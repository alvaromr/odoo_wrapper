"""Shared test scaffolding: fixtures, the scripted Odoo stand-ins, the throwaway state directory and the log
captured as `LEVEL message` lines.

Nothing here touches the network or the real ~/.odoo_dashboard: temp_state points every module that
writes there at a temporary directory for the duration of one test. Importing this module also refuses the
network to the whole process, so a call left unmocked fails its test instead of reaching a real server; the suite
runs with it because the first test module imports it.

A warning is an error in the gate (`-W error`), but one raised while Python cleans up, such as the ResourceWarning
of a response nobody closed, can only be printed and ignored. Importing this module collects those instead, and the
process exits with 1 after the suite if any came, so they fail the gate too.

No test reads the real clock either. Importing this module also pins the zone to ZONE (where the platform has
tzset) and freezes `datetime` in every module that reads the clock (CLOCK_READERS) at NOW, a Wednesday, so a
fixture or an expectation computed from "now" or "today" is the same on every day the suite runs and covers the same
branches. A test that needs another instant patches that module's `datetime` with `frozen(iso)`; the rules modules
take their `now`/`today` as arguments, which a test passes as NOW and TODAY.
"""

import atexit
import http.client
import io
import json
import logging
import os
import socket
import sys
import tempfile
import time
import urllib.parse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from odoo_wrapper import cli, lan  # noqa: E402
from odoo_wrapper import client as c
from odoo_wrapper import data as dt
from odoo_wrapper import discord as dc
from odoo_wrapper import process as pr
from odoo_wrapper import server as sv
from odoo_wrapper import state as st
from odoo_wrapper import team as tm

ZONE = "Europe/Madrid"
NOW_ISO = "2026-11-04T10:00:00+01:00"
NOW = datetime.fromisoformat(NOW_ISO)
TODAY = NOW.date()
CLOCK_READERS = (cli, dt, sv, st, tm)
CONFIG = {"url": "https://odoo.example", "db": "db", "user": "u"}
NORMAL = {"id": 5, "name": "Normal", "is_rest": False, "action_type": "sign_in", "show_on_attendance_screen": True}
REST = {"id": 3, "name": "Descanso", "is_rest": True, "action_type": "sign_in", "show_on_attendance_screen": True}
EMPLOYEE = {"id": 7, "name": "Ana", "resource_calendar_id": [4, "Std"]}
SESSION_HEADER = "session_id=abc123; Expires=Mon, 21 Sep 2026 10:00:00 GMT; Max-Age=604800; HttpOnly; Path=/"
ROTATED_HEADER = "session_id=rotated; Expires=Mon, 21 Sep 2026 10:00:00 GMT; Max-Age=604800; HttpOnly; Path=/"
DEVICE_HEADER = "td_id=dev2; Max-Age=7776000; HttpOnly; Path=/; SameSite=Lax"
TOTP_PAGE = '<form><input type="hidden" name="csrf_token" value="tok1"/><input name="totp_token"/></form>'


def no_network(*_args, **_kwargs):
    raise OSError("The tests never reach the network: mock the call that tried to")


socket.socket.connect = socket.socket.connect_ex = no_network
socket.getaddrinfo = no_network

_unraisable = []


def fail_on_unraisable():
    if _unraisable:
        print("\n".join(["Raised where Python could only ignore it:", *_unraisable]), file=sys.stderr)
        os._exit(1)


sys.unraisablehook = lambda unraisable: _unraisable.append(f"{unraisable.exc_type.__name__}: {unraisable.exc_value}")
atexit.register(fail_on_unraisable)


def frozen(iso=NOW_ISO):
    moment = datetime.fromisoformat(iso)

    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return moment.astimezone(tz) if tz else moment.astimezone().replace(tzinfo=None)

    return Frozen


os.environ["TZ"] = ZONE
if hasattr(time, "tzset"):
    time.tzset()
for reader in CLOCK_READERS:
    reader.datetime = frozen()


def utc(minutes_ago):
    return (NOW - timedelta(minutes=minutes_ago)).astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


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
    """Odoo client stand-in for the server side: answers call_kw per model and records every punch.

    calls keeps (model, args, kwargs) for the tests that look for one argument; queries keeps each whole call,
    method included, for the tests that pin the exact queries sent to Odoo.
    """

    def __init__(self, rows=None, open_att=None, reasons=(NORMAL, REST), team=False):
        self.rows = rows or {}
        self.team = team
        self.open_att = open_att
        self.reasons = reasons
        self.employee_id, self.employee_name, self.calendar_id = 7, "Ana", 4
        self.punches, self.calls, self.queries, self.labelled = [], [], [], {}
        self.session_id, self.uid = "sid", 3

    def session_info(self):
        return {"uid": 3}

    def load_employee(self):
        pass

    def call_kw(self, model, method, args, kwargs=None):
        self.calls.append((model, args, kwargs))
        self.queries.append((model, method, args, kwargs))
        rows = self.rows.get(model, [])
        return rows(args, kwargs) if callable(rows) else rows

    def open_attendance(self):
        return self.open_att

    def open_is_rest(self, open_att, rest):
        if not open_att or not rest:
            return False
        ids = self.call_kw("hr.attendance", "search_read", [[("id", "=", open_att["id"])]], {})[0][
            "attendance_reason_ids"
        ]
        return rest["id"] in ids

    def attendance_reasons(self):
        return self.call_kw("hr.attendance.reason", "search_read", [[]], {})

    def field_named(self, model, label):
        return self.labelled.get((model, label))

    def offered_reasons(self):
        return [r for r in self.reasons if r]

    def sign_in_reasons(self):
        return self.reasons

    def sees_others(self):
        return self.team

    def punch(self, reason_id=None):
        self.punches.append(reason_id)


@contextmanager
def logged(out=None):
    out = out or io.StringIO()
    handler = logging.StreamHandler(out)
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    package = logging.getLogger("odoo_wrapper")
    saved = package.handlers, package.level
    package.handlers = [handler]
    package.setLevel(logging.INFO)
    try:
        yield out
    finally:
        package.handlers = saved[0]
        package.setLevel(saved[1])


def temp_state(test):
    home = tempfile.TemporaryDirectory()
    test.addCleanup(home.cleanup)
    for module, name, value in (
        (c, "STATE_DIR", home.name),
        (c, "CONFIG_FILE", os.path.join(home.name, "config.json")),
        (cli, "CLI_SESSION_FILE", os.path.join(home.name, "cli_session")),
        (cli, "CLI_DEVICE_FILE", os.path.join(home.name, "cli_device")),
        (cli, "SHEET_FILE", os.path.join(home.name, "notices_sheet")),
        (cli, "WRITTEN_FILE", os.path.join(home.name, "notices_written")),
        (lan, "STATE_DIR", home.name),
        (pr, "STATE_DIR", home.name),
        (st, "STATE_FILE", os.path.join(home.name, "state.json")),
        (dc, "TOKEN_FILE", os.path.join(home.name, "discord_token")),
        (pr, "LOG_FILE", os.path.join(home.name, "dashboard.log")),
    ):
        patcher = patch.object(module, name, value)
        patcher.start()
        test.addCleanup(patcher.stop)
    return home.name
