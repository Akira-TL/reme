"""Deterministic temporal transition candidates from pose landmark streams."""

from __future__ import annotations

import math
from collections import Counter, deque
from dataclasses import dataclass
from statistics import median
from typing import Any

from reme.pose.annotations import POSTURE_LABELS, TRANSITION_LABELS
from reme.pose.runtime import RuntimeEvent, RuntimeEventType, RuntimeSessionError

TRANSITION_SCHEMA_VERSION = "reme-transition/v0-experiment"
POSTURE_SCHEMA_VERSION = "reme-posture/v0-experiment"
FRAME_LANDMARKS_SCHEMA_VERSION = "movenet-17/v0-experiment"
LANDMARK_QUALITIES = ("usable", "degraded", "unavailable")
MOTION_LEVELS = ("still", "low", "medium", "high", "unknown")
_REQUIRED_TORSO_POINTS = (
    "left_shoulder",
    "right_shoulder",
    "left_hip",
    "right_hip",
)


class TransitionError(ValueError):
    """Raised when transition input violates the temporal interface."""


@dataclass(frozen=True, slots=True)
class TransitionDetectorConfig:
    """Explicit temporal window and abstention thresholds."""

    window_ms: float = 3200.0
    min_window_ms: float = 500.0
    max_frame_gap_ms: float = 500.0
    max_posture_age_ms: float = 600.0
    settle_ms: float = 200.0
    score_threshold: float = 0.2
    min_visible_keypoint_ratio: float = 0.5
    min_center_change: float = 0.06
    min_torso_change_deg: float = 18.0
    min_motion_speed: float = 0.18
    fall_center_drop: float = 0.20
    fall_peak_speed: float = 0.65
    fall_torso_change_deg: float = 45.0
    fall_max_duration_ms: float = 1400.0
    camera_jump_distance: float = 0.18
    camera_jump_residual: float = 0.035
    camera_jump_max_interval_ms: float = 250.0
    cooldown_ms: float = 1600.0

    def __post_init__(self) -> None:
        positive = {
            "window_ms": self.window_ms,
            "min_window_ms": self.min_window_ms,
            "max_frame_gap_ms": self.max_frame_gap_ms,
            "max_posture_age_ms": self.max_posture_age_ms,
            "settle_ms": self.settle_ms,
            "fall_max_duration_ms": self.fall_max_duration_ms,
            "camera_jump_max_interval_ms": self.camera_jump_max_interval_ms,
            "cooldown_ms": self.cooldown_ms,
        }
        for field_name, value in positive.items():
            if not math.isfinite(value) or value <= 0:
                raise TransitionError(f"{field_name} must be finite and positive")
        if self.min_window_ms > self.window_ms:
            raise TransitionError("min_window_ms must not exceed window_ms")
        ratios = {
            "score_threshold": self.score_threshold,
            "min_visible_keypoint_ratio": self.min_visible_keypoint_ratio,
        }
        for field_name, value in ratios.items():
            if not math.isfinite(value) or not 0.0 <= value <= 1.0:
                raise TransitionError(f"{field_name} must be between 0 and 1")
        thresholds = {
            "min_center_change": self.min_center_change,
            "min_torso_change_deg": self.min_torso_change_deg,
            "min_motion_speed": self.min_motion_speed,
            "fall_center_drop": self.fall_center_drop,
            "fall_peak_speed": self.fall_peak_speed,
            "fall_torso_change_deg": self.fall_torso_change_deg,
            "camera_jump_distance": self.camera_jump_distance,
            "camera_jump_residual": self.camera_jump_residual,
        }
        for field_name, value in thresholds.items():
            if not math.isfinite(value) or value < 0:
                raise TransitionError(f"{field_name} must be finite and non-negative")


@dataclass(frozen=True, slots=True)
class TransitionIssue:
    """One source-time interval where no trustworthy event can be claimed."""

    scene_id: str
    start_ms: float
    end_ms: float
    reason: str

    def to_payload(self) -> dict[str, object]:
        """Return a stable JSON representation for offline reports."""

        return {
            "scene_id": self.scene_id,
            "start_ms": round(self.start_ms, 3),
            "end_ms": round(self.end_ms, 3),
            "reason": self.reason,
        }


