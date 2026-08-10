from __future__ import annotations

import json
from pathlib import Path

from reme.runtime.decision.mimo.adapter import MimoCallResult
from reme.runtime.history.projection import load_projected_demo_fixture
from reme.runtime.history.summary import DiarySummaryService


class _FakeMimo:
    def __init__(self, content: dict[str, object]) -> None:
        self.content = content
        self.calls = 0

    def complete(self, *, system_prompt: str, user_content: str) -> MimoCallResult:
        self.calls += 1
        assert "禁止诊断" in system_prompt
        assert "timeline_revision" in user_content
        return MimoCallResult(
            content=json.dumps(self.content, ensure_ascii=False),
            latency_ms=12.0,
            attempts=1,
        )


def _day() -> dict[str, object]:
    return load_projected_demo_fixture().day_states["2026-08-09"]


def test_summary_is_explicitly_unavailable_without_backend_mimo(tmp_path: Path) -> None:
    service = DiarySummaryService(
        client=None,
        cache_path=tmp_path / "cache.json",
        clock_ms=lambda: 1000,
    )

    state = service.generate(_day())

    assert state["status"] == "unavailable"
    assert state["error_code"] == "mimo_not_configured"
    assert state["summary"] is None


def test_summary_validates_output_and_caches_by_timeline_input(tmp_path: Path) -> None:
    fake = _FakeMimo(
        {
            "headline": "上午形成一次家庭分享",
            "summary": "结构化记录包含匿名活动、设备事实和一次主动关怀。",
            "highlights": [
                {"time": "10:42", "text": "冰箱记录了有来源支持的物品取出事件"},
                {"time": "11:36", "text": "本人同意把午饭信息作为演示材料分享"},
            ],
            "care_note": "一次主动关怀已收到回应，并形成 Mock 家庭材料。",
            "uncertainty": "medium",
        }
    )
    cache = tmp_path / "summary-cache.json"
    service = DiarySummaryService(
        client=fake,  # type: ignore[arg-type]
        cache_path=cache,
        clock_ms=lambda: 2000,
    )

    first = service.generate(_day())
    second = service.generate(_day())

    assert first["status"] == "ready"
    assert first["input_timeline_revision"] == 1
    assert first["summary"]["source"] == "mimo"
    assert first["summary"]["attempts"] == 1
    assert second == first
    assert fake.calls == 1


def test_explicit_summary_retry_increments_summary_revision(tmp_path: Path) -> None:
    cache = tmp_path / "summary-cache.json"
    unavailable = DiarySummaryService(client=None, cache_path=cache, clock_ms=lambda: 1000)
    first = unavailable.generate(_day())
    assert first["status"] == "unavailable"
    assert first["revision"] == 1

    fake = _FakeMimo(
        {
            "headline": "人工重试后的摘要",
            "summary": "同一时间线输入只在显式重试后再次调用 MiMo。",
            "highlights": [{"time": "10:42", "text": "冰箱记录了物品取出事件"}],
            "care_note": "一次关怀已收到回应。",
            "uncertainty": "medium",
        }
    )
    retried = DiarySummaryService(
        client=fake,  # type: ignore[arg-type]
        cache_path=cache,
        clock_ms=lambda: 2000,
    ).generate(_day(), force_retry=True)

    assert retried["status"] == "ready"
    assert retried["revision"] == 2
    assert retried["input_timeline_revision"] == 1
    assert fake.calls == 1


def test_summary_rejects_hallucinated_highlight_time(tmp_path: Path) -> None:
    fake = _FakeMimo(
        {
            "headline": "今日摘要",
            "summary": "只做结构化事实摘要。",
            "highlights": [{"time": "09:99", "text": "不存在的时间"}],
            "care_note": "一次关怀。",
            "uncertainty": "high",
        }
    )
    service = DiarySummaryService(
        client=fake,  # type: ignore[arg-type]
        cache_path=tmp_path / "cache.json",
        clock_ms=lambda: 3000,
    )

    state = service.generate(_day())

    assert state["status"] == "unavailable"
    assert state["error_code"] == "mimo_invalid_output"
