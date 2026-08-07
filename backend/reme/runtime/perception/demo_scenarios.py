"""Local-only manual scenarios that exercise the real A→B runtime contract."""

from __future__ import annotations

from dataclasses import dataclass

from reme.runtime.perception.posture_runtime import POSTURE_SCHEMA_VERSION
from reme.runtime.perception.runtime import RuntimeEvent, RuntimeEventType
from reme.runtime.perception.transitions import TRANSITION_SCHEMA_VERSION

DEBUG_SCENARIOS = ("fall", "long_sit", "normal")


class DemoScenarioError(ValueError):
    """Raised when C requests an unsupported manual scenario."""


@dataclass(frozen=True, slots=True)
class DemoScenarioCommand:
    """One manual scenario command sent over C's existing camera WebSocket."""

    session_id: str
    scene_id: str
    timestamp_ms: float
    scenario: str

    def __post_init__(self) -> None:
        if not self.session_id:
            raise DemoScenarioError("session_id must be non-empty")
        if not self.scene_id:
            raise DemoScenarioError("scene_id must be non-empty")
        if self.timestamp_ms < 0:
            raise DemoScenarioError("timestamp_ms must be non-negative")
        if self.scenario not in DEBUG_SCENARIOS:
            raise DemoScenarioError(f"scenario must be one of {DEBUG_SCENARIOS}")


def build_demo_runtime_events(
    command: DemoScenarioCommand,
    *,
    start_sequence: int,
) -> tuple[RuntimeEvent, ...]:
    """Build ordered runtime events without bypassing B's real state machine."""

    if start_sequence < 0:
        raise DemoScenarioError("start_sequence must be non-negative")
    if command.scenario == "fall":
        return _fall_events(command, start_sequence=start_sequence)
    if command.scenario == "long_sit":
        return (
            _posture_event(
                command,
                sequence=start_sequence,
                timestamp_ms=command.timestamp_ms,
                posture="sitting",
                confidence=0.95,
                duration_ms=31_000.0,
                motion_level="still",
            ),
        )
    return (
        _posture_event(
            command,
            sequence=start_sequence,
            timestamp_ms=command.timestamp_ms,
            posture="standing",
            confidence=0.95,
            duration_ms=0.0,
            motion_level="still",
        ),
    )


def _fall_events(
    command: DemoScenarioCommand,
    *,
    start_sequence: int,
) -> tuple[RuntimeEvent, ...]:
    transition_end = command.timestamp_ms
    transition_start = max(0.0, transition_end - 1_200.0)
    return (
        _posture_event(
            command,
            sequence=start_sequence,
            timestamp_ms=transition_start,
            posture="standing",
            confidence=0.95,
            duration_ms=1_500.0,
            motion_level="low",
        ),
        RuntimeEvent(
            session_id=command.session_id,
            sequence=start_sequence + 1,
            event_type=RuntimeEventType.TRANSITION_EVENT,
            payload={
                "schema_version": TRANSITION_SCHEMA_VERSION,
                "scene_id": command.scene_id,
                "event_id": f"manual-fall-{start_sequence + 1}",
                "start_ms": transition_start,
                "end_ms": transition_end,
                "transition": "fall_like_transition",
                "transition_confidence": 0.92,
                "evidence": {
                    "manual_debug": True,
                    "scenario": command.scenario,
                    "posture_before": "standing",
                    "posture_after": "lying",
                    "reasons": ["manual_acceptance_trigger"],
                    "fall_mil_model": "manual_debug",
                    "fall_mil_probability": 1.0,
                    "fall_mil_threshold": 0.0,
                    "fall_mil_candidate_eligible": True,
                    "fall_mil_confirmed": True,
                },
                "landmark_quality": "usable",
            },
        ),
        _posture_event(
            command,
            sequence=start_sequence + 2,
            timestamp_ms=transition_end + 1.0,
            posture="lying",
            confidence=0.95,
            duration_ms=1_800.0,
            motion_level="still",
        ),
    )


def _posture_event(
    command: DemoScenarioCommand,
    *,
    sequence: int,
    timestamp_ms: float,
    posture: str,
    confidence: float,
    duration_ms: float,
    motion_level: str,
) -> RuntimeEvent:
    return RuntimeEvent(
        session_id=command.session_id,
        sequence=sequence,
        event_type=RuntimeEventType.POSTURE_OBSERVATION,
        payload={
            "schema_version": POSTURE_SCHEMA_VERSION,
            "scene_id": command.scene_id,
            "timestamp_ms": round(timestamp_ms, 3),
            "frame_index": sequence,
            "person_detected": True,
            "posture": posture,
            "posture_confidence": confidence,
            "posture_duration_ms": duration_ms,
            "motion_level": motion_level,
            "visible_keypoint_ratio": 1.0,
            "classification_source": "manual_debug",
            "landmark_quality": "usable",
            "manual_debug": True,
            "debug_scenario": command.scenario,
        },
    )
