"""Unit tests for the day dialog's writes: correcting and adding punches, approving requests, the lost check-in."""

import unittest
from datetime import date, datetime, time, timedelta, timezone
from types import SimpleNamespace

import helpers  # noqa: F401 - puts the package on the path and refuses the network when this file runs alone

from odoo_wrapper import corrections as co
from odoo_wrapper import corrections_rules as cr
from odoo_wrapper import data as dt
from odoo_wrapper import data_rules as dr
from odoo_wrapper.client import OdooError, SessionExpired

MONDAY = date(2025, 3, 3)


def at(day, hour, minute=0):
    local = datetime.combine(MONDAY + timedelta(days=day), time(hour, minute)).astimezone()
    return local.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


class CorrectionsTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(dt.drop_data_cache)
        dt._data_cache[("sid", None)] = (0, {})

    def client(self, answers=None, fail=None):
        calls = []

        def call_kw(model, method, args, kwargs=None):
            calls.append((model, method, args))
            if fail and method in fail:
                raise fail[method]
            return (answers or {}).get(method)

        return SimpleNamespace(call_kw=call_kw, calls=calls)

    def iso(self, day, hour, minute=0):
        return datetime.combine(MONDAY + timedelta(days=day), time(hour, minute)).astimezone().isoformat()

    def test_a_punch_is_corrected_and_the_caches_dropped(self):
        client = self.client({"read": [{"employee_id": [7, "x"], "check_out": at(0, 17)}]})
        status, body = co.save_attendance(
            client, {"id": 31512, "check_in": self.iso(0, 9), "check_out": self.iso(0, 17, 40)}
        )
        self.assertEqual((status, body), (200, {"ok": True, "lost_entry": None}))
        self.assertEqual(
            client.calls[1], ("hr.attendance", "write", [[31512], {"check_in": at(0, 9), "check_out": at(0, 17, 40)}])
        )
        self.assertEqual(dt._data_cache, {})

    def test_shortening_into_the_same_day_warns_when_the_next_check_in_would_be_lost(self):
        body = {"id": 1, "check_in": self.iso(0, 16, 7), "check_out": self.iso(0, 17, 40)}
        lonely = self.client({"read": [{"employee_id": [7, "x"], "check_out": at(1, 8, 34)}], "search_count": 0})
        self.assertEqual(co.save_attendance(lonely, body)[1]["lost_entry"], dr.local(at(1, 8, 34)).isoformat())
        self.assertEqual(
            lonely.calls,
            [
                ("hr.attendance", "read", [[1], ["employee_id", "check_out"]]),
                ("hr.attendance", "write", [[1], {"check_in": at(0, 16, 7), "check_out": at(0, 17, 40)}]),
                (
                    "hr.attendance",
                    "search_count",
                    [[("employee_id", "=", 7), ("check_in", ">=", at(1, 8, 34)), ("check_in", "<=", at(1, 8, 44))]],
                ),
            ],
        )
        repunched = self.client({"read": [{"employee_id": [7, "x"], "check_out": at(1, 8, 34)}], "search_count": 1})
        self.assertIsNone(co.save_attendance(repunched, body)[1]["lost_entry"])
        closing = self.client({"read": [{"employee_id": [7, "x"], "check_out": False}]})
        self.assertIsNone(co.save_attendance(closing, body)[1]["lost_entry"])

    def test_a_new_punch_is_created_for_the_employee(self):
        client = self.client()
        answer = co.save_attendance(
            client, {"employee": "7", "check_in": "2025-03-04T08:34:00Z", "check_out": "2025-03-04T15:00:00.000Z"}
        )
        self.assertEqual(answer, (200, {"ok": True, "lost_entry": None}))
        self.assertEqual(
            client.calls,
            [
                (
                    "hr.attendance",
                    "create",
                    [{"employee_id": 7, "check_in": "2025-03-04 08:34:00", "check_out": "2025-03-04 15:00:00"}],
                )
            ],
        )

    def test_a_reason_replaces_the_ones_the_punch_had(self):
        times = {"check_in": self.iso(0, 9), "check_out": self.iso(0, 10)}
        stamps = {"check_in": at(0, 9), "check_out": at(0, 10), "attendance_reason_ids": [[6, 0, [3]]]}
        client = self.client({"read": [{"employee_id": [7, "x"], "check_out": at(0, 10)}]})
        self.assertEqual(co.save_attendance(client, {"id": 12, "reason": 3, **times})[0], 200)
        self.assertEqual(client.calls[1], ("hr.attendance", "write", [[12], stamps]))
        client = self.client()
        self.assertEqual(co.save_attendance(client, {"employee": 7, "reason": "3", **times})[0], 200)
        self.assertEqual(client.calls, [("hr.attendance", "create", [{"employee_id": 7, **stamps}])])

    def test_bad_input_and_odoo_refusals(self):
        client = self.client()
        for body in (
            {},
            {"check_in": "x", "check_out": "y"},
            {"id": "z", "check_in": self.iso(0, 9), "check_out": self.iso(0, 10)},
            {"id": 1, "reason": "x", "check_in": self.iso(0, 9), "check_out": self.iso(0, 10)},
        ):
            self.assertEqual(co.save_attendance(client, body), (400, {"error": "Entrada, salida o motivo no válidos"}))
        for check_out in (self.iso(0, 9), self.iso(0, 10)):
            self.assertEqual(
                co.save_attendance(client, {"id": 1, "check_in": self.iso(0, 10), "check_out": check_out}),
                (400, {"error": "La salida tiene que ser posterior a la entrada"}),
            )
        self.assertEqual(
            co.save_attendance(client, {"check_in": self.iso(0, 9), "check_out": self.iso(0, 10)}),
            (400, {"error": "Falta el fichaje o la persona"}),
        )
        self.assertEqual(client.calls, [])
        refused = self.client(fail={"create": OdooError("se solapa")})
        self.assertEqual(
            co.save_attendance(refused, {"employee": 7, "check_in": self.iso(0, 9), "check_out": self.iso(0, 10)}),
            (409, {"error": "se solapa"}),
        )
        expired = self.client(fail={"read": SessionExpired("caducada")})
        with self.assertRaises(SessionExpired):
            co.save_attendance(expired, {"id": 1, "check_in": self.iso(0, 9), "check_out": self.iso(0, 10)})

    def test_a_request_is_approved_as_the_session_user(self):
        client = self.client()
        self.assertEqual(co.approve_request(client, None), (400, {"error": "Solicitud no válida: None"}))
        self.assertEqual(
            co.approve_request(self.client(fail={"action_approve": OdooError("no eres aprobador")}), 1),
            (409, {"error": "no eres aprobador"}),
        )
        with self.assertRaises(SessionExpired):
            co.approve_request(self.client(fail={"action_approve": SessionExpired("caducada")}), 1)
        self.assertEqual(list(dt._data_cache), [("sid", None)])
        self.assertEqual(co.approve_request(client, "552"), (200, {"ok": True}))
        self.assertEqual(client.calls, [("approval.request", "action_approve", [[552]])])
        self.assertEqual(dt._data_cache, {})

    def test_a_punch_is_deleted_for_good(self):
        client = self.client()
        self.assertEqual(co.delete_attendance(client, None), (400, {"error": "Fichaje no válido: None"}))
        self.assertEqual(
            co.delete_attendance(self.client(fail={"unlink": OdooError("no puedes borrarlo")}), 1),
            (409, {"error": "no puedes borrarlo"}),
        )
        self.assertEqual(list(dt._data_cache), [("sid", None)])
        self.assertEqual(co.delete_attendance(client, "31512"), (200, {"ok": True}))
        self.assertEqual(client.calls, [("hr.attendance", "unlink", [[31512]])])
        self.assertEqual(dt._data_cache, {})


