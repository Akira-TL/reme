from typing import Any

import pytest
from reme.decision.context import (
    POSTURE_SCHEMA_VERSION,
    TRANSITION_SCHEMA_VERSION,
    build_decision_context,
)
from reme.decision.stream import EVENT_SCHEMA_VERSION, EventIngest, IngestError
from reme.runtime.perception.runtime import RuntimeEventType

SESSION_ID = "session-1"
SCENE_ID = "live-camera-1"


def _envelope(
    *,
    event_type: str,
    payload: object,
    session_id: str = SESSION_ID,
    sequence: int = 0,
    schema_version: str = EVENT_SCHEMA_VERSION,
) -> dict[str, Any]:
    return {
        "schema_version": schema_version,
        "session_id": session_id,
        "sequence": sequence,
        "event_type": event_type,
        "payload": payload,
    }


def _posture_event(
    *,
    sequence: int = 0,
    session_id: str = SESSION_ID,
    scene_id: str = SCENE_ID,
    timestamp_ms: float = 1000.0,
    posture: str = "standing",
    posture_duration_ms: float = 2500.0,
    person_detected: bool = True,
    drop_fields: tuple[str, ...] = (),
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema_version": POSTURE_SCHEMA_VERSION,
        "scene_id": scene_id,
        "timestamp_ms": timestamp_ms,
        "person_detected": person_detected,
        "posture": posture,
        "posture_confidence": 0.82,
        "posture_duration_ms": posture_duration_ms,
        "motion_level": "still",
        "landmark_quality": "usable",
    }
    for field in drop_fields:
        payload.pop(field, None)
    return _envelope(
        event_type=RuntimeEventType.POSTURE_OBSERVATION.value,
        payload=payload,
        session_id=session_id,
        sequence=sequence,
    )


def _transition_event(
    *,
    sequence: int = 0,
    session_id: str = SESSION_ID,
    scene_id: str = SCENE_ID,
    event_id: str = "transition-1",
    start_ms: float = 4000.0,
    end_ms: float = 4800.0,
    transition: str = "fall_like_transition",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema_version": TRANSITION_SCHEMA_VERSION,
        "scene_id": scene_id,
        "event_id": event_id,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "transition": transition,
        "transition_confidence": 0.71,
        "evidence": {"vertical_drop_norm": 0.34},
        "landmark_quality": "usable",
    }
    return _envelope(
        event_type=RuntimeEventType.TRANSITION_EVENT.value,
        payload=payload,
        session_id=session_id,
        sequence=sequence,
    )


def test_posture_event_is_buffered_and_visible_in_snapshot() -> None:
    ingest = EventIngest()

    event = ingest.submit(
        _posture_event(sequence=7, posture="lying", posture_duration_ms=9000.0),
        active_session_id=SESSION_ID,
    )

    assert event.event_type is RuntimeEventType.POSTURE_OBSERVATION
    assert event.sequence == 7
    streams = ingest.snapshot(SCENE_ID)
    assert streams.scene_id == SCENE_ID
    assert len(streams.postures) == 1
    observation = streams.postures[0]
    assert observation.posture.value == "lying"
    assert observation.posture_duration_ms == 9000.0
    assert observation.timestamp_ms == 1000.0
    assert streams.transitions == ()


def test_transition_event_is_buffered_and_visible_in_snapshot() -> None:
    ingest = EventIngest()

    ingest.submit(_transition_event(), active_session_id=SESSION_ID)

    streams = ingest.snapshot(SCENE_ID)
    assert len(streams.transitions) == 1
    transition = streams.transitions[0]
    assert transition.event_id == "transition-1"
    assert transition.transition.value == "fall_like_transition"
    assert transition.start_ms == 4000.0
    assert streams.postures == ()


def test_submit_without_active_session_is_rejected() -> None:
    ingest = EventIngest()

    with pytest.raises(IngestError) as excinfo:
        ingest.submit(_posture_event(), active_session_id=None)

    assert excinfo.value.code == "no_active_session"
    assert ingest.snapshot(SCENE_ID).postures == ()


def test_event_from_a_previous_session_is_rejected() -> None:
    ingest = EventIngest()

    with pytest.raises(IngestError) as excinfo:
        ingest.submit(_posture_event(session_id="session-0"), active_session_id=SESSION_ID)

    assert excinfo.value.code == "stale_session"
    assert ingest.snapshot(SCENE_ID).postures == ()


def test_non_object_envelope_is_rejected() -> None:
    ingest = EventIngest()

    with pytest.raises(IngestError) as excinfo:
        ingest.submit(["not", "an", "object"], active_session_id=SESSION_ID)

    assert excinfo.value.code == "bad_event"


