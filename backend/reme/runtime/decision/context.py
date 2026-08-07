"""Read A's perception streams and assemble B's internal decision context."""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol

from reme.runtime.perception.scene_bundle import SceneManifest, load_scene_manifest

POSTURE_SCHEMA_VERSION = "reme-posture/v0-experiment"
TRANSITION_SCHEMA_VERSION = "reme-transition/v0-experiment"
DEFAULT_TRANSITION_GRACE_MS = 5000.0


class SceneStreamError(ValueError):
    """Raised when one of A's perception streams violates the shared contract."""


class Posture(StrEnum):
    """Static posture labels (contract section 4.3)."""

    STANDING = "standing"
    SITTING = "sitting"
    LYING = "lying"
    BENDING_OR_CROUCHING = "bending_or_crouching"
    UNKNOWN = "unknown"


class MotionLevel(StrEnum):
    """Motion intensity labels (contract section 4.3)."""

    STILL = "still"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    UNKNOWN = "unknown"


class LandmarkQuality(StrEnum):
    """Keypoint quality labels (contract section 4.3)."""

    USABLE = "usable"
    DEGRADED = "degraded"
    UNAVAILABLE = "unavailable"


class Transition(StrEnum):
    """Temporal transition hypotheses (contract section 4.3)."""

    NORMAL = "normal_transition"
    FALL_LIKE = "fall_like_transition"
    UNCERTAIN = "uncertain_transition"


