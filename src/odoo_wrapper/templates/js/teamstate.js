/*
 * The management view's state and who it shows: the one object the page's modules share (team), the names
 * of the flags, and the two filters every section applies to people. No side effects on import.
 *
 * - «Ocultar archivados», on by default, leaves out people archived in Odoo (who left) everywhere: rows,
 *   counts, charts and «Fichajes por corregir» (listed). Turned off, they show with their departure date.
 * - «Buscar persona» keeps only the people whose name holds the text, ignoring case and accents («lopez»
 *   finds López), as it is typed (named), everywhere: table, charts and «Fichajes por corregir». It opens
 *   the toolbar, as the one filter that crosses every section.
 */
import { isoDay } from "./format.js";

export const FlagText = {
  open: "Sin cerrar", empty: "Sin fichar", long: "Jornada muy larga", off: "Fuera de horario", under: "Bajo objetivo",
  over: "Demasiadas horas",
};

export const FixKinds = ["open", "long", "off", "empty"];

export const thisDay = () => isoDay(new Date());

export const team = {
  data: null, fixes: null, view: "week", week: null, month: thisDay().slice(0, 7), year: thisDay().slice(0, 4),
  filter: "issues", display: "table", hideArchived: true, search: "", fixDay: 10, fixKinds: new Set(FixKinds),
};

const folded = text => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function listed(e) {
  return !(team.hideArchived && e.archived);
}


export function named(e, search) {
  return folded(e.name).includes(folded(search.trim()));
}
