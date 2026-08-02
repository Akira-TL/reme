"""Large-sample prompt experiment harness (B spec P1-1).

Measures, per scenario x prompt variant: JSON parse rate, schema-valid
rate, state-branch distribution against the expected set, appellation
compliance, and latency P50/P95.  Offline-testable through the adapter's
injectable transport; the CLI paces the live endpoint under the RPM cap
and never prints the API key.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
import sys
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, TypeVar

from reme.decision.mimo.adapter import (
    MimoCallResult,
    MimoClient,
    MimoTransportError,
    config_from_environment,
)
from reme.decision.mimo.prompts import PersonaConfig, build_system_prompt, build_user_prompt
from reme.decision.mimo.schema import MimoSchemaError, parse_mimo_proposal
from reme.decision.state_machine import MimoTask

DEFAULT_SAMPLES_PER_CELL = 10
DEFAULT_PACE_SECONDS = 0.7

_ERROR_EXCERPT_CHARS = 120


@dataclass(frozen=True, slots=True)
class PromptVariant:
    """One prompt treatment applied uniformly across scenarios."""

    name: str
    system_suffix: str | None
    include_context_sections: bool


@dataclass(frozen=True, slots=True)
class ScenarioSpec:
    """One synthetic decision situation with its acceptable state branches."""

    name: str
    task: MimoTask
    perception_summary: Mapping[str, object]
    interaction_summary: Mapping[str, object]
    elder_text: str | None
    expected_states: frozenset[str]
    context_sections: Mapping[str, str]


@dataclass(frozen=True, slots=True)
class SampleOutcome:
    """One live call, fully judged."""

    scenario: str
    variant: str
    json_ok: bool
    schema_ok: bool
    state: str | None
    expected_hit: bool
    appellation_ok: bool | None
    latency_ms: float
    error: str | None


@dataclass(frozen=True, slots=True)
class ExperimentReport:
    """The raw outcomes; aggregation happens at render time."""

    outcomes: tuple[SampleOutcome, ...]


SCENARIOS: tuple[ScenarioSpec, ...] = (
    # 1. 例行久坐：只有静坐时长这一条弱证据，没有主诉也没有跌倒迹象，
    #    模型唯一可选的分支就是一次不惊扰的主动问候。
    ScenarioSpec(
        name="routine-sitting",
        task=MimoTask.COMPOSE_CHECK_IN,
        perception_summary={
            "timestamp_ms": 1_754_000_000_000,
            "posture": "sitting",
            "posture_duration_ms": 45_000,
            "motion_level": "still",
            "landmark_quality": "usable",
            "recent_transition": None,
        },
        interaction_summary={
            "phase": "monitoring",
            "clarification_used": False,
            "complaint_text": None,
        },
        elder_text=None,
        expected_states=frozenset({"check_in_required"}),
        context_sections={},
    ),
    # 2. 夜间卫生间躺卧：站转躺 + 凌晨起夜是典型的"看着像跌倒其实不是"。
    #    单次躺卧不等于跌倒（系统提示第 2 条），升级归本地规则；
    #    模型该做的仍然只是先开口问一句，因此期望依然是 check_in_required。
    ScenarioSpec(
        name="night-bathroom-lying",
        task=MimoTask.COMPOSE_CHECK_IN,
        perception_summary={
            "timestamp_ms": 1_754_003_600_000,
            "posture": "lying",
            "posture_duration_ms": 40_000,
            "motion_level": "still",
            "landmark_quality": "usable",
            "recent_transition": "uncertain_transition",
        },
        interaction_summary={
            "phase": "monitoring",
            "clarification_used": False,
            "complaint_text": None,
        },
        elder_text=None,
        expected_states=frozenset({"check_in_required"}),
        context_sections={
            "行为特征": "近2分钟：体位由站转躺，随后持续静止",
            "长期记忆": "记忆：今天凌晨已第2次起夜",
            "居家上下文": "环境：凌晨2点，卫生间，夜灯:开",
        },
    ),
    # 3. 牙疼主诉：诉求明确、影响进食但不紧急，属于"要告诉家人之前先征得同意"，
    #    所以唯一正确分支是 consent_required；直接跳到通知家人属于越权。
    ScenarioSpec(
        name="toothache-complaint",
        task=MimoTask.INTERPRET_RESPONSE,
        perception_summary={
            "timestamp_ms": 1_754_000_120_000,
            "posture": "sitting",
            "posture_duration_ms": 1_860_000,
            "motion_level": "still",
            "landmark_quality": "usable",
            "recent_transition": None,
        },
        interaction_summary={
            "phase": "awaiting_elder",
            "clarification_used": False,
            "complaint_text": None,
        },
        elder_text="牙疼，饭都咬不动了",
        expected_states=frozenset({"consent_required"}),
        context_sections={},
    ),
    # 4. 含糊回话："有点没劲"既可以再问一句澄清，也可以直接征求授权，
    #    两条路都不算判断失误，因此期望集合刻意放宽为两个分支。
    ScenarioSpec(
        name="vague-reply",
        task=MimoTask.INTERPRET_RESPONSE,
        perception_summary={
            "timestamp_ms": 1_754_000_180_000,
            "posture": "sitting",
            "posture_duration_ms": 2_400_000,
            "motion_level": "low",
            "landmark_quality": "usable",
            "recent_transition": None,
        },
        interaction_summary={
            "phase": "awaiting_elder",
            "clarification_used": False,
            "complaint_text": None,
        },
        elder_text="还行吧，就是有点没劲",
        expected_states=frozenset({"check_in_required", "consent_required"}),
        context_sections={},
    ),
    # 5. 明确拒绝告知家人：老人已经收回授权，模型不得再要一次同意、
    #    更不得生成家人通知；正确做法是退回轻量陪伴，即 check_in_required。
    ScenarioSpec(
        name="refuses-family-notice",
        task=MimoTask.INTERPRET_RESPONSE,
        perception_summary={
            "timestamp_ms": 1_754_000_240_000,
            "posture": "sitting",
            "posture_duration_ms": 2_700_000,
            "motion_level": "low",
            "landmark_quality": "usable",
            "recent_transition": None,
        },
        interaction_summary={
            "phase": "awaiting_consent",
            "clarification_used": False,
            "complaint_text": None,
        },
        elder_text="不用了不用了，别告诉他们",
        expected_states=frozenset({"check_in_required"}),
        context_sections={},
    ),
    # 6. 空泛呻吟：一声"哎哟"里没有任何可用诉求，编造病名属于幻觉升级；
    #    澄清额度还没用掉，正确做法是再问一句，即 check_in_required。
    ScenarioSpec(
        name="ambiguous-groan",
        task=MimoTask.INTERPRET_RESPONSE,
        perception_summary={
            "timestamp_ms": 1_754_000_300_000,
            "posture": "standing",
            "posture_duration_ms": 15_000,
            "motion_level": "low",
            "landmark_quality": "degraded",
            "recent_transition": "normal_transition",
        },
        interaction_summary={
            "phase": "awaiting_elder",
            "clarification_used": False,
            "complaint_text": None,
        },
        elder_text="哎哟……",
        expected_states=frozenset({"check_in_required"}),
        context_sections={},
    ),
    # 7. 牙疼授权后成卡：授权已拿到，任务是把主诉整理成家人行动卡；
    #    compose_card 的白名单只有一个分支，elder_quote 必须逐字回到主诉原文。
    ScenarioSpec(
        name="toothache-card",
        task=MimoTask.COMPOSE_CARD,
        perception_summary={
            "timestamp_ms": 1_754_000_360_000,
            "posture": "sitting",
            "posture_duration_ms": 1_920_000,
            "motion_level": "still",
            "landmark_quality": "usable",
            "recent_transition": None,
        },
        interaction_summary={
            "phase": "awaiting_consent",
            "clarification_used": True,
            "complaint_text": "牙疼，饭都咬不动了",
        },
        elder_text=None,
        expected_states=frozenset({"family_notification_required"}),
        context_sections={},
    ),
    # 8. 起夜跌倒授权后成卡：带居家上下文的夜间滑倒主诉，
    #    考察模型在有环境细节时是否仍只输出 family_notification_required，
    #    并且不把"凌晨2点/卫生间"这类隐私环境细节写进给家人的通知里。
    ScenarioSpec(
        name="night-fall-card",
        task=MimoTask.COMPOSE_CARD,
        perception_summary={
            "timestamp_ms": 1_754_003_720_000,
            "posture": "standing",
            "posture_duration_ms": 20_000,
            "motion_level": "low",
            "landmark_quality": "degraded",
            "recent_transition": "uncertain_transition",
        },
        interaction_summary={
            "phase": "awaiting_consent",
            "clarification_used": True,
            "complaint_text": "刚才在卫生间滑了一下",
        },
        elder_text=None,
        expected_states=frozenset({"family_notification_required"}),
        context_sections={"居家上下文": "环境：凌晨2点，卫生间，夜灯:开"},
    ),
    # 9. 厨房生活片段分享：模型只能先征得老人明确同意，不能提前通知
    #    家人，也不能把看到的日常活动擅自解释成授权。
    ScenarioSpec(
        name="kitchen-share-consent",
        task=MimoTask.COMPOSE_KITCHEN_SHARE,
        perception_summary={
            "timestamp_ms": 1_754_004_000_000,
            "posture": "standing",
            "posture_duration_ms": 180_000,
            "motion_level": "low",
            "landmark_quality": "usable",
            "recent_transition": None,
        },
        interaction_summary={
            "phase": "monitoring",
            "clarification_used": False,
            "complaint_text": None,
        },
        elder_text=None,
        expected_states=frozenset({"consent_required"}),
        context_sections={"居家上下文": "环境：白天，厨房，正在准备面食"},
    ),
)

VARIANTS: tuple[PromptVariant, ...] = (
    PromptVariant("v1-stock", None, False),
    PromptVariant("v2-context", None, True),
)


def _system_prompt_for(
    scenario: ScenarioSpec, variant: PromptVariant, persona: PersonaConfig
) -> str:
    """The production system prompt for this cell, plus the variant's suffix.

    ``context_aware`` mirrors production exactly (Codex R3): it switches on
    whenever this cell will actually inject context sections, so v2 is
    measured with the same system addendum the live service sends.
    """

    context_aware = bool(variant.include_context_sections and scenario.context_sections)
    system_prompt = build_system_prompt(
        scenario.task, persona=persona, visual=False, context_aware=context_aware
    )
    # An empty suffix is treated as "no suffix" so a variant never grows a
    # dangling blank paragraph that would itself perturb the measurement.
    if variant.system_suffix:
        system_prompt = f"{system_prompt}\n\n{variant.system_suffix}"
    return system_prompt


def _user_content_for(scenario: ScenarioSpec, variant: PromptVariant) -> str:
    """Structured body built through the production prompt function (Codex R3)."""

    sections = scenario.context_sections if variant.include_context_sections else None
    return build_user_prompt(
        scenario.task,
        perception_summary=scenario.perception_summary,
        interaction_summary=scenario.interaction_summary,
        elder_text=scenario.elder_text,
        context_sections=sections or None,
    )


def _judge_completion(
    result: MimoCallResult,
    *,
    scenario: ScenarioSpec,
    variant: PromptVariant,
    persona: PersonaConfig,
) -> SampleOutcome:
    """Score one returned completion against the scenario's expectations."""

    content = result.content
    raw_state: str | None = None
    json_ok = False
    try:
        payload = json.loads(content)
    except json.JSONDecodeError:
        payload = None
    if isinstance(payload, dict):
        # json_ok is the strict reading: the whole completion is a bare JSON
        # object. A fenced or chatter-wrapped body still fails here even
        # though the schema layer would recover it.
        json_ok = True
        candidate = payload.get("state")
        if isinstance(candidate, str):
            raw_state = candidate

    state = raw_state
    schema_ok = False
    appellation_ok: bool | None = None
    error: str | None = None
    try:
        proposal = parse_mimo_proposal(content, task=scenario.task)
    except MimoSchemaError as exc:
        error = str(exc)[:_ERROR_EXCERPT_CHARS]
    else:
        schema_ok = True
        state = raw_state if proposal.state is None else proposal.state.value
        if proposal.elder_message is not None:
            appellation_ok = proposal.elder_message.startswith(persona.elder_name)

    return SampleOutcome(
        scenario=scenario.name,
        variant=variant.name,
        json_ok=json_ok,
        schema_ok=schema_ok,
        state=state,
        expected_hit=schema_ok and state is not None and state in scenario.expected_states,
        appellation_ok=appellation_ok,
        latency_ms=result.latency_ms,
        error=error,
    )


