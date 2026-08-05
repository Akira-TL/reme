"""Client-role RFC 6455 tests for B's subscription to A's perception stream.

Most tests run against a hand-written fake A endpoint on a real loopback
socket (port 0), so the client's framing is validated against an independent
implementation rather than against itself. The fake never masks what it sends
and always unmasks what it receives — the mirror image of
``tests/test_decision_websocket.py``, which drives B's server half. The last
test closes the loop against A's own ``build_runtime_handler``.

Timing is expressed as bounded condition waits, never as fixed sleeps.
"""

from __future__ import annotations

import base64
import hashlib
import json
import socket
import struct
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import suppress
from http.server import ThreadingHTTPServer
from io import BufferedIOBase
from typing import Any

import pytest
from reme.runtime.debug_ws_client import PerceptionEventClient, WebSocketClientError
from reme.runtime.perception.runtime import (
    ModeProfile,
    RuntimeEvent,
    RuntimeEventType,
    RuntimeSessionRequest,
)
from reme.runtime.perception.runtime_server import (
    RuntimePerceptionController,
    build_runtime_handler,
)

_OPCODE_CONTINUATION = 0x0
_OPCODE_TEXT = 0x1
_OPCODE_CLOSE = 0x8
_OPCODE_PING = 0x9
_OPCODE_PONG = 0xA

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_SESSION_ID = "sess-live-001"
_EVENT_SCHEMA = "reme-runtime-event/v0-experiment"
_MAX_MESSAGE_BYTES = 1024 * 1024  # the client's cap, restated independently
_TIMEOUT_S = 5.0
_POLL_S = 0.005
# Comfortably larger than the client's backoff, so a wrongly-reconnecting
# client would have tried several times inside the window.
_NEGATIVE_WINDOW_S = 0.3


# -- waiting ----------------------------------------------------------------


def _wait_until(
    predicate: Callable[[], bool], description: str, *, timeout_s: float = _TIMEOUT_S
) -> None:
    """Poll until ``predicate`` holds, or fail with what was being waited on."""

    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(_POLL_S)
    raise AssertionError(f"timed out after {timeout_s}s waiting for {description}")


def _stays_false(predicate: Callable[[], bool], description: str) -> None:
    """Fail as soon as ``predicate`` turns true inside the negative window."""

    deadline = time.monotonic() + _NEGATIVE_WINDOW_S
    while time.monotonic() < deadline:
        if predicate():
            raise AssertionError(f"unexpectedly observed {description}")
        time.sleep(_POLL_S)


# -- test-side framing (deliberately independent of the module) -------------


def _accept_for(key: str) -> str:
    digest = hashlib.sha1((key + _WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def _server_frame(opcode: int, payload: bytes, *, fin: bool = True) -> bytes:
    """Encode one unmasked server frame — the only direction a client accepts."""

    length = len(payload)
    header = bytearray()
    header.append((0x80 if fin else 0x00) | opcode)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))
    return bytes(header) + payload


def _read_http_request(reader: BufferedIOBase) -> tuple[str, dict[str, str]]:
    request_line = reader.readline().decode("latin-1").strip()
    headers: dict[str, str] = {}
    while True:
        line = reader.readline()
        if line in (b"\r\n", b"\n", b""):
            return request_line, headers
        name, _, value = line.decode("latin-1").partition(":")
        headers[name.strip().lower()] = value.strip()


class _ClientLink:
    """One accepted client connection, driven frame by frame from the test."""

    def __init__(
        self,
        sock: socket.socket,
        reader: BufferedIOBase,
        request_line: str,
        headers: dict[str, str],
    ) -> None:
        self.sock = sock
        self.request_line = request_line
        self.headers = headers
        self._reader = reader

    def send(self, opcode: int, payload: bytes = b"", *, fin: bool = True) -> None:
        self.sock.sendall(_server_frame(opcode, payload, fin=fin))

    def send_raw(self, data: bytes) -> None:
        self.sock.sendall(data)

    def send_event(
        self,
        *,
        sequence: int,
        session_id: str = _SESSION_ID,
        event_type: str = "posture_observation",
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        envelope: dict[str, Any] = {
            "schema_version": _EVENT_SCHEMA,
            "session_id": session_id,
            "sequence": sequence,
            "event_type": event_type,
            "payload": payload if payload is not None else _sample_payload(sequence),
        }
        self.send(_OPCODE_TEXT, json.dumps(envelope, ensure_ascii=False).encode("utf-8"))
        return envelope

    def read_client_frame(self) -> tuple[bool, int, bytes]:
        """Parse one client frame; client frames must always arrive masked."""

        header = self._reader.read(2)
        if header is None or len(header) < 2:
            raise AssertionError("client closed before sending a frame")
        assert header[1] & 0x80, "client frames must always be masked"
        fin = bool(header[0] & 0x80)
        opcode = header[0] & 0x0F
        length = header[1] & 0x7F
        if length == 126:
            (length,) = struct.unpack("!H", self._reader.read(2))
        elif length == 127:
            (length,) = struct.unpack("!Q", self._reader.read(8))
        mask = self._reader.read(4)
        payload = self._reader.read(length) if length else b""
        return fin, opcode, bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))

    def close(self) -> None:
        with suppress(OSError):
            self._reader.close()
        with suppress(OSError):
            self.sock.close()


