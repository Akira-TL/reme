#!/usr/bin/env bash
# 一条命令配置 MiMo key：写入 ~/.config/reme/mimo.env（chmod 600，仓库外不进 git）。
#
# 用法：
#   scripts/setup-mimo-env.sh            # 交互式粘贴 key（输入不回显）
#   MIMO_API_KEY=xxx scripts/setup-mimo-env.sh   # 非交互（CI/脚本）
#   scripts/setup-mimo-env.sh --force    # 覆盖已存在的 key 文件
#
# 写入后如仓库已 `uv sync`，自动跑一次真实 API 冒烟验证 key 可用。
set -euo pipefail

ENV_FILE="${HOME}/.config/reme/mimo.env"

if [[ -f "$ENV_FILE" && "${1:-}" != "--force" ]]; then
  tail_hint="$(grep -o 'MIMO_API_KEY=.*' "$ENV_FILE" | head -1 \
    | sed "s/^MIMO_API_KEY=//; s/^['\"]//; s/['\"]\$//")"
  echo "已存在 ${ENV_FILE}（key 尾号 …${tail_hint: -4}），未改动。覆盖请加 --force。"
  echo "使用方式：source ${ENV_FILE}"
  exit 0
fi

if [[ -n "${MIMO_API_KEY:-}" ]]; then
  key="${MIMO_API_KEY}"
else
  read -rsp "粘贴你的 MIMO_API_KEY（platform.xiaomimimo.com 开通，输入不回显）: " key
  echo
fi
if [[ -z "${key}" ]]; then
  echo "key 为空，未写入。" >&2
  exit 1
fi

mkdir -p "$(dirname "$ENV_FILE")"
umask 177
printf "export MIMO_API_KEY='%s'\n" "${key}" > "$ENV_FILE"
echo "已写入 ${ENV_FILE}（权限 600）。每次启动 B 前：source ${ENV_FILE}"

if [[ -x .venv/bin/reme-decision-smoke ]]; then
  echo "运行真实 API 冒烟验证（1 次调用）…"
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  if .venv/bin/reme-decision-smoke structured --rounds 1; then
    echo "冒烟通过：key 可用。"
  else
    echo "冒烟失败：key 或网络有问题（文件已写入，修好后可单独重跑 .venv/bin/reme-decision-smoke structured --rounds 1）。" >&2
    exit 1
  fi
else
  echo "提示：仓库根目录先 uv sync --extra dev，再重跑本脚本可自动验证 key。"
fi
