// shared.js: what both pages use: the element lookup, the API call, the tooltip, the pan of a scrolling box, the logout
// button and the updates banner with «Actualizar ahora». The module's functions are called straight from the page's
// context, each node dumped as one line (show in page.mjs), so a class, an attribute or a text that changes shows up as
// a failing line.

import assert from "node:assert/strict";
import test from "node:test";
import {
  answering,
  element,
  load,
  payload,
  reply,
  settle,
  show,
  showAll,
  teamFixes,
  teamPage,
  teamPayload,
  tipOf,
  UP_TO_DATE,
} from "./page.mjs";

test("byId returns the page's element and names the one it lacks", () => {
  const page = load();
  assert.equal(page.run("byId('hero') === document.getElementById('hero')"), true);
  const real = page.document.getElementById;
  page.document.getElementById = () => null;
  assert.throws(() => page.run("byId('hero')"), /the page has no #hero/);
  page.document.getElementById = real;
});

test("the tooltip opens on the far side of the pointer when it would not fit the window", () => {
  const page = teamPage();
  const node = element("div");
  page.run("attachTip")(node, (box) => box.appendChild(page.run("el")("div", "t-title", "Hola")));
  const tip = tipOf(page);
  tip.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 100, height: 50 });
  const placed = (x, y) => {
    node.listeners.pointermove[0]({ clientX: x, clientY: y });
    return [tip.style.left, tip.style.top];
  };
  assert.deepEqual(placed(10, 10), ["24px", "24px"]);
  assert.deepEqual(placed(1158, 728), ["1172px", "742px"]);
  assert.deepEqual(placed(1165, 741), ["1051px", "677px"]);
  assert.deepEqual(placed(1200, 10), ["1086px", "24px"]);
});

test("a tooltip says whether it is open, and opens on focus below the middle of what has it", () => {
  const page = teamPage();
  const node = element("div");
  node.getBoundingClientRect = () => ({ left: 100, top: 30, right: 140, bottom: 70, width: 40, height: 40 });
  page.run("attachTip")(node, (box) => box.appendChild(page.run("tipRow")("Horas", "8h")));
  const tipOpen = () => page.run("tipOpen()");
  assert.equal(tipOpen(), false);
  node.listeners.focus[0]();
  assert.equal(tipOpen(), true);
  assert.deepEqual([tipOf(page).style.left, tipOf(page).style.top], ["134px", "84px"]);
  assert.deepEqual(showAll(tipOf(page).children), ["div.t-row", '  span.k "Horas"', '  span.v "8h"']);
  node.listeners.blur[0]();
  assert.equal(tipOpen(), false);
  assert.equal(tipOf(page).style.display, "none");
});

test("a tooltip also opens on keyboard focus and closes on blur", () => {
  const page = load({ entry: "team.js" });
  const node = page.document.createElement("div");
  page.run("attachTip").call(null, node, (tip) => tip.appendChild(page.run("el('div', 't-title', 'Hola')")));
  node.listeners.focus[0]();
  const tip = page.document.getElementById("tip");
  node.listeners.pointermove[0]({ clientX: 40, clientY: 50 });
  assert.deepEqual([tip.style.left, tip.style.top], ["54px", "64px"]);
  assert.equal(tip.style.display, "block");
  assert.equal(tip.children[0].textContent, "Hola");
  node.listeners.blur[0]();
  assert.equal(tip.style.display, "none");
});

test("api posts JSON when it has a body and plain otherwise", async () => {
  const sent = [];
  const page = teamPage({
    fetchImpl: answering((url, opts) => {
      if (!url.startsWith("/api/echo")) return undefined;
      sent.push([url, opts && JSON.parse(JSON.stringify(opts))]);
      return reply({ ok: true });
    }),
  });
  await page.run("api")("/api/echo", { a: 1 });
  await page.run("api")("/api/echo");
  assert.deepEqual(sent, [
    ["/api/echo", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"a":1}' }],
    ["/api/echo", undefined],
  ]);
});

