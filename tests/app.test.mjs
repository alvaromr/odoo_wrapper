// Unit tests for templates/js/*: app.js and every module it imports (recursively) are flattened into one
// script, each stripped of its import statements and its `export` keywords, dependencies first, and run in
// a vm context with a minimal DOM stand-in, fetch and timers replaced, so the logic (formats, weeks, gaps,
// alarms, day rollover) runs without a browser. Run with `node --test tests/app.test.mjs`.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const TEMPLATES = new URL("../src/odoo_wrapper/templates/", import.meta.url);
const JS_DIR = new URL("js/", TEMPLATES);
const JS_FILES = fs.readdirSync(JS_DIR).filter(name => name.endsWith(".js"));
const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*"\.\/([^"]+)";?\s*$/gm;

function readModule(name) {
  return fs.readFileSync(new URL(name, JS_DIR), "utf8");
}

function moduleBody(source) {
  return source.replace(IMPORT_RE, "").replace(/^export\s+/gm, "");
}

function flatten(name, seen = new Set(), order = []) {
  if (seen.has(name)) return order;
  seen.add(name);
  const source = readModule(name);
  for (const m of source.matchAll(IMPORT_RE)) flatten(m[2], seen, order);
  order.push(moduleBody(source));
  return order;
}

const SOURCE = flatten("app.js").join("\n");

test("every imported name is exported by its module", () => {
  for (const file of JS_FILES) {
    const source = readModule(file);
    for (const m of source.matchAll(IMPORT_RE)) {
      const names = m[1].split(",").map(s => s.trim()).filter(Boolean);
      const target = m[2];
      assert.notEqual(target, file, `${file} imports itself`);
      const targetSource = readModule(target);
      for (const name of names) {
        const exported = new RegExp(
          `export (function|async function|const|let) ${name}\\b|export \\{[^}]*\\b${name}\\b`);
        assert.match(targetSource, exported, `${target} does not export ${name} (imported by ${file})`);
      }
    }
  }
});

function parseSelector(selector) {
  return selector.split(",").map(part => part.trim()).map(part => {
    if (part.includes(":") || part.includes(" ")) return null;
    const m = part.match(/^([a-zA-Z][a-zA-Z0-9]*)?((?:\.[a-zA-Z0-9_-]+)*)$/);
    if (!m) return null;
    return { tag: m[1] ? m[1].toUpperCase() : null, classes: m[2] ? m[2].slice(1).split(".") : [] };
  });
}

function matchesSelector(node, parts) {
  return Boolean(node) && typeof node === "object" && node.tagName && parts.some(p => p
    && (!p.tag || node.tagName === p.tag)
    && p.classes.every(c => node.classList && node.classList.contains(c)));
}

function queryAll(root, selector, out = []) {
  const parts = parseSelector(selector);
  (root.children || []).forEach(child => {
    if (typeof child === "string") return;
    if (matchesSelector(child, parts)) out.push(child);
    queryAll(child, selector, out);
  });
  return out;
}

function element(tag = "div") {
  const classes = new Set();
  const e = {
    tagName: tag.toUpperCase(), children: [], attrs: {}, listeners: {}, dataset: {}, style: {},
    textContent: "", innerHTML: "", title: "", hidden: false, disabled: false, open: false,
    value: "", type: "", min: 0, max: 0, step: 0, scrollLeft: 0, scrollWidth: 0, clientWidth: 0,
    get className() { return [...classes].join(" "); },
    set className(v) { classes.clear(); v.split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, force) => { const on = force === undefined ? !classes.has(c) : Boolean(force); on ? classes.add(c) : classes.delete(c); return on; },
      contains: c => classes.has(c),
    },
    appendChild(c) { e.children.push(c); return c; },
    append(...cs) { e.children.push(...cs); },
    prepend(...cs) { e.children.unshift(...cs); },
    replaceChildren(...cs) { e.children = cs; },
    remove() {},
    setAttribute(k, v) { e.attrs[k] = String(v); },
    getAttribute(k) { return k in e.attrs ? e.attrs[k] : null; },
    removeAttribute(k) { delete e.attrs[k]; },
    addEventListener(type, fn) { (e.listeners[type] ||= []).push(fn); },
    querySelector: sel => queryAll(e, sel)[0] || null,
    querySelectorAll: sel => queryAll(e, sel),
    closest: () => null,
    contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    focus() {},
    blur() {},
  };
  return e;
}

