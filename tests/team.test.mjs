// The management view's suites (team.js, teamfixes.js, teamstate.js): what each cell, tooltip, chart and card
// draws, with the classes and tags the stylesheet reads, and the history, storage and keys that move between
// periods. The clock is page.mjs's: today is TUESDAY 2026-09-15, which the payloads below are built around.

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  cellText,
  hover,
  IMPORT_RE,
  isoDate,
  load,
  readModule,
  rowName,
  settle,
  teamFixes,
  teamPayload,
  UP_TO_DATE,
  Y25,
} from "./page.mjs";

const LIMITS = { long_day: 12, under_margin: 1 / 60, over_margin: 5 };
const TODAY = "2026-09-15";

const reply = (json, ok = true, status = 200) => ({ ok, status, json: async () => json });
const shift = (iso, days) => {
  const [y, m, d] = iso.split("-").map(Number);
  return isoDate(new Date(y, m - 1, d + days));
};
const range = (first, n = 7) => Array.from({ length: n }, (_, i) => shift(first, i));
const stamp = (iso, hour, minute = 0) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, hour, minute).toISOString();
};
const punch = (date, from, to) => ({
  in: stamp(date, from),
  out: to == null ? null : stamp(date, to),
  hours: to == null ? null : to - from,
  rest: false,
});
const day = (date, extra) => ({
  date,
  hours: 0,
  target: 8,
  absence: null,
  sessions: [],
  flags: [],
  requests: [],
  ...extra,
});
const week = (monday, extra) => ({
  monday,
  hours: 40,
  target: 40,
  balance: 0,
  due: 40,
  flags: [],
  suspect: false,
  ...extra,
});
const staff = (extra) => ({
  id: 1,
  name: "Ana",
  discord: null,
  hours: 40,
  target: 40,
  balance: 0,
  due: 40,
  flags: [],
  flagged_days: 0,
  pending: 0,
  suspect: false,
  ...extra,
});
const period = (first, employees, extra) => ({
  week: first,
  start: first,
  stop: shift(first, 7),
  generated_at: new Date(2026, 8, 15, 9, 5).toISOString(),
  limits: LIMITS,
  reasons: [],
  can_edit: false,
  can_message: false,
  employees,
  ...extra,
});

function site({ data, fixes = teamFixes(), path = "/gestion#f=all", ...rest }) {
  const urls = [];
  const fetchImpl = async (url) => {
    if (url === "/api/update") return reply(UP_TO_DATE);
    urls.push(url);
    if (url.includes("fixes")) return typeof fixes === "function" ? fixes(url) : reply(fixes);
    return typeof data === "function" ? data(url) : reply(data);
  };
  const page = load({ entry: "team.js", fetchImpl, path, ...rest });
  return { page, urls, doc: page.document };
}

const segment = (page, id, attr, keys) => {
  const seg = page.document.getElementById(id);
  const stray = page.document.createElement("span");
  stray.textContent = "x";
  seg.appendChild(stray);
  for (const key of keys) {
    const button = page.document.createElement("button");
    button.dataset[attr] = key;
    seg.appendChild(button);
  }
  const click = (key) =>
    seg.listeners.click[0]({
      target: {
        closest: (selector) => (selector === "button" ? seg.children.find((b) => b.dataset[attr] === key) : null),
      },
    });
  return { seg, stray, click };
};
const grid = (doc) => {
  const [thead, tbody] = doc.getElementById("grid").children;
  return { thead, tbody, rows: tbody.children, head: thead.children[0].children };
};
const svgTexts = (node) =>
  (node.children || []).flatMap((c) =>
    typeof c === "string" ? [] : [...(c.tagName === "TEXT" ? [c.textContent] : []), ...svgTexts(c)],
  );
const marksOf = (svg) => svg.children.filter((c) => c.tagName === "G");
const shape = (nodes) => nodes.map((n) => `${n.tagName} ${n.className}`.trim());
const tipClasses = (page, node) => {
  node.listeners.pointerenter[0]({ clientX: 10, clientY: 10 });
  const rows = page.document.getElementById("tip").children;
  assert.ok(rows.every((c) => c.tagName === "DIV"));
  const classes = rows.map((c) => c.className);
  node.listeners.pointerleave[0]();
  return classes;
};
const drag = (scroller) => {
  const on = (type) => scroller.listeners[type][0];
  on("pointerdown")({ button: 0, target: { closest: () => null }, clientX: 100, clientY: 0 });
  on("pointermove")({ clientX: 40, clientY: 0 });
  on("pointerup")();
};

function loadModules(...names) {
  const ctx = vm.createContext({ Date, __stryker__: { activeMutant: process.env.__STRYKER_ACTIVE_MUTANT__ } });
  const blank = (text) => text.replace(/[^\n]/g, " ");
  for (const name of names) {
    vm.runInContext(
      readModule(name)
        .replace(IMPORT_RE, blank)
        .replace(/^export\s/gm, blank),
      ctx,
    );
  }
  return (code) => JSON.parse(JSON.stringify(vm.runInContext(code, ctx)));
}

test("the shared state starts on this week, this month and this year, with no search", () => {
  const run = loadModules("format.js", "teamstate.js");
  assert.deepEqual(run("[team.month, team.year, team.search, team.view, team.filter, team.display, team.fixDay]"), [
    "2026-09",
    "2026",
    "",
    "week",
    "issues",
    "table",
    10,
  ]);
  assert.deepEqual(run("FlagText"), {
    open: "Sin cerrar",
    empty: "Sin fichar",
    long: "Jornada muy larga",
  });
});

test("the name search folds case and accents, ignores the spaces around it, and nothing more", () => {
  const run = loadModules("format.js", "teamstate.js");
  assert.deepEqual(
    [
      'named({ name: "López" }, "lopez")',
      'named({ name: "Zoe" }, "  zoe ")',
      'named({ name: "ZOE" }, "oe")',
      'named({ name: "Ana" }, "")',
      'named({ name: "Ana" }, "bea")',
      'named({ name: "Strauß" }, "strauss")',
    ].map(run),
    [true, true, true, true, false, false],
  );
});

