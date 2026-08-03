from __future__ import annotations

import base64

import pytest
from reme.decision.mimo.speech import SpeechRecognitionResult, SpeechSynthesisResult
from reme.decision.records import (
    AlarmSignal,
    AlarmTrigger,
    CareDecision,
    DecisionAction,
    DecisionSource,
    DecisionState,
    DemoMode,
    InteractionResponse,
    PrivacyMode,
    ResponseValue,
    Uncertainty,
)
from reme.decision.voice_dialogue import VoiceDialogueController, VoiceDialogueError


def _decision(
    *,
    resolved: bool,
    decision_id: str | None = None,
    alarm: AlarmSignal | None = None,
) -> CareDecision:
    return CareDecision(
        scene_id="fall_demo_01",
        decision_id=decision_id or ("decision-0002" if resolved else "decision-0001"),
        timestamp_ms=15000.0 if resolved else 13000.0,
        state=(
            DecisionState.FAMILY_NOTIFICATION_REQUIRED
            if alarm is not None
            else DecisionState.RESOLVED if resolved else DecisionState.CHECK_IN_REQUIRED
        ),
        risk_level=3 if alarm is not None else 0 if resolved else 2,
        privacy_mode=PrivacyMode.BLURRED,
        need_dialogue=True,
        dialogue_goal=None if resolved else "confirm_safety",
        elder_message=(
            "王奶奶，已经通知家人。"
            if alarm is not None
            else
            "王奶奶，好的，那您注意安全，有需要随时叫我。"
            if resolved
            else "王奶奶，刚才看您像是摔了一下，您还好吗？"
        ),
        family_notification="请立即查看。" if alarm is not None else None,
        action=(
            DecisionAction.NOTIFY_FAMILY
            if alarm is not None
            else DecisionAction.MARK_RESOLVED if resolved else DecisionAction.ASK_ELDER
        ),
        reason_summary="老人确认安全" if resolved else "检测到跌倒式转变",
        uncertainty=Uncertainty.LOW if resolved else Uncertainty.MEDIUM,
        fallback_used=False,
        source=DecisionSource.RULE,
        demo_mode=DemoMode.LIVE,
        response_timeout_ms=None if resolved else 2000,
        alarm=alarm,
    )


class _Service:
    demo_mode = DemoMode.LIVE

    def __init__(
        self,
        current: CareDecision | None = None,
        next_decision: CareDecision | None = None,
    ) -> None:
        self.pending = current or _decision(resolved=False)
        self.next_decision = next_decision
        self.response = None
        self.started: list[str] = []
        self.ready: list[str] = []

    def current_decision(self, scene_id: str) -> CareDecision | None:
        assert scene_id == self.pending.scene_id
        return self.pending

    def mark_decision_voice_started(self, *, scene_id: str, decision_id: str) -> None:
        assert scene_id == self.pending.scene_id
        self.started.append(decision_id)

    def mark_decision_voice_ready(self, *, scene_id: str, decision_id: str) -> None:
        assert scene_id == self.pending.scene_id
        self.ready.append(decision_id)

    def submit_response(self, response: InteractionResponse) -> CareDecision:
        self.response = response
        self.pending = self.next_decision or _decision(resolved=True)
        return self.pending


class _Speech:
    def __init__(self) -> None:
        self.synthesized: list[str] = []

    def transcribe(self, audio: bytes, *, audio_format: str) -> SpeechRecognitionResult:
        assert audio and audio_format == "wav"
        return SpeechRecognitionResult(
            transcript="我还好",
            model="mimo-v2.5-asr",
            latency_ms=120.0,
            attempts=1,
        )

    def synthesize(self, text: str) -> SpeechSynthesisResult:
        self.synthesized.append(text)
        return SpeechSynthesisResult(
            audio_b64=base64.b64encode(b"safe-ack").decode("ascii"),
            audio_format="wav",
            voice="default",
            model="mimo-v2.5-tts",
            latency_ms=90.0,
            attempts=1,
        )


def test_synthesize_allows_resolved_acknowledgement_but_rejects_alarm() -> None:
    speech = _Speech()
    resolved = _decision(resolved=True, decision_id="decision-resolved")
    service = _Service(current=resolved, next_decision=resolved)
    controller = VoiceDialogueController(service=service, speech=speech)  # type: ignore[arg-type]

    decision, audio = controller.synthesize_decision(
        scene_id=resolved.scene_id,
        decision_id=resolved.decision_id,
    )

    assert decision is resolved
    assert audio.audio_b64
    assert speech.synthesized == [resolved.elder_message]
    assert service.started == ["decision-resolved"]
    assert service.ready == ["decision-resolved"]

    alarm = _decision(
        resolved=False,
        decision_id="decision-alarm",
        alarm=AlarmSignal(channels=("ring",), trigger=AlarmTrigger.VOICE_INTENT),
    )
    service = _Service(current=alarm, next_decision=alarm)
    controller = VoiceDialogueController(service=service, speech=speech)  # type: ignore[arg-type]
    with pytest.raises(VoiceDialogueError, match="no_elder_message"):
        controller.synthesize_decision(scene_id=alarm.scene_id, decision_id=alarm.decision_id)


def test_safe_voice_reply_resolves_and_synthesizes_acknowledgement() -> None:
    service = _Service()
    speech = _Speech()
    controller = VoiceDialogueController(service=service, speech=speech)

    result = controller.submit_audio_reply(
        scene_id="fall_demo_01",
        decision_id="decision-0001",
        timestamp_ms=15000.0,
        audio_b64=base64.b64encode(b"RIFFvoice").decode("ascii"),
        audio_format="wav",
    )

    assert result.transcript == "我还好"
    assert result.response_value is ResponseValue.SAFE
    assert result.decision.state is DecisionState.RESOLVED
    assert result.audio is not None
    assert speech.synthesized == [result.decision.elder_message]
    assert service.response is not None
    assert service.response.response is ResponseValue.SAFE
