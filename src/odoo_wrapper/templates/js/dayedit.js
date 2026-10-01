/*
 * One day of someone's punches, as both pages show it: the tooltip's details (dayDetails) and the dialog
 * that corrects them (openDay, openDayOf). The management view opens it from a table cell or a mark in
 * «Fichajes por corregir»; the personal page from each punch to fix, when the session may read other
 * people's attendances (the only sessions server.py lets write). No side effects on import, like shared.js;
 * each page says what to reload after a write (onDaySaved).
 *
 * - The tooltip lists the day's sessions (an over-long one in orange, sessionRow, as its row in the editor),
 *   why each flag is there, in words and with the limits the payload carries, and its change requests with
 *   their reason.
 * - The dialog shows the same, read only unless the session may change punches (the payload's can_edit, Odoo's own
 *   rights, which server.py also enforces): then each punch's check-in and check-out are time fields
 *   (punchEditor), the «+» closing each row adds an empty one right under it, so a new punch sits where it
 *   belongs in the day (a day without punches opens with one empty row, or there would be no «+» to press; left
 *   empty it sends nothing), and «Guardar cambios» sends only what changed, both times
 *   on the day's own date except a check-out left as it was, which keeps its day. Each punch's reason is a
 *   selector of the ones the payload offers (reasonField; none without the module, and then a break is only
 *   labelled): a punch whose reason is not among them, or that has none, keeps it as one more option, so the
 *   selector never shows what the punch does not have, and a new one starts on the first, the working one. A
 *   reason is sent only when it is another one; an open punch still needs its check-out to be saved. A pending
 *   change request the session may approve gets «Aprobar solicitud». Both write to Odoo, so both ask for a
 *   second click (confirmButton), and both reload the page and reopen the day as it now is (refreshDay), read
 *   from that day's week. When shortening a punch loses the next day's check-in (team.py, lost_entry) the note
 *   under the day says which one to add there; nothing is created on its own.
 * - The dialog stays open, for reading a long reason or copying times: a click outside does not close it,
 *   only «Cerrar» or Escape, and neither while a write is on its way (holdDialog): its answer reopens the day,
 *   which reopened a dialog already closed.
 */
import { DayNames } from "./store.js";
import { fmtHM, fmtDelta, fmtDay, fmtDate, fmtYear, fmtTime, dayKey, parseDay } from "./format.js";
import { el, api, hideTip, tipRow } from "./shared.js";

export const RequestText = { new: "Borrador", pending: "Pendiente", approved: "Aprobada", refused: "Rechazada" };

export function sessionSpan(s) {
  return `${fmtTime(new Date(s.in))}–${s.out ? fmtTime(new Date(s.out)) : "abierto"}${s.rest ? " descanso" : ""}`;
}

export function whyDay(kind, day, limits) {
  if (kind === "open") {
    return day.sessions.filter(s => !s.out).map(s => `Entrada a las ${fmtTime(new Date(s.in))} sin salida`);
  }
  if (kind === "empty") return [`Jornada prevista de ${fmtHM(day.target)} sin fichajes ni ausencia`];
  return [`${fmtHM(day.hours)} fichadas en el día, más de ${fmtHM(limits.long_day)}`];
}

export function balanced(day) {
  return day.target > 0 && day.sessions.length > 0 && day.sessions.every(s => s.out);
}

export function dayLabel(iso, year = false) {
  const date = parseDay(iso);
  return `${DayNames[(date.getDay() + 6) % 7]} ${year ? fmtDate(date) : fmtDay(date) + fmtYear(date)}`;
}

export function wrongSession(s, limits) {
  return s.hours > limits.long_day;
}

export function sessionRow(s, limits, open) {
  const row = tipRow(sessionSpan(s), s.hours == null ? open : fmtHM(s.hours));
  if (wrongSession(s, limits)) row.classList.add("warn");
  return row;
}

export function dayDetails(day, limits, { employee = null, title = true, sessions = true } = {}) {
  return tip => {
    if (title) tip.appendChild(el("div", "t-title", dayLabel(day.date)));
    if (sessions) {
      if (!day.sessions.length) tip.appendChild(el("div", "t-note", "Sin fichajes"));
      for (const s of day.sessions) tip.appendChild(sessionRow(s, limits, "en curso"));
    }
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
      if (employee && r.can_approve) {
        const approve = () => api("/api/team/approve", { id: r.id })
          .then(() => refreshDay(employee, day.date, "Solicitud aprobada."));
        tip.appendChild(confirmButton("Aprobar solicitud", "No se pudo aprobar", approve));
      }
    }
  };
}

export function requestLine(r) {
  const span = `${fmtTime(new Date(r.from))}${r.to ? `–${fmtTime(new Date(r.to))}` : ""}`;
  return `Solicitud ${RequestText[r.status].toLowerCase()} ${span}`;
}

export function openDay(employee, day, { limits, can_edit: canEdit, reasons }) {
  hideTip();
  document.getElementById("dayDialogTitle").textContent = employee.name;
  document.getElementById("dayDialogNote").textContent = "";
  const body = document.getElementById("dayDialogBody");
  body.replaceChildren(el("div", "t-title", dayLabel(day.date)));
  if (canEdit) body.appendChild(punchEditor(employee, day, limits, reasons));
  dayDetails(day, limits, { employee: employee.id, title: false, sessions: !canEdit })(body);
  const dialog = document.getElementById("dayDialog");
  if (!dialog.open) dialog.showModal();
}

export function say(text) {
  document.getElementById("dayDialogNote").textContent = text;
}

