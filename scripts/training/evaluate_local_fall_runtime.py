"""Replay local videos through the complete edge fall runtime without accuracy claims."""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from collections import Counter
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from reme.runtime.perception.edge_bundle import EdgePerceptionBundle
from reme.runtime.perception.fall_runtime import FallMILTransitionEnhancer
from reme.runtime.perception.movenet import MoveNetEstimator
from reme.runtime.perception.posture_runtime import (
    PostureRuntimeConfig,
    RealtimePostureTracker,
)
from reme.runtime.perception.runtime import RuntimeEvent, RuntimeEventType
from reme.runtime.perception.scene_bundle import FRAME_LANDMARKS_SCHEMA_VERSION

DEMO_MIN_HELDOUT_FALL_TRIGGER_RATE = 0.80
DEMO_MAX_HELDOUT_NORMAL_ALERT_RATE = 0.05
DEMO_MAX_HELDOUT_DUPLICATE_RATE = 0.05
HELDOUT_SPLITS = frozenset({"val", "test"})


class FallRuntimeEvaluationError(RuntimeError):
    """Raised when a local fall replay cannot be evaluated honestly."""


@dataclass(frozen=True, slots=True)
class VideoCase:
    case_id: str
    split: str
    label: str
    category: str
    video_path: Path
    start_ms: float
    end_ms: float


@dataclass(frozen=True, slots=True)
class CaseResult:
    case_id: str
    split: str
    label: str
    category: str
    sampled_frames: int
    person_detected_frames: int
    transition_counts: dict[str, int]
    fall_event_count: int
    fall_triggered: bool
    duplicate_fall_events: bool
    first_fall_event_end_ms: float | None
    fall_events: tuple[dict[str, Any], ...]
    elapsed_seconds: float
    mean_inference_ms: float
    p95_inference_ms: float


