"""Longitudinal behavior memory: baselines, event history, deviation.

B-private store: it consumes only what the decision layer already holds
(behavior windows plus emitted-decision milestones) and feeds compact
Chinese summaries back into MiMo prompts.  Memory adds context and may
tighten attention; it never relaxes a deterministic escalation — the
guardrails remain the only escalation owner (ADR-0005 / ADR-0006).
"""

from __future__ import annotations

import contextlib
import json
import math
import os
import queue
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from reme.decision.behavior import BehaviorFeatures

MEMORY_SCHEMA_VERSION = "reme-behavior-memory/v0-experiment"
# None of these four have literature backing — they are demo-scale choices
# registered in docs/references/cognition-evidence.md.  What the literature
# does support is the *reason* a per-hour baseline exists at all: in older
# adults, deviation from one's own routine carries more signal than any
# absolute threshold (see the geriatric entries in that ledger).
DEFAULT_EWMA_ALPHA = 0.3
MAX_EVENTS = 200
MIN_BASELINE_SAMPLES = 3


class MemoryEventKind(StrEnum):
    """Milestones worth remembering across sessions."""

    FALL_ALERT = "fall_alert"
    CHECK_IN_SENT = "check_in_sent"
    COMPLAINT = "complaint"
    CONSENT_GRANTED = "consent_granted"
    FAMILY_NOTIFIED = "family_notified"
    URGENT = "urgent"
    RESOLVED = "resolved"


# Summary wording is fixed here so prompts stay reproducible; every clause is a
# literal replay of a recorded milestone — no diagnosis words, no inference.
_SECONDS_PER_DAY = 86400.0
_SUMMARY_PREFIX = "记忆："
_SUMMARY_JOIN = "；"
_COMPLAINT_KINDS = frozenset({MemoryEventKind.COMPLAINT})
_ALERT_KINDS = frozenset({MemoryEventKind.FALL_ALERT, MemoryEventKind.URGENT})
_ALERT_PHRASES = {
    MemoryEventKind.FALL_ALERT: "曾触发跌倒警报",
    MemoryEventKind.URGENT: "曾升级为紧急关注",
}
# A baseline of ~0ms would make the deviation ratio explode; one millisecond is
# the smallest honest denominator.
_MIN_BASELINE_DENOMINATOR_MS = 1.0


@dataclass(frozen=True, slots=True)
class MemoryEvent:
    """One remembered milestone, stamped with caller-supplied wall time."""

    recorded_at_s: float
    kind: MemoryEventKind
    scene_id: str
    detail: str | None


@dataclass(frozen=True, slots=True)
class HourBaseline:
    """EWMA activity baseline for one local hour-of-day bucket."""

    hour: int
    samples: int
    restlessness_ewma: float
    longest_still_ewma_ms: float


class _CorruptMemoryError(Exception):
    """Internal marker: the on-disk payload cannot be trusted, start empty."""


