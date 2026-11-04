// settings.js: «Ajustes», the dialog the gear opens, each setting saved as it changes and explained in its tooltip.
// Each test asserts what is drawn (tags, classes, attributes, text) and what is requested (paths, bodies), on a clock
// the test sets (clockAt in page.mjs).

import assert from "node:assert/strict";
import test from "node:test";
import {
  answer,
  at,
  dashboard,
  dump,
  heroOf,
  hover,
  load,
  memoryStorage,
  payload,
  session,
  settle,
  UP_TO_DATE,
} from "./page.mjs";

test("the gear opens the settings dialog", () => {
  const page = dashboard({ sessions: [] });
  const gear = heroOf(page)
    .querySelectorAll(".icon-btn")
    .find((b) => b.title === "Ajustes");
  assert.equal(page.document.getElementById("settingsDialog").open, false);
  gear.listeners.click[0]();
  assert.equal(page.document.getElementById("settingsDialog").open, true);
});

test("the settings dialog is built once, hidden, with its title, body, status note and close button", () => {
  const page = dashboard();
  const dialog = page.document.getElementById("settingsDialog");
  assert.equal(
    dump(dialog),
    `dialog#settingsDialog.dialog [aria-labelledby=settingsTitle]
  h2#settingsTitle "Ajustes"
  div#settingsBody.settings
  p#settingsNote.dialog-note [role=status]
  div.dialog-actions
    button.btn.ghost "Cerrar" [type=button]`,
  );
  assert.equal(page.document.body.children.includes(dialog), true);
  const tip = page.document.getElementById("tip");
  page.run("openSettings()");
  assert.equal(dialog.children.includes(tip), true);
  tip.style.display = "block";
  dialog.listeners.close[0]();
  assert.equal(tip.style.display, "none");
  assert.equal(page.document.body.children.at(-1), tip);
  dialog.children.at(-2).children[0].listeners.click[0]();
  assert.equal(dialog.open, false);
});

test("opening the settings lists lunch, break, the lunch button's window, theme and updates", () => {
  const page = dashboard();
  const note = page.document.getElementById("settingsNote");
  note.textContent = "de antes";
  page.run("openSettings()");
  assert.equal(note.textContent, "");
  assert.equal(page.document.getElementById("settingsDialog").open, true);
  assert.equal(
    dump(page.document.getElementById("settingsBody")),
    `div#settingsBody.settings
  div.setting [tabindex=0]
    span.setting-name "Comida"
    label.duration
      input.lunch-input [aria-label=Minutos de comida type=number value=30 min=0 max=240 step=5]
      " min"
  div.setting [tabindex=0]
    span.setting-name "Descanso"
    label.duration
      input.lunch-input [aria-label=Minutos de descanso type=number value=15 min=0 max=240 step=5]
      " min"
  div.setting [tabindex=0]
    span.setting-name "Botón «Salir a comer»"
    "de"
    input.clock-input [aria-label=Aparece a las type=time value=13:30]
    "a"
    input.clock-input [aria-label=Desaparece a las type=time value=16:00]
  div.setting [tabindex=0]
    span.setting-name "Tema"
    div.seg [role=group aria-label=Tema]
      button "Sistema" [aria-pressed=true type=button]
      button "Claro" [aria-pressed=false type=button]
      button "Oscuro" [aria-pressed=false type=button]
  div.setting [tabindex=0]
    span.setting-name "Actualizaciones"
    button.btn.ghost.small "Buscar ahora" [type=button]`,
  );
  const without = dashboard({ extra: { breaks: false } });
  without.run("openSettings()");
  assert.deepEqual(
    without.document.getElementById("settingsBody").children.map((row) => row.children[0].textContent),
    ["Comida", "Botón «Salir a comer»", "Tema", "Actualizaciones"],
  );
});

test("each setting explains in a tooltip what it drives", () => {
  const page = dashboard();
  page.run("openSettings()");
  const rows = page.document.getElementById("settingsBody").children;
  const tips = rows.map((row) => hover(page, row));
  assert.deepEqual(tips, [
    [
      "Lo que sueles tardar en comer. Los días con comida en tu calendario de Odoo se suma a la hora estimada de salida " +
        "hasta tu primera ausencia del día; tras «Salir a comer», el aviso «Comida terminada» suena pasado este tiempo.",
    ],
    [
      "Lo que dura un descanso. El aviso «Descanso terminado» suena pasado este tiempo desde que empieza; con 0 no suena.",
    ],
    [
      "Horas entre las que aparece el botón «Salir a comer», solo los días con comida en tu calendario de Odoo y mientras " +
        "no lo hayas usado ese día. Ficha una salida normal y además pone en marcha el aviso de fin de comida.",
    ],
    ["Colores de la página en este navegador. «Sistema» sigue el modo claro u oscuro del dispositivo."],
    [
      "El panel busca versiones nuevas en GitHub cada pocas horas y avisa arriba cuando hay una. Este botón lo comprueba ahora.",
    ],
  ]);
  assert.equal(rows[0].listeners.focus.length, 1);
  rows[0].listeners.pointerenter[0]({ clientX: 10, clientY: 10 });
  assert.equal(dump(page.document.getElementById("tip")).split("\n")[1].startsWith("  div.t-note "), true);
});