test("a day cell tells today, what is still to come, flags and live sessions, with the tags the stylesheet reads", async () => {
  const days = [
    day("2026-09-14", { sessions: [punch("2026-09-14", 9, null)] }),
    day(TODAY, {
      hours: 1,
      absence: "Vacaciones",
      sessions: [punch(TODAY, 8, 9), punch(TODAY, 10, null)],
    }),
    day("2026-09-16", {
      flags: ["empty"],
      requests: [{ from: stamp("2026-09-16", 9), to: null, status: "pending", reason: "" }],
    }),
    day("2026-09-17", { hours: 5 }),
    day("2026-09-18", { absence: "Baja" }),
    day("2026-09-19"),
    day("2026-09-20"),
  ];
  const ana = staff({ due: 16, balance: -3, hours: 20, days });
  const { doc } = site({ data: period("2026-09-14", [ana]), path: "/gestion" });
  await settle();
  const { thead, tbody, rows, head } = grid(doc);
  assert.equal(thead.tagName, "THEAD");
  assert.equal(tbody.tagName, "TBODY");
  assert.deepEqual(shape(rows), ["TR"]);
  assert.deepEqual(shape(thead.children), ["TR"]);
  assert.deepEqual(
    head.map((th) => [th.tagName, th.className, th.textContent]),
    [
      ["TH", "", "Persona"],
      ["TH", "", "Lun 14"],
      ["TH", "today", "Mar 15"],
      ["TH", "", "Mié 16"],
      ["TH", "", "Jue 17"],
      ["TH", "", "Vie 18"],
      ["TH", "", "Semana"],
    ],
  );
  const cells = rows[0].children;
  assert.deepEqual(shape(cells), [
    "TD name",
    "TD day",
    "TD day today",
    "TD day future warn",
    "TD day future",
    "TD day future",
    "TD total",
  ]);
  assert.deepEqual(cells.slice(1, 6).map(cellText), [
    "0h",
    "1h| Vacaciones · en curso",
    "Sin fichar|Solicitud pendiente 09:00",
    "5h",
    "Baja",
  ]);
  assert.deepEqual(shape(cells[1].children), ["SPAN hours"]);
  assert.deepEqual(shape(cells[2].children), ["SPAN hours", "SPAN meta"]);
  assert.deepEqual(shape(cells[3].children), ["SPAN flag warn", "SPAN req pending"]);
  assert.deepEqual(shape(cells[5].children), ["SPAN meta"]);
  assert.deepEqual(shape(cells[0].children), ["A"]);
  assert.equal(cells[0].children[0].href, "/empleado?id=1");
  assert.equal(rowName(rows[0]), "Ana");
  assert.equal(cellText(cells[6]), "Faltan 3h hasta ayer|13h| de 16h");
  assert.deepEqual(shape(cells[6].children), ["SPAN gap", "SPAN hours", "SPAN meta"]);
  assert.equal(cells[6].tabIndex, 0);

  const dialog = doc.getElementById("dayDialog");
  cells[3].listeners.keydown[0]({ key: "Tab" });
  assert.equal(dialog.open, false);
  cells[3].listeners.keydown[0]({ key: "Enter" });
  assert.equal(dialog.open, true);
});

test("a week's total counts up to yesterday only while it is running, and only once it has started", async () => {
  let spans = [];
  const totals = async (first, extra) => {
    const ana = staff({ days: range(first).map((date) => day(date)), ...extra });
    const { doc } = site({ data: period(first, [ana]) });
    await settle();
    const last = grid(doc).rows[0].children.at(-1);
    spans = shape(last.children);
    return [cellText(last), last.className];
  };
  const running = { due: 32, balance: -2, hours: 31 };
  assert.deepEqual(await totals("2026-09-09", running), ["Faltan 2h hasta ayer|30h| de 32h", "total"]);
  assert.deepEqual(await totals("2026-09-01", running), ["Faltan 2h|31h| de 40h", "total"]);
  assert.deepEqual(await totals("2026-09-15", { due: 0, balance: 0, hours: 0 }), ["0h| de 40h", "total"]);
  assert.deepEqual(await totals("2026-09-21", running), ["31h| de 40h", "total"]);
  assert.deepEqual(await totals("2026-09-09", { target: null, balance: null, due: null, hours: 30 }), [
    "30h| sin horario",
    "total",
  ]);
  assert.deepEqual(await totals("2026-09-01", { suspect: true, flags: ["over"], balance: 6, hours: 46 }), [
    "Sobran 6h|46h| de 40h|⚠ incluye una jornada muy larga: suma no fiable",
    "total bad warn",
  ]);
  assert.deepEqual(spans, ["SPAN gap", "SPAN hours", "SPAN meta", "SPAN flag warn"]);
});

test("a week's total tooltip lists its closed days, then why it is flagged or how it stands", async () => {
  const days = [
    day("2026-09-07", { hours: 7, sessions: [punch("2026-09-07", 9, 16)] }),
    day("2026-09-08", { hours: 0, sessions: [punch("2026-09-08", 9, null)] }),
    ...range("2026-09-09", 5).map((date) => day(date)),
  ];
  const bruno = staff({ id: 2, name: "Bruno", hours: 46, balance: 6, flags: ["over"], days });
  const ana = staff({ days });
  const idle = staff({
    id: 3,
    name: "Cleo",
    target: null,
    balance: null,
    due: null,
    days: range("2026-09-07").map((d) => day(d)),
  });
  const { doc, page } = site({ data: period("2026-09-07", [ana, bruno, idle]) });
  await settle();
  const total = (i) => grid(doc).rows[i].children.at(-1);
  assert.deepEqual(hover(page, total(0)), [
    "Saldo de la semana, día a día",
    "Lun 7 sep −1h",
    "Semana frente a 40h +0h",
  ]);
  assert.deepEqual(tipClasses(page, total(0)), ["t-title", "t-row", "t-sep", "t-row"]);
  assert.deepEqual(hover(page, total(1)), [
    "Saldo de la semana, día a día",
    "Lun 7 sep −1h",
    "46h de 40h previstas: sobran 6h, más de 5h",
  ]);
  assert.deepEqual(tipClasses(page, total(1)), ["t-title", "t-row", "t-sep", "t-note bad"]);
  page.run("team.data.employees[0].days[0].sessions = []; render()");
  assert.deepEqual(hover(page, total(0)), [
    "Saldo de la semana, día a día",
    "Ningún día cerrado con jornada prevista",
    "Semana frente a 40h +0h",
  ]);
  assert.deepEqual(tipClasses(page, total(0)), ["t-title", "t-note", "t-sep", "t-row"]);
  assert.deepEqual(hover(page, total(2)), ["Saldo de la semana, día a día", "Ningún día cerrado con jornada prevista"]);
});

const MONDAYS = ["2026-09-02", "2026-09-09", "2026-09-15", "2026-09-22"];
const monthData = (extra) => {
  const changes = {
    1: { flags: ["empty"] },
    2: { flags: ["empty"] },
    3: { hours: 7, sessions: [punch("2026-09-05", 9, 16)] },
    10: { hours: 9, sessions: [punch("2026-09-12", 9, 18)] },
  };
  const days = () => MONDAYS.flatMap((monday) => range(monday)).map((date, i) => day(date, changes[i]));
  const weeks = (changed = {}) => MONDAYS.map((monday, i) => week(monday, changed[i]));
  const unscheduled = { target: null, balance: null, due: null };
  return period(
    "2026-08-31",
    [
      staff({
        hours: 160,
        target: 160,
        due: 160,
        flagged_days: 2,
        days: days(),
        weeks: weeks({ 2: { flags: ["under"] } }),
      }),
      staff({
        id: 2,
        name: "Bea",
        hours: 152,
        target: 160,
        balance: -8,
        due: 160,
        days: days().map((d) => day(d.date)),
        weeks: weeks({ 1: { flags: ["under"], hours: 32, balance: -8 } }),
      }),
      staff({
        id: 3,
        name: "Cleo",
        hours: 100,
        ...unscheduled,
        days: days().map((d) => day(d.date)),
        weeks: MONDAYS.map((monday) => week(monday, unscheduled)),
      }),
    ],
    { start: "2026-09-01", stop: "2026-10-01", ...extra },
  );
};
const MONTH = "/gestion#v=month&p=2026-09&f=all";

