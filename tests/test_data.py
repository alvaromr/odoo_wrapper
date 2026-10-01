"""Unit tests for the Odoo payload: time helpers, schedule, absences, the cache, the full build and punching."""

import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from helpers import NORMAL, REST, ScriptedClient, temp_state, utc
from odoo_wrapper import data as dt
from odoo_wrapper import state as st


class TimeTest(unittest.TestCase):
    def test_local_converts_from_utc(self):
        stamp = dt.local("2026-06-05 07:00:00")
        self.assertEqual(stamp.astimezone(timezone.utc).hour, 7)
        self.assertIsNotNone(stamp.tzinfo)

    def test_week_monday(self):
        monday = dt.week_monday(datetime(2026, 9, 9, 15, 30))
        self.assertEqual(monday, datetime(2026, 9, 7))
        self.assertEqual(dt.week_monday(monday), monday)


class ScheduleTest(unittest.TestCase):
    WORKDAY = [
        {"dayofweek": "0", "hour_from": 9.0, "hour_to": 14.0, "day_period": "morning"},
        {"dayofweek": "0", "hour_from": 15.0, "hour_to": 18.5, "day_period": "afternoon"},
        {"dayofweek": "4", "hour_from": 9.0, "hour_to": 15.0, "day_period": "morning"},
    ]

    def test_sums_hours_per_day(self):
        schedule = dt.schedule_from(self.WORKDAY)
        self.assertEqual(schedule["hours"], [8.5, 0, 0, 0, 6.0, 0, 0])

    def test_a_gap_between_blocks_means_lunch_from_its_start(self):
        schedule = dt.schedule_from(self.WORKDAY)
        self.assertEqual(schedule["lunch_from"], [14.0, None, None, None, None, None, None])

    def test_an_explicit_lunch_block_is_not_worked_time(self):
        schedule = dt.schedule_from([
            {"dayofweek": "1", "hour_from": 8.0, "hour_to": 17.0, "day_period": "morning"},
            {"dayofweek": "1", "hour_from": 13.0, "hour_to": 14.0, "day_period": "lunch"},
        ])
        self.assertEqual(schedule["hours"][1], 9.0)
        self.assertEqual(schedule["lunch_from"][1], 13.0)

    def test_ignores_unusable_rows(self):
        schedule = dt.schedule_from(self.WORKDAY + [
            {"dayofweek": "9", "hour_from": 9.0, "hour_to": 10.0},
            {"dayofweek": "2", "hour_from": 10.0, "hour_to": 9.0},
            {"dayofweek": None, "hour_from": None, "hour_to": None},
            {},
        ])
        self.assertEqual(schedule["hours"], [8.5, 0, 0, 0, 6.0, 0, 0])

    def test_an_empty_calendar_has_no_schedule(self):
        self.assertIsNone(dt.schedule_from([]))
        self.assertIsNone(dt.schedule_from([{"dayofweek": "0", "hour_from": 9.0, "hour_to": 9.0}]))

    def test_schedule_needs_a_calendar(self):
        client = ScriptedClient({"resource.calendar.attendance": [
            {"dayofweek": "0", "hour_from": 9.0, "hour_to": 17.0, "day_period": "morning"}]})
        self.assertIsNone(dt.fetch_schedule(client, None))
        self.assertEqual(dt.fetch_schedule(client, 4)["hours"][0], 8.0)
        self.assertEqual(client.calls[0][1], [[("calendar_id", "=", 4)]])


