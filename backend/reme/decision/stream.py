"""Realtime ingest: A's RuntimeEvents in, live decision context snapshots out.

Skeleton contract for parallel lane L4 — signatures are FROZEN; the server
lane (L3) codes against ``EventIngest`` with a fake.

Frozen decisions:
- ``IngestError.code`` maps to HTTP in the server layer: ``stale_session`` ->
  409, ``bad_event`` -> 422, ``no_active_session`` -> 409.
- ``LiveStreams`` duck-aligns with ``reme.decision.context.SceneStreams``
  (``.scene_id`` / ``.postures`` / ``.transitions``) so
  ``build_decision_context`` can consume either; widening that function's
  type annotation happens at integration time, NOT in this lane.
- Reuse ``reme.decision.context._parse_posture_observation`` /
  ``_parse_transition_event`` (same-package private import is allowed here;
  do not modify context.py).
- Per-scene buffers are bounded (default 2000 posture events) and
  timestamps must be non-decreasing within a session.
"""

from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass
from typing import Any

from reme.decision.context import (
    PostureObservation,
    SceneStreamError,
    TransitionEvent,
    _parse_posture_observation,
    _parse_transition_event,
)
from reme.pose.runtime import RuntimeEvent, RuntimeEventType, RuntimeSessionError

DEFAULT_MAX_EVENTS_PER_SCENE = 2000
EVENT_SCHEMA_VERSION = "reme-runtime-event/v0-experiment"

_BUFFERED_EVENT_TYPES = (
    RuntimeEventType.POSTURE_OBSERVATION,
    RuntimeEventType.TRANSITION_EVENT,
)


class IngestError(ValueError):
    """Raised on invalid inbound runtime events; ``code`` maps to HTTP."""

    def __init__(self, code: str, message: str | None = None) -> None:
        super().__init__(message or code)
        self.code = code


@dataclass(frozen=True, slots=True)
class LiveStreams:
    """A SceneStreams-shaped snapshot backed by the live ingest buffers."""

    scene_id: str
    postures: tuple[PostureObservation, ...]
    transitions: tuple[TransitionEvent, ...]


def _parse_envelope(payload: object) -> RuntimeEvent:
    """Rebuild one RuntimeEvent from an untrusted JSON envelope."""

    if not isinstance(payload, dict):
        raise IngestError("bad_event", "runtime event must be a JSON object")
    schema_version = payload.get("schema_version", EVENT_SCHEMA_VERSION)
    if schema_version != EVENT_SCHEMA_VERSION:
        raise IngestError(
            "bad_event",
            f"schema_version must be {EVENT_SCHEMA_VERSION!r}, got {schema_version!r}",
        )
    event_type_raw = payload.get("event_type")
    if not isinstance(event_type_raw, str):
        raise IngestError("bad_event", "event_type must be a string")
    try:
        event_type = RuntimeEventType(event_type_raw)
    except ValueError as exc:
        raise IngestError(
            "bad_event",
            f"event_type must be one of {[member.value for member in RuntimeEventType]}, "
            f"got {event_type_raw!r}",
        ) from exc
    # The contract dataclass owns session_id/sequence/payload validation; these stay
    # untyped on purpose so a single wrap turns its errors into ``bad_event``.
    session_id: Any = payload.get("session_id")
    sequence: Any = payload.get("sequence")
    event_payload: Any = payload.get("payload")
    try:
        # RuntimeSessionError is a ValueError subclass, so one clause covers both.
        return RuntimeEvent(
            session_id=session_id,
            sequence=sequence,
            event_type=event_type,
            payload=event_payload,
            schema_version=schema_version,
        )
    except ValueError as exc:
        raise IngestError("bad_event", str(exc)) from exc


