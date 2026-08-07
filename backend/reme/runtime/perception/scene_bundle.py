"""Validation and packaging helpers for demo scene bundles."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCENE_SCHEMA_VERSION = "reme-scene/v0-experiment"
FRAME_LANDMARKS_SCHEMA_VERSION = "movenet-17/v0-experiment"
MOVENET_KEYPOINT_NAMES = (
    "nose",
    "left_eye",
    "right_eye",
    "left_ear",
    "right_ear",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
)
CORE_KEYPOINT_NAMES = {
    "left_shoulder",
    "right_shoulder",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
}


class SceneBundleError(ValueError):
    """Raised when a scene bundle violates the shared A/B/C interface."""


@dataclass(frozen=True, slots=True)
class SceneManifest:
    """Validated manifest data and the directory it is relative to."""

    path: Path
    data: dict[str, Any]

    def resolve_media_path(self) -> Path:
        """Resolve the manifest's local media reference."""

        return _resolve_local_reference(self.path.parent, self.data["media"]["local_path"])

    def resolve_stream_path(self, stream_name: str) -> Path | None:
        """Resolve one optional stream reference from the manifest."""

        streams = self.data["streams"]
        if stream_name not in streams:
            raise SceneBundleError(f"unknown stream {stream_name!r}")
        reference = streams[stream_name]
        if reference is None:
            return None
        return _resolve_local_reference(self.path.parent, reference)


@dataclass(frozen=True, slots=True)
class FrameLandmarksSummary:
    """Summary returned after a full JSONL validation pass."""

    record_count: int
    first_timestamp_ms: float
    last_timestamp_ms: float


def load_scene_manifest(path: str | Path) -> SceneManifest:
    """Load a scene manifest and reject unsupported interface versions."""

    manifest_path = Path(path)
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SceneBundleError(f"cannot read scene manifest: {exc}") from exc

    if not isinstance(data, dict):
        raise SceneBundleError("scene manifest must be a JSON object")
    if data.get("schema_version") != SCENE_SCHEMA_VERSION:
        raise SceneBundleError(
            f"schema_version must be {SCENE_SCHEMA_VERSION!r}, "
            f"got {data.get('schema_version')!r}"
        )
    if not isinstance(data.get("scene_id"), str) or not data["scene_id"]:
        raise SceneBundleError("scene_id must be a non-empty string")
    _validate_manifest_media(data.get("media"))
    _validate_manifest_streams(data.get("streams"))

    return SceneManifest(path=manifest_path, data=data)


