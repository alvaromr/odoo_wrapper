// teamfixes.js: the management view's card of punches to fix, a row per person with its marks on a strip that
// zooms and pans. The clock is page.mjs's: today is TUESDAY 2026-09-15.

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  drag,
  hover,
  LIMITS,
  load,
  marksOf,
  punch,
  siteReply as reply,
  segment,
  settle,
  shape,
  shift,
  site,
  svgTexts,
  teamFixes,
  teamPayload,
  tipClasses,
} from "./page.mjs";

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

test("the fixes card filters its own rows by kind, counting each kind's people", async () => {
  const page = load({ entry: "team.js", data: teamPayload() });
  const doc = page.document;
  const seg = doc.getElementById("fixKinds");
  for (const kind of ["open", "long", "empty"]) {
    const button = doc.createElement("button");
    button.dataset.kind = kind;
    seg.appendChild(button);
  }
  await settle();
  const toggles = seg.children;
  const toggle = (kind) =>
    seg.listeners.click[0]({ target: { closest: () => toggles.find((b) => b.dataset.kind === kind) } });
  const fixed = () =>
    doc
      .getElementById("fixes")
      .children[0].children.filter((c) => c.tagName === "A")
      .map((a) => a.textContent);
  assert.deepEqual(
    toggles.map((b) => b.textContent),
    ["Sin cerrar (1)", "Jornada muy larga (1)", "Sin fichar (2)"],
  );
  assert.deepEqual(fixed(), ["Zoe", "Bruno"]);
  toggle("open");
  toggle("long");
  assert.deepEqual(fixed(), ["Bruno", "Zoe"]);
  assert.deepEqual(
    toggles.map((b) => b.getAttribute("aria-pressed")),
    ["false", "false", "true"],
  );
  assert.equal(toggles[0].textContent, "Sin cerrar (1)");
  assert.match(page.calls.hash, /k=empty$/);
  toggle("empty");
  assert.deepEqual(fixed(), []);
  assert.match(doc.getElementById("fixesNote").textContent, /Nadie con los tipos elegidos\.$/);
  assert.equal(doc.getElementById("openCard").classList.contains("hidden"), false);
  toggle("long");
  const chips = doc.getElementById("fixes").children[0].children[4];
  assert.deepEqual(
    chips.children.map((c) => c.textContent),
    ["1 jornada muy larga · 20h"],
  );
  const wide = doc.getElementById("wideBtn");
  wide.listeners.click[0]({ currentTarget: wide });
  assert.equal(doc.getElementById("openCard").classList.contains("wide"), true);
  assert.deepEqual([wide.getAttribute("aria-pressed"), wide.title], ["true", "Volver al ancho normal"]);
  wide.listeners.click[0]({ currentTarget: wide });
  assert.deepEqual(
    [wide.getAttribute("aria-pressed"), wide.getAttribute("aria-label")],
    ["false", "Ampliar a todo el ancho"],
  );
  doc.getElementById("fixKinds").listeners.click[0]({ target: { closest: () => null } });
  page.run("team.fixes = null");
  toggle("open");
});

test("the fixes strip pans by dragging, and a plain press or a name link is left alone", async () => {
  const page = load({ entry: "team.js", data: teamPayload() });
  await settle();
  const scroller = page.document.getElementById("fixes");
  const on = (type) => scroller.listeners[type][0];
  const target = (link) => ({ closest: () => (link ? {} : null) });
  scroller.scrollLeft = 500;
  on("pointermove")({ clientX: 10, clientY: 0 });
  on("pointerdown")({ button: 2, target: target(false), clientX: 100, clientY: 0 });
  on("pointerdown")({ button: 0, target: target(true), clientX: 100, clientY: 0 });
  on("pointermove")({ clientX: 10, clientY: 0 });
  assert.equal(scroller.scrollLeft, 500);
  on("pointerdown")({ button: 0, target: target(false), clientX: 100, clientY: 0, pointerId: 1 });
  on("pointermove")({ clientX: 102, clientY: 0 });
  assert.deepEqual([scroller.scrollLeft, scroller.classList.contains("dragging")], [500, false]);
  on("pointermove")({ clientX: 60, clientY: 0 });
  on("pointermove")({ clientX: 40, clientY: 0 });
  assert.deepEqual([scroller.scrollLeft, scroller.classList.contains("dragging")], [560, true]);
  on("pointerup")();
  assert.equal(scroller.classList.contains("dragging"), false);
  on("pointermove")({ clientX: 0, clientY: 0 });
  assert.equal(scroller.scrollLeft, 560);
  scroller.listeners.pointercancel[0]();
});

test("a mark in the fixes strip opens its day to correct it, unless it ends a drag", async () => {
  const urls = [];
  let down = false;
  const page = load({
    entry: "team.js",
    fetchImpl: async (url) => {
      urls.push(url);
      if (down && url.includes("week=")) throw new Error("sin red");
      return { ok: true, status: 200, json: async () => (url.includes("fixes") ? teamFixes() : teamPayload()) };
    },
  });
  await settle();
  const doc = page.document;
  const dialog = doc.getElementById("dayDialog");
  const zoe = doc.getElementById("fixes").children[0].children.slice(3)[2];
  const marks = zoe.children.filter((c) => c.tagName === "G");
  const scroller = doc.getElementById("fixes");
  const on = (type) => scroller.listeners[type][0];
  on("pointerdown")({ button: 0, target: { closest: () => null }, clientX: 100, clientY: 0 });
  on("pointermove")({ clientX: 40, clientY: 0 });
  on("pointerup")();
  await marks[0].listeners.click[0]();
  assert.equal(dialog.open, false);
  on("pointerdown")({ button: 0, target: { closest: () => null }, clientX: 100, clientY: 0 });
  on("pointerup")();
  page.run(`team.fixes.employees[0].items[0].date = "2025-03-03"; renderFixes()`);
  const first = doc
    .getElementById("fixes")
    .children[0].children.slice(3)[2]
    .children.filter((c) => c.tagName === "G")[0];
  await first.listeners.click[0]();
  await settle();
  assert.ok(urls.includes("/api/team?week=2025-03-03"));
  assert.equal(dialog.open, true);
  assert.equal(doc.getElementById("dayDialogTitle").textContent, "Zoe");
  dialog.close();
  first.listeners.keydown[0]({ key: "Tab" });
  down = true;
  first.listeners.keydown[0]({ key: "Enter" });
  await settle();
  assert.equal(dialog.open, false);
  assert.equal(doc.getElementById("fixesNote").textContent, "No se pudo abrir ese día: sin red");
});
