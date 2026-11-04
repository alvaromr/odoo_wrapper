/*
 * The banner of a newer release, on both pages. wireUpdates asks the server (updates.py) on load and every hour
 * whether GitHub holds a newer release, and shows the banner under the header with its notes. The server keeps
 * GitHub's answer for hours, so the hourly poll costs GitHub nothing; a failed one leaves the banner as it was, and
 * «Ajustes» (settings.js) says why when asked. How to install it follows the payload's how and local: on the machine
 * itself, «Actualizar ahora» (a second click confirms, as punching does), which also updates the skills, waits for the
 * restarted server to report the new version and reloads, unless the skills failed: then it stays, saying why and
 * with the command to retry; the development install is told to use git; anywhere else, or without uv, the commands
 * for the dashboard and the skills. While it installs the poll leaves the banner alone, so the button and its note
 * stay.
 */

import { api, byId, el, warned } from "./shared.js";

const UpdateEveryMs = 3600000;
const UpgradeCommand = "uv tool upgrade odoo-wrapper";
const PluginCommand = "claude plugin update odoo@odoo-wrapper";
const UpdateArmMs = 4000;
const RestartPollMs = 2000;
const RestartTries = 90;
let Installing = false;

/** @param {string} old */
async function restarted(old) {
  for (let i = 0; i < RestartTries; i++) {
    await new Promise((resolve) => setTimeout(resolve, RestartPollMs));
    try {
      const res = await fetch("/api/update");
      if (res.ok && (await res.json()).current !== old) return;
    } catch (e) {
      warned("waiting for the restarted dashboard")(e);
    }
  }
  throw new Error("el panel no ha vuelto en tres minutos: mira ~/.odoo_dashboard/dashboard.log");
}

/**
 * What /api/update answers (updates.py, plus whether the dashboard is on this machine and how it was installed).
 * @typedef {object} UpdateAnswer
 * @property {boolean} available
 * @property {string} current
 * @property {string} latest
 * @property {string} url
 * @property {string} [error]
 * @property {boolean} local
 * @property {string} how
 */

/**
 * @param {UpdateAnswer} answer
 * @param {HTMLElement} note
 * @returns {HTMLButtonElement}
 */
function installButton(answer, note) {
  const b = el("button", "btn primary small", "Actualizar ahora");
  b.type = "button";
  let armed = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  b.addEventListener("click", async () => {
    if (!armed) {
      b.textContent = `¿Instalar la ${answer.latest}?`;
      armed = setTimeout(() => {
        armed = null;
        b.textContent = "Actualizar ahora";
      }, UpdateArmMs);
      return;
    }
    clearTimeout(armed);
    armed = null;
    b.disabled = Installing = true;
    b.textContent = "Instalando…";
    note.textContent = "Puede tardar un minuto.";
    try {
      const { skills } = /** @type {{ skills: string }} */ (await api("/api/update", {}));
      note.textContent = "Instalada: reiniciando el panel…";
      await restarted(answer.current);
      if (!skills) {
        location.reload();
        return;
      }
      b.textContent = "Instalada";
      note.replaceChildren(
        `La ${answer.latest} ya funciona, pero las skills de Claude Code no se han actualizado ` +
          `(${skills}). Ejecuta `,
        el("code", null, PluginCommand),
        " y recarga esta página.",
      );
    } catch (e) {
      note.textContent = `No se pudo actualizar: ${/** @type {Error} */ (e).message}`;
      b.disabled = Installing = false;
      b.textContent = "Actualizar ahora";
    }
  });
  return b;
}

/**
 * @param {...(string | Node)} parts
 * @returns {HTMLParagraphElement}
 */
function line(...parts) {
  const p = el("p");
  p.append(...parts);
  return p;
}

/**
 * @param {UpdateAnswer} answer
 * @returns {HTMLDivElement}
 */
function installRow(answer) {
  const note = el("span", null, "");
  note.setAttribute("role", "status");
  const row = el("div", "update-actions");
  row.append(installButton(answer, note), note);
  return row;
}

/**
 * @param {UpdateAnswer} answer
 * @returns {HTMLParagraphElement}
 */
function handLine(answer) {
  if (answer.local && answer.how === "git") return line("Es la instalación de desarrollo: tráela con git.");
  return line(
    answer.local ? "No encuentro uv en este ordenador. " : "",
    "Para instalarla, ejecuta ",
    el("code", null, UpgradeCommand),
    " en una terminal del ordenador: el dashboard se reinicia solo.",
  );
}

/**
 * @param {UpdateAnswer} answer
 * @returns {UpdateAnswer}
 */
export function showUpdate(answer) {
  if (Installing) return answer;
  const banner = byId("updateBanner");
  banner.classList.toggle("hidden", !answer.available);
  if (answer.available) {
    const notes = el("a", null, "Novedades");
    notes.href = answer.url;
    notes.target = "_blank";
    notes.rel = "noopener";
    const auto = answer.local && answer.how === "auto";
    banner.replaceChildren(
      line(
        el("strong", null, `Hay una versión nueva, la ${answer.latest}`),
        ` (tienes la ${answer.current}). `,
        notes,
        ".",
      ),
      ...(auto
        ? [installRow(answer)]
        : [
            handLine(answer),
            line("Las skills de Claude Code se actualizan con ", el("code", null, PluginCommand), "."),
          ]),
    );
  }
  return answer;
}

export function wireUpdates() {
  const poll = () =>
    fetch("/api/update")
      .then((res) => res.ok && res.json())
      .then((answer) => answer && showUpdate(answer))
      .catch(warned("the update check"));
  poll();
  setInterval(poll, UpdateEveryMs);
}
