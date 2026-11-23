// week.js: the figures the page draws with, week by week: the lunch window, the hours a day expects, the sessions
// indexed per day, the weeks (current, complete, in error) and the punches to fix, on a clock the test sets
// (clockAt in page.mjs).

import assert from "node:assert/strict";
import { test } from "vitest";
import { at, dashboard, load, MIDNIGHT, MONDAY, payload, session, TUESDAY, withData } from "./page.mjs";

const SUNDAY = new Date(2026, 8, 20, 10, 0);

test("lunch opens from 13:30 to 16:00 and only on days whose calendar has one", () => {
  const { run } = withData([]);
  run("store.lunchFrom = [14, 14, 14, 14, null, null, null]");
  assert.equal(run("lunchOpen(new Date(2026, 8, 15, 13, 29))"), false);
  assert.equal(run("lunchOpen(new Date(2026, 8, 15, 13, 30))"), true);
  assert.equal(run("lunchOpen(new Date(2026, 8, 15, 15, 59))"), true);
  assert.equal(run("lunchOpen(new Date(2026, 8, 15, 16, 0))"), false);
  assert.equal(run("lunchOpen(new Date(2026, 8, 18, 14, 0))"), false);
  assert.equal(run("lunchHours({ date: new Date(2026, 8, 14) })"), 0.5);
  assert.equal(run("lunchHours({ date: new Date(2026, 8, 18) })"), 0);
  assert.equal(run("lunchHours({ date: new Date(2026, 8, 14), vacation: true })"), 0);
});

test("without a schedule nothing is expected and the page says so", async () => {
  const today = new Date();
  const page = load({ data: payload([session(at(today, 9), null)]) });
  await page.run("loadAndRender()");
  assert.equal(page.run("store.weekTarget"), 0);
  assert.equal(page.run("buildWeek(0).target"), 0);
  assert.equal(page.run("lunchOpen(new Date())"), false);
  assert.match(page.document.getElementById("weeksHint").textContent, /^Odoo no devuelve horario/);
});

test("a day whose contract asked for other hours expects those", async () => {
  const today = new Date();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7) - 7);
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const tuesday = new Date(monday);
  tuesday.setDate(monday.getDate() + 1);
  const page = load({
    data: payload([], {
      schedule: { hours: [8, 8, 8, 8, 8, 0, 0], lunch_from: [null, null, null, null, null, null, null] },
      contract_hours: { [iso(monday)]: 0, [iso(tuesday)]: 5 },
    }),
  });
  await page.run("loadAndRender()");
  assert.deepEqual(page.run("buildWeek(1).days.map(d => d.expected)"), [0, 5, 8, 8, 8, 0, 0]);
  assert.equal(page.run("buildWeek(1).target"), 29);
  assert.equal(page.run("buildWeek(0).target"), 40);
});

test("the range selector counts months back from today, as weeks", () => {
  const { run, document } = withData([]);
  assert.deepEqual(
    [1, 6, 12].map((m) => run(`weeksSince(${m})`)),
    [6, 28, 53],
  );
  const seg = document.getElementById("rangeSeg");
  const button = document.createElement("button");
  button.dataset.months = "1";
  seg.appendChild(button);
  seg.listeners.click[0]({ target: { closest: () => button }, currentTarget: seg });
  assert.equal(button.getAttribute("aria-pressed"), "true");
});

test("sessions are indexed per day with their break share", () => {
  const monday = new Date(2026, 8, 14);
  const { run } = withData([
    session(at(monday, 9), at(monday, 11)),
    session(at(monday, 11), at(monday, 11, 15), true),
    session(at(TUESDAY, 9), null),
  ]);
  const week = run("buildWeek(0)");
  assert.equal(week.days[0].hours, 2.25);
  assert.equal(week.days[0].rest, 0.25);
  assert.equal(week.days[0].sessions.length, 2);
  assert.equal(week.days[1].hours, 1);
  assert.equal(week.total, 3.25);
  assert.equal(week.target, 40);
  assert.equal(week.delta, 3.25 - 40);
  assert.equal(week.current, true);
  assert.equal(week.complete, false);
  assert.equal(run("buildWeek(1)").complete, true);
  assert.equal(run("buildWeeks(3).length"), 3);
});

