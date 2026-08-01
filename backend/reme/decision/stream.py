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

from dataclasses import dataclass

from reme.decision.context import PostureObservation, TransitionEvent
from reme.pose.runtime import RuntimeEvent

DEFAULT_MAX_EVENTS_PER_SCENE = 2000


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


class EventIngest:
    """Thread-safe buffer of A's realtime perception events, per scene."""

    def __init__(self, *, max_events_per_scene: int = DEFAULT_MAX_EVENTS_PER_SCENE) -> None:
        raise NotImplementedError

    def submit(self, payload: object, *, active_session_id: str | None) -> RuntimeEvent:
        """Validate and buffer one inbound RuntimeEvent envelope.

        Rejects stale/mismatched sessions (``stale_session``), malformed
        envelopes or payloads (``bad_event``), and events while no session is
        active (``no_active_session``). Only ``posture_observation`` and
        ``transition_event`` event types are buffered; other valid types are
        accepted and ignored. Returns the parsed envelope.
        """

        raise NotImplementedError

    def snapshot(self, scene_id: str) -> LiveStreams:
        """Current buffered streams for a scene (empty when unknown)."""

        raise NotImplementedError

    def reset_scene(self, scene_id: str) -> None:
        raise NotImplementedError

    def reset_all(self) -> None:
        """Drop every buffer (called on session changes)."""

        raise NotImplementedError
