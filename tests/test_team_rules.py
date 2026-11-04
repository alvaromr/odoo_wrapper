"""Unit tests for the management payload's rules: spans, the day, week, month and employee rows, and notices."""

import unittest
from datetime import date, datetime, time, timedelta

import helpers  # noqa: F401 - puts the package on the path, fixes the zone and refuses the network when run alone

from odoo_wrapper import attendance_rules as ar
from odoo_wrapper import team_rules as tr

MONDAY = date(2025, 3, 3)


def row_day(when, hours=0.0, target=8.0, flags=()):
    return {"date": when.isoformat(), "hours": hours, "target": target, "flags": list(flags)}


class HelpersTest(unittest.TestCase):
    def test_odoo_time_is_local_midnight_in_utc(self):
        stamp = tr.odoo_time(MONDAY)
        self.assertEqual(ar.local(stamp), datetime.combine(MONDAY, time()).astimezone())

    def test_month_span_covers_every_week_touching_the_month(self):
        self.assertEqual(tr.month_span(date(2026, 9, 1)), (date(2026, 8, 31), 5, date(2026, 9, 1), date(2026, 10, 1)))
        self.assertEqual(tr.month_span(date(2026, 2, 1)), (date(2026, 1, 26), 5, date(2026, 2, 1), date(2026, 3, 1)))
        self.assertEqual(tr.month_span(date(2026, 12, 1)), (date(2026, 11, 30), 5, date(2026, 12, 1), date(2027, 1, 1)))
        self.assertEqual(tr.month_span(date(2021, 2, 1)), (date(2021, 2, 1), 4, date(2021, 2, 1), date(2021, 3, 1)))
        self.assertEqual(tr.month_span(date(2026, 8, 1)), (date(2026, 7, 27), 6, date(2026, 8, 1), date(2026, 9, 1)))
        self.assertIsInstance(tr.month_span(date(2026, 8, 1))[1], int)

    def test_year_span_covers_every_week_touching_the_year(self):
        self.assertEqual(tr.year_span(2026), (date(2025, 12, 29), 53, date(2026, 1, 1), date(2027, 1, 1)))
        self.assertEqual(tr.year_span(2024), (date(2024, 1, 1), 53, date(2024, 1, 1), date(2025, 1, 1)))
        self.assertEqual(tr.year_span(2023), (date(2022, 12, 26), 53, date(2023, 1, 1), date(2024, 1, 1)))
        self.assertEqual(tr.year_span(2029), (date(2029, 1, 1), 53, date(2029, 1, 1), date(2030, 1, 1)))
        self.assertIsInstance(tr.year_span(2029)[1], int)

    def test_any_day_belongs_to_the_week_of_its_monday(self):
        self.assertEqual(tr.monday_of(date(2025, 3, 9)), MONDAY)
        self.assertEqual(tr.monday_of(MONDAY), MONDAY)


