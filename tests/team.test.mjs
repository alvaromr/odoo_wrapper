// team.js: the management view's page, what each cell, tooltip, chart and card draws, with the classes and tags
// the stylesheet reads, and the history, storage and keys that move between periods. The clock is page.mjs's:
// today is TUESDAY 2026-09-15, which the payloads below are built around.

import assert from "node:assert/strict";
import test from "node:test";
import {
  cellText,
  drag,
  hover,
  LIMITS,
  load,
  marksOf,
  punch,
  siteReply as reply,
  rowName,
  segment,
  settle,
  shape,
  shift,
  site,
  stamp,
  svgTexts,
  teamFixes,
  teamPayload,
  teamWeek,
  tipClasses,
  UP_TO_DATE,
  withFilters,
  Y25,
} from "./page.mjs";

const TODAY = "2026-09-15";

const range = (first, n = 7) => Array.from({ length: n }, (_, i) => shift(first, i));
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

const grid = (doc) => {
  const [thead, tbody] = doc.getElementById("grid").children;
  return { thead, tbody, rows: tbody.children, head: thead.children[0].children };
};

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

test("the management view draws one row per person, sorted in Spanish, with its flags", async () => {
  const page = load({ entry: "team.js", data: teamPayload() });
  const pick = withFilters(page);
  await settle();
  const doc = page.document;
  assert.equal(doc.getElementById("weekLabel").textContent, `Semana del 3 mar al 9 mar${Y25}`);
  assert.match(
    doc.getElementById("criteria").textContent,
    /^Bajo objetivo: una semana terminada con 1m o más por debajo .* más de 5h por encima .* más de 12h fichadas en un día\./,
  );
  assert.match(doc.getElementById("subtitle").textContent, /^4 personas · actualizado el 10 mar a las 09:05/);
  assert.deepEqual(
    doc.getElementById("filterSeg").children.map((b) => [b.textContent, b.getAttribute("aria-pressed")]),
    [
      ["Con incidencias (2)", "true"],
      ["Bajo objetivo (1)", "false"],
      ["Demasiadas horas (1)", "false"],
      ["Con solicitudes (1)", "false"],
      ["Todas (4)", "false"],
    ],
  );
  pick("requests");
  assert.deepEqual(doc.getElementById("grid").children[1].children.map(rowName), ["Álvaro"]);
  pick("all");
  const [thead, tbody] = doc.getElementById("grid").children;
  assert.deepEqual(
    thead.children[0].children.map((th) => th.textContent),
    ["Persona", "Lun 3", "Mar 4", "Mié 5", "Jue 6", "Vie 7", "Semana"],
  );
  assert.deepEqual(tbody.children.map(rowName), ["Álvaro", "Ana", "Bruno", "Zoe"]);
  assert.deepEqual(
    tbody.children.map((tr) => tr.children[0].children[0].href),
    ["/empleado?id=1", "/empleado?id=2", "/empleado?id=4", "/empleado?id=3"],
  );
  const bruno = tbody.children[2].children;
  assert.equal(cellText(bruno[6]), "Sobran 6h 30m|46h 30m| de 40h");
  page.run("team.data.employees.find(e => e.name === 'Bruno').suspect = true; render()");
  const suspect = doc.getElementById("grid").children[1].children[2].children[6];
  assert.equal(cellText(suspect), "Sobran 6h 30m|46h 30m| de 40h|⚠ incluye una jornada muy larga: suma no fiable");
  assert.equal(suspect.classList.contains("bad"), true);
  page.run("team.data.employees.find(e => e.name === 'Bruno').suspect = false; render()");
  assert.equal(hover(page, bruno[6]).at(-1), "46h 30m de 40h previstas: sobran 6h 30m, más de 5h");
  const alvaro = tbody.children[0].children;
  assert.equal(alvaro[2].classList.contains("warn"), true);
  assert.equal(alvaro[2].classList.contains("bad"), false);
  assert.equal(cellText(alvaro[2]), "Sin fichar|Solicitud pendiente 09:00–17:40|Solicitud rechazada 09:00");
  assert.deepEqual(
    alvaro[2].children.slice(1).map((c) => c.className),
    ["req pending", "req refused"],
  );
  assert.deepEqual(hover(page, alvaro[2]), [
    `Mar 4 mar${Y25}`,
    "Sin fichajes",
    "Jornada prevista de 8h sin fichajes ni ausencia",
    "Solicitud pendiente 09:00–17:40",
    "Olvidé fichar",
    "Solicitud rechazada 09:00",
  ]);
  alvaro[2].listeners.pointerenter[0]({ clientX: 10, clientY: 10 });
  assert.deepEqual(
    page.document
      .getElementById("tip")
      .children.filter((c) => /^Solicitud/.test(c.textContent))
      .map((c) => c.className),
    ["t-note pending", "t-note refused"],
  );
  alvaro[2].listeners.pointerleave[0]();
  assert.equal(page.document.getElementById("tip").style.display, "none");
  assert.deepEqual(hover(page, alvaro[6]), [
    "Saldo de la semana, día a día",
    "Ningún día cerrado con jornada prevista",
    "32h de 40h previstas: faltan 8h",
  ]);
  const zoe = tbody.children[3].children;
  assert.deepEqual(hover(page, zoe[1]), [`Lun 3 mar${Y25}`, "09:00–16:30 7h 30m", "Frente a 8h previstas −30m"]);
  assert.deepEqual(hover(page, zoe[6]), [
    "Saldo de la semana, día a día",
    `Lun 3 mar${Y25} −30m`,
    "Semana frente a 40h +0h",
  ]);
  assert.equal(cellText(alvaro[6]), "Faltan 8h|32h| de 40h");
  assert.equal(alvaro[6].classList.contains("bad"), true);
  const ana = tbody.children[1].children;
  assert.equal(cellText(ana[4]), "Vacaciones");
  assert.equal(cellText(ana[6]), "30h| sin horario");
  assert.equal(doc.getElementById("openCard").classList.contains("hidden"), false);
  assert.match(
    doc.getElementById("fixesNote").textContent,
    /^Entradas sin cerrar, jornadas de más de 12h y días con jornada prevista sin fichar/,
  );
  const fixes = doc.getElementById("fixes").children[0].children;
  assert.deepEqual(
    fixes.slice(0, 2).map((c) => c.textContent),
    ["Persona", "Pendiente"],
  );
  const cells = fixes.slice(3);
  assert.deepEqual(
    cells.filter((c) => c.tagName === "A").map((a) => [a.textContent, a.href]),
    [
      ["Zoe", "/empleado?id=3"],
      ["Bruno", "/empleado?id=4"],
    ],
  );
  assert.deepEqual(
    cells[1].children.map((c) => [c.textContent, c.className]),
    [
      ["Abierta desde el 20 feb 2025 08:00", "chip warn"],
      ["1 jornada muy larga · 20h", "chip"],
      ["1 sin fichar", "chip"],
    ],
  );
  assert.deepEqual(
    cells[4].children.map((c) => c.textContent),
    ["1 sin fichar"],
  );
  const zoeMarks = cells[2].children.filter((c) => c.tagName === "G");
  assert.deepEqual(
    zoeMarks.map((g) => g.children[1].getAttribute("class")),
    ["bar error", "bar error late", "bar missing"],
  );
  assert.deepEqual(hover(page, zoeMarks[0]), [
    "Zoe · Jue 20 feb 2025",
    "Sin cerrar",
    "08:00–abierto abierta",
    "Entrada a las 08:00 sin salida",
  ]);
  assert.deepEqual(hover(page, zoeMarks[2]).slice(1), [
    "Sin fichar",
    "Jornada prevista de 8h sin fichajes ni ausencia",
  ]);
  assert.deepEqual(hover(page, zoeMarks[1]).slice(1), [
    "Jornada muy larga",
    "08:00–04:00 20h",
    "20h fichadas en el día, más de 12h",
  ]);
  zoeMarks[1].listeners.pointerenter[0]({ clientX: 10, clientY: 10 });
  assert.equal(doc.getElementById("tip").children[2].classList.contains("warn"), true);
  zoeMarks[1].listeners.pointerleave[0]();
  const brunoMarks = cells[5].children.filter((c) => c.tagName === "G");
  assert.deepEqual(
    brunoMarks.map((g) => g.children[1].getAttribute("class")),
    ["bar missing"],
  );
  assert.ok(fixes[2].children.filter((c) => c.tagName === "TEXT").length >= 6);
  const lines = (strip) => strip.children.filter((c) => c.tagName === "LINE").map((l) => l.getAttribute("class"));
  assert.ok(lines(cells[2]).filter((c) => c === "day").length > 70);
  assert.ok(lines(cells[2]).includes("monday"));
  const width = () => Number(cells[2].getAttribute("width"));
  const strip = () => doc.getElementById("fixes").children[0].children.slice(3)[2];
  const before = Number(strip().getAttribute("width"));
  assert.equal(before, Math.round(page.run("fixSpan(fixRows(team.fixes)).days") * 10));
  doc.getElementById("zoomIn").listeners.click[0]();
  assert.equal(Number(strip().getAttribute("width")), Math.round(page.run("fixSpan(fixRows(team.fixes)).days") * 15));
  for (let k = 0; k < 20; k++) doc.getElementById("zoomIn").listeners.click[0]();
  assert.equal(page.run("team.fixDay"), 96);
  assert.equal(doc.getElementById("zoomIn").disabled, true);
  for (let k = 0; k < 20; k++) doc.getElementById("zoomOut").listeners.click[0]();
  assert.equal(page.run("team.fixDay"), 2);
  assert.equal(doc.getElementById("zoomOut").disabled, true);
  assert.ok(width() > 0);
  assert.deepEqual(
    [1, 2, 7, 14].map(String),
    [40, 20, 6, 3].map((px) => String(page.run(`tickStep(${px})`))),
  );
  const now = new Date(2025, 5, 30, 12);
  const span =
    page.run(`(() => { const s = fixSpan([{ items: [{ date: "2025-06-20", sessions: [{ in: new Date(2025, 5, 20, 16).toISOString() }] }] }],
    new Date(${now.getTime()})); return [s.from.getDate(), s.from.getHours(), Math.round(s.days * 10) / 10]; })()`);
  assert.deepEqual(span, [13, 0, 17.5]);
  const old = page.run(
    `fixSpan([{ items: [{ date: "2020-01-01", sessions: [] }] }], new Date(${now.getTime()})).from.getFullYear()`,
  );
  assert.equal(old, 2019);
  assert.equal(page.run(`fixSpan([], new Date(${now.getTime()})).days`), 7.5);
  const closed = page.run(`(() => { const s = fixSpan([{ items: [
    { date: "2025-06-02", sessions: [{ in: new Date(2025, 5, 2, 18).toISOString(), out: new Date(2025, 5, 2, 21).toISOString() }] },
    { date: "2025-06-04", sessions: [] }] }], new Date(${now.getTime()}));
    return [s.from.getDate(), s.to.getDate(), s.to.getHours(), s.days]; })()`);
  assert.deepEqual(closed, [26, 12, 0, 17]);
  const midnightEnd =
    page.run(`fixSpan([{ items: [{ date: "2025-06-02", sessions: [{ in: new Date(2025, 5, 2, 18).toISOString(),
    out: new Date(2025, 5, 3).toISOString() }] }] }], new Date(${now.getTime()})).days`);
  assert.equal(midnightEnd, 15);
  page.run("team.fixes = null; renderFixes()");
  assert.match(doc.getElementById("fixesNote").textContent, /^Buscando fichajes por corregir/);
  doc.getElementById("zoomIn").listeners.click[0]();
  page.run(`team.data = ${JSON.stringify(teamPayload())}; render()`);
  assert.equal(doc.getElementById("gridCard").classList.contains("hidden"), false);
});

