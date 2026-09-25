/*
 * Formatting of hours, deltas, clocks and dates, in Spanish. Pure functions, no DOM, no state.
 * - Hours and minutes drop a zero part and never pad the minutes: «22h 8m», «11m», «109h», never «22h 08m»,
 *   «0h 11m» or «109h 00m»; a zero part is noise. Nothing at all reads «0h», or «0m» for a short span
 *   (fmtShort: «hace 0m»), which also never goes negative.
 * - fmtDate adds the year to fmtDay for lists that span the whole history (the punches to fix), where
 *   «15 dic» alone does not say which December.
 */
import { MonthNames } from "./store.js";

export function fmtHM(h) {
  const sign = h < 0 ? "−" : "";
  const totalMin = Math.round(Math.abs(h) * 60);
  const H = Math.floor(totalMin / 60), M = totalMin % 60;
  return sign + [H || !M ? `${H}h` : "", M ? `${M}m` : ""].filter(Boolean).join(" ");
}
export function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }
export function fmtDelta(h) { return (h >= 0 ? "+" : "") + fmtHM(h); }
export function fmtShort(h) { return Math.round(h * 60) > 0 ? fmtHM(h) : "0m"; }
export function fmtClock(h) {
  const totalMin = Math.round(Math.abs(h) * 60);
  return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, "0")}`;
}
export function fmtDay(d) { return `${d.getDate()} ${MonthNames[d.getMonth()]}`; }
export function fmtDate(d) { return `${fmtDay(d)} ${d.getFullYear()}`; }
export function fmtTime(d) { return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
export function dayKey(d) { return d.toDateString(); }
export function parseDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function shiftDays(iso, days) {
  const d = parseDay(iso);
  d.setDate(d.getDate() + days);
  return isoDay(d);
}
export function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function hourOf(d) { return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; }
