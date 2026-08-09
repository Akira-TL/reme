from __future__ import annotations

from typing import Any

from reme.runtime.decision.family_event import (
    FALL_AUTHORIZATION_TTL_MS,
    KITCHEN_AUTHORIZATION_TTL_MS,
    FamilyEventAuthority,
    RelayFamilyEventTransport,
)
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
    FamilyDelivery,
    PrivacyMode,
    Uncertainty,
)
from reme.runtime.decision.session import RuntimeSessionRegistry
from reme.runtime.perception.runtime import ModeProfile, RuntimeSessionRequest


class _RecordingTransport:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.closed = False

    def submit(self, event: dict[str, Any]) -> None:
        self.events.append(event)

    def close(self) -> None:
        self.closed = True


def _start(registry: RuntimeSessionRegistry, session_id: str, scene_id: str) -> None:
    registry.start(
        RuntimeSessionRequest(
            session_id=session_id,
            profile=ModeProfile.LIVE_CAMERA,
            scene_id=scene_id,
            camera_id="default",
        )
    )


def _decision(**overrides: Any) -> CareDecision:
    fields: dict[str, Any] = {
        "scene_id": "living",
        "decision_id": "decision-1",
        "timestamp_ms": 1_000.0,
        "state": DecisionState.OBSERVE,
        "risk_level": 1,
        "privacy_mode": PrivacyMode.SKELETON_ONLY,
        "need_dialogue": False,
        "dialogue_goal": None,
        "elder_message": None,
        "family_notification": None,
        "action": DecisionAction.OBSERVE,
        "family_delivery": FamilyDelivery.NONE,
        "reason_summary": "保持观察",
        "uncertainty": Uncertainty.MEDIUM,
        "fallback_used": False,
        "source": DecisionSource.RULE,
        "demo_mode": DemoMode.LIVE,
    }
    fields.update(overrides)
    return CareDecision(**fields)


def test_family_event_revision_resets_per_runtime_and_clears_on_reset() -> None:
    registry = RuntimeSessionRegistry()
    transport = _RecordingTransport()
    authority = FamilyEventAuthority(
        registry=registry,
        transport=transport,
        clock_ms=lambda: 10_000,
    )
    _start(registry, "runtime-1", "living")

    assert authority.begin_runtime("runtime-1")["revision"] == 0
    authority.publish_decision(_decision())
    assert transport.events[-1]["revision"] == 1
    assert transport.events[-1]["care"]["decision_id"] == "decision-1"
    assert "elder_message" not in transport.events[-1]["care"]

    authority.reset_scene()
    assert transport.events[-1]["revision"] == 2
    assert transport.events[-1]["care"] is None

    registry.stop("runtime-1")
    _start(registry, "runtime-2", "fall")
    assert authority.begin_runtime("runtime-2")["revision"] == 0
    authority.close()
    assert transport.closed


def test_backend_issues_only_bounded_kitchen_and_fall_authorizations() -> None:
    now_ms = 50_000
    registry = RuntimeSessionRegistry()
    transport = _RecordingTransport()
    authority = FamilyEventAuthority(
        registry=registry,
        transport=transport,
        clock_ms=lambda: now_ms,
    )
    _start(registry, "runtime-kitchen", "kitchen")
    authority.begin_runtime("runtime-kitchen")
    authority.publish_decision(_decision(
        scene_id="kitchen",
        decision_id="decision-kitchen",
        state=DecisionState.RESOLVED,
        risk_level=0,
        action=DecisionAction.NOTIFY_FAMILY,
        family_delivery=FamilyDelivery.NOTIFICATION,
        family_notification="本人同意分享厨房生活片段",
    ))
    kitchen = transport.events[-1]["authorization"]
    assert kitchen["scope"] == "kitchen_moment"
    assert kitchen["event_id"] == "decision-kitchen"
    assert kitchen["expires_at_ms"] - kitchen["issued_at_ms"] == KITCHEN_AUTHORIZATION_TTL_MS

    authority.publish_decision(_decision(scene_id="kitchen", decision_id="decision-observe"))
    assert transport.events[-1]["authorization"]["status"] == "revoked"
    authority.close()

    registry = RuntimeSessionRegistry()
    transport = _RecordingTransport()
    authority = FamilyEventAuthority(
        registry=registry,
        transport=transport,
        clock_ms=lambda: now_ms,
    )
    _start(registry, "runtime-fall", "fall")
    authority.begin_runtime("runtime-fall")
    authority.publish_decision(_decision(
        scene_id="fall",
        decision_id="decision-fall",
        state=DecisionState.FAMILY_NOTIFICATION_REQUIRED,
        risk_level=3,
        action=DecisionAction.NOTIFY_FAMILY,
        family_delivery=FamilyDelivery.ALARM,
        family_notification="疑似跌倒后无回应",
        alarm=AlarmSignal(
            channels=("ring", "vibrate"),
            trigger=AlarmTrigger.CHECK_IN_TIMEOUT,
        ),
    ))
    fall = transport.events[-1]["authorization"]
    assert fall["scope"] == "fall_emergency"
    assert fall["expires_at_ms"] - fall["issued_at_ms"] == FALL_AUTHORIZATION_TTL_MS
    authority.close()