test("the filters keep incidents, under or over target, or everyone, and say when nobody is left", async () => {
  const page = load({ entry: "team.js", data: teamPayload() });
  const pick = withFilters(page);
  await settle();
  const rows = () => page.document.getElementById("grid").children[1].children;
  assert.deepEqual(rows().map(rowName), ["Álvaro", "Bruno"]);
  pick("under");
  assert.deepEqual(rows().map(rowName), ["Álvaro"]);
  pick("over");
  assert.deepEqual(rows().map(rowName), ["Bruno"]);
  pick("all");
  assert.deepEqual(rows().map(rowName), ["Álvaro", "Ana", "Bruno", "Zoe"]);
  page.run(
    "team.data.employees.find(e => e.name === 'Zoe').days[5].sessions = team.data.employees[0].days[0].sessions.concat([{ in: '2025-03-08T09:00:00', out: '2025-03-08T10:00:00', hours: 1, rest: false }]); render()",
  );
  const head = () => page.document.getElementById("grid").children[0].children[0].children.map((th) => th.textContent);
  assert.deepEqual(head(), ["Persona", "Lun 3", "Mar 4", "Mié 5", "Jue 6", "Vie 7", "Sáb 8", "Semana"]);
  assert.equal(rows()[0].children.length, 8);
  pick("over");
  assert.equal(head().includes("Sáb 8"), false);
  page.run("team.data.employees = team.data.employees.filter(e => e.name === 'Zoe'); render()");
  assert.equal(page.document.getElementById("openCard").classList.contains("hidden"), false);
  page.run("team.fixes = { ...team.fixes, employees: [] }; render()");
  assert.equal(rows()[0].children[0].textContent, "Nadie con demasiadas horas esta semana");
  assert.equal(rows()[0].children[0].colSpan, 7);
  pick("issues");
  assert.equal(rows()[0].children[0].textContent, "Nadie tiene incidencias esta semana");
  assert.equal(page.document.getElementById("openCard").classList.contains("hidden"), true);
  pick("all");
  page.run("team.data.employees = []; render()");
  assert.equal(rows()[0].children[0].textContent, "Nadie a la vista");
  page.document.getElementById("filterSeg").listeners.click[0]({ target: { closest: () => null } });
});

