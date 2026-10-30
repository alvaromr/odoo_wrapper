// What the pages' modules draw and send, checked piece by piece: the charts (teamcharts.js), the tooltip, the
// updates banner and the other helpers both pages share (shared.js), the Discord dialog (teamdiscord.js) and the day
// dialog (dayedit.js). The modules' functions are called straight from the page's context, each node dumped as one
// line (show), so a class, an attribute or a text that changes shows up as a failing line.

import assert from "node:assert/strict";
import test from "node:test";
import { element, load, memoryStorage, settle, teamFixes, teamPayload, Y25 } from "./page.mjs";

const rounded = (value) => (/^-?\d+(\.\d+)?$/.test(value) ? String(Math.round(Number(value) * 100) / 100) : value);
const PROPS = ["type", "title", "autocomplete", "rows", "href", "target", "rel", "value"];

function show(node, depth = 0) {
  const pad = "  ".repeat(depth);
  if (typeof node === "string") return [`${pad}"${node}"`];
  let head = node.tagName.toLowerCase();
  if (node.id) head += `#${node.id}`;
  if (node.className) head += `.${node.className.replaceAll(" ", ".")}`;
  for (const key of PROPS) if (node[key]) head += ` ${key}=${node[key]}`;
  for (const [key, value] of Object.entries(node.attrs)) head += ` ${key}=${rounded(value)}`;
  if (node.disabled) head += " disabled";
  const text = node.textContent === "" || node.textContent == null ? "" : ` "${node.textContent}"`;
  return [pad + head + text, ...node.children.flatMap((child) => show(child, depth + 1))];
}

const showAll = (nodes) => nodes.flatMap((node) => show(node));
const teamPage = (options = {}) =>
  load({ entry: "team.js", data: teamPayload(), storage: memoryStorage(), ...options });
const tipOf = (page) => page.document.getElementById("tip");

function hovered(page, node) {
  node.listeners.pointerenter[0]({ clientX: 10, clientY: 10 });
  const lines = showAll(tipOf(page).children);
  node.listeners.pointerleave[0]();
  return lines;
}

const SERIES = [
  { key: "a", label: "Cortas", cls: "short" },
  { key: "b", label: "Largas", cls: "over" },
];

test("a chart card holds its title and, when given one, its note", () => {
  const { run } = teamPage();
  const chartCard = run("chartCard");
  assert.deepEqual(show(chartCard("Horas", "De todos")), [
    "section.card.chart",
    '  h3.chart-title "Horas"',
    '  p.chart-note "De todos"',
  ]);
  assert.deepEqual(show(chartCard("Horas")), ["section.card.chart", '  h3.chart-title "Horas"']);
});

test("a legend names each series beside its swatch", () => {
  const { run } = teamPage();
  assert.deepEqual(show(run("legend")(SERIES)), [
    "div.legend-row",
    "  span.legend-item",
    "    span.swatch.short",
    '    "Cortas"',
    "  span.legend-item",
    "    span.swatch.over",
    '    "Largas"',
  ]);
});

test("svg nodes are made in the SVG namespace and carry text only when given one", () => {
  const page = teamPage();
  const spaces = [];
  page.document.createElementNS = (space, tag) => {
    spaces.push(space);
    return element(tag);
  };
  const chart = page.run("divergingBars")([{ label: "Zoe", value: -4, suspect: false, rows: [] }], String);
  assert.equal(new Set(spaces).size, 1);
  assert.equal(spaces[0], "http://www.w3.org/2000/svg");
  assert.equal(chart.children[0].textContent, "");
});

test("the diverging bars put hours short on the left and over on the right, suspects at the edge", () => {
  const page = teamPage();
  const chart = page.run("divergingBars")(
    [
      { label: "Zoe", value: -4, suspect: false, rows: [["Horas", "4h"]] },
      { label: "Ana", value: 2, suspect: false, href: "/u/1", rows: [] },
      { label: "Bru", value: 0, suspect: false, rows: [] },
      { label: "Eva", value: -50, suspect: true, rows: [] },
    ],
    (value) => `${value}h`,
  );
  assert.deepEqual(show(chart), [
    "svg viewBox=0 0 1100 96 class=diverging role=img",
    "  line x1=645 x2=645 y1=0 y2=96 class=zero",
    "  g class=mark tabindex=0",
    "    rect x=0 y=4 width=1100 height=22 class=hit",
    '    text x=182 y=19 class=axis-label text-anchor=end "Zoe"',
    "    rect x=290 y=9 width=355 height=12 rx=2 class=bar short",
    '    text x=284 y=19 class=value-label text-anchor=end "-4h"',
    "  g class=mark link tabindex=0",
    "    rect x=0 y=26 width=1100 height=22 class=hit",
    '    text x=182 y=41 class=axis-label text-anchor=end "Ana"',
    "    rect x=645 y=31 width=177.5 height=12 rx=2 class=bar surplus",
    '    text x=828.5 y=41 class=value-label text-anchor=start "2h"',
    "  g class=mark tabindex=0",
    "    rect x=0 y=48 width=1100 height=22 class=hit",
    '    text x=182 y=63 class=axis-label text-anchor=end "Bru"',
    "    rect x=645 y=53 width=1 height=12 rx=2 class=bar surplus",
    '    text x=652 y=63 class=value-label text-anchor=start "0h"',
    "  g class=mark tabindex=0",
    "    rect x=0 y=70 width=1100 height=22 class=hit",
    '    text x=182 y=85 class=axis-label text-anchor=end "Eva"',
    "    rect x=290 y=75 width=355 height=12 rx=2 class=bar error",
    '    text x=284 y=85 class=value-label text-anchor=end "⚠ -50h"',
  ]);
  const [, zoe, ana] = chart.children;
  assert.equal(zoe.listeners.click, undefined);
  assert.equal(zoe.listeners.keydown, undefined);
  assert.deepEqual(hovered(page, zoe), ['div.t-title "Zoe"', "div.t-row", '  span.k "Horas"', '  span.v "4h"']);
  ana.listeners.click[0]();
  ana.listeners.keydown[0]({ key: "Tab" });
  assert.deepEqual(page.calls.assigned, ["/u/1"]);
  ana.listeners.keydown[0]({ key: "Enter" });
  assert.deepEqual(page.calls.assigned, ["/u/1", "/u/1"]);
});

