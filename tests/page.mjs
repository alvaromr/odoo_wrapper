// The harness every page suite (tests/*.test.mjs) loads the pages with: each page's entry script (app.js,
// team.js, login.js) and every module it imports (recursively) run as classic scripts in one vm context,
// dependencies first, with a minimal DOM stand-in, fetch and timers replaced, so the logic (formats, weeks, gaps,
// alarms, day rollover) runs without a browser.
// Each module keeps its own file name and every byte offset of the file on disk: its import statements and
// `export` keywords are blanked out, not removed, so node's coverage maps back to the real lines. Scripts in
// one context share their top-level names, as the modules' imports did. Run the suites with
// `node --test tests/*.test.mjs`, and with coverage as AGENTS.md says.
// The clock is replaced too: Date starts every run at TUESDAY and ticks on from there, here and in the pages.
// With the real one the suite passed or failed, and covered every branch or not, by the day and the hour it ran:
// Thursdays, weekends, before nine, the days a fixture crossed a daylight-saving change, the last ones of a year.
// Under StrykerJS the context also gets __stryker__ with the mutant to switch on: its instrumented code looks for
// it on the global object, which in a vm context is the sandbox, not node's.
// The suites never reach the network: loading this file makes every socket connect throw, so a call left unmocked
// fails its test instead of reaching a real server.
// Below the harness are the fixtures more than one suite builds on: the personal payload, the management
// view's week and fixes, and the helpers that open and drive its page.

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

net.Socket.prototype.connect = () => {
  throw new Error("The page suites never reach the network: stub the call that tried to");
};

const TEMPLATES = new URL("../src/odoo_wrapper/templates/", import.meta.url);
const JS_DIR = new URL("js/", TEMPLATES);
export const JS_FILES = fs.readdirSync(JS_DIR).filter((name) => name.endsWith(".js"));
export const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*"\.\/([^"]+)";?\s*$/gm;

export function readModule(name) {
  return fs.readFileSync(new URL(name, JS_DIR), "utf8");
}

const blank = (text) => text.replace(/[^\n]/g, " ");

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

const THEME = { name: "theme.js", body: readModule("theme.js") };
const SOURCES = Object.fromEntries(["app.js", "team.js", "login.js"].map((name) => [name, [THEME, ...flatten(name)]]));
export const UP_TO_DATE = {
  available: false,
  current: "1.1.0",
  latest: "1.1.0",
  url: "https://github.com/r/releases/tag/v1.1.0",
  error: "",
};

function parseSelector(selector) {
  return selector
    .split(",")
    .map((part) => part.trim())
    .map((part) => {
      if (part.includes(":") || part.includes(" ")) return null;
      const m = part.match(/^([a-zA-Z][a-zA-Z0-9]*)?((?:\.[a-zA-Z0-9_-]+)*)$/);
      if (!m) return null;
      return { tag: m[1] ? m[1].toUpperCase() : null, classes: m[2] ? m[2].slice(1).split(".") : [] };
    });
}

function matchesSelector(node, parts) {
  return (
    Boolean(node) &&
    typeof node === "object" &&
    node.tagName &&
    parts.some((p) => p && (!p.tag || node.tagName === p.tag) && p.classes.every((c) => node.classList?.contains(c)))
  );
}

function queryAll(root, selector, out = []) {
  const parts = parseSelector(selector);
  (root.children || []).forEach((child) => {
    if (typeof child === "string") return;
    if (matchesSelector(child, parts)) out.push(child);
    queryAll(child, selector, out);
  });
  return out;
}

const Parents = new WeakMap();

