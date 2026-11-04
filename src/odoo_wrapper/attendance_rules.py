"""The rules of the personal payload, over plain rows: hours, schedule, absences, sessions and what a punch does.

Nothing here reads Odoo, the disk, the network or the clock: rows go in, the payload comes out, and `now` is an
argument. attendance.py reads the rows and hands them over, team_rules.py applies the same rules to many employees
at once, and tests/test_project.py checks that this module imports nothing that could do I/O.

- Weeks are counted between calendar dates, not local datetimes: across a daylight-saving change the span is an
  hour short and the oldest week was dropped. The history covers at least MIN_WEEKS, from the Monday of the
  first real punch (history_span).
- Expected hours follow the contract in force each day (calendar_on, contract_hours): the payload's schedule is
  the employee's current calendar, and contract_hours lists only the days whose contract asks for something
  else ({date: hours}: 0 before the hire date or between contracts, 5 on a 25 h contract), so the page changes
  nothing for someone whose calendar never changed.
- Nothing is expected either before «since», the Monday of the week of the first punch lasting at least
  MIN_SESSION (a minute), or this week's for someone with none: a person starts clocking in this Odoo
  some day, and a test punch of a few seconds months earlier used to turn every day in between into a
  missed one (months of them for one person). Punches under a minute are taps and tests; the ones from
  one to five minutes are real short breaks, so the threshold stays at a minute. The history starts
  there too, at least MIN_WEEKS back; team_rules.py applies the same rule.
- A closed punch shorter than MIN_SESSION is dropped as it is read (real_punch), here and in team_rules.py: it
  adds no hours and marks no day as punched. An open one is kept: it is still running.
- LONG_HOURS is the one threshold for «too long», here and in team_rules.py: a day whose total passes it is a
  punch error in both views, however many sessions it took. The hour of a punch is never judged: a rule for
  sessions outside 6:30 to midnight, or ending on another day, flagged too many real ones, and a forgotten
  check-out is long anyway. Punch errors to fix are looked for over the whole history, with no time limit.
- Expected hours come from Odoo: resource.calendar.attendance gives the blocks per weekday, their sum is the
  day's target, a gap between blocks (or an explicit day_period "lunch") marks a lunch day (schedule_from). The
  page's constants are only a fallback for a calendar that answers nothing.
- Absences are hr.leave records in state "validate" plus public holidays (resource.calendar.leaves, global
  or of the employee's calendar or of any calendar its contracts had: a regional holiday lives on the
  calendar in force that day, and asking only for the current one left each of them before a change of
  contract as a missed day). A leave shorter than a day (number_of_days < 1) keeps its hours and span so
  the page can subtract just those hours; they used to be skipped, which left a 2 h 30 m medical leave
  counted as hours missing.
- Punch actions validate the real state (open attendance, its reason) and say why not when it is invalid, which
  the server answers as 409; a break is a check-out plus a check-in with the Descanso reason, lunch is a plain
  check-out that also stamps the shared state (punch_state). Without the Descanso reason, break and resume are
  refused and the page hides them. A step only plans the punches, in order, and attendance.py sends them.
- The only ambient input is the machine's time zone, which local reads to show Odoo's UTC stamps as the user's.
- Types. Each Odoo model's rows are the TypedDicts below, holding exactly the fields attendance.py and team.py request
  for the rules; the payload built from them is the TypedDicts too. Odoo's empty value is False whatever the
  field's type: a many2one is [id, name] or False (Many2one, a pair here, though JSON gives a list that is only ever
  indexed; ref_id reads one) and a date or text is the string or False. A field that is unguarded in the code is
  one Odoo always fills. client.py cannot be imported from here, so the shapes of a client row that the rules read
  (Reason) are restated as the fields they need, and a client row fits them; the open attendance, which the
  steps only test for being there, is any mapping (OpenPunch). Keys that are Python keywords are written with the
  functional TypedDict syntax.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from datetime import date, datetime, timedelta, timezone
from typing import Literal, Optional, TypedDict, Union

Many2one = tuple[int, str]
MaybeMany2one = Union[Many2one, Literal[False]]

MIN_WEEKS = 12
MIN_SESSION = 1 / 60
LONG_HOURS = 12
SATURDAY = 5


class Reason(TypedDict):
    """An hr.attendance.reason as the rules read it: its id, its name and whether it is the break."""

    id: int
    name: str
    is_rest: bool


class _Attendance(TypedDict):
    id: int
    check_in: str
    check_out: str | Literal[False]
    worked_hours: float


class AttendanceRow(_Attendance, total=False):
    """An hr.attendance; the reasons it was checked in with are read only where the module is installed."""

    attendance_reason_ids: list[int]


class FirstCheckIn(TypedDict):
    """The first hr.attendance there is, of which only the check-in is read."""

    check_in: str


class BlockRow(TypedDict):
    """A resource.calendar.attendance: a block of a calendar's weekday, in hours since midnight."""

    dayofweek: str
    hour_from: float
    hour_to: float
    day_period: str


