import json
from pathlib import Path

import pytest
from reme.pose.video_dataset import (
    DATASET_SCHEMA_VERSION,
    DatasetCatalog,
    VideoDatasetError,
)


def _catalog_payload() -> dict[str, object]:
    return {
        "schema_version": DATASET_SCHEMA_VERSION,
        "dataset_id": "test-dataset",
        "label_source": "filename_inference",
        "evidence_level": "weak_label_bootstrap",
        "root": "raw",
        "sample_fps": 10.0,
        "clips": [
            {
                "scene_id": "scene-a",
                "file": "standing.mp4",
                "split": "train",
                "label": "standing",
                "start_ratio": 0.2,
                "end_ratio": 0.8,
                "notes": None,
            }
        ],
    }


def test_catalog_validates_selected_direct_files(tmp_path: Path) -> None:
    raw_dir = tmp_path / "raw"
    raw_dir.mkdir()
    (raw_dir / "standing.mp4").write_bytes(b"video")
    catalog_path = tmp_path / "catalog.json"
    catalog_path.write_text(json.dumps(_catalog_payload()), encoding="utf-8")

    catalog = DatasetCatalog.load(catalog_path, project_root=tmp_path)

    assert catalog.validate_files() == {
        "dataset_id": "test-dataset",
        "root": str(raw_dir.resolve()),
        "selected_clip_count": 1,
        "split_counts": {"train": 1},
        "label_counts": {"standing": 1},
        "sample_fps": 10.0,
        "label_source": "filename_inference",
        "evidence_level": "weak_label_bootstrap",
    }


def test_catalog_rejects_missing_selected_file(tmp_path: Path) -> None:
    catalog_path = tmp_path / "catalog.json"
    catalog_path.write_text(json.dumps(_catalog_payload()), encoding="utf-8")
    catalog = DatasetCatalog.load(catalog_path, project_root=tmp_path)

    with pytest.raises(VideoDatasetError, match="missing"):
        catalog.validate_files()


def test_catalog_rejects_duplicate_scene_ids(tmp_path: Path) -> None:
    payload = _catalog_payload()
    clips = payload["clips"]
    assert isinstance(clips, list)
    clips.append(dict(clips[0]))
    catalog_path = tmp_path / "catalog.json"
    catalog_path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(VideoDatasetError, match="scene_id values must be unique"):
        DatasetCatalog.load(catalog_path, project_root=tmp_path)
