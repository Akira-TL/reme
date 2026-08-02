"""End-to-end DecisionService tests over the four acceptance videos plus failure modes."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import reme.decision.policy as policy_module
from reme.decision.context import load_scene_streams
from reme.decision.mimo.adapter import MimoCallResult, MimoTransportError
from reme.decision.policy import (
    DecisionRejectedError,
    DecisionService,
    MockMimoClient,
    PolicyConfig,
    UnknownSceneError,
)
from reme.decision.records import (
    CardStatus,
    CareDecision,
    DecisionSource,
    DecisionState,
    DemoMode,
    InteractionResponse,
    PrivacyMode,
    ResponseSource,
    ResponseValue,
    load_recorded_decisions,
)
from reme.decision.state_machine import MimoTask


def _posture_record(**overrides: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "schema_version": "reme-posture/v0-experiment",
        "scene_id": "toothache_demo_01",
        "timestamp_ms": 40000.0,
        "person_detected": True,
        "posture": "sitting",
        "posture_confidence": 0.9,
        "posture_duration_ms": 35000.0,
        "motion_level": "still",
        "landmark_quality": "usable",
    }
    record.update(overrides)
    return record


def _transition_record(**overrides: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
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
    record.update(overrides)
    return record


def _write_bundle(
    bundle_dir: Path,
    *,
    scene_id: str,
    postures: list[dict[str, Any]] | None = None,
    transitions: list[dict[str, Any]] | None = None,
) -> Path:
    bundle_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        "schema_version": "reme-scene/v0-experiment",
        "scene_id": scene_id,
        "title": scene_id,
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
            "posture_observations": None if postures is None else "posture_observations.jsonl",
            "transition_events": None if transitions is None else "transition_events.jsonl",
            "recorded_decisions": None,
        },
    }
    manifest_path = bundle_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    if postures is not None:
        lines = [json.dumps(record, ensure_ascii=False) for record in postures]
        (bundle_dir / "posture_observations.jsonl").write_text(
            "\n".join(lines) + "\n", encoding="utf-8"
        )
    if transitions is not None:
        lines = [json.dumps(record, ensure_ascii=False) for record in transitions]
        (bundle_dir / "transition_events.jsonl").write_text(
            "\n".join(lines) + "\n", encoding="utf-8"
        )
    return manifest_path


def _toothache_scenes(tmp_path: Path) -> dict[str, Any]:
    manifest = _write_bundle(
        tmp_path / "toothache_demo_01",
        scene_id="toothache_demo_01",
        postures=[_posture_record()],
    )
    return {"toothache_demo_01": load_scene_streams(manifest)}


def _fall_scenes(tmp_path: Path) -> dict[str, Any]:
    manifest = _write_bundle(
        tmp_path / "fall_demo_01",
        scene_id="fall_demo_01",
        postures=[
            _posture_record(
                scene_id="fall_demo_01",
                timestamp_ms=12800.0,
                posture="lying",
                posture_duration_ms=2000.0,
            )
        ],
        transitions=[_transition_record()],
    )
    return {"fall_demo_01": load_scene_streams(manifest)}


def _check_in_payload() -> dict[str, Any]:
    return {
        "state": "check_in_required",
        "risk_level": 2,
        "need_dialogue": True,
        "dialogue_goal": "understand_need",
        "elder_message": "王奶奶，坐了挺久啦，今天午饭吃得还顺口吗？",
        "family_notification": None,
        "consent_required": False,
        "reason_summary": "长时间静坐，轻量问候",
        "uncertainty": "medium",
        "privacy_mode": None,
        "action_card": None,
    }


def _interpret_payload() -> dict[str, Any]:
    return {
        "state": "consent_required",
        "risk_level": 2,
        "need_dialogue": True,
        "dialogue_goal": "request_consent",
        "elder_message": "王奶奶，要不要把牙疼的事告诉家人，让他们帮您约牙科？",
        "family_notification": None,
        "consent_required": True,
        "reason_summary": "主诉牙疼影响进食，先征求授权",
        "uncertainty": "medium",
        "privacy_mode": None,
        "action_card": {
            "event": "长时间静坐 + 主诉牙疼",
            "elder_quote": "牙疼，饭咬不动。",
            "system_judgment": "疑似口腔问题影响进食，非紧急",
            "suggested_action": "本周内预约口腔科检查",
            "time_window": "3 天内",
            "status": "pending",
        },
    }


class _FakeMimo:
    def __init__(self) -> None:
        self.scripts: dict[str, dict[str, Any]] = {
            MimoTask.COMPOSE_CHECK_IN.value: _check_in_payload(),
            MimoTask.INTERPRET_RESPONSE.value: _interpret_payload(),
        }
        self.calls: list[str] = []
        self.fail = False
        self.on_call: Callable[[], None] | None = None

    def complete_task(
        self,
        *,
        scene_id: str,
        task: MimoTask,
        system_prompt: str,
        user_content: str | list[dict[str, Any]],
    ) -> MimoCallResult:
        self.calls.append(task.value)
        if self.on_call is not None:
            hook, self.on_call = self.on_call, None
            hook()
        if self.fail:
            raise MimoTransportError("scripted transport failure", attempts=2)
        payload = self.scripts[task.value]
        return MimoCallResult(
            content=json.dumps(payload, ensure_ascii=False), latency_ms=1.0, attempts=1
        )


def _response(
    *,
    scene_id: str,
    decision_id: str,
    value: ResponseValue,
    source: ResponseSource = ResponseSource.USER_INPUT,
    text: str | None = None,
    timestamp_ms: float = 50000.0,
) -> InteractionResponse:
    return InteractionResponse(
        scene_id=scene_id,
        decision_id=decision_id,
        timestamp_ms=timestamp_ms,
        response=value,
        source=source,
        demo_mode=DemoMode.LIVE,
        text=text,
    )


def test_normal_scene_polls_reuse_same_decision_id(tmp_path: Path) -> None:
    manifest = _write_bundle(
        tmp_path / "normal_demo_01",
        scene_id="normal_demo_01",
        postures=[
            _posture_record(
                scene_id="normal_demo_01",
                posture="standing",
                motion_level="medium",
                posture_duration_ms=1000.0,
            )
        ],
    )
    service = DecisionService(
        scenes={"normal_demo_01": load_scene_streams(manifest)}, config=PolicyConfig()
    )
    first = service.get_decision(scene_id="normal_demo_01", timestamp_ms=41000.0)
    second = service.get_decision(scene_id="normal_demo_01", timestamp_ms=42000.0)
    assert first.state is DecisionState.NORMAL
    assert first.decision_id == second.decision_id
    assert first.source is DecisionSource.RULE


def test_privacy_scene_emits_configured_privacy_mode(tmp_path: Path) -> None:
    service = DecisionService(
        scenes=_toothache_scenes(tmp_path),
        config=PolicyConfig(
            scene_privacy={"toothache_demo_01": PrivacyMode.SKELETON_ONLY},
        ),
        mimo=_FakeMimo(),
    )
    decision = service.get_decision(scene_id="toothache_demo_01", timestamp_ms=41000.0)
    assert decision.privacy_mode is PrivacyMode.SKELETON_ONLY


def test_toothache_scene_completes_action_card_loop(tmp_path: Path) -> None:
    fake = _FakeMimo()
    service = DecisionService(
        scenes=_toothache_scenes(tmp_path), config=PolicyConfig(), mimo=fake
    )
    scene = "toothache_demo_01"

    check_in = service.get_decision(scene_id=scene, timestamp_ms=41000.0)
    assert check_in.state is DecisionState.CHECK_IN_REQUIRED
    assert check_in.source is DecisionSource.MIMO
    assert check_in.elder_message == "王奶奶，坐了挺久啦，今天午饭吃得还顺口吗？"

    consent = service.submit_response(
        _response(
            scene_id=scene,
            decision_id=check_in.decision_id,
            value=ResponseValue.NEED_HELP,
            text="牙疼，饭咬不动。",
        )
    )
    assert consent.state is DecisionState.CONSENT_REQUIRED
    assert consent.consent_required is True
    assert consent.risk_level == 2

    notify = service.submit_response(
        _response(
            scene_id=scene,
            decision_id=consent.decision_id,
            value=ResponseValue.CONSENT_GRANTED,
            timestamp_ms=60000.0,
        )
    )
    assert notify.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert notify.family_notification is not None
    assert notify.action_card is not None
    assert notify.action_card.status is CardStatus.PENDING
    assert notify.action_card.elder_quote == "牙疼，饭咬不动。"
    assert fake.calls == ["compose_check_in", "interpret_response"]

    resolved = service.submit_response(
        _response(
            scene_id=scene,
            decision_id=notify.decision_id,
            value=ResponseValue.CARD_CONFIRMED,
            source=ResponseSource.FAMILY_INPUT,
            timestamp_ms=70000.0,
        )
    )
    assert resolved.state is DecisionState.RESOLVED
    assert resolved.source is DecisionSource.RULE
    assert resolved.action_card is not None
    assert resolved.action_card.status is CardStatus.CONFIRMED


def test_fall_scene_escalates_after_timeout_then_urgent(tmp_path: Path) -> None:
    service = DecisionService(scenes=_fall_scenes(tmp_path), config=PolicyConfig())
    scene = "fall_demo_01"

    check_in = service.get_decision(scene_id=scene, timestamp_ms=13000.0)
    assert check_in.state is DecisionState.CHECK_IN_REQUIRED
    assert check_in.source is DecisionSource.RULE
    assert check_in.response_timeout_ms == 8000

    alert = service.submit_response(
        _response(
            scene_id=scene,
            decision_id=check_in.decision_id,
            value=ResponseValue.NONE,
            source=ResponseSource.TIMEOUT,
            timestamp_ms=21000.0,
        )
    )
    assert alert.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert alert.source is DecisionSource.RULE
    assert alert.fallback_used is False
    assert alert.family_notification is not None

    urgent = service.submit_response(
        _response(
            scene_id=scene,
            decision_id=alert.decision_id,
            value=ResponseValue.NONE,
            source=ResponseSource.TIMEOUT,
            timestamp_ms=29000.0,
        )
    )
    assert urgent.state is DecisionState.URGENT_ATTENTION
    assert urgent.risk_level == 4

    reused = service.get_decision(scene_id=scene, timestamp_ms=30000.0)
    assert reused.decision_id == urgent.decision_id


def test_voice_prompt_timeout_waits_for_tts_window(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = 1000.0
    monkeypatch.setattr(policy_module.time, "monotonic", lambda: now)
    service = DecisionService(scenes=_fall_scenes(tmp_path), config=PolicyConfig())
    scene = "fall_demo_01"
    check_in = service.get_decision(scene_id=scene, timestamp_ms=13000.0)
    assert check_in.response_timeout_ms is not None

    service.mark_decision_voice_started(scene_id=scene, decision_id=check_in.decision_id)
    with pytest.raises(DecisionRejectedError, match="response_too_early"):
        service.submit_response(
            _response(
                scene_id=scene,
                decision_id=check_in.decision_id,
                value=ResponseValue.NONE,
                source=ResponseSource.TIMEOUT,
                timestamp_ms=21000.0,
            )
        )

    now = 1001.0
    service.mark_decision_voice_ready(scene_id=scene, decision_id=check_in.decision_id)
    with pytest.raises(DecisionRejectedError, match="response_too_early"):
        service.submit_response(
            _response(
                scene_id=scene,
                decision_id=check_in.decision_id,
                value=ResponseValue.NONE,
                source=ResponseSource.TIMEOUT,
                timestamp_ms=22000.0,
            )
        )

    now = 1001.0 + check_in.response_timeout_ms / 1000
    alert = service.submit_response(
        _response(
            scene_id=scene,
            decision_id=check_in.decision_id,
            value=ResponseValue.NONE,
            source=ResponseSource.TIMEOUT,
            timestamp_ms=23000.0,
        )
    )
    assert alert.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED


def test_mimo_failure_emits_degraded_and_keeps_phase(tmp_path: Path) -> None:
    fake = _FakeMimo()
    fake.fail = True
    service = DecisionService(
        scenes=_toothache_scenes(tmp_path), config=PolicyConfig(), mimo=fake
    )
    scene = "toothache_demo_01"

    degraded = service.get_decision(scene_id=scene, timestamp_ms=41000.0)
    assert degraded.state is DecisionState.DEGRADED
    assert degraded.source is DecisionSource.DEGRADED
    assert degraded.fallback_used is True

    with pytest.raises(DecisionRejectedError, match="no_pending_decision"):
        service.submit_response(
            _response(
                scene_id=scene, decision_id=degraded.decision_id, value=ResponseValue.SAFE
            )
        )

    fake.fail = False
    recovered = service.get_decision(scene_id=scene, timestamp_ms=42000.0)
    assert recovered.state is DecisionState.CHECK_IN_REQUIRED
    assert recovered.source is DecisionSource.MIMO


def test_stale_mimo_result_discarded_after_rule_escalation(tmp_path: Path) -> None:
    fake = _FakeMimo()
    service = DecisionService(
        scenes=_toothache_scenes(tmp_path), config=PolicyConfig(), mimo=fake
    )
    scene = "toothache_demo_01"
    check_in = service.get_decision(scene_id=scene, timestamp_ms=41000.0)

    def _inject_timeout() -> None:
        service.submit_response(
            _response(
                scene_id=scene,
                decision_id=check_in.decision_id,
                value=ResponseValue.NONE,
                source=ResponseSource.TIMEOUT,
                timestamp_ms=52000.0,
            )
        )

    fake.on_call = _inject_timeout
    outcome = service.submit_response(
        _response(
            scene_id=scene,
            decision_id=check_in.decision_id,
            value=ResponseValue.NEED_HELP,
            text="牙疼，饭咬不动。",
            timestamp_ms=51000.0,
        )
    )
    assert outcome.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert outcome.source is DecisionSource.RULE


def test_record_flag_captures_each_emitted_decision(tmp_path: Path) -> None:
    scenes = _fall_scenes(tmp_path)
    service = DecisionService(
        scenes=scenes, config=PolicyConfig(record_capture=True)
    )
    scene = "fall_demo_01"
    check_in = service.get_decision(scene_id=scene, timestamp_ms=13000.0)
    service.get_decision(scene_id=scene, timestamp_ms=13500.0)
    service.submit_response(
        _response(
            scene_id=scene,
            decision_id=check_in.decision_id,
            value=ResponseValue.NONE,
            source=ResponseSource.TIMEOUT,
            timestamp_ms=21000.0,
        )
    )
    recorded_path = scenes[scene].manifest.path.parent / "recorded_decisions.jsonl"
    recorded = load_recorded_decisions(recorded_path, expected_scene_id=scene)
    assert [decision.state for decision in recorded] == [
        DecisionState.CHECK_IN_REQUIRED,
        DecisionState.FAMILY_NOTIFICATION_REQUIRED,
    ]


def test_record_mode_replays_marked_decisions(tmp_path: Path) -> None:
    scenes = _fall_scenes(tmp_path)
    live = DecisionService(scenes=scenes, config=PolicyConfig(record_capture=True))
    scene = "fall_demo_01"
    live_check_in = live.get_decision(scene_id=scene, timestamp_ms=13000.0)
    live.submit_response(
        _response(
            scene_id=scene,
            decision_id=live_check_in.decision_id,
            value=ResponseValue.NONE,
            source=ResponseSource.TIMEOUT,
            timestamp_ms=21000.0,
        )
    )

    replay = DecisionService(
        scenes=scenes, config=PolicyConfig(demo_mode=DemoMode.RECORD)
    )
    first = replay.get_decision(scene_id=scene, timestamp_ms=1.0)
    assert first.state is DecisionState.CHECK_IN_REQUIRED
    assert first.source is DecisionSource.RECORD
    assert first.demo_mode is DemoMode.RECORD
    advanced = replay.submit_response(
        _response(scene_id=scene, decision_id=first.decision_id, value=ResponseValue.SAFE)
    )
    assert advanced.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED


def test_mock_mode_marks_source_mock_and_rule_paths_stay_rule(tmp_path: Path) -> None:
    script_dir = tmp_path / "mimo_mock"
    script_dir.mkdir()
    (script_dir / "toothache_demo_01.json").write_text(
        json.dumps({"compose_check_in": _check_in_payload()}, ensure_ascii=False),
        encoding="utf-8",
    )
    scenes = _toothache_scenes(tmp_path)
    scenes.update(_fall_scenes(tmp_path))
    service = DecisionService(
        scenes=scenes,
        config=PolicyConfig(demo_mode=DemoMode.MOCK),
        mimo=MockMimoClient(script_dir=script_dir),
    )
    mocked = service.get_decision(scene_id="toothache_demo_01", timestamp_ms=41000.0)
    assert mocked.source is DecisionSource.MOCK
    assert mocked.demo_mode is DemoMode.MOCK
    rule = service.get_decision(scene_id="fall_demo_01", timestamp_ms=13000.0)
    assert rule.source is DecisionSource.RULE


def test_scene_reset_restarts_episode(tmp_path: Path) -> None:
    service = DecisionService(scenes=_fall_scenes(tmp_path), config=PolicyConfig())
    scene = "fall_demo_01"
    first = service.get_decision(scene_id=scene, timestamp_ms=13000.0)
    assert first.state is DecisionState.CHECK_IN_REQUIRED
    service.reset_scene(scene)
    again = service.get_decision(scene_id=scene, timestamp_ms=13000.0)
    assert again.state is DecisionState.CHECK_IN_REQUIRED
    assert again.decision_id != first.decision_id


def test_stale_response_raises_conflict_code(tmp_path: Path) -> None:
    service = DecisionService(scenes=_fall_scenes(tmp_path), config=PolicyConfig())
    scene = "fall_demo_01"
    service.get_decision(scene_id=scene, timestamp_ms=13000.0)
    with pytest.raises(DecisionRejectedError) as excinfo:
        service.submit_response(
            _response(scene_id=scene, decision_id="decision-9999", value=ResponseValue.SAFE)
        )
    assert excinfo.value.code == "stale_decision"


def test_unknown_scene_raises_dedicated_error(tmp_path: Path) -> None:
    service = DecisionService(scenes={}, config=PolicyConfig())
    with pytest.raises(UnknownSceneError):
        service.get_decision(scene_id="ghost", timestamp_ms=0.0)


def test_reset_invalidates_in_flight_mimo(tmp_path: Path) -> None:
    fake = _FakeMimo()
    service = DecisionService(
        scenes=_toothache_scenes(tmp_path), config=PolicyConfig(), mimo=fake
    )
    scene = "toothache_demo_01"
    fake.on_call = lambda: service.reset_scene(scene)
    with pytest.raises(DecisionRejectedError, match="no_pending_decision"):
        service.get_decision(scene_id=scene, timestamp_ms=41000.0)
    recovered = service.get_decision(scene_id=scene, timestamp_ms=41000.0)
    assert recovered.state is DecisionState.CHECK_IN_REQUIRED


def test_polling_tick_does_not_kill_in_flight_mimo(tmp_path: Path) -> None:
    fake = _FakeMimo()
    service = DecisionService(
        scenes=_toothache_scenes(tmp_path), config=PolicyConfig(), mimo=fake
    )
    scene = "toothache_demo_01"
    check_in = service.get_decision(scene_id=scene, timestamp_ms=41000.0)

    def _poll_during_interpret() -> None:
        polled = service.get_decision(scene_id=scene, timestamp_ms=52000.0)
        assert polled.decision_id == check_in.decision_id

    fake.on_call = _poll_during_interpret
    consent = service.submit_response(
        _response(
            scene_id=scene,
            decision_id=check_in.decision_id,
            value=ResponseValue.NEED_HELP,
            text="牙疼，饭咬不动。",
            timestamp_ms=51000.0,
        )
    )
    assert consent.state is DecisionState.CONSENT_REQUIRED


def test_action_card_quote_bound_to_actual_complaint(tmp_path: Path) -> None:
    fake = _FakeMimo()
    fabricated = _interpret_payload()
    card = fabricated["action_card"]
    assert isinstance(card, dict)
    card["elder_quote"] = "编造的诊断性引语"
    fake.scripts[MimoTask.INTERPRET_RESPONSE.value] = fabricated
    service = DecisionService(
        scenes=_toothache_scenes(tmp_path), config=PolicyConfig(), mimo=fake
    )
    scene = "toothache_demo_01"
    check_in = service.get_decision(scene_id=scene, timestamp_ms=41000.0)
    consent = service.submit_response(
        _response(
            scene_id=scene,
            decision_id=check_in.decision_id,
            value=ResponseValue.NEED_HELP,
            text="牙疼，饭咬不动。",
        )
    )
    notify = service.submit_response(
        _response(
            scene_id=scene,
            decision_id=consent.decision_id,
            value=ResponseValue.CONSENT_GRANTED,
            timestamp_ms=60000.0,
        )
    )
    assert notify.action_card is not None
    assert notify.action_card.elder_quote == "牙疼，饭咬不动。"


def test_schema_failure_consumes_one_reask(tmp_path: Path) -> None:
    class _FlakySchemaMimo(_FakeMimo):
        def __init__(self) -> None:
            super().__init__()
            self.queue = ["这不是 JSON", json.dumps(_check_in_payload(), ensure_ascii=False)]

        def complete_task(self, **kwargs: Any) -> MimoCallResult:
            self.calls.append(kwargs["task"].value)
            return MimoCallResult(content=self.queue.pop(0), latency_ms=1.0, attempts=1)

    fake = _FlakySchemaMimo()
    service = DecisionService(
        scenes=_toothache_scenes(tmp_path), config=PolicyConfig(), mimo=fake
    )
    decision = service.get_decision(scene_id="toothache_demo_01", timestamp_ms=41000.0)
    assert decision.state is DecisionState.CHECK_IN_REQUIRED
    assert len(fake.calls) == 2


def test_degraded_not_captured_in_record_stream(tmp_path: Path) -> None:
    fake = _FakeMimo()
    fake.fail = True
    scenes = _toothache_scenes(tmp_path)
    service = DecisionService(
        scenes=scenes, config=PolicyConfig(record_capture=True), mimo=fake
    )
    scene = "toothache_demo_01"
    degraded = service.get_decision(scene_id=scene, timestamp_ms=41000.0)
    assert degraded.state is DecisionState.DEGRADED
    recorded_path = scenes[scene].manifest.path.parent / "recorded_decisions.jsonl"
    assert not recorded_path.exists()
    fake.fail = False
    service.get_decision(scene_id=scene, timestamp_ms=42000.0)
    recorded = load_recorded_decisions(recorded_path, expected_scene_id=scene)
    assert [decision.state for decision in recorded] == [DecisionState.CHECK_IN_REQUIRED]


def test_record_replay_validates_decision_id(tmp_path: Path) -> None:
    scenes = _fall_scenes(tmp_path)
    live = DecisionService(scenes=scenes, config=PolicyConfig(record_capture=True))
    scene = "fall_demo_01"
    check_in = live.get_decision(scene_id=scene, timestamp_ms=13000.0)
    live.submit_response(
        _response(
            scene_id=scene,
            decision_id=check_in.decision_id,
            value=ResponseValue.NONE,
            source=ResponseSource.TIMEOUT,
            timestamp_ms=21000.0,
        )
    )
    replay = DecisionService(scenes=scenes, config=PolicyConfig(demo_mode=DemoMode.RECORD))
    first = replay.get_decision(scene_id=scene, timestamp_ms=1.0)
    with pytest.raises(DecisionRejectedError, match="stale_decision"):
        replay.submit_response(
            _response(scene_id=scene, decision_id="decision-9999", value=ResponseValue.SAFE)
        )
    advanced = replay.submit_response(
        _response(scene_id=scene, decision_id=first.decision_id, value=ResponseValue.SAFE)
    )
    assert advanced.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED


def test_visual_flag_attaches_clip_and_records_context(tmp_path: Path) -> None:
    scenes = _toothache_scenes(tmp_path)
    bundle_dir = scenes["toothache_demo_01"].manifest.path.parent
    derived = bundle_dir / "derived"
    derived.mkdir()
    (derived / "visual_context.mp4").write_bytes(b"fakemp4")
    (derived / "visual_context.json").write_text(
        json.dumps({"start_ms": 30000.0, "end_ms": 33000.0}), encoding="utf-8"
    )

    captured: list[Any] = []

    class _CapturingMimo(_FakeMimo):
        def complete_task(self, **kwargs: Any) -> MimoCallResult:
            captured.append(kwargs["user_content"])
            return super().complete_task(**kwargs)

    service = DecisionService(
        scenes=scenes, config=PolicyConfig(visual_enabled=True), mimo=_CapturingMimo()
    )
    decision = service.get_decision(scene_id="toothache_demo_01", timestamp_ms=41000.0)
    assert isinstance(captured[0], list)
    assert captured[0][1]["type"] == "video_url"
    assert decision.visual_context is not None
    assert decision.visual_context.sent_to_mimo is True
    assert decision.visual_context.start_ms == 30000.0


def test_tick_during_inflight_mimo_reuses_instead_of_stacking(tmp_path: Path) -> None:
    """Ticks landing while one MiMo call is in flight must not each re-dial.

    Posture ticks arrive at 5-10 Hz and a MiMo round trip takes seconds;
    before the in-flight latch every tick in that window launched its own
    identical paid call, the CAS discarded all but one, and each discard
    re-broadcast the same decision_id to C.
    """

    fake = _FakeMimo()

    class _CapturePublisher:
        def __init__(self) -> None:
            self.published: list[str] = []
            self.responses: list[InteractionResponse] = []

        def publish_decision(self, decision: CareDecision) -> None:
            self.published.append(decision.decision_id)

        def publish_response(self, response: InteractionResponse) -> None:
            self.responses.append(response)

    publisher = _CapturePublisher()
    service = DecisionService(
        scenes=_toothache_scenes(tmp_path),
        config=PolicyConfig(),
        mimo=fake,
        publisher=publisher,
    )
    scene = "toothache_demo_01"
    baseline = service.get_decision(scene_id=scene, timestamp_ms=1000.0)
    assert baseline.source is DecisionSource.RULE

    reentrant: list[CareDecision] = []
    fake.on_call = lambda: reentrant.append(
        service.get_decision(scene_id=scene, timestamp_ms=41100.0)
    )
    check_in = service.get_decision(scene_id=scene, timestamp_ms=41000.0)
    assert check_in.state is DecisionState.CHECK_IN_REQUIRED
    assert check_in.source is DecisionSource.MIMO
    assert fake.calls == ["compose_check_in"], "the in-flight window must not stack calls"
    assert len(reentrant) == 1
    assert reentrant[0].decision_id == baseline.decision_id, "reuse, not a new decision"
    assert publisher.published == [baseline.decision_id, check_in.decision_id]

    # The latch releases with the call: the next MiMo directive launches fine.
    consent = service.submit_response(
        _response(
            scene_id=scene,
            decision_id=check_in.decision_id,
            value=ResponseValue.NEED_HELP,
            text="牙疼，饭咬不动。",
        )
    )
    assert consent.state is DecisionState.CONSENT_REQUIRED
    assert fake.calls == ["compose_check_in", "interpret_response"]
    assert publisher.published[-1] == consent.decision_id
