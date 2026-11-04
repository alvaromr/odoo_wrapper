/*
 * Boot and the clock: wires the controls, ticks every TickMs and rolls the day over. This is the only
 * script dashboard.html loads (type="module"); every other file is reached through its imports.
 *
 * - Every tick the page recomputes the time-dependent figures (elapsed, hours so far, remaining) from the
 *   data it already has, no Odoo call, and polls /api/state on its own server. It skips the repaint while a
 *   tooltip, an armed button or a duration field has focus (busy()), so a repaint never eats a click
 *   mid-confirmation. Whether to reload from Odoo is api.js's call (stale()).
 * - When the day rolls over (checked by that tick and whenever the tab becomes visible) it first repaints
 *   from the local clock, so today starts at 0 h at once, and only then reloads from Odoo: a page left open
 *   overnight used to keep yesterday's progress until a reload succeeded, which after a sleep with no
 *   network could be a long time.
 * - On localhost the page also polls /api/version and reloads itself when a source file changes.
 */

import { refreshNotifyNote, resetAlarms, stopFlash } from "./alarms.js";
import { loadAndRender, loadFirst, refreshState, stale } from "./api.js";
import { onDaySaved, wireDayDialog } from "./dayedit.js";
import { isoDay } from "./format.js";
import { punchText, renderHero } from "./hero.js";
import { openRequest, renderAll, setRangeMonths } from "./render.js";
import { byId, warned, wireLogout, wireMouseHistory, wireUpdates } from "./shared.js";
import { LOOPBACK, store, TickMs } from "./store.js";
import { busy, wireSettings } from "./ui.js";
import { indexSessions, setClock } from "./week.js";

store.other = location.pathname === "/empleado" ? new URLSearchParams(location.search).get("id") : null;

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  stopFlash();
  if (!store.data || newDay()) return;
  if (stale() && !busy()) loadAndRender().catch(warned("the reload on returning to the tab"));
});

/** @returns {boolean} */
function newDay() {
  const live = new Date();
  if (isoDay(live) === isoDay(store.today)) return false;
  resetAlarms();
  stopFlash();
  setClock(live);
  indexSessions();
  renderHero();
  renderAll();
  loadAndRender().catch(warned("the reload on a new day"));
  return true;
}

/* ---------- recarga sola al editar el código (solo en local) ---------- */
const ReloadPoll = 2000;
let SourceVersion = /** @type {string | null} */ (null);

async function checkSources() {
  if (busy()) return;
  try {
    const { version } = await (await fetch("/api/version")).json();
    if (SourceVersion === null) SourceVersion = version;
    else if (version !== SourceVersion) location.reload();
  } catch (e) {
    warned("the source version poll")(e);
  }
}

if (LOOPBACK.includes(location.hostname)) setInterval(checkSources, ReloadPoll);

/* ---------- reloj: refresca «faltan/llevas» sin recargar ---------- */
function tick() {
  if (!store.data) {
    if (stale() && document.visibilityState === "visible") loadFirst();
    return;
  }
  if (newDay()) return;
  const live = new Date();
  if (stale() && document.visibilityState === "visible" && !busy()) {
    loadAndRender().catch(warned("the reload of stale data"));
    return;
  }
  refreshState();
  if (!store.data.sessions.some((s) => !s.out)) {
    if (store.punchEv) /** @type {HTMLElement} */ (store.punchEl).textContent = punchText(store.punchEv);
    refreshNotifyNote();
    return;
  }
  if (busy()) return;
  store.now = live;
  indexSessions();
  renderHero();
  renderAll();
}
setInterval(tick, TickMs);

byId("rangeSeg").addEventListener("click", (e) => {
  const btn = /** @type {Element} */ (e.target).closest("button");
  if (!btn) return;
  setRangeMonths(btn.dataset.months === "all" ? 0 : Number(btn.dataset.months));
  for (const b of /** @type {HTMLElement} */ (e.currentTarget).querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b === btn));
  }
  renderAll();
});
byId("viewSeg").addEventListener("click", (e) => {
  const btn = /** @type {Element} */ (e.target).closest("button");
  if (!btn) return;
  for (const b of /** @type {HTMLElement} */ (e.currentTarget).querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b === btn));
  }
  byId("chartsView").classList.toggle("hidden", btn.dataset.view === "table");
  byId("tableView").classList.toggle("hidden", btn.dataset.view !== "table");
});

byId("refreshBtn").addEventListener("click", async (e) => {
  /** @type {HTMLButtonElement} */ (e.target).disabled = true;
  try {
    await loadAndRender(true);
  } finally {
    /** @type {HTMLButtonElement} */ (e.target).disabled = false;
  }
});

const requestBtn = byId("requestBtn");
requestBtn.addEventListener("click", () => openRequest(requestBtn));

wireLogout(/** @type {HTMLButtonElement} */ (byId("logoutBtn")));
wireMouseHistory();
wireUpdates();
wireDayDialog();
wireSettings();
onDaySaved(() => loadAndRender(true));

loadFirst();
