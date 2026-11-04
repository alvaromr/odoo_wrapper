"""The rules of the management view's payload, over plain rows: days, weeks, flags, months and what is left to fix.

Nothing here reads Odoo, the disk, the network or the clock: the rows team.py read go in, the payload comes out, and
`now` and `today` are arguments. The rules shared with the personal page (sessions, absences, schedules, the
thresholds) are attendance_rules.py's, and tests/test_project.py checks that this module imports nothing that could
do I/O.

- A payload covers whole weeks, Monday to Sunday: one for the week view, every week touching the month or
  the year for the others (month_span, year_span). Each employee carries its days, its weeks (hours, target and
  flags of each) and the aggregate of the days between start and stop: the week itself, or only the month's own
  days when a week spills over into the next or previous month. The balance counts only days already over, so a
  period in progress does not owe the hours of days still to come; due is the target of those same days, so the
  page can show a period in progress as hours against target up to yesterday, the sum its balance is. The
  employee's flags are those of any of its weeks.
- A week, month or employee total holding a «long» day is marked suspect: that day's hours are a
  forgotten check-out, not work, so the sum and its balance cannot be trusted and the page says so.
- The year goes out summarised by month (year_payload), without its days: a year of days for every
  employee is megabytes. Each month has its own days' hours, target and balance, and the weeks whose
  Thursday falls in it (the ISO rule, so a week straddling two months counts once) with how many were under
  or over, plus how many of its days carry a flag.
- Each day expects the hours of the contract in force that day (attendance_rules.calendar_on): before the hire date, or
  between two contracts, nothing is expected. The employee's own calendar is only the current one, so it used to
  charge a mid-year hire for the whole year and a 25 h contract, since moved to 40 h, for 40 h all along (both
  seen in real data). An employee without any contract, or a session that may not read contracts, falls back to
  the employee's calendar.
- A day's target is its calendar hours, zero on a full-day absence, minus the hours of a partial leave. An
  employee without a calendar has no target, so is never flagged as missing a day or hours.
- Flags per day: "open" an attendance left open before today (forgot to check out), "empty" a past day with a
  target and no attendance (forgot to check in), "long" a day over LONG_DAY hours in total, however many sessions
  it took (two sessions of 6 h and 8 h are as suspicious as one of 14 h). Taps under a minute are dropped as they
  are read (attendance_rules.real_punch), so they flag nothing. Session length is never flagged: sessions of a few
  seconds are double taps that cost nothing, and the attendance officer asked to ignore them. Breaks count in the
  day's hours like any other session, as they do in the personal payload.
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
  person's first real punch, the same «since» as the personal payload (attendance_rules.py says why). UNDER_MARGIN is
  a minute, the personal page's own threshold: no minute may be missing, and a week read «al día» in one view
  and short in the other when it was six.
- What is left to fix goes out apart (fixes_payload, /api/team?fixes): the same build over the whole history, from
  the first attendance the session can read to this week (fixes_span), keeping only the punch-error days («open»,
  «empty», «long») with their sessions, per employee. Before a person's first real punch no day expects anything,
  so none is missed (thousands of phantom days otherwise). It is the same list the personal page's banner shows
  for one person, and it is built by the same flags as the table, so the two cannot disagree.
- Attendance change requests (approval.request, Odoo's Approvals app) sit on the day they ask to change: the local
  date of their date_start, owner matched to the employee through its user. They are not flags: a pending one
  usually explains a flag next to it. Each row counts its pending ones in the period (pending), which survives
  the year's summary, for the page's «Con solicitudes» filter.
- A notice, for `odoo notices`' spreadsheet (notices), is a day already over with a punch error still unfixed
  (any day flag, «Incidencia») or an attendance change request («Solicitud», or «Solicitud (borrador)» while it is
  a draft nobody has submitted yet), as the first kind of NOTICE_KINDS the day holds: a request is the error being
  dealt with, and a row for each counted it twice in the totals.
- The payload's reasons are the ones a punch may be given, for the day dialog's selector; each session carries its
  own as reason_id. Without the module the list is empty.
- Each employee carries its Discord user id (discord), for the day dialog's message about a punch to fix: the
  field's text whatever its type, None when it is empty or the session read none (with_discord).
- Types. The rows of the models attendance_rules.py does not read are the TypedDicts below, with exactly the fields
  team.py requests (attendance_rules.py says how Odoo's empty values are typed), and the payload is the TypedDicts too:
  each employee, week and day, the year's months and the fixes. An employee grows as it is read (the Discord id with
  with_discord, the first punch with team_payload), one TypedDict for each step. A flag is one of a closed set of
  words. Keys that are Python keywords are written with the functional TypedDict syntax. The one cast is
  year_employee, which drops two keys of an employee by name: a TypedDict cannot say «all but these», and the
  result is exactly YearEmployee's totals.
"""

