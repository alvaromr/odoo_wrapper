// Unit tests for templates/js/*: each page's entry script (app.js, team.js) and every module it imports
// (recursively) run as classic scripts in one vm context, dependencies first, with a minimal DOM stand-in,
// fetch and timers replaced, so the logic (formats, weeks, gaps, alarms, day rollover) runs without a browser.
// Each module keeps its own file name and every byte offset of the file on disk: its import statements and
// `export` keywords are blanked out, not removed, so node's coverage maps back to the real lines. Scripts in
// one context share their top-level names, as the modules' imports did. Run with `node --test tests/app.test.mjs`,
// and with coverage as AGENTS.md says.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const TEMPLATES = new URL("../src/odoo_wrapper/templates/", import.meta.url);
const JS_DIR = new URL("js/", TEMPLATES);
const JS_FILES = fs.readdirSync(JS_DIR).filter(name => name.endsWith(".js"));
const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*"\.\/([^"]+)";?\s*$/gm;

function readModule(name) {
  return fs.readFileSync(new URL(name, JS_DIR), "utf8");
}

const blank = text => text.replace(/[^\n]/g, " ");

function moduleBody(source) {
  return source.replace(IMPORT_RE, blank).replace(/^export\s/gm, blank);
}

function flatten(name, seen = new Set(), order = []) {
  if (seen.has(name)) return order;
  seen.add(name);
  const source = readModule(name);
  for (const m of source.matchAll(IMPORT_RE)) flatten(m[2], seen, order);
  order.push({ name, body: moduleBody(source) });
  return order;
}

const SOURCES = Object.fromEntries(["app.js", "team.js"].map(name => [name, flatten(name)]));

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
    insertBefore(c, ref) { e.children.splice(e.children.includes(ref) ? e.children.indexOf(ref) : e.children.length, 0, c); return c; },
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
    scrollIntoView() {},
    showModal() { e.open = true; },
    close() { e.open = false; },
  };
  return e;
}

