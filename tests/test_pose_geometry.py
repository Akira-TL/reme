import json
from pathlib import Path

import pytest
from reme.pose.geometry import (
    GEOMETRY_MODEL_SCHEMA_VERSION,
    GeometricPostureModel,
    GeometryError,
    GeometryThresholds,
    calibrate_geometry_model,
    extract_geometry_features,
    save_geometry_model,
)
from reme.pose.scene_bundle import MOVENET_KEYPOINT_NAMES


def _coords(label: str) -> list[tuple[float, float]]:
    points = [(0.50, 0.18)] * 17
    shapes: dict[str, dict[int, tuple[float, float]]] = {
        "standing": {
            5: (0.43, 0.30),
            6: (0.57, 0.30),
            11: (0.45, 0.52),
            12: (0.55, 0.52),
            13: (0.45, 0.72),
            14: (0.55, 0.72),
            15: (0.45, 0.92),
            16: (0.55, 0.92),
        },
        "sitting": {
            5: (0.43, 0.30),
            6: (0.57, 0.30),
            11: (0.45, 0.52),
            12: (0.55, 0.52),
            13: (0.36, 0.55),
            14: (0.64, 0.55),
            15: (0.34, 0.76),
            16: (0.66, 0.76),
        },
        "lying": {
            5: (0.30, 0.46),
            6: (0.30, 0.56),
            11: (0.52, 0.46),
            12: (0.52, 0.56),
            13: (0.70, 0.46),
            14: (0.70, 0.56),
            15: (0.88, 0.46),
            16: (0.88, 0.56),
        },
        "bending_or_crouching": {
            5: (0.35, 0.44),
            6: (0.47, 0.46),
            11: (0.53, 0.58),
            12: (0.61, 0.60),
            13: (0.49, 0.69),
            14: (0.65, 0.70),
            15: (0.44, 0.88),
            16: (0.70, 0.88),
        },
        "conflict": {
            5: (0.30, 0.44),
            6: (0.30, 0.56),
            11: (0.52, 0.44),
            12: (0.52, 0.56),
            13: (0.45, 0.62),
            14: (0.59, 0.62),
            15: (0.38, 0.82),
            16: (0.66, 0.82),
        },
    }
    for index, coordinate in shapes[label].items():
        points[index] = coordinate
    return points


def _record(
    label: str,
    timestamp_ms: float = 0.0,
    *,
    detected: bool = True,
    low_score_indices: set[int] | None = None,
) -> dict[str, object]:
    low_score_indices = low_score_indices or set()
    coordinates = _coords(label)
    return {
        "schema_version": "movenet-17/v0-experiment",
        "scene_id": f"scene-{label}",
        "frame_index": int(timestamp_ms / 100.0),
        "timestamp_ms": timestamp_ms,
        "person_detected": detected,
        "landmark_quality": "usable" if detected else "unavailable",
        "coordinate_space": "normalized_image_top_left",
        "smoothed": False,
        "keypoints": [
            {
                "name": name,
                "x_norm": coordinates[index][0],
                "y_norm": coordinates[index][1],
                "score": 0.05 if index in low_score_indices or not detected else 0.95,
            }
            for index, name in enumerate(MOVENET_KEYPOINT_NAMES)
        ],
    }


def _model(*, minimum_margin: float = 0.08) -> GeometricPostureModel:
    return GeometricPostureModel(
        thresholds=GeometryThresholds(minimum_margin=minimum_margin),
        evidence_level="test",
        calibration_splits=("train", "val"),
    )


def test_extract_geometry_features_describes_interpretable_standing_pose() -> None:
    features = extract_geometry_features(_record("standing"))

    assert features.visible_keypoint_ratio == 1.0
    assert features.core_visible_ratio == 1.0
    assert features.torso_angle_from_vertical_deg == pytest.approx(0.0)
    assert features.bbox_aspect_ratio < 0.5
    assert features.knee_angle_mean_deg == pytest.approx(180.0)
    assert features.leg_vertical_order_ratio == 1.0
    assert features.hip_to_ankle_vertical_ratio > 0.5


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("standing", "standing"),
        ("sitting", "sitting"),
        ("lying", "lying"),
        ("bending_or_crouching", "bending_or_crouching"),
    ],
)
def test_rules_classify_canonical_geometry(label: str, expected: str) -> None:
    prediction = _model().predict_record(_record(label))

    assert prediction.posture == expected
    assert prediction.confidence >= 0.5
    assert prediction.evidence[expected] == max(prediction.evidence.values())


