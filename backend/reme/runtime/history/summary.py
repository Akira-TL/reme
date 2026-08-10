"""Backend-only MiMo diary summary generation with revision-keyed caching."""

from __future__ import annotations

import hashlib
import json
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from reme.runtime.decision.mimo.adapter import (
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    MimoClient,
    MimoClientConfig,
    MimoTransportError,
)
from reme.runtime.history.projection import DEMO_MODE, HistoryContractError

DIARY_SUMMARY_SCHEMA_VERSION = "reme-diary-summary-state/v1"
SUMMARY_TIMEOUT_SECONDS = 20.0
SUMMARY_MAX_ATTEMPTS = 1
DEFAULT_CACHE_PATH = Path("artifacts/reme-history-summary-cache.json")
_ALLOWED_UNCERTAINTY = frozenset({"low", "medium", "high", "unknown"})

_SYSTEM_PROMPT = """你是 Reme 家庭日记摘要器。只根据输入的结构化事实生成简短中文摘要。
禁止诊断疾病、推断情绪、意图、睡眠或健康状态；禁止把设备状态扩写成未被来源支持的生活事实。
关怀内容只描述问候、本人回应、材料状态。输出严格 JSON：
{"headline":string,"summary":string,"highlights":[{"time":"HH:MM","text":string}],"care_note":string,"uncertainty":"low|medium|high|unknown"}
headline 不超过40字，summary 不超过240字，highlights 最多4条；
highlight 的 time 必须来自输入事件。"""