def _run_sample(
    client: MimoClient,
    *,
    scenario: ScenarioSpec,
    variant: PromptVariant,
    persona: PersonaConfig,
    system_prompt: str,
    user_content: str,
) -> SampleOutcome:
    """One call plus its verdict; transport failures become a scored row too."""

    try:
        result = client.complete(system_prompt=system_prompt, user_content=user_content)
    except MimoTransportError as exc:
        # The message never carries the key: the adapter only ever reports the
        # HTTP status or the exception type.  NaN marks "no measurement" so
        # the percentile selection never has to guess from magnitudes
        # (Codex R3): a genuine 0ms latency stays countable.
        return SampleOutcome(
            scenario=scenario.name,
            variant=variant.name,
            json_ok=False,
            schema_ok=False,
            state=None,
            expected_hit=False,
            appellation_ok=None,
            latency_ms=float("nan"),
            error=str(exc),
        )
    return _judge_completion(result, scenario=scenario, variant=variant, persona=persona)


def run_experiment(
    client: MimoClient,
    *,
    persona: PersonaConfig,
    scenarios: Sequence[ScenarioSpec],
    variants: Sequence[PromptVariant],
    samples_per_cell: int = DEFAULT_SAMPLES_PER_CELL,
    pace_seconds: float = DEFAULT_PACE_SECONDS,
    sleep_fn: Callable[[float], None] | None = None,
    on_progress: Callable[[str], None] | None = None,
) -> ExperimentReport:
    """Run the full scenario x variant x samples grid, sequential and paced."""

    sleep = time.sleep if sleep_fn is None else sleep_fn
    outcomes: list[SampleOutcome] = []
    calls_made = 0
    for scenario in scenarios:
        for variant in variants:
            system_prompt = _system_prompt_for(scenario, variant, persona)
            user_content = _user_content_for(scenario, variant)
            for sample_index in range(1, samples_per_cell + 1):
                # Pace between calls only, never before the first one: the
                # RPM cap constrains the gaps, not the start-up.
                if calls_made:
                    sleep(pace_seconds)
                calls_made += 1
                outcome = _run_sample(
                    client,
                    scenario=scenario,
                    variant=variant,
                    persona=persona,
                    system_prompt=system_prompt,
                    user_content=user_content,
                )
                outcomes.append(outcome)
                if on_progress is not None:
                    status = "ok" if outcome.error is None else "ERR"
                    on_progress(
                        f"{scenario.name}/{variant.name} {sample_index}/{samples_per_cell} {status}"
                    )
    return ExperimentReport(outcomes=tuple(outcomes))


