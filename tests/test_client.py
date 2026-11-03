"""Unit tests for the Odoo client and the connection config. The HTTP layer is replaced by a scripted opener."""

import http.client
import io
import json
import os
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

from helpers import (
    CONFIG,
    DEVICE_HEADER,
    EMPLOYEE,
    REST,
    ROTATED_HEADER,
    SESSION_HEADER,
    TOTP_PAGE,
    client,
    kw,
    logged,
    temp_state,
    utc,
)

from odoo_wrapper import client as c


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.home = temp_state(self)

    def write(self, path, text):
        with open(path, "w") as f:
            f.write(text)

    def test_nothing_configured(self):
        self.assertEqual(c.read_config(), {})
        with self.assertRaises(c.OdooError) as caught:
            c.load_config()
        self.assertEqual(
            str(caught.exception), "Falta configurar Odoo. Inicia sesión con `odoo login` o desde el dashboard"
        )

    def test_save_and_load(self):
        c.save_config("https://odoo.example/", "db", "u")
        self.assertEqual(c.load_config(), CONFIG)
        self.assertEqual(oct(os.stat(c.CONFIG_FILE).st_mode & 0o777), "0o600")
        self.assertEqual(os.listdir(self.home), ["config.json"])
        c.save_config("https://odoX/", "db", "u")
        self.assertEqual(c.load_config()["url"], "https://odoX")

    def test_junk_or_incomplete_config_counts_as_none_and_says_why(self):
        cases = {
            "{roto": f"{c.CONFIG_FILE} no es JSON: se toma como sin configurar hasta el próximo inicio de sesión (",
            "[]": "(falta url, db, user)",
            '{"url": "x", "db": "y"}': f"{c.CONFIG_FILE} está incompleto: se toma como sin configurar hasta el próximo"
            " inicio de sesión (falta user)",
            '{"url": "", "db": "y", "user": "u"}': "(falta url)",
        }
        for text, said in cases.items():
            self.write(c.CONFIG_FILE, text)
            with patch.object(c, "_degraded", set()), logged() as out:
                self.assertEqual(c.read_config(), {}, text)
            self.assertIn(said, out.getvalue())
            self.assertTrue(out.getvalue().startswith("WARNING "), text)

    def test_a_missing_config_is_the_first_run_and_says_nothing(self):
        with patch.object(c, "_degraded", set()), logged() as out:
            self.assertEqual(c.read_config(), {})
        self.assertEqual(out.getvalue(), "")

    def test_a_private_file_that_is_there_but_cannot_be_read_raises(self):
        os.mkdir(c.CONFIG_FILE)
        with self.assertRaises(IsADirectoryError):
            c.read_private(c.CONFIG_FILE)

    def test_private_files_replace_atomically(self):
        path = os.path.join(self.home, "secret")
        c.write_private(path, "one")
        c.write_private(path, "two\n")
        self.assertEqual(c.read_private(path), "two")
        self.assertEqual(c.read_private(os.path.join(self.home, "missing")), "")
        self.assertEqual(sorted(os.listdir(self.home)), ["secret"])
        with patch.object(c, "STATE_DIR", os.path.join(self.home, "new")):
            c.write_private(os.path.join(c.STATE_DIR, "secret"), "x")
            self.assertEqual(oct(os.stat(c.STATE_DIR).st_mode & 0o777), "0o700")


