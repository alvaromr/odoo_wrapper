"""Unit tests for the attendance CLI: what each command prints and how main() dispatches."""

import io
import json
import os
import runpy
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, datetime, timezone
from types import SimpleNamespace
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


def day(iso, flags=(), requests=()):
    return {"date": iso, "flags": list(flags), "requests": list(requests)}


def typed(cell):
    try:
        return (datetime.strptime(cell, "%d/%m/%Y").date() - cli.SHEET_EPOCH).days
    except (TypeError, ValueError):
        return cell


class FakeSheets:
    """Stands in for sheets.Sheets with its tabs in memory; like Sheets, it stores a typed date as its serial
    number and answers a range past the last column with nothing for that row."""

    def __init__(self, spreadsheet="hoja", **tabs):
        self.id = spreadsheet
        self.tabs = {"Avisos 2026": [], "Avisos Totales": [], **tabs}
        self.appended = []

    def get(self, cells):
        tab, columns = cells.split("!")
        return [row[2:3] for row in self.tabs[tab]] if columns == "D4:D" else self.tabs[tab]

    def append(self, cells, rows):
        self.appended.append((cells, rows))
        self.tabs[cells.split("!")[0]] += [[typed(cell) for cell in row] for row in rows]


class NoticesTest(unittest.TestCase):
    TODAY = date(2026, 10, 8)
    NOW = "2026-10-08T10:00:00+02:00"
    SEPTEMBER = {"start": "2026-09-01", "stop": "2026-10-01", "generated_at": NOW, "employees": [
        {"name": "Bea", "days": [day("2026-08-31", ["open"]), day("2026-09-02", ["open", "long"], [{}]),
                                 day("2026-09-03"), day("2026-09-04", ["empty"])]},
        {"name": "Íñigo", "days": [day("2026-09-02", requests=[{}, {}]), day("2026-10-01", ["empty"])]},
    ]}
    OCTOBER = {"start": "2026-10-01", "stop": "2026-11-01", "generated_at": NOW, "employees": [
        {"name": "Íñigo", "days": [day("2026-10-02", ["empty"]), day("2026-10-08", ["long"])]},
    ]}
    SEPTEMBER_ROWS = [["Bea", "Septiembre", "02/09/2026", "Incidencia"], ["Bea", "Septiembre", "02/09/2026", "Solicitud"],
                      ["Íñigo", "Septiembre", "02/09/2026", "Solicitud"], ["Bea", "Septiembre", "04/09/2026", "Incidencia"]]
    OCTOBER_ROWS = [["Íñigo", "Octubre", "02/10/2026", "Incidencia"]]

    def setUp(self):
        temp_state(self)
        c.write_private(cli.SHEET_FILE, "hoja")

    def run_notices(self, sheets, today=TODAY, stdin=None, **payloads):
        months = {"2026-09-01": self.SEPTEMBER, "2026-10-01": self.OCTOBER, **payloads}
        out = io.StringIO()
        with patch.object(cli, "Sheets", return_value=sheets) as opened, patch.object(sys, "stdin", stdin), \
                patch.object(cli.team, "build_team", side_effect=lambda *span: months[span[3].isoformat()]) as build, \
                redirect_stdout(out):
            self.opened, self.build = opened, build
            cli.notices("odoo", today)
        return out.getvalue()

    def test_the_previous_month_is_closed_and_the_current_one_brought_up_to_yesterday(self):
        sheets = FakeSheets()
        self.assertEqual(self.run_notices(sheets), (
            "Avisos de septiembre añadidos a «Avisos 2026»: 4\n"
            "Empleados con avisos en septiembre, anotados en «Avisos Totales»: 2\n"
            "Avisos de octubre añadidos a «Avisos 2026»: 1\n"))
        self.opened.assert_called_once_with("hoja")
        self.assertEqual(sheets.appended, [
            ("Avisos 2026!B4:E", self.SEPTEMBER_ROWS),
            ("Avisos Totales!B4:D", [["Bea", 3, "Septiembre"], ["Íñigo", 1, "Septiembre"]]),
            ("Avisos 2026!B4:E", self.OCTOBER_ROWS),
        ])
        self.assertEqual([call.args for call in self.build.call_args_list], [
            ("odoo", date(2026, 8, 31), 5, date(2026, 9, 1), date(2026, 10, 1)),
            ("odoo", date(2026, 9, 28), 5, date(2026, 10, 1), date(2026, 11, 1)),
        ])

    def test_a_closed_month_is_left_alone_and_the_sheet_alone_is_enough_to_add_nothing_twice(self):
        sheets = FakeSheets()
        self.run_notices(sheets)
        os.remove(cli.WRITTEN_FILE)
        self.assertEqual(self.run_notices(sheets), "Avisos de octubre añadidos a «Avisos 2026»: 0\n")
        self.assertEqual(sheets.appended[3:], [("Avisos 2026!B4:E", [])])
        self.assertEqual(self.build.call_count, 1)

    def test_rows_the_sheet_already_has_are_left_out_whatever_else_they_carry(self):
        sheets = FakeSheets(**{
            "Avisos 2026": [["Bea", "Septiembre", 46267, "Incidencia", "Informal", "Discord"], ["Íñigo"], [],
                            ["Bea", "Septiembre", "04/09/2026", "Incidencia"]],
            "Avisos Totales": [["Zoe", 2, "Agosto"], []],
        })
        self.run_notices(sheets)
        self.assertEqual(sheets.appended[0], ("Avisos 2026!B4:E", self.SEPTEMBER_ROWS[1:]))
        self.assertEqual(sheets.appended[1], ("Avisos Totales!B4:D", [["Bea", 4, "Septiembre"], ["Íñigo", 1, "Septiembre"]]))

    def test_a_row_written_once_never_comes_back_however_the_sheet_was_changed_by_hand(self):
        self.run_notices(FakeSheets())
        rewritten = [["Ana María", "Octubre", 46300, "Solicitud"]]
        for by_hand in ([], rewritten):
            sheets = FakeSheets(**{"Avisos 2026": list(by_hand)})
            self.run_notices(sheets)
            self.assertEqual([rows for _, rows in sheets.appended], [[], [], []])
            self.assertEqual(sheets.tabs, {"Avisos 2026": by_hand, "Avisos Totales": []})

    def test_an_append_that_fails_notes_nothing_so_the_next_run_adds_it_all(self):
        broken = FakeSheets()
        broken.append = unittest.mock.Mock(side_effect=cli.SheetsError("Google no responde"))
        with self.assertRaises(cli.SheetsError):
            self.run_notices(broken)
        self.assertFalse(os.path.exists(cli.WRITTEN_FILE))
        sheets = FakeSheets()
        self.run_notices(sheets)
        self.assertEqual(len(sheets.tabs["Avisos 2026"]), 5)
        self.assertEqual(json.loads(c.read_private(cli.WRITTEN_FILE)), {"hoja": self.SEPTEMBER_ROWS + self.OCTOBER_ROWS})

    def test_each_spreadsheet_remembers_its_own_rows(self):
        self.run_notices(FakeSheets())
        other = FakeSheets("otra")
        self.run_notices(other)
        self.assertEqual(len(other.tabs["Avisos 2026"]), 5)
        self.assertEqual(sorted(json.loads(c.read_private(cli.WRITTEN_FILE))), ["hoja", "otra"])

    def test_a_memory_that_cannot_be_read_is_an_empty_one(self):
        for broken in ("no", "[1]", "7"):
            c.write_private(cli.WRITTEN_FILE, broken)
            sheets = FakeSheets()
            self.run_notices(sheets)
            self.assertEqual(len(sheets.tabs["Avisos 2026"]), 5)

    def test_january_closes_december_in_last_years_tab(self):
        december = {"start": "2026-12-01", "stop": "2027-01-01", "generated_at": "2027-01-05T10:00:00+01:00",
                    "employees": [{"name": "Bea", "days": [day("2026-12-31", ["open"])]}]}
        january = {"start": "2027-01-01", "stop": "2027-02-01", "generated_at": "2027-01-05T10:00:00+01:00",
                   "employees": [{"name": "Bea", "days": [day("2027-01-04", requests=[{}])]}]}
        sheets = FakeSheets(**{"Avisos 2027": []})
        self.run_notices(sheets, date(2027, 1, 5), **{"2026-12-01": december, "2027-01-01": january})
        self.assertEqual(sheets.appended, [
            ("Avisos 2026!B4:E", [["Bea", "Diciembre", "31/12/2026", "Incidencia"]]),
            ("Avisos Totales!B4:D", [["Bea", 1, "Diciembre"]]),
            ("Avisos 2027!B4:E", [["Bea", "Enero", "04/01/2027", "Solicitud"]]),
        ])

    def test_without_a_saved_spreadsheet_it_is_asked_for_on_a_terminal_and_refused_without_one(self):
        os.remove(cli.SHEET_FILE)
        for no_terminal in (None, io.StringIO()):
            with self.assertRaisesRegex(c.OdooError, "No hay hoja de avisos guardada"):
                self.run_notices(FakeSheets(), stdin=no_terminal)
            self.opened.assert_not_called()
            self.build.assert_not_called()
        with patch("builtins.input", return_value="https://docs.google.com/spreadsheets/d/nueva/edit") as asked:
            self.run_notices(FakeSheets("nueva"), stdin=SimpleNamespace(isatty=lambda: True))
            self.run_notices(FakeSheets("nueva"), stdin=SimpleNamespace(isatty=lambda: True))
        asked.assert_called_once_with("Dirección de la hoja de avisos: ")
        self.opened.assert_called_once_with("nueva")


