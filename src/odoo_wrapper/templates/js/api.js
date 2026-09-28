/*
 * Talking to the dashboard server: the data load, the shared state, and when to reload.
 *
 * - Data older than DataMaxAge is reloaded on the next clock tick while visible and as soon as the tab
 *   becomes visible again, which covers punches made from the CLI or Odoo's own web. A background tab does
 *   not poll Odoo.
 * - A failed load, the first one included, is retried no sooner than RetryAfter, whatever brings the page
 *   back (tick or tab focus): with Odoo down each open page costs one request a minute, and a page opened
 *   while Odoo is down comes up by itself once Odoo is back.
 * - Open pages keep up with each other: any punch stamps punched_at in the shared state, the other pages
 *   see it in their next /api/state poll and reload, so clocking in on the phone updates the laptop by
 *   itself. State writes render optimistically and roll back if the request fails.
 */
import { store, NoSchedule, DataMaxAge, RetryAfter } from "./store.js";
import { api } from "./shared.js";
import { busy } from "./ui.js";
import { setClock, indexSessions } from "./week.js";
import { fmtDay, fmtTime } from "./format.js";
import { renderHero, renderAll } from "./render.js";
import { LastRing } from "./alarms.js";

export function stale() {
  return Date.now() - store.loadedAt > DataMaxAge && Date.now() - store.triedAt > RetryAfter;
}

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
    store.state = res.ok ? await res.json() : previous;
  } catch (e) {
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
    const keys = ["lunch", "lunch_minutes", "break_minutes", "muted", "lunch_done", "punched_at"];
    if (keys.every(k => next[k] === store.state[k])) return;
    if (next.lunch !== store.state.lunch) LastRing.lunch = 0;
    store.state = next;
    renderHero();
  } catch (e) {}
}

export async function loadAndRender(fresh) {
  store.triedAt = Date.now();
  const query = [store.other ? `employee=${store.other}` : "", fresh ? "fresh" : ""].filter(Boolean).join("&");
  const data = await api("/api/data" + (query ? `?${query}` : ""));
  store.data = data;
  store.loadedAt = Date.now();
  store.state = data.state || store.state;
  const schedule = data.schedule || NoSchedule;
  store.expected = schedule.hours;
  store.lunchFrom = schedule.lunch_from;
  store.weekTarget = store.expected.reduce((a, h) => a + h, 0);
  store.contractHours = new Map(Object.entries(data.contract_hours || {}));
  store.since = data.since || "";
  const absences = data.absences || [];
  store.absMap = new Map(absences.filter(a => !a.hours).map(a => [a.date, a.type]));
  store.leaveMap = absences.filter(a => a.hours)
    .reduce((m, a) => m.set(a.date, [...(m.get(a.date) || []), a]), new Map());
  setClock(new Date(store.data.generated_at));
  indexSessions();
  document.getElementById("title").textContent = store.data.employee;
  document.getElementById("subtitle").textContent =
    `Odoo · actualizado el ${fmtDay(store.now)} a las ${fmtTime(store.now)}`;
  document.getElementById("teamLink").classList.toggle("hidden", !store.data.team);
  document.getElementById("loadmsg").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  renderHero();
  renderAll();
}

export function loadFirst() {
  loadAndRender().catch(e => {
    document.getElementById("loadmsg").textContent = "Error cargando datos de Odoo: " + e.message;
  });
}
