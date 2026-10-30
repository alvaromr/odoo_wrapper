// The dashboard page's modules one by one: the hero and the phone block, the settings dialog and the punch
// button, the alarms, boot and the clock, the data load, the week figures and the login page. Where
// app.test.mjs checks that the page works, these assert what is drawn (tags, classes, attributes, text), what
// is requested (paths, bodies) and every edge of a comparison, so a mutant that changes any of them fails.
// Each page runs on a clock the test sets (clockAt): the harness's ticks on, and a figure a minute off would
// be a flaky test.

import assert from "node:assert/strict";
import test from "node:test";
import {
  at,
  element,
  fakeAudio,
  hover,
  load,
  memoryStorage,
  payload,
  RealDate,
  SCHEDULE,
  session,
  settle,
  TUESDAY,
  UP_TO_DATE,
} from "./page.mjs";

const SUNDAY = new Date(2026, 8, 20, 10, 0);
const MONDAY = new Date(2026, 8, 14, 10, 0);
const WEDNESDAY = new Date(2026, 8, 16, 10, 0);
const HOUR = 3.6e6;

function clockAt(start) {
  const clock = { now: start.getTime() };
  class Frozen extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(clock.now);
    }
    static now() {
      return clock.now;
    }
  }
  Frozen.set = (date) => {
    clock.now = date.getTime();
  };
  return Frozen;
}

function dump(node, depth = 0) {
  const pad = "  ".repeat(depth);
  if (typeof node === "string") return `${pad}${JSON.stringify(node)}`;
  if (node.tagName === "SVG") return `${pad}svg paths=${node.children.length}`;
  const own = [
    ...Object.entries(node.attrs).map(([k, v]) => `${k}=${v}`),
    ...Object.entries(node.style)
      .filter(([, v]) => typeof v !== "function")
      .map(([k, v]) => `${k}:${v}`),
    ...(node.type ? [`type=${node.type}`] : []),
    ...(node.title ? [`title=${node.title}`] : []),
    ...(node.disabled ? ["disabled"] : []),
  ];
  if (node.tagName === "INPUT") {
    own.push(`value=${node.value}`);
    if (node.type === "number") own.push(`min=${node.min}`, `max=${node.max}`, `step=${node.step}`);
  }
  if (node.tabIndex !== undefined) own.push(`tabindex=${node.tabIndex}`);
  const head =
    node.tagName.toLowerCase() +
    (node._id ? `#${node._id}` : "") +
    (node.className ? `.${node.className.split(" ").join(".")}` : "") +
    (node.textContent ? ` ${JSON.stringify(node.textContent)}` : "") +
    (own.length ? ` [${own.join(" ")}]` : "");
  return [`${pad}${head}`, ...node.children.map((c) => dump(c, depth + 1))].join("\n");
}

const answer =
  (body, status = 200) =>
  async () => ({ ok: status < 400, status, json: async () => body });

// The page with its payload already loaded on the clock `now`. Its first /api/data (the page's own load at
// boot) never answers, so a test decides when data arrives; `answers` says what other paths answer.
function dashboard({ sessions = [], extra = {}, now = TUESDAY, schedule = SCHEDULE, answers = {}, ...options } = {}) {
  const Clock = clockAt(now);
  const data = payload(sessions, { generated_at: now.toISOString(), ...extra });
  const sent = [];
  const shared = { ...data.state };
  let booted = false;
  const fetchImpl = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : undefined;
    sent.push({ url, method: opts?.method, headers: opts?.headers && { ...opts.headers }, body });
    if (url === "/api/data" && !booted) {
      booted = true;
      return new Promise(() => {});
    }
    if (answers[url]) return answers[url](url, opts);
    if (url === "/api/update") return answer(UP_TO_DATE)();
    if (url.startsWith("/api/data")) return answer(data)();
    if (url === "/api/state") return answer(Object.assign(shared, body))();
    return answer({})();
  };
  const page = load({ fetchImpl, ...options, globals: { Date: Clock, ...options.globals } });
  page.run(`store.data = ${JSON.stringify(data)}; store.state = store.data.state; ${schedule}`);
  page.run(`setClock(new Date(${now.getTime()})); indexSessions();`);
  return { ...page, Clock, data, sent };
}

const built = (page, expression) => {
  const probe = page.document.getElementById("probe");
  page.run(`document.getElementById("probe").replaceChildren(${expression}); 0`);
  return probe.children[0];
};
const heroOf = (page) => {
  page.run("renderHero()");
  return page.document.getElementById("hero");
};
const day = (page, changes = {}) => ({ ...page.run("buildWeek(0).days[1]"), ...changes });
const iso = (date) => date.toISOString();
const MIDNIGHT = new Date(2026, 8, 15, 0, 0);

test("last punch is the latest event, the check-out of a closed session and not the check-in at the same instant", () => {
  const nine = at(TUESDAY, 9);
  const noon = at(TUESDAY, 12);
  const page = dashboard({
    sessions: [session(noon, at(TUESDAY, 13), true), session(nine, noon)],
  });
  assert.deepEqual(page.run("lastPunch()"), { at: iso(at(TUESDAY, 13)), out: true, rest: true });
  page.run(
    `store.data.sessions = [${JSON.stringify(session(nine, noon))}, ${JSON.stringify(session(noon, null, true))}]`,
  );
  assert.deepEqual(page.run("lastPunch()"), { at: iso(noon), out: true, rest: false });
  page.run(`store.data.sessions = [${JSON.stringify(session(nine, null))}]`);
  assert.deepEqual(page.run("lastPunch()"), { at: iso(nine), open: true, rest: false });
  page.run("store.data.sessions = []");
  assert.equal(page.run("lastPunch()"), null);
});

test("the stretches of a span no leave covers leave out the empty ones", () => {
  const page = dashboard();
  const from = at(TUESDAY, 9);
  const leave = (h1, m1, h2, m2) => ({ from: iso(at(TUESDAY, h1, m1)), to: iso(at(TUESDAY, h2, m2)) });
  const spans = (leaves) =>
    page.run(
      `uncovered(new Date(${from.getTime()}), new Date(${at(TUESDAY, 10).getTime()}), ${JSON.stringify(leaves)})`,
    );
  const ms = (h, m) => at(TUESDAY, h, m).getTime();
  assert.deepEqual(spans([]), [[ms(9, 0), ms(10, 0)]]);
  assert.deepEqual(spans([leave(9, 0, 9, 30)]), [[ms(9, 30), ms(10, 0)]]);
  assert.deepEqual(spans([leave(9, 30, 10, 0)]), [[ms(9, 0), ms(9, 30)]]);
  assert.deepEqual(spans([leave(9, 15, 9, 45)]), [
    [ms(9, 0), ms(9, 15)],
    [ms(9, 45), ms(10, 0)],
  ]);
  assert.deepEqual(spans([leave(8, 0, 11, 0)]), []);
});

test("a session left open from an earlier day is stale, and one open since midnight is today's", () => {
  const page = dashboard();
  const open = (when) => page.run(`leftOpen({ open: true, at: new Date(${when.getTime()}), rest: false })`);
  assert.equal(open(new Date(MIDNIGHT.getTime() - 1)), true);
  assert.equal(open(MIDNIGHT), false);
  assert.equal(open(at(TUESDAY, 9)), false);
  assert.equal(page.run(`leftOpen({ open: false, at: new Date(${MIDNIGHT.getTime() - HOUR}), rest: false })`), false);
});

test("the last punch's line says what it was and how long ago", () => {
  const page = dashboard();
  const text = (code) => page.run(`punchText({ at: new Date(${at(TUESDAY, 8, 30).getTime()}), rest: false, ${code} })`);
  assert.equal(text("out: true"), "Última salida a las 08:30 · hace 1h 30m");
  assert.equal(
    page.run(`punchText({ at: new Date(${at(TUESDAY, 8, 30).getTime()}), out: true, rest: true })`),
    "Fin del descanso a las 08:30 · hace 1h 30m",
  );
  assert.equal(text("open: true"), "Entrada a las 08:30 · llevas 1h 30m");
  assert.equal(
    page.run(`punchText({ at: new Date(${at(TUESDAY, 8, 30).getTime()}), open: true, rest: true })`),
    "En descanso desde las 08:30 · llevas 1h 30m",
  );
  assert.equal(text(""), "Entrada a las 08:30 · hace 1h 30m");
  const yesterday = new Date(2026, 8, 14, 22, 0);
  assert.equal(
    page.run(`punchText({ at: new Date(${yesterday.getTime()}), open: true, rest: false })`),
    "Entrada del 14 sep a las 22:00 sin cerrar · hace 12h",
  );
});

const mondayDone = session(at(MONDAY, 9), at(MONDAY, 17, 30));

test("the hero of a working day draws the pending hours, the leave time, both meters, the last punch and the buttons", () => {
  const page = dashboard({ sessions: [mondayDone, session(at(TUESDAY, 9), null)] });
  assert.equal(
    dump(heroOf(page)),
    `div
  div.main
    span.label "Pendiente hoy"
    div.value.num "7h 30m"
    div.delta.flat "para la jornada de 8h 30m"
    div.eta
      "Salida estimada "
      b.num "18:00"
      " · incluye 30m de comida"
    div.note "Mar 15 sep · 1h fichadas"
  div.meter-box
    div.meter-block
      div.meter.day
        div.fill [width:11.76470588235294%]
      div.meter-caption.strong
        span "Jornada de hoy"
        span "1h · 12 %"
    div.meter-block
      div.meter.week
        div.fill [width:23.75%]
        div.scale
          div.day [--hours:8.5]
          div.day [--hours:8.5]
          div.day [--hours:8.5]
          div.day [--hours:8.5]
          div.day [--hours:6]
      div.meter-caption
        span "Semana 14–20 sep · faltan 30h 30m"
        span "9h 30m / 40h"
    div.lastpunch.open
      span.dot
      span "Entrada a las 09:00 · llevas 1h"
  div.actions
    button.btn.primary "Fichar salida"
    button.btn.ghost "Salir a descanso"
    div.notify-row
      button.icon-btn [aria-label=Ajustes type=button title=Ajustes]
        svg paths=2
      button.icon-btn [aria-label=Silenciar avisos aria-pressed=false type=button title=Silenciar avisos]
        svg paths=2
      div.note "Sonará al cumplir la jornada · toca la página para oírlo"
    div.err`,
  );
  assert.equal(page.run("store.punchEl === document.getElementById('hero').children[1].children[2].children[1]"), true);
  assert.equal(page.run("store.punchEv.open"), true);
});

