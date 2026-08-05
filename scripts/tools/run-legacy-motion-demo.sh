#!/bin/sh
# 早期动作 JSONL 原型，仅用于历史兼容与合同回放。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
exec uv run python -m reme.demo "$@"
