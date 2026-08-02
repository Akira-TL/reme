"""Convert FrameLandmarks RuntimeEvents into low-frequency PostureObservations."""

from __future__ import annotations

import math
from collections import defaultdict, deque
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np

from reme.pose.posture import PosturePrediction
from reme.pose.runtime import RuntimeEvent, RuntimeEventType, RuntimeSessionError

POSTURE_SCHEMA_VERSION = "reme-posture/v0-experiment"
MOTION_LEVELS = ("still", "low", "medium", "high", "unknown")


class PostureRuntimeError(ValueError):
    """Raised when a live posture event cannot be produced safely."""


class PosturePredictor(Protocol):
    """Minimal inference seam used by the live posture tracker."""

    def predict_record(self, record: dict[str, Any]) -> PosturePrediction: ...


@dataclass(frozen=True, slots=True)
class PostureRuntimeConfig:
    """Output cadence, smoothing, and motion thresholds for live posture."""

    output_hz: float = 7.5
    smoothing_window: int = 5
    score_threshold: float = 0.2
    still_speed: float = 0.03
    low_speed: float = 0.12
    medium_speed: float = 0.35

    def __post_init__(self) -> None:
        if not 5.0 <= self.output_hz <= 10.0:
            raise PostureRuntimeError("output_hz must be between 5 and 10")
        if self.smoothing_window < 1:
            raise PostureRuntimeError("smoothing_window must be positive")
        if not 0.0 <= self.score_threshold <= 1.0:
            raise PostureRuntimeError("score_threshold must be between 0 and 1")
        if not 0 <= self.still_speed < self.low_speed < self.medium_speed:
            raise PostureRuntimeError("motion thresholds must be strictly increasing")


class RealtimePostureTracker:
    """Stateful per-session posture classifier and duration tracker."""

    def __init__(
        self,
        *,
        session_id: str,
        predictor: PosturePredictor,
        config: PostureRuntimeConfig | None = None,
    ) -> None:
        if not isinstance(session_id, str) or not session_id.strip():
            raise PostureRuntimeError("session_id must be non-empty")
        self.session_id = session_id
        self.predictor = predictor
        self.config = config or PostureRuntimeConfig()
        self._history: deque[PosturePrediction] = deque(
            maxlen=self.config.smoothing_window
        )
        self._last_emit_ms: float | None = None
        self._last_emitted_frame: dict[str, Any] | None = None
        self._current_posture: str | None = None
        self._posture_since_ms = 0.0

    def reset(self) -> None:
        """Clear all state for a replacement session."""

        self._history.clear()
        self._last_emit_ms = None
        self._last_emitted_frame = None
        self._current_posture = None
        self._posture_since_ms = 0.0

    def process_frame_event(self, event: RuntimeEvent) -> RuntimeEvent | None:
        """Return a PostureObservation when the configured cadence is due."""

        try:
            event.require_session(self.session_id)
        except RuntimeSessionError as exc:
            raise PostureRuntimeError(str(exc)) from exc
        if event.event_type is not RuntimeEventType.FRAME_LANDMARKS:
            raise PostureRuntimeError("posture tracker accepts only FrameLandmarks events")
        payload = event.payload
        timestamp_ms = _number(payload.get("timestamp_ms"), "timestamp_ms")
        frame_index = _integer(payload.get("frame_index"), "frame_index")
        scene_id = _text(payload.get("scene_id"), "scene_id")
        interval_ms = 1000.0 / self.config.output_hz
        if (
            self._last_emit_ms is not None
            and timestamp_ms - self._last_emit_ms < interval_ms - 1e-6
        ):
            return None

        prediction = self.predictor.predict_record(payload)
        posture, confidence = self._smooth_prediction(prediction)
        if posture != self._current_posture:
            self._current_posture = posture
            self._posture_since_ms = timestamp_ms
        duration_ms = max(timestamp_ms - self._posture_since_ms, 0.0)
        motion_level = _motion_level(
            self._last_emitted_frame,
            payload,
            score_threshold=self.config.score_threshold,
            still_speed=self.config.still_speed,
            low_speed=self.config.low_speed,
            medium_speed=self.config.medium_speed,
        )
        observation = {
            "schema_version": POSTURE_SCHEMA_VERSION,
            "scene_id": scene_id,
            "timestamp_ms": round(timestamp_ms, 3),
            "frame_index": frame_index,
            "person_detected": bool(payload.get("person_detected")),
            "posture": posture,
            "posture_confidence": round(confidence, 6),
            "posture_duration_ms": round(duration_ms, 3),
            "motion_level": motion_level,
            "visible_keypoint_ratio": prediction.visible_keypoint_ratio,
            "classification_source": getattr(
                prediction, "classification_source", "unspecified"
            ),
            "landmark_quality": _landmark_quality(payload.get("landmark_quality")),
        }
        self._last_emit_ms = timestamp_ms
        self._last_emitted_frame = payload
        return RuntimeEvent(
            session_id=self.session_id,
            sequence=event.sequence,
            event_type=RuntimeEventType.POSTURE_OBSERVATION,
            payload=observation,
        )

    def iter_events(self, events: Iterable[RuntimeEvent]) -> Iterator[RuntimeEvent]:
        """Yield low-frequency posture observations for a frame-event stream."""

        for event in events:
            observation = self.process_frame_event(event)
            if observation is not None:
                yield observation

    def _smooth_prediction(self, prediction: PosturePrediction) -> tuple[str, float]:
        if prediction.posture == "unknown":
            self._history.clear()
            return "unknown", prediction.confidence
        self._history.append(prediction)
        scores: dict[str, float] = defaultdict(float)
        counts: dict[str, int] = defaultdict(int)
        confidence_sums: dict[str, float] = defaultdict(float)
        for item in self._history:
            scores[item.posture] += max(item.confidence, 1e-6)
            counts[item.posture] += 1
            confidence_sums[item.posture] += item.confidence
        winner = max(scores, key=lambda label: (scores[label], counts[label], label))
        average_confidence = confidence_sums[winner] / counts[winner]
        agreement = counts[winner] / len(self._history)
        return winner, min(max(average_confidence * agreement, 0.0), 1.0)


