// dayedit.js: the day dialog, shared by the management view and the personal page: the day's tooltip, the rows that
// correct its punches, the notice to its owner and the requests it approves. The module's functions are called
// straight from the page's context, each node dumped as one line (show in page.mjs), so a class, an attribute or a
// text that changes shows up as a failing line.

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  answering,
  element,
  load,
  reply,
  settle,
  show,
  showAll,
  teamFixes,
  teamPage,
  teamPayload,
  texts,
  Y25,
} from "./page.mjs";

const LIMITS = { long_day: 12, under_margin: 1 / 60, over_margin: 5 };
const REASONS = [
  { id: 5, name: "Normal" },
  { id: 3, name: "Descanso" },
];
const stamp = (day, h, m = 0, s = 0) => new Date(2025, 2, day, h, m, s).toISOString();
const punch = (id, start, end, hours, extra = {}) => ({
  id,
  in: start,
  out: end,
  hours,
  rest: false,
  reason: "Normal",
  reason_id: 5,
  ...extra,
});
const dayOf = (extra = {}) => ({
  date: "2025-03-04",
  hours: 9,
  target: 8,
  absence: null,
  sessions: [],
  flags: [],
  requests: [],
  ...extra,
});
const OWNER = { id: 1, name: "Álvaro", discord: null };

function details(page, day, options) {
  const box = element("div");
  page.run("dayDetails")(day, LIMITS, options)(box);
  return showAll(box.children);
}

test("the day's tooltip lists its punches and, when they balance, the difference against the target", () => {
  const page = teamPage();
  const day = dayOf({
    sessions: [punch(1, stamp(4, 9), stamp(4, 17), 8), punch(2, stamp(4, 17, 30), stamp(4, 18, 30), 1)],
  });
  const row = (k, v) => ["div.t-row", `  span.k "${k}"`, `  span.v "${v}"`];
  assert.deepEqual(details(page, day), [
    `div.t-title "Mar 4 mar${Y25}"`,
    ...row("09:00–17:00", "8h"),
    ...row("17:30–18:30", "1h"),
    "div.t-sep",
    ...row("Frente a 8h previstas", "+1h"),
  ]);
  assert.deepEqual(details(page, day, { title: false, sessions: false }), [
    "div.t-sep",
    ...row("Frente a 8h previstas", "+1h"),
  ]);
  const quiet = dayOf({ target: 0, sessions: day.sessions });
  assert.deepEqual(details(page, quiet, { title: false }), [...row("09:00–17:00", "8h"), ...row("17:30–18:30", "1h")]);
  assert.deepEqual(details(page, dayOf(), { title: false }), ['div.t-note "Sin fichajes"']);
  assert.deepEqual(details(page, dayOf({ sessions: [punch(3, stamp(4, 9), null, null)] }), { title: false }), [
    ...row("09:00–abierto", "en curso"),
  ]);
});

test("the day's tooltip says why each flag is there, in orange for a session over the limit, and lists requests", () => {
  const page = teamPage();
  const approvable = {
    id: 7,
    from: stamp(4, 9),
    to: stamp(4, 17, 40),
    status: "pending",
    reason: "Olvidé fichar",
    can_approve: true,
  };
  const draft = { id: 8, from: stamp(4, 9), to: null, status: "new", reason: "", can_approve: false };
  const day = dayOf({
    hours: 14.5,
    sessions: [
      punch(1, stamp(4, 9), stamp(4, 23, 30), 14.5),
      punch(2, stamp(4, 10), stamp(4, 22), 12),
      punch(3, stamp(5, 9), null, null),
    ],
    flags: ["long", "open"],
    requests: [approvable, draft],
  });
  const lines = details(page, day, { title: false, employee: 1 });
  assert.deepEqual(lines, [
    "div.t-row.warn",
    '  span.k "09:00–23:30"',
    '  span.v "14h 30m"',
    "div.t-row",
    '  span.k "10:00–22:00"',
    '  span.v "12h"',
    "div.t-row",
    '  span.k "09:00–abierto"',
    '  span.v "en curso"',
    "div.t-sep",
    'div.t-note.warn "14h 30m fichadas en el día, más de 12h"',
    'div.t-note.warn "Entrada a las 09:00 sin salida"',
    "div.t-sep",
    'div.t-note.pending "Solicitud pendiente 09:00–17:40"',
    'div.t-note "Olvidé fichar"',
    'button.btn.small type=button "Aprobar solicitud"',
    "div.t-sep",
    'div.t-note.new "Solicitud borrador 09:00"',
  ]);
  assert.equal(
    details(page, day, { title: false }).includes('button.btn.small type=button "Aprobar solicitud"'),
    false,
  );
});

