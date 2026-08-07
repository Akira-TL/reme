"""Time-indexed view over A's PostureObservation stream.

A owns perception: it decides the posture, its confidence, and how long that
posture has held.  This module does not classify anything and must never start
to.  It answers the questions a *consumer* has once A's facts arrive:

- what posture was in force at a given moment (C seeking through a replay);
- which observations fall in a window (B assembling decision context);
- how the stream collapses into contiguous intervals (the timeline C renders
  and D presents);
- how long the person has been both in a given posture set *and* not moving.

That last one is the only derived fact here, and it is the reason the module
exists rather than being a thin wrapper.  A reports ``posture_duration_ms`` for
the posture alone; combining posture with ``motion_level`` across successive
observations is a consumer-side question A deliberately does not answer, because
A supplies objective movement facts and does not decide care semantics.

It matters clinically.  The geriatric literature locates the harm not in the
instant of a fall but in the immobility that follows it: Schwickert et al. 2017
found post-fall resting beyond roughly 24.5 s predicted inability to rise
unaided, and Fleming & Brayne 2008 found that among fallers over 90, most were
unable to get up at least once and a substantial share lay for an hour or more,
with long lies strongly associated with serious injury.  Sustained immobility is
also far more observable from a single uncalibrated camera than the impact of a
fall itself.

Nothing here is a medical claim, a risk level, or an alarm.  This module reports
a duration; whether that duration means anything is B's decision.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

from reme.runtime.decision.context import (
    MotionLevel,
    Posture,
    PostureObservation,
    SceneStreamError,
    load_posture_observations,
)

TIMELINE_SCHEMA_VERSION = "reme-posture-timeline/v0-experiment"

#: Motion levels that count as "not moving" for sustained-stillness accounting.
#: ``unknown`` is excluded on purpose: absence of evidence is not evidence of
#: stillness, and treating it as such would inflate exactly the duration that
#: matters most.
STILL_MOTION_LEVELS: frozenset[MotionLevel] = frozenset({MotionLevel.STILL})

#: Postures where sustained immobility is worth measuring.  ``unknown`` is
#: excluded for the same reason as above.
DOWN_POSTURES: frozenset[Posture] = frozenset({Posture.LYING, Posture.SITTING})


class PostureTimelineError(ValueError):
    """Raised when a timeline query or stream is malformed."""


@dataclass(frozen=True, slots=True)
class PostureInterval:
    """One contiguous run of a single posture."""

    posture: Posture
    start_ms: float
    end_ms: float
    observation_count: int
    mean_confidence: float

    @property
    def duration_ms(self) -> float:
        return self.end_ms - self.start_ms

    def to_payload(self) -> dict[str, object]:
        return {
            "posture": self.posture.value,
            "start_ms": round(self.start_ms, 3),
            "end_ms": round(self.end_ms, 3),
            "duration_ms": round(self.duration_ms, 3),
            "observation_count": self.observation_count,
            "mean_confidence": round(self.mean_confidence, 6),
        }


class PostureTimeline:
    """Ordered, queryable view of one scene's posture observations.

    A's stream is the source of truth and is not copied back to disk here; this
    is an index over it, not a second store.  Observations may arrive out of
    order on a live transport, so ordering is established on read rather than
    assumed on write.
    """

    def __init__(self, scene_id: str) -> None:
        if not isinstance(scene_id, str) or not scene_id.strip():
            raise PostureTimelineError("scene_id must be a non-empty string")
        self.scene_id = scene_id.strip()
        self._observations: list[PostureObservation] = []
        self._times: list[float] = []
        self._sorted = True

    @classmethod
    def from_stream(cls, path: str | Path, *, scene_id: str) -> PostureTimeline:
        """Build a timeline from one of A's posture_observations.jsonl files."""

        timeline = cls(scene_id)
        try:
            observations = load_posture_observations(path, expected_scene_id=scene_id)
        except SceneStreamError as exc:
            raise PostureTimelineError(str(exc)) from exc
        timeline.extend(observations)
        return timeline

    def append(self, observation: PostureObservation) -> None:
        """Add one observation, rejecting anything from another scene."""

        if observation.scene_id != self.scene_id:
            raise PostureTimelineError(
                f"observation belongs to scene {observation.scene_id!r}, not {self.scene_id!r}"
            )
        if self._observations and observation.timestamp_ms < self._observations[-1].timestamp_ms:
            self._sorted = False
        self._observations.append(observation)

    def extend(self, observations: Iterable[PostureObservation]) -> None:
        for observation in observations:
            self.append(observation)

    def __len__(self) -> int:
        return len(self._observations)

    def _ensure_index(self) -> None:
        if not self._sorted:
            self._observations.sort(key=lambda item: item.timestamp_ms)
            self._sorted = True
        self._times = [item.timestamp_ms for item in self._observations]

    def all(self) -> tuple[PostureObservation, ...]:
        """Return every observation in ascending perception-time order."""

        self._ensure_index()
        return tuple(self._observations)

    def latest(self) -> PostureObservation | None:
        """Return the most recent observation by perception time."""

        self._ensure_index()
        return self._observations[-1] if self._observations else None

    def at(self, timestamp_ms: float) -> PostureObservation | None:
        """Return the newest observation at or before ``timestamp_ms``.

        The posture in force at a moment is the last one observed up to that
        moment.  Returning the *nearest* observation instead would let a future
        observation leak backwards into the past during a replay seek, showing a
        viewer a posture that had not been established yet.
        """

        self._ensure_index()
        if not self._observations:
            return None
        position = bisect_right(self._times, float(timestamp_ms))
        if position == 0:
            return None
        return self._observations[position - 1]

    def between(self, start_ms: float, end_ms: float) -> tuple[PostureObservation, ...]:
        """Return observations within ``[start_ms, end_ms)`` in ascending order."""

        if end_ms < start_ms:
            raise PostureTimelineError("end_ms must be >= start_ms")
        self._ensure_index()
        low = bisect_left(self._times, float(start_ms))
        high = bisect_left(self._times, float(end_ms))
        return tuple(self._observations[low:high])

    def intervals(self, *, min_duration_ms: float = 0.0) -> tuple[PostureInterval, ...]:
        """Collapse the stream into contiguous single-posture intervals."""

        self._ensure_index()
        return build_intervals(self._observations, min_duration_ms=min_duration_ms)

    def sustained_stillness_ms(
        self,
        *,
        at_ms: float | None = None,
        postures: frozenset[Posture] = DOWN_POSTURES,
        motion_levels: frozenset[MotionLevel] = STILL_MOTION_LEVELS,
    ) -> float:
        """Return how long posture and stillness have held together, in ms.

        Walks backwards from ``at_ms`` (default: the newest observation) while
        each observation is in ``postures`` *and* in ``motion_levels``, and
        returns the span covered.  Returns 0.0 when the most recent observation
        already fails either condition.

        The duration is measured between the observations that satisfy the
        condition, so it never extrapolates past the last thing actually seen.
        A gap in the stream therefore understates rather than overstates the
        duration, which is the safe direction for a number B may escalate on.
        """

        self._ensure_index()
        if not self._observations:
            return 0.0
        end_index = (
            len(self._observations) - 1
            if at_ms is None
            else bisect_right(self._times, float(at_ms)) - 1
        )
        if end_index < 0:
            return 0.0

        def qualifies(item: PostureObservation) -> bool:
            return item.posture in postures and item.motion_level in motion_levels

        if not qualifies(self._observations[end_index]):
            return 0.0
        start_index = end_index
        while start_index > 0 and qualifies(self._observations[start_index - 1]):
            start_index -= 1
        span = (
            self._observations[end_index].timestamp_ms
            - self._observations[start_index].timestamp_ms
        )
        return max(0.0, span)


