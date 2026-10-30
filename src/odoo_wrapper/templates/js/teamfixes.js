/*
 * «Fichajes por corregir», the management view's card under the table or charts: what to chase whatever the
 * period shown, the punch-error days of each person's whole history (team.py's fetch_fixes, loaded once on
 * its own after the table, again on «Actualizar»), the same the personal page's banner lists.
 *
 * - One row per person, so a repeat offender shows as one row with several marks, most to fix first: chips
 *   counting each kind, and a strip with a line per day where an error's sessions are orange (an open one
 *   solid, running to now) and a missed day an empty orange-edged box. A long day draws only the sessions
 *   to blame (toBlame: over the limit alone), not the normal morning before them, unless none is and the
 *   day is long only by adding up; the tooltips colour the same sessions.
 * - The strip runs from the first error shown to the last (midnight to midnight, and now at most), so a
 *   filter that leaves a few rows narrows it to their dates instead of a long empty stretch, with
 *   FixPadDays more on each side (never past now), so a lone error, or one at either end, has dated weeks
 *   around it. The floating + and − change its pixels per day (team.fixDay, FixZoom); it scrolls sideways
 *   under the fixed name and chip columns, opening at today's end, and down under its fixed header row, at
 *   most 60 % of the window high so a long list does not push the rest of the page away.
 * - It also scrolls by dragging (shared.js's panScroll). A mark opens its day in dayedit.js's dialog
 *   (openFixDay), unless it ends a drag.
 * - «↔» widens the card alone to the whole window and back: the rest of the page reads better narrow, but
 *   the strip is the one thing that gains from the width.
 * - Its own toggles, one per kind of error (FixKinds, all on at first, team.fixKinds), keep only those
 *   errors: a row left with none of the chosen kinds goes, and its chips and marks show only those kinds.
 *   Each counts the people with that kind, whatever the others say, so a toggle turned off still tells how
 *   many it hides. They filter this card only, never the table or the charts; the name search filters it
 *   too (teamstate.js).
 */

import { dayLabel, openDayOf, sessionRow, whyDay, wrongSession } from "./dayedit.js";
import { fmtDate, fmtDay, fmtHM, fmtTime, parseDay, plural, shiftDays } from "./format.js";
import { api, byId, el, panScroll } from "./shared.js";
import { DayNames } from "./store.js";
import { sessionStrip, stripAxis } from "./teamcharts.js";
import { FixKinds, FlagText, named, team } from "./teamstate.js";

/**
 * @typedef {import("./teamstate.js").Fixes} Fixes
 * @typedef {import("./teamstate.js").FixEmployee} FixEmployee
 * @typedef {import("./teamstate.js").FixItem} FixItem
 * @typedef {import("./teamstate.js").Limits} Limits
 * @typedef {import("./teamcharts.js").Mark} Mark
 * @typedef {import("./teamcharts.js").Tick} Tick
 */

export const FixZoom = { min: 2, max: 96, step: 1.5 };
const FixPadDays = 7;
/** @type {ReturnType<typeof panScroll>} */
let fixPan;

/**
 * @param {string} name
 * @param {FixItem} item
 * @returns {(tip: HTMLElement) => void}
 */
export function fixTip(name, item) {
  return (tip) => {
    tip.appendChild(el("div", "t-title", `${name} · ${dayLabel(item.date, true)}`));
    tip.appendChild(el("div", "t-note warn", FlagText[item.kind]));
    for (const s of item.sessions) tip.appendChild(sessionRow(s, /** @type {Fixes} */ (team.fixes).limits, "abierta"));
    const day = { ...item, flags: [item.kind] };
    for (const text of whyDay(item.kind, day, /** @type {Fixes} */ (team.fixes).limits))
      tip.appendChild(el("div", "t-note", text));
  };
}

/**
 * @param {Fixes} fixes
 * @param {Set<string>} [kinds]
 * @returns {FixEmployee[]}
 */
export function fixRows(fixes, kinds = team.fixKinds) {
  const count = (/** @type {FixEmployee} */ r, /** @type {string} */ kind) =>
    r.items.filter((i) => i.kind === kind).length;
  return fixes.employees
    .filter((e) => named(e, team.search))
    .map((r) => ({ ...r, items: r.items.filter((i) => kinds.has(i.kind)) }))
    .filter((r) => r.items.length)
    .sort(
      (a, b) =>
        count(b, "open") - count(a, "open") || b.items.length - a.items.length || a.name.localeCompare(b.name, "es"),
    );
}

