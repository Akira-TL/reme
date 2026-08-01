"""Verification for the Gate 5 minimal experiment.

Run:
    .venv/bin/python -m pytest .scratch/tiny-transition-model/test_experiment.py

These tests check reproducibility and the abstention contract. They deliberately
do not assert a specific accuracy target: the data is synthetic, so a threshold
would only be a statement about the generator.
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

EXPERIMENT_DIR = Path(__file__).resolve().parent
REPO_ROOT = EXPERIMENT_DIR.parents[1]
for candidate in (str(EXPERIMENT_DIR), str(REPO_ROOT / "backend")):
    if candidate not in sys.path:
        sys.path.insert(0, candidate)

from evaluate import FALL_LIKE, NORMAL, UNCERTAIN, score  # noqa: E402
from features import FEATURE_NAMES, extract_features  # noqa: E402
from run import build_splits, run  # noqa: E402
from synth import Sample, generate_dataset, generate_sequence  # noqa: E402

RESULTS_PATH = EXPERIMENT_DIR / "results" / "latest.json"


def test_same_seed_reproduces_metrics(tmp_path: Path) -> None:
    first = run(seed=11, per_scenario=8, output_dir=tmp_path / "a", quiet=True)
    second = run(seed=11, per_scenario=8, output_dir=tmp_path / "b", quiet=True)
    assert first["reports"] == second["reports"]
    assert first["models"] == second["models"]


def test_committed_results_reproduce(tmp_path: Path) -> None:
    committed = json.loads(RESULTS_PATH.read_text(encoding="utf-8"))
    fresh = run(
        seed=committed["config"]["seed"],
        per_scenario=committed["config"]["sequences_per_scenario"],
        output_dir=tmp_path,
        quiet=True,
    )
    assert fresh["reports"] == committed["reports"]
    assert fresh["config"] == committed["config"]


def test_feature_vector_matches_declared_names() -> None:
    sequence = generate_sequence(random.Random(3), "forward_collapse")
    features = extract_features(sequence.samples)
    assert features is not None
    assert len(features.values) == len(FEATURE_NAMES)
    assert all(isinstance(value, float) for value in features.values)


def test_occluded_sequence_has_no_features() -> None:
    samples = [
        Sample(offset_ms=index * 50, torso_angle_deg=12.0, center_y=0.4, visibility=0.15)
        for index in range(120)
    ]
    assert extract_features(samples) is None


def test_unusable_sequences_are_abstained_not_guessed(tmp_path: Path) -> None:
    payload = run(seed=11, per_scenario=8, output_dir=tmp_path, quiet=True)
    unusable = payload["config"]["unusable_test_sequences"]
    for report in payload["reports"]:
        if report["name"] == "geometric_baseline":
            continue
        abstained = sum(
            report["confusion"][actual][UNCERTAIN] for actual in (FALL_LIKE, NORMAL)
        )
        assert abstained >= unusable


def test_split_sizes_and_scenario_balance() -> None:
    dataset = generate_dataset(seed=5, sequences_per_scenario=10)
    splits = build_splits(dataset, per_scenario=10)
    assert len(splits.train) == 54
    assert len(splits.validation) == 18
    assert len(splits.test) == 18
    scenarios = {example.scenario for example in splits.test}
    assert len(scenarios) == 9


def test_abstention_never_counts_as_correct() -> None:
    truth = [FALL_LIKE, FALL_LIKE, NORMAL, NORMAL]
    predictions = [UNCERTAIN, FALL_LIKE, UNCERTAIN, NORMAL]
    report = score("check", truth, predictions)
    assert report.per_class[FALL_LIKE].recall == 0.5
    assert report.per_class[FALL_LIKE].precision == 1.0
    assert report.abstention_rate == 0.5
    assert report.decided_accuracy == 1.0
