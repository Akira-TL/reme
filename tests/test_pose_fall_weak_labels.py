from __future__ import annotations

from reme.runtime.perception.fall_weak_labels import FallPoseSample, infer_weak_fall_candidate


def _sample(
    timestamp_ms: float,
    *,
    posture: str,
    confidence: float = 0.9,
    center_y: float,
    torso_angle_deg: float,
    aspect_ratio: float,
    motion_speed: float,
) -> FallPoseSample:
    return FallPoseSample(
        timestamp_ms=timestamp_ms,
        posture=posture,
        posture_confidence=confidence,
        center_y=center_y,
        torso_angle_deg=torso_angle_deg,
        bbox_aspect_ratio=aspect_ratio,
        motion_speed=motion_speed,
        visible_keypoint_ratio=0.9,
        landmark_quality="usable",
    )


def test_fast_standing_to_fallen_sequence_is_accepted() -> None:
    samples = [
        _sample(
            index * 100.0,
            posture="standing",
            center_y=0.45,
            torso_angle_deg=5.0,
            aspect_ratio=0.35,
            motion_speed=0.02,
        )
        for index in range(6)
    ]
    samples.extend(
        [
            _sample(
                600.0,
                posture="unknown",
                confidence=0.2,
                center_y=0.50,
                torso_angle_deg=25.0,
                aspect_ratio=0.50,
                motion_speed=0.55,
            ),
            _sample(
                700.0,
                posture="unknown",
                confidence=0.2,
                center_y=0.60,
                torso_angle_deg=55.0,
                aspect_ratio=0.80,
                motion_speed=0.90,
            ),
        ]
    )
    samples.extend(
        _sample(
            800.0 + index * 100.0,
            posture="lying",
            center_y=0.70,
            torso_angle_deg=82.0,
            aspect_ratio=1.60,
            motion_speed=0.04,
        )
        for index in range(6)
    )

    candidate = infer_weak_fall_candidate(samples, clip_id="fall-001")

    assert candidate.status == "accepted"
    assert candidate.transition_start_ms == 500.0
    assert candidate.transition_end_ms == 800.0
    assert candidate.evidence["center_drop"] > 0.2
    assert candidate.evidence["peak_motion_speed"] == 0.9


def test_geometry_can_supply_standing_anchor_when_static_model_abstains() -> None:
    samples = [
        _sample(
            index * 100.0,
            posture="unknown",
            confidence=0.1,
            center_y=0.45,
            torso_angle_deg=4.0,
            aspect_ratio=0.30,
            motion_speed=0.03,
        )
        for index in range(6)
    ]
    samples.extend(
        _sample(
            600.0 + index * 100.0,
            posture="lying",
            center_y=0.70,
            torso_angle_deg=80.0,
            aspect_ratio=1.50,
            motion_speed=0.04 if index > 1 else 0.8,
        )
        for index in range(7)
    )

    candidate = infer_weak_fall_candidate(samples, clip_id="geometry-standing")

    assert candidate.status == "accepted"
    assert candidate.standing_start_ms == 0.0
    assert candidate.transition_start_ms == 500.0


def test_slow_normal_lie_down_is_not_accepted_as_fall() -> None:
    samples = [
        _sample(
            index * 100.0,
            posture="standing",
            center_y=0.45,
            torso_angle_deg=5.0,
            aspect_ratio=0.35,
            motion_speed=0.02,
        )
        for index in range(6)
    ]
    samples.extend(
        _sample(
            600.0 + index * 400.0,
            posture="bending_or_crouching",
            center_y=0.48 + index * 0.03,
            torso_angle_deg=15.0 + index * 8.0,
            aspect_ratio=0.45 + index * 0.08,
            motion_speed=0.12,
        )
        for index in range(6)
    )
    samples.extend(
        _sample(
            3000.0 + index * 100.0,
            posture="lying",
            center_y=0.68,
            torso_angle_deg=78.0,
            aspect_ratio=1.40,
            motion_speed=0.03,
        )
        for index in range(6)
    )

    candidate = infer_weak_fall_candidate(samples, clip_id="normal-lie-001")

    assert candidate.status == "uncertain"
    assert "transition_too_slow" in candidate.reasons
    assert "insufficient_peak_speed" in candidate.reasons


def test_lying_without_previous_standing_is_rejected() -> None:
    samples = [
        _sample(
            index * 100.0,
            posture="lying",
            center_y=0.70,
            torso_angle_deg=80.0,
            aspect_ratio=1.50,
            motion_speed=0.02,
        )
        for index in range(8)
    ]

    candidate = infer_weak_fall_candidate(samples, clip_id="lying-only")

    assert candidate.status == "rejected"
    assert candidate.reasons == ("no_stable_standing_anchor",)


def test_low_quality_samples_do_not_form_anchors() -> None:
    samples = [
        FallPoseSample(
            timestamp_ms=index * 100.0,
            posture="standing",
            posture_confidence=0.99,
            center_y=0.45,
            torso_angle_deg=5.0,
            bbox_aspect_ratio=0.35,
            motion_speed=0.01,
            visible_keypoint_ratio=0.1,
            landmark_quality="unavailable",
        )
        for index in range(10)
    ]

    candidate = infer_weak_fall_candidate(samples, clip_id="bad-quality")

    assert candidate.status == "rejected"
    assert candidate.reasons == ("no_stable_standing_anchor",)