test("the month view draws each week whole with its own days, its own flags and today, and a total for the month", async () => {
  const { doc, page } = site({ data: monthData(), path: MONTH });
  await settle();
  const { head, rows } = grid(doc);
  assert.deepEqual(
    head.map((th) => [th.className, th.textContent]),
    [
      ["", "Persona"],
      ["", "2 sep – 8 sep"],
      ["today", "9 sep – 15 sep"],
      ["today", "15 sep – 21 sep"],
      ["", "22 sep – 28 sep"],
      ["", "Mes"],
    ],
  );
  const [ana, bea, cleo] = rows.map((r) => r.children);
  assert.deepEqual(shape(ana), [
    "TD name",
    "TD total week warn",
    "TD total week today",
    "TD total week today",
    "TD total week",
    "TD total warn",
  ]);
  assert.deepEqual(ana.slice(1).map(cellText), [
    "Al día|40h| de 40h|2 días con errores de fichaje",
    "Al día hasta ayer|40h| de 40h",
    "40h| de 40h",
    "40h| de 40h",
    "Al día hasta ayer|160h| de 160h",
  ]);
  assert.deepEqual(shape(ana[1].children), ["SPAN gap", "SPAN hours", "SPAN meta", "SPAN flag warn"]);
  assert.deepEqual(shape(bea).slice(1), [
    "TD total week",
    "TD total bad week today",
    "TD total week today",
    "TD total week",
    "TD total bad",
  ]);
  assert.equal(cellText(bea[2]), "Faltan 8h hasta ayer|32h| de 40h");
  assert.equal(cellText(cleo[5]), "100h| sin horario");
  assert.equal(cleo[5].tabIndex, undefined);
  assert.equal(cleo[5].listeners.pointerenter, undefined);
  assert.equal(ana[5].tabIndex, 0);

  assert.deepEqual(hover(page, ana[1]), ["Saldo de la semana, día a día", "Sáb 5 sep −1h", "Semana frente a 40h +0h"]);
  assert.deepEqual(hover(page, ana[2]), ["Saldo de la semana, día a día", "Sáb 12 sep +1h", "Semana frente a 40h +0h"]);
  assert.deepEqual(hover(page, ana[5]), [
    "Saldo de cada semana, entera",
    "2 sep – 8 sep +0h",
    "9 sep – 15 sep +0h",
    "15 sep – 21 sep +0h",
    "22 sep – 28 sep +0h",
    "Días del mes hasta ayer +0h",
  ]);
  assert.deepEqual(tipClasses(page, ana[5]), ["t-title", "t-row", "t-row", "t-row", "t-row", "t-sep", "t-row"]);
});

test("a month that ends today is no longer running, and says so in its tooltip", async () => {
  const { doc, page } = site({ data: monthData({ stop: TODAY }), path: MONTH });
  await settle();
  const total = grid(doc).rows[0].children[5];
  assert.equal(cellText(total), "Al día|160h| de 160h");
  assert.equal(hover(page, total).at(-1), "Solo los días del mes +0h");
});

test("a week of the month opens in the week view, but not on another key, nor at the end of a drag", async () => {
  const { doc, page, urls } = site({ data: monthData(), path: MONTH });
  await settle();
  const cell = () => grid(doc).rows[0].children[1];
  const tip = doc.getElementById("tip");
  const before = urls.length;
  cell().listeners.keydown[0]({ key: "Tab" });
  drag(doc.getElementById("gridScroll"));
  cell().listeners.click[0]();
  assert.equal(urls.length, before);
  assert.equal(page.run("team.search"), "");
  cell().listeners.pointerenter[0]({ clientX: 10, clientY: 10 });
  assert.equal(tip.style.display, "block");
  cell().listeners.click[0]();
  assert.equal(tip.style.display, "none");
  assert.equal(urls.at(-1), "/api/team?week=2026-09-02");
  assert.deepEqual(page.run("[team.search, team.view]"), ["Ana", "week"]);

  const again = site({ data: monthData(), path: MONTH });
  await settle();
  grid(again.doc).rows[0].children[1].listeners.keydown[0]({ key: "Enter" });
  assert.equal(again.urls.at(-1), "/api/team?week=2026-09-02");
});

const yearData = () => {
  const months = (changes = {}) =>
    Array.from({ length: 12 }, (_, i) => ({
      month: `2026-${String(i + 1).padStart(2, "0")}`,
      hours: 140,
      target: 140,
      balance: 0,
      due: 140,
      suspect: false,
      under: 0,
      over: 0,
      flagged_days: 0,
      ...changes[i],
    }));
  return period(
    "2025-12-29",
    [
      staff({
        hours: 1590,
        target: 1600,
        balance: -10,
        due: 1600,
        months: months({
          2: { hours: 137, balance: -3, under: 2 },
          3: { under: 1, flagged_days: 1 },
          4: { over: 2, balance: 12.5 },
        }),
      }),
      staff({
        id: 2,
        name: "Beto",
        hours: 1608,
        target: 1600,
        balance: 8,
        due: 1600,
        months: months({ 5: { over: 1 } }),
      }),
    ],
    { year: 2026, start: "2026-01-01", stop: "2027-01-01" },
  );
};
const YEAR = "/gestion#v=year&p=2026&f=all";

test("the year view draws each month against its target, what is red, today's month and the months to come", async () => {
  const { doc } = site({ data: yearData(), path: YEAR });
  await settle();
  const { head, rows } = grid(doc);
  assert.deepEqual(
    head.map((th) => [th.className, th.textContent]),
    [
      ["", "Persona"],
      ...["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago"].map((m) => ["", m]),
      ["today", "Sep"],
      ...["Oct", "Nov", "Dic", "Año"].map((m) => ["", m]),
    ],
  );
  const [ana, beto] = rows.map((r) => r.children);
  assert.deepEqual(shape(ana).slice(1), [
    ...Array(2).fill("TD total week"),
    "TD total week bad",
    "TD total week warn",
    ...Array(4).fill("TD total week"),
    "TD total week today",
    ...Array(3).fill("TD total week future"),
    "TD total bad",
  ]);
  assert.deepEqual(
    [1, 3, 4, 5, 9, 10].map((i) => cellText(ana[i])),
    [
      "Al día|140h| de 140h",
      "Faltan 3h|137h| de 140h|2 semanas bajo objetivo",
      "Al día|140h| de 140h|1 semana bajo objetivo|1 día con errores de fichaje",
      "Sobran 12h 30m|140h| de 140h|2 semanas con demasiadas horas",
      "Al día hasta ayer|140h| de 140h",
      "",
    ],
  );
  assert.deepEqual(shape(ana[3].children), ["SPAN gap", "SPAN hours", "SPAN meta", "SPAN flag"]);
  assert.deepEqual(shape(ana[4].children).slice(3), ["SPAN meta block", "SPAN flag warn"]);
  assert.deepEqual(shape(ana[5].children).slice(3), ["SPAN meta block"]);
  assert.equal(cellText(ana[13]), "Faltan 10h hasta ayer|1590h| de 1600h");
  assert.equal(beto[6].className, "total week bad");
  assert.deepEqual(shape(beto[6].children).slice(3), ["SPAN flag"]);
  assert.equal(cellText(beto[6]), "Al día|140h| de 140h|1 semana con demasiadas horas");
  assert.deepEqual([beto[13].className, cellText(beto[13])], ["total", "Sobran 8h hasta ayer|1608h| de 1600h"]);
});

