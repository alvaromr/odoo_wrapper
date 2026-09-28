/*
 * The management view (/gestion): a week, a month or a year of every employee the Odoo session can read, as
 * a table with a row per person, or as charts. This is the only script team.html loads; of the dashboard's
 * modules it imports only the side-effect-free ones (store.js's constants, format.js), never those that
 * register listeners or read the dashboard's DOM as they load (see shared.js).
 *
 * - Flags come computed from the server (team.py says what each one means); the page only draws them and
 *   tells two kinds apart by colour: orange a punch error (Sin fichar, Sin cerrar, Jornada muy larga, Fuera de
 *   horario, a sum that holds one, everything in «Fichajes por corregir»), red a target not met, short or
 *   over (Bajo objetivo, Demasiadas horas, a month or year short); blue is kept for change requests.
 *   style.css says how the charts tell short from too many. A cell with both a target and a punch problem
 *   takes the target's colour and still names the error in orange.
 * - Hovering a cell (or focusing it) opens the day's details in the shared tooltip, and a click (or Enter)
 *   the dialog that corrects it; both are dayedit.js, shared with the personal page. A mark in «Fichajes
 *   por corregir» opens the same dialog for its day (openFixDay), unless it ends a drag. After a write the
 *   page reloads the period and the fixes (onDaySaved).
 *   Today's open session is not counted yet (Odoo has no worked_hours for it), so the cell says
 *   «en curso» instead of leaving a bare 0h that reads as not clocked in.
 * - A day's attendance change requests also show under its hours, coloured by status (pending stands out,
 *   the decided ones stay quiet). They are not flags: «Con incidencias» ignores them.
 * - Each name links to that person's own dashboard, read only (/empleado?id=…, see store.js).
 * - The target is judged per week (team.py): a day's balance against its target is only information, in
 *   the day's tooltip and, day by day, in the week cell's tooltip, where a short day and the longer one
 *   that made up for it read side by side.
 * - Every total cell (week, month, year, and each week or month inside them) leads with how far it is off
 *   its target («Faltan 11m», «Sobran 5h 4m»), then «Xh de Yh» (summary); while the period runs both count
 *   up to yesterday («hasta ayer»), so the two lines always add up.
 * - Red means a target missed that nothing explains or makes up for, the same in the table, the charts and
 *   the filters. A cell is red only without punch errors in it (the server judges no week holding one, and a
 *   month or a year counts its flagged days), and only when the view's whole period does not make it up
 *   (weekRed, monthRed): a short week in the month view is red only if the month is short too, a short month
 *   in the year view only if the year is, and a week or month with too many hours only if the period's
 *   surplus passes the over margin as well. The view's own total is judged by its balance alone (totalShort).
 *   What is made up still says so, «1 semana bajo objetivo», without the red, and the click leads to it.
 *   Orange is never made up: every cell holding a punch error is orange down to the day, so a click at a time
 *   leads from the year to it, and a sum holding a «Jornada muy larga» says it cannot be trusted. In the
 *   charts a balance with punch errors is an orange bar with a ⚠, and a note explains it.
 * - The filter (Filters) opens on «Con incidencias»: the reviewer looks for problems, not for everyone;
 *   «Bajo objetivo» and «Demasiadas horas» keep whoever has a cell of that red in the view shown (redRow),
 *   each button with its count.
 * - Saturday and Sunday are hidden unless some row shown has a session, a request or a flag on them.
 * - The table scrolls inside its card, at most 70 % of the window high, so its header row stays in sight on
 *   top and the names and the total on either side; it also pans by dragging, both ways (shared.js's
 *   panScroll), and a drag never opens the cell it ends on.
 * - Each week takes Odoo about a second and a half, one query per model, so once a week is shown the page
 *   asks for the previous one in the background, into the server's cache, and stepping back is instant.
 * - «Mes» shows the same people by weeks: one cell per week touching the month, judged whole as in the
 *   week view and saying how many of its days carry a flag, and a «Mes» column adding only the month's own
 *   days, saying how many hours it is short or over (the server's balance, which counts only the days
 *   already over: a month in progress would otherwise owe the hours of days still to come). A click on a
 *   week opens it in the week view.
 * - «Año» does the same by months, from the server's monthly summary (team.py): each month's hours against
 *   its target, how many hours short or over, how many of its weeks were under or over and how many days
 *   carry a flag. Months still to come stay blank. A click on a month opens it in the month view, and on a
 *   week in the month view that week, both with the search set to that person (drillInto), so only they
 *   remain.
 * - The arrows and «Hoy» move by the view's own unit; switching view keeps the period in sight (Views).
 * - «Gráficos» shows the same people, under the same filter, as figures (renderCharts, drawn by teamcharts.js):
 *   each person's balance for the period as a diverging bar, and per day, week or month how many people had punch
 *   errors (week view) or a red week or month, short or over (month and year views), each column
 *   naming its people on hover. The charts are drawn at their card's width, and again on resize, so their text
 *   keeps its size.
 * - «Fichajes por corregir», under the table or charts, is teamfixes.js; the page's shared state and the
 *   filter on people (name search) are teamstate.js.
 * - The criteria note under the table is written from the payload's limits (criteria), so it can never
 *   drift from what team.py applies.
 * - The page keeps its view, period, filter, table or charts, the search and the kinds of fixes in the URL hash
 *   (stateHash), and in sessionStorage so the dashboard's «Gestión» link, which has no hash, returns to it too:
 *   coming back from someone's page used to reset everything to this week's table. Moving to another period
 *   or view (a click into a month or a week, the view buttons, the arrows, «Hoy») adds a history entry, so
 *   the browser's back button walks the way back out (popstate reloads what the hash says); a filter, the
 *   search or the display only rewrite the current one.
 * - Rows are sorted by name with Spanish collation (Á next to A), which Odoo's order does not give.
 */
