/*
 * Talking to the dashboard server: the data load, the shared state, and when to reload.
 *
 * - A personal payload older than PersonalMaxAge is reloaded on the next clock tick while visible and as soon as
 *   the tab becomes visible again, which covers punches made from the CLI or Odoo's own web. A background tab
 *   does not poll Odoo.
 * - A failed load, the first one included, is retried no sooner than RetryAfter, whatever brings the page
 *   back (tick or tab focus): with Odoo down each open page costs one request a minute, and a page opened
 *   while Odoo is down comes up by itself once Odoo is back.
 * - Open pages keep up with each other: any punch stamps punched_at in the shared state, the other pages
 *   see it in their next /api/state poll and reload, so clocking in on the phone updates the laptop by
 *   itself. State writes render optimistically and roll back if the request fails, leaving why in the console.
 * - busy() treats an open tooltip (tip.js), an armed button or a focused duration field as "do not repaint now".
 */

import { LastRing } from "./alarms.js";
import { fmtDay, fmtTime } from "./format.js";
import { renderHero } from "./hero.js";
import { renderAll } from "./render.js";
import { api, byId, warned } from "./shared.js";
import { NoSchedule, PersonalMaxAge, RetryAfter, store } from "./store.js";
import { tipOpen } from "./tip.js";
import { indexSessions, setClock } from "./week.js";

/** @returns {boolean} */
export function busy() {
  return tipOpen() || Boolean(document.querySelector(".btn.arm, .actions .btn:disabled, .lunch-input:focus"));
}

/** @returns {boolean} */
export function stale() {
  return Date.now() - store.loadedAt > PersonalMaxAge && Date.now() - store.triedAt > RetryAfter;
}

/** @param {Partial<import("./store.js").SharedState>} changes */
export async function saveState(changes) {
  const previous = store.state;
  store.state = { ...store.state, ...changes };
  renderHero();
  try {
    const res = await fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    store.state = await res.json();
  } catch (e) {
    warned("saving the shared state")(e);
    store.state = previous;
  }
  renderHero();
}

export async function refreshState() {
  if (busy() || store.other) return;
  try {
    const res = await fetch("/api/state");
    if (!res.ok) return;
    const next = await res.json();
    if (next.punched_at !== store.state.punched_at) {
      await loadAndRender();
      return;
    }
    if (Object.keys(next).every((k) => next[k] === /** @type {Object<string, unknown>} */ (store.state)[k])) return;
    if (next.lunch !== store.state.lunch) LastRing.lunch = 0;
    store.state = next;
    renderHero();
  } catch (e) {
    warned("the shared state poll")(e);
  }
}

/** @param {boolean} [fresh] */
export async function loadAndRender(fresh) {
  store.triedAt = Date.now();
  const query = [store.other ? `employee=${store.other}` : "", fresh ? "fresh" : ""].filter(Boolean).join("&");
  const data = /** @type {import("./store.js").Payload} */ (await api(`/api/personal${query ? `?${query}` : ""}`));
  store.personal = data;
  store.loadedAt = Date.now();
  store.state = data.state || store.state;
  const schedule = data.schedule || NoSchedule;
  store.expected = schedule.hours;
  store.lunchFrom = schedule.lunch_from;
  store.weekTarget = store.expected.reduce((a, h) => a + h, 0);
  store.contractHours = new Map(Object.entries(data.contract_hours || {}));
  store.since = data.since || "";
  const absences = data.absences || [];
  store.absMap = new Map(
    absences.filter((a) => !a.hours).map((a) => /** @type {[string, string]} */ ([a.date, a.type])),
  );
  store.leaveMap = /** @type {import("./store.js").Leave[]} */ (absences.filter((a) => a.hours)).reduce(
    (m, a) => m.set(a.date, [...(m.get(a.date) || []), a]),
    /** @type {Map<string, import("./store.js").Leave[]>} */ (new Map()),
  );
  setClock(new Date(store.personal.generated_at));
  indexSessions();
  byId("title").textContent = store.personal.employee;
  byId("subtitle").textContent = `Odoo · actualizado el ${fmtDay(store.now)} a las ${fmtTime(store.now)}`;
  byId("teamLink").classList.toggle("hidden", !store.personal.team);
  byId("requestBtn").classList.toggle("hidden", Boolean(store.other));
  byId("loadmsg").classList.add("hidden");
  byId("app").classList.remove("hidden");
  renderHero();
  renderAll();
}

export function loadFirst() {
  loadAndRender().catch((e) => {
    byId("loadmsg").textContent = `Error cargando datos de Odoo: ${e.message}`;
  });
}
