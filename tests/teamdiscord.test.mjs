// teamdiscord.js: the Discord dialog of the management view, where the bot's token is kept and tested.

import assert from "node:assert/strict";
import test from "node:test";
import { answering, load, reply, settle, show, teamFixes, teamPage, teamPayload } from "./page.mjs";

test("the Discord dialog is built as the page expects and sits in the document", async () => {
  const page = teamPage();
  await settle();
  const dialog = page.document.getElementById("discordDialog");
  assert.equal(page.document.body.children.includes(dialog), true);
  assert.deepEqual(show(dialog), [
    "dialog#discordDialog.dialog aria-labelledby=discordTitle",
    '  h2#discordTitle "Bot de Discord"',
    "  p#discordStatus.t-note",
    '  p.t-note "Está en discord.com/developers/applications: tu aplicación → Bot → «Restablecer token». Discord solo lo enseña una vez."',
    "  div.edit-row",
    "    input type=password autocomplete=off aria-label=Token del bot",
    '    button.btn.small type=button "Guardar"',
    "  p.dialog-note role=status",
    "  div.dialog-actions",
    '    button.btn.ghost type=button title=Te envía a ti un mensaje de prueba por Discord "Enviar prueba"',
    '    button.btn.ghost type=button "Cerrar"',
  ]);
});

test("the Discord dialog's buttons are disabled while their request is on its way", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const page = teamPage({
    fetchImpl: answering(async (url) => {
      if (!url.startsWith("/api/team/discord/")) return undefined;
      await gate;
      return reply({ bot: "Odoo" });
    }),
  });
  await settle();
  const [, status, , row, note, actions] = page.document.getElementById("discordDialog").children;
  const [, save] = row.children;
  const [test] = actions.children;
  page.run("team.data = null");
  const saving = save.listeners.click[0]();
  const testing = test.listeners.click[0]();
  assert.deepEqual([save.disabled, test.disabled], [true, true]);
  release();
  await Promise.all([saving, testing]);
  assert.deepEqual([save.disabled, test.disabled], [false, false]);
  assert.equal(note.textContent, "Prueba enviada: mira tus mensajes directos de Discord.");
  await save.listeners.click[0]();
  assert.equal(note.textContent, "Guardado: el bot «Odoo» enviará los avisos.");
  assert.equal(status.textContent, "Comprobando si hay un token guardado…");
});

test("the Discord dialog tolerates a page without its element when the page reloads", () => {
  const page = teamPage();
  const real = page.document.getElementById;
  page.document.getElementById = (id) => (id === "discordDialog" ? null : real(id));
  page.run("refreshDiscord()");
  page.document.getElementById = real;
});

test("«Discord» says whether the bot has a token and keeps a new one without ever showing it", async () => {
  const posts = [];
  let answer = { ok: true, status: 200, json: async () => ({ bot: "Odoo" }) };
  const page = load({
    entry: "team.js",
    fetchImpl: async (url, opts) => {
      if (opts?.method === "POST") {
        posts.push([url, JSON.parse(opts.body)]);
        return answer;
      }
      return { ok: true, status: 200, json: async () => (url.includes("fixes") ? teamFixes() : teamPayload()) };
    },
  });
  await settle();
  const doc = page.document;
  const dialog = doc.getElementById("discordDialog");
  const [, status, help, row, note] = dialog.children;
  const [input, save] = row.children;
  doc.getElementById("discordBtn").listeners.click[0]();
  assert.equal(dialog.open, true);
  assert.equal(status.textContent, "No hay token guardado: los avisos de fichajes solo se pueden copiar.");
  assert.match(help.textContent, /Restablecer token/);
  assert.equal(input.type, "password");
  input.value = "tok";
  await save.listeners.click[0]();
  assert.deepEqual(posts, [["/api/team/discord/token", { token: "tok" }]]);
  assert.deepEqual([input.value, note.textContent], ["", "Guardado: el bot «Odoo» enviará los avisos."]);
  assert.equal(status.textContent, "Hay un token guardado: los avisos de fichajes se envían por privado.");
  assert.equal(page.run("team.data.can_message"), true);
  answer = { ok: false, status: 400, json: async () => ({ error: "Discord no acepta el token del bot" }) };
  await save.listeners.click[0]();
  assert.deepEqual([note.textContent, save.disabled], ["No se guardó: Discord no acepta el token del bot", false]);
  const [test, close] = dialog.children.at(-1).children;
  answer = { ok: true, status: 200, json: async () => ({ ok: true }) };
  await test.listeners.click[0]();
  assert.deepEqual(posts.at(-1), ["/api/team/discord/test", {}]);
  assert.deepEqual(
    [note.textContent, test.disabled],
    ["Prueba enviada: mira tus mensajes directos de Discord.", false],
  );
  answer = { ok: false, status: 409, json: async () => ({ error: "No se encuentra tu ID de Discord" }) };
  await test.listeners.click[0]();
  assert.equal(note.textContent, "No se envió la prueba: No se encuentra tu ID de Discord");
  input.value = "a medias";
  close.listeners.click[0]();
  assert.equal(dialog.open, false);
  page.run("team.data = null");
  doc.getElementById("discordBtn").listeners.click[0]();
  assert.deepEqual([input.value, note.textContent], ["", ""]);
  assert.equal(status.textContent, "Comprobando si hay un token guardado…");
  answer = { ok: true, status: 200, json: async () => ({ bot: "Odoo" }) };
  await save.listeners.click[0]();
  assert.equal(status.textContent, "Comprobando si hay un token guardado…");
  await page.run("load(null, true)");
  assert.equal(status.textContent, "No hay token guardado: los avisos de fichajes solo se pueden copiar.");
  dialog.close();
  page.run("team.data.can_message = true; refreshDiscord()");
  assert.equal(status.textContent, "No hay token guardado: los avisos de fichajes solo se pueden copiar.");
});
