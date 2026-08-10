"""Versioned P0 fixture loading and deterministic day projection.

The fixture contains only already-normalized, coarse family-history events.
It never contains raw media, per-frame skeletons or MiMo prompts.  Projection
is deterministic so repeated loads produce byte-equivalent day snapshots and
do not create duplicate history facts.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

FIXTURE_SCHEMA_VERSION = "reme-history-fixture/v1"
DATE_INDEX_SCHEMA_VERSION = "reme-date-index/v1"
TIMELINE_DAY_SCHEMA_VERSION = "reme-timeline-day-state/v1"
DEMO_DATASET_ID = "reme-aug-2026-demo-v1"
DEMO_MODE = "mock_fixture"
DEMO_TIMEZONE = "Asia/Shanghai"
DEFAULT_FIXTURE_PATH = Path(__file__).with_name("fixtures") / f"{DEMO_DATASET_ID}.json"

_ALLOWED_KINDS = frozenset({"activity", "device", "care_thread"})
_ALLOWED_DATE_STATUS = frozenset({"ready", "partial", "unavailable"})
_ALLOWED_COVERAGE_STATUS = frozenset({"complete", "partial", "unavailable"})
_FORBIDDEN_KEYS = frozenset(
    {
        "audio",
        "audio_b64",
        "base64",
        "blob",
        "camera_frame",
        "clip_data",
        "image",
        "image_b64",
        "jpeg",
        "landmarks",
        "mimo_completion",
        "mimo_prompt",
        "raw_audio",
        "raw_frame",
        "raw_video",
        "skeleton_history",
        "video_bytes",
    }
)


class HistoryContractError(ValueError):
    """A fixture or projected history payload violates the P0 contract."""


@dataclass(frozen=True, slots=True)
class ProjectedHistoryFixture:
    """Immutable result of one normalized fixture projection."""

    dataset_id: str
    mode: str
    timezone: str
    revision: int
    day_states: dict[str, dict[str, Any]]

    def date_index(self, *, today: date | None = None) -> dict[str, Any]:
        """Return the date index, filtering dates after the household-local today.

        The explicit ``today`` seam exists for deterministic tests and for the
        Aug-11 demo fixture, which is intentionally committed before demo day.
        """

        local_today = today or datetime.now(ZoneInfo(self.timezone)).date()
        dates = []
        for date_key in sorted(self.day_states):
            parsed = date.fromisoformat(date_key)
            if parsed > local_today:
                continue
            day = self.day_states[date_key]
            dates.append(
                {
                    "date": date_key,
                    "status": day["status"],
                    "timeline_revision": day["revision"],
                    "summary_revision": 0,
                }
            )
        return {
            "schema_version": DATE_INDEX_SCHEMA_VERSION,
            "dataset_id": self.dataset_id,
            "mode": self.mode,
            "timezone": self.timezone,
            "revision": self.revision,
            "dates": dates,
        }


def load_projected_demo_fixture(path: Path = DEFAULT_FIXTURE_PATH) -> ProjectedHistoryFixture:
    """Load and validate the versioned backend-owned public demo fixture."""

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise HistoryContractError(f"history fixture not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise HistoryContractError(f"history fixture is invalid JSON: {exc}") from exc
    return project_fixture(raw)


def project_fixture(value: object) -> ProjectedHistoryFixture:
    root = _exact_object(
        value,
        {
            "schema_version",
            "dataset_id",
            "mode",
            "timezone",
            "revision",
            "coverage",
            "events",
        },
        "fixture",
    )
    if root["schema_version"] != FIXTURE_SCHEMA_VERSION:
        raise HistoryContractError("unsupported history fixture schema")
    if root["dataset_id"] != DEMO_DATASET_ID:
        raise HistoryContractError("P0 only permits the allowlisted demo dataset")
    if root["mode"] != DEMO_MODE:
        raise HistoryContractError("P0 history mode must be mock_fixture")
    timezone = _non_empty_string(root["timezone"], "timezone")
    if timezone != DEMO_TIMEZONE:
        raise HistoryContractError("P0 demo timezone must be Asia/Shanghai")
    try:
        zone = ZoneInfo(timezone)
    except ZoneInfoNotFoundError as exc:
        raise HistoryContractError(f"unknown timezone: {timezone}") from exc
    revision = _positive_int(root["revision"], "revision")

    coverage_raw = root["coverage"]
    if not isinstance(coverage_raw, list):
        raise HistoryContractError("coverage must be an array")
    coverage_by_date: dict[str, dict[str, Any]] = {}
    for entry in coverage_raw:
        normalized = _validate_coverage(entry)
        date_key = normalized["date"]
        if date_key in coverage_by_date:
            raise HistoryContractError(f"duplicate coverage date: {date_key}")
        coverage_by_date[date_key] = normalized

    events_raw = root["events"]
    if not isinstance(events_raw, list):
        raise HistoryContractError("events must be an array")
    seen_ids: set[str] = set()
    events_by_date: dict[str, list[dict[str, Any]]] = {}
    for raw_event in events_raw:
        _reject_forbidden_keys(raw_event)
        event = _validate_event(raw_event)
        event_id = event["event_id"]
        if event_id in seen_ids:
            raise HistoryContractError(f"duplicate event_id: {event_id}")
        seen_ids.add(event_id)
        occurred = datetime.fromtimestamp(event["occurred_at_ms"] / 1000, tz=UTC).astimezone(zone)
        date_key = occurred.date().isoformat()
        events_by_date.setdefault(date_key, []).append(event)

    all_dates = sorted(set(coverage_by_date) | set(events_by_date))
    day_states: dict[str, dict[str, Any]] = {}
    for date_key in all_dates:
        coverage = coverage_by_date.get(date_key)
        if coverage is None:
            raise HistoryContractError(f"missing coverage for {date_key}")
        items = sorted(
            events_by_date.get(date_key, []),
            key=lambda item: (item["occurred_at_ms"], item["event_id"]),
        )
        activity = sum(
            int(item["occurrence_count"])
            for item in items
            if item["kind"] == "activity"
        )
        device = sum(
            int(item["occurrence_count"])
            for item in items
            if item["kind"] == "device"
        )
        care = sum(1 for item in items if item["kind"] == "care_thread")
        status = "unavailable" if coverage["status"] == "unavailable" else (
            "partial" if coverage["status"] == "partial" else "ready"
        )
        updated_at_ms = max(
            [coverage["end_at_ms"]]
            + [int(item["recorded_at_ms"]) for item in items]
        )
        day_states[date_key] = {
            "schema_version": TIMELINE_DAY_SCHEMA_VERSION,
            "dataset_id": DEMO_DATASET_ID,
            "mode": DEMO_MODE,
            "date": date_key,
            "timezone": timezone,
            "revision": revision,
            "updated_at_ms": updated_at_ms,
            "status": status,
            "coverage": {
                "status": coverage["status"],
                "start_at_ms": coverage["start_at_ms"],
                "end_at_ms": coverage["end_at_ms"],
                "observed_hours": coverage["observed_hours"],
                "missing_intervals": coverage["missing_intervals"],
            },
            "counts": {
                "total": activity + device + care,
                "activity": activity,
                "device": device,
                "care": care,
            },
            "items": items,
        }
    return ProjectedHistoryFixture(
        dataset_id=DEMO_DATASET_ID,
        mode=DEMO_MODE,
        timezone=timezone,
        revision=revision,
        day_states=day_states,
    )


def _validate_coverage(value: object) -> dict[str, Any]:
    payload = _exact_object(
        value,
        {
            "date",
            "status",
            "start_at_ms",
            "end_at_ms",
            "observed_hours",
            "missing_intervals",
        },
        "coverage",
    )
    date_key = _iso_date(payload["date"], "coverage.date")
    status = _non_empty_string(payload["status"], "coverage.status")
    if status not in _ALLOWED_COVERAGE_STATUS:
        raise HistoryContractError("invalid coverage.status")
    start = _non_negative_int(payload["start_at_ms"], "coverage.start_at_ms")
    end = _non_negative_int(payload["end_at_ms"], "coverage.end_at_ms")
    if end < start:
        raise HistoryContractError("coverage end_at_ms precedes start_at_ms")
    observed_hours = payload["observed_hours"]
    if isinstance(observed_hours, bool) or not isinstance(observed_hours, int | float):
        raise HistoryContractError("coverage.observed_hours must be numeric")
    if not 0 <= float(observed_hours) <= 24:
        raise HistoryContractError("coverage.observed_hours must be within 0..24")
    missing = payload["missing_intervals"]
    if not isinstance(missing, list):
        raise HistoryContractError("coverage.missing_intervals must be an array")
    normalized_missing = []
    for item in missing:
        interval = _exact_object(item, {"start_at_ms", "end_at_ms"}, "missing interval")
        missing_start = _non_negative_int(interval["start_at_ms"], "missing.start_at_ms")
        missing_end = _non_negative_int(interval["end_at_ms"], "missing.end_at_ms")
        if missing_end < missing_start:
            raise HistoryContractError("missing interval end precedes start")
        normalized_missing.append({"start_at_ms": missing_start, "end_at_ms": missing_end})
    if status == "complete" and (float(observed_hours) != 24 or normalized_missing):
        raise HistoryContractError("complete coverage requires 24 hours and no missing intervals")
    return {
        "date": date_key,
        "status": status,
        "start_at_ms": start,
        "end_at_ms": end,
        "observed_hours": observed_hours,
        "missing_intervals": normalized_missing,
    }


def _validate_event(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HistoryContractError("event must be an object")
    kind = _non_empty_string(value.get("kind"), "event.kind")
    if kind not in _ALLOWED_KINDS:
        raise HistoryContractError(f"unsupported event kind: {kind}")
    required = {"event_id", "kind", "occurred_at_ms", "recorded_at_ms", "source"}
    allowed_by_kind = {
        "activity": required
        | {"room", "fact_type", "fact", "detail", "occurrence_count", "related"},
        "device": required
        | {"room", "device", "action", "value", "fact", "occurrence_count"},
        "care_thread": required
        | {
            "thread_id",
            "status",
            "assessment",
            "check_in",
            "response",
            "material",
            "delivery",
        },
    }
    actual = set(value)
    if actual != allowed_by_kind[kind]:
        raise HistoryContractError(
            f"{kind} event fields must be exact; missing={sorted(allowed_by_kind[kind] - actual)} "
            f"extra={sorted(actual - allowed_by_kind[kind])}"
        )
    event_id = _non_empty_string(value["event_id"], "event_id")
    occurred = _non_negative_int(value["occurred_at_ms"], "occurred_at_ms")
    recorded = _non_negative_int(value["recorded_at_ms"], "recorded_at_ms")
    if recorded < occurred:
        raise HistoryContractError("recorded_at_ms cannot precede occurred_at_ms")
    source = _validate_source(value["source"])
    normalized = dict(value)
    normalized.update(
        event_id=event_id,
        kind=kind,
        occurred_at_ms=occurred,
        recorded_at_ms=recorded,
        source=source,
    )
    if kind == "activity":
        normalized["room"] = _non_empty_string(value["room"], "activity.room")
        normalized["fact_type"] = _non_empty_string(value["fact_type"], "activity.fact_type")
        normalized["fact"] = _bounded_string(value["fact"], "activity.fact", 500)
        normalized["detail"] = _bounded_string(value["detail"], "activity.detail", 1000)
        normalized["occurrence_count"] = _positive_int(
            value["occurrence_count"], "activity.occurrence_count"
        )
        if not isinstance(value["related"], list):
            raise HistoryContractError("activity.related must be an array")
    elif kind == "device":
        normalized["room"] = _non_empty_string(value["room"], "device.room")
        normalized["device"] = _require_mapping(value["device"], "device.device")
        normalized["action"] = _non_empty_string(value["action"], "device.action")
        normalized["fact"] = _bounded_string(value["fact"], "device.fact", 500)
        normalized["occurrence_count"] = _positive_int(
            value["occurrence_count"], "device.occurrence_count"
        )
        if not isinstance(value["value"], dict):
            raise HistoryContractError("device.value must be an object")
    else:
        normalized["thread_id"] = _non_empty_string(value["thread_id"], "care.thread_id")
        normalized["status"] = _non_empty_string(value["status"], "care.status")
        for field in ("assessment", "check_in", "response", "material", "delivery"):
            if value[field] is not None and not isinstance(value[field], dict):
                raise HistoryContractError(f"care.{field} must be object or null")
    return normalized


def _validate_source(value: object) -> dict[str, Any]:
    source = _require_mapping(value, "source")
    mode = source.get("mode")
    if mode != DEMO_MODE:
        raise HistoryContractError("P0 source.mode must be mock_fixture")
    source_type = source.get("type")
    if source_type is not None and (not isinstance(source_type, str) or not source_type):
        raise HistoryContractError("source.type must be a non-empty string when present")
    return dict(source)


def _reject_forbidden_keys(value: object) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key.lower() in _FORBIDDEN_KEYS:
                raise HistoryContractError(f"forbidden history field: {key}")
            _reject_forbidden_keys(item)
    elif isinstance(value, list):
        for item in value:
            _reject_forbidden_keys(item)


def _exact_object(value: object, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HistoryContractError(f"{label} must be an object")
    actual = set(value)
    if actual != keys:
        missing = sorted(keys - actual)
        extra = sorted(actual - keys)
        raise HistoryContractError(
            f"{label} fields must be exact; missing={missing} extra={extra}"
        )
    return value


def _require_mapping(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HistoryContractError(f"{label} must be an object")
    return value


def _non_empty_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise HistoryContractError(f"{label} must be a non-empty string")
    return value


def _bounded_string(value: object, label: str, limit: int) -> str:
    text = _non_empty_string(value, label)
    if len(text) > limit:
        raise HistoryContractError(f"{label} exceeds {limit} characters")
    return text


def _non_negative_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise HistoryContractError(f"{label} must be a non-negative integer")
    return value


def _positive_int(value: object, label: str) -> int:
    result = _non_negative_int(value, label)
    if result == 0:
        raise HistoryContractError(f"{label} must be positive")
    return result


def _iso_date(value: object, label: str) -> str:
    text = _non_empty_string(value, label)
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError as exc:
        raise HistoryContractError(f"{label} must be YYYY-MM-DD") from exc
