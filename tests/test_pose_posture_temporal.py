"""Deterministic tests for the posture temporal de-jitter layer."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from reme.pose.biomech import ImageGeometry, parse_frame_record
from reme.pose.posture_criteria import PostureVerdict, classify_frame
from reme.pose.posture_runtime import (
    POSTURE_SCHEMA_VERSION,
    BiomechPostureTracker,
    PostureRuntimeConfig,
    PostureRuntimeError,
)
from reme.pose.posture_temporal import (
    PostureTemporalError,
    PostureTemporalTracker,
    TemporalConfig,
    flip_count,
    smooth_sequence,
    temporal_payload,
)
from reme.pose.runtime import RuntimeEvent, RuntimeEventType


def verdict(posture: str, confidence: float = 0.8) -> PostureVerdict:
    return PostureVerdict(
        posture=posture,
        confidence=confidence,
        gates=(),
        evidence=(),
        abstain_reason=None if posture != "unknown" else "no class criteria fully met",
    )


def run(labels: list[str], *, step_ms: float = 33.3333, **kwargs: float) -> list[str]:
    pairs = [(verdict(label), index * step_ms) for index, label in enumerate(labels)]
    config = TemporalConfig(**kwargs) if kwargs else None
    return [item.posture for item in smooth_sequence(pairs, config=config)]


class TestDwell:
    def test_zero_dwell_is_an_exact_passthrough(self) -> None:
        """With no dwell the layer must not alter the sequence at all."""

        labels = ["standing", "unknown", "standing", "unknown", "unknown", "standing"]
        released = run(labels, min_dwell_ms=0.0, unknown_dwell_ms=0.0)
        assert released == labels

    def test_a_single_frame_blip_is_suppressed(self) -> None:
        labels = ["standing"] * 10 + ["unknown"] + ["standing"] * 10
        released = run(labels)
        # Index 10 is the blip.  The cold start legitimately abstains for one
        # dwell, so only the settled part of the sequence is asserted on.
        assert released[10] == "standing"
        assert set(released[7:]) == {"standing"}

    def test_a_sustained_change_is_released_after_the_dwell(self) -> None:
        labels = ["standing"] * 10 + ["unknown"] * 20
        released = run(labels)
        assert released[-1] == "unknown"

    def test_release_waits_at_least_the_dwell(self) -> None:
        tracker = PostureTemporalTracker(TemporalConfig(min_dwell_ms=167.0))
        for index in range(10):
            tracker.ingest(verdict("standing"), timestamp_ms=index * 33.3333)
        assert tracker.emitted == "standing"
        start = 10 * 33.3333
        switched_at: float | None = None
        for index in range(10, 30):
            timestamp = index * 33.3333
            result = tracker.ingest(verdict("unknown"), timestamp_ms=timestamp)
            if result.posture == "unknown" and switched_at is None:
                switched_at = timestamp
        assert switched_at is not None
        assert switched_at - start >= 167.0

    def test_duration_is_dated_from_when_the_posture_began(self) -> None:
        """Dwell must not be charged to the posture's own duration."""

        tracker = PostureTemporalTracker()
        for index in range(20):
            tracker.ingest(verdict("standing"), timestamp_ms=index * 33.3333)
        result = tracker.ingest(verdict("standing"), timestamp_ms=20 * 33.3333)
        # The run began at t=0, so the reported dwell is the whole run, not the
        # time since the switch was confirmed.
        assert result.dwell_ms == pytest.approx(20 * 33.3333, abs=1.0)


class TestPhysicalLegality:
    def test_standing_and_lying_are_never_adjacent(self) -> None:
        """The rule bars a direct release, not the posture itself.

        Sustained evidence must still win eventually -- refusing forever would
        be wrong when someone really has gone down.  What the rule guarantees is
        that ``unknown`` is always interposed, so the impossible jump surfaces as
        an abstention instead of a confident lie.
        """

        labels = ["standing"] * 10 + ["lying"] * 20
        released = run(labels)
        for earlier, later in zip(released, released[1:], strict=False):
            assert {earlier, later} != {"standing", "lying"}
        assert released[-1] == "lying"

    def test_the_interposed_abstention_lasts_at_least_one_dwell(self) -> None:
        step = 33.3333
        labels = ["standing"] * 10 + ["lying"] * 20
        released = run(labels, step_ms=step)
        first_lying = released.index("lying")
        abstained = [
            index
            for index, label in enumerate(released[:first_lying])
            if label == "unknown" and index > 5
        ]
        assert len(abstained) * step >= 167.0

    def test_standing_to_lying_via_unknown_is_allowed(self) -> None:
        labels = ["standing"] * 10 + ["unknown"] * 10 + ["lying"] * 20
        released = run(labels)
        assert released[-1] == "lying"

    def test_the_refusal_states_which_rule_fired(self) -> None:
        tracker = PostureTemporalTracker()
        for index in range(10):
            tracker.ingest(verdict("standing"), timestamp_ms=index * 33.3333)
        reasons: list[str] = []
        for index in range(10, 25):
            result = tracker.ingest(verdict("lying"), timestamp_ms=index * 33.3333)
            if result.override_reason:
                reasons.append(result.override_reason)
        assert any("not physically reachable" in reason for reason in reasons)

    def test_sitting_after_standing_is_a_normal_transition(self) -> None:
        labels = ["standing"] * 10 + ["sitting"] * 20
        released = run(labels)
        assert released[-1] == "sitting"


