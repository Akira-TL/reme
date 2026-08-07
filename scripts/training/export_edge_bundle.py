"""Export and verify a compact nose-tracking INT8 edge perception bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
from reme.runtime.perception.fall_mil import (
    FallMILModel,
    build_fall_windows,
    load_fall_positive_bags,
    load_normal_negative_bags,
)
from reme.runtime.perception.posture import (
    POSTURE_LABELS,
    StaticPostureModel,
    extract_posture_features,
)

POSTURE_HEAD_SCHEMA_VERSION = "reme-edge-posture-head/v3-experiment"
FALL_HEAD_SCHEMA_VERSION = "reme-edge-fall-head/v2-experiment"
BUNDLE_SCHEMA_VERSION = "reme-edge-bundle/v1-experiment"
UNKNOWN_INDEX = POSTURE_LABELS.index("unknown")
POSE_ESTIMATED_OPS = 541_099_008
INT8_TOPS = 1_000_000_000_000


class EdgeBundleError(RuntimeError):
    """Raised when a compact edge bundle cannot be exported or verified."""


def _json_load(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise EdgeBundleError(f"cannot read JSON {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise EdgeBundleError(f"invalid JSON {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise EdgeBundleError(f"JSON root must be an object: {path}")
    return payload


def _json_write(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _file_record(path: Path, *, relative_to: Path) -> dict[str, object]:
    return {
        "path": str(path.relative_to(relative_to)),
        "bytes": path.stat().st_size,
        "sha256": _sha256(path),
    }


def _safe_scale(maximum: np.ndarray | float, denominator: float) -> np.ndarray:
    scale = np.asarray(maximum, dtype=np.float64) / denominator
    return np.where(scale > 1e-12, scale, 1.0)


def quantize_matrix_per_feature(weights: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Symmetrically quantize posture weights to signed INT16 per input feature."""

    array = np.asarray(weights, dtype=np.float64)
    if array.ndim != 2:
        raise EdgeBundleError("posture weights must be a matrix")
    scales = _safe_scale(np.max(np.abs(array), axis=1), 32767.0)
    quantized = np.rint(array / scales[:, None])
    return np.clip(quantized, -32767, 32767).astype(np.int16), scales


