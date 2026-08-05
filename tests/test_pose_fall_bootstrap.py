from __future__ import annotations

from pathlib import Path

import pytest
from reme.runtime.perception.fall_bootstrap import (
    FallBootstrapError,
    SceneDifference,
    build_clip_intervals,
    select_scene_boundaries,
    split_clip_indices,
)


def test_select_scene_boundaries_uses_strong_non_overlapping_peaks() -> None:
    scores = (
        SceneDifference(timestamp_ms=1000.0, score=0.1),
        SceneDifference(timestamp_ms=2000.0, score=0.9),
        SceneDifference(timestamp_ms=2300.0, score=0.8),
        SceneDifference(timestamp_ms=5000.0, score=0.7),
        SceneDifference(timestamp_ms=8000.0, score=0.6),
    )

    selected = select_scene_boundaries(
        scores,
        expected_clip_count=4,
        duration_ms=10_000.0,
        min_gap_ms=1_000.0,
    )

    assert selected == (2000.0, 5000.0, 8000.0)


def test_select_scene_boundaries_rejects_insufficient_candidates() -> None:
    scores = (
        SceneDifference(timestamp_ms=2000.0, score=0.9),
        SceneDifference(timestamp_ms=2300.0, score=0.8),
    )

    with pytest.raises(FallBootstrapError, match="could not select"):
        select_scene_boundaries(
            scores,
            expected_clip_count=3,
            duration_ms=5_000.0,
            min_gap_ms=1_000.0,
        )


def test_build_clip_intervals_covers_duration_without_overlap() -> None:
    clips = build_clip_intervals(
        boundaries_ms=(2000.0, 5000.0, 8000.0),
        duration_ms=10_000.0,
        split_by_index={0: "train", 1: "test", 2: "train", 3: "val"},
    )

    assert [(clip.start_ms, clip.end_ms) for clip in clips] == [
        (0.0, 2000.0),
        (2000.0, 5000.0),
        (5000.0, 8000.0),
        (8000.0, 10_000.0),
    ]
    assert [clip.scene_id for clip in clips] == [
        "fall-001",
        "fall-002",
        "fall-003",
        "fall-004",
    ]
    assert [clip.split for clip in clips] == ["train", "test", "train", "val"]


def test_split_clip_indices_is_deterministic_and_exact() -> None:
    first = split_clip_indices(50, train_count=35, val_count=7, test_count=8)
    second = split_clip_indices(50, train_count=35, val_count=7, test_count=8)

    assert first == second
    assert sorted(first) == list(range(50))
    assert list(first.values()).count("train") == 35
    assert list(first.values()).count("val") == 7
    assert list(first.values()).count("test") == 8


def test_split_clip_indices_rejects_count_mismatch() -> None:
    with pytest.raises(FallBootstrapError, match="must equal clip_count"):
        split_clip_indices(50, train_count=35, val_count=7, test_count=7)


def test_module_does_not_require_marked_video_for_training_pixels(tmp_path: Path) -> None:
    # The marked video is only an audit reference. Segmentation primitives work
    # on scene scores and never require reading marked-video pixels.
    scores = tuple(
        SceneDifference(timestamp_ms=float(index * 1000), score=float(index))
        for index in range(1, 5)
    )
    assert select_scene_boundaries(
        scores,
        expected_clip_count=3,
        duration_ms=6_000.0,
        min_gap_ms=500.0,
    ) == (3000.0, 4000.0)
