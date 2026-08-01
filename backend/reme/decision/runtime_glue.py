"""Wire the runtime trio (registry / hub / ingest) into the decision service.

Integration-owned module: the parallel lanes deliver the parts, this file
composes them. Kept apart from policy.py so the service stays ignorant of
session and transport concepts.
"""

from __future__ import annotations

import threading
from collections.abc import Callable

from reme.decision.policy import DecisionService
from reme.decision.records import CareDecision
from reme.decision.session import RuntimeSessionRegistry, SessionRegistryError
from reme.decision.stream import EventIngest, LiveStreams
from reme.decision.websocket import DecisionEventHub
from reme.pose.runtime import RuntimeEvent, RuntimeEventType

_EVALUATED_EVENT_TYPES = {
    RuntimeEventType.POSTURE_OBSERVATION,
    RuntimeEventType.TRANSITION_EVENT,
}


class RuntimeDecisionPublisher:
    """Envelope newly emitted decisions and fan them out over the hub."""

    def __init__(self, *, registry: RuntimeSessionRegistry, hub: DecisionEventHub) -> None:
        self._registry = registry
        self._hub = hub

    def publish_decision(self, decision: CareDecision) -> None:
        session_id = self._registry.active_session_id()
        if session_id is None:
            # Prerecorded HTTP-only flows run without a runtime session.
            return
        try:
            sequence = self._registry.next_sequence(session_id)
        except SessionRegistryError:
            return
        event = RuntimeEvent(
            session_id=session_id,
            sequence=sequence,
            event_type=RuntimeEventType.CARE_DECISION,
            payload=decision.to_payload(),
        )
        self._hub.broadcast_json(event.to_payload())


def live_streams_resolver(
    registry: RuntimeSessionRegistry, ingest: EventIngest
) -> Callable[[str], LiveStreams | None]:
    """Resolve unknown scene_ids to live ingest snapshots while a session runs.

    Note: with an active session any scene_id resolves (empty snapshot when
    unseen) — a mistyped live scene yields observe-grade decisions instead of
    404. Accepted for demo scale; bundle scenes keep strict 404 semantics.
    """

    def resolve(scene_id: str) -> LiveStreams | None:
        if registry.active_session_id() is None:
            return None
        return ingest.snapshot(scene_id)

    return resolve


def evaluate_after_ingest(service: DecisionService, event: RuntimeEvent) -> None:
    """Run one decision tick for a freshly buffered perception event.

    Called on a daemon thread from the ingest endpoint so A's event POST never
    blocks on a MiMo round trip; the resulting decision reaches C over the
    WebSocket stream via the service's publisher.
    """

    if event.event_type not in _EVALUATED_EVENT_TYPES:
        return
    scene_id = event.payload.get("scene_id")
    timestamp_raw = event.payload.get("timestamp_ms", event.payload.get("end_ms"))
    if not isinstance(scene_id, str) or not scene_id:
        return
    if isinstance(timestamp_raw, bool) or not isinstance(timestamp_raw, int | float):
        return
    try:
        service.get_decision(scene_id=scene_id, timestamp_ms=float(timestamp_raw))
    except Exception as exc:  # noqa: BLE001 - background tick must never crash ingest
        print(f"warning: post-ingest evaluation failed for {scene_id}: {exc}")


def spawn_post_ingest_evaluation(service: DecisionService, event: RuntimeEvent) -> None:
    """Fire-and-forget wrapper used by the server's /api/events route."""

    thread = threading.Thread(
        target=evaluate_after_ingest, args=(service, event), daemon=True
    )
    thread.start()