test("the hero of a finished day, a week short of its target and the buttons that follow", () => {
  const sessions = [mondayDone, session(at(TUESDAY, 1), null)];
  const page = dashboard({ sessions });
  const hero = heroOf(page);
  assert.deepEqual(dump(hero.children[0]).split("\n"), [
    "div.main",
    '  span.label "Hoy"',
    '  div.value.text.done "Jornada cumplida"',
    '  div.delta.flat "▲ +30m sobre 8h 30m"',
    '  div.note "Mar 15 sep · 9h fichadas"',
  ]);
  assert.deepEqual(dump(hero.children[1].children[0]).split("\n"), [
    "div.meter-block",
    "  div.meter.day.done",
    "    div.fill [width:100%]",
    "  div.meter-caption.strong",
    '    span "Jornada de hoy"',
    '    span "9h · 106 %"',
  ]);
  assert.equal(hero.children[2].children[0].className, "btn primary pulse");
  assert.equal(hero.children[1].children[1].children[1].children[0].textContent, "Semana 14–20 sep · faltan 22h 30m");
  const exact = dashboard({ sessions: [mondayDone, session(at(TUESDAY, 1, 30), null)] });
  const text = (h) => [h.children[0].children[1].textContent, h.children[0].children[2].textContent];
  assert.deepEqual(text(heroOf(exact)), ["Jornada cumplida", "justo en las 8h 30m previstas"]);
  assert.equal(heroOf(exact).children[1].children[0].children[0].className, "meter day done");
  assert.equal(heroOf(exact).children[2].children[0].className, "btn primary pulse");
  const almost = dashboard({ sessions: [mondayDone, session(at(TUESDAY, 1, 31), null)] });
  assert.equal(heroOf(almost).children[1].children[0].children[0].className, "meter day");
  assert.equal(heroOf(almost).children[2].children[0].className, "btn primary");
  assert.equal(heroOf(almost).children[0].children[1].textContent, "1m");
});

test("the week meter reaches its target, flags a week to review and says a vacation week is one", () => {
  const complete = dashboard({ sessions: [mondayDone, session(at(TUESDAY, 9), at(TUESDAY, 10))] });
  const caption = (page) => heroOf(page).children[1].children[1].children[1].children.map((s) => s.textContent);
  assert.deepEqual(caption(complete), ["Semana 14–20 sep · faltan 30h 30m", "9h 30m / 40h"]);
  complete.run("store.expected = [8.5, 0, 0, 0, 0, 0, 0]; store.weekTarget = 8.5");
  assert.deepEqual(caption(complete), ["Semana 14–20 sep · objetivo alcanzado", "9h 30m / 8h 30m"]);
  const week = heroOf(complete).children[1].children[1].children[0];
  assert.equal(week.children[0].style.width, "100%");
  assert.equal(week.children[1].children.length, 1);
  const review = dashboard({ sessions: [session(at(TUESDAY, 9), at(TUESDAY, 10))] });
  assert.equal(caption(review)[0], "Semana 14–20 sep · hay un fichaje por revisar");
  const vacation = dashboard({
    sessions: [],
    schedule: "store.expected = [0, 0, 0, 0, 0, 0, 0]; store.weekTarget = 0;",
  });
  const hero = heroOf(vacation);
  assert.deepEqual(dump(hero.children[1].children[1]).split("\n"), [
    "div.meter-block",
    '  div.note "Semana marcada como vacaciones"',
  ]);
  assert.deepEqual(dump(hero.children[0]).split("\n"), [
    "div.main",
    '  span.label "Hoy"',
    '  div.value.text "Sin jornada"',
    '  div.delta.flat "hoy no hay jornada prevista"',
    '  div.note "Mar 15 sep · 0h fichadas"',
  ]);
  assert.deepEqual(dump(hero.children[1].children[0]).split("\n"), [
    "div.meter-block",
    "  div.meter.day.done",
    "    div.fill [width:0%]",
    "  div.meter-caption.strong",
    '    span "Jornada de hoy"',
    '    span "0h · sin objetivo"',
  ]);
});

test("without a day's hours expected the meter fills only for real work, and absences name the day", () => {
  const page = dashboard({ sessions: [], schedule: "store.expected = [0, 0, 0, 0, 0, 0, 0]; store.weekTarget = 0;" });
  const meter = (hours) => {
    const box = built(
      page,
      `heroMeters(buildWeek(0), ${JSON.stringify(day(page, { expected: 0, hours }))}, undefined, 0, 0, 0)`,
    );
    return [box.children[0].children[0].className, box.children[0].children[0].children[0].style.width];
  };
  assert.deepEqual(meter(0), ["meter day done", "0%"]);
  assert.deepEqual(meter(0.01), ["meter day done", "0%"]);
  assert.deepEqual(meter(0.02), ["meter day done", "100%"]);
  const working = dashboard({ sessions: [], schedule: SCHEDULE });
  const bar = (expected, hours) => {
    const box = built(
      working,
      `heroMeters(buildWeek(0), ${JSON.stringify(day(working, { expected, hours }))}, undefined, 0, 0, 0)`,
    );
    return [box.children[0].children[0].className, box.children[0].children[0].children[0].style.width];
  };
  assert.deepEqual(bar(8, 8), ["meter day done", "100%"]);
  assert.deepEqual(bar(8, 7.99), ["meter day", "99.875%"]);
  assert.deepEqual(bar(8, 2), ["meter day", "25%"]);
  assert.deepEqual(bar(8, 12), ["meter day done", "100%"]);
  working.run(`store.absMap = new Map([["2026-09-15", "Festivo"]])`);
  const hero = heroOf(working);
  assert.deepEqual(
    hero.children[0].children.map((c) => c.textContent),
    ["Hoy", "Sin jornada", "Festivo", "Mar 15 sep · Festivo · 0h fichadas"],
  );
});

test("the day's note lists each leave and the headline adds only a lunch that is worth saying", () => {
  const page = dashboard({ sessions: [session(at(TUESDAY, 9), null)] });
  const leaves = [
    { type: "Médico", hours: 0.5 },
    { type: "Dentista", hours: 1 },
  ];
  const headline = (lunchLeft, extras = "") =>
    dump(
      built(
        page,
        `heroHeadline(${JSON.stringify(day(page, { expected: 8, hours: 1, leaves }))}, 7, -7, new Date(${at(TUESDAY, 17).getTime()}), ${lunchLeft}${extras})`,
      ),
    ).split("\n");
  assert.deepEqual(headline(0.5), [
    "div.main",
    '  span.label "Pendiente hoy"',
    '  div.value.num "7h"',
    '  div.delta.flat "para la jornada de 8h"',
    "  div.eta",
    '    "Salida estimada "',
    '    b.num "17:00"',
    '    " · incluye 30m de comida"',
    '  div.note "Mar 15 sep · Médico 30m · Dentista 1h · 1h fichadas"',
  ]);
  assert.equal(headline(0.01).includes('    " · incluye 1m de comida"'), false);
  assert.equal(
    headline(0).some((l) => l.includes("incluye")),
    false,
  );
  assert.equal(headline(0.02).includes('    " · incluye 1m de comida"'), true);
});

test("the headline says why nothing is estimated and tells a day done from one a minute over", () => {
  const page = dashboard();
  const lines = (args) =>
    dump(built(page, `heroHeadline(${JSON.stringify(day(page, { expected: 8, leaves: [] }))}, ${args})`)).split("\n");
  assert.equal(lines("7, -7, null, 0")[3], '  div.delta.flat "para la jornada de 8h · sin fichaje abierto"');
  assert.equal(lines("7, -7, null, 0, false")[3], '  div.delta.flat "para la jornada de 8h · sin fichaje abierto"');
  assert.equal(
    lines("7, -7, null, 0, true")[3],
    '  div.delta.flat "para la jornada de 8h · hay una entrada anterior sin cerrar"',
  );
  assert.equal(lines(`7, -7, new Date(), 0, true`)[3], '  div.delta.flat "para la jornada de 8h"');
  assert.equal(lines("0, 0, null, 0")[3], '  div.delta.flat "justo en las 8h previstas"');
  assert.equal(lines(`0, ${1 / 60 - 1e-9}, null, 0`)[3], '  div.delta.flat "justo en las 8h previstas"');
  assert.equal(lines(`0, ${1 / 60}, null, 0`)[3], '  div.delta.flat "▲ +1m sobre 8h"');
  assert.equal(lines("0, 0.5, null, 0")[3], '  div.delta.flat "▲ +30m sobre 8h"');
  const vacation = dump(
    built(
      page,
      `heroHeadline(${JSON.stringify(day(page, { expected: 0, vacation: true, auto: "Baja", leaves: [] }))}, 0, 0, null, 0)`,
    ),
  ).split("\n");
  assert.equal(vacation[3], '  div.delta.flat "Baja"');
});

test("the last punch line is open, on a break, stale or closed, and says so when there is none", () => {
  const punchBox = (sessions, now = TUESDAY) => {
    const meters = heroOf(dashboard({ sessions: [mondayDone, ...sessions], now })).children[1];
    return meters.children[2];
  };
  assert.equal(
    dump(punchBox([session(at(TUESDAY, 9), null)])),
    'div.lastpunch.open\n  span.dot\n  span "Entrada a las 09:00 · llevas 1h"',
  );
  assert.equal(
    dump(punchBox([session(at(TUESDAY, 9), at(TUESDAY, 9, 30)), session(at(TUESDAY, 9, 31), null, true)])),
    'div.lastpunch.rest\n  span.dot\n  span "En descanso desde las 09:31 · llevas 29m"',
  );
  assert.equal(
    dump(punchBox([session(at(TUESDAY, 9), at(TUESDAY, 9, 30))])),
    'div.lastpunch\n  span.dot\n  span "Última salida a las 09:30 · hace 30m"',
  );
  const stale = punchBox([session(new Date(2026, 8, 14, 22, 0), null)]);
  assert.equal(stale.className, "lastpunch stale");
  assert.equal(stale.children[1].textContent, "Entrada del 14 sep a las 22:00 sin cerrar · hace 12h");
  const none = heroOf(dashboard({ sessions: [] })).children[1].children[2];
  assert.equal(dump(none), 'div.note "Sin fichajes registrados"');
});

test("a stale open session estimates no leave time, and says so", () => {
  const stale = heroOf(dashboard({ sessions: [session(new Date(2026, 8, 14, 22, 0), null)] }));
  assert.equal(
    stale.children[0].children[2].textContent,
    "para la jornada de 8h 30m · hay una entrada anterior sin cerrar",
  );
  const closed = heroOf(dashboard({ sessions: [mondayDone] }));
  assert.equal(closed.children[0].children[2].textContent, "para la jornada de 8h 30m · sin fichaje abierto");
  assert.deepEqual(stale.children[2].children.map((b) => b.textContent).slice(0, 2), [
    "Fichar salida",
    "Salir a descanso",
  ]);
});

