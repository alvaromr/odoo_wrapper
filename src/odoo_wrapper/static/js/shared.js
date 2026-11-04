/*
 * The basics both pages (the dashboard and the management view) build on, with no side effects on import: team.js
 * cannot import the dashboard's modules, which register listeners and read their own DOM as they load. The tooltip
 * (tip.js), the pan of a big box (pan.js) and the banner of a newer release (updates.js) are both pages' too, each in
 * its own module.
 *
 * - A failure the page deliberately rides out (a background poll, a reload retried later, storage the browser
 *   blocks) still leaves a trace: warned(what) is the handler that logs it to the console. Swallowed outright,
 *   a broken poll looked exactly like a quiet one.
 * - Any 401 sends the page to /login: the cookie is the Odoo session, and Odoo decides when it is dead.
 * - While any api() call is in flight the #loadbar at the top of the page runs: an Odoo load takes a
 *   second or two and the page looked frozen meanwhile. Background requests (the team page's prefetch,
 *   the state poll) use fetch directly and do not light it.
 * - The logout button posts /api/logout and goes to /login; on failure it says so and stays usable.
 * - The mouse's back and forward buttons walk the history (wireMouseHistory): Orca's embedded browser does
 *   not turn them into navigation as Chrome does, so going back from someone's page to the management view
 *   did nothing there. preventDefault keeps a browser that does navigate on them from moving twice.
 * - byId is getElementById for an element the page's HTML always holds: a missing one is a broken page, and it
 *   throws saying which, where getElementById's null failed later on an unrelated property. Code for an element
 *   a page may lack keeps getElementById and its null check.
 */
/**
 * @param {string} what
 * @returns {(error: unknown) => void}
 */
export function warned(what) {
  return (error) => console.warn(`[odoo] ${what} failed:`, error);
}

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
export function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`[odoo] the page has no #${id}`);
  return node;
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string | null} [cls]
 * @param {string | null} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

let Pending = 0;

/** @param {number} delta */
function loading(delta) {
  Pending += delta;
  byId("loadbar").classList.toggle("on", Pending > 0);
}

/**
 * @param {string} path
 * @param {object} [body]
 * @returns {Promise<unknown>} the server's JSON, whose shape each endpoint owns
 */
export async function api(path, body) {
  loading(1);
  try {
    const res = await fetch(
      path,
      body
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : undefined,
    );
    const json = await res.json();
    if (res.status === 401) location.replace("/login");
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  } finally {
    loading(-1);
  }
}

/** @type {Object<number, number>} */
const MouseHistory = { 3: -1, 4: 1 };

export function wireMouseHistory() {
  addEventListener("mouseup", (e) => {
    if (!MouseHistory[e.button]) return;
    e.preventDefault();
    history.go(MouseHistory[e.button]);
  });
}

/** @param {HTMLButtonElement} button */
export function wireLogout(button) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api("/api/logout", {});
      location.replace("/login");
    } catch (err) {
      button.textContent = "Error al cerrar sesión";
      button.title = /** @type {Error} */ (err).message;
      button.disabled = false;
    }
  });
}
