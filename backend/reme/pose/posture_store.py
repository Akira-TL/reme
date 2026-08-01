"""Append-only storage, time lookup, and interval timeline for posture verdicts.

The store keeps one JSONL stream per scene plus an in-memory time index.  It is
deliberately small: the perception layer emits at 5-10 Hz, so a ten-minute
session is a few thousand records and a sorted array beats any database.

Three properties matter more than speed here.

**Perception time only.**  Every timestamp is the scene's own perception clock
as defined by the A/B/C contract -- milliseconds from the session or video
start.  Wall-clock time never enters a record, so a recorded scene replays
identically no matter when it is played.

**Hostile input is expected.**  Live capture produces duplicate frame indices,
out-of-order arrivals, and timestamp regressions when a session restarts.  The
store keeps insertion stable, sorts on read, and refuses to build an interval
whose end precedes its start, so a clock glitch cannot manufacture a negative
duration.

**Privacy by construction.**  Records hold geometry, criteria, and labels.  No
image, no crop, no raw frame, and no identity.  This keeps posture retention
inside the boundary ADR-0001 drew and ADR-0003 narrowed, without needing a new
retention decision.
"""

from __future__ import annotations

import json
import threading
from bisect import bisect_left, bisect_right
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from reme.pose.posture_criteria import PostureVerdict

STORE_SCHEMA_VERSION = "reme-posture-record/v0-experiment"
TIMELINE_SCHEMA_VERSION = "reme-posture-timeline/v0-experiment"


class PostureStoreError(ValueError):
    """Raised when a posture record or query is malformed."""


@dataclass(frozen=True, slots=True)
class PostureRecord:
    """One released posture verdict pinned to a scene and a perception time."""

    scene_id: str
    timestamp_ms: float
    frame_index: int
    posture: str
    confidence: float
    abstain_reason: str | None
    evidence: dict[str, Any]

    @classmethod
    def from_verdict(
        cls,
        verdict: PostureVerdict,
        *,
        scene_id: str,
        timestamp_ms: float,
        frame_index: int,
    ) -> PostureRecord:
        if timestamp_ms < 0.0:
            raise PostureStoreError("timestamp_ms must be non-negative")
        if frame_index < 0:
            raise PostureStoreError("frame_index must be non-negative")
        return cls(
            scene_id=scene_id,
            timestamp_ms=float(timestamp_ms),
            frame_index=int(frame_index),
            posture=verdict.posture,
            confidence=verdict.confidence,
            abstain_reason=verdict.abstain_reason,
            evidence=verdict.to_payload(),
        )

    def to_payload(self) -> dict[str, object]:
        return {
            "schema_version": STORE_SCHEMA_VERSION,
            "scene_id": self.scene_id,
            "timestamp_ms": round(self.timestamp_ms, 3),
            "frame_index": self.frame_index,
            "posture": self.posture,
            "confidence": round(self.confidence, 6),
            "abstain_reason": self.abstain_reason,
            "evidence": self.evidence,
        }

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> PostureRecord:
        if payload.get("schema_version") != STORE_SCHEMA_VERSION:
            raise PostureStoreError(f"schema_version must be {STORE_SCHEMA_VERSION!r}")
        evidence = payload.get("evidence", {})
        if not isinstance(evidence, dict):
            raise PostureStoreError("evidence must be an object")
        reason = payload.get("abstain_reason")
        if reason is not None and not isinstance(reason, str):
            raise PostureStoreError("abstain_reason must be a string or null")
        return cls(
            scene_id=_text(payload.get("scene_id"), "scene_id"),
            timestamp_ms=_non_negative(payload.get("timestamp_ms"), "timestamp_ms"),
            frame_index=int(_non_negative(payload.get("frame_index"), "frame_index")),
            posture=_text(payload.get("posture"), "posture"),
            confidence=_unit(payload.get("confidence"), "confidence"),
            abstain_reason=reason,
            evidence=evidence,
        )


@dataclass(frozen=True, slots=True)
class PostureInterval:
    """One contiguous run of the same released posture."""

    posture: str
    start_ms: float
    end_ms: float
    frame_count: int
    mean_confidence: float
    dominant_reason: str | None

    @property
    def duration_ms(self) -> float:
        return self.end_ms - self.start_ms

    def to_payload(self) -> dict[str, object]:
        return {
            "posture": self.posture,
            "start_ms": round(self.start_ms, 3),
            "end_ms": round(self.end_ms, 3),
            "duration_ms": round(self.duration_ms, 3),
            "frame_count": self.frame_count,
            "mean_confidence": round(self.mean_confidence, 6),
            "dominant_reason": self.dominant_reason,
        }


