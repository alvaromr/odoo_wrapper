"""Unit tests for the management payload: roster, targets, absences and every flag, against a scripted Odoo."""

import unittest
import unittest.mock
from datetime import date, datetime, time, timedelta, timezone
from types import SimpleNamespace

from helpers import NORMAL, REST, ScriptedClient
from odoo_wrapper import data as dt, team as tm
from odoo_wrapper.client import OdooError, SessionExpired

MONDAY = date(2025, 3, 3)
CALENDAR = [{"calendar_id": [4, "Std"], "dayofweek": str(d), "hour_from": 9.0, "hour_to": 17.0, "day_period": "morning"}
            for d in range(5)]


def at(day, hour, minute=0):
    local = datetime.combine(MONDAY + timedelta(days=day), time(hour, minute)).astimezone()
    return local.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def att(employee, day, start, end, hours, reasons=(5,)):
    return {"employee_id": [employee, "x"], "check_in": at(day, *start), "check_out": end and at(day, *end),
            "worked_hours": hours, "attendance_reason_ids": list(reasons)}


WEEK = [
    att(1, 0, (9, 0), (17, 0), 8.0),
    att(1, 2, (9, 0), None, 0),
    att(1, 4, (9, 0), (9, 3), 0.05),
    att(1, 4, (9, 3), (9, 4), 0.0167, reasons=(3,)),
    dict(att(1, 4, (9, 10), (22, 5), 12.83), check_out=at(5, 0, 5)),
    att(3, 1, (9, 0), (15, 0), 6.0),
] + [att(3, d, (9, 0), (17, 0), 8.0) for d in (2, 3, 4)]
LEFT_OPEN = [{"employee_id": [1, "Ana"], "check_in": "2025-02-20 08:00:00"}]
EMPLOYEES = [
    {"id": 1, "name": "Ana", "resource_calendar_id": [4, "Std"], "user_id": [11, "ana"]},
    {"id": 2, "name": "Bea", "resource_calendar_id": False, "user_id": False},
    {"id": 3, "name": "Carl", "resource_calendar_id": [4, "Std"], "user_id": [13, "carl"]},
    {"id": 5, "name": "Dani", "resource_calendar_id": [4, "Std"], "user_id": False, "active": False,
     "departure_date": "2025-03-04"},
    {"id": 6, "name": "Eva", "resource_calendar_id": [4, "Std"], "user_id": False, "active": False,
     "departure_date": "2025-03-02"},
    {"id": 8, "name": "Fede", "resource_calendar_id": [4, "Std"], "user_id": False, "active": False,
     "departure_date": False},
]
for e in EMPLOYEES:
    e.setdefault("active", True)
    e.setdefault("departure_date", False)
REQUESTS = [
    {"id": 51, "request_owner_id": [11, "ana"], "date_start": at(2, 9), "date_end": at(2, 17, 40), "request_status": "pending",
     "user_status": "pending",
     "reason": "<div>Olvidé fichar&nbsp;la salida</div><div><br></div><div>Salí a las 17:40</div>"},
    {"request_owner_id": [13, "carl"], "date_start": at(1, 9), "date_end": False, "request_status": "approved",
     "reason": False},
]
HOLIDAYS = [
    {"name": "Fiesta", "date_from": at(0, 0), "date_to": at(0, 23), "calendar_id": False},
    {"name": "Otro calendario", "date_from": at(1, 0), "date_to": at(1, 23), "calendar_id": [9, "Otro"]},
]
LEAVES = [
    {"employee_id": [1, "Ana"], "request_date_from": "2025-03-06", "request_date_to": "2025-03-06",
     "holiday_status_id": [1, "Vacaciones"], "number_of_days": 1, "number_of_hours": 8,
     "date_from": at(3, 9), "date_to": at(3, 17)},
    {"employee_id": [3, "Carl"], "request_date_from": "2025-03-04", "request_date_to": "2025-03-04",
     "holiday_status_id": [30, "Médico"], "number_of_days": 0.25, "number_of_hours": 2,
     "date_from": at(1, 15), "date_to": at(1, 17)},
]


LATE = [{"employee_id": [3, "Carl"], "check_in": "2025-02-28 08:00:00", "check_out": "2025-03-03 08:00:00",
         "worked_hours": 72.0}]


