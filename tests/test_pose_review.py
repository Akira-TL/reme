import json
from pathlib import Path

import pytest
from reme.pose.review import PoseReviewError, build_pose_review_page


def _write_manifest(bundle_dir: Path) -> Path:
    (bundle_dir / "media").mkdir(parents=True)
    (bundle_dir / "media" / "source.mp4").write_bytes(b"source")
    (bundle_dir / "keypoints_2d.jsonl").write_text("{}\n", encoding="utf-8")
    manifest = bundle_dir / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schema_version": "reme-scene/v0-experiment",
                "scene_id": "video_01",
                "title": "测试场景",
                "media": {
                    "local_path": "media/source.mp4",
                    "sha256": "0" * 64,
                    "width": 1280,
                    "height": 720,
                    "fps": 30.0,
                    "frame_count": 2,
                    "duration_ms": 66.667,
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
    return manifest


def _write_motionbert_poses(path: Path, *, frame_count: int = 2) -> Path:
    frame = [[float(index), float(index + 1), float(index + 2)] for index in range(17)]
    path.write_text(
        json.dumps(
            {
                "schema": "motionbert-h36m-17/offline-demo-v1",
                "model": {"name": "MotionBERT DSTFormer"},
                "video": {
                    "name": "source.mp4",
                    "width": 1280,
                    "height": 720,
                    "fps": 30.0,
                    "frame_count": frame_count,
                    "duration_seconds": frame_count / 30.0,
                },
                "coordinate_system": {"root_relative": True},
                "joint_names": [f"joint_{index}" for index in range(17)],
                "edges": [[index, index + 1] for index in range(16)],
                "frames": [frame for _ in range(frame_count)],
                "scores": [[0.9] * 17 for _ in range(frame_count)],
                "runtime": {"device": "cuda"},
                "warning": "test fixture",
            }
        ),
        encoding="utf-8",
    )
    return path


def _write_vendor(vendor_dir: Path) -> Path:
    vendor_dir.mkdir()
    for filename in ("three.module.js", "three.core.js", "OrbitControls.js"):
        (vendor_dir / filename).write_text(f"// {filename}\n", encoding="utf-8")
    return vendor_dir


def test_build_pose_review_page_uses_threejs_canvas_and_motionbert_data(
    tmp_path: Path,
) -> None:
    bundle = tmp_path / "bundle"
    manifest = _write_manifest(bundle)
    poses = _write_motionbert_poses(tmp_path / "poses3d.json")
    vendor = _write_vendor(tmp_path / "vendor-source")
    output = bundle / "review.html"

    result = build_pose_review_page(
        manifest,
        output,
        candidate_times_ms=[18200.0, 51133.333],
        poses_3d_path=poses,
        vendor_dir=vendor,
    )

    html = result.read_text(encoding="utf-8")
    updated_manifest = json.loads(manifest.read_text(encoding="utf-8"))
    poses_payload = json.loads((bundle / "derived" / "poses3d.json").read_text())

    assert result == output
    assert html.count("<video") == 1
    assert '<canvas id="pose-canvas"' in html
    assert "derived/poses3d.json" in html
    assert "vendor/three.module.js" in html
    assert "vendor/OrbitControls.js" in html
    assert "18.200 秒" in html
    assert "51.133 秒" in html
    assert "derived/skeleton.mp4" not in html
    assert updated_manifest["streams"]["keypoints_3d"] == "derived/poses3d.json"
    assert poses_payload["schema_version"] == "reme-keypoints-3d/v0-experiment"
    assert poses_payload["scene_id"] == "video_01"
    assert poses_payload["source_schema"] == "motionbert-h36m-17/offline-demo-v1"
    assert (bundle / "vendor" / "three.module.js").is_file()
    assert (bundle / "vendor" / "OrbitControls.js").is_file()


def test_build_pose_review_page_rejects_3d_frame_count_mismatch(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle"
    manifest = _write_manifest(bundle)
    poses = _write_motionbert_poses(tmp_path / "poses3d.json", frame_count=1)
    vendor = _write_vendor(tmp_path / "vendor-source")

    with pytest.raises(PoseReviewError, match="frame_count"):
        build_pose_review_page(
            manifest,
            bundle / "review.html",
            [],
            poses_3d_path=poses,
            vendor_dir=vendor,
        )