test("an open session since midnight is today's work and gets a leave time", () => {
  const page = dashboard({ sessions: [mondayDone, session(MIDNIGHT, null)], now: at(TUESDAY, 3) });
  const main = heroOf(page).children[0];
  assert.equal(main.children[2].textContent, "para la jornada de 8h 30m");
  assert.equal(main.children[3].children[1].textContent, "09:00");
});

test("the time away takes the lunch off the estimate only past a hair's breadth", () => {
  const first = session(at(TUESDAY, 9), at(TUESDAY, 9, 30));
  const notes = (hero) => hero.querySelectorAll(".note").map((n) => n.textContent);
  const hair = heroOf(dashboard({ sessions: [mondayDone, first, session(new Date(2026, 8, 15, 9, 30, 36), null)] }));
  assert.equal(hair.children[0].children[3].children[2], " · incluye 30m de comida");
  assert.equal(
    notes(hair).some((n) => n.startsWith("Ausente")),
    false,
  );
  const gap = heroOf(dashboard({ sessions: [mondayDone, first, session(at(TUESDAY, 9, 45), null)] }));
  assert.equal(gap.children[0].children[3].children.length, 2);
  assert.equal(gap.children[0].children[3].children[1].textContent, "17:45");
  assert.ok(notes(gap).includes("Ausente hoy: 15m"));
});

test("a break already over is noted without saying it is in progress, even when nothing is open", () => {
  const rest = session(at(TUESDAY, 9), at(TUESDAY, 9, 15), true);
  const closed = dashboard({ sessions: [mondayDone, rest] });
  const notes = (hero) => hero.querySelectorAll(".note").map((n) => n.textContent);
  assert.ok(notes(heroOf(closed)).includes("Descanso de hoy: 15m ausente"));
  const tiny = heroOf(
    dashboard({ sessions: [mondayDone, session(at(TUESDAY, 9), new Date(2026, 8, 15, 9, 0, 36), true)] }),
  );
  assert.equal(
    notes(tiny).some((n) => n.startsWith("Descanso de hoy")),
    false,
  );
  const direct = (restToday, away, open) =>
    built(closed, `heroMeters(buildWeek(0), ${JSON.stringify(day(closed))}, ${open}, 0, ${restToday}, ${away})`)
      .children.slice(3)
      .map((n) => n.textContent);
  assert.deepEqual(direct(0.02, 0, "undefined"), ["Descanso de hoy: 1m ausente"]);
  assert.deepEqual(direct(0.01, 0.01, "undefined"), []);
  assert.deepEqual(direct(0, 0.02, "undefined"), ["Ausente hoy: 1m"]);
  assert.deepEqual(direct(0.5, 0, JSON.stringify(session(at(TUESDAY, 9), null, true))), [
    "Descanso de hoy: 30m ausente (en curso)",
  ]);
  assert.deepEqual(direct(0.5, 0, JSON.stringify(session(at(TUESDAY, 9), null))), ["Descanso de hoy: 30m ausente"]);
});

test("a break is drawn inside the day's bar and the button to come back leads the actions", () => {
  const sessions = [
    mondayDone,
    session(at(TUESDAY, 8), at(TUESDAY, 9)),
    session(at(TUESDAY, 9), at(TUESDAY, 9, 30), true),
  ];
  const page = dashboard({ sessions: [...sessions, session(at(TUESDAY, 9, 30), null, true)] });
  const hero = heroOf(page);
  assert.deepEqual(dump(hero.children[1].children[0].children[0]).split("\n"), [
    "div.meter.day",
    `  div.fill [width:${(2 / 8.5) * 100}%]`,
    "    div.rest [left:50% width:25%]",
    "    div.rest [left:75% width:25%]",
  ]);
  assert.deepEqual(
    hero.children[2].children.slice(0, 2).map((b) => `${b.className}|${b.textContent}`),
    ["btn primary|Volver del descanso", "btn ghost|Fichar salida"],
  );
});

const buttonOf = (page, label) =>
  heroOf(page)
    .querySelectorAll(".btn")
    .find((b) => b.textContent === label);
const errOf = (page) => page.document.getElementById("hero").children[2].children.at(-1);
const press = async (page, label) => {
  const button = buttonOf(page, label);
  await button.listeners.click[0]();
  await button.listeners.click[0]();
  await settle();
  return button;
};

test("each punch button posts its own action after a second click, then reloads", async () => {
  const lunchTime = at(TUESDAY, 14);
  const open = [session(at(TUESDAY, 9), null)];
  const scenarios = [
    ["Fichar entrada", "checkin", "btn primary", { sessions: [] }],
    ["Fichar salida", "checkout", "btn primary", { sessions: open, now: lunchTime }],
    ["Salir a comer", "lunch", "btn ghost", { sessions: open, now: lunchTime }],
    ["Salir a descanso", "break", "btn ghost", { sessions: open, now: lunchTime }],
    ["Volver del descanso", "resume", "btn primary", { sessions: [session(at(TUESDAY, 9), null, true)] }],
  ];
  for (const [label, action, cls, options] of scenarios) {
    const page = dashboard(options);
    assert.equal(buttonOf(page, label).className, cls, label);
    await press(page, label);
    const posted = page.sent.filter((r) => r.method === "POST");
    assert.deepEqual(posted, [
      {
        url: "/api/attendance",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { action },
      },
    ]);
    assert.equal(page.sent.at(-1).url, "/api/data");
  }
});

test("a punch button arms for four seconds, and a pulsing one gets its pulse back", () => {
  const cleared = [];
  const page = dashboard({
    sessions: [session(at(TUESDAY, 1), null)],
    globals: { clearTimeout: (id) => cleared.push(id) },
  });
  const button = buttonOf(page, "Fichar salida");
  assert.equal(button.className, "btn primary pulse");
  button.listeners.click[0]();
  assert.equal(button.className, "btn primary arm");
  assert.equal(button.textContent, "¿Confirmar?");
  const [expire, ms] = page.calls.timeouts.at(-1);
  assert.equal(ms, 4000);
  expire();
  assert.equal(button.className, "btn primary pulse");
  assert.equal(button.textContent, "Fichar salida");
  button.listeners.click[0]();
  assert.equal(page.run("busy()"), true);
  button.listeners.click[0]();
  assert.deepEqual(cleared, [page.calls.timeouts.length]);
  const calm = dashboard({ sessions: [session(at(TUESDAY, 9), null)] });
  const other = buttonOf(calm, "Salir a descanso");
  other.listeners.click[0]();
  calm.calls.timeouts.at(-1)[0]();
  assert.equal(other.className, "btn ghost");
});

test("a punch in flight disables its button and clears the last error; a refusal gives the button back", async () => {
  let release;
  const page = dashboard({
    sessions: [session(at(TUESDAY, 9), null)],
    answers: {
      "/api/attendance": () => new Promise((resolve) => (release = resolve)),
    },
  });
  const button = buttonOf(page, "Fichar salida");
  errOf(page).textContent = "viejo";
  button.listeners.click[0]();
  button.listeners.click[0]();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Fichando…");
  assert.equal(errOf(page).textContent, "");
  release({ ok: false, status: 409, json: async () => ({ error: "Ya has fichado" }) });
  await settle();
  assert.equal(errOf(page).textContent, "Error: Ya has fichado");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Fichar salida");
  assert.equal(button.className, "btn primary");
});

test("a punch that went through but whose reload failed says so and keeps the button off", async () => {
  const page = dashboard({
    sessions: [session(at(TUESDAY, 9), null)],
    answers: { "/api/data": () => Promise.reject(new Error("Odoo caído")) },
  });
  const button = await press(page, "Fichar salida");
  assert.equal(errOf(page).textContent, "Fichado, pero no se pudo recargar: Odoo caído");
  assert.equal(button.disabled, true);
});

test("a punch ends by running the alarms on the fresh data", async () => {
  const page = dashboard({
    sessions: [session(at(TUESDAY, 9), null)],
    extra: { generated_at: at(TUESDAY, 8).toISOString() },
  });
  await press(page, "Fichar salida");
  assert.equal(page.run("store.now.getTime()"), TUESDAY.getTime());
});

test("the bell mutes the alerts and silences a blinking title, and unmutes without touching it", async () => {
  const page = dashboard({ sessions: [session(at(TUESDAY, 9), null)] });
  const mute = () =>
    heroOf(page)
      .querySelectorAll(".icon-btn")
      .find((b) => b.title.endsWith("avisos"));
  page.run(`flashTitle("⏰")`);
  page.calls.timers.at(-1)[0]();
  assert.equal(page.document.title, "⏰");
  mute().listeners.click[0]();
  assert.equal(page.document.title, "Fichajes");
  assert.equal(page.run("FlashTimer"), null);
  assert.equal(mute().title, "Reactivar avisos");
  assert.equal(mute().attrs["aria-label"], "Reactivar avisos");
  assert.equal(mute().attrs["aria-pressed"], "true");
  assert.equal(mute().children[0].children.length, 3);
  await settle();
  assert.deepEqual(
    page.sent.filter((r) => r.url === "/api/state").map((r) => r.body),
    [{ muted: true }],
  );
  page.run(`flashTitle("⏰")`);
  page.calls.timers.at(-1)[0]();
  mute().listeners.click[0]();
  assert.equal(page.document.title, "⏰");
  assert.notEqual(page.run("FlashTimer"), null);
});

const PHONE = { url: "https://192.168.1.5:8443/", name_url: "https://mac.local:8443/" };
const phoneOf = (page) => {
  page.run("renderPhone()");
  return page.document.getElementById("phone");
};
const pairingOf = (changes = {}) => ({
  url: "https://192.168.1.5:8443/pair?t=abc",
  qr: "<svg>qr</svg>",
  expires_in: 60,
  ...changes,
});

test("the phone block hides unless the page is plain http and the server has an address for it", () => {
  const without = phoneOf(dashboard({ extra: { phone: null } }));
  assert.equal(without.classList.contains("hidden"), true);
  assert.equal(without.children.length, 0);
  const secure = dashboard({ extra: { phone: PHONE } });
  secure.run(`location.protocol = "https:"`);
  assert.equal(phoneOf(secure).classList.contains("hidden"), true);
  assert.equal(phoneOf(secure).children.length, 0);
  const shown = phoneOf(dashboard({ extra: { phone: PHONE } }));
  assert.equal(shown.classList.contains("hidden"), false);
});

