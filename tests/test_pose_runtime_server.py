from __future__ import annotations

import base64
import hashlib
import json
import queue
import socket
import sys
import threading
import time
import types
import urllib.error
import urllib.request
from collections.abc import Callable
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Protocol

import pytest
import reme.runtime.perception.runtime_server as runtime_server_module
from reme.runtime.perception.c_stream import CSceneSignal, CVideoFrame
from reme.runtime.perception.posture import PosturePrediction
from reme.runtime.perception.runtime import (
    ModeProfile,
    RuntimeEvent,
    RuntimeEventType,
    RuntimeSessionRequest,
    RuntimeSessionState,
)
from reme.runtime.perception.runtime_server import (
    CCameraWebSocketPerceptionWorker,
    EventBroker,
    HybridPostureModel,
    PerceptionWorker,
    RuntimePerceptionController,
    build_runtime_handler,
    derive_live_perception_events,
    encode_websocket_frame,
)
from reme.runtime.perception.scene_bundle import MOVENET_KEYPOINT_NAMES


class Publish(Protocol):
    def __call__(self, event: RuntimeEvent) -> None: ...


class FixedPosturePredictor:
    def __init__(self, prediction: PosturePrediction) -> None:
        self.prediction = prediction
        self.calls = 0

    def predict_record(self, record: dict[str, object]) -> PosturePrediction:
        del record
        self.calls += 1
        return self.prediction


class FakePostureTracker:
    def process_frame_event(self, event: RuntimeEvent) -> RuntimeEvent:
        return RuntimeEvent(
            session_id=event.session_id,
            sequence=event.sequence,
            event_type=RuntimeEventType.POSTURE_OBSERVATION,
            payload={"scene_id": "live-camera-001", "posture": "standing"},
        )


class FakeTransitionDetector:
    def __init__(self) -> None:
        self.inputs: list[RuntimeEventType] = []

    def process_runtime_event(self, event: RuntimeEvent) -> RuntimeEvent | None:
        self.inputs.append(event.event_type)
        if event.event_type is not RuntimeEventType.FRAME_LANDMARKS:
            return None
        return RuntimeEvent(
            session_id=event.session_id,
            sequence=event.sequence,
            event_type=RuntimeEventType.TRANSITION_EVENT,
            payload={"scene_id": "live-camera-001", "transition": "normal_transition"},
        )


class FakeWorker(PerceptionWorker):
    def __init__(self) -> None:
        self.started = threading.Event()
        self.stopped = threading.Event()

    def run(
        self,
        request: RuntimeSessionRequest,
        *,
        publish: Publish,
        mark_running: Callable[[], None],
        is_active: Callable[[], bool],
    ) -> None:
        mark_running()
        self.started.set()
        publish(
            RuntimeEvent(
                session_id=request.session_id,
                sequence=0,
                event_type=RuntimeEventType.FRAME_LANDMARKS,
                payload={"scene_id": request.scene_id, "frame_index": 0},
            )
        )
        while is_active():
            time.sleep(0.005)
        self.stopped.set()


def _live_request(session_id: str = "session-live-001") -> RuntimeSessionRequest:
    return RuntimeSessionRequest(
        session_id=session_id,
        profile=ModeProfile.LIVE_CAMERA,
        scene_id="live-camera-001",
        camera_id="default",
    )


