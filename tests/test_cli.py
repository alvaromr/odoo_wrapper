"""Unit tests for the attendance CLI: what each command prints and how main() dispatches."""

import io
import os
import runpy
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from unittest.mock import patch

from helpers import CONFIG, EMPLOYEE, NORMAL, REST, client, kw, temp_state, utc
from odoo_wrapper import cli
from odoo_wrapper import client as c


class CommandTest(unittest.TestCase):
    EMP = kw([EMPLOYEE])

    def run_cmd(self, odoo, command, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            getattr(cli, command)(odoo, *args)
        return out.getvalue()

    def test_status_while_checked_in(self):
        odoo = client(self.EMP, kw([{"id": 1, "check_in": utc(90)}]), kw([NORMAL]),
                      kw([{"check_in": utc(90), "check_out": False, "worked_hours": 0}]))
        out = self.run_cmd(odoo, "status")
        self.assertIn("FICHADO (entrada)", out)
        self.assertIn("(1.5h)", out)
        self.assertIn("Horas hoy: 1.50h", out)

    def test_status_on_a_break(self):
        odoo = client(self.EMP, kw([{"id": 1, "check_in": utc(10)}]), kw([NORMAL, REST]), kw([{"attendance_reason_ids": [3]}]),
                      kw([{"check_in": utc(10), "check_out": False, "worked_hours": 0}]))
        self.assertIn("FICHADO (descanso)", self.run_cmd(odoo, "status"))

    def test_status_after_checking_out(self):
        odoo = client(self.EMP, kw([]), kw([{"check_in": utc(120), "check_out": utc(60), "worked_hours": 1.0}]),
                      kw([{"check_in": utc(120), "check_out": utc(60), "worked_hours": 1.0}]))
        out = self.run_cmd(odoo, "status")
        self.assertIn("NO FICHADO", out)
        self.assertIn("Último check-out", out)
        self.assertIn("Horas hoy: 1.00h", out)

    def test_status_with_no_history(self):
        out = self.run_cmd(client(self.EMP, kw([]), kw([]), kw([])), "status")
        self.assertNotIn("Último", out)
        self.assertIn("Horas hoy: 0.00h", out)

    def test_status_queries_todays_hours_from_local_midnight(self):
        odoo = client(self.EMP, kw([]), kw([]), kw([]))
        self.run_cmd(odoo, "status")
        domain = odoo.opener.calls[-1][1]["args"][0]
        today_start = next(value for field, _, value in domain if field == "check_in")
        expected = (
            datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
            .astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        )
        self.assertEqual(today_start, expected)

    def test_toggle_in_and_out(self):
        reasons = kw([NORMAL])
        odoo = client(self.EMP, kw([]), reasons,
                      {"result": {"attendance_state": "checked_in", "attendance": {"check_in": utc(0)}, "hours_today": 2}})
        self.assertIn("CHECK-IN registrado", self.run_cmd(odoo, "toggle"))
        self.assertEqual(odoo.opener.calls[-1][1], {"attendance_reason_id": 5})
        odoo = client(self.EMP, kw([{"id": 1, "check_in": utc(60)}]), reasons,
                      {"result": {"attendance_state": "checked_out", "attendance": {"check_out": utc(0)},
                                  "hours_today": 2, "last_attendance_worked_hours": 1}})
        out = self.run_cmd(odoo, "toggle")
        self.assertIn("CHECK-OUT registrado", out)
        self.assertIn("(1.00h esta sesión)", out)
        self.assertEqual(odoo.opener.calls[-1][1], {})

    def test_toggle_with_an_unknown_state_still_reports_hours(self):
        odoo = client(self.EMP, kw([]), kw([]), {"result": {"attendance_state": "?", "hours_today": 3}})
        self.assertEqual(self.run_cmd(odoo, "toggle").strip(), "Horas hoy: 3.00h")

    def test_check_in(self):
        odoo = client(self.EMP, kw([{"id": 1, "check_in": utc(30)}]))
        self.assertIn("Ya estás fichado", self.run_cmd(odoo, "check_in"))
        odoo = client(self.EMP, kw([]), kw([NORMAL]),
                      {"result": {"attendance": {"check_in": utc(0)}, "hours_today": 0.5}})
        out = self.run_cmd(odoo, "check_in")
        self.assertIn("CHECK-IN registrado", out)
        self.assertIn("Horas hoy: 0.50h", out)

    def test_check_out(self):
        self.assertIn("No hay fichaje abierto", self.run_cmd(client(self.EMP, kw([])), "check_out"))
        odoo = client(self.EMP, kw([{"id": 1, "check_in": utc(30)}]),
                      {"result": {"attendance": {"check_out": utc(0)}, "hours_today": 4, "last_attendance_worked_hours": 0.5}})
        out = self.run_cmd(odoo, "check_out")
        self.assertIn("CHECK-OUT registrado", out)
        self.assertIn("(0.50h esta sesión)", out)

    def test_break(self):
        open_att = kw([{"id": 1, "check_in": utc(30)}])
        self.assertIn("no tiene el motivo Descanso", self.run_cmd(client(self.EMP, open_att, kw([NORMAL])), "take_break"))
        self.assertIn("No hay fichaje abierto", self.run_cmd(client(self.EMP, kw([]), kw([NORMAL, REST])), "take_break"))
        odoo = client(self.EMP, open_att, kw([NORMAL, REST]), kw([{"attendance_reason_ids": [3]}]))
        self.assertIn("Ya estás en descanso", self.run_cmd(odoo, "take_break"))
        odoo = client(self.EMP, open_att, kw([NORMAL, REST]), kw([{"attendance_reason_ids": [5]}]),
                      {"result": {"attendance": {"check_out": utc(0)}}},
                      {"result": {"attendance": {"check_in": utc(0)}, "hours_today": 3}})
        out = self.run_cmd(odoo, "take_break")
        self.assertIn("DESCANSO iniciado", out)
        self.assertIn("Horas hoy: 3.00h", out)
        self.assertEqual([call[1] for call in odoo.opener.calls[-2:]], [{}, {"attendance_reason_id": 3}])

    def test_resume(self):
        open_att = kw([{"id": 1, "check_in": utc(10)}])
        self.assertIn("No hay un descanso abierto", self.run_cmd(client(self.EMP, kw([]), kw([NORMAL, REST])), "resume"))
        odoo = client(self.EMP, open_att, kw([NORMAL, REST]), kw([{"attendance_reason_ids": [5]}]))
        self.assertIn("No hay un descanso abierto", self.run_cmd(odoo, "resume"))
        odoo = client(self.EMP, open_att, kw([NORMAL, REST]), kw([{"attendance_reason_ids": [3]}]),
                      {"result": {"attendance": {"check_out": utc(0)}, "last_attendance_worked_hours": 0.25}},
                      {"result": {"attendance": {"check_in": utc(0)}, "hours_today": 3.25}})
        out = self.run_cmd(odoo, "resume")
        self.assertIn("VUELTA del descanso", out)
        self.assertIn("(0.25h de descanso)", out)
        self.assertIn("Horas hoy: 3.25h", out)
        self.assertEqual([call[1] for call in odoo.opener.calls[-2:]], [{}, {"attendance_reason_id": 5}])

    def test_history_groups_by_day_and_counts_the_open_session(self):
        odoo = client(self.EMP, kw([
            {"check_in": "2026-03-02 10:00:00", "check_out": False, "worked_hours": 0},
            {"check_in": "2026-03-02 08:00:00", "check_out": "2026-03-02 09:00:00", "worked_hours": 1.0},
            {"check_in": "2026-02-27 08:00:00", "check_out": "2026-02-27 10:00:00", "worked_hours": 2.0},
        ]))
        out = self.run_cmd(odoo, "history", 3)
        self.assertIn("en curso", out)
        self.assertEqual(out.count("TOTAL"), 2)
        self.assertIn("TOTAL: 2.00h", out)
        self.assertIn("(1.00h)", out)

    def test_history_without_records(self):
        self.assertIn("No hay registros en los últimos 7 días", self.run_cmd(client(self.EMP, kw([])), "history"))


class MainTest(unittest.TestCase):
    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(sys, "argv", ["odoo", *argv]), redirect_stdout(out), redirect_stderr(err):
            with self.assertRaises(SystemExit) as caught:
                cli.main()
        return caught.exception.code, out.getvalue(), err.getvalue()

    def test_usage(self):
        for argv in ((), ("-h",), ("help",)):
            code, out, _ = self.run_main(*argv)
            self.assertEqual(code, 0)
            self.assertIn("Uso: odoo", out)

    def test_unknown_command(self):
        code, out, _ = self.run_main("volar")
        self.assertEqual(code, 1)
        self.assertIn("Comando desconocido: volar", out)

    def test_dispatches_each_command(self):
        for cmd, function in (("status", "status"), ("checkin", "check_in"), ("checkout", "check_out"),
                              ("toggle", "toggle"), ("break", "take_break"), ("resume", "resume"), ("history", "history")):
            with patch.object(cli, "cli_client") as odoo, patch.dict(cli.COMMANDS), \
                    patch.object(cli, function) as run, patch.object(sys, "argv", ["odoo", cmd]):
                if cmd != "history":
                    cli.COMMANDS[cmd] = run
                cli.main()
            self.assertEqual(run.call_args.args[0], odoo.return_value, cmd)

    def test_history_takes_a_number_of_days(self):
        with patch.object(cli, "cli_client") as odoo, patch.object(cli, "history") as history:
            with patch.object(sys, "argv", ["odoo", "history", "30"]):
                cli.main()
            history.assert_called_once_with(odoo.return_value, 30)
            code, _, err = self.run_main("history", "cero")
        self.assertEqual(code, 1)
        self.assertIn("ERROR: history espera un número de días", err)

    def test_odoo_errors_go_to_stderr(self):
        with patch.object(cli, "cli_client", side_effect=c.OdooError("sin configurar")):
            code, _, err = self.run_main("status")
        self.assertEqual(code, 1)
        self.assertIn("ERROR: sin configurar", err)

    def test_a_missing_or_expired_session_points_to_login(self):
        temp_state(self)
        code, _, err = self.run_main("status")
        self.assertEqual(code, 1)
        self.assertIn("odoo login", err)
        c.save_config(**CONFIG)
        _, _, err = self.run_main("status")
        self.assertIn("No hay sesión", err)
        c.write_private(cli.CLI_SESSION_FILE, "sid")
        with patch.dict(cli.COMMANDS, {"status": lambda client: (_ for _ in ()).throw(c.SessionExpired("caducada"))}):
            _, _, err = self.run_main("status")
        self.assertIn("ERROR: caducada. Ejecuta: odoo login", err)

    def test_cli_client_uses_the_saved_session(self):
        temp_state(self)
        c.save_config(**CONFIG)
        c.write_private(cli.CLI_SESSION_FILE, "sid")
        odoo = cli.cli_client()
        self.assertEqual((odoo.url, odoo.db, odoo.session_id), ("https://odoo.example", "db", "sid"))

    def test_login_asks_once_and_saves_the_session(self):
        home = temp_state(self)
        answers = iter(["https://odoo.example/", "db", "ana"])
        with patch.object(cli, "OdooClient") as odoo, patch("builtins.input", side_effect=lambda _: next(answers)), \
                patch.object(cli.getpass, "getpass", return_value="p") as getpass:
            odoo.return_value.session_id, odoo.return_value.device = "fresh", ""
            with patch.object(sys, "argv", ["odoo", "login"]), redirect_stdout(io.StringIO()) as out:
                cli.main()
        odoo.assert_called_once_with("https://odoo.example/", "db", device="")
        odoo.return_value.login.assert_called_once_with("ana", "p")
        getpass.assert_called_once()
        self.assertEqual(c.load_config(), {"url": "https://odoo.example", "db": "db", "user": "ana"})
        self.assertEqual(c.read_private(cli.CLI_SESSION_FILE), "fresh")
        self.assertEqual(oct(os.stat(cli.CLI_SESSION_FILE).st_mode & 0o777), "0o600")
        self.assertIn(home, out.getvalue())
        self.assertEqual(sorted(os.listdir(home)), ["cli_session", "config.json"])

    def test_login_asks_the_code_when_odoo_wants_one_and_keeps_the_device(self):
        home = temp_state(self)
        c.save_config(**CONFIG)
        c.write_private(cli.CLI_DEVICE_FILE, "old")
        answers = iter(["", "123456"])
        with patch.object(cli, "OdooClient") as odoo, patch("builtins.input", side_effect=lambda _: next(answers)) as ask, \
                patch.object(cli.getpass, "getpass", return_value="p"), redirect_stdout(io.StringIO()):
            odoo.return_value.session_id, odoo.return_value.device = "fresh", "dev2"
            odoo.return_value.login.side_effect = c.TotpRequired("código")
            cli.cli_login()
        odoo.assert_called_once_with("https://odoo.example", "db", device="old")
        odoo.return_value.login_totp.assert_called_once_with("123456")
        self.assertEqual(ask.call_args.args[0], "Código de verificación (2FA): ")
        self.assertEqual(c.read_private(cli.CLI_DEVICE_FILE), "dev2")
        self.assertEqual(oct(os.stat(cli.CLI_DEVICE_FILE).st_mode & 0o777), "0o600")
        self.assertEqual(sorted(os.listdir(home)), ["cli_device", "cli_session", "config.json"])

    def test_login_reuses_the_config_and_offers_the_user_as_default(self):
        temp_state(self)
        c.save_config(**CONFIG)
        with patch.object(cli, "OdooClient") as odoo, patch("builtins.input", return_value="") as ask, \
                patch.object(cli.getpass, "getpass", return_value="p"), redirect_stdout(io.StringIO()):
            odoo.return_value.session_id, odoo.return_value.device = "fresh", ""
            cli.cli_login()
        self.assertEqual(ask.call_args.args[0], "Usuario [u]: ")
        odoo.return_value.login.assert_called_once_with("u", "p")

    def test_a_failed_login_saves_nothing(self):
        temp_state(self)
        with patch.object(cli, "OdooClient") as odoo, patch("builtins.input", return_value="x"), \
                patch.object(cli.getpass, "getpass", return_value="p"):
            odoo.return_value.login.side_effect = c.AccessDenied("no")
            code, _, err = self.run_main("login")
        self.assertEqual(code, 1)
        self.assertIn("ERROR: no", err)
        self.assertEqual(c.read_config(), {})

    def test_module_entry_point(self):
        out = io.StringIO()
        with patch.object(sys, "argv", ["odoo"]), patch.dict(sys.modules), redirect_stdout(out), self.assertRaises(SystemExit):
            del sys.modules["odoo_wrapper.cli"]
            runpy.run_module("odoo_wrapper.cli", run_name="__main__")
        self.assertIn("Uso: odoo", out.getvalue())


if __name__ == "__main__":
    unittest.main()
