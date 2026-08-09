"""Bounded MiMo JSON contract for the family-facing daily diary summary.

This experimental surface is deliberately separate from ``CareDecision``:
the diary summarizes already-recorded facts and cannot express an alarm,
authorization, state-machine transition, or media grant.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Any, Protocol

from reme.runtime.decision.mimo.adapter import DEFAULT_MODEL, MimoCallResult
from reme.runtime.decision.mimo.schema import extract_json_object

DIARY_REQUEST_SCHEMA = "reme-diary-summary-request/v0-experiment"
DIARY_RESPONSE_SCHEMA = "reme-diary-summary/v0-experiment"

_REQUEST_FIELDS = frozenset({"schema_version", "date", "events"})
_EVENT_FIELDS = frozenset({"time", "kind", "period", "description"})
_COMPLETION_FIELDS = frozenset(
    {"headline", "summary", "highlights", "care_note", "uncertainty"}
)
_HIGHLIGHT_FIELDS = frozenset({"time", "text"})
_EVENT_KINDS = frozenset({"activity", "device", "care", "response", "material"})
_UNCERTAINTIES = frozenset({"low", "medium", "high"})
_CLOCK_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
_MAX_EVENTS = 64


class DiarySummaryError(ValueError):
    """A request or model completion failed the experimental diary contract."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class MimoClientLike(Protocol):
    def complete(
        self,
        *,
        system_prompt: str,
        user_content: str | list[dict[str, Any]],
    ) -> MimoCallResult: ...


@dataclass(frozen=True, slots=True)
class DiaryEvent:
    time: str
    kind: str
    period: str
    description: str

    def to_payload(self) -> dict[str, str]:
        return {
            "time": self.time,
            "kind": self.kind,
            "period": self.period,
            "description": self.description,
        }


@dataclass(frozen=True, slots=True)
class DiarySummaryRequest:
    date: str
    events: tuple[DiaryEvent, ...]

    def to_prompt_payload(self) -> dict[str, object]:
        return {
            "date": self.date,
            "events": [event.to_payload() for event in self.events],
        }


@dataclass(frozen=True, slots=True)
class DiaryHighlight:
    time: str
    text: str

    def to_payload(self) -> dict[str, str]:
        return {"time": self.time, "text": self.text}


@dataclass(frozen=True, slots=True)
class DiarySummary:
    date: str
    headline: str
    summary: str
    highlights: tuple[DiaryHighlight, ...]
    care_note: str | None
    uncertainty: str
    model: str
    generated_at_ms: int
    input_event_count: int
    latency_ms: float
    attempts: int

    def to_payload(self) -> dict[str, object]:
        return {
            "schema_version": DIARY_RESPONSE_SCHEMA,
            "date": self.date,
            "headline": self.headline,
            "summary": self.summary,
            "highlights": [item.to_payload() for item in self.highlights],
            "care_note": self.care_note,
            "uncertainty": self.uncertainty,
            "source": "mimo",
            "model": self.model,
            "generated_at_ms": self.generated_at_ms,
            "input_event_count": self.input_event_count,
            "latency_ms": round(self.latency_ms, 1),
            "attempts": self.attempts,
        }


def _exact_fields(payload: dict[str, object], allowed: frozenset[str], label: str) -> None:
    unknown = sorted(set(payload) - allowed)
    missing = sorted(allowed - set(payload))
    if unknown:
        raise DiarySummaryError(
            "diary_contract_violation", f"{label} has unexpected fields: {', '.join(unknown)}"
        )
    if missing:
        raise DiarySummaryError(
            "diary_contract_violation", f"{label} is missing fields: {', '.join(missing)}"
        )


def _text(
    payload: dict[str, object],
    key: str,
    *,
    label: str,
    max_chars: int,
) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise DiarySummaryError("diary_contract_violation", f"{label}.{key} must be text")
    result = value.strip()
    if len(result) > max_chars:
        raise DiarySummaryError(
            "diary_contract_violation", f"{label}.{key} exceeds {max_chars} characters"
        )
    return result


def parse_diary_summary_request(payload: dict[str, object]) -> DiarySummaryRequest:
    _exact_fields(payload, _REQUEST_FIELDS, "request")
    if payload.get("schema_version") != DIARY_REQUEST_SCHEMA:
        raise DiarySummaryError(
            "diary_contract_violation",
            f"schema_version must be {DIARY_REQUEST_SCHEMA!r}",
        )
    date_value = _text(payload, "date", label="request", max_chars=10)
    try:
        date.fromisoformat(date_value)
    except ValueError as exc:
        raise DiarySummaryError(
            "diary_contract_violation", "request.date must be YYYY-MM-DD"
        ) from exc
    raw_events = payload.get("events")
    if not isinstance(raw_events, list) or not 1 <= len(raw_events) <= _MAX_EVENTS:
        raise DiarySummaryError(
            "diary_contract_violation", f"request.events must contain 1..{_MAX_EVENTS} items"
        )
    events: list[DiaryEvent] = []
    for index, raw_event in enumerate(raw_events):
        if not isinstance(raw_event, dict):
            raise DiarySummaryError(
                "diary_contract_violation", f"events[{index}] must be an object"
            )
        event = dict(raw_event)
        label = f"events[{index}]"
        _exact_fields(event, _EVENT_FIELDS, label)
        event_time = _text(event, "time", label=label, max_chars=5)
        if _CLOCK_RE.fullmatch(event_time) is None:
            raise DiarySummaryError(
                "diary_contract_violation", f"{label}.time must be HH:MM"
            )
        kind = _text(event, "kind", label=label, max_chars=16)
        if kind not in _EVENT_KINDS:
            raise DiarySummaryError(
                "diary_contract_violation", f"{label}.kind has an unsupported value"
            )
        events.append(
            DiaryEvent(
                time=event_time,
                kind=kind,
                period=_text(event, "period", label=label, max_chars=16),
                description=_text(event, "description", label=label, max_chars=160),
            )
        )
    return DiarySummaryRequest(date=date_value, events=tuple(events))