test("a request reads by its status, a day by its weekday, and what is open or long says so", () => {
  const { run } = teamPage();
  const requestLine = run("requestLine");
  const asks = ["new", "pending", "approved", "refused"].map((status) =>
    requestLine({ from: stamp(4, 9), to: stamp(4, 17, 40), status }),
  );
  assert.deepEqual(asks, [
    "Solicitud borrador 09:00–17:40",
    "Solicitud pendiente 09:00–17:40",
    "Solicitud aprobada 09:00–17:40",
    "Solicitud rechazada 09:00–17:40",
  ]);
  assert.equal(run("dayLabel")("2025-03-04"), `Mar 4 mar${Y25}`);
  assert.equal(run("dayLabel")("2025-03-04", true), "Mar 4 mar 2025");
  assert.equal(run("dayLabel")("2026-09-15"), "Mar 15 sep");
  assert.equal(run("dayLabel")("2026-09-15", true), "Mar 15 sep 2026");
  const open = punch(1, stamp(4, 9), null, null);
  const done = punch(2, stamp(4, 10), stamp(4, 11), 1);
  assert.deepEqual(run("whyDay")("open", { sessions: [done, open] }, LIMITS), ["Entrada a las 09:00 sin salida"]);
  assert.deepEqual(Array.from(run("whyDay")("empty", { sessions: [], target: 8 }, LIMITS)), [
    "Jornada prevista de 8h sin fichajes ni ausencia",
  ]);
  const balanced = run("balanced");
  assert.deepEqual(
    [
      balanced(dayOf({ sessions: [done] })),
      balanced(dayOf({ sessions: [done], target: 0 })),
      balanced(dayOf({ sessions: [done, open] })),
      balanced(dayOf()),
    ],
    [true, false, false, false],
  );
  const wrong = run("wrongSession");
  assert.deepEqual([wrong({ hours: 12.01 }, LIMITS), wrong({ hours: 12 }, LIMITS)], [true, false]);
  assert.equal(
    run("sessionRow")(punch(1, stamp(4, 9), stamp(4, 21), 12), LIMITS, "x").classList.contains("warn"),
    false,
  );
});

test("sessions read as times, and weeks move by seven days", () => {
  const { run } = load({ entry: "team.js" });
  assert.equal(run('shiftWeek("2025-03-03", -1)'), "2025-02-24");
  assert.equal(run('shiftWeek("2025-03-24", 1)'), "2025-03-31");
  const s = (a, b, extra) =>
    JSON.stringify({
      in: a.toISOString(),
      out: b?.toISOString(),
      hours: b ? (b - a) / 3.6e6 : null,
      rest: false,
      ...extra,
    });
  assert.equal(run(`sessionSpan(${s(new Date(2025, 2, 3, 9), new Date(2025, 2, 3, 13, 30))})`), "09:00–13:30");
  assert.equal(
    run(`sessionSpan(${s(new Date(2025, 2, 3, 13, 30), new Date(2025, 2, 3, 13, 45), { rest: true })})`),
    "13:30–13:45 descanso",
  );
  assert.equal(run(`sessionSpan(${s(new Date(2025, 2, 3, 9), null)})`), "09:00–abierto");
  const day = (flags, sessions, extra) =>
    JSON.stringify({ date: "2025-03-03", hours: 14.5, target: 8, flags, sessions, ...extra });
  const limits = JSON.stringify({ long_day: 12, under_margin: 1 / 60 });
  assert.deepEqual(run(`whyDay("long", ${day(["long"], [])}, ${limits})`), ["14h 30m fichadas en el día, más de 12h"]);
  assert.deepEqual(
    run(`whyDay("open", ${day(["open"], [JSON.parse(s(new Date(2025, 2, 3, 9, 5), null))])}, ${limits})`),
    ["Entrada a las 09:05 sin salida"],
  );
});

test("the notice joins a day's reasons with semicolons", () => {
  const { run } = teamPage();
  const day = dayOf({ flags: ["empty", "open"], sessions: [punch(1, stamp(4, 9), null, null)] });
  assert.equal(
    run("noticeText")(day, LIMITS),
    "Tienes un error en el fichaje del martes 4 de marzo: jornada prevista de 8h sin fichajes ni ausencia; " +
      "entrada a las 09:00 sin salida.\nPor favor, haz una solicitud de cambio de fichaje en Odoo.",
  );
});

function dialogOf(page) {
  const [title, body, note] = page.document.getElementById("dayDialog").children;
  return { title, body, note, dialog: page.document.getElementById("dayDialog") };
}

test("the day dialog is built as the page expects", async () => {
  const page = teamPage();
  await settle();
  const { dialog } = dialogOf(page);
  assert.equal(page.document.body.children.includes(dialog), true);
  assert.deepEqual(show(dialog), [
    "dialog#dayDialog.dialog aria-labelledby=dayDialogTitle",
    "  h2#dayDialogTitle",
    "  div#dayDialogBody",
    "  p#dayDialogNote.dialog-note role=status",
    "  div.dialog-actions",
    '    button#dayDialogClose.btn.ghost type=button "Cerrar"',
  ]);
  const event = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  dialog.listeners.cancel[0](event);
  assert.equal(event.prevented, false);
  page.document.getElementById("dayDialogClose").disabled = true;
  dialog.listeners.cancel[0](event);
  assert.equal(event.prevented, true);
});

