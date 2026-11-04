/*
 * Rendering of the personal page below the hero (hero.js): the KPIs, the weekly chart, the navigable week card with
 * its two views (timeline «Horario» and hours per day «Objetivo»), the table and the banner of punches to fix.
 *
 * - Every sentence quoting the schedule is generated from it (scheduleSentence).
 * - The banner under the hero lists this person's punch errors (week.js's punchErrors), whoever is looking and
 *   whatever their rights: it reads only this page's own sessions. Each one opens its week. It folds (closed by
 *   default, the count in its title) and keeps whatever the viewer left it at across repaints. A missed day also
 *   reads «sin fichar» in orange in both calendar views instead of a bare dash. In the weekly chart a week with a
 *   punch error (a too long session or a missed day) is orange, with a thin orange line just under the axis so a
 *   week with nothing punched still shows it (under it, not on it: on it, it read as a few hours punched), and its
 *   tooltip says why. The chart's grid keeps about six lines whatever the tallest week: a 230 h week used to draw
 *   one every 10 h. Its scale leaves out suspect weeks, which run to the top: one forgotten check-out flattened
 *   every other column. A click (or Enter) on a column opens that week in the calendar, as a banner entry does
 *   (showWeek). The average and balance tiles turn orange with a note when a finished week they count has a punch
 *   error: they cannot be trusted. «Horario habitual» averages only days without a punch error: a check-out on the
 *   next morning read as leaving at 8:36, and an open entry skewed the mean the same way. When the days worked had
 *   more than one scheduled length (week.js's scheduled: 8 h 30 m from Monday to Thursday and 6 h on Fridays, or a
 *   contract that changed), it is one tile per length, named after it, longest first: one mean over all of them
 *   was the hours of no real day. A day with nothing scheduled then fits no length and is left out.
 * - In the timeline a gap is only what no hour leave covers (hero.js's uncovered), and leaves and gaps say what
 *   they are in the page's own tooltip, as sessions do: a narrow block cuts its text short.
 * - A session longer than the payload's long_hours is drawn orange (a punch error, style.css) in the timeline, and
 *   so is its day's total in both calendar views: it is nearly always a forgotten check-out. A session that ends
 *   on a later day runs to midnight on its check-in day, labelled with the days it spans («15:00 – 09:00 (+1)»);
 *   its end hour used to come before its start and left a sliver. A week holding such a session never claims its
 *   target reached: the hero, the week card's badge and the table say a punch needs checking instead, the card's
 *   total says its sum cannot be trusted, and the day's bar is red in «Objetivo» too. A week with a missed day
 *   says a punch needs checking the same way (week.error).
 * - «Objetivo» scales its bars to the week shown, leaving out its long days, which run to the edge: scaled to the
 *   longest day of the whole history, one forgotten check-out of hundreds of hours shrank every normal day to a
 *   sliver.
 * - For a session that may change punches (the payload's can_edit), each day in the banner has «Corregir», which
 *   opens it in the correcting dialog of dayedit.js, as the management view does; saving reloads this page. A day
 *   with a request the viewer may approve has «Revisar» instead when they may not correct. On someone else's page,
 *   whoever may approve their pending change requests gets them in the same banner (the payload's requests; the
 *   employee never sees them), in blue, grouped with the punch errors of their day: one line and one «Corregir»
 *   per day, whose dialog also approves the request. On their own page, every day also has «Solicitar cambio»,
 *   beside «Corregir» for whoever may correct: some who may still have to file a request for their own punches.
 *   It opens Odoo's change request form for that day, filled as the Discord notice's button (discord.py),
 *   in a tab opened on the click itself, since one opened after the server's answer is a popup Safari blocks
 *   (openRequest). The header's «Nueva solicitud» opens the same form empty, for any other day, on their own
 *   page alike.
 * - Red and grey follow the management view's rule (team.js): hours over target are never green, only grey,
 *   and a finished week short of its target is red only when the range shown (the «Mostrar» buttons) is short
 *   too, the balance tile's own sum (rangeShort): a short week made up by the rest of the range is grey, in the
 *   week card's badge, the chart's tooltip and the table alike. A week with a punch error stays orange.
 * - Colours: never hardcode one here. Two call sites build the token name at runtime (var(--${…})) and go
 *   silently colourless when a token is renamed; the palette and its rules are in style.css.
 */

import { openDayOf } from "./dayedit.js";
import {
  dayKey,
  fmtClock,
  fmtDate,
  fmtDay,
  fmtDelta,
  fmtHM,
  fmtShort,
  fmtTime,
  hourOf,
  isoDay,
  plural,
} from "./format.js";
import { renderPhone, uncovered, unloggedGap } from "./hero.js";
import { api, byId, el } from "./shared.js";
import { DayFull, DayNames, store } from "./store.js";
import { attachTip, tipRow } from "./tip.js";
import {
  buildWeek,
  buildWeeks,
  dayError,
  longDay,
  missed,
  punchErrors,
  targetLabel,
  unclosed,
  weekOffsetOf,
  weekRangeLabel,
  weeksSince,
} from "./week.js";