def quantize_centroids_per_feature(centroids: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Symmetrically quantize class centroids to signed int16 per feature."""

    array = np.asarray(centroids, dtype=np.float64)
    if array.ndim != 2:
        raise EdgeBundleError("posture centroids must be a matrix")
    scales = _safe_scale(np.max(np.abs(array), axis=0), 32767.0)
    quantized = np.rint(array / scales[None, :])
    return np.clip(quantized, -32767, 32767).astype(np.int16), scales


def quantize_vector(weights: np.ndarray) -> tuple[np.ndarray, float]:
    """Symmetrically quantize one linear output vector to signed int16."""

    array = np.asarray(weights, dtype=np.float64)
    if array.ndim != 1:
        raise EdgeBundleError("fall weights must be a vector")
    scale = float(_safe_scale(float(np.max(np.abs(array))), 32767.0))
    quantized = np.rint(array / scale)
    return np.clip(quantized, -32767, 32767).astype(np.int16), scale


def _softmax_rows(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    exponent = np.exp(shifted)
    return exponent / exponent.sum(axis=1, keepdims=True)


def _sigmoid(values: np.ndarray) -> np.ndarray:
    clipped = np.clip(values, -60.0, 60.0)
    return 1.0 / (1.0 + np.exp(-clipped))


def _posture_predictions(
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
    predictions[rejected] = UNKNOWN_INDEX
    return predictions


def _feature_mode(report: dict[str, Any]) -> tuple[str, np.ndarray, dict[str, Any]]:
    selected = report.get("selected")
    modes = report.get("feature_modes")
    head_tracking = report.get("head_tracking")
    if not isinstance(selected, dict) or not isinstance(modes, dict):
        raise EdgeBundleError("posture report is missing selected feature metadata")
    if not isinstance(head_tracking, dict):
        raise EdgeBundleError("posture report is missing head-tracking metadata")
    mode = selected.get("mode")
    mode_payload = modes.get(mode) if isinstance(mode, str) else None
    if not isinstance(mode_payload, dict):
        raise EdgeBundleError("selected posture feature mode is invalid")
    raw_indices = mode_payload.get("feature_indices")
    keypoints = mode_payload.get("keypoints")
    if not isinstance(raw_indices, list) or not all(
        isinstance(value, int) for value in raw_indices
    ):
        raise EdgeBundleError("posture feature indices must be integers")
    if not isinstance(keypoints, list) or not all(isinstance(value, str) for value in keypoints):
        raise EdgeBundleError("posture keypoints must be strings")
    proxy = head_tracking.get("proxy_keypoint")
    ignored = head_tracking.get("ignored_face_keypoints")
    if proxy != "nose" or "nose" not in keypoints:
        raise EdgeBundleError("selected posture head must retain the nose proxy")
    if not isinstance(ignored, list) or any(name in keypoints for name in ignored):
        raise EdgeBundleError("selected posture head must exclude eyes and ears")
    return mode, np.asarray(raw_indices, dtype=np.int64), mode_payload


def _all_posture_features(
    dataset_index: Path,
    *,
    score_threshold: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    index = _json_load(dataset_index)
    scenes = index.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise EdgeBundleError("posture dataset index has no scenes")
    features: list[np.ndarray] = []
    detected: list[bool] = []
    visible_ratios: list[float] = []
    for scene_index, scene in enumerate(scenes):
        if not isinstance(scene, dict):
            raise EdgeBundleError(f"posture scene {scene_index} must be an object")
        keypoints = scene.get("keypoints")
        if not isinstance(keypoints, str) or not keypoints:
            raise EdgeBundleError(f"posture scene {scene_index} has no keypoints path")
        keypoints_path = Path(keypoints)
        for line_number, raw_line in enumerate(
            keypoints_path.read_text(encoding="utf-8").splitlines(),
            start=1,
        ):
            if not raw_line.strip():
                continue
            record = json.loads(raw_line)
            if not isinstance(record, dict):
                raise EdgeBundleError(
                    f"posture keypoint record is not an object: {keypoints_path}:{line_number}"
                )
            feature, visible_ratio = extract_posture_features(
                record,
                score_threshold=score_threshold,
            )
            features.append(feature)
            detected.append(bool(record.get("person_detected")))
            visible_ratios.append(visible_ratio)
    if not features:
        raise EdgeBundleError("posture dataset produced no feature records")
    return (
        np.stack(features),
        np.asarray(detected, dtype=np.bool_),
        np.asarray(visible_ratios, dtype=np.float64),
    )


def _export_posture_head(
    *,
    model_path: Path,
    report_path: Path,
    dataset_index: Path,
    output_path: Path,
) -> dict[str, object]:
    model = StaticPostureModel.load(model_path)
    report = _json_load(report_path)
    mode, indices, mode_payload = _feature_mode(report)
    if np.any(indices < 0) or np.any(indices >= model.feature_mean.size):
        raise EdgeBundleError("selected posture feature index is out of range")

    selected_mean = model.feature_mean[indices]
    selected_scale = model.feature_scale[indices]
    selected_weights = model.weights[indices]
    selected_centroids = model.class_centroids[:, indices]
    quantized_weights, weight_scales = quantize_matrix_per_feature(selected_weights)
    quantized_centroids, centroid_scales = quantize_centroids_per_feature(
        selected_centroids
    )
    dequantized_weights = quantized_weights.astype(np.float64) * weight_scales[:, None]
    dequantized_centroids = (
        quantized_centroids.astype(np.float64) * centroid_scales[None, :]
    )

    features, person_detected, visible_ratios = _all_posture_features(
        dataset_index,
        score_threshold=model.score_threshold,
    )
    full_standardized = (features - model.feature_mean) / model.feature_scale
    original_probabilities = _softmax_rows(full_standardized @ model.weights + model.bias)
    full_differences = full_standardized[:, None, :] - model.class_centroids[None, :, :]
    original_distances = np.linalg.norm(full_differences, axis=2).min(axis=1) / math.sqrt(
        model.feature_mean.size
    )
    selected_standardized = (features[:, indices] - selected_mean) / selected_scale
    quantized_probabilities = _softmax_rows(
        selected_standardized @ dequantized_weights + model.bias
    )
    compact_differences = (
        selected_standardized[:, None, :] - dequantized_centroids[None, :, :]
    )
    quantized_distances = np.linalg.norm(compact_differences, axis=2).min(axis=1) / math.sqrt(
        model.feature_mean.size
    )
    original_predictions = _posture_predictions(
        original_probabilities,
        original_distances,
        confidence_threshold=model.confidence_threshold,
        distance_threshold=model.distance_threshold,
    )
    quantized_predictions = _posture_predictions(
        quantized_probabilities,
        quantized_distances,
        confidence_threshold=model.confidence_threshold,
        distance_threshold=model.distance_threshold,
    )
    visibility_rejected = (~person_detected) | (
        visible_ratios < model.min_visible_ratio
    )
    original_predictions[visibility_rejected] = UNKNOWN_INDEX
    quantized_predictions[visibility_rejected] = UNKNOWN_INDEX
    probability_error = np.abs(original_probabilities - quantized_probabilities)
    distance_error = np.abs(original_distances - quantized_distances)

    payload = {
        "schema_version": POSTURE_HEAD_SCHEMA_VERSION,
        "source_schema_version": model.to_payload()["schema_version"],
        "feature_mode": mode,
        "feature_indices": [int(value) for value in indices.tolist()],
        "retained_keypoints": mode_payload["keypoints"],
        "head_tracking_proxy": "nose",
        "ignored_face_keypoints": ["left_eye", "right_eye", "left_ear", "right_ear"],
        "labels": list(model.labels),
        "feature_mean_float32": selected_mean.astype(np.float32).tolist(),
        "feature_scale_float32": selected_scale.astype(np.float32).tolist(),
        "weights_int16": quantized_weights.astype(int).tolist(),
        "weight_scales_per_feature_float32": weight_scales.astype(np.float32).tolist(),
        "bias_float32": model.bias.astype(np.float32).tolist(),
        "centroids_int16": quantized_centroids.astype(int).tolist(),
        "centroid_scales_float32": centroid_scales.astype(np.float32).tolist(),
        "distance_normalization_feature_count": int(model.feature_mean.size),
        "confidence_threshold": model.confidence_threshold,
        "distance_threshold": model.distance_threshold,
        "score_threshold": model.score_threshold,
        "min_visible_ratio": model.min_visible_ratio,
        "evidence_level": model.evidence_level,
    }
    _json_write(output_path, payload)
    return {
        "feature_mode": mode,
        "active_feature_count": int(indices.size),
        "original_feature_count": int(model.feature_mean.size),
        "sample_count": int(features.shape[0]),
        "probability_error_max": round(float(probability_error.max()), 9),
        "probability_error_p95": round(float(np.percentile(probability_error, 95)), 9),
        "distance_error_max": round(float(distance_error.max()), 9),
        "argmax_disagreements": int(
            np.count_nonzero(
                original_probabilities.argmax(axis=1)
                != quantized_probabilities.argmax(axis=1)
            )
        ),
        "final_prediction_disagreements": int(
            np.count_nonzero(original_predictions != quantized_predictions)
        ),
        "claim_boundary": (
            "quantization regression over every persisted keypoint record, including "
            "person-detected and visible-ratio rejection; not posture accuracy evidence"
        ),
    }


def _all_fall_windows(
    *,
    model: FallMILModel,
    posture_model: StaticPostureModel,
    fall_manifest: Path,
    fall_samples: Path,
    normal_index: Path,
) -> np.ndarray:
    bags = (
        *load_fall_positive_bags(fall_manifest, fall_samples),
        *load_normal_negative_bags(normal_index, predictor=posture_model),
    )
    windows = [
        window
        for bag in bags
        for window in build_fall_windows(bag, config=model.window_config)
    ]
    if not windows:
        raise EdgeBundleError("fall artifacts produced no usable windows")
    return np.asarray([window.features for window in windows], dtype=np.float64)


def _export_fall_head(
    *,
    model_path: Path,
    posture_model_path: Path,
    fall_manifest: Path,
    fall_samples: Path,
    normal_index: Path,
    output_path: Path,
) -> dict[str, object]:
    model = FallMILModel.load(model_path)
    posture_model = StaticPostureModel.load(posture_model_path)
    quantized_weights, weight_scale = quantize_vector(model.weights)
    dequantized_weights = quantized_weights.astype(np.float64) * weight_scale
    features = _all_fall_windows(
        model=model,
        posture_model=posture_model,
        fall_manifest=fall_manifest,
        fall_samples=fall_samples,
        normal_index=normal_index,
    )
    standardized = (features - model.feature_mean) / model.feature_scale
    original_probabilities = _sigmoid(standardized @ model.weights + model.bias)
    quantized_probabilities = _sigmoid(standardized @ dequantized_weights + model.bias)
    original_candidates = original_probabilities >= model.threshold
    quantized_candidates = quantized_probabilities >= model.threshold
    probability_error = np.abs(original_probabilities - quantized_probabilities)

    payload = {
        "schema_version": FALL_HEAD_SCHEMA_VERSION,
        "source_schema_version": model.to_payload()["schema_version"],
        "feature_names": list(model.feature_names),
        "feature_mean_float32": model.feature_mean.astype(np.float32).tolist(),
        "feature_scale_float32": model.feature_scale.astype(np.float32).tolist(),
        "weights_int16": quantized_weights.astype(int).tolist(),
        "weight_scale_float32": float(np.float32(weight_scale)),
        "bias_float32": float(np.float32(model.bias)),
        "threshold": model.threshold,
        "window_config": model.window_config.to_payload(),
        "evidence_level": model.evidence_level,
    }
    _json_write(output_path, payload)
    return {
        "feature_count": len(model.feature_names),
        "window_count": int(features.shape[0]),
        "probability_error_max": round(float(probability_error.max()), 9),
        "probability_error_p95": round(float(np.percentile(probability_error, 95)), 9),
        "threshold_candidate_disagreements": int(
            np.count_nonzero(original_candidates != quantized_candidates)
        ),
        "claim_boundary": (
            "quantization regression only; does not establish fall precision, recall or F1"
        ),
    }


def _budget_report(posture_feature_count: int, fall_feature_count: int) -> dict[str, object]:
    posture_linear_ops = posture_feature_count * 4 * 2
    fall_linear_ops = fall_feature_count * 2
    downstream_ops = posture_linear_ops + fall_linear_ops
    scenarios: dict[str, object] = {}
    for fps in (5, 10, 15, 30):
        required_ops = POSE_ESTIMATED_OPS * fps + downstream_ops * fps
        scenarios[str(fps)] = {
            "required_ops_per_second": required_ops,
            "required_tops": round(required_ops / INT8_TOPS, 6),
            "share_of_1tops_percent": round(required_ops / INT8_TOPS * 100.0, 4),
        }
    utilization_latency = {
        str(percent): round(
            POSE_ESTIMATED_OPS / (INT8_TOPS * (percent / 100.0)) * 1000.0,
            6,
        )
        for percent in (10, 20, 50, 100)
    }
    return {
        "pose_estimated_ops_per_frame": POSE_ESTIMATED_OPS,
        "posture_linear_ops_per_frame": posture_linear_ops,
        "fall_linear_ops_per_window": fall_linear_ops,
        "one_tops_int8_ops_per_second": INT8_TOPS,
        "scenarios": scenarios,
        "pose_theoretical_latency_ms_by_effective_utilization_percent": utilization_latency,
        "claim_boundary": (
            "operation-budget simulation only; not a target-chip compiler, power or latency result"
        ),
    }


def export_bundle(source_run: Path, output_dir: Path) -> dict[str, object]:
    if output_dir.exists() and any(output_dir.iterdir()):
        raise EdgeBundleError(f"output directory is non-empty: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    source_run = source_run.resolve()
    posture_model = source_run / "candidate/posture/model.json"
    posture_report = source_run / "candidate/posture/training-report.json"
    fall_model = source_run / "candidate/fall/model.json"
    fall_manifest = source_run / "inputs/fall-clip-manifest.local.json"
    fall_samples = source_run / "fall-int8-data/pose-samples.jsonl"
    source_manifest = _json_load(source_run / "run-manifest.json")
    source_day1 = Path(str(source_manifest.get("source_run", ""))).resolve()
    pose_model = source_day1 / "models/movenet_lightning_int8_v4.tflite"
    normal_index = source_day1 / "pose-int8-dataset/dataset-index.json"
    required = (
        posture_model,
        posture_report,
        fall_model,
        fall_manifest,
        fall_samples,
        pose_model,
        normal_index,
    )
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise EdgeBundleError(f"source run is missing required artifacts: {missing}")

    started = time.perf_counter()
    model_dir = output_dir / "models"
    reference_dir = output_dir / "reference"
    model_dir.mkdir(parents=True, exist_ok=True)
    reference_dir.mkdir(parents=True, exist_ok=True)
    pose_output = model_dir / "pose_int8.tflite"
    posture_output = model_dir / "posture_head.int16.json"
    fall_output = model_dir / "fall_head.int16.json"
    shutil.copy2(pose_model, pose_output)
    shutil.copy2(posture_model, reference_dir / "posture_head.float.json")
    shutil.copy2(fall_model, reference_dir / "fall_head.float.json")

    posture_verification = _export_posture_head(
        model_path=posture_model,
        report_path=posture_report,
        dataset_index=normal_index,
        output_path=posture_output,
    )
    fall_verification = _export_fall_head(
        model_path=fall_model,
        posture_model_path=posture_model,
        fall_manifest=fall_manifest,
        fall_samples=fall_samples,
        normal_index=normal_index,
        output_path=fall_output,
    )
    verification = {
        "schema_version": "reme-edge-bundle-verification/v1-experiment",
        "posture": posture_verification,
        "fall": fall_verification,
    }
    _json_write(output_dir / "verification.json", verification)
    budget = _budget_report(
        int(posture_verification["active_feature_count"]),
        int(fall_verification["feature_count"]),
    )
    _json_write(output_dir / "one-tops-budget.json", budget)

    files = {
        "pose_model": _file_record(pose_output, relative_to=output_dir),
        "posture_head": _file_record(posture_output, relative_to=output_dir),
        "fall_head": _file_record(fall_output, relative_to=output_dir),
        "posture_float_reference": _file_record(
            reference_dir / "posture_head.float.json", relative_to=output_dir
        ),
        "fall_float_reference": _file_record(
            reference_dir / "fall_head.float.json", relative_to=output_dir
        ),
    }
    quantization_gate_passed = (
        int(posture_verification["final_prediction_disagreements"]) == 0
        and int(fall_verification["threshold_candidate_disagreements"]) == 0
    )
    manifest = {
        "schema_version": BUNDLE_SCHEMA_VERSION,
        "source_refinement_run": str(source_run),
        "source_day1_run": str(source_day1),
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "files": files,
        "head_tracking": {
            "proxy_keypoint": "nose",
            "ignored_face_keypoints": [
                "left_eye",
                "right_eye",
                "left_ear",
                "right_ear",
            ],
            "feature_mode": posture_verification["feature_mode"],
        },
        "verification": verification,
        "one_tops_budget": budget,
        "preservation": {
            "source_models_modified": False,
            "legacy_models_deleted": False,
            "frontend_modified": False,
        },
        "deployment_status": (
            "budget_and_quantization_gate_passed_target_npu_unverified"
            if quantization_gate_passed
            else "quantization_regression_failed"
        ),
    }
    _json_write(output_dir / "manifest.json", manifest)
    print(json.dumps(manifest, ensure_ascii=False, indent=2), flush=True)
    return manifest


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-run", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    root = Path(__file__).resolve().parents[2]
    try:
        export_bundle((root / args.source_run).resolve(), (root / args.output_dir).resolve())
        return 0
    except (EdgeBundleError, OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
