/*
 * The management view (/gestion): a week, a month or a year of every employee the Odoo session can read, as
 * a table with a row per person, or as charts. This is the only script team.html loads; of the dashboard's
 * modules it imports only the side-effect-free ones (store.js's constants, format.js), never those that
 * register listeners or read the dashboard's DOM as they load (see shared.js).
 *
 * - Flags come computed from the server (team.py says what each one means); the page only draws them and
 *   tells two kinds apart by colour: orange a punch error (Sin fichar, Sin cerrar, Jornada muy larga, Fuera de
 *   horario, a sum
 *   that holds one, everything in «Fichajes por corregir»), red hours short (Bajo objetivo, a month or year
 *   short) and blue too many (Demasiadas horas), the blue of hours over in the charts. A cell with both a
 *   target and a punch problem takes the target's colour and still names the error in orange; a month with
 *   weeks both under and over is red.
 * - Hovering a cell (or focusing it) opens the shared tooltip with its sessions (an off-hours one in orange, sessionRow), why each flag is there,
 *   in words and with the limits the payload carries, and its change requests with their reason; a click
 *   (or Enter) shows the same in a dialog that stays open, for reading a long reason or copying times:
 *   a click outside does not close it, only «Cerrar» or Escape.
 *   Today's open session is not counted yet (Odoo has no worked_hours for it), so the cell says
 *   «en curso» instead of leaving a bare 0h that reads as not clocked in.
 * - A day's attendance change requests also show under its hours, coloured by status (pending stands out,
 *   the decided ones stay quiet). They are not flags: «Con incidencias» ignores them.
 * - Each name links to that person's own dashboard, read only (/empleado?id=…, see store.js).
 * - The target is judged per week (team.py): a day's balance against its target is only information, in
 *   the day's tooltip and, day by day, in the week cell's tooltip, where a short day and the longer one
 *   that made up for it read side by side.
 * - Every total cell (week, month, year, and each week or month inside them) leads with how far it is off
 *   its target («Faltan 0h 11m», «Sobran 5h 04m», «hasta ayer» while the period runs), then «Xh de Yh»
 *   (summary). A week turns red on its flags; a month or year total turns red whenever its balance falls
 *   short by more than the under margin, since there is no monthly rule to flag it otherwise. A total the
 *   server marks suspect (it holds a «Jornada muy larga» day) is orange and says its sum cannot be trusted;
 *   in the charts its bar carries a ⚠ and a note explains it.
 * - The filter (Filters) opens on «Con incidencias»: the reviewer looks for problems, not for everyone;
 *   «Bajo objetivo» and «Demasiadas horas» narrow it to the weekly flags, each button with its count.
 * - Saturday and Sunday are hidden unless some row shown has a session, a request or a flag on them.
 * - Each week takes Odoo about a second and a half, one query per model, so once a week is shown the page
 *   asks for the previous one in the background, into the server's cache, and stepping back is instant.
 * - «Mes» shows the same people by weeks: one cell per week touching the month, judged whole as in the
 *   week view and saying how many of its days carry a flag, and a «Mes» column adding only the month's own
 *   days, saying how many hours it is short or over (the server's balance, which counts only the days
 *   already over: a month in progress would otherwise owe the hours of days still to come). A click on a
 *   week opens it in the week view.
 * - «Año» does the same by months, from the server's monthly summary (team.py): each month's hours against
 *   its target, how many hours short or over, how many of its weeks were under or over and how many days
 *   carry a flag. Months still to come stay blank. A click on a month opens it in the month view.
 * - The arrows and «Hoy» move by the view's own unit; switching view keeps the period in sight (Views).
 * - «Gráficos» shows the same people, under the same filter, as figures (renderCharts, drawn by
 *   teamcharts.js): each person's balance for the period as a diverging bar, and per day, week or month how many people had punch errors (week view) or weeks under
 *   or over target (month and year views, finished weeks only), each column naming its people on hover.
 *   The charts are drawn at their card's width, and again on resize, so their text keeps its size.
 * - «Fichajes por corregir», under the table or charts, is what to chase whatever the period shown: the
 *   punch-error days of each person's whole history (team.fetch_fixes, loaded once on its own after the
 *   table, again on «Actualizar»), the same the personal page's banner lists. One row per person so a
 *   repeat offender shows as one row with several marks, most to fix first: chips counting each kind, and
 *   a strip with a line per day where an error's sessions are orange (an open one solid, running to now)
 *   and a missed day an empty orange-edged box.
 *   The strip runs from the first error shown to the last (midnight to midnight, and now at most), so a
 *   filter that leaves a few rows narrows it to their dates instead of a long empty stretch, with
 *   FixPadDays more on each side (never past now), so a lone error, or one at either end, has dated weeks
 *   around it; the
 *   floating + and − change its pixels per day (team.fixDay, FixZoom) and it scrolls sideways under the fixed name and chip columns, opening at today's end. It also scrolls by
 *   dragging it: a press that moves more than DragSlop pixels pans instead of clicking, and a press on a
 *   name link is left alone.
 *   «↔» widens the card alone to the whole window and back: the rest of the page reads better narrow, but
 *   the strip is the one thing that gains from the width.
 *   Its own toggles, one per kind of error (FixKinds, all on at first, team.fixKinds), keep only those
 *   errors: a row left with none of the chosen kinds goes, and its chips and marks show only those kinds.
 *   Each counts the people with that kind, whatever the others say, so a toggle turned off still tells
 *   how many it hides. They, and the card's own «Buscar persona» (team.fixSearch), filter this card only,
 *   never the table or the charts.
 * - «Ocultar archivados», on by default, leaves out people archived in Odoo (who left) everywhere: rows,
 *   counts, charts and that card (listed). Turned off, they show with their departure date.
 * - The criteria note under the table is written from the payload's limits (criteria), so it can never
 *   drift from what team.py applies.
 * - «Buscar persona» keeps only the people whose name holds the text, ignoring case and accents («lopez»
 *   finds López), as it is typed (named): the one in the toolbar in the table and the charts, the card's
 *   in the card.
 * - The page keeps its view, period, filter, table or charts, the archived toggle, both searches and the kinds of fixes in the URL hash
 *   (stateHash), and in sessionStorage so the dashboard's «Gestión» link, which has no hash, returns to it
 *   too: coming back from someone's page used to reset everything to this week's table.
 * - Rows are sorted by name with Spanish collation (Á next to A), which Odoo's order does not give.
 */