class RpcTest(unittest.TestCase):
    def test_login_posts_the_credentials_and_keeps_the_session(self):
        odoo = client({"result": {"uid": 9}, "cookies": ["other=1; Path=/", SESSION_HEADER]}, session_id="")
        self.assertEqual(odoo.login("u", "p"), "abc123")
        url, params, cookie = odoo.opener.calls[0]
        self.assertEqual(url, "https://odoo.example/web/session/authenticate")
        self.assertEqual(params, {"db": "db", "login": "u", "password": "p"})
        self.assertIsNone(cookie)
        self.assertEqual((odoo.uid, odoo.session_id), (9, "abc123"))

    def test_login_without_a_cookie_fails(self):
        with self.assertRaises(c.OdooError) as caught:
            client({"result": {"uid": 9}}).login("u", "p")
        self.assertEqual(str(caught.exception), "Autenticación fallida: Odoo no devolvió una sesión")

    def test_a_cookie_value_keeps_its_own_equals_signs(self):
        headers = http.client.HTTPMessage()
        headers["Set-Cookie"] = "td_id=a=b; Path=/"
        self.assertEqual(c.set_cookies(headers), {"td_id": "a=b"})

    def test_a_trusted_device_skips_the_code(self):
        odoo = client(
            {"result": {}, "cookies": [SESSION_HEADER]},
            {"status": 303, "cookies": [ROTATED_HEADER]},
            {"result": {"uid": 9}},
            session_id="",
        )
        odoo.device = "dev1"
        self.assertEqual(odoo.login("u", "p"), "rotated")
        url, fields, cookie = odoo.opener.calls[1]
        self.assertEqual(
            (url, fields, cookie), ("https://odoo.example/web/login/totp", None, "session_id=abc123; td_id=dev1")
        )
        self.assertEqual(odoo.opener.calls[2][2], "session_id=rotated")
        self.assertEqual((odoo.uid, odoo.device), (9, "dev1"))

    def test_the_code_is_asked_for_and_the_device_remembered(self):
        odoo = client(
            {"result": {}, "cookies": [SESSION_HEADER]},
            {"page": TOTP_PAGE},
            {"status": 303, "cookies": [ROTATED_HEADER, DEVICE_HEADER]},
            {"result": {"uid": 9}},
            session_id="",
        )
        with self.assertRaises(c.TotpRequired) as caught:
            odoo.login("u", "p")
        self.assertEqual(str(caught.exception), "Odoo pide el código de verificación en dos pasos")
        self.assertEqual(odoo.opener.calls[1][2], "session_id=abc123")
        self.assertEqual(odoo.login_totp("123 456"), "rotated")
        self.assertEqual(odoo.opener.calls[2][1], {"totp_token": "123 456", "csrf_token": "tok1", "remember": "1"})
        self.assertEqual((odoo.uid, odoo.session_id, odoo.device), (9, "rotated", "dev2"))

    def test_login_with_the_code_in_hand(self):
        odoo = client(
            {"result": {}, "cookies": [SESSION_HEADER]},
            {"page": TOTP_PAGE},
            {"status": 303, "cookies": [ROTATED_HEADER, DEVICE_HEADER]},
            {"result": {"uid": 9}},
            session_id="",
        )
        self.assertEqual(odoo.login("u", "p", "123456"), "rotated")
        self.assertEqual(odoo.opener.calls[2][1]["totp_token"], "123456")

    def test_a_wrong_code_is_access_denied(self):
        odoo = client(
            {"result": {}, "cookies": [SESSION_HEADER]}, {"page": TOTP_PAGE}, {"page": TOTP_PAGE}, session_id=""
        )
        with self.assertRaises(c.AccessDenied) as caught:
            odoo.login("u", "p", "000000")
        self.assertEqual(str(caught.exception), "Código de verificación incorrecto")
        self.assertEqual(len(odoo.opener.calls), 3)

    def test_a_bounce_or_a_missing_form_fails_the_login(self):
        for answer in ({"status": 303}, {"page": "<html>sin formulario</html>"}):
            with self.assertRaises(c.OdooError) as caught:
                client({"result": {}, "cookies": [SESSION_HEADER]}, answer, session_id="").login("u", "p")
            self.assertEqual(
                str(caught.exception), "Autenticación fallida: Odoo no devolvió el formulario de verificación"
            )

    def test_redirects_are_kept_not_followed(self):
        handler = c.KeepRedirects()
        for method in ("http_error_301", "http_error_302", "http_error_303", "http_error_307", "http_error_308"):
            self.assertEqual(getattr(handler, method)(None, "response", 303, "", {}), "response")
        opener = c.OdooClient("https://odoo.example", "db").opener
        self.assertEqual(
            [type(h) for h in opener.handlers if isinstance(h, urllib.request.HTTPRedirectHandler)], [c.KeepRedirects]
        )

    def test_wrong_credentials_are_access_denied(self):
        error = {"error": {"code": 200, "data": {"name": "odoo.exceptions.AccessDenied", "message": "Access Denied"}}}
        with self.assertRaises(c.AccessDenied) as caught:
            client(error).login("u", "p")
        self.assertEqual(str(caught.exception), "Usuario o contraseña incorrectos")

    def test_calls_carry_the_session_cookie(self):
        odoo = client(kw([1]))
        odoo.call_kw("hr.x", "search_read", [[]])
        self.assertEqual(odoo.opener.calls[0][2], "session_id=sid")

    def test_an_expired_session_is_its_own_error(self):
        with self.assertRaises(c.SessionExpired) as caught:
            client({"error": {"code": 100, "message": "Odoo Session Expired"}}).call_kw("m", "read", [])
        self.assertEqual(str(caught.exception), "La sesión de Odoo ha caducado")

    def test_server_errors_carry_the_message(self):
        with self.assertRaises(c.OdooError) as caught:
            client({"error": {"data": {"message": "sin permiso"}}}).call_kw("m", "read", [])
        self.assertEqual(str(caught.exception), "sin permiso")
        with self.assertRaises(c.OdooError) as caught:
            client({"error": {"code": 500}}).call_kw("m", "read", [])
        self.assertIn("500", str(caught.exception))

    def test_a_network_failure_is_odoo_down(self):
        odoo = client()
        with (
            patch.object(odoo.opener, "open", side_effect=urllib.error.URLError("Connection refused")),
            self.assertRaises(c.OdooDown) as caught,
        ):
            odoo.call_kw("m", "read", [])
        self.assertEqual(str(caught.exception), "Odoo no responde (Connection refused)")

    def test_a_non_json_response_is_odoo_down(self):
        odoo = client()
        garbled = io.BytesIO(b"<html>Bad Gateway</html>")
        garbled.headers = http.client.HTTPMessage()
        with patch.object(odoo.opener, "open", return_value=garbled), self.assertRaises(c.OdooDown) as caught:
            odoo.call_kw("m", "read", [])
        self.assertEqual(str(caught.exception), "Odoo no responde (respuesta no válida)")

    def test_each_request_is_a_json_rpc_call_and_the_form_names_its_browser(self):
        odoo = client({"result": None}, {"page": TOTP_PAGE})
        sent = []
        record = odoo.opener.open
        odoo.opener.open = lambda req: sent.append(req) or record(req)
        odoo.jsonrpc("/x", {"a": 1})
        odoo.form()
        self.assertEqual(json.loads(sent[0].data), {"jsonrpc": "2.0", "method": "call", "params": {"a": 1}, "id": 1})
        self.assertEqual(sent[1].get_header("User-agent"), c.USER_AGENT)

    def test_a_new_client_trims_the_url_and_knows_nothing_yet(self):
        odoo = c.OdooClient("https://odoX/", "db", "sid", device="dev")
        self.assertEqual(
            (odoo.url, odoo.device, odoo.uid, odoo.employee_id, odoo.employee_name, odoo.calendar_id),
            ("https://odoX", "dev", None, None, None, None),
        )
        self.assertEqual(c.OdooClient("https://odoX", "db").session_id, "")

    def test_call_kw_shape(self):
        odoo = client(kw([1]))
        self.assertEqual(odoo.call_kw("hr.x", "search_read", [[]]), [1])
        _, params, _ = odoo.opener.calls[0]
        self.assertEqual(params, {"model": "hr.x", "method": "search_read", "args": [[]], "kwargs": {}})

    def test_session_info_sets_the_uid(self):
        odoo = client({"result": {"uid": 4, "username": "u"}})
        self.assertEqual(odoo.session_info()["username"], "u")
        self.assertEqual(odoo.uid, 4)

    def test_sees_others_asks_for_one_attendance_of_someone_else(self):
        odoo = client(kw([12]))
        self.assertTrue(odoo.sees_others())
        _, params, _ = odoo.opener.calls[0]
        self.assertEqual(params["args"], [[["employee_id.user_id", "!=", 3]]])
        self.assertEqual(params["kwargs"], {"limit": 1})
        odoo = client({"result": {"uid": 9}}, kw([]))
        odoo.uid = None
        self.assertFalse(odoo.sees_others())
        self.assertEqual(odoo.opener.calls[1][1]["args"], [[["employee_id.user_id", "!=", 9]]])

    def test_edits_punches_asks_odoo_for_write_create_and_unlink_on_attendances(self):
        odoo = client(kw(True), kw(True), kw(True))
        self.assertTrue(odoo.edits_punches())
        self.assertEqual(
            [(p["model"], p["method"], p["args"]) for _, p, _ in odoo.opener.calls],
            [("hr.attendance", "check_access_rights", [op]) for op in ("write", "create", "unlink")],
        )
        self.assertFalse(client(kw(True), kw(False)).edits_punches())
        self.assertFalse(client(kw(True), kw(True), kw(False)).edits_punches())
        refused = {"error": {"code": 200, "message": "Odoo Server Error", "data": {"message": "no"}}}
        with patch.object(c, "_degraded", set()), logged() as out:
            self.assertFalse(client(refused).edits_punches())
            self.assertFalse(client(refused).edits_punches())
        self.assertEqual(
            out.getvalue(),
            "WARNING Odoo no deja comprobar si puedes corregir fichajes: el diálogo del día queda de solo lectura"
            " (no)\n",
        )
        with self.assertRaises(c.SessionExpired):
            client({"error": {"code": 100}}).edits_punches()

    def test_what_the_tools_go_without_is_logged_once_per_thing(self):
        with patch.object(c, "_degraded", set()), logged() as out:
            c.degrade("Falta algo: se sigue sin ello", OSError("no"))
            c.degrade("Falta algo: se sigue sin ello", OSError("otra vez"))
            c.degrade("Falta otra cosa: también", ValueError("x"))
        self.assertEqual(
            out.getvalue(), "WARNING Falta algo: se sigue sin ello (no)\nWARNING Falta otra cosa: también (x)\n"
        )

    def test_logout_destroys_the_session(self):
        odoo = client({"result": None})
        odoo.logout()
        self.assertTrue(odoo.opener.calls[0][0].endswith("/web/session/destroy"))

    def test_the_requests_sent_to_odoo_are_exactly_these(self):
        odoo = client(
            {"result": {"uid": 3}},
            kw([1]),
            kw(True),
            kw(True),
            kw(True),
            kw([EMPLOYEE]),
            kw([{"id": 1, "check_in": utc(5)}]),
            kw([{"attendance_reason_ids": [3]}]),
            kw([EMPLOYEE]),
            {"result": {}},
            {"result": {}},
            kw([REST]),
            kw({}),
            {"result": None},
        )
        odoo.session_info()
        odoo.sees_others()
        odoo.edits_punches()
        odoo.open_is_rest(odoo.open_attendance(), REST)
        odoo.load_other(7)
        odoo.punch(5)
        odoo.punch()
        odoo.attendance_reasons()
        odoo.field_named("hr.employee", "discord")
        odoo.logout()

        def call(model, method, args, kwargs):
            return "/web/dataset/call_kw", {"model": model, "method": method, "args": args, "kwargs": kwargs}

        self.assertEqual(
            [(url.removeprefix("https://odoo.example"), params) for url, params, _ in odoo.opener.calls],
            [
                ("/web/session/get_session_info", {}),
                call("hr.attendance", "search", [[["employee_id.user_id", "!=", 3]]], {"limit": 1}),
                *[
                    call("hr.attendance", "check_access_rights", [op], {"raise_exception": False})
                    for op in ("write", "create", "unlink")
                ],
                call(
                    "hr.employee",
                    "search_read",
                    [[["user_id", "=", 3]]],
                    {"fields": ["id", "name", "resource_calendar_id"], "limit": 1},
                ),
                call(
                    "hr.attendance",
                    "search_read",
                    [[["employee_id", "=", 7], ["check_out", "=", False]]],
                    {"fields": ["id", "check_in"], "limit": 1},
                ),
                call("hr.attendance", "search_read", [[["id", "=", 1]]], {"fields": ["attendance_reason_ids"]}),
                call("hr.employee", "read", [[7], ["name", "resource_calendar_id"]], {}),
                ("/hr_attendance/systray_check_in_out", {"attendance_reason_id": 5}),
                ("/hr_attendance/systray_check_in_out", {}),
                call(
                    "hr.attendance.reason",
                    "search_read",
                    [[]],
                    {"fields": ["name", "is_rest", "action_type", "show_on_attendance_screen"]},
                ),
                call("hr.employee", "fields_get", [], {"attributes": ["string"]}),
                ("/web/session/destroy", {}),
            ],
        )


