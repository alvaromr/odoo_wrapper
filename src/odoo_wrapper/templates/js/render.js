/*
 * Rendering: the hero (today and the current week), the phone access block, the KPIs, the weekly chart, the
 * navigable week card with its two views (timeline «Horario» and hours per day «Objetivo») and the table.
 *
 * - The hero offers check in (Normal), check out, leave for lunch (a check-out that also stamps the lunch),
 *   leave for break (check-out + check-in as Descanso) and return from break (check-out + check-in as
 *   Normal). The lunch button only shows from that day's lunch time onwards (the start of the lunch gap in
 *   the Odoo calendar) and disappears for the rest of the day once used. A UI guard, not a server rule: the
 *   action is a plain check-out and stays valid at any hour.
 * - The break button and the break-length field exist only when the payload says breaks: true, i.e. Odoo
 *   has the Descanso reason (data.py). Without it no session is ever a break, so the break alarm never fires
 *   either.
 * - Every sentence quoting the schedule is generated from it (scheduleSentence).
 * - The banner under the hero lists this person's punch errors (week.js's punchErrors), whoever is looking
 *   and whatever their rights: it reads only this page's own sessions. Each one opens its week. It folds
 *   (closed by default, the count in its title) and keeps whatever the viewer left it at across repaints. A missed day
 *   also reads «sin fichar» in orange in both calendar views instead of a bare dash. In the weekly chart a
 *   week with a punch error (a too long session or a missed day) is orange, with a thin orange line just
 *   under the axis so a week with nothing punched still shows it (under it, not on it: on it, it read as a
 *   few hours punched), and its tooltip says why. The chart's grid keeps
 *   about six lines whatever the tallest week: a 230 h week used to draw one every 10 h. Its scale leaves
 *   out suspect weeks, which run to the top: one forgotten check-out flattened every other column. A click (or Enter) on
 *   a column opens that week in the calendar, as a banner entry does (showWeek). The average and balance
 *   tiles turn orange with a note when a finished week they count has a punch error: they cannot be trusted.
 *   «Horario habitual» averages only days without a punch error: a check-out on the next morning read as
 *   leaving at 8:36, and an open entry or an off-hours punch skewed the mean the same way.
 * - A session longer than the payload's long_hours is drawn orange (a punch error, style.css) in the
 *   timeline, and so is its day's total in both calendar views: it is nearly always a forgotten check-out. A session that ends on a later day
 *   runs to midnight on its check-in day, labelled with the days it spans («15:00 – 09:00 (+1)»); its end
 *   hour used to come before its start and left a sliver. A week holding such a session never claims its
 *   target reached: the hero, the week card's badge and the table say a punch needs checking instead, the
 *   card's total says its sum cannot be trusted, and the day's bar is red in «Objetivo» too. A week with a
 *   missed day says a punch needs checking the same way (week.error).
 * - «Objetivo» scales its bars to the week shown, leaving out its long days, which run to the edge: scaled to
 *   the longest day of the whole history, one forgotten check-out of hundreds of hours shrank every normal day to a sliver.
 * - A session left open since an earlier day is not today's work: the hero estimates no leave time from it
 *   and its last-punch line says, in orange, since when it is open (leftOpen). The punch buttons still follow
 *   the real open attendance, which is what Odoo will close.
 * - For a session that may change punches (the payload's can_edit), each day in the banner has «Corregir»,
 *   which opens it in the correcting dialog of dayedit.js, as the management view does; saving reloads this
 *   page. A day with a request the viewer may approve has «Revisar» instead when they may not correct. On someone else's page, whoever may approve their pending change
 *   requests gets them in the same banner (the payload's requests; the employee never sees them), in
 *   blue, grouped with the punch errors of their day: one line and one «Corregir» per day, whose dialog
 *   also approves the request.
 * - Colours: never hardcode one here. Two call sites build the token name at runtime (var(--${…})) and go
 *   silently colourless when a token is renamed; the palette and its rules are in style.css.
 */
import { store, DayNames, DayFull } from "./store.js";
import {
  buildWeek, buildWeeks, weekRangeLabel, lunchHours, lunchOpen, targetLabel, weeksSince, punchErrors, weekOffsetOf,
  missed, longDay, offHours, dayError, unclosed,
} from "./week.js";
import { fmtShort, fmtTime, fmtHM, fmtDelta, fmtDay, fmtDate, fmtClock, hourOf, dayKey, isoDay } from "./format.js";
import { openDayOf } from "./dayedit.js";
import { el, api, attachTip, tipRow } from "./shared.js";
import { fillBar, minutesField, bellIcon, qrIcon, actionButton } from "./ui.js";
import { saveState } from "./api.js";
import { stopFlash, notifyStatus } from "./alarms.js";

/* ---------- último fichaje ---------- */
export function lastPunch() {
  const events = store.data.sessions.flatMap(s => {
    const inEv = { at: new Date(s.in), open: !s.out, rest: s.rest };
    return s.out ? [inEv, { at: new Date(s.out), out: true, rest: s.rest }] : [inEv];
  });
  return events.reduce((a, e) => (a && a.at >= e.at ? a : e), null);
}

export function unloggedGap(sessions) {
  return sessions.reduce((a, s, i) =>
    i && sessions[i - 1].out ? a + Math.max(s.in - sessions[i - 1].out, 0) / 3.6e6 : a, 0);
}

