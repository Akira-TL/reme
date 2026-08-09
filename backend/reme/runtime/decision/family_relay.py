"""Asynchronous HTTPS publisher for authoritative family-facing events."""

from __future__ import annotations

import json
import os
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

DEFAULT_TIMEOUT_SECONDS = 3.0
DEFAULT_MAX_ATTEMPTS = 2
DEFAULT_RETRY_DELAY_SECONDS = 0.25


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
    retry_delay_seconds: float = DEFAULT_RETRY_DELAY_SECONDS
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
        if self.retry_delay_seconds <= 0:
            raise FamilyRelayError("family relay retry_delay_seconds must be positive")


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
        self._condition = threading.Condition()
        self._stop_event = threading.Event()
        self._pending: FamilyEvent | None = None
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
        with self._condition:
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
        with self._condition:
            if self._closed:
                return
            # Latest-state semantics: while cloud delivery is unavailable, a
            # newer authoritative decision supersedes an older unsent one.
            self._pending = event
            self._condition.notify()

    def close(self) -> None:
        with self._condition:
            if self._closed:
                return
            self._closed = True
            self._pending = None
            self._condition.notify_all()
        self._stop_event.set()
        self._thread.join(timeout=self._config.timeout_seconds * self._config.max_attempts + 1.0)

    def _run(self) -> None:
        while True:
            with self._condition:
                while self._pending is None and not self._closed:
                    self._condition.wait()
                if self._closed:
                    return
                event = self._pending
                self._pending = None
            assert event is not None
            if self._deliver(event):
                continue
            with self._condition:
                if self._closed:
                    return
                if self._pending is None:
                    self._pending = event
            # Interruptible backoff: a newer decision can replace _pending
            # while we wait, and shutdown never waits for the retry delay.
            if self._stop_event.wait(self._config.retry_delay_seconds):
                return

    def _deliver(self, event: FamilyEvent) -> bool:
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
                return True
            except urllib.error.HTTPError as exc:
                if exc.code == 409:
                    # Relay already has this revision or a newer one.
                    return True
                if 400 <= exc.code < 500:
                    self._warn(
                        "permanent delivery rejection for "
                        f"{event.runtime_session_id}/revision-{event.revision}: HTTP {exc.code}"
                    )
                    return True
                last_error = exc
            except (OSError, urllib.error.URLError, FamilyRelayError) as exc:
                last_error = exc
            if attempt < self._config.max_attempts:
                time.sleep(0.05 * attempt)
        self._warn(
            "temporary delivery failure for "
            f"{event.runtime_session_id}/revision-{event.revision}: {last_error}; "
            "retrying latest state"
        )
        return False

    @staticmethod
    def _warn(message: str) -> None:
        print(f"warning: family relay publisher: {message}", file=sys.stderr)