function makeDocument() {
  const byId = new Map();
  return {
    title: "Fichajes", hidden: false, visibilityState: "visible", listeners: {},
    getElementById: id => byId.get(id) || byId.set(id, element("div")).get(id),
    createElement: tag => {
      const e = element(tag);
      Object.defineProperty(e, "id", { get: () => e._id, set: v => { e._id = v; byId.set(v, e); } });
      return e;
    },
    body: element("body"),
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

function load({ data = null, fetchImpl = null, entry = "app.js", path = "/", storage = null, globals = {} } = {}) {
  const document = makeDocument();
  const calls = { fetch: [], replace: [], reload: 0, timers: [] };
  const sandbox = {
    document, window: {}, console, URLSearchParams, innerWidth: 1280, innerHeight: 800,
    addEventListener: (type, fn) => ((calls.window ||= {})[type] ||= []).push(fn),
    history: { replaceState: (a, b, url) => { calls.hash = url; } },
    ...(storage ? { sessionStorage: storage } : {}),
    location: { assign: url => (calls.assigned ||= []).push(url), hostname: "localhost", protocol: "http:", pathname: path.split(/[?#]/)[0],
      search: path.includes("?") ? path.slice(path.indexOf("?")).split("#")[0] : "",
      hash: path.includes("#") ? path.slice(path.indexOf("#")) : "", replace: url => calls.replace.push(url), reload: () => calls.reload++ },
    fetch: fetchImpl || (async (url, opts) => {
      calls.fetch.push([url, opts]);
      if (url.includes("fixes")) return { ok: true, status: 200, json: async () => teamFixes() };
      if (!data) throw new Error("sin datos");
      return { ok: true, status: 200, json: async () => data };
    }),
    setInterval: (fn, ms) => calls.timers.push([fn, ms]),
    clearInterval: () => {},
    setTimeout: (fn, ms) => (calls.timeouts ||= []).push([fn, ms]),
    clearTimeout: () => {},
    ...globals,
  };
  const ctx = vm.createContext(sandbox);
  for (const { name, body } of SOURCES[entry]) vm.runInContext(body, ctx, { filename: fileURLToPath(new URL(name, JS_DIR)) });
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
  sessions, absences: [], schedule: null, long_hours: 12, work_hours: [7.5, 20],
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
  assert.equal(run("fmtHM(-0.25)"), "−15m");
  assert.equal(run("fmtHM(0)"), "0h");
  assert.equal(run("fmtHM(2.05)"), "2h 3m");
  assert.equal(run("fmtHM(18)"), "18h");
  assert.equal(run("fmtDelta(0.5)"), "+30m");
  assert.equal(run("fmtDelta(-0.5)"), "−30m");
  assert.equal(run("fmtShort(0.5)"), "30m");
  assert.equal(run("fmtShort(1.25)"), "1h 15m");
  assert.equal(run("fmtShort(-1)"), "0m");
  assert.equal(run("fmtClock(17.5)"), "17:30");
  assert.equal(run("isoDay(new Date(2026, 0, 5))"), "2026-01-05");
  run(SCHEDULE);
  assert.equal(run("targetLabel({ target: 40 })"), "40h");
  assert.equal(run("targetLabel({ target: 31.5 })"), "31h 30m");
});

test("the schedule sentence groups days by hours", () => {
  const { run } = load();
  assert.equal(run("scheduleSentence()"), "");
  run(SCHEDULE);
  assert.equal(run("scheduleSentence()"), "8h 30m de lunes a jueves, 6h los viernes");
  run("store.expected = [8, 8, 0, 0, 0, 0, 0]");
  assert.equal(run("scheduleSentence()"), "8h los lunes y martes");
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

test("a day whose contract asked for other hours expects those", async () => {
  const today = new Date();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (today.getDay() + 6) % 7 - 7);
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const tuesday = new Date(monday); tuesday.setDate(monday.getDate() + 1);
  const page = load({ data: payload([], {
    schedule: { hours: [8, 8, 8, 8, 8, 0, 0], lunch_from: [null, null, null, null, null, null, null] },
    contract_hours: { [iso(monday)]: 0, [iso(tuesday)]: 5 },
  }) });
  await page.run("loadAndRender()");
  assert.deepEqual(page.run("buildWeek(1).days.map(d => d.expected)"), [0, 5, 8, 8, 8, 0, 0]);
  assert.equal(page.run("buildWeek(1).target"), 29);
  assert.equal(page.run("buildWeek(0).target"), 40);
});

test("the range selector counts months back from today, as weeks", () => {
  const { run, document } = withData([]);
  assert.deepEqual([1, 6, 12].map(m => run(`weeksSince(${m})`)), [6, 28, 53]);
  const seg = document.getElementById("rangeSeg");
  const button = document.createElement("button");
  button.dataset.months = "1";
  seg.appendChild(button);
  seg.listeners.click[0]({ target: { closest: () => button }, currentTarget: seg });
  assert.equal(button.getAttribute("aria-pressed"), "true");
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
  const { run } = withData([
    session(at(TUESDAY, 9), at(TUESDAY, 12)),
    session(at(TUESDAY, 13), null, true),
  ]);
  const last = run("lastPunch()");
  assert.equal(last.open, true);
  assert.equal(last.rest, true);
  assert.equal(new Date(last.at).getTime(), at(TUESDAY, 13).getTime());
  assert.match(run("punchText(lastPunch())"), /^En descanso desde las 13:00 · llevas /);
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
  assert.match(document.getElementById("weeksHint").textContent, /jornada prevista en Odoo: 7h de lunes a viernes\./);
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
  pairReply = { ok: false, status: 500, json: async () => ({ error: "caído" }) };
  await pairButton().listeners.click[0]();
  await settle();
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

test("a session over the long limit is red, and one that ends the next day runs to midnight", async () => {
  const today = new Date();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (today.getDay() + 6) % 7 - 7);
  const tuesday = new Date(monday); tuesday.setDate(monday.getDate() + 1);
  const wednesday = new Date(monday); wednesday.setDate(monday.getDate() + 2);
  const page = load({ data: payload([session(at(monday, 9), at(monday, 14)), session(at(tuesday, 15), at(wednesday, 9))], {
    long_hours: 12, schedule: { hours: [8, 8, 8, 8, 8, 0, 0], lunch_from: [null, null, null, null, null, null, null] },
  }) });
  await page.run("loadAndRender()");
  const card = page.document.getElementById("weekCal");
  const rows = () => card.querySelectorAll(".tl-row");
  page.run("renderTimeline(document.getElementById('weekCal'), buildWeek(1))");
  const tl = rows().slice(-7);
  const dayRow = date => tl.find(r => r.querySelectorAll(".dnum")[0]?.textContent === String(date.getDate()));
  const tuesdayRow = dayRow(tuesday);
  const block = tuesdayRow.querySelectorAll(".sess")[0];
  assert.equal(block.classList.contains("long"), true);
  assert.equal(block.textContent, "15:00 – 09:00 (+1)");
  assert.match(block.style.width, /100%/);
  assert.equal(tuesdayRow.querySelectorAll(".dvalue")[0].classList.contains("long"), true);
  assert.deepEqual(hover(page, block).slice(-3), ["Termina al día siguiente",
    "Jornada muy larga: 18h en el día, más de 12h, casi siempre una salida sin fichar",
    "Fuera de horario: fuera de 7:30 a 20:00"]);
  assert.equal(dayRow(monday).querySelectorAll(".sess")[0].classList.contains("long"), false);
  assert.equal(page.run("buildWeek(1).suspect"), true);
  page.run("calView = 'objetivo'; calOffset = 1; renderCalendar()");
  const bars = card.querySelectorAll(".dayrow").map(r => r.querySelectorAll(".bar")[0]?.style.width);
  assert.deepEqual(bars.slice(0, 2), ["50%", "100%"]);
  assert.equal(page.run("buildWeek(0).suspect"), false);
  page.run("renderTable(buildWeeks(2))");
  const table = page.document.getElementById("tableView");
  assert.ok(table.querySelectorAll("td.warn").some(td => td.textContent === "fichaje por revisar"));
});

test("an attendance left open since an earlier day is not today's work", async () => {
  const today = new Date();
  const earlier = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 3, 8, 46);
  const page = load({ data: payload([{ in: earlier.toISOString(), out: null, hours: null, rest: false, reason: "Normal" }], {
    long_hours: 12, schedule: { hours: [8, 8, 8, 8, 8, 8, 8], lunch_from: [null, null, null, null, null, null, null] } }) });
  await page.run("loadAndRender()");
  const hero = page.document.getElementById("hero");
  const texts = node => [node.textContent, ...(node.children || []).filter(c => typeof c !== "string").flatMap(texts)];
  assert.ok(!texts(hero).some(t => /^Salida estimada/.test(t)));
  assert.ok(texts(hero).some(t => / · hay una entrada anterior sin cerrar$/.test(t)));
  const line = hero.querySelectorAll(".lastpunch")[0];
  assert.equal(line.classList.contains("stale"), true);
  assert.match(line.children[1].textContent, /^Entrada del \d+ \w+ a las 08:46 sin cerrar · hace /);
  const badge = page.document.getElementById("weekCal").querySelectorAll(".badge")[0];
  assert.match(badge.textContent, /fichaje por revisar$/);
});

test("the banner lists this person's punch errors and opens their week", async () => {
  const today = new Date();
  const back = n => { const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - n); return d; };
  const page = load({ data: payload([
    session(at(back(200), 9), at(back(199), 9)),
    session(at(back(10), 16), at(back(9), 8, 30)),
    session(at(back(3), 9), null),
    session(at(back(1), 9), at(back(1), 17)),
    session(at(back(20), 6), at(back(20), 10)),
  ], { long_hours: 12, weeks: 40,
    contract_hours: { [isoDate(back(5))]: 7.5 },
    schedule: { hours: [0, 0, 0, 0, 0, 0, 0], lunch_from: [null, null, null, null, null, null, null] } }) });
  await page.run("loadAndRender()");
  const box = page.document.getElementById("errorsBanner");
  assert.equal(box.classList.contains("hidden"), false);
  const details = box.children[0];
  assert.equal(details.tagName, "DETAILS");
  assert.equal(details.open, false);
  assert.equal(details.children[0].children[0].textContent, "⚠ 5 fichajes por corregir");
  details.open = true;
  details.listeners.toggle[0]();
  page.run("renderErrors()");
  assert.equal(box.children[0].open, true);
  const items = box.children[0].children[2].children.map(li => li.children[0]);
  assert.deepEqual(items.map(i => i.children[2].textContent),
    ["Sin cerrar", "Sin fichar", "Jornada de 16h 30m", "Fuera de horario", "Jornada de 24h"]);
  assert.match(bannerLine(items[3]), / · Fuera de horario 06:00 – 10:00$/);
  assert.match(bannerLine(items[1]), / · Sin fichar con jornada prevista de 7h 30m$/);
  assert.match(bannerLine(items[0]), / · Sin cerrar entrada a las 09:00, sin salida$/);
  items[1].listeners.click[0]();
  const values = page.document.getElementById("weekCal").querySelectorAll(".dvalue").filter(v => v.textContent === "sin fichar");
  assert.equal(values.length, 1);
  assert.equal(values[0].classList.contains("long"), true);
  items[2].listeners.click[0]();
  assert.equal(page.run("weekOffsetOf(new Date())"), 0);
  assert.equal(page.run("calOffset"), page.run(`weekOffsetOf(new Date(${back(10).getTime()}))`));
  assert.ok(page.run("calOffset") >= 1);
  page.run("renderKpis(buildWeeks(40))");
  const [averageTile, balanceTile, usualTile] = page.document.getElementById("kpis").children;
  assert.deepEqual(usualTile.children.map(c => c.textContent), ["Horario habitual", "09:00 – 17:00", "entrada y salida medias · 1 día"]);
  for (const tile of [averageTile, balanceTile]) {
    assert.equal(tile.children[1].style.color, "var(--status-warning)");
    assert.match(tile.children.at(-1).textContent, /^⚠ No fiable: \d+ semanas? con fichajes incorrectos \(jornadas muy largas, entradas sin cerrar, fuera de horario o días sin fichar\)$/);
  }
  const stale = page.run(`(() => { const w = buildWeek(weekOffsetOf(new Date(${back(3).getTime()})));
    const d = w.days.find(d => d.sessions.some(unclosed)); return [d.hours, w.openDays, w.error, dayError(d), dayValue(d).textContent]; })()`);
  assert.deepEqual(stale, [0, 1, true, true, "sin cerrar"]);
  page.run("store.weekTarget = 40; renderOverview(buildWeeks(40))");
  const has = (node, c) => (node.getAttribute("class") || "").split(" ").includes(c);
  const cols = page.document.getElementById("overviewChart").children[0].children.filter(g => g.tagName === "G" && has(g, "col"));
  const errors = cols.filter(g => has(g, "error"));
  assert.ok(errors.length >= 2);
  assert.ok(errors.every(g => g.children.filter(c => has(c, "err-mark")).length === 1));
  assert.ok(cols.filter(g => !has(g, "error")).every(g => g.children.every(c => !has(c, "err-mark"))));
  assert.ok(errors.some(g => hover(page, g).some(t => /sin fichar$/.test(t))));
  assert.ok(errors.some(g => hover(page, g).includes("Incluye una jornada muy larga: suma no fiable")));
  assert.ok(errors.some(g => hover(page, g).includes("1 día con fichajes fuera de horario")));
  assert.ok(errors.some(g => hover(page, g).includes("1 día con una entrada sin cerrar")));
  page.run("calOffset = 0");
  const oldest = cols[0];
  oldest.listeners.click[0]();
  assert.equal(page.run("calOffset"), 39);
  cols.at(-2).listeners.keydown[0]({ key: "Enter" });
  assert.equal(page.run("calOffset"), 1);
  cols.at(-2).listeners.keydown[0]({ key: "Tab" });
  assert.equal(page.run("calOffset"), 1);
  page.run("const ws = buildWeeks(40); Object.defineProperty(ws[0], 'total', { value: 230 }); ws[0].suspect = true; renderOverview(ws)");
  const chart = page.document.getElementById("overviewChart").children[0];
  const ticks = chart.children.filter(c => has(c, "ticklabel")).map(t => Number(t.textContent));
  assert.equal(Math.max(...ticks), 40);
  const tallest = chart.children.filter(g => g.tagName === "G" && has(g, "col"))[0].children.find(c => has(c, "bar"));
  assert.match(tallest.getAttribute("d"), / L [\d.]+ 14 Q /);
  page.run("store.data.sessions = []; store.contractHours = new Map(); indexSessions(); renderErrors()");
  assert.equal(box.classList.contains("hidden"), true);
});

test("a week holding a too long session never claims its target reached", async () => {
  const today = new Date();
  const page = load({ data: payload([session(at(today, 0), at(today, 12, 30))], {
    long_hours: 12, schedule: { hours: [1, 1, 1, 1, 1, 1, 1], lunch_from: [null, null, null, null, null, null, null] },
  }) });
  await page.run("loadAndRender()");
  const texts = node => [node.textContent, ...(node.children || []).filter(c => typeof c !== "string").flatMap(texts)];
  assert.ok(texts(page.document.getElementById("hero")).some(t => /hay un fichaje por revisar$/.test(t)));
  assert.ok(!texts(page.document.getElementById("hero")).some(t => /objetivo alcanzado$/.test(t)));
  const badge = page.document.getElementById("weekCal").querySelectorAll(".badge")[0];
  assert.equal(badge.textContent, "⚠ en curso · fichaje por revisar");
  assert.equal(badge.classList.contains("warn"), true);
  const cal = page.document.getElementById("weekCal");
  assert.equal(cal.querySelectorAll(".total")[0].classList.contains("long"), true);
  assert.equal(cal.querySelectorAll(".total-warn")[0].textContent, "⚠ incluye una jornada muy larga");
  cal.querySelectorAll(".seg")[0].children[1].listeners.click[0]();
  assert.equal(cal.querySelectorAll(".bar")[0].classList.contains("long"), true);
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

const settle = () => new Promise(resolve => setImmediate(resolve));
const WEEK_DAYS = ["2025-03-03", "2025-03-04", "2025-03-05", "2025-03-06", "2025-03-07", "2025-03-08", "2025-03-09"];
const teamWeek = (changes = {}) => WEEK_DAYS.map((date, i) => ({
  date, hours: i < 5 ? 8 : 0, target: i < 5 ? 8 : 0, absence: null, sessions: [], flags: [], requests: [], ...changes[i],
}));
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n, h, m = 0) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, h, m); };
const dayTime = d => `${d.getDate()} ${["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"][d.getMonth()]} `
  + `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const withBalance = p => {
  for (const e of p.employees) if (e.balance === undefined) e.balance = e.target == null ? null : e.hours - e.target;
  return p;
};
const fixLimits = { long_day: 12, under_margin: 1 / 60, over_margin: 5, work_from: 7.5, work_to: 20 };
const teamFixes = () => ({ generated_at: new Date().toISOString(), limits: fixLimits, employees: [
  { id: 3, name: "Zoe", archived: false, departure_date: false, items: [
    { date: "2025-02-20", kind: "open", hours: 0, target: 8,
      sessions: [{ in: new Date(2025, 1, 20, 8).toISOString(), out: null, hours: null }] },
    { date: isoDate(daysAgo(3, 0)), kind: "long", hours: 20, target: 8,
      sessions: [{ in: daysAgo(3, 8).toISOString(), out: daysAgo(2, 4).toISOString(), hours: 20 }] },
    { date: isoDate(daysAgo(5, 0)), kind: "empty", hours: 0, target: 8, sessions: [] },
  ] },
  { id: 4, name: "Bruno", archived: false, departure_date: false, items: [
    { date: isoDate(daysAgo(11, 0)), kind: "off", hours: 9.5, target: 8, sessions: [
      { in: daysAgo(11, 6).toISOString(), out: daysAgo(11, 15).toISOString(), hours: 9 },
      { in: daysAgo(11, 15, 30).toISOString(), out: daysAgo(11, 16).toISOString(), hours: 0.5 }] },
  ] },
  { id: 9, name: "Íñigo", archived: true, departure_date: "2025-03-04", items: [
    { date: "2025-02-21", kind: "open", hours: 0, target: 8,
      sessions: [{ in: new Date(2025, 1, 21, 9).toISOString(), out: null, hours: null }] },
  ] },
] });
const teamPayload = () => withBalance({
  week: "2025-03-03", generated_at: new Date(2025, 2, 10, 9, 5).toISOString(), limits: { long_day: 12, under_margin: 1 / 60, over_margin: 5, work_from: 7.5, work_to: 20 },
  employees: [
    { id: 3, name: "Zoe", hours: 40, target: 40, flags: [], days: teamWeek({ 0: { hours: 7.5, sessions: [
      { in: new Date(2025, 2, 3, 9).toISOString(), out: new Date(2025, 2, 3, 16, 30).toISOString(), hours: 7.5, rest: false },
    ] } }) },
    { id: 1, name: "Álvaro", hours: 32, target: 40, flags: ["under"], pending: 1, days: teamWeek({ 1: { hours: 0, flags: ["empty"], requests: [
      { from: new Date(2025, 2, 4, 9).toISOString(), to: new Date(2025, 2, 4, 17, 40).toISOString(), status: "pending", reason: "Olvidé fichar" },
      { from: new Date(2025, 2, 4, 9).toISOString(), to: null, status: "refused", reason: "" },
    ] } }) },
    { id: 2, name: "Ana", hours: 30, target: null, flags: [], days: teamWeek({ 3: { hours: 0, target: 0, absence: "Vacaciones" } }) },
    { id: 4, name: "Bruno", hours: 46.5, target: 40, flags: ["over"], days: teamWeek() },
  ],
});
const cellText = td => td.children.map(c => c.textContent).join("|");
const rowName = tr => (tr.children[0].children[0] || tr.children[0]).textContent;
const withFilters = page => {
  const seg = page.document.getElementById("filterSeg");
  for (const key of ["issues", "under", "over", "requests", "all"]) {
    const button = page.document.createElement("button");
    button.dataset.filter = key;
    seg.appendChild(button);
  }
  return key => seg.listeners.click[0]({ target: { closest: () => seg.children.find(b => b.dataset.filter === key) } });
};
const texts = box => box.children.map(c => c.children.length ? c.children.map(k => k.textContent).join(" ") : c.textContent)
  .filter(Boolean);
const bannerLine = item => item.children.map(c => c.textContent ?? c).join("");
const hover = (page, node) => {
  node.listeners.pointerenter[0]({ clientX: 10, clientY: 10 });
  const tip = page.document.getElementById("tip");
  const texts = tip.children.map(c => c.children.length ? c.children.map(k => k.textContent).join(" ") : c.textContent);
  node.listeners.pointerleave[0]();
  return texts.filter(Boolean);
};

test("the management view draws one row per person, sorted in Spanish, with its flags", async () => {
  const page = load({ entry: "team.js", data: teamPayload() });
  const pick = withFilters(page);
  await settle();
  const doc = page.document;
  assert.equal(doc.getElementById("weekLabel").textContent, "Semana del 3 mar al 9 mar");
  assert.match(doc.getElementById("criteria").textContent,
    /^Bajo objetivo: una semana terminada con 1m o más por debajo .* más de 5h por encima .* más de 12h fichadas en un día\./);
  assert.match(doc.getElementById("subtitle").textContent, /^4 personas · actualizado el 10 mar a las 09:05/);
  assert.deepEqual(doc.getElementById("filterSeg").children.map(b => [b.textContent, b.getAttribute("aria-pressed")]),
    [["Con incidencias (2)", "true"], ["Bajo objetivo (1)", "false"], ["Demasiadas horas (1)", "false"], ["Con solicitudes (1)", "false"],
      ["Todas (4)", "false"]]);
  pick("requests");
  assert.deepEqual(doc.getElementById("grid").children[1].children.map(rowName), ["Álvaro"]);
  pick("all");
  const [thead, tbody] = doc.getElementById("grid").children;
  assert.deepEqual(thead.children[0].children.map(th => th.textContent),
    ["Persona", "Lun 3", "Mar 4", "Mié 5", "Jue 6", "Vie 7", "Semana"]);
  assert.deepEqual(tbody.children.map(rowName), ["Álvaro", "Ana", "Bruno", "Zoe"]);
  assert.deepEqual(tbody.children.map(tr => tr.children[0].children[0].href),
    ["/empleado?id=1", "/empleado?id=2", "/empleado?id=4", "/empleado?id=3"]);
  const bruno = tbody.children[2].children;
  assert.equal(cellText(bruno[6]), "Sobran 6h 30m|46h 30m| de 40h");
  page.run("team.data.employees.find(e => e.name === 'Bruno').suspect = true; render()");
  const suspect = doc.getElementById("grid").children[1].children[2].children[6];
  assert.equal(cellText(suspect), "Sobran 6h 30m|46h 30m| de 40h|⚠ incluye una jornada muy larga: suma no fiable");
  assert.equal(suspect.classList.contains("bad"), true);
  page.run("team.data.employees.find(e => e.name === 'Bruno').suspect = false; render()");
  assert.equal(hover(page, bruno[6]).at(-1), "46h 30m de 40h previstas: sobran 6h 30m, más de 5h");
  const alvaro = tbody.children[0].children;
  assert.equal(alvaro[2].classList.contains("warn"), true);
  assert.equal(alvaro[2].classList.contains("bad"), false);
  assert.equal(cellText(alvaro[2]), "Sin fichar|Solicitud pendiente 09:00–17:40|Solicitud rechazada 09:00");
  assert.deepEqual(alvaro[2].children.slice(1).map(c => c.className), ["req pending", "req refused"]);
  assert.deepEqual(hover(page, alvaro[2]), ["Mar 4 mar", "Sin fichajes", "Jornada prevista de 8h sin fichajes ni ausencia",
    "Solicitud pendiente 09:00–17:40", "Olvidé fichar", "Solicitud rechazada 09:00"]);
  alvaro[2].listeners.pointerenter[0]({ clientX: 10, clientY: 10 });
  assert.deepEqual(page.document.getElementById("tip").children.filter(c => /^Solicitud/.test(c.textContent)).map(c => c.className),
    ["t-note pending", "t-note refused"]);
  alvaro[2].listeners.pointerleave[0]();
  assert.equal(page.document.getElementById("tip").style.display, "none");
  assert.deepEqual(hover(page, alvaro[6]), ["Saldo de la semana, día a día", "Ningún día cerrado con jornada prevista",
    "32h de 40h previstas: faltan 8h"]);
  const zoe = tbody.children[3].children;
  assert.deepEqual(hover(page, zoe[1]), ["Lun 3 mar", "09:00–16:30 7h 30m", "Frente a 8h previstas −30m"]);
  assert.deepEqual(hover(page, zoe[6]), ["Saldo de la semana, día a día", "Lun 3 mar −30m", "Semana frente a 40h +0h"]);
  assert.equal(cellText(alvaro[6]), "Faltan 8h|32h| de 40h");
  assert.equal(alvaro[6].classList.contains("bad"), true);
  const ana = tbody.children[1].children;
  assert.equal(cellText(ana[4]), "Vacaciones");
  assert.equal(cellText(ana[6]), "30h| sin horario");
  assert.equal(doc.getElementById("openCard").classList.contains("hidden"), false);
  assert.match(doc.getElementById("fixesNote").textContent,
    /^Entradas sin cerrar, jornadas de más de 12h, fichajes fuera de 7:30 a 20:00 y días con jornada prevista sin fichar/);
  const fixes = doc.getElementById("fixes").children[0].children;
  assert.deepEqual(fixes.slice(0, 2).map(c => c.textContent), ["Persona", "Pendiente"]);
  const cells = fixes.slice(3);
  assert.deepEqual(cells.filter(c => c.tagName === "A").map(a => [a.textContent, a.href]), [["Zoe", "/empleado?id=3"], ["Bruno", "/empleado?id=4"]]);
  assert.deepEqual(cells[1].children.map(c => [c.textContent, c.className]),
    [["Abierta desde el 20 feb 2025 08:00", "chip warn"], ["1 jornada muy larga · 20h", "chip"], ["1 sin fichar", "chip"]]);
  assert.deepEqual(cells[4].children.map(c => c.textContent), ["1 fuera de horario"]);
  const zoeMarks = cells[2].children.filter(c => c.tagName === "G");
  assert.deepEqual(zoeMarks.map(g => g.children[1].getAttribute("class")), ["bar error", "bar error late", "bar missing"]);
  assert.deepEqual(hover(page, zoeMarks[0]), ["Zoe · Jue 20 feb 2025", "Sin cerrar", "08:00–abierto abierta", "Entrada a las 08:00 sin salida"]);
  assert.deepEqual(hover(page, zoeMarks[2]).slice(1), ["Sin fichar", "Jornada prevista de 8h sin fichajes ni ausencia"]);
  const brunoMarks = cells[5].children.filter(c => c.tagName === "G");
  assert.equal(brunoMarks.length, 1);
  assert.ok(hover(page, brunoMarks[0]).includes("Entrada a las 06:00, antes de las 7:30"));
  assert.ok(fixes[2].children.filter(c => c.tagName === "TEXT").length >= 6);
  const lines = strip => strip.children.filter(c => c.tagName === "LINE").map(l => l.getAttribute("class"));
  assert.ok(lines(cells[2]).filter(c => c === "day").length > 70);
  assert.ok(lines(cells[2]).includes("monday"));
  const width = () => Number(cells[2].getAttribute("width"));
  const strip = () => doc.getElementById("fixes").children[0].children.slice(3)[2];
  const before = Number(strip().getAttribute("width"));
  assert.equal(before, Math.round(page.run("fixSpan(fixRows(team.fixes)).days") * 10));
  doc.getElementById("zoomIn").listeners.click[0]();
  assert.equal(Number(strip().getAttribute("width")), Math.round(page.run("fixSpan(fixRows(team.fixes)).days") * 15));
  for (let k = 0; k < 20; k++) doc.getElementById("zoomIn").listeners.click[0]();
  assert.equal(page.run("team.fixDay"), 96);
  assert.equal(doc.getElementById("zoomIn").disabled, true);
  for (let k = 0; k < 20; k++) doc.getElementById("zoomOut").listeners.click[0]();
  assert.equal(page.run("team.fixDay"), 2);
  assert.equal(doc.getElementById("zoomOut").disabled, true);
  assert.ok(width() > 0);
  assert.deepEqual([1, 2, 7, 14].map(String), [40, 20, 6, 3].map(px => String(page.run(`tickStep(${px})`))));
  const now = new Date(2025, 5, 30, 12);
  const span = page.run(`(() => { const s = fixSpan([{ items: [{ date: "2025-06-20", sessions: [{ in: new Date(2025, 5, 20, 16).toISOString() }] }] }],
    new Date(${now.getTime()})); return [s.from.getDate(), s.from.getHours(), Math.round(s.days * 10) / 10]; })()`);
  assert.deepEqual(span, [13, 0, 17.5]);
  const old = page.run(`fixSpan([{ items: [{ date: "2020-01-01", sessions: [] }] }], new Date(${now.getTime()})).from.getFullYear()`);
  assert.equal(old, 2019);
  assert.equal(page.run(`fixSpan([], new Date(${now.getTime()})).days`), 7.5);
  const closed = page.run(`(() => { const s = fixSpan([{ items: [
    { date: "2025-06-02", sessions: [{ in: new Date(2025, 5, 2, 18).toISOString(), out: new Date(2025, 5, 2, 21).toISOString() }] },
    { date: "2025-06-04", sessions: [] }] }], new Date(${now.getTime()}));
    return [s.from.getDate(), s.to.getDate(), s.to.getHours(), s.days]; })()`);
  assert.deepEqual(closed, [26, 12, 0, 17]);
  const midnightEnd = page.run(`fixSpan([{ items: [{ date: "2025-06-02", sessions: [{ in: new Date(2025, 5, 2, 18).toISOString(),
    out: new Date(2025, 5, 3).toISOString() }] }] }], new Date(${now.getTime()})).days`);
  assert.equal(midnightEnd, 15);
  page.run("team.fixes = null; renderFixes()");
  assert.match(doc.getElementById("fixesNote").textContent, /^Buscando fichajes por corregir/);
  doc.getElementById("zoomIn").listeners.click[0]();
  page.run(`team.data = ${JSON.stringify(teamPayload())}; render()`);
  assert.equal(doc.getElementById("gridCard").classList.contains("hidden"), false);
});

test("the filters keep incidents, under or over target, or everyone, and say when nobody is left", async () => {
  const page = load({ entry: "team.js", data: teamPayload() });
  const pick = withFilters(page);
  await settle();
  const rows = () => page.document.getElementById("grid").children[1].children;
  assert.deepEqual(rows().map(rowName), ["Álvaro", "Bruno"]);
  pick("under");
  assert.deepEqual(rows().map(rowName), ["Álvaro"]);
  pick("over");
  assert.deepEqual(rows().map(rowName), ["Bruno"]);
  pick("all");
  assert.deepEqual(rows().map(rowName), ["Álvaro", "Ana", "Bruno", "Zoe"]);
  page.run("team.data.employees.find(e => e.name === 'Zoe').days[5].sessions = team.data.employees[0].days[0].sessions.concat([{ in: '2025-03-08T09:00:00', out: '2025-03-08T10:00:00', hours: 1, rest: false }]); render()");
  const head = () => page.document.getElementById("grid").children[0].children[0].children.map(th => th.textContent);
  assert.deepEqual(head(), ["Persona", "Lun 3", "Mar 4", "Mié 5", "Jue 6", "Vie 7", "Sáb 8", "Semana"]);
  assert.equal(rows()[0].children.length, 8);
  pick("over");
  assert.equal(head().includes("Sáb 8"), false);
  page.run("team.data.employees = team.data.employees.filter(e => e.name === 'Zoe'); render()");
  assert.equal(page.document.getElementById("openCard").classList.contains("hidden"), false);
  page.run("team.fixes = { ...team.fixes, employees: [] }; render()");
  assert.equal(rows()[0].children[0].textContent, "Nadie con demasiadas horas esta semana");
  assert.equal(rows()[0].children[0].colSpan, 7);
  pick("issues");
  assert.equal(rows()[0].children[0].textContent, "Nadie tiene incidencias esta semana");
  assert.equal(page.document.getElementById("openCard").classList.contains("hidden"), true);
  pick("all");
  page.run("team.data.employees = []; render()");
  assert.equal(rows()[0].children[0].textContent, "Nadie a la vista");
  page.document.getElementById("filterSeg").listeners.click[0]({ target: { closest: () => null } });
});

test("a click on a day opens its details in a dialog that closes", async () => {
  const page = load({ entry: "team.js", data: teamPayload() });
  await settle();
  const alvaro = page.document.getElementById("grid").children[1].children[0].children;
  alvaro[2].listeners.click[0]();
  const dialog = page.document.getElementById("dayDialog");
  assert.equal(dialog.open, true);
  assert.equal(page.document.getElementById("dayDialogTitle").textContent, "Álvaro");
  assert.deepEqual(texts(page.document.getElementById("dayDialogBody")), ["Mar 4 mar", "Sin fichajes",
    "Jornada prevista de 8h sin fichajes ni ausencia", "Solicitud pendiente 09:00–17:40", "Olvidé fichar", "Solicitud rechazada 09:00"]);
  page.document.getElementById("dayDialogClose").listeners.click[0]();
  assert.equal(dialog.open, false);
  alvaro[3].listeners.keydown[0]({ key: "Enter" });
  assert.equal(dialog.open, true);
  assert.deepEqual(texts(page.document.getElementById("dayDialogBody")).slice(0, 1), ["Mié 5 mar"]);
  alvaro[3].listeners.keydown[0]({ key: "Tab" });
  assert.equal(dialog.listeners.click, undefined);
});

test("today's open session reads as in progress, not as zero", async () => {
  const data = teamPayload();
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (today.getDay() + 6) % 7);
  const day = i => { const d = new Date(monday); d.setDate(d.getDate() + i); return d; };
  const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  data.week = isoOf(monday);
  const index = (today.getDay() + 6) % 7;
  data.employees = [{ id: 1, name: "Ana", hours: 0, target: 8, flags: [], days: [0, 1, 2, 3, 4, 5, 6].map(i => ({
    date: isoOf(day(i)), hours: 0, target: 8, absence: null, flags: [], requests: [],
    sessions: i === index ? [{ in: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9).toISOString(), out: null, hours: null, rest: false }] : [],
  })) }];
  const page = load({ entry: "team.js", data });
  const pick = withFilters(page);
  await settle();
  pick("all");
  const cell = page.document.getElementById("grid").children[1].children[0].children[index + 1];
  assert.equal(iso, data.employees[0].days[index].date);
  assert.equal(cellText(cell), "0h| en curso");
  assert.equal(cell.classList.contains("today"), true);
  assert.deepEqual(hover(page, cell).slice(1), ["09:00–abierto en curso"]);
});

test("someone else's week is read only: their data, no punch buttons, no durations, no state polling", async () => {
  const today = new Date();
  const page = load({ path: "/empleado?id=9", data: payload([session(at(today, 9), null)], {
    schedule: { hours: [8, 8, 8, 8, 8, 8, 8], lunch_from: [null, null, null, null, null, null, null] }, team: true,
  }) });
  await page.run("loadAndRender()");
  assert.equal(page.run("store.other"), "9");
  assert.equal(page.calls.fetch.at(-1)[0], "/api/data?employee=9");
  const hero = page.document.getElementById("hero");
  assert.equal(hero.children.length, 2);
  assert.equal(hero.querySelectorAll("button").length, 0);
  assert.equal(page.document.getElementById("teamLink").classList.contains("hidden"), false);
  const before = page.calls.fetch.length;
  await page.run("refreshState()");
  assert.equal(page.calls.fetch.length, before);
  await page.run("loadAndRender(true)");
  assert.equal(page.calls.fetch.at(-1)[0], "/api/data?employee=9&fresh");
});

test("sessions read as times, and weeks move by seven days", () => {
  const { run } = load({ entry: "team.js" });
  assert.equal(run('shiftWeek("2025-03-03", -1)'), "2025-02-24");
  assert.equal(run('shiftWeek("2025-03-24", 1)'), "2025-03-31");
  const s = (a, b, extra) => JSON.stringify({ in: a.toISOString(), out: b && b.toISOString(), hours: b ? (b - a) / 3.6e6 : null, rest: false, ...extra });
  assert.equal(run(`sessionSpan(${s(new Date(2025, 2, 3, 9), new Date(2025, 2, 3, 13, 30))})`), "09:00–13:30");
  assert.equal(run(`sessionSpan(${s(new Date(2025, 2, 3, 13, 30), new Date(2025, 2, 3, 13, 45), { rest: true })})`), "13:30–13:45 descanso");
  assert.equal(run(`sessionSpan(${s(new Date(2025, 2, 3, 9), null)})`), "09:00–abierto");
  const day = (flags, sessions, extra) => JSON.stringify({ date: "2025-03-03", hours: 14.5, target: 8, flags, sessions, ...extra });
  const limits = JSON.stringify({ long_day: 12, under_margin: 1 / 60 });
  assert.deepEqual(run(`whyDay("long", ${day(["long"], [])}, ${limits})`), ["14h 30m fichadas en el día, más de 12h"]);
  const offLimits = JSON.stringify({ long_day: 12, work_from: 7.5, work_to: 20 });
  const offDay = JSON.stringify({ date: "2025-03-03", hours: 9, target: 8, flags: ["off"], sessions: [
    JSON.parse(s(new Date(2025, 2, 3, 6, 50), new Date(2025, 2, 3, 12))),
    JSON.parse(s(new Date(2025, 2, 3, 15), new Date(2025, 2, 3, 21, 15))),
    JSON.parse(s(new Date(2025, 2, 3, 22), new Date(2025, 2, 4, 1))),
  ] });
  assert.deepEqual(run(`whyDay("off", ${offDay}, ${offLimits})`),
    ["Entrada a las 06:50, antes de las 7:30", "Salida a las 21:15, después de las 20:00", "Salida otro día, el 4 mar a las 01:00"]);
  assert.deepEqual(run(`whyDay("open", ${day(["open"], [JSON.parse(s(new Date(2025, 2, 3, 9, 5), null))])}, ${limits})`),
    ["Entrada a las 09:05 sin salida"]);
});

test("week buttons ask the server for the week they point at", async () => {
  const page = load({ entry: "team.js", data: teamPayload() });
  await settle();
  const click = async id => {
    const button = page.document.getElementById(id);
    await button.listeners.click[0]({ currentTarget: button });
    assert.equal(button.disabled, false);
  };
  await click("prevWeek");
  await click("nextWeek");
  await click("refreshBtn");
  await click("thisWeek");
  assert.deepEqual(page.calls.fetch.map(([url]) => url),
    ["/api/team", "/api/team?fixes", "/api/team?week=2025-02-24", "/api/team?week=2025-02-24", "/api/team?week=2025-02-24",
     "/api/team?week=2025-03-10", "/api/team?week=2025-02-24", "/api/team?week=2025-03-03&fresh", "/api/team?fixes&fresh",
     "/api/team?week=2025-02-24", "/api/team", "/api/team?week=2025-02-24"]);
  page.run("team.data = null");
  withFilters(page)("all");
});

test("the loading bar runs while a load is in flight, and stops even when it fails", async () => {
  let finish;
  const page = load({ entry: "team.js", fetchImpl: url => url.includes("week=")
    ? Promise.resolve({ ok: true, status: 200, json: async () => teamPayload() })
    : new Promise(resolve => { finish = resolve; }) });
  const bar = page.document.getElementById("loadbar");
  assert.equal(bar.classList.contains("on"), true);
  finish({ ok: false, status: 502, json: async () => ({ error: "Odoo no responde" }) });
  await settle();
  assert.equal(bar.classList.contains("on"), false);
});

const monthPayload = () => {
  const p = teamPayload();
  p.start = "2025-03-01";
  p.stop = "2025-04-01";
  const later = iso => { const [y, m, d] = iso.split("-").map(Number); const t = new Date(y, m - 1, d + 7);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
  for (const e of p.employees) {
    e.days = e.days.concat(teamWeek().map(d => ({ ...d, date: later(d.date) })));
    e.balance = e.target == null ? null : e.hours - e.target;
    e.weeks = [{ monday: "2025-03-03", hours: e.hours, target: e.target, balance: e.balance, flags: e.flags },
      { monday: "2025-03-10", hours: 40, target: e.target == null ? null : 40, balance: e.target == null ? null : 0, flags: [] }];
  }
  return p;
};
const withViews = page => {
  const seg = page.document.getElementById("viewSeg");
  for (const key of ["week", "month", "year"]) {
    const button = page.document.createElement("button");
    button.dataset.view = key;
    seg.appendChild(button);
  }
  return key => seg.listeners.click[0]({ target: { closest: () => seg.children.find(b => b.dataset.view === key) } });
};

test("the month view shows each week whole, how many days carry a flag, and the month's own balance", async () => {
  const page = load({ entry: "team.js", data: monthPayload() });
  const view = withViews(page);
  const pick = withFilters(page);
  await settle();
  view("week");
  view("month");
  await settle();
  const doc = page.document;
  assert.equal(page.calls.fetch.at(-2)[0], "/api/team?month=2025-03");
  assert.equal(page.calls.fetch.at(-1)[0], "/api/team?month=2025-02");
  assert.equal(doc.getElementById("weekLabel").textContent, "Marzo de 2025");
  assert.deepEqual(doc.getElementById("viewSeg").children.map(b => b.getAttribute("aria-pressed")), ["false", "true", "false"]);
  pick("all");
  const [thead, tbody] = doc.getElementById("grid").children;
  assert.deepEqual(thead.children[0].children.map(th => th.textContent), ["Persona", "3 mar – 9 mar", "10 mar – 16 mar", "Mes"]);
  const alvaro = tbody.children[0].children;
  assert.equal(cellText(alvaro[1]), "Faltan 8h|32h| de 40h|1 día con errores de fichaje");
  assert.equal(alvaro[1].classList.contains("bad"), true);
  assert.equal(alvaro[2].classList.contains("bad"), false);
  assert.equal(cellText(alvaro[3]), "Faltan 8h|32h| de 40h");
  assert.equal(alvaro[3].classList.contains("bad"), true);
  assert.equal(tbody.children[3].children[3].classList.contains("bad"), false);
  assert.deepEqual(hover(page, alvaro[3]),
    ["Saldo de cada semana, entera", "3 mar – 9 mar −8h", "10 mar – 16 mar +0h", "Solo los días del mes −8h"]);
  page.run('team.data = { ...team.data, stop: "2999-01-01" }; render()');
  assert.equal(cellText(doc.getElementById("grid").children[1].children[0].children[3]), "Faltan 8h hasta ayer|32h| de 40h");
  assert.deepEqual(["gapText(0)", "gapText(0.001)", "gapText(1.5)", "gapText(-0.25)"].map(page.run),
    ["Al día", "Al día", "Sobran 1h 30m", "Faltan 15m"]);
  assert.equal(cellText(tbody.children[1].children[3]), "30h| sin horario");
  page.run("team.data = { ...team.data, employees: [] }; team.filter = 'issues'; render()");
  assert.equal(doc.getElementById("grid").children[1].children[0].children[0].textContent, "Nadie tiene incidencias este mes");
  page.run("team.data = " + JSON.stringify(monthPayload()) + "; team.filter = 'all'; render()");
  const again = doc.getElementById("grid").children[1].children[0].children;
  again[2].listeners.keydown[0]({ key: "Tab" });
  again[2].listeners.keydown[0]({ key: "Enter" });
  assert.equal(page.calls.fetch.at(-1)[0], "/api/team?week=2025-03-10");
  assert.deepEqual([page.run("team.search"), doc.getElementById("search").value], ["Álvaro", "Álvaro"]);
  await settle();
  assert.equal(page.run("team.view"), "week");
  view("month");
  await settle();
  const cells = doc.getElementById("grid").children[1].children[0].children;
  cells[1].listeners.click[0]();
  await settle();
  assert.equal(page.run("team.view"), "week");
  view("week");
});

test("in the month view the arrows and «Hoy» move by months", async () => {
  const page = load({ entry: "team.js", data: monthPayload() });
  const view = withViews(page);
  await settle();
  view("month");
  await settle();
  const click = async id => {
    const button = page.document.getElementById(id);
    await button.listeners.click[0]({ currentTarget: button });
  };
  await click("prevWeek");
  assert.equal(page.calls.fetch.at(-2)[0], "/api/team?month=2025-02");
  await click("nextWeek");
  assert.equal(page.calls.fetch.at(-2)[0], "/api/team?month=2025-04");
  await click("refreshBtn");
  assert.equal(page.calls.fetch.at(-3)[0], "/api/team?month=2025-03&fresh");
  assert.equal(page.calls.fetch.at(-2)[0], "/api/team?fixes&fresh");
  await click("thisWeek");
  const now = new Date();
  assert.equal(page.calls.fetch.at(-2)[0], `/api/team?month=${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  assert.equal(page.run('shiftMonth("2025-12", 1)'), "2026-01");
  assert.equal(page.run('shiftMonth("2025-01", -1)'), "2024-12");
});

const yearPayload = (year = 2025) => {
  const months = changes => Array.from({ length: 12 }, (_, i) => ({
    month: `${year}-${String(i + 1).padStart(2, "0")}`, hours: 140, target: 140, balance: 0, under: 0, over: 0, flagged_days: 0,
    ...changes[i],
  }));
  return {
    year: 2025, week: "2024-12-30", start: "2025-01-01", stop: "2026-01-01", generated_at: new Date(2026, 0, 2).toISOString(),
    limits: { long_day: 12, under_margin: 1 / 60, over_margin: 5, work_from: 7.5, work_to: 20 }, open: [],
    employees: [
      { id: 1, name: "Álvaro", hours: 1600, target: 1700, balance: -100, flags: ["under"],
        months: months({ 2: { under: 1, flagged_days: 2 }, 4: { over: 2, balance: 12.5 } }) },
      { id: 2, name: "Ana", hours: 900, target: null, balance: null, flags: [],
        months: months({}).map(m => ({ ...m, target: null, balance: null })) },
    ],
  };
};

const byPeriod = urls => async url => {
  urls.push(url);
  const data = url.includes("fixes") ? teamFixes() : url.includes("year=") ? yearPayload()
    : url.includes("month=") ? monthPayload() : teamPayload();
  return { ok: true, status: 200, json: async () => data };
};

test("the year view shows each month against its target, its weeks off target and its flagged days", async () => {
  const urls = [];
  const page = load({ entry: "team.js", fetchImpl: byPeriod(urls) });
  page.calls.fetch = { at: i => [urls.at(i)] };
  const view = withViews(page);
  const pick = withFilters(page);
  await settle();
  view("year");
  await settle();
  const doc = page.document;
  assert.equal(page.calls.fetch.at(-1)[0], "/api/team?year=2025");
  assert.equal(doc.getElementById("weekLabel").textContent, "2025");
  pick("all");
  const [thead, tbody] = doc.getElementById("grid").children;
  assert.deepEqual(thead.children[0].children.map(th => th.textContent),
    ["Persona", "Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic", "Año"]);
  const alvaro = tbody.children[0].children;
  assert.equal(cellText(alvaro[3]), "Al día|140h| de 140h|1 semana bajo objetivo|2 días con errores de fichaje");
  assert.equal(alvaro[3].classList.contains("bad"), true);
  assert.equal(cellText(alvaro[5]), "Sobran 12h 30m|140h| de 140h|2 semanas con demasiadas horas");
  assert.equal(alvaro[1].classList.contains("bad"), false);
  assert.equal(cellText(alvaro[13]), "Faltan 100h|1600h| de 1700h");
  assert.equal(alvaro[13].classList.contains("bad"), true);
  assert.equal(tbody.children[1].children[13].classList.contains("bad"), false);
  const ana = tbody.children[1].children;
  assert.equal(cellText(ana[1]), "140h| sin horario");
  assert.equal(cellText(ana[13]), "900h| sin horario");
  pick("issues");
  assert.deepEqual(doc.getElementById("grid").children[1].children.map(rowName), ["Álvaro"]);
  page.run("team.data = { ...team.data, employees: [] }; render()");
  assert.equal(doc.getElementById("grid").children[1].children[0].children[0].textContent, "Nadie tiene incidencias este año");
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  page.run(`team.year = "${now.getFullYear()}"; team.data = ${JSON.stringify(yearPayload(now.getFullYear()))}; render()`);
  const cells = doc.getElementById("grid").children[1].children[0].children;
  const index = now.getMonth() + 1;
  assert.equal(cells[index].classList.contains("today"), true);
  assert.match(cellText(cells[index]), /Al día hasta ayer/);
  assert.equal(cellText(cells[13]), "Faltan 100h hasta ayer|1600h| de 1700h");
  if (index < 12) {
    assert.equal(cells[index + 1].classList.contains("future"), true);
    assert.equal(cells[index + 1].children.length, 0);
  }
  page.run(`team.year = "2025"; team.data = ${JSON.stringify(yearPayload())}; render()`);
  const again = doc.getElementById("grid").children[1].children[0].children;
  again[3].listeners.keydown[0]({ key: "Tab" });
  again[3].listeners.keydown[0]({ key: "Enter" });
  assert.equal(page.calls.fetch.at(-1)[0], "/api/team?month=2025-03");
  assert.equal(page.run("team.search"), "Álvaro");
  await settle();
  view("year");
  await settle();
  doc.getElementById("grid").children[1].children[0].children[3].listeners.click[0]();
  await settle();
  assert.equal(page.run("team.view"), "month");
  assert.ok(thisMonth);
});

test("in the year view the arrows and «Hoy» move by years, with no background prefetch", async () => {
  const urls = [];
  const page = load({ entry: "team.js", fetchImpl: byPeriod(urls) });
  page.calls.fetch = { at: i => [urls.at(i)] };
  const view = withViews(page);
  await settle();
  view("year");
  await settle();
  const click = async id => {
    const button = page.document.getElementById(id);
    await button.listeners.click[0]({ currentTarget: button });
  };
  await click("prevWeek");
  assert.equal(page.calls.fetch.at(-1)[0], "/api/team?year=2024");
  await click("nextWeek");
  assert.equal(page.calls.fetch.at(-1)[0], "/api/team?year=2026");
  await click("refreshBtn");
  assert.equal(page.calls.fetch.at(-2)[0], "/api/team?year=2025&fresh");
  assert.equal(page.calls.fetch.at(-1)[0], "/api/team?fixes&fresh");
  await click("thisWeek");
  assert.equal(page.calls.fetch.at(-1)[0], `/api/team?year=${new Date().getFullYear()}`);
  page.run(`team.year = "${new Date().getFullYear()}"`);
  view("week");
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  assert.equal(page.calls.fetch.at(-1)[0], `/api/team?week=${iso}`);
});

const withDisplay = page => {
  const seg = page.document.getElementById("displaySeg");
  for (const key of ["table", "charts"]) {
    const button = page.document.createElement("button");
    button.dataset.display = key;
    seg.appendChild(button);
  }
  return key => seg.listeners.click[0]({ target: { closest: () => seg.children.find(b => b.dataset.display === key) } });
};
const svgTexts = node => (node.children || []).flatMap(c => typeof c === "string" ? [] : [
  ...(c.tagName === "TEXT" ? [c.textContent] : []), ...svgTexts(c)]);

test("the charts tab shows each person's balance and incidents per period, in every view", async () => {
  const urls = [];
  const page = load({ entry: "team.js", fetchImpl: byPeriod(urls) });
  const display = withDisplay(page);
  const view = withViews(page);
  const pick = withFilters(page);
  await settle();
  pick("all");
  page.run("team.data.employees.forEach((e, i) => { e.balance = [-8, 0.5, null, 6.5][i]; e.suspect = i === 3; })");
  display("charts");
  const doc = page.document;
  assert.equal(doc.getElementById("gridCard").classList.contains("hidden"), true);
  assert.equal(doc.getElementById("charts").classList.contains("hidden"), false);
  const [people, timeline] = doc.getElementById("charts").children;
  assert.deepEqual(page.run(`divergingBars([{ label: "a", value: -4, rows: [] }, { label: "b", value: 40, suspect: true, rows: [] }], String)
    .children.filter(c => c.tagName === "G").map(g => g.children[2].getAttribute("width"))`), ["355", "355"]);
  const bars = people.children.at(-2);
  assert.deepEqual(svgTexts(bars), ["Zoe", "−8h", "Álvaro", "+30m", "Bruno", "⚠ +6h 30m"]);
  assert.equal(people.children.at(-1).textContent, "⚠ Saldo no fiable: incluye una jornada muy larga, casi siempre una salida sin fichar.");
  assert.deepEqual(svgTexts(timeline.children.at(-1)).map(String), ["0", "1", "Lun", "1", "Mar", "Mié", "Jue", "Vie"]);
  const marks = bars.children.filter(c => c.tagName === "G");
  assert.equal(marks.length, 3);
  assert.equal(marks[0].children[2].getAttribute("class"), "bar short");
  assert.equal(marks[1].children[2].getAttribute("class"), "bar surplus");
  assert.equal(marks[2].children[2].getAttribute("class"), "bar error");
  marks[0].listeners.click[0]();
  marks[1].listeners.keydown[0]({ key: "Enter" });
  marks[1].listeners.keydown[0]({ key: "Tab" });
  assert.deepEqual(page.calls.assigned, ["/empleado?id=3", "/empleado?id=1"]);
  assert.deepEqual(hover(page, marks[0]), ["Zoe", "Fichadas 40h", "Previstas 40h", "Saldo Faltan 8h"]);
  const columns = timeline.children.at(-1).children.filter(c => c.tagName === "G");
  assert.equal(columns.length, 5);
  assert.deepEqual(hover(page, columns[1]), ["Mar 4 mar", "Personas con errores de fichaje 1", "Álvaro"]);
  display("table");
  assert.equal(doc.getElementById("gridCard").classList.contains("hidden"), false);
  display("charts");
  view("month");
  await settle();
  const month = doc.getElementById("charts").children;
  assert.equal(month[1].children[2].className, "legend-row");
  const weeks = month[1].children.at(-1).children.filter(c => c.tagName === "G");
  assert.equal(weeks.length, 2);
  assert.deepEqual(hover(page, weeks[0]), ["3 mar – 9 mar", "Bajo objetivo 1", "Álvaro", "Demasiadas horas 1", "Bruno"]);
  weeks[0].listeners.pointerenter[0]({ clientX: 10, clientY: 10 });
  const tipKids = page.document.getElementById("tip").children;
  assert.deepEqual(tipKids.map(c => c.className), ["t-title", "t-row", "t-note t-name", "t-sep", "t-row", "t-note t-name"]);
  assert.deepEqual(tipKids.filter(c => c.className === "t-row").map(r => r.children[0].children[0].className), ["swatch short", "swatch over"]);
  weeks[0].listeners.pointerleave[0]();
  view("year");
  await settle();
  const year = doc.getElementById("charts").children;
  assert.equal(year[1].children.at(-1).children.filter(c => c.tagName === "G").length, 12);
  page.run("team.data = { ...team.data, employees: team.data.employees.map(e => ({ ...e, balance: null })) }; render()");
  assert.equal(doc.getElementById("charts").children[0].children.at(-1).textContent, "Nadie con jornada prevista");
  doc.getElementById("displaySeg").listeners.click[0]({ target: { closest: () => null } });
  doc.getElementById("charts").replaceChildren();
  page.calls.window.resize[0]();
  assert.equal(doc.getElementById("charts").children.length, 2);
  page.run("team.data = null");
  page.calls.window.resize[0]();
  display("table");
});

test("archived people are hidden by default everywhere and shown with their departure on demand", async () => {
  const data = teamPayload();
  data.employees.push({ id: 9, name: "Íñigo", hours: 0, target: 40, balance: -40, flags: ["under"], archived: true,
    departure_date: "2025-03-04", days: teamWeek() });
  data.employees.push({ id: 10, name: "Olga", hours: 0, target: 40, balance: -40, flags: [], archived: true,
    departure_date: false, days: teamWeek() });
  const page = load({ entry: "team.js", data });
  const pick = withFilters(page);
  await settle();
  const doc = page.document;
  const button = doc.getElementById("archivedBtn");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(button.textContent, "Ocultar archivados (2)");
  assert.match(doc.getElementById("subtitle").textContent, /^4 personas/);
  const fixed = () => doc.getElementById("fixes").children[0].children.filter(c => c.tagName === "A").map(a => a.textContent);
  assert.deepEqual(fixed(), ["Zoe", "Bruno"]);
  pick("all");
  const names = () => doc.getElementById("grid").children[1].children.map(rowName);
  assert.deepEqual(names(), ["Álvaro", "Ana", "Bruno", "Zoe"]);
  button.listeners.click[0]();
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.textContent, "Ocultar archivados");
  assert.deepEqual(names(), ["Álvaro", "Ana", "Bruno", "Íñigo", "Olga", "Zoe"]);
  const inigo = doc.getElementById("grid").children[1].children[3].children[0];
  assert.equal(inigo.children[1].textContent, "Baja 4 mar");
  assert.equal(doc.getElementById("grid").children[1].children[4].children[0].children[1].textContent, "Archivado");
  assert.deepEqual(fixed(), ["Zoe", "Íñigo", "Bruno"]);
  assert.match(doc.getElementById("subtitle").textContent, /^6 personas/);
  page.run("team.data = null");
  button.listeners.click[0]();
});

