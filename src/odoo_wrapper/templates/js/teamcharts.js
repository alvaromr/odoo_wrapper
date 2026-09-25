/*
 * The chart builders of the management view's «Gráficos» tab: a diverging bar per person and
 * grouped columns per period. They only draw what team.js hands them; which figures to show is its call.
 *
 * - Hand-written SVG, no library, drawn at the width the caller measures (the card's), so text keeps its size on a
 *   wide screen instead of growing with a stretched viewBox; below MIN_WIDTH it is drawn at that width and scaled
 *   down, as the labels would not fit. Colours are the style.css tokens by class, never literals: --chart-short
 *   for hours missing and targets not met, --chart-over for weeks with too many hours, --chart-surplus for a
 *   positive balance, --chart-error for punch errors. That pair was run through the dataviz palette validator in
 *   light and dark (dark --destructive is too light for a mark, hence the separate --chart-short).
 * - One axis per chart, a zero line or baseline, recessive grid. Every mark answers hover and focus with the
 *   shared tooltip; the table tab is the non-visual fallback.
 * - A column's tooltip names the people behind each count (period.people), not only the number: each
 *   series under its own heading, with the swatch of its bars, and a rule between series, so two lists
 *   of names never read as one.
 * - A session strip lays one person's problem marks on a shared time axis (stripAxis): each a bar from its
 *   start to its end with the class the caller gives it (mark.cls), so a repeat offender reads as a row of
 *   marks. Bars have a minimum width, a one-night session is thin. Each mark opens on click or Enter
 *   (mark.open), as a person's bar does.
 *   Both the axis and every strip draw a faint line at each midnight, stronger on Mondays, so a bar reads
 *   against its days at any zoom; marks wholly outside the range are skipped. Strips are drawn at their
 *   real pixel width (the caller's zoom), not stretched, so labels keep their size and the row scrolls.
 * - A diverging bar whose item has an href opens it on click or Enter (a person's own page).
 * - A diverging bar whose item is suspect is orange, a punch error rather than hours short or over, and
 *   carries a ⚠ before its value; the caller explains it. The scale leaves suspect items out and they run to
 *   the edge: one forgotten check-out shrank every other bar to a sliver.
 * - A diverging bar reads left for hours short and right for hours over, value at its end, sorted so the
 *   largest shortfall comes first. Grouped columns carry a count on top of each non-empty bar and a
 *   legend when there is more than one series, so colour is never the only cue.
 */
import { el, attachTip, tipRow } from "./shared.js";

const NS = "http://www.w3.org/2000/svg";
const WIDTH = 1100;
const MIN_WIDTH = 640;

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

export function chartCard(title, note) {
  const card = el("section", "card chart");
  card.appendChild(el("h3", "chart-title", title));
  if (note) card.appendChild(el("p", "chart-note", note));
  return card;
}

export function divergingBars(items, format, size = WIDTH) {
  const width = Math.max(MIN_WIDTH, size);
  const labelWidth = 190, valueWidth = 100, rowHeight = 22, bar = 12;
  const plot = width - labelWidth - 2 * valueWidth;
  const max = Math.max(1, ...items.filter(i => !i.suspect).map(i => Math.abs(i.value)));
  const zero = labelWidth + valueWidth + plot / 2;
  const height = items.length * rowHeight + 8;
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "diverging", role: "img" });
  chart.appendChild(svg("line", { x1: zero, x2: zero, y1: 0, y2: height, class: "zero" }));
  items.forEach((item, i) => {
    const y = 4 + i * rowHeight;
    const length = Math.max(1, Math.min(Math.abs(item.value) / max, 1) * (plot / 2));
    const short = item.value < 0;
    const x = short ? zero - length : zero;
    const group = svg("g", { class: item.href ? "mark link" : "mark", tabindex: 0 });
    if (item.href) {
      group.addEventListener("click", () => location.assign(item.href));
      group.addEventListener("keydown", e => { if (e.key === "Enter") location.assign(item.href); });
    }
    group.appendChild(svg("rect", { x: 0, y, width, height: rowHeight, class: "hit" }));
    const labelAt = { x: labelWidth - 8, y: y + rowHeight / 2 + 4, class: "axis-label", "text-anchor": "end" };
    group.appendChild(svg("text", labelAt, item.label));
    group.appendChild(svg("rect", { x, y: y + (rowHeight - bar) / 2, width: length, height: bar, rx: 2,
      class: item.suspect ? "bar error" : short ? "bar short" : "bar surplus" }));
    group.appendChild(svg("text", {
      x: short ? x - 6 : x + length + 6, y: y + rowHeight / 2 + 4, class: "value-label",
      "text-anchor": short ? "end" : "start",
    }, `${item.suspect ? "⚠ " : ""}${format(item.value)}`));
    attachTip(group, tip => {
      tip.appendChild(el("div", "t-title", item.label));
      for (const [k, v] of item.rows) tip.appendChild(tipRow(k, v));
    });
    chart.appendChild(group);
  });
  return chart;
}

