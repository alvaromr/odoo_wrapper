"""The management view's payload: a week, month or year of everyone the session can read, read from Odoo.

The rules (days, weeks, flags, months, what is left to fix) are team_rules.py's, pure over plain rows; this module is
the edge that reads those rows from Odoo, one query per model, not a load per week, and hands them over.

- Who shows up is Odoo's call, never ours. The rows are the employees with at least one attendance the session
  can read from LOOKBACK_WEEKS before the period to its end, so an attendance officer sees everyone and a team lead
  only whoever Odoo's record rules let them read (their own team). /api/team answers 403 when the session reads
  nobody else's attendances (client.sees_others), and the dashboard shows its link only then.
- People who left are left out: an employee archived in Odoo (hr.employee active false) keeps their attendances,
  but shows in no period, not even the weeks they still worked. Only the current staff is reviewed. Showing them
  took their departure_date, which only an HR officer may read (a team lead reading their team's attendances got
  an access error for the whole read, seen in real data).
- Contracts are hr.contract in state open or close, read by data.fetch_contracts; a session that may not read
  them gets the employee's own calendar for every day (team_rules.py says what each day expects).
- Expected hours and absences come from the same places as the personal payload (data.py): the
  resource.calendar, validated hr.leave and public holidays, read for everyone at once, one query per model.
  Nothing is expected before each person's first real punch (first_punches reads it for everyone in one read_group).
- What is left to fix (fetch_fixes, /api/team?fixes) reads the first attendance the session can read, then builds
  the payload over the whole history. Being the heaviest load, the page asks for it on its own, after the table,
  and it is cached like the rest.
- Attendance change requests (approval.request, Odoo's Approvals app) are found by category name
  (REQUEST_CATEGORY, «Modificación de fichaje» in this Odoo), never by id; cancelled ones are left out. Someone's
  own page lists, to whoever may approve them only, every pending request of theirs (requests_to_approve, whatever
  their date): the employee never sees it, as they are not the approver. Approvals is optional, and a session that
  may not read requests simply gets none, like the attendance reasons in client.py.
- The payload's reasons are the ones a punch may be given (client.offered_reasons). Without the module the list is
  empty.
- Each employee carries its Discord user id (discord): the hr.employee field labelled DISCORD_LABEL that someone
  added to this Odoo by hand (client.field_named), read as text whatever its type, None when it is empty or the
  field does not exist. A session outside HR reads employees only through their public profile, which has no field
  added by hand, and Odoo refuses the whole read (seen in real data, a team lead): read_employees then reads them
  again without it, so for that session nobody has one. discord_of reads it for one employee, for discord.py: the
  recipient of that message and its sender.
- Read only: the day dialog's writes are corrections.py. The payload is cached per session and period for
  data.VIEW_TTL, longer than the personal one: what someone else punched moves slowly. The reload_ functions skip
  the cache and replace its entry («Actualizar»).
- Types. Each query's rows are annotated where client.call_kw hands them over (its Any ends there), with the shapes
  team_rules.py declares; the payloads returned are its TeamPayload, YearPayload and FixesPayload.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import TypedDict

from odoo_wrapper import data, data_rules
from odoo_wrapper import team_rules as rules
from odoo_wrapper.client import OdooClient, OdooError, SessionExpired, degrade

LOOKBACK_WEEKS = 12
REQUEST_CATEGORY = "fichaje"
REQUEST_STATES = ("new", "pending", "approved", "refused")
DISCORD_LABEL = "discord"


class EmployeeUser(TypedDict):
    """An hr.employee read for its user only."""

    user_id: data_rules.MaybeMany2one


def team_load(client: OdooClient, span: rules.Span) -> data.Load[rules.TeamPayload]:
    """Return the cache key of a span of weeks, as from month_span or (monday,), and the function that builds it."""
    monday, weeks, start, stop = rules.period(*span)
    key = (client.session_id, monday.isoformat(), weeks, start and start.isoformat())
    return key, lambda: build_team(client, monday, weeks, start, stop)


def fetch_team(client: OdooClient, span: rules.Span) -> rules.TeamPayload:
    """Return the payload of a span of weeks, as from month_span or (monday,), cached for the view."""
    return data.cached(*team_load(client, span), data.VIEW_TTL)


def reload_team(client: OdooClient, span: rules.Span) -> rules.TeamPayload:
    """Return the payload of a span of weeks read again from Odoo, replacing what was cached."""
    return data.rebuilt(*team_load(client, span))


def year_load(client: OdooClient, year: int) -> data.Load[rules.YearPayload]:
    """Return the cache key of a year's payload and the function that builds it."""

    def build() -> rules.YearPayload:
        return rules.year_payload(build_team(client, *rules.year_span(year)), year)

    return (client.session_id, "year", year), build


def fetch_year(client: OdooClient, year: int) -> rules.YearPayload:
    """Return a year's payload, one row per month, cached for the view."""
    return data.cached(*year_load(client, year), data.VIEW_TTL)


def reload_year(client: OdooClient, year: int) -> rules.YearPayload:
    """Return a year's payload read again from Odoo, replacing what was cached."""
    return data.rebuilt(*year_load(client, year))


def build_fixes(client: OdooClient) -> rules.FixesPayload:
    """Read from Odoo every punch to fix since the first one, by employee."""
    first: list[data_rules.FirstCheckIn] = client.call_kw(
        "hr.attendance",
        "search_read",
        [[("employee_id.active", "=", True)]],
        {"fields": ["check_in"], "order": "check_in asc", "limit": 1},
    )
    monday, weeks = rules.fixes_span(first, datetime.now().astimezone().date())
    return rules.fixes_payload(build_team(client, monday, weeks))


