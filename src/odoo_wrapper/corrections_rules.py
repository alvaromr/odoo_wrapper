"""The rules of the day dialog's corrections, over plain values: what a body asks for and when a correction warns.

Nothing here reads Odoo, the disk, the network or the clock; corrections.py sends what these rules decide, and
tests/test_project.py checks that this module imports nothing that could do I/O.

- A punch's reason (Normal, Descanso…) is changed only when the body names one: it then replaces whatever
  reasons the punch had (REPLACE, the many2many command), as the page shows one reason per punch and every
  punch in this Odoo carries one or none. Without it the field is not sent at all: it only exists with the
  module installed (client.py), and which reasons there are to choose is the payload's business (team_rules.py).
- Shortening a punch that ended on a later day may lose that day's check-in: someone who forgot to check
  out and did not punch again right away left their next morning's check-in only as this punch's
  check-out. When no attendance of theirs starts within LOST_ENTRY_MINUTES of the old check-out (lost_window
  says where to look), the answer carries it as lost_entry and the page says so; nothing is created on its own
  (about one long punch in five was like that).
- A body is parsed here, so it is the one place where the values of a request stay Any: attendance_edit turns each
  into a number or a stamp with int() and fromisoformat(), whose own TypeError and ValueError are the validation
  (a string, a number or a bool all convert; anything else is refused). What it returns is typed.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any, NamedTuple, TypedDict

from odoo_wrapper import attendance_rules

LOST_ENTRY_MINUTES = 10
REPLACE = 6
STAMP = "%Y-%m-%d %H:%M:%S"


class _Times(TypedDict):
    check_in: str
    check_out: str


class AttendanceValues(_Times, total=False):
    """The values written to an hr.attendance: its times, and its reasons only when the body names one."""

    attendance_reason_ids: list[list[object]]


class AttendanceEdit(NamedTuple):
    """What a body asks of one attendance: the record to change (0 to create), the person and the values to write."""

    record: int
    employee: int
    values: AttendanceValues


def odoo_stamp(iso: str) -> str:
    """Turn an ISO time with its zone, as the page sends it, into Odoo's UTC stamp."""
    aware = iso.replace("Z", "+00:00")  # pragma: no mutate - mutmut runs on 3.12, which reads Z itself; 3.9 needs this
    return datetime.fromisoformat(aware).astimezone(timezone.utc).strftime(STAMP)


def attendance_edit(body: Mapping[str, Any]) -> AttendanceEdit | str:
    """Read a body that corrects an attendance, or creates one when it has no id, and return what it asks or why not."""
    try:
        check_in, check_out = odoo_stamp(body["check_in"]), odoo_stamp(body["check_out"])
        record, employee = int(body.get("id") or 0), int(body.get("employee") or 0)
        reason = int(body.get("reason") or 0)
    except (KeyError, TypeError, ValueError):
        return "Entrada, salida o motivo no válidos"
    if check_out <= check_in:
        return "La salida tiene que ser posterior a la entrada"
    if not record and not employee:
        return "Falta el fichaje o la persona"
    values: AttendanceValues = {"check_in": check_in, "check_out": check_out}
    if reason:
        values["attendance_reason_ids"] = [[REPLACE, 0, [reason]]]
    return AttendanceEdit(record, employee, values)


def lost_window(old_out: str | None, new_out: str) -> tuple[str, str] | None:
    """Return the span after the old check-out, as Odoo's stamps, where a check-in shows nothing was lost.

    Args:
        old_out: The check-out the punch had, as Odoo's stamp, or None when it was open.
        new_out: The check-out it is given, as Odoo's stamp.

    Returns:
        The old check-out and the end of the span, or None when shortening the punch cannot lose a check-in.
    """
    if not old_out or attendance_rules.local(old_out).date() <= attendance_rules.local(new_out).date():
        return None
    out = datetime.strptime(old_out, STAMP).replace(tzinfo=timezone.utc)  # pragma: no mutate - strftime drops the zone
    return old_out, (out + timedelta(minutes=LOST_ENTRY_MINUTES)).strftime(STAMP)
