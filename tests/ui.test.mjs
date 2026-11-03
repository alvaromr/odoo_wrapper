// ui.js: the day's bar with its breaks, the punch buttons, the bell and the gear, the settings dialog and the icons.
// Each test asserts what is drawn (tags, classes, attributes, text) and what is requested (paths, bodies), on a clock
// the test sets (clockAt in page.mjs).

import assert from "node:assert/strict";
import test from "node:test";
import {
  answer,
  at,
  built,
  dashboard,
  dump,
  element,
  heroOf,
  hover,
  load,
  memoryStorage,
  payload,
  session,
  settle,
  TUESDAY,
  UP_TO_DATE,
} from "./page.mjs";

test("break spans sit where the break happened and gaps count only unlogged time", () => {
  const { run } = load();
  assert.deepEqual(
    run("restSpans([{ hours: 2, rest: false }, { hours: 0.25, rest: true }, { hours: 1, rest: false }])"),
    [{ from: 2, to: 2.25 }],
  );
  const monday = new Date(2026, 8, 14);
  const gap = (leaves) =>
    run(`unloggedGap([
    { in: new Date(${at(monday, 9).getTime()}), out: new Date(${at(monday, 12).getTime()}) },
    { in: new Date(${at(monday, 12, 30).getTime()}), out: null },
  ], ${JSON.stringify(leaves)})`);
  const leave = (h1, m1, h2, m2) => ({ from: at(monday, h1, m1).toISOString(), to: at(monday, h2, m2).toISOString() });
  assert.equal(gap([]), 0.5);
  assert.equal(gap([leave(11, 0, 12, 15)]), 0.25);
  assert.equal(gap([leave(12, 0, 12, 30)]), 0);
  assert.equal(gap([leave(15, 0, 16, 0)]), 0.5);
});

const buttonOf = (page, label) =>
  heroOf(page)
    .querySelectorAll(".btn")
    .find((b) => b.textContent === label);
const errOf = (page) => page.document.getElementById("hero").children[2].children.at(-1);
const press = async (page, label) => {
  const button = buttonOf(page, label);
  await button.listeners.click[0]();
  await button.listeners.click[0]();
  await settle();
  return button;
};

test("each punch button posts its own action after a second click, then reloads", async () => {
  const lunchTime = at(TUESDAY, 14);
  const open = [session(at(TUESDAY, 9), null)];
  const scenarios = [
    ["Fichar entrada", "checkin", "btn primary", { sessions: [] }],
    ["Fichar salida", "checkout", "btn primary", { sessions: open, now: lunchTime }],
    ["Salir a comer", "lunch", "btn ghost", { sessions: open, now: lunchTime }],
    ["Salir a descanso", "break", "btn ghost", { sessions: open, now: lunchTime }],
    ["Volver del descanso", "resume", "btn primary", { sessions: [session(at(TUESDAY, 9), null, true)] }],
  ];
  for (const [label, action, cls, options] of scenarios) {
    const page = dashboard(options);
    assert.equal(buttonOf(page, label).className, cls, label);
    await press(page, label);
    const posted = page.sent.filter((r) => r.method === "POST");
    assert.deepEqual(posted, [
      {
        url: "/api/attendance",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { action },
      },
    ]);
    assert.equal(page.sent.at(-1).url, "/api/data");
  }
});

test("a punch button arms for four seconds, and a pulsing one gets its pulse back", () => {
  const cleared = [];
  const page = dashboard({
    sessions: [session(at(TUESDAY, 1), null)],
    globals: { clearTimeout: (id) => cleared.push(id) },
  });
  const button = buttonOf(page, "Fichar salida");
  assert.equal(button.className, "btn primary pulse");
  button.listeners.click[0]();
  assert.equal(button.className, "btn primary arm");
  assert.equal(button.textContent, "¿Confirmar?");
  const [expire, ms] = page.calls.timeouts.at(-1);
  assert.equal(ms, 4000);
  expire();
  assert.equal(button.className, "btn primary pulse");
  assert.equal(button.textContent, "Fichar salida");
  button.listeners.click[0]();
  assert.equal(page.run("busy()"), true);
  button.listeners.click[0]();
  assert.deepEqual(cleared, [page.calls.timeouts.length]);
  const calm = dashboard({ sessions: [session(at(TUESDAY, 9), null)] });
  const other = buttonOf(calm, "Salir a descanso");
  other.listeners.click[0]();
  calm.calls.timeouts.at(-1)[0]();
  assert.equal(other.className, "btn ghost");
});

test("a punch in flight disables its button and clears the last error; a refusal gives the button back", async () => {
  let release;
  const page = dashboard({
    sessions: [session(at(TUESDAY, 9), null)],
    answers: {
      "/api/attendance": () => new Promise((resolve) => (release = resolve)),
    },
  });
  const button = buttonOf(page, "Fichar salida");
  errOf(page).textContent = "viejo";
  button.listeners.click[0]();
  button.listeners.click[0]();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Fichando…");
  assert.equal(errOf(page).textContent, "");
  release({ ok: false, status: 409, json: async () => ({ error: "Ya has fichado" }) });
  await settle();
  assert.equal(errOf(page).textContent, "Error: Ya has fichado");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Fichar salida");
  assert.equal(button.className, "btn primary");
});

