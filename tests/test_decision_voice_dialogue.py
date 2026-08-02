"""Focused safety tests for B's synchronous voice-dialogue controller."""

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
    Uncertainty,
)
from reme.decision.voice_dialogue import VoiceDialogueController, VoiceDialogueError


def _decision(
    *,
    decision_id: str,
    state: DecisionState,
    action: DecisionAction,
    risk_level: int,
    elder_message: str | None,
    family_notification: str | None = None,
    alarm: AlarmSignal | None = None,
) -> CareDecision:
    return CareDecision(
        scene_id="fall_demo_01",
        decision_id=decision_id,
        timestamp_ms=1000.0,
        state=state,
        risk_level=risk_level,
        privacy_mode=PrivacyMode.SKELETON_ONLY,
        need_dialogue=elder_message is not None,
        dialogue_goal="confirm_safety" if action is DecisionAction.ASK_ELDER else None,
        elder_message=elder_message,
        family_notification=family_notification,
        action=action,
        reason_summary="test",
        uncertainty=Uncertainty.LOW,
        fallback_used=False,
        source=DecisionSource.RULE,
        demo_mode=DemoMode.LIVE,
        alarm=alarm,
    )


class _Speech:
    def __init__(self, transcript: str = "我没事") -> None:
        self.transcript = transcript
        self.synthesized: list[str] = []

    def transcribe(self, audio: bytes, *, audio_format: str) -> SpeechRecognitionResult:
        assert audio.startswith(b"RIFF")
        assert audio_format == "wav"
        return SpeechRecognitionResult(
            transcript=self.transcript,
            model="mimo-v2.5-asr",
            latency_ms=1.0,
            attempts=1,
        )

    def synthesize(self, text: str) -> SpeechSynthesisResult:
        self.synthesized.append(text)
        return SpeechSynthesisResult(
            audio_b64=base64.b64encode(b"RIFFtts").decode("ascii"),
            audio_format="wav",
            voice="mimo_default",
            model="mimo-v2.5-tts",
            latency_ms=1.0,
            attempts=1,
        )


class _Service:
    demo_mode = DemoMode.LIVE

    def __init__(self, current: CareDecision, next_decision: CareDecision) -> None:
        self.current = current
        self.next_decision = next_decision
        self.started: list[str] = []
        self.ready: list[str] = []
        self.responses: list[InteractionResponse] = []

    def current_decision(self, scene_id: str) -> CareDecision | None:
        assert scene_id == self.current.scene_id
        return self.current

    def mark_decision_voice_started(self, *, scene_id: str, decision_id: str) -> None:
        assert scene_id == self.current.scene_id
        self.started.append(decision_id)

    def mark_decision_voice_ready(self, *, scene_id: str, decision_id: str) -> None:
        assert scene_id == self.current.scene_id
        self.ready.append(decision_id)

    def submit_response(self, response: InteractionResponse) -> CareDecision:
        self.responses.append(response)
        return self.next_decision


def _check_in() -> CareDecision:
    return _decision(
        decision_id="decision-0001",
        state=DecisionState.CHECK_IN_REQUIRED,
        action=DecisionAction.ASK_ELDER,
        risk_level=2,
        elder_message="您还好吗？",
    )


def test_synthesize_rejects_resolved_or_alarm_decisions() -> None:
    speech = _Speech()
    for decision in (
        _decision(
            decision_id="decision-resolved",
            state=DecisionState.RESOLVED,
            action=DecisionAction.MARK_RESOLVED,
            risk_level=0,
            # Defensive fixture for an old/replayed decision that still carries text.
            elder_message="已经结束。",
        ),
        _decision(
            decision_id="decision-alarm",
            state=DecisionState.FAMILY_NOTIFICATION_REQUIRED,
            action=DecisionAction.NOTIFY_FAMILY,
            risk_level=3,
            elder_message="已经通知家人。",
            family_notification="请立即查看。",
            alarm=AlarmSignal(channels=("ring",), trigger=AlarmTrigger.VOICE_INTENT),
        ),
    ):
        service = _Service(decision, decision)
        controller = VoiceDialogueController(service=service, speech=speech)  # type: ignore[arg-type]
        with pytest.raises(VoiceDialogueError, match="no_elder_message"):
            controller.synthesize_decision(
                scene_id=decision.scene_id,
                decision_id=decision.decision_id,
            )
        assert service.started == []
    assert speech.synthesized == []


@pytest.mark.parametrize(
    "next_decision",
    [
        _decision(
            decision_id="decision-resolved",
            state=DecisionState.RESOLVED,
            action=DecisionAction.MARK_RESOLVED,
            risk_level=0,
            elder_message="已经结束。",
        ),
        _decision(
            decision_id="decision-alarm",
            state=DecisionState.FAMILY_NOTIFICATION_REQUIRED,
            action=DecisionAction.NOTIFY_FAMILY,
            risk_level=3,
            elder_message="已经通知家人。",
            family_notification="请立即查看。",
            alarm=AlarmSignal(channels=("ring",), trigger=AlarmTrigger.VOICE_INTENT),
        ),
    ],
)
def test_voice_reply_does_not_synthesize_resolved_or_alarm_followup(
    next_decision: CareDecision,
) -> None:
    speech = _Speech()
    service = _Service(_check_in(), next_decision)
    controller = VoiceDialogueController(service=service, speech=speech)  # type: ignore[arg-type]

    result = controller.submit_audio_reply(
        scene_id="fall_demo_01",
        decision_id="decision-0001",
        timestamp_ms=2000.0,
        audio_b64=base64.b64encode(b"RIFFvoice").decode("ascii"),
        audio_format="wav",
    )

    assert result.audio is None
    assert speech.synthesized == []
