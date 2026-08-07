from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from reme.runtime.perception.fall_mil import (
    FALL_WINDOW_FEATURE_NAMES,
    FallMILScore,
    FallWindow,
    FallWindowConfig,
)
from reme.runtime.perception.fall_runtime import (
    ContinuousFallDecision,
    FallMILTransitionEnhancer,
)
from reme.runtime.perception.runtime import RuntimeEvent, RuntimeEventType


@dataclass(frozen=True, slots=True)
class _FakeModel:
    probability: float = 0.1
    threshold: float = 0.99
    window_config: FallWindowConfig = FallWindowConfig()

    def predict_probability(self, features: tuple[float, ...]) -> float:
        assert len(features) == len(FALL_WINDOW_FEATURE_NAMES)
        return self.probability


class _NoopDetector:
    def process_runtime_event(self, event: RuntimeEvent) -> RuntimeEvent | None:
        return None

    def reset(self, *, session_id: str) -> None:
        return None


class _StubContinuousEnhancer(FallMILTransitionEnhancer):
    def __init__(self, decision: ContinuousFallDecision) -> None:
        super().__init__(session_id="session", model=_FakeModel())
        self.detector = _NoopDetector()  # type: ignore[assignment]
        self.decision = decision

    def _append_sample(self, frame: dict[str, Any]) -> None:
        return None

    def _continuous_decision(self, frame: dict[str, Any]) -> ContinuousFallDecision:
        return self.decision

    def _score(self) -> FallMILScore:
        return FallMILScore(0.1, 0.99, False, None, None)


def _window(**overrides: float) -> FallWindow:
    values = {name: 0.0 for name in FALL_WINDOW_FEATURE_NAMES}
    values.update(
        {
            "duration_s": 2.0,
            "center_start": 0.52,
            "center_end": 0.76,
            "center_drop": 0.24,
            "max_downward_center_speed": 0.9,
            "torso_range_deg": 72.0,
            "peak_motion_speed": 0.8,
            "high_motion_ratio": 0.4,
            "has_fallen_anchor": 1.0,
        }
    )
    values.update(overrides)
    return FallWindow(
        bag_id="case",
        split="test",
        label="normal",
        category="runtime",
        start_ms=1000.0,
        end_ms=3000.0,
        features=tuple(values[name] for name in FALL_WINDOW_FEATURE_NAMES),
    )


def _frame(sequence: int, timestamp_ms: float) -> RuntimeEvent:
    return RuntimeEvent(
        session_id="session",
        sequence=sequence,
        event_type=RuntimeEventType.FRAME_LANDMARKS,
        payload={
            "scene_id": "room",
            "timestamp_ms": timestamp_ms,
            "landmark_quality": "usable",
        },
    )


def _recovery_posture() -> RuntimeEvent:
    return RuntimeEvent(
        session_id="session",
        sequence=10,
        event_type=RuntimeEventType.POSTURE_OBSERVATION,
        payload={
            "scene_id": "room",
            "posture": "standing",
            "motion_level": "still",
            "posture_duration_ms": 6000.0,
            "timestamp_ms": 14000.0,
        },
    )


def test_impulse_window_confirms_independently_of_model_probability() -> None:
    enhancer = FallMILTransitionEnhancer(session_id="session", model=_FakeModel())

    decision = enhancer._window_decision(_window())

    assert decision.confirmed is True
    assert decision.source == "continuous_impulse"
    assert decision.confidence >= 0.7


def test_slow_lie_down_window_is_rejected() -> None:
    enhancer = FallMILTransitionEnhancer(
        session_id="session",
        model=_FakeModel(probability=0.9999),
    )

    decision = enhancer._window_decision(
        _window(
            center_start=0.67,
            center_drop=0.06,
            max_downward_center_speed=0.45,
            peak_motion_speed=0.5,
            high_motion_ratio=0.08,
        )
    )

    assert decision.confirmed is False


def test_continuous_event_is_latched_until_stable_recovery() -> None:
    decision = ContinuousFallDecision(
        confirmed=True,
        confidence=0.88,
        source="continuous_impulse",
        start_ms=1000.0,
        end_ms=3000.0,
        model_probability=0.2,
        evidence={"continuous_source": "continuous_impulse"},
    )
    enhancer = _StubContinuousEnhancer(decision)

    first = enhancer.process_runtime_event(_frame(1, 3000.0))
    duplicate = enhancer.process_runtime_event(_frame(2, 3250.0))
    enhancer.process_runtime_event(_recovery_posture())
    after_recovery = enhancer.process_runtime_event(_frame(3, 6000.0))

    assert first is not None
    assert first.payload["transition"] == "fall_like_transition"
    assert duplicate is None
    assert after_recovery is not None
    assert after_recovery.payload["transition"] == "fall_like_transition"
