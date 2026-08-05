#!/bin/sh
# 使用仓库本地 .env 运行 MiMo 结构化/视觉通道冒烟。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
exec uv run python -m reme.runtime.decision.mimo.adapter "$@"