class TestEvidenceCoversTheEmittedLabel:
    def test_disagreement_is_recorded_rather_than_hidden(self) -> None:
        tracker = PostureTemporalTracker()
        for index in range(10):
            tracker.ingest(verdict("standing"), timestamp_ms=index * 33.3333)
        result = tracker.ingest(verdict("unknown"), timestamp_ms=10 * 33.3333)
        assert result.posture == "standing"
        assert result.frame_posture == "unknown"
        assert result.overridden is True
        assert result.override_reason is not None
        assert "required to replace" in result.override_reason

    def test_payload_carries_both_labels_and_the_frame_evidence(self) -> None:
        frame = parse_frame_record(_upright_record(), image=_GEOMETRY)
        tracker = PostureTemporalTracker()
        result = tracker.ingest(classify_frame(frame), timestamp_ms=0.0)
        payload = temporal_payload(result)["temporal"]
        assert isinstance(payload, dict)
        assert payload["posture"] == result.posture
        assert payload["frame_posture"] == result.frame_posture
        assert "frame_evidence" in payload

    def test_agreement_reports_no_override(self) -> None:
        tracker = PostureTemporalTracker()
        for index in range(10):
            result = tracker.ingest(verdict("unknown"), timestamp_ms=index * 33.3333)
        assert result.overridden is False
        assert result.override_reason is None


class TestDiscontinuity:
    def test_cold_start_abstains_until_the_posture_holds(self) -> None:
        tracker = PostureTemporalTracker()
        first = tracker.ingest(verdict("standing"), timestamp_ms=0.0)
        assert first.posture == "unknown"

    def test_a_clock_regression_resets_the_state(self) -> None:
        tracker = PostureTemporalTracker()
        for index in range(20):
            tracker.ingest(verdict("standing"), timestamp_ms=index * 33.3333)
        assert tracker.emitted == "standing"
        result = tracker.ingest(verdict("standing"), timestamp_ms=5.0)
        assert result.posture == "unknown"
        assert result.override_reason is not None
        assert "backwards" in result.override_reason

    def test_a_long_gap_resets_the_state(self) -> None:
        tracker = PostureTemporalTracker(TemporalConfig(max_gap_ms=500.0))
        for index in range(20):
            tracker.ingest(verdict("standing"), timestamp_ms=index * 33.3333)
        result = tracker.ingest(verdict("standing"), timestamp_ms=20_000.0)
        assert result.posture == "unknown"
        assert result.override_reason is not None
        assert "gap of" in result.override_reason

    def test_reset_clears_everything(self) -> None:
        tracker = PostureTemporalTracker()
        for index in range(20):
            tracker.ingest(verdict("standing"), timestamp_ms=index * 33.3333)
        tracker.reset()
        assert tracker.emitted == "unknown"

    def test_negative_timestamp_is_rejected(self) -> None:
        with pytest.raises(PostureTemporalError, match="non-negative"):
            PostureTemporalTracker().ingest(verdict("standing"), timestamp_ms=-1.0)

    def test_negative_dwell_is_rejected(self) -> None:
        with pytest.raises(PostureTemporalError, match="non-negative"):
            TemporalConfig(min_dwell_ms=-1.0)


_GEOMETRY = ImageGeometry(width=1280, height=720, size_provenance="measured")


def _upright_record() -> dict[str, object]:
    from test_pose_biomech import build_record, upright_person

    return build_record(upright_person())


REAL_CLIP = Path(".scratch/posture-classifier-theory/data/movenet17-real-2370.jsonl")


