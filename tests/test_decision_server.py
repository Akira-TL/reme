from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from http.server import ThreadingHTTPServer
from typing import Any

import pytest

from reme.decision.mock_scenes import SCENE_NEED_LOOP
from reme.decision.server import SessionRegistry, build_handler


@pytest.fixture()
def api_base(tmp_path: Any) -> Iterator[str]:
    registry = SessionRegistry(mode="mock", audit_dir=tmp_path / "audit")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), build_handler(registry))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}"
    finally:
        httpd.shutdown()
        httpd.server_close()


def _post(base: str, path: str, body: dict[str, Any]) -> Any:
    request = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode())


def _get(base: str, path: str) -> Any:
    with urllib.request.urlopen(f"{base}{path}", timeout=5) as response:
        return json.loads(response.read().decode())


def test_health_lists_scenes(api_base: str) -> None:
    health = _get(api_base, "/api/health")
    assert health["status"] == "ok"
    assert SCENE_NEED_LOOP in health["scenes"]


def test_full_toothache_loop_over_http(api_base: str) -> None:
    scene = f"/api/scenes/{SCENE_NEED_LOOP}"

    early = _post(api_base, f"{scene}/posture", _observation(10_000.0))
    assert early is None

    opening = _post(api_base, f"{scene}/posture", _observation(65_000.0))
    assert opening["state"] == "check_in_required"
    assert _get(api_base, f"{scene}/decision")["decision_id"] == opening["decision_id"]

    consent = _post(
        api_base,
        f"{scene}/response",
        _response(opening, "need_help", text="牙疼，饭咬不动。"),
    )
    assert consent["consent_required"] is True

    notify = _post(api_base, f"{scene}/response", _response(consent, "consent_granted"))
    assert notify["action"] == "notify_family"
    assert notify["action_card"]["status"] == "pending"

    receipt = _post(
        api_base,
        f"{scene}/response",
        _response(notify, "card_confirmed", source="family_input"),
    )
    assert receipt["state"] == "resolved"

    reset = _post(api_base, f"{scene}/reset", {})
    assert reset["status"] == "reset"
    assert _get(api_base, f"{scene}/decision") is None


def test_contract_violation_returns_422(api_base: str) -> None:
    scene = f"/api/scenes/{SCENE_NEED_LOOP}"
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        _post(api_base, f"{scene}/response", {"bad": "payload"})
    assert excinfo.value.code == 422


def _observation(duration_ms: float) -> dict[str, Any]:
    return {
        "schema_version": "reme-posture/v0-experiment",
        "scene_id": SCENE_NEED_LOOP,
        "timestamp_ms": duration_ms,
        "posture": "sitting",
        "posture_confidence": 0.9,
        "posture_duration_ms": duration_ms,
        "motion_level": "still",
        "landmark_quality": "usable",
    }


def _response(
    decision: dict[str, Any],
    response: str,
    *,
    text: str | None = None,
    source: str = "user_input",
) -> dict[str, Any]:
    return {
        "schema_version": "reme-interaction-response/v0-experiment",
        "scene_id": decision["scene_id"],
        "decision_id": decision["decision_id"],
        "timestamp_ms": decision["timestamp_ms"] + 5_000.0,
        "response": response,
        "source": source,
        "demo_mode": decision["demo_mode"],
        "text": text,
    }
