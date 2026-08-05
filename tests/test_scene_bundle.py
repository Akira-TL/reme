import json
from pathlib import Path

import pytest
from reme.runtime.perception.scene_bundle import (
    MOVENET_KEYPOINT_NAMES,
    SceneBundleError,
    build_scene_bundle,
    load_scene_manifest,
    validate_frame_landmarks_jsonl,
)


def test_legacy_scene_bundle_entrypoint_reexports_pose_module() -> None:
    from reme import scene_bundle as legacy_scene_bundle

    assert legacy_scene_bundle.load_scene_manifest is load_scene_manifest
    assert legacy_scene_bundle.build_scene_bundle is build_scene_bundle


def test_load_scene_manifest_rejects_unknown_schema_version(tmp_path: Path) -> None:
    path = tmp_path / "manifest.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": "candidate-v1",
                "scene_id": "fall_demo_01",
                "title": "test",
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
                    "posture_observations": None,
                    "transition_events": None,
                    "recorded_decisions": None,
                },
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(SceneBundleError, match="schema_version"):
        load_scene_manifest(path)


def _frame_record(*, frame_index: int, timestamp_ms: float) -> dict[str, object]:
    return {
        "schema_version": "movenet-17/v0-experiment",
        "scene_id": "fall_demo_01",
        "frame_index": frame_index,
        "timestamp_ms": timestamp_ms,
        "person_detected": True,
        "landmark_quality": "usable",
        "coordinate_space": "normalized_image_top_left",
        "smoothed": False,
        "keypoints": [
            {"name": name, "x_norm": 0.5, "y_norm": 0.5, "score": 0.9}
            for name in MOVENET_KEYPOINT_NAMES
        ],
    }


def test_validate_frame_landmarks_rejects_out_of_order_timestamps(tmp_path: Path) -> None:
    path = tmp_path / "keypoints.jsonl"
    path.write_text(
        "\n".join(
            [
                json.dumps(_frame_record(frame_index=0, timestamp_ms=33.333)),
                json.dumps(_frame_record(frame_index=1, timestamp_ms=0.0)),
            ]
        ),
        encoding="utf-8",
    )

    with pytest.raises(SceneBundleError, match="timestamp_ms"):
        validate_frame_landmarks_jsonl(path, expected_scene_id="fall_demo_01")


def test_validate_frame_landmarks_rejects_wrong_keypoint_set(tmp_path: Path) -> None:
    path = tmp_path / "keypoints.jsonl"
    record = _frame_record(frame_index=0, timestamp_ms=0.0)
    record["keypoints"] = record["keypoints"][:-1]  # type: ignore[index]
    path.write_text(json.dumps(record), encoding="utf-8")

    with pytest.raises(SceneBundleError, match="17 MoveNet keypoints"):
        validate_frame_landmarks_jsonl(path, expected_scene_id="fall_demo_01")


def test_build_scene_bundle_converts_legacy_movenet_output(tmp_path: Path) -> None:
    video_path = tmp_path / "source.mp4"
    video_path.write_bytes(b"video-bytes")
    skeleton_path = tmp_path / "skeleton.mp4"
    skeleton_path.write_bytes(b"skeleton-bytes")
    summary_path = tmp_path / "summary.json"
    summary_path.write_text(
        json.dumps(
            {
                "video": {
                    "width": 1280,
                    "height": 720,
                    "fps": 30.0,
                    "reported_frame_count": 2,
                    "reported_duration_seconds": 0.066666,
                },
                "sampling": {
                    "score_threshold": 0.2,
                    "preprocessing": "tracking_crop",
                },
                "measurements": {
                    "processed_frames": 2,
                    "detection_coverage": 1.0,
                },
                "privacy_boundary": {
                    "raw_frames_written": False,
                    "raw_frames_uploaded": False,
                },
            }
        ),
        encoding="utf-8",
    )
    legacy_keypoints_path = tmp_path / "legacy.jsonl"
    legacy_records = []
    for frame_index, timestamp_ms in [(0, 0.0), (1, 33.333)]:
        keypoints = [
            {"name": name, "x_norm": 0.5, "y_norm": 0.4, "score": 0.9}
            for name in MOVENET_KEYPOINT_NAMES
        ]
        if frame_index == 1:
            keypoints[-1]["score"] = 0.1
        legacy_records.append(
            {
                "schema": "movenet-17/v0-experiment",
                "frame_index": frame_index,
                "timestamp_ms": timestamp_ms,
                "torso_detected": True,
                "keypoints": keypoints,
            }
        )
    legacy_keypoints_path.write_text(
        "\n".join(json.dumps(record) for record in legacy_records),
        encoding="utf-8",
    )

    manifest_path = build_scene_bundle(
        scene_id="fall_demo_01",
        title="疑似跌倒后无回应",
        video_path=video_path,
        legacy_keypoints_path=legacy_keypoints_path,
        skeleton_video_path=skeleton_path,
        run_summary_path=summary_path,
        output_dir=tmp_path / "bundle",
        demo_time_scale=30.0,
    )

    manifest = load_scene_manifest(manifest_path)
    assert manifest.data["media"]["local_path"] == "media/source.mp4"
    assert manifest.data["media"]["source_type"] == "prerecorded_video"
    assert manifest.data["media"]["demo_time_scale"] == 30.0
    assert manifest.data["media"]["frame_count"] == 2
    assert manifest.resolve_media_path().read_bytes() == b"video-bytes"
    keypoints_path = manifest.resolve_stream_path("keypoints_2d")
    assert keypoints_path is not None
    records = [json.loads(line) for line in keypoints_path.read_text().splitlines()]
    assert records[0]["schema_version"] == "movenet-17/v0-experiment"
    assert records[0]["scene_id"] == "fall_demo_01"
    assert records[0]["person_detected"] is True
    assert records[0]["coordinate_space"] == "normalized_image_top_left"
    assert records[0]["landmark_quality"] == "usable"
    assert records[1]["landmark_quality"] == "degraded"
    assert validate_frame_landmarks_jsonl(
        keypoints_path, expected_scene_id="fall_demo_01"
    ).record_count == 2


def test_load_scene_manifest_rejects_non_positive_demo_time_scale(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "schema_version": "reme-scene/v0-experiment",
                "scene_id": "video_01",
                "title": "test",
                "media": {
                    "local_path": "media/source.mp4",
                    "source_type": "prerecorded_video",
                    "sha256": "0" * 64,
                    "width": 1280,
                    "height": 720,
                    "fps": 30.0,
                    "frame_count": 2,
                    "duration_ms": 66.667,
                    "demo_time_scale": 0,
                },
                "streams": {
                    "keypoints_2d": "keypoints_2d.jsonl",
                    "keypoints_3d": None,
                    "posture_observations": None,
                    "transition_events": None,
                    "recorded_decisions": None,
                },
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(SceneBundleError, match="demo_time_scale"):
        load_scene_manifest(manifest_path)
