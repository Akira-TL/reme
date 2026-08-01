"""Whole-home context: time, room, and ambient signals as decision context.

Our own generic abstraction — no vendor protocol, no third-party code.  The
same posture means different things in different home contexts (lying in
the bedroom at 02:00 is sleep; lying on the bathroom floor at 02:00 is an
emergency), so :class:`HomeContext` both feeds MiMo prompts and modulates
the deterministic thresholds within hard safety bounds: fall rules and
timeouts are never relaxed (ADR-0006).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Protocol

from reme.decision.guardrails import TriggerConfig

HOME_SCHEMA_VERSION = "reme-home-context/v0-experiment"
NIGHT_HOURS = frozenset({22, 23, 0, 1, 2, 3, 4, 5})

# adjust_trigger_config clamp band for long_still_min_ms scaling.
MIN_STILL_SCALE = 0.5
MAX_STILL_SCALE = 3.0


class HomeScriptError(ValueError):
    """Raised when a home-context timeline file violates its schema."""


class RoomLabel(StrEnum):
    """Coarse room semantics; UNKNOWN keeps every rule at its neutral base."""

    LIVING_ROOM = "living_room"
    BEDROOM = "bedroom"
    BATHROOM = "bathroom"
    KITCHEN = "kitchen"
    HALLWAY = "hallway"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class HomeContext:
    """One home-state snapshot aligned to a scene timestamp."""

    local_hour: int | None
    room: RoomLabel
    is_night: bool
    ambient: Mapping[str, str]


class HomeContextProvider(Protocol):
    """Where the decision layer asks what the home looks like right now."""

    def context_at(self, scene_id: str, timestamp_ms: float) -> HomeContext: ...


@dataclass(frozen=True, slots=True)
class StaticHomeProvider:
    """The same context for every timestamp (CLI flags / simplest demo)."""

    context: HomeContext

    def context_at(self, scene_id: str, timestamp_ms: float) -> HomeContext:
        raise NotImplementedError("L3 泳道实现")


class ScriptedHomeProvider:
    """Timeline segments loaded from a home_context.jsonl demo script."""

    def __init__(self, segments: tuple[tuple[float, HomeContext], ...]) -> None:
        raise NotImplementedError("L3 泳道实现")

    @classmethod
    def load(cls, path: str | Path) -> ScriptedHomeProvider:
        """Parse a strict JSONL timeline (rows sorted by from_ms)."""

        raise NotImplementedError("L3 泳道实现")

    def context_at(self, scene_id: str, timestamp_ms: float) -> HomeContext:
        raise NotImplementedError("L3 泳道实现")


def default_home_context() -> HomeContext:
    """UNKNOWN room, no hour, ambient empty — modulates nothing."""

    raise NotImplementedError("L3 泳道实现")


def adjust_trigger_config(base: TriggerConfig, home: HomeContext) -> TriggerConfig:
    """Bounded, deterministic modulation of the concern thresholds.

    - ``long_still_min_ms`` scales inside [MIN_STILL_SCALE, MAX_STILL_SCALE]:
      bedroom night sleep earns a longer leash, a bathroom a shorter one.
    - The bathroom adds LYING to the concern postures (a lying body on a
      bathroom floor deserves a check-in even without a fall hypothesis).
    - ``fall_confidence_min``, both timeouts, rewind tolerance and privacy
      are untouchable — safety never loosens with context.
    """

    raise NotImplementedError("L3 泳道实现")


def home_summary_zh(home: HomeContext) -> str:
    """Compact Chinese environment line for prompt injection."""

    raise NotImplementedError("L3 泳道实现")
