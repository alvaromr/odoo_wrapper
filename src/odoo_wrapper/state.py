"""Shared state of the dashboard: the lunch stamp, the settings, the mute, all in ~/.odoo_dashboard/state.json.

- It lives on the server so every open page agrees: silence the alarm on the laptop and the phone stops too.
  It used to live in localStorage, which meant a reload silently un-silenced the alarm and each device had
  its own answer.
- It is kept per Odoo user, keyed by uid, so two people logged in from two browsers each keep their own; the
  devices sharing one session (the paired phone) share its user's. A file from before that, one flat record,
  reads as nobody's and is dropped by the next write.
- read_state(uid) returns {lunch, lunch_minutes, break_minutes, lunch_button_from, lunch_button_to, muted,
  lunch_done, punched_at}; write_state(uid, ...) merges any of them. The settings are whole minutes up to
  their MINUTE_LIMITS: both durations up to MINUTES_MAX, and the two ends of the lunch button's window as
  minutes since midnight up to 23:59 (a time field cannot say 24:00), the window ending after it starts
  (window_ok; a file that breaks it reads as the default window). A bool is not an integer here however
  much Python disagrees. The mute and lunch_done are stored as today's date and read back as
  booleans, so they expire by themselves. punched_at is the timestamp of the last punch made through the
  dashboard, written only by the attendance action; it is how open pages notice each other's punches. The
  lunch stamp is ignored if not from today, cleared by the next punch, and dropped by the data builder as soon
  as a session starts after it, which covers clocking back in from the CLI.
- OTHER_STATE is what the page gets while looking at someone else's week: nothing of the viewer's own state
  applies there, and muted keeps the alarms from ringing for another person's day.
"""

import json
import os
import threading
from datetime import datetime

from .client import STATE_DIR, write_private

STATE_FILE = os.path.join(STATE_DIR, "state.json")
LUNCH_DEFAULT = 30
BREAK_DEFAULT = 15
MINUTES_MAX = 240
LAST_MINUTE = 24 * 60 - 1
SETTINGS = {"lunch_minutes": LUNCH_DEFAULT, "break_minutes": BREAK_DEFAULT,
            "lunch_button_from": 13 * 60 + 30, "lunch_button_to": 16 * 60}
MINUTE_LIMITS = {"lunch_minutes": MINUTES_MAX, "break_minutes": MINUTES_MAX,
                 "lunch_button_from": LAST_MINUTE, "lunch_button_to": LAST_MINUTE}
OTHER_STATE = {"lunch": None, **SETTINGS, "muted": True, "lunch_done": False, "punched_at": None}
_state_lock = threading.Lock()


def today_iso():
    return datetime.now().astimezone().date().isoformat()


def valid_minutes(value, default, top=MINUTES_MAX):
    ok = isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= top
    return value if ok else default


def window_ok(settings):
    return settings["lunch_button_from"] < settings["lunch_button_to"]


def read_users():
    try:
        with open(STATE_FILE) as f:
            raw = json.load(f)
        return {uid: record for uid, record in raw.items() if isinstance(record, dict)}
    except (OSError, ValueError, AttributeError):
        return {}


def read_settings(raw):
    settings = {key: valid_minutes(raw.get(key), default, MINUTE_LIMITS[key]) for key, default in SETTINGS.items()}
    if not window_ok(settings):
        settings.update(lunch_button_from=SETTINGS["lunch_button_from"], lunch_button_to=SETTINGS["lunch_button_to"])
    return settings


def read_state(uid):
    raw = read_users().get(str(uid), {})
    started, muted, lunch_day, punched_at = (raw.get(k) for k in ("lunch", "muted", "lunch_day", "punched_at"))
    try:
        if started and datetime.fromisoformat(started).date().isoformat() != today_iso():
            started = None
    except (TypeError, ValueError):
        started = None
    return {
        "lunch": started,
        **read_settings(raw),
        "muted": muted == today_iso(),
        "lunch_done": lunch_day == today_iso(),
        "punched_at": punched_at if isinstance(punched_at, str) else None,
    }


def write_state(uid, **changes):
    with _state_lock:
        current, users = read_state(uid), read_users()
        users[str(uid)] = {
            "lunch": changes.get("lunch", current["lunch"]),
            "lunch_day": today_iso() if changes.get("lunch_done", current["lunch_done"]) else None,
            **{key: changes.get(key, current[key]) for key in SETTINGS},
            "muted": today_iso() if changes.get("muted", current["muted"]) else None,
            "punched_at": changes.get("punched_at", current["punched_at"]),
        }
        write_private(STATE_FILE, json.dumps(users))
        return read_state(uid)