def test_unknown_envelope_schema_version_is_rejected() -> None:
    ingest = EventIngest()
    envelope = _posture_event()
    envelope["schema_version"] = "reme-runtime-event/v9-nope"

    with pytest.raises(IngestError) as excinfo:
        ingest.submit(envelope, active_session_id=SESSION_ID)

    assert excinfo.value.code == "bad_event"


def test_unknown_event_type_is_rejected() -> None:
    ingest = EventIngest()

    with pytest.raises(IngestError) as excinfo:
        ingest.submit(
            _envelope(event_type="posture_guess", payload={}),
            active_session_id=SESSION_ID,
        )

    assert excinfo.value.code == "bad_event"


def test_incomplete_posture_payload_is_rejected() -> None:
    ingest = EventIngest()

    with pytest.raises(IngestError) as excinfo:
        ingest.submit(
            _posture_event(drop_fields=("posture_confidence",)),
            active_session_id=SESSION_ID,
        )

    assert excinfo.value.code == "bad_event"
    assert "posture_confidence" in str(excinfo.value)
    assert ingest.snapshot(SCENE_ID).postures == ()


def test_ignored_event_types_are_accepted_but_not_buffered() -> None:
    ingest = EventIngest()

    event = ingest.submit(
        _envelope(
            event_type=RuntimeEventType.CARE_DECISION.value,
            payload={"scene_id": SCENE_ID, "action": "check_in"},
            sequence=3,
        ),
        active_session_id=SESSION_ID,
    )

    assert event.event_type is RuntimeEventType.CARE_DECISION
    streams = ingest.snapshot(SCENE_ID)
    assert streams.postures == ()
    assert streams.transitions == ()


def test_posture_timestamp_regression_is_rejected() -> None:
    ingest = EventIngest()
    ingest.submit(_posture_event(sequence=1, timestamp_ms=2000.0), active_session_id=SESSION_ID)

    with pytest.raises(IngestError) as excinfo:
        ingest.submit(_posture_event(sequence=2, timestamp_ms=1999.0), active_session_id=SESSION_ID)

    assert excinfo.value.code == "bad_event"
    assert "reset" in str(excinfo.value)
    assert len(ingest.snapshot(SCENE_ID).postures) == 1


def test_transition_start_regression_is_rejected() -> None:
    ingest = EventIngest()
    ingest.submit(
        _transition_event(sequence=1, event_id="transition-1", start_ms=5000.0, end_ms=5400.0),
        active_session_id=SESSION_ID,
    )

    with pytest.raises(IngestError) as excinfo:
        ingest.submit(
            _transition_event(sequence=2, event_id="transition-2", start_ms=4000.0, end_ms=4200.0),
            active_session_id=SESSION_ID,
        )

    assert excinfo.value.code == "bad_event"
    assert len(ingest.snapshot(SCENE_ID).transitions) == 1


def test_bounded_buffer_evicts_the_oldest_observation() -> None:
    ingest = EventIngest(max_events_per_scene=3)
    for index in range(4):
        ingest.submit(
            _posture_event(sequence=index, timestamp_ms=1000.0 * index),
            active_session_id=SESSION_ID,
        )

    postures = ingest.snapshot(SCENE_ID).postures
    assert [observation.timestamp_ms for observation in postures] == [1000.0, 2000.0, 3000.0]


def test_scenes_are_buffered_independently() -> None:
    ingest = EventIngest()
    ingest.submit(
        _posture_event(sequence=1, scene_id="scene-a", timestamp_ms=5000.0),
        active_session_id=SESSION_ID,
    )
    ingest.submit(
        _posture_event(sequence=2, scene_id="scene-b", timestamp_ms=10.0),
        active_session_id=SESSION_ID,
    )

    assert len(ingest.snapshot("scene-a").postures) == 1
    assert len(ingest.snapshot("scene-b").postures) == 1
    unknown = ingest.snapshot("scene-c")
    assert unknown.scene_id == "scene-c"
    assert unknown.postures == ()
    assert unknown.transitions == ()


def test_reset_scene_clears_the_snapshot_and_allows_replay() -> None:
    ingest = EventIngest()
    ingest.submit(_posture_event(sequence=1, timestamp_ms=8000.0), active_session_id=SESSION_ID)
    ingest.submit(_transition_event(sequence=2), active_session_id=SESSION_ID)

    ingest.reset_scene(SCENE_ID)

    streams = ingest.snapshot(SCENE_ID)
    assert streams.postures == ()
    assert streams.transitions == ()
    ingest.submit(_posture_event(sequence=3, timestamp_ms=10.0), active_session_id=SESSION_ID)
    assert len(ingest.snapshot(SCENE_ID).postures) == 1