test("a month of the year opens in the month view, but not on another key, nor at the end of a drag", async () => {
  const { doc, page, urls } = site({ data: yearData(), path: YEAR });
  await settle();
  const cell = () => grid(doc).rows[0].children[3];
  const tip = doc.getElementById("tip");
  const before = urls.length;
  cell().listeners.keydown[0]({ key: "Tab" });
  drag(doc.getElementById("gridScroll"));
  cell().listeners.click[0]();
  assert.equal(urls.length, before);
  tip.style.display = "block";
  cell().listeners.click[0]();
  assert.equal(tip.style.display, "none");
  assert.equal(urls.at(-1), "/api/team?month=2026-03");
  assert.deepEqual(page.run("[team.search, team.view]"), ["Ana", "month"]);

  const again = site({ data: yearData(), path: YEAR });
  await settle();
  grid(again.doc).rows[0].children[3].listeners.keydown[0]({ key: "Enter" });
  assert.equal(again.urls.at(-1), "/api/team?month=2026-03");
});

test("the year's charts stop at the current month and name the people behind each one", async () => {
  const { doc, page } = site({ data: yearData(), path: YEAR });
  const show = segment(page, "displaySeg", "display", ["table", "charts"]);
  await settle();
  show.click("charts");
  const [people, timeline] = doc.getElementById("charts").children;
  assert.deepEqual(shape(people.children), ["H3 chart-title", "P chart-note", "SVG"]);
  assert.equal(people.children[2].getAttribute("class"), "diverging");
  assert.equal(people.children[0].textContent, "Saldo de cada persona en el año");
  assert.equal(
    people.children[1].textContent,
    "Horas de fichajes cerrados menos jornada prevista, hasta ayer: hoy aún no cuenta. " +
      "Una entrada sin cerrar no suma horas, así que resta como si faltaran. " +
      "A la izquierda faltan, a la derecha sobran.",
  );
  assert.deepEqual(svgTexts(people.children[2]), ["Ana", "−10h", "Beto", "+8h"]);
  assert.deepEqual(hover(page, marksOf(people.children[2])[0]), [
    "Ana",
    "Fichadas 1590h",
    "Previstas 1600h",
    "Saldo Faltan 10h",
  ]);
  assert.equal(timeline.children[0].textContent, "Personas con meses fuera de objetivo");
  assert.equal(timeline.children[1].textContent, "Cada mes sin errores de fichaje, si el año no lo compensa.");
  assert.equal(timeline.children[2].className, "legend-row");
  const columns = marksOf(timeline.children[3]);
  assert.equal(columns.length, 9);
  assert.deepEqual(hover(page, columns[2]), ["Marzo de 2026", "Bajo objetivo 1", "Ana", "Demasiadas horas 0"]);
  assert.deepEqual(hover(page, columns[5]), ["Junio de 2026", "Bajo objetivo 0", "Demasiadas horas 1", "Beto"]);
  assert.deepEqual(hover(page, columns[8]).slice(1), ["Bajo objetivo 0", "Demasiadas horas 0"]);
});

const chartsOf = (doc) => doc.getElementById("charts").children;

test("the week's charts sort the balances, explain the unreliable ones, and count the people with errors per day", async () => {
  const data = teamPayload();
  const extra = (id, name) => ({
    ...data.employees[3],
    id,
    name,
    flags: [],
    days: data.employees[2].days.map((d) => ({ ...d })),
  });
  data.employees.push(extra(5, "Dora"), extra(6, "Eli"));
  [2, -6, null, 7, 0.5, -1.5].forEach((balance, i) => {
    data.employees[i].balance = balance;
  });
  data.employees[3].flagged_days = 1;
  data.employees[0].flagged_days = 2;
  data.employees[3].days[1].flags = ["empty"];
  data.employees[0].days[5].sessions = [
    { in: "2025-03-08T09:00:00", out: "2025-03-08T10:00:00", hours: 1, rest: false },
  ];
  const { doc, page } = site({ data, path: "/gestion#f=all&d=charts" });
  const widen = page.document.createElement;
  page.document.createElement = (tag) => Object.assign(widen(tag), tag === "h3" ? { clientWidth: 800 } : {});
  await settle();
  const [people, timeline] = chartsOf(doc);
  assert.deepEqual(shape(people.children), ["H3 chart-title", "P chart-note", "SVG", "P chart-note"]);
  assert.equal(people.children[0].textContent, "Saldo de cada persona en la semana");
  assert.equal(
    people.children[1].textContent,
    "Horas de fichajes cerrados menos jornada prevista. " +
      "Una entrada sin cerrar no suma horas, así que resta como si faltaran. " +
      "A la izquierda faltan, a la derecha sobran.",
  );
  assert.deepEqual(svgTexts(people.children[2]), [
    "Álvaro",
    "−6h",
    "Eli",
    "−1h 30m",
    "Dora",
    "+30m",
    "Zoe",
    "⚠ +2h",
    "Bruno",
    "⚠ +7h",
  ]);
  assert.equal(
    people.children[3].textContent,
    "⚠ Saldo no fiable: incluye errores de fichaje, que se corrigen antes de juzgar sus horas.",
  );
  const bars = marksOf(people.children[2]);
  assert.deepEqual(hover(page, bars[4]).slice(-2), ["Saldo Sobran 7h", "Aviso 1 día con errores de fichaje"]);
  assert.deepEqual(hover(page, bars[3]).slice(-1), ["Aviso 2 días con errores de fichaje"]);
  assert.equal(hover(page, bars[0]).length, 4);
  assert.match(people.children[2].getAttribute("viewBox"), /^0 0 800 /);

  assert.deepEqual(shape(timeline.children), ["H3 chart-title", "P chart-note", "SVG"]);
  assert.equal(timeline.children[0].textContent, "Personas con incidencias cada día");
  assert.equal(timeline.children[1].textContent, "Días sin fichar, sin cerrar o con una jornada muy larga.");
  const columns = marksOf(timeline.children[2]);
  assert.deepEqual(svgTexts(columns[1]).slice(-2).map(String), ["2", "Mar"]);
  assert.equal(columns[1].children[1].getAttribute("class"), "bar error");
  assert.match(timeline.children[2].getAttribute("viewBox"), /^0 0 800 /);
  assert.deepEqual(
    svgTexts(timeline.children[2]).filter((t) => /^[A-Z]/.test(t)),
    ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"],
  );
  assert.deepEqual(hover(page, columns[1]), [
    `Mar 4 mar${Y25}`,
    "Personas con errores de fichaje 2",
    "Álvaro",
    "Bruno",
  ]);
  assert.deepEqual(
    page.run(`(() => {
      const rows = team.data.employees.slice().sort((a, b) => b.name.localeCompare(a.name, "es"));
      const names = rows.map((e) => e.name);
      const flagged = periods(team.data, rows, "${TODAY}")[1].people.flagged;
      return [flagged, rows.map((e) => e.name).join() === names.join()];
    })()`),
    [["Álvaro", "Bruno"], true],
  );

  page.run(`team.data.stop = "${TODAY}"; render()`);
  assert.doesNotMatch(chartsOf(doc)[0].children[1].textContent, /hasta ayer/);
  page.run('team.data.stop = "2999-01-01"; team.data.employees.forEach((e) => { e.due = 30; }); render()');
  const running = chartsOf(doc)[0];
  assert.match(
    running.children[1].textContent,
    /^Horas de fichajes cerrados menos jornada prevista, hasta ayer: hoy aún no cuenta\. Una/,
  );
  assert.deepEqual(hover(page, marksOf(running.children[2])[2]).slice(1, 3), ["Fichadas 30h 30m", "Previstas 30h"]);
});

