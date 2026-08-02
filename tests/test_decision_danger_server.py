"""HTTP surface tests for the danger link's upload routes and voice assets."""

from __future__ import annotations

import base64
import http.client
import json
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any

from reme.decision.context import load_scene_streams
from reme.decision.danger import DangerConfig, DangerConfirmController
from reme.decision.guardrails import TriggerConfig
from reme.decision.mimo.adapter import MimoCallResult
from reme.decision.policy import DecisionService, PolicyConfig
from reme.decision.records import DemoMode
from reme.decision.server import build_decision_handler

JPEG_B64 = base64.b64encode(b"\xff\xd8\xff\xe0reme").decode("ascii")


def _fall_scenes(tmp_path: Path) -> dict[str, Any]:
    bundle_dir = tmp_path / "fall_demo_01"
    bundle_dir.mkdir(parents=True)
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
    (bundle_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (bundle_dir / "posture_observations.jsonl").write_text(
        json.dumps(
            {
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
        )
        + "\n",
        encoding="utf-8",
    )
    (bundle_dir / "transition_events.jsonl").write_text(
        json.dumps(
            {
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
        )
        + "\n",
        encoding="utf-8",
    )
    return {"fall_demo_01": load_scene_streams(bundle_dir / "manifest.json")}


class _FakeConfirmClient:
    def complete(
        self, *, system_prompt: str, user_content: str | list[dict[str, Any]]
    ) -> MimoCallResult:
        return MimoCallResult(
            content=json.dumps({"fallen": True, "confidence": 0.9, "reason": "躺地"}),
            latency_ms=1.0,
            attempts=1,
        )


def _start(
    tmp_path: Path, *, with_danger: bool = True, voice_dir: Path | None = None
) -> tuple[ThreadingHTTPServer, threading.Thread, DecisionService]:
    service = DecisionService(
        scenes=_fall_scenes(tmp_path),
        config=PolicyConfig(
            trigger=TriggerConfig(), demo_mode=DemoMode.LIVE, cognition_enabled=False
        ),
    )
    danger = None
    if with_danger:
        danger = DangerConfirmController(
            service=service,
            client=_FakeConfirmClient(),
            config=DangerConfig(),
            spawn=lambda work: work(),
        )
    handler = build_decision_handler(
        service=service, static_dir=None, danger=danger, voice_dir=voice_dir
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, service


def _stop(server: ThreadingHTTPServer, thread: threading.Thread) -> None:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def _post(server: ThreadingHTTPServer, path: str, payload: dict[str, Any]) -> tuple[int, Any]:
    connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
    try:
        connection.request(
            "POST",
            path,
            body=json.dumps(payload),
            headers={"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        return response.status, json.loads(response.read().decode("utf-8"))
    finally:
        connection.close()


def _get(server: ThreadingHTTPServer, path: str) -> tuple[int, bytes, str]:
    connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        return response.status, response.read(), response.headers.get("Content-Type", "")
    finally:
        connection.close()


def _open_check_in(server: ThreadingHTTPServer) -> str:
    status, payload = _post(
        server, "/api/decision", {"scene_id": "fall_demo_01", "timestamp_ms": 13000.0}
    )
    assert status == 200 and payload["state"] == "check_in_required"
    decision_id = payload["decision_id"]
    assert isinstance(decision_id, str)
    assert payload["confirm_channels"] == ["frame", "voice"]
    return decision_id


def test_danger_frame_endpoint_accepts_and_escalates(tmp_path: Path) -> None:
    server, thread, service = _start(tmp_path)
    try:
        decision_id = _open_check_in(server)
        status, payload = _post(
            server,
            "/api/danger/frame",
            {
                "scene_id": "fall_demo_01",
                "decision_id": decision_id,
                "timestamp_ms": 14000.0,
                "image_b64": JPEG_B64,
            },
        )
        assert status == 200 and payload == {"accepted": "visual_confirm"}
        status, payload = _post(
            server, "/api/decision", {"scene_id": "fall_demo_01", "timestamp_ms": 14500.0}
        )
        assert status == 200
        assert payload["state"] == "family_notification_required"
        assert payload["alarm"] == {
            "channels": ["vibrate", "ring", "flash"],
            "trigger": "visual_confirm",
        }
    finally:
        _stop(server, thread)


def test_danger_voice_text_endpoint(tmp_path: Path) -> None:
    server, thread, _service = _start(tmp_path)
    try:
        decision_id = _open_check_in(server)
        status, payload = _post(
            server,
            "/api/danger/voice",
            {
                "scene_id": "fall_demo_01",
                "decision_id": decision_id,
                "timestamp_ms": 14000.0,
                "text": "快来人啊我起不来了",
            },
        )
        assert status == 200 and payload == {"accepted": "voice_intent"}
        status, payload = _post(
            server, "/api/decision", {"scene_id": "fall_demo_01", "timestamp_ms": 14500.0}
        )
        assert payload["state"] == "family_notification_required"
        assert payload["alarm"]["trigger"] == "voice_intent"
    finally:
        _stop(server, thread)


def test_danger_endpoints_report_rejections(tmp_path: Path) -> None:
    server, thread, _service = _start(tmp_path)
    try:
        # No pending check-in yet: 409.
        status, payload = _post(
            server,
            "/api/danger/frame",
            {
                "scene_id": "fall_demo_01",
                "decision_id": "decision-0001",
                "timestamp_ms": 1000.0,
                "image_b64": JPEG_B64,
            },
        )
        assert status == 409 and payload["error"]["code"] == "no_confirm_pending"
        decision_id = _open_check_in(server)
        status, payload = _post(
            server,
            "/api/danger/voice",
            {
                "scene_id": "fall_demo_01",
                "decision_id": decision_id,
                "timestamp_ms": 14000.0,
                "audio_b64": "AAAA",
                "audio_format": "webm",
            },
        )
        assert status == 422 and payload["error"]["code"] == "bad_media"
        status, payload = _post(
            server,
            "/api/danger/frame",
            {"scene_id": "fall_demo_01", "decision_id": decision_id, "timestamp_ms": 14000.0},
        )
        assert status == 400 and payload["error"]["code"] == "bad_request"
    finally:
        _stop(server, thread)


def test_danger_disabled_returns_503(tmp_path: Path) -> None:
    server, thread, _service = _start(tmp_path, with_danger=False)
    try:
        status, payload = _post(
            server,
            "/api/danger/frame",
            {
                "scene_id": "fall_demo_01",
                "decision_id": "decision-0001",
                "timestamp_ms": 1000.0,
                "image_b64": JPEG_B64,
            },
        )
        assert status == 503 and payload["error"]["code"] == "danger_disabled"
    finally:
        _stop(server, thread)


def test_voice_asset_route_serves_presets(tmp_path: Path) -> None:
    voice_dir = tmp_path / "voice_presets"
    voice_dir.mkdir()
    (voice_dir / "fall_check_in.m4a").write_bytes(b"m4a-bytes")
    server, thread, _service = _start(tmp_path, voice_dir=voice_dir)
    try:
        status, body, content_type = _get(server, "/voice/fall_check_in.m4a")
        assert status == 200 and body == b"m4a-bytes"
        assert "audio" in content_type or "mp4" in content_type
        status, _body, _ct = _get(server, "/voice/../manifest.json")
        assert status == 404
        status, _body, _ct = _get(server, "/voice/absent.m4a")
        assert status == 404
    finally:
        _stop(server, thread)


def test_voice_route_without_dir_is_404(tmp_path: Path) -> None:
    server, thread, _service = _start(tmp_path, voice_dir=None)
    try:
        status, _body, _ct = _get(server, "/voice/fall_check_in.m4a")
        assert status == 404
    finally:
        _stop(server, thread)
