"""Large-sample prompt experiment harness (B spec P1-1).

Measures, per scenario x prompt variant: JSON parse rate, schema-valid
rate, state-branch distribution against the expected set, appellation
compliance, and latency P50/P95.  Offline-testable through the adapter's
injectable transport; the CLI paces the live endpoint under the RPM cap
and never prints the API key.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from reme.decision.mimo.adapter import MimoClient
from reme.decision.mimo.prompts import PersonaConfig
from reme.decision.state_machine import MimoTask

DEFAULT_SAMPLES_PER_CELL = 10
DEFAULT_PACE_SECONDS = 0.7


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


SCENARIOS: tuple[ScenarioSpec, ...] = ()  # L4 泳道填充：>=8 个课程化场景
VARIANTS: tuple[PromptVariant, ...] = ()  # L4 泳道填充：v1-stock / v2-context


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

    raise NotImplementedError("L4 泳道实现")


def render_report_md(report: ExperimentReport) -> str:
    """Markdown tables: per-cell rates and latency, plus per-variant rollups."""

    raise NotImplementedError("L4 泳道实现")


def main(argv: Sequence[str] | None = None) -> int:
    """CLI: --samples/--pace/--variant/--scenario/--out; key from environment."""

    raise NotImplementedError("L4 泳道实现")
