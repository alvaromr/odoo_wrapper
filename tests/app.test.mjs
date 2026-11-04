// app.js, the dashboard page's entry script: how the page boots and wires its controls, the clock that keeps it
// current, the polls and reloads that follow the tab, the day and the server, and the flows that cross several
// modules. What each module draws has its own suite, named after it; the harness and the shared fixtures are in
// page.mjs, whose header says how the pages run here. Each page runs on a clock the test sets where a figure a
// minute off would be a flaky test.

import assert from "node:assert/strict";
import test from "node:test";
import {
  answer,
  at,
  click,
  dashboard,
  element,
  fakeAudio,
  flashing,
  heroOf,
  hover,
  IMPORT_RE,
  isoDate,
  JS_FILES,
  load,
  lunchedAt,
  mondayDone,
  payload,
  readModule,
  SCHEDULE,
  session,
  settle,
  TUESDAY,
  teamFixes,
  teamPayload,
  withAlarms,
  withData,
} from "./page.mjs";

const WEDNESDAY = new Date(2026, 8, 16, 10, 0);

test("every imported name is exported by its module", () => {
  for (const file of JS_FILES) {
    const source = readModule(file);
    for (const m of source.matchAll(IMPORT_RE)) {
      const names = m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const target = m[2];
      assert.notEqual(target, file, `${file} imports itself`);
      const targetSource = readModule(target);
      for (const name of names) {
        const exported = new RegExp(
          `export (function|async function|const|let) ${name}\\b|export \\{[^}]*\\b${name}\\b`,
        );
        assert.match(targetSource, exported, `${target} does not export ${name} (imported by ${file})`);
      }
    }
  }
});

test("the page follows the day change before asking Odoo", async () => {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 18, 0);
  const page = load({ data: payload([session(at(yesterday, 9), at(yesterday, 17))]) });
  await page.run("loadAndRender()");
  page.run(`setClock(new Date(${yesterday.getTime()})); NotifiedAt = 5; indexSessions();`);
  const before = page.calls.fetch.length;
  assert.equal(page.run("newDay()"), true);
  assert.equal(page.run("isoDay(store.today)"), page.run("isoDay(new Date())"));
  assert.equal(page.run("NotifiedAt"), 0);
  assert.equal(page.calls.fetch.length, before + 1);
  assert.equal(page.run("newDay()"), false);
});

test("a failed first load keeps retrying once a minute", async () => {
  const page = load();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const loads = () => page.calls.fetch.filter(([url]) => url.startsWith("/api/personal")).length;
  assert.equal(loads(), 1);
  assert.match(page.document.getElementById("loadmsg").textContent, /^Error cargando datos de Odoo: sin datos/);
  page.run("tick()");
  assert.equal(loads(), 1);
  page.run("store.triedAt = Date.now() - 61000; tick()");
  assert.equal(loads(), 2);
});

test("a failed reload is retried once a minute, not every tick", () => {
  const page = withData([session(at(new Date(), 9), null)]);
  page.run("setClock(new Date()); indexSessions();");
  const loads = () => page.calls.fetch.filter(([url]) => url.startsWith("/api/personal")).length;
  page.run("tick()");
  assert.equal(loads(), 1);
  page.run("tick()");
  assert.equal(loads(), 1);
  page.run("store.triedAt = Date.now() - 61000; tick()");
  assert.equal(loads(), 2);
});

test("someone else's week is read only: their data, no punch buttons, no durations, no state polling", async () => {
  const today = new Date();
  const page = load({
    path: "/empleado?id=9",
    data: payload([session(at(today, 9), null)], {
      schedule: { hours: [8, 8, 8, 8, 8, 8, 8], lunch_from: [null, null, null, null, null, null, null] },
      team: true,
    }),
  });
  await page.run("loadAndRender()");
  assert.equal(page.run("store.other"), "9");
  assert.equal(page.calls.fetch.at(-1)[0], "/api/personal?employee=9");
  const hero = page.document.getElementById("hero");
  assert.equal(hero.children.length, 2);
  assert.equal(hero.querySelectorAll("button").length, 0);
  assert.equal(page.document.getElementById("teamLink").classList.contains("hidden"), false);
  const before = page.calls.fetch.length;
  await page.run("refreshState()");
  assert.equal(page.calls.fetch.length, before);
  await page.run("loadAndRender(true)");
  assert.equal(page.calls.fetch.at(-1)[0], "/api/personal?employee=9&fresh");
});

