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
 *   reason is sent only when it is another one; an open punch still needs its check-out to be saved. The «✕»
 *   of a punch already in Odoo marks it to be deleted, and again unmarks it: nothing is deleted until «Guardar
 *   cambios», which sends the deletions before anything else (Odoo checks overlaps on each write, and a punch
 *   still there would refuse the neighbour stretched over it) and whatever its fields hold, so an open or
 *   half-filled punch can go too. Deleting on the spot would also have reopened the day and dropped the edits
 *   not yet saved in the other rows. When Odoo refuses a change after others of the same save went through,
 *   the day is reopened as it now is and the note says the rest was not saved: left as it was, the next try
 *   sent again a deletion already made (refused, so nothing after it ever went) or a punch already created
 *   (a duplicate). A pending change request the session may approve gets «Aprobar
 *   solicitud». Both write to Odoo, so both ask for a second click (confirmButton), and both reload the page
 *   and reopen the day as it now is (refreshDay), read from that day's week. When shortening a punch loses the
 *   next day's check-in (team.py, lost_entry) the note under the day says which one to add there; nothing is
 *   created on its own.
 * - A day with a punch error ends with the message that tells its owner what is wrong and asks for an attendance
 *   change request (noticeBox), folded behind one button, «Avisar por Discord…» or «Preparar aviso…»: most visits
 *   come to correct, not to warn, and the dialog was crowded. Unfolded, it is a field, so it can be retouched
 *   before sending. «Enviar» sends it as it stands, by private message from the bot (discord.py), when this
 *   machine has one (the payload's can_message) and the person's Odoo record names their Discord user (team.py's
 *   discord); it asks for a second click like every other button that acts for real, and its tooltip says what
 *   the server adds and the field does not show: that the message is automatic, whom to write to, and a button
 *   to Odoo's form for the request.
 *   «Copiar» is always there, for the rest; a clipboard that refuses (a page out of a secure context) leaves
 *   the text selected for a manual copy. «Cancelar» folds it again, keeping what was typed.
 * - The dialog stays open, for reading a long reason or copying times: a click outside does not close it,
 *   only «Cerrar» or Escape, and neither while a write is on its way (holdDialog): its answer reopens the day,
 *   which reopened a dialog already closed.
 */

import { dayKey, fmtDate, fmtDay, fmtDelta, fmtHM, fmtTime, fmtYear, parseDay } from "./format.js";
import { api, byId, el, warned } from "./shared.js";
import { DayNames } from "./store.js";
import { hideTip, tipRow } from "./tip.js";

/**
 * What the day dialog reads and writes, as team.py sends it (data.py's session_of, fetch_requests).
 *
 * @typedef {{ id: number, in: string, out: string | null, hours: number | null, rest: boolean, reason: string | null, reason_id: number | null }} Session
 * @typedef {Pick<Session, "in" | "out" | "hours"> & { rest?: boolean }} SessionLike  What a row of sessions needs
 * @typedef {{ id: number, from: string, to: string | null, status: "new" | "pending" | "approved" | "refused", reason: string, can_approve: boolean }} ChangeRequest
 * @typedef {"open" | "empty" | "long"} DayFlag
 * @typedef {{ date: string, hours: number, target: number, absence: string | null, sessions: Session[], flags: DayFlag[], requests: ChangeRequest[] }} Day
 * @typedef {{ long_day: number, under_margin: number, over_margin: number }} Limits
 * @typedef {{ id: number, name: string }} Reason
 * @typedef {{ id: number, name: string, discord?: string | null }} DayOwner
 * @typedef {{ limits: Limits, can_edit: boolean, reasons: Reason[], can_message: boolean }} DayContext
 * @typedef {{ s: Session | null, start: HTMLInputElement, end: HTMLInputElement, reason: HTMLSelectElement | null, gone: boolean }} PunchEntry
 * @typedef {{ id?: number, gone?: boolean, check_in?: string, check_out?: string | null, reason?: number, employee?: number }} PunchChange
 */

export const RequestText = { new: "Borrador", pending: "Pendiente", approved: "Aprobada", refused: "Rechazada" };

/** @param {SessionLike} s */
export function sessionSpan(s) {
  return `${fmtTime(new Date(s.in))}–${s.out ? fmtTime(new Date(s.out)) : "abierto"}${s.rest ? " descanso" : ""}`;
}

/**
 * @param {DayFlag} kind
 * @param {{ sessions: SessionLike[], hours: number, target: number }} day
 * @param {Limits} limits
 * @returns {string[]}
 */
export function whyDay(kind, day, limits) {
  if (kind === "open") {
    return day.sessions.filter((s) => !s.out).map((s) => `Entrada a las ${fmtTime(new Date(s.in))} sin salida`);
  }
  if (kind === "empty") return [`Jornada prevista de ${fmtHM(day.target)} sin fichajes ni ausencia`];
  return [`${fmtHM(day.hours)} fichadas en el día, más de ${fmtHM(limits.long_day)}`];
}

/** @param {Day} day */
export function balanced(day) {
  return day.target > 0 && day.sessions.length > 0 && day.sessions.every((s) => s.out);
}

/**
 * @param {string} iso
 * @param {boolean} [year]
 */
export function dayLabel(iso, year = false) {
  const date = parseDay(iso);
  return `${DayNames[(date.getDay() + 6) % 7]} ${year ? fmtDate(date) : fmtDay(date) + fmtYear(date)}`;
}

/**
 * @param {{ hours: number | null }} s
 * @param {Pick<Limits, "long_day">} limits
 */
export function wrongSession(s, limits) {
  return /** @type {number} */ (s.hours) > limits.long_day;
}

/**
 * @param {SessionLike} s
 * @param {Limits} limits
 * @param {string} open
 */
export function sessionRow(s, limits, open) {
  const row = tipRow(sessionSpan(s), s.hours == null ? open : fmtHM(s.hours));
  if (wrongSession(s, limits)) row.classList.add("warn");
  return row;
}

/**
 * @param {Day} day
 * @param {Limits} limits
 * @param {{ employee?: number | null, title?: boolean, sessions?: boolean }} [options]
 * @returns {(tip: HTMLElement) => void}
 */
export function dayDetails(day, limits, { employee = null, title = true, sessions = true } = {}) {
  return (tip) => {
    if (title) tip.appendChild(el("div", "t-title", dayLabel(day.date)));
    if (sessions) {
      if (!day.sessions.length) tip.appendChild(el("div", "t-note", "Sin fichajes"));
      for (const s of day.sessions) tip.appendChild(sessionRow(s, limits, "en curso"));
    }
    if (balanced(day)) {
      tip.appendChild(el("div", "t-sep"));
      tip.appendChild(tipRow(`Frente a ${fmtHM(day.target)} previstas`, fmtDelta(day.hours - day.target)));
    }
    const notes = day.flags.flatMap((kind) => whyDay(kind, day, limits));
    if (notes.length) tip.appendChild(el("div", "t-sep"));
    for (const text of notes) tip.appendChild(el("div", "t-note warn", text));
    for (const r of day.requests) {
      tip.appendChild(el("div", "t-sep"));
      tip.appendChild(el("div", `t-note ${r.status}`, requestLine(r)));
      if (r.reason) tip.appendChild(el("div", "t-note", r.reason));
      if (employee && r.can_approve) {
        const approve = () =>
          api("/api/team/approve", { id: r.id }).then(() => refreshDay(employee, day.date, "Solicitud aprobada."));
        tip.appendChild(confirmButton("Aprobar solicitud", "No se pudo aprobar", approve));
      }
    }
  };
}

/** @param {Pick<ChangeRequest, "from" | "to" | "status">} r */
export function requestLine(r) {
  const span = `${fmtTime(new Date(r.from))}${r.to ? `–${fmtTime(new Date(r.to))}` : ""}`;
  return `Solicitud ${RequestText[r.status].toLowerCase()} ${span}`;
}

/**
 * @param {DayOwner} employee
 * @param {Day} day
 * @param {DayContext} context
 */
export function openDay(employee, day, { limits, can_edit: canEdit, reasons, can_message: canMessage }) {
  hideTip();
  byId("dayDialogTitle").textContent = employee.name;
  byId("dayDialogNote").textContent = "";
  const body = byId("dayDialogBody");
  body.replaceChildren(el("div", "t-title", dayLabel(day.date)));
  if (canEdit) body.appendChild(punchEditor(employee, day, limits, reasons));
  dayDetails(day, limits, { employee: employee.id, title: false, sessions: !canEdit })(body);
  if (day.flags.length) body.append(el("div", "t-sep"), noticeBox(employee, day, limits, canMessage));
  const dialog = /** @type {HTMLDialogElement} */ (byId("dayDialog"));
  if (!dialog.open) dialog.showModal();
}

/**
 * @param {Day} day
 * @param {Limits} limits
 */
export function noticeText(day, limits) {
  const date = parseDay(day.date).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
  const why = day.flags.flatMap((kind) => whyDay(kind, day, limits)).map((t) => t[0].toLowerCase() + t.slice(1));
  return (
    `Tienes un error en el fichaje del ${date.replace(",", "")}: ${why.join("; ")}.\n` +
    "Por favor, haz una solicitud de cambio de fichaje en Odoo."
  );
}

/**
 * @param {DayOwner} employee
 * @param {Day} day
 * @param {Limits} limits
 * @param {boolean} canMessage
 */
export function noticeBox(employee, day, limits, canMessage) {
  const box = el("div", "notice");
  const text = el("textarea");
  text.value = noticeText(day, limits);
  text.rows = 4;
  text.setAttribute("aria-label", "Mensaje para avisar del error");
  const actions = el("div", "edit-actions");
  const sends = Boolean(canMessage && employee.discord);
  if (sends) {
    const send = confirmButton("Enviar", "No se pudo enviar", async () => {
      await api("/api/team/discord", { employee: employee.id, date: day.date, text: text.value });
      say(`Mensaje enviado a ${employee.name} por Discord.`);
    });
    send.title = "Al final se añade que es automático, que te escriba a ti y un botón para hacer la solicitud en Odoo";
    actions.appendChild(send);
  }
  const copy = el("button", sends ? "btn ghost small" : "btn small", "Copiar");
  copy.type = "button";
  copy.addEventListener("click", () =>
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text.value))
      .then(
        () => say("Mensaje copiado."),
        () => {
          text.select();
          say("No se pudo copiar: el mensaje está seleccionado, cópialo con ⌘C o Ctrl+C.");
        },
      ),
  );
  actions.appendChild(copy);
  const fold = el("button", "btn ghost small", "Cancelar");
  fold.type = "button";
  actions.appendChild(fold);
  if (canMessage && !sends) actions.appendChild(el("span", "meta", "Sin Discord en su ficha de Odoo"));
  const open = el("button", "btn ghost small", sends ? "Avisar por Discord…" : "Preparar aviso…");
  open.type = "button";
  open.addEventListener("click", () => {
    box.replaceChildren(text, actions);
    text.focus();
  });
  fold.addEventListener("click", () => box.replaceChildren(open));
  box.appendChild(open);
  return box;
}

