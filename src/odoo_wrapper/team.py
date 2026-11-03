"""The management view's payload: a week, month or year of everyone the session can read, with problems flagged.

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
- Each employee carries its Discord user id (discord), for the day dialog's message about a punch to fix: the
  hr.employee field labelled DISCORD_LABEL that someone added to this Odoo by hand (client.field_named), read as
  text whatever its type, None when it is empty or the field does not exist. A session outside HR reads
  employees only through their public profile, which has no field added by hand, and Odoo refuses the whole
  read (seen in real data, a team lead): read_employees then reads them again without it, so for that session
  nobody has one. discord_of reads it for one employee, for discord.py: the recipient of that message and
  its sender.
- Read only: the day dialog's writes are corrections.py. The payload is cached per session and period for data.VIEW_TTL,
  longer than the personal one: what someone else punched moves slowly and «Actualizar» forces a reload.
"""

from __future__ import annotations

import html
import re
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Callable, cast

from odoo_wrapper import data
from odoo_wrapper.client import OdooClient, OdooError, SessionExpired

LOOKBACK_WEEKS = 12
LONG_DAY = data.LONG_HOURS
UNDER_MARGIN = 1 / 60
OVER_MARGIN = 5
REQUEST_CATEGORY = "fichaje"
REQUEST_STATES = ("new", "pending", "approved", "refused")
DISCORD_LABEL = "discord"


def hundredths(hours: float) -> float:
    """Round hours to the hundredth the payload carries."""
    return round(hours, 2)


def odoo_time(day: date) -> str:
    """Return a day's local midnight as Odoo's UTC stamp."""
    return datetime.combine(day, time()).astimezone().astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def monday_of(day: date) -> date:
    """Return the Monday of a day's week."""
    return day - timedelta(days=day.weekday())


