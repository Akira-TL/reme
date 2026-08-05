"""Build a weakly labelled MoveNet dataset from extracted local videos."""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from reme.pose.annotations import (
    ANNOTATION_SCHEMA_VERSION,
    DATA_SPLITS,
    POSTURE_LABELS,
    PoseAnnotations,
    PostureSegment,
    save_annotations,
)
from reme.pose.movenet import MoveNetError, MoveNetEstimator
from reme.pose.scene_bundle import FRAME_LANDMARKS_SCHEMA_VERSION

DATASET_SCHEMA_VERSION = "reme-pose-dataset/v0-experiment"
DATASET_INDEX_SCHEMA_VERSION = "reme-pose-dataset-index/v0-experiment"


class VideoDatasetError(ValueError):
    """Raised when a local-video dataset catalog or extraction is invalid."""


@dataclass(frozen=True, slots=True)
class ClipSpec:
    """One selected source video and its weak static-posture interval."""

    scene_id: str
    file: str
    split: str
    label: str
    start_ratio: float
    end_ratio: float
    notes: str | None

    @classmethod
    def from_payload(cls, value: object, *, index: int) -> ClipSpec:
        prefix = f"clips[{index}]"
        if not isinstance(value, dict):
            raise VideoDatasetError(f"{prefix} must be an object")
        start_ratio = _ratio(value.get("start_ratio"), f"{prefix}.start_ratio")
        end_ratio = _ratio(value.get("end_ratio"), f"{prefix}.end_ratio")
        if end_ratio <= start_ratio:
            raise VideoDatasetError(f"{prefix}.end_ratio must exceed start_ratio")
        return cls(
            scene_id=_text(value.get("scene_id"), f"{prefix}.scene_id"),
            file=_text(value.get("file"), f"{prefix}.file"),
            split=_enum(value.get("split"), DATA_SPLITS, f"{prefix}.split"),
            label=_enum(value.get("label"), POSTURE_LABELS, f"{prefix}.label"),
            start_ratio=start_ratio,
            end_ratio=end_ratio,
            notes=_nullable_text(value.get("notes"), f"{prefix}.notes"),
        )