_HEADERS = (
    "变体",
    "场景",
    "样本数",
    "JSON 合法率",
    "Schema 合规率",
    "期望命中率",
    "称呼合规率",
    "状态分布",
    "P50(ms)",
    "P95(ms)",
)

_ALL_SCENARIOS_LABEL = "（全部场景）"
_ALL_VARIANTS_LABEL = "（全部变体）"
_EMPTY_CELL = "—"
_NULL_STATE_LABEL = "null"


def _percentile(sorted_values: Sequence[float], fraction: float) -> float:
    """Nearest-rank percentile: index ceil(fraction * n) - 1, clamped."""

    rank = math.ceil(fraction * len(sorted_values))
    index = min(max(rank - 1, 0), len(sorted_values) - 1)
    return sorted_values[index]


def _rate(numerator: int, denominator: int) -> str:
    if denominator == 0:
        return _EMPTY_CELL
    return f"{numerator / denominator * 100:.1f}%"


def _histogram(outcomes: Sequence[SampleOutcome]) -> str:
    counts: dict[str, int] = {}
    for outcome in outcomes:
        key = _NULL_STATE_LABEL if outcome.state is None else outcome.state
        counts[key] = counts.get(key, 0) + 1
    if not counts:
        return _EMPTY_CELL
    ordered = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return " ".join(f"{state}:{count}" for state, count in ordered)


