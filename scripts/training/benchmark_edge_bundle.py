"""Benchmark an edge bundle under an explicit simulated INT8 TOPS budget."""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from reme.runtime.perception.edge_bundle import EdgePerceptionBundle
from reme.runtime.perception.movenet import MoveNetEstimator

POSE_ESTIMATED_OPS = 541_099_008
OPS_PER_TOPS = 1_000_000_000_000


class EdgeBenchmarkError(RuntimeError):
    """Raised when the simulated edge benchmark cannot run."""


@dataclass(frozen=True, slots=True)
class ComputeBudget:
    """One theoretical fixed-throughput compute budget."""

    tops: float
    effective_utilization: float
    ops_per_inference: int = POSE_ESTIMATED_OPS

    def __post_init__(self) -> None:
        if not math.isfinite(self.tops) or self.tops <= 0:
            raise EdgeBenchmarkError("tops must be finite and positive")
        if not math.isfinite(self.effective_utilization) or not (
            0.0 < self.effective_utilization <= 1.0
        ):
            raise EdgeBenchmarkError("effective_utilization must be in (0, 1]")
        if self.ops_per_inference < 1:
            raise EdgeBenchmarkError("ops_per_inference must be positive")

    @property
    def effective_ops_per_second(self) -> float:
        return self.tops * OPS_PER_TOPS * self.effective_utilization

    @property
    def service_time_seconds(self) -> float:
        return self.ops_per_inference / self.effective_ops_per_second

    @property
    def theoretical_max_fps(self) -> float:
        return 1.0 / self.service_time_seconds

    def throttle(self, elapsed_seconds: float) -> float:
        """Sleep until one inference consumes at least its theoretical service time."""

        wait_seconds = max(self.service_time_seconds - elapsed_seconds, 0.0)
        if wait_seconds:
            time.sleep(wait_seconds)
        return wait_seconds


def _percentiles(values: list[float]) -> dict[str, float]:
    if not values:
        raise EdgeBenchmarkError("cannot summarize an empty metric series")
    array = np.asarray(values, dtype=np.float64)
    return {
        "mean": round(float(array.mean()), 6),
        "p50": round(float(np.percentile(array, 50)), 6),
        "p95": round(float(np.percentile(array, 95)), 6),
        "max": round(float(array.max()), 6),
    }


