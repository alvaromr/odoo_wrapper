/*
 * The management view's «Discord» dialog: the token of the bot that sends the day dialog's notices by private
 * message (discord.py). It says whether this machine keeps one (the payload's can_message) and takes a new one,
 * which the server checks with Discord before keeping it, the same as `odoo discord`; the field is a password
 * and starts empty every time, as nothing ever sends the token back. Whoever opens it is setting the bot up, so
 * it says where the token is found. No side effects on import.
 */
import { el, api } from "./shared.js";
import { team } from "./teamstate.js";

export const BotHelp = "Está en discord.com/developers/applications: tu aplicación → Bot → «Restablecer token». "
  + "Discord solo lo enseña una vez.";

export function botStatus() {
  return team.data?.can_message ? "Hay un token guardado: los avisos de fichajes se envían por privado."
    : "No hay token guardado: los avisos de fichajes solo se pueden copiar.";
}

export function wireDiscord(button) {
  const dialog = el("dialog", "dialog");
  dialog.id = "discordDialog";
  dialog.setAttribute("aria-labelledby", "discordTitle");
  const title = el("h2", null, "Bot de Discord"), status = el("p", "t-note"), note = el("p", "dialog-note");
  const input = el("input"), save = el("button", "btn small", "Guardar"), close = el("button", "btn ghost", "Cerrar");
  title.id = "discordTitle";
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
  close.addEventListener("click", () => dialog.close());
  const row = el("div", "edit-row"), actions = el("div", "dialog-actions");
  row.append(input, save);
  actions.appendChild(close);
  dialog.append(title, status, el("p", "t-note", BotHelp), row, note, actions);
  document.body.appendChild(dialog);
  button.addEventListener("click", () => {
    status.textContent = botStatus();
    note.textContent = input.value = "";
    dialog.showModal();
  });
}