import { DayNames, MonthNames } from "./store.js";
import { fmtHM, fmtDelta, fmtDay, fmtDate, fmtTime, isoDay, fmtClock, hourOf, dayKey } from "./format.js";
import { el, api, wireLogout, attachTip, hideTip, tipRow } from "./shared.js";
import { chartCard, divergingBars, groupedColumns, legend, stripAxis, sessionStrip } from "./teamcharts.js";

export const FlagText = {
  open: "Sin cerrar", empty: "Sin fichar", long: "Jornada muy larga", off: "Fuera de horario", under: "Bajo objetivo",
  over: "Demasiadas horas",
};

export const FixKinds = ["open", "long", "off", "empty"];

export const RequestText = { new: "Borrador", pending: "Pendiente", approved: "Aprobada", refused: "Rechazada" };

export const Filters = {
  issues: { label: "Con incidencias", keep: e => hasFlags(e), none: "Nadie tiene incidencias esta semana" },
  under: { label: "Bajo objetivo", keep: e => e.flags.includes("under"), none: "Nadie bajo objetivo esta semana" },
  over: { label: "Demasiadas horas", keep: e => e.flags.includes("over"), none: "Nadie con demasiadas horas esta semana" },
  all: { label: "Todas", keep: () => true, none: "Nadie a la vista" },
};

const thisDay = () => isoDay(new Date());

export const team = { data: null, fixes: null, view: "week", week: null, month: thisDay().slice(0, 7), year: thisDay().slice(0, 4),
  filter: "issues", display: "table", hideArchived: true, search: "", fixSearch: "", fixDay: 10,
  fixKinds: new Set(FixKinds) };

export const FixZoom = { min: 2, max: 96, step: 1.5 };
const FixPadDays = 7;
const DragSlop = 3;

export const Views = {
  week: { key: () => team.week, step: n => shiftWeek(team.week, n), now: () => undefined, noun: "esta semana",
    anchor: () => team.week, keep: data => { team.week = data.week; }, keyOf: anchor => anchor },
  month: { key: () => team.month, step: n => shiftMonth(team.month, n), now: () => thisDay().slice(0, 7), noun: "este mes",
    anchor: () => `${team.month}-01`, keep: data => { team.month = data.start.slice(0, 7); }, keyOf: anchor => anchor.slice(0, 7) },
  year: { key: () => team.year, step: n => String(Number(team.year) + n), now: () => thisDay().slice(0, 4), noun: "este año",
    anchor: () => team.year === thisDay().slice(0, 4) ? thisDay() : `${team.year}-01-01`,
    keep: data => { team.year = String(data.year); }, keyOf: anchor => anchor.slice(0, 4) },
};

export function gapText(balance) {
  if (Math.abs(balance) < 1 / 60) return "Al día";
  return balance < 0 ? `Faltan ${fmtHM(-balance)}` : `Sobran ${fmtHM(balance)}`;
}

export function parseDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function shiftDays(iso, days) {
  const d = parseDay(iso);
  d.setDate(d.getDate() + days);
  return isoDay(d);
}

export function shiftWeek(iso, weeks) {
  return shiftDays(iso, 7 * weeks);
}

export function shiftMonth(month, months) {
  const [y, m] = month.split("-").map(Number);
  return isoDay(new Date(y, m - 1 + months, 1)).slice(0, 7);
}