import { DayNames, MonthNames } from "./store.js";
import { fmtHM, fmtDelta, fmtDay, fmtYear, fmtTime, isoDay, fmtClock, parseDay, shiftDays, plural } from "./format.js";
import { el, api, wireLogout, wireMouseHistory, attachTip, hideTip, tipRow, panScroll } from "./shared.js";
import { balanced, dayDetails, dayLabel, requestLine, openDay, onDaySaved, wireDayDialog } from "./dayedit.js";
import { chartCard, divergingBars, groupedColumns, legend } from "./teamcharts.js";
import { team, FixKinds, FlagText, thisDay, named } from "./teamstate.js";
import { renderFixes, loadFixes, wireFixes } from "./teamfixes.js";

export const Filters = {
  issues: { label: "Con incidencias", keep: e => hasFlags(e), none: "Nadie tiene incidencias esta semana" },
  under: { label: "Bajo objetivo", keep: e => redRow(e).under, none: "Nadie bajo objetivo esta semana" },
  over: { label: "Demasiadas horas", keep: e => redRow(e).over,
    none: "Nadie con demasiadas horas esta semana" },
  requests: { label: "Con solicitudes", keep: e => e.pending > 0,
    none: "Nadie tiene solicitudes pendientes esta semana" },
  all: { label: "Todas", keep: () => true, none: "Nadie a la vista" },
};

export const Views = {
  week: { key: () => team.week, step: n => shiftWeek(team.week, n), now: () => undefined, noun: "esta semana",
    anchor: () => team.week, keep: data => { team.week = data.week; }, keyOf: anchor => anchor },
  month: { key: () => team.month, step: n => shiftMonth(team.month, n), now: () => thisDay().slice(0, 7),
    noun: "este mes", anchor: () => `${team.month}-01`, keep: data => { team.month = data.start.slice(0, 7); },
    keyOf: anchor => anchor.slice(0, 7) },
  year: { key: () => team.year, step: n => String(Number(team.year) + n), now: () => thisDay().slice(0, 4),
    noun: "este año",
    anchor: () => team.year === thisDay().slice(0, 4) ? thisDay() : `${team.year}-01-01`,
    keep: data => { team.year = String(data.year); }, keyOf: anchor => anchor.slice(0, 4) },
};