class StopLoop(Exception):
    pass


class MainTest(unittest.TestCase):
    TTY = SimpleNamespace(isatty=lambda: True)

    def run_main(self, *argv, stdin=None):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(sys, "argv", ["odoo", *argv]), patch.object(sys, "stdin", stdin), \
                redirect_stdout(out), redirect_stderr(err):
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
            for days in ("cero", "0"):
                code, _, err = self.run_main("history", days)
                self.assertEqual(code, 1)
                self.assertIn(f"ERROR: history espera un número de días, no «{days}»", err)

    def test_notices_run_for_today_and_what_google_refuses_goes_to_stderr(self):
        with patch.object(cli, "cli_client") as odoo, patch.object(cli, "notices") as notices:
            with patch.object(sys, "argv", ["odoo", "notices"]):
                cli.main()
            notices.assert_called_once_with(odoo.return_value, date.today())
            notices.side_effect = cli.SheetsError("Google no responde (sin red)")
            code, _, err = self.run_main("notices")
        self.assertEqual(code, 1)
        self.assertIn("ERROR: Google no responde (sin red)", err)

    def test_sheet_remembers_the_spreadsheet_of_an_address_without_a_session(self):
        home = temp_state(self)
        code, _, err = self.run_main("sheet")
        self.assertEqual(code, 1)
        self.assertIn("ERROR: No hay hoja de avisos guardada. Ejecuta: odoo sheet", err)
        code, _, err = self.run_main("sheet", "https://example.com/hoja")
        self.assertEqual(code, 1)
        self.assertIn("«https://example.com/hoja» no es la dirección de una hoja de cálculo de Google", err)
        for argv in (["https://docs.google.com/spreadsheets/d/1mF_a-b9/edit?usp=sharing"], []):
            out = io.StringIO()
            with patch.object(sys, "argv", ["odoo", "sheet", *argv]), redirect_stdout(out):
                cli.main()
            self.assertEqual(out.getvalue(), "1mF_a-b9\n")
        self.assertEqual(os.stat(os.path.join(home, "notices_sheet")).st_mode & 0o777, 0o600)

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
            _, _, err = self.run_main("status", stdin=io.StringIO())
        self.assertIn("ERROR: caducada. Ejecuta: odoo login", err)

    def test_with_a_terminal_an_expired_session_logs_in_and_starts_over(self):
        temp_state(self)
        c.save_config(**CONFIG)
        c.write_private(cli.CLI_SESSION_FILE, "old")
        seen = []

        def status(client):
            seen.append(client.session_id)
            if client.session_id == "old":
                raise c.SessionExpired("caducada")

        with patch.dict(cli.COMMANDS, {"status": status}), patch.object(sys, "stdin", self.TTY), \
                patch.object(cli, "cli_login", side_effect=lambda: c.write_private(cli.CLI_SESSION_FILE, "fresh")), \
                patch.object(sys, "argv", ["odoo", "status"]), redirect_stdout(io.StringIO()) as out:
            cli.main()
        self.assertEqual(seen, ["old", "fresh"])
        self.assertIn("caducada. Inicia sesión para continuar.", out.getvalue())
        with patch.dict(cli.COMMANDS, {"status": status}), patch.object(cli, "cli_login") as login:
            c.write_private(cli.CLI_SESSION_FILE, "old")
            code, _, err = self.run_main("status", stdin=self.TTY)
        login.assert_called_once_with()
        self.assertEqual(code, 1)
        self.assertIn("ERROR: caducada. Ejecuta: odoo login", err)

    def test_keep_alive_pings_the_session_on_disk_whatever_odoo_answers(self):
        temp_state(self)
        answers = iter([c.SessionExpired("caducada"), OSError("sin red"), {"uid": 3}])
        seen = []

        def ping(odoo):
            seen.append(odoo.session_id)
            c.write_private(cli.CLI_SESSION_FILE, "fresh")
            answer = next(answers)
            if isinstance(answer, Exception):
                raise answer

        with patch.object(cli.OdooClient, "session_info", autospec=True, side_effect=ping), \
                patch.object(cli.time, "sleep", side_effect=StopLoop) as sleep:
            with self.assertRaises(StopLoop):
                cli.keep_alive()
            self.assertEqual(seen, [])
            c.save_config(**CONFIG)
            c.write_private(cli.CLI_SESSION_FILE, "old")
            sleep.side_effect = [None, None, StopLoop]
            with self.assertRaises(StopLoop):
                cli.keep_alive()
        self.assertEqual(seen, ["old", "fresh", "fresh"])
        sleep.assert_called_with(cli.KEEPALIVE_INTERVAL)

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
