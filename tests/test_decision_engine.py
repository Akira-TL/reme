from __future__ import annotations

from typing import Any

import pytest
from reme.decision.contracts import ContractError, InteractionResponse
from reme.decision.engine import DecisionSession
from reme.decision.guardrails import GuardrailConfig
from reme.decision.mimo_client import MiMoClient
from reme.decision.mock_scenes import (
    SCENE_FALL_SILENT,
    SCENE_NEED_LOOP,
    scripted_payloads,
)

_CONFIG = GuardrailConfig(
    check_in_timeout_ms=20_000.0,
    stillness_check_in_threshold_ms=60_000.0,
    address_term="王叔叔",
)


def _still(duration_ms: float, timestamp_ms: float) -> dict[str, Any]:
    return {
        "schema_version": "reme-posture/v0-experiment",
        "scene_id": SCENE_NEED_LOOP,
        "timestamp_ms": timestamp_ms,
        "posture": "sitting",
        "posture_confidence": 0.9,
        "posture_duration_ms": duration_ms,
        "motion_level": "still",
        "landmark_quality": "usable",
    }


def _fall(confidence: float = 0.76) -> dict[str, Any]:
    return {
        "schema_version": "reme-transition/v0-experiment",
        "scene_id": SCENE_FALL_SILENT,
        "event_id": "transition-0001",
        "start_ms": 11_100.0,
        "end_ms": 12_700.0,
        "transition": "fall_like_transition",
        "transition_confidence": confidence,
        "landmark_quality": "usable",
    }


def _respond(
    session: DecisionSession,
    response: str,
    *,
    text: str | None = None,
    source: str = "user_input",
    timestamp_ms: float = 50_000.0,
) -> Any:
    assert session.last_decision is not None
    return session.on_interaction_response(
        InteractionResponse(
            scene_id=session.scene_id,
            decision_id=session.last_decision.decision_id,
            timestamp_ms=timestamp_ms,
            response=response,
            source=source,
            demo_mode=session.demo_mode,
            text=text,
        )
    )


def _need_loop_session() -> DecisionSession:
    client = MiMoClient("mock", mock_payloads=scripted_payloads(SCENE_NEED_LOOP))
    return DecisionSession(SCENE_NEED_LOOP, client=client, config=_CONFIG)


def _fall_session() -> DecisionSession:
    client = MiMoClient("mock", mock_payloads=scripted_payloads(SCENE_FALL_SILENT))
    return DecisionSession(SCENE_FALL_SILENT, client=client, config=_CONFIG)


def test_toothache_full_loop() -> None:
    session = _need_loop_session()

    assert session.on_posture_observation(_still(10_000.0, 10_000.0)) is None
    opening = session.on_posture_observation(_still(65_000.0, 65_000.0))
    assert opening is not None
    assert opening.state == "check_in_required"
    assert opening.elder_message == "今天午饭吃得还顺口吗？"
    assert opening.source == "mock"
    assert opening.response_timeout_ms == 20_000.0

    consent = _respond(session, "need_help", text="牙疼，饭咬不动。")
    assert consent.state == "consent_required"
    assert consent.consent_required is True
    assert consent.action == "ask_elder"
    assert consent.action_card is None  # card only travels after consent

    notify = _respond(session, "consent_granted")
    assert notify.state == "family_notification_required"
    assert notify.action == "notify_family"
    assert notify.family_notification is not None
    assert notify.action_card is not None
    assert notify.action_card.elder_quote == "牙疼，饭咬不动。"
    assert notify.action_card.status == "pending"

    receipt = _respond(session, "card_confirmed", source="family_input")
    assert receipt.state == "resolved"
    assert receipt.action == "mark_resolved"
    assert receipt.action_card is not None
    assert receipt.action_card.status == "confirmed"
    assert receipt.elder_message is not None


def test_consent_denied_stops_notification() -> None:
    session = _need_loop_session()
    session.on_posture_observation(_still(65_000.0, 65_000.0))
    _respond(session, "need_help", text="牙疼。")
    decision = _respond(session, "consent_denied")
    assert decision.state == "observe"
    assert decision.family_notification is None


def test_fall_scene_runs_fully_on_rules() -> None:
    session = _fall_session()

    check_in = session.on_transition_event(_fall())
    assert check_in is not None
    assert check_in.source == "rule"
    assert check_in.state == "check_in_required"
    assert check_in.response_timeout_ms is not None  # contract: never null for falls

    first = _respond(session, "none", source="timeout", text=None)
    assert first.state == "family_notification_required"
    assert first.source == "rule"
    assert first.family_notification is not None

    second = _respond(session, "none", source="timeout")
    assert second.state == "urgent_attention"
    assert second.risk_level == 4
    assert second.action == "show_urgent_attention"


def test_safe_answer_resolves_without_escalation() -> None:
    session = _fall_session()
    session.on_transition_event(_fall())
    decision = _respond(session, "safe")
    assert decision.state == "resolved"
    assert decision.risk_level == 0


def test_low_confidence_fall_is_ignored() -> None:
    session = _fall_session()
    assert session.on_transition_event(_fall(confidence=0.3)) is None


def test_escalation_cannot_be_downgraded_by_mimo() -> None:
    normal_payload = {
        "state": "normal",
        "risk_level": 0,
        "privacy_mode": "skeleton_only",
        "need_dialogue": False,
        "dialogue_goal": None,
        "elder_message": None,
        "family_notification": None,
        "action": "none",
        "reason_summary": "看起来一切正常",
    }
    client = MiMoClient("mock", mock_payloads=iter([normal_payload]))
    session = DecisionSession(SCENE_FALL_SILENT, client=client, config=_CONFIG)
    session.on_transition_event(_fall())
    _respond(session, "none", source="timeout")

    late = _respond(session, "need_help", text="现在有点晕。")
    assert late.state == "family_notification_required"  # verdict unchanged
    assert "MiMo 补充" in late.reason_summary  # explanation enriched only


def test_mimo_failure_degrades_to_rule_consent() -> None:
    client = MiMoClient("mock", mock_payloads=iter([]))  # exhausted immediately
    session = DecisionSession(SCENE_NEED_LOOP, client=client, config=_CONFIG)
    opening = session.on_posture_observation(_still(65_000.0, 65_000.0))
    assert opening is not None
    assert opening.fallback_used is True
    assert opening.source == "degraded"

    consent = _respond(session, "need_help", text="牙疼。")
    assert consent.fallback_used is True
    assert consent.state == "consent_required"
    assert consent.consent_required is True


def test_clarification_is_single_shot() -> None:
    client = MiMoClient("mock", mock_payloads=iter([]))
    session = DecisionSession(SCENE_NEED_LOOP, client=client, config=_CONFIG)
    session.on_posture_observation(_still(65_000.0, 65_000.0))
    first = _respond(session, "unclear")
    assert first.state == "check_in_required"  # one clarification allowed
    second = _respond(session, "unclear")
    assert second.state == "observe"  # then stop asking


def test_stale_decision_id_rejected() -> None:
    session = _fall_session()
    session.on_transition_event(_fall())
    with pytest.raises(ContractError):
        session.on_interaction_response(
            InteractionResponse(
                scene_id=session.scene_id,
                decision_id="decision-9999",
                timestamp_ms=1.0,
                response="safe",
                source="user_input",
                demo_mode=session.demo_mode,
            )
        )
