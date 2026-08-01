"""Longitudinal behavior memory: baselines, event history, deviation.

B-private store: it consumes only what the decision layer already holds
(behavior windows plus emitted-decision milestones) and feeds compact
Chinese summaries back into MiMo prompts.  Memory adds context and may
tighten attention; it never relaxes a deterministic escalation — the
guardrails remain the only escalation owner (ADR-0005 / ADR-0006).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from reme.decision.behavior import BehaviorFeatures

MEMORY_SCHEMA_VERSION = "reme-behavior-memory/v0-experiment"
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


class BehaviorMemoryStore:
    """Thread-safe per-elder memory with atomic JSON persistence.

    Storage failures never propagate into the decision path (audit-style
    OSError tolerance); a missing or corrupt file simply starts empty.
    ``path=None`` keeps the store purely in-memory.
    """

    def __init__(self, path: Path | None, *, clock: Callable[[], float]) -> None:
        raise NotImplementedError("L2 泳道实现")

    def record_event(
        self, kind: MemoryEventKind, *, scene_id: str, detail: str | None = None
    ) -> None:
        """Append one milestone (trimmed to MAX_EVENTS, newest kept) and persist."""

        raise NotImplementedError("L2 泳道实现")

    def observe(self, features: BehaviorFeatures, *, local_hour: int) -> None:
        """Fold one behavior window into that hour's baseline and persist."""

        raise NotImplementedError("L2 泳道实现")

    def deviation(self, features: BehaviorFeatures, *, local_hour: int) -> float | None:
        """今天此时段静止时长相对基线的比值；样本不足 MIN_BASELINE_SAMPLES 时 None。"""

        raise NotImplementedError("L2 泳道实现")

    def recent_events(
        self,
        *,
        kinds: frozenset[MemoryEventKind] | None = None,
        limit: int = 5,
    ) -> tuple[MemoryEvent, ...]:
        """Newest-first milestones, optionally filtered by kind."""

        raise NotImplementedError("L2 泳道实现")

    def summary_zh(self, *, local_hour: int | None, max_chars: int = 160) -> str | None:
        """Compact Chinese memory digest for prompts; None when nothing to say."""

        raise NotImplementedError("L2 泳道实现")