def test_hidden_privacy_and_bathroom_are_hard_authorization_vetoes() -> None:
    registry = RuntimeSessionRegistry()
    transport = _RecordingTransport()
    authority = FamilyEventAuthority(registry=registry, transport=transport)
    _start(registry, "runtime-bathroom", "bathroom")
    authority.begin_runtime("runtime-bathroom")
    authority.publish_decision(_decision(
        scene_id="bathroom",
        privacy_mode=PrivacyMode.HIDDEN,
        decision_id="decision-private",
    ))
    assert transport.events[-1]["authorization"] is None
    authority.close()


def test_public_family_projection_omits_elder_quote_from_action_card() -> None:
    registry = RuntimeSessionRegistry()
    transport = _RecordingTransport()
    authority = FamilyEventAuthority(registry=registry, transport=transport)
    _start(registry, "runtime-living", "living")
    authority.begin_runtime("runtime-living")
    authority.publish_decision(_decision(
        decision_id="decision-card",
        state=DecisionState.FAMILY_NOTIFICATION_REQUIRED,
        risk_level=2,
        action=DecisionAction.NOTIFY_FAMILY,
        family_delivery=FamilyDelivery.ACTION_CARD,
        family_notification="请查看行动卡",
        action_card=ActionCard(
            event="需要家属协助",
            elder_quote="不应进入匿名公开房间",
            system_judgment="普通关怀事件需要安排",
            suggested_action="联系本人并安排后续事项",
            time_window="3 天内",
            status=CardStatus.PENDING,
        ),
    ))

    card = transport.events[-1]["care"]["action_card"]
    assert card == {
        "event": "需要家属协助",
        "system_judgment": "普通关怀事件需要安排",
        "suggested_action": "联系本人并安排后续事项",
        "time_window": "3 天内",
        "status": "pending",
    }
    authority.close()


def test_relay_transport_is_latest_wins_and_rebinds_on_room_change() -> None:
    transport = RelayFamilyEventTransport(
        relay_url="http://relay.test/",
        token="secret",
        autostart=False,
    )
    room = {"value": "room-1"}
    calls: list[tuple[str, str, dict[str, Any] | None]] = []

    def request_json(
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        calls.append((method, path, payload))
        if method == "GET":
            return {
                "schema_version": "reme-backend-relay-context/v1",
                "room_session_id": room["value"],
            }
        assert payload is not None
        return {"accepted_revision": payload["revision"]}

    transport._request_json = request_json  # type: ignore[method-assign]
    transport.submit({
        "schema_version": "reme-family-event/v1",
        "runtime_session_id": "runtime-1",
        "revision": 1,
        "timestamp_ms": 1_000,
        "care": None,
        "authorization": None,
    })
    transport.submit({
        "schema_version": "reme-family-event/v1",
        "runtime_session_id": "runtime-1",
        "revision": 2,
        "timestamp_ms": 2_000,
        "care": None,
        "authorization": None,
    })
    assert transport.deliver_pending_once()
    posts = [call for call in calls if call[0] == "POST"]
    assert len(posts) == 1
    assert posts[0][2] is not None
    assert posts[0][2]["revision"] == 2
    assert posts[0][2]["room_session_id"] == "room-1"

    assert transport.deliver_pending_once()
    assert len([call for call in calls if call[0] == "POST"]) == 1
    room["value"] = "room-2"
    assert transport.deliver_pending_once()
    posts = [call for call in calls if call[0] == "POST"]
    assert len(posts) == 2
    assert posts[-1][2] is not None
    assert posts[-1][2]["room_session_id"] == "room-2"
    transport.close()
