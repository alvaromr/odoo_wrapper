// teamstate.js: the management view's shared state and its name search. Loaded on its own, with format.js,
// in a context of its own.

import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";
import { IMPORT_RE, readModule } from "./page.mjs";

function loadModules(...names) {
  const ctx = vm.createContext({ Date, __stryker__: { activeMutant: process.env.__STRYKER_ACTIVE_MUTANT__ } });
  const blank = (text) => text.replace(/[^\n]/g, " ");
  for (const name of names) {
    vm.runInContext(
      readModule(name)
        .replace(IMPORT_RE, blank)
        .replace(/^export\s/gm, blank),
      ctx,
    );
  }
  return (code) => JSON.parse(JSON.stringify(vm.runInContext(code, ctx)));
}

test("the shared state starts on this week, this month and this year, with no search", () => {
  const run = loadModules("format.js", "teamstate.js");
  assert.deepEqual(run("[team.month, team.year, team.search, team.view, team.filter, team.display, team.fixDay]"), [
    "2026-09",
    "2026",
    "",
    "week",
    "issues",
    "table",
    10,
  ]);
  assert.deepEqual(run("FlagText"), {
    open: "Sin cerrar",
    empty: "Sin fichar",
    long: "Jornada muy larga",
  });
});

test("the name search folds case and accents, ignores the spaces around it, and nothing more", () => {
  const run = loadModules("format.js", "teamstate.js");
  assert.deepEqual(
    [
      'named({ name: "López" }, "lopez")',
      'named({ name: "Zoe" }, "  zoe ")',
      'named({ name: "ZOE" }, "oe")',
      'named({ name: "Ana" }, "")',
      'named({ name: "Ana" }, "bea")',
      'named({ name: "Strauß" }, "strauss")',
    ].map(run),
    [true, true, true, true, false, false],
  );
});
