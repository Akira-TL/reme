"""RFC 6455 protocol tests for B's decision WebSocket surface.

Pure codec paths run over BytesIO; the lifecycle paths run over a real
``socket.socketpair`` with a hand-written client so the framing is checked
against an independent implementation rather than against itself.
"""

from __future__ import annotations

import json
import socket
import struct
import threading
import time
from collections.abc import Callable
from contextlib import suppress
from io import BytesIO
from types import SimpleNamespace
from typing import Any, BinaryIO

import pytest
from reme.decision.websocket import (
    MAX_MESSAGE_BYTES,
    OPCODE_BINARY,
    OPCODE_CLOSE,
    OPCODE_CONTINUATION,
    OPCODE_PING,
    OPCODE_PONG,
    OPCODE_TEXT,
    DecisionEventHub,
    ServerConnection,
    WebSocketError,
    compute_accept,
    encode_frame,
    read_frame,
)

_RFC_KEY = "dGhlIHNhbXBsZSBub25jZQ=="
_RFC_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
_MASK = b"\x37\xfa\x21\x3d"
_TIMEOUT_S = 5.0


# -- test-side client framing (deliberately independent of the module) ------


def _client_frame(
    opcode: int,
    payload: bytes,
    *,
    fin: bool = True,
    mask: bytes = _MASK,
) -> bytes:
    """Encode one masked client frame — the only direction a server accepts."""

    length = len(payload)
    header = bytearray()
    header.append((0x80 if fin else 0x00) | opcode)
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.append(0x80 | 126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack("!Q", length))
    header.extend(mask)
    header.extend(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return bytes(header)


def _read_server_frame(reader: BinaryIO) -> tuple[bool, int, bytes]:
    """Parse one unmasked server frame into (fin, opcode, payload)."""

    header = reader.read(2)
    if len(header) < 2:
        raise AssertionError("server closed before sending a frame")
    assert header[1] & 0x80 == 0, "server frames must never be masked"
    fin = bool(header[0] & 0x80)
    opcode = header[0] & 0x0F
    length = header[1] & 0x7F
    if length == 126:
        (length,) = struct.unpack("!H", reader.read(2))
    elif length == 127:
        (length,) = struct.unpack("!Q", reader.read(8))
    return fin, opcode, reader.read(length) if length else b""


def _decode_server_frames(data: bytes) -> list[tuple[bool, int, bytes]]:
    reader = BytesIO(data)
    frames: list[tuple[bool, int, bytes]] = []
    while reader.tell() < len(data):
        frames.append(_read_server_frame(reader))
    return frames


def _close_payload(code: int) -> bytes:
    return struct.pack("!H", code)


# -- handler / connection harnesses -----------------------------------------


def _handshake_headers(
    *,
    upgrade: str | None = "WebSocket",
    connection: str | None = "keep-alive, Upgrade",
    key: str | None = _RFC_KEY,
    version: str | None = "13",
) -> dict[str, str]:
    headers: dict[str, str] = {}
    if upgrade is not None:
        headers["Upgrade"] = upgrade
    if connection is not None:
        headers["Connection"] = connection
    if key is not None:
        headers["Sec-WebSocket-Key"] = key
    if version is not None:
        headers["Sec-WebSocket-Version"] = version
    return headers


class _NoTcpOptions:
    """A transport that rejects TCP_NODELAY, like a unix socket or some TLS wrappers."""

    def setsockopt(self, *args: int) -> None:
        raise OSError("TCP_NODELAY is unavailable on this transport")


def _fake_handler(
    *,
    headers: dict[str, str],
    command: str = "GET",
    rfile: BinaryIO | None = None,
    wfile: Any = None,
    connection: Any = None,
) -> SimpleNamespace:
    """The BaseHTTPRequestHandler slice the hub is allowed to touch."""

    return SimpleNamespace(
        command=command,
        headers=headers,
        rfile=BytesIO() if rfile is None else rfile,
        wfile=BytesIO() if wfile is None else wfile,
        connection=_NoTcpOptions() if connection is None else connection,
    )


class _BrokenWriter(BytesIO):
    """A wfile that starts working and then fails like a dropped peer."""

    def __init__(self) -> None:
        super().__init__()
        self.fail = False

    def write(self, data: Any) -> int:  # type: ignore[override]
        if self.fail:
            raise BrokenPipeError("peer went away")
        return super().write(data)


class _Peer:
    """Test-side WebSocket client over one half of a socketpair."""

    def __init__(self, sock: socket.socket) -> None:
        sock.settimeout(_TIMEOUT_S)
        self._sock = sock
        self._reader = sock.makefile("rb")

    def send(self, opcode: int, payload: bytes, *, fin: bool = True) -> None:
        self._sock.sendall(_client_frame(opcode, payload, fin=fin))

    def read_handshake(self) -> str:
        lines: list[bytes] = []
        while True:
            line = self._reader.readline()
            if line in (b"\r\n", b""):
                break
            lines.append(line)
        return b"".join(lines).decode("ascii")

    def read_frame(self) -> tuple[bool, int, bytes]:
        return _read_server_frame(self._reader)

    def close(self) -> None:
        with suppress(OSError):
            self._reader.close()
        self._sock.close()


class _Link:
    """One socketpair: test-side peer plus the server-side plumbing.

    With ``hub`` the hub owns the lifecycle (handshake + serve in a thread);
    without it the test drives a bare ServerConnection.
    """

    def __init__(self, *, hub: DecisionEventHub | None = None) -> None:
        client, server = socket.socketpair()
        self._server_sock = server
        self._rfile = server.makefile("rb")
        self._wfile = server.makefile("wb")
        self.peer = _Peer(client)
        self.connection: ServerConnection | None = None
        self.thread: threading.Thread | None = None
        self.handshake = ""
        if hub is None:
            self.connection = ServerConnection(
                connection=server, rfile=self._rfile, wfile=self._wfile
            )
            return
        handler = _fake_handler(
            headers=_handshake_headers(),
            rfile=self._rfile,
            wfile=self._wfile,
            connection=server,
        )
        self.thread = threading.Thread(target=hub.accept, args=(handler,), daemon=True)
        self.thread.start()
        self.handshake = self.peer.read_handshake()

    def serve_in_thread(self, on_text: Callable[[str], None] | None = None) -> threading.Thread:
        assert self.connection is not None
        thread = threading.Thread(target=self.connection.serve, args=(on_text,), daemon=True)
        self.thread = thread
        thread.start()
        return thread

    def close(self) -> None:
        # Drop the client first so the recv loop sees EOF, join, only then
        # close the server-side files the loop is still reading from.
        self.peer.close()
        if self.thread is not None:
            self.thread.join(timeout=_TIMEOUT_S)
            assert not self.thread.is_alive(), "serve loop did not exit"
        with suppress(OSError):
            self._wfile.close()
        self._rfile.close()
        self._server_sock.close()


def _await_connections(hub: DecisionEventHub, expected: int) -> None:
    """Wait for hub registration/unregistration to settle."""

    deadline = time.monotonic() + _TIMEOUT_S
    while time.monotonic() < deadline:
        if hub.connection_count() == expected:
            return
        time.sleep(0.005)
    raise AssertionError(f"hub stayed at {hub.connection_count()} connections, wanted {expected}")


# -- handshake --------------------------------------------------------------


def test_compute_accept_matches_the_rfc_vector() -> None:
    assert compute_accept(_RFC_KEY) == _RFC_ACCEPT


def test_accept_writes_the_101_response_and_unregisters_on_eof() -> None:
    hub = DecisionEventHub()
    wfile = BytesIO()
    handler = _fake_handler(headers=_handshake_headers(), wfile=wfile)

    hub.accept(handler)  # empty rfile -> immediate EOF -> serve returns

    response = wfile.getvalue().decode("ascii")
    assert response.startswith("HTTP/1.1 101 Switching Protocols\r\n")
    assert "Upgrade: websocket\r\n" in response
    assert "Connection: Upgrade\r\n" in response
    assert f"Sec-WebSocket-Accept: {_RFC_ACCEPT}\r\n" in response
    assert response.endswith("\r\n\r\n")
    assert "Sec-WebSocket-Extensions" not in response
    assert "Sec-WebSocket-Protocol" not in response
    assert hub.connection_count() == 0


def test_handshake_failures_raise_before_any_byte_is_written() -> None:
    hub = DecisionEventHub()
    cases = {
        "missing key": _fake_handler(headers=_handshake_headers(key=None)),
        "wrong version": _fake_handler(headers=_handshake_headers(version="8")),
        "not a GET": _fake_handler(headers=_handshake_headers(), command="POST"),
        "no upgrade token": _fake_handler(headers=_handshake_headers(connection="keep-alive")),
        "wrong upgrade": _fake_handler(headers=_handshake_headers(upgrade="h2c")),
    }
    for label, handler in cases.items():
        with pytest.raises(WebSocketError):
            hub.accept(handler)
        assert handler.wfile.getvalue() == b"", f"{label} wrote bytes before failing"
    assert hub.connection_count() == 0


# -- pure framing -----------------------------------------------------------


def test_frames_round_trip_across_the_three_length_classes() -> None:
    for size, marker in ((5, 5), (200, 126), (70_000, 127)):
        payload = bytes(index % 251 for index in range(size))
        server_frame = encode_frame(OPCODE_TEXT, payload)
        assert server_frame[1] & 0x80 == 0, "server frames are never masked"
        assert server_frame[1] & 0x7F == marker
        assert server_frame.endswith(payload)

        frame = read_frame(BytesIO(_client_frame(OPCODE_TEXT, payload)))
        assert (frame.fin, frame.opcode, frame.payload) == (True, OPCODE_TEXT, payload)


def test_read_frame_unmasks_a_client_payload() -> None:
    payload = "老人跌倒了".encode()
    raw = _client_frame(OPCODE_TEXT, payload)

    assert payload not in raw, "the client payload must travel masked"
    assert read_frame(BytesIO(raw)).payload.decode("utf-8") == "老人跌倒了"


def test_read_frame_rejects_an_unmasked_client_frame() -> None:
    with pytest.raises(WebSocketError):
        read_frame(BytesIO(encode_frame(OPCODE_TEXT, b"hello")))


def test_read_frame_rejects_reserved_bits() -> None:
    raw = bytearray(_client_frame(OPCODE_TEXT, b"hello"))
    raw[0] |= 0x40  # RSV2
    with pytest.raises(WebSocketError):
        read_frame(BytesIO(bytes(raw)))


def test_read_frame_rejects_an_oversized_control_frame() -> None:
    with pytest.raises(WebSocketError):
        read_frame(BytesIO(_client_frame(OPCODE_PING, b"p" * 126)))


def test_read_frame_rejects_a_64bit_length_with_the_high_bit_set() -> None:
    raw = bytearray(_client_frame(OPCODE_TEXT, b"x" * 70_000))
    raw[2] |= 0x80  # most significant byte of the 8-byte length
    with pytest.raises(WebSocketError):
        read_frame(BytesIO(bytes(raw)))


def test_read_frame_rejects_a_truncated_payload() -> None:
    with pytest.raises(WebSocketError):
        read_frame(BytesIO(_client_frame(OPCODE_TEXT, b"hello")[:-2]))


# -- recv loop over BytesIO -------------------------------------------------


def test_serve_assembles_a_fragmented_text_message() -> None:
    stream = (
        _client_frame(OPCODE_TEXT, "跌".encode(), fin=False)
        + _client_frame(OPCODE_PING, b"mid", fin=True)
        + _client_frame(OPCODE_CONTINUATION, "倒".encode(), fin=False)
        + _client_frame(OPCODE_CONTINUATION, "了".encode())
        + _client_frame(OPCODE_CLOSE, _close_payload(1000))
    )
    wfile = BytesIO()
    received: list[str] = []
    connection = ServerConnection(connection=None, rfile=BytesIO(stream), wfile=wfile)

    connection.serve(received.append)

    assert received == ["跌倒了"]
    assert _decode_server_frames(wfile.getvalue()) == [
        (True, OPCODE_PONG, b"mid"),
        (True, OPCODE_CLOSE, _close_payload(1000)),
    ]
    assert connection.closed is True


def test_serve_rejects_a_new_data_frame_inside_a_fragment() -> None:
    stream = _client_frame(OPCODE_TEXT, b"a", fin=False) + _client_frame(OPCODE_TEXT, b"b")
    wfile = BytesIO()
    received: list[str] = []

    ServerConnection(connection=None, rfile=BytesIO(stream), wfile=wfile).serve(received.append)

    assert received == []
    assert _decode_server_frames(wfile.getvalue()) == [(True, OPCODE_CLOSE, _close_payload(1002))]


def test_serve_closes_1003_on_a_binary_frame() -> None:
    wfile = BytesIO()
    rfile = BytesIO(_client_frame(OPCODE_BINARY, b"\x00\x01"))

    ServerConnection(connection=None, rfile=rfile, wfile=wfile).serve()

    assert _decode_server_frames(wfile.getvalue()) == [(True, OPCODE_CLOSE, _close_payload(1003))]


def test_send_marks_the_connection_dead_on_a_write_error() -> None:
    wfile = _BrokenWriter()
    wfile.fail = True
    connection = ServerConnection(connection=None, rfile=BytesIO(), wfile=wfile)

    connection.send_text("我在")

    assert connection.closed is True


# -- socketpair end to end --------------------------------------------------


def test_connection_relays_text_and_answers_a_ping() -> None:
    link = _Link()
    received: list[str] = []
    try:
        link.serve_in_thread(received.append)
        link.peer.send(OPCODE_TEXT, "现在还好吗".encode())
        link.peer.send(OPCODE_PING, b"beat")
        assert link.peer.read_frame() == (True, OPCODE_PONG, b"beat")

        assert link.connection is not None
        link.connection.send_text("我在")
        assert link.peer.read_frame() == (True, OPCODE_TEXT, "我在".encode())
    finally:
        link.close()
    assert received == ["现在还好吗"]


def test_client_close_is_echoed_and_ends_the_loop() -> None:
    link = _Link()
    try:
        link.serve_in_thread()
        link.peer.send(OPCODE_CLOSE, _close_payload(1000))
        assert link.peer.read_frame() == (True, OPCODE_CLOSE, _close_payload(1000))
        assert link.thread is not None
        link.thread.join(timeout=_TIMEOUT_S)
        assert link.connection is not None
        assert link.connection.closed is True
    finally:
        link.close()


def test_oversized_message_closes_1009() -> None:
    link = _Link()
    try:
        link.serve_in_thread()
        link.peer.send(OPCODE_TEXT, b"x" * (MAX_MESSAGE_BYTES + 1))
        assert link.peer.read_frame() == (True, OPCODE_CLOSE, _close_payload(1009))
    finally:
        link.close()


def test_hub_broadcasts_one_frame_to_every_connection() -> None:
    hub = DecisionEventHub()
    payload = {"event": "care_decision", "level": "watch", "note": "老人久坐"}
    first = _Link(hub=hub)
    second = _Link(hub=hub)
    try:
        assert first.handshake.startswith("HTTP/1.1 101 Switching Protocols")
        _await_connections(hub, 2)

        assert hub.broadcast_json(payload) == 2

        for link in (first, second):
            fin, opcode, body = link.peer.read_frame()
            assert (fin, opcode) == (True, OPCODE_TEXT)
            assert body == json.dumps(payload, ensure_ascii=False).encode("utf-8")
            assert json.loads(body.decode("utf-8")) == payload
    finally:
        first.close()
        second.close()


def test_hub_prunes_a_disconnected_client() -> None:
    hub = DecisionEventHub()
    alive = _Link(hub=hub)
    doomed = _Link(hub=hub)
    try:
        _await_connections(hub, 2)
        assert hub.broadcast_json({"seq": 1}) == 2
        assert alive.peer.read_frame()[1] == OPCODE_TEXT
        assert doomed.peer.read_frame()[1] == OPCODE_TEXT

        doomed.close()
        _await_connections(hub, 1)

        assert hub.broadcast_json({"seq": 2}) == 1
        assert alive.peer.read_frame()[1] == OPCODE_TEXT
    finally:
        alive.close()


def test_close_all_closes_and_clears_every_connection() -> None:
    hub = DecisionEventHub()
    first = _Link(hub=hub)
    second = _Link(hub=hub)
    try:
        _await_connections(hub, 2)

        hub.close_all()

        assert hub.connection_count() == 0
        for link in (first, second):
            assert link.peer.read_frame() == (True, OPCODE_CLOSE, _close_payload(1000))
        assert hub.broadcast_json({"seq": 1}) == 0
    finally:
        first.close()
        second.close()