class RowRulesTest(unittest.TestCase):
    """The day, week and month rows at the edges of each rule, where a flipped comparison would hide."""

    def test_a_day_rounds_to_hundredths_and_flags_at_the_edges(self):
        day = MONDAY
        session = {"in": f"{day}T08:00:00", "out": f"{day}T09:00:00", "hours": 1.2345}
        row = tr.day_row(day, 7.4567, None, ([session], []), day + timedelta(days=1))
        self.assertEqual((row["hours"], row["target"], row["flags"]), (1.23, 7.46, []))
        self.assertEqual(tr.day_row(day, 0.5, None, ([], []), day + timedelta(days=1))["flags"], ["empty"])
        self.assertEqual(tr.day_row(day, 0, None, ([], []), day + timedelta(days=1))["flags"], [])
        exactly_long = dict(session, hours=tr.LONG_DAY)
        self.assertEqual(tr.day_row(day, 8, None, ([exactly_long], []), day)["flags"], [])

    def test_a_week_is_judged_once_it_is_over_and_flagged_at_the_edges_of_its_margins(self):
        days = [row_day(MONDAY + timedelta(days=i), hours) for i, hours in enumerate((8.0, 8.0, 8.0, 8.0, 8.0))]
        target = 40.0

        def flags(total, today=MONDAY + timedelta(days=7)):
            week = [dict(d, hours=total / 5) for d in days]
            return tr.week_row(MONDAY, week, True, today)["flags"]

        self.assertEqual(flags(target - tr.UNDER_MARGIN), ["under"])
        self.assertEqual(flags(target - tr.UNDER_MARGIN / 2), [])
        self.assertEqual(flags(target + tr.OVER_MARGIN), [])
        self.assertEqual(flags(target + tr.OVER_MARGIN + 0.01), ["over"])
        self.assertEqual(flags(0, MONDAY + timedelta(days=6)), [])

    def test_a_week_sums_only_the_days_before_today_rounded_and_says_when_it_holds_a_long_day(self):
        days = [row_day(MONDAY, 1.2345, 2.3456), row_day(MONDAY + timedelta(days=1), 4.0, 1.1111, ["long"])]
        row = tr.week_row(MONDAY, days, True, MONDAY + timedelta(days=1))
        self.assertEqual(
            (row["hours"], row["target"], row["balance"], row["due"], row["suspect"]), (5.23, 3.46, -1.11, 2.35, True)
        )
        open_only = [row_day(MONDAY, 1, 1, ["open"])]
        self.assertFalse(tr.week_row(MONDAY, open_only, True, MONDAY)["suspect"])
        self.assertEqual(
            [tr.week_row(MONDAY, days, None, MONDAY)[k] for k in ("target", "balance", "due")], [None, None, None]
        )

    def test_a_month_takes_the_weeks_whose_thursday_falls_in_it_and_counts_their_flags(self):
        july = [
            {"monday": "2025-07-28", "flags": ["under", "over"]},
            {"monday": "2025-07-21", "flags": ["under"]},
            {"monday": "2025-06-30", "flags": ["over"]},
            {"monday": "2025-06-23", "flags": ["under"]},
        ]
        employee = {"days": [], "weeks": july, "target": 0}
        row = tr.month_row("2025-07", employee, "2025-07-15")
        self.assertEqual((row["under"], row["over"]), (2, 2))
        september = {"days": [], "weeks": [{"monday": "2025-09-01", "flags": ["under"]}], "target": 0}
        self.assertEqual(tr.month_row("2025-09", september, "2025-09-15")["under"], 1)
        self.assertEqual(tr.month_row("2025-08", september, "2025-09-15")["under"], 0)

    def test_a_month_sums_its_days_before_today_rounded_and_says_when_it_holds_a_long_day(self):
        days = [
            row_day(date(2025, 7, 1), 1.2345, 2.3456),
            row_day(date(2025, 7, 2), 4.0, 1.1111, ["open"]),
            row_day(date(2025, 8, 1), 9.0, 9.0, ["long"]),
        ]
        row = tr.month_row("2025-07", {"days": days, "weeks": [], "target": 0}, "2025-07-02")
        self.assertEqual(
            (row["hours"], row["target"], row["balance"], row["due"], row["suspect"]), (5.23, 3.46, -1.11, 2.35, False)
        )
        days[1]["flags"] = ["long"]
        self.assertTrue(tr.month_row("2025-07", {"days": days, "weeks": [], "target": 0}, "2025-07-02")["suspect"])

    def test_an_employee_adds_up_partial_leaves_starts_on_their_first_week_and_slices_each_week(self):
        schedule = {"hours": [8.5] * 5 + [0, 0]}
        leaves = [{"date": "2025-03-05", "hours": 1}, {"date": "2025-03-05", "hours": 2.25}]
        row = tr.employee_row(
            {"id": 1, "name": "Ana", "since": "2025-03-04"},
            lambda iso: schedule,
            (leaves, [], []),
            (MONDAY, 3),
            MONDAY + timedelta(weeks=2),
        )
        self.assertEqual([d["target"] for d in row["days"][:7]], [0, 8.5, 5.25, 8.5, 8.5, 0, 0])
        self.assertEqual([w["target"] for w in row["weeks"]], [30.75, 42.5, 42.5])
        self.assertEqual((row["target"], row["balance"], row["due"]), (115.75, -73.25, 73.25))

    def test_a_year_keeps_the_payload_has_twelve_months_and_counts_up_to_the_day_before_it_was_built(self):
        days = [row_day(date(2025, 3, 4), 8.0, 8.5), row_day(date(2025, 3, 5), 2.0, 8.5)]
        payload = {
            "generated_at": "2025-03-05T10:00:00",
            "limits": {"long_day": 12},
            "employees": [{"id": 1, "name": "Ana", "target": 17, "days": days, "weeks": []}],
        }
        year = tr.year_payload(payload, 2025)
        self.assertEqual(year["limits"], {"long_day": 12})
        months = year["employees"][0]["months"]
        self.assertEqual(len(months), 12)
        self.assertEqual((months[2]["balance"], months[2]["due"]), (-0.5, 8.5))


class NoticesTest(unittest.TestCase):
    def day(self, when, flags=(), statuses=()):
        return {"date": when, "flags": list(flags), "requests": [{"status": status} for status in statuses]}

    def test_each_day_over_gives_its_first_kind_in_order_of_date_then_name(self):
        payload = {
            "start": "2025-03-03",
            "stop": "2025-03-10",
            "generated_at": "2025-03-06T10:00:00+01:00",
            "employees": [
                {
                    "name": "Bea",
                    "days": [
                        self.day("2025-03-02", ["open"]),
                        self.day("2025-03-03", ["empty"], ["pending"]),
                        self.day("2025-03-04", ["long"], ["new"]),
                        self.day("2025-03-05"),
                        self.day("2025-03-06", ["open"]),
                    ],
                },
                {"name": "Ana", "days": [self.day("2025-03-03", ["open"]), self.day("2025-03-05", ["empty"])]},
            ],
        }
        self.assertEqual(
            tr.notices(payload),
            [
                (date(2025, 3, 3), "Ana", "Incidencia"),
                (date(2025, 3, 3), "Bea", "Solicitud"),
                (date(2025, 3, 4), "Bea", "Solicitud (borrador)"),
                (date(2025, 3, 5), "Ana", "Incidencia"),
            ],
        )

    def test_notices_end_at_the_payloads_stop_when_it_comes_before_the_day_it_was_built(self):
        payload = {
            "start": "2025-03-03",
            "stop": "2025-03-05",
            "generated_at": "2025-03-09T10:00:00+01:00",
            "employees": [
                {"name": "Ana", "days": [self.day("2025-03-04", ["open"]), self.day("2025-03-05", ["open"])]}
            ],
        }
        self.assertEqual(tr.notices(payload), [(date(2025, 3, 4), "Ana", "Incidencia")])


if __name__ == "__main__":
    unittest.main()