test("the fixes card filters its own rows by kind, counting each kind's people", async () => {
  const page = load({ entry: "team.js", data: teamPayload() });
  const doc = page.document;
  const seg = doc.getElementById("fixKinds");
  for (const kind of ["open", "long", "off", "empty"]) {
    const button = doc.createElement("button");
    button.dataset.kind = kind;
    seg.appendChild(button);
  }
  await settle();
  const toggles = seg.children;
  const toggle = kind => seg.listeners.click[0]({ target: { closest: () => toggles.find(b => b.dataset.kind === kind) } });
  const fixed = () => doc.getElementById("fixes").children[0].children.filter(c => c.tagName === "A").map(a => a.textContent);
  assert.deepEqual(toggles.map(b => b.textContent), ["Sin cerrar (1)", "Jornada muy larga (1)", "Fuera de horario (1)", "Sin fichar (1)"]);
  assert.deepEqual(fixed(), ["Zoe", "Bruno"]);
  toggle("open");
  toggle("long");
  toggle("empty");
  assert.deepEqual(fixed(), ["Bruno"]);
  assert.deepEqual(toggles.map(b => b.getAttribute("aria-pressed")), ["false", "false", "true", "false"]);
  assert.equal(toggles[0].textContent, "Sin cerrar (1)");
  assert.match(page.calls.hash, /k=off$/);
  toggle("off");
  assert.deepEqual(fixed(), []);
  assert.match(doc.getElementById("fixesNote").textContent, /Nadie con los tipos elegidos\.$/);
  assert.equal(doc.getElementById("openCard").classList.contains("hidden"), false);
  toggle("long");
  const chips = doc.getElementById("fixes").children[0].children[4];
  assert.deepEqual(chips.children.map(c => c.textContent), ["1 jornada muy larga · 20h"]);
  const wide = doc.getElementById("wideBtn");
  wide.listeners.click[0]({ currentTarget: wide });
  assert.equal(doc.getElementById("openCard").classList.contains("wide"), true);
  assert.deepEqual([wide.getAttribute("aria-pressed"), wide.title], ["true", "Volver al ancho normal"]);
  wide.listeners.click[0]({ currentTarget: wide });
  assert.deepEqual([wide.getAttribute("aria-pressed"), wide.getAttribute("aria-label")], ["false", "Ampliar a todo el ancho"]);
  doc.getElementById("fixKinds").listeners.click[0]({ target: { closest: () => null } });
  page.run("team.fixes = null");
  toggle("open");
});

