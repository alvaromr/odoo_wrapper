// alarms.js: the three alarms (end of day, lunch, break), the beep, the blinking title and the status line that says
// what rings next. The beep is read back from an AudioContext that remembers every call (page.mjs), on a clock the
// test sets (clockAt in page.mjs).

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  at,
  beeps,
  fakeAudio,
  flashing,
  HOUR,
  iso,
  load,
  lunchedAt,
  mondayDone,
  payload,
  SCHEDULE,
  session,
  settle,
  TUESDAY,
  withAlarms,
  withData,
} from "./page.mjs";

test("the status line explains why it is or is not ringing", () => {
  const { run } = withData([]);
  const day = { expected: 8, hours: 1 };
  assert.equal(run(`notifyStatus(null, ${JSON.stringify(day)}, 7)`), "Sin fichaje abierto");
  assert.equal(run("notifyStatus(null, { expected: 0 }, 0)"), "Hoy sin jornada prevista");
  run("store.state = { ...store.state, lunch: new Date(Date.now() - 10 * 60000).toISOString() }");
  assert.match(
    run(`notifyStatus(null, ${JSON.stringify(day)}, 7)`),
    /^Comida hasta las \d\d:\d\d · toca la página para oírlo$/,
  );
  run("store.state = { ...store.state, lunch: new Date(Date.now() - 60 * 60000).toISOString() }");
  assert.match(run(`notifyStatus(null, ${JSON.stringify(day)}, 7)`), /^Comida vencida/);
  const open = { in: new Date(Date.now() - 5 * 60000).toISOString(), rest: true };
  assert.match(run(`notifyStatus(${JSON.stringify(open)}, ${JSON.stringify(day)}, 7)`), /^Descanso hasta las/);
  assert.match(run(`notifyStatus({ rest: false }, ${JSON.stringify(day)}, 7)`), /^Sonará al cumplir la jornada/);
  assert.match(run(`notifyStatus({ rest: false }, ${JSON.stringify(day)}, 0)`), /^Avisando cada 2 min/);
  run("store.state = { ...store.state, muted: true }");
  assert.equal(run(`notifyStatus({ rest: false }, ${JSON.stringify(day)}, 0)`), "Silenciado hasta mañana");
});

function alarmsPage(sessions, state = {}) {
  const page = load();
  const data = payload(sessions, { state: { ...payload([]).state, ...state } });
  page.run(
    `store.personal = ${JSON.stringify(data)}; store.state = store.personal.state; store.expected = [8, 8, 8, 8, 8, 8, 8]; store.lunchFrom = Array(7).fill(13.5);`,
  );
  page.run("setClock(new Date()); indexSessions();");
  return page;
}

test("the end-of-day alarm rings once the expected hours are met with a session open", () => {
  const today = new Date();
  const { run, document } = alarmsPage([session(at(today, 0), null)]);
  assert.equal(run("NotifiedAt"), 0);
  run("checkAlarms()");
  assert.ok(run("NotifiedAt") > 0);
  assert.ok(run("FlashTimer"));
  run("checkAlarms()");
  const first = run("NotifiedAt");
  run("checkAlarms()");
  assert.equal(run("NotifiedAt"), first);
  run("store.state = { ...store.state, muted: true }; checkAlarms()");
  assert.equal(run("FlashTimer"), null);
  assert.equal(document.title, "Fichajes");
});

test("a short open session does not ring", () => {
  const { run } = alarmsPage([session(new Date(Date.now() - 60000), null)]);
  run("checkAlarms()");
  assert.equal(run("NotifiedAt"), 0);
  assert.equal(run("FlashTimer"), null);
});

test("lunch rings only after the lunch button, within the grace period", () => {
  const { run } = alarmsPage([]);
  run("checkAlarms()");
  assert.equal(run("LastRing.lunch"), 0);
  run("store.state = { ...store.state, lunch: new Date(Date.now() - 40 * 60000).toISOString() }; checkAlarms()");
  assert.ok(run("LastRing.lunch") > 0);
  run(
    "LastRing.lunch = 0; store.state = { ...store.state, lunch: new Date(Date.now() - 4 * 3600000).toISOString() }; checkAlarms()",
  );
  assert.equal(run("LastRing.lunch"), 0);
  assert.equal(run("FlashTimer"), null);
});

