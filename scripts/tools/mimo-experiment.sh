#!/bin/sh
# 运行 MiMo 离线/在线实验并将结果写入显式输出目录。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
exec uv run python -m reme.decision.mimo.experiment "$@"