test("the management page keeps its view in the URL and in the session, and restores it", async () => {
  const urls = [];
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const page = load({ entry: "team.js", fetchImpl: byPeriod(urls), path: "/gestion#v=month&p=2025-03&f=all&d=charts&a=0&k=open,bogus,off&q=zo", storage });
  await settle();
  assert.equal(urls[0], "/api/team?month=2025-03");
  assert.deepEqual(page.run("[team.view, team.filter, team.display, team.hideArchived, team.search]"),
    ["month", "all", "charts", false, "zo"]);
  assert.deepEqual(page.run("[...team.fixKinds]"), ["open", "off"]);
  assert.equal(page.calls.hash, "#v=month&p=2025-03&f=all&d=charts&a=0&k=open%2Coff&q=zo");
  assert.equal(store.get("gestion"), "#v=month&p=2025-03&f=all&d=charts&a=0&k=open%2Coff&q=zo");
  const again = load({ entry: "team.js", fetchImpl: byPeriod([]), path: "/gestion", storage });
  assert.equal(again.run("team.view"), "month");
  const bogus = load({ entry: "team.js", fetchImpl: byPeriod([]), path: "/gestion#v=nope&f=nope&d=nope" });
  assert.deepEqual(bogus.run("[team.view, team.filter, team.display, team.hideArchived, team.search]"),
    ["week", "issues", "table", true, ""]);
  const broken = { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("bloqueado"); } };
  const blocked = load({ entry: "team.js", fetchImpl: byPeriod([]), path: "/gestion", storage: broken });
  await settle();
  assert.equal(blocked.run("team.view"), "week");
});