test("the mouse's back and forward buttons walk the history on both pages", async () => {
  for (const [entry, data] of [
    ["team.js", teamPayload()],
    ["app.js", payload([])],
  ]) {
    const page = load({ entry, data });
    await settle();
    const prevented = [];
    for (const button of [0, 3, 4, 1]) {
      page.calls.window.mouseup[0]({ button, preventDefault: () => prevented.push(button) });
    }
    assert.deepEqual(
      [page.calls.went, prevented],
      [
        [-1, 1],
        [3, 4],
      ],
    );
  }
});

test("the tab coming back, the source poll, the views and «Actualizar» drive the dashboard", async () => {
  const versions = ["a", "a", "b"];
  let versionFails = false;
  const fetched = [];
  const page = load({
    fetchImpl: async (url) => {
      fetched.push(url);
      if (url === "/api/version") {
        if (versionFails) throw new Error("sin red");
        return { ok: true, status: 200, json: async () => ({ version: versions.shift() }) };
      }
      return { ok: true, status: 200, json: async () => payload([]) };
    },
  });
  await page.run("loadAndRender()");
  const doc = page.document;
  const poll = page.calls.timers.find(([, ms]) => ms === 2000)[0];
  await poll();
  await poll();
  assert.equal(page.calls.reload, 0);
  await poll();
  await settle();
  assert.equal(page.calls.reload, 1);
  versionFails = true;
  await poll();
  page.run("document.querySelector = () => ({})");
  await poll();
  page.run("document.querySelector = () => null");
  const visible = doc.listeners.visibilitychange[0];
  doc.hidden = true;
  visible();
  doc.hidden = false;
  const loads = () => fetched.filter((url) => url.startsWith("/api/personal")).length;
  const loaded = loads();
  visible();
  page.run("store.loadedAt = 0; store.triedAt = 0");
  visible();
  await settle();
  assert.equal(loads(), loaded + 1);
  page.run("store.personal = null");
  visible();
  page.run(`store.personal = ${JSON.stringify(payload([]))}; store.state = store.personal.state`);
  page.run("setClock(new Date()); indexSessions(); store.loadedAt = Date.now(); store.punchEv = null; tick()");
  page.run("store.punchEv = { at: new Date(), open: false }; store.punchEl = document.createElement('div'); tick()");
  assert.match(page.run("store.punchEl.textContent"), / a las \d\d:\d\d · hace 0m$/);
  page.run(
    `store.personal.sessions = [${JSON.stringify(session(new Date(Date.now() - 3600e3), null))}]; indexSessions()`,
  );
  page.run("document.querySelector = () => ({}); tick(); document.querySelector = () => null; tick()");
  const views = doc.getElementById("viewSeg");
  const table = doc.createElement("button"),
    charts = doc.createElement("button");
  table.dataset.view = "table";
  charts.dataset.view = "charts";
  views.append(charts, table);
  views.listeners.click[0]({ target: { closest: () => table }, currentTarget: views });
  assert.deepEqual(
    [
      doc.getElementById("tableView").classList.contains("hidden"),
      doc.getElementById("chartsView").classList.contains("hidden"),
    ],
    [false, true],
  );
  assert.deepEqual(
    [charts, table].map((b) => b.getAttribute("aria-pressed")),
    ["false", "true"],
  );
  views.listeners.click[0]({ target: { closest: () => null }, currentTarget: views });
  const refresh = doc.getElementById("refreshBtn");
  const target = { disabled: false };
  await refresh.listeners.click[0]({ target });
  assert.equal(target.disabled, false);
  assert.ok(fetched.includes("/api/personal?fresh"));
});

