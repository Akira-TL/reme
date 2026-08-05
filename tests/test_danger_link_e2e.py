"""Whole-chain danger E2E through the unified backend.

A scripted browser pushes synthetic fall landmarks through ``/ws/camera-input``.
The perception worker publishes into the in-process bridge, the decision module
opens a safety check-in, and the family alert returns through the public ``/ws``.
Only browser-facing boundaries use sockets; perception-to-decision delivery is
directly in process. MiMo vision is faked at its transport seam.
"""

from __future__ import annotations

import contextlib
import http.client
import json
import os
import socket
import struct
import threading
import time
from typing import Any

from reme.decision.danger import DangerConfig, DangerConfirmController
from reme.decision.guardrails import TriggerConfig
from reme.decision.mimo.adapter import MimoCallResult
from reme.decision.policy import DecisionService, PolicyConfig
from reme.decision.records import DemoMode
from reme.decision.runtime_glue import RuntimeDecisionPublisher, live_streams_resolver
from reme.decision.server import build_decision_handler
from reme.decision.session import RuntimeSessionRegistry
from reme.decision.state_machine import TemplateId
from reme.decision.stream import EventIngest
from reme.decision.websocket import DecisionEventHub
from reme.runtime.perception.browser_input import (
    KEYPOINT_NAMES,
    BrowserGatewayPerceptionWorker,
)
from reme.runtime.perception.runtime_server import (
    RuntimeHTTPServer,
    RuntimePerceptionController,
    build_runtime_handler,
)
from reme.runtime.server import build_unified_handler
from reme.runtime.transport import InProcessPerceptionBridge

SESSION_ID = "live-camera-e2e-001"
SCENE_ID = "living_room"


# -- synthetic fall ----------------------------------------------------------


def _skeleton(coords: dict[str, tuple[float, float]]) -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "x_norm": coords.get(name, (0.5, 0.5))[0],
            "y_norm": coords.get(name, (0.5, 0.5))[1],
            "score": 0.9 if name in coords else 0.0,
        }
        for name in KEYPOINT_NAMES
    ]


def _standing() -> dict[str, tuple[float, float]]:
    return {
        "nose": (0.50, 0.18),
        "left_eye": (0.485, 0.17),
        "right_eye": (0.515, 0.17),
        "left_ear": (0.47, 0.18),
        "right_ear": (0.53, 0.18),
        "left_shoulder": (0.44, 0.30),
        "right_shoulder": (0.56, 0.30),
        "left_elbow": (0.42, 0.42),
        "right_elbow": (0.58, 0.42),
        "left_wrist": (0.41, 0.53),
        "right_wrist": (0.59, 0.53),
        "left_hip": (0.46, 0.55),
        "right_hip": (0.54, 0.55),
        "left_knee": (0.46, 0.75),
        "right_knee": (0.54, 0.75),
        "left_ankle": (0.46, 0.95),
        "right_ankle": (0.54, 0.95),
    }


def _lying() -> dict[str, tuple[float, float]]:
    return {
        "nose": (0.24, 0.84),
        "left_eye": (0.25, 0.83),
        "right_eye": (0.25, 0.85),
        "left_ear": (0.26, 0.82),
        "right_ear": (0.26, 0.86),
        "left_shoulder": (0.36, 0.83),
        "right_shoulder": (0.40, 0.87),
        "left_elbow": (0.44, 0.80),
        "right_elbow": (0.46, 0.90),
        "left_wrist": (0.50, 0.79),
        "right_wrist": (0.52, 0.91),
        "left_hip": (0.58, 0.84),
        "right_hip": (0.62, 0.88),
        "left_knee": (0.70, 0.83),
        "right_knee": (0.72, 0.89),
        "left_ankle": (0.80, 0.84),
        "right_ankle": (0.82, 0.88),
    }


def _fall_frames() -> list[dict[str, Any]]:
    frames: list[dict[str, Any]] = []
    index = 0
    timestamp = 0.0

    def push(coords: dict[str, tuple[float, float]]) -> None:
        nonlocal index, timestamp
        frames.append(
            {
                "type": "landmarks_frame",
                "session_id": SESSION_ID,
                "scene_id": SCENE_ID,
                "frame_index": index,
                "timestamp_ms": timestamp,
                "person_detected": True,
                "keypoints": _skeleton(coords),
            }
        )
        index += 1
        timestamp += 100.0

    for _ in range(6):
        push(_standing())
    standing, lying = _standing(), _lying()
    for step in range(1, 5):
        blend = step / 4
        push(
            {
                name: (
                    standing[name][0] + (lying[name][0] - standing[name][0]) * blend,
                    standing[name][1] + (lying[name][1] - standing[name][1]) * blend,
                )
                for name in standing
            }
        )
    for _ in range(60):
        push(_lying())
    return frames


