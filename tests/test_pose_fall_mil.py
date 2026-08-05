from __future__ import annotations

from pathlib import Path

import numpy as np
from reme.runtime.perception.fall_mil import (
    FALL_WINDOW_FEATURE_NAMES,
    FallBag,
    FallMILModel,
    FallMILTrainingConfig,
    FallWindowConfig,
    build_fall_windows,
    save_fall_mil_model,
    train_fall_mil,
)
from reme.runtime.perception.fall_weak_labels import FallPoseSample


def _sample(
    timestamp_ms: float,
    *,
    center_y: float,
    torso_angle_deg: float,
    aspect_ratio: float,
    motion_speed: float,
    posture: str,
    visible_ratio: float = 0.95,
    quality: str = "usable",
) -> FallPoseSample:
    return FallPoseSample(
        timestamp_ms=timestamp_ms,
        posture=posture,
        posture_confidence=0.9 if posture != "unknown" else 0.2,
        center_y=center_y,
        torso_angle_deg=torso_angle_deg,
        bbox_aspect_ratio=aspect_ratio,
        motion_speed=motion_speed,
        visible_keypoint_ratio=visible_ratio,
        landmark_quality=quality,
    )


def _fast_fall(*, offset: float = 0.0) -> tuple[FallPoseSample, ...]:
    samples: list[FallPoseSample] = []
    for index in range(11):
        samples.append(
            _sample(
                offset + index * 100.0,
                center_y=0.43,
                torso_angle_deg=4.0,
                aspect_ratio=0.32,
                motion_speed=0.02,
                posture="standing",
            )
        )
    for index in range(1, 8):
        progress = index / 7.0
        samples.append(
            _sample(
                offset + 1000.0 + index * 100.0,
                center_y=0.43 + progress * 0.29,
                torso_angle_deg=4.0 + progress * 78.0,
                aspect_ratio=0.32 + progress * 1.25,
                motion_speed=0.55 + progress * 0.5,
                posture="unknown",
            )
        )
    for index in range(1, 15):
        samples.append(
            _sample(
                offset + 1700.0 + index * 100.0,
                center_y=0.72,
                torso_angle_deg=82.0,
                aspect_ratio=1.57,
                motion_speed=0.03,
                posture="lying",
            )
        )
    return tuple(samples)


def _slow_lie_down(*, offset: float = 0.0) -> tuple[FallPoseSample, ...]:
    samples: list[FallPoseSample] = []
    for index in range(11):
        samples.append(
            _sample(
                offset + index * 100.0,
                center_y=0.44,
                torso_angle_deg=5.0,
                aspect_ratio=0.34,
                motion_speed=0.02,
                posture="standing",
            )
        )
    for index in range(1, 23):
        progress = index / 22.0
        samples.append(
            _sample(
                offset + 1000.0 + index * 100.0,
                center_y=0.44 + progress * 0.25,
                torso_angle_deg=5.0 + progress * 72.0,
                aspect_ratio=0.34 + progress * 1.05,
                motion_speed=0.10 + 0.04 * np.sin(progress * np.pi),
                posture="bending_or_crouching",
            )
        )
    for index in range(1, 14):
        samples.append(
            _sample(
                offset + 3200.0 + index * 100.0,
                center_y=0.69,
                torso_angle_deg=77.0,
                aspect_ratio=1.39,
                motion_speed=0.03,
                posture="lying",
            )
        )
    return tuple(samples)


def _sit_down(*, offset: float = 0.0) -> tuple[FallPoseSample, ...]:
    samples: list[FallPoseSample] = []
    for index in range(11):
        samples.append(
            _sample(
                offset + index * 100.0,
                center_y=0.43,
                torso_angle_deg=4.0,
                aspect_ratio=0.33,
                motion_speed=0.02,
                posture="standing",
            )
        )
    for index in range(1, 10):
        progress = index / 9.0
        samples.append(
            _sample(
                offset + 1000.0 + index * 100.0,
                center_y=0.43 + progress * 0.12,
                torso_angle_deg=4.0 + progress * 18.0,
                aspect_ratio=0.33 + progress * 0.20,
                motion_speed=0.16,
                posture="sitting",
            )
        )
    for index in range(1, 15):
        samples.append(
            _sample(
                offset + 1900.0 + index * 100.0,
                center_y=0.55,
                torso_angle_deg=22.0,
                aspect_ratio=0.53,
                motion_speed=0.02,
                posture="sitting",
            )
        )
    return tuple(samples)


def _bag(
    bag_id: str,
    split: str,
    label: str,
    category: str,
    samples: tuple[FallPoseSample, ...],
) -> FallBag:
    return FallBag(
        bag_id=bag_id,
        split=split,
        label=label,
        category=category,
        samples=samples,
    )


def _window_config() -> FallWindowConfig:
    return FallWindowConfig(
        durations_ms=(1500.0, 2000.0, 2500.0, 3200.0),
        stride_ms=250.0,
        min_samples=10,
        min_mean_visible_ratio=0.5,
        max_unavailable_ratio=0.25,
    )


def _training_config() -> FallMILTrainingConfig:
    return FallMILTrainingConfig(
        rounds=4,
        epochs=700,
        learning_rate=0.04,
        l2=0.001,
        hard_negatives_per_bag=4,
        background_negatives_per_bag=4,
        random_seed=17,
    )


