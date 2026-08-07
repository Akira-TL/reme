from __future__ import annotations

from reme.runtime.perception.fall_training_data import derive_fall_pose_sample
from reme.runtime.perception.posture import PosturePrediction
from reme.runtime.perception.scene_bundle import MOVENET_KEYPOINT_NAMES


def _record(timestamp_ms: float, *, y_shift: float = 0.0) -> dict[str, object]:
    coords = {
        "nose": (0.50, 0.15),
        "left_eye": (0.48, 0.14),
        "right_eye": (0.52, 0.14),
        "left_ear": (0.46, 0.16),
        "right_ear": (0.54, 0.16),
        "left_shoulder": (0.45, 0.30),
        "right_shoulder": (0.55, 0.30),
        "left_elbow": (0.43, 0.45),
        "right_elbow": (0.57, 0.45),
        "left_wrist": (0.42, 0.58),
        "right_wrist": (0.58, 0.58),
        "left_hip": (0.47, 0.55),
        "right_hip": (0.53, 0.55),
        "left_knee": (0.47, 0.75),
        "right_knee": (0.53, 0.75),
        "left_ankle": (0.47, 0.95),
        "right_ankle": (0.53, 0.95),
    }
    return {
        "timestamp_ms": timestamp_ms,
        "person_detected": True,
        "landmark_quality": "usable",
        "keypoints": [
            {
                "name": name,
                "x_norm": coords[name][0],
                "y_norm": min(coords[name][1] + y_shift, 1.0),
                "score": 0.9,
            }
            for name in MOVENET_KEYPOINT_NAMES
        ],
    }


def test_derive_fall_pose_sample_extracts_geometry_and_motion() -> None:
    previous = _record(0.0)
    current = _record(100.0, y_shift=0.05)
    prediction = PosturePrediction(
        posture="standing",
        confidence=0.8,
        probabilities={"standing": 0.8},
        visible_keypoint_ratio=1.0,
    )

    sample = derive_fall_pose_sample(
        current,
        prediction=prediction,
        previous_record=previous,
        score_threshold=0.2,
    )

    assert sample.posture == "standing"
    assert sample.posture_confidence == 0.8
    assert sample.visible_keypoint_ratio == 1.0
    assert sample.landmark_quality == "usable"
    assert sample.center_y > 0.5
    assert sample.torso_angle_deg == 0.0
    assert sample.bbox_aspect_ratio < 0.3
    assert 0.49 < sample.motion_speed < 0.51


def test_derive_fall_pose_sample_returns_zero_motion_without_previous_frame() -> None:
    prediction = PosturePrediction(
        posture="standing",
        confidence=0.8,
        probabilities={"standing": 0.8},
        visible_keypoint_ratio=1.0,
    )

    sample = derive_fall_pose_sample(
        _record(0.0),
        prediction=prediction,
        previous_record=None,
        score_threshold=0.2,
    )

    assert sample.motion_speed == 0.0
