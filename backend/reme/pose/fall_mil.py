"""Multiple-instance fall-transition training on weakly labelled pose bags."""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, cast

import numpy as np

from reme.pose.fall_training_data import derive_fall_pose_sample
from reme.pose.fall_weak_labels import FallPoseSample
from reme.pose.posture import PosturePrediction, StaticPostureModel

FALL_MIL_MODEL_SCHEMA_VERSION = "reme-fall-mil/v2-experiment"
FALL_MIL_REPORT_SCHEMA_VERSION = "reme-fall-mil-report/v2-experiment"
FALL_WINDOW_FEATURE_SCHEMA_VERSION = "reme-fall-window-features/v2-experiment"
FALL_WINDOW_FEATURE_NAMES = (
    "duration_s",
    "center_start",
    "center_end",
    "center_drop",
    "center_range",
    "center_drop_rate",
    "max_downward_center_speed",
    "torso_start_deg",
    "torso_end_deg",
    "torso_change_deg",
    "torso_range_deg",
    "torso_change_rate_deg_s",
    "max_torso_speed_deg_s",
    "log_aspect_start",
    "log_aspect_end",
    "log_aspect_change",
    "log_aspect_range",
    "log_aspect_change_rate",
    "peak_motion_speed",
    "mean_motion_speed",
    "p90_motion_speed",
    "motion_impulse_ratio",
    "high_motion_ratio",
    "start_stable_ratio",
    "end_stable_ratio",
    "mean_visible_ratio",
    "min_visible_ratio",
    "has_standing_anchor",
    "has_fallen_anchor",
    "ordered_anchor_pair",
    "anchor_gap_s",
)
BAG_SPLITS = ("train", "val", "test")
BAG_LABELS = ("fall", "normal")


class FallMILError(ValueError):
    """Raised when fall MIL data, configuration, or artifacts are invalid."""


class PosturePredictor(Protocol):
    """Minimal static-posture seam used to derive normal negative bags."""

    def predict_record(self, record: dict[str, Any]) -> PosturePrediction: ...


@dataclass(frozen=True, slots=True)
class FallBag:
    """One video-level multiple-instance bag with ordered pose samples."""

    bag_id: str
    split: str
    label: str
    category: str
    samples: tuple[FallPoseSample, ...]

    def __post_init__(self) -> None:
        if not self.bag_id.strip():
            raise FallMILError("bag_id must be non-empty")
        if self.split not in BAG_SPLITS:
            raise FallMILError(f"split must be one of {BAG_SPLITS}")
        if self.label not in BAG_LABELS:
            raise FallMILError(f"label must be one of {BAG_LABELS}")
        if not self.category.strip():
            raise FallMILError("category must be non-empty")
        if not self.samples:
            raise FallMILError("bag samples must be non-empty")
        if any(
            current.timestamp_ms <= previous.timestamp_ms
            for previous, current in zip(self.samples, self.samples[1:], strict=False)
        ):
            raise FallMILError("bag samples must have strictly increasing timestamps")


@dataclass(frozen=True, slots=True)
class FallWindowConfig:
    """Temporal window bank and input-quality rejection rules."""

    durations_ms: tuple[float, ...] = (1500.0, 2000.0, 2500.0, 3200.0)
    stride_ms: float = 250.0
    min_samples: int = 10
    min_mean_visible_ratio: float = 0.45
    max_unavailable_ratio: float = 0.25
    stable_motion_speed: float = 0.20
    standing_torso_angle_deg: float = 35.0
    standing_aspect_ratio: float = 0.65
    fallen_torso_angle_deg: float = 50.0
    fallen_aspect_ratio: float = 0.75
    max_aspect_ratio: float = 8.0
    high_motion_speed: float = 0.35
    min_candidate_center_drop: float = 0.06
    min_candidate_downward_speed: float = 0.25
    min_candidate_torso_range_deg: float = 25.0
    min_candidate_peak_motion: float = 0.25
    min_candidate_high_motion_ratio: float = 0.08
    min_candidate_abs_torso_change_deg: float = 15.0
    min_candidate_abs_log_aspect_change: float = 0.25
    min_candidate_stable_ratio: float = 0.20

    def __post_init__(self) -> None:
        if not self.durations_ms:
            raise FallMILError("durations_ms must be non-empty")
        if any(not math.isfinite(value) or value <= 0 for value in self.durations_ms):
            raise FallMILError("durations_ms values must be finite and positive")
        if tuple(sorted(set(self.durations_ms))) != self.durations_ms:
            raise FallMILError("durations_ms must be unique and sorted")
        if not 1500.0 <= self.durations_ms[0] <= self.durations_ms[-1] <= 3200.0:
            raise FallMILError("window durations must stay within 1500–3200 ms")
        if not math.isfinite(self.stride_ms) or self.stride_ms <= 0:
            raise FallMILError("stride_ms must be finite and positive")
        if self.min_samples < 2:
            raise FallMILError("min_samples must be at least 2")
        for field_name, value in (
            ("min_mean_visible_ratio", self.min_mean_visible_ratio),
            ("max_unavailable_ratio", self.max_unavailable_ratio),
        ):
            if not math.isfinite(value) or not 0.0 <= value <= 1.0:
                raise FallMILError(f"{field_name} must be between 0 and 1")
        for field_name, value in (
            ("stable_motion_speed", self.stable_motion_speed),
            ("standing_torso_angle_deg", self.standing_torso_angle_deg),
            ("standing_aspect_ratio", self.standing_aspect_ratio),
            ("fallen_torso_angle_deg", self.fallen_torso_angle_deg),
            ("fallen_aspect_ratio", self.fallen_aspect_ratio),
            ("max_aspect_ratio", self.max_aspect_ratio),
            ("high_motion_speed", self.high_motion_speed),
            ("min_candidate_center_drop", self.min_candidate_center_drop),
            ("min_candidate_downward_speed", self.min_candidate_downward_speed),
            ("min_candidate_torso_range_deg", self.min_candidate_torso_range_deg),
            ("min_candidate_peak_motion", self.min_candidate_peak_motion),
            ("min_candidate_abs_torso_change_deg", self.min_candidate_abs_torso_change_deg),
            ("min_candidate_abs_log_aspect_change", self.min_candidate_abs_log_aspect_change),
        ):
            if not math.isfinite(value) or value < 0:
                raise FallMILError(f"{field_name} must be finite and non-negative")
        for field_name, value in (
            ("min_candidate_high_motion_ratio", self.min_candidate_high_motion_ratio),
            ("min_candidate_stable_ratio", self.min_candidate_stable_ratio),
        ):
            if not 0.0 <= value <= 1.0:
                raise FallMILError(f"{field_name} must be between 0 and 1")

    def to_payload(self) -> dict[str, object]:
        return {
            "durations_ms": list(self.durations_ms),
            "stride_ms": self.stride_ms,
            "min_samples": self.min_samples,
            "min_mean_visible_ratio": self.min_mean_visible_ratio,
            "max_unavailable_ratio": self.max_unavailable_ratio,
            "stable_motion_speed": self.stable_motion_speed,
            "standing_torso_angle_deg": self.standing_torso_angle_deg,
            "standing_aspect_ratio": self.standing_aspect_ratio,
            "fallen_torso_angle_deg": self.fallen_torso_angle_deg,
            "fallen_aspect_ratio": self.fallen_aspect_ratio,
            "max_aspect_ratio": self.max_aspect_ratio,
            "high_motion_speed": self.high_motion_speed,
            "min_candidate_center_drop": self.min_candidate_center_drop,
            "min_candidate_downward_speed": self.min_candidate_downward_speed,
            "min_candidate_torso_range_deg": self.min_candidate_torso_range_deg,
            "min_candidate_peak_motion": self.min_candidate_peak_motion,
            "min_candidate_high_motion_ratio": self.min_candidate_high_motion_ratio,
            "min_candidate_abs_torso_change_deg": (
                self.min_candidate_abs_torso_change_deg
            ),
            "min_candidate_abs_log_aspect_change": (
                self.min_candidate_abs_log_aspect_change
            ),
            "min_candidate_stable_ratio": self.min_candidate_stable_ratio,
        }

    @classmethod
    def from_payload(cls, payload: object) -> FallWindowConfig:
        if not isinstance(payload, dict):
            raise FallMILError("window_config must be an object")
        durations = payload.get("durations_ms")
        if not isinstance(durations, list):
            raise FallMILError("window_config.durations_ms must be an array")
        return cls(
            durations_ms=tuple(_number(item, "durations_ms") for item in durations),
            stride_ms=_number(payload.get("stride_ms"), "stride_ms"),
            min_samples=_integer(payload.get("min_samples"), "min_samples"),
            min_mean_visible_ratio=_number(
                payload.get("min_mean_visible_ratio"), "min_mean_visible_ratio"
            ),
            max_unavailable_ratio=_number(
                payload.get("max_unavailable_ratio"), "max_unavailable_ratio"
            ),
            stable_motion_speed=_number(
                payload.get("stable_motion_speed"), "stable_motion_speed"
            ),
            standing_torso_angle_deg=_number(
                payload.get("standing_torso_angle_deg"),
                "standing_torso_angle_deg",
            ),
            standing_aspect_ratio=_number(
                payload.get("standing_aspect_ratio"), "standing_aspect_ratio"
            ),
            fallen_torso_angle_deg=_number(
                payload.get("fallen_torso_angle_deg"), "fallen_torso_angle_deg"
            ),
            fallen_aspect_ratio=_number(
                payload.get("fallen_aspect_ratio"), "fallen_aspect_ratio"
            ),
            max_aspect_ratio=_number(
                payload.get("max_aspect_ratio"), "max_aspect_ratio"
            ),
            high_motion_speed=_number(
                payload.get("high_motion_speed"), "high_motion_speed"
            ),
            min_candidate_center_drop=_number(
                payload.get("min_candidate_center_drop"),
                "min_candidate_center_drop",
            ),
            min_candidate_downward_speed=_number(
                payload.get("min_candidate_downward_speed"),
                "min_candidate_downward_speed",
            ),
            min_candidate_torso_range_deg=_number(
                payload.get("min_candidate_torso_range_deg"),
                "min_candidate_torso_range_deg",
            ),
            min_candidate_peak_motion=_number(
                payload.get("min_candidate_peak_motion"),
                "min_candidate_peak_motion",
            ),
            min_candidate_high_motion_ratio=_number(
                payload.get("min_candidate_high_motion_ratio"),
                "min_candidate_high_motion_ratio",
            ),
            min_candidate_abs_torso_change_deg=_number(
                payload.get("min_candidate_abs_torso_change_deg"),
                "min_candidate_abs_torso_change_deg",
            ),
            min_candidate_abs_log_aspect_change=_number(
                payload.get("min_candidate_abs_log_aspect_change"),
                "min_candidate_abs_log_aspect_change",
            ),
            min_candidate_stable_ratio=_number(
                payload.get("min_candidate_stable_ratio"),
                "min_candidate_stable_ratio",
            ),
        )


