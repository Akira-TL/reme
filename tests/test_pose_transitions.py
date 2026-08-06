import json
import math
from pathlib import Path

from reme.runtime.perception.runtime import RuntimeEvent, RuntimeEventType
from reme.runtime.perception.scene_bundle import MOVENET_KEYPOINT_NAMES
from reme.runtime.perception.transition_eval import main as transition_eval_main
from reme.runtime.perception.transitions import TransitionDetector, TransitionDetectorConfig


def _frame(
    sequence: int,
    timestamp_ms: float,
    *,
    center_y: float,
    torso_angle_deg: float,
    scene_id: str = "scene-1",
    session_id: str = "session-1",
    quality: str = "usable",
    visible_ratio: float = 1.0,
    x_shift: float = 0.0,
) -> RuntimeEvent:
    relative = {
        "nose": (0.0, -0.18),
        "left_eye": (-0.02, -0.20),
        "right_eye": (0.02, -0.20),
        "left_ear": (-0.04, -0.19),
        "right_ear": (0.04, -0.19),
        "left_shoulder": (-0.07, -0.08),
        "right_shoulder": (0.07, -0.08),
        "left_elbow": (-0.10, 0.01),
        "right_elbow": (0.10, 0.01),
        "left_wrist": (-0.12, 0.10),
        "right_wrist": (0.12, 0.10),
        "left_hip": (-0.05, 0.06),
        "right_hip": (0.05, 0.06),
        "left_knee": (-0.05, 0.18),
        "right_knee": (0.05, 0.18),
        "left_ankle": (-0.05, 0.30),
        "right_ankle": (0.05, 0.30),
    }
    radians = math.radians(torso_angle_deg)
    cosine = math.cos(radians)
    sine = math.sin(radians)
    visible_count = round(len(MOVENET_KEYPOINT_NAMES) * visible_ratio)
    keypoints = []
    for index, name in enumerate(MOVENET_KEYPOINT_NAMES):
        rel_x, rel_y = relative[name]
        x_norm = 0.5 + x_shift + rel_x * cosine - rel_y * sine
        y_norm = center_y + rel_x * sine + rel_y * cosine
        keypoints.append(
            {
                "name": name,
                "x_norm": round(x_norm, 6),
                "y_norm": round(y_norm, 6),
                "score": 0.95 if index < visible_count else 0.0,
            }
        )
    return RuntimeEvent(
        session_id=session_id,
        sequence=sequence,
        event_type=RuntimeEventType.FRAME_LANDMARKS,
        payload={
            "schema_version": "movenet-17/v0-experiment",
            "scene_id": scene_id,
            "frame_index": sequence,
            "timestamp_ms": timestamp_ms,
            "person_detected": quality != "unavailable",
            "landmark_quality": quality,
            "coordinate_space": "normalized_image_top_left",
            "smoothed": False,
            "keypoints": keypoints,
        },
    )


def _posture(
    sequence: int,
    timestamp_ms: float,
    posture: str,
    *,
    duration_ms: float,
    motion_level: str,
    scene_id: str = "scene-1",
    session_id: str = "session-1",
    quality: str = "usable",
    visible_ratio: float = 1.0,
) -> RuntimeEvent:
    return RuntimeEvent(
        session_id=session_id,
        sequence=sequence,
        event_type=RuntimeEventType.POSTURE_OBSERVATION,
        payload={
            "schema_version": "reme-posture/v0-experiment",
            "scene_id": scene_id,
            "timestamp_ms": timestamp_ms,
            "frame_index": sequence,
            "person_detected": quality != "unavailable",
            "posture": posture,
            "posture_confidence": 0.9,
            "posture_duration_ms": duration_ms,
            "motion_level": motion_level,
            "visible_keypoint_ratio": visible_ratio,
            "landmark_quality": quality,
        },
    )