class AbsencesTest(unittest.TestCase):
    def absences(self, holidays=(), leaves=()):
        client = ScriptedClient({"resource.calendar.leaves": list(holidays), "hr.leave": list(leaves)})
        return dt.fetch_absences(client, "2026-08-01", [4]), client

    def test_holidays_skip_the_weekend(self):
        out, client = self.absences([{"name": "Puente", "date_from": "2026-08-07 12:00:00", "date_to": "2026-08-10 12:00:00"}])
        self.assertEqual(out, [{"date": "2026-08-07", "type": "Puente"}, {"date": "2026-08-10", "type": "Puente"}])
        self.assertIn(("calendar_id", "in", [4]), client.calls[0][1][0])

    def test_full_day_leaves_cover_each_working_day(self):
        out, _ = self.absences(leaves=[{
            "request_date_from": "2026-08-13", "request_date_to": "2026-08-17",
            "holiday_status_id": [1, "Vacaciones"], "number_of_days": 3, "number_of_hours": 24,
            "date_from": "2026-08-13 06:00:00", "date_to": "2026-08-17 16:00:00",
        }])
        self.assertEqual([a["date"] for a in out], ["2026-08-13", "2026-08-14", "2026-08-17"])
        self.assertTrue(all(a["type"] == "Vacaciones" and "hours" not in a for a in out))

    def test_a_holiday_wins_over_a_leave_on_the_same_day(self):
        out, _ = self.absences(
            [{"name": "Festivo", "date_from": "2026-08-13 12:00:00", "date_to": "2026-08-13 12:00:00"}],
            [{"request_date_from": "2026-08-13", "request_date_to": "2026-08-13", "holiday_status_id": False,
              "number_of_days": 1, "number_of_hours": 8, "date_from": "2026-08-13 06:00:00", "date_to": "2026-08-13 16:00:00"}])
        self.assertEqual(out, [{"date": "2026-08-13", "type": "Festivo"}])

    def test_an_unnamed_leave_is_an_absence(self):
        out, _ = self.absences(leaves=[{
            "request_date_from": "2026-08-12", "request_date_to": "2026-08-12", "holiday_status_id": False,
            "number_of_days": 1, "number_of_hours": 8, "date_from": "2026-08-12 06:00:00", "date_to": "2026-08-12 16:00:00",
        }])
        self.assertEqual(out[0]["type"], "Ausencia")

    def test_hour_leaves_keep_their_hours_and_span(self):
        out, _ = self.absences(leaves=[{
            "request_date_from": "2026-06-05", "request_date_to": "2026-06-05", "holiday_status_id": [30, "Médico"],
            "number_of_days": 0.208, "number_of_hours": 2.5, "date_from": "2026-06-05 07:00:00", "date_to": "2026-06-05 09:30:00",
        }])
        self.assertEqual(len(out), 1)
        self.assertEqual((out[0]["date"], out[0]["type"], out[0]["hours"]), ("2026-06-05", "Médico", 2.5))
        self.assertEqual(out[0]["from"], dt.local("2026-06-05 07:00:00").isoformat())
        self.assertEqual(out[0]["to"], dt.local("2026-06-05 09:30:00").isoformat())

    def test_weekend_only_leaves_are_dropped(self):
        out, _ = self.absences(leaves=[{
            "request_date_from": "2026-08-15", "request_date_to": "2026-08-16", "holiday_status_id": [1, "X"],
            "number_of_days": 0, "number_of_hours": 0, "date_from": "2026-08-15 06:00:00", "date_to": "2026-08-16 16:00:00",
        }])
        self.assertEqual(out, [])


class DataCacheTest(unittest.TestCase):
    def setUp(self):
        self.calls = 0
        original = dt.build_data
        dt.build_data = self.count
        self.addCleanup(setattr, dt, "build_data", original)
        self.addCleanup(dt.drop_data_cache)
        dt.drop_data_cache()

    def count(self, client, employee=None):
        self.calls += 1
        return dict({"call": self.calls, "client": client.session_id}, **({"employee": employee} if employee else {}))

    def fetch(self, session_id, fresh=False, employee=None):
        return dt.fetch_data(SimpleNamespace(session_id=session_id), fresh, employee)

    def test_serves_the_same_payload_within_the_ttl_per_session(self):
        self.assertEqual(self.fetch("one"), {"call": 1, "client": "one"})
        self.assertEqual(self.fetch("one"), {"call": 1, "client": "one"})
        self.assertEqual(self.fetch("other"), {"call": 2, "client": "other"})
        self.assertEqual(self.fetch("one"), {"call": 1, "client": "one"})
        self.assertEqual(self.calls, 2)

    def test_fresh_bypasses_it(self):
        self.fetch("one")
        self.assertEqual(self.fetch("one", fresh=True)["call"], 2)

    def test_someone_elses_week_keeps_longer(self):
        self.fetch("one", employee=9)
        with patch.object(dt, "DATA_TTL", -1):
            self.assertEqual(self.fetch("one", employee=9)["call"], 1)
            self.assertEqual(self.fetch("one")["call"], 2)
        with patch.object(dt, "VIEW_TTL", -1):
            self.assertEqual(self.fetch("one", employee=9)["call"], 3)

    def test_someone_elses_week_has_its_own_entry(self):
        self.assertEqual(self.fetch("one")["call"], 1)
        self.assertEqual(self.fetch("one", employee=9), {"call": 2, "client": "one", "employee": 9})
        self.assertEqual(self.fetch("one", employee=9)["call"], 2)
        self.assertEqual(self.fetch("one")["call"], 1)

    def test_a_punch_drops_every_session(self):
        self.fetch("one")
        self.fetch("other")
        dt.drop_data_cache()
        self.assertEqual(self.fetch("one")["call"], 3)
        self.assertEqual(self.fetch("other")["call"], 4)

    def test_it_expires(self):
        self.fetch("one")
        original = dt.DATA_TTL
        dt.DATA_TTL = -1
        self.addCleanup(setattr, dt, "DATA_TTL", original)
        self.assertEqual(self.fetch("one")["call"], 2)


