/*
 * DOM building blocks: the break segments drawn inside a bar, the inline icons
 * (bell, gear, QR), the punch button, the settings dialog, and busy().
 *
 * - The gear in the hero opens «Ajustes» (openSettings): how long lunch and a break last, and the hours the
 *   lunch button shows, all in the shared state (state.py), each saved as soon as it changes. Each row's
 *   tooltip says what the setting drives. A modal dialog sits in the browser's top layer, above any z-index,
 *   so the tooltip is moved inside it while it is open and back to the body when it closes. A window that
 *   would end before it starts is refused here with a note, and by the server too.
 * - Every punch button asks for confirmation in place: the first click arms it («¿Confirmar?») for four
 *   seconds, the second one punches. The server validates the real state and answers 409 on invalid
 *   actions; the error lands in the hero's error box. A punch that succeeds but is followed by a failed
 *   reload says so instead of claiming the punch itself failed, and leaves the button disabled since the
 *   punch went through and the next tick or tab focus will reload.
 * - busy() treats an open tooltip (shared.js), an armed button or a focused duration field as "do not
 *   repaint now".
 */
import { store, LunchMax } from "./store.js";
import { el, api, tipOpen, attachTip, hideTip } from "./shared.js";
import { saveState, loadAndRender } from "./api.js";
import { checkAlarms } from "./alarms.js";

function restSpans(sessions) {
  let before = 0;
  return sessions.flatMap(s => {
    const span = s.rest ? [{ from: before, to: before + s.hours }] : [];
    before += s.hours;
    return span;
  });
}

export function fillBar(bar, sessions, total) {
  for (const span of restSpans(sessions)) {
    const seg = el("div", "rest");
    seg.style.left = span.from / total * 100 + "%";
    seg.style.width = (span.to - span.from) / total * 100 + "%";
    bar.appendChild(seg);
  }
  return bar;
}

/* ---------- estado ocupado ---------- */
export function busy() {
  return tipOpen()
    || Boolean(document.querySelector(".btn.arm, .actions .btn:disabled, .lunch-input:focus"));
}


/* ---------- ajustes ---------- */
const SettingsTips = {
  lunch: "Lo que sueles tardar en comer. Los días con comida en tu calendario de Odoo se suma a la hora "
    + "estimada de salida hasta tu primera ausencia del día; tras «Salir a comer», el aviso «Comida terminada» "
    + "suena pasado este tiempo.",
  rest: "Lo que dura un descanso. El aviso «Descanso terminado» suena pasado este tiempo desde que empieza; "
    + "con 0 no suena.",
  window: "Horas entre las que aparece el botón «Salir a comer», solo los días con comida en tu calendario de "
    + "Odoo y mientras no lo hayas usado ese día. Ficha una salida normal y además pone en marcha el aviso de "
    + "fin de comida.",
};

export function minutesField(label, key) {
  const field = el("label", "duration");
  const input = el("input", "lunch-input");
  input.type = "number";
  input.min = 0;
  input.max = LunchMax;
  input.step = 5;
  input.value = store.state[key];
  input.setAttribute("aria-label", `Minutos de ${label.toLowerCase()}`);
  input.addEventListener("change", async () => {
    await saveState({ [key]: Math.min(LunchMax, Math.max(0, Math.round(Number(input.value) || 0))) });
    input.value = store.state[key];
  });
  field.appendChild(input);
  field.append(" min");
  return field;
}

const WindowBackwards = "No se ha guardado: el botón tiene que aparecer antes de la hora en que desaparece.";

const twoDigits = n => String(n).padStart(2, "0");
const clockText = minutes => `${twoDigits(Math.floor(minutes / 60))}:${twoDigits(minutes % 60)}`;

function clockField(label, key) {
  const input = el("input", "clock-input");
  input.type = "time";
  input.value = clockText(store.state[key]);
  input.setAttribute("aria-label", label);
  input.addEventListener("change", async () => {
    const [hours, minutes] = input.value.split(":").map(Number);
    const next = { ...store.state, [key]: hours * 60 + minutes };
    const fits = next.lunch_button_from < next.lunch_button_to;
    document.getElementById("settingsNote").textContent = !input.value || fits ? "" : WindowBackwards;
    if (input.value && fits) await saveState({ [key]: next[key] });
    input.value = clockText(store.state[key]);
  });
  return input;
}