@dataclass(frozen=True, slots=True)
class TransitionEvent:
    """Shared A/B/C temporal event contract without care-risk semantics."""

    scene_id: str
    event_id: str
    start_ms: float
    end_ms: float
    transition: str
    transition_confidence: float
    evidence: dict[str, object]
    landmark_quality: str
    schema_version: str = TRANSITION_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.transition not in TRANSITION_LABELS:
            raise TransitionError(f"transition must be one of {TRANSITION_LABELS}")
        if self.landmark_quality not in LANDMARK_QUALITIES:
            raise TransitionError("landmark_quality is invalid")
        if not 0.0 <= self.transition_confidence <= 1.0:
            raise TransitionError("transition_confidence must be between 0 and 1")
        if self.end_ms <= self.start_ms:
            raise TransitionError("transition end_ms must be greater than start_ms")

    def to_payload(self) -> dict[str, object]:
        """Return the shared JSON payload consumed by B and C."""

        return {
            "schema_version": self.schema_version,
            "scene_id": self.scene_id,
            "event_id": self.event_id,
            "start_ms": round(self.start_ms, 3),
            "end_ms": round(self.end_ms, 3),
            "transition": self.transition,
            "transition_confidence": round(self.transition_confidence, 6),
            "evidence": dict(self.evidence),
            "landmark_quality": self.landmark_quality,
        }


@dataclass(frozen=True, slots=True)
class _PostureState:
    scene_id: str
    timestamp_ms: float
    posture: str
    posture_duration_ms: float
    motion_level: str
    visible_keypoint_ratio: float
    landmark_quality: str


@dataclass(frozen=True, slots=True)
class _Sample:
    scene_id: str
    timestamp_ms: float
    frame_index: int
    center_y: float
    torso_angle_deg: float
    points: dict[str, tuple[float, float]]
    visible_keypoint_ratio: float
    landmark_quality: str
    posture: str
    posture_duration_ms: float
    motion_level: str


@dataclass(frozen=True, slots=True)
class _WindowEvidence:
    start_ms: float
    end_ms: float
    center_height_change: float
    maximum_center_drop: float
    peak_keypoint_speed: float
    torso_direction_change_deg: float
    maximum_torso_excursion_deg: float
    posture_before: str
    posture_after: str
    intermediate_postures: tuple[str, ...]
    visible_keypoint_ratio: float
    landmark_quality: str

    @property
    def duration_ms(self) -> float:
        return self.end_ms - self.start_ms


