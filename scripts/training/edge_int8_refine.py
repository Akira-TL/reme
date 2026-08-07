"""Refine the INT8 posture head with leave-one-video-out calibration and retrain fall MIL."""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from reme.runtime.perception.annotations import POSTURE_LABELS
from reme.runtime.perception.fall_mil import (
    FallMILTrainingConfig,
    train_fall_mil_from_artifacts,
)
from reme.runtime.perception.fall_training_data import extract_fall_training_data
from reme.runtime.perception.posture import (
    MODEL_LABELS,
    StaticPostureModel,
    load_dataset_samples,
    save_posture_model,
)
from reme.runtime.perception.scene_bundle import MOVENET_KEYPOINT_NAMES

KEYPOINT_COUNT = len(MOVENET_KEYPOINT_NAMES)
COORDINATE_FEATURE_COUNT = KEYPOINT_COUNT * 2
SCORE_OFFSET = COORDINATE_FEATURE_COUNT
GEOMETRY_OFFSET = SCORE_OFFSET + KEYPOINT_COUNT
GEOMETRY_FEATURE_COUNT = 17
FEATURE_COUNT = GEOMETRY_OFFSET + GEOMETRY_FEATURE_COUNT
UNKNOWN_INDEX = POSTURE_LABELS.index("unknown")
FACE_KEYPOINTS = (
    "left_eye",
    "right_eye",
    "left_ear",
    "right_ear",
)
BODY_KEYPOINTS = MOVENET_KEYPOINT_NAMES[5:]
CORE_BODY_KEYPOINTS = (
    "left_shoulder",
    "right_shoulder",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
)
HEAD_TRACKING_KEYPOINT = "nose"
HEAD_TRACKING_MODES = ("nose_body_geometry", "nose_core_geometry")


def _feature_indices_for_keypoints(keypoint_names: Sequence[str]) -> np.ndarray:
    keypoint_indices = [MOVENET_KEYPOINT_NAMES.index(name) for name in keypoint_names]
    coordinate_indices = [
        feature_index
        for keypoint_index in keypoint_indices
        for feature_index in (keypoint_index * 2, keypoint_index * 2 + 1)
    ]
    score_indices = [SCORE_OFFSET + keypoint_index for keypoint_index in keypoint_indices]
    return np.asarray(
        [
            *coordinate_indices,
            *score_indices,
            *range(GEOMETRY_OFFSET, FEATURE_COUNT),
        ],
        dtype=np.int64,
    )


FEATURE_MODE_KEYPOINTS: dict[str, tuple[str, ...]] = {
    "all": MOVENET_KEYPOINT_NAMES,
    "body_geometry": BODY_KEYPOINTS,
    "nose_body_geometry": (HEAD_TRACKING_KEYPOINT, *BODY_KEYPOINTS),
    "nose_core_geometry": (HEAD_TRACKING_KEYPOINT, *CORE_BODY_KEYPOINTS),
    "geometry": (),
}
FEATURE_MODES: dict[str, np.ndarray] = {
    "all": np.arange(FEATURE_COUNT, dtype=np.int64),
    "body_geometry": _feature_indices_for_keypoints(BODY_KEYPOINTS),
    "nose_body_geometry": _feature_indices_for_keypoints(
        FEATURE_MODE_KEYPOINTS["nose_body_geometry"]
    ),
    "nose_core_geometry": _feature_indices_for_keypoints(
        FEATURE_MODE_KEYPOINTS["nose_core_geometry"]
    ),
    "geometry": np.arange(GEOMETRY_OFFSET, FEATURE_COUNT, dtype=np.int64),
}
SEEDS = (42, 2026)
LEARNING_RATES = (0.01, 0.03)
FALL_SEEDS = (42, 2026, 3407)


class RefineError(RuntimeError):
    """Raised when the grouped refinement experiment is invalid."""


@dataclass(frozen=True, slots=True)
class LinearFit:
    mean: np.ndarray
    scale: np.ndarray
    weights: np.ndarray
    bias: np.ndarray
    centroids: np.ndarray


