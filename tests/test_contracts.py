from datetime import UTC, datetime

import pytest
from reme.contracts import EventCandidate, EventType


def test_event_candidate_serializes_for_decision_agent() -> None:
    candidate = EventCandidate(
        event_type=EventType.POSSIBLE_FALL,
        confidence=0.82,
        observed_at=datetime(2026, 8, 1, 0, 30, tzinfo=UTC),
        duration_ms=1200,
        features={"torso_angle_change_deg": 74.0},
    )

    assert candidate.to_payload() == {
        "schema_version": "0.1",
        "event_type": "possible_fall",
        "confidence": 0.82,
        "observed_at": "2026-08-01T00:30:00+00:00",
        "duration_ms": 1200,
        "features": {"torso_angle_change_deg": 74.0},
    }


def test_event_candidate_rejects_invalid_confidence() -> None:
    with pytest.raises(ValueError, match="confidence"):
        EventCandidate(
            event_type=EventType.POSSIBLE_FALL,
            confidence=1.1,
            observed_at=datetime.now(UTC),
        )
