"""Continuous local fall detection built around deterministic and weak MIL evidence."""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from reme.runtime.perception.edge_bundle import (
    FALL_HEAD_SCHEMA_VERSION,
    CompactFallModel,
    model_schema_version,
)
from reme.runtime.perception.fall_mil import (
    FALL_WINDOW_FEATURE_NAMES,
    FallBag,
    FallMILModel,
    FallMILScore,
    FallWindow,
    FallWindowPredictor,
    build_fall_windows,
    score_fall_samples,
)
from reme.runtime.perception.fall_training_data import derive_fall_pose_sample
from reme.runtime.perception.fall_weak_labels import FallPoseSample
from reme.runtime.perception.posture import PosturePrediction
from reme.runtime.perception.runtime import RuntimeEvent, RuntimeEventType
from reme.runtime.perception.transitions import (
    TRANSITION_SCHEMA_VERSION,
    TransitionDetector,
    TransitionDetectorConfig,
)

DEFAULT_FALL_MIL_MODEL = Path("models/trained/fall/mil-v3/model.json")
_FEATURE_INDEX = {
    name: index for index, name in enumerate(FALL_WINDOW_FEATURE_NAMES)
}


class FallRuntimeError(RuntimeError):
    """Raised when the runtime fall detector receives incompatible events."""


@dataclass(frozen=True, slots=True)
class ContinuousFallConfig:
    """Conservative local-demo thresholds for continuous fall-window evaluation."""

    evaluation_stride_ms: float = 250.0
    maximum_start_center_y: float = 0.65
    minimum_center_drop: float = 0.10
    minimum_high_motion_ratio: float = 0.22
    minimum_torso_range_deg: float = 55.0
    minimum_peak_motion_speed: float = 0.55
    minimum_downward_speed: float = 0.65
    slow_probability_threshold: float = 0.95
    slow_minimum_center_drop: float = 0.18
    slow_minimum_torso_end_deg: float = 45.0
    slow_minimum_torso_range_deg: float = 60.0
    slow_minimum_high_motion_ratio: float = 0.08
    slow_minimum_downward_speed: float = 0.50
    recovery_posture_duration_ms: float = 5000.0
    minimum_latch_ms: float = 10000.0

    def __post_init__(self) -> None:
        positive = {
            "evaluation_stride_ms": self.evaluation_stride_ms,
            "minimum_center_drop": self.minimum_center_drop,
            "minimum_high_motion_ratio": self.minimum_high_motion_ratio,
            "minimum_torso_range_deg": self.minimum_torso_range_deg,
            "minimum_peak_motion_speed": self.minimum_peak_motion_speed,
            "minimum_downward_speed": self.minimum_downward_speed,
            "slow_minimum_center_drop": self.slow_minimum_center_drop,
            "slow_minimum_torso_end_deg": self.slow_minimum_torso_end_deg,
            "slow_minimum_torso_range_deg": self.slow_minimum_torso_range_deg,
            "slow_minimum_high_motion_ratio": self.slow_minimum_high_motion_ratio,
            "slow_minimum_downward_speed": self.slow_minimum_downward_speed,
            "recovery_posture_duration_ms": self.recovery_posture_duration_ms,
            "minimum_latch_ms": self.minimum_latch_ms,
        }
        for name, value in positive.items():
            if not math.isfinite(value) or value <= 0:
                raise FallRuntimeError(f"{name} must be finite and positive")
        ratios = {
            "maximum_start_center_y": self.maximum_start_center_y,
            "minimum_high_motion_ratio": self.minimum_high_motion_ratio,
            "slow_minimum_high_motion_ratio": self.slow_minimum_high_motion_ratio,
            "slow_probability_threshold": self.slow_probability_threshold,
        }
        for name, value in ratios.items():
            if not math.isfinite(value) or not 0.0 <= value <= 1.0:
                raise FallRuntimeError(f"{name} must be between 0 and 1")


