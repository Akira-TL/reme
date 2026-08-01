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

from pathlib import Path

from reme.pose.runtime import (
    ModeProfile,
    RuntimeSessionError,
    RuntimeSessionRequest,
    RuntimeSessionStatus,
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
    schema_version = payload.get("schema_version", REQUEST_SCHEMA_VERSION)
    if schema_version != REQUEST_SCHEMA_VERSION:
        raise SessionRegistryError(
            "bad_request", f"schema_version must be {REQUEST_SCHEMA_VERSION!r}"
        )
    try:
        profile = ModeProfile(payload.get("profile"))
    except ValueError as exc:
        raise SessionRegistryError(
            "bad_request", f"profile must be one of {[p.value for p in ModeProfile]}"
        ) from exc
    session_id = payload.get("session_id")
    scene_id = payload.get("scene_id")
    camera_id = payload.get("camera_id")
    manifest_raw = payload.get("manifest_path")
    if not isinstance(session_id, str) or not isinstance(scene_id, str):
        raise SessionRegistryError("bad_request", "session_id and scene_id must be strings")
    if camera_id is not None and not isinstance(camera_id, str):
        raise SessionRegistryError("bad_request", "camera_id must be a string or null")
    if manifest_raw is not None and not isinstance(manifest_raw, str):
        raise SessionRegistryError("bad_request", "manifest_path must be a string or null")
    try:
        request = RuntimeSessionRequest(
            session_id=session_id,
            profile=profile,
            scene_id=scene_id,
            camera_id=camera_id,
            manifest_path=None if manifest_raw is None else Path(manifest_raw),
        )
    except RuntimeSessionError as exc:
        raise SessionRegistryError("bad_request", str(exc)) from exc
    for derived in ("input_source", "perception_mode", "decision_mode"):
        provided = payload.get(derived)
        if provided is not None and provided != getattr(request, derived).value:
            raise SessionRegistryError(
                "bad_request", f"{derived} contradicts the requested profile"
            )
    return request


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