def _motion_level(
    previous: dict[str, Any] | None,
    current: dict[str, Any],
    *,
    score_threshold: float,
    still_speed: float,
    low_speed: float,
    medium_speed: float,
) -> str:
    if previous is None:
        return "unknown"
    if not bool(previous.get("person_detected")) or not bool(current.get("person_detected")):
        return "unknown"
    previous_timestamp = _number(previous.get("timestamp_ms"), "previous.timestamp_ms")
    current_timestamp = _number(current.get("timestamp_ms"), "current.timestamp_ms")
    elapsed_seconds = (current_timestamp - previous_timestamp) / 1000.0
    if elapsed_seconds <= 0:
        return "unknown"
    previous_points = _point_map(previous, score_threshold=score_threshold)
    current_points = _point_map(current, score_threshold=score_threshold)
    common = sorted(previous_points.keys() & current_points.keys())
    if len(common) < 4:
        return "unknown"
    displacements = [
        math.dist(previous_points[name], current_points[name]) / elapsed_seconds
        for name in common
    ]
    speed = float(np.median(np.asarray(displacements, dtype=np.float64)))
    if speed < still_speed:
        return "still"
    if speed < low_speed:
        return "low"
    if speed < medium_speed:
        return "medium"
    return "high"


def _point_map(record: dict[str, Any], *, score_threshold: float) -> dict[str, tuple[float, float]]:
    raw_points = record.get("keypoints")
    if not isinstance(raw_points, list):
        raise PostureRuntimeError("keypoints must be an array")
    points: dict[str, tuple[float, float]] = {}
    for index, item in enumerate(raw_points):
        if not isinstance(item, dict):
            raise PostureRuntimeError(f"keypoints[{index}] must be an object")
        name = _text(item.get("name"), f"keypoints[{index}].name")
        score = _number(item.get("score"), f"keypoints[{index}].score")
        if score < score_threshold:
            continue
        x_norm = _number(item.get("x_norm"), f"keypoints[{index}].x_norm")
        y_norm = _number(item.get("y_norm"), f"keypoints[{index}].y_norm")
        points[name] = (x_norm, y_norm)
    return points


def _landmark_quality(value: object) -> str:
    if value not in ("usable", "degraded", "unavailable"):
        raise PostureRuntimeError("landmark_quality is invalid")
    return str(value)


def _text(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PostureRuntimeError(f"{field_name} must be a non-empty string")
    return value.strip()


def _integer(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise PostureRuntimeError(f"{field_name} must be a non-negative integer")
    return value


def _number(value: object, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise PostureRuntimeError(f"{field_name} must be numeric")
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise PostureRuntimeError(f"{field_name} must be finite and non-negative")
    return number