export function monthLabel(month) {
  const text = parseDay(`${month}-01`).toLocaleDateString("es", { month: "long", year: "numeric" });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function weekRange(monday) {
  return `${fmtDay(parseDay(monday))} – ${fmtDay(parseDay(shiftDays(monday, 6)))}`;
}

export function hasFlags(employee) {
  return employee.flags.length > 0 || (employee.days || []).some(d => d.flags.length > 0)
    || (employee.months || []).some(m => m.flagged_days > 0);
}

export function sessionSpan(s) {
  return `${fmtTime(new Date(s.in))}–${s.out ? fmtTime(new Date(s.out)) : "abierto"}${s.rest ? " descanso" : ""}`;
}

export function offSession(s, limits) {
  const [from, to] = [new Date(s.in), s.out && new Date(s.out)];
  return hourOf(from) < limits.work_from || Boolean(to) && (dayKey(to) !== dayKey(from) || hourOf(to) > limits.work_to);
}

export function whyDay(kind, day, limits) {
  if (kind === "open") {
    return day.sessions.filter(s => !s.out).map(s => `Entrada a las ${fmtTime(new Date(s.in))} sin salida`);
  }
  if (kind === "empty") return [`Jornada prevista de ${fmtHM(day.target)} sin fichajes ni ausencia`];
  if (kind === "off") {
    return day.sessions.filter(s => offSession(s, limits)).flatMap(s => {
      const [from, to] = [new Date(s.in), s.out && new Date(s.out)];
      return [
        ...(hourOf(from) < limits.work_from ? [`Entrada a las ${fmtTime(from)}, antes de las ${fmtClock(limits.work_from)}`] : []),
        ...(to && dayKey(to) !== dayKey(from) ? [`Salida otro día, el ${fmtDay(to)} a las ${fmtTime(to)}`]
          : to && hourOf(to) > limits.work_to ? [`Salida a las ${fmtTime(to)}, después de las ${fmtClock(limits.work_to)}`] : []),
      ];
    });
  }
  return [`${fmtHM(day.hours)} fichadas en el día, más de ${fmtHM(limits.long_day)}`];
}

export function balanced(day) {
  return day.target > 0 && day.sessions.length > 0 && day.sessions.every(s => s.out);
}

function dayLabel(iso) {
  const date = parseDay(iso);
  return `${DayNames[(date.getDay() + 6) % 7]} ${fmtDay(date)}`;
}

export function whyWeek(kind, employee, limits) {
  const { hours, target } = employee;
  if (kind === "under") return `${fmtHM(hours)} de ${fmtHM(target)} previstas: faltan ${fmtHM(target - hours)}`;
  return `${fmtHM(hours)} de ${fmtHM(target)} previstas: sobran ${fmtHM(hours - target)}, más de ${fmtHM(limits.over_margin)}`;
}

export function hasData(day) {
  return day.sessions.length > 0 || day.requests.length > 0 || day.flags.length > 0;
}

function dayDetails(day, limits) {
  return tip => {
    tip.appendChild(el("div", "t-title", dayLabel(day.date)));
    if (!day.sessions.length) tip.appendChild(el("div", "t-note", "Sin fichajes"));
    for (const s of day.sessions) tip.appendChild(sessionRow(s, limits, "en curso"));
    if (balanced(day)) {
      tip.appendChild(el("div", "t-sep"));
      tip.appendChild(tipRow(`Frente a ${fmtHM(day.target)} previstas`, fmtDelta(day.hours - day.target)));
    }
    const notes = day.flags.flatMap(kind => whyDay(kind, day, limits));
    if (notes.length) tip.appendChild(el("div", "t-sep"));
    for (const text of notes) tip.appendChild(el("div", "t-note warn", text));
    for (const r of day.requests) {
      tip.appendChild(el("div", "t-sep"));
      tip.appendChild(el("div", `t-note ${r.status}`, requestLine(r)));
      if (r.reason) tip.appendChild(el("div", "t-note", r.reason));
    }
  };
}

export function requestLine(r) {
  const span = `${fmtTime(new Date(r.from))}${r.to ? `–${fmtTime(new Date(r.to))}` : ""}`;
  return `Solicitud ${RequestText[r.status].toLowerCase()} ${span}`;
}

function openDay(employee, day, limits) {
  hideTip();
  document.getElementById("dayDialogTitle").textContent = employee.name;
  const body = document.getElementById("dayDialogBody");
  body.replaceChildren();
  dayDetails(day, limits)(body);
  document.getElementById("dayDialog").showModal();
}

function dayCell(employee, day, today, limits) {
  const td = el("td", "day");
  td.tabIndex = 0;
  td.addEventListener("click", () => openDay(employee, day, limits));
  td.addEventListener("keydown", e => { if (e.key === "Enter") openDay(employee, day, limits); });
  if (day.date === today) td.classList.add("today");
  if (day.date > today) td.classList.add("future");
  if (day.flags.length) td.classList.add("warn");
  const worked = day.hours > 0 || day.sessions.length > 0;
  if (worked) td.appendChild(el("span", "hours", fmtHM(day.hours)));
  const live = day.date === today && day.sessions.some(s => !s.out);
  const meta = [day.absence, live ? "en curso" : ""].filter(Boolean).join(" · ");
  if (meta) td.appendChild(el("span", "meta", worked ? ` ${meta}` : meta));
  for (const flag of day.flags) td.appendChild(el("span", "flag warn", FlagText[flag]));
  for (const r of day.requests) td.appendChild(el("span", `req ${r.status}`, requestLine(r)));
  attachTip(td, dayDetails(day, limits));
  return td;
}

export const SuspectText = "⚠ incluye una jornada muy larga: suma no fiable";

function summary(td, { hours, target, balance, suspect }, running, started = true) {
  if (target != null && started) td.appendChild(el("span", "gap", `${gapText(balance)}${running ? " hasta ayer" : ""}`));
  td.appendChild(el("span", "hours", fmtHM(hours)));
  td.appendChild(el("span", "meta", target == null ? " sin horario" : ` de ${fmtHM(target)}`));
  if (suspect) {
    td.classList.add("warn");
    td.appendChild(el("span", "flag warn", SuspectText));
  }
}

const TargetClass = { under: "bad", over: "over" };

function short(balance, limits) {
  return balance != null && balance <= -limits.under_margin;
}

function totalCell(employee, limits, today, extra = []) {
  const td = el("td", "total");
  const [target] = ["under", "over"].filter(f => employee.flags.includes(f));
  if (target) td.classList.add(TargetClass[target]);
  const days = employee.days;
  summary(td, employee, days.at(-1).date >= today, days[0].date < today);
  for (const text of extra) td.appendChild(el("span", "flag warn", text));
  td.tabIndex = 0;
  attachTip(td, tip => {
    tip.appendChild(el("div", "t-title", "Saldo de la semana, día a día"));
    const days = employee.days.filter(balanced);
    if (!days.length) tip.appendChild(el("div", "t-note", "Ningún día cerrado con jornada prevista"));
    for (const day of days) tip.appendChild(tipRow(dayLabel(day.date), fmtDelta(day.hours - day.target)));
    if (employee.target == null) return;
    tip.appendChild(el("div", "t-sep"));
    for (const kind of employee.flags) tip.appendChild(el("div", `t-note ${TargetClass[kind]}`, whyWeek(kind, employee, limits)));
    if (!employee.flags.length) tip.appendChild(tipRow(`Semana frente a ${fmtHM(employee.target)}`, fmtDelta(employee.hours - employee.target)));
  });
  return td;
}

function weekCell(employee, w, today, limits) {
  const week = employee.weeks[w];
  const days = employee.days.slice(7 * w, 7 * w + 7);
  const flagged = days.filter(d => d.flags.length).length;
  const td = totalCell({ ...week, days }, limits, today,
    flagged ? [`${flagged} ${flagged === 1 ? "día" : "días"} con errores de fichaje`] : []);
  td.classList.add("week");
  if (flagged) td.classList.add("warn");
  if (week.monday <= today && today <= shiftDays(week.monday, 6)) td.classList.add("today");
  const open = () => { hideTip(); team.view = "week"; load(week.monday); };
  td.addEventListener("click", open);
  td.addEventListener("keydown", e => { if (e.key === "Enter") open(); });
  return td;
}

function monthCell(employee, data, today) {
  const td = el("td", "total");
  const balance = employee.balance;
  const running = today < data.stop;
  summary(td, employee, running);
  if (employee.target == null) return td;
  if (short(balance, data.limits)) td.classList.add("bad");
  td.tabIndex = 0;
  attachTip(td, tip => {
    tip.appendChild(el("div", "t-title", "Saldo de cada semana, entera"));
    for (const w of employee.weeks) tip.appendChild(tipRow(weekRange(w.monday), fmtDelta(w.hours - w.target)));
    tip.appendChild(el("div", "t-sep"));
    tip.appendChild(tipRow(running ? "Días del mes hasta ayer" : "Solo los días del mes", fmtDelta(balance)));
  });
  return td;
}

function yearMonthCell(employee, m, today, limits) {
  const td = el("td", "total week");
  if (m.month > today.slice(0, 7)) {
    td.classList.add("future");
    return td;
  }
  const running = m.month === today.slice(0, 7);
  if (running) td.classList.add("today");
  summary(td, m, running);
  if (short(m.balance, limits)) td.classList.add("bad");
  const counts = [
    [m.under, "semana bajo objetivo", "semanas bajo objetivo", "flag"],
    [m.over, "semana con demasiadas horas", "semanas con demasiadas horas", "flag over"],
    [m.flagged_days, "día con errores de fichaje", "días con errores de fichaje", "flag warn"],
  ].filter(([n]) => n > 0);
  for (const [n, one, many, cls] of counts) td.appendChild(el("span", cls, `${n} ${n === 1 ? one : many}`));
  if (m.under) td.classList.add("bad");
  else if (m.over) td.classList.add("over");
  else if (m.flagged_days) td.classList.add("warn");
  td.tabIndex = 0;
  const open = () => { team.view = "month"; load(m.month); };
  td.addEventListener("click", open);
  td.addEventListener("keydown", e => { if (e.key === "Enter") open(); });
  return td;
}

function yearCell(employee, today, limits) {
  const td = el("td", "total");
  summary(td, employee, team.year === today.slice(0, 4));
  if (short(employee.balance, limits)) td.classList.add("bad");
  return td;
}

function columns(data, rows, today) {
  if (team.view === "year") {
    return {
      cols: MonthNames.map((name, i) => {
        const month = `${team.year}-${String(i + 1).padStart(2, "0")}`;
        return { label: name.charAt(0).toUpperCase() + name.slice(1), current: month === today.slice(0, 7),
          cell: e => yearMonthCell(e, e.months[i], today, data.limits) };
      }),
      total: ["Año", e => yearCell(e, today, data.limits)],
    };
  }
  if (team.view === "month") {
    return {
      cols: (data.employees[0]?.weeks || []).map((w, i) => ({
        label: weekRange(w.monday), current: w.monday <= today && today <= shiftDays(w.monday, 6),
        cell: e => weekCell(e, i, today, data.limits),
      })),
      total: ["Mes", e => monthCell(e, data, today)],
    };
  }
  return {
    cols: [0, 1, 2, 3, 4, 5, 6].filter(i => i < 5 || rows.some(e => hasData(e.days[i]))).map(i => {
      const date = shiftDays(data.week, i);
      return { label: `${DayNames[i]} ${parseDay(date).getDate()}`, current: date === today,
        cell: e => dayCell(e, e.days[i], today, data.limits) };
    }),
    total: ["Semana", e => totalCell(e, data.limits, today)],
  };
}

function nameCell(employee) {
  const name = el("td", "name");
  const link = el("a", null, employee.name);
  link.href = `/empleado?id=${employee.id}`;
  name.appendChild(link);
  if (employee.archived) {
    name.appendChild(el("span", "meta block",
      employee.departure_date ? `Baja ${fmtDay(parseDay(employee.departure_date))}` : "Archivado"));
  }
  return name;
}

export function criteria(limits) {
  return `Bajo objetivo: una semana terminada con ${fmtHM(limits.under_margin)} o más por debajo de su `
    + `jornada prevista. Demasiadas horas: una semana terminada con más de ${fmtHM(limits.over_margin)} por encima de ella. `
    + `Jornada muy larga: más de ${fmtHM(limits.long_day)} fichadas en un día. Fuera de horario: una entrada antes de las `
    + `${fmtClock(limits.work_from)} o una salida después de las ${fmtClock(limits.work_to)} o ya en otro día. Sin fichar: un día pasado con jornada prevista y `
    + "sin fichajes ni ausencia. Sin cerrar: una entrada de un día anterior sin salida. La jornada prevista de cada día es "
    + "la del contrato vigente ese día; vacaciones, festivos y permisos la reducen. Los descansos cuentan como horas. "
    + "En naranja, errores de fichaje; en rojo, horas de menos; en azul, demasiadas horas.";
}

export function render() {
  const data = team.data;
  const today = isoDay(new Date());
  document.getElementById("weekLabel").textContent = {
    week: () => `Semana del ${fmtDay(parseDay(data.week))} al ${fmtDay(parseDay(shiftDays(data.week, 6)))}`,
    month: () => monthLabel(team.month),
    year: () => team.year,
  }[team.view]();
  for (const button of document.getElementById("viewSeg").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === team.view));
  }
  const people = data.employees.filter(e => listed(e) && named(e, team.search));
  document.getElementById("criteria").textContent = criteria(data.limits);
  const generated = new Date(data.generated_at);
  document.getElementById("subtitle").textContent =
    `${people.length} ${people.length === 1 ? "persona" : "personas"} · actualizado el ${fmtDay(generated)} a las ${fmtTime(generated)}`;
  const archivedButton = document.getElementById("archivedBtn");
  const archived = data.employees.filter(e => e.archived).length;
  archivedButton.setAttribute("aria-pressed", String(team.hideArchived));
  archivedButton.textContent = team.hideArchived && archived ? `Ocultar archivados (${archived})` : "Ocultar archivados";

  for (const button of document.getElementById("filterSeg").querySelectorAll("button")) {
    const filter = Filters[button.dataset.filter];
    button.textContent = `${filter.label} (${people.filter(filter.keep).length})`;
    button.setAttribute("aria-pressed", String(button.dataset.filter === team.filter));
  }

  renderFixes();

  const table = document.getElementById("grid");
  const rows = people.filter(Filters[team.filter].keep).sort((a, b) => a.name.localeCompare(b.name, "es"));
  const { cols, total } = columns(data, rows, today);
  const head = el("tr");
  head.appendChild(el("th", null, "Persona"));
  for (const col of cols) head.appendChild(el("th", col.current ? "today" : null, col.label));
  head.appendChild(el("th", null, total[0]));
  const thead = el("thead");
  thead.appendChild(head);
  const tbody = el("tbody");
  for (const employee of rows) {
    const tr = el("tr");
    tr.appendChild(nameCell(employee));
    for (const col of cols) tr.appendChild(col.cell(employee));
    tr.appendChild(total[1](employee));
    tbody.appendChild(tr);
  }
  table.replaceChildren(thead, tbody);
  if (rows.length === 0) {
    const td = el("td", "empty-state", team.search.trim() ? `Nadie cuyo nombre contenga «${team.search.trim()}»`
      : Filters[team.filter].none.replace("esta semana", Views[team.view].noun));
    td.colSpan = cols.length + 2;
    const tr = el("tr");
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  for (const button of document.getElementById("displaySeg").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.display === team.display));
  }
  const charts = team.display === "charts";
  if (charts) renderCharts(data, rows, today);
  document.getElementById("loadmsg").classList.add("hidden");
  document.getElementById("gridCard").classList.toggle("hidden", charts);
  document.getElementById("charts").classList.toggle("hidden", !charts);
  saveState();
}