export function groupedColumns(periods, series, size = WIDTH) {
  const width = Math.max(MIN_WIDTH, size);
  const left = 30, bottom = 26, top = 18, height = 220;
  const plot = height - top - bottom;
  const max = Math.max(1, ...periods.flatMap(p => series.map(s => p.values[s.key])));
  const ticks = [...new Set([0, Math.ceil(max / 2), max])];
  const slot = (width - left) / Math.max(1, periods.length);
  const bar = Math.min(22, (slot - 8) / series.length - 2);
  const y = v => top + plot - v / max * plot;
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "columns", role: "img" });
  for (const t of ticks) {
    chart.appendChild(svg("line", { x1: left, x2: width, y1: y(t), y2: y(t), class: t ? "grid" : "zero" }));
    chart.appendChild(svg("text", { x: left - 6, y: y(t) + 4, class: "axis-label", "text-anchor": "end" }, t));
  }
  periods.forEach((period, i) => {
    const x0 = left + i * slot + (slot - series.length * (bar + 2)) / 2;
    const group = svg("g", { class: "mark", tabindex: 0 });
    group.appendChild(svg("rect", { x: left + i * slot, y: top, width: slot, height: plot, class: "hit" }));
    series.forEach((s, j) => {
      const value = period.values[s.key];
      const x = x0 + j * (bar + 2);
      if (value > 0) {
        const tall = top + plot - y(value);
        group.appendChild(svg("rect", { x, y: y(value), width: bar, height: tall, rx: 2, class: `bar ${s.cls}` }));
        const label = { x: x + bar / 2, y: y(value) - 4, class: "value-label", "text-anchor": "middle" };
        group.appendChild(svg("text", label, value));
      }
    });
    const labelAt = { x: left + i * slot + slot / 2, y: height - 8, class: "axis-label", "text-anchor": "middle" };
    group.appendChild(svg("text", labelAt, period.label));
    attachTip(group, tip => {
      tip.appendChild(el("div", "t-title", period.title || period.label));
      series.forEach((s, i) => {
        if (i) tip.appendChild(el("div", "t-sep"));
        const row = tipRow(s.label, String(period.values[s.key]));
        row.children[0].prepend(el("span", `swatch ${s.cls}`));
        tip.appendChild(row);
        for (const name of period.people?.[s.key] || []) tip.appendChild(el("div", "t-note t-name", name));
      });
    });
    chart.appendChild(group);
  });
  return chart;
}

export function legend(series) {
  const row = el("div", "legend-row");
  for (const s of series) {
    const item = el("span", "legend-item");
    item.appendChild(el("span", `swatch ${s.cls}`));
    item.append(s.label);
    row.appendChild(item);
  }
  return row;
}

function frame(cls, role, size) {
  return svg("svg", { viewBox: `0 0 ${size} 18`, width: size, height: 18, class: cls, role });
}

function dayLines(chart, from, to, size, y1, y2) {
  const span = to - from;
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
  for (; day < to; day.setDate(day.getDate() + 1)) {
    const x = (day - from) / span * size;
    chart.appendChild(svg("line", { x1: x, x2: x, y1, y2, class: day.getDay() === 1 ? "monday" : "day" }));
  }
}

export function stripAxis(from, to, ticks, size) {
  const span = to - from;
  const chart = frame("strip-axis", "presentation", size);
  dayLines(chart, from, to, size, 14, 18);
  for (const { at, label } of ticks) {
    const x = (at - from) / span * size;
    chart.appendChild(svg("line", { x1: x, x2: x, y1: 12, y2: 18, class: "grid" }));
    chart.appendChild(svg("text", { x: Math.min(x + 3, size - 40), y: 10, class: "axis-label" }, label));
  }
  return chart;
}

export function sessionStrip(from, to, marks, size) {
  const span = to - from;
  const chart = frame("strip", "img", size);
  dayLines(chart, from, to, size, 0, 18);
  chart.appendChild(svg("line", { x1: 0, x2: size, y1: 9, y2: 9, class: "zero" }));
  for (const mark of marks.filter(m => m.end > from && m.start < to)) {
    const x = Math.max(0, (mark.start - from) / span * size);
    const width = Math.max(4, (Math.min(mark.end, to) - Math.max(mark.start, from)) / span * size);
    const group = svg("g", { class: "mark link", tabindex: 0 });
    group.appendChild(svg("rect", { x: x - 3, y: 0, width: width + 6, height: 18, class: "hit" }));
    group.appendChild(svg("rect", { x, y: 3, width, height: 12, rx: 2, class: `bar ${mark.cls}` }));
    group.addEventListener("click", mark.open);
    group.addEventListener("keydown", e => { if (e.key === "Enter") mark.open(); });
    attachTip(group, mark.tip);
    chart.appendChild(group);
  }
  return chart;
}
