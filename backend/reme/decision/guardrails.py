"""Deterministic guardrails: rule templates for degraded output and escalation.

Two contract clauses live here (abc-interface §10 constraints):
- MiMo timeout / invalid output / offline must still yield a legal decision;
- after a timeout `none`, B escalates via `source=rule` without waiting for
  MiMo, and later MiMo answers may only enrich the explanation.
"""

from __future__ import annotations

from dataclasses import dataclass

from reme.decision.contracts import MiMoPayload

CHECK_IN_TIMEOUT_MS_DEFAULT = 20_000.0
STILLNESS_CHECK_IN_THRESHOLD_MS_DEFAULT = 60_000.0
FALL_CONFIDENCE_THRESHOLD_DEFAULT = 0.6


@dataclass(frozen=True)
class GuardrailConfig:
    """Scene-configurable deterministic thresholds (real video milliseconds)."""

    check_in_timeout_ms: float = CHECK_IN_TIMEOUT_MS_DEFAULT
    stillness_check_in_threshold_ms: float = STILLNESS_CHECK_IN_THRESHOLD_MS_DEFAULT
    fall_confidence_threshold: float = FALL_CONFIDENCE_THRESHOLD_DEFAULT
    address_term: str = "叔叔"


def fallback_check_in(config: GuardrailConfig, reason: str) -> MiMoPayload:
    """Conservative check-in when MiMo is unavailable at question time."""

    return MiMoPayload(
        state="check_in_required",
        risk_level=2,
        privacy_mode="skeleton_only",
        need_dialogue=True,
        action="ask_elder",
        reason_summary=reason,
        dialogue_goal="confirm_safety",
        elder_message=f"{config.address_term}，您还好吗？方便回应一声吗？",
        family_notification=None,
        uncertainty="high",
    )


def fallback_observe(reason: str) -> MiMoPayload:
    """Silent conservative fallback for non-urgent contexts."""

    return MiMoPayload(
        state="observe",
        risk_level=1,
        privacy_mode="skeleton_only",
        need_dialogue=False,
        action="observe",
        reason_summary=reason,
        elder_message=None,
        family_notification=None,
        uncertainty="high",
    )


def rule_family_notification(config: GuardrailConfig, context_summary: str) -> MiMoPayload:
    """First deterministic escalation after an unanswered check-in."""

    return MiMoPayload(
        state="family_notification_required",
        risk_level=3,
        privacy_mode="skeleton_only",
        need_dialogue=False,
        action="notify_family",
        reason_summary=f"询问超时无回应，规则升级：{context_summary}",
        elder_message=None,
        family_notification=(
            f"{config.address_term}对确认询问无回应（{context_summary}），请尽快联系确认状态。"
        ),
        uncertainty="medium",
    )


def rule_urgent_attention(config: GuardrailConfig, context_summary: str) -> MiMoPayload:
    """Second deterministic escalation when the elder stays unresponsive."""

    return MiMoPayload(
        state="urgent_attention",
        risk_level=4,
        privacy_mode="blurred",
        need_dialogue=False,
        action="show_urgent_attention",
        reason_summary=f"持续无回应，规则升级至紧急关注：{context_summary}",
        elder_message=None,
        family_notification=(
            f"紧急提醒：{config.address_term}持续无回应（{context_summary}），建议立即联系或前往查看。"
        ),
        uncertainty="medium",
    )


def merge_late_mimo_reason(escalated_reason: str, mimo_reason: str) -> str:
    """Enrich an escalated decision's explanation without touching its verdict."""

    return f"{escalated_reason}（MiMo 补充：{mimo_reason}）"