test("a duration is saved clamped to what the server takes, and shown as the server keeps it", async () => {
  const page = dashboard();
  page.run("openSettings()");
  const input = page.document.getElementById("settingsBody").children[0].children[1].children[0];
  const type = async (value) => {
    input.value = value;
    await input.listeners.change[0]();
    return page.sent.filter((r) => r.url === "/api/state").at(-1).body;
  };
  assert.deepEqual(await type("500"), { lunch_minutes: 240 });
  assert.equal(input.value, "240");
  assert.deepEqual(await type("-5"), { lunch_minutes: 0 });
  assert.deepEqual(await type("12.6"), { lunch_minutes: 13 });
  assert.deepEqual(await type("abc"), { lunch_minutes: 0 });
});

test("the lunch button's window is saved only when it opens before it closes", async () => {
  const page = dashboard();
  page.run("openSettings()");
  const [from, to] = page.document
    .getElementById("settingsBody")
    .children[2].children.filter((c) => c.tagName === "INPUT");
  const note = page.document.getElementById("settingsNote");
  const posts = () => page.sent.filter((r) => r.url === "/api/state").map((r) => r.body);
  from.value = "14:30";
  await from.listeners.change[0]();
  assert.deepEqual(posts(), [{ lunch_button_from: 870 }]);
  assert.equal(note.textContent, "");
  from.value = "16:00";
  await from.listeners.change[0]();
  assert.equal(posts().length, 1);
  assert.equal(note.textContent, "No se ha guardado: el botón tiene que aparecer antes de la hora en que desaparece.");
  assert.equal(from.value, "14:30");
  to.value = "";
  await to.listeners.change[0]();
  assert.equal(posts().length, 1);
  assert.equal(note.textContent, "");
  assert.equal(to.value, "16:00");
  to.value = "17:05";
  await to.listeners.change[0]();
  assert.deepEqual(posts().at(-1), { lunch_button_to: 1025 });
  assert.equal(to.value, "17:05");
  from.value = "17:05";
  await from.listeners.change[0]();
  assert.equal(posts().length, 2);
  assert.equal(note.textContent.startsWith("No se ha guardado"), true);
});

test("the theme buttons mark the one in force, apply a choice, and say when the browser cannot keep it", () => {
  const page = dashboard();
  page.run("openSettings()");
  const note = page.document.getElementById("settingsNote");
  const buttons = () => page.document.getElementById("settingsBody").children[3].children[1].children;
  const pressed = () => buttons().map((b) => b.attrs["aria-pressed"]);
  assert.deepEqual(
    buttons().map((b) => b.dataset.theme),
    ["", "light", "dark"],
  );
  buttons()[2].listeners.click[0]();
  assert.equal(page.document.documentElement.dataset.theme, "dark");
  assert.deepEqual(pressed(), ["false", "false", "true"]);
  assert.equal(note.textContent, "");
  buttons()[0].listeners.click[0]();
  assert.deepEqual(pressed(), ["true", "false", "false"]);
  const blocked = dashboard({
    local: {
      getItem: () => null,
      setItem: () => {
        throw new Error("bloqueado");
      },
    },
  });
  blocked.run("openSettings()");
  blocked.document.getElementById("settingsBody").children[3].children[1].children[1].listeners.click[0]();
  assert.equal(
    blocked.document.getElementById("settingsNote").textContent,
    "Este navegador no deja guardar el tema: vuelve al del sistema al recargar la página.",
  );
});

test("the update check disables its button, and says what it found or why it could not", async () => {
  const check = async (body, status = 200) => {
    let release;
    const page = dashboard({ answers: { "/api/update?fresh": () => new Promise((resolve) => (release = resolve)) } });
    page.run("openSettings()");
    const button = page.document.getElementById("settingsBody").children[4].children[1];
    button.listeners.click[0]();
    assert.equal(button.disabled, true);
    release(status === 0 ? Promise.reject(new Error("sin red")) : await answer(body, status)());
    await settle();
    assert.equal(button.disabled, false);
    return page.document.getElementById("settingsNote").textContent;
  };
  assert.equal(await check({ ...UP_TO_DATE, available: false }), "Tienes la última versión, la 1.1.0.");
  assert.equal(
    await check({ ...UP_TO_DATE, available: true, latest: "1.2.0", local: false, how: "uv" }),
    "Hay una versión nueva: el aviso de arriba dice cómo instalarla.",
  );
  assert.equal(await check({ ...UP_TO_DATE, error: "GitHub no responde" }), "GitHub no responde");
  assert.equal(await check({ error: "Sin internet" }, 502), "No se pudo buscar actualizaciones: Sin internet");
});