test("the diverging bars scale to the largest bar that is not a suspect, and never below a width", () => {
  const { run } = teamPage();
  const widths = (items, size) =>
    run("divergingBars")(items, String, size)
      .children.filter((child) => child.tagName === "G")
      .map((group) => group.children[2].getAttribute("width"));
  const item = (value, suspect = false) => ({ label: "a", value, suspect, rows: [] });
  assert.deepEqual(widths([item(-4), item(2), item(-100, true)]), ["355", "177.5", "355"]);
  assert.deepEqual(widths([item(-0.5), item(0.25)]), ["177.5", "88.75"]);
  assert.deepEqual(
    [500, 700, 1600].flatMap((size) => widths([item(-1)], size)),
    ["125", "155", "605"],
  );
});

test("the grouped columns draw a bar and its count per series, a tick scale and a label per period", () => {
  const page = teamPage();
  const chart = page.run("groupedColumns")(
    [
      { label: "S1", values: { a: 8, b: 0 }, people: { a: ["X", "Y"] } },
      { label: "S2", title: "Semana 2", values: { a: 3, b: 5 } },
      { label: "S3", values: { a: 0, b: 2 } },
    ],
    SERIES,
    1100,
  );
  assert.deepEqual(show(chart), [
    "svg viewBox=0 0 1100 220 class=columns role=img",
    "  line x1=30 x2=1100 y1=194 y2=194 class=zero",
    '  text x=24 y=198 class=axis-label text-anchor=end "0"',
    "  line x1=30 x2=1100 y1=106 y2=106 class=grid",
    '  text x=24 y=110 class=axis-label text-anchor=end "4"',
    "  line x1=30 x2=1100 y1=18 y2=18 class=grid",
    '  text x=24 y=22 class=axis-label text-anchor=end "8"',
    "  g class=mark tabindex=0",
    "    rect x=30 y=18 width=356.67 height=176 class=hit",
    "    rect x=184.33 y=18 width=22 height=176 rx=2 class=bar short",
    '    text x=195.33 y=14 class=value-label text-anchor=middle "8"',
    '    text x=208.33 y=212 class=axis-label text-anchor=middle "S1"',
    "  g class=mark tabindex=0",
    "    rect x=386.67 y=18 width=356.67 height=176 class=hit",
    "    rect x=541 y=128 width=22 height=66 rx=2 class=bar short",
    '    text x=552 y=124 class=value-label text-anchor=middle "3"',
    "    rect x=565 y=84 width=22 height=110 rx=2 class=bar over",
    '    text x=576 y=80 class=value-label text-anchor=middle "5"',
    '    text x=565 y=212 class=axis-label text-anchor=middle "S2"',
    "  g class=mark tabindex=0",
    "    rect x=743.33 y=18 width=356.67 height=176 class=hit",
    "    rect x=921.67 y=150 width=22 height=44 rx=2 class=bar over",
    '    text x=932.67 y=146 class=value-label text-anchor=middle "2"',
    '    text x=921.67 y=212 class=axis-label text-anchor=middle "S3"',
  ]);
  const [s1, s2] = chart.children.slice(6);
  assert.deepEqual(hovered(page, s1), [
    'div.t-title "S1"',
    "div.t-row",
    '  span.k "Cortas"',
    "    span.swatch.short",
    '  span.v "8"',
    'div.t-note.t-name "X"',
    'div.t-note.t-name "Y"',
    "div.t-sep",
    "div.t-row",
    '  span.k "Largas"',
    "    span.swatch.over",
    '  span.v "0"',
  ]);
  assert.equal(hovered(page, s2)[0], 'div.t-title "Semana 2"');
});

test("narrow columns shrink their bars to fit and a small chart is drawn at its minimum width", () => {
  const page = teamPage();
  const periods = Array.from({ length: 12 }, (_, i) => ({ label: `P${i}`, values: { a: 1, b: 1 } }));
  const chart = page.run("groupedColumns")(periods, SERIES, 100);
  assert.equal(chart.attrs.viewBox, "0 0 640 220");
  const bars = chart.children.at(-1).children.filter((child) => child.attrs.class?.startsWith("bar"));
  assert.deepEqual(
    bars.map((bar) => [rounded(bar.attrs.x), rounded(bar.attrs.width)]),
    [
      ["593.17", "19.42"],
      ["614.58", "19.42"],
    ],
  );
  const empty = page.run("groupedColumns")([{ label: "P", values: { a: 0, b: 0 } }], [SERIES[0]], 700);
  assert.equal(empty.attrs.viewBox, "0 0 700 220");
  assert.deepEqual(
    empty.children.filter((child) => child.tagName === "LINE").map((child) => [child.attrs.y1, child.attrs.class]),
    [
      ["194", "zero"],
      ["18", "grid"],
    ],
  );
});

test("the session strip's axis draws a line per midnight, a stronger one on Mondays, and its ticks", () => {
  const page = teamPage();
  const stripAxis = page.run("stripAxis");
  const from = new Date(2025, 2, 8, 12);
  const to = new Date(2025, 2, 12);
  const ticks = [
    { at: new Date(2025, 2, 9, 12), label: "dom" },
    { at: new Date(2025, 2, 11, 22), label: "mar" },
  ];
  assert.deepEqual(show(stripAxis(from, to, ticks, 840)), [
    "svg viewBox=0 0 840 18 width=840 height=18 class=strip-axis role=presentation",
    "  line x1=120 x2=120 y1=14 y2=18 class=day",
    "  line x1=360 x2=360 y1=14 y2=18 class=monday",
    "  line x1=600 x2=600 y1=14 y2=18 class=day",
    "  line x1=240 x2=240 y1=12 y2=18 class=grid",
    '  text x=243 y=10 class=axis-label "dom"',
    "  line x1=820 x2=820 y1=12 y2=18 class=grid",
    '  text x=800 y=10 class=axis-label "mar"',
  ]);
});

