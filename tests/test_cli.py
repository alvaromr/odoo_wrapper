"""Unit tests for the attendance CLI: what each command prints and how main() dispatches."""

import io
import json
import os
import runpy
import sys
import unittest
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from datetime import date, datetime, time, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from helpers import (
    CONFIG,
    DEVICE_HEADER,
    EMPLOYEE,
    NORMAL,
    REST,
    ROTATED_HEADER,
    SESSION_HEADER,
    TOTP_PAGE,
    ScriptedClient,
    ScriptedOpener,
    client,
    frozen,
    kw,
    temp_state,
    utc,
)

from odoo_wrapper import cli
from odoo_wrapper import client as c
from odoo_wrapper import sheets as sh

GWS_EXPORT = b'{"client_id": "cid", "client_secret": "s3cret", "refresh_token": "r3fresh"}'
FIRST_DAY, LAST_DAY = date(2026, 8, 31), date(2027, 2, 1)
STAFF = [
    {"id": 1, "name": "Bea", "resource_calendar_id": [4, "Std"], "user_id": [11, "bea"]},
    {"id": 2, "name": "Íñigo", "resource_calendar_id": [4, "Std"], "user_id": [12, "inigo"]},
]
WORKWEEK = [
    {"calendar_id": [4, "Std"], "dayofweek": str(d), "hour_from": 9.0, "hour_to": 17.0, "day_period": "morning"}
    for d in range(5)
]
WORKDAY = [(9, 17, 8.0)]


