// store.js: the constants of the dashboard and its shared state as the page starts with them.

import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./page.mjs";

test("the page starts with its constants and an empty shared state", () => {
  const page = load({ fetchImpl: () => new Promise(() => {}) });
  assert.deepEqual(page.run("LOOPBACK"), ["localhost", "127.0.0.1", "[::1]", "::1"]);
  assert.deepEqual(page.run("DayNames"), ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]);
  assert.deepEqual(page.run("DayFull"), ["lunes", "martes", "miércoles", "jueves", "viernes", "sábados", "domingos"]);
  assert.deepEqual(page.run("NoSchedule"), {
    hours: [0, 0, 0, 0, 0, 0, 0],
    lunch_from: [null, null, null, null, null, null, null],
  });
  assert.deepEqual(page.run("store.state"), {
    lunch: null,
    lunch_minutes: 30,
    break_minutes: 15,
    lunch_button_from: 810,
    lunch_button_to: 960,
    muted: false,
    lunch_done: false,
    punched_at: null,
  });
});

test("the page shows someone else's week only at /empleado with an id", () => {
  const other = (path) => load({ path, fetchImpl: () => new Promise(() => {}) }).run("store.other");
  assert.deepEqual([other("/"), other("/?id=5"), other("/empleado?id=5"), other("/empleado")], [null, null, "5", null]);
});
