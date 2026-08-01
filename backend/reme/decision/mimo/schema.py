"""Parse and validate MiMo's raw output into a bounded MimoProposal.

The proposal type deliberately has no ``action``, no ``decision_id``, no
``response_timeout_ms`` and no ``source``: the model cannot express a
cancellation or an escalation rollback at the type level. Each task also
restricts which ``state`` values the model may even suggest.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import StrEnum
from typing import TypeVar

from reme.decision.records import (
    ActionCard,
    CardStatus,
    DecisionRecordError,
    DecisionState,
    PrivacyMode,
    Uncertainty,
    parse_action_card,
)
from reme.decision.state_machine import MimoTask


class MimoSchemaError(ValueError):
    """Raised when MiMo output cannot be turned into a safe proposal."""


TASK_STATE_ALLOWLIST: dict[MimoTask, frozenset[DecisionState]] = {
    MimoTask.COMPOSE_CHECK_IN: frozenset({DecisionState.CHECK_IN_REQUIRED}),
    MimoTask.INTERPRET_RESPONSE: frozenset(
        {
            DecisionState.CHECK_IN_REQUIRED,
            DecisionState.CONSENT_REQUIRED,
            DecisionState.FAMILY_NOTIFICATION_REQUIRED,
        }
    ),
    MimoTask.COMPOSE_CARD: frozenset({DecisionState.FAMILY_NOTIFICATION_REQUIRED}),
}

_PROPOSAL_FIELDS = {
    "state",
    "risk_level",
    "need_dialogue",
    "dialogue_goal",
    "elder_message",
    "family_notification",
    "consent_required",
    "reason_summary",
    "uncertainty",
    "privacy_mode",
    "action_card",
}


@dataclass(frozen=True, slots=True)
class MimoProposal:
    """Wording and soft judgments MiMo may contribute to one decision."""

    reason_summary: str
    uncertainty: Uncertainty
    state: DecisionState | None = None
    risk_level: int | None = None
    need_dialogue: bool | None = None
    dialogue_goal: str | None = None
    elder_message: str | None = None
    family_notification: str | None = None
    consent_required: bool | None = None
    privacy_mode: PrivacyMode | None = None
    action_card: ActionCard | None = None


def extract_json_object(raw_text: str) -> str:
    """Strip one markdown fence / surrounding chatter and return the JSON body."""

    text = raw_text.strip()
    if text.startswith("```"):
        first_newline = text.find("\n")
        closing = text.rfind("```")
        if first_newline != -1 and closing > first_newline:
            text = text[first_newline + 1 : closing].strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        raise MimoSchemaError("no JSON object found in MiMo output")
    return text[start : end + 1]


def _optional_text(payload: dict[str, object], key: str) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise MimoSchemaError(f"{key} must be a non-empty string or null")
    return value


def _optional_bool(payload: dict[str, object], key: str) -> bool | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, bool):
        raise MimoSchemaError(f"{key} must be a boolean or null")
    return value


_EnumT = TypeVar("_EnumT", bound=StrEnum)


def _optional_enum(
    payload: dict[str, object], key: str, enum_cls: type[_EnumT]
) -> _EnumT | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise MimoSchemaError(f"{key} has an illegal value {value!r}")
    try:
        return enum_cls(value)
    except ValueError as exc:
        raise MimoSchemaError(f"{key} has an illegal value {value!r}") from exc


def parse_mimo_proposal(raw_text: str, *, task: MimoTask) -> MimoProposal:
    """Validate MiMo's raw completion against the per-task allowlist."""

    body = extract_json_object(raw_text)
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise MimoSchemaError(f"MiMo output is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise MimoSchemaError("MiMo output must be a JSON object")
    unknown = sorted(set(payload) - _PROPOSAL_FIELDS)
    if unknown:
        raise MimoSchemaError(f"MiMo output has unexpected fields: {', '.join(unknown)}")

    reason_summary = _optional_text(payload, "reason_summary")
    if reason_summary is None:
        raise MimoSchemaError("reason_summary is required")
    uncertainty = _optional_enum(payload, "uncertainty", Uncertainty)
    if uncertainty is None:
        raise MimoSchemaError("uncertainty is required")

    state = _optional_enum(payload, "state", DecisionState)
    if state is not None and state not in TASK_STATE_ALLOWLIST[task]:
        raise MimoSchemaError(f"state {state.value!r} is outside the {task.value} allowlist")

    risk_level = payload.get("risk_level")
    if risk_level is not None and (
        isinstance(risk_level, bool) or not isinstance(risk_level, int) or not 0 <= risk_level <= 4
    ):
        raise MimoSchemaError("risk_level must be an integer within 0..4 or null")

    card_payload = payload.get("action_card")
    action_card: ActionCard | None = None
    if card_payload is not None:
        try:
            action_card = parse_action_card(card_payload)
        except DecisionRecordError as exc:
            raise MimoSchemaError(f"action_card is invalid: {exc}") from exc
        if action_card.status is not CardStatus.PENDING:
            raise MimoSchemaError("action_card.status must be 'pending' in a proposal")

    elder_message = _optional_text(payload, "elder_message")
    family_notification = _optional_text(payload, "family_notification")
    if task is MimoTask.COMPOSE_CHECK_IN and elder_message is None:
        raise MimoSchemaError("compose_check_in requires elder_message")
    if task is MimoTask.COMPOSE_CARD:
        if action_card is None:
            raise MimoSchemaError("compose_card requires a complete action_card")
        if family_notification is None:
            raise MimoSchemaError("compose_card requires family_notification")

    return MimoProposal(
        reason_summary=reason_summary,
        uncertainty=uncertainty,
        state=state,
        risk_level=risk_level,
        need_dialogue=_optional_bool(payload, "need_dialogue"),
        dialogue_goal=_optional_text(payload, "dialogue_goal"),
        elder_message=elder_message,
        family_notification=family_notification,
        consent_required=_optional_bool(payload, "consent_required"),
        privacy_mode=_optional_enum(payload, "privacy_mode", PrivacyMode),
        action_card=action_card,
    )