test("the phone block offers the address by name or by IP and a button to pair", () => {
  const page = dashboard({ extra: { phone: PHONE } });
  assert.equal(
    dump(phoneOf(page)),
    `div
  div.links
    h2 "Abrir en el móvil"
    div.seg [role=group aria-label=URL del móvil]
      button "Por nombre" [aria-pressed=true type=button]
      button "Por IP" [aria-pressed=false type=button]
    div.url "https://mac.local:8443/"
    button.btn.primary "Emparejar móvil" [type=button]
      svg paths=12
    div.note "Si tu móvil resuelve mDNS, vale en todas las redes. El móvil entra con la sesión de este navegador, sin escribir la contraseña."`,
  );
  phoneOf(page).children[0].children[1].children[1].listeners.click[0]();
  assert.equal(
    dump(page.document.getElementById("phone")),
    `div
  div.links
    h2 "Abrir en el móvil"
    div.seg [role=group aria-label=URL del móvil]
      button "Por nombre" [aria-pressed=false type=button]
      button "Por IP" [aria-pressed=true type=button]
    div.url "https://192.168.1.5:8443/"
    button.btn.primary "Emparejar móvil" [type=button]
      svg paths=12
    div.note "Vale en esta red; al cambiar de red, empareja de nuevo. El móvil entra con la sesión de este navegador, sin escribir la contraseña."`,
  );
});

test("where the dashboard is not on the LAN the phone block says what it is for and why it is off", () => {
  const page = dashboard({ extra: { phone: { off: "Escucha solo en localhost: arranca con --lan." } } });
  assert.equal(
    dump(phoneOf(page)),
    `div
  div.links
    h2 "Abrir en el móvil"
    div.note "Este panel también se puede usar desde el móvil, conectado a la misma red que este ordenador: aquí aparecería un código QR para escanearlo con su cámara. Ahora no está disponible."
    div.note "Escucha solo en localhost: arranca con --lan."`,
  );
});

test("pairing shows the code and its countdown, cancel revokes it, and the timer stops when it lapses", async () => {
  const cleared = [];
  let calls = 0;
  const page = dashboard({
    extra: { phone: PHONE },
    globals: { clearInterval: (id) => cleared.push(id) },
    answers: {
      "/api/pair": () => (++calls === 1 ? answer(pairingOf())() : Promise.reject(new Error("sin red"))),
    },
  });
  const pairButton = () =>
    phoneOf(page)
      .children.at(-1)
      .children.find((c) => c.textContent === "Emparejar móvil");
  const first = pairButton();
  first.listeners.click[0]();
  assert.equal(first.disabled, true);
  await settle();
  const [tick, ms] = page.calls.timers.at(-1);
  assert.equal(ms, 1000);
  assert.deepEqual(
    page.sent.filter((r) => r.url === "/api/pair"),
    [{ url: "/api/pair", method: "POST", headers: { "Content-Type": "application/json" }, body: { name: true } }],
  );
  assert.equal(
    dump(page.document.getElementById("phone")),
    `div
  div.qr
  div.links
    h2 "Abrir en el móvil"
    div.seg [role=group aria-label=URL del móvil]
      button "Por nombre" [aria-pressed=true type=button]
      button "Por IP" [aria-pressed=false type=button]
    div.url "https://192.168.1.5:8443/pair?t=abc"
    button.btn.ghost "Cancelar" [type=button]
    div.note "Escanea el código con la cámara del móvil: caduca en 60 s y sirve una sola vez. Si el móvil avisa del certificado, acéptalo."`,
  );
  assert.equal(page.document.getElementById("phone").children[0].innerHTML, "<svg>qr</svg>");
  page.Clock.set(new Date(TUESDAY.getTime() + 25_500));
  tick();
  assert.equal(
    page.document.getElementById("phone").children.at(-1).children.at(-1).textContent.includes("caduca en 35 s"),
    true,
  );
  assert.deepEqual(cleared, []);
  page.Clock.set(new Date(TUESDAY.getTime() + 60_000));
  tick();
  assert.deepEqual(cleared, [page.calls.timers.length]);
  assert.equal(page.document.getElementById("phone").children.length, 1);
  assert.equal(page.run("pairing"), null);
});

test("cancelling a pairing revokes it, and a revoke that fails is logged", async () => {
  let calls = 0;
  const page = dashboard({
    extra: { phone: PHONE },
    answers: { "/api/pair": () => (++calls === 1 ? answer(pairingOf())() : Promise.reject(new Error("sin red"))) },
  });
  phoneOf(page)
    .children[0].children.find((c) => c.textContent === "Emparejar móvil")
    .listeners.click[0]();
  await settle();
  const cancel = page.document
    .getElementById("phone")
    .children.at(-1)
    .children.find((c) => c.textContent === "Cancelar");
  cancel.listeners.click[0]();
  await settle();
  assert.equal(page.document.getElementById("phone").children.length, 1);
  assert.deepEqual(page.sent.filter((r) => r.url === "/api/pair").at(-1).body, { revoke: true });
  assert.deepEqual(page.calls.warnings, ["[odoo] revoking the pairing failed: Error: sin red"]);
});

test("a pairing that fails says why until the next try clears it, and the other view drops a live pairing", async () => {
  let calls = 0;
  const page = dashboard({
    extra: { phone: PHONE },
    answers: {
      "/api/pair": () =>
        ++calls === 1 ? answer({ error: "Sin LAN" }, 500)() : calls === 2 ? answer(pairingOf())() : answer({})(),
    },
  });
  const links = () => page.document.getElementById("phone").children.at(-1);
  const pairButton = () => links().children.find((c) => c.textContent === "Emparejar móvil");
  assert.equal(phoneOf(page).children[0].children.at(-1).textContent.includes("No se pudo"), false);
  pairButton().listeners.click[0]();
  await settle();
  assert.equal(links().children.at(-1).textContent, "No se pudo emparejar: Sin LAN");
  pairButton().listeners.click[0]();
  await settle();
  assert.equal(page.run("pairError"), "");
  links().children[1].children[1].listeners.click[0]();
  assert.equal(page.run("pairing"), null);
  pairButton().listeners.click[0]();
  await settle();
  links()
    .children.find((c) => c.textContent === "Cancelar")
    .listeners.click[0]();
  await settle();
  assert.equal(links().children.at(-1).textContent.startsWith("Si tu móvil resuelve mDNS"), false);
  assert.equal(links().children.at(-1).textContent.startsWith("Vale en esta red"), true);
});

test("the gear opens the settings dialog", () => {
  const page = dashboard({ sessions: [] });
  const gear = heroOf(page)
    .querySelectorAll(".icon-btn")
    .find((b) => b.title === "Ajustes");
  assert.equal(page.document.getElementById("settingsDialog").open, false);
  gear.listeners.click[0]();
  assert.equal(page.document.getElementById("settingsDialog").open, true);
});

test("a break is drawn at its place in the bar, as a share of the total", () => {
  const page = dashboard();
  const bar = built(
    page,
    `fillBar(document.createElement("div"), [
      { hours: 4, rest: false }, { hours: 2, rest: true }, { hours: 1, rest: false }, { hours: 1, rest: true },
    ], 8)`,
  );
  assert.deepEqual(dump(bar).split("\n"), [
    "div",
    "  div.rest [left:50% width:25%]",
    "  div.rest [left:87.5% width:12.5%]",
  ]);
});

test("the page is busy while a tooltip is open or a button is armed, and idle otherwise", () => {
  const page = dashboard({ sessions: [session(at(TUESDAY, 9), null)] });
  assert.strictEqual(page.run("busy()"), false);
  page.document.getElementById("tip").style.display = "block";
  assert.strictEqual(page.run("busy()"), true);
  page.document.getElementById("tip").style.display = "none";
  assert.strictEqual(page.run("busy()"), false);
  buttonOf(page, "Fichar salida").listeners.click[0]();
  assert.strictEqual(page.run("busy()"), true);
});

test("the settings dialog is built once, hidden, with its title, body, status note and close button", () => {
  const page = dashboard();
  const dialog = page.document.getElementById("settingsDialog");
  assert.equal(
    dump(dialog),
    `dialog#settingsDialog.dialog [aria-labelledby=settingsTitle]
  h2#settingsTitle "Ajustes"
  div#settingsBody.settings
  p#settingsNote.dialog-note [role=status]
  div.dialog-actions
    button.btn.ghost "Cerrar" [type=button]`,
  );
  assert.equal(page.document.body.children.includes(dialog), true);
  const tip = page.document.getElementById("tip");
  page.run("openSettings()");
  assert.equal(dialog.children.includes(tip), true);
  tip.style.display = "block";
  dialog.listeners.close[0]();
  assert.equal(tip.style.display, "none");
  assert.equal(page.document.body.children.at(-1), tip);
  dialog.children.at(-2).children[0].listeners.click[0]();
  assert.equal(dialog.open, false);
});

test("opening the settings lists lunch, break, the lunch button's window, theme and updates", () => {
  const page = dashboard();
  const note = page.document.getElementById("settingsNote");
  note.textContent = "de antes";
  page.run("openSettings()");
  assert.equal(note.textContent, "");
  assert.equal(page.document.getElementById("settingsDialog").open, true);
  assert.equal(
    dump(page.document.getElementById("settingsBody")),
    `div#settingsBody.settings
  div.setting [tabindex=0]
    span.setting-name "Comida"
    label.duration
      input.lunch-input [aria-label=Minutos de comida type=number value=30 min=0 max=240 step=5]
      " min"
  div.setting [tabindex=0]
    span.setting-name "Descanso"
    label.duration
      input.lunch-input [aria-label=Minutos de descanso type=number value=15 min=0 max=240 step=5]
      " min"
  div.setting [tabindex=0]
    span.setting-name "Botón «Salir a comer»"
    "de"
    input.clock-input [aria-label=Aparece a las type=time value=13:30]
    "a"
    input.clock-input [aria-label=Desaparece a las type=time value=16:00]
  div.setting [tabindex=0]
    span.setting-name "Tema"
    div.seg [role=group aria-label=Tema]
      button "Sistema" [aria-pressed=true type=button]
      button "Claro" [aria-pressed=false type=button]
      button "Oscuro" [aria-pressed=false type=button]
  div.setting [tabindex=0]
    span.setting-name "Actualizaciones"
    button.btn.ghost.small "Buscar ahora" [type=button]`,
  );
  const without = dashboard({ extra: { breaks: false } });
  without.run("openSettings()");
  assert.deepEqual(
    without.document.getElementById("settingsBody").children.map((row) => row.children[0].textContent),
    ["Comida", "Botón «Salir a comer»", "Tema", "Actualizaciones"],
  );
});

