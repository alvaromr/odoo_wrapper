"""The dashboard payload: attendance sessions, expected schedule and absences, read from Odoo and cached.

- build_data loads the employee's full attendance history (from the first hr.attendance, at least MIN_WEEKS)
  in six calls; the page trims what it shows. The payload is cached per Odoo session for DATA_TTL seconds (a
  load costs ~1.8 s against Odoo, ~2 ms from the cache), so two people logged into the same dashboard never
  see each other's data, and every entry is dropped on any punch; fresh=True skips the cache («Actualizar»).
  The shared state is not part of the payload: it changes between loads, so the server adds it fresh to every
  response.
- Expected hours come from Odoo: resource.calendar.attendance gives the blocks per weekday, their sum is the
  day's target, a gap between blocks (or an explicit day_period "lunch") marks a lunch day. The page's
  constants are only a fallback for a calendar that answers nothing.
- Absences are hr.leave records in state "validate" plus public holidays (resource.calendar.leaves for the
  employee's calendar or global). A leave shorter than a day (number_of_days < 1) keeps its hours and span so
  the page can subtract just those hours; they used to be skipped, which left a 2 h 30 m medical leave
  counted as hours missing.
- Attendance reasons are optional (see client.py). Without them the payload says breaks: false and
  attendance_reason_ids is not even requested — the field only exists with the module installed.
- Punch actions validate the real state (open attendance, its reason) and answer 409 on invalid ones; a
  break is a check-out plus a check-in with the Descanso reason, lunch is a plain check-out that also stamps
  the shared state. Without the Descanso reason, break and resume answer 409 and the page hides them.
"""

import threading
import time
from datetime import date, datetime, timedelta, timezone

from . import state

MIN_WEEKS = 12
DATA_TTL = 45
_data_lock = threading.Lock()
_data_cache = {}


def local(ts):
    return datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).astimezone()