export function element(tag = "div") {
  const classes = new Set();
  const e = {
    tagName: tag.toUpperCase(),
    children: [],
    attrs: {},
    listeners: {},
    dataset: {},
    style: {
      setProperty(name, value) {
        this[name] = value;
      },
    },
    textContent: "",
    innerHTML: "",
    title: "",
    hidden: false,
    disabled: false,
    open: false,
    value: "",
    type: "",
    min: 0,
    max: 0,
    step: 0,
    scrollLeft: 0,
    scrollWidth: 0,
    clientWidth: 0,
    get className() {
      return [...classes].join(" ");
    },
    set className(v) {
      classes.clear();
      for (const c of v.split(/\s+/).filter(Boolean)) classes.add(c);
    },
    classList: {
      add: (...c) => {
        for (const x of c) classes.add(x);
      },
      remove: (...c) => {
        for (const x of c) classes.delete(x);
      },
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : Boolean(force);
        on ? classes.add(c) : classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    appendChild(c) {
      e.children.push(c);
      return c;
    },
    append(...cs) {
      e.children.push(...cs);
    },
    prepend(...cs) {
      e.children.unshift(...cs);
    },
    insertBefore(c, ref) {
      e.children.splice(e.children.includes(ref) ? e.children.indexOf(ref) : e.children.length, 0, c);
      Parents.set(c, e);
      return c;
    },
    get nextElementSibling() {
      const all = Parents.get(e)?.children || [];
      return all[all.indexOf(e) + 1] || null;
    },
    replaceChildren(...cs) {
      e.children = cs;
    },
    remove() {},
    setAttribute(k, v) {
      e.attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in e.attrs ? e.attrs[k] : null;
    },
    removeAttribute(k) {
      delete e.attrs[k];
    },
    addEventListener(type, fn) {
      (e.listeners[type] ||= []).push(fn);
    },
    querySelector: (sel) => queryAll(e, sel)[0] || null,
    querySelectorAll: (sel) => queryAll(e, sel),
    closest: () => null,
    contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    focus() {},
    blur() {},
    select() {
      e.selected = true;
    },
    scrollIntoView() {},
    showModal() {
      e.open = true;
    },
    close() {
      e.open = false;
    },
  };
  return e;
}

function makeDocument() {
  const byId = new Map();
  return {
    title: "Fichajes",
    hidden: false,
    visibilityState: "visible",
    listeners: {},
    getElementById: (id) => byId.get(id) || byId.set(id, element("div")).get(id),
    createElement: (tag) => {
      const e = element(tag);
      Object.defineProperty(e, "id", {
        get: () => e._id,
        set: (v) => {
          e._id = v;
          byId.set(v, e);
        },
      });
      return e;
    },
    body: element("body"),
    documentElement: element("html"),
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
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
  };
}

export function memoryStorage(items = {}) {
  return {
    getItem: (key) => (key in items ? items[key] : null),
    setItem: (key, value) => {
      items[key] = String(value);
    },
  };
}

export function fakeAudio(refuse = false, state = "suspended") {
  const made = [];
  class AudioContext {
    constructor() {
      this.state = state;
      this.currentTime = 0;
      this.destination = {};
      made.push(this);
    }
    resume() {
      if (refuse) return Promise.reject(new Error("bloqueado"));
      this.state = "running";
      return Promise.resolve();
    }
    createOscillator() {
      const osc = {
        frequency: {},
        connect: (to) => to,
        start() {},
        stop() {
          osc.stopped = true;
        },
      };
      (this.oscillators ||= []).push(osc);
      return osc;
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (to) => to };
    }
  }
  return { made, window: { AudioContext } };
}

