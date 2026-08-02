#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PYTHON=".venv/bin/python"
INDEX="artifacts/pose-classification/datasets/downloads6/dataset-index.json"
OUTPUT_ROOT="artifacts/pose-classification/models/posture-sweep-20260801"

if [[ ! -x "$PYTHON" ]]; then
  echo "error: missing project Python: $PYTHON" >&2
  exit 2
fi
if [[ ! -f "$INDEX" ]]; then
  echo "error: missing dataset index: $INDEX" >&2
  exit 2
fi

for seed in 42 2026 3407; do
  for learning_rate in 0.005 0.01 0.02 0.04; do
    run_id="seed-${seed}-lr-${learning_rate}"
    echo "=== $run_id ==="
    "$PYTHON" -m reme.pose.posture train "$INDEX" \
      --model-output "$OUTPUT_ROOT/$run_id/model.json" \
      --metrics-output "$OUTPUT_ROOT/$run_id/metrics.json" \
      --epochs 5000 \
      --learning-rate "$learning_rate" \
      --l2 0.0001 \
      --seed "$seed" \
      --max-samples-per-scene 400
  done
done

echo "=== TRAINING_COMPLETE ==="