class PostureStore:
    """Append-only JSONL store with a sorted in-memory time index."""

    def __init__(self, path: str | Path | None = None) -> None:
        self._path = None if path is None else Path(path)
        self._lock = threading.Lock()
        self._records: list[PostureRecord] = []
        self._times: list[float] = []
        self._sorted = True
        if self._path is not None:
            self._path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, record: PostureRecord) -> None:
        """Append one record, persisting it before it becomes queryable."""

        line = json.dumps(record.to_payload(), ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            if self._path is not None:
                with self._path.open("a", encoding="utf-8") as stream:
                    stream.write(line + "\n")
                    stream.flush()
            if self._records and record.timestamp_ms < self._records[-1].timestamp_ms:
                self._sorted = False
            self._records.append(record)

    def extend(self, records: Iterable[PostureRecord]) -> None:
        for record in records:
            self.append(record)

    def _ensure_index(self) -> None:
        if not self._sorted:
            self._records.sort(key=lambda item: (item.timestamp_ms, item.frame_index))
            self._sorted = True
        self._times = [item.timestamp_ms for item in self._records]

    def __len__(self) -> int:
        return len(self._records)

    def all(self) -> tuple[PostureRecord, ...]:
        """Return every record in ascending perception-time order."""

        with self._lock:
            self._ensure_index()
            return tuple(self._records)

    def latest(self) -> PostureRecord | None:
        """Return the most recent record by perception time."""

        with self._lock:
            self._ensure_index()
            return self._records[-1] if self._records else None

    def at(self, timestamp_ms: float) -> PostureRecord | None:
        """Return the newest record at or before ``timestamp_ms``.

        This is the query a replaying viewer needs when it seeks: the posture in
        force at a moment is the last one observed up to that moment, not the
        nearest one, which could otherwise let a future observation leak
        backwards into the past.
        """

        with self._lock:
            self._ensure_index()
            if not self._records:
                return None
            position = bisect_right(self._times, float(timestamp_ms))
            if position == 0:
                return None
            return self._records[position - 1]

    def range(self, start_ms: float, end_ms: float) -> tuple[PostureRecord, ...]:
        """Return records within ``[start_ms, end_ms)`` in ascending order."""

        if end_ms < start_ms:
            raise PostureStoreError("end_ms must be >= start_ms")
        with self._lock:
            self._ensure_index()
            low = bisect_left(self._times, float(start_ms))
            high = bisect_left(self._times, float(end_ms))
            return tuple(self._records[low:high])

    def timeline(self, *, min_duration_ms: float = 0.0) -> tuple[PostureInterval, ...]:
        """Aggregate records into contiguous posture intervals."""

        with self._lock:
            self._ensure_index()
            return build_timeline(self._records, min_duration_ms=min_duration_ms)

    def load(self, path: str | Path | None = None) -> None:
        """Replace in-memory state from a JSONL stream on disk."""

        source = Path(path) if path is not None else self._path
        if source is None:
            raise PostureStoreError("no path to load from")
        try:
            text = source.read_text(encoding="utf-8")
        except OSError as exc:
            raise PostureStoreError(f"cannot read posture store: {exc}") from exc
        records: list[PostureRecord] = []
        for number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                # A live writer killed mid-line leaves a partial final record.
                # Dropping a trailing fragment is correct; a broken line in the
                # middle of the stream is corruption and must not pass silently.
                if number == len(text.splitlines()):
                    break
                raise PostureStoreError(f"line {number} is not valid JSON") from None
            if not isinstance(payload, dict):
                raise PostureStoreError(f"line {number} must be a JSON object")
            records.append(PostureRecord.from_payload(payload))
        with self._lock:
            self._records = records
            self._sorted = False
            self._ensure_index()


def build_timeline(
    records: Sequence[PostureRecord], *, min_duration_ms: float = 0.0
) -> tuple[PostureInterval, ...]:
    """Collapse ordered records into runs of a single posture.

    An interval ends at the timestamp of the first record of the next posture,
    so intervals tile the observed span without gaps or overlaps.  The final
    interval ends at its own last sample, because nothing is yet known about
    what follows it.
    """

    if min_duration_ms < 0.0:
        raise PostureStoreError("min_duration_ms must be non-negative")
    ordered = sorted(records, key=lambda item: (item.timestamp_ms, item.frame_index))
    runs = list(_runs(ordered))
    intervals: list[PostureInterval] = []
    for position, run in enumerate(runs):
        first, last = run[0], run[-1]
        following = runs[position + 1][0].timestamp_ms if position + 1 < len(runs) else None
        # Clamping to the run's own start keeps a timestamp regression from
        # producing a negative duration; the run still appears, with zero width.
        end_ms = max(following if following is not None else last.timestamp_ms, first.timestamp_ms)
        reasons = [item.abstain_reason for item in run if item.abstain_reason]
        dominant = max(set(reasons), key=reasons.count) if reasons else None
        interval = PostureInterval(
            posture=first.posture,
            start_ms=first.timestamp_ms,
            end_ms=end_ms,
            frame_count=len(run),
            mean_confidence=sum(item.confidence for item in run) / len(run),
            dominant_reason=dominant,
        )
        if interval.duration_ms >= min_duration_ms:
            intervals.append(interval)
    return tuple(intervals)


def _runs(ordered: Sequence[PostureRecord]) -> Iterator[list[PostureRecord]]:
    current: list[PostureRecord] = []
    for record in ordered:
        if current and record.posture != current[-1].posture:
            yield current
            current = []
        current.append(record)
    if current:
        yield current


def _text(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PostureStoreError(f"{field_name} must be a non-empty string")
    return value.strip()


def _non_negative(value: object, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or value < 0:
        raise PostureStoreError(f"{field_name} must be a non-negative number")
    return float(value)


def _unit(value: object, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise PostureStoreError(f"{field_name} must be numeric")
    number = float(value)
    if not 0.0 <= number <= 1.0:
        raise PostureStoreError(f"{field_name} must be between 0 and 1")
    return number