test("today's open session reads as in progress, not as zero", async () => {
  const data = teamPayload();
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
  const day = (i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return d;
  };
  const isoOf = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  data.week = isoOf(monday);
  const index = (today.getDay() + 6) % 7;
  data.employees = [
    {
      id: 1,
      name: "Ana",
      hours: 0,
      target: 8,
      flags: [],
      days: [0, 1, 2, 3, 4, 5, 6].map((i) => ({
        date: isoOf(day(i)),
        hours: 0,
        target: 8,
        absence: null,
        flags: [],
        requests: [],
        sessions:
          i === index
            ? [
                {
                  in: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9).toISOString(),
                  out: null,
                  hours: null,
                  rest: false,
                },
              ]
            : [],
      })),
    },
  ];
  const page = load({ entry: "team.js", data });
  const pick = withFilters(page);
  await settle();
  pick("all");
  const cell = page.document.getElementById("grid").children[1].children[0].children[index + 1];
  assert.equal(iso, data.employees[0].days[index].date);
  assert.equal(cellText(cell), "0h| en curso");
  assert.equal(cell.classList.contains("today"), true);
  assert.deepEqual(hover(page, cell).slice(1), ["09:00–abierto en curso"]);
});

test("week buttons ask the server for the week they point at", async () => {
  const page = load({ entry: "team.js", data: teamPayload() });
  await settle();
  const click = async (id) => {
    const button = page.document.getElementById(id);
    await button.listeners.click[0]({ currentTarget: button });
    assert.equal(button.disabled, false);
  };
  await click("prevWeek");
  await click("nextWeek");
  await click("refreshBtn");
  await click("thisWeek");
  assert.deepEqual(
    page.calls.fetch.map(([url]) => url),
    [
      "/api/team",
      "/api/team?fixes",
      "/api/team?week=2025-02-24",
      "/api/team?week=2025-02-24",
      "/api/team?week=2025-02-24",
      "/api/team?week=2025-03-10",
      "/api/team?week=2025-02-24",
      "/api/team?week=2025-03-03&fresh",
      "/api/team?fixes&fresh",
      "/api/team?week=2025-02-24",
      "/api/team",
      "/api/team?week=2025-02-24",
    ],
  );
  page.run("team.data = null");
  withFilters(page)("all");
});

test("the loading bar runs while a load is in flight, and stops even when it fails", async () => {
  let finish;
  const page = load({
    entry: "team.js",
    fetchImpl: (url) =>
      url.includes("week=")
        ? Promise.resolve({ ok: true, status: 200, json: async () => teamPayload() })
        : new Promise((resolve) => {
            finish = resolve;
          }),
  });
  const bar = page.document.getElementById("loadbar");
  assert.equal(bar.classList.contains("on"), true);
  finish({ ok: false, status: 502, json: async () => ({ error: "Odoo no responde" }) });
  await settle();
  assert.equal(bar.classList.contains("on"), false);
});

const monthPayload = () => {
  const p = teamPayload();
  p.start = "2025-03-01";
  p.stop = "2025-04-01";
  const later = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    const t = new Date(y, m - 1, d + 7);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  };
  for (const e of p.employees) {
    e.days = e.days.concat(teamWeek().map((d) => ({ ...d, date: later(d.date) })));
    e.balance = e.target == null ? null : e.hours - e.target;
    e.due = e.target;
    e.weeks = [
      { monday: "2025-03-03", hours: e.hours, target: e.target, balance: e.balance, due: e.target, flags: e.flags },
      {
        monday: "2025-03-10",
        hours: 40,
        target: e.target == null ? null : 40,
        balance: e.target == null ? null : 0,
        due: e.target == null ? null : 40,
        flags: [],
      },
    ];
  }
  return p;
};
const withViews = (page) => {
  const seg = page.document.getElementById("viewSeg");
  for (const key of ["week", "month", "year"]) {
    const button = page.document.createElement("button");
    button.dataset.view = key;
    seg.appendChild(button);
  }
  return (key) =>
    seg.listeners.click[0]({ target: { closest: () => seg.children.find((b) => b.dataset.view === key) } });
};

