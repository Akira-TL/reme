from datetime import UTC, datetime

from reme.care import CheckInResponse, DecisionAction, run_care_sequence
from reme.motion import MotionObservation

STARTED_AT = datetime(2026, 8, 1, 0, 30, tzinfo=UTC)


def upright_sequence() -> list[MotionObservation]:
    return [
        MotionObservation(offset_ms=0, torso_angle_deg=8.0, center_y=0.42, visibility=0.96),
        MotionObservation(offset_ms=500, torso_angle_deg=12.0, center_y=0.43, visibility=0.95),
        MotionObservation(offset_ms=1000, torso_angle_deg=10.0, center_y=0.42, visibility=0.97),
    ]


def fall_like_sequence(*, visibility: float = 0.95) -> list[MotionObservation]:
    return [
        MotionObservation(
            offset_ms=0,
            torso_angle_deg=9.0,
            center_y=0.36,
            visibility=visibility,
        ),
        MotionObservation(
            offset_ms=600,
            torso_angle_deg=31.0,
            center_y=0.48,
            visibility=visibility,
        ),
        MotionObservation(
            offset_ms=1200,
            torso_angle_deg=78.0,
            center_y=0.72,
            visibility=visibility,
        ),
    ]


def test_upright_motion_emits_no_event_or_escalation() -> None:
    result = run_care_sequence(upright_sequence(), started_at=STARTED_AT)

    assert result.events == ()
    assert result.decisions == ()
    assert result.status == "normal"


def test_fall_like_motion_checks_in_then_notifies_family_after_no_response() -> None:
    result = run_care_sequence(
        fall_like_sequence(),
        started_at=STARTED_AT,
        check_in_response=CheckInResponse.NO_RESPONSE,
    )

    assert len(result.events) == 1
    event = result.events[0]
    assert event.event_type.value == "possible_fall"
    assert event.duration_ms == 1200
    assert event.features == {
        "angle_change_deg": 69.0,
        "center_drop": 0.36,
        "minimum_visibility": 0.95,
        "transition_ms": 1200.0,
    }
    assert [decision.action for decision in result.decisions] == [
        DecisionAction.LOCAL_CHECK_IN,
        DecisionAction.FAMILY_NOTIFICATION,
    ]
    assert result.status == "family_notified"


def test_safe_response_stops_after_local_check_in() -> None:
    result = run_care_sequence(
        fall_like_sequence(),
        started_at=STARTED_AT,
        check_in_response=CheckInResponse.SAFE,
    )

    assert [decision.action for decision in result.decisions] == [
        DecisionAction.LOCAL_CHECK_IN
    ]
    assert result.status == "resolved_safe"


def test_low_visibility_motion_does_not_become_a_fall_event() -> None:
    result = run_care_sequence(
        fall_like_sequence(visibility=0.30),
        started_at=STARTED_AT,
    )

    assert result.events == ()
    assert [decision.action for decision in result.decisions] == [
        DecisionAction.MANUAL_REVIEW
    ]
    assert result.status == "insufficient_motion_data"
