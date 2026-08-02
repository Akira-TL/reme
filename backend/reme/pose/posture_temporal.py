"""Temporal de-jitter for posture verdicts: dwell, hysteresis, and legality.

This is the L4 layer.  Per-frame classification is correct but twitchy: on this
project's real clip the raw verdict sequence contains 120 label flips across 121
runs, and 47 of the 60 ``unknown`` runs are three frames or shorter.  Nothing a
person does changes posture in under 100 ms, so roughly half of those
abstentions are a boundary-straddling value dithering across a threshold rather
than the classifier being appropriately careful.

**Why this layer is deliberately not a sequence decoder.**  A constrained
Viterbi would smooth the sequence better, and it would also quietly destroy the
property the whole classifier is built around.  The guarantee at L2/L3 is that
the criteria *produce* the verdict, so a reader can recompute the decision from
the evidence payload alone.  A global sequence optimiser makes the emitted label
the output of a whole-sequence argmax while the payload still records only
per-frame criteria -- a reader recomputing from evidence would get a different
answer than the one emitted, which is the post-hoc rationalisation this design
refuses, relocated one layer up.  It is also unimplementable here without
inventing something: Viterbi needs per-class observation log-likelihoods, and
the criteria layer produces margins with uncertainty, not probabilities.  There
is no calibration data from which an honest likelihood could be built.

So this layer only ever does two things a reader can replay by hand: it makes a
change wait, and it refuses a change that no body can perform.  Whenever the
emitted label differs from this frame's verdict, the difference is recorded --
with which rule caused it -- so the evidence still covers what was emitted.

**What the dwell may and may not encode.**  Controlled and fall-like transitions
overlap in duration: a controlled sit-to-stand half cycle runs 1.1-1.5 s while a
fall's descent phase is 583 +/- 255 ms, whose +1.6 sigma already reaches 1.0 s.
So the transition rules here encode *ordering* and *lower bounds* only.  Nothing
in this module infers that a fast transition was a fall; duration is not
semantics, and separating controlled from fall-like needs velocity-peak shape,
which belongs to a later layer that does not exist yet.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from reme.pose.posture_criteria import PostureVerdict

TEMPORAL_SCHEMA_VERSION = "reme-posture-temporal/v0-experiment"

#: Posture pairs with no single-frame direct path.  Standing and lying are
#: separated by the whole descent or rise; an input sequence that jumps straight
#: between them is reporting something impossible, and the honest response is to
#: abstain until the intermediate evidence actually arrives.  Sitting is not
#: listed against standing because sit-to-stand is exactly the normal case.
#: Transitions *via* ``unknown`` are always legal: ``unknown`` is the absence of
#: evidence, not a body configuration.
FORBIDDEN_DIRECT_TRANSITIONS: frozenset[tuple[str, str]] = frozenset(
    {("standing", "lying"), ("lying", "standing")}
)


class PostureTemporalError(ValueError):
    """Raised when the temporal tracker is fed an unusable sequence."""


@dataclass(frozen=True, slots=True)
class TemporalConfig:
    """Timing rules for releasing a posture change.

    ``min_dwell_ms`` is an engineering de-jitter value, not a physiological
    constant: 167 ms is five frames at 30 FPS, which on this project's clip
    removes 87% of the label flips.  It must be recalibrated against a real
    validation set before being quoted as a working parameter.

    The dwell buys stability with latency, and that latency is a real cost on a
    safety-relevant signal: it delays every posture change by up to
    ``min_dwell_ms``, which has to be counted against the contract's 500 ms
    posture-label budget and against the escalation clock in ADR-0005.
    """

    min_dwell_ms: float = 167.0
    unknown_dwell_ms: float = 167.0
    max_gap_ms: float = 1000.0
    forbidden_direct: frozenset[tuple[str, str]] = FORBIDDEN_DIRECT_TRANSITIONS

    def __post_init__(self) -> None:
        for name, value in (
            ("min_dwell_ms", self.min_dwell_ms),
            ("unknown_dwell_ms", self.unknown_dwell_ms),
            ("max_gap_ms", self.max_gap_ms),
        ):
            if not math.isfinite(value) or value < 0.0:
                raise PostureTemporalError(f"{name} must be finite and non-negative")

    def dwell_for(self, posture: str) -> float:
        return self.unknown_dwell_ms if posture == "unknown" else self.min_dwell_ms

    def to_payload(self) -> dict[str, object]:
        return {
            "min_dwell_ms": self.min_dwell_ms,
            "unknown_dwell_ms": self.unknown_dwell_ms,
            "max_gap_ms": self.max_gap_ms,
            "provenance": "pending_calibration",
            "source": "5 frames at 30 FPS; removes 87% of flips on the project clip",
        }


@dataclass(frozen=True, slots=True)
class TemporalVerdict:
    """What was emitted, what the frame said, and why they differ."""

    posture: str
    frame_posture: str
    confidence: float
    timestamp_ms: float
    dwell_ms: float
    overridden: bool
    override_reason: str | None
    pending: str | None
    pending_ms: float
    frame_verdict: PostureVerdict | None = field(default=None, repr=False)

    def to_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "schema_version": TEMPORAL_SCHEMA_VERSION,
            "posture": self.posture,
            "frame_posture": self.frame_posture,
            "confidence": round(self.confidence, 6),
            "dwell_ms": round(self.dwell_ms, 3),
            "overridden": self.overridden,
            "override_reason": self.override_reason,
            "pending": self.pending,
            "pending_ms": round(self.pending_ms, 3),
        }
        if self.frame_verdict is not None:
            payload["frame_evidence"] = self.frame_verdict.to_payload()
        return payload


class PostureTemporalTracker:
    """Hold a posture until a challenger has persisted long enough to replace it.

    The tracker is a plain state machine over perception time.  It is driven by
    timestamps rather than frame counts because the input may arrive at 30 Hz
    while observations are emitted at 5-10 Hz, and because a recorded replay and
    a live session do not share a frame cadence.
    """

    def __init__(self, config: TemporalConfig | None = None) -> None:
        self.config = config or TemporalConfig()
        self._emitted = "unknown"
        self._emitted_since_ms: float | None = None
        self._emitted_confidence = 1.0
        self._candidate: str | None = None
        self._candidate_since_ms: float | None = None
        self._candidate_confidence = 0.0
        self._last_timestamp_ms: float | None = None

    def reset(self) -> None:
        """Clear all state, as required when a new session begins."""

        self._emitted = "unknown"
        self._emitted_since_ms = None
        self._emitted_confidence = 1.0
        self._candidate = None
        self._candidate_since_ms = None
        self._candidate_confidence = 0.0
        self._last_timestamp_ms = None

    @property
    def emitted(self) -> str:
        return self._emitted

    def ingest(
        self, verdict: PostureVerdict, *, timestamp_ms: float, include_evidence: bool = True
    ) -> TemporalVerdict:
        """Feed one frame verdict and return what should actually be released."""

        if not math.isfinite(timestamp_ms) or timestamp_ms < 0.0:
            raise PostureTemporalError("timestamp_ms must be finite and non-negative")

        discontinuity = self._detect_discontinuity(timestamp_ms)
        if discontinuity is not None:
            self.reset()

        frame_posture = verdict.posture
        if self._emitted_since_ms is None:
            # Cold start, and also the state after a gap or a clock regression.
            # Abstaining until the new posture has actually held is the honest
            # opening position: nothing has been observed long enough yet.
            self._emitted = "unknown"
            self._emitted_since_ms = timestamp_ms
            self._emitted_confidence = 1.0

        override_reason = discontinuity
        if frame_posture == self._emitted:
            self._candidate = None
            self._candidate_since_ms = None
            self._emitted_confidence = verdict.confidence
        else:
            override_reason = self._challenge(
                frame_posture, verdict, timestamp_ms, override_reason
            )

        self._last_timestamp_ms = timestamp_ms
        emitted_since = self._emitted_since_ms if self._emitted_since_ms is not None else 0.0
        pending_ms = (
            0.0
            if self._candidate_since_ms is None
            else max(0.0, timestamp_ms - self._candidate_since_ms)
        )
        return TemporalVerdict(
            posture=self._emitted,
            frame_posture=frame_posture,
            confidence=self._emitted_confidence,
            timestamp_ms=timestamp_ms,
            dwell_ms=max(0.0, timestamp_ms - emitted_since),
            overridden=frame_posture != self._emitted,
            override_reason=override_reason if frame_posture != self._emitted else None,
            pending=self._candidate,
            pending_ms=pending_ms,
            frame_verdict=verdict if include_evidence else None,
        )

    def _detect_discontinuity(self, timestamp_ms: float) -> str | None:
        previous = self._last_timestamp_ms
        if previous is None:
            return None
        if timestamp_ms < previous:
            return "perception clock went backwards; temporal state reset"
        if timestamp_ms - previous > self.config.max_gap_ms:
            return (
                f"gap of {timestamp_ms - previous:.0f} ms exceeds "
                f"{self.config.max_gap_ms:.0f} ms; temporal state reset"
            )
        return None

    def _challenge(
        self,
        frame_posture: str,
        verdict: PostureVerdict,
        timestamp_ms: float,
        discontinuity: str | None,
    ) -> str | None:
        if self._candidate != frame_posture:
            self._candidate = frame_posture
            self._candidate_since_ms = timestamp_ms
        self._candidate_confidence = verdict.confidence
        since = self._candidate_since_ms if self._candidate_since_ms is not None else timestamp_ms
        held_ms = timestamp_ms - since
        required = self.config.dwell_for(frame_posture)
        if held_ms + 1e-9 < required:
            return discontinuity or self._pending_reason(frame_posture, held_ms)

        if (self._emitted, frame_posture) in self.config.forbidden_direct:
            # No body goes between these two without passing through something
            # else.  Abstain rather than accept an impossible jump; a real
            # transition will re-enter through the intermediate evidence.
            previous = self._emitted
            self._emitted = "unknown"
            self._emitted_since_ms = since
            self._emitted_confidence = 1.0
            self._candidate = None
            self._candidate_since_ms = None
            return (
                f"direct {previous!r} to {frame_posture!r} is not physically "
                "reachable; released as unknown"
            )

        self._emitted = frame_posture
        self._emitted_since_ms = since
        self._emitted_confidence = self._candidate_confidence
        self._candidate = None
        self._candidate_since_ms = None
        return None

    def _pending_reason(self, frame_posture: str, held_ms: float) -> str:
        required = self.config.dwell_for(frame_posture)
        return (
            f"{frame_posture!r} has held {held_ms:.0f} of the {required:.0f} ms "
            f"required to replace {self._emitted!r}"
        )


def smooth_sequence(
    verdicts: list[tuple[PostureVerdict, float]],
    *,
    config: TemporalConfig | None = None,
) -> list[TemporalVerdict]:
    """Run a whole sequence through one tracker, for offline evaluation."""

    tracker = PostureTemporalTracker(config)
    return [
        tracker.ingest(verdict, timestamp_ms=timestamp, include_evidence=False)
        for verdict, timestamp in verdicts
    ]


def flip_count(results: list[TemporalVerdict] | list[str]) -> int:
    """Count label changes in a released sequence."""

    labels: list[str] = [
        item if isinstance(item, str) else item.posture for item in results
    ]
    return sum(1 for earlier, later in zip(labels, labels[1:], strict=False) if earlier != later)


def temporal_payload(result: TemporalVerdict) -> dict[str, Any]:
    """Return the record fragment that keeps evidence covering the emitted label."""

    return {"temporal": result.to_payload()}
