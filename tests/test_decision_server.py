"""HTTP surface tests for the decision server (port 0 + daemon threads)."""

from __future__ import annotations

import http.client
import json
import shutil
import ssl
import subprocess
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any, cast

import pytest
from reme.decision.config import ServerConfig
from reme.decision.context import load_scene_streams
from reme.decision.policy import DecisionService, PolicyConfig
from reme.decision.records import parse_care_decision
from reme.decision.server import build_decision_handler, build_server
from reme.decision.session import RuntimeSessionRegistry, SessionRegistryError
from reme.decision.stream import EventIngest, IngestError
from reme.decision.websocket import DecisionEventHub
from reme.pose.runtime import (
    Component,
    ModeProfile,
    RuntimeEvent,
    RuntimeEventType,
    RuntimeSessionRequest,
    RuntimeSessionState,
    RuntimeSessionStatus,
)


def _posture_record(**overrides: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "schema_version": "reme-posture/v0-experiment",
        "scene_id": "fall_demo_01",
        "timestamp_ms": 12800.0,
        "person_detected": True,
        "posture": "lying",
        "posture_confidence": 0.9,
        "posture_duration_ms": 2000.0,
        "motion_level": "still",
        "landmark_quality": "usable",
    }
    record.update(overrides)
    return record


def _transition_record() -> dict[str, Any]:
    return {
        "schema_version": "reme-transition/v0-experiment",
        "scene_id": "fall_demo_01",
        "event_id": "transition-0001",
        "start_ms": 11100.0,
        "end_ms": 12700.0,
        "transition": "fall_like_transition",
        "transition_confidence": 0.85,
        "evidence": {},
        "landmark_quality": "usable",
    }


