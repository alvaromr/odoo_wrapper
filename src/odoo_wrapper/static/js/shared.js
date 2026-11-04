/*
 * What both pages (the dashboard and the management view) need, with no side effects on import: team.js
 * cannot import the dashboard's modules, which register listeners and read their own DOM as they load.
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
 * - The tooltip (#tip, styled in style.css) follows the pointer and also opens on keyboard focus. It is
 *   drawn by the page, not a title attribute, which showed nothing in Orca's embedded browser.
 * - panScroll lets a big box scroll by dragging, sideways and up and down, for a mouse that has no sideways
 *   wheel: a press that moves more than PanSlop pixels pans instead of clicking, and a press on a link is left
 *   alone. Touch is left to the browser, which already scrolls a box under a finger. The
 *   pointer is captured only once it pans: captured from the press, every click landed on the box instead
 *   of the thing under it, which then never opened. consume() tells a click handler that its press was a
 *   pan, once, so the drag does not also open what it ended on.
 * - wireUpdates asks the server (updates.py) on load and every hour whether GitHub holds a newer release, and
 *   shows the banner under the header with its notes. The server keeps GitHub's answer for hours, so the
 *   hourly poll costs GitHub nothing; a failed one leaves the banner as it was, and «Ajustes» (ui.js) says why
 *   when asked. How to install it follows the payload's how and local: on the machine itself, «Actualizar
 *   ahora» (a second click confirms, as punching does), which also updates the skills, waits for the restarted
 *   server to report the new version and reloads, unless the skills failed: then it stays, saying why and
 *   with the command to retry; the development install is told to use git; anywhere else, or without uv, the
 *   commands for the dashboard and the skills. While it installs the poll leaves the banner alone, so the button and its note stay.
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

/* ---------- tooltip ---------- */
const tip = () => byId("tip");
export function tipOpen() {
  return tip().style.display === "block";
}
/**
 * @param {string} k
 * @param {string | null} v
 * @returns {HTMLDivElement}
 */
export function tipRow(k, v) {
  const r = el("div", "t-row");
  r.appendChild(el("span", "k", k));
  r.appendChild(el("span", "v", v));
  return r;
}
/** @type {EventTarget | null} */
let TipOwner = null;

/**
 * Fills the tooltip's box when it opens.
 * @typedef {(box: HTMLElement) => void} TipBuilder
 */

/**
 * @param {TipBuilder} build
 * @param {number} x
 * @param {number} y
 * @param {EventTarget} owner
 */
function showTip(build, x, y, owner) {
  TipOwner = owner;
  tip().replaceChildren();
  build(tip());
  tip().style.display = "block";
  moveTip(x, y);
}
/**
 * @param {number} x
 * @param {number} y
 */
function moveTip(x, y) {
  const r = tip().getBoundingClientRect();
  let left = x + 14,
    top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  tip().style.left = `${left}px`;
  tip().style.top = `${top}px`;
}
/** @param {EventTarget} [owner] */
export function hideTip(owner) {
  if (owner && TipOwner !== owner) return;
  TipOwner = null;
  tip().style.display = "none";
}
const PanSlop = 3;

/**
 * A press on a pannable box: where it began and the box's scroll then.
 * @typedef {{x: number, y: number, left: number, top: number, moved: boolean, pointer: number}} Press
 */

/**
 * @param {HTMLElement} scroller
 * @returns {{consume: () => boolean}}
 */
export function panScroll(scroller) {
  let press = /** @type {Press | null} */ (null),
    panned = false;
  scroller.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.pointerType === "touch" || /** @type {Element} */ (e.target).closest("a")) return;
    press = {
      x: e.clientX,
      y: e.clientY,
      left: scroller.scrollLeft,
      top: scroller.scrollTop,
      moved: false,
      pointer: e.pointerId,
    };
    panned = false;
  });
  scroller.addEventListener("pointermove", (e) => {
    if (!press) return;
    const dx = e.clientX - press.x,
      dy = e.clientY - press.y;
    if (!press.moved && Math.hypot(dx, dy) > PanSlop) {
      press.moved = true;
      scroller.setPointerCapture?.(press.pointer);
      scroller.classList.add("dragging");
      hideTip();
    }
    if (!press.moved) return;
    scroller.scrollLeft = press.left - dx;
    scroller.scrollTop = press.top - dy;
  });
  const end = () => {
    panned = Boolean(press?.moved);
    press = null;
    scroller.classList.remove("dragging");
  };
  scroller.addEventListener("pointerup", end);
  scroller.addEventListener("pointercancel", end);
  return {
    consume: () => {
      const was = panned;
      panned = false;
      return was;
    },
  };
}

/* ---------- actualizaciones ---------- */
const UpdateEveryMs = 3600000;
const UpgradeCommand = "uv tool upgrade odoo-wrapper";
const PluginCommand = "claude plugin update odoo@odoo-wrapper";
const UpdateArmMs = 4000;
const RestartPollMs = 2000;
const RestartTries = 90;
let Installing = false;

