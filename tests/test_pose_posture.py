import json
from pathlib import Path

import numpy as np
from reme.pose.annotations import PoseAnnotations, PostureSegment, save_annotations
from reme.pose.posture import (
    StaticPostureModel,
    extract_posture_features,
    save_posture_model,
    train_posture_model,
)
from reme.pose.scene_bundle import MOVENET_KEYPOINT_NAMES


def _coords(label: str) -> list[tuple[float, float]]:
    base = [(0.5, 0.2)] * 17
    if label == "standing":
        points = {
            5: (0.43, 0.30), 6: (0.57, 0.30),
            11: (0.45, 0.52), 12: (0.55, 0.52),
            13: (0.45, 0.72), 14: (0.55, 0.72),
            15: (0.45, 0.92), 16: (0.55, 0.92),
        }
    elif label == "sitting":
        points = {
            5: (0.43, 0.30), 6: (0.57, 0.30),
            11: (0.44, 0.54), 12: (0.56, 0.54),
            13: (0.35, 0.60), 14: (0.65, 0.60),
            15: (0.33, 0.82), 16: (0.67, 0.82),
        }
    elif label == "lying":
        points = {
            5: (0.32, 0.48), 6: (0.34, 0.56),
            11: (0.54, 0.48), 12: (0.56, 0.56),
            13: (0.70, 0.48), 14: (0.72, 0.56),
            15: (0.88, 0.48), 16: (0.90, 0.56),
        }
    elif label == "bending_or_crouching":
        points = {
            5: (0.36, 0.50), 6: (0.48, 0.52),
            11: (0.52, 0.58), 12: (0.60, 0.60),
            13: (0.48, 0.72), 14: (0.62, 0.72),
            15: (0.44, 0.90), 16: (0.66, 0.90),
        }
    else:
        points = {
            5: (0.25, 0.44), 6: (0.25, 0.56),
            11: (0.52, 0.44), 12: (0.52, 0.56),
            13: (0.72, 0.40), 14: (0.72, 0.60),
            15: (0.88, 0.36), 16: (0.88, 0.64),
        }
    for index, value in points.items():
        base[index] = value
    return base


def _record(label: str, timestamp_ms: float, *, detected: bool = True) -> dict[str, object]:
    coords = _coords(label)
    return {
        "schema_version": "movenet-17/v0-experiment",
        "scene_id": f"scene-{label}",
        "frame_index": int(timestamp_ms / 100),
        "timestamp_ms": timestamp_ms,
        "person_detected": detected,
        "landmark_quality": "usable" if detected else "unavailable",
        "coordinate_space": "normalized_image_top_left",
        "smoothed": False,
        "keypoints": [
            {
                "name": name,
                "x_norm": coords[index][0],
                "y_norm": coords[index][1],
                "score": 0.95 if detected else 0.0,
            }
            for index, name in enumerate(MOVENET_KEYPOINT_NAMES)
        ],
    }


def test_extract_posture_features_is_finite() -> None:
    feature, visible_ratio = extract_posture_features(_record("standing", 0.0))

    assert feature.shape == (68,)
    assert np.isfinite(feature).all()
    assert visible_ratio == 1.0


def test_model_rejects_undetected_person_as_unknown() -> None:
    feature, _ = extract_posture_features(_record("standing", 0.0))
    model = StaticPostureModel(
        labels=("standing", "sitting", "lying", "bending_or_crouching"),
        feature_mean=np.zeros(feature.size),
        feature_scale=np.ones(feature.size),
        weights=np.zeros((feature.size, 4)),
        bias=np.asarray([10.0, 0.0, 0.0, 0.0]),
        class_centroids=np.zeros((4, feature.size)),
        confidence_threshold=0.5,
        distance_threshold=10.0,
        score_threshold=0.2,
        min_visible_ratio=0.35,
        evidence_level="test",
    )

    prediction = model.predict_record(_record("standing", 0.0, detected=False))

    assert prediction.posture == "unknown"
    assert prediction.confidence == 1.0


def test_train_and_reload_small_separable_dataset(tmp_path: Path) -> None:
    scenes: list[dict[str, object]] = []
    labels = ("standing", "sitting", "lying", "bending_or_crouching", "unknown")
    for label in labels:
        scene_id = f"scene-{label}"
        scene_dir = tmp_path / scene_id
        scene_dir.mkdir()
        keypoints_path = scene_dir / "keypoints.jsonl"
        keypoints_path.write_text(
            "".join(
                json.dumps(_record(label, timestamp), ensure_ascii=False) + "\n"
                for timestamp in (0.0, 100.0, 200.0, 300.0)
            ),
            encoding="utf-8",
        )
        annotations_path = scene_dir / "annotations.json"
        save_annotations(
            annotations_path,
            PoseAnnotations(
                scene_id=scene_id,
                posture_segments=(
                    PostureSegment(
                        start_ms=0.0,
                        end_ms=400.0,
                        posture=label,
                        split="train",
                        person_id=scene_id,
                        camera_id=scene_id,
                    ),
                ),
                transition_events=(),
            ),
        )
        scenes.append(
            {
                "scene_id": scene_id,
                "keypoints": str(keypoints_path),
                "annotations": str(annotations_path),
            }
        )
    index_path = tmp_path / "dataset-index.json"
    index_path.write_text(
        json.dumps(
            {
                "schema_version": "reme-pose-dataset-index/v0-experiment",
                "scenes": scenes,
            }
        ),
        encoding="utf-8",
    )

    model, metrics = train_posture_model(index_path, epochs=150, learning_rate=0.03)
    model_path = tmp_path / "model.json"
    save_posture_model(model_path, model)
    loaded = StaticPostureModel.load(model_path)

    assert metrics["sample_count"] == 20
    assert loaded.predict_record(_record("lying", 0.0)).posture == "lying"
