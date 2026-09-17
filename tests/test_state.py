"""Unit tests for the shared state file."""

import json
import os
import unittest
from datetime import datetime, timedelta

from helpers import temp_state
from odoo_wrapper import state as st


class MinutesTest(unittest.TestCase):
    def test_accepts_the_whole_range(self):
        for value in (0, 1, 30, st.MINUTES_MAX):
            self.assertEqual(st.valid_minutes(value, 99), value)

    def test_rejects_out_of_range_and_wrong_types(self):
        for value in (-1, st.MINUTES_MAX + 1, "30", 30.5, None, True, False, [30]):
            self.assertEqual(st.valid_minutes(value, 99), 99, value)


class StateTest(unittest.TestCase):
    def setUp(self):
        self.home = temp_state(self)

    def test_defaults_without_a_file(self):
        self.assertEqual(st.read_state(), {
            "lunch": None, "lunch_minutes": st.LUNCH_DEFAULT,
            "break_minutes": st.BREAK_DEFAULT, "muted": False, "lunch_done": False,
            "punched_at": None,
        })

    def test_unreadable_file_falls_back_to_defaults(self):
        for content in ("{roto", "", "[]", '"texto"'):
            with open(st.STATE_FILE, "w") as f:
                f.write(content)
            self.assertEqual(st.read_state()["lunch_minutes"], st.LUNCH_DEFAULT, content)

    def test_writes_merge_instead_of_replacing(self):
        st.write_state(lunch_minutes=45)
        st.write_state(muted=True)
        state = st.read_state()
        self.assertEqual(state["lunch_minutes"], 45)
        self.assertTrue(state["muted"])
        self.assertEqual(state["break_minutes"], st.BREAK_DEFAULT)

    def test_lunch_stamp_and_flags_expire_with_the_day(self):
        yesterday = datetime.now().astimezone() - timedelta(days=1)
        with open(st.STATE_FILE, "w") as f:
            json.dump({"lunch": yesterday.isoformat(), "lunch_day": yesterday.date().isoformat(),
                       "muted": yesterday.date().isoformat()}, f)
        state = st.read_state()
        self.assertIsNone(state["lunch"])
        self.assertFalse(state["lunch_done"])
        self.assertFalse(state["muted"])

    def test_an_unreadable_lunch_stamp_is_dropped(self):
        for stamp in ("ayer", 1234):
            with open(st.STATE_FILE, "w") as f:
                json.dump({"lunch": stamp}, f)
            self.assertIsNone(st.read_state()["lunch"], stamp)

    def test_lunch_done_outlives_the_stamp(self):
        st.write_state(lunch=datetime.now().astimezone().isoformat(), lunch_done=True)
        st.write_state(lunch=None)
        state = st.read_state()
        self.assertIsNone(state["lunch"])
        self.assertTrue(state["lunch_done"])

    def test_reads_the_pre_break_minutes_key(self):
        with open(st.STATE_FILE, "w") as f:
            json.dump({"minutes": 45}, f)
        self.assertEqual(st.read_state()["lunch_minutes"], 45)

    def test_punched_at_survives_other_writes(self):
        st.write_state(punched_at="2026-09-01T18:00:00+02:00")
        st.write_state(muted=True)
        self.assertEqual(st.read_state()["punched_at"], "2026-09-01T18:00:00+02:00")

    def test_punched_at_ignores_junk(self):
        with open(st.STATE_FILE, "w") as f:
            json.dump({"punched_at": 1234}, f)
        self.assertIsNone(st.read_state()["punched_at"])

    def test_write_leaves_no_partial_file_behind(self):
        st.write_state(lunch_minutes=20)
        self.assertEqual(os.listdir(self.home), ["state.json"])


if __name__ == "__main__":
    unittest.main()