test("each setting explains in a tooltip what it drives", () => {
  const page = dashboard();
  page.run("openSettings()");
  const rows = page.document.getElementById("settingsBody").children;
  const tips = rows.map((row) => hover(page, row));
  assert.deepEqual(tips, [
    [
      "Lo que sueles tardar en comer. Los días con comida en tu calendario de Odoo se suma a la hora estimada de salida " +
        "hasta tu primera ausencia del día; tras «Salir a comer», el aviso «Comida terminada» suena pasado este tiempo.",
    ],
    [
      "Lo que dura un descanso. El aviso «Descanso terminado» suena pasado este tiempo desde que empieza; con 0 no suena.",
    ],
    [
      "Horas entre las que aparece el botón «Salir a comer», solo los días con comida en tu calendario de Odoo y mientras " +
        "no lo hayas usado ese día. Ficha una salida normal y además pone en marcha el aviso de fin de comida.",
    ],
    ["Colores de la página en este navegador. «Sistema» sigue el modo claro u oscuro del dispositivo."],
    [
      "El panel busca versiones nuevas en GitHub cada pocas horas y avisa arriba cuando hay una. Este botón lo comprueba ahora.",
    ],
  ]);
  assert.equal(rows[0].listeners.focus.length, 1);
  rows[0].listeners.pointerenter[0]({ clientX: 10, clientY: 10 });
  assert.equal(dump(page.document.getElementById("tip")).split("\n")[1].startsWith("  div.t-note "), true);
});

test("a duration is saved clamped to what the server takes, and shown as the server keeps it", async () => {
  const page = dashboard();
  page.run("openSettings()");
  const input = page.document.getElementById("settingsBody").children[0].children[1].children[0];
  const type = async (value) => {
    input.value = value;
    await input.listeners.change[0]();
    return page.sent.filter((r) => r.url === "/api/state").at(-1).body;
  };
  assert.deepEqual(await type("500"), { lunch_minutes: 240 });
  assert.equal(input.value, "240");
  assert.deepEqual(await type("-5"), { lunch_minutes: 0 });
  assert.deepEqual(await type("12.6"), { lunch_minutes: 13 });
  assert.deepEqual(await type("abc"), { lunch_minutes: 0 });
});

test("the lunch button's window is saved only when it opens before it closes", async () => {
  const page = dashboard();
  page.run("openSettings()");
  const [from, to] = page.document
    .getElementById("settingsBody")
    .children[2].children.filter((c) => c.tagName === "INPUT");
  const note = page.document.getElementById("settingsNote");
  const posts = () => page.sent.filter((r) => r.url === "/api/state").map((r) => r.body);
  from.value = "14:30";
  await from.listeners.change[0]();
  assert.deepEqual(posts(), [{ lunch_button_from: 870 }]);
  assert.equal(note.textContent, "");
  from.value = "16:00";
  await from.listeners.change[0]();
  assert.equal(posts().length, 1);
  assert.equal(note.textContent, "No se ha guardado: el botón tiene que aparecer antes de la hora en que desaparece.");
  assert.equal(from.value, "14:30");
  to.value = "";
  await to.listeners.change[0]();
  assert.equal(posts().length, 1);
  assert.equal(note.textContent, "");
  assert.equal(to.value, "16:00");
  to.value = "17:05";
  await to.listeners.change[0]();
  assert.deepEqual(posts().at(-1), { lunch_button_to: 1025 });
  assert.equal(to.value, "17:05");
  from.value = "17:05";
  await from.listeners.change[0]();
  assert.equal(posts().length, 2);
  assert.equal(note.textContent.startsWith("No se ha guardado"), true);
});

test("the theme buttons mark the one in force, apply a choice, and say when the browser cannot keep it", () => {
  const page = dashboard();
  page.run("openSettings()");
  const note = page.document.getElementById("settingsNote");
  const buttons = () => page.document.getElementById("settingsBody").children[3].children[1].children;
  const pressed = () => buttons().map((b) => b.attrs["aria-pressed"]);
  assert.deepEqual(
    buttons().map((b) => b.dataset.theme),
    ["", "light", "dark"],
  );
  buttons()[2].listeners.click[0]();
  assert.equal(page.document.documentElement.dataset.theme, "dark");
  assert.deepEqual(pressed(), ["false", "false", "true"]);
  assert.equal(note.textContent, "");
  buttons()[0].listeners.click[0]();
  assert.deepEqual(pressed(), ["true", "false", "false"]);
  const blocked = dashboard({
    local: {
      getItem: () => null,
      setItem: () => {
        throw new Error("bloqueado");
      },
    },
  });
  blocked.run("openSettings()");
  blocked.document.getElementById("settingsBody").children[3].children[1].children[1].listeners.click[0]();
  assert.equal(
    blocked.document.getElementById("settingsNote").textContent,
    "Este navegador no deja guardar el tema: vuelve al del sistema al recargar la página.",
  );
});

test("the update check disables its button, and says what it found or why it could not", async () => {
  const check = async (body, status = 200) => {
    let release;
    const page = dashboard({ answers: { "/api/update?fresh": () => new Promise((resolve) => (release = resolve)) } });
    page.run("openSettings()");
    const button = page.document.getElementById("settingsBody").children[4].children[1];
    button.listeners.click[0]();
    assert.equal(button.disabled, true);
    release(status === 0 ? Promise.reject(new Error("sin red")) : await answer(body, status)());
    await settle();
    assert.equal(button.disabled, false);
    return page.document.getElementById("settingsNote").textContent;
  };
  assert.equal(await check({ ...UP_TO_DATE, available: false }), "Tienes la última versión, la 1.1.0.");
  assert.equal(
    await check({ ...UP_TO_DATE, available: true, latest: "1.2.0", local: false, how: "uv" }),
    "Hay una versión nueva: el aviso de arriba dice cómo instalarla.",
  );
  assert.equal(await check({ ...UP_TO_DATE, error: "GitHub no responde" }), "GitHub no responde");
  assert.equal(await check({ error: "Sin internet" }, 502), "No se pudo buscar actualizaciones: Sin internet");
});

test("the icons are SVG paths with the same stroke, and the muted bell is crossed out", () => {
  const page = dashboard();
  const spaces = [];
  page.document.createElementNS = (space, tag) => {
    spaces.push(space);
    return element(tag);
  };
  const stroke = {
    viewBox: "0 0 24 24",
    width: "15",
    height: "15",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  };
  for (const [call, paths] of [
    ["bellIcon(false)", 2],
    ["bellIcon(true)", 3],
    ["gearIcon()", 2],
    ["qrIcon()", 12],
  ]) {
    const svg = built(page, call);
    assert.equal(svg.tagName, "SVG", call);
    assert.deepEqual({ ...svg.attrs }, stroke, call);
    assert.equal(svg.children.length, paths, call);
    for (const path of svg.children) {
      assert.equal(path.tagName, "PATH");
      assert.match(path.attrs.d, /^M[\d.]/, call);
    }
  }
  assert.equal(built(page, "bellIcon(true)").children[2].attrs.d, "M3 3l18 18");
  assert.equal(
    built(page, "gearIcon()").children[0].attrs.d,
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38" +
      "a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38" +
      "a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2" +
      "v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73" +
      "l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73" +
      "l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
  );
  assert.equal(spaces.length > 0 && spaces.every((space) => space === "http://www.w3.org/2000/svg"), true);
});

// An AudioContext that remembers every call, to compare the beep with its envelope.
function recordingAudio(state = "running") {
  const made = [];
  class AudioContext {
    constructor() {
      this.state = state;
      this.currentTime = 100;
      this.destination = { name: "speakers" };
      this.oscillators = [];
      this.gains = [];
      this.resumed = 0;
      made.push(this);
    }
    resume() {
      this.resumed++;
      this.state = "running";
      return Promise.resolve();
    }
    createOscillator() {
      const osc = {
        frequency: {},
        connect(to) {
          osc.to = to;
          return to;
        },
        start(when) {
          osc.started = when;
        },
        stop(when) {
          osc.stopped = when;
        },
      };
      this.oscillators.push(osc);
      return osc;
    }
    createGain() {
      const calls = [];
      const gain = {
        calls,
        gain: {
          setValueAtTime: (value, when) => calls.push(["set", value, when]),
          exponentialRampToValueAtTime: (value, when) => calls.push(["ramp", value, when]),
        },
        connect(to) {
          gain.to = to;
          return to;
        },
      };
      this.gains.push(gain);
      return gain;
    }
  }
  return { made, window: { AudioContext } };
}

const withAlarms = (options = {}) => {
  const audio = recordingAudio(options.audio);
  const page = dashboard({ ...options, globals: { window: audio.window, ...options.globals } });
  return Object.assign(page, { audio: audio.made[0] });
};
const beeps = (page) => page.audio.oscillators.length / 3;
const flashing = (page) => page.run("FlashTimer") !== null;
const lunchedAt = (when) => `store.state.lunch = ${JSON.stringify(when.toISOString())}`;

test("a beep is three sine tones at 880 Hz, each with its own envelope, to the speakers", () => {
  const page = withAlarms({ sessions: [session(at(TUESDAY, 1), null)] });
  page.run("checkAlarms()");
  const { oscillators, gains, destination } = page.audio;
  assert.equal(oscillators.length, 3);
  [0, 0.3, 0.6].forEach((offset, i) => {
    const [osc, gain] = [oscillators[i], gains[i]];
    assert.equal(osc.type, "sine");
    assert.equal(osc.frequency.value, 880);
    assert.deepEqual(gain.calls, [
      ["set", 0.0001, 100 + offset],
      ["ramp", 0.3, 100 + offset + 0.02],
      ["ramp", 0.0001, 100 + offset + 0.25],
    ]);
    assert.equal(osc.to, gain);
    assert.equal(gain.to, destination);
    assert.equal(osc.started, 100 + offset);
    assert.equal(osc.stopped, 100 + offset + 0.26);
  });
});

test("the title blinks with the alarm's words and stops when the alarm does", () => {
  const page = withAlarms({ sessions: [session(at(TUESDAY, 1), null)] });
  page.run("checkAlarms()");
  const [blink, ms] = page.calls.timers.at(-1);
  assert.equal(ms, 900);
  blink();
  assert.equal(page.document.title, "⏰ Jornada cumplida");
  blink();
  assert.equal(page.document.title, "Fichajes");
  blink();
  page.run("stopFlash()");
  assert.equal(page.document.title, "Fichajes");
  assert.equal(page.run("FlashTimer"), null);
  const rest = withAlarms({ sessions: [session(at(TUESDAY, 9, 40), null, true)] });
  rest.run("checkAlarms()");
  rest.calls.timers.at(-1)[0]();
  assert.equal(rest.document.title, "☕ Descanso terminado");
  const lunch = withAlarms({ sessions: [mondayDone] });
  lunch.run(lunchedAt(new Date(TUESDAY.getTime() - 40 * 60000)));
  lunch.run("checkAlarms()");
  lunch.calls.timers.at(-1)[0]();
  assert.equal(lunch.document.title, "🍽 Comida terminada");
});

