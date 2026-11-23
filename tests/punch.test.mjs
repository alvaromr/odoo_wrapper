// punch.js: the hero's punch buttons, armed by a first click and punching on the second, and what each failure says.
// Each test asserts what is drawn and what is requested (paths, bodies), on a clock the test sets (clockAt in
// page.mjs).

import assert from "node:assert/strict";
import { test } from "vitest";
import { at, dashboard, heroOf, load, payload, session, settle, TUESDAY } from "./page.mjs";

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
    assert.equal(page.sent.at(-1).url, "/api/personal");
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
    answers: { "/api/personal": () => Promise.reject(new Error("Odoo caído")) },
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
