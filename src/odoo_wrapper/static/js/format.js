/*
 * Formatting of hours, deltas, clocks and dates, in Spanish. Pure functions, no DOM, no state.
 * - Hours and minutes drop a zero part and never pad the minutes: «22h 8m», «11m», «109h», never «22h 08m»,
 *   «0h 11m» or «109h 00m»; a zero part is noise. Nothing at all reads «0h», or «0m» for a short span
 *   (fmtShort: «hace 0m»), which also never goes negative.
 * - fmtDate adds the year to fmtDay for lists that span the whole history (the punches to fix), where
 *   «15 dic» alone does not say which December; fmtYear adds it only to a date outside the current year,
 *   for a label that is usually about now (a week, a day) but may be reached from such a list.
 */
import { MonthNames } from "./store.js";

/**
 * @param {number} h
 * @returns {string}
 */
export function fmtHM(h) {
  const sign = h < 0 ? "−" : "";
  const totalMin = Math.round(Math.abs(h) * 60);
  const H = Math.floor(totalMin / 60),
    M = totalMin % 60;
  return sign + [H || !M ? `${H}h` : "", M ? `${M}m` : ""].filter(Boolean).join(" ");
}
/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
/**
 * @param {number} h
 * @returns {string}
 */
export function fmtDelta(h) {
  return (h >= 0 ? "+" : "") + fmtHM(h);
}
/**
 * @param {number} h
 * @returns {string}
 */
export function fmtShort(h) {
  return Math.round(h * 60) > 0 ? fmtHM(h) : "0m";
}
/**
 * @param {number} h
 * @returns {string}
 */
export function fmtClock(h) {
  const totalMin = Math.round(Math.abs(h) * 60);
  return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, "0")}`;
}
/**
 * @param {Date} d
 * @returns {string}
 */
export function fmtDay(d) {
  return `${d.getDate()} ${MonthNames[d.getMonth()]}`;
}
/**
 * @param {Date} d
 * @returns {string}
 */
export function fmtDate(d) {
  return `${fmtDay(d)} ${d.getFullYear()}`;
}
/**
 * @param {Date} d
 * @returns {string}
 */
export function fmtYear(d) {
  return d.getFullYear() === new Date().getFullYear() ? "" : ` ${d.getFullYear()}`;
}
/**
 * @param {Date} d
 * @returns {string}
 */
export function fmtTime(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
/**
 * @param {Date} d
 * @returns {string}
 */
export function dayKey(d) {
  return d.toDateString();
}
/**
 * @param {string} iso
 * @returns {Date}
 */
export function parseDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
/**
 * @param {string} iso
 * @param {number} days
 * @returns {string}
 */
export function shiftDays(iso, days) {
  const d = parseDay(iso);
  d.setDate(d.getDate() + days);
  return isoDay(d);
}
/**
 * @param {Date} d
 * @returns {string}
 */
export function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/**
 * @param {Date} d
 * @returns {number}
 */
export function hourOf(d) {
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}