test("stopping a flash that is not on leaves the title alone, and a flash on is cleared", () => {
  const cleared = [];
  const page = withAlarms({ globals: { clearInterval: (id) => cleared.push(id) } });
  page.document.title = "otra cosa";
  page.run("stopFlash()");
  assert.equal(page.document.title, "otra cosa");
  assert.deepEqual(cleared, []);
  page.run(`flashTitle("x")`);
  const id = page.run("FlashTimer");
  page.run("stopFlash()");
  assert.deepEqual(cleared, [id]);
  assert.equal(page.document.title, "Fichajes");
});

test("the first click or key unlocks a suspended audio, once", async () => {
  const page = withAlarms({ audio: "suspended" });
  page.run("store.notifyEl = document.createElement('div'); store.notifyArgs = [undefined, { expected: 8 }, 0]");
  page.document.listeners.pointerdown[0]();
  assert.equal(page.audio.resumed, 1);
  await settle();
  assert.equal(page.run("store.notifyEl.textContent"), "Sin fichaje abierto");
  page.document.listeners.keydown[0]();
  assert.equal(page.audio.resumed, 1);
  const refused = withAlarms({ audio: "suspended", globals: { window: fakeAudio(true).window } });
  refused.document.listeners.keydown[0]();
  await settle();
});

test("the status line refreshes only when there is a line and what to say", () => {
  const page = withAlarms();
  page.run("refreshNotifyNote()");
  page.run("store.notifyEl = document.createElement('div'); store.notifyEl.textContent = 'quieto'");
  page.run("refreshNotifyNote()");
  assert.equal(page.run("store.notifyEl.textContent"), "quieto");
  page.run("store.notifyEl = null; store.notifyArgs = [undefined, { expected: 8 }, 0]");
  page.run("refreshNotifyNote()");
  page.run("store.notifyEl = document.createElement('div'); store.notifyArgs = [undefined, { expected: 8 }, 0]");
  page.run("refreshNotifyNote()");
  assert.equal(page.run("store.notifyEl.textContent"), "Sin fichaje abierto");
});

test("the status line says what the next alarm is", () => {
  const page = withAlarms();
  const open = (extra = {}) => JSON.stringify({ in: iso(at(TUESDAY, 9, 45)), rest: false, ...extra });
  const status = (args) => page.run(`notifyStatus(${args})`);
  const worked = "{ expected: 8 }";
  page.run(`store.state.muted = true`);
  assert.equal(status(`undefined, ${worked}, 0`), "Silenciado hasta mañana");
  page.run(`store.state.muted = false`);
  assert.equal(status(`undefined, { expected: 0 }, 0`), "Hoy sin jornada prevista");
  assert.equal(status(`undefined, ${worked}, 0`), "Sin fichaje abierto");
  page.run(lunchedAt(new Date(TUESDAY.getTime() + 1 * 60000 - 30 * 60000)));
  assert.equal(status(`undefined, ${worked}, 0`), "Comida hasta las 10:01");
  page.run(lunchedAt(new Date(TUESDAY.getTime() - 30 * 60000)));
  assert.equal(status(`undefined, ${worked}, 0`), "Comida vencida a las 10:00");
  page.run(lunchedAt(new Date(TUESDAY.getTime() - 31 * 60000)));
  assert.equal(status(`undefined, ${worked}, 0`), "Comida vencida a las 09:59");
  page.run(`store.state.break_minutes = 0`);
  assert.equal(status(`${open({ rest: true })}, ${worked}, 3`), "En descanso · sin aviso configurado");
  page.run(`store.state.break_minutes = 15`);
  assert.equal(
    status(`${open({ rest: true, in: iso(at(TUESDAY, 9, 45)) })}, ${worked}, 3`),
    "Descanso vencido a las 10:00",
  );
  assert.equal(
    status(`${open({ rest: true, in: iso(at(TUESDAY, 9, 46)) })}, ${worked}, 3`),
    "Descanso hasta las 10:01",
  );
  assert.equal(
    status(`${open({ rest: true, in: iso(at(TUESDAY, 9, 44)) })}, ${worked}, 3`),
    "Descanso vencido a las 09:59",
  );
  assert.equal(status(`${open()}, ${worked}, 3`), "Sonará al cumplir la jornada");
  const every = "Avisando cada 2 min · siguiente ";
  assert.equal(status(`${open()}, ${worked}, 0`), `${every}en menos de 1 min`);
  page.run(`NotifiedAt = ${TUESDAY.getTime() - 60000}`);
  assert.equal(status(`${open()}, ${worked}, 0`), `${every}en 1 min`);
  page.run(`NotifiedAt = ${TUESDAY.getTime() - 59999}`);
  assert.equal(status(`${open()}, ${worked}, 0`), `${every}en 1 min`);
  page.run(`NotifiedAt = ${TUESDAY.getTime() - 60001}`);
  assert.equal(status(`${open()}, ${worked}, 0`), `${every}en menos de 1 min`);
  page.run(`NotifiedAt = ${TUESDAY.getTime() - 90000}`);
  assert.equal(status(`${open()}, ${worked}, 0`), `${every}en menos de 1 min`);
});

test("the status line asks to touch the page while the audio is held back", () => {
  const page = withAlarms({ audio: "suspended" });
  const status = (args) => page.run(`notifyStatus(${args})`);
  const worked = "{ expected: 8 }";
  const open = JSON.stringify({ in: iso(at(TUESDAY, 9)), rest: false });
  page.run(lunchedAt(new Date(TUESDAY.getTime() - 40 * 60000)));
  assert.equal(status(`undefined, ${worked}, 0`), "Comida vencida a las 09:50 · toca la página para oírlo");
  assert.equal(
    status(`${JSON.stringify({ in: iso(at(TUESDAY, 9)), rest: true })}, ${worked}, 0`),
    "Descanso vencido a las 09:15 · toca la página para oírlo",
  );
  assert.equal(status(`${open}, ${worked}, 3`), "Sonará al cumplir la jornada · toca la página para oírlo");
});

test("no beep sounds while the audio is held back, but the title still blinks", () => {
  const page = withAlarms({ audio: "suspended", sessions: [session(at(TUESDAY, 1), null)] });
  page.run("checkAlarms()");
  assert.equal(beeps(page), 0);
  assert.equal(flashing(page), true);
});

test("the end of day rings once its hours are met, then every two minutes while still punched in", () => {
  const page = withAlarms({ sessions: [session(at(TUESDAY, 9), null)] });
  page.run("store.expected = [8.5, 1.01, 0, 0, 0, 0, 0]");
  page.run("checkAlarms()");
  assert.equal(beeps(page), 0);
  assert.equal(flashing(page), false);
  page.run("store.expected = [8.5, 1, 0, 0, 0, 0, 0]");
  page.run("checkAlarms()");
  assert.equal(beeps(page), 1);
  assert.equal(flashing(page), true);
  page.run("checkAlarms()");
  assert.equal(beeps(page), 1);
  page.Clock.set(new Date(TUESDAY.getTime() + 119999));
  page.run("checkAlarms()");
  assert.equal(beeps(page), 1);
  page.Clock.set(new Date(TUESDAY.getTime() + 120000));
  page.run("checkAlarms()");
  assert.equal(beeps(page), 2);
});

test("the alarms recompute the day's hours at the moment they are checked", () => {
  const page = withAlarms({ sessions: [session(at(TUESDAY, 9), null)], now: at(TUESDAY, 9, 30) });
  page.run("store.expected = [8.5, 1, 0, 0, 0, 0, 0]");
  page.Clock.set(TUESDAY);
  page.run("checkAlarms()");
  assert.equal(beeps(page), 1);
});

test("a muted day, a day with no hours or no data rings nothing and stops a blinking title", () => {
  const sessions = [session(at(TUESDAY, 1), null)];
  const quiet = (setup) => {
    const page = withAlarms({ sessions });
    page.run(`flashTitle("x")`);
    page.run(setup);
    page.run("checkAlarms()");
    return [beeps(page), flashing(page)];
  };
  assert.deepEqual(quiet("store.state.muted = true"), [0, false]);
  assert.deepEqual(quiet("store.expected = [8.5, 0, 0, 0, 0, 0, 0]"), [0, false]);
  assert.deepEqual(quiet("store.data = null"), [0, true]);
});

test("a break rings when it has lasted as long as it should, not a minute before", () => {
  const page = withAlarms({ sessions: [session(at(TUESDAY, 9, 46), null, true)] });
  page.run("checkAlarms()");
  assert.equal(beeps(page), 0);
  assert.equal(flashing(page), false);
  const due = withAlarms({ sessions: [session(at(TUESDAY, 9, 45), null, true)] });
  due.run("checkAlarms()");
  assert.equal(beeps(due), 1);
  assert.equal(flashing(due), true);
  due.run("checkAlarms()");
  assert.equal(beeps(due), 1);
  const long = withAlarms({
    sessions: [session(at(TUESDAY, 9, 45), null, true)],
    now: new Date(TUESDAY.getTime() + 2 * HOUR),
  });
  long.run("checkAlarms()");
  assert.equal(beeps(long), 1);
  const over = withAlarms({
    sessions: [session(at(TUESDAY, 9, 45), null, true)],
    now: new Date(TUESDAY.getTime() + 2 * HOUR + 1),
  });
  over.run(`flashTitle("x")`);
  over.run("checkAlarms()");
  assert.equal(beeps(over), 0);
  assert.equal(flashing(over), false);
});

test("lunch rings after the minutes set, for two hours, and not before or after", () => {
  const lunch = (minutesAgo, setup = "") => {
    const page = withAlarms({ sessions: [mondayDone] });
    page.run(lunchedAt(new Date(TUESDAY.getTime() - (minutesAgo + 30) * 60000)));
    page.run(`flashTitle("x"); ${setup}`);
    page.run("checkAlarms()");
    return [beeps(page), flashing(page)];
  };
  assert.deepEqual(lunch(-1), [0, false]);
  assert.deepEqual(lunch(0), [1, true]);
  assert.deepEqual(lunch(60), [1, true]);
  assert.deepEqual(lunch(120), [1, true]);
  assert.deepEqual(lunch(121), [0, false]);
  assert.deepEqual(lunch(0, `LastRing.lunch = ${TUESDAY.getTime() - 119999}`), [0, true]);
  assert.deepEqual(lunch(0, `LastRing.lunch = ${TUESDAY.getTime() - 120000}`), [1, true]);
  const none = withAlarms({ sessions: [mondayDone] });
  none.run("checkAlarms()");
  assert.equal(beeps(none), 0);
});

