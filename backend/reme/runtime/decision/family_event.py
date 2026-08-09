"""Minimal family-facing event projection from authoritative CareDecision data."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from reme.runtime.decision.records import CareDecision

FAMILY_EVENT_SCHEMA_VERSION = "reme-family-event/v1"


@dataclass(frozen=True, slots=True)
class FamilyEvent:
    runtime_session_id: str
    revision: int
    decision_timestamp_ms: float
    published_at_ms: int
    care: dict[str, Any]
    schema_version: str = FAMILY_EVENT_SCHEMA_VERSION

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "runtime_session_id": self.runtime_session_id,
            "revision": self.revision,
            "decision_timestamp_ms": self.decision_timestamp_ms,
            "published_at_ms": self.published_at_ms,
            "care": self.care,
        }


def family_event_from_decision(
    decision: CareDecision,
    *,
    runtime_session_id: str,
    revision: int,
    published_at_ms: int,
    include_elder_quote: bool = False,
) -> FamilyEvent:
    """Project only the facts a family surface needs; no perception/debug payloads."""

    action_card: dict[str, Any] | None = None
    if decision.action_card is not None:
        action_card = {
            "event": decision.action_card.event,
            "system_judgment": decision.action_card.system_judgment,
            "suggested_action": decision.action_card.suggested_action,
            "time_window": decision.action_card.time_window,
            "status": decision.action_card.status.value,
        }
        if include_elder_quote:
            action_card["elder_quote"] = decision.action_card.elder_quote

    return FamilyEvent(
        runtime_session_id=runtime_session_id,
        revision=revision,
        decision_timestamp_ms=decision.timestamp_ms,
        published_at_ms=published_at_ms,
        care={
            "decision_id": decision.decision_id,
            "state": decision.state.value,
            "action": decision.action.value,
            "risk_level": decision.risk_level,
            "family_notification": decision.family_notification,
            "privacy_mode": decision.privacy_mode.value,
            "alarm": None if decision.alarm is None else decision.alarm.to_payload(),
            "action_card": action_card,
            "media_authorization": (
                None
                if decision.media_authorization is None
                else decision.media_authorization.to_payload()
            ),
        },
    )