class ContractHoursTest(unittest.TestCase):
    EIGHT = {"hours": [8, 8, 8, 8, 8, 0, 0], "lunch_from": [None] * 7}

    def client(self):
        def blocks(args, kwargs):
            return [{"dayofweek": str(d), "hour_from": 9.0, "hour_to": 14.0, "day_period": "morning"} for d in range(5)]
        return ScriptedClient({"resource.calendar.attendance": blocks})

    def test_only_days_whose_contract_asks_for_other_hours_are_listed(self):
        contracts = [
            {"employee_id": [7, "Ana"], "date_start": "2025-03-05", "date_end": "2025-03-06", "resource_calendar_id": [9, "25 h"]},
            {"employee_id": [7, "Ana"], "date_start": "2025-03-07", "date_end": False, "resource_calendar_id": [4, "Std"]},
        ]
        out = dt.contract_hours(self.client(), self.EIGHT, contracts, date(2025, 3, 3), date(2025, 3, 10))
        self.assertEqual(out, {"2025-03-03": 0, "2025-03-04": 0, "2025-03-05": 5.0, "2025-03-06": 5.0})

    def test_without_contracts_or_a_current_calendar(self):
        self.assertEqual(dt.contract_hours(self.client(), self.EIGHT, [], date(2025, 3, 3), date(2025, 3, 10)), {})
        contracts = [{"employee_id": [7, "Ana"], "date_start": "2025-03-03", "date_end": False,
                      "resource_calendar_id": [9, "25 h"]}]
        out = dt.contract_hours(self.client(), None, contracts, date(2025, 3, 3), date(2025, 3, 5))
        self.assertEqual(out, {"2025-03-03": 5.0, "2025-03-04": 5.0})