def _wait_until(predicate: Callable[[], bool], timeout: float = 1.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("condition was not met before timeout")


def test_hybrid_posture_model_uses_geometry_only_after_softmax_rejects() -> None:
    primary = FixedPosturePredictor(
        PosturePrediction(
            posture="unknown",
            confidence=0.8,
            probabilities={"unknown": 0.8},
            visible_keypoint_ratio=0.9,
            classification_source="softmax_reject",
        )
    )
    fallback = FixedPosturePredictor(
        PosturePrediction(
            posture="standing",
            confidence=0.7,
            probabilities={"standing": 0.7},
            visible_keypoint_ratio=0.9,
            classification_source="geometry",
        )
    )
    model = HybridPostureModel(primary=primary, fallback=fallback)  # type: ignore[arg-type]

    prediction = model.predict_record({})

    assert prediction.posture == "standing"
    assert prediction.classification_source == "geometry_fallback"
    assert primary.calls == 1
    assert fallback.calls == 1


def test_hybrid_posture_model_preserves_known_softmax_prediction() -> None:
    primary = FixedPosturePredictor(
        PosturePrediction(
            posture="sitting",
            confidence=0.75,
            probabilities={"sitting": 0.75},
            visible_keypoint_ratio=0.9,
            classification_source="softmax",
        )
    )
    fallback = FixedPosturePredictor(
        PosturePrediction(
            posture="standing",
            confidence=0.7,
            probabilities={"standing": 0.7},
            visible_keypoint_ratio=0.9,
            classification_source="geometry",
        )
    )
    model = HybridPostureModel(primary=primary, fallback=fallback)  # type: ignore[arg-type]

    prediction = model.predict_record({})

    assert prediction.posture == "sitting"
    assert prediction.classification_source == "softmax"
    assert primary.calls == 1
    assert fallback.calls == 0


def test_live_pipeline_publishes_frame_posture_transition_in_order() -> None:
    frame = RuntimeEvent(
        session_id="session-live-001",
        sequence=8,
        event_type=RuntimeEventType.FRAME_LANDMARKS,
        payload={"scene_id": "live-camera-001", "frame_index": 8},
    )
    detector = FakeTransitionDetector()

    events = derive_live_perception_events(
        frame,
        posture_tracker=FakePostureTracker(),
        transition_detector=detector,
    )

    assert [event.event_type for event in events] == [
        RuntimeEventType.FRAME_LANDMARKS,
        RuntimeEventType.POSTURE_OBSERVATION,
        RuntimeEventType.TRANSITION_EVENT,
    ]
    assert detector.inputs == [
        RuntimeEventType.POSTURE_OBSERVATION,
        RuntimeEventType.FRAME_LANDMARKS,
    ]
    assert all(event.session_id == "session-live-001" for event in events)
    assert all(event.sequence == 8 for event in events)


def test_event_broker_fans_out_and_closes_one_session() -> None:
    broker = EventBroker(queue_size=2)
    first = broker.subscribe("session-a")
    second = broker.subscribe("session-a")
    other = broker.subscribe("session-b")
    event = RuntimeEvent(
        session_id="session-a",
        sequence=3,
        event_type=RuntimeEventType.POSTURE_OBSERVATION,
        payload={"posture": "standing"},
    )

    broker.publish(event)

    assert first.get_nowait() == event
    assert second.get_nowait() == event
    with pytest.raises(queue.Empty):
        other.get_nowait()

    broker.close_session("session-a")
    assert first.get_nowait() is None
    assert second.get_nowait() is None


def test_controller_reports_real_running_and_stops_worker() -> None:
    worker = FakeWorker()
    controller = RuntimePerceptionController(worker=worker)
    subscription = controller.broker.subscribe("session-live-001")

    starting = controller.start(_live_request())
    assert starting.state is RuntimeSessionState.STARTING
    assert worker.started.wait(1.0)
    _wait_until(lambda: controller.status().state is RuntimeSessionState.RUNNING)

    event = subscription.get(timeout=1.0)
    assert event is not None
    assert event.session_id == "session-live-001"

    stopped = controller.stop("session-live-001")
    assert stopped.state is RuntimeSessionState.STOPPED
    assert worker.stopped.wait(1.0)
    assert subscription.get(timeout=1.0) is None


def test_replacement_session_closes_old_event_stream() -> None:
    worker = FakeWorker()
    controller = RuntimePerceptionController(worker=worker)
    old_stream = controller.broker.subscribe("session-old")
    controller.start(_live_request("session-old"))
    assert worker.started.wait(1.0)

    replacement = FakeWorker()
    controller.worker = replacement
    controller.start(_live_request("session-new"))

    assert old_stream.get(timeout=1.0) is not None
    assert old_stream.get(timeout=1.0) is None
    assert replacement.started.wait(1.0)
    assert controller.status().session_id == "session-new"
    controller.stop("session-new")


def test_websocket_frame_encodes_short_and_extended_text() -> None:
    short = encode_websocket_frame(b"hello")
    assert short == b"\x81\x05hello"

    payload = b"x" * 200
    extended = encode_websocket_frame(payload)
    assert extended[:2] == b"\x81\x7e"
    assert int.from_bytes(extended[2:4], "big") == 200
    assert extended[4:] == payload


def test_frontend_capabilities_and_cors_headers() -> None:
    worker = FakeWorker()
    controller = RuntimePerceptionController(worker=worker)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), build_runtime_handler(controller))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{httpd.server_port}"
    try:
        request = urllib.request.Request(
            f"{base}/api/runtime/capabilities",
            method="GET",
        )
        with urllib.request.urlopen(request, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
            assert response.headers["Access-Control-Allow-Origin"] == "*"
            assert response.headers["Access-Control-Allow-Private-Network"] == "true"
        assert payload["schema_version"] == "reme-perception-frontend/v0-experiment"
        assert payload["service"] == "reme-perception"
        assert payload["profiles"] == ["live_camera"]
        assert payload["events"] == [
            "frame_landmarks",
            "posture_observation",
            "transition_event",
        ]
        assert payload["formal_input_adapter"] == "c_ws"
        assert payload["local_test_input_adapter"] == "local_camera"
        assert payload["frame_source_owner"] == "C"
        assert payload["scene_signal_supported"] is True
        assert payload["camera_websocket_reused_across_scenes"] is True
        assert payload["audio_processed_by_a"] is False
        assert payload["raw_video_persisted"] is False
        assert payload["endpoints"]["events"] == "/ws/events?session_id=<session_id>"

        options = urllib.request.Request(
            f"{base}/api/runtime/start",
            method="OPTIONS",
            headers={"Access-Control-Request-Private-Network": "true"},
        )
        with urllib.request.urlopen(options, timeout=2) as response:
            assert response.status == 204
            assert response.headers["Access-Control-Allow-Private-Network"] == "true"
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)


