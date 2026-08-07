"""Offline tests for the large-sample prompt experiment harness."""

from __future__ import annotations

import json
import math
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pytest
from reme.runtime.decision.mimo import experiment
from reme.runtime.decision.mimo.adapter import MimoClient, MimoClientConfig
from reme.runtime.decision.mimo.experiment import (
    SCENARIOS,
    VARIANTS,
    ExperimentReport,
    PromptVariant,
    SampleOutcome,
    ScenarioSpec,
    render_report_md,
    run_experiment,
)
from reme.runtime.decision.mimo.prompts import PersonaConfig
from reme.runtime.decision.mimo.schema import TASK_STATE_ALLOWLIST
from reme.runtime.decision.state_machine import MimoTask

_PERCEPTION_KEYS = {
    "timestamp_ms",
    "posture",
    "posture_duration_ms",
    "motion_level",
    "landmark_quality",
    "recent_transition",
}
_INTERACTION_KEYS = {"phase", "clarification_used", "complaint_text"}


def _proposal_json(**overrides: Any) -> str:
    payload: dict[str, Any] = {
        "state": "check_in_required",
        "risk_level": 2,
        "need_dialogue": True,
        "dialogue_goal": "understand_need",
        "elder_message": "王奶奶，坐了挺久啦，今天午饭吃得还顺口吗？",
        "family_notification": None,
        "consent_required": False,
        "reason_summary": "长时间静坐，例行轻量问候",
        "uncertainty": "medium",
        "privacy_mode": None,
        "action_card": None,
    }
    payload.update(overrides)
    return json.dumps(payload, ensure_ascii=False)


def _completion_bytes(content: str) -> bytes:
    payload = {"choices": [{"message": {"role": "assistant", "content": content}}]}
    return json.dumps(payload).encode("utf-8")


def _client(content: str, *, captured: list[urllib.request.Request] | None = None) -> MimoClient:
    def transport(request: urllib.request.Request, timeout: float) -> bytes:
        if captured is not None:
            captured.append(request)
        return _completion_bytes(content)

    return MimoClient(MimoClientConfig(api_key="sk-test"), transport=transport)


def _failing_client() -> MimoClient:
    def transport(request: urllib.request.Request, timeout: float) -> bytes:
        raise urllib.error.URLError("connection refused")

    return MimoClient(MimoClientConfig(api_key="sk-test", max_attempts=1), transport=transport)


def _scenario(name: str) -> ScenarioSpec:
    return next(spec for spec in SCENARIOS if spec.name == name)


def _run_one(
    content: str, scenario_name: str, *, variant: PromptVariant = VARIANTS[0]
) -> SampleOutcome:
    report = run_experiment(
        _client(content),
        persona=PersonaConfig(),
        scenarios=[_scenario(scenario_name)],
        variants=[variant],
        samples_per_cell=1,
        pace_seconds=0.0,
        sleep_fn=lambda _seconds: None,
    )
    return report.outcomes[0]


def _user_content(request: urllib.request.Request) -> str:
    assert request.data is not None
    body = json.loads(request.data.decode("utf-8"))
    content = body["messages"][1]["content"]
    assert isinstance(content, str)
    return content


def _system_content(request: urllib.request.Request) -> str:
    assert request.data is not None
    body = json.loads(request.data.decode("utf-8"))
    content = body["messages"][0]["content"]
    assert isinstance(content, str)
    return content


def test_scenarios_meet_the_curriculum_contract() -> None:
    assert len(SCENARIOS) >= 8
    names = [spec.name for spec in SCENARIOS]
    assert len(set(names)) == len(names)
    assert {spec.task for spec in SCENARIOS} == set(MimoTask)
    for spec in SCENARIOS:
        allowed = {state.value for state in TASK_STATE_ALLOWLIST[spec.task]}
        assert spec.expected_states
        assert spec.expected_states <= allowed, spec.name
        assert set(spec.perception_summary) == _PERCEPTION_KEYS, spec.name
        assert set(spec.interaction_summary) == _INTERACTION_KEYS, spec.name
    with_context = [spec.name for spec in SCENARIOS if spec.context_sections]
    assert "night-bathroom-lying" in with_context
    assert "night-fall-card" in with_context


