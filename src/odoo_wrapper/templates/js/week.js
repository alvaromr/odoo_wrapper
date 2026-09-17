/*
 * From sessions to days and weeks: the clock the page renders with, the per-day index, and each week's
 * hours, target and delta.
 *
 * - Absence days subtract their expected hours from the week's target. A leave shorter than a day
 *   subtracts just its hours from that day and is kept on the day so the hero and the timeline can show it.
 * - Break sessions count toward the total, same as Odoo's worked_hours. Lunch is checked out, so it is an
 *   unlogged gap that never counts; lunchHours says how much of it the day still owes.
 */
import { store, MonthNames } from "./store.js";
import { fmtHours, fmtHM, dayKey, isoDay, fmtDay } from "./format.js";

export function lunchFrom(date) { return store.lunchFrom[(date.getDay() + 6) % 7]; }

export function lunchOpen(at = new Date()) {
  const from = lunchFrom(at);
  return from != null && at.getHours() + at.getMinutes() / 60 >= from;
}

export function lunchHours(day) {
  return day.vacation || lunchFrom(day.date) == null ? 0 : store.state.lunch_minutes / 60;
}

export function targetLabel(w) { return w.target === store.weekTarget ? fmtHours(store.weekTarget) : fmtHM(w.target); }

export function setClock(date) {
  store.now = date;
  store.today = new Date(store.now.getFullYear(), store.now.getMonth(), store.now.getDate());
}

export function indexSessions() {
  store.byDay = new Map();
  for (const s of store.data.sessions) {
    const inD = new Date(s.in);
    const outD = s.out ? new Date(s.out) : null;
    const hours = s.hours != null ? s.hours : (store.now - inD) / 3.6e6;
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
    const leaves = auto ? [] : store.leaveMap.get(isoDay(date)) || [];
    return {
      date, auto, vacation: !!auto, leaves,
      expected: auto ? 0 : Math.max(store.expected[i] - leaves.reduce((a, l) => a + l.hours, 0), 0),
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
  };
}

export function buildWeeks(nWeeks) {
  return Array.from({ length: nWeeks }, (_, i) => buildWeek(nWeeks - 1 - i));
}

export function weekRangeLabel(w) {
  const a = w.monday, b = w.sunday;
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()}–${b.getDate()} ${MonthNames[b.getMonth()]}`
    : `${fmtDay(a)} – ${fmtDay(b)}`;
}
