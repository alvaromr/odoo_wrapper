/*
 * The management view's «Discord» dialog: the token of the bot that sends the day dialog's notices by private
 * message (discord.py). It says whether this machine keeps one (the payload's can_message; «Comprobando…» until
 * the first payload arrives, as an empty page knows nothing yet), and while open it follows the page's loads
 * (refreshDiscord), so it never keeps an answer the page has since learned otherwise. It takes a new one,
 * which the server checks with Discord before keeping it, the same as `odoo discord`; the field is a password
 * and starts empty every time, as nothing ever sends the token back. Whoever opens it is setting the bot up, so
 * it says where the token is found, and «Enviar prueba» sends them, and only them, a test message to see it
 * work end to end. No side effects on import.
 */
import { el, api } from "./shared.js";
import { team } from "./teamstate.js";

export const BotHelp = "Está en discord.com/developers/applications: tu aplicación → Bot → «Restablecer token». "
  + "Discord solo lo enseña una vez.";

export function botStatus() {
  if (!team.data) return "Comprobando si hay un token guardado…";
  return team.data.can_message ? "Hay un token guardado: los avisos de fichajes se envían por privado."
    : "No hay token guardado: los avisos de fichajes solo se pueden copiar.";
}

export function refreshDiscord() {
  const dialog = document.getElementById("discordDialog");
  if (dialog?.open) document.getElementById("discordStatus").textContent = botStatus();
}

export function wireDiscord(button) {
  const dialog = el("dialog", "dialog");
  dialog.id = "discordDialog";
  dialog.setAttribute("aria-labelledby", "discordTitle");
  const title = el("h2", null, "Bot de Discord"), status = el("p", "t-note"), note = el("p", "dialog-note");
  const input = el("input"), save = el("button", "btn small", "Guardar"), close = el("button", "btn ghost", "Cerrar");
  [title.id, status.id] = ["discordTitle", "discordStatus"];
  input.type = "password";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Token del bot");
  note.setAttribute("role", "status");
  save.type = close.type = "button";
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const { bot } = await api("/api/team/discord/token", { token: input.value });
      if (team.data) team.data.can_message = true;
      input.value = "";
      status.textContent = botStatus();
      note.textContent = `Guardado: el bot «${bot}» enviará los avisos.`;
    } catch (e) {
      note.textContent = `No se guardó: ${e.message}`;
    } finally {
      save.disabled = false;
    }
  });
  const test = el("button", "btn ghost", "Enviar prueba");
  test.type = "button";
  test.title = "Te envía a ti un mensaje de prueba por Discord";
  test.addEventListener("click", async () => {
    test.disabled = true;
    try {
      await api("/api/team/discord/test", {});
      note.textContent = "Prueba enviada: mira tus mensajes directos de Discord.";
    } catch (e) {
      note.textContent = `No se envió la prueba: ${e.message}`;
    } finally {
      test.disabled = false;
    }
  });
  close.addEventListener("click", () => dialog.close());
  const row = el("div", "edit-row"), actions = el("div", "dialog-actions");
  row.append(input, save);
  actions.append(test, close);
  dialog.append(title, status, el("p", "t-note", BotHelp), row, note, actions);
  document.body.appendChild(dialog);
  button.addEventListener("click", () => {
    status.textContent = botStatus();
    note.textContent = input.value = "";
    dialog.showModal();
  });
}
