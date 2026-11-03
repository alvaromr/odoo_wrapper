"""Unit tests for the personal payload's rules: time helpers, schedules and the hours each contract asks for."""

import unittest
from datetime import date, datetime, timezone

import helpers  # noqa: F401 - puts the package on the path, fixes the zone and refuses the network when run alone

from odoo_wrapper import data_rules as dr


class TimeTest(unittest.TestCase):
    def test_local_converts_from_utc(self):
        stamp = dr.local("2026-06-05 07:00:00")
        self.assertEqual(stamp.astimezone(timezone.utc).hour, 7)
        self.assertIsNotNone(stamp.tzinfo)

    def test_a_week_starts_at_midnight_of_its_monday(self):
        monday = dr.week_monday(datetime(2026, 9, 9, 15, 30))
        self.assertEqual(monday, datetime(2026, 9, 7))
        self.assertEqual(dr.week_monday(monday), monday)
        self.assertEqual(dr.week_monday(datetime(2026, 9, 9, 15, 30, 45, 123)), datetime(2026, 9, 7))


class ScheduleTest(unittest.TestCase):
    WORKDAY = [
        {"dayofweek": "0", "hour_from": 9.0, "hour_to": 14.0, "day_period": "morning"},
        {"dayofweek": "0", "hour_from": 15.0, "hour_to": 18.5, "day_period": "afternoon"},
        {"dayofweek": "4", "hour_from": 9.0, "hour_to": 15.0, "day_period": "morning"},
    ]

    def test_sums_hours_per_day(self):
        schedule = dr.schedule_from(self.WORKDAY)
        self.assertEqual(schedule["hours"], [8.5, 0, 0, 0, 6.0, 0, 0])

    def test_a_gap_between_blocks_means_lunch_from_its_start(self):
        schedule = dr.schedule_from(self.WORKDAY)
        self.assertEqual(schedule["lunch_from"], [14.0, None, None, None, None, None, None])

    def test_an_explicit_lunch_block_is_not_worked_time(self):
        schedule = dr.schedule_from(
            [
                {"dayofweek": "1", "hour_from": 8.0, "hour_to": 17.0, "day_period": "morning"},
                {"dayofweek": "1", "hour_from": 13.0, "hour_to": 14.0, "day_period": "lunch"},
            ]
        )
        self.assertEqual(schedule["hours"][1], 9.0)
        self.assertEqual(schedule["lunch_from"][1], 13.0)

    def test_ignores_unusable_rows(self):
        schedule = dr.schedule_from(
            self.WORKDAY
            + [
                {"dayofweek": "9", "hour_from": 9.0, "hour_to": 10.0},
                {"dayofweek": "2", "hour_from": 10.0, "hour_to": 9.0},
            ]
        )
        self.assertEqual(schedule["hours"], [8.5, 0, 0, 0, 6.0, 0, 0])

    def test_a_bad_row_or_a_lunch_block_never_cuts_the_rows_after_it(self):
        schedule = dr.schedule_from(
            [
                {"dayofweek": "7", "hour_from": 9.0, "hour_to": 10.0},
                {"dayofweek": "2", "hour_from": 10.0, "hour_to": 9.0},
                {"dayofweek": "1", "hour_from": 13.0, "hour_to": 14.0, "day_period": "lunch"},
                {"dayofweek": "6", "hour_from": 9.0, "hour_to": 17.3333},
            ]
        )
        self.assertEqual(schedule["hours"], [0, 0, 0, 0, 0, 0, 8.33])

    def test_lunch_is_a_real_gap_between_blocks_and_a_block_of_no_length_counts_for_nothing(self):
        joined = dr.schedule_from(
            [
                {"dayofweek": "0", "hour_from": 9.0, "hour_to": 13.0},
                {"dayofweek": "0", "hour_from": 13.0, "hour_to": 17.0},
            ]
        )
        self.assertEqual(joined["lunch_from"][0], None)
        empty_first = dr.schedule_from(
            [
                {"dayofweek": "0", "hour_from": 8.0, "hour_to": 8.0},
                {"dayofweek": "0", "hour_from": 9.0, "hour_to": 13.0},
                {"dayofweek": "0", "hour_from": 15.0, "hour_to": 18.0},
            ]
        )
        self.assertEqual(empty_first["lunch_from"][0], 13.0)

    def test_a_block_odoo_sends_without_its_hours_fails_rather_than_counting_for_nothing(self):
        with self.assertRaises(KeyError):
            dr.schedule_from([{"dayofweek": "0", "hour_from": 9.0}])

    def test_an_empty_calendar_has_no_schedule(self):
        self.assertIsNone(dr.schedule_from([]))
        self.assertIsNone(dr.schedule_from([{"dayofweek": "0", "hour_from": 9.0, "hour_to": 9.0}]))


class ContractHoursTest(unittest.TestCase):
    EIGHT = {"hours": [8, 8, 8, 8, 8, 0, 0], "lunch_from": [None] * 7}

    SHORT = dr.schedule_from(
        [{"dayofweek": str(d), "hour_from": 9.0, "hour_to": 14.0, "day_period": "morning"} for d in range(5)]
    )

    def test_only_days_whose_contract_asks_for_other_hours_are_listed(self):
        contracts = [
            {
                "employee_id": [7, "Ana"],
                "date_start": "2025-03-05",
                "date_end": "2025-03-06",
                "resource_calendar_id": [9, "25 h"],
            },
            {
                "employee_id": [7, "Ana"],
                "date_start": "2025-03-07",
                "date_end": False,
                "resource_calendar_id": [4, "Std"],
            },
        ]
        schedules = {4: self.EIGHT, 9: self.SHORT}
        out = dr.contract_hours(schedules, 4, contracts, date(2025, 3, 3), date(2025, 3, 10))
        self.assertEqual(out, {"2025-03-03": 0, "2025-03-04": 0, "2025-03-05": 5.0, "2025-03-06": 5.0})

    def test_without_contracts_or_a_current_calendar(self):
        self.assertEqual(
            dr.contract_hours({4: self.EIGHT}, 4, [], date(2025, 3, 3), date(2025, 3, 10)),
            {},
        )
        contracts = [
            {
                "employee_id": [7, "Ana"],
                "date_start": "2025-03-03",
                "date_end": False,
                "resource_calendar_id": [9, "25 h"],
            }
        ]
        out = dr.contract_hours({4: None, 9: self.SHORT}, 4, contracts, date(2025, 3, 3), date(2025, 3, 10))
        self.assertEqual(out, {f"2025-03-0{d}": 5.0 for d in range(3, 8)})


if __name__ == "__main__":
    unittest.main()
