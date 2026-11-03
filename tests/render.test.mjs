// render.js, the personal page below the hero: the KPI tiles, the weekly chart, the week card in both views, the
// table and the banner of punches to fix. Weeks and days are built here by hand, so each branch is reached by the
// numbers that decide it, and what is drawn is read back as a sketch of the nodes: tag, classes, attributes, text.

import assert from "node:assert/strict";
import test from "node:test";
import { at, withData } from "./page.mjs";

const decimals = (text) => text.replace(/\d+\.\d{3,}/g, (n) => String(Math.round(Number(n) * 100) / 100));

function sketch(node) {
  if (typeof node === "string") return JSON.stringify(node);
  const cls = node.className || node.attrs.class || "";
  const attrs = Object.entries(node.attrs)
    .filter(([key]) => key !== "class")
    .map(([key, value]) => `${key}=${value}`);
  if (node.title) attrs.push(`title=${node.title}`);
  if (node.type) attrs.push(`type=${node.type}`);
  if (node.tabIndex === 0) attrs.push("tab");
  if (node.disabled) attrs.push("disabled");
  for (const [key, value] of Object.entries(node.dataset)) attrs.push(`data-${key}=${value}`);
  for (const [key, value] of Object.entries(node.style))
    if (typeof value !== "function") attrs.push(`style.${key}=${value}`);
  const kids = node.children.map(sketch);
  return decimals(
    node.tagName.toLowerCase() +
      (cls ? `.${cls.split(" ").join(".")}` : "") +
      (attrs.length ? `[${attrs.join(" ")}]` : "") +
      (node.textContent ? ` ${JSON.stringify(node.textContent)}` : "") +
      (kids.length ? `(${kids.join(", ")})` : ""),
  );
}

const serialized = (value) =>
  JSON.stringify(value, function (key, item) {
    return this[key] instanceof Date ? { $d: this[key].getTime() } : item;
  });

function put(page, name, value) {
  page.run(
    `globalThis.${name} = JSON.parse(${JSON.stringify(serialized(value))}, (k, v) => (v && v.$d !== undefined ? new Date(v.$d) : v)); 0`,
  );
}

const MONDAY = 7;
const day = (i, extra = {}, first = MONDAY) => ({
  date: new Date(2026, 8, first + i),
  auto: null,
  vacation: false,
  leaves: [],
  scheduled: i < 5 ? 8 : 0,
  expected: i < 5 ? 8 : 0,
  hours: 0,
  rest: 0,
  sessions: [],
  ...extra,
});
const week = (extra = {}, first = MONDAY) => {
  const days = extra.days ?? Array.from({ length: 7 }, (_, i) => day(i, {}, first));
  return {
    monday: days[0].date,
    sunday: days[6].date,
    days,
    total: 0,
    rest: 0,
    target: 40,
    delta: 0,
    current: false,
    complete: true,
    allVacation: false,
    suspect: false,
    missedDays: 0,
    openDays: 0,
    error: false,
    ...extra,
  };
};
const punched = (from, to, rest = false, first = MONDAY) => {
  const [h1, m1, s1 = 0] = from;
  const [h2, m2, s2 = 0] = to;
  const start = new Date(2026, 8, first, h1, m1, s1);
  const end = new Date(2026, 8, first, h2, m2, s2);
  return { in: start, out: end, hours: (end - start) / 3.6e6, rest };
};

const page = () => withData([], { long_hours: 12 });
const kpis = (p) => p.document.getElementById("kpis").children.map(sketch);
const tipOf = (p, node) => {
  node.listeners.pointerenter[0]({ clientX: 10, clientY: 10 });
  const rows = p.document.getElementById("tip").children.map(sketch);
  node.listeners.pointerleave[0]();
  return rows;
};

/* ---------- KPIs ---------- */

test("the average and the balance count only the finished weeks, the average only those with a target", () => {
  const p = page();
  const worked = (total, target, delta, extra = {}) => week({ total, target, delta, ...extra });
  put(p, "ws", [
    worked(40, 40, 0),
    worked(30, 40, -10),
    worked(0, 0, 0, { allVacation: true }),
    worked(10, 40, -30, { complete: false, current: true }),
  ]);
  p.run("renderKpis(ws)");
  assert.deepEqual(kpis(p), [
    'div.card(span.label "Media semanal", div.value.num "35h", div.foot "2 semanas laborables completas")',
    'div.card(span.label "Balance frente al objetivo", div.value.num.down "−10h", div.foot "acumulado en contra")',
  ]);
});

test("the balance tile reads in favour at zero and turns red from a minute short", () => {
  const p = page();
  const balance = (delta) => {
    put(p, "ws", [week({ total: 8, target: 8, delta })]);
    p.run("renderKpis(ws)");
    return kpis(p)[1];
  };
  assert.equal(
    balance(0),
    'div.card(span.label "Balance frente al objetivo", div.value.num "+0h", div.foot "acumulado a favor")',
  );
  assert.equal(
    balance(-1 / 60),
    'div.card(span.label "Balance frente al objetivo", div.value.num.down "−1m", div.foot "acumulado en contra")',
  );
  assert.equal(
    balance(-1 / 120),
    'div.card(span.label "Balance frente al objetivo", div.value.num "−1m", div.foot "acumulado en contra")',
  );
  assert.equal(
    balance(0.5),
    'div.card(span.label "Balance frente al objetivo", div.value.num "+30m", div.foot "acumulado a favor")',
  );
});

test("a week with a punch error makes the tiles unreliable, and names how many", () => {
  const p = page();
  const worked = (error) => week({ total: 40, target: 40, error });
  put(p, "ws", [worked(true), worked(false), week({ total: 0, target: 0, allVacation: true, error: true })]);
  p.run("renderKpis(ws)");
  const note = (n) =>
    `div.foot.warn "⚠ No fiable: ${n} con fichajes incorrectos (jornadas muy largas, entradas sin cerrar o días sin fichar)"`;
  assert.deepEqual(kpis(p), [
    `div.card(span.label "Media semanal", div.value.num.warn "40h", div.foot "2 semanas laborables completas", ${note("1 semana")})`,
    `div.card(span.label "Balance frente al objetivo", div.value.num.warn "+0h", div.foot "acumulado a favor", ${note("2 semanas")})`,
  ]);
});

test("a single finished week with a target is told in the singular", () => {
  const p = page();
  put(p, "ws", [week({ total: 40, target: 40 })]);
  p.run("renderKpis(ws)");
  assert.equal(
    kpis(p)[0],
    'div.card(span.label "Media semanal", div.value.num "40h", div.foot "1 semana laborable completa")',
  );
});

test("without a finished week with a target the average reads a dash, and without any there are no tiles", () => {
  const p = page();
  put(p, "ws", [week({ total: 0, target: 0, allVacation: true }), week({ total: 3, complete: false })]);
  p.run("renderKpis(ws)");
  assert.deepEqual(kpis(p), [
    'div.card(span.label "Media semanal", div.value.num "—", div.foot "0 semanas laborables completas")',
    'div.card(span.label "Balance frente al objetivo", div.value.num "+0h", div.foot "acumulado a favor")',
  ]);
  put(p, "ws", [week({ complete: false })]);
  p.run("renderKpis(ws)");
  assert.deepEqual(kpis(p), []);
});