test("resetting the alarms lets the next one ring at once", () => {
  const page = withAlarms({ sessions: [session(at(TUESDAY, 1), null)] });
  page.run("checkAlarms()");
  page.run("checkAlarms()");
  assert.equal(beeps(page), 1);
  page.run("resetAlarms()");
  page.run("checkAlarms()");
  assert.equal(beeps(page), 2);
  assert.deepEqual(page.run("LastRing"), { lunch: 0, rest: 0 });
});

test("the alarms are checked every thirty seconds", () => {
  const page = withAlarms();
  assert.equal(
    page.calls.timers.some(([, ms]) => ms === 30000),
    true,
  );
});

const now = (page) => page.Clock.now();
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

test("polling the shared state ignores a page of someone else's and a refused answer", async () => {
  const refused = dashboard({
    answers: { "/api/state": async () => ({ ok: false, status: 500, json: async () => ({ punched_at: "x" }) }) },
  });
  await refused.run("refreshState()");
  assert.equal(refused.sent.filter((r) => r.url === "/api/state").length, 1);
  assert.equal(refused.sent.filter((r) => r.url === "/api/data").length, 1);
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
  assert.equal(punched.sent.filter((r) => r.url === "/api/data").length, 2);
  assert.equal(punched.run("window.kept === store.state"), false);
});