from __future__ import annotations

import html
import re
from collections.abc import Sequence
from datetime import date, datetime, time, timedelta, timezone
from typing import Callable, Literal, NamedTuple, Optional, TypedDict, Union, cast

from odoo_wrapper import attendance_rules
from odoo_wrapper.attendance_rules import Many2one, MaybeMany2one

LONG_DAY = attendance_rules.LONG_HOURS
UNDER_MARGIN = 1 / 60
OVER_MARGIN = 5
Span = Union[tuple[date], tuple[date, int, Optional[date], Optional[date]]]
DayFlag = Literal["open", "empty", "long"]
WeekFlag = Literal["under", "over"]
WEEK_FLAGS: tuple[WeekFlag, ...] = ("under", "over")
NOTICE_KINDS: tuple[tuple[str, Callable[[Day], bool]], ...] = (
    ("Solicitud", lambda d: any(r["status"] != "new" for r in d["requests"])),
    ("Solicitud (borrador)", lambda d: bool(d["requests"])),
    ("Incidencia", lambda d: bool(d["flags"])),
)


class EmployeeRow(TypedDict):
    """An hr.employee, with the fields team.py reads from Odoo."""

    id: int
    name: str
    resource_calendar_id: MaybeMany2one
    user_id: MaybeMany2one


class Employee(EmployeeRow):
    """An employee with the Discord user id its form holds, None when it is empty or unreadable."""

    discord: str | None


class TrackedEmployee(Employee):
    """An employee with the Monday of their first real punch, before which nothing is expected."""

    since: str


class TeamAttendanceRow(attendance_rules.AttendanceRow):
    """An hr.attendance of someone in the management view."""

    employee_id: Many2one


class TeamBlockRow(attendance_rules.BlockRow):
    """A resource.calendar.attendance with the calendar it belongs to."""

    calendar_id: Many2one


class RequestRow(TypedDict):
    """An approval.request for an attendance change."""

    id: int
    request_owner_id: Many2one
    date_start: str
    date_end: str | Literal[False]
    reason: str | Literal[False]
    request_status: str
    user_status: str


class EmployeeGroup(TypedDict):
    """A row of an hr.attendance read_group by employee."""

    employee_id: MaybeMany2one


class FirstCheckInGroup(EmployeeGroup):
    """A row of an hr.attendance read_group by employee with the earliest check-in of each."""

    check_in: str


DayRequest = TypedDict(
    "DayRequest",
    {
        "id": Optional[int],
        "can_approve": bool,
        "from": str,
        "to": Optional[str],
        "status": str,
        "reason": str,
    },
)


class ChangeRequest(DayRequest):
    """An attendance change request as the payload carries it, with the user who owns it."""

    user: int


class Day(TypedDict):
    """An employee's day: its hours against its target, sessions, requests and flags."""

    date: str
    hours: float
    target: float
    absence: str | None
    sessions: list[attendance_rules.Session]
    flags: list[DayFlag]
    requests: list[DayRequest]


class Week(TypedDict):
    """An employee's week: its hours against its target, once over flagged under or over."""

    monday: str
    hours: float
    target: float | None
    balance: float | None
    due: float | None
    flags: list[WeekFlag]
    suspect: bool


class EmployeeTotals(TypedDict):
    """An employee's sums over a period."""

    id: int
    name: str
    discord: str | None
    hours: float
    target: float | None
    balance: float | None
    due: float | None
    flags: list[WeekFlag]
    suspect: bool
    flagged_days: int
    pending: int


class TeamEmployee(EmployeeTotals):
    """An employee of the management view with the weeks and days of the period."""

    weeks: list[Week]
    days: list[Day]


class Month(TypedDict):
    """An employee's month in the year's summary."""

    month: str
    hours: float
    target: float | None
    balance: float | None
    due: float | None
    under: int
    over: int
    flagged_days: int
    suspect: bool