test("a full fortnight draws every part of the dashboard: break, lunch, leave, holidays and progress", async () => {
  const d = (day, h, m = 0) => new Date(2026, 8, day, h, m);
  const work = (day, h1, m1, h2, m2) => session(d(day, h1, m1), d(day, h2, m2));
  const rest = (day, h1, m1, h2, m2) => session(d(day, h1, m1), h2 == null ? null : d(day, h2, m2), true);
  const sessions = [
    work(7, 8, 0, 12, 0),
    rest(7, 12, 0, 12, 15),
    work(7, 12, 15, 13, 0),
    work(7, 13, 45, 17, 30),
    work(8, 8, 0, 16, 30),
    work(9, 8, 0, 16, 0),
    work(10, 8, 0, 16, 0),
    work(11, 8, 0, 16, 0),
    work(14, 8, 0, 16, 0),
    work(15, 7, 45, 8, 15),
    rest(15, 8, 45),
  ];
  const absences = [1, 2, 3, 4]
    .map((day) => ({ date: isoDate(d(day, 0)), type: "Vacaciones" }))
    .concat([
      { date: "2026-08-31", type: "Vacaciones" },
      {
        date: "2026-09-08",
        type: "Médico",
        hours: 1,
        from: d(8, 16, 30).toISOString(),
        to: d(8, 17, 30).toISOString(),
      },
      {
        date: "2026-09-15",
        type: "Médico",
        hours: 0.5,
        from: d(15, 16).toISOString(),
        to: d(15, 16, 30).toISOString(),
      },
    ]);
  const schedule = { hours: [8, 8, 8, 8, 8, 0, 0], lunch_from: [0, 0, 0, 0, 0, 0, 0] };
  const data = payload(sessions, { generated_at: d(15, 10).toISOString(), schedule, absences });
  const page = load({
    fetchImpl: async (url, opts) => ({
      ok: true,
      status: 200,
      json: async () => (url === "/api/state" ? { ...data.state, ...JSON.parse(opts.body) } : data),
    }),
  });
  await page.run("loadAndRender()");
  const doc = page.document;
  const hero = doc.getElementById("hero");
  assert.deepEqual(
    hero.querySelectorAll(".btn").map((b) => b.textContent),
    ["Volver del descanso", "Fichar salida"],
  );
  const notes = hero.querySelectorAll(".note").map((n) => n.textContent);
  assert.ok(notes.includes("Ausente hoy: 30m"));
  assert.equal(hero.querySelectorAll(".meter-caption")[0].children[1].textContent, "1h 45m · 23 %");
  assert.ok(notes.includes("Descanso de hoy: 1h 15m ausente (en curso)"));
  assert.ok(notes.includes("Mar 15 sep · Médico 30m · 1h 45m fichadas"));
  const mute = () => hero.querySelectorAll(".icon-btn").find((b) => b.title.endsWith("avisos"));
  mute().listeners.click[0]();
  await settle();
  assert.equal(page.run("store.state.muted"), true);
  page.run("renderHero()");
  mute().listeners.click[0]();
  await settle();
  assert.equal(page.run("store.state.muted"), false);
  page.run("store.personal.sessions.at(-1).rest = false; indexSessions(); renderHero()");
  assert.deepEqual(
    hero.querySelectorAll(".btn").map((b) => b.textContent),
    ["Fichar salida", "Salir a descanso"],
  );

  const card = doc.getElementById("weekCal");
  assert.equal(card.querySelectorAll(".badge")[0].textContent, "en curso · faltan 29h 45m");
  const nav = (cls) => card.querySelectorAll(`.${cls}`)[0];
  nav("navbtn").listeners.click[0]();
  assert.equal(page.run("calOffset"), 1);
  card.querySelectorAll(".navbtn")[1].listeners.click[0]();
  assert.equal(page.run("calOffset"), 0);
  nav("navbtn").listeners.click[0]();
  nav("todaybtn").listeners.click[0]();
  assert.equal(page.run("calOffset"), 0);
  page.run("calOffset = 1; calView = 'objetivo'; renderCalendar()");
  assert.equal(card.querySelectorAll(".badge")[0].textContent, "▲ +2h 15m vs 39h");
  const monday = card.querySelectorAll(".dayrow")[0];
  assert.equal(monday.querySelectorAll(".rest").length, 1);
  assert.deepEqual(hover(page, monday), [
    "Lun 7 sep",
    "Total 8h 45m",
    "Previsto 8h",
    "Ausente 45m",
    "Descanso 15m",
    "08:00 – 12:00 4h",
    "12:00 – 12:15 · descanso 15m",
    "12:15 – 13:00 45m",
    "13:45 – 17:30 3h 45m",
  ]);
  assert.deepEqual(hover(page, card.querySelectorAll(".dayrow")[1]).slice(0, 4), [
    "Mar 8 sep",
    "Total 8h 30m",
    "Previsto 7h",
    "Permiso · Médico 1h",
  ]);
  page.run("calOffset = 2; renderCalendar()");
  assert.equal(card.querySelectorAll(".badge")[0].textContent, "vacaciones");
  assert.deepEqual(hover(page, card.querySelectorAll(".dayrow")[0]).slice(0, 3), [
    "Lun 31 ago",
    "Total —",
    "Ausencia Vacaciones",
  ]);
  page.run("calOffset = 1; calView = 'horario'; renderCalendar()");
  const rows = card.querySelectorAll(".tl-row");
  const mondayRow = rows.find((r) => r.querySelectorAll(".dnum")[0]?.textContent === "7");
  assert.deepEqual(
    mondayRow.querySelectorAll(".gap").map((g) => g.textContent),
    ["45m"],
  );
  const restBlock = mondayRow.querySelectorAll(".sess").find((s) => s.classList.contains("rest"));
  assert.deepEqual(hover(page, restBlock).slice(0, 2), ["Lun 7 sep · 12:00 – 12:15", "Descanso 15m"]);
  assert.ok(mondayRow.querySelectorAll(".sess").some((s) => s.classList.contains("join-r")));
  const tuesdayRow = rows.find((r) => r.querySelectorAll(".dnum")[0]?.textContent === "8");
  assert.deepEqual(
    tuesdayRow.querySelectorAll(".leave").map((l) => [l.textContent, ...hover(page, l)]),
    [["Médico", "Mar 8 sep · 16:30 – 17:30", "Permiso · Médico 1h"]],
  );
  assert.deepEqual(hover(page, mondayRow.querySelectorAll(".gap")[0]), ["Lun 7 sep · 13:00 – 13:45", "Sin fichar 45m"]);

  page.run("renderOverview(buildWeeks(4))");
  const cols = doc.getElementById("overviewChart").children[0].children.filter((g) => g.tagName === "G");
  assert.ok(cols[2].children.some((c) => (c.getAttribute("class") || "") === "rest"));
  assert.deepEqual(hover(page, cols[1]).slice(-1), ["Vacaciones toda la semana"]);
  assert.deepEqual(hover(page, cols[2]).slice(1, 4), ["Total 41h 15m", "Trabajo 41h", "Descanso 15m"]);
  assert.equal(hover(page, cols[2]).at(-1), "Sobre objetivo +2h 15m");
  assert.equal(hover(page, cols[3]).at(-1), "Para el objetivo 29h 45m");
});