def month_span(first: date) -> tuple[date, int, date, date]:
    """Return the weeks touching a month, as Monday, count, first day and the next month's first."""
    stop = date(first.year + first.month // 12, first.month % 12 + 1, 1)
    monday = monday_of(first)
    return monday, (monday_of(stop - timedelta(days=1)) - monday).days // 7 + 1, first, stop


def year_span(year: int) -> tuple[date, int, date, date]:
    """Return the weeks touching a year, as Monday, count, its first day and the next year's."""
    start, stop = date(year, 1, 1), date(year + 1, 1, 1)
    monday = monday_of(start)
    return monday, (monday_of(stop - timedelta(days=1)) - monday).days // 7 + 1, start, stop


def fetch_team(client: OdooClient, span: tuple[Any, ...], fresh: bool = False) -> dict[str, Any]:
    """Return the payload of a span of weeks, as from month_span or (monday,), cached for the view."""
    monday, weeks, start, stop = period(*span)
    key = (client.session_id, monday.isoformat(), weeks, start and start.isoformat())
    return data.cached(key, fresh, lambda: build_team(client, monday, weeks, start, stop), data.VIEW_TTL)


def period(
    monday: date, weeks: int = 1, start: date | None = None, stop: date | None = None
) -> tuple[date, int, date | None, date | None]:
    """Return a span with its defaults: one week, counted whole."""
    return monday, weeks, start, stop


def fetch_year(client: OdooClient, year: int, fresh: bool = False) -> dict[str, Any]:
    """Return a year's payload, one row per month, cached for the view."""
    return data.cached(
        (client.session_id, "year", year),
        fresh,
        lambda: year_payload(build_team(client, *year_span(year)), year),
        data.VIEW_TTL,
    )


def month_row(month: str, employee: dict[str, Any], today: str) -> dict[str, Any]:
    """Return an employee's month: its own days' sums and the weeks whose Thursday falls in it."""
    days = [d for d in employee["days"] if d["date"][:7] == month]
    weeks = [
        w for w in employee["weeks"] if (date.fromisoformat(w["monday"]) + timedelta(days=3)).isoformat()[:7] == month
    ]
    schedule = employee["target"] is not None
    return {
        "month": month,
        "hours": hundredths(sum(d["hours"] for d in days)),
        "target": hundredths(sum(d["target"] for d in days)) if schedule else None,
        "balance": hundredths(sum(d["hours"] - d["target"] for d in days if d["date"] < today)) if schedule else None,
        "due": hundredths(sum(d["target"] for d in days if d["date"] < today)) if schedule else None,
        "under": sum("under" in w["flags"] for w in weeks),
        "over": sum("over" in w["flags"] for w in weeks),
        "flagged_days": sum(bool(d["flags"]) for d in days),
        "suspect": any("long" in d["flags"] for d in days),
    }


def fetch_fixes(client: OdooClient, fresh: bool = False) -> dict[str, Any]:
    """Return every punch to fix since the first one in Odoo, by employee, cached for the view."""

    def build() -> dict[str, Any]:
        first = client.call_kw(
            "hr.attendance",
            "search_read",
            [[("employee_id.active", "=", True)]],
            {"fields": ["check_in"], "order": "check_in asc", "limit": 1},
        )
        today = datetime.now().astimezone().date()
        monday = monday_of(data.local(first[0]["check_in"]).date() if first else today)
        return fixes_payload(build_team(client, monday, (monday_of(today) - monday).days // 7 + 1))

    return data.cached((client.session_id, "fixes"), fresh, build, data.VIEW_TTL)


def fixes_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Reduce a payload to the flagged days of each employee who has any."""

    def items(e: dict[str, Any]) -> list[dict[str, Any]]:
        return [
            {
                "date": d["date"],
                "kind": kind,
                "hours": d["hours"],
                "target": d["target"],
                "sessions": [{k: s[k] for k in ("id", "in", "out", "hours")} for s in d["sessions"]],
            }
            for d in e["days"]
            for kind in d["flags"]
        ]

    rows = [dict({k: e[k] for k in ("id", "name")}, items=items(e)) for e in payload["employees"]]
    return {
        "generated_at": payload["generated_at"],
        "limits": payload["limits"],
        "employees": [r for r in rows if r["items"]],
    }


def year_payload(payload: dict[str, Any], year: int) -> dict[str, Any]:
    """Turn a year of weeks into one row per month for each employee."""
    today = payload["generated_at"][:10]
    months = [f"{year}-{m:02d}" for m in range(1, 13)]
    return dict(
        payload,
        year=year,
        employees=[
            {k: v for k, v in e.items() if k not in ("days", "weeks")}
            | {"months": [month_row(m, e, today) for m in months]}
            for e in payload["employees"]
        ],
    )


def plain_text(markup: str | None) -> str:
    """Return the text of Odoo's HTML, on one line."""
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", markup or "")).split())


def fetch_requests(
    client: OdooClient,
    user_ids: list[int],
    monday: date | None = None,
    end: date | None = None,
    states: tuple[str, ...] = REQUEST_STATES,
) -> list[dict[str, Any]]:
    """Return these users' attendance change requests, in a span when given, or none if they cannot be read."""
    span = (
        [("date_start", ">=", odoo_time(monday)), ("date_start", "<", odoo_time(cast("date", end)))] if monday else []
    )
    try:
        rows = client.call_kw(
            "approval.request",
            "search_read",
            [
                [
                    ("category_id.name", "ilike", REQUEST_CATEGORY),
                    ("request_owner_id", "in", user_ids),
                    ("request_status", "in", list(states)),
                ]
                + span
            ],
            {
                "fields": ["request_owner_id", "date_start", "date_end", "reason", "request_status", "user_status"],
                "order": "date_start asc",
            },
        )
    except SessionExpired:
        raise
    except OdooError:
        return []
    return [
        {
            "id": r.get("id"),
            "user": r["request_owner_id"][0],
            "can_approve": r.get("user_status") == "pending",
            "from": data.local(r["date_start"]).isoformat(),
            "to": data.local(r["date_end"]).isoformat() if r["date_end"] else None,
            "status": r["request_status"],
            "reason": plain_text(r["reason"]),
        }
        for r in rows
    ]


def requests_to_approve(client: OdooClient, employee_id: int) -> list[dict[str, Any]]:
    """Return an employee's pending change requests the session's user may approve."""
    user = client.call_kw("hr.employee", "read", [[employee_id], ["user_id"]])[0]["user_id"]
    return [r for r in fetch_requests(client, [user[0]], states=("pending",)) if r["can_approve"]] if user else []


def day_row(
    day: date,
    target: float,
    absence: str | None,
    punches: tuple[list[dict[str, Any]], list[dict[str, Any]]],
    today: date,
) -> dict[str, Any]:
    """Return a day's hours, target, sessions, requests and flags: left open, not punched, too long."""
    sessions, requests = punches
    mine = [s for s in sessions if s["in"][:10] == day.isoformat()]
    requests = [r for r in requests if r["from"][:10] == day.isoformat()]
    past = day < today
    hours = sum(s["hours"] or 0 for s in mine)
    flags = [
        flag
        for flag, hit in (
            ("open", past and any(not s["out"] for s in mine)),
            ("empty", past and target > 0 and not mine),
            ("long", hours > LONG_DAY),
        )
        if hit
    ]
    return {
        "date": day.isoformat(),
        "hours": hundredths(hours),
        "target": hundredths(target),
        "absence": absence,
        "sessions": mine,
        "flags": flags,
        "requests": [{k: v for k, v in r.items() if k != "user"} for r in requests],
    }


def week_row(monday: date, days: list[dict[str, Any]], schedule: bool, today: date) -> dict[str, Any]:
    """Return a week's hours, target and balance, flagged under or over once it is over."""
    hours = hundredths(sum(d["hours"] for d in days))
    suspect = any("long" in d["flags"] for d in days)
    target: float | None = None
    balance: float | None = None
    due: float | None = None
    flags: list[str] = []
    if schedule:
        target = hundredths(sum(d["target"] for d in days))
        judged = monday + timedelta(days=7) <= today and not any(d["flags"] for d in days)
        short = hours <= target - UNDER_MARGIN  # pragma: no mutate - hours and target are hundredths, never 1/60 apart
        flags = [
            flag
            for flag, hit in (
                ("under", judged and short),
                ("over", judged and hours > target + OVER_MARGIN),
            )
            if hit
        ]
        past = [d for d in days if d["date"] < today.isoformat()]
        balance = hundredths(sum(d["hours"] - d["target"] for d in past))
        due = hundredths(sum(d["target"] for d in past))
    return {
        "monday": monday.isoformat(),
        "hours": hours,
        "target": target,
        "balance": balance,
        "due": due,
        "flags": flags,
        "suspect": suspect,
    }


def employee_row(
    employee: dict[str, Any],
    schedule_on: Callable[[str], dict[str, Any] | None],
    punches: tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]],
    span: tuple[Any, ...],
    today: date,
) -> dict[str, Any]:
    """Return an employee's days and weeks over a span, and the sums of the days between its start and stop."""
    absences, sessions, requests = punches
    monday, weeks, start, stop = period(*span)
    full = {a["date"]: a["type"] for a in absences if "hours" not in a}
    partial: dict[str, float] = {}
    for a in absences:
        if "hours" in a:
            partial[a["date"]] = partial.get(a["date"], 0) + a["hours"]
    sessions_on: dict[str, list[dict[str, Any]]] = {}
    requests_on: dict[str, list[dict[str, Any]]] = {}
    for s in sessions:
        sessions_on.setdefault(s["in"][:10], []).append(s)
    for r in requests:
        requests_on.setdefault(r["from"][:10], []).append(r)
    days = []
    dates = [monday + timedelta(days=i) for i in range(7 * weeks)]
    schedule = any(schedule_on(day.isoformat()) for day in dates)
    for day in dates:
        iso = day.isoformat()
        day_schedule = schedule_on(iso)
        expected = day_schedule["hours"][day.weekday()] if day_schedule else 0
        target = 0 if iso in full or iso < employee["since"] else max(0, expected - partial.get(iso, 0))
        days.append(day_row(day, target, full.get(iso), (sessions_on.get(iso, []), requests_on.get(iso, [])), today))
    week_rows = [week_row(monday + timedelta(weeks=w), days[7 * w : 7 * w + 7], schedule, today) for w in range(weeks)]
    first, last = (start or monday).isoformat(), (stop or monday + timedelta(weeks=weeks)).isoformat()
    inside = [d for d in days if first <= d["date"] < last]
    return {
        "id": employee["id"],
        "name": employee["name"],
        "discord": employee.get("discord"),
        "hours": hundredths(sum(d["hours"] for d in inside)),
        "target": hundredths(sum(d["target"] for d in inside)) if schedule else None,
        "balance": hundredths(sum(d["hours"] - d["target"] for d in inside if d["date"] < today.isoformat()))
        if schedule
        else None,
        "due": hundredths(sum(d["target"] for d in inside if d["date"] < today.isoformat())) if schedule else None,
        "flags": [flag for flag in ("under", "over") if any(flag in w["flags"] for w in week_rows)],
        "suspect": any("long" in d["flags"] for d in inside),
        "flagged_days": sum(bool(d["flags"]) for d in inside),
        "pending": sum(r["status"] == "pending" for d in inside for r in d["requests"]),
        "weeks": week_rows,
        "days": days,
    }


def read_employees(client: OdooClient, ids: list[int], fields: list[str]) -> list[dict[str, Any]]:
    """Read employees with their Discord field when Odoo has it and lets it be read."""
    discord = client.field_named("hr.employee", DISCORD_LABEL)
    try:
        rows = client.call_kw("hr.employee", "read", [ids, fields + ([discord] if discord else [])])
    except SessionExpired:
        raise
    except OdooError:
        if not discord:
            raise
        rows = client.call_kw("hr.employee", "read", [ids, fields])
    return [dict(r, discord=str(r.get(discord) or "").strip() or None) for r in rows]


def discord_of(client: OdooClient, employee_id: int) -> str | None:
    """Return what an employee's Discord field holds, or None."""
    held: str | None = read_employees(client, [employee_id], ["name"])[0]["discord"]
    return held


def first_punches(client: OdooClient, ids: list[int]) -> dict[int, str]:
    """Return the Monday of each employee's first real punch, by id."""
    rows = client.call_kw(
        "hr.attendance",
        "read_group",
        [
            [("employee_id", "in", ids), ("worked_hours", ">=", data.MIN_SESSION)],
            ["employee_id", "check_in:min"],
            ["employee_id"],
        ],
        {"lazy": True},
    )
    return {
        r["employee_id"][0]: monday_of(data.local(r["check_in"]).date()).isoformat() for r in rows if r["employee_id"]
    }


def build_team(
    client: OdooClient, monday: date, weeks: int = 1, start: date | None = None, stop: date | None = None
) -> dict[str, Any]:
    """Read from Odoo, one query per model, every employee with attendances in the weeks, and their rows."""
    now = datetime.now().astimezone()
    today, end = now.date(), monday + timedelta(weeks=weeks)
    roster = client.call_kw(
        "hr.attendance",
        "read_group",
        [
            [
                ("check_in", ">=", odoo_time(monday - timedelta(weeks=LOOKBACK_WEEKS))),
                ("check_in", "<", odoo_time(end)),
                ("employee_id.active", "=", True),
            ],
            ["employee_id"],
            ["employee_id"],
        ],
        {"lazy": True},
    )
    seen = [row["employee_id"][0] for row in roster if row["employee_id"]]
    employees = read_employees(client, seen, ["name", "resource_calendar_id", "user_id"])
    ids = [e["id"] for e in employees]
    since = first_punches(client, ids)
    for e in employees:
        e["since"] = since.get(e["id"], monday_of(today).isoformat())
    calendar_of = {e["id"]: e["resource_calendar_id"] and e["resource_calendar_id"][0] for e in employees}
    contracts = data.fetch_contracts(client, ids, monday, end)
    calendar_ids = sorted(
        {cid for cid in calendar_of.values() if cid}
        | data.contract_calendars(c for cs in contracts.values() for c in cs)
    )
    blocks = client.call_kw(
        "resource.calendar.attendance",
        "search_read",
        [[("calendar_id", "in", calendar_ids)]],
        {"fields": ["calendar_id", "dayofweek", "hour_from", "hour_to", "day_period"]},
    )
    schedules = {cid: data.schedule_from([b for b in blocks if b["calendar_id"][0] == cid]) for cid in calendar_ids}
    reason_by_id = {r["id"]: r for r in client.attendance_reasons()}
    records = client.call_kw(
        "hr.attendance",
        "search_read",
        [[("employee_id", "in", ids), ("check_in", ">=", odoo_time(monday)), ("check_in", "<", odoo_time(end))]],
        {
            "fields": ["employee_id", "check_in", "check_out", "worked_hours"]
            + (["attendance_reason_ids"] if reason_by_id else []),
            "order": "check_in asc",
        },
    )
    holidays = data.holiday_rows(client, monday.isoformat(), end.isoformat(), calendar_ids)
    leaves = data.leave_rows(client, ids, monday.isoformat(), end.isoformat())
    user_of = {e["id"]: e["user_id"] and e["user_id"][0] for e in employees}
    requests = fetch_requests(client, sorted({u for u in user_of.values() if u}), monday, end)

    def row(employee: dict[str, Any]) -> dict[str, Any]:
        calendar = calendar_of[employee["id"]]
        mine_contracts = contracts.get(employee["id"], [])
        own = {calendar} | data.contract_calendars(mine_contracts)
        pick = data.calendar_on(mine_contracts, calendar)
        absences = data.absences_from(
            [h for h in holidays if not h["calendar_id"] or h["calendar_id"][0] in own],
            [leave for leave in leaves if leave["employee_id"][0] == employee["id"]],
        )
        sessions = [
            data.session_of(r, reason_by_id)
            for r in records
            if r["employee_id"][0] == employee["id"] and data.real_punch(r)
        ]
        mine = [r for r in requests if user_of[employee["id"]] and r["user"] == user_of[employee["id"]]]
        return employee_row(
            employee,
            lambda iso: schedules.get(pick(iso)),
            (absences, sessions, mine),
            (monday, weeks, start, stop),
            today,
        )

    return {
        "week": monday.isoformat(),
        "start": (start or monday).isoformat(),
        "stop": (stop or end).isoformat(),
        "generated_at": now.isoformat(),
        "limits": {"long_day": LONG_DAY, "under_margin": UNDER_MARGIN, "over_margin": OVER_MARGIN},
        "reasons": [{"id": r["id"], "name": r["name"]} for r in client.offered_reasons()],
        "employees": [row(e) for e in employees],
    }