export function leftOpen(ev) {
  return ev.open && ev.at < store.today;
}

export function punchText(ev) {
  const elapsed = (Date.now() - ev.at) / 3.6e6;
  if (leftOpen(ev)) return `Entrada del ${fmtDay(ev.at)} a las ${fmtTime(ev.at)} sin cerrar · hace ${fmtShort(elapsed)}`;
  const label = ev.out
    ? ev.rest ? "Fin del descanso a las" : "Última salida a las"
    : ev.rest ? "En descanso desde las" : "Entrada a las";
  const since = ev.open ? `llevas ${fmtShort(elapsed)}` : `hace ${fmtShort(elapsed)}`;
  return `${label} ${fmtTime(ev.at)} · ${since}`;
}

/* ---------- hero (hoy y semana actual, no dependen del filtro) ---------- */
export function heroHeadline(day, dayRemaining, dayDelta, leaveAt, lunchLeft, leftover = false) {
  const main = el("div", "main");
  const headline = (label, value, valueCls, detail) => {
    main.appendChild(el("span", "label", label));
    main.appendChild(el("div", `value ${valueCls}`, value));
    main.appendChild(el("div", `delta ${detail.cls || "flat"}`, detail.text));
  };
  if (day.expected <= 0) {
    headline("Hoy", "Sin jornada", "text",
      { text: day.vacation ? day.auto : "hoy no hay jornada prevista" });
  } else if (dayRemaining > 0) {
    headline("Pendiente hoy", fmtShort(dayRemaining), "num", {
      text: `para la jornada de ${fmtHM(day.expected)}`
        + (leaveAt ? "" : leftover ? " · hay una entrada anterior sin cerrar" : " · sin fichaje abierto"),
    });
    if (leaveAt) {
      const eta = el("div", "eta");
      eta.append("Salida estimada ");
      eta.appendChild(el("b", "num", fmtTime(leaveAt)));
      if (lunchLeft > 0.01) eta.append(` · incluye ${fmtShort(lunchLeft)} de comida`);
      main.appendChild(eta);
    }
  } else {
    headline("Hoy", "Jornada cumplida", "text done", {
      cls: dayDelta < 1 / 60 ? "flat" : "up",
      text: dayDelta < 1 / 60 ? `justo en las ${fmtHM(day.expected)} previstas`
        : `▲ ${fmtDelta(dayDelta)} sobre ${fmtHM(day.expected)}`,
    });
  }
  main.appendChild(el("div", "note",
    `${DayNames[(store.today.getDay() + 6) % 7]} ${fmtDay(store.today)}${day.vacation ? ` · ${day.auto}` : ""}`
    + day.leaves.map(l => ` · ${l.type} ${fmtShort(l.hours)}`).join("")
    + ` · ${fmtHM(day.hours)} fichadas`));
  return main;
}

export function heroMeters(week, day, open, remaining, restToday, lunchDone) {
  const box = el("div", "meter-box");

  const dayBlock = el("div", "meter-block");
  const dayDone = day.expected <= 0 || day.hours >= day.expected;
  const dayMeter = el("div", "meter day" + (dayDone ? " done" : ""));
  const dayFill = el("div", "fill");
  dayFill.style.width = (day.expected > 0
    ? Math.min(day.hours / day.expected * 100, 100)
    : day.hours > 0.01 ? 100 : 0) + "%";
  dayMeter.appendChild(fillBar(dayFill, day.sessions, day.hours));
  dayBlock.appendChild(dayMeter);
  const dayCap = el("div", "meter-caption strong");
  dayCap.appendChild(el("span", null, "Jornada de hoy"));
  dayCap.appendChild(el("span", null,
    day.expected > 0 ? `${Math.round(day.hours / day.expected * 100)} %` : "sin objetivo"));
  dayBlock.appendChild(dayCap);
  box.appendChild(dayBlock);

  const weekBlock = el("div", "meter-block");
  if (week.target > 0) {
    const meter = el("div", "meter week");
    const fill = el("div", "fill");
    fill.style.width = Math.min(week.total / week.target * 100, 100) + "%";
    meter.appendChild(fillBar(fill, week.sessions, week.total));
    weekBlock.appendChild(meter);
    const cap = el("div", "meter-caption");
    cap.appendChild(el("span", null,
      week.error ? `Semana ${weekRangeLabel(week)} · hay un fichaje por revisar`
        : remaining > 0 ? `Semana ${weekRangeLabel(week)} · faltan ${fmtHM(remaining)}`
        : `Semana ${weekRangeLabel(week)} · objetivo alcanzado`));
    cap.appendChild(el("span", null, `${fmtHM(week.total)} / ${targetLabel(week)}`));
    weekBlock.appendChild(cap);
  } else {
    weekBlock.appendChild(el("div", "note", "Semana marcada como vacaciones"));
  }
  box.appendChild(weekBlock);

  const ev = lastPunch();
  store.punchEl = store.punchEv = null;
  if (ev) {
    const punch = el("div", "lastpunch" + (leftOpen(ev) ? " stale" : open ? open.rest ? " rest" : " open" : ""));
    punch.appendChild(el("span", "dot"));
    const txt = el("span", null, punchText(ev));
    punch.appendChild(txt);
    box.appendChild(punch);
    store.punchEl = txt;
    store.punchEv = ev;
  } else {
    box.appendChild(el("div", "note", "Sin fichajes registrados"));
  }
  if (lunchDone > 0.01) {
    box.appendChild(el("div", "note", `Comida de hoy: ${fmtShort(lunchDone)} sin fichar`));
  }
  if (restToday > 0.01) {
    box.appendChild(el("div", "note",
      `Descanso fichado hoy: ${fmtShort(restToday)}${open && open.rest ? " (en curso)" : ""}`));
  }
  if (day.expected > 0 && !store.other) {
    const cfg = el("div", "note durations");
    cfg.appendChild(minutesField("Comida", "lunch_minutes",
      lunchHours(day) > 0 ? "" : " · hoy sin comida prevista"));
    if (store.data.breaks) cfg.appendChild(minutesField("Descanso", "break_minutes", ""));
    box.appendChild(cfg);
  }
  return box;
}