class BehaviorMemoryStore:
    """Thread-safe per-elder memory with atomic JSON persistence.

    Storage failures never propagate into the decision path (audit-style
    OSError tolerance); a missing or corrupt file simply starts empty.
    ``path=None`` keeps the store purely in-memory.
    """

    def __init__(
        self,
        path: Path | None,
        *,
        clock: Callable[[], float],
        persist_async: bool = False,
    ) -> None:
        self._path = path
        self._clock = clock
        self._lock = threading.Lock()
        self._events: list[MemoryEvent] = []
        self._baselines: dict[int, HourBaseline] = {}
        # persist_async hands writes to one ordered daemon writer so mutations
        # made on the decision path never wait on the filesystem (Codex R3 P1).
        self._persist_queue: queue.SimpleQueue[dict[str, object]] | None = None
        if path is not None:
            state = _load_state(path)
            if state is not None:
                self._events, self._baselines = state
            if persist_async:
                self._persist_queue = queue.SimpleQueue()
                threading.Thread(
                    target=self._writer_loop, name="behavior-memory-writer", daemon=True
                ).start()

    def _writer_loop(self) -> None:
        assert self._persist_queue is not None and self._path is not None
        while True:
            payload = self._persist_queue.get()
            # Coalesce to the newest snapshot; intermediate states are moot.
            while not self._persist_queue.empty():
                with contextlib.suppress(queue.Empty):
                    payload = self._persist_queue.get_nowait()
            _write_payload(self._path, payload)

    def record_event(
        self, kind: MemoryEventKind, *, scene_id: str, detail: str | None = None
    ) -> None:
        """Append one milestone (trimmed to MAX_EVENTS, newest kept) and persist."""

        with self._lock:
            self._events.append(
                MemoryEvent(
                    recorded_at_s=float(self._clock()),
                    kind=kind,
                    scene_id=scene_id,
                    detail=detail,
                )
            )
            if len(self._events) > MAX_EVENTS:
                del self._events[: len(self._events) - MAX_EVENTS]
            self._persist_locked()

    def observe(self, features: BehaviorFeatures, *, local_hour: int) -> None:
        """Fold one behavior window into that hour's baseline and persist."""

        hour = _validated_hour(local_hour)
        with self._lock:
            previous = self._baselines.get(hour)
            if previous is None:
                self._baselines[hour] = HourBaseline(
                    hour=hour,
                    samples=1,
                    restlessness_ewma=float(features.restlessness_score),
                    longest_still_ewma_ms=float(features.longest_still_ms),
                )
            else:
                self._baselines[hour] = HourBaseline(
                    hour=hour,
                    samples=previous.samples + 1,
                    restlessness_ewma=_fold_ewma(
                        previous.restlessness_ewma, features.restlessness_score
                    ),
                    longest_still_ewma_ms=_fold_ewma(
                        previous.longest_still_ewma_ms, features.longest_still_ms
                    ),
                )
            self._persist_locked()

    def deviation(self, features: BehaviorFeatures, *, local_hour: int) -> float | None:
        """今天此时段静止时长相对基线的比值；样本不足 MIN_BASELINE_SAMPLES 时 None。

        ``local_hour`` 越界同 :meth:`observe`，抛 ValueError（桶下标必须合法）。
        """

        hour = _validated_hour(local_hour)
        with self._lock:
            baseline = self._baselines.get(hour)
            if baseline is None or baseline.samples < MIN_BASELINE_SAMPLES:
                return None
            denominator = max(baseline.longest_still_ewma_ms, _MIN_BASELINE_DENOMINATOR_MS)
            return float(features.longest_still_ms) / denominator

    def recent_events(
        self,
        *,
        kinds: frozenset[MemoryEventKind] | None = None,
        limit: int = 5,
    ) -> tuple[MemoryEvent, ...]:
        """Newest-first milestones, optionally filtered by kind."""

        with self._lock:
            return self._recent_locked(kinds=kinds, limit=limit)

    def summary_zh(self, *, local_hour: int | None, max_chars: int = 160) -> str | None:
        """Compact Chinese memory digest for prompts; None when nothing to say.

        分工：本方法只复述**事件史**——最近一次主诉、最近一次跌倒/紧急升级，
        逐字复述已记录的内容，绝不虚构、不使用诊断词。时段偏离（今天此刻是否
        比平时更静止）刻意不在这里拼句：调用方（policy 层）自行调用
        :meth:`deviation` 取比值，再决定如何写进 prompt。因此 ``local_hour``
        仅作为签名占位保留，不参与文案生成——传 None 与传具体小时输出一致，
        也不做区间校验。

        素材按优先级排列（主诉 > 跌倒/紧急），以 "记忆：" 开头、分号连接；
        超出 ``max_chars`` 时从最低优先级素材开始丢弃。
        """

        with self._lock:
            now_s = float(self._clock())
            clauses: list[str] = []
            complaint = _newest(self._recent_locked(kinds=_COMPLAINT_KINDS, limit=1))
            if complaint is not None:
                clauses.append(_complaint_clause(complaint, now_s=now_s))
            alert = _newest(self._recent_locked(kinds=_ALERT_KINDS, limit=1))
            if alert is not None:
                clauses.append(_alert_clause(alert, now_s=now_s))

        if not clauses:
            return None
        while len(clauses) > 1 and len(_join_clauses(clauses)) > max_chars:
            clauses.pop()
        text = _join_clauses(clauses)[:max_chars]
        return text if len(text) > len(_SUMMARY_PREFIX) else None

    def _recent_locked(
        self,
        *,
        kinds: frozenset[MemoryEventKind] | None,
        limit: int,
    ) -> tuple[MemoryEvent, ...]:
        """Caller must already hold ``self._lock`` (the lock is not reentrant)."""

        if limit <= 0:
            return ()
        selected: list[MemoryEvent] = []
        for event in reversed(self._events):
            if kinds is not None and event.kind not in kinds:
                continue
            selected.append(event)
            if len(selected) >= limit:
                break
        return tuple(selected)

    def _persist_locked(self) -> None:
        """Atomic best-effort save; any OSError stays inside this method."""

        path = self._path
        if path is None:
            return
        payload: dict[str, object] = {
            "schema_version": MEMORY_SCHEMA_VERSION,
            "events": [
                {
                    "recorded_at_s": event.recorded_at_s,
                    "kind": event.kind.value,
                    "scene_id": event.scene_id,
                    "detail": event.detail,
                }
                for event in self._events
            ],
            "baselines": [
                {
                    "hour": baseline.hour,
                    "samples": baseline.samples,
                    "restlessness_ewma": baseline.restlessness_ewma,
                    "longest_still_ewma_ms": baseline.longest_still_ewma_ms,
                }
                for baseline in sorted(self._baselines.values(), key=_baseline_hour)
            ],
        }
        if self._persist_queue is not None:
            self._persist_queue.put(payload)
            return
        _write_payload(path, payload)