test("failed reloads from a returning tab, a new day or a prefetch leave the page alone and only log", async () => {
  let down = false;
  const page = load({
    fetchImpl: async () => {
      if (down) throw new Error("sin red");
      return { ok: true, status: 200, json: async () => payload([]) };
    },
  });
  await page.run("loadAndRender()");
  down = true;
  page.run("store.loadedAt = 0; store.triedAt = 0");
  page.document.listeners.visibilitychange[0]();
  page.run("setClock(new Date(Date.now() - 864e5))");
  page.document.listeners.visibilitychange[0]();
  await settle();
  assert.equal(page.run("isoDay(store.today)"), page.run("isoDay(new Date())"));
  assert.ok(page.calls.warnings.includes("[odoo] the reload on returning to the tab failed: Error: sin red"));
  assert.ok(page.calls.warnings.includes("[odoo] the reload on a new day failed: Error: sin red"));
  const urls = [];
  const team = load({
    entry: "team.js",
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.startsWith("/api/team?week=")) throw new Error("sin red");
      return { ok: true, status: 200, json: async () => (url.includes("fixes") ? teamFixes() : teamPayload()) };
    },
  });
  await settle();
  assert.ok(urls.some((url) => url.startsWith("/api/team?week=")));
  assert.equal(team.document.getElementById("gridCard").classList.contains("hidden"), false);
  assert.ok(team.calls.warnings.includes("[odoo] the prefetch failed: Error: sin red"));
});

