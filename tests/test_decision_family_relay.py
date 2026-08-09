from __future__ import annotations

import json
import threading
from typing import Any

from reme.runtime.decision.authorization import MediaAuthorization, MediaAuthorizationScope
from reme.runtime.decision.family_event import family_event_from_decision
from reme.runtime.decision.family_relay import FamilyRelayConfig, FamilyRelayPublisher
from reme.runtime.decision.records import (
    ActionCard,
    AlarmSignal,
    AlarmTrigger,
    CardStatus,
    CareDecision,
    DecisionAction,
    DecisionSource,
    DecisionState,
    DemoMode,
    PrivacyMode,
    Uncertainty,
    VisualContext,
    VisualContextType,
)


class _Registry:
    def __init__(self, session_id: str | None = "runtime-1") -> None:
        self.session_id = session_id

    def active_session_id(self) -> str | None:
        return self.session_id


def _decision(**overrides: Any) -> CareDecision:
    authorization = MediaAuthorization(
        authorization_id="authorization-decision-42",
        decision_id="decision-42",
        scene_id="fall",
        scope=MediaAuthorizationScope.FALL_EMERGENCY,
        issued_at_ms=1_000,
        expires_at_ms=31_000,
        event_id="transition-9",
    )
    values: dict[str, Any] = {
        "scene_id": "fall",
        "decision_id": "decision-42",
        "timestamp_ms": 12_300.0,
        "state": DecisionState.FAMILY_NOTIFICATION_REQUIRED,
        "risk_level": 3,
        "privacy_mode": PrivacyMode.BLURRED,
        "need_dialogue": False,
        "dialogue_goal": None,
        "elder_message": None,
        "family_notification": "请尽快联系或前往查看。",
        "action": DecisionAction.NOTIFY_FAMILY,
        "reason_summary": "跌倒询问超时",
        "uncertainty": Uncertainty.HIGH,
        "fallback_used": False,
        "source": DecisionSource.RULE,
        "demo_mode": DemoMode.LIVE,
        "alarm": AlarmSignal(
            channels=("vibrate", "ring", "flash"),
            trigger=AlarmTrigger.CHECK_IN_TIMEOUT,
        ),
        "media_authorization": authorization,
        "visual_context": VisualContext(
            sent_to_mimo=True,
            type=VisualContextType.KEYFRAMES,
            start_ms=11_000.0,
            end_ms=12_000.0,
            sample_count=2,
        ),
    }
    values.update(overrides)
    return CareDecision(**values)


def test_family_event_is_minimized_and_redacts_elder_quote_by_default() -> None:
    card = ActionCard(
        event="老人反馈牙疼",
        elder_quote="牙疼，饭咬不动。",
        system_judgment="影响进食，建议家属关注",
        suggested_action="预约口腔科",
        time_window="3 天内",
        status=CardStatus.PENDING,
    )
    decision = _decision(
        scene_id="kitchen",
        decision_id="decision-card",
        state=DecisionState.FAMILY_NOTIFICATION_REQUIRED,
        privacy_mode=PrivacyMode.BLURRED,
        action_card=card,
        alarm=None,
        media_authorization=None,
        visual_context=VisualContext(
            sent_to_mimo=True,
            type=VisualContextType.KEYFRAMES,
            start_ms=1.0,
            end_ms=2.0,
            sample_count=1,
        ),
    )
    event = family_event_from_decision(
        decision,
        runtime_session_id="runtime-1",
        revision=7,
        published_at_ms=99_000,
    ).to_payload()

    assert event["runtime_session_id"] == "runtime-1"
    assert event["revision"] == 7
    assert event["care"]["decision_id"] == "decision-card"
    assert "elder_quote" not in event["care"]["action_card"]
    serialized = json.dumps(event, ensure_ascii=False)
    assert "visual_context" not in serialized
    assert "elder_message" not in serialized
    assert "confirm_channels" not in serialized
    assert "posture" not in serialized
    assert "landmark" not in serialized