@dataclass(frozen=True, slots=True)
class DiarySummaryService:
    """Generate one summary per normalized day revision/input hash."""

    client: MimoClient | None
    model: str = DEFAULT_MODEL
    cache_path: Path = DEFAULT_CACHE_PATH
    clock_ms: Callable[[], int] = lambda: int(time.time() * 1000)

    @classmethod
    def from_environment(
        cls,
        *,
        cache_path: Path = DEFAULT_CACHE_PATH,
        clock_ms: Callable[[], int] | None = None,
    ) -> DiarySummaryService:
        api_key = os.environ.get("MIMO_API_KEY", "").strip()
        model = os.environ.get("MIMO_MODEL", DEFAULT_MODEL)
        client = None
        if api_key:
            client = MimoClient(
                MimoClientConfig(
                    base_url=os.environ.get("MIMO_BASE_URL", DEFAULT_BASE_URL),
                    model=model,
                    api_key=api_key,
                    timeout_seconds=SUMMARY_TIMEOUT_SECONDS,
                    max_attempts=SUMMARY_MAX_ATTEMPTS,
                    temperature=0.2,
                    max_completion_tokens=500,
                )
            )
        return cls(
            client=client,
            model=model,
            cache_path=cache_path,
            clock_ms=clock_ms or (lambda: int(time.time() * 1000)),
        )

    def generating_state(
        self,
        day_state: dict[str, Any],
        *,
        revision: int = 1,
    ) -> dict[str, Any]:
        return self._state(
            day_state,
            revision=revision,
            status="generating",
            summary=None,
            error_code=None,
        )

    def generate(
        self,
        day_state: dict[str, Any],
        *,
        force_retry: bool = False,
    ) -> dict[str, Any]:
        """Return cached/ready summary, or an explicit unavailable state.

        There is deliberately no fixed-text fallback.  A missing MiMo key is a
        visible capability state, not permission to label mock copy as MiMo.
        """

        _validate_day_for_summary(day_state)
        input_hash = _input_hash(day_state)
        cached = self._load_cached(input_hash)
        if cached is not None and not force_retry:
            return cached
        summary_revision = 1 if cached is None else int(cached["revision"]) + 1
        if self.client is None:
            state = self._state(
                day_state,
                revision=summary_revision,
                status="unavailable",
                summary=None,
                error_code="mimo_not_configured",
            )
            self._store_cached(input_hash, state)
            return state

        prompt, allowed_times = _build_user_prompt(day_state)
        started = time.perf_counter()
        try:
            result = self.client.complete(system_prompt=_SYSTEM_PROMPT, user_content=prompt)
        except MimoTransportError as exc:
            message = str(exc).lower()
            error = (
                "mimo_timeout"
                if "timeout" in message or "deadline" in message
                else "mimo_upstream_error"
            )
            state = self._state(
                day_state,
                revision=summary_revision,
                status="unavailable",
                summary=None,
                error_code=error,
            )
            self._store_cached(input_hash, state)
            return state
        latency_ms = (time.perf_counter() - started) * 1000
        try:
            summary = _parse_summary(
                result.content,
                allowed_times=allowed_times,
                model=self.model,
                generated_at_ms=self.clock_ms(),
                input_event_count=day_state["counts"]["total"],
                latency_ms=latency_ms,
                attempts=result.attempts,
            )
        except HistoryContractError:
            state = self._state(
                day_state,
                revision=summary_revision,
                status="unavailable",
                summary=None,
                error_code="mimo_invalid_output",
            )
            self._store_cached(input_hash, state)
            return state
        state = self._state(
            day_state,
            revision=summary_revision,
            status="ready",
            summary=summary,
            error_code=None,
        )
        self._store_cached(input_hash, state)
        return state

    def _state(
        self,
        day_state: dict[str, Any],
        *,
        revision: int,
        status: str,
        summary: dict[str, Any] | None,
        error_code: str | None,
    ) -> dict[str, Any]:
        return {
            "schema_version": DIARY_SUMMARY_SCHEMA_VERSION,
            "dataset_id": day_state["dataset_id"],
            "mode": DEMO_MODE,
            "date": day_state["date"],
            "revision": revision,
            "input_timeline_revision": int(day_state["revision"]),
            "status": status,
            "updated_at_ms": self.clock_ms(),
            "error_code": error_code,
            "summary": summary,
        }

    def _load_cached(self, input_hash: str) -> dict[str, Any] | None:
        if not self.cache_path.is_file():
            return None
        try:
            root = json.loads(self.cache_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(root, dict):
            return None
        value = root.get(input_hash)
        if not isinstance(value, dict):
            return None
        if value.get("status") not in {"ready", "unavailable"}:
            return None
        revision = value.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            return None
        return value

    def _store_cached(self, input_hash: str, state: dict[str, Any]) -> None:
        root: dict[str, Any] = {}
        if self.cache_path.is_file():
            try:
                loaded = json.loads(self.cache_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    root = loaded
            except (OSError, json.JSONDecodeError):
                root = {}
        root[input_hash] = state
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.cache_path.write_text(
                json.dumps(root, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
        except OSError:
            # Cache failure must never turn a valid MiMo completion into a
            # safety or page failure; the next explicit loader run may retry.
            return


def _input_hash(day_state: dict[str, Any]) -> str:
    canonical = json.dumps(
        {
            "dataset_id": day_state["dataset_id"],
            "date": day_state["date"],
            "revision": day_state["revision"],
            "items": day_state["items"],
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _build_user_prompt(day_state: dict[str, Any]) -> tuple[str, set[str]]:
    zone = ZoneInfo(day_state["timezone"])
    allowed_times: set[str] = set()
    facts: list[dict[str, Any]] = []
    for item in day_state["items"]:
        local = datetime.fromtimestamp(item["occurred_at_ms"] / 1000, tz=UTC).astimezone(zone)
        time_text = local.strftime("%H:%M")
        allowed_times.add(time_text)
        if item["kind"] in {"activity", "device"}:
            text = item["fact"]
        else:
            assessment = item.get("assessment") or {}
            response = item.get("response") or {}
            assessment_title = assessment.get("title", "")
            response_summary = response.get("summary", "未收到回应")
            text = f"关怀：{assessment_title}；回应：{response_summary}"
        facts.append({"time": time_text, "kind": item["kind"], "fact": text})
    payload = {
        "date": day_state["date"],
        "timezone": day_state["timezone"],
        "timeline_revision": day_state["revision"],
        "coverage": day_state["coverage"],
        "counts": day_state["counts"],
        "facts": facts,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")), allowed_times


def _parse_summary(
    content: str,
    *,
    allowed_times: set[str],
    model: str,
    generated_at_ms: int,
    input_event_count: int,
    latency_ms: float,
    attempts: int,
) -> dict[str, Any]:
    try:
        value = json.loads(content)
    except json.JSONDecodeError as exc:
        raise HistoryContractError("MiMo diary summary is not JSON") from exc
    if not isinstance(value, dict) or set(value) != {
        "headline",
        "summary",
        "highlights",
        "care_note",
        "uncertainty",
    }:
        raise HistoryContractError("MiMo diary summary fields are not exact")
    headline = _bounded_text(value["headline"], "headline", 40)
    summary_text = _bounded_text(value["summary"], "summary", 240)
    care_note = _bounded_text(value["care_note"], "care_note", 160)
    uncertainty = value["uncertainty"]
    if uncertainty not in _ALLOWED_UNCERTAINTY:
        raise HistoryContractError("invalid summary uncertainty")
    highlights_raw = value["highlights"]
    if not isinstance(highlights_raw, list) or len(highlights_raw) > 4:
        raise HistoryContractError("highlights must contain at most four items")
    highlights = []
    for item in highlights_raw:
        if not isinstance(item, dict) or set(item) != {"time", "text"}:
            raise HistoryContractError("highlight fields are not exact")
        time_text = item["time"]
        if time_text not in allowed_times:
            raise HistoryContractError("highlight time is not present in input events")
        highlights.append(
            {"time": time_text, "text": _bounded_text(item["text"], "highlight.text", 120)}
        )
    return {
        "headline": headline,
        "summary": summary_text,
        "highlights": highlights,
        "care_note": care_note,
        "uncertainty": uncertainty,
        "source": "mimo",
        "model": model,
        "generated_at_ms": generated_at_ms,
        "input_event_count": input_event_count,
        "latency_ms": round(latency_ms, 1),
        "attempts": attempts,
    }


def _bounded_text(value: object, label: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise HistoryContractError(f"{label} must be a non-empty string <= {limit} chars")
    return value


def _validate_day_for_summary(day_state: dict[str, Any]) -> None:
    required = {
        "schema_version",
        "dataset_id",
        "mode",
        "date",
        "timezone",
        "revision",
        "updated_at_ms",
        "status",
        "coverage",
        "counts",
        "items",
    }
    if set(day_state) != required:
        raise HistoryContractError("timeline day fields are not exact")
    if day_state["mode"] != DEMO_MODE:
        raise HistoryContractError("P0 diary summary only accepts mock_fixture")
    if day_state["status"] != "ready":
        raise HistoryContractError("timeline_not_ready")