export function gapText(balance) {
  if (Math.abs(balance) < 1 / 60) return "Al día";
  return balance < 0 ? `Faltan ${fmtHM(-balance)}` : `Sobran ${fmtHM(balance)}`;
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

function shortOf(balance, limits) {
  return balance != null && balance <= -limits.under_margin;
}

function surplusOf(balance, limits) {
  return balance != null && balance > limits.over_margin;
}

function totalShort(total, limits) {
  return !total.flagged_days && shortOf(total.balance, limits);
}

function weekRed(employee, w, limits) {
  const { flags } = employee.weeks[w];
  return { under: flags.includes("under") && shortOf(employee.balance, limits),
    over: flags.includes("over") && surplusOf(employee.balance, limits) };
}

function monthRed(employee, m, limits) {
  return { under: totalShort(m, limits) && shortOf(employee.balance, limits),
    over: !m.flagged_days && m.over > 0 && surplusOf(employee.balance, limits) };
}

function redRow(employee) {
  const limits = team.data.limits;
  if (team.view === "week") return { under: employee.flags.includes("under"), over: employee.flags.includes("over") };
  const inside = team.view === "month" ? employee.weeks.map((_, w) => weekRed(employee, w, limits))
    : employee.months.map(m => monthRed(employee, m, limits));
  return { under: totalShort(employee, limits) || inside.some(red => red.under), over: inside.some(red => red.over) };
}

export function hasFlags(employee) {
  const red = redRow(employee);
  return red.under || red.over || (employee.days || []).some(d => d.flags.length > 0)
    || (employee.months || []).some(m => m.flagged_days > 0);
}

export function whyWeek(kind, employee, limits) {
  const { hours, target } = employee;
  if (kind === "under") return `${fmtHM(hours)} de ${fmtHM(target)} previstas: faltan ${fmtHM(target - hours)}`;
  return `${fmtHM(hours)} de ${fmtHM(target)} previstas: sobran ${fmtHM(hours - target)}, `
    + `más de ${fmtHM(limits.over_margin)}`;
}

export function hasData(day) {
  return day.sessions.length > 0 || day.requests.length > 0 || day.flags.length > 0;
}

function dayCell(employee, day, today, limits) {
  const td = el("td", "day");
  td.tabIndex = 0;
  td.addEventListener("click", () => { if (!gridPan.consume()) openDay(employee, day, limits, team.data.can_edit); });
  td.addEventListener("keydown", e => { if (e.key === "Enter") openDay(employee, day, limits, team.data.can_edit); });
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

function summary(td, { hours, target, balance, due, suspect, flagged_days: flagged }, running, started = true) {
  if (target != null && started) {
    td.appendChild(el("span", "gap", `${gapText(balance)}${running ? " hasta ayer" : ""}`));
  }
  const sofar = target != null && started && running;
  td.appendChild(el("span", "hours", fmtHM(sofar ? due + balance : hours)));
  td.appendChild(el("span", "meta", target == null ? " sin horario" : ` de ${fmtHM(sofar ? due : target)}`));
  if (suspect || flagged) td.classList.add("warn");
  if (suspect) td.appendChild(el("span", "flag warn", SuspectText));
}

function drillInto(employee, view, key) {
  team.search = employee.name;
  document.getElementById("search").value = employee.name;
  team.view = view;
  load(key, false, true);
}

function totalCell(employee, limits, today, extra = [], flags = employee.flags) {
  const td = el("td", "total");
  if (flags.length) td.classList.add("bad");
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
    for (const kind of flags) tip.appendChild(el("div", "t-note bad", whyWeek(kind, employee, limits)));
    if (!flags.length) {
      tip.appendChild(tipRow(`Semana frente a ${fmtHM(employee.target)}`, fmtDelta(employee.hours - employee.target)));
    }
  });
  return td;
}