# -- minimal RFC6455 client --------------------------------------------------


class _WsClient:
    """Enough of RFC 6455 to receive text frames and send masked messages."""

    def __init__(self, port: int, path: str) -> None:
        self._sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        key = "dGhlIHNhbXBsZSBub25jZQ=="
        upgrade = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self._sock.sendall(upgrade.encode("ascii"))
        self._buffer = b""
        while b"\r\n\r\n" not in self._buffer:
            self._buffer += self._sock.recv(4096)
        head, _, self._buffer = self._buffer.partition(b"\r\n\r\n")
        assert b"101" in head.split(b"\r\n", 1)[0], head

    def _read_exact(self, size: int) -> bytes:
        while len(self._buffer) < size:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise AssertionError("websocket stream ended early")
            self._buffer += chunk
        data, self._buffer = self._buffer[:size], self._buffer[size:]
        return data

    def recv_json(self) -> dict[str, Any]:
        while True:
            header = self._read_exact(2)
            opcode = header[0] & 0x0F
            length = header[1] & 0x7F
            if length == 126:
                (length,) = struct.unpack("!H", self._read_exact(2))
            elif length == 127:
                (length,) = struct.unpack("!Q", self._read_exact(8))
            payload = self._read_exact(length)
            if opcode != 0x1:
                continue  # ping/pong/close noise is irrelevant here
            body = json.loads(payload.decode("utf-8"))
            assert isinstance(body, dict)
            return body

    def send_text(self, text: str) -> None:
        payload = text.encode("utf-8")
        mask = b"\x12\x34\x56\x78"
        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        length = len(payload)
        if length < 126:
            header = struct.pack("!BB", 0x81, 0x80 | length)
        elif length <= 0xFFFF:
            header = struct.pack("!BBH", 0x81, 0x80 | 126, length)
        else:
            header = struct.pack("!BBQ", 0x81, 0x80 | 127, length)
        self._sock.sendall(header + mask + masked)

    def close(self) -> None:
        frame = bytearray([0x88, 0x80]) + b"\x00\x00\x00\x00"
        with contextlib.suppress(OSError):
            self._sock.sendall(bytes(frame))
        self._sock.close()


class _FakeVisionClient:
    """Transport-seam fake: every frame is judged a confident fall."""

    def complete(
        self, *, system_prompt: str, user_content: str | list[dict[str, Any]]
    ) -> MimoCallResult:
        return MimoCallResult(
            content=json.dumps({"fallen": True, "confidence": 0.93, "reason": "倒地"}),
            latency_ms=3.0,
            attempts=1,
        )