@dataclass(frozen=True, slots=True)
class ContinuousFallDecision:
    """One independent continuous-window fall decision."""

    confirmed: bool
    confidence: float
    source: str
    start_ms: float | None
    end_ms: float | None
    model_probability: float
    evidence: dict[str, float | bool | str]

    @classmethod
    def abstain(cls) -> ContinuousFallDecision:
        return cls(False, 0.0, "none", None, None, 0.0, {})


class FallMILTransitionEnhancer:
    """Combine deterministic transitions with continuous MIL and impact evidence.

    The model and structural windows are evaluated on a fixed source-time stride,
    independently of whether the deterministic detector happens to emit an event.
    One confirmed fall is latched until a stable standing or sitting posture has
    been observed long enough, preventing duplicate alerts from overlapping windows.
    """

    def __init__(
        self,
        *,
        session_id: str,
        model: FallWindowPredictor,
        config: TransitionDetectorConfig | None = None,
        score_threshold: float = 0.2,
        continuous_config: ContinuousFallConfig | None = None,
    ) -> None:
        self.session_id = session_id
        self.model = model
        self.model_name = "edge-int16" if isinstance(model, CompactFallModel) else "mil-v3"
        self.detector = TransitionDetector(session_id=session_id, config=config)
        self.score_threshold = score_threshold
        self.continuous_config = continuous_config or ContinuousFallConfig()
        self._samples: deque[FallPoseSample] = deque()
        self._latest_posture: dict[str, Any] | None = None
        self._previous_frame: dict[str, Any] | None = None
        self._last_evaluation_ms: float | None = None
        self._fall_latched = False
        self._fall_latched_at_ms: float | None = None
        self._continuous_event_counter = 0

    @classmethod
    def load(
        cls,
        *,
        session_id: str,
        model_path: str | Path,
        config: TransitionDetectorConfig | None = None,
        score_threshold: float = 0.2,
        continuous_config: ContinuousFallConfig | None = None,
    ) -> FallMILTransitionEnhancer:
        model: FallMILModel | CompactFallModel
        if model_schema_version(model_path) == FALL_HEAD_SCHEMA_VERSION:
            model = CompactFallModel.load(model_path)
        else:
            model = FallMILModel.load(model_path)
        return cls(
            session_id=session_id,
            model=model,
            config=config,
            score_threshold=score_threshold,
            continuous_config=continuous_config,
        )

    def reset(self, *, session_id: str) -> None:
        self.session_id = session_id
        self.detector.reset(session_id=session_id)
        self._samples.clear()
        self._latest_posture = None
        self._previous_frame = None
        self._last_evaluation_ms = None
        self._fall_latched = False
        self._fall_latched_at_ms = None
        self._continuous_event_counter = 0

    def process_runtime_event(self, event: RuntimeEvent) -> RuntimeEvent | None:
        if event.event_type is RuntimeEventType.POSTURE_OBSERVATION:
            self._latest_posture = event.payload
            self._recover_if_safe(event.payload)
            return self.detector.process_runtime_event(event)
        if event.event_type is not RuntimeEventType.FRAME_LANDMARKS:
            return self.detector.process_runtime_event(event)

        self._append_sample(event.payload)
        deterministic = self.detector.process_runtime_event(event)
        continuous = self._continuous_decision(event.payload)

        if (
            deterministic is not None
            and deterministic.payload.get("transition") == "fall_like_transition"
        ):
            if self._fall_latched:
                return None
            self._latch_fall(float(deterministic.payload.get("end_ms", 0.0)))
            return self._enhance(deterministic, continuous=continuous)

        if continuous.confirmed and not self._fall_latched:
            self._latch_fall(float(continuous.end_ms or 0.0))
            if deterministic is not None:
                return self._upgrade_with_continuous(deterministic, continuous)
            return self._continuous_event(event, continuous)

        if deterministic is not None:
            return self._enhance(deterministic, continuous=continuous)
        return None

    def _append_sample(self, frame: dict[str, Any]) -> None:
        prediction = self._prediction_for_frame(frame)
        try:
            sample = derive_fall_pose_sample(
                frame,
                prediction=prediction,
                previous_record=self._previous_frame,
                score_threshold=self.score_threshold,
            )
        except (KeyError, TypeError, ValueError):
            self._previous_frame = frame
            return
        self._previous_frame = frame
        if self._samples and sample.timestamp_ms <= self._samples[-1].timestamp_ms:
            self._samples.clear()
            self._last_evaluation_ms = None
        self._samples.append(sample)
        retention_ms = max(self.model.window_config.durations_ms) + 1000.0
        while self._samples and sample.timestamp_ms - self._samples[0].timestamp_ms > retention_ms:
            self._samples.popleft()

    def _prediction_for_frame(self, frame: dict[str, Any]) -> PosturePrediction:
        posture = self._latest_posture
        frame_scene = frame.get("scene_id")
        frame_timestamp = frame.get("timestamp_ms")
        if (
            posture is None
            or posture.get("scene_id") != frame_scene
            or not isinstance(frame_timestamp, int | float)
            or not isinstance(posture.get("timestamp_ms"), int | float)
            or float(frame_timestamp) - float(posture["timestamp_ms"]) > 1000.0
        ):
            return PosturePrediction(
                posture="unknown",
                confidence=1.0,
                probabilities={"unknown": 1.0},
                visible_keypoint_ratio=0.0,
                classification_source="missing_posture_context",
            )
        return PosturePrediction(
            posture=str(posture.get("posture", "unknown")),
            confidence=float(posture.get("posture_confidence", 0.0)),
            probabilities={
                str(posture.get("posture", "unknown")): float(
                    posture.get("posture_confidence", 0.0)
                )
            },
            visible_keypoint_ratio=float(posture.get("visible_keypoint_ratio", 0.0)),
            classification_source=str(posture.get("classification_source", "runtime")),
        )

    def _continuous_decision(self, frame: dict[str, Any]) -> ContinuousFallDecision:
        timestamp = frame.get("timestamp_ms")
        if not isinstance(timestamp, int | float):
            return ContinuousFallDecision.abstain()
        timestamp_ms = float(timestamp)
        if (
            self._last_evaluation_ms is not None
            and timestamp_ms - self._last_evaluation_ms
            < self.continuous_config.evaluation_stride_ms - 1e-6
        ):
            return ContinuousFallDecision.abstain()
        self._last_evaluation_ms = timestamp_ms
        if len(self._samples) < self.model.window_config.min_samples:
            return ContinuousFallDecision.abstain()
        try:
            windows = build_fall_windows(
                _runtime_bag(self.session_id, tuple(self._samples)),
                config=self.model.window_config,
            )
        except ValueError:
            return ContinuousFallDecision.abstain()
        candidates = [
            decision
            for window in windows
            if (decision := self._window_decision(window)).confirmed
        ]
        if not candidates:
            return ContinuousFallDecision.abstain()
        return max(
            candidates,
            key=lambda item: (
                item.confidence,
                item.model_probability,
                item.end_ms or -1.0,
            ),
        )

    def _window_decision(self, window: FallWindow) -> ContinuousFallDecision:
        features = {
            name: float(window.features[index])
            for name, index in _FEATURE_INDEX.items()
        }
        probability = self.model.predict_probability(window.features)
        kinetic = (
            features["peak_motion_speed"]
            >= self.continuous_config.minimum_peak_motion_speed
            or features["max_downward_center_speed"]
            >= self.continuous_config.minimum_downward_speed
        )
        impulse_confirmed = (
            features["center_start"]
            <= self.continuous_config.maximum_start_center_y
            and features["center_drop"]
            >= self.continuous_config.minimum_center_drop
            and features["high_motion_ratio"]
            >= self.continuous_config.minimum_high_motion_ratio
            and features["torso_range_deg"]
            >= self.continuous_config.minimum_torso_range_deg
            and kinetic
        )
        slow_confirmed = (
            probability >= self.continuous_config.slow_probability_threshold
            and features["center_drop"]
            >= self.continuous_config.slow_minimum_center_drop
            and features["has_fallen_anchor"] >= 0.5
            and features["torso_end_deg"]
            >= self.continuous_config.slow_minimum_torso_end_deg
            and features["torso_range_deg"]
            >= self.continuous_config.slow_minimum_torso_range_deg
            and features["high_motion_ratio"]
            >= self.continuous_config.slow_minimum_high_motion_ratio
            and features["max_downward_center_speed"]
            >= self.continuous_config.slow_minimum_downward_speed
        )
        if not impulse_confirmed and not slow_confirmed:
            return ContinuousFallDecision.abstain()
        source = "continuous_impulse" if impulse_confirmed else "continuous_model_settle"
        confidence = _continuous_confidence(
            features,
            probability=probability,
            config=self.continuous_config,
            impulse_confirmed=impulse_confirmed,
        )
        evidence: dict[str, float | bool | str] = {
            "continuous_source": source,
            "continuous_model_probability": round(probability, 6),
            "center_start": round(features["center_start"], 6),
            "center_drop": round(features["center_drop"], 6),
            "max_downward_center_speed": round(
                features["max_downward_center_speed"], 6
            ),
            "torso_end_deg": round(features["torso_end_deg"], 3),
            "torso_range_deg": round(features["torso_range_deg"], 3),
            "peak_motion_speed": round(features["peak_motion_speed"], 6),
            "high_motion_ratio": round(features["high_motion_ratio"], 6),
            "has_fallen_anchor": features["has_fallen_anchor"] >= 0.5,
        }
        return ContinuousFallDecision(
            confirmed=True,
            confidence=confidence,
            source=source,
            start_ms=window.start_ms,
            end_ms=window.end_ms,
            model_probability=probability,
            evidence=evidence,
        )

    def _enhance(
        self,
        event: RuntimeEvent,
        *,
        continuous: ContinuousFallDecision | None = None,
    ) -> RuntimeEvent:
        score = self._score()
        payload = dict(event.payload)
        evidence = dict(payload.get("evidence") or {})
        evidence.update(self._model_evidence(score))
        if continuous is not None and continuous.confirmed:
            evidence.update(continuous.evidence)
        payload["evidence"] = evidence
        return RuntimeEvent(
            session_id=event.session_id,
            sequence=event.sequence,
            event_type=event.event_type,
            payload=payload,
        )

    def _upgrade_with_continuous(
        self,
        event: RuntimeEvent,
        decision: ContinuousFallDecision,
    ) -> RuntimeEvent:
        enhanced = self._enhance(event, continuous=decision)
        payload = dict(enhanced.payload)
        evidence = dict(payload.get("evidence") or {})
        evidence["deterministic_transition"] = event.payload.get("transition")
        reasons = evidence.get("reasons")
        evidence["reasons"] = sorted(
            set(
                (reasons if isinstance(reasons, list) else [])
                + ["continuous_fall_confirmed"]
            )
        )
        payload["transition"] = "fall_like_transition"
        payload["transition_confidence"] = round(
            max(float(payload.get("transition_confidence", 0.0)), decision.confidence),
            6,
        )
        payload["evidence"] = evidence
        return RuntimeEvent(
            session_id=event.session_id,
            sequence=event.sequence,
            event_type=RuntimeEventType.TRANSITION_EVENT,
            payload=payload,
        )

    def _continuous_event(
        self,
        frame_event: RuntimeEvent,
        decision: ContinuousFallDecision,
    ) -> RuntimeEvent:
        self._continuous_event_counter += 1
        score = self._score()
        frame = frame_event.payload
        evidence = {
            **self._model_evidence(score),
            **decision.evidence,
            "deterministic_transition": None,
            "reasons": ["continuous_fall_confirmed"],
        }
        return RuntimeEvent(
            session_id=frame_event.session_id,
            sequence=frame_event.sequence,
            event_type=RuntimeEventType.TRANSITION_EVENT,
            payload={
                "schema_version": TRANSITION_SCHEMA_VERSION,
                "scene_id": str(frame.get("scene_id", "runtime")),
                "event_id": f"continuous-fall-{self._continuous_event_counter:04d}",
                "start_ms": round(float(decision.start_ms or 0.0), 3),
                "end_ms": round(float(decision.end_ms or frame.get("timestamp_ms", 0.0)), 3),
                "transition": "fall_like_transition",
                "transition_confidence": round(decision.confidence, 6),
                "evidence": evidence,
                "landmark_quality": str(frame.get("landmark_quality", "degraded")),
            },
        )

    def _model_evidence(self, score: FallMILScore) -> dict[str, object]:
        return {
            "fall_mil_model": self.model_name,
            "fall_mil_probability": round(score.probability, 6),
            "fall_mil_threshold": round(score.threshold, 6),
            "fall_mil_candidate_eligible": score.candidate_eligible,
            "fall_mil_confirmed": score.confirmed,
            "fall_mil_window_start_ms": score.start_ms,
            "fall_mil_window_end_ms": score.end_ms,
        }

    def _recover_if_safe(self, posture: dict[str, Any]) -> None:
        if not self._fall_latched or self._fall_latched_at_ms is None:
            return
        label = posture.get("posture")
        motion = posture.get("motion_level")
        duration = posture.get("posture_duration_ms")
        timestamp = posture.get("timestamp_ms")
        if (
            label in {"standing", "sitting"}
            and motion in {"still", "low"}
            and isinstance(duration, int | float)
            and isinstance(timestamp, int | float)
            and float(duration)
            >= self.continuous_config.recovery_posture_duration_ms
            and float(timestamp) - self._fall_latched_at_ms
            >= self.continuous_config.minimum_latch_ms
        ):
            self._fall_latched = False
            self._fall_latched_at_ms = None
            self._samples.clear()
            self._previous_frame = None
            self._last_evaluation_ms = None

    def _latch_fall(self, timestamp_ms: float) -> None:
        self._fall_latched = True
        self._fall_latched_at_ms = max(timestamp_ms, 0.0)

    def _score(self) -> FallMILScore:
        try:
            return score_fall_samples(
                self.model,
                tuple(self._samples),
                bag_id=f"runtime-{self.session_id}",
            )
        except ValueError:
            return FallMILScore(0.0, self.model.threshold, False, None, None)