test("a punch that went through but whose reload failed says so and keeps the button off", async () => {
  const page = dashboard({
    sessions: [session(at(TUESDAY, 9), null)],
    answers: { "/api/data": () => Promise.reject(new Error("Odoo caído")) },
  });
  const button = await press(page, "Fichar salida");
  assert.equal(errOf(page).textContent, "Fichado, pero no se pudo recargar: Odoo caído");
  assert.equal(button.disabled, true);
});

test("a punch ends by running the alarms on the fresh data", async () => {
  const page = dashboard({
    sessions: [session(at(TUESDAY, 9), null)],
    extra: { generated_at: at(TUESDAY, 8).toISOString() },
  });
  await press(page, "Fichar salida");
  assert.equal(page.run("store.now.getTime()"), TUESDAY.getTime());
});

test("the bell mutes the alerts and silences a blinking title, and unmutes without touching it", async () => {
  const page = dashboard({ sessions: [session(at(TUESDAY, 9), null)] });
  const mute = () =>
    heroOf(page)
      .querySelectorAll(".icon-btn")
      .find((b) => b.title.endsWith("avisos"));
  page.run(`flashTitle("⏰")`);
  page.calls.timers.at(-1)[0]();
  assert.equal(page.document.title, "⏰");
  mute().listeners.click[0]();
  assert.equal(page.document.title, "Fichajes");
  assert.equal(page.run("FlashTimer"), null);
  assert.equal(mute().title, "Reactivar avisos");
  assert.equal(mute().attrs["aria-label"], "Reactivar avisos");
  assert.equal(mute().attrs["aria-pressed"], "true");
  assert.equal(mute().children[0].children.length, 3);
  await settle();
  assert.deepEqual(
    page.sent.filter((r) => r.url === "/api/state").map((r) => r.body),
    [{ muted: true }],
  );
  page.run(`flashTitle("⏰")`);
  page.calls.timers.at(-1)[0]();
  mute().listeners.click[0]();
  assert.equal(page.document.title, "⏰");
  assert.notEqual(page.run("FlashTimer"), null);
});

test("the gear opens the settings dialog", () => {
  const page = dashboard({ sessions: [] });
  const gear = heroOf(page)
    .querySelectorAll(".icon-btn")
    .find((b) => b.title === "Ajustes");
  assert.equal(page.document.getElementById("settingsDialog").open, false);
  gear.listeners.click[0]();
  assert.equal(page.document.getElementById("settingsDialog").open, true);
});

test("a break is drawn at its place in the bar, as a share of the total", () => {
  const page = dashboard();
  const bar = built(
    page,
    `fillBar(document.createElement("div"), [
      { hours: 4, rest: false }, { hours: 2, rest: true }, { hours: 1, rest: false }, { hours: 1, rest: true },
    ], 8)`,
  );
  assert.deepEqual(dump(bar).split("\n"), [
    "div",
    "  div.rest [left:50% width:25%]",
    "  div.rest [left:87.5% width:12.5%]",
  ]);
});

