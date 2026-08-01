"""Minimal RFC 6455 WebSocket server for B->C decision streaming (stdlib only).

Skeleton contract for parallel lane L2 — signatures are FROZEN; the server
lane (L3) codes against ``DecisionEventHub`` with a fake and never imports
protocol internals.

Frozen decisions:
- Wire format: one RuntimeEvent payload (``RuntimeEvent.to_payload()`` JSON)
  per text frame; the hub never fragments outbound messages.
- ``DecisionEventHub.accept(handler)`` owns the full connection lifecycle
  (handshake + register + blocking serve + unregister). It may only touch
  ``handler.command / handler.headers / handler.rfile / handler.wfile /
  handler.connection``; on handshake failure it raises WebSocketError
  BEFORE writing any bytes so the caller can still send an HTTP error.
- Reads go through ``handler.rfile`` exclusively (bytes may already sit in
  its buffer after the upgrade request); writes go through ``handler.wfile``
  under a per-connection lock.
"""

from __future__ import annotations

import base64
import hashlib
import json
import socket
import struct
import threading
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from io import BufferedIOBase
from typing import Any, Protocol

OPCODE_CONTINUATION = 0x0
OPCODE_TEXT = 0x1
OPCODE_BINARY = 0x2
OPCODE_CLOSE = 0x8
OPCODE_PING = 0x9
OPCODE_PONG = 0xA

MAX_MESSAGE_BYTES = 1024 * 1024  # close 1009 beyond this

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_MASK_KEY_BYTES = 4
_MAX_CONTROL_PAYLOAD = 125
_FIN_BIT = 0x80
_RSV_BITS = 0x70
_MASK_BIT = 0x80
_OPCODE_MASK = 0x0F
_LENGTH_MASK = 0x7F
_CONTROL_BIT = 0x08

_CLOSE_NORMAL = 1000
_CLOSE_PROTOCOL_ERROR = 1002
_CLOSE_UNSUPPORTED_DATA = 1003
_CLOSE_INVALID_PAYLOAD = 1007
_CLOSE_MESSAGE_TOO_BIG = 1009
# Codes a peer never puts on the wire, so they must not be echoed back.
_UNECHOABLE_CLOSE_CODES = frozenset({1004, 1005, 1006, 1015})


class WebSocketError(Exception):
    """Handshake or protocol failure; on handshake paths no bytes were sent."""


class _EndOfStream(WebSocketError):
    """The peer stopped mid-frame; no close frame can reach it any more.

    A WebSocketError subclass so callers keep the single frozen exception
    type, while the recv loop can tell "peer vanished" from "peer broke the
    protocol" (only the latter deserves a close frame).
    """


class HandlerLike(Protocol):
    """The slice of BaseHTTPRequestHandler the hub is allowed to touch."""

    command: str

    @property
    def headers(self) -> Any: ...

    @property
    def rfile(self) -> BufferedIOBase: ...

    @property
    def wfile(self) -> Any: ...

    @property
    def connection(self) -> Any: ...