export function load({
  data = null,
  fetchImpl = null,
  entry = "app.js",
  path = "/",
  storage = null,
  local = memoryStorage(),
  globals = {},
} = {}) {
  const document = makeDocument();
  const calls = { fetch: [], replace: [], reload: 0, timers: [] };
  const sandbox = {
    document,
    window: fakeAudio().window,
    URLSearchParams,
    Date,
    innerWidth: 1280,
    innerHeight: 800,
    console: { ...console, warn: (...args) => (calls.warnings ||= []).push(args.map(String).join(" ")) },
    addEventListener: (type, fn) => ((calls.window ||= {})[type] ||= []).push(fn),
    history: {
      replaceState: (a, b, url) => {
        calls.hash = url;
      },
      pushState: (a, b, url) => {
        (calls.pushed ||= []).push(url);
        calls.hash = url;
      },
      go: (n) => (calls.went ||= []).push(n),
    },
    ...(storage ? { sessionStorage: storage } : {}),
    localStorage: local,
    location: {
      assign: (url) => (calls.assigned ||= []).push(url),
      hostname: "localhost",
      protocol: "http:",
      pathname: path.split(/[?#]/)[0],
      search: path.includes("?") ? path.slice(path.indexOf("?")).split("#")[0] : "",
      hash: path.includes("#") ? path.slice(path.indexOf("#")) : "",
      replace: (url) => calls.replace.push(url),
      reload: () => calls.reload++,
    },
    fetch:
      fetchImpl ||
      (async (url, opts) => {
        if (url === "/api/update") return { ok: true, status: 200, json: async () => UP_TO_DATE };
        calls.fetch.push([url, opts]);
        if (url.includes("fixes")) return { ok: true, status: 200, json: async () => teamFixes() };
        if (!data) throw new Error("sin datos");
        return { ok: true, status: 200, json: async () => data };
      }),
    setInterval: (fn, ms) => calls.timers.push([fn, ms]),
    clearInterval: () => {},
    setTimeout: (fn, ms) => (calls.timeouts ||= []).push([fn, ms]),
    clearTimeout: () => {},
    __stryker__: { activeMutant: process.env.__STRYKER_ACTIVE_MUTANT__ },
    ...globals,
  };
  const ctx = vm.createContext(sandbox);
  for (const { name, body } of SOURCES[entry])
    vm.runInContext(body, ctx, { filename: fileURLToPath(new URL(name, JS_DIR)) });
  const plain = (value) =>
    value && typeof value === "object" && typeof value.then !== "function" ? JSON.parse(JSON.stringify(value)) : value;
  const run = (code) => plain(vm.runInContext(code, ctx));
  return { run, document, calls };
}

export const at = (day, h, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
export const session = (start, end, rest = false) => ({
  in: start.toISOString(),
  out: end ? end.toISOString() : null,
  hours: end ? (end - start) / 3.6e6 : null,
  rest,
  reason: rest ? "Descanso" : "Normal",
});
export const payload = (sessions, extra = {}) => ({
  employee: "Ana",
  breaks: true,
  phone: null,
  generated_at: new Date().toISOString(),
  weeks: 12,
  sessions,
  absences: [],
  schedule: null,
  long_hours: 12,
  state: {
    lunch: null,
    lunch_minutes: 30,
    break_minutes: 15,
    lunch_button_from: 810,
    lunch_button_to: 960,
    muted: false,
    lunch_done: false,
    punched_at: null,
  },
  ...extra,
});

export const TUESDAY = new Date(2026, 8, 15, 10, 0);

export const RealDate = Date;
const CLOCK_SHIFT = TUESDAY - RealDate.now();
class Clock extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(RealDate.now() + CLOCK_SHIFT);
  }
  static now() {
    return RealDate.now() + CLOCK_SHIFT;
  }
}
globalThis.Date = Clock;

export const SCHEDULE =
  "store.expected = [8.5, 8.5, 8.5, 8.5, 6, 0, 0]; store.lunchFrom = [13.5, 13.5, 13.5, 13.5, null, null, null]; store.weekTarget = 40;";

export function withData(sessions, extra) {
  const page = load();
  page.run(`store.data = ${JSON.stringify(payload(sessions, extra))}; store.state = store.data.state; ${SCHEDULE}`);
  page.run(`setClock(new Date(${TUESDAY.getTime()})); indexSessions();`);
  return page;
}

export const settle = () => new Promise((resolve) => setImmediate(resolve));
export const Y25 = new Date().getFullYear() === 2025 ? "" : " 2025";
const WEEK_DAYS = ["2025-03-03", "2025-03-04", "2025-03-05", "2025-03-06", "2025-03-07", "2025-03-08", "2025-03-09"];
export const teamWeek = (changes = {}) =>
  WEEK_DAYS.map((date, i) => ({
    date,
    hours: i < 5 ? 8 : 0,
    target: i < 5 ? 8 : 0,
    absence: null,
    sessions: [],
    flags: [],
    requests: [],
    ...changes[i],
  }));
export const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const daysAgo = (n, h, m = 0) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, h, m);
};
export const withBalance = (p) => {
  for (const e of p.employees) if (e.balance === undefined) e.balance = e.target == null ? null : e.hours - e.target;
  for (const e of p.employees) e.due = e.target;
  return p;
};
export const fixLimits = { long_day: 12, under_margin: 1 / 60, over_margin: 5 };
export const teamFixes = () => ({
  generated_at: new Date().toISOString(),
  limits: fixLimits,
  employees: [
    {
      id: 3,
      name: "Zoe",
      items: [
        {
          date: "2025-02-20",
          kind: "open",
          hours: 0,
          target: 8,
          sessions: [{ in: new Date(2025, 1, 20, 8).toISOString(), out: null, hours: null }],
        },
        {
          date: isoDate(daysAgo(3, 0)),
          kind: "long",
          hours: 20,
          target: 8,
          sessions: [{ in: daysAgo(3, 8).toISOString(), out: daysAgo(2, 4).toISOString(), hours: 20 }],
        },
        { date: isoDate(daysAgo(5, 0)), kind: "empty", hours: 0, target: 8, sessions: [] },
      ],
    },
    {
      id: 4,
      name: "Bruno",
      items: [{ date: isoDate(daysAgo(11, 0)), kind: "empty", hours: 0, target: 8, sessions: [] }],
    },
  ],
});
export const teamPayload = () =>
  withBalance({
    week: "2025-03-03",
    generated_at: new Date(2025, 2, 10, 9, 5).toISOString(),
    limits: { long_day: 12, under_margin: 1 / 60, over_margin: 5 },
    reasons: [],
    employees: [
      {
        id: 3,
        name: "Zoe",
        hours: 40,
        target: 40,
        flags: [],
        days: teamWeek({
          0: {
            hours: 7.5,
            sessions: [
              {
                in: new Date(2025, 2, 3, 9).toISOString(),
                out: new Date(2025, 2, 3, 16, 30).toISOString(),
                hours: 7.5,
                rest: false,
              },
            ],
          },
        }),
      },
      {
        id: 1,
        name: "Álvaro",
        hours: 32,
        target: 40,
        flags: ["under"],
        pending: 1,
        days: teamWeek({
          1: {
            hours: 0,
            flags: ["empty"],
            requests: [
              {
                from: new Date(2025, 2, 4, 9).toISOString(),
                to: new Date(2025, 2, 4, 17, 40).toISOString(),
                status: "pending",
                reason: "Olvidé fichar",
              },
              { from: new Date(2025, 2, 4, 9).toISOString(), to: null, status: "refused", reason: "" },
            ],
          },
        }),
      },
      {
        id: 2,
        name: "Ana",
        hours: 30,
        target: null,
        flags: [],
        days: teamWeek({ 3: { hours: 0, target: 0, absence: "Vacaciones" } }),
      },
      { id: 4, name: "Bruno", hours: 46.5, target: 40, flags: ["over"], days: teamWeek() },
    ],
  });