def _run_trajectory(
    detector: TransitionDetector,
    *,
    centers: list[float],
    angles: list[float],
    postures: list[str],
    interval_ms: float,
) -> list[RuntimeEvent]:
    events: list[RuntimeEvent] = []
    posture_since = 0.0
    previous_posture: str | None = None
    for index, (center, angle, posture) in enumerate(zip(centers, angles, postures, strict=True)):
        timestamp_ms = index * interval_ms
        if posture != previous_posture:
            posture_since = timestamp_ms
            previous_posture = posture
        motion_level = "low" if index == len(centers) - 1 else "medium"
        detector.process_runtime_event(
            _posture(
                index,
                timestamp_ms,
                posture,
                duration_ms=timestamp_ms - posture_since,
                motion_level=motion_level,
            )
        )
        event = detector.process_runtime_event(
            _frame(
                index,
                timestamp_ms,
                center_y=center,
                torso_angle_deg=angle,
            )
        )
        if event is not None:
            events.append(event)
    return events


def _linear(start: float, end: float, count: int) -> list[float]:
    if count == 1:
        return [start]
    return [start + (end - start) * index / (count - 1) for index in range(count)]


def test_normal_sitting_is_one_normal_transition() -> None:
    detector = TransitionDetector(session_id="session-1")
    centers = _linear(0.36, 0.49, 16)
    angles = _linear(0.0, 12.0, 16)
    postures = ["standing"] * 5 + ["sitting"] * 11

    events = _run_trajectory(
        detector,
        centers=centers,
        angles=angles,
        postures=postures,
        interval_ms=120.0,
    )

    assert [event.payload["transition"] for event in events] == ["normal_transition"]
    assert events[0].payload["evidence"]["posture_before"] == "standing"
    assert events[0].payload["evidence"]["posture_after"] == "sitting"


def test_normal_lying_down_is_not_a_fall() -> None:
    detector = TransitionDetector(session_id="session-1")
    centers = _linear(0.36, 0.58, 24)
    angles = _linear(0.0, 82.0, 24)
    postures = ["standing"] * 5 + ["bending_or_crouching"] * 10 + ["lying"] * 9

    events = _run_trajectory(
        detector,
        centers=centers,
        angles=angles,
        postures=postures,
        interval_ms=120.0,
    )

    assert events
    assert all(event.payload["transition"] != "fall_like_transition" for event in events)
    assert events[-1].payload["transition"] == "normal_transition"


def test_bending_then_recovering_is_not_a_fall() -> None:
    detector = TransitionDetector(session_id="session-1")
    centers = _linear(0.36, 0.43, 8) + _linear(0.43, 0.36, 9)[1:]
    angles = _linear(0.0, 48.0, 8) + _linear(48.0, 0.0, 9)[1:]
    postures = ["standing"] * 4 + ["bending_or_crouching"] * 8 + ["standing"] * 4

    events = _run_trajectory(
        detector,
        centers=centers,
        angles=angles,
        postures=postures,
        interval_ms=120.0,
    )

    assert events
    assert all(event.payload["transition"] == "normal_transition" for event in events)


def test_rapid_high_to_low_motion_is_fall_like() -> None:
    detector = TransitionDetector(session_id="session-1")
    centers = [0.35, 0.36, 0.37, 0.43, 0.54, 0.65, 0.66, 0.66, 0.66]
    angles = [0.0, 0.0, 2.0, 20.0, 52.0, 84.0, 86.0, 86.0, 86.0]
    postures = ["standing"] * 3 + ["bending_or_crouching"] * 2 + ["lying"] * 4

    events = _run_trajectory(
        detector,
        centers=centers,
        angles=angles,
        postures=postures,
        interval_ms=100.0,
    )

    assert [event.payload["transition"] for event in events] == ["fall_like_transition"]
    evidence = events[0].payload["evidence"]
    assert evidence["center_height_change"] > 0.2
    assert evidence["peak_keypoint_speed"] > 0.5


def test_rapid_fall_geometry_does_not_require_lying_classification() -> None:
    detector = TransitionDetector(session_id="session-1")
    centers = [0.35, 0.36, 0.37, 0.43, 0.54, 0.65, 0.66, 0.66, 0.66]
    angles = [0.0, 0.0, 2.0, 20.0, 52.0, 84.0, 86.0, 86.0, 86.0]
    postures = ["standing"] * len(centers)

    events = _run_trajectory(
        detector,
        centers=centers,
        angles=angles,
        postures=postures,
        interval_ms=100.0,
    )

    assert [event.payload["transition"] for event in events] == ["fall_like_transition"]
    reasons = events[0].payload["evidence"]["reasons"]
    assert "low_final_center" in reasons
    assert "horizontal_final_torso" in reasons
    assert "high_to_low_posture" not in reasons


