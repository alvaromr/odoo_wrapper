"""The dashboard payload: attendance sessions, expected schedule and absences, read from Odoo and cached.

The rules (hours, schedule, absences, what a punch does) are data_rules.py's, pure over plain rows; this module is
the edge that reads those rows from Odoo, hands them over and sends the punches.

- build_data loads the employee's full attendance history (from the first hr.attendance, at least MIN_WEEKS) in six
  calls; the page trims what it shows. The payload is cached per Odoo session for DATA_TTL seconds (a load costs
  ~1.8 s against Odoo, ~2 ms from the cache), so two people logged into the same dashboard never see each other's
  data; every entry is dropped on any punch, and a logout drops its session's; reload_data skips the cache
  («Actualizar») and replaces the entry, leaving the old one if the load fails. cached() is that cache for any
  payload, keyed by a tuple that starts with the session, and rebuilt() is its reload; team.py keys its own per
  session and period. What the viewer reads about other people (the management view, someone else's week) keeps
  VIEW_TTL, five minutes: moving between those pages used to reload from Odoo every time, and «Actualizar» still
  forces a fresh load. The payload's team flag says whether the session reads other people's attendances, so the
  page links the management view.
- build_data(client, employee) reads someone else's week instead, for the management view's links: the
  same payload, loaded by employee id, and it never touches the shared state, which is the viewer's own.
- The absence and contract readers take no session state and return plain rows, so team.py reads the same
  absences, contracts and schedules for many employees at once from one query per model.
  The shared state is not part of the payload: it changes between loads, so the server adds it fresh to every
  response. Reading it here only clears the lunch stamp once a later punch exists.
- Expected hours come from Odoo: resource.calendar.attendance gives the blocks per weekday (fetch_schedule).
- Absences are hr.leave records in state "validate" plus public holidays (resource.calendar.leaves, global
  or of the employee's calendar or of any calendar its contracts had, as in team.py), read by holiday_rows and
  leave_rows.
- Attendance reasons are optional (see client.py). Without them the payload says breaks: false and
  attendance_reason_ids is not even requested — the field only exists with the module installed.
- A punch is sent as data_rules.py plans it: one check-out or check-in at a time, in order, then the shared state
  is stamped and every cached payload dropped.
- The cache holds payloads of several kinds (the personal one, the team's, a year's, the fixes), so it stores them as
  object and returns each as the type its builder made: a key says which kind it holds (the session, then the
  employee, the period, "year" or "fixes"), and cached() and rebuilt() are only called with a key and builder of one
  kind. Each read of Odoo declares the rows it asked for (data_rules.py has them), and a reply that is only
  acknowledged is a Mapping[str, object].
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from datetime import date, datetime
from typing import TypeVar, cast

from odoo_wrapper import data_rules as rules
from odoo_wrapper import state
from odoo_wrapper.client import OdooClient, OdooError, SessionExpired, degrade

Payload = TypeVar("Payload")
Key = tuple[object, ...]
Load = tuple[Key, Callable[[], Payload]]

DATA_TTL = 45
VIEW_TTL = 300
_data_lock = threading.Lock()
_data_cache: dict[Key, tuple[float, object]] = {}


def fetch_schedule(client: OdooClient, calendar_id: int | None) -> rules.Schedule | None:
    """Return a calendar's schedule, or None without a calendar."""
    if not calendar_id:
        return None
    blocks: list[rules.BlockRow] = client.call_kw(
        "resource.calendar.attendance",
        "search_read",
        [[("calendar_id", "=", calendar_id)]],
        {"fields": ["dayofweek", "hour_from", "hour_to", "day_period"]},
    )
    return rules.schedule_from(blocks)