def _sample_payload(sequence: int) -> dict[str, Any]:
    return {
        "scene_id": "living-room",
        "timestamp_ms": 1000.0 + sequence,
        "posture": "sitting",
        "note": "老人坐着没动",
    }


# -- fake A -----------------------------------------------------------------


class _FakeAServer:
    """The slice of A's ``/ws/events`` endpoint the client actually talks to."""

    def __init__(
        self, *, reject_status: str | None = None, accept_override: str | None = None
    ) -> None:
        self._reject_status = reject_status
        self._accept_override = accept_override
        self._listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(8)
        self._listener.settimeout(0.1)
        self.port = int(self._listener.getsockname()[1])
        self._lock = threading.Lock()
        self._links: list[_ClientLink] = []
        self._attempts = 0
        self._closed = threading.Event()
        self._thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/ws/events"

    @property
    def attempts(self) -> int:
        """TCP connections accepted so far, handshake outcome aside."""

        with self._lock:
            return self._attempts

    def link_count(self) -> int:
        with self._lock:
            return len(self._links)

    def wait_for_link(self, index: int = 0) -> _ClientLink:
        _wait_until(lambda: self.link_count() > index, f"upgraded connection #{index}")
        with self._lock:
            return self._links[index]

    def close(self) -> None:
        self._closed.set()
        with self._lock:
            links = list(self._links)
            self._links = []
        for link in links:
            link.close()
        with suppress(OSError):
            self._listener.close()
        self._thread.join(timeout=_TIMEOUT_S)

    def _accept_loop(self) -> None:
        while not self._closed.is_set():
            try:
                sock, _ = self._listener.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            with self._lock:
                self._attempts += 1
            worker = threading.Thread(target=self._serve, args=(sock,), daemon=True)
            worker.start()

    def _serve(self, sock: socket.socket) -> None:
        sock.settimeout(_TIMEOUT_S)
        reader: BufferedIOBase = sock.makefile("rb")
        try:
            request_line, headers = _read_http_request(reader)
        except OSError:
            _drop(sock, reader)
            return
        if self._reject_status is not None:
            with suppress(OSError):
                sock.sendall(
                    f"HTTP/1.1 {self._reject_status}\r\nContent-Length: 0\r\n\r\n".encode("ascii")
                )
            _drop(sock, reader)
            return
        accept = self._accept_override or _accept_for(headers.get("sec-websocket-key", ""))
        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n"
            "\r\n"
        )
        try:
            sock.sendall(response.encode("ascii"))
        except OSError:
            _drop(sock, reader)
            return
        with self._lock:
            self._links.append(_ClientLink(sock, reader, request_line, headers))


def _drop(sock: socket.socket, reader: BufferedIOBase) -> None:
    with suppress(OSError):
        reader.close()
    with suppress(OSError):
        sock.close()


# -- harness ----------------------------------------------------------------


class _Harness:
    """Owns every socket a test opens; clients stop before servers close."""

    def __init__(self) -> None:
        self._servers: list[_FakeAServer] = []
        self._clients: list[PerceptionEventClient] = []

    def server(self, **kwargs: Any) -> _FakeAServer:
        fake = _FakeAServer(**kwargs)
        self._servers.append(fake)
        return fake

    def client(
        self,
        server: _FakeAServer,
        on_event: Callable[[RuntimeEvent], None],
        *,
        session_id: str = _SESSION_ID,
        url: str | None = None,
    ) -> PerceptionEventClient:
        client = PerceptionEventClient(
            url=server.url if url is None else url,
            session_id=session_id,
            on_event=on_event,
            connect_timeout_s=2.0,
            # Tight backoff keeps reconnect tests fast; recv_timeout is far
            # above any test's runtime so no test races the idle timer.
            initial_backoff_s=0.02,
            max_backoff_s=0.1,
            recv_timeout_s=30.0,
        )
        self._clients.append(client)
        client.start()
        return client

    def close(self) -> None:
        for client in self._clients:
            client.stop()
        for server in self._servers:
            server.close()


