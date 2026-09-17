"""Shared test scaffolding: fixtures, the scripted Odoo stand-ins and the throwaway state directory.

Nothing here touches the network or the real ~/.odoo_dashboard: temp_state points every module that
writes there at a temporary directory for the duration of one test.
"""

import http.client
import io
import json
import os
import sys
import tempfile
import urllib.parse
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from odoo_wrapper import cli, client as c, lan, process as pr, state as st  # noqa: E402

CONFIG = {"url": "https://odoo.example", "db": "db", "user": "u"}
NORMAL = {"id": 5, "name": "Normal", "is_rest": False, "action_type": "sign_in", "show_on_attendance_screen": True}
REST = {"id": 3, "name": "Descanso", "is_rest": True, "action_type": "sign_in", "show_on_attendance_screen": True}
EMPLOYEE = {"id": 7, "name": "Ana", "resource_calendar_id": [4, "Std"]}
SESSION_HEADER = "session_id=abc123; Expires=Mon, 21 Sep 2026 10:00:00 GMT; Max-Age=604800; HttpOnly; Path=/"
ROTATED_HEADER = "session_id=rotated; Expires=Mon, 21 Sep 2026 10:00:00 GMT; Max-Age=604800; HttpOnly; Path=/"
DEVICE_HEADER = "td_id=dev2; Max-Age=7776000; HttpOnly; Path=/; SameSite=Lax"
TOTP_PAGE = '<form><input type="hidden" name="csrf_token" value="tok1"/><input name="totp_token"/></form>'


def utc(minutes_ago):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%d %H:%M:%S")


class ScriptedOpener:
    """Answers each call with the next scripted result and records what was asked: JSON-RPC calls get a JSON
    body, form calls (the TOTP page) get the scripted page and status, with the form fields as params."""

    def __init__(self, *results):
        self.results = list(results)
        self.calls = []

    def open(self, req):
        result = self.results.pop(0)
        if req.get_header("Content-type") == "application/json":
            params = json.loads(req.data)["params"]
            body = json.dumps(result if "error" in result else {"result": result.get("result")})
        else:
            params = dict(urllib.parse.parse_qsl(req.data.decode())) if req.data else None
            body = result.get("page", "")
        self.calls.append((req.full_url, params, req.get_header("Cookie")))
        response = io.BytesIO(body.encode())
        response.status = result.get("status", 200)
        response.headers = http.client.HTTPMessage()
        for header in result.get("cookies", []):
            response.headers["Set-Cookie"] = header
        return response


def client(*results, session_id="sid"):
    odoo = c.OdooClient("https://odoo.example/", "db", session_id)
    odoo.opener = ScriptedOpener(*results)
    odoo.uid = 3
    return odoo


def kw(rows):
    return {"result": rows}


class ScriptedClient:
    """Odoo client stand-in for the server side: answers call_kw per model and records every punch."""

    def __init__(self, rows=None, open_att=None, reasons=(NORMAL, REST)):
        self.rows = rows or {}
        self.open_att = open_att
        self.reasons = reasons
        self.employee_id, self.employee_name, self.calendar_id = 7, "Ana", 4
        self.punches, self.calls = [], []
        self.session_id = "sid"

    def session_info(self):
        return {"uid": 3}

    def load_employee(self):
        pass

    def call_kw(self, model, method, args, kwargs=None):
        self.calls.append((model, args, kwargs))
        rows = self.rows.get(model, [])
        return rows(args, kwargs) if callable(rows) else rows

    def open_attendance(self):
        return self.open_att

    def open_is_rest(self, open_att, rest):
        if not open_att or not rest:
            return False
        ids = self.call_kw("hr.attendance", "search_read", [[("id", "=", open_att["id"])]], {})[0]["attendance_reason_ids"]
        return rest["id"] in ids

    def attendance_reasons(self):
        return self.call_kw("hr.attendance.reason", "search_read", [[]], {})

    def sign_in_reasons(self):
        return self.reasons

    def punch(self, reason_id=None):
        self.punches.append(reason_id)


def temp_state(test):
    home = tempfile.TemporaryDirectory()
    test.addCleanup(home.cleanup)
    for module, name, value in (
        (c, "STATE_DIR", home.name), (c, "CONFIG_FILE", os.path.join(home.name, "config.json")),
        (cli, "CLI_SESSION_FILE", os.path.join(home.name, "cli_session")),
        (cli, "CLI_DEVICE_FILE", os.path.join(home.name, "cli_device")),
        (lan, "STATE_DIR", home.name), (pr, "STATE_DIR", home.name),
        (st, "STATE_FILE", os.path.join(home.name, "state.json")),
        (pr, "LOG_FILE", os.path.join(home.name, "dashboard.log")),
    ):
        patcher = patch.object(module, name, value)
        patcher.start()
        test.addCleanup(patcher.stop)
    return home.name
