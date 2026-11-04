/*
 * The hero (today and the current week) and the phone access block of the personal page.
 *
 * - The hero offers check in (Normal), check out, leave for lunch (a check-out that also stamps the lunch),
 *   leave for break (check-out + check-in as Descanso) and return from break (check-out + check-in as
 *   Normal). The lunch button only shows inside its window (13:30 to 16:00 unless set otherwise), on days whose Odoo
 *   calendar has a lunch, and disappears for the rest of the day once used. A UI guard, not a server rule: the
 *   action is a plain check-out and stays valid at any hour. Nothing in Odoo tells which gap was lunch, so the
 *   hero and the day's tooltip call every gap time away («Ausente»), not lunch. The durations and that window
 *   are set in «Ajustes», the gear beside the bell (ui.js).
 * - The week's meter is a gauge: one section per day that expects hours, as wide as those hours and notched every
 *   hour (8 h 30 m from Monday to Thursday and 6 h on Fridays: four long sections and a short one). The hours are
 *   each day's expected ones, after absences and leaves, so the sections add up to the target the fill is measured
 *   against and a day's boundary is where the week stands once that day is done. Its fill is one colour, breaks
 *   included: they count like any other hour, and a week's worth of violet segments read as hours apart.
 * - Where the dashboard does not listen on the LAN (the payload's phone.off, lan.py), the phone block says why and
 *   how to fix it instead of offering to pair: a missing block gave no reason for the missing QR. It first says
 *   what the block is for, since whoever reads it may never have seen the QR it replaces.
 * - The break button and the break row of «Ajustes» exist only when the payload says breaks: true, i.e. Odoo
 *   has the Descanso reason (data.py). Without it no session is ever a break, so the break alarm never fires
 *   either.
 * - The gap between two sessions is only what no hour leave covers (uncovered), in the timeline (render.js) and as
 *   the lunch taken alike (unloggedGap): a doctor's leave taken between two punches had the gap's box and length
 *   written over the leave's, and counted as that day's lunch, so the estimated leave time stopped allowing for one.
 * - A session left open since an earlier day is not today's work: the hero estimates no leave time from it
 *   and its last-punch line says, in orange, since when it is open (leftOpen). The punch buttons still follow
 *   the real open attendance, which is what Odoo will close.
 */

import { notifyStatus, stopFlash } from "./alarms.js";
import { saveState } from "./api.js";
import { fmtDay, fmtDelta, fmtHM, fmtShort, fmtTime } from "./format.js";
import { api, byId, el, warned } from "./shared.js";
import { DayNames, store } from "./store.js";
import { actionButton, bellIcon, fillBar, gearIcon, openSettings, qrIcon } from "./ui.js";
import { buildWeek, lunchHours, lunchOpen, targetLabel, weekRangeLabel } from "./week.js";

/**
 * A check-in (open while its session is) or a check-out, with the time it happened and whether it is a break's.
 * @typedef {object} PunchEvent
 * @property {Date} at
 * @property {boolean} [open]
 * @property {boolean} [out]
 * @property {boolean} rest
 */

/* ---------- último fichaje ---------- */
/** @returns {PunchEvent | null} */
export function lastPunch() {
  /** @type {PunchEvent[]} */
  const events = store.data.sessions.flatMap((s) => {
    const inEv = { at: new Date(s.in), open: !s.out, rest: s.rest };
    return s.out ? [inEv, { at: new Date(s.out), out: true, rest: s.rest }] : [inEv];
  });
  return events.reduce((a, e) => (a && a.at >= e.at ? a : e), /** @type {PunchEvent | null} */ (null));
}

/**
 * @param {Date} from
 * @param {Date} to
 * @param {import("./store.js").Leave[]} leaves
 * @returns {[number, number][]} the stretches of the span no leave covers, in milliseconds
 */
export function uncovered(from, to, leaves) {
  return leaves
    .reduce(
      (free, l) =>
        free.flatMap(([a, b]) => [
          [a, Math.min(b, new Date(l.from).getTime())],
          [Math.max(a, new Date(l.to).getTime()), b],
        ]),
      /** @type {[number, number][]} */ ([[from.getTime(), to.getTime()]]),
    )
    .filter(([a, b]) => b > a);
}

/**
 * @param {import("./store.js").DaySession[]} sessions
 * @param {import("./store.js").Leave[]} leaves
 * @returns {number}
 */
