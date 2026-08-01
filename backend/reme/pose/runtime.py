"""Runtime session contracts shared by A, B, and C."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any


class RuntimeSessionError(ValueError):
    """Raised when a runtime session contract is invalid."""


class ModeProfile(StrEnum):
    """Supported end-to-end runtime configurations."""

    LIVE_CAMERA = "live_camera"
    RECORDED_VIDEO = "recorded_video"


class InputSource(StrEnum):
    """Where the visual input originates."""

    CAMERA = "camera"
    VIDEO = "video"


class PerceptionMode(StrEnum):
    """Whether A computes perception now or replays recorded output."""

    LIVE = "live"
    RECORDED = "recorded"


class DecisionMode(StrEnum):
    """Whether B computes decisions now or replays recorded output."""

    LIVE = "live"
    RECORDED = "recorded"


class Component(StrEnum):
    """Runtime component that acknowledges a session request."""

    PERCEPTION = "perception"
    DECISION = "decision"


class RuntimeSessionState(StrEnum):
    """Lifecycle state reported by A or B."""

    STARTING = "starting"
    RUNNING = "running"
    DEGRADED = "degraded"
    STOPPED = "stopped"


class RuntimeEventType(StrEnum):
    """Payload types transported during one runtime session."""

    FRAME_LANDMARKS = "frame_landmarks"
    POSTURE_OBSERVATION = "posture_observation"
    TRANSITION_EVENT = "transition_event"
    CARE_DECISION = "care_decision"
    INTERACTION_RESPONSE = "interaction_response"


@dataclass(frozen=True, slots=True)
class RuntimeSessionRequest:
    """C's request to start one supported runtime configuration."""

    session_id: str
    profile: ModeProfile
    scene_id: str
    camera_id: str | None = None
    manifest_path: Path | None = None
    schema_version: str = "reme-runtime-session-request/v0-experiment"

    def __post_init__(self) -> None:
        _require_identifier(self.session_id, "session_id")
        _require_identifier(self.scene_id, "scene_id")

        if self.profile is ModeProfile.LIVE_CAMERA:
            if not isinstance(self.camera_id, str) or not self.camera_id.strip():
                raise RuntimeSessionError("live_camera requires a non-empty camera_id")
            if self.manifest_path is not None:
                raise RuntimeSessionError("live_camera must not provide manifest_path")
            return

        if self.camera_id is not None:
            raise RuntimeSessionError("recorded_video must not provide camera_id")
        if self.manifest_path is None:
            raise RuntimeSessionError("recorded_video requires manifest_path")

    @property
    def input_source(self) -> InputSource:
        """Return the input source implied by the profile."""

        if self.profile is ModeProfile.LIVE_CAMERA:
            return InputSource.CAMERA
        return InputSource.VIDEO

    @property
    def perception_mode(self) -> PerceptionMode:
        """Return the perception mode implied by the profile."""

        if self.profile is ModeProfile.LIVE_CAMERA:
            return PerceptionMode.LIVE
        return PerceptionMode.RECORDED

    @property
    def decision_mode(self) -> DecisionMode:
        """Return the decision mode implied by the profile."""

        if self.profile is ModeProfile.LIVE_CAMERA:
            return DecisionMode.LIVE
        return DecisionMode.RECORDED

    def to_payload(self) -> dict[str, Any]:
        """Return the JSON-serializable control payload sent by C."""

        return {
            "schema_version": self.schema_version,
            "session_id": self.session_id,
            "profile": self.profile.value,
            "scene_id": self.scene_id,
            "input_source": self.input_source.value,
            "perception_mode": self.perception_mode.value,
            "decision_mode": self.decision_mode.value,
            "camera_id": self.camera_id,
            "manifest_path": str(self.manifest_path) if self.manifest_path else None,
        }


@dataclass(frozen=True, slots=True)
class RuntimeSessionStatus:
    """A or B's acknowledgement of the actually effective runtime state."""

    session_id: str
    component: Component
    requested_profile: ModeProfile
    effective_profile: ModeProfile | None
    state: RuntimeSessionState
    reason: str | None = None
    schema_version: str = "reme-runtime-session-status/v0-experiment"

    def __post_init__(self) -> None:
        _require_identifier(self.session_id, "session_id")

        if self.state is RuntimeSessionState.RUNNING:
            if self.effective_profile is not self.requested_profile:
                raise RuntimeSessionError(
                    "running status effective_profile must match requested_profile"
                )
            if self.reason is not None:
                raise RuntimeSessionError("running status must not provide a failure reason")
            return

        if self.state is RuntimeSessionState.DEGRADED:
            if not isinstance(self.reason, str) or not self.reason.strip():
                raise RuntimeSessionError("degraded status requires a non-empty reason")
            if self.effective_profile not in (None, self.requested_profile):
                raise RuntimeSessionError(
                    "degraded status cannot silently switch effective_profile"
                )
            return

        if self.effective_profile not in (None, self.requested_profile):
            raise RuntimeSessionError("effective_profile cannot silently change profile")

    def to_payload(self) -> dict[str, Any]:
        """Return the JSON-serializable acknowledgement shown by C."""

        return {
            "schema_version": self.schema_version,
            "session_id": self.session_id,
            "component": self.component.value,
            "requested_profile": self.requested_profile.value,
            "effective_profile": (
                self.effective_profile.value if self.effective_profile else None
            ),
            "state": self.state.value,
            "reason": self.reason,
        }


@dataclass(frozen=True, slots=True)
class RuntimeEvent:
    """Envelope that prevents events from leaking across C-controlled sessions."""

    session_id: str
    sequence: int
    event_type: RuntimeEventType
    payload: dict[str, Any]
    schema_version: str = "reme-runtime-event/v0-experiment"

    def __post_init__(self) -> None:
        _require_identifier(self.session_id, "session_id")
        if isinstance(self.sequence, bool) or not isinstance(self.sequence, int):
            raise RuntimeSessionError("sequence must be a non-negative integer")
        if self.sequence < 0:
            raise RuntimeSessionError("sequence must be a non-negative integer")
        if not isinstance(self.payload, dict):
            raise RuntimeSessionError("payload must be an object")

    def require_session(self, active_session_id: str) -> RuntimeEvent:
        """Reject data emitted for an inactive or previous session."""

        _require_identifier(active_session_id, "active_session_id")
        if self.session_id != active_session_id:
            raise RuntimeSessionError(
                f"stale session event: {self.session_id!r} != {active_session_id!r}"
            )
        return self

    def to_payload(self) -> dict[str, Any]:
        """Return the JSON-serializable event envelope."""

        return {
            "schema_version": self.schema_version,
            "session_id": self.session_id,
            "sequence": self.sequence,
            "event_type": self.event_type.value,
            "payload": dict(self.payload),
        }


def ensure_new_session(
    previous: RuntimeSessionRequest, next_request: RuntimeSessionRequest
) -> None:
    """Require a fresh identifier whenever C starts a replacement session."""

    if previous.session_id == next_request.session_id:
        raise RuntimeSessionError("starting a new runtime requires a new session_id")


def _require_identifier(value: str, field_name: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeSessionError(f"{field_name} must be a non-empty string")