test("a break rings when it runs over its minutes", () => {
  const { run } = alarmsPage([session(new Date(Date.now() - 20 * 60000), null, true)]);
  run("checkAlarms()");
  assert.ok(run("LastRing.rest") > 0);
  const { run: quiet } = alarmsPage([session(new Date(Date.now() - 20 * 60000), null, true)], { break_minutes: 0 });
  quiet("checkAlarms()");
  assert.equal(quiet("LastRing.rest"), 0);
});

test("the first touch unlocks the sound, and a lunch that ran out rings three beeps", async () => {
  const audio = fakeAudio();
  const page = load({ globals: { window: audio.window } });
  const doc = page.document;
  doc.listeners.pointerdown[0]();
  await settle();
  assert.equal(audio.made.length, 1);
  assert.equal(audio.made[0].state, "running");
  doc.listeners.keydown[0]();
  assert.equal(audio.made.length, 1);
  const lunch = new Date(Date.now() - 40 * 60000).toISOString();
  page.run(
    `store.personal = ${JSON.stringify(payload([]))}; store.state = { ...store.personal.state, lunch: "${lunch}" }; ${SCHEDULE}`,
  );
  page.run("setClock(new Date()); store.expected = [8, 8, 8, 8, 8, 8, 8]; checkAlarms()");
  assert.equal(audio.made[0].oscillators.length, 3);
  assert.ok(audio.made[0].oscillators.every((o) => o.stopped));
  assert.equal(page.run("document.title"), "Fichajes");
  const flash = page.calls.timers.find(([, ms]) => ms === 900)[0];
  flash();
  assert.equal(page.run("document.title"), "🍽 Comida terminada");
  flash();
  assert.equal(page.run("document.title"), "Fichajes");
  const refused = fakeAudio(true);
  const blocked = load({ globals: { window: refused.window } });
  blocked.document.listeners.pointerdown[0]();
  await settle();
  assert.equal(refused.made[0].state, "suspended");
  page.run(
    "store.notifyEl = document.createElement('div'); store.notifyArgs = [null, { expected: 8 }, 8]; refreshNotifyNote()",
  );
  assert.match(page.run("store.notifyEl.textContent"), /^Comida vencida a las \d\d:\d\d$/);
});

test("a browser that grants the sound with no gesture rings without a touch", () => {
  const audio = fakeAudio(false, "running");
  const page = load({ globals: { window: audio.window } });
  const lunch = new Date(Date.now() - 40 * 60000).toISOString();
  page.run(
    `store.personal = ${JSON.stringify(payload([]))}; store.state = { ...store.personal.state, lunch: "${lunch}" }; ${SCHEDULE}`,
  );
  page.run("setClock(new Date()); store.expected = [8, 8, 8, 8, 8, 8, 8]; checkAlarms()");
  assert.equal(audio.made[0].oscillators.length, 3);
  assert.match(page.run("notifyStatus(null, { expected: 8 }, 8)"), /^Comida vencida a las \d\d:\d\d$/);
});

test("a beep is three sine tones at 880 Hz, each with its own envelope, to the speakers", () => {
  const page = withAlarms({ sessions: [session(at(TUESDAY, 1), null)] });
  page.run("checkAlarms()");
  const { oscillators, gains, destination } = page.audio;
  assert.equal(oscillators.length, 3);
  [0, 0.3, 0.6].forEach((offset, i) => {
    const [osc, gain] = [oscillators[i], gains[i]];
    assert.equal(osc.type, "sine");
    assert.equal(osc.frequency.value, 880);
    assert.deepEqual(gain.calls, [
      ["set", 0.0001, 100 + offset],
      ["ramp", 0.3, 100 + offset + 0.02],
      ["ramp", 0.0001, 100 + offset + 0.25],
    ]);
    assert.equal(osc.to, gain);
    assert.equal(gain.to, destination);
    assert.equal(osc.started, 100 + offset);
    assert.equal(osc.stopped, 100 + offset + 0.26);
  });
});

