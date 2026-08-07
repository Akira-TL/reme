"""Privacy and delivery contract tests for outbound emergency integrations."""

from __future__ import annotations

from datetime import UTC, datetime
from threading import Event
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
from reme.runtime.decision.runtime_glue import DecisionPublisherFanout
from reme.runtime.integrations.emergency import (
    EmergencyDecisionPublisher,
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
        event_id="reme-8c891fd4e5c6e3cb5e06ac339bbb7ecc",
        type=EmergencyType.FAMILY_INTERVENTION_REQUIRED,
        severity=EmergencySeverity.HIGH,
        summary="Reme 检测到需要家属介入的紧急事件，请尽快处理。",
        occurred_at="2026-08-07T11:39:00Z",
    )
    assert event.to_payload() == {
        "schema_version": "reme-emergency-event/v1",
        "event_id": "reme-8c891fd4e5c6e3cb5e06ac339bbb7ecc",
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


def test_event_id_is_stable_for_retries_and_distinct_across_scenes() -> None:
    decision = _decision(
        state=DecisionState.URGENT_ATTENTION,
        risk_level=4,
        need_dialogue=False,
        dialogue_goal=None,
        elder_message=None,
        action=DecisionAction.SHOW_URGENT_ATTENTION,
        response_timeout_ms=None,
    )
    first = emergency_event_from_decision(
        decision, occurred_at=datetime(2026, 8, 7, 11, 40, tzinfo=UTC)
    )
    retry = emergency_event_from_decision(
        decision, occurred_at=datetime(2026, 8, 7, 11, 41, tzinfo=UTC)
    )
    other_scene = emergency_event_from_decision(
        _decision(
            scene_id="kitchen",
            state=DecisionState.URGENT_ATTENTION,
            risk_level=4,
            need_dialogue=False,
            dialogue_goal=None,
            elder_message=None,
            action=DecisionAction.SHOW_URGENT_ATTENTION,
            response_timeout_ms=None,
        ),
        occurred_at=datetime(2026, 8, 7, 11, 40, tzinfo=UTC),
    )

    assert first is not None and retry is not None and other_scene is not None
    assert first.event_id == retry.event_id
    assert first.event_id != other_scene.event_id
    assert "fall_demo_01" not in first.event_id
    assert "decision-0042" not in first.event_id


class _RecordingDecisionPublisher:
    def __init__(self) -> None:
        self.decisions: list[CareDecision] = []

    def publish_decision(self, decision: CareDecision) -> None:
        self.decisions.append(decision)


class _ExplodingDecisionPublisher:
    def publish_decision(self, decision: CareDecision) -> None:
        raise RuntimeError(f"simulated publisher failure for {decision.decision_id}")


def test_decision_publisher_fanout_isolates_each_sink(capsys: Any) -> None:
    first = _RecordingDecisionPublisher()
    last = _RecordingDecisionPublisher()
    fanout = DecisionPublisherFanout(first, _ExplodingDecisionPublisher(), last)
    decision = _urgent_decision()

    fanout.publish_decision(decision)

    assert first.decisions == [decision]
    assert last.decisions == [decision]
    assert "warning: decision publisher failed" in capsys.readouterr().out


class _BlockingTransport:
    def __init__(self) -> None:
        self.started = Event()
        self.release = Event()
        self.sent: list[EmergencyEvent] = []

    def send_event(self, event: EmergencyEvent) -> None:
        self.started.set()
        if not self.release.wait(timeout=1.0):
            raise TimeoutError("test transport was not released")
        self.sent.append(event)


class _CollectingTransport:
    def __init__(self) -> None:
        self.sent: list[EmergencyEvent] = []

    def send_event(self, event: EmergencyEvent) -> None:
        self.sent.append(event)


class _FailingTransport:
    def send_event(self, event: EmergencyEvent) -> None:
        raise TimeoutError(f"simulated timeout for {event.event_id}")


def _urgent_decision() -> CareDecision:
    return _decision(
        state=DecisionState.URGENT_ATTENTION,
        risk_level=4,
        need_dialogue=False,
        dialogue_goal=None,
        elder_message=None,
        action=DecisionAction.SHOW_URGENT_ATTENTION,
        response_timeout_ms=None,
    )


def test_emergency_publisher_is_non_blocking_and_deduplicates_decisions() -> None:
    transport = _BlockingTransport()
    publisher = EmergencyDecisionPublisher(
        transport,
        clock=lambda: datetime(2026, 8, 7, 11, 42, tzinfo=UTC),
    )
    decision = _urgent_decision()

    publisher.publish_decision(decision)
    assert transport.started.wait(timeout=0.5)
    publisher.publish_decision(decision)
    transport.release.set()
    publisher.close()

    assert len(transport.sent) == 1


def test_emergency_publisher_swallows_transport_failures(capsys: Any) -> None:
    publisher = EmergencyDecisionPublisher(
        _FailingTransport(),
        clock=lambda: datetime(2026, 8, 7, 11, 42, tzinfo=UTC),
    )

    publisher.publish_decision(_urgent_decision())
    publisher.close()

    assert "warning: emergency delivery failed" in capsys.readouterr().out


def test_emergency_publisher_ignores_non_emergency_decisions() -> None:
    transport = _CollectingTransport()
    publisher = EmergencyDecisionPublisher(
        transport,
        clock=lambda: datetime(2026, 8, 7, 11, 42, tzinfo=UTC),
    )

    publisher.publish_decision(_decision())
    publisher.close()

    assert transport.sent == []


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