@pytest.mark.skipif(not REAL_CLIP.exists(), reason="derived keypoint copy is git-ignored")
def test_real_clip_label_jitter_collapses() -> None:
    """The layer exists to remove sub-100 ms dithering; prove it does on real data."""

    pairs: list[tuple[PostureVerdict, float]] = []
    with REAL_CLIP.open(encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            payload = json.loads(line)
            frame = parse_frame_record(payload, image=_GEOMETRY)
            pairs.append((classify_frame(frame), float(payload["timestamp_ms"])))

    raw_flips = flip_count([item.posture for item, _ in pairs])
    released = smooth_sequence(pairs)
    assert raw_flips > 100
    assert flip_count(released) < 10
    # The person stands throughout, so removing the dither must raise coverage
    # rather than trade it away.
    standing = sum(1 for item in released if item.posture == "standing")
    assert standing / len(released) > 0.97


class TestRuntimeWiring:
    """The temporal layer must see every frame, not the emission cadence."""

    @staticmethod
    def _event(record: dict[str, object], index: int, timestamp_ms: float) -> RuntimeEvent:
        payload = dict(record)
        payload["frame_index"] = index
        payload["timestamp_ms"] = timestamp_ms
        return RuntimeEvent(
            session_id="session-1",
            sequence=index,
            event_type=RuntimeEventType.FRAME_LANDMARKS,
            payload=payload,
        )

    def _stream(self, postures: list[str]) -> list[RuntimeEvent]:
        from test_pose_biomech import build_record, upright_person

        records = {
            "standing": build_record(upright_person()),
            # A collapsed skeleton the criteria cannot resolve, so the frame
            # verdict is unknown without needing to fake a verdict object.
            "unknown": build_record({"nose": (640.0, 300.0)}),
        }
        return [
            self._event(records[posture], index, index * 33.3333)
            for index, posture in enumerate(postures)
        ]

    def _tracker(self, **kwargs: object) -> BiomechPostureTracker:
        return BiomechPostureTracker(
            session_id="session-1", image=_GEOMETRY, **kwargs  # type: ignore[arg-type]
        )

    def test_emission_stays_inside_the_contract_cadence(self) -> None:
        events = self._stream(["standing"] * 300)
        tracker = self._tracker(config=PostureRuntimeConfig(output_hz=7.5))
        emitted = list(tracker.iter_events(events))
        span_s = (299 * 33.3333) / 1000.0
        rate = len(emitted) / span_s
        assert 5.0 <= rate <= 10.0

    def test_a_single_frame_blip_never_reaches_the_emitted_stream(self) -> None:
        """The F9 fix: a 33 ms blip is invisible only if every frame is ingested."""

        postures = ["standing"] * 150 + ["unknown"] + ["standing"] * 150
        tracker = self._tracker()
        emitted = list(tracker.iter_events(self._stream(postures)))
        settled = [item.payload["posture"] for item in emitted[10:]]
        assert set(settled) == {"standing"}

    def test_observation_keeps_the_shared_schema_version(self) -> None:
        tracker = self._tracker()
        emitted = list(tracker.iter_events(self._stream(["standing"] * 60)))
        assert emitted[0].payload["schema_version"] == POSTURE_SCHEMA_VERSION

    def test_observation_carries_evidence_for_the_released_label(self) -> None:
        tracker = self._tracker()
        emitted = list(tracker.iter_events(self._stream(["standing"] * 60)))
        evidence = emitted[-1].payload["posture_evidence"]
        assert isinstance(evidence, dict)
        assert evidence["posture"] == emitted[-1].payload["posture"]
        assert "frame_posture" in evidence
        assert "frame_evidence" in evidence

    def test_the_decision_layer_still_parses_the_payload(self) -> None:
        """Adding evidence must not break B, which keys on schema_version."""

        from reme.decision.context import Posture, _parse_posture_observation

        tracker = self._tracker()
        emitted = list(tracker.iter_events(self._stream(["standing"] * 60)))
        observation = _parse_posture_observation(emitted[-1].payload, label="test")
        assert observation.posture is Posture.STANDING

    def test_events_from_another_session_are_rejected(self) -> None:
        tracker = self._tracker()
        event = self._stream(["standing"])[0]
        stray = RuntimeEvent(
            session_id="session-2",
            sequence=0,
            event_type=RuntimeEventType.FRAME_LANDMARKS,
            payload=event.payload,
        )
        with pytest.raises(PostureRuntimeError):
            tracker.process_frame_event(stray)

    def test_non_landmark_events_are_rejected(self) -> None:
        tracker = self._tracker()
        stray = RuntimeEvent(
            session_id="session-1",
            sequence=0,
            event_type=RuntimeEventType.POSTURE_OBSERVATION,
            payload={},
        )
        with pytest.raises(PostureRuntimeError, match="only FrameLandmarks"):
            tracker.process_frame_event(stray)

    def test_reset_clears_state_for_a_replacement_session(self) -> None:
        tracker = self._tracker()
        list(tracker.iter_events(self._stream(["standing"] * 60)))
        tracker.reset()
        first = tracker.process_frame_event(self._stream(["standing"])[0])
        assert first is not None
        assert first.payload["posture"] == "unknown"