function weekCell(employee, w, today, limits) {
  const week = employee.weeks[w];
  const days = employee.days.slice(7 * w, 7 * w + 7);
  const flagged = days.filter(d => d.flags.length).length;
  const red = weekRed(employee, w, limits);
  const td = totalCell({ ...week, days }, limits, today,
    flagged ? [`${plural(flagged, "día", "días")} con errores de fichaje`] : [],
    week.flags.filter(kind => red[kind]));
  td.classList.add("week");
  if (flagged) td.classList.add("warn");
  if (week.monday <= today && today <= shiftDays(week.monday, 6)) td.classList.add("today");
  const open = () => { hideTip(); drillInto(employee, "week", week.monday); };
  td.addEventListener("click", () => { if (!gridPan.consume()) open(); });
  td.addEventListener("keydown", e => { if (e.key === "Enter") open(); });
  return td;
}

function monthCell(employee, data, today) {
  const td = el("td", "total");
  const running = today < data.stop;
  summary(td, employee, running);
  if (employee.target == null) return td;
  if (totalShort(employee, data.limits)) td.classList.add("bad");
  td.tabIndex = 0;
  attachTip(td, tip => {
    tip.appendChild(el("div", "t-title", "Saldo de cada semana, entera"));
    for (const w of employee.weeks) tip.appendChild(tipRow(weekRange(w.monday), fmtDelta(w.hours - w.target)));
    tip.appendChild(el("div", "t-sep"));
    const label = running ? "Días del mes hasta ayer" : "Solo los días del mes";
    tip.appendChild(tipRow(label, fmtDelta(employee.balance)));
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
  const red = monthRed(employee, m, limits);
  const counts = [
    [m.under, "semana bajo objetivo", "semanas bajo objetivo", red.under ? "flag" : "meta block"],
    [m.over, "semana con demasiadas horas", "semanas con demasiadas horas", red.over ? "flag" : "meta block"],
    [m.flagged_days, "día con errores de fichaje", "días con errores de fichaje", "flag warn"],
  ].filter(([n]) => n > 0);
  for (const [n, one, many, cls] of counts) td.appendChild(el("span", cls, plural(n, one, many)));
  if (red.under || red.over) td.classList.add("bad");
  td.tabIndex = 0;
  const open = () => { hideTip(); drillInto(employee, "month", m.month); };
  td.addEventListener("click", () => { if (!gridPan.consume()) open(); });
  td.addEventListener("keydown", e => { if (e.key === "Enter") open(); });
  return td;
}

function yearCell(employee, today, limits) {
  const td = el("td", "total");
  summary(td, employee, team.year === today.slice(0, 4));
  if (totalShort(employee, limits)) td.classList.add("bad");
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
  return name;
}

export function criteria(limits) {
  return `Bajo objetivo: una semana terminada con ${fmtHM(limits.under_margin)} o más por debajo de su `
    + `jornada prevista. Demasiadas horas: una semana terminada con más de ${fmtHM(limits.over_margin)} `
    + `por encima de ella. Jornada muy larga: más de ${fmtHM(limits.long_day)} fichadas en un día. Fuera de horario: `
    + `una entrada antes de las ${fmtClock(limits.work_from)} o una salida después de las ${fmtClock(limits.work_to)} `
    + "o ya en otro día. Sin fichar: un día pasado con jornada prevista y sin fichajes ni ausencia. Sin cerrar: una "
    + "entrada de un día anterior sin salida. La jornada prevista de cada día es la del contrato vigente ese día; "
    + "vacaciones, festivos y permisos la reducen. Los descansos cuentan como horas. En naranja, errores de fichaje, "
    + "que se corrigen antes de juzgar las horas; en rojo, objetivo no cumplido (horas de menos o demasiadas), solo "
    + "sin errores de fichaje y si el periodo que estás viendo no lo compensa: una semana corta en un mes que llega, "
    + "o un mes corto en un año que llega, no sale en rojo. En azul, solicitudes de cambio.";
}

export function render() {
  const data = team.data;
  const today = isoDay(new Date());
  document.getElementById("weekLabel").textContent = {
    week: () => `Semana del ${fmtDay(parseDay(data.week))} al ${fmtDay(parseDay(shiftDays(data.week, 6)))}`
      + fmtYear(parseDay(shiftDays(data.week, 6))),
    month: () => monthLabel(team.month),
    year: () => team.year,
  }[team.view]();
  for (const button of document.getElementById("viewSeg").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === team.view));
  }
  const people = data.employees.filter(e => named(e, team.search));
  document.getElementById("criteria").textContent = criteria(data.limits);
  const generated = new Date(data.generated_at);
  document.getElementById("subtitle").textContent =
    `${plural(people.length, "persona", "personas")} · actualizado el ${fmtDay(generated)} `
    + `a las ${fmtTime(generated)}`;

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

const StateKey = "gestion";

export function stateHash() {
  const params = new URLSearchParams({ v: team.view, p: Views[team.view].key() || "", f: team.filter,
    d: team.display,
    k: FixKinds.filter(k => team.fixKinds.has(k)).join(","), ...(team.search ? { q: team.search } : {}) });
  return `#${params}`;
}

export function readState(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if (Views[params.get("v")]) team.view = params.get("v");
  if (Filters[params.get("f")]) team.filter = params.get("f");
  if (["table", "charts"].includes(params.get("d"))) team.display = params.get("d");
  team.search = params.get("q") || "";
  document.getElementById("search").value = team.search;
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

const Series = {
  flagged: { key: "flagged", label: "Personas con errores de fichaje", cls: "error" },
  under: { key: "under", label: "Bajo objetivo", cls: "short" },
  over: { key: "over", label: "Demasiadas horas", cls: "over" },
};

function periods(data, rows, today) {
  const sorted = rows.slice().sort((a, b) => a.name.localeCompare(b.name, "es"));
  const each = (object, fn) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, fn(value)]));
  const period = (base, tests) => {
    const people = each(tests, test => sorted.filter(test).map(e => e.name));
    return { ...base, people, values: each(people, names => names.length) };
  };
  if (team.view === "year") {
    return MonthNames.map((name, i) => period({
      label: name, title: monthLabel(`${team.year}-${String(i + 1).padStart(2, "0")}`),
      month: `${team.year}-${String(i + 1).padStart(2, "0")}`,
    }, { under: e => monthRed(e, e.months[i], data.limits).under,
      over: e => monthRed(e, e.months[i], data.limits).over }))
      .filter(p => p.month <= today.slice(0, 7));
  }
  if (team.view === "month") {
    return (data.employees[0]?.weeks || []).map((w, i) => period(
      { label: fmtDay(parseDay(w.monday)), title: weekRange(w.monday) },
      { under: e => weekRed(e, i, data.limits).under, over: e => weekRed(e, i, data.limits).over }));
  }
  return [0, 1, 2, 3, 4, 5, 6].filter(i => i < 5 || rows.some(e => hasData(e.days[i]))).map(i =>
    period({ label: DayNames[i], title: dayLabel(shiftDays(data.week, i)) },
      { flagged: e => e.days[i].flags.length > 0 }));
}