class HolidayRow(TypedDict):
    """A public holiday, a resource.calendar.leaves with no resource: global when it has no calendar."""

    name: str
    date_from: str
    date_to: str
    calendar_id: MaybeMany2one


class LeaveRow(TypedDict):
    """An approved hr.leave."""

    employee_id: Many2one
    request_date_from: str
    request_date_to: str
    holiday_status_id: MaybeMany2one
    number_of_days: float
    number_of_hours: float
    date_from: str
    date_to: str


class ContractRow(TypedDict):
    """An hr.contract in force at some point of the span: its employee, dates and calendar."""

    employee_id: Many2one
    date_start: str
    date_end: str | Literal[False]
    resource_calendar_id: MaybeMany2one


ContractsByEmployee = dict[Optional[int], list[ContractRow]]


class Schedule(TypedDict):
    """A calendar's expected hours and lunch start (None where it has none) for each weekday, Monday first."""

    hours: list[float]
    lunch_from: list[float | None]


Session = TypedDict(
    "Session",
    {
        "id": Optional[int],
        "in": str,
        "out": Optional[str],
        "hours": Optional[float],
        "rest": bool,
        "reason": Optional[str],
        "reason_id": Optional[int],
    },
)


class _DatedAbsence(TypedDict):
    date: str
    type: str


_AbsenceStart = TypedDict("_AbsenceStart", {"from": str}, total=False)


class Absence(_DatedAbsence, _AbsenceStart, total=False):
    """A weekday off: the whole day, or only some of its hours (then also hours, from and to)."""

    hours: float
    to: str


class PersonalHead(TypedDict):
    """The personal payload's first keys: who it is and what the session may do."""

    employee: str | None
    employee_id: int | None
    breaks: bool
    team: bool


class PersonalPayload(PersonalHead):
    """The personal page's payload."""

    generated_at: str
    weeks: int
    since: str
    sessions: list[Session]
    absences: list[Absence]
    schedule: Schedule | None
    long_hours: int
    contract_hours: dict[str, float]


class PunchState(TypedDict, total=False):
    """What a punch writes to the shared state."""

    lunch: str | None
    lunch_done: bool
    punched_at: str


OpenPunch = Optional[Mapping[str, object]]
Plan = tuple[str, list[Optional[int]]]
Step = Callable[[OpenPunch, Optional[int], Optional[Reason], bool], Plan]


def local(ts: str) -> datetime:
    """Turn one of Odoo's UTC stamps into a time in the machine's zone."""
    return datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).astimezone()


