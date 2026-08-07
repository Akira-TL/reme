"""Privacy and delivery contract tests for outbound emergency integrations."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from reme.runtime.decision.records import (
    CareDecision,
    DecisionAction,
    DecisionSource,
    DecisionState,
    DemoMode,
    PrivacyMode,
    Uncertainty,
)
from reme.runtime.integrations.emergency import (
    EmergencyEvent,
    EmergencySeverity,
    EmergencyType,
    emergency_event_from_decision,
)


def _decision(**overrides: Any) -> CareDecision:
    fields: dict[str, Any] = {
        "scene_id": "fall_demo_01",
        "decision_id": "decision-0042",
        "timestamp_ms": 12800.0,
        "state": DecisionState.CHECK_IN_REQUIRED,
        "risk_level": 2,
        "privacy_mode": PrivacyMode.SKELETON_ONLY,
        "need_dialogue": True,
        "dialogue_goal": "confirm_safety",
        "elder_message": "您还好吗？需要我帮您联系家人吗？",
        "family_notification": None,
        "action": DecisionAction.ASK_ELDER,
        "reason_summary": "内部原因不得出域",
        "uncertainty": Uncertainty.MEDIUM,
        "fallback_used": False,
        "source": DecisionSource.RULE,
        "demo_mode": DemoMode.LIVE,
        "response_timeout_ms": 8000,
    }
    fields.update(overrides)
    return CareDecision(**fields)


def test_family_alert_projects_to_exact_minimal_emergency_payload() -> None:
    occurred_at = datetime(2026, 8, 7, 11, 39, tzinfo=UTC)
    decision = _decision(
        state=DecisionState.FAMILY_NOTIFICATION_REQUIRED,
        risk_level=3,
        need_dialogue=False,
        dialogue_goal=None,
        elder_message=None,
        family_notification="内部家属通知文案不得直接出域",
        action=DecisionAction.NOTIFY_FAMILY,
        response_timeout_ms=None,
    )

    event = emergency_event_from_decision(decision, occurred_at=occurred_at)

    assert event == EmergencyEvent(
        schema_version="reme-emergency-event/v1",
        event_id="decision-0042",
        type=EmergencyType.FAMILY_INTERVENTION_REQUIRED,
        severity=EmergencySeverity.HIGH,
        summary="Reme 检测到需要家属介入的紧急事件，请尽快处理。",
        occurred_at="2026-08-07T11:39:00Z",
    )
    assert event.to_payload() == {
        "schema_version": "reme-emergency-event/v1",
        "event_id": "decision-0042",
        "type": "family_intervention_required",
        "severity": "high",
        "summary": "Reme 检测到需要家属介入的紧急事件，请尽快处理。",
        "occurred_at": "2026-08-07T11:39:00Z",
    }


def test_urgent_attention_projects_to_critical_emergency() -> None:
    decision = _decision(
        state=DecisionState.URGENT_ATTENTION,
        risk_level=4,
        need_dialogue=False,
        dialogue_goal=None,
        elder_message=None,
        action=DecisionAction.SHOW_URGENT_ATTENTION,
        response_timeout_ms=None,
    )

    event = emergency_event_from_decision(
        decision,
        occurred_at=datetime(2026, 8, 7, 11, 40, tzinfo=UTC),
    )

    assert event is not None
    assert event.type is EmergencyType.URGENT_ATTENTION
    assert event.severity is EmergencySeverity.CRITICAL
    assert event.summary == "Reme 检测到需要立即外部介入的紧急事件，请立即处理。"


def test_non_emergency_decisions_never_project_outbound_events() -> None:
    occurred_at = datetime(2026, 8, 7, 11, 41, tzinfo=UTC)
    non_emergency_states = (
        DecisionState.NORMAL,
        DecisionState.OBSERVE,
        DecisionState.CHECK_IN_REQUIRED,
        DecisionState.CONSENT_REQUIRED,
        DecisionState.RESOLVED,
        DecisionState.DEGRADED,
    )

    for state in non_emergency_states:
        decision = _decision()
        if state is DecisionState.NORMAL:
            decision = _decision(
                state=state,
                risk_level=0,
                need_dialogue=False,
                dialogue_goal=None,
                elder_message=None,
                action=DecisionAction.NONE,
                response_timeout_ms=None,
            )
        elif state is DecisionState.OBSERVE:
            decision = _decision(
                state=state,
                risk_level=1,
                need_dialogue=False,
                dialogue_goal=None,
                elder_message=None,
                action=DecisionAction.OBSERVE,
                response_timeout_ms=None,
            )
        elif state is DecisionState.CONSENT_REQUIRED:
            decision = _decision(state=state, consent_required=True)
        elif state is DecisionState.RESOLVED:
            decision = _decision(
                state=state,
                risk_level=0,
                need_dialogue=False,
                dialogue_goal=None,
                elder_message=None,
                action=DecisionAction.MARK_RESOLVED,
                response_timeout_ms=None,
            )
        elif state is DecisionState.DEGRADED:
            decision = _decision(
                state=state,
                risk_level=1,
                need_dialogue=False,
                dialogue_goal=None,
                elder_message=None,
                action=DecisionAction.OBSERVE,
                fallback_used=True,
                source=DecisionSource.DEGRADED,
                response_timeout_ms=None,
            )

        assert emergency_event_from_decision(decision, occurred_at=occurred_at) is None