class TransitionDetector:
    """Stateful, deterministic transition detector scoped to one runtime session."""

    def __init__(
        self,
        *,
        session_id: str,
        config: TransitionDetectorConfig | None = None,
    ) -> None:
        self.config = config or TransitionDetectorConfig()
        self._set_session_id(session_id)
        self._samples: deque[_Sample] = deque()
        self._latest_posture: _PostureState | None = None
        self._last_frame_timestamp_ms: float | None = None
        self._last_posture_timestamp_ms: float | None = None
        self._event_counter = 0
        self._cooldown_until_ms = -1.0
        self._issues: list[TransitionIssue] = []

    @property
    def issues(self) -> tuple[TransitionIssue, ...]:
        """Return source intervals that were rejected or abstained."""

        return tuple(self._issues)

    def reset(self, *, session_id: str) -> None:
        """Discard all temporal state before accepting a replacement session."""

        self._set_session_id(session_id)
        self._samples.clear()
        self._latest_posture = None
        self._last_frame_timestamp_ms = None
        self._last_posture_timestamp_ms = None
        self._event_counter = 0
        self._cooldown_until_ms = -1.0
        self._issues.clear()

    def process_runtime_event(self, event: RuntimeEvent) -> RuntimeEvent | None:
        """Consume one ordered FrameLandmarks or PostureObservation event."""

        try:
            event.require_session(self.session_id)
        except RuntimeSessionError as exc:
            raise TransitionError(str(exc)) from exc
        if event.event_type is RuntimeEventType.POSTURE_OBSERVATION:
            self.process_posture(event.payload)
            return None
        if event.event_type is not RuntimeEventType.FRAME_LANDMARKS:
            raise TransitionError(
                "transition detector accepts only FrameLandmarks and PostureObservation events"
            )
        transition = self.process_frame(event.payload)
        if transition is None:
            return None
        return RuntimeEvent(
            session_id=self.session_id,
            sequence=event.sequence,
            event_type=RuntimeEventType.TRANSITION_EVENT,
            payload=transition.to_payload(),
        )

    def process_posture(self, payload: dict[str, Any]) -> None:
        """Update the latest static posture context without emitting a care event."""

        if payload.get("schema_version") != POSTURE_SCHEMA_VERSION:
            raise TransitionError(f"posture schema_version must be {POSTURE_SCHEMA_VERSION!r}")
        scene_id = _text(payload.get("scene_id"), "scene_id")
        timestamp_ms = _non_negative_number(payload.get("timestamp_ms"), "timestamp_ms")
        if (
            self._last_posture_timestamp_ms is not None
            and timestamp_ms < self._last_posture_timestamp_ms
        ):
            self._record_issue(
                scene_id=scene_id,
                start_ms=timestamp_ms,
                end_ms=self._last_posture_timestamp_ms,
                reason="timestamp_out_of_order",
            )
            return
        posture = _enum_text(payload.get("posture"), POSTURE_LABELS, "posture")
        posture_duration_ms = _non_negative_number(
            payload.get("posture_duration_ms"), "posture_duration_ms"
        )
        motion_level = _enum_text(payload.get("motion_level"), MOTION_LEVELS, "motion_level")
        visible_keypoint_ratio = _ratio(
            payload.get("visible_keypoint_ratio"), "visible_keypoint_ratio"
        )
        landmark_quality = _enum_text(
            payload.get("landmark_quality"), LANDMARK_QUALITIES, "landmark_quality"
        )
        self._latest_posture = _PostureState(
            scene_id=scene_id,
            timestamp_ms=timestamp_ms,
            posture=posture,
            posture_duration_ms=posture_duration_ms,
            motion_level=motion_level,
            visible_keypoint_ratio=visible_keypoint_ratio,
            landmark_quality=landmark_quality,
        )
        self._last_posture_timestamp_ms = timestamp_ms

    def process_frame(self, payload: dict[str, Any]) -> TransitionEvent | None:
        """Consume one ordered landmark frame and return at most one merged event."""

        if payload.get("schema_version") != FRAME_LANDMARKS_SCHEMA_VERSION:
            raise TransitionError(
                f"frame schema_version must be {FRAME_LANDMARKS_SCHEMA_VERSION!r}"
            )
        scene_id = _text(payload.get("scene_id"), "scene_id")
        timestamp_ms = _non_negative_number(payload.get("timestamp_ms"), "timestamp_ms")
        frame_index = _non_negative_integer(payload.get("frame_index"), "frame_index")
        if (
            self._last_frame_timestamp_ms is not None
            and timestamp_ms <= self._last_frame_timestamp_ms
        ):
            self._record_issue(
                scene_id=scene_id,
                start_ms=min(timestamp_ms, self._last_frame_timestamp_ms),
                end_ms=max(timestamp_ms, self._last_frame_timestamp_ms),
                reason="timestamp_out_of_order",
            )
            self._samples.clear()
            self._last_frame_timestamp_ms = timestamp_ms
            return None

        if (
            self._last_frame_timestamp_ms is not None
            and timestamp_ms - self._last_frame_timestamp_ms > self.config.max_frame_gap_ms
        ):
            self._record_issue(
                scene_id=scene_id,
                start_ms=self._last_frame_timestamp_ms,
                end_ms=timestamp_ms,
                reason="frame_gap",
            )
            self._samples.clear()

        landmark_quality = _enum_text(
            payload.get("landmark_quality"), LANDMARK_QUALITIES, "landmark_quality"
        )
        person_detected = payload.get("person_detected")
        if not isinstance(person_detected, bool):
            raise TransitionError("person_detected must be boolean")
        points, visible_keypoint_ratio = _point_map(
            payload,
            score_threshold=self.config.score_threshold,
        )
        self._last_frame_timestamp_ms = timestamp_ms
        if (
            not person_detected
            or landmark_quality == "unavailable"
            or visible_keypoint_ratio < self.config.min_visible_keypoint_ratio
            or any(name not in points for name in _REQUIRED_TORSO_POINTS)
        ):
            self._record_issue(
                scene_id=scene_id,
                start_ms=(self._samples[-1].timestamp_ms if self._samples else timestamp_ms),
                end_ms=timestamp_ms,
                reason="insufficient_visible_keypoints",
            )
            self._samples.clear()
            return None

        posture = self._posture_for_frame(scene_id=scene_id, timestamp_ms=timestamp_ms)
        sample = _Sample(
            scene_id=scene_id,
            timestamp_ms=timestamp_ms,
            frame_index=frame_index,
            center_y=_body_center_y(points),
            torso_angle_deg=_torso_angle_deg(points),
            points=points,
            visible_keypoint_ratio=min(
                visible_keypoint_ratio,
                posture.visible_keypoint_ratio if posture is not None else 1.0,
            ),
            landmark_quality=_worst_quality(
                (landmark_quality, posture.landmark_quality if posture is not None else "usable")
            ),
            posture=posture.posture if posture is not None else "unknown",
            posture_duration_ms=posture.posture_duration_ms if posture is not None else 0.0,
            motion_level=posture.motion_level if posture is not None else "unknown",
        )

        previous = self._samples[-1] if self._samples else None
        if previous is not None and previous.scene_id != scene_id:
            self._samples.clear()
            previous = None
        if previous is not None and _is_camera_jump(previous, sample, self.config):
            self._record_issue(
                scene_id=scene_id,
                start_ms=previous.timestamp_ms,
                end_ms=sample.timestamp_ms,
                reason="camera_jump",
            )
            self._samples.clear()
            self._samples.append(sample)
            return None

        self._samples.append(sample)
        self._prune(timestamp_ms)
        if timestamp_ms < self._cooldown_until_ms:
            return None
        if not self._is_settled(sample):
            return None
        if len(self._samples) < 3:
            return None
        window_duration_ms = self._samples[-1].timestamp_ms - self._samples[0].timestamp_ms
        if window_duration_ms < self.config.min_window_ms:
            return None

        evidence = _window_evidence(tuple(self._samples))
        transition, confidence, reasons = self._classify(evidence)
        if transition is None:
            return None
        self._event_counter += 1
        event = TransitionEvent(
            scene_id=scene_id,
            event_id=f"transition-{self._event_counter:04d}",
            start_ms=evidence.start_ms,
            end_ms=evidence.end_ms,
            transition=transition,
            transition_confidence=confidence,
            evidence={
                "center_height_change": round(evidence.center_height_change, 6),
                "maximum_center_drop": round(evidence.maximum_center_drop, 6),
                "peak_keypoint_speed": round(evidence.peak_keypoint_speed, 6),
                "torso_direction_change_deg": round(evidence.torso_direction_change_deg, 3),
                "maximum_torso_excursion_deg": round(evidence.maximum_torso_excursion_deg, 3),
                "posture_before": evidence.posture_before,
                "posture_after": evidence.posture_after,
                "intermediate_postures": list(evidence.intermediate_postures),
                "visible_keypoint_ratio": round(evidence.visible_keypoint_ratio, 6),
                "window_duration_ms": round(evidence.duration_ms, 3),
                "reasons": reasons,
            },
            landmark_quality=evidence.landmark_quality,
        )
        self._cooldown_until_ms = evidence.end_ms + self.config.cooldown_ms
        latest = self._samples[-1]
        self._samples.clear()
        self._samples.append(latest)
        return event

    def _classify(self, evidence: _WindowEvidence) -> tuple[str | None, float, list[str]]:
        posture_changed = (
            evidence.posture_before != "unknown"
            and evidence.posture_after != "unknown"
            and evidence.posture_before != evidence.posture_after
        )
        transient_posture = any(
            posture not in {"unknown", evidence.posture_before, evidence.posture_after}
            for posture in evidence.intermediate_postures
        )
        geometry_changed = (
            abs(evidence.center_height_change) >= self.config.min_center_change
            or evidence.maximum_torso_excursion_deg >= self.config.min_torso_change_deg
            or evidence.peak_keypoint_speed >= self.config.min_motion_speed
        )
        if not geometry_changed and not posture_changed and not transient_posture:
            return None, 0.0, []

        fall_signals = {
            "rapid_center_drop": evidence.center_height_change >= self.config.fall_center_drop,
            "high_keypoint_speed": evidence.peak_keypoint_speed >= self.config.fall_peak_speed,
            "large_torso_change": evidence.torso_direction_change_deg
            >= self.config.fall_torso_change_deg,
            "short_window": evidence.duration_ms <= self.config.fall_max_duration_ms,
            "high_to_low_posture": evidence.posture_before in {"standing", "sitting"}
            and evidence.posture_after == "lying",
        }
        if all(fall_signals.values()):
            confidence = _clamp(
                0.55
                + 0.12
                * min(
                    evidence.center_height_change / self.config.fall_center_drop - 1.0,
                    1.0,
                )
                + 0.12
                * min(
                    evidence.peak_keypoint_speed / self.config.fall_peak_speed - 1.0,
                    1.0,
                )
                + 0.08 * evidence.visible_keypoint_ratio,
                0.0,
                0.95,
            )
            return "fall_like_transition", confidence, sorted(fall_signals)

        rapid_drop_conflict = (
            fall_signals["rapid_center_drop"]
            and fall_signals["high_keypoint_speed"]
            and not fall_signals["high_to_low_posture"]
        )
        missing_posture_context = (
            evidence.posture_before == "unknown" or evidence.posture_after == "unknown"
        )
        if rapid_drop_conflict or missing_posture_context:
            reasons = []
            if rapid_drop_conflict:
                reasons.append("rapid_geometry_conflicts_with_posture")
            if missing_posture_context:
                reasons.append("missing_posture_context")
            return "uncertain_transition", 0.35, reasons

        normal_reasons = [
            name for name, present in fall_signals.items() if present and name != "short_window"
        ]
        if posture_changed:
            normal_reasons.append("controlled_posture_change")
        if transient_posture:
            normal_reasons.append("transient_supported_posture")
        confidence = _clamp(
            0.52
            + 0.12 * evidence.visible_keypoint_ratio
            + (0.08 if posture_changed else 0.0)
            + (0.05 if transient_posture else 0.0),
            0.0,
            0.85,
        )
        return "normal_transition", confidence, sorted(set(normal_reasons))

    def _posture_for_frame(self, *, scene_id: str, timestamp_ms: float) -> _PostureState | None:
        posture = self._latest_posture
        if posture is None or posture.scene_id != scene_id:
            return None
        age_ms = timestamp_ms - posture.timestamp_ms
        if age_ms < 0 or age_ms > self.config.max_posture_age_ms:
            return None
        return posture

    def _is_settled(self, sample: _Sample) -> bool:
        if sample.motion_level in {"still", "low"}:
            return sample.posture_duration_ms >= self.config.settle_ms
        if sample.motion_level != "unknown" or len(self._samples) < 2:
            return False
        previous = self._samples[-2]
        return _pair_speed(previous, sample) < self.config.min_motion_speed * 0.5

    def _prune(self, timestamp_ms: float) -> None:
        cutoff = timestamp_ms - self.config.window_ms
        while len(self._samples) > 1 and self._samples[0].timestamp_ms < cutoff:
            self._samples.popleft()

    def _record_issue(self, *, scene_id: str, start_ms: float, end_ms: float, reason: str) -> None:
        normalized_start = min(start_ms, end_ms)
        normalized_end = max(start_ms, end_ms)
        self._issues.append(
            TransitionIssue(
                scene_id=scene_id,
                start_ms=normalized_start,
                end_ms=normalized_end,
                reason=reason,
            )
        )

    def _set_session_id(self, session_id: str) -> None:
        if not isinstance(session_id, str) or not session_id.strip():
            raise TransitionError("session_id must be a non-empty string")
        self.session_id = session_id.strip()


