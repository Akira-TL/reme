from pathlib import Path

import pytest
from reme.pose.review import PoseReviewError, build_pose_review_page


def _write_manifest(bundle_dir: Path, *, include_skeleton: bool = True) -> Path:
    (bundle_dir / "media").mkdir(parents=True)
    (bundle_dir / "derived").mkdir(parents=True)
    (bundle_dir / "media" / "source.mp4").write_bytes(b"source")
    if include_skeleton:
        (bundle_dir / "derived" / "skeleton.mp4").write_bytes(b"skeleton")
    manifest = bundle_dir / "manifest.json"
    skeleton_reference = '"skeleton_video": "derived/skeleton.mp4"' if include_skeleton else ""
    manifest.write_text(
        f"""{{
  "schema_version": "reme-scene/v0-experiment",
  "scene_id": "video_01",
  "title": "测试场景",
  "media": {{
    "local_path": "media/source.mp4",
    "sha256": "{'0' * 64}",
    "width": 1280,
    "height": 720,
    "fps": 30.0,
    "frame_count": 2,
    "duration_ms": 66.667
  }},
  "streams": {{
    "keypoints_2d": "keypoints_2d.jsonl",
    "keypoints_3d": null,
    "posture_observations": null,
    "transition_events": null,
    "recorded_decisions": null
  }},
  "diagnostics": {{
    {skeleton_reference}
  }}
}}
""",
        encoding="utf-8",
    )
    return manifest


def test_build_pose_review_page_links_both_videos_and_candidate_times(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path / "bundle")
    output = tmp_path / "bundle" / "review.html"

    result = build_pose_review_page(
        manifest,
        output,
        candidate_times_ms=[18200.0, 51133.333],
    )

    html = result.read_text(encoding="utf-8")
    assert result == output
    assert "media/source.mp4" in html
    assert "derived/skeleton.mp4" in html
    assert "18.200 秒" in html
    assert "51.133 秒" in html
    assert 'data-time-seconds="18.2"' in html


def test_build_pose_review_page_requires_skeleton_diagnostic(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path / "bundle", include_skeleton=False)

    with pytest.raises(PoseReviewError, match="skeleton_video"):
        build_pose_review_page(manifest, tmp_path / "bundle" / "review.html", [])
