"""The management view's payload: a week, a month or a year of every employee whose attendances the session can
read, with the problems a reviewer looks for already flagged.

- A payload covers whole weeks, Monday to Sunday: one for the week view, every week touching the month or
  the year for the others (month_span, year_span), read from Odoo in one pass, one query per model, not a
  load per week. Each employee carries its days, its weeks (hours, target and flags of each) and the
  aggregate of the days between start and stop: the week itself, or only the month's own days when a week
  spills over into the next or previous month. The balance counts only days already over, so a period in
  progress does not owe the hours of days still to come; due is the target of those same days, so the page
  can show a period in progress as hours against target up to yesterday, the sum its balance is. The
  employee's flags are those of any of its weeks.
- A week, month or employee total holding a «long» day is marked suspect: that day's hours are a
  forgotten check-out, not work, so the sum and its balance cannot be trusted and the page says so.
- The year goes out summarised by month (year_payload), without its days: a year of days for every
  employee is megabytes. Each month has its own days' hours, target and balance, and the weeks whose
  Thursday falls in it (the ISO rule, so a week straddling two months counts once) with how many were under
  or over, plus how many of its days carry a flag.
- Who shows up is Odoo's call, never ours. The rows are the employees with at least one attendance the session
  can read from LOOKBACK_WEEKS before the period to its end, so an attendance officer sees everyone and a team lead
  only whoever Odoo's record rules let them read (their own team). /api/team answers 403 when the session reads
  nobody else's attendances (client.sees_others), and the dashboard shows its link only then.
- People who left are left out: an employee archived in Odoo (hr.employee active false) keeps their attendances,
  but shows in no period, not even the weeks they still worked. Only the current staff is reviewed. Showing them
  took their departure_date, which only an HR officer may read (a team lead reading their team's attendances got
  an access error for the whole read, seen in real data).
- Each day expects the hours of the contract in force that day (hr.contract in state open or close, its
  resource.calendar): before the hire date, or between two contracts, nothing is expected. The employee's
  own calendar is only the current one, so it used to charge a mid-year hire for the whole year and a
  25 h contract, since moved to 40 h, for 40 h all along (both seen in real data). An employee without any
  contract, or a session that may not read contracts, falls back to the employee's calendar.
- Expected hours and absences come from the same places as the personal payload (data.py): the
  resource.calendar, validated hr.leave and public holidays, read for everyone at once, one query per model.
  A day's target is its calendar hours, zero on a full-day absence, minus the hours of a partial leave. An
  employee without a calendar has no target, so is never flagged as missing a day or hours.
- Flags per day: "open" an attendance left open before today (forgot to check out), "empty" a past day with a
  target and no attendance (forgot to check in), "long" a day over LONG_DAY hours in total, however many sessions
  it took (two sessions of 6 h and 8 h are as suspicious as one of 14 h). Taps under a minute are dropped as they
  are read (data.real_punch), so they flag nothing. Session length is never flagged: sessions of a few seconds are
  double taps that cost nothing, and the attendance officer asked to ignore them. Breaks count in the day's hours
  like any other session, as they do in the personal payload.
- The target is checked per week, not per day: a short day is often made up later that week, so only a
  finished week without punch errors is judged (a day with any flag makes its hours a guess: a missing punch
  reads as hours short, a forgotten check-out as too many; the error is what to fix, in orange), "under"
  below its target by UNDER_MARGIN or more and "over" above it by more than OVER_MARGIN (the page shows each
  day's balance as information, not as a flag). Each total counts its flagged days (flagged_days), so the page
  judges it by the same rule. Both limits are relative to
  each person's own week, 40 h on a full week and less with a holiday, a leave or a shorter contract: the
  attendance officer's rule is «under 40 h, over 45 h», and fixed numbers would flag every week with a
  holiday. The payload carries these limits so the page can explain each flag in words without restating
  them. Today and later are never empty or under: they are not over yet. Nothing is expected before each
  person's first real punch, the same «since» as the personal payload (data.py says why; first_punches reads
  it for everyone in one read_group). UNDER_MARGIN is a minute, the
  personal page's own threshold: no minute may be missing, and a week read «al día» in one view and short
  in the other when it was six.
- What is left to fix goes out apart (fetch_fixes, /api/team?fixes): the same build over the whole history, from
  the first attendance the session can read to this week, keeping only the punch-error days («open», «empty»,
  «long») with their sessions, per employee. Before a person's first real punch no day expects anything, so none
  is missed (thousands of phantom days otherwise). It is the same list the personal page's banner shows for one
  person, and it is built by the same flags as the table, so the two cannot disagree. Being the heaviest load, the
  page asks for it on its own, after the table, and it is cached like the rest.
- Attendance change requests (approval.request, Odoo's Approvals app) sit on the day they ask to change: the local
  date of their date_start, owner matched to the employee through its user. The category is found by name
  (REQUEST_CATEGORY, «Modificación de fichaje» in this Odoo), never by id; cancelled ones are left out. They are
  not flags: a pending one usually explains a flag next to it. Each row counts its pending ones in the period
  (pending), which survives the year's summary, for the page's «Con solicitudes» filter. Someone's own page lists,
  to whoever may approve them only, every pending request of theirs (requests_to_approve, whatever their date): the
  employee never sees it, as they are not the approver. Approvals is optional, and a session that may not read
  requests simply gets none, like the attendance reasons in client.py.
- The payload's reasons are the ones a punch may be given (client.offered_reasons), for the day dialog's
  selector; each session carries its own as reason_id. Without the module the list is empty.
- Read only: the day dialog's writes are corrections.py. The payload is cached per session and period for data.VIEW_TTL,
  longer than the personal one: what someone else punched moves slowly and «Actualizar» forces a reload.
"""

