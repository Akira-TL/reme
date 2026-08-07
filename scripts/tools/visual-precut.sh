#!/bin/sh
# 生成事件触发的最小视觉上下文切片。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
exec uv run python -m reme.runtime.decision.visual "$@"