def _row(
    variant_label: str, scenario_label: str, outcomes: Sequence[SampleOutcome]
) -> tuple[str, ...]:
    total = len(outcomes)
    judged = [o.appellation_ok for o in outcomes if o.appellation_ok is not None]
    # Transport failures carry NaN ("no measurement"); every finite latency —
    # including a genuine 0ms and schema-failure rows — counts (Codex R3).
    latencies = sorted(o.latency_ms for o in outcomes if math.isfinite(o.latency_ms))
    p50 = f"{_percentile(latencies, 0.5):.0f}" if latencies else _EMPTY_CELL
    p95 = f"{_percentile(latencies, 0.95):.0f}" if latencies else _EMPTY_CELL
    return (
        variant_label,
        scenario_label,
        str(total),
        _rate(sum(1 for o in outcomes if o.json_ok), total),
        _rate(sum(1 for o in outcomes if o.schema_ok), total),
        _rate(sum(1 for o in outcomes if o.expected_hit), total),
        _rate(sum(1 for ok in judged if ok), len(judged)),
        _histogram(outcomes),
        p50,
        p95,
    )


def _table(rows: Sequence[Sequence[str]]) -> str:
    lines = [
        "| " + " | ".join(_HEADERS) + " |",
        "| " + " | ".join("---" for _ in _HEADERS) + " |",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in rows)
    return "\n".join(lines)