const EDITABLE = {
  limits: LIMITS,
  can_edit: true,
  reasons: REASONS,
  can_message: false,
};
const LONG_DAY = dayOf({
  hours: 21,
  flags: ["long"],
  sessions: [
    punch(1, stamp(4, 9, 0, 30), stamp(4, 17, 0, 15), 8),
    punch(2, stamp(4, 17, 30), stamp(5, 6, 30), 13, { rest: true, reason: "Descanso", reason_id: 3 }),
  ],
});

test("the day dialog edits each punch of the day in a row of its own, and warns of the one that is too long", async () => {
  const page = teamPage();
  await settle();
  const { title, body, note, dialog } = dialogOf(page);
  note.textContent = "antes";
  page.run("openDay")(OWNER, LONG_DAY, EDITABLE);
  assert.equal(dialog.open, true);
  assert.deepEqual([title.textContent, note.textContent], ["Álvaro", ""]);
  assert.deepEqual(showAll(body.children.slice(0, 2)), [
    `div.t-title "Mar 4 mar${Y25}"`,
    "div.editor",
    "  div.edit-row",
    "    input type=time value=09:00 aria-label=Entrada",
    '    "–"',
    "    input type=time value=17:00 aria-label=Salida",
    "    select value=5 aria-label=Motivo",
    '      option value=5 "Normal"',
    '      option value=3 "Descanso"',
    '    button.btn.ghost.small type=button title=Eliminar este fichaje aria-label=Eliminar este fichaje aria-pressed=false "✕"',
    '    button.btn.ghost.small type=button title=Añadir un fichaje debajo aria-label=Añadir un fichaje debajo "+"',
    "  div.edit-row.warn",
    "    input type=time value=17:30 aria-label=Entrada",
    '    "–"',
    "    input type=time value=06:30 aria-label=Salida",
    '    span.meta "salida el 5 mar 2025"',
    "    select value=3 aria-label=Motivo",
    '      option value=5 "Normal"',
    '      option value=3 "Descanso"',
    '    button.btn.ghost.small type=button title=Eliminar este fichaje aria-label=Eliminar este fichaje aria-pressed=false "✕"',
    '    button.btn.ghost.small type=button title=Añadir un fichaje debajo aria-label=Añadir un fichaje debajo "+"',
    "  div.edit-actions",
    '    button.btn.small type=button "Guardar cambios"',
  ]);
  assert.deepEqual(showAll(body.children.slice(2)), [
    "div.t-sep",
    "div.t-row",
    '  span.k "Frente a 8h previstas"',
    '  span.v "+13h"',
    "div.t-sep",
    'div.t-note.warn "21h fichadas en el día, más de 12h"',
    "div.t-sep",
    "div.notice",
    '  button.btn.ghost.small type=button "Preparar aviso…"',
  ]);
});

test("a day without punches opens one empty row, a punch is marked for deletion and unmarked, a new row goes under its row", async () => {
  const page = teamPage();
  await settle();
  const { body } = dialogOf(page);
  const open = (day, context = EDITABLE) => page.run("openDay")(OWNER, day, context);
  const emptyRow = (reason) => [
    "div.edit-row",
    "  input type=time aria-label=Entrada",
    '  "–"',
    "  input type=time aria-label=Salida",
    ...reason,
    '  button.btn.ghost.small type=button title=Añadir un fichaje debajo aria-label=Añadir un fichaje debajo "+"',
  ];
  const selector = [
    "  select value=5 aria-label=Motivo",
    '    option value=5 "Normal"',
    '    option value=3 "Descanso"',
  ];

  open(dayOf());
  assert.deepEqual(showAll(body.children.slice(1, 2)), [
    "div.editor",
    ...emptyRow(selector).map((line) => `  ${line}`),
    "  div.edit-actions",
    '    button.btn.small type=button "Guardar cambios"',
  ]);

  open(dayOf({ sessions: [punch(1, stamp(4, 9), stamp(4, 17), 8, { rest: true })] }), { ...EDITABLE, reasons: [] });
  const [editor] = body.children.slice(1, 2);
  const [row] = editor.children;
  assert.deepEqual(showAll(row.children.slice(3, 4)), ['span.meta "descanso"']);
  const [start, , end, , drop, add] = row.children;
  drop.listeners.click[0]();
  assert.deepEqual(
    [
      row.classList.contains("gone"),
      start.disabled,
      end.disabled,
      drop.title,
      drop.attrs["aria-label"],
      drop.attrs["aria-pressed"],
    ],
    [true, true, true, "No eliminar este fichaje", "No eliminar este fichaje", "true"],
  );
  drop.listeners.click[0]();
  assert.deepEqual(
    [
      row.classList.contains("gone"),
      start.disabled,
      end.disabled,
      drop.title,
      drop.attrs["aria-label"],
      drop.attrs["aria-pressed"],
    ],
    [false, false, false, "Eliminar este fichaje", "Eliminar este fichaje", "false"],
  );
  add.listeners.click[0]();
  assert.equal(editor.children.length, 3);
  assert.deepEqual(show(editor.children[1]), emptyRow([]));
  assert.equal(editor.children[2].className, "edit-actions");
});

