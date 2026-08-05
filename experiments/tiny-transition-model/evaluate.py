"""Metrics for a transition classifier that is allowed to abstain.

Abstention is scored honestly: an abstained sequence is never counted as a
correct prediction. It lowers recall for its true class and shows up as its own
column in the confusion matrix, so a model cannot buy a good score by refusing
to answer the hard cases.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

FALL_LIKE = "fall_like_transition"
NORMAL = "normal_transition"
UNCERTAIN = "uncertain_transition"

CLASSES: tuple[str, ...] = (FALL_LIKE, NORMAL)
PREDICTIONS: tuple[str, ...] = (FALL_LIKE, NORMAL, UNCERTAIN)


@dataclass(frozen=True, slots=True)
class ClassMetrics:
    support: int
    precision: float
    recall: float
    f1: float


@dataclass(frozen=True, slots=True)
class Report:
    name: str
    per_class: dict[str, ClassMetrics]
    macro_f1: float
    abstention_rate: float
    decided_accuracy: float
    confusion: dict[str, dict[str, int]]

    def to_payload(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "macro_f1": round(self.macro_f1, 4),
            "abstention_rate": round(self.abstention_rate, 4),
            "decided_accuracy": round(self.decided_accuracy, 4),
            "per_class": {
                label: {
                    "support": metrics.support,
                    "precision": round(metrics.precision, 4),
                    "recall": round(metrics.recall, 4),
                    "f1": round(metrics.f1, 4),
                }
                for label, metrics in self.per_class.items()
            },
            "confusion": self.confusion,
        }


def score(name: str, truth: Sequence[str], predictions: Sequence[str]) -> Report:
    """Build a full report from aligned truth and prediction sequences."""

    confusion = {
        actual: {predicted: 0 for predicted in PREDICTIONS} for actual in CLASSES
    }
    for actual, predicted in zip(truth, predictions, strict=True):
        confusion[actual][predicted] += 1

    per_class: dict[str, ClassMetrics] = {}
    for label in CLASSES:
        support = sum(confusion[label].values())
        true_positive = confusion[label][label]
        predicted_positive = sum(confusion[actual][label] for actual in CLASSES)
        precision = true_positive / predicted_positive if predicted_positive else 0.0
        recall = true_positive / support if support else 0.0
        f1 = (
            2 * precision * recall / (precision + recall)
            if precision + recall > 0
            else 0.0
        )
        per_class[label] = ClassMetrics(
            support=support, precision=precision, recall=recall, f1=f1
        )

    total = len(truth)
    abstained = sum(1 for predicted in predictions if predicted == UNCERTAIN)
    decided = total - abstained
    correct = sum(confusion[label][label] for label in CLASSES)
    return Report(
        name=name,
        per_class=per_class,
        macro_f1=sum(metrics.f1 for metrics in per_class.values()) / len(CLASSES),
        abstention_rate=abstained / total if total else 0.0,
        decided_accuracy=correct / decided if decided else 0.0,
        confusion=confusion,
    )


def format_report(report: Report) -> str:
    """Render one report as plain text for the console and the results file."""

    lines = [
        f"{report.name}",
        f"  macro-F1 {report.macro_f1:.3f}"
        f" | decided accuracy {report.decided_accuracy:.3f}"
        f" | abstention {report.abstention_rate:.3f}",
        "  class                     support  precision  recall     F1",
    ]
    for label, metrics in report.per_class.items():
        lines.append(
            f"  {label:<24} {metrics.support:>7}"
            f" {metrics.precision:>10.3f} {metrics.recall:>7.3f} {metrics.f1:>6.3f}"
        )
    lines.append("  confusion (rows = truth, cols = prediction)")
    lines.append(f"  {'':<24} {'fall_like':>10} {'normal':>8} {'uncertain':>10}")
    for label in CLASSES:
        row = report.confusion[label]
        lines.append(
            f"  {label:<24} {row[FALL_LIKE]:>10} {row[NORMAL]:>8} {row[UNCERTAIN]:>10}"
        )
    return "\n".join(lines)


def scenario_breakdown(
    scenarios: Sequence[str], truth: Sequence[str], predictions: Sequence[str]
) -> dict[str, dict[str, int]]:
    """Count predictions per synthetic scenario, to locate the actual failure mode."""

    breakdown: dict[str, dict[str, int]] = {}
    for scenario, actual, predicted in zip(scenarios, truth, predictions, strict=True):
        counts = breakdown.setdefault(
            scenario, {"support": 0, "correct": 0, "wrong": 0, "uncertain": 0}
        )
        counts["support"] += 1
        if predicted == UNCERTAIN:
            counts["uncertain"] += 1
        elif predicted == actual:
            counts["correct"] += 1
        else:
            counts["wrong"] += 1
    return breakdown
