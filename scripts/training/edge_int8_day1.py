"""Run the first reproducible INT8 edge-training gate without replacing archived models."""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
import shutil
import sys
import time
import urllib.request
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from ai_edge_litert.interpreter import Interpreter
from reme.runtime.perception.fall_mil import (
    FallMILTrainingConfig,
    train_fall_mil_from_artifacts,
)
from reme.runtime.perception.fall_training_data import extract_fall_training_data
from reme.runtime.perception.posture import save_posture_model, train_posture_model
from reme.runtime.perception.video_dataset import DatasetCatalog, extract_catalog

OFFICIAL_MOVENET_INT8_URL = (
    "https://tfhub.dev/google/lite-model/movenet/singlepose/lightning/"
    "tflite/int8/4?lite-format=tflite"
)
POSTURE_SEEDS = (42, 2026, 3407)
POSTURE_LEARNING_RATES = (0.005, 0.01, 0.02, 0.04)
FALL_SEEDS = (42, 2026, 3407)


class EdgeTrainingError(RuntimeError):
    """Raised when the day-one edge pipeline cannot preserve a valid artifact trail."""


@dataclass(frozen=True, slots=True)
class Paths:
    root: Path
    output: Path

    @property
    def old_pose_index(self) -> Path:
        return self.root / "data/training/pose/processed/downloads6/dataset-index.json"

    @property
    def pose_raw_root(self) -> Path:
        return self.root / "data/training/pose/raw/downloads6"

    @property
    def pose_processed_root(self) -> Path:
        return self.root / "data/training/pose/processed/downloads6"

    @property
    def fp16_model(self) -> Path:
        return self.root / "models/runtime/movenet/movenet_lightning_f16_v4.tflite"

    @property
    def int8_model(self) -> Path:
        return self.output / "models/movenet_lightning_int8_v4.tflite"

    @property
    def pose_catalog(self) -> Path:
        return self.output / "inputs/pose-catalog.json"

    @property
    def int8_pose_dataset(self) -> Path:
        return self.output / "pose-int8-dataset"

    @property
    def posture_sweep(self) -> Path:
        return self.output / "posture-sweep"

    @property
    def posture_candidate(self) -> Path:
        return self.output / "candidate/posture"

    @property
    def source_fall_manifest(self) -> Path:
        return self.root / "data/training/fall/bootstrap/clip-manifest.json"

    @property
    def localized_fall_manifest(self) -> Path:
        return self.output / "inputs/fall-clip-manifest.local.json"

    @property
    def fall_raw_video(self) -> Path:
        return self.root / "data/training/fall/raw/50种摔倒.mp4"

    @property
    def fall_marked_video(self) -> Path:
        return self.root / "data/training/fall/raw/50种摔倒方式 -摔倒检测.mp4"

    @property
    def fall_int8_data(self) -> Path:
        return self.output / "fall-int8-data"

    @property
    def fall_sweep(self) -> Path:
        return self.output / "fall-mil-sweep"

    @property
    def fall_candidate(self) -> Path:
        return self.output / "candidate/fall"


@dataclass(frozen=True, slots=True)
class PostureCandidate:
    run_id: str
    model_path: Path
    metrics_path: Path
    validation_macro_f1: float
    validation_accuracy: float


@dataclass(frozen=True, slots=True)
class FallCandidate:
    run_id: str
    model_path: Path
    report_path: Path
    validation_score: float
    validation_positive_candidate_rate: float
    validation_negative_alert_rate: float