class CommandTest(unittest.TestCase):
    EMP = kw([EMPLOYEE])

    def run_cmd(self, odoo, command, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            getattr(cli, command)(odoo, *args)
        return out.getvalue()

    def hms(self, stamp):
        return cli.local_time(stamp).strftime("%H:%M:%S")

    def test_status_while_checked_in(self):
        start = utc(90)
        odoo = client(
            self.EMP,
            kw([{"id": 1, "check_in": start}]),
            kw([NORMAL]),
            kw([{"check_in": start, "check_out": False, "worked_hours": 0}]),
        )
        self.assertEqual(
            self.run_cmd(odoo, "status"),
            f"Estado: FICHADO (entrada)\nCheck-in: {self.hms(start)} (1.5h)\nHoras hoy: 1.50h\n",
        )

    def test_status_on_a_break(self):
        odoo = client(
            self.EMP,
            kw([{"id": 1, "check_in": utc(10)}]),
            kw([NORMAL, REST]),
            kw([{"attendance_reason_ids": [3]}]),
            kw([{"check_in": utc(10), "check_out": False, "worked_hours": 0}]),
        )
        self.assertIn("FICHADO (descanso)", self.run_cmd(odoo, "status"))

    def test_status_after_checking_out(self):
        done = {"check_in": utc(120), "check_out": utc(60), "worked_hours": 1.0}
        odoo = client(self.EMP, kw([]), kw([done]), kw([done]))
        self.assertEqual(
            self.run_cmd(odoo, "status"),
            f"Estado: NO FICHADO (salida)\nÚltimo check-out: {self.hms(done['check_out'])}\nHoras hoy: 1.00h\n",
        )

    def test_status_adds_every_session_of_today_and_counts_a_long_open_one_to_the_minute(self):
        odoo = client(
            self.EMP,
            kw([{"id": 1, "check_in": utc(200 * 60)}]),
            kw([NORMAL]),
            kw(
                [
                    {"check_in": utc(201 * 60), "check_out": utc(200 * 60 + 30), "worked_hours": 0.5},
                    {"check_in": utc(200 * 60 + 20), "check_out": utc(200 * 60 + 10), "worked_hours": 0.25},
                    {"check_in": utc(200 * 60), "check_out": False, "worked_hours": 0},
                ]
            ),
        )
        out = self.run_cmd(odoo, "status")
        self.assertIn("(200.0h)", out)
        self.assertIn("Horas hoy: 200.75h", out)

    def test_missing_hours_read_as_zero(self):
        open_att, reasons = kw([{"id": 1, "check_in": utc(30)}]), kw([NORMAL, REST])
        runs = [
            ("check_in", client(self.EMP, kw([]), reasons, {"result": {"attendance": {"check_in": utc(0)}}})),
            ("check_out", client(self.EMP, open_att, {"result": {"attendance": {"check_out": utc(0)}}})),
            (
                "take_break",
                client(
                    self.EMP,
                    open_att,
                    reasons,
                    kw([{"attendance_reason_ids": [5]}]),
                    {"result": {}},
                    {"result": {"attendance": {"check_in": utc(0)}}},
                ),
            ),
            (
                "resume",
                client(
                    self.EMP,
                    open_att,
                    reasons,
                    kw([{"attendance_reason_ids": [3]}]),
                    {"result": {}},
                    {"result": {"attendance": {"check_in": utc(0)}}},
                ),
            ),
            (
                "toggle",
                client(
                    self.EMP,
                    open_att,
                    reasons,
                    {"result": {"attendance_state": "checked_out", "attendance": {"check_out": utc(0)}}},
                ),
            ),
        ]
        for command, odoo in runs:
            out = self.run_cmd(odoo, command)
            self.assertIn("Horas hoy: 0.00h", out, command)
            if command in ("check_out", "toggle"):
                self.assertIn("(0.00h esta sesión)", out, command)
            if command == "resume":
                self.assertIn("(0.00h de descanso)", out)

    def test_status_with_no_history(self):
        out = self.run_cmd(client(self.EMP, kw([]), kw([]), kw([])), "status")
        self.assertNotIn("Último", out)
        self.assertIn("Horas hoy: 0.00h", out)

    def test_status_and_history_send_exactly_these_queries(self):
        moment = datetime(2026, 3, 2, 12, 34, 56, 789, tzinfo=timezone.utc)

        class Frozen(datetime):
            @classmethod
            def now(cls, tz=None):
                return moment.astimezone(tz) if tz else moment.astimezone().replace(tzinfo=None)

        odoo = client(self.EMP, kw([]), kw([]), kw([]), kw([]))
        with patch.object(cli, "datetime", Frozen):
            self.run_cmd(odoo, "status")
            self.run_cmd(odoo, "history", 3)
        midnight = (
            datetime.combine(moment.astimezone().date(), datetime.min.time())
            .astimezone()
            .astimezone(timezone.utc)
            .strftime("%Y-%m-%d %H:%M:%S")
        )
        fields = ["check_in", "check_out", "worked_hours"]

        def call(domain, kwargs):
            return {"model": "hr.attendance", "method": "search_read", "args": [domain], "kwargs": kwargs}

        self.assertEqual(
            [params for _, params, _ in odoo.opener.calls[2:]],
            [
                call([["employee_id", "=", 7]], {"fields": fields, "limit": 1, "order": "check_in desc"}),
                call(
                    [["employee_id", "=", 7], ["check_in", ">=", midnight]], {"fields": fields, "order": "check_in asc"}
                ),
                call(
                    [["employee_id", "=", 7], ["check_in", ">=", "2026-02-27 12:34:56"]],
                    {"fields": fields, "order": "check_in desc"},
                ),
            ],
        )

    def test_toggle_in_and_out(self):
        reasons, now = kw([NORMAL]), utc(0)
        odoo = client(
            self.EMP,
            kw([]),
            reasons,
            {"result": {"attendance_state": "checked_in", "attendance": {"check_in": now}, "hours_today": 2}},
        )
        self.assertEqual(self.run_cmd(odoo, "toggle"), f"CHECK-IN registrado a las {self.hms(now)}\nHoras hoy: 2.00h\n")
        self.assertEqual(odoo.opener.calls[-1][1], {"attendance_reason_id": 5})
        odoo = client(
            self.EMP,
            kw([{"id": 1, "check_in": utc(60)}]),
            reasons,
            {
                "result": {
                    "attendance_state": "checked_out",
                    "attendance": {"check_out": now},
                    "hours_today": 2,
                    "last_attendance_worked_hours": 1,
                }
            },
        )
        self.assertEqual(
            self.run_cmd(odoo, "toggle"),
            f"CHECK-OUT registrado a las {self.hms(now)} (1.00h esta sesión)\nHoras hoy: 2.00h\n",
        )
        self.assertEqual(odoo.opener.calls[-1][1], {})

    def test_toggle_with_an_unknown_state_still_reports_hours(self):
        odoo = client(self.EMP, kw([]), kw([]), {"result": {"attendance_state": "?", "hours_today": 3}})
        self.assertEqual(self.run_cmd(odoo, "toggle").strip(), "Horas hoy: 3.00h")

    def test_check_in_refuses_an_open_session_and_punches_with_the_normal_reason(self):
        start, now = utc(30), utc(0)
        odoo = client(self.EMP, kw([{"id": 1, "check_in": start}]))
        self.assertEqual(
            self.run_cmd(odoo, "check_in"),
            f"Ya estás fichado desde las {self.hms(start)}. Usa 'checkout' para salir.\n",
        )
        odoo = client(self.EMP, kw([]), kw([NORMAL]), {"result": {"attendance": {"check_in": now}, "hours_today": 0.5}})
        self.assertEqual(
            self.run_cmd(odoo, "check_in"), f"CHECK-IN registrado a las {self.hms(now)}\nHoras hoy: 0.50h\n"
        )
        self.assertEqual(odoo.opener.calls[-1][1], {"attendance_reason_id": 5})

    def test_check_out_needs_an_open_session_and_reports_its_hours(self):
        self.assertEqual(
            self.run_cmd(client(self.EMP, kw([])), "check_out"), "No hay fichaje abierto. Usa 'checkin' para entrar.\n"
        )
        now = utc(0)
        odoo = client(
            self.EMP,
            kw([{"id": 1, "check_in": utc(30)}]),
            {"result": {"attendance": {"check_out": now}, "hours_today": 4, "last_attendance_worked_hours": 0.5}},
        )
        self.assertEqual(
            self.run_cmd(odoo, "check_out"),
            f"CHECK-OUT registrado a las {self.hms(now)} (0.50h esta sesión)\nHoras hoy: 4.00h\n",
        )

    def test_break(self):
        open_att = kw([{"id": 1, "check_in": utc(30)}])
        self.assertEqual(
            self.run_cmd(client(self.EMP, open_att, kw([NORMAL])), "take_break"),
            "Este Odoo no tiene el motivo Descanso; no se puede fichar un descanso.\n",
        )
        self.assertEqual(
            self.run_cmd(client(self.EMP, kw([]), kw([NORMAL, REST])), "take_break"),
            "No hay fichaje abierto. Usa 'checkin' para entrar.\n",
        )
        odoo = client(self.EMP, open_att, kw([NORMAL, REST]), kw([{"attendance_reason_ids": [3]}]))
        self.assertEqual(self.run_cmd(odoo, "take_break"), "Ya estás en descanso. Usa 'resume' para volver.\n")
        now = utc(0)
        odoo = client(
            self.EMP,
            open_att,
            kw([NORMAL, REST]),
            kw([{"attendance_reason_ids": [5]}]),
            {"result": {"attendance": {"check_out": now}}},
            {"result": {"attendance": {"check_in": now}, "hours_today": 3}},
        )
        self.assertEqual(
            self.run_cmd(odoo, "take_break"), f"DESCANSO iniciado a las {self.hms(now)}\nHoras hoy: 3.00h\n"
        )
        self.assertEqual([call[1] for call in odoo.opener.calls[-2:]], [{}, {"attendance_reason_id": 3}])

    def test_resume_needs_an_open_break_and_comes_back_with_the_normal_reason(self):
        open_att = kw([{"id": 1, "check_in": utc(10)}])
        none_open = "No hay un descanso abierto. Usa 'break' para salir a descanso.\n"
        self.assertEqual(self.run_cmd(client(self.EMP, kw([]), kw([NORMAL, REST])), "resume"), none_open)
        odoo = client(self.EMP, open_att, kw([NORMAL, REST]), kw([{"attendance_reason_ids": [5]}]))
        self.assertEqual(self.run_cmd(odoo, "resume"), none_open)
        now = utc(0)
        odoo = client(
            self.EMP,
            open_att,
            kw([NORMAL, REST]),
            kw([{"attendance_reason_ids": [3]}]),
            {"result": {"attendance": {"check_out": now}, "last_attendance_worked_hours": 0.25}},
            {"result": {"attendance": {"check_in": now}, "hours_today": 3.25}},
        )
        self.assertEqual(
            self.run_cmd(odoo, "resume"),
            f"VUELTA del descanso a las {self.hms(now)} (0.25h de descanso)\nHoras hoy: 3.25h\n",
        )
        self.assertEqual([call[1] for call in odoo.opener.calls[-2:]], [{}, {"attendance_reason_id": 5}])

    def test_history_groups_by_day_and_counts_the_open_session(self):
        odoo = client(
            self.EMP,
            kw(
                [
                    {"check_in": "2026-03-02 10:00:00", "check_out": False, "worked_hours": 0},
                    {"check_in": "2026-03-02 08:00:00", "check_out": "2026-03-02 09:00:00", "worked_hours": 1.0},
                    {"check_in": "2026-02-27 08:00:00", "check_out": "2026-02-27 10:00:00", "worked_hours": 2.0},
                ]
            ),
        )
        out = self.run_cmd(odoo, "history", 3)
        self.assertIn("en curso", out)
        self.assertEqual(out.count("TOTAL"), 2)
        self.assertIn("TOTAL: 2.00h", out)
        self.assertIn("(1.00h)", out)

    def test_history_prints_each_day_its_sessions_and_its_total(self):
        moment = datetime(2026, 3, 2, 12, 0, tzinfo=timezone.utc)

        class Frozen(datetime):
            @classmethod
            def now(cls, tz=None):
                return moment.astimezone(tz)

        odoo = client(
            self.EMP,
            kw(
                [
                    {"check_in": "2026-03-01 14:00:00", "check_out": "2026-03-01 15:00:00", "worked_hours": 1.0},
                    {"check_in": "2026-03-01 08:00:00", "check_out": False, "worked_hours": 0},
                    {"check_in": "2026-03-01 06:00:00", "check_out": "2026-03-01 07:00:00", "worked_hours": 1.0},
                    {"check_in": "2026-02-27 08:00:00", "check_out": "2026-02-27 10:00:00", "worked_hours": 2.0},
                ]
            ),
        )
        with patch.object(cli, "datetime", Frozen):
            out = self.run_cmd(odoo, "history")

        def at(stamp, fmt="%H:%M"):
            return cli.local_time(stamp).strftime(fmt)

        total = f"  {'':>23} TOTAL: "
        self.assertEqual(
            out.split("\n"),
            [
                "",
                at("2026-03-01 14:00:00", "%Y-%m-%d (%a)"),
                f"  {at('2026-03-01 14:00:00')} - {at('2026-03-01 15:00:00')}  (1.00h)",
                f"  {at('2026-03-01 08:00:00')} - ...    (28.00h en curso)",
                f"  {at('2026-03-01 06:00:00')} - {at('2026-03-01 07:00:00')}  (1.00h)",
                f"{total}30.00h",
                "",
                at("2026-02-27 08:00:00", "%Y-%m-%d (%a)"),
                f"  {at('2026-02-27 08:00:00')} - {at('2026-02-27 10:00:00')}  (2.00h)",
                f"{total}2.00h",
                "",
            ],
        )

    def test_history_without_records(self):
        self.assertIn("No hay registros en los últimos 7 días", self.run_cmd(client(self.EMP, kw([])), "history"))


def typed(cell):
    try:
        return (datetime.strptime(cell, "%d/%m/%Y").date() - cli.SHEET_EPOCH).days
    except (TypeError, ValueError):
        return cell


class FakeGoogle:
    """Google's Sheets API for one spreadsheet, as the opener Sheets talks through: it trades the token, serves
    and appends to its tabs in memory, and, like Google, stores a typed date as its serial number and answers a
    range past the last column with nothing for that row."""

    def __init__(self, spreadsheet="hoja", **tabs):
        self.id = spreadsheet
        self.tabs = {"Avisos 2026": [], "Avisos Totales": [], **tabs}
        self.appended, self.requests = [], []
        self.unreachable_to_append = False

    def refuse(self, request, code):
        return urllib.error.HTTPError(request.full_url, code, "refused", {}, io.BytesIO(b"{}"))

    def open(self, request, timeout):
        self.requests.append((request.get_method(), request.full_url))
        if request.full_url == sh.TOKEN_URL:
            return io.BytesIO(b'{"access_token": "tok"}')
        if request.get_header("Authorization") != "Bearer tok":
            raise self.refuse(request, 401)
        prefix = f"/v4/spreadsheets/{self.id}/values/"
        path = urllib.parse.unquote(urllib.parse.urlsplit(request.full_url).path)
        if not path.startswith(prefix):
            raise self.refuse(request, 404)
        cells = path[len(prefix) :]
        if cells.endswith(":append"):
            if self.unreachable_to_append:
                raise urllib.error.URLError("sin red")
            cells = cells.removesuffix(":append")
            rows = json.loads(request.data)["values"]
            self.appended.append((cells, rows))
            self.tabs[cells.split("!")[0]] += [[typed(cell) for cell in row] for row in rows]
            return io.BytesIO(b"{}")
        tab, columns = cells.split("!")
        return io.BytesIO(
            json.dumps(
                {"values": [row[2:3] for row in self.tabs[tab]] if columns == "D4:D" else self.tabs[tab]}
            ).encode()
        )


@contextmanager
def google_fake(google):
    with (
        patch.object(sh.shutil, "which", return_value="/bin/gws"),
        patch.object(sh.subprocess, "run", return_value=SimpleNamespace(stdout=GWS_EXPORT)),
        patch.object(sh.urllib.request, "build_opener", return_value=google),
    ):
        yield google


def stamp(day, hour=0):
    return datetime.combine(day, time(hour)).astimezone().astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def attendances(sessions):
    def rows(args, kwargs):
        if len(args) == 3:
            return [{"employee_id": [e["id"], e["name"]], "check_in": "2026-01-05 08:00:00"} for e in STAFF]
        return [
            {
                "employee_id": [e["id"], e["name"]],
                "check_in": stamp(day, start),
                "check_out": end and stamp(day, end),
                "worked_hours": hours,
                "attendance_reason_ids": [NORMAL["id"]],
            }
            for e in STAFF
            for day in (FIRST_DAY + timedelta(days=n) for n in range((LAST_DAY - FIRST_DAY).days))
            if day.weekday() < 5
            for start, end, hours in sessions.get((e["id"], day), WORKDAY)
        ]

    return rows


def office(sessions, requests):
    """Odoo as team.py reads it: Bea and Íñigo work nine to five on weekdays with a punch to match, except on the
    days `sessions` names, as (employee, day) -> [(in, out, hours)] with no out for an open punch; `requests`
    are (owner user, day, status)."""
    return ScriptedClient(
        {
            "hr.attendance": attendances(sessions),
            "hr.attendance.reason": [NORMAL, REST],
            "hr.employee": STAFF,
            "resource.calendar.attendance": WORKWEEK,
            "approval.request": [
                {
                    "request_owner_id": [owner, "x"],
                    "date_start": stamp(day, 9),
                    "date_end": stamp(day, 10),
                    "reason": False,
                    "request_status": status,
                    "user_status": "pending",
                }
                for owner, day, status in requests
            ],
        }
    )


SEPTEMBER_OCTOBER = {
    (1, date(2026, 8, 31)): [(9, None, 0)],
    (1, date(2026, 9, 2)): [(8, None, 0), (9, 23, 14.0)],
    (1, date(2026, 9, 4)): [],
    (2, date(2026, 10, 1)): [],
    (2, date(2026, 10, 2)): [],
    (2, date(2026, 10, 6)): [(9, None, 0)],
    (2, date(2026, 10, 8)): [(9, 23, 14.0)],
}
REQUESTS = [
    (11, date(2026, 9, 2), "pending"),
    (12, date(2026, 9, 2), "new"),
    (12, date(2026, 9, 2), "approved"),
    (12, date(2026, 10, 6), "new"),
]


class NoticesTest(unittest.TestCase):
    TODAY = date(2026, 10, 8)
    NOW = "2026-10-08T10:00:00+02:00"
    SEPTEMBER_ROWS = [
        ["Bea", "Septiembre", "02/09/2026", "Solicitud"],
        ["Íñigo", "Septiembre", "02/09/2026", "Solicitud"],
        ["Bea", "Septiembre", "04/09/2026", "Incidencia"],
    ]
    OCTOBER_ROWS = [
        ["Íñigo", "Octubre", "01/10/2026", "Incidencia"],
        ["Íñigo", "Octubre", "02/10/2026", "Incidencia"],
        ["Íñigo", "Octubre", "06/10/2026", "Solicitud (borrador)"],
    ]

    def setUp(self):
        temp_state(self)
        c.write_private(cli.SHEET_FILE, "hoja")

    def run_notices(self, google, today=TODAY, *, stdin=None, now=NOW, sessions=SEPTEMBER_OCTOBER, requests=REQUESTS):
        self.google, self.office = google, office(sessions, requests)
        out = io.StringIO()
        with (
            google_fake(google),
            patch.object(sys, "stdin", stdin),
            patch.object(cli.team, "datetime", frozen(now)),
            redirect_stdout(out),
        ):
            cli.notices(self.office, today)
        return out.getvalue()

    def test_the_first_day_of_the_month_counts_and_a_short_row_of_the_sheet_is_padded(self):
        google = FakeGoogle()
        with (
            google_fake(google),
            patch.object(cli.team, "datetime", frozen(self.NOW)),
            redirect_stdout(io.StringIO()),
        ):
            cli.add_notices(office({(2, date(2026, 10, 1)): []}, []), cli.Sheets("hoja"), date(2026, 10, 1))
        self.assertEqual(google.appended, [("Avisos 2026!B4:E", [["Íñigo", "Octubre", "01/10/2026", "Incidencia"]])])
        with google_fake(FakeGoogle(**{"Avisos 2026": [["Bea"]]})):
            self.assertEqual(cli.sheet_rows(cli.Sheets("hoja"), date(2026, 10, 1)), [["Bea", "", "", ""]])

    def test_the_previous_month_is_closed_and_the_current_one_brought_up_to_yesterday(self):
        google = FakeGoogle()
        self.assertEqual(
            self.run_notices(google),
            (
                "Avisos de septiembre añadidos a «Avisos 2026»: 3\n"
                "Empleados con avisos en septiembre, anotados en «Avisos Totales»: 2\n"
                "Avisos de octubre añadidos a «Avisos 2026»: 3\n"
            ),
        )
        self.assertEqual(
            google.appended,
            [
                ("Avisos 2026!B4:E", self.SEPTEMBER_ROWS),
                ("Avisos Totales!B4:D", [["Bea", 2, "Septiembre"], ["Íñigo", 1, "Septiembre"]]),
                ("Avisos 2026!B4:E", self.OCTOBER_ROWS),
            ],
        )
        weeks = [tuple(q[2][0][1:3]) for q in self.office.queries if q[:2] == ("hr.attendance", "search_read")]
        self.assertEqual(
            weeks,
            [
                (("check_in", ">=", stamp(date(2026, 8, 31))), ("check_in", "<", stamp(date(2026, 10, 5)))),
                (("check_in", ">=", stamp(date(2026, 9, 28))), ("check_in", "<", stamp(date(2026, 11, 2)))),
            ],
        )

    def test_a_closed_month_is_left_alone_and_the_sheet_alone_is_enough_to_add_nothing_twice(self):
        google = FakeGoogle()
        self.run_notices(google)
        os.remove(cli.WRITTEN_FILE)
        self.assertEqual(self.run_notices(google), "Avisos de octubre añadidos a «Avisos 2026»: 0\n")
        self.assertEqual(len(google.appended), 3)
        self.assertEqual(len([q for q in self.office.queries if q[:2] == ("hr.attendance", "search_read")]), 1)

    def test_rows_the_sheet_already_has_are_left_out_whatever_else_they_carry(self):
        google = FakeGoogle(
            **{
                "Avisos 2026": [
                    ["Bea", "Septiembre", 46267, "Solicitud", "Informal", "Discord"],
                    ["Íñigo"],
                    [],
                    ["Bea", "Septiembre", "04/09/2026", "Incidencia"],
                ],
                "Avisos Totales": [["Zoe", 2, "Agosto"], []],
            }
        )
        self.run_notices(google)
        self.assertEqual(google.appended[0], ("Avisos 2026!B4:E", self.SEPTEMBER_ROWS[1:]))
        self.assertEqual(
            google.appended[1], ("Avisos Totales!B4:D", [["Bea", 3, "Septiembre"], ["Íñigo", 1, "Septiembre"]])
        )

    def test_a_row_written_once_never_comes_back_however_the_sheet_was_changed_by_hand(self):
        self.run_notices(FakeGoogle())
        rewritten = [["Ana María", "Octubre", 46300, "Solicitud"]]
        for by_hand in ([], rewritten):
            google = FakeGoogle(**{"Avisos 2026": list(by_hand)})
            self.run_notices(google)
            self.assertEqual(google.appended, [])
            self.assertEqual(google.tabs, {"Avisos 2026": by_hand, "Avisos Totales": []})

    def test_an_append_that_fails_notes_nothing_so_the_next_run_adds_it_all(self):
        broken = FakeGoogle()
        broken.unreachable_to_append = True
        with self.assertRaisesRegex(cli.SheetsError, r"Google no responde \(sin red\)"):
            self.run_notices(broken)
        self.assertFalse(os.path.exists(cli.WRITTEN_FILE))
        google = FakeGoogle()
        self.run_notices(google)
        self.assertEqual(len(google.tabs["Avisos 2026"]), 6)
        self.assertEqual(
            json.loads(c.read_private(cli.WRITTEN_FILE)), {"hoja": self.SEPTEMBER_ROWS + self.OCTOBER_ROWS}
        )

    def test_each_spreadsheet_remembers_its_own_rows(self):
        self.run_notices(FakeGoogle())
        c.write_private(cli.SHEET_FILE, "otra")
        other = FakeGoogle("otra")
        self.run_notices(other)
        self.assertEqual(len(other.tabs["Avisos 2026"]), 6)
        self.assertEqual(sorted(json.loads(c.read_private(cli.WRITTEN_FILE))), ["hoja", "otra"])

    def test_a_memory_that_cannot_be_read_is_an_empty_one_and_says_so(self):
        for broken in ("no", "[1]", "7"):
            c.write_private(cli.WRITTEN_FILE, broken)
            google, err = FakeGoogle(), io.StringIO()
            with redirect_stderr(err):
                self.run_notices(google)
            self.assertEqual(len(google.tabs["Avisos 2026"]), 6)
            self.assertEqual(
                err.getvalue(),
                f"No se puede leer {cli.WRITTEN_FILE}: se sigue sin él, y vuelven a añadirse las filas borradas a"
                " mano\n",
            )

    def test_no_memory_yet_says_nothing(self):
        err = io.StringIO()
        with redirect_stderr(err):
            self.run_notices(FakeGoogle())
        self.assertEqual(err.getvalue(), "")

    def test_january_closes_december_in_last_years_tab(self):
        google = FakeGoogle(**{"Avisos 2027": []})
        self.run_notices(
            google,
            date(2027, 1, 5),
            now="2027-01-05T10:00:00+01:00",
            sessions={(1, date(2026, 12, 31)): [(9, None, 0)]},
            requests=[(11, date(2027, 1, 4), "pending")],
        )
        self.assertEqual(
            google.appended,
            [
                ("Avisos 2026!B4:E", [["Bea", "Diciembre", "31/12/2026", "Incidencia"]]),
                ("Avisos Totales!B4:D", [["Bea", 1, "Diciembre"]]),
                ("Avisos 2027!B4:E", [["Bea", "Enero", "04/01/2027", "Solicitud"]]),
            ],
        )

    def test_without_a_saved_spreadsheet_it_is_asked_for_on_a_terminal_and_refused_without_one(self):
        os.remove(cli.SHEET_FILE)
        for no_terminal in (None, io.StringIO()):
            google = FakeGoogle()
            with self.assertRaisesRegex(c.OdooError, "No hay hoja de avisos guardada"):
                self.run_notices(google, stdin=no_terminal)
            self.assertEqual(google.requests, [])
            self.assertEqual(self.office.queries, [])
        nueva = FakeGoogle("nueva")
        with patch("builtins.input", return_value="https://docs.google.com/spreadsheets/d/nueva/edit") as asked:
            self.run_notices(nueva, stdin=SimpleNamespace(isatty=lambda: True))
            self.run_notices(nueva, stdin=SimpleNamespace(isatty=lambda: True))
        asked.assert_called_once_with("Dirección de la hoja de avisos: ")
        self.assertTrue(nueva.requests)
        self.assertEqual(c.read_private(cli.SHEET_FILE), "nueva")


class StopLoop(Exception):
    pass


class Unreachable(ScriptedOpener):
    def open(self, req):
        self.calls.append((req.full_url, None, req.get_header("Cookie")))
        raise OSError("sin red")


EXPIRED = {"error": {"code": 100, "message": "Odoo Session Expired"}}
SESSION = kw({"uid": 3})
EMPLOYEE_ROW = kw([EMPLOYEE])


class MainTest(unittest.TestCase):
    TTY = SimpleNamespace(isatty=lambda: True)

    def run_main(self, *argv, stdin=None):
        out, err = io.StringIO(), io.StringIO()
        with (
            patch.object(sys, "argv", ["odoo", *argv]),
            patch.object(sys, "stdin", stdin),
            redirect_stdout(out),
            redirect_stderr(err),
            self.assertRaises(SystemExit) as caught,
        ):
            cli.main()
        return caught.exception.code, out.getvalue(), err.getvalue()

    def run_ok(self, *argv):
        out = io.StringIO()
        with patch.object(sys, "argv", ["odoo", *argv]), redirect_stdout(out):
            cli.main()
        return out.getvalue()

    def signed_in(self):
        temp_state(self)
        c.save_config(**CONFIG)
        c.write_private(cli.CLI_SESSION_FILE, "sid")

    def odoo_answers(self, *scripts):
        self.openers = [ScriptedOpener(*script) if isinstance(script, list) else script for script in scripts]
        queue = iter(self.openers)
        return patch.object(urllib.request, "build_opener", side_effect=lambda *handlers: next(queue))

    def discord_says(self, *results):
        pending, self.discord_requests = list(results), []

        def urlopen(request, timeout):
            self.discord_requests.append(request)
            result = pending.pop(0)
            if isinstance(result, Exception):
                raise result
            return io.BytesIO(json.dumps(result).encode())

        return patch.object(cli.discord.urllib.request, "urlopen", side_effect=urlopen)

    def test_usage(self):
        for argv in ((), ("-h",), ("--help",), ("help",)):
            code, out, _ = self.run_main(*argv)
            self.assertEqual(code, 0)
            self.assertIn("Uso: odoo", out)

    def test_unknown_command(self):
        code, out, _ = self.run_main("volar")
        self.assertEqual(code, 1)
        self.assertEqual(out, f"Comando desconocido: volar\n{cli.USAGE}\n")

    def test_dispatches_each_command(self):
        self.signed_in()
        open_now = kw([{"id": 1, "check_in": utc(30)}])
        for cmd, script, said in (
            ("status", [EMPLOYEE_ROW, kw([]), kw([]), kw([])], "Estado: NO FICHADO (salida)"),
            ("checkin", [EMPLOYEE_ROW, open_now], "Ya estás fichado desde las"),
            ("checkout", [EMPLOYEE_ROW, kw([])], "No hay fichaje abierto. Usa 'checkin' para entrar."),
            (
                "toggle",
                [
                    EMPLOYEE_ROW,
                    open_now,
                    kw([NORMAL]),
                    {"result": {"attendance_state": "checked_out", "attendance": {"check_out": utc(0)}}},
                ],
                "CHECK-OUT registrado a las",
            ),
            ("break", [EMPLOYEE_ROW, open_now, kw([NORMAL])], "Este Odoo no tiene el motivo Descanso"),
            ("resume", [EMPLOYEE_ROW, kw([]), kw([NORMAL, REST])], "No hay un descanso abierto."),
            ("history", [EMPLOYEE_ROW, kw([])], "No hay registros en los últimos 7 días"),
        ):
            with self.odoo_answers([SESSION, *script]):
                self.assertIn(said, self.run_ok(cmd), cmd)
            self.assertEqual(self.openers[0].calls[0][2], "session_id=sid", cmd)

    def test_history_takes_a_number_of_days(self):
        self.signed_in()
        with self.odoo_answers([SESSION, EMPLOYEE_ROW, kw([])]):
            self.assertIn("No hay registros en los últimos 30 días", self.run_ok("history", "30"))
        for days in ("cero", "0"):
            with self.odoo_answers([]):
                code, _, err = self.run_main("history", days)
            self.assertEqual(code, 1)
            self.assertIn(f"ERROR: history espera un número de días, no «{days}»", err)

    def test_notices_run_for_today_and_what_google_refuses_goes_to_stderr(self):
        self.signed_in()
        c.write_private(cli.SHEET_FILE, "hoja")
        closed = {"Avisos Totales": [["Bea", 1, "Septiembre"]]}
        refusing = FakeGoogle(**closed)
        refusing.unreachable_to_append = True
        accepting = FakeGoogle(**closed)
        for google in (refusing, accepting):
            with (
                google_fake(google),
                patch.object(cli, "OdooClient", return_value=office(SEPTEMBER_OCTOBER, REQUESTS)),
                patch.object(cli, "datetime", frozen("2026-10-08T10:00:00+02:00")),
                patch.object(cli.team, "datetime", frozen("2026-10-08T10:00:00+02:00")),
            ):
                if google is refusing:
                    code, _, err = self.run_main("notices")
                else:
                    said = self.run_ok("notices")
        self.assertEqual(code, 1)
        self.assertIn("ERROR: Google no responde (sin red)", err)
        self.assertEqual(said, "Avisos de octubre añadidos a «Avisos 2026»: 3\n")
        self.assertEqual(len(accepting.tabs["Avisos 2026"]), 3)

    def test_sheet_remembers_the_spreadsheet_of_an_address_without_a_session(self):
        home = temp_state(self)
        code, _, err = self.run_main("sheet")
        self.assertEqual(code, 1)
        self.assertIn("ERROR: No hay hoja de avisos guardada. Ejecuta: odoo sheet", err)
        code, _, err = self.run_main("sheet", "https://example.com/hoja")
        self.assertEqual(code, 1)
        self.assertIn("«https://example.com/hoja» no es la dirección de una hoja de cálculo de Google", err)
        for argv in (["https://docs.google.com/spreadsheets/d/1mF_a-b9/edit?usp=sharing", "sobra"], []):
            out = io.StringIO()
            with patch.object(sys, "argv", ["odoo", "sheet", *argv]), redirect_stdout(out):
                cli.main()
            self.assertEqual(out.getvalue(), "1mF_a-b9\n")
        self.assertEqual(os.stat(os.path.join(home, "notices_sheet")).st_mode & 0o777, 0o600)

    def test_discord_keeps_the_bot_token_without_a_session(self):
        temp_state(self)
        with patch.object(cli.getpass, "getpass", return_value=" tok ") as getpass:
            with self.discord_says({"username": "Odoo"}):
                out = self.run_ok("discord")
            getpass.assert_called_once_with("Token del bot de Discord: ")
            self.assertEqual(out, f"Bot «Odoo» guardado en {cli.discord.TOKEN_FILE}\n")
            self.assertEqual(self.discord_requests[0].full_url, f"{cli.discord.API}/users/@me")
            self.assertEqual(self.discord_requests[0].get_header("Authorization"), "Bot tok")
            self.assertEqual(c.read_private(cli.discord.TOKEN_FILE), "tok")
            with self.discord_says(urllib.error.URLError("sin red")):
                code, _, err = self.run_main("discord")
        self.assertEqual(code, 1)
        self.assertIn("ERROR: Discord no responde", err)

    def test_odoo_errors_go_to_stderr(self):
        self.signed_in()
        refused = {"error": {"code": 200, "data": {"message": "sin acceso"}}}
        with self.odoo_answers([SESSION, refused]):
            code, _, err = self.run_main("status")
        self.assertEqual(code, 1)
        self.assertIn("ERROR: sin acceso", err)

    def test_a_missing_or_expired_session_points_to_login(self):
        temp_state(self)
        code, _, err = self.run_main("status")
        self.assertEqual(code, 1)
        self.assertIn("odoo login", err)
        c.save_config(**CONFIG)
        _, _, err = self.run_main("status")
        self.assertIn("ERROR: No hay sesión de Odoo guardada", err)
        c.write_private(cli.CLI_SESSION_FILE, "sid")
        with self.odoo_answers([EXPIRED]):
            _, _, err = self.run_main("status", stdin=io.StringIO())
        self.assertIn("ERROR: La sesión de Odoo ha caducado. Ejecuta: odoo login", err)

    def test_with_a_terminal_an_expired_session_logs_in_and_starts_over(self):
        temp_state(self)
        c.save_config(**CONFIG)
        c.write_private(cli.CLI_SESSION_FILE, "old")
        login = {"result": {"uid": 9}, "cookies": [SESSION_HEADER]}
        with (
            self.odoo_answers([EXPIRED], [login], [SESSION, EMPLOYEE_ROW, kw([]), kw([]), kw([])]),
            patch.object(cli.getpass, "getpass", return_value="p"),
            patch("builtins.input", return_value=""),
            patch.object(sys, "stdin", self.TTY),
            patch.object(sys, "argv", ["odoo", "status"]),
            redirect_stdout(io.StringIO()) as out,
        ):
            cli.main()
        self.assertEqual([opener.calls[0][2] for opener in self.openers], ["session_id=old", None, "session_id=abc123"])
        self.assertEqual(self.openers[1].calls[0][1], {"db": "db", "login": "u", "password": "p"})
        self.assertEqual(c.read_private(cli.CLI_SESSION_FILE), "abc123")
        self.assertIn("La sesión de Odoo ha caducado. Inicia sesión para continuar.", out.getvalue())
        self.assertIn("Estado: NO FICHADO (salida)", out.getvalue())
        c.write_private(cli.CLI_SESSION_FILE, "old")
        with (
            self.odoo_answers([EXPIRED], [login], [EXPIRED]),
            patch.object(cli.getpass, "getpass", return_value="p"),
            patch("builtins.input", return_value=""),
        ):
            code, _, err = self.run_main("status", stdin=self.TTY)
        self.assertEqual(len(self.openers[1].calls), 1)
        self.assertEqual(code, 1)
        self.assertIn("ERROR: La sesión de Odoo ha caducado. Ejecuta: odoo login", err)

    def test_keep_alive_pings_the_session_on_disk_whatever_odoo_answers(self):
        temp_state(self)
        with patch.object(cli.time, "sleep", side_effect=StopLoop), self.assertRaises(StopLoop):
            cli.keep_alive()
        c.save_config(**CONFIG)
        c.write_private(cli.CLI_SESSION_FILE, "old")
        pauses = [lambda: c.write_private(cli.CLI_SESSION_FILE, "fresh"), lambda: None]

        def pause(seconds):
            if not pauses:
                raise StopLoop
            pauses.pop(0)()

        with (
            self.odoo_answers([EXPIRED], Unreachable(), [SESSION]),
            patch.object(cli.time, "sleep", side_effect=pause) as sleep,
            self.assertRaises(StopLoop),
        ):
            cli.keep_alive()
        sleep.assert_called_with(cli.KEEPALIVE_INTERVAL)
        self.assertEqual(sleep.call_count, 3)
        self.assertEqual(
            [opener.calls[0][2] for opener in self.openers], ["session_id=old", "session_id=fresh", "session_id=fresh"]
        )

    def test_cli_client_uses_the_saved_session(self):
        temp_state(self)
        c.save_config(**CONFIG)
        c.write_private(cli.CLI_SESSION_FILE, "sid")
        odoo = cli.cli_client()
        self.assertEqual((odoo.url, odoo.db, odoo.session_id), ("https://odoo.example", "db", "sid"))

    def test_login_asks_once_and_saves_the_session(self):
        home = temp_state(self)
        answers = iter(["https://odoo.example/", "db", "ana"])
        with (
            self.odoo_answers([{"result": {"uid": 9}, "cookies": [SESSION_HEADER]}]),
            patch("builtins.input", side_effect=lambda _: next(answers)) as ask,
            patch.object(cli.getpass, "getpass", return_value="p") as getpass,
            patch.object(sys, "argv", ["odoo", "login"]),
            redirect_stdout(io.StringIO()) as out,
        ):
            cli.main()
        self.assertEqual(
            self.openers[0].calls,
            [
                (
                    "https://odoo.example/web/session/authenticate",
                    {"db": "db", "login": "ana", "password": "p"},
                    None,
                )
            ],
        )
        getpass.assert_called_once_with("Contraseña: ")
        self.assertEqual(
            [call.args[0] for call in ask.call_args_list], ["URL de Odoo: ", "Base de datos: ", "Usuario: "]
        )
        self.assertEqual(c.load_config(), {"url": "https://odoo.example", "db": "db", "user": "ana"})
        self.assertEqual(c.read_private(cli.CLI_SESSION_FILE), "abc123")
        self.assertEqual(oct(os.stat(cli.CLI_SESSION_FILE).st_mode & 0o777), "0o600")
        self.assertIn(home, out.getvalue())
        self.assertEqual(sorted(os.listdir(home)), ["cli_session", "config.json"])

    def test_login_asks_the_code_when_odoo_wants_one_and_keeps_the_device(self):
        home = temp_state(self)
        c.save_config(**CONFIG)
        c.write_private(cli.CLI_DEVICE_FILE, "old")
        answers = iter(["", "123456"])
        with (
            self.odoo_answers(
                [
                    {"result": {}, "cookies": [SESSION_HEADER]},
                    {"page": TOTP_PAGE},
                    {"status": 303, "cookies": [ROTATED_HEADER, DEVICE_HEADER]},
                    {"result": {"uid": 9}},
                ]
            ),
            patch("builtins.input", side_effect=lambda _: next(answers)) as ask,
            patch.object(cli.getpass, "getpass", return_value="p"),
            redirect_stdout(io.StringIO()),
        ):
            cli.cli_login()
        self.assertEqual(self.openers[0].calls[1][2], "session_id=abc123; td_id=old")
        self.assertEqual(self.openers[0].calls[2][1], {"totp_token": "123456", "csrf_token": "tok1", "remember": "1"})
        self.assertEqual(ask.call_args.args[0], "Código de verificación (2FA): ")
        self.assertEqual(c.read_private(cli.CLI_SESSION_FILE), "rotated")
        self.assertEqual(c.read_private(cli.CLI_DEVICE_FILE), "dev2")
        self.assertEqual(oct(os.stat(cli.CLI_DEVICE_FILE).st_mode & 0o777), "0o600")
        self.assertEqual(sorted(os.listdir(home)), ["cli_device", "cli_session", "config.json"])

    def test_login_reuses_the_config_and_offers_the_user_as_default(self):
        temp_state(self)
        c.save_config(**CONFIG)
        with (
            self.odoo_answers([{"result": {"uid": 9}, "cookies": [SESSION_HEADER]}]),
            patch("builtins.input", return_value="") as ask,
            patch.object(cli.getpass, "getpass", return_value="p"),
            redirect_stdout(io.StringIO()),
        ):
            cli.cli_login()
        self.assertEqual(ask.call_args.args[0], "Usuario [u]: ")
        self.assertEqual(self.openers[0].calls[0][1], {"db": "db", "login": "u", "password": "p"})

    def test_a_blank_user_is_sent_as_blank(self):
        temp_state(self)
        answers = iter(["https://odoo.example/", "db", ""])
        with (
            self.odoo_answers([{"result": {"uid": 9}, "cookies": [SESSION_HEADER]}]),
            patch("builtins.input", side_effect=lambda _: next(answers)),
            patch.object(cli.getpass, "getpass", return_value="p"),
            redirect_stdout(io.StringIO()),
        ):
            cli.cli_login()
        self.assertEqual(self.openers[0].calls[0][1], {"db": "db", "login": "", "password": "p"})

    def test_a_failed_login_saves_nothing(self):
        temp_state(self)
        denied = {"error": {"code": 200, "data": {"name": "odoo.exceptions.AccessDenied", "message": "Access Denied"}}}
        with (
            self.odoo_answers([denied]),
            patch("builtins.input", side_effect=["https://odoo.example", "db", "ana"]),
            patch.object(cli.getpass, "getpass", return_value="p"),
        ):
            code, _, err = self.run_main("login")
        self.assertEqual(code, 1)
        self.assertIn("ERROR: Usuario o contraseña incorrectos", err)
        self.assertEqual(c.read_config(), {})

    def test_module_entry_point(self):
        out = io.StringIO()
        with (
            patch.object(sys, "argv", ["odoo"]),
            patch.dict(sys.modules),
            redirect_stdout(out),
            self.assertRaises(SystemExit),
        ):
            del sys.modules["odoo_wrapper.cli"]
            runpy.run_module("odoo_wrapper.cli", run_name="__main__")
        self.assertIn("Uso: odoo", out.getvalue())


if __name__ == "__main__":
    unittest.main()
