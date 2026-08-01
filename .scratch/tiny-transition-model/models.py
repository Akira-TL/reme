"""Two tiny learned classifiers, written in the standard library only.

Keeping these dependency-free is deliberate: the project has no runtime
dependencies, and a model this small does not need a framework. Both models are
deterministic given a seed, so a reported metric can be reproduced exactly.
"""

from __future__ import annotations

import math
import random
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

Vector = list[float]
Matrix = list[Vector]


def _sigmoid(value: float) -> float:
    if value >= 0.0:
        return 1.0 / (1.0 + math.exp(-min(value, 60.0)))
    exponent = math.exp(max(value, -60.0))
    return exponent / (1.0 + exponent)


@dataclass(frozen=True, slots=True)
class Standardizer:
    """Per-feature zero-mean unit-variance scaling fitted on the training split."""

    means: Vector
    deviations: Vector

    @classmethod
    def fit(cls, rows: Matrix) -> Standardizer:
        width = len(rows[0])
        means = [sum(row[index] for row in rows) / len(rows) for index in range(width)]
        deviations: Vector = []
        for index in range(width):
            variance = sum((row[index] - means[index]) ** 2 for row in rows) / len(rows)
            deviations.append(max(math.sqrt(variance), 1e-6))
        return cls(means=means, deviations=deviations)

    def apply(self, row: Sequence[float]) -> Vector:
        return [
            (value - mean) / deviation
            for value, mean, deviation in zip(row, self.means, self.deviations, strict=True)
        ]


@dataclass
class LogisticRegression:
    """Batch gradient descent logistic regression with L2 regularization."""

    weights: Vector
    bias: float
    scaler: Standardizer
    name: str = "logistic_regression"

    @classmethod
    def train(
        cls,
        rows: Matrix,
        labels: Sequence[int],
        *,
        learning_rate: float = 0.35,
        iterations: int = 4000,
        l2: float = 1e-3,
    ) -> LogisticRegression:
        scaler = Standardizer.fit(rows)
        scaled = [scaler.apply(row) for row in rows]
        width = len(scaled[0])
        weights = [0.0] * width
        bias = 0.0
        count = len(scaled)

        for _ in range(iterations):
            weight_gradient = [0.0] * width
            bias_gradient = 0.0
            for row, label in zip(scaled, labels, strict=True):
                error = _sigmoid(sum(w * x for w, x in zip(weights, row, strict=True)) + bias) - label
                for index, value in enumerate(row):
                    weight_gradient[index] += error * value
                bias_gradient += error
            for index in range(width):
                gradient = weight_gradient[index] / count + l2 * weights[index]
                weights[index] -= learning_rate * gradient
            bias -= learning_rate * bias_gradient / count

        return cls(weights=weights, bias=bias, scaler=scaler)

    def predict_proba(self, row: Sequence[float]) -> float:
        scaled = self.scaler.apply(row)
        return _sigmoid(sum(w * x for w, x in zip(self.weights, scaled, strict=True)) + self.bias)

    def to_payload(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "weights": [round(value, 6) for value in self.weights],
            "bias": round(self.bias, 6),
            "feature_means": [round(value, 6) for value in self.scaler.means],
            "feature_deviations": [round(value, 6) for value in self.scaler.deviations],
        }


@dataclass
class TinyMLP:
    """One hidden tanh layer. Small enough to inspect, large enough to bend."""

    hidden_weights: Matrix
    hidden_bias: Vector
    output_weights: Vector
    output_bias: float
    scaler: Standardizer
    name: str = "tiny_mlp"

    @classmethod
    def train(
        cls,
        rows: Matrix,
        labels: Sequence[int],
        *,
        hidden_units: int = 8,
        learning_rate: float = 0.25,
        iterations: int = 3000,
        l2: float = 1e-3,
        seed: int = 7,
    ) -> TinyMLP:
        scaler = Standardizer.fit(rows)
        scaled = [scaler.apply(row) for row in rows]
        width = len(scaled[0])
        rng = random.Random(seed)
        limit = math.sqrt(6.0 / (width + hidden_units))
        hidden_weights = [
            [rng.uniform(-limit, limit) for _ in range(width)] for _ in range(hidden_units)
        ]
        hidden_bias = [0.0] * hidden_units
        output_weights = [rng.uniform(-limit, limit) for _ in range(hidden_units)]
        output_bias = 0.0
        count = len(scaled)

        for _ in range(iterations):
            hidden_weight_gradient = [[0.0] * width for _ in range(hidden_units)]
            hidden_bias_gradient = [0.0] * hidden_units
            output_weight_gradient = [0.0] * hidden_units
            output_bias_gradient = 0.0

            for row, label in zip(scaled, labels, strict=True):
                activations = [
                    math.tanh(
                        sum(w * x for w, x in zip(hidden_weights[unit], row, strict=True))
                        + hidden_bias[unit]
                    )
                    for unit in range(hidden_units)
                ]
                logit = (
                    sum(w * a for w, a in zip(output_weights, activations, strict=True))
                    + output_bias
                )
                error = _sigmoid(logit) - label
                for unit in range(hidden_units):
                    output_weight_gradient[unit] += error * activations[unit]
                    delta = error * output_weights[unit] * (1.0 - activations[unit] ** 2)
                    hidden_bias_gradient[unit] += delta
                    for index, value in enumerate(row):
                        hidden_weight_gradient[unit][index] += delta * value
                output_bias_gradient += error

            for unit in range(hidden_units):
                for index in range(width):
                    gradient = (
                        hidden_weight_gradient[unit][index] / count
                        + l2 * hidden_weights[unit][index]
                    )
                    hidden_weights[unit][index] -= learning_rate * gradient
                hidden_bias[unit] -= learning_rate * hidden_bias_gradient[unit] / count
                output_weights[unit] -= learning_rate * (
                    output_weight_gradient[unit] / count + l2 * output_weights[unit]
                )
            output_bias -= learning_rate * output_bias_gradient / count

        return cls(
            hidden_weights=hidden_weights,
            hidden_bias=hidden_bias,
            output_weights=output_weights,
            output_bias=output_bias,
            scaler=scaler,
        )

    def predict_proba(self, row: Sequence[float]) -> float:
        scaled = self.scaler.apply(row)
        activations = [
            math.tanh(sum(w * x for w, x in zip(weights, scaled, strict=True)) + bias)
            for weights, bias in zip(self.hidden_weights, self.hidden_bias, strict=True)
        ]
        logit = (
            sum(w * a for w, a in zip(self.output_weights, activations, strict=True))
            + self.output_bias
        )
        return _sigmoid(logit)

    def to_payload(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "hidden_units": len(self.hidden_bias),
            "parameter_count": len(self.hidden_bias) * (len(self.scaler.means) + 2) + 1,
        }