class CorrectionRulesTest(unittest.TestCase):
    def iso(self, day, hour, minute=0):
        return datetime.combine(MONDAY + timedelta(days=day), time(hour, minute)).astimezone().isoformat()

    def test_a_stamp_is_odoos_utc_whatever_zone_the_page_sent(self):
        self.assertEqual(cr.odoo_stamp("2025-03-04T08:34:00Z"), "2025-03-04 08:34:00")
        self.assertEqual(cr.odoo_stamp("2025-03-04T09:34:00+01:00"), "2025-03-04 08:34:00")

    def test_a_body_becomes_what_is_written_and_a_reason_replaces_the_old_ones(self):
        times = {"check_in": self.iso(0, 9), "check_out": self.iso(0, 10)}
        plain = {"check_in": at(0, 9), "check_out": at(0, 10)}
        self.assertEqual(cr.attendance_edit({"id": "5", **times}), cr.AttendanceEdit(5, 0, plain))
        self.assertEqual(
            cr.attendance_edit({"employee": 7, "reason": "3", **times}),
            cr.AttendanceEdit(0, 7, {**plain, "attendance_reason_ids": [[cr.REPLACE, 0, [3]]]}),
        )

    def test_a_body_that_cannot_be_written_says_why(self):
        times = {"check_in": self.iso(0, 9), "check_out": self.iso(0, 10)}
        self.assertEqual(cr.attendance_edit({}), "Entrada, salida o motivo no válidos")
        self.assertEqual(cr.attendance_edit({"id": 1, "reason": "x", **times}), "Entrada, salida o motivo no válidos")
        self.assertEqual(
            cr.attendance_edit({"id": 1, "check_in": times["check_out"], "check_out": times["check_in"]}),
            "La salida tiene que ser posterior a la entrada",
        )
        self.assertEqual(cr.attendance_edit(times), "Falta el fichaje o la persona")

    def test_only_a_punch_shortened_past_its_day_can_lose_a_check_in(self):
        self.assertEqual(cr.lost_window(at(1, 8, 34), at(0, 17)), (at(1, 8, 34), at(1, 8, 44)))
        self.assertIsNone(cr.lost_window(at(0, 18), at(0, 17)))
        self.assertIsNone(cr.lost_window(at(1, 8), at(1, 17)))
        self.assertIsNone(cr.lost_window(None, at(0, 17)))


if __name__ == "__main__":
    unittest.main()
