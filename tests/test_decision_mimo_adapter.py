"""Transport-layer tests for the MiMo client (no network involved)."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

import pytest
from reme.decision.mimo.adapter import (
    MimoCallResult,
    MimoClient,
    MimoClientConfig,
    MimoTransportError,
    build_video_part,
)


def _config(**overrides: Any) -> MimoClientConfig:
    fields: dict[str, Any] = {"api_key": "sk-test", "max_attempts": 2}
    fields.update(overrides)
    return MimoClientConfig(**fields)


def _completion_bytes(content: str) -> bytes:
    payload = {
        "choices": [{"message": {"role": "assistant", "content": content}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
    }
    return json.dumps(payload).encode("utf-8")


def test_client_sends_json_mode_and_thinking_disabled() -> None:
    captured: list[urllib.request.Request] = []

    def transport(request: urllib.request.Request, timeout: float) -> bytes:
        captured.append(request)
        assert timeout == 8.0
        return _completion_bytes("{}")

    client = MimoClient(_config(), transport=transport)
    result = client.complete(system_prompt="系统", user_content="用户")
    assert isinstance(result, MimoCallResult)
    request = captured[0]
    assert request.full_url == "https://api.xiaomimimo.com/v1/chat/completions"
    assert request.get_header("Authorization") == "Bearer sk-test"
    assert request.data is not None
    body = json.loads(request.data.decode("utf-8"))
    assert body["model"] == "mimo-v2.5"
    assert body["response_format"] == {"type": "json_object"}
    assert body["thinking"] == {"type": "disabled"}
    assert body["temperature"] == 0.2


def test_client_retries_once_then_raises_transport_error() -> None:
    attempts: list[int] = []

    def transport(request: urllib.request.Request, timeout: float) -> bytes:
        attempts.append(1)
        raise urllib.error.URLError("connection refused")

    client = MimoClient(_config(), transport=transport)
    with pytest.raises(MimoTransportError, match="2 attempts"):
        client.complete(system_prompt="系统", user_content="用户")
    assert len(attempts) == 2


def test_client_recovers_on_second_attempt() -> None:
    calls: list[int] = []

    def transport(request: urllib.request.Request, timeout: float) -> bytes:
        calls.append(1)
        if len(calls) == 1:
            raise TimeoutError("timed out")
        return _completion_bytes('{"ok":true}')

    client = MimoClient(_config(), transport=transport)
    result = client.complete(system_prompt="系统", user_content="用户")
    assert result.attempts == 2
    assert result.content == '{"ok":true}'
    assert result.latency_ms >= 0
    assert result.usage == {"prompt_tokens": 10, "completion_tokens": 5}


def test_client_requires_api_key_before_any_attempt() -> None:
    def transport(request: urllib.request.Request, timeout: float) -> bytes:
        raise AssertionError("transport must not be called without a key")

    client = MimoClient(_config(api_key=""), transport=transport)
    with pytest.raises(MimoTransportError, match="MIMO_API_KEY"):
        client.complete(system_prompt="系统", user_content="用户")


def test_client_rejects_malformed_response_payload() -> None:
    def transport(request: urllib.request.Request, timeout: float) -> bytes:
        return b"not json"

    client = MimoClient(_config(), transport=transport)
    with pytest.raises(MimoTransportError, match="malformed"):
        client.complete(system_prompt="系统", user_content="用户")


def test_build_video_part_encodes_data_uri_with_fps() -> None:
    part = build_video_part(b"\x00\x01", fps=2)
    assert part["type"] == "video_url"
    assert part["fps"] == 2
    assert part["video_url"]["url"].startswith("data:video/mp4;base64,")
