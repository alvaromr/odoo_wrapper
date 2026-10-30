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
 *   (lunch stamp, settings, mute).
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

/**
 * A session as /api/data sends it (data.py's session_of).
 * @typedef {object} PayloadSession
 * @property {number | null} id
 * @property {string} in
 * @property {string | null} out
 * @property {number | null} hours
 * @property {boolean} rest
 * @property {string | null} reason
 * @property {number | null} reason_id
 */

/**
 * A day off as the payload sends it: a whole day has a type only, one shorter than a day (a leave) also its hours
 * and span.
 * @typedef {object} Absence
 * @property {string} date
 * @property {string} type
 * @property {number} [hours]
 * @property {string} [from]
 * @property {string} [to]
 */

/**
 * A leave shorter than a day: an Absence with its hours and span.
 * @typedef {Absence & {hours: number, from: string, to: string}} Leave
 */

/**
 * The expected hours per weekday (Monday first) and the minute-less hour each lunch starts from.
 * @typedef {object} Schedule
 * @property {number[]} hours
 * @property {(number | null)[]} lunch_from
 */

/**
 * The shared state (state.py).
 * @typedef {object} SharedState
 * @property {string | null} lunch
 * @property {number} lunch_minutes
 * @property {number} break_minutes
 * @property {number} lunch_button_from
 * @property {number} lunch_button_to
 * @property {boolean} muted
 * @property {boolean} lunch_done
 * @property {string | null} punched_at
 */

/**
 * How to reach the dashboard from a phone (lan.py): why not (off), or the two addresses.
 * @typedef {object} Phone
 * @property {string} [off]
 * @property {string} [url]
 * @property {string} [name_url]
 */

/**
 * A pending attendance change request the viewer may approve (team.py's fetch_requests).
 * @typedef {object} ChangeRequest
 * @property {number | null} id
 * @property {string} from
 * @property {string | null} to
 * @property {string} reason
 * @property {string} status
 * @property {boolean} can_approve
 */

/**
 * The /api/data payload (data.py's build_data, and server.py's additions to it).
 * @typedef {object} Payload
 * @property {string} employee
 * @property {number} employee_id
 * @property {boolean} breaks
 * @property {boolean} team
 * @property {string} generated_at
 * @property {number} weeks
 * @property {string} since
 * @property {PayloadSession[]} sessions
 * @property {Absence[]} absences
 * @property {Schedule | null} schedule
 * @property {number} long_hours
 * @property {Object<string, number>} contract_hours
 * @property {Phone | null} phone
 * @property {SharedState} state
 * @property {boolean} can_edit
 * @property {ChangeRequest[]} [requests]
 */

/**
 * A payload session as the page indexes it: dates, and the hours it counts.
 * @typedef {object} DaySession
 * @property {Date} in
 * @property {Date | null} out
 * @property {number} hours
 * @property {boolean} rest
 */

/**
 * One calendar day's indexed sessions and their hours (week.js's indexSessions).
 * @typedef {object} DayRecord
 * @property {number} hours
 * @property {number} rest
 * @property {DaySession[]} sessions
 */

/**
 * The shared mutable object. data, now and today are typed as set because nothing renders before
 * loadAndRender fills them (the code that can run earlier checks store.data first).
 * @typedef {object} Store
 * @property {Payload} data
 * @property {Date} now
 * @property {Date} today
 * @property {Map<string, DayRecord>} byDay
 * @property {Map<string, string>} absMap
 * @property {Map<string, Leave[]>} leaveMap
 * @property {SharedState} state
 * @property {number[]} expected
 * @property {(number | null)[]} lunchFrom
 * @property {number} weekTarget
 * @property {Map<string, number>} contractHours
 * @property {string} since
 * @property {string | null} other
 * @property {number} loadedAt
 * @property {number} triedAt
 * @property {HTMLElement | null} punchEl
 * @property {import("./hero.js").PunchEvent | null} punchEv
 * @property {HTMLElement | null} notifyEl
 * @property {[PayloadSession | undefined, import("./week.js").Day, number] | null} notifyArgs
 */

export const LOOPBACK = ["localhost", "127.0.0.1", "[::1]", "::1"];

/** @type {Schedule} */
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

/** @type {Store} */
export const store = {
  data: /** @type {Payload} */ (/** @type {unknown} */ (null)),
  now: /** @type {Date} */ (/** @type {unknown} */ (null)),
  today: /** @type {Date} */ (/** @type {unknown} */ (null)),
  byDay: new Map(),
  absMap: new Map(),
  leaveMap: new Map(),
  state: {
    lunch: null,
    lunch_minutes: 30,
    break_minutes: 15,
    lunch_button_from: 810,
    lunch_button_to: 960,
    muted: false,
    lunch_done: false,
    punched_at: null,
  },
  expected: NoSchedule.hours,
  lunchFrom: NoSchedule.lunch_from,
  weekTarget: 0,
  contractHours: new Map(),
  since: "",
  other: null,
  loadedAt: 0,
  triedAt: 0,
  punchEl: null,
  punchEv: null,
  notifyEl: null,
  notifyArgs: null,
};
