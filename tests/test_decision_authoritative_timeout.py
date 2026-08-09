"""Backend-owned care-decision timeout and race tests."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from reme.runtime.decision.context import load_scene_streams
from reme.runtime.decision.policy import DecisionRejectedError, DecisionService, PolicyConfig
from reme.runtime.decision.records import (
    AlarmTrigger,
    CareDecision,
    DecisionState,
    DemoMode,
    InteractionResponse,
    ResponseSource,
    ResponseValue,
)


def _fall_scenes(tmp_path: Path) -> dict[str, Any]:
    bundle_dir = tmp_path / "fall_demo_01"
    bundle_dir.mkdir(parents=True)
    manifest = {
        "schema_version": "reme-scene/v0-experiment",
        "scene_id": "fall_demo_01",
        "title": "fall_demo_01",
        "media": {
            "local_path": "media/source.mp4",
            "sha256": "0" * 64,
            "width": 1280,
            "height": 720,
            "fps": 30.0,
            "frame_count": 2370,
            "duration_ms": 79000,
        },
        "streams": {
            "keypoints_2d": "keypoints_2d.jsonl",
            "keypoints_3d": None,
            "posture_observations": "posture_observations.jsonl",
            "transition_events": "transition_events.jsonl",
            "recorded_decisions": None,
        },
    }
    manifest_path = bundle_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    posture = {
        "schema_version": "reme-posture/v0-experiment",
        "scene_id": "fall_demo_01",
        "timestamp_ms": 12800.0,
        "person_detected": True,
        "posture": "lying",
        "posture_confidence": 0.9,
        "posture_duration_ms": 2000.0,
        "motion_level": "still",
        "landmark_quality": "usable",
    }
    transition = {
        "schema_version": "reme-transition/v0-experiment",
        "scene_id": "fall_demo_01",
        "event_id": "transition-0001",
        "start_ms": 11100.0,
        "end_ms": 12700.0,
        "transition": "fall_like_transition",
        "transition_confidence": 0.85,
        "evidence": {},
        "landmark_quality": "usable",
    }
    (bundle_dir / "posture_observations.jsonl").write_text(
        json.dumps(posture) + "\n", encoding="utf-8"
    )
    (bundle_dir / "transition_events.jsonl").write_text(
        json.dumps(transition) + "\n", encoding="utf-8"
    )
    return {"fall_demo_01": load_scene_streams(manifest_path)}


def _response(
    *,
    decision_id: str,
    value: ResponseValue,
    timestamp_ms: float = 13100.0,
    source: ResponseSource = ResponseSource.USER_INPUT,
) -> InteractionResponse:
    return InteractionResponse(
        scene_id="fall_demo_01",
        decision_id=decision_id,
        timestamp_ms=timestamp_ms,
        response=value,
        source=source,
        demo_mode=DemoMode.LIVE,
    )


class _ManualTimeoutHandle:
    def __init__(self, delay_seconds: float, callback: Callable[[], None]) -> None:
        self.delay_seconds = delay_seconds
        self.callback = callback
        self.cancelled = False
        self.fired = False

    def cancel(self) -> None:
        self.cancelled = True

    def fire(self, *, even_if_cancelled: bool = False) -> None:
        if self.fired or (self.cancelled and not even_if_cancelled):
            return
        self.fired = True
        self.callback()


class _ManualTimeoutScheduler:
    def __init__(self) -> None:
        self.handles: list[_ManualTimeoutHandle] = []
        self.closed = False

    def call_later(
        self, delay_seconds: float, callback: Callable[[], None]
    ) -> _ManualTimeoutHandle:
        assert not self.closed
        handle = _ManualTimeoutHandle(delay_seconds, callback)
        self.handles.append(handle)
        return handle

    def active(self) -> list[_ManualTimeoutHandle]:
        return [handle for handle in self.handles if not handle.cancelled and not handle.fired]

    def close(self) -> None:
        self.closed = True
        for handle in self.handles:
            handle.cancel()


class _CapturePublisher:
    def __init__(self) -> None:
        self.decisions: list[CareDecision] = []

    def publish_decision(self, decision: CareDecision) -> None:
        self.decisions.append(decision)


def _service(
    tmp_path: Path,
) -> tuple[DecisionService, _ManualTimeoutScheduler, _CapturePublisher, list[float]]:
    scheduler = _ManualTimeoutScheduler()
    publisher = _CapturePublisher()
    now = [1000.0]
    service = DecisionService(
        scenes=_fall_scenes(tmp_path),
        config=PolicyConfig(),
        publisher=publisher,
        timeout_scheduler=scheduler,
        monotonic=lambda: now[0],
    )
    return service, scheduler, publisher, now


def _open_check_in(service: DecisionService) -> CareDecision:
    decision = service.get_decision(scene_id="fall_demo_01", timestamp_ms=13000.0)
    assert decision.state is DecisionState.CHECK_IN_REQUIRED
    return decision


def test_backend_timeout_escalates_without_frontend_response(tmp_path: Path) -> None:
    service, scheduler, publisher, _ = _service(tmp_path)
    check_in = _open_check_in(service)
    handle = scheduler.active()[0]
    assert handle.delay_seconds == pytest.approx(2.5)

    handle.fire()

    alert = service.current_decision("fall_demo_01")
    assert alert is not None
    assert alert.decision_id != check_in.decision_id
    assert alert.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert alert.alarm is not None
    assert alert.alarm.trigger is AlarmTrigger.CHECK_IN_TIMEOUT
    assert publisher.decisions[-1].decision_id == alert.decision_id


def test_safe_response_cancels_backend_timeout(tmp_path: Path) -> None:
    service, scheduler, publisher, _ = _service(tmp_path)
    check_in = _open_check_in(service)
    stale = scheduler.active()[0]

    resolved = service.submit_response(
        _response(decision_id=check_in.decision_id, value=ResponseValue.SAFE)
    )
    stale.fire(even_if_cancelled=True)

    assert resolved.state is DecisionState.RESOLVED
    assert service.current_decision("fall_demo_01") == resolved
    assert publisher.decisions[-1].decision_id == resolved.decision_id


def test_need_help_stales_original_timeout_without_duplicate_alarm(tmp_path: Path) -> None:
    service, scheduler, publisher, _ = _service(tmp_path)
    check_in = _open_check_in(service)
    stale = scheduler.active()[0]

    alert = service.submit_response(
        _response(decision_id=check_in.decision_id, value=ResponseValue.NEED_HELP)
    )
    published_before_stale_fire = len(publisher.decisions)
    stale.fire(even_if_cancelled=True)

    assert alert.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert alert.alarm is not None
    assert alert.alarm.trigger is AlarmTrigger.ELDER_REPORT
    assert len(publisher.decisions) == published_before_stale_fire


def test_new_pending_decision_stales_old_timeout(tmp_path: Path) -> None:
    service, scheduler, publisher, _ = _service(tmp_path)
    check_in = _open_check_in(service)
    stale = scheduler.active()[0]

    clarify = service.submit_response(
        _response(decision_id=check_in.decision_id, value=ResponseValue.UNCLEAR)
    )
    stale.fire(even_if_cancelled=True)

    assert clarify.state is DecisionState.CHECK_IN_REQUIRED
    assert clarify.decision_id != check_in.decision_id
    assert service.current_decision("fall_demo_01") == clarify
    assert publisher.decisions[-1].decision_id == clarify.decision_id


def test_scene_reset_invalidates_backend_timeout(tmp_path: Path) -> None:
    service, scheduler, publisher, _ = _service(tmp_path)
    _open_check_in(service)
    stale = scheduler.active()[0]
    published_before_reset = len(publisher.decisions)

    service.reset_scene("fall_demo_01")
    stale.fire(even_if_cancelled=True)

    assert service.current_decision("fall_demo_01") is None
    assert len(publisher.decisions) == published_before_reset


def test_session_reset_all_invalidates_backend_timeout(tmp_path: Path) -> None:
    # `/api/session/stop` and session replacement call reset_all_scenes().
    service, scheduler, publisher, _ = _service(tmp_path)
    _open_check_in(service)
    stale = scheduler.active()[0]
    published_before_reset = len(publisher.decisions)

    service.reset_all_scenes()
    stale.fire(even_if_cancelled=True)

    assert service.current_decision("fall_demo_01") is None
    assert len(publisher.decisions) == published_before_reset


def test_legacy_frontend_timeout_first_stales_backend_callback(tmp_path: Path) -> None:
    service, scheduler, publisher, _ = _service(tmp_path)
    check_in = _open_check_in(service)
    stale = scheduler.active()[0]

    alert = service.submit_response(
        _response(
            decision_id=check_in.decision_id,
            value=ResponseValue.NONE,
            source=ResponseSource.TIMEOUT,
        )
    )
    published_before_stale_fire = len(publisher.decisions)
    stale.fire(even_if_cancelled=True)

    assert alert.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert alert.alarm is not None
    assert alert.alarm.trigger is AlarmTrigger.CHECK_IN_TIMEOUT
    assert len(publisher.decisions) == published_before_stale_fire


def test_backend_timeout_first_rejects_legacy_frontend_timeout(tmp_path: Path) -> None:
    service, scheduler, publisher, _ = _service(tmp_path)
    check_in = _open_check_in(service)
    scheduler.active()[0].fire()
    published_after_timeout = len(publisher.decisions)

    with pytest.raises(DecisionRejectedError, match="stale_decision"):
        service.submit_response(
            _response(
                decision_id=check_in.decision_id,
                value=ResponseValue.NONE,
                source=ResponseSource.TIMEOUT,
            )
        )

    assert len(publisher.decisions) == published_after_timeout


def test_timeout_wins_race_once_and_late_safe_is_stale(tmp_path: Path) -> None:
    service, scheduler, publisher, _ = _service(tmp_path)
    check_in = _open_check_in(service)
    scheduler.active()[0].fire()
    published_after_timeout = len(publisher.decisions)

    with pytest.raises(DecisionRejectedError, match="stale_decision"):
        service.submit_response(
            _response(decision_id=check_in.decision_id, value=ResponseValue.SAFE)
        )

    assert len(publisher.decisions) == published_after_timeout
    current = service.current_decision("fall_demo_01")
    assert current is not None
    assert current.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED


def test_tts_inflight_pauses_backend_timeout(tmp_path: Path) -> None:
    service, scheduler, publisher, _ = _service(tmp_path)
    check_in = _open_check_in(service)
    original = scheduler.active()[0]

    service.mark_decision_voice_started(
        scene_id="fall_demo_01", decision_id=check_in.decision_id
    )
    original.fire(even_if_cancelled=True)

    assert scheduler.active() == []
    assert service.current_decision("fall_demo_01") == check_in
    assert publisher.decisions[-1].decision_id == check_in.decision_id


def test_tts_ready_restarts_full_timeout_window(tmp_path: Path) -> None:
    service, scheduler, _, now = _service(tmp_path)
    check_in = _open_check_in(service)
    service.mark_decision_voice_started(
        scene_id="fall_demo_01", decision_id=check_in.decision_id
    )
    now[0] = 1001.0
    service.mark_decision_voice_ready(
        scene_id="fall_demo_01", decision_id=check_in.decision_id
    )
    ready_timer = scheduler.active()[0]
    assert ready_timer.delay_seconds == pytest.approx(2.5)

    ready_timer.fire()
    assert service.current_decision("fall_demo_01") == check_in
    retry = scheduler.active()[0]
    assert retry.delay_seconds == pytest.approx(2.5)

    now[0] = 1003.5
    retry.fire()
    alert = service.current_decision("fall_demo_01")
    assert alert is not None
    assert alert.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert alert.alarm is not None
    assert alert.alarm.trigger is AlarmTrigger.CHECK_IN_TIMEOUT


def test_family_ack_timeout_also_remains_backend_authoritative(tmp_path: Path) -> None:
    service, scheduler, _, _ = _service(tmp_path)
    _open_check_in(service)
    scheduler.active()[0].fire()
    alert = service.current_decision("fall_demo_01")
    assert alert is not None
    assert alert.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED

    scheduler.active()[0].fire()
    urgent = service.current_decision("fall_demo_01")
    assert urgent is not None
    assert urgent.state is DecisionState.URGENT_ATTENTION
    assert urgent.alarm is not None
    assert urgent.alarm.trigger is AlarmTrigger.FAMILY_UNRESPONSIVE


def test_service_close_cancels_pending_timeout(tmp_path: Path) -> None:
    service, scheduler, publisher, _ = _service(tmp_path)
    _open_check_in(service)
    stale = scheduler.active()[0]
    published_before_close = len(publisher.decisions)

    service.close()
    stale.fire(even_if_cancelled=True)

    assert scheduler.closed is True
    assert len(publisher.decisions) == published_before_close
