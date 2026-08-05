from __future__ import annotations

import json
from pathlib import Path

from reme.pose.fall_mil import FallMILModel, FallMILScore, score_fall_samples
from reme.pose.fall_runtime import FallMILTransitionEnhancer
from reme.pose.fall_weak_labels import FallPoseSample
from reme.pose.runtime import RuntimeEvent, RuntimeEventType

_MODEL_PATH = Path("models/trained/fall/mil-v3/model.json")
_SAMPLES_PATH = Path("artifacts/pose-classification/fall-50/bootstrap/pose-samples.jsonl")


def _fall_002_samples() -> tuple[FallPoseSample, ...]:
    samples: list[FallPoseSample] = []
    for line in _SAMPLES_PATH.read_text(encoding="utf-8").splitlines():
        payload = json.loads(line)
        if payload.get("scene_id") != "fall-002":
            continue
        samples.append(
            FallPoseSample(
                timestamp_ms=float(payload["timestamp_ms"]),
                posture=str(payload["posture"]),
                posture_confidence=float(payload["posture_confidence"]),
                center_y=float(payload["center_y"]),
                torso_angle_deg=float(payload["torso_angle_deg"]),
                bbox_aspect_ratio=float(payload["bbox_aspect_ratio"]),
                motion_speed=float(payload["motion_speed"]),
                visible_keypoint_ratio=float(payload["visible_keypoint_ratio"]),
                landmark_quality=str(payload["landmark_quality"]),
            )
        )
    return tuple(samples)


def _transition_event(transition: str = "uncertain_transition") -> RuntimeEvent:
    return RuntimeEvent(
        session_id="session-live",
        sequence=42,
        event_type=RuntimeEventType.TRANSITION_EVENT,
        payload={
            "schema_version": "reme-transition/v0-experiment",
            "scene_id": "fall",
            "event_id": "transition-0001",
            "start_ms": 1000.0,
            "end_ms": 3000.0,
            "transition": transition,
            "transition_confidence": 0.35,
            "evidence": {"reasons": ["missing_posture_context"]},
            "landmark_quality": "usable",
        },
    )


def test_mil_v3_scores_known_positive_training_bag() -> None:
    model = FallMILModel.load(_MODEL_PATH)

    score = score_fall_samples(model, _fall_002_samples(), bag_id="fall-002")

    assert score.candidate_eligible is True
    assert score.confirmed is True
    assert score.probability > 0.98
    assert score.threshold == model.threshold


def test_runtime_enhancer_upgrades_only_confirmed_uncertain_candidate() -> None:
    model = FallMILModel.load(_MODEL_PATH)

    class ConfirmingEnhancer(FallMILTransitionEnhancer):
        def _score(self) -> FallMILScore:
            return FallMILScore(0.91, self.model.threshold, True, 1000.0, 3000.0)

    enhancer = ConfirmingEnhancer(session_id="session-live", model=model)

    result = enhancer._enhance(_transition_event())

    assert result.payload["transition"] == "fall_like_transition"
    assert result.payload["transition_confidence"] == 0.91
    assert result.payload["evidence"]["fall_mil_confirmed"] is True
    assert result.payload["evidence"]["deterministic_transition"] == "uncertain_transition"


def test_runtime_enhancer_preserves_deterministic_fall_without_mil_window() -> None:
    model = FallMILModel.load(_MODEL_PATH)

    class AbstainingEnhancer(FallMILTransitionEnhancer):
        def _score(self) -> FallMILScore:
            return FallMILScore(0.0, self.model.threshold, False, None, None)

    enhancer = AbstainingEnhancer(session_id="session-live", model=model)

    result = enhancer._enhance(_transition_event("fall_like_transition"))

    assert result.payload["transition"] == "fall_like_transition"
    assert result.payload["evidence"]["fall_mil_confirmed"] is False
    assert result.payload["evidence"]["deterministic_transition"] == "fall_like_transition"
