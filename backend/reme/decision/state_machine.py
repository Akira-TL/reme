"""Pure per-scene session state machine: ticks and responses in, directives out.

B is request-driven (contract: C renders the countdown and submits
``response=none/source=timeout``), so this module holds no timers, no IO and
no MiMo calls — those live in the policy layer. Every function returns a new
immutable :class:`SessionState` plus instructions for the policy layer.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import StrEnum

from reme.decision.context import DecisionContext
from reme.decision.guardrails import (
    TriggerConfig,
    detect_concern_trigger,
    detect_fall_trigger,
    detect_observe_condition,
)
from reme.decision.records import (
    ActionCard,
    CardStatus,
    DecisionAction,
    DecisionState,
    InteractionResponse,
    ResponseValue,
)


class SessionPhase(StrEnum):
    """Where one care episode currently stands (internal, not the wire state)."""

    MONITORING = "monitoring"
    AWAITING_ELDER = "awaiting_elder"
    AWAITING_CONSENT = "awaiting_consent"
    FAMILY_NOTIFIED = "family_notified"
    URGENT = "urgent"
    RESOLVED = "resolved"


class EscalationKind(StrEnum):
    """Which deterministic trigger opened the current episode."""

    FALL = "fall"
    CONCERN = "concern"


class MimoTask(StrEnum):
    """The one MiMo call the policy layer may run for a directive."""

    COMPOSE_CHECK_IN = "compose_check_in"
    INTERPRET_RESPONSE = "interpret_response"
    COMPOSE_CARD = "compose_card"


class TemplateId(StrEnum):
    """Deterministic wording template for one outbound decision."""

    NORMAL = "normal"
    OBSERVE = "observe"
    FALL_CHECK_IN = "fall_check_in"
    CONCERN_CHECK_IN = "concern_check_in"
    CLARIFY = "clarify"
    SAFE_RESOLVED = "safe_resolved"
    LATE_SAFE_RESOLVED = "late_safe_resolved"
    FALL_HELP_ALERT = "fall_help_alert"
    UNCLEAR_FAMILY_ALERT = "unclear_family_alert"
    TIMEOUT_FAMILY_ALERT = "timeout_family_alert"
    CONSENT_REQUEST = "consent_request"
    CONSENT_DENIED_CLOSE = "consent_denied_close"
    CONSENT_TIMEOUT_CLOSE = "consent_timeout_close"
    CARD_FAMILY_NOTIFY = "card_family_notify"
    RECEIPT_RESOLVED = "receipt_resolved"
    URGENT_ALERT = "urgent_alert"


REJECT_STALE_DECISION = "stale_decision"
REJECT_NO_PENDING = "no_pending_decision"
REJECT_INVALID_RESPONSE = "invalid_response"
REJECT_TIMELINE_REWIND = "timeline_rewind"
REJECT_EPISODE_RESOLVED = "episode_resolved"


@dataclass(frozen=True, slots=True)
class SessionState:
    """Immutable per-scene episode state owned by the policy layer's store."""

    scene_id: str
    phase: SessionPhase = SessionPhase.MONITORING
    escalation: EscalationKind | None = None
    clarification_used: bool = False
    timeout_count: int = 0
    risk_floor: int = 0
    generation: int = 0
    complaint_text: str | None = None
    card_draft: ActionCard | None = None
    pending_decision_id: str | None = None
    last_emitted_state: DecisionState | None = None
    context_high_water_ms: float = 0.0
    handled_fall_event_id: str | None = None


@dataclass(frozen=True, slots=True)
class DecisionSkeleton:
    """Rule-decided shape of the next CareDecision; wording may come from MiMo."""

    state: DecisionState
    risk_level: int
    action: DecisionAction
    need_dialogue: bool
    dialogue_goal: str | None
    consent_required: bool
    response_timeout_ms: int | None
    template: TemplateId
    include_card: CardStatus | None = None


@dataclass(frozen=True, slots=True)
class Directive:
    """Transition output: new state plus what (if anything) to emit."""

    next_state: SessionState
    skeleton: DecisionSkeleton | None = None
    mimo_task: MimoTask | None = None
    reject_code: str | None = None


def _advance_clock(state: SessionState, timestamp_ms: float) -> SessionState:
    if timestamp_ms <= state.context_high_water_ms:
        return state
    return replace(state, context_high_water_ms=timestamp_ms)


def _mark_emitted(state: SessionState, skeleton: DecisionSkeleton) -> SessionState:
    return replace(state, generation=state.generation + 1, last_emitted_state=skeleton.state)


def _resolved_skeleton(
    template: TemplateId, *, include_card: CardStatus | None
) -> DecisionSkeleton:
    return DecisionSkeleton(
        state=DecisionState.RESOLVED,
        risk_level=0,
        action=DecisionAction.MARK_RESOLVED,
        need_dialogue=True,
        dialogue_goal=None,
        consent_required=False,
        response_timeout_ms=None,
        template=template,
        include_card=include_card,
    )


