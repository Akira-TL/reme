#!/bin/sh
# Reme 单机验收正式入口。程序入口只保留在仓库 scripts/，不安装到 .venv/bin。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

command -v uv >/dev/null 2>&1 || {
  echo "缺少 uv，请先安装 uv。" >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "缺少 npm，请先安装 Node.js。" >&2
  exit 1
}

exec uv run --extra pose python -m reme.local_demo "$@"