test("the alarms, the loader and the tooltip in their other cases", async () => {
  const audio = fakeAudio();
  const page = load({ globals: { window: { webkitAudioContext: audio.window.AudioContext } } });
  page.run("checkAlarms()");
  page.document.listeners.pointerdown[0]();
  await settle();
  assert.equal(audio.made.length, 1);
  const lunch = new Date(Date.now() - 40 * 60000).toISOString();
  page.run(
    `store.personal = ${JSON.stringify(payload([]))}; store.state = { ...store.personal.state, lunch: "${lunch}" }; ${SCHEDULE}`,
  );
  page.run(
    "setClock(new Date()); store.expected = [8, 8, 8, 8, 8, 8, 8]; checkAlarms(); checkAlarms(); LastRing.lunch = 0; checkAlarms()",
  );
  assert.equal(audio.made[0].oscillators.length, 6);
  assert.equal(page.calls.timers.filter(([, ms]) => ms === 900).length, 1);
  const since = new Date(Date.now() - 3600e3).toISOString();
  page.run("store.state.break_minutes = 0");
  assert.equal(
    page.run(`notifyStatus({ rest: true, in: "${since}" }, { expected: 8 }, 0)`),
    "En descanso · sin aviso configurado",
  );
  page.run("NotifiedAt = 0");
  assert.match(page.run(`notifyStatus({ in: "${since}" }, { expected: 8 }, 0)`), /siguiente en menos de 1 min$/);
  page.run("NotifiedAt = Date.now()");
  assert.match(page.run(`notifyStatus({ in: "${since}" }, { expected: 8 }, 0)`), /siguiente en 2 min$/);

  const bare = { ...payload([]) };
  delete bare.state;
  delete bare.absences;
  const loader = load({
    fetchImpl: async (url) =>
      url === "/api/boom"
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => bare },
  });
  loader.run(`store.state = ${JSON.stringify(payload([]).state)}`);
  await loader.run("loadAndRender()");
  assert.equal(loader.run("store.state.lunch_minutes"), 30);
  assert.equal(loader.run("store.absMap.size"), 0);
  await assert.rejects(loader.run("api('/api/boom')"), /HTTP 500/);
  loader.run("setClock(new Date(Date.now() - 864e5)); tick()");
  assert.equal(loader.run("isoDay(store.today)"), loader.run("isoDay(new Date())"));
  const seg = loader.document.getElementById("rangeSeg");
  const all = loader.document.createElement("button"),
    one = loader.document.createElement("button");
  all.dataset.months = "all";
  one.dataset.months = "1";
  seg.listeners.click[0]({ target: { closest: () => null }, currentTarget: seg });
  seg.listeners.click[0]({ target: { closest: () => all }, currentTarget: seg });
  assert.equal(loader.run("rangeMonths"), 0);
  seg.listeners.click[0]({ target: { closest: () => one }, currentTarget: seg });
  assert.equal(loader.run("rangeMonths"), 1);

  const a = page.document.createElement("div"),
    b = page.document.createElement("div");
  for (const node of [a, b]) page.run("attachTip").call(null, node, () => {});
  const tip = page.document.getElementById("tip");
  a.listeners.pointerenter[0]({ clientX: 1275, clientY: 795 });
  assert.deepEqual([tip.style.left, tip.style.top], ["1261px", "781px"]);
  b.listeners.blur[0]();
  assert.equal(tip.style.display, "block");
  a.listeners.pointerleave[0]();
  assert.equal(tip.style.display, "none");
});

test("the source poll runs only where the page is served from this machine", () => {
  const where = (hostname) => {
    const page = load({
      globals: {
        location: { hostname, protocol: "http:", pathname: "/", search: "", hash: "", replace() {}, reload() {} },
      },
    });
    return page.calls.timers.some(([, ms]) => ms === 2000);
  };
  assert.deepEqual(["localhost", "127.0.0.1", "[::1]", "::1", "192.168.1.5", "mac.local"].map(where), [
    true,
    true,
    true,
    true,
    false,
    false,
  ]);
});

const later = (page, ms) => page.Clock.set(new Date(page.Clock.now() + ms));
const freshData = (page) => page.run(`store.loadedAt = ${page.Clock.now()}; store.triedAt = ${page.Clock.now()}`);
const dataLoads = (page) => page.sent.filter((r) => r.url.startsWith("/api/personal")).length;
const marks = (page) => {
  page.run("LastRing.lunch = 5; LastRing.rest = 6; NotifiedAt = 7; store.byDay = new Map()");
  page.run(`flashTitle("x")`);
  page.document.getElementById("hero").replaceChildren("marca");
  page.document.getElementById("overviewTitle").textContent = "marca";
};
const redrawn = (page) => ({
  alarms: page.run("[LastRing.lunch, LastRing.rest, NotifiedAt]"),
  flashing: flashing(page),
  indexed: page.run("store.byDay.size") > 0,
  hero: page.document.getElementById("hero").children[0] !== "marca",
  all: page.document.getElementById("overviewTitle").textContent !== "marca",
});
const REDRAWN_ON_A_NEW_DAY = { alarms: [0, 0, 0], flashing: false, indexed: true, hero: true, all: true };