class YearEmployee(EmployeeTotals):
    """An employee of the year's summary: the totals and a row for each month."""

    months: list[Month]


class Limits(TypedDict):
    """The limits the flags are judged by, for the page to explain them."""

    long_day: int
    under_margin: float
    over_margin: int


class OfferedReason(TypedDict):
    """An attendance reason a punch may be given."""

    id: int
    name: str


class PayloadHead(TypedDict):
    """What the management view's payloads begin with: the span, when it was made, the limits and the reasons."""

    week: str
    start: str
    stop: str
    generated_at: str
    limits: Limits
    reasons: list[OfferedReason]


class TeamPayload(PayloadHead):
    """The management view's payload for a span of weeks."""

    employees: list[TeamEmployee]


class YearPayload(PayloadHead):
    """The management view's payload for a year, summarised by month."""

    employees: list[YearEmployee]
    year: int


FixSession = TypedDict("FixSession", {"id": Optional[int], "in": str, "out": Optional[str], "hours": Optional[float]})


class FixItem(TypedDict):
    """A day to fix: its flag, hours and target, with the sessions it holds."""

    date: str
    kind: DayFlag
    hours: float
    target: float
    sessions: list[FixSession]


class FixEmployee(TypedDict):
    """An employee with the days they have to fix."""

    id: int
    name: str
    items: list[FixItem]


class FixesPayload(TypedDict):
    """The punches to fix over the whole history, by employee."""

    generated_at: str
    limits: Limits
    employees: list[FixEmployee]


class Rows(NamedTuple):
    """What team.py read from Odoo for a span of weeks, as plain rows."""

    employees: list[Employee]
    since: dict[int, str]
    contracts: attendance_rules.ContractsByEmployee
    blocks: list[TeamBlockRow]
    reasons: Sequence[attendance_rules.Reason]
    records: list[TeamAttendanceRow]
    holidays: list[attendance_rules.HolidayRow]
    leaves: list[attendance_rules.LeaveRow]
    requests: list[ChangeRequest]
    offered: Sequence[attendance_rules.Reason]


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


def period(
    monday: date, weeks: int = 1, start: date | None = None, stop: date | None = None
) -> tuple[date, int, date | None, date | None]:
    """Return a span with its defaults: one week, counted whole."""
    return monday, weeks, start, stop


def fixes_span(first: list[attendance_rules.FirstCheckIn], today: date) -> tuple[date, int]:
    """Return the Monday and the number of weeks that take in every attendance up to this week.

    Args:
        first: The first attendance there is, as a list of one row, or an empty list when there is none.
        today: The day taken as today.
    """
    monday = monday_of(attendance_rules.local(first[0]["check_in"]).date() if first else today)
    return monday, (monday_of(today) - monday).days // 7 + 1


def month_row(month: str, employee: TeamEmployee, today: str) -> Month:
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


def fixes_payload(payload: TeamPayload) -> FixesPayload:
    """Reduce a payload to the flagged days of each employee who has any."""

    def items(e: TeamEmployee) -> list[FixItem]:
        return [
            {
                "date": d["date"],
                "kind": kind,
                "hours": d["hours"],
                "target": d["target"],
                "sessions": [
                    {"id": s["id"], "in": s["in"], "out": s["out"], "hours": s["hours"]} for s in d["sessions"]
                ],
            }
            for d in e["days"]
            for kind in d["flags"]
        ]

    rows: list[FixEmployee] = [{"id": e["id"], "name": e["name"], "items": items(e)} for e in payload["employees"]]
    return {
        "generated_at": payload["generated_at"],
        "limits": payload["limits"],
        "employees": [r for r in rows if r["items"]],
    }


def notices(payload: TeamPayload) -> list[tuple[date, str, str]]:
    """Return a payload's notices, by date and name: the day, the employee and the first kind the day holds."""
    stop = min(payload["stop"], payload["generated_at"][:10])
    return sorted(
        (date.fromisoformat(d["date"]), e["name"], kinds[0])
        for e in payload["employees"]
        for d in e["days"]
        if payload["start"] <= d["date"] < stop
        for kinds in [[kind for kind, holds in NOTICE_KINDS if holds(d)]]
        if kinds
    )


