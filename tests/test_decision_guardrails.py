"""Tests for B's deterministic triggers and escalation clamps."""

from __future__ import annotations

import math
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
    FALL_LIKE_CONFIDENCE_FLOOR,
    TriggerConfig,
    detect_concern_trigger,
    detect_fall_trigger,
    detect_observe_condition,
    violates_risk_floor,
)
from reme.decision.records import DecisionState
from reme.pose.transitions import TransitionDetectorConfig


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


def _a_side_fall_confidence(
    *,
    drop_multiple: float,
    speed_multiple: float,
    visible_keypoint_ratio: float,
) -> float:
    """Reproduce A's fall_like confidence for one point inside its fall gate.

    Mirrors ``TransitionDetector._classify`` in backend/reme/pose/transitions.py::

        conf = clamp(0.55
                     + 0.12 * min(center_height_change / fall_center_drop - 1, 1)
                     + 0.12 * min(peak_keypoint_speed / fall_peak_speed - 1, 1)
                     + 0.08 * visible_keypoint_ratio, 0.0, 0.95)

    The ``*_multiple`` arguments are ``center_height_change / fall_center_drop`` and
    ``peak_keypoint_speed / fall_peak_speed``; A only reaches this branch when
    ``all(fall_signals)`` holds, which forces both of them to be at least 1.0.
    """

    return min(
        max(
            0.55
            + 0.12 * min(drop_multiple - 1.0, 1.0)
            + 0.12 * min(speed_multiple - 1.0, 1.0)
            + 0.08 * visible_keypoint_ratio,
            0.0,
        ),
        0.95,
    )


def test_fall_confidence_floor_tracks_a_side_formula() -> None:
    """0.55 is A's arithmetic, not a round number, and must move when A's config moves."""

    # Floor: both fall gates met exactly, so both min() bonus terms are 0, and the
    # visible-keypoint ratio contributes nothing.  Crucially the ratio has NO enforced
    # lower bound: A admits frames at min_visible_keypoint_ratio, but each sample keeps
    # min(frame_ratio, posture_ratio) and the posture side is only range-checked to
    # [0, 1].  An earlier revision assumed a 0.5 floor here and set the threshold to
    # 0.59, which silently discarded every real fall observed under occlusion.
    floor = _a_side_fall_confidence(
        drop_multiple=1.0, speed_multiple=1.0, visible_keypoint_ratio=0.0
    )
    # Ceiling: both bonus terms saturated at their min(..., 1.0) cap, every keypoint visible.
    ceiling = _a_side_fall_confidence(
        drop_multiple=2.0, speed_multiple=2.0, visible_keypoint_ratio=1.0
    )
    assert round(floor, 6) == FALL_LIKE_CONFIDENCE_FLOOR == 0.55
    assert round(ceiling, 6) == 0.87  # A's 0.95 clamp is unreachable
    assert TriggerConfig().fall_confidence_min == FALL_LIKE_CONFIDENCE_FLOOR


def test_fall_trigger_fires_at_a_side_confidence_floor() -> None:
    """A's weakest possible fall_like event must still escalate, not be silently dropped."""

    transition = _transition(transition_confidence=FALL_LIKE_CONFIDENCE_FLOOR)
    assert detect_fall_trigger(_context(active_transition=transition), config=TriggerConfig())


def test_fall_trigger_covers_the_whole_a_side_confidence_band() -> None:
    """[0.55, 0.87] is A's entire fall_like range; 0.7 and 0.59 both cut into its low band."""

    config = TriggerConfig()
    # 0.55 is A's true floor (occluded window, ratio 0); 0.578 = 0.55 + 0.08*0.35 is the
    # static posture model's own default admission floor; 0.712 is a measured hard fall;
    # 0.818511 is the rapid high-to-low trajectory in tests/test_pose_transitions.py.
    for confidence in (0.55, 0.578, 0.59, 0.65, 0.699999, 0.712, 0.818511, 0.87):
        context = _context(active_transition=_transition(transition_confidence=confidence))
        assert detect_fall_trigger(context, config=config), confidence


def test_fall_trigger_rejects_confidence_below_a_side_floor() -> None:
    """Below 0.55 nothing A labels fall_like can exist, so the floor stays a real gate."""

    config = TriggerConfig()
    for confidence in (0.0, 0.2, 0.35, 0.54):
        context = _context(active_transition=_transition(transition_confidence=confidence))
        assert not detect_fall_trigger(context, config=config), confidence


def test_fall_confidence_boundary_is_inclusive() -> None:
    """The edge is unambiguous: exactly at the floor fires, one float step below does not."""

    config = TriggerConfig()
    below_floor = math.nextafter(FALL_LIKE_CONFIDENCE_FLOOR, 0.0)
    at_floor = _transition(transition_confidence=FALL_LIKE_CONFIDENCE_FLOOR)
    just_below = _transition(transition_confidence=below_floor)
    assert detect_fall_trigger(_context(active_transition=at_floor), config=config)
    assert not detect_fall_trigger(_context(active_transition=just_below), config=config)


def test_fall_floor_survives_a_side_payload_rounding() -> None:
    """A ships round(confidence, 6) on the wire; the rounded floor must not fall under."""

    raw = _a_side_fall_confidence(
        drop_multiple=1.0,
        speed_multiple=1.0,
        visible_keypoint_ratio=TransitionDetectorConfig().min_visible_keypoint_ratio,
    )
    transition = _transition(transition_confidence=round(raw, 6))
    assert detect_fall_trigger(_context(active_transition=transition), config=TriggerConfig())


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
