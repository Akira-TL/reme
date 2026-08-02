from collections.abc import Iterator

import pytest
from reme.pose.camera import (
    CameraConfig,
    CameraStreamError,
    LiveMoveNetStream,
    _opencv_camera_backend,
)
from reme.pose.movenet import MoveNetKeypoint, MoveNetResult


class FakeFrameSource:
    def __init__(self, frames: list[object]) -> None:
        self._frames = iter(frames)
        self.opened = False
        self.closed = False

    def open(self) -> None:
        self.opened = True

    def read(self) -> object | None:
        return next(self._frames, None)

    def close(self) -> None:
        self.closed = True


class FakeEstimator:
    def __init__(self, results: list[MoveNetResult]) -> None:
        self._results: Iterator[MoveNetResult] = iter(results)
        self.reset_count = 0

    def reset(self) -> None:
        self.reset_count += 1

    def infer(self, frame: object) -> MoveNetResult:
        del frame
        return next(self._results)


def _result(*, detected: bool, quality: str, inference_ms: float) -> MoveNetResult:
    return MoveNetResult(
        keypoints=tuple(
            MoveNetKeypoint(name=name, x_norm=0.4, y_norm=0.5, score=0.9)
            for name in (
                "nose",
                "left_eye",
                "right_eye",
                "left_ear",
                "right_ear",
                "left_shoulder",
                "right_shoulder",
                "left_elbow",
                "right_elbow",
                "left_wrist",
                "right_wrist",
                "left_hip",
                "right_hip",
                "left_knee",
                "right_knee",
                "left_ankle",
                "right_ankle",
            )
        ),
        person_detected=detected,
        landmark_quality=quality,
        inference_ms=inference_ms,
    )


def _clock(values: list[float]):
    iterator = iter(values)
    return lambda: next(iterator)


def test_live_stream_wraps_frame_landmarks_in_runtime_events() -> None:
    source = FakeFrameSource([object(), object()])
    estimator = FakeEstimator(
        [
            _result(detected=True, quality="usable", inference_ms=4.0),
            _result(detected=False, quality="unavailable", inference_ms=5.0),
        ]
    )
    stream = LiveMoveNetStream(
        session_id="session-live-001",
        scene_id="live-camera-001",
        frame_source=source,
        estimator=estimator,
        clock=_clock([100.0, 100.01, 100.015, 100.04, 100.046, 100.05]),
    )

    events = list(stream.iter_events(max_frames=2))

    assert source.opened is True
    assert source.closed is True
    assert estimator.reset_count == 1
    assert [event.sequence for event in events] == [0, 1]
    assert all(event.session_id == "session-live-001" for event in events)
    assert events[0].payload["scene_id"] == "live-camera-001"
    assert events[0].payload["timestamp_ms"] == 10.0
    assert events[0].payload["person_detected"] is True
    assert events[1].payload["timestamp_ms"] == 40.0
    assert events[1].payload["landmark_quality"] == "unavailable"
    assert stream.summary is not None
    assert stream.summary.processed_frames == 2
    assert stream.summary.inference_ms_average == 4.5
    assert stream.summary.processing_ms_average == 5.5
    assert stream.summary.processing_ms_p95 == 5.95
    assert stream.summary.elapsed_seconds == pytest.approx(0.05)
    assert stream.summary.output_fps == pytest.approx(40.0)


def test_live_stream_closes_camera_when_inference_fails() -> None:
    source = FakeFrameSource([object()])

    class FailingEstimator(FakeEstimator):
        def infer(self, frame: object) -> MoveNetResult:
            del frame
            raise RuntimeError("inference failed")

    stream = LiveMoveNetStream(
        session_id="session-live-001",
        scene_id="live-camera-001",
        frame_source=source,
        estimator=FailingEstimator([]),
        clock=_clock([100.0, 100.01, 100.02]),
    )

    with pytest.raises(RuntimeError, match="inference failed"):
        list(stream.iter_events(max_frames=1))

    assert source.closed is True


def test_closing_iterator_after_one_event_counts_the_emitted_frame() -> None:
    source = FakeFrameSource([object(), object()])
    estimator = FakeEstimator(
        [
            _result(detected=True, quality="usable", inference_ms=4.0),
            _result(detected=True, quality="usable", inference_ms=4.0),
        ]
    )
    stream = LiveMoveNetStream(
        session_id="session-live-001",
        scene_id="live-camera-001",
        frame_source=source,
        estimator=estimator,
        clock=_clock([100.0, 100.01, 100.015, 100.02]),
    )

    events = stream.iter_events(max_frames=2)
    first = next(events)
    events.close()

    assert first.sequence == 0
    assert source.closed is True
    assert stream.summary is not None
    assert stream.summary.processed_frames == 1


def test_stream_stops_when_session_is_no_longer_active() -> None:
    source = FakeFrameSource([object(), object()])
    estimator = FakeEstimator(
        [
            _result(detected=True, quality="usable", inference_ms=4.0),
            _result(detected=True, quality="usable", inference_ms=4.0),
        ]
    )
    active_checks = iter([True, False])
    stream = LiveMoveNetStream(
        session_id="session-live-001",
        scene_id="live-camera-001",
        frame_source=source,
        estimator=estimator,
        clock=_clock([100.0, 100.01, 100.015, 100.02]),
        is_session_active=lambda _session_id: next(active_checks),
    )

    events = list(stream.iter_events())

    assert len(events) == 1
    assert source.closed is True
    assert stream.summary is not None
    assert stream.summary.processed_frames == 1


def test_camera_config_rejects_invalid_values() -> None:
    with pytest.raises(CameraStreamError, match="width"):
        CameraConfig(width=0)
    with pytest.raises(CameraStreamError, match="fps"):
        CameraConfig(fps=0)
    with pytest.raises(CameraStreamError, match="device_index"):
        CameraConfig(device_index=-1)
    with pytest.raises(CameraStreamError, match="device_index"):
        CameraConfig(device_index=0.5)  # type: ignore[arg-type]


def test_camera_backend_matches_operating_system() -> None:
    class FakeCV2:
        CAP_ANY = 0
        CAP_AVFOUNDATION = 1200
        CAP_V4L2 = 200
        CAP_DSHOW = 700

    cv2 = FakeCV2()

    assert _opencv_camera_backend(cv2, "darwin") == cv2.CAP_AVFOUNDATION
    assert _opencv_camera_backend(cv2, "linux") == cv2.CAP_V4L2
    assert _opencv_camera_backend(cv2, "win32") == cv2.CAP_DSHOW
    assert _opencv_camera_backend(cv2, "freebsd") == cv2.CAP_ANY