class EventIngest:
    """Thread-safe buffer of A's realtime perception events, per scene."""

    def __init__(self, *, max_events_per_scene: int = DEFAULT_MAX_EVENTS_PER_SCENE) -> None:
        if isinstance(max_events_per_scene, bool) or not isinstance(max_events_per_scene, int):
            raise ValueError("max_events_per_scene must be a positive integer")
        if max_events_per_scene < 1:
            raise ValueError("max_events_per_scene must be a positive integer")
        self._max_events_per_scene = max_events_per_scene
        self._lock = threading.Lock()
        self._postures: dict[str, deque[PostureObservation]] = {}
        self._transitions: dict[str, deque[TransitionEvent]] = {}
        self._session_sequences: dict[str, int] = {}

    def submit(self, payload: object, *, active_session_id: str | None) -> RuntimeEvent:
        """Validate and buffer one inbound RuntimeEvent envelope.

        Rejects stale/mismatched sessions (``stale_session``), malformed
        envelopes or payloads (``bad_event``), and events while no session is
        active (``no_active_session``). Only ``posture_observation`` and
        ``transition_event`` event types are buffered; other valid types are
        accepted and ignored. Returns the parsed envelope.
        """

        if active_session_id is None:
            raise IngestError("no_active_session", "no runtime session is active")
        with self._lock:
            event = _parse_envelope(payload)
            try:
                event.require_session(active_session_id)
            except RuntimeSessionError as exc:
                raise IngestError("stale_session", str(exc)) from exc
            # Contract section 4: sequences are strictly increasing per sender
            # and session; duplicates and reordering are rejected, and the
            # watermark only advances once an event is fully accepted.
            last_sequence = self._session_sequences.get(event.session_id)
            if last_sequence is not None and event.sequence <= last_sequence:
                raise IngestError(
                    "bad_event",
                    f"sequence must be strictly increasing per session "
                    f"({event.sequence} <= {last_sequence})",
                )
            if event.event_type in _BUFFERED_EVENT_TYPES:
                label = f"runtime event {event.sequence}"
                if event.event_type is RuntimeEventType.POSTURE_OBSERVATION:
                    self._buffer_posture(event.payload, label=label)
                else:
                    self._buffer_transition(event.payload, label=label)
            self._session_sequences[event.session_id] = event.sequence
            return event

    def snapshot(self, scene_id: str) -> LiveStreams:
        """Current buffered streams for a scene (empty when unknown)."""

        with self._lock:
            postures: tuple[PostureObservation, ...] = tuple(self._postures.get(scene_id, ()))
            transitions: tuple[TransitionEvent, ...] = tuple(self._transitions.get(scene_id, ()))
        return LiveStreams(scene_id=scene_id, postures=postures, transitions=transitions)

    def reset_scene(self, scene_id: str) -> None:
        """Drop every buffered event for one scene."""

        with self._lock:
            self._postures.pop(scene_id, None)
            self._transitions.pop(scene_id, None)

    def reset_all(self) -> None:
        """Drop every buffer and sequence watermark (called on session changes)."""

        with self._lock:
            self._postures.clear()
            self._transitions.clear()
            self._session_sequences.clear()

    def _buffer_posture(self, payload: dict[str, Any], *, label: str) -> None:
        """Append one posture observation; caller holds the lock."""

        try:
            observation = _parse_posture_observation(payload, label=label)
        except SceneStreamError as exc:
            raise IngestError("bad_event", str(exc)) from exc
        buffer = self._postures.get(observation.scene_id)
        if buffer and observation.timestamp_ms < buffer[-1].timestamp_ms:
            raise IngestError(
                "bad_event",
                f"{label}: timestamp_ms must be non-decreasing per scene "
                f"({observation.timestamp_ms} < {buffer[-1].timestamp_ms}); "
                "reset the scene before replaying earlier events",
            )
        if buffer is None:
            buffer = deque(maxlen=self._max_events_per_scene)
            self._postures[observation.scene_id] = buffer
        buffer.append(observation)

    def _buffer_transition(self, payload: dict[str, Any], *, label: str) -> None:
        """Append one transition event; caller holds the lock."""

        try:
            transition = _parse_transition_event(payload, label=label)
        except SceneStreamError as exc:
            raise IngestError("bad_event", str(exc)) from exc
        buffer = self._transitions.get(transition.scene_id)
        if buffer and transition.start_ms < buffer[-1].start_ms:
            raise IngestError(
                "bad_event",
                f"{label}: start_ms must be non-decreasing per scene "
                f"({transition.start_ms} < {buffer[-1].start_ms}); "
                "reset the scene before replaying earlier events",
            )
        if buffer is None:
            buffer = deque(maxlen=self._max_events_per_scene)
            self._transitions[transition.scene_id] = buffer
        buffer.append(transition)
