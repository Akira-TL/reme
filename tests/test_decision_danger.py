"""Danger link tests: contracts, transitions, and the two racing confirm paths."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import pytest
from reme.decision.context import load_scene_streams
from reme.decision.danger import (
    REJECT_BAD_MEDIA,
    REJECT_CONFIRM_BUDGET,
    REJECT_CONFIRM_UNAVAILABLE,
    REJECT_NO_CONFIRM_PENDING,
    DangerConfig,
    DangerConfirmController,
    DangerRejectedError,
)
from reme.decision.guardrails import TriggerConfig
from reme.decision.mimo.adapter import MimoCallResult, MimoTransportError
from reme.decision.mimo.confirm import (
    VoiceIntent,
    classify_reply_text,
    guard_voice_intent,
    parse_vision_verdict,
    parse_voice_intent,
)
from reme.decision.mimo.schema import MimoSchemaError
from reme.decision.policy import DecisionService, PolicyConfig
from reme.decision.records import (
    AlarmSignal,
    AlarmTrigger,
    CareDecision,
    DecisionRecordError,
    DecisionState,
    DemoMode,
    InteractionResponse,
    ResponseSource,
    ResponseValue,
    parse_care_decision,
)
from reme.decision.state_machine import (
    REJECT_DANGER_NOT_APPLICABLE,
    EscalationKind,
    SessionPhase,
    SessionState,
    TemplateId,
    on_danger_confirmed,
)

JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"reme-test-frame"
WAV_BYTES = b"RIFF" + b"\x00" * 8 + b"WAVEreme-test-clip"


# -- fixtures ----------------------------------------------------------------


def _posture_record(**overrides: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
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


def _fall_scenes(tmp_path: Path) -> dict[str, Any]:
    bundle_dir = tmp_path / "fall_demo_01"
    bundle_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        "schema_version": "reme-scene/v0-experiment",
        "scene_id": "fall_demo_01",
        "title": "fall",
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
    (bundle_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (bundle_dir / "posture_observations.jsonl").write_text(
        json.dumps(_posture_record()) + "\n", encoding="utf-8"
    )
    (bundle_dir / "transition_events.jsonl").write_text(
        json.dumps(_transition_record()) + "\n", encoding="utf-8"
    )
    return {"fall_demo_01": load_scene_streams(bundle_dir / "manifest.json")}


class _Publisher:
    def __init__(self) -> None:
        self.decisions: list[CareDecision] = []

    def publish_decision(self, decision: CareDecision) -> None:
        self.decisions.append(decision)


class _FakeConfirmClient:
    """Scripted transport for the confirmation calls, in arrival order."""

    def __init__(self, replies: list[str | Exception]) -> None:
        self.replies = replies
        self.calls: list[tuple[str, Any]] = []

    def complete(
        self, *, system_prompt: str, user_content: str | list[dict[str, Any]]
    ) -> MimoCallResult:
        self.calls.append((system_prompt, user_content))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return MimoCallResult(content=reply, latency_ms=42.0, attempts=1)


def _service(tmp_path: Path, publisher: _Publisher) -> DecisionService:
    return DecisionService(
        scenes=_fall_scenes(tmp_path),
        config=PolicyConfig(
            trigger=TriggerConfig(),
            demo_mode=DemoMode.LIVE,
            cognition_enabled=False,
            voice_assets={TemplateId.FALL_CHECK_IN: "/voice/fall_check_in.m4a"},
        ),
        publisher=publisher,
    )


def _controller(
    service: DecisionService,
    client: _FakeConfirmClient | None,
    *,
    config: DangerConfig | None = None,
) -> DangerConfirmController:
    return DangerConfirmController(
        service=service,
        client=client,
        config=config if config is not None else DangerConfig(),
        spawn=lambda work: work(),
    )


def _open_fall_check_in(service: DecisionService) -> CareDecision:
    decision = service.get_decision(scene_id="fall_demo_01", timestamp_ms=13000.0)
    assert decision.state is DecisionState.CHECK_IN_REQUIRED
    return decision


def _vision_reply(fallen: bool, confidence: float = 0.9) -> str:
    return json.dumps(
        {"fallen": fallen, "confidence": confidence, "reason": "水平躺地"}, ensure_ascii=False
    )


def _voice_reply(intent: str, transcript: str) -> str:
    return json.dumps({"intent": intent, "transcript": transcript}, ensure_ascii=False)


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


# -- contract records --------------------------------------------------------


def test_fall_check_in_carries_confirm_channels_and_voice_asset(tmp_path: Path) -> None:
    publisher = _Publisher()
    decision = _open_fall_check_in(_service(tmp_path, publisher))
    assert decision.confirm_channels == ("frame", "voice")
    assert decision.voice_asset == "/voice/fall_check_in.m4a"
    payload = decision.to_payload()
    assert payload["confirm_channels"] == ["frame", "voice"]
    assert payload["voice_asset"] == "/voice/fall_check_in.m4a"
    assert parse_care_decision(payload) == decision


def test_alarm_signal_validation() -> None:
    with pytest.raises(DecisionRecordError):
        AlarmSignal(channels=(), trigger=AlarmTrigger.ELDER_REPORT)
    with pytest.raises(DecisionRecordError):
        AlarmSignal(channels=("vibrate", "vibrate"), trigger=AlarmTrigger.ELDER_REPORT)
    with pytest.raises(DecisionRecordError):
        AlarmSignal(channels=("siren",), trigger=AlarmTrigger.ELDER_REPORT)
    signal = AlarmSignal(channels=("vibrate", "ring", "flash"), trigger=AlarmTrigger.VOICE_INTENT)
    assert signal.to_payload() == {
        "channels": ["vibrate", "ring", "flash"],
        "trigger": "voice_intent",
    }


def test_alarm_only_on_alert_states(tmp_path: Path) -> None:
    publisher = _Publisher()
    decision = _open_fall_check_in(_service(tmp_path, publisher))
    with pytest.raises(DecisionRecordError):
        parse_care_decision(
            {
                **decision.to_payload(),
                "alarm": {"channels": ["vibrate"], "trigger": "elder_report"},
            }
        )


def test_voice_source_cross_whitelist() -> None:
    response = InteractionResponse(
        scene_id="fall_demo_01",
        decision_id="decision-0001",
        timestamp_ms=14000.0,
        response=ResponseValue.NEED_HELP,
        source=ResponseSource.VOICE,
        demo_mode=DemoMode.LIVE,
        text="我摔倒了",
    )
    assert response.to_payload()["source"] == "voice"
    with pytest.raises(DecisionRecordError):
        InteractionResponse(
            scene_id="fall_demo_01",
            decision_id="decision-0001",
            timestamp_ms=14000.0,
            response=ResponseValue.NONE,
            source=ResponseSource.VOICE,
            demo_mode=DemoMode.LIVE,
        )


# -- state machine -----------------------------------------------------------


def _awaiting_fall_state() -> SessionState:
    return SessionState(
        scene_id="fall_demo_01",
        phase=SessionPhase.AWAITING_ELDER,
        escalation=EscalationKind.FALL,
        pending_decision_id="decision-0001",
        context_high_water_ms=13000.0,
    )


def test_on_danger_confirmed_escalates_awaiting_fall() -> None:
    directive = on_danger_confirmed(
        _awaiting_fall_state(), timestamp_ms=14000.0, config=TriggerConfig()
    )
    assert directive.reject_code is None
    assert directive.skeleton is not None
    assert directive.skeleton.template is TemplateId.DANGER_CONFIRMED_ALERT
    assert directive.skeleton.alarm_trigger is AlarmTrigger.VISUAL_CONFIRM
    assert directive.skeleton.risk_level == 3
    assert directive.next_state.phase is SessionPhase.FAMILY_NOTIFIED
    assert directive.next_state.risk_floor == 3


@pytest.mark.parametrize(
    "state",
    [
        SessionState(scene_id="fall_demo_01"),
        SessionState(
            scene_id="fall_demo_01",
            phase=SessionPhase.AWAITING_ELDER,
            escalation=EscalationKind.CONCERN,
            pending_decision_id="decision-0001",
        ),
        SessionState(
            scene_id="fall_demo_01",
            phase=SessionPhase.FAMILY_NOTIFIED,
            escalation=EscalationKind.FALL,
            pending_decision_id="decision-0002",
            risk_floor=3,
        ),
        SessionState(scene_id="fall_demo_01", phase=SessionPhase.RESOLVED),
    ],
)
def test_on_danger_confirmed_rejects_other_phases(state: SessionState) -> None:
    directive = on_danger_confirmed(state, timestamp_ms=14000.0, config=TriggerConfig())
    assert directive.reject_code == REJECT_DANGER_NOT_APPLICABLE
    assert directive.skeleton is None


# -- verdict parsing and guardrails -----------------------------------------


def test_parse_vision_verdict_strict() -> None:
    verdict = parse_vision_verdict('{"fallen": true, "confidence": 1.7, "reason": "躺地"}')
    assert verdict.fallen is True
    assert verdict.confidence == 1.0
    with pytest.raises(MimoSchemaError):
        parse_vision_verdict('{"fallen": "yes"}')
    with pytest.raises(MimoSchemaError):
        parse_vision_verdict('{"fallen": true, "confidence": 0.9, "extra": 1}')
    with pytest.raises(MimoSchemaError):
        parse_vision_verdict("not json")


def test_parse_voice_intent_strict() -> None:
    verdict = parse_voice_intent('{"intent": "safe", "transcript": " 没事 "}')
    assert verdict.intent is ResponseValue.SAFE
    assert verdict.transcript == "没事"
    with pytest.raises(MimoSchemaError):
        parse_voice_intent('{"intent": "panic"}')


def test_classify_reply_text_rules() -> None:
    assert classify_reply_text("快来人啊我起不来了") is ResponseValue.NEED_HELP
    assert classify_reply_text("没事没事我挺好的") is ResponseValue.SAFE
    assert classify_reply_text("我没摔倒放心吧没事") is ResponseValue.SAFE
    assert classify_reply_text("今天天气不错") is None


def test_guard_voice_intent_upgrades_only() -> None:
    upgraded = guard_voice_intent(
        VoiceIntent(intent=ResponseValue.UNCLEAR, transcript="腿疼得厉害起不来")
    )
    assert upgraded.intent is ResponseValue.NEED_HELP
    kept_safe = guard_voice_intent(
        VoiceIntent(intent=ResponseValue.SAFE, transcript="有点疼但是没事")
    )
    assert kept_safe.intent is ResponseValue.SAFE
    hard_override = guard_voice_intent(
        VoiceIntent(intent=ResponseValue.SAFE, transcript="救命救命")
    )
    assert hard_override.intent is ResponseValue.NEED_HELP


# -- visual path -------------------------------------------------------------


def test_frame_confirms_fall_and_alarms_family(tmp_path: Path) -> None:
    publisher = _Publisher()
    service = _service(tmp_path, publisher)
    check_in = _open_fall_check_in(service)
    client = _FakeConfirmClient([_vision_reply(True)])
    controller = _controller(service, client)

    controller.submit_frame(
        scene_id="fall_demo_01",
        decision_id=check_in.decision_id,
        image_b64=_b64(JPEG_BYTES),
        timestamp_ms=14000.0,
    )

    alert = publisher.decisions[-1]
    assert alert.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert alert.alarm is not None
    assert alert.alarm.trigger is AlarmTrigger.VISUAL_CONFIRM
    assert alert.alarm.channels == ("vibrate", "ring", "flash")
    assert alert.family_notification is not None
    assert alert.response_timeout_ms == TriggerConfig().family_ack_timeout_ms
    # The vision call actually carried the frame.
    system_prompt, user_content = client.calls[0]
    assert "摔倒" in system_prompt
    assert isinstance(user_content, list)
    assert user_content[1]["type"] == "image_url"


def test_frame_not_fallen_leaves_check_in_pending(tmp_path: Path) -> None:
    publisher = _Publisher()
    service = _service(tmp_path, publisher)
    check_in = _open_fall_check_in(service)
    controller = _controller(service, _FakeConfirmClient([_vision_reply(False, 0.2)]))

    controller.submit_frame(
        scene_id="fall_demo_01",
        decision_id=check_in.decision_id,
        image_b64=_b64(JPEG_BYTES),
        timestamp_ms=14000.0,
    )

    assert publisher.decisions[-1].decision_id == check_in.decision_id
    assert service.pending_confirm_target("fall_demo_01") is not None


def test_frame_after_safe_answer_is_discarded(tmp_path: Path) -> None:
    publisher = _Publisher()
    service = _service(tmp_path, publisher)
    check_in = _open_fall_check_in(service)
    client = _FakeConfirmClient([_vision_reply(True)])
    controller = _controller(service, client)

    resolved = service.submit_response(
        InteractionResponse(
            scene_id="fall_demo_01",
            decision_id=check_in.decision_id,
            timestamp_ms=13500.0,
            response=ResponseValue.SAFE,
            source=ResponseSource.USER_INPUT,
            demo_mode=DemoMode.LIVE,
        )
    )
    assert resolved.state is DecisionState.RESOLVED

    with pytest.raises(DangerRejectedError) as excinfo:
        controller.submit_frame(
            scene_id="fall_demo_01",
            decision_id=check_in.decision_id,
            image_b64=_b64(JPEG_BYTES),
            timestamp_ms=14000.0,
        )
    assert excinfo.value.code == REJECT_NO_CONFIRM_PENDING
    assert publisher.decisions[-1].state is DecisionState.RESOLVED


def test_race_confirm_after_resolution_commits_nothing(tmp_path: Path) -> None:
    """The elder's explicit safe answer beats a late visual verdict."""

    publisher = _Publisher()
    service = _service(tmp_path, publisher)
    check_in = _open_fall_check_in(service)
    client = _FakeConfirmClient([_vision_reply(True)])
    resolved_holder: list[CareDecision] = []

    def race_spawn(work: Any) -> None:
        # The upload passed validation while the check-in was pending; the
        # elder answers safe before the vision verdict lands.
        resolved_holder.append(
            service.submit_response(
                InteractionResponse(
                    scene_id="fall_demo_01",
                    decision_id=check_in.decision_id,
                    timestamp_ms=13500.0,
                    response=ResponseValue.SAFE,
                    source=ResponseSource.USER_INPUT,
                    demo_mode=DemoMode.LIVE,
                )
            )
        )
        work()

    controller = DangerConfirmController(
        service=service, client=client, config=DangerConfig(), spawn=race_spawn
    )
    controller.submit_frame(
        scene_id="fall_demo_01",
        decision_id=check_in.decision_id,
        image_b64=_b64(JPEG_BYTES),
        timestamp_ms=14000.0,
    )

    assert resolved_holder[0].state is DecisionState.RESOLVED
    assert publisher.decisions[-1].state is DecisionState.RESOLVED
    assert service.confirm_danger(scene_id="fall_demo_01", timestamp_ms=15000.0) is None