def _resolve(
    state: SessionState, template: TemplateId, *, include_card: CardStatus | None = None
) -> Directive:
    skeleton = _resolved_skeleton(template, include_card=include_card)
    next_state = replace(_mark_emitted(state, skeleton), phase=SessionPhase.RESOLVED, risk_floor=0)
    return Directive(next_state=next_state, skeleton=skeleton)


def _family_alert(
    state: SessionState,
    template: TemplateId,
    *,
    response_timeout_ms: int | None,
    need_dialogue: bool,
    timeout_count: int | None = None,
    include_card: CardStatus | None = None,
    mimo_task: MimoTask | None = None,
) -> Directive:
    skeleton = DecisionSkeleton(
        state=DecisionState.FAMILY_NOTIFICATION_REQUIRED,
        risk_level=3,
        action=DecisionAction.NOTIFY_FAMILY,
        need_dialogue=need_dialogue,
        dialogue_goal=None,
        consent_required=False,
        response_timeout_ms=response_timeout_ms,
        template=template,
        include_card=include_card,
    )
    next_state = replace(
        _mark_emitted(state, skeleton),
        phase=SessionPhase.FAMILY_NOTIFIED,
        risk_floor=3,
        timeout_count=state.timeout_count if timeout_count is None else timeout_count,
    )
    return Directive(next_state=next_state, skeleton=skeleton, mimo_task=mimo_task)


# Phases a newly observed fall may preempt: everything below family-alert
# severity, plus a resolved episode (which a fresh fall reopens).
_FALL_PREEMPTIBLE_PHASES = {
    SessionPhase.MONITORING,
    SessionPhase.AWAITING_CONSENT,
    SessionPhase.RESOLVED,
}


def _fall_check_in(
    state: SessionState, event_id: str | None, *, config: TriggerConfig
) -> Directive:
    skeleton = DecisionSkeleton(
        state=DecisionState.CHECK_IN_REQUIRED,
        risk_level=2,
        action=DecisionAction.ASK_ELDER,
        need_dialogue=True,
        dialogue_goal="confirm_safety",
        consent_required=False,
        # Contract: a high-confidence fall check-in must carry a countdown.
        response_timeout_ms=config.check_in_timeout_ms,
        template=TemplateId.FALL_CHECK_IN,
    )
    next_state = replace(
        _mark_emitted(state, skeleton),
        phase=SessionPhase.AWAITING_ELDER,
        escalation=EscalationKind.FALL,
        clarification_used=False,
        timeout_count=0,
        complaint_text=None,
        card_draft=None,
        handled_fall_event_id=event_id,
    )
    return Directive(next_state=next_state, skeleton=skeleton)


def _fall_preempts(state: SessionState, context: DecisionContext, config: TriggerConfig) -> bool:
    if not detect_fall_trigger(context, config=config):
        return False
    event = context.active_transition
    event_id = None if event is None else event.event_id
    if event_id is not None and event_id == state.handled_fall_event_id:
        return False
    if state.phase in _FALL_PREEMPTIBLE_PHASES:
        return True
    return state.phase is SessionPhase.AWAITING_ELDER and state.escalation is EscalationKind.CONCERN


def on_tick(state: SessionState, context: DecisionContext, *, config: TriggerConfig) -> Directive:
    """Evaluate one perception snapshot; may open or preempt an episode."""

    if context.scene_id != state.scene_id:
        raise ValueError(f"context scene {context.scene_id!r} does not match session")
    if context.timestamp_ms + config.rewind_tolerance_ms < state.context_high_water_ms:
        return Directive(next_state=state, reject_code=REJECT_TIMELINE_REWIND)
    advanced = _advance_clock(state, context.timestamp_ms)
    if _fall_preempts(advanced, context, config):
        # A new high-confidence fall outranks any lower-severity episode and
        # reopens a resolved one; family-alert states never de-escalate.
        event = context.active_transition
        return _fall_check_in(advanced, None if event is None else event.event_id, config=config)
    if advanced.phase is not SessionPhase.MONITORING:
        return Directive(next_state=advanced)

    if detect_concern_trigger(context, config=config):
        skeleton = DecisionSkeleton(
            state=DecisionState.CHECK_IN_REQUIRED,
            risk_level=2,
            action=DecisionAction.ASK_ELDER,
            need_dialogue=True,
            dialogue_goal="understand_need",
            consent_required=False,
            response_timeout_ms=None,
            template=TemplateId.CONCERN_CHECK_IN,
        )
        next_state = replace(
            _mark_emitted(advanced, skeleton),
            phase=SessionPhase.AWAITING_ELDER,
            escalation=EscalationKind.CONCERN,
        )
        return Directive(
            next_state=next_state, skeleton=skeleton, mimo_task=MimoTask.COMPOSE_CHECK_IN
        )

    if detect_observe_condition(context):
        skeleton = DecisionSkeleton(
            state=DecisionState.OBSERVE,
            risk_level=1,
            action=DecisionAction.OBSERVE,
            need_dialogue=False,
            dialogue_goal=None,
            consent_required=False,
            response_timeout_ms=None,
            template=TemplateId.OBSERVE,
        )
    else:
        skeleton = DecisionSkeleton(
            state=DecisionState.NORMAL,
            risk_level=0,
            action=DecisionAction.NONE,
            need_dialogue=False,
            dialogue_goal=None,
            consent_required=False,
            response_timeout_ms=None,
            template=TemplateId.NORMAL,
        )
    if advanced.last_emitted_state is skeleton.state:
        return Directive(next_state=advanced)
    return Directive(next_state=_mark_emitted(advanced, skeleton), skeleton=skeleton)