const FixText = { open: "Sin cerrar", long: "Jornada muy larga", off: "Fuera de horario", empty: "Sin fichar" };

function sessionRow(s, limits, open) {
  const row = tipRow(sessionSpan(s), s.hours == null ? open : fmtHM(s.hours));
  if (offSession(s, limits)) row.classList.add("warn");
  return row;
}

function fixTip(name, item) {
  return tip => {
    tip.appendChild(el("div", "t-title", `${name} · ${dayLabel(item.date)} ${parseDay(item.date).getFullYear()}`));
    tip.appendChild(el("div", "t-note warn", FixText[item.kind]));
    for (const s of item.sessions) tip.appendChild(sessionRow(s, team.fixes.limits, "abierta"));
    const day = { ...item, flags: [item.kind] };
    for (const text of whyDay(item.kind, day, team.fixes.limits)) tip.appendChild(el("div", "t-note", text));
  };
}

const folded = text => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

function listed(e) {
  return !(team.hideArchived && e.archived);
}

function named(e, search) {
  return folded(e.name).includes(folded(search.trim()));
}

export function fixRows(fixes, kinds = team.fixKinds) {
  const count = (r, kind) => r.items.filter(i => i.kind === kind).length;
  return fixes.employees.filter(e => listed(e) && named(e, team.fixSearch))
    .map(r => ({ ...r, items: r.items.filter(i => kinds.has(i.kind)) })).filter(r => r.items.length)
    .sort((a, b) => count(b, "open") - count(a, "open") || b.items.length - a.items.length || a.name.localeCompare(b.name, "es"));
}