@dataclass(frozen=True, slots=True)
class FallWindow:
    """One fixed-duration candidate instance inside a video-level bag."""

    bag_id: str
    split: str
    label: str
    category: str
    start_ms: float
    end_ms: float
    features: tuple[float, ...]

    def __post_init__(self) -> None:
        if self.end_ms <= self.start_ms:
            raise FallMILError("window end_ms must exceed start_ms")
        if len(self.features) != len(FALL_WINDOW_FEATURE_NAMES):
            raise FallMILError("window feature vector has the wrong length")
        if any(not math.isfinite(value) for value in self.features):
            raise FallMILError("window features must be finite")

    def to_payload(self, *, probability: float | None = None) -> dict[str, object]:
        payload: dict[str, object] = {
            "bag_id": self.bag_id,
            "split": self.split,
            "label": self.label,
            "category": self.category,
            "start_ms": round(self.start_ms, 3),
            "end_ms": round(self.end_ms, 3),
        }
        if probability is not None:
            payload["probability"] = round(probability, 6)
        return payload


@dataclass(frozen=True, slots=True)
class FallMILTrainingConfig:
    """Deterministic alternating MIL and hard-negative mining settings."""

    rounds: int = 5
    epochs: int = 1800
    learning_rate: float = 0.03
    l2: float = 0.001
    hard_negatives_per_bag: int = 5
    background_negatives_per_bag: int = 5
    positive_background_negatives_per_bag: int = 4
    random_seed: int = 2026

    def __post_init__(self) -> None:
        if self.rounds < 1:
            raise FallMILError("rounds must be positive")
        if self.epochs < 1:
            raise FallMILError("epochs must be positive")
        if not math.isfinite(self.learning_rate) or self.learning_rate <= 0:
            raise FallMILError("learning_rate must be finite and positive")
        if not math.isfinite(self.l2) or self.l2 < 0:
            raise FallMILError("l2 must be finite and non-negative")
        if self.hard_negatives_per_bag < 1:
            raise FallMILError("hard_negatives_per_bag must be positive")
        if self.background_negatives_per_bag < 1:
            raise FallMILError("background_negatives_per_bag must be positive")
        if self.positive_background_negatives_per_bag < 1:
            raise FallMILError(
                "positive_background_negatives_per_bag must be positive"
            )
        if isinstance(self.random_seed, bool) or not isinstance(self.random_seed, int):
            raise FallMILError("random_seed must be an integer")

    def to_payload(self) -> dict[str, object]:
        return {
            "rounds": self.rounds,
            "epochs": self.epochs,
            "learning_rate": self.learning_rate,
            "l2": self.l2,
            "hard_negatives_per_bag": self.hard_negatives_per_bag,
            "background_negatives_per_bag": self.background_negatives_per_bag,
            "positive_background_negatives_per_bag": (
                self.positive_background_negatives_per_bag
            ),
            "random_seed": self.random_seed,
        }