/** @param {string} text */
export function say(text) {
  byId("dayDialogNote").textContent = text;
}

/**
 * @param {string} label
 * @param {string} failure
 * @param {() => Promise<unknown>} work
 */
export function confirmButton(label, failure, work) {
  const button = el("button", "btn small", label);
  button.type = "button";
  /** @type {ReturnType<typeof setTimeout> | null} */
  let armed = null;
  button.addEventListener("click", async () => {
    if (!armed) {
      armed = setTimeout(() => {
        armed = null;
        button.textContent = label;
      }, 4000);
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
      say(`${failure}: ${/** @type {Error} */ (e).message}`);
    } finally {
      button.disabled = false;
      holdDialog(false);
    }
  });
  return button;
}

/**
 * @param {string | null | undefined} iso
 * @param {string} label
 */
export function timeField(iso, label) {
  const input = el("input");
  input.type = "time";
  input.value = iso ? fmtTime(new Date(iso)) : "";
  input.setAttribute("aria-label", label);
  return input;
}

/**
 * @param {Session | null | undefined} s
 * @param {Reason[]} reasons
 */
export function reasonField(s, reasons) {
  const own = s ? { id: s.reason_id ?? "", name: s.reason ?? "sin motivo" } : reasons[0];
  const select = el("select");
  select.setAttribute("aria-label", "Motivo");
  for (const r of reasons.some((r) => r.id === own.id) ? reasons : [own, ...reasons]) {
    const option = el("option", "", r.name);
    option.value = String(r.id);
    select.appendChild(option);
  }
  select.value = String(own.id);
  return select;
}

