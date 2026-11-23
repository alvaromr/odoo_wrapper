// api.js: when the data is stale, the shared state (saved, rolled back, polled) and the load that turns the payload
// into the figures the page draws with, on a clock the test sets (clockAt in page.mjs).

import assert from "node:assert/strict";
import { test } from "vitest";
import { answer, at, dashboard, heroOf, iso, load, now, payload, session, settle, TUESDAY } from "./page.mjs";

const staleAt = (page, loaded, tried) =>
  page.run(`store.loadedAt = ${now(page) - loaded}; store.triedAt = ${now(page) - tried}; stale()`);

test("data goes stale after five minutes, retried no sooner than a minute after the last try", () => {
  const page = dashboard();
  assert.equal(staleAt(page, 300001, 60001), true);
  assert.equal(staleAt(page, 300000, 60001), false);
  assert.equal(staleAt(page, 300001, 60000), false);
  assert.equal(staleAt(page, 1000, 60001), false);
  assert.equal(staleAt(page, 300001, 1000), false);
});

test("a state change is drawn at once, posted as it is, and kept as the server answers", async () => {
  const page = dashboard({ sessions: [session(at(TUESDAY, 9), null)] });
  const bell = () =>
    page.document
      .getElementById("hero")
      .querySelectorAll(".icon-btn")
      .find((b) => b.title.endsWith("avisos")).title;
  heroOf(page);
  assert.equal(bell(), "Silenciar avisos");
  const saving = page.run("saveState({ muted: true })");
  assert.equal(bell(), "Reactivar avisos");
  await saving;
  assert.deepEqual(
    page.sent.filter((r) => r.url === "/api/state"),
    [{ url: "/api/state", method: "POST", headers: { "Content-Type": "application/json" }, body: { muted: true } }],
  );
  assert.equal(bell(), "Reactivar avisos");
});

test("a state change the server refuses is taken back and drawn again", async () => {
  for (const refusal of [answer({}, 500), () => Promise.reject(new Error("sin red"))]) {
    const page = dashboard({ sessions: [session(at(TUESDAY, 9), null)], answers: { "/api/state": refusal } });
    heroOf(page);
    await page.run("saveState({ muted: true })");
    assert.equal(page.run("store.state.muted"), false);
    const titles = page.document
      .getElementById("hero")
      .querySelectorAll(".icon-btn")
      .map((b) => b.title);
    assert.deepEqual(titles, ["Ajustes", "Silenciar avisos"]);
  }
});

test("a changed setting is saved, and rolled back when the server refuses it", async () => {
  const posts = [];
  let reply = { ok: true, status: 200, json: async () => ({ ...payload([]).state, lunch_minutes: 45 }) };
  const page = load({
    fetchImpl: async (url, opts) => {
      if (url === "/api/state" && opts?.method === "POST") {
        posts.push(JSON.parse(opts.body));
        return reply;
      }
      return { ok: true, status: 200, json: async () => payload([]) };
    },
  });
  await page.run("loadAndRender()");
  await page.run("saveState({ lunch_minutes: 45 })");
  assert.deepEqual(posts, [{ lunch_minutes: 45 }]);
  assert.equal(page.run("store.state.lunch_minutes"), 45);
  reply = { ok: false, status: 500, json: async () => ({}) };
  await page.run("saveState({ lunch_minutes: 60 })");
  assert.equal(page.run("store.state.lunch_minutes"), 45);
  reply = Promise.reject(new Error("sin red"));
  reply.catch(() => {});
  await page.run("saveState({ lunch_minutes: 70 })");
  assert.equal(page.run("store.state.lunch_minutes"), 45);
  assert.deepEqual(page.calls.warnings, [
    "[odoo] saving the shared state failed: Error: HTTP 500",
    "[odoo] saving the shared state failed: Error: sin red",
  ]);
});

test("polling the shared state ignores a page of someone else's and a refused answer", async () => {
  const refused = dashboard({
    answers: { "/api/state": async () => ({ ok: false, status: 500, json: async () => ({ punched_at: "x" }) }) },
  });
  await refused.run("refreshState()");
  assert.equal(refused.sent.filter((r) => r.url === "/api/state").length, 1);
  assert.equal(refused.sent.filter((r) => r.url === "/api/personal").length, 1);
  const other = dashboard();
  other.run(`store.other = "7"`);
  await other.run("refreshState()");
  assert.equal(
    other.sent.some((r) => r.url === "/api/state"),
    false,
  );
  const busy = dashboard();
  busy.document.getElementById("tip").style.display = "block";
  await busy.run("refreshState()");
  assert.equal(
    busy.sent.some((r) => r.url === "/api/state"),
    false,
  );
});

