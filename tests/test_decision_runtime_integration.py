"""End-to-end runtime integration: real registry + hub + ingest over HTTP and WS."""

from __future__ import annotations

import contextlib
import http.client
import json
import os
import socket
import struct
import threading
from http.server import ThreadingHTTPServer
from typing import Any

from reme.decision.policy import DecisionService, PolicyConfig
from reme.decision.records import (
    CareDecision,
    DecisionAction,
    DecisionSource,
    DecisionState,
    DemoMode,
    PrivacyMode,
    Uncertainty,
)
from reme.decision.runtime_glue import (
    RuntimeDecisionPublisher,
    live_streams_resolver,
    spawn_post_ingest_evaluation,
)
from reme.decision.server import build_decision_handler
from reme.decision.session import RuntimeSessionRegistry, parse_session_request
from reme.decision.stream import EventIngest
from reme.decision.websocket import DecisionEventHub

SCENE_ID = "live-camera-001"
SESSION_ID = "session-live-001"


def _build_runtime_server() -> tuple[ThreadingHTTPServer, threading.Thread, DecisionEventHub]:
    registry = RuntimeSessionRegistry()
    hub = DecisionEventHub()
    ingest = EventIngest()
    service = DecisionService(
        scenes={},
        config=PolicyConfig(),
        publisher=RuntimeDecisionPublisher(registry=registry, hub=hub),
        live_streams=live_streams_resolver(registry, ingest),
    )
    handler = build_decision_handler(
        service=service, static_dir=None, registry=registry, hub=hub, ingest=ingest
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, hub


def _stop(server: ThreadingHTTPServer, thread: threading.Thread, hub: DecisionEventHub) -> None:
    hub.close_all()
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def _post(port: int, path: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(
            "POST",
            path,
            body=json.dumps(payload, ensure_ascii=False),
            headers={"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        body = json.loads(response.read().decode("utf-8"))
        assert isinstance(body, dict)
        return response.status, body
    finally:
        connection.close()


def _session_request_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema_version": "reme-runtime-session-request/v0-experiment",
        "session_id": SESSION_ID,
        "profile": "live_camera",
        "scene_id": SCENE_ID,
        "camera_id": "default",
        "manifest_path": None,
    }
    payload.update(overrides)
    return payload


def _posture_envelope(
    *,
    sequence: int,
    timestamp_ms: float,
    posture: str = "sitting",
    duration_ms: float = 35000.0,
    session_id: str = SESSION_ID,
) -> dict[str, Any]:
    return {
        "schema_version": "reme-runtime-event/v0-experiment",
        "session_id": session_id,
        "sequence": sequence,
        "event_type": "posture_observation",
        "payload": {
            "schema_version": "reme-posture/v0-experiment",
            "scene_id": SCENE_ID,
            "timestamp_ms": timestamp_ms,
            "person_detected": True,
            "posture": posture,
            "posture_confidence": 0.9,
            "posture_duration_ms": duration_ms,
            "motion_level": "still",
            "landmark_quality": "usable",
        },
    }


class _WsClient:
    """Just enough RFC 6455 client to receive server text frames."""

    def __init__(self, port: int) -> None:
        self._sock = socket.create_connection(("127.0.0.1", port), timeout=8)
        key = "dGhlIHNhbXBsZSBub25jZQ=="
        upgrade = (
            "GET /ws HTTP/1.1\r\n"
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
        assert b"101" in head.split(b"\r\n", 1)[0]

    def _read_exact(self, size: int) -> bytes:
        while len(self._buffer) < size:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise AssertionError("websocket stream ended early")
            self._buffer += chunk
        data, self._buffer = self._buffer[:size], self._buffer[size:]
        return data

    def recv_json(self) -> dict[str, Any]:
        header = self._read_exact(2)
        opcode = header[0] & 0x0F
        length = header[1] & 0x7F
        if length == 126:
            (length,) = struct.unpack("!H", self._read_exact(2))
        elif length == 127:
            (length,) = struct.unpack("!Q", self._read_exact(8))
        payload = self._read_exact(length)
        assert opcode == 0x1, f"expected a text frame, got opcode {opcode}"
        body = json.loads(payload.decode("utf-8"))
        assert isinstance(body, dict)
        return body

    def close(self) -> None:
        # A masked close frame, then drop the socket.
        frame = bytearray([0x88, 0x80]) + b"\x00\x00\x00\x00"
        with contextlib.suppress(OSError):
            self._sock.sendall(bytes(frame))
        self._sock.close()


def test_live_session_streams_decisions_over_websocket() -> None:
    os.environ["REME_DEMO_QUIET"] = "1"
    server, thread, hub = _build_runtime_server()
    try:
        port = server.server_address[1]
        status, body = _post(port, "/api/session", _session_request_payload())
        assert status == 200
        assert body["state"] == "running"
        assert body["component"] == "decision"

        client = _WsClient(port)
        try:
            status, body = _post(
                port, "/api/events", _posture_envelope(sequence=1, timestamp_ms=41000.0)
            )
            assert status == 200
            assert body == {"accepted": "posture_observation"}

            envelope = client.recv_json()
            assert envelope["schema_version"] == "reme-runtime-event/v0-experiment"
            assert envelope["session_id"] == SESSION_ID
            assert envelope["event_type"] == "care_decision"
            assert envelope["sequence"] == 1
            decision = envelope["payload"]
            assert decision["scene_id"] == SCENE_ID
            assert decision["state"] == "check_in_required"
            assert decision["source"] == "rule"

            polled_status, polled = _post(
                port, "/api/decision", {"scene_id": SCENE_ID, "timestamp_ms": 42000.0}
            )
            assert polled_status == 200
            assert polled["decision_id"] == decision["decision_id"]
        finally:
            client.close()

        status, body = _post(port, "/api/session/stop", {"session_id": SESSION_ID})
        assert status == 200
        assert body["state"] == "stopped"
    finally:
        _stop(server, thread, hub)


def test_late_ws_joiner_receives_the_current_decision_as_a_snapshot() -> None:
    # P1 regression: the alarm-bearing decision fired before the family
    # viewer connected (or while it was inside its reconnect window) and was
    # gone forever — /ws replayed nothing and terminal states get no
    # follow-up broadcast. A new connection must now receive the current
    # episode's latest decision envelope on accept.
    os.environ["REME_DEMO_QUIET"] = "1"
    server, thread, hub = _build_runtime_server()
    try:
        port = server.server_address[1]
        _post(port, "/api/session", _session_request_payload())

        live = _WsClient(port)
        try:
            _post(port, "/api/events", _posture_envelope(sequence=1, timestamp_ms=41000.0))
            broadcast = live.recv_json()
            assert broadcast["event_type"] == "care_decision"
        finally:
            live.close()

        late = _WsClient(port)
        try:
            snapshot = late.recv_json()
        finally:
            late.close()
        # Byte-identical replay (same decision_id, same sequence): a viewer
        # that DID see the live broadcast dedups the snapshot by decision_id,
        # so reconnects inside the retry window converge instead of doubling.
        assert snapshot == broadcast
    finally:
        _stop(server, thread, hub)


def test_ws_joiner_before_any_decision_gets_no_snapshot_frame() -> None:
    os.environ["REME_DEMO_QUIET"] = "1"
    server, thread, hub = _build_runtime_server()
    try:
        port = server.server_address[1]
        _post(port, "/api/session", _session_request_payload())

        client = _WsClient(port)
        try:
            # No decision exists yet, so nothing may be replayed: the first
            # frame on the wire must be the live decision itself (sequence 1).
            _post(port, "/api/events", _posture_envelope(sequence=1, timestamp_ms=41000.0))
            first = client.recv_json()
            assert first["event_type"] == "care_decision"
            assert first["sequence"] == 1
        finally:
            client.close()
    finally:
        _stop(server, thread, hub)


def test_snapshot_from_a_stopped_session_is_not_replayed_into_the_next() -> None:
    os.environ["REME_DEMO_QUIET"] = "1"
    server, thread, hub = _build_runtime_server()
    try:
        port = server.server_address[1]
        _post(port, "/api/session", _session_request_payload())
        witness = _WsClient(port)
        try:
            _post(port, "/api/events", _posture_envelope(sequence=1, timestamp_ms=41000.0))
            old_decision = witness.recv_json()
            assert old_decision["session_id"] == SESSION_ID
        finally:
            witness.close()
        _post(port, "/api/session/stop", {"session_id": SESSION_ID})

        next_session = "session-live-002"
        _post(port, "/api/session", _session_request_payload(session_id=next_session))
        client = _WsClient(port)
        try:
            # The stale envelope still sits in the publisher, but it belongs
            # to the stopped session: the joiner's first frame must be the new
            # session's own decision, not a cross-session replay.
            _post(
                port,
                "/api/events",
                _posture_envelope(sequence=1, timestamp_ms=41000.0, session_id=next_session),
            )
            first = client.recv_json()
            assert first["session_id"] == next_session
            assert first["sequence"] == 1
            assert first["payload"]["decision_id"] != old_decision["payload"]["decision_id"]
        finally:
            client.close()
    finally:
        _stop(server, thread, hub)


def _care_decision() -> CareDecision:
    return CareDecision(
        scene_id=SCENE_ID,
        decision_id="decision-0007",
        timestamp_ms=12800.0,
        state=DecisionState.CHECK_IN_REQUIRED,
        risk_level=2,
        privacy_mode=PrivacyMode.SKELETON_ONLY,
        need_dialogue=True,
        dialogue_goal="confirm_safety",
        elder_message="您还好吗？",
        family_notification=None,
        action=DecisionAction.ASK_ELDER,
        reason_summary="测试用决策。",
        uncertainty=Uncertainty.MEDIUM,
        fallback_used=False,
        source=DecisionSource.RULE,
        demo_mode=DemoMode.LIVE,
        response_timeout_ms=8000,
    )


def test_publisher_stores_the_snapshot_before_broadcasting() -> None:
    # White-box ordering guard (Codex review): the replay proof depends on
    # store-then-broadcast — with the order flipped, a joiner registering
    # between the two misses the frame forever, and no black-box schedule
    # catches that deterministically.
    registry = RuntimeSessionRegistry()
    registry.start(parse_session_request(_session_request_payload()))
    hub = DecisionEventHub()
    publisher = RuntimeDecisionPublisher(registry=registry, hub=hub)
    stored_at_broadcast: list[dict[str, Any] | None] = []

    def spying_broadcast(payload: dict[str, Any]) -> int:
        stored_at_broadcast.append(publisher.latest_decision_event())
        return 0

    hub.broadcast_json = spying_broadcast  # type: ignore[method-assign]
    publisher.publish_decision(_care_decision())

    assert len(stored_at_broadcast) == 1
    stored = stored_at_broadcast[0]
    assert stored is not None, "the snapshot must already be stored when the broadcast starts"
    assert stored["event_type"] == "care_decision"
    assert stored["payload"]["decision_id"] == "decision-0007"


def test_stale_session_event_is_rejected_end_to_end() -> None:
    os.environ["REME_DEMO_QUIET"] = "1"
    server, thread, hub = _build_runtime_server()
    try:
        port = server.server_address[1]
        status, _ = _post(port, "/api/events", _posture_envelope(sequence=1, timestamp_ms=1.0))
        assert status == 409  # no active session yet

        _post(port, "/api/session", _session_request_payload())
        status, body = _post(
            port,
            "/api/events",
            _posture_envelope(sequence=2, timestamp_ms=2.0, session_id="session-old-999"),
        )
        assert status == 409
        assert body["error"]["code"] == "stale_session"
    finally:
        _stop(server, thread, hub)


def test_post_ingest_evaluation_survives_service_errors() -> None:
    from reme.pose.runtime import RuntimeEvent, RuntimeEventType

    # Without a live resolver the scene is unknown; the background hook must
    # swallow the resulting error instead of crashing its thread.
    service = DecisionService(scenes={}, config=PolicyConfig())
    event = RuntimeEvent(
        session_id=SESSION_ID,
        sequence=1,
        event_type=RuntimeEventType.POSTURE_OBSERVATION,
        payload=_posture_envelope(sequence=1, timestamp_ms=1000.0)["payload"],
    )
    thread = threading.Thread(
        target=spawn_post_ingest_evaluation, args=(service, event), daemon=True
    )
    thread.start()
    thread.join(timeout=5)
    assert not thread.is_alive()
