from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from reme.runtime.decision.authorization import (
    FALL_AUTHORIZATION_TTL_MS,
    KITCHEN_AUTHORIZATION_TTL_MS,
    MediaAuthorizationScope,
)
from reme.runtime.decision.context import (
    LandmarkQuality,
    MotionLevel,
    Posture,
    PostureObservation,
    Transition,
    TransitionEvent,
)
from reme.runtime.decision.policy import DecisionService, PolicyConfig
from reme.runtime.decision.records import (
    DemoMode,
    InteractionResponse,
    PrivacyMode,
    ResponseSource,
    ResponseValue,
    parse_care_decision,
)
from reme.runtime.decision.state_machine import DemoConversationKind


@dataclass(frozen=True)
class _Streams:
    scene_id: str
    postures: tuple[PostureObservation, ...] = ()
    transitions: tuple[TransitionEvent, ...] = ()


class _Handle:
    def __init__(self) -> None:
        self.cancelled = False

    def cancel(self) -> None:
        self.cancelled = True


class _Scheduler:
    def __init__(self) -> None:
        self.calls: list[tuple[float, Callable[[], None], _Handle]] = []

    def call_later(self, delay_seconds: float, callback: Callable[[], None]) -> _Handle:
        handle = _Handle()
        self.calls.append((delay_seconds, callback, handle))
        return handle

    def close(self) -> None:
        for _, _, handle in self.calls:
            handle.cancel()


class _Clock:
    def __init__(self) -> None:
        self.monotonic_seconds = 100.0
        self.wall_seconds = 1_800_000_000.0

    def monotonic(self) -> float:
        return self.monotonic_seconds

    def wall(self) -> float:
        return self.wall_seconds

    def advance(self, seconds: float) -> None:
        self.monotonic_seconds += seconds
        self.wall_seconds += seconds


def _response(scene_id: str, decision_id: str, value: ResponseValue) -> InteractionResponse:
    return InteractionResponse(
        scene_id=scene_id,
        decision_id=decision_id,
        timestamp_ms=20_000.0,
        response=value,
        source=(
            ResponseSource.FAMILY_INPUT
            if value is ResponseValue.ALARM_ACKNOWLEDGED
            else ResponseSource.USER_INPUT
        ),
        demo_mode=DemoMode.LIVE,
    )


def _service(
    streams: _Streams,
    *,
    clock: _Clock,
    privacy_mode: PrivacyMode | None = None,
) -> DecisionService:
    scene_privacy = {} if privacy_mode is None else {streams.scene_id: privacy_mode}
    return DecisionService(
        scenes={streams.scene_id: streams},  # type: ignore[arg-type]
        config=PolicyConfig(scene_privacy=scene_privacy),
        timeout_scheduler=_Scheduler(),
        monotonic=clock.monotonic,
        wall_clock=clock.wall,
    )


def _fall_streams(scene_id: str = "fall") -> _Streams:
    posture = PostureObservation(
        scene_id=scene_id,
        timestamp_ms=12_800.0,
        person_detected=True,
        posture=Posture.LYING,
        posture_confidence=0.95,
        posture_duration_ms=2_000.0,
        motion_level=MotionLevel.STILL,
        landmark_quality=LandmarkQuality.USABLE,
    )
    transition = TransitionEvent(
        scene_id=scene_id,
        event_id="transition-fall-1",
        start_ms=11_100.0,
        end_ms=12_700.0,
        transition=Transition.FALL_LIKE,
        transition_confidence=0.9,
        evidence={},
        landmark_quality=LandmarkQuality.USABLE,
    )
    return _Streams(scene_id=scene_id, postures=(posture,), transitions=(transition,))