test("the month's charts count the red weeks per week, and say when nobody has a schedule", async () => {
  const { doc, page } = site({ data: monthData(), path: `${MONTH}&d=charts` });
  await settle();
  const [people, timeline] = chartsOf(doc);
  assert.equal(people.children[0].textContent, "Saldo de cada persona en el mes");
  assert.match(people.children[2].getAttribute("viewBox"), /^0 0 1100 /);
  assert.match(timeline.children[3].getAttribute("viewBox"), /^0 0 1100 /);
  assert.deepEqual(shape(timeline.children), ["H3 chart-title", "P chart-note", "DIV legend-row", "SVG"]);
  assert.equal(timeline.children[0].textContent, "Personas con semanas fuera de objetivo");
  assert.equal(
    timeline.children[1].textContent,
    "Cada semana entera, ya terminada y sin errores de fichaje, si el mes no la compensa.",
  );
  const weeks = marksOf(timeline.children[3]);
  assert.equal(weeks.length, 4);
  assert.deepEqual(hover(page, weeks[1]), ["9 sep – 15 sep", "Bajo objetivo 1", "Bea", "Demasiadas horas 0"]);
  assert.deepEqual(hover(page, weeks[2]), ["15 sep – 21 sep", "Bajo objetivo 0", "Demasiadas horas 0"]);
  page.run("team.data.employees.forEach((e) => { e.balance = null; }); render()");
  const empty = chartsOf(doc)[0].children.at(-1);
  assert.deepEqual(
    [empty.tagName, empty.className, empty.textContent],
    ["P", "chart-note", "Nadie con jornada prevista"],
  );
});

test("each filter keeps its own people, counts them, and says who is missing from the period shown", async () => {
  const data = teamPayload();
  data.employees.find((e) => e.name === "Ana").pending = 0;
  data.employees.find((e) => e.name === "Bruno").pending = 2;
  const { doc, page } = site({ data, path: "/gestion" });
  const filter = segment(page, "filterSeg", "filter", ["issues", "under", "over", "requests", "all"]);
  const view = segment(page, "viewSeg", "view", ["week", "month", "year"]);
  const display = segment(page, "displaySeg", "display", ["table", "charts"]);
  await settle();
  assert.equal(doc.getElementById("charts").children.length, 0);
  assert.equal(filter.stray.getAttribute("aria-pressed"), null);
  assert.deepEqual(
    filter.seg.children.slice(1).map((b) => b.getAttribute("aria-pressed")),
    ["true", "false", "false", "false", "false"],
  );
  assert.equal(view.stray.getAttribute("aria-pressed"), null);
  assert.equal(display.stray.getAttribute("aria-pressed"), null);
  assert.equal(filter.stray.textContent, "x");
  assert.deepEqual(
    filter.seg.children.slice(1).map((b) => b.textContent),
    ["Con incidencias (2)", "Bajo objetivo (1)", "Demasiadas horas (1)", "Con solicitudes (2)", "Todas (4)"],
  );
  assert.deepEqual(
    view.seg.children.slice(1).map((b) => b.getAttribute("aria-pressed")),
    ["true", "false", "false"],
  );
  assert.deepEqual(
    display.seg.children.slice(1).map((b) => b.getAttribute("aria-pressed")),
    ["true", "false"],
  );
  filter.click("requests");
  assert.deepEqual(grid(doc).rows.map(rowName), ["Álvaro", "Bruno"]);
  display.click("charts");
  assert.deepEqual(
    display.seg.children.slice(1).map((b) => b.getAttribute("aria-pressed")),
    ["false", "true"],
  );
  assert.equal(doc.getElementById("charts").children.length, 2);
  display.click("table");
  assert.equal(doc.getElementById("charts").classList.contains("hidden"), true);

  page.run("team.data.employees = []; render()");
  const none = {
    issues: "Nadie tiene incidencias esta semana",
    under: "Nadie bajo objetivo esta semana",
    over: "Nadie con demasiadas horas esta semana",
    requests: "Nadie tiene solicitudes pendientes esta semana",
    all: "Nadie a la vista",
  };
  for (const [key, text] of Object.entries(none)) {
    filter.click(key);
    const empty = grid(doc).rows[0].children[0];
    assert.deepEqual(
      [empty.tagName, empty.className, empty.textContent, empty.colSpan],
      ["TD", "empty-state", text, 7],
    );
    assert.equal(grid(doc).rows[0].tagName, "TR");
  }
  page.run("team.search = '  '; render()");
  assert.equal(grid(doc).rows[0].children[0].textContent, "Nadie a la vista");
  page.run("team.search = ' zz '; render()");
  assert.equal(grid(doc).rows[0].children[0].textContent, "Nadie cuyo nombre contenga «zz»");
});

