"""Stable contracts between perception and decision components."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any


class EventType(StrEnum):
    """Event hypotheses currently in scope for the MVP."""

    POSSIBLE_FALL = "possible_fall"
    PROLONGED_INACTIVITY = "prolonged_inactivity"


@dataclass(frozen=True, slots=True)
class EventCandidate:
    """A perception hypothesis, not an emergency declaration."""

    event_type: EventType
    confidence: float
    observed_at: datetime
    duration_ms: int = 0
    features: dict[str, float] = field(default_factory=dict)
    schema_version: str = "0.1"

    def __post_init__(self) -> None:
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("confidence must be between 0.0 and 1.0")
        if self.duration_ms < 0:
            raise ValueError("duration_ms must be non-negative")
        if self.observed_at.tzinfo is None or self.observed_at.utcoffset() is None:
            raise ValueError("observed_at must be timezone-aware")

    def to_payload(self) -> dict[str, Any]:
        """Return a JSON-serializable payload for the decision agent."""

        return {
            "schema_version": self.schema_version,
            "event_type": self.event_type.value,
            "confidence": self.confidence,
            "observed_at": self.observed_at.isoformat(),
            "duration_ms": self.duration_ms,
            "features": dict(self.features),
        }
