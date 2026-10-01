"""The only writes to Odoo besides punching: the day dialog's corrections, for a session that may make them.

- save_attendance changes a punch's check-in and check-out, or creates one, delete_attendance removes one for
  good (unlink: Odoo keeps nothing of it, so it cannot be undone), and approve_request approves a change request
  as the session's user (action_approve, which Odoo allows only to a pending approver, hence team.py's
  can_approve). Odoo validates them all (overlaps, rights) and its refusal comes back as a 409 with its words.
  Every write drops the cached payloads.
- A punch's reason (Normal, Descanso…) is changed only when the body names one: it then replaces whatever
  reasons the punch had (REPLACE, the many2many command), as the page shows one reason per punch and every
  punch in this Odoo carries one or none. Without it the field is not sent at all: it only exists with the
  module installed (client.py), and which reasons there are to choose is the payload's business (team.py).
- Shortening a punch that ended on a later day may lose that day's check-in: someone who forgot to check
  out and did not punch again right away left their next morning's check-in only as this punch's
  check-out. When no attendance of theirs starts within LOST_ENTRY_MINUTES of the old check-out, the
  answer carries it as lost_entry and the page says so; nothing is created on its own (about one long
  punch in five was like that).
- server.py lets a session here only if it reads other people's attendances and, for a punch, Odoo gives it
  write, create and unlink on hr.attendance (client.edits_punches); Odoo checks again on every call.
"""

from datetime import datetime, timedelta, timezone

from . import data
from .client import OdooError, SessionExpired

LOST_ENTRY_MINUTES = 10
REPLACE = 6
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
        reason = int(body.get("reason") or 0)
    except (KeyError, TypeError, ValueError):
        return 400, {"error": "Entrada, salida o motivo no válidos"}
    if check_out <= check_in:
        return 400, {"error": "La salida tiene que ser posterior a la entrada"}
    if not record and not employee:
        return 400, {"error": "Falta el fichaje o la persona"}
    punch = {"check_in": check_in, "check_out": check_out,
             **({"attendance_reason_ids": [[REPLACE, 0, [reason]]]} if reason else {})}
    try:
        if record:
            before = client.call_kw("hr.attendance", "read", [[record], ["employee_id", "check_out"]])[0]
            client.call_kw("hr.attendance", "write", [[record], punch])
            lost = lost_entry(client, before["employee_id"][0], before["check_out"], check_out)
        else:
            client.call_kw("hr.attendance", "create", [{"employee_id": employee, **punch}])
            lost = None
    except SessionExpired:
        raise
    except OdooError as error:
        return 409, {"error": str(error)}
    data.drop_data_cache()
    return 200, {"ok": True, "lost_entry": lost}


def run_on(client, model, method, record_id, invalid):
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


def approve_request(client, request_id):
    return run_on(client, "approval.request", "action_approve", request_id, "Solicitud no válida")


def delete_attendance(client, record_id):
    return run_on(client, "hr.attendance", "unlink", record_id, "Fichaje no válido")