test("the period's numbers decide what is short, over and flagged, down to the margins", async () => {
  const { page } = site({ data: monthData(), path: MONTH });
  await settle();
  const run = (code) => page.run(code);
  const limits = JSON.stringify(LIMITS);
  assert.deepEqual(
    [
      `shortOf(null, { under_margin: 0 })`,
      `shortOf(-1 / 60, ${limits})`,
      `shortOf(-1 / 120, ${limits})`,
      `surplusOf(null, { over_margin: -1 })`,
      `surplusOf(5, ${limits})`,
      `surplusOf(5.01, ${limits})`,
      "gapText(1 / 60)",
      "gapText(-1 / 60)",
      "gapText(1 / 120)",
      "gapText(0)",
      'shiftWeek("2025-03-03", 2)',
      'shiftWeek("2025-03-17", -2)',
    ].map(run),
    [false, true, false, false, false, true, "Sobran 1m", "Faltan 1m", "Al día", "Al día", "2025-03-17", "2025-03-03"],
  );
  const monthRed = (month, balance) =>
    run(`monthRed({ balance: ${balance} }, ${JSON.stringify({ balance: 0, ...month })}, ${limits})`);
  assert.deepEqual(monthRed({ flagged_days: 0, over: 0 }, 6), { under: false, over: false });
  assert.deepEqual(monthRed({ flagged_days: 1, over: 2 }, 6), { under: false, over: false });
  assert.deepEqual(monthRed({ flagged_days: 0, over: 2 }, 6), { under: false, over: true });
  assert.deepEqual(monthRed({ flagged_days: 0, over: 2 }, 1), { under: false, over: false });
  assert.deepEqual(monthRed({ flagged_days: 0, over: 0, balance: -1 }, -1), { under: true, over: false });

  run("team.view = 'week'");
  assert.deepEqual(
    [
      { flags: [], days: [{ flags: ["open"] }] },
      { flags: [], days: [{ flags: [] }] },
      { flags: ["under"], days: [] },
    ].map((e) => run(`hasFlags(${JSON.stringify(e)})`)),
    [true, false, true],
  );
  run("team.view = 'month'");
  const manyWeeks = JSON.stringify({ flags: [], balance: 6, weeks: [{ flags: ["over"] }, { flags: [] }] });
  assert.equal(run(`Filters.over.keep(${manyWeeks})`), true);
  run("team.view = 'year'");
  const months = (flagged) =>
    JSON.stringify({ flags: [], balance: 0, months: [{ balance: 0, flagged_days: flagged }] });
  assert.deepEqual([run(`hasFlags(${months(2)})`), run(`hasFlags(${months(0)})`)], [true, false]);
  assert.deepEqual(
    [
      "{ sessions: [], requests: [{}], flags: [] }",
      '{ sessions: [], requests: [], flags: ["open"] }',
      "{ sessions: [{}], requests: [], flags: [] }",
      "{ sessions: [], requests: [], flags: [] }",
    ].map((d) => run(`hasData(${d})`)),
    [true, true, true, false],
  );
});

test("the criteria note is written from the limits, each sentence in its place", async () => {
  const { doc } = site({ data: teamPayload(), path: "/gestion" });
  await settle();
  const text = doc.getElementById("criteria").textContent;
  for (const part of [
    "Bajo objetivo: una semana terminada con 1m o más por debajo de su jornada prevista. ",
    "Demasiadas horas: una semana terminada con más de 5h por encima de ella. ",
    "Jornada muy larga: más de 12h fichadas en un día. ",
    "Sin fichar: un día pasado con jornada prevista y sin fichajes ni ausencia. ",
    "Sin cerrar: una entrada de un día anterior sin salida. ",
    "La jornada prevista de cada día es la del contrato vigente ese día; vacaciones, festivos y permisos la reducen. ",
    "Los descansos cuentan como horas. ",
    "En naranja, errores de fichaje, que se corrigen antes de juzgar las horas; ",
    "en rojo, objetivo no cumplido (horas de menos o demasiadas), solo sin errores de fichaje y ",
    "si el periodo que estás viendo no lo compensa: una semana corta en un mes que llega, ",
    "o un mes corto en un año que llega, no sale en rojo. En azul, solicitudes de cambio.",
  ]) {
    assert.ok(text.includes(part), part);
  }
});

test("the view is kept in the URL as the browser is told to, and written down even when the history is missing", async () => {
  const seen = [];
  const history = {
    replaceState: (...args) => seen.push(["replace", ...args]),
    pushState: (...args) => seen.push(["push", ...args]),
    go() {},
  };
  const { doc } = site({ data: teamPayload(), path: "/gestion", globals: { history } });
  await settle();
  const hash = "#v=week&p=2025-03-03&f=issues&d=table&k=open%2Clong%2Cempty";
  assert.deepEqual(seen, [["replace", null, "", hash]]);
  doc.getElementById("search").listeners.input[0]({ target: { value: "zo" } });
  assert.deepEqual(seen.at(-1), ["replace", null, "", `${hash}&q=zo`]);
  const prev = doc.getElementById("prevWeek");
  await prev.listeners.click[0]({ currentTarget: prev });
  assert.deepEqual(
    seen.filter(([how]) => how === "push"),
    [["push", null, "", `${hash}&q=zo`]],
  );

  const bare = site({ data: teamPayload(), path: "/gestion", globals: { history: undefined } });
  await settle();
  const button = bare.doc.getElementById("prevWeek");
  await button.listeners.click[0]({ currentTarget: button });
  const message = bare.doc.getElementById("loadmsg");
  assert.deepEqual([message.textContent, message.classList.contains("hidden")], ["", true]);
  assert.equal(grid(bare.doc).rows.length, 2);
});

test("a browser that refuses the storage is warned about, and the page goes on", async () => {
  const refuse = () => {
    throw new Error("bloqueado");
  };
  const { page, doc } = site({
    data: teamPayload(),
    path: "/gestion",
    storage: { getItem: refuse, setItem: refuse },
  });
  await settle();
  assert.deepEqual(page.calls.warnings, [
    "[odoo] restoring the view failed: Error: bloqueado",
    "[odoo] saving the view failed: Error: bloqueado",
  ]);
  assert.equal(grid(doc).rows.length, 2);
  assert.equal(page.run("team.search"), "");
  const empty = site({ data: teamPayload(), path: "/gestion", storage: { getItem: () => null, setItem() {} } });
  await settle();
  assert.equal(empty.page.calls.warnings, undefined);
});

