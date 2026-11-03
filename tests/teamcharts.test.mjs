// teamcharts.js: the chart card, the legend, the diverging bars, the grouped columns and the session strip. The
// module's functions are called straight from the page's context, each node dumped as one line (show in page.mjs), so
// a class, an attribute or a text that changes shows up as a failing line.

import assert from "node:assert/strict";
import test from "node:test";
import { element, rounded, show, showAll, teamPage, tipOf } from "./page.mjs";

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