def _write_payload(path: Path, payload: dict[str, object]) -> None:
    """Atomic best-effort write; any OSError stays inside this function."""

    temporary = path.with_name(path.name + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        os.replace(temporary, path)
    except OSError as exc:
        # A dead disk must never take the care decision down with it.
        _warn(f"behavior memory write to {path} failed: {exc}")
        with contextlib.suppress(OSError):
            temporary.unlink(missing_ok=True)


def _warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)


def _baseline_hour(baseline: HourBaseline) -> int:
    return baseline.hour


def _validated_hour(local_hour: int) -> int:
    if not 0 <= local_hour <= 23:
        raise ValueError(f"local_hour must be within 0..23, got {local_hour}")
    return local_hour


def _fold_ewma(previous: float, sample: float) -> float:
    return DEFAULT_EWMA_ALPHA * float(sample) + (1.0 - DEFAULT_EWMA_ALPHA) * previous


def _newest(events: tuple[MemoryEvent, ...]) -> MemoryEvent | None:
    return events[0] if events else None


def _join_clauses(clauses: list[str]) -> str:
    return _SUMMARY_PREFIX + _SUMMARY_JOIN.join(clauses)


def _relative_day_zh(recorded_at_s: float, *, now_s: float) -> str:
    """Coarse, non-committal day distance; future stamps read as 今天."""

    elapsed_s = now_s - recorded_at_s
    if elapsed_s < _SECONDS_PER_DAY:
        return "今天"
    if elapsed_s < 2.0 * _SECONDS_PER_DAY:
        return "昨天"
    return f"{int(elapsed_s // _SECONDS_PER_DAY)}天前"


def _complaint_clause(event: MemoryEvent, *, now_s: float) -> str:
    when = _relative_day_zh(event.recorded_at_s, now_s=now_s)
    detail = (event.detail or "").strip()
    if not detail:
        return f"{when}曾有主诉记录"
    return f"{when}曾主诉：{detail}"