test("a read-only dialog lists the punches, and a day with an error folds its message behind a button", async () => {
  const page = teamPage();
  await settle();
  const { body } = dialogOf(page);
  const focused = [];
  const make = page.document.createElement;
  page.document.createElement = (tag) => {
    const node = make(tag);
    node.focus = () => focused.push(tag);
    return node;
  };
  const open = (context) => page.run("openDay")({ ...OWNER, discord: "123" }, LONG_DAY, context);
  open({ ...EDITABLE, can_edit: false });
  assert.deepEqual(showAll(body.children).slice(0, 8), [
    `div.t-title "Mar 4 mar${Y25}"`,
    "div.t-row",
    '  span.k "09:00–17:00"',
    '  span.v "8h"',
    "div.t-row.warn",
    '  span.k "17:30–06:30 descanso"',
    '  span.v "13h"',
    "div.t-sep",
  ]);
  assert.equal(
    body.children.some((child) => child.className === "editor"),
    false,
  );
  const notice = body.children.at(-1);
  assert.deepEqual(show(notice), ["div.notice", '  button.btn.ghost.small type=button "Preparar aviso…"']);

  open({ ...EDITABLE, can_message: true });
  const folded = body.children.at(-1);
  assert.deepEqual(show(folded), ["div.notice", '  button.btn.ghost.small type=button "Avisar por Discord…"']);
  folded.children[0].listeners.click[0]();
  assert.deepEqual(focused, ["textarea"]);
  const text =
    "Tienes un error en el fichaje del martes 4 de marzo: 21h fichadas en el día, más de 12h.\n" +
    "Por favor, haz una solicitud de cambio de fichaje en Odoo.";
  assert.deepEqual(show(folded), [
    "div.notice",
    `  textarea rows=4 value=${text} aria-label=Mensaje para avisar del error`,
    "  div.edit-actions",
    '    button.btn.small type=button title=Al final se añade que es automático, que te escriba a ti y un botón para hacer la solicitud en Odoo "Enviar"',
    '    button.btn.ghost.small type=button "Copiar"',
    '    button.btn.ghost.small type=button "Cancelar"',
  ]);
  folded.children[1].children[2].listeners.click[0]();
  assert.deepEqual(show(folded).length, 2);

  open({ ...EDITABLE, can_message: true });
  const noDiscord = page.run("noticeBox")(OWNER, LONG_DAY, LIMITS, true);
  noDiscord.children[0].listeners.click[0]();
  assert.deepEqual(showAll(noDiscord.children[1].children), [
    'button.btn.small type=button "Copiar"',
    'button.btn.ghost.small type=button "Cancelar"',
    'span.meta "Sin Discord en su ficha de Odoo"',
  ]);
});

test("the dialog shows the dialog once, hides the tooltip and clears the last note when it reopens", async () => {
  const page = teamPage();
  await settle();
  const { dialog, note } = dialogOf(page);
  let shown = 0;
  dialog.showModal = () => {
    shown += 1;
    dialog.open = true;
  };
  const node = element("div");
  page.run("attachTip")(node, (box) => box.appendChild(page.run("el")("div", "t-title", "Hola")));
  node.listeners.pointerenter[0]({ clientX: 1, clientY: 1 });
  note.textContent = "Guardado.";
  page.run("openDay")(OWNER, dayOf(), EDITABLE);
  page.run("openDay")(OWNER, dayOf(), EDITABLE);
  assert.equal(shown, 1);
  assert.deepEqual([page.run("tipOpen()"), note.textContent], [false, ""]);
});

test("a button that acts for real asks to be confirmed, locks the dialog while it works and says what failed", async () => {
  const timers = [],
    cleared = [];
  const page = teamPage({
    globals: {
      setTimeout: (fn, ms) => timers.push([fn, ms]),
      clearTimeout: (id) => cleared.push(id),
    },
  });
  await settle();
  const { note } = dialogOf(page);
  const close = page.document.getElementById("dayDialogClose");
  let release;
  let outcome = Promise.resolve();
  const work = () => outcome;
  const button = page.run("confirmButton")("Aprobar", "No se pudo aprobar", work);
  assert.deepEqual(show(button), ['button.btn.small type=button "Aprobar"']);
  await button.listeners.click[0]();
  assert.equal(button.textContent, "¿Confirmar?");
  assert.deepEqual(
    timers.map(([, ms]) => ms),
    [4000],
  );
  timers[0][0]();
  assert.equal(button.textContent, "Aprobar");
  await button.listeners.click[0]();
  outcome = new Promise((resolve) => {
    release = resolve;
  });
  const done = button.listeners.click[0]();
  assert.deepEqual(cleared, [2]);
  assert.deepEqual([button.textContent, button.disabled, close.disabled], ["Aprobar", true, true]);
  release();
  await done;
  assert.deepEqual([button.disabled, close.disabled, note.textContent], [false, false, ""]);
  await button.listeners.click[0]();
  outcome = Promise.reject(new Error("se solapa"));
  await button.listeners.click[0]();
  assert.equal(note.textContent, "No se pudo aprobar: se solapa");
  assert.deepEqual([button.disabled, close.disabled], [false, false]);
});