function renderCharts(data, rows, today) {
  const box = document.getElementById("charts");
  const running = today < data.stop;
  const noun = { week: "la semana", month: "el mes", year: "el año" }[team.view];
  const judged = rows.filter(e => e.balance != null);
  box.replaceChildren();

  const people = chartCard(`Saldo de cada persona en ${noun}`,
    `Horas de fichajes cerrados menos jornada prevista${running ? ", hasta ayer: hoy aún no cuenta" : ""}. `
    + "Una entrada sin cerrar no suma horas, así que resta como si faltaran. "
    + "A la izquierda faltan, a la derecha sobran.");
  const items = judged.slice().sort((a, b) => a.balance - b.balance).map(e => ({
    label: e.name, value: e.balance, suspect: e.flagged_days > 0, href: `/empleado?id=${e.id}`,
    rows: [["Fichadas", fmtHM(running ? e.due + e.balance : e.hours)], ["Previstas", fmtHM(running ? e.due : e.target)],
      ["Saldo", gapText(e.balance)],
      ...(e.flagged_days
        ? [["Aviso", plural(e.flagged_days, "día con errores de fichaje", "días con errores de fichaje")]] : [])],
  }));
  box.appendChild(people);
  const width = people.children[0].clientWidth || undefined;
  people.appendChild(items.length ? divergingBars(items, v => fmtDelta(v), width)
    : el("p", "chart-note", "Nadie con jornada prevista"));
  if (items.some(i => i.suspect)) {
    people.appendChild(el("p", "chart-note",
      "⚠ Saldo no fiable: incluye errores de fichaje, que se corrigen antes de juzgar sus horas."));
  }

  const series = team.view === "week" ? [Series.flagged] : [Series.under, Series.over];
  const timeline = chartCard(
    { week: "Personas con incidencias cada día", month: "Personas con semanas fuera de objetivo",
      year: "Personas con meses fuera de objetivo" }[team.view],
    { week: "Días sin fichar, sin cerrar, fuera de horario o con una jornada muy larga.",
      month: "Cada semana entera, ya terminada y sin errores de fichaje, si el mes no la compensa.",
      year: "Cada mes sin errores de fichaje, si el año no lo compensa." }[team.view]);
  if (series.length > 1) timeline.appendChild(legend(series));
  timeline.appendChild(groupedColumns(periods(data, rows, today), series, width));
  box.appendChild(timeline);
}

