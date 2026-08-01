"""Deterministic tests for the explainable biomechanical posture classifier."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest
from reme.pose.biomech import (
    BODY_AXIS_INDICES,
    COCO17_NAMES,
    LEFT_HIP,
    LEFT_KNEE,
    LEFT_SHOULDER,
    RIGHT_SHOULDER,
    TRUNK_AXIS_INDICES,
    BiomechError,
    ImageGeometry,
    joint_angle,
    min_segment_length_for_angle_budget,
    parse_frame_record,
    principal_axis_angle,
    sagittal_observability,
    segment_angle_from_gravity,
    vertical_order_margin,
)
from reme.pose.posture_criteria import DEFAULT_RELEASED_CLASSES, classify_frame
from reme.pose.posture_store import (
    PostureRecord,
    PostureStore,
    PostureStoreError,
    build_timeline,
)

WIDTH, HEIGHT = 1280, 720
GEOMETRY = ImageGeometry(width=WIDTH, height=HEIGHT, size_provenance="measured")


def build_record(
    points_px: dict[str, tuple[float, float]],
    *,
    score: float = 0.9,
    frame_index: int = 0,
    timestamp_ms: float = 0.0,
    detected: bool = True,
) -> dict[str, Any]:
    """Build a FrameLandmarks record from explicit pixel coordinates."""

    keypoints = []
    for name in COCO17_NAMES:
        x_px, y_px = points_px.get(name, (WIDTH * 0.5, HEIGHT * 0.5))
        keypoints.append(
            {
                "name": name,
                "x_norm": x_px / WIDTH,
                "y_norm": y_px / HEIGHT,
                "score": score if name in points_px else 0.05,
            }
        )
    return {
        "schema_version": "movenet-17/v0-experiment",
        "scene_id": "test-scene",
        "frame_index": frame_index,
        "timestamp_ms": timestamp_ms,
        "person_detected": detected,
        "landmark_quality": "usable",
        "coordinate_space": "normalized_image_top_left",
        "smoothed": False,
        "keypoints": keypoints,
    }


def upright_person(
    *,
    trunk_deg: float = 0.0,
    thigh_deg: float = 0.0,
    shank_deg: float = 0.0,
    shoulder_half_width: float = 43.0,
) -> dict[str, tuple[float, float]]:
    """Build a person from segment angles measured away from vertical.

    Segments chain downward from the shoulders; positive angles lean the segment
    towards +x.  Lengths are pixel values in the range the real clip exhibits.
    """

    trunk_len, thigh_len, shank_len = 101.0, 100.0, 90.0
    shoulder_y = 320.0
    centre_x = 640.0
    hip_x = centre_x + trunk_len * math.sin(math.radians(trunk_deg))
    hip_y = shoulder_y + trunk_len * math.cos(math.radians(trunk_deg))
    knee_x = hip_x + thigh_len * math.sin(math.radians(thigh_deg))
    knee_y = hip_y + thigh_len * math.cos(math.radians(thigh_deg))
    ankle_x = knee_x + shank_len * math.sin(math.radians(shank_deg))
    ankle_y = knee_y + shank_len * math.cos(math.radians(shank_deg))
    return {
        "nose": (centre_x, shoulder_y - 60.0),
        "left_shoulder": (centre_x + shoulder_half_width, shoulder_y),
        "right_shoulder": (centre_x - shoulder_half_width, shoulder_y),
        "left_hip": (hip_x + 20.0, hip_y),
        "right_hip": (hip_x - 20.0, hip_y),
        "left_knee": (knee_x + 20.0, knee_y),
        "right_knee": (knee_x - 20.0, knee_y),
        "left_ankle": (ankle_x + 20.0, ankle_y),
        "right_ankle": (ankle_x - 20.0, ankle_y),
    }


class TestGeometryIsClosedForm:
    """V1: every quantity must equal its mathematical definition."""

    def test_vertical_segment_reads_zero_from_gravity(self) -> None:
        frame = parse_frame_record(build_record(upright_person()), image=GEOMETRY)
        angle = segment_angle_from_gravity(frame, LEFT_HIP, LEFT_KNEE, name="thigh")
        assert angle is not None
        assert angle.value == pytest.approx(0.0, abs=1e-9)

    @pytest.mark.parametrize("expected_deg", [10.0, 30.0, 45.0, 60.0, 80.0])
    def test_segment_angle_recovers_the_constructed_angle(self, expected_deg: float) -> None:
        points = upright_person(thigh_deg=expected_deg)
        frame = parse_frame_record(build_record(points), image=GEOMETRY)
        angle = segment_angle_from_gravity(frame, LEFT_HIP, LEFT_KNEE, name="thigh")
        assert angle is not None
        assert angle.value == pytest.approx(expected_deg, abs=1e-6)

    def test_straight_leg_gives_a_straight_joint_angle(self) -> None:
        frame = parse_frame_record(build_record(upright_person()), image=GEOMETRY)
        knee = joint_angle(frame, LEFT_HIP, LEFT_KNEE, 15, name="knee")
        assert knee is not None
        assert knee.value == pytest.approx(180.0, abs=1e-6)

    def test_angles_are_computed_in_pixel_space_not_normalised_space(self) -> None:
        """A 45 deg segment must read 45 deg, not the 29.4 deg a 16:9 image fakes."""

        points = upright_person(thigh_deg=45.0)
        frame = parse_frame_record(build_record(points), image=GEOMETRY)
        angle = segment_angle_from_gravity(frame, LEFT_HIP, LEFT_KNEE, name="thigh")
        assert angle is not None
        assert angle.value == pytest.approx(45.0, abs=1e-6)

        naive = math.degrees(
            math.atan2(
                abs(frame.xy[LEFT_KNEE][0] / WIDTH - frame.xy[LEFT_HIP][0] / WIDTH),
                abs(frame.xy[LEFT_KNEE][1] / HEIGHT - frame.xy[LEFT_HIP][1] / HEIGHT),
            )
        )
        assert naive == pytest.approx(29.4, abs=0.3)


class TestUncertainty:
    def test_shorter_segments_carry_larger_angular_uncertainty(self) -> None:
        frame = parse_frame_record(build_record(upright_person()), image=GEOMETRY)
        long_segment = segment_angle_from_gravity(frame, LEFT_HIP, LEFT_KNEE, name="thigh")
        short_segment = segment_angle_from_gravity(
            frame, LEFT_SHOULDER, RIGHT_SHOULDER, name="shoulders"
        )
        assert long_segment is not None and short_segment is not None
        assert short_segment.sigma > long_segment.sigma

    def test_minimum_length_matches_the_measured_budget(self) -> None:
        assert min_segment_length_for_angle_budget(1.31, 5.0) == pytest.approx(21.2, abs=0.3)
        assert min_segment_length_for_angle_budget(1.31, 10.0) == pytest.approx(10.6, abs=0.3)

    def test_a_value_straddling_the_threshold_is_inconclusive(self) -> None:
        frame = parse_frame_record(build_record(upright_person()), image=GEOMETRY)
        angle = segment_angle_from_gravity(frame, LEFT_HIP, LEFT_KNEE, name="thigh")
        assert angle is not None
        straddling = angle.value + 0.5 * angle.sigma
        assert not angle.below(straddling)
        assert not angle.above(straddling)


class TestSagittalObservability:
    def test_side_on_subject_reports_high_sagittal_observability(self) -> None:
        points = upright_person(shoulder_half_width=6.0)
        frame = parse_frame_record(build_record(points), image=GEOMETRY)
        quantity = sagittal_observability(frame)
        assert quantity is not None
        assert quantity.value > 0.9

    def test_frontal_subject_reports_low_sagittal_observability(self) -> None:
        points = upright_person(shoulder_half_width=43.0)
        frame = parse_frame_record(build_record(points), image=GEOMETRY)
        quantity = sagittal_observability(frame)
        assert quantity is not None
        assert quantity.value < 0.3

    def test_impossible_shoulder_width_reports_zero_rather_than_confidence(self) -> None:
        points = upright_person(shoulder_half_width=200.0)
        frame = parse_frame_record(build_record(points), image=GEOMETRY)
        quantity = sagittal_observability(frame)
        assert quantity is not None
        assert quantity.value == 0.0
        assert "inconsistent" in quantity.note


class TestClassification:
    def test_upright_person_is_standing(self) -> None:
        frame = parse_frame_record(build_record(upright_person()), image=GEOMETRY)
        verdict = classify_frame(frame)
        assert verdict.posture == "standing"
        assert verdict.abstain_reason is None

    def test_standing_verdict_explains_itself(self) -> None:
        frame = parse_frame_record(build_record(upright_person()), image=GEOMETRY)
        verdict = classify_frame(frame)
        standing = next(item for item in verdict.evidence if item.posture == "standing")
        names = {criterion.name for criterion in standing.criteria}
        assert {"trunk_upright", "thigh_near_vertical", "knee_extended"} <= names
        assert all(criterion.support == "supports" for criterion in standing.criteria)
        for criterion in standing.criteria:
            assert criterion.threshold.source, "every threshold must state its provenance"

    def test_absent_person_abstains(self) -> None:
        record = build_record(upright_person(), detected=False)
        verdict = classify_frame(parse_frame_record(record, image=GEOMETRY))
        assert verdict.posture == "unknown"
        assert verdict.abstain_reason == "no person detected"

    def test_seated_geometry_is_withheld_until_validated(self) -> None:
        """Sitting criteria may fire, but the released label stays unknown."""

        points = upright_person(thigh_deg=85.0, shank_deg=0.0, shoulder_half_width=6.0)
        verdict = classify_frame(parse_frame_record(build_record(points), image=GEOMETRY))
        assert verdict.posture == "unknown"
        assert "sitting" in verdict.shadow_candidates
        assert verdict.abstain_reason is not None
        assert "not validated" in verdict.abstain_reason

    def test_enabling_a_class_releases_it(self) -> None:
        points = upright_person(thigh_deg=85.0, shank_deg=0.0, shoulder_half_width=6.0)
        frame = parse_frame_record(build_record(points), image=GEOMETRY)
        verdict = classify_frame(
            frame, released_classes=DEFAULT_RELEASED_CLASSES | {"sitting"}
        )
        assert verdict.posture == "sitting"

    def test_frontal_view_withholds_sagittal_classes(self) -> None:
        points = upright_person(thigh_deg=85.0, shoulder_half_width=43.0)
        verdict = classify_frame(parse_frame_record(build_record(points), image=GEOMETRY))
        sitting = next(item for item in verdict.evidence if item.posture == "sitting")
        assert sitting.unavailable_reason is not None
        assert verdict.posture == "unknown"

    def test_one_bent_knee_still_reads_as_standing(self) -> None:
        """Stance needs one supporting limb; the other leg is free."""

        points = upright_person()
        points["left_knee"] = (points["left_knee"][0] + 60.0, points["left_knee"][1])
        verdict = classify_frame(parse_frame_record(build_record(points), image=GEOMETRY))
        assert verdict.posture == "standing"


class TestRecordParsing:
    def test_accepts_the_adr_0003_record_shape(self) -> None:
        record = build_record(upright_person())
        legacy = {
            "schema": record["schema_version"],
            "frame_index": record["frame_index"],
            "timestamp_ms": record["timestamp_ms"],
            "torso_detected": True,
            "keypoints": record["keypoints"],
        }
        frame = parse_frame_record(legacy, image=GEOMETRY)
        assert frame.person_detected is True

    def test_rejects_wrong_keypoint_count(self) -> None:
        record = build_record(upright_person())
        record["keypoints"] = record["keypoints"][:16]
        with pytest.raises(BiomechError, match="17 keypoints"):
            parse_frame_record(record, image=GEOMETRY)

    def test_rejects_reordered_keypoints(self) -> None:
        record = build_record(upright_person())
        record["keypoints"][0]["name"] = "left_ankle"
        with pytest.raises(BiomechError, match="nose"):
            parse_frame_record(record, image=GEOMETRY)

    def test_rejects_non_unit_gravity(self) -> None:
        with pytest.raises(BiomechError, match="unit vector"):
            ImageGeometry(width=WIDTH, height=HEIGHT, gravity_x=1.0, gravity_y=1.0)


def make_record(posture: str, timestamp_ms: float, index: int = 0) -> PostureRecord:
    return PostureRecord(
        scene_id="test-scene",
        timestamp_ms=timestamp_ms,
        frame_index=index,
        posture=posture,
        confidence=0.8,
        abstain_reason=None if posture != "unknown" else "no class criteria fully met",
        evidence={},
    )


class TestStore:
    def test_at_returns_the_posture_in_force(self) -> None:
        store = PostureStore()
        store.extend(
            [make_record("standing", 0.0), make_record("standing", 1000.0, 1)]
        )
        assert store.at(-1.0) is None
        assert store.at(500.0) is not None
        found = store.at(500.0)
        assert found is not None and found.timestamp_ms == 0.0

    def test_range_is_half_open(self) -> None:
        store = PostureStore()
        store.extend([make_record("standing", float(i * 100), i) for i in range(10)])
        found = store.range(200.0, 500.0)
        assert [item.timestamp_ms for item in found] == [200.0, 300.0, 400.0]

    def test_out_of_order_arrivals_are_sorted_on_read(self) -> None:
        store = PostureStore()
        store.append(make_record("standing", 900.0, 9))
        store.append(make_record("standing", 100.0, 1))
        assert [item.timestamp_ms for item in store.all()] == [100.0, 900.0]
        latest = store.latest()
        assert latest is not None and latest.timestamp_ms == 900.0

    def test_rejects_inverted_range(self) -> None:
        with pytest.raises(PostureStoreError, match="end_ms"):
            PostureStore().range(500.0, 100.0)

    def test_round_trips_through_disk(self, tmp_path: Path) -> None:
        path = tmp_path / "posture.jsonl"
        store = PostureStore(path)
        store.extend([make_record("standing", 0.0), make_record("unknown", 200.0, 1)])
        reloaded = PostureStore(path)
        reloaded.load()
        assert [item.posture for item in reloaded.all()] == ["standing", "unknown"]

    def test_a_truncated_final_line_is_dropped_not_fatal(self, tmp_path: Path) -> None:
        """A writer killed mid-append must not make the whole stream unreadable."""

        path = tmp_path / "posture.jsonl"
        store = PostureStore(path)
        store.append(make_record("standing", 0.0))
        with path.open("a", encoding="utf-8") as stream:
            stream.write('{"schema_version": "reme-posture-record/v0-exp')
        reloaded = PostureStore(path)
        reloaded.load()
        assert len(reloaded) == 1


class TestTimeline:
    def test_runs_collapse_into_intervals(self) -> None:
        records = [
            make_record("standing", 0.0, 0),
            make_record("standing", 100.0, 1),
            make_record("unknown", 200.0, 2),
            make_record("standing", 300.0, 3),
        ]
        timeline = build_timeline(records)
        assert [item.posture for item in timeline] == ["standing", "unknown", "standing"]
        assert timeline[0].start_ms == 0.0
        assert timeline[0].end_ms == 200.0
        assert timeline[0].frame_count == 2

    def test_intervals_tile_without_gaps(self) -> None:
        records = [
            make_record("standing", 0.0, 0),
            make_record("unknown", 500.0, 1),
            make_record("standing", 900.0, 2),
        ]
        timeline = build_timeline(records)
        for earlier, later in zip(timeline, timeline[1:], strict=False):
            assert earlier.end_ms == later.start_ms

    def test_no_interval_has_negative_duration(self) -> None:
        records = [
            make_record("standing", 500.0, 0),
            make_record("unknown", 100.0, 1),
            make_record("standing", 300.0, 2),
        ]
        for interval in build_timeline(records):
            assert interval.duration_ms >= 0.0

    def test_short_runs_can_be_filtered(self) -> None:
        records = [
            make_record("standing", 0.0, 0),
            make_record("unknown", 100.0, 1),
            make_record("standing", 150.0, 2),
            make_record("standing", 2000.0, 3),
        ]
        timeline = build_timeline(records, min_duration_ms=100.0)
        assert all(item.duration_ms >= 100.0 for item in timeline)


REAL_CLIP = Path(".scratch/posture-classifier-theory/data/movenet17-real-2370.jsonl")


@pytest.mark.skipif(not REAL_CLIP.exists(), reason="derived keypoint copy is git-ignored")
def test_real_clip_is_predominantly_standing() -> None:
    """V4: the only real human footage is 79 s of standing; nothing else may win."""

    labels: dict[str, int] = {}
    with REAL_CLIP.open(encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            frame = parse_frame_record(json.loads(line), image=GEOMETRY)
            verdict = classify_frame(frame)
            labels[verdict.posture] = labels.get(verdict.posture, 0) + 1
    total = sum(labels.values())
    assert total == 2370
    assert labels.get("standing", 0) / total > 0.95
    assert set(labels) <= {"standing", "unknown"}


class TestAxisSeparation:
    """The trunk axis and the whole-body long axis are different quantities."""

    def test_seated_pose_separates_trunk_from_body_axis(self) -> None:
        points = upright_person(trunk_deg=0.0, thigh_deg=85.0, shoulder_half_width=6.0)
        frame = parse_frame_record(build_record(points), image=GEOMETRY)
        trunk = principal_axis_angle(
            frame, indices=TRUNK_AXIS_INDICES, name="trunk", minimum_points=3
        )
        body = principal_axis_angle(frame, indices=BODY_AXIS_INDICES, name="body")
        assert trunk is not None and body is not None
        # The trunk is upright; the L-shaped whole-body cloud is not, so a single
        # axis cannot serve both roles.
        assert trunk[0].value < 10.0
        assert body[0].value > trunk[0].value + 10.0

    def test_upright_pose_leaves_both_axes_agreeing(self) -> None:
        frame = parse_frame_record(build_record(upright_person()), image=GEOMETRY)
        trunk = principal_axis_angle(
            frame, indices=TRUNK_AXIS_INDICES, name="trunk", minimum_points=3
        )
        body = principal_axis_angle(frame, indices=BODY_AXIS_INDICES, name="body")
        assert trunk is not None and body is not None
        assert abs(trunk[0].value - body[0].value) < 2.0


class TestRollTolerance:
    """Uncalibrated camera roll dominates vertical-order sign tests."""

    def test_horizontally_separated_pair_carries_roll_uncertainty(self) -> None:
        seated = upright_person(thigh_deg=85.0, shoulder_half_width=6.0)
        frame = parse_frame_record(build_record(seated), image=GEOMETRY)
        margin = vertical_order_margin(frame, LEFT_HIP, LEFT_KNEE, name="hip_above_knee")
        assert margin is not None
        # Jitter alone would be under 2 px; the roll term must dominate once the
        # pair is ~100 px apart horizontally.
        assert margin.sigma > 4.0
        assert "roll term" in margin.note

    def test_calibrated_gravity_removes_the_roll_term(self) -> None:
        calibrated = ImageGeometry(
            width=WIDTH,
            height=HEIGHT,
            size_provenance="measured",
            gravity_provenance="measured",
        )
        seated = upright_person(thigh_deg=85.0, shoulder_half_width=6.0)
        frame = parse_frame_record(build_record(seated), image=calibrated)
        margin = vertical_order_margin(frame, LEFT_HIP, LEFT_KNEE, name="hip_above_knee")
        assert margin is not None
        assert margin.sigma < 2.0

    def test_vertically_aligned_pair_is_barely_affected(self) -> None:
        """Standing must not pay the roll penalty: hip and knee are nearly plumb."""

        frame = parse_frame_record(build_record(upright_person()), image=GEOMETRY)
        margin = vertical_order_margin(frame, LEFT_HIP, LEFT_KNEE, name="hip_above_knee")
        assert margin is not None
        assert "roll term 0.00 px" in margin.note

        seated = upright_person(thigh_deg=85.0, shoulder_half_width=6.0)
        seated_frame = parse_frame_record(build_record(seated), image=GEOMETRY)
        seated_margin = vertical_order_margin(
            seated_frame, LEFT_HIP, LEFT_KNEE, name="hip_above_knee"
        )
        assert seated_margin is not None
        assert seated_margin.sigma > 2.0 * margin.sigma