test("the state read from a hash sets only what it names, with its own spelling of each choice", async () => {
  const { page } = site({ data: teamPayload(), path: "/gestion" });
  await settle();
  const run = (code) => page.run(code);
  assert.equal(run('readState("#v=year&p=2026&f=all&d=charts&k=open,bogus&q=zo")'), "2026");
  assert.deepEqual(run("[team.view, team.filter, team.display, team.search, [...team.fixKinds]]"), [
    "year",
    "all",
    "charts",
    "zo",
    ["open"],
  ]);
  run('readState("#d=table")');
  assert.equal(run("team.display"), "table");
  run('readState("#v=month&d=charts")');
  run('readState("v=year#")');
  assert.deepEqual(run("[team.view, team.display]"), ["month", "charts"]);
  assert.equal(run('readState("#")'), run("thisDay().slice(0, 7)"));
  assert.equal(run("team.search"), "");
  assert.deepEqual(run("[...team.fixKinds]"), ["open"]);
  assert.match(run("stateHash()"), /^#v=month&p=.*&f=all&d=charts&k=open$/);
});

test("a hash without the period opens the current one of its view", async () => {
  const { page } = site({ data: teamPayload(), path: "/gestion" });
  await settle();
  const today = page.run("thisDay()");
  assert.deepEqual(
    ["#v=year&f=all", "#v=month", "#v=week"].map((hash) => page.run(`readState(${JSON.stringify(hash)})`)),
    [today.slice(0, 4), today.slice(0, 7), undefined],
  );
});

test("the view buttons, the search and the arrows keep the page where the URL says", async () => {
  const data = (url) => reply(url.includes("month=") ? monthData() : teamPayload());
  const { doc, page, urls } = site({ data, path: "/gestion" });
  const view = segment(page, "viewSeg", "view", ["week", "month", "year"]);
  await settle();
  const before = urls.length;
  view.click("week");
  assert.equal(urls.length, before);
  view.click("month");
  await settle();
  assert.equal(urls.at(-2), "/api/team?month=2025-03");
  assert.equal(page.calls.pushed.length, 1);
  assert.match(page.calls.pushed[0], /^#v=month&p=2026-09&f=issues/);
  assert.deepEqual(
    view.seg.children.slice(1).map((b) => b.getAttribute("aria-pressed")),
    ["false", "true", "false"],
  );
  assert.equal(doc.getElementById("weekLabel").textContent, "Septiembre de 2026");
  doc.getElementById("search").listeners.input[0]({ target: { value: "bea" } });
  assert.match(page.calls.hash, /&q=bea$/);
  assert.deepEqual(grid(doc).rows.map(rowName), ["Bea"]);
  assert.match(doc.getElementById("subtitle").textContent, /^1 persona · actualizado el 15 sep a las 09:05$/);
  const next = doc.getElementById("nextWeek");
  await next.listeners.click[0]({ currentTarget: next });
  assert.equal(page.calls.pushed.length, 2);
});

test("a reload that fails says why and the next one that works takes the message away", async () => {
  let failing = false;
  const data = () => (failing ? reply({ error: "Odoo no responde" }, false, 502) : reply(teamPayload()));
  const { doc } = site({ data, path: "/gestion" });
  await settle();
  const message = doc.getElementById("loadmsg");
  assert.equal(message.classList.contains("hidden"), true);
  const refresh = doc.getElementById("refreshBtn");
  failing = true;
  await refresh.listeners.click[0]({ currentTarget: refresh });
  assert.deepEqual(
    [message.textContent, message.classList.contains("hidden")],
    ["Error cargando datos de Odoo: Odoo no responde", false],
  );
  failing = false;
  await refresh.listeners.click[0]({ currentTarget: refresh });
  assert.equal(message.classList.contains("hidden"), true);
});

test("a period button is held while its load is in flight", async () => {
  let release;
  let hold = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const data = () => (hold ? gate.then(() => reply(teamPayload())) : reply(teamPayload()));
  const { doc } = site({ data, path: "/gestion" });
  await settle();
  const next = doc.getElementById("nextWeek");
  hold = true;
  const done = next.listeners.click[0]({ currentTarget: next });
  assert.equal(next.disabled, true);
  release();
  await done;
  assert.equal(next.disabled, false);
});

test("the search narrows the fixes too when the table is not there, and resizing redraws only the charts", async () => {
  const { doc, page } = site({ data: teamPayload(), path: "/gestion#f=all" });
  await settle();
  const body = grid(doc).tbody;
  page.calls.window.resize[0]();
  assert.equal(grid(doc).tbody, body);
  page.run("team.data = null");
  doc.getElementById("search").listeners.input[0]({ target: { value: "zo" } });
  assert.match(page.calls.hash, /&q=zo$/);
  const names = doc
    .getElementById("fixes")
    .children[0].children.filter((c) => c.tagName === "A")
    .map((a) => a.textContent);
  assert.deepEqual(names, ["Zoe"]);
});

test("a search that finds the data missing and the fixes unread leaves the fixes note alone", async () => {
  const { doc } = site({
    data: () => reply({ error: "Odoo no responde" }, false, 502),
    fixes: () => reply({ error: "Odoo no responde" }, false, 502),
    path: "/gestion",
  });
  await settle();
  doc.getElementById("search").listeners.input[0]({ target: { value: "zo" } });
  assert.equal(doc.getElementById("fixesNote").textContent, "");
});

test("a saved punch reloads the period and the fixes from the server, not from its cache", async () => {
  const { page, urls } = site({ data: teamPayload(), path: "/gestion" });
  await settle();
  await page.run("refreshDay(1, '2025-03-04', 'Guardado.')");
  assert.ok(urls.includes("/api/team?week=2025-03-03&fresh"));
  assert.ok(urls.includes("/api/team?fixes&fresh"));
});

const fixItem = (kind, date, extra) => ({
  date,
  kind,
  hours: kind === "long" ? 14 : 0,
  target: 8,
  sessions: { open: [punch(date, 9, null)], long: [punch(date, 8, 22)] }[kind] || [],
  ...extra,
});
const fixes = (crew) => ({
  generated_at: new Date().toISOString(),
  limits: LIMITS,
  employees: crew.map(([name, items], i) => ({ id: i + 1, name, items })),
});

test("the people to fix come most open sessions first, then most days, then by name", async () => {
  const days = (kinds) => kinds.map((kind, i) => fixItem(kind, shift("2026-09-01", i)));
  const crew = fixes([
    ["Zaira", days(["long", "long", "long", "long", "long"])],
    ["Ana", days(["long"])],
    ["Beto", days(["open"])],
    ["Ábel", days(["open"])],
    ["Cris", days(["open", "long", "long"])],
    ["Dora", days(["open", "open"])],
  ]);
  const { page } = site({ data: teamPayload(), fixes: crew });
  await settle();
  const sorted = page.run(`(() => {
    const crew = team.fixes.employees;
    const orders = [crew, crew.slice().reverse(), crew.slice(2).concat(crew.slice(0, 2)), crew.slice(4).concat(crew.slice(0, 4))];
    return orders.map((employees) => fixRows({ employees }).map((r) => r.name));
  })()`);
  for (const names of sorted) assert.deepEqual(names, ["Dora", "Cris", "Ábel", "Beto", "Zaira", "Ana"]);
});

test("a mark covers only the sessions to blame, from their start to their end, or to now when still open", async () => {
  const row = {
    id: 5,
    name: "X",
    items: [
      fixItem("open", "2026-09-10", { sessions: [punch("2026-09-10", 8, 12), punch("2026-09-10", 13, null)] }),
      fixItem("long", "2026-09-11", { sessions: [punch("2026-09-11", 6, 9), punch("2026-09-11", 10, 23)], hours: 16 }),
      fixItem("long", "2026-09-12", { sessions: [punch("2026-09-12", 6, 12), punch("2026-09-12", 13, 20)], hours: 13 }),
      fixItem("empty", "2026-09-13"),
    ],
  };
  const { page } = site({ data: teamPayload() });
  await settle();
  const at = (y, m, d, h = 0) => new Date(y, m - 1, d, h).getTime();
  const now = at(2026, 9, 15, 10);
  assert.deepEqual(
    page.run(
      `fixMarks(${JSON.stringify(row)}, new Date(${now})).map((m) => [m.cls, m.start.getTime(), m.end.getTime()])`,
    ),
    [
      ["error", at(2026, 9, 10, 13), now],
      ["error late", at(2026, 9, 11, 10), at(2026, 9, 11, 23)],
      ["error late", at(2026, 9, 12, 6), at(2026, 9, 12, 12)],
      ["error late", at(2026, 9, 12, 13), at(2026, 9, 12, 20)],
      ["missing", at(2026, 9, 13), at(2026, 9, 14)],
    ],
  );
});

test("the strip ends at the midnight after the last error, and starts a week before the first", async () => {
  const { page } = site({ data: teamPayload() });
  await settle();
  const span = (items) =>
    page.run(
      `(() => { const s = fixSpan([{ items: ${JSON.stringify(items)} }], new Date(2025, 11, 30)); return [s.from, s.to].map((d) => [d.getMonth(), d.getDate(), d.getHours()]); })()`,
    );
  assert.deepEqual(span([fixItem("long", "2025-06-02", { sessions: [punch("2025-06-02", 18, 21)] })]), [
    [4, 26, 0],
    [5, 10, 0],
  ]);
  assert.deepEqual(span([fixItem("empty", "2025-06-02")]), [
    [4, 26, 0],
    [5, 10, 0],
  ]);
});

test("the strip's axis names a tick per day, two days or a Monday, by how far it is zoomed", async () => {
  const labels = async (date, zoom) => {
    const { page, doc } = site({ data: teamPayload(), fixes: fixes([["Dora", [fixItem("empty", date)]]]) });
    await settle();
    page.run(`team.fixDay = ${zoom}; renderFixes()`);
    return svgTexts(doc.getElementById("fixes").children[0].children[2]);
  };
  assert.deepEqual(await labels("2026-08-30", 10), ["24 ago", "31 ago", "7 sep"]);
  assert.deepEqual(await labels("2026-09-04", 10), ["31 ago", "7 sep"]);
  assert.deepEqual(await labels("2026-09-04", 25), [
    "28 ago",
    "30 ago",
    "1 sep",
    "3 sep",
    "5 sep",
    "7 sep",
    "9 sep",
    "11 sep",
  ]);
  assert.deepEqual(await labels("2026-09-04", 50), [
    "Vie 28",
    "Sáb 29",
    "Dom 30",
    "Lun 31",
    "Mar 1",
    "Mié 2",
    "Jue 3",
    "Vie 4",
    "Sáb 5",
    "Dom 6",
    "Lun 7",
    "Mar 8",
    "Mié 9",
    "Jue 10",
    "Vie 11",
    "Sáb 12",
  ]);
});

test("the card of fixes draws a row per person with its chips, says what it holds, and zooms within its bounds", async () => {
  const { doc, page } = site({ data: teamPayload() });
  const kinds = segment(page, "fixKinds", "kind", ["open", "long", "empty"]);
  await settle();
  assert.equal(kinds.stray.textContent, "x");
  const scroller = doc.getElementById("fixes");
  const cells = scroller.children[0].children;
  assert.equal(scroller.children[0].tagName, "DIV");
  assert.equal(scroller.children[0].className, "fix-grid");
  assert.deepEqual(shape(cells.slice(0, 3)), ["SPAN label", "SPAN label", "SVG"]);
  assert.deepEqual(shape(cells.slice(3)), ["A fix-name", "DIV chips", "SVG", "A fix-name", "DIV chips", "SVG"]);
  assert.deepEqual(shape(cells[4].children), ["SPAN chip warn", "SPAN chip", "SPAN chip"]);
  assert.deepEqual(shape(cells[7].children), ["SPAN chip"]);
  assert.equal(
    doc.getElementById("fixesNote").textContent,
    "Entradas sin cerrar, jornadas de más de 12h y días con jornada prevista sin fichar, " +
      "de todo el historial de cada persona y sea cual sea el periodo que estés viendo. Una fila por persona.",
  );
  assert.deepEqual([doc.getElementById("zoomIn").disabled, doc.getElementById("zoomOut").disabled], [false, false]);
  assert.equal(scroller.scrollLeft, scroller.scrollWidth);

  page.run("team.search = '  '; team.fixKinds = new Set(); renderFixes()");
  assert.match(doc.getElementById("fixesNote").textContent, /persona\. Nadie con los tipos elegidos\.$/);
  page.run("team.search = ' zoe '; renderFixes()");
  assert.match(
    doc.getElementById("fixesNote").textContent,
    /persona\. Nadie cuyo nombre contenga «zoe» con los tipos elegidos\.$/,
  );
  assert.equal(scroller.children[0].children.length, 3);
  page.run("team.fixes = null; renderFixes()");
  assert.equal(scroller.children.length, 0);
  assert.match(doc.getElementById("fixesNote").textContent, /^Buscando fichajes por corregir/);
});

test("a punch to fix describes itself in its tooltip, with the year it was on", async () => {
  const { doc, page } = site({ data: teamPayload() });
  await settle();
  const marks = marksOf(doc.getElementById("fixes").children[0].children[5]);
  assert.deepEqual(hover(page, marks[0])[0], "Zoe · Jue 20 feb 2025");
  assert.deepEqual(tipClasses(page, marks[0]), ["t-title", "t-note warn", "t-row", "t-note"]);
  assert.deepEqual(hover(page, marks[1])[0], "Zoe · Sáb 12 sep 2026");
  assert.deepEqual(tipClasses(page, marks[1]), ["t-title", "t-note warn", "t-row warn", "t-note"]);
  assert.deepEqual(tipClasses(page, marks[2]), ["t-title", "t-note warn", "t-note"]);
});

test("the kinds and the zoom leave the note alone when the fixes could not be read", async () => {
  const { doc, page } = site({ data: teamPayload(), fixes: () => reply({ error: "Odoo no responde" }, false, 502) });
  const kinds = segment(page, "fixKinds", "kind", ["open", "long", "empty"]);
  await settle();
  const note = doc.getElementById("fixesNote");
  assert.equal(note.textContent, "No se pudieron cargar los fichajes por corregir: Odoo no responde");
  doc.getElementById("zoomIn").listeners.click[0]();
  doc.getElementById("zoomOut").listeners.click[0]();
  kinds.click("long");
  assert.equal(note.textContent, "No se pudieron cargar los fichajes por corregir: Odoo no responde");
  assert.match(page.calls.hash, /k=open%2Cempty$/);
});

test("a mark does not open its day at the end of a drag, and does once the drag is over", async () => {
  const mine = fixes([["Zoe", [fixItem("open", "2025-03-03")]]]);
  const { doc, urls } = site({ data: teamPayload(), fixes: mine });
  await settle();
  const mark = () => marksOf(doc.getElementById("fixes").children[0].children[5])[0];
  drag(doc.getElementById("fixes"));
  await mark().listeners.click[0]();
  assert.equal(doc.getElementById("dayDialog").open, false);
  assert.equal(urls.includes("/api/team?week=2025-03-03"), false);
  await mark().listeners.click[0]();
  assert.equal(urls.includes("/api/team?week=2025-03-03"), true);
  assert.equal(doc.getElementById("dayDialog").open, true);
});