function makeDocument() {
  const byId = new Map();
  return {
    title: "Fichajes", hidden: false, visibilityState: "visible", listeners: {},
    getElementById: id => byId.get(id) || byId.set(id, element("div")).get(id),
    createElement: tag => element(tag),
    createElementNS: (_, tag) => element(tag),
    querySelector(sel) {
      for (const root of byId.values()) {
        const parts = parseSelector(sel);
        if (matchesSelector(root, parts)) return root;
        const found = queryAll(root, sel)[0];
        if (found) return found;
      }
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      const parts = parseSelector(sel);
      for (const root of byId.values()) {
        if (matchesSelector(root, parts)) out.push(root);
        out.push(...queryAll(root, sel));
      }
      return out;
    },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  };
}

function load({ data = null, fetchImpl = null } = {}) {
  const document = makeDocument();
  const calls = { fetch: [], replace: [], reload: 0, timers: [] };
  const sandbox = {
    document, window: {}, console,
    location: { hostname: "localhost", protocol: "http:", replace: url => calls.replace.push(url), reload: () => calls.reload++ },
    fetch: fetchImpl || (async (url, opts) => {
      calls.fetch.push([url, opts]);
      if (!data) throw new Error("sin datos");
      return { ok: true, status: 200, json: async () => data };
    }),
    setInterval: (fn, ms) => calls.timers.push([fn, ms]),
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SOURCE, ctx, { filename: "app.js" });
  const plain = value => value && typeof value === "object" && typeof value.then !== "function"
    ? JSON.parse(JSON.stringify(value))
    : value;
  const run = code => plain(vm.runInContext(code, ctx));
  return { run, document, calls };
}