@pytest.fixture
def harness() -> Iterator[_Harness]:
    live = _Harness()
    try:
        yield live
    finally:
        live.close()


# -- construction -----------------------------------------------------------


def _noop(event: RuntimeEvent) -> None:
    return None


def test_invalid_configuration_is_rejected_at_construction() -> None:
    with pytest.raises(WebSocketClientError, match="scheme"):
        PerceptionEventClient(url="wss://127.0.0.1:1/ws/events", session_id="s", on_event=_noop)
    with pytest.raises(WebSocketClientError, match="host"):
        PerceptionEventClient(url="ws:///ws/events", session_id="s", on_event=_noop)
    with pytest.raises(WebSocketClientError, match="session_id"):
        PerceptionEventClient(url="ws://127.0.0.1:1/ws/events", session_id="  ", on_event=_noop)
    with pytest.raises(WebSocketClientError, match="positive"):
        PerceptionEventClient(
            url="ws://127.0.0.1:1/ws/events",
            session_id="s",
            on_event=_noop,
            connect_timeout_s=0.0,
        )


def test_stop_before_start_is_a_noop(harness: _Harness) -> None:
    server = harness.server()
    client = PerceptionEventClient(url=server.url, session_id=_SESSION_ID, on_event=_noop)

    client.stop()
    client.stop()

    assert client.connected is False
    _stays_false(lambda: server.attempts > 0, "a connection from a never-started client")


# -- handshake --------------------------------------------------------------


def test_handshake_carries_the_session_and_delivers_an_event(harness: _Harness) -> None:
    server = harness.server()
    received: list[RuntimeEvent] = []
    client = harness.client(server, received.append)

    link = server.wait_for_link()

    assert link.request_line == f"GET /ws/events?session_id={_SESSION_ID} HTTP/1.1"
    assert link.headers["host"] == f"127.0.0.1:{server.port}"
    assert link.headers["upgrade"].lower() == "websocket"
    assert "upgrade" in link.headers["connection"].lower()
    assert link.headers["sec-websocket-version"] == "13"
    assert len(base64.b64decode(link.headers["sec-websocket-key"], validate=True)) == 16
    _wait_until(lambda: client.connected, "the client to report connected")

    link.send_event(sequence=7)
    _wait_until(lambda: len(received) == 1, "one delivered event")

    event = received[0]
    assert isinstance(event, RuntimeEvent)
    assert event.session_id == _SESSION_ID
    assert event.sequence == 7
    assert event.event_type is RuntimeEventType.POSTURE_OBSERVATION
    assert event.payload == _sample_payload(7)
    assert event.schema_version == _EVENT_SCHEMA


def test_session_id_overrides_any_query_already_on_the_url(harness: _Harness) -> None:
    server = harness.server()
    client = harness.client(server, _noop, url=f"{server.url}?session_id=stale-session&debug=1")

    link = server.wait_for_link()

    assert "session_id=stale-session" not in link.request_line
    assert "debug=1" in link.request_line
    assert f"session_id={_SESSION_ID}" in link.request_line
    _wait_until(lambda: client.connected, "the client to report connected")


def test_non_101_response_keeps_the_client_disconnected_and_retrying(harness: _Harness) -> None:
    server = harness.server(reject_status="426 Upgrade Required")
    received: list[RuntimeEvent] = []
    client = harness.client(server, received.append)

    _wait_until(lambda: server.attempts >= 2, "a retry after the rejected handshake")

    assert client.connected is False
    assert received == []


