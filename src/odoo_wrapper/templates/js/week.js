/*
 * From sessions to days and weeks: the clock the page renders with, the per-day index, and each week's
 * hours, target and delta.
 *
 * - punchErrors lists the punches to fix over the whole history loaded, as the management view flags them:
 *   sessions still open from before today, days whose total passes long_hours (longDay, however many sessions),
 *   and missed days (a past day that expected hours, after its absences and contract, with no session at all).
 *   dayError is any of the first two on a day.
 * - A session left open from before today (unclosed) counts 0 h, as Odoo and the management view count it:
 *   counted up to now, one left open for weeks made a day of hundreds of hours and a balance hundreds of
 *   hours in favour where the management view read it short. Only today's open session counts live.
 * - The range selector counts months back from today; weeksSince turns them into the weeks from the one
 *   holding that date to the current one.
 * - A week is suspect when a day in it passes the payload's long_hours (longDay): its hours cannot be
 *   trusted, so the page does not tell it reached its target. It has an error when it is suspect or holds
 *   a missed or unclosed day: either way a punch needs fixing.
 * - A day expects its contract's hours when the payload lists it (store.contractHours), the current
 *   schedule's otherwise, and nothing before store.since, the week of the first real punch (data.py says why).
 *   Its scheduled hours are those same hours before any absence or leave: the length of day its calendar gave it.
 * - Absence days subtract their expected hours from the week's target. A leave shorter than a day
 *   subtracts just its hours from that day and is kept on the day so the hero and the timeline can show it.
 * - Break sessions count toward the total, same as Odoo's worked_hours. Lunch is checked out, so it is an
 *   unlogged gap that never counts; lunchHours is the lunch the day allows for. The estimated leave time adds
 *   it only until the day has a gap: once lunch is taken, its actual length is what it is.
 */

import { dayKey, fmtDay, fmtHM, fmtYear, isoDay } from "./format.js";
import { MonthNames, store } from "./store.js";

/**
 * One day of a week: its expected and punched hours, and why it expects none when it does not.
 * @typedef {object} Day
 * @property {Date} date
 * @property {string | null} auto the absence's name (a holiday, a leave of the whole day)
 * @property {boolean} vacation
 * @property {import("./store.js").Leave[]} leaves
 * @property {number} scheduled
 * @property {number} expected
 * @property {number} hours
 * @property {number} rest
 * @property {import("./store.js").DaySession[]} sessions
 */

/**
 * A week, Monday to Sunday, with its totals and what is wrong with it.
 * @typedef {object} Week
 * @property {Date} monday
 * @property {Date} sunday
 * @property {Day[]} days
 * @property {number} total
 * @property {number} rest
 * @property {number} target
 * @property {number} delta
 * @property {boolean} current
 * @property {boolean} complete
 * @property {boolean} allVacation
 * @property {boolean} suspect
 * @property {number} missedDays
 * @property {number} openDays
 * @property {boolean} error
 */

/**
 * A punch to fix: a session left open, a day too long or a day with hours expected and none punched.
 * @typedef {object} PunchError
 * @property {"open" | "long" | "empty"} kind
 * @property {Date} in
 * @property {number} [hours]
 * @property {number} [count]
 * @property {number} [expected]
 */

/**
 * @param {Date} date
 * @returns {number | null}
 */
export function lunchFrom(date) {
  return store.lunchFrom[(date.getDay() + 6) % 7];
}

/** @param {Date} [at] */
export function lunchOpen(at = new Date()) {
  const minute = at.getHours() * 60 + at.getMinutes();
  return lunchFrom(at) != null && minute >= store.state.lunch_button_from && minute < store.state.lunch_button_to;
}

/**
 * @param {Day} day
 * @returns {number}
 */
export function lunchHours(day) {
  return day.vacation || lunchFrom(day.date) == null ? 0 : store.state.lunch_minutes / 60;
}

/**
 * @param {Day} d
 * @returns {boolean}
 */
export function longDay(d) {
  return d.hours > store.data.long_hours;
}

/**
 * @param {{in: Date, out: Date | null}} s
 * @returns {boolean}
 */
export function unclosed(s) {
  return !s.out && s.in < store.today;
}

/**
 * @param {Day} d
 * @returns {boolean}
 */
export function dayError(d) {
  return longDay(d) || d.sessions.some(unclosed);
}

/**
 * @param {Day} d
 * @returns {boolean}
 */
export function missed(d) {
  return d.date < store.today && d.expected > 0 && d.sessions.length === 0;
}

