"""Offline contract tests for MiMo-V2.5 ASR/TTS requests."""

from __future__ import annotations

import base64
import json
import urllib.request
from typing import Any

from reme.decision.mimo.speech import MimoSpeechClient, MimoSpeechConfig


def _payload(request: urllib.request.Request) -> dict[str, Any]:
    assert isinstance(request.data, bytes)
    value = json.loads(request.data.decode("utf-8"))
    assert isinstance(value, dict)
    return value


def test_asr_uses_official_input_audio_contract() -> None:
    requests: list[urllib.request.Request] = []

    def transport(request: urllib.request.Request, timeout: float) -> bytes:
        requests.append(request)
        assert timeout == 15.0
        return json.dumps(
            {
                "model": "mimo-v2.5-asr",
                "choices": [{"message": {"content": "分享给孩子。"}}],
                "usage": {"total_tokens": 12},
            }
        ).encode()

    client = MimoSpeechClient(MimoSpeechConfig(api_key="secret"), transport=transport)
    result = client.transcribe(b"RIFFfake-wave", audio_format="wav")

    assert result.transcript == "分享给孩子。"
    assert result.model == "mimo-v2.5-asr"
    request = requests[0]
    assert request.full_url == "https://api.xiaomimimo.com/v1/chat/completions"
    assert request.headers["Authorization"] == "Bearer secret"
    body = _payload(request)
    assert body["model"] == "mimo-v2.5-asr"
    assert body["asr_options"] == {"language": "auto"}
    input_audio = body["messages"][0]["content"][0]
    assert input_audio["type"] == "input_audio"
    assert set(input_audio["input_audio"]) == {"data"}
    prefix, encoded = input_audio["input_audio"]["data"].split(",", 1)
    assert prefix == "data:audio/wav;base64"
    assert base64.b64decode(encoded) == b"RIFFfake-wave"


def test_tts_uses_mimo_default_and_returns_wav_base64() -> None:
    requests: list[urllib.request.Request] = []
    audio_b64 = base64.b64encode(b"RIFFtts-wave").decode("ascii")

    def transport(request: urllib.request.Request, timeout: float) -> bytes:
        requests.append(request)
        return json.dumps(
            {
                "model": "mimo-v2.5-tts",
                "choices": [{"message": {"content": "", "audio": {"data": audio_b64}}}],
                "usage": {"total_tokens": 20},
            }
        ).encode()

    client = MimoSpeechClient(MimoSpeechConfig(api_key="secret"), transport=transport)
    result = client.synthesize("好的，这次不分享。")

    assert result.audio_b64 == audio_b64
    assert result.audio_format == "wav"
    assert result.voice == "mimo_default"
    assert result.model == "mimo-v2.5-tts"
    body = _payload(requests[0])
    assert body["model"] == "mimo-v2.5-tts"
    assert body["messages"][0]["role"] == "user"
    assert body["messages"][1] == {"role": "assistant", "content": "好的，这次不分享。"}
    assert body["audio"] == {"format": "wav", "voice": "mimo_default"}
