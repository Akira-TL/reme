"""Contract records B shares with C: CareDecision and InteractionResponse."""

from __future__ import annotations

import json
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path
from typing import Any

DECISION_SCHEMA_VERSION = "reme-care-decision/v0-experiment"
RESPONSE_SCHEMA_VERSION = "reme-interaction-response/v0-experiment"


class DecisionRecordError(ValueError):
    """Raised when a decision-layer record violates the shared A/B/C contract."""


class DecisionState(StrEnum):
    """Business state attached to one care decision (contract section 10.1)."""

    NORMAL = "normal"
    OBSERVE = "observe"
    CHECK_IN_REQUIRED = "check_in_required"
    CONSENT_REQUIRED = "consent_required"
    FAMILY_NOTIFICATION_REQUIRED = "family_notification_required"
    URGENT_ATTENTION = "urgent_attention"
    RESOLVED = "resolved"
    DEGRADED = "degraded"


class PrivacyMode(StrEnum):
    """Rendering instruction for source imagery (contract section 10.2)."""

    VISIBLE = "visible"
    BLURRED = "blurred"
    SKELETON_ONLY = "skeleton_only"
    HIDDEN = "hidden"


class DecisionAction(StrEnum):
    """Current action C must render (contract section 10.3)."""

    NONE = "none"
    OBSERVE = "observe"
    ASK_ELDER = "ask_elder"
    NOTIFY_FAMILY = "notify_family"
    SHOW_URGENT_ATTENTION = "show_urgent_attention"
    MARK_RESOLVED = "mark_resolved"


class DecisionSource(StrEnum):
    """Provenance of one care decision (contract section 10.4)."""

    RULE = "rule"
    MIMO = "mimo"
    MOCK = "mock"
    RECORD = "record"
    DEGRADED = "degraded"


class DemoMode(StrEnum):
    """Demo adapter mode the decision was produced under (contract section 10.5)."""

    LIVE = "live"
    MOCK = "mock"
    RECORD = "record"