/**
 * @param {string} date
 * @param {PunchEntry[]} entries
 * @returns {PunchChange[]}
 */
export function punchChanges(date, entries) {
  const at = (/** @type {string} */ time) => new Date(`${date}T${time}`).toISOString();
  const kept = entries
    .filter((e) => !e.gone)
    .flatMap(({ s, start, end, reason }) => {
      const [was, until] = s ? [fmtTime(new Date(s.in)), s.out ? fmtTime(new Date(s.out)) : ""] : ["", ""];
      const another = Boolean(reason) && /** @type {HTMLSelectElement} */ (reason).value !== String(s?.reason_id ?? "");
      if (start.value === was && end.value === until && !(s && another)) return [];
      if (!start.value || !end.value) throw new Error("cada fichaje necesita entrada y salida");
      return [
        {
          ...(s ? { id: s.id } : {}),
          check_in: start.value === was ? /** @type {Session} */ (s).in : at(start.value),
          check_out: end.value === until ? /** @type {Session} */ (s).out : at(end.value),
          ...(another ? { reason: Number(/** @type {HTMLSelectElement} */ (reason).value) } : {}),
        },
      ];
    });
  return [...entries.filter((e) => e.gone).map((e) => ({ id: /** @type {Session} */ (e.s).id, gone: true })), ...kept];
}