test("a 401 sends the page to the login", async () => {
  const page = load({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: "caducada" }) }) });
  await new Promise((resolve) => setImmediate(resolve));
  page.calls.replace.length = 0;
  await assert.rejects(page.run("api('/api/data')"), /caducada/);
  assert.deepEqual(page.calls.replace, ["/login"]);
});

test("the logout button is disabled while the request is on its way", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const page = teamPage({
    fetchImpl: answering(async (url) => {
      if (url !== "/api/logout") return undefined;
      await gate;
      return reply({ ok: true });
    }),
  });
  const button = page.document.getElementById("logoutBtn");
  const done = button.listeners.click[0]();
  assert.equal(button.disabled, true);
  release();
  await done;
  assert.deepEqual(page.calls.replace, ["/login"]);
});

test("logout goes to the login page, or says it failed and stays usable", async () => {
  let ok = true;
  const page = load({
    entry: "team.js",
    fetchImpl: async (url) =>
      url === "/api/logout"
        ? { ok, status: ok ? 200 : 502, json: async () => (ok ? { ok: true } : { error: "Odoo no responde" }) }
        : { ok: true, status: 200, json: async () => teamPayload() },
  });
  const button = page.document.getElementById("logoutBtn");
  await button.listeners.click[0]();
  assert.deepEqual(page.calls.replace, ["/login"]);
  ok = false;
  await button.listeners.click[0]();
  assert.equal(button.textContent, "Error al cerrar sesión");
  assert.equal(button.title, "Odoo no responde");
  assert.equal(button.disabled, false);
  assert.deepEqual(page.calls.replace, ["/login"]);
});

test("a press pans a box only once it moves, leaves links alone and tells a click it was a drag, once", () => {
  const page = teamPage();
  const scroller = element("div");
  const captured = [];
  scroller.setPointerCapture = (id) => captured.push(id);
  const pan = page.run("panScroll")(scroller);
  const on = (type, event) => scroller.listeners[type][0](event);
  const plain = { closest: (selector) => (selector === "a" ? null : {}) };
  const link = { closest: (selector) => (selector === "a" ? {} : null) };
  const press = (target) =>
    on("pointerdown", { button: 0, pointerType: "mouse", target, clientX: 100, clientY: 100, pointerId: 7 });
  scroller.scrollLeft = 50;
  scroller.scrollTop = 20;

  press(link);
  on("pointermove", { clientX: 160, clientY: 100 });
  assert.deepEqual([scroller.scrollLeft, scroller.scrollTop], [50, 20]);

  press(plain);
  assert.equal(pan.consume(), false);
  on("pointermove", { clientX: 103, clientY: 100 });
  assert.deepEqual([scroller.scrollLeft, scroller.classList.contains("dragging"), captured], [50, false, []]);
  const owner = element("div");
  page.run("attachTip")(owner, (box) => box.appendChild(page.run("el")("div", "t-title", "Hola")));
  owner.listeners.pointerenter[0]({ clientX: 1, clientY: 1 });
  assert.equal(page.run("tipOpen()"), true);
  on("pointermove", { clientX: 110, clientY: 100 });
  assert.equal(page.run("tipOpen()"), false);
  assert.deepEqual([scroller.scrollLeft, scroller.scrollTop, scroller.classList.contains("dragging")], [40, 20, true]);
  assert.deepEqual(captured, [7]);
  on("pointerup");
  assert.equal(scroller.classList.contains("dragging"), false);
  assert.deepEqual([pan.consume(), pan.consume()], [true, false]);

  press(plain);
  on("pointerup");
  assert.equal(pan.consume(), false);
});

