"""Behavior semantics: windowed features over A's frozen contract streams.

Every base feature is computable from ``PostureObservation`` /
``TransitionEvent`` alone — no new obligation lands on A.  Spatial
quantities live in the dormant superset :class:`SpatialHints`: when a
producer (A later, our synthetic fixtures today) attaches them inside
``TransitionEvent.evidence`` they are parsed and used, and their absence
never degrades the base features.  Disciplinary grounding for every
feature and threshold: docs/adr/0006-behavior-memory-home-cognition.md.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass

from reme.decision.context import (
    MotionLevel,
    PerceptionStreams,
    Posture,
    PostureObservation,
    Transition,
)

DEFAULT_WINDOW_MS = 120000.0
STILL_EPISODE_MIN_MS = 10000.0

# Physics guardband for a genuine fall's descent (ADR-0006 §physics): an
# uncontrolled centre-of-mass drop completes well inside two seconds, while
# a controlled lie-down takes longer; sub-150ms "descents" are jitter.
FALL_DESCENT_MIN_MS = 150.0
FALL_DESCENT_MAX_MS = 2000.0

EVIDENCE_DESCENT_KEY = "descent_duration_ms"
EVIDENCE_DROP_RATIO_KEY = "com_drop_ratio"
EVIDENCE_POST_IMPACT_KEY = "post_impact_motion"


@dataclass(frozen=True, slots=True)
class SpatialHints:
    """Dormant-superset spatial evidence from ``TransitionEvent.evidence``.

    Monocular uncalibrated camera: only durations and dimensionless ratios
    are claimable — never metres or velocities (ADR-0006 §limits).
    """

    descent_duration_ms: float | None
    com_drop_ratio: float | None
    post_impact_motion: float | None


@dataclass(frozen=True, slots=True)
class BehaviorFeatures:
    """One backward-looking behavior window ending at ``timestamp_ms``.

    Field contract is FROZEN: memory.py and the prompt layer consume it.
    """

    window_ms: float
    observation_count: int
    posture_change_count: int
    restlessness_score: float
    stillness_episode_count: int
    longest_still_ms: float
    sit_to_stand_count: int
    lying_to_upright_count: int
    dominant_posture: Posture | None
    fall_like_count: int
    uncertain_transition_count: int
    spatial_hints: SpatialHints | None


def parse_spatial_hints(evidence: Mapping[str, object]) -> SpatialHints | None:
    """Read the optional spatial keys from one evidence dict.

    Lenient by design (the evidence dict is contract-free): malformed values
    are treated as absent; returns None when no recognised key survives.

    ``descent_duration_ms`` must be a finite number strictly above zero;
    ``com_drop_ratio`` and ``post_impact_motion`` are dimensionless and must
    land inside 0.0..1.0.  Booleans never count as numbers (``True`` is not a
    0.001 ratio) and NaN fails every range test, so both read as absent.  A
    producer that ships junk in one key still gets the other two honoured.
    """

    def _finite_number(key: str) -> float | None:
        value = evidence.get(key)
        if isinstance(value, bool) or not isinstance(value, int | float):
            return None
        try:
            number = float(value)
        except (OverflowError, ValueError):  # ints beyond float range are junk, not a crash
            return None
        return number if math.isfinite(number) else None

    def _ratio(key: str) -> float | None:
        number = _finite_number(key)
        if number is None or not 0.0 <= number <= 1.0:
            return None
        return number

    descent_duration_ms = _finite_number(EVIDENCE_DESCENT_KEY)
    if descent_duration_ms is not None and descent_duration_ms <= 0.0:
        descent_duration_ms = None
    com_drop_ratio = _ratio(EVIDENCE_DROP_RATIO_KEY)
    post_impact_motion = _ratio(EVIDENCE_POST_IMPACT_KEY)
    if descent_duration_ms is None and com_drop_ratio is None and post_impact_motion is None:
        return None
    return SpatialHints(
        descent_duration_ms=descent_duration_ms,
        com_drop_ratio=com_drop_ratio,
        post_impact_motion=post_impact_motion,
    )


def plausible_fall_dynamics(hints: SpatialHints) -> bool | None:
    """Physics screen for a fall hypothesis; None when evidence is insufficient.

    Without a descent duration there is nothing to screen, so the answer is
    None (unknown) rather than False (implausible) — the caller must not read
    missing evidence as counter-evidence.  With a duration, the descent has to
    sit inside the guardband above, and a centre-of-mass drop ratio, when the
    producer supplies one, has to be large enough to be a real drop instead of
    a lean; a ratio-free hint is accepted on the duration alone.
    """

    if hints.descent_duration_ms is None:
        return None
    if not FALL_DESCENT_MIN_MS <= hints.descent_duration_ms <= FALL_DESCENT_MAX_MS:
        return False
    # A drop shallower than 30% of the body's vertical extent reads as a lean
    # or a crouch, not a fall (ADR-0006 §physics).
    return hints.com_drop_ratio is None or hints.com_drop_ratio >= 0.3


def _motion_band(level: MotionLevel) -> int:
    """Collapse motion levels into low/active/unknown bands for flip counting.

    STILL<->LOW jitter inside one continuous rest is categorical noise, not
    restlessness (Codex R3): only crossing between the low band and the
    active band (or into UNKNOWN) counts as a motion flip.
    """

    if level in (MotionLevel.STILL, MotionLevel.LOW):
        return 0
    if level in (MotionLevel.MEDIUM, MotionLevel.HIGH):
        return 1
    return 2


def extract_behavior_features(
    streams: PerceptionStreams,
    *,
    timestamp_ms: float,
    window_ms: float = DEFAULT_WINDOW_MS,
) -> BehaviorFeatures:
    """Fold the window ``(timestamp_ms - window_ms, timestamp_ms]`` into features.

    Observations enter the window by ``timestamp_ms`` and transitions by
    ``start_ms``.  The window opens exclusively and closes inclusively, so two
    back-to-back windows never count the same sample twice.  Both streams are
    consumed in the ascending order the contract guarantees (context.py
    rejects out-of-order rows).

    Adjacency rules: every pairwise count (posture change, motion flip,
    sit-to-stand, lying-to-upright) compares two consecutive *detected*
    observations.  An undetected sample in between breaks the chain rather
    than inventing a transition across the blind gap.

    Restlessness is ``min(1, (posture_change_count + motion_flip_count) /
    max(1, window_ms / 20000))`` — the churn counts divided by the number of
    20-second slots in the window.  Motion flips count band crossings only
    (:func:`_motion_band`): STILL<->LOW jitter is not restlessness.  It rises
    monotonically with churn, saturates at 1.0, and stays comparable across
    window sizes.

    A stillness episode is a maximal run of detected observations whose motion
    level is STILL or LOW; its duration is the span between its first and last
    sample, widened to the last sample's own ``posture_duration_ms`` when that
    reaches further back than the window's own samples do, and clamped to
    ``window_ms`` so one carried-in duration can never claim more stillness
    than the window it is reported for (Codex R3).

    ``spatial_hints`` carries the latest in-window FALL_LIKE transition that
    parses to usable hints (a later fall event with unusable evidence does not
    erase an earlier readable one).

    Raises:
        ValueError: when ``timestamp_ms`` is negative or non-finite, or
            ``window_ms`` is not a finite positive duration.
    """

    if not math.isfinite(timestamp_ms) or timestamp_ms < 0.0:
        raise ValueError("timestamp_ms must be a finite non-negative number of milliseconds")
    if not math.isfinite(window_ms) or window_ms <= 0.0:
        raise ValueError("window_ms must be a finite positive number of milliseconds")

    window_start_ms = timestamp_ms - window_ms
    observations = [
        observation
        for observation in streams.postures
        if window_start_ms < observation.timestamp_ms <= timestamp_ms
    ]

    low_motion = (MotionLevel.STILL, MotionLevel.LOW)
    upright_postures = (Posture.SITTING, Posture.STANDING)

    posture_change_count = 0
    motion_flip_count = 0
    sit_to_stand_count = 0
    lying_to_upright_count = 0
    posture_counts: dict[Posture, int] = {}
    posture_last_index: dict[Posture, int] = {}
    still_episodes: list[list[PostureObservation]] = []
    open_episode: list[PostureObservation] = []
    previous: PostureObservation | None = None

    for index, observation in enumerate(observations):
        if not observation.person_detected:
            previous = None
            if open_episode:
                still_episodes.append(open_episode)
                open_episode = []
            continue
        if previous is not None:
            if observation.posture is not previous.posture:
                posture_change_count += 1
            if _motion_band(observation.motion_level) != _motion_band(previous.motion_level):
                motion_flip_count += 1
            if previous.posture is Posture.SITTING and observation.posture is Posture.STANDING:
                sit_to_stand_count += 1
            if previous.posture is Posture.LYING and observation.posture in upright_postures:
                lying_to_upright_count += 1
        previous = observation
        posture_counts[observation.posture] = posture_counts.get(observation.posture, 0) + 1
        posture_last_index[observation.posture] = index
        if observation.motion_level in low_motion:
            open_episode.append(observation)
        elif open_episode:
            still_episodes.append(open_episode)
            open_episode = []
    if open_episode:
        still_episodes.append(open_episode)

    episode_durations = [
        min(
            max(
                episode[-1].timestamp_ms - episode[0].timestamp_ms,
                episode[-1].posture_duration_ms,
            ),
            window_ms,
        )
        for episode in still_episodes
    ]
    dominant_posture: Posture | None = None
    if posture_counts:
        dominant_posture = max(
            posture_counts,
            key=lambda posture: (posture_counts[posture], posture_last_index[posture]),
        )

    fall_like_count = 0
    uncertain_transition_count = 0
    spatial_hints: SpatialHints | None = None
    for event in streams.transitions:
        if not window_start_ms < event.start_ms <= timestamp_ms:
            continue
        if event.transition is Transition.FALL_LIKE:
            fall_like_count += 1
            hints = parse_spatial_hints(event.evidence)
            if hints is not None:
                spatial_hints = hints
        elif event.transition is Transition.UNCERTAIN:
            uncertain_transition_count += 1

    slots = max(1.0, window_ms / 20000.0)
    return BehaviorFeatures(
        window_ms=window_ms,
        observation_count=len(observations),
        posture_change_count=posture_change_count,
        restlessness_score=min(1.0, (posture_change_count + motion_flip_count) / slots),
        stillness_episode_count=sum(
            1 for duration in episode_durations if duration >= STILL_EPISODE_MIN_MS
        ),
        longest_still_ms=max(episode_durations, default=0.0),
        sit_to_stand_count=sit_to_stand_count,
        lying_to_upright_count=lying_to_upright_count,
        dominant_posture=dominant_posture,
        fall_like_count=fall_like_count,
        uncertain_transition_count=uncertain_transition_count,
        spatial_hints=spatial_hints,
    )


def behavior_summary_zh(features: BehaviorFeatures) -> str:
    """Compact Chinese digest for prompt injection (aim <= 80 chars, no diagnosis).

    Describes only what was observed — posture, movement, stillness, and the
    perception layer's own transition labels.  It never names a condition or
    an outcome: that judgement belongs downstream, to a human.  The window is
    announced in whole minutes (floored, at least one).
    """

    posture_labels: dict[Posture, str] = {
        Posture.STANDING: "站姿",
        Posture.SITTING: "坐姿",
        Posture.LYING: "躺姿",
        Posture.BENDING_OR_CROUCHING: "弯腰或蹲姿",
        Posture.UNKNOWN: "未知姿态",
    }
    minutes = max(1, int(features.window_ms // 60000.0))
    prefix = f"近{minutes}分钟："
    if features.observation_count == 0:
        return f"{prefix}无有效观察"

    parts: list[str] = []
    if features.dominant_posture is not None:
        parts.append(f"以{posture_labels[features.dominant_posture]}为主")
    parts.append(f"体位变化{features.posture_change_count}次")
    if features.longest_still_ms > 0.0:
        parts.append(f"最长静止{round(features.longest_still_ms / 1000.0)}秒")
    if features.fall_like_count > 0:
        clause = f"{features.fall_like_count}次疑似跌倒转换"
        if features.spatial_hints is not None:
            plausible = plausible_fall_dynamics(features.spatial_hints)
            if plausible is True:
                clause += "（下坠动力学合理）"
            elif plausible is False:
                clause += "（下坠动力学存疑）"
        parts.append(clause)
    if features.uncertain_transition_count > 0:
        parts.append(f"{features.uncertain_transition_count}次不确定转换")
    return prefix + "，".join(parts)
