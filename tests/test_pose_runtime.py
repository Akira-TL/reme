from pathlib import Path

import pytest
from reme.pose.runtime import (
    Component,
    ModeProfile,
    RuntimeEvent,
    RuntimeEventType,
    RuntimeSessionError,
    RuntimeSessionRequest,
    RuntimeSessionState,
    RuntimeSessionStatus,
    ensure_new_session,
)


def test_live_camera_profile_derives_real_runtime_modes() -> None:
    request = RuntimeSessionRequest(
        session_id="session-live-001",
        profile=ModeProfile.LIVE_CAMERA,
        scene_id="live-camera-001",
        camera_id="default",
    )

    assert request.to_payload() == {
        "schema_version": "reme-runtime-session-request/v0-experiment",
        "session_id": "session-live-001",
        "profile": "live_camera",
        "scene_id": "live-camera-001",
        "input_source": "camera",
        "perception_mode": "live",
        "decision_mode": "live",
        "camera_id": "default",
        "manifest_path": None,
    }


def test_recorded_video_profile_requires_manifest_and_derives_recorded_modes(
    tmp_path: Path,
) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text("{}", encoding="utf-8")

    request = RuntimeSessionRequest(
        session_id="session-video-001",
        profile=ModeProfile.RECORDED_VIDEO,
        scene_id="video-demo-001",
        manifest_path=manifest,
    )

    payload = request.to_payload()
    assert payload["input_source"] == "video"
    assert payload["perception_mode"] == "recorded"
    assert payload["decision_mode"] == "recorded"
    assert payload["manifest_path"] == str(manifest)


def test_recorded_video_profile_rejects_missing_manifest() -> None:
    with pytest.raises(RuntimeSessionError, match="manifest_path"):
        RuntimeSessionRequest(
            session_id="session-video-001",
            profile=ModeProfile.RECORDED_VIDEO,
            scene_id="video-demo-001",
        )


def test_running_component_cannot_silently_change_profile() -> None:
    with pytest.raises(RuntimeSessionError, match="effective_profile"):
        RuntimeSessionStatus(
            session_id="session-live-001",
            component=Component.PERCEPTION,
            requested_profile=ModeProfile.LIVE_CAMERA,
            effective_profile=ModeProfile.RECORDED_VIDEO,
            state=RuntimeSessionState.RUNNING,
        )


def test_degraded_component_requires_reason_and_does_not_fake_running() -> None:
    status = RuntimeSessionStatus(
        session_id="session-live-001",
        component=Component.DECISION,
        requested_profile=ModeProfile.LIVE_CAMERA,
        effective_profile=None,
        state=RuntimeSessionState.DEGRADED,
        reason="MiMo request timed out",
    )

    assert status.to_payload()["state"] == "degraded"
    assert status.to_payload()["reason"] == "MiMo request timed out"


def test_runtime_event_rejects_data_from_previous_session() -> None:
    event = RuntimeEvent(
        session_id="session-old",
        sequence=12,
        event_type=RuntimeEventType.POSTURE_OBSERVATION,
        payload={"posture": "standing"},
    )

    with pytest.raises(RuntimeSessionError, match="stale session"):
        event.require_session("session-current")


def test_switching_profile_requires_new_session_id() -> None:
    previous = RuntimeSessionRequest(
        session_id="session-001",
        profile=ModeProfile.LIVE_CAMERA,
        scene_id="live-camera-001",
        camera_id="default",
    )
    next_request = RuntimeSessionRequest(
        session_id="session-001",
        profile=ModeProfile.RECORDED_VIDEO,
        scene_id="video-demo-001",
        manifest_path=Path("demo/manifest.json"),
    )

    with pytest.raises(RuntimeSessionError, match="new session_id"):
        ensure_new_session(previous, next_request)


def test_restarting_same_profile_requires_new_session_id() -> None:
    previous = RuntimeSessionRequest(
        session_id="session-001",
        profile=ModeProfile.LIVE_CAMERA,
        scene_id="live-camera-001",
        camera_id="default",
    )
    restarted = RuntimeSessionRequest(
        session_id="session-001",
        profile=ModeProfile.LIVE_CAMERA,
        scene_id="live-camera-002",
        camera_id="default",
    )

    with pytest.raises(RuntimeSessionError, match="new session_id"):
        ensure_new_session(previous, restarted)