const at = (day, h, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
const session = (start, end, rest = false) => ({
  in: start.toISOString(), out: end ? end.toISOString() : null,
  hours: end ? (end - start) / 3.6e6 : null, rest, reason: rest ? "Descanso" : "Normal",
});
const payload = (sessions, extra = {}) => ({
  employee: "Ana", breaks: true, phone: null, generated_at: new Date().toISOString(), weeks: 12,
  sessions, absences: [], schedule: null,
  state: { lunch: null, lunch_minutes: 30, break_minutes: 15, muted: false, lunch_done: false, punched_at: null },
  ...extra,
});

const TUESDAY = new Date(2026, 8, 15, 10, 0);

const SCHEDULE = "store.expected = [8.5, 8.5, 8.5, 8.5, 6, 0, 0]; store.lunchFrom = [13.5, 13.5, 13.5, 13.5, null, null, null]; store.weekTarget = 40;";

function withData(sessions, extra) {
  const page = load();
  page.run(`store.data = ${JSON.stringify(payload(sessions, extra))}; store.state = store.data.state; ${SCHEDULE}`);
  page.run(`setClock(new Date(${TUESDAY.getTime()})); indexSessions();`);
  return page;
}

test("formats hours, deltas and clocks", () => {
  const { run } = load();
  assert.equal(run("fmtHM(1.5)"), "1h 30m");
  assert.equal(run("fmtHM(-0.25)"), "−0h 15m");
  assert.equal(run("fmtDelta(0.5)"), "+0h 30m");
  assert.equal(run("fmtDelta(-0.5)"), "−0h 30m");
  assert.equal(run("fmtShort(0.5)"), "30m");
  assert.equal(run("fmtShort(1.25)"), "1h 15m");
  assert.equal(run("fmtShort(-1)"), "0m");
  assert.equal(run("fmtClock(17.5)"), "17:30");
  assert.equal(run("fmtHours(8.5)"), "8,5 h");
  assert.equal(run("fmtHours(40)"), "40 h");
  assert.equal(run("isoDay(new Date(2026, 0, 5))"), "2026-01-05");
  run(SCHEDULE);
  assert.equal(run("targetLabel({ target: 40 })"), "40 h");
  assert.equal(run("targetLabel({ target: 31.5 })"), "31h 30m");
});

test("the schedule sentence groups days by hours", () => {
  const { run } = load();
  assert.equal(run("scheduleSentence()"), "");
  run(SCHEDULE);
  assert.equal(run("scheduleSentence()"), "8,5 h de lunes a jueves, 6 h los viernes");
  run("store.expected = [8, 8, 0, 0, 0, 0, 0]");
  assert.equal(run("scheduleSentence()"), "8 h los lunes y martes");
});

test("lunch opens at the calendar's lunch time and only on days that have one", () => {
  const { run } = withData([]);
  assert.equal(run("lunchOpen(new Date(2026, 8, 15, 13, 29))"), false);
  assert.equal(run("lunchOpen(new Date(2026, 8, 15, 13, 30))"), true);
  assert.equal(run("lunchOpen(new Date(2026, 8, 18, 15, 0))"), false);
  assert.equal(run("lunchHours({ date: new Date(2026, 8, 14) })"), 0.5);
  assert.equal(run("lunchHours({ date: new Date(2026, 8, 18) })"), 0);
  assert.equal(run("lunchHours({ date: new Date(2026, 8, 14), vacation: true })"), 0);
});

test("without a schedule nothing is expected and the page says so", async () => {
  const today = new Date();
  const page = load({ data: payload([session(at(today, 9), null)]) });
  await page.run("loadAndRender()");
  assert.equal(page.run("store.weekTarget"), 0);
  assert.equal(page.run("buildWeek(0).target"), 0);
  assert.equal(page.run("lunchOpen(new Date())"), false);
  assert.match(page.document.getElementById("weeksHint").textContent, /^Odoo no devuelve horario/);
});

test("sessions are indexed per day with their break share", () => {
  const monday = new Date(2026, 8, 14);
  const { run } = withData([
    session(at(monday, 9), at(monday, 11)),
    session(at(monday, 11), at(monday, 11, 15), true),
    session(at(TUESDAY, 9), null),
  ]);
  const week = run("buildWeek(0)");
  assert.equal(week.days[0].hours, 2.25);
  assert.equal(week.days[0].rest, 0.25);
  assert.equal(week.days[0].sessions.length, 2);
  assert.equal(week.days[1].hours, 1);
  assert.equal(week.total, 3.25);
  assert.equal(week.target, 40);
  assert.equal(week.delta, 3.25 - 40);
  assert.equal(week.current, true);
  assert.equal(week.complete, false);
  assert.equal(run("buildWeek(1)").complete, true);
  assert.equal(run("buildWeeks(3).length"), 3);
});

test("absences and hour leaves lower the expected hours", () => {
  const { run } = withData([]);
  run(`store.absMap = new Map([["2026-09-14", "Festivo"]]);
       store.leaveMap = new Map([["2026-09-15", [{ hours: 2.5, type: "Médico" }]]]);`);
  const week = run("buildWeek(0)");
  assert.equal(week.days[0].expected, 0);
  assert.equal(week.days[0].auto, "Festivo");
  assert.equal(week.days[1].expected, 6);
  assert.equal(week.days[1].leaves[0].type, "Médico");
  assert.equal(week.target, 40 - 8.5 - 2.5);
  run("store.absMap = new Map([0, 1, 2, 3, 4].map(i => [`2026-09-1${4 + i}`, 'Vacaciones']))");
  assert.equal(run("buildWeek(0)").allVacation, true);
});

test("week labels span one or two months", () => {
  const { run } = load();
  assert.equal(run("weekRangeLabel({ monday: new Date(2026, 8, 14), sunday: new Date(2026, 8, 20) })"), "14–20 sep");
  assert.equal(run("weekRangeLabel({ monday: new Date(2026, 8, 28), sunday: new Date(2026, 9, 4) })"), "28 sep – 4 oct");
});

test("break spans sit where the break happened and gaps count only unlogged time", () => {
  const { run } = load();
  assert.deepEqual(
    run("restSpans([{ hours: 2, rest: false }, { hours: 0.25, rest: true }, { hours: 1, rest: false }])"),
    [{ from: 2, to: 2.25 }],
  );
  const monday = new Date(2026, 8, 14);
  const gap = run(`unloggedGap([
    { in: new Date(${at(monday, 9).getTime()}), out: new Date(${at(monday, 12).getTime()}) },
    { in: new Date(${at(monday, 12, 30).getTime()}), out: null },
  ])`);
  assert.equal(gap, 0.5);
});

test("the last punch is the newest event and says whether it is open", () => {
  const monday = new Date(2026, 8, 14);
  const { run } = withData([
    session(at(monday, 9), at(monday, 12)),
    session(at(monday, 13), null, true),
  ]);
  const last = run("lastPunch()");
  assert.equal(last.open, true);
  assert.equal(last.rest, true);
  assert.equal(new Date(last.at).getTime(), at(monday, 13).getTime());
  assert.match(run("punchText(lastPunch())"), /^En descanso desde a las 13:00 · llevas /);
});

test("the status line explains why it is or is not ringing", () => {
  const { run } = withData([]);
  const day = { expected: 8, hours: 1 };
  assert.equal(run(`notifyStatus(null, ${JSON.stringify(day)}, 7)`), "Sin fichaje abierto");
  assert.equal(run("notifyStatus(null, { expected: 0 }, 0)"), "Hoy sin jornada prevista");
  run("store.state = { ...store.state, lunch: new Date(Date.now() - 10 * 60000).toISOString() }");
  assert.match(run(`notifyStatus(null, ${JSON.stringify(day)}, 7)`), /^Comida hasta las \d\d:\d\d · toca la página para oírlo$/);
  run("store.state = { ...store.state, lunch: new Date(Date.now() - 60 * 60000).toISOString() }");
  assert.match(run(`notifyStatus(null, ${JSON.stringify(day)}, 7)`), /^Comida vencida/);
  const open = { in: new Date(Date.now() - 5 * 60000).toISOString(), rest: true };
  assert.match(run(`notifyStatus(${JSON.stringify(open)}, ${JSON.stringify(day)}, 7)`), /^Descanso hasta las/);
  assert.match(run(`notifyStatus({ rest: false }, ${JSON.stringify(day)}, 7)`), /^Sonará al cumplir la jornada/);
  assert.match(run(`notifyStatus({ rest: false }, ${JSON.stringify(day)}, 0)`), /^Avisando cada 2 min/);
  run("store.state = { ...store.state, muted: true }");
  assert.equal(run(`notifyStatus({ rest: false }, ${JSON.stringify(day)}, 0)`), "Silenciado hasta mañana");
});

function alarmsPage(sessions, state = {}) {
  const page = load();
  const data = payload(sessions, { state: { ...payload([]).state, ...state } });
  page.run(`store.data = ${JSON.stringify(data)}; store.state = store.data.state; store.expected = [8, 8, 8, 8, 8, 8, 8]; store.lunchFrom = Array(7).fill(13.5);`);
  page.run("setClock(new Date()); indexSessions();");
  return page;
}

test("the end-of-day alarm rings once the expected hours are met with a session open", () => {
  const today = new Date();
  const { run, document } = alarmsPage([session(at(today, 0), null)]);
  assert.equal(run("NotifiedAt"), 0);
  run("checkAlarms()");
  assert.ok(run("NotifiedAt") > 0);
  assert.ok(run("FlashTimer"));
  run("checkAlarms()");
  const first = run("NotifiedAt");
  run("checkAlarms()");
  assert.equal(run("NotifiedAt"), first);
  run("store.state = { ...store.state, muted: true }; checkAlarms()");
  assert.equal(run("FlashTimer"), null);
  assert.equal(document.title, "Fichajes");
});

test("a short open session does not ring", () => {
  const { run } = alarmsPage([session(new Date(Date.now() - 60000), null)]);
  run("checkAlarms()");
  assert.equal(run("NotifiedAt"), 0);
  assert.equal(run("FlashTimer"), null);
});

test("lunch rings only after the lunch button, within the grace period", () => {
  const { run } = alarmsPage([]);
  run("checkAlarms()");
  assert.equal(run("LastRing.lunch"), 0);
  run("store.state = { ...store.state, lunch: new Date(Date.now() - 40 * 60000).toISOString() }; checkAlarms()");
  assert.ok(run("LastRing.lunch") > 0);
  run("LastRing.lunch = 0; store.state = { ...store.state, lunch: new Date(Date.now() - 4 * 3600000).toISOString() }; checkAlarms()");
  assert.equal(run("LastRing.lunch"), 0);
  assert.equal(run("FlashTimer"), null);
});

test("a break rings when it runs over its minutes", () => {
  const { run } = alarmsPage([session(new Date(Date.now() - 20 * 60000), null, true)]);
  run("checkAlarms()");
  assert.ok(run("LastRing.rest") > 0);
  const { run: quiet } = alarmsPage([session(new Date(Date.now() - 20 * 60000), null, true)], { break_minutes: 0 });
  quiet("checkAlarms()");
  assert.equal(quiet("LastRing.rest"), 0);
});

test("the page follows the day change before asking Odoo", async () => {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 18, 0);
  const page = load({ data: payload([session(at(yesterday, 9), at(yesterday, 17))]) });
  await page.run("loadAndRender()");
  page.run(`setClock(new Date(${yesterday.getTime()})); NotifiedAt = 5; indexSessions();`);
  const before = page.calls.fetch.length;
  assert.equal(page.run("newDay()"), true);
  assert.equal(page.run("isoDay(store.today)"), page.run("isoDay(new Date())"));
  assert.equal(page.run("NotifiedAt"), 0);
  assert.equal(page.calls.fetch.length, before + 1);
  assert.equal(page.run("newDay()"), false);
});

