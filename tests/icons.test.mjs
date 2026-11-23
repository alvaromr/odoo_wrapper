// icons.js: the hero's inline icons, read back as the SVG nodes they draw.

import assert from "node:assert/strict";
import { test } from "vitest";
import { built, dashboard, element } from "./page.mjs";

test("the icons are SVG paths with the same stroke, and the muted bell is crossed out", () => {
  const page = dashboard();
  const spaces = [];
  page.document.createElementNS = (space, tag) => {
    spaces.push(space);
    return element(tag);
  };
  const stroke = {
    viewBox: "0 0 24 24",
    width: "15",
    height: "15",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  };
  for (const [call, paths] of [
    ["bellIcon(false)", 2],
    ["bellIcon(true)", 3],
    ["gearIcon()", 2],
    ["qrIcon()", 12],
  ]) {
    const svg = built(page, call);
    assert.equal(svg.tagName, "SVG", call);
    assert.deepEqual({ ...svg.attrs }, stroke, call);
    assert.equal(svg.children.length, paths, call);
    for (const path of svg.children) {
      assert.equal(path.tagName, "PATH");
      assert.match(path.attrs.d, /^M[\d.]/, call);
    }
  }
  assert.equal(built(page, "bellIcon(true)").children[2].attrs.d, "M3 3l18 18");
  assert.equal(
    built(page, "gearIcon()").children[0].attrs.d,
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38" +
      "a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38" +
      "a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2" +
      "v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73" +
      "l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73" +
      "l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
  );
  assert.equal(spaces.length > 0 && spaces.every((space) => space === "http://www.w3.org/2000/svg"), true);
});