def week_monday(dt: datetime) -> datetime:
    """Return the midnight that starts a time's week."""
    return (dt - timedelta(days=dt.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)


def ref_id(ref: MaybeMany2one) -> int | None:
    """Return the id of a many2one value, or None when it is empty."""
    return ref[0] if ref else None


def hours_of(session: Session) -> float:
    """Return a session's hours, none while it is open."""
    return session["hours"] or 0


def schedule_from(blocks: Iterable[BlockRow]) -> Schedule | None:
    """Return a calendar's hours and lunch start for each weekday, from its attendance blocks."""
    hours = [0.0] * 7
    lunch_from: list[float | None] = [None] * 7
    spans: list[list[tuple[float, float]]] = [[] for _ in range(7)]
    for block in blocks:
        day = int(block["dayofweek"])
        start, end = float(block["hour_from"]), float(block["hour_to"])
        if day not in range(7) or end <= start:
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


def absences_from(holidays: Iterable[HolidayRow], leaves: Iterable[LeaveRow]) -> list[Absence]:
    """Return the weekdays off, whole or by hours, from holidays and leaves; a holiday wins over a leave."""
    absences: dict[str, str] = {}
    for h in holidays:
        d0, d1 = local(h["date_from"]).date(), local(h["date_to"]).date()
        for i in range((d1 - d0).days + 1):
            d = d0 + timedelta(days=i)
            if d.weekday() < SATURDAY:
                absences[d.isoformat()] = h["name"]
    partial: list[Absence] = []
    for leave in leaves:
        d0 = date.fromisoformat(leave["request_date_from"])
        d1 = date.fromisoformat(leave["request_date_to"])
        days = [d0 + timedelta(days=i) for i in range((d1 - d0).days + 1)]
        days = [d for d in days if d.weekday() < SATURDAY and d.isoformat() not in absences]
        if not days:
            continue
        name = leave["holiday_status_id"][1] if leave["holiday_status_id"] else "Ausencia"
        if leave["number_of_days"] < 1:
            partial.append(
                {
                    "date": days[0].isoformat(),
                    "type": name,
                    "hours": leave["number_of_hours"],
                    "from": local(leave["date_from"]).isoformat(),
                    "to": local(leave["date_to"]).isoformat(),
                }
            )
            continue
        for d in days:
            absences[d.isoformat()] = name
    whole: list[Absence] = [{"date": k, "type": v} for k, v in sorted(absences.items())]
    return whole + partial


def real_punch(record: AttendanceRow) -> bool:
    """Tell whether an attendance counts: open, or at least MIN_SESSION long."""
    return not record["check_out"] or record["worked_hours"] >= MIN_SESSION


def session_of(record: AttendanceRow, reason_by_id: Mapping[int, Reason]) -> Session:
    """Return an attendance as the page's session: local times, hours and whether it is a break."""
    reason = next((reason_by_id[i] for i in record.get("attendance_reason_ids", []) if i in reason_by_id), None)
    return {
        "id": record.get("id"),
        "in": local(record["check_in"]).isoformat(),
        "out": local(record["check_out"]).isoformat() if record["check_out"] else None,
        "hours": record["worked_hours"] if record["check_out"] else None,
        "rest": bool(reason and reason["is_rest"]),
        "reason": reason["name"] if reason else None,
        "reason_id": reason["id"] if reason else None,
    }


def calendar_on(contracts: Sequence[ContractRow], fallback: int | None) -> Callable[[str], int | None]:
    """Return a function that gives the calendar in force on a day: its contract's, else the fallback."""
    if not contracts:
        return lambda _iso: fallback

    def pick(iso: str) -> int | None:
        c = next((c for c in contracts if c["date_start"] <= iso and (not c["date_end"] or iso <= c["date_end"])), None)
        return ref_id(c["resource_calendar_id"]) if c else None

    return pick


def contract_calendars(contracts: Iterable[ContractRow]) -> set[int]:
    """Return the calendars the contracts name."""
    return {c["resource_calendar_id"][0] for c in contracts if c["resource_calendar_id"]}


def contract_hours(
    schedules: Mapping[int | None, Schedule | None],
    calendar_id: int | None,
    contracts: Sequence[ContractRow],
    monday0: date,
    end: date,
) -> dict[str, float]:
    """Return the days whose expected hours a contract's calendar sets apart from the employee's own.

    Args:
        schedules: Every calendar the contracts name and the employee's own, by id, each as schedule_from gives it.
        calendar_id: The employee's own calendar.
        contracts: The employee's contracts.
        monday0: The first day to look at.
        end: The day after the last one.
    """
    pick = calendar_on(contracts, calendar_id)
    own = schedules.get(calendar_id)

    def hours_on(day: date, chosen: Schedule | None) -> float:
        return chosen["hours"][day.weekday()] if chosen else 0

    overrides: dict[str, float] = {}
    for i in range((end - monday0).days):
        day = monday0 + timedelta(days=i)
        hours = hours_on(day, schedules.get(pick(day.isoformat())))
        if hours != hours_on(day, own):
            overrides[day.isoformat()] = hours
    return overrides


def history_span(records: Iterable[AttendanceRow], now: datetime) -> tuple[datetime, datetime, datetime, date]:
    """Return the Monday of this week, «since», the Monday the history starts at, and the day after this week."""
    cur_monday = week_monday(now)
    real = [r for r in records if r["worked_hours"] >= MIN_SESSION]
    since = week_monday(local(real[0]["check_in"])) if real else cur_monday
    monday0 = min(since, cur_monday - timedelta(weeks=MIN_WEEKS - 1))
    return cur_monday, since, monday0, (cur_monday + timedelta(weeks=1)).date()


def punched_after(records: Iterable[AttendanceRow], stamp: str) -> bool:
    """Tell whether any attendance checked in after a stamp, an ISO time with its zone."""
    return any(local(r["check_in"]) > datetime.fromisoformat(stamp) for r in records)


def personal_payload(
    head: PersonalHead,
    now: datetime,
    span: tuple[datetime, datetime, datetime, date],
    rows: tuple[list[AttendanceRow], Mapping[int, Reason], list[Absence], Schedule | None, dict[str, float]],
) -> PersonalPayload:
    """Return the personal page's payload from what was read from Odoo.

    Args:
        head: The payload's first keys, which say who it is and what the session may do.
        now: The moment the payload is made.
        span: What history_span gave for the attendances.
        rows: The attendances, the attendance reasons by id, the absences, the schedule and the contract hours.
    """
    records, reason_by_id, absences, schedule, overrides = rows
    cur_monday, since, monday0, _ = span
    return {
        **head,
        "generated_at": now.isoformat(),
        "weeks": (cur_monday.date() - monday0.date()).days // 7 + 1,
        "since": since.date().isoformat(),
        "sessions": [session_of(r, reason_by_id) for r in records if real_punch(r)],
        "absences": absences,
        "schedule": schedule,
        "long_hours": LONG_HOURS,
        "contract_hours": overrides,
    }


def punch_in(open_att: OpenPunch, normal_id: int | None, _rest: Reason | None, _on_rest: bool) -> Plan:
    """Plan a check-in as normal work, or say why not."""
    if open_att:
        return "Ya hay un fichaje abierto", []
    return "", [normal_id]


def punch_break(open_att: OpenPunch, _normal_id: int | None, rest: Reason | None, on_rest: bool) -> Plan:
    """Plan a check-out and a check-in as a break, or say why not."""
    if not rest:
        return "Este Odoo no tiene el motivo Descanso", []
    if not open_att:
        return "No hay fichaje abierto", []
    if on_rest:
        return "Ya estás en descanso", []
    return "", [None, rest["id"]]


def punch_resume(open_att: OpenPunch, normal_id: int | None, _rest: Reason | None, on_rest: bool) -> Plan:
    """Plan the end of a break: a check-out and a check-in as normal work, or say why not."""
    if not open_att or not on_rest:
        return "No hay un descanso abierto", []
    return "", [None, normal_id]


def punch_out(open_att: OpenPunch, _normal_id: int | None, _rest: Reason | None, _on_rest: bool) -> Plan:
    """Plan a check-out, or say why not."""
    if not open_att:
        return "No hay fichaje abierto", []
    return "", [None]


PUNCHES: dict[str, Step] = {
    "checkin": punch_in,
    "checkout": punch_out,
    "break": punch_break,
    "resume": punch_resume,
    "lunch": punch_out,
}


def punch_step(action: object) -> Step | None:
    """Return the step a page action asks for, or None when it is not one."""
    return PUNCHES.get(action) if isinstance(action, str) else None


def punch_state(action: object, stamp: str) -> PunchState:
    """Return what a punch writes to the shared state: lunch also stamps that it was taken.

    Args:
        action: The page's action, which punch_step has already accepted.
        stamp: The moment of the punch, as ISO.
    """
    if action == "lunch":
        return {"lunch": stamp, "lunch_done": True, "punched_at": stamp}
    return {"lunch": None, "punched_at": stamp}
