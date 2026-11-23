// login.js: the login page with its fields as login.html has them: which ones it asks for, the code Odoo may want
// and what a refused sign-in says, on a clock the test sets (clockAt in page.mjs).

import assert from "node:assert/strict";
import { test } from "vitest";
import { answer, clockAt, element, load, settle } from "./page.mjs";

// The login page with its fields as login.html has them: the URL, the database and the code start hidden.
async function loginPage({ config = { local: true, configured: true, user: "" }, login = answer({}) } = {}) {
  const fields = {};
  const focused = [];
  const field = (id) => {
    if (!fields[id]) {
      fields[id] = element("div");
      fields[id].hidden = ["url", "db", "code"].includes(id);
      fields[id].focus = () => focused.push(id);
    }
    return fields[id];
  };
  const sent = [];
  const Clock = clockAt(new Date(2026, 8, 15, 9, 5));
  const page = load({
    entry: "login.js",
    globals: { Date: Clock, document: { getElementById: field, documentElement: element("html") } },
    fetchImpl: async (url, opts) => {
      sent.push({
        url,
        method: opts?.method,
        headers: opts?.headers && { ...opts.headers },
        body: opts?.body && JSON.parse(opts.body),
      });
      return url === "/api/config" ? answer(config)() : login(url, opts);
    },
  });
  await settle();
  return { ...page, field, fields, focused, sent };
}

test("the login page shows the time and puts the cursor where the next thing to type is", async () => {
  const configured = await loginPage({ config: { local: true, configured: true, user: "" } });
  assert.equal(configured.field("clock").textContent, "09:05");
  assert.equal(configured.calls.timers[0][1], 10000);
  assert.equal(configured.field("user").value, "");
  assert.deepEqual(configured.focused, ["user"]);
  assert.equal(configured.field("url").hidden, true);
  assert.equal(configured.field("db").hidden, true);
  assert.notEqual(configured.field("url").required, true);
  const known = await loginPage({ config: { local: true, configured: true, user: "ana" } });
  assert.equal(known.field("user").value, "ana");
  assert.deepEqual(known.focused, ["pass"]);
  const fresh = await loginPage({ config: { local: true, configured: false } });
  assert.deepEqual([fresh.field("url").hidden, fresh.field("db").hidden], [false, false]);
  assert.deepEqual([fresh.field("url").required, fresh.field("db").required], [true, true]);
  assert.equal(fresh.field("code").hidden, true);
  assert.deepEqual(fresh.focused, ["url"]);
});

test("off the machine itself the login page only says how to pair the phone", async () => {
  const page = await loginPage({ config: { local: false, configured: true, user: "ana" } });
  assert.equal(
    page.field("hint").textContent,
    "Aquí no se inicia sesión. En el ordenador, abre http://localhost:8931/ y pulsa «Emparejar móvil»: escanea el código que aparece y entrarás sin contraseña.",
  );
  assert.deepEqual(
    ["user", "secret", "submit"].map((id) => page.field(id).hidden),
    [true, true, true],
  );
  assert.deepEqual(page.focused, []);
});

test("the eye shows and hides the password", async () => {
  const page = await loginPage();
  page.field("pass").type = "password";
  page.field("eye-slash").classList.add("hidden");
  page.focused.length = 0;
  page.field("eye").listeners.click[0]();
  assert.equal(page.field("pass").type, "text");
  assert.equal(page.field("eye-slash").classList.contains("hidden"), false);
  assert.deepEqual(page.field("eye").attrs, { "aria-pressed": "true", "aria-label": "Ocultar contraseña" });
  assert.deepEqual(page.focused, ["pass"]);
  page.field("eye").listeners.click[0]();
  assert.equal(page.field("pass").type, "password");
  assert.equal(page.field("eye-slash").classList.contains("hidden"), true);
  assert.deepEqual(page.field("eye").attrs, { "aria-pressed": "false", "aria-label": "Mostrar contraseña" });
});

const submit = async (page, values = {}) => {
  for (const [id, value] of Object.entries({ url: "u", db: "d", user: "ana", pass: "p", code: "123456", ...values })) {
    page.field(id).value = value;
  }
  let prevented = 0;
  const done = page.field("login").listeners.submit[0]({ preventDefault: () => prevented++ });
  return { done, prevented };
};

test("signing in posts every field and goes to the dashboard", async () => {
  const page = await loginPage({ login: answer({ ok: true }) });
  page.field("err").textContent = "viejo";
  const { done, prevented } = await submit(page);
  assert.equal(prevented, 1);
  assert.equal(page.field("err").textContent, "");
  assert.equal(page.field("submit").disabled, true);
  await done;
  assert.deepEqual(page.sent.at(-1), {
    url: "/api/login",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { url: "u", db: "d", user: "ana", password: "p", code: "123456" },
  });
  assert.deepEqual(page.calls.replace, ["/"]);
  assert.equal(page.field("submit").disabled, true);
});

