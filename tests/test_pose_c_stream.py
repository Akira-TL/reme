from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import socket
import threading

import pytest
from reme.pose.c_stream import (
    CCameraWebSocketSource,
    CSceneSignal,
    CStreamDecoder,
    CStreamError,
    CVideoFrame,
)
from reme.pose.runtime import ModeProfile, RuntimeSessionRequest
from reme.pose.runtime_server import encode_websocket_frame


def _live_request() -> RuntimeSessionRequest:
    return RuntimeSessionRequest(
        session_id="session-live-001",
        profile=ModeProfile.LIVE_CAMERA,
        scene_id="live-camera-001",
        camera_id="default",
    )


def test_c_stream_decoder_handles_scene_reuse_and_binary_frames() -> None:
    decoder = CStreamDecoder()
    scene = decoder.feed(
        json.dumps(
            {
                "type": "scene_signal",
                "session_id": "session-live-001",
                "scene_id": "kitchen",
                "timestamp_ms": 0,
                "signal": "activate",
            }
        )
    )
    assert scene == (
        CSceneSignal(
            session_id="session-live-001",
            scene_id="kitchen",
            timestamp_ms=0.0,
            signal="activate",
        ),
    )

    assert decoder.feed(
        json.dumps(
            {
                "type": "frame_meta",
                "session_id": "session-live-001",
                "scene_id": "kitchen",
                "frame_index": 12,
                "timestamp_ms": 400.0,
            }
        )
    ) == ()
    frame = decoder.feed(b"\xff\xd8jpeg-data")
    assert frame == (
        CVideoFrame(
            session_id="session-live-001",
            scene_id="kitchen",
            frame_index=12,
            timestamp_ms=400.0,
            jpeg=b"\xff\xd8jpeg-data",
        ),
    )

    reused = decoder.feed(
        json.dumps(
            {
                "type": "scene_signal",
                "session_id": "session-live-001",
                "scene_id": "kitchen",
                "timestamp_ms": 1200,
                "signal": "reuse",
            }
        )
    )
    assert isinstance(reused[0], CSceneSignal)
    assert reused[0].scene_id == "kitchen"
    assert reused[0].signal == "reuse"


def test_c_stream_decoder_accepts_base64_frames_and_rejects_bare_binary() -> None:
    decoder = CStreamDecoder()
    encoded = base64.b64encode(b"\xff\xd8frame").decode("ascii")
    decoded = decoder.feed(
        json.dumps(
            {
                "type": "frame",
                "session_id": "session-live-001",
                "scene_id": "living-room",
                "frame_index": 3,
                "timestamp_ms": 100.5,
                "jpeg_base64": encoded,
            }
        )
    )
    assert isinstance(decoded[0], CVideoFrame)
    assert decoded[0].jpeg == b"\xff\xd8frame"

    with pytest.raises(CStreamError, match="preceding frame_meta"):
        CStreamDecoder().feed(b"\xff\xd8frame")


def test_c_camera_websocket_source_subscribes_once_and_reuses_connection() -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    captured: dict[str, object] = {}

    def serve() -> None:
        connection, _ = listener.accept()
        with connection:
            request_bytes = _recv_until(connection, b"\r\n\r\n")
            headers = _header_map(request_bytes)
            key = headers["sec-websocket-key"]
            accept = base64.b64encode(
                hashlib.sha1(
                    (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
                ).digest()
            ).decode("ascii")
            connection.sendall(
                (
                    "HTTP/1.1 101 Switching Protocols\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
                ).encode("ascii")
            )
            captured["subscribe"] = json.loads(_recv_client_text_frame(connection))
            connection.sendall(
                encode_websocket_frame(
                    json.dumps(
                        {
                            "type": "scene_signal",
                            "session_id": "session-live-001",
                            "scene_id": "kitchen",
                            "timestamp_ms": 0,
                            "signal": "activate",
                        }
                    ).encode("utf-8")
                )
            )
            connection.sendall(
                encode_websocket_frame(
                    json.dumps(
                        {
                            "type": "frame",
                            "session_id": "session-live-001",
                            "scene_id": "kitchen",
                            "frame_index": 0,
                            "timestamp_ms": 0,
                            "jpeg_base64": base64.b64encode(b"\xff\xd8frame").decode(
                                "ascii"
                            ),
                        }
                    ).encode("utf-8")
                )
            )
            with contextlib.suppress(OSError, TimeoutError):
                connection.settimeout(1)
                connection.recv(4096)

    server_thread = threading.Thread(target=serve, daemon=True)
    server_thread.start()
    source = CCameraWebSocketSource(
        f"ws://127.0.0.1:{listener.getsockname()[1]}/camera"
    )
    iterator = source.iter_messages(_live_request(), is_active=lambda: True)
    try:
        scene = next(iterator)
        frame = next(iterator)
    finally:
        iterator.close()
        listener.close()
        server_thread.join(timeout=2)

    assert isinstance(scene, CSceneSignal)
    assert scene.scene_id == "kitchen"
    assert isinstance(frame, CVideoFrame)
    assert frame.scene_id == "kitchen"
    assert captured["subscribe"] == {
        "type": "subscribe",
        "consumer": "reme-perception",
        "session_id": "session-live-001",
        "camera_id": "default",
        "initial_scene_id": "live-camera-001",
    }


def _recv_until(connection: socket.socket, marker: bytes) -> bytes:
    result = bytearray()
    while marker not in result:
        chunk = connection.recv(4096)
        if not chunk:
            raise AssertionError("connection closed before marker")
        result.extend(chunk)
    return bytes(result)


def _header_map(request_bytes: bytes) -> dict[str, str]:
    headers: dict[str, str] = {}
    for line in request_bytes.split(b"\r\n")[1:]:
        if b":" not in line:
            continue
        name, value = line.split(b":", 1)
        headers[name.decode("ascii").strip().lower()] = value.decode("ascii").strip()
    return headers


def _recv_client_text_frame(connection: socket.socket) -> str:
    first, second = connection.recv(2)
    assert first & 0x0F == 0x1
    assert second & 0x80
    length = second & 0x7F
    if length == 126:
        length = int.from_bytes(connection.recv(2), "big")
    elif length == 127:
        length = int.from_bytes(connection.recv(8), "big")
    mask = connection.recv(4)
    payload = bytearray()
    while len(payload) < length:
        payload.extend(connection.recv(length - len(payload)))
    decoded = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    return decoded.decode("utf-8")