test("loading renders the page from the server payload", async () => {
  const today = new Date();
  const data = payload([session(at(today, 9), null)], {
    schedule: { hours: [7, 7, 7, 7, 7, 0, 0], lunch_from: [13, 13, 13, 13, null, null, null] },
    absences: [{ date: "2026-09-14", type: "Festivo" }],
    phone: { url: "https://10.0.0.2:8443/", name_url: "https://mac.local:8443/" },
  });
  const page = load({ data });
  await page.run("loadAndRender()");
  const { document, run } = page;
  assert.match(document.getElementById("subtitle").textContent, /^Ana · Odoo · actualizado el /);
  assert.equal(document.getElementById("app").classList.contains("hidden"), false);
  assert.equal(run("store.weekTarget"), 35);
  assert.equal(run("lunchFrom(new Date(2026, 8, 14))"), 13);
  assert.equal(run("lunchFrom(new Date(2026, 8, 18))"), null);
  assert.match(document.getElementById("weeksHint").textContent, /jornada prevista en Odoo: 7 h de lunes a viernes\./);
  assert.deepEqual(run("[...store.absMap]"), [["2026-09-14", "Festivo"]]);
  assert.ok(document.getElementById("hero").children.length > 0);
  const phone = document.getElementById("phone");
  assert.equal(phone.classList.contains("hidden"), false);
  assert.equal(phone.querySelectorAll(".qr").length, 0);
  const buttons = () => phone.querySelector(".seg").children;
  assert.deepEqual(buttons().map(b => [b.textContent, b.getAttribute("aria-pressed")]), [["Por IP", "true"], ["Por nombre", "false"]]);
  assert.equal(phone.querySelector(".url").textContent, "https://10.0.0.2:8443/");
  assert.equal(phone.querySelector(".btn").textContent, "Emparejar móvil");
  buttons()[1].listeners.click[0]();
  assert.deepEqual(buttons().map(b => b.getAttribute("aria-pressed")), ["false", "true"]);
  assert.equal(phone.querySelector(".url").textContent, "https://mac.local:8443/");
});

