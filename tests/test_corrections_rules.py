"""Unit tests for the day dialog's rules: what a correction body asks for, and when a check-in could be lost."""

import unittest
from datetime import date, datetime, time, timedelta, timezone

import helpers  # noqa: F401 - puts the package on the path, fixes the zone and refuses the network when run alone

from odoo_wrapper import corrections_rules as cr

MONDAY = date(2025, 3, 3)


def at(day, hour, minute=0):
    local = datetime.combine(MONDAY + timedelta(days=day), time(hour, minute)).astimezone()
    return local.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def iso(day, hour, minute=0):
    return datetime.combine(MONDAY + timedelta(days=day), time(hour, minute)).astimezone().isoformat()


class CorrectionRulesTest(unittest.TestCase):
    def test_a_stamp_is_odoos_utc_whatever_zone_the_page_sent(self):
        self.assertEqual(cr.odoo_stamp("2025-03-04T08:34:00Z"), "2025-03-04 08:34:00")
        self.assertEqual(cr.odoo_stamp("2025-03-04T09:34:00+01:00"), "2025-03-04 08:34:00")

    def test_a_body_becomes_what_is_written_and_a_reason_replaces_the_old_ones(self):
        times = {"check_in": iso(0, 9), "check_out": iso(0, 10)}
        plain = {"check_in": at(0, 9), "check_out": at(0, 10)}
        self.assertEqual(cr.attendance_edit({"id": "5", **times}), cr.AttendanceEdit(5, 0, plain))
        self.assertEqual(
            cr.attendance_edit({"employee": 7, "reason": "3", **times}),
            cr.AttendanceEdit(0, 7, {**plain, "attendance_reason_ids": [[cr.REPLACE, 0, [3]]]}),
        )

    def test_a_body_that_cannot_be_written_says_why(self):
        times = {"check_in": iso(0, 9), "check_out": iso(0, 10)}
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
