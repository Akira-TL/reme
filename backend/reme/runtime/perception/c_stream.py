"""C-owned camera WebSocket input and reusable scene signals."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import secrets
import socket
import ssl
from collections.abc import Callable, Iterator
from contextlib import suppress
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlparse

from reme.pose.demo_scenarios import DEBUG_SCENARIOS, DemoScenarioCommand
from reme.pose.runtime import RuntimeSessionRequest

_WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class CStreamError(RuntimeError):
    """Raised when C's camera stream violates the A-side input contract."""


@dataclass(frozen=True, slots=True)
class CSceneSignal:
    """One scene activation signal carried by C's existing camera WebSocket."""

    session_id: str
    scene_id: str
    timestamp_ms: float
    signal: str = "activate"


@dataclass(frozen=True, slots=True)
class CDebugScenario:
    """One manual acceptance scenario carried over the existing input socket."""

    session_id: str
    scene_id: str
    timestamp_ms: float
    scenario: str

    def to_command(self) -> DemoScenarioCommand:
        return DemoScenarioCommand(
            session_id=self.session_id,
            scene_id=self.scene_id,
            timestamp_ms=self.timestamp_ms,
            scenario=self.scenario,
        )


@dataclass(frozen=True, slots=True)
class CVideoFrame:
    """One JPEG frame captured and timestamped by C."""

    session_id: str
    scene_id: str
    frame_index: int
    timestamp_ms: float
    jpeg: bytes


CStreamMessage = CSceneSignal | CDebugScenario | CVideoFrame


class CStreamDecoder:
    """Decode scene signals and JPEG frames from one reused C camera WebSocket."""

    def __init__(self, *, max_frame_bytes: int = 5_000_000) -> None:
        if max_frame_bytes < 1:
            raise CStreamError("max_frame_bytes must be positive")
        self.max_frame_bytes = max_frame_bytes
        self._pending_frame: dict[str, object] | None = None

    def feed(self, message: str | bytes) -> tuple[CStreamMessage, ...]:
        """Decode one text or binary WebSocket message."""

        if isinstance(message, bytes):
            if self._pending_frame is None:
                raise CStreamError("binary JPEG requires a preceding frame_meta message")
            metadata = self._pending_frame
            self._pending_frame = None
            return (self._frame_from_metadata(metadata, message),)

        try:
            payload = json.loads(message)
        except json.JSONDecodeError as exc:
            raise CStreamError("C camera WebSocket text message must be JSON") from exc
        if not isinstance(payload, dict):
            raise CStreamError("C camera WebSocket message must be an object")
        message_type = payload.get("type")
        if message_type == "scene_signal":
            return (
                CSceneSignal(
                    session_id=_required_text(payload, "session_id"),
                    scene_id=_required_text(payload, "scene_id"),
                    timestamp_ms=_non_negative_number(payload, "timestamp_ms"),
                    signal=_optional_text(payload, "signal", default="activate"),
                ),
            )
        if message_type == "debug_scenario":
            scenario = _required_text(payload, "scenario")
            if scenario not in DEBUG_SCENARIOS:
                raise CStreamError(f"scenario must be one of {DEBUG_SCENARIOS}")
            return (
                CDebugScenario(
                    session_id=_required_text(payload, "session_id"),
                    scene_id=_required_text(payload, "scene_id"),
                    timestamp_ms=_non_negative_number(payload, "timestamp_ms"),
                    scenario=scenario,
                ),
            )
        if message_type == "frame_meta":
            self._pending_frame = dict(payload)
            return ()
        if message_type == "frame":
            encoded = _required_text(payload, "jpeg_base64")
            try:
                jpeg = base64.b64decode(encoded, validate=True)
            except ValueError as exc:
                raise CStreamError("jpeg_base64 must be valid base64") from exc
            return (self._frame_from_metadata(payload, jpeg),)
        if message_type in {"ping", "heartbeat"}:
            return ()
        raise CStreamError(
            f"unsupported C camera WebSocket message type: {message_type!r}"
        )

    def _frame_from_metadata(
        self,
        metadata: dict[str, object],
        jpeg: bytes,
    ) -> CVideoFrame:
        if not jpeg or len(jpeg) > self.max_frame_bytes:
            raise CStreamError("JPEG frame is empty or exceeds max_frame_bytes")
        if not jpeg.startswith(b"\xff\xd8"):
            raise CStreamError("frame payload must be a JPEG image")
        return CVideoFrame(
            session_id=_required_text(metadata, "session_id"),
            scene_id=_required_text(metadata, "scene_id"),
            frame_index=_non_negative_integer(metadata, "frame_index"),
            timestamp_ms=_non_negative_number(metadata, "timestamp_ms"),
            jpeg=bytes(jpeg),
        )