test("the month view shows each week whole, how many days carry a flag, and the month's own balance", async () => {
  const page = load({ entry: "team.js", data: monthPayload() });
  const view = withViews(page);
  const pick = withFilters(page);
  await settle();
  view("week");
  view("month");
  await settle();
  const doc = page.document;
  assert.equal(page.calls.fetch.at(-2)[0], "/api/team?month=2025-03");
  assert.equal(page.calls.fetch.at(-1)[0], "/api/team?month=2025-02");
  assert.equal(doc.getElementById("weekLabel").textContent, "Marzo de 2025");
  assert.deepEqual(
    doc.getElementById("viewSeg").children.map((b) => b.getAttribute("aria-pressed")),
    ["false", "true", "false"],
  );
  pick("all");
  const [thead, tbody] = doc.getElementById("grid").children;
  assert.deepEqual(
    thead.children[0].children.map((th) => th.textContent),
    ["Persona", "3 mar – 9 mar", "10 mar – 16 mar", "Mes"],
  );
  const alvaro = tbody.children[0].children;
  assert.equal(cellText(alvaro[1]), "Faltan 8h|32h| de 40h|1 día con errores de fichaje");
  assert.equal(alvaro[1].classList.contains("bad"), true);
  assert.equal(alvaro[2].classList.contains("bad"), false);
  assert.equal(cellText(alvaro[3]), "Faltan 8h|32h| de 40h");
  assert.equal(alvaro[3].classList.contains("bad"), true);
  assert.equal(tbody.children[3].children[3].classList.contains("bad"), false);
  assert.deepEqual(hover(page, alvaro[3]), [
    "Saldo de cada semana, entera",
    "3 mar – 9 mar −8h",
    "10 mar – 16 mar +0h",
    "Solo los días del mes −8h",
  ]);
  page.run(
    'team.data = { ...team.data, stop: "2999-01-01", employees: team.data.employees.map(e => ({ ...e, due: 24 })) }; render()',
  );
  assert.equal(
    cellText(doc.getElementById("grid").children[1].children[0].children[3]),
    "Faltan 8h hasta ayer|16h| de 24h",
  );
  assert.deepEqual(
    [
      "{ flags: [], balance: -2, weeks: [] }",
      "{ flags: [], balance: -2, flagged_days: 1, weeks: [] }",
      "{ flags: [], balance: 1, weeks: [{ flags: ['under'] }] }",
      "{ flags: [], balance: -2, flagged_days: 1, weeks: [{ flags: ['under'] }] }",
    ].map((e) => page.run(`Filters.under.keep(${e})`)),
    [true, false, false, true],
  );
  assert.deepEqual(
    [
      "{ flags: [], balance: 6, weeks: [{ flags: ['over'] }] }",
      "{ flags: [], balance: 2, weeks: [{ flags: ['over'] }] }",
    ].map((e) => page.run(`Filters.over.keep(${e})`)),
    [true, false],
  );
  assert.deepEqual(["gapText(0)", "gapText(0.001)", "gapText(1.5)", "gapText(-0.25)"].map(page.run), [
    "Al día",
    "Al día",
    "Sobran 1h 30m",
    "Faltan 15m",
  ]);
  assert.equal(cellText(tbody.children[1].children[3]), "30h| sin horario");
  page.run("team.data = { ...team.data, employees: [] }; team.filter = 'issues'; render()");
  assert.equal(
    doc.getElementById("grid").children[1].children[0].children[0].textContent,
    "Nadie tiene incidencias este mes",
  );
  page.run(`team.data = ${JSON.stringify(monthPayload())}; team.filter = 'all'; render()`);
  const again = doc.getElementById("grid").children[1].children[0].children;
  again[2].listeners.keydown[0]({ key: "Tab" });
  again[2].listeners.keydown[0]({ key: "Enter" });
  assert.equal(page.calls.fetch.at(-1)[0], "/api/team?week=2025-03-10");
  assert.deepEqual([page.run("team.search"), doc.getElementById("search").value], ["Álvaro", "Álvaro"]);
  await settle();
  assert.equal(page.run("team.view"), "week");
  view("month");
  await settle();
  const cells = doc.getElementById("grid").children[1].children[0].children;
  cells[1].listeners.click[0]();
  await settle();
  assert.equal(page.run("team.view"), "week");
  view("week");
});