def build_intervals(
    observations: Sequence[PostureObservation], *, min_duration_ms: float = 0.0
) -> tuple[PostureInterval, ...]:
    """Collapse ordered observations into runs of a single posture.

    An interval ends where the next posture begins, so intervals tile the
    observed span without gaps or overlaps.  The final interval ends at its own
    last sample, because nothing is yet known about what follows it.
    """

    if min_duration_ms < 0.0:
        raise PostureTimelineError("min_duration_ms must be non-negative")
    ordered = sorted(observations, key=lambda item: item.timestamp_ms)
    runs = list(_runs(ordered))
    intervals: list[PostureInterval] = []
    for position, run in enumerate(runs):
        first, last = run[0], run[-1]
        following = runs[position + 1][0].timestamp_ms if position + 1 < len(runs) else None
        # Clamping to the run's own start keeps a timestamp regression from
        # producing a negative duration; the run still appears, with zero width.
        end_ms = max(following if following is not None else last.timestamp_ms, first.timestamp_ms)
        interval = PostureInterval(
            posture=first.posture,
            start_ms=first.timestamp_ms,
            end_ms=end_ms,
            observation_count=len(run),
            mean_confidence=sum(item.posture_confidence for item in run) / len(run),
        )
        if interval.duration_ms >= min_duration_ms:
            intervals.append(interval)
    return tuple(intervals)


def _runs(ordered: Sequence[PostureObservation]) -> Iterator[list[PostureObservation]]:
    current: list[PostureObservation] = []
    for observation in ordered:
        if current and observation.posture is not current[-1].posture:
            yield current
            current = []
        current.append(observation)
    if current:
        yield current