test("the session strip draws each mark in range, clipped to it, opens it and shows its tip", () => {
  const page = teamPage();
  const opened = [];
  const mark = (start, end, cls) => ({
    start,
    end,
    cls,
    tip: (box) => box.appendChild(page.run("el")("div", "t-title", cls)),
    open: () => opened.push(cls),
  });
  const from = new Date(2025, 2, 8, 12);
  const to = new Date(2025, 2, 12);
  const marks = [
    mark(new Date(2025, 2, 8), from, "before"),
    mark(new Date(2025, 2, 7), new Date(2025, 2, 9), "clipped-start"),
    mark(new Date(2025, 2, 10, 10), new Date(2025, 2, 10, 10, 1), "tiny"),
    mark(new Date(2025, 2, 11), new Date(2025, 2, 14), "clipped-end"),
    mark(to, new Date(2025, 2, 13), "after"),
  ];
  const strip = page.run("sessionStrip")(from, to, marks, 840);
  assert.deepEqual(show(strip), [
    "svg viewBox=0 0 840 18 width=840 height=18 class=strip role=img",
    "  line x1=120 x2=120 y1=0 y2=18 class=day",
    "  line x1=360 x2=360 y1=0 y2=18 class=monday",
    "  line x1=600 x2=600 y1=0 y2=18 class=day",
    "  line x1=0 x2=840 y1=9 y2=9 class=zero",
    "  g class=mark link tabindex=0",
    "    rect x=-3 y=0 width=126 height=18 class=hit",
    "    rect x=0 y=3 width=120 height=12 rx=2 class=bar clipped-start",
    "  g class=mark link tabindex=0",
    "    rect x=457 y=0 width=10 height=18 class=hit",
    "    rect x=460 y=3 width=4 height=12 rx=2 class=bar tiny",
    "  g class=mark link tabindex=0",
    "    rect x=597 y=0 width=246 height=18 class=hit",
    "    rect x=600 y=3 width=240 height=12 rx=2 class=bar clipped-end",
  ]);
  const group = strip.children[4];
  group.listeners.click[0]();
  group.listeners.keydown[0]({ key: "Enter" });
  group.listeners.keydown[0]({ key: "Tab" });
  assert.deepEqual(opened, ["clipped-start", "clipped-start"]);
  assert.deepEqual(hovered(page, group), ['div.t-title "clipped-start"']);
});

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const teamReply = (url) => reply(url.includes("fixes") ? teamFixes() : teamPayload());
const answering = (route) => async (url, opts) => (await route(url, opts)) ?? teamReply(url);

test("the tooltip opens on the far side of the pointer when it would not fit the window", () => {
  const page = teamPage();
  const node = element("div");
  page.run("attachTip")(node, (box) => box.appendChild(page.run("el")("div", "t-title", "Hola")));
  const tip = tipOf(page);
  tip.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 100, height: 50 });
  const placed = (x, y) => {
    node.listeners.pointermove[0]({ clientX: x, clientY: y });
    return [tip.style.left, tip.style.top];
  };
  assert.deepEqual(placed(10, 10), ["24px", "24px"]);
  assert.deepEqual(placed(1158, 728), ["1172px", "742px"]);
  assert.deepEqual(placed(1165, 741), ["1051px", "677px"]);
  assert.deepEqual(placed(1200, 10), ["1086px", "24px"]);
});

test("a tooltip says whether it is open, and opens on focus below the middle of what has it", () => {
  const page = teamPage();
  const node = element("div");
  node.getBoundingClientRect = () => ({ left: 100, top: 30, right: 140, bottom: 70, width: 40, height: 40 });
  page.run("attachTip")(node, (box) => box.appendChild(page.run("tipRow")("Horas", "8h")));
  const tipOpen = () => page.run("tipOpen()");
  assert.equal(tipOpen(), false);
  node.listeners.focus[0]();
  assert.equal(tipOpen(), true);
  assert.deepEqual([tipOf(page).style.left, tipOf(page).style.top], ["134px", "84px"]);
  assert.deepEqual(showAll(tipOf(page).children), ["div.t-row", '  span.k "Horas"', '  span.v "8h"']);
  node.listeners.blur[0]();
  assert.equal(tipOpen(), false);
  assert.equal(tipOf(page).style.display, "none");
});

test("api posts JSON when it has a body and plain otherwise", async () => {
  const sent = [];
  const page = teamPage({
    fetchImpl: answering((url, opts) => {
      if (!url.startsWith("/api/echo")) return undefined;
      sent.push([url, opts && JSON.parse(JSON.stringify(opts))]);
      return reply({ ok: true });
    }),
  });
  await page.run("api")("/api/echo", { a: 1 });
  await page.run("api")("/api/echo");
  assert.deepEqual(sent, [
    ["/api/echo", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"a":1}' }],
    ["/api/echo", undefined],
  ]);
});

test("the logout button is disabled while the request is on its way", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const page = teamPage({
    fetchImpl: answering(async (url) => {
      if (url !== "/api/logout") return undefined;
      await gate;
      return reply({ ok: true });
    }),
  });
  const button = page.document.getElementById("logoutBtn");
  const done = button.listeners.click[0]();
  assert.equal(button.disabled, true);
  release();
  await done;
  assert.deepEqual(page.calls.replace, ["/login"]);
});

test("a press pans a box only once it moves, leaves links alone and tells a click it was a drag, once", () => {
  const page = teamPage();
  const scroller = element("div");
  const captured = [];
  scroller.setPointerCapture = (id) => captured.push(id);
  const pan = page.run("panScroll")(scroller);
  const on = (type, event) => scroller.listeners[type][0](event);
  const plain = { closest: (selector) => (selector === "a" ? null : {}) };
  const link = { closest: (selector) => (selector === "a" ? {} : null) };
  const press = (target) =>
    on("pointerdown", { button: 0, pointerType: "mouse", target, clientX: 100, clientY: 100, pointerId: 7 });
  scroller.scrollLeft = 50;
  scroller.scrollTop = 20;

  press(link);
  on("pointermove", { clientX: 160, clientY: 100 });
  assert.deepEqual([scroller.scrollLeft, scroller.scrollTop], [50, 20]);

  press(plain);
  assert.equal(pan.consume(), false);
  on("pointermove", { clientX: 103, clientY: 100 });
  assert.deepEqual([scroller.scrollLeft, scroller.classList.contains("dragging"), captured], [50, false, []]);
  const owner = element("div");
  page.run("attachTip")(owner, (box) => box.appendChild(page.run("el")("div", "t-title", "Hola")));
  owner.listeners.pointerenter[0]({ clientX: 1, clientY: 1 });
  assert.equal(page.run("tipOpen()"), true);
  on("pointermove", { clientX: 110, clientY: 100 });
  assert.equal(page.run("tipOpen()"), false);
  assert.deepEqual([scroller.scrollLeft, scroller.scrollTop, scroller.classList.contains("dragging")], [40, 20, true]);
  assert.deepEqual(captured, [7]);
  on("pointerup");
  assert.equal(scroller.classList.contains("dragging"), false);
  assert.deepEqual([pan.consume(), pan.consume()], [true, false]);

  press(plain);
  on("pointerup");
  assert.equal(pan.consume(), false);
});