test("a punch made elsewhere reloads the page, a changed state replaces it, an equal one changes nothing", async () => {
  const polled = (changes) => {
    const page = dashboard({
      sessions: [session(at(TUESDAY, 9), null)],
      answers: { "/api/state": async () => answer({ ...payload([]).state, ...changes })() },
    });
    page.document.getElementById("hero").replaceChildren("marca");
    page.run("LastRing.lunch = 5; window.kept = store.state");
    return page;
  };
  const unchanged = polled({});
  await unchanged.run("refreshState()");
  assert.equal(unchanged.run("window.kept === store.state"), true);
  assert.deepEqual(unchanged.document.getElementById("hero").children, ["marca"]);

  const changed = polled({ muted: true });
  await changed.run("refreshState()");
  assert.equal(changed.run("store.state.muted"), true);
  assert.equal(changed.run("LastRing.lunch"), 5);
  assert.equal(changed.document.getElementById("hero").children.length > 1, true);

  const lunch = polled({ lunch: iso(TUESDAY) });
  await lunch.run("refreshState()");
  assert.equal(lunch.run("LastRing.lunch"), 0);

  const punched = polled({ punched_at: iso(TUESDAY) });
  await punched.run("refreshState()");
  assert.equal(punched.sent.filter((r) => r.url === "/api/personal").length, 2);
  assert.equal(punched.run("window.kept === store.state"), false);
});

test("the state poll repaints only on a change, and reloads after a punch elsewhere", async () => {
  let state = payload([]).state;
  let fail = false;
  const loads = [];
  const page = load({
    fetchImpl: async (url) => {
      if (url === "/api/state") {
        if (fail) throw new Error("sin red");
        return { ok: state !== null, status: state ? 200 : 500, json: async () => state };
      }
      loads.push(url);
      return { ok: true, status: 200, json: async () => payload([]) };
    },
  });
  await page.run("loadAndRender()");
  const before = loads.length;
  await page.run("refreshState()");
  assert.equal(loads.length, before);
  state = { ...state, lunch: new Date().toISOString() };
  page.run("LastRing.lunch = 5");
  await page.run("refreshState()");
  assert.equal(page.run("store.state.lunch"), state.lunch);
  assert.equal(page.run("LastRing.lunch"), 0);
  state = { ...state, muted: true };
  await page.run("refreshState()");
  assert.equal(page.run("store.state.muted"), true);
  state = { ...state, punched_at: "2026-09-25T10:00:00" };
  await page.run("refreshState()");
  assert.equal(loads.length, before + 1);
  state = null;
  await page.run("refreshState()");
  fail = true;
  await page.run("refreshState()");
  assert.equal(loads.length, before + 1);
});

test("a failed poll of the shared state is logged and the page carries on", async () => {
  const page = dashboard({ answers: { "/api/state": () => Promise.reject(new Error("sin red")) } });
  await page.run("refreshState()");
  assert.deepEqual(page.calls.warnings, ["[odoo] the shared state poll failed: Error: sin red"]);
});

test("a load asks for the personal week, the fresh data or someone else's, and nothing more", async () => {
  const page = dashboard();
  const urls = () => page.sent.filter((r) => r.url.startsWith("/api/personal")).map((r) => r.url);
  await page.run("loadAndRender()");
  await page.run("loadAndRender(true)");
  page.run(`store.other = "7"`);
  await page.run("loadAndRender()");
  await page.run("loadAndRender(true)");
  assert.deepEqual(urls(), [
    "/api/personal",
    "/api/personal",
    "/api/personal?fresh",
    "/api/personal?employee=7",
    "/api/personal?employee=7&fresh",
  ]);
  assert.equal(page.sent.at(-1).method, undefined);
});

test("a load turns the payload into the figures the page draws with", async () => {
  const absences = [
    { date: "2026-09-16", type: "Vacaciones" },
    { date: "2026-09-15", type: "Médico", hours: 1, from: iso(at(TUESDAY, 12)), to: iso(at(TUESDAY, 13)) },
    { date: "2026-09-15", type: "Dentista", hours: 0.5, from: iso(at(TUESDAY, 14)), to: iso(at(TUESDAY, 14, 30)) },
  ];
  const page = dashboard({
    extra: {
      employee: "Ana",
      schedule: { hours: [8, 8, 8, 8, 6, 0, 0], lunch_from: [13, 13, 13, 13, null, null, null] },
      contract_hours: { "2026-09-14": 4 },
      since: "2026-09-07",
      absences,
      team: true,
    },
  });
  page.run(
    `store.since = "viejo"; document.getElementById("app").classList.add("hidden"); document.getElementById("teamLink").classList.add("hidden")`,
  );
  page.run(`document.getElementById("requestBtn").classList.add("hidden")`);
  await page.run("loadAndRender()");
  assert.deepEqual(page.run("store.expected"), [8, 8, 8, 8, 6, 0, 0]);
  assert.deepEqual(page.run("store.lunchFrom"), [13, 13, 13, 13, null, null, null]);
  assert.equal(page.run("store.weekTarget"), 38);
  assert.deepEqual(page.run("[...store.contractHours]"), [["2026-09-14", 4]]);
  assert.equal(page.run("store.since"), "2026-09-07");
  assert.deepEqual(page.run("[...store.absMap]"), [["2026-09-16", "Vacaciones"]]);
  assert.deepEqual(page.run("[...store.leaveMap.keys()]"), ["2026-09-15"]);
  assert.deepEqual(page.run(`store.leaveMap.get("2026-09-15").map((l) => l.type)`), ["Médico", "Dentista"]);
  assert.equal(page.run("store.now.getTime()"), TUESDAY.getTime());
  assert.equal(page.document.getElementById("title").textContent, "Ana");
  assert.equal(page.document.getElementById("subtitle").textContent, "Odoo · actualizado el 15 sep a las 10:00");
  const hidden = (id) => page.document.getElementById(id).classList.contains("hidden");
  assert.deepEqual(["teamLink", "requestBtn", "loadmsg", "app"].map(hidden), [false, false, true, false]);
  page.run(`store.other = "7"`);
  await page.run("loadAndRender()");
  assert.equal(hidden("requestBtn"), true);
});