export function unloggedGap(sessions, leaves) {
  return sessions
    .flatMap((s, i) =>
      i && sessions[i - 1].out ? uncovered(/** @type {Date} */ (sessions[i - 1].out), s.in, leaves) : [],
    )
    .reduce((a, [from, to]) => a + (to - from) / 3.6e6, 0);
}

/**
 * @param {PunchEvent} ev
 * @returns {boolean | undefined}
 */
export function leftOpen(ev) {
  return ev.open && ev.at < store.today;
}

/**
 * @param {PunchEvent} ev
 * @returns {string}
 */
export function punchText(ev) {
  const elapsed = (Date.now() - ev.at.getTime()) / 3.6e6;
  if (leftOpen(ev)) {
    return `Entrada del ${fmtDay(ev.at)} a las ${fmtTime(ev.at)} sin cerrar · hace ${fmtShort(elapsed)}`;
  }
  const label = ev.out
    ? ev.rest
      ? "Fin del descanso a las"
      : "Última salida a las"
    : ev.rest
      ? "En descanso desde las"
      : "Entrada a las";
  const since = ev.open ? `llevas ${fmtShort(elapsed)}` : `hace ${fmtShort(elapsed)}`;
  return `${label} ${fmtTime(ev.at)} · ${since}`;
}

/* ---------- hero (hoy y semana actual, no dependen del filtro) ---------- */
/**
 * @param {import("./week.js").Day} day
 * @param {number} dayRemaining
 * @param {number} dayDelta
 * @param {Date | null} leaveAt
 * @param {number} lunchLeft
 * @param {boolean} [leftover]
 * @returns {HTMLDivElement}
 */
export function heroHeadline(day, dayRemaining, dayDelta, leaveAt, lunchLeft, leftover = false) {
  const main = el("div", "main");
  /**
   * @param {string} label
   * @param {string} value
   * @param {string} valueCls
   * @param {{cls?: string, text: string | null}} detail
   */
  const headline = (label, value, valueCls, detail) => {
    main.appendChild(el("span", "label", label));
    main.appendChild(el("div", `value ${valueCls}`, value));
    main.appendChild(el("div", `delta ${detail.cls || "flat"}`, detail.text));
  };
  if (day.expected <= 0) {
    headline("Hoy", "Sin jornada", "text", { text: day.vacation ? day.auto : "hoy no hay jornada prevista" });
  } else if (dayRemaining > 0) {
    headline("Pendiente hoy", fmtShort(dayRemaining), "num", {
      text:
        `para la jornada de ${fmtHM(day.expected)}` +
        (leaveAt ? "" : leftover ? " · hay una entrada anterior sin cerrar" : " · sin fichaje abierto"),
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
      // Stryker disable next-line StringLiteral: an empty class falls back to "flat" in headline(), the same value
      cls: "flat",
      text:
        dayDelta < 1 / 60
          ? `justo en las ${fmtHM(day.expected)} previstas`
          : `▲ ${fmtDelta(dayDelta)} sobre ${fmtHM(day.expected)}`,
    });
  }
  main.appendChild(
    el(
      "div",
      "note",
      `${DayNames[(store.today.getDay() + 6) % 7]} ${fmtDay(store.today)}${day.vacation ? ` · ${day.auto}` : ""}` +
        day.leaves.map((l) => ` · ${l.type} ${fmtShort(l.hours)}`).join("") +
        ` · ${fmtHM(day.hours)} fichadas`,
    ),
  );
  return main;
}

/**
 * @param {import("./week.js").Week} week
 * @param {import("./week.js").Day} day
 * @param {import("./store.js").PayloadSession | undefined} open
 * @param {number} remaining
 * @param {number} restToday
 * @param {number} away
 * @returns {HTMLDivElement}
 */