def test_wrong_sec_websocket_accept_is_refused(harness: _Harness) -> None:
    server = harness.server(accept_override="AAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    client = harness.client(server, _noop)

    _wait_until(lambda: server.attempts >= 2, "a retry after the bad accept header")

    assert client.connected is False


# -- framing ----------------------------------------------------------------


def test_fragmented_message_is_reassembled_across_a_multibyte_split(harness: _Harness) -> None:
    server = harness.server()
    received: list[RuntimeEvent] = []
    client = harness.client(server, received.append)
    link = server.wait_for_link()
    _wait_until(lambda: client.connected, "the client to report connected")

    envelope: dict[str, Any] = {
        "schema_version": _EVENT_SCHEMA,
        "session_id": _SESSION_ID,
        "sequence": 3,
        "event_type": "transition_event",
        "payload": _sample_payload(3),
    }
    raw = json.dumps(envelope, ensure_ascii=False).encode("utf-8")
    # Split inside a multibyte character: only the reassembled message decodes.
    pivot = next(index for index, byte in enumerate(raw) if byte >= 0x80) + 1
    link.send(_OPCODE_TEXT, raw[:pivot], fin=False)
    link.send(_OPCODE_PING, b"mid")  # a control frame may interleave fragments
    link.send(_OPCODE_CONTINUATION, raw[pivot : pivot + 5], fin=False)
    link.send(_OPCODE_CONTINUATION, raw[pivot + 5 :])

    _wait_until(lambda: len(received) == 1, "the reassembled event")
    assert received[0].event_type is RuntimeEventType.TRANSITION_EVENT
    assert received[0].payload == _sample_payload(3)
    assert link.read_client_frame() == (True, _OPCODE_PONG, b"mid")


def test_server_ping_is_answered_with_a_masked_pong(harness: _Harness) -> None:
    server = harness.server()
    client = harness.client(server, _noop)
    link = server.wait_for_link()
    _wait_until(lambda: client.connected, "the client to report connected")

    link.send(_OPCODE_PING, b"beat")

    assert link.read_client_frame() == (True, _OPCODE_PONG, b"beat")
    assert client.connected is True


def test_oversized_message_is_refused_then_the_client_reconnects(harness: _Harness) -> None:
    server = harness.server()
    received: list[RuntimeEvent] = []
    client = harness.client(server, received.append)
    link = server.wait_for_link()
    _wait_until(lambda: client.connected, "the client to report connected")

    # Header only: a declared length past the cap must be refused before any
    # payload byte is buffered.
    link.send_raw(bytes([0x81, 0x7F]) + struct.pack("!Q", _MAX_MESSAGE_BYTES + 1))

    assert link.read_client_frame() == (True, _OPCODE_CLOSE, struct.pack("!H", 1009))
    second = server.wait_for_link(1)
    _wait_until(lambda: client.connected, "the client to reconnect")
    second.send_event(sequence=11)
    _wait_until(lambda: len(received) == 1, "an event on the fresh connection")
    assert received[0].sequence == 11


# -- reconnect and shutdown -------------------------------------------------


def test_client_reconnects_after_the_server_closes(harness: _Harness) -> None:
    server = harness.server()
    received: list[RuntimeEvent] = []
    client = harness.client(server, received.append)
    link = server.wait_for_link()
    _wait_until(lambda: client.connected, "the client to report connected")
    link.send_event(sequence=1)
    _wait_until(lambda: len(received) == 1, "the first event")

    link.send(_OPCODE_CLOSE, struct.pack("!H", 1000))

    assert link.read_client_frame() == (True, _OPCODE_CLOSE, struct.pack("!H", 1000))
    link.close()
    second = server.wait_for_link(1)
    _wait_until(lambda: client.connected, "the client to reconnect")
    second.send_event(sequence=2)
    _wait_until(lambda: len(received) == 2, "the event after the reconnect")
    assert [event.sequence for event in received] == [1, 2]


def test_stop_is_idempotent_interrupts_recv_and_ends_reconnecting(harness: _Harness) -> None:
    server = harness.server()
    client = harness.client(server, _noop)
    link = server.wait_for_link()
    _wait_until(lambda: client.connected, "the client to report connected")

    started = time.monotonic()
    client.stop()
    client.stop()  # idempotent
    elapsed = time.monotonic() - started

    # A recv loop that was not woken would hold stop() for the join timeout.
    assert elapsed < _TIMEOUT_S
    assert client.connected is False
    link.close()
    _stays_false(lambda: server.attempts > 1, "a reconnect attempt after stop()")


def test_stop_from_inside_the_callback_does_not_deadlock(harness: _Harness) -> None:
    server = harness.server()
    holder: dict[str, PerceptionEventClient] = {}
    stopped = threading.Event()

    def on_event(event: RuntimeEvent) -> None:
        holder["client"].stop()
        stopped.set()

    client = harness.client(server, on_event)
    holder["client"] = client
    link = server.wait_for_link()
    _wait_until(lambda: client.connected, "the client to report connected")

    link.send_event(sequence=1)

    _wait_until(stopped.is_set, "the callback-issued stop() to return")
    _wait_until(lambda: not client.connected, "the client to report disconnected")


# -- dispatch robustness ----------------------------------------------------


def test_callback_failure_does_not_kill_the_connection(harness: _Harness) -> None:
    server = harness.server()
    received: list[RuntimeEvent] = []

    def on_event(event: RuntimeEvent) -> None:
        received.append(event)
        if event.sequence == 1:
            raise RuntimeError("consumer blew up")

    client = harness.client(server, on_event)
    link = server.wait_for_link()
    _wait_until(lambda: client.connected, "the client to report connected")

    link.send_event(sequence=1)
    link.send_event(sequence=2)

    _wait_until(lambda: len(received) == 2, "consumption to continue past the failure")
    assert [event.sequence for event in received] == [1, 2]
    assert client.connected is True
    assert server.link_count() == 1, "the connection must survive a bad callback"


def test_malformed_and_foreign_events_are_dropped_without_disconnecting(
    harness: _Harness,
) -> None:
    server = harness.server()
    received: list[RuntimeEvent] = []
    client = harness.client(server, received.append)
    link = server.wait_for_link()
    _wait_until(lambda: client.connected, "the client to report connected")

    link.send(_OPCODE_TEXT, b"{not json")
    link.send(_OPCODE_TEXT, json.dumps({"event_type": "nope"}).encode("utf-8"))
    link.send(_OPCODE_TEXT, json.dumps({"session_id": _SESSION_ID}).encode("utf-8"))
    link.send_event(sequence=4, session_id="sess-other-002")
    link.send_event(sequence=5)

    _wait_until(lambda: len(received) == 1, "only the well-formed in-session event")
    assert received[0].sequence == 5
    assert client.connected is True
    assert server.link_count() == 1


# -- end to end against A's own server --------------------------------------


class _TickingWorker:
    """A PerceptionWorker that publishes posture events until the session stops."""

    def __init__(self, *, interval_s: float = 0.02) -> None:
        self._interval_s = interval_s

    def run(
        self,
        request: RuntimeSessionRequest,
        *,
        publish: Callable[[RuntimeEvent], None],
        mark_running: Callable[[], None],
        is_active: Callable[[], bool],
    ) -> None:
        mark_running()
        sequence = 0
        while is_active():
            publish(
                RuntimeEvent(
                    session_id=request.session_id,
                    sequence=sequence,
                    event_type=RuntimeEventType.POSTURE_OBSERVATION,
                    payload=_sample_payload(sequence),
                )
            )
            sequence += 1
            time.sleep(self._interval_s)


def test_client_consumes_events_from_the_real_runtime_server() -> None:
    """The link this lane exists to close, end to end against A's own handler."""

    session_id = "sess-real-001"
    controller = RuntimePerceptionController(worker=_TickingWorker())
    server = ThreadingHTTPServer(("127.0.0.1", 0), build_runtime_handler(controller))
    port = int(server.server_address[1])
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    received: list[RuntimeEvent] = []
    client = PerceptionEventClient(
        url=f"ws://127.0.0.1:{port}/ws/events",
        session_id=session_id,
        on_event=received.append,
        connect_timeout_s=2.0,
        initial_backoff_s=0.02,
        max_backoff_s=0.1,
    )
    try:
        controller.start(
            RuntimeSessionRequest(
                session_id=session_id,
                profile=ModeProfile.LIVE_CAMERA,
                scene_id="living-room",
                camera_id="0",
            )
        )
        client.start()
        _wait_until(lambda: len(received) >= 3, "events from A's real runtime server")
    finally:
        client.stop()
        controller.shutdown()
        server.shutdown()
        server.server_close()

    sequences = [event.sequence for event in received]
    assert sequences == sorted(sequences)
    assert len(set(sequences)) == len(sequences)
    for event in received:
        assert event.session_id == session_id
        assert event.event_type is RuntimeEventType.POSTURE_OBSERVATION
        assert event.schema_version == _EVENT_SCHEMA
        assert event.payload["scene_id"] == "living-room"
