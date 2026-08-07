"""Care-event orchestration over derived motion observations."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any

from experiments.legacy_motion_demo.contracts import EventCandidate
from experiments.legacy_motion_demo.motion import (
    DEFAULT_FALL_HEURISTIC,
    FallHeuristic,
    MotionObservation,
    detect_fall_like_event,
    has_insufficient_motion_data,
)


class CheckInResponse(StrEnum):
    """Observed result of the local safety check-in."""

    UNKNOWN = "unknown"
    SAFE = "safe"
    NO_RESPONSE = "no_response"


class DecisionAction(StrEnum):
    """Actions available to the deterministic MVP safety policy."""

    LOCAL_CHECK_IN = "local_check_in"
    FAMILY_NOTIFICATION = "family_notification"
    MANUAL_REVIEW = "manual_review"


@dataclass(frozen=True, slots=True)
class CareDecision:
    """One explainable response chosen by the deterministic safety policy."""

    action: DecisionAction
    reason: str

    def to_payload(self) -> dict[str, str]:
        return {"action": self.action.value, "reason": self.reason}


@dataclass(frozen=True, slots=True)
class CareRunResult:
    """Event and response timeline produced by one motion sequence."""

    status: str
    events: tuple[EventCandidate, ...]
    decisions: tuple[CareDecision, ...]
    observation_count: int
    audit: dict[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "observation_count": self.observation_count,
            "events": [event.to_payload() for event in self.events],
            "decisions": [decision.to_payload() for decision in self.decisions],
            "audit": dict(self.audit),
        }


def run_care_sequence(
    observations: Sequence[MotionObservation],
    *,
    started_at: datetime,
    check_in_response: CheckInResponse = CheckInResponse.UNKNOWN,
    heuristic: FallHeuristic = DEFAULT_FALL_HEURISTIC,
    adapter_name: str = "derived_motion_data",
) -> CareRunResult:
    """Run the MVP event and staged-response policy over derived motion data."""

    audit: dict[str, Any] = {
        "input_kind": "motion_data",
        "adapter": adapter_name,
        "raw_media_in_core_pipeline": False,
        "raw_media_persisted": False,
        "network_access": False,
        "heuristic_is_clinically_validated": False,
    }

    if has_insufficient_motion_data(
        observations,
        minimum_visibility=heuristic.minimum_visibility,
    ):
        return CareRunResult(
            status="insufficient_motion_data",
            events=(),
            decisions=(
                CareDecision(
                    action=DecisionAction.MANUAL_REVIEW,
                    reason="Too few sufficiently visible motion observations to assess safely.",
                ),
            ),
            observation_count=len(observations),
            audit=audit,
        )

    event = detect_fall_like_event(
        observations,
        started_at=started_at,
        heuristic=heuristic,
    )
    if event is None:
        return CareRunResult(
            status="normal",
            events=(),
            decisions=(),
            observation_count=len(observations),
            audit=audit,
        )

    check_in = CareDecision(
        action=DecisionAction.LOCAL_CHECK_IN,
        reason="A fall-like motion transition needs a local safety confirmation.",
    )
    if check_in_response is CheckInResponse.NO_RESPONSE:
        return CareRunResult(
            status="family_notified",
            events=(event,),
            decisions=(
                check_in,
                CareDecision(
                    action=DecisionAction.FAMILY_NOTIFICATION,
                    reason="No response was received after the local safety check-in.",
                ),
            ),
            observation_count=len(observations),
            audit=audit,
        )
    if check_in_response is CheckInResponse.SAFE:
        return CareRunResult(
            status="resolved_safe",
            events=(event,),
            decisions=(check_in,),
            observation_count=len(observations),
            audit=audit,
        )

    return CareRunResult(
        status="awaiting_check_in_response",
        events=(event,),
        decisions=(check_in,),
        observation_count=len(observations),
        audit=audit,
    )
