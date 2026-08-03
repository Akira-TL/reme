"""Tests for B's whole-home context: timeline scripts and bounded modulation."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from reme.decision.context import Posture
from reme.decision.guardrails import TriggerConfig
from reme.decision.home import (
    MAX_STILL_SCALE,
    MIN_STILL_SCALE,
    HomeContext,
    HomeScriptError,
    RoomLabel,
    ScriptedHomeProvider,
    StaticHomeProvider,
    _clamp_still_scale,
    _raw_still_scale,
    adjust_trigger_config,
    default_home_context,
    home_summary_zh,
)


def _home(**overrides: Any) -> HomeContext:
    fields: dict[str, Any] = {
        "local_hour": 2,
        "room": RoomLabel.BATHROOM,
        "is_night": True,
        "ambient": {},
    }
    fields.update(overrides)
    return HomeContext(**fields)


def _row(**overrides: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {"from_ms": 0.0, "room": "living_room"}
    fields.update(overrides)
    return fields


def _script(tmp_path: Path, *lines: str, name: str = "home_context.jsonl") -> Path:
    path = tmp_path / name
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def _all_home_contexts() -> list[HomeContext]:
    contexts: list[HomeContext] = [default_home_context()]
    for room in RoomLabel:
        for is_night in (False, True):
            hour = 2 if is_night else 14
            contexts.append(
                _home(room=room, is_night=is_night, local_hour=hour, ambient={"夜灯": "开"})
            )
            contexts.append(_home(room=room, is_night=is_night, local_hour=None))
    return contexts


def test_static_provider_returns_the_same_context_for_every_timestamp() -> None:
    context = _home(room=RoomLabel.KITCHEN, local_hour=14, is_night=False)
    provider = StaticHomeProvider(context=context)
    assert provider.context_at("fall_demo_01", 0.0) is context
    assert provider.context_at("other_scene", 999999.0) is context


def test_default_home_context_modulates_nothing() -> None:
    home = default_home_context()
    assert home.room is RoomLabel.UNKNOWN
    assert home.local_hour is None
    assert not home.is_night
    assert dict(home.ambient) == {}
    assert adjust_trigger_config(TriggerConfig(), home) == TriggerConfig()


def test_scripted_provider_rejects_unsorted_or_negative_segments() -> None:
    home = default_home_context()
    with pytest.raises(HomeScriptError):
        ScriptedHomeProvider(((0.0, home), (5000.0, home), (4000.0, home)))
    with pytest.raises(HomeScriptError):
        ScriptedHomeProvider(((0.0, home), (5000.0, home), (5000.0, home)))
    with pytest.raises(HomeScriptError):
        ScriptedHomeProvider(((-1.0, home),))


def test_load_parses_timeline_and_skips_blank_lines(tmp_path: Path) -> None:
    path = _script(
        tmp_path,
        json.dumps(_row(from_ms=0, room="bedroom", local_hour=2)),
        "",
        "   ",
        json.dumps(_row(from_ms=8000, room="bathroom", local_hour=2, ambient={"夜灯": "开"})),
    )
    provider = ScriptedHomeProvider.load(path)
    first = provider.context_at("scene", 100.0)
    assert first.room is RoomLabel.BEDROOM
    assert first.is_night
    second = provider.context_at("scene", 9000.0)
    assert second.room is RoomLabel.BATHROOM
    assert dict(second.ambient) == {"夜灯": "开"}


def test_load_returns_default_before_the_first_segment(tmp_path: Path) -> None:
    path = _script(tmp_path, json.dumps(_row(from_ms=5000, room="kitchen")))
    provider = ScriptedHomeProvider.load(path)
    assert provider.context_at("scene", 4999.0) == default_home_context()


def test_segment_lookup_is_inclusive_at_from_ms(tmp_path: Path) -> None:
    path = _script(
        tmp_path,
        json.dumps(_row(from_ms=0, room="hallway")),
        json.dumps(_row(from_ms=5000, room="kitchen")),
    )
    provider = ScriptedHomeProvider.load(path)
    assert provider.context_at("scene", 4999.9).room is RoomLabel.HALLWAY
    assert provider.context_at("scene", 5000.0).room is RoomLabel.KITCHEN
    assert provider.context_at("scene", 10_000_000.0).room is RoomLabel.KITCHEN


def test_load_derives_is_night_from_local_hour(tmp_path: Path) -> None:
    path = _script(
        tmp_path,
        json.dumps(_row(from_ms=0, room="bedroom", local_hour=23)),
        json.dumps(_row(from_ms=1000, room="bedroom", local_hour=9)),
    )
    provider = ScriptedHomeProvider.load(path)
    assert provider.context_at("scene", 0.0).is_night
    assert not provider.context_at("scene", 1000.0).is_night


def test_load_treats_missing_local_hour_as_daytime(tmp_path: Path) -> None:
    path = _script(
        tmp_path,
        json.dumps(_row(from_ms=0, room="bedroom")),
        json.dumps(_row(from_ms=1000, room="bedroom", local_hour=None)),
    )
    provider = ScriptedHomeProvider.load(path)
    for timestamp in (0.0, 1000.0):
        context = provider.context_at("scene", timestamp)
        assert context.local_hour is None
        assert not context.is_night


def test_load_honours_explicit_is_night_override(tmp_path: Path) -> None:
    path = _script(
        tmp_path,
        json.dumps(_row(from_ms=0, room="bedroom", local_hour=14, is_night=True)),
        json.dumps(_row(from_ms=1000, room="bedroom", local_hour=3, is_night=False)),
    )
    provider = ScriptedHomeProvider.load(path)
    assert provider.context_at("scene", 0.0).is_night
    assert not provider.context_at("scene", 1000.0).is_night


def test_load_rejects_schema_violations(tmp_path: Path) -> None:
    bad_lines = [
        json.dumps({"room": "kitchen"}),  # from_ms missing
        json.dumps(_row(from_ms=-1)),  # negative from_ms
        json.dumps(_row(from_ms="0")),  # from_ms not a number
        json.dumps(_row(from_ms=True)),  # bool is not a timestamp
        json.dumps({"from_ms": 0}),  # room missing
        json.dumps(_row(room="garage")),  # room outside the enum
        json.dumps(_row(local_hour=24)),  # hour out of range
        json.dumps(_row(local_hour=-1)),  # hour out of range
        json.dumps(_row(local_hour=2.5)),  # hour not an integer
        json.dumps(_row(is_night="yes")),  # is_night not a boolean
        json.dumps(_row(is_night=None)),  # null is not a boolean
        json.dumps(_row(ambient=["夜灯"])),  # ambient not an object
        json.dumps(_row(ambient={"夜灯": 1})),  # ambient value not a string
        json.dumps(_row(schema_version="reme-home-context/v9")),  # wrong schema
        json.dumps([1, 2, 3]),  # not a JSON object
        "{not json",  # not JSON at all
    ]
    for index, line in enumerate(bad_lines):
        path = _script(tmp_path, line, name=f"bad_{index}.jsonl")
        with pytest.raises(HomeScriptError):
            ScriptedHomeProvider.load(path)


def test_load_rejects_descending_rows_with_a_line_number(tmp_path: Path) -> None:
    path = _script(
        tmp_path,
        json.dumps(_row(from_ms=0)),
        json.dumps(_row(from_ms=5000)),
        json.dumps(_row(from_ms=4000)),
    )
    with pytest.raises(HomeScriptError, match="line 3"):
        ScriptedHomeProvider.load(path)


def test_load_rejects_an_unreadable_file(tmp_path: Path) -> None:
    with pytest.raises(HomeScriptError):
        ScriptedHomeProvider.load(tmp_path / "missing.jsonl")


def test_bathroom_shortens_stillness_and_watches_lying() -> None:
    base = TriggerConfig()
    for is_night in (False, True):
        adjusted = adjust_trigger_config(base, _home(room=RoomLabel.BATHROOM, is_night=is_night))
        assert adjusted.long_still_min_ms == base.long_still_min_ms * 0.5
        assert Posture.LYING in adjusted.concern_postures
        assert base.concern_postures <= adjusted.concern_postures


def test_bedroom_at_night_earns_a_longer_stillness_leash() -> None:
    base = TriggerConfig()
    home = _home(room=RoomLabel.BEDROOM, local_hour=2, is_night=True)
    adjusted = adjust_trigger_config(base, home)
    assert adjusted.long_still_min_ms == base.long_still_min_ms * 3.0
    assert adjusted.concern_postures == base.concern_postures


def test_night_outside_the_bedroom_tightens_stillness_slightly() -> None:
    base = TriggerConfig()
    for room in (RoomLabel.LIVING_ROOM, RoomLabel.KITCHEN, RoomLabel.HALLWAY, RoomLabel.UNKNOWN):
        adjusted = adjust_trigger_config(base, _home(room=room, local_hour=2, is_night=True))
        assert adjusted.long_still_min_ms == base.long_still_min_ms * 0.75


def test_daytime_outside_the_bathroom_leaves_thresholds_at_base() -> None:
    base = TriggerConfig()
    for room in (RoomLabel.LIVING_ROOM, RoomLabel.BEDROOM, RoomLabel.KITCHEN, RoomLabel.UNKNOWN):
        home = _home(room=room, local_hour=14, is_night=False)
        adjusted = adjust_trigger_config(base, home)
        assert adjusted == base
        assert adjusted is not base


def test_safety_fields_are_never_modulated_by_any_home_context() -> None:
    base = TriggerConfig()
    for home in _all_home_contexts():
        adjusted = adjust_trigger_config(base, home)
        assert adjusted.fall_confidence_min == base.fall_confidence_min
        assert adjusted.check_in_timeout_ms == base.check_in_timeout_ms
        assert adjusted.fall_response_timeout_ms == base.fall_response_timeout_ms
        assert adjusted.family_ack_timeout_ms == base.family_ack_timeout_ms
        assert adjusted.rewind_tolerance_ms == base.rewind_tolerance_ms
        assert adjusted.default_privacy_mode == base.default_privacy_mode
    assert base == TriggerConfig()


def test_stillness_scaling_stays_inside_the_clamp_band() -> None:
    base = TriggerConfig()
    for home in _all_home_contexts():
        ratio = adjust_trigger_config(base, home).long_still_min_ms / base.long_still_min_ms
        assert MIN_STILL_SCALE <= ratio <= MAX_STILL_SCALE
        assert _clamp_still_scale(_raw_still_scale(home)) == ratio
    # The clamp is the hard bound, not a formality the table happens to satisfy.
    assert _clamp_still_scale(99.0) == MAX_STILL_SCALE
    assert _clamp_still_scale(0.01) == MIN_STILL_SCALE


def test_home_summary_zh_matches_the_reference_line() -> None:
    home = _home(local_hour=2, room=RoomLabel.BATHROOM, ambient={"夜灯": "开"})
    assert home_summary_zh(home) == "环境：凌晨2点，卫生间，夜灯:开"


def test_home_summary_zh_labels_every_hour_period() -> None:
    expected = {
        0: "凌晨12点",
        2: "凌晨2点",
        5: "凌晨5点",
        6: "上午6点",
        11: "上午11点",
        12: "下午12点",
        15: "下午3点",
        17: "下午5点",
        18: "晚上6点",
        21: "晚上9点",
        22: "深夜10点",
        23: "深夜11点",
    }
    for hour, label in expected.items():
        home = _home(local_hour=hour, room=RoomLabel.BEDROOM)
        assert home_summary_zh(home) == f"环境：{label}，卧室"


def test_home_summary_zh_maps_every_room() -> None:
    expected = {
        RoomLabel.LIVING_ROOM: "客厅",
        RoomLabel.BEDROOM: "卧室",
        RoomLabel.BATHROOM: "卫生间",
        RoomLabel.KITCHEN: "厨房",
        RoomLabel.HALLWAY: "走廊",
        RoomLabel.UNKNOWN: "位置未知",
    }
    for room, label in expected.items():
        assert home_summary_zh(_home(local_hour=None, room=room)) == f"环境：{label}"


def test_home_summary_zh_omits_absent_time_and_sorts_ambient_keys() -> None:
    assert home_summary_zh(default_home_context()) == "环境：位置未知"
    home = _home(local_hour=None, room=RoomLabel.KITCHEN, ambient={"温度": "22", "夜灯": "关"})
    assert home_summary_zh(home) == "环境：厨房，夜灯:关，温度:22"


# --- Codex R3 regressions ---------------------------------------------------


def test_nan_from_ms_is_rejected(tmp_path: Path) -> None:
    path = _script(tmp_path, json.dumps({"from_ms": float("nan"), "room": "bedroom"}))
    with pytest.raises(HomeScriptError):
        ScriptedHomeProvider.load(path)


def test_infinite_from_ms_is_rejected_by_constructor() -> None:
    with pytest.raises(HomeScriptError):
        ScriptedHomeProvider(((float("inf"), default_home_context()),))