FIRST_PUNCH = "2024-01-01 08:00:00"


def attendance(args, kwargs):
    if len(args) == 3 and "check_in:min" in args[1]:
        return [{"employee_id": [e["id"], e["name"]], "check_in": FIRST_PUNCH} for e in EMPLOYEES] + [{"employee_id": False}]
    if len(args) == 3:
        return [{"employee_id": [e["id"], e["name"]]} for e in EMPLOYEES] + [{"employee_id": False}]
    if ("check_out", "!=", False) in args[0]:
        return LATE
    return LEFT_OPEN if ("check_out", "=", False) in args[0] else WEEK


def rows(**extra):
    return dict({
        "hr.attendance": attendance, "hr.employee": EMPLOYEES, "resource.calendar.attendance": CALENDAR,
        "hr.attendance.reason": [NORMAL, REST], "resource.calendar.leaves": HOLIDAYS, "hr.leave": LEAVES,
        "approval.request": REQUESTS,
    }, **extra)


class HelpersTest(unittest.TestCase):
    def test_odoo_time_is_local_midnight_in_utc(self):
        stamp = tm.odoo_time(MONDAY)
        self.assertEqual(dt.local(stamp), datetime.combine(MONDAY, time()).astimezone())

    def test_month_span_covers_every_week_touching_the_month(self):
        self.assertEqual(tm.month_span(date(2026, 9, 1)), (date(2026, 8, 31), 5, date(2026, 9, 1), date(2026, 10, 1)))
        self.assertEqual(tm.month_span(date(2026, 2, 1)), (date(2026, 1, 26), 5, date(2026, 2, 1), date(2026, 3, 1)))
        self.assertEqual(tm.month_span(date(2026, 12, 1)), (date(2026, 11, 30), 5, date(2026, 12, 1), date(2027, 1, 1)))
        self.assertEqual(tm.month_span(date(2021, 2, 1)), (date(2021, 2, 1), 4, date(2021, 2, 1), date(2021, 3, 1)))

    def test_year_span_covers_every_week_touching_the_year(self):
        self.assertEqual(tm.year_span(2026), (date(2025, 12, 29), 53, date(2026, 1, 1), date(2027, 1, 1)))
        self.assertEqual(tm.year_span(2024), (date(2024, 1, 1), 53, date(2024, 1, 1), date(2025, 1, 1)))

    def test_monday_of(self):
        self.assertEqual(tm.monday_of(date(2025, 3, 9)), MONDAY)
        self.assertEqual(tm.monday_of(MONDAY), MONDAY)


class BuildTeamTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(dt.drop_data_cache)
        self.client = ScriptedClient(rows())
        self.payload = tm.build_team(self.client, MONDAY)
        self.people = {e["name"]: e for e in self.payload["employees"]}

    def test_roster_is_who_odoo_lets_the_session_read(self):
        self.assertEqual(list(self.people), ["Ana", "Bea", "Carl", "Dani"])
        self.assertEqual(self.payload["week"], "2025-03-03")
        read = next(args for model, args, _ in self.client.calls if model == "hr.employee")
        self.assertEqual(read, [[1, 2, 3, 5, 6, 8], ["name", "resource_calendar_id", "user_id", "active", "departure_date"]])
        week = next(args for model, args, kwargs in self.client.calls
                    if model == "hr.attendance" and len(args) == 1 and ("check_out", "=", False) not in args[0])
        self.assertIn(("employee_id", "in", [1, 2, 3, 5]), week[0])

    def test_someone_who_left_counts_only_until_their_departure(self):
        dani = self.people["Dani"]
        self.assertEqual([d["target"] for d in dani["days"]], [0, 8, 0, 0, 0, 0, 0])
        self.assertEqual([d["flags"] for d in dani["days"]], [[], ["empty"], [], [], [], [], []])
        self.assertEqual((dani["archived"], dani["departure_date"]), (True, "2025-03-04"))
        self.assertEqual((self.people["Ana"]["archived"], self.people["Ana"]["departure_date"]), (False, False))

    def test_every_day_flag(self):
        flags = [d["flags"] for d in self.people["Ana"]["days"]]
        self.assertEqual(flags, [[], ["empty"], ["open"], [], ["long", "off"], [], []])
        self.assertEqual(self.payload["limits"], {"long_day": 12, "under_margin": 1 / 60, "over_margin": 5,
                                                   "work_from": 6.5, "work_to": 24})
        self.assertTrue(all(d["flags"] == [] for d in self.people["Carl"]["days"]))

    def test_a_session_outside_working_hours_is_off(self):
        day = MONDAY + timedelta(days=1)
        flags = lambda *sessions: tm.day_row(day, 8, None, [dt.session_of(s, {}) for s in sessions], [], date.today())["flags"]
        self.assertEqual(flags(att(1, 1, (6, 30), (15, 30), 9.0)), [])
        self.assertEqual(flags(att(1, 1, (16, 0), (23, 59), 8.0)), [])
        self.assertEqual(flags(att(1, 1, (6, 29), (14, 30), 8.0)), ["off"])
        self.assertEqual(flags(dict(att(1, 1, (16, 0), (23, 59), 8.0), check_out=at(2, 0, 1))), ["off"])
        overnight = att(1, 1, (15, 0), None, 0)
        overnight["check_out"] = at(2, 9)
        overnight["worked_hours"] = 18.0
        self.assertEqual(flags(overnight), ["long", "off"])
        self.assertEqual(self.payload["limits"]["work_from"], 6.5)
        self.assertEqual(self.payload["limits"]["work_to"], 24)

    def test_a_tap_under_a_minute_counts_for_nothing(self):
        tap = att(3, 0, (2, 3), (2, 4), 0.006)
        payload = tm.build_team(ScriptedClient(rows(**{"hr.attendance": lambda args, kwargs:
                                                      attendance(args, kwargs) + ([tap] if len(args) == 1 else [])})), MONDAY)
        carl = next(e for e in payload["employees"] if e["name"] == "Carl")
        self.assertEqual((carl["days"][0]["sessions"], carl["days"][0]["flags"]), ([], []))

    def test_a_short_day_is_no_flag_the_week_decides(self):
        day = MONDAY + timedelta(days=1)
        blip = [dt.session_of(att(1, 1, (9, 0), (9, 0), 0.001), {}), dt.session_of(att(1, 1, (9, 0), (15, 0), 6.0), {})]
        self.assertEqual(tm.day_row(day, 8.5, None, blip, [], date.today())["flags"], [])

    def test_a_long_day_is_flagged_whatever_its_sessions(self):
        day = MONDAY + timedelta(days=1)
        split = [dt.session_of(att(1, 1, (8, 44), (14, 43), 6.0), {}), dt.session_of(att(1, 1, (15, 7), (23, 45), 8.63), {})]
        self.assertEqual(tm.day_row(day, 8.5, None, split, [], date.today())["flags"], ["long"])
        self.assertEqual(tm.day_row(day, 8.5, None, split[:1], [], date.today())["flags"], [])

    def test_targets_follow_calendar_absences_and_partial_leaves(self):
        ana, carl = self.people["Ana"], self.people["Carl"]
        self.assertEqual([d["target"] for d in ana["days"]], [0, 8, 8, 0, 8, 0, 0])
        self.assertEqual(ana["days"][0]["absence"], "Fiesta")
        self.assertEqual(ana["days"][3]["absence"], "Vacaciones")
        self.assertEqual([d["target"] for d in carl["days"]], [0, 6, 8, 8, 8, 0, 0])
        self.assertIsNone(carl["days"][1]["absence"])
        self.assertEqual((carl["hours"], carl["target"], carl["flags"]), (30.0, 30.0, []))

    def test_a_finished_week_below_target_is_under(self):
        ana = self.people["Ana"]
        self.assertEqual(ana["target"], 24.0)
        self.assertEqual(ana["flags"], ["under"])

    def test_a_finished_week_over_its_target_by_more_than_the_margin_is_over(self):
        schedule = {"hours": [8] * 5 + [0, 0]}
        employee = {"id": 1, "name": "Ana", "departure_date": False, "since": "2000-01-01"}
        long_week = [dt.session_of(att(1, d, (8, 0), (17, 12), 9.2), {}) for d in range(5)]
        row = tm.employee_row(employee, lambda iso: schedule, [], long_week, [], MONDAY, date.today())
        self.assertEqual((row["hours"], row["target"], row["flags"]), (46.0, 40, ["over"]))
        fair = [dt.session_of(att(1, d, (8, 0), (17, 0), 9.0), {}) for d in range(5)]
        self.assertEqual(tm.employee_row(employee, lambda iso: schedule, [], fair, [], MONDAY, date.today())["flags"], [])
        self.assertEqual(tm.employee_row(employee, lambda iso: schedule, [], long_week, [], MONDAY, MONDAY)["flags"], [])

    def test_without_a_calendar_nothing_is_expected_or_flagged(self):
        bea = self.people["Bea"]
        self.assertEqual((bea["hours"], bea["target"], bea["flags"]), (0, None, []))
        self.assertTrue(all(d["flags"] == [] and d["target"] == 0 for d in bea["days"]))

    def test_sessions_keep_times_and_breaks(self):
        friday = self.people["Ana"]["days"][4]["sessions"]
        self.assertEqual([s["rest"] for s in friday], [False, True, False])
        self.assertEqual(friday[0]["in"], dt.local(at(4, 9)).isoformat())

    def test_change_requests_sit_on_the_day_they_ask_to_change(self):
        ana, carl = self.people["Ana"], self.people["Carl"]
        self.assertEqual([len(d["requests"]) for d in ana["days"]], [0, 0, 1, 0, 0, 0, 0])
        self.assertEqual(ana["days"][2]["requests"], [{
            "id": 51, "can_approve": True,
            "from": dt.local(at(2, 9)).isoformat(), "to": dt.local(at(2, 17, 40)).isoformat(),
            "status": "pending", "reason": "Olvidé fichar la salida Salí a las 17:40",
        }])
        self.assertEqual(carl["days"][1]["requests"], [{"id": None, "can_approve": False, "from": dt.local(at(1, 9)).isoformat(), "to": None,
                                                         "status": "approved", "reason": ""}])
        self.assertTrue(all(d["requests"] == [] for d in self.people["Bea"]["days"]))
        self.assertEqual([self.people[n]["pending"] for n in ("Ana", "Bea", "Carl")], [1, 0, 0])
        domain = next(args for model, args, _ in self.client.calls if model == "approval.request")[0]
        self.assertIn(("request_owner_id", "in", [11, 13]), domain)
        self.assertIn(("category_id.name", "ilike", "fichaje"), domain)
        self.assertEqual(ana["days"][2]["flags"], ["open"])

    def test_someones_page_lists_only_the_pending_requests_the_viewer_may_approve(self):
        waiting = dict(REQUESTS[0], date_start="2024-01-10 08:00:00")
        mine = dict(waiting, id=52, user_status="approved")
        client = ScriptedClient(rows(**{"hr.employee": [{"id": 1, "user_id": [11, "ana"]}], "approval.request": [waiting, mine]}))
        self.assertEqual([r["id"] for r in tm.requests_to_approve(client, 1)], [51])
        domain = next(args for model, args, _ in client.calls if model == "approval.request")[0]
        self.assertEqual(domain[1:], [("request_owner_id", "in", [11]), ("request_status", "in", ["pending"])])
        nobody = ScriptedClient(rows(**{"hr.employee": [{"id": 1, "user_id": False}]}))
        self.assertEqual(tm.requests_to_approve(nobody, 1), [])

    def test_without_access_to_approvals_there_are_no_requests(self):
        def refuse(args, kwargs):
            raise OdooError("acceso denegado")
        payload = tm.build_team(ScriptedClient(rows(**{"approval.request": refuse})), MONDAY)
        self.assertTrue(all(d["requests"] == [] for e in payload["employees"] for d in e["days"]))

        def expire(args, kwargs):
            raise SessionExpired("caducada")
        with self.assertRaises(SessionExpired):
            tm.build_team(ScriptedClient(rows(**{"approval.request": expire})), MONDAY)

    def test_the_current_week_flags_nothing_not_over_yet(self):
        monday = tm.monday_of(date.today())
        day = (date.today() - monday).days
        today = datetime.combine(date.today(), time(9)).astimezone().astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        live = [{"employee_id": [2, "Bea"], "check_in": today, "check_out": False, "worked_hours": 0,
                 "attendance_reason_ids": []}]
        client = ScriptedClient(rows(**{
            "hr.attendance": lambda args, kwargs: attendance(args, kwargs)
            if len(args) == 3 or ("check_out", "=", False) in args[0] or ("check_out", "!=", False) in args[0] else live,
            "hr.employee": lambda args, kwargs: [{"id": 2, "name": "Bea", "resource_calendar_id": [4, "Std"], "user_id": False,
                                                  "active": True, "departure_date": False}]
            if "name" in args[1] else [{"id": 1, "active": True}, {"id": 3, "active": True}],
            "resource.calendar.leaves": [], "hr.leave": [],
        }))
        bea = tm.build_team(client, monday)["employees"][0]
        self.assertEqual(bea["days"][day]["flags"], [])
        self.assertEqual(bea["flags"], [])
        self.assertTrue(all(d["flags"] == [] for d in bea["days"][day:]))

    def test_without_attendance_reasons_the_field_is_not_asked(self):
        client = ScriptedClient(rows(**{"hr.attendance.reason": []}))
        tm.build_team(client, MONDAY)
        fields = [kwargs["fields"] for model, args, kwargs in client.calls if model == "hr.attendance" and len(args) == 1]
        self.assertNotIn("attendance_reason_ids", fields[0])