test("a refused sign-in says why and gives the button back, with or without a message", async () => {
  const refused = await loginPage({ login: answer({ error: "Credenciales erróneas" }, 401) });
  await (await submit(refused)).done;
  assert.equal(refused.field("err").textContent, "Credenciales erróneas");
  assert.equal(refused.field("submit").disabled, false);
  const silent = await loginPage({ login: answer({}, 500) });
  await (await submit(silent)).done;
  assert.equal(silent.field("err").textContent, "HTTP 500");
  const broken = await loginPage({ login: () => Promise.reject(new Error("sin red")) });
  await (await submit(broken)).done;
  assert.equal(broken.field("err").textContent, "sin red");
  assert.equal(broken.field("submit").disabled, false);
  assert.deepEqual(broken.calls.replace, []);
});

test("when Odoo wants a two-factor code the page asks for it and waits", async () => {
  const page = await loginPage({ login: answer({ totp: true }, 401) });
  page.focused.length = 0;
  await (await submit(page)).done;
  assert.equal(
    page.field("hint").textContent,
    "Introduce el código de tu aplicación de verificación. Este navegador quedará como dispositivo de confianza 90 días.",
  );
  assert.equal(page.field("code").hidden, false);
  assert.equal(page.field("code").required, true);
  assert.equal(page.field("submit").disabled, false);
  assert.deepEqual(page.focused, ["code"]);
  assert.equal(page.field("err").textContent, "");
});

test("the login page asks only for what Odoo still needs, and for the code when Odoo wants one", async () => {
  const open = async (cfg, answers = []) => {
    const posts = [];
    const page = load({
      entry: "login.js",
      path: "/login",
      fetchImpl: async (url, opts) => {
        if (url === "/api/config") return { ok: true, status: 200, json: async () => cfg };
        posts.push(JSON.parse(opts.body));
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return { ok: next.status === 200, status: next.status, json: async () => next.body };
      },
    });
    const field = (id) => page.document.getElementById(id);
    const focused = [];
    for (const id of ["url", "user", "pass", "code"]) field(id).focus = () => focused.push(id);
    await settle();
    return { page, field, focused, posts, submit: () => field("login").listeners.submit[0]({ preventDefault() {} }) };
  };

  const known = await open({ configured: true, local: true, user: "ana", url: "u", db: "d" }, [
    { status: 401, body: { error: "Falta el código", totp: true } },
    { status: 401, body: { error: "Usuario o contraseña incorrectos" } },
    { status: 500, body: {} },
    new Error("sin red"),
    { status: 200, body: { ok: true } },
  ]);
  assert.match(known.field("clock").textContent, /^\d\d:\d\d$/);
  assert.ok(known.page.calls.timers.some(([, ms]) => ms === 10000));
  assert.deepEqual([known.field("user").value, known.focused], ["ana", ["pass"]]);
  known.field("pass").type = "password";
  known.field("eye").listeners.click[0]();
  assert.deepEqual(
    [
      known.field("pass").type,
      known.field("eye").getAttribute("aria-label"),
      known.field("eye-slash").classList.contains("hidden"),
    ],
    ["text", "Ocultar contraseña", false],
  );
  known.field("eye").listeners.click[0]();
  assert.deepEqual(
    [known.field("pass").type, known.field("eye-slash").classList.contains("hidden")],
    ["password", true],
  );
  known.field("pass").value = "secreta";
  await known.submit();
  assert.deepEqual(
    [known.field("code").hidden, known.field("code").required, known.field("submit").disabled],
    [false, true, false],
  );
  assert.match(known.field("hint").textContent, /^Introduce el código/);
  known.field("code").value = "123456";
  for (const said of ["Usuario o contraseña incorrectos", "HTTP 500", "sin red"]) {
    await known.submit();
    assert.deepEqual([known.field("err").textContent, known.field("submit").disabled], [said, false]);
  }
  await known.submit();
  assert.deepEqual(known.page.calls.replace, ["/"]);
  assert.deepEqual(known.posts[1], { url: "", db: "", user: "ana", password: "secreta", code: "123456" });

  const fresh = await open({ configured: false, local: true });
  assert.deepEqual([fresh.field("url").hidden, fresh.field("db").required, fresh.focused], [false, true, ["url"]]);
  const nameless = await open({ configured: true, local: true });
  assert.deepEqual(nameless.focused, ["user"]);
  const phone = await open({ configured: true, local: false });
  assert.match(phone.field("hint").textContent, /^Aquí no se inicia sesión/);
  assert.deepEqual(
    ["user", "secret", "submit"].map((id) => phone.field(id).hidden),
    [true, true, true],
  );
  assert.deepEqual(phone.focused, []);
});
