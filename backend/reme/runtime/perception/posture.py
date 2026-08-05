"""Train and run a lightweight static-posture classifier on MoveNet landmarks."""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import numpy as np

from reme.pose.annotations import POSTURE_LABELS, PoseAnnotations

MODEL_SCHEMA_VERSION = "reme-posture-softmax/v1-experiment"
DATASET_INDEX_SCHEMA_VERSION = "reme-pose-dataset-index/v0-experiment"
FEATURE_SCHEMA_VERSION = "reme-posture-features/v0-experiment"
MODEL_LABELS = POSTURE_LABELS[:-1]
SHOULDERS = (5, 6)
HIPS = (11, 12)
KNEES = (13, 14)
ANKLES = (15, 16)


class PostureModelError(ValueError):
    """Raised when posture features, datasets, or model artifacts are invalid."""


@dataclass(frozen=True, slots=True)
class PosturePrediction:
    """One static-posture prediction before duration smoothing."""

    posture: str
    confidence: float
    probabilities: dict[str, float]
    visible_keypoint_ratio: float
    classification_source: str = "unspecified"


@dataclass(frozen=True, slots=True)
class StaticPostureModel:
    """Standardized linear softmax posture model with confidence rejection."""

    labels: tuple[str, ...]
    feature_mean: np.ndarray
    feature_scale: np.ndarray
    weights: np.ndarray
    bias: np.ndarray
    class_centroids: np.ndarray
    confidence_threshold: float
    distance_threshold: float
    score_threshold: float
    min_visible_ratio: float
    evidence_level: str

    @classmethod
    def load(cls, path: str | Path) -> StaticPostureModel:
        model_path = Path(path)
        try:
            payload = json.loads(model_path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise PostureModelError(f"cannot read posture model: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise PostureModelError(f"posture model is not valid JSON: {exc}") from exc
        if not isinstance(payload, dict):
            raise PostureModelError("posture model must be an object")
        if payload.get("schema_version") != MODEL_SCHEMA_VERSION:
            raise PostureModelError(
                f"schema_version must be {MODEL_SCHEMA_VERSION!r}"
            )
        labels_raw = payload.get("labels")
        if not isinstance(labels_raw, list) or not all(
            isinstance(label, str) for label in labels_raw
        ):
            raise PostureModelError("labels must be a string array")
        labels = tuple(labels_raw)
        if labels != MODEL_LABELS:
            raise PostureModelError(f"labels must match known posture order {MODEL_LABELS}")
        mean = _array(payload.get("feature_mean"), "feature_mean", ndim=1)
        scale = _array(payload.get("feature_scale"), "feature_scale", ndim=1)
        weights = _array(payload.get("weights"), "weights", ndim=2)
        bias = _array(payload.get("bias"), "bias", ndim=1)
        centroids = _array(payload.get("class_centroids"), "class_centroids", ndim=2)
        if mean.shape != scale.shape:
            raise PostureModelError("feature_mean and feature_scale shapes must match")
        if weights.shape != (mean.size, len(labels)):
            raise PostureModelError("weights shape does not match features and labels")
        if bias.shape != (len(labels),):
            raise PostureModelError("bias shape does not match labels")
        if centroids.shape != (len(labels), mean.size):
            raise PostureModelError("class_centroids shape does not match labels and features")
        if np.any(scale <= 0):
            raise PostureModelError("feature_scale values must be positive")
        return cls(
            labels=labels,
            feature_mean=mean,
            feature_scale=scale,
            weights=weights,
            bias=bias,
            class_centroids=centroids,
            confidence_threshold=_unit_number(
                payload.get("confidence_threshold"), "confidence_threshold"
            ),
            distance_threshold=_positive_number(
                payload.get("distance_threshold"), "distance_threshold"
            ),
            score_threshold=_unit_number(
                payload.get("score_threshold"), "score_threshold"
            ),
            min_visible_ratio=_unit_number(
                payload.get("min_visible_ratio"), "min_visible_ratio"
            ),
            evidence_level=_text(payload.get("evidence_level"), "evidence_level"),
        )

    def predict_record(self, record: dict[str, Any]) -> PosturePrediction:
        """Predict one FrameLandmarks record, rejecting weak evidence as unknown."""

        feature, visible_ratio = extract_posture_features(
            record, score_threshold=self.score_threshold
        )
        classification_source = "softmax"
        if not bool(record.get("person_detected")) or visible_ratio < self.min_visible_ratio:
            output_probabilities = np.zeros(len(POSTURE_LABELS), dtype=np.float64)
            output_probabilities[-1] = 1.0
            posture = "unknown"
            confidence = 1.0
            classification_source = "visibility_reject"
        else:
            standardized = (feature - self.feature_mean) / self.feature_scale
            known_probabilities = _softmax(standardized @ self.weights + self.bias)
            best_index = int(np.argmax(known_probabilities))
            best_confidence = float(known_probabilities[best_index])
            nearest_distance = _nearest_centroid_distance(
                standardized, self.class_centroids
            )
            rejected = (
                best_confidence < self.confidence_threshold
                or nearest_distance > self.distance_threshold
            )
            output_probabilities = _output_probabilities(
                known_probabilities,
                rejected=rejected,
                nearest_distance=nearest_distance,
                distance_threshold=self.distance_threshold,
            )
            if rejected:
                posture = "unknown"
                confidence = float(output_probabilities[-1])
                classification_source = "softmax_reject"
            else:
                posture = self.labels[best_index]
                confidence = best_confidence
        return PosturePrediction(
            posture=posture,
            confidence=round(confidence, 6),
            probabilities={
                label: round(float(output_probabilities[index]), 6)
                for index, label in enumerate(POSTURE_LABELS)
            },
            visible_keypoint_ratio=round(visible_ratio, 6),
            classification_source=classification_source,
        )

    def to_payload(self) -> dict[str, object]:
        return {
            "schema_version": MODEL_SCHEMA_VERSION,
            "feature_schema_version": FEATURE_SCHEMA_VERSION,
            "labels": list(self.labels),
            "feature_mean": self.feature_mean.tolist(),
            "feature_scale": self.feature_scale.tolist(),
            "weights": self.weights.tolist(),
            "bias": self.bias.tolist(),
            "class_centroids": self.class_centroids.tolist(),
            "confidence_threshold": self.confidence_threshold,
            "distance_threshold": self.distance_threshold,
            "score_threshold": self.score_threshold,
            "min_visible_ratio": self.min_visible_ratio,
            "evidence_level": self.evidence_level,
        }


def extract_posture_features(
    record: dict[str, Any], *, score_threshold: float = 0.2
) -> tuple[np.ndarray, float]:
    """Return root-centered landmark and geometric features for one frame."""

    if not 0.0 <= score_threshold <= 1.0:
        raise PostureModelError("score_threshold must be between 0 and 1")
    keypoints = record.get("keypoints")
    if not isinstance(keypoints, list) or len(keypoints) != 17:
        raise PostureModelError("FrameLandmarks record must contain 17 keypoints")
    try:
        coords = np.asarray(
            [[float(item["x_norm"]), float(item["y_norm"])] for item in keypoints],
            dtype=np.float64,
        )
        scores = np.asarray([float(item["score"]) for item in keypoints], dtype=np.float64)
    except (KeyError, TypeError, ValueError) as exc:
        raise PostureModelError("invalid keypoint coordinate or score") from exc
    if not np.all(np.isfinite(coords)) or not np.all(np.isfinite(scores)):
        raise PostureModelError("keypoint values must be finite")
    if np.any(coords < 0) or np.any(coords > 1) or np.any(scores < 0) or np.any(scores > 1):
        raise PostureModelError("keypoint coordinates and scores must be between 0 and 1")

    visible = scores >= score_threshold
    visible_ratio = float(visible.mean())
    shoulder_mid = _pair_midpoint(coords, visible, SHOULDERS)
    hip_mid = _pair_midpoint(coords, visible, HIPS)
    root = hip_mid if hip_mid is not None else shoulder_mid
    if root is None:
        root = coords[visible].mean(axis=0) if visible.any() else np.zeros(2)
    if shoulder_mid is not None and hip_mid is not None:
        scale = float(np.linalg.norm(shoulder_mid - hip_mid))
    elif visible.sum() >= 2:
        scale = float(np.linalg.norm(np.ptp(coords[visible], axis=0)))
    else:
        scale = 1.0
    scale = max(scale, 1e-4)

    normalized = np.clip((coords - root) / scale, -5.0, 5.0)
    normalized[~visible] = 0.0
    landmark_features = np.concatenate([normalized.reshape(-1), scores], axis=0)

    visible_coords = coords[visible]
    if visible_coords.size:
        minimum = visible_coords.min(axis=0)
        maximum = visible_coords.max(axis=0)
        bbox_width, bbox_height = maximum - minimum
        center_y = float((minimum[1] + maximum[1]) * 0.5)
    else:
        bbox_width = bbox_height = center_y = 0.0
    aspect_ratio = float(bbox_width / max(bbox_height, 1e-4))

    torso_vector = (
        shoulder_mid - hip_mid
        if shoulder_mid is not None and hip_mid is not None
        else np.zeros(2)
    )
    torso_horizontal_ratio = float(
        abs(torso_vector[0]) / max(abs(torso_vector[1]), 1e-4)
    )
    knee_mid = _pair_midpoint(coords, visible, KNEES)
    ankle_mid = _pair_midpoint(coords, visible, ANKLES)
    hip_y = float(hip_mid[1]) if hip_mid is not None else -1.0
    shoulder_y = float(shoulder_mid[1]) if shoulder_mid is not None else -1.0
    knee_y = float(knee_mid[1]) if knee_mid is not None else -1.0
    ankle_y = float(ankle_mid[1]) if ankle_mid is not None else -1.0
    leg_vertical_span = ankle_y - hip_y if ankle_y >= 0 and hip_y >= 0 else 0.0
    left_knee_angle = _joint_angle(coords, visible, 11, 13, 15)
    right_knee_angle = _joint_angle(coords, visible, 12, 14, 16)
    shoulder_width = _pair_distance(coords, visible, SHOULDERS) / scale
    hip_width = _pair_distance(coords, visible, HIPS) / scale

    geometry = np.asarray(
        [
            bbox_width,
            bbox_height,
            aspect_ratio,
            center_y,
            float(torso_vector[0]),
            float(torso_vector[1]),
            torso_horizontal_ratio,
            shoulder_y,
            hip_y,
            knee_y,
            ankle_y,
            leg_vertical_span,
            visible_ratio,
            left_knee_angle,
            right_knee_angle,
            shoulder_width,
            hip_width,
        ],
        dtype=np.float64,
    )
    return np.concatenate([landmark_features, geometry]), visible_ratio


def load_dataset_samples(
    index_path: str | Path,
    *,
    score_threshold: float = 0.2,
    max_samples_per_scene: int = 400,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str]]:
    """Load frame features, labels, splits, and scene IDs from a dataset index."""

    if max_samples_per_scene < 1:
        raise PostureModelError("max_samples_per_scene must be positive")
    index_file = Path(index_path)
    try:
        payload = json.loads(index_file.read_text(encoding="utf-8"))
    except OSError as exc:
        raise PostureModelError(f"cannot read dataset index: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise PostureModelError(f"dataset index is not valid JSON: {exc}") from exc
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version") != DATASET_INDEX_SCHEMA_VERSION
    ):
        raise PostureModelError("unsupported dataset index schema")
    raw_scenes = payload.get("scenes")
    if not isinstance(raw_scenes, list) or not raw_scenes:
        raise PostureModelError("dataset index scenes must be a non-empty array")

    features: list[np.ndarray] = []
    labels: list[int] = []
    splits: list[str] = []
    scene_ids: list[str] = []
    label_to_index = {label: index for index, label in enumerate(POSTURE_LABELS)}
    for scene in raw_scenes:
        if not isinstance(scene, dict):
            raise PostureModelError("dataset scene must be an object")
        scene_id = _text(scene.get("scene_id"), "scene_id")
        keypoints_path = Path(_text(scene.get("keypoints"), "keypoints"))
        annotations_path = Path(_text(scene.get("annotations"), "annotations"))
        annotations = PoseAnnotations.load(annotations_path, expected_scene_id=scene_id)
        if len(annotations.posture_segments) != 1:
            raise PostureModelError("bootstrap scenes must contain one posture segment")
        segment = annotations.posture_segments[0]
        try:
            lines = keypoints_path.read_text(encoding="utf-8").splitlines()
        except OSError as exc:
            raise PostureModelError(f"cannot read keypoints for {scene_id}: {exc}") from exc
        selected_records: list[dict[str, Any]] = []
        for raw_line in lines:
            if not raw_line.strip():
                continue
            record = json.loads(raw_line)
            timestamp_ms = float(record["timestamp_ms"])
            if segment.start_ms <= timestamp_ms < segment.end_ms:
                selected_records.append(record)
        if len(selected_records) > max_samples_per_scene:
            indices = np.linspace(
                0,
                len(selected_records) - 1,
                max_samples_per_scene,
                dtype=np.int64,
            )
            selected_records = [selected_records[int(index)] for index in indices]
        for record in selected_records:
            feature, _ = extract_posture_features(record, score_threshold=score_threshold)
            features.append(feature)
            labels.append(label_to_index[segment.posture])
            splits.append(segment.split)
            scene_ids.append(scene_id)
    if not features:
        raise PostureModelError("dataset produced no labelled frame samples")
    return (
        np.stack(features),
        np.asarray(labels, dtype=np.int64),
        np.asarray(splits, dtype=np.str_),
        scene_ids,
    )


def train_posture_model(
    index_path: str | Path,
    *,
    epochs: int = 500,
    learning_rate: float = 0.02,
    l2: float = 1e-4,
    seed: int = 42,
    score_threshold: float = 0.2,
    min_visible_ratio: float = 0.35,
    max_samples_per_scene: int = 400,
) -> tuple[StaticPostureModel, dict[str, object]]:
    """Train class-weighted softmax regression and evaluate video-held-out splits."""

    if epochs < 1 or learning_rate <= 0 or l2 < 0:
        raise PostureModelError("training hyperparameters are invalid")
    features, targets, splits, scene_ids = load_dataset_samples(
        index_path,
        score_threshold=score_threshold,
        max_samples_per_scene=max_samples_per_scene,
    )
    train_mask = splits == "train"
    known_train_mask = train_mask & (targets < len(MODEL_LABELS))
    if not known_train_mask.any():
        raise PostureModelError("dataset contains no known-posture training samples")
    mean = features[known_train_mask].mean(axis=0)
    scale = features[known_train_mask].std(axis=0)
    scale[scale < 1e-6] = 1.0
    standardized = (features - mean) / scale
    rng = np.random.default_rng(seed)
    weights = rng.normal(0.0, 0.01, size=(features.shape[1], len(MODEL_LABELS)))
    bias = np.zeros(len(MODEL_LABELS), dtype=np.float64)
    first_moment_w = np.zeros_like(weights)
    second_moment_w = np.zeros_like(weights)
    first_moment_b = np.zeros_like(bias)
    second_moment_b = np.zeros_like(bias)

    train_targets = targets[known_train_mask]
    counts = np.bincount(train_targets, minlength=len(MODEL_LABELS)).astype(np.float64)
    nonzero = counts > 0
    class_weights = np.zeros_like(counts)
    class_weights[nonzero] = counts[nonzero].sum() / (counts[nonzero] * nonzero.sum())
    sample_weights = class_weights[train_targets]
    x_train = standardized[known_train_mask]
    eye_targets = np.eye(len(MODEL_LABELS))[train_targets]

    for step in range(1, epochs + 1):
        logits = x_train @ weights + bias
        probabilities = _softmax_rows(logits)
        weighted_difference = (probabilities - eye_targets) * sample_weights[:, None]
        normalization = max(float(sample_weights.sum()), 1.0)
        gradient_w = x_train.T @ weighted_difference / normalization + l2 * weights
        gradient_b = weighted_difference.sum(axis=0) / normalization
        weights, first_moment_w, second_moment_w = _adam_update(
            weights,
            gradient_w,
            first_moment_w,
            second_moment_w,
            step=step,
            learning_rate=learning_rate,
        )
        bias, first_moment_b, second_moment_b = _adam_update(
            bias,
            gradient_b,
            first_moment_b,
            second_moment_b,
            step=step,
            learning_rate=learning_rate,
        )

    raw_probabilities = _softmax_rows(standardized @ weights + bias)
    centroids = np.stack(
        [
            standardized[known_train_mask & (targets == index)].mean(axis=0)
            for index in range(len(MODEL_LABELS))
        ]
    )
    distances = _nearest_centroid_distances(standardized, centroids)
    confidence_threshold, distance_threshold = _select_rejection_thresholds(
        raw_probabilities,
        distances,
        targets,
        splits,
    )
    model = StaticPostureModel(
        labels=MODEL_LABELS,
        feature_mean=mean,
        feature_scale=scale,
        weights=weights,
        bias=bias,
        class_centroids=centroids,
        confidence_threshold=confidence_threshold,
        distance_threshold=distance_threshold,
        score_threshold=score_threshold,
        min_visible_ratio=min_visible_ratio,
        evidence_level="weak_label_bootstrap",
    )
    metrics = {
        "model_schema_version": MODEL_SCHEMA_VERSION,
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "evidence_level": model.evidence_level,
        "sample_count": int(features.shape[0]),
        "feature_count": int(features.shape[1]),
        "scene_count": len(set(scene_ids)),
        "class_sample_counts": {
            label: int((targets == index).sum())
            for index, label in enumerate(POSTURE_LABELS)
        },
        "split_sample_counts": dict(sorted(Counter(splits.tolist()).items())),
        "confidence_threshold": confidence_threshold,
        "distance_threshold": distance_threshold,
        "max_samples_per_scene": max_samples_per_scene,
        "metrics": {
            split: _evaluate_split(
                raw_probabilities,
                targets,
                splits,
                distances,
                split=split,
                confidence_threshold=confidence_threshold,
                distance_threshold=distance_threshold,
            )
            for split in ("train", "val", "test")
            if bool((splits == split).any())
        },
    }
    return model, metrics


def save_posture_model(path: str | Path, model: StaticPostureModel) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(model.to_payload(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _evaluate_split(
    probabilities: np.ndarray,
    targets: np.ndarray,
    splits: np.ndarray,
    distances: np.ndarray,
    *,
    split: str,
    confidence_threshold: float,
    distance_threshold: float,
) -> dict[str, object]:
    mask = splits == split
    split_probabilities = probabilities[mask]
    split_targets = targets[mask]
    predictions = _rejection_predictions(
        split_probabilities,
        distances[mask],
        confidence_threshold=confidence_threshold,
        distance_threshold=distance_threshold,
    )
    confusion = np.zeros((len(POSTURE_LABELS), len(POSTURE_LABELS)), dtype=np.int64)
    for actual, predicted in zip(split_targets, predictions, strict=True):
        confusion[int(actual), int(predicted)] += 1
    per_class: dict[str, object] = {}
    f1_values: list[float] = []
    for index, label in enumerate(POSTURE_LABELS):
        true_positive = int(confusion[index, index])
        predicted_count = int(confusion[:, index].sum())
        actual_count = int(confusion[index, :].sum())
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
    accuracy = float((predictions == split_targets).mean()) if split_targets.size else 0.0
    return {
        "accuracy": round(accuracy, 6),
        "macro_f1": round(float(np.mean(f1_values)) if f1_values else 0.0, 6),
        "confusion_matrix": confusion.tolist(),
        "per_class": per_class,
    }


def _select_rejection_thresholds(
    probabilities: np.ndarray,
    distances: np.ndarray,
    targets: np.ndarray,
    splits: np.ndarray,
) -> tuple[float, float]:
    val_mask = splits == "val"
    known_train_mask = (splits == "train") & (targets < len(MODEL_LABELS))
    if not known_train_mask.any():
        raise PostureModelError("known training samples are required for rejection calibration")
    candidates = [
        max(float(np.percentile(distances[known_train_mask], percentile)), 1e-6)
        for percentile in (90.0, 95.0, 97.5, 99.0, 100.0)
    ]
    if not val_mask.any():
        return 0.55, round(candidates[2], 6)
    best_confidence = 0.55
    best_distance = candidates[2]
    best_score = -1.0
    for confidence_threshold in np.arange(0.35, 0.81, 0.05):
        for distance_threshold in candidates:
            predictions = _rejection_predictions(
                probabilities[val_mask],
                distances[val_mask],
                confidence_threshold=float(confidence_threshold),
                distance_threshold=distance_threshold,
            )
            score = _macro_f1(
                targets[val_mask], predictions, len(POSTURE_LABELS)
            )
            if score > best_score + 1e-12:
                best_score = score
                best_confidence = float(confidence_threshold)
                best_distance = distance_threshold
    return round(best_confidence, 3), round(best_distance, 6)


def _rejection_predictions(
    probabilities: np.ndarray,
    distances: np.ndarray,
    *,
    confidence_threshold: float,
    distance_threshold: float,
) -> np.ndarray:
    predictions = probabilities.argmax(axis=1).astype(np.int64)
    rejected = (probabilities.max(axis=1) < confidence_threshold) | (
        distances > distance_threshold
    )
    predictions[rejected] = POSTURE_LABELS.index("unknown")
    return cast(np.ndarray, predictions)


def _nearest_centroid_distances(
    standardized: np.ndarray, centroids: np.ndarray
) -> np.ndarray:
    differences = standardized[:, None, :] - centroids[None, :, :]
    distances = np.linalg.norm(differences, axis=2) / math.sqrt(standardized.shape[1])
    return cast(np.ndarray, distances.min(axis=1))


def _nearest_centroid_distance(
    standardized: np.ndarray, centroids: np.ndarray
) -> float:
    differences = centroids - standardized[None, :]
    distances = np.linalg.norm(differences, axis=1) / math.sqrt(standardized.size)
    return float(distances.min())


def _output_probabilities(
    known_probabilities: np.ndarray,
    *,
    rejected: bool,
    nearest_distance: float,
    distance_threshold: float,
) -> np.ndarray:
    output = np.zeros(len(POSTURE_LABELS), dtype=np.float64)
    if not rejected:
        output[: len(MODEL_LABELS)] = known_probabilities
        return output
    distance_excess = max(nearest_distance / max(distance_threshold, 1e-8) - 1.0, 0.0)
    unknown_probability = min(max(0.5, 1.0 - float(known_probabilities.max())), 0.95)
    unknown_probability = min(0.99, unknown_probability + min(distance_excess, 1.0) * 0.25)
    output[: len(MODEL_LABELS)] = known_probabilities * (1.0 - unknown_probability)
    output[-1] = unknown_probability
    output /= output.sum()
    return output


def _macro_f1(targets: np.ndarray, predictions: np.ndarray, class_count: int) -> float:
    scores: list[float] = []
    for index in range(class_count):
        actual = targets == index
        if not actual.any():
            continue
        predicted = predictions == index
        true_positive = int((actual & predicted).sum())
        precision = true_positive / int(predicted.sum()) if predicted.any() else 0.0
        recall = true_positive / int(actual.sum())
        score = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        scores.append(score)
    return float(np.mean(scores)) if scores else 0.0


def _adam_update(
    parameters: np.ndarray,
    gradient: np.ndarray,
    first_moment: np.ndarray,
    second_moment: np.ndarray,
    *,
    step: int,
    learning_rate: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    beta1 = 0.9
    beta2 = 0.999
    epsilon = 1e-8
    first_moment = beta1 * first_moment + (1 - beta1) * gradient
    second_moment = beta2 * second_moment + (1 - beta2) * (gradient * gradient)
    corrected_first = first_moment / (1 - beta1**step)
    corrected_second = second_moment / (1 - beta2**step)
    parameters = parameters - learning_rate * corrected_first / (
        np.sqrt(corrected_second) + epsilon
    )
    return parameters, first_moment, second_moment


def _pair_midpoint(
    coords: np.ndarray, visible: np.ndarray, indices: tuple[int, int]
) -> np.ndarray | None:
    if all(bool(visible[index]) for index in indices):
        return cast(np.ndarray, coords[list(indices)].mean(axis=0))
    return None


def _pair_distance(coords: np.ndarray, visible: np.ndarray, indices: tuple[int, int]) -> float:
    if all(bool(visible[index]) for index in indices):
        return float(np.linalg.norm(coords[indices[0]] - coords[indices[1]]))
    return 0.0


def _joint_angle(
    coords: np.ndarray,
    visible: np.ndarray,
    first: int,
    center: int,
    last: int,
) -> float:
    if not all(bool(visible[index]) for index in (first, center, last)):
        return -1.0
    vector_a = coords[first] - coords[center]
    vector_b = coords[last] - coords[center]
    denominator = float(np.linalg.norm(vector_a) * np.linalg.norm(vector_b))
    if denominator < 1e-8:
        return -1.0
    cosine = float(np.clip(np.dot(vector_a, vector_b) / denominator, -1.0, 1.0))
    return math.acos(cosine) / math.pi


def _softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max()
    exponent = np.exp(shifted)
    return cast(np.ndarray, exponent / exponent.sum())


def _softmax_rows(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    exponent = np.exp(shifted)
    return cast(np.ndarray, exponent / exponent.sum(axis=1, keepdims=True))


def _array(value: object, field_name: str, *, ndim: int) -> np.ndarray:
    try:
        array = np.asarray(value, dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise PostureModelError(f"{field_name} must be numeric") from exc
    if array.ndim != ndim or not np.all(np.isfinite(array)):
        raise PostureModelError(f"{field_name} must be a finite {ndim}D array")
    return array


def _text(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PostureModelError(f"{field_name} must be a non-empty string")
    return value.strip()


def _positive_number(value: object, field_name: str) -> float:
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise PostureModelError(f"{field_name} must be numeric")
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise PostureModelError(f"{field_name} must be finite and positive")
    return number


def _unit_number(value: object, field_name: str) -> float:
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise PostureModelError(f"{field_name} must be numeric")
    number = float(value)
    if not 0.0 <= number <= 1.0:
        raise PostureModelError(f"{field_name} must be between 0 and 1")
    return number


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    train = subparsers.add_parser("train", help="train a static posture model")
    train.add_argument("index", type=Path)
    train.add_argument("--model-output", type=Path, required=True)
    train.add_argument("--metrics-output", type=Path, required=True)
    train.add_argument("--epochs", type=int, default=500)
    train.add_argument("--learning-rate", type=float, default=0.02)
    train.add_argument("--l2", type=float, default=1e-4)
    train.add_argument("--seed", type=int, default=42)
    train.add_argument("--score-threshold", type=float, default=0.2)
    train.add_argument("--min-visible-ratio", type=float, default=0.35)
    train.add_argument("--max-samples-per-scene", type=int, default=400)
    predict = subparsers.add_parser("predict", help="predict one FrameLandmarks JSON")
    predict.add_argument("model", type=Path)
    predict.add_argument("record", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "train":
            model, metrics = train_posture_model(
                args.index,
                epochs=args.epochs,
                learning_rate=args.learning_rate,
                l2=args.l2,
                seed=args.seed,
                score_threshold=args.score_threshold,
                min_visible_ratio=args.min_visible_ratio,
                max_samples_per_scene=args.max_samples_per_scene,
            )
            save_posture_model(args.model_output, model)
            args.metrics_output.parent.mkdir(parents=True, exist_ok=True)
            args.metrics_output.write_text(
                json.dumps(metrics, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            print(json.dumps(metrics, ensure_ascii=False, indent=2))
        else:
            model = StaticPostureModel.load(args.model)
            record = json.loads(args.record.read_text(encoding="utf-8"))
            prediction = model.predict_record(record)
            print(
                json.dumps(
                    {
                        "posture": prediction.posture,
                        "confidence": prediction.confidence,
                        "probabilities": prediction.probabilities,
                        "visible_keypoint_ratio": prediction.visible_keypoint_ratio,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        return 0
    except (PostureModelError, OSError, json.JSONDecodeError) as exc:
        print(f"error: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