def year_employee(employee: TeamEmployee, months: list[Month]) -> YearEmployee:
    """Return an employee's totals with their months, without the weeks and days."""
    kept = {k: v for k, v in employee.items() if k not in ("days", "weeks")}
    return cast("YearEmployee", kept | {"months": months})


def year_payload(payload: TeamPayload, year: int) -> YearPayload:
    """Turn a year of weeks into one row per month for each employee."""
    today = payload["generated_at"][:10]
    months = [f"{year}-{m:02d}" for m in range(1, 13)]
    return {
        **payload,
        "year": year,
        "employees": [year_employee(e, [month_row(m, e, today) for m in months]) for e in payload["employees"]],
    }


def plain_text(markup: str | Literal[False]) -> str:
    """Return the text of Odoo's HTML, on one line."""
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", markup or "")).split())


def request_rows(rows: list[RequestRow]) -> list[ChangeRequest]:
    """Return approval requests as the payload carries them: owner, local span, status and the reason as text."""
    return [
        {
            "id": r.get("id"),
            "user": r["request_owner_id"][0],
            "can_approve": r.get("user_status") == "pending",
            "from": attendance_rules.local(r["date_start"]).isoformat(),
            "to": attendance_rules.local(r["date_end"]).isoformat() if r["date_end"] else None,
            "status": r["request_status"],
            "reason": plain_text(r["reason"]),
        }
        for r in rows
    ]


def with_discord(rows: list[EmployeeRow], field: str | None) -> list[Employee]:
    """Return employees with their Discord user id: what the field holds as text, or None when it is empty."""
    return [{**r, "discord": (str(r.get(field) or "").strip() or None) if field else None} for r in rows]


def first_mondays(rows: list[FirstCheckInGroup]) -> dict[int, str]:
    """Return the Monday of each employee's first real punch, by id, from the grouped earliest check-ins."""
    return {
        r["employee_id"][0]: monday_of(attendance_rules.local(r["check_in"]).date()).isoformat()
        for r in rows
        if r["employee_id"]
    }


def calendars_of(employees: Sequence[EmployeeRow]) -> dict[int, int | None]:
    """Return each employee's own calendar, by employee id."""
    return {e["id"]: attendance_rules.ref_id(e["resource_calendar_id"]) for e in employees}


def users_of(employees: Sequence[EmployeeRow]) -> dict[int, int | None]:
    """Return each employee's user, by employee id."""
    return {e["id"]: attendance_rules.ref_id(e["user_id"]) for e in employees}


def calendar_ids(employees: Sequence[EmployeeRow], contracts: attendance_rules.ContractsByEmployee) -> list[int]:
    """Return the calendars to read: the employees' own and every one their contracts name."""
    return sorted(
        {cid for cid in calendars_of(employees).values() if cid}
        | attendance_rules.contract_calendars(c for cs in contracts.values() for c in cs)
    )


def user_ids(employees: Sequence[EmployeeRow]) -> list[int]:
    """Return the users the employees have, once each."""
    return sorted({u for u in users_of(employees).values() if u})


def day_request(request: ChangeRequest) -> DayRequest:
    """Return a change request as a day carries it: without the user who owns it."""
    return {
        "id": request["id"],
        "can_approve": request["can_approve"],
        "from": request["from"],
        "to": request["to"],
        "status": request["status"],
        "reason": request["reason"],
    }


def day_row(
    day: date,
    target: float,
    absence: str | None,
    punches: tuple[list[attendance_rules.Session], list[ChangeRequest]],
    today: date,
) -> Day:
    """Return a day's hours, target, sessions, requests and flags: left open, not punched, too long."""
    sessions, requests = punches
    mine = [s for s in sessions if s["in"][:10] == day.isoformat()]
    requests = [r for r in requests if r["from"][:10] == day.isoformat()]
    past = day < today
    hours = sum(attendance_rules.hours_of(s) for s in mine)
    hits: tuple[tuple[DayFlag, bool], ...] = (
        ("open", past and any(not s["out"] for s in mine)),
        ("empty", past and target > 0 and not mine),
        ("long", hours > LONG_DAY),
    )
    return {
        "date": day.isoformat(),
        "hours": hundredths(hours),
        "target": hundredths(target),
        "absence": absence,
        "sessions": mine,
        "flags": [flag for flag, hit in hits if hit],
        "requests": [day_request(r) for r in requests],
    }