class ContractTest(unittest.TestCase):
    PART_TIME = [{"calendar_id": [9, "25 h"], "dayofweek": str(d), "hour_from": 9.0, "hour_to": 14.0, "day_period": "morning"}
                 for d in range(5)]

    def build(self, contracts):
        client = ScriptedClient(rows(**{"hr.contract": contracts, "resource.calendar.attendance": CALENDAR + self.PART_TIME,
                                        "resource.calendar.leaves": [], "hr.leave": []}))
        payload = tm.build_team(client, MONDAY)
        return {e["name"]: e for e in payload["employees"]}, client

    def test_each_day_expects_the_contract_in_force_and_nothing_outside_one(self):
        people, client = self.build([
            {"employee_id": [1, "Ana"], "date_start": "2025-03-04", "date_end": "2025-03-05", "resource_calendar_id": [9, "25 h"]},
            {"employee_id": [1, "Ana"], "date_start": "2025-03-07", "date_end": False, "resource_calendar_id": [4, "Std"]},
            {"employee_id": [3, "Carl"], "date_start": "2025-01-01", "date_end": False, "resource_calendar_id": False},
        ])
        self.assertEqual([d["target"] for d in people["Ana"]["days"]], [0, 5, 5, 0, 8, 0, 0])
        self.assertEqual(people["Ana"]["days"][0]["flags"], [])
        self.assertEqual([d["target"] for d in people["Carl"]["days"]], [0] * 7)
        self.assertIsNone(people["Carl"]["target"])
        self.assertEqual([d["target"] for d in people["Bea"]["days"]], [0] * 7)
        domain = next(args for model, args, _ in client.calls if model == "hr.contract")[0]
        self.assertIn(("state", "in", ["open", "close"]), domain)
        blocks = next(args for model, args, _ in client.calls if model == "resource.calendar.attendance")[0]
        self.assertEqual(blocks, [("calendar_id", "in", [4, 9])])

    def test_without_access_to_contracts_the_employee_calendar_is_used(self):
        def refuse(args, kwargs):
            raise OdooError("acceso denegado")
        people, _ = self.build(refuse)
        self.assertEqual([d["target"] for d in people["Carl"]["days"]], [8, 8, 8, 8, 8, 0, 0])

        def expire(args, kwargs):
            raise SessionExpired("caducada")
        with self.assertRaises(SessionExpired):
            self.build(expire)