import html
import re
from datetime import date, datetime, time, timedelta, timezone

from . import data
from .client import OdooError, SessionExpired

LOOKBACK_WEEKS = 12
LONG_DAY = data.LONG_HOURS
UNDER_MARGIN = 1 / 60
OVER_MARGIN = 5
REQUEST_CATEGORY = "fichaje"
REQUEST_STATES = ("new", "pending", "approved", "refused")


def odoo_time(day):
    return datetime.combine(day, time()).astimezone().astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def monday_of(day):
    return day - timedelta(days=day.weekday())


def month_span(first):
    stop = (first.replace(day=28) + timedelta(days=4)).replace(day=1)
    monday = monday_of(first)
    return monday, (monday_of(stop - timedelta(days=1)) - monday).days // 7 + 1, first, stop


def year_span(year):
    start, stop = date(year, 1, 1), date(year + 1, 1, 1)
    monday = monday_of(start)
    return monday, (monday_of(stop - timedelta(days=1)) - monday).days // 7 + 1, start, stop


def fetch_team(client, monday, fresh=False, weeks=1, start=None, stop=None):
    key = (client.session_id, monday.isoformat(), weeks, start and start.isoformat())
    return data.cached(key, fresh, lambda: build_team(client, monday, weeks, start, stop), data.VIEW_TTL)


def fetch_year(client, year, fresh=False):
    return data.cached((client.session_id, "year", year), fresh,
                       lambda: year_payload(build_team(client, *year_span(year)), year), data.VIEW_TTL)


def month_row(month, employee, today):
    days = [d for d in employee["days"] if d["date"][:7] == month]
    weeks = [w for w in employee["weeks"]
             if (date.fromisoformat(w["monday"]) + timedelta(days=3)).isoformat()[:7] == month]
    schedule = employee["target"] is not None
    return {
        "month": month,
        "hours": round(sum(d["hours"] for d in days), 2),
        "target": round(sum(d["target"] for d in days), 2) if schedule else None,
        "balance": round(sum(d["hours"] - d["target"] for d in days if d["date"] < today), 2) if schedule else None,
        "due": round(sum(d["target"] for d in days if d["date"] < today), 2) if schedule else None,
        "under": sum("under" in w["flags"] for w in weeks),
        "over": sum("over" in w["flags"] for w in weeks),
        "flagged_days": sum(bool(d["flags"]) for d in days),
        "suspect": any("long" in d["flags"] for d in days),
    }