class CCameraMessageSource(Protocol):
    """Yield decoded messages from C's existing camera WebSocket."""

    def iter_messages(
        self,
        request: RuntimeSessionRequest,
        *,
        is_active: Callable[[], bool],
    ) -> Iterator[CStreamMessage]: ...


class CCameraWebSocketSource:
    """Connect to C's camera WebSocket and reuse it across scene switches."""

    def __init__(self, url: str, *, open_timeout: float = 5.0) -> None:
        parsed = urlparse(url)
        if parsed.scheme not in {"ws", "wss"} or not parsed.hostname:
            raise CStreamError("C camera WebSocket URL must use ws:// or wss://")
        self.url = url
        self.open_timeout = open_timeout

    def iter_messages(
        self,
        request: RuntimeSessionRequest,
        *,
        is_active: Callable[[], bool],
    ) -> Iterator[CStreamMessage]:
        """Subscribe once and yield all scene/frame messages for one session."""

        decoder = CStreamDecoder()
        connection = _WebSocketClientConnection.open(
            self.url,
            timeout=self.open_timeout,
        )
        try:
            connection.send_text(
                json.dumps(
                    {
                        "type": "subscribe",
                        "consumer": "reme-perception",
                        "session_id": request.session_id,
                        "camera_id": request.camera_id,
                        "initial_scene_id": request.scene_id,
                    },
                    separators=(",", ":"),
                )
            )
            while is_active():
                raw_message = connection.receive(timeout=0.5)
                if raw_message is None:
                    continue
                yield from decoder.feed(raw_message)
        finally:
            connection.close()