const OFFER = {
  available: true,
  current: "1.1.0",
  latest: "1.2.0",
  url: "https://github.com/r/releases/tag/v1.2.0",
  local: true,
  how: "auto",
};
const PLUGIN_NOTE = [
  "p",
  '  "Las skills de Claude Code se actualizan con "',
  '  code "claude plugin update odoo@odoo-wrapper"',
  '  "."',
];
const upgradeNote = (lead) => [
  "p",
  `  "${lead}"`,
  '  "Para instalarla, ejecuta "',
  '  code "uv tool upgrade odoo-wrapper"',
  '  " en una terminal del ordenador: el dashboard se reinicia solo."',
];

test("the update banner hides without an update and offers the right way to install when there is one", () => {
  const page = teamPage();
  const banner = page.document.getElementById("updateBanner");
  const showUpdate = page.run("showUpdate");

  showUpdate({ ...OFFER, available: false });
  assert.deepEqual([banner.classList.contains("hidden"), banner.children.length], [true, 0]);

  assert.equal(showUpdate(OFFER), OFFER);
  assert.equal(banner.classList.contains("hidden"), false);
  assert.deepEqual(show(banner.children[0]), [
    "p",
    '  strong "Hay una versión nueva, la 1.2.0"',
    '  " (tienes la 1.1.0). "',
    '  a href=https://github.com/r/releases/tag/v1.2.0 target=_blank rel=noopener "Novedades"',
    '  "."',
  ]);
  assert.deepEqual(show(banner.children[1]), [
    "div.update-actions",
    '  button.btn.primary.small type=button "Actualizar ahora"',
    "  span role=status",
  ]);

  showUpdate({ ...OFFER, how: "git" });
  assert.deepEqual(show(banner.children[1]), ["p", '  "Es la instalación de desarrollo: tráela con git."']);
  assert.deepEqual(show(banner.children[2]), PLUGIN_NOTE);

  showUpdate({ ...OFFER, how: "none" });
  assert.deepEqual(show(banner.children[1]), upgradeNote("No encuentro uv en este ordenador. "));
  assert.deepEqual(show(banner.children[2]), PLUGIN_NOTE);

  showUpdate({ ...OFFER, local: false });
  assert.deepEqual(show(banner.children[1]), upgradeNote(""));
});

function updating(route) {
  const timers = [],
    cleared = [];
  let restarting = false;
  const page = teamPage({
    fetchImpl: answering((url, opts) => (restarting ? route(url, opts) : undefined)),
    globals: {
      setTimeout: (fn, ms) => {
        if (ms === 2000) {
          fn();
          return 0;
        }
        timers.push([fn, ms]);
        return timers.length;
      },
      clearTimeout: (id) => cleared.push(id),
    },
  });
  return { page, timers, cleared, start: () => (restarting = true) };
}

function installer(page) {
  page.run("showUpdate")(OFFER);
  const [button, note] = page.document.getElementById("updateBanner").children[1].children;
  return { button, note };
}

test("«Actualizar ahora» asks twice, installs, waits for the new version and reloads", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let gets = 0;
  const { page, timers, cleared, start } = updating(async (url, opts) => {
    if (url !== "/api/update") return undefined;
    if (opts) {
      await gate;
      return reply({ skills: "" });
    }
    gets += 1;
    if (gets === 1) throw new Error("sin red");
    if (gets === 2) return reply({ current: "1.1.0" });
    if (gets === 3) return reply({ error: "ocupado" }, 503);
    return reply({ current: "1.2.0" });
  });
  await settle();
  start();
  const { button, note } = installer(page);
  assert.equal(note.textContent, "");
  await button.listeners.click[0]();
  assert.equal(button.textContent, "¿Instalar la 1.2.0?");
  assert.deepEqual(
    timers.map(([, ms]) => ms),
    [4000],
  );
  timers[0][0]();
  assert.equal(button.textContent, "Actualizar ahora");
  await button.listeners.click[0]();
  const done = button.listeners.click[0]();
  assert.deepEqual(cleared, [2]);
  assert.deepEqual(
    [button.disabled, button.textContent, note.textContent],
    [true, "Instalando…", "Puede tardar un minuto."],
  );
  const banner = page.document.getElementById("updateBanner");
  page.run("showUpdate")({ ...OFFER, available: false });
  assert.equal(banner.classList.contains("hidden"), false);
  release();
  await done;
  assert.equal(gets, 4);
  assert.equal(note.textContent, "Instalada: reiniciando el panel…");
  assert.equal(page.calls.reload, 1);
  assert.deepEqual(page.calls.warnings, ["[odoo] waiting for the restarted dashboard failed: Error: sin red"]);
});

