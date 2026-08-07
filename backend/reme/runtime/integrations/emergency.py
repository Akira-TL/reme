"""Minimal outbound emergency contract derived from final care decisions."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from reme.runtime.decision.records import CareDecision, DecisionState

EMERGENCY_SCHEMA_VERSION = "reme-emergency-event/v1"


class EmergencyType(StrEnum):
    """Coarse external intervention categories; never perception labels."""

    FAMILY_INTERVENTION_REQUIRED = "family_intervention_required"
    URGENT_ATTENTION = "urgent_attention"


class EmergencySeverity(StrEnum):
    """Coarse external severity independent from internal risk/model values."""

    HIGH = "high"
    CRITICAL = "critical"


@dataclass(frozen=True, slots=True)
class EmergencyEvent:
    """The complete and intentionally tiny Reme -> external executor payload."""

    schema_version: str
    event_id: str
    type: EmergencyType
    severity: EmergencySeverity
    summary: str
    occurred_at: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "event_id": self.event_id,
            "type": self.type.value,
            "severity": self.severity.value,
            "summary": self.summary,
            "occurred_at": self.occurred_at,
        }


_OUTBOUND_STATES: dict[
    DecisionState, tuple[EmergencyType, EmergencySeverity, str]
] = {
    DecisionState.FAMILY_NOTIFICATION_REQUIRED: (
        EmergencyType.FAMILY_INTERVENTION_REQUIRED,
        EmergencySeverity.HIGH,
        "Reme 检测到需要家属介入的紧急事件，请尽快处理。",
    ),
    DecisionState.URGENT_ATTENTION: (
        EmergencyType.URGENT_ATTENTION,
        EmergencySeverity.CRITICAL,
        "Reme 检测到需要立即外部介入的紧急事件，请立即处理。",
    ),
}


def emergency_event_from_decision(
    decision: CareDecision, *, occurred_at: datetime
) -> EmergencyEvent | None:
    """Project an allowlisted final decision without serializing CareDecision itself."""

    outbound = _OUTBOUND_STATES.get(decision.state)
    if outbound is None:
        return None
    if occurred_at.tzinfo is None or occurred_at.utcoffset() is None:
        raise ValueError("occurred_at must be timezone-aware")
    event_type, severity, summary = outbound
    occurred_at_utc = occurred_at.astimezone(UTC).isoformat().replace("+00:00", "Z")
    return EmergencyEvent(
        schema_version=EMERGENCY_SCHEMA_VERSION,
        event_id=_external_event_id(decision),
        type=event_type,
        severity=severity,
        summary=summary,
        occurred_at=occurred_at_utc,
    )


def _external_event_id(decision: CareDecision) -> str:
    """Derive a stable opaque id without exposing the internal scene identifier."""

    identity = "\x1f".join(
        (decision.scene_id, decision.decision_id, str(decision.timestamp_ms))
    ).encode("utf-8")
    digest = hashlib.sha256(identity).hexdigest()[:32]
    return f"reme-{digest}"
