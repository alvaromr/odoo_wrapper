/*
 * DOM building blocks: elements, the break segments drawn inside a bar, the tooltip, the inline icons
 * (bell, QR) and the controls of the hero (duration field, punch button); busy() also lives here since it
 * reads the tooltip it owns.
 *
 * - Every punch button asks for confirmation in place: the first click arms it («¿Confirmar?») for four
 *   seconds, the second one punches. The server validates the real state and answers 409 on invalid
 *   actions; the error lands in the hero's error box. A punch that succeeds but is followed by a failed
 *   reload says so instead of claiming the punch itself failed, and leaves the button disabled since the
 *   punch went through and the next tick or tab focus will reload.
 * - The tooltip follows the pointer and also opens on keyboard focus; busy() treats an open tooltip, an
 *   armed button or a focused duration field as "do not repaint now".
 */
import { store, LunchMax } from "./store.js";
import { api, saveState, loadAndRender } from "./api.js";
import { checkAlarms } from "./alarms.js";

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function restSpans(sessions) {
  let before = 0;
  return sessions.flatMap(s => {
    const span = s.rest ? [{ from: before, to: before + s.hours }] : [];
    before += s.hours;
    return span;
  });
}

export function fillBar(bar, sessions, total) {
  for (const span of restSpans(sessions)) {
    const seg = el("div", "rest");
    seg.style.left = span.from / total * 100 + "%";
    seg.style.width = (span.to - span.from) / total * 100 + "%";
    bar.appendChild(seg);
  }
  return bar;
}

/* ---------- estado ocupado ---------- */
const tip = document.getElementById("tip");
export function busy() {
  return tip.style.display === "block"
    || Boolean(document.querySelector(".btn.arm, .actions .btn:disabled, .lunch-input:focus"));
}

/* ---------- tooltip ---------- */
export function tipRow(k, v) {
  const r = el("div", "t-row");
  r.appendChild(el("span", "k", k));
  r.appendChild(el("span", "v", v));
  return r;
}
let TipOwner = null;

function showTip(build, x, y, owner) {
  TipOwner = owner || null;
  tip.replaceChildren();
  build(tip);
  tip.style.display = "block";
  moveTip(x, y);
}
function moveTip(x, y) {
  const r = tip.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}
function hideTip(owner) {
  if (owner && TipOwner !== owner) return;
  TipOwner = null;
  tip.style.display = "none";
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

/* ---------- controles del hero ---------- */
export function minutesField(label, key, suffix) {
  const field = el("label", "duration");
  field.append(label + " ");
  const input = el("input", "lunch-input");
  input.type = "number";
  input.min = 0;
  input.max = LunchMax;
  input.step = 5;
  input.value = store.state[key];
  input.setAttribute("aria-label", `Minutos de ${label.toLowerCase()}`);
  input.addEventListener("change", () => {
    saveState({ [key]: Math.min(LunchMax, Math.max(0, Math.round(Number(input.value) || 0))) });
  });
  field.appendChild(input);
  field.append(" min" + suffix);
  return field;
}

function icon(shapes) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24", width: 15, height: 15, fill: "none", stroke: "currentColor",
    "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(k, v);
  for (const d of shapes) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

export function bellIcon(muted) {
  return icon([
    "M10.3 21a2 2 0 0 0 3.4 0",
    "M3.3 15.3A1 1 0 0 0 4 17h16a1 1 0 0 0 .7-1.7C19.4 14 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.4 6-2.7 7.3",
    ...(muted ? ["M3 3l18 18"] : []),
  ]);
}

export function qrIcon() {
  return icon([
    "M3 3h5v5H3z", "M16 3h5v5h-5z", "M3 16h5v5H3z",
    "M21 16h-3a2 2 0 0 0-2 2v3", "M21 21v.01", "M12 7v3a2 2 0 0 1-2 2H7",
    "M3 12h.01", "M12 3h.01", "M12 16v.01", "M16 12h1", "M21 12v.01", "M12 21v-1",
  ]);
}

export function actionButton(cls, label, action, errBox) {
  const b = el("button", `btn ${cls}`, label);
  let armed = null;
  b.addEventListener("click", async () => {
    if (!armed) {
      const hadPulse = b.classList.contains("pulse");
      armed = setTimeout(() => {
        armed = null;
        b.textContent = label;
        b.classList.remove("arm");
        b.classList.toggle("pulse", hadPulse);
      }, 4000);
      b.textContent = "¿Confirmar?";
      b.classList.add("arm");
      b.classList.remove("pulse");
      return;
    }
    clearTimeout(armed);
    armed = null;
    b.disabled = true;
    b.textContent = "Fichando…";
    errBox.textContent = "";
    let punched = false;
    try {
      await api("/api/attendance", { action });
      punched = true;
      await loadAndRender();
      checkAlarms();
    } catch (e) {
      if (punched) {
        errBox.textContent = "Fichado, pero no se pudo recargar: " + e.message;
        return;
      }
      errBox.textContent = "Error: " + e.message;
      b.disabled = false;
      b.textContent = label;
      b.classList.remove("arm");
    }
  });
  return b;
}
