"""Infer auditable fall-transition pseudo labels from ordered pose samples."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from statistics import median
from typing import Literal, Protocol

WeakCandidateStatus = Literal["accepted", "uncertain", "rejected"]
LANDMARK_QUALITIES = ("usable", "degraded", "unavailable")
POSTURES = (
    "standing",
    "sitting",
    "lying",
    "bending_or_crouching",
    "unknown",
)


class FallWeakLabelError(ValueError):
    """Raised when weak-label inputs violate temporal or numeric invariants."""


@dataclass(frozen=True, slots=True)
class FallPoseSample:
    """One source-time posture and geometric observation used for weak labels."""

    timestamp_ms: float
    posture: str
    posture_confidence: float
    center_y: float
    torso_angle_deg: float
    bbox_aspect_ratio: float
    motion_speed: float
    visible_keypoint_ratio: float
    landmark_quality: str

    def __post_init__(self) -> None:
        numeric = {
            "timestamp_ms": self.timestamp_ms,
            "posture_confidence": self.posture_confidence,
            "center_y": self.center_y,
            "torso_angle_deg": self.torso_angle_deg,
            "bbox_aspect_ratio": self.bbox_aspect_ratio,
            "motion_speed": self.motion_speed,
            "visible_keypoint_ratio": self.visible_keypoint_ratio,
        }
        for field_name, value in numeric.items():
            if isinstance(value, bool) or not isinstance(value, int | float):
                raise FallWeakLabelError(f"{field_name} must be numeric")
            if not math.isfinite(float(value)):
                raise FallWeakLabelError(f"{field_name} must be finite")
        if self.timestamp_ms < 0:
            raise FallWeakLabelError("timestamp_ms must be non-negative")
        if self.posture not in POSTURES:
            raise FallWeakLabelError(f"posture must be one of {POSTURES}")
        if not 0.0 <= self.posture_confidence <= 1.0:
            raise FallWeakLabelError("posture_confidence must be between 0 and 1")
        if not 0.0 <= self.center_y <= 1.0:
            raise FallWeakLabelError("center_y must be between 0 and 1")
        if not 0.0 <= self.torso_angle_deg <= 180.0:
            raise FallWeakLabelError("torso_angle_deg must be between 0 and 180")
        if self.bbox_aspect_ratio < 0:
            raise FallWeakLabelError("bbox_aspect_ratio must be non-negative")
        if self.motion_speed < 0:
            raise FallWeakLabelError("motion_speed must be non-negative")
        if not 0.0 <= self.visible_keypoint_ratio <= 1.0:
            raise FallWeakLabelError("visible_keypoint_ratio must be between 0 and 1")
        if self.landmark_quality not in LANDMARK_QUALITIES:
            raise FallWeakLabelError(
                f"landmark_quality must be one of {LANDMARK_QUALITIES}"
            )

    def to_payload(self) -> dict[str, object]:
        """Return the persisted weak-label sample shape."""

        return {
            "timestamp_ms": round(self.timestamp_ms, 3),
            "posture": self.posture,
            "posture_confidence": round(self.posture_confidence, 6),
            "center_y": round(self.center_y, 6),
            "torso_angle_deg": round(self.torso_angle_deg, 6),
            "bbox_aspect_ratio": round(self.bbox_aspect_ratio, 6),
            "motion_speed": round(self.motion_speed, 6),
            "visible_keypoint_ratio": round(self.visible_keypoint_ratio, 6),
            "landmark_quality": self.landmark_quality,
        }


@dataclass(frozen=True, slots=True)
class WeakFallConfig:
    """Conservative anchor and transition evidence thresholds."""

    min_anchor_duration_ms: float = 400.0
    max_anchor_gap_ms: float = 250.0
    min_visible_ratio: float = 0.35
    min_standing_confidence: float = 0.45
    max_standing_torso_angle_deg: float = 35.0
    max_standing_aspect_ratio: float = 0.65
    max_standing_motion_speed: float = 0.20
    min_fallen_confidence: float = 0.35
    min_fallen_torso_angle_deg: float = 50.0
    min_fallen_aspect_ratio: float = 0.75
    max_fallen_motion_speed: float = 0.20
    max_fall_duration_ms: float = 1600.0
    min_center_drop: float = 0.12
    min_torso_change_deg: float = 35.0
    min_peak_motion_speed: float = 0.35

    def __post_init__(self) -> None:
        positive = {
            "min_anchor_duration_ms": self.min_anchor_duration_ms,
            "max_anchor_gap_ms": self.max_anchor_gap_ms,
            "max_fall_duration_ms": self.max_fall_duration_ms,
        }
        for field_name, value in positive.items():
            if not math.isfinite(value) or value <= 0:
                raise FallWeakLabelError(f"{field_name} must be finite and positive")
        ratios = {
            "min_visible_ratio": self.min_visible_ratio,
            "min_standing_confidence": self.min_standing_confidence,
            "min_fallen_confidence": self.min_fallen_confidence,
            "min_center_drop": self.min_center_drop,
        }
        for field_name, value in ratios.items():
            if not math.isfinite(value) or not 0.0 <= value <= 1.0:
                raise FallWeakLabelError(f"{field_name} must be between 0 and 1")
        non_negative = {
            "max_standing_torso_angle_deg": self.max_standing_torso_angle_deg,
            "max_standing_aspect_ratio": self.max_standing_aspect_ratio,
            "max_standing_motion_speed": self.max_standing_motion_speed,
            "min_fallen_torso_angle_deg": self.min_fallen_torso_angle_deg,
            "min_fallen_aspect_ratio": self.min_fallen_aspect_ratio,
            "max_fallen_motion_speed": self.max_fallen_motion_speed,
            "min_torso_change_deg": self.min_torso_change_deg,
            "min_peak_motion_speed": self.min_peak_motion_speed,
        }
        for field_name, value in non_negative.items():
            if not math.isfinite(value) or value < 0:
                raise FallWeakLabelError(
                    f"{field_name} must be finite and non-negative"
                )


@dataclass(frozen=True, slots=True)
class WeakFallCandidate:
    """One selected standing-to-fallen pseudo-label candidate."""

    clip_id: str
    status: WeakCandidateStatus
    standing_start_ms: float | None
    standing_end_ms: float | None
    transition_start_ms: float | None
    transition_end_ms: float | None
    fallen_start_ms: float | None
    fallen_end_ms: float | None
    confidence: float
    evidence: dict[str, float]
    reasons: tuple[str, ...]

    def to_payload(self) -> dict[str, object]:
        """Return a stable machine-readable weak-label candidate."""

        return {
            "clip_id": self.clip_id,
            "status": self.status,
            "standing_start_ms": self.standing_start_ms,
            "standing_end_ms": self.standing_end_ms,
            "transition_start_ms": self.transition_start_ms,
            "transition_end_ms": self.transition_end_ms,
            "fallen_start_ms": self.fallen_start_ms,
            "fallen_end_ms": self.fallen_end_ms,
            "confidence": round(self.confidence, 6),
            "evidence": {
                key: round(value, 6) for key, value in sorted(self.evidence.items())
            },
            "reasons": list(self.reasons),
        }


class _AnchorPredicate(Protocol):
    def __call__(self, sample: FallPoseSample) -> bool: ...


@dataclass(frozen=True, slots=True)
class _StableRun:
    samples: tuple[FallPoseSample, ...]

    @property
    def start_ms(self) -> float:
        return self.samples[0].timestamp_ms

    @property
    def end_ms(self) -> float:
        return self.samples[-1].timestamp_ms

    @property
    def duration_ms(self) -> float:
        return self.end_ms - self.start_ms


def infer_weak_fall_candidate(
    samples: Sequence[FallPoseSample],
    *,
    clip_id: str,
    config: WeakFallConfig | None = None,
) -> WeakFallCandidate:
    """Select one conservative fall candidate from a positive-bag clip."""

    if not isinstance(clip_id, str) or not clip_id.strip():
        raise FallWeakLabelError("clip_id must be non-empty")
    ordered = tuple(samples)
    if any(
        current.timestamp_ms <= previous.timestamp_ms
        for previous, current in zip(ordered, ordered[1:], strict=False)
    ):
        raise FallWeakLabelError("samples must have strictly increasing timestamps")
    if not ordered:
        return _rejected(clip_id, "no_pose_samples")

    thresholds = config or WeakFallConfig()
    standing_runs = _stable_runs(
        ordered,
        predicate=lambda sample: _is_standing(sample, thresholds),
        min_duration_ms=thresholds.min_anchor_duration_ms,
        max_gap_ms=thresholds.max_anchor_gap_ms,
    )
    if not standing_runs:
        return _rejected(clip_id, "no_stable_standing_anchor")

    fallen_runs = _stable_runs(
        ordered,
        predicate=lambda sample: _is_fallen(sample, thresholds),
        min_duration_ms=thresholds.min_anchor_duration_ms,
        max_gap_ms=thresholds.max_anchor_gap_ms,
    )
    pairs = [
        (standing, fallen)
        for standing in standing_runs
        for fallen in fallen_runs
        if fallen.start_ms > standing.end_ms
    ]
    if not pairs:
        return _rejected(clip_id, "no_stable_fallen_anchor_after_standing")

    scored = [
        _score_pair(ordered, standing, fallen, config=thresholds)
        for standing, fallen in pairs
    ]
    scored.sort(key=lambda item: (-item[0], item[1].end_ms, item[2].start_ms))
    confidence, standing, fallen, evidence, reasons = scored[0]
    status: WeakCandidateStatus = "accepted" if not reasons else "uncertain"
    return WeakFallCandidate(
        clip_id=clip_id.strip(),
        status=status,
        standing_start_ms=standing.start_ms,
        standing_end_ms=standing.end_ms,
        transition_start_ms=standing.end_ms,
        transition_end_ms=fallen.start_ms,
        fallen_start_ms=fallen.start_ms,
        fallen_end_ms=fallen.end_ms,
        confidence=confidence,
        evidence=evidence,
        reasons=reasons,
    )


def _stable_runs(
    samples: Sequence[FallPoseSample],
    *,
    predicate: _AnchorPredicate,
    min_duration_ms: float,
    max_gap_ms: float,
) -> tuple[_StableRun, ...]:
    runs: list[_StableRun] = []
    current: list[FallPoseSample] = []

    def flush() -> None:
        if current and current[-1].timestamp_ms - current[0].timestamp_ms >= min_duration_ms:
            runs.append(_StableRun(tuple(current)))
        current.clear()

    for sample in samples:
        if not predicate(sample):
            flush()
            continue
        if current and sample.timestamp_ms - current[-1].timestamp_ms > max_gap_ms:
            flush()
        current.append(sample)
    flush()
    return tuple(runs)


def _is_standing(sample: FallPoseSample, config: WeakFallConfig) -> bool:
    if (
        sample.landmark_quality == "unavailable"
        or sample.visible_keypoint_ratio < config.min_visible_ratio
        or sample.motion_speed > config.max_standing_motion_speed
    ):
        return False
    model_evidence = (
        sample.posture == "standing"
        and sample.posture_confidence >= config.min_standing_confidence
    )
    geometry_evidence = (
        sample.torso_angle_deg <= config.max_standing_torso_angle_deg
        and sample.bbox_aspect_ratio <= config.max_standing_aspect_ratio
    )
    return model_evidence or geometry_evidence


def _is_fallen(sample: FallPoseSample, config: WeakFallConfig) -> bool:
    if (
        sample.landmark_quality == "unavailable"
        or sample.visible_keypoint_ratio < config.min_visible_ratio
    ):
        return False
    if sample.motion_speed > config.max_fallen_motion_speed:
        return False
    static_evidence = (
        sample.posture == "lying"
        and sample.posture_confidence >= config.min_fallen_confidence
    )
    geometry_evidence = (
        sample.torso_angle_deg >= config.min_fallen_torso_angle_deg
        and sample.bbox_aspect_ratio >= config.min_fallen_aspect_ratio
    )
    return static_evidence or geometry_evidence


def _score_pair(
    all_samples: Sequence[FallPoseSample],
    standing: _StableRun,
    fallen: _StableRun,
    *,
    config: WeakFallConfig,
) -> tuple[
    float,
    _StableRun,
    _StableRun,
    dict[str, float],
    tuple[str, ...],
]:
    standing_center = float(median(sample.center_y for sample in standing.samples))
    fallen_center = float(median(sample.center_y for sample in fallen.samples))
    standing_torso = float(
        median(sample.torso_angle_deg for sample in standing.samples)
    )
    fallen_torso = float(median(sample.torso_angle_deg for sample in fallen.samples))
    center_drop = fallen_center - standing_center
    torso_change = abs(fallen_torso - standing_torso)
    transition_duration = fallen.start_ms - standing.end_ms
    transition_samples = [
        sample
        for sample in all_samples
        if standing.end_ms <= sample.timestamp_ms <= fallen.start_ms
    ]
    peak_speed = max(
        (sample.motion_speed for sample in transition_samples),
        default=0.0,
    )
    standing_confidence = float(
        median(sample.posture_confidence for sample in standing.samples)
    )
    fallen_confidence = float(
        median(sample.posture_confidence for sample in fallen.samples)
    )
    visible_ratio = float(
        median(
            sample.visible_keypoint_ratio
            for sample in (*standing.samples, *fallen.samples)
        )
    )

    reasons: list[str] = []
    if transition_duration > config.max_fall_duration_ms:
        reasons.append("transition_too_slow")
    if center_drop < config.min_center_drop:
        reasons.append("insufficient_center_drop")
    if torso_change < config.min_torso_change_deg:
        reasons.append("insufficient_torso_change")
    if peak_speed < config.min_peak_motion_speed:
        reasons.append("insufficient_peak_speed")

    evidence = {
        "transition_duration_ms": transition_duration,
        "center_drop": center_drop,
        "torso_change_deg": torso_change,
        "peak_motion_speed": peak_speed,
        "standing_confidence": standing_confidence,
        "fallen_confidence": fallen_confidence,
        "visible_keypoint_ratio": visible_ratio,
    }
    confidence = _candidate_confidence(evidence, config=config)
    return confidence, standing, fallen, evidence, tuple(reasons)


def _candidate_confidence(
    evidence: dict[str, float],
    *,
    config: WeakFallConfig,
) -> float:
    duration_score = _clamp01(
        1.0 - evidence["transition_duration_ms"] / config.max_fall_duration_ms
    )
    drop_score = _clamp01(evidence["center_drop"] / max(config.min_center_drop * 2, 1e-6))
    torso_score = _clamp01(
        evidence["torso_change_deg"] / max(config.min_torso_change_deg * 2, 1e-6)
    )
    speed_score = _clamp01(
        evidence["peak_motion_speed"] / max(config.min_peak_motion_speed * 2, 1e-6)
    )
    anchor_score = (
        evidence["standing_confidence"]
        + evidence["fallen_confidence"]
        + evidence["visible_keypoint_ratio"]
    ) / 3.0
    return _clamp01(
        0.20 * duration_score
        + 0.20 * drop_score
        + 0.20 * torso_score
        + 0.20 * speed_score
        + 0.20 * anchor_score
    )


def _rejected(clip_id: str, reason: str) -> WeakFallCandidate:
    return WeakFallCandidate(
        clip_id=clip_id.strip(),
        status="rejected",
        standing_start_ms=None,
        standing_end_ms=None,
        transition_start_ms=None,
        transition_end_ms=None,
        fallen_start_ms=None,
        fallen_end_ms=None,
        confidence=0.0,
        evidence={},
        reasons=(reason,),
    )


def _clamp01(value: float) -> float:
    return min(max(float(value), 0.0), 1.0)
