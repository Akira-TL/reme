from collections import deque

import pytest
from reme.runtime.perception.posture import PosturePrediction
from reme.runtime.perception.posture_runtime import (
    PostureRuntimeConfig,
    PostureRuntimeError,
    RealtimePostureTracker,
)
from reme.runtime.perception.runtime import RuntimeEvent, RuntimeEventType
from reme.runtime.perception.scene_bundle import MOVENET_KEYPOINT_NAMES


class StubPredictor:
    def __init__(self, predictions: list[PosturePrediction]) -> None:
        self.predictions = deque(predictions)

    def predict_record(self, record: dict[str, object]) -> PosturePrediction:
        return self.predictions.popleft()


def _prediction(
    posture: str,
    confidence: float = 0.9,
    *,
    source: str = "test_predictor",
) -> PosturePrediction:
    return PosturePrediction(
        posture=posture,
        confidence=confidence,
        probabilities={posture: confidence},
        visible_keypoint_ratio=1.0,
        classification_source=source,
    )


def _frame_event(
    sequence: int,
    timestamp_ms: float,
    *,
    session_id: str = "session-1",
    offset: float = 0.0,
    detected: bool = True,
) -> RuntimeEvent:
    return RuntimeEvent(
        session_id=session_id,
        sequence=sequence,
        event_type=RuntimeEventType.FRAME_LANDMARKS,
        payload={
            "schema_version": "movenet-17/v0-experiment",
            "scene_id": "live-camera-1",
            "frame_index": sequence,
            "timestamp_ms": timestamp_ms,
            "person_detected": detected,
            "landmark_quality": "usable" if detected else "unavailable",
            "coordinate_space": "normalized_image_top_left",
            "smoothed": False,
            "keypoints": [
                {
                    "name": name,
                    "x_norm": 0.4 + index * 0.005 + offset,
                    "y_norm": 0.2 + index * 0.02,
                    "score": 0.9 if detected else 0.0,
                }
                for index, name in enumerate(MOVENET_KEYPOINT_NAMES)
            ],
        },
    )


def test_tracker_emits_at_configured_frequency_and_tracks_duration() -> None:
    predictor = StubPredictor([_prediction("standing") for _ in range(3)])
    tracker = RealtimePostureTracker(
        session_id="session-1",
        predictor=predictor,
        config=PostureRuntimeConfig(output_hz=5.0, smoothing_window=3),
    )

    events = [
        tracker.process_frame_event(_frame_event(index, index * 100.0))
        for index in range(5)
    ]
    emitted = [event for event in events if event is not None]

    assert [event.payload["timestamp_ms"] for event in emitted] == [0.0, 200.0, 400.0]
    assert [event.payload["posture_duration_ms"] for event in emitted] == [0.0, 200.0, 400.0]
    assert emitted[1].payload["motion_level"] == "still"
    assert emitted[1].payload["classification_source"] == "test_predictor"


def test_unknown_is_immediate_and_resets_duration() -> None:
    predictor = StubPredictor(
        [_prediction("standing"), _prediction("standing"), _prediction("unknown", 0.8)]
    )
    tracker = RealtimePostureTracker(
        session_id="session-1",
        predictor=predictor,
        config=PostureRuntimeConfig(output_hz=5.0),
    )

    emitted = [
        tracker.process_frame_event(_frame_event(0, 0.0)),
        tracker.process_frame_event(_frame_event(1, 200.0)),
        tracker.process_frame_event(_frame_event(2, 400.0)),
    ]

    assert emitted[1] is not None
    assert emitted[1].payload["posture_duration_ms"] == 200.0
    assert emitted[2] is not None
    assert emitted[2].payload["posture"] == "unknown"
    assert emitted[2].payload["posture_duration_ms"] == 0.0


def test_tracker_rejects_stale_session_event() -> None:
    tracker = RealtimePostureTracker(
        session_id="session-1",
        predictor=StubPredictor([_prediction("standing")]),
    )

    with pytest.raises(PostureRuntimeError, match="stale session"):
        tracker.process_frame_event(_frame_event(0, 0.0, session_id="session-old"))


def test_tracker_reports_high_motion_for_large_displacement() -> None:
    tracker = RealtimePostureTracker(
        session_id="session-1",
        predictor=StubPredictor([_prediction("standing"), _prediction("standing")]),
        config=PostureRuntimeConfig(output_hz=5.0),
    )

    first = tracker.process_frame_event(_frame_event(0, 0.0))
    second = tracker.process_frame_event(_frame_event(1, 200.0, offset=0.2))

    assert first is not None
    assert second is not None
    assert second.payload["motion_level"] == "high"
