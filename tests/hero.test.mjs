// hero.js: the hero of the personal page (the pending hours, the meters, the last punch, the buttons) and the phone
// block. Each test asserts what is drawn (tags, classes, attributes, text) and every edge of a comparison, on a
// clock the test sets (clockAt in page.mjs).

import assert from "node:assert/strict";
import test from "node:test";
import {
  answer,
  at,
  built,
  dashboard,
  day,
  dump,
  HOUR,
  heroOf,
  iso,
  load,
  MIDNIGHT,
  mondayDone,
  payload,
  RealDate,
  SCHEDULE,
  session,
  settle,
  TUESDAY,
  withData,
} from "./page.mjs";

test("last punch is the latest event, the check-out of a closed session and not the check-in at the same instant", () => {
  const nine = at(TUESDAY, 9);
  const noon = at(TUESDAY, 12);
  const page = dashboard({
    sessions: [session(noon, at(TUESDAY, 13), true), session(nine, noon)],
  });
  assert.deepEqual(page.run("lastPunch()"), { at: iso(at(TUESDAY, 13)), out: true, rest: true });
  page.run(
    `store.personal.sessions = [${JSON.stringify(session(nine, noon))}, ${JSON.stringify(session(noon, null, true))}]`,
  );
  assert.deepEqual(page.run("lastPunch()"), { at: iso(noon), out: true, rest: false });
  page.run(`store.personal.sessions = [${JSON.stringify(session(nine, null))}]`);
  assert.deepEqual(page.run("lastPunch()"), { at: iso(nine), open: true, rest: false });
  page.run("store.personal.sessions = []");
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

test("the last punch is the newest event and says whether it is open", () => {
  const { run } = withData([session(at(TUESDAY, 9), at(TUESDAY, 12)), session(at(TUESDAY, 13), null, true)]);
  const last = run("lastPunch()");
  assert.equal(last.open, true);
  assert.equal(last.rest, true);
  assert.equal(new Date(last.at).getTime(), at(TUESDAY, 13).getTime());
  assert.match(run("punchText(lastPunch())"), /^En descanso desde las 13:00 · llevas /);
});

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

test("the hero offers lunch inside its window until it is taken", async () => {
  const two = new Date(2026, 8, 15, 14, 0);
  class AtTwo extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(two);
    }
    static now() {
      return two.getTime();
    }
  }
  const schedule = { hours: [8, 8, 8, 8, 8, 0, 0], lunch_from: [14, 14, 14, 14, null, null, null] };
  const page = load({ data: payload([session(at(two, 9), null)], { schedule }), globals: { Date: AtTwo } });
  await page.run("loadAndRender()");
  const buttons = () =>
    page.document
      .getElementById("hero")
      .querySelectorAll(".btn")
      .map((b) => b.textContent);
  assert.deepEqual(buttons(), ["Fichar salida", "Salir a comer", "Salir a descanso"]);
  page.run("store.state.lunch_done = true; renderHero()");
  assert.deepEqual(buttons(), ["Fichar salida", "Salir a descanso"]);
});