const OFFER = {
  available: true,
  current: "1.1.0",
  latest: "1.2.0",
  url: "https://github.com/r/releases/tag/v1.2.0",
  local: true,
  how: "auto",
};
const PLUGIN_NOTE = [
  "p",
  '  "Las skills de Claude Code se actualizan con "',
  '  code "claude plugin update odoo@odoo-wrapper"',
  '  "."',
];
const upgradeNote = (lead) => [
  "p",
  `  "${lead}"`,
  '  "Para instalarla, ejecuta "',
  '  code "uv tool upgrade odoo-wrapper"',
  '  " en una terminal del ordenador: el dashboard se reinicia solo."',
];

test("the update banner hides without an update and offers the right way to install when there is one", () => {
  const page = teamPage();
  const banner = page.document.getElementById("updateBanner");
  const showUpdate = page.run("showUpdate");

  showUpdate({ ...OFFER, available: false });
  assert.deepEqual([banner.classList.contains("hidden"), banner.children.length], [true, 0]);

  assert.equal(showUpdate(OFFER), OFFER);
  assert.equal(banner.classList.contains("hidden"), false);
  assert.deepEqual(show(banner.children[0]), [
    "p",
    '  strong "Hay una versión nueva, la 1.2.0"',
    '  " (tienes la 1.1.0). "',
    '  a href=https://github.com/r/releases/tag/v1.2.0 target=_blank rel=noopener "Novedades"',
    '  "."',
  ]);
  assert.deepEqual(show(banner.children[1]), [
    "div.update-actions",
    '  button.btn.primary.small type=button "Actualizar ahora"',
    "  span role=status",
  ]);

  showUpdate({ ...OFFER, how: "git" });
  assert.deepEqual(show(banner.children[1]), ["p", '  "Es la instalación de desarrollo: tráela con git."']);
  assert.deepEqual(show(banner.children[2]), PLUGIN_NOTE);

  showUpdate({ ...OFFER, how: "none" });
  assert.deepEqual(show(banner.children[1]), upgradeNote("No encuentro uv en este ordenador. "));
  assert.deepEqual(show(banner.children[2]), PLUGIN_NOTE);

  showUpdate({ ...OFFER, local: false });
  assert.deepEqual(show(banner.children[1]), upgradeNote(""));
});

function updating(route) {
  const timers = [],
    cleared = [];
  let restarting = false;
  const page = teamPage({
    fetchImpl: answering((url, opts) => (restarting ? route(url, opts) : undefined)),
    globals: {
      setTimeout: (fn, ms) => {
        if (ms === 2000) {
          fn();
          return 0;
        }
        timers.push([fn, ms]);
        return timers.length;
      },
      clearTimeout: (id) => cleared.push(id),
    },
  });
  return { page, timers, cleared, start: () => (restarting = true) };
}

function installer(page) {
  page.run("showUpdate")(OFFER);
  const [button, note] = page.document.getElementById("updateBanner").children[1].children;
  return { button, note };
}

test("«Actualizar ahora» asks twice, installs, waits for the new version and reloads", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let gets = 0;
  const { page, timers, cleared, start } = updating(async (url, opts) => {
    if (url !== "/api/update") return undefined;
    if (opts) {
      await gate;
      return reply({ skills: "" });
    }
    gets += 1;
    if (gets === 1) throw new Error("sin red");
    if (gets === 2) return reply({ current: "1.1.0" });
    if (gets === 3) return reply({ error: "ocupado" }, 503);
    return reply({ current: "1.2.0" });
  });
  await settle();
  start();
  const { button, note } = installer(page);
  assert.equal(note.textContent, "");
  await button.listeners.click[0]();
  assert.equal(button.textContent, "¿Instalar la 1.2.0?");
  assert.deepEqual(
    timers.map(([, ms]) => ms),
    [4000],
  );
  timers[0][0]();
  assert.equal(button.textContent, "Actualizar ahora");
  await button.listeners.click[0]();
  const done = button.listeners.click[0]();
  assert.deepEqual(cleared, [2]);
  assert.deepEqual(
    [button.disabled, button.textContent, note.textContent],
    [true, "Instalando…", "Puede tardar un minuto."],
  );
  const banner = page.document.getElementById("updateBanner");
  page.run("showUpdate")({ ...OFFER, available: false });
  assert.equal(banner.classList.contains("hidden"), false);
  release();
  await done;
  assert.equal(gets, 4);
  assert.equal(note.textContent, "Instalada: reiniciando el panel…");
  assert.equal(page.calls.reload, 1);
  assert.deepEqual(page.calls.warnings, ["[odoo] waiting for the restarted dashboard failed: Error: sin red"]);
});

test("«Actualizar ahora» says when the skills were not updated", async () => {
  const { page, start } = updating(async (url, opts) => {
    if (url !== "/api/update") return undefined;
    return opts ? reply({ skills: "no encuentro claude" }) : reply({ current: "1.2.0" });
  });
  await settle();
  start();
  const { button, note } = installer(page);
  await button.listeners.click[0]();
  await button.listeners.click[0]();
  assert.deepEqual([button.textContent, button.disabled, page.calls.reload], ["Instalada", true, 0]);
  assert.deepEqual(showAll(note.children), [
    '"La 1.2.0 ya funciona, pero las skills de Claude Code no se han actualizado (no encuentro claude). Ejecuta "',
    'code "claude plugin update odoo@odoo-wrapper"',
    '" y recarga esta página."',
  ]);
});