def _json_object(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise FallRuntimeEvaluationError(f"cannot read JSON {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise FallRuntimeEvaluationError(f"invalid JSON {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise FallRuntimeEvaluationError(f"JSON root must be an object: {path}")
    return payload


def load_fall_cases(manifest_path: Path) -> list[VideoCase]:
    manifest = _json_object(manifest_path)
    raw_video = manifest.get("raw_video")
    clips = manifest.get("clips")
    if not isinstance(raw_video, dict) or not isinstance(raw_video.get("path"), str):
        raise FallRuntimeEvaluationError("fall manifest raw_video.path is missing")
    if not isinstance(clips, list) or not clips:
        raise FallRuntimeEvaluationError("fall manifest clips must be a non-empty array")
    video_path = Path(raw_video["path"])
    cases: list[VideoCase] = []
    for index, clip in enumerate(clips):
        if not isinstance(clip, dict):
            raise FallRuntimeEvaluationError(f"clips[{index}] must be an object")
        cases.append(
            VideoCase(
                case_id=_text(clip.get("scene_id"), f"clips[{index}].scene_id"),
                split=_split(clip.get("split"), f"clips[{index}].split"),
                label="fall",
                category="fall_compilation",
                video_path=video_path,
                start_ms=_non_negative_number(
                    clip.get("start_ms"), f"clips[{index}].start_ms"
                ),
                end_ms=_positive_number(clip.get("end_ms"), f"clips[{index}].end_ms"),
            )
        )
    for case in cases:
        if case.end_ms <= case.start_ms:
            raise FallRuntimeEvaluationError(
                f"fall case {case.case_id!r} end_ms must exceed start_ms"
            )
    return cases


def load_normal_cases(index_path: Path) -> list[VideoCase]:
    index = _json_object(index_path)
    scenes = index.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise FallRuntimeEvaluationError("normal dataset scenes must be a non-empty array")
    cases: list[VideoCase] = []
    for scene_index, scene in enumerate(scenes):
        if not isinstance(scene, dict):
            raise FallRuntimeEvaluationError(f"scenes[{scene_index}] must be an object")
        case_id = _text(scene.get("scene_id"), f"scenes[{scene_index}].scene_id")
        source = Path(_text(scene.get("source"), f"scenes[{scene_index}].source"))
        duration_ms = _positive_number(
            scene.get("duration_ms"), f"scenes[{scene_index}].duration_ms"
        )
        cases.append(
            VideoCase(
                case_id=case_id,
                split=_split(scene.get("split"), f"scenes[{scene_index}].split"),
                label="normal",
                category=_normal_category(case_id),
                video_path=source,
                start_ms=0.0,
                end_ms=duration_ms,
            )
        )
    return cases


def _normal_category(case_id: str) -> str:
    lowered = case_id.lower()
    if "lying" in lowered:
        return "normal_lie_down"
    if "bending" in lowered or "crouching" in lowered:
        return "bend_or_crouch"
    if "sitting" in lowered:
        return "sit_or_stand"
    if "standing" in lowered:
        return "stable_standing"
    return "unusual_nonfall"


def replay_case(
    case: VideoCase,
    *,
    bundle: EdgePerceptionBundle,
    estimator: MoveNetEstimator,
    sample_fps: float,
) -> CaseResult:
    try:
        import cv2
    except ImportError as exc:
        raise FallRuntimeEvaluationError("opencv-python-headless is required") from exc

    if not case.video_path.is_file():
        raise FallRuntimeEvaluationError(f"video is missing: {case.video_path}")
    capture = cv2.VideoCapture(str(case.video_path))
    if not capture.isOpened():
        raise FallRuntimeEvaluationError(f"OpenCV could not open: {case.video_path}")
    source_fps = float(capture.get(cv2.CAP_PROP_FPS))
    if not math.isfinite(source_fps) or source_fps <= 0:
        capture.release()
        raise FallRuntimeEvaluationError(f"invalid FPS for {case.video_path}")
    sample_every = max(1, round(source_fps / sample_fps))
    start_frame = max(0, math.floor(case.start_ms * source_fps / 1000.0))
    end_frame = max(start_frame + 1, math.ceil(case.end_ms * source_fps / 1000.0))
    capture.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

    session_id = f"fall-eval-{case.case_id}"
    tracker = RealtimePostureTracker(
        session_id=session_id,
        predictor=bundle.posture_model,
        config=PostureRuntimeConfig(output_hz=7.5, score_threshold=0.2),
    )
    enhancer = FallMILTransitionEnhancer(
        session_id=session_id,
        model=bundle.fall_model,
        score_threshold=0.2,
    )
    estimator.reset()
    sampled_frames = 0
    detected_frames = 0
    inference_times: list[float] = []
    transition_events: list[dict[str, Any]] = []
    sequence = 0
    source_frame = start_frame
    started = time.perf_counter()
    try:
        while source_frame < end_frame:
            ok, frame = capture.read()
            if not ok:
                break
            if (source_frame - start_frame) % sample_every != 0:
                source_frame += 1
                continue
            result = estimator.infer(frame)
            timestamp_ms = (source_frame - start_frame) * 1000.0 / source_fps
            payload = {
                "schema_version": FRAME_LANDMARKS_SCHEMA_VERSION,
                "scene_id": case.case_id,
                "frame_index": sampled_frames,
                "timestamp_ms": round(timestamp_ms, 3),
                "person_detected": result.person_detected,
                "landmark_quality": result.landmark_quality,
                "coordinate_space": "normalized_image_top_left",
                "smoothed": False,
                "keypoints": [point.to_payload() for point in result.keypoints],
            }
            frame_event = RuntimeEvent(
                session_id=session_id,
                sequence=sequence,
                event_type=RuntimeEventType.FRAME_LANDMARKS,
                payload=payload,
            )
            sequence += 1
            posture_event = tracker.process_frame_event(frame_event)
            if posture_event is not None:
                enhancer.process_runtime_event(posture_event)
            transition_event = enhancer.process_runtime_event(frame_event)
            if transition_event is not None:
                transition_events.append(dict(transition_event.payload))
            sampled_frames += 1
            detected_frames += int(result.person_detected)
            inference_times.append(float(result.inference_ms))
            source_frame += 1
    finally:
        capture.release()
    elapsed = time.perf_counter() - started
    transition_counts = Counter(
        str(event.get("transition", "unknown")) for event in transition_events
    )
    fall_events = [
        event for event in transition_events if event.get("transition") == "fall_like_transition"
    ]
    return CaseResult(
        case_id=case.case_id,
        split=case.split,
        label=case.label,
        category=case.category,
        sampled_frames=sampled_frames,
        person_detected_frames=detected_frames,
        transition_counts=dict(sorted(transition_counts.items())),
        fall_event_count=len(fall_events),
        fall_triggered=bool(fall_events),
        duplicate_fall_events=len(fall_events) > 1,
        first_fall_event_end_ms=(
            float(fall_events[0]["end_ms"]) if fall_events else None
        ),
        fall_events=tuple(_fall_event_summary(event) for event in fall_events),
        elapsed_seconds=round(elapsed, 6),
        mean_inference_ms=round(_mean(inference_times), 6),
        p95_inference_ms=round(_percentile(inference_times, 95.0), 6),
    )


def _fall_event_summary(event: dict[str, Any]) -> dict[str, Any]:
    evidence = event.get("evidence")
    evidence_map = evidence if isinstance(evidence, dict) else {}
    fields = (
        "continuous_source",
        "continuous_model_probability",
        "deterministic_transition",
        "fall_mil_probability",
        "fall_mil_confirmed",
        "center_start",
        "center_drop",
        "max_downward_center_speed",
        "torso_end_deg",
        "torso_range_deg",
        "peak_motion_speed",
        "high_motion_ratio",
        "has_fallen_anchor",
        "reasons",
    )
    return {
        "event_id": event.get("event_id"),
        "start_ms": event.get("start_ms"),
        "end_ms": event.get("end_ms"),
        "transition_confidence": event.get("transition_confidence"),
        "evidence": {
            field: evidence_map[field]
            for field in fields
            if field in evidence_map
        },
    }


def summarize(results: Sequence[CaseResult]) -> dict[str, Any]:
    heldout = [result for result in results if result.split in HELDOUT_SPLITS]
    heldout_falls = [result for result in heldout if result.label == "fall"]
    heldout_normals = [result for result in heldout if result.label == "normal"]
    if not heldout_falls or not heldout_normals:
        raise FallRuntimeEvaluationError("held-out results require fall and normal cases")
    fall_trigger_rate = sum(result.fall_triggered for result in heldout_falls) / len(
        heldout_falls
    )
    normal_alert_rate = sum(result.fall_triggered for result in heldout_normals) / len(
        heldout_normals
    )
    duplicate_rate = sum(result.duplicate_fall_events for result in heldout) / len(heldout)
    stable_demo_gate = (
        fall_trigger_rate >= DEMO_MIN_HELDOUT_FALL_TRIGGER_RATE
        and normal_alert_rate <= DEMO_MAX_HELDOUT_NORMAL_ALERT_RATE
        and duplicate_rate <= DEMO_MAX_HELDOUT_DUPLICATE_RATE
    )
    return {
        "engineering_gate": {
            "minimum_heldout_fall_trigger_rate": DEMO_MIN_HELDOUT_FALL_TRIGGER_RATE,
            "maximum_heldout_normal_alert_rate": DEMO_MAX_HELDOUT_NORMAL_ALERT_RATE,
            "maximum_heldout_duplicate_rate": DEMO_MAX_HELDOUT_DUPLICATE_RATE,
            "passed": stable_demo_gate,
            "scope": "local demo stability only; not a medical or real-world accuracy standard",
        },
        "heldout": {
            "fall_case_count": len(heldout_falls),
            "normal_case_count": len(heldout_normals),
            "fall_triggered_cases": sum(result.fall_triggered for result in heldout_falls),
            "normal_alert_cases": sum(result.fall_triggered for result in heldout_normals),
            "duplicate_cases": sum(result.duplicate_fall_events for result in heldout),
            "fall_trigger_rate": round(fall_trigger_rate, 6),
            "normal_alert_rate": round(normal_alert_rate, 6),
            "duplicate_rate": round(duplicate_rate, 6),
        },
        "all_cases": {
            "fall_case_count": sum(result.label == "fall" for result in results),
            "normal_case_count": sum(result.label == "normal" for result in results),
            "fall_triggered_cases": sum(
                result.label == "fall" and result.fall_triggered for result in results
            ),
            "normal_alert_cases": sum(
                result.label == "normal" and result.fall_triggered for result in results
            ),
            "duplicate_cases": sum(result.duplicate_fall_events for result in results),
        },
    }


def evaluate(
    *,
    bundle_path: Path,
    fall_manifest_path: Path,
    normal_index_path: Path,
    output_path: Path,
    sample_fps: float,
    threads: int,
    splits: frozenset[str],
    case_ids: frozenset[str] | None = None,
) -> dict[str, Any]:
    if not math.isfinite(sample_fps) or sample_fps <= 0:
        raise FallRuntimeEvaluationError("sample_fps must be finite and positive")
    if threads < 1:
        raise FallRuntimeEvaluationError("threads must be positive")
    if output_path.exists():
        raise FallRuntimeEvaluationError(f"output already exists: {output_path}")
    bundle = EdgePerceptionBundle.load(bundle_path)
    cases = [
        case
        for case in [
            *load_fall_cases(fall_manifest_path),
            *load_normal_cases(normal_index_path),
        ]
        if case.split in splits and (case_ids is None or case.case_id in case_ids)
    ]
    if not cases:
        raise FallRuntimeEvaluationError("no cases matched the requested filters")
    estimator = MoveNetEstimator(
        bundle.pose_model_path,
        score_threshold=bundle.posture_model.score_threshold,
        num_threads=threads,
        warmup_runs=3,
    )
    results: list[CaseResult] = []
    started = time.perf_counter()
    for index, case in enumerate(cases, start=1):
        print(
            f"[fall-replay] {index}/{len(cases)} {case.split} {case.label} {case.case_id}",
            flush=True,
        )
        results.append(
            replay_case(
                case,
                bundle=bundle,
                estimator=estimator,
                sample_fps=sample_fps,
            )
        )
    report = {
        "schema_version": "reme-local-fall-runtime-evaluation/v1-experiment",
        "bundle": str(bundle_path.resolve()),
        "fall_manifest": str(fall_manifest_path.resolve()),
        "normal_index": str(normal_index_path.resolve()),
        "sample_fps": sample_fps,
        "threads": threads,
        "splits": sorted(splits),
        "elapsed_seconds": round(time.perf_counter() - started, 6),
        "summary": summarize(results),
        "cases": [asdict(result) for result in results],
        "raw_frames_persisted": False,
        "claim_boundary": (
            "local replay over archived weakly labelled videos; results are engineering evidence "
            "for this demo dataset, not clinical or real-world fall accuracy"
        ),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2), flush=True)
    return report


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _percentile(values: Sequence[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile / 100.0
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def _text(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise FallRuntimeEvaluationError(f"{field_name} must be a non-empty string")
    return value.strip()


def _split(value: object, field_name: str) -> str:
    split = _text(value, field_name)
    if split not in {"train", "val", "test"}:
        raise FallRuntimeEvaluationError(f"{field_name} has invalid split {split!r}")
    return split


def _non_negative_number(value: object, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise FallRuntimeEvaluationError(f"{field_name} must be numeric")
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise FallRuntimeEvaluationError(f"{field_name} must be finite and non-negative")
    return number


def _positive_number(value: object, field_name: str) -> float:
    number = _non_negative_number(value, field_name)
    if number <= 0:
        raise FallRuntimeEvaluationError(f"{field_name} must be positive")
    return number


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--fall-manifest", type=Path, required=True)
    parser.add_argument("--normal-index", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sample-fps", type=float, default=12.0)
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument(
        "--splits",
        nargs="+",
        choices=("train", "val", "test"),
        default=("val", "test"),
    )
    parser.add_argument(
        "--case-id",
        action="append",
        dest="case_ids",
        help="restrict replay to one or more case IDs for targeted debugging",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        report = evaluate(
            bundle_path=args.bundle.resolve(),
            fall_manifest_path=args.fall_manifest.resolve(),
            normal_index_path=args.normal_index.resolve(),
            output_path=args.output.resolve(),
            sample_fps=args.sample_fps,
            threads=args.threads,
            splits=frozenset(args.splits),
            case_ids=(frozenset(args.case_ids) if args.case_ids else None),
        )
        return 0 if report["summary"]["engineering_gate"]["passed"] else 1
    except (FallRuntimeEvaluationError, OSError, ValueError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