def test_live_streams_duck_align_with_build_decision_context() -> None:
    # LiveStreams is not a SceneStreams subclass; build_decision_context only reads
    # .scene_id/.postures/.transitions. Widening its annotation is L-integration's job.
    ingest = EventIngest()
    ingest.submit(
        _posture_event(sequence=1, timestamp_ms=1000.0, posture="lying"),
        active_session_id=SESSION_ID,
    )
    ingest.submit(
        _transition_event(sequence=2, start_ms=1500.0, end_ms=1800.0),
        active_session_id=SESSION_ID,
    )

    context = build_decision_context(ingest.snapshot(SCENE_ID), timestamp_ms=2000.0)

    assert context.scene_id == SCENE_ID
    assert context.latest_posture is not None
    assert context.latest_posture.posture.value == "lying"
    assert context.active_transition is not None
    assert context.input_quality.value == "usable"


def test_reset_all_drops_every_scene() -> None:
    ingest = EventIngest()
    ingest.submit(_posture_event(sequence=1, scene_id="scene-a"), active_session_id=SESSION_ID)
    ingest.submit(_posture_event(sequence=2, scene_id="scene-b"), active_session_id=SESSION_ID)

    ingest.reset_all()

    assert ingest.snapshot("scene-a").postures == ()
    assert ingest.snapshot("scene-b").postures == ()


def test_duplicate_or_reordered_sequence_is_rejected() -> None:
    ingest = EventIngest()
    ingest.submit(_posture_event(sequence=5, timestamp_ms=1000.0), active_session_id=SESSION_ID)
    with pytest.raises(IngestError, match="strictly increasing") as duplicate:
        ingest.submit(_posture_event(sequence=5, timestamp_ms=2000.0), active_session_id=SESSION_ID)
    assert duplicate.value.code == "bad_event"
    with pytest.raises(IngestError, match="strictly increasing"):
        ingest.submit(_posture_event(sequence=4, timestamp_ms=3000.0), active_session_id=SESSION_ID)
    ingest.reset_all()
    ingest.submit(_posture_event(sequence=1, timestamp_ms=4000.0), active_session_id=SESSION_ID)


def test_same_sequence_posture_and_transition_are_both_accepted() -> None:
    # A derives PostureObservation and TransitionEvent from one frame and reuses
    # that frame's sequence for both; a session-wide watermark dropped the
    # transition -- i.e. dropped the fall signal.
    ingest = EventIngest()

    ingest.submit(_posture_event(sequence=42, timestamp_ms=7000.0), active_session_id=SESSION_ID)
    ingest.submit(
        _transition_event(sequence=42, start_ms=6800.0, end_ms=7000.0),
        active_session_id=SESSION_ID,
    )

    streams = ingest.snapshot(SCENE_ID)
    assert len(streams.postures) == 1
    assert len(streams.transitions) == 1
    assert streams.transitions[0].transition.value == "fall_like_transition"


def test_same_sequence_frame_landmarks_do_not_block_derived_events() -> None:
    # The unbuffered FrameLandmarks event carries the same sequence as the two
    # events derived from it; it must not consume the sequence for them.
    ingest = EventIngest()

    ingest.submit(
        _envelope(
            event_type=RuntimeEventType.FRAME_LANDMARKS.value,
            payload={"scene_id": SCENE_ID, "frame_index": 9},
            sequence=9,
        ),
        active_session_id=SESSION_ID,
    )
    ingest.submit(_posture_event(sequence=9, timestamp_ms=3000.0), active_session_id=SESSION_ID)
    ingest.submit(
        _transition_event(sequence=9, start_ms=2900.0, end_ms=3000.0),
        active_session_id=SESSION_ID,
    )

    streams = ingest.snapshot(SCENE_ID)
    assert len(streams.postures) == 1
    assert len(streams.transitions) == 1


def test_duplicate_transition_at_the_same_sequence_is_rejected() -> None:
    ingest = EventIngest()
    ingest.submit(_posture_event(sequence=11, timestamp_ms=5000.0), active_session_id=SESSION_ID)
    ingest.submit(
        _transition_event(sequence=11, event_id="transition-1", start_ms=4900.0, end_ms=5000.0),
        active_session_id=SESSION_ID,
    )

    with pytest.raises(IngestError, match="strictly increasing") as excinfo:
        ingest.submit(
            _transition_event(sequence=11, event_id="transition-2", start_ms=5000.0, end_ms=5100.0),
            active_session_id=SESSION_ID,
        )

    assert excinfo.value.code == "bad_event"
    assert len(ingest.snapshot(SCENE_ID).transitions) == 1


