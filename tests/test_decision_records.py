"""Contract tests for B's outbound/inbound decision records."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from reme.decision.records import (
    ActionCard,
    CardStatus,
    CareDecision,
    DecisionAction,
    DecisionRecordError,
    DecisionSource,
    DecisionState,
    DemoMode,
    InteractionResponse,
    PrivacyMode,
    ResponseSource,
    ResponseValue,
    Uncertainty,
    VisualContext,
    VisualContextType,
    append_recorded_decision,
    as_recorded,
    load_recorded_decisions,
    parse_care_decision,
    parse_interaction_response,
)


def _action_card(**overrides: Any) -> ActionCard:
    fields: dict[str, Any] = {
        "event": "长时间静坐 + 主诉牙疼",
        "elder_quote": "牙疼，饭咬不动。",
        "system_judgment": "疑似口腔问题影响进食，非紧急",
        "suggested_action": "本周内预约口腔科检查",
        "time_window": "3 天内",
        "status": CardStatus.PENDING,
    }
    fields.update(overrides)
    return ActionCard(**fields)


def _decision(**overrides: Any) -> CareDecision:
    fields: dict[str, Any] = {
        "scene_id": "fall_demo_01",
        "decision_id": "decision-0007",
        "timestamp_ms": 12800.0,
        "state": DecisionState.CHECK_IN_REQUIRED,
        "risk_level": 2,
        "privacy_mode": PrivacyMode.SKELETON_ONLY,
        "need_dialogue": True,
        "dialogue_goal": "confirm_safety",
        "elder_message": "您还好吗？需要我帮您联系家人吗？",
        "family_notification": None,
        "action": DecisionAction.ASK_ELDER,
        "reason_summary": "检测到跌倒式转变，随后处于低运动状态。",
        "uncertainty": Uncertainty.MEDIUM,
        "fallback_used": False,
        "source": DecisionSource.RULE,
        "demo_mode": DemoMode.LIVE,
        "response_timeout_ms": 8000,
    }
    fields.update(overrides)
    return CareDecision(**fields)


def _response(**overrides: Any) -> InteractionResponse:
    fields: dict[str, Any] = {
        "scene_id": "fall_demo_01",
        "decision_id": "decision-0007",
        "timestamp_ms": 18600.0,
        "response": ResponseValue.SAFE,
        "source": ResponseSource.USER_INPUT,
        "demo_mode": DemoMode.LIVE,
    }
    fields.update(overrides)
    return InteractionResponse(**fields)


def test_care_decision_payload_round_trips_contract_fields() -> None:
    decision = _decision(
        action_card=_action_card(),
        visual_context=VisualContext(
            sent_to_mimo=True,
            type=VisualContextType.KEYFRAMES,
            start_ms=11100.0,
            end_ms=12700.0,
            sample_count=3,
        ),
    )
    assert parse_care_decision(decision.to_payload()) == decision


def test_interaction_response_payload_round_trips_contract_fields() -> None:
    response = _response(response=ResponseValue.NEED_HELP, text="牙疼，饭咬不动。")
    assert parse_interaction_response(response.to_payload()) == response


def test_care_decision_rejects_notify_family_without_family_notification() -> None:
    with pytest.raises(DecisionRecordError, match="family_notification"):
        _decision(action=DecisionAction.NOTIFY_FAMILY, family_notification=None)


def test_care_decision_rejects_partial_action_card() -> None:
    with pytest.raises(DecisionRecordError, match="suggested_action"):
        _action_card(suggested_action="  ")


def test_care_decision_rejects_notify_family_while_consent_pending() -> None:
    with pytest.raises(DecisionRecordError, match="consent"):
        _decision(
            action=DecisionAction.NOTIFY_FAMILY,
            family_notification="需要关注",
            consent_required=True,
        )


def test_care_decision_requires_null_elder_message_when_no_dialogue() -> None:
    with pytest.raises(DecisionRecordError, match="need_dialogue"):
        _decision(need_dialogue=False, elder_message="不该出现的话")


def test_care_decision_consent_state_pins_risk_level_two() -> None:
    with pytest.raises(DecisionRecordError, match="risk_level"):
        _decision(state=DecisionState.CONSENT_REQUIRED, consent_required=True, risk_level=3)


def test_care_decision_consent_state_requires_consent_flag() -> None:
    with pytest.raises(DecisionRecordError, match="consent_required"):
        _decision(state=DecisionState.CONSENT_REQUIRED, consent_required=False, risk_level=2)


def test_care_decision_degraded_state_requires_fallback_used() -> None:
    with pytest.raises(DecisionRecordError, match="fallback_used"):
        _decision(state=DecisionState.DEGRADED, fallback_used=False)


def test_care_decision_rejects_out_of_range_risk_level() -> None:
    with pytest.raises(DecisionRecordError, match="risk_level"):
        _decision(risk_level=5)
    with pytest.raises(DecisionRecordError, match="risk_level"):
        _decision(risk_level=True)


def test_care_decision_rejects_empty_optional_text() -> None:
    with pytest.raises(DecisionRecordError, match="dialogue_goal"):
        _decision(dialogue_goal="")


def test_visual_context_requires_null_fields_when_nothing_sent() -> None:
    with pytest.raises(DecisionRecordError, match="visual_context"):
        VisualContext(sent_to_mimo=False, type=VisualContextType.CLIP)


def test_interaction_response_rejects_text_from_timeout_source() -> None:
    with pytest.raises(DecisionRecordError, match="text"):
        _response(response=ResponseValue.NONE, source=ResponseSource.TIMEOUT, text="迟到的话")


def test_interaction_response_rejects_none_from_user_input() -> None:
    with pytest.raises(DecisionRecordError, match="response=none"):
        _response(response=ResponseValue.NONE, source=ResponseSource.USER_INPUT)


def test_interaction_response_rejects_card_confirmed_from_user_input() -> None:
    with pytest.raises(DecisionRecordError, match="family_input"):
        _response(response=ResponseValue.CARD_CONFIRMED, source=ResponseSource.USER_INPUT)


def test_parse_care_decision_rejects_unknown_field() -> None:
    payload = _decision().to_payload()
    payload["surprise"] = 1
    with pytest.raises(DecisionRecordError, match="unexpected"):
        parse_care_decision(payload)


def test_parse_care_decision_rejects_illegal_enum_value() -> None:
    payload = _decision().to_payload()
    payload["state"] = "panic"
    with pytest.raises(DecisionRecordError, match="state"):
        parse_care_decision(payload)


def test_recorded_decisions_append_and_reload_round_trip(tmp_path: Path) -> None:
    target = tmp_path / "recorded_decisions.jsonl"
    first = _decision(decision_id="decision-0001")
    second = _decision(
        decision_id="decision-0002",
        state=DecisionState.FAMILY_NOTIFICATION_REQUIRED,
        risk_level=3,
        need_dialogue=False,
        dialogue_goal=None,
        elder_message=None,
        action=DecisionAction.NOTIFY_FAMILY,
        family_notification="疑似跌倒后无回应，请尽快联系。",
        response_timeout_ms=None,
    )
    append_recorded_decision(target, first)
    append_recorded_decision(target, second)
    assert load_recorded_decisions(target, expected_scene_id="fall_demo_01") == (first, second)


def test_load_recorded_decisions_rejects_cross_scene_lines(tmp_path: Path) -> None:
    target = tmp_path / "recorded_decisions.jsonl"
    append_recorded_decision(target, _decision(scene_id="other_scene"))
    with pytest.raises(DecisionRecordError, match="scene"):
        load_recorded_decisions(target, expected_scene_id="fall_demo_01")


def test_as_recorded_rewrites_source_and_demo_mode() -> None:
    replayed = as_recorded(_decision())
    assert replayed.source is DecisionSource.RECORD
    assert replayed.demo_mode is DemoMode.RECORD
    assert replayed.decision_id == "decision-0007"
