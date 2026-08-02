"""Tests for B's windowed behavior features and their spatial dormant superset."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from reme.decision.behavior import (
    EVIDENCE_DESCENT_KEY,
    EVIDENCE_DROP_RATIO_KEY,
    EVIDENCE_POST_IMPACT_KEY,
    FALL_DESCENT_MAX_MS,
    FALL_DESCENT_MIN_MS,
    STILL_EPISODE_MIN_MS,
    SpatialHints,
    behavior_summary_zh,
    extract_behavior_features,
    parse_spatial_hints,
    plausible_fall_dynamics,
)
from reme.decision.context import (
    LandmarkQuality,
    MotionLevel,
    Posture,
    PostureObservation,
    Transition,
    TransitionEvent,
)

SCENE_ID = "behavior_demo_01"


@dataclass(frozen=True, slots=True)
class _Streams:
    """Minimal in-memory stand-in for the PerceptionStreams protocol."""

    scene_id: str
    postures: tuple[PostureObservation, ...]
    transitions: tuple[TransitionEvent, ...]


def _observation(
    *,
    timestamp_ms: float,
    person_detected: bool = True,
    posture: Posture = Posture.SITTING,
    posture_confidence: float = 0.9,
    posture_duration_ms: float = 0.0,
    motion_level: MotionLevel = MotionLevel.MEDIUM,
    landmark_quality: LandmarkQuality = LandmarkQuality.USABLE,
) -> PostureObservation:
    return PostureObservation(
        scene_id=SCENE_ID,
        timestamp_ms=timestamp_ms,
        person_detected=person_detected,
        posture=posture,
        posture_confidence=posture_confidence,
        posture_duration_ms=posture_duration_ms,
        motion_level=motion_level,
        landmark_quality=landmark_quality,
    )


def _transition(
    *,
    start_ms: float,
    end_ms: float | None = None,
    event_id: str = "transition-0001",
    transition: Transition = Transition.FALL_LIKE,
    transition_confidence: float = 0.8,
    evidence: dict[str, Any] | None = None,
    landmark_quality: LandmarkQuality = LandmarkQuality.USABLE,
) -> TransitionEvent:
    return TransitionEvent(
        scene_id=SCENE_ID,
        event_id=event_id,
        start_ms=start_ms,
        end_ms=start_ms if end_ms is None else end_ms,
        transition=transition,
        transition_confidence=transition_confidence,
        evidence={} if evidence is None else evidence,
        landmark_quality=landmark_quality,
    )


def _streams(
    *,
    postures: tuple[PostureObservation, ...] = (),
    transitions: tuple[TransitionEvent, ...] = (),
) -> _Streams:
    return _Streams(scene_id=SCENE_ID, postures=postures, transitions=transitions)


def _hints(
    *,
    descent_duration_ms: float | None = None,
    com_drop_ratio: float | None = None,
    post_impact_motion: float | None = None,
) -> SpatialHints:
    return SpatialHints(
        descent_duration_ms=descent_duration_ms,
        com_drop_ratio=com_drop_ratio,
        post_impact_motion=post_impact_motion,
    )


# --- parse_spatial_hints ---------------------------------------------------


def test_evidence_without_any_recognised_key_yields_no_hints() -> None:
    assert parse_spatial_hints({}) is None
    assert parse_spatial_hints({"note": "unrelated producer field"}) is None


def test_all_three_spatial_keys_are_read() -> None:
    hints = parse_spatial_hints(
        {
            EVIDENCE_DESCENT_KEY: 900,
            EVIDENCE_DROP_RATIO_KEY: 0.55,
            EVIDENCE_POST_IMPACT_KEY: 0.0,
        }
    )
    assert hints == _hints(descent_duration_ms=900.0, com_drop_ratio=0.55, post_impact_motion=0.0)


def test_one_readable_key_survives_junk_neighbours() -> None:
    hints = parse_spatial_hints(
        {
            EVIDENCE_DESCENT_KEY: 800.0,
            EVIDENCE_DROP_RATIO_KEY: "0.4",
            EVIDENCE_POST_IMPACT_KEY: None,
        }
    )
    assert hints == _hints(descent_duration_ms=800.0)


def test_booleans_are_never_accepted_as_numbers() -> None:
    assert parse_spatial_hints({EVIDENCE_DROP_RATIO_KEY: True}) is None
    assert parse_spatial_hints({EVIDENCE_DESCENT_KEY: True}) is None


def test_out_of_range_and_non_finite_values_are_treated_as_absent() -> None:
    assert parse_spatial_hints({EVIDENCE_DROP_RATIO_KEY: 1.5}) is None
    assert parse_spatial_hints({EVIDENCE_POST_IMPACT_KEY: -0.1}) is None
    assert parse_spatial_hints({EVIDENCE_DESCENT_KEY: 0}) is None
    assert parse_spatial_hints({EVIDENCE_DESCENT_KEY: -300.0}) is None
    assert parse_spatial_hints({EVIDENCE_DESCENT_KEY: float("nan")}) is None
    assert parse_spatial_hints({EVIDENCE_DESCENT_KEY: float("inf")}) is None


def test_dirty_evidence_of_every_shape_never_raises() -> None:
    dirty: dict[str, Any] = {
        EVIDENCE_DESCENT_KEY: {"nested": 1},
        EVIDENCE_DROP_RATIO_KEY: [0.5],
        EVIDENCE_POST_IMPACT_KEY: "0.9",
    }
    assert parse_spatial_hints(dirty) is None


# --- plausible_fall_dynamics -----------------------------------------------


def test_missing_descent_duration_is_unknown_not_implausible() -> None:
    assert plausible_fall_dynamics(_hints(com_drop_ratio=0.9)) is None


def test_descent_inside_the_guardband_is_plausible_without_a_drop_ratio() -> None:
    assert plausible_fall_dynamics(_hints(descent_duration_ms=700.0)) is True
    assert plausible_fall_dynamics(_hints(descent_duration_ms=FALL_DESCENT_MIN_MS)) is True
    assert plausible_fall_dynamics(_hints(descent_duration_ms=FALL_DESCENT_MAX_MS)) is True


def test_descent_outside_the_guardband_is_implausible() -> None:
    assert plausible_fall_dynamics(_hints(descent_duration_ms=FALL_DESCENT_MIN_MS - 1.0)) is False
    assert plausible_fall_dynamics(_hints(descent_duration_ms=FALL_DESCENT_MAX_MS + 1.0)) is False


def test_shallow_centre_of_mass_drop_rejects_an_otherwise_fast_descent() -> None:
    assert plausible_fall_dynamics(_hints(descent_duration_ms=700.0, com_drop_ratio=0.29)) is False
    assert plausible_fall_dynamics(_hints(descent_duration_ms=700.0, com_drop_ratio=0.3)) is True


# --- extract_behavior_features ---------------------------------------------


def test_window_opens_exclusively_and_closes_inclusively() -> None:
    streams = _streams(
        postures=(
            _observation(timestamp_ms=1000.0),
            _observation(timestamp_ms=61000.0),
            _observation(timestamp_ms=121000.0),
        ),
        transitions=(
            _transition(start_ms=1000.0, event_id="t-open"),
            _transition(start_ms=121000.0, event_id="t-close"),
        ),
    )
    features = extract_behavior_features(streams, timestamp_ms=121000.0, window_ms=120000.0)
    assert features.observation_count == 2
    assert features.fall_like_count == 1


def test_empty_stream_yields_a_zeroed_window() -> None:
    features = extract_behavior_features(_streams(), timestamp_ms=5000.0, window_ms=120000.0)
    assert features.observation_count == 0
    assert features.posture_change_count == 0
    assert features.restlessness_score == 0.0
    assert features.longest_still_ms == 0.0
    assert features.stillness_episode_count == 0
    assert features.dominant_posture is None
    assert features.spatial_hints is None


def test_undetected_observation_breaks_posture_change_continuity() -> None:
    continuous = _streams(
        postures=(
            _observation(timestamp_ms=1000.0, posture=Posture.SITTING),
            _observation(timestamp_ms=2000.0, posture=Posture.STANDING),
        )
    )
    interrupted = _streams(
        postures=(
            _observation(timestamp_ms=1000.0, posture=Posture.SITTING),
            _observation(timestamp_ms=1500.0, person_detected=False, posture=Posture.UNKNOWN),
            _observation(timestamp_ms=2000.0, posture=Posture.STANDING),
        )
    )
    assert extract_behavior_features(continuous, timestamp_ms=3000.0).posture_change_count == 1
    assert extract_behavior_features(interrupted, timestamp_ms=3000.0).posture_change_count == 0
    assert extract_behavior_features(interrupted, timestamp_ms=3000.0).sit_to_stand_count == 0


def test_restlessness_follows_the_documented_slot_formula() -> None:
    calm = _streams(
        postures=(
            _observation(timestamp_ms=1000.0, motion_level=MotionLevel.STILL),
            _observation(timestamp_ms=2000.0, motion_level=MotionLevel.STILL),
        )
    )
    busy = _streams(
        postures=(
            _observation(
                timestamp_ms=1000.0, posture=Posture.SITTING, motion_level=MotionLevel.LOW
            ),
            _observation(
                timestamp_ms=2000.0, posture=Posture.STANDING, motion_level=MotionLevel.HIGH
            ),
            _observation(
                timestamp_ms=3000.0, posture=Posture.SITTING, motion_level=MotionLevel.LOW
            ),
        )
    )
    calm_features = extract_behavior_features(calm, timestamp_ms=4000.0, window_ms=120000.0)
    busy_features = extract_behavior_features(busy, timestamp_ms=4000.0, window_ms=120000.0)
    # 120000 / 20000 == 6 slots; busy has 2 posture changes + 2 motion flips.
    assert calm_features.restlessness_score == 0.0
    assert busy_features.restlessness_score == pytest.approx(4.0 / 6.0)
    assert busy_features.restlessness_score > calm_features.restlessness_score


def test_restlessness_saturates_at_one() -> None:
    postures = tuple(
        _observation(
            timestamp_ms=1000.0 * step,
            posture=Posture.SITTING if step % 2 else Posture.STANDING,
            motion_level=MotionLevel.LOW if step % 2 else MotionLevel.HIGH,
        )
        for step in range(1, 12)
    )
    features = extract_behavior_features(
        _streams(postures=postures), timestamp_ms=12000.0, window_ms=20000.0
    )
    assert features.restlessness_score == 1.0


def test_stillness_episodes_count_only_runs_past_the_minimum() -> None:
    streams = _streams(
        postures=(
            _observation(timestamp_ms=1000.0, motion_level=MotionLevel.STILL),
            _observation(timestamp_ms=4000.0, motion_level=MotionLevel.LOW),
            _observation(timestamp_ms=5000.0, motion_level=MotionLevel.HIGH),
            _observation(timestamp_ms=6000.0, motion_level=MotionLevel.STILL),
            _observation(timestamp_ms=6000.0 + STILL_EPISODE_MIN_MS, motion_level=MotionLevel.LOW),
        )
    )
    features = extract_behavior_features(streams, timestamp_ms=30000.0, window_ms=120000.0)
    assert features.stillness_episode_count == 1
    assert features.longest_still_ms == STILL_EPISODE_MIN_MS


def test_still_episode_borrows_a_longer_self_reported_duration() -> None:
    streams = _streams(
        postures=(
            _observation(
                timestamp_ms=9000.0,
                motion_level=MotionLevel.STILL,
                posture_duration_ms=45000.0,
            ),
        )
    )
    features = extract_behavior_features(streams, timestamp_ms=10000.0, window_ms=120000.0)
    assert features.longest_still_ms == 45000.0
    assert features.stillness_episode_count == 1


def test_undetected_sample_closes_a_still_episode() -> None:
    streams = _streams(
        postures=(
            _observation(timestamp_ms=1000.0, motion_level=MotionLevel.STILL),
            _observation(
                timestamp_ms=8000.0, person_detected=False, motion_level=MotionLevel.STILL
            ),
            _observation(timestamp_ms=15000.0, motion_level=MotionLevel.STILL),
        )
    )
    features = extract_behavior_features(streams, timestamp_ms=20000.0, window_ms=120000.0)
    assert features.longest_still_ms == 0.0
    assert features.stillness_episode_count == 0


def test_posture_recovery_counters_track_upright_moves() -> None:
    streams = _streams(
        postures=(
            _observation(timestamp_ms=1000.0, posture=Posture.LYING),
            _observation(timestamp_ms=2000.0, posture=Posture.SITTING),
            _observation(timestamp_ms=3000.0, posture=Posture.STANDING),
            _observation(timestamp_ms=4000.0, posture=Posture.LYING),
            _observation(timestamp_ms=5000.0, posture=Posture.STANDING),
        )
    )
    features = extract_behavior_features(streams, timestamp_ms=6000.0, window_ms=120000.0)
    assert features.lying_to_upright_count == 2
    assert features.sit_to_stand_count == 1
    assert features.posture_change_count == 4


def test_dominant_posture_breaks_ties_on_the_later_appearance() -> None:
    streams = _streams(
        postures=(
            _observation(timestamp_ms=1000.0, posture=Posture.SITTING),
            _observation(timestamp_ms=2000.0, posture=Posture.STANDING),
            _observation(timestamp_ms=3000.0, posture=Posture.SITTING),
            _observation(timestamp_ms=4000.0, posture=Posture.STANDING),
        )
    )
    features = extract_behavior_features(streams, timestamp_ms=5000.0, window_ms=120000.0)
    assert features.dominant_posture is Posture.STANDING


def test_dominant_posture_ignores_undetected_samples() -> None:
    streams = _streams(
        postures=(
            _observation(timestamp_ms=1000.0, person_detected=False, posture=Posture.UNKNOWN),
            _observation(timestamp_ms=2000.0, person_detected=False, posture=Posture.UNKNOWN),
            _observation(timestamp_ms=3000.0, posture=Posture.LYING),
        )
    )
    features = extract_behavior_features(streams, timestamp_ms=4000.0, window_ms=120000.0)
    assert features.observation_count == 3
    assert features.dominant_posture is Posture.LYING


def test_transitions_are_counted_by_kind_and_hints_come_from_the_latest_fall() -> None:
    streams = _streams(
        transitions=(
            _transition(
                start_ms=10000.0,
                event_id="t-1",
                evidence={EVIDENCE_DESCENT_KEY: 5000.0},
            ),
            _transition(start_ms=20000.0, event_id="t-2", transition=Transition.UNCERTAIN),
            _transition(start_ms=30000.0, event_id="t-3", transition=Transition.NORMAL),
            _transition(
                start_ms=40000.0,
                event_id="t-4",
                evidence={EVIDENCE_DESCENT_KEY: 800.0, EVIDENCE_DROP_RATIO_KEY: 0.6},
            ),
        )
    )
    features = extract_behavior_features(streams, timestamp_ms=50000.0, window_ms=120000.0)
    assert features.fall_like_count == 2
    assert features.uncertain_transition_count == 1
    assert features.spatial_hints == _hints(descent_duration_ms=800.0, com_drop_ratio=0.6)


def test_unreadable_evidence_on_the_last_fall_keeps_the_earlier_hints() -> None:
    streams = _streams(
        transitions=(
            _transition(start_ms=10000.0, event_id="t-1", evidence={EVIDENCE_DESCENT_KEY: 700.0}),
            _transition(start_ms=20000.0, event_id="t-2", evidence={"unrelated": "junk"}),
        )
    )
    features = extract_behavior_features(streams, timestamp_ms=30000.0, window_ms=120000.0)
    assert features.spatial_hints == _hints(descent_duration_ms=700.0)


def test_illegal_window_arguments_raise() -> None:
    streams = _streams()
    with pytest.raises(ValueError):
        extract_behavior_features(streams, timestamp_ms=-1.0)
    with pytest.raises(ValueError):
        extract_behavior_features(streams, timestamp_ms=float("nan"))
    with pytest.raises(ValueError):
        extract_behavior_features(streams, timestamp_ms=1000.0, window_ms=0.0)
    with pytest.raises(ValueError):
        extract_behavior_features(streams, timestamp_ms=1000.0, window_ms=-5000.0)
    with pytest.raises(ValueError):
        extract_behavior_features(streams, timestamp_ms=1000.0, window_ms=float("inf"))


# --- behavior_summary_zh ---------------------------------------------------


def test_summary_of_an_empty_window_says_so() -> None:
    features = extract_behavior_features(_streams(), timestamp_ms=1000.0, window_ms=120000.0)
    assert behavior_summary_zh(features) == "近2分钟：无有效观察"


def test_summary_reports_posture_stillness_and_fall_dynamics() -> None:
    streams = _streams(
        postures=(
            _observation(timestamp_ms=10000.0, posture=Posture.SITTING),
            _observation(timestamp_ms=20000.0, posture=Posture.STANDING),
            _observation(
                timestamp_ms=30000.0,
                posture=Posture.SITTING,
                motion_level=MotionLevel.STILL,
                posture_duration_ms=45000.0,
            ),
        ),
        transitions=(
            _transition(
                start_ms=25000.0,
                evidence={EVIDENCE_DESCENT_KEY: 800.0, EVIDENCE_DROP_RATIO_KEY: 0.6},
            ),
        ),
    )
    features = extract_behavior_features(streams, timestamp_ms=60000.0, window_ms=120000.0)
    summary = behavior_summary_zh(features)
    assert summary == (
        "近2分钟：以坐姿为主，体位变化2次，最长静止45秒，1次疑似跌倒转换（下坠动力学合理）"
    )
    assert len(summary) <= 80


def test_summary_flags_doubtful_dynamics_and_stays_short() -> None:
    streams = _streams(
        postures=(_observation(timestamp_ms=10000.0, posture=Posture.LYING),),
        transitions=(
            _transition(
                start_ms=9000.0,
                evidence={EVIDENCE_DESCENT_KEY: FALL_DESCENT_MAX_MS + 1000.0},
            ),
            _transition(start_ms=9500.0, event_id="t-uncertain", transition=Transition.UNCERTAIN),
        ),
    )
    features = extract_behavior_features(streams, timestamp_ms=60000.0, window_ms=120000.0)
    summary = behavior_summary_zh(features)
    assert "下坠动力学存疑" in summary
    assert "1次不确定转换" in summary
    assert len(summary) <= 80


def test_summary_omits_dynamics_when_no_spatial_evidence_exists() -> None:
    streams = _streams(
        postures=(_observation(timestamp_ms=10000.0, posture=Posture.LYING),),
        transitions=(_transition(start_ms=9000.0),),
    )
    features = extract_behavior_features(streams, timestamp_ms=60000.0, window_ms=120000.0)
    summary = behavior_summary_zh(features)
    assert "1次疑似跌倒转换" in summary
    assert "下坠动力学" not in summary


def test_summary_uses_whole_minutes_with_a_floor_of_one() -> None:
    streams = _streams(postures=(_observation(timestamp_ms=10000.0),))
    short = extract_behavior_features(streams, timestamp_ms=11000.0, window_ms=30000.0)
    long_window = extract_behavior_features(streams, timestamp_ms=11000.0, window_ms=300000.0)
    assert behavior_summary_zh(short).startswith("近1分钟：")
    assert behavior_summary_zh(long_window).startswith("近5分钟：")


# --- Codex R3 regressions ---------------------------------------------------


def test_huge_integer_evidence_reads_as_absent() -> None:
    assert parse_spatial_hints({EVIDENCE_DESCENT_KEY: 10**400}) is None


def test_still_low_jitter_is_not_restlessness() -> None:
    postures = tuple(
        _observation(
            timestamp_ms=1000.0 * index,
            motion_level=MotionLevel.STILL if index % 2 == 0 else MotionLevel.LOW,
        )
        for index in range(1, 11)
    )
    features = extract_behavior_features(_streams(postures=postures), timestamp_ms=10000.0)
    assert features.restlessness_score == 0.0
    # 9s of continuous low motion: one run, but below the 10s episode floor.
    assert features.stillness_episode_count == 0
    assert features.longest_still_ms == 9000.0


def test_medium_to_high_jitter_is_not_restlessness_either() -> None:
    postures = tuple(
        _observation(
            timestamp_ms=1000.0 * index,
            motion_level=MotionLevel.MEDIUM if index % 2 == 0 else MotionLevel.HIGH,
        )
        for index in range(1, 11)
    )
    features = extract_behavior_features(_streams(postures=postures), timestamp_ms=10000.0)
    assert features.restlessness_score == 0.0


def test_carried_in_duration_is_clamped_to_the_window() -> None:
    postures = (
        _observation(
            timestamp_ms=40000.0,
            motion_level=MotionLevel.STILL,
            posture_duration_ms=999999.0,
        ),
    )
    features = extract_behavior_features(
        _streams(postures=postures), timestamp_ms=40000.0, window_ms=20000.0
    )
    assert features.longest_still_ms == 20000.0


# --- A/B 对接：A 实际发出的 evidence 键（upstream transitions.py） -----------


def _a_evidence(**overrides: Any) -> dict[str, Any]:
    """One TransitionEvent.evidence dict shaped like A actually emits it."""

    payload: dict[str, Any] = {
        "center_height_change": 0.21,
        "maximum_center_drop": 0.24,
        "peak_keypoint_speed": 0.71,
        "torso_direction_change_deg": 52.0,
        "maximum_torso_excursion_deg": 58.0,
        "posture_before": "standing",
        "posture_after": "lying",
        "intermediate_postures": [],
        "visible_keypoint_ratio": 0.83,
        "window_duration_ms": 1180.0,
    }
    payload.update(overrides)
    return payload


def test_parses_the_evidence_a_actually_emits() -> None:
    hints = parse_spatial_hints(_a_evidence())
    assert hints is not None
    assert hints.torso_drop_ratio == 0.24
    assert hints.peak_keypoint_speed == 0.71
    assert hints.torso_direction_change_deg == 52.0
    assert hints.window_duration_ms == 1180.0
    # The idealised keys stay absent: A does not measure a pure descent.
    assert hints.descent_duration_ms is None
    assert hints.com_drop_ratio is None


def test_a_evidence_supports_a_fall_hypothesis() -> None:
    assert plausible_fall_dynamics(parse_spatial_hints(_a_evidence())) is True


def test_shallow_torso_drop_contradicts_a_fall() -> None:
    hints = parse_spatial_hints(_a_evidence(maximum_center_drop=0.03))
    assert hints is not None
    assert plausible_fall_dynamics(hints) is False


def test_upward_center_move_is_not_a_drop() -> None:
    # Image y grows downward, so a negative delta means the body rose.
    hints = parse_spatial_hints(_a_evidence(maximum_center_drop=-0.3))
    assert hints is not None
    assert hints.torso_drop_ratio is None
    # No drop and no descent time: unknown, never a denial.
    assert plausible_fall_dynamics(hints) is None


def test_window_duration_is_not_used_as_a_descent_gate() -> None:
    # A's window spans the whole transition plus settle; feeding it to the
    # 150-2000ms descent gate would reject genuine falls.
    hints = parse_spatial_hints(_a_evidence(window_duration_ms=3200.0))
    assert hints is not None
    assert plausible_fall_dynamics(hints) is True


def test_a_evidence_survives_partial_payloads() -> None:
    hints = parse_spatial_hints({"maximum_center_drop": 0.3})
    assert hints is not None and hints.torso_drop_ratio == 0.3
    assert parse_spatial_hints({"posture_before": "standing"}) is None
