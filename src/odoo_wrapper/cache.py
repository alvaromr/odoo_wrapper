"""The payload cache: what a page shows, kept per Odoo session for a few seconds or minutes.

- A load from Odoo costs ~1.8 s and an answer from the cache ~2 ms. Each entry is keyed by a tuple that starts with
  the session, so two people logged into the same dashboard never see each other's data. cached() answers from the
  cache within its ttl, and rebuilt() is its reload («Actualizar»): it replaces the entry, leaving the old one if
  the load fails. drop() forgets a session's entries on logout, and every entry after any write to Odoo.
- The viewer's own week keeps OWN_TTL. What the viewer reads about other people (the management view, someone
  else's week) keeps VIEW_TTL, five minutes: moving between those pages used to reload from Odoo every time, and
  «Actualizar» still forces a fresh load.
- The cache holds payloads of several kinds (the personal one, the team's, a year's, the fixes), so it stores them as
  object and returns each as the type its builder made: a key says which kind it holds (the session, then the
  employee, the period, "year" or "fixes"), and cached() and rebuilt() are only called with a key and builder of one
  kind.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import TypeVar, cast

Payload = TypeVar("Payload")
Key = tuple[object, ...]
Load = tuple[Key, Callable[[], Payload]]

OWN_TTL = 45
VIEW_TTL = 300
_lock = threading.Lock()
_entries: dict[Key, tuple[float, object]] = {}


def cached(key: Key, build: Callable[[], Payload], ttl: float) -> Payload:
    """Return what build made for a key within ttl seconds, or build it again."""
    with _lock:
        hit = _entries.get(key)
        if hit and time.monotonic() - hit[0] < ttl:
            return cast("Payload", hit[1])
    return rebuilt(key, build)


def rebuilt(key: Key, build: Callable[[], Payload]) -> Payload:
    """Build a key's payload again whatever the cache holds, keep it and return it."""
    payload = build()
    with _lock:
        _entries[key] = (time.monotonic(), payload)
    return payload


def drop(session_id: str | None = None) -> None:
    """Forget the cached payloads of a session, or of every session."""
    with _lock:
        for key in [key for key in _entries if session_id in (None, key[0])]:
            del _entries[key]