def test_frame_budget_exhausts(tmp_path: Path) -> None:
    publisher = _Publisher()
    service = _service(tmp_path, publisher)
    check_in = _open_fall_check_in(service)
    client = _FakeConfirmClient([_vision_reply(False, 0.1), _vision_reply(False, 0.1)])
    controller = _controller(service, client)

    for _ in range(2):
        controller.submit_frame(
            scene_id="fall_demo_01",
            decision_id=check_in.decision_id,
            image_b64=_b64(JPEG_BYTES),
            timestamp_ms=14000.0,
        )
    with pytest.raises(DangerRejectedError) as excinfo:
        controller.submit_frame(
            scene_id="fall_demo_01",
            decision_id=check_in.decision_id,
            image_b64=_b64(JPEG_BYTES),
            timestamp_ms=14000.0,
        )
    assert excinfo.value.code == REJECT_CONFIRM_BUDGET


def test_frame_transport_failure_is_swallowed(tmp_path: Path) -> None:
    publisher = _Publisher()
    service = _service(tmp_path, publisher)
    check_in = _open_fall_check_in(service)
    controller = _controller(service, _FakeConfirmClient([MimoTransportError("boom", attempts=1)]))

    controller.submit_frame(
        scene_id="fall_demo_01",
        decision_id=check_in.decision_id,
        image_b64=_b64(JPEG_BYTES),
        timestamp_ms=14000.0,
    )

    assert publisher.decisions[-1].decision_id == check_in.decision_id


