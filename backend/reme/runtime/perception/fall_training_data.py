"""Extract pose samples and weak fall candidates from one segmented compilation."""

from __future__ import annotations

import argparse
import json
import math
import time
from collections import Counter
from collections.abc import Sequence
from pathlib import Path
from statistics import median
from typing import Any

from reme.pose.fall_bootstrap import FALL_BOOTSTRAP_SCHEMA_VERSION
from reme.pose.fall_weak_labels import FallPoseSample, infer_weak_fall_candidate
from reme.pose.movenet import MoveNetEstimator
from reme.pose.posture import PosturePrediction, StaticPostureModel
from reme.pose.scene_bundle import FRAME_LANDMARKS_SCHEMA_VERSION

FALL_TRAINING_DATA_SCHEMA_VERSION = "reme-fall-training-data/v0-experiment"
_SHOULDERS = ("left_shoulder", "right_shoulder")
_HIPS = ("left_hip", "right_hip")


class FallTrainingDataError(ValueError):
    """Raised when fall training data cannot be extracted safely."""


def derive_fall_pose_sample(
    frame_record: dict[str, object],
    *,
    prediction: PosturePrediction,
    previous_record: dict[str, object] | None,
    score_threshold: float,
) -> FallPoseSample:
    """Derive temporal geometry from one FrameLandmarks-shaped record."""

    if not 0.0 <= score_threshold <= 1.0:
        raise FallTrainingDataError("score_threshold must be between 0 and 1")
    timestamp_ms = _number(frame_record.get("timestamp_ms"), "timestamp_ms")
    points = _visible_points(frame_record, score_threshold=score_threshold)
    if points:
        xs = [point[0] for point in points.values()]
        ys = [point[1] for point in points.values()]
        width = max(xs) - min(xs)
        height = max(ys) - min(ys)
        center_y = (min(ys) + max(ys)) * 0.5
        aspect_ratio = width / max(height, 1e-6)
    else:
        center_y = 0.0
        aspect_ratio = 0.0
    torso_angle = _torso_angle_deg(points)
    motion_speed = _motion_speed(
        previous_record,
        frame_record,
        score_threshold=score_threshold,
    )
    quality = frame_record.get("landmark_quality")
    if quality not in {"usable", "degraded", "unavailable"}:
        raise FallTrainingDataError("landmark_quality is invalid")
    return FallPoseSample(
        timestamp_ms=timestamp_ms,
        posture=prediction.posture,
        posture_confidence=prediction.confidence,
        center_y=center_y,
        torso_angle_deg=torso_angle,
        bbox_aspect_ratio=aspect_ratio,
        motion_speed=motion_speed,
        visible_keypoint_ratio=prediction.visible_keypoint_ratio,
        landmark_quality=str(quality),
    )