test("the title blinks with the alarm's words and stops when the alarm does", () => {
  const page = withAlarms({ sessions: [session(at(TUESDAY, 1), null)] });
  page.run("checkAlarms()");
  const [blink, ms] = page.calls.timers.at(-1);
  assert.equal(ms, 900);
  blink();
  assert.equal(page.document.title, "⏰ Jornada cumplida");
  blink();
  assert.equal(page.document.title, "Fichajes");
  blink();
  page.run("stopFlash()");
  assert.equal(page.document.title, "Fichajes");
  assert.equal(page.run("FlashTimer"), null);
  const rest = withAlarms({ sessions: [session(at(TUESDAY, 9, 40), null, true)] });
  rest.run("checkAlarms()");
  rest.calls.timers.at(-1)[0]();
  assert.equal(rest.document.title, "☕ Descanso terminado");
  const lunch = withAlarms({ sessions: [mondayDone] });
  lunch.run(lunchedAt(new Date(TUESDAY.getTime() - 40 * 60000)));
  lunch.run("checkAlarms()");
  lunch.calls.timers.at(-1)[0]();
  assert.equal(lunch.document.title, "🍽 Comida terminada");
});

test("stopping a flash that is not on leaves the title alone, and a flash on is cleared", () => {
  const cleared = [];
  const page = withAlarms({ globals: { clearInterval: (id) => cleared.push(id) } });
  page.document.title = "otra cosa";
  page.run("stopFlash()");
  assert.equal(page.document.title, "otra cosa");
  assert.deepEqual(cleared, []);
  page.run(`flashTitle("x")`);
  const id = page.run("FlashTimer");
  page.run("stopFlash()");
  assert.deepEqual(cleared, [id]);
  assert.equal(page.document.title, "Fichajes");
});

test("the first click or key unlocks a suspended audio, once", async () => {
  const page = withAlarms({ audio: "suspended" });
  page.run("store.notifyEl = document.createElement('div'); store.notifyArgs = [undefined, { expected: 8 }, 0]");
  page.document.listeners.pointerdown[0]();
  assert.equal(page.audio.resumed, 1);
  await settle();
  assert.equal(page.run("store.notifyEl.textContent"), "Sin fichaje abierto");
  page.document.listeners.keydown[0]();
  assert.equal(page.audio.resumed, 1);
  const refused = withAlarms({ audio: "suspended", globals: { window: fakeAudio(true).window } });
  refused.document.listeners.keydown[0]();
  await settle();
});

test("the status line refreshes only when there is a line and what to say", () => {
  const page = withAlarms();
  page.run("refreshNotifyNote()");
  page.run("store.notifyEl = document.createElement('div'); store.notifyEl.textContent = 'quieto'");
  page.run("refreshNotifyNote()");
  assert.equal(page.run("store.notifyEl.textContent"), "quieto");
  page.run("store.notifyEl = null; store.notifyArgs = [undefined, { expected: 8 }, 0]");
  page.run("refreshNotifyNote()");
  page.run("store.notifyEl = document.createElement('div'); store.notifyArgs = [undefined, { expected: 8 }, 0]");
  page.run("refreshNotifyNote()");
  assert.equal(page.run("store.notifyEl.textContent"), "Sin fichaje abierto");
});

