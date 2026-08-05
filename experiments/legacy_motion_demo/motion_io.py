"""Read derived human-motion observations from exchange files."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from experiments.legacy_motion_demo.motion import MotionObservation


class MotionDataError(ValueError):
    """Raised when a motion-data file cannot be mapped to the public contract."""


def load_motion_jsonl(path: Path) -> list[MotionObservation]:
    """Load one normalized motion observation per JSONL line."""

    observations: list[MotionObservation] = []
    with path.open(encoding="utf-8") as source:
        for line_number, raw_line in enumerate(source, start=1):
            line = raw_line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
                observations.append(_observation_from_payload(payload))
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
                raise MotionDataError(
                    f"invalid motion observation at line {line_number}: {error}"
                ) from error
    return observations


def _observation_from_payload(payload: Any) -> MotionObservation:
    if not isinstance(payload, dict):
        raise TypeError("each JSONL line must be an object")

    required_fields = (
        "offset_ms",
        "torso_angle_deg",
        "center_y",
        "visibility",
    )
    missing_fields = [field for field in required_fields if field not in payload]
    if missing_fields:
        raise KeyError(", ".join(missing_fields))

    return MotionObservation(
        offset_ms=_as_int(payload["offset_ms"], field="offset_ms"),
        torso_angle_deg=_as_float(
            payload["torso_angle_deg"], field="torso_angle_deg"
        ),
        center_y=_as_float(payload["center_y"], field="center_y"),
        visibility=_as_float(payload["visibility"], field="visibility"),
    )


def _as_int(value: Any, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field} must be an integer")
    return value


def _as_float(value: Any, *, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{field} must be a number")
    return float(value)
