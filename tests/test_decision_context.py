"""Tests for reading A's streams and assembling B's decision context."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from reme.decision.context import (
    LandmarkQuality,
    Posture,
    SceneStreamError,
    Transition,
    build_decision_context,
    discover_scenes,
    load_posture_observations,
    load_scene_streams,
)


def _posture_record(**overrides: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "schema_version": "reme-posture/v0-experiment",
        "scene_id": "fall_demo_01",
        "timestamp_ms": 12500.0,
        "frame_index": 375,
        "person_detected": True,
        "posture": "lying",
        "posture_confidence": 0.88,
        "posture_duration_ms": 4200,
        "motion_level": "low",
        "visible_keypoint_ratio": 0.94,
        "landmark_quality": "usable",
    }
    record.update(overrides)
    return record


def _transition_record(**overrides: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "schema_version": "reme-transition/v0-experiment",
        "scene_id": "fall_demo_01",
        "event_id": "transition-0003",
        "start_ms": 11100.0,
        "end_ms": 12700.0,
        "transition": "fall_like_transition",
        "transition_confidence": 0.76,
        "evidence": {"posture_before": "standing", "posture_after": "lying"},
        "landmark_quality": "usable",
    }
    record.update(overrides)
    return record


def _write_bundle(
    bundle_dir: Path,
    *,
    scene_id: str = "fall_demo_01",
    postures: list[dict[str, Any]] | None = None,
    transitions: list[dict[str, Any]] | None = None,
) -> Path:
    bundle_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        "schema_version": "reme-scene/v0-experiment",
        "scene_id": scene_id,
        "title": "疑似跌倒后无回应",
        "media": {
            "local_path": "media/source.mp4",
            "sha256": "0" * 64,
            "width": 1280,
            "height": 720,
            "fps": 30.0,
            "frame_count": 2370,
            "duration_ms": 79000,
        },
        "streams": {
            "keypoints_2d": "keypoints_2d.jsonl",
            "keypoints_3d": None,
            "posture_observations": None if postures is None else "posture_observations.jsonl",
            "transition_events": None if transitions is None else "transition_events.jsonl",
            "recorded_decisions": None,
        },
    }
    manifest_path = bundle_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    if postures is not None:
        lines = [json.dumps(record, ensure_ascii=False) for record in postures]
        (bundle_dir / "posture_observations.jsonl").write_text(
            "\n".join(lines) + "\n", encoding="utf-8"
        )
    if transitions is not None:
        lines = [json.dumps(record, ensure_ascii=False) for record in transitions]
        (bundle_dir / "transition_events.jsonl").write_text(
            "\n".join(lines) + "\n", encoding="utf-8"
        )
    return manifest_path


def test_load_scene_streams_reads_posture_and_transition_jsonl(tmp_path: Path) -> None:
    manifest_path = _write_bundle(
        tmp_path / "fall_demo_01",
        postures=[_posture_record(timestamp_ms=1000.0), _posture_record(timestamp_ms=2000.0)],
        transitions=[_transition_record()],
    )
    streams = load_scene_streams(manifest_path)
    assert streams.scene_id == "fall_demo_01"
    assert len(streams.postures) == 2
    assert streams.postures[1].posture is Posture.LYING
    assert streams.transitions[0].transition is Transition.FALL_LIKE
    assert streams.transitions[0].evidence["posture_after"] == "lying"


def test_load_scene_streams_tolerates_null_optional_streams(tmp_path: Path) -> None:
    manifest_path = _write_bundle(tmp_path / "fall_demo_01")
    streams = load_scene_streams(manifest_path)
    assert streams.postures == ()
    assert streams.transitions == ()


def test_posture_parser_tolerates_unknown_fields(tmp_path: Path) -> None:
    manifest_path = _write_bundle(
        tmp_path / "fall_demo_01",
        postures=[_posture_record(extra_experiment_field={"nested": True})],
    )
    streams = load_scene_streams(manifest_path)
    assert streams.postures[0].posture_confidence == 0.88


def test_load_posture_observations_rejects_scene_id_mismatch(tmp_path: Path) -> None:
    stream = tmp_path / "posture_observations.jsonl"
    stream.write_text(json.dumps(_posture_record(scene_id="other")) + "\n", encoding="utf-8")
    with pytest.raises(SceneStreamError, match="scene_id mismatch"):
        load_posture_observations(stream, expected_scene_id="fall_demo_01")


def test_load_posture_observations_rejects_descending_timestamps(tmp_path: Path) -> None:
    stream = tmp_path / "posture_observations.jsonl"
    lines = [
        json.dumps(_posture_record(timestamp_ms=2000.0)),
        json.dumps(_posture_record(timestamp_ms=1000.0)),
    ]
    stream.write_text("\n".join(lines) + "\n", encoding="utf-8")
    with pytest.raises(SceneStreamError, match="ascending"):
        load_posture_observations(stream, expected_scene_id="fall_demo_01")


def test_transition_parser_rejects_reversed_window(tmp_path: Path) -> None:
    manifest_path = _write_bundle(
        tmp_path / "fall_demo_01",
        transitions=[_transition_record(start_ms=13000.0, end_ms=12000.0)],
    )
    with pytest.raises(SceneStreamError, match="end_ms"):
        load_scene_streams(manifest_path)


def test_build_context_uses_latest_observation_not_after_timestamp(tmp_path: Path) -> None:
    manifest_path = _write_bundle(
        tmp_path / "fall_demo_01",
        postures=[
            _posture_record(timestamp_ms=1000.0, posture="standing"),
            _posture_record(timestamp_ms=2000.0, posture="sitting"),
            _posture_record(timestamp_ms=3000.0, posture="lying"),
        ],
    )
    context = build_decision_context(load_scene_streams(manifest_path), timestamp_ms=2500.0)
    assert context.latest_posture is not None
    assert context.latest_posture.posture is Posture.SITTING
    assert context.input_quality is LandmarkQuality.USABLE


def test_build_context_selects_transition_within_grace_window(tmp_path: Path) -> None:
    manifest_path = _write_bundle(
        tmp_path / "fall_demo_01",
        transitions=[_transition_record(start_ms=11100.0, end_ms=12700.0)],
    )
    context = build_decision_context(load_scene_streams(manifest_path), timestamp_ms=14000.0)
    assert context.active_transition is not None
    assert context.active_transition.event_id == "transition-0003"


def test_build_context_ignores_transition_beyond_grace(tmp_path: Path) -> None:
    manifest_path = _write_bundle(
        tmp_path / "fall_demo_01",
        transitions=[_transition_record(start_ms=1000.0, end_ms=2000.0)],
    )
    context = build_decision_context(load_scene_streams(manifest_path), timestamp_ms=20000.0)
    assert context.active_transition is None


def test_build_context_reports_unavailable_quality_without_observations(tmp_path: Path) -> None:
    manifest_path = _write_bundle(tmp_path / "fall_demo_01")
    context = build_decision_context(load_scene_streams(manifest_path), timestamp_ms=1000.0)
    assert context.latest_posture is None
    assert context.input_quality is LandmarkQuality.UNAVAILABLE


def test_discover_scenes_rejects_duplicate_scene_ids(tmp_path: Path) -> None:
    _write_bundle(tmp_path / "bundle_a", scene_id="fall_demo_01")
    _write_bundle(tmp_path / "bundle_b", scene_id="fall_demo_01")
    with pytest.raises(SceneStreamError, match="duplicate"):
        discover_scenes(tmp_path)
