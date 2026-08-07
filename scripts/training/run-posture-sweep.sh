#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

INDEX="${1:-data/training/pose/processed/downloads6/dataset-index.json}"
OUTPUT_ROOT="${2:-artifacts/training/posture/posture-sweep-$(date +%Y%m%d-%H%M%S)}"
PYTHON=(uv run --extra pose python)

if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv is required" >&2
  exit 2
fi
if [[ ! -f "$INDEX" ]]; then
  echo "error: missing dataset index: $INDEX" >&2
  exit 2
fi

echo "dataset index: $INDEX"
echo "output root: $OUTPUT_ROOT"

for seed in 42 2026 3407; do
  for learning_rate in 0.005 0.01 0.02 0.04; do
    run_id="seed-${seed}-lr-${learning_rate}"
    echo "=== $run_id ==="
    "${PYTHON[@]}" -m reme.runtime.perception.posture train "$INDEX" \
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
echo "results: $OUTPUT_ROOT"
