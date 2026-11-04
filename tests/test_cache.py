"""Unit tests for the payload cache, through the personal page's payload that uses it."""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from odoo_wrapper import attendance as at
from odoo_wrapper import cache


class CacheTest(unittest.TestCase):
    def setUp(self):
        self.calls, self.failing = 0, False
        original = at.build_personal
        at.build_personal = self.count
        self.addCleanup(setattr, at, "build_personal", original)
        self.addCleanup(cache.drop)
        cache.drop()

    def count(self, client, employee=None):
        if self.failing:
            raise ZeroDivisionError
        self.calls += 1
        return dict({"call": self.calls, "client": client.session_id}, **({"employee": employee} if employee else {}))

    def fetch(self, session_id, employee=None):
        return at.fetch_personal(SimpleNamespace(session_id=session_id), employee)

    def reload(self, session_id, employee=None):
        return at.reload_personal(SimpleNamespace(session_id=session_id), employee)

    def test_serves_the_same_payload_within_the_ttl_per_session(self):
        self.assertEqual(self.fetch("one"), {"call": 1, "client": "one"})
        self.assertEqual(self.fetch("one"), {"call": 1, "client": "one"})
        self.assertEqual(self.fetch("other"), {"call": 2, "client": "other"})
        self.assertEqual(self.fetch("one"), {"call": 1, "client": "one"})
        self.assertEqual(self.calls, 2)

    def test_a_reload_bypasses_it_and_replaces_the_entry(self):
        self.fetch("one")
        self.assertEqual(self.reload("one")["call"], 2)
        self.assertEqual(self.fetch("one")["call"], 2)
        self.assertEqual(self.reload("one", employee=9)["call"], 3)
        self.assertEqual(self.fetch("one", employee=9)["call"], 3)

    def test_a_reload_that_fails_leaves_the_entry_it_found(self):
        self.fetch("one")
        self.failing = True
        with self.assertRaises(ZeroDivisionError):
            self.reload("one")
        self.failing = False
        self.assertEqual(self.fetch("one")["call"], 1)

    def test_someone_elses_week_keeps_longer(self):
        self.fetch("one", employee=9)
        with patch.object(cache, "OWN_TTL", -1):
            self.assertEqual(self.fetch("one", employee=9)["call"], 1)
            self.assertEqual(self.fetch("one")["call"], 2)
        with patch.object(cache, "VIEW_TTL", -1):
            self.assertEqual(self.fetch("one", employee=9)["call"], 3)

    def test_someone_elses_week_has_its_own_entry(self):
        self.assertEqual(self.fetch("one")["call"], 1)
        self.assertEqual(self.fetch("one", employee=9), {"call": 2, "client": "one", "employee": 9})
        self.assertEqual(self.fetch("one", employee=9)["call"], 2)
        self.assertEqual(self.fetch("one")["call"], 1)

    def test_dropping_without_a_session_drops_every_session(self):
        self.fetch("one")
        self.fetch("other")
        cache.drop()
        self.assertEqual(self.fetch("one")["call"], 3)
        self.assertEqual(self.fetch("other")["call"], 4)

    def test_it_expires_exactly_when_its_ttl_has_passed(self):
        clock = [100.0]
        with patch.object(cache.time, "monotonic", side_effect=lambda: clock[0]):
            self.fetch("one")
            clock[0] += cache.OWN_TTL - 0.5
            self.assertEqual(self.fetch("one")["call"], 1)
            clock[0] += 0.5
            self.assertEqual(self.fetch("one")["call"], 2)

    def test_it_expires(self):
        self.fetch("one")
        with patch.object(cache, "OWN_TTL", -1):
            self.assertEqual(self.fetch("one")["call"], 2)


if __name__ == "__main__":
    unittest.main()
