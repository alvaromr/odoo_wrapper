/*
 * «Ajustes», the dialog the gear in the hero opens (openSettings): how long lunch and a break last, and the hours the
 * lunch button shows, all in the shared state (state.py), each saved as soon as it changes. Each row's tooltip says
 * what the setting drives. A modal dialog sits in the browser's top layer, above any z-index, so the tooltip is moved
 * inside it while it is open and back to the body when it closes. A window that would end before it starts is
 * refused here with a note, and by the server too. Two rows are not shared state: «Tema», this browser's own
 * (theme.js), and «Actualizaciones», which asks the server to check GitHub now (updates.py) and says the answer, or
 * why there is none, in the dialog's note.
 */

import { saveState } from "./api.js";
import { api, byId, el } from "./shared.js";
import { LunchMax, store } from "./store.js";
import { attachTip, hideTip } from "./tip.js";
import { showUpdate } from "./updates.js";

const SettingsTips = {
  lunch:
    "Lo que sueles tardar en comer. Los días con comida en tu calendario de Odoo se suma a la hora " +
    "estimada de salida hasta tu primera ausencia del día; tras «Salir a comer», el aviso «Comida terminada» " +
    "suena pasado este tiempo.",
  rest:
    "Lo que dura un descanso. El aviso «Descanso terminado» suena pasado este tiempo desde que empieza; " +
    "con 0 no suena.",
  window:
    "Horas entre las que aparece el botón «Salir a comer», solo los días con comida en tu calendario de " +
    "Odoo y mientras no lo hayas usado ese día. Ficha una salida normal y además pone en marcha el aviso de " +
    "fin de comida.",
  theme: "Colores de la página en este navegador. «Sistema» sigue el modo claro u oscuro del dispositivo.",
  updates:
    "El panel busca versiones nuevas en GitHub cada pocas horas y avisa arriba cuando hay una. Este botón " +
    "lo comprueba ahora.",
};

const Themes = [
  ["", "Sistema"],
  ["light", "Claro"],
  ["dark", "Oscuro"],
];

/** @returns {HTMLDivElement} */
function themeField() {
  const seg = el("div", "seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Tema");
  const buttons = Themes.map(([theme, label]) => {
    const b = el("button", null, label);
    b.type = "button";
    b.dataset.theme = theme;
    return b;
  });
  const press = () => {
    for (const b of buttons) {
      b.setAttribute("aria-pressed", String(b.dataset.theme === (document.documentElement.dataset.theme || "")));
    }
  };
  for (const b of buttons) {
    const { theme } = b.dataset;
    b.addEventListener("click", () => {
      const kept = window.chooseTheme(/** @type {string} */ (theme));
      press();
      byId("settingsNote").textContent = kept
        ? ""
        : "Este navegador no deja guardar el tema: vuelve al del sistema al recargar la página.";
    });
    seg.appendChild(b);
  }
  press();
  return seg;
}

/** @returns {HTMLButtonElement} */
function updatesField() {
  const b = el("button", "btn ghost small", "Buscar ahora");
  b.type = "button";
  b.addEventListener("click", async () => {
    const note = byId("settingsNote");
    b.disabled = true;
    try {
      const answer = showUpdate(/** @type {import("./updates.js").UpdateAnswer} */ (await api("/api/update?fresh")));
      note.textContent =
        answer.error ||
        (answer.available
          ? "Hay una versión nueva: el aviso de arriba dice cómo instalarla."
          : `Tienes la última versión, la ${answer.current}.`);
    } catch (e) {
      note.textContent = `No se pudo buscar actualizaciones: ${/** @type {Error} */ (e).message}`;
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

/**
 * @param {string} label
 * @param {"lunch_minutes" | "break_minutes"} key
 * @returns {HTMLLabelElement}
 */
export function minutesField(label, key) {
  const field = el("label", "duration");
  const input = el("input", "lunch-input");
  input.type = "number";
  input.min = "0";
  input.max = String(LunchMax);
  input.step = "5";
  input.value = String(store.state[key]);
  input.setAttribute("aria-label", `Minutos de ${label.toLowerCase()}`);
  input.addEventListener("change", async () => {
    await saveState({ [key]: Math.min(LunchMax, Math.max(0, Math.round(Number(input.value) || 0))) });
    input.value = String(store.state[key]);
  });
  field.appendChild(input);
  field.append(" min");
  return field;
}

const WindowBackwards = "No se ha guardado: el botón tiene que aparecer antes de la hora en que desaparece.";

/** @param {number} n */
const twoDigits = (n) => String(n).padStart(2, "0");
/** @param {number} minutes */
const clockText = (minutes) => `${twoDigits(Math.floor(minutes / 60))}:${twoDigits(minutes % 60)}`;

/**
 * @param {string} label
 * @param {"lunch_button_from" | "lunch_button_to"} key
 * @returns {HTMLInputElement}
 */
function clockField(label, key) {
  const input = el("input", "clock-input");
  input.type = "time";
  input.value = clockText(store.state[key]);
  input.setAttribute("aria-label", label);
  input.addEventListener("change", async () => {
    const [hours, minutes] = input.value.split(":").map(Number);
    const next = { ...store.state, [key]: hours * 60 + minutes };
    const fits = next.lunch_button_from < next.lunch_button_to;
    byId("settingsNote").textContent = !input.value || fits ? "" : WindowBackwards;
    if (input.value && fits) await saveState({ [key]: next[key] });
    input.value = clockText(store.state[key]);
  });
  return input;
}

/**
 * @param {string} label
 * @param {string} tip
 * @param {...(string | Node)} controls
 * @returns {HTMLDivElement}
 */
function settingRow(label, tip, ...controls) {
  const row = el("div", "setting");
  row.tabIndex = 0;
  row.append(el("span", "setting-name", label), ...controls);
  attachTip(row, (t) => t.appendChild(el("div", "t-note", tip)));
  return row;
}

export function wireSettings() {
  const dialog = el("dialog", "dialog");
  dialog.id = "settingsDialog";
  dialog.setAttribute("aria-labelledby", "settingsTitle");
  const title = el("h2", null, "Ajustes"),
    body = el("div", "settings"),
    note = el("p", "dialog-note");
  const actions = el("div", "dialog-actions"),
    close = el("button", "btn ghost", "Cerrar");
  [title.id, body.id, note.id] = ["settingsTitle", "settingsBody", "settingsNote"];
  note.setAttribute("role", "status");
  close.type = "button";
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    hideTip();
    document.body.appendChild(byId("tip"));
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
  rows.push(
    settingRow(
      "Botón «Salir a comer»",
      SettingsTips.window,
      "de",
      clockField("Aparece a las", "lunch_button_from"),
      "a",
      clockField("Desaparece a las", "lunch_button_to"),
    ),
  );
  rows.push(
    settingRow("Tema", SettingsTips.theme, themeField()),
    settingRow("Actualizaciones", SettingsTips.updates, updatesField()),
  );
  byId("settingsBody").replaceChildren(...rows);
  byId("settingsNote").textContent = "";
  const dialog = /** @type {HTMLDialogElement} */ (byId("settingsDialog"));
  dialog.appendChild(byId("tip"));
  dialog.showModal();
}