test("a new day resets the alarms, repaints from the local clock and reloads", async () => {
  const page = dashboard({ sessions: [session(at(TUESDAY, 9), null)] });
  marks(page);
  page.Clock.set(WEDNESDAY);
  page.document.listeners.visibilitychange[0]();
  assert.deepEqual(redrawn(page), REDRAWN_ON_A_NEW_DAY);
  assert.equal(page.run("store.today.getDate()"), 16);
  assert.equal(dataLoads(page), 2);
  await settle();
  const ticking = dashboard({ sessions: [session(at(TUESDAY, 9), null)] });
  marks(ticking);
  ticking.Clock.set(WEDNESDAY);
  clockTick(ticking)();
  assert.deepEqual(redrawn(ticking), REDRAWN_ON_A_NEW_DAY);
  assert.equal(
    ticking.sent.some((r) => r.url === "/api/state"),
    false,
  );
  const failing = dashboard({ answers: { "/api/personal": () => Promise.reject(new Error("sin red")) } });
  failing.Clock.set(WEDNESDAY);
  failing.document.listeners.visibilitychange[0]();
  await settle();
  assert.deepEqual(failing.calls.warnings, ["[odoo] the reload on a new day failed: Error: sin red"]);
});

test("coming back to the tab stops a blinking title and reloads stale data unless the page is busy", async () => {
  const back = () => {
    const page = dashboard({ sessions: [session(at(TUESDAY, 9), null)] });
    page.run(`flashTitle("x")`);
    return page;
  };
  const hidden = back();
  hidden.document.hidden = true;
  later(hidden, 61000);
  hidden.document.listeners.visibilitychange[0]();
  assert.equal(flashing(hidden), true);
  assert.equal(dataLoads(hidden), 1);

  const stale = back();
  later(stale, 61000);
  stale.document.listeners.visibilitychange[0]();
  assert.equal(flashing(stale), false);
  assert.equal(dataLoads(stale), 2);

  const fresh = back();
  later(fresh, 30000);
  fresh.document.listeners.visibilitychange[0]();
  assert.equal(dataLoads(fresh), 1);

  const busy = back();
  later(busy, 61000);
  busy.document.getElementById("tip").style.display = "block";
  busy.document.listeners.visibilitychange[0]();
  assert.equal(dataLoads(busy), 1);

  const empty = back();
  empty.run("store.personal = null");
  later(empty, 61000);
  empty.document.listeners.visibilitychange[0]();
  assert.equal(dataLoads(empty), 1);

  const failing = dashboard({ answers: { "/api/personal": () => Promise.reject(new Error("sin red")) } });
  later(failing, 61000);
  failing.document.listeners.visibilitychange[0]();
  await settle();
  assert.deepEqual(failing.calls.warnings, ["[odoo] the reload on returning to the tab failed: Error: sin red"]);
});

const sourcePoll = (page) => page.calls.timers.find(([, ms]) => ms === 2000)[0];

test("the source poll reloads the page when the version changes, and is skipped while busy", async () => {
  let version = "a";
  const page = dashboard({ answers: { "/api/version": () => answer({ version })() } });
  await sourcePoll(page)();
  assert.equal(page.run("SourceVersion"), "a");
  await sourcePoll(page)();
  assert.equal(page.calls.reload, 0);
  version = "b";
  page.document.getElementById("tip").style.display = "block";
  await sourcePoll(page)();
  assert.equal(page.calls.reload, 0);
  assert.equal(page.sent.filter((r) => r.url === "/api/version").length, 2);
  page.document.getElementById("tip").style.display = "none";
  await sourcePoll(page)();
  assert.equal(page.calls.reload, 1);
});

test("a source poll that fails is logged", async () => {
  const page = dashboard({ answers: { "/api/version": () => Promise.reject(new Error("sin red")) } });
  await sourcePoll(page)();
  assert.deepEqual(page.calls.warnings, ["[odoo] the source version poll failed: Error: sin red"]);
});

const clockTick = (page) => page.calls.timers.find(([, ms]) => ms === 20000)[0];

