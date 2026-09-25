/*
 * Shared state and constants of the dashboard page.
 *
 * The page is ES modules loaded through app.js — dashboard.html loads only that one script, as
 * type="module" — so each file can `import` exactly what it needs from the others; a browser serves them
 * as they are, no build step and no bundler. `store` is the one shared mutable object: no module
 * reassigns another module's `let`. A module that needs to change state owned elsewhere mutates a
 * property of `store`, or, for module-private state another file must still be able to touch, calls an
 * exported setter (render.js's setRangeMonths, alarms.js's resetAlarms). Constants that never change stay
 * plain exported `const`s, not store properties.
 *
 * - store.data is the last payload from /api/data; store.now/store.today the clock it was rendered with;
 *   store.byDay, store.absMap and store.leaveMap the indexes built from it; store.state the shared state
 *   (lunch stamp, durations, mute).
 * - store.contractHours holds the payload's contract_hours ({date: hours}, data.py): the days whose contract
 *   in force asked for other hours than the current schedule, which a day's expected hours take first.
 * - store.expected, store.lunchFrom and store.weekTarget come only from the schedule in the payload;
 *   nothing about the user's working week is written here. A calendar that answers nothing means no
 *   expected hours and no target, and the page says so instead of guessing.
 * - store.other is the employee id when the page shows someone else's week (/empleado?id=…, linked from
 *   the management view), null on the user's own dashboard. Then the page only reads: no punch buttons,
 *   no duration fields, no alarms (the server sends a muted state) and no shared-state polling.
 * - store.loadedAt/store.triedAt drive the reload policy in api.js; store.punchEl/store.punchEv/
 *   store.notifyEl/store.notifyArgs are the hero nodes the clock tick and the alarms refresh in place.
 */
export const LOOPBACK = ["localhost", "127.0.0.1", "[::1]", "::1"];

export const NoSchedule = { hours: [0, 0, 0, 0, 0, 0, 0], lunch_from: [null, null, null, null, null, null, null] };
export const LunchMax = 240;
export const AlarmGrace = 2;
export const DayNames = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
export const DayFull = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábados", "domingos"];
export const MonthNames = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
export const NotifyEveryMs = 120000;
export const TickMs = 20000;
export const DataMaxAge = 300000;
export const RetryAfter = 60000;

export const store = {
  data: null, now: null, today: null, byDay: new Map(), absMap: new Map(), leaveMap: new Map(),
  state: { lunch: null, lunch_minutes: 30, break_minutes: 15, muted: false, lunch_done: false, punched_at: null },
  expected: NoSchedule.hours, lunchFrom: NoSchedule.lunch_from, weekTarget: 0, contractHours: new Map(), since: "",
  other: null, loadedAt: 0, triedAt: 0, punchEl: null, punchEv: null, notifyEl: null, notifyArgs: null,
};
