"""Server-owned deadline integration without any browser timeout producer."""

from __future__ import annotations

import threading
import time

from reme.runtime.decision.context import (
    LandmarkQuality,
    MotionLevel,
    Posture,
    PostureObservation,
    Transition,
    TransitionEvent,
)
from reme.runtime.decision.deadline import MonotonicDeadlineScheduler
from reme.runtime.decision.guardrails import TriggerConfig
from reme.runtime.decision.policy import DecisionService, PolicyConfig
from reme.runtime.decision.records import (
    CareDecision,
    DecisionState,
    DemoMode,
    InteractionResponse,
    ResponseSource,
    ResponseValue,
)
from reme.runtime.decision.stream import LiveStreams

SCENE_ID = "fall_demo_01"


class _Publisher:
    def __init__(self) -> None:
        self.decisions: list[CareDecision] = []
        self._condition = threading.Condition()

    def publish_decision(self, decision: CareDecision) -> None:
        with self._condition:
            self.decisions.append(decision)
            self._condition.notify_all()

    def wait_for_count(self, count: int, timeout: float = 1.0) -> bool:
        deadline = time.monotonic() + timeout
        with self._condition:
            while len(self.decisions) < count:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(remaining)
            return True


def _fall_streams() -> LiveStreams:
    posture = PostureObservation(
        scene_id=SCENE_ID,
        timestamp_ms=12_800.0,
        person_detected=True,
        posture=Posture.LYING,
        posture_confidence=0.9,
        posture_duration_ms=2_000.0,
        motion_level=MotionLevel.STILL,
        landmark_quality=LandmarkQuality.USABLE,
    )
    transition = TransitionEvent(
        scene_id=SCENE_ID,
        event_id="transition-0001",
        start_ms=11_100.0,
        end_ms=12_700.0,
        transition=Transition.FALL_LIKE,
        transition_confidence=0.85,
        evidence={},
        landmark_quality=LandmarkQuality.USABLE,
    )
    return LiveStreams(scene_id=SCENE_ID, postures=(posture,), transitions=(transition,))


def _service(
    scheduler: MonotonicDeadlineScheduler,
    publisher: _Publisher,
    *,
    timeout_ms: int,
    family_ack_timeout_ms: int = 500,
) -> DecisionService:
    return DecisionService(
        scenes={SCENE_ID: _fall_streams()},
        config=PolicyConfig(
            trigger=TriggerConfig(
                check_in_timeout_ms=timeout_ms,
                family_ack_timeout_ms=family_ack_timeout_ms,
            )
        ),
        publisher=publisher,
        deadline_scheduler=scheduler,
    )


def test_backend_escalates_after_deadline_without_browser_response() -> None:
    scheduler = MonotonicDeadlineScheduler()
    publisher = _Publisher()
    service = _service(scheduler, publisher, timeout_ms=35)
    try:
        check_in = service.get_decision(scene_id=SCENE_ID, timestamp_ms=13_000.0)
        assert check_in.state is DecisionState.CHECK_IN_REQUIRED
        assert check_in.response_deadline_ms is not None

        # No InteractionResponse is submitted: the runtime deadline is the only
        # producer of the next authoritative decision.
        assert publisher.wait_for_count(2)
        alert = publisher.decisions[-1]
        assert alert.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
        assert alert.alarm is not None
        assert alert.source.value == "rule"
        assert alert.timestamp_ms == check_in.timestamp_ms
    finally:
        scheduler.close()


def test_real_response_cancels_the_stale_deadline() -> None:
    scheduler = MonotonicDeadlineScheduler()
    publisher = _Publisher()
    service = _service(scheduler, publisher, timeout_ms=120)
    try:
        check_in = service.get_decision(scene_id=SCENE_ID, timestamp_ms=13_000.0)
        resolved = service.submit_response(
            InteractionResponse(
                scene_id=SCENE_ID,
                decision_id=check_in.decision_id,
                timestamp_ms=13_100.0,
                response=ResponseValue.SAFE,
                source=ResponseSource.USER_INPUT,
                demo_mode=DemoMode.LIVE,
            )
        )
        assert resolved.state is DecisionState.RESOLVED
        time.sleep(0.18)
        assert [decision.state for decision in publisher.decisions] == [
            DecisionState.CHECK_IN_REQUIRED,
            DecisionState.RESOLVED,
        ]
    finally:
        scheduler.close()


def test_backend_reschedules_the_family_ack_deadline_to_urgent() -> None:
    scheduler = MonotonicDeadlineScheduler()
    publisher = _Publisher()
    service = _service(
        scheduler,
        publisher,
        timeout_ms=25,
        family_ack_timeout_ms=30,
    )
    try:
        service.get_decision(scene_id=SCENE_ID, timestamp_ms=13_000.0)
        assert publisher.wait_for_count(3)
        assert [decision.state for decision in publisher.decisions] == [
            DecisionState.CHECK_IN_REQUIRED,
            DecisionState.FAMILY_NOTIFICATION_REQUIRED,
            DecisionState.URGENT_ATTENTION,
        ]
    finally:
        scheduler.close()


def test_scene_reset_cancels_the_stale_deadline() -> None:
    scheduler = MonotonicDeadlineScheduler()
    publisher = _Publisher()
    service = _service(scheduler, publisher, timeout_ms=80)
    try:
        service.get_decision(scene_id=SCENE_ID, timestamp_ms=13_000.0)
        service.reset_scene(SCENE_ID)
        time.sleep(0.14)
        assert len(publisher.decisions) == 1
    finally:
        scheduler.close()