def fetch_fixes(client, fresh=False):
    def build():
        first = client.call_kw("hr.attendance", "search_read", [[("employee_id.active", "=", True)]],
                               {"fields": ["check_in"], "order": "check_in asc", "limit": 1})
        today = datetime.now().astimezone().date()
        monday = monday_of(data.local(first[0]["check_in"]).date() if first else today)
        return fixes_payload(build_team(client, monday, (monday_of(today) - monday).days // 7 + 1))
    return data.cached((client.session_id, "fixes"), fresh, build, data.VIEW_TTL)


def fixes_payload(payload):
    def items(e):
        return [{"date": d["date"], "kind": kind, "hours": d["hours"], "target": d["target"],
                 "sessions": [{k: s[k] for k in ("id", "in", "out", "hours")} for s in d["sessions"]]}
                for d in e["days"] for kind in d["flags"]]
    rows = [dict({k: e[k] for k in ("id", "name")}, items=items(e))
            for e in payload["employees"]]
    return {"generated_at": payload["generated_at"], "limits": payload["limits"],
            "employees": [r for r in rows if r["items"]]}


def year_payload(payload, year):
    today = payload["generated_at"][:10]
    months = [f"{year}-{m:02d}" for m in range(1, 13)]
    return dict(payload, year=year, employees=[
        {k: v for k, v in e.items() if k not in ("days", "weeks")}
        | {"months": [month_row(m, e, today) for m in months]}
        for e in payload["employees"]
    ])


def plain_text(markup):
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", markup or "")).split())


def fetch_requests(client, user_ids, monday=None, end=None, states=REQUEST_STATES):
    span = [("date_start", ">=", odoo_time(monday)), ("date_start", "<", odoo_time(end))] if monday else []
    try:
        rows = client.call_kw(
            "approval.request", "search_read",
            [[("category_id.name", "ilike", REQUEST_CATEGORY), ("request_owner_id", "in", user_ids),
              ("request_status", "in", list(states))] + span],
            {"fields": ["request_owner_id", "date_start", "date_end", "reason", "request_status", "user_status"],
             "order": "date_start asc"},
        )
    except SessionExpired:
        raise
    except OdooError:
        return []
    return [{
        "id": r.get("id"),
        "user": r["request_owner_id"][0],
        "can_approve": r.get("user_status") == "pending",
        "from": data.local(r["date_start"]).isoformat(),
        "to": data.local(r["date_end"]).isoformat() if r["date_end"] else None,
        "status": r["request_status"],
        "reason": plain_text(r["reason"]),
    } for r in rows]


def requests_to_approve(client, employee_id):
    user = client.call_kw("hr.employee", "read", [[employee_id], ["user_id"]])[0]["user_id"]
    return [r for r in fetch_requests(client, [user[0]], states=("pending",)) if r["can_approve"]] if user else []


def day_row(day, target, absence, sessions, requests, today):
    mine = [s for s in sessions if s["in"][:10] == day.isoformat()]
    requests = [r for r in requests if r["from"][:10] == day.isoformat()]
    past = day < today
    hours = sum(s["hours"] or 0 for s in mine)
    flags = [flag for flag, hit in (
        ("open", past and any(not s["out"] for s in mine)),
        ("empty", past and target > 0 and not mine),
        ("long", hours > LONG_DAY),
    ) if hit]
    return {"date": day.isoformat(), "hours": round(hours, 2), "target": round(target, 2), "absence": absence,
            "sessions": mine, "flags": flags,
            "requests": [{k: v for k, v in r.items() if k != "user"} for r in requests]}


def week_row(monday, days, schedule, today):
    hours = round(sum(d["hours"] for d in days), 2)
    target = round(sum(d["target"] for d in days), 2) if schedule else None
    suspect = any("long" in d["flags"] for d in days)
    judged = bool(schedule) and monday + timedelta(days=7) <= today and not any(d["flags"] for d in days)
    flags = [flag for flag, hit in (
        ("under", judged and hours <= target - UNDER_MARGIN),
        ("over", judged and hours > target + OVER_MARGIN),
    ) if hit]
    past = [d for d in days if d["date"] < today.isoformat()]
    balance = round(sum(d["hours"] - d["target"] for d in past), 2) if schedule else None
    due = round(sum(d["target"] for d in past), 2) if schedule else None
    return {"monday": monday.isoformat(), "hours": hours, "target": target, "balance": balance, "due": due,
            "flags": flags, "suspect": suspect}


def employee_row(employee, schedule_on, absences, sessions, requests, monday, today, weeks=1, start=None, stop=None):
    full = {a["date"]: a["type"] for a in absences if "hours" not in a}
    partial = {}
    for a in absences:
        if "hours" in a:
            partial[a["date"]] = partial.get(a["date"], 0) + a["hours"]
    sessions_on, requests_on = {}, {}
    for s in sessions:
        sessions_on.setdefault(s["in"][:10], []).append(s)
    for r in requests:
        requests_on.setdefault(r["from"][:10], []).append(r)
    days = []
    span = [monday + timedelta(days=i) for i in range(7 * weeks)]
    schedule = any(schedule_on(day.isoformat()) for day in span)
    for day in span:
        iso = day.isoformat()
        day_schedule = schedule_on(iso)
        expected = day_schedule["hours"][day.weekday()] if day_schedule else 0
        target = 0 if iso in full or iso < employee["since"] else max(0, expected - partial.get(iso, 0))
        days.append(day_row(day, target, full.get(iso), sessions_on.get(iso, []), requests_on.get(iso, []), today))
    week_rows = [week_row(monday + timedelta(weeks=w), days[7 * w:7 * w + 7], schedule, today) for w in range(weeks)]
    start, stop = (start or monday).isoformat(), (stop or monday + timedelta(weeks=weeks)).isoformat()
    inside = [d for d in days if start <= d["date"] < stop]
    return {"id": employee["id"], "name": employee["name"],
            "hours": round(sum(d["hours"] for d in inside), 2),
            "target": round(sum(d["target"] for d in inside), 2) if schedule else None,
            "balance": round(sum(d["hours"] - d["target"] for d in inside if d["date"] < today.isoformat()), 2)
            if schedule else None,
            "due": round(sum(d["target"] for d in inside if d["date"] < today.isoformat()), 2) if schedule else None,
            "flags": [flag for flag in ("under", "over") if any(flag in w["flags"] for w in week_rows)],
            "suspect": any("long" in d["flags"] for d in inside),
            "flagged_days": sum(bool(d["flags"]) for d in inside),
            "pending": sum(r["status"] == "pending" for d in inside for r in d["requests"]),
            "weeks": week_rows, "days": days}


def first_punches(client, ids):
    rows = client.call_kw(
        "hr.attendance", "read_group",
        [[("employee_id", "in", ids), ("worked_hours", ">=", data.MIN_SESSION)],
         ["employee_id", "check_in:min"], ["employee_id"]],
        {"lazy": True},
    )
    return {r["employee_id"][0]: monday_of(data.local(r["check_in"]).date()).isoformat()
            for r in rows if r["employee_id"]}


def build_team(client, monday, weeks=1, start=None, stop=None):
    now = datetime.now().astimezone()
    today, end = now.date(), monday + timedelta(weeks=weeks)
    roster = client.call_kw(
        "hr.attendance", "read_group",
        [[("check_in", ">=", odoo_time(monday - timedelta(weeks=LOOKBACK_WEEKS))), ("check_in", "<", odoo_time(end)),
          ("employee_id.active", "=", True)], ["employee_id"], ["employee_id"]],
        {"lazy": True},
    )
    seen = [row["employee_id"][0] for row in roster if row["employee_id"]]
    employees = client.call_kw("hr.employee", "read", [seen, ["name", "resource_calendar_id", "user_id"]])
    ids = [e["id"] for e in employees]
    since = first_punches(client, ids)
    for e in employees:
        e["since"] = since.get(e["id"], monday_of(today).isoformat())
    calendar_of = {e["id"]: e["resource_calendar_id"] and e["resource_calendar_id"][0] for e in employees}
    contracts = data.fetch_contracts(client, ids, monday, end)
    calendar_ids = sorted({cid for cid in calendar_of.values() if cid}
                          | data.contract_calendars(c for cs in contracts.values() for c in cs))
    blocks = client.call_kw(
        "resource.calendar.attendance", "search_read", [[("calendar_id", "in", calendar_ids)]],
        {"fields": ["calendar_id", "dayofweek", "hour_from", "hour_to", "day_period"]},
    )
    schedules = {cid: data.schedule_from([b for b in blocks if b["calendar_id"][0] == cid]) for cid in calendar_ids}
    reason_by_id = {r["id"]: r for r in client.attendance_reasons()}
    records = client.call_kw(
        "hr.attendance", "search_read",
        [[("employee_id", "in", ids), ("check_in", ">=", odoo_time(monday)), ("check_in", "<", odoo_time(end))]],
        {"fields": ["employee_id", "check_in", "check_out", "worked_hours"]
                   + (["attendance_reason_ids"] if reason_by_id else []),
         "order": "check_in asc"},
    )
    holidays = data.holiday_rows(client, monday.isoformat(), end.isoformat(), calendar_ids)
    leaves = data.leave_rows(client, ids, monday.isoformat(), end.isoformat())
    user_of = {e["id"]: e["user_id"] and e["user_id"][0] for e in employees}
    requests = fetch_requests(client, sorted({u for u in user_of.values() if u}), monday, end)

    def row(employee):
        calendar = calendar_of[employee["id"]]
        mine_contracts = contracts.get(employee["id"], [])
        own = {calendar} | data.contract_calendars(mine_contracts)
        pick = data.calendar_on(mine_contracts, calendar)
        absences = data.absences_from(
            [h for h in holidays if not h["calendar_id"] or h["calendar_id"][0] in own],
            [leave for leave in leaves if leave["employee_id"][0] == employee["id"]],
        )
        sessions = [data.session_of(r, reason_by_id) for r in records
                    if r["employee_id"][0] == employee["id"] and data.real_punch(r)]
        mine = [r for r in requests if user_of[employee["id"]] and r["user"] == user_of[employee["id"]]]
        return employee_row(employee, lambda iso: schedules.get(pick(iso)), absences, sessions, mine, monday, today,
                            weeks, start, stop)

    return {
        "week": monday.isoformat(),
        "start": (start or monday).isoformat(),
        "stop": (stop or end).isoformat(),
        "generated_at": now.isoformat(),
        "limits": {"long_day": LONG_DAY, "under_margin": UNDER_MARGIN, "over_margin": OVER_MARGIN},
        "reasons": [{"id": r["id"], "name": r["name"]} for r in client.offered_reasons()],
        "employees": [row(e) for e in employees],
    }
