// theme.js: the colour theme, the one classic script, read from storage on load.

import assert from "node:assert/strict";
import test from "node:test";
import { load, memoryStorage } from "./page.mjs";

test("the colour theme is read from storage on load, and a choice says whether it was kept", () => {
  const stored = load({ local: memoryStorage({ theme: "dark" }) });
  assert.equal(stored.document.documentElement.dataset.theme, "dark");
  const none = load();
  assert.strictEqual(none.document.documentElement.dataset.theme, "");
  assert.strictEqual(none.run("window.chooseTheme('light')"), true);
  assert.equal(none.document.documentElement.dataset.theme, "light");
  const blocked = load({
    local: {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    },
  });
  assert.equal(blocked.document.documentElement.dataset.theme, undefined);
  assert.deepEqual(blocked.calls.warnings, ["[odoo] reading the theme failed: Error: bloqueado"]);
  assert.strictEqual(blocked.run("window.chooseTheme('dark')"), false);
  assert.equal(blocked.document.documentElement.dataset.theme, "dark");
});