test("the table shows even when the list of fixes fails, which says why", async () => {
  const page = load({ entry: "team.js", fetchImpl: async url => url.includes("fixes")
    ? { ok: false, status: 502, json: async () => ({ error: "Odoo no responde" }) }
    : { ok: true, status: 200, json: async () => teamPayload() } });
  await settle();
  assert.equal(page.document.getElementById("gridCard").classList.contains("hidden"), false);
  assert.equal(page.document.getElementById("fixesNote").textContent, "No se pudieron cargar los fichajes por corregir: Odoo no responde");
});

test("a refused or failed load says why", async () => {
  const page = load({ entry: "team.js", fetchImpl: async () => ({
    ok: false, status: 403, json: async () => ({ error: "Tu usuario de Odoo no ve fichajes de otras personas" }),
  }) });
  await settle();
  const msg = page.document.getElementById("loadmsg");
  assert.equal(msg.textContent, "Error cargando datos de Odoo: Tu usuario de Odoo no ve fichajes de otras personas");
  assert.equal(msg.classList.contains("hidden"), false);
});

test("logout goes to the login page, or says it failed and stays usable", async () => {
  let ok = true;
  const page = load({ entry: "team.js", fetchImpl: async url => url === "/api/logout"
    ? { ok, status: ok ? 200 : 502, json: async () => (ok ? { ok: true } : { error: "Odoo no responde" }) }
    : { ok: true, status: 200, json: async () => teamPayload() } });
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

function fakeAudio(refuse = false) {
  const made = [];
  class AudioContext {
    constructor() { this.state = "suspended"; this.currentTime = 0; this.destination = {}; made.push(this); }
    resume() {
      if (refuse) return Promise.reject(new Error("bloqueado"));
      this.state = "running";
      return Promise.resolve();
    }
    createOscillator() {
      const osc = { frequency: {}, connect: to => to, start() {}, stop() { osc.stopped = true; } };
      (this.oscillators ||= []).push(osc);
      return osc;
    }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: to => to }; }
  }
  return { made, window: { AudioContext } };
}

test("the first touch unlocks the sound, and a lunch that ran out rings three beeps", async () => {
  const audio = fakeAudio();
  const page = load({ globals: { window: audio.window } });
  const doc = page.document;
  doc.listeners.pointerdown[0]();
  await settle();
  assert.equal(audio.made.length, 1);
  assert.equal(audio.made[0].state, "running");
  doc.listeners.keydown[0]();
  assert.equal(audio.made.length, 1);
  const lunch = new Date(Date.now() - 40 * 60000).toISOString();
  page.run(`store.data = ${JSON.stringify(payload([]))}; store.state = { ...store.data.state, lunch: "${lunch}" }; ${SCHEDULE}`);
  page.run("setClock(new Date()); store.expected = [8, 8, 8, 8, 8, 8, 8]; checkAlarms()");
  assert.equal(audio.made[0].oscillators.length, 3);
  assert.ok(audio.made[0].oscillators.every(o => o.stopped));
  assert.equal(page.run("document.title"), "Fichajes");
  const flash = page.calls.timers.find(([, ms]) => ms === 900)[0];
  flash();
  assert.equal(page.run("document.title"), "🍽 Comida terminada");
  flash();
  assert.equal(page.run("document.title"), "Fichajes");
  const refused = fakeAudio(true);
  const blocked = load({ globals: { window: refused.window } });
  blocked.document.listeners.pointerdown[0]();
  await settle();
  assert.equal(refused.made[0].state, "suspended");
  page.run("store.notifyEl = document.createElement('div'); store.notifyArgs = [null, { expected: 8 }, 8]; refreshNotifyNote()");
  assert.match(page.run("store.notifyEl.textContent"), /^Comida vencida a las \d\d:\d\d$/);
});

test("a changed setting is saved, and rolled back when the server refuses it", async () => {
  const posts = [];
  let reply = { ok: true, status: 200, json: async () => ({ ...payload([]).state, lunch_minutes: 45 }) };
  const page = load({ fetchImpl: async (url, opts) => {
    if (url === "/api/state" && opts?.method === "POST") { posts.push(JSON.parse(opts.body)); return reply; }
    return { ok: true, status: 200, json: async () => payload([]) };
  } });
  await page.run("loadAndRender()");
  await page.run("saveState({ lunch_minutes: 45 })");
  assert.deepEqual(posts, [{ lunch_minutes: 45 }]);
  assert.equal(page.run("store.state.lunch_minutes"), 45);
  reply = { ok: false, status: 500, json: async () => ({}) };
  await page.run("saveState({ lunch_minutes: 60 })");
  assert.equal(page.run("store.state.lunch_minutes"), 45);
  reply = Promise.reject(new Error("sin red"));
  reply.catch(() => {});
  await page.run("saveState({ lunch_minutes: 70 })");
  assert.equal(page.run("store.state.lunch_minutes"), 45);
});

test("the state poll repaints only on a change, and reloads after a punch elsewhere", async () => {
  let state = payload([]).state;
  let fail = false;
  const loads = [];
  const page = load({ fetchImpl: async url => {
    if (url === "/api/state") {
      if (fail) throw new Error("sin red");
      return { ok: state !== null, status: state ? 200 : 500, json: async () => state };
    }
    loads.push(url);
    return { ok: true, status: 200, json: async () => payload([]) };
  } });
  await page.run("loadAndRender()");
  const before = loads.length;
  await page.run("refreshState()");
  assert.equal(loads.length, before);
  state = { ...state, lunch: new Date().toISOString() };
  page.run("LastRing.lunch = 5");
  await page.run("refreshState()");
  assert.equal(page.run("store.state.lunch"), state.lunch);
  assert.equal(page.run("LastRing.lunch"), 0);
  state = { ...state, muted: true };
  await page.run("refreshState()");
  assert.equal(page.run("store.state.muted"), true);
  state = { ...state, punched_at: "2026-09-25T10:00:00" };
  await page.run("refreshState()");
  assert.equal(loads.length, before + 1);
  state = null;
  await page.run("refreshState()");
  fail = true;
  await page.run("refreshState()");
  assert.equal(loads.length, before + 1);
});

test("the tab coming back, the source poll, the views and «Actualizar» drive the dashboard", async () => {
  const versions = ["a", "a", "b"];
  let versionFails = false;
  const fetched = [];
  const page = load({ fetchImpl: async url => {
    fetched.push(url);
    if (url === "/api/version") {
      if (versionFails) throw new Error("sin red");
      return { ok: true, status: 200, json: async () => ({ version: versions.shift() }) };
    }
    return { ok: true, status: 200, json: async () => payload([]) };
  } });
  await page.run("loadAndRender()");
  const doc = page.document;
  const poll = page.calls.timers.find(([, ms]) => ms === 2000)[0];
  await poll();
  await poll();
  assert.equal(page.calls.reload, 0);
  await poll();
  await settle();
  assert.equal(page.calls.reload, 1);
  versionFails = true;
  await poll();
  page.run("document.querySelector = () => ({})");
  await poll();
  page.run("document.querySelector = () => null");
  const visible = doc.listeners.visibilitychange[0];
  doc.hidden = true;
  visible();
  doc.hidden = false;
  const loads = () => fetched.filter(url => url.startsWith("/api/data")).length;
  const loaded = loads();
  visible();
  page.run("store.loadedAt = 0; store.triedAt = 0");
  visible();
  await settle();
  assert.equal(loads(), loaded + 1);
  page.run("store.data = null");
  visible();
  page.run(`store.data = ${JSON.stringify(payload([]))}; store.state = store.data.state`);
  page.run("setClock(new Date()); indexSessions(); store.loadedAt = Date.now(); store.punchEv = null; tick()");
  page.run("store.punchEv = { at: new Date(), open: false }; store.punchEl = document.createElement('div'); tick()");
  assert.match(page.run("store.punchEl.textContent"), / a las \d\d:\d\d · hace 0m$/);
  page.run(`store.data.sessions = [${JSON.stringify(session(new Date(Date.now() - 3600e3), null))}]; indexSessions()`);
  page.run("document.querySelector = () => ({}); tick(); document.querySelector = () => null; tick()");
  const views = doc.getElementById("viewSeg");
  const table = doc.createElement("button"), charts = doc.createElement("button");
  table.dataset.view = "table";
  charts.dataset.view = "charts";
  views.append(charts, table);
  views.listeners.click[0]({ target: { closest: () => table }, currentTarget: views });
  assert.deepEqual([doc.getElementById("tableView").classList.contains("hidden"), doc.getElementById("chartsView").classList.contains("hidden")], [false, true]);
  assert.deepEqual([charts, table].map(b => b.getAttribute("aria-pressed")), ["false", "true"]);
  views.listeners.click[0]({ target: { closest: () => null }, currentTarget: views });
  const refresh = doc.getElementById("refreshBtn");
  const target = { disabled: false };
  await refresh.listeners.click[0]({ target });
  assert.equal(target.disabled, false);
  assert.ok(fetched.includes("/api/data?fresh"));
});