def test_variants_are_stock_and_context() -> None:
    assert [variant.name for variant in VARIANTS] == ["v1-stock", "v2-context"]
    assert [variant.system_suffix for variant in VARIANTS] == [None, None]
    assert [variant.include_context_sections for variant in VARIANTS] == [False, True]


def test_valid_completion_scores_all_green() -> None:
    outcome = _run_one(_proposal_json(), "routine-sitting")
    assert outcome.json_ok is True
    assert outcome.schema_ok is True
    assert outcome.state == "check_in_required"
    assert outcome.expected_hit is True
    assert outcome.appellation_ok is True
    assert outcome.error is None
    assert outcome.latency_ms > 0.0


def test_fenced_completion_fails_json_but_still_passes_schema() -> None:
    outcome = _run_one(f"```json\n{_proposal_json()}\n```", "routine-sitting")
    assert outcome.json_ok is False
    assert outcome.schema_ok is True
    assert outcome.state == "check_in_required"
    assert outcome.expected_hit is True


def test_invalid_json_fails_both_gates() -> None:
    outcome = _run_one("老人看起来还好，我就不打扰了。", "routine-sitting")
    assert outcome.json_ok is False
    assert outcome.schema_ok is False
    assert outcome.state is None
    assert outcome.expected_hit is False
    assert outcome.appellation_ok is None
    assert outcome.error is not None


def test_out_of_allowlist_state_keeps_the_raw_state_and_fails_schema() -> None:
    outcome = _run_one(_proposal_json(state="urgent_attention"), "routine-sitting")
    assert outcome.json_ok is True
    assert outcome.schema_ok is False
    assert outcome.state == "urgent_attention"
    assert outcome.expected_hit is False
    assert outcome.error is not None
    assert "allowlist" in outcome.error


def test_schema_error_excerpt_is_truncated() -> None:
    payload = json.loads(_proposal_json())
    payload.update({f"stray_field_{index}": 1 for index in range(30)})
    outcome = _run_one(json.dumps(payload, ensure_ascii=False), "routine-sitting")
    assert outcome.schema_ok is False
    assert outcome.error is not None
    assert len(outcome.error) == 120


def test_appellation_mismatch_is_flagged() -> None:
    outcome = _run_one(_proposal_json(elder_message="李爷爷，坐挺久了吧？"), "routine-sitting")
    assert outcome.schema_ok is True
    assert outcome.appellation_ok is False
    assert outcome.expected_hit is True


def test_appellation_is_none_when_no_elder_message() -> None:
    content = _proposal_json(
        state="consent_required", elder_message=None, dialogue_goal="request_consent"
    )
    outcome = _run_one(content, "toothache-complaint")
    assert outcome.schema_ok is True
    assert outcome.appellation_ok is None
    assert outcome.expected_hit is True


def test_expected_hit_is_false_for_a_legal_but_unexpected_branch() -> None:
    outcome = _run_one(_proposal_json(state="check_in_required"), "toothache-complaint")
    assert outcome.schema_ok is True
    assert outcome.state == "check_in_required"
    assert outcome.expected_hit is False


def test_transport_failure_produces_an_unmeasured_scored_row() -> None:
    report = run_experiment(
        _failing_client(),
        persona=PersonaConfig(),
        scenarios=[_scenario("routine-sitting")],
        variants=[VARIANTS[0]],
        samples_per_cell=1,
        pace_seconds=0.0,
        sleep_fn=lambda _seconds: None,
    )
    outcome = report.outcomes[0]
    assert outcome.json_ok is False
    assert outcome.schema_ok is False
    assert outcome.state is None
    assert outcome.expected_hit is False
    assert outcome.appellation_ok is None
    # NaN marks "no measurement" so percentiles never ingest it (Codex R3).
    assert math.isnan(outcome.latency_ms)
    assert outcome.error is not None
    assert "sk-test" not in outcome.error


def test_pace_sleeps_between_calls_only() -> None:
    slept: list[float] = []
    report = run_experiment(
        _client(_proposal_json()),
        persona=PersonaConfig(),
        scenarios=[_scenario("routine-sitting")],
        variants=list(VARIANTS),
        samples_per_cell=3,
        pace_seconds=0.25,
        sleep_fn=slept.append,
    )
    assert len(report.outcomes) == 6
    assert slept == [0.25] * 5