test("«Actualizar ahora» gives up after ninety polls and becomes usable again", async () => {
  let gets = 0;
  const { page, start } = updating(async (url, opts) => {
    if (url !== "/api/update") return undefined;
    if (opts) return reply({ skills: "" });
    gets += 1;
    return reply({ current: "1.1.0" });
  });
  await settle();
  start();
  const { button, note } = installer(page);
  await button.listeners.click[0]();
  await button.listeners.click[0]();
  assert.equal(gets, 90);
  assert.equal(
    note.textContent,
    "No se pudo actualizar: el panel no ha vuelto en tres minutos: mira ~/.odoo_dashboard/dashboard.log",
  );
  assert.deepEqual([button.disabled, button.textContent], [false, "Actualizar ahora"]);
});

test("a failed update check leaves a trace in the console", async () => {
  const page = teamPage({
    fetchImpl: answering((url) => {
      if (url === "/api/update") throw new Error("sin red");
    }),
  });
  await settle();
  assert.deepEqual(page.calls.warnings, ["[odoo] the update check failed: Error: sin red"]);
});

test("the Discord dialog is built as the page expects and sits in the document", async () => {
  const page = teamPage();
  await settle();
  const dialog = page.document.getElementById("discordDialog");
  assert.equal(page.document.body.children.includes(dialog), true);
  assert.deepEqual(show(dialog), [
    "dialog#discordDialog.dialog aria-labelledby=discordTitle",
    '  h2#discordTitle "Bot de Discord"',
    "  p#discordStatus.t-note",
    '  p.t-note "Está en discord.com/developers/applications: tu aplicación → Bot → «Restablecer token». Discord solo lo enseña una vez."',
    "  div.edit-row",
    "    input type=password autocomplete=off aria-label=Token del bot",
    '    button.btn.small type=button "Guardar"',
    "  p.dialog-note role=status",
    "  div.dialog-actions",
    '    button.btn.ghost type=button title=Te envía a ti un mensaje de prueba por Discord "Enviar prueba"',
    '    button.btn.ghost type=button "Cerrar"',
  ]);
});

test("the Discord dialog's buttons are disabled while their request is on its way", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const page = teamPage({
    fetchImpl: answering(async (url) => {
      if (!url.startsWith("/api/team/discord/")) return undefined;
      await gate;
      return reply({ bot: "Odoo" });
    }),
  });
  await settle();
  const [, status, , row, note, actions] = page.document.getElementById("discordDialog").children;
  const [, save] = row.children;
  const [test] = actions.children;
  page.run("team.data = null");
  const saving = save.listeners.click[0]();
  const testing = test.listeners.click[0]();
  assert.deepEqual([save.disabled, test.disabled], [true, true]);
  release();
  await Promise.all([saving, testing]);
  assert.deepEqual([save.disabled, test.disabled], [false, false]);
  assert.equal(note.textContent, "Prueba enviada: mira tus mensajes directos de Discord.");
  await save.listeners.click[0]();
  assert.equal(note.textContent, "Guardado: el bot «Odoo» enviará los avisos.");
  assert.equal(status.textContent, "Comprobando si hay un token guardado…");
});

test("the Discord dialog tolerates a page without its element when the page reloads", () => {
  const page = teamPage();
  const real = page.document.getElementById;
  page.document.getElementById = (id) => (id === "discordDialog" ? null : real(id));
  page.run("refreshDiscord()");
  page.document.getElementById = real;
});

const LIMITS = { long_day: 12, under_margin: 1 / 60, over_margin: 5 };
const REASONS = [
  { id: 5, name: "Normal" },
  { id: 3, name: "Descanso" },
];
const stamp = (day, h, m = 0, s = 0) => new Date(2025, 2, day, h, m, s).toISOString();
const punch = (id, start, end, hours, extra = {}) => ({
  id,
  in: start,
  out: end,
  hours,
  rest: false,
  reason: "Normal",
  reason_id: 5,
  ...extra,
});
const dayOf = (extra = {}) => ({
  date: "2025-03-04",
  hours: 9,
  target: 8,
  absence: null,
  sessions: [],
  flags: [],
  requests: [],
  ...extra,
});
const OWNER = { id: 1, name: "Álvaro", discord: null };

function details(page, day, options) {
  const box = element("div");
  page.run("dayDetails")(day, LIMITS, options)(box);
  return showAll(box.children);
}

test("the day's tooltip lists its punches and, when they balance, the difference against the target", () => {
  const page = teamPage();
  const day = dayOf({
    sessions: [punch(1, stamp(4, 9), stamp(4, 17), 8), punch(2, stamp(4, 17, 30), stamp(4, 18, 30), 1)],
  });
  const row = (k, v) => ["div.t-row", `  span.k "${k}"`, `  span.v "${v}"`];
  assert.deepEqual(details(page, day), [
    `div.t-title "Mar 4 mar${Y25}"`,
    ...row("09:00–17:00", "8h"),
    ...row("17:30–18:30", "1h"),
    "div.t-sep",
    ...row("Frente a 8h previstas", "+1h"),
  ]);
  assert.deepEqual(details(page, day, { title: false, sessions: false }), [
    "div.t-sep",
    ...row("Frente a 8h previstas", "+1h"),
  ]);
  const quiet = dayOf({ target: 0, sessions: day.sessions });
  assert.deepEqual(details(page, quiet, { title: false }), [...row("09:00–17:00", "8h"), ...row("17:30–18:30", "1h")]);
  assert.deepEqual(details(page, dayOf(), { title: false }), ['div.t-note "Sin fichajes"']);
  assert.deepEqual(details(page, dayOf({ sessions: [punch(3, stamp(4, 9), null, null)] }), { title: false }), [
    ...row("09:00–abierto", "en curso"),
  ]);
});

