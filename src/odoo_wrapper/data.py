"""The dashboard payload: attendance sessions, expected schedule and absences, read from Odoo and cached.

- build_data loads the employee's full attendance history (from the first hr.attendance, at least MIN_WEEKS)
  in six calls; the page trims what it shows. Its weeks are counted between calendar dates, not local
  datetimes: across a daylight-saving change the span is an hour short and the oldest week was dropped.
  The payload is cached per Odoo session for DATA_TTL seconds (a
  load costs ~1.8 s against Odoo, ~2 ms from the cache), so two people logged into the same dashboard never
  see each other's data, and every entry is dropped on any punch; fresh=True skips the cache («Actualizar»).
  cached() is that cache for any payload; team.py keys its own per session and period. What the viewer
  reads about other people (the management view, someone else's week) keeps VIEW_TTL, five minutes: moving
  between those pages used to reload from Odoo every time, and «Actualizar» still forces a fresh load. The payload's team
  flag says whether the session reads other people's attendances, so the page links the management view.
- build_data(client, employee) reads someone else's week instead, for the management view's links: the
  same payload, loaded by employee id, and it never touches the shared state, which is the viewer's own.
- Expected hours follow the contract in force each day, as in team.py (fetch_contracts, calendar_on): the
  payload's schedule is the employee's current calendar, and contract_hours lists only the days whose
  contract asks for something else ({date: hours}: 0 before the hire date or between contracts, 5 on a
  25 h contract), so the page changes nothing for someone whose calendar never changed.
- Nothing is expected either before «since», the Monday of the week of the first punch lasting at least
  MIN_SESSION (a minute), or this week's for someone with none: a person starts clocking in this Odoo
  some day, and a test punch of a few seconds months earlier used to turn every day in between into a
  missed one (months of them for one person). Punches under a minute are taps and tests; the ones from
  one to five minutes are real short breaks, so the threshold stays at a minute. The history starts
  there too, at least MIN_WEEKS back; team.py applies the same rule (first_punches).
- A closed punch shorter than MIN_SESSION is dropped as it is read (real_punch), here and in team.py: it
  adds no hours, marks no day as punched and is never off hours (a 22-second tap at two in the morning was
  the whole «off hours» error of a normal day). An open one is kept: it is still running.
- LONG_HOURS is the one threshold for «too long», here and in team.py: a day whose total passes it is a
  punch error in both views, however many sessions it took. WORK_FROM and WORK_TO bound a normal working
  day (6:30 to midnight, generous on purpose; people do start at 7:20 and some work late): a session that
  starts earlier or ends on another day is «off hours», most likely a wrong punch, again in both views. Punch errors to fix are looked for over the whole
  history, with no time limit (the management view's «Fichajes por corregir», the page's banner).
- The absence and session helpers take plain rows so team.py builds the same absences and sessions for
  many employees at once from one query per model.
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
from .client import OdooError, SessionExpired

MIN_WEEKS = 12
MIN_SESSION = 1 / 60
LONG_HOURS = 12
WORK_FROM = 6.5
WORK_TO = 24
DATA_TTL = 45
VIEW_TTL = 300
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


def holiday_rows(client, since, until, calendar_ids):
    return client.call_kw(
        "resource.calendar.leaves",
        "search_read",
        [
            [
                ("resource_id", "=", False),
                "|",
                ("calendar_id", "=", False),
                ("calendar_id", "in", calendar_ids),
                ("date_to", ">=", since),
            ]
            + ([("date_from", "<", until)] if until else [])
        ],
        {"fields": ["name", "date_from", "date_to", "calendar_id"]},
    )


def leave_rows(client, employee_ids, since, until):
    return client.call_kw(
        "hr.leave",
        "search_read",
        [
            [
                ("employee_id", "in", employee_ids),
                ("state", "=", "validate"),
                ("request_date_to", ">=", since),
            ]
            + ([("request_date_from", "<", until)] if until else [])
        ],
        {"fields": ["employee_id", "request_date_from", "request_date_to", "holiday_status_id", "number_of_days",
                    "number_of_hours", "date_from", "date_to"]},
    )


def absences_from(holidays, leaves):
    absences = {}
    for h in holidays:
        d0, d1 = local(h["date_from"]).date(), local(h["date_to"]).date()
        for i in range((d1 - d0).days + 1):
            d = d0 + timedelta(days=i)
            if d.weekday() < 5:
                absences[d.isoformat()] = h["name"]
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


def fetch_absences(client, since, calendar_id):
    holidays = holiday_rows(client, since, None, [calendar_id] if calendar_id else [])
    return absences_from(holidays, leave_rows(client, [client.employee_id], since, None))


def real_punch(record):
    return not record["check_out"] or record["worked_hours"] >= MIN_SESSION


def session_of(record, reason_by_id):
    reason = next((reason_by_id[i] for i in record.get("attendance_reason_ids", []) if i in reason_by_id), None)
    return {
        "id": record.get("id"),
        "in": local(record["check_in"]).isoformat(),
        "out": local(record["check_out"]).isoformat() if record["check_out"] else None,
        "hours": record["worked_hours"] if record["check_out"] else None,
        "rest": bool(reason and reason["is_rest"]),
        "reason": reason["name"] if reason else None,
    }


def cached(key, fresh, build, ttl=DATA_TTL):
    with _data_lock:
        hit = _data_cache.get(key)
        if not fresh and hit and time.monotonic() - hit[0] < ttl:
            return hit[1]
    payload = build()
    with _data_lock:
        _data_cache[key] = (time.monotonic(), payload)
    return payload


def fetch_data(client, fresh=False, employee=None):
    key = (client.session_id, employee) if employee else client.session_id
    return cached(key, fresh, lambda: build_data(client, employee), VIEW_TTL if employee else DATA_TTL)


def drop_data_cache():
    with _data_lock:
        _data_cache.clear()


def fetch_contracts(client, ids, monday, end):
    try:
        rows = client.call_kw(
            "hr.contract", "search_read",
            [[("employee_id", "in", ids), ("state", "in", ["open", "close"]), ("date_start", "<", end.isoformat()),
              "|", ("date_end", "=", False), ("date_end", ">=", monday.isoformat())]],
            {"fields": ["employee_id", "date_start", "date_end", "resource_calendar_id"], "context": {"active_test": False}},
        )
    except SessionExpired:
        raise
    except OdooError:
        return {}
    contracts = {}
    for c in rows:
        contracts.setdefault(c["employee_id"][0], []).append(c)
    return contracts


def calendar_on(contracts, fallback):
    if not contracts:
        return lambda iso: fallback
    def pick(iso):
        c = next((c for c in contracts if c["date_start"] <= iso and (not c["date_end"] or iso <= c["date_end"])), None)
        return c and c["resource_calendar_id"] and c["resource_calendar_id"][0]
    return pick


def contract_hours(client, schedule, monday0, end):
    contracts = fetch_contracts(client, [client.employee_id], monday0, end).get(client.employee_id, [])
    if not contracts:
        return {}
    pick = calendar_on(contracts, client.calendar_id)
    others = {c["resource_calendar_id"][0] for c in contracts if c["resource_calendar_id"]} - {client.calendar_id}
    schedules = {cid: fetch_schedule(client, cid) for cid in sorted(others)}
    schedules[client.calendar_id] = schedule
    base = schedule["hours"] if schedule else [0] * 7
    overrides = {}
    for i in range((end - monday0).days):
        day = monday0 + timedelta(days=i)
        own = schedules.get(pick(day.isoformat()))
        hours = own["hours"][day.weekday()] if own else 0
        if hours != base[day.weekday()]:
            overrides[day.isoformat()] = hours
    return overrides


def build_data(client, employee=None):
    if employee:
        client.load_other(employee)
    else:
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
    real = [r for r in records if r["worked_hours"] >= MIN_SESSION]
    since = week_monday(local(real[0]["check_in"])) if real else cur_monday
    monday0 = min(since, cur_monday - timedelta(weeks=MIN_WEEKS - 1))

    schedule = fetch_schedule(client, client.calendar_id)
    lunch = not employee and state.read_state()["lunch"]
    if lunch and any(local(r["check_in"]) > datetime.fromisoformat(lunch) for r in records):
        state.write_state(lunch=None)

    return {
        "employee": client.employee_name,
        "employee_id": client.employee_id,
        "breaks": client.sign_in_reasons()[1] is not None,
        "team": client.sees_others(),
        "generated_at": now_local.isoformat(),
        "weeks": (cur_monday.date() - monday0.date()).days // 7 + 1,
        "since": since.date().isoformat(),
        "sessions": [session_of(r, reason_by_id) for r in records if real_punch(r)],
        "absences": fetch_absences(client, monday0.date().isoformat(), client.calendar_id),
        "schedule": schedule,
        "long_hours": LONG_HOURS,
        "work_hours": [WORK_FROM, WORK_TO],
        "contract_hours": contract_hours(client, schedule, monday0.date(), (cur_monday + timedelta(weeks=1)).date()),
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
    else:
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