def _confidence(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or not 0.0 <= value <= 1.0:
        raise SceneStreamError(f"{label} must be a number within 0.0..1.0")
    return float(value)


def _timestamp(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or value < 0:
        raise SceneStreamError(f"{label} must be a non-negative number")
    return float(value)


def _enum(value: object, enum_cls: type[Any], label: str) -> Any:
    try:
        return enum_cls(value)
    except ValueError as exc:
        raise SceneStreamError(
            f"{label} must be one of {[member.value for member in enum_cls]}, got {value!r}"
        ) from exc


@dataclass(frozen=True, slots=True)
class PostureObservation:
    """One low-frequency posture fact from A (contract section 7)."""

    scene_id: str
    timestamp_ms: float
    person_detected: bool
    posture: Posture
    posture_confidence: float
    posture_duration_ms: float
    motion_level: MotionLevel
    landmark_quality: LandmarkQuality


@dataclass(frozen=True, slots=True)
class TransitionEvent:
    """One temporal transition hypothesis from A (contract section 8)."""

    scene_id: str
    event_id: str
    start_ms: float
    end_ms: float
    transition: Transition
    transition_confidence: float
    evidence: dict[str, Any]
    landmark_quality: LandmarkQuality


def _parse_posture_observation(payload: dict[str, Any], *, label: str) -> PostureObservation:
    if payload.get("schema_version") != POSTURE_SCHEMA_VERSION:
        raise SceneStreamError(
            f"{label}: schema_version must be {POSTURE_SCHEMA_VERSION!r}, "
            f"got {payload.get('schema_version')!r}"
        )
    scene_id = payload.get("scene_id")
    if not isinstance(scene_id, str) or not scene_id:
        raise SceneStreamError(f"{label}: scene_id must be a non-empty string")
    person_detected = payload.get("person_detected")
    if not isinstance(person_detected, bool):
        raise SceneStreamError(f"{label}: person_detected must be a boolean")
    return PostureObservation(
        scene_id=scene_id,
        timestamp_ms=_timestamp(payload.get("timestamp_ms"), f"{label}: timestamp_ms"),
        person_detected=person_detected,
        posture=_enum(payload.get("posture"), Posture, f"{label}: posture"),
        posture_confidence=_confidence(
            payload.get("posture_confidence"), f"{label}: posture_confidence"
        ),
        posture_duration_ms=_timestamp(
            payload.get("posture_duration_ms"), f"{label}: posture_duration_ms"
        ),
        motion_level=_enum(payload.get("motion_level"), MotionLevel, f"{label}: motion_level"),
        landmark_quality=_enum(
            payload.get("landmark_quality"), LandmarkQuality, f"{label}: landmark_quality"
        ),
    )


def _parse_transition_event(payload: dict[str, Any], *, label: str) -> TransitionEvent:
    if payload.get("schema_version") != TRANSITION_SCHEMA_VERSION:
        raise SceneStreamError(
            f"{label}: schema_version must be {TRANSITION_SCHEMA_VERSION!r}, "
            f"got {payload.get('schema_version')!r}"
        )
    scene_id = payload.get("scene_id")
    if not isinstance(scene_id, str) or not scene_id:
        raise SceneStreamError(f"{label}: scene_id must be a non-empty string")
    event_id = payload.get("event_id")
    if not isinstance(event_id, str) or not event_id:
        raise SceneStreamError(f"{label}: event_id must be a non-empty string")
    start_ms = _timestamp(payload.get("start_ms"), f"{label}: start_ms")
    end_ms = _timestamp(payload.get("end_ms"), f"{label}: end_ms")
    if end_ms < start_ms:
        raise SceneStreamError(f"{label}: end_ms must be >= start_ms")
    evidence = payload.get("evidence", {})
    if not isinstance(evidence, dict):
        raise SceneStreamError(f"{label}: evidence must be an object")
    return TransitionEvent(
        scene_id=scene_id,
        event_id=event_id,
        start_ms=start_ms,
        end_ms=end_ms,
        transition=_enum(payload.get("transition"), Transition, f"{label}: transition"),
        transition_confidence=_confidence(
            payload.get("transition_confidence"), f"{label}: transition_confidence"
        ),
        evidence=evidence,
        landmark_quality=_enum(
            payload.get("landmark_quality"), LandmarkQuality, f"{label}: landmark_quality"
        ),
    )


def _read_jsonl(path: Path) -> list[tuple[int, dict[str, Any]]]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise SceneStreamError(f"cannot read stream {path.name}: {exc}") from exc
    rows: list[tuple[int, dict[str, Any]]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SceneStreamError(f"{path.name} line {line_number} is not valid JSON") from exc
        if not isinstance(payload, dict):
            raise SceneStreamError(f"{path.name} line {line_number} must be a JSON object")
        rows.append((line_number, payload))
    return rows


def load_posture_observations(
    path: str | Path, *, expected_scene_id: str
) -> tuple[PostureObservation, ...]:
    """Load one posture_observations.jsonl stream in ascending time order."""

    stream_path = Path(path)
    observations: list[PostureObservation] = []
    for line_number, payload in _read_jsonl(stream_path):
        label = f"{stream_path.name} line {line_number}"
        observation = _parse_posture_observation(payload, label=label)
        if observation.scene_id != expected_scene_id:
            raise SceneStreamError(f"{label}: scene_id mismatch, got {observation.scene_id!r}")
        if observations and observation.timestamp_ms < observations[-1].timestamp_ms:
            raise SceneStreamError(f"{label}: timestamp_ms must be ascending")
        observations.append(observation)
    return tuple(observations)


def load_transition_events(
    path: str | Path, *, expected_scene_id: str
) -> tuple[TransitionEvent, ...]:
    """Load one transition_events.jsonl stream in ascending start order."""

    stream_path = Path(path)
    events: list[TransitionEvent] = []
    for line_number, payload in _read_jsonl(stream_path):
        label = f"{stream_path.name} line {line_number}"
        event = _parse_transition_event(payload, label=label)
        if event.scene_id != expected_scene_id:
            raise SceneStreamError(f"{label}: scene_id mismatch, got {event.scene_id!r}")
        if events and event.start_ms < events[-1].start_ms:
            raise SceneStreamError(f"{label}: start_ms must be ascending")
        events.append(event)
    return tuple(events)


class PerceptionStreams(Protocol):
    """What the context builder needs from any stream source.

    Satisfied by :class:`SceneStreams` (prerecorded bundles) and by the live
    ingest's ``LiveStreams`` snapshot — the decision layer treats both alike.
    """

    @property
    def scene_id(self) -> str: ...

    @property
    def postures(self) -> tuple[PostureObservation, ...]: ...

    @property
    def transitions(self) -> tuple[TransitionEvent, ...]: ...


@dataclass(frozen=True, slots=True)
class SceneStreams:
    """A's validated perception streams for one scene."""

    manifest: SceneManifest
    postures: tuple[PostureObservation, ...]
    transitions: tuple[TransitionEvent, ...]

    @property
    def scene_id(self) -> str:
        scene_id = self.manifest.data["scene_id"]
        assert isinstance(scene_id, str)
        return scene_id


def load_scene_streams(manifest_path: str | Path) -> SceneStreams:
    """Load one scene's manifest plus the optional posture/transition streams."""

    manifest = load_scene_manifest(manifest_path)
    scene_id = manifest.data["scene_id"]
    posture_path = manifest.resolve_stream_path("posture_observations")
    transition_path = manifest.resolve_stream_path("transition_events")
    postures: tuple[PostureObservation, ...] = ()
    transitions: tuple[TransitionEvent, ...] = ()
    if posture_path is not None:
        postures = load_posture_observations(posture_path, expected_scene_id=scene_id)
    if transition_path is not None:
        transitions = load_transition_events(transition_path, expected_scene_id=scene_id)
    return SceneStreams(manifest=manifest, postures=postures, transitions=transitions)


def discover_scenes(scenes_dir: str | Path) -> dict[str, SceneStreams]:
    """Load every scene bundle directory that contains a manifest.json."""

    root = Path(scenes_dir)
    if not root.is_dir():
        raise SceneStreamError(f"scenes directory does not exist: {root}")
    scenes: dict[str, SceneStreams] = {}
    for manifest_path in sorted(root.glob("*/manifest.json")):
        streams = load_scene_streams(manifest_path)
        if streams.scene_id in scenes:
            raise SceneStreamError(f"duplicate scene_id {streams.scene_id!r}")
        scenes[streams.scene_id] = streams
    return scenes


@dataclass(frozen=True, slots=True)
class DecisionContext:
    """The perception snapshot B evaluates at one video timestamp (contract section 9)."""

    scene_id: str
    timestamp_ms: float
    latest_posture: PostureObservation | None
    active_transition: TransitionEvent | None
    input_quality: LandmarkQuality


def build_decision_context(
    streams: PerceptionStreams,
    *,
    timestamp_ms: float,
    transition_grace_ms: float = DEFAULT_TRANSITION_GRACE_MS,
) -> DecisionContext:
    """Assemble the latest-not-after-timestamp snapshot (contract section 7 reading rule)."""

    _timestamp(timestamp_ms, "timestamp_ms")
    latest_posture: PostureObservation | None = None
    for observation in streams.postures:
        if observation.timestamp_ms > timestamp_ms:
            break
        latest_posture = observation

    active_transition: TransitionEvent | None = None
    for event in streams.transitions:
        if event.start_ms > timestamp_ms:
            break
        if timestamp_ms - event.end_ms <= transition_grace_ms:
            active_transition = event

    if latest_posture is None:
        input_quality = LandmarkQuality.UNAVAILABLE
    else:
        input_quality = latest_posture.landmark_quality
    return DecisionContext(
        scene_id=streams.scene_id,
        timestamp_ms=timestamp_ms,
        latest_posture=latest_posture,
        active_transition=active_transition,
        input_quality=input_quality,
    )