export function confirmButton(label, failure, work) {
  const button = el("button", "btn small", label);
  button.type = "button";
  let armed = null;
  button.addEventListener("click", async () => {
    if (!armed) {
      armed = setTimeout(() => { armed = null; button.textContent = label; }, 4000);
      button.textContent = "¿Confirmar?";
      return;
    }
    clearTimeout(armed);
    armed = null;
    button.textContent = label;
    button.disabled = true;
    holdDialog(true);
    try {
      await work();
    } catch (e) {
      say(`${failure}: ${e.message}`);
    } finally {
      button.disabled = false;
      holdDialog(false);
    }
  });
  return button;
}

export function timeField(iso, label) {
  const input = el("input");
  input.type = "time";
  input.value = iso ? fmtTime(new Date(iso)) : "";
  input.setAttribute("aria-label", label);
  return input;
}

export function reasonField(s, reasons) {
  const own = s ? { id: s.reason_id ?? "", name: s.reason ?? "sin motivo" } : reasons[0];
  const select = el("select");
  select.setAttribute("aria-label", "Motivo");
  for (const r of reasons.some(r => r.id === own.id) ? reasons : [own, ...reasons]) {
    const option = el("option", "", r.name);
    option.value = r.id;
    select.appendChild(option);
  }
  select.value = String(own.id);
  return select;
}

export function punchChanges(date, entries) {
  const at = time => new Date(`${date}T${time}`).toISOString();
  return entries.flatMap(({ s, start, end, reason }) => {
    const [was, until] = s ? [fmtTime(new Date(s.in)), s.out ? fmtTime(new Date(s.out)) : ""] : ["", ""];
    const another = Boolean(reason) && reason.value !== String(s?.reason_id ?? "");
    if (start.value === was && end.value === until && !(s && another)) return [];
    if (!start.value || !end.value) throw new Error("cada fichaje necesita entrada y salida");
    return [{ ...(s ? { id: s.id } : {}), check_in: start.value === was ? s.in : at(start.value),
      check_out: end.value === until ? s.out : at(end.value), ...(another ? { reason: Number(reason.value) } : {}) }];
  });
}

export function punchEditor(employee, day, limits, reasons) {
  const box = el("div", "editor");
  const entries = [];
  const addRow = (s, before) => {
    const row = el("div", "edit-row" + (s && wrongSession(s, limits) ? " warn" : ""));
    const start = timeField(s?.in, "Entrada"), end = timeField(s?.out, "Salida");
    const reason = reasons.length ? reasonField(s, reasons) : null;
    row.append(start, "–", end);
    if (s?.out && dayKey(new Date(s.out)) !== dayKey(new Date(s.in))) {
      row.appendChild(el("span", "meta", `salida el ${fmtDate(new Date(s.out))}`));
    }
    if (reason) row.appendChild(reason);
    else if (s?.rest) row.appendChild(el("span", "meta", "descanso"));
    const add = el("button", "btn ghost small", "+");
    add.type = "button";
    add.title = "Añadir un fichaje debajo";
    add.setAttribute("aria-label", add.title);
    add.addEventListener("click", () => addRow(null, row.nextElementSibling));
    row.appendChild(add);
    box.insertBefore(row, before);
    entries.push({ s, start, end, reason });
  };
  const actions = el("div", "edit-actions");
  actions.append(confirmButton("Guardar cambios", "No se pudo guardar", async () => {
    const changes = punchChanges(day.date, entries).map(c => c.id ? c : { ...c, employee: employee.id });
    if (!changes.length) return say("No hay cambios que guardar.");
    const lost = [];
    for (const change of changes) {
      const answer = await api("/api/team/attendance", change);
      if (answer.lost_entry) lost.push(new Date(answer.lost_entry));
    }
    const warnings = lost.map(d => `La salida original, ${fmtDate(d)} a las ${fmtTime(d)}, `
      + "era probablemente la entrada de ese día: añádela allí.");
    await refreshDay(employee.id, day.date, ["Guardado.", ...warnings].join(" "));
  }));
  box.appendChild(actions);
  (day.sessions.length ? day.sessions : [null]).forEach(s => addRow(s, actions));
  return box;
}

let Reload;

function holdDialog(busy) {
  document.getElementById("dayDialogClose").disabled = busy;
}

export function wireDayDialog() {
  const dialog = el("dialog", "dialog");
  dialog.id = "dayDialog";
  dialog.setAttribute("aria-labelledby", "dayDialogTitle");
  const title = el("h2"), body = el("div"), note = el("p", "dialog-note"), actions = el("div", "dialog-actions");
  const close = el("button", "btn ghost", "Cerrar");
  [title.id, body.id, note.id, close.id] = ["dayDialogTitle", "dayDialogBody", "dayDialogNote", "dayDialogClose"];
  close.type = "button";
  note.setAttribute("role", "status");
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", e => { if (close.disabled) e.preventDefault(); });
  actions.appendChild(close);
  dialog.append(title, body, note, actions);
  document.body.appendChild(dialog);
}

export function onDaySaved(reload) {
  Reload = reload;
}

export async function openDayOf(employeeId, date) {
  const week = await api(`/api/team?week=${date}`);
  const employee = week.employees.find(e => e.id === employeeId);
  const day = employee?.days.find(d => d.date === date);
  if (day) openDay(employee, day, week);
}

export async function refreshDay(employeeId, date, message) {
  await Reload();
  await openDayOf(employeeId, date).catch(() => {});
  say(message);
}
