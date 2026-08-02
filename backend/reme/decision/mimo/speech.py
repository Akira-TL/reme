"""MiMo-V2.5 ASR and TTS clients for the elder voice dialogue path.

The public API is OpenAI-compatible but both speech models use
``/v1/chat/completions`` with model-specific payloads:

- ``mimo-v2.5-asr`` accepts one WAV/MP3 ``input_audio`` content part and
  returns the transcript in ``choices[0].message.content``;
- ``mimo-v2.5-tts`` accepts a style instruction plus the text to speak and
  returns Base64 audio in ``choices[0].message.audio.data``.

The transport is injectable so tests never call the network.
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

DEFAULT_SPEECH_BASE_URL = "https://api.xiaomimimo.com/v1"
DEFAULT_ASR_MODEL = "mimo-v2.5-asr"
DEFAULT_TTS_MODEL = "mimo-v2.5-tts"
DEFAULT_TTS_VOICE = "mimo_default"
DEFAULT_TTS_STYLE = "温和、自然、清晰的中文居家陪伴语气，语速稍慢，避免夸张情绪。"
SUPPORTED_ASR_FORMATS = frozenset({"wav", "mp3"})

TransportFn = Callable[[urllib.request.Request, float], bytes]


class MimoSpeechError(RuntimeError):
    """One ASR/TTS call failed or returned an invalid payload."""

    def __init__(self, message: str, *, attempts: int = 0) -> None:
        super().__init__(message)
        self.attempts = attempts


@dataclass(frozen=True, slots=True)
class MimoSpeechConfig:
    base_url: str = DEFAULT_SPEECH_BASE_URL
    api_key: str = ""
    asr_model: str = DEFAULT_ASR_MODEL
    tts_model: str = DEFAULT_TTS_MODEL
    tts_voice: str = DEFAULT_TTS_VOICE
    tts_format: str = "wav"
    timeout_seconds: float = 15.0
    max_attempts: int = 2


@dataclass(frozen=True, slots=True)
class SpeechRecognitionResult:
    transcript: str
    model: str
    latency_ms: float
    attempts: int
    usage: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class SpeechSynthesisResult:
    audio_b64: str
    audio_format: str
    voice: str
    model: str
    latency_ms: float
    attempts: int
    usage: dict[str, Any] | None = None


def _default_transport(request: urllib.request.Request, timeout: float) -> bytes:
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read()
        assert isinstance(body, bytes)
        return body


def _mime_type(audio_format: str) -> str:
    if audio_format == "wav":
        return "audio/wav"
    if audio_format == "mp3":
        return "audio/mpeg"
    raise MimoSpeechError(f"unsupported ASR audio format: {audio_format}")


def _load_response(raw: bytes) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None]:
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MimoSpeechError(f"malformed MiMo speech payload: {exc}") from exc
    if not isinstance(payload, dict):
        raise MimoSpeechError("MiMo speech payload must be a JSON object")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise MimoSpeechError("MiMo speech payload has no completion choice")
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise MimoSpeechError("MiMo speech payload has no message object")
    usage = payload.get("usage")
    return payload, message, usage if isinstance(usage, dict) else None


class MimoSpeechClient:
    """Retrying synchronous client used by B's threaded HTTP handlers."""

    def __init__(
        self,
        config: MimoSpeechConfig,
        *,
        transport: TransportFn | None = None,
    ) -> None:
        self._config = config
        self._transport = _default_transport if transport is None else transport

    @property
    def config(self) -> MimoSpeechConfig:
        return self._config

    def transcribe(
        self, audio_bytes: bytes, *, audio_format: str = "wav"
    ) -> SpeechRecognitionResult:
        if audio_format not in SUPPORTED_ASR_FORMATS:
            raise MimoSpeechError(
                f"audio_format must be one of {sorted(SUPPORTED_ASR_FORMATS)}"
            )
        if not audio_bytes:
            raise MimoSpeechError("audio payload is empty")
        encoded = base64.b64encode(audio_bytes).decode("ascii")
        body = {
            "model": self._config.asr_model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {
                                "data": f"data:{_mime_type(audio_format)};base64,{encoded}",
                                "format": audio_format,
                            },
                        }
                    ],
                }
            ],
            "asr_options": {"language": "zh"},
            "stream": False,
        }
        raw, latency_ms, attempts = self._request(body)
        payload, message, usage = _load_response(raw)
        transcript = message.get("content")
        if not isinstance(transcript, str) or not transcript.strip():
            raise MimoSpeechError("MiMo ASR returned an empty transcript", attempts=attempts)
        model = payload.get("model")
        return SpeechRecognitionResult(
            transcript=transcript.strip(),
            model=model if isinstance(model, str) else self._config.asr_model,
            latency_ms=latency_ms,
            attempts=attempts,
            usage=usage,
        )

    def synthesize(
        self,
        text: str,
        *,
        style: str = DEFAULT_TTS_STYLE,
    ) -> SpeechSynthesisResult:
        if not text.strip():
            raise MimoSpeechError("TTS text must be non-empty")
        body = {
            "model": self._config.tts_model,
            "messages": [
                {"role": "user", "content": style},
                {"role": "assistant", "content": text.strip()},
            ],
            "audio": {
                "format": self._config.tts_format,
                "voice": self._config.tts_voice,
            },
            "stream": False,
        }
        raw, latency_ms, attempts = self._request(body)
        payload, message, usage = _load_response(raw)
        audio = message.get("audio")
        if not isinstance(audio, dict):
            raise MimoSpeechError("MiMo TTS response has no audio object", attempts=attempts)
        audio_b64 = audio.get("data")
        if not isinstance(audio_b64, str) or not audio_b64.strip():
            raise MimoSpeechError("MiMo TTS response has no audio data", attempts=attempts)
        try:
            base64.b64decode(audio_b64, validate=True)
        except ValueError as exc:
            raise MimoSpeechError("MiMo TTS audio is not valid Base64", attempts=attempts) from exc
        model = payload.get("model")
        return SpeechSynthesisResult(
            audio_b64=audio_b64,
            audio_format=self._config.tts_format,
            voice=self._config.tts_voice,
            model=model if isinstance(model, str) else self._config.tts_model,
            latency_ms=latency_ms,
            attempts=attempts,
            usage=usage,
        )

    def _request(self, body: dict[str, Any]) -> tuple[bytes, float, int]:
        config = self._config
        if not config.api_key:
            raise MimoSpeechError("MIMO_API_KEY is not configured", attempts=0)
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        started = time.perf_counter()
        deadline = started + config.timeout_seconds * config.max_attempts
        last_error = "unknown error"
        attempt = 0
        for attempt in range(1, config.max_attempts + 1):
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                last_error = "deadline exhausted"
                break
            request = urllib.request.Request(
                url=f"{config.base_url.rstrip('/')}/chat/completions",
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {config.api_key}",
                    "User-Agent": "reme-decision/0.1",
                },
                method="POST",
            )
            try:
                raw = self._transport(request, min(config.timeout_seconds, remaining))
            except urllib.error.HTTPError as exc:
                last_error = f"HTTP {exc.code}"
                if exc.code != 429 and exc.code < 500:
                    raise MimoSpeechError(
                        f"MiMo speech call failed: {last_error}", attempts=attempt
                    ) from exc
                continue
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                continue
            latency_ms = (time.perf_counter() - started) * 1000
            return raw, latency_ms, attempt
        raise MimoSpeechError(
            f"MiMo speech call failed after {attempt} attempts: {last_error}",
            attempts=attempt,
        )


def speech_config_from_environment() -> MimoSpeechConfig:
    return MimoSpeechConfig(
        base_url=os.environ.get("MIMO_BASE_URL", DEFAULT_SPEECH_BASE_URL),
        api_key=os.environ.get("MIMO_API_KEY", ""),
        asr_model=os.environ.get("MIMO_ASR_MODEL", DEFAULT_ASR_MODEL),
        tts_model=os.environ.get("MIMO_TTS_MODEL", DEFAULT_TTS_MODEL),
        tts_voice=os.environ.get("MIMO_TTS_VOICE", DEFAULT_TTS_VOICE),
    )
