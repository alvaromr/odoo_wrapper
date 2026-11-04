/*
 * panScroll lets a big box of the management view scroll by dragging, sideways and up and down, for a mouse that has
 * no sideways wheel: a press that moves more than PanSlop pixels pans instead of clicking, and a press on a link is
 * left alone. Touch is left to the browser, which already scrolls a box under a finger. The pointer is captured only
 * once it pans: captured from the press, every click landed on the box instead of the thing under it, which then
 * never opened. consume() tells a click handler that its press was a pan, once, so the drag does not also open what
 * it ended on.
 */

import { hideTip } from "./tip.js";

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