def _alert_clause(event: MemoryEvent, *, now_s: float) -> str:
    when = _relative_day_zh(event.recorded_at_s, now_s=now_s)
    return f"{when}{_ALERT_PHRASES[event.kind]}"


def _load_state(path: Path) -> tuple[list[MemoryEvent], dict[int, HourBaseline]] | None:
    """Read persisted state; ``None`` means "start empty" (absent/unreadable/foreign)."""

    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError) as exc:
        _warn(f"behavior memory read from {path} failed: {exc}; starting empty")
        return None

    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise _CorruptMemoryError("payload is not a JSON object")
        version = payload.get("schema_version")
        if version != MEMORY_SCHEMA_VERSION:
            raise _CorruptMemoryError(f"unsupported schema_version {version!r}")
        events = _parse_events(payload.get("events"))
        baselines = _parse_baselines(payload.get("baselines"))
    except (ValueError, _CorruptMemoryError) as exc:
        _warn(f"behavior memory at {path} unusable ({exc}); starting empty")
        return None
    return events, baselines


def _parse_events(value: object) -> list[MemoryEvent]:
    if not isinstance(value, list):
        raise _CorruptMemoryError("events must be a list")
    events: list[MemoryEvent] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise _CorruptMemoryError(f"events[{index}] must be an object")
        try:
            recorded_at_s = float(item["recorded_at_s"])
            kind = MemoryEventKind(item["kind"])
            scene_id = item["scene_id"]
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            raise _CorruptMemoryError(f"events[{index}] is malformed: {exc}") from exc
        if not math.isfinite(recorded_at_s):
            raise _CorruptMemoryError(f"events[{index}].recorded_at_s must be finite")
        detail = item.get("detail")
        if not isinstance(scene_id, str):
            raise _CorruptMemoryError(f"events[{index}].scene_id must be a string")
        if detail is not None and not isinstance(detail, str):
            raise _CorruptMemoryError(f"events[{index}].detail must be a string or null")
        events.append(
            MemoryEvent(recorded_at_s=recorded_at_s, kind=kind, scene_id=scene_id, detail=detail)
        )
    return events[-MAX_EVENTS:]


def _parse_baselines(value: object) -> dict[int, HourBaseline]:
    if not isinstance(value, list):
        raise _CorruptMemoryError("baselines must be a list")
    baselines: dict[int, HourBaseline] = {}
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise _CorruptMemoryError(f"baselines[{index}] must be an object")
        hour = item.get("hour")
        samples = item.get("samples")
        if isinstance(hour, bool) or not isinstance(hour, int):
            raise _CorruptMemoryError(f"baselines[{index}].hour must be an integer")
        if isinstance(samples, bool) or not isinstance(samples, int):
            raise _CorruptMemoryError(f"baselines[{index}].samples must be an integer")
        try:
            restlessness_ewma = float(item["restlessness_ewma"])
            longest_still_ewma_ms = float(item["longest_still_ewma_ms"])
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            raise _CorruptMemoryError(f"baselines[{index}] is malformed: {exc}") from exc
        if not 0 <= hour <= 23:
            raise _CorruptMemoryError(f"baselines[{index}].hour out of range: {hour}")
        if samples < 1:
            raise _CorruptMemoryError(f"baselines[{index}].samples must be positive")
        if not (math.isfinite(restlessness_ewma) and math.isfinite(longest_still_ewma_ms)):
            raise _CorruptMemoryError(f"baselines[{index}] carries a non-finite ewma")
        if restlessness_ewma < 0.0 or longest_still_ewma_ms < 0.0:
            raise _CorruptMemoryError(f"baselines[{index}] carries a negative ewma")
        baselines[hour] = HourBaseline(
            hour=hour,
            samples=samples,
            restlessness_ewma=restlessness_ewma,
            longest_still_ewma_ms=longest_still_ewma_ms,
        )
    return baselines
