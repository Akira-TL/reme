"""Wire the runtime trio (registry / hub / ingest) into the decision service.

Integration-owned module: the parallel lanes deliver the parts, this file
composes them. Kept apart from policy.py so the service stays ignorant of
session and transport concepts.
"""

from __future__ import annotations

import sys
import threading
from collections.abc import Callable
from typing import Any

from reme.decision.danger import DangerConfirmController, DangerRejectedError
from reme.decision.policy import DecisionPublisher, DecisionService
from reme.decision.records import (
    CareDecision,
    DecisionState,
    InteractionResponse,
    ResponseSource,
    ResponseValue,
)
from reme.decision.session import RuntimeSessionRegistry, SessionRegistryError
from reme.decision.stream import EventIngest, IngestError, LiveStreams
from reme.decision.websocket import DecisionEventHub
from reme.decision.ws_client import PerceptionEventClient, _redact_url
from reme.pose.runtime import RuntimeEvent, RuntimeEventType

_EVALUATED_EVENT_TYPES = {
    RuntimeEventType.POSTURE_OBSERVATION,
    RuntimeEventType.TRANSITION_EVENT,
}

# Dormant superset key (abc-interface: TransitionEvent.evidence is a free
# dict): A may attach the fall window's raw frame so the visual confirmation
# starts without waiting for C's upload.  A never has to send it.
EVIDENCE_FRAME_KEY = "frame_jpeg_b64"


class RuntimeDecisionPublisher:
    """Envelope newly emitted decisions and fan them out over the hub.

    Also keeps the latest broadcast envelope for the hub to replay to late
    joiners: without it, a viewer page opened after the fall (or reconnecting
    inside its retry window) misses the alarm-bearing decision forever — the
    terminal states get no follow-up broadcast to catch up on.
    """

    def __init__(self, *, registry: RuntimeSessionRegistry, hub: DecisionEventHub) -> None:
        self._registry = registry
        self._hub = hub
        # Sequence allocation and the broadcast must be one ordered step, or
        # concurrent publishers can put n+1 on the wire before n (Codex P1).
        self._order_lock = threading.Lock()
        self._latest_event: dict[str, Any] | None = None
        # Self-registration so every composition (server main, tests, demo
        # CLI) gets late-joiner replay without extra wiring.
        hub.set_replay_provider(self.latest_decision_event)

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
            payload = event.to_payload()
            # Store BEFORE broadcasting: hub.accept reads the snapshot under
            # the hub lock, so any broadcast whose target-copy predates a
            # registration has already made its store visible there — the
            # reverse order would let a late joiner miss exactly that frame.
            self._latest_event = payload
            self._hub.broadcast_json(payload)

    def latest_decision_event(self) -> dict[str, Any] | None:
        """The active session's newest care_decision envelope, or None.

        Deliberately lock-free: the hub calls this while holding its own
        lock, and taking ``_order_lock`` here would ABBA-deadlock against
        ``publish_decision`` (which holds it around ``broadcast_json``). The
        plain attribute read is atomic, and any momentary staleness is
        resolved by the hub's replay-then-register ordering (worst case a
        duplicate frame, which C dedups by decision_id).
        """

        event = self._latest_event
        if event is None:
            return None
        if event.get("session_id") != self._registry.active_session_id():
            # Session switched or stopped: the old episode's decision must
            # not leak into the new session (C would drop it by session_id,
            # but B does not get to rely on that).
            return None
        return event


# States whose countdown gets the server-side safety net.
_BACKSTOP_STATES = {
    DecisionState.CHECK_IN_REQUIRED,
    DecisionState.FAMILY_NOTIFICATION_REQUIRED,
}
# C's own countdown submits first in the healthy case; the backstop fires
# late and gets rejected as stale. The grace covers网络与渲染延迟.
_BACKSTOP_GRACE_MS = 2000.0