test("the clock reloads a page that has no data, when it is time and the tab is visible", () => {
  const empty = () => {
    const page = dashboard();
    page.run("store.personal = null");
    return page;
  };
  const visible = empty();
  later(visible, 61000);
  clockTick(visible)();
  assert.equal(dataLoads(visible), 2);
  const hidden = empty();
  hidden.document.visibilityState = "hidden";
  later(hidden, 61000);
  clockTick(hidden)();
  assert.equal(dataLoads(hidden), 1);
  const early = empty();
  later(early, 30000);
  clockTick(early)();
  assert.equal(dataLoads(early), 1);
});

test("the clock reloads stale data when visible and idle, and otherwise only polls the shared state", async () => {
  const run = async (setup) => {
    const page = dashboard({ sessions: [session(at(TUESDAY, 9), null)] });
    later(page, 61000);
    setup?.(page);
    clockTick(page)();
    await settle();
    return { loads: dataLoads(page), polls: page.sent.filter((r) => r.url === "/api/state").length };
  };
  assert.deepEqual(await run(), { loads: 2, polls: 0 });
  assert.deepEqual(await run((p) => (p.document.visibilityState = "hidden")), { loads: 1, polls: 1 });
  assert.deepEqual(await run((p) => (p.document.getElementById("tip").style.display = "block")), {
    loads: 1,
    polls: 0,
  });
  assert.deepEqual(await run((p) => freshData(p)), { loads: 1, polls: 1 });
  const failing = dashboard({ answers: { "/api/personal": () => Promise.reject(new Error("sin red")) } });
  later(failing, 61000);
  clockTick(failing)();
  await settle();
  assert.deepEqual(failing.calls.warnings, ["[odoo] the reload of stale data failed: Error: sin red"]);
});

test("the clock repaints the hero and the page while a session is open, unless the page is busy", () => {
  const ticked = (setup) => {
    const page = dashboard({ sessions: [session(at(TUESDAY, 8), at(TUESDAY, 8, 30)), session(at(TUESDAY, 9), null)] });
    marks(page);
    later(page, 30 * 60000);
    freshData(page);
    setup?.(page);
    clockTick(page)();
    return page;
  };
  const page = ticked();
  assert.equal(page.run("store.now.getTime()"), TUESDAY.getTime() + 30 * 60000);
  assert.deepEqual(redrawn(page), { ...REDRAWN_ON_A_NEW_DAY, alarms: [5, 6, 7], flashing: true });
  const busy = ticked((p) => (p.document.getElementById("tip").style.display = "block"));
  assert.equal(busy.run("store.now.getTime()"), TUESDAY.getTime());
  assert.deepEqual(redrawn(busy), { alarms: [5, 6, 7], flashing: true, indexed: false, hero: false, all: false });
});

test("the clock only refreshes the last punch and the status line when nothing is open", () => {
  const page = withAlarms({ sessions: [mondayDone, session(at(TUESDAY, 9), at(TUESDAY, 9, 30))] });
  page.run(lunchedAt(new Date(TUESDAY.getTime() - 20 * 60000)));
  heroOf(page);
  const punch = () => page.run("store.punchEl.textContent");
  const note = () => page.run("store.notifyEl.textContent");
  assert.equal(punch(), "Última salida a las 09:30 · hace 30m");
  assert.equal(note(), "Comida hasta las 10:10");
  page.document.getElementById("hero").children.push("marca");
  later(page, 30 * 60000);
  freshData(page);
  clockTick(page)();
  assert.equal(punch(), "Última salida a las 09:30 · hace 1h");
  assert.equal(note(), "Comida vencida a las 10:10");
  assert.equal(page.document.getElementById("hero").children.at(-1), "marca");
  assert.equal(page.run("store.now.getTime()"), TUESDAY.getTime());
  const none = dashboard({ sessions: [] });
  heroOf(none);
  later(none, 30 * 60000);
  freshData(none);
  clockTick(none)();
});

test("the clock is a timer every twenty seconds", () => {
  const page = dashboard();
  assert.equal(page.calls.timers.filter(([, ms]) => ms === 20000).length, 1);
});

const segment = (page, id, buttons) => {
  const seg = page.document.getElementById(id);
  const made = buttons.map((dataset) => Object.assign(element("button"), { dataset }));
  const span = element("span");
  seg.children = [...made, span];
  return { made, span };
};
const closestTo = (button, selectors) => ({
  closest: (selector) => {
    selectors.push(selector);
    return button;
  },
});