def build_scene_bundle(
    *,
    scene_id: str,
    title: str,
    video_path: str | Path,
    legacy_keypoints_path: str | Path,
    skeleton_video_path: str | Path,
    run_summary_path: str | Path,
    output_dir: str | Path,
    demo_time_scale: float = 1.0,
) -> Path:
    """Build a self-contained v0 experiment scene bundle from MoveNet outputs."""

    source_video = Path(video_path)
    source_keypoints = Path(legacy_keypoints_path)
    source_skeleton = Path(skeleton_video_path)
    source_summary = Path(run_summary_path)
    destination = Path(output_dir)

    if not scene_id:
        raise SceneBundleError("scene_id must be non-empty")
    if (
        isinstance(demo_time_scale, bool)
        or not isinstance(demo_time_scale, int | float)
        or demo_time_scale <= 0
    ):
        raise SceneBundleError("demo_time_scale must be a positive number")
    for source in (source_video, source_keypoints, source_skeleton, source_summary):
        if not source.is_file():
            raise SceneBundleError(f"required source file does not exist: {source}")

    try:
        summary = json.loads(source_summary.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SceneBundleError(f"cannot read MoveNet summary: {exc}") from exc

    video_metadata = _video_metadata_from_summary(summary)
    score_threshold = _score_threshold_from_summary(summary)
    destination_media = destination / "media" / "source.mp4"
    destination_skeleton = destination / "derived" / "skeleton.mp4"
    destination_summary = destination / "derived" / "extraction_summary.json"
    destination_keypoints = destination / "keypoints_2d.jsonl"
    for directory in (destination_media.parent, destination_skeleton.parent):
        directory.mkdir(parents=True, exist_ok=True)

    shutil.copy2(source_video, destination_media)
    shutil.copy2(source_skeleton, destination_skeleton)
    shutil.copy2(source_summary, destination_summary)
    _convert_legacy_keypoints(
        source_keypoints,
        destination_keypoints,
        scene_id=scene_id,
        score_threshold=score_threshold,
    )

    manifest_data: dict[str, Any] = {
        "schema_version": SCENE_SCHEMA_VERSION,
        "scene_id": scene_id,
        "title": title,
        "media": {
            "local_path": "media/source.mp4",
            "source_type": "prerecorded_video",
            "sha256": _sha256_file(destination_media),
            **video_metadata,
            "demo_time_scale": float(demo_time_scale),
        },
        "streams": {
            "keypoints_2d": "keypoints_2d.jsonl",
            "keypoints_3d": None,
            "posture_observations": None,
            "transition_events": None,
            "recorded_decisions": None,
        },
        "diagnostics": {
            "skeleton_video": "derived/skeleton.mp4",
            "extraction_summary": "derived/extraction_summary.json",
        },
        "extraction": {
            "model": "MoveNet SinglePose Lightning FP16 v4",
            "score_threshold": score_threshold,
            "preprocessing": summary.get("sampling", {}).get("preprocessing"),
            "raw_frames_written": summary.get("privacy_boundary", {}).get(
                "raw_frames_written"
            ),
            "raw_frames_uploaded": summary.get("privacy_boundary", {}).get(
                "raw_frames_uploaded"
            ),
        },
    }
    manifest_path = destination / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest_data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    manifest = load_scene_manifest(manifest_path)
    keypoints_reference = manifest.resolve_stream_path("keypoints_2d")
    if keypoints_reference is None:
        raise SceneBundleError("generated manifest is missing keypoints_2d")
    keypoint_summary = validate_frame_landmarks_jsonl(
        keypoints_reference, expected_scene_id=scene_id
    )
    if keypoint_summary.record_count != video_metadata["frame_count"]:
        raise SceneBundleError(
            "keypoint record count does not match manifest frame_count: "
            f"{keypoint_summary.record_count} != {video_metadata['frame_count']}"
        )

    return manifest_path


def validate_frame_landmarks_jsonl(
    path: str | Path, *, expected_scene_id: str
) -> FrameLandmarksSummary:
    """Validate an ordered MoveNet FrameLandmarks JSONL stream."""

    keypoints_path = Path(path)
    previous_timestamp: float | None = None
    first_timestamp: float | None = None
    record_count = 0

    try:
        lines = keypoints_path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise SceneBundleError(f"cannot read frame landmarks: {exc}") from exc

    for line_number, raw_line in enumerate(lines, start=1):
        if not raw_line.strip():
            continue
        try:
            record = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            raise SceneBundleError(f"invalid JSON on line {line_number}: {exc}") from exc

        if record.get("schema_version") != FRAME_LANDMARKS_SCHEMA_VERSION:
            raise SceneBundleError(
                f"line {line_number}: schema_version must be "
                f"{FRAME_LANDMARKS_SCHEMA_VERSION!r}"
            )
        if record.get("scene_id") != expected_scene_id:
            raise SceneBundleError(
                f"line {line_number}: scene_id must be {expected_scene_id!r}"
            )

        timestamp = record.get("timestamp_ms")
        if not isinstance(timestamp, int | float) or isinstance(timestamp, bool) or timestamp < 0:
            raise SceneBundleError(f"line {line_number}: timestamp_ms must be non-negative")
        timestamp_float = float(timestamp)
        if previous_timestamp is not None and timestamp_float <= previous_timestamp:
            raise SceneBundleError(
                f"line {line_number}: timestamp_ms must be strictly increasing"
            )

        keypoints = record.get("keypoints")
        if not isinstance(keypoints, list) or len(keypoints) != len(MOVENET_KEYPOINT_NAMES):
            raise SceneBundleError(
                f"line {line_number}: keypoints must contain the 17 MoveNet keypoints"
            )
        names = tuple(
            point.get("name") if isinstance(point, dict) else None for point in keypoints
        )
        if names != MOVENET_KEYPOINT_NAMES:
            raise SceneBundleError(
                f"line {line_number}: keypoints must contain the 17 MoveNet keypoints "
                "in canonical order"
            )

        for point in keypoints:
            _validate_keypoint(point, line_number=line_number)

        if first_timestamp is None:
            first_timestamp = timestamp_float
        previous_timestamp = timestamp_float
        record_count += 1

    if record_count == 0 or first_timestamp is None or previous_timestamp is None:
        raise SceneBundleError("frame landmarks JSONL must contain at least one record")

    return FrameLandmarksSummary(
        record_count=record_count,
        first_timestamp_ms=first_timestamp,
        last_timestamp_ms=previous_timestamp,
    )


def _convert_legacy_keypoints(
    source_path: Path,
    destination_path: Path,
    *,
    scene_id: str,
    score_threshold: float,
) -> None:
    output_lines: list[str] = []
    try:
        lines = source_path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise SceneBundleError(f"cannot read legacy MoveNet keypoints: {exc}") from exc

    for line_number, raw_line in enumerate(lines, start=1):
        if not raw_line.strip():
            continue
        try:
            legacy = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            raise SceneBundleError(
                f"invalid legacy keypoint JSON on line {line_number}: {exc}"
            ) from exc
        if legacy.get("schema") != FRAME_LANDMARKS_SCHEMA_VERSION:
            raise SceneBundleError(
                f"line {line_number}: unsupported legacy keypoint schema"
            )
        torso_detected = legacy.get("torso_detected")
        if not isinstance(torso_detected, bool):
            raise SceneBundleError(f"line {line_number}: torso_detected must be boolean")

        keypoints = legacy.get("keypoints")
        if not isinstance(keypoints, list):
            raise SceneBundleError(f"line {line_number}: keypoints must be a list")
        converted = {
            "schema_version": FRAME_LANDMARKS_SCHEMA_VERSION,
            "scene_id": scene_id,
            "frame_index": legacy.get("frame_index"),
            "timestamp_ms": legacy.get("timestamp_ms"),
            "person_detected": torso_detected,
            "landmark_quality": _derive_landmark_quality(
                keypoints,
                torso_detected=torso_detected,
                score_threshold=score_threshold,
            ),
            "coordinate_space": "normalized_image_top_left",
            "smoothed": False,
            "keypoints": keypoints,
        }
        output_lines.append(json.dumps(converted, ensure_ascii=False, separators=(",", ":")))

    destination_path.write_text("\n".join(output_lines) + "\n", encoding="utf-8")


def _derive_landmark_quality(
    keypoints: list[object], *, torso_detected: bool, score_threshold: float
) -> str:
    if not torso_detected:
        return "unavailable"

    scores: dict[str, float] = {}
    for point in keypoints:
        if not isinstance(point, dict):
            continue
        name = point.get("name")
        score = point.get("score")
        if isinstance(name, str) and isinstance(score, int | float) and not isinstance(score, bool):
            scores[name] = float(score)

    if all(scores.get(name, -1.0) >= score_threshold for name in CORE_KEYPOINT_NAMES):
        return "usable"
    return "degraded"


def _score_threshold_from_summary(summary: dict[str, Any]) -> float:
    sampling = summary.get("sampling")
    if not isinstance(sampling, dict):
        raise SceneBundleError("MoveNet summary must contain a sampling object")
    threshold = sampling.get("score_threshold")
    if (
        not isinstance(threshold, int | float)
        or isinstance(threshold, bool)
        or not 0.0 <= threshold <= 1.0
    ):
        raise SceneBundleError("MoveNet summary score_threshold must be between 0 and 1")
    return float(threshold)


def _video_metadata_from_summary(summary: dict[str, Any]) -> dict[str, int | float]:
    video = summary.get("video")
    measurements = summary.get("measurements")
    if not isinstance(video, dict) or not isinstance(measurements, dict):
        raise SceneBundleError("MoveNet summary must contain video and measurements objects")

    required = ("width", "height", "fps", "reported_duration_seconds")
    if any(field not in video for field in required):
        raise SceneBundleError("MoveNet summary is missing required video metadata")
    frame_count = measurements.get("processed_frames", video.get("reported_frame_count"))
    if not isinstance(frame_count, int) or frame_count <= 0:
        raise SceneBundleError("MoveNet summary frame count must be a positive integer")

    return {
        "width": int(video["width"]),
        "height": int(video["height"]),
        "fps": float(video["fps"]),
        "frame_count": frame_count,
        "duration_ms": round(float(video["reported_duration_seconds"]) * 1000, 3),
    }


def _validate_manifest_media(media: object) -> None:
    if not isinstance(media, dict):
        raise SceneBundleError("media must be an object")
    local_path = media.get("local_path")
    if not isinstance(local_path, str) or not local_path:
        raise SceneBundleError("media.local_path must be a non-empty string")
    _reject_remote_reference(local_path)
    source_type = media.get("source_type")
    if source_type is not None and source_type != "prerecorded_video":
        raise SceneBundleError("media.source_type must be 'prerecorded_video'")
    demo_time_scale = media.get("demo_time_scale", 1.0)
    if (
        not isinstance(demo_time_scale, int | float)
        or isinstance(demo_time_scale, bool)
        or demo_time_scale <= 0
    ):
        raise SceneBundleError("media.demo_time_scale must be positive")
    sha256 = media.get("sha256")
    if (
        not isinstance(sha256, str)
        or len(sha256) != 64
        or any(character not in "0123456789abcdef" for character in sha256)
    ):
        raise SceneBundleError("media.sha256 must be a lowercase SHA-256 digest")
    for field_name in ("width", "height", "frame_count"):
        value = media.get(field_name)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise SceneBundleError(f"media.{field_name} must be a positive integer")
    fps = media.get("fps")
    duration_ms = media.get("duration_ms")
    if not isinstance(fps, int | float) or isinstance(fps, bool) or fps <= 0:
        raise SceneBundleError("media.fps must be positive")
    if (
        not isinstance(duration_ms, int | float)
        or isinstance(duration_ms, bool)
        or duration_ms <= 0
    ):
        raise SceneBundleError("media.duration_ms must be positive")


def _validate_manifest_streams(streams: object) -> None:
    if not isinstance(streams, dict):
        raise SceneBundleError("streams must be an object")
    required_streams = {
        "keypoints_2d",
        "keypoints_3d",
        "posture_observations",
        "transition_events",
        "recorded_decisions",
    }
    if set(streams) != required_streams:
        raise SceneBundleError("streams must contain the shared interface stream names")
    if not isinstance(streams["keypoints_2d"], str) or not streams["keypoints_2d"]:
        raise SceneBundleError("streams.keypoints_2d must be a non-empty string")
    for stream_name, reference in streams.items():
        if reference is not None and not isinstance(reference, str):
            raise SceneBundleError(f"streams.{stream_name} must be a string or null")
        if isinstance(reference, str):
            _reject_remote_reference(reference)


def _resolve_local_reference(base_dir: Path, reference: str) -> Path:
    _reject_remote_reference(reference)
    path = Path(reference)
    return path if path.is_absolute() else base_dir / path


def _reject_remote_reference(reference: str) -> None:
    if "://" in reference:
        raise SceneBundleError("scene bundle references must be local, not URLs")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file_handle:
        for chunk in iter(lambda: file_handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_keypoint(point: dict[str, Any], *, line_number: int) -> None:
    score = point.get("score")
    if not isinstance(score, int | float) or isinstance(score, bool) or not 0.0 <= score <= 1.0:
        raise SceneBundleError(f"line {line_number}: keypoint score must be between 0 and 1")

    for field_name in ("x_norm", "y_norm"):
        value = point.get(field_name)
        if value is None:
            continue
        if (
            not isinstance(value, int | float)
            or isinstance(value, bool)
            or not 0.0 <= value <= 1.0
        ):
            raise SceneBundleError(
                f"line {line_number}: keypoint {field_name} must be null or between 0 and 1"
            )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    package_parser = subparsers.add_parser("package", help="build a scene bundle")
    package_parser.add_argument("--scene-id", required=True)
    package_parser.add_argument("--title", required=True)
    package_parser.add_argument("--video", type=Path, required=True)
    package_parser.add_argument("--legacy-keypoints", type=Path, required=True)
    package_parser.add_argument("--skeleton-video", type=Path, required=True)
    package_parser.add_argument("--run-summary", type=Path, required=True)
    package_parser.add_argument("--output-dir", type=Path, required=True)
    package_parser.add_argument("--demo-time-scale", type=float, default=1.0)

    validate_parser = subparsers.add_parser("validate", help="validate a scene bundle")
    validate_parser.add_argument("manifest", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the scene bundle package or validation command."""

    args = _build_parser().parse_args(argv)
    try:
        if args.command == "package":
            manifest_path = build_scene_bundle(
                scene_id=args.scene_id,
                title=args.title,
                video_path=args.video,
                legacy_keypoints_path=args.legacy_keypoints,
                skeleton_video_path=args.skeleton_video,
                run_summary_path=args.run_summary,
                output_dir=args.output_dir,
                demo_time_scale=args.demo_time_scale,
            )
            print(manifest_path)
            return 0

        manifest = load_scene_manifest(args.manifest)
        keypoints_path = manifest.resolve_stream_path("keypoints_2d")
        if keypoints_path is None:
            raise SceneBundleError("manifest does not provide keypoints_2d")
        summary = validate_frame_landmarks_jsonl(
            keypoints_path, expected_scene_id=manifest.data["scene_id"]
        )
        if summary.record_count != manifest.data["media"]["frame_count"]:
            raise SceneBundleError("keypoint record count does not match manifest")
        print(
            json.dumps(
                {
                    "scene_id": manifest.data["scene_id"],
                    "records": summary.record_count,
                    "first_timestamp_ms": summary.first_timestamp_ms,
                    "last_timestamp_ms": summary.last_timestamp_ms,
                },
                ensure_ascii=False,
            )
        )
        return 0
    except SceneBundleError as exc:
        print(f"error: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
