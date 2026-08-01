"""Deterministic safety rules: escalation triggers and outbound clamps."""

from __future__ import annotations

from dataclasses import dataclass, field

from reme.decision.context import DecisionContext, LandmarkQuality, MotionLevel, Posture, Transition
from reme.decision.records import DecisionState, PrivacyMode

LOW_MOTION_LEVELS = frozenset({MotionLevel.STILL, MotionLevel.LOW})
DOWN_POSTURES = frozenset({Posture.LYING, Posture.UNKNOWN})

_STATE_SEVERITY: dict[DecisionState, int] = {
    DecisionState.NORMAL: 0,
    DecisionState.RESOLVED: 0,
    DecisionState.OBSERVE: 1,
    DecisionState.DEGRADED: 1,
    DecisionState.CHECK_IN_REQUIRED: 2,
    DecisionState.CONSENT_REQUIRED: 2,
    DecisionState.FAMILY_NOTIFICATION_REQUIRED: 3,
    DecisionState.URGENT_ATTENTION: 4,
}


@dataclass(frozen=True, slots=True)
class TriggerConfig:
    """Per-scene deterministic thresholds, expressed in real video milliseconds."""

    fall_confidence_min: float = 0.7
    long_still_min_ms: float = 30000.0
    concern_postures: frozenset[Posture] = field(
        default_factory=lambda: frozenset({Posture.SITTING})
    )
    check_in_timeout_ms: int = 8000
    family_ack_timeout_ms: int = 8000
    rewind_tolerance_ms: float = 3000.0
    default_privacy_mode: PrivacyMode = PrivacyMode.BLURRED


def detect_fall_trigger(context: DecisionContext, *, config: TriggerConfig) -> bool:
    """High-confidence fall-like transition followed by a low, low-motion body state.

    A single lying posture never triggers on its own (contract section 8): the rule
    requires an explicit fall_like_transition hypothesis from A.
    """

    transition = context.active_transition
    if transition is None or transition.transition is not Transition.FALL_LIKE:
        return False
    if transition.transition_confidence < config.fall_confidence_min:
        return False
    posture = context.latest_posture
    if posture is None:
        return False
    if posture.timestamp_ms < transition.start_ms:
        return False
    if posture.person_detected and posture.posture not in DOWN_POSTURES:
        return False
    return posture.motion_level in LOW_MOTION_LEVELS


def detect_concern_trigger(context: DecisionContext, *, config: TriggerConfig) -> bool:
    """Prolonged low-motion stillness worth a gentle check-in (video three opening)."""

    posture = context.latest_posture
    if posture is None or not posture.person_detected:
        return False
    if posture.landmark_quality is not LandmarkQuality.USABLE:
        return False
    if posture.posture not in config.concern_postures:
        return False
    if posture.posture_duration_ms < config.long_still_min_ms:
        return False
    return posture.motion_level in LOW_MOTION_LEVELS


def detect_observe_condition(context: DecisionContext) -> bool:
    """Mild anomaly: keep watching without disturbing anyone."""

    if context.input_quality is not LandmarkQuality.USABLE:
        return True
    posture = context.latest_posture
    if posture is not None and posture.person_detected and posture.posture is Posture.UNKNOWN:
        return True
    transition = context.active_transition
    return transition is not None and transition.transition is Transition.UNCERTAIN


def state_severity(state: DecisionState) -> int:
    """Rank a decision state on the escalation ladder."""

    return _STATE_SEVERITY[state]


def violates_risk_floor(state: DecisionState, risk_level: int, *, risk_floor: int) -> bool:
    """True when a decision would walk back an escalation the rules already made.

    MiMo output must never cancel, lower, or delay a rule-driven family alert;
    only explicit rule transitions (family confirmation, late safe closure) may
    leave the escalated band.
    """

    if risk_floor <= 0:
        return False
    return state_severity(state) < risk_floor or risk_level < risk_floor