test("the range buttons set the months shown, mark the one pressed and redraw", () => {
  const page = dashboard({ sessions: [session(at(TUESDAY, 9), null)] });
  const { made, span } = segment(page, "rangeSeg", [{ months: "3" }, { months: "all" }]);
  const selectors = [];
  page.document.getElementById("overviewTitle").textContent = "marca";
  click(page, "rangeSeg", closestTo(made[0], selectors));
  assert.equal(page.run("rangeMonths"), 3);
  assert.deepEqual(
    made.map((b) => b.attrs["aria-pressed"]),
    ["true", "false"],
  );
  assert.equal(span.attrs["aria-pressed"], undefined);
  assert.notEqual(page.document.getElementById("overviewTitle").textContent, "marca");
  click(page, "rangeSeg", closestTo(made[1], selectors));
  assert.equal(page.run("rangeMonths"), 0);
  assert.deepEqual(
    made.map((b) => b.attrs["aria-pressed"]),
    ["false", "true"],
  );
  assert.deepEqual(selectors, ["button", "button"]);
  page.document.getElementById("overviewTitle").textContent = "marca";
  click(page, "rangeSeg", closestTo(null, selectors));
  assert.equal(page.run("rangeMonths"), 0);
  assert.equal(page.document.getElementById("overviewTitle").textContent, "marca");
});

test("the view buttons show the charts or the table", () => {
  const page = dashboard();
  const { made, span } = segment(page, "viewSeg", [{ view: "charts" }, { view: "table" }]);
  const selectors = [];
  const hidden = (id) => page.document.getElementById(id).classList.contains("hidden");
  click(page, "viewSeg", closestTo(made[1], selectors));
  assert.deepEqual([hidden("chartsView"), hidden("tableView")], [true, false]);
  assert.deepEqual(
    made.map((b) => b.attrs["aria-pressed"]),
    ["false", "true"],
  );
  assert.equal(span.attrs["aria-pressed"], undefined);
  click(page, "viewSeg", closestTo(made[0], selectors));
  assert.deepEqual([hidden("chartsView"), hidden("tableView")], [false, true]);
  assert.deepEqual(
    made.map((b) => b.attrs["aria-pressed"]),
    ["true", "false"],
  );
  assert.deepEqual(selectors, ["button", "button"]);
  click(page, "viewSeg", closestTo(null, selectors));
  assert.deepEqual([hidden("chartsView"), hidden("tableView")], [false, true]);
});

test("the refresh button reloads from Odoo and stays off meanwhile", async () => {
  let release;
  const page = dashboard({ answers: { "/api/personal?fresh": () => new Promise((resolve) => (release = resolve)) } });
  const button = page.document.getElementById("refreshBtn");
  const pending = button.listeners.click[0]({ target: button });
  assert.equal(button.disabled, true);
  release(await answer(page.data)());
  await pending;
  assert.equal(button.disabled, false);
  assert.equal(page.sent.at(-1).url, "/api/personal?fresh");
});

test("the page wires its controls: log out, the mouse's back button, the update banner, the day dialog", async () => {
  const opened = [];
  const tab = { close() {} };
  const page = dashboard({
    answers: { "/api/request": answer({ url: "https://odoo.example/solicitud" }) },
    globals: {
      window: Object.assign(fakeAudio().window, {
        open: (...args) => {
          opened.push(args);
          return tab;
        },
      }),
    },
  });
  assert.equal(page.document.getElementById("logoutBtn").listeners.click.length, 1);
  assert.equal(page.calls.window.mouseup.length, 1);
  assert.equal(
    page.sent.some((r) => r.url === "/api/update"),
    true,
  );
  assert.equal(
    page.calls.timers.some(([, ms]) => ms === 3600000),
    true,
  );
  assert.equal(
    page.document.body.children.some((c) => c._id === "dayDialog"),
    true,
  );
  await page.run("Reload()");
  assert.equal(page.sent.at(-1).url, "/api/personal?fresh");
  const request = page.document.getElementById("requestBtn");
  await request.listeners.click[0]();
  await settle();
  assert.deepEqual(opened, [["", "_blank"]]);
  assert.equal(page.sent.at(-1).url, "/api/request");
  assert.equal(tab.location, "https://odoo.example/solicitud");
});
