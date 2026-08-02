"""Danger-link MiMo calls: visual fall confirmation and voice intent.

Both calls are deliberately tiny — one system prompt, one media part, a flat
JSON verdict — because the danger link optimises for latency over nuance
(用户定调: 生命的价值优先于它的误报). Neither call gates a deterministic
escalation: a slow or failed confirmation simply leaves the countdown rules
in charge (ADR-0005), so the worst case of this module is "no earlier alarm",
never "no alarm".

Measured 2026-08-01 against ``mimo-v2.5`` (JSON mode, thinking disabled):
single-JPEG fall judgment ~2.1s; 4s voice clip transcribed and classified in
one omni call ~0.9-2.0s; ``input_audio`` accepts wav/mp3/m4a/ogg/flac and
rejects webm.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from reme.decision.mimo.adapter import build_audio_part, build_image_part
from reme.decision.mimo.schema import MimoSchemaError
from reme.decision.records import ResponseValue

VISION_CONFIRM_SYSTEM_PROMPT = (
    "你是居家安全画面确认器。你会看到一张家中摄像头画面。"
    "只判断一件事：画面中的人是否摔倒或瘫倒在地面（含床沿/家具旁滑落在地）。"
    '只输出 JSON 对象：{"fallen": true|false, "confidence": 0到1的小数, "reason": "一句话依据"}。'
    "看不到人、画面不清或无法判断时输出 fallen=false 并给出低 confidence。"
    "不要输出任何其他字段或文字。"
)

VOICE_INTENT_SYSTEM_PROMPT = (
    "你是老人语音回应判读器。刚才系统询问了老人是否摔倒/是否需要帮助，"
    "你会听到老人的语音回应。只输出 JSON 对象："
    '{"intent": "need_help"|"safe"|"unclear", "transcript": "听到的原话"}。'
    "表示摔倒、疼痛、起不来、呼救、需要帮忙的一律 need_help；"
    "明确表示没事、安全、不需要帮助的是 safe；"
    "听不清、无人声或含义不明的是 unclear。不要输出任何其他字段或文字。"
)

VISION_CONFIRM_USER_TEXT = "这是刚检测到疑似跌倒后的实时画面，请判断画面中的人是否摔倒在地。"
VOICE_INTENT_USER_TEXT = "这是老人对“您是否摔倒了”的语音回应，请判断意图。"

# Deterministic guardrail vocabulary for the voice path.  Hard phrases force
# need_help regardless of the model's verdict; soft phrases only lift an
# `unclear` to need_help (never override an explicit safe — the elder's clear
# answer stays authoritative).  Negated fall phrases are stripped before the
# scan so “我没摔倒” cannot trip the soft token “摔”.
HARD_DANGER_PHRASES = (
    "救命",
    "快来人",
    "快来帮",
    "起不来",
    "站不起来",
    "动不了",
    "帮帮我",
    "扶我",
)
SOFT_DANGER_PHRASES = ("摔", "跌", "疼", "痛")
_NEGATED_FALL_PHRASES = ("没摔", "没有摔", "没跌", "没有跌", "不疼", "不痛")


@dataclass(frozen=True, slots=True)
class VisionVerdict:
    """Flat verdict of one visual fall confirmation."""

    fallen: bool
    confidence: float
    reason: str


@dataclass(frozen=True, slots=True)
class VoiceIntent:
    """Flat verdict of one voice-reply interpretation."""

    intent: ResponseValue
    transcript: str | None


def build_vision_confirm_content(image_bytes: bytes, *, mime_type: str = "image/jpeg") -> list[
    dict[str, Any]
]:
    """User content for one visual confirmation call."""

    return [
        {"type": "text", "text": VISION_CONFIRM_USER_TEXT},
        build_image_part(image_bytes, mime_type=mime_type),
    ]


def build_voice_intent_content(audio_bytes: bytes, *, audio_format: str) -> list[dict[str, Any]]:
    """User content for one voice-intent call (omni: ASR + intent in one hop)."""

    return [
        {"type": "text", "text": VOICE_INTENT_USER_TEXT},
        build_audio_part(audio_bytes, audio_format=audio_format),
    ]


def _load_flat_object(raw_text: str, *, allowed: set[str], label: str) -> dict[str, Any]:
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise MimoSchemaError(f"{label} is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise MimoSchemaError(f"{label} must be a JSON object")
    unknown = sorted(set(payload) - allowed)
    if unknown:
        raise MimoSchemaError(f"{label} has unexpected fields: {', '.join(unknown)}")
    return payload

def parse_vision_verdict(raw_text: str) -> VisionVerdict:
    """Parse one visual confirmation reply; violations raise MimoSchemaError."""

    payload = _load_flat_object(
        raw_text, allowed={"fallen", "confidence", "reason"}, label="vision verdict"
    )
    fallen = payload.get("fallen")
    if not isinstance(fallen, bool):
        raise MimoSchemaError("vision verdict fallen must be a boolean")
    confidence = payload.get("confidence")
    if isinstance(confidence, bool) or not isinstance(confidence, int | float):
        raise MimoSchemaError("vision verdict confidence must be a number")
    reason = payload.get("reason", "")
    if reason is None:
        reason = ""
    if not isinstance(reason, str):
        raise MimoSchemaError("vision verdict reason must be a string")
    clamped = min(1.0, max(0.0, float(confidence)))
    return VisionVerdict(fallen=fallen, confidence=clamped, reason=reason.strip())


_VOICE_INTENTS: dict[str, ResponseValue] = {
    "need_help": ResponseValue.NEED_HELP,
    "safe": ResponseValue.SAFE,
    "unclear": ResponseValue.UNCLEAR,
}


def parse_voice_intent(raw_text: str) -> VoiceIntent:
    """Parse one voice-intent reply; violations raise MimoSchemaError."""

    payload = _load_flat_object(
        raw_text, allowed={"intent", "transcript"}, label="voice intent"
    )
    intent_raw = payload.get("intent")
    intent = _VOICE_INTENTS.get(intent_raw) if isinstance(intent_raw, str) else None
    if intent is None:
        raise MimoSchemaError(
            f"voice intent must be one of {sorted(_VOICE_INTENTS)}, got {intent_raw!r}"
        )
    transcript = payload.get("transcript")
    if transcript is not None and not isinstance(transcript, str):
        raise MimoSchemaError("voice intent transcript must be a string")
    cleaned = None if transcript is None else transcript.strip()
    return VoiceIntent(intent=intent, transcript=cleaned or None)


def classify_reply_text(text: str) -> ResponseValue | None:
    """Deterministic keyword verdict for a textual reply; None when unsure."""

    stripped = text
    for phrase in _NEGATED_FALL_PHRASES:
        stripped = stripped.replace(phrase, "")
    if any(phrase in stripped for phrase in HARD_DANGER_PHRASES + SOFT_DANGER_PHRASES):
        return ResponseValue.NEED_HELP
    if any(phrase in text for phrase in ("没事", "没什么事", "还好", "挺好", "不用管", "安全")):
        return ResponseValue.SAFE
    return None


def guard_voice_intent(verdict: VoiceIntent) -> VoiceIntent:
    """Apply the upgrade-only keyword guardrail to a model verdict.

    Danger words in the transcript may only push the intent *toward*
    need_help; nothing here can soften a need_help or flip an explicit safe
    on soft evidence.
    """

    transcript = verdict.transcript
    if transcript is None or verdict.intent is ResponseValue.NEED_HELP:
        return verdict
    stripped = transcript
    for phrase in _NEGATED_FALL_PHRASES:
        stripped = stripped.replace(phrase, "")
    if any(phrase in stripped for phrase in HARD_DANGER_PHRASES):
        return VoiceIntent(intent=ResponseValue.NEED_HELP, transcript=transcript)
    if verdict.intent is ResponseValue.UNCLEAR and any(
        phrase in stripped for phrase in SOFT_DANGER_PHRASES
    ):
        return VoiceIntent(intent=ResponseValue.NEED_HELP, transcript=transcript)
    return verdict
