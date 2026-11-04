"""Unit tests for the HTTP side: Odoo sessions as login, the brute-force throttle and the request handler.

The handler is driven directly, without sockets: a request is a Handler built by hand with a fake
connection, headers and body, and the answer is read back from its output buffer. Odoo is a ServerOdoo handed out
by the server's own client factory, Discord and GitHub answer at urlopen, and the rest of the package runs for real.
"""

import http.client
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import unittest
import urllib.request
from contextlib import contextmanager
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from harness import CONFIG, NORMAL, TODAY, ScriptedClient, logged, temp_state, utc

from odoo_wrapper import attendance_rules as ar
from odoo_wrapper import cache, lan
from odoo_wrapper import client as c
from odoo_wrapper import server as sv
from odoo_wrapper import state as st
from odoo_wrapper import team_rules as tr
from odoo_wrapper.client import AccessDenied, OdooDown, OdooError, SessionExpired, TotpRequired


class ServerOdoo(ScriptedClient):
    """The scripted Odoo plus what the server asks of a client besides data: its rights, its session check, its
    logout and someone else's employee, each able to fail, with a count of what was asked."""

    url = "https://odoo.example"

    def __init__(self, rows=None, edits=False, failure=None, **kw):
        super().__init__(rows, **kw)
        self.edits, self.failure, self.session_error, self.logout_error = edits, failure, None, None
        self.sessions, self.loaded_others = [], []
        self.session_checks = self.rights_asked = self.logouts = 0

    def factory(self, session_id):
        self.sessions.append(session_id)
        return self

    def session_info(self):
        self.session_checks += 1
        if self.session_error:
            raise self.session_error
        return super().session_info()

    def load_employee(self):
        if self.failure:
            raise self.failure

    def load_other(self, employee):
        self.load_employee()
        self.loaded_others.append(employee)
        self.employee_id = employee

    def sees_others(self):
        self.rights_asked += 1
        return self.team

    def edits_punches(self):
        return self.edits

    def logout(self):
        self.logouts += 1
        if self.logout_error:
            raise self.logout_error


class FakeDiscord:
    """Discord's API at urlopen: answers the bot's name and a direct channel, and records what was asked."""

    ANSWERS = {"/users/@me": {"username": "Odoo"}, "/users/@me/channels": {"id": "chan"}}

    def __init__(self):
        self.requests = []

    def urlopen(self, request, timeout):
        path = request.full_url.removeprefix(sv.discord.API)
        body = json.loads(request.data) if request.data else None
        self.requests.append((path, request.get_header("Authorization"), body))
        return io.BytesIO(json.dumps(self.ANSWERS.get(path, {})).encode())


class UdpSocket:
    def __init__(self, *_args):
        pass

    def connect(self, _address):
        pass

    def getsockname(self):
        return ("10.0.0.2", 40000)

    def close(self):
        pass


@contextmanager
def on_the_lan():
    with (
        patch.object(socket, "socket", UdpSocket),
        patch.object(subprocess, "run", return_value=SimpleNamespace(stdout="mac\n")),
    ):
        lan.expose("10.0.0.2")
        yield


class SessionTest(unittest.TestCase):
    def setUp(self):
        temp_state(self)
        sv._sessions.clear()
        self.addCleanup(sv._sessions.clear)

    def cookie(self, value):
        return {"Cookie": f"otra=1; {sv.COOKIE_NAME}={value}"} if value is not None else {}

    def test_the_cookie_is_read_and_sanitised(self):
        self.assertEqual(sv.session_cookie(self.cookie("abc-DEF_09")), "abc-DEF_09")
        every = "".join(sorted(sv.SESSION_CHARS))
        self.assertEqual(sv.session_cookie(self.cookie(every)), every)
        for value in ("", "a b", "a;b", 'a"b', "ñ", "a.b", None):
            self.assertEqual(sv.session_cookie(self.cookie(value)), "", value)

    def test_nothing_is_valid_without_a_configuration(self):
        odoo = ServerOdoo()
        with patch.object(sv, "new_client", odoo.factory):
            self.assertFalse(sv.session_ok("sid"))
        self.assertEqual(odoo.sessions, [])

    def test_an_unknown_session_is_checked_once_against_odoo(self):
        c.save_config(**CONFIG)
        odoo = ServerOdoo()
        odoo.uid = 4
        with patch.object(sv, "new_client", odoo.factory):
            self.assertFalse(sv.session_ok(""))
            self.assertTrue(sv.session_ok("sid"))
            self.assertTrue(sv.session_ok("sid"))
        self.assertEqual((odoo.sessions, odoo.session_checks), (["sid"], 1))
        self.assertEqual(sv._sessions, {"sid": 4})

    def test_an_expired_session_is_refused(self):
        c.save_config(**CONFIG)
        odoo = ServerOdoo()
        odoo.session_error = SessionExpired("caducada")
        with patch.object(sv, "new_client", odoo.factory):
            self.assertFalse(sv.session_ok("sid"))
        self.assertNotIn("sid", sv._sessions)

    def test_new_client_takes_the_configured_server_and_the_cached_uid(self):
        sv._sessions["sid"] = 4
        c.save_config("https://o/", "db", "u")
        client, fresh = sv.new_client("sid"), sv.new_client("other")
        self.assertEqual((client.url, client.db, client.session_id, client.uid), ("https://o", "db", "sid", 4))
        self.assertIsNone(fresh.uid)


class LoginThrottleTest(unittest.TestCase):
    IP = "192.0.2.7"

    def setUp(self):
        sv._login_fails.clear()
        self.addCleanup(sv._login_fails.clear)

    def test_the_first_failures_are_free(self):
        for _ in range(sv.LOGIN_TRIES - 1):
            sv.login_failed(self.IP)
        self.assertEqual(sv.login_wait(self.IP), 0)

    def test_locks_out_after_the_limit_and_backs_off(self):
        for _ in range(sv.LOGIN_TRIES):
            sv.login_failed(self.IP)
        first = sv.login_wait(self.IP)
        self.assertGreater(first, 0)
        sv.login_failed(self.IP)
        self.assertGreater(sv.login_wait(self.IP), first)

    def test_never_locks_out_longer_than_the_cap(self):
        for _ in range(40):
            sv.login_failed(self.IP)
        self.assertLessEqual(sv.login_wait(self.IP), sv.LOGIN_LOCK_MAX)

    def test_a_success_clears_the_counter(self):
        for _ in range(sv.LOGIN_TRIES + 2):
            sv.login_failed(self.IP)
        sv.login_succeeded(self.IP)
        self.assertEqual(sv.login_wait(self.IP), 0)

    def test_one_address_does_not_lock_out_another(self):
        for _ in range(sv.LOGIN_TRIES + 1):
            sv.login_failed(self.IP)
        self.assertEqual(sv.login_wait("192.0.2.8"), 0)