export const cellText = (td) => td.children.map((c) => c.textContent).join("|");
export const rowName = (tr) => (tr.children[0].children[0] || tr.children[0]).textContent;
export const withFilters = (page) => {
  const seg = page.document.getElementById("filterSeg");
  for (const key of ["issues", "under", "over", "requests", "all"]) {
    const button = page.document.createElement("button");
    button.dataset.filter = key;
    seg.appendChild(button);
  }
  return (key) =>
    seg.listeners.click[0]({ target: { closest: () => seg.children.find((b) => b.dataset.filter === key) } });
};
export const texts = (box) =>
  box.children
    .map((c) => (c.children.length ? c.children.map((k) => k.textContent).join(" ") : c.textContent))
    .filter(Boolean);
export const bannerLine = (item) => item.children.map((c) => c.textContent ?? c).join("");
export const hover = (page, node) => {
  node.listeners.pointerenter[0]({ clientX: 10, clientY: 10 });
  const tip = page.document.getElementById("tip");
  const texts = tip.children.map((c) =>
    c.children.length ? c.children.map((k) => k.textContent).join(" ") : c.textContent,
  );
  node.listeners.pointerleave[0]();
  return texts.filter(Boolean);
};

export const MONDAY = new Date(2026, 8, 14, 10, 0);
export const HOUR = 3.6e6;

export function clockAt(start) {
  const clock = { now: start.getTime() };
  class Frozen extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(clock.now);
    }
    static now() {
      return clock.now;
    }
  }
  Frozen.set = (date) => {
    clock.now = date.getTime();
  };
  return Frozen;
}

export function dump(node, depth = 0) {
  const pad = "  ".repeat(depth);
  if (typeof node === "string") return `${pad}${JSON.stringify(node)}`;
  if (node.tagName === "SVG") return `${pad}svg paths=${node.children.length}`;
  const own = [
    ...Object.entries(node.attrs).map(([k, v]) => `${k}=${v}`),
    ...Object.entries(node.style)
      .filter(([, v]) => typeof v !== "function")
      .map(([k, v]) => `${k}:${v}`),
    ...(node.type ? [`type=${node.type}`] : []),
    ...(node.title ? [`title=${node.title}`] : []),
    ...(node.disabled ? ["disabled"] : []),
  ];
  if (node.tagName === "INPUT") {
    own.push(`value=${node.value}`);
    if (node.type === "number") own.push(`min=${node.min}`, `max=${node.max}`, `step=${node.step}`);
  }
  if (node.tabIndex !== undefined) own.push(`tabindex=${node.tabIndex}`);
  const head =
    node.tagName.toLowerCase() +
    (node._id ? `#${node._id}` : "") +
    (node.className ? `.${node.className.split(" ").join(".")}` : "") +
    (node.textContent ? ` ${JSON.stringify(node.textContent)}` : "") +
    (own.length ? ` [${own.join(" ")}]` : "");
  return [`${pad}${head}`, ...node.children.map((c) => dump(c, depth + 1))].join("\n");
}