test("pairing shows a one-shot QR that expires", async () => {
  const data = payload([], { phone: { url: "https://10.0.0.2:8443/", name_url: "https://mac.local:8443/" } });
  const pairs = [];
  let pairReply = {
    ok: true,
    status: 200,
    json: async () => ({ url: "https://10.0.0.2:8443/pair?t=tok", qr: "<svg/>", expires_in: 120 }),
  };
  const page = load({
    fetchImpl: async (url, opts) => {
      if (url !== "/api/pair") return { ok: true, status: 200, json: async () => data };
      pairs.push(JSON.parse(opts.body));
      return pairReply;
    },
  });
  await page.run("loadAndRender()");
  const { document, run, calls } = page;
  const phone = document.getElementById("phone");
  const pairButton = () => phone.querySelector(".btn");
  await pairButton().listeners.click[0]();
  assert.deepEqual(pairs, [{ name: true }]);
  assert.equal(phone.querySelectorAll(".qr").length, 1);
  assert.equal(phone.querySelector(".url").textContent, "https://10.0.0.2:8443/pair?t=tok");
  assert.match(phone.querySelector(".note").textContent, /caduca en 120 s/);
  assert.equal(pairButton().textContent, "Cancelar");
  assert.equal(calls.timers.at(-1)[1], 1000);
  run("pairing.until = Date.now() - 1");
  calls.timers.at(-1)[0]();
  assert.equal(run("pairing"), null);
  assert.equal(phone.querySelectorAll(".qr").length, 0);
  assert.equal(pairButton().textContent, "Emparejar móvil");
  await pairButton().listeners.click[0]();
  assert.equal(pairButton().textContent, "Cancelar");
  pairReply = { ok: false, status: 500, json: async () => ({ error: "caído" }) };
  await pairButton().listeners.click[0]();
  await settle();
  assert.equal(pairButton().textContent, "Emparejar móvil");
  assert.equal(phone.querySelectorAll(".qr").length, 0);
  assert.deepEqual(pairs.at(-1), { revoke: true });
  phone.querySelector(".seg").children[1].listeners.click[0]();
  pairReply = { ok: false, status: 409, json: async () => ({ error: "sin --host" }) };
  await pairButton().listeners.click[0]();
  assert.deepEqual(pairs.at(-1), { name: false });
  assert.match(phone.querySelector(".note").textContent, /No se pudo emparejar: sin --host/);
});

test("without the Descanso reason the page offers no break", async () => {
  const today = new Date();
  const schedule = { hours: [7, 7, 7, 7, 7, 7, 7], lunch_from: [13, 13, 13, 13, 13, 13, 13] };
  const texts = async (breaks) => {
    const page = load({ data: payload([session(at(today, 9), null)], { schedule, breaks }) });
    await page.run("loadAndRender()");
    const hero = page.document.getElementById("hero");
    return hero.querySelectorAll(".btn").map((b) => b.textContent);
  };
  const withBreaks = await texts(true),
    without = await texts(false);
  assert.deepEqual(
    withBreaks.filter((t) => t.includes("escanso")),
    ["Salir a descanso"],
  );
  assert.deepEqual(
    without.filter((t) => t.includes("escanso")),
    [],
  );
  assert.ok(without.includes("Fichar salida"));
});

test("an attendance left open since an earlier day is not today's work", async () => {
  const today = new Date();
  const earlier = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 3, 8, 46);
  const page = load({
    data: payload([{ in: earlier.toISOString(), out: null, hours: null, rest: false, reason: "Normal" }], {
      long_hours: 12,
      schedule: { hours: [8, 8, 8, 8, 8, 8, 8], lunch_from: [null, null, null, null, null, null, null] },
    }),
  });
  await page.run("loadAndRender()");
  const hero = page.document.getElementById("hero");
  const texts = (node) => [
    node.textContent,
    ...(node.children || []).filter((c) => typeof c !== "string").flatMap(texts),
  ];
  assert.ok(!texts(hero).some((t) => /^Salida estimada/.test(t)));
  assert.ok(texts(hero).some((t) => / · hay una entrada anterior sin cerrar$/.test(t)));
  const line = hero.querySelectorAll(".lastpunch")[0];
  assert.equal(line.classList.contains("stale"), true);
  assert.match(line.children[1].textContent, /^Entrada del \d+ \w+ a las 08:46 sin cerrar · hace /);
  page.run("renderTable(buildWeeks(2))");
  const table = page.document.getElementById("tableView");
  assert.ok(table.querySelectorAll("td.warn").some((td) => td.textContent === "fichaje por revisar"));
});

