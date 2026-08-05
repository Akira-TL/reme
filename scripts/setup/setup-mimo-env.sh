#!/usr/bin/env bash
# 配置仓库本地 .env 中的 MiMo key；.env 已被 Git 忽略。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ROOT}/.env"
FORCE=false

if [[ "${1:-}" == "--force" ]]; then
  FORCE=true
elif [[ -n "${1:-}" ]]; then
  echo "未知参数：$1" >&2
  echo "用法：scripts/setup/setup-mimo-env.sh [--force]" >&2
  exit 2
fi

current_key=""
if [[ -f "$ENV_FILE" ]]; then
  current_key="$(grep -E '^(export[[:space:]]+)?MIMO_API_KEY=' "$ENV_FILE" | tail -1 \
    | sed -E "s/^(export[[:space:]]+)?MIMO_API_KEY=//; s/^['\"]//; s/['\"]$//" || true)"
fi

if [[ -n "$current_key" && "$FORCE" != true ]]; then
  echo "${ENV_FILE} 已配置 MIMO_API_KEY（尾号 …${current_key: -4}），未改动。覆盖请加 --force。"
  exit 0
fi

if [[ -n "${MIMO_API_KEY:-}" ]]; then
  key="$MIMO_API_KEY"
else
  read -rsp "粘贴你的 MIMO_API_KEY（输入不回显）: " key
  echo
fi

if [[ -z "$key" ]]; then
  echo "key 为空，未写入。" >&2
  exit 1
fi
if [[ "$key" == *$'\n'* || "$key" == *$'\r'* ]]; then
  echo "key 不能包含换行。" >&2
  exit 1
fi

mkdir -p "$ROOT"
tmp_file="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT

if [[ -f "$ENV_FILE" ]]; then
  awk '!/^(export[[:space:]]+)?MIMO_API_KEY=/' "$ENV_FILE" > "$tmp_file"
fi
escaped_key="${key//\'/\'\\\'\'}"
printf "MIMO_API_KEY='%s'\n" "$escaped_key" >> "$tmp_file"
chmod 600 "$tmp_file"
mv "$tmp_file" "$ENV_FILE"
trap - EXIT

echo "已写入 ${ENV_FILE}（权限 600）。正式启动脚本会自动读取该文件。"

echo "运行真实 API 冒烟验证（1 次调用）…"
if "${ROOT}/scripts/tools/mimo-smoke.sh" structured --rounds 1; then
  echo "冒烟通过：key 可用。"
else
  echo "冒烟失败：key 或网络有问题；.env 已保留，可稍后单独重跑。" >&2
  exit 1
fi