def test_window_features_capture_fast_standing_to_fallen_transition() -> None:
    bag = _bag("fall-fast", "train", "fall", "fall", _fast_fall())

    windows = build_fall_windows(bag, config=_window_config())

    assert windows
    feature_index = {name: index for index, name in enumerate(FALL_WINDOW_FEATURE_NAMES)}
    strongest = max(windows, key=lambda window: window.features[feature_index["center_drop"]])
    assert strongest.features[feature_index["center_drop"]] > 0.2
    assert strongest.features[feature_index["torso_change_deg"]] > 50.0
    assert strongest.features[feature_index["peak_motion_speed"]] > 0.8
    assert strongest.features[feature_index["ordered_anchor_pair"]] == 1.0


def test_low_quality_sequence_does_not_generate_training_windows() -> None:
    samples = tuple(
        _sample(
            index * 100.0,
            center_y=0.5,
            torso_angle_deg=10.0,
            aspect_ratio=0.4,
            motion_speed=0.1,
            posture="unknown",
            visible_ratio=0.1,
            quality="unavailable",
        )
        for index in range(40)
    )
    bag = _bag("bad-quality", "train", "fall", "fall", samples)

    assert build_fall_windows(bag, config=_window_config()) == ()


def test_mil_training_scores_fast_fall_above_normal_transitions() -> None:
    bags = (
        _bag("fall-train-1", "train", "fall", "fall", _fast_fall()),
        _bag("fall-train-2", "train", "fall", "fall", _fast_fall(offset=50.0)),
        _bag("slow-train", "train", "normal", "normal_lie_down", _slow_lie_down()),
        _bag("sit-train", "train", "normal", "sit_down", _sit_down()),
        _bag("fall-val", "val", "fall", "fall", _fast_fall(offset=20.0)),
        _bag("slow-val", "val", "normal", "normal_lie_down", _slow_lie_down(offset=20.0)),
        _bag("sit-val", "val", "normal", "sit_down", _sit_down(offset=20.0)),
    )
    seeds = {
        "fall-train-1": (900.0, 1900.0),
        "fall-train-2": (950.0, 1950.0),
    }

    model, report = train_fall_mil(
        bags,
        seed_intervals=seeds,
        window_config=_window_config(),
        training_config=_training_config(),
    )

    positive_score = max(
        model.predict_probability(window.features)
        for window in build_fall_windows(bags[4], config=_window_config())
    )
    negative_scores = [
        max(
            model.predict_probability(window.features)
            for window in build_fall_windows(bag, config=_window_config())
        )
        for bag in bags[5:]
    ]
    assert positive_score > max(negative_scores)
    assert report["threshold_source"] == "validation_bags_only"
    assert report["selected_positive_bags"] == 2
    assert report["same_domain_negative_windows"] > 0
    assert report["event_accuracy_report_allowed"] is False
    assert "unknown_ratio" not in FALL_WINDOW_FEATURE_NAMES
    assert "degraded_ratio" not in FALL_WINDOW_FEATURE_NAMES


def test_test_split_cannot_change_model_or_threshold() -> None:
    base = (
        _bag("fall-train-1", "train", "fall", "fall", _fast_fall()),
        _bag("fall-train-2", "train", "fall", "fall", _fast_fall(offset=40.0)),
        _bag("slow-train", "train", "normal", "normal_lie_down", _slow_lie_down()),
        _bag("sit-train", "train", "normal", "sit_down", _sit_down()),
        _bag("fall-val", "val", "fall", "fall", _fast_fall(offset=20.0)),
        _bag("slow-val", "val", "normal", "normal_lie_down", _slow_lie_down(offset=20.0)),
    )
    seeds = {
        "fall-train-1": (900.0, 1900.0),
        "fall-train-2": (900.0, 1900.0),
    }
    first_bags = base + (
        _bag("test-only", "test", "fall", "fall", _fast_fall(offset=70.0)),
    )
    second_bags = base + (
        _bag("test-only", "test", "normal", "sit_down", _sit_down(offset=70.0)),
    )

    first_model, _ = train_fall_mil(
        first_bags,
        seed_intervals=seeds,
        window_config=_window_config(),
        training_config=_training_config(),
    )
    second_model, _ = train_fall_mil(
        second_bags,
        seed_intervals=seeds,
        window_config=_window_config(),
        training_config=_training_config(),
    )

    np.testing.assert_allclose(first_model.feature_mean, second_model.feature_mean)
    np.testing.assert_allclose(first_model.feature_scale, second_model.feature_scale)
    np.testing.assert_allclose(first_model.weights, second_model.weights)
    assert first_model.bias == second_model.bias
    assert first_model.threshold == second_model.threshold


def test_model_round_trip_preserves_probability(tmp_path: Path) -> None:
    bags = (
        _bag("fall-train", "train", "fall", "fall", _fast_fall()),
        _bag("slow-train", "train", "normal", "normal_lie_down", _slow_lie_down()),
        _bag("fall-val", "val", "fall", "fall", _fast_fall(offset=20.0)),
        _bag("slow-val", "val", "normal", "normal_lie_down", _slow_lie_down(offset=20.0)),
    )
    model, _ = train_fall_mil(
        bags,
        seed_intervals={"fall-train": (900.0, 1900.0)},
        window_config=_window_config(),
        training_config=_training_config(),
    )
    window = build_fall_windows(bags[0], config=_window_config())[0]
    path = tmp_path / "fall-mil.json"

    save_fall_mil_model(path, model)
    restored = FallMILModel.load(path)

    assert restored.predict_probability(window.features) == model.predict_probability(
        window.features
    )
    assert restored.threshold == model.threshold
