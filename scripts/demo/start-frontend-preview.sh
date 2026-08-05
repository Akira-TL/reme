#!/usr/bin/env bash
# 启动单独的前端预览页，不启动统一后端。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRONTEND_DIR="${ROOT}/frontend"
PAGE="${1:-index.html}"
PORT="${REME_DEMO_PORT:-4174}"
HOST="${REME_DEMO_HOST:-127.0.0.1}"
NPM_CACHE="${REME_NPM_CACHE_DIR:-/private/tmp/reme-npm-cache}"
URL="http://${HOST}:${PORT}/${PAGE#index.html}"

cd "$FRONTEND_DIR"

if [[ ! -x node_modules/.bin/vite ]] || \
  ! node scripts/check-native-deps.mjs >/dev/null 2>&1; then
  echo "检测到前端依赖缺失或与当前系统不兼容，正在干净重装…"
  npm_config_cache="$NPM_CACHE" npm ci
fi

[[ -x node_modules/.bin/vite ]] || {
  echo "Vite 命令未正确安装" >&2
  exit 1
}
node scripts/check-native-deps.mjs

npm run dev -- --host "$HOST" --port "$PORT" --strictPort &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM
sleep 1

if command -v open >/dev/null 2>&1; then
  open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
else
  echo "前端已启动：${URL}"
fi

wait "$SERVER_PID"