test("absences and hour leaves lower the expected hours", () => {
  const { run } = withData([]);
  run(`store.absMap = new Map([["2026-09-14", "Festivo"]]);
       store.leaveMap = new Map([["2026-09-15", [{ hours: 2.5, type: "Médico" }]]]);`);
  const week = run("buildWeek(0)");
  assert.equal(week.days[0].expected, 0);
  assert.equal(week.days[0].auto, "Festivo");
  assert.equal(week.days[1].expected, 6);
  assert.equal(week.days[1].leaves[0].type, "Médico");
  assert.equal(week.target, 40 - 8.5 - 2.5);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is code the page's context runs
  run("store.absMap = new Map([0, 1, 2, 3, 4].map(i => [`2026-09-1${4 + i}`, 'Vacaciones']))");
  assert.equal(run("buildWeek(0)").allVacation, true);
});

test("week labels span one or two months", () => {
  const { run } = load();
  assert.equal(
    run(
      `weekRangeLabel({ monday: new Date(${new Date().getFullYear()}, 8, 14), sunday: new Date(${new Date().getFullYear()}, 8, 20) })`,
    ),
    "14–20 sep",
  );
  const thisYear = new Date().getFullYear();
  assert.equal(
    run(`weekRangeLabel({ monday: new Date(${thisYear}, 8, 28), sunday: new Date(${thisYear}, 9, 4) })`),
    "28 sep – 4 oct",
  );
  assert.equal(run("weekRangeLabel({ monday: new Date(2020, 8, 7), sunday: new Date(2020, 8, 13) })"), "7–13 sep 2020");
  assert.equal(
    run("weekRangeLabel({ monday: new Date(2019, 11, 30), sunday: new Date(2020, 0, 5) })"),
    "30 dic 2019 – 5 ene 2020",
  );
  assert.equal(
    run("weekRangeLabel({ monday: new Date(2020, 8, 28), sunday: new Date(2020, 9, 4) })"),
    "28 sep – 4 oct 2020",
  );
});

const SEPTEMBER = (day, from = 9, to = 17) => session(at(new Date(2026, 8, day), from), at(new Date(2026, 8, day), to));

test("a day is long only past the payload's limit, and a day with a session left open is in error", () => {
  const page = dashboard();
  const longDay = (hours) => page.run(`longDay({ hours: ${hours} })`);
  assert.deepEqual([longDay(11.99), longDay(12), longDay(12.01)], [false, false, true]);
  const yesterday = new Date(2026, 8, 14, 9).getTime();
  const open = `{ in: new Date(${yesterday}), out: null }`;
  const closed = `{ in: new Date(${yesterday}), out: new Date(${yesterday}) }`;
  const error = (hours, sessions) => page.run(`dayError({ hours: ${hours}, sessions: [${sessions}] })`);
  assert.equal(error(1, `${open}, ${closed}`), true);
  assert.equal(error(1, closed), false);
  assert.equal(error(13, closed), true);
});

test("a day is missed when it is past, expected hours and has no session", () => {
  const page = dashboard();
  const missed = (date, expected, sessions) =>
    page.run(`missed({ date: new Date(${date.getTime()}), expected: ${expected}, sessions: ${sessions} })`);
  const yesterday = new Date(2026, 8, 14);
  assert.deepEqual(
    [missed(yesterday, 8, "[]"), missed(MIDNIGHT, 8, "[]"), missed(yesterday, 0, "[]"), missed(yesterday, 8, "[{}]")],
    [true, false, false, false],
  );
});

