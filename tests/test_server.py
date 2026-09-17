"""Unit tests for the HTTP side: Odoo sessions as login, the brute-force throttle and the request handler.

The handler is driven directly, without sockets: a request is a Handler built by hand with a fake
connection, headers and body, and the answer is read back from its output buffer.
"""

import http.client
import io
import json
import os
import re
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

from helpers import CONFIG, temp_state
from odoo_wrapper import client as c
from odoo_wrapper import data as dt, lan, server as sv, state as st
from odoo_wrapper.client import AccessDenied, OdooDown, OdooError, SessionExpired, TotpRequired


class SessionTest(unittest.TestCase):
    def setUp(self):
        sv._sessions.clear()
        self.addCleanup(sv._sessions.clear)

    def cookie(self, value):
        return {"Cookie": f"otra=1; {sv.COOKIE_NAME}={value}"} if value is not None else {}

    def test_the_cookie_is_read_and_sanitised(self):
        self.assertEqual(sv.session_cookie(self.cookie("abc-DEF_09")), "abc-DEF_09")
        for value in ("", "a b", "a;b", 'a"b', "ñ", None):
            self.assertEqual(sv.session_cookie(self.cookie(value)), "", value)

    def test_nothing_is_valid_without_a_configuration(self):
        with patch.object(sv, "read_config", return_value={}), patch.object(sv, "new_client") as client:
            self.assertFalse(sv.session_ok("sid"))
        client.assert_not_called()

    def test_an_unknown_session_is_checked_once_against_odoo(self):
        with patch.object(sv, "read_config", return_value={"url": "u"}), patch.object(sv, "new_client") as client:
            client.return_value.uid = 4
            self.assertFalse(sv.session_ok(""))
            self.assertTrue(sv.session_ok("sid"))
            self.assertTrue(sv.session_ok("sid"))
        client.assert_called_once_with("sid")
        client.return_value.session_info.assert_called_once()
        self.assertEqual(sv._sessions, {"sid": 4})

    def test_an_expired_session_is_refused(self):
        with patch.object(sv, "read_config", return_value={"url": "u"}), patch.object(sv, "new_client") as client:
            client.return_value.session_info.side_effect = SessionExpired("caducada")
            self.assertFalse(sv.session_ok("sid"))
        self.assertNotIn("sid", sv._sessions)

    def test_new_client_takes_the_configured_server_and_the_cached_uid(self):
        sv._sessions["sid"] = 4
        with patch.object(sv, "load_config", return_value={"url": "https://o/", "db": "db", "user": "u"}):
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


class FakeTLS:
    pass


