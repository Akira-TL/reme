"""Tests for B's deterministic triggers and escalation clamps."""

from __future__ import annotations

from typing import Any

from reme.decision.context import (
    DecisionContext,
    LandmarkQuality,
    MotionLevel,
    Posture,
    PostureObservation,
    Transition,
    TransitionEvent,
)
from reme.decision.guardrails import (
    TriggerConfig,
    detect_concern_trigger,
    detect_fall_trigger,
    detect_observe_condition,
    violates_risk_floor,
)
from reme.decision.records import DecisionState


def _posture(**overrides: Any) -> PostureObservation:
    fields: dict[str, Any] = {
        "scene_id": "fall_demo_01",
        "timestamp_ms": 12800.0,
        "person_detected": True,
        "posture": Posture.LYING,
        "posture_confidence": 0.9,
        "posture_duration_ms": 4200.0,
        "motion_level": MotionLevel.STILL,
        "landmark_quality": LandmarkQuality.USABLE,
    }
    fields.update(overrides)
    return PostureObservation(**fields)


def _transition(**overrides: Any) -> TransitionEvent:
    fields: dict[str, Any] = {
        "scene_id": "fall_demo_01",
        "event_id": "transition-0003",
        "start_ms": 11100.0,
        "end_ms": 12700.0,
        "transition": Transition.FALL_LIKE,
        "transition_confidence": 0.8,
        "evidence": {},
        "landmark_quality": LandmarkQuality.USABLE,
    }
    fields.update(overrides)
    return TransitionEvent(**fields)


def _context(**overrides: Any) -> DecisionContext:
    fields: dict[str, Any] = {
        "scene_id": "fall_demo_01",
        "timestamp_ms": 13000.0,
        "latest_posture": _posture(),
        "active_transition": _transition(),
        "input_quality": LandmarkQuality.USABLE,
    }
    fields.update(overrides)
    return DecisionContext(**fields)


def test_fall_trigger_fires_on_high_confidence_transition_with_still_body() -> None:
    assert detect_fall_trigger(_context(), config=TriggerConfig())


def test_lying_posture_alone_never_triggers_check_in() -> None:
    context = _context(active_transition=None)
    assert not detect_fall_trigger(context, config=TriggerConfig())


def test_fall_trigger_requires_confidence_threshold() -> None:
    context = _context(active_transition=_transition(transition_confidence=0.5))
    assert not detect_fall_trigger(context, config=TriggerConfig())


def test_fall_trigger_requires_low_motion_after_transition() -> None:
    context = _context(latest_posture=_posture(motion_level=MotionLevel.HIGH))
    assert not detect_fall_trigger(context, config=TriggerConfig())


def test_fall_trigger_ignores_posture_from_before_the_transition() -> None:
    context = _context(latest_posture=_posture(timestamp_ms=9000.0))
    assert not detect_fall_trigger(context, config=TriggerConfig())


def test_fall_trigger_accepts_person_lost_after_transition() -> None:
    posture = _posture(person_detected=False, posture=Posture.UNKNOWN)
    assert detect_fall_trigger(_context(latest_posture=posture), config=TriggerConfig())


def test_concern_trigger_requires_long_still_duration() -> None:
    config = TriggerConfig(long_still_min_ms=30000.0)
    sitting = _posture(
        posture=Posture.SITTING, posture_duration_ms=31000.0, motion_level=MotionLevel.LOW
    )
    context = _context(latest_posture=sitting, active_transition=None)
    assert detect_concern_trigger(context, config=config)
    short = _posture(
        posture=Posture.SITTING, posture_duration_ms=10000.0, motion_level=MotionLevel.LOW
    )
    assert not detect_concern_trigger(_context(latest_posture=short), config=config)


def test_concern_trigger_requires_usable_landmarks() -> None:
    sitting = _posture(
        posture=Posture.SITTING,
        posture_duration_ms=40000.0,
        landmark_quality=LandmarkQuality.DEGRADED,
    )
    context = _context(latest_posture=sitting, active_transition=None)
    assert not detect_concern_trigger(context, config=TriggerConfig())


def test_observe_condition_fires_on_low_quality_input() -> None:
    context = _context(input_quality=LandmarkQuality.DEGRADED)
    assert detect_observe_condition(context)


def test_observe_condition_fires_on_uncertain_transition() -> None:
    context = _context(active_transition=_transition(transition=Transition.UNCERTAIN))
    assert detect_observe_condition(context)


def test_observe_condition_quiet_on_clean_input() -> None:
    context = _context(
        latest_posture=_posture(posture=Posture.STANDING, motion_level=MotionLevel.MEDIUM),
        active_transition=None,
    )
    assert not detect_observe_condition(context)


def test_risk_floor_blocks_lower_severity_after_family_alert() -> None:
    assert violates_risk_floor(DecisionState.CHECK_IN_REQUIRED, 2, risk_floor=3)
    assert violates_risk_floor(DecisionState.FAMILY_NOTIFICATION_REQUIRED, 2, risk_floor=3)
    assert not violates_risk_floor(DecisionState.FAMILY_NOTIFICATION_REQUIRED, 3, risk_floor=3)
    assert not violates_risk_floor(DecisionState.URGENT_ATTENTION, 4, risk_floor=3)


def test_risk_floor_inactive_before_any_escalation() -> None:
    assert not violates_risk_floor(DecisionState.NORMAL, 0, risk_floor=0)
