from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from reme.runtime.perception.edge_bundle import (
    BUNDLE_SCHEMA_VERSION,
    FALL_HEAD_SCHEMA_VERSION,
    POSTURE_HEAD_SCHEMA_VERSION,
    CompactFallModel,
    CompactPostureModel,
    EdgeBundleError,
    EdgePerceptionBundle,
)
from reme.runtime.perception.fall_mil import (
    FALL_WINDOW_FEATURE_NAMES,
    FallWindowConfig,
)
from reme.runtime.perception.fall_runtime import FallMILTransitionEnhancer
from reme.runtime.perception.runtime_server import build_runtime_posture_model
from reme.runtime.perception.scene_bundle import MOVENET_KEYPOINT_NAMES


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _posture_payload() -> dict[str, object]:
    return {
        "schema_version": POSTURE_HEAD_SCHEMA_VERSION,
        "source_schema_version": "reme-posture-softmax/v1-experiment",
        "feature_mode": "nose_core_geometry",
        "feature_indices": [0, 1, 34],
        "retained_keypoints": ["nose"],
        "head_tracking_proxy": "nose",
        "ignored_face_keypoints": [
            "left_eye",
            "right_eye",
            "left_ear",
            "right_ear",
        ],
        "labels": ["standing", "sitting", "lying", "bending_or_crouching"],
        "feature_mean_float32": [0.0, 0.0, 0.0],
        "feature_scale_float32": [1.0, 1.0, 1.0],
        "weights_int16": [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        "weight_scales_per_feature_float32": [1.0, 1.0, 1.0],
        "bias_float32": [4.0, 0.0, 0.0, 0.0],
        "centroids_int16": [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
        "centroid_scales_float32": [1.0, 1.0, 1.0],
        "distance_normalization_feature_count": 68,
        "confidence_threshold": 0.3,
        "distance_threshold": 10.0,
        "score_threshold": 0.2,
        "min_visible_ratio": 0.35,
        "evidence_level": "test",
    }


def _fall_payload() -> dict[str, object]:
    feature_count = len(FALL_WINDOW_FEATURE_NAMES)
    return {
        "schema_version": FALL_HEAD_SCHEMA_VERSION,
        "source_schema_version": "reme-fall-mil/v2-experiment",
        "feature_names": list(FALL_WINDOW_FEATURE_NAMES),
        "feature_mean_float32": [0.0] * feature_count,
        "feature_scale_float32": [1.0] * feature_count,
        "weights_int16": [0] * feature_count,
        "weight_scale_float32": 1.0,
        "bias_float32": 0.0,
        "threshold": 0.9,
        "window_config": FallWindowConfig().to_payload(),
        "evidence_level": "test",
    }


def _record() -> dict[str, object]:
    return {
        "person_detected": True,
        "keypoints": [
            {
                "name": name,
                "x_norm": 0.45 + index * 0.002,
                "y_norm": 0.25 + index * 0.02,
                "score": 1.0,
            }
            for index, name in enumerate(MOVENET_KEYPOINT_NAMES)
        ],
    }


def _bundle(tmp_path: Path) -> Path:
    root = tmp_path / "bundle"
    pose = root / "models/pose_int8.tflite"
    posture = root / "models/posture_head.int16.json"
    fall = root / "models/fall_head.int16.json"
    pose.parent.mkdir(parents=True)
    pose.write_bytes(b"fake-int8-pose-model")
    _write_json(posture, _posture_payload())
    _write_json(fall, _fall_payload())
    files = {
        "pose_model": {"path": "models/pose_int8.tflite", "sha256": _sha256(pose)},
        "posture_head": {
            "path": "models/posture_head.int16.json",
            "sha256": _sha256(posture),
        },
        "fall_head": {
            "path": "models/fall_head.int16.json",
            "sha256": _sha256(fall),
        },
    }
    _write_json(
        root / "manifest.json",
        {
            "schema_version": BUNDLE_SCHEMA_VERSION,
            "deployment_status": (
                "budget_and_quantization_gate_passed_target_npu_unverified"
            ),
            "files": files,
        },
    )
    return root


def test_compact_posture_keeps_nose_and_ignores_eye_and_ear_features(
    tmp_path: Path,
) -> None:
    path = tmp_path / "posture.json"
    _write_json(path, _posture_payload())
    model = CompactPostureModel.load(path)
    first = model.predict_record(_record())
    changed = _record()
    keypoints = changed["keypoints"]
    assert isinstance(keypoints, list)
    for index in range(1, 5):
        point = keypoints[index]
        assert isinstance(point, dict)
        point["x_norm"] = 0.0
        point["y_norm"] = 1.0
    second = model.predict_record(changed)
    assert first.posture == "standing"
    assert second.posture == first.posture
    assert second.probabilities == first.probabilities
    assert second.classification_source == "edge_int16"


def test_compact_fall_head_matches_linear_probability(tmp_path: Path) -> None:
    path = tmp_path / "fall.json"
    _write_json(path, _fall_payload())
    model = CompactFallModel.load(path)
    assert model.predict_probability([0.0] * len(FALL_WINDOW_FEATURE_NAMES)) == 0.5


def test_edge_bundle_validates_hashes_and_runtime_loaders(tmp_path: Path) -> None:
    root = _bundle(tmp_path)
    bundle = EdgePerceptionBundle.load(root)
    assert bundle.pose_model_path.name == "pose_int8.tflite"
    assert bundle.posture_model.predict_record(_record()).posture == "standing"

    hybrid = build_runtime_posture_model(
        root / "models/posture_head.int16.json",
        score_threshold=0.2,
    )
    assert isinstance(hybrid.primary, CompactPostureModel)
    enhancer = FallMILTransitionEnhancer.load(
        session_id="edge-test",
        model_path=root / "models/fall_head.int16.json",
    )
    assert isinstance(enhancer.model, CompactFallModel)
    assert enhancer.model_name == "edge-int16"


def test_edge_bundle_rejects_modified_model_file(tmp_path: Path) -> None:
    root = _bundle(tmp_path)
    (root / "models/posture_head.int16.json").write_text("{}", encoding="utf-8")
    with pytest.raises(EdgeBundleError, match="hash mismatch"):
        EdgePerceptionBundle.load(root)
