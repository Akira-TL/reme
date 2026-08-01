"""Decision session state machine: perception + responses in, CareDecisions out.

Contract behaviours implemented here (abc-interface §10-§11 + scene five):
- long stillness / fall-like transition trigger a check-in;
- fall check-ins always carry `response_timeout_ms`; timeout `none` escalates
  deterministically via `source=rule` (family notification, then urgent
  attention) and later MiMo output may only enrich the explanation;
- specific needs run the consent chain: need_help(+text) → consent_required →
  consent_granted → notify_family with a six-field action card →
  card_confirmed (family_input) → resolved receipt;
- at most one clarification round; MiMo failure at any call site degrades to a
  legal rule-template decision with `fallback_used=true`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from reme.decision.audit import AuditLogger
from reme.decision.context import DecisionContext, build_messages
from reme.decision.contracts import (
    ActionCard,
    CareDecision,
    ContractError,
    InteractionResponse,
    MiMoPayload,
)
from reme.decision.guardrails import (
    GuardrailConfig,
    fallback_check_in,
    fallback_observe,
    merge_late_mimo_reason,
    rule_family_notification,
    rule_urgent_attention,
)
from reme.decision.mimo_client import MiMoCallResult, MiMoClient, MiMoClientError

_NEED_UNDERSTANDING_INSTRUCTION = (
    "老人刚才对询问做出了回应（见 dialogue_history 最后一条）。请理解老人的需求："
    "若是需要家人协助的普通需求，设 consent_required=true、state=consent_required、"
    "action=ask_elder，elder_message 用一句话征求老人同意告知家人，并起草 action_card"
    "（六字段完整，elder_quote 使用老人原话，status=pending）；"
    "若无需协助，输出安抚回应并将 state 设为 observe 或 resolved。"
)
_CHECK_IN_INSTRUCTION = (
    "老人出现长时间静止（见 recent_posture_observations）。请判断是否需要轻量问候："
    "若需要，state=check_in_required、action=ask_elder、need_dialogue=true，"
    "elder_message 用一句自然的开场询问；若属正常作息，state=normal、need_dialogue=false。"
)
_CLARIFY_INSTRUCTION = (
    "老人上一条回应含义不清（见 dialogue_history）。请用一句更具体的问题澄清，"
    "state=check_in_required、action=ask_elder、need_dialogue=true。只此一次澄清机会。"
)


@dataclass(frozen=True)
class EngineEvent:
    """Normalized perception input for the session."""

    timestamp_ms: float
    kind: str
    data: dict[str, Any]


class DecisionSession:
    """One scene's decision loop; deterministic rules own every escalation."""

    def __init__(
        self,
        scene_id: str,
        *,
        client: MiMoClient,
        config: GuardrailConfig | None = None,
        audit: AuditLogger | None = None,
        context: DecisionContext | None = None,
    ) -> None:
        self.scene_id = scene_id
        self.demo_mode = client.mode
        self._client = client
        self._config = config or GuardrailConfig()
        self._audit = audit
        self._context = context or DecisionContext(
            scene_id=scene_id, address_term=(config or GuardrailConfig()).address_term
        )
        self._decision_seq = 0
        self._last_decision: CareDecision | None = None
        self._pending_card: ActionCard | None = None
        self._clarify_used = False
        self._timeout_count = 0
        self._escalated = False
        self._check_in_open = False
        self._stillness_reported = False

    @property
    def last_decision(self) -> CareDecision | None:
        return self._last_decision

    # ------------------------------------------------------------------
    # Perception inputs
    # ------------------------------------------------------------------

    def on_posture_observation(self, observation: dict[str, Any]) -> CareDecision | None:
        """Feed one PostureObservation; may open a stillness check-in."""

        self._context.add_observation(observation)
        duration = float(observation.get("posture_duration_ms") or 0.0)
        motion = observation.get("motion_level")
        timestamp = float(observation.get("timestamp_ms") or 0.0)
        if self._check_in_open or self._escalated or self._stillness_reported:
            return None
        if duration < self._config.stillness_check_in_threshold_ms:
            return None
        if motion not in ("still", "low"):
            return None
        self._stillness_reported = True
        payload, call = self._call_mimo(_CHECK_IN_INSTRUCTION)
        if payload is None:
            payload = fallback_check_in(self._config, "长时间静止，MiMo 不可用，规则保守问候")
        if payload.need_dialogue:
            self._check_in_open = True
        decision = self._emit(
            payload,
            timestamp_ms=timestamp,
            source=self._payload_source(call),
            fallback_used=call is None,
            response_timeout_ms=self._config.check_in_timeout_ms
            if payload.need_dialogue
            else None,
            call=call,
        )
        if payload.elder_message:
            self._context.add_dialogue("assistant", payload.elder_message)
        return decision

    def on_transition_event(self, event: dict[str, Any]) -> CareDecision | None:
        """Feed one TransitionEvent; fall-like transitions open a timed check-in."""

        self._context.add_transition(event)
        if event.get("transition") != "fall_like_transition":
            return None
        confidence = float(event.get("transition_confidence") or 0.0)
        if confidence < self._config.fall_confidence_threshold:
            return None
        if self._escalated:
            return None
        timestamp = float(event.get("end_ms") or event.get("start_ms") or 0.0)
        # Rule-first: the timed question goes out immediately, never waiting on MiMo.
        payload = fallback_check_in(
            self._config, f"检测到跌倒式转变（置信度 {confidence:.2f}），立即确认状态"
        )
        self._check_in_open = True
        decision = self._emit(
            payload,
            timestamp_ms=timestamp,
            source="rule",
            fallback_used=False,
            response_timeout_ms=self._config.check_in_timeout_ms,
            call=None,
        )
        if payload.elder_message:
            self._context.add_dialogue("assistant", payload.elder_message)
        return decision

    # ------------------------------------------------------------------
    # C → B responses
    # ------------------------------------------------------------------

    def on_interaction_response(self, response: InteractionResponse) -> CareDecision:
        """Consume one InteractionResponse and produce the next CareDecision."""

        response.validate()
        if self._last_decision is None:
            raise ContractError("no active decision to respond to")
        if response.decision_id != self._last_decision.decision_id:
            raise ContractError(
                f"response targets {response.decision_id!r}, "
                f"active decision is {self._last_decision.decision_id!r}"
            )
        if response.text:
            self._context.add_dialogue("elder", response.text)

        handler = {
            "safe": self._handle_safe,
            "need_help": self._handle_need_help,
            "unclear": self._handle_unclear,
            "none": self._handle_none,
            "consent_granted": self._handle_consent_granted,
            "consent_denied": self._handle_consent_denied,
            "card_confirmed": self._handle_card_confirmed,
        }[response.response]
        return handler(response)

    # ------------------------------------------------------------------
    # Response handlers
    # ------------------------------------------------------------------

    def _handle_safe(self, response: InteractionResponse) -> CareDecision:
        self._check_in_open = False
        if self._escalated:
            # Family alert already out; elder answering later resolves the loop
            # but the deterministic alert itself is never cancelled.
            payload = MiMoPayload(
                state="resolved",
                risk_level=2,
                privacy_mode="skeleton_only",
                need_dialogue=False,
                action="mark_resolved",
                reason_summary="老人已回应安全；此前的家属告警保留在时间线，不撤销。",
                elder_message=None,
                uncertainty="low",
            )
        else:
            payload = MiMoPayload(
                state="resolved",
                risk_level=0,
                privacy_mode="skeleton_only",
                need_dialogue=False,
                action="mark_resolved",
                reason_summary="老人确认状态正常，本次关注结束。",
                elder_message=None,
                uncertainty="low",
            )
        return self._emit(
            payload,
            timestamp_ms=response.timestamp_ms,
            source="rule",
            fallback_used=False,
            call=None,
        )

    def _handle_need_help(self, response: InteractionResponse) -> CareDecision:
        payload, call = self._call_mimo(_NEED_UNDERSTANDING_INSTRUCTION)
        fallback = call is None
        if payload is None:
            payload = MiMoPayload(
                state="consent_required",
                risk_level=2,
                privacy_mode="skeleton_only",
                need_dialogue=True,
                action="ask_elder",
                reason_summary="老人表达了求助需求；MiMo 不可用，按规则征求告知家人的同意。",
                dialogue_goal="request_consent",
                elder_message=f"{self._config.address_term}，需要我把这件事告诉家人吗？",
                consent_required=True,
                action_card=self._draft_rule_card(response.text),
                uncertainty="high",
            )
        payload = self._enforce_consent_gate(payload, response.text)
        if payload.consent_required:
            self._pending_card = payload.action_card or self._draft_rule_card(response.text)
        decision = self._emit(
            payload,
            timestamp_ms=response.timestamp_ms,
            source=self._payload_source(call),
            fallback_used=fallback,
            response_timeout_ms=self._config.check_in_timeout_ms
            if payload.need_dialogue
            else None,
            strip_card=True,
            call=call,
        )
        if payload.elder_message:
            self._context.add_dialogue("assistant", payload.elder_message)
        return decision

    def _handle_unclear(self, response: InteractionResponse) -> CareDecision:
        if self._clarify_used:
            payload = fallback_observe("两次未能理解回应，转为观察，不再追问。")
            self._check_in_open = False
            return self._emit(
                payload,
                timestamp_ms=response.timestamp_ms,
                source="rule",
                fallback_used=False,
                call=None,
            )
        self._clarify_used = True
        payload, call = self._call_mimo(_CLARIFY_INSTRUCTION)
        if payload is None:
            payload = fallback_check_in(self._config, "回应不清，规则模板再确认一次")
        decision = self._emit(
            payload,
            timestamp_ms=response.timestamp_ms,
            source=self._payload_source(call),
            fallback_used=call is None,
            response_timeout_ms=self._config.check_in_timeout_ms,
            call=call,
        )
        if payload.elder_message:
            self._context.add_dialogue("assistant", payload.elder_message)
        return decision

    def _handle_none(self, response: InteractionResponse) -> CareDecision:
        """Timeout escalation: deterministic, never waits for MiMo."""

        self._timeout_count += 1
        self._escalated = True
        self._check_in_open = False
        summary = self._escalation_summary()
        if self._timeout_count == 1:
            payload = rule_family_notification(self._config, summary)
        else:
            payload = rule_urgent_attention(self._config, summary)
        return self._emit(
            payload,
            timestamp_ms=response.timestamp_ms,
            source="rule",
            fallback_used=False,
            call=None,
        )

    def _handle_consent_granted(self, response: InteractionResponse) -> CareDecision:
        if self._last_decision is None or not self._last_decision.consent_required:
            raise ContractError("consent_granted only answers a consent_required decision")
        card = self._pending_card or self._draft_rule_card(None)
        payload = MiMoPayload(
            state="family_notification_required",
            risk_level=2,
            privacy_mode="skeleton_only",
            need_dialogue=False,
            action="notify_family",
            reason_summary="老人同意告知家人，发送行动卡。",
            elder_message=None,
            family_notification=f"{card.event}：{card.suggested_action}（{card.time_window}）",
            action_card=card,
            uncertainty="low",
        )
        return self._emit(
            payload,
            timestamp_ms=response.timestamp_ms,
            source="rule",
            fallback_used=False,
            call=None,
        )

    def _handle_consent_denied(self, response: InteractionResponse) -> CareDecision:
        if self._last_decision is None or not self._last_decision.consent_required:
            raise ContractError("consent_denied only answers a consent_required decision")
        self._pending_card = None
        self._check_in_open = False
        payload = fallback_observe("老人不同意告知家人，尊重意愿，仅保持观察。")
        return self._emit(
            payload,
            timestamp_ms=response.timestamp_ms,
            source="rule",
            fallback_used=False,
            call=None,
        )

    def _handle_card_confirmed(self, response: InteractionResponse) -> CareDecision:
        if self._last_decision is None or self._last_decision.action_card is None:
            raise ContractError("card_confirmed requires an outstanding action card")
        confirmed = ActionCard(
            event=self._last_decision.action_card.event,
            elder_quote=self._last_decision.action_card.elder_quote,
            system_judgment=self._last_decision.action_card.system_judgment,
            suggested_action=self._last_decision.action_card.suggested_action,
            time_window=self._last_decision.action_card.time_window,
            status="confirmed",
        )
        self._pending_card = None
        payload = MiMoPayload(
            state="resolved",
            risk_level=1,
            privacy_mode="skeleton_only",
            need_dialogue=True,
            action="mark_resolved",
            reason_summary="家属已确认行动卡，向老人发送回执。",
            elder_message="家人已经收到，会尽快安排，您安心。",
            action_card=confirmed,
            uncertainty="low",
        )
        return self._emit(
            payload,
            timestamp_ms=response.timestamp_ms,
            source="rule",
            fallback_used=False,
            call=None,
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _call_mimo(self, instruction: str) -> tuple[MiMoPayload | None, MiMoCallResult | None]:
        messages = build_messages(self._context, instruction)
        try:
            call = self._client.decide(messages)
        except MiMoClientError:
            return None, None
        payload = call.payload
        if self._escalated and _downgrades_escalation(payload):
            # Late MiMo answers may only enrich the explanation of an
            # already-escalated timeline, never soften it.
            base = self._last_decision
            enriched = rule_urgent_attention(self._config, self._escalation_summary())
            if base is not None and base.state == "family_notification_required":
                enriched = rule_family_notification(self._config, self._escalation_summary())
            enriched = MiMoPayload(
                state=enriched.state,
                risk_level=enriched.risk_level,
                privacy_mode=enriched.privacy_mode,
                need_dialogue=enriched.need_dialogue,
                action=enriched.action,
                reason_summary=merge_late_mimo_reason(
                    enriched.reason_summary, payload.reason_summary
                ),
                elder_message=enriched.elder_message,
                family_notification=enriched.family_notification,
                uncertainty=enriched.uncertainty,
            )
            return enriched, call
        return payload, call

    def _enforce_consent_gate(self, payload: MiMoPayload, elder_text: str | None) -> MiMoPayload:
        """Consent-before-notify for ordinary needs; escalated alerts bypass it."""

        if self._escalated:
            # Deterministic high-risk alerts are not subject to consent (v3.0):
            # the gate protects ordinary needs, never rule escalations.
            return payload
        if payload.action != "notify_family" or self._consent_already_granted():
            return payload
        return MiMoPayload(
            state="consent_required",
            risk_level=max(payload.risk_level, 2) if payload.risk_level <= 2 else 2,
            privacy_mode=payload.privacy_mode,
            need_dialogue=True,
            action="ask_elder",
            reason_summary=f"授权前置拦截：{payload.reason_summary}",
            dialogue_goal="request_consent",
            elder_message=f"{self._config.address_term}，需要我把这件事告诉家人吗？",
            consent_required=True,
            action_card=payload.action_card or self._draft_rule_card(elder_text),
            uncertainty=payload.uncertainty,
        )

    def _consent_already_granted(self) -> bool:
        return False  # Consent is granted per-decision via _handle_consent_granted.

    def _draft_rule_card(self, elder_text: str | None) -> ActionCard:
        quote = elder_text or "（老人表达了求助需求）"
        return ActionCard(
            event="主动询问中老人表达需求",
            elder_quote=quote,
            system_judgment="老人主诉需要协助，非紧急",
            suggested_action="请尽快与老人电话确认具体需求",
            time_window="今天内",
            status="pending",
        )

    def _escalation_summary(self) -> str:
        transitions = self._context.transitions
        if transitions:
            last = transitions[-1]
            return f"跌倒式转变后无回应 ×{self._timeout_count}（{last.get('transition', '')}）"
        return f"长时间静止后无回应 ×{self._timeout_count}"

    def _payload_source(self, call: MiMoCallResult | None) -> str:
        if call is None:
            return "degraded"
        return {"live": "mimo", "mock": "mock", "record": "record"}[call.mode]

    def _emit(
        self,
        payload: MiMoPayload,
        *,
        timestamp_ms: float,
        source: str,
        fallback_used: bool,
        response_timeout_ms: float | None = None,
        strip_card: bool = False,
        call: MiMoCallResult | None,
    ) -> CareDecision:
        self._decision_seq += 1
        card = payload.action_card
        if strip_card and payload.consent_required:
            # The card travels to C only after consent; keep the draft pending.
            card = None
        decision = CareDecision(
            scene_id=self.scene_id,
            decision_id=f"decision-{self._decision_seq:04d}",
            timestamp_ms=timestamp_ms,
            state=payload.state,
            risk_level=payload.risk_level,
            privacy_mode=payload.privacy_mode,
            need_dialogue=payload.need_dialogue,
            dialogue_goal=payload.dialogue_goal,
            elder_message=payload.elder_message if payload.need_dialogue else None,
            family_notification=payload.family_notification,
            consent_required=payload.consent_required,
            response_timeout_ms=response_timeout_ms,
            action_card=card,
            action=payload.action,
            reason_summary=payload.reason_summary,
            uncertainty=payload.uncertainty,
            fallback_used=fallback_used,
            source=source,
            demo_mode=self.demo_mode,
            visual_context=None,
        )
        decision.validate()
        self._last_decision = decision
        if self._audit is not None:
            self._audit.log_decision(decision, call)
        return decision


def _downgrades_escalation(payload: MiMoPayload) -> bool:
    return payload.state not in ("family_notification_required", "urgent_attention")