class EmployeeTest(unittest.TestCase):
    def test_loads_once(self):
        odoo = client(kw([EMPLOYEE]))
        odoo.load_employee()
        odoo.load_employee()
        self.assertEqual((odoo.employee_id, odoo.employee_name), (7, "Ana"))
        self.assertEqual(len(odoo.opener.calls), 1)

    def test_asks_odoo_for_the_uid_when_unknown(self):
        odoo = client({"result": {"uid": 4}}, kw([EMPLOYEE]))
        odoo.uid = None
        odoo.load_employee()
        self.assertEqual(odoo.opener.calls[1][1]["args"], [[["user_id", "=", 4]]])

    def test_load_other_reads_that_employee(self):
        odoo = client(kw([{"id": 9, "name": "Bea", "resource_calendar_id": False}]))
        odoo.load_other(9)
        self.assertEqual((odoo.employee_id, odoo.employee_name, odoo.calendar_id), (9, "Bea", None))
        _, params, _ = odoo.opener.calls[0]
        self.assertEqual(
            (params["model"], params["method"], params["args"]),
            ("hr.employee", "read", [[9], ["name", "resource_calendar_id"]]),
        )

    def test_no_employee(self):
        with self.assertRaises(c.OdooError) as caught:
            client(kw([])).load_employee()
        self.assertEqual(str(caught.exception), "No se encontró empleado asociado a tu usuario")

    def test_the_open_attendance_is_the_unclosed_one_or_none(self):
        odoo = client(kw([EMPLOYEE]), kw([{"id": 1, "check_in": utc(5)}]), kw([]))
        self.assertEqual(odoo.open_attendance()["id"], 1)
        self.assertIsNone(odoo.open_attendance())

    def test_open_is_rest_reads_the_reasons_of_the_open_attendance(self):
        odoo = client(kw([{"attendance_reason_ids": [3]}]), kw([{"attendance_reason_ids": [5]}]))
        self.assertTrue(odoo.open_is_rest({"id": 1}, REST))
        self.assertFalse(odoo.open_is_rest({"id": 1}, REST))
        self.assertEqual(odoo.opener.calls[-1][1]["args"][0], [["id", "=", 1]])
        self.assertFalse(odoo.open_is_rest(None, REST))
        self.assertFalse(odoo.open_is_rest({"id": 1}, None))
        self.assertEqual(len(odoo.opener.calls), 2)

    def test_load_employee_keeps_the_calendar(self):
        odoo = client(kw([EMPLOYEE]))
        odoo.load_employee()
        self.assertEqual(odoo.calendar_id, 4)
        odoo = client(kw([{**EMPLOYEE, "resource_calendar_id": False}]))
        odoo.load_employee()
        self.assertIsNone(odoo.calendar_id)

    def test_punch_with_and_without_reason(self):
        odoo = client({"result": {"a": 1}}, {"result": {"b": 2}})
        odoo.punch(5)
        odoo.punch()
        self.assertEqual([p for _, p, _ in odoo.opener.calls], [{"attendance_reason_id": 5}, {}])

    def test_sign_in_reasons_are_the_offered_normal_and_rest_ones_read_once(self):
        rows = [
            {"id": 3, "name": "Descanso", "is_rest": True, "action_type": "sign_in", "show_on_attendance_screen": True},
            {"id": 5, "name": "Normal", "is_rest": False, "action_type": "sign_in", "show_on_attendance_screen": True},
            {"id": 8, "name": "Oculto", "is_rest": False, "action_type": "sign_in", "show_on_attendance_screen": False},
            {"id": 9, "name": "Salida", "is_rest": True, "action_type": "sign_out", "show_on_attendance_screen": True},
        ]
        odoo = client(kw(rows))
        normal, rest = odoo.sign_in_reasons()
        self.assertEqual((normal["id"], rest["id"]), (5, 3))
        self.assertEqual(odoo.sign_in_reasons(), (normal, rest))
        self.assertEqual([r["id"] for r in odoo.offered_reasons()], [5, 3])
        self.assertEqual(len(odoo.opener.calls), 1)
        self.assertEqual(client(kw([])).sign_in_reasons(), (None, None))

    def test_a_field_added_by_hand_is_found_by_its_label(self):
        odoo = client(kw({"name": {"string": "Name"}, "x_studio_discord": {"string": " Discord "}}))
        self.assertEqual(odoo.field_named("hr.employee", "discord"), "x_studio_discord")
        _, params, _ = odoo.opener.calls[0]
        self.assertEqual((params["model"], params["method"]), ("hr.employee", "fields_get"))
        self.assertIsNone(client(kw({"name": {"string": "Name"}})).field_named("hr.employee", "discord"))

    def test_reasons_are_optional(self):
        missing = {"error": {"code": 200, "data": {"name": "builtins.KeyError", "message": "hr.attendance.reason"}}}
        odoo = client(missing)
        with patch.object(c, "_degraded", set()), logged() as out:
            self.assertEqual(odoo.attendance_reasons(), [])
            self.assertEqual(odoo.sign_in_reasons(), (None, None))
        self.assertEqual(len(odoo.opener.calls), 1)
        self.assertEqual(
            out.getvalue(),
            "WARNING Odoo no da los motivos de fichaje: se ficha sin motivo y sin descansos (hr.attendance.reason)\n",
        )
        with self.assertRaises(c.SessionExpired):
            client({"error": {"code": 100}}).attendance_reasons()


if __name__ == "__main__":
    unittest.main()