def _json_write(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def benchmark(
    *,
    bundle_path: Path,
    video_path: Path,
    target_fps: float,
    max_frames: int,
    threads: int,
    budget: ComputeBudget,
) -> dict[str, object]:
    if not math.isfinite(target_fps) or target_fps <= 0:
        raise EdgeBenchmarkError("target_fps must be finite and positive")
    if max_frames < 1:
        raise EdgeBenchmarkError("max_frames must be positive")
    if threads < 1:
        raise EdgeBenchmarkError("threads must be positive")
    if not video_path.is_file():
        raise EdgeBenchmarkError(f"video is missing: {video_path}")

    try:
        import cv2
    except ImportError as exc:
        raise EdgeBenchmarkError("opencv-python-headless is required") from exc

    bundle = EdgePerceptionBundle.load(bundle_path)
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise EdgeBenchmarkError(f"OpenCV could not open video: {video_path}")
    source_fps = float(capture.get(cv2.CAP_PROP_FPS))
    if source_fps <= 0:
        capture.release()
        raise EdgeBenchmarkError("video reports invalid FPS")
    sample_every = max(1, round(source_fps / target_fps))
    effective_sample_fps = source_fps / sample_every
    estimator = MoveNetEstimator(
        bundle.pose_model_path,
        score_threshold=bundle.posture_model.score_threshold,
        num_threads=threads,
        warmup_runs=3,
    )
    estimator.reset()

    inference_ms: list[float] = []
    processing_ms: list[float] = []
    simulated_service_ms: list[float] = []
    wait_ms: list[float] = []
    posture_counts: Counter[str] = Counter()
    quality_counts: Counter[str] = Counter()
    detected_frames = 0
    decoded_frames = 0
    sampled_frames = 0
    budget_overrun_frames = 0
    started = time.perf_counter()
    try:
        while sampled_frames < max_frames:
            ok, frame = capture.read()
            if not ok:
                break
            frame_index = decoded_frames
            decoded_frames += 1
            if frame_index % sample_every != 0:
                continue
            frame_started = time.perf_counter()
            result = estimator.infer(frame)
            record: dict[str, Any] = {
                "person_detected": result.person_detected,
                "keypoints": [keypoint.to_payload() for keypoint in result.keypoints],
            }
            prediction = bundle.posture_model.predict_record(record)
            processing_seconds = time.perf_counter() - frame_started
            wait_seconds = budget.throttle(processing_seconds)
            service_seconds = processing_seconds + wait_seconds
            if processing_seconds > budget.service_time_seconds:
                budget_overrun_frames += 1
            inference_ms.append(result.inference_ms)
            processing_ms.append(processing_seconds * 1000.0)
            wait_ms.append(wait_seconds * 1000.0)
            simulated_service_ms.append(service_seconds * 1000.0)
            posture_counts[prediction.posture] += 1
            quality_counts[result.landmark_quality] += 1
            detected_frames += int(result.person_detected)
            sampled_frames += 1
    finally:
        capture.release()
    elapsed_seconds = time.perf_counter() - started
    if sampled_frames < 1:
        raise EdgeBenchmarkError("video produced no sampled frames")

    target_frame_interval_ms = 1000.0 / target_fps
    service_metrics = _percentiles(simulated_service_ms)
    measured_pipeline_fps = sampled_frames / elapsed_seconds
    target_fps_passed = (
        budget.theoretical_max_fps >= target_fps
        and service_metrics["p95"] <= target_frame_interval_ms
        and measured_pipeline_fps >= target_fps
    )
    return {
        "schema_version": "reme-edge-budget-benchmark/v1-experiment",
        "bundle": str(bundle_path.resolve()),
        "video": str(video_path.resolve()),
        "source_fps": round(source_fps, 6),
        "target_fps": target_fps,
        "sample_every": sample_every,
        "effective_sample_fps": round(effective_sample_fps, 6),
        "sampled_frames": sampled_frames,
        "decoded_frames": decoded_frames,
        "elapsed_seconds": round(elapsed_seconds, 6),
        "unpaced_pipeline_fps_including_budget": round(measured_pipeline_fps, 6),
        "budget": {
            "tops": budget.tops,
            "effective_utilization": budget.effective_utilization,
            "effective_ops_per_second": round(budget.effective_ops_per_second, 3),
            "ops_per_inference": budget.ops_per_inference,
            "service_time_ms": round(budget.service_time_seconds * 1000.0, 6),
            "theoretical_max_fps": round(budget.theoretical_max_fps, 6),
            "processing_over_budget_frames": budget_overrun_frames,
        },
        "metrics_ms": {
            "interpreter_inference": _percentiles(inference_ms),
            "pose_plus_posture_processing": _percentiles(processing_ms),
            "simulated_budget_wait": _percentiles(wait_ms),
            "simulated_service": service_metrics,
        },
        "person_detected_coverage": round(detected_frames / sampled_frames, 6),
        "landmark_quality_counts": dict(sorted(quality_counts.items())),
        "posture_counts": dict(sorted(posture_counts.items())),
        "target_frame_interval_ms": round(target_frame_interval_ms, 6),
        "target_fps_passed": target_fps_passed,
        "head_tracking_proxy": bundle.manifest["head_tracking"]["proxy_keypoint"],
        "raw_frames_persisted": False,
        "claim_boundary": (
            "software timing plus theoretical TOPS service throttling; not a target NPU "
            "compiler, power, thermal or silicon benchmark"
        ),
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--target-fps", type=float, default=30.0)
    parser.add_argument("--max-frames", type=int, default=300)
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--tops", type=float, default=1.0)
    parser.add_argument("--effective-utilization", type=float, default=0.1)
    parser.add_argument("--output", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    root = Path(__file__).resolve().parents[2]
    try:
        report = benchmark(
            bundle_path=(root / args.bundle).resolve(),
            video_path=(root / args.video).resolve(),
            target_fps=args.target_fps,
            max_frames=args.max_frames,
            threads=args.threads,
            budget=ComputeBudget(
                tops=args.tops,
                effective_utilization=args.effective_utilization,
            ),
        )
        if args.output is not None:
            _json_write((root / args.output).resolve(), report)
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
        return 0 if bool(report["target_fps_passed"]) else 1
    except (EdgeBenchmarkError, OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
