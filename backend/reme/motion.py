"""Derived motion-data contracts and the first transparent demo heuristic."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

from reme.contracts import EventCandidate, EventType


@dataclass(frozen=True, slots=True)
class MotionObservation:
    """One normalized observation from an offline motion-data source."""

    offset_ms: int
    torso_angle_deg: float
    center_y: float
    visibility: float

    def __post_init__(self) -> None:
        if self.offset_ms < 0:
            raise ValueError("offset_ms must be non-negative")
        if not 0.0 <= self.torso_angle_deg <= 180.0:
            raise ValueError("torso_angle_deg must be between 0 and 180")
        if not 0.0 <= self.center_y <= 1.0:
            raise ValueError("center_y must be normalized between 0 and 1")
        if not 0.0 <= self.visibility <= 1.0:
            raise ValueError("visibility must be between 0 and 1")


@dataclass(frozen=True, slots=True)
class FallHeuristic:
    """Explicit thresholds for a demo fall-like transition, not a clinical detector."""

    minimum_visibility: float = 0.60
    upright_max_angle_deg: float = 35.0
    horizontal_min_angle_deg: float = 65.0
    minimum_angle_change_deg: float = 55.0
    minimum_center_drop: float = 0.18
    minimum_transition_ms: int = 250
    maximum_transition_ms: int = 2500


DEFAULT_FALL_HEURISTIC = FallHeuristic()


def detect_fall_like_event(
    observations: Sequence[MotionObservation],
    *,
    started_at: datetime,
    heuristic: FallHeuristic = DEFAULT_FALL_HEURISTIC,
) -> EventCandidate | None:
    """Return the first worked fall-like transition in a motion sequence."""

    if started_at.tzinfo is None or started_at.utcoffset() is None:
        raise ValueError("started_at must be timezone-aware")

    ordered = tuple(sorted(observations, key=lambda observation: observation.offset_ms))
    for start_index, start in enumerate(ordered):
        if start.visibility < heuristic.minimum_visibility:
            continue
        if start.torso_angle_deg > heuristic.upright_max_angle_deg:
            continue

        for end in ordered[start_index + 1 :]:
            transition_ms = end.offset_ms - start.offset_ms
            if transition_ms > heuristic.maximum_transition_ms:
                break
            if transition_ms < heuristic.minimum_transition_ms:
                continue
            if end.visibility < heuristic.minimum_visibility:
                continue
            if end.torso_angle_deg < heuristic.horizontal_min_angle_deg:
                continue

            angle_change = end.torso_angle_deg - start.torso_angle_deg
            center_drop = end.center_y - start.center_y
            if angle_change < heuristic.minimum_angle_change_deg:
                continue
            if center_drop < heuristic.minimum_center_drop:
                continue

            minimum_visibility = min(start.visibility, end.visibility)
            evidence_score = round(
                (
                    min(angle_change / 90.0, 1.0)
                    + min(center_drop / 0.40, 1.0)
                    + minimum_visibility
                )
                / 3.0,
                3,
            )
            return EventCandidate(
                event_type=EventType.POSSIBLE_FALL,
                confidence=evidence_score,
                observed_at=started_at + timedelta(milliseconds=end.offset_ms),
                duration_ms=transition_ms,
                features={
                    "angle_change_deg": round(angle_change, 4),
                    "center_drop": round(center_drop, 4),
                    "minimum_visibility": round(minimum_visibility, 4),
                    "transition_ms": float(transition_ms),
                },
            )

    return None


def has_insufficient_motion_data(
    observations: Sequence[MotionObservation],
    *,
    minimum_visibility: float,
) -> bool:
    """Identify sequences that cannot support a reliable pose transition decision."""

    visible_count = sum(
        observation.visibility >= minimum_visibility for observation in observations
    )
    return len(observations) < 2 or visible_count < 2
