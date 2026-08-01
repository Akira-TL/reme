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
from typing import Any

import pytest
from reme.decision.config import ServerConfig
from reme.decision.context import load_scene_streams
from reme.decision.policy import DecisionService, PolicyConfig
from reme.decision.records import parse_care_decision
from reme.decision.server import build_decision_handler, build_server


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
