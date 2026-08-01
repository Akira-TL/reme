"""Tests for B's longitudinal behavior memory store."""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from reme.decision.behavior import BehaviorFeatures
from reme.decision.context import Posture
from reme.decision.memory import (
    MAX_EVENTS,
    MEMORY_SCHEMA_VERSION,
    BehaviorMemoryStore,
    MemoryEventKind,
)

_T0 = 1_700_000_000.0


def _features(**overrides: Any) -> BehaviorFeatures:
    fields: dict[str, Any] = {
        "window_ms": 120000.0,
        "observation_count": 12,
        "posture_change_count": 2,
        "restlessness_score": 0.2,
        "stillness_episode_count": 1,
        "longest_still_ms": 10000.0,
        "sit_to_stand_count": 1,
        "lying_to_upright_count": 0,
        "dominant_posture": Posture.SITTING,
        "fall_like_count": 0,
        "uncertain_transition_count": 0,
        "spatial_hints": None,
    }
    fields.update(overrides)
    return BehaviorFeatures(**fields)


def _clock(now: list[float]) -> Callable[[], float]:
    """Mutable stub clock: bump ``now[0]`` to advance wall time."""

    def _read() -> float:
        return now[0]

    return _read


def _store(path: Path | None, now: list[float]) -> BehaviorMemoryStore:
    return BehaviorMemoryStore(path, clock=_clock(now))


