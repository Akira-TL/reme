"""Transition-table tests for B's session state machine (contract section 14 paths)."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from reme.decision.context import (
    DecisionContext,
    LandmarkQuality,
    MotionLevel,
    Posture,
    PostureObservation,
    Transition,
    TransitionEvent,
)
from reme.decision.guardrails import TriggerConfig
from reme.decision.records import (
    ActionCard,
    CardStatus,
    DecisionAction,
    DecisionState,
    DemoMode,
    InteractionResponse,
    ResponseSource,
    ResponseValue,
)
from reme.decision.state_machine import (
    REJECT_EPISODE_RESOLVED,
    REJECT_INVALID_RESPONSE,
    REJECT_NO_PENDING,
    REJECT_STALE_DECISION,
    REJECT_TIMELINE_REWIND,
    DemoConversationKind,
    EscalationKind,
    MimoTask,
    SessionPhase,
    SessionState,
    TemplateId,
    on_demo_conversation,
    on_response,
    on_tick,
)

_CONFIG = TriggerConfig()


def _posture(**overrides: Any) -> PostureObservation:
    fields: dict[str, Any] = {
        "scene_id": "fall_demo_01",
        "timestamp_ms": 12800.0,
        "person_detected": True,
        "posture": Posture.STANDING,
        "posture_confidence": 0.9,
        "posture_duration_ms": 2000.0,
        "motion_level": MotionLevel.MEDIUM,
        "landmark_quality": LandmarkQuality.USABLE,
    }
    fields.update(overrides)
    return PostureObservation(**fields)


def _fall_transition(**overrides: Any) -> TransitionEvent:
    fields: dict[str, Any] = {
        "scene_id": "fall_demo_01",
        "event_id": "transition-0003",
        "start_ms": 11100.0,
        "end_ms": 12700.0,
        "transition": Transition.FALL_LIKE,
        "transition_confidence": 0.8,
        "evidence": {},
        "landmark_quality": LandmarkQuality.USABLE,
    }
    fields.update(overrides)
    return TransitionEvent(**fields)


def _context(**overrides: Any) -> DecisionContext:
    fields: dict[str, Any] = {
        "scene_id": "fall_demo_01",
        "timestamp_ms": 13000.0,
        "latest_posture": _posture(),
        "active_transition": None,
        "input_quality": LandmarkQuality.USABLE,
    }
    fields.update(overrides)
    return DecisionContext(**fields)


def _fall_context() -> DecisionContext:
    return _context(
        latest_posture=_posture(posture=Posture.LYING, motion_level=MotionLevel.STILL),
        active_transition=_fall_transition(),
    )


def _state(**overrides: Any) -> SessionState:
    fields: dict[str, Any] = {"scene_id": "fall_demo_01"}
    fields.update(overrides)
    return SessionState(**fields)


def _response(
    value: ResponseValue, source: ResponseSource, **overrides: Any
) -> InteractionResponse:
    fields: dict[str, Any] = {
        "scene_id": "fall_demo_01",
        "decision_id": "decision-0001",
        "timestamp_ms": 20000.0,
        "response": value,
        "source": source,
        "demo_mode": DemoMode.LIVE,
    }
    fields.update(overrides)
    return InteractionResponse(**fields)


def _awaiting_elder(**overrides: Any) -> SessionState:
    fields: dict[str, Any] = {
        "phase": SessionPhase.AWAITING_ELDER,
        "escalation": EscalationKind.FALL,
        "pending_decision_id": "decision-0001",
        "last_emitted_state": DecisionState.CHECK_IN_REQUIRED,
        "generation": 1,
    }
    fields.update(overrides)
    return _state(**fields)


def test_normal_context_stays_monitoring_with_normal_decision() -> None:
    directive = on_tick(_state(), _context(), config=_CONFIG)
    assert directive.skeleton is not None
    assert directive.skeleton.state is DecisionState.NORMAL
    assert directive.skeleton.action is DecisionAction.NONE
    assert directive.next_state.phase is SessionPhase.MONITORING
    assert directive.mimo_task is None


def test_repeated_normal_tick_reuses_pending_decision() -> None:
    first = on_tick(_state(), _context(), config=_CONFIG)
    settled = replace(first.next_state, pending_decision_id="decision-0001")
    second = on_tick(settled, _context(timestamp_ms=14000.0), config=_CONFIG)
    assert second.skeleton is None
    assert second.reject_code is None
    assert second.next_state.context_high_water_ms == 14000.0


def test_degraded_quality_emits_observe_not_alarm() -> None:
    context = _context(input_quality=LandmarkQuality.DEGRADED)
    directive = on_tick(_state(), context, config=_CONFIG)
    assert directive.skeleton is not None
    assert directive.skeleton.state is DecisionState.OBSERVE
    assert directive.skeleton.need_dialogue is False


def test_fall_trigger_enters_awaiting_elder_with_mandatory_timeout() -> None:
    directive = on_tick(_state(), _fall_context(), config=_CONFIG)
    assert directive.skeleton is not None
    assert directive.skeleton.state is DecisionState.CHECK_IN_REQUIRED
    assert directive.skeleton.response_timeout_ms == _CONFIG.fall_response_timeout_ms
    assert directive.skeleton.response_timeout_ms == 2000
    assert directive.skeleton.template is TemplateId.FALL_CHECK_IN
    assert directive.skeleton.confirm_channels == ("voice",)
    assert directive.mimo_task is None
    assert directive.next_state.phase is SessionPhase.AWAITING_ELDER
    assert directive.next_state.escalation is EscalationKind.FALL


def _concern_context() -> DecisionContext:
    sitting = _posture(
        posture=Posture.SITTING, posture_duration_ms=40000.0, motion_level=MotionLevel.STILL
    )
    return _context(latest_posture=sitting)


def test_concern_trigger_requests_mimo_check_in() -> None:
    directive = on_tick(_state(), _concern_context(), config=_CONFIG)
    assert directive.skeleton is not None
    assert directive.skeleton.template is TemplateId.CONCERN_CHECK_IN
    assert directive.mimo_task is MimoTask.COMPOSE_CHECK_IN
    assert directive.next_state.escalation is EscalationKind.CONCERN


def test_concern_check_in_carries_the_mandatory_countdown() -> None:
    directive = on_tick(_state(), _concern_context(), config=_CONFIG)
    assert directive.skeleton is not None
    assert directive.skeleton.state is DecisionState.CHECK_IN_REQUIRED
    assert directive.skeleton.need_dialogue is True
    # Same countdown source as the fall path: without it C renders no timer and
    # the timeout escalation below is unreachable.
    assert directive.skeleton.response_timeout_ms == _CONFIG.check_in_timeout_ms
    assert directive.next_state.phase is SessionPhase.AWAITING_ELDER


def test_concern_check_in_timeout_escalates_by_rule() -> None:
    check_in = on_tick(_state(), _concern_context(), config=_CONFIG)
    assert check_in.skeleton is not None
    assert check_in.skeleton.response_timeout_ms is not None
    awaiting = replace(check_in.next_state, pending_decision_id="decision-0001")

    directive = on_response(
        awaiting, _response(ResponseValue.NONE, ResponseSource.TIMEOUT), config=_CONFIG
    )
    assert directive.skeleton is not None
    assert directive.skeleton.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert directive.skeleton.template is TemplateId.TIMEOUT_FAMILY_ALERT
    assert directive.skeleton.action is DecisionAction.NOTIFY_FAMILY
    # Rule-driven and MiMo-free, exactly as on the fall path (ADR-0005).
    assert directive.mimo_task is None
    assert directive.next_state.phase is SessionPhase.FAMILY_NOTIFIED
    assert directive.next_state.risk_floor == 3
    assert directive.next_state.timeout_count == 1


def test_concern_clarification_keeps_the_countdown() -> None:
    first = on_response(
        _awaiting_elder(escalation=EscalationKind.CONCERN),
        _response(ResponseValue.UNCLEAR, ResponseSource.USER_INPUT),
        config=_CONFIG,
    )
    assert first.skeleton is not None
    assert first.skeleton.template is TemplateId.CLARIFY
    assert first.skeleton.response_timeout_ms == _CONFIG.check_in_timeout_ms

    clarified = replace(first.next_state, pending_decision_id="decision-0002")
    second = on_response(
        clarified,
        _response(ResponseValue.NONE, ResponseSource.TIMEOUT, decision_id="decision-0002"),
        config=_CONFIG,
    )
    assert second.skeleton is not None
    assert second.skeleton.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert second.mimo_task is None


def test_concern_need_help_clarification_keeps_the_countdown() -> None:
    directive = on_response(
        _awaiting_elder(escalation=EscalationKind.CONCERN),
        _response(ResponseValue.NEED_HELP, ResponseSource.USER_INPUT),
        config=_CONFIG,
    )
    assert directive.skeleton is not None
    assert directive.skeleton.template is TemplateId.CLARIFY
    assert directive.skeleton.response_timeout_ms == _CONFIG.check_in_timeout_ms


def test_tick_while_awaiting_elder_reuses_pending_decision() -> None:
    directive = on_tick(_awaiting_elder(), _fall_context(), config=_CONFIG)
    assert directive.skeleton is None
    assert directive.reject_code is None
    assert directive.next_state.phase is SessionPhase.AWAITING_ELDER


def test_timeline_rewind_is_rejected() -> None:
    state = _state(context_high_water_ms=30000.0)
    directive = on_tick(state, _context(timestamp_ms=1000.0), config=_CONFIG)
    assert directive.reject_code == REJECT_TIMELINE_REWIND


def test_safe_response_resolves_check_in() -> None:
    directive = on_response(
        _awaiting_elder(), _response(ResponseValue.SAFE, ResponseSource.USER_INPUT), config=_CONFIG
    )
    assert directive.skeleton is not None
    assert directive.skeleton.state is DecisionState.RESOLVED
    assert directive.skeleton.action is DecisionAction.MARK_RESOLVED
    assert directive.skeleton.need_dialogue is True
    assert directive.next_state.phase is SessionPhase.RESOLVED
    assert directive.next_state.risk_floor == 0


def test_timeout_none_escalates_by_rule_without_mimo_task() -> None:
    directive = on_response(
        _awaiting_elder(), _response(ResponseValue.NONE, ResponseSource.TIMEOUT), config=_CONFIG
    )
    assert directive.skeleton is not None
    assert directive.skeleton.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert directive.skeleton.action is DecisionAction.NOTIFY_FAMILY
    assert directive.skeleton.response_timeout_ms == _CONFIG.family_ack_timeout_ms
    assert directive.mimo_task is None
    assert directive.next_state.risk_floor == 3
    assert directive.next_state.timeout_count == 1


def test_second_timeout_reaches_urgent_attention() -> None:
    first = on_response(
        _awaiting_elder(), _response(ResponseValue.NONE, ResponseSource.TIMEOUT), config=_CONFIG
    )
    notified = replace(first.next_state, pending_decision_id="decision-0002")
    second = on_response(
        notified,
        _response(ResponseValue.NONE, ResponseSource.TIMEOUT, decision_id="decision-0002"),
        config=_CONFIG,
    )
    assert second.skeleton is not None
    assert second.skeleton.state is DecisionState.URGENT_ATTENTION
    assert second.skeleton.risk_level == 4
    assert second.next_state.phase is SessionPhase.URGENT
    assert second.next_state.risk_floor == 4
    assert second.next_state.timeout_count == 2


def test_unclear_response_allows_exactly_one_clarification() -> None:
    first = on_response(
        _awaiting_elder(),
        _response(ResponseValue.UNCLEAR, ResponseSource.USER_INPUT),
        config=_CONFIG,
    )
    assert first.skeleton is not None
    assert first.skeleton.template is TemplateId.CLARIFY
    assert first.next_state.clarification_used is True
    assert first.next_state.phase is SessionPhase.AWAITING_ELDER

    clarified = replace(first.next_state, pending_decision_id="decision-0002")
    second = on_response(
        clarified,
        _response(ResponseValue.UNCLEAR, ResponseSource.USER_INPUT, decision_id="decision-0002"),
        config=_CONFIG,
    )
    assert second.skeleton is not None
    assert second.skeleton.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert second.skeleton.template is TemplateId.UNCLEAR_FAMILY_ALERT


def test_fall_path_uses_two_second_voice_response_window() -> None:
    """Fall voice turns escalate after two silent seconds; concern remains unchanged."""

    check_in = on_tick(_state(), _fall_context(), config=_CONFIG)
    assert check_in.skeleton is not None
    assert check_in.skeleton.template is TemplateId.FALL_CHECK_IN
    assert check_in.skeleton.dialogue_goal == "confirm_safety"
    assert check_in.skeleton.response_timeout_ms == _CONFIG.fall_response_timeout_ms
    assert check_in.mimo_task is None

    clarify = on_response(
        _awaiting_elder(),
        _response(ResponseValue.UNCLEAR, ResponseSource.USER_INPUT),
        config=_CONFIG,
    )
    assert clarify.skeleton is not None
    assert clarify.skeleton.template is TemplateId.CLARIFY
    # The goal distinguishes the safety path and keeps its shorter window.
    assert clarify.skeleton.dialogue_goal == "confirm_safety"
    assert clarify.skeleton.response_timeout_ms == _CONFIG.fall_response_timeout_ms


def test_need_help_on_fall_path_notifies_family_immediately() -> None:
    directive = on_response(
        _awaiting_elder(),
        _response(ResponseValue.NEED_HELP, ResponseSource.USER_INPUT),
        config=_CONFIG,
    )
    assert directive.skeleton is not None
    assert directive.skeleton.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert directive.skeleton.template is TemplateId.FALL_HELP_ALERT
    assert directive.skeleton.need_dialogue is False
    assert directive.mimo_task is None


def test_need_help_with_text_directs_to_consent_task() -> None:
    directive = on_response(
        _awaiting_elder(escalation=EscalationKind.CONCERN),
        _response(ResponseValue.NEED_HELP, ResponseSource.USER_INPUT, text="牙疼，饭咬不动。"),
        config=_CONFIG,
    )
    assert directive.skeleton is not None
    assert directive.skeleton.state is DecisionState.CONSENT_REQUIRED
    assert directive.skeleton.consent_required is True
    assert directive.skeleton.risk_level == 2
    assert directive.mimo_task is MimoTask.INTERPRET_RESPONSE
    assert directive.next_state.phase is SessionPhase.AWAITING_CONSENT
    assert directive.next_state.complaint_text == "牙疼，饭咬不动。"


def _awaiting_consent(**overrides: Any) -> SessionState:
    fields: dict[str, Any] = {
        "phase": SessionPhase.AWAITING_CONSENT,
        "escalation": EscalationKind.CONCERN,
        "pending_decision_id": "decision-0002",
        "last_emitted_state": DecisionState.CONSENT_REQUIRED,
        "complaint_text": "牙疼，饭咬不动。",
        "generation": 2,
    }
    fields.update(overrides)
    return _state(**fields)


def test_kitchen_share_starts_directly_at_consent_with_mimo_wording() -> None:
    directive = on_demo_conversation(
        _state(),
        kind=DemoConversationKind.KITCHEN_SHARE,
        timestamp_ms=15000.0,
        config=_CONFIG,
    )
    assert directive.skeleton is not None
    assert directive.skeleton.state is DecisionState.CONSENT_REQUIRED
    assert directive.skeleton.template is TemplateId.KITCHEN_SHARE_REQUEST
    assert directive.skeleton.consent_required is True
    assert directive.mimo_task is MimoTask.COMPOSE_KITCHEN_SHARE
    assert directive.next_state.phase is SessionPhase.AWAITING_CONSENT
    assert directive.next_state.conversation_kind is DemoConversationKind.KITCHEN_SHARE
    assert "包包子" in (directive.next_state.complaint_text or "")


def test_kitchen_share_only_notifies_after_explicit_consent() -> None:
    started = on_demo_conversation(
        _state(),
        kind=DemoConversationKind.KITCHEN_SHARE,
        timestamp_ms=15000.0,
        config=_CONFIG,
    )
    awaiting = replace(started.next_state, pending_decision_id="decision-0002")
    granted = on_response(
        awaiting,
        _response(
            ResponseValue.CONSENT_GRANTED,
            ResponseSource.USER_INPUT,
            decision_id="decision-0002",
        ),
        config=_CONFIG,
    )
    assert granted.skeleton is not None
    assert granted.skeleton.state is DecisionState.RESOLVED
    assert granted.skeleton.action is DecisionAction.NOTIFY_FAMILY
    assert granted.skeleton.template is TemplateId.KITCHEN_SHARE_GRANTED
    assert granted.skeleton.risk_level == 0
    assert granted.skeleton.need_dialogue is False
    assert granted.mimo_task is None

    denied = on_response(
        awaiting,
        _response(
            ResponseValue.CONSENT_DENIED,
            ResponseSource.USER_INPUT,
            decision_id="decision-0002",
        ),
        config=_CONFIG,
    )
    assert denied.skeleton is not None
    assert denied.skeleton.state is DecisionState.RESOLVED
    assert denied.skeleton.action is DecisionAction.MARK_RESOLVED
    assert denied.skeleton.template is TemplateId.KITCHEN_SHARE_DENIED
    assert denied.skeleton.need_dialogue is False


def test_manual_proactive_check_in_uses_normal_mimo_question_path() -> None:
    directive = on_demo_conversation(
        _state(),
        kind=DemoConversationKind.PROACTIVE_CHECK_IN,
        timestamp_ms=15000.0,
        config=_CONFIG,
    )
    assert directive.skeleton is not None
    assert directive.skeleton.state is DecisionState.CHECK_IN_REQUIRED
    assert directive.mimo_task is MimoTask.COMPOSE_CHECK_IN
    assert directive.next_state.phase is SessionPhase.AWAITING_ELDER


def test_consent_granted_notifies_family_with_card_task() -> None:
    directive = on_response(
        _awaiting_consent(),
        _response(
            ResponseValue.CONSENT_GRANTED, ResponseSource.USER_INPUT, decision_id="decision-0002"
        ),
        config=_CONFIG,
    )
    assert directive.skeleton is not None
    assert directive.skeleton.state is DecisionState.FAMILY_NOTIFICATION_REQUIRED
    assert directive.skeleton.include_card is CardStatus.PENDING
    assert directive.mimo_task is MimoTask.COMPOSE_CARD
    assert directive.next_state.risk_floor == 3


def test_consent_granted_reuses_cached_card_draft() -> None:
    card = ActionCard(
        event="长时间静坐 + 主诉牙疼",
        elder_quote="牙疼，饭咬不动。",
        system_judgment="疑似口腔问题影响进食，非紧急",
        suggested_action="本周内预约口腔科检查",
        time_window="3 天内",
        status=CardStatus.PENDING,
    )
    directive = on_response(
        _awaiting_consent(card_draft=card),
        _response(
            ResponseValue.CONSENT_GRANTED, ResponseSource.USER_INPUT, decision_id="decision-0002"
        ),
        config=_CONFIG,
    )
    assert directive.mimo_task is None


def test_consent_denied_resolves_without_notification() -> None:
    directive = on_response(
        _awaiting_consent(),
        _response(
            ResponseValue.CONSENT_DENIED, ResponseSource.USER_INPUT, decision_id="decision-0002"
        ),
        config=_CONFIG,
    )
    assert directive.skeleton is not None
    assert directive.skeleton.state is DecisionState.RESOLVED
    assert directive.skeleton.template is TemplateId.CONSENT_DENIED_CLOSE


def test_consent_timeout_resolves_conservatively() -> None:
    directive = on_response(
        _awaiting_consent(),
        _response(ResponseValue.NONE, ResponseSource.TIMEOUT, decision_id="decision-0002"),
        config=_CONFIG,
    )
    assert directive.skeleton is not None
    assert directive.skeleton.template is TemplateId.CONSENT_TIMEOUT_CLOSE
    assert directive.next_state.phase is SessionPhase.RESOLVED


def _family_notified(**overrides: Any) -> SessionState:
    fields: dict[str, Any] = {
        "phase": SessionPhase.FAMILY_NOTIFIED,
        "escalation": EscalationKind.CONCERN,
        "pending_decision_id": "decision-0003",
        "last_emitted_state": DecisionState.FAMILY_NOTIFICATION_REQUIRED,
        "risk_floor": 3,
        "generation": 3,
    }
    fields.update(overrides)
    return _state(**fields)


def test_card_confirmed_by_family_resolves_episode() -> None:
    card = ActionCard(
        event="长时间静坐 + 主诉牙疼",
        elder_quote="牙疼，饭咬不动。",
        system_judgment="疑似口腔问题影响进食，非紧急",
        suggested_action="本周内预约口腔科检查",
        time_window="3 天内",
        status=CardStatus.PENDING,
    )
    directive = on_response(
        _family_notified(card_draft=card),
        _response(
            ResponseValue.CARD_CONFIRMED, ResponseSource.FAMILY_INPUT, decision_id="decision-0003"
        ),
        config=_CONFIG,
    )
    assert directive.skeleton is not None
    assert directive.skeleton.state is DecisionState.RESOLVED
    assert directive.skeleton.include_card is CardStatus.CONFIRMED
    assert directive.skeleton.template is TemplateId.RECEIPT_RESOLVED


def test_late_safe_after_family_alert_resolves_with_dedicated_template() -> None:
    directive = on_response(
        _family_notified(),
        _response(ResponseValue.SAFE, ResponseSource.USER_INPUT, decision_id="decision-0003"),
        config=_CONFIG,
    )
    assert directive.skeleton is not None
    assert directive.skeleton.template is TemplateId.LATE_SAFE_RESOLVED
    assert directive.next_state.phase is SessionPhase.RESOLVED


def test_response_with_stale_decision_id_is_rejected() -> None:
    directive = on_response(
        _awaiting_elder(),
        _response(ResponseValue.SAFE, ResponseSource.USER_INPUT, decision_id="decision-9999"),
        config=_CONFIG,
    )
    assert directive.reject_code == REJECT_STALE_DECISION
    assert directive.skeleton is None


def test_response_without_pending_decision_is_rejected() -> None:
    directive = on_response(
        _state(), _response(ResponseValue.SAFE, ResponseSource.USER_INPUT), config=_CONFIG
    )
    assert directive.reject_code == REJECT_NO_PENDING


def test_consent_answer_is_invalid_while_awaiting_elder() -> None:
    directive = on_response(
        _awaiting_elder(),
        _response(ResponseValue.CONSENT_GRANTED, ResponseSource.USER_INPUT),
        config=_CONFIG,
    )
    assert directive.reject_code == REJECT_INVALID_RESPONSE


def test_new_fall_preempts_concern_episode() -> None:
    state = _awaiting_elder(escalation=EscalationKind.CONCERN)
    context = _context(
        latest_posture=_posture(posture=Posture.LYING, motion_level=MotionLevel.STILL),
        active_transition=_fall_transition(event_id="transition-0009"),
    )
    directive = on_tick(state, context, config=_CONFIG)
    assert directive.skeleton is not None
    assert directive.skeleton.template is TemplateId.FALL_CHECK_IN
    assert directive.next_state.escalation is EscalationKind.FALL
    assert directive.next_state.handled_fall_event_id == "transition-0009"


def test_same_fall_event_does_not_retrigger_after_resolution() -> None:
    state = _state(
        phase=SessionPhase.RESOLVED,
        pending_decision_id="decision-0004",
        last_emitted_state=DecisionState.RESOLVED,
        handled_fall_event_id="transition-0003",
    )
    directive = on_tick(state, _fall_context(), config=_CONFIG)
    assert directive.skeleton is None
    assert directive.next_state.phase is SessionPhase.RESOLVED


def test_lingering_lying_posture_does_not_reopen_resolved_fall() -> None:
    state = _state(
        phase=SessionPhase.RESOLVED,
        pending_decision_id="decision-0004",
        last_emitted_state=DecisionState.RESOLVED,
        handled_fall_event_id="transition-0003",
    )
    context = _context(
        latest_posture=_posture(
            posture=Posture.LYING,
            motion_level=MotionLevel.STILL,
            posture_duration_ms=900.0,
        ),
        active_transition=None,
    )

    directive = on_tick(state, context, config=_CONFIG)

    assert directive.skeleton is None
    assert directive.next_state.phase is SessionPhase.RESOLVED
    assert directive.next_state.handled_fall_event_id == "transition-0003"


def test_upright_evidence_rearms_posture_only_fall_detection() -> None:
    resolved = _state(
        phase=SessionPhase.RESOLVED,
        pending_decision_id="decision-0004",
        last_emitted_state=DecisionState.RESOLVED,
        handled_fall_event_id="lying:fall_demo_01:11",
    )
    upright = on_tick(resolved, _context(), config=_CONFIG)
    assert upright.next_state.handled_fall_event_id is None

    next_fall = on_tick(upright.next_state, _context(
        timestamp_ms=16000.0,
        latest_posture=_posture(
            timestamp_ms=15900.0,
            posture=Posture.LYING,
            motion_level=MotionLevel.STILL,
            posture_duration_ms=800.0,
        ),
    ), config=_CONFIG)

    assert next_fall.skeleton is not None
    assert next_fall.skeleton.template is TemplateId.FALL_CHECK_IN


def test_late_transition_canonicalizes_posture_fall_before_safe_resolution() -> None:
    posture_first = on_tick(_state(), _context(
        latest_posture=_posture(posture=Posture.LYING, motion_level=MotionLevel.STILL),
        active_transition=None,
    ), config=_CONFIG)
    assert posture_first.next_state.handled_fall_event_id.startswith("lying:")

    transition_arrives = on_tick(
        posture_first.next_state,
        _fall_context(),
        config=_CONFIG,
    )
    assert transition_arrives.skeleton is None
    assert transition_arrives.next_state.handled_fall_event_id == "transition-0003"

    resolved = on_response(
        replace(transition_arrives.next_state, pending_decision_id="decision-0001"),
        _response(ResponseValue.SAFE, ResponseSource.VOICE),
        config=_CONFIG,
    )
    upright = on_tick(resolved.next_state, _context(), config=_CONFIG)
    assert upright.next_state.handled_fall_event_id == "transition-0003"

    stale_transition = on_tick(upright.next_state, _fall_context(), config=_CONFIG)
    assert stale_transition.skeleton is None
    assert stale_transition.next_state.phase is SessionPhase.RESOLVED


def test_new_fall_reopens_resolved_episode() -> None:
    state = _state(
        phase=SessionPhase.RESOLVED,
        pending_decision_id="decision-0004",
        last_emitted_state=DecisionState.RESOLVED,
        handled_fall_event_id="transition-0003",
    )
    context = _context(
        latest_posture=_posture(posture=Posture.LYING, motion_level=MotionLevel.STILL),
        active_transition=_fall_transition(event_id="transition-0010"),
    )
    directive = on_tick(state, context, config=_CONFIG)
    assert directive.skeleton is not None
    assert directive.skeleton.state is DecisionState.CHECK_IN_REQUIRED
    assert directive.next_state.phase is SessionPhase.AWAITING_ELDER
    assert directive.next_state.timeout_count == 0


def test_need_help_without_text_clarifies_before_consent() -> None:
    first = on_response(
        _awaiting_elder(escalation=EscalationKind.CONCERN),
        _response(ResponseValue.NEED_HELP, ResponseSource.USER_INPUT),
        config=_CONFIG,
    )
    assert first.skeleton is not None
    assert first.skeleton.template is TemplateId.CLARIFY
    assert first.next_state.phase is SessionPhase.AWAITING_ELDER
    assert first.mimo_task is None

    clarified = replace(first.next_state, pending_decision_id="decision-0002")
    second = on_response(
        clarified,
        _response(ResponseValue.NEED_HELP, ResponseSource.USER_INPUT, decision_id="decision-0002"),
        config=_CONFIG,
    )
    assert second.skeleton is not None
    assert second.skeleton.template is TemplateId.UNCLEAR_FAMILY_ALERT


def test_consent_unclear_reasks_once_then_closes() -> None:
    first = on_response(
        _awaiting_consent(),
        _response(ResponseValue.UNCLEAR, ResponseSource.USER_INPUT, decision_id="decision-0002"),
        config=_CONFIG,
    )
    assert first.skeleton is not None
    assert first.skeleton.state is DecisionState.CONSENT_REQUIRED
    assert first.next_state.clarification_used is True

    reasked = replace(first.next_state, pending_decision_id="decision-0003")
    second = on_response(
        reasked,
        _response(ResponseValue.UNCLEAR, ResponseSource.USER_INPUT, decision_id="decision-0003"),
        config=_CONFIG,
    )
    assert second.skeleton is not None
    assert second.skeleton.template is TemplateId.CONSENT_TIMEOUT_CLOSE


def test_urgent_need_help_keeps_urgent_decision() -> None:
    state = _state(
        phase=SessionPhase.URGENT,
        pending_decision_id="decision-0005",
        last_emitted_state=DecisionState.URGENT_ATTENTION,
        risk_floor=4,
    )
    directive = on_response(
        state,
        _response(ResponseValue.NEED_HELP, ResponseSource.USER_INPUT, decision_id="decision-0005"),
        config=_CONFIG,
    )
    assert directive.reject_code is None
    assert directive.skeleton is None
    assert directive.next_state.phase is SessionPhase.URGENT


def test_resolved_episode_rejects_further_responses() -> None:
    state = _state(
        phase=SessionPhase.RESOLVED,
        pending_decision_id="decision-0004",
        last_emitted_state=DecisionState.RESOLVED,
    )
    directive = on_response(
        state,
        _response(ResponseValue.SAFE, ResponseSource.USER_INPUT, decision_id="decision-0004"),
        config=_CONFIG,
    )
    assert directive.reject_code == REJECT_EPISODE_RESOLVED