test("a payload without schedule, contracts, since, absences or team leaves the page with no hours expected", async () => {
  const page = dashboard({
    extra: { schedule: null, since: undefined, absences: undefined, contract_hours: undefined },
  });
  page.run(`store.since = "viejo"; store.contractHours = new Map([["x", 1]])`);
  await page.run("loadAndRender()");
  assert.deepEqual(page.run("store.expected"), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(page.run("store.lunchFrom"), [null, null, null, null, null, null, null]);
  assert.equal(page.run("store.weekTarget"), 0);
  assert.equal(page.run("store.since"), "");
  assert.deepEqual(page.run("[...store.contractHours]"), []);
  assert.deepEqual(page.run("[...store.absMap]"), []);
  assert.equal(page.document.getElementById("teamLink").classList.contains("hidden"), true);
});

test("the first load that fails says so where the page was to appear", async () => {
  const page = dashboard({ answers: { "/api/personal": () => Promise.reject(new Error("Odoo caído")) } });
  page.run("loadFirst()");
  await settle();
  assert.equal(page.document.getElementById("loadmsg").textContent, "Error cargando datos de Odoo: Odoo caído");
});

test("loading renders the page from the server payload", async () => {
  const today = new Date();
  const data = payload([session(at(today, 9), null)], {
    schedule: { hours: [7, 7, 7, 7, 7, 0, 0], lunch_from: [13, 13, 13, 13, null, null, null] },
    absences: [{ date: "2026-09-14", type: "Festivo" }],
    phone: { url: "https://10.0.0.2:8443/", name_url: "https://mac.local:8443/" },
  });
  const page = load({ data });
  await page.run("loadAndRender()");
  const { document, run } = page;
  assert.equal(document.getElementById("title").textContent, "Ana");
  assert.match(document.getElementById("subtitle").textContent, /^Odoo · actualizado el /);
  assert.equal(document.getElementById("app").classList.contains("hidden"), false);
  assert.equal(run("store.weekTarget"), 35);
  assert.equal(run("lunchFrom(new Date(2026, 8, 14))"), 13);
  assert.equal(run("lunchFrom(new Date(2026, 8, 18))"), null);
  assert.match(document.getElementById("weeksHint").textContent, /jornada prevista en Odoo: 7h de lunes a viernes\./);
  assert.deepEqual(run("[...store.absMap]"), [["2026-09-14", "Festivo"]]);
  assert.ok(document.getElementById("hero").children.length > 0);
  const phone = document.getElementById("phone");
  assert.equal(phone.classList.contains("hidden"), false);
  assert.equal(phone.querySelectorAll(".qr").length, 0);
  const buttons = () => phone.querySelector(".seg").children;
  assert.deepEqual(
    buttons().map((b) => [b.textContent, b.getAttribute("aria-pressed")]),
    [
      ["Por nombre", "true"],
      ["Por IP", "false"],
    ],
  );
  assert.equal(phone.querySelector(".url").textContent, "https://mac.local:8443/");
  assert.equal(phone.querySelector(".btn").textContent, "Emparejar móvil");
  buttons()[1].listeners.click[0]();
  assert.deepEqual(
    buttons().map((b) => b.getAttribute("aria-pressed")),
    ["false", "true"],
  );
  assert.equal(phone.querySelector(".url").textContent, "https://10.0.0.2:8443/");
});

test("the page is busy while a tooltip is open or a button is armed, and idle otherwise", () => {
  const page = dashboard({ sessions: [session(at(TUESDAY, 9), null)] });
  assert.strictEqual(page.run("busy()"), false);
  page.document.getElementById("tip").style.display = "block";
  assert.strictEqual(page.run("busy()"), true);
  page.document.getElementById("tip").style.display = "none";
  assert.strictEqual(page.run("busy()"), false);
  heroOf(page)
    .querySelectorAll(".btn")
    .find((b) => b.textContent === "Fichar salida")
    .listeners.click[0]();
  assert.strictEqual(page.run("busy()"), true);
});