@dataclass(frozen=True, slots=True)
class FallMILModel:
    """Standardized linear fall-window model with validation-only threshold."""

    feature_names: tuple[str, ...]
    feature_mean: np.ndarray
    feature_scale: np.ndarray
    weights: np.ndarray
    bias: float
    threshold: float
    window_config: FallWindowConfig
    evidence_level: str = "weak_supervision_multiple_instance"

    def __post_init__(self) -> None:
        if self.feature_names != FALL_WINDOW_FEATURE_NAMES:
            raise FallMILError("feature_names do not match the frozen fall feature order")
        feature_count = len(self.feature_names)
        if self.feature_mean.shape != (feature_count,):
            raise FallMILError("feature_mean has the wrong shape")
        if self.feature_scale.shape != (feature_count,):
            raise FallMILError("feature_scale has the wrong shape")
        if self.weights.shape != (feature_count,):
            raise FallMILError("weights have the wrong shape")
        if np.any(self.feature_scale <= 0):
            raise FallMILError("feature_scale values must be positive")
        if not math.isfinite(self.bias):
            raise FallMILError("bias must be finite")
        if not 0.0 <= self.threshold <= 1.0:
            raise FallMILError("threshold must be between 0 and 1")

    def predict_probability(self, features: Sequence[float]) -> float:
        """Return one fall-like probability for a window feature vector."""

        array = np.asarray(features, dtype=np.float64)
        if array.shape != self.feature_mean.shape:
            raise FallMILError("features have the wrong shape")
        standardized = (array - self.feature_mean) / self.feature_scale
        logit = float(standardized @ self.weights + self.bias)
        return _sigmoid_scalar(logit)

    def to_payload(self) -> dict[str, object]:
        return {
            "schema_version": FALL_MIL_MODEL_SCHEMA_VERSION,
            "feature_schema_version": FALL_WINDOW_FEATURE_SCHEMA_VERSION,
            "feature_names": list(self.feature_names),
            "feature_mean": self.feature_mean.tolist(),
            "feature_scale": self.feature_scale.tolist(),
            "weights": self.weights.tolist(),
            "bias": self.bias,
            "threshold": self.threshold,
            "window_config": self.window_config.to_payload(),
            "evidence_level": self.evidence_level,
        }

    @classmethod
    def load(cls, path: str | Path) -> FallMILModel:
        model_path = Path(path)
        try:
            payload = json.loads(model_path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise FallMILError(f"cannot read fall MIL model: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise FallMILError(f"fall MIL model is invalid JSON: {exc}") from exc
        if not isinstance(payload, dict):
            raise FallMILError("fall MIL model must be an object")
        if payload.get("schema_version") != FALL_MIL_MODEL_SCHEMA_VERSION:
            raise FallMILError("unsupported fall MIL model schema_version")
        feature_names = payload.get("feature_names")
        if not isinstance(feature_names, list) or not all(
            isinstance(name, str) for name in feature_names
        ):
            raise FallMILError("feature_names must be a string array")
        return cls(
            feature_names=tuple(feature_names),
            feature_mean=_array(payload.get("feature_mean"), "feature_mean", ndim=1),
            feature_scale=_array(payload.get("feature_scale"), "feature_scale", ndim=1),
            weights=_array(payload.get("weights"), "weights", ndim=1),
            bias=_number(payload.get("bias"), "bias"),
            threshold=_number(payload.get("threshold"), "threshold"),
            window_config=FallWindowConfig.from_payload(payload.get("window_config")),
            evidence_level=_text(payload.get("evidence_level"), "evidence_level"),
        )


def save_fall_mil_model(path: str | Path, model: FallMILModel) -> None:
    """Persist a reproducible fall MIL model."""

    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(model.to_payload(), ensure_ascii=False, indent=2, sort_keys=True)
        + "\n",
        encoding="utf-8",
    )


def build_fall_windows(
    bag: FallBag,
    *,
    config: FallWindowConfig | None = None,
) -> tuple[FallWindow, ...]:
    """Build quality-gated fixed-duration instances for one bag."""

    thresholds = config or FallWindowConfig()
    first_timestamp = bag.samples[0].timestamp_ms
    final_timestamp = bag.samples[-1].timestamp_ms
    windows: list[FallWindow] = []
    for duration_ms in thresholds.durations_ms:
        start_ms = first_timestamp
        while start_ms + duration_ms <= final_timestamp + 1e-6:
            end_ms = start_ms + duration_ms
            samples = tuple(
                sample
                for sample in bag.samples
                if start_ms - 1e-6 <= sample.timestamp_ms <= end_ms + 1e-6
            )
            if _window_is_usable(samples, config=thresholds):
                windows.append(
                    FallWindow(
                        bag_id=bag.bag_id,
                        split=bag.split,
                        label=bag.label,
                        category=bag.category,
                        start_ms=start_ms,
                        end_ms=end_ms,
                        features=_window_features(samples, config=thresholds),
                    )
                )
            start_ms += thresholds.stride_ms
    return tuple(windows)


def train_fall_mil(
    bags: Sequence[FallBag],
    *,
    seed_intervals: dict[str, tuple[float, float]],
    window_config: FallWindowConfig | None = None,
    training_config: FallMILTrainingConfig | None = None,
) -> tuple[FallMILModel, dict[str, object]]:
    """Train an alternating MIL model using train bags and val-only calibration."""

    windows_config = window_config or FallWindowConfig()
    optimization = training_config or FallMILTrainingConfig()
    ordered_bags = tuple(sorted(bags, key=lambda item: item.bag_id))
    if len({bag.bag_id for bag in ordered_bags}) != len(ordered_bags):
        raise FallMILError("bag_id values must be unique")

    windows_by_bag = {
        bag.bag_id: build_fall_windows(bag, config=windows_config)
        for bag in ordered_bags
    }
    unusable = [bag.bag_id for bag in ordered_bags if not windows_by_bag[bag.bag_id]]
    train_positive = [
        bag
        for bag in ordered_bags
        if bag.split == "train" and bag.label == "fall" and windows_by_bag[bag.bag_id]
    ]
    train_negative = [
        bag
        for bag in ordered_bags
        if bag.split == "train" and bag.label == "normal" and windows_by_bag[bag.bag_id]
    ]
    val_bags = [
        bag
        for bag in ordered_bags
        if bag.split == "val" and windows_by_bag[bag.bag_id]
    ]
    if not train_positive:
        raise FallMILError("at least one usable train fall bag is required")
    if not train_negative:
        raise FallMILError("at least one usable train normal bag is required")
    if {bag.label for bag in val_bags} != {"fall", "normal"}:
        raise FallMILError("validation bags must include fall and normal labels")

    seed_windows: list[FallWindow] = []
    for bag in train_positive:
        interval = seed_intervals.get(bag.bag_id)
        if interval is None:
            continue
        seed_windows.append(
            _window_for_interval(windows_by_bag[bag.bag_id], interval=interval)
        )
    if not seed_windows:
        raise FallMILError("at least one train seed interval is required")

    rng = np.random.default_rng(optimization.random_seed)
    initial_negatives = _initial_negative_windows(
        train_negative,
        windows_by_bag=windows_by_bag,
        window_config=windows_config,
        config=optimization,
        rng=rng,
    )
    initial_negatives.extend(
        _positive_background_windows(
            seed_windows,
            windows_by_bag=windows_by_bag,
            count=optimization.positive_background_negatives_per_bag,
        )
    )
    model = _fit_model(
        positive_windows=seed_windows,
        negative_windows=initial_negatives,
        config=optimization,
        window_config=windows_config,
    )

    round_reports: list[dict[str, object]] = []
    selected_positive: list[FallWindow] = list(seed_windows)
    selected_negative: list[FallWindow] = list(initial_negatives)
    selected_same_domain_negative_count = 0
    for round_index in range(1, optimization.rounds + 1):
        selected_positive = []
        uncertain_positive_bags: list[str] = []
        for bag in train_positive:
            all_windows = windows_by_bag[bag.bag_id]
            candidate_windows = _candidate_windows(
                all_windows,
                config=windows_config,
            )
            if not candidate_windows:
                uncertain_positive_bags.append(bag.bag_id)
                continue
            selected_positive.append(
                max(
                    candidate_windows,
                    key=lambda window: (
                        model.predict_probability(window.features),
                        _structural_fall_score(window),
                        -window.start_ms,
                    ),
                )
            )
        if not selected_positive:
            raise FallMILError("no train fall bags contain an eligible transition window")
        selected_negative = _hard_negative_windows(
            train_negative,
            windows_by_bag=windows_by_bag,
            model=model,
            window_config=windows_config,
            config=optimization,
            rng=rng,
        )
        same_domain_negatives = _positive_background_windows(
            selected_positive,
            windows_by_bag=windows_by_bag,
            count=optimization.positive_background_negatives_per_bag,
        )
        selected_same_domain_negative_count = len(same_domain_negatives)
        selected_negative.extend(same_domain_negatives)
        model = _fit_model(
            positive_windows=selected_positive,
            negative_windows=selected_negative,
            config=optimization,
            window_config=windows_config,
        )
        round_reports.append(
            {
                "round": round_index,
                "positive_windows": [
                    window.to_payload(
                        probability=model.predict_probability(window.features)
                    )
                    for window in selected_positive
                ],
                "negative_window_count": len(selected_negative),
                "same_domain_negative_count": len(same_domain_negatives),
                "uncertain_positive_bags": uncertain_positive_bags,
                "maximum_selected_negative_probability": round(
                    max(
                        model.predict_probability(window.features)
                        for window in selected_negative
                    ),
                    6,
                ),
            }
        )

    val_scores = [
        (
            bag,
            _score_bag_windows(
                windows_by_bag[bag.bag_id],
                model=model,
                config=windows_config,
            ),
        )
        for bag in val_bags
    ]
    threshold, calibration = _select_validation_threshold(val_scores)
    model = FallMILModel(
        feature_names=model.feature_names,
        feature_mean=model.feature_mean,
        feature_scale=model.feature_scale,
        weights=model.weights,
        bias=model.bias,
        threshold=threshold,
        window_config=model.window_config,
        evidence_level=model.evidence_level,
    )

    split_counts: dict[str, Counter[str]] = defaultdict(Counter)
    category_counts: Counter[str] = Counter()
    window_counts: Counter[str] = Counter()
    for bag in ordered_bags:
        split_counts[bag.split][bag.label] += 1
        category_counts[bag.category] += 1
        window_counts[bag.split] += len(windows_by_bag[bag.bag_id])

    bag_predictions = [
        _bag_prediction_payload(
            bag,
            windows_by_bag=windows_by_bag,
            model=model,
        )
        for bag in ordered_bags
        if windows_by_bag[bag.bag_id]
    ]
    report: dict[str, object] = {
        "schema_version": FALL_MIL_REPORT_SCHEMA_VERSION,
        "evidence_level": "weak_supervision_multiple_instance",
        "threshold_source": "validation_bags_only",
        "threshold": round(model.threshold, 6),
        "event_accuracy_report_allowed": False,
        "test_event_boundaries_reviewed": False,
        "window_config": windows_config.to_payload(),
        "training_config": optimization.to_payload(),
        "feature_schema_version": FALL_WINDOW_FEATURE_SCHEMA_VERSION,
        "feature_names": list(FALL_WINDOW_FEATURE_NAMES),
        "bag_counts": {
            split: dict(sorted(counts.items()))
            for split, counts in sorted(split_counts.items())
        },
        "category_counts": dict(sorted(category_counts.items())),
        "window_counts": dict(sorted(window_counts.items())),
        "unusable_bags": unusable,
        "seed_positive_windows": len(seed_windows),
        "selected_positive_bags": len(selected_positive),
        "selected_negative_windows": len(selected_negative),
        "same_domain_negative_windows": selected_same_domain_negative_count,
        "validation_calibration": calibration,
        "rounds": round_reports,
        "bag_predictions": bag_predictions,
        "claims": {
            "allowed": [
                "weak bag candidate coverage",
                "normal-action alert candidates",
                "validation-only threshold selection",
            ],
            "forbidden_until_manual_test_review": [
                "fall precision",
                "fall recall",
                "fall F1",
                "event boundary error",
                "medical or guaranteed fall detection",
            ],
        },
    }
    return model, report


def load_fall_positive_bags(
    manifest_path: str | Path,
    samples_path: str | Path,
) -> tuple[FallBag, ...]:
    """Load the 50 segmented positive bags from persisted pose samples."""

    manifest = _load_json_object(manifest_path, "fall manifest")
    raw_clips = manifest.get("clips")
    if not isinstance(raw_clips, list) or not raw_clips:
        raise FallMILError("fall manifest clips must be a non-empty array")
    clip_metadata: dict[str, tuple[str, float, float]] = {}
    for index, item in enumerate(raw_clips):
        if not isinstance(item, dict):
            raise FallMILError(f"fall manifest clips[{index}] must be an object")
        bag_id = _text(item.get("scene_id"), f"clips[{index}].scene_id")
        clip_metadata[bag_id] = (
            _enum(item.get("split"), BAG_SPLITS, f"clips[{index}].split"),
            _number(item.get("start_ms"), f"clips[{index}].start_ms"),
            _number(item.get("end_ms"), f"clips[{index}].end_ms"),
        )

    grouped: dict[str, list[FallPoseSample]] = defaultdict(list)
    for line_number, payload in _jsonl_objects(samples_path):
        bag_id = _text(payload.get("scene_id"), f"line {line_number}.scene_id")
        if bag_id not in clip_metadata:
            raise FallMILError(f"pose sample references unknown fall bag {bag_id!r}")
        grouped[bag_id].append(_fall_sample_from_payload(payload, prefix=f"line {line_number}"))

    bags = []
    for bag_id, (split, start_ms, end_ms) in clip_metadata.items():
        samples = tuple(grouped.get(bag_id, ()))
        if not samples:
            raise FallMILError(f"fall bag {bag_id!r} has no pose samples")
        if samples[0].timestamp_ms < start_ms - 250.0 or samples[-1].timestamp_ms > end_ms + 250.0:
            raise FallMILError(f"fall bag {bag_id!r} samples exceed manifest bounds")
        bags.append(
            FallBag(
                bag_id=bag_id,
                split=split,
                label="fall",
                category="fall_compilation",
                samples=samples,
            )
        )
    return tuple(bags)


def load_seed_intervals(path: str | Path) -> dict[str, tuple[float, float]]:
    """Load only accepted Round 0 transition intervals as positive seeds."""

    payload = _load_json_object(path, "weak candidates")
    raw_candidates = payload.get("candidates")
    if not isinstance(raw_candidates, list):
        raise FallMILError("weak candidates must contain a candidates array")
    intervals: dict[str, tuple[float, float]] = {}
    for index, item in enumerate(raw_candidates):
        if not isinstance(item, dict):
            raise FallMILError(f"candidates[{index}] must be an object")
        if item.get("status") != "accepted":
            continue
        bag_id = _text(item.get("clip_id"), f"candidates[{index}].clip_id")
        start_ms = _number(
            item.get("transition_start_ms"),
            f"candidates[{index}].transition_start_ms",
        )
        end_ms = _number(
            item.get("transition_end_ms"),
            f"candidates[{index}].transition_end_ms",
        )
        if end_ms <= start_ms:
            raise FallMILError("accepted seed transition end must exceed start")
        intervals[bag_id] = (start_ms, end_ms)
    if not intervals:
        raise FallMILError("weak candidates contain no accepted seeds")
    return intervals


def load_normal_negative_bags(
    index_path: str | Path,
    *,
    predictor: PosturePredictor,
    score_threshold: float = 0.2,
) -> tuple[FallBag, ...]:
    """Derive normal-action negative bags from existing keypoint JSONL scenes."""

    if not 0.0 <= score_threshold <= 1.0:
        raise FallMILError("score_threshold must be between 0 and 1")
    index = _load_json_object(index_path, "normal dataset index")
    raw_scenes = index.get("scenes")
    if not isinstance(raw_scenes, list) or not raw_scenes:
        raise FallMILError("normal dataset index scenes must be a non-empty array")
    bags: list[FallBag] = []
    for scene_index, scene in enumerate(raw_scenes):
        if not isinstance(scene, dict):
            raise FallMILError(f"scenes[{scene_index}] must be an object")
        scene_id = _text(scene.get("scene_id"), f"scenes[{scene_index}].scene_id")
        split = _enum(scene.get("split"), BAG_SPLITS, f"scenes[{scene_index}].split")
        label = _text(scene.get("label"), f"scenes[{scene_index}].label")
        keypoints_path = Path(
            _text(scene.get("keypoints"), f"scenes[{scene_index}].keypoints")
        )
        samples: list[FallPoseSample] = []
        previous: dict[str, object] | None = None
        for _line_number, record in _jsonl_objects(keypoints_path):
            prediction = predictor.predict_record(cast(dict[str, Any], record))
            sample = derive_fall_pose_sample(
                record,
                prediction=prediction,
                previous_record=previous,
                score_threshold=score_threshold,
            )
            samples.append(sample)
            previous = record
        if not samples:
            raise FallMILError(f"normal scene {scene_id!r} has no keypoint samples")
        bags.append(
            FallBag(
                bag_id=scene_id,
                split=split,
                label="normal",
                category=_negative_category(scene_id, label),
                samples=tuple(samples),
            )
        )
    return tuple(bags)


def train_fall_mil_from_artifacts(
    *,
    fall_manifest_path: str | Path,
    fall_samples_path: str | Path,
    weak_candidates_path: str | Path,
    normal_index_path: str | Path,
    posture_model_path: str | Path,
    output_dir: str | Path,
    window_config: FallWindowConfig | None = None,
    training_config: FallMILTrainingConfig | None = None,
) -> dict[str, object]:
    """Load persisted bags, train the MIL model, and write model plus report."""

    predictor = StaticPostureModel.load(posture_model_path)
    positive_bags = load_fall_positive_bags(fall_manifest_path, fall_samples_path)
    negative_bags = load_normal_negative_bags(
        normal_index_path,
        predictor=predictor,
    )
    seeds = load_seed_intervals(weak_candidates_path)
    model, report = train_fall_mil(
        (*positive_bags, *negative_bags),
        seed_intervals=seeds,
        window_config=window_config,
        training_config=training_config,
    )
    destination = Path(output_dir).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    model_path = destination / "model.json"
    report_path = destination / "training-report.json"
    save_fall_mil_model(model_path, model)
    enriched = dict(report)
    enriched.update(
        {
            "fall_manifest": str(Path(fall_manifest_path).resolve()),
            "fall_samples": str(Path(fall_samples_path).resolve()),
            "weak_candidates": str(Path(weak_candidates_path).resolve()),
            "normal_index": str(Path(normal_index_path).resolve()),
            "posture_model": str(Path(posture_model_path).resolve()),
            "model_path": str(model_path),
            "report_path": str(report_path),
            "raw_frames_persisted": False,
        }
    )
    report_path.write_text(
        json.dumps(enriched, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return enriched


def _window_is_usable(
    samples: Sequence[FallPoseSample],
    *,
    config: FallWindowConfig,
) -> bool:
    if len(samples) < config.min_samples:
        return False
    mean_visible = float(np.mean([sample.visible_keypoint_ratio for sample in samples]))
    unavailable_ratio = sum(
        sample.landmark_quality == "unavailable" for sample in samples
    ) / len(samples)
    return (
        mean_visible >= config.min_mean_visible_ratio
        and unavailable_ratio <= config.max_unavailable_ratio
    )


def _window_features(
    samples: Sequence[FallPoseSample],
    *,
    config: FallWindowConfig,
) -> tuple[float, ...]:
    timestamps = np.asarray([sample.timestamp_ms for sample in samples], dtype=np.float64)
    center = np.asarray([sample.center_y for sample in samples], dtype=np.float64)
    torso = np.asarray([sample.torso_angle_deg for sample in samples], dtype=np.float64)
    raw_aspect = np.asarray(
        [sample.bbox_aspect_ratio for sample in samples], dtype=np.float64
    )
    log_aspect = np.log1p(np.clip(raw_aspect, 0.0, config.max_aspect_ratio))
    motion = np.asarray([sample.motion_speed for sample in samples], dtype=np.float64)
    visible = np.asarray(
        [sample.visible_keypoint_ratio for sample in samples], dtype=np.float64
    )
    duration_s = max((timestamps[-1] - timestamps[0]) / 1000.0, 1e-6)
    edge_count = max(2, int(math.ceil(len(samples) * 0.25)))

    center_start = float(np.median(center[:edge_count]))
    center_end = float(np.median(center[-edge_count:]))
    center_drop = center_end - center_start
    torso_start = float(np.median(torso[:edge_count]))
    torso_end = float(np.median(torso[-edge_count:]))
    torso_change = torso_end - torso_start
    aspect_start = float(np.median(log_aspect[:edge_count]))
    aspect_end = float(np.median(log_aspect[-edge_count:]))
    aspect_change = aspect_end - aspect_start
    center_speeds = _positive_derivative(center, timestamps)
    torso_speeds = np.abs(_derivative(torso, timestamps))

    first_third = samples[: max(1, len(samples) // 3)]
    last_third = samples[-max(1, len(samples) // 3) :]
    start_stable = sum(
        sample.motion_speed <= config.stable_motion_speed for sample in first_third
    ) / len(first_third)
    end_stable = sum(
        sample.motion_speed <= config.stable_motion_speed for sample in last_third
    ) / len(last_third)

    standing_indices = [
        index
        for index, sample in enumerate(samples)
        if _standing_anchor(sample, config=config)
    ]
    fallen_indices = [
        index
        for index, sample in enumerate(samples)
        if _fallen_anchor(sample, config=config)
    ]
    ordered_pair = _ordered_anchor_pair(
        standing_indices,
        fallen_indices,
        timestamps=timestamps,
        duration_s=duration_s,
    )
    has_standing, has_fallen, ordered, anchor_gap_s = ordered_pair
    mean_motion = float(np.mean(motion))
    peak_motion = float(np.max(motion))

    values = (
        duration_s,
        center_start,
        center_end,
        center_drop,
        float(np.ptp(center)),
        center_drop / duration_s,
        float(np.max(center_speeds)) if center_speeds.size else 0.0,
        torso_start,
        torso_end,
        torso_change,
        float(np.ptp(torso)),
        torso_change / duration_s,
        float(np.max(torso_speeds)) if torso_speeds.size else 0.0,
        aspect_start,
        aspect_end,
        aspect_change,
        float(np.ptp(log_aspect)),
        aspect_change / duration_s,
        peak_motion,
        mean_motion,
        float(np.quantile(motion, 0.9)),
        peak_motion / max(mean_motion, 1e-6),
        float(np.mean(motion >= config.high_motion_speed)),
        start_stable,
        end_stable,
        float(np.mean(visible)),
        float(np.min(visible)),
        has_standing,
        has_fallen,
        ordered,
        anchor_gap_s,
    )
    return tuple(float(value) for value in values)


def _standing_anchor(sample: FallPoseSample, *, config: FallWindowConfig) -> bool:
    return (
        sample.landmark_quality != "unavailable"
        and sample.visible_keypoint_ratio >= config.min_mean_visible_ratio
        and sample.motion_speed <= config.stable_motion_speed
        and sample.torso_angle_deg <= config.standing_torso_angle_deg
        and sample.bbox_aspect_ratio <= config.standing_aspect_ratio
    )


def _fallen_anchor(sample: FallPoseSample, *, config: FallWindowConfig) -> bool:
    return (
        sample.landmark_quality != "unavailable"
        and sample.visible_keypoint_ratio >= config.min_mean_visible_ratio
        and sample.motion_speed <= config.stable_motion_speed
        and sample.torso_angle_deg >= config.fallen_torso_angle_deg
        and sample.bbox_aspect_ratio >= config.fallen_aspect_ratio
    )


def _ordered_anchor_pair(
    standing_indices: Sequence[int],
    fallen_indices: Sequence[int],
    *,
    timestamps: np.ndarray,
    duration_s: float,
) -> tuple[float, float, float, float]:
    has_standing = float(bool(standing_indices))
    has_fallen = float(bool(fallen_indices))
    pairs = [
        (standing, fallen)
        for standing in standing_indices
        for fallen in fallen_indices
        if fallen > standing
    ]
    if not pairs:
        return has_standing, has_fallen, 0.0, duration_s
    standing, fallen = min(pairs, key=lambda pair: pair[1] - pair[0])
    gap_s = max(float(timestamps[fallen] - timestamps[standing]) / 1000.0, 0.0)
    return has_standing, has_fallen, 1.0, gap_s


def _derivative(values: np.ndarray, timestamps_ms: np.ndarray) -> np.ndarray:
    if values.size < 2:
        return np.zeros(0, dtype=np.float64)
    elapsed = np.diff(timestamps_ms) / 1000.0
    valid = elapsed > 1e-9
    result = np.zeros_like(elapsed)
    result[valid] = np.diff(values)[valid] / elapsed[valid]
    return result


def _positive_derivative(values: np.ndarray, timestamps_ms: np.ndarray) -> np.ndarray:
    return cast(np.ndarray, np.maximum(_derivative(values, timestamps_ms), 0.0))


def _window_for_interval(
    windows: Sequence[FallWindow],
    *,
    interval: tuple[float, float],
) -> FallWindow:
    start_ms, end_ms = interval
    if end_ms <= start_ms:
        raise FallMILError("seed interval end must exceed start")
    return max(
        windows,
        key=lambda window: (
            _interval_iou(window.start_ms, window.end_ms, start_ms, end_ms),
            -abs((window.start_ms + window.end_ms) - (start_ms + end_ms)),
            -window.start_ms,
        ),
    )


def _interval_iou(
    first_start: float,
    first_end: float,
    second_start: float,
    second_end: float,
) -> float:
    intersection = max(0.0, min(first_end, second_end) - max(first_start, second_start))
    union = max(first_end, second_end) - min(first_start, second_start)
    return intersection / union if union > 0 else 0.0


def _feature_map(window: FallWindow) -> dict[str, float]:
    return dict(zip(FALL_WINDOW_FEATURE_NAMES, window.features, strict=True))


def _is_candidate_window(
    window: FallWindow,
    *,
    config: FallWindowConfig,
) -> bool:
    features = _feature_map(window)
    orientation_evidence = (
        abs(features["torso_change_deg"])
        >= config.min_candidate_abs_torso_change_deg
        or abs(features["log_aspect_change"])
        >= config.min_candidate_abs_log_aspect_change
        or features["ordered_anchor_pair"] >= 0.5
    )
    return (
        features["center_drop"] >= config.min_candidate_center_drop
        and features["max_downward_center_speed"]
        >= config.min_candidate_downward_speed
        and features["torso_range_deg"] >= config.min_candidate_torso_range_deg
        and features["peak_motion_speed"] >= config.min_candidate_peak_motion
        and features["high_motion_ratio"] >= config.min_candidate_high_motion_ratio
        and orientation_evidence
        and features["start_stable_ratio"] >= config.min_candidate_stable_ratio
        and features["end_stable_ratio"] >= config.min_candidate_stable_ratio
    )


def _candidate_windows(
    windows: Sequence[FallWindow],
    *,
    config: FallWindowConfig,
) -> tuple[FallWindow, ...]:
    return tuple(window for window in windows if _is_candidate_window(window, config=config))


def _structural_fall_score(window: FallWindow) -> float:
    features = _feature_map(window)
    return (
        max(features["center_drop_rate"], 0.0) * 3.0
        + max(features["torso_change_rate_deg_s"], 0.0) / 90.0
        + min(features["peak_motion_speed"], 2.0) * 0.4
        + features["ordered_anchor_pair"] * 0.5
    )


def _initial_negative_windows(
    bags: Sequence[FallBag],
    *,
    windows_by_bag: dict[str, tuple[FallWindow, ...]],
    window_config: FallWindowConfig,
    config: FallMILTrainingConfig,
    rng: np.random.Generator,
) -> list[FallWindow]:
    selected: list[FallWindow] = []
    for bag in bags:
        windows = windows_by_bag[bag.bag_id]
        candidates = _candidate_windows(windows, config=window_config)
        hard_pool = candidates or windows
        hardest = sorted(hard_pool, key=_structural_fall_score, reverse=True)[
            : config.hard_negatives_per_bag
        ]
        background = _sample_windows(
            windows,
            count=config.background_negatives_per_bag,
            rng=rng,
            excluded=set(hardest),
        )
        selected.extend(hardest)
        selected.extend(background)
    return selected


def _hard_negative_windows(
    bags: Sequence[FallBag],
    *,
    windows_by_bag: dict[str, tuple[FallWindow, ...]],
    model: FallMILModel,
    window_config: FallWindowConfig,
    config: FallMILTrainingConfig,
    rng: np.random.Generator,
) -> list[FallWindow]:
    selected: list[FallWindow] = []
    for bag in bags:
        windows = windows_by_bag[bag.bag_id]
        candidates = _candidate_windows(windows, config=window_config)
        hard_pool = candidates or windows
        hardest = sorted(
            hard_pool,
            key=lambda window: model.predict_probability(window.features),
            reverse=True,
        )[: config.hard_negatives_per_bag]
        background = _sample_windows(
            windows,
            count=config.background_negatives_per_bag,
            rng=rng,
            excluded=set(hardest),
        )
        selected.extend(hardest)
        selected.extend(background)
    return selected


def _positive_background_windows(
    selected_positive: Sequence[FallWindow],
    *,
    windows_by_bag: dict[str, tuple[FallWindow, ...]],
    count: int,
) -> list[FallWindow]:
    selected: list[FallWindow] = []
    for positive in selected_positive:
        windows = windows_by_bag[positive.bag_id]
        separated = [
            window
            for window in windows
            if window != positive
            and _interval_iou(
                window.start_ms,
                window.end_ms,
                positive.start_ms,
                positive.end_ms,
            )
            <= 0.25
        ]
        pool = separated or [window for window in windows if window != positive]
        selected.extend(sorted(pool, key=_structural_fall_score)[:count])
    return selected


def _score_bag_windows(
    windows: Sequence[FallWindow],
    *,
    model: FallMILModel,
    config: FallWindowConfig,
) -> float:
    candidates = _candidate_windows(windows, config=config)
    if not candidates:
        return 0.0
    return max(model.predict_probability(window.features) for window in candidates)


def _sample_windows(
    windows: Sequence[FallWindow],
    *,
    count: int,
    rng: np.random.Generator,
    excluded: set[FallWindow],
) -> list[FallWindow]:
    pool = [window for window in windows if window not in excluded]
    if len(pool) <= count:
        return pool
    indices = np.sort(rng.choice(len(pool), size=count, replace=False))
    return [pool[int(index)] for index in indices]


def _fit_model(
    *,
    positive_windows: Sequence[FallWindow],
    negative_windows: Sequence[FallWindow],
    config: FallMILTrainingConfig,
    window_config: FallWindowConfig,
) -> FallMILModel:
    if not positive_windows or not negative_windows:
        raise FallMILError("positive and negative windows are required")
    x = np.asarray(
        [window.features for window in (*positive_windows, *negative_windows)],
        dtype=np.float64,
    )
    y = np.asarray(
        [1.0] * len(positive_windows) + [0.0] * len(negative_windows),
        dtype=np.float64,
    )
    mean = x.mean(axis=0)
    scale = x.std(axis=0)
    scale = np.where(scale < 1e-6, 1.0, scale)
    standardized = (x - mean) / scale
    sample_weights = np.where(
        y == 1.0,
        len(y) / (2.0 * max(float((y == 1.0).sum()), 1.0)),
        len(y) / (2.0 * max(float((y == 0.0).sum()), 1.0)),
    )
    weights = np.zeros(standardized.shape[1], dtype=np.float64)
    bias = 0.0
    first_weights = np.zeros_like(weights)
    second_weights = np.zeros_like(weights)
    first_bias = 0.0
    second_bias = 0.0
    beta1 = 0.9
    beta2 = 0.999
    epsilon = 1e-8
    weight_total = float(sample_weights.sum())

    for step in range(1, config.epochs + 1):
        logits = standardized @ weights + bias
        probabilities = _sigmoid_array(logits)
        errors = sample_weights * (probabilities - y)
        gradient_weights = standardized.T @ errors / weight_total + config.l2 * weights
        gradient_bias = float(errors.sum() / weight_total)

        first_weights = beta1 * first_weights + (1.0 - beta1) * gradient_weights
        second_weights = beta2 * second_weights + (1.0 - beta2) * (
            gradient_weights * gradient_weights
        )
        corrected_first = first_weights / (1.0 - beta1**step)
        corrected_second = second_weights / (1.0 - beta2**step)
        weights -= config.learning_rate * corrected_first / (
            np.sqrt(corrected_second) + epsilon
        )

        first_bias = beta1 * first_bias + (1.0 - beta1) * gradient_bias
        second_bias = beta2 * second_bias + (1.0 - beta2) * gradient_bias**2
        corrected_first_bias = first_bias / (1.0 - beta1**step)
        corrected_second_bias = second_bias / (1.0 - beta2**step)
        bias -= config.learning_rate * corrected_first_bias / (
            math.sqrt(corrected_second_bias) + epsilon
        )

    return FallMILModel(
        feature_names=FALL_WINDOW_FEATURE_NAMES,
        feature_mean=mean,
        feature_scale=scale,
        weights=weights,
        bias=bias,
        threshold=0.5,
        window_config=window_config,
    )


def _select_validation_threshold(
    scored_bags: Sequence[tuple[FallBag, float]],
) -> tuple[float, dict[str, object]]:
    scores = sorted({float(score) for _, score in scored_bags})
    candidates = {0.0, 0.5, 1.0}
    candidates.update(scores)
    candidates.update(
        (first + second) * 0.5
        for first, second in zip(scores, scores[1:], strict=False)
    )
    evaluated: list[tuple[float, float, int, int]] = []
    for threshold in sorted(candidates):
        targets = np.asarray(
            [1 if bag.label == "fall" else 0 for bag, _ in scored_bags],
            dtype=np.int64,
        )
        predictions = np.asarray(
            [1 if score >= threshold else 0 for _, score in scored_bags],
            dtype=np.int64,
        )
        macro_f1 = _binary_macro_f1(targets, predictions)
        false_positives = int(((targets == 0) & (predictions == 1)).sum())
        true_positives = int(((targets == 1) & (predictions == 1)).sum())
        evaluated.append((macro_f1, threshold, false_positives, true_positives))
    objective, threshold, false_positives, true_positives = max(
        evaluated,
        key=lambda item: (item[0], -item[2], item[3], item[1]),
    )
    category_scores: dict[str, list[float]] = defaultdict(list)
    for bag, score in scored_bags:
        category_scores[bag.category].append(score)
    return threshold, {
        "objective_name": "weak_bag_macro_f1_internal_only",
        "objective": round(objective, 6),
        "fall_bags": sum(bag.label == "fall" for bag, _ in scored_bags),
        "normal_bags": sum(bag.label == "normal" for bag, _ in scored_bags),
        "fall_bags_above_threshold": true_positives,
        "normal_bags_above_threshold": false_positives,
        "category_max_scores": {
            category: round(max(values), 6)
            for category, values in sorted(category_scores.items())
        },
    }


def _bag_prediction_payload(
    bag: FallBag,
    *,
    windows_by_bag: dict[str, tuple[FallWindow, ...]],
    model: FallMILModel,
) -> dict[str, object]:
    windows = windows_by_bag[bag.bag_id]
    candidates = _candidate_windows(windows, config=model.window_config)
    if candidates:
        best = max(
            candidates,
            key=lambda window: model.predict_probability(window.features),
        )
        score = model.predict_probability(best.features)
    else:
        best = max(windows, key=_structural_fall_score)
        score = 0.0
    return {
        **best.to_payload(probability=score),
        "candidate_eligible": bool(candidates),
        "candidate": bool(candidates) and score >= model.threshold,
        "threshold": round(model.threshold, 6),
    }


def _binary_macro_f1(targets: np.ndarray, predictions: np.ndarray) -> float:
    scores: list[float] = []
    for label in (0, 1):
        actual = targets == label
        predicted = predictions == label
        true_positive = int((actual & predicted).sum())
        precision = true_positive / int(predicted.sum()) if predicted.any() else 0.0
        recall = true_positive / int(actual.sum()) if actual.any() else 0.0
        score = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        scores.append(score)
    return float(np.mean(scores))


def _negative_category(scene_id: str, label: str) -> str:
    if label == "lying":
        return "normal_lie_down"
    if label == "sitting":
        return "sit_or_stand"
    if label == "standing":
        return "stable_standing"
    if label == "bending_or_crouching":
        return "bend_or_crouch"
    if "pushup" in scene_id:
        return "horizontal_nonfall"
    if "jump" in scene_id:
        return "high_motion_nonfall"
    if "kneel" in scene_id:
        return "kneeling_nonfall"
    return "unusual_nonfall"


def _fall_sample_from_payload(
    payload: dict[str, object],
    *,
    prefix: str,
) -> FallPoseSample:
    quality = _text(payload.get("landmark_quality"), f"{prefix}.landmark_quality")
    return FallPoseSample(
        timestamp_ms=_number(payload.get("timestamp_ms"), f"{prefix}.timestamp_ms"),
        posture=_text(payload.get("posture"), f"{prefix}.posture"),
        posture_confidence=_number(
            payload.get("posture_confidence"), f"{prefix}.posture_confidence"
        ),
        center_y=_number(payload.get("center_y"), f"{prefix}.center_y"),
        torso_angle_deg=_number(
            payload.get("torso_angle_deg"), f"{prefix}.torso_angle_deg"
        ),
        bbox_aspect_ratio=_number(
            payload.get("bbox_aspect_ratio"), f"{prefix}.bbox_aspect_ratio"
        ),
        motion_speed=_number(
            payload.get("motion_speed"), f"{prefix}.motion_speed"
        ),
        visible_keypoint_ratio=_number(
            payload.get("visible_keypoint_ratio"),
            f"{prefix}.visible_keypoint_ratio",
        ),
        landmark_quality=quality,
    )


def _jsonl_objects(path: str | Path) -> Iterable[tuple[int, dict[str, object]]]:
    source = Path(path)
    try:
        with source.open("r", encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, start=1):
                if not line.strip():
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise FallMILError(
                        f"{source} line {line_number} is invalid JSON"
                    ) from exc
                if not isinstance(payload, dict):
                    raise FallMILError(f"{source} line {line_number} must be an object")
                yield line_number, payload
    except OSError as exc:
        raise FallMILError(f"cannot read JSONL {source}: {exc}") from exc


def _load_json_object(path: str | Path, description: str) -> dict[str, object]:
    source = Path(path)
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except OSError as exc:
        raise FallMILError(f"cannot read {description}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise FallMILError(f"{description} is invalid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise FallMILError(f"{description} must be an object")
    return payload


def _sigmoid_scalar(value: float) -> float:
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-value))
    exponent = math.exp(value)
    return exponent / (1.0 + exponent)


def _sigmoid_array(values: np.ndarray) -> np.ndarray:
    clipped = np.clip(values, -60.0, 60.0)
    return cast(np.ndarray, 1.0 / (1.0 + np.exp(-clipped)))


def _array(value: object, field_name: str, *, ndim: int) -> np.ndarray:
    try:
        array = np.asarray(value, dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise FallMILError(f"{field_name} must be numeric") from exc
    if array.ndim != ndim or not np.isfinite(array).all():
        raise FallMILError(f"{field_name} must be a finite {ndim}D array")
    return cast(np.ndarray, array)


def _text(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise FallMILError(f"{field_name} must be a non-empty string")
    return value.strip()


def _enum(value: object, allowed: tuple[str, ...], field_name: str) -> str:
    text = _text(value, field_name)
    if text not in allowed:
        raise FallMILError(f"{field_name} must be one of {allowed}")
    return text


def _number(value: object, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise FallMILError(f"{field_name} must be numeric")
    number = float(value)
    if not math.isfinite(number):
        raise FallMILError(f"{field_name} must be finite")
    return number


def _integer(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise FallMILError(f"{field_name} must be an integer")
    return value


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fall-manifest", type=Path, required=True)
    parser.add_argument("--fall-samples", type=Path, required=True)
    parser.add_argument("--weak-candidates", type=Path, required=True)
    parser.add_argument("--normal-index", type=Path, required=True)
    parser.add_argument("--posture-model", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--epochs", type=int, default=1800)
    parser.add_argument("--learning-rate", type=float, default=0.03)
    parser.add_argument("--l2", type=float, default=0.001)
    parser.add_argument("--hard-negatives-per-bag", type=int, default=5)
    parser.add_argument("--background-negatives-per-bag", type=int, default=5)
    parser.add_argument(
        "--positive-background-negatives-per-bag",
        type=int,
        default=4,
    )
    parser.add_argument("--random-seed", type=int, default=2026)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Train the weakly supervised multiple-instance fall model."""

    args = _build_parser().parse_args(argv)
    report = train_fall_mil_from_artifacts(
        fall_manifest_path=args.fall_manifest,
        fall_samples_path=args.fall_samples,
        weak_candidates_path=args.weak_candidates,
        normal_index_path=args.normal_index,
        posture_model_path=args.posture_model,
        output_dir=args.output_dir,
        training_config=FallMILTrainingConfig(
            rounds=args.rounds,
            epochs=args.epochs,
            learning_rate=args.learning_rate,
            l2=args.l2,
            hard_negatives_per_bag=args.hard_negatives_per_bag,
            background_negatives_per_bag=args.background_negatives_per_bag,
            positive_background_negatives_per_bag=(
                args.positive_background_negatives_per_bag
            ),
            random_seed=args.random_seed,
        ),
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