test("a load asks for the personal week, the fresh data or someone else's, and nothing more", async () => {
  const page = dashboard();
  const urls = () => page.sent.filter((r) => r.url.startsWith("/api/data")).map((r) => r.url);
  await page.run("loadAndRender()");
  await page.run("loadAndRender(true)");
  page.run(`store.other = "7"`);
  await page.run("loadAndRender()");
  await page.run("loadAndRender(true)");
  assert.deepEqual(urls(), [
    "/api/data",
    "/api/data",
    "/api/data?fresh",
    "/api/data?employee=7",
    "/api/data?employee=7&fresh",
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
  const page = dashboard({ answers: { "/api/data": () => Promise.reject(new Error("Odoo caído")) } });
  page.run("loadFirst()");
  await settle();
  assert.equal(page.document.getElementById("loadmsg").textContent, "Error cargando datos de Odoo: Odoo caído");
});

const SEPTEMBER = (day, from = 9, to = 17) => session(at(new Date(2026, 8, day), from), at(new Date(2026, 8, day), to));

test("a day is long only past the payload's limit, and a day with a session left open is in error", () => {
  const page = dashboard();
  const longDay = (hours) => page.run(`longDay({ hours: ${hours} })`);
  assert.deepEqual([longDay(11.99), longDay(12), longDay(12.01)], [false, false, true]);
  const yesterday = new Date(2026, 8, 14, 9).getTime();
  const open = `{ in: new Date(${yesterday}), out: null }`;
  const closed = `{ in: new Date(${yesterday}), out: new Date(${yesterday}) }`;
  const error = (hours, sessions) => page.run(`dayError({ hours: ${hours}, sessions: [${sessions}] })`);
  assert.equal(error(1, `${open}, ${closed}`), true);
  assert.equal(error(1, closed), false);
  assert.equal(error(13, closed), true);
});

test("a day is missed when it is past, expected hours and has no session", () => {
  const page = dashboard();
  const missed = (date, expected, sessions) =>
    page.run(`missed({ date: new Date(${date.getTime()}), expected: ${expected}, sessions: ${sessions} })`);
  const yesterday = new Date(2026, 8, 14);
  assert.deepEqual(
    [missed(yesterday, 8, "[]"), missed(MIDNIGHT, 8, "[]"), missed(yesterday, 0, "[]"), missed(yesterday, 8, "[{}]")],
    [true, false, false, false],
  );
});

test("the punches to fix are the open ones from before today, long days and missed ones, newest first", () => {
  const sessions = [
    SEPTEMBER(7, 9, 17),
    SEPTEMBER(9, 6, 20),
    session(new Date(2026, 8, 14, 22), null),
    session(MIDNIGHT, null),
  ];
  const page = dashboard({ sessions, extra: { since: "2026-09-07" } });
  page.run(`store.since = "2026-09-07"`);
  const errors = page.run("punchErrors()").map((e) => `${e.kind} ${e.in.slice(0, 10)}`);
  assert.deepEqual(
    page.run("punchErrors()").map((e) => e.kind),
    ["open", "empty", "empty", "long", "empty"],
  );
  assert.deepEqual(errors.length, 5);
  assert.equal(page.run("punchErrors()")[3].hours, 14);
  assert.equal(page.run("punchErrors()")[3].count, 1);
  assert.equal(page.run("punchErrors()")[1].expected, 6);
  const dates = page.run("punchErrors().map((e) => new Date(e.in).getTime())");
  assert.deepEqual(
    [...dates].sort((a, b) => b - a),
    dates,
  );
});

test("a day that holds an open session today is not a long day to fix", () => {
  const page = dashboard({
    sessions: [session(at(TUESDAY, 0), at(TUESDAY, 7)), session(at(TUESDAY, 7), null)],
    extra: { long_hours: 5, since: "2026-09-15" },
  });
  page.run(`store.since = "2026-09-15"`);
  assert.deepEqual(page.run("punchErrors()"), []);
});

test("a week offset counts Monday-to-Sunday weeks back, whatever day of the week the date is", () => {
  const page = dashboard();
  const offset = (date) => page.run(`weekOffsetOf(new Date(${date.getTime()}))`);
  assert.deepEqual(
    [
      new Date(2026, 8, 15),
      new Date(2026, 8, 14),
      new Date(2026, 8, 20),
      new Date(2026, 8, 13),
      new Date(2026, 8, 7),
      new Date(2026, 8, 6),
    ].map(offset),
    [0, 0, 0, 1, 1, 2],
  );
});

test("a whole-day absence has no leaves, even when a leave is listed for the same date", () => {
  const page = dashboard();
  page.run(
    `store.absMap = new Map([["2026-09-15", "Festivo"]]); store.leaveMap = new Map([["2026-09-15", [{ hours: 1, type: "Médico" }]]])`,
  );
  const today = page.run("buildWeek(0).days[1]");
  assert.deepEqual(today.leaves, []);
  assert.equal(today.expected, 0);
  assert.equal(today.vacation, true);
  assert.deepEqual(page.run("buildWeek(0).days[2].leaves"), []);
});

test("a week is the current one from Monday to Sunday only, and complete only after its Sunday", () => {
  const flags = (now) => {
    const page = dashboard({ now });
    return ["buildWeek(0)", "buildWeek(1)", "buildWeek(-1)"].map((week) =>
      page.run(`[${week}.current, ${week}.complete]`),
    );
  };
  assert.deepEqual(flags(TUESDAY), [
    [true, false],
    [false, true],
    [false, false],
  ]);
  assert.deepEqual(flags(MONDAY), [
    [true, false],
    [false, true],
    [false, false],
  ]);
  assert.deepEqual(flags(SUNDAY), [
    [true, false],
    [false, true],
    [false, false],
  ]);
});

test("a week is in error for a long day, a missed day or an open one, each by itself", () => {
  const week = (sessions) => {
    const page = dashboard({ sessions: [SEPTEMBER(14), ...sessions] });
    return page.run("[buildWeek(1).error, buildWeek(1).suspect, buildWeek(1).missedDays, buildWeek(1).openDays]");
  };
  const all = [7, 8, 9, 10, 11].map((d) => SEPTEMBER(d));
  assert.deepEqual(week(all), [false, false, 0, 0]);
  assert.deepEqual(week([...all.slice(0, 2), SEPTEMBER(9, 5, 20), ...all.slice(3)]), [true, true, 0, 0]);
  assert.deepEqual(week(all.slice(1)), [true, false, 1, 0]);
  assert.deepEqual(week([...all.slice(0, 4), session(new Date(2026, 8, 11, 9), null)]), [true, false, 0, 1]);
});

test("the page starts with its constants and an empty shared state", () => {
  const page = load({ fetchImpl: () => new Promise(() => {}) });
  assert.deepEqual(page.run("LOOPBACK"), ["localhost", "127.0.0.1", "[::1]", "::1"]);
  assert.deepEqual(page.run("DayNames"), ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]);
  assert.deepEqual(page.run("DayFull"), ["lunes", "martes", "miércoles", "jueves", "viernes", "sábados", "domingos"]);
  assert.deepEqual(page.run("NoSchedule"), {
    hours: [0, 0, 0, 0, 0, 0, 0],
    lunch_from: [null, null, null, null, null, null, null],
  });
  assert.deepEqual(page.run("store.state"), {
    lunch: null,
    lunch_minutes: 30,
    break_minutes: 15,
    lunch_button_from: 810,
    lunch_button_to: 960,
    muted: false,
    lunch_done: false,
    punched_at: null,
  });
});

test("the schedule is told with the day names of the days that have hours", () => {
  const page = dashboard();
  page.run("store.expected = [0, 0, 8, 0, 0, 4, 4]");
  assert.equal(page.run("scheduleSentence()"), "8h los miércoles, 4h los sábados y domingos");
  page.run("store.expected = [8, 8, 8, 8, 8, 0, 0]");
  assert.equal(page.run("scheduleSentence()"), "8h de lunes a viernes");
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

test("the colour theme is read from storage on load, and a choice says whether it was kept", () => {
  const stored = load({ local: memoryStorage({ theme: "dark" }) });
  assert.equal(stored.document.documentElement.dataset.theme, "dark");
  const none = load();
  assert.strictEqual(none.document.documentElement.dataset.theme, "");
  assert.strictEqual(none.run("window.chooseTheme('light')"), true);
  assert.equal(none.document.documentElement.dataset.theme, "light");
  const blocked = load({
    local: {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    },
  });
  assert.equal(blocked.document.documentElement.dataset.theme, undefined);
  assert.deepEqual(blocked.calls.warnings, ["[odoo] reading the theme failed: Error: bloqueado"]);
  assert.strictEqual(blocked.run("window.chooseTheme('dark')"), false);
  assert.equal(blocked.document.documentElement.dataset.theme, "dark");
});

test("clock times pad their minutes and the hour of a date counts its seconds", () => {
  const page = load();
  assert.equal(page.run("fmtClock(8.05)"), "8:03");
  assert.equal(page.run("fmtClock(17.5)"), "17:30");
  assert.equal(page.run("hourOf(new Date(2026, 0, 1, 10, 30, 36))"), 10 + 0.5 + 0.01);
});

// The login page with its fields as login.html has them: the URL, the database and the code start hidden.
async function loginPage({ config = { local: true, configured: true, user: "" }, login = answer({}) } = {}) {
  const fields = {};
  const focused = [];
  const field = (id) => {
    if (!fields[id]) {
      fields[id] = element("div");
      fields[id].hidden = ["url", "db", "code"].includes(id);
      fields[id].focus = () => focused.push(id);
    }
    return fields[id];
  };
  const sent = [];
  const Clock = clockAt(new Date(2026, 8, 15, 9, 5));
  const page = load({
    entry: "login.js",
    globals: { Date: Clock, document: { getElementById: field, documentElement: element("html") } },
    fetchImpl: async (url, opts) => {
      sent.push({
        url,
        method: opts?.method,
        headers: opts?.headers && { ...opts.headers },
        body: opts?.body && JSON.parse(opts.body),
      });
      return url === "/api/config" ? answer(config)() : login(url, opts);
    },
  });
  await settle();
  return { ...page, field, fields, focused, sent };
}

test("the login page shows the time and puts the cursor where the next thing to type is", async () => {
  const configured = await loginPage({ config: { local: true, configured: true, user: "" } });
  assert.equal(configured.field("clock").textContent, "09:05");
  assert.equal(configured.calls.timers[0][1], 10000);
  assert.equal(configured.field("user").value, "");
  assert.deepEqual(configured.focused, ["user"]);
  assert.equal(configured.field("url").hidden, true);
  assert.equal(configured.field("db").hidden, true);
  assert.notEqual(configured.field("url").required, true);
  const known = await loginPage({ config: { local: true, configured: true, user: "ana" } });
  assert.equal(known.field("user").value, "ana");
  assert.deepEqual(known.focused, ["pass"]);
  const fresh = await loginPage({ config: { local: true, configured: false } });
  assert.deepEqual([fresh.field("url").hidden, fresh.field("db").hidden], [false, false]);
  assert.deepEqual([fresh.field("url").required, fresh.field("db").required], [true, true]);
  assert.equal(fresh.field("code").hidden, true);
  assert.deepEqual(fresh.focused, ["url"]);
});

test("off the machine itself the login page only says how to pair the phone", async () => {
  const page = await loginPage({ config: { local: false, configured: true, user: "ana" } });
  assert.equal(
    page.field("hint").textContent,
    "Aquí no se inicia sesión. En el ordenador, abre http://localhost:8931/ y pulsa «Emparejar móvil»: escanea el código que aparece y entrarás sin contraseña.",
  );
  assert.deepEqual(
    ["user", "secret", "submit"].map((id) => page.field(id).hidden),
    [true, true, true],
  );
  assert.deepEqual(page.focused, []);
});

test("the eye shows and hides the password", async () => {
  const page = await loginPage();
  page.field("pass").type = "password";
  page.field("eye-slash").classList.add("hidden");
  page.focused.length = 0;
  page.field("eye").listeners.click[0]();
  assert.equal(page.field("pass").type, "text");
  assert.equal(page.field("eye-slash").classList.contains("hidden"), false);
  assert.deepEqual(page.field("eye").attrs, { "aria-pressed": "true", "aria-label": "Ocultar contraseña" });
  assert.deepEqual(page.focused, ["pass"]);
  page.field("eye").listeners.click[0]();
  assert.equal(page.field("pass").type, "password");
  assert.equal(page.field("eye-slash").classList.contains("hidden"), true);
  assert.deepEqual(page.field("eye").attrs, { "aria-pressed": "false", "aria-label": "Mostrar contraseña" });
});

const submit = async (page, values = {}) => {
  for (const [id, value] of Object.entries({ url: "u", db: "d", user: "ana", pass: "p", code: "123456", ...values })) {
    page.field(id).value = value;
  }
  let prevented = 0;
  const done = page.field("login").listeners.submit[0]({ preventDefault: () => prevented++ });
  return { done, prevented };
};

test("signing in posts every field and goes to the dashboard", async () => {
  const page = await loginPage({ login: answer({ ok: true }) });
  page.field("err").textContent = "viejo";
  const { done, prevented } = await submit(page);
  assert.equal(prevented, 1);
  assert.equal(page.field("err").textContent, "");
  assert.equal(page.field("submit").disabled, true);
  await done;
  assert.deepEqual(page.sent.at(-1), {
    url: "/api/login",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { url: "u", db: "d", user: "ana", password: "p", code: "123456" },
  });
  assert.deepEqual(page.calls.replace, ["/"]);
  assert.equal(page.field("submit").disabled, true);
});

test("a refused sign-in says why and gives the button back, with or without a message", async () => {
  const refused = await loginPage({ login: answer({ error: "Credenciales erróneas" }, 401) });
  await (await submit(refused)).done;
  assert.equal(refused.field("err").textContent, "Credenciales erróneas");
  assert.equal(refused.field("submit").disabled, false);
  const silent = await loginPage({ login: answer({}, 500) });
  await (await submit(silent)).done;
  assert.equal(silent.field("err").textContent, "HTTP 500");
  const broken = await loginPage({ login: () => Promise.reject(new Error("sin red")) });
  await (await submit(broken)).done;
  assert.equal(broken.field("err").textContent, "sin red");
  assert.equal(broken.field("submit").disabled, false);
  assert.deepEqual(broken.calls.replace, []);
});

test("when Odoo wants a two-factor code the page asks for it and waits", async () => {
  const page = await loginPage({ login: answer({ totp: true }, 401) });
  page.focused.length = 0;
  await (await submit(page)).done;
  assert.equal(
    page.field("hint").textContent,
    "Introduce el código de tu aplicación de verificación. Este navegador quedará como dispositivo de confianza 90 días.",
  );
  assert.equal(page.field("code").hidden, false);
  assert.equal(page.field("code").required, true);
  assert.equal(page.field("submit").disabled, false);
  assert.deepEqual(page.focused, ["code"]);
  assert.equal(page.field("err").textContent, "");
});

test("the page shows someone else's week only at /empleado with an id", () => {
  const other = (path) => load({ path, fetchImpl: () => new Promise(() => {}) }).run("store.other");
  assert.deepEqual([other("/"), other("/?id=5"), other("/empleado?id=5"), other("/empleado")], [null, null, "5", null]);
});

const later = (page, ms) => page.Clock.set(new Date(page.Clock.now() + ms));
const freshData = (page) => page.run(`store.loadedAt = ${page.Clock.now()}; store.triedAt = ${page.Clock.now()}`);
const dataLoads = (page) => page.sent.filter((r) => r.url.startsWith("/api/data")).length;
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
  const failing = dashboard({ answers: { "/api/data": () => Promise.reject(new Error("sin red")) } });
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
  empty.run("store.data = null");
  later(empty, 61000);
  empty.document.listeners.visibilitychange[0]();
  assert.equal(dataLoads(empty), 1);

  const failing = dashboard({ answers: { "/api/data": () => Promise.reject(new Error("sin red")) } });
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
    page.run("store.data = null");
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
  const failing = dashboard({ answers: { "/api/data": () => Promise.reject(new Error("sin red")) } });
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

const click = (page, id, target) => {
  const event = { target, currentTarget: page.document.getElementById(id) };
  page.document.getElementById(id).listeners.click[0](event);
  return event;
};
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
  const page = dashboard({ answers: { "/api/data?fresh": () => new Promise((resolve) => (release = resolve)) } });
  const button = page.document.getElementById("refreshBtn");
  const pending = button.listeners.click[0]({ target: button });
  assert.equal(button.disabled, true);
  release(await answer(page.data)());
  await pending;
  assert.equal(button.disabled, false);
  assert.equal(page.sent.at(-1).url, "/api/data?fresh");
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
  assert.equal(page.sent.at(-1).url, "/api/data?fresh");
  const request = page.document.getElementById("requestBtn");
  await request.listeners.click[0]();
  await settle();
  assert.deepEqual(opened, [["", "_blank"]]);
  assert.equal(page.sent.at(-1).url, "/api/request");
  assert.equal(tab.location, "https://odoo.example/solicitud");
});

test("an alarm sets the stamp of its own kind and the blinking title starts only once", () => {
  const rest = withAlarms({ sessions: [session(at(TUESDAY, 9, 40), null, true)] });
  rest.run("checkAlarms()");
  assert.deepEqual(rest.run("[LastRing.lunch, LastRing.rest]"), [0, TUESDAY.getTime()]);
  const lunch = withAlarms({ sessions: [mondayDone] });
  lunch.run(lunchedAt(new Date(TUESDAY.getTime() - 40 * 60000)));
  lunch.run("checkAlarms()");
  assert.deepEqual(lunch.run("[LastRing.lunch, LastRing.rest]"), [TUESDAY.getTime(), 0]);
  lunch.run(`flashTitle("otra")`);
  assert.equal(lunch.calls.timers.filter(([, ms]) => ms === 900).length, 1);
});

test("a view of someone else's week has no punch buttons, and a page without breaks no break button", () => {
  const other = dashboard({ sessions: [session(at(TUESDAY, 9), null)] });
  other.run(`store.other = "7"`);
  assert.deepEqual(
    heroOf(other).children.map((c) => c.className),
    ["main", "meter-box"],
  );
  const plain = dashboard({ sessions: [session(at(TUESDAY, 9), null)], extra: { breaks: false } });
  assert.deepEqual(
    heroOf(plain)
      .querySelectorAll(".btn")
      .map((b) => b.textContent),
    ["Fichar salida"],
  );
});

test("a day with no hours expected does not pulse the check-out button", () => {
  const page = dashboard({
    sessions: [session(at(TUESDAY, 9), null)],
    schedule: "store.expected = [0, 0, 0, 0, 0, 0, 0]; store.weekTarget = 0;",
  });
  assert.equal(buttonOf(page, "Fichar salida").className, "btn primary");
});

test("pairing by IP asks for the address and not the name", async () => {
  const page = dashboard({ extra: { phone: PHONE } });
  phoneOf(page).children[0].children[1].children[1].listeners.click[0]();
  page.document
    .getElementById("phone")
    .children[0].children.find((c) => c.textContent === "Emparejar móvil")
    .listeners.click[0]();
  await settle();
  assert.deepEqual(page.sent.filter((r) => r.url === "/api/pair").at(-1).body, { name: false });
});

test("a failed poll of the shared state is logged and the page carries on", async () => {
  const page = dashboard({ answers: { "/api/state": () => Promise.reject(new Error("sin red")) } });
  await page.run("refreshState()");
  assert.deepEqual(page.calls.warnings, ["[odoo] the shared state poll failed: Error: sin red"]);
});
