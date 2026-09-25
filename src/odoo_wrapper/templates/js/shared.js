/*
 * What both pages (the dashboard and the management view) need, with no side effects on import: team.js
 * cannot import the dashboard's modules, which register listeners and read their own DOM as they load.
 *
 * - Any 401 sends the page to /login: the cookie is the Odoo session, and Odoo decides when it is dead.
 * - While any api() call is in flight the #loadbar at the top of the page runs: an Odoo load takes a
 *   second or two and the page looked frozen meanwhile. Background requests (the team page's prefetch,
 *   the state poll) use fetch directly and do not light it.
 * - The logout button posts /api/logout and goes to /login; on failure it says so and stays usable.
 * - The tooltip (#tip, styled in style.css) follows the pointer and also opens on keyboard focus. It is
 *   drawn by the page, not a title attribute, which showed nothing in Orca's embedded browser.
 */
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

let Pending = 0;

function loading(delta) {
  Pending += delta;
  document.getElementById("loadbar").classList.toggle("on", Pending > 0);
}

export async function api(path, body) {
  loading(1);
  try {
    const res = await fetch(path, body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : undefined);
    const json = await res.json();
    if (res.status === 401) location.replace("/login");
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  } finally {
    loading(-1);
  }
}

export function wireLogout(button) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api("/api/logout", {});
      location.replace("/login");
    } catch (err) {
      button.textContent = "Error al cerrar sesión";
      button.title = err.message;
      button.disabled = false;
    }
  });
}

/* ---------- tooltip ---------- */
const tip = () => document.getElementById("tip");
export function tipOpen() { return tip().style.display === "block"; }
export function tipRow(k, v) {
  const r = el("div", "t-row");
  r.appendChild(el("span", "k", k));
  r.appendChild(el("span", "v", v));
  return r;
}
let TipOwner = null;

function showTip(build, x, y, owner) {
  TipOwner = owner;
  tip().replaceChildren();
  build(tip());
  tip().style.display = "block";
  moveTip(x, y);
}
function moveTip(x, y) {
  const r = tip().getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  tip().style.left = left + "px";
  tip().style.top = top + "px";
}
export function hideTip(owner) {
  if (owner && TipOwner !== owner) return;
  TipOwner = null;
  tip().style.display = "none";
}
export function attachTip(node, build) {
  node.addEventListener("pointerenter", e => showTip(build, e.clientX, e.clientY, node));
  node.addEventListener("pointermove", e => moveTip(e.clientX, e.clientY));
  node.addEventListener("pointerleave", () => hideTip(node));
  node.addEventListener("focus", () => {
    const r = node.getBoundingClientRect();
    showTip(build, r.left + r.width / 2, r.bottom, node);
  });
  node.addEventListener("blur", () => hideTip(node));
}