def _runtime_bag(
    session_id: str,
    samples: tuple[FallPoseSample, ...],
) -> FallBag:
    return FallBag(
        bag_id=f"runtime-{session_id}",
        split="test",
        label="normal",
        category="runtime",
        samples=samples,
    )


def _continuous_confidence(
    features: dict[str, float],
    *,
    probability: float,
    config: ContinuousFallConfig,
    impulse_confirmed: bool,
) -> float:
    if not impulse_confirmed:
        return min(max(probability, 0.75), 0.99)
    drop_excess = min(
        max(features["center_drop"] / config.minimum_center_drop - 1.0, 0.0),
        1.0,
    )
    kinetic_ratio = max(
        features["peak_motion_speed"] / config.minimum_peak_motion_speed,
        features["max_downward_center_speed"] / config.minimum_downward_speed,
    )
    kinetic_excess = min(max(kinetic_ratio - 1.0, 0.0), 1.0)
    torso_excess = min(
        max(features["torso_range_deg"] / config.minimum_torso_range_deg - 1.0, 0.0),
        1.0,
    )
    motion_excess = min(
        max(
            features["high_motion_ratio"] / config.minimum_high_motion_ratio - 1.0,
            0.0,
        ),
        1.0,
    )
    return min(
        0.70
        + 0.08 * drop_excess
        + 0.08 * kinetic_excess
        + 0.05 * torso_excess
        + 0.04 * motion_excess,
        0.95,
    )
