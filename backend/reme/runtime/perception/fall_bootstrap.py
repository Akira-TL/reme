"""Build deterministic weak-supervision clip manifests for fall compilations."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

FALL_BOOTSTRAP_SCHEMA_VERSION = "reme-fall-bootstrap/v0-experiment"
_SPLIT_NAMES = ("train", "val", "test")
_SPLIT_SEED = "reme-fall-bootstrap-20260802"


class FallBootstrapError(ValueError):
    """Raised when weak fall data cannot be segmented safely."""


@dataclass(frozen=True, slots=True)
class SceneDifference:
    """One adjacent-frame visual difference candidate."""

    timestamp_ms: float
    score: float

    def __post_init__(self) -> None:
        if not math.isfinite(self.timestamp_ms) or self.timestamp_ms <= 0:
            raise FallBootstrapError("timestamp_ms must be finite and positive")
        if not math.isfinite(self.score) or self.score < 0:
            raise FallBootstrapError("score must be finite and non-negative")


@dataclass(frozen=True, slots=True)
class FallClipInterval:
    """One indivisible positive-bag clip in the weak-supervision dataset."""

    clip_index: int
    scene_id: str
    start_ms: float
    end_ms: float
    split: str
    label_source: str = "video_theme_positive_bag"

    def __post_init__(self) -> None:
        if self.clip_index < 0:
            raise FallBootstrapError("clip_index must be non-negative")
        if not self.scene_id:
            raise FallBootstrapError("scene_id must be non-empty")
        if self.end_ms <= self.start_ms:
            raise FallBootstrapError("clip end_ms must exceed start_ms")
        if self.split not in _SPLIT_NAMES:
            raise FallBootstrapError(f"split must be one of {_SPLIT_NAMES}")

    def to_payload(self) -> dict[str, object]:
        """Return the persisted clip shape."""

        return {
            "clip_index": self.clip_index,
            "scene_id": self.scene_id,
            "start_ms": round(self.start_ms, 3),
            "end_ms": round(self.end_ms, 3),
            "duration_ms": round(self.end_ms - self.start_ms, 3),
            "split": self.split,
            "label_source": self.label_source,
        }


@dataclass(frozen=True, slots=True)
class VideoDescriptor:
    """Stable metadata for one local source video."""

    path: str
    sha256: str
    width: int
    height: int
    fps: float
    frame_count: int
    duration_ms: float

    def to_payload(self) -> dict[str, object]:
        """Return a JSON-safe descriptor."""

        return {
            "path": self.path,
            "sha256": self.sha256,
            "width": self.width,
            "height": self.height,
            "fps": round(self.fps, 6),
            "frame_count": self.frame_count,
            "duration_ms": round(self.duration_ms, 3),
        }


def select_scene_boundaries(
    scores: Sequence[SceneDifference],
    *,
    expected_clip_count: int,
    duration_ms: float,
    min_gap_ms: float,
) -> tuple[float, ...]:
    """Select strong scene changes with non-maximum suppression."""

    if expected_clip_count < 2:
        raise FallBootstrapError("expected_clip_count must be at least 2")
    if not math.isfinite(duration_ms) or duration_ms <= 0:
        raise FallBootstrapError("duration_ms must be finite and positive")
    if not math.isfinite(min_gap_ms) or min_gap_ms <= 0:
        raise FallBootstrapError("min_gap_ms must be finite and positive")

    required = expected_clip_count - 1
    selected: list[SceneDifference] = []
    for candidate in sorted(
        scores,
        key=lambda item: (-item.score, item.timestamp_ms),
    ):
        if candidate.timestamp_ms >= duration_ms:
            continue
        if any(
            abs(candidate.timestamp_ms - chosen.timestamp_ms) < min_gap_ms
            for chosen in selected
        ):
            continue
        selected.append(candidate)
        if len(selected) == required:
            break
    if len(selected) != required:
        raise FallBootstrapError(
            f"could not select {required} scene boundaries; selected {len(selected)}"
        )
    return tuple(sorted(item.timestamp_ms for item in selected))


def split_clip_indices(
    clip_count: int,
    *,
    train_count: int,
    val_count: int,
    test_count: int,
) -> dict[int, str]:
    """Return a deterministic clip-level split without adjacent-window leakage."""

    if clip_count < 1:
        raise FallBootstrapError("clip_count must be positive")
    counts = (train_count, val_count, test_count)
    if any(count < 0 for count in counts):
        raise FallBootstrapError("split counts must be non-negative")
    if sum(counts) != clip_count:
        raise FallBootstrapError("split counts must equal clip_count")

    ranked = sorted(
        range(clip_count),
        key=lambda index: hashlib.sha256(
            f"{_SPLIT_SEED}:{index}".encode()
        ).digest(),
    )
    result: dict[int, str] = {}
    train_end = train_count
    val_end = train_end + val_count
    for rank, index in enumerate(ranked):
        if rank < train_end:
            result[index] = "train"
        elif rank < val_end:
            result[index] = "val"
        else:
            result[index] = "test"
    return result


def build_clip_intervals(
    *,
    boundaries_ms: Sequence[float],
    duration_ms: float,
    split_by_index: dict[int, str],
) -> tuple[FallClipInterval, ...]:
    """Convert ordered boundaries into full-duration non-overlapping clips."""

    if not math.isfinite(duration_ms) or duration_ms <= 0:
        raise FallBootstrapError("duration_ms must be finite and positive")
    boundaries = tuple(float(value) for value in boundaries_ms)
    if any(not math.isfinite(value) for value in boundaries):
        raise FallBootstrapError("boundaries must be finite")
    if boundaries != tuple(sorted(boundaries)) or len(set(boundaries)) != len(boundaries):
        raise FallBootstrapError("boundaries must be strictly increasing")
    if boundaries and (boundaries[0] <= 0 or boundaries[-1] >= duration_ms):
        raise FallBootstrapError("boundaries must be inside the video duration")

    points = (0.0, *boundaries, float(duration_ms))
    clip_count = len(points) - 1
    if set(split_by_index) != set(range(clip_count)):
        raise FallBootstrapError("split_by_index must cover every clip index exactly once")
    return tuple(
        FallClipInterval(
            clip_index=index,
            scene_id=f"fall-{index + 1:03d}",
            start_ms=points[index],
            end_ms=points[index + 1],
            split=split_by_index[index],
        )
        for index in range(clip_count)
    )


def scan_scene_differences(
    video_path: str | Path,
    *,
    resize_width: int = 160,
) -> tuple[SceneDifference, ...]:
    """Measure adjacent-frame grayscale differences without persisting frames."""

    if resize_width < 16:
        raise FallBootstrapError("resize_width must be at least 16")
    cv2, np = _load_video_runtime()
    path = Path(video_path).resolve()
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise FallBootstrapError(f"OpenCV could not open video: {path}")
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    if fps <= 0:
        capture.release()
        raise FallBootstrapError(f"video reports invalid FPS: {path}")

    previous: Any | None = None
    frame_index = 0
    scores: list[SceneDifference] = []
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            height, width = frame.shape[:2]
            resized_height = max(16, round(height * resize_width / width))
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            small = cv2.resize(gray, (resize_width, resized_height))
            if previous is not None:
                score = float(np.mean(cv2.absdiff(small, previous))) / 255.0
                scores.append(
                    SceneDifference(
                        timestamp_ms=frame_index / fps * 1000.0,
                        score=score,
                    )
                )
            previous = small
            frame_index += 1
    finally:
        capture.release()
    if not scores:
        raise FallBootstrapError(f"video contains no comparable frames: {path}")
    return tuple(scores)


def probe_video(video_path: str | Path) -> VideoDescriptor:
    """Read stable metadata and hash for one local video."""

    cv2, _ = _load_video_runtime()
    path = Path(video_path).resolve()
    if not path.is_file():
        raise FallBootstrapError(f"video does not exist: {path}")
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise FallBootstrapError(f"OpenCV could not open video: {path}")
    try:
        fps = float(capture.get(cv2.CAP_PROP_FPS))
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    finally:
        capture.release()
    if fps <= 0 or frame_count <= 0 or width <= 0 or height <= 0:
        raise FallBootstrapError(f"video reports invalid metadata: {path}")
    duration_ms = frame_count / fps * 1000.0
    return VideoDescriptor(
        path=str(path),
        sha256=_sha256(path),
        width=width,
        height=height,
        fps=fps,
        frame_count=frame_count,
        duration_ms=duration_ms,
    )


def build_fall_manifest(
    *,
    raw_video: str | Path,
    marked_video: str | Path,
    expected_clip_count: int = 50,
    min_gap_ms: float = 1500.0,
    train_count: int = 35,
    val_count: int = 7,
    test_count: int = 8,
) -> dict[str, object]:
    """Build the auditable positive-bag manifest used before pose extraction."""

    raw = probe_video(raw_video)
    marked = probe_video(marked_video)
    duration_delta_ms = abs(raw.duration_ms - marked.duration_ms)
    if duration_delta_ms > 250.0:
        raise FallBootstrapError(
            "raw and marked videos are not sufficiently time-aligned: "
            f"duration delta {duration_delta_ms:.3f} ms"
        )
    scores = scan_scene_differences(raw_video)
    boundaries = select_scene_boundaries(
        scores,
        expected_clip_count=expected_clip_count,
        duration_ms=raw.duration_ms,
        min_gap_ms=min_gap_ms,
    )
    splits = split_clip_indices(
        expected_clip_count,
        train_count=train_count,
        val_count=val_count,
        test_count=test_count,
    )
    clips = build_clip_intervals(
        boundaries_ms=boundaries,
        duration_ms=raw.duration_ms,
        split_by_index=splits,
    )
    selected_scores = {
        round(item.timestamp_ms, 3): item.score
        for item in scores
        if any(abs(item.timestamp_ms - boundary) < 0.001 for boundary in boundaries)
    }
    return {
        "schema_version": FALL_BOOTSTRAP_SCHEMA_VERSION,
        "dataset_id": "fall-50-video-theme-bootstrap",
        "evidence_level": "weak_supervision_bootstrap",
        "training_pixel_source": "raw_video_only",
        "marked_video_role": "audit_reference_only",
        "raw_video": raw.to_payload(),
        "marked_video": marked.to_payload(),
        "duration_delta_ms": round(duration_delta_ms, 3),
        "expected_clip_count": expected_clip_count,
        "scene_detection": {
            "method": "adjacent_grayscale_mean_absolute_difference_topk_nms",
            "resize_width": 160,
            "min_gap_ms": min_gap_ms,
            "candidate_count": len(scores),
            "selected_boundary_count": len(boundaries),
            "selected_boundaries_ms": [round(value, 3) for value in boundaries],
            "selected_scores": {
                f"{timestamp:.3f}": round(score, 9)
                for timestamp, score in sorted(selected_scores.items())
            },
        },
        "split_counts": {
            "train": train_count,
            "val": val_count,
            "test": test_count,
        },
        "clips": [clip.to_payload() for clip in clips],
        "raw_frames_persisted": False,
        "claims": {
            "contains_fall_theme_bags": True,
            "event_boundaries_verified": False,
            "accuracy_report_allowed": False,
        },
    }


def save_manifest(path: str | Path, payload: dict[str, object]) -> None:
    """Persist one deterministic JSON manifest."""

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_video_runtime() -> tuple[Any, Any]:
    try:
        import cv2
        import numpy as np
    except ImportError as exc:
        raise FallBootstrapError(
            "fall bootstrap video inspection requires opencv-python and numpy"
        ) from exc
    return cv2, np


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("raw_video", type=Path)
    parser.add_argument("marked_video", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-clips", type=int, default=50)
    parser.add_argument("--min-gap-ms", type=float, default=1500.0)
    parser.add_argument("--train-count", type=int, default=35)
    parser.add_argument("--val-count", type=int, default=7)
    parser.add_argument("--test-count", type=int, default=8)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Generate a weak-supervision fall clip manifest."""

    args = _build_parser().parse_args(argv)
    manifest = build_fall_manifest(
        raw_video=args.raw_video,
        marked_video=args.marked_video,
        expected_clip_count=args.expected_clips,
        min_gap_ms=args.min_gap_ms,
        train_count=args.train_count,
        val_count=args.val_count,
        test_count=args.test_count,
    )
    save_manifest(args.output, manifest)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
