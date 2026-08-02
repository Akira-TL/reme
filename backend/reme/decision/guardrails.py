"""Deterministic safety rules: escalation triggers and outbound clamps."""

from __future__ import annotations

from dataclasses import dataclass, field

from reme.decision.context import DecisionContext, LandmarkQuality, MotionLevel, Posture, Transition
from reme.decision.records import DecisionState, PrivacyMode

LOW_MOTION_LEVELS = frozenset({MotionLevel.STILL, MotionLevel.LOW})
DOWN_POSTURES = frozenset({Posture.LYING, Posture.UNKNOWN})

# Derivation of A's fall_like confidence range (reme/pose/transitions.py::_classify):
# conf = clamp(0.55 + 0.12*min(drop/0.20 - 1, 1) + 0.12*min(speed/0.65 - 1, 1) + 0.08*r, 0, 0.95),
# emitted only when all(fall_signals) holds, which already forces drop >= 0.20 and speed >= 0.65,
# so both min() terms live in [0, 1].
#
# r is the window's smallest visible-keypoint ratio, and it has NO enforced floor: A drops frames
# under TransitionDetectorConfig.min_visible_keypoint_ratio = 0.5, but each sample stores
# min(frame_ratio, posture.visible_keypoint_ratio) (transitions.py) and the posture side is only
# range-checked to [0, 1].  So r in [0, 1] and conf in [0.55, 0.87]; the 0.95 clamp is unreachable.
# An earlier 0.59 floor assumed a 0.5 lower bound on r that the code does not enforce — Codex
# built an r=0 window and A classified it fall_like at exactly 0.55.
#
# We therefore sit at A's true floor.  Occlusion is precisely when a real fall is most likely to
# produce a low visible ratio, so trading a false check-in for a missed fall is the wrong trade.
FALL_LIKE_CONFIDENCE_FLOOR = 0.55

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
    """Per-scene deterministic thresholds, expressed in real video milliseconds.

    Provenance (PRD requirement "阈值参考公开学术论文并经实测标定"; full ledger
    in docs/references/cognition-evidence.md):

    - The *shape* of the long-stillness rule (low motion sustained over time,
      rather than a posture snapshot) follows the operationalisation used by
      validated accelerometer systems — R9 Skotte et al. 2014 — and the
      geriatric finding that what matters after a fall is time spent immobile:
      R3 Fleming & Brayne 2008 (BMJ 337:a2227), R4 Schwickert et al. 2017.
    - The *numbers* below are ours.  ``long_still_min_ms`` is a demo-scale
      value, not R4's 24.5 s marker, and both timeouts are tuned for a live
      demo's pacing.  No paper states them, and none may be cited as their
      source.
    - ``fall_confidence_min`` is the one number here that was actually
      measured: it is 按 A 的产出分布实测标定的工程值, pinned to the analytic
      floor of A's fall_like confidence (derivation above
      ``FALL_LIKE_CONFIDENCE_FLOOR``).  The previous 0.7 sat *inside* A's own
      output range [0.59, 0.87] and silently dropped every real fall scoring
      below it — an availability defect, not a threshold choice.  0.59 has no
      literature behind it either; it is A's arithmetic, and it moves the
      moment A retunes ``fall_center_drop`` / ``fall_peak_speed`` /
      ``min_visible_keypoint_ratio``.
    - Detection rates from the literature must never become Reme's promises:
      published fall-detection algorithms drop to 57.0% +/- 27.3% sensitivity
      on real-world falls (R6 Bagalà et al. 2012), which is exactly why the
      product asks a question first instead of asserting a fall.
    """

    fall_confidence_min: float = FALL_LIKE_CONFIDENCE_FLOOR
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
    if not posture.person_detected:
        # Half-frame cameras: a real fall often drops the person *out of
        # view* (the "vanish fall" candidate), so absence after a fall-like
        # transition is corroboration, not missing data. Sensitivity-first
        # per the danger-link product call — the check-in question, not this
        # gate, is what filters false positives.
        return True
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
