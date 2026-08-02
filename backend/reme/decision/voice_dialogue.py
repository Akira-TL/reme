"""B-owned elder voice pipeline: WAV -> ASR -> decision -> TTS.

C records and plays audio only. This controller keeps transcript interpretation,
state transitions, and MiMo credentials inside B so button and spoken replies
share the same DecisionService contract.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from typing import Protocol

from reme.decision.mimo.confirm import classify_reply_text
from reme.decision.mimo.speech import (
    SUPPORTED_ASR_FORMATS,
    MimoSpeechClient,
    MimoSpeechError,
    SpeechRecognitionResult,
    SpeechSynthesisResult,
)
from reme.decision.records import (
    CareDecision,
    DemoMode,
    InteractionResponse,
    ResponseSource,
    ResponseValue,
)


class VoiceDialogueError(ValueError):
    """A voice request B cannot complete; ``code`` maps to HTTP status."""

    def __init__(self, code: str, message: str | None = None) -> None:
        super().__init__(message or code)
        self.code = code


class VoiceDecisionService(Protocol):
    @property
    def demo_mode(self) -> DemoMode: ...

    def current_decision(self, scene_id: str) -> CareDecision | None: ...

    def submit_response(self, response: InteractionResponse) -> CareDecision: ...


@dataclass(frozen=True, slots=True)
class VoiceAudio:
    audio_b64: str
    audio_format: str
    voice: str
    model: str
    latency_ms: float

    @classmethod
    def from_result(cls, result: SpeechSynthesisResult) -> VoiceAudio:
        return cls(
            audio_b64=result.audio_b64,
            audio_format=result.audio_format,
            voice=result.voice,
            model=result.model,
            latency_ms=result.latency_ms,
        )

    def to_payload(self) -> dict[str, object]:
        return {
            "audio_b64": self.audio_b64,
            "audio_format": self.audio_format,
            "voice": self.voice,
            "tts_model": self.model,
            "tts_latency_ms": self.latency_ms,
        }


@dataclass(frozen=True, slots=True)
class VoiceDialogueResult:
    transcript: str
    response_value: ResponseValue
    decision: CareDecision
    recognition: SpeechRecognitionResult
    audio: VoiceAudio | None

    def to_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "transcript": self.transcript,
            "response_value": self.response_value.value,
            "asr_model": self.recognition.model,
            "asr_latency_ms": self.recognition.latency_ms,
            "decision": self.decision.to_payload(),
            "audio_b64": None,
            "audio_format": None,
            "voice": None,
            "tts_model": None,
            "tts_latency_ms": None,
        }
        if self.audio is not None:
            payload.update(self.audio.to_payload())
        return payload


class VoiceDialogueController:
    """Synchronous controller used by B's ThreadingHTTPServer handlers."""

    def __init__(
        self,
        *,
        service: VoiceDecisionService,
        speech: MimoSpeechClient | None,
        max_audio_bytes: int = 2_000_000,
    ) -> None:
        self._service = service
        self._speech = speech
        self._max_audio_bytes = max_audio_bytes

    def synthesize_decision(
        self, *, scene_id: str, decision_id: str
    ) -> tuple[CareDecision, VoiceAudio]:
        decision = self._require_decision(scene_id, decision_id)
        if decision.elder_message is None:
            raise VoiceDialogueError("no_elder_message")
        result = self._synthesize(decision.elder_message)
        return decision, VoiceAudio.from_result(result)

    def submit_audio_reply(
        self,
        *,
        scene_id: str,
        decision_id: str,
        timestamp_ms: float,
        audio_b64: str,
        audio_format: str,
    ) -> VoiceDialogueResult:
        decision = self._require_decision(scene_id, decision_id)
        speech = self._require_speech()
        audio_bytes = self._decode_audio(audio_b64, audio_format)
        try:
            recognition = speech.transcribe(audio_bytes, audio_format=audio_format)
        except MimoSpeechError as exc:
            raise VoiceDialogueError("asr_failed", str(exc)) from exc
        response_value = _classify_transcript(recognition.transcript, decision)
        response = InteractionResponse(
            scene_id=scene_id,
            decision_id=decision_id,
            timestamp_ms=timestamp_ms,
            response=response_value,
            source=ResponseSource.VOICE,
            demo_mode=self._service.demo_mode,
            text=recognition.transcript,
        )
        next_decision = self._service.submit_response(response)
        audio = None
        if next_decision.elder_message is not None:
            audio = VoiceAudio.from_result(self._synthesize(next_decision.elder_message))
        return VoiceDialogueResult(
            transcript=recognition.transcript,
            response_value=response_value,
            decision=next_decision,
            recognition=recognition,
            audio=audio,
        )

    def _require_decision(self, scene_id: str, decision_id: str) -> CareDecision:
        decision = self._service.current_decision(scene_id)
        if decision is None:
            raise VoiceDialogueError("no_pending_decision")
        if decision.decision_id != decision_id:
            raise VoiceDialogueError("stale_decision")
        return decision

    def _require_speech(self) -> MimoSpeechClient:
        if self._speech is None:
            raise VoiceDialogueError("speech_unavailable")
        return self._speech

    def _synthesize(self, text: str) -> SpeechSynthesisResult:
        try:
            return self._require_speech().synthesize(text)
        except MimoSpeechError as exc:
            raise VoiceDialogueError("tts_failed", str(exc)) from exc

    def _decode_audio(self, encoded: str, audio_format: str) -> bytes:
        if audio_format not in SUPPORTED_ASR_FORMATS:
            raise VoiceDialogueError("bad_audio", f"unsupported audio format: {audio_format}")
        if len(encoded) > self._max_audio_bytes * 4 // 3 + 8:
            raise VoiceDialogueError("bad_audio", "audio payload is too large")
        try:
            payload = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise VoiceDialogueError("bad_audio", "audio_b64 is invalid") from exc
        if not payload or len(payload) > self._max_audio_bytes:
            raise VoiceDialogueError("bad_audio", "audio payload is empty or too large")
        if audio_format == "wav" and not payload.startswith(b"RIFF"):
            raise VoiceDialogueError("bad_audio", "WAV payload has an invalid header")
        return payload


def _classify_transcript(transcript: str, decision: CareDecision) -> ResponseValue:
    text = transcript.strip()
    if decision.consent_required:
        denied_phrases = ("不分享", "不要分享", "不发", "不用发", "拒绝", "算了")
        if any(phrase in text for phrase in denied_phrases):
            return ResponseValue.CONSENT_DENIED
        if any(phrase in text for phrase in ("分享", "发给", "可以", "同意", "愿意")):
            return ResponseValue.CONSENT_GRANTED
        return ResponseValue.UNCLEAR

    deterministic = classify_reply_text(text)
    if deterministic is not None:
        return deterministic
    if any(phrase in text for phrase in ("需要帮助", "帮我", "不舒服", "难受")):
        return ResponseValue.NEED_HELP
    return ResponseValue.UNCLEAR