class MonthTest(unittest.TestCase):
    def test_weeks_each_judged_and_the_month_counting_only_its_own_days(self):
        client = ScriptedClient(rows())
        payload = tm.build_team(client, MONDAY, 2, MONDAY + timedelta(days=2), MONDAY + timedelta(days=9))
        self.assertEqual((payload["week"], payload["start"], payload["stop"]), ("2025-03-03", "2025-03-05", "2025-03-12"))
        ana = next(e for e in payload["employees"] if e["name"] == "Ana")
        self.assertEqual(len(ana["days"]), 14)
        self.assertEqual([w["monday"] for w in ana["weeks"]], ["2025-03-03", "2025-03-10"])
        self.assertEqual([w["flags"] for w in ana["weeks"]], [["under"], ["under"]])
        self.assertEqual(ana["weeks"][0]["target"], 24.0)
        self.assertEqual(ana["weeks"][1]["target"], 40.0)
        self.assertEqual(ana["target"], 8 * 1 + 0 + 8 + 8 + 8)
        self.assertEqual(ana["hours"], round(0 + 0 + 0.05 + 0.0167 + 12.83, 2))
        self.assertEqual(ana["flags"], ["under"])
        week = next(args for model, args, kwargs in client.calls
                    if model == "hr.attendance" and len(args) == 1 and ("check_out", "=", False) not in args[0])
        self.assertIn(("check_in", "<", tm.odoo_time(MONDAY + timedelta(weeks=2))), week[0])

    def test_a_week_payload_is_its_own_single_week(self):
        payload = tm.build_team(ScriptedClient(rows()), MONDAY)
        ana = next(e for e in payload["employees"] if e["name"] == "Ana")
        self.assertEqual(ana["weeks"], [{"monday": "2025-03-03", "hours": ana["hours"], "target": ana["target"],
                                         "balance": ana["balance"], "flags": ana["flags"], "suspect": True}])
        self.assertTrue(ana["suspect"])
        carl = next(e for e in payload["employees"] if e["name"] == "Carl")
        self.assertFalse(carl["suspect"])
        self.assertEqual((payload["start"], payload["stop"]), ("2025-03-03", "2025-03-10"))


