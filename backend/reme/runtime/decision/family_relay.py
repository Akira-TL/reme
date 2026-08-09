"""Asynchronous HTTPS publisher for authoritative family-facing events."""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from reme.runtime.decision.family_event import FamilyEvent, family_event_from_decision
from reme.runtime.decision.records import CareDecision
from reme.runtime.decision.session import RuntimeSessionRegistry

DEFAULT_QUEUE_CAPACITY = 64
DEFAULT_TIMEOUT_SECONDS = 3.0
DEFAULT_MAX_ATTEMPTS = 2


class FamilyRelayError(RuntimeError):
    """Invalid relay configuration or delivery failure."""


class FamilyRelayTransport(Protocol):
    def __call__(self, request: urllib.request.Request, timeout: float) -> bytes: ...


@dataclass(frozen=True, slots=True)
class FamilyRelayConfig:
    endpoint: str
    token: str
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    max_attempts: int = DEFAULT_MAX_ATTEMPTS
    queue_capacity: int = DEFAULT_QUEUE_CAPACITY
    include_elder_quote: bool = False

    def __post_init__(self) -> None:
        parsed = urllib.parse.urlparse(self.endpoint)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise FamilyRelayError("family relay endpoint must be an absolute http(s) URL")
        if not self.token.strip():
            raise FamilyRelayError("family relay token must be non-empty")
        if self.timeout_seconds <= 0:
            raise FamilyRelayError("family relay timeout must be positive")
        if self.max_attempts < 1:
            raise FamilyRelayError("family relay max_attempts must be at least 1")
        if self.queue_capacity < 1:
            raise FamilyRelayError("family relay queue_capacity must be at least 1")


@dataclass(frozen=True, slots=True)
class _QueuedEvent:
    event: FamilyEvent


def _default_transport(request: urllib.request.Request, timeout: float) -> bytes:
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status < 200 or response.status >= 300:
            raise FamilyRelayError(f"family relay returned HTTP {response.status}")
        return response.read()


def family_relay_config_from_env() -> FamilyRelayConfig | None:
    endpoint = os.environ.get("REME_FAMILY_RELAY_ENDPOINT", "").strip()
    token = os.environ.get("REME_FAMILY_RELAY_TOKEN", "").strip()
    if not endpoint and not token:
        return None
    if not endpoint or not token:
        raise FamilyRelayError(
            "REME_FAMILY_RELAY_ENDPOINT and REME_FAMILY_RELAY_TOKEN must be configured together"
        )
    include_quote = os.environ.get("REME_FAMILY_RELAY_INCLUDE_ELDER_QUOTE", "0").strip() in {
        "1",
        "true",
        "yes",
    }
    return FamilyRelayConfig(
        endpoint=endpoint,
        token=token,
        include_elder_quote=include_quote,
    )


class FamilyRelayPublisher:
    """Project decisions into minimal events and deliver them off the decision path."""

    def __init__(
        self,
        *,
        registry: RuntimeSessionRegistry,
        config: FamilyRelayConfig,
        transport: FamilyRelayTransport = _default_transport,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._registry = registry
        self._config = config
        self._transport = transport
        self._wall_clock = wall_clock
        self._queue: queue.Queue[_QueuedEvent | None] = queue.Queue(config.queue_capacity)
        self._lock = threading.Lock()
        self._revision_by_session: dict[str, int] = {}
        self._closed = False
        self._thread = threading.Thread(
            target=self._run,
            name="reme-family-relay-publisher",
            daemon=True,
        )
        self._thread.start()

    def publish_decision(self, decision: CareDecision) -> None:
        session_id = self._registry.active_session_id()
        if session_id is None:
            return
        with self._lock:
            if self._closed:
                return
            revision = self._revision_by_session.get(session_id, 0) + 1
            self._revision_by_session[session_id] = revision
        event = family_event_from_decision(
            decision,
            runtime_session_id=session_id,
            revision=revision,
            published_at_ms=max(0, int(round(self._wall_clock() * 1000))),
            include_elder_quote=self._config.include_elder_quote,
        )
        self._enqueue_latest(_QueuedEvent(event=event))

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._enqueue_latest(None)
        self._thread.join(timeout=self._config.timeout_seconds * self._config.max_attempts + 1.0)

    def _enqueue_latest(self, item: _QueuedEvent | None) -> None:
        try:
            self._queue.put_nowait(item)
            return
        except queue.Full:
            pass
        try:
            self._queue.get_nowait()
            self._queue.task_done()
        except queue.Empty:
            pass
        try:
            self._queue.put_nowait(item)
        except queue.Full:
            self._warn("queue remained full; dropping family relay event")

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            try:
                if item is None:
                    return
                self._deliver(item.event)
            finally:
                self._queue.task_done()

    def _deliver(self, event: FamilyEvent) -> None:
        body = json.dumps(
            event.to_payload(),
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        request = urllib.request.Request(
            self._config.endpoint,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {self._config.token}",
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
            },
        )
        last_error: Exception | None = None
        for attempt in range(1, self._config.max_attempts + 1):
            try:
                self._transport(request, self._config.timeout_seconds)
                return
            except (OSError, urllib.error.URLError, FamilyRelayError) as exc:
                last_error = exc
                if attempt < self._config.max_attempts:
                    time.sleep(0.05 * attempt)
        self._warn(
            "delivery failed for "
            f"{event.runtime_session_id}/revision-{event.revision}: {last_error}"
        )

    @staticmethod
    def _warn(message: str) -> None:
        print(f"warning: family relay publisher: {message}", file=sys.stderr)