def _post(port: int, path: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.request(
            "POST", path, body=json.dumps(payload), headers={"Content-Type": "application/json"}
        )
        response = connection.getresponse()
        body = json.loads(response.read().decode("utf-8"))
        assert isinstance(body, dict)
        return response.status, body
    finally:
        connection.close()


def _session_payload() -> dict[str, Any]:
    return {
        "schema_version": "reme-runtime-session-request/v0-experiment",
        "session_id": SESSION_ID,
        "profile": "live_camera",
        "scene_id": SCENE_ID,
        "camera_id": "c-primary-camera",
        "manifest_path": None,
    }


def test_danger_link_six_hops_end_to_end(tmp_path: Any) -> None:
    os.environ["REME_DEMO_QUIET"] = "1"

    # -- unified backend components ------------------------------------------
    gateway = BrowserGatewayPerceptionWorker()
    perception_controller = RuntimePerceptionController(worker=gateway)
    registry = RuntimeSessionRegistry()
    hub = DecisionEventHub()
    ingest = EventIngest()
    service = DecisionService(
        scenes={},
        config=PolicyConfig(
            trigger=TriggerConfig(),
            demo_mode=DemoMode.LIVE,
            cognition_enabled=False,
            voice_assets={TemplateId.FALL_CHECK_IN: "/voice/fall_check_in.m4a"},
        ),
        publisher=RuntimeDecisionPublisher(registry=registry, hub=hub),
        live_streams=live_streams_resolver(registry, ingest),
    )
    danger = DangerConfirmController(
        service=service, client=_FakeVisionClient(), config=DangerConfig()
    )
    bridge = InProcessPerceptionBridge(
        broker=perception_controller.broker,
        ingest=ingest,
        registry=registry,
        service=service,
        danger=danger,
    )
    decision_handler = build_decision_handler(
        service=service,
        static_dir=None,
        registry=registry,
        hub=hub,
        ingest=ingest,
        bridge=bridge,
        danger=danger,
    )
    perception_handler = build_runtime_handler(
        perception_controller,
        input_gateway=gateway,
    )
    server = RuntimeHTTPServer(
        ("127.0.0.1", 0),
        build_unified_handler(perception_handler, decision_handler),
    )
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    port = server.server_address[1]

    decision_ws: _WsClient | None = None
    camera_ws: _WsClient | None = None
    try:
        # The browser starts perception and decision sessions on one server.
        status, body = _post(port, "/api/runtime/start", _session_payload())
        assert status == 202, body
        status, body = _post(port, "/api/session", _session_payload())
        assert status == 200, body
        assert body["component"] == "decision" and body["state"] == "running"

        # The unified backend advertises the hosted browser input lane.
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        connection.request("GET", "/api/runtime/capabilities")
        capabilities = json.loads(connection.getresponse().read().decode("utf-8"))
        connection.close()
        assert capabilities["input"]["camera_input_ws"] == "/ws/camera-input"
        assert capabilities["input"]["landmarks_inference"] is True
        assert capabilities["schemas"]["runtime_event"] == "reme-runtime-event/v0-experiment"

        decision_ws = _WsClient(port, "/ws")

        # Wait until the perception gateway owns the session intake.
        deadline = time.time() + 5
        while gateway.get_intake(SESSION_ID) is None:
            assert time.time() < deadline, "A never registered the session intake"
            time.sleep(0.02)

        camera_ws = _WsClient(port, "/ws/camera-input")
        started = time.time()
        for frame in _fall_frames():
            camera_ws.send_text(json.dumps(frame, separators=(",", ":")))

        # The fall check-in must reach the browser-facing decision stream.
        check_in = None
        deadline = time.time() + 15
        while time.time() < deadline:
            envelope = decision_ws.recv_json()
            if envelope.get("schema_version") != "reme-runtime-event/v0-experiment":
                continue
            if envelope.get("event_type") != "care_decision":
                continue
            assert envelope["session_id"] == SESSION_ID
            decision = envelope["payload"]
            if decision["state"] == "check_in_required":
                check_in = decision
                break
        assert check_in is not None, "fall check-in never reached the decision stream"
        check_in_latency = time.time() - started
        assert check_in["dialogue_goal"] == "confirm_safety"
        assert check_in["confirm_channels"] == ["frame", "voice"]
        assert check_in["voice_asset"] == "/voice/fall_check_in.m4a"
        assert check_in["response_timeout_ms"] == TriggerConfig().check_in_timeout_ms

        # Hop 4b: C uploads the raw frame; the fake vision verdict confirms.
        jpeg_b64 = "/9j/reme-e2e"  # b64 of 0xFF 0xD8 0xFF prefix + filler
        import base64 as _b64

        jpeg_b64 = _b64.b64encode(b"\xff\xd8\xff\xe0reme-e2e-frame").decode()
        status, body = _post(
            port,
            "/api/danger/frame",
            {
                "scene_id": SCENE_ID,
                "decision_id": check_in["decision_id"],
                "timestamp_ms": 12000.0,
                "image_b64": jpeg_b64,
            },
        )
        assert status == 200 and body == {"accepted": "visual_confirm"}

        # Hop 5: the family alert with the alarm block reaches C.
        alert = None
        deadline = time.time() + 10
        while time.time() < deadline:
            envelope = decision_ws.recv_json()
            if envelope.get("event_type") != "care_decision":
                continue
            decision = envelope["payload"]
            if decision["state"] == "family_notification_required":
                alert = decision
                break
        assert alert is not None, "family alert never reached the decision stream"
        total_latency = time.time() - started
        assert alert["alarm"] == {
            "channels": ["vibrate", "ring", "flash"],
            "trigger": "visual_confirm",
        }
        assert alert["family_notification"]
        assert alert["risk_level"] == 3
        # The elder-side reassurance is spoken from the preset registry only
        # when configured; text always rides elder_message.
        assert alert["elder_message"]

        # Sanity: the whole chain (sans MiMo) stays far inside the countdown.
        assert check_in_latency < 10, f"check-in took {check_in_latency:.1f}s"
        assert total_latency < 15, f"alert took {total_latency:.1f}s"
    finally:
        if camera_ws is not None:
            camera_ws.close()
        if decision_ws is not None:
            decision_ws.close()
        bridge.stop()
        hub.close_all()
        perception_controller.shutdown()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5)