test("a punch changed in one field keeps the other as Odoo has it, down to the second", () => {
  const { run } = teamPage();
  const entry = (s, start, end, reason = null, gone = false) => ({
    s,
    start: { value: start },
    end: { value: end },
    reason,
    gone,
  });
  const changes = (entries) => JSON.parse(JSON.stringify(run("punchChanges")("2025-03-04", entries)));
  const s = punch(1, stamp(4, 9, 0, 30), stamp(4, 17, 0, 15), 8);
  assert.deepEqual(changes([entry(s, "09:00", "17:30")]), [
    { id: 1, check_in: s.in, check_out: new Date(2025, 2, 4, 17, 30).toISOString() },
  ]);
  assert.deepEqual(changes([entry(s, "08:45", "17:00")]), [
    { id: 1, check_in: new Date(2025, 2, 4, 8, 45).toISOString(), check_out: s.out },
  ]);
  assert.deepEqual(changes([entry(s, "09:00", "17:00", { value: "3" })]), [
    { id: 1, check_in: s.in, check_out: s.out, reason: 3 },
  ]);
  assert.deepEqual(changes([entry(s, "09:00", "17:00", { value: "5" })]), []);
  assert.deepEqual(changes([entry(null, "10:00", "11:00"), entry(s, "", "", null, true)]), [
    { id: 1, gone: true },
    { check_in: new Date(2025, 2, 4, 10).toISOString(), check_out: new Date(2025, 2, 4, 11).toISOString() },
  ]);
  assert.throws(() => changes([entry(s, "09:00", "")]), /cada fichaje necesita entrada y salida/);
});

test("a reason selector keeps the punch's own reason, even when it is not on offer or missing", () => {
  const { run } = teamPage();
  const field = run("reasonField");
  assert.deepEqual(show(field(null, REASONS)), [
    "select value=5 aria-label=Motivo",
    '  option value=5 "Normal"',
    '  option value=3 "Descanso"',
  ]);
  assert.deepEqual(show(field(punch(1, stamp(4, 9), null, null, { reason: "Otro", reason_id: 9 }), REASONS)), [
    "select value=9 aria-label=Motivo",
    '  option value=9 "Otro"',
    '  option value=5 "Normal"',
    '  option value=3 "Descanso"',
  ]);
  assert.deepEqual(show(field(punch(1, stamp(4, 9), null, null, { reason: null, reason_id: null }), REASONS)), [
    "select aria-label=Motivo",
    '  option "sin motivo"',
    '  option value=5 "Normal"',
    '  option value=3 "Descanso"',
  ]);
});

test("reopening a day reads its week, ignores a person or a day that is not there and logs a failure", async () => {
  let failing = false;
  const page = teamPage({
    fetchImpl: answering((url) => {
      if (failing && url.endsWith("week=2025-03-04")) return reply({ error: "boom" }, 500);
    }),
  });
  await settle();
  const { dialog, note, title } = dialogOf(page);
  await page.run("openDayOf")(99, "2025-03-04");
  await page.run("openDayOf")(1, "2025-03-20");
  assert.equal(dialog.open, false);
  await page.run("openDayOf")(1, "2025-03-04");
  assert.equal(dialog.open, true);
  assert.equal(title.textContent, "Álvaro");
  dialog.open = false;
  failing = true;
  await page.run("refreshDay")(1, "2025-03-04", "Guardado.");
  assert.deepEqual([dialog.open, note.textContent], [false, "Guardado."]);
  assert.deepEqual(page.calls.warnings, ["[odoo] reopening the day failed: Error: boom"]);
});

test("a click on a day opens its details in a dialog that closes", async () => {
  const page = load({ entry: "team.js", data: teamPayload() });
  await settle();
  const alvaro = page.document.getElementById("grid").children[1].children[0].children;
  alvaro[2].listeners.click[0]();
  const dialog = page.document.getElementById("dayDialog");
  assert.equal(dialog.open, true);
  assert.equal(page.document.getElementById("dayDialogTitle").textContent, "Álvaro");
  assert.deepEqual(texts(page.document.getElementById("dayDialogBody")).slice(0, 6), [
    `Mar 4 mar${Y25}`,
    "Sin fichajes",
    "Jornada prevista de 8h sin fichajes ni ausencia",
    "Solicitud pendiente 09:00–17:40",
    "Olvidé fichar",
    "Solicitud rechazada 09:00",
  ]);
  page.document.getElementById("dayDialogClose").listeners.click[0]();
  assert.equal(dialog.open, false);
  alvaro[3].listeners.keydown[0]({ key: "Enter" });
  assert.equal(dialog.open, true);
  assert.deepEqual(texts(page.document.getElementById("dayDialogBody")).slice(0, 1), [`Mié 5 mar${Y25}`]);
  alvaro[3].listeners.keydown[0]({ key: "Tab" });
  assert.equal(dialog.listeners.click, undefined);
});