class ClockEdgeTest(unittest.TestCase):
    """The throttle, the pairings and the remembered rights at the exact second each rule turns."""

    def setUp(self):
        self.now = 1000.0
        patcher = patch.object(sv, "time", SimpleNamespace(monotonic=lambda: self.now))
        patcher.start()
        self.addCleanup(patcher.stop)
        for store in (sv._login_fails, sv._pairings, sv._rights):
            store.clear()
            self.addCleanup(store.clear)

    def test_each_lock_doubles_from_the_limit_and_resets_once_the_longest_has_passed(self):
        ip, waits = "192.0.2.7", []
        for _ in range(sv.LOGIN_TRIES + 2):
            sv.login_failed(ip)
            waits.append(sv.login_wait(ip))
        self.assertEqual(waits, [0] * (sv.LOGIN_TRIES - 1) + [sv.LOGIN_LOCK, 2 * sv.LOGIN_LOCK, 4 * sv.LOGIN_LOCK])
        self.now += 4 * sv.LOGIN_LOCK + sv.LOGIN_LOCK_MAX
        sv.login_failed(ip)
        self.assertEqual(sv.login_wait(ip), 8 * sv.LOGIN_LOCK)
        self.now += 8 * sv.LOGIN_LOCK + sv.LOGIN_LOCK_MAX + 1
        sv.login_failed(ip)
        self.assertEqual(sv.login_wait(ip), 0)

    def test_an_unknown_address_never_waits(self):
        self.now = 0.5
        self.assertEqual(sv.login_wait("192.0.2.9"), 0)
        for _ in range(sv.LOGIN_TRIES - 1):
            sv.login_failed("192.0.2.9")
        self.assertEqual(sv.login_wait("192.0.2.9"), 0)

    def test_a_pairing_holds_until_its_last_second(self):
        token = sv.new_pairing("sid", "https://10.0.0.2:8443/")["url"].split("t=")[1]
        self.assertEqual(len(token), 32)
        self.now += sv.PAIR_TTL
        sv.new_pairing("sid", "https://10.0.0.2:8443/")
        self.assertEqual(sv.spend_pairing(token), "sid")

    def test_a_right_is_asked_again_once_its_time_is_up(self):
        odoo = ServerOdoo(team=True)
        sv.sees_others(odoo)
        self.now += sv.SEES_TTL
        sv.sees_others(odoo)
        self.assertEqual(odoo.rights_asked, 2)


class FakeTLS:
    pass