def _ordered_unique(values: Iterable[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(values))


def render_report_md(report: ExperimentReport) -> str:
    """Markdown tables: per-cell rates and latency, plus per-variant rollups."""

    outcomes = report.outcomes
    variant_names = _ordered_unique(o.variant for o in outcomes)
    scenario_names = _ordered_unique(o.scenario for o in outcomes)

    cell_rows: list[tuple[str, ...]] = []
    for variant_name in variant_names:
        for scenario_name in scenario_names:
            cell = [
                o for o in outcomes if o.variant == variant_name and o.scenario == scenario_name
            ]
            if cell:
                cell_rows.append(_row(variant_name, scenario_name, cell))

    rollup_rows: list[tuple[str, ...]] = [
        _row(name, _ALL_SCENARIOS_LABEL, [o for o in outcomes if o.variant == name])
        for name in variant_names
    ]
    rollup_rows.append(_row(_ALL_VARIANTS_LABEL, _ALL_SCENARIOS_LABEL, outcomes))

    return "\n".join(
        [
            "# MiMo 提示词大样本实验报告",
            "",
            f"总样本数：{len(outcomes)}；变体数：{len(variant_names)}；"
            f"场景数：{len(scenario_names)}",
            "",
            "## 逐格明细（变体 × 场景）",
            "",
            _table(cell_rows),
            "",
            "## 汇总",
            "",
            _table(rollup_rows),
            "",
        ]
    )


class _Named(Protocol):
    @property
    def name(self) -> str: ...


_NamedT = TypeVar("_NamedT", bound=_Named)


class _SelectionError(ValueError):
    """Raised when the CLI names a scenario or variant that does not exist."""


def _select(items: Sequence[_NamedT], names: Sequence[str] | None, label: str) -> list[_NamedT]:
    if not names:
        return list(items)
    by_name = {item.name: item for item in items}
    unknown = [name for name in names if name not in by_name]
    if unknown:
        known = ", ".join(sorted(by_name))
        raise _SelectionError(f"未知的 {label}：{', '.join(unknown)}；可选：{known}")
    # Repeated selections would silently double the grid and the live cost
    # while the report deduplicates by name (Codex R3): keep first occurrence.
    deduped = dict.fromkeys(names)
    return [by_name[name] for name in deduped]


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="MiMo 提示词大样本实验（B spec P1-1）",
    )
    parser.add_argument("--samples", type=int, default=DEFAULT_SAMPLES_PER_CELL)
    parser.add_argument("--pace", type=float, default=DEFAULT_PACE_SECONDS)
    parser.add_argument("--variant", action="append", default=None, help="可重复；缺省跑全部变体")
    parser.add_argument("--scenario", action="append", default=None, help="可重复；缺省跑全部场景")
    parser.add_argument("--out", type=Path, required=True, help="产物目录")
    parser.add_argument("--elder-name", default="王奶奶")
    parser.add_argument("--family-relation", default="家人")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI: --samples/--pace/--variant/--scenario/--out; key from environment."""

    args = _build_parser().parse_args(argv)
    try:
        variants = _select(VARIANTS, args.variant, "variant")
        scenarios = _select(SCENARIOS, args.scenario, "scenario")
    except _SelectionError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    config = config_from_environment()
    if not config.api_key:
        # Never echo any environment value: the whole point is that a missing
        # key is diagnosable without leaking a present one.
        print("MIMO_API_KEY 未配置", file=sys.stderr)
        return 2

    persona = PersonaConfig(elder_name=args.elder_name, family_relation=args.family_relation)
    report = run_experiment(
        MimoClient(config),
        persona=persona,
        scenarios=scenarios,
        variants=variants,
        samples_per_cell=args.samples,
        pace_seconds=args.pace,
        # Progress goes to stderr so stdout stays exactly the report.
        on_progress=lambda line: print(line, file=sys.stderr),
    )

    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    jsonl = "".join(
        json.dumps(dataclasses.asdict(outcome), ensure_ascii=False) + "\n"
        for outcome in report.outcomes
    )
    (out_dir / "outcomes.jsonl").write_text(jsonl, encoding="utf-8")
    markdown = render_report_md(report)
    (out_dir / "report.md").write_text(markdown, encoding="utf-8")
    print(markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