test("an armed punch button disarms by itself after four seconds", async () => {
  const today = new Date();
  const schedule = { hours: [7, 7, 7, 7, 7, 7, 7], lunch_from: [13, 13, 13, 13, 13, 13, 13] };
  const page = load({ data: payload([session(at(today, 9), null)], { schedule }) });
  await page.run("loadAndRender()");
  const hero = page.document.getElementById("hero");
  const button = hero.querySelectorAll(".btn").find(b => b.textContent === "Fichar salida");
  button.classList.add("pulse");
  await button.listeners.click[0]();
  assert.equal(button.textContent, "¿Confirmar?");
  const [disarm, ms] = page.calls.timeouts.at(-1);
  assert.equal(ms, 4000);
  disarm();
  assert.equal(button.textContent, "Fichar salida");
  assert.deepEqual(["arm", "pulse"].map(c => button.classList.contains(c)), [false, true]);
  const field = hero.querySelectorAll(".lunch-input")[0];
  field.value = "999";
  field.listeners.change[0]();
  field.value = "abc";
  field.listeners.change[0]();
  const posts = page.calls.fetch.filter(([url, opts]) => url === "/api/state" && opts?.method === "POST").map(([, o]) => JSON.parse(o.body));
  assert.deepEqual(posts.map(p => Object.values(p)[0]), [240, 0]);
});

test("a full fortnight draws every part of the dashboard: break, lunch, leave, holidays and progress", async () => {
  const d = (day, h, m = 0) => new Date(2026, 8, day, h, m);
  const work = (day, h1, m1, h2, m2) => session(d(day, h1, m1), d(day, h2, m2));
  const rest = (day, h1, m1, h2, m2) => session(d(day, h1, m1), h2 == null ? null : d(day, h2, m2), true);
  const sessions = [
    work(7, 8, 0, 12, 0), rest(7, 12, 0, 12, 15), work(7, 12, 15, 13, 0), work(7, 13, 45, 17, 30),
    work(8, 8, 0, 16, 30), work(9, 8, 0, 16, 0), work(10, 8, 0, 16, 0), work(11, 8, 0, 16, 0),
    work(14, 8, 0, 16, 0), work(15, 7, 45, 8, 15), rest(15, 8, 45),
  ];
  const absences = [1, 2, 3, 4].map(day => ({ date: isoDate(d(day, 0)), type: "Vacaciones" })).concat([
    { date: "2026-08-31", type: "Vacaciones" },
    { date: "2026-09-08", type: "Médico", hours: 1, from: d(8, 16, 30).toISOString(), to: d(8, 17, 30).toISOString() },
    { date: "2026-09-15", type: "Médico", hours: 0.5, from: d(15, 16).toISOString(), to: d(15, 16, 30).toISOString() },
  ]);
  const schedule = { hours: [8, 8, 8, 8, 8, 0, 0], lunch_from: [0, 0, 0, 0, 0, 0, 0] };
  const data = payload(sessions, { generated_at: d(15, 10).toISOString(), schedule, absences });
  const page = load({ fetchImpl: async (url, opts) => ({ ok: true, status: 200,
    json: async () => url === "/api/state" ? { ...data.state, ...JSON.parse(opts.body) } : data }) });
  await page.run("loadAndRender()");
  const doc = page.document;
  const hero = doc.getElementById("hero");
  assert.deepEqual(hero.querySelectorAll(".btn").map(b => b.textContent), ["Volver del descanso", "Fichar salida"]);
  const notes = hero.querySelectorAll(".note").map(n => n.textContent);
  assert.ok(notes.includes("Comida de hoy: 30m sin fichar"));
  assert.ok(notes.includes("Descanso fichado hoy: 1h 15m (en curso)"));
  assert.ok(notes.includes("Mar 15 sep · Médico 30m · 1h 45m fichadas"));
  const mute = hero.querySelectorAll(".icon-btn")[0];
  mute.listeners.click[0]();
  await settle();
  assert.equal(page.run("store.state.muted"), true);
  page.run("renderHero()");
  hero.querySelectorAll(".icon-btn")[0].listeners.click[0]();
  await settle();
  assert.equal(page.run("store.state.muted"), false);
  page.run("store.data.sessions.at(-1).rest = false; indexSessions(); renderHero()");
  assert.deepEqual(hero.querySelectorAll(".btn").map(b => b.textContent), ["Fichar salida", "Salir a comer", "Salir a descanso"]);

  const card = doc.getElementById("weekCal");
  assert.equal(card.querySelectorAll(".badge")[0].textContent, "en curso · faltan 29h 45m");
  const nav = cls => card.querySelectorAll(`.${cls}`)[0];
  nav("navbtn").listeners.click[0]();
  assert.equal(page.run("calOffset"), 1);
  card.querySelectorAll(".navbtn")[1].listeners.click[0]();
  assert.equal(page.run("calOffset"), 0);
  nav("navbtn").listeners.click[0]();
  nav("todaybtn").listeners.click[0]();
  assert.equal(page.run("calOffset"), 0);
  page.run("calOffset = 1; calView = 'objetivo'; renderCalendar()");
  assert.equal(card.querySelectorAll(".badge")[0].textContent, "▲ +2h 15m vs 39h");
  const monday = card.querySelectorAll(".dayrow")[0];
  assert.equal(monday.querySelectorAll(".rest").length, 1);
  assert.deepEqual(hover(page, monday), ["Lun 7 sep", "Total 8h 45m", "Previsto 8h", "Comida (sin fichar) 45m", "Descanso 15m",
    "08:00 – 12:00 4h", "12:00 – 12:15 · descanso 15m", "12:15 – 13:00 45m", "13:45 – 17:30 3h 45m"]);
  assert.deepEqual(hover(page, card.querySelectorAll(".dayrow")[1]).slice(0, 4), ["Mar 8 sep", "Total 8h 30m", "Previsto 7h", "Permiso · Médico 1h"]);
  page.run("calOffset = 2; renderCalendar()");
  assert.equal(card.querySelectorAll(".badge")[0].textContent, "vacaciones");
  assert.deepEqual(hover(page, card.querySelectorAll(".dayrow")[0]).slice(0, 3), ["Lun 31 ago", "Total —", "Ausencia Vacaciones"]);
  page.run("calOffset = 1; calView = 'horario'; renderCalendar()");
  const rows = card.querySelectorAll(".tl-row");
  const mondayRow = rows.find(r => r.querySelectorAll(".dnum")[0]?.textContent === "7");
  assert.deepEqual(mondayRow.querySelectorAll(".gap").map(g => g.textContent), ["45m"]);
  const restBlock = mondayRow.querySelectorAll(".sess").find(s => s.classList.contains("rest"));
  assert.deepEqual(hover(page, restBlock).slice(0, 2), ["Lun 7 sep · 12:00 – 12:15", "Descanso 15m"]);
  assert.ok(mondayRow.querySelectorAll(".sess").some(s => s.classList.contains("join-r")));
  const tuesdayRow = rows.find(r => r.querySelectorAll(".dnum")[0]?.textContent === "8");
  assert.deepEqual(tuesdayRow.querySelectorAll(".leave").map(l => [l.textContent, l.title]), [["Médico", "Médico: 1h"]]);

  page.run("renderOverview(buildWeeks(4))");
  const cols = doc.getElementById("overviewChart").children[0].children.filter(g => g.tagName === "G");
  assert.ok(cols[2].children.some(c => (c.getAttribute("class") || "") === "rest"));
  assert.deepEqual(hover(page, cols[1]).slice(-1), ["Vacaciones toda la semana"]);
  assert.deepEqual(hover(page, cols[2]).slice(1, 4), ["Total 41h 15m", "Trabajo 41h", "Descanso 15m"]);
  assert.equal(hover(page, cols[2]).at(-1), "Sobre objetivo +2h 15m");
  assert.equal(hover(page, cols[3]).at(-1), "Para el objetivo 29h 45m");
});

test("the fixes strip pans by dragging, and a plain press or a name link is left alone", async () => {
  const page = load({ entry: "team.js", data: teamPayload() });
  await settle();
  const scroller = page.document.getElementById("fixes");
  const on = type => scroller.listeners[type][0];
  const target = link => ({ closest: () => link ? {} : null });
  scroller.scrollLeft = 500;
  on("pointermove")({ clientX: 10 });
  on("pointerdown")({ button: 2, target: target(false), clientX: 100 });
  on("pointerdown")({ button: 0, target: target(true), clientX: 100 });
  on("pointermove")({ clientX: 10 });
  assert.equal(scroller.scrollLeft, 500);
  on("pointerdown")({ button: 0, target: target(false), clientX: 100, pointerId: 1 });
  on("pointermove")({ clientX: 102 });
  assert.deepEqual([scroller.scrollLeft, scroller.classList.contains("dragging")], [500, false]);
  on("pointermove")({ clientX: 60 });
  on("pointermove")({ clientX: 40 });
  assert.deepEqual([scroller.scrollLeft, scroller.classList.contains("dragging")], [560, true]);
  on("pointerup")();
  assert.equal(scroller.classList.contains("dragging"), false);
  on("pointermove")({ clientX: 0 });
  assert.equal(scroller.scrollLeft, 560);
  scroller.listeners.pointercancel[0]();
});

test("a tooltip also opens on keyboard focus and closes on blur", () => {
  const page = load({ entry: "team.js" });
  const node = page.document.createElement("div");
  page.run("attachTip").call(null, node, tip => tip.appendChild(page.run("el('div', 't-title', 'Hola')")));
  node.listeners.focus[0]();
  const tip = page.document.getElementById("tip");
  node.listeners.pointermove[0]({ clientX: 40, clientY: 50 });
  assert.deepEqual([tip.style.left, tip.style.top], ["54px", "64px"]);
  assert.equal(tip.style.display, "block");
  assert.equal(tip.children[0].textContent, "Hola");
  node.listeners.blur[0]();
  assert.equal(tip.style.display, "none");
});

test("a punch that goes through reloads and checks the alarms", async () => {
  const today = new Date();
  let punched = false;
  const page = load({ fetchImpl: async (url, opts) => {
    if (opts?.method === "POST") { punched = true; return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => payload(punched ? [session(at(today, 9), at(today, 10))] : [session(at(today, 9), null)]) };
  } });
  await page.run("loadAndRender()");
  const hero = page.document.getElementById("hero");
  const button = hero.querySelectorAll(".btn").find(b => b.textContent === "Fichar salida");
  await button.listeners.click[0]();
  await button.listeners.click[0]();
  assert.equal(punched, true);
  assert.deepEqual(hero.querySelectorAll(".btn").map(b => b.textContent), ["Fichar entrada"]);
  assert.equal(hero.querySelector(".err").textContent, "");
});

test("failed reloads from a returning tab, a new day or a prefetch stay quiet", async () => {
  let down = false;
  const page = load({ fetchImpl: async () => {
    if (down) throw new Error("sin red");
    return { ok: true, status: 200, json: async () => payload([]) };
  } });
  await page.run("loadAndRender()");
  down = true;
  page.run("store.loadedAt = 0; store.triedAt = 0");
  page.document.listeners.visibilitychange[0]();
  page.run("setClock(new Date(Date.now() - 864e5))");
  page.document.listeners.visibilitychange[0]();
  await settle();
  assert.equal(page.run("isoDay(store.today)"), page.run("isoDay(new Date())"));
  const urls = [];
  const team = load({ entry: "team.js", fetchImpl: async url => {
    urls.push(url);
    if (url.startsWith("/api/team?week=")) throw new Error("sin red");
    return { ok: true, status: 200, json: async () => url.includes("fixes") ? teamFixes() : teamPayload() };
  } });
  await settle();
  assert.ok(urls.some(url => url.startsWith("/api/team?week=")));
  assert.equal(team.document.getElementById("gridCard").classList.contains("hidden"), false);
});