class YearTest(unittest.TestCase):
    def test_a_year_goes_out_by_month_with_its_weeks_counted_where_their_thursday_falls(self):
        payload = tm.build_team(ScriptedClient(rows()), date(2025, 2, 24), 3, date(2025, 3, 1), date(2025, 3, 15))
        ana = next(e for e in payload["employees"] if e["name"] == "Ana")
        self.assertEqual(ana["balance"], round(sum(d["hours"] - d["target"] for d in ana["days"]
                                                   if "2025-03-01" <= d["date"] < "2025-03-15"), 2))
        year = tm.year_payload(payload, 2025)
        self.assertEqual(year["year"], 2025)
        row = next(e for e in year["employees"] if e["name"] == "Ana")
        self.assertNotIn("days", row)
        self.assertNotIn("weeks", row)
        self.assertEqual([m["month"] for m in row["months"]][:3], ["2025-01", "2025-02", "2025-03"])
        feb, march = row["months"][1], row["months"][2]
        self.assertEqual((feb["hours"], feb["target"], feb["flagged_days"]), (0, 40, 5))
        self.assertEqual((feb["under"], feb["over"]), (1, 0))
        self.assertEqual((march["under"], march["over"]), (2, 0))
        self.assertEqual(march["target"], 24 + 40)
        self.assertEqual(march["balance"], round(march["hours"] - march["target"], 2))
        self.assertEqual(row["months"][0], {"month": "2025-01", "hours": 0, "target": 0, "balance": 0,
                                            "under": 0, "over": 0, "flagged_days": 0, "suspect": False})
        self.assertTrue(march["suspect"])
        bea = next(e for e in year["employees"] if e["name"] == "Bea")
        self.assertEqual((bea["months"][2]["target"], bea["months"][2]["balance"], bea["balance"]), (None, None, None))

    def test_fetch_year_builds_its_span_once_and_caches_it(self):
        self.addCleanup(dt.drop_data_cache)
        dt.drop_data_cache()
        calls = []
        original = tm.build_team
        tm.build_team = lambda client, *span: calls.append(span) or {"generated_at": "2026-09-24T10:00:00", "employees": []}
        self.addCleanup(setattr, tm, "build_team", original)
        client = SimpleNamespace(session_id="sid")
        self.assertEqual(tm.fetch_year(client, 2026)["year"], 2026)
        tm.fetch_year(client, 2026)
        self.assertEqual(calls, [tm.year_span(2026)])


