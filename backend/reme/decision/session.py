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

from reme.pose.runtime import (
    RuntimeSessionRequest,
    RuntimeSessionStatus,
)


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
    """

    raise NotImplementedError


class RuntimeSessionRegistry:
    """Thread-safe single-active-session registry for the decision component."""

    def __init__(self) -> None:
        raise NotImplementedError

    def start(self, request: RuntimeSessionRequest) -> RuntimeSessionStatus:
        """Activate a new session; the previous one must be stopped first.

        Same-session_id restart or profile switch without a new id raises
        SessionRegistryError("session_conflict"). Returns a RUNNING status
        for the DECISION component.
        """

        raise NotImplementedError

    def stop(self, session_id: str) -> RuntimeSessionStatus:
        """Stop the session (idempotent); returns a STOPPED status."""

        raise NotImplementedError

    def current_status(self) -> RuntimeSessionStatus | None:
        """The latest status for the active (or last) session, if any."""

        raise NotImplementedError

    def active_session_id(self) -> str | None:
        """The running session id, or None."""

        raise NotImplementedError

    def is_active(self, session_id: str) -> bool:
        """True when ``session_id`` is the currently running session."""

        raise NotImplementedError

    def next_sequence(self, session_id: str) -> int:
        """Monotonic outbound-event sequence for the given active session.

        Raises SessionRegistryError("unknown_session") when the id is not
        the active session.
        """

        raise NotImplementedError

    def mark_degraded(self, reason: str) -> RuntimeSessionStatus:
        """Report the decision component degraded without changing sessions."""

        raise NotImplementedError