def holiday_rows(
    client: OdooClient, since: str, until: str | None, calendar_ids: Iterable[int | None]
) -> list[rules.HolidayRow]:
    """Return the public holidays from since to until, of these calendars or of none in particular."""
    rows: list[rules.HolidayRow] = client.call_kw(
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
    return rows


def leave_rows(
    client: OdooClient, employee_ids: Sequence[int | None], since: str, until: str | None
) -> list[rules.LeaveRow]:
    """Return the approved leaves of these employees from since to until."""
    rows: list[rules.LeaveRow] = client.call_kw(
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
        {
            "fields": [
                "employee_id",
                "request_date_from",
                "request_date_to",
                "holiday_status_id",
                "number_of_days",
                "number_of_hours",
                "date_from",
                "date_to",
            ]
        },
    )
    return rows


def fetch_absences(client: OdooClient, since: str, calendar_ids: Iterable[int | None]) -> list[rules.Absence]:
    """Return the employee's absences since a day."""
    holidays = holiday_rows(client, since, None, calendar_ids)
    return rules.absences_from(holidays, leave_rows(client, [client.employee_id], since, None))


def cached(key: Key, build: Callable[[], Payload], ttl: float = DATA_TTL) -> Payload:
    """Return what build made for a key within ttl seconds, or build it again."""
    with _data_lock:
        hit = _data_cache.get(key)
        if hit and time.monotonic() - hit[0] < ttl:
            return cast("Payload", hit[1])
    return rebuilt(key, build)


def rebuilt(key: Key, build: Callable[[], Payload]) -> Payload:
    """Build a key's payload again whatever the cache holds, keep it and return it."""
    payload = build()
    with _data_lock:
        _data_cache[key] = (time.monotonic(), payload)
    return payload


def data_load(client: OdooClient, employee: int | None) -> Load[rules.PersonalPayload]:
    """Return the cache key of the personal page's payload and the function that builds it."""
    return (client.session_id, employee), lambda: build_data(client, employee)


def fetch_data(client: OdooClient, employee: int | None = None) -> rules.PersonalPayload:
    """Return the personal page's payload, the session's own or an employee's, cached."""
    key, build = data_load(client, employee)
    return cached(key, build, VIEW_TTL if employee else DATA_TTL)


def reload_data(client: OdooClient, employee: int | None = None) -> rules.PersonalPayload:
    """Return the personal page's payload read again from Odoo, replacing what was cached."""
    return rebuilt(*data_load(client, employee))


def drop_data_cache(session_id: str | None = None) -> None:
    """Forget the cached payloads of a session, or of every session."""
    with _data_lock:
        for key in [key for key in _data_cache if session_id in (None, key[0])]:
            del _data_cache[key]


def fetch_contracts(
    client: OdooClient, ids: Sequence[int | None], monday: date, end: date
) -> rules.ContractsByEmployee:
    """Return the contracts in force between monday and end, by employee, or none if they cannot be read."""
    try:
        rows: list[rules.ContractRow] = client.call_kw(
            "hr.contract",
            "search_read",
            [
                [
                    ("employee_id", "in", ids),
                    ("state", "in", ["open", "close"]),
                    ("date_start", "<", end.isoformat()),
                    "|",
                    ("date_end", "=", False),
                    ("date_end", ">=", monday.isoformat()),
                ]
            ],
            {
                "fields": ["employee_id", "date_start", "date_end", "resource_calendar_id"],
                "context": {"active_test": False},
            },
        )
    except SessionExpired:
        raise
    except OdooError as error:
        degrade("Odoo no da los contratos: las horas previstas siguen el horario actual de cada empleado", error)
        return {}
    contracts: rules.ContractsByEmployee = {}
    for c in rows:
        contracts.setdefault(c["employee_id"][0], []).append(c)
    return contracts


def build_data(client: OdooClient, employee: int | None = None) -> rules.PersonalPayload:
    """Read from Odoo everything the personal page shows: sessions, schedule, absences and contracts."""
    if employee:
        client.load_other(employee)
    else:
        client.load_employee()
    now = datetime.now().astimezone()
    reason_by_id: dict[int, rules.Reason] = {r["id"]: r for r in client.attendance_reasons()}
    records: list[rules.AttendanceRow] = client.call_kw(
        "hr.attendance",
        "search_read",
        [[("employee_id", "=", client.employee_id)]],
        {
            "fields": ["check_in", "check_out", "worked_hours"] + (["attendance_reason_ids"] if reason_by_id else []),
            "order": "check_in asc",
        },
    )
    span = rules.history_span(records, now)
    monday0, end = span[2].date(), span[3]
    contracts = fetch_contracts(client, [client.employee_id], monday0, end).get(client.employee_id, [])
    calendars = sorted(rules.contract_calendars(contracts) | ({client.calendar_id} if client.calendar_id else set()))

    schedule = fetch_schedule(client, client.calendar_id)
    lunch = None if employee else state.read_state(client.uid)["lunch"]
    if lunch and rules.punched_after(records, lunch):
        state.write_state(client.uid, lunch=None)

    head: rules.PersonalHead = {
        "employee": client.employee_name,
        "employee_id": client.employee_id,
        "breaks": client.sign_in_reasons()[1] is not None,
        "team": client.sees_others(),
    }
    absences = fetch_absences(client, monday0.isoformat(), calendars)
    schedules: dict[int | None, rules.Schedule | None] = {
        cid: fetch_schedule(client, cid) for cid in sorted(rules.contract_calendars(contracts) - {client.calendar_id})
    }
    schedules[client.calendar_id] = schedule
    overrides = rules.contract_hours(schedules, client.calendar_id, contracts, monday0, end)
    return rules.personal_payload(head, now, span, (records, reason_by_id, absences, schedule, overrides))


def punch(client: OdooClient, action: object) -> tuple[int, Mapping[str, object]]:
    """Clock as the page's button asks, stamp the shared state and answer (status, payload)."""
    step = rules.punch_step(action)
    if step is None:
        return 400, {"error": f"Acción desconocida: {action}"}
    open_att = client.open_attendance()
    normal, rest = client.sign_in_reasons()
    refused, reasons = step(open_att, normal["id"] if normal else None, rest, client.open_is_rest(open_att, rest))
    if refused:
        return 409, {"error": refused}
    for reason in reasons:
        client.punch(reason)
    state.write_state(client.uid, **rules.punch_state(action, datetime.now().astimezone().isoformat()))
    drop_data_cache()
    return 200, {"ok": True}