def _window_evidence(samples: tuple[_Sample, ...]) -> _WindowEvidence:
    segment_size = max(2, math.ceil(len(samples) * 0.3))
    start_samples = samples[:segment_size]
    end_samples = samples[-segment_size:]
    start_center = median(sample.center_y for sample in start_samples)
    end_center = median(sample.center_y for sample in end_samples)
    start_angle = median(sample.torso_angle_deg for sample in start_samples)
    end_angle = median(sample.torso_angle_deg for sample in end_samples)
    postures = tuple(sample.posture for sample in samples)
    posture_before = _majority_posture(tuple(sample.posture for sample in start_samples))
    posture_after = _majority_posture(tuple(sample.posture for sample in end_samples))
    return _WindowEvidence(
        start_ms=samples[0].timestamp_ms,
        end_ms=samples[-1].timestamp_ms,
        center_height_change=end_center - start_center,
        maximum_center_drop=max(sample.center_y for sample in samples) - start_center,
        peak_keypoint_speed=max(
            _pair_speed(previous, current)
            for previous, current in zip(samples, samples[1:], strict=False)
        ),
        torso_direction_change_deg=abs(end_angle - start_angle),
        maximum_torso_excursion_deg=max(
            abs(sample.torso_angle_deg - start_angle) for sample in samples
        ),
        posture_before=posture_before,
        posture_after=posture_after,
        intermediate_postures=tuple(dict.fromkeys(postures)),
        visible_keypoint_ratio=min(sample.visible_keypoint_ratio for sample in samples),
        landmark_quality=_worst_quality(tuple(sample.landmark_quality for sample in samples)),
    )


