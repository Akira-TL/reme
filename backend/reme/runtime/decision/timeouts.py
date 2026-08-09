"""Backend-owned timeout scheduling for care decisions.

The scheduler is deliberately tiny: policy owns timeout semantics and validates
stale callbacks; this module only provides cancellable delayed callbacks. Tests
can inject a deterministic scheduler instead of sleeping.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Protocol


class TimeoutHandle(Protocol):
    """One cancellable scheduled callback."""

    def cancel(self) -> None: ...


class TimeoutScheduler(Protocol):
    """Scheduling seam used by ``DecisionService``."""

    def call_later(self, delay_seconds: float, callback: Callable[[], None]) -> TimeoutHandle: ...

    def close(self) -> None: ...


class _ThreadingTimeoutHandle:
    def __init__(self, scheduler: ThreadingTimeoutScheduler, timer: threading.Timer) -> None:
        self._scheduler = scheduler
        self._timer = timer

    def cancel(self) -> None:
        self._scheduler._cancel(self._timer)


class ThreadingTimeoutScheduler:
    """Production scheduler backed by daemon ``threading.Timer`` instances."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._timers: set[threading.Timer] = set()
        self._closed = False

    def call_later(self, delay_seconds: float, callback: Callable[[], None]) -> TimeoutHandle:
        if delay_seconds < 0:
            raise ValueError("delay_seconds must be non-negative")

        timer: threading.Timer

        def run() -> None:
            try:
                callback()
            finally:
                self._discard(timer)

        timer = threading.Timer(delay_seconds, run)
        timer.daemon = True
        with self._lock:
            if self._closed:
                raise RuntimeError("timeout scheduler is closed")
            self._timers.add(timer)
        timer.start()
        return _ThreadingTimeoutHandle(self, timer)

    def _discard(self, timer: threading.Timer) -> None:
        with self._lock:
            self._timers.discard(timer)

    def _cancel(self, timer: threading.Timer) -> None:
        self._discard(timer)
        timer.cancel()

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            timers = tuple(self._timers)
            self._timers.clear()
        for timer in timers:
            timer.cancel()