test("the day's tooltip says why each flag is there, in orange for a session over the limit, and lists requests", () => {
  const page = teamPage();
  const approvable = {
    id: 7,
    from: stamp(4, 9),
    to: stamp(4, 17, 40),
    status: "pending",
    reason: "Olvidé fichar",
    can_approve: true,
  };
  const draft = { id: 8, from: stamp(4, 9), to: null, status: "new", reason: "", can_approve: false };
  const day = dayOf({
    hours: 14.5,
    sessions: [
      punch(1, stamp(4, 9), stamp(4, 23, 30), 14.5),
      punch(2, stamp(4, 10), stamp(4, 22), 12),
      punch(3, stamp(5, 9), null, null),
    ],
    flags: ["long", "open"],
    requests: [approvable, draft],
  });
  const lines = details(page, day, { title: false, employee: 1 });
  assert.deepEqual(lines, [
    "div.t-row.warn",
    '  span.k "09:00–23:30"',
    '  span.v "14h 30m"',
    "div.t-row",
    '  span.k "10:00–22:00"',
    '  span.v "12h"',
    "div.t-row",
    '  span.k "09:00–abierto"',
    '  span.v "en curso"',
    "div.t-sep",
    'div.t-note.warn "14h 30m fichadas en el día, más de 12h"',
    'div.t-note.warn "Entrada a las 09:00 sin salida"',
    "div.t-sep",
    'div.t-note.pending "Solicitud pendiente 09:00–17:40"',
    'div.t-note "Olvidé fichar"',
    'button.btn.small type=button "Aprobar solicitud"',
    "div.t-sep",
    'div.t-note.new "Solicitud borrador 09:00"',
  ]);
  assert.equal(
    details(page, day, { title: false }).includes('button.btn.small type=button "Aprobar solicitud"'),
    false,
  );
});

test("a request reads by its status, a day by its weekday, and what is open or long says so", () => {
  const { run } = teamPage();
  const requestLine = run("requestLine");
  const asks = ["new", "pending", "approved", "refused"].map((status) =>
    requestLine({ from: stamp(4, 9), to: stamp(4, 17, 40), status }),
  );
  assert.deepEqual(asks, [
    "Solicitud borrador 09:00–17:40",
    "Solicitud pendiente 09:00–17:40",
    "Solicitud aprobada 09:00–17:40",
    "Solicitud rechazada 09:00–17:40",
  ]);
  assert.equal(run("dayLabel")("2025-03-04"), `Mar 4 mar${Y25}`);
  assert.equal(run("dayLabel")("2025-03-04", true), "Mar 4 mar 2025");
  assert.equal(run("dayLabel")("2026-09-15"), "Mar 15 sep");
  assert.equal(run("dayLabel")("2026-09-15", true), "Mar 15 sep 2026");
  const open = punch(1, stamp(4, 9), null, null);
  const done = punch(2, stamp(4, 10), stamp(4, 11), 1);
  assert.deepEqual(run("whyDay")("open", { sessions: [done, open] }, LIMITS), ["Entrada a las 09:00 sin salida"]);
  assert.deepEqual(Array.from(run("whyDay")("empty", { sessions: [], target: 8 }, LIMITS)), [
    "Jornada prevista de 8h sin fichajes ni ausencia",
  ]);
  const balanced = run("balanced");
  assert.deepEqual(
    [
      balanced(dayOf({ sessions: [done] })),
      balanced(dayOf({ sessions: [done], target: 0 })),
      balanced(dayOf({ sessions: [done, open] })),
      balanced(dayOf()),
    ],
    [true, false, false, false],
  );
  const wrong = run("wrongSession");
  assert.deepEqual([wrong({ hours: 12.01 }, LIMITS), wrong({ hours: 12 }, LIMITS)], [true, false]);
  assert.equal(
    run("sessionRow")(punch(1, stamp(4, 9), stamp(4, 21), 12), LIMITS, "x").classList.contains("warn"),
    false,
  );
});

test("the notice joins a day's reasons with semicolons", () => {
  const { run } = teamPage();
  const day = dayOf({ flags: ["empty", "open"], sessions: [punch(1, stamp(4, 9), null, null)] });
  assert.equal(
    run("noticeText")(day, LIMITS),
    "Tienes un error en el fichaje del martes 4 de marzo: jornada prevista de 8h sin fichajes ni ausencia; " +
      "entrada a las 09:00 sin salida.\nPor favor, haz una solicitud de cambio de fichaje en Odoo.",
  );
});

function dialogOf(page) {
  const [title, body, note] = page.document.getElementById("dayDialog").children;
  return { title, body, note, dialog: page.document.getElementById("dayDialog") };
}

test("the day dialog is built as the page expects", async () => {
  const page = teamPage();
  await settle();
  const { dialog } = dialogOf(page);
  assert.equal(page.document.body.children.includes(dialog), true);
  assert.deepEqual(show(dialog), [
    "dialog#dayDialog.dialog aria-labelledby=dayDialogTitle",
    "  h2#dayDialogTitle",
    "  div#dayDialogBody",
    "  p#dayDialogNote.dialog-note role=status",
    "  div.dialog-actions",
    '    button#dayDialogClose.btn.ghost type=button "Cerrar"',
  ]);
  const event = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  dialog.listeners.cancel[0](event);
  assert.equal(event.prevented, false);
  page.document.getElementById("dayDialogClose").disabled = true;
  dialog.listeners.cancel[0](event);
  assert.equal(event.prevented, true);
});

const EDITABLE = {
  limits: LIMITS,
  can_edit: true,
  reasons: REASONS,
  can_message: false,
};
const LONG_DAY = dayOf({
  hours: 21,
  flags: ["long"],
  sessions: [
    punch(1, stamp(4, 9, 0, 30), stamp(4, 17, 0, 15), 8),
    punch(2, stamp(4, 17, 30), stamp(5, 6, 30), 13, { rest: true, reason: "Descanso", reason_id: 3 }),
  ],
});