class FixesTest(unittest.TestCase):
    def test_only_punch_error_days_with_their_sessions_and_no_off_on_a_long_day(self):
        fixes = tm.fixes_payload(tm.build_team(ScriptedClient(rows()), MONDAY))
        people = {e["name"]: e for e in fixes["employees"]}
        self.assertEqual(sorted(people), ["Ana", "Dani"])
        self.assertEqual([(i["date"], i["kind"]) for i in people["Dani"]["items"]], [("2025-03-04", "empty")])
        ana = people["Ana"]
        self.assertEqual([(i["date"], i["kind"]) for i in ana["items"]],
                         [("2025-03-04", "empty"), ("2025-03-05", "open"), ("2025-03-07", "long")])
        self.assertEqual(ana["items"][2]["sessions"][0]["in"], dt.local(at(4, 9)).isoformat())
        self.assertEqual(set(ana["items"][2]["sessions"][0]), {"id", "in", "out", "hours"})
        self.assertEqual(ana["archived"], False)
        self.assertEqual(fixes["limits"]["long_day"], 12)

    def test_nothing_is_expected_before_the_week_of_the_first_real_punch(self):
        def firsts(args, kwargs):
            if len(args) == 3 and "check_in:min" in args[1]:
                self.assertIn(("worked_hours", ">=", dt.MIN_SESSION), args[0])
                return [{"employee_id": [3, "Carl"], "check_in": at(8, 9)}, {"employee_id": False}]
            return attendance(args, kwargs)
        people = {e["name"]: e for e in tm.build_team(ScriptedClient(rows(**{"hr.attendance": firsts})), MONDAY)["employees"]}
        self.assertEqual([d["target"] for d in people["Carl"]["days"]], [0] * 7)
        self.assertEqual(people["Carl"]["target"], 0)
        self.assertTrue(all("empty" not in d["flags"] for d in people["Carl"]["days"]))
        self.assertEqual([d["target"] for d in people["Ana"]["days"]], [0] * 7)
        this_week = tm.build_team(ScriptedClient(rows(**{"hr.attendance": firsts})), tm.monday_of(date.today()))
        ana = next(e for e in this_week["employees"] if e["name"] == "Ana")
        self.assertGreater(ana["target"], 0)

    def test_fetch_fixes_spans_from_the_first_attendance_to_this_week_and_caches(self):
        self.addCleanup(dt.drop_data_cache)
        dt.drop_data_cache()
        calls = []
        original = tm.build_team
        tm.build_team = lambda client, monday, weeks: calls.append((monday, weeks)) or {
            "generated_at": "x", "limits": {}, "employees": []}
        self.addCleanup(setattr, tm, "build_team", original)
        client = ScriptedClient({"hr.attendance": [{"check_in": "2025-03-05 08:00:00"}]})
        self.assertEqual(tm.fetch_fixes(client), {"generated_at": "x", "limits": {}, "employees": []})
        tm.fetch_fixes(client)
        monday = tm.monday_of(date.today())
        self.assertEqual(calls, [(MONDAY, (monday - MONDAY).days // 7 + 1)])
        first = client.calls[0]
        self.assertEqual((first[0], first[2]["limit"], first[2]["order"]), ("hr.attendance", 1, "check_in asc"))
        tm.fetch_fixes(ScriptedClient({"hr.attendance": []}), fresh=True)
        self.assertEqual(calls[-1], (monday, 1))


class FetchTeamTest(unittest.TestCase):
    def test_cached_per_session_week_and_span(self):
        self.addCleanup(dt.drop_data_cache)
        dt.drop_data_cache()
        calls = []
        original = tm.build_team
        tm.build_team = lambda client, monday, weeks, start, stop: calls.append((client.session_id, monday)) or len(calls)
        self.addCleanup(setattr, tm, "build_team", original)
        client = SimpleNamespace(session_id="sid")
        self.assertEqual(tm.fetch_team(client, MONDAY), 1)
        self.assertEqual(tm.fetch_team(client, MONDAY), 1)
        self.assertEqual(tm.fetch_team(client, MONDAY + timedelta(days=7)), 2)
        self.assertEqual(tm.fetch_team(client, MONDAY, fresh=True), 3)
        self.assertEqual(tm.fetch_team(client, MONDAY, False, 5, MONDAY, MONDAY + timedelta(weeks=5)), 4)
        self.assertEqual(tm.fetch_team(client, MONDAY, False, 5, MONDAY, MONDAY + timedelta(weeks=5)), 4)



class WriteTest(unittest.TestCase):
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
            status, body = tm.save_attendance(client, {"id": 31512, "check_in": self.iso(0, 9), "check_out": self.iso(0, 17, 40)})
        self.assertEqual((status, body), (200, {"ok": True, "lost_entry": None}))
        self.assertEqual(client.calls[1], ("hr.attendance", "write", [[31512], {"check_in": at(0, 9), "check_out": at(0, 17, 40)}]))
        drop.assert_called_once()

    def test_shortening_into_the_same_day_warns_when_the_next_check_in_would_be_lost(self):
        body = {"id": 1, "check_in": self.iso(0, 16, 7), "check_out": self.iso(0, 17, 40)}
        lonely = self.client({"read": [{"employee_id": [7, "x"], "check_out": at(1, 8, 34)}], "search_count": 0})
        self.assertEqual(tm.save_attendance(lonely, body)[1]["lost_entry"], dt.local(at(1, 8, 34)).isoformat())
        domain = lonely.calls[-1][2][0]
        self.assertEqual(domain, [("employee_id", "=", 7), ("check_in", ">=", at(1, 8, 34)), ("check_in", "<=", at(1, 8, 44))])
        repunched = self.client({"read": [{"employee_id": [7, "x"], "check_out": at(1, 8, 34)}], "search_count": 1})
        self.assertIsNone(tm.save_attendance(repunched, body)[1]["lost_entry"])
        closing = self.client({"read": [{"employee_id": [7, "x"], "check_out": False}]})
        self.assertIsNone(tm.save_attendance(closing, body)[1]["lost_entry"])

    def test_a_new_punch_is_created_for_the_employee(self):
        client = self.client()
        status, _ = tm.save_attendance(client, {"employee": "7", "check_in": "2025-03-04T08:34:00Z", "check_out": "2025-03-04T15:00:00.000Z"})
        self.assertEqual(status, 200)
        self.assertEqual(client.calls, [("hr.attendance", "create",
                                         [{"employee_id": 7, "check_in": "2025-03-04 08:34:00", "check_out": "2025-03-04 15:00:00"}])])

    def test_bad_input_and_odoo_refusals(self):
        client = self.client()
        for body in ({}, {"check_in": "x", "check_out": "y"}, {"id": "z", "check_in": self.iso(0, 9), "check_out": self.iso(0, 10)}):
            self.assertEqual(tm.save_attendance(client, body)[0], 400)
        self.assertEqual(tm.save_attendance(client, {"id": 1, "check_in": self.iso(0, 10), "check_out": self.iso(0, 9)}),
                         (400, {"error": "La salida tiene que ser posterior a la entrada"}))
        self.assertEqual(tm.save_attendance(client, {"check_in": self.iso(0, 9), "check_out": self.iso(0, 10)}),
                         (400, {"error": "Falta el fichaje o la persona"}))
        self.assertEqual(client.calls, [])
        refused = self.client(fail={"create": OdooError("se solapa")})
        self.assertEqual(tm.save_attendance(refused, {"employee": 7, "check_in": self.iso(0, 9), "check_out": self.iso(0, 10)}),
                         (409, {"error": "se solapa"}))
        expired = self.client(fail={"read": SessionExpired("caducada")})
        with self.assertRaises(SessionExpired):
            tm.save_attendance(expired, {"id": 1, "check_in": self.iso(0, 9), "check_out": self.iso(0, 10)})

    def test_a_request_is_approved_as_the_session_user(self):
        client = self.client()
        with unittest.mock.patch.object(dt, "drop_data_cache") as drop:
            self.assertEqual(tm.approve_request(client, "552"), (200, {"ok": True}))
        self.assertEqual(client.calls, [("approval.request", "action_approve", [[552]])])
        drop.assert_called_once()
        self.assertEqual(tm.approve_request(client, None)[0], 400)
        self.assertEqual(tm.approve_request(self.client(fail={"action_approve": OdooError("no eres aprobador")}), 1),
                         (409, {"error": "no eres aprobador"}))
        with self.assertRaises(SessionExpired):
            tm.approve_request(self.client(fail={"action_approve": SessionExpired("caducada")}), 1)
