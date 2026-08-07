import json
from pathlib import Path

import pytest
from reme.runtime.perception.annotations import (
    ANNOTATION_SCHEMA_VERSION,
    AnnotationError,
    PoseAnnotations,
    empty_annotations,
    save_annotations,
)


def _payload() -> dict[str, object]:
    return {
        "schema_version": ANNOTATION_SCHEMA_VERSION,
        "scene_id": "scene-01",
        "posture_segments": [
            {
                "start_ms": 0,
                "end_ms": 1000,
                "posture": "standing",
                "split": "train",
                "person_id": "person-01",
                "camera_id": "camera-01",
                "notes": None,
            },
            {
                "start_ms": 1000,
                "end_ms": 2000,
                "posture": "sitting",
                "split": "train",
                "person_id": "person-01",
                "camera_id": "camera-01",
                "notes": "stable seated section",
            },
        ],
        "transition_events": [
            {
                "event_id": "transition-01",
                "start_ms": 800,
                "end_ms": 1200,
                "transition": "normal_transition",
                "split": "train",
                "person_id": "person-01",
                "camera_id": "camera-01",
                "notes": "sit down",
            }
        ],
    }


def test_annotations_round_trip_and_report_full_coverage(tmp_path: Path) -> None:
    annotations = PoseAnnotations.from_payload(
        _payload(),
        expected_scene_id="scene-01",
        duration_ms=2000,
        require_full_posture_coverage=True,
    )

    path = tmp_path / "annotations.json"
    save_annotations(path, annotations)
    loaded = PoseAnnotations.load(path, duration_ms=2000)

    assert loaded == annotations
    report = loaded.coverage_report(duration_ms=2000)
    assert report["coverage_ratio"] == 1.0
    assert report["posture_segments"] == {"sitting": 1, "standing": 1}
    assert report["transition_events"] == {"normal_transition": 1}
    assert report["gaps"] == []


def test_annotations_reject_overlapping_posture_segments() -> None:
    payload = _payload()
    segments = payload["posture_segments"]
    assert isinstance(segments, list)
    second = segments[1]
    assert isinstance(second, dict)
    second["start_ms"] = 900

    with pytest.raises(AnnotationError, match="overlaps"):
        PoseAnnotations.from_payload(payload, duration_ms=2000)


def test_annotations_report_uncovered_ranges() -> None:
    payload = _payload()
    segments = payload["posture_segments"]
    assert isinstance(segments, list)
    segments.pop()

    annotations = PoseAnnotations.from_payload(payload, duration_ms=2000)

    assert annotations.posture_gaps(duration_ms=2000) == [
        {"start_ms": 1000.0, "end_ms": 2000}
    ]
    with pytest.raises(AnnotationError, match="contain gaps"):
        PoseAnnotations.from_payload(
            payload,
            duration_ms=2000,
            require_full_posture_coverage=True,
        )


def test_annotations_warn_when_same_recording_crosses_learned_splits() -> None:
    payload = _payload()
    segments = payload["posture_segments"]
    assert isinstance(segments, list)
    second = segments[1]
    assert isinstance(second, dict)
    second["split"] = "test"

    annotations = PoseAnnotations.from_payload(payload, duration_ms=2000)

    assert annotations.split_leakage_warnings() == [
        "person 'person-01' on camera 'camera-01' appears in multiple learned splits: "
        "['test', 'train']"
    ]


def test_empty_annotations_uses_canonical_schema(tmp_path: Path) -> None:
    annotations = empty_annotations("scene-new")
    path = tmp_path / "empty.json"
    save_annotations(path, annotations)

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload == {
        "schema_version": ANNOTATION_SCHEMA_VERSION,
        "scene_id": "scene-new",
        "posture_segments": [],
        "transition_events": [],
    }
