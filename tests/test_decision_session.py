"""Contract tests for B's runtime session registry (single active session)."""

from __future__ import annotations

from pathlib import Path

import pytest
from reme.decision.session import (
    RuntimeSessionRegistry,
    SessionRegistryError,
    parse_session_request,
)
from reme.pose.runtime import (
    Component,
    ModeProfile,
    RuntimeSessionRequest,
    RuntimeSessionState,
)


def _live_request(
    *,
    session_id: str = "session-live-001",
    scene_id: str = "live-camera-001",
    camera_id: str = "default",
) -> RuntimeSessionRequest:
    return RuntimeSessionRequest(
        session_id=session_id,
        profile=ModeProfile.LIVE_CAMERA,
        scene_id=scene_id,
        camera_id=camera_id,
    )


def _recorded_request(
    *,
    session_id: str = "session-video-001",
    scene_id: str = "video-demo-001",
    manifest_path: Path = Path("demo/manifest.json"),
) -> RuntimeSessionRequest:
    return RuntimeSessionRequest(
        session_id=session_id,
        profile=ModeProfile.RECORDED_VIDEO,
        scene_id=scene_id,
        manifest_path=manifest_path,
    )


def test_start_returns_running_status_for_the_decision_component() -> None:
    registry = RuntimeSessionRegistry()

    status = registry.start(_live_request())

    assert status.component is Component.DECISION
    assert status.state is RuntimeSessionState.RUNNING
    assert status.effective_profile is ModeProfile.LIVE_CAMERA
    assert status.reason is None
    assert registry.active_session_id() == "session-live-001"
    assert registry.is_active("session-live-001")
    assert not registry.is_active("session-live-002")


def test_second_start_without_stop_conflicts() -> None:
    registry = RuntimeSessionRegistry()
    registry.start(_live_request())

    with pytest.raises(SessionRegistryError, match="still active") as excinfo:
        registry.start(_recorded_request())

    assert excinfo.value.code == "session_conflict"
    assert registry.active_session_id() == "session-live-001"


def test_replace_active_atomically_takes_over_stale_browser_session() -> None:
    registry = RuntimeSessionRegistry()
    registry.start(_live_request(session_id="session-stale", scene_id="fall"))
    registry.next_sequence("session-stale")

    previous_id, status = registry.replace_active(
        _live_request(session_id="session-fresh", scene_id="kitchen")
    )

    assert previous_id == "session-stale"
    assert status.session_id == "session-fresh"
    assert status.state is RuntimeSessionState.RUNNING
    assert registry.active_session_id() == "session-fresh"
    assert registry.active_scene_id() == "kitchen"
    assert registry.next_sequence("session-fresh") == 1
    assert not registry.is_active("session-stale")


def test_restarting_the_same_session_id_after_stop_is_rejected() -> None:
    registry = RuntimeSessionRegistry()
    registry.start(_live_request())
    registry.stop("session-live-001")

    with pytest.raises(SessionRegistryError, match="new session_id") as excinfo:
        registry.start(_recorded_request(session_id="session-live-001"))

    assert excinfo.value.code == "session_conflict"
    assert registry.active_session_id() is None


def test_a_fresh_session_id_can_start_after_stop() -> None:
    registry = RuntimeSessionRegistry()
    registry.start(_live_request())
    registry.stop("session-live-001")

    status = registry.start(_recorded_request(session_id="session-video-002"))

    assert status.state is RuntimeSessionState.RUNNING
    assert status.requested_profile is ModeProfile.RECORDED_VIDEO
    assert registry.active_session_id() == "session-video-002"


def test_stop_is_idempotent() -> None:
    registry = RuntimeSessionRegistry()
    registry.start(_live_request())

    first = registry.stop("session-live-001")
    second = registry.stop("session-live-001")

    assert first.state is RuntimeSessionState.STOPPED
    assert first == second
    assert registry.active_session_id() is None
    assert not registry.is_active("session-live-001")


def test_stopping_an_unknown_session_id_raises_unknown_session() -> None:
    registry = RuntimeSessionRegistry()

    with pytest.raises(SessionRegistryError, match="unknown session") as before:
        registry.stop("session-live-001")
    assert before.value.code == "unknown_session"

    registry.start(_live_request())
    with pytest.raises(SessionRegistryError, match="unknown session") as during:
        registry.stop("session-live-999")
    assert during.value.code == "unknown_session"
    assert registry.active_session_id() == "session-live-001"