class HandlerTest(unittest.TestCase):
    def setUp(self):
        self.home = temp_state(self)
        patcher = patch.dict(lan._lan)
        patcher.start()
        self.addCleanup(patcher.stop)
        lan.expose("127.0.0.1")
        c.save_config(**CONFIG)
        sv._sessions["sid"] = 3
        self.addCleanup(sv._sessions.clear)
        sv._rights.clear()
        self.addCleanup(sv._rights.clear)
        sv._login_fails.clear()
        self.addCleanup(sv._login_fails.clear)
        self.addCleanup(cache.drop)

    def request(
        self,
        method,
        path,
        body=None,
        *,
        host="localhost:8931",
        origin=None,
        cookie="sid",
        device="",
        ip="127.0.0.1",
        tls=False,
        length=True,
    ):
        h = sv.Handler.__new__(sv.Handler)
        h.command, h.path, h.request_version = method, path, "HTTP/1.1"
        h.requestline = f"{method} {path} HTTP/1.1"
        h.client_address = (ip, 1)
        h.connection = FakeTLS() if tls else object()
        h.headers = http.client.HTTPMessage()
        cookies = [(sv.COOKIE_NAME, cookie), (sv.DEVICE_COOKIE, device)]
        for key, value in (
            ("Host", host),
            ("Origin", origin),
            ("User-Agent", "TestBrowser/1"),
            ("Cookie", "; ".join(f"{name}={value}" for name, value in cookies if value) or None),
        ):
            if value is not None:
                h.headers[key] = value
        raw = b"" if body is None else body if isinstance(body, bytes) else json.dumps(body).encode()
        if length is not None:
            h.headers["Content-Length"] = str(len(raw) if length is True else length)
        h.rfile, h.wfile = io.BytesIO(raw), io.BytesIO()
        with patch.object(sv, "ssl", SimpleNamespace(SSLSocket=FakeTLS)):
            getattr(h, "do_" + method)()
        head, _, payload = h.wfile.getvalue().partition(b"\r\n\r\n")
        status = int(head.split(b" ")[1])
        headers = {}
        for key, value in (line.decode().split(": ", 1) for line in head.split(b"\r\n")[1:]):
            headers[key] = f"{headers[key]}\n{value}" if key in headers else value
        self.assertEqual(headers["Content-Length"], str(len(payload)))
        if headers["Content-Type"].startswith("application/json"):
            self.assertEqual(payload, json.dumps(json.loads(payload), ensure_ascii=False).encode())
        return status, headers, payload

    def get(self, path, **kw):
        status, headers, payload = self.request("GET", path, **kw)
        return (
            status,
            headers,
            json.loads(payload) if headers["Content-Type"].startswith("application/json") else payload,
        )

    def post(self, path, body, **kw):
        status, headers, payload = self.request("POST", path, body, **kw)
        return status, headers, json.loads(payload)

    def test_pages_and_assets(self):
        for path, marker, ctype in (
            ("/", b"<html", "text/html"),
            ("/index.html", b"<html", "text/html"),
            ("/style.css", b":root", "text/css"),
            ("/dashboard.css", b".hero", "text/css"),
            ("/team.css", b".fix-grid", "text/css"),
            ("/login.css", b".clock", "text/css"),
            ("/js/app.js", b"function", "text/javascript"),
            ("/js/hero.js", b"function renderHero", "text/javascript"),
            ("/manifest.json", b'"start_url"', "application/manifest+json"),
            ("/icon.svg", b"<svg", "image/svg+xml"),
        ):
            status, headers, payload = self.get(path)
            self.assertEqual(status, 200, path)
            self.assertIn(marker, payload)
            self.assertNotEqual(payload[:1], b'"', path)
            self.assertTrue(headers["Content-Type"].startswith(ctype), path)
            self.assertEqual(headers["X-Frame-Options"], "DENY")
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            self.assertEqual(
                headers["Content-Security-Policy"],
                "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; "
                "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; "
                "object-src 'none'",
            )
        for path in (
            "/js/nada.js",
            "/js/../server.py",
            "/js/",
            "/app.js",
            "/nada.css",
            "/js/style.css",
            "/../static/style.css",
            "/dashboard.html",
        ):
            self.assertEqual(self.get(path)[0], 404, path)

    def test_no_page_carries_a_style_the_policy_would_refuse(self):
        for name in sv.PAGES.values():
            with open(name, encoding="utf-8") as f:
                page = f.read()
            self.assertNotIn("<style", page, name)
            self.assertNotIn(" style=", page, name)

    def test_the_page_is_installable(self):
        manifest = json.loads(self.get("/manifest.json")[2])
        self.assertEqual(manifest["start_url"], "/")
        self.assertEqual(manifest["display"], "standalone")
        for cookie in (None, "sid"):
            self.assertIn(b'rel="manifest"', self.get("/", cookie=cookie)[2])

    def test_each_page_loads_the_theme_and_one_entry_script_and_every_other_script_is_imported(self):
        theme = '<script src="/js/theme.js">'
        entries = {"/": "app.js", "/gestion": "team.js"}
        for path, entry in entries.items():
            tags = re.findall(r"<script[^>]*>", self.get(path)[2].decode())
            self.assertEqual(tags, [theme, f'<script type="module" src="/js/{entry}">'], path)
        self.assertEqual(
            re.findall(r"<script[^>]*>", self.get("/login")[2].decode()),
            [theme, '<script type="module" src="/js/login.js">'],
        )
        sources = {}
        for name in os.listdir(sv.SCRIPTS):
            with open(os.path.join(sv.SCRIPTS, name)) as f:
                sources[name] = f.read()
        for name in sources:
            if name in entries.values() or name in ("theme.js", "login.js"):
                continue
            self.assertTrue(any(re.search(rf'from "\./{re.escape(name)}"', src) for src in sources.values()), name)

    def test_login_page_without_a_session_cookie(self):
        self.assertIn(b"Introduce tu usuario", self.get("/", cookie=None)[2])
        self.assertIn(b"Introduce tu usuario", self.get("/", cookie="a b")[2])
        self.assertNotIn(b"Introduce tu usuario", self.get("/")[2])
        self.assertIn(b"Introduce tu usuario", self.get("/login")[2])
        self.assertIn(b"Introduce tu usuario", self.get("/gestion", cookie=None)[2])
        self.assertIn(b"Gesti\xc3\xb3n de fichajes", self.get("/gestion")[2])
        self.assertIn(b'id="hero"', self.get("/empleado?id=9")[2])
        self.assertIn(b"Introduce tu usuario", self.get("/empleado?id=9", cookie=None)[2])

    def test_the_permission_to_read_others_is_remembered_per_session(self):
        odoo = ServerOdoo(team=True)
        with patch.object(sv, "new_client", odoo.factory):
            self.assertTrue(sv.sees_others(odoo))
            self.assertTrue(sv.sees_others(odoo))
            self.assertEqual(odoo.rights_asked, 1)
            with patch.object(sv, "SEES_TTL", -1):
                sv.sees_others(odoo)
            self.assertEqual(odoo.rights_asked, 2)
            self.post("/api/logout", {})
        self.assertNotIn("sid", sv._rights)

    def test_someone_elses_data(self):
        self.assertEqual(self.get("/api/data?employee=x")[0], 400)
        pending = {
            "id": 552,
            "request_owner_id": [11, "Ana"],
            "date_start": utc(60),
            "date_end": None,
            "reason": "<p>Olvidé  fichar</p>",
            "request_status": "pending",
            "user_status": "pending",
        }
        odoo = ServerOdoo({"hr.employee": [{"user_id": [11, "Ana"]}], "approval.request": [pending]})

        def attendance_reads():
            return sum(model == "hr.attendance" for model, *_ in odoo.queries)

        with patch.object(sv, "new_client", odoo.factory):
            self.assertEqual(self.get("/api/data?employee=9")[:3:2], (403, {"error": sv.NOT_TEAM}))
            self.assertEqual((odoo.sessions, odoo.queries), (["sid"], []))
            odoo.team = True
            sv._rights.clear()
            status, _, payload = self.get("/api/data?employee=9&fresh")
            self.assertEqual(status, 200)
            asked = {
                "from": ar.local(pending["date_start"]).isoformat(),
                "id": 552,
                "reason": "Olvidé fichar",
                "status": "pending",
                "to": None,
                "user": 11,
                "can_approve": True,
            }
            self.assertEqual(
                (payload["phone"], payload["state"], payload["requests"], payload["can_edit"], payload["sessions"]),
                (None, st.OTHER_STATE, [asked], False, []),
            )
            self.assertEqual((payload["employee_id"], odoo.loaded_others), (9, [9]))
            self.assertEqual(attendance_reads(), 1)
            self.get("/api/data?employee=9")
            self.assertEqual(attendance_reads(), 1)
            self.get("/api/data?employee=9&fresh")
            self.assertEqual(attendance_reads(), 2)
            self.assertEqual(sum(model == "approval.request" for model, *_ in odoo.queries), 3)

    def test_the_own_request_link_needs_a_session_and_takes_only_the_date(self):
        self.assertEqual(self.get("/api/request?date=2026-10-19", cookie=None)[0], 401)
        odoo = ServerOdoo({"approval.category": [{"id": 12}]})
        with patch.object(sv, "new_client", odoo.factory):
            status, _, payload = self.get("/api/request?date=2026-10-19&employee=9")
        self.assertEqual(
            (status, payload), (200, {"url": "https://odoo.example/odoo/approvals/12/approval.request/new"})
        )
        self.assertEqual((odoo.sessions, odoo.loaded_others), (["sid"], []))
        roster = next(q for q in odoo.queries if q[1] == "read_group")
        self.assertIn(("check_in", "<", tr.odoo_time(sv.date(2026, 10, 26))), roster[2][0])

    def test_the_update_check_needs_a_session_and_forces_a_check_only_when_fresh(self):
        self.assertEqual(self.get("/api/update", cookie=None)[0], 401)
        clock, asked = [1000.0], []

        def github(request, timeout):
            asked.append(request.full_url)
            return io.BytesIO(json.dumps({"tag_name": f"v1.{len(asked)}.0", "html_url": "U"}).encode())

        sv.updates._last.update(at=None, answer=None)
        self.addCleanup(sv.updates._last.update, at=None, answer=None)
        with (
            patch.object(sv.updates, "__version__", "1.0.0"),
            patch.object(urllib.request, "urlopen", github),
            patch.object(time, "monotonic", lambda: clock[0]),
            patch.object(sys, "prefix", self.home),
            patch.object(shutil, "which", lambda program: f"/bin/{program}"),
        ):
            answer = {"available": True, "current": "1.0.0", "latest": "1.1.0", "url": "U", "error": ""}
            self.assertEqual(self.get("/api/update")[:3:2], (200, dict(answer, local=True, how="auto")))
            self.assertEqual(self.get("/api/update?fresh", ip="10.0.0.9")[2]["latest"], "1.1.0")
            self.assertEqual(len(asked), 1)
            clock[0] += sv.updates.FRESH_MIN
            status, _, payload = self.get("/api/update?fresh", ip="10.0.0.9")
            self.assertEqual((status, payload["latest"], payload["local"]), (200, "1.2.0", False))
            clock[0] += sv.updates.FRESH_MIN
            self.assertEqual(self.get("/api/update")[2]["latest"], "1.2.0")
        self.assertEqual(asked, [sv.updates.LATEST] * 2)

    def test_only_the_machine_itself_installs_an_update(self):
        self.assertEqual(self.post("/api/update", {}, cookie=None)[0], 401)
        self.addCleanup(lambda: sv.updates._installing.locked() and sv.updates._installing.release())
        runs = []

        def uv(command, **_kwargs):
            runs.append(command)
            return SimpleNamespace(returncode=0, stdout=f"{self.home}\n", stderr="")

        with (
            patch.object(sys, "argv", ["odoo-dashboard", "--host", "0.0.0.0", "--open"]),
            patch.object(sys, "platform", "win32"),
            patch.object(sys, "prefix", self.home),
            patch.object(shutil, "which", lambda program: "uv" if program == "uv" else None),
            patch.object(sv.updates, "HOMES", ()),
            patch.object(sv.updates, "SYSTEM_BINS", ()),
            patch.object(subprocess, "run", uv),
            patch.object(subprocess, "Popen") as helper,
            patch.object(threading, "Timer"),
        ):
            self.assertEqual(
                self.post("/api/update", {}, ip="10.0.0.9")[:3:2],
                (403, {"error": "Solo se actualiza desde el propio ordenador"}),
            )
            self.assertEqual((runs, helper.call_count), ([], 0))
            self.assertEqual(self.post("/api/update", {})[:3:2], (202, {"ok": True, "skills": ""}))
        self.assertEqual(runs, [["uv", "tool", "dir"]])
        plan = json.loads(helper.call_args.args[0][-1])
        self.assertEqual((plan["port"], plan["old"][3:]), (sv.PORT, ["--host", "0.0.0.0"]))
        self.assertEqual(plan["command"][-1], sv.updates.SOURCE)

    def test_team_writes(self):
        self.assertEqual(self.post("/api/team/attendance", {}, cookie=None)[0], 401)
        punch = {
            "id": 1,
            "check_in": "2026-10-19T08:00:00+00:00",
            "check_out": "2026-10-19T16:00:00+00:00",
        }
        was = {"employee_id": [7, "Ana"], "check_out": "2026-10-19 16:00:00"}

        def refuse(_args, _kwargs):
            raise OdooError("no")

        odoo = ServerOdoo({"hr.attendance": [was], "approval.request": refuse})

        def writes():
            return [q for q in odoo.queries if q[1] in ("write", "unlink", "action_approve")]

        with patch.object(sv, "new_client", odoo.factory):
            self.assertEqual(self.post("/api/team/attendance", punch)[:3:2], (403, {"error": sv.NOT_TEAM}))
            self.assertEqual(self.post("/api/team/delete", {"id": 1})[:3:2], (403, {"error": sv.NOT_TEAM}))
            self.assertEqual(self.post("/api/team/approve", {"id": 1})[0], 403)
            odoo.team = True
            sv._rights.clear()
            self.assertEqual(self.post("/api/team/attendance", punch)[:3:2], (403, {"error": sv.NOT_EDITOR}))
            self.assertEqual(self.post("/api/team/delete", {"id": 1})[:3:2], (403, {"error": sv.NOT_EDITOR}))
            self.assertEqual(writes(), [])
            odoo.edits = True
            sv._rights.clear()
            self.assertEqual(self.post("/api/team/attendance", punch)[:3:2], (200, {"ok": True, "lost_entry": None}))
            self.assertEqual(
                writes(),
                [
                    (
                        "hr.attendance",
                        "write",
                        [[1], {"check_in": "2026-10-19 08:00:00", "check_out": "2026-10-19 16:00:00"}],
                        None,
                    )
                ],
            )
            self.assertEqual(self.post("/api/team/delete", {"id": 31512})[:3:2], (200, {"ok": True}))
            self.assertEqual(writes()[-1], ("hr.attendance", "unlink", [[31512]], None))
            self.assertEqual(self.post("/api/team/approve", {"id": 552})[:3:2], (409, {"error": "no"}))
            self.assertEqual(odoo.queries[-1], ("approval.request", "action_approve", [[552]], None))
        self.assertEqual(set(odoo.sessions), {"sid"})

    def test_a_discord_message_needs_a_session_that_reads_others_and_nothing_else(self):
        c.write_private(sv.discord.TOKEN_FILE, "tok")
        body = {"employee": 7, "text": "hola"}
        odoo = self.discord_odoo()
        discord = FakeDiscord()
        with patch.object(sv, "new_client", odoo.factory), patch.object(urllib.request, "urlopen", discord.urlopen):
            self.assertEqual(self.post("/api/team/discord", body)[0], 403)
            self.assertEqual(discord.requests, [])
            odoo.team = True
            sv._rights.clear()
            self.assertEqual(self.post("/api/team/discord", body)[:3:2], (200, {"ok": True}))
        self.assertEqual(
            [(path, auth) for path, auth, _ in discord.requests],
            [("/users/@me/channels", "Bot tok"), ("/channels/chan/messages", "Bot tok")],
        )
        self.assertEqual(discord.requests[0][2], {"recipient_id": "111222333"})
        message = discord.requests[1][2]
        self.assertEqual(message["content"], "hola\n\n" + sv.discord.FOOTER.format("<@111222333>"))
        button = message["components"][0]["components"][0]
        self.assertEqual(button["url"], "https://odoo.example/odoo/approvals/12/approval.request/new")

    def discord_odoo(self):
        odoo = ServerOdoo({"hr.employee": [{"id": 7, "x_discord": "111222333"}], "approval.category": [{"id": 12}]})
        odoo.labelled[("hr.employee", "discord")] = "x_discord"
        return odoo

    def test_the_bot_token_is_kept_for_a_session_that_reads_others_and_never_sent_back(self):
        odoo, discord = self.discord_odoo(), FakeDiscord()
        with patch.object(sv, "new_client", odoo.factory), patch.object(urllib.request, "urlopen", discord.urlopen):
            self.assertEqual(self.post("/api/team/discord/token", {"token": "tok"})[0], 403)
            self.assertEqual(discord.requests, [])
            self.assertFalse(sv.discord.configured())
            odoo.team = True
            sv._rights.clear()
            self.assertEqual(self.post("/api/team/discord/token", {"token": "tok"})[:3:2], (200, {"bot": "Odoo"}))
            self.assertEqual(discord.requests, [("/users/@me", "Bot tok", None)])
            self.assertEqual(c.read_private(sv.discord.TOKEN_FILE), "tok")
            self.assertEqual(self.post("/api/team/discord/test", {})[:3:2], (200, {"ok": True}))
        self.assertEqual(discord.requests[1][2], {"recipient_id": "111222333"})
        self.assertEqual(discord.requests[2][2]["content"], sv.discord.TEST_TEXT)

    def test_team_api(self):
        self.assertEqual(self.get("/api/team", cookie=None)[0], 401)
        self.assertEqual(self.get("/api/team?week=nope")[0], 400)
        odoo = ServerOdoo()

        def reads():
            return len(odoo.queries)

        def span(payload):
            return tuple(payload[key] for key in ("week", "start", "stop"))

        with patch.object(sv, "new_client", odoo.factory):
            status, _, payload = self.get("/api/team")
            self.assertEqual((status, payload), (403, {"error": "Tu usuario de Odoo no ve fichajes de otras personas"}))
            self.assertEqual(odoo.queries, [])
            odoo.team = odoo.edits = True
            sv._rights.clear()
            status, _, payload = self.get("/api/team?week=2026-09-24&fresh")
            self.assertEqual(status, 200)
            self.assertEqual(span(payload), ("2026-09-21", "2026-09-21", "2026-09-28"))
            self.assertEqual((payload["employees"], payload["can_edit"], payload["can_message"]), ([], True, False))
            self.assertEqual(set(odoo.sessions), {"sid"})
            asked = reads()
            c.write_private(sv.discord.TOKEN_FILE, "tok")
            self.assertIs(self.get("/api/team?week=2026-09-24")[2]["can_message"], True)
            self.assertEqual(reads(), asked)
            self.get("/api/team?week=2026-09-24&fresh")
            self.assertGreater(reads(), asked)
            monday = tr.monday_of(TODAY)
            self.assertEqual(
                span(self.get("/api/team")[2]),
                tuple(day.isoformat() for day in (monday, monday, monday + timedelta(weeks=1))),
            )
            self.assertEqual(span(self.get("/api/team?month=2026-09")[2]), ("2026-08-31", "2026-09-01", "2026-10-01"))
        self.assertEqual(self.get("/api/team?month=2026-13")[0], 400)
        self.assertEqual(self.get("/api/team?year=dos")[0], 400)
        odoo = ServerOdoo(team=True)
        with patch.object(sv, "new_client", odoo.factory):
            status, _, payload = self.get("/api/team?year=2025&fresh")
            self.assertEqual(
                (status, payload["year"], payload["employees"], payload["can_message"]), (200, 2025, [], True)
            )
            asked = reads()
            self.get("/api/team?year=2025")
            self.assertEqual(reads(), asked)
            self.get("/api/team?year=2025&fresh")
            self.assertGreater(reads(), asked)
        odoo = ServerOdoo(team=True)
        with patch.object(sv, "new_client", odoo.factory):
            status, _, payload = self.get("/api/team?fixes")
            self.assertEqual(
                (status, sorted(payload), payload["employees"]), (200, ["employees", "generated_at", "limits"], [])
            )
            asked = reads()
            self.get("/api/team?fixes")
            self.assertEqual(reads(), asked)
            self.get("/api/team?fixes&fresh")
            self.assertGreater(reads(), asked)

    def test_foreign_host_or_origin_is_refused(self):
        self.assertEqual(self.get("/", host="evil.com")[:3:2], (403, {"error": "origen no permitido"}))
        self.assertEqual(self.post("/api/state", {}, origin="https://evil.example")[0], 403)
        self.assertEqual(self.post("/api/state", {}, origin="http://localhost:8931")[0], 200)
        self.assertEqual(self.get("/nada")[:3:2], (404, {"error": "not found"}))
        self.assertEqual(self.post("/api/nada", {})[:3:2], (404, {"error": "not found"}))
        self.assertEqual(self.get("/api/data?employee=x")[:3:2], (400, {"error": "Empleado no válido: x"}))
        for period in ("week=nope", "month=2026-13", "year=dos"):
            self.assertEqual(
                self.get(f"/api/team?{period}")[:3:2], (400, {"error": f"Periodo no válido: {period.split('=')[1]}"})
            )

    def test_version_state_and_data(self):
        self.assertEqual(self.get("/api/version", cookie=None)[:3:2], (200, {"version": sv.process.source_version()}))
        self.assertEqual(self.get("/api/state")[2]["lunch_minutes"], st.LUNCH_DEFAULT)
        st.write_state(3, break_minutes=st.BREAK_DEFAULT + 1)
        odoo = ServerOdoo(edits=True)

        def attendance_reads():
            return sum(model == "hr.attendance" for model, *_ in odoo.queries)

        with patch.object(sv, "new_client", odoo.factory):
            status, _, payload = self.get("/api/data?fresh")
            self.assertEqual(status, 200)
            self.assertIs(payload["can_edit"], False)
            self.assertEqual(payload["sessions"], [])
            self.assertEqual(payload["state"]["break_minutes"], st.BREAK_DEFAULT + 1)
            self.assertEqual(payload["phone"], {"off": lan.HOST_OPTION})
            self.assertEqual((set(odoo.sessions), attendance_reads()), ({"sid"}, 1))
            self.get("/api/data")
            self.assertEqual(attendance_reads(), 1)
            self.get("/api/data?fresh")
            self.assertEqual(attendance_reads(), 2)
            odoo.team = True
            self.assertIs(self.get("/api/data?fresh")[2]["can_edit"], True)

    def test_config_shows_the_server_only_to_loopback(self):
        self.assertEqual(self.get("/api/config", cookie=None)[:3:2], (200, dict(CONFIG, configured=True, local=True)))
        self.assertEqual(self.get("/api/config", cookie=None, ip="10.0.0.9")[2], {"configured": True, "local": False})
        os.remove(c.CONFIG_FILE)
        self.assertEqual(
            self.get("/api/config", cookie=None)[2],
            {"url": "", "db": "", "user": "", "configured": False, "local": True},
        )

    def failing(self, error):
        return patch.object(sv, "new_client", ServerOdoo(failure=error).factory)

    def test_data_errors(self):
        with self.failing(OdooError("caído")):
            status, _, payload = self.get("/api/data")
        self.assertEqual((status, payload["error"]), (502, "Odoo: caído"))
        with self.failing(OdooDown("Odoo no responde (Connection refused)")):
            status, _, payload = self.get("/api/data")
        self.assertEqual((status, payload["error"]), (502, "Odoo no responde (Connection refused)"))
        with self.failing(RuntimeError("roto")), logged() as out:
            self.assertEqual(self.get("/api/data")[:3:2], (500, {"error": "Error interno del dashboard"}))
        self.assertTrue(out.getvalue().startswith("ERROR Error interno atendiendo GET /api/data\nTraceback"))
        self.assertTrue(out.getvalue().endswith("RuntimeError: roto\n"))

    def test_an_expired_session_is_forgotten_and_the_cookie_cleared(self):
        with self.failing(SessionExpired("caducada")):
            status, headers, payload = self.get("/api/data")
        self.assertEqual((status, payload["error"]), (401, "caducada"))
        self.assertIn(f"{sv.COOKIE_NAME}=; Path=/; Max-Age=0;", headers["Set-Cookie"])
        self.assertNotIn("sid", sv._sessions)

    def test_api_needs_a_session_everywhere(self):
        unauthorized = (401, {"error": "no autorizado"})
        for ip in ("127.0.0.1", "10.0.0.9"):
            for path in ("/api/state", "/api/request", "/api/update", "/api/data", "/api/team"):
                self.assertEqual(self.get(path, ip=ip, cookie=None)[:3:2], unauthorized, path)
            self.assertEqual(self.post("/api/state", {}, ip=ip, cookie=None)[:3:2], unauthorized)
        odoo = ServerOdoo()
        with patch.object(sv, "new_client", odoo.factory):
            odoo.session_error = SessionExpired("no")
            self.assertEqual(self.get("/api/state", cookie="unknown")[0], 401)
            odoo.session_error = OdooError("caído")
            self.assertEqual(self.get("/api/state", cookie="unknown")[0], 502)
            odoo.session_error = None
            self.assertEqual(self.get("/api/state", cookie="unknown")[0], 200)
        self.assertIn("unknown", sv._sessions)

    def login(self, body, totp=False, **kw):
        with patch.object(sv, "OdooClient") as odoo, patch.object(time, "sleep") as sleep:
            odoo.return_value.session_id = "fresh"
            odoo.return_value.device = "dev2" if totp else ""
            odoo.return_value.login.side_effect = (
                TotpRequired("código")
                if totp and not body.get("code")
                else None
                if body.get("password") == "pw"
                else AccessDenied("Usuario o contraseña incorrectos")
            )
            status, headers, payload = self.post("/api/login", body, cookie=None, **kw)
        return status, headers, payload, odoo, sleep

    def test_a_login_needs_the_right_password_and_sets_the_session_cookie(self):
        status, _, payload, odoo, sleep = self.login({"user": "ana", "password": "no"})
        self.assertEqual((status, payload["error"]), (401, "Usuario o contraseña incorrectos"))
        sleep.assert_called_once_with(sv.LOGIN_PENALTY)
        odoo.assert_called_once_with("https://odoo.example", "db", device="")
        self.assertEqual(c.read_config()["user"], "u")
        status, headers, payload, odoo, _ = self.login({"user": "ana", "password": "pw"}, tls=True)
        self.assertEqual((status, payload), (200, {"ok": True}))
        self.assertEqual(sv._sessions["fresh"], odoo.return_value.uid)
        odoo.return_value.login.assert_called_once_with("ana", "pw", "")
        self.assertEqual(odoo.return_value.user_agent, "TestBrowser/1")
        self.assertEqual(headers["Set-Cookie"].count("\n"), 0)
        self.assertIn(
            f"{sv.COOKIE_NAME}=fresh; Path=/; Max-Age={sv.COOKIE_MAX_AGE[sv.COOKIE_NAME]}; HttpOnly",
            headers["Set-Cookie"],
        )
        self.assertIn("; Secure", headers["Set-Cookie"])
        self.assertEqual(c.read_config()["user"], "ana")
        self.assertEqual(self.get("/api/state", ip="10.0.0.9", cookie="fresh")[0], 200)
        self.assertNotIn("Secure", self.login({"password": "pw"})[1]["Set-Cookie"])

    def test_login_is_loopback_only(self):
        status, _, payload, odoo, _ = self.login({"user": "ana", "password": "pw"}, ip="10.0.0.9")
        self.assertEqual(status, 403)
        self.assertEqual(payload["error"], "En el móvil no se inicia sesión: empareja desde el ordenador")
        odoo.assert_not_called()

    def test_login_asks_for_the_code_and_then_trusts_the_device(self):
        status, headers, payload, odoo, sleep = self.login({"user": "ana", "password": "pw"}, totp=True)
        self.assertEqual((status, payload), (401, {"error": "código", "totp": True}))
        self.assertNotIn("Set-Cookie", headers)
        sleep.assert_not_called()
        self.assertEqual(sv.login_wait("127.0.0.1"), 0)
        body = {"user": "ana", "password": "pw", "code": "123456"}
        status, headers, _, odoo, _ = self.login(body, totp=True, device="dev1")
        self.assertEqual(status, 200)
        odoo.assert_called_once_with("https://odoo.example", "db", device="dev1")
        odoo.return_value.login.assert_called_once_with("ana", "pw", "123456")
        session, device = headers["Set-Cookie"].split("\n")
        self.assertTrue(session.startswith(f"{sv.COOKIE_NAME}=fresh; "))
        self.assertEqual(
            device,
            f"{sv.DEVICE_COOKIE}=dev2; Path=/; Max-Age={sv.COOKIE_MAX_AGE[sv.DEVICE_COOKIE]}; HttpOnly; SameSite=Lax",
        )

    def test_login_falls_back_to_the_configured_user(self):
        _, _, _, odoo, _ = self.login({"password": "pw"})
        odoo.return_value.login.assert_called_once_with("u", "pw", "")

    def test_login_may_point_at_another_server(self):
        body = {"url": "https://other.example/", "db": "x", "user": "ana", "password": "pw"}
        _, _, _, odoo, _ = self.login(body)
        odoo.assert_called_once_with("https://other.example/", "x", device="")
        self.assertEqual(c.read_config(), {"url": "https://other.example", "db": "x", "user": "ana"})

    def test_a_server_without_its_database_is_ignored(self):
        _, _, _, odoo, _ = self.login({"url": "https://other.example/", "user": "ana", "password": "pw"})
        odoo.assert_called_once_with("https://odoo.example", "db", device="")

    def test_first_run_needs_the_server(self):
        os.remove(c.CONFIG_FILE)
        status, _, payload, odoo, _ = self.login({"user": "ana", "password": "pw"})
        self.assertEqual(status, 409)
        self.assertEqual(payload["error"], "Configura Odoo primero: faltan la URL y la base de datos")
        odoo.assert_not_called()
        odoo = self.login({"url": "https://o", "db": "db"})[3]
        self.assertEqual(odoo.return_value.login.call_args.args, ("", "", ""))
        status, _, _, _, _ = self.login({"url": "https://o", "db": "db", "user": "ana", "password": "pw"})
        self.assertEqual(status, 200)
        self.assertEqual(c.read_config(), {"url": "https://o", "db": "db", "user": "ana"})

    def test_pairing_hands_the_laptop_session_to_the_phone(self):
        self.assertEqual(self.post("/api/pair", {}, cookie=None)[0], 401)
        self.assertEqual(
            self.post("/api/pair", {}, ip="10.0.0.9")[:3:2],
            (403, {"error": "Solo se empareja desde el propio ordenador"}),
        )
        self.assertEqual(self.post("/api/pair", {})[::2], (409, {"error": lan.HOST_OPTION}))
        with on_the_lan():
            status, _, ip_pair = self.post("/api/pair", {})
            _, _, name_pair = self.post("/api/pair", {"name": True})
        self.assertEqual((status, ip_pair["expires_in"]), (200, sv.PAIR_TTL))
        self.assertTrue(ip_pair["url"].startswith("https://10.0.0.2:8443/pair?t="))
        self.assertTrue(name_pair["url"].startswith("https://mac.local:8443/pair?t="))
        self.assertTrue(ip_pair["qr"].startswith("<svg"))
        token = ip_pair["url"].split("t=")[1]
        status, headers, body = self.request(
            "GET", f"/pair?t={token}", host="10.0.0.2:8443", ip="10.0.0.9", cookie=None, tls=True
        )
        self.assertEqual((status, headers["Location"], headers["Content-Type"], body), (303, "/", "text/plain", b""))
        self.assertIn(
            f"{sv.COOKIE_NAME}=sid; Path=/; Max-Age={sv.COOKIE_MAX_AGE[sv.COOKIE_NAME]}; HttpOnly; SameSite=Lax"
            "; Secure",
            headers["Set-Cookie"],
        )
        for spent in (f"/pair?t={token}", "/pair?t=nope", "/pair"):
            status, headers, _ = self.request("GET", spent, host="10.0.0.2:8443", ip="10.0.0.9", cookie=None)
            self.assertEqual((status, headers["Location"]), (303, "/login"), spent)
            self.assertNotIn("Set-Cookie", headers)
        token = name_pair["url"].split("t=")[1]
        sv._pairings[token] = ("sid", time.monotonic() - 1)
        self.assertEqual(self.request("GET", f"/pair?t={token}", ip="10.0.0.9", cookie=None)[1]["Location"], "/login")
        self.assertNotIn(token, sv._pairings)

    def test_cancelling_revokes_the_sessions_pairings_only(self):
        sv._pairings.clear()
        self.addCleanup(sv._pairings.clear)
        sv._pairings["theirs"] = ("other", time.monotonic() + 60)
        with on_the_lan():
            token = self.post("/api/pair", {})[2]["url"].split("t=")[1]
        self.assertEqual(self.post("/api/pair", {"revoke": True})[:3:2], (200, {"ok": True}))
        self.assertEqual(list(sv._pairings), ["theirs"])
        self.assertEqual(self.request("GET", f"/pair?t={token}", ip="10.0.0.9", cookie=None)[1]["Location"], "/login")

    def test_logout_ends_the_session_in_odoo_and_here(self):
        sv._pairings.clear()
        self.addCleanup(sv._pairings.clear)
        sv._pairings["mine"] = ("sid", time.monotonic() + 60)
        odoo = ServerOdoo()
        with patch.object(sv, "new_client", odoo.factory):
            status, headers, payload = self.post("/api/logout", {})
        self.assertEqual((odoo.sessions, odoo.logouts), (["sid"], 1))
        self.assertEqual((status, payload), (200, {"ok": True}))
        self.assertIn(f"{sv.COOKIE_NAME}=; Path=/; Max-Age=0", headers["Set-Cookie"])
        self.assertNotIn("sid", sv._sessions)
        self.assertEqual(sv._pairings, {})

    def test_logout_drops_only_its_own_cached_data(self):
        cache._entries.update({("sid", None): (0, {}), ("sid", 42): (0, {}), ("other", None): (0, {})})
        with patch.object(sv, "new_client", ServerOdoo().factory):
            self.post("/api/logout", {})
        self.assertEqual(list(cache._entries), [("other", None)])

    def test_two_users_keep_their_own_state(self):
        sv._sessions["other"] = 4
        self.post("/api/state", {"muted": True, "lunch_minutes": 45})
        self.assertEqual(self.get("/api/state", cookie="other")[2]["lunch_minutes"], st.LUNCH_DEFAULT)
        self.assertFalse(self.post("/api/state", {}, cookie="other")[2]["muted"])
        self.assertTrue(self.get("/api/state")[2]["muted"])

    def test_logout_with_a_dead_or_missing_session_still_clears_the_cookie(self):
        odoo = ServerOdoo()
        odoo.logout_error = SessionExpired("caducada")
        with patch.object(sv, "new_client", odoo.factory):
            self.assertEqual(self.post("/api/logout", {})[0], 200)
            self.assertEqual(self.post("/api/logout", {}, cookie=None)[0], 200)
            os.remove(c.CONFIG_FILE)
            self.assertEqual(self.post("/api/logout", {})[0], 200)
        self.assertEqual((odoo.sessions, odoo.logouts), (["sid"], 1))

    def test_stale_pairings_are_purged_when_a_new_one_is_minted(self):
        sv._pairings.clear()
        self.addCleanup(sv._pairings.clear)
        sv._pairings["old"] = ("sid", time.monotonic() - 1)
        sv.new_pairing("sid", "https://10.0.0.2:8443/")
        self.assertNotIn("old", sv._pairings)
        self.assertEqual(len(sv._pairings), 1)

    def test_login_lockout(self):
        with patch.object(time, "monotonic", return_value=1000.0):
            for _ in range(sv.LOGIN_TRIES):
                self.login({"password": "no"})
            status, _, payload, odoo, _ = self.login({"password": "pw"})
            self.assertEqual((status, payload), (429, {"error": f"Demasiados intentos. Espera {sv.LOGIN_LOCK + 1} s"}))
            odoo.assert_not_called()
            self.login({"password": "no"}, ip="::1")
            self.assertEqual(self.login({"password": "pw"}, ip="::1")[0], 200)
            self.assertNotIn("::1", sv._login_fails)
            self.assertEqual(sv.login_wait("127.0.0.1"), sv.LOGIN_LOCK)

    def test_unreadable_body(self):
        self.assertEqual(self.post("/api/state", b"{rota")[:3:2], (400, {"error": "Cuerpo de la petición ilegible"}))
        self.assertEqual(self.post("/api/state", b"")[0], 200)
        self.assertEqual(self.post("/api/state", b'{"muted": true}garbage', length=15)[2]["muted"], True)
        self.assertEqual(self.post("/api/state", b"garbage", length=None)[0], 200)

    def test_state_writes(self):
        status, _, payload = self.post("/api/state", {"lunch_minutes": 45, "break_minutes": 10, "muted": 1})
        self.assertEqual(status, 200)
        self.assertEqual((payload["lunch_minutes"], payload["break_minutes"], payload["muted"]), (45, 10, True))
        status, _, payload = self.post("/api/state", {"break_minutes": 999})
        self.assertEqual(status, 400)
        self.assertIn("break_minutes", payload["error"])
        status, _, payload = self.post("/api/state", {"lunch_button_from": 780, "lunch_button_to": 1439})
        self.assertEqual((status, payload["lunch_button_from"], payload["lunch_button_to"]), (200, 780, 1439))
        status, _, payload = self.post("/api/state", {"lunch_button_from": 1440})
        self.assertEqual(status, 400)
        self.assertIn("lunch_button_from", payload["error"])
        status, _, payload = self.post("/api/state", {"lunch_button_to": 780, "muted": 0})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "El botón de comida tiene que aparecer antes de la hora en que desaparece")
        self.assertTrue(self.get("/api/state")[2]["muted"])
        self.assertEqual(self.post("/otro", {})[0], 404)
        self.post("/api/state", {"lunch_button_from": 600})
        self.assertEqual(self.post("/api/state", {"lunch_button_to": 700})[0], 200)

    def test_punch_errors(self):
        with patch.object(sv, "new_client", side_effect=OdooError("caído")):
            status, _, payload = self.post("/api/attendance", {"action": "checkin"})
        self.assertEqual((status, payload["error"]), (502, "Odoo: caído"))
        with patch.object(sv, "new_client", side_effect=SessionExpired("caducada")):
            self.assertEqual(self.post("/api/attendance", {"action": "checkin"})[0], 401)
        with patch.object(sv, "new_client", side_effect=RuntimeError), logged():
            self.assertEqual(self.post("/api/attendance", {"action": "checkin"})[0], 500)

    def test_a_punch_clocks_through_the_session_and_is_refused_when_the_real_state_does_not_allow_it(self):
        odoo = ServerOdoo()
        with patch.object(sv, "new_client", odoo.factory):
            self.assertEqual(
                self.post("/api/attendance", {"action": "break"})[::2], (409, {"error": "No hay fichaje abierto"})
            )
            self.assertEqual(odoo.punches, [])
            self.assertEqual(self.post("/api/attendance", {"action": "checkin"})[::2], (200, {"ok": True}))
        self.assertEqual((odoo.sessions, odoo.punches), (["sid", "sid"], [NORMAL["id"]]))
        self.assertIsNotNone(st.read_state(3)["punched_at"])


if __name__ == "__main__":
    unittest.main()
