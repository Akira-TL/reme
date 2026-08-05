"""Calibrate and evaluate an explainable geometric posture baseline."""

from __future__ import annotations

import argparse
import json
import math
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass, replace
from itertools import product
from pathlib import Path
from typing import Any, cast

from reme.runtime.perception.annotations import POSTURE_LABELS, PoseAnnotations

GEOMETRY_MODEL_SCHEMA_VERSION = "reme-posture-geometry/v1-experiment"
GEOMETRY_FEATURE_SCHEMA_VERSION = "reme-posture-geometry-features/v1-experiment"
GEOMETRY_METRICS_SCHEMA_VERSION = "reme-posture-geometry-metrics/v1-experiment"
DATASET_INDEX_SCHEMA_VERSION = "reme-pose-dataset-index/v0-experiment"
KNOWN_POSTURES = POSTURE_LABELS[:-1]
SHOULDERS = (5, 6)
HIPS = (11, 12)
KNEES = (13, 14)
ANKLES = (15, 16)
CORE_KEYPOINTS = SHOULDERS + HIPS + KNEES + ANKLES


class GeometryError(ValueError):
    """Raised when geometric features, rules, or datasets are invalid."""


@dataclass(frozen=True, slots=True)
class GeometryFeatures:
    """Small set of human-readable measurements derived from one MoveNet frame."""

    visible_keypoint_ratio: float
    core_visible_ratio: float
    bbox_width: float
    bbox_height: float
    bbox_aspect_ratio: float
    center_y: float
    torso_angle_from_vertical_deg: float | None
    shoulder_line_angle_from_horizontal_deg: float | None
    hip_line_angle_from_horizontal_deg: float | None
    hip_to_knee_vertical_ratio: float | None
    knee_to_ankle_vertical_ratio: float | None
    hip_to_ankle_vertical_ratio: float | None
    leg_vertical_order_ratio: float | None
    knee_angle_left_deg: float | None
    knee_angle_right_deg: float | None
    knee_angle_mean_deg: float | None

    def to_payload(self) -> dict[str, float | None]:
        """Return the stable public feature representation."""

        return cast(dict[str, float | None], asdict(self))


@dataclass(frozen=True, slots=True)
class GeometryThresholds:
    """Explicit rule thresholds selected using train/validation frames only."""

    score_threshold: float = 0.2
    min_visible_ratio: float = 0.6
    min_core_visible_ratio: float = 0.75
    upright_torso_max_deg: float = 20.0
    lying_torso_min_deg: float = 55.0
    lying_aspect_ratio_min: float = 1.15
    lying_pair_angle_min_deg: float = 45.0
    upright_aspect_ratio_max: float = 0.65
    standing_knee_angle_min_deg: float = 165.0
    standing_leg_span_min: float = 0.48
    sitting_knee_angle_max_deg: float = 150.0
    sitting_leg_span_max: float = 0.48
    sitting_hip_knee_span_max: float = 0.2
    bending_torso_min_deg: float = 20.0
    crouching_knee_angle_max_deg: float = 160.0
    low_center_y_min: float = 0.55
    crouching_leg_span_max: float = 0.6
    minimum_score: float = 0.55
    minimum_margin: float = 0.08

    @classmethod
    def from_payload(cls, value: object) -> GeometryThresholds:
        """Validate persisted thresholds without silently accepting new fields."""

        if not isinstance(value, dict):
            raise GeometryError("thresholds must be an object")
        expected = {field_name for field_name in cls.__dataclass_fields__}
        if set(value) != expected:
            raise GeometryError(f"threshold fields must be exactly {sorted(expected)}")
        numbers = {name: _finite_number(value[name], f"thresholds.{name}") for name in expected}
        thresholds = cls(**numbers)
        thresholds.validate()
        return thresholds

    def validate(self) -> None:
        """Validate ranges and ordering assumptions used by the rules."""

        for field_name in (
            "score_threshold",
            "min_visible_ratio",
            "min_core_visible_ratio",
            "upright_aspect_ratio_max",
            "standing_leg_span_min",
            "sitting_leg_span_max",
            "sitting_hip_knee_span_max",
            "low_center_y_min",
            "crouching_leg_span_max",
            "minimum_score",
            "minimum_margin",
        ):
            value = float(getattr(self, field_name))
            if not 0.0 <= value <= 1.0:
                raise GeometryError(f"{field_name} must be between 0 and 1")
        for field_name in (
            "upright_torso_max_deg",
            "lying_torso_min_deg",
            "lying_pair_angle_min_deg",
            "standing_knee_angle_min_deg",
            "sitting_knee_angle_max_deg",
            "bending_torso_min_deg",
            "crouching_knee_angle_max_deg",
        ):
            value = float(getattr(self, field_name))
            if not 0.0 <= value <= 180.0:
                raise GeometryError(f"{field_name} must be between 0 and 180")
        if self.lying_aspect_ratio_min <= 0:
            raise GeometryError("lying_aspect_ratio_min must be positive")
        if self.upright_torso_max_deg >= self.lying_torso_min_deg:
            raise GeometryError("upright torso threshold must be below lying torso threshold")
        if self.bending_torso_min_deg >= self.lying_torso_min_deg:
            raise GeometryError("bending torso threshold must be below lying torso threshold")

    def to_payload(self) -> dict[str, float]:
        """Return thresholds as a JSON-compatible mapping."""

        self.validate()
        return {name: float(value) for name, value in asdict(self).items()}