test("the day dialog edits each punch of the day in a row of its own, and warns of the one that is too long", async () => {
  const page = teamPage();
  await settle();
  const { title, body, note, dialog } = dialogOf(page);
  note.textContent = "antes";
  page.run("openDay")(OWNER, LONG_DAY, EDITABLE);
  assert.equal(dialog.open, true);
  assert.deepEqual([title.textContent, note.textContent], ["Álvaro", ""]);
  assert.deepEqual(showAll(body.children.slice(0, 2)), [
    `div.t-title "Mar 4 mar${Y25}"`,
    "div.editor",
    "  div.edit-row",
    "    input type=time value=09:00 aria-label=Entrada",
    '    "–"',
    "    input type=time value=17:00 aria-label=Salida",
    "    select value=5 aria-label=Motivo",
    '      option value=5 "Normal"',
    '      option value=3 "Descanso"',
    '    button.btn.ghost.small type=button title=Eliminar este fichaje aria-label=Eliminar este fichaje aria-pressed=false "✕"',
    '    button.btn.ghost.small type=button title=Añadir un fichaje debajo aria-label=Añadir un fichaje debajo "+"',
    "  div.edit-row.warn",
    "    input type=time value=17:30 aria-label=Entrada",
    '    "–"',
    "    input type=time value=06:30 aria-label=Salida",
    '    span.meta "salida el 5 mar 2025"',
    "    select value=3 aria-label=Motivo",
    '      option value=5 "Normal"',
    '      option value=3 "Descanso"',
    '    button.btn.ghost.small type=button title=Eliminar este fichaje aria-label=Eliminar este fichaje aria-pressed=false "✕"',
    '    button.btn.ghost.small type=button title=Añadir un fichaje debajo aria-label=Añadir un fichaje debajo "+"',
    "  div.edit-actions",
    '    button.btn.small type=button "Guardar cambios"',
  ]);
  assert.deepEqual(showAll(body.children.slice(2)), [
    "div.t-sep",
    "div.t-row",
    '  span.k "Frente a 8h previstas"',
    '  span.v "+13h"',
    "div.t-sep",
    'div.t-note.warn "21h fichadas en el día, más de 12h"',
    "div.t-sep",
    "div.notice",
    '  button.btn.ghost.small type=button "Preparar aviso…"',
  ]);
});

test("a day without punches opens one empty row, a punch is marked for deletion and unmarked, a new row goes under its row", async () => {
  const page = teamPage();
  await settle();
  const { body } = dialogOf(page);
  const open = (day, context = EDITABLE) => page.run("openDay")(OWNER, day, context);
  const emptyRow = (reason) => [
    "div.edit-row",
    "  input type=time aria-label=Entrada",
    '  "–"',
    "  input type=time aria-label=Salida",
    ...reason,
    '  button.btn.ghost.small type=button title=Añadir un fichaje debajo aria-label=Añadir un fichaje debajo "+"',
  ];
  const selector = [
    "  select value=5 aria-label=Motivo",
    '    option value=5 "Normal"',
    '    option value=3 "Descanso"',
  ];

  open(dayOf());
  assert.deepEqual(showAll(body.children.slice(1, 2)), [
    "div.editor",
    ...emptyRow(selector).map((line) => `  ${line}`),
    "  div.edit-actions",
    '    button.btn.small type=button "Guardar cambios"',
  ]);

  open(dayOf({ sessions: [punch(1, stamp(4, 9), stamp(4, 17), 8, { rest: true })] }), { ...EDITABLE, reasons: [] });
  const [editor] = body.children.slice(1, 2);
  const [row] = editor.children;
  assert.deepEqual(showAll(row.children.slice(3, 4)), ['span.meta "descanso"']);
  const [start, , end, , drop, add] = row.children;
  drop.listeners.click[0]();
  assert.deepEqual(
    [
      row.classList.contains("gone"),
      start.disabled,
      end.disabled,
      drop.title,
      drop.attrs["aria-label"],
      drop.attrs["aria-pressed"],
    ],
    [true, true, true, "No eliminar este fichaje", "No eliminar este fichaje", "true"],
  );
  drop.listeners.click[0]();
  assert.deepEqual(
    [
      row.classList.contains("gone"),
      start.disabled,
      end.disabled,
      drop.title,
      drop.attrs["aria-label"],
      drop.attrs["aria-pressed"],
    ],
    [false, false, false, "Eliminar este fichaje", "Eliminar este fichaje", "false"],
  );
  add.listeners.click[0]();
  assert.equal(editor.children.length, 3);
  assert.deepEqual(show(editor.children[1]), emptyRow([]));
  assert.equal(editor.children[2].className, "edit-actions");
});

test("a read-only dialog lists the punches, and a day with an error folds its message behind a button", async () => {
  const page = teamPage();
  await settle();
  const { body } = dialogOf(page);
  const focused = [];
  const make = page.document.createElement;
  page.document.createElement = (tag) => {
    const node = make(tag);
    node.focus = () => focused.push(tag);
    return node;
  };
  const open = (context) => page.run("openDay")({ ...OWNER, discord: "123" }, LONG_DAY, context);
  open({ ...EDITABLE, can_edit: false });
  assert.deepEqual(showAll(body.children).slice(0, 8), [
    `div.t-title "Mar 4 mar${Y25}"`,
    "div.t-row",
    '  span.k "09:00–17:00"',
    '  span.v "8h"',
    "div.t-row.warn",
    '  span.k "17:30–06:30 descanso"',
    '  span.v "13h"',
    "div.t-sep",
  ]);
  assert.equal(
    body.children.some((child) => child.className === "editor"),
    false,
  );
  const notice = body.children.at(-1);
  assert.deepEqual(show(notice), ["div.notice", '  button.btn.ghost.small type=button "Preparar aviso…"']);

  open({ ...EDITABLE, can_message: true });
  const folded = body.children.at(-1);
  assert.deepEqual(show(folded), ["div.notice", '  button.btn.ghost.small type=button "Avisar por Discord…"']);
  folded.children[0].listeners.click[0]();
  assert.deepEqual(focused, ["textarea"]);
  const text =
    "Tienes un error en el fichaje del martes 4 de marzo: 21h fichadas en el día, más de 12h.\n" +
    "Por favor, haz una solicitud de cambio de fichaje en Odoo.";
  assert.deepEqual(show(folded), [
    "div.notice",
    `  textarea rows=4 value=${text} aria-label=Mensaje para avisar del error`,
    "  div.edit-actions",
    '    button.btn.small type=button title=Al final se añade que es automático, que te escriba a ti y un botón para hacer la solicitud en Odoo "Enviar"',
    '    button.btn.ghost.small type=button "Copiar"',
    '    button.btn.ghost.small type=button "Cancelar"',
  ]);
  folded.children[1].children[2].listeners.click[0]();
  assert.deepEqual(show(folded).length, 2);

  open({ ...EDITABLE, can_message: true });
  const noDiscord = page.run("noticeBox")(OWNER, LONG_DAY, LIMITS, true);
  noDiscord.children[0].listeners.click[0]();
  assert.deepEqual(showAll(noDiscord.children[1].children), [
    'button.btn.small type=button "Copiar"',
    'button.btn.ghost.small type=button "Cancelar"',
    'span.meta "Sin Discord en su ficha de Odoo"',
  ]);
});