export const answer =
  (body, status = 200) =>
  async () => ({ ok: status < 400, status, json: async () => body });

// The page with its payload already loaded on the clock `now`. Its first /api/data (the page's own load at
// boot) never answers, so a test decides when data arrives; `answers` says what other paths answer.
export function dashboard({
  sessions = [],
  extra = {},
  now = TUESDAY,
  schedule = SCHEDULE,
  answers = {},
  ...options
} = {}) {
  const Clock = clockAt(now);
  const data = payload(sessions, { generated_at: now.toISOString(), ...extra });
  const sent = [];
  const shared = { ...data.state };
  let booted = false;
  const fetchImpl = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : undefined;
    sent.push({ url, method: opts?.method, headers: opts?.headers && { ...opts.headers }, body });
    if (url === "/api/data" && !booted) {
      booted = true;
      return new Promise(() => {});
    }
    if (answers[url]) return answers[url](url, opts);
    if (url === "/api/update") return answer(UP_TO_DATE)();
    if (url.startsWith("/api/data")) return answer(data)();
    if (url === "/api/state") return answer(Object.assign(shared, body))();
    return answer({})();
  };
  const page = load({ fetchImpl, ...options, globals: { Date: Clock, ...options.globals } });
  page.run(`store.data = ${JSON.stringify(data)}; store.state = store.data.state; ${schedule}`);
  page.run(`setClock(new Date(${now.getTime()})); indexSessions();`);
  return { ...page, Clock, data, sent };
}

export const built = (page, expression) => {
  const probe = page.document.getElementById("probe");
  page.run(`document.getElementById("probe").replaceChildren(${expression}); 0`);
  return probe.children[0];
};
export const heroOf = (page) => {
  page.run("renderHero()");
  return page.document.getElementById("hero");
};
export const day = (page, changes = {}) => ({ ...page.run("buildWeek(0).days[1]"), ...changes });
export const iso = (date) => date.toISOString();
export const MIDNIGHT = new Date(2026, 8, 15, 0, 0);
export const mondayDone = session(at(MONDAY, 9), at(MONDAY, 17, 30));
export const now = (page) => page.Clock.now();
export const click = (page, id, target) => {
  const event = { target, currentTarget: page.document.getElementById(id) };
  page.document.getElementById(id).listeners.click[0](event);
  return event;
};

// An AudioContext that remembers every call, to compare the beep with its envelope.
export function recordingAudio(state = "running") {
  const made = [];
  class AudioContext {
    constructor() {
      this.state = state;
      this.currentTime = 100;
      this.destination = { name: "speakers" };
      this.oscillators = [];
      this.gains = [];
      this.resumed = 0;
      made.push(this);
    }
    resume() {
      this.resumed++;
      this.state = "running";
      return Promise.resolve();
    }
    createOscillator() {
      const osc = {
        frequency: {},
        connect(to) {
          osc.to = to;
          return to;
        },
        start(when) {
          osc.started = when;
        },
        stop(when) {
          osc.stopped = when;
        },
      };
      this.oscillators.push(osc);
      return osc;
    }
    createGain() {
      const calls = [];
      const gain = {
        calls,
        gain: {
          setValueAtTime: (value, when) => calls.push(["set", value, when]),
          exponentialRampToValueAtTime: (value, when) => calls.push(["ramp", value, when]),
        },
        connect(to) {
          gain.to = to;
          return to;
        },
      };
      this.gains.push(gain);
      return gain;
    }
  }
  return { made, window: { AudioContext } };
}

export const withAlarms = (options = {}) => {
  const audio = recordingAudio(options.audio);
  const page = dashboard({ ...options, globals: { window: audio.window, ...options.globals } });
  return Object.assign(page, { audio: audio.made[0] });
};
export const beeps = (page) => page.audio.oscillators.length / 3;
export const flashing = (page) => page.run("FlashTimer") !== null;
export const lunchedAt = (when) => `store.state.lunch = ${JSON.stringify(when.toISOString())}`;