test("a week holding a too long session never claims its target reached", async () => {
  const today = new Date();
  const page = load({
    data: payload([session(at(today, 0), at(today, 12, 30))], {
      long_hours: 12,
      schedule: { hours: [1, 1, 1, 1, 1, 1, 1], lunch_from: [null, null, null, null, null, null, null] },
    }),
  });
  await page.run("loadAndRender()");
  const texts = (node) => [
    node.textContent,
    ...(node.children || []).filter((c) => typeof c !== "string").flatMap(texts),
  ];
  assert.ok(texts(page.document.getElementById("hero")).some((t) => /hay un fichaje por revisar$/.test(t)));
  assert.ok(!texts(page.document.getElementById("hero")).some((t) => /objetivo alcanzado$/.test(t)));
  const badge = page.document.getElementById("weekCal").querySelectorAll(".badge")[0];
  assert.equal(badge.textContent, "⚠ en curso · fichaje por revisar");
  assert.equal(badge.classList.contains("warn"), true);
  const cal = page.document.getElementById("weekCal");
  assert.equal(cal.querySelectorAll(".total")[0].classList.contains("long"), true);
  assert.equal(cal.querySelectorAll(".total-warn")[0].textContent, "⚠ incluye una jornada muy larga");
  cal.querySelectorAll(".seg")[0].children[1].listeners.click[0]();
  assert.equal(cal.querySelectorAll(".bar")[0].classList.contains("long"), true);
});

test("the hero is three blocks", async () => {
  const today = new Date();
  const page = load({
    data: payload([session(at(today, 9), null)], {
      schedule: { hours: [8, 8, 8, 8, 8, 0, 0], lunch_from: [13, 13, 13, 13, 13, null, null] },
    }),
  });
  await page.run("loadAndRender()");
  const hero = page.document.getElementById("hero");
  assert.deepEqual(
    hero.children.map((c) => c.className),
    ["main", "meter-box", "actions"],
  );
  assert.equal(hero.querySelectorAll(".meter-caption").length, 2);
});

test("without phone access the block says why and how to fix it instead of offering to pair", async () => {
  const page = load({ data: payload([], { phone: { off: "Falta openssl. Instálalo." } }) });
  await page.run("loadAndRender()");
  const phone = page.document.getElementById("phone");
  assert.equal(phone.classList.contains("hidden"), false);
  const [title, what, why] = phone.children[0].children.map((c) => c.textContent);
  assert.equal(title, "Abrir en el móvil");
  assert.match(what, /^Este panel también se puede usar desde el móvil.*Ahora no está disponible\.$/);
  assert.equal(why, "Falta openssl. Instálalo.");
  assert.equal(phone.querySelectorAll(".btn").length, 0);
});

test("the week's meter has one section per day that expects hours, as wide as those hours", async () => {
  const today = new Date();
  const page = load({
    data: payload([session(at(today, 9), null)], {
      schedule: { hours: [8.5, 8.5, 8.5, 8.5, 6, 0, 0], lunch_from: [14, 14, 14, 14, null, null, null] },
    }),
  });
  await page.run("loadAndRender()");
  const sections = page.document.getElementById("hero").querySelectorAll(".scale")[0].children;
  assert.deepEqual(
    sections.map((s) => s.style["--hours"]),
    ["8.5", "8.5", "8.5", "8.5", "6"],
  );
});

test("a gap counts only the unlogged time no leave covers", () => {
  const { run } = load();
  const monday = new Date(2026, 8, 14);
  const gap = (leaves) =>
    run(`unloggedGap([
    { in: new Date(${at(monday, 9).getTime()}), out: new Date(${at(monday, 12).getTime()}) },
    { in: new Date(${at(monday, 12, 30).getTime()}), out: null },
  ], ${JSON.stringify(leaves)})`);
  const leave = (h1, m1, h2, m2) => ({ from: at(monday, h1, m1).toISOString(), to: at(monday, h2, m2).toISOString() });
  assert.equal(gap([]), 0.5);
  assert.equal(gap([leave(11, 0, 12, 15)]), 0.25);
  assert.equal(gap([leave(12, 0, 12, 30)]), 0);
  assert.equal(gap([leave(15, 0, 16, 0)]), 0.5);
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