test("in the month view the arrows and «Hoy» move by months", async () => {
  const page = load({ entry: "team.js", data: monthPayload() });
  const view = withViews(page);
  await settle();
  view("month");
  await settle();
  const click = async (id) => {
    const button = page.document.getElementById(id);
    await button.listeners.click[0]({ currentTarget: button });
  };
  await click("prevWeek");
  assert.equal(page.calls.fetch.at(-2)[0], "/api/team?month=2025-02");
  await click("nextWeek");
  assert.equal(page.calls.fetch.at(-2)[0], "/api/team?month=2025-04");
  await click("refreshBtn");
  assert.equal(page.calls.fetch.at(-3)[0], "/api/team?month=2025-03&fresh");
  assert.equal(page.calls.fetch.at(-2)[0], "/api/team?fixes&fresh");
  await click("thisWeek");
  const now = new Date();
  assert.equal(
    page.calls.fetch.at(-2)[0],
    `/api/team?month=${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
  );
  assert.equal(page.run('shiftMonth("2025-12", 1)'), "2026-01");
  assert.equal(page.run('shiftMonth("2025-01", -1)'), "2024-12");
});

const yearPayload = (year = 2025) => {
  const months = (changes) =>
    Array.from({ length: 12 }, (_, i) => ({
      month: `${year}-${String(i + 1).padStart(2, "0")}`,
      hours: 140,
      target: 140,
      balance: 0,
      due: 140,
      under: 0,
      over: 0,
      flagged_days: 0,
      ...changes[i],
    }));
  return {
    year: 2025,
    week: "2024-12-30",
    start: "2025-01-01",
    stop: "2026-01-01",
    generated_at: new Date(2026, 0, 2).toISOString(),
    limits: { long_day: 12, under_margin: 1 / 60, over_margin: 5 },
    open: [],
    employees: [
      {
        id: 1,
        name: "Álvaro",
        hours: 1600,
        target: 1700,
        balance: -100,
        due: 1700,
        flags: ["under"],
        months: months({
          2: { under: 1, flagged_days: 2 },
          4: { over: 2, balance: 12.5 },
          6: { hours: 137, under: 1, balance: -3 },
        }),
      },
      {
        id: 2,
        name: "Ana",
        hours: 900,
        target: null,
        balance: null,
        due: null,
        flags: [],
        months: months({}).map((m) => ({ ...m, target: null, balance: null, due: null })),
      },
    ],
  };
};

const byPeriod = (urls) => async (url) => {
  if (url === "/api/update") return { ok: true, status: 200, json: async () => UP_TO_DATE };
  urls.push(url);
  const data = url.includes("fixes")
    ? teamFixes()
    : url.includes("year=")
      ? yearPayload()
      : url.includes("month=")
        ? monthPayload()
        : teamPayload();
  return { ok: true, status: 200, json: async () => data };
};

test("the year view shows each month against its target, its weeks off target and its flagged days", async () => {
  const urls = [];
  const page = load({ entry: "team.js", fetchImpl: byPeriod(urls) });
  page.calls.fetch = { at: (i) => [urls.at(i)] };
  const view = withViews(page);
  const pick = withFilters(page);
  await settle();
  view("year");
  await settle();
  const doc = page.document;
  assert.equal(page.calls.fetch.at(-1)[0], "/api/team?year=2025");
  assert.equal(doc.getElementById("weekLabel").textContent, "2025");
  pick("all");
  const [thead, tbody] = doc.getElementById("grid").children;
  assert.deepEqual(
    thead.children[0].children.map((th) => th.textContent),
    ["Persona", "Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic", "Año"],
  );
  const alvaro = tbody.children[0].children;
  assert.equal(cellText(alvaro[3]), "Al día|140h| de 140h|1 semana bajo objetivo|2 días con errores de fichaje");
  assert.deepEqual(
    [alvaro[3].classList.contains("bad"), alvaro[3].classList.contains("warn"), alvaro[3].children[3].className],
    [false, true, "meta block"],
  );
  assert.equal(cellText(alvaro[7]), "Faltan 3h|137h| de 140h|1 semana bajo objetivo");
  assert.deepEqual([alvaro[7].classList.contains("bad"), alvaro[7].children[3].className], [true, "flag"]);
  assert.equal(cellText(alvaro[5]), "Sobran 12h 30m|140h| de 140h|2 semanas con demasiadas horas");
  assert.equal(alvaro[1].classList.contains("bad"), false);
  assert.equal(cellText(alvaro[13]), "Faltan 100h|1600h| de 1700h");
  assert.equal(alvaro[13].classList.contains("bad"), true);
  assert.equal(tbody.children[1].children[13].classList.contains("bad"), false);
  const ana = tbody.children[1].children;
  assert.equal(cellText(ana[1]), "140h| sin horario");
  assert.equal(cellText(ana[13]), "900h| sin horario");
  pick("issues");
  assert.deepEqual(doc.getElementById("grid").children[1].children.map(rowName), ["Álvaro"]);
  const made = "{ flags: ['under'], balance: -1, flagged_days: 1, months: [{ balance: 0 }, { balance: -2 }] }";
  assert.deepEqual(
    [made, made.replace("-1", "5"), made.replace("-2", "3")].map((e) => page.run(`Filters.under.keep(${e})`)),
    [true, false, false],
  );
  assert.equal(
    page.run(
      "Filters.under.keep({ flags: [], balance: -5, flagged_days: 2, months: [{ balance: -5, flagged_days: 2 }] })",
    ),
    false,
  );
  page.run("team.data = { ...team.data, employees: [] }; render()");
  assert.equal(
    doc.getElementById("grid").children[1].children[0].children[0].textContent,
    "Nadie tiene incidencias este año",
  );
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  page.run(
    `team.year = "${now.getFullYear()}"; team.data = ${JSON.stringify(yearPayload(now.getFullYear()))}; render()`,
  );
  const cells = doc.getElementById("grid").children[1].children[0].children;
  const index = now.getMonth() + 1;
  assert.equal(cells[index].classList.contains("today"), true);
  assert.match(cellText(cells[index]), /Al día hasta ayer/);
  assert.equal(cellText(cells[13]), "Faltan 100h hasta ayer|1600h| de 1700h");
  if (index < 12) {
    assert.equal(cells[index + 1].classList.contains("future"), true);
    assert.equal(cells[index + 1].children.length, 0);
  }
  page.run(`team.year = "2025"; team.data = ${JSON.stringify(yearPayload())}; render()`);
  const again = doc.getElementById("grid").children[1].children[0].children;
  again[3].listeners.keydown[0]({ key: "Tab" });
  again[3].listeners.keydown[0]({ key: "Enter" });
  assert.equal(page.calls.fetch.at(-1)[0], "/api/team?month=2025-03");
  assert.equal(page.run("team.search"), "Álvaro");
  await settle();
  view("year");
  await settle();
  doc.getElementById("grid").children[1].children[0].children[3].listeners.click[0]();
  await settle();
  assert.equal(page.run("team.view"), "month");
  assert.ok(thisMonth);
});

test("in the year view the arrows and «Hoy» move by years, with no background prefetch", async () => {
  const urls = [];
  const page = load({ entry: "team.js", fetchImpl: byPeriod(urls) });
  page.calls.fetch = { at: (i) => [urls.at(i)] };
  const view = withViews(page);
  await settle();
  view("year");
  await settle();
  const click = async (id) => {
    const button = page.document.getElementById(id);
    await button.listeners.click[0]({ currentTarget: button });
  };
  await click("prevWeek");
  assert.equal(page.calls.fetch.at(-1)[0], "/api/team?year=2024");
  await click("nextWeek");
  assert.equal(page.calls.fetch.at(-1)[0], "/api/team?year=2026");
  await click("refreshBtn");
  assert.equal(page.calls.fetch.at(-2)[0], "/api/team?year=2025&fresh");
  assert.equal(page.calls.fetch.at(-1)[0], "/api/team?fixes&fresh");
  await click("thisWeek");
  assert.equal(page.calls.fetch.at(-1)[0], `/api/team?year=${new Date().getFullYear()}`);
  page.run(`team.year = "${new Date().getFullYear()}"`);
  view("week");
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  assert.equal(page.calls.fetch.at(-1)[0], `/api/team?week=${iso}`);
});

const withDisplay = (page) => {
  const seg = page.document.getElementById("displaySeg");
  for (const key of ["table", "charts"]) {
    const button = page.document.createElement("button");
    button.dataset.display = key;
    seg.appendChild(button);
  }
  return (key) =>
    seg.listeners.click[0]({ target: { closest: () => seg.children.find((b) => b.dataset.display === key) } });
};

test("the charts tab shows each person's balance and incidents per period, in every view", async () => {
  const urls = [];
  const page = load({ entry: "team.js", fetchImpl: byPeriod(urls) });
  const display = withDisplay(page);
  const view = withViews(page);
  const pick = withFilters(page);
  await settle();
  pick("all");
  page.run(
    "team.data.employees.forEach((e, i) => { e.balance = [-8, 0.5, null, 6.5][i]; e.flagged_days = i === 3 ? 2 : 0; })",
  );
  display("charts");
  const doc = page.document;
  assert.equal(doc.getElementById("gridCard").classList.contains("hidden"), true);
  assert.equal(doc.getElementById("charts").classList.contains("hidden"), false);
  const [people, timeline] = doc.getElementById("charts").children;
  assert.deepEqual(
    page.run(`divergingBars([{ label: "a", value: -4, rows: [] }, { label: "b", value: 40, suspect: true, rows: [] }], String)
    .children.filter(c => c.tagName === "G").map(g => g.children[2].getAttribute("width"))`),
    ["355", "355"],
  );
  const bars = people.children.at(-2);
  assert.deepEqual(svgTexts(bars), ["Zoe", "−8h", "Álvaro", "+30m", "Bruno", "⚠ +6h 30m"]);
  assert.equal(
    people.children.at(-1).textContent,
    "⚠ Saldo no fiable: incluye errores de fichaje, que se corrigen antes de juzgar sus horas.",
  );
  assert.deepEqual(svgTexts(timeline.children.at(-1)).map(String), ["0", "1", "Lun", "1", "Mar", "Mié", "Jue", "Vie"]);
  const marks = bars.children.filter((c) => c.tagName === "G");
  assert.equal(marks.length, 3);
  assert.equal(marks[0].children[2].getAttribute("class"), "bar short");
  assert.equal(marks[1].children[2].getAttribute("class"), "bar surplus");
  assert.equal(marks[2].children[2].getAttribute("class"), "bar error");
  marks[0].listeners.click[0]();
  marks[1].listeners.keydown[0]({ key: "Enter" });
  marks[1].listeners.keydown[0]({ key: "Tab" });
  assert.deepEqual(page.calls.assigned, ["/empleado?id=3", "/empleado?id=1"]);
  assert.deepEqual(hover(page, marks[0]), ["Zoe", "Fichadas 40h", "Previstas 40h", "Saldo Faltan 8h"]);
  page.run(
    'team.data = { ...team.data, stop: "2999-01-01" }; team.data.employees.forEach(e => { e.due = 32; }); render()',
  );
  const runningBars = doc
    .getElementById("charts")
    .children[0].children.at(-2)
    .children.filter((c) => c.tagName === "G");
  assert.deepEqual(hover(page, runningBars[0]), ["Zoe", "Fichadas 24h", "Previstas 32h", "Saldo Faltan 8h"]);
  page.run('team.data = { ...team.data, stop: "2025-03-10" }; render()');
  const columns = timeline.children.at(-1).children.filter((c) => c.tagName === "G");
  assert.equal(columns.length, 5);
  assert.deepEqual(hover(page, columns[1]), [`Mar 4 mar${Y25}`, "Personas con errores de fichaje 1", "Álvaro"]);
  display("table");
  assert.equal(doc.getElementById("gridCard").classList.contains("hidden"), false);
  display("charts");
  view("month");
  await settle();
  const month = doc.getElementById("charts").children;
  assert.equal(month[1].children[2].className, "legend-row");
  const weeks = month[1].children.at(-1).children.filter((c) => c.tagName === "G");
  assert.equal(weeks.length, 2);
  assert.deepEqual(hover(page, weeks[0]), [
    "3 mar – 9 mar",
    "Bajo objetivo 1",
    "Álvaro",
    "Demasiadas horas 1",
    "Bruno",
  ]);
  weeks[0].listeners.pointerenter[0]({ clientX: 10, clientY: 10 });
  const tipKids = page.document.getElementById("tip").children;
  assert.deepEqual(
    tipKids.map((c) => c.className),
    ["t-title", "t-row", "t-note t-name", "t-sep", "t-row", "t-note t-name"],
  );
  assert.deepEqual(
    tipKids.filter((c) => c.className === "t-row").map((r) => r.children[0].children[0].className),
    ["swatch short", "swatch over"],
  );
  weeks[0].listeners.pointerleave[0]();
  view("year");
  await settle();
  const year = doc.getElementById("charts").children;
  assert.equal(year[1].children.at(-1).children.filter((c) => c.tagName === "G").length, 12);
  page.run(
    "team.data = { ...team.data, employees: team.data.employees.map(e => ({ ...e, balance: null })) }; render()",
  );
  assert.equal(doc.getElementById("charts").children[0].children.at(-1).textContent, "Nadie con jornada prevista");
  doc.getElementById("displaySeg").listeners.click[0]({ target: { closest: () => null } });
  doc.getElementById("charts").replaceChildren();
  page.calls.window.resize[0]();
  assert.equal(doc.getElementById("charts").children.length, 2);
  page.run("team.data = null");
  page.calls.window.resize[0]();
  display("table");
});

test("the management page keeps its view in the URL and in the session, and restores it", async () => {
  const urls = [];
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const page = load({
    entry: "team.js",
    fetchImpl: byPeriod(urls),
    path: "/gestion#v=month&p=2025-03&f=all&d=charts&k=open,bogus,off&q=zo",
    storage,
  });
  await settle();
  assert.equal(urls[0], "/api/team?month=2025-03");
  assert.deepEqual(page.run("[team.view, team.filter, team.display, team.search]"), ["month", "all", "charts", "zo"]);
  assert.deepEqual(page.run("[...team.fixKinds]"), ["open"]);
  assert.equal(page.calls.hash, "#v=month&p=2025-03&f=all&d=charts&k=open&q=zo");
  assert.equal(store.get("gestion"), "#v=month&p=2025-03&f=all&d=charts&k=open&q=zo");
  const again = load({ entry: "team.js", fetchImpl: byPeriod([]), path: "/gestion", storage });
  assert.equal(again.run("team.view"), "month");
  const bogus = load({ entry: "team.js", fetchImpl: byPeriod([]), path: "/gestion#v=nope&f=nope&d=nope" });
  assert.deepEqual(bogus.run("[team.view, team.filter, team.display, team.search]"), ["week", "issues", "table", ""]);
  const broken = {
    getItem: () => {
      throw new Error("bloqueado");
    },
    setItem: () => {
      throw new Error("bloqueado");
    },
  };
  const blocked = load({ entry: "team.js", fetchImpl: byPeriod([]), path: "/gestion", storage: broken });
  await settle();
  assert.equal(blocked.run("team.view"), "week");
});

test("each step into a period is a history entry, and going back reloads the one before", async () => {
  const urls = [];
  const page = load({ entry: "team.js", fetchImpl: byPeriod(urls), path: "/gestion#v=year&p=2025&f=all&d=table" });
  await settle();
  assert.equal(urls[0], "/api/team?year=2025");
  page.document.getElementById("grid").children[1].children[0].children[3].listeners.click[0]();
  await settle();
  assert.equal(page.calls.pushed.length, 1);
  assert.match(page.calls.pushed[0], /^#v=month&p=2025-03&f=all&d=table&k=.*&q=%C3%81lvaro$/);
  page.document
    .getElementById("prevWeek")
    .listeners.click[0]({ currentTarget: page.document.getElementById("prevWeek") });
  await settle();
  assert.ok(urls.includes("/api/team?month=2025-02"));
  assert.equal(page.calls.pushed.length, 2);
  page.run('location.hash = "#v=year&p=2025&f=all&d=table"');
  page.calls.window.popstate[0]();
  await settle();
  assert.equal(urls.at(-1), "/api/team?year=2025");
  assert.deepEqual(page.run("[team.view, team.search, document.getElementById('search').value]"), ["year", "", ""]);
  assert.equal(page.calls.pushed.length, 2);
});

test("the table shows even when the list of fixes fails, which says why", async () => {
  const page = load({
    entry: "team.js",
    fetchImpl: async (url) =>
      url.includes("fixes")
        ? { ok: false, status: 502, json: async () => ({ error: "Odoo no responde" }) }
        : { ok: true, status: 200, json: async () => teamPayload() },
  });
  await settle();
  assert.equal(page.document.getElementById("gridCard").classList.contains("hidden"), false);
  assert.equal(
    page.document.getElementById("fixesNote").textContent,
    "No se pudieron cargar los fichajes por corregir: Odoo no responde",
  );
});

test("a refused or failed load says why", async () => {
  const page = load({
    entry: "team.js",
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "Tu usuario de Odoo no ve fichajes de otras personas" }),
    }),
  });
  await settle();
  const msg = page.document.getElementById("loadmsg");
  assert.equal(msg.textContent, "Error cargando datos de Odoo: Tu usuario de Odoo no ve fichajes de otras personas");
  assert.equal(msg.classList.contains("hidden"), false);
});

test("the table pans by dragging, and a drag does not open the cell it ends on", async () => {
  const page = load({ entry: "team.js", data: teamPayload() });
  withFilters(page)("all");
  await settle();
  const doc = page.document;
  const scroller = doc.getElementById("gridScroll");
  const on = (type) => scroller.listeners[type][0];
  const cell = doc.getElementById("grid").children[1].children[0].children[1];
  scroller.scrollLeft = 200;
  scroller.scrollTop = 100;
  on("pointerdown")({ button: 0, pointerType: "touch", target: { closest: () => null }, clientX: 300, clientY: 0 });
  on("pointermove")({ clientX: 250, clientY: 0 });
  assert.deepEqual([scroller.scrollLeft, scroller.scrollTop], [200, 100]);
  on("pointerdown")({
    button: 0,
    pointerType: "mouse",
    target: { closest: () => null },
    clientX: 300,
    clientY: 300,
    pointerId: 1,
  });
  on("pointermove")({ clientX: 302, clientY: 298 });
  assert.deepEqual([scroller.scrollLeft, scroller.scrollTop], [200, 100]);
  on("pointermove")({ clientX: 250, clientY: 260 });
  on("pointerup")();
  assert.deepEqual([scroller.scrollLeft, scroller.scrollTop], [250, 140]);
  cell.listeners.click[0]();
  assert.equal(doc.getElementById("dayDialog").open, false);
  cell.listeners.click[0]();
  assert.equal(doc.getElementById("dayDialog").open, true);
});

test("the management cells, charts and controls in their other cases", async () => {
  const page = load({ entry: "team.js", data: teamPayload() });
  await settle();
  const doc = page.document;
  const probe = (code) => {
    page.run(`document.getElementById("probe").replaceChildren(${code})`);
    return doc.getElementById("probe").children[0];
  };
  const limits = "{ long_day: 12, under_margin: 1 / 60, over_margin: 5 }";
  const day = (date, extra = "") =>
    `{ date: "${date}", hours: 0, target: 8, absence: null, sessions: [], flags: [], requests: [] ${extra} }`;
  assert.equal(probe(`dayCell({}, ${day("2099-01-01")}, "2026-01-01", ${limits})`).classList.contains("future"), true);
  const days = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08"];
  const week = `{ monday: "2026-03-02", hours: 0, target: null, balance: null, flags: [] }`;
  const employee = `{ id: 1, name: "Ana", weeks: [${week}], days: [${days.map((d, i) => day(d, i < 2 ? ', flags: ["empty"]' : "")).join(",")}] }`;
  const cell = probe(`weekCell(${employee}, 0, "2026-03-04", ${limits})`);
  assert.equal(cell.classList.contains("today"), true);
  assert.ok(cell.children.some((c) => c.textContent === "2 días con errores de fichaje"));
  assert.deepEqual(hover(page, cell), ["Saldo de la semana, día a día", "Ningún día cerrado con jornada prevista"]);
  const month = probe(
    `monthCell({ hours: 10, target: 20, balance: -10, weeks: [] }, { stop: "2026-04-01", limits: ${limits} }, "2026-05-01")`,
  );
  assert.deepEqual(hover(page, month).slice(-1), ["Solo los días del mes −10h"]);
  const running = probe(
    `monthCell({ hours: 10, target: 20, balance: -10, weeks: [] }, { stop: "2026-04-01", limits: ${limits} }, "2026-03-15")`,
  );
  assert.deepEqual(hover(page, running).slice(-1), ["Días del mes hasta ayer −10h"]);
  const yearMonth = (m, year = -5) =>
    probe(
      `yearMonthCell({ balance: ${year} }, { month: "2026-01", hours: 1, target: 1, under: 0, over: 0, flagged_days: 0, ${m} }, "2026-06-01", ${limits})`,
    );
  assert.equal(yearMonth("balance: -2").classList.contains("bad"), true);
  assert.equal(yearMonth("balance: -2", 3).classList.contains("bad"), false);
  assert.equal(yearMonth("balance: -2, flagged_days: 1").classList.contains("bad"), false);
  const over = yearMonth("balance: 6, over: 1", 6);
  assert.deepEqual([over.classList.contains("bad"), over.children.at(-1).className], [true, "flag"]);
  assert.equal(yearMonth("balance: 6, over: 1", 2).children.at(-1).className, "meta block");
  assert.deepEqual(
    ["bad", "warn"].map((c) => yearMonth("balance: 0").classList.contains(c)),
    [false, false],
  );
  assert.equal(yearMonth("balance: 0, flagged_days: 2").classList.contains("warn"), true);
  assert.equal(page.run(`team.year = "2020"; Views.year.anchor()`), "2020-01-01");
  assert.equal(page.run(`team.year = thisDay().slice(0, 4); Views.year.anchor()`), page.run("thisDay()"));
  assert.match(page.run(`team.week = null; team.view = "week"; stateHash()`), /^#v=week&p=&/);
  page.run(`team.fixes = { ...team.fixes, employees: [{ id: 5, name: "Uno", items: [
    { date: "2025-03-04", kind: "long", hours: 13, target: 8, sessions: [{ in: "2025-03-04T08:00:00", out: "2025-03-04T21:00:00", hours: 13 }] }] }] }; renderFixes()`);
  const chips = () =>
    doc
      .getElementById("fixes")
      .children[0].children.flatMap((c) => c.children || [])
      .map((k) => k.textContent);
  assert.ok(chips().includes("1 jornada muy larga · 13h"));
  page.run(
    "team.fixes.employees[0].items.push({ ...team.fixes.employees[0].items[0], date: '2025-03-05' }); renderFixes()",
  );
  assert.ok(chips().includes("2 jornadas muy largas · 26h"));
  page.run(`team.view = "month"; periods({ employees: [] }, [], "2026-01-01")`);
  page.run(`team.view = "week"; renderCharts({ ...team.data, stop: "2000-01-01" }, team.data.employees, "2026-01-01")`);
  assert.doesNotMatch(doc.getElementById("charts").children[0].children[1].textContent, /hasta ayer/);
  page.run(`renderCharts({ ...team.data, stop: "2999-01-01" }, team.data.employees, "2026-01-01")`);
  assert.match(doc.getElementById("charts").children[0].children[1].textContent, /hasta ayer: hoy aún no cuenta/);
  const columns = probe(
    `groupedColumns([{ label: "L", values: { a: 1 } }], [{ key: "a", label: "Serie", cls: "error" }])`,
  );
  assert.deepEqual(
    hover(
      page,
      columns.children.find((c) => c.tagName === "G"),
    ),
    ["L", "Serie 1"],
  );
  const views = doc.getElementById("viewSeg");
  page.run("team.data = null");
  const monthButton = doc.createElement("button");
  monthButton.dataset.view = "month";
  views.listeners.click[0]({ target: { closest: () => monthButton } });
  await settle();
  assert.equal(page.run("team.view"), "month");
  const scroller = doc.getElementById("fixes");
  const captured = [];
  scroller.setPointerCapture = (id) => captured.push(id);
  scroller.listeners.pointerdown[0]({
    button: 0,
    target: { closest: () => null },
    clientX: 5,
    clientY: 0,
    pointerId: 7,
  });
  assert.deepEqual(captured, []);
  scroller.listeners.pointermove[0]({ clientX: 50, clientY: 0 });
  assert.deepEqual(captured, [7]);
  scroller.listeners.pointerup[0]();
});

test("the name search ignores case and accents, reaches every list and is kept in the URL", async () => {
  const data = teamPayload();
  const page = load({ entry: "team.js", data, path: "/gestion#f=all&q=ZO" });
  const pick = withFilters(page);
  await settle();
  const doc = page.document;
  const names = () => doc.getElementById("grid").children[1].children.map(rowName);
  const fixed = () =>
    doc
      .getElementById("fixes")
      .children[0].children.filter((c) => c.tagName === "A")
      .map((a) => a.textContent);
  assert.equal(doc.getElementById("search").value, "ZO");
  assert.deepEqual(names(), ["Zoe"]);
  assert.deepEqual(fixed(), ["Zoe"]);
  const search = doc.getElementById("search");
  search.listeners.input[0]({ target: { value: "BRÚNO" } });
  assert.deepEqual([names(), fixed()], [["Bruno"], ["Bruno"]]);
  search.listeners.input[0]({ target: { value: "alvaro" } });
  assert.deepEqual(names(), ["Álvaro"]);
  assert.match(page.calls.hash, /q=alvaro/);
  search.listeners.input[0]({ target: { value: "  nadie  " } });
  assert.equal(names()[0], "Nadie cuyo nombre contenga «nadie»");
  assert.deepEqual(fixed(), []);
  assert.match(
    doc.getElementById("fixesNote").textContent,
    /Nadie cuyo nombre contenga «nadie» con los tipos elegidos\.$/,
  );
  assert.equal(doc.getElementById("openCard").classList.contains("hidden"), false);
  search.listeners.input[0]({ target: { value: "" } });
  assert.deepEqual(names(), ["Álvaro", "Ana", "Bruno", "Zoe"]);
  pick("issues");
  page.run("team.data = null");
  search.listeners.input[0]({ target: { value: "zo" } });
  assert.deepEqual([page.run("team.search"), fixed()], ["zo", ["Zoe"]]);
  page.run("team.fixes = null");
  search.listeners.input[0]({ target: { value: "" } });
});