test("the status line says what the next alarm is", () => {
  const page = withAlarms();
  const open = (extra = {}) => JSON.stringify({ in: iso(at(TUESDAY, 9, 45)), rest: false, ...extra });
  const status = (args) => page.run(`notifyStatus(${args})`);
  const worked = "{ expected: 8 }";
  page.run(`store.state.muted = true`);
  assert.equal(status(`undefined, ${worked}, 0`), "Silenciado hasta mañana");
  page.run(`store.state.muted = false`);
  assert.equal(status(`undefined, { expected: 0 }, 0`), "Hoy sin jornada prevista");
  assert.equal(status(`undefined, ${worked}, 0`), "Sin fichaje abierto");
  page.run(lunchedAt(new Date(TUESDAY.getTime() + 1 * 60000 - 30 * 60000)));
  assert.equal(status(`undefined, ${worked}, 0`), "Comida hasta las 10:01");
  page.run(lunchedAt(new Date(TUESDAY.getTime() - 30 * 60000)));
  assert.equal(status(`undefined, ${worked}, 0`), "Comida vencida a las 10:00");
  page.run(lunchedAt(new Date(TUESDAY.getTime() - 31 * 60000)));
  assert.equal(status(`undefined, ${worked}, 0`), "Comida vencida a las 09:59");
  page.run(`store.state.break_minutes = 0`);
  assert.equal(status(`${open({ rest: true })}, ${worked}, 3`), "En descanso · sin aviso configurado");
  page.run(`store.state.break_minutes = 15`);
  assert.equal(
    status(`${open({ rest: true, in: iso(at(TUESDAY, 9, 45)) })}, ${worked}, 3`),
    "Descanso vencido a las 10:00",
  );
  assert.equal(
    status(`${open({ rest: true, in: iso(at(TUESDAY, 9, 46)) })}, ${worked}, 3`),
    "Descanso hasta las 10:01",
  );
  assert.equal(
    status(`${open({ rest: true, in: iso(at(TUESDAY, 9, 44)) })}, ${worked}, 3`),
    "Descanso vencido a las 09:59",
  );
  assert.equal(status(`${open()}, ${worked}, 3`), "Sonará al cumplir la jornada");
  const every = "Avisando cada 2 min · siguiente ";
  assert.equal(status(`${open()}, ${worked}, 0`), `${every}en menos de 1 min`);
  page.run(`NotifiedAt = ${TUESDAY.getTime() - 60000}`);
  assert.equal(status(`${open()}, ${worked}, 0`), `${every}en 1 min`);
  page.run(`NotifiedAt = ${TUESDAY.getTime() - 59999}`);
  assert.equal(status(`${open()}, ${worked}, 0`), `${every}en 1 min`);
  page.run(`NotifiedAt = ${TUESDAY.getTime() - 60001}`);
  assert.equal(status(`${open()}, ${worked}, 0`), `${every}en menos de 1 min`);
  page.run(`NotifiedAt = ${TUESDAY.getTime() - 90000}`);
  assert.equal(status(`${open()}, ${worked}, 0`), `${every}en menos de 1 min`);
});

test("the status line asks to touch the page while the audio is held back", () => {
  const page = withAlarms({ audio: "suspended" });
  const status = (args) => page.run(`notifyStatus(${args})`);
  const worked = "{ expected: 8 }";
  const open = JSON.stringify({ in: iso(at(TUESDAY, 9)), rest: false });
  page.run(lunchedAt(new Date(TUESDAY.getTime() - 40 * 60000)));
  assert.equal(status(`undefined, ${worked}, 0`), "Comida vencida a las 09:50 · toca la página para oírlo");
  assert.equal(
    status(`${JSON.stringify({ in: iso(at(TUESDAY, 9)), rest: true })}, ${worked}, 0`),
    "Descanso vencido a las 09:15 · toca la página para oírlo",
  );
  assert.equal(status(`${open}, ${worked}, 3`), "Sonará al cumplir la jornada · toca la página para oírlo");
});

test("no beep sounds while the audio is held back, but the title still blinks", () => {
  const page = withAlarms({ audio: "suspended", sessions: [session(at(TUESDAY, 1), null)] });
  page.run("checkAlarms()");
  assert.equal(beeps(page), 0);
  assert.equal(flashing(page), true);
});

test("the end of day rings once its hours are met, then every two minutes while still punched in", () => {
  const page = withAlarms({ sessions: [session(at(TUESDAY, 9), null)] });
  page.run("store.expected = [8.5, 1.01, 0, 0, 0, 0, 0]");
  page.run("checkAlarms()");
  assert.equal(beeps(page), 0);
  assert.equal(flashing(page), false);
  page.run("store.expected = [8.5, 1, 0, 0, 0, 0, 0]");
  page.run("checkAlarms()");
  assert.equal(beeps(page), 1);
  assert.equal(flashing(page), true);
  page.run("checkAlarms()");
  assert.equal(beeps(page), 1);
  page.Clock.set(new Date(TUESDAY.getTime() + 119999));
  page.run("checkAlarms()");
  assert.equal(beeps(page), 1);
  page.Clock.set(new Date(TUESDAY.getTime() + 120000));
  page.run("checkAlarms()");
  assert.equal(beeps(page), 2);
});

test("the alarms recompute the day's hours at the moment they are checked", () => {
  const page = withAlarms({ sessions: [session(at(TUESDAY, 9), null)], now: at(TUESDAY, 9, 30) });
  page.run("store.expected = [8.5, 1, 0, 0, 0, 0, 0]");
  page.Clock.set(TUESDAY);
  page.run("checkAlarms()");
  assert.equal(beeps(page), 1);
});