function settingRow(label, tip, ...controls) {
  const row = el("div", "setting");
  row.tabIndex = 0;
  row.append(el("span", "setting-name", label), ...controls);
  attachTip(row, t => t.appendChild(el("div", "t-note", tip)));
  return row;
}

export function wireSettings() {
  const dialog = el("dialog", "dialog");
  dialog.id = "settingsDialog";
  dialog.setAttribute("aria-labelledby", "settingsTitle");
  const title = el("h2", null, "Ajustes"), body = el("div", "settings"), note = el("p", "dialog-note");
  const actions = el("div", "dialog-actions"), close = el("button", "btn ghost", "Cerrar");
  [title.id, body.id, note.id] = ["settingsTitle", "settingsBody", "settingsNote"];
  note.setAttribute("role", "status");
  close.type = "button";
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    hideTip();
    document.body.appendChild(document.getElementById("tip"));
  });
  actions.appendChild(close);
  dialog.append(title, body, note, actions);
  document.body.appendChild(dialog);
}

export function openSettings() {
  const rows = [settingRow("Comida", SettingsTips.lunch, minutesField("Comida", "lunch_minutes"))];
  if (store.data.breaks) {
    rows.push(settingRow("Descanso", SettingsTips.rest, minutesField("Descanso", "break_minutes")));
  }
  rows.push(settingRow("Botón «Salir a comer»", SettingsTips.window,
    "de", clockField("Aparece a las", "lunch_button_from"), "a", clockField("Desaparece a las", "lunch_button_to")));
  document.getElementById("settingsBody").replaceChildren(...rows);
  document.getElementById("settingsNote").textContent = "";
  const dialog = document.getElementById("settingsDialog");
  dialog.appendChild(document.getElementById("tip"));
  dialog.showModal();
}

function icon(shapes) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24", width: 15, height: 15, fill: "none", stroke: "currentColor",
    "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(k, v);
  for (const d of shapes) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

export function bellIcon(muted) {
  return icon([
    "M10.3 21a2 2 0 0 0 3.4 0",
    "M3.3 15.3A1 1 0 0 0 4 17h16a1 1 0 0 0 .7-1.7C19.4 14 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.4 6-2.7 7.3",
    ...(muted ? ["M3 3l18 18"] : []),
  ]);
}

export function gearIcon() {
  return icon([
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38"
      + "a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38"
      + "a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2"
      + "v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73"
      + "l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73"
      + "l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
    "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  ]);
}

export function qrIcon() {
  return icon([
    "M3 3h5v5H3z", "M16 3h5v5h-5z", "M3 16h5v5H3z",
    "M21 16h-3a2 2 0 0 0-2 2v3", "M21 21v.01", "M12 7v3a2 2 0 0 1-2 2H7",
    "M3 12h.01", "M12 3h.01", "M12 16v.01", "M16 12h1", "M21 12v.01", "M12 21v-1",
  ]);
}

export function actionButton(cls, label, action, errBox) {
  const b = el("button", `btn ${cls}`, label);
  let armed = null;
  b.addEventListener("click", async () => {
    if (!armed) {
      const hadPulse = b.classList.contains("pulse");
      armed = setTimeout(() => {
        armed = null;
        b.textContent = label;
        b.classList.remove("arm");
        b.classList.toggle("pulse", hadPulse);
      }, 4000);
      b.textContent = "¿Confirmar?";
      b.classList.add("arm");
      b.classList.remove("pulse");
      return;
    }
    clearTimeout(armed);
    armed = null;
    b.disabled = true;
    b.textContent = "Fichando…";
    errBox.textContent = "";
    let punched = false;
    try {
      await api("/api/attendance", { action });
      punched = true;
      await loadAndRender();
      checkAlarms();
    } catch (e) {
      if (punched) {
        errBox.textContent = "Fichado, pero no se pudo recargar: " + e.message;
        return;
      }
      errBox.textContent = "Error: " + e.message;
      b.disabled = false;
      b.textContent = label;
      b.classList.remove("arm");
    }
  });
  return b;
}
