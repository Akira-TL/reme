"""MiMo client with live / mock / record modes returning one payload shape.

Live parameters follow the measured G-01 setup
(`.scratch/handoff/2026-08-01-mimo-api-live-test.md`): OpenAI-compatible
endpoint, JSON mode, thinking disabled, temperature 0.2, 8s timeout with a
single retry. Mock and record modes replay pre-authored payloads through the
same parse/validate path so downstream code never learns the mode.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from reme.decision.contracts import ContractError, MiMoPayload, parse_mimo_payload

DEFAULT_BASE_URL = "https://api.xiaomimimo.com/v1"
DEFAULT_MODEL = "mimo-v2.5"
DEFAULT_TIMEOUT_S = 8.0
DEFAULT_MAX_COMPLETION_TOKENS = 400
DEFAULT_TEMPERATURE = 0.2
API_KEY_ENV = "MIMO_API_KEY"


class MiMoClientError(RuntimeError):
    """Raised when MiMo cannot produce a contract-valid payload."""


@dataclass(frozen=True)
class MiMoCallResult:
    """One MiMo answer plus observability facts for the audit log."""

    payload: MiMoPayload
    latency_ms: float
    attempts: int
    mode: str


@dataclass
class LiveConfig:
    """HTTP configuration for the live MiMo path."""

    base_url: str = DEFAULT_BASE_URL
    model: str = DEFAULT_MODEL
    api_key: str | None = None
    timeout_s: float = DEFAULT_TIMEOUT_S
    max_retries: int = 1
    temperature: float = DEFAULT_TEMPERATURE
    max_completion_tokens: int = DEFAULT_MAX_COMPLETION_TOKENS
    extra_body: dict[str, Any] = field(
        default_factory=lambda: {"thinking": {"type": "disabled"}}
    )

    def resolve_api_key(self) -> str:
        key = self.api_key or os.environ.get(API_KEY_ENV, "")
        if not key:
            raise MiMoClientError(
                f"missing MiMo API key: set {API_KEY_ENV} (see ~/.config/reme/mimo.env)"
            )
        return key


class MiMoClient:
    """Unified decision client: `decide(messages)` behaves the same in every mode."""

    def __init__(
        self,
        mode: str = "mock",
        *,
        live_config: LiveConfig | None = None,
        mock_payloads: Iterator[dict[str, Any]] | None = None,
        record_path: Path | None = None,
        transport: Callable[[urllib.request.Request, float], bytes] | None = None,
    ) -> None:
        if mode not in ("live", "mock", "record"):
            raise MiMoClientError(f"unknown mode {mode!r}")
        self.mode = mode
        self._live_config = live_config or LiveConfig()
        self._mock_payloads = mock_payloads
        self._transport = transport or _default_transport
        self._recorded: list[dict[str, Any]] = []
        self._record_cursor = 0
        if mode == "record":
            if record_path is None:
                raise MiMoClientError("record mode requires record_path")
            self._recorded = _load_recorded(record_path)

    def decide(self, messages: list[dict[str, Any]]) -> MiMoCallResult:
        """Return one validated MiMo payload for the given chat messages."""

        start = time.monotonic()
        if self.mode == "mock":
            payload = self._next_mock()
            return MiMoCallResult(
                payload=payload,
                latency_ms=(time.monotonic() - start) * 1000,
                attempts=1,
                mode=self.mode,
            )
        if self.mode == "record":
            payload = self._next_recorded()
            return MiMoCallResult(
                payload=payload,
                latency_ms=(time.monotonic() - start) * 1000,
                attempts=1,
                mode=self.mode,
            )
        return self._decide_live(messages, start)

    def _decide_live(self, messages: list[dict[str, Any]], start: float) -> MiMoCallResult:
        config = self._live_config
        last_error: Exception | None = None
        attempts = 0
        for attempts in range(1, config.max_retries + 2):
            try:
                raw_text = self._post_chat(messages)
                payload = parse_mimo_payload(_extract_json_object(raw_text))
                return MiMoCallResult(
                    payload=payload,
                    latency_ms=(time.monotonic() - start) * 1000,
                    attempts=attempts,
                    mode=self.mode,
                )
            except (MiMoClientError, ContractError, urllib.error.URLError, OSError) as exc:
                last_error = exc
        raise MiMoClientError(f"MiMo live call failed after {attempts} attempts: {last_error}")

    def _post_chat(self, messages: list[dict[str, Any]]) -> str:
        config = self._live_config
        body: dict[str, Any] = {
            "model": config.model,
            "messages": messages,
            "temperature": config.temperature,
            "max_completion_tokens": config.max_completion_tokens,
            "response_format": {"type": "json_object"},
        }
        body.update(config.extra_body)
        request = urllib.request.Request(
            url=f"{config.base_url}/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {config.resolve_api_key()}",
            },
            method="POST",
        )
        raw = self._transport(request, config.timeout_s)
        try:
            envelope = json.loads(raw.decode("utf-8"))
            content = envelope["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
            raise MiMoClientError(f"malformed MiMo response envelope: {exc}") from exc
        if not isinstance(content, str) or not content.strip():
            raise MiMoClientError("MiMo returned empty content")
        return content

    def _next_mock(self) -> MiMoPayload:
        if self._mock_payloads is None:
            raise MiMoClientError("mock mode requires mock_payloads")
        try:
            raw = next(self._mock_payloads)
        except StopIteration as exc:
            raise MiMoClientError("mock payloads exhausted") from exc
        return parse_mimo_payload(raw)

    def _next_recorded(self) -> MiMoPayload:
        if self._record_cursor >= len(self._recorded):
            raise MiMoClientError("recorded payloads exhausted")
        raw = self._recorded[self._record_cursor]
        self._record_cursor += 1
        return parse_mimo_payload(raw)


def _default_transport(request: urllib.request.Request, timeout_s: float) -> bytes:
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        return bytes(response.read())


def _extract_json_object(text: str) -> dict[str, Any]:
    """Parse MiMo content as one JSON object, tolerating stray text around it."""

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end <= start:
            raise MiMoClientError("MiMo content contains no JSON object") from None
        try:
            parsed = json.loads(text[start : end + 1])
        except json.JSONDecodeError as exc:
            raise MiMoClientError(f"MiMo content is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise MiMoClientError("MiMo content must be a JSON object")
    return parsed


def _load_recorded(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise MiMoClientError(f"record file not found: {path}")
    entries: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            entry = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise MiMoClientError(f"invalid JSONL at {path}:{line_number}: {exc}") from exc
        if not isinstance(entry, dict):
            raise MiMoClientError(f"record entry at {path}:{line_number} must be an object")
        entries.append(entry)
    if not entries:
        raise MiMoClientError(f"record file is empty: {path}")
    return entries