@dataclass(frozen=True, slots=True)
class GeometryPrediction:
    """One rule prediction with inspectable evidence and rejection reason."""

    posture: str
    confidence: float
    visible_keypoint_ratio: float
    evidence: dict[str, float]
    reason: str | None
    features: GeometryFeatures


@dataclass(frozen=True, slots=True)
class GeometricPostureModel:
    """Stateless geometric rules with explicit conflict and quality rejection."""

    thresholds: GeometryThresholds
    evidence_level: str
    calibration_splits: tuple[str, ...] = ("train", "val")

    def __post_init__(self) -> None:
        self.thresholds.validate()
        if not self.evidence_level.strip():
            raise GeometryError("evidence_level must be non-empty")
        if self.calibration_splits != ("train", "val"):
            raise GeometryError("geometry calibration_splits must be ('train', 'val')")

    @classmethod
    def load(cls, path: str | Path) -> GeometricPostureModel:
        """Load and validate a persisted geometric rule model."""

        payload = _read_json_object(path, "geometry model")
        if payload.get("schema_version") != GEOMETRY_MODEL_SCHEMA_VERSION:
            raise GeometryError(f"schema_version must be {GEOMETRY_MODEL_SCHEMA_VERSION!r}")
        if payload.get("feature_schema_version") != GEOMETRY_FEATURE_SCHEMA_VERSION:
            raise GeometryError(
                f"feature_schema_version must be {GEOMETRY_FEATURE_SCHEMA_VERSION!r}"
            )
        labels = payload.get("labels")
        if labels != list(POSTURE_LABELS):
            raise GeometryError(f"labels must match {POSTURE_LABELS}")
        raw_splits = payload.get("calibration_splits")
        if not isinstance(raw_splits, list) or not all(
            isinstance(item, str) for item in raw_splits
        ):
            raise GeometryError("calibration_splits must be a string array")
        return cls(
            thresholds=GeometryThresholds.from_payload(payload.get("thresholds")),
            evidence_level=_text(payload.get("evidence_level"), "evidence_level"),
            calibration_splits=tuple(raw_splits),
        )

    def to_payload(self) -> dict[str, object]:
        """Return the stable persisted rule artifact."""

        return {
            "schema_version": GEOMETRY_MODEL_SCHEMA_VERSION,
            "feature_schema_version": GEOMETRY_FEATURE_SCHEMA_VERSION,
            "labels": list(POSTURE_LABELS),
            "thresholds": self.thresholds.to_payload(),
            "evidence_level": self.evidence_level,
            "calibration_splits": list(self.calibration_splits),
        }

    def predict_record(self, record: dict[str, Any]) -> GeometryPrediction:
        """Classify one frame; no temporal state or previous label is consulted."""

        features = extract_geometry_features(
            record, score_threshold=self.thresholds.score_threshold
        )
        return self.predict_features(features, person_detected=bool(record.get("person_detected")))

    def predict_features(
        self,
        features: GeometryFeatures,
        *,
        person_detected: bool = True,
    ) -> GeometryPrediction:
        """Apply explainable rules to already extracted geometry."""

        evidence = _rule_evidence(features, self.thresholds)
        if (
            not person_detected
            or features.visible_keypoint_ratio < self.thresholds.min_visible_ratio
            or features.core_visible_ratio < self.thresholds.min_core_visible_ratio
            or not _required_geometry_available(features)
        ):
            return GeometryPrediction(
                posture="unknown",
                confidence=round(1.0 - min(features.core_visible_ratio, 1.0), 6),
                visible_keypoint_ratio=round(features.visible_keypoint_ratio, 6),
                evidence=evidence,
                reason="insufficient_landmarks",
                features=features,
            )

        ranked = sorted(evidence.items(), key=lambda item: (-item[1], item[0]))
        best_label, best_score = ranked[0]
        second_score = ranked[1][1]
        if best_score < self.thresholds.minimum_score:
            return _unknown_prediction(
                features,
                evidence,
                confidence=1.0 - best_score,
                reason="insufficient_evidence",
            )
        if best_score - second_score <= self.thresholds.minimum_margin:
            return _unknown_prediction(
                features,
                evidence,
                confidence=1.0 - (best_score - second_score),
                reason="conflicting_rules",
            )
        return GeometryPrediction(
            posture=best_label,
            confidence=round(best_score, 6),
            visible_keypoint_ratio=round(features.visible_keypoint_ratio, 6),
            evidence=evidence,
            reason=None,
            features=features,
        )


