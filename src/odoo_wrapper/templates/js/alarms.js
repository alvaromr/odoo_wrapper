/*
 * The three alarms, all fired by the page itself so a stale or stopped server cannot swallow them; if the
 * poll fails the page keeps ringing from the copy it has. Each repeats every NotifyEveryMs: three WebAudio
 * beeps plus a blinking <title>. Browsers only allow audio after a gesture, so the status line says «toca la
 * página para oírlo» until the page has been clicked once. «Silenciar avisos» kills them for the day.
 *
 * - End of day: the day's expected hours are met while a session is still open. Repeats until check-out
 *   and the check-out button pulses.
 * - Break over: the open session carries the Descanso reason and started more than break_minutes ago. It
 *   needs no stored stamp: a break is a punched session, so Odoo says when it began. It takes priority over
 *   the end-of-day alarm while on a break.
 * - Lunch over: only after the «Salir a comer» button, never inferred. It fires once lunch + the configured
 *   minutes passes with no session open, and stops past AlarmGrace hours so a long errand does not beep all
 *   afternoon. Guessing was tried first ("checked out with the day unfinished means lunch") and was wrong
 *   in both directions: a mid-morning errand rang like a lunch, leaving early rang for two hours, eating
 *   after the hours were met rang not at all. Do not reintroduce it.
 * - The blinking stops when the reason stops: every branch of the dispatcher that decides "no alarm here"
 *   calls stopFlash(), and a punch runs the dispatcher at once. It used to stop only when the tab regained
 *   focus, so clocking back in while already looking at the page left the title blinking.
 */
import { store, AlarmGrace, NotifyEveryMs } from "./store.js";
import { fmtTime } from "./format.js";
import { buildWeek, indexSessions } from "./week.js";

const BaseTitle = document.title;
let NotifiedAt = 0, AudioCtx = null, FlashTimer = null;
export const LastRing = { lunch: 0, rest: 0 };

export function resetAlarms() {
  NotifiedAt = 0;
  LastRing.lunch = LastRing.rest = 0;
}

function unlockAudio() {
  if (!AudioCtx) AudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (AudioCtx.state !== "suspended") return;
  AudioCtx.resume().then(refreshNotifyNote, () => {});
}

export function refreshNotifyNote() {
  if (store.notifyEl && store.notifyArgs) store.notifyEl.textContent = notifyStatus(...store.notifyArgs);
}
document.addEventListener("pointerdown", unlockAudio);
document.addEventListener("keydown", unlockAudio);

function audioReady() {
  return Boolean(AudioCtx) && AudioCtx.state === "running";
}

function beep() {
  if (!audioReady()) return;
  const t0 = AudioCtx.currentTime;
  for (const offset of [0, 0.3, 0.6]) {
    const osc = AudioCtx.createOscillator(), gain = AudioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t0 + offset);
    gain.gain.exponentialRampToValueAtTime(0.3, t0 + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.25);
    osc.connect(gain).connect(AudioCtx.destination);
    osc.start(t0 + offset);
    osc.stop(t0 + offset + 0.26);
  }
}

function flashTitle(text) {
  if (FlashTimer) return;
  let on = false;
  FlashTimer = setInterval(() => { document.title = (on = !on) ? text : BaseTitle; }, 900);
}

export function stopFlash() {
  if (!FlashTimer) return;
  clearInterval(FlashTimer);
  FlashTimer = null;
  document.title = BaseTitle;
}

export function notifyStatus(open, day, dayRemaining) {
  if (store.state.muted) return "Silenciado hasta mañana";
  if (day.expected <= 0) return "Hoy sin jornada prevista";
  const silent = audioReady() ? "" : " · toca la página para oírlo";
  if (!open) {
    const due = lunchDueAt();
    if (!due) return "Sin fichaje abierto";
    return (due > Date.now()
      ? `Comida hasta las ${fmtTime(due)}`
      : `Comida vencida a las ${fmtTime(due)}`) + silent;
  }
  if (open.rest) {
    const due = breakDueAt(open);
    if (!due) return "En descanso · sin aviso configurado";
    return (due > Date.now()
      ? `Descanso hasta las ${fmtTime(due)}`
      : `Descanso vencido a las ${fmtTime(due)}`) + silent;
  }
  if (dayRemaining > 0) return "Sonará al cumplir la jornada" + silent;
  const left = Math.max(NotifiedAt + NotifyEveryMs - Date.now(), 0);
  return `Avisando cada ${Math.round(NotifyEveryMs / 60000)} min · siguiente ${left < 60000 ? "en menos de 1 min" : `en ${Math.round(left / 60000)} min`}`;
}

function lunchDueAt() {
  return store.state.lunch ? new Date(new Date(store.state.lunch).getTime() + store.state.lunch_minutes * 60000) : null;
}

function breakDueAt(open) {
  return open && open.rest && store.state.break_minutes > 0
    ? new Date(new Date(open.in).getTime() + store.state.break_minutes * 60000)
    : null;
}

function ringWhenDue(due, kind, title) {
  const late = due ? (Date.now() - due.getTime()) / 3.6e6 : -1;
  if (late < 0 || late > AlarmGrace) return stopFlash();
  if (Date.now() - LastRing[kind] < NotifyEveryMs) return;
  LastRing[kind] = Date.now();
  beep();
  flashTitle(title);
}

export function checkAlarms() {
  if (!store.data) return;
  if (store.state.muted) return stopFlash();
  store.now = new Date();
  indexSessions();
  const day = buildWeek(0).days.find(d => d.date.getTime() === store.today.getTime());
  if (!day || day.expected <= 0) return stopFlash();
  const open = store.data.sessions.find(s => !s.out);

  if (open && open.rest) {
    LastRing.lunch = 0;
    return ringWhenDue(breakDueAt(open), "rest", "☕ Descanso terminado");
  }
  if (open) {
    LastRing.lunch = LastRing.rest = 0;
    if (day.hours < day.expected) return stopFlash();
    if (Date.now() - NotifiedAt < NotifyEveryMs) return;
    NotifiedAt = Date.now();
    beep();
    flashTitle("⏰ Jornada cumplida");
    return;
  }
  LastRing.rest = 0;
  return ringWhenDue(lunchDueAt(), "lunch", "🍽 Comida terminada");
}
setInterval(checkAlarms, 30000);
