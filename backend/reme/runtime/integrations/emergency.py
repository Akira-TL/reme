"""Minimal outbound emergency contract derived from final care decisions."""

from __future__ import annotations

import hashlib
import queue
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Protocol

from reme.runtime.decision.records import CareDecision, DecisionState

EMERGENCY_SCHEMA_VERSION = "reme-emergency-event/v1"
_DEFAULT_QUEUE_SIZE = 32
_STOP = object()


class EmergencyType(StrEnum):
    """Coarse external intervention categories; never perception labels."""

    FAMILY_INTERVENTION_REQUIRED = "family_intervention_required"
    URGENT_ATTENTION = "urgent_attention"


class EmergencySeverity(StrEnum):
    """Coarse external severity independent from internal risk/model values."""

    HIGH = "high"
    CRITICAL = "critical"


class EmergencyTransport(Protocol):
    """Transport seam: send one already-minimized emergency event."""

    def send_event(self, event: EmergencyEvent) -> None: ...


@dataclass(frozen=True, slots=True)
class EmergencyEvent:
    """The complete and intentionally tiny Reme -> external executor payload."""

    schema_version: str
    event_id: str
    type: EmergencyType
    severity: EmergencySeverity
    summary: str
    occurred_at: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "event_id": self.event_id,
            "type": self.type.value,
            "severity": self.severity.value,
            "summary": self.summary,
            "occurred_at": self.occurred_at,
        }


_OUTBOUND_STATES: dict[
    DecisionState, tuple[EmergencyType, EmergencySeverity, str]
] = {
    DecisionState.FAMILY_NOTIFICATION_REQUIRED: (
        EmergencyType.FAMILY_INTERVENTION_REQUIRED,
        EmergencySeverity.HIGH,
        "Reme 检测到需要家属介入的紧急事件，请尽快处理。",
    ),
    DecisionState.URGENT_ATTENTION: (
        EmergencyType.URGENT_ATTENTION,
        EmergencySeverity.CRITICAL,
        "Reme 检测到需要立即外部介入的紧急事件，请立即处理。",
    ),
}


def _utc_now() -> datetime:
    return datetime.now(UTC)


class EmergencyDecisionPublisher:
    """Non-blocking CareDecision publisher for external emergency executors."""

    def __init__(
        self,
        transport: EmergencyTransport,
        *,
        clock: Callable[[], datetime] = _utc_now,
        queue_size: int = _DEFAULT_QUEUE_SIZE,
    ) -> None:
        if queue_size <= 0:
            raise ValueError("queue_size must be positive")
        self._transport = transport
        self._clock = clock
        self._queue: queue.Queue[EmergencyEvent | object] = queue.Queue(maxsize=queue_size)
        self._seen_event_ids: set[str] = set()
        self._lock = threading.Lock()
        self._closed = False
        self._worker = threading.Thread(
            target=self._run,
            name="reme-emergency-publisher",
            daemon=True,
        )
        self._worker.start()

    def publish_decision(self, decision: CareDecision) -> None:
        """Enqueue one allowlisted emergency decision without waiting on HTTP."""

        event = emergency_event_from_decision(decision, occurred_at=self._clock())
        if event is None:
            return
        with self._lock:
            if self._closed or event.event_id in self._seen_event_ids:
                return
            self._seen_event_ids.add(event.event_id)
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            with self._lock:
                self._seen_event_ids.discard(event.event_id)
            print(f"warning: emergency queue full; dropped {event.event_id}")

    def close(self, *, timeout_seconds: float = 1.0) -> None:
        """Stop the daemon worker after queued events, bounded by timeout_seconds."""

        if timeout_seconds < 0:
            raise ValueError("timeout_seconds must be non-negative")
        with self._lock:
            if self._closed:
                return
            self._closed = True
        try:
            self._queue.put(_STOP, timeout=timeout_seconds)
        except queue.Full:
            return
        self._worker.join(timeout=timeout_seconds)

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            try:
                if item is _STOP:
                    return
                assert isinstance(item, EmergencyEvent)
                try:
                    self._transport.send_event(item)
                except Exception as exc:  # noqa: BLE001 - external delivery is never safety-critical
                    print(f"warning: emergency delivery failed for {item.event_id}: {exc}")
            finally:
                self._queue.task_done()


def emergency_event_from_decision(
    decision: CareDecision, *, occurred_at: datetime
) -> EmergencyEvent | None:
    """Project an allowlisted final decision without serializing CareDecision itself."""

    outbound = _OUTBOUND_STATES.get(decision.state)
    if outbound is None:
        return None
    if occurred_at.tzinfo is None or occurred_at.utcoffset() is None:
        raise ValueError("occurred_at must be timezone-aware")
    event_type, severity, summary = outbound
    occurred_at_utc = occurred_at.astimezone(UTC).isoformat().replace("+00:00", "Z")
    return EmergencyEvent(
        schema_version=EMERGENCY_SCHEMA_VERSION,
        event_id=_external_event_id(decision),
        type=event_type,
        severity=severity,
        summary=summary,
        occurred_at=occurred_at_utc,
    )


def _external_event_id(decision: CareDecision) -> str:
    """Derive a stable opaque id without exposing the internal scene identifier."""

    identity = "\x1f".join(
        (decision.scene_id, decision.decision_id, str(decision.timestamp_ms))
    ).encode("utf-8")
    digest = hashlib.sha256(identity).hexdigest()[:32]
    return f"reme-{digest}"
