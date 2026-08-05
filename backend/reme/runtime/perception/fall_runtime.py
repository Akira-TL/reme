"""Attach the weakly supervised fall MIL model to live transition candidates."""

from __future__ import annotations

from collections import deque
from pathlib import Path
from typing import Any

from reme.pose.fall_mil import FallMILModel, FallMILScore, score_fall_samples
from reme.pose.fall_training_data import derive_fall_pose_sample
from reme.pose.fall_weak_labels import FallPoseSample
from reme.pose.posture import PosturePrediction
from reme.pose.runtime import RuntimeEvent, RuntimeEventType
from reme.pose.transitions import TransitionDetector, TransitionDetectorConfig

DEFAULT_FALL_MIL_MODEL = Path("models/trained/fall/mil-v3/model.json")


class FallRuntimeError(RuntimeError):
    """Raised when the runtime MIL enhancer receives incompatible events."""


class FallMILTransitionEnhancer:
    """Decorate deterministic transition events with the MIL v3 score.

    The deterministic detector remains the primary event generator.  MIL is
    only allowed to upgrade an ``uncertain_transition`` when the frozen
    candidate gate and validation threshold both pass.  Existing deterministic
    fall candidates are preserved, avoiding a regression when a live window is
    shorter than the MIL model's 1.5 second minimum.
    """

    def __init__(
        self,
        *,
        session_id: str,
        model: FallMILModel,
        config: TransitionDetectorConfig | None = None,
        score_threshold: float = 0.2,
    ) -> None:
        self.session_id = session_id
        self.model = model
        self.detector = TransitionDetector(session_id=session_id, config=config)
        self.score_threshold = score_threshold
        self._samples: deque[FallPoseSample] = deque()
        self._latest_posture: dict[str, Any] | None = None
        self._previous_frame: dict[str, Any] | None = None

    @classmethod
    def load(
        cls,
        *,
        session_id: str,
        model_path: str | Path,
        config: TransitionDetectorConfig | None = None,
        score_threshold: float = 0.2,
    ) -> FallMILTransitionEnhancer:
        return cls(
            session_id=session_id,
            model=FallMILModel.load(model_path),
            config=config,
            score_threshold=score_threshold,
        )

    def reset(self, *, session_id: str) -> None:
        self.session_id = session_id
        self.detector.reset(session_id=session_id)
        self._samples.clear()
        self._latest_posture = None
        self._previous_frame = None

    def process_runtime_event(self, event: RuntimeEvent) -> RuntimeEvent | None:
        if event.event_type is RuntimeEventType.POSTURE_OBSERVATION:
            self._latest_posture = event.payload
            return self.detector.process_runtime_event(event)
        if event.event_type is not RuntimeEventType.FRAME_LANDMARKS:
            return self.detector.process_runtime_event(event)

        self._append_sample(event.payload)
        transition = self.detector.process_runtime_event(event)
        if transition is None:
            return None
        return self._enhance(transition)

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
            probabilities={str(posture.get("posture", "unknown")): float(
                posture.get("posture_confidence", 0.0)
            )},
            visible_keypoint_ratio=float(posture.get("visible_keypoint_ratio", 0.0)),
            classification_source=str(posture.get("classification_source", "runtime")),
        )

    def _enhance(self, event: RuntimeEvent) -> RuntimeEvent:
        score = self._score()
        payload = dict(event.payload)
        evidence = dict(payload.get("evidence") or {})
        evidence.update(
            {
                "fall_mil_model": "mil-v3",
                "fall_mil_probability": round(score.probability, 6),
                "fall_mil_threshold": round(score.threshold, 6),
                "fall_mil_candidate_eligible": score.candidate_eligible,
                "fall_mil_confirmed": score.confirmed,
                "fall_mil_window_start_ms": score.start_ms,
                "fall_mil_window_end_ms": score.end_ms,
                "deterministic_transition": payload.get("transition"),
            }
        )
        if payload.get("transition") == "uncertain_transition" and score.confirmed:
            payload["transition"] = "fall_like_transition"
            payload["transition_confidence"] = round(
                max(float(payload.get("transition_confidence", 0.0)), score.probability),
                6,
            )
            reasons = evidence.get("reasons")
            evidence["reasons"] = sorted(
                set((reasons if isinstance(reasons, list) else []) + ["fall_mil_confirmed"])
            )
        payload["evidence"] = evidence
        return RuntimeEvent(
            session_id=event.session_id,
            sequence=event.sequence,
            event_type=event.event_type,
            payload=payload,
        )

    def _score(self) -> FallMILScore:
        try:
            return score_fall_samples(
                self.model,
                tuple(self._samples),
                bag_id=f"runtime-{self.session_id}",
            )
        except ValueError:
            return FallMILScore(0.0, self.model.threshold, False, None, None)
