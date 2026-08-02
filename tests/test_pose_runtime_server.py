from __future__ import annotations

import base64
import hashlib
import json
import queue
import socket
import threading
import time
import urllib.request
from collections.abc import Callable
from http.server import ThreadingHTTPServer
from typing import Protocol

import pytest
from reme.pose.runtime import (
    ModeProfile,
    RuntimeEvent,
    RuntimeEventType,
    RuntimeSessionRequest,
    RuntimeSessionState,
)
from reme.pose.runtime_server import (
    EventBroker,
    PerceptionWorker,
    RuntimePerceptionController,
    build_runtime_handler,
    derive_live_perception_events,
    encode_websocket_frame,
)


class Publish(Protocol):
    def __call__(self, event: RuntimeEvent) -> None: ...


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


def test_runtime_http_start_status_stop_and_websocket() -> None:
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
