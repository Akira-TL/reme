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

from collections.abc import Mapping
from dataclasses import dataclass

from reme.decision.context import PerceptionStreams, Posture

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
    """

    raise NotImplementedError("L1 泳道实现")


def plausible_fall_dynamics(hints: SpatialHints) -> bool | None:
    """Physics screen for a fall hypothesis; None when evidence is insufficient."""

    raise NotImplementedError("L1 泳道实现")


def extract_behavior_features(
    streams: PerceptionStreams,
    *,
    timestamp_ms: float,
    window_ms: float = DEFAULT_WINDOW_MS,
) -> BehaviorFeatures:
    """Fold the window ``(timestamp_ms - window_ms, timestamp_ms]`` into features."""

    raise NotImplementedError("L1 泳道实现")


def behavior_summary_zh(features: BehaviorFeatures) -> str:
    """Compact Chinese digest for prompt injection (aim <= 80 chars, no diagnosis)."""

    raise NotImplementedError("L1 泳道实现")
