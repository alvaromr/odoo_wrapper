"""Shared state of the dashboard: the lunch stamp, both durations, the mute, all in ~/.odoo_dashboard/state.json.

- It lives on the server so every open page agrees: silence the alarm on the laptop and the phone stops too.
  It used to live in localStorage, which meant a reload silently un-silenced the alarm and each device had
  its own answer.
- It is kept per Odoo user, keyed by uid, so two people logged in from two browsers each keep their own; the
  devices sharing one session (the paired phone) share its user's. A file from before that, one flat record,
  reads as nobody's and is dropped by the next write.
- read_state(uid) returns {lunch, lunch_minutes, break_minutes, muted, lunch_done, punched_at};
  write_state(uid, ...) merges any of them. Minutes are integers 0..MINUTES_MAX, and a bool is not an integer
  here however much Python disagrees. The mute and lunch_done are stored as today's date and read back as
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
OTHER_STATE = {"lunch": None, "lunch_minutes": LUNCH_DEFAULT, "break_minutes": BREAK_DEFAULT, "muted": True,
               "lunch_done": False, "punched_at": None}
_state_lock = threading.Lock()


def today_iso():
    return datetime.now().astimezone().date().isoformat()


def valid_minutes(value, default):
    ok = isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MINUTES_MAX
    return value if ok else default


def read_users():
    try:
        with open(STATE_FILE) as f:
            raw = json.load(f)
        return {uid: record for uid, record in raw.items() if isinstance(record, dict)}
    except (OSError, ValueError, AttributeError):
        return {}


def read_state(uid):
    try:
        raw = read_users()[str(uid)]
        started, muted, lunch_day = raw.get("lunch"), raw.get("muted"), raw.get("lunch_day")
        lunch_minutes = raw.get("lunch_minutes")
        break_minutes, punched_at = raw.get("break_minutes"), raw.get("punched_at")
    except KeyError:
        started = muted = lunch_day = lunch_minutes = break_minutes = punched_at = None
    try:
        if started and datetime.fromisoformat(started).date().isoformat() != today_iso():
            started = None
    except (TypeError, ValueError):
        started = None
    return {
        "lunch": started,
        "lunch_minutes": valid_minutes(lunch_minutes, LUNCH_DEFAULT),
        "break_minutes": valid_minutes(break_minutes, BREAK_DEFAULT),
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
            "lunch_minutes": changes.get("lunch_minutes", current["lunch_minutes"]),
            "break_minutes": changes.get("break_minutes", current["break_minutes"]),
            "muted": today_iso() if changes.get("muted", current["muted"]) else None,
            "punched_at": changes.get("punched_at", current["punched_at"]),
        }
        write_private(STATE_FILE, json.dumps(users))
        return read_state(uid)