/**
 * @param {DayOwner} employee
 * @param {Day} day
 * @param {Limits} limits
 * @param {Reason[]} reasons
 */
export function punchEditor(employee, day, limits, reasons) {
  const box = el("div", "editor");
  /** @type {PunchEntry[]} */
  const entries = [];
  const addRow = (/** @type {Session | null} */ s, /** @type {Element | null} */ before) => {
    const row = el("div", `edit-row${s && wrongSession(s, limits) ? " warn" : ""}`);
    const start = timeField(s?.in, "Entrada"),
      end = timeField(s?.out, "Salida");
    const reason = reasons.length ? reasonField(s, reasons) : null;
    row.append(start, "–", end);
    if (s?.out && dayKey(new Date(s.out)) !== dayKey(new Date(s.in))) {
      row.appendChild(el("span", "meta", `salida el ${fmtDate(new Date(s.out))}`));
    }
    if (reason) row.appendChild(reason);
    else if (s?.rest) row.appendChild(el("span", "meta", "descanso"));
    const entry = { s, start, end, reason, gone: false };
    if (s) {
      const drop = el("button", "btn ghost small", "✕");
      drop.type = "button";
      const mark = (/** @type {boolean} */ gone) => {
        entry.gone = gone;
        row.classList.toggle("gone", gone);
        for (const field of /** @type {(HTMLInputElement | HTMLSelectElement)[]} */ (
          [start, end, reason].filter(Boolean)
        ))
          field.disabled = gone;
        drop.title = gone ? "No eliminar este fichaje" : "Eliminar este fichaje";
        drop.setAttribute("aria-label", drop.title);
        drop.setAttribute("aria-pressed", String(gone));
      };
      drop.addEventListener("click", () => mark(!entry.gone));
      mark(false);
      row.appendChild(drop);
    }
    const add = el("button", "btn ghost small", "+");
    add.type = "button";
    add.title = "Añadir un fichaje debajo";
    add.setAttribute("aria-label", add.title);
    add.addEventListener("click", () => addRow(null, row.nextElementSibling));
    row.appendChild(add);
    box.insertBefore(row, before);
    entries.push(entry);
  };
  const actions = el("div", "edit-actions");
  actions.append(
    confirmButton("Guardar cambios", "No se pudo guardar", async () => {
      const changes = punchChanges(day.date, entries).map((c) => (c.id ? c : { ...c, employee: employee.id }));
      if (!changes.length) return say("No hay cambios que guardar.");
      /** @type {Date[]} */
      const lost = [];
      let sent = 0,
        done = "Guardado.";
      try {
        for (const change of changes) {
          const answer = /** @type {{ lost_entry?: string }} */ (
            await api(change.gone ? "/api/team/delete" : "/api/team/attendance", change)
          );
          if (answer.lost_entry) lost.push(new Date(answer.lost_entry));
          // Stryker disable next-line AssignmentOperator: sent is only ever tested for zero, which counting down leaves as counting up does
          sent += 1;
        }
      } catch (e) {
        if (!sent) throw e;
        done = `Guardado solo en parte; no se pudo el resto: ${/** @type {Error} */ (e).message}.`;
      }
      const warnings = lost.map(
        (d) =>
          `La salida original, ${fmtDate(d)} a las ${fmtTime(d)}, ` +
          "era probablemente la entrada de ese día: añádela allí.",
      );
      await refreshDay(employee.id, day.date, [done, ...warnings].join(" "));
    }),
  );
  box.appendChild(actions);
  for (const s of day.sessions.length ? day.sessions : [null]) addRow(s, actions);
  return box;
}