class HandlerTest(unittest.TestCase):
    def setUp(self):
        temp_state(self)
        patcher = patch.object(lan, "_exposed", False)
        patcher.start()
        self.addCleanup(patcher.stop)
        c.save_config(**CONFIG)
        sv._sessions["sid"] = 3
        self.addCleanup(sv._sessions.clear)
        sv._login_fails.clear()
        self.addCleanup(sv._login_fails.clear)
        self.addCleanup(dt.drop_data_cache)

    def request(self, method, path, body=None, host="localhost:8931", origin=None, cookie="sid", device="",
                ip="127.0.0.1", tls=False):
        h = sv.Handler.__new__(sv.Handler)
        h.command, h.path, h.request_version = method, path, "HTTP/1.1"
        h.requestline = f"{method} {path} HTTP/1.1"
        h.client_address = (ip, 1)
        h.connection = FakeTLS() if tls else object()
        h.headers = http.client.HTTPMessage()
        cookies = [(sv.COOKIE_NAME, cookie), (sv.DEVICE_COOKIE, device)]
        for key, value in (("Host", host), ("Origin", origin), ("User-Agent", "TestBrowser/1"),
                           ("Cookie", "; ".join(f"{name}={value}" for name, value in cookies if value) or None)):
            if value is not None:
                h.headers[key] = value
        raw = b"" if body is None else body if isinstance(body, bytes) else json.dumps(body).encode()
        h.headers["Content-Length"] = str(len(raw))
        h.rfile, h.wfile = io.BytesIO(raw), io.BytesIO()
        with patch.object(sv, "ssl", SimpleNamespace(SSLSocket=FakeTLS)):
            getattr(h, "do_" + method)()
        head, _, payload = h.wfile.getvalue().partition(b"\r\n\r\n")
        status = int(head.split(b" ")[1])
        headers = {}
        for key, value in (line.decode().split(": ", 1) for line in head.split(b"\r\n")[1:]):
            headers[key] = f"{headers[key]}\n{value}" if key in headers else value
        return status, headers, payload

    def get(self, path, **kw):
        status, headers, payload = self.request("GET", path, **kw)
        return status, headers, json.loads(payload) if headers["Content-Type"].startswith("application/json") else payload

    def post(self, path, body, **kw):
        status, headers, payload = self.request("POST", path, body, **kw)
        return status, headers, json.loads(payload)

    def test_pages_and_assets(self):
        for path, marker, ctype in (("/", b"<html", "text/html"), ("/index.html", b"<html", "text/html"),
                                    ("/style.css", b":root", "text/css"), ("/js/app.js", b"function", "text/javascript"),
                                    ("/js/render.js", b"function renderHero", "text/javascript"),
                                    ("/manifest.json", b'"start_url"', "application/manifest+json"),
                                    ("/icon.svg", b"<svg", "image/svg+xml")):
            status, headers, payload = self.get(path)
            self.assertEqual(status, 200, path)
            self.assertIn(marker, payload)
            self.assertTrue(headers["Content-Type"].startswith(ctype), path)
            self.assertEqual(headers["X-Frame-Options"], "DENY")
            self.assertEqual(headers["Cache-Control"], "no-store")
        for path in ("/js/nada.js", "/js/../server.py", "/js/", "/app.js"):
            self.assertEqual(self.get(path)[0], 404, path)

    def test_the_page_is_installable(self):
        manifest = json.loads(self.get("/manifest.json")[2])
        self.assertEqual(manifest["start_url"], "/")
        self.assertEqual(manifest["display"], "standalone")
        for cookie in (None, "sid"):
            self.assertIn(b'rel="manifest"', self.get("/", cookie=cookie)[2])

    def test_the_page_loads_every_script_and_nothing_else(self):
        page = self.get("/")[2].decode()
        tags = re.findall(r'<script[^>]*>', page)
        self.assertEqual(tags, ['<script type="module" src="/js/app.js">'])
        sources = {}
        for name in os.listdir(sv.SCRIPTS):
            with open(os.path.join(sv.SCRIPTS, name)) as f:
                sources[name] = f.read()
        for name in sources:
            if name == "app.js":
                continue
            self.assertTrue(
                any(re.search(rf'from "\./{re.escape(name)}"', src) for src in sources.values()), name)

    def test_login_page_without_a_session_cookie(self):
        self.assertIn(b"Introduce tu usuario", self.get("/", cookie=None)[2])
        self.assertIn(b"Introduce tu usuario", self.get("/", cookie="a b")[2])
        self.assertNotIn(b"Introduce tu usuario", self.get("/")[2])
        self.assertIn(b"Introduce tu usuario", self.get("/login")[2])

    def test_foreign_host_or_origin_is_refused(self):
        self.assertEqual(self.get("/", host="evil.com")[0], 403)
        self.assertEqual(self.post("/api/state", {}, origin="https://evil.example")[0], 403)
        self.assertEqual(self.post("/api/state", {}, origin="http://localhost:8931")[0], 200)
        self.assertEqual(self.get("/nada")[0], 404)

    def test_version_state_and_data(self):
        self.assertIn("version", self.get("/api/version", cookie=None)[2])
        self.assertEqual(self.get("/api/state")[2]["lunch_minutes"], st.LUNCH_DEFAULT)
        with patch.object(dt, "fetch_data", return_value={"sessions": []}) as fetch:
            status, _, payload = self.get("/api/data?fresh")
            self.assertEqual(status, 200)
            self.assertEqual(payload["state"]["break_minutes"], st.BREAK_DEFAULT)
            self.assertIsNone(payload["phone"])
            self.assertEqual((fetch.call_args.args[0].session_id, fetch.call_args.kwargs), ("sid", {"fresh": True}))
            self.get("/api/data")
            self.assertEqual(fetch.call_args.kwargs, {"fresh": False})

    def test_config_shows_the_server_only_to_loopback(self):
        self.assertEqual(self.get("/api/config", cookie=None)[2], dict(CONFIG, configured=True, local=True))
        self.assertEqual(self.get("/api/config", cookie=None, ip="10.0.0.9")[2], {"configured": True, "local": False})
        os.remove(c.CONFIG_FILE)
        self.assertEqual(self.get("/api/config", cookie=None)[2], {"url": "", "db": "", "user": "", "configured": False, "local": True})

    def test_data_errors(self):
        with patch.object(dt, "fetch_data", side_effect=OdooError("caído")):
            status, _, payload = self.get("/api/data")
        self.assertEqual((status, payload["error"]), (502, "Odoo: caído"))
        with patch.object(dt, "fetch_data", side_effect=OdooDown("Odoo no responde (Connection refused)")):
            status, _, payload = self.get("/api/data")
        self.assertEqual((status, payload["error"]), (502, "Odoo no responde (Connection refused)"))
        with patch.object(dt, "fetch_data", side_effect=RuntimeError), redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()):
            self.assertEqual(self.get("/api/data")[0], 500)

    def test_an_expired_session_is_forgotten_and_the_cookie_cleared(self):
        with patch.object(dt, "fetch_data", side_effect=SessionExpired("caducada")):
            status, headers, payload = self.get("/api/data")
        self.assertEqual((status, payload["error"]), (401, "caducada"))
        self.assertIn(f"{sv.COOKIE_NAME}=; Path=/; Max-Age=0;", headers["Set-Cookie"])
        self.assertNotIn("sid", sv._sessions)

    def test_api_needs_a_session_everywhere(self):
        for ip in ("127.0.0.1", "10.0.0.9"):
            self.assertEqual(self.get("/api/state", ip=ip, cookie=None)[0], 401)
            self.assertEqual(self.get("/api/data", ip=ip, cookie=None)[0], 401)
            self.assertEqual(self.post("/api/state", {}, ip=ip, cookie=None)[0], 401)
        with patch.object(sv, "new_client") as client:
            client.return_value.session_info.side_effect = SessionExpired("no")
            self.assertEqual(self.get("/api/state", cookie="unknown")[0], 401)
            client.return_value.session_info.side_effect = OdooError("caído")
            self.assertEqual(self.get("/api/state", cookie="unknown")[0], 502)
            client.return_value.session_info.side_effect = None
            self.assertEqual(self.get("/api/state", cookie="unknown")[0], 200)
        self.assertIn("unknown", sv._sessions)

    def login(self, body, totp=False, **kw):
        with patch.object(sv, "OdooClient") as odoo, patch.object(time, "sleep") as sleep:
            odoo.return_value.session_id = "fresh"
            odoo.return_value.device = "dev2" if totp else ""
            odoo.return_value.login.side_effect = (
                TotpRequired("código") if totp and not body.get("code")
                else None if body.get("password") == "pw" else AccessDenied("Usuario o contraseña incorrectos"))
            status, headers, payload = self.post("/api/login", body, cookie=None, **kw)
        return status, headers, payload, odoo, sleep

    def test_login(self):
        status, _, payload, odoo, sleep = self.login({"user": "ana", "password": "no"})
        self.assertEqual((status, payload["error"]), (401, "Usuario o contraseña incorrectos"))
        sleep.assert_called_once_with(sv.LOGIN_PENALTY)
        odoo.assert_called_once_with("https://odoo.example", "db", device="")
        self.assertEqual(c.read_config()["user"], "u")
        status, headers, _, odoo, _ = self.login({"user": "ana", "password": "pw"}, tls=True)
        self.assertEqual(status, 200)
        odoo.return_value.login.assert_called_once_with("ana", "pw", "")
        self.assertEqual(odoo.return_value.user_agent, "TestBrowser/1")
        self.assertEqual(headers["Set-Cookie"].count("\n"), 0)
        self.assertIn(f"{sv.COOKIE_NAME}=fresh; Path=/; Max-Age={sv.COOKIE_MAX_AGE[sv.COOKIE_NAME]}; HttpOnly", headers["Set-Cookie"])
        self.assertIn("; Secure", headers["Set-Cookie"])
        self.assertEqual(c.read_config()["user"], "ana")
        self.assertEqual(self.get("/api/state", ip="10.0.0.9", cookie="fresh")[0], 200)
        self.assertNotIn("Secure", self.login({"password": "pw"})[1]["Set-Cookie"])

    def test_login_is_loopback_only(self):
        status, _, payload, odoo, _ = self.login({"user": "ana", "password": "pw"}, ip="10.0.0.9")
        self.assertEqual(status, 403)
        self.assertIn("empareja desde el ordenador", payload["error"])
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
        self.assertEqual(device, f"{sv.DEVICE_COOKIE}=dev2; Path=/; Max-Age={sv.COOKIE_MAX_AGE[sv.DEVICE_COOKIE]}; HttpOnly; SameSite=Lax")

    def test_login_falls_back_to_the_configured_user(self):
        _, _, _, odoo, _ = self.login({"password": "pw"})
        odoo.return_value.login.assert_called_once_with("u", "pw", "")

    def test_login_may_point_at_another_server(self):
        body = {"url": "https://other.example/", "db": "x", "user": "ana", "password": "pw"}
        _, _, _, odoo, _ = self.login(body)
        odoo.assert_called_once_with("https://other.example/", "x", device="")
        self.assertEqual(c.read_config(), {"url": "https://other.example", "db": "x", "user": "ana"})

    def test_first_run_needs_the_server(self):
        os.remove(c.CONFIG_FILE)
        status, _, payload, odoo, _ = self.login({"user": "ana", "password": "pw"})
        self.assertEqual(status, 409)
        self.assertIn("Configura Odoo primero", payload["error"])
        odoo.assert_not_called()
        status, _, _, _, _ = self.login({"url": "https://o", "db": "db", "user": "ana", "password": "pw"})
        self.assertEqual(status, 200)
        self.assertEqual(c.read_config(), {"url": "https://o", "db": "db", "user": "ana"})

    def test_pairing_hands_the_laptop_session_to_the_phone(self):
        self.assertEqual(self.post("/api/pair", {}, cookie=None)[0], 401)
        self.assertEqual(self.post("/api/pair", {}, ip="10.0.0.9")[0], 403)
        self.assertEqual(self.post("/api/pair", {})[0], 409)
        with patch.object(lan, "_exposed", True), patch.object(lan, "lan_ip", return_value="10.0.0.2"), \
                patch.object(lan, "bonjour_name", return_value="mac.local"):
            status, _, ip_pair = self.post("/api/pair", {})
            _, _, name_pair = self.post("/api/pair", {"name": True})
        self.assertEqual((status, ip_pair["expires_in"]), (200, sv.PAIR_TTL))
        self.assertTrue(ip_pair["url"].startswith("https://10.0.0.2:8443/pair?t="))
        self.assertTrue(name_pair["url"].startswith("https://mac.local:8443/pair?t="))
        self.assertTrue(ip_pair["qr"].startswith("<svg"))
        token = ip_pair["url"].split("t=")[1]
        status, headers, _ = self.request("GET", f"/pair?t={token}", host="10.0.0.2:8443", ip="10.0.0.9", cookie=None, tls=True)
        self.assertEqual((status, headers["Location"]), (303, "/"))
        self.assertIn(f"{sv.COOKIE_NAME}=sid; Path=/; Max-Age={sv.COOKIE_MAX_AGE[sv.COOKIE_NAME]}; HttpOnly; SameSite=Lax; Secure", headers["Set-Cookie"])
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
        with patch.object(lan, "_exposed", True), patch.object(lan, "lan_ip", return_value="10.0.0.2"):
            token = self.post("/api/pair", {})[2]["url"].split("t=")[1]
        self.assertEqual(self.post("/api/pair", {"revoke": True})[2], {"ok": True})
        self.assertEqual(list(sv._pairings), ["theirs"])
        self.assertEqual(self.request("GET", f"/pair?t={token}", ip="10.0.0.9", cookie=None)[1]["Location"], "/login")

    def test_stale_pairings_are_purged_when_a_new_one_is_minted(self):
        sv._pairings.clear()
        self.addCleanup(sv._pairings.clear)
        sv._pairings["old"] = ("sid", time.monotonic() - 1)
        sv.new_pairing("sid", "https://10.0.0.2:8443/")
        self.assertNotIn("old", sv._pairings)
        self.assertEqual(len(sv._pairings), 1)

    def test_login_lockout(self):
        for _ in range(sv.LOGIN_TRIES):
            self.login({"password": "no"})
        status, _, payload, odoo, _ = self.login({"password": "pw"})
        self.assertEqual(status, 429)
        self.assertIn("Espera", payload["error"])
        odoo.assert_not_called()

    def test_unreadable_body(self):
        self.assertEqual(self.post("/api/state", b"{rota")[0], 400)
        self.assertEqual(self.post("/api/state", b"")[0], 200)

    def test_state_writes(self):
        status, _, payload = self.post("/api/state", {"lunch_minutes": 45, "break_minutes": 10, "muted": 1})
        self.assertEqual(status, 200)
        self.assertEqual((payload["lunch_minutes"], payload["break_minutes"], payload["muted"]), (45, 10, True))
        status, _, payload = self.post("/api/state", {"break_minutes": 999})
        self.assertEqual(status, 400)
        self.assertIn("break_minutes", payload["error"])
        self.assertEqual(self.post("/otro", {})[0], 404)

    def test_punch_errors(self):
        with patch.object(sv, "new_client", side_effect=OdooError("caído")):
            status, _, payload = self.post("/api/attendance", {"action": "checkin"})
        self.assertEqual((status, payload["error"]), (502, "Odoo: caído"))
        with patch.object(sv, "new_client", side_effect=SessionExpired("caducada")):
            self.assertEqual(self.post("/api/attendance", {"action": "checkin"})[0], 401)
        with patch.object(sv, "new_client", side_effect=RuntimeError), redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()):
            self.assertEqual(self.post("/api/attendance", {"action": "checkin"})[0], 500)

    def test_attendance_dispatches_to_data_punch(self):
        with patch.object(dt, "punch", return_value=(409, {"error": "x"})) as punch:
            status, _, payload = self.post("/api/attendance", {"action": "break"})
        self.assertEqual((status, payload), (409, {"error": "x"}))
        client, action = punch.call_args.args
        self.assertEqual((client.session_id, action), ("sid", "break"))


if __name__ == "__main__":
    unittest.main()