@dataclass(frozen=True, slots=True)
class _GeometrySample:
    scene_id: str
    timestamp_ms: float
    actual: str
    split: str
    record: dict[str, Any]
    features: GeometryFeatures


@dataclass(frozen=True, slots=True)
class _ScoredSample:
    scene_id: str
    timestamp_ms: float
    actual: str
    predicted: str
    reason: str | None


def extract_geometry_features(
    record: dict[str, Any], *, score_threshold: float = 0.2
) -> GeometryFeatures:
    """Extract translation/scale-stable and image-relative geometric measurements."""

    if not 0.0 <= score_threshold <= 1.0:
        raise GeometryError("score_threshold must be between 0 and 1")
    raw_keypoints = record.get("keypoints")
    if not isinstance(raw_keypoints, list) or len(raw_keypoints) != 17:
        raise GeometryError("FrameLandmarks record must contain 17 keypoints")
    coordinates: list[tuple[float, float]] = []
    scores: list[float] = []
    for index, item in enumerate(raw_keypoints):
        if not isinstance(item, dict):
            raise GeometryError(f"keypoints[{index}] must be an object")
        x = _unit_number(item.get("x_norm"), f"keypoints[{index}].x_norm")
        y = _unit_number(item.get("y_norm"), f"keypoints[{index}].y_norm")
        score = _unit_number(item.get("score"), f"keypoints[{index}].score")
        coordinates.append((x, y))
        scores.append(score)
    visible = [score >= score_threshold for score in scores]
    visible_indices = [index for index, is_visible in enumerate(visible) if is_visible]
    visible_ratio = len(visible_indices) / len(visible)
    core_visible_ratio = sum(visible[index] for index in CORE_KEYPOINTS) / len(CORE_KEYPOINTS)

    if visible_indices:
        visible_x = [coordinates[index][0] for index in visible_indices]
        visible_y = [coordinates[index][1] for index in visible_indices]
        bbox_width = max(visible_x) - min(visible_x)
        bbox_height = max(visible_y) - min(visible_y)
        center_y = (min(visible_y) + max(visible_y)) * 0.5
    else:
        bbox_width = bbox_height = center_y = 0.0
    bbox_aspect_ratio = bbox_width / max(bbox_height, 1e-6)

    shoulder_mid = _pair_midpoint(coordinates, visible, SHOULDERS)
    hip_mid = _pair_midpoint(coordinates, visible, HIPS)
    knee_mid = _pair_midpoint(coordinates, visible, KNEES)
    ankle_mid = _pair_midpoint(coordinates, visible, ANKLES)
    torso_angle = (
        _angle_from_vertical(shoulder_mid, hip_mid)
        if shoulder_mid is not None and hip_mid is not None
        else None
    )
    shoulder_line_angle = _pair_line_angle(coordinates, visible, SHOULDERS)
    hip_line_angle = _pair_line_angle(coordinates, visible, HIPS)
    hip_to_knee = _normalized_vertical_delta(hip_mid, knee_mid, bbox_height)
    knee_to_ankle = _normalized_vertical_delta(knee_mid, ankle_mid, bbox_height)
    hip_to_ankle = _normalized_vertical_delta(hip_mid, ankle_mid, bbox_height)
    left_knee_angle = _joint_angle(coordinates, visible, 11, 13, 15)
    right_knee_angle = _joint_angle(coordinates, visible, 12, 14, 16)
    known_knee_angles = [
        angle for angle in (left_knee_angle, right_knee_angle) if angle is not None
    ]
    knee_angle_mean = sum(known_knee_angles) / len(known_knee_angles) if known_knee_angles else None
    leg_order = _leg_vertical_order_ratio(coordinates, visible)
    return GeometryFeatures(
        visible_keypoint_ratio=round(visible_ratio, 6),
        core_visible_ratio=round(core_visible_ratio, 6),
        bbox_width=round(bbox_width, 6),
        bbox_height=round(bbox_height, 6),
        bbox_aspect_ratio=round(bbox_aspect_ratio, 6),
        center_y=round(center_y, 6),
        torso_angle_from_vertical_deg=_rounded_optional(torso_angle),
        shoulder_line_angle_from_horizontal_deg=_rounded_optional(shoulder_line_angle),
        hip_line_angle_from_horizontal_deg=_rounded_optional(hip_line_angle),
        hip_to_knee_vertical_ratio=_rounded_optional(hip_to_knee),
        knee_to_ankle_vertical_ratio=_rounded_optional(knee_to_ankle),
        hip_to_ankle_vertical_ratio=_rounded_optional(hip_to_ankle),
        leg_vertical_order_ratio=_rounded_optional(leg_order),
        knee_angle_left_deg=_rounded_optional(left_knee_angle),
        knee_angle_right_deg=_rounded_optional(right_knee_angle),
        knee_angle_mean_deg=_rounded_optional(knee_angle_mean),
    )