/**
 * @template {{ hours: number | null }} T
 * @param {T[]} sessions
 * @param {Pick<Limits, "long_day">} limits
 * @returns {T[]}
 */
export function toBlame(sessions, limits) {
  const wrong = sessions.filter((s) => wrongSession(s, limits));
  return wrong.length ? wrong : sessions;
}

/**
 * @param {FixEmployee} row
 * @param {Date} [now]
 * @returns {Mark[]}
 */
export function fixMarks(row, now = new Date()) {
  const limits = /** @type {Fixes} */ (team.fixes).limits;
  return row.items.flatMap((item) => {
    const tip = fixTip(row.name, item);
    const open = () => openFixDay(row.id, item.date);
    if (item.kind === "empty") {
      const start = parseDay(item.date);
      return [{ start, end: parseDay(shiftDays(item.date, 1)), cls: "missing", tip, open }];
    }
    const sessions = item.kind === "open" ? item.sessions.filter((s) => !s.out) : toBlame(item.sessions, limits);
    return sessions.map((s) => ({
      start: new Date(s.in),
      end: s.out ? new Date(s.out) : now,
      cls: item.kind === "open" ? "error" : "error late",
      tip,
      open,
    }));
  });
}

/**
 * @param {FixEmployee[]} rows
 * @param {Date} [now]
 */
export function fixSpan(rows, now = new Date()) {
  const items = rows.flatMap((r) => r.items);
  /** @type {Date[]} */
  const starts = items.flatMap((i) => (i.sessions.length ? i.sessions.map((s) => new Date(s.in)) : [parseDay(i.date)]));
  /** @type {Date[]} */
  const ends = items.flatMap((i) =>
    i.sessions.length ? i.sessions.map((s) => (s.out ? new Date(s.out) : now)) : [parseDay(shiftDays(i.date, 1))],
  );
  /**
   * @param {Date} d
   * @returns {Date}
   */
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const first = midnight(starts.length ? new Date(Math.min(...starts.map(Number))) : now);
  const last = new Date(Math.max(...ends.map(Number), first.getTime()));
  const end = +last === +midnight(last) ? last : new Date(midnight(last).setDate(last.getDate() + 1));
  const to = new Date(Math.min(now.getTime(), new Date(end).setDate(end.getDate() + FixPadDays)));
  const from = new Date(new Date(first).setDate(first.getDate() - FixPadDays));
  return { from, to, days: Math.max(1, (to.getTime() - from.getTime()) / 864e5) };
}

/** @param {number} pxPerDay */
export function tickStep(pxPerDay) {
  return pxPerDay >= 40 ? 1 : pxPerDay >= 20 ? 2 : pxPerDay >= 6 ? 7 : 14;
}

