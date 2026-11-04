/*
 * The hero's punch buttons. Every one asks for confirmation in place: the first click arms it («¿Confirmar?») for
 * four seconds, the second one punches. The server validates the real state and answers 409 on invalid actions; the
 * error lands in the hero's error box. A punch that succeeds but is followed by a failed reload says so instead of
 * claiming the punch itself failed, and leaves the button disabled since the punch went through and the next tick or
 * tab focus will reload.
 */

import { checkAlarms } from "./alarms.js";
import { loadAndRender } from "./api.js";
import { api, el } from "./shared.js";

/**
 * @param {string} cls
 * @param {string} label
 * @param {string} action
 * @param {HTMLElement} errBox
 * @returns {HTMLButtonElement}
 */
export function actionButton(cls, label, action, errBox) {
  const b = el("button", `btn ${cls}`, label);
  let armed = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
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
        errBox.textContent = `Fichado, pero no se pudo recargar: ${/** @type {Error} */ (e).message}`;
        return;
      }
      errBox.textContent = `Error: ${/** @type {Error} */ (e).message}`;
      b.disabled = false;
      b.textContent = label;
      b.classList.remove("arm");
    }
  });
  return b;
}