export function fixMarks(row, now = new Date()) {
  const limits = team.fixes.limits;
  return row.items.flatMap(item => {
    const tip = fixTip(row.name, item);
    if (item.kind === "empty") {
      const start = parseDay(item.date);
      return [{ start, end: parseDay(shiftDays(item.date, 1)), cls: "missing", tip }];
    }
    const sessions = item.kind === "open" ? item.sessions.filter(s => !s.out)
      : item.kind === "off" ? item.sessions.filter(s => offSession(s, limits)) : item.sessions;
    return sessions.map(s => ({ start: new Date(s.in), end: s.out ? new Date(s.out) : now,
      cls: item.kind === "open" ? "error" : "error late", tip }));
  });
}

const StateKey = "gestion";

export function stateHash() {
  const params = new URLSearchParams({ v: team.view, p: Views[team.view].key() || "", f: team.filter,
    d: team.display, a: team.hideArchived ? "1" : "0",
    k: FixKinds.filter(k => team.fixKinds.has(k)).join(","), ...(team.search ? { q: team.search } : {}),
    ...(team.fixSearch ? { fq: team.fixSearch } : {}) });
  return `#${params}`;
}

export function readState(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if (Views[params.get("v")]) team.view = params.get("v");
  if (Filters[params.get("f")]) team.filter = params.get("f");
  if (["table", "charts"].includes(params.get("d"))) team.display = params.get("d");
  if (params.get("a") === "0") team.hideArchived = false;
  team.search = params.get("q") || "";
  team.fixSearch = params.get("fq") || "";
  document.getElementById("search").value = team.search;
  document.getElementById("fixSearch").value = team.fixSearch;
  if (params.has("k")) team.fixKinds = new Set(params.get("k").split(",").filter(k => FixKinds.includes(k)));
  return params.get("p") || undefined;
}

