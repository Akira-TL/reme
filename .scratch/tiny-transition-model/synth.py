"""Deterministic synthetic motion sequences in the MotionObservation schema.

This generator is an explicit hypothesis, not measured footage. It encodes one
biomechanical assumption that the experiment is built to test:

    a controlled descent decelerates before it reaches the floor, while a
    fall-like transition accelerates into an impact and then goes still.

Every parameter range below is an assumption written by hand. No range comes
from the supplied video, so no number produced from this data may be reported
as Reme accuracy on real footage.
"""

from __future__ import annotations

import random
from collections.abc import Sequence
from dataclasses import dataclass

SAMPLE_INTERVAL_MS = 50
SEQUENCE_DURATION_MS = 6000

FALL_LIKE = "fall_like_transition"
NORMAL = "normal_transition"


@dataclass(frozen=True, slots=True)
class Sample:
    """One synthetic observation, field-compatible with reme.motion.MotionObservation."""

    offset_ms: int
    torso_angle_deg: float
    center_y: float
    visibility: float


@dataclass(frozen=True, slots=True)
class Sequence_:
    """A labelled synthetic sequence."""

    scenario: str
    label: str
    samples: tuple[Sample, ...]


FALL_SCENARIOS = ("forward_collapse", "backward_fall", "slip_from_sitting", "slow_slide")
NORMAL_SCENARIOS = ("controlled_lie_down", "fast_lie_down", "sit_down", "bend_pick_up", "stand_idle")


def _ease(u: float, shape: float) -> float:
    """Map progress 0..1 to displacement 0..1.

    shape == 1.0 gives smoothstep: symmetric, decelerating into the target.
    shape > 1.0 biases the peak velocity towards the end, i.e. impact-like.
    """

    u = min(max(u, 0.0), 1.0)
    smooth = u * u * (3.0 - 2.0 * u)
    if shape <= 1.0:
        return smooth
    accelerating = u**shape
    weight = min((shape - 1.0) / 1.5, 1.0)
    return (1.0 - weight) * smooth + weight * accelerating


@dataclass(frozen=True, slots=True)
class _Key:
    at_ms: float
    angle_deg: float
    center_y: float
    shape: float = 1.0


def _interpolate(keys: Sequence[_Key], at_ms: float) -> tuple[float, float]:
    if at_ms <= keys[0].at_ms:
        return keys[0].angle_deg, keys[0].center_y
    for previous, current in zip(keys, keys[1:], strict=False):
        if at_ms <= current.at_ms:
            span = max(current.at_ms - previous.at_ms, 1.0)
            progress = _ease((at_ms - previous.at_ms) / span, current.shape)
            angle = previous.angle_deg + progress * (current.angle_deg - previous.angle_deg)
            center = previous.center_y + progress * (current.center_y - previous.center_y)
            return angle, center
    return keys[-1].angle_deg, keys[-1].center_y


def _fall_keys(rng: random.Random, scenario: str) -> list[_Key]:
    start_ms = rng.uniform(1200.0, 2600.0)
    if scenario == "slip_from_sitting":
        angle0 = rng.uniform(20.0, 38.0)
        center0 = rng.uniform(0.44, 0.54)
        drop = rng.uniform(0.16, 0.28)
        duration = rng.uniform(400.0, 900.0)
    elif scenario == "slow_slide":
        angle0 = rng.uniform(5.0, 18.0)
        center0 = rng.uniform(0.32, 0.42)
        drop = rng.uniform(0.22, 0.36)
        duration = rng.uniform(1100.0, 1800.0)
    else:
        angle0 = rng.uniform(4.0, 16.0)
        center0 = rng.uniform(0.30, 0.42)
        drop = rng.uniform(0.24, 0.44)
        duration = rng.uniform(350.0, 950.0)

    angle1 = min(rng.uniform(76.0, 96.0), 180.0)
    center1 = min(center0 + drop, 0.97)
    overshoot = rng.uniform(2.0, 8.0)
    return [
        _Key(0.0, angle0, center0),
        _Key(start_ms, angle0, center0),
        _Key(start_ms + duration, min(angle1 + overshoot, 180.0), center1, shape=rng.uniform(1.9, 2.6)),
        _Key(start_ms + duration + rng.uniform(120.0, 260.0), angle1, center1),
        _Key(float(SEQUENCE_DURATION_MS), angle1, center1),
    ]