def _write_fall_bundle(tmp_path: Path) -> Path:
    bundle_dir = tmp_path / "fall_demo_01"
    (bundle_dir / "media").mkdir(parents=True)
    (bundle_dir / "media" / "source.mp4").write_bytes(b"0123456789abcdef")
    manifest: dict[str, Any] = {
        "schema_version": "reme-scene/v0-experiment",
        "scene_id": "fall_demo_01",
        "title": "fall",
        "media": {
            "local_path": "media/source.mp4",
            "sha256": "0" * 64,
            "width": 1280,
            "height": 720,
            "fps": 30.0,
            "frame_count": 2370,
            "duration_ms": 79000,
        },
        "streams": {
            "keypoints_2d": "keypoints_2d.jsonl",
            "keypoints_3d": None,
            "posture_observations": "posture_observations.jsonl",
            "transition_events": "transition_events.jsonl",
            "recorded_decisions": None,
        },
    }
    (bundle_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
    )
    (bundle_dir / "posture_observations.jsonl").write_text(
        json.dumps(_posture_record(), ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (bundle_dir / "transition_events.jsonl").write_text(
        json.dumps(_transition_record(), ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return bundle_dir / "manifest.json"


def _service(tmp_path: Path) -> DecisionService:
    manifest_path = _write_fall_bundle(tmp_path)
    return DecisionService(
        scenes={"fall_demo_01": load_scene_streams(manifest_path)}, config=PolicyConfig()
    )


def _start_server(service: DecisionService) -> tuple[ThreadingHTTPServer, threading.Thread]:
    handler = build_decision_handler(service=service, static_dir=None)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _stop_server(server: ThreadingHTTPServer, thread: threading.Thread) -> None:
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


def test_health_reports_loaded_scene_streams(tmp_path: Path) -> None:
    server, thread = _start_server(_service(tmp_path))
    try:
        connection = http.client.HTTPConnection(
            "127.0.0.1", server.server_address[1], timeout=5
        )
        connection.request("GET", "/api/health")
        response = connection.getresponse()
        body = json.loads(response.read().decode("utf-8"))
        assert response.status == 200
        assert body["scenes"]["fall_demo_01"] == {"postures": 1, "transitions": 1}
        connection.close()
    finally:
        _stop_server(server, thread)


def test_decision_endpoint_returns_contract_payload(tmp_path: Path) -> None:
    server, thread = _start_server(_service(tmp_path))
    try:
        status, body = _post(
            server.server_address[1],
            "/api/decision",
            {"scene_id": "fall_demo_01", "timestamp_ms": 13000.0},
        )
        assert status == 200
        decision = parse_care_decision(body)
        assert decision.state.value == "check_in_required"
        assert decision.response_timeout_ms == 8000
    finally:
        _stop_server(server, thread)


def test_response_endpoint_advances_state_machine(tmp_path: Path) -> None:
    server, thread = _start_server(_service(tmp_path))
    try:
        port = server.server_address[1]
        _, first = _post(
            port, "/api/decision", {"scene_id": "fall_demo_01", "timestamp_ms": 13000.0}
        )
        status, second = _post(
            port,
            "/api/response",
            {
                "schema_version": "reme-interaction-response/v0-experiment",
                "scene_id": "fall_demo_01",
                "decision_id": first["decision_id"],
                "timestamp_ms": 21000.0,
                "response": "none",
                "source": "timeout",
                "demo_mode": "live",
                "text": None,
            },
        )
        assert status == 200
        assert second["state"] == "family_notification_required"
        assert second["source"] == "rule"
    finally:
        _stop_server(server, thread)


def test_mismatched_decision_id_returns_conflict(tmp_path: Path) -> None:
    server, thread = _start_server(_service(tmp_path))
    try:
        port = server.server_address[1]
        _post(port, "/api/decision", {"scene_id": "fall_demo_01", "timestamp_ms": 13000.0})
        status, body = _post(
            port,
            "/api/response",
            {
                "schema_version": "reme-interaction-response/v0-experiment",
                "scene_id": "fall_demo_01",
                "decision_id": "decision-9999",
                "timestamp_ms": 21000.0,
                "response": "safe",
                "source": "user_input",
                "demo_mode": "live",
                "text": None,
            },
        )
        assert status == 409
        assert body["error"]["code"] == "stale_decision"
    finally:
        _stop_server(server, thread)


def test_illegal_enum_returns_structured_422(tmp_path: Path) -> None:
    server, thread = _start_server(_service(tmp_path))
    try:
        status, body = _post(
            server.server_address[1],
            "/api/response",
            {
                "schema_version": "reme-interaction-response/v0-experiment",
                "scene_id": "fall_demo_01",
                "decision_id": "decision-0001",
                "timestamp_ms": 21000.0,
                "response": "panic",
                "source": "user_input",
                "demo_mode": "live",
                "text": None,
            },
        )
        assert status == 422
        assert body["error"]["code"] == "contract_violation"
    finally:
        _stop_server(server, thread)


def test_unknown_scene_returns_404(tmp_path: Path) -> None:
    server, thread = _start_server(_service(tmp_path))
    try:
        status, body = _post(
            server.server_address[1],
            "/api/decision",
            {"scene_id": "ghost", "timestamp_ms": 1.0},
        )
        assert status == 404
        assert body["error"]["code"] == "unknown_scene"
    finally:
        _stop_server(server, thread)


def test_scene_media_supports_byte_ranges(tmp_path: Path) -> None:
    server, thread = _start_server(_service(tmp_path))
    try:
        connection = http.client.HTTPConnection(
            "127.0.0.1", server.server_address[1], timeout=5
        )
        connection.request(
            "GET",
            "/scenes/fall_demo_01/media/source.mp4",
            headers={"Range": "bytes=4-7"},
        )
        response = connection.getresponse()
        payload = response.read()
        assert response.status == 206
        assert payload == b"4567"
        assert response.headers["Content-Range"] == "bytes 4-7/16"
        connection.close()
    finally:
        _stop_server(server, thread)


def test_scene_reset_endpoint_restarts_episode(tmp_path: Path) -> None:
    server, thread = _start_server(_service(tmp_path))
    try:
        port = server.server_address[1]
        _, first = _post(
            port, "/api/decision", {"scene_id": "fall_demo_01", "timestamp_ms": 13000.0}
        )
        status, _ = _post(port, "/api/scene/reset", {"scene_id": "fall_demo_01"})
        assert status == 200
        _, again = _post(
            port, "/api/decision", {"scene_id": "fall_demo_01", "timestamp_ms": 13000.0}
        )
        assert again["decision_id"] != first["decision_id"]
    finally:
        _stop_server(server, thread)


def test_options_preflight_allows_dev_cors(tmp_path: Path) -> None:
    server, thread = _start_server(_service(tmp_path))
    try:
        connection = http.client.HTTPConnection(
            "127.0.0.1", server.server_address[1], timeout=5
        )
        connection.request("OPTIONS", "/api/decision")
        response = connection.getresponse()
        response.read()
        assert response.status == 204
        assert response.headers["Access-Control-Allow-Origin"] == "*"
        connection.close()
    finally:
        _stop_server(server, thread)


def test_tls_server_serves_with_generated_certificate(tmp_path: Path) -> None:
    if shutil.which("openssl") is None:
        pytest.skip("openssl is not available")
    certfile = tmp_path / "cert.pem"
    keyfile = tmp_path / "key.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-keyout",
            str(keyfile),
            "-out",
            str(certfile),
            "-days",
            "1",
            "-nodes",
            "-subj",
            "/CN=127.0.0.1",
        ],
        check=True,
        capture_output=True,
    )
    service = _service(tmp_path)
    config = ServerConfig(
        scenes_dir=tmp_path, host="127.0.0.1", port=0, certfile=certfile, keyfile=keyfile
    )
    handler = build_decision_handler(service=service, static_dir=None)
    server = build_server(config, handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        connection = http.client.HTTPSConnection(
            "127.0.0.1", server.server_address[1], timeout=5, context=context
        )
        connection.request("GET", "/api/health")
        response = connection.getresponse()
        assert response.status == 200
        response.read()
        connection.close()
    finally:
        _stop_server(server, thread)


# ---------------------------------------------------------------------------
# Runtime routing (lane L3). Every collaborator below is a fake: session,
# websocket and stream are still skeletons in this worktree, so these tests
# pin the server's contract with them, not their behaviour.
# ---------------------------------------------------------------------------


_WS_HEADERS = {
    "Upgrade": "websocket",
    "Connection": "Upgrade",
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version": "13",
}


def _running_status(session_id: str = "session-0001") -> RuntimeSessionStatus:
    return RuntimeSessionStatus(
        session_id=session_id,
        component=Component.DECISION,
        requested_profile=ModeProfile.RECORDED_VIDEO,
        effective_profile=ModeProfile.RECORDED_VIDEO,
        state=RuntimeSessionState.RUNNING,
    )


def _stopped_status(session_id: str = "session-0001") -> RuntimeSessionStatus:
    return RuntimeSessionStatus(
        session_id=session_id,
        component=Component.DECISION,
        requested_profile=ModeProfile.RECORDED_VIDEO,
        effective_profile=None,
        state=RuntimeSessionState.STOPPED,
    )


def _session_body(session_id: str = "session-0001") -> dict[str, Any]:
    return {
        "schema_version": "reme-runtime-session-request/v0-experiment",
        "session_id": session_id,
        "profile": "recorded_video",
        "scene_id": "fall_demo_01",
        "manifest_path": "scenes/fall_demo_01/manifest.json",
    }


class _FakeRegistry:
    """Records control calls; programmable to raise SessionRegistryError."""

    def __init__(
        self,
        calls: list[str],
        *,
        start_error: SessionRegistryError | None = None,
        status: RuntimeSessionStatus | None = None,
        active_session_id: str | None = "session-0001",
    ) -> None:
        self.calls = calls
        self.started: list[RuntimeSessionRequest] = []
        self.stopped: list[str] = []
        self._start_error = start_error
        self._status = status
        self._active_session_id = active_session_id

    def start(self, request: RuntimeSessionRequest) -> RuntimeSessionStatus:
        self.calls.append("registry.start")
        self.started.append(request)
        if self._start_error is not None:
            raise self._start_error
        return _running_status(request.session_id)

    def stop(self, session_id: str) -> RuntimeSessionStatus:
        self.calls.append("registry.stop")
        self.stopped.append(session_id)
        return _stopped_status(session_id)

    def current_status(self) -> RuntimeSessionStatus | None:
        self.calls.append("registry.current_status")
        return self._status

    def active_session_id(self) -> str | None:
        self.calls.append("registry.active_session_id")
        return self._active_session_id


class _FakeHub:
    """Records broadcasts and asserts the socket handover precondition."""

    def __init__(self, calls: list[str]) -> None:
        self.calls = calls
        self.broadcasts: list[dict[str, Any]] = []
        self.accepted: list[Any] = []
        self.close_connection_at_accept: bool | None = None
        self.accept_done = threading.Event()

    def accept(self, handler: Any) -> None:
        self.calls.append("hub.accept")
        # The server must disable keep-alive BEFORE handing the socket over,
        # otherwise BaseHTTPRequestHandler would read another request off a
        # connection the hub now owns. Recorded as well as asserted: this runs
        # on the server thread, where a bare assert would be invisible.
        self.close_connection_at_accept = handler.close_connection
        assert handler.close_connection is True
        self.accepted.append(handler)
        self.accept_done.set()

    def broadcast_json(self, payload: dict[str, Any]) -> int:
        self.calls.append("hub.broadcast_json")
        self.broadcasts.append(payload)
        return len(self.accepted)

    def close_all(self) -> None:
        self.calls.append("hub.close_all")


class _FakeIngest:
    """Records submissions and resets; programmable to raise IngestError."""

    def __init__(self, calls: list[str], *, submit_error: IngestError | None = None) -> None:
        self.calls = calls
        self.submitted: list[tuple[object, str | None]] = []
        self.reset_all_count = 0
        self._submit_error = submit_error

    def submit(self, payload: object, *, active_session_id: str | None) -> RuntimeEvent:
        self.calls.append("ingest.submit")
        self.submitted.append((payload, active_session_id))
        if self._submit_error is not None:
            raise self._submit_error
        return RuntimeEvent(
            session_id=active_session_id or "session-0001",
            sequence=0,
            event_type=RuntimeEventType.POSTURE_OBSERVATION,
            payload={},
        )

    def reset_all(self) -> None:
        self.calls.append("ingest.reset_all")
        self.reset_all_count += 1


def _start_runtime_server(
    service: DecisionService,
    *,
    registry: object | None = None,
    hub: object | None = None,
    ingest: object | None = None,
) -> tuple[ThreadingHTTPServer, threading.Thread]:
    """_start_server's shape plus the three optional runtime collaborators."""

    handler = build_decision_handler(
        service=service,
        static_dir=None,
        registry=cast("RuntimeSessionRegistry | None", registry),
        hub=cast("DecisionEventHub | None", hub),
        ingest=cast("EventIngest | None", ingest),
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _get(
    port: int, path: str, headers: dict[str, str] | None = None
) -> tuple[int, dict[str, Any]]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request("GET", path, headers=headers or {})
        response = connection.getresponse()
        body = json.loads(response.read().decode("utf-8"))
        assert isinstance(body, dict)
        return response.status, body
    finally:
        connection.close()


def _ws_get(port: int, headers: dict[str, str]) -> int | None:
    """GET /ws, returning None when the server sent no HTTP response at all."""

    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request("GET", "/ws", headers=headers)
        try:
            response = connection.getresponse()
        except http.client.HTTPException:
            return None
        response.read()
        return response.status
    finally:
        connection.close()


def test_session_start_returns_status_and_resets_runtime_state(tmp_path: Path) -> None:
    calls: list[str] = []
    registry = _FakeRegistry(calls)
    hub = _FakeHub(calls)
    ingest = _FakeIngest(calls)
    server, thread = _start_runtime_server(
        _service(tmp_path), registry=registry, hub=hub, ingest=ingest
    )
    try:
        status, body = _post(server.server_address[1], "/api/session", _session_body())
        assert status == 200
        assert body == _running_status().to_payload()
        assert body["component"] == "decision"
        # Buffers must be dropped before the new status reaches C.
        assert calls == ["registry.start", "ingest.reset_all", "hub.broadcast_json"]
        assert hub.broadcasts == [body]
        assert registry.started[0].session_id == "session-0001"
        assert registry.started[0].profile is ModeProfile.RECORDED_VIDEO
    finally:
        _stop_server(server, thread)


def test_session_start_conflict_returns_409(tmp_path: Path) -> None:
    calls: list[str] = []
    registry = _FakeRegistry(
        calls, start_error=SessionRegistryError("session_conflict", "session already running")
    )
    hub = _FakeHub(calls)
    ingest = _FakeIngest(calls)
    server, thread = _start_runtime_server(
        _service(tmp_path), registry=registry, hub=hub, ingest=ingest
    )
    try:
        status, body = _post(server.server_address[1], "/api/session", _session_body())
        assert status == 409
        assert body["error"]["code"] == "session_conflict"
        # A rejected start must not touch buffers or notify anybody.
        assert calls == ["registry.start"]
        assert ingest.reset_all_count == 0
        assert hub.broadcasts == []
    finally:
        _stop_server(server, thread)


def test_session_start_rejects_malformed_body_with_400(tmp_path: Path) -> None:
    calls: list[str] = []
    registry = _FakeRegistry(calls)
    server, thread = _start_runtime_server(_service(tmp_path), registry=registry)
    try:
        malformed = _session_body()
        malformed["profile"] = "teleport"
        status, body = _post(server.server_address[1], "/api/session", malformed)
        assert status == 400
        assert body["error"]["code"] == "bad_request"
        assert calls == []
    finally:
        _stop_server(server, thread)


def test_session_stop_is_idempotent_and_broadcasts_status(tmp_path: Path) -> None:
    calls: list[str] = []
    registry = _FakeRegistry(calls)
    hub = _FakeHub(calls)
    ingest = _FakeIngest(calls)
    server, thread = _start_runtime_server(
        _service(tmp_path), registry=registry, hub=hub, ingest=ingest
    )
    try:
        port = server.server_address[1]
        first_status, first = _post(port, "/api/session/stop", {"session_id": "session-0001"})
        second_status, second = _post(port, "/api/session/stop", {"session_id": "session-0001"})
        assert (first_status, second_status) == (200, 200)
        assert first == second == _stopped_status().to_payload()
        assert first["state"] == "stopped"
        assert registry.stopped == ["session-0001", "session-0001"]
        assert ingest.reset_all_count == 2
        assert hub.broadcasts == [first, second]
    finally:
        _stop_server(server, thread)


def test_session_status_returns_current_status(tmp_path: Path) -> None:
    calls: list[str] = []
    registry = _FakeRegistry(calls, status=_running_status())
    server, thread = _start_runtime_server(_service(tmp_path), registry=registry)
    try:
        status, body = _get(server.server_address[1], "/api/session/status")
        assert status == 200
        assert body == _running_status().to_payload()
    finally:
        _stop_server(server, thread)


def test_session_status_without_session_returns_404(tmp_path: Path) -> None:
    calls: list[str] = []
    registry = _FakeRegistry(calls, status=None)
    server, thread = _start_runtime_server(_service(tmp_path), registry=registry)
    try:
        status, body = _get(server.server_address[1], "/api/session/status")
        assert status == 404
        assert body["error"]["code"] == "no_session"
    finally:
        _stop_server(server, thread)


def test_events_endpoint_accepts_runtime_event(tmp_path: Path) -> None:
    calls: list[str] = []
    registry = _FakeRegistry(calls, active_session_id="session-0042")
    ingest = _FakeIngest(calls)
    server, thread = _start_runtime_server(_service(tmp_path), registry=registry, ingest=ingest)
    try:
        envelope: dict[str, Any] = {
            "schema_version": "reme-runtime-event/v0-experiment",
            "session_id": "session-0042",
            "sequence": 7,
            "event_type": "posture_observation",
            "payload": _posture_record(),
        }
        status, body = _post(server.server_address[1], "/api/events", envelope)
        assert status == 200
        assert body == {"accepted": "posture_observation"}
        # The active session id comes from the registry, never from the body.
        assert calls == ["registry.active_session_id", "ingest.submit"]
        assert ingest.submitted == [(envelope, "session-0042")]
    finally:
        _stop_server(server, thread)


def test_events_stale_session_returns_409(tmp_path: Path) -> None:
    calls: list[str] = []
    registry = _FakeRegistry(calls)
    ingest = _FakeIngest(
        calls, submit_error=IngestError("stale_session", "event belongs to a previous session")
    )
    server, thread = _start_runtime_server(_service(tmp_path), registry=registry, ingest=ingest)
    try:
        status, body = _post(server.server_address[1], "/api/events", {"session_id": "old"})
        assert status == 409
        assert body["error"]["code"] == "stale_session"
    finally:
        _stop_server(server, thread)


def test_events_bad_event_returns_422(tmp_path: Path) -> None:
    calls: list[str] = []
    registry = _FakeRegistry(calls)
    ingest = _FakeIngest(calls, submit_error=IngestError("bad_event", "payload is not a posture"))
    server, thread = _start_runtime_server(_service(tmp_path), registry=registry, ingest=ingest)
    try:
        status, body = _post(server.server_address[1], "/api/events", {"nope": True})
        assert status == 422
        assert body["error"]["code"] == "bad_event"
    finally:
        _stop_server(server, thread)


def test_runtime_endpoints_return_503_without_dependencies(tmp_path: Path) -> None:
    # _start_server is the recorded-bundle server: no registry, hub or ingest.
    server, thread = _start_server(_service(tmp_path))
    try:
        port = server.server_address[1]
        start_status, start_body = _post(port, "/api/session", _session_body())
        stop_status, stop_body = _post(port, "/api/session/stop", {"session_id": "session-0001"})
        events_status, events_body = _post(port, "/api/events", {"session_id": "session-0001"})
        query_status, query_body = _get(port, "/api/session/status")
        assert start_status == stop_status == events_status == query_status == 503
        for body in (start_body, stop_body, events_body, query_body):
            assert body["error"]["code"] == "runtime_disabled"
    finally:
        _stop_server(server, thread)


def test_websocket_without_hub_returns_503(tmp_path: Path) -> None:
    server, thread = _start_server(_service(tmp_path))
    try:
        port = server.server_address[1]
        assert _ws_get(port, _WS_HEADERS) == 503
        status, body = _get(port, "/ws", _WS_HEADERS)
        assert status == 503
        assert body["error"]["code"] == "runtime_disabled"
    finally:
        _stop_server(server, thread)


def test_websocket_rejects_non_upgrade_request(tmp_path: Path) -> None:
    calls: list[str] = []
    hub = _FakeHub(calls)
    server, thread = _start_runtime_server(_service(tmp_path), hub=hub)
    try:
        status, body = _get(server.server_address[1], "/ws")
        assert status == 400
        assert body["error"]["code"] == "bad_upgrade"
        assert calls == []
    finally:
        _stop_server(server, thread)


def test_websocket_upgrade_hands_the_socket_to_the_hub(tmp_path: Path) -> None:
    calls: list[str] = []
    hub = _FakeHub(calls)
    server, thread = _start_runtime_server(_service(tmp_path), hub=hub)
    try:
        # The fake returns immediately, so the handler closes without ever
        # writing an HTTP response: no status line is the expected outcome.
        assert _ws_get(server.server_address[1], _WS_HEADERS) is None
        assert hub.accept_done.wait(timeout=5)
        assert calls == ["hub.accept"]
        assert hub.close_connection_at_accept is True
        assert len(hub.accepted) == 1
    finally:
        _stop_server(server, thread)