def test_browser_gateway_can_force_landmark_lane_when_jpeg_stack_is_ready(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    movenet_model = tmp_path / "movenet.tflite"
    posture_model = tmp_path / "posture.json"
    movenet_model.write_bytes(b"model")
    posture_model.write_text("{}", encoding="utf-8")
    monkeypatch.setattr("importlib.util.find_spec", lambda name: object())

    args = runtime_server_module._build_parser().parse_args(
        [
            "--input-adapter",
            "c_ws_server",
            "--browser-input-mode",
            "landmarks",
            "--movenet-model",
            str(movenet_model),
            "--posture-model",
            str(posture_model),
        ]
    )

    gateway = runtime_server_module.build_browser_gateway(args)

    assert gateway.mode == "landmarks"
    assert gateway.capabilities()["accepts"] == [
        "landmarks_frame",
        "debug_scenario",
        "scene_signal",
    ]


def test_c_camera_worker_resets_scene_state_and_keeps_runtime_sequence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeSource:
        def iter_messages(
            self,
            request: RuntimeSessionRequest,
            *,
            is_active: Callable[[], bool],
        ):
            assert request.session_id == "session-live-001"
            assert is_active()
            yield CSceneSignal("session-live-001", "kitchen", 0.0, "activate")
            yield CVideoFrame("session-live-001", "kitchen", 7, 0.0, b"\xff\xd8a")
            yield CSceneSignal("session-live-001", "living-room", 100.0, "switch")
            yield CVideoFrame("session-live-001", "living-room", 0, 0.0, b"\xff\xd8b")
            yield CSceneSignal("session-live-001", "kitchen", 200.0, "reuse")
            yield CVideoFrame("session-live-001", "kitchen", 0, 0.0, b"\xff\xd8c")

    class FakeKeypoint:
        def __init__(self, index: int) -> None:
            self.index = index

        def to_payload(self) -> dict[str, object]:
            return {
                "name": MOVENET_KEYPOINT_NAMES[self.index],
                "x_norm": 0.5,
                "y_norm": 0.5,
                "score": 0.0,
            }

    class FakeEstimator:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def reset(self) -> None:
            pass

        def infer(self, frame: object) -> object:
            return types.SimpleNamespace(
                person_detected=False,
                landmark_quality="unavailable",
                keypoints=tuple(FakeKeypoint(index) for index in range(17)),
            )

    class FakePredictor:
        def predict_record(self, record: dict[str, object]) -> object:
            return types.SimpleNamespace(
                posture="unknown",
                confidence=1.0,
                visible_keypoint_ratio=0.0,
            )

    class FakeStaticPostureModel:
        @staticmethod
        def load(path: object) -> FakePredictor:
            return FakePredictor()

    fake_cv2 = types.ModuleType("cv2")
    fake_cv2.IMREAD_COLOR = 1
    fake_cv2.imdecode = lambda encoded, mode: object()
    monkeypatch.setitem(sys.modules, "cv2", fake_cv2)
    monkeypatch.setattr(runtime_server_module, "MoveNetEstimator", FakeEstimator)
    monkeypatch.setattr(runtime_server_module, "StaticPostureModel", FakeStaticPostureModel)

    published: list[RuntimeEvent] = []
    running = 0

    def mark_running() -> None:
        nonlocal running
        running += 1

    worker = CCameraWebSocketPerceptionWorker(
        source=FakeSource(),
        movenet_model=runtime_server_module.DEFAULT_MOVENET_MODEL,
        posture_model=runtime_server_module.DEFAULT_POSTURE_MODEL,
    )
    worker.run(
        _live_request(),
        publish=published.append,
        mark_running=mark_running,
        is_active=lambda: True,
    )

    frame_events = [
        event for event in published if event.event_type is RuntimeEventType.FRAME_LANDMARKS
    ]
    posture_events = [
        event
        for event in published
        if event.event_type is RuntimeEventType.POSTURE_OBSERVATION
    ]
    assert running == 1
    assert [event.sequence for event in frame_events] == [0, 1, 2]
    assert [event.payload["frame_index"] for event in frame_events] == [7, 0, 0]
    assert [event.payload["scene_id"] for event in frame_events] == [
        "kitchen",
        "living-room",
        "kitchen",
    ]
    assert [event.payload["posture_duration_ms"] for event in posture_events] == [
        0.0,
        0.0,
        0.0,
    ]


def test_frontend_error_payload_has_stable_shape() -> None:
    worker = FakeWorker()
    controller = RuntimePerceptionController(worker=worker)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), build_runtime_handler(controller))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{httpd.server_port}"
    try:
        with pytest.raises(urllib.error.HTTPError) as excinfo:
            urllib.request.urlopen(f"{base}/api/missing", timeout=2)
        payload = json.loads(excinfo.value.read().decode("utf-8"))
        assert excinfo.value.code == 404
        assert payload == {
            "schema_version": "reme-api-error/v0-experiment",
            "code": "not_found",
            "message": "unknown path /api/missing",
            "path": "/api/missing",
        }
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)


