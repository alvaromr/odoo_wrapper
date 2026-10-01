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
 * - Absence days subtract their expected hours from the week's target. A leave shorter than a day
 *   subtracts just its hours from that day and is kept on the day so the hero and the timeline can show it.
 * - Break sessions count toward the total, same as Odoo's worked_hours. Lunch is checked out, so it is an
 *   unlogged gap that never counts; lunchHours is the lunch the day allows for. The estimated leave time adds
 *   it only until the day has a gap: once lunch is taken, its actual length is what it is.
 */
import { store, MonthNames } from "./store.js";
import { fmtHM, dayKey, isoDay, fmtDay, fmtYear } from "./format.js";

export function lunchFrom(date) { return store.lunchFrom[(date.getDay() + 6) % 7]; }

export function lunchOpen(at = new Date()) {
  const from = lunchFrom(at);
  return from != null && at.getHours() + at.getMinutes() / 60 >= from;
}

export function lunchHours(day) {
  return day.vacation || lunchFrom(day.date) == null ? 0 : store.state.lunch_minutes / 60;
}

export function longDay(d) {
  return d.hours > store.data.long_hours;
}

export function unclosed(s) {
  return !s.out && s.in < store.today;
}

export function dayError(d) {
  return longDay(d) || d.sessions.some(unclosed);
}

export function missed(d) {
  return d.date < store.today && d.expected > 0 && d.sessions.length === 0;
}

export function punchErrors() {
  const open = store.data.sessions
    .filter(s => !s.out && new Date(s.in) < store.today)
    .map(s => ({ kind: "open", in: new Date(s.in) }));
  const days = Array.from({ length: store.data.weeks }, (_, k) => buildWeek(k).days).flat();
  const long = days.filter(d => d.sessions.every(s => s.out) && longDay(d))
    .map(d => ({ kind: "long", in: d.date, hours: d.hours, count: d.sessions.length }));
  const empty = days.filter(missed).map(d => ({ kind: "empty", in: d.date, expected: d.expected }));
  return [...open, ...long, ...empty].sort((a, b) => b.in - a.in);
}

export function weekOffsetOf(date) {
  const monday = d => new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7);
  return Math.round((monday(store.today) - monday(date)) / (7 * 864e5));
}

export function targetLabel(w) { return fmtHM(w.target); }

export function setClock(date) {
  store.now = date;
  store.today = new Date(store.now.getFullYear(), store.now.getMonth(), store.now.getDate());
}

export function indexSessions() {
  store.byDay = new Map();
  for (const s of store.data.sessions) {
    const inD = new Date(s.in);
    const outD = s.out ? new Date(s.out) : null;
    const hours = s.hours != null ? s.hours : unclosed({ in: inD, out: outD }) ? 0 : (store.now - inD) / 3.6e6;
    const key = dayKey(inD);
    if (!store.byDay.has(key)) store.byDay.set(key, { hours: 0, rest: 0, sessions: [] });
    const d = store.byDay.get(key);
    d.hours += hours;
    if (s.rest) d.rest += hours;
    d.sessions.push({ in: inD, out: outD, hours, rest: s.rest });
  }
}

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
    return {
      date, auto, vacation: !!auto, leaves,
      expected: auto || early ? 0 : Math.max((store.contractHours.get(isoDay(date)) ?? store.expected[i])
        - leaves.reduce((a, l) => a + l.hours, 0), 0),
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
    monday, sunday, days, total, rest, target,
    sessions: days.flatMap(d => d.sessions),
    delta: total - target,
    current: monday <= store.today && store.today <= sunday,
    complete: sunday < store.today,
    allVacation: target <= 0,
    suspect: days.some(longDay),
    missedDays: days.filter(missed).length,
    openDays: days.filter(d => d.sessions.some(unclosed)).length,
    get error() { return this.suspect || this.missedDays > 0 || this.openDays > 0; },
  };
}

export function weeksSince(months) {
  const start = new Date(store.today.getFullYear(), store.today.getMonth() - months, store.today.getDate());
  const monday = d => new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7);
  return Math.round((monday(store.today) - monday(start)) / (7 * 864e5)) + 1;
}

export function buildWeeks(nWeeks) {
  return Array.from({ length: nWeeks }, (_, i) => buildWeek(nWeeks - 1 - i));
}

export function weekRangeLabel(w) {
  const a = w.monday, b = w.sunday;
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()}–${b.getDate()} ${MonthNames[b.getMonth()]}${fmtYear(b)}`
    : `${fmtDay(a)}${a.getFullYear() === b.getFullYear() ? "" : fmtYear(a)} – ${fmtDay(b)}${fmtYear(b)}`;
}