def week_monday(dt):
    return (dt - timedelta(days=dt.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)


def schedule_from(blocks):
    hours, lunch_from = [0.0] * 7, [None] * 7
    spans = [[] for _ in range(7)]
    for block in blocks:
        try:
            day = int(block["dayofweek"])
            start, end = float(block["hour_from"]), float(block["hour_to"])
        except (KeyError, TypeError, ValueError):
            continue
        if not 0 <= day <= 6 or end <= start:
            continue
        if block.get("day_period") == "lunch":
            lunch_from[day] = start
            continue
        hours[day] += end - start
        spans[day].append((start, end))
    for day, day_spans in enumerate(spans):
        day_spans.sort()
        gaps = [earlier[1] for earlier, later in zip(day_spans, day_spans[1:]) if later[0] > earlier[1]]
        if lunch_from[day] is None and gaps:
            lunch_from[day] = gaps[0]
    if not any(hours):
        return None
    return {"hours": [round(h, 2) for h in hours], "lunch_from": lunch_from}


def fetch_schedule(client, calendar_id):
    if not calendar_id:
        return None
    blocks = client.call_kw(
        "resource.calendar.attendance",
        "search_read",
        [[("calendar_id", "=", calendar_id)]],
        {"fields": ["dayofweek", "hour_from", "hour_to", "day_period"]},
    )
    return schedule_from(blocks)


def fetch_absences(client, since, calendar_id):
    absences = {}
    holidays = client.call_kw(
        "resource.calendar.leaves",
        "search_read",
        [
            [
                ("resource_id", "=", False),
                "|",
                ("calendar_id", "=", False),
                ("calendar_id", "=", calendar_id or False),
                ("date_to", ">=", since),
            ]
        ],
        {"fields": ["name", "date_from", "date_to"]},
    )
    for h in holidays:
        d0, d1 = local(h["date_from"]).date(), local(h["date_to"]).date()
        for i in range((d1 - d0).days + 1):
            d = d0 + timedelta(days=i)
            if d.weekday() < 5:
                absences[d.isoformat()] = h["name"]
    leaves = client.call_kw(
        "hr.leave",
        "search_read",
        [
            [
                ("employee_id", "=", client.employee_id),
                ("state", "=", "validate"),
                ("request_date_to", ">=", since),
            ]
        ],
        {"fields": ["request_date_from", "request_date_to", "holiday_status_id", "number_of_days",
                    "number_of_hours", "date_from", "date_to"]},
    )
    partial = []
    for leave in leaves:
        d0 = date.fromisoformat(leave["request_date_from"])
        d1 = date.fromisoformat(leave["request_date_to"])
        days = [d0 + timedelta(days=i) for i in range((d1 - d0).days + 1)]
        days = [d for d in days if d.weekday() < 5 and d.isoformat() not in absences]
        if not days:
            continue
        name = leave["holiday_status_id"][1] if leave["holiday_status_id"] else "Ausencia"
        if leave["number_of_days"] < 1:
            partial.append({
                "date": days[0].isoformat(), "type": name, "hours": leave["number_of_hours"],
                "from": local(leave["date_from"]).isoformat(), "to": local(leave["date_to"]).isoformat(),
            })
            continue
        for d in days:
            absences[d.isoformat()] = name
    return [{"date": k, "type": v} for k, v in sorted(absences.items())] + partial


def fetch_data(client, fresh=False):
    with _data_lock:
        cached = _data_cache.get(client.session_id)
        if not fresh and cached and time.monotonic() - cached[0] < DATA_TTL:
            return cached[1]
    payload = build_data(client)
    with _data_lock:
        _data_cache[client.session_id] = (time.monotonic(), payload)
    return payload


def drop_data_cache():
    with _data_lock:
        _data_cache.clear()


def build_data(client):
    client.load_employee()
    now_local = datetime.now().astimezone()
    cur_monday = week_monday(now_local)
    reason_by_id = {r["id"]: r for r in client.attendance_reasons()}
    records = client.call_kw(
        "hr.attendance",
        "search_read",
        [[("employee_id", "=", client.employee_id)]],
        {
            "fields": ["check_in", "check_out", "worked_hours"] + (["attendance_reason_ids"] if reason_by_id else []),
            "order": "check_in asc",
        },
    )
    monday0 = min(
        week_monday(local(records[0]["check_in"])) if records else cur_monday,
        cur_monday - timedelta(weeks=MIN_WEEKS - 1),
    )

    def session(r):
        reason = next((reason_by_id[i] for i in r.get("attendance_reason_ids", []) if i in reason_by_id), None)
        return {
            "in": local(r["check_in"]).isoformat(),
            "out": local(r["check_out"]).isoformat() if r["check_out"] else None,
            "hours": r["worked_hours"] if r["check_out"] else None,
            "rest": bool(reason and reason["is_rest"]),
            "reason": reason["name"] if reason else None,
        }

    lunch = state.read_state()["lunch"]
    if lunch and any(local(r["check_in"]) > datetime.fromisoformat(lunch) for r in records):
        state.write_state(lunch=None)

    return {
        "employee": client.employee_name,
        "breaks": client.sign_in_reasons()[1] is not None,
        "generated_at": now_local.isoformat(),
        "weeks": (cur_monday - monday0).days // 7 + 1,
        "sessions": [session(r) for r in records],
        "absences": fetch_absences(client, monday0.date().isoformat(), client.calendar_id),
        "schedule": fetch_schedule(client, client.calendar_id),
    }


def punch(client, action):
    if action not in ("checkin", "checkout", "break", "resume", "lunch"):
        return 400, {"error": f"Acción desconocida: {action}"}
    open_att = client.open_attendance()
    normal, rest = client.sign_in_reasons()
    normal_id = normal and normal["id"]
    open_is_rest = client.open_is_rest(open_att, rest)
    if action == "checkin":
        if open_att:
            return 409, {"error": "Ya hay un fichaje abierto"}
        client.punch(normal_id)
    elif action == "checkout":
        if not open_att:
            return 409, {"error": "No hay fichaje abierto"}
        client.punch()
    elif action == "break":
        if not rest:
            return 409, {"error": "Este Odoo no tiene el motivo Descanso"}
        if not open_att:
            return 409, {"error": "No hay fichaje abierto"}
        if open_is_rest:
            return 409, {"error": "Ya estás en descanso"}
        client.punch()
        client.punch(rest["id"])
    elif action == "resume":
        if not open_att or not open_is_rest:
            return 409, {"error": "No hay un descanso abierto"}
        client.punch()
        client.punch(normal_id)
    elif action == "lunch":
        if not open_att:
            return 409, {"error": "No hay fichaje abierto"}
        client.punch()
    stamp = datetime.now().astimezone().isoformat()
    if action == "lunch":
        state.write_state(lunch=stamp, lunch_done=True, punched_at=stamp)
    else:
        state.write_state(lunch=None, punched_at=stamp)
    drop_data_cache()
    return 200, {"ok": True}
