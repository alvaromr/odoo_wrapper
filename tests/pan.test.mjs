// pan.js: a big box of the management view scrolls by dragging, and a drag never counts as a click.

import assert from "node:assert/strict";
import { test } from "vitest";
import { element, teamPage } from "./page.mjs";

test("a press pans a box only once it moves, leaves links alone and tells a click it was a drag, once", () => {
  const page = teamPage();
  const scroller = element("div");
  const captured = [];
  scroller.setPointerCapture = (id) => captured.push(id);
  const pan = page.run("panScroll")(scroller);
  const on = (type, event) => scroller.listeners[type][0](event);
  const plain = { closest: (selector) => (selector === "a" ? null : {}) };
  const link = { closest: (selector) => (selector === "a" ? {} : null) };
  const press = (target) =>
    on("pointerdown", { button: 0, pointerType: "mouse", target, clientX: 100, clientY: 100, pointerId: 7 });
  scroller.scrollLeft = 50;
  scroller.scrollTop = 20;

  press(link);
  on("pointermove", { clientX: 160, clientY: 100 });
  assert.deepEqual([scroller.scrollLeft, scroller.scrollTop], [50, 20]);

  press(plain);
  assert.equal(pan.consume(), false);
  on("pointermove", { clientX: 103, clientY: 100 });
  assert.deepEqual([scroller.scrollLeft, scroller.classList.contains("dragging"), captured], [50, false, []]);
  const owner = element("div");
  page.run("attachTip")(owner, (box) => box.appendChild(page.run("el")("div", "t-title", "Hola")));
  owner.listeners.pointerenter[0]({ clientX: 1, clientY: 1 });
  assert.equal(page.run("tipOpen()"), true);
  on("pointermove", { clientX: 110, clientY: 100 });
  assert.equal(page.run("tipOpen()"), false);
  assert.deepEqual([scroller.scrollLeft, scroller.scrollTop, scroller.classList.contains("dragging")], [40, 20, true]);
  assert.deepEqual(captured, [7]);
  on("pointerup");
  assert.equal(scroller.classList.contains("dragging"), false);
  assert.deepEqual([pan.consume(), pan.consume()], [true, false]);

  press(plain);
  on("pointerup");
  assert.equal(pan.consume(), false);
});