def test_frame_media_validation(tmp_path: Path) -> None:
    publisher = _Publisher()
    service = _service(tmp_path, publisher)
    check_in = _open_fall_check_in(service)
    controller = _controller(service, _FakeConfirmClient([]))

    with pytest.raises(DangerRejectedError) as bad_magic:
        controller.submit_frame(
            scene_id="fall_demo_01",
            decision_id=check_in.decision_id,
            image_b64=_b64(b"GIF89a not a jpeg"),
            timestamp_ms=14000.0,
        )
    assert bad_magic.value.code == REJECT_BAD_MEDIA
    with pytest.raises(DangerRejectedError) as bad_b64:
        controller.submit_frame(
            scene_id="fall_demo_01",
            decision_id=check_in.decision_id,
            image_b64="@@not-base64@@",
            timestamp_ms=14000.0,
        )
    assert bad_b64.value.code == REJECT_BAD_MEDIA


def test_frame_without_client_unavailable(tmp_path: Path) -> None:
    publisher = _Publisher()
    service = _service(tmp_path, publisher)
    check_in = _open_fall_check_in(service)
    controller = _controller(service, None)

    with pytest.raises(DangerRejectedError) as excinfo:
        controller.submit_frame(
            scene_id="fall_demo_01",
            decision_id=check_in.decision_id,
            image_b64=_b64(JPEG_BYTES),
            timestamp_ms=14000.0,
        )
    assert excinfo.value.code == REJECT_CONFIRM_UNAVAILABLE