def test_context_sections_reach_the_user_content_only_for_v2() -> None:
    captured: list[urllib.request.Request] = []
    run_experiment(
        _client(_proposal_json(), captured=captured),
        persona=PersonaConfig(),
        scenarios=[_scenario("night-bathroom-lying")],
        variants=list(VARIANTS),
        samples_per_cell=1,
        pace_seconds=0.0,
        sleep_fn=lambda _seconds: None,
    )
    stock, context = (_user_content(request) for request in captured)
    assert "【长期记忆】" not in stock
    assert "【居家上下文】" not in stock
    assert "【行为特征】近2分钟：体位由站转躺，随后持续静止" in context
    assert "【长期记忆】记忆：今天凌晨已第2次起夜" in context
    assert "【居家上下文】环境：凌晨2点，卫生间，夜灯:开" in context


def test_context_sections_are_spliced_above_the_tail_line() -> None:
    captured: list[urllib.request.Request] = []
    run_experiment(
        _client(_proposal_json(), captured=captured),
        persona=PersonaConfig(),
        scenarios=[_scenario("night-bathroom-lying")],
        variants=[VARIANTS[1]],
        samples_per_cell=1,
        pace_seconds=0.0,
        sleep_fn=lambda _seconds: None,
    )
    lines = _user_content(captured[0]).split("\n")
    assert lines[-1] == "只输出 JSON 对象。"
    assert lines[-2] == "【居家上下文】环境：凌晨2点，卫生间，夜灯:开"
    assert lines[-4] == "【行为特征】近2分钟：体位由站转躺，随后持续静止"


def test_system_suffix_is_appended_when_a_variant_declares_one() -> None:
    captured: list[urllib.request.Request] = []
    suffix = "补充约束：每句话不超过 20 个字。"
    run_experiment(
        _client(_proposal_json(), captured=captured),
        persona=PersonaConfig(),
        scenarios=[_scenario("routine-sitting")],
        variants=[PromptVariant("v3-suffix", suffix, False)],
        samples_per_cell=1,
        pace_seconds=0.0,
        sleep_fn=lambda _seconds: None,
    )
    assert _system_content(captured[0]).endswith(f"\n\n{suffix}")


def test_progress_reports_ok_and_err_per_sample() -> None:
    lines: list[str] = []
    run_experiment(
        _client("不是 JSON"),
        persona=PersonaConfig(),
        scenarios=[_scenario("routine-sitting")],
        variants=[VARIANTS[0]],
        samples_per_cell=2,
        pace_seconds=0.0,
        sleep_fn=lambda _seconds: None,
        on_progress=lines.append,
    )
    assert lines == [
        "routine-sitting/v1-stock 1/2 ERR",
        "routine-sitting/v1-stock 2/2 ERR",
    ]
    ok_lines: list[str] = []
    run_experiment(
        _client(_proposal_json()),
        persona=PersonaConfig(),
        scenarios=[_scenario("routine-sitting")],
        variants=[VARIANTS[0]],
        samples_per_cell=1,
        pace_seconds=0.0,
        sleep_fn=lambda _seconds: None,
        on_progress=ok_lines.append,
    )
    assert ok_lines == ["routine-sitting/v1-stock 1/1 ok"]


def _outcome(**overrides: Any) -> SampleOutcome:
    fields: dict[str, Any] = {
        "scenario": "sX",
        "variant": "vA",
        "json_ok": True,
        "schema_ok": True,
        "state": "check_in_required",
        "expected_hit": True,
        "appellation_ok": True,
        "latency_ms": 100.0,
        "error": None,
    }
    fields.update(overrides)
    return SampleOutcome(**fields)