export function heroMeters(week, day, open, remaining, restToday, away) {
  const box = el("div", "meter-box");

  const dayBlock = el("div", "meter-block");
  const dayDone = day.hours >= day.expected;
  const dayMeter = el("div", `meter day${dayDone ? " done" : ""}`);
  const dayFill = el("div", "fill");
  dayFill.style.width = `${day.expected > 0 ? Math.min((day.hours / day.expected) * 100, 100) : day.hours > 0.01 ? 100 : 0}%`;
  dayMeter.appendChild(fillBar(dayFill, day.sessions, day.hours));
  dayBlock.appendChild(dayMeter);
  const dayCap = el("div", "meter-caption strong");
  dayCap.appendChild(el("span", null, "Jornada de hoy"));
  dayCap.appendChild(
    el(
      "span",
      null,
      `${fmtHM(day.hours)} · ` +
        (day.expected > 0 ? `${Math.round((day.hours / day.expected) * 100)} %` : "sin objetivo"),
    ),
  );
  dayBlock.appendChild(dayCap);
  box.appendChild(dayBlock);

  const weekBlock = el("div", "meter-block");
  if (week.target > 0) {
    const meter = el("div", "meter week");
    const fill = el("div", "fill");
    fill.style.width = `${Math.min((week.total / week.target) * 100, 100)}%`;
    meter.appendChild(fill);
    const scale = el("div", "scale");
    for (const d of week.days.filter((d) => d.expected > 0)) {
      scale.appendChild(el("div", "day")).style.setProperty("--hours", String(d.expected));
    }
    meter.appendChild(scale);
    weekBlock.appendChild(meter);
    const cap = el("div", "meter-caption");
    cap.appendChild(
      el(
        "span",
        null,
        week.error
          ? `Semana ${weekRangeLabel(week)} · hay un fichaje por revisar`
          : remaining > 0
            ? `Semana ${weekRangeLabel(week)} · faltan ${fmtHM(remaining)}`
            : `Semana ${weekRangeLabel(week)} · objetivo alcanzado`,
      ),
    );
    cap.appendChild(el("span", null, `${fmtHM(week.total)} / ${targetLabel(week)}`));
    weekBlock.appendChild(cap);
  } else {
    weekBlock.appendChild(el("div", "note", "Semana marcada como vacaciones"));
  }
  box.appendChild(weekBlock);

  const ev = lastPunch();
  store.punchEl = store.punchEv = null;
  if (ev) {
    const punch = el("div", `lastpunch${leftOpen(ev) ? " stale" : open ? (open.rest ? " rest" : " open") : ""}`);
    punch.appendChild(el("span", "dot"));
    const txt = el("span", null, punchText(ev));
    punch.appendChild(txt);
    box.appendChild(punch);
    store.punchEl = txt;
    store.punchEv = ev;
  } else {
    box.appendChild(el("div", "note", "Sin fichajes registrados"));
  }
  if (away > 0.01) {
    box.appendChild(el("div", "note", `Ausente hoy: ${fmtShort(away)}`));
  }
  if (restToday > 0.01) {
    box.appendChild(
      el("div", "note", `Descanso de hoy: ${fmtShort(restToday)} ausente${open?.rest ? " (en curso)" : ""}`),
    );
  }
  return box;
}

/**
 * @param {import("./store.js").PayloadSession | undefined} open
 * @param {import("./week.js").Day} day
 * @param {number} dayRemaining
 * @returns {HTMLDivElement}
 */