function saveState() {
  const hash = stateHash();
  globalThis.history?.replaceState(null, "", hash);
  try { sessionStorage.setItem(StateKey, hash); } catch (e) {}
}

function restoreState() {
  let saved = "";
  try { saved = sessionStorage.getItem(StateKey) || ""; } catch (e) {}
  return readState(location.hash || saved);
}

export function fixSpan(rows, now = new Date()) {
  const items = rows.flatMap(r => r.items);
  const starts = items.flatMap(i => i.sessions.length ? i.sessions.map(s => new Date(s.in)) : [parseDay(i.date)]);
  const ends = items.flatMap(i => i.sessions.length ? i.sessions.map(s => s.out ? new Date(s.out) : now)
    : [parseDay(shiftDays(i.date, 1))]);
  const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const first = midnight(starts.length ? new Date(Math.min(...starts)) : now);
  const last = new Date(Math.max(...ends, first));
  const end = +last === +midnight(last) ? last : new Date(midnight(last).setDate(last.getDate() + 1));
  const to = new Date(Math.min(now, new Date(end).setDate(end.getDate() + FixPadDays)));
  const from = new Date(new Date(first).setDate(first.getDate() - FixPadDays));
  return { from, to, days: Math.max(1, (to - from) / 864e5) };
}

export function tickStep(pxPerDay) {
  return pxPerDay >= 40 ? 1 : pxPerDay >= 20 ? 2 : pxPerDay >= 6 ? 7 : 14;
}