def test_switch_scene_keeps_session_and_sequence_active() -> None:
    registry = RuntimeSessionRegistry()
    registry.start(_live_request(scene_id="fall"))
    assert registry.next_sequence("session-live-001") == 1

    status = registry.switch_scene("session-live-001", "kitchen")

    assert status.state is RuntimeSessionState.RUNNING
    assert registry.active_session_id() == "session-live-001"
    assert registry.active_scene_id() == "kitchen"
    assert registry.next_sequence("session-live-001") == 2


def test_switch_scene_rejects_unknown_session_and_empty_scene() -> None:
    registry = RuntimeSessionRegistry()
    registry.start(_live_request(scene_id="fall"))

    with pytest.raises(SessionRegistryError) as unknown:
        registry.switch_scene("session-live-999", "kitchen")
    assert unknown.value.code == "unknown_session"

    with pytest.raises(SessionRegistryError) as empty:
        registry.switch_scene("session-live-001", "   ")
    assert empty.value.code == "bad_request"
    assert registry.active_scene_id() == "fall"


def test_next_sequence_increments_and_resets_for_a_new_session() -> None:
    registry = RuntimeSessionRegistry()
    registry.start(_live_request())

    assert registry.next_sequence("session-live-001") == 1
    assert registry.next_sequence("session-live-001") == 2
    assert registry.next_sequence("session-live-001") == 3

    registry.stop("session-live-001")
    registry.start(_live_request(session_id="session-live-002"))

    assert registry.next_sequence("session-live-002") == 1


def test_next_sequence_rejects_stopped_and_foreign_sessions() -> None:
    registry = RuntimeSessionRegistry()
    registry.start(_live_request())
    registry.next_sequence("session-live-001")
    registry.stop("session-live-001")

    with pytest.raises(SessionRegistryError, match="not the active session") as stopped:
        registry.next_sequence("session-live-001")
    assert stopped.value.code == "unknown_session"

    registry.start(_live_request(session_id="session-live-002"))
    with pytest.raises(SessionRegistryError, match="not the active session") as foreign:
        registry.next_sequence("session-live-001")
    assert foreign.value.code == "unknown_session"


def test_mark_degraded_keeps_the_session_active_with_a_reason() -> None:
    registry = RuntimeSessionRegistry()
    registry.start(_live_request())

    status = registry.mark_degraded("MiMo request timed out")

    assert status.state is RuntimeSessionState.DEGRADED
    assert status.reason == "MiMo request timed out"
    assert status.requested_profile is ModeProfile.LIVE_CAMERA
    assert status.effective_profile is None
    assert registry.is_active("session-live-001")
    assert registry.next_sequence("session-live-001") == 1
    assert registry.stop("session-live-001").state is RuntimeSessionState.STOPPED


def test_mark_degraded_without_an_active_session_raises_unknown_session() -> None:
    registry = RuntimeSessionRegistry()

    with pytest.raises(SessionRegistryError, match="no active session") as excinfo:
        registry.mark_degraded("MiMo request timed out")

    assert excinfo.value.code == "unknown_session"


def test_current_status_tracks_the_session_lifecycle() -> None:
    registry = RuntimeSessionRegistry()
    assert registry.current_status() is None

    registry.start(_live_request())
    running = registry.current_status()
    assert running is not None and running.state is RuntimeSessionState.RUNNING

    registry.mark_degraded("MiMo request timed out")
    degraded = registry.current_status()
    assert degraded is not None and degraded.state is RuntimeSessionState.DEGRADED

    registry.stop("session-live-001")
    stopped = registry.current_status()
    assert stopped is not None and stopped.state is RuntimeSessionState.STOPPED
    assert stopped.session_id == "session-live-001"


def test_parse_session_request_accepts_a_live_camera_payload() -> None:
    request = parse_session_request(
        {
            "schema_version": "reme-runtime-session-request/v0-experiment",
            "session_id": "session-live-001",
            "profile": "live_camera",
            "scene_id": "live-camera-001",
            "camera_id": "default",
        }
    )

    assert request.profile is ModeProfile.LIVE_CAMERA
    assert request.camera_id == "default"
    assert request.manifest_path is None
    assert request.to_payload()["decision_mode"] == "live"


def test_parse_session_request_rejects_a_contradicting_derived_field() -> None:
    # Wording comes from A's official from_payload now that B delegates to it;
    # what B guarantees is the rejection and the machine-readable code.
    with pytest.raises(SessionRegistryError, match="decision_mode") as excinfo:
        parse_session_request(
            {
                "session_id": "session-live-001",
                "profile": "live_camera",
                "scene_id": "live-camera-001",
                "camera_id": "default",
                "decision_mode": "recorded",
            }
        )

    assert excinfo.value.code == "bad_request"