test("«Actualizar ahora» says when the skills were not updated", async () => {
  const { page, start } = updating(async (url, opts) => {
    if (url !== "/api/update") return undefined;
    return opts ? reply({ skills: "no encuentro claude" }) : reply({ current: "1.2.0" });
  });
  await settle();
  start();
  const { button, note } = installer(page);
  await button.listeners.click[0]();
  await button.listeners.click[0]();
  assert.deepEqual([button.textContent, button.disabled, page.calls.reload], ["Instalada", true, 0]);
  assert.deepEqual(showAll(note.children), [
    '"La 1.2.0 ya funciona, pero las skills de Claude Code no se han actualizado (no encuentro claude). Ejecuta "',
    'code "claude plugin update odoo@odoo-wrapper"',
    '" y recarga esta página."',
  ]);
});

test("«Actualizar ahora» gives up after ninety polls and becomes usable again", async () => {
  let gets = 0;
  const { page, start } = updating(async (url, opts) => {
    if (url !== "/api/update") return undefined;
    if (opts) return reply({ skills: "" });
    gets += 1;
    return reply({ current: "1.1.0" });
  });
  await settle();
  start();
  const { button, note } = installer(page);
  await button.listeners.click[0]();
  await button.listeners.click[0]();
  assert.equal(gets, 90);
  assert.equal(
    note.textContent,
    "No se pudo actualizar: el panel no ha vuelto en tres minutos: mira ~/.odoo_dashboard/dashboard.log",
  );
  assert.deepEqual([button.disabled, button.textContent], [false, "Actualizar ahora"]);
});

test("a failed update check leaves a trace in the console", async () => {
  const page = teamPage({
    fetchImpl: answering((url) => {
      if (url === "/api/update") throw new Error("sin red");
    }),
  });
  await settle();
  assert.deepEqual(page.calls.warnings, ["[odoo] the update check failed: Error: sin red"]);
});