def test_insufficient_core_landmarks_are_rejected_without_previous_label() -> None:
    model = _model()
    first = model.predict_record(_record("standing"))
    rejected = model.predict_record(
        _record("standing", 100.0, low_score_indices={5, 6, 11, 12, 13, 14})
    )

    assert first.posture == "standing"
    assert rejected.posture == "unknown"
    assert rejected.reason == "insufficient_landmarks"


def test_rule_conflict_is_rejected() -> None:
    prediction = _model(minimum_margin=0.35).predict_record(_record("conflict"))

    assert prediction.posture == "unknown"
    assert prediction.reason == "conflicting_rules"


def test_model_round_trip_and_invalid_schema(tmp_path: Path) -> None:
    path = tmp_path / "geometry-model.json"
    save_geometry_model(path, _model())

    loaded = GeometricPostureModel.load(path)
    assert loaded.predict_record(_record("lying")).posture == "lying"

    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["schema_version"] = "wrong"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(GeometryError, match=GEOMETRY_MODEL_SCHEMA_VERSION):
        GeometricPostureModel.load(path)


def _write_scene(
    root: Path,
    *,
    scene_id: str,
    label: str,
    split: str,
    record_label: str,
) -> dict[str, object]:
    scene_dir = root / scene_id
    scene_dir.mkdir()
    keypoints_path = scene_dir / "keypoints.jsonl"
    keypoints_path.write_text(
        "".join(
            json.dumps(_record(record_label, timestamp), ensure_ascii=False) + "\n"
            for timestamp in (0.0, 100.0, 200.0)
        ),
        encoding="utf-8",
    )
    annotations_path = scene_dir / "annotations.json"
    annotations_path.write_text(
        json.dumps(
            {
                "schema_version": "reme-pose-annotations/v0-experiment",
                "scene_id": scene_id,
                "posture_segments": [
                    {
                        "start_ms": 0.0,
                        "end_ms": 300.0,
                        "posture": label,
                        "split": split,
                        "person_id": scene_id,
                        "camera_id": scene_id,
                        "notes": None,
                    }
                ],
                "transition_events": [],
            }
        ),
        encoding="utf-8",
    )
    return {
        "scene_id": scene_id,
        "keypoints": str(keypoints_path),
        "annotations": str(annotations_path),
    }


def _write_index(root: Path, *, test_record_label: str) -> Path:
    scenes = [
        _write_scene(
            root,
            scene_id="train-standing",
            label="standing",
            split="train",
            record_label="standing",
        ),
        _write_scene(
            root,
            scene_id="train-sitting",
            label="sitting",
            split="train",
            record_label="sitting",
        ),
        _write_scene(
            root,
            scene_id="train-lying",
            label="lying",
            split="train",
            record_label="lying",
        ),
        _write_scene(
            root,
            scene_id="train-bending",
            label="bending_or_crouching",
            split="train",
            record_label="bending_or_crouching",
        ),
        _write_scene(
            root,
            scene_id="val-standing",
            label="standing",
            split="val",
            record_label="standing",
        ),
        _write_scene(
            root,
            scene_id="val-unknown",
            label="unknown",
            split="val",
            record_label="conflict",
        ),
        _write_scene(
            root,
            scene_id="test-standing",
            label="standing",
            split="test",
            record_label=test_record_label,
        ),
    ]
    index_path = root / "dataset-index.json"
    index_path.write_text(
        json.dumps(
            {
                "schema_version": "reme-pose-dataset-index/v0-experiment",
                "dataset_id": "test",
                "evidence_level": "test",
                "scenes": scenes,
            }
        ),
        encoding="utf-8",
    )
    return index_path


def test_calibration_does_not_use_test_frames(tmp_path: Path) -> None:
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    first_root.mkdir()
    second_root.mkdir()

    first_model, first_metrics = calibrate_geometry_model(
        _write_index(first_root, test_record_label="standing"),
        max_samples_per_scene=3,
    )
    second_model, second_metrics = calibrate_geometry_model(
        _write_index(second_root, test_record_label="lying"),
        max_samples_per_scene=3,
    )

    assert first_model.to_payload() == second_model.to_payload()
    assert first_metrics["calibration_splits"] == ["train", "val"]
    assert first_metrics["metrics"]["test"] != second_metrics["metrics"]["test"]
    assert "rejection_rate" in first_metrics["metrics"]["test"]
    assert "error_ranges" in first_metrics["metrics"]["test"]
