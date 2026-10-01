"""Unit tests for the day dialog's writes: correcting and adding punches, approving requests, the lost check-in."""
import unittest
import unittest.mock
from datetime import date, datetime, time, timedelta, timezone
from types import SimpleNamespace

from odoo_wrapper import corrections as co, data as dt
from odoo_wrapper.client import OdooError, SessionExpired

MONDAY = date(2025, 3, 3)


def at(day, hour, minute=0):
    local = datetime.combine(MONDAY + timedelta(days=day), time(hour, minute)).astimezone()
    return local.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


class CorrectionsTest(unittest.TestCase):
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
        with unittest.mock.patch.object(dt, "drop_data_cache") as drop:
            status, body = co.save_attendance(client, {"id": 31512, "check_in": self.iso(0, 9), "check_out": self.iso(0, 17, 40)})
        self.assertEqual((status, body), (200, {"ok": True, "lost_entry": None}))
        self.assertEqual(client.calls[1], ("hr.attendance", "write", [[31512], {"check_in": at(0, 9), "check_out": at(0, 17, 40)}]))
        drop.assert_called_once()

    def test_shortening_into_the_same_day_warns_when_the_next_check_in_would_be_lost(self):
        body = {"id": 1, "check_in": self.iso(0, 16, 7), "check_out": self.iso(0, 17, 40)}
        lonely = self.client({"read": [{"employee_id": [7, "x"], "check_out": at(1, 8, 34)}], "search_count": 0})
        self.assertEqual(co.save_attendance(lonely, body)[1]["lost_entry"], dt.local(at(1, 8, 34)).isoformat())
        domain = lonely.calls[-1][2][0]
        self.assertEqual(domain, [("employee_id", "=", 7), ("check_in", ">=", at(1, 8, 34)), ("check_in", "<=", at(1, 8, 44))])
        repunched = self.client({"read": [{"employee_id": [7, "x"], "check_out": at(1, 8, 34)}], "search_count": 1})
        self.assertIsNone(co.save_attendance(repunched, body)[1]["lost_entry"])
        closing = self.client({"read": [{"employee_id": [7, "x"], "check_out": False}]})
        self.assertIsNone(co.save_attendance(closing, body)[1]["lost_entry"])

    def test_a_new_punch_is_created_for_the_employee(self):
        client = self.client()
        status, _ = co.save_attendance(client, {"employee": "7", "check_in": "2025-03-04T08:34:00Z", "check_out": "2025-03-04T15:00:00.000Z"})
        self.assertEqual(status, 200)
        self.assertEqual(client.calls, [("hr.attendance", "create",
                                         [{"employee_id": 7, "check_in": "2025-03-04 08:34:00", "check_out": "2025-03-04 15:00:00"}])])

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
        for body in ({}, {"check_in": "x", "check_out": "y"}, {"id": "z", "check_in": self.iso(0, 9), "check_out": self.iso(0, 10)},
                     {"id": 1, "reason": "x", "check_in": self.iso(0, 9), "check_out": self.iso(0, 10)}):
            self.assertEqual(co.save_attendance(client, body)[0], 400)
        self.assertEqual(co.save_attendance(client, {"id": 1, "check_in": self.iso(0, 10), "check_out": self.iso(0, 9)}),
                         (400, {"error": "La salida tiene que ser posterior a la entrada"}))
        self.assertEqual(co.save_attendance(client, {"check_in": self.iso(0, 9), "check_out": self.iso(0, 10)}),
                         (400, {"error": "Falta el fichaje o la persona"}))
        self.assertEqual(client.calls, [])
        refused = self.client(fail={"create": OdooError("se solapa")})
        self.assertEqual(co.save_attendance(refused, {"employee": 7, "check_in": self.iso(0, 9), "check_out": self.iso(0, 10)}),
                         (409, {"error": "se solapa"}))
        expired = self.client(fail={"read": SessionExpired("caducada")})
        with self.assertRaises(SessionExpired):
            co.save_attendance(expired, {"id": 1, "check_in": self.iso(0, 9), "check_out": self.iso(0, 10)})

    def test_a_request_is_approved_as_the_session_user(self):
        client = self.client()
        with unittest.mock.patch.object(dt, "drop_data_cache") as drop:
            self.assertEqual(co.approve_request(client, "552"), (200, {"ok": True}))
        self.assertEqual(client.calls, [("approval.request", "action_approve", [[552]])])
        drop.assert_called_once()
        self.assertEqual(co.approve_request(client, None)[0], 400)
        self.assertEqual(co.approve_request(self.client(fail={"action_approve": OdooError("no eres aprobador")}), 1),
                         (409, {"error": "no eres aprobador"}))
        with self.assertRaises(SessionExpired):
            co.approve_request(self.client(fail={"action_approve": SessionExpired("caducada")}), 1)


if __name__ == "__main__":
    unittest.main()