# -- voice path --------------------------------------------------------------


def test_voice_audio_need_help_alarms_via_elder_path(tmp_path: Path) -> None:
    publisher = _Publisher()
    service = _service(tmp_path, publisher)
    check_in = _open_fall_check_in(service)
    client = _FakeConfirmClient([_voice_reply("need_help", "我摔倒了起不来")])
    controller = _controller(service, client)

    controller.submit_voice(
        scene_id="fall_demo_01",
        decision_id=check_in.decision_id,
        timestamp_ms=14000.0,
        audio_b64=_b64(WAV_BYTES),
        audio_format="wav",
    )

    alert = publisher.decisions[-1]
    assert alert.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert alert.alarm is not None
    assert alert.alarm.trigger is AlarmTrigger.VOICE_INTENT
    system_prompt, user_content = client.calls[0]
    assert "语音" in system_prompt
    assert isinstance(user_content, list)
    assert user_content[1]["type"] == "input_audio"
    assert user_content[1]["input_audio"]["format"] == "wav"


def test_voice_text_safe_resolves_without_client(tmp_path: Path) -> None:
    publisher = _Publisher()
    service = _service(tmp_path, publisher)
    check_in = _open_fall_check_in(service)
    controller = _controller(service, None)

    controller.submit_voice(
        scene_id="fall_demo_01",
        decision_id=check_in.decision_id,
        timestamp_ms=14000.0,
        text="没事没事，我就是坐下歇一会儿",
    )

    assert publisher.decisions[-1].state is DecisionState.RESOLVED


