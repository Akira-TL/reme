"""Window features derived from a derived-motion sequence.

The features stay inside the published motion-data contract: torso angle,
normalized body-center height, and visibility. No pixels, no identity signal.

Quality numbers (visible ratio, minimum visibility) are returned separately from
the model features on purpose. Quality decides whether the pipeline is allowed
to answer at all; it must not become a shortcut the classifier learns from.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from statistics import fmean, median

FEATURE_NAMES: tuple[str, ...] = (
    "net_angle_change_deg",
    "max_window_angle_change_deg",
    "center_drop",
    "max_window_center_drop",
    "peak_angular_velocity_deg_s",
    "transition_duration_s",
    "impulsiveness",
    "peak_velocity_position",
    "recovery_ratio",
)

MIN_VISIBILITY = 0.60
MIN_VISIBLE_SAMPLES = 8
MIN_VISIBLE_RATIO = 0.55
BASELINE_WINDOW_MS = 2500


@dataclass(frozen=True, slots=True)
class WindowFeatures:
    """Model features plus the quality evidence used for abstention."""

    values: tuple[float, ...]
    visible_ratio: float
    minimum_visibility: float

    def as_dict(self) -> dict[str, float]:
        return dict(zip(FEATURE_NAMES, self.values, strict=True))


def _smooth(values: Sequence[float]) -> list[float]:
    if len(values) < 3:
        return list(values)
    smoothed = [values[0]]
    for index in range(1, len(values) - 1):
        smoothed.append(fmean(values[index - 1 : index + 2]))
    smoothed.append(values[-1])
    return smoothed


def _edge_median(values: Sequence[float], *, fraction: float, from_end: bool) -> float:
    count = max(int(len(values) * fraction), 1)
    return median(values[-count:] if from_end else values[:count])


def _max_window_gain(times_s: Sequence[float], values: Sequence[float], *, window_ms: int) -> float:
    """Largest increase observed inside any sub-window no longer than window_ms."""

    window_s = window_ms / 1000.0
    best = 0.0
    start = 0
    for end in range(len(values)):
        while times_s[end] - times_s[start] > window_s:
            start += 1
        running_min = min(values[start : end + 1])
        best = max(best, values[end] - running_min)
    return best


def extract_features(samples: Sequence[object]) -> WindowFeatures | None:
    """Return window features, or None when the sequence cannot support a decision.

    Accepts any object exposing offset_ms, torso_angle_deg, center_y and
    visibility, so both synthetic samples and reme.motion.MotionObservation work.
    """

    if not samples:
        return None

    visible = [sample for sample in samples if getattr(sample, "visibility") >= MIN_VISIBILITY]
    visible_ratio = len(visible) / len(samples)
    if len(visible) < MIN_VISIBLE_SAMPLES or visible_ratio < MIN_VISIBLE_RATIO:
        return None

    visible.sort(key=lambda sample: getattr(sample, "offset_ms"))
    times_s = [getattr(sample, "offset_ms") / 1000.0 for sample in visible]
    angles = _smooth([float(getattr(sample, "torso_angle_deg")) for sample in visible])
    centers = _smooth([float(getattr(sample, "center_y")) for sample in visible])

    baseline_angle = _edge_median(angles, fraction=0.2, from_end=False)
    final_angle = _edge_median(angles, fraction=0.2, from_end=True)
    net_angle_change = final_angle - baseline_angle
    center_drop = _edge_median(centers, fraction=0.2, from_end=True) - _edge_median(
        centers, fraction=0.2, from_end=False
    )

    angular_velocity: list[float] = []
    for index in range(1, len(angles)):
        delta_t = max(times_s[index] - times_s[index - 1], 1e-3)
        angular_velocity.append((angles[index] - angles[index - 1]) / delta_t)

    peak_velocity = max(angular_velocity) if angular_velocity else 0.0
    peak_index = angular_velocity.index(peak_velocity) if angular_velocity else 0

    span = max(angles) - min(angles)
    if net_angle_change > 5.0:
        low_threshold = baseline_angle + 0.1 * net_angle_change
        high_threshold = baseline_angle + 0.9 * net_angle_change
        start_index = next(
            (index for index, angle in enumerate(angles) if angle >= low_threshold), 0
        )
        end_index = next(
            (
                index
                for index in range(len(angles) - 1, -1, -1)
                if angles[index] <= high_threshold
            ),
            len(angles) - 1,
        )
        transition_start_s = times_s[min(start_index, end_index)]
        transition_end_s = times_s[max(start_index, end_index)]
    else:
        transition_start_s = times_s[0]
        transition_end_s = times_s[-1]

    duration_s = max(transition_end_s - transition_start_s, 0.05)
    inside = [
        velocity
        for index, velocity in enumerate(angular_velocity)
        if transition_start_s <= times_s[index + 1] <= transition_end_s
    ]
    mean_abs_velocity = fmean([abs(value) for value in inside]) if inside else 0.0
    impulsiveness = min(peak_velocity / (mean_abs_velocity + 1e-3), 50.0)
    peak_position = min(max((times_s[peak_index + 1] - transition_start_s) / duration_s, 0.0), 1.0)
    recovery_ratio = (max(angles) - final_angle) / span if span > 1e-6 else 0.0

    values = (
        net_angle_change,
        _max_window_gain(times_s, angles, window_ms=BASELINE_WINDOW_MS),
        center_drop,
        _max_window_gain(times_s, centers, window_ms=BASELINE_WINDOW_MS),
        peak_velocity,
        duration_s,
        impulsiveness,
        peak_position,
        recovery_ratio,
    )
    # Window visibility is measured over every sample in the window, including the
    # dropped ones, so a gap inside the transition still shows up as low quality.
    window_visibility = [
        float(getattr(sample, "visibility"))
        for sample in samples
        if transition_start_s <= getattr(sample, "offset_ms") / 1000.0 <= transition_end_s
    ]
    return WindowFeatures(
        values=values,
        visible_ratio=visible_ratio,
        minimum_visibility=min(window_visibility) if window_visibility else 0.0,
    )
