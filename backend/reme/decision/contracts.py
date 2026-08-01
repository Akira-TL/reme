"""Care-decision contract types mirroring `.scratch/abc-interface/spec.md` §10-§11.

Field names, enums, and validation rules follow the shared A/B/C interface
contract (`reme-care-decision/v0-experiment` and
`reme-interaction-response/v0-experiment`). Contract constraints that span
multiple turns (consent gating, rule escalation immutability) live in the
decision engine; this module enforces single-payload shape only.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

CARE_DECISION_SCHEMA_VERSION = "reme-care-decision/v0-experiment"
INTERACTION_RESPONSE_SCHEMA_VERSION = "reme-interaction-response/v0-experiment"

DECISION_STATES = (
    "normal",
    "observe",
    "check_in_required",
    "consent_required",
    "family_notification_required",
    "urgent_attention",
    "resolved",
    "degraded",
)
PRIVACY_MODES = ("visible", "blurred", "skeleton_only", "hidden")
ACTIONS = (
    "none",
    "observe",
    "ask_elder",
    "notify_family",
    "show_urgent_attention",
    "mark_resolved",
)
DECISION_SOURCES = ("rule", "mimo", "mock", "record", "degraded")
DEMO_MODES = ("live", "mock", "record")
UNCERTAINTY_LEVELS = ("low", "medium", "high", "unknown")
ACTION_CARD_STATUSES = ("pending", "confirmed", "done")
RESPONSES = (
    "safe",
    "need_help",
    "unclear",
    "none",
    "consent_granted",
    "consent_denied",
    "card_confirmed",
)
RESPONSE_SOURCES = ("user_input", "family_input", "script", "timeout")
VISUAL_CONTEXT_TYPES = ("keyframes", "clip")

_ACTION_CARD_FIELDS = (
    "event",
    "elder_quote",
    "system_judgment",
    "suggested_action",
    "time_window",
    "status",
)


class ContractError(ValueError):
    """Raised when a payload violates the shared interface contract."""


@dataclass(frozen=True)
class ActionCard:
    """Six-element family action card; every field is mandatory when present."""

    event: str
    elder_quote: str
    system_judgment: str
    suggested_action: str
    time_window: str
    status: str = "pending"

    def validate(self) -> None:
        for name in _ACTION_CARD_FIELDS:
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ContractError(f"action_card.{name} must be a non-empty string")
        if self.status not in ACTION_CARD_STATUSES:
            raise ContractError(f"action_card.status must be one of {ACTION_CARD_STATUSES}")

    def to_dict(self) -> dict[str, str]:
        return {name: getattr(self, name) for name in _ACTION_CARD_FIELDS}

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> ActionCard:
        missing = [name for name in _ACTION_CARD_FIELDS if name not in raw]
        if missing:
            raise ContractError(f"action_card missing fields: {missing}")
        card = cls(**{name: raw[name] for name in _ACTION_CARD_FIELDS})
        card.validate()
        return card


@dataclass(frozen=True)
class VisualContext:
    """Record of what visual material actually went to MiMo for this decision."""

    sent_to_mimo: bool
    type: str | None = None
    start_ms: float | None = None
    end_ms: float | None = None
    sample_count: int | None = None

    def validate(self) -> None:
        if self.sent_to_mimo:
            if self.type not in VISUAL_CONTEXT_TYPES:
                raise ContractError(
                    f"visual_context.type must be one of {VISUAL_CONTEXT_TYPES} when sent"
                )
            if self.start_ms is None or self.end_ms is None:
                raise ContractError("visual_context window required when sent_to_mimo")
            if self.end_ms < self.start_ms:
                raise ContractError("visual_context.end_ms must be >= start_ms")

    def to_dict(self) -> dict[str, Any]:
        return {
            "sent_to_mimo": self.sent_to_mimo,
            "type": self.type,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "sample_count": self.sample_count,
        }


@dataclass(frozen=True)
class CareDecision:
    """One B→C decision payload (`reme-care-decision/v0-experiment`)."""

    scene_id: str
    decision_id: str
    timestamp_ms: float
    state: str
    risk_level: int
    privacy_mode: str
    need_dialogue: bool
    action: str
    reason_summary: str
    uncertainty: str
    fallback_used: bool
    source: str
    demo_mode: str
    dialogue_goal: str | None = None
    elder_message: str | None = None
    family_notification: str | None = None
    consent_required: bool = False
    response_timeout_ms: float | None = None
    action_card: ActionCard | None = None
    visual_context: VisualContext | None = None
    schema_version: str = CARE_DECISION_SCHEMA_VERSION

    def validate(self) -> None:
        if self.schema_version != CARE_DECISION_SCHEMA_VERSION:
            raise ContractError(f"unexpected schema_version {self.schema_version!r}")
        if not self.scene_id or not self.decision_id:
            raise ContractError("scene_id and decision_id are required")
        if self.state not in DECISION_STATES:
            raise ContractError(f"state must be one of {DECISION_STATES}")
        if self.privacy_mode not in PRIVACY_MODES:
            raise ContractError(f"privacy_mode must be one of {PRIVACY_MODES}")
        if self.action not in ACTIONS:
            raise ContractError(f"action must be one of {ACTIONS}")
        if self.source not in DECISION_SOURCES:
            raise ContractError(f"source must be one of {DECISION_SOURCES}")
        if self.demo_mode not in DEMO_MODES:
            raise ContractError(f"demo_mode must be one of {DEMO_MODES}")
        if self.uncertainty not in UNCERTAINTY_LEVELS:
            raise ContractError(f"uncertainty must be one of {UNCERTAINTY_LEVELS}")
        if not 0 <= self.risk_level <= 4:
            raise ContractError("risk_level must be within 0..4")
        if not self.need_dialogue and self.elder_message is not None:
            raise ContractError("elder_message must be null when need_dialogue is false")
        if self.action == "notify_family" and not self.family_notification:
            raise ContractError("family_notification required when action=notify_family")
        if self.action_card is not None:
            self.action_card.validate()
        if self.visual_context is not None:
            self.visual_context.validate()

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "scene_id": self.scene_id,
            "decision_id": self.decision_id,
            "timestamp_ms": self.timestamp_ms,
            "state": self.state,
            "risk_level": self.risk_level,
            "privacy_mode": self.privacy_mode,
            "need_dialogue": self.need_dialogue,
            "dialogue_goal": self.dialogue_goal,
            "elder_message": self.elder_message,
            "family_notification": self.family_notification,
            "consent_required": self.consent_required,
            "response_timeout_ms": self.response_timeout_ms,
            "action_card": self.action_card.to_dict() if self.action_card else None,
            "action": self.action,
            "reason_summary": self.reason_summary,
            "uncertainty": self.uncertainty,
            "fallback_used": self.fallback_used,
            "source": self.source,
            "demo_mode": self.demo_mode,
            "visual_context": self.visual_context.to_dict() if self.visual_context else None,
        }


@dataclass(frozen=True)
class InteractionResponse:
    """One C→B elder/family response (`reme-interaction-response/v0-experiment`)."""

    scene_id: str
    decision_id: str
    timestamp_ms: float
    response: str
    source: str
    demo_mode: str
    text: str | None = None
    schema_version: str = INTERACTION_RESPONSE_SCHEMA_VERSION

    def validate(self) -> None:
        if self.schema_version != INTERACTION_RESPONSE_SCHEMA_VERSION:
            raise ContractError(f"unexpected schema_version {self.schema_version!r}")
        if not self.scene_id or not self.decision_id:
            raise ContractError("scene_id and decision_id are required")
        if self.response not in RESPONSES:
            raise ContractError(f"response must be one of {RESPONSES}")
        if self.source not in RESPONSE_SOURCES:
            raise ContractError(f"source must be one of {RESPONSE_SOURCES}")
        if self.demo_mode not in DEMO_MODES:
            raise ContractError(f"demo_mode must be one of {DEMO_MODES}")
        if self.text is not None and self.source not in ("user_input", "script"):
            raise ContractError("text is only allowed for user_input or script sources")
        if self.source == "timeout" and self.response != "none":
            raise ContractError("timeout source must carry response=none")
        if self.response == "card_confirmed" and self.source != "family_input":
            raise ContractError("card_confirmed must come from family_input")

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> InteractionResponse:
        required = ("scene_id", "decision_id", "timestamp_ms", "response", "source", "demo_mode")
        missing = [name for name in required if name not in raw]
        if missing:
            raise ContractError(f"interaction response missing fields: {missing}")
        response = cls(
            scene_id=raw["scene_id"],
            decision_id=raw["decision_id"],
            timestamp_ms=float(raw["timestamp_ms"]),
            response=raw["response"],
            source=raw["source"],
            demo_mode=raw["demo_mode"],
            text=raw.get("text"),
            schema_version=raw.get("schema_version", INTERACTION_RESPONSE_SCHEMA_VERSION),
        )
        response.validate()
        return response


# Fields MiMo itself must return inside its JSON answer. Engine-owned fields
# (scene_id, decision_id, source, demo_mode, visual_context, timestamps) are
# stamped after parsing and are deliberately absent here.
MIMO_PAYLOAD_REQUIRED_FIELDS = (
    "state",
    "risk_level",
    "privacy_mode",
    "need_dialogue",
    "dialogue_goal",
    "elder_message",
    "family_notification",
    "action",
    "reason_summary",
)


@dataclass(frozen=True)
class MiMoPayload:
    """Validated decision fields extracted from one MiMo JSON answer."""

    state: str
    risk_level: int
    privacy_mode: str
    need_dialogue: bool
    action: str
    reason_summary: str
    dialogue_goal: str | None = None
    elder_message: str | None = None
    family_notification: str | None = None
    consent_required: bool = False
    action_card: ActionCard | None = None
    uncertainty: str = "medium"
    raw: dict[str, Any] = field(default_factory=dict)


def parse_mimo_payload(raw: dict[str, Any]) -> MiMoPayload:
    """Validate a parsed MiMo JSON object against the decision contract subset."""

    missing = [name for name in MIMO_PAYLOAD_REQUIRED_FIELDS if name not in raw]
    if missing:
        raise ContractError(f"MiMo payload missing fields: {missing}")
    state = raw["state"]
    if state not in DECISION_STATES:
        raise ContractError(f"MiMo state {state!r} not in {DECISION_STATES}")
    if raw["privacy_mode"] not in PRIVACY_MODES:
        raise ContractError(f"MiMo privacy_mode {raw['privacy_mode']!r} invalid")
    if raw["action"] not in ACTIONS:
        raise ContractError(f"MiMo action {raw['action']!r} invalid")
    try:
        risk_level = int(raw["risk_level"])
    except (TypeError, ValueError) as exc:
        raise ContractError("MiMo risk_level must be an integer") from exc
    if not 0 <= risk_level <= 4:
        raise ContractError("MiMo risk_level must be within 0..4")
    if not isinstance(raw["need_dialogue"], bool):
        raise ContractError("MiMo need_dialogue must be a boolean")
    uncertainty = raw.get("uncertainty", "medium")
    if uncertainty not in UNCERTAINTY_LEVELS:
        raise ContractError(f"MiMo uncertainty {uncertainty!r} invalid")
    card_raw = raw.get("action_card")
    action_card = ActionCard.from_dict(card_raw) if isinstance(card_raw, dict) else None
    return MiMoPayload(
        state=state,
        risk_level=risk_level,
        privacy_mode=raw["privacy_mode"],
        need_dialogue=raw["need_dialogue"],
        action=raw["action"],
        reason_summary=str(raw["reason_summary"]),
        dialogue_goal=raw.get("dialogue_goal"),
        elder_message=raw.get("elder_message"),
        family_notification=raw.get("family_notification"),
        consent_required=bool(raw.get("consent_required", False)),
        action_card=action_card,
        uncertainty=uncertainty,
        raw=raw,
    )