class BuildDataTest(unittest.TestCase):
    def setUp(self):
        temp_state(self)
        self.addCleanup(dt.drop_data_cache)

    def build(self, records, reasons=(NORMAL, REST), rows=None):
        rows = {
            "hr.attendance": records,
            "hr.attendance.reason": [r for r in reasons if r],
            "resource.calendar.leaves": [], "hr.leave": [],
            "resource.calendar.attendance": [{"dayofweek": "0", "hour_from": 9.0, "hour_to": 17.0, "day_period": "morning"}],
            **(rows or {}),
        }
        client = ScriptedClient(rows, reasons=reasons)
        return dt.build_data(client), client

    def test_sessions_carry_reason_and_open_state(self):
        payload, _ = self.build([
            {"check_in": "2026-09-07 07:00:00", "check_out": "2026-09-07 10:00:00", "worked_hours": 3.0, "attendance_reason_ids": [5]},
            {"check_in": "2026-09-07 10:00:00", "check_out": "2026-09-07 10:15:00", "worked_hours": 0.25, "attendance_reason_ids": [3]},
            {"check_in": utc(20), "check_out": False, "worked_hours": 0, "attendance_reason_ids": [99]},
        ])
        work, rest, open_one = payload["sessions"]
        self.assertEqual((work["hours"], work["rest"], work["reason"]), (3.0, False, "Normal"))
        self.assertEqual((rest["hours"], rest["rest"], rest["reason"]), (0.25, True, "Descanso"))
        self.assertEqual((open_one["out"], open_one["hours"], open_one["rest"], open_one["reason"]), (None, None, False, None))
        self.assertEqual(work["in"], dt.local("2026-09-07 07:00:00").isoformat())
        self.assertEqual(payload["employee"], "Ana")
        self.assertTrue(payload["breaks"])
        self.assertNotIn("phone", payload)
        self.assertEqual(payload["schedule"]["hours"][0], 8.0)
        self.assertEqual(payload["absences"], [])
        self.assertFalse(payload["team"])
        self.assertEqual(payload["contract_hours"], {})
        self.assertEqual((payload["long_hours"], payload["work_hours"]), (12, [6.5, 24]))

    def test_without_attendance_reasons(self):
        payload, client = self.build([{"check_in": utc(30), "check_out": False, "worked_hours": 0}], reasons=(None, None))
        self.assertFalse(payload["breaks"])
        self.assertEqual((payload["sessions"][0]["rest"], payload["sessions"][0]["reason"]), (False, None))
        fields = next(kwargs["fields"] for model, _, kwargs in client.calls if model == "hr.attendance")
        self.assertNotIn("attendance_reason_ids", fields)

    def test_history_starts_at_the_oldest_punch_or_min_weeks(self):
        tap = {"check_in": "2024-06-03 08:00:00", "check_out": "2024-06-03 08:00:04", "worked_hours": 0.001, "attendance_reason_ids": []}
        old = {"check_in": "2025-01-08 08:00:00", "check_out": "2025-01-08 16:00:00", "worked_hours": 8.0, "attendance_reason_ids": []}
        payload, client = self.build([tap, old])
        self.assertEqual(payload["since"], "2025-01-06")
        self.assertEqual(payload["employee_id"], 7)
        self.assertEqual([x["in"][:10] for x in payload["sessions"]], ["2025-01-08"])
        today = date.today()
        expected = (today - timedelta(days=today.weekday()) - date(2025, 1, 6)).days // 7 + 1
        self.assertEqual(payload["weeks"], expected)
        self.assertEqual([a[0] for model, a, _ in client.calls if model == "hr.attendance"], [[("employee_id", "=", 7)]])
        self.assertEqual([model for model, _, _ in client.calls].count("hr.employee"), 0)
        payload, _ = self.build([])
        self.assertEqual(payload["weeks"], dt.MIN_WEEKS)
        self.assertEqual(payload["since"], (today - timedelta(days=today.weekday())).isoformat())

    def test_holidays_are_asked_for_every_calendar_the_contracts_had(self):
        payload, client = self.build(
            [{"check_in": "2024-07-22 08:00:00", "check_out": "2024-07-22 12:00:00", "worked_hours": 4.0, "attendance_reason_ids": []}],
            rows={
                "hr.contract": [{"employee_id": [7, "Ana"], "date_start": "2024-07-15", "date_end": "2025-09-30",
                                 "resource_calendar_id": [9, "20 h"]}],
                "resource.calendar.leaves": [{"name": "Santiago", "date_from": "2024-07-25 07:00:00",
                                              "date_to": "2024-07-25 16:30:00", "calendar_id": [9, "20 h"]}],
            })
        domains = {model: args[0] for model, args, _ in client.calls}
        self.assertIn(("calendar_id", "in", [4, 9]), domains["resource.calendar.leaves"])
        self.assertIn(("employee_id", "in", [7]), domains["hr.contract"])
        self.assertEqual([model for model, _, _ in client.calls].count("hr.contract"), 1)
        self.assertEqual(payload["absences"], [{"date": "2024-07-25", "type": "Santiago"}])

    def test_someone_elses_week_is_loaded_by_id_and_leaves_the_state_alone(self):
        stamp = (datetime.now().astimezone() - timedelta(hours=1)).isoformat()
        st.write_state(3, lunch=stamp)
        client = ScriptedClient({
            "hr.attendance": [{"check_in": utc(30), "check_out": False, "worked_hours": 0, "attendance_reason_ids": []}],
            "hr.attendance.reason": [NORMAL, REST], "resource.calendar.leaves": [], "hr.leave": [],
            "resource.calendar.attendance": [],
        })
        client.load_other = lambda employee: setattr(client, "employee_id", employee)
        dt.build_data(client, 42)
        self.assertEqual(client.employee_id, 42)
        self.assertEqual(st.read_state(3)["lunch"], stamp)
        self.assertIn([("employee_id", "=", 42)], [a[0] for model, a, _ in client.calls if model == "hr.attendance"])

    def test_a_punch_after_the_lunch_stamp_clears_it(self):
        stamp = (datetime.now().astimezone() - timedelta(hours=1)).isoformat()
        st.write_state(3, lunch=stamp)
        self.build([{"check_in": utc(120), "check_out": utc(90), "worked_hours": 0.5, "attendance_reason_ids": []}])
        self.assertEqual(st.read_state(3)["lunch"], stamp)
        self.build([{"check_in": utc(30), "check_out": False, "worked_hours": 0, "attendance_reason_ids": []}])
        self.assertIsNone(st.read_state(3)["lunch"])