def _completion_text(
    payload: dict[str, object], key: str, *, max_chars: int, nullable: bool = False
) -> str | None:
    value = payload.get(key)
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > max_chars:
        suffix = " or null" if nullable else ""
        raise DiarySummaryError(
            "mimo_invalid_diary_summary", f"{key} must be bounded text{suffix}"
        )
    return value.strip()


def parse_diary_summary_completion(raw_text: str) -> tuple[
    str, str, tuple[DiaryHighlight, ...], str | None, str
]:
    try:
        payload = json.loads(extract_json_object(raw_text))
    except (ValueError, json.JSONDecodeError) as exc:
        raise DiarySummaryError(
            "mimo_invalid_diary_summary", f"MiMo diary output is not valid JSON: {exc}"
        ) from exc
    if not isinstance(payload, dict):
        raise DiarySummaryError(
            "mimo_invalid_diary_summary", "MiMo diary output must be an object"
        )
    completion = dict(payload)
    try:
        _exact_fields(completion, _COMPLETION_FIELDS, "completion")
    except DiarySummaryError as exc:
        raise DiarySummaryError("mimo_invalid_diary_summary", str(exc)) from exc
    headline = _completion_text(completion, "headline", max_chars=40)
    summary = _completion_text(completion, "summary", max_chars=240)
    care_note = _completion_text(completion, "care_note", max_chars=160, nullable=True)
    uncertainty = completion.get("uncertainty")
    if uncertainty not in _UNCERTAINTIES:
        raise DiarySummaryError(
            "mimo_invalid_diary_summary", "uncertainty must be low, medium, or high"
        )
    raw_highlights = completion.get("highlights")
    if not isinstance(raw_highlights, list) or len(raw_highlights) > 4:
        raise DiarySummaryError(
            "mimo_invalid_diary_summary", "highlights must contain at most 4 items"
        )
    highlights: list[DiaryHighlight] = []
    for index, raw_highlight in enumerate(raw_highlights):
        if not isinstance(raw_highlight, dict):
            raise DiarySummaryError(
                "mimo_invalid_diary_summary", f"highlights[{index}] must be an object"
            )
        highlight = dict(raw_highlight)
        try:
            _exact_fields(highlight, _HIGHLIGHT_FIELDS, f"highlights[{index}]")
        except DiarySummaryError as exc:
            raise DiarySummaryError("mimo_invalid_diary_summary", str(exc)) from exc
        highlight_time = highlight.get("time")
        text = highlight.get("text")
        if not isinstance(highlight_time, str) or _CLOCK_RE.fullmatch(highlight_time) is None:
            raise DiarySummaryError(
                "mimo_invalid_diary_summary", f"highlights[{index}].time must be HH:MM"
            )
        if not isinstance(text, str) or not text.strip() or len(text.strip()) > 100:
            raise DiarySummaryError(
                "mimo_invalid_diary_summary", f"highlights[{index}].text must be bounded text"
            )
        highlights.append(DiaryHighlight(time=highlight_time, text=text.strip()))
    assert isinstance(headline, str)
    assert isinstance(summary, str)
    assert isinstance(uncertainty, str)
    return headline, summary, tuple(highlights), care_note, uncertainty


_SYSTEM_PROMPT = """你是 Reme 的 MiMo 日记整理器。输入是已经记录的结构化生活片段。
只做事实整理，不诊断疾病，不推断情绪、意图、睡眠或健康状态，不补写输入中没有发生的事。
标题不超过 40 个汉字；摘要不超过 240 个汉字；最多选择 4 个有时间的重点片段。
care_note 只说明主动关怀是否发起、是否收到回应；没有关怀则为 null。
严格只返回一个 JSON 对象，字段必须且只能是：
{"headline":"...","summary":"...","highlights":[{"time":"HH:MM","text":"..."}],"care_note":null,"uncertainty":"low|medium|high"}
不要输出 Markdown。"""


class MimoDiarySummaryService:
    """Send one bounded event list to MiMo and validate the returned JSON."""

    def __init__(
        self,
        client: MimoClientLike,
        *,
        model: str = DEFAULT_MODEL,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._client = client
        self._model = model
        self._clock = clock

    def generate(self, payload: dict[str, object]) -> DiarySummary:
        request = parse_diary_summary_request(payload)
        result = self._client.complete(
            system_prompt=_SYSTEM_PROMPT,
            user_content=json.dumps(request.to_prompt_payload(), ensure_ascii=False),
        )
        headline, summary, highlights, care_note, uncertainty = (
            parse_diary_summary_completion(result.content)
        )
        observed_times = {event.time for event in request.events}
        invented_times = sorted({item.time for item in highlights} - observed_times)
        if invented_times:
            raise DiarySummaryError(
                "mimo_invalid_diary_summary",
                "MiMo diary highlights contain unobserved times: "
                + ", ".join(invented_times),
            )
        return DiarySummary(
            date=request.date,
            headline=headline,
            summary=summary,
            highlights=highlights,
            care_note=care_note,
            uncertainty=uncertainty,
            model=self._model,
            generated_at_ms=int(self._clock() * 1000),
            input_event_count=len(request.events),
            latency_ms=result.latency_ms,
            attempts=result.attempts,
        )
