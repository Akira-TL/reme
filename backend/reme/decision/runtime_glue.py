"""Wire the runtime trio (registry / hub / ingest) into the decision service.

Integration-owned module: the parallel lanes deliver the parts, this file
composes them. Kept apart from policy.py so the service stays ignorant of
session and transport concepts.
"""

from __future__ import annotations

import sys
import threading
from collections.abc import Callable

from reme.decision.policy import DecisionService
from reme.decision.records import CareDecision
from reme.decision.session import RuntimeSessionRegistry, SessionRegistryError
from reme.decision.stream import EventIngest, IngestError, LiveStreams
from reme.decision.websocket import DecisionEventHub
from reme.decision.ws_client import PerceptionEventClient
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
        # Sequence allocation and the broadcast must be one ordered step, or
        # concurrent publishers can put n+1 on the wire before n (Codex P1).
        self._order_lock = threading.Lock()

    def publish_decision(self, decision: CareDecision) -> None:
        with self._order_lock:
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
    """Resolve the active session's scene to a live ingest snapshot.

    Scene-bound (Codex review P2): only the scene named in the active
    session request resolves; every other scene_id keeps strict 404
    semantics, live or not.
    """

    def resolve(scene_id: str) -> LiveStreams | None:
        if registry.active_scene_id() != scene_id:
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

    thread = threading.Thread(target=evaluate_after_ingest, args=(service, event), daemon=True)
    thread.start()


class PerceptionBridge:
    """Own the A→B event subscription for whichever session is active.

    Pull mode (this class) and push mode (``POST /api/events``) write into the
    same :class:`EventIngest` and therefore share one sequence watermark, so
    they must never run at once: whichever arrives first advances the mark and
    the other's whole batch is rejected as out of order.  The server enforces
    that by refusing pushes while a bridge is attached.
    """

    def __init__(
        self,
        *,
        events_url: str,
        ingest: EventIngest,
        registry: RuntimeSessionRegistry,
        service: DecisionService,
        client_factory: Callable[..., PerceptionEventClient] = PerceptionEventClient,
    ) -> None:
        self._events_url = events_url
        self._ingest = ingest
        self._registry = registry
        self._service = service
        self._client_factory = client_factory
        self._lock = threading.Lock()
        self._client: PerceptionEventClient | None = None

    @property
    def events_url(self) -> str:
        return self._events_url

    def attached(self) -> bool:
        """True while a subscription is live (pushes are refused meanwhile)."""

        with self._lock:
            return self._client is not None

    def connected(self) -> bool:
        """True when the socket to A is actually up (feeds degraded status)."""

        with self._lock:
            client = self._client
        return client is not None and client.connected

    def start_for(self, session_id: str) -> None:
        """Subscribe for one session; replaces any previous subscription."""

        self.stop()
        client = self._client_factory(
            url=self._events_url,
            session_id=session_id,
            on_event=self._consume,
        )
        with self._lock:
            self._client = client
        client.start()

    def stop(self) -> None:
        """Tear the subscription down; idempotent and safe from any thread."""

        with self._lock:
            client = self._client
            self._client = None
        if client is not None:
            client.stop()

    def _consume(self, event: RuntimeEvent) -> None:
        """Feed one of A's events through the same path the POST route uses."""

        try:
            self._ingest.submit(
                event.to_payload(), active_session_id=self._registry.active_session_id()
            )
        except IngestError as exc:
            # Stale or malformed events are A's to fix; dropping one must not
            # kill the subscription (the client keeps the socket open).
            print(f"warning: dropped event from A: {exc.code}: {exc}", file=sys.stderr)
            return
        spawn_post_ingest_evaluation(self._service, event)