export function heroActions(open, day, dayRemaining) {
  const actions = el("div", "actions");
  const errBox = el("div", "err");
  const outBtn = open
    ? actionButton(open.rest ? "ghost" : "primary", "Fichar salida", "checkout", errBox)
    : null;
  if (outBtn && day.expected > 0 && dayRemaining <= 0) outBtn.classList.add("pulse");
  if (open && open.rest) {
    actions.appendChild(actionButton("primary", "Volver del descanso", "resume", errBox));
    actions.appendChild(outBtn);
  } else if (open) {
    actions.appendChild(outBtn);
    if (!store.state.lunch_done && lunchOpen()) {
      actions.appendChild(actionButton("ghost", "Salir a comer", "lunch", errBox));
    }
    if (store.data.breaks) actions.appendChild(actionButton("ghost", "Salir a descanso", "break", errBox));
  } else {
    actions.appendChild(actionButton("primary", "Fichar entrada", "checkin", errBox));
  }
  const mute = el("button", "icon-btn");
  mute.type = "button";
  mute.title = store.state.muted ? "Reactivar avisos" : "Silenciar avisos";
  mute.setAttribute("aria-label", mute.title);
  mute.setAttribute("aria-pressed", String(store.state.muted));
  mute.appendChild(bellIcon(store.state.muted));
  mute.addEventListener("click", () => {
    if (!store.state.muted) stopFlash();
    saveState({ muted: !store.state.muted });
  });

  store.notifyArgs = [open, day, dayRemaining];
  store.notifyEl = el("div", "note", notifyStatus(...store.notifyArgs));
  const notify = el("div", "notify-row");
  notify.appendChild(mute);
  notify.appendChild(store.notifyEl);
  actions.appendChild(notify);
  actions.appendChild(errBox);
  return actions;
}

export function renderHero() {
  const week = buildWeek(0);
  const day = week.days.find(d => d.date.getTime() === store.today.getTime());
  const dayRemaining = Math.max(day.expected - day.hours, 0);
  const dayDelta = day.hours - day.expected;
  const remaining = Math.max(week.target - week.total, 0);
  const restToday = day.rest;
  const open = store.data.sessions.find(s => !s.out);
  const working = open && new Date(open.in) >= store.today;
  const lunchDone = unloggedGap(day.sessions);
  const lunchLeft = lunchDone > 0.01 ? 0 : lunchHours(day);
  const leaveAt = working && dayRemaining > 0
    ? new Date(Date.now() + (dayRemaining + lunchLeft) * 3.6e6)
    : null;

  const hero = document.getElementById("hero");
  hero.replaceChildren();
  hero.appendChild(heroHeadline(day, dayRemaining, dayDelta, leaveAt, lunchLeft, Boolean(open && !working)));
  hero.appendChild(heroMeters(week, day, open, remaining, restToday, lunchDone));
  if (!store.other) hero.appendChild(heroActions(open, day, dayRemaining));
}

/* ---------- acceso desde el móvil ---------- */
let phoneView = "ip";
let pairing = null;
let pairError = "";