def calibrate_geometry_model(
    index_path: str | Path,
    *,
    max_samples_per_scene: int = 400,
) -> tuple[GeometricPostureModel, dict[str, object]]:
    """Select rule thresholds on train/validation samples, then evaluate test once."""

    samples, evidence_level = _load_geometry_samples(
        index_path, max_samples_per_scene=max_samples_per_scene
    )
    calibration_samples = [sample for sample in samples if sample.split in {"train", "val"}]
    if not any(sample.split == "train" for sample in calibration_samples):
        raise GeometryError("dataset must contain training samples")
    if not any(sample.split == "val" for sample in calibration_samples):
        raise GeometryError("dataset must contain validation samples")
    candidates = _candidate_thresholds(calibration_samples)
    best_thresholds: GeometryThresholds | None = None
    best_key: tuple[float, float, float, float] | None = None
    for thresholds in candidates:
        model = GeometricPostureModel(
            thresholds=thresholds,
            evidence_level=evidence_level,
            calibration_splits=("train", "val"),
        )
        train_metrics = _evaluate_samples(
            [sample for sample in calibration_samples if sample.split == "train"], model
        )
        val_metrics = _evaluate_samples(
            [sample for sample in calibration_samples if sample.split == "val"], model
        )
        train_macro = cast(float, train_metrics["macro_f1"])
        val_macro = cast(float, val_metrics["macro_f1"])
        val_known_rejection = cast(float, val_metrics["known_rejection_rate"])
        val_rejection = cast(float, val_metrics["rejection_rate"])
        key = (
            round(0.3 * train_macro + 0.7 * val_macro, 9),
            round(val_macro, 9),
            round(-val_known_rejection, 9),
            round(-val_rejection, 9),
        )
        if best_key is None or key > best_key:
            best_key = key
            best_thresholds = thresholds
    if best_thresholds is None:
        raise GeometryError("no geometric threshold candidate could be evaluated")
    model = GeometricPostureModel(
        thresholds=best_thresholds,
        evidence_level=evidence_level,
        calibration_splits=("train", "val"),
    )
    split_metrics = {
        split: _evaluate_samples([sample for sample in samples if sample.split == split], model)
        for split in ("train", "val", "test")
        if any(sample.split == split for sample in samples)
    }
    metrics: dict[str, object] = {
        "schema_version": GEOMETRY_METRICS_SCHEMA_VERSION,
        "model_schema_version": GEOMETRY_MODEL_SCHEMA_VERSION,
        "feature_schema_version": GEOMETRY_FEATURE_SCHEMA_VERSION,
        "dataset_index": str(Path(index_path).resolve()),
        "evidence_level": evidence_level,
        "calibration_splits": ["train", "val"],
        "test_used_for_calibration": False,
        "max_samples_per_scene": max_samples_per_scene,
        "sample_count": len(samples),
        "threshold_candidate_count": len(candidates),
        "thresholds": best_thresholds.to_payload(),
        "metrics": split_metrics,
    }
    return model, metrics


def evaluate_geometry_model(
    model: GeometricPostureModel,
    index_path: str | Path,
    *,
    max_samples_per_scene: int = 400,
) -> dict[str, object]:
    """Evaluate a frozen model without changing thresholds."""

    samples, evidence_level = _load_geometry_samples(
        index_path, max_samples_per_scene=max_samples_per_scene
    )
    return {
        "schema_version": GEOMETRY_METRICS_SCHEMA_VERSION,
        "model_schema_version": GEOMETRY_MODEL_SCHEMA_VERSION,
        "feature_schema_version": GEOMETRY_FEATURE_SCHEMA_VERSION,
        "dataset_index": str(Path(index_path).resolve()),
        "evidence_level": evidence_level,
        "calibration_splits": list(model.calibration_splits),
        "test_used_for_calibration": False,
        "max_samples_per_scene": max_samples_per_scene,
        "sample_count": len(samples),
        "thresholds": model.thresholds.to_payload(),
        "metrics": {
            split: _evaluate_samples([sample for sample in samples if sample.split == split], model)
            for split in ("train", "val", "test")
            if any(sample.split == split for sample in samples)
        },
    }