export const rounded = (value) =>
  /^-?\d+(\.\d+)?$/.test(value) ? String(Math.round(Number(value) * 100) / 100) : value;
const PROPS = ["type", "title", "autocomplete", "rows", "href", "target", "rel", "value"];

export function show(node, depth = 0) {
  const pad = "  ".repeat(depth);
  if (typeof node === "string") return [`${pad}"${node}"`];
  let head = node.tagName.toLowerCase();
  if (node.id) head += `#${node.id}`;
  if (node.className) head += `.${node.className.replaceAll(" ", ".")}`;
  for (const key of PROPS) if (node[key]) head += ` ${key}=${node[key]}`;
  for (const [key, value] of Object.entries(node.attrs)) head += ` ${key}=${rounded(value)}`;
  if (node.disabled) head += " disabled";
  const text = node.textContent === "" || node.textContent == null ? "" : ` "${node.textContent}"`;
  return [pad + head + text, ...node.children.flatMap((child) => show(child, depth + 1))];
}

export const showAll = (nodes) => nodes.flatMap((node) => show(node));
export const teamPage = (options = {}) =>
  load({ entry: "team.js", data: teamPayload(), storage: memoryStorage(), ...options });
export const tipOf = (page) => page.document.getElementById("tip");

export const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
export const teamReply = (url) => reply(url.includes("fixes") ? teamFixes() : teamPayload());
export const answering = (route) => async (url, opts) => (await route(url, opts)) ?? teamReply(url);

export const LIMITS = { long_day: 12, under_margin: 1 / 60, over_margin: 5 };
export const siteReply = (json, ok = true, status = 200) => ({ ok, status, json: async () => json });
export const shift = (iso, days) => {
  const [y, m, d] = iso.split("-").map(Number);
  return isoDate(new Date(y, m - 1, d + days));
};
export const stamp = (iso, hour, minute = 0) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, hour, minute).toISOString();
};
export const punch = (date, from, to) => ({
  in: stamp(date, from),
  out: to == null ? null : stamp(date, to),
  hours: to == null ? null : to - from,
  rest: false,
});

export function site({ data, fixes = teamFixes(), path = "/gestion#f=all", ...rest }) {
  const urls = [];
  const fetchImpl = async (url) => {
    if (url === "/api/update") return siteReply(UP_TO_DATE);
    urls.push(url);
    if (url.includes("fixes")) return typeof fixes === "function" ? fixes(url) : siteReply(fixes);
    return typeof data === "function" ? data(url) : siteReply(data);
  };
  const page = load({ entry: "team.js", fetchImpl, path, ...rest });
  return { page, urls, doc: page.document };
}

export const segment = (page, id, attr, keys) => {
  const seg = page.document.getElementById(id);
  const stray = page.document.createElement("span");
  stray.textContent = "x";
  seg.appendChild(stray);
  for (const key of keys) {
    const button = page.document.createElement("button");
    button.dataset[attr] = key;
    seg.appendChild(button);
  }
  const click = (key) =>
    seg.listeners.click[0]({
      target: {
        closest: (selector) => (selector === "button" ? seg.children.find((b) => b.dataset[attr] === key) : null),
      },
    });
  return { seg, stray, click };
};
export const svgTexts = (node) =>
  (node.children || []).flatMap((c) =>
    typeof c === "string" ? [] : [...(c.tagName === "TEXT" ? [c.textContent] : []), ...svgTexts(c)],
  );
export const marksOf = (svg) => svg.children.filter((c) => c.tagName === "G");
export const shape = (nodes) => nodes.map((n) => `${n.tagName} ${n.className}`.trim());
export const tipClasses = (page, node) => {
  node.listeners.pointerenter[0]({ clientX: 10, clientY: 10 });
  const rows = page.document.getElementById("tip").children;
  assert.ok(rows.every((c) => c.tagName === "DIV"));
  const classes = rows.map((c) => c.className);
  node.listeners.pointerleave[0]();
  return classes;
};
export const drag = (scroller) => {
  const on = (type) => scroller.listeners[type][0];
  on("pointerdown")({ button: 0, target: { closest: () => null }, clientX: 100, clientY: 0 });
  on("pointermove")({ clientX: 40, clientY: 0 });
  on("pointerup")();
};