export async function load(key, fresh, push = false) {
  const unit = team.view;
  const params = [key ? `${unit}=${key}` : "", fresh ? "fresh" : ""].filter(Boolean).join("&");
  const loadmsg = document.getElementById("loadmsg");
  try {
    const data = await api(`/api/team${params ? `?${params}` : ""}`);
    team.data = data;
    Views[unit].keep(data);
    if (push) globalThis.history?.pushState(null, "", stateHash());
    render();
    if (fresh || !team.fixes) loadFixes(fresh);
    if (unit !== "year") fetch(`/api/team?${unit}=${Views[unit].step(-1)}`).catch(() => {});
  } catch (e) {
    loadmsg.textContent = "Error cargando datos de Odoo: " + e.message;
    loadmsg.classList.remove("hidden");
  }
}

async function busyWhile(button, work) {
  button.disabled = true;
  try { await work(); } finally { button.disabled = false; }
}

const view = () => Views[team.view];
const periodButtons = [
  ["prevWeek", () => view().step(-1)], ["nextWeek", () => view().step(1)], ["thisWeek", () => view().now()],
];
for (const [id, key] of periodButtons) {
  document.getElementById(id).addEventListener("click", e =>
    busyWhile(e.currentTarget, () => load(key(), false, true)));
}
document.getElementById("refreshBtn").addEventListener("click", e =>
  busyWhile(e.currentTarget, () => load(view().key(), true)));
document.getElementById("viewSeg").addEventListener("click", e => {
  const button = e.target.closest("button");
  if (!button || button.dataset.view === team.view) return;
  const anchor = team.data ? view().anchor() : thisDay();
  team.view = button.dataset.view;
  load(view().keyOf(anchor), false, true);
});
addEventListener("popstate", () => load(readState(location.hash)));
document.getElementById("search").addEventListener("input", e => {
  team.search = e.target.value;
  saveState();
  if (team.data) render();
  else if (team.fixes) renderFixes();
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
const gridPan = panScroll(document.getElementById("gridScroll"));
wireDayDialog();
wireFixes(saveState);
onDaySaved(() => load(view().key(), true));

wireLogout(document.getElementById("logoutBtn"));
wireMouseHistory();

load(restoreState());