export function heroActions(open, day, dayRemaining) {
  const actions = el("div", "actions");
  const errBox = el("div", "err");
  const outBtn = open ? actionButton(open.rest ? "ghost" : "primary", "Fichar salida", "checkout", errBox) : null;
  if (outBtn && day.expected > 0 && dayRemaining <= 0) outBtn.classList.add("pulse");
  if (open?.rest) {
    actions.appendChild(actionButton("primary", "Volver del descanso", "resume", errBox));
    actions.appendChild(/** @type {HTMLButtonElement} */ (outBtn));
  } else if (open) {
    actions.appendChild(/** @type {HTMLButtonElement} */ (outBtn));
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
  const settings = el("button", "icon-btn");
  settings.type = "button";
  settings.title = "Ajustes";
  settings.setAttribute("aria-label", settings.title);
  settings.appendChild(gearIcon());
  settings.addEventListener("click", openSettings);
  const notify = el("div", "notify-row");
  notify.appendChild(settings);
  notify.appendChild(mute);
  notify.appendChild(store.notifyEl);
  actions.appendChild(notify);
  actions.appendChild(errBox);
  return actions;
}

export function renderHero() {
  const week = buildWeek(0);
  const day = /** @type {import("./week.js").Day} */ (
    week.days.find((d) => d.date.getTime() === store.today.getTime())
  );
  const dayRemaining = Math.max(day.expected - day.hours, 0);
  const dayDelta = day.hours - day.expected;
  const remaining = Math.max(week.target - week.total, 0);
  const restToday = day.rest;
  const open = store.data.sessions.find((s) => !s.out);
  const working = open && new Date(open.in) >= store.today;
  const away = unloggedGap(day.sessions, day.leaves);
  const lunchLeft = away > 0.01 ? 0 : lunchHours(day);
  const leaveAt = working ? new Date(Date.now() + (dayRemaining + lunchLeft) * 3.6e6) : null;

  const hero = byId("hero");
  hero.replaceChildren();
  hero.appendChild(heroHeadline(day, dayRemaining, dayDelta, leaveAt, lunchLeft, Boolean(open && !working)));
  hero.appendChild(heroMeters(week, day, open, remaining, restToday, away));
  if (!store.other) hero.appendChild(heroActions(open, day, dayRemaining));
}

/* ---------- acceso desde el móvil ---------- */
/**
 * A pairing the server issued: its link, the QR as SVG, and when it lapses (ms since the epoch).
 * @typedef {object} Pairing
 * @property {string} url
 * @property {string} qr
 * @property {number} expires_in
 * @property {number} until
 */

let phoneView = "name";
let pairing = /** @type {Pairing | null} */ (null);
let pairError = "";

export function renderPhone() {
  const host = byId("phone");
  const show = store.data.phone && location.protocol === "http:";
  host.classList.toggle("hidden", !show);
  if (!show) return;
  host.replaceChildren();
  const phone = /** @type {import("./store.js").Phone} */ (store.data.phone);
  if (phone.off) {
    const off = el("div", "links");
    off.appendChild(el("h2", null, "Abrir en el móvil"));
    off.appendChild(
      el(
        "div",
        "note",
        "Este panel también se puede usar desde el móvil, conectado a la misma red" +
          " que este ordenador: aquí aparecería un código QR para escanearlo con su cámara. Ahora no está disponible.",
      ),
    );
    off.appendChild(el("div", "note", phone.off));
    host.appendChild(off);
    return;
  }
  /** @type {Object<string, {label: string, url?: string, note: string}>} */
  const views = {
    name: { label: "Por nombre", url: phone.name_url, note: "Si tu móvil resuelve mDNS, vale en todas las redes." },
    ip: { label: "Por IP", url: phone.url, note: "Vale en esta red; al cambiar de red, empareja de nuevo." },
  };
  const left = pairing ? Math.ceil((pairing.until - Date.now()) / 1000) : 0;
  if (left <= 0) pairing = null;
  if (pairing?.qr) {
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
    b.addEventListener("click", () => {
      phoneView = key;
      pairing = null;
      renderPhone();
    });
    seg.appendChild(b);
  }
  links.appendChild(seg);
  links.appendChild(el("div", "url", pairing ? pairing.url : views[phoneView].url));
  if (pairing) {
    const cancel = el("button", "btn ghost", "Cancelar");
    cancel.type = "button";
    cancel.addEventListener("click", unpair);
    links.appendChild(cancel);
    links.appendChild(
      el(
        "div",
        "note",
        `Escanea el código con la cámara del móvil: caduca en ${left} s y sirve` +
          " una sola vez. Si el móvil avisa del certificado, acéptalo.",
      ),
    );
  } else {
    const b = el("button", "btn primary", "Emparejar móvil");
    b.type = "button";
    b.prepend(qrIcon());
    b.addEventListener("click", () => pair(b));
    links.appendChild(b);
    links.appendChild(
      el(
        "div",
        "note",
        pairError ||
          `${views[phoneView].note} El móvil entra con la sesión de este navegador, sin escribir la contraseña.`,
      ),
    );
  }
  host.appendChild(links);
}

/** @param {HTMLButtonElement} button */
async function pair(button) {
  button.disabled = true;
  pairError = "";
  try {
    const res = /** @type {Omit<Pairing, "until">} */ (await api("/api/pair", { name: phoneView === "name" }));
    pairing = { ...res, until: Date.now() + res.expires_in * 1000 };
    const timer = setInterval(() => {
      renderPhone();
      if (!pairing) clearInterval(timer);
    }, 1000);
  } catch (e) {
    pairError = `No se pudo emparejar: ${/** @type {Error} */ (e).message}`;
  }
  renderPhone();
}

function unpair() {
  pairing = null;
  renderPhone();
  api("/api/pair", { revoke: true }).catch(warned("revoking the pairing"));
}