/** @param {string} old */
async function restarted(old) {
  for (let i = 0; i < RestartTries; i++) {
    await new Promise((resolve) => setTimeout(resolve, RestartPollMs));
    try {
      const res = await fetch("/api/update");
      if (res.ok && (await res.json()).current !== old) return;
    } catch (e) {
      warned("waiting for the restarted dashboard")(e);
    }
  }
  throw new Error("el panel no ha vuelto en tres minutos: mira ~/.odoo_dashboard/dashboard.log");
}

/**
 * What /api/update answers (updates.py, plus whether the dashboard is on this machine and how it was installed).
 * @typedef {object} UpdateAnswer
 * @property {boolean} available
 * @property {string} current
 * @property {string} latest
 * @property {string} url
 * @property {string} [error]
 * @property {boolean} local
 * @property {string} how
 */

/**
 * @param {UpdateAnswer} answer
 * @param {HTMLElement} note
 * @returns {HTMLButtonElement}
 */
function installButton(answer, note) {
  const b = el("button", "btn primary small", "Actualizar ahora");
  b.type = "button";
  let armed = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  b.addEventListener("click", async () => {
    if (!armed) {
      b.textContent = `¿Instalar la ${answer.latest}?`;
      armed = setTimeout(() => {
        armed = null;
        b.textContent = "Actualizar ahora";
      }, UpdateArmMs);
      return;
    }
    clearTimeout(armed);
    armed = null;
    b.disabled = Installing = true;
    b.textContent = "Instalando…";
    note.textContent = "Puede tardar un minuto.";
    try {
      const { skills } = /** @type {{ skills: string }} */ (await api("/api/update", {}));
      note.textContent = "Instalada: reiniciando el panel…";
      await restarted(answer.current);
      if (!skills) {
        location.reload();
        return;
      }
      b.textContent = "Instalada";
      note.replaceChildren(
        `La ${answer.latest} ya funciona, pero las skills de Claude Code no se han actualizado ` +
          `(${skills}). Ejecuta `,
        el("code", null, PluginCommand),
        " y recarga esta página.",
      );
    } catch (e) {
      note.textContent = `No se pudo actualizar: ${/** @type {Error} */ (e).message}`;
      b.disabled = Installing = false;
      b.textContent = "Actualizar ahora";
    }
  });
  return b;
}

/**
 * @param {...(string | Node)} parts
 * @returns {HTMLParagraphElement}
 */
function line(...parts) {
  const p = el("p");
  p.append(...parts);
  return p;
}

/**
 * @param {UpdateAnswer} answer
 * @returns {HTMLDivElement}
 */
function installRow(answer) {
  const note = el("span", null, "");
  note.setAttribute("role", "status");
  const row = el("div", "update-actions");
  row.append(installButton(answer, note), note);
  return row;
}

/**
 * @param {UpdateAnswer} answer
 * @returns {HTMLParagraphElement}
 */
function handLine(answer) {
  if (answer.local && answer.how === "git") return line("Es la instalación de desarrollo: tráela con git.");
  return line(
    answer.local ? "No encuentro uv en este ordenador. " : "",
    "Para instalarla, ejecuta ",
    el("code", null, UpgradeCommand),
    " en una terminal del ordenador: el dashboard se reinicia solo.",
  );
}

/**
 * @param {UpdateAnswer} answer
 * @returns {UpdateAnswer}
 */
export function showUpdate(answer) {
  if (Installing) return answer;
  const banner = byId("updateBanner");
  banner.classList.toggle("hidden", !answer.available);
  if (answer.available) {
    const notes = el("a", null, "Novedades");
    notes.href = answer.url;
    notes.target = "_blank";
    notes.rel = "noopener";
    const auto = answer.local && answer.how === "auto";
    banner.replaceChildren(
      line(
        el("strong", null, `Hay una versión nueva, la ${answer.latest}`),
        ` (tienes la ${answer.current}). `,
        notes,
        ".",
      ),
      ...(auto
        ? [installRow(answer)]
        : [
            handLine(answer),
            line("Las skills de Claude Code se actualizan con ", el("code", null, PluginCommand), "."),
          ]),
    );
  }
  return answer;
}

export function wireUpdates() {
  const poll = () =>
    fetch("/api/update")
      .then((res) => res.ok && res.json())
      .then((answer) => answer && showUpdate(answer))
      .catch(warned("the update check"));
  poll();
  setInterval(poll, UpdateEveryMs);
}

/**
 * @param {HTMLElement | SVGElement} element
 * @param {TipBuilder} build
 */
export function attachTip(element, build) {
  const node = /** @type {HTMLElement} */ (element);
  node.addEventListener("pointerenter", (e) => showTip(build, e.clientX, e.clientY, node));
  node.addEventListener("pointermove", (e) => moveTip(e.clientX, e.clientY));
  node.addEventListener("pointerleave", () => hideTip(node));
  node.addEventListener("focus", () => {
    const r = node.getBoundingClientRect();
    showTip(build, r.left + r.width / 2, r.bottom, node);
  });
  node.addEventListener("blur", () => hideTip(node));
}
