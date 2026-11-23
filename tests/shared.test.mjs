// shared.js: the basics both pages build on: the element lookup, the API call and the logout button. The module's
// functions are called straight from the page's context.

import assert from "node:assert/strict";
import { test } from "vitest";
import { answering, load, reply, teamPage, teamPayload } from "./page.mjs";

test("byId returns the page's element and names the one it lacks", () => {
  const page = load();
  assert.equal(page.run("byId('hero') === document.getElementById('hero')"), true);
  const real = page.document.getElementById;
  page.document.getElementById = () => null;
  assert.throws(() => page.run("byId('hero')"), /the page has no #hero/);
  page.document.getElementById = real;
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
  await assert.rejects(page.run("api('/api/personal')"), /caducada/);
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