export function renderPhone() {
  const host = document.getElementById("phone");
  const show = store.data.phone && location.protocol === "http:";
  host.classList.toggle("hidden", !show);
  if (!show) return;
  host.replaceChildren();
  const phone = store.data.phone;
  const views = {
    ip: { label: "Por IP", url: phone.url, note: "Vale en esta red; al cambiar de red, empareja de nuevo." },
    name: { label: "Por nombre", url: phone.name_url, note: "Si tu móvil resuelve mDNS, vale en todas las redes." },
  };
  const left = pairing ? Math.ceil((pairing.until - Date.now()) / 1000) : 0;
  if (left <= 0) pairing = null;
  if (pairing && pairing.qr) {
    const code = el("div", "qr");
    code.innerHTML = pairing.qr;
    host.appendChild(code);
  }
  const links = el("div", "links");
  links.appendChild(el("h2", null, "Abrir en el móvil"));
  const seg = el("div", "seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "URL del móvil");
  for (const [key, v] of Object.entries(views)) {
    const b = el("button", null, v.label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(key === phoneView));
    b.addEventListener("click", () => { phoneView = key; pairing = null; renderPhone(); });
    seg.appendChild(b);
  }
  links.appendChild(seg);
  links.appendChild(el("div", "url", pairing ? pairing.url : views[phoneView].url));
  if (pairing) {
    const cancel = el("button", "btn ghost", "Cancelar");
    cancel.type = "button";
    cancel.addEventListener("click", unpair);
    links.appendChild(cancel);
    links.appendChild(el("div", "note", `Escanea el código con la cámara del móvil: caduca en ${left} s y sirve`
      + " una sola vez. Si el móvil avisa del certificado, acéptalo."));
  } else {
    const b = el("button", "btn primary", "Emparejar móvil");
    b.type = "button";
    b.prepend(qrIcon());
    b.addEventListener("click", () => pair(b));
    links.appendChild(b);
    links.appendChild(el("div", "note", pairError || `${views[phoneView].note} El móvil entra con la sesión de`
      + " este navegador, sin escribir la contraseña."));
  }
  host.appendChild(links);
}

async function pair(button) {
  button.disabled = true;
  pairError = "";
  try {
    const res = await api("/api/pair", { name: phoneView === "name" });
    pairing = { ...res, until: Date.now() + res.expires_in * 1000 };
    const timer = setInterval(() => { renderPhone(); if (!pairing) clearInterval(timer); }, 1000);
  } catch (e) {
    pairError = `No se pudo emparejar: ${e.message}`;
  }
  renderPhone();
}

function unpair() {
  pairing = null;
  renderPhone();
  api("/api/pair", { revoke: true }).catch(() => {});
}

/* ---------- KPIs ---------- */
export function renderKpis(weeks) {
  const done = weeks.filter(w => w.complete);
  const working = done.filter(w => w.target > 0);
  const kpis = document.getElementById("kpis");
  kpis.replaceChildren();
  function tile(label, valueText, foot, valueCls) {
    const c = el("div", "card");
    c.appendChild(el("span", "label", label));
    const v = el("div", "value num", valueText);
    if (valueCls) v.style.color = `var(--${valueCls})`;
    c.appendChild(v);
    if (foot) c.appendChild(el("div", "foot", foot));
    return c;
  }
  if (!done.length) return;
  const balance = done.reduce((a, w) => a + w.delta, 0);
  const wrong = done.filter(w => w.error).length;
  const unreliable = n => el("div", "foot warn", `⚠ No fiable: ${n} ${n === 1 ? "semana" : "semanas"} con `
    + "fichajes incorrectos (jornadas muy largas, entradas sin cerrar, fuera de horario o días sin fichar)");
  const wrongWorking = working.filter(w => w.error).length;
  const averageTile = tile("Media semanal",
    working.length ? fmtHM(working.reduce((a, w) => a + w.total, 0) / working.length) : "—",
    `${working.length} ${working.length === 1 ? "semana laborable completa" : "semanas laborables completas"}`, wrongWorking ? "status-warning" : null);
  if (wrongWorking) averageTile.appendChild(unreliable(wrongWorking));
  kpis.appendChild(averageTile);
  const balanceTile = tile("Balance frente al objetivo", fmtDelta(balance),
    balance >= 0 ? "acumulado a favor" : "acumulado en contra",
    wrong ? "status-warning" : Math.abs(balance) < 1 / 60 ? null : balance > 0 ? "status-success" : "destructive");
  if (wrong) balanceTile.appendChild(unreliable(wrong));
  kpis.appendChild(balanceTile);

  const worked = weeks.flatMap(w => w.days).filter(d => d.sessions.length && !dayError(d));
  const minsOf = d => d.getHours() * 60 + d.getMinutes();
  const avgTime = list => {
    if (!list.length) return null;
    const m = Math.round(list.reduce((a, v) => a + v, 0) / list.length);
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  const entry = avgTime(worked.map(d => minsOf(d.sessions[0].in)));
  const exit = avgTime(worked.filter(d => d.sessions.at(-1).out).map(d => minsOf(d.sessions.at(-1).out)));
  if (entry && exit) {
    kpis.appendChild(tile("Horario habitual", `${entry} – ${exit}`,
      `entrada y salida medias · ${worked.length} ${worked.length === 1 ? "día" : "días"}`));
  }
}

/* ---------- overview chart ---------- */
export function scheduleSentence() {
  const groups = new Map();
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

export function renderOverview(weeks) {
  document.getElementById("overviewTitle").textContent =
    `Total semanal frente al objetivo de ${fmtHM(store.weekTarget)}`;
  const adjusted = weeks.some(w => w.target !== store.weekTarget && w.target > 0);
  document.getElementById("overviewCaption").textContent =
    "Cada columna es una semana; la actual, en azul claro; abajo, en morado, el descanso fichado; en naranja, "
    + "las semanas con un error de fichaje (una jornada muy larga, una entrada sin cerrar, un fichaje fuera de horario o"
    + " un día sin fichar). Pulsa una para verla arriba."
    + (adjusted ? " Las semanas con ausencias o permisos llevan su objetivo ajustado como marca horizontal." : "");

  const BaseW = 940, MinBand = 38, H = 250, MinSegH = 3;
  const m = { l: 34, r: 84, t: 14, b: 34 };
  const plotW = Math.max(BaseW - m.l - m.r, weeks.length * MinBand);
  const W = plotW + m.l + m.r, plotH = H - m.t - m.b;
  const maxTotal = Math.max(...weeks.filter(w => !w.suspect).map(w => w.total), store.weekTarget);
  const yMax = Math.max(44, Math.ceil((maxTotal + 2) / 4) * 4);
  const y = v => m.t + plotH - (v / yMax) * plotH;
  const band = plotW / weeks.length;
  const colW = Math.min(24, band * 0.55);

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Horas totales por semana frente al objetivo de ${fmtHM(store.weekTarget)}`);
  function sEl(tag, attrs, cls) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (cls) e.setAttribute("class", cls);
    return e;
  }

  const gridStep = Math.max(10, Math.ceil(yMax / 6 / 10) * 10);
  for (let v = gridStep; v <= yMax; v += gridStep) {
    if (v !== store.weekTarget) svg.appendChild(sEl("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, "gridline"));
    const t = sEl("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, "ticklabel");
    t.textContent = v;
    svg.appendChild(t);
  }
  svg.appendChild(sEl("line", { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }, "axisline"));

  weeks.forEach((w, i) => {
    const cx = m.l + band * i + band / 2;
    const x0 = cx - colW / 2;
    const yTop = y(Math.min(w.total, yMax)), r = Math.min(4, (y(0) - yTop) / 2);
    const error = w.error;
    const g = sEl("g", { tabindex: 0 }, "col" + (w.current ? " inprogress" : "") + (error ? " error" : ""));
    g.addEventListener("click", () => showWeek(w.monday));
    g.addEventListener("keydown", e => { if (e.key === "Enter") showWeek(w.monday); });
    g.setAttribute("aria-label", `Semana del ${weekRangeLabel(w)}: ${fmtHM(w.total)}`);
    if (w.total > 0.01) {
      const d = `M ${x0} ${y(0)} L ${x0} ${yTop + r} Q ${x0} ${yTop} ${x0 + r} ${yTop}` +
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
    attachTip(g, t => {
      t.appendChild(el("div", "t-title", `Semana del ${weekRangeLabel(w)}${w.current ? " · en curso" : ""}`));
      t.appendChild(tipRow("Total", fmtHM(w.total)));
      if (w.rest > 0.01) {
        t.appendChild(tipRow("Trabajo", fmtHM(w.total - w.rest)));
        t.appendChild(tipRow("Descanso", fmtShort(w.rest)));
      }
      if (w.target !== store.weekTarget) t.appendChild(tipRow("Objetivo (con ausencias)", targetLabel(w)));
      if (w.suspect) t.appendChild(el("div", "t-note warn", "Incluye una jornada muy larga: suma no fiable"));
      if (w.offDays) {
        t.appendChild(el("div", "t-note warn", `${w.offDays} ${w.offDays === 1 ? "día" : "días"} con fichajes fuera de horario`));
      }
      if (w.missedDays) {
        t.appendChild(el("div", "t-note warn", `${w.missedDays} ${w.missedDays === 1 ? "día" : "días"} sin fichar`));
      }
      if (w.openDays) {
        t.appendChild(el("div", "t-note warn", `${w.openDays} ${w.openDays === 1 ? "día" : "días"} con una entrada sin cerrar`));
      }
      if (w.allVacation && w.total < 0.01) {
        t.appendChild(tipRow("Vacaciones", "toda la semana"));
      } else if (w.complete) {
        const r2 = tipRow(w.delta >= 0 ? "Sobre objetivo" : "Bajo objetivo", fmtDelta(w.delta));
        r2.querySelector(".v").style.color = `var(--${w.suspect ? "status-warning" : w.delta >= 0 ? "status-success" : "destructive"})`;
        t.appendChild(r2);
      } else {
        t.appendChild(tipRow("Para el objetivo", fmtHM(Math.max(w.target - w.total, 0))));
      }
    });
  });

  svg.appendChild(sEl("line", { x1: m.l, x2: W - m.r, y1: y(store.weekTarget), y2: y(store.weekTarget) }, "targetline"));
  const tl = sEl("text", { x: W - m.r + 8, y: y(store.weekTarget) + 4 }, "targetlabel");
  tl.textContent = `Objetivo ${fmtHM(store.weekTarget)}`;
  svg.appendChild(tl);

  if (W > BaseW) {
    svg.style.width = W + "px";
    svg.style.height = H + "px";
  }
  const host = document.getElementById("overviewChart");
  const keep = host.scrollWidth - host.scrollLeft - host.clientWidth > 4 ? host.scrollLeft : null;
  host.replaceChildren(svg);
  host.scrollLeft = keep == null ? host.scrollWidth : keep;
}

/* ---------- calendario semanal navegable ---------- */
let calOffset = 0, calView = "horario";

export function vacIcon(d) {
  const vb = el("span", "vacbtn" + (d.auto ? " active" : ""), d.auto ? "🏖" : "");
  if (d.auto) vb.title = `Ausencia en Odoo: ${d.auto}`;
  return vb;
}

export function renderCalendar() {
  const w = buildWeek(calOffset);
  document.getElementById("weeksHint").textContent =
    (store.data.schedule
      ? `La marca vertical de cada día es la jornada prevista en Odoo: ${scheduleSentence()}.`
      : "Odoo no devuelve horario para tu calendario, así que no hay jornada prevista ni objetivo semanal.")
    + " El descanso fichado va en morado, en el tramo en que ocurrió; en naranja, las jornadas de más de "
    + `${fmtHM(store.data.long_hours)} en total, los fichajes fuera de horario, las entradas sin cerrar y los días con`
    + " jornada prevista sin fichar, casi siempre un fichaje olvidado."
    + " En el horario, cada bloque es un fichaje en su hora real; los huecos entre bloques son tiempo sin fichar,"
    + " la comida por ejemplo, y no cuentan."
    + " Los festivos y ausencias aprobadas se marcan solos (🏖) y no cuentan en el objetivo de su semana;"
    + " los permisos de horas (médico, etc.) restan de la jornada prevista de su día y aparecen en el horario"
    + " como bloque punteado.";
  const card = document.getElementById("weekCal");
  card.replaceChildren();
  const barMax = Math.max(10, ...w.days.filter(d => !longDay(d)).map(d => Math.max(d.hours, d.expected)));

  const head = el("div", "week-head");
  function navButton(cls, label, title, disabled, onClick) {
    const b = el("button", cls, label);
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  }
  head.appendChild(navButton("navbtn", "‹", "Semana anterior", calOffset >= store.data.weeks - 1,
    () => { calOffset++; renderCalendar(); }));
  head.appendChild(el("span", "range", `Semana del ${weekRangeLabel(w)}`));
  head.appendChild(navButton("navbtn", "›", "Semana siguiente", calOffset <= 0,
    () => { calOffset--; renderCalendar(); }));
  head.appendChild(navButton("todaybtn", "Hoy", "Ir a la semana actual", calOffset === 0,
    () => { calOffset = 0; renderCalendar(); }));
  if (w.complete && w.allVacation && w.total < 0.01) {
    head.appendChild(el("span", "badge flat", "vacaciones"));
  } else if (w.error) {
    head.appendChild(el("span", "badge warn", `⚠ ${w.complete ? "" : "en curso · "}fichaje por revisar`));
  } else if (w.complete) {
    const cls = Math.abs(w.delta) < 1 / 60 ? "flat" : w.delta > 0 ? "up" : "down";
    const arrow = cls === "up" ? "▲ " : cls === "down" ? "▼ " : "";
    head.appendChild(el("span", `badge ${cls}`, `${arrow}${fmtDelta(w.delta)} vs ${targetLabel(w)}`));
  } else if (w.total >= w.target) {
    head.appendChild(el("span", "badge up", "▲ en curso · objetivo alcanzado"));
  } else {
    head.appendChild(el("span", "badge flat", `en curso · faltan ${fmtHM(w.target - w.total)}`));
  }
  const total = el("span", "total" + (w.suspect ? " long" : ""), fmtHM(w.total));
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
  for (const [view, label] of [["horario", "Horario"], ["objetivo", "Objetivo"]]) {
    const b = el("button", null, label);
    b.type = "button";
    b.dataset.view = view;
    b.setAttribute("aria-pressed", String(view === calView));
    b.addEventListener("click", () => { calView = view; renderCalendar(); });
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
    const row = el("div", "dayrow" + (isToday ? " today" : "") + (d.vacation ? " vac" : ""));
    row.tabIndex = 0;
    const lbl = el("span", "dlabel");
    lbl.append(DayNames[i] + " ");
    lbl.appendChild(el("span", "dnum", String(d.date.getDate())));
    row.appendChild(lbl);
    const track = el("div", "track");
    if (d.hours > 0.01) {
      const bar = el("div", "bar" + (dayError(d) ? " long" : ""));
      bar.style.width = Math.min(d.hours / barMax * 100, 100) + "%";
      track.appendChild(fillBar(bar, d.sessions, d.hours));
    }
    if (d.expected > 0) {
      const tick = el("div", "exp-tick");
      tick.style.left = `calc(${d.expected / barMax * 100}% - 1px)`;
      track.appendChild(tick);
    }
    row.appendChild(track);
    row.appendChild(dayValue(d));
    row.appendChild(vacIcon(d));
    card.appendChild(row);

    attachTip(row, t => {
      t.appendChild(el("div", "t-title", `${DayNames[i]} ${fmtDay(d.date)}${isToday ? " · hoy" : ""}`));
      t.appendChild(tipRow("Total", d.hours < 0.01 ? "—" : fmtHM(d.hours)));
      if (d.vacation) t.appendChild(tipRow("Ausencia", d.auto));
      else if (d.expected > 0) t.appendChild(tipRow("Previsto", fmtHM(d.expected)));
      d.leaves.forEach(l => t.appendChild(tipRow(`Permiso · ${l.type}`, fmtShort(l.hours))));
      const gap = unloggedGap(d.sessions);
      if (gap > 0.01) t.appendChild(tipRow("Comida (sin fichar)", fmtShort(gap)));
      if (d.rest > 0.01) t.appendChild(tipRow("Descanso", fmtShort(d.rest)));
      if (d.sessions.length) {
        t.appendChild(el("div", "t-sep"));
        d.sessions.forEach(s => {
          t.appendChild(tipRow(
            `${fmtTime(s.in)} – ${s.out ? fmtTime(s.out) : "…"}${s.rest ? " · descanso" : ""}`,
            fmtHM(s.hours) + (s.out ? "" : " en curso")));
        });
      }
    });
  });
}

/* ---------- horario semanal ---------- */
function spanDays(s) {
  const out = s.out || store.now;
  return Math.round((new Date(out.getFullYear(), out.getMonth(), out.getDate())
    - new Date(s.in.getFullYear(), s.in.getMonth(), s.in.getDate())) / 864e5);
}

function endHour(s) {
  return dayKey(s.out || store.now) === dayKey(s.in) ? hourOf(s.out || store.now) : 24;
}

export function renderTimeline(card, w) {
  const days = w.days.filter((d, i) => i < 5 || d.hours >= 0.01 || d.vacation || missed(d));
  const ends = days.flatMap(d => [
    ...d.sessions.flatMap(s => [hourOf(s.in), endHour(s)]),
    ...d.leaves.flatMap(l => [hourOf(new Date(l.from)), hourOf(new Date(l.to))]),
  ]);
  const from = Math.floor(Math.min(8, ...ends)), to = Math.ceil(Math.max(18, ...ends));
  const pct = h => (h - from) / (to - from) * 100 + "%";

  const axis = el("div", "tl-axis");
  for (let h = from; h <= to; h++) {
    const lbl = el("span", null, String(h));
    lbl.style.left = pct(h);
    axis.appendChild(lbl);
  }
  card.appendChild(axis);

  days.forEach(d => {
    const i = (d.date.getDay() + 6) % 7;
    const isToday = d.date.getTime() === store.today.getTime();
    const row = el("div", "dayrow tl-row" + (isToday ? " today" : "") + (d.vacation ? " vac" : ""));
    const lbl = el("span", "dlabel");
    lbl.append(DayNames[i] + " ");
    lbl.appendChild(el("span", "dnum", String(d.date.getDate())));
    row.appendChild(lbl);
    const track = el("div", "track");
    for (let h = from; h <= to; h++) {
      const line = el("div", "tl-grid");
      line.style.left = pct(h);
      track.appendChild(line);
    }
    d.leaves.forEach(l => {
      const block = el("div", "leave", l.type);
      block.title = `${l.type}: ${fmtShort(l.hours)}`;
      block.style.left = pct(hourOf(new Date(l.from)));
      block.style.width = `calc(${pct(hourOf(new Date(l.to)))} - ${pct(hourOf(new Date(l.from)))})`;
      track.appendChild(block);
    });
    const span = (block, from, to) => {
      block.style.left = pct(from);
      block.style.width = `calc(${pct(to)} - ${pct(from)})`;
    };
    const rests = [];
    let prevBlock = null, prevStart = 0;
    d.sessions.forEach((s, k) => {
      const prev = d.sessions[k - 1];
      const joined = prevBlock && prev.out && s.in - prev.out <= 60000;
      if (prev && prev.out && s.in - prev.out > 60000) {
        const gap = el("div", "gap", fmtShort((s.in - prev.out) / 3.6e6));
        span(gap, hourOf(prev.out), hourOf(s.in));
        track.appendChild(gap);
      }
      const start = joined ? hourOf(prev.out) : hourOf(s.in), end = endHour(s);
      const days = spanDays(s);
      const later = days > 0 ? ` (+${days})` : "";
      const block = el("div", "sess" + (s.rest ? " rest" : "") + (joined && !s.rest ? " join-l" : "")
        + (longDay(d) || offHours(s) ? " long" : ""), s.rest ? "" : `${fmtTime(s.in)} – ${s.out ? fmtTime(s.out) + later : "…"}`);
      block.tabIndex = 0;
      attachTip(block, t => {
        t.appendChild(el("div", "t-title",
          `${DayNames[i]} ${fmtDay(d.date)} · ${fmtTime(s.in)} – ${s.out ? fmtTime(s.out) : "en curso"}`));
        t.appendChild(tipRow(s.rest ? "Descanso" : "Trabajo", fmtHM(s.hours)));
        if (days > 0) t.appendChild(el("div", "t-note", `Termina ${days === 1 ? "al día siguiente" : `${days} días después`}`));
        if (longDay(d)) {
          t.appendChild(el("div", "t-note warn",
            `Jornada muy larga: ${fmtHM(d.hours)} en el día, más de ${fmtHM(store.data.long_hours)}, casi siempre una salida sin fichar`));
        }
        if (offHours(s)) {
          const [from, to] = store.data.work_hours;
          t.appendChild(el("div", "t-note warn", `Fuera de horario: fuera de ${fmtClock(from)} a ${fmtClock(to)}`));
        }
      });
      if (s.rest) {
        span(block, hourOf(s.in), end);
        rests.push(block);
        if (joined) span(prevBlock, prevStart, end);
        else prevBlock = null;
        return;
      }
      if (joined) prevBlock.classList.add("join-r");
      span(block, start, end);
      track.appendChild(block);
      prevBlock = block;
      prevStart = start;
    });
    rests.forEach(r => track.appendChild(r));
    row.appendChild(track);
    row.appendChild(dayValue(d));
    row.appendChild(vacIcon(d));
    card.appendChild(row);
  });
}

/* ---------- tabla ---------- */
export function renderTable(weeks) {
  const host = document.getElementById("tableView");
  host.replaceChildren();
  const hasWeekend = weeks.some(w => w.days[5].hours > 0.01 || w.days[6].hours > 0.01);
  const dayCount = hasWeekend ? 7 : 5;

  const table = el("table");
  const cap = el("caption", null, "Horas fichadas por semana y día (horas:minutos). «vac.» = día de vacaciones.");
  cap.style.cssText = "text-align:left;font-size:12px;color:var(--muted-foreground);padding-bottom:8px";
  table.appendChild(cap);
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
  [...weeks].reverse().forEach(w => {
    const tr = el("tr");
    tr.appendChild(el("td", null, `${weekRangeLabel(w)}${w.current ? " (en curso)" : ""}`));
    for (let i = 0; i < dayCount; i++) {
      const d = w.days[i];
      tr.appendChild(el("td", d.hours < 0.01 ? "dim" : null,
        d.hours < 0.01 ? (d.vacation ? "vac." : "—") : fmtClock(d.hours)));
    }
    tr.appendChild(el("td", "dim", fmtClock(w.target)));
    const tot = el("td", null, fmtClock(w.total));
    tot.style.fontWeight = "650";
    tr.appendChild(tot);
    tr.appendChild(
      w.complete && w.allVacation && w.total < 0.01 ? el("td", "dim", "vacaciones")
      : w.error ? el("td", "warn", "fichaje por revisar")
      : w.complete ? el("td", w.delta >= 0 ? "up" : "down", fmtDelta(w.delta))
      : el("td", "dim", w.total >= w.target ? "objetivo alcanzado" : `faltan ${fmtHM(w.target - w.total)}`));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  host.appendChild(table);
}

/* ---------- todo lo que depende del filtro de rango ---------- */
let rangeMonths = 6;
export function setRangeMonths(n) { rangeMonths = n; }

function showWeek(date) {
  calOffset = Math.min(weekOffsetOf(date), store.data.weeks - 1);
  renderCalendar();
  document.getElementById("weekCal").scrollIntoView({ block: "start", behavior: "smooth" });
}

function dayValue(d) {
  if (missed(d)) return el("span", "dvalue long", "sin fichar");
  if (d.hours < 0.01 && d.sessions.some(unclosed)) return el("span", "dvalue long", "sin cerrar");
  return el("span", "dvalue" + (d.hours < 0.01 ? " zero" : "") + (dayError(d) ? " long" : ""),
    d.hours < 0.01 ? (d.vacation ? "vac." : "—") : fmtHM(d.hours));
}

let errorsOpen = false;

function errorPiece(s) {
  return {
    long: () => ["kind", `Jornada de ${fmtShort(s.hours)}`, s.count > 1 ? `en ${s.count} sesiones` : ""],
    off: () => ["kind", "Fuera de horario", `${fmtTime(s.in)} – ${fmtTime(s.out)}${dayKey(s.out) !== dayKey(s.in) ? " (+1)" : ""}`],
    open: () => ["kind", "Sin cerrar", `entrada a las ${fmtTime(s.in)}, sin salida`],
    empty: () => ["kind", "Sin fichar", `con jornada prevista de ${fmtShort(s.expected)}`],
  }[s.kind]();
}

function requestPiece(r) {
  const span = `${fmtTime(new Date(r.from))}${r.to ? `–${fmtTime(new Date(r.to))}` : ""}`;
  return ["req", "Solicitud pendiente", `${span}${r.reason ? ` · ${r.reason}` : ""}`];
}

export function renderErrors() {
  const box = document.getElementById("errorsBanner");
  const errors = punchErrors();
  const requests = store.data.requests || [];
  box.classList.toggle("hidden", !errors.length && !requests.length);
  box.classList.toggle("requests", !errors.length);
  if (!errors.length && !requests.length) return;
  const days = new Map();
  const on = at => {
    const key = isoDay(at);
    if (!days.has(key)) days.set(key, { date: new Date(at.getFullYear(), at.getMonth(), at.getDate()), pieces: [] });
    return days.get(key).pieces;
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
    if (store.data.can_edit || pieces.some(([cls]) => cls === "req")) {
      const fix = el("button", "fix", store.data.can_edit ? "Corregir" : "Revisar");
      fix.type = "button";
      fix.addEventListener("click", () => openDayOf(Number(store.other) || store.data.employee_id, key).catch(e => {
        fix.textContent = "No se pudo abrir";
        fix.title = e.message;
      }));
      li.appendChild(fix);
    }
    list.appendChild(li);
  }
  const details = el("details");
  details.open = errorsOpen;
  details.addEventListener("toggle", () => { errorsOpen = details.open; });
  const summary = el("summary");
  const n = errors.length, m = requests.length;
  summary.appendChild(el("h2", null, [
    n ? `⚠ ${n} ${n === 1 ? "fichaje por corregir" : "fichajes por corregir"}` : "",
    m ? `${m} ${m === 1 ? "solicitud pendiente" : "solicitudes pendientes"}` : "",
  ].filter(Boolean).join(" · ")));
  details.append(summary,
    el("p", null, `Entradas sin cerrar de días anteriores, jornadas de más de ${fmtHM(store.data.long_hours)}, fichajes fuera `
      + `de ${fmtClock(store.data.work_hours[0])} a ${fmtClock(store.data.work_hours[1])} y días con jornada prevista `
      + "sin ningún fichaje, de todo el historial"
      + (m ? ", y las solicitudes de cambio pendientes de tu aprobación" : "")
      + ", un día por línea. Pulsa uno para ver su semana."),
    list);
  box.replaceChildren(details);
}

export function renderAll() {
  const weeks = buildWeeks(Math.min(rangeMonths ? weeksSince(rangeMonths) : store.data.weeks, store.data.weeks));
  renderErrors();
  renderCalendar();
  renderKpis(weeks);
  renderOverview(weeks);
  renderTable(weeks);
  renderPhone();
}
