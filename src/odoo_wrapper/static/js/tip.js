/*
 * The tooltip (#tip, styled in style.css), on both pages: it follows the pointer and also opens on keyboard focus.
 * It is drawn by the page, not a title attribute, which showed nothing in Orca's embedded browser.
 */

import { byId, el } from "./shared.js";

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