test("the gear opens the settings, each saved on change and explained in its tooltip", async () => {
  const posts = [];
  const data = payload([session(at(new Date(), 9), null)]);
  const page = load({
    fetchImpl: async (url, opts) => {
      if (url !== "/api/state") return { ok: true, status: 200, json: async () => data };
      posts.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ ...page.run("store.state"), ...posts.at(-1) }) };
    },
  });
  await page.run("loadAndRender()");
  const doc = page.document,
    dialog = doc.getElementById("settingsDialog"),
    tip = doc.getElementById("tip");
  doc
    .getElementById("hero")
    .querySelectorAll(".icon-btn")
    .find((b) => b.title === "Ajustes")
    .listeners.click[0]();
  assert.equal(dialog.open, true);
  assert.ok(dialog.children.includes(tip));
  const rows = dialog.querySelectorAll(".setting");
  assert.deepEqual(
    rows.map((r) => r.children[0].textContent),
    ["Comida", "Descanso", "Botón «Salir a comer»", "Tema", "Actualizaciones"],
  );
  rows[2].listeners.pointerenter[0]({ clientX: 0, clientY: 0 });
  assert.match(tip.children[0].textContent, /^Horas entre las que aparece el botón/);

  const minutes = dialog.querySelectorAll(".lunch-input")[0];
  for (const value of ["999", "abc"]) {
    minutes.value = value;
    await minutes.listeners.change[0]();
  }
  assert.equal(minutes.value, "0");
  const [from, to] = dialog.querySelectorAll(".clock-input");
  assert.deepEqual([from.value, to.value], ["13:30", "16:00"]);
  from.value = "13:05";
  await from.listeners.change[0]();
  assert.deepEqual(posts, [{ lunch_minutes: 240 }, { lunch_minutes: 0 }, { lunch_button_from: 785 }]);
  to.value = "12:00";
  await to.listeners.change[0]();
  assert.match(doc.getElementById("settingsNote").textContent, /^No se ha guardado/);
  to.value = "";
  await to.listeners.change[0]();
  assert.deepEqual([to.value, doc.getElementById("settingsNote").textContent, posts.length], ["16:00", "", 3]);

  dialog
    .querySelectorAll(".btn")
    .find((b) => b.textContent === "Cerrar")
    .listeners.click[0]();
  dialog.listeners.close[0]();
  assert.equal(dialog.open, false);
  assert.ok(doc.body.children.includes(tip));
  page.run("store.personal.breaks = false; openSettings()");
  assert.equal(dialog.querySelectorAll(".setting").length, 4);
});

test("«Tema» keeps this browser's theme, and says so when the browser will not keep it", () => {
  const items = { theme: "dark" };
  const page = load({ local: memoryStorage(items) });
  const doc = page.document;
  assert.equal(doc.documentElement.dataset.theme, "dark");
  page.run("store.personal = { breaks: false }; openSettings()");
  const seg = doc.getElementById("settingsDialog").querySelectorAll(".seg")[0];
  const pressed = () => seg.children.map((b) => b.getAttribute("aria-pressed"));
  assert.deepEqual(
    seg.children.map((b) => b.textContent),
    ["Sistema", "Claro", "Oscuro"],
  );
  assert.deepEqual(pressed(), ["false", "false", "true"]);
  seg.children[1].listeners.click[0]();
  assert.deepEqual(
    [doc.documentElement.dataset.theme, items.theme, pressed()],
    ["light", "light", ["false", "true", "false"]],
  );
  assert.equal(doc.getElementById("settingsNote").textContent, "");
  seg.children[0].listeners.click[0]();
  assert.deepEqual([doc.documentElement.dataset.theme, items.theme], ["", ""]);

  const blocked = {
    getItem: () => {
      throw new Error("bloqueado");
    },
    setItem: () => {
      throw new Error("bloqueado");
    },
  };
  const locked = load({ local: blocked });
  assert.equal(locked.document.documentElement.dataset.theme, undefined);
  locked.run("store.personal = { breaks: false }; openSettings()");
  const dark = locked.document.getElementById("settingsDialog").querySelectorAll(".seg")[0].children[2];
  dark.listeners.click[0]();
  assert.equal(locked.document.documentElement.dataset.theme, "dark");
  assert.match(locked.document.getElementById("settingsNote").textContent, /^Este navegador no deja guardar el tema/);
});
