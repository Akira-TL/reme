#!/usr/bin/env python3
"""Load Reme MoveNet JSONL and build fixed-length posture windows."""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np

try:
    import torch
    from torch import Tensor
    from torch.utils.data import Dataset
except ImportError as exc:  # pragma: no cover - dependency guard
    raise SystemExit(
        "PyTorch is required. Install the dependencies from requirements.txt."
    ) from exc


COCO17_NAMES = (
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

SHOULDERS = (5, 6)
HIPS = (11, 12)


@dataclass(frozen=True)
class Annotation:
    start_ms: float
    end_ms: float
    label: str
    split: str

    def contains(self, timestamp_ms: float) -> bool:
        return self.start_ms <= timestamp_ms < self.end_ms


@dataclass(frozen=True)
class WindowRecord:
    start_frame: int
    end_frame: int
    center_timestamp_ms: float
    label: str
    split: str


def read_keypoint_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as source:
        for line_number, raw_line in enumerate(source, start=1):
            line = raw_line.strip()
            if not line:
                continue
            record = json.loads(line)
            if record.get("schema") != "movenet-17/v0-experiment":
                raise ValueError(
                    f"{path}:{line_number}: unsupported schema {record.get('schema')!r}"
                )
            keypoints = record.get("keypoints")
            if not isinstance(keypoints, list) or len(keypoints) != 17:
                raise ValueError(f"{path}:{line_number}: expected exactly 17 keypoints")
            names = tuple(item.get("name") for item in keypoints)
            if names != COCO17_NAMES:
                raise ValueError(
                    f"{path}:{line_number}: unexpected MoveNet keypoint ordering"
                )
            records.append(record)
    if not records:
        raise ValueError(f"No keypoint records found in {path}")
    return records


def read_annotations(path: Path) -> list[Annotation]:
    annotations: list[Annotation] = []
    with path.open("r", encoding="utf-8", newline="") as source:
        reader = csv.DictReader(source)
        required = {"start_ms", "end_ms", "label", "split"}
        if reader.fieldnames is None or not required.issubset(reader.fieldnames):
            raise ValueError(
                f"Annotation CSV must contain columns: {', '.join(sorted(required))}"
            )
        for line_number, row in enumerate(reader, start=2):
            annotation = Annotation(
                start_ms=float(row["start_ms"]),
                end_ms=float(row["end_ms"]),
                label=row["label"].strip(),
                split=row["split"].strip().lower(),
            )
            if annotation.end_ms <= annotation.start_ms:
                raise ValueError(f"{path}:{line_number}: end_ms must exceed start_ms")
            if not annotation.label:
                raise ValueError(f"{path}:{line_number}: label cannot be empty")
            if annotation.split not in {"train", "val", "test"}:
                raise ValueError(
                    f"{path}:{line_number}: split must be train, val, or test"
                )
            annotations.append(annotation)
    if not annotations:
        raise ValueError(f"No annotations found in {path}")
    return annotations


def label_names(annotations: Iterable[Annotation]) -> tuple[str, ...]:
    return tuple(sorted({annotation.label for annotation in annotations}))


def _midpoint(coords: np.ndarray, scores: np.ndarray, indices: tuple[int, int], threshold: float) -> np.ndarray | None:
    if all(scores[index] >= threshold for index in indices):
        return coords[list(indices)].mean(axis=0)
    return None


def normalize_frame(
    record: dict[str, Any],
    score_threshold: float = 0.2,
) -> np.ndarray:
    """Return a root-centered, scale-normalized ``[17, 3]`` frame."""
    if not 0.0 <= score_threshold <= 1.0:
        raise ValueError("score_threshold must be between 0 and 1")

    keypoints = record["keypoints"]
    coords = np.asarray(
        [[float(item["x_norm"]), float(item["y_norm"])] for item in keypoints],
        dtype=np.float32,
    )
    scores = np.asarray([float(item["score"]) for item in keypoints], dtype=np.float32)
    visible = scores >= score_threshold

    hip_midpoint = _midpoint(coords, scores, HIPS, score_threshold)
    shoulder_midpoint = _midpoint(coords, scores, SHOULDERS, score_threshold)
    if hip_midpoint is not None:
        root = hip_midpoint
    elif shoulder_midpoint is not None:
        root = shoulder_midpoint
    elif visible.any():
        root = coords[visible].mean(axis=0)
    else:
        root = np.zeros(2, dtype=np.float32)

    if hip_midpoint is not None and shoulder_midpoint is not None:
        scale = float(np.linalg.norm(shoulder_midpoint - hip_midpoint))
    elif visible.sum() >= 2:
        extent = np.ptp(coords[visible], axis=0)
        scale = float(np.linalg.norm(extent))
    else:
        scale = 1.0
    scale = max(scale, 1e-4)

    normalized = (coords - root) / scale
    normalized[~visible] = 0.0
    return np.concatenate(
        [normalized, np.clip(scores[:, None], 0.0, 1.0)],
        axis=1,
    ).astype(np.float32, copy=False)


def build_windows(
    records: list[dict[str, Any]],
    annotations: list[Annotation],
    window_frames: int,
    stride_frames: int,
) -> list[WindowRecord]:
    if window_frames < 2:
        raise ValueError("window_frames must be at least 2")
    if stride_frames < 1:
        raise ValueError("stride_frames must be at least 1")
    if len(records) < window_frames:
        return []

    windows: list[WindowRecord] = []
    for start in range(0, len(records) - window_frames + 1, stride_frames):
        end = start + window_frames
        center = start + window_frames // 2
        start_timestamp_ms = float(records[start]["timestamp_ms"])
        end_timestamp_ms = float(records[end - 1]["timestamp_ms"])
        center_timestamp_ms = float(records[center]["timestamp_ms"])
        matches = [
            annotation
            for annotation in annotations
            if annotation.contains(start_timestamp_ms)
            and annotation.contains(end_timestamp_ms)
        ]
        if len(matches) > 1:
            raise ValueError(
                "Overlapping annotations for window centered at "
                f"{center_timestamp_ms:.3f} ms"
            )
        if not matches:
            continue
        annotation = matches[0]
        windows.append(
            WindowRecord(
                start_frame=start,
                end_frame=end,
                center_timestamp_ms=center_timestamp_ms,
                label=annotation.label,
                split=annotation.split,
            )
        )
    return windows


class PoseSequenceDataset(Dataset[tuple[Tensor, Tensor]]):
    def __init__(
        self,
        records: list[dict[str, Any]],
        windows: list[WindowRecord],
        labels: tuple[str, ...],
        split: str,
        score_threshold: float = 0.2,
    ) -> None:
        self.records = records
        self.windows = [window for window in windows if window.split == split]
        self.labels = labels
        self.label_to_index = {label: index for index, label in enumerate(labels)}
        self.score_threshold = score_threshold
        if not self.windows:
            raise ValueError(f"No windows available for split {split!r}")

    def __len__(self) -> int:
        return len(self.windows)

    def __getitem__(self, index: int) -> tuple[Tensor, Tensor]:
        window = self.windows[index]
        sequence = np.stack(
            [
                normalize_frame(record, self.score_threshold)
                for record in self.records[window.start_frame : window.end_frame]
            ],
            axis=0,
        )
        return torch.from_numpy(sequence), torch.tensor(
            self.label_to_index[window.label], dtype=torch.long
        )
