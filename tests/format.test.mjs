// format.js: hours, deltas and clock times as the pages write them.

import assert from "node:assert/strict";
import { test } from "vitest";
import { load, SCHEDULE } from "./page.mjs";

test("formats hours, deltas and clocks", () => {
  const { run } = load();
  assert.equal(run("fmtHM(1.5)"), "1h 30m");
  assert.equal(run("fmtHM(-0.25)"), "−15m");
  assert.equal(run("fmtHM(0)"), "0h");
  assert.equal(run("fmtHM(2.05)"), "2h 3m");
  assert.equal(run("fmtHM(18)"), "18h");
  assert.equal(run("fmtDelta(0.5)"), "+30m");
  assert.equal(run("fmtDelta(-0.5)"), "−30m");
  assert.equal(run("fmtShort(0.5)"), "30m");
  assert.equal(run("fmtShort(1.25)"), "1h 15m");
  assert.equal(run("fmtShort(-1)"), "0m");
  assert.equal(run("fmtClock(17.5)"), "17:30");
  assert.equal(run("isoDay(new Date(2026, 0, 5))"), "2026-01-05");
  run(SCHEDULE);
  assert.equal(run("targetLabel({ target: 40 })"), "40h");
  assert.equal(run("targetLabel({ target: 31.5 })"), "31h 30m");
});

test("clock times pad their minutes and the hour of a date counts its seconds", () => {
  const page = load();
  assert.equal(page.run("fmtClock(8.05)"), "8:03");
  assert.equal(page.run("fmtClock(17.5)"), "17:30");
  assert.equal(page.run("hourOf(new Date(2026, 0, 1, 10, 30, 36))"), 10 + 0.5 + 0.01);
});
