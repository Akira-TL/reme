"""Minimal RFC 6455 client for external runtime diagnostics.

The unified backend uses :mod:`reme.runtime.transport` for perception-to-
decision delivery. This client is intentionally outside that path: examples
and diagnostics use it to observe browser-facing ``/ws/events`` or ``/ws``
streams without adding a third-party WebSocket dependency.

It owns only WebSocket transport and RuntimeEvent envelope parsing. Production
components must not use this module for internal event delivery.

The client role mirrors the server implementation in
``reme.runtime.decision.websocket``: outbound frames are masked, while masked
server frames are protocol errors.

Delivery contract:
- Every event type A publishes is forwarded (``frame_landmarks`` included);
  filtering by type belongs to the consumer, not to the transport.
- Envelopes whose ``session_id`` differs from the subscribed session are
  dropped: this client is bound to one session by its query string.
- ``schema_version`` is passed through untouched so the ingest layer stays the
  single contract gate.
- ``on_event`` raising never kills the connection; the error is logged and the
  next message is consumed.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import struct
import sys
import threading
from collections.abc import Callable
from contextlib import suppress
from io import BufferedIOBase
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlsplit, urlunparse, urlunsplit

from reme.runtime.decision.websocket import (
    MAX_MESSAGE_BYTES,
    OPCODE_BINARY,
    OPCODE_CLOSE,
    OPCODE_CONTINUATION,
    OPCODE_PING,
    OPCODE_PONG,
    OPCODE_TEXT,
    Frame,
    compute_accept,
)
from reme.runtime.perception.runtime import RuntimeEvent, RuntimeEventType

DEFAULT_INITIAL_BACKOFF_S = 0.5
DEFAULT_RECV_TIMEOUT_S = 30.0  # A pings every 12s while idle, so silence means dead

_HANDSHAKE_KEY_BYTES = 16
_MASK_KEY_BYTES = 4
_MAX_HANDSHAKE_LINE_BYTES = 8192
_MAX_HANDSHAKE_HEADERS = 64
_MIN_JOIN_TIMEOUT_S = 5.0

_FIN_BIT = 0x80
_RSV_BITS = 0x70
_MASK_BIT = 0x80
_OPCODE_MASK = 0x0F
_LENGTH_MASK = 0x7F
_CONTROL_BIT = 0x08
_MAX_CONTROL_PAYLOAD = 125

_CLOSE_NORMAL = 1000
_CLOSE_PROTOCOL_ERROR = 1002
_CLOSE_UNSUPPORTED_DATA = 1003
_CLOSE_INVALID_PAYLOAD = 1007
_CLOSE_MESSAGE_TOO_BIG = 1009
# Codes a peer never puts on the wire, so they must not be echoed back.
_UNECHOABLE_CLOSE_CODES = frozenset({1004, 1005, 1006, 1015})


class WebSocketClientError(Exception):
    """Configuration, handshake, or protocol failure on the client side."""


class _EndOfStream(WebSocketClientError):
    """The server stopped mid-frame; no close frame can reach it any more."""


class _MessageTooBig(WebSocketClientError):
    """A declared frame length exceeds the message cap; close with 1009.

    Raised before the payload is read so a server-declared multi-GiB length
    never gets buffered.
    """


def _apply_mask(payload: bytes, mask: bytes) -> bytes:
    """XOR ``payload`` with the repeating 4-byte mask key (batched as one int)."""

    length = len(payload)
    if length == 0:
        return b""
    repeated = (mask * (length // _MASK_KEY_BYTES + 1))[:length]
    masked = int.from_bytes(payload, "big") ^ int.from_bytes(repeated, "big")
    return masked.to_bytes(length, "big")


def encode_client_frame(opcode: int, payload: bytes = b"", *, fin: bool = True) -> bytes:
    """Encode one client frame; RFC 6455 requires every client frame masked."""

    mask = os.urandom(_MASK_KEY_BYTES)
    length = len(payload)
    header = bytearray()
    header.append((_FIN_BIT if fin else 0x00) | (opcode & _OPCODE_MASK))
    if length < 126:
        header.append(_MASK_BIT | length)
    elif length < 65536:
        header.append(_MASK_BIT | 126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(_MASK_BIT | 127)
        header.extend(struct.pack("!Q", length))
    header.extend(mask)
    return bytes(header) + _apply_mask(payload, mask)


def _read_exact(reader: BufferedIOBase, size: int) -> bytes:
    """Read exactly ``size`` bytes; a short read means the server is gone."""

    if size <= 0:
        return b""
    chunks: list[bytes] = []
    remaining = size
    while remaining > 0:
        chunk = reader.read(remaining)
        if not chunk:
            raise _EndOfStream(f"stream ended {remaining} bytes short of a {size}-byte read")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_server_frame(reader: BufferedIOBase) -> Frame:
    """Read one server frame; a masked server frame is a protocol error."""

    header = _read_exact(reader, 2)
    byte0, byte1 = header[0], header[1]
    if byte0 & _RSV_BITS:
        raise WebSocketClientError("reserved frame bits must be zero")
    fin = bool(byte0 & _FIN_BIT)
    opcode = byte0 & _OPCODE_MASK
    masked = bool(byte1 & _MASK_BIT)
    length = byte1 & _LENGTH_MASK
    if opcode & _CONTROL_BIT:
        if not fin:
            raise WebSocketClientError("control frames must not be fragmented")
        if length > _MAX_CONTROL_PAYLOAD:
            raise WebSocketClientError("control frame payload must be at most 125 bytes")
    if length == 126:
        length = int(struct.unpack("!H", _read_exact(reader, 2))[0])
    elif length == 127:
        length = int(struct.unpack("!Q", _read_exact(reader, 8))[0])
        if length >> 63:
            raise WebSocketClientError("64-bit payload length must have the high bit clear")
    if length > MAX_MESSAGE_BYTES:
        # Checked before the payload read: never buffer an oversize frame.
        raise _MessageTooBig(f"declared frame length {length} exceeds {MAX_MESSAGE_BYTES}")
    if masked:
        raise WebSocketClientError("server frames must not be masked")
    return Frame(fin=fin, opcode=opcode, payload=_read_exact(reader, length))


def parse_event_message(text: str) -> RuntimeEvent:
    """Rebuild one RuntimeEvent from an untrusted JSON text frame.

    ``RuntimeEvent`` has no ``from_payload`` classmethod, so the envelope is
    rebuilt field by field and the frozen dataclass owns the validation. A
    missing ``schema_version`` falls back to the dataclass default; a present
    one is passed through so the ingest layer stays the single contract gate.
    """

    decoded: object = json.loads(text)
    if not isinstance(decoded, dict):
        raise WebSocketClientError("runtime event must be a JSON object")
    event_type_raw = decoded.get("event_type")
    if not isinstance(event_type_raw, str):
        raise WebSocketClientError("event_type must be a string")
    try:
        event_type = RuntimeEventType(event_type_raw)
    except ValueError as exc:
        raise WebSocketClientError(f"unknown event_type {event_type_raw!r}") from exc
    # Left untyped on purpose: the frozen contract dataclass owns session_id /
    # sequence / payload validation, so one wrap covers every field.
    session_id: Any = decoded.get("session_id")
    sequence: Any = decoded.get("sequence")
    payload: Any = decoded.get("payload")
    schema_version: Any = decoded.get("schema_version")
    fields: dict[str, Any] = {
        "session_id": session_id,
        "sequence": sequence,
        "event_type": event_type,
        "payload": payload,
    }
    if schema_version is not None:
        fields["schema_version"] = schema_version
    try:
        # RuntimeSessionError subclasses ValueError, so one clause covers both.
        return RuntimeEvent(**fields)
    except (ValueError, TypeError) as exc:
        raise WebSocketClientError(f"invalid runtime event envelope: {exc}") from exc


def _echo_close_code(payload: bytes) -> int:
    """The status code to mirror back for a received close frame."""

    if len(payload) < 2:
        return _CLOSE_NORMAL
    code = int(struct.unpack("!H", payload[:2])[0])
    if code < 1000 or code in _UNECHOABLE_CLOSE_CODES:
        return _CLOSE_NORMAL
    return code


def _has_connection_token(value: str, token: str) -> bool:
    """True when a comma-separated Connection header carries ``token``."""

    return any(part.strip().lower() == token for part in value.split(","))


def _redact_url(url: str) -> str:
    """Log-safe rendering: keep scheme/host/port/path, drop userinfo and query.

    A deployment may authenticate to A with ``?token=…`` or userinfo; neither
    may ever reach a log line (Codex R4).
    """

    try:
        parsed = urlsplit(url)
    except ValueError:
        return "<unparseable url>"
    host = parsed.hostname or ""
    if parsed.port is not None:
        host = f"{host}:{parsed.port}"
    shown = urlunsplit((parsed.scheme, host, parsed.path, "", ""))
    return f"{shown}?<redacted>" if parsed.query else shown


def _split_ws_url(url: str, session_id: str) -> tuple[str, int, str, str]:
    """Split ``ws://host:port/path`` into (host, port, Host header, resource).

    ``session_id`` always wins over any value already in the query string, so
    the socket can never subscribe to a session other than the configured one.
    """

    parsed = urlparse(url)
    if parsed.scheme != "ws":
        raise WebSocketClientError(
            f"url scheme must be 'ws' (wss is not supported yet), got {parsed.scheme!r}"
        )
    host = parsed.hostname
    if not host:
        raise WebSocketClientError(f"url must contain a host, got {url!r}")
    port = parsed.port or 80
    query = [
        (name, value)
        for name, value in parse_qsl(parsed.query, keep_blank_values=True)
        if name != "session_id"
    ]
    query.append(("session_id", session_id))
    resource = urlunparse(("", "", parsed.path or "/", parsed.params, urlencode(query), ""))
    bracketed = f"[{host}]" if ":" in host else host
    return host, port, f"{bracketed}:{port}", resource


class PerceptionEventClient:
    """Subscribe to A's ``/ws/events`` stream and hand every event to a callback.

    ``start()`` runs one daemon thread that connects, consumes, and reconnects
    with capped exponential backoff until ``stop()``. Both are safe to call
    from any thread, including from inside ``on_event``.
    """

    def __init__(
        self,
        *,
        url: str,
        session_id: str,
        on_event: Callable[[RuntimeEvent], None],
        connect_timeout_s: float = 5.0,
        max_backoff_s: float = 5.0,
        initial_backoff_s: float = DEFAULT_INITIAL_BACKOFF_S,
        recv_timeout_s: float = DEFAULT_RECV_TIMEOUT_S,
    ) -> None:
        if not isinstance(session_id, str) or not session_id.strip():
            raise WebSocketClientError("session_id must be a non-empty string")
        for name, value in (
            ("connect_timeout_s", connect_timeout_s),
            ("max_backoff_s", max_backoff_s),
            ("initial_backoff_s", initial_backoff_s),
            ("recv_timeout_s", recv_timeout_s),
        ):
            if value <= 0:
                raise WebSocketClientError(f"{name} must be positive, got {value!r}")
        if max_backoff_s < initial_backoff_s:
            raise WebSocketClientError("max_backoff_s must be at least initial_backoff_s")
        self._url = url
        self._safe_url = _redact_url(url)
        self._session_id = session_id.strip()
        self._on_event = on_event
        self._connect_timeout_s = connect_timeout_s
        self._max_backoff_s = max_backoff_s
        self._initial_backoff_s = initial_backoff_s
        self._recv_timeout_s = recv_timeout_s
        self._host, self._port, self._host_header, self._resource = _split_ws_url(
            url, self._session_id
        )
        # A blocked connect cannot be interrupted, only waited out.
        self._join_timeout_s = max(_MIN_JOIN_TIMEOUT_S, connect_timeout_s + 1.0)
        # Never held while ``on_event`` runs: a callback calling stop() would
        # deadlock on this non-reentrant lock.
        self._lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._socket: socket.socket | None = None
        self._connected = False
        self._close_sent = False

    # -- lifecycle ----------------------------------------------------------

    @property
    def connected(self) -> bool:
        """True between a completed handshake and the connection dropping."""

        with self._lock:
            return self._connected

    def start(self) -> None:
        """Start the background consumer; a no-op while one is already running."""

        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            # A fresh event per run: a thread still winding down from a
            # previous stop() keeps its own (already set) event and exits.
            self._stop_event = threading.Event()
            stop_event = self._stop_event
            thread = threading.Thread(
                target=self._run,
                args=(stop_event,),
                name=f"reme-perception-ws-{self._session_id}",
                daemon=True,
            )
            self._thread = thread
        thread.start()

    def stop(self) -> None:
        """Stop consuming and reconnecting; idempotent, safe from any thread."""

        with self._lock:
            stop_event = self._stop_event
            thread = self._thread
        # Set first, then read the socket: a connect finishing concurrently
        # either publishes its socket before this read, or sees the flag and
        # discards the socket itself.
        stop_event.set()
        with self._lock:
            sock = self._socket
        if sock is not None:
            self._send_close(sock, _CLOSE_NORMAL)
            with suppress(OSError):
                sock.shutdown(socket.SHUT_RDWR)
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=self._join_timeout_s)
        with self._lock:
            self._connected = False
            if self._thread is thread:
                self._thread = None

    # -- connection loop ----------------------------------------------------

    def _run(self, stop_event: threading.Event) -> None:
        backoff = self._initial_backoff_s
        while not stop_event.is_set():
            try:
                sock, reader = self._connect()
            except (OSError, WebSocketClientError) as exc:
                # Never the raw URL: it may carry userinfo or a token query
                # that would then sit in the logs forever (Codex R4).
                self._warn(f"connect to {self._safe_url} failed: {exc}")
                if stop_event.wait(backoff):
                    return
                backoff = min(backoff * 2.0, self._max_backoff_s)
                continue
            if not self._publish(sock, reader, stop_event):
                return
            backoff = self._initial_backoff_s
            try:
                self._consume(sock, reader, stop_event)
            finally:
                self._retire(sock, reader)
            if stop_event.wait(self._initial_backoff_s):
                return

    def _connect(self) -> tuple[socket.socket, BufferedIOBase]:
        sock = socket.create_connection((self._host, self._port), timeout=self._connect_timeout_s)
        try:
            with suppress(OSError):
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            reader: BufferedIOBase = sock.makefile("rb")
        except BaseException:
            sock.close()
            raise
        try:
            key = base64.b64encode(os.urandom(_HANDSHAKE_KEY_BYTES)).decode("ascii")
            sock.sendall(self._handshake_request(key).encode("ascii"))
            _validate_handshake_response(reader, key)
            # The handshake timeout was the connect budget; frames get their own.
            sock.settimeout(self._recv_timeout_s)
        except BaseException:
            _discard(sock, reader)
            raise
        return sock, reader

    def _handshake_request(self, key: str) -> str:
        return (
            f"GET {self._resource} HTTP/1.1\r\n"
            f"Host: {self._host_header}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )

    def _publish(
        self, sock: socket.socket, reader: BufferedIOBase, stop_event: threading.Event
    ) -> bool:
        """Register the live socket so stop() can wake a blocked recv."""

        with self._send_lock:
            self._close_sent = False
        with self._lock:
            if stop_event.is_set():
                stale = True
            else:
                self._socket = sock
                self._connected = True
                stale = False
        if stale:
            _discard(sock, reader)
            return False
        return True

    def _retire(self, sock: socket.socket, reader: BufferedIOBase) -> None:
        with self._lock:
            if self._socket is sock:
                self._socket = None
            self._connected = False
        _discard(sock, reader)

    def _consume(
        self, sock: socket.socket, reader: BufferedIOBase, stop_event: threading.Event
    ) -> None:
        """Blocking recv loop: pong pings, reassemble fragments, dispatch text."""

        fragments: list[bytes] = []
        pending_bytes = 0
        fragmented = False
        try:
            while not stop_event.is_set():
                frame = read_server_frame(reader)
                opcode = frame.opcode
                if opcode == OPCODE_PONG:
                    continue
                if opcode == OPCODE_PING:
                    self._send(sock, encode_client_frame(OPCODE_PONG, frame.payload))
                    continue
                if opcode == OPCODE_CLOSE:
                    self._send_close(sock, _echo_close_code(frame.payload))
                    return
                if opcode == OPCODE_BINARY:
                    self._send_close(sock, _CLOSE_UNSUPPORTED_DATA)
                    return
                if opcode == OPCODE_TEXT:
                    if fragmented:
                        self._send_close(sock, _CLOSE_PROTOCOL_ERROR)
                        return
                    fragments = [frame.payload]
                    pending_bytes = len(frame.payload)
                elif opcode == OPCODE_CONTINUATION:
                    if not fragmented:
                        self._send_close(sock, _CLOSE_PROTOCOL_ERROR)
                        return
                    fragments.append(frame.payload)
                    pending_bytes += len(frame.payload)
                else:
                    self._send_close(sock, _CLOSE_PROTOCOL_ERROR)
                    return
                if pending_bytes > MAX_MESSAGE_BYTES:
                    self._warn(f"message over {MAX_MESSAGE_BYTES} bytes; dropping the connection")
                    self._send_close(sock, _CLOSE_MESSAGE_TOO_BIG)
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
                    self._send_close(sock, _CLOSE_INVALID_PAYLOAD)
                    return
                self._dispatch(text)
        except _MessageTooBig as exc:
            self._warn(f"{exc}; dropping the connection")
            self._send_close(sock, _CLOSE_MESSAGE_TOO_BIG)
        except (_EndOfStream, OSError):
            # The server vanished (or stop() shut the socket down); a close
            # frame would go nowhere.
            pass
        except WebSocketClientError as exc:
            self._warn(f"protocol error: {exc}")
            self._send_close(sock, _CLOSE_PROTOCOL_ERROR)

    def _dispatch(self, text: str) -> None:
        """Parse one message and hand it to the callback, absorbing failures."""

        try:
            event = parse_event_message(text)
        except (WebSocketClientError, json.JSONDecodeError) as exc:
            self._warn(f"dropping malformed event: {exc}")
            return
        if event.session_id != self._session_id:
            self._warn(
                f"dropping event for session {event.session_id!r}; "
                f"subscribed to {self._session_id!r}"
            )
            return
        try:
            self._on_event(event)
        except Exception as exc:  # noqa: BLE001 - a bad consumer must not kill the stream
            self._warn(
                f"on_event failed for sequence {event.sequence}: {type(exc).__name__}: {exc}"
            )

    # -- transport helpers --------------------------------------------------

    def _send(self, sock: socket.socket, frame: bytes) -> None:
        with self._send_lock, suppress(OSError):
            sock.sendall(frame)

    def _send_close(self, sock: socket.socket, code: int) -> None:
        with self._send_lock:
            if self._close_sent:
                return
            self._close_sent = True
            with suppress(OSError):
                sock.sendall(encode_client_frame(OPCODE_CLOSE, struct.pack("!H", code)))

    def _warn(self, message: str) -> None:
        print(f"warning: perception ws client: {message}", file=sys.stderr)


def _discard(sock: socket.socket, reader: BufferedIOBase) -> None:
    with suppress(OSError):
        reader.close()
    with suppress(OSError):
        sock.close()


def _read_handshake_line(reader: BufferedIOBase) -> str:
    line = reader.readline(_MAX_HANDSHAKE_LINE_BYTES)
    if not line:
        raise _EndOfStream("server closed the connection during the handshake")
    if not line.endswith(b"\n"):
        raise WebSocketClientError("handshake response line exceeds the header budget")
    return line.decode("latin-1").strip()


def _validate_handshake_response(reader: BufferedIOBase, key: str) -> None:
    """Require 101 plus a matching Sec-WebSocket-Accept before any frame is read."""

    status_line = _read_handshake_line(reader)
    parts = status_line.split(" ", 2)
    if len(parts) < 2 or not parts[0].upper().startswith("HTTP/"):
        raise WebSocketClientError(f"malformed HTTP status line: {status_line!r}")
    if parts[1] != "101":
        raise WebSocketClientError(f"expected '101 Switching Protocols', got {status_line!r}")
    headers: dict[str, str] = {}
    for _ in range(_MAX_HANDSHAKE_HEADERS):
        line = _read_handshake_line(reader)
        if not line:
            break
        name, separator, value = line.partition(":")
        if not separator:
            raise WebSocketClientError(f"malformed handshake header: {line!r}")
        headers[name.strip().lower()] = value.strip()
    else:
        raise WebSocketClientError("handshake response carries too many headers")
    if headers.get("upgrade", "").lower() != "websocket":
        raise WebSocketClientError("handshake response Upgrade header must be 'websocket'")
    if not _has_connection_token(headers.get("connection", ""), "upgrade"):
        raise WebSocketClientError("handshake response Connection header must contain 'upgrade'")
    expected = compute_accept(key)
    if headers.get("sec-websocket-accept") != expected:
        raise WebSocketClientError("handshake response Sec-WebSocket-Accept does not match the key")