test("the usual hours get a tile per length of day, the longest first, and a single one when there is one", () => {
  const p = page();
  const worked = (i, scheduled, from, to) =>
    day(i, { scheduled, hours: 5, sessions: [punched(from, to, false, MONDAY + i)] });
  put(p, "ws", [
    week({
      days: [
        worked(0, 6, [8, 0], [14, 0]),
        worked(1, 8.5, [9, 0], [18, 0]),
        worked(2, 8, [8, 30], [16, 30]),
        worked(3, 8.5, [9, 30], [18, 30]),
        day(4, { scheduled: 0, hours: 5, sessions: [punched([7, 0], [12, 0], false, MONDAY + 4)] }),
        day(5),
        day(6),
      ],
    }),
  ]);
  p.run("renderKpis(ws)");
  assert.deepEqual(
    kpis(p)
      .slice(2)
      .map((tile) => tile.replace(/^div\.card\(/, "")),
    [
      'span.label "Horario habitual · jornada de 8h 30m", div.value.num "09:15 – 18:15", div.foot "entrada y salida medias · 2 días")',
      'span.label "Horario habitual · jornada de 8h", div.value.num "08:30 – 16:30", div.foot "entrada y salida medias · 1 día")',
      'span.label "Horario habitual · jornada de 6h", div.value.num "08:00 – 14:00", div.foot "entrada y salida medias · 1 día")',
    ],
  );
  put(p, "ws", [
    week({
      days: [worked(0, 8, [9, 0], [17, 0]), worked(1, 8, [10, 0], [18, 0]), ...[2, 3, 4, 5, 6].map((i) => day(i))],
    }),
  ]);
  p.run("renderKpis(ws)");
  assert.deepEqual(
    kpis(p)
      .slice(2)
      .map((tile) => tile.replace(/^div\.card\(/, "")),
    ['span.label "Horario habitual", div.value.num "09:30 – 17:30", div.foot "entrada y salida medias · 2 días")'],
  );
});

/* ---------- the weekly chart ---------- */

const chart = (p) => p.document.getElementById("overviewChart").children[0];

test("the chart draws its grid, axis, columns, target marks and labels at their scale", () => {
  const p = page();
  const sunday = (first) => new Date(2026, 8, first + 6);
  put(p, "ws", [
    week({ total: 50, rest: 8, delta: 10 }),
    week({ total: 1, target: 24, delta: -23, current: true, complete: false, error: true }, 14),
    week({ total: 0.01, rest: 0.01, target: 0 }, 21),
    week({ total: 0.5, rest: 0.05, delta: -39.5, error: true }, 28),
  ]);
  assert.equal(sunday(7).getDate(), 13);
  p.run("renderOverview(ws)");
  const svg = chart(p);
  assert.equal(
    sketch(svg).split("(")[0],
    "svg[viewBox=0 0 940 250 role=img aria-label=Horas totales por semana frente al objetivo de 40h]",
  );
  assert.deepEqual(svg.children.map(sketch), [
    "line.gridline[x1=34 x2=856 y1=177.15 y2=177.15]",
    'text.ticklabel[x=26 y=181.15 text-anchor=end] "10"',
    "line.gridline[x1=34 x2=856 y1=138.31 y2=138.31]",
    'text.ticklabel[x=26 y=142.31 text-anchor=end] "20"',
    "line.gridline[x1=34 x2=856 y1=99.46 y2=99.46]",
    'text.ticklabel[x=26 y=103.46 text-anchor=end] "30"',
    'text.ticklabel[x=26 y=64.62 text-anchor=end] "40"',
    "line.gridline[x1=34 x2=856 y1=21.77 y2=21.77]",
    'text.ticklabel[x=26 y=25.77 text-anchor=end] "50"',
    "line.axisline[x1=34 x2=856 y1=216 y2=216]",
    "g.col[tabindex=0 aria-label=Semana del 7–13 sep: 50h](path.bar[d=M 124.75 216 L 124.75 25.77 Q 124.75 21.77 128.75 21.77 L 144.75 21.77 Q 148.75 21.77 148.75 25.77 L 148.75 216 Z], rect.rest[x=124.75 y=184.92 width=24 height=31.08], rect.hit[x=34 y=14 width=205.5 height=202])",
    'text.xlabel[x=136.75 y=234 text-anchor=middle] "7 sep"',
    "line.targettick[x1=325.25 x2=359.25 y1=122.77 y2=122.77]",
    "g.col.inprogress.error[tabindex=0 aria-label=Semana del 14–20 sep: 1h](path.bar[d=M 330.25 216 L 330.25 214.06 Q 330.25 212.12 332.19 212.12 L 352.31 212.12 Q 354.25 212.12 354.25 214.06 L 354.25 216 Z], rect.err-mark[x=330.25 y=218 width=24 height=1.5], rect.hit[x=239.5 y=14 width=205.5 height=202])",
    'text.xlabel[x=342.25 y=234 text-anchor=middle] "14 sep"',
    'text.inprogress-label[x=342.25 y=247 text-anchor=middle] "en curso"',
    "g.col[tabindex=0 aria-label=Semana del 21–27 sep: 1m](rect.hit[x=445 y=14 width=205.5 height=202])",
    'text.xlabel[x=547.75 y=234 text-anchor=middle] "21 sep"',
    "g.col.error[tabindex=0 aria-label=Semana del 28 sep – 4 oct: 30m](path.bar[d=M 741.25 216 L 741.25 215.03 Q 741.25 214.06 742.22 214.06 L 764.28 214.06 Q 765.25 214.06 765.25 215.03 L 765.25 216 Z], rect.rest[x=741.25 y=213 width=24 height=3], rect.err-mark[x=741.25 y=218 width=24 height=1.5], rect.hit[x=650.5 y=14 width=205.5 height=202])",
    'text.xlabel[x=753.25 y=234 text-anchor=middle] "28 sep"',
    "line.targetline[x1=34 x2=856 y1=60.62 y2=60.62]",
    'text.targetlabel[x=864 y=64.62] "Objetivo 40h"',
  ]);
  assert.equal(p.document.getElementById("overviewTitle").textContent, "Total semanal frente al objetivo de 40h");
});

test("the chart's caption mentions adjusted targets only when a week with a target has one", () => {
  const p = page();
  const caption = (...targets) => {
    put(
      p,
      "ws",
      targets.map((target) => week({ target })),
    );
    p.run("renderOverview(ws)");
    return p.document.getElementById("overviewCaption").textContent;
  };
  const base =
    "Cada columna es una semana; la actual, en azul claro; abajo, en morado, el descanso fichado; en naranja, " +
    "las semanas con un error de fichaje (una jornada muy larga, una entrada sin cerrar o un día sin fichar). " +
    "Pulsa una para verla arriba.";
  const adjusted = " Las semanas con ausencias o permisos llevan su objetivo ajustado como marca horizontal.";
  assert.equal(caption(40, 40), base);
  assert.equal(caption(40, 0), base);
  assert.equal(caption(24), base + adjusted);
  assert.equal(caption(40, 24, 40), base + adjusted);
  assert.equal(caption(40, 0, 24), base + adjusted);
});

test("a long history widens the chart, a short one leaves it at its base width", () => {
  const p = page();
  const monday = (i) => new Date(2026, 8, MONDAY + 7 * i);
  const weeks = (n) =>
    Array.from({ length: n }, (_, i) =>
      week({ monday: monday(i), sunday: new Date(2026, 8, MONDAY + 7 * i + 6), total: 10 }),
    );
  put(p, "ws", weeks(12));
  p.run("renderOverview(ws)");
  assert.equal(sketch(chart(p)).split("(")[0].slice(0, 28), "svg[viewBox=0 0 940 250 role");
  assert.equal(chart(p).style.width, undefined);
  assert.equal(chart(p).style.height, undefined);
  put(p, "ws", weeks(30));
  p.run("renderOverview(ws)");
  const svg = chart(p);
  assert.equal(svg.attrs.viewBox, "0 0 1258 250");
  assert.deepEqual([svg.style.width, svg.style.height], ["1258px", "250px"]);
  const bar = svg.children.find((n) => n.tagName === "G").children[0];
  assert.equal(
    decimals(bar.attrs.d),
    "M 42.55 216 L 42.55 174.09 Q 42.55 170.09 46.55 170.09 L 59.45 170.09 Q 63.45 170.09 63.45 174.09 L 63.45 216 Z",
  );
  const hits = svg.children.filter((n) => n.tagName === "G").map((g) => g.children.at(-1).attrs);
  assert.deepEqual([hits[0].x, hits[1].x, hits[29].x, hits[0].width], ["34", "72", "1136", "38"]);
  assert.equal(svg.children.find((n) => n.attrs.class === "targetlabel").attrs.x, "1182");
});

test("the chart's grid keeps about six lines however tall the tallest week, leaving out suspect ones", () => {
  const p = page();
  put(p, "ws", [week({ total: 116.5 }), week({ total: 230, suspect: true }, 14)]);
  p.run("renderOverview(ws)");
  const svg = chart(p);
  const labels = svg.children.filter((n) => n.attrs.class === "ticklabel").map((n) => n.textContent);
  assert.deepEqual(labels, ["20", "40", "60", "80", "100", "120"]);
  const lines = svg.children.filter((n) => n.attrs.class === "gridline").map((n) => n.attrs.y1);
  assert.deepEqual(lines.map(Number).map(Math.round), [182, 115, 81, 48, 14]);
});

test("a column's tooltip tells the week's total, its target, its errors and where it stands", () => {
  const p = page();
  const partial = { complete: false, current: true };
  put(p, "ws", [
    week({ total: 20, target: 40, delta: -20, ...partial, suspect: true, missedDays: 2, openDays: 1 }),
    week({ total: 37, delta: -3, error: true, rest: 1 }, 14),
    week({ total: 38, delta: -2 }, 21),
    week({ total: 42, delta: 2 }, 28),
    week({ total: 0.005, target: 0, delta: 0, allVacation: true }, 35),
    week({ total: 0.01, target: 0, delta: -40, allVacation: true }, 42),
    week({ total: 5, target: 0, delta: 5, allVacation: true }, 49),
    week({ total: 40, delta: 0, complete: true }, 56),
    week({ total: 30, rest: 0.01, delta: -10, error: true, missedDays: 1 }, 63),
  ]);
  p.run("rangeShort = true; renderOverview(ws)");
  const cols = chart(p).children.filter((n) => n.tagName === "G");
  const row = (k, v, color = "") =>
    `div.t-row(span.k ${JSON.stringify(k)}, span.v${color ? `.${color}` : ""} ${JSON.stringify(v)})`;
  const note = (text) => `div.t-note.warn ${JSON.stringify(text)}`;
  const title = (text) => `div.t-title ${JSON.stringify(text)}`;
  assert.deepEqual(
    cols.map((col) => tipOf(p, col)),
    [
      [
        title("Semana del 7–13 sep · en curso"),
        row("Total", "20h"),
        note("Incluye una jornada muy larga: suma no fiable"),
        note("2 días sin fichar"),
        note("1 día con una entrada sin cerrar"),
        row("Para el objetivo", "20h"),
      ],
      [
        title("Semana del 14–20 sep"),
        row("Total", "37h"),
        row("Trabajo", "36h"),
        row("Descanso", "1h"),
        row("Bajo objetivo", "−3h", "warn"),
      ],
      [title("Semana del 21–27 sep"), row("Total", "38h"), row("Bajo objetivo", "−2h", "down")],
      [title("Semana del 28 sep – 4 oct"), row("Total", "42h"), row("Sobre objetivo", "+2h")],
      [
        title("Semana del 5–11 oct"),
        row("Total", "0h"),
        row("Objetivo (con ausencias)", "0h"),
        row("Vacaciones", "toda la semana"),
      ],
      [
        title("Semana del 12–18 oct"),
        row("Total", "1m"),
        row("Objetivo (con ausencias)", "0h"),
        row("Bajo objetivo", "−40h", "down"),
      ],
      [
        title("Semana del 19–25 oct"),
        row("Total", "5h"),
        row("Objetivo (con ausencias)", "0h"),
        row("Sobre objetivo", "+5h"),
      ],
      [title("Semana del 26 oct – 1 nov"), row("Total", "40h"), row("Sobre objetivo", "+0h")],
      [
        title("Semana del 2–8 nov"),
        row("Total", "30h"),
        note("1 día sin fichar"),
        row("Bajo objetivo", "−10h", "warn"),
      ],
    ],
  );
});

test("a column opens its week on a click or Enter, and on no other key", () => {
  const p = page();
  put(p, "ws", [week({ total: 10 }), week({ total: 10 }, 14)]);
  p.run("renderOverview(ws)");
  const [old, recent] = chart(p).children.filter((n) => n.tagName === "G");
  const scrolled = [];
  p.document.getElementById("weekCal").scrollIntoView = (options) => scrolled.push({ ...options });
  p.run("calOffset = 5");
  old.listeners.keydown[0]({ key: "Tab" });
  recent.listeners.keydown[0]({ key: " " });
  assert.equal(p.run("calOffset"), 5);
  assert.deepEqual(scrolled, []);
  recent.listeners.keydown[0]({ key: "Enter" });
  assert.equal(p.run("calOffset"), 0);
  old.listeners.click[0]();
  assert.equal(p.run("calOffset"), 1);
  assert.deepEqual(scrolled, [
    { block: "start", behavior: "smooth" },
    { block: "start", behavior: "smooth" },
  ]);
});

test("opening a week far back stops at the oldest one the payload holds", () => {
  const p = page();
  put(p, "ws", [week({ total: 10 }, 7 - 7 * 20)]);
  p.run("renderOverview(ws)");
  chart(p)
    .children.find((n) => n.tagName === "G")
    .listeners.click[0]();
  assert.equal(p.run("calOffset"), 11);
});

test("the chart keeps where the viewer scrolled to unless they were at its end", () => {
  const p = page();
  put(p, "ws", [week({ total: 10 })]);
  const host = p.document.getElementById("overviewChart");
  const redraw = (scrollWidth, scrollLeft, clientWidth) => {
    Object.assign(host, { scrollWidth, scrollLeft, clientWidth });
    p.run("renderOverview(ws)");
    return host.scrollLeft;
  };
  assert.equal(redraw(1000, 100, 500), 100);
  assert.equal(redraw(604, 100, 500), 604);
  assert.equal(redraw(605, 100, 500), 100);
  assert.equal(redraw(1000, 500, 500), 1000);
});

test("the chart's elements are made in the SVG namespace", () => {
  const p = page();
  const made = [];
  const create = p.document.createElementNS;
  p.document.createElementNS = (ns, tag) => {
    made.push(ns);
    return create(ns, tag);
  };
  put(p, "ws", [week({ total: 10 })]);
  p.run("renderOverview(ws)");
  assert.ok(made.length > 5);
  assert.deepEqual([...new Set(made)], ["http://www.w3.org/2000/svg"]);
});

/* ---------- the week card ---------- */

const card = (p) => p.document.getElementById("weekCal");
const showing = (p, w, short = false) => {
  put(p, "W", w);
  p.run(`buildWeek = () => W; rangeShort = ${short}; renderCalendar()`);
};
const headOf = (p) => card(p).children[0];

test("the week card's hint quotes the schedule, or says there is none", () => {
  const p = page();
  const tail =
    " El descanso fichado va en morado, en el tramo en que ocurrió; en naranja, las jornadas de más de 12h en total, " +
    "las entradas sin cerrar y los días con jornada prevista sin fichar, casi siempre un fichaje olvidado. " +
    "En el horario, cada bloque es un fichaje en su hora real; los huecos entre bloques son tiempo ausente, " +
    "la comida por ejemplo, y no cuentan. " +
    "Los festivos y ausencias aprobadas se marcan solos (🏖) y no cuentan en el objetivo de su semana; " +
    "los permisos de horas (médico, etc.) restan de la jornada prevista de su día y aparecen en el horario " +
    "como bloque punteado.";
  const hint = () => p.document.getElementById("weeksHint").textContent;
  p.run("renderCalendar()");
  assert.equal(
    hint(),
    `Odoo no devuelve horario para tu calendario, así que no hay jornada prevista ni objetivo semanal.${tail}`,
  );
  p.run("store.data.schedule = { hours: store.expected, lunch_from: store.lunchFrom }; renderCalendar()");
  assert.equal(
    hint(),
    `La marca vertical de cada día es la jornada prevista en Odoo: 8h 30m de lunes a jueves, 6h los viernes.${tail}`,
  );
  const sentence = (hours) => p.run(`store.expected = ${JSON.stringify(hours)}; scheduleSentence()`);
  assert.equal(sentence([8, 8, 8, 0, 0, 0, 0]), "8h de lunes a miércoles");
  assert.equal(sentence([0, 0, 0, 0, 0, 4, 4]), "4h los sábados y domingos");
  assert.equal(sentence([0, 0, 0, 0, 0, 4, 0]), "4h los sábados");
});

test("the week card's header navigates between weeks and disables what leads nowhere", () => {
  const p = page();
  const buttons = () => headOf(p).children.filter((n) => n.tagName === "BUTTON");
  const state = (offset) => {
    p.run(`calOffset = ${offset}; renderCalendar()`);
    return buttons().map((b) => b.disabled);
  };
  assert.deepEqual(state(0), [false, true, true]);
  assert.deepEqual(state(1), [false, false, false]);
  assert.deepEqual(state(10), [false, false, false]);
  assert.deepEqual(state(11), [true, false, false]);
  p.run("calOffset = 3; renderCalendar()");
  assert.deepEqual(buttons().map(sketch), [
    'button.navbtn[aria-label=Semana anterior title=Semana anterior type=button] "‹"',
    'button.navbtn[aria-label=Semana siguiente title=Semana siguiente type=button] "›"',
    'button.todaybtn[aria-label=Ir a la semana actual title=Ir a la semana actual type=button] "Hoy"',
  ]);
  const range = () => headOf(p).children[1].textContent;
  assert.equal(range(), "Semana del 24–30 ago");
  buttons()[0].listeners.click[0]();
  assert.deepEqual([p.run("calOffset"), range()], [4, "Semana del 17–23 ago"]);
  buttons()[1].listeners.click[0]();
  buttons()[1].listeners.click[0]();
  assert.deepEqual([p.run("calOffset"), range()], [2, "Semana del 31 ago – 6 sep"]);
  buttons()[2].listeners.click[0]();
  assert.deepEqual([p.run("calOffset"), range()], [0, "Semana del 14–20 sep"]);
  assert.deepEqual([headOf(p).children[1].tagName, headOf(p).children[1].className], ["SPAN", "range"]);
  assert.deepEqual([headOf(p).tagName, headOf(p).className], ["DIV", "week-head"]);
});

test("the week card's badge says where the week stands, and its total flags a suspect sum", () => {
  const p = page();
  const badges = (props, short = false) => {
    showing(p, week({ target: 40, total: 40, delta: 0, ...props }), short);
    return headOf(p).children.slice(4).map(sketch);
  };
  const total = (text) => `span.total ${JSON.stringify(text)}`;
  assert.deepEqual(badges({ allVacation: true, total: 0, target: 0 }), ['span.badge.flat "vacaciones"', total("0h")]);
  assert.deepEqual(badges({ error: true }), ['span.badge.warn "⚠ fichaje por revisar"', total("40h")]);
  assert.deepEqual(badges({ error: true, complete: false }), [
    'span.badge.warn "⚠ en curso · fichaje por revisar"',
    total("40h"),
  ]);
  assert.deepEqual(badges({ total: 0, delta: -40 }), ['span.badge.flat "▼ −40h vs 40h"', total("0h")]);
  assert.deepEqual(badges({ complete: false, allVacation: true, total: 0, target: 0 }), [
    'span.badge.flat "▲ en curso · objetivo alcanzado"',
    total("0h"),
  ]);
  assert.deepEqual(badges({ allVacation: true, total: 0.01, target: 0, delta: 0.01 }), [
    'span.badge.flat "+1m vs 0h"',
    total("1m"),
  ]);
  assert.deepEqual(badges({ allVacation: true, total: 5, target: 0, delta: 5 }), [
    'span.badge.flat "▲ +5h vs 0h"',
    total("5h"),
  ]);
  assert.deepEqual(badges({ delta: 0 }), ['span.badge.flat "+0h vs 40h"', total("40h")]);
  assert.deepEqual(badges({ delta: 1 / 60 }), ['span.badge.flat "▲ +1m vs 40h"', total("40h")]);
  assert.deepEqual(badges({ delta: 1 / 120 }), ['span.badge.flat "+1m vs 40h"', total("40h")]);
  assert.deepEqual(badges({ delta: -1 / 120 }, true), ['span.badge.flat "−1m vs 40h"', total("40h")]);
  assert.deepEqual(badges({ delta: -1 / 60 }, true), ['span.badge.down "▼ −1m vs 40h"', total("40h")]);
  assert.deepEqual(badges({ delta: -1 / 60 }), ['span.badge.flat "▼ −1m vs 40h"', total("40h")]);
  assert.deepEqual(badges({ complete: false }), ['span.badge.flat "▲ en curso · objetivo alcanzado"', total("40h")]);
  assert.deepEqual(badges({ complete: false, total: 39.5 }), [
    'span.badge.flat "en curso · faltan 30m"',
    total("39h 30m"),
  ]);
  assert.deepEqual(badges({ suspect: true, error: true, total: 60 }), [
    'span.badge.warn "⚠ fichaje por revisar"',
    'span.total-warn "⚠ incluye una jornada muy larga"',
    'span.total.long[title=Incluye una jornada muy larga: esta suma no es fiable] "60h"',
  ]);
});

test("the week card's view switch marks the one shown and changes it on a click", () => {
  const p = page();
  showing(p, week());
  const filter = card(p).children[1];
  const filterAt = (pressed) =>
    'div.filter-row.cal-filter(span.filter-label "Mostrar", div.seg[role=group aria-label=Vista de la semana](' +
    `button[aria-pressed=${pressed === "horario"} type=button data-view=horario] "Horario", ` +
    `button[aria-pressed=${pressed === "objetivo"} type=button data-view=objetivo] "Objetivo"))`;
  assert.equal(sketch(filter), filterAt("horario"));
  filter.children[1].children[1].listeners.click[0]();
  assert.equal(p.run("calView"), "objetivo");
  assert.equal(sketch(card(p).children[1]), filterAt("objetivo"));
  card(p).children[1].children[1].children[0].listeners.click[0]();
  assert.equal(p.run("calView"), "horario");
  assert.equal(sketch(card(p).children[1]), filterAt("horario"));
});

const objective = (p, w, short = false) => {
  p.run("calView = 'objetivo'");
  showing(p, w, short);
};
const rows = (p) => card(p).children.filter((n) => (n.className || "").split(" ").includes("dayrow"));

function busyWeek() {
  const sessions = [punched([9, 0], [12, 0]), punched([12, 0], [12, 30], true), punched([13, 0], [19, 30])];
  return week({
    days: [
      day(0, {
        hours: 10,
        rest: 0.5,
        sessions,
        leaves: [
          {
            type: "Médico",
            hours: 1,
            from: new Date(2026, 8, 7, 20),
            to: new Date(2026, 8, 7, 21),
          },
        ],
      }),
      day(1, { hours: 0.01, sessions: [punched([9, 0], [9, 0, 36], false, 8)] }),
      day(2, { hours: 11, sessions: [punched([8, 0], [19, 0], false, 9)] }),
      day(3, { hours: 14, sessions: [punched([7, 0], [21, 0], false, 10)] }),
      day(4, { vacation: true, auto: "Festivo", expected: 0 }),
      day(5),
      day(6),
    ],
  });
}

test("the objective view draws a bar per day against the longest day, leaving out the long ones from the scale", () => {
  const p = page();
  objective(p, busyWeek());
  assert.deepEqual(rows(p).map(sketch), [
    'div.dayrow[tab](span.dlabel("Lun ", span.dnum "7"), div.track(div.bar[style.width=90.91%](div.rest[style.left=30% style.width=5%]), div.exp-tick[style.left=calc(72.73% - 1px)]), span.dvalue "10h", span.vacbtn)',
    'div.dayrow[tab](span.dlabel("Mar ", span.dnum "8"), div.track(div.exp-tick[style.left=calc(72.73% - 1px)]), span.dvalue "1m", span.vacbtn)',
    'div.dayrow[tab](span.dlabel("Mié ", span.dnum "9"), div.track(div.bar[style.width=100%], div.exp-tick[style.left=calc(72.73% - 1px)]), span.dvalue "11h", span.vacbtn)',
    'div.dayrow[tab](span.dlabel("Jue ", span.dnum "10"), div.track(div.bar.long[style.width=100%], div.exp-tick[style.left=calc(72.73% - 1px)]), span.dvalue.long "14h", span.vacbtn)',
    'div.dayrow.vac[tab](span.dlabel("Vie ", span.dnum "11"), div.track, span.dvalue.zero "vac.", span.vacbtn.active[title=Ausencia en Odoo: Festivo] "🏖")',
  ]);
});

test("a day's tooltip in the objective view lists its totals, absences and punches", () => {
  const p = page();
  objective(p, busyWeek());
  const line = (k, v) => `div.t-row(span.k ${JSON.stringify(k)}, span.v ${JSON.stringify(v)})`;
  const [monday, tuesday, , , friday] = rows(p);
  assert.deepEqual(tipOf(p, monday), [
    'div.t-title "Lun 7 sep"',
    line("Total", "10h"),
    line("Previsto", "8h"),
    line("Permiso · Médico", "1h"),
    line("Ausente", "30m"),
    line("Descanso", "30m"),
    "div.t-sep",
    line("09:00 – 12:00", "3h"),
    line("12:00 – 12:30 · descanso", "30m"),
    line("13:00 – 19:30", "6h 30m"),
  ]);
  assert.deepEqual(tipOf(p, tuesday), [
    'div.t-title "Mar 8 sep"',
    line("Total", "1m"),
    line("Previsto", "8h"),
    "div.t-sep",
    line("09:00 – 09:00", "1m"),
  ]);
  assert.deepEqual(tipOf(p, friday), ['div.t-title "Vie 11 sep"', line("Total", "—"), line("Ausencia", "Festivo")]);
});

test("a day without hours or sessions, and today, read as such in the objective view", () => {
  const p = page();
  objective(
    p,
    week(
      {
        days: [
          day(0, { expected: 0 }, 14),
          day(1, { sessions: [{ in: at(new Date(2026, 8, 15), 9), out: null, hours: 1, rest: false }], hours: 1 }, 14),
          day(2, { expected: 0 }, 14),
          day(3, { expected: 0 }, 14),
          day(4, { expected: 0 }, 14),
          day(5, {}, 14),
          day(6, {}, 14),
        ],
      },
      14,
    ),
  );
  const [monday, tuesday] = rows(p);
  assert.equal(monday.className, "dayrow");
  assert.equal(tuesday.className, "dayrow today");
  assert.deepEqual(tipOf(p, monday), ['div.t-title "Lun 14 sep"', 'div.t-row(span.k "Total", span.v "—")']);
  assert.equal(tipOf(p, tuesday)[0], 'div.t-title "Mar 15 sep · hoy"');
});

test("a gap or a rest of a hundredth of an hour is not told in a day's tooltip", () => {
  const p = page();
  objective(
    p,
    week({
      days: [
        day(0, {
          hours: 1,
          rest: 0.01,
          sessions: [punched([9, 0], [9, 30]), punched([9, 0, 36], [9, 30, 36], true)].map((s, i) =>
            i ? s : { ...s, out: new Date(2026, 8, 7, 9, 0) },
          ),
        }),
        ...[1, 2, 3, 4, 5, 6].map((i) => day(i)),
      ],
    }),
  );
  assert.deepEqual(tipOf(p, rows(p)[0]).slice(0, 4), [
    'div.t-title "Lun 7 sep"',
    'div.t-row(span.k "Total", span.v "1h")',
    'div.t-row(span.k "Previsto", span.v "8h")',
    "div.t-sep",
  ]);
});

test("the weekend rows appear only for a day with hours, an absence or a missed day, in both views", () => {
  const p = page();
  const weekend = (sat, sun) =>
    week({
      days: [
        ...[0, 1, 2, 3, 4].map((i) => day(i, { sessions: [punched([9, 0], [17, 0], false, 7 + i)], hours: 8 })),
        day(5, sat),
        day(6, sun),
      ],
    });
  const shown = (view, sat, sun) => {
    p.run(`calView = '${view}'`);
    showing(p, weekend(sat, sun));
    return card(p)
      .querySelectorAll(".dayrow")
      .map((row) => row.querySelectorAll(".dnum")[0].textContent)
      .slice(5);
  };
  for (const view of ["objetivo", "horario"]) {
    assert.deepEqual(shown(view, {}, {}), []);
    assert.deepEqual(shown(view, { hours: 0.01 }, {}), ["12"]);
    assert.deepEqual(shown(view, { hours: 5 }, { hours: 3 }), ["12", "13"]);
    assert.deepEqual(shown(view, { vacation: true, auto: "Festivo" }, {}), ["12"]);
    assert.deepEqual(shown(view, {}, { expected: 4 }), ["13"]);
    assert.deepEqual(shown(view, { expected: 4, sessions: [punched([9, 0], [9, 0, 30])] }, {}), []);
  }
});

const timeline = (p, w) => {
  p.run("calView = 'horario'");
  showing(p, w);
};

function splitDay() {
  const sessions = [
    punched([9, 0], [12, 0]),
    punched([12, 0], [12, 30], true),
    punched([12, 31], [14, 0]),
    punched([14, 30], [15, 0]),
    punched([15, 0, 30], [15, 30], true),
    punched([16, 0], [16, 15], true),
    punched([16, 15], [17, 0]),
  ];
  return week({
    days: [
      day(0, {
        hours: 5,
        sessions,
        leaves: [{ type: "Médico", hours: 0.5, from: new Date(2026, 8, 7, 17, 30), to: new Date(2026, 8, 7, 18) }],
      }),
      ...[1, 2, 3, 4, 5, 6].map((i) => day(i, { expected: 0 })),
    ],
  });
}

test("the timeline draws an hour axis and, per day, its grid, leaves, gaps and punches, rests on top", () => {
  const p = page();
  timeline(p, splitDay());
  const axis = card(p).children[2];
  assert.deepEqual([axis.tagName, axis.className], ["DIV", "tl-axis"]);
  assert.deepEqual(
    axis.children.map(sketch),
    Array.from({ length: 11 }, (_, i) => `span[style.left=${i * 10}%] "${8 + i}"`),
  );
  const monday = rows(p)[0];
  assert.deepEqual(
    monday.children.map((n) => sketch(n).split("(")[0]),
    ["span.dlabel", "div.track", 'span.dvalue "5h"', "span.vacbtn"],
  );
  assert.equal(monday.className, "dayrow tl-row");
  assert.equal(sketch(monday.children[0]), 'span.dlabel("Lun ", span.dnum "7")');
  assert.deepEqual(monday.children[1].children.map(sketch), [
    ...Array.from({ length: 11 }, (_, i) => `div.tl-grid[style.left=${i * 10}%]`),
    'div.leave[tab style.left=95% style.width=calc(100% - 95%)] "Médico"',
    'div.sess.join-r[tab style.left=10% style.width=calc(45% - 10%)] "09:00 – 12:00"',
    'div.sess.join-l[tab style.left=45% style.width=calc(60% - 45%)] "12:31 – 14:00"',
    'div.gap[tab style.left=60% style.width=calc(65% - 60%)] "30m"',
    'div.sess[tab style.left=65% style.width=calc(75% - 65%)] "14:30 – 15:00"',
    'div.gap[tab style.left=75% style.width=calc(80% - 75%)] "30m"',
    'div.sess[tab style.left=82.5% style.width=calc(90% - 82.5%)] "16:15 – 17:00"',
    "div.sess.rest[tab style.left=40% style.width=calc(45% - 40%)]",
    "div.sess.rest[tab style.left=70.08% style.width=calc(75% - 70.08%)]",
    "div.sess.rest[tab style.left=80% style.width=calc(82.5% - 80%)]",
  ]);
  assert.equal(rows(p).length, 5);
});

test("the timeline's tooltips name each block's day, hours and kind", () => {
  const p = page();
  timeline(p, splitDay());
  const blocks = rows(p)[0].children[1].children.slice(11);
  const [leave, work, , gap, , , , rest] = blocks;
  const line = (k, v) => `div.t-row(span.k ${JSON.stringify(k)}, span.v ${JSON.stringify(v)})`;
  assert.deepEqual(tipOf(p, leave), ['div.t-title "Lun 7 sep · 17:30 – 18:00"', line("Permiso · Médico", "30m")]);
  assert.deepEqual(tipOf(p, work), ['div.t-title "Lun 7 sep · 09:00 – 12:00"', line("Trabajo", "3h")]);
  assert.deepEqual(tipOf(p, gap), ['div.t-title "Lun 7 sep · 14:00 – 14:30"', line("Sin fichar", "30m")]);
  assert.deepEqual(tipOf(p, rest), ['div.t-title "Lun 7 sep · 12:00 – 12:30"', line("Descanso", "30m")]);
});

test("a session that ends on a later day runs to midnight, says how many days on, and warns of a long day", () => {
  const p = page();
  const overnight = (from, out, hours) => ({ in: from, out, hours, rest: false });
  timeline(
    p,
    week({
      days: [
        day(0, {
          hours: 18,
          sessions: [overnight(new Date(2026, 8, 7, 15), new Date(2026, 8, 8, 9), 18)],
        }),
        day(1, { hours: 5, sessions: [overnight(new Date(2026, 8, 8, 8), new Date(2026, 8, 10, 10), 5)] }),
        ...[2, 3, 4, 5, 6].map((i) => day(i)),
      ],
    }),
  );
  const [monday, tuesday] = rows(p);
  const block = (row) => row.children[1].children.at(-1);
  assert.equal(
    sketch(block(monday)),
    'div.sess.long[tab style.left=43.75% style.width=calc(100% - 43.75%)] "15:00 – 09:00 (+1)"',
  );
  assert.equal(sketch(block(tuesday)), 'div.sess[tab style.left=0% style.width=calc(100% - 0%)] "08:00 – 10:00 (+2)"');
  assert.deepEqual(tipOf(p, block(monday)), [
    'div.t-title "Lun 7 sep · 15:00 – 09:00"',
    'div.t-row(span.k "Trabajo", span.v "18h")',
    'div.t-note "Termina al día siguiente"',
    'div.t-note.warn "Jornada muy larga: 18h en el día, más de 12h, casi siempre una salida sin fichar"',
  ]);
  assert.deepEqual(tipOf(p, block(tuesday)), [
    'div.t-title "Mar 8 sep · 08:00 – 10:00"',
    'div.t-row(span.k "Trabajo", span.v "5h")',
    'div.t-note "Termina 2 días después"',
  ]);
});

test("an open session reads as in progress, and a closed one the same day carries no day count", () => {
  const p = page();
  const today = new Date(2026, 8, 15);
  timeline(
    p,
    week(
      {
        days: [
          day(0, {}, 14),
          day(1, { hours: 1, sessions: [{ in: at(today, 9), out: null, hours: 1, rest: false }] }, 14),
          ...[2, 3, 4, 5, 6].map((i) => day(i, {}, 14)),
        ],
      },
      14,
    ),
  );
  const open = rows(p)[1].children[1].children.at(-1);
  assert.equal(sketch(open), 'div.sess[tab style.left=10% style.width=calc(20% - 10%)] "09:00 – …"');
  assert.deepEqual(tipOf(p, open), [
    'div.t-title "Mar 15 sep · 09:00 – en curso"',
    'div.t-row(span.k "Trabajo", span.v "1h")',
  ]);
});

test("the hour axis widens to the earliest and latest punch or leave", () => {
  const p = page();
  timeline(
    p,
    week({
      days: [
        day(0, {
          hours: 14,
          sessions: [punched([6, 30], [20, 15])],
          leaves: [{ type: "Médico", hours: 1, from: new Date(2026, 8, 7, 5, 15), to: new Date(2026, 8, 7, 21, 30) }],
        }),
        ...[1, 2, 3, 4, 5, 6].map((i) => day(i)),
      ],
    }),
  );
  assert.deepEqual(
    card(p).children[2].children.map((n) => n.textContent),
    Array.from({ length: 18 }, (_, i) => String(5 + i)),
  );
  assert.equal(rows(p)[0].children[1].children.filter((n) => n.className === "tl-grid").length, 18);
});

/* ---------- the table ---------- */

const tableRows = (p) => p.document.getElementById("tableView").children[0].children;

test("the table lists the weeks newest first with a column per day, and how each stands", () => {
  const p = page();
  const worked = (hours) => ({ hours });
  const days = (first, byDay = {}) => Array.from({ length: 7 }, (_, i) => day(i, byDay[i] ?? {}, first));
  put(p, "ws", [
    week({ allVacation: true, target: 0, days: days(7, { 0: { vacation: true, auto: "Festivo", expected: 0 } }) }, 7),
    week({ error: true, total: 40, target: 40, days: days(14, { 0: worked(8), 1: worked(32) }) }, 14),
    week({ total: 38, delta: -2, target: 40, days: days(21, { 0: worked(0.01) }) }, 21),
    week({ total: 41, delta: 1, days: days(28) }, 28),
    week({ total: 40, complete: false, current: true, days: days(35) }, 35),
    week({ total: 39.5, complete: false, days: days(42) }, 42),
    week({ total: 0, target: 0, allVacation: true, complete: false, days: days(49) }, 49),
    week({ total: 0.01, target: 0, delta: 0.01, allVacation: true, days: days(56) }, 56),
  ]);
  p.run("renderTable(ws)");
  const [table] = p.document.getElementById("tableView").children;
  assert.equal(table.tagName, "TABLE");
  const [caption, head, body] = table.children;
  assert.equal(
    sketch(caption),
    'caption "Horas fichadas por semana y día (horas:minutos). «vac.» = día de vacaciones."',
  );
  assert.equal(
    sketch(head),
    'thead(tr(th "Semana", th "Lun", th "Mar", th "Mié", th "Jue", th "Vie", th "Objetivo", th "Total", th "Δ objetivo"))',
  );
  const cells = (tr) => tr.children.map(sketch).join(" | ");
  const dashes = Array(5).fill('td.dim "—"').join(" | ");
  const expected = [
    `td "26 oct – 1 nov" | ${dashes} | td.dim "0:00" | td.total "0:01" | td "+1m"`,
    `td "19–25 oct" | ${dashes} | td.dim "0:00" | td.total "0:00" | td.dim "objetivo alcanzado"`,
    `td "12–18 oct" | ${dashes} | td.dim "40:00" | td.total "39:30" | td.dim "faltan 30m"`,
    `td "5–11 oct (en curso)" | ${dashes} | td.dim "40:00" | td.total "40:00" | td.dim "objetivo alcanzado"`,
    `td "28 sep – 4 oct" | ${dashes} | td.dim "40:00" | td.total "41:00" | td "+1h"`,
    `td "21–27 sep" | td "0:01" | ${Array(4).fill('td.dim "—"').join(" | ")} | td.dim "40:00" | td.total "38:00" | td "−2h"`,
    `td "14–20 sep" | td "8:00" | td "32:00" | ${Array(3).fill('td.dim "—"').join(" | ")} | td.dim "40:00" | td.total "40:00" | td.warn "fichaje por revisar"`,
    `td "7–13 sep" | td.dim "vac." | ${Array(4).fill('td.dim "—"').join(" | ")} | td.dim "0:00" | td.total "0:00" | td.dim "vacaciones"`,
  ];
  assert.deepEqual(body.children.map(cells), expected);
  assert.deepEqual([body.tagName, ...body.children.map((tr) => tr.tagName)], ["TBODY", ...Array(8).fill("TR")]);
  assert.equal(body.children[5].children.at(-1).className, "");
  p.run("rangeShort = true; renderTable(ws)");
  const short = tableRows(p)[2].children.map((tr) => tr.children.at(-1).className);
  assert.deepEqual(short, ["", "dim", "dim", "dim", "", "down", "warn", "dim"]);
});

test("the table adds the weekend columns once a week has hours on one of them", () => {
  const p = page();
  const header = (byDay) => {
    put(p, "ws", [week({ days: Array.from({ length: 7 }, (_, i) => day(i, byDay[i] ?? {})) })]);
    p.run("renderTable(ws)");
    return tableRows(p)[1]
      .children[0].children.map((th) => th.textContent)
      .join(" ");
  };
  const five = "Semana Lun Mar Mié Jue Vie Objetivo Total Δ objetivo";
  const seven = "Semana Lun Mar Mié Jue Vie Sáb Dom Objetivo Total Δ objetivo";
  assert.equal(header({}), five);
  assert.equal(header({ 5: { hours: 0.01 }, 6: { hours: 0.01 } }), five);
  assert.equal(header({ 5: { hours: 3 } }), seven);
  assert.equal(header({ 6: { hours: 3 } }), seven);
  assert.equal(header({ 5: { hours: 3 }, 6: { hours: 3 } }), seven);
  assert.equal(header({ 5: { hours: 0.02 } }), seven);
  assert.equal(header({ 6: { hours: 0.02 } }), seven);
  put(p, "ws", [week({ days: Array.from({ length: 7 }, (_, i) => day(i, i === 5 ? { hours: 3 } : {})) }), week()]);
  p.run("renderTable(ws)");
  assert.equal(tableRows(p)[1].children[0].children.length, 11);
  assert.equal(tableRows(p)[2].children[0].children.length, 11);
});

/* ---------- the banner of punches to fix ---------- */

const PUNCH_ERRORS = [
  { kind: "long", in: new Date(2026, 8, 10), hours: 16.5, count: 1 },
  { kind: "long", in: new Date(2026, 8, 9), hours: 14, count: 2 },
  { kind: "open", in: new Date(2026, 8, 8, 9) },
  { kind: "empty", in: new Date(2026, 8, 7), expected: 7.5 },
];
const REQUESTS = [
  {
    from: new Date(2026, 8, 10, 9).toISOString(),
    to: new Date(2026, 8, 10, 17, 40).toISOString(),
    reason: "Olvidé fichar",
  },
  { from: new Date(2026, 8, 12, 9).toISOString(), to: null, reason: "" },
];
const banner = (p, { errors = PUNCH_ERRORS, requests = REQUESTS, canEdit = true, other = null } = {}) => {
  put(p, "errors", errors);
  p.run(
    `punchErrors = () => errors; store.data.requests = ${JSON.stringify(requests)}; store.data.can_edit = ${canEdit}; store.other = ${JSON.stringify(other)}; renderErrors()`,
  );
  return p.document.getElementById("errorsBanner");
};
const items = (box) => box.children[0].children[2].children;

test("the banner lists a line per day with its errors and requests, newest first, and what can be done", () => {
  const p = page();
  const box = banner(p);
  assert.equal(box.className, "");
  assert.equal(box.children.length, 1);
  const [details] = box.children;
  assert.equal(details.tagName, "DETAILS");
  assert.equal(details.open, false);
  const [summary, intro, list] = details.children;
  assert.equal(list.tagName, "UL");
  assert.equal(sketch(summary), 'summary(h2 "⚠ 4 fichajes por corregir · 2 solicitudes pendientes")');
  assert.equal(
    sketch(intro),
    'p "Entradas sin cerrar de días anteriores, jornadas de más de 12h y días con jornada prevista sin ningún fichaje, ' +
      "de todo el historial, y las solicitudes de cambio pendientes de tu aprobación, un día por línea. " +
      'Pulsa uno para ver su semana."',
  );
  const fix = (text) => `button.fix[type=button] ${JSON.stringify(text)}`;
  const ask =
    'button.fix[title=Abre en Odoo la solicitud de cambio de fichaje de este día, preparada: revisa las horas antes de enviarla type=button] "Solicitar cambio"';
  const line = (inner) => `li(button[type=button](${inner}), ${fix("Corregir")}, ${ask})`;
  assert.deepEqual(list.children.map(sketch), [
    line('span.day "Sáb 12 sep 2026", " · ", span.req "Solicitud pendiente", " 09:00"'),
    line(
      'span.day "Jue 10 sep 2026", " · ", span.kind "Jornada de 16h 30m", " · ", span.req "Solicitud pendiente", ' +
        '" 09:00–17:40 · Olvidé fichar"',
    ),
    line('span.day "Mié 9 sep 2026", " · ", span.kind "Jornada de 14h", " en 2 sesiones"'),
    line('span.day "Mar 8 sep 2026", " · ", span.kind "Sin cerrar", " entrada a las 09:00, sin salida"'),
    line('span.day "Lun 7 sep 2026", " · ", span.kind "Sin fichar", " con jornada prevista de 7h 30m"'),
  ]);
});

test("the banner offers «Revisar» to who may only approve, no request form on another's page, and says what it holds", () => {
  const p = page();
  const mixed = { errors: [PUNCH_ERRORS[0]], canEdit: false, other: "7" };
  const box = banner(p, mixed);
  assert.deepEqual(
    items(box).map((li) => li.children.slice(1).map(sketch)),
    [['button.fix[type=button] "Revisar"'], ['button.fix[type=button] "Revisar"']],
  );
  banner(p, { ...mixed, requests: [] });
  assert.deepEqual(
    items(box).map((li) => li.children.length),
    [1],
  );
  const own = banner(p, { ...mixed, other: null });
  assert.deepEqual(
    items(own).map((li) => li.children.map((n) => n.textContent).slice(1)),
    [
      ["Revisar", "Solicitar cambio"],
      ["Revisar", "Solicitar cambio"],
    ],
  );
  banner(p, { errors: [PUNCH_ERRORS[0]], requests: [], canEdit: true, other: "7" });
  assert.equal(sketch(box.children[0].children[0]), 'summary(h2 "⚠ 1 fichaje por corregir")');
  assert.equal(
    box.children[0].children[1].textContent,
    "Entradas sin cerrar de días anteriores, jornadas de más de 12h y días con jornada prevista sin ningún fichaje, " +
      "de todo el historial, un día por línea. Pulsa uno para ver su semana.",
  );
  assert.equal(box.className, "");
  banner(p, { errors: [], requests: [REQUESTS[1]] });
  assert.equal(sketch(box.children[0].children[0]), 'summary(h2 "1 solicitud pendiente")');
  assert.equal(box.className, "requests");
});

test("the banner stays hidden and untouched when there is nothing to fix", () => {
  const p = page();
  const box = banner(p, { errors: [], requests: [] });
  assert.equal(box.className, "hidden requests");
  assert.equal(box.children.length, 0);
});

test("a day's «Solicitar cambio» opens the request form for that day in a tab opened on the click", async () => {
  const p = page();
  p.run(`globalThis.requested = [];
    fetch = async (url) => {
      requested.push(url);
      if (url.includes("2026-09-12")) throw new Error("Odoo no responde");
      return { ok: true, status: 200, json: async () => ({ url: "https://odoo.example/form" }) };
    };
    window.open = (...args) => ((globalThis.openedWith = args), (globalThis.tab = { close() { this.closed = true; } }));`);
  const requested = () => p.run("requested");
  const button = { textContent: "Solicitar cambio", title: "" };
  put(p, "button", button);
  await p.run("openRequest(button, '2026-09-10')");
  assert.deepEqual(requested(), ["/api/request?date=2026-09-10"]);
  assert.deepEqual(p.run("openedWith"), ["", "_blank"]);
  assert.deepEqual(p.run("[tab.opener, tab.location, tab.closed]"), [null, "https://odoo.example/form", null]);
  await p.run("openRequest(button, '2026-09-12')");
  assert.deepEqual(p.run("[tab.closed, button.textContent, button.title]"), [
    true,
    "No se pudo abrir",
    "Odoo no responde",
  ]);
  await p.run("openRequest(button)");
  assert.equal(requested().at(-1), "/api/request");
});

test("each day's «Solicitar cambio» button opens the form for that day", () => {
  const p = page();
  p.run(`globalThis.asked = [];
    openRequest = (button, day) => { asked.push(day); return Promise.resolve(); };`);
  const box = banner(p);
  for (const li of items(box)) li.children.at(-1).listeners.click[0]();
  assert.deepEqual(p.run("asked"), ["2026-09-12", "2026-09-10", "2026-09-09", "2026-09-08", "2026-09-07"]);
});

/* ---------- the day's value ---------- */

test("a day's value says what is wrong with it, or its hours, a dash or an absence", () => {
  const p = page();
  const value = (extra, first = MONDAY) => {
    put(p, "d", day(0, extra, first));
    return sketch(p.run("dayValue(d)"));
  };
  const open = { in: new Date(2026, 8, 7, 9), out: null, hours: 0, rest: false };
  const closed = { in: new Date(2026, 8, 7, 9), out: new Date(2026, 8, 7, 9), hours: 0, rest: false };
  assert.equal(value({}), 'span.dvalue.long "sin fichar"');
  assert.equal(value({ expected: 0 }), 'span.dvalue.zero "—"');
  assert.equal(value({}, 15), 'span.dvalue.zero "—"');
  assert.equal(value({ sessions: [open] }), 'span.dvalue.long "sin cerrar"');
  assert.equal(value({ sessions: [closed, open] }), 'span.dvalue.long "sin cerrar"');
  assert.equal(value({ hours: 0.01, sessions: [open] }), 'span.dvalue.long "1m"');
  assert.equal(value({ hours: 5, sessions: [open] }), 'span.dvalue.long "5h"');
  assert.equal(value({ hours: 0.01, sessions: [closed] }), 'span.dvalue "1m"');
  assert.equal(value({ hours: 8, sessions: [closed] }), 'span.dvalue "8h"');
  assert.equal(value({ hours: 14, sessions: [closed] }), 'span.dvalue.long "14h"');
  assert.equal(value({ vacation: true, auto: "Festivo", expected: 0 }), 'span.dvalue.zero "vac."');
});

/* ---------- everything the range filter drives ---------- */

test("renderAll paints every block of the page, over the months asked for and never more weeks than held", () => {
  const p = page();
  const weeksShown = () => tableRows(p)[2].children.length;
  p.run("renderAll()");
  assert.equal(weeksShown(), 12);
  assert.equal(p.document.getElementById("kpis").children.length, 2);
  assert.equal(chart(p).tagName, "SVG");
  assert.ok(card(p).children.length > 2);
  assert.equal(p.document.getElementById("errorsBanner").children.length, 1);
  p.run("setRangeMonths(1); renderAll()");
  assert.equal(weeksShown(), 6);
  p.run("setRangeMonths(24); renderAll()");
  assert.equal(weeksShown(), 12);
  p.run("setRangeMonths(0); renderAll()");
  assert.equal(weeksShown(), 12);
});

test("a finished short week is red only when the range shown is short too, by a minute or more", () => {
  const p = page();
  const downs = (...weeks) => {
    put(
      p,
      "ws",
      weeks.map(([delta, complete = true], i) =>
        week(
          {
            total: 40 + delta,
            delta,
            complete,
            current: !complete,
            days: Array.from({ length: 7 }, (_, d) => day(d, {}, 7 + 7 * i)),
          },
          7 + 7 * i,
        ),
      ),
    );
    p.run("buildWeeks = () => ws; renderAll()");
    return tableRows(p)[2]
      .children.map((tr) => tr.children.at(-1).className)
      .reverse();
  };
  assert.deepEqual(downs([-1 / 60]), ["down"]);
  assert.deepEqual(downs([-1 / 120]), [""]);
  assert.deepEqual(downs([-1, true], [1, true]), ["", ""]);
  assert.deepEqual(downs([-1, true], [5, false]), ["down", "dim"]);
  assert.deepEqual(downs([-1], [-1 / 60]), ["down", "down"]);
});

test("a short week is not red in the table before the range's balance says so", () => {
  const p = page();
  put(p, "ws", [week({ total: 38, delta: -2 })]);
  p.run("renderTable(ws)");
  assert.equal(tableRows(p)[2].children[0].children.at(-1).className, "");
});
