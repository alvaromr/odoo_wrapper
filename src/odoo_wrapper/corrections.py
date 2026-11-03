"""The only writes to Odoo besides punching: the day dialog's corrections, for a session that may make them.

The rules (what a body asks for, when a correction warns) are corrections_rules.py's, pure over plain values; this
module is the edge that sends what they decide.

- save_attendance changes a punch's check-in and check-out, or creates one, delete_attendance removes one for
  good (unlink: Odoo keeps nothing of it, so it cannot be undone), and approve_request approves a change request
  as the session's user (action_approve, which Odoo allows only to a pending approver, hence team_rules.py's
  can_approve). Odoo validates them all (overlaps, rights) and its refusal comes back as a 409 with its words.
  Every write drops the cached payloads.
- Shortening a punch that ended on a later day may lose that day's check-in: lost_entry asks Odoo whether any
  attendance of theirs starts in the span corrections_rules.lost_window gives, and answers the old check-out,
  local, when none does.
- A request's body and a record id are Any here for the reason corrections_rules.py gives: int() and
  fromisoformat() are what validate them. Replies that only acknowledge are a Mapping[str, object].
- server.py lets a session here only if it reads other people's attendances and, for a punch, Odoo gives it
  write, create and unlink on hr.attendance (client.edits_punches); Odoo checks again on every call.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal, TypedDict

from odoo_wrapper import corrections_rules as rules
from odoo_wrapper import data, data_rules
from odoo_wrapper.client import OdooClient, OdooError, SessionExpired


class AttendanceEnd(TypedDict):
    """An hr.attendance as save_attendance reads it before changing it: whose it is and when it ended."""

    employee_id: data_rules.Many2one
    check_out: str | Literal[False]


def lost_entry(client: OdooClient, employee_id: int, old_out: str | None, new_out: str) -> str | None:
    """Return the old check-out, local, when shortening a punch past its day may lose that day's check-in, else None."""
    window = rules.lost_window(old_out, new_out)
    if not window:
        return None
    later = client.call_kw(
        "hr.attendance",
        "search_count",
        [[("employee_id", "=", employee_id), ("check_in", ">=", window[0]), ("check_in", "<=", window[1])]],
    )
    return None if later else data_rules.local(window[0]).isoformat()


def save_attendance(client: OdooClient, body: Mapping[str, Any]) -> tuple[int, Mapping[str, object]]:
    """Correct an attendance, or create one when the body has no id, and answer (status, payload)."""
    edit = rules.attendance_edit(body)
    if isinstance(edit, str):
        return 400, {"error": edit}
    try:
        if edit.record:
            ends: list[AttendanceEnd] = client.call_kw(
                "hr.attendance", "read", [[edit.record], ["employee_id", "check_out"]]
            )
            before = ends[0]
            client.call_kw("hr.attendance", "write", [[edit.record], edit.values])
            lost = lost_entry(client, before["employee_id"][0], before["check_out"] or None, edit.values["check_out"])
        else:
            client.call_kw("hr.attendance", "create", [{"employee_id": edit.employee, **edit.values}])
            lost = None
    except SessionExpired:
        raise
    except OdooError as error:
        return 409, {"error": str(error)}
    data.drop_data_cache()
    return 200, {"ok": True, "lost_entry": lost}


def run_on(
    client: OdooClient, model: str, method: str, record_id: Any, invalid: str
) -> tuple[int, Mapping[str, object]]:
    """Call a method of Odoo on one record by its id and answer (status, payload)."""
    try:
        record = int(record_id)
    except (TypeError, ValueError):
        return 400, {"error": f"{invalid}: {record_id}"}
    try:
        client.call_kw(model, method, [[record]])
    except SessionExpired:
        raise
    except OdooError as error:
        return 409, {"error": str(error)}
    data.drop_data_cache()
    return 200, {"ok": True}


def approve_request(client: OdooClient, request_id: Any) -> tuple[int, Mapping[str, object]]:
    """Approve a change request as the session's user."""
    return run_on(client, "approval.request", "action_approve", request_id, "Solicitud no válida")


def delete_attendance(client: OdooClient, record_id: Any) -> tuple[int, Mapping[str, object]]:
    """Delete an attendance for good."""
    return run_on(client, "hr.attendance", "unlink", record_id, "Fichaje no válido")
