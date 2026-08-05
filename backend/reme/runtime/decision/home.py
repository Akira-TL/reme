"""Whole-home context: time, room, and ambient signals as decision context.

Our own generic abstraction — no vendor protocol, no third-party code.  The
same posture means different things in different home contexts (lying in
the bedroom at 02:00 is sleep; lying on the bathroom floor at 02:00 is an
emergency), so :class:`HomeContext` both feeds MiMo prompts and modulates
the deterministic thresholds within hard safety bounds: fall rules and
timeouts are never relaxed (ADR-0006).
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path
from types import MappingProxyType
from typing import Any, Protocol

from reme.runtime.decision.context import Posture
from reme.runtime.decision.guardrails import TriggerConfig

HOME_SCHEMA_VERSION = "reme-home-context/v0-experiment"
NIGHT_HOURS = frozenset({22, 23, 0, 1, 2, 3, 4, 5})

# adjust_trigger_config clamp band for long_still_min_ms scaling.
# The *direction* of each adjustment is defensible (a bathroom floor is where
# "long lie" harm concentrates — R3 Fleming & Brayne 2008; a bed at night is
# where stillness is expected), but the multipliers themselves have NO
# literature backing: they are demo-tuned values, deliberately clamped so no
# context can loosen a rule beyond this band.  See
# docs/references/cognition-evidence.md.
MIN_STILL_SCALE = 0.5
MAX_STILL_SCALE = 3.0

_EMPTY_AMBIENT: Mapping[str, str] = MappingProxyType({})


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
        return self.context


def _parse_from_ms(value: object, *, label: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or not math.isfinite(float(value))
        or value < 0
    ):
        raise HomeScriptError(
            f"{label}: from_ms must be a finite non-negative number, got {value!r}"
        )
    return float(value)


def _parse_room(value: object, *, label: str) -> RoomLabel:
    for member in RoomLabel:
        if value == member.value:
            return member
    allowed = [member.value for member in RoomLabel]
    raise HomeScriptError(f"{label}: room must be one of {allowed}, got {value!r}")


def _parse_local_hour(value: object, *, label: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 23:
        raise HomeScriptError(
            f"{label}: local_hour must be an integer within 0..23 or null, got {value!r}"
        )
    return value


def _parse_is_night(payload: dict[str, Any], *, local_hour: int | None, label: str) -> bool:
    if "is_night" not in payload:
        return local_hour is not None and local_hour in NIGHT_HOURS
    value = payload["is_night"]
    if not isinstance(value, bool):
        raise HomeScriptError(f"{label}: is_night must be a boolean, got {value!r}")
    return value


def _parse_ambient(value: object, *, label: str) -> Mapping[str, str]:
    if not isinstance(value, dict):
        raise HomeScriptError(f"{label}: ambient must be an object")
    ambient: dict[str, str] = {}
    for key, entry in value.items():
        if not isinstance(key, str) or not isinstance(entry, str):
            raise HomeScriptError(f"{label}: ambient entries must map strings to strings")
        ambient[key] = entry
    return MappingProxyType(ambient)


def _parse_segment(payload: dict[str, Any], *, label: str) -> tuple[float, HomeContext]:
    schema_version = payload.get("schema_version", HOME_SCHEMA_VERSION)
    if schema_version != HOME_SCHEMA_VERSION:
        raise HomeScriptError(
            f"{label}: schema_version must be {HOME_SCHEMA_VERSION!r}, got {schema_version!r}"
        )
    from_ms = _parse_from_ms(payload.get("from_ms"), label=label)
    local_hour = _parse_local_hour(payload.get("local_hour"), label=label)
    context = HomeContext(
        local_hour=local_hour,
        room=_parse_room(payload.get("room"), label=label),
        is_night=_parse_is_night(payload, local_hour=local_hour, label=label),
        ambient=_parse_ambient(payload.get("ambient", {}), label=label),
    )
    return from_ms, context


class ScriptedHomeProvider:
    """Timeline segments loaded from a home_context.jsonl demo script."""

    __slots__ = ("_segments",)

    def __init__(self, segments: tuple[tuple[float, HomeContext], ...]) -> None:
        previous: float | None = None
        for index, (from_ms, _context) in enumerate(segments):
            if not math.isfinite(from_ms) or from_ms < 0:
                raise HomeScriptError(f"segment {index}: from_ms must be finite and non-negative")
            if previous is not None and from_ms <= previous:
                raise HomeScriptError(f"segment {index}: from_ms must be strictly ascending")
            previous = from_ms
        self._segments: tuple[tuple[float, HomeContext], ...] = tuple(segments)

    @classmethod
    def load(cls, path: str | Path) -> ScriptedHomeProvider:
        """Parse a strict JSONL timeline (rows sorted by from_ms)."""

        script_path = Path(path)
        try:
            text = script_path.read_text(encoding="utf-8")
        except OSError as exc:
            raise HomeScriptError(f"cannot read home script {script_path.name}: {exc}") from exc
        segments: list[tuple[float, HomeContext]] = []
        for line_number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            label = f"{script_path.name} line {line_number}"
            try:
                payload = json.loads(line)
            except json.JSONDecodeError as exc:
                raise HomeScriptError(f"{label} is not valid JSON") from exc
            if not isinstance(payload, dict):
                raise HomeScriptError(f"{label} must be a JSON object")
            from_ms, context = _parse_segment(payload, label=label)
            if segments and from_ms <= segments[-1][0]:
                raise HomeScriptError(f"{label}: from_ms must be strictly ascending")
            segments.append((from_ms, context))
        return cls(tuple(segments))

    def context_at(self, scene_id: str, timestamp_ms: float) -> HomeContext:
        current = default_home_context()
        for from_ms, context in self._segments:
            if from_ms > timestamp_ms:
                break
            current = context
        return current


def default_home_context() -> HomeContext:
    """UNKNOWN room, no hour, ambient empty — modulates nothing."""

    return HomeContext(
        local_hour=None,
        room=RoomLabel.UNKNOWN,
        is_night=False,
        ambient=_EMPTY_AMBIENT,
    )


def adjust_trigger_config(base: TriggerConfig, home: HomeContext) -> TriggerConfig:
    """Bounded, deterministic modulation of the concern thresholds.

    - ``long_still_min_ms`` scales inside [MIN_STILL_SCALE, MAX_STILL_SCALE]:
      bedroom night sleep earns a longer leash, a bathroom a shorter one.
    - The bathroom adds LYING to the concern postures (a lying body on a
      bathroom floor deserves a check-in even without a fall hypothesis).
    - ``fall_confidence_min``, both timeouts, rewind tolerance and privacy
      are untouchable — safety never loosens with context.
    """

    scale = _clamp_still_scale(_raw_still_scale(home))
    concern_postures = base.concern_postures
    if home.room is RoomLabel.BATHROOM:
        concern_postures = concern_postures | {Posture.LYING}
    return replace(
        base,
        long_still_min_ms=base.long_still_min_ms * scale,
        concern_postures=concern_postures,
    )


def _raw_still_scale(home: HomeContext) -> float:
    """Deterministic lookup table, before the hard clamp."""

    if home.room is RoomLabel.BATHROOM:
        return 0.5
    if home.room is RoomLabel.BEDROOM and home.is_night:
        return 3.0
    if home.is_night:
        return 0.75
    return 1.0


def _clamp_still_scale(scale: float) -> float:
    """Keep every table entry inside the sanctioned band, whatever it claims."""

    return min(max(scale, MIN_STILL_SCALE), MAX_STILL_SCALE)


_ROOM_ZH: Mapping[RoomLabel, str] = MappingProxyType(
    {
        RoomLabel.LIVING_ROOM: "客厅",
        RoomLabel.BEDROOM: "卧室",
        RoomLabel.BATHROOM: "卫生间",
        RoomLabel.KITCHEN: "厨房",
        RoomLabel.HALLWAY: "走廊",
        RoomLabel.UNKNOWN: "位置未知",
    }
)

# Inclusive hour bands covering 0..23, in reading order.
_HOUR_PERIODS_ZH: tuple[tuple[int, int, str], ...] = (
    (0, 5, "凌晨"),
    (6, 11, "上午"),
    (12, 17, "下午"),
    (18, 21, "晚上"),
    (22, 23, "深夜"),
)


def _hour_zh(hour: int) -> str:
    """Period word plus a 12-hour clock number, e.g. 15 -> 下午3点."""

    for low, high, period in _HOUR_PERIODS_ZH:
        if low <= hour <= high:
            return f"{period}{hour % 12 or 12}点"
    return f"{hour}点"


def home_summary_zh(home: HomeContext) -> str:
    """Compact Chinese environment line for prompt injection."""

    parts: list[str] = []
    if home.local_hour is not None:
        parts.append(_hour_zh(home.local_hour))
    parts.append(_ROOM_ZH.get(home.room, "位置未知"))
    parts.extend(f"{key}:{home.ambient[key]}" for key in sorted(home.ambient))
    return "环境：" + "，".join(parts)