function renderFixes() {
  const note = document.getElementById("fixesNote");
  const scroller = document.getElementById("fixes");
  if (!team.fixes) {
    note.textContent = "Buscando fichajes por corregir en todo el historial…";
    scroller.replaceChildren();
    return;
  }
  const all = fixRows(team.fixes, new Set(FixKinds));
  const rows = fixRows(team.fixes);
  const limits = team.fixes.limits;
  document.getElementById("openCard").classList.toggle("hidden", !team.fixes.employees.some(listed));
  note.textContent = `Entradas sin cerrar, jornadas de más de ${fmtHM(limits.long_day)}, fichajes fuera de `
    + `${fmtClock(limits.work_from)} a ${fmtClock(limits.work_to)} y días con jornada prevista sin fichar, de todo el `
    + "historial de cada persona y sea cual sea el periodo que estés viendo. Una fila por persona."
    + (rows.length ? "" : team.fixSearch.trim() ? ` Nadie cuyo nombre contenga «${team.fixSearch.trim()}» con los tipos elegidos.`
      : " Nadie con los tipos elegidos.");
  for (const button of document.getElementById("fixKinds").querySelectorAll("button")) {
    const kind = button.dataset.kind;
    button.textContent = `${FlagText[kind]} (${all.filter(r => r.items.some(i => i.kind === kind)).length})`;
    button.setAttribute("aria-pressed", String(team.fixKinds.has(kind)));
  }
  const { from, to, days } = fixSpan(rows);
  const size = Math.round(days * team.fixDay);
  const step = tickStep(team.fixDay);
  const ticks = [];
  const first = new Date(from);
  if (step >= 7) first.setDate(first.getDate() + (8 - first.getDay()) % 7);
  for (const d = first; d <= to; d.setDate(d.getDate() + step)) {
    ticks.push({ at: new Date(d), label: step === 1 ? `${DayNames[(d.getDay() + 6) % 7]} ${d.getDate()}` : fmtDay(d) });
  }
  document.getElementById("zoomIn").disabled = team.fixDay >= FixZoom.max;
  document.getElementById("zoomOut").disabled = team.fixDay <= FixZoom.min;
  const grid = el("div", "fix-grid");
  grid.append(el("span", "label", "Persona"), el("span", "label", "Pendiente"), stripAxis(from, to, ticks, size));
  for (const row of rows) {
    const link = el("a", "fix-name", row.name);
    link.href = `/empleado?id=${row.id}`;
    const chips = el("div", "chips");
    for (const item of row.items.filter(i => i.kind === "open")) {
      const since = new Date(item.sessions.find(s => !s.out).in);
      chips.appendChild(el("span", "chip warn", `Abierta desde el ${fmtDate(since)} ${fmtTime(since)}`));
    }
    const of = kind => row.items.filter(i => i.kind === kind);
    const long = of("long");
    if (long.length) {
      chips.appendChild(el("span", "chip", `${long.length} ${long.length === 1 ? "jornada muy larga" : "jornadas muy largas"} · `
        + fmtHM(long.reduce((sum, i) => sum + i.hours, 0))));
    }
    if (of("off").length) chips.appendChild(el("span", "chip", `${of("off").length} fuera de horario`));
    if (of("empty").length) chips.appendChild(el("span", "chip", `${of("empty").length} sin fichar`));
    grid.append(link, chips, sessionStrip(from, to, fixMarks(row, to), size));
  }
  scroller.replaceChildren(grid);
  scroller.scrollLeft = scroller.scrollWidth;
}

const Series = {
  flagged: { key: "flagged", label: "Personas con errores de fichaje", cls: "error" },
  under: { key: "under", label: "Bajo objetivo", cls: "short" },
  over: { key: "over", label: "Demasiadas horas", cls: "over" },
};

function periods(data, rows, today) {
  const sorted = rows.slice().sort((a, b) => a.name.localeCompare(b.name, "es"));
  const who = tests => Object.fromEntries(Object.entries(tests).map(([key, test]) => [key, sorted.filter(test).map(e => e.name)]));
  const period = (base, tests) => {
    const people = who(tests);
    return { ...base, people, values: Object.fromEntries(Object.entries(people).map(([key, names]) => [key, names.length])) };
  };
  if (team.view === "year") {
    return MonthNames.map((name, i) => period({
      label: name, title: monthLabel(`${team.year}-${String(i + 1).padStart(2, "0")}`),
      month: `${team.year}-${String(i + 1).padStart(2, "0")}`,
    }, { under: e => e.months[i].under > 0, over: e => e.months[i].over > 0 })).filter(p => p.month <= today.slice(0, 7));
  }
  if (team.view === "month") {
    return (data.employees[0]?.weeks || []).map((w, i) => period({ label: fmtDay(parseDay(w.monday)), title: weekRange(w.monday) },
      { under: e => e.weeks[i].flags.includes("under"), over: e => e.weeks[i].flags.includes("over") }));
  }
  return [0, 1, 2, 3, 4, 5, 6].filter(i => i < 5 || rows.some(e => hasData(e.days[i]))).map(i =>
    period({ label: DayNames[i], title: dayLabel(shiftDays(data.week, i)) }, { flagged: e => e.days[i].flags.length > 0 }));
}

function renderCharts(data, rows, today) {
  const box = document.getElementById("charts");
  const running = today < data.stop;
  const noun = { week: "la semana", month: "el mes", year: "el año" }[team.view];
  const judged = rows.filter(e => e.balance != null);
  box.replaceChildren();

  const people = chartCard(`Saldo de cada persona en ${noun}`,
    `Horas de fichajes cerrados menos jornada prevista${running ? ", hasta ayer: hoy aún no cuenta" : ""}. `
    + "Una entrada sin cerrar no suma horas, así que resta como si faltaran. A la izquierda faltan, a la derecha sobran.");
  const items = judged.slice().sort((a, b) => a.balance - b.balance).map(e => ({
    label: e.name, value: e.balance, suspect: Boolean(e.suspect), href: `/empleado?id=${e.id}`,
    rows: [["Fichadas", fmtHM(e.hours)], ["Previstas", fmtHM(e.target)], ["Saldo", gapText(e.balance)],
      ...(e.suspect ? [["Aviso", "incluye una jornada muy larga"]] : [])],
  }));
  box.appendChild(people);
  const width = people.children[0].clientWidth || undefined;
  people.appendChild(items.length ? divergingBars(items, v => fmtDelta(v), width) : el("p", "chart-note", "Nadie con jornada prevista"));
  if (items.some(i => i.suspect)) {
    people.appendChild(el("p", "chart-note", "⚠ Saldo no fiable: incluye una jornada muy larga, casi siempre una salida sin fichar."));
  }

  const series = team.view === "week" ? [Series.flagged] : [Series.under, Series.over];
  const timeline = chartCard(team.view === "week" ? "Personas con incidencias cada día" : "Personas con semanas fuera de objetivo",
    team.view === "week" ? "Días sin fichar, sin cerrar, fuera de horario o con una jornada muy larga."
      : "Cada semana se cuenta entera y solo si ya ha terminado.");
  if (series.length > 1) timeline.appendChild(legend(series));
  timeline.appendChild(groupedColumns(periods(data, rows, today), series, width));
  box.appendChild(timeline);
}