def test_single_lying_frame_does_not_emit_fall() -> None:
    detector = TransitionDetector(session_id="session-1")
    detector.process_runtime_event(
        _posture(0, 0.0, "lying", duration_ms=0.0, motion_level="unknown")
    )

    event = detector.process_runtime_event(_frame(0, 0.0, center_y=0.62, torso_angle_deg=88.0))

    assert event is None


def test_missing_keypoints_emits_uncertain_or_no_event() -> None:
    detector = TransitionDetector(session_id="session-1")
    detector.process_runtime_event(
        _posture(0, 0.0, "standing", duration_ms=0.0, motion_level="low")
    )
    assert (
        detector.process_runtime_event(_frame(0, 0.0, center_y=0.35, torso_angle_deg=0.0)) is None
    )
    detector.process_runtime_event(
        _posture(
            1,
            300.0,
            "unknown",
            duration_ms=0.0,
            motion_level="unknown",
            quality="degraded",
            visible_ratio=0.2,
        )
    )

    event = detector.process_runtime_event(
        _frame(
            1,
            300.0,
            center_y=0.60,
            torso_angle_deg=80.0,
            quality="degraded",
            visible_ratio=0.2,
        )
    )

    assert event is None or event.payload["transition"] == "uncertain_transition"
    assert detector.issues
    assert detector.issues[-1].reason == "insufficient_visible_keypoints"


def test_out_of_order_timestamp_is_rejected_without_false_event() -> None:
    detector = TransitionDetector(session_id="session-1")
    detector.process_runtime_event(_frame(0, 200.0, center_y=0.35, torso_angle_deg=0.0))

    event = detector.process_runtime_event(_frame(1, 100.0, center_y=0.65, torso_angle_deg=85.0))

    assert event is None
    assert detector.issues[-1].reason == "timestamp_out_of_order"


def test_camera_jump_is_uncertain_not_fall_like() -> None:
    detector = TransitionDetector(session_id="session-1")
    detector.process_runtime_event(
        _posture(0, 0.0, "standing", duration_ms=0.0, motion_level="low")
    )
    detector.process_runtime_event(_frame(0, 0.0, center_y=0.35, torso_angle_deg=0.0))
    detector.process_runtime_event(
        _posture(1, 100.0, "standing", duration_ms=100.0, motion_level="high")
    )

    event = detector.process_runtime_event(
        _frame(
            1,
            100.0,
            center_y=0.58,
            torso_angle_deg=0.0,
            x_shift=0.22,
        )
    )

    assert event is None or event.payload["transition"] == "uncertain_transition"
    assert detector.issues[-1].reason == "camera_jump"


def test_duplicate_motion_emits_one_event_during_cooldown() -> None:
    detector = TransitionDetector(
        session_id="session-1",
        config=TransitionDetectorConfig(cooldown_ms=2000.0),
    )
    centers = [0.35, 0.36, 0.45, 0.58, 0.65, 0.66, 0.66, 0.66]
    angles = [0.0, 1.0, 25.0, 60.0, 85.0, 86.0, 86.0, 86.0]
    postures = ["standing"] * 2 + ["bending_or_crouching"] * 2 + ["lying"] * 4

    events = _run_trajectory(
        detector,
        centers=centers,
        angles=angles,
        postures=postures,
        interval_ms=100.0,
    )
    for index in range(8, 18):
        timestamp_ms = index * 100.0
        detector.process_runtime_event(
            _posture(
                index,
                timestamp_ms,
                "lying",
                duration_ms=timestamp_ms - 400.0,
                motion_level="still",
            )
        )
        event = detector.process_runtime_event(
            _frame(index, timestamp_ms, center_y=0.66, torso_angle_deg=86.0)
        )
        if event is not None:
            events.append(event)

    assert len(events) == 1