export function renderFixes() {
  const note = byId("fixesNote");
  const scroller = byId("fixes");
  if (!team.fixes) {
    note.textContent = "Buscando fichajes por corregir en todo el historial…";
    scroller.replaceChildren();
    return;
  }
  const all = fixRows(team.fixes, new Set(FixKinds));
  const rows = fixRows(team.fixes);
  const limits = team.fixes.limits;
  byId("openCard").classList.toggle("hidden", !team.fixes.employees.length);
  note.textContent =
    `Entradas sin cerrar, jornadas de más de ${fmtHM(limits.long_day)} y días con jornada ` +
    "prevista sin fichar, de todo el historial de cada persona y sea cual sea el periodo que estés viendo. " +
    "Una fila por persona." +
    (rows.length
      ? ""
      : team.search.trim()
        ? ` Nadie cuyo nombre contenga «${team.search.trim()}» con los tipos elegidos.`
        : " Nadie con los tipos elegidos.");
  for (const button of byId("fixKinds").querySelectorAll("button")) {
    const kind = /** @type {string} */ (button.dataset.kind);
    button.textContent = `${FlagText[kind]} (${all.filter((r) => r.items.some((i) => i.kind === kind)).length})`;
    button.setAttribute("aria-pressed", String(team.fixKinds.has(kind)));
  }
  const { from, to, days } = fixSpan(rows);
  const size = Math.round(days * team.fixDay);
  const step = tickStep(team.fixDay);
  /** @type {Tick[]} */
  const ticks = [];
  const first = new Date(from);
  if (step >= 7) first.setDate(first.getDate() + ((8 - first.getDay()) % 7));
  for (const d = first; d <= to; d.setDate(d.getDate() + step)) {
    ticks.push({ at: new Date(d), label: step === 1 ? `${DayNames[(d.getDay() + 6) % 7]} ${d.getDate()}` : fmtDay(d) });
  }
  /** @type {HTMLButtonElement} */ (byId("zoomIn")).disabled = team.fixDay >= FixZoom.max;
  /** @type {HTMLButtonElement} */ (byId("zoomOut")).disabled = team.fixDay <= FixZoom.min;
  const grid = el("div", "fix-grid");
  grid.append(el("span", "label", "Persona"), el("span", "label", "Pendiente"), stripAxis(from, to, ticks, size));
  for (const row of rows) {
    const link = el("a", "fix-name", row.name);
    link.href = `/empleado?id=${row.id}`;
    const chips = el("div", "chips");
    for (const item of row.items.filter((i) => i.kind === "open")) {
      const since = new Date(/** @type {FixItem["sessions"][number]} */ (item.sessions.find((s) => !s.out)).in);
      chips.appendChild(el("span", "chip warn", `Abierta desde el ${fmtDate(since)} ${fmtTime(since)}`));
    }
    const of = (/** @type {string} */ kind) => row.items.filter((i) => i.kind === kind);
    const long = of("long");
    if (long.length) {
      const total = fmtHM(long.reduce((sum, i) => sum + i.hours, 0));
      const count = plural(long.length, "jornada muy larga", "jornadas muy largas");
      chips.appendChild(el("span", "chip", `${count} · ${total}`));
    }
    if (of("empty").length) chips.appendChild(el("span", "chip", `${of("empty").length} sin fichar`));
    grid.append(link, chips, sessionStrip(from, to, fixMarks(row, to), size));
  }
  scroller.replaceChildren(grid);
  scroller.scrollLeft = scroller.scrollWidth;
}

/** @param {boolean} [fresh] */
export async function loadFixes(fresh) {
  try {
    team.fixes = /** @type {Fixes} */ (await api(`/api/team?fixes${fresh ? "&fresh" : ""}`));
    renderFixes();
  } catch (e) {
    byId("fixesNote").textContent =
      `No se pudieron cargar los fichajes por corregir: ${/** @type {Error} */ (e).message}`;
  }
}

/**
 * @param {number} employeeId
 * @param {string} date
 */
function openFixDay(employeeId, date) {
  if (fixPan.consume()) return;
  return openDayOf(employeeId, date).catch((e) => {
    byId("fixesNote").textContent = `No se pudo abrir ese día: ${e.message}`;
  });
}

/** @param {() => void} saveState */
export function wireFixes(saveState) {
  const zoomFixes = (/** @type {number} */ factor) => {
    team.fixDay = Math.min(FixZoom.max, Math.max(FixZoom.min, team.fixDay * factor));
    if (team.fixes) renderFixes();
  };
  byId("zoomIn").addEventListener("click", () => zoomFixes(FixZoom.step));
  byId("wideBtn").addEventListener("click", (e) => {
    const wide = byId("openCard").classList.toggle("wide");
    const label = wide ? "Volver al ancho normal" : "Ampliar a todo el ancho";
    /** @type {HTMLElement} */ (e.currentTarget).setAttribute("aria-pressed", String(wide));
    /** @type {HTMLElement} */ (e.currentTarget).setAttribute("aria-label", label);
    /** @type {HTMLElement} */ (e.currentTarget).title = label;
  });
  byId("fixKinds").addEventListener("click", (e) => {
    const button = /** @type {HTMLElement} */ (e.target).closest("button");
    if (!button) return;
    const kind = /** @type {string} */ (button.dataset.kind);
    if (!team.fixKinds.delete(kind)) team.fixKinds.add(kind);
    saveState();
    if (team.fixes) renderFixes();
  });
  fixPan = panScroll(byId("fixes"));
  byId("zoomOut").addEventListener("click", () => zoomFixes(1 / FixZoom.step));
}