def test_runtime_http_start_status_stop_and_websocket(
    capsys: pytest.CaptureFixture[str],
) -> None:
    worker = FakeWorker()
    controller = RuntimePerceptionController(worker=worker)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), build_runtime_handler(controller))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{httpd.server_port}"
    try:
        websocket = socket.create_connection(("127.0.0.1", httpd.server_port), timeout=2)
        key = base64.b64encode(b"runtime-server-test").decode("ascii")
        websocket.sendall(
            (
                "GET /ws/events?session_id=session-live-001 HTTP/1.1\r\n"
                f"Host: 127.0.0.1:{httpd.server_port}\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                "Sec-WebSocket-Version: 13\r\n\r\n"
            ).encode("ascii")
        )
        handshake = websocket.recv(4096)
        expected_accept = base64.b64encode(
            hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
            ).digest()
        )
        assert b"101 Switching Protocols" in handshake
        assert expected_accept in handshake

        start = _post_json(base, "/api/runtime/start", _live_request().to_payload())
        assert start["state"] == "starting"
        assert worker.started.wait(1.0)

        frame = websocket.recv(4096)
        payload = _decode_server_text_frame(frame)
        assert payload["session_id"] == "session-live-001"
        assert payload["event_type"] == "frame_landmarks"

        status = _get_json(base, "/api/runtime/status")
        assert status["state"] == "running"
        stopped = _post_json(
            base,
            "/api/runtime/stop",
            {"session_id": "session-live-001"},
        )
        assert stopped["state"] == "stopped"
        websocket.close()
        time.sleep(0.05)
        assert "BrokenPipeError" not in capsys.readouterr().err
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)


def _post_json(base: str, path: str, payload: dict[str, object]) -> dict[str, object]:
    request = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=2) as response:
        decoded = json.loads(response.read().decode("utf-8"))
    assert isinstance(decoded, dict)
    return decoded


def _get_json(base: str, path: str) -> dict[str, object]:
    with urllib.request.urlopen(f"{base}{path}", timeout=2) as response:
        decoded = json.loads(response.read().decode("utf-8"))
    assert isinstance(decoded, dict)
    return decoded


def _decode_server_text_frame(frame: bytes) -> dict[str, object]:
    assert frame[0] == 0x81
    length = frame[1] & 0x7F
    offset = 2
    if length == 126:
        length = int.from_bytes(frame[2:4], "big")
        offset = 4
    payload = json.loads(frame[offset : offset + length].decode("utf-8"))
    assert isinstance(payload, dict)
    return payload