class PunchTest(unittest.TestCase):
    def setUp(self):
        temp_state(self)
        self.addCleanup(dt.drop_data_cache)

    def punch(self, action, open_att=None, reasons=(NORMAL, REST), open_reason_ids=(5,)):
        client = ScriptedClient({"hr.attendance": [{"attendance_reason_ids": list(open_reason_ids)}]}, open_att, reasons)
        status, body = dt.punch(client, action)
        return status, body, client

    def test_unknown_action(self):
        status, _, client = self.punch("bogus")
        self.assertEqual(status, 400)
        self.assertEqual(client.punches, [])

    def test_without_reasons_punches_are_plain_and_breaks_refused(self):
        status, _, client = self.punch("checkin", reasons=(None, None))
        self.assertEqual((status, client.punches), (200, [None]))
        status, _, client = self.punch("checkout", open_att={"id": 1}, reasons=(None, None))
        self.assertEqual((status, client.punches), (200, [None]))
        self.assertEqual([model for model, _, _ in client.calls], [])
        status, payload, client = self.punch("break", open_att={"id": 1}, reasons=(NORMAL, None))
        self.assertEqual((status, client.punches), (409, []))
        self.assertIn("Descanso", payload["error"])
        self.assertEqual(self.punch("resume", open_att={"id": 1}, reasons=(NORMAL, None), open_reason_ids=(3,))[0], 409)

    def test_checkin_and_checkout(self):
        self.assertEqual(self.punch("checkin", open_att={"id": 1})[0], 409)
        status, _, client = self.punch("checkin")
        self.assertEqual((status, client.punches), (200, [5]))
        self.assertEqual(self.punch("checkout")[0], 409)
        status, _, client = self.punch("checkout", open_att={"id": 1})
        self.assertEqual((status, client.punches), (200, [None]))

    def test_break_and_resume(self):
        self.assertEqual(self.punch("break")[0], 409)
        self.assertEqual(self.punch("break", open_att={"id": 1}, open_reason_ids=(3,))[0], 409)
        status, _, client = self.punch("break", open_att={"id": 1})
        self.assertEqual((status, client.punches), (200, [None, 3]))
        self.assertEqual(self.punch("resume")[0], 409)
        self.assertEqual(self.punch("resume", open_att={"id": 1})[0], 409)
        status, _, client = self.punch("resume", open_att={"id": 1}, open_reason_ids=(3,))
        self.assertEqual((status, client.punches), (200, [None, 5]))

    def test_lunch_stamps_the_state_and_other_punches_clear_it(self):
        self.assertEqual(self.punch("lunch")[0], 409)
        dt._data_cache[("sid", None)] = (0, {})
        status, _, client = self.punch("lunch", open_att={"id": 1})
        self.assertEqual((status, client.punches), (200, [None]))
        self.assertEqual(dt._data_cache, {})
        state = st.read_state(3)
        self.assertTrue(state["lunch"] and state["lunch_done"] and state["punched_at"])
        self.punch("checkin")
        state = st.read_state(3)
        self.assertIsNone(state["lunch"])
        self.assertTrue(state["lunch_done"])


if __name__ == "__main__":
    unittest.main()