test("a newer version shows the banner on both pages, and «Actualizaciones» checks now and says the answer", async () => {
  const newer = {
    available: true,
    current: "1.0.0",
    latest: "1.1.0",
    url: "https://github.com/r/releases/tag/v1.1.0",
    error: "",
  };
  let answer = newer;
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.startsWith("/api/update")) {
      if (answer instanceof Error) throw answer;
      const body = answer;
      return { ok: !body.refused, status: body.refused ? 401 : 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => (url.includes("fixes") ? teamFixes() : teamPayload()) };
  };
  for (const [entry, path] of [
    ["app.js", "/"],
    ["team.js", "/gestion"],
  ]) {
    const page = load({ entry, path, fetchImpl });
    await settle();
    const banner = page.document.getElementById("updateBanner");
    assert.equal(banner.classList.contains("hidden"), false, entry);
    assert.deepEqual(
      banner.children.map((c) => c.tagName),
      ["P", "P", "P"],
    );
    assert.deepEqual(
      banner.querySelectorAll("code").map((c) => c.textContent),
      ["uv tool upgrade odoo-wrapper", "claude plugin update odoo@odoo-wrapper"],
    );
    assert.equal(banner.children[0].children[0].textContent, "Hay una versión nueva, la 1.1.0");
    assert.equal(banner.children[0].children[1], " (tienes la 1.0.0). ");
    const notes = banner.querySelectorAll("a")[0];
    assert.deepEqual(
      [notes.textContent, notes.href, notes.target, notes.rel],
      ["Novedades", newer.url, "_blank", "noopener"],
    );
    assert.ok(
      page.calls.timers.some(([, ms]) => ms === 3600000),
      entry,
    );
  }

  const page = load({ fetchImpl });
  await settle();
  const doc = page.document,
    banner = doc.getElementById("updateBanner"),
    note = doc.getElementById("settingsNote");
  const poll = page.calls.timers.find(([, ms]) => ms === 3600000)[0];
  answer = { refused: true, error: "no autorizado" };
  await poll();
  await settle();
  assert.equal(banner.classList.contains("hidden"), false);
  answer = new Error("sin red");
  await poll();
  await settle();
  assert.equal(banner.classList.contains("hidden"), false);

  page.run("openSettings()");
  const check = doc
    .getElementById("settingsDialog")
    .querySelectorAll(".btn")
    .find((b) => b.textContent === "Buscar ahora");
  const cases = [
    [UP_TO_DATE, "Tienes la última versión, la 1.1.0.", true],
    [newer, "Hay una versión nueva: el aviso de arriba dice cómo instalarla.", false],
    [
      { ...UP_TO_DATE, latest: null, url: null, error: "No se pudo consultar GitHub: HTTP Error 403" },
      "No se pudo consultar GitHub: HTTP Error 403",
      true,
    ],
    [new Error("sin red"), "No se pudo buscar actualizaciones: sin red", true],
  ];
  for (const [next, text, hidden] of cases) {
    answer = next;
    await check.listeners.click[0]();
    assert.deepEqual([note.textContent, banner.classList.contains("hidden"), check.disabled], [text, hidden, false]);
  }
  assert.equal(urls.filter((u) => u === "/api/update?fresh").length, 4);
});