test("the dialog shows the dialog once, hides the tooltip and clears the last note when it reopens", async () => {
  const page = teamPage();
  await settle();
  const { dialog, note } = dialogOf(page);
  let shown = 0;
  dialog.showModal = () => {
    shown += 1;
    dialog.open = true;
  };
  const node = element("div");
  page.run("attachTip")(node, (box) => box.appendChild(page.run("el")("div", "t-title", "Hola")));
  node.listeners.pointerenter[0]({ clientX: 1, clientY: 1 });
  note.textContent = "Guardado.";
  page.run("openDay")(OWNER, dayOf(), EDITABLE);
  page.run("openDay")(OWNER, dayOf(), EDITABLE);
  assert.equal(shown, 1);
  assert.deepEqual([page.run("tipOpen()"), note.textContent], [false, ""]);
});

test("a button that acts for real asks to be confirmed, locks the dialog while it works and says what failed", async () => {
  const timers = [],
    cleared = [];
  const page = teamPage({
    globals: {
      setTimeout: (fn, ms) => timers.push([fn, ms]),
      clearTimeout: (id) => cleared.push(id),
    },
  });
  await settle();
  const { note } = dialogOf(page);
  const close = page.document.getElementById("dayDialogClose");
  let release;
  let outcome = Promise.resolve();
  const work = () => outcome;
  const button = page.run("confirmButton")("Aprobar", "No se pudo aprobar", work);
  assert.deepEqual(show(button), ['button.btn.small type=button "Aprobar"']);
  await button.listeners.click[0]();
  assert.equal(button.textContent, "¿Confirmar?");
  assert.deepEqual(
    timers.map(([, ms]) => ms),
    [4000],
  );
  timers[0][0]();
  assert.equal(button.textContent, "Aprobar");
  await button.listeners.click[0]();
  outcome = new Promise((resolve) => {
    release = resolve;
  });
  const done = button.listeners.click[0]();
  assert.deepEqual(cleared, [2]);
  assert.deepEqual([button.textContent, button.disabled, close.disabled], ["Aprobar", true, true]);
  release();
  await done;
  assert.deepEqual([button.disabled, close.disabled, note.textContent], [false, false, ""]);
  await button.listeners.click[0]();
  outcome = Promise.reject(new Error("se solapa"));
  await button.listeners.click[0]();
  assert.equal(note.textContent, "No se pudo aprobar: se solapa");
  assert.deepEqual([button.disabled, close.disabled], [false, false]);
});

test("a punch changed in one field keeps the other as Odoo has it, down to the second", () => {
  const { run } = teamPage();
  const entry = (s, start, end, reason = null, gone = false) => ({
    s,
    start: { value: start },
    end: { value: end },
    reason,
    gone,
  });
  const changes = (entries) => JSON.parse(JSON.stringify(run("punchChanges")("2025-03-04", entries)));
  const s = punch(1, stamp(4, 9, 0, 30), stamp(4, 17, 0, 15), 8);
  assert.deepEqual(changes([entry(s, "09:00", "17:30")]), [
    { id: 1, check_in: s.in, check_out: new Date(2025, 2, 4, 17, 30).toISOString() },
  ]);
  assert.deepEqual(changes([entry(s, "08:45", "17:00")]), [
    { id: 1, check_in: new Date(2025, 2, 4, 8, 45).toISOString(), check_out: s.out },
  ]);
  assert.deepEqual(changes([entry(s, "09:00", "17:00", { value: "3" })]), [
    { id: 1, check_in: s.in, check_out: s.out, reason: 3 },
  ]);
  assert.deepEqual(changes([entry(s, "09:00", "17:00", { value: "5" })]), []);
  assert.deepEqual(changes([entry(null, "10:00", "11:00"), entry(s, "", "", null, true)]), [
    { id: 1, gone: true },
    { check_in: new Date(2025, 2, 4, 10).toISOString(), check_out: new Date(2025, 2, 4, 11).toISOString() },
  ]);
  assert.throws(() => changes([entry(s, "09:00", "")]), /cada fichaje necesita entrada y salida/);
});

test("a reason selector keeps the punch's own reason, even when it is not on offer or missing", () => {
  const { run } = teamPage();
  const field = run("reasonField");
  assert.deepEqual(show(field(null, REASONS)), [
    "select value=5 aria-label=Motivo",
    '  option value=5 "Normal"',
    '  option value=3 "Descanso"',
  ]);
  assert.deepEqual(show(field(punch(1, stamp(4, 9), null, null, { reason: "Otro", reason_id: 9 }), REASONS)), [
    "select value=9 aria-label=Motivo",
    '  option value=9 "Otro"',
    '  option value=5 "Normal"',
    '  option value=3 "Descanso"',
  ]);
  assert.deepEqual(show(field(punch(1, stamp(4, 9), null, null, { reason: null, reason_id: null }), REASONS)), [
    "select aria-label=Motivo",
    '  option "sin motivo"',
    '  option value=5 "Normal"',
    '  option value=3 "Descanso"',
  ]);
});

test("reopening a day reads its week, ignores a person or a day that is not there and logs a failure", async () => {
  let failing = false;
  const page = teamPage({
    fetchImpl: answering((url) => {
      if (failing && url.endsWith("week=2025-03-04")) return reply({ error: "boom" }, 500);
    }),
  });
  await settle();
  const { dialog, note, title } = dialogOf(page);
  await page.run("openDayOf")(99, "2025-03-04");
  await page.run("openDayOf")(1, "2025-03-20");
  assert.equal(dialog.open, false);
  await page.run("openDayOf")(1, "2025-03-04");
  assert.equal(dialog.open, true);
  assert.equal(title.textContent, "Álvaro");
  dialog.open = false;
  failing = true;
  await page.run("refreshDay")(1, "2025-03-04", "Guardado.");
  assert.deepEqual([dialog.open, note.textContent], [false, "Guardado."]);
  assert.deepEqual(page.calls.warnings, ["[odoo] reopening the day failed: Error: boom"]);
});