test("the punches to fix are the open ones from before today, long days and missed ones, newest first", () => {
  const sessions = [
    SEPTEMBER(7, 9, 17),
    SEPTEMBER(9, 6, 20),
    session(new Date(2026, 8, 14, 22), null),
    session(MIDNIGHT, null),
  ];
  const page = dashboard({ sessions, extra: { since: "2026-09-07" } });
  page.run(`store.since = "2026-09-07"`);
  const errors = page.run("punchErrors()").map((e) => `${e.kind} ${e.in.slice(0, 10)}`);
  assert.deepEqual(
    page.run("punchErrors()").map((e) => e.kind),
    ["open", "empty", "empty", "long", "empty"],
  );
  assert.deepEqual(errors.length, 5);
  assert.equal(page.run("punchErrors()")[3].hours, 14);
  assert.equal(page.run("punchErrors()")[3].count, 1);
  assert.equal(page.run("punchErrors()")[1].expected, 6);
  const dates = page.run("punchErrors().map((e) => new Date(e.in).getTime())");
  assert.deepEqual(
    [...dates].sort((a, b) => b - a),
    dates,
  );
});

test("a day that holds an open session today is not a long day to fix", () => {
  const page = dashboard({
    sessions: [session(at(TUESDAY, 0), at(TUESDAY, 7)), session(at(TUESDAY, 7), null)],
    extra: { long_hours: 5, since: "2026-09-15" },
  });
  page.run(`store.since = "2026-09-15"`);
  assert.deepEqual(page.run("punchErrors()"), []);
});

test("a week offset counts Monday-to-Sunday weeks back, whatever day of the week the date is", () => {
  const page = dashboard();
  const offset = (date) => page.run(`weekOffsetOf(new Date(${date.getTime()}))`);
  assert.deepEqual(
    [
      new Date(2026, 8, 15),
      new Date(2026, 8, 14),
      new Date(2026, 8, 20),
      new Date(2026, 8, 13),
      new Date(2026, 8, 7),
      new Date(2026, 8, 6),
    ].map(offset),
    [0, 0, 0, 1, 1, 2],
  );
});

test("a whole-day absence has no leaves, even when a leave is listed for the same date", () => {
  const page = dashboard();
  page.run(
    `store.absMap = new Map([["2026-09-15", "Festivo"]]); store.leaveMap = new Map([["2026-09-15", [{ hours: 1, type: "Médico" }]]])`,
  );
  const today = page.run("buildWeek(0).days[1]");
  assert.deepEqual(today.leaves, []);
  assert.equal(today.expected, 0);
  assert.equal(today.vacation, true);
  assert.deepEqual(page.run("buildWeek(0).days[2].leaves"), []);
});

test("a week is the current one from Monday to Sunday only, and complete only after its Sunday", () => {
  const flags = (now) => {
    const page = dashboard({ now });
    return ["buildWeek(0)", "buildWeek(1)", "buildWeek(-1)"].map((week) =>
      page.run(`[${week}.current, ${week}.complete]`),
    );
  };
  assert.deepEqual(flags(TUESDAY), [
    [true, false],
    [false, true],
    [false, false],
  ]);
  assert.deepEqual(flags(MONDAY), [
    [true, false],
    [false, true],
    [false, false],
  ]);
  assert.deepEqual(flags(SUNDAY), [
    [true, false],
    [false, true],
    [false, false],
  ]);
});

test("a week is in error for a long day, a missed day or an open one, each by itself", () => {
  const week = (sessions) => {
    const page = dashboard({ sessions: [SEPTEMBER(14), ...sessions] });
    return page.run("[buildWeek(1).error, buildWeek(1).suspect, buildWeek(1).missedDays, buildWeek(1).openDays]");
  };
  const all = [7, 8, 9, 10, 11].map((d) => SEPTEMBER(d));
  assert.deepEqual(week(all), [false, false, 0, 0]);
  assert.deepEqual(week([...all.slice(0, 2), SEPTEMBER(9, 5, 20), ...all.slice(3)]), [true, true, 0, 0]);
  assert.deepEqual(week(all.slice(1)), [true, false, 1, 0]);
  assert.deepEqual(week([...all.slice(0, 4), session(new Date(2026, 8, 11, 9), null)]), [true, false, 0, 1]);
});