test("a day with a punch error offers its owner's message, to send by Discord or to copy", async () => {
  let clipboard = {
    writeText: async (text) => {
      copied.push(text);
    },
  };
  const copied = [],
    posts = [];
  const data = teamPayload();
  let answer = { ok: true, status: 200, json: async () => ({ ok: true }) };
  const page = load({
    entry: "team.js",
    globals: {
      navigator: {
        get clipboard() {
          return clipboard;
        },
      },
    },
    fetchImpl: async (url, opts) => {
      if (opts?.method === "POST") {
        posts.push([url, JSON.parse(opts.body)]);
        return answer;
      }
      return { ok: true, status: 200, json: async () => (url.includes("fixes") ? teamFixes() : data) };
    },
  });
  await settle();
  const doc = page.document;
  const cell = (i) => doc.getElementById("grid").children[1].children[0].children[i];
  const notice = () => doc.getElementById("dayDialogBody").children.find((c) => c.className === "notice");
  const actions = () => notice().children[1].children;
  const button = (label) => actions().find((b) => b.textContent === label);
  const note = () => doc.getElementById("dayDialogNote").textContent;
  const unfold = (label) => {
    assert.deepEqual(
      notice().children.map((c) => c.textContent),
      [label],
    );
    notice().children[0].listeners.click[0]();
  };
  cell(3).listeners.click[0]();
  assert.equal(notice(), undefined);
  cell(2).listeners.click[0]();
  unfold("Preparar aviso…");
  const text = notice().children[0];
  assert.equal(
    text.value,
    "Tienes un error en el fichaje del martes 4 de marzo: jornada prevista de 8h sin " +
      "fichajes ni ausencia.\nPor favor, haz una solicitud de cambio de fichaje en Odoo.",
  );
  assert.deepEqual(
    actions().map((b) => [b.textContent, b.className]),
    [
      ["Copiar", "btn small"],
      ["Cancelar", "btn ghost small"],
    ],
  );
  text.value = "Hola, revisa el martes";
  button("Cancelar").listeners.click[0]();
  unfold("Preparar aviso…");
  assert.equal(notice().children[0].value, "Hola, revisa el martes");
  await button("Copiar").listeners.click[0]();
  assert.deepEqual([copied, note()], [["Hola, revisa el martes"], "Mensaje copiado."]);
  clipboard = {
    writeText: async () => {
      throw new Error("denegado");
    },
  };
  await button("Copiar").listeners.click[0]();
  assert.equal(note(), "No se pudo copiar: el mensaje está seleccionado, cópialo con ⌘C o Ctrl+C.");
  assert.equal(text.selected, true);
  clipboard = undefined;
  await button("Copiar").listeners.click[0]();
  assert.equal(note(), "No se pudo copiar: el mensaje está seleccionado, cópialo con ⌘C o Ctrl+C.");

  page.run("team.data.can_message = true");
  cell(2).listeners.click[0]();
  unfold("Preparar aviso…");
  assert.deepEqual(
    actions().map((b) => b.textContent),
    ["Copiar", "Cancelar", "Sin Discord en su ficha de Odoo"],
  );
  page.run("team.data.employees.find(e => e.name === 'Álvaro').discord = '123456789012345678'");
  cell(2).listeners.click[0]();
  unfold("Avisar por Discord…");
  assert.deepEqual(
    actions().map((b) => [b.textContent, b.className]),
    [
      ["Enviar", "btn small"],
      ["Copiar", "btn ghost small"],
      ["Cancelar", "btn ghost small"],
    ],
  );
  assert.equal(
    button("Enviar").title,
    "Al final se añade que es automático, que te escriba a ti y un botón para hacer la solicitud en Odoo",
  );
  notice().children[0].value = "Revisa el martes";
  const send = button("Enviar");
  await send.listeners.click[0]();
  await send.listeners.click[0]();
  await settle();
  assert.deepEqual(posts, [["/api/team/discord", { employee: 1, date: "2025-03-04", text: "Revisa el martes" }]]);
  assert.equal(note(), "Mensaje enviado a Álvaro por Discord.");
  answer = { ok: false, status: 502, json: async () => ({ error: "Discord no responde" }) };
  await send.listeners.click[0]();
  await send.listeners.click[0]();
  await settle();
  assert.equal(note(), "No se pudo enviar: Discord no responde");
});

