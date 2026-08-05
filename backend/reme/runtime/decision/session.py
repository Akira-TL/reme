"""B-side runtime session registry (contract sections 3.2/3.3).

Skeleton contract for parallel lane L1 — signatures are FROZEN; the server
lane (L3) codes against them with fakes. Reuse the contract dataclasses from
:mod:`reme.pose.runtime` verbatim; never define a second set.

Frozen decisions:
- Single active session per process (demo scale); starting a new session
  requires a fresh session_id (``ensure_new_session``).
- ``SessionRegistryError.code`` is machine-readable and maps to HTTP status
  in the server layer (e.g. ``session_conflict`` -> 409, ``bad_request`` ->
  400, ``unknown_session`` -> 404).
- The decision-stream sequence counter lives here: ``next_sequence`` hands out
  monotonically increasing integers per session for B's outbound
  RuntimeEvent envelopes (A's frame-derived sequences are not reusable).
- Scene existence checks belong to the server layer, not the registry.
"""

from __future__ import annotations

import threading
from dataclasses import replace

from reme.runtime.perception.runtime import (
    Component,
    RuntimeSessionError,
    RuntimeSessionRequest,
    RuntimeSessionState,
    RuntimeSessionStatus,
    ensure_new_session,
)

REQUEST_SCHEMA_VERSION = "reme-runtime-session-request/v0-experiment"

_REQUEST_FIELDS = {
    "schema_version",
    "session_id",
    "profile",
    "scene_id",
    "input_source",
    "perception_mode",
    "decision_mode",
    "camera_id",
    "manifest_path",
}


class SessionRegistryError(ValueError):
    """Raised on invalid session control requests; ``code`` maps to HTTP."""

    def __init__(self, code: str, message: str | None = None) -> None:
        super().__init__(message or code)
        self.code = code


def parse_session_request(payload: object) -> RuntimeSessionRequest:
    """Parse one RuntimeSessionRequest JSON payload.

    Raises SessionRegistryError("bad_request", ...) on shape violations;
    profile/camera/manifest cross-field rules are enforced by the contract
    dataclass itself (RuntimeSessionError is wrapped into bad_request).
    The derived mode fields are the profile's job — when C sends them they
    must match, but they are never trusted as inputs.
    """

    if not isinstance(payload, dict):
        raise SessionRegistryError("bad_request", "session request must be a JSON object")
    unknown = sorted(set(payload) - _REQUEST_FIELDS)
    if unknown:
        raise SessionRegistryError(
            "bad_request", f"session request has unexpected fields: {', '.join(unknown)}"
        )
    # Everything below the unknown-field gate is delegated to A's official
    # constructor (pose/runtime.py::RuntimeSessionRequest.from_payload), so
    # A and B can never disagree about what a given C request means.  B keeps
    # only the extra strictness A does not have — rejecting unknown fields —
    # and translates A's error type into B's HTTP-mappable code.
    try:
        return RuntimeSessionRequest.from_payload(payload)
    except RuntimeSessionError as exc:
        raise SessionRegistryError("bad_request", str(exc)) from exc