def _on_elder_response(
    state: SessionState, response: InteractionResponse, *, config: TriggerConfig
) -> Directive:
    value = response.response
    if value is ResponseValue.SAFE:
        return _resolve(state, TemplateId.SAFE_RESOLVED)
    if value is ResponseValue.NEED_HELP:
        if state.escalation is EscalationKind.FALL:
            return _family_alert(
                state,
                TemplateId.FALL_HELP_ALERT,
                response_timeout_ms=None,
                need_dialogue=True,
            )
        complaint = response.text or state.complaint_text
        if complaint is None:
            # No concrete complaint yet: nothing specific may be told to the
            # family, and MiMo must not invent one. Ask once, then alert.
            if not state.clarification_used:
                skeleton = DecisionSkeleton(
                    state=DecisionState.CHECK_IN_REQUIRED,
                    risk_level=2,
                    action=DecisionAction.ASK_ELDER,
                    need_dialogue=True,
                    dialogue_goal="understand_need",
                    consent_required=False,
                    response_timeout_ms=None,
                    template=TemplateId.CLARIFY,
                )
                next_state = replace(_mark_emitted(state, skeleton), clarification_used=True)
                return Directive(next_state=next_state, skeleton=skeleton)
            return _family_alert(
                state,
                TemplateId.UNCLEAR_FAMILY_ALERT,
                response_timeout_ms=config.family_ack_timeout_ms,
                need_dialogue=False,
            )
        skeleton = DecisionSkeleton(
            state=DecisionState.CONSENT_REQUIRED,
            risk_level=2,
            action=DecisionAction.ASK_ELDER,
            need_dialogue=True,
            dialogue_goal="request_consent",
            consent_required=True,
            response_timeout_ms=None,
            template=TemplateId.CONSENT_REQUEST,
        )
        next_state = replace(
            _mark_emitted(state, skeleton),
            phase=SessionPhase.AWAITING_CONSENT,
            complaint_text=complaint,
        )
        mimo_task = MimoTask.INTERPRET_RESPONSE if response.text is not None else None
        return Directive(next_state=next_state, skeleton=skeleton, mimo_task=mimo_task)
    if value is ResponseValue.UNCLEAR:
        if not state.clarification_used:
            is_fall = state.escalation is EscalationKind.FALL
            skeleton = DecisionSkeleton(
                state=DecisionState.CHECK_IN_REQUIRED,
                risk_level=2,
                action=DecisionAction.ASK_ELDER,
                need_dialogue=True,
                dialogue_goal="confirm_safety" if is_fall else "understand_need",
                consent_required=False,
                response_timeout_ms=config.check_in_timeout_ms if is_fall else None,
                template=TemplateId.CLARIFY,
            )
            next_state = replace(_mark_emitted(state, skeleton), clarification_used=True)
            return Directive(next_state=next_state, skeleton=skeleton)
        return _family_alert(
            state,
            TemplateId.UNCLEAR_FAMILY_ALERT,
            response_timeout_ms=config.family_ack_timeout_ms,
            need_dialogue=False,
        )
    if value is ResponseValue.NONE:
        # Contract: after a timeout the rules escalate immediately, never MiMo.
        return _family_alert(
            state,
            TemplateId.TIMEOUT_FAMILY_ALERT,
            response_timeout_ms=config.family_ack_timeout_ms,
            need_dialogue=False,
            timeout_count=state.timeout_count + 1,
        )
    return Directive(next_state=state, reject_code=REJECT_INVALID_RESPONSE)