def compute_accept(key: str) -> str:
    """Sec-WebSocket-Accept for a client key (RFC 6455 section 4.2.2)."""

    digest = hashlib.sha1((key + _WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


@dataclass(frozen=True, slots=True)
class Frame:
    """One parsed frame (control frames arrive unfragmented)."""

    fin: bool
    opcode: int
    payload: bytes


def _read_exact(rfile: BufferedIOBase, size: int) -> bytes:
    """Read exactly ``size`` bytes; a short read means the peer is gone."""

    if size <= 0:
        return b""
    chunks: list[bytes] = []
    remaining = size
    while remaining > 0:
        chunk = rfile.read(remaining)
        if not chunk:
            raise _EndOfStream(f"stream ended {remaining} bytes short of a {size}-byte read")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _apply_mask(payload: bytes, mask: bytes) -> bytes:
    """XOR ``payload`` with the repeating 4-byte mask key (batched as one int)."""

    length = len(payload)
    if length == 0:
        return b""
    repeated = (mask * (length // _MASK_KEY_BYTES + 1))[:length]
    unmasked = int.from_bytes(payload, "big") ^ int.from_bytes(repeated, "big")
    return unmasked.to_bytes(length, "big")


def read_frame(rfile: BufferedIOBase) -> Frame:
    """Read exactly one client frame; unmasked client frames are a protocol error."""

    header = _read_exact(rfile, 2)
    byte0, byte1 = header[0], header[1]
    if byte0 & _RSV_BITS:
        raise WebSocketError("reserved frame bits must be zero")
    fin = bool(byte0 & _FIN_BIT)
    opcode = byte0 & _OPCODE_MASK
    masked = bool(byte1 & _MASK_BIT)
    length = byte1 & _LENGTH_MASK
    if opcode & _CONTROL_BIT:
        if not fin:
            raise WebSocketError("control frames must not be fragmented")
        if length > _MAX_CONTROL_PAYLOAD:
            raise WebSocketError("control frame payload must be at most 125 bytes")
    if length == 126:
        (length,) = struct.unpack("!H", _read_exact(rfile, 2))
    elif length == 127:
        (length,) = struct.unpack("!Q", _read_exact(rfile, 8))
        if length >> 63:
            raise WebSocketError("64-bit payload length must have the high bit clear")
    if not masked:
        raise WebSocketError("client frames must be masked")
    mask = _read_exact(rfile, _MASK_KEY_BYTES)
    payload = _read_exact(rfile, length)
    return Frame(fin=fin, opcode=opcode, payload=_apply_mask(payload, mask))


def encode_frame(opcode: int, payload: bytes, *, fin: bool = True) -> bytes:
    """Encode one server frame (never masked)."""

    length = len(payload)
    header = bytearray()
    header.append((_FIN_BIT if fin else 0x00) | (opcode & _OPCODE_MASK))
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))
    return bytes(header) + payload


def _echo_close_code(payload: bytes) -> int:
    """The status code to mirror back for a received close frame."""

    if len(payload) < 2:
        return _CLOSE_NORMAL
    code = int(struct.unpack("!H", payload[:2])[0])
    if code < 1000 or code in _UNECHOABLE_CLOSE_CODES:
        return _CLOSE_NORMAL
    return code


class ServerConnection:
    """One accepted connection: send lock, recv loop, close handshake."""

    def __init__(self, *, connection: Any, rfile: BufferedIOBase, wfile: Any) -> None:
        self._connection = connection
        self._rfile = rfile
        self._wfile = wfile
        self._send_lock = threading.Lock()
        self._closed = False
        self._close_sent = False

    @property
    def closed(self) -> bool:
        return self._closed

    def _send_frame(self, frame: bytes) -> bool:
        """Write one pre-encoded frame; False once the connection is dead."""

        with self._send_lock:
            return self._write_locked(frame)

    def _write_locked(self, frame: bytes) -> bool:
        if self._closed:
            return False
        try:
            self._wfile.write(frame)
            self._wfile.flush()
        except (OSError, ValueError):
            self._closed = True
            return False
        return True

    def send_text(self, text: str) -> None:
        """Thread-safe text send; marks the connection dead on OSError."""

        self._send_frame(encode_frame(OPCODE_TEXT, text.encode("utf-8")))

    def send_close(self, code: int = _CLOSE_NORMAL) -> None:
        with self._send_lock:
            if self._close_sent:
                return
            self._close_sent = True
            self._write_locked(encode_frame(OPCODE_CLOSE, struct.pack("!H", code)))
            self._closed = True

    def serve(self, on_text: Callable[[str], None] | None = None) -> None:
        """Blocking recv loop: pong pings, honour close, feed text upstream."""

        fragments: list[bytes] = []
        pending_bytes = 0
        fragmented = False
        try:
            while not self._closed:
                frame = read_frame(self._rfile)
                opcode = frame.opcode
                if opcode == OPCODE_PONG:
                    continue
                if opcode == OPCODE_PING:
                    self._send_frame(encode_frame(OPCODE_PONG, frame.payload))
                    continue
                if opcode == OPCODE_CLOSE:
                    self.send_close(_echo_close_code(frame.payload))
                    return
                if opcode == OPCODE_BINARY:
                    self.send_close(_CLOSE_UNSUPPORTED_DATA)
                    return
                if opcode == OPCODE_TEXT:
                    if fragmented:
                        self.send_close(_CLOSE_PROTOCOL_ERROR)
                        return
                    fragments = [frame.payload]
                    pending_bytes = len(frame.payload)
                elif opcode == OPCODE_CONTINUATION:
                    if not fragmented:
                        self.send_close(_CLOSE_PROTOCOL_ERROR)
                        return
                    fragments.append(frame.payload)
                    pending_bytes += len(frame.payload)
                else:
                    self.send_close(_CLOSE_PROTOCOL_ERROR)
                    return
                if pending_bytes > MAX_MESSAGE_BYTES:
                    self.send_close(_CLOSE_MESSAGE_TOO_BIG)
                    return
                if not frame.fin:
                    fragmented = True
                    continue
                fragmented = False
                message = b"".join(fragments)
                fragments = []
                pending_bytes = 0
                try:
                    text = message.decode("utf-8")
                except UnicodeDecodeError:
                    self.send_close(_CLOSE_INVALID_PAYLOAD)
                    return
                if on_text is not None:
                    on_text(text)
        except (_EndOfStream, OSError):
            # The peer vanished; a close frame would go nowhere.
            pass
        except WebSocketError:
            self.send_close(_CLOSE_PROTOCOL_ERROR)
        finally:
            self._closed = True


def _has_connection_token(value: object, token: str) -> bool:
    """True when a comma-separated Connection header carries ``token``."""

    if not isinstance(value, str):
        return False
    return any(part.strip().lower() == token for part in value.split(","))


def _handshake(handler: HandlerLike) -> ServerConnection:
    """Validate the upgrade request, then write the 101 response.

    Every validation happens before the first byte is written, so a caller
    catching WebSocketError can still emit a normal HTTP error response.
    """

    if handler.command != "GET":
        raise WebSocketError("websocket upgrade requires a GET request")
    headers = handler.headers
    upgrade = headers.get("Upgrade")
    if not isinstance(upgrade, str) or upgrade.strip().lower() != "websocket":
        raise WebSocketError("Upgrade header must be 'websocket'")
    if not _has_connection_token(headers.get("Connection"), "upgrade"):
        raise WebSocketError("Connection header must contain the 'upgrade' token")
    key = headers.get("Sec-WebSocket-Key")
    if not isinstance(key, str) or not key.strip():
        raise WebSocketError("Sec-WebSocket-Key header is required")
    version = headers.get("Sec-WebSocket-Version")
    if not isinstance(version, str) or version.strip() != "13":
        raise WebSocketError("Sec-WebSocket-Version must be 13")

    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {compute_accept(key.strip())}\r\n"
        "\r\n"
    )
    handler.wfile.write(response.encode("ascii"))
    handler.wfile.flush()
    # Latency tuning is best-effort: non-TCP transports (unix sockets in
    # tests) and some TLS wrappers reject the option.
    with suppress(OSError):
        handler.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    return ServerConnection(
        connection=handler.connection,
        rfile=handler.rfile,
        wfile=handler.wfile,
    )


class DecisionEventHub:
    """Connection registry + broadcast fan-out for B's decision stream."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._connections: list[ServerConnection] = []

    def accept(self, handler: HandlerLike) -> None:
        """Full WS lifecycle on an upgrade request; blocks until disconnect."""

        connection = _handshake(handler)
        with self._lock:
            self._connections.append(connection)
        try:
            connection.serve()
        finally:
            self._unregister([connection])

    def _unregister(self, dead: list[ServerConnection]) -> None:
        with self._lock:
            self._connections = [
                live for live in self._connections if not any(live is gone for gone in dead)
            ]

    def broadcast_json(self, payload: dict[str, Any]) -> int:
        """Send one JSON text frame to every live connection; returns count.

        Encodes the frame once, reuses the bytes, and prunes dead
        connections as it goes.
        """

        text = json.dumps(payload, ensure_ascii=False)
        frame = encode_frame(OPCODE_TEXT, text.encode("utf-8"))
        with self._lock:
            targets = list(self._connections)
        delivered = 0
        dead: list[ServerConnection] = []
        for connection in targets:
            if connection.closed or not connection._send_frame(frame):
                dead.append(connection)
            else:
                delivered += 1
        if dead:
            self._unregister(dead)
        return delivered

    def connection_count(self) -> int:
        with self._lock:
            return len(self._connections)

    def close_all(self) -> None:
        """Graceful close of every connection (server shutdown/tests)."""

        with self._lock:
            targets = list(self._connections)
            self._connections = []
        for connection in targets:
            connection.send_close()