test("the page is busy while a tooltip is open or a button is armed, and idle otherwise", () => {
  const page = dashboard({ sessions: [session(at(TUESDAY, 9), null)] });
  assert.strictEqual(page.run("busy()"), false);
  page.document.getElementById("tip").style.display = "block";
  assert.strictEqual(page.run("busy()"), true);
  page.document.getElementById("tip").style.display = "none";
  assert.strictEqual(page.run("busy()"), false);
  buttonOf(page, "Fichar salida").listeners.click[0]();
  assert.strictEqual(page.run("busy()"), true);
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

test("the icons are SVG paths with the same stroke, and the muted bell is crossed out", () => {
  const page = dashboard();
  const spaces = [];
  page.document.createElementNS = (space, tag) => {
    spaces.push(space);
    return element(tag);
  };
  const stroke = {
    viewBox: "0 0 24 24",
    width: "15",
    height: "15",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  };
  for (const [call, paths] of [
    ["bellIcon(false)", 2],
    ["bellIcon(true)", 3],
    ["gearIcon()", 2],
    ["qrIcon()", 12],
  ]) {
    const svg = built(page, call);
    assert.equal(svg.tagName, "SVG", call);
    assert.deepEqual({ ...svg.attrs }, stroke, call);
    assert.equal(svg.children.length, paths, call);
    for (const path of svg.children) {
      assert.equal(path.tagName, "PATH");
      assert.match(path.attrs.d, /^M[\d.]/, call);
    }
  }
  assert.equal(built(page, "bellIcon(true)").children[2].attrs.d, "M3 3l18 18");
  assert.equal(
    built(page, "gearIcon()").children[0].attrs.d,
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38" +
      "a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38" +
      "a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2" +
      "v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73" +
      "l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73" +
      "l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
  );
  assert.equal(spaces.length > 0 && spaces.every((space) => space === "http://www.w3.org/2000/svg"), true);
});

test("a day with no hours expected does not pulse the check-out button", () => {
  const page = dashboard({
    sessions: [session(at(TUESDAY, 9), null)],
    schedule: "store.expected = [0, 0, 0, 0, 0, 0, 0]; store.weekTarget = 0;",
  });
  assert.equal(buttonOf(page, "Fichar salida").className, "btn primary");
});

test("a punch that succeeds but fails to reload says so and leaves the button disabled", async () => {
  const today = new Date();
  let punchedOnce = false;
  const fetchImpl = async (url, opts) => {
    if (opts && opts.method === "POST") {
      punchedOnce = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (punchedOnce) throw new Error("caído");
    return { ok: true, status: 200, json: async () => payload([session(at(today, 9), null)]) };
  };
  const page = load({ fetchImpl });
  await page.run("loadAndRender()");
  const hero = page.document.getElementById("hero");
  const button = hero.querySelectorAll(".btn").find((b) => b.textContent === "Fichar salida");
  await button.listeners.click[0]();
  await button.listeners.click[0]();
  const errBox = hero.querySelector(".err");
  assert.equal(errBox.textContent, "Fichado, pero no se pudo recargar: caído");
  assert.equal(button.disabled, true);
});

test("a punch that itself fails restores the button and shows the plain error", async () => {
  const today = new Date();
  const fetchImpl = async (url, opts) => {
    if (opts && opts.method === "POST") throw new Error("sin conexión");
    return { ok: true, status: 200, json: async () => payload([session(at(today, 9), null)]) };
  };
  const page = load({ fetchImpl });
  await page.run("loadAndRender()");
  const hero = page.document.getElementById("hero");
  const button = hero.querySelectorAll(".btn").find((b) => b.textContent === "Fichar salida");
  await button.listeners.click[0]();
  await button.listeners.click[0]();
  const errBox = hero.querySelector(".err");
  assert.equal(errBox.textContent, "Error: sin conexión");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Fichar salida");
});

test("an armed punch button disarms by itself after four seconds", async () => {
  const today = new Date();
  const schedule = { hours: [7, 7, 7, 7, 7, 7, 7], lunch_from: [13, 13, 13, 13, 13, 13, 13] };
  const page = load({ data: payload([session(at(today, 9), null)], { schedule }) });
  await page.run("loadAndRender()");
  const hero = page.document.getElementById("hero");
  const button = hero.querySelectorAll(".btn").find((b) => b.textContent === "Fichar salida");
  button.classList.add("pulse");
  await button.listeners.click[0]();
  assert.equal(button.textContent, "¿Confirmar?");
  const [disarm, ms] = page.calls.timeouts.at(-1);
  assert.equal(ms, 4000);
  disarm();
  assert.equal(button.textContent, "Fichar salida");
  assert.deepEqual(
    ["arm", "pulse"].map((c) => button.classList.contains(c)),
    [false, true],
  );
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
  page.run("store.data.breaks = false; openSettings()");
  assert.equal(dialog.querySelectorAll(".setting").length, 4);
});

test("«Tema» keeps this browser's theme, and says so when the browser will not keep it", () => {
  const items = { theme: "dark" };
  const page = load({ local: memoryStorage(items) });
  const doc = page.document;
  assert.equal(doc.documentElement.dataset.theme, "dark");
  page.run("store.data = { breaks: false }; openSettings()");
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
  locked.run("store.data = { breaks: false }; openSettings()");
  const dark = locked.document.getElementById("settingsDialog").querySelectorAll(".seg")[0].children[2];
  dark.listeners.click[0]();
  assert.equal(locked.document.documentElement.dataset.theme, "dark");
  assert.match(locked.document.getElementById("settingsNote").textContent, /^Este navegador no deja guardar el tema/);
});

test("a punch that goes through reloads and checks the alarms", async () => {
  const today = new Date();
  let punched = false;
  const page = load({
    fetchImpl: async (url, opts) => {
      if (opts?.method === "POST") {
        punched = true;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => payload(punched ? [session(at(today, 9), at(today, 10))] : [session(at(today, 9), null)]),
      };
    },
  });
  await page.run("loadAndRender()");
  const hero = page.document.getElementById("hero");
  const button = hero.querySelectorAll(".btn").find((b) => b.textContent === "Fichar salida");
  await button.listeners.click[0]();
  await button.listeners.click[0]();
  assert.equal(punched, true);
  assert.deepEqual(
    hero.querySelectorAll(".btn").map((b) => b.textContent),
    ["Fichar entrada"],
  );
  assert.equal(hero.querySelector(".err").textContent, "");
});
