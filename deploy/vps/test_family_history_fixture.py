import json
from pathlib import Path

from reme.runtime.decision.mimo.adapter import MimoCallResult
from reme.runtime.history.projection import load_projected_demo_fixture
from reme.runtime.history.summary import DiarySummaryService

FIXTURE = Path(__file__).with_name("fixtures") / "reme-aug-2026-family-summary-v2.json"
EXPECTED_TOTALS = {
    "2026-08-04": 32,
    "2026-08-05": 30,
    "2026-08-06": 29,
    "2026-08-07": 28,
    "2026-08-08": 27,
    "2026-08-09": 38,
    "2026-08-10": 29,
    "2026-08-11": 30,
}


def test_family_summary_fixture_matches_rich_frontend_timeline_counts() -> None:
    fixture = load_projected_demo_fixture(FIXTURE)

    assert fixture.revision == 2
    assert {
        date_key: day["counts"]["total"]
        for date_key, day in fixture.day_states.items()
    } == EXPECTED_TOTALS
    assert all(day["mode"] == "mock_fixture" for day in fixture.day_states.values())


class _FakeMimo:
    def __init__(self) -> None:
        self.calls = 0

    def complete(self, *, system_prompt: str, user_content: str) -> MimoCallResult:
        self.calls += 1
        assert "禁止诊断" in system_prompt
        assert json.loads(user_content)["counts"]["total"] == 30
        return MimoCallResult(
            content=json.dumps(
                {
                    "headline": "上午有活动记录，午后已完成一次问候",
                    "summary": "结构化记录包含匿名活动、设备事实和一次主动关怀。",
                    "highlights": [{"time": "08:10", "text": "客厅出现匿名姿态活动"}],
                    "care_note": "一次主动关怀已收到本人回应。",
                    "uncertainty": "medium",
                },
                ensure_ascii=False,
            ),
            latency_ms=12.0,
            attempts=1,
        )


def test_family_fixture_generates_and_caches_a_real_mimo_shaped_summary(
    tmp_path: Path,
) -> None:
    day = load_projected_demo_fixture(FIXTURE).day_states["2026-08-11"]
    mimo = _FakeMimo()
    service = DiarySummaryService(
        client=mimo,  # type: ignore[arg-type]
        cache_path=tmp_path / "summary-cache.json",
        clock_ms=lambda: 1_786_434_400_000,
    )

    first = service.generate(day)
    second = service.generate(day)

    assert first["status"] == "ready"
    assert first["input_timeline_revision"] == 2
    assert first["summary"]["source"] == "mimo"
    assert first["summary"]["input_event_count"] == 30
    assert second == first
    assert mimo.calls == 1
