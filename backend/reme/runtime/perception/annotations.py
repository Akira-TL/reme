"""Validated posture and transition annotations for pose experiments."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ANNOTATION_SCHEMA_VERSION = "reme-pose-annotations/v0-experiment"
POSTURE_LABELS = (
    "standing",
    "sitting",
    "lying",
    "bending_or_crouching",
    "unknown",
)
TRANSITION_LABELS = (
    "normal_transition",
    "fall_like_transition",
    "uncertain_transition",
)
DATA_SPLITS = ("train", "val", "test", "demo", "exclude")
LEARNED_SPLITS = frozenset({"train", "val", "test"})


class AnnotationError(ValueError):
    """Raised when an annotation payload is malformed or unsafe to use."""


@dataclass(frozen=True, slots=True)
class PostureSegment:
    """One continuous static-posture ground-truth segment."""

    start_ms: float
    end_ms: float
    posture: str
    split: str
    person_id: str
    camera_id: str
    notes: str | None = None

    def to_payload(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""

        return {
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "posture": self.posture,
            "split": self.split,
            "person_id": self.person_id,
            "camera_id": self.camera_id,
            "notes": self.notes,
        }


@dataclass(frozen=True, slots=True)
class TransitionAnnotation:
    """One labelled temporal transition window."""

    event_id: str
    start_ms: float
    end_ms: float
    transition: str
    split: str
    person_id: str
    camera_id: str
    notes: str | None = None

    def to_payload(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""

        return {
            "event_id": self.event_id,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "transition": self.transition,
            "split": self.split,
            "person_id": self.person_id,
            "camera_id": self.camera_id,
            "notes": self.notes,
        }


@dataclass(frozen=True, slots=True)
class PoseAnnotations:
    """Validated posture and transition labels for one source scene."""

    scene_id: str
    posture_segments: tuple[PostureSegment, ...]
    transition_events: tuple[TransitionAnnotation, ...]
    schema_version: str = ANNOTATION_SCHEMA_VERSION

    @classmethod
    def from_payload(
        cls,
        payload: object,
        *,
        expected_scene_id: str | None = None,
        duration_ms: float | None = None,
        require_full_posture_coverage: bool = False,
    ) -> PoseAnnotations:
        """Validate and construct annotations from a decoded JSON payload."""

        if not isinstance(payload, dict):
            raise AnnotationError("annotation payload must be an object")
        if payload.get("schema_version") != ANNOTATION_SCHEMA_VERSION:
            raise AnnotationError(
                f"schema_version must be {ANNOTATION_SCHEMA_VERSION!r}"
            )
        scene_id = _non_empty_string(payload.get("scene_id"), "scene_id")
        if expected_scene_id is not None and scene_id != expected_scene_id:
            raise AnnotationError(
                f"scene_id must be {expected_scene_id!r}, got {scene_id!r}"
            )
        if duration_ms is not None and duration_ms <= 0:
            raise AnnotationError("duration_ms must be positive")

        posture_payloads = payload.get("posture_segments")
        transition_payloads = payload.get("transition_events")
        if not isinstance(posture_payloads, list):
            raise AnnotationError("posture_segments must be an array")
        if not isinstance(transition_payloads, list):
            raise AnnotationError("transition_events must be an array")

        posture_segments = tuple(
            _parse_posture_segment(item, index=index, duration_ms=duration_ms)
            for index, item in enumerate(posture_payloads)
        )
        transition_events = tuple(
            _parse_transition_event(item, index=index, duration_ms=duration_ms)
            for index, item in enumerate(transition_payloads)
        )
        _validate_posture_order_and_overlap(posture_segments)
        _validate_transition_order_and_ids(transition_events)

        annotations = cls(
            scene_id=scene_id,
            posture_segments=posture_segments,
            transition_events=transition_events,
        )
        if require_full_posture_coverage:
            if duration_ms is None:
                raise AnnotationError(
                    "duration_ms is required when full posture coverage is enforced"
                )
            gaps = annotations.posture_gaps(duration_ms=duration_ms)
            if gaps:
                raise AnnotationError(f"posture annotations contain gaps: {gaps}")
        return annotations

    @classmethod
    def load(
        cls,
        path: str | Path,
        *,
        expected_scene_id: str | None = None,
        duration_ms: float | None = None,
        require_full_posture_coverage: bool = False,
    ) -> PoseAnnotations:
        """Read and validate an annotation JSON file."""

        annotation_path = Path(path)
        try:
            payload = json.loads(annotation_path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise AnnotationError(f"cannot read annotations: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise AnnotationError(f"annotations are not valid JSON: {exc}") from exc
        return cls.from_payload(
            payload,
            expected_scene_id=expected_scene_id,
            duration_ms=duration_ms,
            require_full_posture_coverage=require_full_posture_coverage,
        )

    def to_payload(self) -> dict[str, object]:
        """Return the canonical persisted representation."""

        return {
            "schema_version": self.schema_version,
            "scene_id": self.scene_id,
            "posture_segments": [segment.to_payload() for segment in self.posture_segments],
            "transition_events": [event.to_payload() for event in self.transition_events],
        }

    def posture_gaps(self, *, duration_ms: float) -> list[dict[str, float]]:
        """Return uncovered source-time ranges in ascending order."""

        if duration_ms <= 0:
            raise AnnotationError("duration_ms must be positive")
        gaps: list[dict[str, float]] = []
        cursor = 0.0
        for segment in self.posture_segments:
            if segment.start_ms > cursor:
                gaps.append({"start_ms": cursor, "end_ms": segment.start_ms})
            cursor = max(cursor, segment.end_ms)
        if cursor < duration_ms:
            gaps.append({"start_ms": cursor, "end_ms": duration_ms})
        return gaps

    def split_leakage_warnings(self) -> list[str]:
        """Report identities or recordings reused across learned-data splits."""

        assignments: dict[tuple[str, str], set[str]] = {}
        for segment in self.posture_segments:
            if segment.split not in LEARNED_SPLITS:
                continue
            key = (segment.person_id, segment.camera_id)
            assignments.setdefault(key, set()).add(segment.split)
        warnings = []
        for (person_id, camera_id), splits in sorted(assignments.items()):
            if len(splits) > 1:
                warnings.append(
                    f"person {person_id!r} on camera {camera_id!r} appears in "
                    f"multiple learned splits: {sorted(splits)}"
                )
        return warnings

    def coverage_report(self, *, duration_ms: float) -> dict[str, object]:
        """Summarize label duration, identity coverage, gaps, and split safety."""

        label_durations: dict[str, float] = {}
        label_segments: Counter[str] = Counter()
        people: set[str] = set()
        cameras: set[str] = set()
        splits: set[str] = set()
        for segment in self.posture_segments:
            label_durations[segment.posture] = (
                label_durations.get(segment.posture, 0.0)
                + segment.end_ms
                - segment.start_ms
            )
            label_segments[segment.posture] += 1
            people.add(segment.person_id)
            cameras.add(segment.camera_id)
            splits.add(segment.split)

        transition_counts = Counter(event.transition for event in self.transition_events)
        gaps = self.posture_gaps(duration_ms=duration_ms)
        labelled_ms = sum(label_durations.values())
        return {
            "scene_id": self.scene_id,
            "duration_ms": duration_ms,
            "labelled_ms": round(labelled_ms, 3),
            "coverage_ratio": round(min(labelled_ms / duration_ms, 1.0), 6),
            "posture_segments": dict(sorted(label_segments.items())),
            "posture_duration_ms": {
                label: round(value, 3) for label, value in sorted(label_durations.items())
            },
            "transition_events": dict(sorted(transition_counts.items())),
            "person_count": len(people),
            "camera_count": len(cameras),
            "splits": sorted(splits),
            "gaps": gaps,
            "split_leakage_warnings": self.split_leakage_warnings(),
        }


def empty_annotations(scene_id: str) -> PoseAnnotations:
    """Create the initial empty payload for an annotation session."""

    return PoseAnnotations(
        scene_id=_non_empty_string(scene_id, "scene_id"),
        posture_segments=(),
        transition_events=(),
    )


def save_annotations(path: str | Path, annotations: PoseAnnotations) -> None:
    """Atomically persist validated annotations."""

    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(
        json.dumps(annotations.to_payload(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(destination)


def _parse_posture_segment(
    value: object, *, index: int, duration_ms: float | None
) -> PostureSegment:
    if not isinstance(value, dict):
        raise AnnotationError(f"posture_segments[{index}] must be an object")
    start_ms, end_ms = _time_window(value, f"posture_segments[{index}]", duration_ms)
    posture = _enum_string(
        value.get("posture"), POSTURE_LABELS, f"posture_segments[{index}].posture"
    )
    split = _enum_string(
        value.get("split"), DATA_SPLITS, f"posture_segments[{index}].split"
    )
    return PostureSegment(
        start_ms=start_ms,
        end_ms=end_ms,
        posture=posture,
        split=split,
        person_id=_non_empty_string(
            value.get("person_id"), f"posture_segments[{index}].person_id"
        ),
        camera_id=_non_empty_string(
            value.get("camera_id"), f"posture_segments[{index}].camera_id"
        ),
        notes=_nullable_string(value.get("notes"), f"posture_segments[{index}].notes"),
    )


def _parse_transition_event(
    value: object, *, index: int, duration_ms: float | None
) -> TransitionAnnotation:
    if not isinstance(value, dict):
        raise AnnotationError(f"transition_events[{index}] must be an object")
    prefix = f"transition_events[{index}]"
    start_ms, end_ms = _time_window(value, prefix, duration_ms)
    return TransitionAnnotation(
        event_id=_non_empty_string(value.get("event_id"), f"{prefix}.event_id"),
        start_ms=start_ms,
        end_ms=end_ms,
        transition=_enum_string(
            value.get("transition"), TRANSITION_LABELS, f"{prefix}.transition"
        ),
        split=_enum_string(value.get("split"), DATA_SPLITS, f"{prefix}.split"),
        person_id=_non_empty_string(value.get("person_id"), f"{prefix}.person_id"),
        camera_id=_non_empty_string(value.get("camera_id"), f"{prefix}.camera_id"),
        notes=_nullable_string(value.get("notes"), f"{prefix}.notes"),
    )


def _time_window(
    value: dict[str, Any], prefix: str, duration_ms: float | None
) -> tuple[float, float]:
    start_ms = _finite_number(value.get("start_ms"), f"{prefix}.start_ms")
    end_ms = _finite_number(value.get("end_ms"), f"{prefix}.end_ms")
    if start_ms < 0:
        raise AnnotationError(f"{prefix}.start_ms must be non-negative")
    if end_ms <= start_ms:
        raise AnnotationError(f"{prefix}.end_ms must be greater than start_ms")
    if duration_ms is not None and end_ms > duration_ms + 0.001:
        raise AnnotationError(f"{prefix}.end_ms exceeds scene duration")
    return start_ms, end_ms


def _validate_posture_order_and_overlap(segments: tuple[PostureSegment, ...]) -> None:
    previous_end = 0.0
    for index, segment in enumerate(segments):
        if index and segment.start_ms < previous_end - 0.001:
            raise AnnotationError(
                f"posture_segments[{index}] overlaps or is out of order"
            )
        previous_end = segment.end_ms


def _validate_transition_order_and_ids(
    events: tuple[TransitionAnnotation, ...],
) -> None:
    previous_start = -1.0
    event_ids: set[str] = set()
    for index, event in enumerate(events):
        if event.start_ms < previous_start:
            raise AnnotationError(f"transition_events[{index}] is out of order")
        if event.event_id in event_ids:
            raise AnnotationError(f"duplicate transition event_id {event.event_id!r}")
        previous_start = event.start_ms
        event_ids.add(event.event_id)


def _non_empty_string(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AnnotationError(f"{field_name} must be a non-empty string")
    return value.strip()


def _nullable_string(value: object, field_name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise AnnotationError(f"{field_name} must be a string or null")
    stripped = value.strip()
    return stripped or None


def _enum_string(
    value: object,
    allowed: tuple[str, ...],
    field_name: str,
) -> str:
    text = _non_empty_string(value, field_name)
    if text not in allowed:
        raise AnnotationError(f"{field_name} must be one of {allowed}")
    return text


def _finite_number(value: object, field_name: str) -> float:
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise AnnotationError(f"{field_name} must be a number")
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        raise AnnotationError(f"{field_name} must be finite")
    return round(number, 3)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate = subparsers.add_parser("validate", help="validate and summarize annotations")
    validate.add_argument("annotations", type=Path)
    validate.add_argument("--scene-id")
    validate.add_argument("--duration-ms", type=float, required=True)
    validate.add_argument("--require-full-coverage", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Validate one annotation file and print its coverage report."""

    args = _build_parser().parse_args(argv)
    try:
        annotations = PoseAnnotations.load(
            args.annotations,
            expected_scene_id=args.scene_id,
            duration_ms=args.duration_ms,
            require_full_posture_coverage=args.require_full_coverage,
        )
        print(
            json.dumps(
                annotations.coverage_report(duration_ms=args.duration_ms),
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    except AnnotationError as exc:
        print(f"error: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
