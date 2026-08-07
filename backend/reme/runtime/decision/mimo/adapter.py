"""Stdlib transport to the MiMo chat-completions API, plus a smoke-test CLI.

Live parameters were pinned by the 2026-08-01 measurements: OpenAI-compatible
``/chat/completions``, JSON mode, thinking disabled, temperature 0.2, an 8s
timeout and a single retry. The transport callable is injectable so every test
stays off the network.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from reme.runtime.decision.mimo.prompts import (
    PersonaConfig,
    build_system_prompt,
    build_user_prompt,
)
from reme.runtime.decision.mimo.schema import MimoSchemaError, parse_mimo_proposal
from reme.runtime.decision.state_machine import MimoTask

DEFAULT_BASE_URL = "https://api.xiaomimimo.com/v1"
DEFAULT_MODEL = "mimo-v2.5"

TransportFn = Callable[[urllib.request.Request, float], bytes]


class MimoTransportError(RuntimeError):
    """Raised when the MiMo API cannot produce a usable completion."""

    def __init__(self, message: str, *, attempts: int = 0) -> None:
        super().__init__(message)
        self.attempts = attempts


@dataclass(frozen=True, slots=True)
class MimoClientConfig:
    """Connection settings for one MiMo-compatible endpoint."""

    base_url: str = DEFAULT_BASE_URL
    model: str = DEFAULT_MODEL
    api_key: str = ""
    timeout_seconds: float = 8.0
    max_attempts: int = 2
    temperature: float = 0.2
    max_completion_tokens: int = 400


@dataclass(frozen=True, slots=True)
class MimoCallResult:
    """One successful completion with observability data for the audit log."""

    content: str
    latency_ms: float
    attempts: int
    usage: dict[str, Any] | None = None


def _default_transport(request: urllib.request.Request, timeout: float) -> bytes:
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read()
        assert isinstance(body, bytes)
        return body


def build_video_part(video_bytes: bytes, *, fps: int = 1) -> dict[str, Any]:
    """Encode one short clip as the MiMo ``video_url`` content part (ADR-0003)."""

    encoded = base64.b64encode(video_bytes).decode("ascii")
    return {
        "type": "video_url",
        "video_url": {"url": f"data:video/mp4;base64,{encoded}"},
        "fps": fps,
    }


def build_image_part(image_bytes: bytes, *, mime_type: str = "image/jpeg") -> dict[str, Any]:
    """Encode one keyframe as the MiMo ``image_url`` content part (ADR-0003)."""

    encoded = base64.b64encode(image_bytes).decode("ascii")
    return {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{encoded}"}}


# Container formats the omni endpoint accepts for ``input_audio`` — measured
# 2026-08-01 against api.xiaomimimo.com (the 400 body enumerates exactly this
# list; notably webm/opus is rejected, so Chrome recordings must be WAV).
SUPPORTED_AUDIO_FORMATS = frozenset({"wav", "mp3", "m4a", "ogg", "flac"})


def build_audio_part(audio_bytes: bytes, *, audio_format: str) -> dict[str, Any]:
    """Encode one short recording as the MiMo ``input_audio`` content part.

    The omni channel transcribes and reasons over the clip in a single chat
    call (measured ~2s for a 4s clip), which is why the danger link needs no
    separate ASR endpoint.
    """

    if audio_format not in SUPPORTED_AUDIO_FORMATS:
        raise ValueError(
            f"audio_format must be one of {sorted(SUPPORTED_AUDIO_FORMATS)}, got {audio_format!r}"
        )
    encoded = base64.b64encode(audio_bytes).decode("ascii")
    return {"type": "input_audio", "input_audio": {"data": encoded, "format": audio_format}}


class MimoClient:
    """Thin, retrying JSON-mode client for one configured endpoint."""

    def __init__(self, config: MimoClientConfig, *, transport: TransportFn | None = None) -> None:
        self._config = config
        self._transport = _default_transport if transport is None else transport

    def complete(
        self,
        *,
        system_prompt: str,
        user_content: str | list[dict[str, Any]],
    ) -> MimoCallResult:
        """Run one JSON-mode chat completion; retries once before failing."""

        config = self._config
        if not config.api_key:
            raise MimoTransportError("MIMO_API_KEY is not configured", attempts=0)
        body = {
            "model": config.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            "max_completion_tokens": config.max_completion_tokens,
            "temperature": config.temperature,
            "thinking": {"type": "disabled"},
            "response_format": {"type": "json_object"},
        }
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        last_error = "unknown error"
        started = time.perf_counter()
        # A single monotonic budget bounds the whole call, not each socket op:
        # urllib's timeout is per blocking operation, so without this cap two
        # silent attempts could take 2x the configured timeout or worse.
        deadline = started + config.timeout_seconds * config.max_attempts
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
                content, usage = _extract_completion(raw)
            except urllib.error.HTTPError as exc:
                last_error = f"HTTP {exc.code}"
                if exc.code != 429 and exc.code < 500:
                    # Auth/validation failures are not transient; retrying
                    # only burns the latency budget.
                    raise MimoTransportError(
                        f"MiMo call failed: {last_error}", attempts=attempt
                    ) from exc
                continue
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                continue
            except MimoTransportError as exc:
                last_error = str(exc)
                continue
            latency_ms = (time.perf_counter() - started) * 1000
            return MimoCallResult(
                content=content, latency_ms=latency_ms, attempts=attempt, usage=usage
            )
        raise MimoTransportError(
            f"MiMo call failed after {attempt} attempts: {last_error}",
            attempts=attempt,
        )


def _extract_completion(raw: bytes) -> tuple[str, dict[str, Any] | None]:
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MimoTransportError(f"malformed completion payload: {exc}") from exc
    if not isinstance(payload, dict):
        raise MimoTransportError("completion payload must be a JSON object")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise MimoTransportError("completion payload has no choices")
    first = choices[0]
    if not isinstance(first, dict):
        raise MimoTransportError("completion choice must be an object")
    message = first.get("message")
    if not isinstance(message, dict) or not isinstance(message.get("content"), str):
        raise MimoTransportError("completion message content is missing")
    usage = payload.get("usage")
    return message["content"], usage if isinstance(usage, dict) else None


def config_from_environment() -> MimoClientConfig:
    """Assemble a client config from MIMO_* environment variables."""

    return MimoClientConfig(
        base_url=os.environ.get("MIMO_BASE_URL", DEFAULT_BASE_URL),
        model=os.environ.get("MIMO_MODEL", DEFAULT_MODEL),
        api_key=os.environ.get("MIMO_API_KEY", ""),
    )


_SMOKE_PERCEPTION = {
    "posture": "sitting",
    "posture_duration_ms": 1860000,
    "motion_level": "still",
    "landmark_quality": "usable",
    "recent_transition": None,
    "time_context": "afternoon",
}
_SMOKE_INTERACTION = {
    "phase": "awaiting_elder",
    "clarification_used": False,
    "last_question": "今天午饭吃得还顺口吗？",
}


def _run_smoke(kind: str, media_path: Path | None, rounds: int) -> int:
    client = MimoClient(config_from_environment())
    persona = PersonaConfig()
    task = MimoTask.INTERPRET_RESPONSE
    system_prompt = build_system_prompt(task, persona=persona, visual=kind == "visual")
    text_body = build_user_prompt(
        task,
        perception_summary=_SMOKE_PERCEPTION,
        interaction_summary=_SMOKE_INTERACTION,
        elder_text="牙疼，饭咬不动。",
    )
    user_content: str | list[dict[str, Any]] = text_body
    if kind == "visual":
        if media_path is None:
            print("error: --media is required for the visual smoke")
            return 2
        user_content = [
            {"type": "text", "text": text_body},
            build_video_part(media_path.read_bytes()),
        ]
    successes = 0
    for round_index in range(1, rounds + 1):
        try:
            result = client.complete(system_prompt=system_prompt, user_content=user_content)
        except MimoTransportError as exc:
            print(f"round {round_index}: TRANSPORT FAIL after {exc.attempts} attempts: {exc}")
            continue
        try:
            proposal = parse_mimo_proposal(result.content, task=task)
        except MimoSchemaError as exc:
            print(f"round {round_index}: SCHEMA FAIL ({exc}); raw={result.content[:120]!r}")
            continue
        successes += 1
        print(
            f"round {round_index}: OK latency={result.latency_ms:.0f}ms "
            f"attempts={result.attempts} state={proposal.state} "
            f"uncertainty={proposal.uncertainty} elder_message={proposal.elder_message!r}"
        )
    print(f"smoke {kind}: {successes}/{rounds} rounds parsed clean")
    return 0 if successes == rounds else 1


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MiMo dual-path smoke test (B spec section 14)")
    parser.add_argument("kind", choices=("structured", "visual"))
    parser.add_argument("--media", type=Path, default=None, help="mp4 clip for the visual path")
    parser.add_argument("--rounds", type=int, default=1)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the structured or visual smoke against the configured endpoint."""

    args = _build_parser().parse_args(argv)
    return _run_smoke(args.kind, args.media, args.rounds)


if __name__ == "__main__":
    raise SystemExit(main())
