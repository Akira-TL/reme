"""Load compact fixed-point heads exported for the INT8 edge perception path."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import numpy as np

from reme.runtime.perception.fall_mil import (
    FALL_WINDOW_FEATURE_NAMES,
    FallWindowConfig,
)
from reme.runtime.perception.posture import (
    MODEL_LABELS,
    POSTURE_LABELS,
    PosturePrediction,
    extract_posture_features,
)

POSTURE_HEAD_SCHEMA_VERSION = "reme-edge-posture-head/v3-experiment"
FALL_HEAD_SCHEMA_VERSION = "reme-edge-fall-head/v2-experiment"
BUNDLE_SCHEMA_VERSION = "reme-edge-bundle/v1-experiment"
_UNKNOWN_INDEX = POSTURE_LABELS.index("unknown")
_NOSE_FEATURE_INDICES = frozenset((0, 1, 34))
_IGNORED_FACE_KEYPOINTS = (
    "left_eye",
    "right_eye",
    "left_ear",
    "right_ear",
)
_IGNORED_FACE_FEATURE_INDICES = frozenset(
    feature_index
    for keypoint_index in range(1, 5)
    for feature_index in (
        keypoint_index * 2,
        keypoint_index * 2 + 1,
        34 + keypoint_index,
    )
)


class EdgeBundleError(RuntimeError):
    """Raised when an exported edge model or bundle is malformed."""


@dataclass(frozen=True, slots=True)
class CompactPostureModel:
    """Nose-retaining posture head with INT16 weights and centroids."""

    feature_indices: np.ndarray
    retained_keypoints: tuple[str, ...]
    labels: tuple[str, ...]
    feature_mean: np.ndarray
    feature_scale: np.ndarray
    quantized_weights: np.ndarray
    weight_scales: np.ndarray
    bias: np.ndarray
    quantized_centroids: np.ndarray
    centroid_scales: np.ndarray
    distance_normalization_feature_count: int
    confidence_threshold: float
    distance_threshold: float
    score_threshold: float
    min_visible_ratio: float
    evidence_level: str

    def __post_init__(self) -> None:
        feature_count = self.feature_indices.size
        if self.feature_indices.ndim != 1 or feature_count < 1:
            raise EdgeBundleError("posture feature_indices must be a non-empty vector")
        if len(set(int(value) for value in self.feature_indices)) != feature_count:
            raise EdgeBundleError("posture feature_indices must be unique")
        if np.any(self.feature_indices < 0) or np.any(self.feature_indices >= 68):
            raise EdgeBundleError("posture feature index is out of range")
        active_indices = frozenset(int(value) for value in self.feature_indices)
        if not active_indices >= _NOSE_FEATURE_INDICES:
            raise EdgeBundleError("posture head must retain nose coordinates and score")
        if active_indices & _IGNORED_FACE_FEATURE_INDICES:
            raise EdgeBundleError("posture head must exclude eye and ear features")
        if "nose" not in self.retained_keypoints:
            raise EdgeBundleError("posture retained_keypoints must contain nose")
        if any(name in self.retained_keypoints for name in _IGNORED_FACE_KEYPOINTS):
            raise EdgeBundleError("posture retained_keypoints must exclude eyes and ears")
        if self.labels != MODEL_LABELS:
            raise EdgeBundleError(f"posture labels must be {MODEL_LABELS}")
        if self.feature_mean.shape != (feature_count,):
            raise EdgeBundleError("posture feature_mean has the wrong shape")
        if self.feature_scale.shape != (feature_count,) or np.any(self.feature_scale <= 0):
            raise EdgeBundleError("posture feature_scale has the wrong shape or range")
        if self.quantized_weights.shape != (feature_count, len(self.labels)):
            raise EdgeBundleError("posture weights have the wrong shape")
        if self.weight_scales.shape != (feature_count,) or np.any(
            self.weight_scales <= 0
        ):
            raise EdgeBundleError("posture weight scales have the wrong shape or range")
        if self.bias.shape != (len(self.labels),):
            raise EdgeBundleError("posture bias has the wrong shape")
        if self.quantized_centroids.shape != (len(self.labels), feature_count):
            raise EdgeBundleError("posture centroids have the wrong shape")
        if self.centroid_scales.shape != (feature_count,) or np.any(
            self.centroid_scales <= 0
        ):
            raise EdgeBundleError("posture centroid scales have the wrong shape or range")
        if self.distance_normalization_feature_count < feature_count:
            raise EdgeBundleError("posture distance normalization count is invalid")
        _unit_number(self.confidence_threshold, "confidence_threshold")
        _positive_number(self.distance_threshold, "distance_threshold")
        _unit_number(self.score_threshold, "score_threshold")
        _unit_number(self.min_visible_ratio, "min_visible_ratio")
        if not self.evidence_level.strip():
            raise EdgeBundleError("posture evidence_level must be non-empty")

    @property
    def weights(self) -> np.ndarray:
        return self.quantized_weights.astype(np.float64) * self.weight_scales[:, None]

    @property
    def centroids(self) -> np.ndarray:
        return self.quantized_centroids.astype(np.float64) * self.centroid_scales[None, :]

    @classmethod
    def load(cls, path: str | Path) -> CompactPostureModel:
        payload = _json_object(Path(path), "compact posture head")
        if payload.get("schema_version") != POSTURE_HEAD_SCHEMA_VERSION:
            raise EdgeBundleError("unsupported compact posture schema_version")
        retained = _string_tuple(payload.get("retained_keypoints"), "retained_keypoints")
        ignored = _string_tuple(
            payload.get("ignored_face_keypoints"), "ignored_face_keypoints"
        )
        if payload.get("head_tracking_proxy") != "nose":
            raise EdgeBundleError("compact posture head_tracking_proxy must be nose")
        if ignored != _IGNORED_FACE_KEYPOINTS:
            raise EdgeBundleError("compact posture ignored face keypoints are invalid")
        return cls(
            feature_indices=_integer_array(
                payload.get("feature_indices"), "feature_indices", ndim=1
            ),
            retained_keypoints=retained,
            labels=_string_tuple(payload.get("labels"), "labels"),
            feature_mean=_float_array(
                payload.get("feature_mean_float32"), "feature_mean_float32", ndim=1
            ),
            feature_scale=_float_array(
                payload.get("feature_scale_float32"), "feature_scale_float32", ndim=1
            ),
            quantized_weights=_integer_array(
                payload.get("weights_int16"), "weights_int16", ndim=2
            ).astype(np.int16),
            weight_scales=_float_array(
                payload.get("weight_scales_per_feature_float32"),
                "weight_scales_per_feature_float32",
                ndim=1,
            ),
            bias=_float_array(payload.get("bias_float32"), "bias_float32", ndim=1),
            quantized_centroids=_integer_array(
                payload.get("centroids_int16"), "centroids_int16", ndim=2
            ).astype(np.int16),
            centroid_scales=_float_array(
                payload.get("centroid_scales_float32"),
                "centroid_scales_float32",
                ndim=1,
            ),
            distance_normalization_feature_count=_positive_integer(
                payload.get("distance_normalization_feature_count"),
                "distance_normalization_feature_count",
            ),
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
        feature, visible_ratio = extract_posture_features(
            record, score_threshold=self.score_threshold
        )
        if not bool(record.get("person_detected")) or visible_ratio < self.min_visible_ratio:
            probabilities = np.zeros(len(POSTURE_LABELS), dtype=np.float64)
            probabilities[_UNKNOWN_INDEX] = 1.0
            return _posture_prediction(
                "unknown",
                probabilities,
                visible_ratio,
                classification_source="edge_visibility_reject",
            )

        selected = feature[self.feature_indices]
        standardized = (selected - self.feature_mean) / self.feature_scale
        known_probabilities = _softmax(standardized @ self.weights + self.bias)
        best_index = int(np.argmax(known_probabilities))
        nearest_distance = float(
            np.linalg.norm(self.centroids - standardized[None, :], axis=1).min()
            / math.sqrt(self.distance_normalization_feature_count)
        )
        rejected = (
            float(known_probabilities[best_index]) < self.confidence_threshold
            or nearest_distance > self.distance_threshold
        )
        probabilities = _output_probabilities(
            known_probabilities,
            rejected=rejected,
            nearest_distance=nearest_distance,
            distance_threshold=self.distance_threshold,
        )
        if rejected:
            return _posture_prediction(
                "unknown",
                probabilities,
                visible_ratio,
                classification_source="edge_int16_reject",
            )
        return _posture_prediction(
            self.labels[best_index],
            probabilities,
            visible_ratio,
            classification_source="edge_int16",
        )


@dataclass(frozen=True, slots=True)
class CompactFallModel:
    """INT16 linear fall-window head compatible with the MIL runtime seam."""

    feature_names: tuple[str, ...]
    feature_mean: np.ndarray
    feature_scale: np.ndarray
    quantized_weights: np.ndarray
    weight_scale: float
    bias: float
    threshold: float
    window_config: FallWindowConfig
    evidence_level: str

    def __post_init__(self) -> None:
        feature_count = len(self.feature_names)
        if self.feature_names != FALL_WINDOW_FEATURE_NAMES:
            raise EdgeBundleError("fall feature_names do not match the frozen order")
        if self.feature_mean.shape != (feature_count,):
            raise EdgeBundleError("fall feature_mean has the wrong shape")
        if self.feature_scale.shape != (feature_count,) or np.any(self.feature_scale <= 0):
            raise EdgeBundleError("fall feature_scale has the wrong shape or range")
        if self.quantized_weights.shape != (feature_count,):
            raise EdgeBundleError("fall weights have the wrong shape")
        _positive_number(self.weight_scale, "weight_scale")
        _finite_number(self.bias, "bias")
        _unit_number(self.threshold, "threshold")
        if not self.evidence_level.strip():
            raise EdgeBundleError("fall evidence_level must be non-empty")

    @property
    def weights(self) -> np.ndarray:
        return self.quantized_weights.astype(np.float64) * self.weight_scale

    @classmethod
    def load(cls, path: str | Path) -> CompactFallModel:
        payload = _json_object(Path(path), "compact fall head")
        if payload.get("schema_version") != FALL_HEAD_SCHEMA_VERSION:
            raise EdgeBundleError("unsupported compact fall schema_version")
        return cls(
            feature_names=_string_tuple(payload.get("feature_names"), "feature_names"),
            feature_mean=_float_array(
                payload.get("feature_mean_float32"), "feature_mean_float32", ndim=1
            ),
            feature_scale=_float_array(
                payload.get("feature_scale_float32"), "feature_scale_float32", ndim=1
            ),
            quantized_weights=_integer_array(
                payload.get("weights_int16"), "weights_int16", ndim=1
            ).astype(np.int16),
            weight_scale=_positive_number(
                payload.get("weight_scale_float32"), "weight_scale_float32"
            ),
            bias=_finite_number(payload.get("bias_float32"), "bias_float32"),
            threshold=_unit_number(payload.get("threshold"), "threshold"),
            window_config=FallWindowConfig.from_payload(payload.get("window_config")),
            evidence_level=_text(payload.get("evidence_level"), "evidence_level"),
        )

    def predict_probability(self, features: Any) -> float:
        array = np.asarray(features, dtype=np.float64)
        if array.shape != self.feature_mean.shape:
            raise EdgeBundleError("fall features have the wrong shape")
        standardized = (array - self.feature_mean) / self.feature_scale
        logit = float(standardized @ self.weights + self.bias)
        return 1.0 / (1.0 + math.exp(-max(min(logit, 60.0), -60.0)))


@dataclass(frozen=True, slots=True)
class EdgePerceptionBundle:
    """Validated paths and compact heads for one edge deployment bundle."""

    root: Path
    pose_model_path: Path
    posture_model: CompactPostureModel
    fall_model: CompactFallModel
    manifest: dict[str, Any]

    @classmethod
    def load(
        cls,
        path: str | Path,
        *,
        verify_hashes: bool = True,
    ) -> EdgePerceptionBundle:
        root = Path(path).expanduser().resolve()
        manifest = _json_object(root / "manifest.json", "edge bundle manifest")
        if manifest.get("schema_version") != BUNDLE_SCHEMA_VERSION:
            raise EdgeBundleError("unsupported edge bundle schema_version")
        if manifest.get("deployment_status") != (
            "budget_and_quantization_gate_passed_target_npu_unverified"
        ):
            raise EdgeBundleError("edge bundle has not passed the quantization gate")
        files = manifest.get("files")
        if not isinstance(files, dict):
            raise EdgeBundleError("edge bundle files must be an object")
        pose_path = _bundle_file(root, files, "pose_model", verify_hashes=verify_hashes)
        posture_path = _bundle_file(
            root, files, "posture_head", verify_hashes=verify_hashes
        )
        fall_path = _bundle_file(root, files, "fall_head", verify_hashes=verify_hashes)
        return cls(
            root=root,
            pose_model_path=pose_path,
            posture_model=CompactPostureModel.load(posture_path),
            fall_model=CompactFallModel.load(fall_path),
            manifest=manifest,
        )


def model_schema_version(path: str | Path) -> str | None:
    """Return a JSON model schema without treating binary models as errors."""

    source = Path(path)
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    value = payload.get("schema_version")
    return value if isinstance(value, str) else None


def _bundle_file(
    root: Path,
    files: dict[str, Any],
    key: str,
    *,
    verify_hashes: bool,
) -> Path:
    record = files.get(key)
    if not isinstance(record, dict):
        raise EdgeBundleError(f"edge bundle file record is missing: {key}")
    relative = record.get("path")
    expected_hash = record.get("sha256")
    if not isinstance(relative, str) or not relative:
        raise EdgeBundleError(f"edge bundle file path is invalid: {key}")
    resolved = (root / relative).resolve()
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise EdgeBundleError(f"edge bundle file is missing or escapes root: {key}")
    if verify_hashes and (
        not isinstance(expected_hash, str) or _sha256(resolved) != expected_hash
    ):
        raise EdgeBundleError(f"edge bundle file hash mismatch: {key}")
    return resolved


def _posture_prediction(
    posture: str,
    probabilities: np.ndarray,
    visible_ratio: float,
    *,
    classification_source: str,
) -> PosturePrediction:
    confidence = float(probabilities[POSTURE_LABELS.index(posture)])
    return PosturePrediction(
        posture=posture,
        confidence=round(confidence, 6),
        probabilities={
            label: round(float(probabilities[index]), 6)
            for index, label in enumerate(POSTURE_LABELS)
        },
        visible_keypoint_ratio=round(visible_ratio, 6),
        classification_source=classification_source,
    )


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
    unknown_probability = min(
        0.99,
        unknown_probability + min(distance_excess, 1.0) * 0.25,
    )
    output[: len(MODEL_LABELS)] = known_probabilities * (1.0 - unknown_probability)
    output[_UNKNOWN_INDEX] = unknown_probability
    output /= output.sum()
    return output


def _softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max()
    exponent = np.exp(shifted)
    return cast(np.ndarray, exponent / exponent.sum())


def _json_object(path: Path, description: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise EdgeBundleError(f"cannot read {description}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise EdgeBundleError(f"{description} is invalid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise EdgeBundleError(f"{description} must be an object")
    return cast(dict[str, Any], payload)


def _float_array(value: object, field_name: str, *, ndim: int) -> np.ndarray:
    try:
        array = np.asarray(value, dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise EdgeBundleError(f"{field_name} must be numeric") from exc
    if array.ndim != ndim or not np.all(np.isfinite(array)):
        raise EdgeBundleError(f"{field_name} must be a finite {ndim}D array")
    return array


def _integer_array(value: object, field_name: str, *, ndim: int) -> np.ndarray:
    try:
        array = np.asarray(value, dtype=np.int64)
    except (TypeError, ValueError) as exc:
        raise EdgeBundleError(f"{field_name} must be an integer array") from exc
    if array.ndim != ndim:
        raise EdgeBundleError(f"{field_name} must be a {ndim}D array")
    return array


def _string_tuple(value: object, field_name: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise EdgeBundleError(f"{field_name} must be a string array")
    return tuple(value)


def _text(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise EdgeBundleError(f"{field_name} must be a non-empty string")
    return value.strip()


def _finite_number(value: object, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise EdgeBundleError(f"{field_name} must be numeric")
    number = float(value)
    if not math.isfinite(number):
        raise EdgeBundleError(f"{field_name} must be finite")
    return number


def _positive_number(value: object, field_name: str) -> float:
    number = _finite_number(value, field_name)
    if number <= 0:
        raise EdgeBundleError(f"{field_name} must be positive")
    return number


def _unit_number(value: object, field_name: str) -> float:
    number = _finite_number(value, field_name)
    if not 0.0 <= number <= 1.0:
        raise EdgeBundleError(f"{field_name} must be between 0 and 1")
    return number


def _positive_integer(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise EdgeBundleError(f"{field_name} must be a positive integer")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
