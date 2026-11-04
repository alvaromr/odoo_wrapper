// tip.js: the tooltip both pages draw, where it opens and when it closes, on the pointer and on keyboard focus.

import assert from "node:assert/strict";
import test from "node:test";
import { element, load, showAll, teamPage, tipOf } from "./page.mjs";

test("the tooltip opens on the far side of the pointer when it would not fit the window", () => {
  const page = teamPage();
  const node = element("div");
  page.run("attachTip")(node, (box) => box.appendChild(page.run("el")("div", "t-title", "Hola")));
  const tip = tipOf(page);
  tip.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 100, height: 50 });
  const placed = (x, y) => {
    node.listeners.pointermove[0]({ clientX: x, clientY: y });
    return [tip.style.left, tip.style.top];
  };
  assert.deepEqual(placed(10, 10), ["24px", "24px"]);
  assert.deepEqual(placed(1158, 728), ["1172px", "742px"]);
  assert.deepEqual(placed(1165, 741), ["1051px", "677px"]);
  assert.deepEqual(placed(1200, 10), ["1086px", "24px"]);
});

test("a tooltip says whether it is open, and opens on focus below the middle of what has it", () => {
  const page = teamPage();
  const node = element("div");
  node.getBoundingClientRect = () => ({ left: 100, top: 30, right: 140, bottom: 70, width: 40, height: 40 });
  page.run("attachTip")(node, (box) => box.appendChild(page.run("tipRow")("Horas", "8h")));
  const tipOpen = () => page.run("tipOpen()");
  assert.equal(tipOpen(), false);
  node.listeners.focus[0]();
  assert.equal(tipOpen(), true);
  assert.deepEqual([tipOf(page).style.left, tipOf(page).style.top], ["134px", "84px"]);
  assert.deepEqual(showAll(tipOf(page).children), ["div.t-row", '  span.k "Horas"', '  span.v "8h"']);
  node.listeners.blur[0]();
  assert.equal(tipOpen(), false);
  assert.equal(tipOf(page).style.display, "none");
});

test("a tooltip also opens on keyboard focus and closes on blur", () => {
  const page = load({ entry: "team.js" });
  const node = page.document.createElement("div");
  page.run("attachTip").call(null, node, (tip) => tip.appendChild(page.run("el('div', 't-title', 'Hola')")));
  node.listeners.focus[0]();
  const tip = page.document.getElementById("tip");
  node.listeners.pointermove[0]({ clientX: 40, clientY: 50 });
  assert.deepEqual([tip.style.left, tip.style.top], ["54px", "64px"]);
  assert.equal(tip.style.display, "block");
  assert.equal(tip.children[0].textContent, "Hola");
  node.listeners.blur[0]();
  assert.equal(tip.style.display, "none");
});