@dataclass(frozen=True, slots=True)
class DatasetCatalog:
    """Validated selection of direct local video files."""

    dataset_id: str
    root: Path
    sample_fps: float
    clips: tuple[ClipSpec, ...]
    label_source: str
    evidence_level: str

    @classmethod
    def load(cls, path: str | Path, *, project_root: str | Path = ".") -> DatasetCatalog:
        catalog_path = Path(path)
        try:
            payload = json.loads(catalog_path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise VideoDatasetError(f"cannot read dataset catalog: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise VideoDatasetError(f"dataset catalog is not valid JSON: {exc}") from exc
        if not isinstance(payload, dict):
            raise VideoDatasetError("dataset catalog must be an object")
        if payload.get("schema_version") != DATASET_SCHEMA_VERSION:
            raise VideoDatasetError(
                f"schema_version must be {DATASET_SCHEMA_VERSION!r}"
            )
        raw_clips = payload.get("clips")
        if not isinstance(raw_clips, list) or not raw_clips:
            raise VideoDatasetError("clips must be a non-empty array")
        clips = tuple(
            ClipSpec.from_payload(item, index=index)
            for index, item in enumerate(raw_clips)
        )
        scene_ids = [clip.scene_id for clip in clips]
        if len(scene_ids) != len(set(scene_ids)):
            raise VideoDatasetError("scene_id values must be unique")
        root_text = _text(payload.get("root"), "root")
        root = (Path(project_root) / root_text).resolve()
        sample_fps = _positive_number(payload.get("sample_fps"), "sample_fps")
        return cls(
            dataset_id=_text(payload.get("dataset_id"), "dataset_id"),
            root=root,
            sample_fps=sample_fps,
            clips=clips,
            label_source=_text(payload.get("label_source"), "label_source"),
            evidence_level=_text(payload.get("evidence_level"), "evidence_level"),
        )

    def validate_files(self) -> dict[str, object]:
        """Confirm that selected files exist without inspecting unrelated videos."""

        missing = [clip.file for clip in self.clips if not (self.root / clip.file).is_file()]
        if missing:
            raise VideoDatasetError(f"selected source videos are missing: {missing}")
        return {
            "dataset_id": self.dataset_id,
            "root": str(self.root),
            "selected_clip_count": len(self.clips),
            "split_counts": dict(sorted(Counter(clip.split for clip in self.clips).items())),
            "label_counts": dict(sorted(Counter(clip.label for clip in self.clips).items())),
            "sample_fps": self.sample_fps,
            "label_source": self.label_source,
            "evidence_level": self.evidence_level,
        }


def extract_catalog(
    catalog: DatasetCatalog,
    *,
    model_path: str | Path,
    output_dir: str | Path,
    score_threshold: float = 0.2,
    num_threads: int = 4,
    resume: bool = True,
) -> dict[str, object]:
    """Extract MoveNet records and weak annotations for selected clips."""

    catalog.validate_files()
    destination = Path(output_dir).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    estimator = MoveNetEstimator(
        model_path,
        score_threshold=score_threshold,
        num_threads=num_threads,
    )
    cv2 = _load_cv2()
    scenes: list[dict[str, object]] = []
    total_frames = 0
    started = time.perf_counter()
    index_path = destination / "dataset-index.json"
    existing_scenes = _load_existing_scenes(index_path) if resume else {}

    for clip in catalog.clips:
        estimator.reset()
        source_path = catalog.root / clip.file
        scene_dir = destination / clip.scene_id
        scene_dir.mkdir(parents=True, exist_ok=True)
        records_path = scene_dir / "keypoints.jsonl"
        annotations_path = scene_dir / "annotations.json"
        existing = existing_scenes.get(clip.scene_id)
        if (
            existing is not None
            and records_path.is_file()
            and annotations_path.is_file()
            and existing.get("source") == str(source_path)
        ):
            duration_ms = _positive_number(existing.get("duration_ms"), "duration_ms")
            annotations = _clip_annotations(clip, duration_ms=duration_ms)
            save_annotations(annotations_path, annotations)
            reused = dict(existing)
            reused.update(
                {
                    "split": clip.split,
                    "label": clip.label,
                    "annotations": str(annotations_path),
                    "reused": True,
                }
            )
            sampled_frames = _non_negative_integer(
                existing.get("sampled_frames", 0), "sampled_frames"
            )
            total_frames += sampled_frames
            scenes.append(reused)
            continue

        capture = cv2.VideoCapture(str(source_path))
        if not capture.isOpened():
            raise VideoDatasetError(f"OpenCV could not open source video: {source_path}")
        source_fps = float(capture.get(cv2.CAP_PROP_FPS))
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if source_fps <= 0 or frame_count <= 0 or width <= 0 or height <= 0:
            capture.release()
            raise VideoDatasetError(f"source video reports invalid metadata: {source_path}")
        duration_ms = frame_count / source_fps * 1000.0
        sample_every = max(1, round(source_fps / catalog.sample_fps))
        processed = 0
        detected = 0
        inference_total = 0.0
        decoded = 0
        try:
            with records_path.open("w", encoding="utf-8") as target:
                while True:
                    ok, frame = capture.read()
                    if not ok:
                        break
                    frame_index = decoded
                    decoded += 1
                    if frame_index % sample_every != 0:
                        continue
                    result = estimator.infer(frame)
                    timestamp_ms = frame_index / source_fps * 1000.0
                    record = {
                        "schema_version": FRAME_LANDMARKS_SCHEMA_VERSION,
                        "scene_id": clip.scene_id,
                        "frame_index": frame_index,
                        "timestamp_ms": round(timestamp_ms, 3),
                        "person_detected": result.person_detected,
                        "landmark_quality": result.landmark_quality,
                        "coordinate_space": "normalized_image_top_left",
                        "smoothed": False,
                        "keypoints": [keypoint.to_payload() for keypoint in result.keypoints],
                    }
                    target.write(json.dumps(record, ensure_ascii=False) + "\n")
                    processed += 1
                    detected += int(result.person_detected)
                    inference_total += result.inference_ms
        except MoveNetError as exc:
            raise VideoDatasetError(f"MoveNet failed for {source_path}: {exc}") from exc
        finally:
            capture.release()

        annotations = _clip_annotations(clip, duration_ms=duration_ms)
        save_annotations(annotations_path, annotations)
        total_frames += processed
        scenes.append(
            {
                "scene_id": clip.scene_id,
                "source": str(source_path),
                "split": clip.split,
                "label": clip.label,
                "duration_ms": round(duration_ms, 3),
                "source_fps": round(source_fps, 3),
                "sample_every": sample_every,
                "sampled_frames": processed,
                "person_detected_frames": detected,
                "person_detected_coverage": round(detected / processed, 6)
                if processed
                else 0.0,
                "inference_ms_average": round(inference_total / processed, 3)
                if processed
                else None,
                "keypoints": str(records_path),
                "annotations": str(annotations_path),
                "reused": False,
            }
        )

    index = {
        "schema_version": DATASET_INDEX_SCHEMA_VERSION,
        "dataset_id": catalog.dataset_id,
        "label_source": catalog.label_source,
        "evidence_level": catalog.evidence_level,
        "score_threshold": score_threshold,
        "sample_fps": catalog.sample_fps,
        "model_path": str(Path(model_path).resolve()),
        "total_sampled_frames": total_frames,
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "scenes": scenes,
    }
    index_path.write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return index


def _clip_annotations(clip: ClipSpec, *, duration_ms: float) -> PoseAnnotations:
    return PoseAnnotations(
        scene_id=clip.scene_id,
        posture_segments=(
            PostureSegment(
                start_ms=round(duration_ms * clip.start_ratio, 3),
                end_ms=round(duration_ms * clip.end_ratio, 3),
                posture=clip.label,
                split=clip.split,
                person_id=clip.scene_id,
                camera_id=clip.scene_id,
                notes=clip.notes,
            ),
        ),
        transition_events=(),
        schema_version=ANNOTATION_SCHEMA_VERSION,
    )


def _load_existing_scenes(index_path: Path) -> dict[str, dict[str, object]]:
    if not index_path.is_file():
        return {}
    try:
        payload = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version") != DATASET_INDEX_SCHEMA_VERSION
    ):
        return {}
    raw_scenes = payload.get("scenes")
    if not isinstance(raw_scenes, list):
        return {}
    scenes: dict[str, dict[str, object]] = {}
    for item in raw_scenes:
        if not isinstance(item, dict):
            continue
        scene_id = item.get("scene_id")
        if isinstance(scene_id, str) and scene_id:
            scenes[scene_id] = item
    return scenes


def _load_cv2() -> Any:
    try:
        import cv2
    except ImportError as exc:
        raise VideoDatasetError("opencv-python-headless is required") from exc
    return cv2


def _text(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise VideoDatasetError(f"{field_name} must be a non-empty string")
    return value.strip()


def _nullable_text(value: object, field_name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise VideoDatasetError(f"{field_name} must be a string or null")
    return value.strip() or None


def _enum(value: object, allowed: tuple[str, ...], field_name: str) -> str:
    text = _text(value, field_name)
    if text not in allowed:
        raise VideoDatasetError(f"{field_name} must be one of {allowed}")
    return text


def _ratio(value: object, field_name: str) -> float:
    number = _positive_or_zero_number(value, field_name)
    if number > 1.0:
        raise VideoDatasetError(f"{field_name} must be at most 1")
    return number


def _non_negative_integer(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise VideoDatasetError(f"{field_name} must be a non-negative integer")
    return value


def _positive_number(value: object, field_name: str) -> float:
    number = _positive_or_zero_number(value, field_name)
    if number <= 0:
        raise VideoDatasetError(f"{field_name} must be positive")
    return number


def _positive_or_zero_number(value: object, field_name: str) -> float:
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise VideoDatasetError(f"{field_name} must be numeric")
    number = float(value)
    if number != number or number < 0 or number == float("inf"):
        raise VideoDatasetError(f"{field_name} must be finite and non-negative")
    return round(number, 6)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate = subparsers.add_parser("validate", help="validate selected direct files")
    validate.add_argument("catalog", type=Path)
    validate.add_argument("--project-root", type=Path, default=Path("."))
    extract = subparsers.add_parser("extract", help="extract MoveNet records for selected clips")
    extract.add_argument("catalog", type=Path)
    extract.add_argument("--project-root", type=Path, default=Path("."))
    extract.add_argument("--model", type=Path, required=True)
    extract.add_argument("--output-dir", type=Path, required=True)
    extract.add_argument("--score-threshold", type=float, default=0.2)
    extract.add_argument("--num-threads", type=int, default=4)
    extract.add_argument("--no-resume", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        catalog = DatasetCatalog.load(args.catalog, project_root=args.project_root)
        if args.command == "validate":
            result = catalog.validate_files()
        else:
            result = extract_catalog(
                catalog,
                model_path=args.model,
                output_dir=args.output_dir,
                score_threshold=args.score_threshold,
                num_threads=args.num_threads,
                resume=not args.no_resume,
            )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except VideoDatasetError as exc:
        print(f"error: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