class Uncertainty(StrEnum):
    """Decision-level uncertainty (contract section 4.3)."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    UNKNOWN = "unknown"


class CardStatus(StrEnum):
    """Action card handling status (contract section 10.6)."""

    PENDING = "pending"
    CONFIRMED = "confirmed"
    DONE = "done"


class VisualContextType(StrEnum):
    """Kind of visual payload sent to MiMo under ADR-0003."""

    KEYFRAMES = "keyframes"
    CLIP = "clip"


class ResponseValue(StrEnum):
    """Elder/family response values (contract section 11.1)."""

    SAFE = "safe"
    NEED_HELP = "need_help"
    UNCLEAR = "unclear"
    NONE = "none"
    CONSENT_GRANTED = "consent_granted"
    CONSENT_DENIED = "consent_denied"
    CARD_CONFIRMED = "card_confirmed"


class ResponseSource(StrEnum):
    """Who produced the response (contract section 11.2)."""

    USER_INPUT = "user_input"
    FAMILY_INPUT = "family_input"
    SCRIPT = "script"
    TIMEOUT = "timeout"
    # Superset value (danger link): B's own voice-intent loop submits the
    # elder's spoken reply on their behalf; `text` carries the transcript.
    VOICE = "voice"


class AlarmTrigger(StrEnum):
    """Which deterministic path fired a family alarm (danger link)."""

    ELDER_REPORT = "elder_report"
    VOICE_INTENT = "voice_intent"
    VISUAL_CONFIRM = "visual_confirm"
    CHECK_IN_TIMEOUT = "check_in_timeout"
    UNCLEAR_RESPONSE = "unclear_response"
    FAMILY_UNRESPONSIVE = "family_unresponsive"


# Channel vocabularies for the danger link's superset fields.  Both are closed
# lists so C can hard-code renderers against them.
ALARM_CHANNELS = ("vibrate", "ring", "flash")
CONFIRM_CHANNELS = ("frame", "voice")

_TEXT_BEARING_RESPONSE_SOURCES = {
    ResponseSource.USER_INPUT,
    ResponseSource.SCRIPT,
    ResponseSource.VOICE,
}
_NONE_RESPONSE_SOURCES = {ResponseSource.TIMEOUT, ResponseSource.SCRIPT}
_ELDER_RESPONSE_SOURCES = {
    ResponseSource.USER_INPUT,
    ResponseSource.SCRIPT,
    ResponseSource.VOICE,
}


def _require_non_empty(value: str, label: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise DecisionRecordError(f"{label} must be a non-empty string")


def _require_optional_text(value: str | None, label: str) -> None:
    if value is None:
        return
    _require_non_empty(value, label)


def _require_timestamp(value: float, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int | float) or value < 0:
        raise DecisionRecordError(f"{label} must be a non-negative number")


@dataclass(frozen=True, slots=True)
class ActionCard:
    """Six mandatory elements of one family action card (contract section 10.6)."""

    event: str
    elder_quote: str
    system_judgment: str
    suggested_action: str
    time_window: str
    status: CardStatus

    def __post_init__(self) -> None:
        for label in ("event", "elder_quote", "system_judgment", "suggested_action", "time_window"):
            _require_non_empty(getattr(self, label), f"action_card.{label}")
        if not isinstance(self.status, CardStatus):
            raise DecisionRecordError("action_card.status must be a CardStatus")

    def to_payload(self) -> dict[str, Any]:
        return {
            "event": self.event,
            "elder_quote": self.elder_quote,
            "system_judgment": self.system_judgment,
            "suggested_action": self.suggested_action,
            "time_window": self.time_window,
            "status": self.status.value,
        }


@dataclass(frozen=True, slots=True)
class VisualContext:
    """Truthful record of the visual payload sent to MiMo (ADR-0003)."""

    sent_to_mimo: bool
    type: VisualContextType | None = None
    start_ms: float | None = None
    end_ms: float | None = None
    sample_count: int | None = None

    def __post_init__(self) -> None:
        if self.sent_to_mimo:
            if self.type is None:
                raise DecisionRecordError("visual_context.type is required when sent_to_mimo")
        elif not (
            self.type is None
            and self.start_ms is None
            and self.end_ms is None
            and self.sample_count is None
        ):
            raise DecisionRecordError("visual_context fields must be null when nothing was sent")
        for label in ("start_ms", "end_ms"):
            value = getattr(self, label)
            if value is not None:
                _require_timestamp(value, f"visual_context.{label}")
        if self.start_ms is not None and self.end_ms is not None and self.end_ms < self.start_ms:
            raise DecisionRecordError("visual_context.end_ms must be >= start_ms")
        if self.sample_count is not None and (
            isinstance(self.sample_count, bool)
            or not isinstance(self.sample_count, int)
            or self.sample_count <= 0
        ):
            raise DecisionRecordError("visual_context.sample_count must be a positive integer")

    def to_payload(self) -> dict[str, Any]:
        return {
            "sent_to_mimo": self.sent_to_mimo,
            "type": None if self.type is None else self.type.value,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "sample_count": self.sample_count,
        }


@dataclass(frozen=True, slots=True)
class AlarmSignal:
    """Family-device alarm instruction attached to a danger-link alert.

    ``channels`` tells the family view how to demand attention (vibrate loop,
    ringtone, flashlight/screen strobe); ``trigger`` records which deterministic
    path fired the alarm.  The field is decoration on an already-escalated
    decision — it never appears below family-alert severity.
    """

    channels: tuple[str, ...]
    trigger: AlarmTrigger

    def __post_init__(self) -> None:
        if not isinstance(self.channels, tuple) or not self.channels:
            raise DecisionRecordError("alarm.channels must be a non-empty tuple")
        unknown = [channel for channel in self.channels if channel not in ALARM_CHANNELS]
        if unknown:
            raise DecisionRecordError(
                f"alarm.channels must be within {list(ALARM_CHANNELS)}, got {unknown}"
            )
        if len(set(self.channels)) != len(self.channels):
            raise DecisionRecordError("alarm.channels must not repeat")
        if not isinstance(self.trigger, AlarmTrigger):
            raise DecisionRecordError("alarm.trigger must be an AlarmTrigger")

    def to_payload(self) -> dict[str, Any]:
        return {"channels": list(self.channels), "trigger": self.trigger.value}


@dataclass(frozen=True, slots=True)
class CareDecision:
    """One outbound decision for C (contract section 10)."""

    scene_id: str
    decision_id: str
    timestamp_ms: float
    state: DecisionState
    risk_level: int
    privacy_mode: PrivacyMode
    need_dialogue: bool
    dialogue_goal: str | None
    elder_message: str | None
    family_notification: str | None
    action: DecisionAction
    reason_summary: str
    uncertainty: Uncertainty
    fallback_used: bool
    source: DecisionSource
    demo_mode: DemoMode
    consent_required: bool = False
    response_timeout_ms: int | None = None
    action_card: ActionCard | None = None
    visual_context: VisualContext | None = None
    alarm: AlarmSignal | None = None
    voice_asset: str | None = None
    confirm_channels: tuple[str, ...] | None = None
    schema_version: str = DECISION_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != DECISION_SCHEMA_VERSION:
            raise DecisionRecordError(
                f"schema_version must be {DECISION_SCHEMA_VERSION!r}, got {self.schema_version!r}"
            )
        _require_non_empty(self.scene_id, "scene_id")
        _require_non_empty(self.decision_id, "decision_id")
        _require_timestamp(self.timestamp_ms, "timestamp_ms")
        if isinstance(self.risk_level, bool) or not isinstance(self.risk_level, int):
            raise DecisionRecordError("risk_level must be an integer")
        if not 0 <= self.risk_level <= 4:
            raise DecisionRecordError(f"risk_level must be within 0..4, got {self.risk_level}")
        _require_non_empty(self.reason_summary, "reason_summary")
        _require_optional_text(self.dialogue_goal, "dialogue_goal")
        _require_optional_text(self.elder_message, "elder_message")
        _require_optional_text(self.family_notification, "family_notification")
        if not self.need_dialogue and self.elder_message is not None:
            raise DecisionRecordError("elder_message must be null when need_dialogue is false")
        if self.action is DecisionAction.NOTIFY_FAMILY and self.family_notification is None:
            raise DecisionRecordError("family_notification is required when action=notify_family")
        if self.consent_required and self.action is DecisionAction.NOTIFY_FAMILY:
            raise DecisionRecordError("action=notify_family is forbidden while consent is pending")
        if self.state is DecisionState.CONSENT_REQUIRED:
            if self.risk_level != 2:
                raise DecisionRecordError("state=consent_required pins risk_level to 2")
            if not self.consent_required:
                raise DecisionRecordError("state=consent_required requires consent_required=true")
        if self.state is DecisionState.DEGRADED and not self.fallback_used:
            raise DecisionRecordError("state=degraded requires fallback_used=true")
        if self.source is DecisionSource.DEGRADED and self.state is not DecisionState.DEGRADED:
            raise DecisionRecordError("source=degraded is only valid on degraded decisions")
        if self.response_timeout_ms is not None and (
            isinstance(self.response_timeout_ms, bool)
            or not isinstance(self.response_timeout_ms, int)
            or self.response_timeout_ms <= 0
        ):
            raise DecisionRecordError("response_timeout_ms must be a positive integer")
        if self.alarm is not None and self.state not in (
            DecisionState.FAMILY_NOTIFICATION_REQUIRED,
            DecisionState.URGENT_ATTENTION,
        ):
            raise DecisionRecordError("alarm is only valid on family-alert or urgent decisions")
        _require_optional_text(self.voice_asset, "voice_asset")
        if self.voice_asset is not None and self.elder_message is None:
            raise DecisionRecordError("voice_asset requires a spoken elder_message")
        if self.confirm_channels is not None:
            if not isinstance(self.confirm_channels, tuple) or not self.confirm_channels:
                raise DecisionRecordError("confirm_channels must be a non-empty tuple")
            unknown = [
                channel for channel in self.confirm_channels if channel not in CONFIRM_CHANNELS
            ]
            if unknown:
                raise DecisionRecordError(
                    f"confirm_channels must be within {list(CONFIRM_CHANNELS)}, got {unknown}"
                )
            if len(set(self.confirm_channels)) != len(self.confirm_channels):
                raise DecisionRecordError("confirm_channels must not repeat")
            if self.action is not DecisionAction.ASK_ELDER:
                raise DecisionRecordError("confirm_channels is only valid on ask_elder decisions")

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "scene_id": self.scene_id,
            "decision_id": self.decision_id,
            "timestamp_ms": self.timestamp_ms,
            "state": self.state.value,
            "risk_level": self.risk_level,
            "privacy_mode": self.privacy_mode.value,
            "need_dialogue": self.need_dialogue,
            "dialogue_goal": self.dialogue_goal,
            "elder_message": self.elder_message,
            "family_notification": self.family_notification,
            "action": self.action.value,
            "reason_summary": self.reason_summary,
            "uncertainty": self.uncertainty.value,
            "fallback_used": self.fallback_used,
            "source": self.source.value,
            "demo_mode": self.demo_mode.value,
            "consent_required": self.consent_required,
            "response_timeout_ms": self.response_timeout_ms,
            "action_card": None if self.action_card is None else self.action_card.to_payload(),
            "visual_context": (
                None if self.visual_context is None else self.visual_context.to_payload()
            ),
            "alarm": None if self.alarm is None else self.alarm.to_payload(),
            "voice_asset": self.voice_asset,
            "confirm_channels": (
                None if self.confirm_channels is None else list(self.confirm_channels)
            ),
        }


@dataclass(frozen=True, slots=True)
class InteractionResponse:
    """One elder/family response submitted by C (contract section 11)."""

    scene_id: str
    decision_id: str
    timestamp_ms: float
    response: ResponseValue
    source: ResponseSource
    demo_mode: DemoMode
    text: str | None = None
    schema_version: str = RESPONSE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != RESPONSE_SCHEMA_VERSION:
            raise DecisionRecordError(
                f"schema_version must be {RESPONSE_SCHEMA_VERSION!r}, got {self.schema_version!r}"
            )
        _require_non_empty(self.scene_id, "scene_id")
        _require_non_empty(self.decision_id, "decision_id")
        _require_timestamp(self.timestamp_ms, "timestamp_ms")
        _require_optional_text(self.text, "text")
        if self.text is not None and self.source not in _TEXT_BEARING_RESPONSE_SOURCES:
            raise DecisionRecordError("text is only allowed when source is user_input or script")
        # Full response x source cross-whitelist: a timeout can only say "none",
        # the family view can only confirm cards, and elder answers (including
        # consent) must come from the elder's own input or an explicit script.
        if self.response is ResponseValue.NONE and self.source not in _NONE_RESPONSE_SOURCES:
            raise DecisionRecordError("response=none is only valid from timeout or script sources")
        if self.source is ResponseSource.TIMEOUT and self.response is not ResponseValue.NONE:
            raise DecisionRecordError("source=timeout can only carry response=none")
        if (
            self.response is ResponseValue.CARD_CONFIRMED
            and self.source is not ResponseSource.FAMILY_INPUT
        ):
            raise DecisionRecordError("response=card_confirmed must come from family_input")
        if (
            self.source is ResponseSource.FAMILY_INPUT
            and self.response is not ResponseValue.CARD_CONFIRMED
        ):
            raise DecisionRecordError("source=family_input can only confirm the action card")
        if (
            self.response not in (ResponseValue.NONE, ResponseValue.CARD_CONFIRMED)
            and self.source not in _ELDER_RESPONSE_SOURCES
        ):
            raise DecisionRecordError("elder responses must come from user_input or script sources")

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "scene_id": self.scene_id,
            "decision_id": self.decision_id,
            "timestamp_ms": self.timestamp_ms,
            "response": self.response.value,
            "source": self.source.value,
            "demo_mode": self.demo_mode.value,
            "text": self.text,
        }


def _require_payload_mapping(data: object, label: str) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise DecisionRecordError(f"{label} must be a JSON object")
    return data


def _reject_unknown_fields(data: dict[str, Any], allowed: set[str], label: str) -> None:
    unknown = sorted(set(data) - allowed)
    if unknown:
        raise DecisionRecordError(f"{label} has unexpected fields: {', '.join(unknown)}")


def _enum_value(
    data: dict[str, Any], key: str, enum_cls: type[Any], *, optional: bool = False
) -> Any:
    value = data.get(key)
    if value is None and optional:
        return None
    try:
        return enum_cls(value)
    except ValueError as exc:
        raise DecisionRecordError(f"{key} must be one of {[e.value for e in enum_cls]}") from exc


def _bool_value(data: dict[str, Any], key: str) -> bool:
    value = data.get(key)
    if not isinstance(value, bool):
        raise DecisionRecordError(f"{key} must be a boolean")
    return value


_DECISION_FIELDS = {
    "schema_version",
    "scene_id",
    "decision_id",
    "timestamp_ms",
    "state",
    "risk_level",
    "privacy_mode",
    "need_dialogue",
    "dialogue_goal",
    "elder_message",
    "family_notification",
    "action",
    "reason_summary",
    "uncertainty",
    "fallback_used",
    "source",
    "demo_mode",
    "consent_required",
    "response_timeout_ms",
    "action_card",
    "visual_context",
    "alarm",
    "voice_asset",
    "confirm_channels",
}

_RESPONSE_FIELDS = {
    "schema_version",
    "scene_id",
    "decision_id",
    "timestamp_ms",
    "response",
    "source",
    "demo_mode",
    "text",
}


def parse_action_card(data: object) -> ActionCard:
    """Parse one action card payload, rejecting incomplete cards."""

    payload = _require_payload_mapping(data, "action_card")
    allowed = {
        "event",
        "elder_quote",
        "system_judgment",
        "suggested_action",
        "time_window",
        "status",
    }
    _reject_unknown_fields(payload, allowed, "action_card")
    return ActionCard(
        event=payload.get("event", ""),
        elder_quote=payload.get("elder_quote", ""),
        system_judgment=payload.get("system_judgment", ""),
        suggested_action=payload.get("suggested_action", ""),
        time_window=payload.get("time_window", ""),
        status=_enum_value(payload, "status", CardStatus),
    )


def _parse_alarm(data: object) -> AlarmSignal:
    payload = _require_payload_mapping(data, "alarm")
    _reject_unknown_fields(payload, {"channels", "trigger"}, "alarm")
    channels = payload.get("channels")
    if not isinstance(channels, list) or not all(isinstance(item, str) for item in channels):
        raise DecisionRecordError("alarm.channels must be a list of strings")
    return AlarmSignal(
        channels=tuple(channels),
        trigger=_enum_value(payload, "trigger", AlarmTrigger),
    )


def _parse_confirm_channels(data: object) -> tuple[str, ...]:
    if not isinstance(data, list) or not all(isinstance(item, str) for item in data):
        raise DecisionRecordError("confirm_channels must be a list of strings")
    return tuple(data)


def _parse_visual_context(data: object) -> VisualContext:
    payload = _require_payload_mapping(data, "visual_context")
    allowed = {"sent_to_mimo", "type", "start_ms", "end_ms", "sample_count"}
    _reject_unknown_fields(payload, allowed, "visual_context")
    return VisualContext(
        sent_to_mimo=_bool_value(payload, "sent_to_mimo"),
        type=_enum_value(payload, "type", VisualContextType, optional=True),
        start_ms=payload.get("start_ms"),
        end_ms=payload.get("end_ms"),
        sample_count=payload.get("sample_count"),
    )


def parse_care_decision(data: object) -> CareDecision:
    """Parse one CareDecision payload; contract violations raise DecisionRecordError."""

    payload = _require_payload_mapping(data, "care decision")
    _reject_unknown_fields(payload, _DECISION_FIELDS, "care decision")
    card = payload.get("action_card")
    visual = payload.get("visual_context")
    alarm = payload.get("alarm")
    confirm_channels = payload.get("confirm_channels")
    risk_level = payload.get("risk_level")
    if isinstance(risk_level, bool) or not isinstance(risk_level, int):
        raise DecisionRecordError("risk_level must be an integer")
    return CareDecision(
        schema_version=payload.get("schema_version", ""),
        scene_id=payload.get("scene_id", ""),
        decision_id=payload.get("decision_id", ""),
        timestamp_ms=payload.get("timestamp_ms", -1),
        state=_enum_value(payload, "state", DecisionState),
        risk_level=risk_level,
        privacy_mode=_enum_value(payload, "privacy_mode", PrivacyMode),
        need_dialogue=_bool_value(payload, "need_dialogue"),
        dialogue_goal=payload.get("dialogue_goal"),
        elder_message=payload.get("elder_message"),
        family_notification=payload.get("family_notification"),
        action=_enum_value(payload, "action", DecisionAction),
        reason_summary=payload.get("reason_summary", ""),
        uncertainty=_enum_value(payload, "uncertainty", Uncertainty),
        fallback_used=_bool_value(payload, "fallback_used"),
        source=_enum_value(payload, "source", DecisionSource),
        demo_mode=_enum_value(payload, "demo_mode", DemoMode),
        consent_required=_bool_value(payload, "consent_required"),
        response_timeout_ms=payload.get("response_timeout_ms"),
        action_card=None if card is None else parse_action_card(card),
        visual_context=None if visual is None else _parse_visual_context(visual),
        alarm=None if alarm is None else _parse_alarm(alarm),
        voice_asset=payload.get("voice_asset"),
        confirm_channels=(
            None if confirm_channels is None else _parse_confirm_channels(confirm_channels)
        ),
    )


def parse_interaction_response(data: object) -> InteractionResponse:
    """Parse one InteractionResponse payload submitted by C.

    ``demo_mode`` and ``text`` are superset fields kept from the earlier
    contract revision; the current interface version omits them, so both are
    optional on the wire (missing ``demo_mode`` defaults to live).
    """

    payload = _require_payload_mapping(data, "interaction response")
    _reject_unknown_fields(payload, _RESPONSE_FIELDS, "interaction response")
    if payload.get("demo_mode") is None:
        payload = {**payload, "demo_mode": DemoMode.LIVE.value}
    return InteractionResponse(
        schema_version=payload.get("schema_version", ""),
        scene_id=payload.get("scene_id", ""),
        decision_id=payload.get("decision_id", ""),
        timestamp_ms=payload.get("timestamp_ms", -1),
        response=_enum_value(payload, "response", ResponseValue),
        source=_enum_value(payload, "source", ResponseSource),
        demo_mode=_enum_value(payload, "demo_mode", DemoMode),
        text=payload.get("text"),
    )


def as_recorded(decision: CareDecision) -> CareDecision:
    """Rewrite provenance for replaying a captured decision (contract section 10.5)."""

    return replace(decision, source=DecisionSource.RECORD, demo_mode=DemoMode.RECORD)


def append_recorded_decision(path: str | Path, decision: CareDecision) -> None:
    """Append one decision to a bundle's recorded_decisions.jsonl."""

    line = json.dumps(decision.to_payload(), ensure_ascii=False, separators=(",", ":"))
    with Path(path).open("a", encoding="utf-8") as stream:
        stream.write(line + "\n")


def load_recorded_decisions(
    path: str | Path, *, expected_scene_id: str
) -> tuple[CareDecision, ...]:
    """Load a recorded_decisions.jsonl stream and reject cross-scene contamination."""

    decisions: list[CareDecision] = []
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise DecisionRecordError(f"cannot read recorded decisions: {exc}") from exc
    for line_number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            raise DecisionRecordError(f"line {line_number} is not valid JSON: {exc}") from exc
        decision = parse_care_decision(payload)
        if decision.scene_id != expected_scene_id:
            raise DecisionRecordError(
                f"line {line_number} belongs to scene {decision.scene_id!r}, "
                f"expected {expected_scene_id!r}"
            )
        decisions.append(decision)
    return tuple(decisions)