/** @type {() => unknown} */
let Reload;

/** @param {boolean} busy */
function holdDialog(busy) {
  /** @type {HTMLButtonElement} */ (byId("dayDialogClose")).disabled = busy;
}

export function wireDayDialog() {
  const dialog = el("dialog", "dialog");
  dialog.id = "dayDialog";
  dialog.setAttribute("aria-labelledby", "dayDialogTitle");
  const title = el("h2"),
    body = el("div"),
    note = el("p", "dialog-note"),
    actions = el("div", "dialog-actions");
  const close = el("button", "btn ghost", "Cerrar");
  [title.id, body.id, note.id, close.id] = ["dayDialogTitle", "dayDialogBody", "dayDialogNote", "dayDialogClose"];
  close.type = "button";
  note.setAttribute("role", "status");
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (e) => {
    if (close.disabled) e.preventDefault();
  });
  actions.appendChild(close);
  dialog.append(title, body, note, actions);
  document.body.appendChild(dialog);
}

/** @param {() => unknown} reload */
export function onDaySaved(reload) {
  Reload = reload;
}

/**
 * @param {number} employeeId
 * @param {string} date
 */
export async function openDayOf(employeeId, date) {
  const week = /** @type {import("./teamstate.js").TeamData} */ (await api(`/api/team?week=${date}`));
  const employee = week.employees.find((e) => e.id === employeeId);
  const day = employee?.days.find((d) => d.date === date);
  if (day) openDay(/** @type {DayOwner} */ (employee), day, week);
}

/**
 * @param {number} employeeId
 * @param {string} date
 * @param {string} message
 */
export async function refreshDay(employeeId, date, message) {
  await Reload();
  await openDayOf(employeeId, date).catch(warned("reopening the day"));
  say(message);
}
