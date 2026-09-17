/*
 * Formatting of hours, deltas, clocks and dates, in Spanish. Pure functions, no DOM, no state.
 */
import { MonthNames } from "./store.js";

export function fmtHM(h) {
  const sign = h < 0 ? "−" : "";
  const totalMin = Math.round(Math.abs(h) * 60);
  const H = Math.floor(totalMin / 60), M = totalMin % 60;
  return `${sign}${H}h ${String(M).padStart(2, "0")}m`;
}
export function fmtDelta(h) { return (h >= 0 ? "+" : "") + fmtHM(h); }
export function fmtShort(h) {
  const m = Math.max(0, Math.round(h * 60));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
export function fmtClock(h) {
  const totalMin = Math.round(Math.abs(h) * 60);
  return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, "0")}`;
}
export function fmtDay(d) { return `${d.getDate()} ${MonthNames[d.getMonth()]}`; }
export function fmtTime(d) { return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
export function dayKey(d) { return d.toDateString(); }
export function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function fmtHours(h) { return `${Number(h.toFixed(2))} h`.replace(".", ","); }
export function hourOf(d) { return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; }