def test_duplicate_posture_at_the_same_sequence_is_rejected() -> None:
    # A replayed posture would pollute the behavior window and memory baseline.
    ingest = EventIngest()
    ingest.submit(_posture_event(sequence=11, timestamp_ms=5000.0), active_session_id=SESSION_ID)
    ingest.submit(
        _transition_event(sequence=11, start_ms=4900.0, end_ms=5000.0),
        active_session_id=SESSION_ID,
    )

    with pytest.raises(IngestError, match="strictly increasing") as excinfo:
        ingest.submit(
            _posture_event(sequence=11, timestamp_ms=5000.0), active_session_id=SESSION_ID
        )

    assert excinfo.value.code == "bad_event"
    assert len(ingest.snapshot(SCENE_ID).postures) == 1


def test_reordering_within_one_event_type_is_still_rejected() -> None:
    ingest = EventIngest()
    ingest.submit(
        _transition_event(sequence=8, event_id="transition-1", start_ms=1000.0, end_ms=1200.0),
        active_session_id=SESSION_ID,
    )
    ingest.submit(_posture_event(sequence=9, timestamp_ms=2000.0), active_session_id=SESSION_ID)

    with pytest.raises(IngestError, match="strictly increasing") as excinfo:
        ingest.submit(
            _transition_event(sequence=7, event_id="transition-0", start_ms=1300.0, end_ms=1400.0),
            active_session_id=SESSION_ID,
        )

    assert excinfo.value.code == "bad_event"
    assert len(ingest.snapshot(SCENE_ID).transitions) == 1


def test_stale_session_is_rejected_regardless_of_event_type() -> None:
    ingest = EventIngest()
    ingest.submit(_posture_event(sequence=3, timestamp_ms=1000.0), active_session_id=SESSION_ID)

    with pytest.raises(IngestError) as excinfo:
        ingest.submit(
            _transition_event(sequence=3, session_id="session-0"),
            active_session_id=SESSION_ID,
        )

    assert excinfo.value.code == "stale_session"
    assert ingest.snapshot(SCENE_ID).transitions == ()


def test_reset_all_clears_every_per_event_type_watermark() -> None:
    ingest = EventIngest()
    ingest.submit(_posture_event(sequence=50, timestamp_ms=9000.0), active_session_id=SESSION_ID)
    ingest.submit(
        _transition_event(sequence=50, start_ms=8900.0, end_ms=9000.0),
        active_session_id=SESSION_ID,
    )

    ingest.reset_all()

    ingest.submit(_posture_event(sequence=1, timestamp_ms=10.0), active_session_id=SESSION_ID)
    ingest.submit(
        _transition_event(sequence=1, start_ms=10.0, end_ms=20.0), active_session_id=SESSION_ID
    )
    streams = ingest.snapshot(SCENE_ID)
    assert len(streams.postures) == 1
    assert len(streams.transitions) == 1


def test_watermarks_are_tracked_per_session() -> None:
    ingest = EventIngest()
    ingest.submit(_posture_event(sequence=9, timestamp_ms=1000.0), active_session_id=SESSION_ID)

    # A fresh session keeps its own watermark, so it may restart from zero.
    ingest.submit(
        _posture_event(sequence=0, session_id="session-2", scene_id="scene-b"),
        active_session_id="session-2",
    )

    assert len(ingest.snapshot("scene-b").postures) == 1


# --- Codex R4：跨类型序列回退（per-type 水位单独使用时的漏洞） ---------------


def test_stale_transition_cannot_ride_in_behind_a_newer_posture() -> None:
    """A captured old transition must not slip past on an unseen type's empty watermark."""

    ingest = EventIngest()
    ingest.submit(_posture_event(sequence=100), active_session_id=SESSION_ID)
    # Same session, structurally valid, but from long before the current frame:
    # per-type alone would accept it because transitions had no watermark yet.
    with pytest.raises(IngestError) as excinfo:
        ingest.submit(_transition_event(sequence=50), active_session_id=SESSION_ID)
    assert excinfo.value.code == "bad_event"
    assert "high-water" in str(excinfo.value)


def test_same_frame_events_still_share_one_sequence() -> None:
    """The whole point of per-type watermarks: same-frame derivations coexist."""

    ingest = EventIngest()
    ingest.submit(_posture_event(sequence=7), active_session_id=SESSION_ID)
    event = ingest.submit(_transition_event(sequence=7), active_session_id=SESSION_ID)
    assert event.sequence == 7