test("the dashboard's texts in their other cases", () => {
  const monday = new Date(2026, 8, 14), last = new Date(2026, 8, 7);
  const on = (base, days, h, m = 0) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, h, m);
  const page = withData([
    session(on(last, 0, 20), on(last, 2, 8)),
    session(on(last, 3, 21), on(last, 4, 1)),
    session(on(monday, 0, 8), on(monday, 0, 16, 30)),
    session(on(monday, 1, 8), on(monday, 1, 8, 15), true),
    session(on(monday, 1, 8, 15), null),
  ]);
  const text = code => page.run(code);
  const past = new Date(TUESDAY.getTime() - 3600e3).getTime();
  assert.match(text(`punchText({ at: new Date(${past}), out: new Date(), rest: true })`), /^Fin del descanso a las 09:00 · hace /);
  assert.match(text(`punchText({ at: new Date(${past}), out: null, rest: true, open: true })`), /^En descanso desde las 09:00 · llevas /);
  const headline = code => text(`heroHeadline(${code}).children.map(c => c.textContent)`);
  assert.deepEqual(headline(`{ expected: 0, vacation: true, auto: "Festivo", leaves: [], hours: 0 }, 0, 0, null, 0`).slice(0, 3), ["Hoy", "Sin jornada", "Festivo"]);
  assert.deepEqual(headline(`{ expected: 8, hours: 8, leaves: [] }, 0, 0, null, 0`).slice(0, 3), ["Hoy", "Jornada cumplida", "justo en las 8h previstas"]);

  page.run("renderHero()");
  const hero = page.document.getElementById("hero");
  assert.ok(hero.querySelectorAll(".note").some(n => n.textContent === "Descanso fichado hoy: 15m"));
  page.run(`store.absMap = new Map([["2026-09-15", "Festivo"]]); renderHero()`);
  assert.ok(hero.querySelectorAll(".note").some(n => /^Mar 15 sep · Festivo · /.test(n.textContent)));
  assert.equal(hero.querySelectorAll(".btn").find(b => b.textContent === "Fichar salida").classList.contains("pulse"), false);
  page.run(`store.absMap = new Map(); store.expected = [0.5, 0.25, 0, 0, 0, 0, 0]; renderHero()`);
  assert.ok(hero.querySelectorAll(".meter-caption").some(c => /· objetivo alcanzado$/.test(c.children[0].textContent)));
  page.run(SCHEDULE);

  page.run("renderKpis([])");
  assert.equal(page.document.getElementById("kpis").children.length, 0);
  const tile = delta => text(`(() => { renderKpis([{ complete: true, target: 8, total: 8 + ${delta}, delta: ${delta}, error: false, days: [] }]);
    return document.getElementById("kpis").children[1].children[1].style.color; })()`);
  assert.deepEqual([tile(0), tile(-2), tile(2)], [undefined, "var(--destructive)", "var(--status-success)"]);

  page.run(`(() => { const ws = buildWeeks(3); Object.assign(ws[0], { offDays: 2, missedDays: 2, openDays: 2, delta: -3 });
    Object.assign(ws[1], { suspect: true, delta: -1 }); window.ws = ws; })()`);
  const host = page.document.getElementById("overviewChart");
  Object.assign(host, { scrollWidth: 1000, scrollLeft: 100, clientWidth: 200 });
  page.run("store.weekTarget = 40; renderOverview(window.ws)");
  assert.equal(host.scrollLeft, 100);
  const cols = host.children[0].children.filter(g => g.tagName === "G");
  const first = hover(page, cols[0]);
  assert.ok(["2 días con fichajes fuera de horario", "2 días sin fichar", "2 días con una entrada sin cerrar"].every(t => first.includes(t)));
  assert.equal(first.at(-1), "Bajo objetivo −3h");
  cols[1].listeners.pointerenter[0]({ clientX: 10, clientY: 10 });
  assert.equal(page.document.getElementById("tip").querySelectorAll(".v").at(-1).style.color, "var(--status-warning)");
  cols[1].listeners.pointerleave[0]();

  const card = page.document.getElementById("weekCal");
  page.run("calOffset = 0; calView = 'objetivo'; renderCalendar()");
  const today = card.querySelectorAll(".dayrow")[1];
  const tip = hover(page, today);
  assert.equal(tip[0], "Mar 15 sep · hoy");
  assert.ok(tip.includes("08:15 – … 1h 45m en curso"));
  assert.ok(tip.includes("08:00 – 08:15 · descanso 15m"));
  page.run(`store.absMap = new Map([["2026-09-14", "Festivo"]]); calView = 'horario'; renderCalendar()`);
  const rows = card.querySelectorAll(".tl-row");
  assert.deepEqual(rows.slice(0, 2).map(r => ["today", "vac"].filter(c => r.classList.contains(c))), [["vac"], ["today"]]);
  const open = rows[1].querySelectorAll(".sess").find(s => !s.classList.contains("rest"));
  assert.deepEqual(hover(page, open).slice(0, 2), ["Mar 15 sep · 08:15 – en curso", "Trabajo 1h 45m"]);
  page.run("store.absMap = new Map(); calOffset = 1; renderCalendar()");
  const long = card.querySelectorAll(".tl-row")[0].querySelectorAll(".sess")[0];
  assert.ok(hover(page, long).includes("Termina 2 días después"));
  page.run("renderErrors()");
  const banner = page.document.getElementById("errorsBanner");
  const items = banner.children[0].children[2].children.map(li => bannerLine(li.children[0]));
  assert.ok(items.includes("Lun 7 sep 2026 · Jornada de 36h"));
  assert.ok(items.includes("Jue 10 sep 2026 · Fuera de horario 21:00 – 01:00 (+1)"));
  page.run(`store.data.sessions = [${JSON.stringify(session(on(last, 3, 21), on(last, 4, 1)))}]; store.expected = [0, 0, 0, 0, 0, 0, 0]; indexSessions(); renderErrors()`);
  assert.equal(banner.querySelectorAll("h2")[0].textContent, "⚠ 1 fichaje por corregir");
  page.run(SCHEDULE);
  page.run(`store.data.sessions = [${["0,8,0,16,30", "1,8,0,16,30", "2,8,0,16,30", "3,8,0,16,30", "4,8,0,13,0"].map(v => {
    const [d, h1, m1, h2, m2] = v.split(",").map(Number);
    return JSON.stringify(session(on(last, d, h1, m1), on(last, d, h2, m2)));
  }).join(",")}]; indexSessions(); calOffset = 1; renderCalendar(); renderTable(buildWeeks(2))`);
  assert.equal(card.querySelectorAll(".badge")[0].textContent, "▼ −1h vs 40h");
  assert.ok(page.document.getElementById("tableView").querySelectorAll("td").some(td => td.classList.contains("down")));
  page.run(`store.data.sessions.at(-1).out = "${on(last, 4, 14).toISOString()}"; store.data.sessions.at(-1).hours = 6; indexSessions(); renderCalendar()`);
  assert.equal(card.querySelectorAll(".badge")[0].textContent, "+0h vs 40h");
  page.run("setRangeMonths(1); renderAll(); setRangeMonths(0); renderAll()");
  page.run(`store.since = "2026-09-14"`);
  assert.deepEqual(page.run("buildWeek(1).days.map(d => d.expected)"), [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(page.run("buildWeek(0).target"), 40);
  page.run(`store.since = ""`);
  page.run(`store.data.sessions = [${JSON.stringify(session(on(last, 0, 8), on(last, 0, 9)))}, ${JSON.stringify(session(on(last, 0, 10), on(last, 0, 23)))}];
    store.expected = [0, 0, 0, 0, 0, 0, 0]; indexSessions(); renderErrors()`);
  assert.equal(bannerLine(banner.children[0].children[2].children[0].children[0]), "Lun 7 sep 2026 · Jornada de 14h en 2 sesiones");
});

test("the alarms, the loader and the tooltip in their other cases", async () => {
  const audio = fakeAudio();
  const page = load({ globals: { window: { webkitAudioContext: audio.window.AudioContext } } });
  page.run("checkAlarms()");
  page.document.listeners.pointerdown[0]();
  await settle();
  assert.equal(audio.made.length, 1);
  const lunch = new Date(Date.now() - 40 * 60000).toISOString();
  page.run(`store.data = ${JSON.stringify(payload([]))}; store.state = { ...store.data.state, lunch: "${lunch}" }; ${SCHEDULE}`);
  page.run("setClock(new Date()); store.expected = [8, 8, 8, 8, 8, 8, 8]; checkAlarms(); checkAlarms(); LastRing.lunch = 0; checkAlarms()");
  assert.equal(audio.made[0].oscillators.length, 6);
  assert.equal(page.calls.timers.filter(([, ms]) => ms === 900).length, 1);
  const since = new Date(Date.now() - 3600e3).toISOString();
  page.run("store.state.break_minutes = 0");
  assert.equal(page.run(`notifyStatus({ rest: true, in: "${since}" }, { expected: 8 }, 0)`), "En descanso · sin aviso configurado");
  page.run("NotifiedAt = 0");
  assert.match(page.run(`notifyStatus({ in: "${since}" }, { expected: 8 }, 0)`), /siguiente en menos de 1 min$/);
  page.run("NotifiedAt = Date.now()");
  assert.match(page.run(`notifyStatus({ in: "${since}" }, { expected: 8 }, 0)`), /siguiente en 2 min$/);

  const bare = { ...payload([]) };
  delete bare.state;
  delete bare.absences;
  const loader = load({ fetchImpl: async url => url === "/api/boom"
    ? { ok: false, status: 500, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => bare } });
  loader.run(`store.state = ${JSON.stringify(payload([]).state)}`);
  await loader.run("loadAndRender()");
  assert.equal(loader.run("store.state.lunch_minutes"), 30);
  assert.equal(loader.run("store.absMap.size"), 0);
  await assert.rejects(loader.run("api('/api/boom')"), /HTTP 500/);
  loader.run("setClock(new Date(Date.now() - 864e5)); tick()");
  assert.equal(loader.run("isoDay(store.today)"), loader.run("isoDay(new Date())"));
  const seg = loader.document.getElementById("rangeSeg");
  const all = loader.document.createElement("button"), one = loader.document.createElement("button");
  all.dataset.months = "all";
  one.dataset.months = "1";
  seg.listeners.click[0]({ target: { closest: () => null }, currentTarget: seg });
  seg.listeners.click[0]({ target: { closest: () => all }, currentTarget: seg });
  assert.equal(loader.run("rangeMonths"), 0);
  seg.listeners.click[0]({ target: { closest: () => one }, currentTarget: seg });
  assert.equal(loader.run("rangeMonths"), 1);

  const a = page.document.createElement("div"), b = page.document.createElement("div");
  for (const node of [a, b]) page.run("attachTip").call(null, node, () => {});
  const tip = page.document.getElementById("tip");
  a.listeners.pointerenter[0]({ clientX: 1275, clientY: 795 });
  assert.deepEqual([tip.style.left, tip.style.top], ["1261px", "781px"]);
  b.listeners.blur[0]();
  assert.equal(tip.style.display, "block");
  a.listeners.pointerleave[0]();
  assert.equal(tip.style.display, "none");
});

test("the management cells, charts and controls in their other cases", async () => {
  const page = load({ entry: "team.js", data: teamPayload() });
  await settle();
  const doc = page.document;
  const probe = code => {
    page.run(`document.getElementById("probe").replaceChildren(${code})`);
    return doc.getElementById("probe").children[0];
  };
  const limits = "{ long_day: 12, under_margin: 1 / 60, over_margin: 5, work_from: 7.5, work_to: 20 }";
  const day = (date, extra = "") => `{ date: "${date}", hours: 0, target: 8, absence: null, sessions: [], flags: [], requests: [] ${extra} }`;
  assert.equal(probe(`dayCell({}, ${day("2099-01-01")}, "2026-01-01", ${limits})`).classList.contains("future"), true);
  const days = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08"];
  const week = `{ monday: "2026-03-02", hours: 0, target: null, balance: null, flags: [] }`;
  const employee = `{ id: 1, name: "Ana", weeks: [${week}], days: [${days.map((d, i) => day(d, i < 2 ? ', flags: ["empty"]' : "")).join(",")}] }`;
  const cell = probe(`weekCell(${employee}, 0, "2026-03-04", ${limits})`);
  assert.equal(cell.classList.contains("today"), true);
  assert.ok(cell.children.some(c => c.textContent === "2 días con errores de fichaje"));
  assert.deepEqual(hover(page, cell), ["Saldo de la semana, día a día", "Ningún día cerrado con jornada prevista"]);
  const month = probe(`monthCell({ hours: 10, target: 20, balance: -10, weeks: [] }, { stop: "2026-04-01", limits: ${limits} }, "2026-05-01")`);
  assert.deepEqual(hover(page, month).slice(-1), ["Solo los días del mes −10h"]);
  const running = probe(`monthCell({ hours: 10, target: 20, balance: -10, weeks: [] }, { stop: "2026-04-01", limits: ${limits} }, "2026-03-15")`);
  assert.deepEqual(hover(page, running).slice(-1), ["Días del mes hasta ayer −10h"]);
  const yearMonth = m => probe(`yearMonthCell({}, { month: "2026-01", hours: 1, target: 1, under: 0, over: 0, flagged_days: 0, ${m} }, "2026-06-01", ${limits})`);
  assert.equal(yearMonth("balance: -2").classList.contains("bad"), true);
  assert.deepEqual(["bad", "warn"].map(c => yearMonth("balance: 0").classList.contains(c)), [false, false]);
  assert.equal(yearMonth("balance: 0, flagged_days: 2").classList.contains("warn"), true);
  assert.equal(page.run(`team.year = "2020"; Views.year.anchor()`), "2020-01-01");
  assert.equal(page.run(`team.year = thisDay().slice(0, 4); Views.year.anchor()`), page.run("thisDay()"));
  assert.match(page.run(`team.week = null; team.view = "week"; stateHash()`), /^#v=week&p=&/);
  page.run(`team.fixes = { ...team.fixes, employees: [{ id: 5, name: "Uno", archived: false, items: [
    { date: "2025-03-04", kind: "long", hours: 13, target: 8, sessions: [{ in: "2025-03-04T08:00:00", out: "2025-03-04T21:00:00", hours: 13 }] }] }] }; renderFixes()`);
  const chips = () => doc.getElementById("fixes").children[0].children.flatMap(c => c.children || []).map(k => k.textContent);
  assert.ok(chips().includes("1 jornada muy larga · 13h"));
  page.run("team.fixes.employees[0].items.push({ ...team.fixes.employees[0].items[0], date: '2025-03-05' }); renderFixes()");
  assert.ok(chips().includes("2 jornadas muy largas · 26h"));
  page.run(`team.view = "month"; periods({ employees: [] }, [], "2026-01-01")`);
  page.run(`team.view = "week"; renderCharts({ ...team.data, stop: "2000-01-01" }, team.data.employees, "2026-01-01")`);
  assert.doesNotMatch(doc.getElementById("charts").children[0].children[1].textContent, /hasta ayer/);
  page.run(`renderCharts({ ...team.data, stop: "2999-01-01" }, team.data.employees, "2026-01-01")`);
  assert.match(doc.getElementById("charts").children[0].children[1].textContent, /hasta ayer: hoy aún no cuenta/);
  const columns = probe(`groupedColumns([{ label: "L", values: { a: 1 } }], [{ key: "a", label: "Serie", cls: "error" }])`);
  assert.deepEqual(hover(page, columns.children.find(c => c.tagName === "G")), ["L", "Serie 1"]);
  const views = doc.getElementById("viewSeg");
  page.run("team.data = null");
  const monthButton = doc.createElement("button");
  monthButton.dataset.view = "month";
  views.listeners.click[0]({ target: { closest: () => monthButton } });
  await settle();
  assert.equal(page.run("team.view"), "month");
  const scroller = doc.getElementById("fixes");
  const captured = [];
  scroller.setPointerCapture = id => captured.push(id);
  scroller.listeners.pointerdown[0]({ button: 0, target: { closest: () => null }, clientX: 5, pointerId: 7 });
  assert.deepEqual(captured, []);
  scroller.listeners.pointermove[0]({ clientX: 50 });
  assert.deepEqual(captured, [7]);
  scroller.listeners.pointerup[0]();
});

test("the name search ignores case and accents, reaches every list and is kept in the URL", async () => {
  const data = teamPayload();
  const page = load({ entry: "team.js", data, path: "/gestion#f=all&q=ZO" });
  const pick = withFilters(page);
  await settle();
  const doc = page.document;
  const names = () => doc.getElementById("grid").children[1].children.map(rowName);
  const fixed = () => doc.getElementById("fixes").children[0].children.filter(c => c.tagName === "A").map(a => a.textContent);
  assert.equal(doc.getElementById("search").value, "ZO");
  assert.deepEqual(names(), ["Zoe"]);
  assert.deepEqual(fixed(), ["Zoe"]);
  const search = doc.getElementById("search");
  search.listeners.input[0]({ target: { value: "BRÚNO" } });
  assert.deepEqual([names(), fixed()], [["Bruno"], ["Bruno"]]);
  search.listeners.input[0]({ target: { value: "alvaro" } });
  assert.deepEqual(names(), ["Álvaro"]);
  assert.match(page.calls.hash, /q=alvaro/);
  search.listeners.input[0]({ target: { value: "  nadie  " } });
  assert.equal(names()[0], "Nadie cuyo nombre contenga «nadie»");
  assert.deepEqual(fixed(), []);
  assert.match(doc.getElementById("fixesNote").textContent, /Nadie cuyo nombre contenga «nadie» con los tipos elegidos\.$/);
  assert.equal(doc.getElementById("openCard").classList.contains("hidden"), false);
  search.listeners.input[0]({ target: { value: "" } });
  assert.deepEqual(names(), ["Álvaro", "Ana", "Bruno", "Zoe"]);
  pick("issues");
  page.run("team.data = null");
  search.listeners.input[0]({ target: { value: "zo" } });
  assert.deepEqual([page.run("team.search"), fixed()], ["zo", ["Zoe"]]);
  page.run("team.fixes = null");
  search.listeners.input[0]({ target: { value: "" } });
});

test("the day dialog corrects punches and approves a request, with a second click each", async () => {
  const data = { ...teamPayload(), can_edit: true };
  const alvaro = data.employees.find(e => e.name === "Álvaro");
  const at = (d, h, m = 0) => new Date(2025, 2, d, h, m).toISOString();
  alvaro.days[0] = { ...alvaro.days[0], hours: 23.6, flags: ["long", "off"], sessions: [
    { id: 11, in: at(3, 8, 36), out: at(3, 15, 45), hours: 7.15 },
    { id: 12, in: at(3, 16, 7), out: at(4, 8, 34), hours: 16.45 },
    { id: 13, in: at(3, 16, 50), out: at(3, 17), hours: 0.17, rest: true }],
    requests: [{ id: 552, from: at(3, 8, 30), to: at(3, 17, 40), status: "pending", reason: "Salí a las 17:40", can_approve: true }] };
  const posts = [];
  let answer = { ok: true, status: 200, json: async () => ({ ok: true, lost_entry: at(4, 8, 34) }) };
  const page = load({ entry: "team.js", fetchImpl: async (url, opts) => {
    if (opts?.method === "POST") { posts.push([url, JSON.parse(opts.body)]); return answer; }
    return { ok: true, status: 200, json: async () => url.includes("fixes") ? teamFixes() : data };
  } });
  await settle();
  const doc = page.document;
  const cell = () => doc.getElementById("grid").children[1].children[0].children[1];
  cell().listeners.click[0]();
  const body = doc.getElementById("dayDialogBody");
  const note = () => doc.getElementById("dayDialogNote").textContent;
  const editor = () => body.children[1];
  const rows = () => editor().children.filter(c => c.className.startsWith("edit-row"));
  const inputs = i => rows()[i].children.filter(c => c.tagName === "INPUT");
  const buttons = () => editor().children.at(-1).children;
  const twice = async button => { await button.listeners.click[0](); await button.listeners.click[0](); await settle(); };
  assert.deepEqual(rows().map(r => r.className), ["edit-row", "edit-row warn", "edit-row"]);
  assert.deepEqual(inputs(1).map(i => i.value), ["16:07", "08:34"]);
  assert.ok(rows()[1].children.some(c => c.textContent === "salida el 4 mar 2025"));
  assert.ok(rows()[2].children.some(c => c.textContent === "descanso"));

  const save = buttons()[1];
  await save.listeners.click[0]();
  assert.equal(save.textContent, "¿Confirmar?");
  page.calls.timeouts.at(-1)[0]();
  assert.equal(save.textContent, "Guardar cambios");
  await twice(save);
  assert.equal(note(), "No hay cambios que guardar.");

  inputs(1)[1].value = "17:40";
  const close = doc.getElementById("dayDialogClose");
  const held = [];
  const cancel = e => { let refused = false; doc.getElementById("dayDialog").listeners.cancel[0]({ preventDefault: () => { refused = true; } }); held.push([close.disabled, refused]); };
  await buttons()[1].listeners.click[0]();
  const saving = buttons()[1].listeners.click[0]();
  cancel();
  await saving;
  await settle();
  cancel();
  assert.deepEqual(held, [[true, true], [false, false]]);
  assert.deepEqual(posts.at(-1), ["/api/team/attendance", { id: 12, check_in: at(3, 16, 7), check_out: at(3, 17, 40) }]);
  assert.equal(note(), "Guardado. La salida original, 4 mar 2025 a las 08:34, era probablemente la entrada de ese día: añádela allí.");
  assert.equal(doc.getElementById("dayDialog").open, true);

  answer = { ok: true, status: 200, json: async () => ({ ok: true, lost_entry: null }) };
  buttons()[0].listeners.click[0]();
  const fresh = rows().length - 1;
  inputs(fresh)[0].value = "08:34";
  await twice(buttons()[1]);
  assert.match(note(), /cada fichaje necesita entrada y salida$/);
  inputs(fresh)[1].value = "15:00";
  inputs(0)[0].value = "08:40";
  await twice(buttons()[1]);
  assert.deepEqual(posts.slice(-2), [
    ["/api/team/attendance", { id: 11, check_in: at(3, 8, 40), check_out: at(3, 15, 45) }],
    ["/api/team/attendance", { employee: 1, check_in: at(3, 8, 34), check_out: at(3, 15) }]]);
  assert.equal(note(), "Guardado.");

  const approve = () => body.children.find(c => c.textContent === "Aprobar solicitud");
  await twice(approve());
  assert.deepEqual(posts.at(-1), ["/api/team/approve", { id: 552 }]);
  assert.equal(note(), "Solicitud aprobada.");
  answer = { ok: false, status: 409, json: async () => ({ error: "no eres aprobador" }) };
  await twice(approve());
  assert.equal(note(), "No se pudo aprobar: no eres aprobador");

  const blame = page.run(`toBlame([{ in: "${at(3, 8, 36)}", out: "${at(3, 15, 45)}", hours: 7.15 },
    { in: "${at(3, 16, 7)}", out: "${at(4, 8, 34)}", hours: 16.45 }], team.fixes.limits).map(s => s.hours)`);
  assert.deepEqual(blame, [16.45]);
  const adding = page.run(`toBlame([{ in: "${at(3, 8)}", out: "${at(3, 14)}", hours: 6 }, { in: "${at(3, 12)}", out: "${at(3, 19)}", hours: 7 }],
    team.fixes.limits).length`);
  assert.equal(adding, 2);
  const open = `{ s: { id: 9, in: "${at(3, 9)}", out: null }, start: { value: "09:00" }, end: { value: VALUE } }`;
  assert.deepEqual(page.run(`punchChanges("2025-03-03", [${open.replace("VALUE", '""')}])`), []);
  assert.deepEqual(page.run(`punchChanges("2025-03-03", [${open.replace("VALUE", '"14:00"')}])`),
    [{ id: 9, check_in: at(3, 9), check_out: at(3, 14) }]);
  answer = { ok: true, status: 200, json: async () => ({ ok: true }) };
  data.employees = data.employees.filter(e => e !== alvaro);
  inputs(0)[0].value = "08:45";
  await twice(buttons()[1]);
  assert.equal(note(), "Guardado.");
});

test("a mark in the fixes strip opens its day to correct it, unless it ends a drag", async () => {
  const urls = [];
  let down = false;
  const page = load({ entry: "team.js", fetchImpl: async url => {
    urls.push(url);
    if (down && url.includes("week=")) throw new Error("sin red");
    return { ok: true, status: 200, json: async () => url.includes("fixes") ? teamFixes() : teamPayload() };
  } });
  await settle();
  const doc = page.document;
  const dialog = doc.getElementById("dayDialog");
  const zoe = doc.getElementById("fixes").children[0].children.slice(3)[2];
  const marks = zoe.children.filter(c => c.tagName === "G");
  const scroller = doc.getElementById("fixes");
  const on = type => scroller.listeners[type][0];
  on("pointerdown")({ button: 0, target: { closest: () => null }, clientX: 100 });
  on("pointermove")({ clientX: 40 });
  on("pointerup")();
  await marks[0].listeners.click[0]();
  assert.equal(dialog.open, false);
  on("pointerdown")({ button: 0, target: { closest: () => null }, clientX: 100 });
  on("pointerup")();
  page.run(`team.fixes.employees[0].items[0].date = "2025-03-03"; renderFixes()`);
  const first = doc.getElementById("fixes").children[0].children.slice(3)[2].children.filter(c => c.tagName === "G")[0];
  await first.listeners.click[0]();
  await settle();
  assert.ok(urls.includes("/api/team?week=2025-03-03"));
  assert.equal(dialog.open, true);
  assert.equal(doc.getElementById("dayDialogTitle").textContent, "Zoe");
  dialog.close();
  first.listeners.keydown[0]({ key: "Tab" });
  down = true;
  first.listeners.keydown[0]({ key: "Enter" });
  await settle();
  assert.equal(dialog.open, false);
  assert.equal(doc.getElementById("fixesNote").textContent, "No se pudo abrir ese día: sin red");
});

test("the personal page's punches to fix open the correcting dialog when the session may", async () => {
  const today = new Date();
  const back = n => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
  const errors = [session(at(back(10), 16), at(back(9), 8, 30))];
  const week = { ...teamPayload(), can_edit: true };
  const day = isoDate(back(10));
  week.employees[0] = { ...week.employees[0], id: 9, days: [{ ...week.employees[0].days[0], date: day }] };
  const urls = [];
  let down = false;
  const page = load({ path: "/empleado?id=9", fetchImpl: async url => {
    urls.push(url);
    if (url === "/api/team/attendance") {
      down = true;
      return { ok: true, status: 200, json: async () => ({ ok: true, lost_entry: null }) };
    }
    if (url.startsWith("/api/team")) {
      if (down) throw new Error("sin red");
      return { ok: true, status: 200, json: async () => week };
    }
    return { ok: true, status: 200, json: async () => payload(errors, { team: true, can_edit: true, employee_id: 3 }) };
  } });
  await page.run("loadAndRender()");
  const doc = page.document;
  const items = () => doc.getElementById("errorsBanner").children[0].children[2].children;
  const fix = items()[0].children[1];
  assert.equal(fix.textContent, "Corregir");
  await fix.listeners.click[0]();
  await settle();
  assert.ok(urls.includes(`/api/team?week=${day}`));
  const dialog = doc.getElementById("dayDialog");
  assert.equal(dialog.open, true);
  assert.equal(doc.getElementById("dayDialogTitle").textContent, "Zoe");
  const editor = doc.getElementById("dayDialogBody").children[1];
  editor.children.find(c => c.className === "edit-actions").children[0].listeners.click[0]();
  const added = editor.children.filter(c => c.className === "edit-row").at(-1).children.filter(c => c.tagName === "INPUT");
  [added[0].value, added[1].value] = ["09:00", "10:00"];
  const save = editor.children.find(c => c.className === "edit-actions").children[1];
  const loads = urls.filter(u => u.startsWith("/api/data")).length;
  await save.listeners.click[0]();
  await save.listeners.click[0]();
  await settle();
  assert.equal(urls.filter(u => u.startsWith("/api/data")).length, loads + 1);
  assert.equal(doc.getElementById("dayDialogNote").textContent, "Guardado.");
  down = false;
  doc.getElementById("dayDialogClose").listeners.click[0]();
  assert.equal(dialog.open, false);
  down = true;
  await fix.listeners.click[0]();
  await settle();
  assert.deepEqual([fix.textContent, fix.title], ["No se pudo abrir", "sin red"]);
  page.run("store.other = null; store.data.can_edit = false; renderErrors()");
  assert.equal(items()[0].children.length, 1);
  page.run("store.data.can_edit = true; renderErrors()");
  down = false;
  await items()[0].children[1].listeners.click[0]();
  await settle();
  assert.ok(urls.at(-1).startsWith("/api/team?week="));
});

test("someone's page shows the requests the viewer may approve, one line per day with its errors", async () => {
  const week = teamPayload();
  const urls = [];
  let down = false;
  const requests = [{ id: 552, from: new Date(2025, 2, 3, 8, 30).toISOString(), to: new Date(2025, 2, 3, 17, 40).toISOString(),
    status: "pending", reason: "Salí a las 17:40", can_approve: true },
    { id: 553, from: new Date(2025, 2, 4, 9).toISOString(), to: null, status: "pending", reason: "", can_approve: true }];
  const page = load({ path: "/empleado?id=3", fetchImpl: async url => {
    urls.push(url);
    if (url.startsWith("/api/team")) {
      if (down) throw new Error("sin red");
      return { ok: true, status: 200, json: async () => week };
    }
    return { ok: true, status: 200, json: async () => payload([], { team: true, requests }) };
  } });
  await page.run("loadAndRender()");
  const box = page.document.getElementById("errorsBanner");
  const lines = () => box.children[0].children[2].children;
  assert.deepEqual([box.classList.contains("hidden"), box.classList.contains("requests")], [false, true]);
  assert.equal(box.querySelectorAll("h2")[0].textContent, "2 solicitudes pendientes");
  assert.deepEqual(lines().map(li => bannerLine(li.children[0])),
    ["Mar 4 mar 2025 · Solicitud pendiente 09:00", "Lun 3 mar 2025 · Solicitud pendiente 08:30–17:40 · Salí a las 17:40"]);
  assert.deepEqual(lines().map(li => li.children[1].textContent), ["Revisar", "Revisar"]);
  await lines()[1].children[1].listeners.click[0]();
  await settle();
  assert.ok(urls.includes("/api/team?week=2025-03-03"));
  assert.equal(page.document.getElementById("dayDialogBody").children.some(c => c.className === "editor"), false);
  assert.equal(page.document.getElementById("dayDialog").open, true);
  down = true;
  await lines()[0].children[1].listeners.click[0]();
  await settle();
  assert.equal(lines()[0].children[1].textContent, "No se pudo abrir");
  page.run(`store.data.requests = store.data.requests.slice(0, 1); store.data.sessions = [${JSON.stringify(session(new Date(2025, 2, 3, 9), null))}];
    indexSessions(); renderErrors()`);
  assert.equal(box.querySelectorAll("h2")[0].textContent, "⚠ 1 fichaje por corregir · 1 solicitud pendiente");
  assert.equal(box.classList.contains("requests"), false);
  assert.equal(bannerLine(lines()[0].children[0]), "Lun 3 mar 2025 · Sin cerrar entrada a las 09:00, sin salida · Solicitud pendiente 08:30–17:40 · Salí a las 17:40");
  page.run("delete store.data.requests; store.data.sessions = []; indexSessions(); renderErrors()");
  assert.equal(box.classList.contains("hidden"), true);
});