def test_voice_text_hard_danger_alarms(tmp_path: Path) -> None:
    publisher = _Publisher()
    service = _service(tmp_path, publisher)
    check_in = _open_fall_check_in(service)
    controller = _controller(service, None)

    controller.submit_voice(
        scene_id="fall_demo_01",
        decision_id=check_in.decision_id,
        timestamp_ms=14000.0,
        text="快来人啊，我起不来了",
    )

    alert = publisher.decisions[-1]
    assert alert.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert alert.alarm is not None
    assert alert.alarm.trigger is AlarmTrigger.VOICE_INTENT


def test_voice_model_unclear_with_danger_transcript_upgrades(tmp_path: Path) -> None:
    publisher = _Publisher()
    service = _service(tmp_path, publisher)
    check_in = _open_fall_check_in(service)
    client = _FakeConfirmClient([_voice_reply("unclear", "哎哟我的腿动不了")])
    controller = _controller(service, client)

    controller.submit_voice(
        scene_id="fall_demo_01",
        decision_id=check_in.decision_id,
        timestamp_ms=14000.0,
        audio_b64=_b64(WAV_BYTES),
        audio_format="wav",
    )

    alert = publisher.decisions[-1]
    assert alert.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert alert.alarm is not None and alert.alarm.trigger is AlarmTrigger.VOICE_INTENT


def test_voice_unclear_consumes_clarification(tmp_path: Path) -> None:
    publisher = _Publisher()
    service = _service(tmp_path, publisher)
    check_in = _open_fall_check_in(service)
    client = _FakeConfirmClient([_voice_reply("unclear", "呜呜")])
    controller = _controller(service, client)

    controller.submit_voice(
        scene_id="fall_demo_01",
        decision_id=check_in.decision_id,
        timestamp_ms=14000.0,
        audio_b64=_b64(WAV_BYTES),
        audio_format="wav",
    )

    clarify = publisher.decisions[-1]
    assert clarify.state is DecisionState.CHECK_IN_REQUIRED
    assert clarify.decision_id != check_in.decision_id
    # The clarify decision keeps the confirm window open for the retry.
    assert clarify.confirm_channels == ("frame", "voice")