def _majority_posture(postures: tuple[str, ...]) -> str:
    known = [posture for posture in postures if posture != "unknown"]
    if not known:
        return "unknown"
    counts = Counter(known)
    return max(counts, key=lambda posture: (counts[posture], -known.index(posture)))


def _is_camera_jump(
    previous: _Sample,
    current: _Sample,
    config: TransitionDetectorConfig,
) -> bool:
    elapsed_ms = current.timestamp_ms - previous.timestamp_ms
    if elapsed_ms <= 0 or elapsed_ms > config.camera_jump_max_interval_ms:
        return False
    common = sorted(previous.points.keys() & current.points.keys())
    if len(common) < 6:
        return False
    dx_values = [current.points[name][0] - previous.points[name][0] for name in common]
    dy_values = [current.points[name][1] - previous.points[name][1] for name in common]
    global_dx = median(dx_values)
    global_dy = median(dy_values)
    global_distance = math.hypot(global_dx, global_dy)
    residuals = [
        math.hypot(dx - global_dx, dy - global_dy)
        for dx, dy in zip(dx_values, dy_values, strict=True)
    ]
    residual = median(residuals)
    torso_step = abs(current.torso_angle_deg - previous.torso_angle_deg)
    return (
        global_distance >= config.camera_jump_distance
        and residual <= config.camera_jump_residual
        and torso_step < 10.0
    )