export async function load(key, fresh) {
  const unit = team.view;
  const params = [key ? `${unit}=${key}` : "", fresh ? "fresh" : ""].filter(Boolean).join("&");
  const loadmsg = document.getElementById("loadmsg");
  try {
    const data = await api(`/api/team${params ? `?${params}` : ""}`);
    team.data = data;
    Views[unit].keep(data);
    render();
    if (fresh || !team.fixes) loadFixes(fresh);
    if (unit !== "year") fetch(`/api/team?${unit}=${Views[unit].step(-1)}`).catch(() => {});
  } catch (e) {
    loadmsg.textContent = "Error cargando datos de Odoo: " + e.message;
    loadmsg.classList.remove("hidden");
  }
}

export async function loadFixes(fresh) {
  try {
    team.fixes = await api(`/api/team?fixes${fresh ? "&fresh" : ""}`);
    renderFixes();
  } catch (e) {
    document.getElementById("fixesNote").textContent = "No se pudieron cargar los fichajes por corregir: " + e.message;
  }
}

async function busyWhile(button, work) {
  button.disabled = true;
  try { await work(); } finally { button.disabled = false; }
}

const view = () => Views[team.view];
document.getElementById("prevWeek").addEventListener("click", e => busyWhile(e.currentTarget, () => load(view().step(-1))));
document.getElementById("nextWeek").addEventListener("click", e => busyWhile(e.currentTarget, () => load(view().step(1))));
document.getElementById("thisWeek").addEventListener("click", e => busyWhile(e.currentTarget, () => load(view().now())));
document.getElementById("refreshBtn").addEventListener("click", e =>
  busyWhile(e.currentTarget, () => load(view().key(), true)));
document.getElementById("viewSeg").addEventListener("click", e => {
  const button = e.target.closest("button");
  if (!button || button.dataset.view === team.view) return;
  const anchor = team.data ? view().anchor() : thisDay();
  team.view = button.dataset.view;
  load(view().keyOf(anchor));
});
const zoomFixes = factor => {
  team.fixDay = Math.min(FixZoom.max, Math.max(FixZoom.min, team.fixDay * factor));
  if (team.fixes) renderFixes();
};
document.getElementById("zoomIn").addEventListener("click", () => zoomFixes(FixZoom.step));
document.getElementById("wideBtn").addEventListener("click", e => {
  const wide = document.getElementById("openCard").classList.toggle("wide");
  const label = wide ? "Volver al ancho normal" : "Ampliar a todo el ancho";
  e.currentTarget.setAttribute("aria-pressed", String(wide));
  e.currentTarget.setAttribute("aria-label", label);
  e.currentTarget.title = label;
});
document.getElementById("fixKinds").addEventListener("click", e => {
  const button = e.target.closest("button");
  if (!button) return;
  const kind = button.dataset.kind;
  if (!team.fixKinds.delete(kind)) team.fixKinds.add(kind);
  saveState();
  if (team.fixes) renderFixes();
});
const fixScroller = document.getElementById("fixes");
let fixDrag = null;
fixScroller.addEventListener("pointerdown", e => {
  if (e.button !== 0 || e.target.closest("a")) return;
  fixDrag = { x: e.clientX, left: fixScroller.scrollLeft, moved: false };
  fixScroller.setPointerCapture?.(e.pointerId);
});
fixScroller.addEventListener("pointermove", e => {
  if (!fixDrag) return;
  const dx = e.clientX - fixDrag.x;
  if (!fixDrag.moved && Math.abs(dx) > DragSlop) {
    fixDrag.moved = true;
    fixScroller.classList.add("dragging");
    hideTip();
  }
  if (fixDrag.moved) fixScroller.scrollLeft = fixDrag.left - dx;
});
const endFixDrag = () => {
  fixDrag = null;
  fixScroller.classList.remove("dragging");
};
fixScroller.addEventListener("pointerup", endFixDrag);
fixScroller.addEventListener("pointercancel", endFixDrag);
document.getElementById("zoomOut").addEventListener("click", () => zoomFixes(1 / FixZoom.step));
document.getElementById("archivedBtn").addEventListener("click", () => {
  team.hideArchived = !team.hideArchived;
  if (team.data) render();
});
document.getElementById("fixSearch").addEventListener("input", e => {
  team.fixSearch = e.target.value;
  saveState();
  if (team.fixes) renderFixes();
});
document.getElementById("search").addEventListener("input", e => {
  team.search = e.target.value;
  saveState();
  if (team.data) render();
});
addEventListener("resize", () => {
  if (team.data && team.display === "charts") render();
});
document.getElementById("displaySeg").addEventListener("click", e => {
  const button = e.target.closest("button");
  if (!button) return;
  team.display = button.dataset.display;
  if (team.data) render();
});
document.getElementById("filterSeg").addEventListener("click", e => {
  const button = e.target.closest("button");
  if (!button) return;
  team.filter = button.dataset.filter;
  if (team.data) render();
});
const dialog = document.getElementById("dayDialog");
document.getElementById("dayDialogClose").addEventListener("click", () => dialog.close());
wireLogout(document.getElementById("logoutBtn"));

load(restoreState());