def test_session_reset_discards_partial_window_and_restarts_event_ids() -> None:
    detector = TransitionDetector(session_id="session-1")
    detector.process_runtime_event(
        _posture(0, 0.0, "standing", duration_ms=0.0, motion_level="medium")
    )
    detector.process_runtime_event(_frame(0, 0.0, center_y=0.35, torso_angle_deg=0.0))
    detector.process_runtime_event(
        _posture(1, 100.0, "bending_or_crouching", duration_ms=0.0, motion_level="high")
    )
    detector.process_runtime_event(_frame(1, 100.0, center_y=0.50, torso_angle_deg=45.0))

    detector.reset(session_id="session-2")
    detector.process_runtime_event(
        _posture(
            0,
            0.0,
            "lying",
            duration_ms=1000.0,
            motion_level="still",
            session_id="session-2",
        )
    )
    assert (
        detector.process_runtime_event(
            _frame(
                0,
                0.0,
                center_y=0.65,
                torso_angle_deg=86.0,
                session_id="session-2",
            )
        )
        is None
    )

    centers = [0.35, 0.36, 0.45, 0.58, 0.65, 0.66, 0.66, 0.66]
    angles = [0.0, 1.0, 25.0, 60.0, 85.0, 86.0, 86.0, 86.0]
    postures = ["standing"] * 2 + ["bending_or_crouching"] * 2 + ["lying"] * 4
    events: list[RuntimeEvent] = []
    posture_since = 0.0
    previous_posture: str | None = None
    for index, (center, angle, posture) in enumerate(zip(centers, angles, postures, strict=True)):
        timestamp_ms = 1000.0 + index * 100.0
        if posture != previous_posture:
            posture_since = timestamp_ms
            previous_posture = posture
        detector.process_runtime_event(
            _posture(
                index + 1,
                timestamp_ms,
                posture,
                duration_ms=timestamp_ms - posture_since,
                motion_level="low" if index == len(centers) - 1 else "medium",
                session_id="session-2",
            )
        )
        event = detector.process_runtime_event(
            _frame(
                index + 1,
                timestamp_ms,
                center_y=center,
                torso_angle_deg=angle,
                session_id="session-2",
            )
        )
        if event is not None:
            events.append(event)

    assert events[0].payload["event_id"] == "transition-0001"


def test_offline_command_writes_candidates_and_error_intervals(tmp_path: Path) -> None:
    keypoints_path = tmp_path / "keypoints.jsonl"
    postures_path = tmp_path / "postures.jsonl"
    output_path = tmp_path / "events.jsonl"
    report_path = tmp_path / "report.json"
    frames = [
        _frame(index, index * 100.0, center_y=center, torso_angle_deg=angle).payload
        for index, (center, angle) in enumerate(
            zip(
                [0.35, 0.36, 0.45, 0.58, 0.65, 0.66, 0.66, 0.66],
                [0.0, 1.0, 25.0, 60.0, 85.0, 86.0, 86.0, 86.0],
                strict=True,
            )
        )
    ]
    postures = [
        _posture(
            index,
            index * 100.0,
            posture,
            duration_ms=[0.0, 100.0, 0.0, 100.0, 0.0, 100.0, 200.0, 300.0][index],
            motion_level="low" if index == 7 else "medium",
        ).payload
        for index, posture in enumerate(
            [
                "standing",
                "standing",
                "bending_or_crouching",
                "bending_or_crouching",
                "lying",
                "lying",
                "lying",
                "lying",
            ]
        )
    ]
    keypoints_path.write_text(
        "\n".join(json.dumps(frame) for frame in frames) + "\n",
        encoding="utf-8",
    )
    postures_path.write_text(
        "\n".join(json.dumps(posture) for posture in postures) + "\n",
        encoding="utf-8",
    )

    exit_code = transition_eval_main(
        [
            "--keypoints",
            str(keypoints_path),
            "--postures",
            str(postures_path),
            "--output",
            str(output_path),
            "--report",
            str(report_path),
            "--session-id",
            "offline-test",
        ]
    )

    assert exit_code == 0
    events = [json.loads(line) for line in output_path.read_text(encoding="utf-8").splitlines()]
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert events[0]["transition"] == "fall_like_transition"
    assert report["evaluation_status"] == "candidates_only_unlabelled"
    assert "precision" not in report
    assert report["candidate_event_count"] == 1