def _write_payload(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def test_in_memory_store_starts_empty_and_writes_nothing(tmp_path: Path) -> None:
    now = [_T0]
    store = _store(None, now)
    store.record_event(MemoryEventKind.COMPLAINT, scene_id="s1", detail="牙疼")
    store.observe(_features(), local_hour=9)

    assert len(store.recent_events()) == 1
    assert list(tmp_path.iterdir()) == []


def test_record_event_returns_newest_first_with_clock_stamps() -> None:
    now = [_T0]
    store = _store(None, now)
    store.record_event(MemoryEventKind.CHECK_IN_SENT, scene_id="s1")
    now[0] += 60.0
    store.record_event(MemoryEventKind.RESOLVED, scene_id="s1", detail="老人回应正常")

    events = store.recent_events()
    assert [event.kind for event in events] == [
        MemoryEventKind.RESOLVED,
        MemoryEventKind.CHECK_IN_SENT,
    ]
    assert events[0].recorded_at_s == _T0 + 60.0
    assert events[0].detail == "老人回应正常"
    assert events[1].detail is None


def test_recent_events_filters_by_kind_and_honours_limit() -> None:
    now = [_T0]
    store = _store(None, now)
    for index in range(4):
        now[0] += 10.0
        store.record_event(MemoryEventKind.CHECK_IN_SENT, scene_id=f"s{index}")
        now[0] += 10.0
        store.record_event(MemoryEventKind.FALL_ALERT, scene_id=f"s{index}")

    alerts = store.recent_events(kinds=frozenset({MemoryEventKind.FALL_ALERT}))
    assert len(alerts) == 4
    assert {event.kind for event in alerts} == {MemoryEventKind.FALL_ALERT}
    assert store.recent_events(limit=3) == store.recent_events(limit=8)[:3]
    assert store.recent_events(limit=0) == ()


def test_events_are_trimmed_to_max_events_keeping_newest() -> None:
    now = [_T0]
    store = _store(None, now)
    for index in range(MAX_EVENTS + 5):
        now[0] += 1.0
        store.record_event(MemoryEventKind.CHECK_IN_SENT, scene_id=f"s{index}")

    events = store.recent_events(limit=MAX_EVENTS + 50)
    assert len(events) == MAX_EVENTS
    assert events[0].scene_id == f"s{MAX_EVENTS + 4}"
    assert events[-1].scene_id == "s5"


def test_persistence_roundtrips_events_and_baselines(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "memory.json"
    now = [_T0]
    writer = _store(path, now)
    writer.record_event(MemoryEventKind.COMPLAINT, scene_id="s1", detail="牙疼")
    writer.observe(_features(restlessness_score=0.2, longest_still_ms=10000.0), local_hour=9)

    reader = _store(path, now)
    events = reader.recent_events()
    assert len(events) == 1
    assert events[0].kind is MemoryEventKind.COMPLAINT
    assert events[0].detail == "牙疼"
    # Baseline survived too: two more windows mature it and unlock deviation.
    reader.observe(_features(longest_still_ms=10000.0), local_hour=9)
    reader.observe(_features(longest_still_ms=10000.0), local_hour=9)
    assert reader.deviation(_features(longest_still_ms=10000.0), local_hour=9) is not None


def test_persisted_payload_matches_documented_schema(tmp_path: Path) -> None:
    path = tmp_path / "memory.json"
    now = [_T0]
    store = _store(path, now)
    store.record_event(MemoryEventKind.FALL_ALERT, scene_id="fall_demo_01")
    store.observe(_features(restlessness_score=0.2, longest_still_ms=10000.0), local_hour=9)

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == MEMORY_SCHEMA_VERSION
    assert payload["events"] == [
        {
            "recorded_at_s": _T0,
            "kind": "fall_alert",
            "scene_id": "fall_demo_01",
            "detail": None,
        }
    ]
    assert payload["baselines"] == [
        {
            "hour": 9,
            "samples": 1,
            "restlessness_ewma": 0.2,
            "longest_still_ewma_ms": 10000.0,
        }
    ]
    assert not (tmp_path / "memory.json.tmp").exists()


def test_ewma_folding_matches_hand_computation(tmp_path: Path) -> None:
    path = tmp_path / "memory.json"
    now = [_T0]
    store = _store(path, now)
    store.observe(_features(restlessness_score=0.2, longest_still_ms=10000.0), local_hour=9)
    store.observe(_features(restlessness_score=0.7, longest_still_ms=20000.0), local_hour=9)
    store.observe(_features(restlessness_score=0.7, longest_still_ms=20000.0), local_hour=9)

    baseline = json.loads(path.read_text(encoding="utf-8"))["baselines"][0]
    assert baseline["samples"] == 3
    # alpha=0.3: 0.2 -> 0.3*0.7+0.7*0.2=0.35 -> 0.3*0.7+0.7*0.35=0.455
    assert baseline["restlessness_ewma"] == pytest.approx(0.455)
    # 10000 -> 0.3*20000+0.7*10000=13000 -> 0.3*20000+0.7*13000=15100
    assert baseline["longest_still_ewma_ms"] == pytest.approx(15100.0)


def test_hour_buckets_are_independent(tmp_path: Path) -> None:
    path = tmp_path / "memory.json"
    now = [_T0]
    store = _store(path, now)
    store.observe(_features(longest_still_ms=10000.0), local_hour=9)
    store.observe(_features(longest_still_ms=90000.0), local_hour=23)

    baselines = json.loads(path.read_text(encoding="utf-8"))["baselines"]
    assert [item["hour"] for item in baselines] == [9, 23]
    assert [item["longest_still_ewma_ms"] for item in baselines] == [10000.0, 90000.0]


def test_deviation_is_none_before_the_baseline_matures() -> None:
    now = [_T0]
    store = _store(None, now)
    probe = _features(longest_still_ms=30200.0)
    assert store.deviation(probe, local_hour=9) is None
    store.observe(_features(longest_still_ms=10000.0), local_hour=9)
    assert store.deviation(probe, local_hour=9) is None
    store.observe(_features(longest_still_ms=20000.0), local_hour=9)
    assert store.deviation(probe, local_hour=9) is None


def test_deviation_reports_ratio_once_baseline_matures() -> None:
    now = [_T0]
    store = _store(None, now)
    store.observe(_features(longest_still_ms=10000.0), local_hour=9)
    store.observe(_features(longest_still_ms=20000.0), local_hour=9)
    store.observe(_features(longest_still_ms=20000.0), local_hour=9)

    # baseline 15100ms; today's 30200ms is exactly twice as still.
    assert store.deviation(_features(longest_still_ms=30200.0), local_hour=9) == pytest.approx(2.0)
    assert store.deviation(_features(longest_still_ms=7550.0), local_hour=9) == pytest.approx(0.5)


def test_deviation_floors_a_zero_baseline_at_one_millisecond() -> None:
    now = [_T0]
    store = _store(None, now)
    for _ in range(3):
        store.observe(_features(longest_still_ms=0.0), local_hour=3)

    assert store.deviation(_features(longest_still_ms=5.0), local_hour=3) == pytest.approx(5.0)


def test_out_of_range_local_hour_is_rejected() -> None:
    now = [_T0]
    store = _store(None, now)
    for hour in (-1, 24, 99):
        with pytest.raises(ValueError):
            store.observe(_features(), local_hour=hour)
        with pytest.raises(ValueError):
            store.deviation(_features(), local_hour=hour)


def test_missing_file_starts_empty(tmp_path: Path) -> None:
    path = tmp_path / "absent" / "memory.json"
    now = [_T0]
    store = _store(path, now)

    assert store.recent_events() == ()
    assert store.summary_zh(local_hour=9) is None
    assert not path.exists()


def test_corrupt_file_starts_empty(tmp_path: Path) -> None:
    path = tmp_path / "memory.json"
    path.write_text("{not json at all", encoding="utf-8")
    now = [_T0]
    store = _store(path, now)

    assert store.recent_events() == ()
    store.record_event(MemoryEventKind.CHECK_IN_SENT, scene_id="s1")
    assert json.loads(path.read_text(encoding="utf-8"))["schema_version"] == MEMORY_SCHEMA_VERSION


def test_foreign_schema_version_starts_empty(tmp_path: Path) -> None:
    path = tmp_path / "memory.json"
    _write_payload(
        path,
        {
            "schema_version": "reme-behavior-memory/v99-from-the-future",
            "events": [
                {
                    "recorded_at_s": _T0,
                    "kind": "complaint",
                    "scene_id": "s1",
                    "detail": "牙疼",
                }
            ],
            "baselines": [],
        },
    )
    now = [_T0]
    assert _store(path, now).recent_events() == ()


def test_structurally_invalid_payloads_start_empty(tmp_path: Path) -> None:
    now = [_T0]
    broken: list[object] = [
        {"schema_version": MEMORY_SCHEMA_VERSION, "events": "nope", "baselines": []},
        {
            "schema_version": MEMORY_SCHEMA_VERSION,
            "events": [{"recorded_at_s": _T0, "kind": "not_a_kind", "scene_id": "s1"}],
            "baselines": [],
        },
        {
            "schema_version": MEMORY_SCHEMA_VERSION,
            "events": [],
            "baselines": [{"hour": 44, "samples": 3, "restlessness_ewma": 0.1}],
        },
        ["not", "an", "object"],
    ]
    for index, payload in enumerate(broken):
        path = tmp_path / f"memory-{index}.json"
        _write_payload(path, payload)
        store = _store(path, now)
        assert store.recent_events() == ()
        assert store.deviation(_features(), local_hour=9) is None


def test_summary_zh_is_none_without_reportable_events() -> None:
    now = [_T0]
    store = _store(None, now)
    assert store.summary_zh(local_hour=9) is None
    # Milestones outside the reportable set stay silent rather than invent text.
    store.record_event(MemoryEventKind.CONSENT_GRANTED, scene_id="s1")
    store.observe(_features(), local_hour=9)
    assert store.summary_zh(local_hour=9) is None


def test_summary_zh_uses_relative_days() -> None:
    now = [_T0]
    store = _store(None, now)
    store.record_event(MemoryEventKind.COMPLAINT, scene_id="s1", detail="牙疼")

    assert store.summary_zh(local_hour=None) == "记忆：今天曾主诉：牙疼"
    now[0] = _T0 + 25 * 3600.0
    assert store.summary_zh(local_hour=None) == "记忆：昨天曾主诉：牙疼"
    now[0] = _T0 + 3 * 86400.0 + 3600.0
    assert store.summary_zh(local_hour=None) == "记忆：3天前曾主诉：牙疼"


def test_summary_zh_orders_complaint_before_newest_alert() -> None:
    now = [_T0]
    store = _store(None, now)
    store.record_event(MemoryEventKind.FALL_ALERT, scene_id="s1")
    now[0] += 3600.0
    store.record_event(MemoryEventKind.COMPLAINT, scene_id="s1", detail="牙疼")

    assert store.summary_zh(local_hour=9) == "记忆：今天曾主诉：牙疼；今天曾触发跌倒警报"
    now[0] += 3600.0
    store.record_event(MemoryEventKind.URGENT, scene_id="s1")
    assert store.summary_zh(local_hour=9) == "记忆：今天曾主诉：牙疼；今天曾升级为紧急关注"


def test_summary_zh_falls_back_to_alert_only_and_detailless_complaint() -> None:
    now = [_T0]
    alert_only = _store(None, now)
    alert_only.record_event(MemoryEventKind.FALL_ALERT, scene_id="s1")
    assert alert_only.summary_zh(local_hour=9) == "记忆：今天曾触发跌倒警报"

    blank = _store(None, now)
    blank.record_event(MemoryEventKind.COMPLAINT, scene_id="s1", detail="   ")
    assert blank.summary_zh(local_hour=9) == "记忆：今天曾有主诉记录"


def test_summary_zh_drops_low_priority_clause_over_budget() -> None:
    now = [_T0]
    store = _store(None, now)
    store.record_event(MemoryEventKind.FALL_ALERT, scene_id="s1")
    store.record_event(MemoryEventKind.COMPLAINT, scene_id="s1", detail="牙疼")

    full = store.summary_zh(local_hour=9, max_chars=160)
    assert full is not None and len(full) == 21
    trimmed = store.summary_zh(local_hour=9, max_chars=20)
    assert trimmed == "记忆：今天曾主诉：牙疼"


def test_summary_zh_truncates_a_single_oversized_clause() -> None:
    now = [_T0]
    store = _store(None, now)
    store.record_event(MemoryEventKind.COMPLAINT, scene_id="s1", detail="牙" * 300)

    summary = store.summary_zh(local_hour=9)
    assert summary is not None
    assert len(summary) == 160
    assert summary.startswith("记忆：今天曾主诉：牙牙")
    assert store.summary_zh(local_hour=9, max_chars=3) is None


def test_write_failures_never_reach_the_caller(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "memory.json"
    now = [_T0]
    store = _store(path, now)

    def _explode(src: Any, dst: Any, **kwargs: Any) -> None:
        raise OSError("simulated disk failure")

    monkeypatch.setattr(os, "replace", _explode)
    store.record_event(MemoryEventKind.FALL_ALERT, scene_id="s1")
    store.observe(_features(), local_hour=9)
    monkeypatch.undo()

    # In-memory state stayed correct and no temp file was left behind.
    assert len(store.recent_events()) == 1
    assert not path.exists()
    assert not (tmp_path / "memory.json.tmp").exists()


def test_unusable_path_is_tolerated_on_both_load_and_save(tmp_path: Path) -> None:
    path = tmp_path / "memory.json"
    path.mkdir()
    now = [_T0]
    store = _store(path, now)

    store.record_event(MemoryEventKind.URGENT, scene_id="s1")
    store.observe(_features(), local_hour=9)
    assert len(store.recent_events()) == 1
    assert store.summary_zh(local_hour=9) == "记忆：今天曾升级为紧急关注"