def extract_fall_training_data(
    *,
    manifest_path: str | Path,
    movenet_model: str | Path,
    posture_model: str | Path,
    output_dir: str | Path,
    sample_fps: float = 12.0,
    score_threshold: float = 0.2,
    num_threads: int = 4,
) -> dict[str, object]:
    """Extract one-pass MoveNet samples and infer one weak candidate per clip."""

    if not math.isfinite(sample_fps) or sample_fps <= 0:
        raise FallTrainingDataError("sample_fps must be finite and positive")
    if not 0.0 <= score_threshold <= 1.0:
        raise FallTrainingDataError("score_threshold must be between 0 and 1")
    if num_threads < 1:
        raise FallTrainingDataError("num_threads must be positive")

    manifest = _load_manifest(manifest_path)
    raw_video = Path(_mapping_text(manifest, "raw_video", "path")).resolve()
    if not raw_video.is_file():
        raise FallTrainingDataError(f"raw video is missing: {raw_video}")
    clips = _clip_rows(manifest)
    destination = Path(output_dir).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    samples_path = destination / "pose-samples.jsonl"
    report_path = destination / "weak-candidates.json"

    cv2 = _load_cv2()
    capture = cv2.VideoCapture(str(raw_video))
    if not capture.isOpened():
        raise FallTrainingDataError(f"OpenCV could not open raw video: {raw_video}")
    source_fps = float(capture.get(cv2.CAP_PROP_FPS))
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    if source_fps <= 0 or frame_count <= 0:
        capture.release()
        raise FallTrainingDataError("raw video reports invalid FPS or frame count")
    sample_every = max(1, round(source_fps / sample_fps))

    estimator = MoveNetEstimator(
        movenet_model,
        score_threshold=score_threshold,
        num_threads=num_threads,
    )
    estimator.reset()
    predictor = StaticPostureModel.load(posture_model)
    samples_by_clip: dict[int, list[FallPoseSample]] = {
        index: [] for index in range(len(clips))
    }
    previous_record_by_clip: dict[int, dict[str, object]] = {}
    sampled_frames = 0
    detected_frames = 0
    inference_total_ms = 0.0
    clip_index = 0
    decoded_frame_index = 0
    started = time.perf_counter()

    try:
        with samples_path.open("w", encoding="utf-8") as target:
            while True:
                ok, frame = capture.read()
                if not ok:
                    break
                source_frame_index = decoded_frame_index
                decoded_frame_index += 1
                timestamp_ms = source_frame_index / source_fps * 1000.0
                while (
                    clip_index < len(clips) - 1
                    and timestamp_ms >= _clip_number(clips[clip_index], "end_ms")
                ):
                    clip_index += 1
                if source_frame_index % sample_every != 0:
                    continue
                clip = clips[clip_index]
                if timestamp_ms < _clip_number(clip, "start_ms"):
                    continue

                result = estimator.infer(frame)
                frame_record: dict[str, object] = {
                    "schema_version": FRAME_LANDMARKS_SCHEMA_VERSION,
                    "scene_id": _clip_text(clip, "scene_id"),
                    "frame_index": source_frame_index,
                    "timestamp_ms": round(timestamp_ms, 3),
                    "person_detected": result.person_detected,
                    "landmark_quality": result.landmark_quality,
                    "coordinate_space": "normalized_image_top_left",
                    "smoothed": False,
                    "keypoints": [
                        keypoint.to_payload() for keypoint in result.keypoints
                    ],
                }
                prediction = predictor.predict_record(frame_record)
                pose_sample = derive_fall_pose_sample(
                    frame_record,
                    prediction=prediction,
                    previous_record=previous_record_by_clip.get(clip_index),
                    score_threshold=score_threshold,
                )
                previous_record_by_clip[clip_index] = frame_record
                samples_by_clip[clip_index].append(pose_sample)
                target.write(
                    json.dumps(
                        {
                            "schema_version": FALL_TRAINING_DATA_SCHEMA_VERSION,
                            "clip_index": clip_index,
                            "scene_id": _clip_text(clip, "scene_id"),
                            "split": _clip_text(clip, "split"),
                            "source_frame_index": source_frame_index,
                            **pose_sample.to_payload(),
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                sampled_frames += 1
                detected_frames += int(result.person_detected)
                inference_total_ms += result.inference_ms
    finally:
        capture.release()

    candidates = tuple(
        infer_weak_fall_candidate(
            samples_by_clip[index],
            clip_id=_clip_text(clips[index], "scene_id"),
        )
        for index in range(len(clips))
    )
    status_counts = Counter(candidate.status for candidate in candidates)
    reason_counts = Counter(
        reason for candidate in candidates for reason in candidate.reasons
    )
    report: dict[str, object] = {
        "schema_version": FALL_TRAINING_DATA_SCHEMA_VERSION,
        "evidence_level": "weak_supervision_bootstrap",
        "manifest": str(Path(manifest_path).resolve()),
        "raw_video": str(raw_video),
        "training_pixel_source": "raw_video_only",
        "marked_video_used_for_training": False,
        "sample_fps_requested": sample_fps,
        "source_fps": round(source_fps, 6),
        "sample_every": sample_every,
        "sampled_frames": sampled_frames,
        "person_detected_frames": detected_frames,
        "person_detected_coverage": (
            round(detected_frames / sampled_frames, 6) if sampled_frames else 0.0
        ),
        "inference_ms_average": (
            round(inference_total_ms / sampled_frames, 3)
            if sampled_frames
            else None
        ),
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "clip_count": len(clips),
        "status_counts": dict(sorted(status_counts.items())),
        "reason_counts": dict(sorted(reason_counts.items())),
        "samples_path": str(samples_path),
        "raw_frames_persisted": False,
        "accuracy_report_allowed": False,
        "candidates": [candidate.to_payload() for candidate in candidates],
    }
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return report


def _visible_points(
    record: dict[str, object],
    *,
    score_threshold: float,
) -> dict[str, tuple[float, float]]:
    raw = record.get("keypoints")
    if not isinstance(raw, list):
        raise FallTrainingDataError("keypoints must be an array")
    points: dict[str, tuple[float, float]] = {}
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise FallTrainingDataError(f"keypoints[{index}] must be an object")
        name = item.get("name")
        if not isinstance(name, str) or not name:
            raise FallTrainingDataError(f"keypoints[{index}].name must be non-empty")
        score = _number(item.get("score"), f"keypoints[{index}].score")
        if score < score_threshold:
            continue
        x_norm = _number(item.get("x_norm"), f"keypoints[{index}].x_norm")
        y_norm = _number(item.get("y_norm"), f"keypoints[{index}].y_norm")
        if not 0.0 <= x_norm <= 1.0 or not 0.0 <= y_norm <= 1.0:
            raise FallTrainingDataError("normalized keypoint coordinates must be in [0, 1]")
        points[name] = (x_norm, y_norm)
    return points


def _torso_angle_deg(points: dict[str, tuple[float, float]]) -> float:
    shoulder = _midpoint(points, _SHOULDERS)
    hip = _midpoint(points, _HIPS)
    if shoulder is None or hip is None:
        return 0.0
    dx = hip[0] - shoulder[0]
    dy = hip[1] - shoulder[1]
    if abs(dx) + abs(dy) < 1e-9:
        return 0.0
    return math.degrees(math.atan2(abs(dx), abs(dy)))


def _midpoint(
    points: dict[str, tuple[float, float]],
    names: tuple[str, str],
) -> tuple[float, float] | None:
    if names[0] not in points or names[1] not in points:
        return None
    first = points[names[0]]
    second = points[names[1]]
    return ((first[0] + second[0]) * 0.5, (first[1] + second[1]) * 0.5)


def _motion_speed(
    previous: dict[str, object] | None,
    current: dict[str, object],
    *,
    score_threshold: float,
) -> float:
    if previous is None:
        return 0.0
    previous_time = _number(previous.get("timestamp_ms"), "previous.timestamp_ms")
    current_time = _number(current.get("timestamp_ms"), "current.timestamp_ms")
    elapsed_seconds = (current_time - previous_time) / 1000.0
    if elapsed_seconds <= 0:
        return 0.0
    previous_points = _visible_points(previous, score_threshold=score_threshold)
    current_points = _visible_points(current, score_threshold=score_threshold)
    common = sorted(previous_points.keys() & current_points.keys())
    if len(common) < 4:
        return 0.0
    displacements = [
        math.dist(previous_points[name], current_points[name]) / elapsed_seconds
        for name in common
    ]
    return float(median(displacements))


def _load_manifest(path: str | Path) -> dict[str, object]:
    source = Path(path)
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except OSError as exc:
        raise FallTrainingDataError(f"cannot read fall manifest: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise FallTrainingDataError(f"fall manifest is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise FallTrainingDataError("fall manifest must be an object")
    if payload.get("schema_version") != FALL_BOOTSTRAP_SCHEMA_VERSION:
        raise FallTrainingDataError("unsupported fall manifest schema_version")
    return payload


def _clip_rows(manifest: dict[str, object]) -> list[dict[str, object]]:
    raw = manifest.get("clips")
    if not isinstance(raw, list) or not raw:
        raise FallTrainingDataError("fall manifest clips must be a non-empty array")
    clips: list[dict[str, object]] = []
    previous_end = 0.0
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise FallTrainingDataError(f"clips[{index}] must be an object")
        start = _clip_number(item, "start_ms")
        end = _clip_number(item, "end_ms")
        if abs(start - previous_end) > 1e-3 or end <= start:
            raise FallTrainingDataError("fall manifest clips must be ordered and contiguous")
        previous_end = end
        clips.append(item)
    return clips


def _mapping_text(
    payload: dict[str, object],
    mapping_name: str,
    field_name: str,
) -> str:
    mapping = payload.get(mapping_name)
    if not isinstance(mapping, dict):
        raise FallTrainingDataError(f"{mapping_name} must be an object")
    value = mapping.get(field_name)
    if not isinstance(value, str) or not value:
        raise FallTrainingDataError(f"{mapping_name}.{field_name} must be non-empty")
    return value


def _clip_text(clip: dict[str, object], field_name: str) -> str:
    value = clip.get(field_name)
    if not isinstance(value, str) or not value:
        raise FallTrainingDataError(f"clip {field_name} must be non-empty")
    return value


def _clip_number(clip: dict[str, object], field_name: str) -> float:
    return _number(clip.get(field_name), f"clip.{field_name}")


def _number(value: object, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise FallTrainingDataError(f"{field_name} must be numeric")
    number = float(value)
    if not math.isfinite(number):
        raise FallTrainingDataError(f"{field_name} must be finite")
    return number


def _load_cv2() -> Any:
    try:
        import cv2
    except ImportError as exc:
        raise FallTrainingDataError("opencv-python-headless is required") from exc
    return cv2


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--movenet-model", type=Path, required=True)
    parser.add_argument("--posture-model", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--sample-fps", type=float, default=12.0)
    parser.add_argument("--score-threshold", type=float, default=0.2)
    parser.add_argument("--num-threads", type=int, default=4)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Extract pose samples and weak fall candidates."""

    args = _build_parser().parse_args(argv)
    report = extract_fall_training_data(
        manifest_path=args.manifest,
        movenet_model=args.movenet_model,
        posture_model=args.posture_model,
        output_dir=args.output_dir,
        sample_fps=args.sample_fps,
        score_threshold=args.score_threshold,
        num_threads=args.num_threads,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