def _json_write(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _json_load(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise EdgeTrainingError(f"cannot read JSON {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise EdgeTrainingError(f"invalid JSON {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise EdgeTrainingError(f"JSON root must be an object: {path}")
    return payload


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "RemeEdgeTraining/0.1 (+LiteRT model audit)"},
    )
    try:
        with (
            urllib.request.urlopen(request, timeout=180) as response,
            temporary.open("wb") as target,
        ):
            shutil.copyfileobj(response, target)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        raise EdgeTrainingError(f"cannot download official MoveNet INT8 model: {exc}") from exc
    if temporary.stat().st_size < 1_000_000:
        temporary.unlink(missing_ok=True)
        raise EdgeTrainingError("downloaded MoveNet INT8 artifact is unexpectedly small")
    temporary.replace(destination)


def _tensor_map(interpreter: Interpreter) -> dict[int, dict[str, Any]]:
    return {int(item["index"]): item for item in interpreter.get_tensor_details()}


def _tensor_shape(tensors: dict[int, dict[str, Any]], index: int) -> tuple[int, ...]:
    detail = tensors.get(index)
    if detail is None:
        return ()
    return tuple(int(value) for value in detail["shape"])


def _dtype_name(detail: dict[str, Any]) -> str:
    return np.dtype(detail["dtype"]).name


def _estimate_macs(interpreter: Interpreter) -> tuple[int, dict[str, int]]:
    tensors = _tensor_map(interpreter)
    macs_by_op: collections.Counter[str] = collections.Counter()
    for op in interpreter._get_ops_details():  # noqa: SLF001 - LiteRT has no public op graph API
        op_name = str(op["op_name"])
        inputs = [int(index) for index in op["inputs"] if int(index) >= 0]
        outputs = [int(index) for index in op["outputs"] if int(index) >= 0]
        if not outputs:
            continue
        output_shape = _tensor_shape(tensors, outputs[0])
        if op_name == "CONV_2D" and len(inputs) >= 2 and len(output_shape) == 4:
            filter_shape = _tensor_shape(tensors, inputs[1])
            if len(filter_shape) == 4:
                batch, out_h, out_w, out_channels = output_shape
                _, kernel_h, kernel_w, in_channels = filter_shape
                macs_by_op[op_name] += (
                    batch
                    * out_h
                    * out_w
                    * out_channels
                    * kernel_h
                    * kernel_w
                    * in_channels
                )
        elif op_name == "DEPTHWISE_CONV_2D" and len(inputs) >= 2 and len(output_shape) == 4:
            filter_shape = _tensor_shape(tensors, inputs[1])
            if len(filter_shape) == 4:
                batch, out_h, out_w, out_channels = output_shape
                _, kernel_h, kernel_w, _ = filter_shape
                macs_by_op[op_name] += (
                    batch * out_h * out_w * out_channels * kernel_h * kernel_w
                )
    return sum(macs_by_op.values()), dict(sorted(macs_by_op.items()))


def _synthetic_input(detail: dict[str, Any]) -> np.ndarray:
    shape = tuple(int(value) for value in detail["shape"])
    dtype = np.dtype(detail["dtype"])
    if np.issubdtype(dtype, np.integer):
        info = np.iinfo(dtype)
        value = int((int(info.min) + int(info.max)) / 2)
        return np.full(shape, value, dtype=dtype)
    return np.zeros(shape, dtype=dtype)


def audit_tflite(path: Path, *, runs: int = 100) -> dict[str, object]:
    interpreter = Interpreter(model_path=str(path), num_threads=1)
    interpreter.allocate_tensors()
    tensors = _tensor_map(interpreter)
    operations = interpreter._get_ops_details()  # noqa: SLF001
    op_counts = collections.Counter(str(item["op_name"]) for item in operations)
    conv_dtypes: list[dict[str, object]] = []
    for op in operations:
        op_name = str(op["op_name"])
        if op_name not in {"CONV_2D", "DEPTHWISE_CONV_2D"}:
            continue
        input_types = [
            _dtype_name(tensors[int(index)])
            for index in op["inputs"]
            if int(index) >= 0 and int(index) in tensors
        ]
        output_types = [
            _dtype_name(tensors[int(index)])
            for index in op["outputs"]
            if int(index) >= 0 and int(index) in tensors
        ]
        conv_dtypes.append(
            {
                "op": op_name,
                "input_types": input_types,
                "output_types": output_types,
            }
        )
    for detail in interpreter.get_input_details():
        interpreter.set_tensor(int(detail["index"]), _synthetic_input(detail))
    for _ in range(10):
        interpreter.invoke()
    timings: list[float] = []
    for _ in range(runs):
        started = time.perf_counter_ns()
        interpreter.invoke()
        timings.append((time.perf_counter_ns() - started) / 1_000_000.0)
    values = np.asarray(timings, dtype=np.float64)
    macs, macs_by_op = _estimate_macs(interpreter)
    all_conv_integer = bool(conv_dtypes) and all(
        all(name in {"int8", "int16", "int32", "uint8"} for name in row["input_types"])
        and all(name in {"int8", "int16", "int32", "uint8"} for name in row["output_types"])
        for row in conv_dtypes
    )
    return {
        "path": str(path.resolve()),
        "bytes": path.stat().st_size,
        "sha256": _sha256(path),
        "inputs": [
            {
                "name": str(item["name"]),
                "shape": [int(value) for value in item["shape"]],
                "dtype": _dtype_name(item),
                "quantization": [float(item["quantization"][0]), int(item["quantization"][1])],
            }
            for item in interpreter.get_input_details()
        ],
        "outputs": [
            {
                "name": str(item["name"]),
                "shape": [int(value) for value in item["shape"]],
                "dtype": _dtype_name(item),
                "quantization": [float(item["quantization"][0]), int(item["quantization"][1])],
            }
            for item in interpreter.get_output_details()
        ],
        "op_counts": dict(sorted(op_counts.items())),
        "conv_dtype_examples": conv_dtypes[:8],
        "all_conv_integer": all_conv_integer,
        "estimated_macs": macs,
        "estimated_ops_mul_add": macs * 2,
        "macs_by_op": macs_by_op,
        "cpu_single_thread_ms": {
            "mean": round(float(values.mean()), 6),
            "p50": round(float(np.percentile(values, 50)), 6),
            "p95": round(float(np.percentile(values, 95)), 6),
        },
        "one_tops_budget": {
            str(int(utilization * 100)): {
                "effective_utilization": utilization,
                "theoretical_ms": round(macs * 2 / (1e12 * utilization) * 1000.0, 6),
            }
            for utilization in (0.1, 0.2, 0.5, 1.0)
        },
    }


def build_local_pose_catalog(paths: Paths) -> dict[str, object]:
    index = _json_load(paths.old_pose_index)
    raw_scenes = index.get("scenes")
    if not isinstance(raw_scenes, list) or not raw_scenes:
        raise EdgeTrainingError("existing posture index has no scenes")
    clips: list[dict[str, object]] = []
    for scene in raw_scenes:
        if not isinstance(scene, dict):
            raise EdgeTrainingError("existing posture scene must be an object")
        scene_id = str(scene["scene_id"])
        source_name = Path(str(scene["source"])).name
        source = paths.pose_raw_root / source_name
        if not source.is_file():
            raise EdgeTrainingError(f"missing local posture source: {source}")
        annotation_path = paths.pose_processed_root / scene_id / "annotations.json"
        annotation = _json_load(annotation_path)
        segments = annotation.get("posture_segments")
        if not isinstance(segments, list) or len(segments) != 1:
            raise EdgeTrainingError(f"expected one posture segment for {scene_id}")
        segment = segments[0]
        if not isinstance(segment, dict):
            raise EdgeTrainingError(f"invalid posture segment for {scene_id}")
        duration_ms = float(scene["duration_ms"])
        clips.append(
            {
                "scene_id": scene_id,
                "file": source_name,
                "split": str(scene["split"]),
                "label": str(scene["label"]),
                "start_ratio": round(float(segment["start_ms"]) / duration_ms, 9),
                "end_ratio": round(float(segment["end_ms"]) / duration_ms, 9),
                "notes": segment.get("notes"),
            }
        )
    catalog = {
        "schema_version": "reme-pose-dataset/v0-experiment",
        "dataset_id": "downloads6-animation-int8-reextract-20260806",
        "root": str(paths.pose_raw_root.relative_to(paths.root)),
        "sample_fps": float(index.get("sample_fps", 10.0)),
        "label_source": str(index.get("label_source", "filename_inference")),
        "evidence_level": str(index.get("evidence_level", "weak_label_bootstrap")),
        "clips": clips,
    }
    _json_write(paths.pose_catalog, catalog)
    return catalog


def localize_fall_manifest(paths: Paths) -> dict[str, object]:
    manifest = _json_load(paths.source_fall_manifest)
    raw = manifest.get("raw_video")
    marked = manifest.get("marked_video")
    if not isinstance(raw, dict) or not isinstance(marked, dict):
        raise EdgeTrainingError("fall manifest must contain raw_video and marked_video")
    if not paths.fall_raw_video.is_file() or not paths.fall_marked_video.is_file():
        raise EdgeTrainingError("local fall source videos are missing")
    if _sha256(paths.fall_raw_video) != str(raw.get("sha256")):
        raise EdgeTrainingError("local raw fall video hash does not match manifest")
    if _sha256(paths.fall_marked_video) != str(marked.get("sha256")):
        raise EdgeTrainingError("local marked fall video hash does not match manifest")
    localized = dict(manifest)
    localized["raw_video"] = {**raw, "path": str(paths.fall_raw_video.resolve())}
    localized["marked_video"] = {**marked, "path": str(paths.fall_marked_video.resolve())}
    _json_write(paths.localized_fall_manifest, localized)
    return localized


def _posture_validation(metrics: dict[str, Any]) -> tuple[float, float]:
    split_metrics = metrics.get("metrics")
    if not isinstance(split_metrics, dict):
        raise EdgeTrainingError("posture metrics has no split metrics")
    validation = split_metrics.get("val")
    if not isinstance(validation, dict):
        raise EdgeTrainingError("posture metrics has no validation split")
    return float(validation["macro_f1"]), float(validation["accuracy"])


def run_posture_sweep(paths: Paths) -> PostureCandidate:
    candidates: list[PostureCandidate] = []
    index_path = paths.int8_pose_dataset / "dataset-index.json"
    for seed in POSTURE_SEEDS:
        for learning_rate in POSTURE_LEARNING_RATES:
            run_id = f"seed-{seed}-lr-{learning_rate}"
            run_dir = paths.posture_sweep / run_id
            print(f"[posture] training {run_id}", flush=True)
            model, metrics = train_posture_model(
                index_path,
                epochs=5000,
                learning_rate=learning_rate,
                l2=1e-4,
                seed=seed,
                score_threshold=0.2,
                min_visible_ratio=0.35,
                max_samples_per_scene=400,
            )
            model_path = run_dir / "model.json"
            metrics_path = run_dir / "metrics.json"
            save_posture_model(model_path, model)
            _json_write(metrics_path, metrics)
            macro_f1, accuracy = _posture_validation(metrics)
            candidates.append(
                PostureCandidate(
                    run_id=run_id,
                    model_path=model_path,
                    metrics_path=metrics_path,
                    validation_macro_f1=macro_f1,
                    validation_accuracy=accuracy,
                )
            )
    selected = max(
        candidates,
        key=lambda item: (
            item.validation_macro_f1,
            item.validation_accuracy,
            -POSTURE_SEEDS.index(int(item.run_id.split("-")[1])),
        ),
    )
    paths.posture_candidate.mkdir(parents=True, exist_ok=True)
    shutil.copy2(selected.model_path, paths.posture_candidate / "model.json")
    shutil.copy2(selected.metrics_path, paths.posture_candidate / "metrics.json")
    _json_write(
        paths.posture_candidate / "selection-report.json",
        {
            "selection_basis": "validation_macro_f1_then_validation_accuracy",
            "selected": {
                "run_id": selected.run_id,
                "validation_macro_f1": selected.validation_macro_f1,
                "validation_accuracy": selected.validation_accuracy,
            },
            "candidates": [
                {
                    "run_id": item.run_id,
                    "validation_macro_f1": item.validation_macro_f1,
                    "validation_accuracy": item.validation_accuracy,
                }
                for item in sorted(candidates, key=lambda item: item.run_id)
            ],
            "claim_boundary": "weak-label validation selection; not real-world posture accuracy",
        },
    )
    return selected


def _fall_validation(report: dict[str, Any]) -> tuple[float, float, float]:
    predictions = report.get("bag_predictions")
    if not isinstance(predictions, list):
        raise EdgeTrainingError("fall report has no bag_predictions")
    rows = [row for row in predictions if isinstance(row, dict) and row.get("split") == "val"]
    positives = [row for row in rows if row.get("label") == "fall"]
    negatives = [row for row in rows if row.get("label") == "normal"]
    if not positives or not negatives:
        raise EdgeTrainingError("fall validation selection requires positive and negative bags")
    positive_rate = sum(bool(row.get("candidate")) for row in positives) / len(positives)
    negative_alert_rate = sum(bool(row.get("candidate")) for row in negatives) / len(negatives)
    return positive_rate - negative_alert_rate, positive_rate, negative_alert_rate


def run_fall_sweep(paths: Paths) -> FallCandidate:
    candidates: list[FallCandidate] = []
    for seed in FALL_SEEDS:
        run_id = f"seed-{seed}"
        run_dir = paths.fall_sweep / run_id
        print(f"[fall] training {run_id}", flush=True)
        report = train_fall_mil_from_artifacts(
            fall_manifest_path=paths.localized_fall_manifest,
            fall_samples_path=paths.fall_int8_data / "pose-samples.jsonl",
            weak_candidates_path=paths.fall_int8_data / "weak-candidates.json",
            normal_index_path=paths.int8_pose_dataset / "dataset-index.json",
            posture_model_path=paths.posture_candidate / "model.json",
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
            FallCandidate(
                run_id=run_id,
                model_path=run_dir / "model.json",
                report_path=run_dir / "training-report.json",
                validation_score=score,
                validation_positive_candidate_rate=positive_rate,
                validation_negative_alert_rate=negative_rate,
            )
        )
    selected = max(
        candidates,
        key=lambda item: (
            item.validation_score,
            item.validation_positive_candidate_rate,
            -item.validation_negative_alert_rate,
        ),
    )
    paths.fall_candidate.mkdir(parents=True, exist_ok=True)
    shutil.copy2(selected.model_path, paths.fall_candidate / "model.json")
    shutil.copy2(selected.report_path, paths.fall_candidate / "training-report.json")
    _json_write(
        paths.fall_candidate / "selection-report.json",
        {
            "selection_basis": "weak_validation_positive_candidate_rate_minus_negative_alert_rate",
            "selected": {
                "run_id": selected.run_id,
                "validation_score": selected.validation_score,
                "validation_positive_candidate_rate": (
                    selected.validation_positive_candidate_rate
                ),
                "validation_negative_alert_rate": selected.validation_negative_alert_rate,
            },
            "candidates": [
                {
                    "run_id": item.run_id,
                    "validation_score": item.validation_score,
                    "validation_positive_candidate_rate": (
                        item.validation_positive_candidate_rate
                    ),
                    "validation_negative_alert_rate": item.validation_negative_alert_rate,
                }
                for item in sorted(candidates, key=lambda item: item.run_id)
            ],
            "claim_boundary": (
                "weak-bag model selection only; fall precision, recall, F1 and event accuracy "
                "remain prohibited until manual event review"
            ),
        },
    )
    return selected


def _load_records(path: Path) -> dict[int, dict[str, Any]]:
    records: dict[int, dict[str, Any]] = {}
    with path.open("r", encoding="utf-8") as source:
        for line in source:
            if not line.strip():
                continue
            row = json.loads(line)
            if isinstance(row, dict) and isinstance(row.get("frame_index"), int):
                records[int(row["frame_index"])] = row
    return records


def compare_pose_datasets(paths: Paths) -> dict[str, object]:
    old_index = _json_load(paths.old_pose_index)
    new_index = _json_load(paths.int8_pose_dataset / "dataset-index.json")
    old_scenes = {
        str(row["scene_id"]): row
        for row in old_index.get("scenes", [])
        if isinstance(row, dict)
    }
    new_scenes = {
        str(row["scene_id"]): row
        for row in new_index.get("scenes", [])
        if isinstance(row, dict)
    }
    coordinate_errors: list[float] = []
    score_errors: list[float] = []
    compared_frames = 0
    detection_disagreements = 0
    per_scene: list[dict[str, object]] = []
    for scene_id in sorted(old_scenes.keys() & new_scenes.keys()):
        old_records = _load_records(paths.pose_processed_root / scene_id / "keypoints.jsonl")
        new_records = _load_records(paths.int8_pose_dataset / scene_id / "keypoints.jsonl")
        shared = sorted(old_records.keys() & new_records.keys())
        scene_coordinate_errors: list[float] = []
        scene_score_errors: list[float] = []
        scene_disagreements = 0
        for frame_index in shared:
            old = old_records[frame_index]
            new = new_records[frame_index]
            if bool(old.get("person_detected")) != bool(new.get("person_detected")):
                detection_disagreements += 1
                scene_disagreements += 1
            old_points = old.get("keypoints")
            new_points = new.get("keypoints")
            if not isinstance(old_points, list) or not isinstance(new_points, list):
                continue
            if len(old_points) != 17 or len(new_points) != 17:
                continue
            for old_point, new_point in zip(old_points, new_points, strict=True):
                if not isinstance(old_point, dict) or not isinstance(new_point, dict):
                    continue
                coordinate_error = math.dist(
                    (float(old_point["x_norm"]), float(old_point["y_norm"])),
                    (float(new_point["x_norm"]), float(new_point["y_norm"])),
                )
                score_error = abs(float(old_point["score"]) - float(new_point["score"]))
                coordinate_errors.append(coordinate_error)
                score_errors.append(score_error)
                scene_coordinate_errors.append(coordinate_error)
                scene_score_errors.append(score_error)
            compared_frames += 1
        per_scene.append(
            {
                "scene_id": scene_id,
                "shared_frames": len(shared),
                "detection_disagreements": scene_disagreements,
                "coordinate_mae": round(float(np.mean(scene_coordinate_errors)), 8)
                if scene_coordinate_errors
                else None,
                "score_mae": round(float(np.mean(scene_score_errors)), 8)
                if scene_score_errors
                else None,
            }
        )
    coords = np.asarray(coordinate_errors, dtype=np.float64)
    scores = np.asarray(score_errors, dtype=np.float64)
    return {
        "schema_version": "reme-movenet-int8-regression/v0-experiment",
        "comparison": "archived_fp16_keypoints_vs_new_official_int8_keypoints",
        "scene_count": len(per_scene),
        "compared_frames": compared_frames,
        "detection_disagreements": detection_disagreements,
        "detection_disagreement_rate": round(
            detection_disagreements / compared_frames, 8
        )
        if compared_frames
        else None,
        "coordinate_error": {
            "mean": round(float(coords.mean()), 8) if coords.size else None,
            "p50": round(float(np.percentile(coords, 50)), 8) if coords.size else None,
            "p95": round(float(np.percentile(coords, 95)), 8) if coords.size else None,
        },
        "score_error": {
            "mean": round(float(scores.mean()), 8) if scores.size else None,
            "p50": round(float(np.percentile(scores, 50)), 8) if scores.size else None,
            "p95": round(float(np.percentile(scores, 95)), 8) if scores.size else None,
        },
        "fp16_person_detected_coverage": _mean_scene_value(
            old_scenes.values(), "person_detected_coverage"
        ),
        "int8_person_detected_coverage": _mean_scene_value(
            new_scenes.values(), "person_detected_coverage"
        ),
        "fp16_inference_ms_average": _mean_scene_value(
            old_scenes.values(), "inference_ms_average"
        ),
        "int8_inference_ms_average": _mean_scene_value(
            new_scenes.values(), "inference_ms_average"
        ),
        "per_scene": per_scene,
        "claim_boundary": (
            "model-regression comparison against archived teacher outputs, "
            "not landmark ground truth"
        ),
    }


def _mean_scene_value(rows: Iterable[dict[str, Any]], key: str) -> float | None:
    values = [float(row[key]) for row in rows if isinstance(row.get(key), int | float)]
    return round(float(np.mean(values)), 8) if values else None


def run_pipeline(paths: Paths) -> dict[str, object]:
    if paths.output.exists() and any(paths.output.iterdir()):
        raise EdgeTrainingError(f"output directory already exists and is non-empty: {paths.output}")
    paths.output.mkdir(parents=True, exist_ok=True)
    started = time.time()
    print(f"[edge] output: {paths.output}", flush=True)

    print("[edge] downloading official MoveNet Lightning INT8 v4", flush=True)
    _download(OFFICIAL_MOVENET_INT8_URL, paths.int8_model)
    int8_audit = audit_tflite(paths.int8_model)
    fp16_audit = audit_tflite(paths.fp16_model)
    _json_write(paths.output / "audit/movenet-int8.json", int8_audit)
    _json_write(paths.output / "audit/movenet-fp16.json", fp16_audit)
    if not bool(int8_audit["all_conv_integer"]):
        raise EdgeTrainingError("official INT8 candidate does not have integer convolution tensors")

    print("[edge] building localized posture catalog", flush=True)
    build_local_pose_catalog(paths)
    catalog = DatasetCatalog.load(paths.pose_catalog, project_root=paths.root)

    print("[edge] extracting posture keypoints with INT8 MoveNet", flush=True)
    pose_index = extract_catalog(
        catalog,
        model_path=paths.int8_model,
        output_dir=paths.int8_pose_dataset,
        score_threshold=0.2,
        num_threads=4,
        resume=False,
    )
    _json_write(paths.output / "reports/pose-int8-extraction.json", pose_index)
    regression = compare_pose_datasets(paths)
    _json_write(paths.output / "reports/fp16-vs-int8-keypoints.json", regression)

    posture = run_posture_sweep(paths)
    localize_fall_manifest(paths)

    print("[edge] re-extracting fall samples with INT8 MoveNet", flush=True)
    fall_data = extract_fall_training_data(
        manifest_path=paths.localized_fall_manifest,
        movenet_model=paths.int8_model,
        posture_model=paths.posture_candidate / "model.json",
        output_dir=paths.fall_int8_data,
        sample_fps=12.0,
        score_threshold=0.2,
        num_threads=4,
    )
    _json_write(paths.output / "reports/fall-int8-extraction.json", fall_data)
    fall = run_fall_sweep(paths)

    manifest = {
        "schema_version": "reme-edge-int8-training-run/v0-experiment",
        "started_at_unix": started,
        "completed_at_unix": time.time(),
        "elapsed_seconds": round(time.time() - started, 3),
        "official_model_url": OFFICIAL_MOVENET_INT8_URL,
        "inputs": {
            "fp16_model": {
                "path": str(paths.fp16_model.resolve()),
                "sha256": _sha256(paths.fp16_model),
            },
            "old_pose_index": str(paths.old_pose_index.resolve()),
            "fall_manifest": str(paths.source_fall_manifest.resolve()),
            "fall_raw_video": {
                "path": str(paths.fall_raw_video.resolve()),
                "sha256": _sha256(paths.fall_raw_video),
            },
        },
        "outputs": {
            "int8_model": {
                "path": str(paths.int8_model.resolve()),
                "sha256": _sha256(paths.int8_model),
            },
            "int8_pose_index": str(
                (paths.int8_pose_dataset / "dataset-index.json").resolve()
            ),
            "posture_candidate": {
                "run_id": posture.run_id,
                "path": str((paths.posture_candidate / "model.json").resolve()),
                "validation_macro_f1": posture.validation_macro_f1,
                "validation_accuracy": posture.validation_accuracy,
            },
            "fall_candidate": {
                "run_id": fall.run_id,
                "path": str((paths.fall_candidate / "model.json").resolve()),
                "validation_score": fall.validation_score,
                "validation_positive_candidate_rate": (
                    fall.validation_positive_candidate_rate
                ),
                "validation_negative_alert_rate": fall.validation_negative_alert_rate,
            },
        },
        "preservation": {
            "models_trained_modified": False,
            "legacy_models_deleted": False,
            "frontend_modified": False,
        },
        "claim_boundary": {
            "posture": "weak-label validation only",
            "fall": "weak-bag selection only; no precision/recall/F1 claim",
            "int8": "teacher regression and runtime audit; no ground-truth landmark accuracy claim",
        },
    }
    _json_write(paths.output / "run-manifest.json", manifest)
    print(json.dumps(manifest, ensure_ascii=False, indent=2), flush=True)
    return manifest


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(
            f"artifacts/training/edge-int8/day1-{time.strftime('%Y%m%d-%H%M%S')}"
        ),
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    root = Path(__file__).resolve().parents[2]
    paths = Paths(root=root, output=(root / args.output_dir).resolve())
    try:
        run_pipeline(paths)
        return 0
    except (EdgeTrainingError, OSError, ValueError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