def test_render_report_md_computes_rates_and_nearest_rank_percentiles() -> None:
    # Latencies 100/200/300/400: P50 -> ceil(0.5*4)=2 -> 200, P95 -> ceil(3.8)=4 -> 400.
    # json 3/4, schema 2/4, expected 1/4, appellation 1/2 (two samples unjudged).
    report = ExperimentReport(
        outcomes=(
            _outcome(latency_ms=100.0),
            _outcome(latency_ms=200.0, schema_ok=False, expected_hit=False, appellation_ok=False),
            _outcome(
                latency_ms=300.0,
                json_ok=False,
                schema_ok=False,
                expected_hit=False,
                appellation_ok=None,
                state="consent_required",
            ),
            _outcome(latency_ms=400.0, expected_hit=False, appellation_ok=None, state=None),
        )
    )
    markdown = render_report_md(report)
    expected = (
        "| vA | sX | 4 | 75.0% | 50.0% | 25.0% | 50.0% | "
        "check_in_required:2 consent_required:1 null:1 | 200 | 400 |"
    )
    assert expected in markdown
    assert markdown.startswith("# MiMo 提示词大样本实验报告")
    assert "| 变体 | 场景 | 样本数 |" in markdown
    # One per-cell row plus one variant rollup plus the grand total.
    assert markdown.count("| vA |") == 2
    assert "| （全部变体） | （全部场景） | 4 |" in markdown


def test_render_report_md_marks_empty_denominators() -> None:
    report = ExperimentReport(
        outcomes=(
            _outcome(
                json_ok=False,
                schema_ok=False,
                state=None,
                expected_hit=False,
                appellation_ok=None,
                latency_ms=float("nan"),  # transport failure: no measurement (Codex R3)
                error="MiMo call failed",
            ),
        )
    )
    markdown = render_report_md(report)
    assert "| vA | sX | 1 | 0.0% | 0.0% | 0.0% | — | null:1 | — | — |" in markdown


def test_render_report_md_separates_variants_and_scenarios() -> None:
    report = ExperimentReport(
        outcomes=(
            _outcome(variant="vA", scenario="s1"),
            _outcome(variant="vB", scenario="s1", expected_hit=False),
            _outcome(variant="vB", scenario="s2"),
        )
    )
    markdown = render_report_md(report)
    assert "| vA | s1 | 1 |" in markdown
    assert "| vB | s1 | 1 |" in markdown
    assert "| vB | s2 | 1 |" in markdown
    # vA never ran s2, so no empty cell row is emitted for it.
    assert "| vA | s2 |" not in markdown
    assert "| vB | （全部场景） | 2 |" in markdown


@pytest.mark.parametrize(
    "argument",
    [["--variant", "v9-nope"], ["--scenario", "does-not-exist"]],
)
def test_main_rejects_unknown_names(
    argument: list[str], tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code = experiment.main([*argument, "--out", str(tmp_path / "out")])
    assert code == 2
    captured = capsys.readouterr()
    assert "未知的" in captured.err
    assert not (tmp_path / "out").exists()


def test_main_requires_the_api_key_without_echoing_the_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("MIMO_API_KEY", raising=False)
    code = experiment.main(["--out", str(tmp_path / "out")])
    assert code == 2
    captured = capsys.readouterr()
    assert captured.err.strip() == "MIMO_API_KEY 未配置"
    assert captured.out == ""


class _FakeResponse:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def __enter__(self) -> _FakeResponse:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return self._payload


def test_main_writes_outcomes_and_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("MIMO_API_KEY", "sk-fake")
    payload = _completion_bytes(_proposal_json())

    def fake_urlopen(request: urllib.request.Request, timeout: float) -> _FakeResponse:
        return _FakeResponse(payload)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    out_dir = tmp_path / "run"
    code = experiment.main(
        [
            "--out",
            str(out_dir),
            "--samples",
            "2",
            "--pace",
            "0",
            "--variant",
            "v1-stock",
            "--scenario",
            "routine-sitting",
        ]
    )
    assert code == 0
    rows = [
        json.loads(line)
        for line in (out_dir / "outcomes.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert len(rows) == 2
    assert rows[0]["scenario"] == "routine-sitting"
    assert rows[0]["variant"] == "v1-stock"
    assert rows[0]["expected_hit"] is True
    markdown = (out_dir / "report.md").read_text(encoding="utf-8")
    assert markdown.startswith("# MiMo 提示词大样本实验报告")
    captured = capsys.readouterr()
    assert markdown in captured.out
    assert "sk-fake" not in captured.out
    assert "sk-fake" not in captured.err
    assert "sk-fake" not in markdown