@dataclass(frozen=True, slots=True)
class ConfigResult:
    mode: str
    seed: int
    learning_rate: float
    confidence_threshold: float
    distance_threshold: float
    macro_f1: float
    minimum_known_f1: float
    selection_score: float
    accuracy: float
    confusion: np.ndarray
    per_class: dict[str, dict[str, float | int]]
    per_scene: list[dict[str, object]]


@dataclass(frozen=True, slots=True)
class FallSelection:
    seed: int
    score: float
    positive_rate: float
    negative_rate: float
    model_path: Path
    report_path: Path


def _json_load(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RefineError(f"JSON root must be an object: {path}")
    return payload


def _json_write(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _softmax_rows(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    exponent = np.exp(shifted)
    return exponent / exponent.sum(axis=1, keepdims=True)


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
    first_moment = beta1 * first_moment + (1.0 - beta1) * gradient
    second_moment = beta2 * second_moment + (1.0 - beta2) * (gradient * gradient)
    corrected_first = first_moment / (1.0 - beta1**step)
    corrected_second = second_moment / (1.0 - beta2**step)
    parameters = parameters - learning_rate * corrected_first / (
        np.sqrt(corrected_second) + epsilon
    )
    return parameters, first_moment, second_moment


def _fit_linear(
    features: np.ndarray,
    targets: np.ndarray,
    train_mask: np.ndarray,
    *,
    feature_indices: np.ndarray,
    seed: int,
    learning_rate: float,
    epochs: int,
    l2: float = 1e-4,
) -> LinearFit:
    known_mask = train_mask & (targets < len(MODEL_LABELS))
    if not known_mask.any():
        raise RefineError("fold has no known posture training samples")
    selected = features[:, feature_indices]
    train = selected[known_mask]
    train_targets = targets[known_mask]
    classes = set(int(value) for value in train_targets.tolist())
    if classes != set(range(len(MODEL_LABELS))):
        raise RefineError(f"fold is missing known posture classes: {sorted(classes)}")
    mean = train.mean(axis=0)
    scale = train.std(axis=0)
    scale[scale < 1e-6] = 1.0
    standardized = (train - mean) / scale

    rng = np.random.default_rng(seed)
    weights = rng.normal(0.0, 0.01, size=(feature_indices.size, len(MODEL_LABELS)))
    bias = np.zeros(len(MODEL_LABELS), dtype=np.float64)
    first_w = np.zeros_like(weights)
    second_w = np.zeros_like(weights)
    first_b = np.zeros_like(bias)
    second_b = np.zeros_like(bias)
    counts = np.bincount(train_targets, minlength=len(MODEL_LABELS)).astype(np.float64)
    class_weights = counts.sum() / (counts * len(MODEL_LABELS))
    sample_weights = class_weights[train_targets]
    expected = np.eye(len(MODEL_LABELS), dtype=np.float64)[train_targets]

    for step in range(1, epochs + 1):
        probabilities = _softmax_rows(standardized @ weights + bias)
        difference = (probabilities - expected) * sample_weights[:, None]
        normalization = max(float(sample_weights.sum()), 1.0)
        gradient_w = standardized.T @ difference / normalization + l2 * weights
        gradient_b = difference.sum(axis=0) / normalization
        weights, first_w, second_w = _adam_update(
            weights,
            gradient_w,
            first_w,
            second_w,
            step=step,
            learning_rate=learning_rate,
        )
        bias, first_b, second_b = _adam_update(
            bias,
            gradient_b,
            first_b,
            second_b,
            step=step,
            learning_rate=learning_rate,
        )

    standardized_all = (selected - mean) / scale
    centroids = np.stack(
        [
            standardized_all[known_mask & (targets == class_index)].mean(axis=0)
            for class_index in range(len(MODEL_LABELS))
        ]
    )
    return LinearFit(
        mean=mean,
        scale=scale,
        weights=weights,
        bias=bias,
        centroids=centroids,
    )


def _predict_raw(
    fit: LinearFit,
    features: np.ndarray,
    *,
    feature_indices: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    selected = features[:, feature_indices]
    standardized = (selected - fit.mean) / fit.scale
    probabilities = _softmax_rows(standardized @ fit.weights + fit.bias)
    differences = standardized[:, None, :] - fit.centroids[None, :, :]
    distances_selected = np.linalg.norm(differences, axis=2).min(axis=1)
    distances = distances_selected / math.sqrt(FEATURE_COUNT)
    return probabilities, distances


def _apply_rejection(
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


def _metrics(targets: np.ndarray, predictions: np.ndarray) -> tuple[
    float,
    float,
    float,
    np.ndarray,
    dict[str, dict[str, float | int]],
]:
    confusion = np.zeros((len(POSTURE_LABELS), len(POSTURE_LABELS)), dtype=np.int64)
    for actual, predicted in zip(targets, predictions, strict=True):
        confusion[int(actual), int(predicted)] += 1
    per_class: dict[str, dict[str, float | int]] = {}
    f1_values: list[float] = []
    known_f1_values: list[float] = []
    for index, label in enumerate(POSTURE_LABELS):
        support = int(confusion[index].sum())
        predicted_count = int(confusion[:, index].sum())
        true_positive = int(confusion[index, index])
        precision = true_positive / predicted_count if predicted_count else 0.0
        recall = true_positive / support if support else 0.0
        f1 = 2.0 * precision * recall / (precision + recall) if precision + recall else 0.0
        if support:
            f1_values.append(f1)
            if index < len(MODEL_LABELS):
                known_f1_values.append(f1)
        per_class[label] = {
            "support": support,
            "precision": round(precision, 6),
            "recall": round(recall, 6),
            "f1": round(f1, 6),
        }
    accuracy = float((targets == predictions).mean())
    macro_f1 = float(np.mean(f1_values))
    minimum_known_f1 = min(known_f1_values) if known_f1_values else 0.0
    return accuracy, macro_f1, minimum_known_f1, confusion, per_class


def _select_thresholds(
    probabilities: np.ndarray,
    distances: np.ndarray,
    targets: np.ndarray,
) -> tuple[float, float, tuple[float, float, float]]:
    known = targets < len(MODEL_LABELS)
    distance_candidates = [
        max(float(np.percentile(distances[known], percentile)), 1e-6)
        for percentile in (85.0, 90.0, 95.0, 97.5, 99.0, 100.0)
    ]
    best_thresholds = (0.5, distance_candidates[2])
    best = (-1.0, -1.0, -1.0)
    for confidence in np.arange(0.3, 0.86, 0.05):
        for distance in distance_candidates:
            predictions = _apply_rejection(
                probabilities,
                distances,
                confidence_threshold=float(confidence),
                distance_threshold=distance,
            )
            accuracy, macro_f1, minimum_known_f1, _, _ = _metrics(
                targets, predictions
            )
            score = macro_f1 + 0.2 * minimum_known_f1
            candidate = (score, minimum_known_f1, accuracy)
            if candidate > best:
                best = candidate
                best_thresholds = (float(confidence), distance)
    return best_thresholds[0], best_thresholds[1], best


def _evaluate_config(
    features: np.ndarray,
    targets: np.ndarray,
    scene_ids: np.ndarray,
    *,
    mode: str,
    seed: int,
    learning_rate: float,
    epochs: int,
) -> ConfigResult:
    indices = FEATURE_MODES[mode]
    probabilities = np.zeros((features.shape[0], len(MODEL_LABELS)), dtype=np.float64)
    distances = np.zeros(features.shape[0], dtype=np.float64)
    unique_scenes = sorted(set(scene_ids.tolist()))
    for fold_index, held_scene in enumerate(unique_scenes):
        held_mask = scene_ids == held_scene
        fit = _fit_linear(
            features,
            targets,
            ~held_mask,
            feature_indices=indices,
            seed=seed + fold_index * 17,
            learning_rate=learning_rate,
            epochs=epochs,
        )
        fold_probabilities, fold_distances = _predict_raw(
            fit,
            features[held_mask],
            feature_indices=indices,
        )
        probabilities[held_mask] = fold_probabilities
        distances[held_mask] = fold_distances
    confidence, distance, _ = _select_thresholds(probabilities, distances, targets)
    predictions = _apply_rejection(
        probabilities,
        distances,
        confidence_threshold=confidence,
        distance_threshold=distance,
    )
    accuracy, macro_f1, minimum_known_f1, confusion, per_class = _metrics(
        targets, predictions
    )
    per_scene: list[dict[str, object]] = []
    for scene_id in unique_scenes:
        mask = scene_ids == scene_id
        scene_accuracy, scene_macro, scene_minimum, _, scene_classes = _metrics(
            targets[mask], predictions[mask]
        )
        per_scene.append(
            {
                "scene_id": scene_id,
                "label": POSTURE_LABELS[int(targets[mask][0])],
                "sample_count": int(mask.sum()),
                "accuracy": round(scene_accuracy, 6),
                "macro_f1_present_classes": round(scene_macro, 6),
                "minimum_known_f1": round(scene_minimum, 6),
                "per_class": scene_classes,
            }
        )
    return ConfigResult(
        mode=mode,
        seed=seed,
        learning_rate=learning_rate,
        confidence_threshold=round(confidence, 3),
        distance_threshold=round(distance, 6),
        macro_f1=round(macro_f1, 6),
        minimum_known_f1=round(minimum_known_f1, 6),
        selection_score=round(macro_f1 + 0.2 * minimum_known_f1, 6),
        accuracy=round(accuracy, 6),
        confusion=confusion,
        per_class=per_class,
        per_scene=per_scene,
    )


def _to_full_model(
    fit: LinearFit,
    *,
    feature_indices: np.ndarray,
    confidence_threshold: float,
    distance_threshold: float,
) -> StaticPostureModel:
    mean = np.zeros(FEATURE_COUNT, dtype=np.float64)
    scale = np.full(FEATURE_COUNT, 1e9, dtype=np.float64)
    weights = np.zeros((FEATURE_COUNT, len(MODEL_LABELS)), dtype=np.float64)
    centroids = np.zeros((len(MODEL_LABELS), FEATURE_COUNT), dtype=np.float64)
    mean[feature_indices] = fit.mean
    scale[feature_indices] = fit.scale
    weights[feature_indices] = fit.weights
    centroids[:, feature_indices] = fit.centroids
    return StaticPostureModel(
        labels=MODEL_LABELS,
        feature_mean=mean,
        feature_scale=scale,
        weights=weights,
        bias=fit.bias,
        class_centroids=centroids,
        confidence_threshold=confidence_threshold,
        distance_threshold=distance_threshold,
        score_threshold=0.2,
        min_visible_ratio=0.35,
        evidence_level="weak_label_leave_one_video_out",
    )


def train_grouped_posture(index_path: Path, output_dir: Path) -> ConfigResult:
    features, targets, _splits, scene_ids_list = load_dataset_samples(
        index_path,
        score_threshold=0.2,
        max_samples_per_scene=400,
    )
    scene_ids = np.asarray(scene_ids_list, dtype=np.str_)
    results: list[ConfigResult] = []
    for mode in FEATURE_MODES:
        for seed in SEEDS:
            for learning_rate in LEARNING_RATES:
                print(
                    f"[loso] mode={mode} seed={seed} lr={learning_rate}",
                    flush=True,
                )
                results.append(
                    _evaluate_config(
                        features,
                        targets,
                        scene_ids,
                        mode=mode,
                        seed=seed,
                        learning_rate=learning_rate,
                        epochs=400,
                    )
                )
    eligible_results = [item for item in results if item.mode in HEAD_TRACKING_MODES]
    if not eligible_results:
        raise RefineError("no head-tracking posture candidates were evaluated")
    selected = max(
        eligible_results,
        key=lambda item: (
            item.selection_score,
            item.minimum_known_f1,
            item.macro_f1,
            item.accuracy,
        ),
    )
    final_fit = _fit_linear(
        features,
        targets,
        np.ones(features.shape[0], dtype=np.bool_),
        feature_indices=FEATURE_MODES[selected.mode],
        seed=selected.seed,
        learning_rate=selected.learning_rate,
        epochs=5000,
    )
    model = _to_full_model(
        final_fit,
        feature_indices=FEATURE_MODES[selected.mode],
        confidence_threshold=selected.confidence_threshold,
        distance_threshold=selected.distance_threshold,
    )
    candidate_dir = output_dir / "candidate/posture"
    save_posture_model(candidate_dir / "model.json", model)
    report = {
        "schema_version": "reme-posture-group-loso/v0-experiment",
        "dataset_index": str(index_path.resolve()),
        "sample_count": int(features.shape[0]),
        "scene_count": len(set(scene_ids.tolist())),
        "selection_basis": (
            "best head-tracking mode by oof_macro_f1_plus_0.2_times_"
            "minimum_known_class_f1"
        ),
        "head_tracking": {
            "proxy_keypoint": HEAD_TRACKING_KEYPOINT,
            "required_modes": list(HEAD_TRACKING_MODES),
            "ignored_face_keypoints": list(FACE_KEYPOINTS),
        },
        "selected": _config_payload(selected, include_scene=True),
        "candidates": [
            _config_payload(item, include_scene=False)
            for item in sorted(
                results,
                key=lambda item: (item.mode, item.seed, item.learning_rate),
            )
        ],
        "feature_modes": {
            name: {
                "feature_indices": [int(value) for value in indices.tolist()],
                "keypoints": list(FEATURE_MODE_KEYPOINTS[name]),
                "feature_count": int(indices.size),
                "retains_head_tracking": HEAD_TRACKING_KEYPOINT
                in FEATURE_MODE_KEYPOINTS[name],
            }
            for name, indices in FEATURE_MODES.items()
        },
        "claim_boundary": (
            "leave-one-video-out weak-label evidence; not real-world posture accuracy"
        ),
    }
    _json_write(candidate_dir / "training-report.json", report)
    return selected


def _config_payload(item: ConfigResult, *, include_scene: bool) -> dict[str, object]:
    payload: dict[str, object] = {
        "mode": item.mode,
        "seed": item.seed,
        "learning_rate": item.learning_rate,
        "confidence_threshold": item.confidence_threshold,
        "distance_threshold": item.distance_threshold,
        "accuracy": item.accuracy,
        "macro_f1": item.macro_f1,
        "minimum_known_f1": item.minimum_known_f1,
        "selection_score": item.selection_score,
        "confusion_matrix": item.confusion.tolist(),
        "per_class": item.per_class,
    }
    if include_scene:
        payload["per_scene"] = item.per_scene
    return payload


def _localize_manifest(source: Path, output: Path, root: Path) -> None:
    manifest = _json_load(source)
    raw = manifest.get("raw_video")
    marked = manifest.get("marked_video")
    if not isinstance(raw, dict) or not isinstance(marked, dict):
        raise RefineError("fall manifest is missing video metadata")
    localized = dict(manifest)
    localized["raw_video"] = {
        **raw,
        "path": str((root / "data/training/fall/raw/50种摔倒.mp4").resolve()),
    }
    localized["marked_video"] = {
        **marked,
        "path": str(
            (root / "data/training/fall/raw/50种摔倒方式 -摔倒检测.mp4").resolve()
        ),
    }
    _json_write(output, localized)


def _fall_validation(report: dict[str, Any]) -> tuple[float, float, float]:
    predictions = report.get("bag_predictions")
    if not isinstance(predictions, list):
        raise RefineError("fall report has no bag predictions")
    rows = [
        row
        for row in predictions
        if isinstance(row, dict) and row.get("split") == "val"
    ]
    positives = [row for row in rows if row.get("label") == "fall"]
    negatives = [row for row in rows if row.get("label") == "normal"]
    if not positives or not negatives:
        raise RefineError("fall validation requires both weak positive and negative bags")
    positive_rate = sum(bool(row.get("candidate")) for row in positives) / len(positives)
    negative_rate = sum(bool(row.get("candidate")) for row in negatives) / len(negatives)
    return positive_rate - negative_rate, positive_rate, negative_rate


def retrain_fall(
    *,
    root: Path,
    source_run: Path,
    output_dir: Path,
) -> FallSelection:
    manifest = output_dir / "inputs/fall-clip-manifest.local.json"
    _localize_manifest(
        root / "data/training/fall/bootstrap/clip-manifest.json",
        manifest,
        root,
    )
    model_path = source_run / "models/movenet_lightning_int8_v4.tflite"
    posture_model = output_dir / "candidate/posture/model.json"
    fall_data_dir = output_dir / "fall-int8-data"
    print("[refine] extracting fall data with grouped posture candidate", flush=True)
    extraction = extract_fall_training_data(
        manifest_path=manifest,
        movenet_model=model_path,
        posture_model=posture_model,
        output_dir=fall_data_dir,
        sample_fps=12.0,
        score_threshold=0.2,
        num_threads=4,
    )
    _json_write(output_dir / "reports/fall-int8-extraction.json", extraction)

    candidates: list[FallSelection] = []
    for seed in FALL_SEEDS:
        run_dir = output_dir / f"fall-mil-sweep/seed-{seed}"
        print(f"[refine] training fall seed={seed}", flush=True)
        report = train_fall_mil_from_artifacts(
            fall_manifest_path=manifest,
            fall_samples_path=fall_data_dir / "pose-samples.jsonl",
            weak_candidates_path=fall_data_dir / "weak-candidates.json",
            normal_index_path=source_run / "pose-int8-dataset/dataset-index.json",
            posture_model_path=posture_model,
            output_dir=run_dir,
            training_config=FallMILTrainingConfig(
                rounds=7,
                epochs=1800,
                learning_rate=0.03,
                l2=0.001,
                hard_negatives_per_bag=5,
                background_negatives_per_bag=5,
                positive_background_negatives_per_bag=4,
                random_seed=seed,
            ),
        )
        score, positive_rate, negative_rate = _fall_validation(report)
        candidates.append(
            FallSelection(
                seed=seed,
                score=score,
                positive_rate=positive_rate,
                negative_rate=negative_rate,
                model_path=run_dir / "model.json",
                report_path=run_dir / "training-report.json",
            )
        )
    selected = max(
        candidates,
        key=lambda item: (item.score, item.positive_rate, -item.negative_rate),
    )
    candidate_dir = output_dir / "candidate/fall"
    candidate_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(selected.model_path, candidate_dir / "model.json")
    shutil.copy2(selected.report_path, candidate_dir / "training-report.json")
    _json_write(
        candidate_dir / "selection-report.json",
        {
            "selected": _fall_payload(selected),
            "candidates": [_fall_payload(item) for item in candidates],
            "selection_basis": (
                "weak_validation_positive_candidate_rate_minus_negative_alert_rate"
            ),
            "claim_boundary": (
                "weak-bag selection only; no fall precision, recall or F1 claim"
            ),
        },
    )
    return selected


def _fall_payload(item: FallSelection) -> dict[str, object]:
    return {
        "seed": item.seed,
        "validation_score": item.score,
        "validation_positive_candidate_rate": item.positive_rate,
        "validation_negative_alert_rate": item.negative_rate,
    }


def run(source_run: Path, output_dir: Path) -> dict[str, object]:
    if output_dir.exists() and any(output_dir.iterdir()):
        raise RefineError(f"output directory is non-empty: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    root = Path(__file__).resolve().parents[2]
    started = time.time()
    source_index = source_run / "pose-int8-dataset/dataset-index.json"
    if not source_index.is_file():
        raise RefineError(f"source INT8 dataset is missing: {source_index}")
    selected_posture = train_grouped_posture(source_index, output_dir)
    selected_fall = retrain_fall(root=root, source_run=source_run, output_dir=output_dir)
    manifest = {
        "schema_version": "reme-edge-int8-refinement/v0-experiment",
        "source_run": str(source_run.resolve()),
        "elapsed_seconds": round(time.time() - started, 3),
        "posture": {
            "mode": selected_posture.mode,
            "head_tracking_proxy": HEAD_TRACKING_KEYPOINT,
            "ignored_face_keypoints": list(FACE_KEYPOINTS),
            "retained_keypoints": list(FEATURE_MODE_KEYPOINTS[selected_posture.mode]),
            "seed": selected_posture.seed,
            "learning_rate": selected_posture.learning_rate,
            "oof_macro_f1": selected_posture.macro_f1,
            "oof_minimum_known_f1": selected_posture.minimum_known_f1,
            "oof_accuracy": selected_posture.accuracy,
        },
        "fall": _fall_payload(selected_fall),
        "preservation": {
            "frontend_modified": False,
            "legacy_models_deleted": False,
            "source_run_modified": False,
        },
    }
    _json_write(output_dir / "run-manifest.json", manifest)
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
        run((root / args.source_run).resolve(), (root / args.output_dir).resolve())
        return 0
    except (RefineError, OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