def week_row(monday: date, days: list[Day], schedule: bool, today: date) -> Week:
    """Return a week's hours, target and balance, flagged under or over once it is over."""
    hours = hundredths(sum(d["hours"] for d in days))
    suspect = any("long" in d["flags"] for d in days)
    target: float | None = None
    balance: float | None = None
    due: float | None = None
    flags: list[WeekFlag] = []
    if schedule:
        target = hundredths(sum(d["target"] for d in days))
        judged = monday + timedelta(days=7) <= today and not any(d["flags"] for d in days)
        short = hours <= target - UNDER_MARGIN  # pragma: no mutate - hours and target are hundredths, never 1/60 apart
        hits: tuple[tuple[WeekFlag, bool], ...] = (
            ("under", judged and short),
            ("over", judged and hours > target + OVER_MARGIN),
        )
        flags = [flag for flag, hit in hits if hit]
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
    employee: TrackedEmployee,
    schedule_on: Callable[[str], attendance_rules.Schedule | None],
    punches: tuple[list[attendance_rules.Absence], list[attendance_rules.Session], list[ChangeRequest]],
    span: Span,
    today: date,
) -> TeamEmployee:
    """Return an employee's days and weeks over a span, and the sums of the days between its start and stop."""
    absences, sessions, requests = punches
    monday, weeks, start, stop = period(*span)
    full = {a["date"]: a["type"] for a in absences if "hours" not in a}
    partial: dict[str, float] = {}
    for a in absences:
        if "hours" in a:
            partial[a["date"]] = partial.get(a["date"], 0) + a["hours"]
    sessions_on: dict[str, list[attendance_rules.Session]] = {}
    requests_on: dict[str, list[ChangeRequest]] = {}
    for s in sessions:
        sessions_on.setdefault(s["in"][:10], []).append(s)
    for r in requests:
        requests_on.setdefault(r["from"][:10], []).append(r)
    days: list[Day] = []
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
        "flags": [flag for flag in WEEK_FLAGS if any(flag in w["flags"] for w in week_rows)],
        "suspect": any("long" in d["flags"] for d in inside),
        "flagged_days": sum(bool(d["flags"]) for d in inside),
        "pending": sum(r["status"] == "pending" for d in inside for r in d["requests"]),
        "weeks": week_rows,
        "days": days,
    }


def team_payload(span: Span, now: datetime, rows: Rows) -> TeamPayload:
    """Return the payload of a span of weeks from the rows read for it, every employee flagged.

    Args:
        span: The weeks, as month_span gives them or as (monday,).
        now: The moment the payload is made.
        rows: What was read from Odoo for the span.
    """
    monday, weeks, start, stop = period(*span)
    today, end = now.date(), monday + timedelta(weeks=weeks)
    employees: list[TrackedEmployee] = [
        {**e, "since": rows.since.get(e["id"], monday_of(today).isoformat())} for e in rows.employees
    ]
    calendar_of, user_of = calendars_of(employees), users_of(employees)
    ids = calendar_ids(employees, rows.contracts)
    schedules: dict[int | None, attendance_rules.Schedule | None] = {
        cid: attendance_rules.schedule_from([b for b in rows.blocks if b["calendar_id"][0] == cid]) for cid in ids
    }
    reason_by_id = {r["id"]: r for r in rows.reasons}

    def row(employee: TrackedEmployee) -> TeamEmployee:
        calendar = calendar_of[employee["id"]]
        mine_contracts = rows.contracts.get(employee["id"], [])
        own = {calendar} | attendance_rules.contract_calendars(mine_contracts)
        pick = attendance_rules.calendar_on(mine_contracts, calendar)
        absences = attendance_rules.absences_from(
            [h for h in rows.holidays if not h["calendar_id"] or h["calendar_id"][0] in own],
            [leave for leave in rows.leaves if leave["employee_id"][0] == employee["id"]],
        )
        sessions = [
            attendance_rules.session_of(r, reason_by_id)
            for r in rows.records
            if r["employee_id"][0] == employee["id"] and attendance_rules.real_punch(r)
        ]
        mine = [r for r in rows.requests if user_of[employee["id"]] and r["user"] == user_of[employee["id"]]]
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
        "reasons": [{"id": r["id"], "name": r["name"]} for r in rows.offered],
        "employees": [row(e) for e in employees],
    }