class _WebSocketClientConnection:
    """Small RFC 6455 client sufficient for C's local camera stream."""

    def __init__(self, transport: socket.socket) -> None:
        self.transport = transport

    @classmethod
    def open(cls, url: str, *, timeout: float) -> _WebSocketClientConnection:
        parsed = urlparse(url)
        host = parsed.hostname
        if host is None:
            raise CStreamError("WebSocket URL must include a host")
        secure = parsed.scheme == "wss"
        port = parsed.port or (443 if secure else 80)
        transport = socket.create_connection((host, port), timeout=timeout)
        if secure:
            context = ssl.create_default_context()
            transport = context.wrap_socket(transport, server_hostname=host)
        transport.settimeout(timeout)
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        target = parsed.path or "/"
        if parsed.query:
            target = f"{target}?{parsed.query}"
        host_header = host if port in {80, 443} else f"{host}:{port}"
        request = (
            f"GET {target} HTTP/1.1\r\n"
            f"Host: {host_header}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        ).encode("ascii")
        transport.sendall(request)
        response = _read_http_headers(transport)
        expected = base64.b64encode(
            hashlib.sha1((key + _WEBSOCKET_GUID).encode("ascii")).digest()
        ).decode("ascii")
        status_line, _, header_block = response.partition(b"\r\n")
        headers = _parse_http_headers(header_block)
        if b" 101 " not in status_line or headers.get("sec-websocket-accept") != expected:
            transport.close()
            raise CStreamError("C camera WebSocket handshake failed")
        return cls(transport)

    def send_text(self, text: str) -> None:
        self.transport.sendall(
            _encode_client_websocket_frame(text.encode("utf-8"), opcode=0x1)
        )

    def receive(self, *, timeout: float) -> str | bytes | None:
        self.transport.settimeout(timeout)
        try:
            first_two = _recv_exact(self.transport, 2)
        except TimeoutError:
            return None
        first, second = first_two
        opcode = first & 0x0F
        if not first & 0x80:
            raise CStreamError("fragmented C camera WebSocket messages are unsupported")
        length = second & 0x7F
        if length == 126:
            length = int.from_bytes(_recv_exact(self.transport, 2), "big")
        elif length == 127:
            length = int.from_bytes(_recv_exact(self.transport, 8), "big")
        mask = _recv_exact(self.transport, 4) if second & 0x80 else None
        payload = _recv_exact(self.transport, length)
        if mask is not None:
            payload = bytes(
                value ^ mask[index % 4] for index, value in enumerate(payload)
            )
        if opcode == 0x8:
            raise CStreamError("C camera WebSocket closed")
        if opcode == 0x9:
            self.transport.sendall(_encode_client_websocket_frame(payload, opcode=0xA))
            return None
        if opcode == 0xA:
            return None
        if opcode == 0x1:
            return payload.decode("utf-8")
        if opcode == 0x2:
            return payload
        raise CStreamError(f"unsupported C camera WebSocket opcode: {opcode}")

    def close(self) -> None:
        with suppress(OSError):
            self.transport.sendall(_encode_client_websocket_frame(b"", opcode=0x8))
        self.transport.close()


def _recv_exact(transport: socket.socket, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        try:
            chunk = transport.recv(length - len(chunks))
        except TimeoutError:
            raise
        if not chunk:
            raise CStreamError("C camera WebSocket disconnected")
        chunks.extend(chunk)
    return bytes(chunks)


def _read_http_headers(transport: socket.socket) -> bytes:
    response = bytearray()
    while b"\r\n\r\n" not in response:
        if len(response) > 64 * 1024:
            raise CStreamError("WebSocket handshake headers are too large")
        response.extend(_recv_exact(transport, 1))
    return bytes(response)


def _parse_http_headers(block: bytes) -> dict[str, str]:
    headers: dict[str, str] = {}
    for line in block.split(b"\r\n"):
        if b":" not in line:
            continue
        name, value = line.split(b":", 1)
        headers[name.decode("ascii").strip().lower()] = value.decode("ascii").strip()
    return headers


def _encode_client_websocket_frame(payload: bytes, *, opcode: int) -> bytes:
    if not 0 <= opcode <= 0xF:
        raise CStreamError("invalid WebSocket opcode")
    mask = secrets.token_bytes(4)
    masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    first = bytes((0x80 | opcode,))
    length = len(payload)
    if length < 126:
        header = first + bytes((0x80 | length,))
    elif length <= 0xFFFF:
        header = first + bytes((0x80 | 126,)) + length.to_bytes(2, "big")
    else:
        header = first + bytes((0x80 | 127,)) + length.to_bytes(8, "big")
    return header + mask + masked


def _required_text(payload: dict[str, object], field_name: str) -> str:
    value = payload.get(field_name)
    if not isinstance(value, str) or not value.strip():
        raise CStreamError(f"{field_name} must be a non-empty string")
    return value.strip()


def _optional_text(
    payload: dict[str, object],
    field_name: str,
    *,
    default: str,
) -> str:
    value = payload.get(field_name, default)
    if not isinstance(value, str) or not value.strip():
        raise CStreamError(f"{field_name} must be a non-empty string")
    return value.strip()


def _non_negative_integer(payload: dict[str, object], field_name: str) -> int:
    value = payload.get(field_name)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise CStreamError(f"{field_name} must be a non-negative integer")
    return value


def _non_negative_number(payload: dict[str, object], field_name: str) -> float:
    value = payload.get(field_name)
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or not math.isfinite(float(value))
        or float(value) < 0
    ):
        raise CStreamError(f"{field_name} must be finite and non-negative")
    return float(value)