def test_family_event_can_include_elder_quote_only_when_explicitly_enabled() -> None:
    card = ActionCard(
        event="老人反馈牙疼",
        elder_quote="牙疼，饭咬不动。",
        system_judgment="影响进食，建议家属关注",
        suggested_action="预约口腔科",
        time_window="3 天内",
        status=CardStatus.PENDING,
    )
    decision = _decision(
        scene_id="kitchen",
        decision_id="decision-card",
        action_card=card,
        alarm=None,
        media_authorization=None,
    )
    event = family_event_from_decision(
        decision,
        runtime_session_id="runtime-1",
        revision=1,
        published_at_ms=1,
        include_elder_quote=True,
    )
    assert event.care["action_card"]["elder_quote"] == "牙疼，饭咬不动。"


def test_family_relay_publisher_sends_authoritative_revisions_with_bearer_token() -> None:
    registry = _Registry()
    delivered: list[tuple[dict[str, Any], dict[str, str]]] = []
    delivered_event = threading.Event()

    def transport(request: Any, _timeout: float) -> bytes:
        delivered.append((
            json.loads(request.data.decode("utf-8")),
            {key.lower(): value for key, value in request.header_items()},
        ))
        delivered_event.set()
        return b"{}"

    publisher = FamilyRelayPublisher(
        registry=registry,  # type: ignore[arg-type]
        config=FamilyRelayConfig(
            endpoint="https://relay.example/api/runtime/event",
            token="runtime-secret",
        ),
        transport=transport,
        wall_clock=lambda: 100.0,
    )
    publisher.publish_decision(_decision(decision_id="decision-42"))
    assert delivered_event.wait(1.0)
    delivered_event.clear()
    publisher.publish_decision(_decision(
        decision_id="decision-43",
        media_authorization=MediaAuthorization(
            authorization_id="authorization-decision-43",
            decision_id="decision-43",
            scene_id="fall",
            scope=MediaAuthorizationScope.FALL_EMERGENCY,
            issued_at_ms=1_000,
            expires_at_ms=31_000,
            event_id="transition-9",
        ),
    ))
    assert delivered_event.wait(1.0)
    publisher.close()

    assert [item[0]["revision"] for item in delivered] == [1, 2]
    assert [item[0]["care"]["decision_id"] for item in delivered] == [
        "decision-42",
        "decision-43",
    ]
    assert delivered[0][1]["authorization"] == "Bearer runtime-secret"
    assert delivered[0][1]["content-type"] == "application/json"


def test_family_relay_publisher_retries_latest_state_after_temporary_outage() -> None:
    registry = _Registry()
    attempts: list[int] = []
    delivered: list[dict[str, Any]] = []
    success = threading.Event()

    def transport(request: Any, _timeout: float) -> bytes:
        attempts.append(len(attempts) + 1)
        if len(attempts) <= 3:
            raise OSError("relay temporarily unavailable")
        delivered.append(json.loads(request.data.decode("utf-8")))
        success.set()
        return b"{}"

    publisher = FamilyRelayPublisher(
        registry=registry,  # type: ignore[arg-type]
        config=FamilyRelayConfig(
            endpoint="https://relay.example/api/runtime/event",
            token="runtime-secret",
            max_attempts=1,
            retry_delay_seconds=0.01,
        ),
        transport=transport,
    )
    publisher.publish_decision(_decision())
    assert success.wait(1.0)
    publisher.close()

    assert len(attempts) >= 4
    assert [item["revision"] for item in delivered] == [1]
    assert delivered[0]["care"]["decision_id"] == "decision-42"


def test_family_relay_publisher_does_nothing_without_active_runtime_session() -> None:
    registry = _Registry(session_id=None)
    calls: list[object] = []

    def transport(request: Any, _timeout: float) -> bytes:
        calls.append(request)
        return b"{}"

    publisher = FamilyRelayPublisher(
        registry=registry,  # type: ignore[arg-type]
        config=FamilyRelayConfig(
            endpoint="https://relay.example/api/runtime/event",
            token="runtime-secret",
        ),
        transport=transport,
    )
    publisher.publish_decision(_decision())
    publisher.close()
    assert calls == []
