"""Deterministic tests for the consumer-side posture timeline over A's stream."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from reme.runtime.decision.context import (
    LandmarkQuality,
    MotionLevel,
    Posture,
    PostureObservation,
)
from reme.runtime.decision.posture_timeline import (
    DOWN_POSTURES,
    PostureTimeline,
    PostureTimelineError,
    build_intervals,
)

SCENE = "scene-01"


def observation(
    posture: Posture,
    timestamp_ms: float,
    *,
    motion: MotionLevel = MotionLevel.LOW,
    confidence: float = 0.8,
    scene_id: str = SCENE,
    duration_ms: float = 0.0,
) -> PostureObservation:
    return PostureObservation(
        scene_id=scene_id,
        timestamp_ms=timestamp_ms,
        person_detected=True,
        posture=posture,
        posture_confidence=confidence,
        posture_duration_ms=duration_ms,
        motion_level=motion,
        landmark_quality=LandmarkQuality.USABLE,
    )


def timeline_of(*observations: PostureObservation) -> PostureTimeline:
    timeline = PostureTimeline(SCENE)
    timeline.extend(observations)
    return timeline


class TestLookup:
    def test_at_returns_the_posture_in_force(self) -> None:
        timeline = timeline_of(
            observation(Posture.STANDING, 0.0),
            observation(Posture.SITTING, 1000.0),
        )
        before = timeline.at(-1.0)
        assert before is None
        during = timeline.at(500.0)
        assert during is not None and during.posture is Posture.STANDING
        after = timeline.at(1500.0)
        assert after is not None and after.posture is Posture.SITTING

    def test_at_is_inclusive_of_its_own_timestamp(self) -> None:
        timeline = timeline_of(observation(Posture.STANDING, 100.0))
        found = timeline.at(100.0)
        assert found is not None

    def test_between_is_half_open(self) -> None:
        timeline = timeline_of(
            *(observation(Posture.STANDING, float(index * 100)) for index in range(10))
        )
        found = timeline.between(200.0, 500.0)
        assert [item.timestamp_ms for item in found] == [200.0, 300.0, 400.0]

    def test_out_of_order_arrivals_are_ordered_on_read(self) -> None:
        timeline = timeline_of(
            observation(Posture.STANDING, 900.0),
            observation(Posture.STANDING, 100.0),
        )
        assert [item.timestamp_ms for item in timeline.all()] == [100.0, 900.0]
        latest = timeline.latest()
        assert latest is not None and latest.timestamp_ms == 900.0

    def test_inverted_range_is_rejected(self) -> None:
        with pytest.raises(PostureTimelineError, match="end_ms"):
            timeline_of().between(500.0, 100.0)

    def test_observations_from_another_scene_are_rejected(self) -> None:
        timeline = PostureTimeline(SCENE)
        with pytest.raises(PostureTimelineError, match="another-scene"):
            timeline.append(observation(Posture.STANDING, 0.0, scene_id="another-scene"))

    def test_empty_timeline_answers_safely(self) -> None:
        timeline = PostureTimeline(SCENE)
        assert timeline.latest() is None
        assert timeline.at(0.0) is None
        assert timeline.intervals() == ()
        assert timeline.sustained_stillness_ms() == 0.0


class TestIntervals:
    def test_runs_collapse_and_tile_without_gaps(self) -> None:
        timeline = timeline_of(
            observation(Posture.STANDING, 0.0),
            observation(Posture.STANDING, 100.0),
            observation(Posture.SITTING, 200.0),
            observation(Posture.STANDING, 300.0),
        )
        intervals = timeline.intervals()
        assert [item.posture for item in intervals] == [
            Posture.STANDING,
            Posture.SITTING,
            Posture.STANDING,
        ]
        assert intervals[0].start_ms == 0.0
        assert intervals[0].end_ms == 200.0
        assert intervals[0].observation_count == 2
        for earlier, later in zip(intervals, intervals[1:], strict=False):
            assert earlier.end_ms == later.start_ms

    def test_no_interval_has_negative_duration_under_clock_regression(self) -> None:
        observations = [
            observation(Posture.STANDING, 500.0),
            observation(Posture.SITTING, 100.0),
            observation(Posture.STANDING, 300.0),
        ]
        for interval in build_intervals(observations):
            assert interval.duration_ms >= 0.0

    def test_short_runs_can_be_filtered(self) -> None:
        timeline = timeline_of(
            observation(Posture.STANDING, 0.0),
            observation(Posture.SITTING, 100.0),
            observation(Posture.STANDING, 150.0),
            observation(Posture.STANDING, 2000.0),
        )
        for interval in timeline.intervals(min_duration_ms=100.0):
            assert interval.duration_ms >= 100.0

    def test_negative_filter_is_rejected(self) -> None:
        with pytest.raises(PostureTimelineError, match="non-negative"):
            build_intervals([], min_duration_ms=-1.0)


class TestSustainedStillness:
    def test_counts_only_while_posture_and_stillness_both_hold(self) -> None:
        timeline = timeline_of(
            observation(Posture.LYING, 0.0, motion=MotionLevel.STILL),
            observation(Posture.LYING, 1000.0, motion=MotionLevel.STILL),
            observation(Posture.LYING, 2000.0, motion=MotionLevel.STILL),
        )
        assert timeline.sustained_stillness_ms() == pytest.approx(2000.0)

    def test_movement_resets_the_span(self) -> None:
        timeline = timeline_of(
            observation(Posture.LYING, 0.0, motion=MotionLevel.STILL),
            observation(Posture.LYING, 1000.0, motion=MotionLevel.HIGH),
            observation(Posture.LYING, 2000.0, motion=MotionLevel.STILL),
        )
        assert timeline.sustained_stillness_ms() == pytest.approx(0.0)

    def test_a_posture_outside_the_set_yields_zero(self) -> None:
        timeline = timeline_of(
            observation(Posture.LYING, 0.0, motion=MotionLevel.STILL),
            observation(Posture.STANDING, 1000.0, motion=MotionLevel.STILL),
        )
        assert timeline.sustained_stillness_ms() == 0.0

    def test_unknown_motion_does_not_count_as_stillness(self) -> None:
        """Absence of evidence must not inflate the duration that matters most."""

        timeline = timeline_of(
            observation(Posture.LYING, 0.0, motion=MotionLevel.STILL),
            observation(Posture.LYING, 1000.0, motion=MotionLevel.UNKNOWN),
            observation(Posture.LYING, 2000.0, motion=MotionLevel.STILL),
        )
        assert timeline.sustained_stillness_ms() == pytest.approx(0.0)

    def test_unknown_posture_does_not_count(self) -> None:
        timeline = timeline_of(
            observation(Posture.LYING, 0.0, motion=MotionLevel.STILL),
            observation(Posture.UNKNOWN, 1000.0, motion=MotionLevel.STILL),
        )
        assert timeline.sustained_stillness_ms() == 0.0

    def test_can_be_asked_about_an_earlier_moment(self) -> None:
        timeline = timeline_of(
            observation(Posture.LYING, 0.0, motion=MotionLevel.STILL),
            observation(Posture.LYING, 1000.0, motion=MotionLevel.STILL),
            observation(Posture.STANDING, 2000.0, motion=MotionLevel.LOW),
        )
        assert timeline.sustained_stillness_ms(at_ms=1000.0) == pytest.approx(1000.0)
        assert timeline.sustained_stillness_ms(at_ms=2000.0) == 0.0

    def test_sitting_is_included_by_default(self) -> None:
        assert Posture.SITTING in DOWN_POSTURES
        assert Posture.LYING in DOWN_POSTURES
        assert Posture.STANDING not in DOWN_POSTURES

    def test_the_posture_set_is_caller_controlled(self) -> None:
        timeline = timeline_of(
            observation(Posture.STANDING, 0.0, motion=MotionLevel.STILL),
            observation(Posture.STANDING, 5000.0, motion=MotionLevel.STILL),
        )
        assert timeline.sustained_stillness_ms() == 0.0
        held = timeline.sustained_stillness_ms(postures=frozenset({Posture.STANDING}))
        assert held == pytest.approx(5000.0)


class TestStreamLoading:
    def test_reads_one_of_a_s_observation_streams(self, tmp_path: Path) -> None:
        path = tmp_path / "posture_observations.jsonl"
        rows = [
            {
                "schema_version": "reme-posture/v0-experiment",
                "scene_id": SCENE,
                "timestamp_ms": float(index * 200),
                "person_detected": True,
                "posture": "standing",
                "posture_confidence": 0.9,
                "posture_duration_ms": float(index * 200),
                "motion_level": "low",
                "landmark_quality": "usable",
            }
            for index in range(5)
        ]
        path.write_text(
            "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
            encoding="utf-8",
        )
        timeline = PostureTimeline.from_stream(path, scene_id=SCENE)
        assert len(timeline) == 5
        found = timeline.at(500.0)
        assert found is not None and found.timestamp_ms == 400.0

    def test_a_mismatched_scene_is_rejected(self, tmp_path: Path) -> None:
        path = tmp_path / "posture_observations.jsonl"
        path.write_text(
            json.dumps(
                {
                    "schema_version": "reme-posture/v0-experiment",
                    "scene_id": "other",
                    "timestamp_ms": 0.0,
                    "person_detected": True,
                    "posture": "standing",
                    "posture_confidence": 0.9,
                    "posture_duration_ms": 0.0,
                    "motion_level": "low",
                    "landmark_quality": "usable",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        with pytest.raises(PostureTimelineError):
            PostureTimeline.from_stream(path, scene_id=SCENE)