class EscalationBackstopPublisher:
    """Decorator publisher: server-side countdown net behind C's timers.

    The contract makes C render the countdown and submit
    ``response=none/source=timeout`` — but browser tabs throttle background
    timers, and a swallowed timeout leaves the episode waiting forever
    (observed live 2026-08-02: a hung check-in also blocks every later fall,
    since an awaiting fall episode is deliberately non-preemptible). ADR-0005
    means silence MUST escalate, so B arms its own timer per countdown-bearing
    decision, offset by a grace so C normally wins; the loser is rejected as
    stale/no-pending and swallowed. Timers are daemon threads; stale firings
    after resets are rejected by the state machine, never replayed.
    """

    def __init__(self, inner: DecisionPublisher, *, grace_ms: float = _BACKSTOP_GRACE_MS) -> None:
        self._inner = inner
        self._grace_ms = grace_ms
        self._service: DecisionService | None = None

    def bind(self, service: DecisionService) -> None:
        """Late binding: the service is constructed with this publisher."""

        self._service = service

    def publish_decision(self, decision: CareDecision) -> None:
        try:
            self._inner.publish_decision(decision)
        finally:
            self._arm(decision)

    def _arm(self, decision: CareDecision) -> None:
        if self._service is None:
            return
        if decision.response_timeout_ms is None or decision.state not in _BACKSTOP_STATES:
            return
        delay_s = (decision.response_timeout_ms + self._grace_ms) / 1000.0
        timer = threading.Timer(delay_s, self._fire, args=(decision,))
        timer.daemon = True
        timer.start()

    def _fire(self, decision: CareDecision) -> None:
        service = self._service
        if service is None or decision.response_timeout_ms is None:
            return
        response = InteractionResponse(
            scene_id=decision.scene_id,
            decision_id=decision.decision_id,
            timestamp_ms=decision.timestamp_ms + decision.response_timeout_ms,
            response=ResponseValue.NONE,
            source=ResponseSource.TIMEOUT,
            demo_mode=service.demo_mode,
        )
        try:
            service.submit_response(response)
        except Exception:  # noqa: BLE001 - C answered first / episode moved on
            return


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


def evaluate_after_ingest(
    service: DecisionService,
    event: RuntimeEvent,
    danger: DangerConfirmController | None = None,
) -> None:
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
        decision = service.get_decision(scene_id=scene_id, timestamp_ms=float(timestamp_raw))
    except Exception as exc:  # noqa: BLE001 - background tick must never crash ingest
        print(f"warning: post-ingest evaluation failed for {scene_id}: {exc}")
        return
    _feed_evidence_frame(danger, event, decision)


def _feed_evidence_frame(
    danger: DangerConfirmController | None, event: RuntimeEvent, decision: CareDecision
) -> None:
    """Start the visual confirmation from A's own evidence frame, if any."""

    if danger is None or event.event_type is not RuntimeEventType.TRANSITION_EVENT:
        return
    if decision.state is not DecisionState.CHECK_IN_REQUIRED:
        return
    channels = decision.confirm_channels
    if channels is None or "frame" not in channels:
        return
    evidence = event.payload.get("evidence")
    frame_b64 = evidence.get(EVIDENCE_FRAME_KEY) if isinstance(evidence, dict) else None
    if not isinstance(frame_b64, str) or not frame_b64:
        return
    try:
        danger.submit_frame(
            scene_id=decision.scene_id,
            decision_id=decision.decision_id,
            image_b64=frame_b64,
            timestamp_ms=decision.timestamp_ms,
            origin="a_evidence",
        )
    except DangerRejectedError as exc:
        # Evidence frames are best-effort; a refusal only means the episode
        # moved on or the payload was junk.
        print(f"warning: evidence frame refused for {decision.scene_id}: {exc.code}")


def spawn_post_ingest_evaluation(
    service: DecisionService,
    event: RuntimeEvent,
    *,
    danger: DangerConfirmController | None = None,
) -> None:
    """Fire-and-forget wrapper used by the server's /api/events route."""

    thread = threading.Thread(
        target=evaluate_after_ingest, args=(service, event, danger), daemon=True
    )
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
        danger: DangerConfirmController | None = None,
    ) -> None:
        self._events_url = events_url
        self._ingest = ingest
        self._registry = registry
        self._service = service
        self._client_factory = client_factory
        self._danger = danger
        self._lock = threading.Lock()
        self._client: PerceptionEventClient | None = None

    @property
    def events_url(self) -> str:
        return self._events_url

    @property
    def safe_url(self) -> str:
        """Log/response-safe URL: no userinfo, query redacted."""

        return _redact_url(self._events_url)

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
        # Claim before the socket exists: the push entry must already be
        # closed when the first pulled event arrives (Codex R4).
        self._ingest.claim_pull(session_id)
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
        self._ingest.release_pull()
        if client is not None:
            client.stop()

    def _consume(self, event: RuntimeEvent) -> None:
        """Feed one of A's events through the same path the POST route uses."""

        try:
            self._ingest.submit(
                event.to_payload(),
                active_session_id=self._registry.active_session_id(),
                source="pull",
            )
        except IngestError as exc:
            # Stale or malformed events are A's to fix; dropping one must not
            # kill the subscription (the client keeps the socket open).
            print(f"warning: dropped event from A: {exc.code}: {exc}", file=sys.stderr)
            return
        spawn_post_ingest_evaluation(self._service, event, danger=self._danger)