test("pairing shows a one-shot QR that expires", async () => {
  const data = payload([], { phone: { url: "https://10.0.0.2:8443/", name_url: "https://mac.local:8443/" } });
  const pairs = [];
  let pairReply = { ok: true, status: 200, json: async () => ({ url: "https://10.0.0.2:8443/pair?t=tok", qr: "<svg/>", expires_in: 120 }) };
  const page = load({ fetchImpl: async (url, opts) => {
    if (url !== "/api/pair") return { ok: true, status: 200, json: async () => data };
    pairs.push(JSON.parse(opts.body));
    return pairReply;
  } });
  await page.run("loadAndRender()");
  const { document, run, calls } = page;
  const phone = document.getElementById("phone");
  const pairButton = () => phone.querySelector(".btn");
  await pairButton().listeners.click[0]();
  assert.deepEqual(pairs, [{ name: false }]);
  assert.equal(phone.querySelectorAll(".qr").length, 1);
  assert.equal(phone.querySelector(".url").textContent, "https://10.0.0.2:8443/pair?t=tok");
  assert.match(phone.querySelector(".note").textContent, /caduca en 120 s/);
  assert.equal(pairButton().textContent, "Cancelar");
  assert.equal(calls.timers.at(-1)[1], 1000);
  run("pairing.until = Date.now() - 1");
  calls.timers.at(-1)[0]();
  assert.equal(run("pairing"), null);
  assert.equal(phone.querySelectorAll(".qr").length, 0);
  assert.equal(pairButton().textContent, "Emparejar móvil");
  await pairButton().listeners.click[0]();
  assert.equal(pairButton().textContent, "Cancelar");
  await pairButton().listeners.click[0]();
  assert.equal(pairButton().textContent, "Emparejar móvil");
  assert.equal(phone.querySelectorAll(".qr").length, 0);
  assert.deepEqual(pairs.at(-1), { revoke: true });
  phone.querySelector(".seg").children[1].listeners.click[0]();
  pairReply = { ok: false, status: 409, json: async () => ({ error: "sin --host" }) };
  await pairButton().listeners.click[0]();
  assert.deepEqual(pairs.at(-1), { name: true });
  assert.match(phone.querySelector(".note").textContent, /No se pudo emparejar: sin --host/);
});