/** @returns {PunchError[]} */
export function punchErrors() {
  /** @type {PunchError[]} */
  const open = store.data.sessions
    .filter((s) => !s.out && new Date(s.in) < store.today)
    .map((s) => ({ kind: "open", in: new Date(s.in) }));
  const days = Array.from({ length: store.data.weeks }, (_, k) => buildWeek(k).days).flat();
  /** @type {PunchError[]} */
  const long = days
    .filter((d) => d.sessions.every((s) => s.out) && longDay(d))
    .map((d) => ({ kind: "long", in: d.date, hours: d.hours, count: d.sessions.length }));
  /** @type {PunchError[]} */
  const empty = days.filter(missed).map((d) => ({ kind: "empty", in: d.date, expected: d.expected }));
  return [...open, ...long, ...empty].sort((a, b) => /** @type {any} */ (b.in) - /** @type {any} */ (a.in));
}

/**
 * @param {Date} date
 * @returns {number}
 */
export function weekOffsetOf(date) {
  /**
   * @param {Date} d
   * @returns {any} a Date, which TypeScript will not subtract
   */
  const monday = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return Math.round((monday(store.today) - monday(date)) / (7 * 864e5));
}

/**
 * @param {Week} w
 * @returns {string}
 */
export function targetLabel(w) {
  return fmtHM(w.target);
}

/** @param {Date} date */
export function setClock(date) {
  store.now = date;
  store.today = new Date(store.now.getFullYear(), store.now.getMonth(), store.now.getDate());
}

export function indexSessions() {
  store.byDay = new Map();
  for (const s of store.data.sessions) {
    const inD = new Date(s.in);
    const outD = s.out ? new Date(s.out) : null;
    const hours =
      s.hours != null
        ? s.hours
        : unclosed({ in: inD, out: outD })
          ? 0
          : /** @type {number} */ (/** @type {any} */ (store.now) - /** @type {any} */ (inD)) / 3.6e6;
    const key = dayKey(inD);
    if (!store.byDay.has(key)) store.byDay.set(key, { hours: 0, rest: 0, sessions: [] });
    const d = /** @type {import("./store.js").DayRecord} */ (store.byDay.get(key));
    d.hours += hours;
    if (s.rest) d.rest += hours;
    d.sessions.push({ in: inD, out: outD, hours, rest: s.rest });
  }
}

/**
 * @param {number} offset weeks back from the current one
 * @returns {Week}
 */
export function buildWeek(offset) {
  const monday = new Date(store.today);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - 7 * offset);
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(monday);
    date.setDate(date.getDate() + i);
    const rec = store.byDay.get(dayKey(date)) || { hours: 0, rest: 0, sessions: [] };
    const auto = store.absMap.get(isoDay(date)) || null;
    const early = isoDay(date) < store.since;
    const leaves = auto ? [] : store.leaveMap.get(isoDay(date)) || [];
    const scheduled = store.contractHours.get(isoDay(date)) ?? store.expected[i];
    return {
      date,
      auto,
      vacation: !!auto,
      leaves,
      scheduled,
      expected: auto || early ? 0 : Math.max(scheduled - leaves.reduce((a, l) => a + l.hours, 0), 0),
      hours: rec.hours,
      rest: rec.rest,
      sessions: rec.sessions,
    };
  });
  const total = days.reduce((a, d) => a + d.hours, 0);
  const rest = days.reduce((a, d) => a + d.rest, 0);
  const target = days.reduce((a, d) => a + d.expected, 0);
  const sunday = days[6].date;
  return {
    monday,
    sunday,
    days,
    total,
    rest,
    target,
    delta: total - target,
    current: monday <= store.today && store.today <= sunday,
    complete: sunday < store.today,
    allVacation: target <= 0,
    suspect: days.some(longDay),
    missedDays: days.filter(missed).length,
    openDays: days.filter((d) => d.sessions.some(unclosed)).length,
    get error() {
      return this.suspect || this.missedDays > 0 || this.openDays > 0;
    },
  };
}

/**
 * @param {number} months
 * @returns {number}
 */
export function weeksSince(months) {
  const start = new Date(store.today.getFullYear(), store.today.getMonth() - months, store.today.getDate());
  /**
   * @param {Date} d
   * @returns {any} a Date, which TypeScript will not subtract
   */
  const monday = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return Math.round((monday(store.today) - monday(start)) / (7 * 864e5)) + 1;
}

/**
 * @param {number} nWeeks
 * @returns {Week[]} the oldest first
 */
export function buildWeeks(nWeeks) {
  return Array.from({ length: nWeeks }, (_, i) => buildWeek(nWeeks - 1 - i));
}

/**
 * @param {Week} w
 * @returns {string}
 */
export function weekRangeLabel(w) {
  const a = w.monday,
    b = w.sunday;
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()}–${b.getDate()} ${MonthNames[b.getMonth()]}${fmtYear(b)}`
    : `${fmtDay(a)}${a.getFullYear() === b.getFullYear() ? "" : fmtYear(a)} – ${fmtDay(b)}${fmtYear(b)}`;
}