def save_geometry_model(path: str | Path, model: GeometricPostureModel) -> None:
    """Persist the calibrated rule model."""

    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(model.to_payload(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _rule_evidence(features: GeometryFeatures, thresholds: GeometryThresholds) -> dict[str, float]:
    torso = features.torso_angle_from_vertical_deg
    knee = features.knee_angle_mean_deg
    leg_span = features.hip_to_ankle_vertical_ratio
    hip_knee_span = features.hip_to_knee_vertical_ratio
    leg_order = features.leg_vertical_order_ratio
    pair_angles = [
        angle
        for angle in (
            features.shoulder_line_angle_from_horizontal_deg,
            features.hip_line_angle_from_horizontal_deg,
        )
        if angle is not None
    ]
    pair_angle = max(pair_angles) if pair_angles else None

    upright = _matches(torso, maximum=thresholds.upright_torso_max_deg)
    standing = upright * (
        0.25
        + 0.25 * _matches(knee, minimum=thresholds.standing_knee_angle_min_deg)
        + 0.2 * _matches(leg_order, minimum=0.75)
        + 0.15 * _matches(leg_span, minimum=thresholds.standing_leg_span_min)
        + 0.1 * float(features.bbox_aspect_ratio <= thresholds.upright_aspect_ratio_max)
        + 0.05 * float(features.center_y <= 0.7)
    )

    sitting = upright * (
        0.3
        + 0.25 * _matches(knee, maximum=thresholds.sitting_knee_angle_max_deg)
        + 0.2 * _matches(leg_span, maximum=thresholds.sitting_leg_span_max)
        + 0.15 * _matches(hip_knee_span, maximum=thresholds.sitting_hip_knee_span_max)
        + 0.1 * float(features.center_y <= 0.7)
    )

    lying = 0.0
    lying += 0.4 * _matches(torso, minimum=thresholds.lying_torso_min_deg)
    lying += 0.35 * float(features.bbox_aspect_ratio >= thresholds.lying_aspect_ratio_min)
    lying += 0.2 * _matches(pair_angle, minimum=thresholds.lying_pair_angle_min_deg)
    lying += 0.05 * _matches(leg_order, maximum=0.5)

    bending = 0.0
    bending += 0.4 * _matches(
        torso,
        minimum=thresholds.bending_torso_min_deg,
        maximum=thresholds.lying_torso_min_deg,
        upper_exclusive=True,
    )
    bending += 0.2 * _matches(knee, maximum=thresholds.crouching_knee_angle_max_deg)
    bending += 0.15 * float(features.center_y >= thresholds.low_center_y_min)
    bending += 0.2 * _matches(leg_span, maximum=thresholds.crouching_leg_span_max)
    bending += 0.05 * float(features.bbox_aspect_ratio < thresholds.lying_aspect_ratio_min)
    return {
        "standing": round(standing, 6),
        "sitting": round(sitting, 6),
        "lying": round(lying, 6),
        "bending_or_crouching": round(bending, 6),
    }


def _candidate_thresholds(samples: list[_GeometrySample]) -> list[GeometryThresholds]:
    by_label: dict[str, list[GeometryFeatures]] = {label: [] for label in POSTURE_LABELS}
    for sample in samples:
        by_label[sample.actual].append(sample.features)
    standing_knees = _known_values(feature.knee_angle_mean_deg for feature in by_label["standing"])
    sitting_knees = _known_values(feature.knee_angle_mean_deg for feature in by_label["sitting"])
    lying_torso = _known_values(
        feature.torso_angle_from_vertical_deg for feature in by_label["lying"]
    )
    lying_aspect = [feature.bbox_aspect_ratio for feature in by_label["lying"]]
    base = GeometryThresholds()
    upright_values = _unique_values((15.0, 20.0, 25.0))
    lying_torso_values = _unique_values(
        (45.0, 55.0, _quantile(lying_torso, 0.5, base.lying_torso_min_deg))
    )
    lying_aspect_values = _unique_values(
        (1.0, 1.2, _quantile(lying_aspect, 0.5, base.lying_aspect_ratio_min))
    )
    standing_knee_values = _unique_values(
        (165.0, _quantile(standing_knees, 0.25, base.standing_knee_angle_min_deg))
    )
    sitting_knee_values = _unique_values(
        (150.0, 165.0, _quantile(sitting_knees, 0.5, base.sitting_knee_angle_max_deg))
    )
    candidates = []
    for (
        upright_torso,
        lying_torso_min,
        lying_aspect_min,
        lying_pair_min,
        standing_knee_min,
        sitting_knee_max,
        minimum_score,
        minimum_margin,
    ) in product(
        upright_values,
        lying_torso_values,
        lying_aspect_values,
        (30.0, 45.0),
        standing_knee_values,
        sitting_knee_values,
        (0.5, 0.6),
        (0.05, 0.1),
    ):
        if upright_torso >= lying_torso_min:
            continue
        thresholds = replace(
            base,
            upright_torso_max_deg=upright_torso,
            lying_torso_min_deg=lying_torso_min,
            lying_aspect_ratio_min=lying_aspect_min,
            lying_pair_angle_min_deg=lying_pair_min,
            standing_knee_angle_min_deg=standing_knee_min,
            sitting_knee_angle_max_deg=sitting_knee_max,
            bending_torso_min_deg=min(20.0, upright_torso),
            minimum_score=minimum_score,
            minimum_margin=minimum_margin,
        )
        thresholds.validate()
        candidates.append(thresholds)
    unique = {json.dumps(item.to_payload(), sort_keys=True): item for item in candidates}
    return list(unique.values())


def _load_geometry_samples(
    index_path: str | Path, *, max_samples_per_scene: int
) -> tuple[list[_GeometrySample], str]:
    if max_samples_per_scene < 1:
        raise GeometryError("max_samples_per_scene must be positive")
    payload = _read_json_object(index_path, "dataset index")
    if payload.get("schema_version") != DATASET_INDEX_SCHEMA_VERSION:
        raise GeometryError("unsupported dataset index schema")
    evidence_level = _text(payload.get("evidence_level", "unspecified"), "evidence_level")
    raw_scenes = payload.get("scenes")
    if not isinstance(raw_scenes, list) or not raw_scenes:
        raise GeometryError("dataset index scenes must be a non-empty array")
    samples: list[_GeometrySample] = []
    for raw_scene in raw_scenes:
        if not isinstance(raw_scene, dict):
            raise GeometryError("dataset scene must be an object")
        scene_id = _text(raw_scene.get("scene_id"), "scene_id")
        keypoints_path = Path(_text(raw_scene.get("keypoints"), "keypoints"))
        annotations_path = Path(_text(raw_scene.get("annotations"), "annotations"))
        annotations = PoseAnnotations.load(annotations_path, expected_scene_id=scene_id)
        if len(annotations.posture_segments) != 1:
            raise GeometryError(
                "geometry baseline currently requires one posture segment per scene"
            )
        segment = annotations.posture_segments[0]
        records = _load_labelled_records(keypoints_path, segment.start_ms, segment.end_ms)
        for record in _uniform_sample(records, max_samples_per_scene):
            timestamp_ms = _finite_number(record.get("timestamp_ms"), "timestamp_ms")
            features = extract_geometry_features(record)
            samples.append(
                _GeometrySample(
                    scene_id=scene_id,
                    timestamp_ms=timestamp_ms,
                    actual=segment.posture,
                    split=segment.split,
                    record=record,
                    features=features,
                )
            )
    if not samples:
        raise GeometryError("dataset produced no labelled geometry samples")
    return samples, evidence_level


def _load_labelled_records(path: Path, start_ms: float, end_ms: float) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise GeometryError(f"cannot read keypoints: {exc}") from exc
    records: list[dict[str, Any]] = []
    for line_number, raw_line in enumerate(lines, start=1):
        if not raw_line.strip():
            continue
        try:
            value = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            raise GeometryError(f"invalid keypoint JSON at line {line_number}: {exc}") from exc
        if not isinstance(value, dict):
            raise GeometryError(f"keypoint line {line_number} must be an object")
        record = cast(dict[str, Any], value)
        timestamp_ms = _finite_number(record.get("timestamp_ms"), "timestamp_ms")
        if start_ms <= timestamp_ms < end_ms:
            records.append(record)
    return records


def _uniform_sample(records: list[dict[str, Any]], maximum: int) -> list[dict[str, Any]]:
    if len(records) <= maximum:
        return records
    if maximum == 1:
        return [records[0]]
    indices = [int(index * (len(records) - 1) / (maximum - 1)) for index in range(maximum)]
    return [records[index] for index in indices]


def _evaluate_samples(
    samples: list[_GeometrySample], model: GeometricPostureModel
) -> dict[str, object]:
    confusion = [[0 for _ in POSTURE_LABELS] for _ in POSTURE_LABELS]
    label_to_index = {label: index for index, label in enumerate(POSTURE_LABELS)}
    scored: list[_ScoredSample] = []
    unknown_count = 0
    known_rejection_count = 0
    correct_count = 0
    rejection_reason_counts: dict[str, int] = {}
    for sample in samples:
        prediction = model.predict_features(
            sample.features,
            person_detected=bool(sample.record.get("person_detected")),
        )
        actual_index = label_to_index[sample.actual]
        predicted_index = label_to_index[prediction.posture]
        confusion[actual_index][predicted_index] += 1
        correct_count += int(sample.actual == prediction.posture)
        unknown_count += int(prediction.posture == "unknown")
        if prediction.posture == "unknown":
            reason = prediction.reason or "unspecified"
            rejection_reason_counts[reason] = rejection_reason_counts.get(reason, 0) + 1
        known_rejection_count += int(sample.actual != "unknown" and prediction.posture == "unknown")
        scored.append(
            _ScoredSample(
                scene_id=sample.scene_id,
                timestamp_ms=sample.timestamp_ms,
                actual=sample.actual,
                predicted=prediction.posture,
                reason=prediction.reason,
            )
        )
    per_class: dict[str, object] = {}
    f1_values: list[float] = []
    for index, label in enumerate(POSTURE_LABELS):
        true_positive = confusion[index][index]
        predicted_count = sum(row[index] for row in confusion)
        actual_count = sum(confusion[index])
        precision = true_positive / predicted_count if predicted_count else 0.0
        recall = true_positive / actual_count if actual_count else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        if actual_count:
            f1_values.append(f1)
        per_class[label] = {
            "precision": round(precision, 6),
            "recall": round(recall, 6),
            "f1": round(f1, 6),
            "support": actual_count,
        }
    known_count = sum(sample.actual != "unknown" for sample in samples)
    sample_count = len(samples)
    return {
        "sample_count": sample_count,
        "accuracy": round(correct_count / sample_count, 6) if sample_count else 0.0,
        "macro_f1": round(sum(f1_values) / len(f1_values), 6) if f1_values else 0.0,
        "rejection_rate": round(unknown_count / sample_count, 6) if sample_count else 0.0,
        "known_rejection_rate": round(known_rejection_count / known_count, 6)
        if known_count
        else 0.0,
        "rejection_reason_counts": dict(sorted(rejection_reason_counts.items())),
        "label_jitter_count": _label_jitter_count(scored),
        "confusion_matrix_labels": list(POSTURE_LABELS),
        "confusion_matrix": confusion,
        "per_class": per_class,
        "error_ranges": _error_ranges(scored),
    }


def _error_ranges(scored: list[_ScoredSample]) -> list[dict[str, object]]:
    errors = sorted(
        (item for item in scored if item.actual != item.predicted),
        key=lambda item: (item.scene_id, item.timestamp_ms),
    )
    ranges: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    previous_timestamp = -math.inf
    for error in errors:
        same_group = bool(
            current is not None
            and current["scene_id"] == error.scene_id
            and current["actual"] == error.actual
            and current["predicted"] == error.predicted
            and current["reason"] == error.reason
            and error.timestamp_ms - previous_timestamp <= 250.0
        )
        if not same_group:
            if current is not None:
                ranges.append(current)
            current = {
                "scene_id": error.scene_id,
                "start_ms": round(error.timestamp_ms, 3),
                "end_ms": round(error.timestamp_ms, 3),
                "actual": error.actual,
                "predicted": error.predicted,
                "reason": error.reason,
                "frame_count": 1,
            }
        else:
            assert current is not None
            current["end_ms"] = round(error.timestamp_ms, 3)
            current["frame_count"] = cast(int, current["frame_count"]) + 1
        previous_timestamp = error.timestamp_ms
    if current is not None:
        ranges.append(current)
    return sorted(
        ranges,
        key=lambda item: (-cast(int, item["frame_count"]), cast(str, item["scene_id"])),
    )


def _label_jitter_count(scored: list[_ScoredSample]) -> int:
    jitter = 0
    previous_by_scene: dict[str, str] = {}
    for item in sorted(scored, key=lambda value: (value.scene_id, value.timestamp_ms)):
        previous = previous_by_scene.get(item.scene_id)
        if previous is not None and previous != item.predicted:
            jitter += 1
        previous_by_scene[item.scene_id] = item.predicted
    return jitter


def _required_geometry_available(features: GeometryFeatures) -> bool:
    return all(
        value is not None
        for value in (
            features.torso_angle_from_vertical_deg,
            features.hip_to_knee_vertical_ratio,
            features.hip_to_ankle_vertical_ratio,
            features.leg_vertical_order_ratio,
            features.knee_angle_mean_deg,
        )
    )


def _unknown_prediction(
    features: GeometryFeatures,
    evidence: dict[str, float],
    *,
    confidence: float,
    reason: str,
) -> GeometryPrediction:
    return GeometryPrediction(
        posture="unknown",
        confidence=round(max(0.0, min(confidence, 1.0)), 6),
        visible_keypoint_ratio=round(features.visible_keypoint_ratio, 6),
        evidence=evidence,
        reason=reason,
        features=features,
    )


def _matches(
    value: float | None,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
    upper_exclusive: bool = False,
) -> float:
    if value is None:
        return 0.0
    if minimum is not None and value < minimum:
        return 0.0
    if maximum is not None:
        if upper_exclusive and value >= maximum:
            return 0.0
        if not upper_exclusive and value > maximum:
            return 0.0
    return 1.0


def _pair_midpoint(
    coordinates: list[tuple[float, float]],
    visible: list[bool],
    indices: tuple[int, int],
) -> tuple[float, float] | None:
    first, second = indices
    if not visible[first] or not visible[second]:
        return None
    return (
        (coordinates[first][0] + coordinates[second][0]) * 0.5,
        (coordinates[first][1] + coordinates[second][1]) * 0.5,
    )


def _pair_line_angle(
    coordinates: list[tuple[float, float]],
    visible: list[bool],
    indices: tuple[int, int],
) -> float | None:
    first, second = indices
    if not visible[first] or not visible[second]:
        return None
    dx = abs(coordinates[first][0] - coordinates[second][0])
    dy = abs(coordinates[first][1] - coordinates[second][1])
    if dx < 1e-8 and dy < 1e-8:
        return None
    return math.degrees(math.atan2(dy, dx))


def _angle_from_vertical(first: tuple[float, float], second: tuple[float, float]) -> float | None:
    dx = abs(first[0] - second[0])
    dy = abs(first[1] - second[1])
    if dx < 1e-8 and dy < 1e-8:
        return None
    return math.degrees(math.atan2(dx, dy))


def _normalized_vertical_delta(
    first: tuple[float, float] | None,
    second: tuple[float, float] | None,
    bbox_height: float,
) -> float | None:
    if first is None or second is None or bbox_height < 1e-8:
        return None
    return (second[1] - first[1]) / bbox_height


def _joint_angle(
    coordinates: list[tuple[float, float]],
    visible: list[bool],
    first: int,
    center: int,
    last: int,
) -> float | None:
    if not all(visible[index] for index in (first, center, last)):
        return None
    vector_a = (
        coordinates[first][0] - coordinates[center][0],
        coordinates[first][1] - coordinates[center][1],
    )
    vector_b = (
        coordinates[last][0] - coordinates[center][0],
        coordinates[last][1] - coordinates[center][1],
    )
    denominator = math.hypot(*vector_a) * math.hypot(*vector_b)
    if denominator < 1e-8:
        return None
    cosine = (vector_a[0] * vector_b[0] + vector_a[1] * vector_b[1]) / denominator
    return math.degrees(math.acos(max(-1.0, min(1.0, cosine))))


def _leg_vertical_order_ratio(
    coordinates: list[tuple[float, float]], visible: list[bool]
) -> float | None:
    ordered = 0
    observed = 0
    for hip, knee, ankle in ((11, 13, 15), (12, 14, 16)):
        if all(visible[index] for index in (hip, knee, ankle)):
            observed += 1
            ordered += int(coordinates[hip][1] < coordinates[knee][1] < coordinates[ankle][1])
    return ordered / observed if observed else None


def _known_values(values: Iterable[float | None]) -> list[float]:
    return [value for value in values if value is not None]


def _quantile(values: list[float], fraction: float, fallback: float) -> float:
    if not values:
        return fallback
    ordered = sorted(values)
    position = fraction * (len(ordered) - 1)
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def _unique_values(values: Iterable[float]) -> tuple[float, ...]:
    return tuple(sorted({round(float(value), 3) for value in values}))


def _rounded_optional(value: float | None) -> float | None:
    return round(value, 6) if value is not None else None


def _read_json_object(path: str | Path, description: str) -> dict[str, Any]:
    source = Path(path)
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
    except OSError as exc:
        raise GeometryError(f"cannot read {description}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise GeometryError(f"{description} is not valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise GeometryError(f"{description} must be an object")
    return cast(dict[str, Any], value)


def _text(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GeometryError(f"{field_name} must be a non-empty string")
    return value.strip()


def _finite_number(value: object, field_name: str) -> float:
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise GeometryError(f"{field_name} must be numeric")
    number = float(value)
    if not math.isfinite(number):
        raise GeometryError(f"{field_name} must be finite")
    return number


def _unit_number(value: object, field_name: str) -> float:
    number = _finite_number(value, field_name)
    if not 0.0 <= number <= 1.0:
        raise GeometryError(f"{field_name} must be between 0 and 1")
    return number


def _write_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    calibrate = subparsers.add_parser(
        "calibrate", help="calibrate rules on train/val and evaluate all splits"
    )
    calibrate.add_argument("index", type=Path)
    calibrate.add_argument("--model-output", type=Path, required=True)
    calibrate.add_argument("--metrics-output", type=Path, required=True)
    calibrate.add_argument("--max-samples-per-scene", type=int, default=400)
    evaluate = subparsers.add_parser("evaluate", help="evaluate a frozen rule model")
    evaluate.add_argument("model", type=Path)
    evaluate.add_argument("index", type=Path)
    evaluate.add_argument("--metrics-output", type=Path, required=True)
    evaluate.add_argument("--max-samples-per-scene", type=int, default=400)
    predict = subparsers.add_parser("predict", help="predict one FrameLandmarks JSON")
    predict.add_argument("model", type=Path)
    predict.add_argument("record", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run geometry calibration, evaluation, or single-record prediction."""

    args = _build_parser().parse_args(argv)
    try:
        if args.command == "calibrate":
            model, metrics = calibrate_geometry_model(
                args.index, max_samples_per_scene=args.max_samples_per_scene
            )
            save_geometry_model(args.model_output, model)
            _write_json(args.metrics_output, metrics)
            print(json.dumps(metrics, ensure_ascii=False, indent=2))
        elif args.command == "evaluate":
            model = GeometricPostureModel.load(args.model)
            metrics = evaluate_geometry_model(
                model,
                args.index,
                max_samples_per_scene=args.max_samples_per_scene,
            )
            _write_json(args.metrics_output, metrics)
            print(json.dumps(metrics, ensure_ascii=False, indent=2))
        else:
            model = GeometricPostureModel.load(args.model)
            record = _read_json_object(args.record, "FrameLandmarks record")
            prediction = model.predict_record(record)
            print(
                json.dumps(
                    {
                        "posture": prediction.posture,
                        "confidence": prediction.confidence,
                        "visible_keypoint_ratio": prediction.visible_keypoint_ratio,
                        "reason": prediction.reason,
                        "evidence": prediction.evidence,
                        "features": prediction.features.to_payload(),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        return 0
    except (GeometryError, OSError, json.JSONDecodeError) as exc:
        print(f"error: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