def test_kitchen_consent_creates_recoverable_sixty_second_authorization() -> None:
    clock = _Clock()
    service = _service(_Streams(scene_id="kitchen"), clock=clock)
    request = service.start_demo_conversation(
        scene_id="kitchen",
        kind=DemoConversationKind.KITCHEN_SHARE,
        timestamp_ms=1_000.0,
    )
    granted = service.submit_response(
        _response("kitchen", request.decision_id, ResponseValue.CONSENT_GRANTED)
    )

    authorization = granted.media_authorization
    assert authorization is not None
    assert authorization.scope is MediaAuthorizationScope.KITCHEN_MOMENT
    assert authorization.decision_id == granted.decision_id
    assert authorization.ttl_ms == KITCHEN_AUTHORIZATION_TTL_MS
    assert service.current_media_authorization("kitchen") == authorization
    assert parse_care_decision(granted.to_payload()) == granted

    clock.advance(KITCHEN_AUTHORIZATION_TTL_MS / 1000.0)
    assert service.current_media_authorization("kitchen") is None
    service.close()


def test_scene_reset_revokes_kitchen_authorization() -> None:
    clock = _Clock()
    service = _service(_Streams(scene_id="kitchen"), clock=clock)
    request = service.start_demo_conversation(
        scene_id="kitchen",
        kind=DemoConversationKind.KITCHEN_SHARE,
        timestamp_ms=1_000.0,
    )
    service.submit_response(
        _response("kitchen", request.decision_id, ResponseValue.CONSENT_GRANTED)
    )
    assert service.current_media_authorization("kitchen") is not None

    service.reset_scene("kitchen")
    assert service.current_media_authorization("kitchen") is None
    service.close()


def test_skeleton_only_privacy_blocks_kitchen_clear_video_authorization() -> None:
    clock = _Clock()
    service = _service(
        _Streams(scene_id="kitchen"),
        clock=clock,
        privacy_mode=PrivacyMode.SKELETON_ONLY,
    )
    request = service.start_demo_conversation(
        scene_id="kitchen",
        kind=DemoConversationKind.KITCHEN_SHARE,
        timestamp_ms=1_000.0,
    )
    granted = service.submit_response(
        _response("kitchen", request.decision_id, ResponseValue.CONSENT_GRANTED)
    )
    assert granted.media_authorization is None
    assert service.current_media_authorization("kitchen") is None
    service.close()


def test_authoritative_fall_alarm_creates_thirty_second_authorization() -> None:
    clock = _Clock()
    service = _service(_fall_streams(), clock=clock)
    check_in = service.get_decision(scene_id="fall", timestamp_ms=13_000.0)
    assert check_in.media_authorization is None

    alert = service.confirm_danger(scene_id="fall", timestamp_ms=13_100.0, note="test")
    assert alert is not None
    authorization = alert.media_authorization
    assert authorization is not None
    assert authorization.scope is MediaAuthorizationScope.FALL_EMERGENCY
    assert authorization.event_id == "transition-fall-1"
    assert authorization.ttl_ms == FALL_AUTHORIZATION_TTL_MS
    assert service.current_media_authorization("fall") == authorization
    service.close()


def test_alarm_acknowledgement_revokes_fall_authorization() -> None:
    clock = _Clock()
    service = _service(_fall_streams(), clock=clock)
    service.get_decision(scene_id="fall", timestamp_ms=13_000.0)
    alert = service.confirm_danger(scene_id="fall", timestamp_ms=13_100.0, note="test")
    assert alert is not None and alert.media_authorization is not None

    resolved = service.submit_response(
        _response("fall", alert.decision_id, ResponseValue.ALARM_ACKNOWLEDGED)
    )
    assert resolved.media_authorization is None
    assert service.current_media_authorization("fall") is None
    service.close()


def test_bathroom_never_gets_clear_video_authorization_even_for_fall() -> None:
    clock = _Clock()
    service = _service(_fall_streams(scene_id="bathroom"), clock=clock)
    service.get_decision(scene_id="bathroom", timestamp_ms=13_000.0)
    alert = service.confirm_danger(scene_id="bathroom", timestamp_ms=13_100.0, note="test")
    assert alert is not None
    assert alert.media_authorization is None
    assert service.current_media_authorization("bathroom") is None
    service.close()