def _pair_speed(previous: _Sample, current: _Sample) -> float:
    elapsed_seconds = (current.timestamp_ms - previous.timestamp_ms) / 1000.0
    if elapsed_seconds <= 0:
        return float("inf")
    common = sorted(previous.points.keys() & current.points.keys())
    if not common:
        return float("inf")
    speeds = [
        math.dist(previous.points[name], current.points[name]) / elapsed_seconds for name in common
    ]
    return median(speeds)


def _point_map(
    payload: dict[str, Any], *, score_threshold: float
) -> tuple[dict[str, tuple[float, float]], float]:
    raw_points = payload.get("keypoints")
    if not isinstance(raw_points, list) or not raw_points:
        raise TransitionError("keypoints must be a non-empty array")
    points: dict[str, tuple[float, float]] = {}
    visible_count = 0
    for index, raw_point in enumerate(raw_points):
        if not isinstance(raw_point, dict):
            raise TransitionError(f"keypoints[{index}] must be an object")
        name = _text(raw_point.get("name"), f"keypoints[{index}].name")
        score = _ratio(raw_point.get("score"), f"keypoints[{index}].score")
        if score < score_threshold:
            continue
        x_norm = _ratio(raw_point.get("x_norm"), f"keypoints[{index}].x_norm")
        y_norm = _ratio(raw_point.get("y_norm"), f"keypoints[{index}].y_norm")
        points[name] = (x_norm, y_norm)
        visible_count += 1
    return points, visible_count / len(raw_points)


def _body_center_y(points: dict[str, tuple[float, float]]) -> float:
    return median(points[name][1] for name in _REQUIRED_TORSO_POINTS)


def _torso_angle_deg(points: dict[str, tuple[float, float]]) -> float:
    shoulder_x = (points["left_shoulder"][0] + points["right_shoulder"][0]) / 2.0
    shoulder_y = (points["left_shoulder"][1] + points["right_shoulder"][1]) / 2.0
    hip_x = (points["left_hip"][0] + points["right_hip"][0]) / 2.0
    hip_y = (points["left_hip"][1] + points["right_hip"][1]) / 2.0
    return math.degrees(math.atan2(abs(hip_x - shoulder_x), abs(hip_y - shoulder_y)))


def _worst_quality(qualities: tuple[str, ...]) -> str:
    ranking = {"usable": 0, "degraded": 1, "unavailable": 2}
    return max(qualities, key=ranking.__getitem__)


def _text(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TransitionError(f"{field_name} must be a non-empty string")
    return value.strip()


def _enum_text(
    value: object,
    allowed: tuple[str, ...],
    field_name: str,
) -> str:
    text = _text(value, field_name)
    if text not in allowed:
        raise TransitionError(f"{field_name} must be one of {allowed}")
    return text


def _non_negative_integer(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise TransitionError(f"{field_name} must be a non-negative integer")
    return value


def _non_negative_number(value: object, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise TransitionError(f"{field_name} must be numeric")
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise TransitionError(f"{field_name} must be finite and non-negative")
    return number


def _ratio(value: object, field_name: str) -> float:
    number = _non_negative_number(value, field_name)
    if number > 1.0:
        raise TransitionError(f"{field_name} must be between 0 and 1")
    return number


def _clamp(value: float, lower: float, upper: float) -> float:
    return min(max(value, lower), upper)