class RuntimeSessionRegistry:
    """Thread-safe single-active-session registry for the decision component."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._request: RuntimeSessionRequest | None = None
        self._status: RuntimeSessionStatus | None = None
        self._sequence = 0

    def start(self, request: RuntimeSessionRequest) -> RuntimeSessionStatus:
        """Activate a new session; the previous one must be stopped first.

        Same-session_id restart or profile switch without a new id raises
        SessionRegistryError("session_conflict"). Returns a RUNNING status
        for the DECISION component.
        """

        with self._lock:
            active = self._active_session_id_locked()
            if active is not None:
                raise SessionRegistryError(
                    "session_conflict",
                    f"session {active!r} is still active; stop it before starting a new one",
                )
            previous = self._request
            if previous is not None:
                try:
                    ensure_new_session(previous, request)
                except RuntimeSessionError as exc:
                    raise SessionRegistryError("session_conflict", str(exc)) from exc
            status = RuntimeSessionStatus(
                session_id=request.session_id,
                component=Component.DECISION,
                requested_profile=request.profile,
                effective_profile=request.profile,
                state=RuntimeSessionState.RUNNING,
            )
            self._request = request
            self._status = status
            self._sequence = 0
            return status

    def replace_active(
        self, request: RuntimeSessionRequest
    ) -> tuple[str | None, RuntimeSessionStatus]:
        """Atomically replace a stale local-demo session with ``request``.

        The normal :meth:`start` contract remains strict. This explicit path is
        reserved for C's single-page local demo, where browser refresh/HMR can
        terminate JavaScript before the old ``/api/session/stop`` reaches B.
        """

        with self._lock:
            previous_session_id = self._active_session_id_locked()
            status = RuntimeSessionStatus(
                session_id=request.session_id,
                component=Component.DECISION,
                requested_profile=request.profile,
                effective_profile=request.profile,
                state=RuntimeSessionState.RUNNING,
            )
            self._request = request
            self._status = status
            self._sequence = 0
            return previous_session_id, status

    def stop(self, session_id: str) -> RuntimeSessionStatus:
        """Stop the session (idempotent); returns a STOPPED status."""

        with self._lock:
            request = self._request
            status = self._status
            if request is None or status is None or request.session_id != session_id:
                raise SessionRegistryError("unknown_session", f"unknown session_id: {session_id!r}")
            if status.state is RuntimeSessionState.STOPPED:
                return status
            stopped = RuntimeSessionStatus(
                session_id=request.session_id,
                component=Component.DECISION,
                requested_profile=request.profile,
                effective_profile=None,
                state=RuntimeSessionState.STOPPED,
            )
            self._status = stopped
            return stopped

    def current_status(self) -> RuntimeSessionStatus | None:
        """The latest status for the active (or last) session, if any."""

        with self._lock:
            return self._status

    def active_session_id(self) -> str | None:
        """The running session id, or None."""

        with self._lock:
            return self._active_session_id_locked()

    def active_scene_id(self) -> str | None:
        """The scene bound to the active session, or None.

        Live decisions must stay scene-bound (Codex review P2): the resolver
        only serves snapshots for this scene.
        """

        with self._lock:
            if self._active_session_id_locked() is None or self._request is None:
                return None
            return self._request.scene_id

    def switch_scene(self, session_id: str, scene_id: str) -> RuntimeSessionStatus:
        """Rebind the active session to another scene without replacing the session."""

        if not scene_id.strip():
            raise SessionRegistryError("bad_request", "scene_id must be non-empty")
        with self._lock:
            request = self._request
            status = self._status
            if (
                request is None
                or status is None
                or self._active_session_id_locked() != session_id
            ):
                raise SessionRegistryError(
                    "unknown_session", f"unknown session_id: {session_id!r}"
                )
            self._request = replace(request, scene_id=scene_id.strip())
            return status

    def is_active(self, session_id: str) -> bool:
        """True when ``session_id`` is the currently running session."""

        with self._lock:
            return self._active_session_id_locked() == session_id

    def next_sequence(self, session_id: str) -> int:
        """Monotonic outbound-event sequence for the given active session.

        Raises SessionRegistryError("unknown_session") when the id is not
        the active session.
        """

        with self._lock:
            if self._active_session_id_locked() != session_id:
                raise SessionRegistryError(
                    "unknown_session", f"{session_id!r} is not the active session"
                )
            self._sequence += 1
            return self._sequence

    def mark_degraded(self, reason: str) -> RuntimeSessionStatus:
        """Report the decision component degraded without changing sessions."""

        with self._lock:
            request = self._request
            if request is None or self._active_session_id_locked() is None:
                raise SessionRegistryError("unknown_session", "no active session to degrade")
            if not reason.strip():
                raise SessionRegistryError("bad_request", "degraded reason must be non-empty")
            status = RuntimeSessionStatus(
                session_id=request.session_id,
                component=Component.DECISION,
                requested_profile=request.profile,
                effective_profile=None,
                state=RuntimeSessionState.DEGRADED,
                reason=reason,
            )
            self._status = status
            return status

    def _active_session_id_locked(self) -> str | None:
        """Session id when the latest status is RUNNING/DEGRADED; else None."""

        status = self._status
        if status is None:
            return None
        if status.state in (RuntimeSessionState.RUNNING, RuntimeSessionState.DEGRADED):
            return status.session_id
        return None
