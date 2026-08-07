"""Tests for MiMo proposal parsing, task allowlists, and prompt assembly."""

from __future__ import annotations

import json
from typing import Any

import pytest
from reme.runtime.decision.mimo.prompts import (
    PersonaConfig,
    build_system_prompt,
    build_user_prompt,
)
from reme.runtime.decision.mimo.schema import (
    MimoSchemaError,
    extract_json_object,
    parse_mimo_proposal,
)
from reme.runtime.decision.records import DecisionState, Uncertainty
from reme.runtime.decision.state_machine import MimoTask


def _proposal_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "state": "consent_required",
        "risk_level": 2,
        "need_dialogue": True,
        "dialogue_goal": "request_consent",
        "elder_message": "王奶奶，要不要把牙疼的事告诉家人？",
        "family_notification": None,
        "consent_required": True,
        "reason_summary": "主诉牙疼影响进食，先征求授权",
        "uncertainty": "medium",
        "privacy_mode": None,
        "action_card": None,
    }
    payload.update(overrides)
    return payload


def _card_payload() -> dict[str, Any]:
    return {
        "event": "长时间静坐 + 主诉牙疼",
        "elder_quote": "牙疼，饭咬不动。",
        "system_judgment": "疑似口腔问题影响进食，非紧急",
        "suggested_action": "本周内预约口腔科检查",
        "time_window": "3 天内",
        "status": "pending",
    }


def test_parse_proposal_accepts_contract_json() -> None:
    proposal = parse_mimo_proposal(
        json.dumps(_proposal_payload(), ensure_ascii=False), task=MimoTask.INTERPRET_RESPONSE
    )
    assert proposal.state is DecisionState.CONSENT_REQUIRED
    assert proposal.consent_required is True
    assert proposal.uncertainty is Uncertainty.MEDIUM


def test_parse_proposal_strips_markdown_fence_once() -> None:
    fenced = "```json\n" + json.dumps(_proposal_payload(), ensure_ascii=False) + "\n```"
    proposal = parse_mimo_proposal(fenced, task=MimoTask.INTERPRET_RESPONSE)
    assert proposal.state is DecisionState.CONSENT_REQUIRED


def test_parse_proposal_rejects_unknown_fields() -> None:
    raw = json.dumps(_proposal_payload(surprise=1), ensure_ascii=False)
    with pytest.raises(MimoSchemaError, match="unexpected"):
        parse_mimo_proposal(raw, task=MimoTask.INTERPRET_RESPONSE)


def test_parse_proposal_rejects_illegal_enum_value() -> None:
    raw = json.dumps(_proposal_payload(uncertainty="panic"), ensure_ascii=False)
    with pytest.raises(MimoSchemaError, match="uncertainty"):
        parse_mimo_proposal(raw, task=MimoTask.INTERPRET_RESPONSE)


def test_parse_proposal_rejects_state_outside_task_allowlist() -> None:
    raw = json.dumps(_proposal_payload(state="resolved"), ensure_ascii=False)
    with pytest.raises(MimoSchemaError, match="allowlist"):
        parse_mimo_proposal(raw, task=MimoTask.INTERPRET_RESPONSE)


def test_parse_proposal_rejects_urgent_even_for_check_in_task() -> None:
    raw = json.dumps(
        _proposal_payload(state="urgent_attention", consent_required=False), ensure_ascii=False
    )
    with pytest.raises(MimoSchemaError, match="allowlist"):
        parse_mimo_proposal(raw, task=MimoTask.COMPOSE_CHECK_IN)


def test_parse_proposal_requires_complete_action_card() -> None:
    card = _card_payload()
    del card["time_window"]
    raw = json.dumps(_proposal_payload(action_card=card), ensure_ascii=False)
    with pytest.raises(MimoSchemaError, match="action_card"):
        parse_mimo_proposal(raw, task=MimoTask.INTERPRET_RESPONSE)