test("the day dialog corrects punches and approves a request, with a second click each", async () => {
  const data = {
    ...teamPayload(),
    can_edit: true,
    reasons: [
      { id: 5, name: "Normal" },
      { id: 3, name: "Descanso" },
    ],
  };
  const alvaro = data.employees.find((e) => e.name === "Álvaro");
  const at = (d, h, m = 0) => new Date(2025, 2, d, h, m).toISOString();
  alvaro.days[0] = {
    ...alvaro.days[0],
    hours: 23.6,
    flags: ["long"],
    sessions: [
      { id: 11, in: at(3, 8, 36), out: at(3, 15, 45), hours: 7.15 },
      { id: 12, in: at(3, 16, 7), out: at(4, 8, 34), hours: 16.45, reason: "Normal", reason_id: 5 },
      { id: 13, in: at(3, 16, 50), out: at(3, 17), hours: 0.17, rest: true, reason: "Descanso", reason_id: 3 },
    ],
    requests: [
      {
        id: 552,
        from: at(3, 8, 30),
        to: at(3, 17, 40),
        status: "pending",
        reason: "Salí a las 17:40",
        can_approve: true,
      },
    ],
  };
  const posts = [];
  let answer = { ok: true, status: 200, json: async () => ({ ok: true, lost_entry: at(4, 8, 34) }) };
  let refused = null;
  const overlap = { ok: false, status: 409, json: async () => ({ error: "se solapa" }) };
  const page = load({
    entry: "team.js",
    fetchImpl: async (url, opts) => {
      if (opts?.method === "POST") {
        posts.push([url, JSON.parse(opts.body)]);
        return url === refused ? overlap : answer;
      }
      return { ok: true, status: 200, json: async () => (url.includes("fixes") ? teamFixes() : data) };
    },
  });
  await settle();
  const doc = page.document;
  const cell = () => doc.getElementById("grid").children[1].children[0].children[1];
  cell().listeners.click[0]();
  const body = doc.getElementById("dayDialogBody");
  const note = () => doc.getElementById("dayDialogNote").textContent;
  const editor = () => body.children[1];
  const rows = () => editor().children.filter((c) => c.className.startsWith("edit-row"));
  const inputs = (i) => rows()[i].children.filter((c) => c.tagName === "INPUT");
  const motive = (i) => rows()[i].children.find((c) => c.tagName === "SELECT");
  const plus = (i) => rows()[i].children.at(-1);
  const saveButton = () => editor().children.at(-1).children[0];
  const twice = async (button) => {
    await button.listeners.click[0]();
    await button.listeners.click[0]();
    await settle();
  };
  assert.deepEqual(
    rows().map((r) => r.className),
    ["edit-row", "edit-row warn", "edit-row"],
  );
  assert.deepEqual(
    inputs(1).map((i) => i.value),
    ["16:07", "08:34"],
  );
  assert.ok(rows()[1].children.some((c) => c.textContent === "salida el 4 mar 2025"));
  assert.deepEqual(
    [0, 1, 2].map((i) => motive(i).value),
    ["", "5", "3"],
  );
  assert.deepEqual(
    motive(0).children.map((o) => [o.value, o.textContent]),
    [
      ["", "sin motivo"],
      ["5", "Normal"],
      ["3", "Descanso"],
    ],
  );
  assert.deepEqual(
    motive(1).children.map((o) => o.textContent),
    ["Normal", "Descanso"],
  );
  assert.equal(motive(1).attrs["aria-label"], "Motivo");

  assert.deepEqual([plus(0).textContent, plus(0).attrs["aria-label"]], ["+", "Añadir un fichaje debajo"]);
  const save = saveButton();
  await save.listeners.click[0]();
  assert.equal(save.textContent, "¿Confirmar?");
  page.calls.timeouts.at(-1)[0]();
  assert.equal(save.textContent, "Guardar cambios");
  await twice(save);
  assert.equal(note(), "No hay cambios que guardar.");

  inputs(1)[1].value = "17:40";
  const close = doc.getElementById("dayDialogClose");
  const held = [];
  const cancel = (e) => {
    let refused = false;
    doc.getElementById("dayDialog").listeners.cancel[0]({
      preventDefault: () => {
        refused = true;
      },
    });
    held.push([close.disabled, refused]);
  };
  await saveButton().listeners.click[0]();
  const saving = saveButton().listeners.click[0]();
  cancel();
  await saving;
  await settle();
  cancel();
  assert.deepEqual(held, [
    [true, true],
    [false, false],
  ]);
  assert.deepEqual(posts.at(-1), [
    "/api/team/attendance",
    { id: 12, check_in: at(3, 16, 7), check_out: at(3, 17, 40) },
  ]);
  assert.equal(
    note(),
    "Guardado. La salida original, 4 mar 2025 a las 08:34, era probablemente la entrada de ese día: añádela allí.",
  );
  assert.equal(doc.getElementById("dayDialog").open, true);

  answer = { ok: true, status: 200, json: async () => ({ ok: true, lost_entry: null }) };
  motive(2).value = "5";
  await twice(saveButton());
  assert.deepEqual(posts.at(-1), [
    "/api/team/attendance",
    { id: 13, check_in: at(3, 16, 50), check_out: at(3, 17), reason: 5 },
  ]);
  plus(0).listeners.click[0]();
  await twice(saveButton());
  assert.equal(note(), "No hay cambios que guardar.");
  const fresh = 1;
  assert.deepEqual(
    rows().map((r) => r.className),
    ["edit-row", "edit-row", "edit-row warn", "edit-row"],
  );
  assert.deepEqual([inputs(fresh).map((i) => i.value), motive(fresh).value], [["", ""], "5"]);
  assert.deepEqual(
    rows()
      [fresh].children.filter((c) => c.tagName === "BUTTON")
      .map((b) => b.textContent),
    ["+"],
  );
  inputs(fresh)[0].value = "08:34";
  await twice(saveButton());
  assert.match(note(), /cada fichaje necesita entrada y salida$/);
  inputs(fresh)[1].value = "15:00";
  inputs(0)[0].value = "08:40";
  await twice(saveButton());
  assert.deepEqual(posts.slice(-2), [
    ["/api/team/attendance", { id: 11, check_in: at(3, 8, 40), check_out: at(3, 15, 45) }],
    ["/api/team/attendance", { employee: 1, check_in: at(3, 8, 34), check_out: at(3, 15), reason: 5 }],
  ]);
  assert.equal(note(), "Guardado.");

  const cross = (i) => rows()[i].children.at(-2);
  assert.deepEqual(
    [cross(1).textContent, cross(1).title, cross(1).attrs["aria-pressed"]],
    ["✕", "Eliminar este fichaje", "false"],
  );
  cross(1).listeners.click[0]();
  assert.deepEqual(
    [
      rows()[1].className,
      inputs(1).map((i) => i.disabled),
      motive(1).disabled,
      cross(1).attrs["aria-label"],
      cross(1).attrs["aria-pressed"],
    ],
    ["edit-row warn gone", [true, true], true, "No eliminar este fichaje", "true"],
  );
  cross(1).listeners.click[0]();
  assert.deepEqual(
    [rows()[1].className, inputs(1).map((i) => i.disabled), cross(1).title],
    ["edit-row warn", [false, false], "Eliminar este fichaje"],
  );
  await twice(saveButton());
  assert.equal(note(), "No hay cambios que guardar.");
  inputs(0)[1].value = "17:00";
  inputs(1)[1].value = "";
  cross(1).listeners.click[0]();
  await twice(saveButton());
  assert.deepEqual(posts.slice(-2), [
    ["/api/team/delete", { id: 12, gone: true }],
    ["/api/team/attendance", { id: 11, check_in: at(3, 8, 36), check_out: at(3, 17) }],
  ]);
  assert.equal(note(), "Guardado.");

  refused = "/api/team/attendance";
  inputs(0)[1].value = "17:00";
  await twice(saveButton());
  assert.equal(note(), "No se pudo guardar: se solapa");
  assert.equal(inputs(0)[1].value, "17:00");
  cross(1).listeners.click[0]();
  await twice(saveButton());
  assert.equal(note(), "Guardado solo en parte; no se pudo el resto: se solapa.");
  assert.deepEqual([rows()[1].className, inputs(0)[1].value], ["edit-row warn", "15:45"]);
  refused = null;

  const approve = () => body.children.find((c) => c.textContent === "Aprobar solicitud");
  await twice(approve());
  assert.deepEqual(posts.at(-1), ["/api/team/approve", { id: 552 }]);
  assert.equal(note(), "Solicitud aprobada.");
  answer = { ok: false, status: 409, json: async () => ({ error: "no eres aprobador" }) };
  await twice(approve());
  assert.equal(note(), "No se pudo aprobar: no eres aprobador");

  const blame = page.run(`toBlame([{ in: "${at(3, 8, 36)}", out: "${at(3, 15, 45)}", hours: 7.15 },
    { in: "${at(3, 16, 7)}", out: "${at(4, 8, 34)}", hours: 16.45 }], team.fixes.limits).map(s => s.hours)`);
  assert.deepEqual(blame, [16.45]);
  const adding =
    page.run(`toBlame([{ in: "${at(3, 8)}", out: "${at(3, 14)}", hours: 6 }, { in: "${at(3, 12)}", out: "${at(3, 19)}", hours: 7 }],
    team.fixes.limits).length`);
  assert.equal(adding, 2);
  const open = `{ s: { id: 9, in: "${at(3, 9)}", out: null }, start: { value: "09:00" }, end: { value: VALUE } }`;
  assert.deepEqual(page.run(`punchChanges("2025-03-03", [${open.replace("VALUE", '""')}])`), []);
  assert.deepEqual(page.run(`punchChanges("2025-03-03", [${open.replace("VALUE", '"14:00"')}])`), [
    { id: 9, check_in: at(3, 9), check_out: at(3, 14) },
  ]);
  const other = page.run(
    `(f => [f.value, f.children.map(o => o.textContent)])(reasonField({ reason: "Felt Sick", reason_id: 8 }, team.data.reasons))`,
  );
  assert.deepEqual(other, ["8", ["Felt Sick", "Normal", "Descanso"]]);
  const plain =
    page.run(`punchEditor({ id: 1 }, { date: "2025-03-03", sessions: [{ id: 13, in: "${at(3, 16, 50)}", out: "${at(3, 17)}", rest: true }] },
    team.data.limits, []).children[0].children.at(-3).textContent`);
  assert.equal(plain, "descanso");
  const empty = page.run(
    `punchEditor({ id: 1 }, { date: "2025-03-04", sessions: [] }, team.data.limits, []).children.map(c => c.className)`,
  );
  assert.deepEqual(empty, ["edit-row", "edit-actions"]);
  answer = { ok: true, status: 200, json: async () => ({ ok: true }) };
  data.employees = data.employees.filter((e) => e !== alvaro);
  inputs(0)[0].value = "08:45";
  await twice(saveButton());
  assert.equal(note(), "Guardado.");
});
