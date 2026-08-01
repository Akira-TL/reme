from __future__ import annotations

import json
import urllib.request
from typing import Any

import pytest

from reme.decision.mimo_client import (
    LiveConfig,
    MiMoClient,
    MiMoClientError,
    _extract_json_object,
)

_PAYLOAD: dict[str, Any] = {
    "state": "normal",
    "risk_level": 0,
    "privacy_mode": "skeleton_only",
    "need_dialogue": False,
    "dialogue_goal": None,
    "elder_message": None,
    "family_notification": None,
    "action": "none",
    "reason_summary": "ok",
}


def _envelope(content: str) -> bytes:
    return json.dumps({"choices": [{"message": {"content": content}}]}).encode()


def test_mock_mode_returns_scripted_payload() -> None:
    client = MiMoClient("mock", mock_payloads=iter([_PAYLOAD]))
    result = client.decide([])
    assert result.mode == "mock"
    assert result.payload.state == "normal"
    with pytest.raises(MiMoClientError):
        client.decide([])


def test_extract_json_tolerates_surrounding_text() -> None:
    parsed = _extract_json_object('好的，结果如下：{"a": 1} 完毕')
    assert parsed == {"a": 1}
    with pytest.raises(MiMoClientError):
        _extract_json_object("没有对象")


def test_live_request_shape_and_success() -> None:
    captured: dict[str, Any] = {}

    def transport(request: urllib.request.Request, timeout_s: float) -> bytes:
        captured["body"] = json.loads(request.data.decode())  # type: ignore[union-attr]
        captured["auth"] = request.get_header("Authorization")
        captured["timeout"] = timeout_s
        return _envelope(json.dumps(_PAYLOAD))

    client = MiMoClient(
        "live",
        live_config=LiveConfig(api_key="sk-test"),
        transport=transport,
    )
    result = client.decide([{"role": "user", "content": "hi"}])
    assert result.payload.reason_summary == "ok"
    body = captured["body"]
    assert body["model"] == "mimo-v2.5"
    assert body["response_format"] == {"type": "json_object"}
    assert body["thinking"] == {"type": "disabled"}
    assert body["temperature"] == 0.2
    assert captured["auth"] == "Bearer sk-test"
    assert captured["timeout"] == 8.0


def test_live_retries_once_then_succeeds() -> None:
    calls = {"count": 0}

    def transport(request: urllib.request.Request, timeout_s: float) -> bytes:
        calls["count"] += 1
        if calls["count"] == 1:
            raise OSError("simulated timeout")
        return _envelope(json.dumps(_PAYLOAD))

    client = MiMoClient("live", live_config=LiveConfig(api_key="k"), transport=transport)
    result = client.decide([])
    assert result.attempts == 2


def test_live_gives_up_after_retry_budget() -> None:
    def transport(request: urllib.request.Request, timeout_s: float) -> bytes:
        raise OSError("down")

    client = MiMoClient("live", live_config=LiveConfig(api_key="k"), transport=transport)
    with pytest.raises(MiMoClientError):
        client.decide([])


def test_live_missing_key_raises() -> None:
    def transport(request: urllib.request.Request, timeout_s: float) -> bytes:
        return _envelope(json.dumps(_PAYLOAD))

    client = MiMoClient(
        "live", live_config=LiveConfig(api_key=None), transport=transport
    )
    import os

    saved = os.environ.pop("MIMO_API_KEY", None)
    try:
        with pytest.raises(MiMoClientError):
            client.decide([])
    finally:
        if saved is not None:
            os.environ["MIMO_API_KEY"] = saved
