"""Monotonic runtime deadlines for timeout-bearing CareDecisions.

The scheduler knows nothing about session rules.  It owns cancellable daemon
timers and calls back with the scene/decision identity; DecisionService performs
the authoritative in-lock stale check before applying any transition.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Protocol

DeadlineCallback = Callable[[str, str], None]


class DeadlineScheduler(Protocol):
    """Adapter boundary used by DecisionService."""

    def schedule(
        self,
        *,
        scene_id: str,
        decision_id: str,
        delay_ms: float,
        callback: DeadlineCallback,
    ) -> None: ...

    def cancel(self, scene_id: str) -> None: ...

    def cancel_all(self) -> None: ...

    def close(self) -> None: ...


class MonotonicDeadlineScheduler:
    """One replaceable monotonic timer per scene.

    ``threading.Timer`` is monotonic internally through Python's condition
    waits.  Every timer is daemonized so an emergency deadline cannot prevent
    orderly process shutdown; ``close`` still cancels all known work.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._timers: dict[str, tuple[str, object, threading.Timer]] = {}
        self._closed = False

    def schedule(
        self,
        *,
        scene_id: str,
        decision_id: str,
        delay_ms: float,
        callback: DeadlineCallback,
    ) -> None:
        if delay_ms <= 0:
            delay_ms = 1.0
        token = object()
        timer = threading.Timer(
            delay_ms / 1000.0,
            self._fire,
            args=(scene_id, decision_id, token, callback),
        )
        timer.daemon = True
        previous: threading.Timer | None = None
        with self._lock:
            if self._closed:
                return
            old = self._timers.get(scene_id)
            if old is not None:
                previous = old[2]
            self._timers[scene_id] = (decision_id, token, timer)
            timer.start()
        if previous is not None:
            previous.cancel()

    def _fire(
        self,
        scene_id: str,
        decision_id: str,
        token: object,
        callback: DeadlineCallback,
    ) -> None:
        with self._lock:
            current = self._timers.get(scene_id)
            if current is None or current[0] != decision_id or current[1] is not token:
                return
            self._timers.pop(scene_id, None)
        callback(scene_id, decision_id)

    def cancel(self, scene_id: str) -> None:
        with self._lock:
            current = self._timers.pop(scene_id, None)
        if current is not None:
            current[2].cancel()

    def cancel_all(self) -> None:
        with self._lock:
            timers = tuple(entry[2] for entry in self._timers.values())
            self._timers.clear()
        for timer in timers:
            timer.cancel()
    def close(self) -> None:
        with self._lock:
            self._closed = True
            timers = tuple(entry[2] for entry in self._timers.values())
            self._timers.clear()
        for timer in timers:
            timer.cancel()