def _normal_keys(rng: random.Random, scenario: str) -> list[_Key]:
    start_ms = rng.uniform(1200.0, 2400.0)
    angle0 = rng.uniform(4.0, 18.0)
    center0 = rng.uniform(0.30, 0.42)

    if scenario == "controlled_lie_down":
        sit_ms = rng.uniform(900.0, 1500.0)
        pause_ms = rng.uniform(200.0, 700.0)
        lie_ms = rng.uniform(1100.0, 2000.0)
        sit_angle = rng.uniform(28.0, 46.0)
        sit_center = center0 + rng.uniform(0.06, 0.12)
        lie_angle = rng.uniform(74.0, 92.0)
        lie_center = min(sit_center + rng.uniform(0.10, 0.20), 0.97)
        return [
            _Key(0.0, angle0, center0),
            _Key(start_ms, angle0, center0),
            _Key(start_ms + sit_ms, sit_angle, sit_center),
            _Key(start_ms + sit_ms + pause_ms, sit_angle, sit_center),
            _Key(start_ms + sit_ms + pause_ms + lie_ms, lie_angle, lie_center),
            _Key(float(SEQUENCE_DURATION_MS), lie_angle, lie_center),
        ]

    if scenario == "fast_lie_down":
        duration = rng.uniform(850.0, 1600.0)
        lie_angle = rng.uniform(72.0, 92.0)
        lie_center = min(center0 + rng.uniform(0.20, 0.34), 0.97)
        return [
            _Key(0.0, angle0, center0),
            _Key(start_ms, angle0, center0),
            _Key(start_ms + duration, lie_angle, lie_center, shape=rng.uniform(1.0, 1.3)),
            _Key(float(SEQUENCE_DURATION_MS), lie_angle, lie_center),
        ]

    if scenario == "sit_down":
        duration = rng.uniform(700.0, 1600.0)
        sit_angle = rng.uniform(16.0, 38.0)
        sit_center = min(center0 + rng.uniform(0.08, 0.17), 0.97)
        return [
            _Key(0.0, angle0, center0),
            _Key(start_ms, angle0, center0),
            _Key(start_ms + duration, sit_angle, sit_center),
            _Key(float(SEQUENCE_DURATION_MS), sit_angle, sit_center),
        ]

    if scenario == "bend_pick_up":
        down_ms = rng.uniform(600.0, 1100.0)
        hold_ms = rng.uniform(300.0, 900.0)
        up_ms = rng.uniform(700.0, 1300.0)
        bend_angle = rng.uniform(56.0, 82.0)
        bend_center = min(center0 + rng.uniform(0.10, 0.20), 0.97)
        return [
            _Key(0.0, angle0, center0),
            _Key(start_ms, angle0, center0),
            _Key(start_ms + down_ms, bend_angle, bend_center),
            _Key(start_ms + down_ms + hold_ms, bend_angle, bend_center),
            _Key(start_ms + down_ms + hold_ms + up_ms, angle0 + rng.uniform(-3.0, 3.0), center0),
            _Key(float(SEQUENCE_DURATION_MS), angle0, center0),
        ]

    drift = rng.uniform(-4.0, 4.0)
    return [
        _Key(0.0, angle0, center0),
        _Key(float(SEQUENCE_DURATION_MS), max(angle0 + drift, 0.0), center0 + rng.uniform(-0.02, 0.02)),
    ]


def _visibility_track(rng: random.Random) -> list[float]:
    count = SEQUENCE_DURATION_MS // SAMPLE_INTERVAL_MS
    base = rng.uniform(0.82, 0.97)
    track = [min(max(base + rng.gauss(0.0, 0.02), 0.0), 1.0) for _ in range(count)]
    draw = rng.random()
    if draw < 0.08:
        # Severe occlusion or the person leaving frame: no system should answer.
        dropout_len = rng.randrange(55, 95)
    elif draw < 0.28:
        dropout_len = rng.randrange(6, 30)
    else:
        return track

    dropout_start = rng.randrange(0, max(count - 12, 1))
    for index in range(dropout_start, min(dropout_start + dropout_len, count)):
        track[index] = min(max(rng.uniform(0.08, 0.48), 0.0), 1.0)
    return track


def generate_sequence(rng: random.Random, scenario: str) -> Sequence_:
    """Build one labelled sequence for the given scenario."""

    is_fall = scenario in FALL_SCENARIOS
    keys = _fall_keys(rng, scenario) if is_fall else _normal_keys(rng, scenario)
    angle_noise = rng.uniform(1.2, 3.0)
    center_noise = rng.uniform(0.005, 0.012)
    visibility = _visibility_track(rng)

    samples: list[Sample] = []
    for index, vis in enumerate(visibility):
        at_ms = index * SAMPLE_INTERVAL_MS
        angle, center = _interpolate(keys, float(at_ms))
        # Low-visibility frames are noisier, the way a weak skeleton estimate is.
        quality_penalty = 1.0 if vis >= 0.6 else 3.0
        angle += rng.gauss(0.0, angle_noise * quality_penalty)
        center += rng.gauss(0.0, center_noise * quality_penalty)
        samples.append(
            Sample(
                offset_ms=at_ms,
                torso_angle_deg=min(max(angle, 0.0), 180.0),
                center_y=min(max(center, 0.0), 1.0),
                visibility=vis,
            )
        )
    return Sequence_(scenario=scenario, label=FALL_LIKE if is_fall else NORMAL, samples=tuple(samples))


def generate_dataset(*, seed: int, sequences_per_scenario: int) -> list[Sequence_]:
    """Generate a balanced, deterministic dataset ordered scenario by scenario."""

    rng = random.Random(seed)
    dataset: list[Sequence_] = []
    for scenario in (*FALL_SCENARIOS, *NORMAL_SCENARIOS):
        for _ in range(sequences_per_scenario):
            dataset.append(generate_sequence(rng, scenario))
    return dataset
