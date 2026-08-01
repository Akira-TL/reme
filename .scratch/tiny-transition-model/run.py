"""Gate 5 minimal experiment: geometric baseline versus two tiny learned models.

Run:
    .venv/bin/python .scratch/tiny-transition-model/run.py

Everything is deterministic. The same seed reproduces the same metrics, and the
results file records the seed, the split sizes and the calibrated thresholds.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

EXPERIMENT_DIR = Path(__file__).resolve().parent
REPO_ROOT = EXPERIMENT_DIR.parents[1]
for candidate in (str(EXPERIMENT_DIR), str(REPO_ROOT / "backend")):
    if candidate not in sys.path:
        sys.path.insert(0, candidate)

from evaluate import (  # noqa: E402
    FALL_LIKE,
    NORMAL,
    UNCERTAIN,
    Report,
    format_report,
    scenario_breakdown,
    score,
)
from features import WindowFeatures, extract_features  # noqa: E402
from models import LogisticRegression, TinyMLP  # noqa: E402
from reme.motion import (  # noqa: E402
    MotionObservation,
    detect_fall_like_event,
    has_insufficient_motion_data,
)
from synth import Sequence_, generate_dataset  # noqa: E402

ABSTENTION_MARGINS = (0.0, 0.05, 0.10, 0.15, 0.20, 0.25)
MAX_ABSTENTION = 0.25
BASELINE_MIN_VISIBILITY = 0.60


@dataclass(frozen=True, slots=True)
class Example:
    sequence: Sequence_
    features: WindowFeatures | None

    @property
    def label(self) -> str:
        return self.sequence.label

    @property
    def scenario(self) -> str:
        return self.sequence.scenario


@dataclass(frozen=True, slots=True)
class Splits:
    train: tuple[Example, ...]
    validation: tuple[Example, ...]
    test: tuple[Example, ...]


def build_splits(dataset: Sequence[Sequence_], *, per_scenario: int) -> Splits:
    """Split scenario by scenario so every split holds the same scenario mix."""

    train_size = int(per_scenario * 0.6)
    validation_size = int(per_scenario * 0.2)
    buckets: dict[str, list[Example]] = {}
    for sequence in dataset:
        example = Example(sequence=sequence, features=extract_features(sequence.samples))
        buckets.setdefault(sequence.scenario, []).append(example)

    train: list[Example] = []
    validation: list[Example] = []
    test: list[Example] = []
    for examples in buckets.values():
        train.extend(examples[:train_size])
        validation.extend(examples[train_size : train_size + validation_size])
        test.extend(examples[train_size + validation_size :])
    return Splits(train=tuple(train), validation=tuple(validation), test=tuple(test))


def _training_matrix(examples: Sequence[Example]) -> tuple[list[list[float]], list[int]]:
    rows: list[list[float]] = []
    labels: list[int] = []
    for example in examples:
        if example.features is None:
            continue
        rows.append(list(example.features.values))
        labels.append(1 if example.label == FALL_LIKE else 0)
    return rows, labels


def predict_with_margin(
    predict_proba: Callable[[Sequence[float]], float],
    examples: Sequence[Example],
    margin: float,
) -> list[str]:
    """Predict, abstaining on unusable input or on probabilities inside the band."""

    predictions: list[str] = []
    for example in examples:
        if example.features is None:
            predictions.append(UNCERTAIN)
            continue
        probability = predict_proba(example.features.values)
        if abs(probability - 0.5) <= margin:
            predictions.append(UNCERTAIN)
        else:
            predictions.append(FALL_LIKE if probability > 0.5 else NORMAL)
    return predictions


def calibrate_margin(
    predict_proba: Callable[[Sequence[float]], float], examples: Sequence[Example]
) -> tuple[float, float]:
    """Pick the abstention band on validation data, not on the test split."""

    truth = [example.label for example in examples]
    best_margin = 0.0
    best_macro_f1 = -1.0
    for margin in ABSTENTION_MARGINS:
        report = score("validation", truth, predict_with_margin(predict_proba, examples, margin))
        if report.abstention_rate > MAX_ABSTENTION:
            continue
        if report.macro_f1 > best_macro_f1 + 1e-9:
            best_macro_f1 = report.macro_f1
            best_margin = margin
    return best_margin, best_macro_f1


def baseline_predictions(examples: Sequence[Example]) -> list[str]:
    """Run the existing transparent heuristic from reme.motion on the same data."""

    started_at = datetime(2026, 1, 1, tzinfo=UTC)
    predictions: list[str] = []
    for example in examples:
        observations = [
            MotionObservation(
                offset_ms=sample.offset_ms,
                torso_angle_deg=sample.torso_angle_deg,
                center_y=sample.center_y,
                visibility=sample.visibility,
            )
            for sample in example.sequence.samples
        ]
        if has_insufficient_motion_data(observations, minimum_visibility=BASELINE_MIN_VISIBILITY):
            predictions.append(UNCERTAIN)
            continue
        event = detect_fall_like_event(observations, started_at=started_at)
        predictions.append(FALL_LIKE if event is not None else NORMAL)
    return predictions


def _display_path(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def _write_results(
    output_dir: Path,
    payload: dict[str, Any],
    reports: Sequence[Report],
    breakdowns: dict[str, dict[str, dict[str, int]]],
) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "latest.json"
    json_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    lines = [
        "# Gate 5 synthetic transition experiment — latest run",
        "",
        "Generated by `.scratch/tiny-transition-model/run.py`. Synthetic data only:",
        "these numbers describe the generator in `synth.py`, not the supplied video.",
        "",
        f"- seed: `{payload['config']['seed']}`",
        f"- sequences: {payload['config']['total_sequences']}"
        f" (train {payload['config']['train_size']},"
        f" val {payload['config']['validation_size']},"
        f" test {payload['config']['test_size']})",
        f"- features: {', '.join(payload['config']['feature_names'])}",
        "",
        "## Test-split results",
        "",
        "| model | macro-F1 | fall recall | fall precision | abstention |",
        "|---|---:|---:|---:|---:|",
    ]
    for report in reports:
        fall = report.per_class[FALL_LIKE]
        lines.append(
            f"| {report.name} | {report.macro_f1:.3f} | {fall.recall:.3f}"
            f" | {fall.precision:.3f} | {report.abstention_rate:.3f} |"
        )
    lines.extend(["", "## Per-scenario outcome (test split)", ""])
    scenarios = sorted(next(iter(breakdowns.values())))
    header = "| scenario | support | " + " | ".join(f"{name} correct" for name in breakdowns) + " |"
    lines.append(header)
    lines.append("|---|---:|" + "---:|" * len(breakdowns))
    for scenario in scenarios:
        support = next(iter(breakdowns.values()))[scenario]["support"]
        cells = " | ".join(f"{breakdowns[name][scenario]['correct']}" for name in breakdowns)
        lines.append(f"| {scenario} | {support} | {cells} |")
    lines.extend(["", "## Console output", "", "```text"])
    for report in reports:
        lines.append(format_report(report))
        lines.append("")
    lines.append("```")
    markdown_path = output_dir / "latest.md"
    markdown_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return json_path, markdown_path


def run(*, seed: int, per_scenario: int, output_dir: Path, quiet: bool = False) -> dict[str, Any]:
    """Train, calibrate, evaluate and persist the whole comparison."""

    dataset = generate_dataset(seed=seed, sequences_per_scenario=per_scenario)
    splits = build_splits(dataset, per_scenario=per_scenario)
    rows, labels = _training_matrix(splits.train)

    logistic = LogisticRegression.train(rows, labels)
    mlp = TinyMLP.train(rows, labels)

    reports: list[Report] = []
    breakdowns: dict[str, dict[str, dict[str, int]]] = {}
    models: dict[str, Any] = {}

    truth = [example.label for example in splits.test]
    scenarios = [example.scenario for example in splits.test]

    baseline = baseline_predictions(splits.test)
    reports.append(score("geometric_baseline", truth, baseline))
    breakdowns["geometric_baseline"] = scenario_breakdown(scenarios, truth, baseline)

    for model in (logistic, mlp):
        margin, validation_macro_f1 = calibrate_margin(model.predict_proba, splits.validation)
        predictions = predict_with_margin(model.predict_proba, splits.test, margin)
        reports.append(score(model.name, truth, predictions))
        breakdowns[model.name] = scenario_breakdown(scenarios, truth, predictions)
        models[model.name] = {
            **model.to_payload(),
            "abstention_margin": margin,
            "validation_macro_f1": round(validation_macro_f1, 4),
        }

    from features import FEATURE_NAMES

    payload: dict[str, Any] = {
        "experiment": "gate5-synthetic-transition-baseline-vs-tiny-models",
        "data_source": "synthetic (.scratch/tiny-transition-model/synth.py)",
        "config": {
            "seed": seed,
            "sequences_per_scenario": per_scenario,
            "total_sequences": len(dataset),
            "train_size": len(splits.train),
            "validation_size": len(splits.validation),
            "test_size": len(splits.test),
            "unusable_test_sequences": sum(
                1 for example in splits.test if example.features is None
            ),
            "feature_names": list(FEATURE_NAMES),
        },
        "models": models,
        "reports": [report.to_payload() for report in reports],
        "scenario_breakdown": breakdowns,
    }

    json_path, markdown_path = _write_results(output_dir, payload, reports, breakdowns)
    if not quiet:
        print(
            f"dataset: {len(dataset)} sequences"
            f" (train {len(splits.train)} / val {len(splits.validation)}"
            f" / test {len(splits.test)}),"
            f" unusable in test: {payload['config']['unusable_test_sequences']}"
        )
        print()
        for report in reports:
            print(format_report(report))
            print()
        print("per-scenario correct predictions on the test split")
        for scenario in sorted(breakdowns["geometric_baseline"]):
            support = breakdowns["geometric_baseline"][scenario]["support"]
            cells = "  ".join(
                f"{name}={breakdowns[name][scenario]['correct']}/{support}" for name in breakdowns
            )
            print(f"  {scenario:<20} {cells}")
        print()
        print(f"wrote {_display_path(json_path)} and {_display_path(markdown_path)}")
    return payload


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=20260801)
    parser.add_argument("--per-scenario", type=int, default=60)
    parser.add_argument("--output-dir", type=Path, default=EXPERIMENT_DIR / "results")
    parser.add_argument("--quiet", action="store_true")
    arguments = parser.parse_args(argv)
    run(
        seed=arguments.seed,
        per_scenario=arguments.per_scenario,
        output_dir=arguments.output_dir,
        quiet=arguments.quiet,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