def _on_consent_response(state: SessionState, response: InteractionResponse) -> Directive:
    value = response.response
    if value is ResponseValue.CONSENT_GRANTED:
        return _family_alert(
            state,
            TemplateId.CARD_FAMILY_NOTIFY,
            response_timeout_ms=None,
            need_dialogue=True,
            include_card=CardStatus.PENDING,
            mimo_task=MimoTask.COMPOSE_CARD if state.card_draft is None else None,
        )
    if value is ResponseValue.CONSENT_DENIED:
        return _resolve(state, TemplateId.CONSENT_DENIED_CLOSE)
    if value is ResponseValue.UNCLEAR:
        if not state.clarification_used:
            skeleton = DecisionSkeleton(
                state=DecisionState.CONSENT_REQUIRED,
                risk_level=2,
                action=DecisionAction.ASK_ELDER,
                need_dialogue=True,
                dialogue_goal="request_consent",
                consent_required=True,
                response_timeout_ms=None,
                template=TemplateId.CONSENT_REQUEST,
            )
            next_state = replace(_mark_emitted(state, skeleton), clarification_used=True)
            return Directive(next_state=next_state, skeleton=skeleton)
        return _resolve(state, TemplateId.CONSENT_TIMEOUT_CLOSE)
    if value is ResponseValue.NONE:
        # Conservative default the team may revisit: an unanswered consent
        # request never becomes a family notification.
        return _resolve(state, TemplateId.CONSENT_TIMEOUT_CLOSE)
    return Directive(next_state=state, reject_code=REJECT_INVALID_RESPONSE)


def _on_family_notified_response(state: SessionState, response: InteractionResponse) -> Directive:
    value = response.response
    if value is ResponseValue.CARD_CONFIRMED:
        include_card = CardStatus.CONFIRMED if state.card_draft is not None else None
        return _resolve(state, TemplateId.RECEIPT_RESOLVED, include_card=include_card)
    if value is ResponseValue.NONE:
        skeleton = DecisionSkeleton(
            state=DecisionState.URGENT_ATTENTION,
            risk_level=4,
            action=DecisionAction.SHOW_URGENT_ATTENTION,
            need_dialogue=False,
            dialogue_goal=None,
            consent_required=False,
            response_timeout_ms=None,
            template=TemplateId.URGENT_ALERT,
        )
        next_state = replace(
            _mark_emitted(state, skeleton),
            phase=SessionPhase.URGENT,
            risk_floor=4,
            timeout_count=state.timeout_count + 1,
        )
        return Directive(next_state=next_state, skeleton=skeleton)
    if value is ResponseValue.SAFE:
        return _resolve(state, TemplateId.LATE_SAFE_RESOLVED)
    if value is ResponseValue.NEED_HELP:
        return Directive(next_state=state)
    return Directive(next_state=state, reject_code=REJECT_INVALID_RESPONSE)


def _on_urgent_response(state: SessionState, response: InteractionResponse) -> Directive:
    value = response.response
    if value is ResponseValue.CARD_CONFIRMED:
        include_card = CardStatus.CONFIRMED if state.card_draft is not None else None
        return _resolve(state, TemplateId.RECEIPT_RESOLVED, include_card=include_card)
    if value is ResponseValue.SAFE:
        return _resolve(state, TemplateId.LATE_SAFE_RESOLVED)
    if value in (ResponseValue.NONE, ResponseValue.NEED_HELP):
        # An explicit help request cannot raise severity further; keep the
        # urgent decision on screen rather than erroring at the elder.
        return Directive(next_state=state)
    return Directive(next_state=state, reject_code=REJECT_INVALID_RESPONSE)


def on_response(
    state: SessionState, response: InteractionResponse, *, config: TriggerConfig
) -> Directive:
    """Apply one InteractionResponse from C to the current episode."""

    if response.scene_id != state.scene_id:
        raise ValueError(f"response scene {response.scene_id!r} does not match session")
    advanced = _advance_clock(state, response.timestamp_ms)
    if advanced.pending_decision_id is None:
        return Directive(next_state=advanced, reject_code=REJECT_NO_PENDING)
    if response.decision_id != advanced.pending_decision_id:
        return Directive(next_state=advanced, reject_code=REJECT_STALE_DECISION)
    if advanced.phase is SessionPhase.RESOLVED:
        return Directive(next_state=advanced, reject_code=REJECT_EPISODE_RESOLVED)
    if advanced.phase is SessionPhase.MONITORING:
        return Directive(next_state=advanced, reject_code=REJECT_INVALID_RESPONSE)
    if advanced.phase is SessionPhase.AWAITING_ELDER:
        return _on_elder_response(advanced, response, config=config)
    if advanced.phase is SessionPhase.AWAITING_CONSENT:
        return _on_consent_response(advanced, response)
    if advanced.phase is SessionPhase.FAMILY_NOTIFIED:
        return _on_family_notified_response(advanced, response)
    return _on_urgent_response(advanced, response)