def test_parse_proposal_rejects_non_pending_card_status() -> None:
    card = _card_payload()
    card["status"] = "confirmed"
    raw = json.dumps(_proposal_payload(action_card=card), ensure_ascii=False)
    with pytest.raises(MimoSchemaError, match="pending"):
        parse_mimo_proposal(raw, task=MimoTask.INTERPRET_RESPONSE)


def test_compose_check_in_requires_elder_message() -> None:
    payload = _proposal_payload(
        state="check_in_required", elder_message=None, consent_required=False
    )
    with pytest.raises(MimoSchemaError, match="elder_message"):
        parse_mimo_proposal(json.dumps(payload, ensure_ascii=False), task=MimoTask.COMPOSE_CHECK_IN)


def test_compose_kitchen_share_requires_consent_and_no_early_notification() -> None:
    valid = _proposal_payload(
        elder_message="王奶奶，我看到您在包包子，要不要分享给家人看看？",
        reason_summary="看到厨房包包子场景，先征求分享授权",
        uncertainty="low",
    )
    proposal = parse_mimo_proposal(
        json.dumps(valid, ensure_ascii=False),
        task=MimoTask.COMPOSE_KITCHEN_SHARE,
    )
    assert proposal.state is DecisionState.CONSENT_REQUIRED
    assert proposal.consent_required is True

    invalid = dict(valid, family_notification="已发送给家人")
    with pytest.raises(MimoSchemaError, match="cannot notify family"):
        parse_mimo_proposal(
            json.dumps(invalid, ensure_ascii=False),
            task=MimoTask.COMPOSE_KITCHEN_SHARE,
        )


def test_kitchen_share_prompt_states_scene_and_waits_for_reply() -> None:
    system = build_system_prompt(MimoTask.COMPOSE_KITCHEN_SHARE, persona=PersonaConfig())
    assert "包包子" in system
    assert "必须等待老人明确回复" in system
    assert '"consent_required"' in system


def test_compose_card_requires_card_and_notification() -> None:
    payload = _proposal_payload(
        state="family_notification_required", risk_level=3, consent_required=False
    )
    with pytest.raises(MimoSchemaError, match="action_card"):
        parse_mimo_proposal(json.dumps(payload, ensure_ascii=False), task=MimoTask.COMPOSE_CARD)


def test_parse_proposal_rejects_empty_reason() -> None:
    raw = json.dumps(_proposal_payload(reason_summary=""), ensure_ascii=False)
    with pytest.raises(MimoSchemaError, match="reason_summary"):
        parse_mimo_proposal(raw, task=MimoTask.INTERPRET_RESPONSE)


def test_extract_json_object_rejects_prose_only_output() -> None:
    with pytest.raises(MimoSchemaError, match="JSON"):
        extract_json_object("我认为老人目前状态良好。")


def test_prompts_pin_elder_name_and_json_only_rule() -> None:
    persona = PersonaConfig(elder_name="李爷爷", family_relation="女儿")
    system = build_system_prompt(MimoTask.INTERPRET_RESPONSE, persona=persona)
    assert "李爷爷" in system
    assert "女儿" in system
    assert "只输出一个 JSON 对象" in system
    assert "consent_required" in system
    assert "不得升级、降低或撤销" in system


def test_visual_system_prompt_adds_privacy_addendum() -> None:
    persona = PersonaConfig()
    system = build_system_prompt(MimoTask.INTERPRET_RESPONSE, persona=persona, visual=True)
    assert "不得识别身份" in system


def test_user_prompt_embeds_summaries_and_elder_text() -> None:
    body = build_user_prompt(
        MimoTask.INTERPRET_RESPONSE,
        perception_summary={"posture": "sitting", "posture_duration_ms": 1860000},
        interaction_summary={"phase": "awaiting_elder", "clarification_used": False},
        elder_text="牙疼，饭咬不动。",
    )
    assert "【感知摘要】" in body
    assert '"posture": "sitting"' in body
    assert "牙疼，饭咬不动。" in body
    assert body.endswith("只输出 JSON 对象。")