/**
 * @typedef {import("./week.js").Day} Day
 * @typedef {import("./week.js").Week} Week
 * @typedef {import("./store.js").DaySession} DaySession
 */

/**
 * One entry of the banner of punches to fix: a class, what it is and what it says of the day.
 * @typedef {[string, string, string]} Piece
 */

/**
 * @param {DaySession[]} sessions
 * @returns {{from: number, to: number}[]}
 */
function restSpans(sessions) {
  let before = 0;
  return sessions.flatMap((s) => {
    const span = s.rest ? [{ from: before, to: before + s.hours }] : [];
    before += s.hours;
    return span;
  });
}

/**
 * Draws a day's breaks inside its bar, each at its place as a share of the day's total.
 * @template {HTMLElement} T
 * @param {T} bar
 * @param {DaySession[]} sessions
 * @param {number} total
 * @returns {T}
 */
export function fillBar(bar, sessions, total) {
  for (const span of restSpans(sessions)) {
    const seg = el("div", "rest");
    seg.style.left = `${(span.from / total) * 100}%`;
    seg.style.width = `${((span.to - span.from) / total) * 100}%`;
    bar.appendChild(seg);
  }
  return bar;
}

/* ---------- KPIs ---------- */
/** @param {Week[]} weeks */
export function renderKpis(weeks) {
  const done = weeks.filter((w) => w.complete);
  const working = done.filter((w) => w.target > 0);
  const kpis = byId("kpis");
  kpis.replaceChildren();
  /**
   * @param {string} label
   * @param {string} valueText
   * @param {string | null} [foot]
   * @param {string | null} [valueCls]
   * @returns {HTMLDivElement}
   */
  function tile(label, valueText, foot, valueCls) {
    const c = el("div", "card");
    c.appendChild(el("span", "label", label));
    const v = el("div", "value num", valueText);
    if (valueCls) v.classList.add(valueCls);
    c.appendChild(v);
    // Stryker disable next-line ConditionalExpression: every tile is given a foot, so the guard is always true
    if (foot) c.appendChild(el("div", "foot", foot));
    return c;
  }
  if (!done.length) return;
  const balance = done.reduce((a, w) => a + w.delta, 0);
  const wrong = done.filter((w) => w.error).length;
  /** @param {number} n */
  const unreliable = (n) =>
    el(
      "div",
      "foot warn",
      `⚠ No fiable: ${plural(n, "semana", "semanas")} con ` +
        "fichajes incorrectos (jornadas muy largas, entradas sin cerrar o días sin fichar)",
    );
  const wrongWorking = working.filter((w) => w.error).length;
  const averageTile = tile(
    "Media semanal",
    working.length ? fmtHM(working.reduce((a, w) => a + w.total, 0) / working.length) : "—",
    plural(working.length, "semana laborable completa", "semanas laborables completas"),
    wrongWorking ? "warn" : null,
  );
  if (wrongWorking) averageTile.appendChild(unreliable(wrongWorking));
  kpis.appendChild(averageTile);
  const balanceTile = tile(
    "Balance frente al objetivo",
    fmtDelta(balance),
    balance >= 0 ? "acumulado a favor" : "acumulado en contra",
    wrong ? "warn" : balance <= -1 / 60 ? "down" : null,
  );
  if (wrong) balanceTile.appendChild(unreliable(wrong));
  kpis.appendChild(balanceTile);

  const worked = weeks.flatMap((w) => w.days).filter((d) => d.sessions.length && !dayError(d));
  /** @param {Date} d */
  const minsOf = (d) => d.getHours() * 60 + d.getMinutes();
  /** @param {number[]} list */
  const avgTime = (list) => {
    if (!list.length) return null;
    const m = Math.round(list.reduce((a, v) => a + v, 0) / list.length);
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  const byLength = worked
    .filter((d) => d.scheduled > 0)
    .reduce(
      (m, d) => m.set(d.scheduled, [...(m.get(d.scheduled) || []), d]),
      /** @type {Map<number, Day[]>} */ (new Map()),
    );
  const split = byLength.size > 1;
  /** @type {[number, Day[]][]} */ (split ? [...byLength].sort(([a], [b]) => b - a) : [[0, worked]]).forEach(
    ([hours, days]) => {
      const entry = avgTime(days.map((d) => minsOf(d.sessions[0].in)));
      const exit = avgTime(
        days
          .filter((d) => /** @type {DaySession} */ (d.sessions.at(-1)).out)
          .map((d) => minsOf(/** @type {Date} */ (/** @type {DaySession} */ (d.sessions.at(-1)).out))),
      );
      if (entry && exit) {
        kpis.appendChild(
          tile(
            `Horario habitual${split ? ` · jornada de ${fmtHM(hours)}` : ""}`,
            `${entry} – ${exit}`,
            `entrada y salida medias · ${plural(days.length, "día", "días")}`,
          ),
        );
      }
    },
  );
}

/* ---------- overview chart ---------- */
/** @returns {string} */
export function scheduleSentence() {
  const groups = /** @type {Map<number, string[]>} */ (new Map());
  store.expected.forEach((hours, day) => {
    if (hours <= 0) return;
    const names = groups.get(hours) || [];
    names.push(DayFull[day]);
    groups.set(hours, names);
  });
  const parts = [...groups].map(([hours, names]) => {
    const span = names.length > 2 ? `de ${names[0]} a ${names.at(-1)}` : `los ${names.join(" y ")}`;
    return `${fmtHM(hours)} ${span}`;
  });
  return parts.join(", ");
}

/** @param {Week[]} weeks */
export function renderOverview(weeks) {
  byId("overviewTitle").textContent = `Total semanal frente al objetivo de ${fmtHM(store.weekTarget)}`;
  const adjusted = weeks.some((w) => w.target !== store.weekTarget && w.target > 0);
  byId("overviewCaption").textContent =
    "Cada columna es una semana; la actual, en azul claro; abajo, en morado, el descanso fichado; en naranja, " +
    "las semanas con un error de fichaje (una jornada muy larga, una entrada sin cerrar o un día sin fichar). " +
    "Pulsa una para verla arriba." +
    (adjusted ? " Las semanas con ausencias o permisos llevan su objetivo ajustado como marca horizontal." : "");

  const BaseW = 940,
    MinBand = 38,
    H = 250,
    MinSegH = 3;
  const m = { l: 34, r: 84, t: 14, b: 34 };
  const plotW = Math.max(BaseW - m.l - m.r, weeks.length * MinBand);
  const W = plotW + m.l + m.r,
    plotH = H - m.t - m.b;
  const maxTotal = Math.max(...weeks.filter((w) => !w.suspect).map((w) => w.total), store.weekTarget);
  const yMax = Math.max(44, Math.ceil((maxTotal + 2) / 4) * 4);
  /** @param {number} v */
  const y = (v) => m.t + plotH - (v / yMax) * plotH;
  const band = plotW / weeks.length;
  const colW = Math.min(24, band * 0.55);

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Horas totales por semana frente al objetivo de ${fmtHM(store.weekTarget)}`);
  /**
   * @param {string} tag
   * @param {Object<string, string | number>} attrs
   * @param {string} [cls]
   * @returns {SVGElement}
   */
  function sEl(tag, attrs, cls) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, /** @type {string} */ (v));
    // Stryker disable next-line ConditionalExpression: every call passes a class, so the guard is always true
    if (cls) e.setAttribute("class", cls);
    return e;
  }

  const gridStep = Math.max(10, Math.ceil(yMax / 6 / 10) * 10);
  for (let v = gridStep; v <= yMax; v += gridStep) {
    if (v !== store.weekTarget) svg.appendChild(sEl("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, "gridline"));
    const t = sEl("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, "ticklabel");
    t.textContent = String(v);
    svg.appendChild(t);
  }
  svg.appendChild(sEl("line", { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }, "axisline"));

  weeks.forEach((w, i) => {
    const cx = m.l + band * i + band / 2;
    const x0 = cx - colW / 2;
    const yTop = y(Math.min(w.total, yMax)),
      r = Math.min(4, (y(0) - yTop) / 2);
    const error = w.error;
    const g = sEl("g", { tabindex: 0 }, `col${w.current ? " inprogress" : ""}${error ? " error" : ""}`);
    g.addEventListener("click", () => showWeek(w.monday));
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter") showWeek(w.monday);
    });
    g.setAttribute("aria-label", `Semana del ${weekRangeLabel(w)}: ${fmtHM(w.total)}`);
    if (w.total > 0.01) {
      const d =
        `M ${x0} ${y(0)} L ${x0} ${yTop + r} Q ${x0} ${yTop} ${x0 + r} ${yTop}` +
        ` L ${x0 + colW - r} ${yTop} Q ${x0 + colW} ${yTop} ${x0 + colW} ${yTop + r} L ${x0 + colW} ${y(0)} Z`;
      g.appendChild(sEl("path", { d }, "bar"));
    }
    if (w.rest > 0.01) {
      const h = Math.max(y(0) - y(w.rest), MinSegH);
      g.appendChild(sEl("rect", { x: x0, y: y(0) - h, width: colW, height: h }, "rest"));
    }
    if (error) g.appendChild(sEl("rect", { x: x0, y: y(0) + 2, width: colW, height: 1.5 }, "err-mark"));
    g.appendChild(sEl("rect", { x: m.l + band * i, y: m.t, width: band, height: plotH }, "hit"));
    if (w.target !== store.weekTarget && w.target > 0) {
      svg.appendChild(sEl("line", { x1: x0 - 5, x2: x0 + colW + 5, y1: y(w.target), y2: y(w.target) }, "targettick"));
    }
    const xl = sEl("text", { x: cx, y: H - 16, "text-anchor": "middle" }, "xlabel");
    xl.textContent = fmtDay(w.monday);
    svg.appendChild(g);
    svg.appendChild(xl);
    if (w.current) {
      const cl = sEl("text", { x: cx, y: H - 3, "text-anchor": "middle" }, "inprogress-label");
      cl.textContent = "en curso";
      svg.appendChild(cl);
    }
    attachTip(g, (t) => {
      t.appendChild(el("div", "t-title", `Semana del ${weekRangeLabel(w)}${w.current ? " · en curso" : ""}`));
      t.appendChild(tipRow("Total", fmtHM(w.total)));
      if (w.rest > 0.01) {
        t.appendChild(tipRow("Trabajo", fmtHM(w.total - w.rest)));
        t.appendChild(tipRow("Descanso", fmtShort(w.rest)));
      }
      if (w.target !== store.weekTarget) t.appendChild(tipRow("Objetivo (con ausencias)", targetLabel(w)));
      if (w.suspect) t.appendChild(el("div", "t-note warn", "Incluye una jornada muy larga: suma no fiable"));
      if (w.missedDays) {
        t.appendChild(el("div", "t-note warn", `${plural(w.missedDays, "día", "días")} sin fichar`));
      }
      if (w.openDays) {
        t.appendChild(el("div", "t-note warn", `${plural(w.openDays, "día", "días")} con una entrada sin cerrar`));
      }
      if (w.allVacation && w.total < 0.01) {
        t.appendChild(tipRow("Vacaciones", "toda la semana"));
      } else if (w.complete) {
        const r2 = tipRow(w.delta >= 0 ? "Sobre objetivo" : "Bajo objetivo", fmtDelta(w.delta));
        const tone = w.error ? "warn" : shortWeek(w) ? "down" : null;
        if (tone) /** @type {HTMLElement} */ (r2.querySelector(".v")).classList.add(tone);
        t.appendChild(r2);
      } else {
        t.appendChild(tipRow("Para el objetivo", fmtHM(Math.max(w.target - w.total, 0))));
      }
    });
  });

  svg.appendChild(
    sEl("line", { x1: m.l, x2: W - m.r, y1: y(store.weekTarget), y2: y(store.weekTarget) }, "targetline"),
  );
  const tl = sEl("text", { x: W - m.r + 8, y: y(store.weekTarget) + 4 }, "targetlabel");
  tl.textContent = `Objetivo ${fmtHM(store.weekTarget)}`;
  svg.appendChild(tl);

  if (W > BaseW) {
    svg.style.width = `${W}px`;
    svg.style.height = `${H}px`;
  }
  const host = byId("overviewChart");
  const keep = host.scrollWidth - host.scrollLeft - host.clientWidth > 4 ? host.scrollLeft : null;
  host.replaceChildren(svg);
  host.scrollLeft = keep == null ? host.scrollWidth : keep;
}

/* ---------- calendario semanal navegable ---------- */
let calOffset = 0,
  calView = "horario";

/**
 * @param {Day} d
 * @returns {HTMLSpanElement}
 */
export function vacIcon(d) {
  const vb = el("span", `vacbtn${d.auto ? " active" : ""}`, d.auto ? "🏖" : "");
  if (d.auto) vb.title = `Ausencia en Odoo: ${d.auto}`;
  return vb;
}

export function renderCalendar() {
  const w = buildWeek(calOffset);
  byId("weeksHint").textContent =
    (store.personal.schedule
      ? `La marca vertical de cada día es la jornada prevista en Odoo: ${scheduleSentence()}.`
      : "Odoo no devuelve horario para tu calendario, así que no hay jornada prevista ni objetivo semanal.") +
    " El descanso fichado va en morado, en el tramo en que ocurrió; en naranja, las jornadas de más de " +
    `${fmtHM(store.personal.long_hours)} en total, las entradas sin cerrar y los días con` +
    " jornada prevista sin fichar, casi siempre un fichaje olvidado." +
    " En el horario, cada bloque es un fichaje en su hora real; los huecos entre bloques son tiempo ausente," +
    " la comida por ejemplo, y no cuentan." +
    " Los festivos y ausencias aprobadas se marcan solos (🏖) y no cuentan en el objetivo de su semana;" +
    " los permisos de horas (médico, etc.) restan de la jornada prevista de su día y aparecen en el horario" +
    " como bloque punteado.";
  const card = byId("weekCal");
  card.replaceChildren();
  const barMax = Math.max(10, ...w.days.filter((d) => !longDay(d)).map((d) => Math.max(d.hours, d.expected)));

  const head = el("div", "week-head");
  /**
   * @param {string} cls
   * @param {string} label
   * @param {string} title
   * @param {boolean} disabled
   * @param {() => void} onClick
   * @returns {HTMLButtonElement}
   */
  function navButton(cls, label, title, disabled, onClick) {
    const b = el("button", cls, label);
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  }
  head.appendChild(
    navButton("navbtn", "‹", "Semana anterior", calOffset >= store.personal.weeks - 1, () => {
      calOffset++;
      renderCalendar();
    }),
  );
  head.appendChild(el("span", "range", `Semana del ${weekRangeLabel(w)}`));
  head.appendChild(
    navButton("navbtn", "›", "Semana siguiente", calOffset <= 0, () => {
      calOffset--;
      renderCalendar();
    }),
  );
  head.appendChild(
    navButton("todaybtn", "Hoy", "Ir a la semana actual", calOffset === 0, () => {
      calOffset = 0;
      renderCalendar();
    }),
  );
  if (w.complete && w.allVacation && w.total < 0.01) {
    head.appendChild(el("span", "badge flat", "vacaciones"));
  } else if (w.error) {
    head.appendChild(el("span", "badge warn", `⚠ ${w.complete ? "" : "en curso · "}fichaje por revisar`));
  } else if (w.complete) {
    const level = Math.abs(w.delta) < 1 / 60;
    // Stryker disable next-line EqualityOperator: past the level test the delta is never 0, so > and >= agree
    const arrow = level ? "" : w.delta > 0 ? "▲ " : "▼ ";
    head.appendChild(
      el("span", `badge ${shortWeek(w) ? "down" : "flat"}`, `${arrow}${fmtDelta(w.delta)} vs ${targetLabel(w)}`),
    );
  } else if (w.total >= w.target) {
    head.appendChild(el("span", "badge flat", "▲ en curso · objetivo alcanzado"));
  } else {
    head.appendChild(el("span", "badge flat", `en curso · faltan ${fmtHM(w.target - w.total)}`));
  }
  const total = el("span", `total${w.suspect ? " long" : ""}`, fmtHM(w.total));
  if (w.suspect) {
    total.title = "Incluye una jornada muy larga: esta suma no es fiable";
    const warn = el("span", "total-warn", "⚠ incluye una jornada muy larga");
    head.append(warn);
  }
  head.appendChild(total);
  card.appendChild(head);

  const filter = el("div", "filter-row cal-filter");
  filter.appendChild(el("span", "filter-label", "Mostrar"));
  const seg = el("div", "seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Vista de la semana");
  for (const [view, label] of [
    ["horario", "Horario"],
    ["objetivo", "Objetivo"],
  ]) {
    const b = el("button", null, label);
    b.type = "button";
    b.dataset.view = view;
    b.setAttribute("aria-pressed", String(view === calView));
    b.addEventListener("click", () => {
      calView = view;
      renderCalendar();
    });
    seg.appendChild(b);
  }
  filter.appendChild(seg);
  card.appendChild(filter);

  if (calView === "horario") {
    renderTimeline(card, w);
    return;
  }
  w.days.forEach((d, i) => {
    if (i >= 5 && d.hours < 0.01 && !d.vacation && !missed(d)) return;
    const isToday = d.date.getTime() === store.today.getTime();
    const row = el("div", `dayrow${isToday ? " today" : ""}${d.vacation ? " vac" : ""}`);
    row.tabIndex = 0;
    const lbl = el("span", "dlabel");
    lbl.append(`${DayNames[i]} `);
    lbl.appendChild(el("span", "dnum", String(d.date.getDate())));
    row.appendChild(lbl);
    const track = el("div", "track");
    if (d.hours > 0.01) {
      const bar = el("div", `bar${dayError(d) ? " long" : ""}`);
      bar.style.width = `${Math.min((d.hours / barMax) * 100, 100)}%`;
      track.appendChild(fillBar(bar, d.sessions, d.hours));
    }
    if (d.expected > 0) {
      const tick = el("div", "exp-tick");
      tick.style.left = `calc(${(d.expected / barMax) * 100}% - 1px)`;
      track.appendChild(tick);
    }
    row.appendChild(track);
    row.appendChild(dayValue(d));
    row.appendChild(vacIcon(d));
    card.appendChild(row);

    attachTip(row, (t) => {
      t.appendChild(el("div", "t-title", `${DayNames[i]} ${fmtDay(d.date)}${isToday ? " · hoy" : ""}`));
      t.appendChild(tipRow("Total", d.hours < 0.01 ? "—" : fmtHM(d.hours)));
      if (d.vacation) t.appendChild(tipRow("Ausencia", d.auto));
      else if (d.expected > 0) t.appendChild(tipRow("Previsto", fmtHM(d.expected)));
      for (const l of d.leaves) t.appendChild(tipRow(`Permiso · ${l.type}`, fmtShort(l.hours)));
      const gap = unloggedGap(d.sessions, d.leaves);
      if (gap > 0.01) t.appendChild(tipRow("Ausente", fmtShort(gap)));
      if (d.rest > 0.01) t.appendChild(tipRow("Descanso", fmtShort(d.rest)));
      if (d.sessions.length) {
        t.appendChild(el("div", "t-sep"));
        d.sessions.forEach((s) => {
          t.appendChild(
            tipRow(
              `${fmtTime(s.in)} – ${s.out ? fmtTime(s.out) : "…"}${s.rest ? " · descanso" : ""}`,
              fmtHM(s.hours) + (s.out ? "" : " en curso"),
            ),
          );
        });
      }
    });
  });
}

/* ---------- horario semanal ---------- */
/**
 * @param {DaySession} s
 * @returns {number}
 */
function spanDays(s) {
  const out = s.out || store.now;
  const outDay = new Date(out.getFullYear(), out.getMonth(), out.getDate());
  const inDay = new Date(s.in.getFullYear(), s.in.getMonth(), s.in.getDate());
  return Math.round((outDay.getTime() - inDay.getTime()) / 864e5);
}

/**
 * @param {DaySession} s
 * @returns {number}
 */
function endHour(s) {
  return dayKey(s.out || store.now) === dayKey(s.in) ? hourOf(s.out || store.now) : 24;
}

/**
 * @param {HTMLElement} card
 * @param {Week} w
 */
export function renderTimeline(card, w) {
  const days = w.days.filter((d, i) => i < 5 || d.hours >= 0.01 || d.vacation || missed(d));
  const ends = days.flatMap((d) => [
    ...d.sessions.flatMap((s) => [hourOf(s.in), endHour(s)]),
    ...d.leaves.flatMap((l) => [hourOf(new Date(l.from)), hourOf(new Date(l.to))]),
  ]);
  const from = Math.floor(Math.min(8, ...ends)),
    to = Math.ceil(Math.max(18, ...ends));
  /** @param {number} h */
  const pct = (h) => `${((h - from) / (to - from)) * 100}%`;

  const axis = el("div", "tl-axis");
  for (let h = from; h <= to; h++) {
    const lbl = el("span", null, String(h));
    lbl.style.left = pct(h);
    axis.appendChild(lbl);
  }
  card.appendChild(axis);

  days.forEach((d) => {
    const i = (d.date.getDay() + 6) % 7;
    const isToday = d.date.getTime() === store.today.getTime();
    const row = el("div", `dayrow tl-row${isToday ? " today" : ""}${d.vacation ? " vac" : ""}`);
    const lbl = el("span", "dlabel");
    lbl.append(`${DayNames[i]} `);
    lbl.appendChild(el("span", "dnum", String(d.date.getDate())));
    row.appendChild(lbl);
    const track = el("div", "track");
    for (let h = from; h <= to; h++) {
      const line = el("div", "tl-grid");
      line.style.left = pct(h);
      track.appendChild(line);
    }
    /**
     * @param {HTMLElement} block
     * @param {number} from
     * @param {number} to
     */
    const span = (block, from, to) => {
      block.style.left = pct(from);
      block.style.width = `calc(${pct(to)} - ${pct(from)})`;
    };
    /**
     * @param {HTMLElement} block
     * @param {Date} from
     * @param {Date} to
     * @param {string} kind
     * @param {number} hours
     */
    const place = (block, from, to, kind, hours) => {
      block.tabIndex = 0;
      span(block, hourOf(from), hourOf(to));
      attachTip(block, (t) => {
        t.appendChild(el("div", "t-title", `${DayNames[i]} ${fmtDay(d.date)} · ${fmtTime(from)} – ${fmtTime(to)}`));
        t.appendChild(tipRow(kind, fmtShort(hours)));
      });
      track.appendChild(block);
    };
    for (const l of d.leaves) {
      place(el("div", "leave", l.type), new Date(l.from), new Date(l.to), `Permiso · ${l.type}`, l.hours);
    }
    const rests = /** @type {HTMLElement[]} */ ([]);
    let prevBlock = /** @type {HTMLElement | null} */ (null),
      prevStart = 0;
    d.sessions.forEach((s, k) => {
      const prev = d.sessions[k - 1];
      const joined = prevBlock && prev.out && s.in.getTime() - prev.out.getTime() <= 60000;
      if (prev?.out) {
        for (const [a, b] of uncovered(prev.out, s.in, d.leaves).filter(([from, to]) => to - from > 60000)) {
          place(el("div", "gap", fmtShort((b - a) / 3.6e6)), new Date(a), new Date(b), "Sin fichar", (b - a) / 3.6e6);
        }
      }
      const start = joined ? hourOf(/** @type {Date} */ (prev.out)) : hourOf(s.in),
        end = endHour(s);
      const days = spanDays(s);
      const later = days > 0 ? ` (+${days})` : "";
      const text = s.rest ? "" : `${fmtTime(s.in)} – ${s.out ? fmtTime(s.out) + later : "…"}`;
      const block = el(
        "div",
        `sess${s.rest ? " rest" : ""}${joined && !s.rest ? " join-l" : ""}${longDay(d) ? " long" : ""}`,
        text,
      );
      block.tabIndex = 0;
      attachTip(block, (t) => {
        t.appendChild(
          el(
            "div",
            "t-title",
            `${DayNames[i]} ${fmtDay(d.date)} · ${fmtTime(s.in)} – ${s.out ? fmtTime(s.out) : "en curso"}`,
          ),
        );
        t.appendChild(tipRow(s.rest ? "Descanso" : "Trabajo", fmtHM(s.hours)));
        if (days > 0) {
          t.appendChild(el("div", "t-note", `Termina ${days === 1 ? "al día siguiente" : `${days} días después`}`));
        }
        if (longDay(d)) {
          t.appendChild(
            el(
              "div",
              "t-note warn",
              `Jornada muy larga: ${fmtHM(d.hours)} en el día, más de ${fmtHM(store.personal.long_hours)}, ` +
                "casi siempre una salida sin fichar",
            ),
          );
        }
      });
      if (s.rest) {
        span(block, hourOf(s.in), end);
        rests.push(block);
        if (joined) span(/** @type {HTMLElement} */ (prevBlock), prevStart, end);
        else prevBlock = null;
        return;
      }
      if (joined) /** @type {HTMLElement} */ (prevBlock).classList.add("join-r");
      span(block, start, end);
      track.appendChild(block);
      prevBlock = block;
      prevStart = start;
    });
    for (const r of rests) track.appendChild(r);
    row.appendChild(track);
    row.appendChild(dayValue(d));
    row.appendChild(vacIcon(d));
    card.appendChild(row);
  });
}

/* ---------- tabla ---------- */
/** @param {Week[]} weeks */
export function renderTable(weeks) {
  const host = byId("tableView");
  host.replaceChildren();
  const hasWeekend = weeks.some((w) => w.days[5].hours > 0.01 || w.days[6].hours > 0.01);
  const dayCount = hasWeekend ? 7 : 5;

  const table = el("table");
  table.appendChild(
    el("caption", null, "Horas fichadas por semana y día (horas:minutos). «vac.» = día de vacaciones."),
  );
  const thead = el("thead");
  const hr = el("tr");
  hr.appendChild(el("th", null, "Semana"));
  for (let i = 0; i < dayCount; i++) hr.appendChild(el("th", null, DayNames[i]));
  hr.appendChild(el("th", null, "Objetivo"));
  hr.appendChild(el("th", null, "Total"));
  hr.appendChild(el("th", null, "Δ objetivo"));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el("tbody");
  [...weeks].reverse().forEach((w) => {
    const tr = el("tr");
    tr.appendChild(el("td", null, `${weekRangeLabel(w)}${w.current ? " (en curso)" : ""}`));
    for (let i = 0; i < dayCount; i++) {
      const d = w.days[i];
      tr.appendChild(
        el("td", d.hours < 0.01 ? "dim" : null, d.hours < 0.01 ? (d.vacation ? "vac." : "—") : fmtClock(d.hours)),
      );
    }
    tr.appendChild(el("td", "dim", fmtClock(w.target)));
    tr.appendChild(el("td", "total", fmtClock(w.total)));
    tr.appendChild(
      w.complete && w.allVacation && w.total < 0.01
        ? el("td", "dim", "vacaciones")
        : w.error
          ? el("td", "warn", "fichaje por revisar")
          : w.complete
            ? el("td", shortWeek(w) ? "down" : null, fmtDelta(w.delta))
            : el("td", "dim", w.total >= w.target ? "objetivo alcanzado" : `faltan ${fmtHM(w.target - w.total)}`),
    );
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  host.appendChild(table);
}

/* ---------- todo lo que depende del filtro de rango ---------- */
let rangeMonths = 6;
/** @param {number} n */
export function setRangeMonths(n) {
  rangeMonths = n;
}

/** @param {Date} date */
function showWeek(date) {
  calOffset = Math.min(weekOffsetOf(date), store.personal.weeks - 1);
  renderCalendar();
  byId("weekCal").scrollIntoView({ block: "start", behavior: "smooth" });
}

/**
 * @param {Day} d
 * @returns {HTMLSpanElement}
 */
function dayValue(d) {
  if (missed(d)) return el("span", "dvalue long", "sin fichar");
  if (d.hours < 0.01 && d.sessions.some(unclosed)) return el("span", "dvalue long", "sin cerrar");
  return el(
    "span",
    `dvalue${d.hours < 0.01 ? " zero" : ""}${dayError(d) ? " long" : ""}`,
    d.hours < 0.01 ? (d.vacation ? "vac." : "—") : fmtHM(d.hours),
  );
}

let errorsOpen = false;

/**
 * @param {import("./week.js").PunchError} s
 * @returns {Piece}
 */
function errorPiece(s) {
  return /** @type {Record<string, () => Piece>} */ ({
    long: () => [
      "kind",
      `Jornada de ${fmtShort(/** @type {number} */ (s.hours))}`,
      /** @type {number} */ (s.count) > 1 ? `en ${s.count} sesiones` : "",
    ],
    open: () => ["kind", "Sin cerrar", `entrada a las ${fmtTime(s.in)}, sin salida`],
    empty: () => ["kind", "Sin fichar", `con jornada prevista de ${fmtShort(/** @type {number} */ (s.expected))}`],
  })[s.kind]();
}

/**
 * @param {HTMLElement} button
 * @param {string} [day]
 * @returns {Promise<void>}
 */
export function openRequest(button, day) {
  const tab = /** @type {Window} */ (window.open("", "_blank"));
  tab.opener = null;
  return api(`/api/request${day ? `?date=${day}` : ""}`)
    .then((answer) => {
      const { url } = /** @type {{ url: string }} */ (answer);
      tab.location = url;
    })
    .catch((e) => {
      tab.close();
      button.textContent = "No se pudo abrir";
      button.title = e.message;
    });
}

/**
 * @param {import("./store.js").ChangeRequest} r
 * @returns {Piece}
 */
function requestPiece(r) {
  const span = `${fmtTime(new Date(r.from))}${r.to ? `–${fmtTime(new Date(r.to))}` : ""}`;
  return ["req", "Solicitud pendiente", `${span}${r.reason ? ` · ${r.reason}` : ""}`];
}

export function renderErrors() {
  const box = byId("errorsBanner");
  const errors = punchErrors();
  const requests = store.personal.requests || [];
  box.classList.toggle("hidden", !errors.length && !requests.length);
  box.classList.toggle("requests", !errors.length);
  if (!errors.length && !requests.length) return;
  const days = /** @type {Map<string, {date: Date, pieces: Piece[]}>} */ (new Map());
  /** @param {Date} at */
  const on = (at) => {
    const key = isoDay(at);
    if (!days.has(key)) days.set(key, { date: new Date(at.getFullYear(), at.getMonth(), at.getDate()), pieces: [] });
    return /** @type {{date: Date, pieces: Piece[]}} */ (days.get(key)).pieces;
  };
  for (const s of errors) on(s.in).push(errorPiece(s));
  for (const r of requests) on(new Date(r.from)).push(requestPiece(r));
  const list = el("ul");
  for (const [key, { date, pieces }] of [...days].sort(([a], [b]) => b.localeCompare(a))) {
    const item = el("button");
    item.type = "button";
    item.appendChild(el("span", "day", `${DayNames[(date.getDay() + 6) % 7]} ${fmtDate(date)}`));
    for (const [cls, kind, text] of pieces) {
      item.append(" · ");
      item.appendChild(el("span", cls, kind));
      if (text) item.append(` ${text}`);
    }
    item.addEventListener("click", () => showWeek(date));
    const li = el("li");
    li.appendChild(item);
    if (store.personal.can_edit || pieces.some(([cls]) => cls === "req")) {
      const fix = el("button", "fix", store.personal.can_edit ? "Corregir" : "Revisar");
      fix.type = "button";
      fix.addEventListener("click", () =>
        openDayOf(Number(store.other) || store.personal.employee_id, key).catch((e) => {
          fix.textContent = "No se pudo abrir";
          fix.title = e.message;
        }),
      );
      li.appendChild(fix);
    }
    if (!store.other) {
      const ask = el("button", "fix", "Solicitar cambio");
      ask.type = "button";
      ask.title =
        "Abre en Odoo la solicitud de cambio de fichaje de este día, preparada: " +
        "revisa las horas antes de enviarla";
      ask.addEventListener("click", () => openRequest(ask, key));
      li.appendChild(ask);
    }
    list.appendChild(li);
  }
  const details = el("details");
  details.open = errorsOpen;
  details.addEventListener("toggle", () => {
    errorsOpen = details.open;
  });
  const summary = el("summary");
  const n = errors.length,
    m = requests.length;
  summary.appendChild(
    el(
      "h2",
      null,
      [
        n ? `⚠ ${plural(n, "fichaje por corregir", "fichajes por corregir")}` : "",
        m ? plural(m, "solicitud pendiente", "solicitudes pendientes") : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  details.append(
    summary,
    el(
      "p",
      null,
      "Entradas sin cerrar de días anteriores, jornadas de más de " +
        `${fmtHM(store.personal.long_hours)} y días con jornada prevista sin ningún fichaje, de todo el historial` +
        (m ? ", y las solicitudes de cambio pendientes de tu aprobación" : "") +
        ", un día por línea. Pulsa uno para ver su semana.",
    ),
    list,
  );
  box.replaceChildren(details);
}

let rangeShort = false;

/**
 * @param {Week} w
 * @returns {boolean}
 */
function shortWeek(w) {
  return rangeShort && w.delta <= -1 / 60;
}

export function renderAll() {
  const weeks = buildWeeks(
    Math.min(rangeMonths ? weeksSince(rangeMonths) : store.personal.weeks, store.personal.weeks),
  );
  rangeShort = weeks.filter((w) => w.complete).reduce((a, w) => a + w.delta, 0) <= -1 / 60;
  renderErrors();
  renderCalendar();
  renderKpis(weeks);
  renderOverview(weeks);
  renderTable(weeks);
  renderPhone();
}