test("a muted day, a day with no hours or no data rings nothing and stops a blinking title", () => {
  const sessions = [session(at(TUESDAY, 1), null)];
  const quiet = (setup) => {
    const page = withAlarms({ sessions });
    page.run(`flashTitle("x")`);
    page.run(setup);
    page.run("checkAlarms()");
    return [beeps(page), flashing(page)];
  };
  assert.deepEqual(quiet("store.state.muted = true"), [0, false]);
  assert.deepEqual(quiet("store.expected = [8.5, 0, 0, 0, 0, 0, 0]"), [0, false]);
  assert.deepEqual(quiet("store.personal = null"), [0, true]);
});

test("a break rings when it has lasted as long as it should, not a minute before", () => {
  const page = withAlarms({ sessions: [session(at(TUESDAY, 9, 46), null, true)] });
  page.run("checkAlarms()");
  assert.equal(beeps(page), 0);
  assert.equal(flashing(page), false);
  const due = withAlarms({ sessions: [session(at(TUESDAY, 9, 45), null, true)] });
  due.run("checkAlarms()");
  assert.equal(beeps(due), 1);
  assert.equal(flashing(due), true);
  due.run("checkAlarms()");
  assert.equal(beeps(due), 1);
  const long = withAlarms({
    sessions: [session(at(TUESDAY, 9, 45), null, true)],
    now: new Date(TUESDAY.getTime() + 2 * HOUR),
  });
  long.run("checkAlarms()");
  assert.equal(beeps(long), 1);
  const over = withAlarms({
    sessions: [session(at(TUESDAY, 9, 45), null, true)],
    now: new Date(TUESDAY.getTime() + 2 * HOUR + 1),
  });
  over.run(`flashTitle("x")`);
  over.run("checkAlarms()");
  assert.equal(beeps(over), 0);
  assert.equal(flashing(over), false);
});

test("lunch rings after the minutes set, for two hours, and not before or after", () => {
  const lunch = (minutesAgo, setup = "") => {
    const page = withAlarms({ sessions: [mondayDone] });
    page.run(lunchedAt(new Date(TUESDAY.getTime() - (minutesAgo + 30) * 60000)));
    page.run(`flashTitle("x"); ${setup}`);
    page.run("checkAlarms()");
    return [beeps(page), flashing(page)];
  };
  assert.deepEqual(lunch(-1), [0, false]);
  assert.deepEqual(lunch(0), [1, true]);
  assert.deepEqual(lunch(60), [1, true]);
  assert.deepEqual(lunch(120), [1, true]);
  assert.deepEqual(lunch(121), [0, false]);
  assert.deepEqual(lunch(0, `LastRing.lunch = ${TUESDAY.getTime() - 119999}`), [0, true]);
  assert.deepEqual(lunch(0, `LastRing.lunch = ${TUESDAY.getTime() - 120000}`), [1, true]);
  const none = withAlarms({ sessions: [mondayDone] });
  none.run("checkAlarms()");
  assert.equal(beeps(none), 0);
});

test("resetting the alarms lets the next one ring at once", () => {
  const page = withAlarms({ sessions: [session(at(TUESDAY, 1), null)] });
  page.run("checkAlarms()");
  page.run("checkAlarms()");
  assert.equal(beeps(page), 1);
  page.run("resetAlarms()");
  page.run("checkAlarms()");
  assert.equal(beeps(page), 2);
  assert.deepEqual(page.run("LastRing"), { lunch: 0, rest: 0 });
});

test("the alarms are checked every thirty seconds", () => {
  const page = withAlarms();
  assert.equal(
    page.calls.timers.some(([, ms]) => ms === 30000),
    true,
  );
});

test("an alarm sets the stamp of its own kind and the blinking title starts only once", () => {
  const rest = withAlarms({ sessions: [session(at(TUESDAY, 9, 40), null, true)] });
  rest.run("checkAlarms()");
  assert.deepEqual(rest.run("[LastRing.lunch, LastRing.rest]"), [0, TUESDAY.getTime()]);
  const lunch = withAlarms({ sessions: [mondayDone] });
  lunch.run(lunchedAt(new Date(TUESDAY.getTime() - 40 * 60000)));
  lunch.run("checkAlarms()");
  assert.deepEqual(lunch.run("[LastRing.lunch, LastRing.rest]"), [TUESDAY.getTime(), 0]);
  lunch.run(`flashTitle("otra")`);
  assert.equal(lunch.calls.timers.filter(([, ms]) => ms === 900).length, 1);
});