def test_voice_validation_rejects_ambiguous_payloads(tmp_path: Path) -> None:
    publisher = _Publisher()
    service = _service(tmp_path, publisher)
    check_in = _open_fall_check_in(service)
    controller = _controller(service, _FakeConfirmClient([]))

    with pytest.raises(DangerRejectedError):
        controller.submit_voice(
            scene_id="fall_demo_01",
            decision_id=check_in.decision_id,
            timestamp_ms=14000.0,
            text="有字",
            audio_b64=_b64(WAV_BYTES),
            audio_format="wav",
        )
    with pytest.raises(DangerRejectedError):
        controller.submit_voice(
            scene_id="fall_demo_01",
            decision_id=check_in.decision_id,
            timestamp_ms=14000.0,
            audio_b64=_b64(WAV_BYTES),
            audio_format="webm",
        )
    with pytest.raises(DangerRejectedError):
        controller.submit_voice(
            scene_id="fall_demo_01",
            decision_id=check_in.decision_id,
            timestamp_ms=14000.0,
            text="   ",
        )


def test_voice_channel_not_offered_on_concern(tmp_path: Path) -> None:
    """A concern check-in advertises no confirm channels; uploads are refused."""

    bundle_dir = tmp_path / "concern_demo_01"
    bundle_dir.mkdir(parents=True)
    manifest: dict[str, Any] = {
        "schema_version": "reme-scene/v0-experiment",
        "scene_id": "concern_demo_01",
        "title": "concern",
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
            "transition_events": None,
            "recorded_decisions": None,
        },
    }
    (bundle_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (bundle_dir / "posture_observations.jsonl").write_text(
        json.dumps(
            _posture_record(
                scene_id="concern_demo_01",
                timestamp_ms=40000.0,
                posture="sitting",
                posture_duration_ms=35000.0,
            )
        )
        + "\n",
        encoding="utf-8",
    )
    publisher = _Publisher()
    service = DecisionService(
        scenes={"concern_demo_01": load_scene_streams(bundle_dir / "manifest.json")},
        config=PolicyConfig(
            trigger=TriggerConfig(),
            demo_mode=DemoMode.LIVE,
            cognition_enabled=False,
        ),
        publisher=publisher,
    )
    decision = service.get_decision(scene_id="concern_demo_01", timestamp_ms=41000.0)
    assert decision.state is DecisionState.CHECK_IN_REQUIRED
    assert decision.confirm_channels is None
    controller = _controller(service, _FakeConfirmClient([]))
    with pytest.raises(DangerRejectedError) as excinfo:
        controller.submit_voice(
            scene_id="concern_demo_01",
            decision_id=decision.decision_id,
            timestamp_ms=42000.0,
            text="没事",
        )
    assert excinfo.value.code == REJECT_NO_CONFIRM_PENDING


# -- timeout path keeps its alarm --------------------------------------------


def test_fall_timeout_alert_carries_alarm(tmp_path: Path) -> None:
    publisher = _Publisher()
    service = _service(tmp_path, publisher)
    check_in = _open_fall_check_in(service)

    alert = service.submit_response(
        InteractionResponse(
            scene_id="fall_demo_01",
            decision_id=check_in.decision_id,
            timestamp_ms=21000.0,
            response=ResponseValue.NONE,
            source=ResponseSource.TIMEOUT,
            demo_mode=DemoMode.LIVE,
        )
    )
    assert alert.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert alert.alarm is not None
    assert alert.alarm.trigger is AlarmTrigger.CHECK_IN_TIMEOUT


def test_visual_confirm_then_late_safe_keeps_alert(tmp_path: Path) -> None:
    publisher = _Publisher()
    service = _service(tmp_path, publisher)
    check_in = _open_fall_check_in(service)
    controller = _controller(service, _FakeConfirmClient([_vision_reply(True)]))
    controller.submit_frame(
        scene_id="fall_demo_01",
        decision_id=check_in.decision_id,
        image_b64=_b64(JPEG_BYTES),
        timestamp_ms=14000.0,
    )
    alert = publisher.decisions[-1]
    assert alert.alarm is not None and alert.alarm.trigger is AlarmTrigger.VISUAL_CONFIRM

    late_safe = service.submit_response(
        InteractionResponse(
            scene_id="fall_demo_01",
            decision_id=alert.decision_id,
            timestamp_ms=16000.0,
            response=ResponseValue.SAFE,
            source=ResponseSource.USER_INPUT,
            demo_mode=DemoMode.LIVE,
        )
    )
    # Late safe closes the episode but the family alert was already sent
    # (LATE_SAFE_RESOLVED wording tells the elder the family knows).
    assert late_safe.state is DecisionState.RESOLVED
