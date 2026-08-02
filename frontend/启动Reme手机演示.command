#!/bin/zsh
cd "${0:A:h}"
REME_PORT=4174
REME_URL="http://127.0.0.1:${REME_PORT}"
REME_NPM_CACHE_DIR="/private/tmp/reme-npm-cache"

if [[ ! -x node_modules/.bin/vite ]] || \
  ! node scripts/check-native-deps.mjs >/dev/null 2>&1; then
  echo "检测到前端依赖缺失或与当前系统不兼容，正在干净重装…"
  npm_config_cache="$REME_NPM_CACHE_DIR" npm ci || exit 1
fi
[[ -x node_modules/.bin/vite ]] || { echo "Vite 命令未正确安装" >&2; exit 1; }
node scripts/check-native-deps.mjs || exit 1

npm run dev -- --host 127.0.0.1 --port "$REME_PORT" &
REME_SERVER_PID=$!
trap 'kill "$REME_SERVER_PID" 2>/dev/null' EXIT INT TERM
sleep 1
open "$REME_URL"
wait "$REME_SERVER_PID"
