#!/bin/sh
# Reme ABC 单机验收入口。真实进程管理逻辑统一由 reme-local-demo 提供。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

command -v uv >/dev/null 2>&1 || {
  echo "缺少 uv，请先安装 uv。" >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "缺少 npm，请先安装 Node.js。" >&2
  exit 1
}

exec uv run --extra pose reme-local-demo "$@"