test("on the machine itself «Actualizar ahora» installs after a second click, waits for the restart and reloads", async () => {
  const newer = {
    available: true,
    current: "1.0.0",
    latest: "1.1.0",
    url: "https://github.com/r/releases/tag/v1.1.0",
    error: "",
    local: true,
    how: "auto",
  };
  const state = { answer: newer, install: { ok: true, status: 200, body: { ok: true } }, down: false };
  const posts = [];
  const page = load({
    fetchImpl: async (url, opts) => {
      if (url === "/api/update" && opts?.method === "POST") {
        posts.push(url);
        const { ok, status, body } = state.install;
        return { ok, status, json: async () => body };
      }
      if (url.startsWith("/api/update")) {
        if (state.down) throw new Error("reiniciando");
        return { ok: true, status: 200, json: async () => state.answer };
      }
      return { ok: true, status: 200, json: async () => payload([]) };
    },
  });
  await settle();
  const doc = page.document,
    banner = doc.getElementById("updateBanner");
  const button = () => banner.querySelectorAll("button")[0];
  const note = () => banner.querySelectorAll("span")[0];
  const waits = () => (page.calls.timeouts || []).filter(([, ms]) => ms === 2000);
  const drive = async (steps = 3) => {
    for (let done = 0; done < steps; done++) {
      await settle();
      const pending = waits().splice(0);
      page.calls.timeouts = (page.calls.timeouts || []).filter(([, ms]) => ms !== 2000);
      if (!pending.length) return;
      for (const [fn] of pending) fn();
    }
  };
  assert.equal(
    banner.querySelectorAll("code").some((c) => c.textContent === "uv tool upgrade odoo-wrapper"),
    false,
  );
  assert.deepEqual(
    banner.children.map((c) => c.className || c.tagName),
    ["P", "update-actions"],
  );
  assert.equal(banner.querySelectorAll("code").length, 0);
  assert.deepEqual(banner.children.at(-1).children, [button(), note()]);
  assert.equal(button().textContent, "Actualizar ahora");

  button().listeners.click[0]();
  assert.equal(button().textContent, "¿Instalar la 1.1.0?");
  page.calls.timeouts.find(([, ms]) => ms === 4000)[0]();
  assert.equal(button().textContent, "Actualizar ahora");
  assert.equal(posts.length, 0);

  state.install = { ok: false, status: 502, body: { error: "uv no pudo instalarla: boom" } };
  button().listeners.click[0]();
  await button().listeners.click[0]();
  assert.deepEqual(
    [note().textContent, button().disabled, button().textContent],
    ["No se pudo actualizar: uv no pudo instalarla: boom", false, "Actualizar ahora"],
  );

  state.install = { ok: true, status: 200, body: { ok: true } };
  state.down = true;
  button().listeners.click[0]();
  const installing = button().listeners.click[0]();
  await settle();
  assert.deepEqual(
    [button().disabled, button().textContent, note().textContent],
    [true, "Instalando…", "Instalada: reiniciando el panel…"],
  );
  const kept = button();
  page.run("showUpdate({ available: false })");
  assert.equal(banner.classList.contains("hidden"), false);
  await drive();
  state.down = false;
  await drive();
  assert.equal(page.calls.reload, 0);
  state.answer = { ...newer, current: "1.1.0", available: false };
  await drive();
  await installing;
  assert.equal(page.calls.reload, 1);
  assert.equal(button(), kept);

  state.answer = newer;
  const stuck = load({
    fetchImpl: async (url, opts) => ({
      ok: true,
      status: 200,
      json: async () => (opts?.method === "POST" ? { ok: true } : url.startsWith("/api/update") ? newer : payload([])),
    }),
  });
  await settle();
  const stuckBanner = stuck.document.getElementById("updateBanner");
  const stuckButton = stuckBanner.querySelectorAll("button")[0];
  stuckButton.listeners.click[0]();
  const pending = stuckButton.listeners.click[0]();
  for (let i = 0; i < 100; i++) {
    await settle();
    const timers = (stuck.calls.timeouts || []).filter(([, ms]) => ms === 2000);
    stuck.calls.timeouts = [];
    for (const [fn] of timers) fn();
  }
  await pending;
  assert.match(stuckBanner.querySelectorAll("span")[0].textContent, /el panel no ha vuelto en tres minutos/);
  assert.equal(stuck.calls.reload, 0);

  let restartedYet = false;
  const partial = load({
    fetchImpl: async (url, opts) => ({
      ok: true,
      status: 200,
      json: async () =>
        opts?.method === "POST"
          ? { ok: true, skills: "marketplace not found" }
          : url.startsWith("/api/update")
            ? restartedYet
              ? { ...newer, current: "1.2.0" }
              : { ...newer, latest: "1.2.0" }
            : payload([]),
    }),
  });
  await settle();
  const partialBanner = partial.document.getElementById("updateBanner");
  const partialButton = partialBanner.querySelectorAll("button")[0];
  partialButton.listeners.click[0]();
  const partialRun = partialButton.listeners.click[0]();
  await settle();
  restartedYet = true;
  for (const [fn] of partial.calls.timeouts.filter(([, ms]) => ms === 2000)) fn();
  await partialRun;
  const said = partialBanner.querySelectorAll("span")[0];
  assert.deepEqual([partial.calls.reload, partialButton.textContent, partialButton.disabled], [0, "Instalada", true]);
  assert.equal(
    said.children[0],
    "La 1.2.0 ya funciona, pero las skills de Claude Code no se han actualizado " + "(marketplace not found). Ejecuta ",
  );
  assert.equal(said.children[1].textContent, "claude plugin update odoo@odoo-wrapper");

  const texts = (how) => {
    const other = load({
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        json: async () => (url.startsWith("/api/update") ? { ...newer, how } : payload([])),
      }),
    });
    return settle().then(() =>
      other.document
        .getElementById("updateBanner")
        .children.map((p) => p.children.filter((c) => typeof c === "string").join("")),
    );
  };
  assert.equal((await texts("git"))[1], "Es la instalación de desarrollo: tráela con git.");
  assert.match((await texts("manual"))[1], /^No encuentro uv en este ordenador\. Para instalarla, ejecuta/);
});
