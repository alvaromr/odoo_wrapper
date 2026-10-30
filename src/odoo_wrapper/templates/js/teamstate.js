/*
 * The management view's state and who it shows: the one object the page's modules share (team), the names
 * of the flags, and the filter every section applies to people. No side effects on import.
 *
 * - «Buscar persona» keeps only the people whose name holds the text, ignoring case and accents («lopez»
 *   finds López), as it is typed (named), everywhere: table, charts and «Fichajes por corregir». It has
 *   a row of its own above the toolbar, as the one filter that crosses every section.
 */
import { isoDay } from "./format.js";

/**
 * What team.py sends (the shapes of the day dialog's own data are dayedit.js's typedefs). The balance and the
 * due hours are there exactly when the target is: an employee, week or month without a schedule has none of
 * the three, so a check on the target tells TypeScript about the rest.
 *
 * @typedef {import("./dayedit.js").Day} Day
 * @typedef {import("./dayedit.js").DayFlag} DayFlag
 * @typedef {import("./dayedit.js").Limits} Limits
 * @typedef {import("./dayedit.js").Reason} Reason
 * @typedef {import("./dayedit.js").Session} Session
 * @typedef {"week" | "month" | "year"} ViewName
 * @typedef {"under" | "over"} WeekFlag
 * @typedef {{ target: number, balance: number, due: number } | { target: null, balance: null, due: null }} Schedule
 * @typedef {{ hours: number, suspect: boolean, flagged_days?: number } & Schedule} Total
 * @typedef {Total & { monday: string, flags: WeekFlag[] }} Week
 * @typedef {Total & { month: string, under: number, over: number, flagged_days: number }} Month
 * @typedef {Total & {
 *   id: number,
 *   name: string,
 *   discord: string | null,
 *   flags: WeekFlag[],
 *   flagged_days: number,
 *   pending: number,
 *   weeks: Week[],
 *   days: Day[],
 *   months: Month[],
 * }} Employee  A payload holds only the lists of its view: days and weeks in the week and month views, months in the year's.
 * @typedef {object} TeamData
 * @property {string} week  Monday of the first week
 * @property {string} start
 * @property {string} stop
 * @property {number} [year]  Only in the year's payload
 * @property {string} generated_at
 * @property {Limits} limits
 * @property {Reason[]} reasons
 * @property {Employee[]} employees
 * @property {boolean} can_edit
 * @property {boolean} can_message
 * @typedef {{ date: string, kind: DayFlag, hours: number, target: number, sessions: Pick<Session, "id" | "in" | "out" | "hours">[] }} FixItem
 * @typedef {{ id: number, name: string, items: FixItem[] }} FixEmployee
 * @typedef {{ generated_at: string, limits: Limits, employees: FixEmployee[] }} Fixes
 */

/** @type {Record<string, string>} */
export const FlagText = {
  open: "Sin cerrar",
  empty: "Sin fichar",
  long: "Jornada muy larga",
  under: "Bajo objetivo",
  over: "Demasiadas horas",
};

/** @type {string[]} */
export const FixKinds = ["open", "long", "empty"];

export const thisDay = () => isoDay(new Date());

export const team = {
  /** @type {TeamData | null} */
  data: null,
  /** @type {Fixes | null} */
  fixes: null,
  /** @type {ViewName} */
  view: "week",
  /** @type {string | null} */
  week: null,
  month: thisDay().slice(0, 7),
  year: thisDay().slice(0, 4),
  filter: "issues",
  /** @type {"table" | "charts"} */
  display: "table",
  search: "",
  fixDay: 10,
  fixKinds: new Set(FixKinds),
};

/** @param {string} text */
const folded = (text) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/**
 * @param {{ name: string }} e
 * @param {string} search
 */
export function named(e, search) {
  return folded(e.name).includes(folded(search.trim()));
}
