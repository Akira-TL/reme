#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv is required" >&2
  exit 2
fi

OUTPUT_DIR="${1:-artifacts/training/edge-int8/day1-$(date +%Y%m%d-%H%M%S)}"

if [[ -e "$OUTPUT_DIR" ]]; then
  echo "error: output path already exists: $OUTPUT_DIR" >&2
  exit 2
fi

echo "Reme INT8 day-one training"
echo "output: $OUTPUT_DIR"
echo "archived models under models/trained/ will not be modified"

exec uv run --extra pose python scripts/training/edge_int8_day1.py \
  --output-dir "$OUTPUT_DIR"
