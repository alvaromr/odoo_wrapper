"""The only writes to Odoo besides punching: the day dialog's corrections, for a session that may make them.

- save_attendance changes a punch's check-in and check-out, or creates one, and approve_request approves a
  change request as the session's user (action_approve, which Odoo allows only to a pending approver, hence
  team.py's can_approve). Odoo validates both (overlaps, rights) and its refusal comes back as a 409 with its
  words. Every write drops the cached payloads.
- Shortening a punch that ended on a later day may lose that day's check-in: someone who forgot to check
  out and did not punch again right away left their next morning's check-in only as this punch's
  check-out. When no attendance of theirs starts within LOST_ENTRY_MINUTES of the old check-out, the
  answer carries it as lost_entry and the page says so; nothing is created on its own (about one long
  punch in five was like that).
- server.py lets a session here only if it reads other people's attendances and, for a punch, Odoo gives it
  write and create on hr.attendance (client.edits_punches); Odoo checks again on every call.
"""

from datetime import datetime, timedelta, timezone

from . import data
from .client import OdooError, SessionExpired

LOST_ENTRY_MINUTES = 10
STAMP = "%Y-%m-%d %H:%M:%S"


def odoo_stamp(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc).strftime(STAMP)


def lost_entry(client, employee_id, old_out, new_out):
    if not old_out or data.local(old_out).date() <= data.local(new_out).date():
        return None
    until = datetime.strptime(old_out, STAMP) + timedelta(minutes=LOST_ENTRY_MINUTES)
    until = until.strftime(STAMP)
    later = client.call_kw("hr.attendance", "search_count", [[("employee_id", "=", employee_id),
                                                              ("check_in", ">=", old_out), ("check_in", "<=", until)]])
    return None if later else data.local(old_out).isoformat()


def save_attendance(client, body):
    try:
        check_in, check_out = odoo_stamp(body["check_in"]), odoo_stamp(body["check_out"])
        record, employee = int(body.get("id") or 0), int(body.get("employee") or 0)
    except (KeyError, TypeError, ValueError):
        return 400, {"error": "Entrada o salida no válidas"}
    if check_out <= check_in:
        return 400, {"error": "La salida tiene que ser posterior a la entrada"}
    if not record and not employee:
        return 400, {"error": "Falta el fichaje o la persona"}
    try:
        if record:
            before = client.call_kw("hr.attendance", "read", [[record], ["employee_id", "check_out"]])[0]
            client.call_kw("hr.attendance", "write", [[record], {"check_in": check_in, "check_out": check_out}])
            lost = lost_entry(client, before["employee_id"][0], before["check_out"], check_out)
        else:
            punch = {"employee_id": employee, "check_in": check_in, "check_out": check_out}
            client.call_kw("hr.attendance", "create", [punch])
            lost = None
    except SessionExpired:
        raise
    except OdooError as error:
        return 409, {"error": str(error)}
    data.drop_data_cache()
    return 200, {"ok": True, "lost_entry": lost}


def approve_request(client, request_id):
    try:
        request = int(request_id)
    except (TypeError, ValueError):
        return 400, {"error": f"Solicitud no válida: {request_id}"}
    try:
        client.call_kw("approval.request", "action_approve", [[request]])
    except SessionExpired:
        raise
    except OdooError as error:
        return 409, {"error": str(error)}
    data.drop_data_cache()
    return 200, {"ok": True}
