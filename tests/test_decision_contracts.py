from __future__ import annotations

import pytest

from reme.decision.contracts import (
    ActionCard,
    CareDecision,
    ContractError,
    InteractionResponse,
    parse_mimo_payload,
)


def _decision(**overrides: object) -> CareDecision:
    base: dict[str, object] = {
        "scene_id": "toothache_loop_01",
        "decision_id": "decision-0001",
        "timestamp_ms": 1000.0,
        "state": "check_in_required",
        "risk_level": 1,
        "privacy_mode": "skeleton_only",
        "need_dialogue": True,
        "action": "ask_elder",
        "reason_summary": "test",
        "uncertainty": "medium",
        "fallback_used": False,
        "source": "mock",
        "demo_mode": "mock",
        "elder_message": "您好吗？",
    }
    base.update(overrides)
    return CareDecision(**base)  # type: ignore[arg-type]


def test_valid_decision_passes() -> None:
    _decision().validate()


def test_invalid_state_rejected() -> None:
    with pytest.raises(ContractError):
        _decision(state="panic").validate()


def test_notify_family_requires_notification_text() -> None:
    with pytest.raises(ContractError):
        _decision(action="notify_family", family_notification=None).validate()


def test_no_dialogue_forbids_elder_message() -> None:
    with pytest.raises(ContractError):
        _decision(need_dialogue=False, elder_message="嗨").validate()


def test_action_card_requires_all_six_fields() -> None:
    with pytest.raises(ContractError):
        ActionCard.from_dict({"event": "e", "elder_quote": "q", "status": "pending"})


def test_action_card_blank_field_rejected() -> None:
    with pytest.raises(ContractError):
        ActionCard(
            event="e",
            elder_quote=" ",
            system_judgment="j",
            suggested_action="a",
            time_window="t",
        ).validate()


def test_interaction_response_timeout_must_be_none_and_textless() -> None:
    with pytest.raises(ContractError):
        InteractionResponse(
            scene_id="s",
            decision_id="d",
            timestamp_ms=1.0,
            response="safe",
            source="timeout",
            demo_mode="mock",
        ).validate()
    with pytest.raises(ContractError):
        InteractionResponse(
            scene_id="s",
            decision_id="d",
            timestamp_ms=1.0,
            response="none",
            source="timeout",
            demo_mode="mock",
            text="迟到的话",
        ).validate()


def test_card_confirmed_requires_family_input() -> None:
    with pytest.raises(ContractError):
        InteractionResponse(
            scene_id="s",
            decision_id="d",
            timestamp_ms=1.0,
            response="card_confirmed",
            source="user_input",
            demo_mode="mock",
        ).validate()


def test_parse_mimo_payload_missing_fields() -> None:
    with pytest.raises(ContractError):
        parse_mimo_payload({"state": "normal"})


def test_parse_mimo_payload_full() -> None:
    payload = parse_mimo_payload(
        {
            "state": "consent_required",
            "risk_level": 2,
            "privacy_mode": "skeleton_only",
            "need_dialogue": True,
            "dialogue_goal": "request_consent",
            "elder_message": "告诉家人吗？",
            "family_notification": None,
            "consent_required": True,
            "action": "ask_elder",
            "reason_summary": "牙疼求助",
            "action_card": {
                "event": "e",
                "elder_quote": "q",
                "system_judgment": "j",
                "suggested_action": "a",
                "time_window": "t",
                "status": "pending",
            },
        }
    )
    assert payload.consent_required is True
    assert payload.action_card is not None
    assert payload.action_card.status == "pending"
