#!/bin/sh
# 生成危险确认链路使用的预置语音资产。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
exec uv run python -m reme.decision.voice_preset "$@"