def fixes_load(client: OdooClient) -> data.Load[rules.FixesPayload]:
    """Return the cache key of the punches to fix and the function that builds them."""
    return (client.session_id, "fixes"), lambda: build_fixes(client)


def fetch_fixes(client: OdooClient) -> rules.FixesPayload:
    """Return every punch to fix since the first one in Odoo, by employee, cached for the view."""
    return data.cached(*fixes_load(client), data.VIEW_TTL)


def reload_fixes(client: OdooClient) -> rules.FixesPayload:
    """Return every punch to fix read again from Odoo, replacing what was cached."""
    return data.rebuilt(*fixes_load(client))


def fetch_requests(
    client: OdooClient,
    user_ids: list[int],
    within: tuple[date, date] | None = None,
    states: tuple[str, ...] = REQUEST_STATES,
) -> list[rules.ChangeRequest]:
    """Return these users' attendance change requests, in a span when given, or none if they cannot be read."""
    span = (
        [("date_start", ">=", rules.odoo_time(within[0])), ("date_start", "<", rules.odoo_time(within[1]))]
        if within
        else []
    )
    try:
        rows: list[rules.RequestRow] = client.call_kw(
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
    except OdooError as error:
        degrade("Odoo no da las solicitudes de cambio de fichaje: no se muestran", error)
        return []
    return rules.request_rows(rows)


def requests_to_approve(client: OdooClient, employee_id: int) -> list[rules.ChangeRequest]:
    """Return an employee's pending change requests the session's user may approve."""
    owner: list[EmployeeUser] = client.call_kw("hr.employee", "read", [[employee_id], ["user_id"]])
    user = owner[0]["user_id"]
    return [r for r in fetch_requests(client, [user[0]], states=("pending",)) if r["can_approve"]] if user else []


def read_employees(client: OdooClient, ids: list[int], fields: list[str]) -> list[rules.Employee]:
    """Read employees with their Discord field when Odoo has it and lets it be read."""
    discord = client.field_named("hr.employee", DISCORD_LABEL)
    try:
        rows: list[rules.EmployeeRow] = client.call_kw(
            "hr.employee", "read", [ids, fields + ([discord] if discord else [])]
        )
    except SessionExpired:
        raise
    except OdooError as error:
        if not discord:
            raise
        degrade("Odoo no deja leer el campo Discord de los empleados: los avisos no se envían por Discord", error)
        rows = client.call_kw("hr.employee", "read", [ids, fields])
    return rules.with_discord(rows, discord)


def discord_of(client: OdooClient, employee_id: int) -> str | None:
    """Return what an employee's Discord field holds, or None."""
    return read_employees(client, [employee_id], ["name"])[0]["discord"]


def first_punches(client: OdooClient, ids: list[int]) -> dict[int, str]:
    """Return the Monday of each employee's first real punch, by id."""
    rows: list[rules.FirstCheckInGroup] = client.call_kw(
        "hr.attendance",
        "read_group",
        [
            [("employee_id", "in", ids), ("worked_hours", ">=", data_rules.MIN_SESSION)],
            ["employee_id", "check_in:min"],
            ["employee_id"],
        ],
        {"lazy": True},
    )
    return rules.first_mondays(rows)


def build_team(
    client: OdooClient, monday: date, weeks: int = 1, start: date | None = None, stop: date | None = None
) -> rules.TeamPayload:
    """Read from Odoo, one query per model, every employee with attendances in the weeks, and their rows."""
    now = datetime.now().astimezone()
    end = monday + timedelta(weeks=weeks)
    roster: list[rules.EmployeeGroup] = client.call_kw(
        "hr.attendance",
        "read_group",
        [
            [
                ("check_in", ">=", rules.odoo_time(monday - timedelta(weeks=LOOKBACK_WEEKS))),
                ("check_in", "<", rules.odoo_time(end)),
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
    contracts = data.fetch_contracts(client, ids, monday, end)
    calendars = rules.calendar_ids(employees, contracts)
    blocks: list[rules.TeamBlockRow] = client.call_kw(
        "resource.calendar.attendance",
        "search_read",
        [[("calendar_id", "in", calendars)]],
        {"fields": ["calendar_id", "dayofweek", "hour_from", "hour_to", "day_period"]},
    )
    reasons = client.attendance_reasons()
    records: list[rules.TeamAttendanceRow] = client.call_kw(
        "hr.attendance",
        "search_read",
        [
            [
                ("employee_id", "in", ids),
                ("check_in", ">=", rules.odoo_time(monday)),
                ("check_in", "<", rules.odoo_time(end)),
            ]
        ],
        {
            "fields": ["employee_id", "check_in", "check_out", "worked_hours"]
            + (["attendance_reason_ids"] if reasons else []),
            "order": "check_in asc",
        },
    )
    holidays = data.holiday_rows(client, monday.isoformat(), end.isoformat(), calendars)
    leaves = data.leave_rows(client, ids, monday.isoformat(), end.isoformat())
    requests = fetch_requests(client, rules.user_ids(employees), (monday, end))
    rows = rules.Rows(
        employees, since, contracts, blocks, reasons, records, holidays, leaves, requests, client.offered_reasons()
    )
    return rules.team_payload((monday, weeks, start, stop), now, rows)