test("without the Descanso reason the page offers no break", async () => {
  const today = new Date();
  const schedule = { hours: [7, 7, 7, 7, 7, 7, 7], lunch_from: [13, 13, 13, 13, 13, 13, 13] };
  const texts = async (breaks) => {
    const page = load({ data: payload([session(at(today, 9), null)], { schedule, breaks }) });
    await page.run("loadAndRender()");
    const hero = page.document.getElementById("hero");
    return [...hero.querySelectorAll(".btn").map(b => b.textContent), ...hero.querySelectorAll(".duration").map(f => f.children[0])];
  };
  const withBreaks = await texts(true), without = await texts(false);
  assert.deepEqual(withBreaks.filter(t => t.includes("escanso")), ["Salir a descanso", "Descanso "]);
  assert.deepEqual(without.filter(t => t.includes("escanso")), []);
  assert.ok(without.includes("Fichar salida") && without.includes("Comida "));
});

test("a failed first load keeps retrying once a minute", async () => {
  const page = load();
  await new Promise(resolve => setTimeout(resolve, 0));
  const loads = () => page.calls.fetch.filter(([url]) => url.startsWith("/api/data")).length;
  assert.equal(loads(), 1);
  assert.match(page.document.getElementById("loadmsg").textContent, /^Error cargando datos de Odoo: sin datos/);
  page.run("tick()");
  assert.equal(loads(), 1);
  page.run("store.triedAt = Date.now() - 61000; tick()");
  assert.equal(loads(), 2);
});

test("a failed reload is retried once a minute, not every tick", () => {
  const page = withData([session(at(new Date(), 9), null)]);
  page.run("setClock(new Date()); indexSessions();");
  const loads = () => page.calls.fetch.filter(([url]) => url.startsWith("/api/data")).length;
  page.run("tick()");
  assert.equal(loads(), 1);
  page.run("tick()");
  assert.equal(loads(), 1);
  page.run("store.triedAt = Date.now() - 61000; tick()");
  assert.equal(loads(), 2);
});

test("the week card switches between the timeline and the hours per day", async () => {
  const today = new Date();
  const page = load({ data: payload([session(at(today, 9), at(today, 12))], { schedule: { hours: [8, 8, 8, 8, 8, 0, 0], lunch_from: [13, 13, 13, 13, 13, null, null] } }) });
  await page.run("loadAndRender()");
  const card = page.document.getElementById("weekCal");
  const buttons = card.querySelectorAll(".seg")[0].children;
  assert.deepEqual(buttons.map(b => [b.textContent, b.getAttribute("aria-pressed")]), [["Horario", "true"], ["Objetivo", "false"]]);
  assert.ok(card.querySelectorAll(".tl-row").length >= 5);
  assert.equal(card.querySelectorAll(".exp-tick").length, 0);
  buttons[1].listeners.click[0]();
  assert.ok(card.querySelectorAll(".exp-tick").length >= 5);
  assert.equal(card.querySelectorAll(".tl-row").length, 0);
  assert.equal(card.querySelectorAll(".seg")[0].children[1].getAttribute("aria-pressed"), "true");
});

test("the hero is three blocks", async () => {
  const today = new Date();
  const page = load({ data: payload([session(at(today, 9), null)], {
    schedule: { hours: [8, 8, 8, 8, 8, 0, 0], lunch_from: [13, 13, 13, 13, 13, null, null] },
  }) });
  await page.run("loadAndRender()");
  const hero = page.document.getElementById("hero");
  assert.deepEqual(hero.children.map(c => c.className), ["main", "meter-box", "actions"]);
  assert.equal(hero.querySelectorAll(".meter-caption").length, 2);
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
  const button = hero.querySelectorAll(".btn").find(b => b.textContent === "Fichar salida");
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
  const button = hero.querySelectorAll(".btn").find(b => b.textContent === "Fichar salida");
  await button.listeners.click[0]();
  await button.listeners.click[0]();
  const errBox = hero.querySelector(".err");
  assert.equal(errBox.textContent, "Error: sin conexión");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Fichar salida");
});

test("a 401 sends the page to the login", async () => {
  const page = load({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: "caducada" }) }) });
  await new Promise(resolve => setImmediate(resolve));
  page.calls.replace.length = 0;
  await assert.rejects(page.run("api('/api/data')"), /caducada/);
  assert.deepEqual(page.calls.replace, ["/login"]);
});
