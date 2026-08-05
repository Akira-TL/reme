#!/bin/zsh
cd "${0:A:h}"
REME_DEMO_PORT=4174
REME_DEMO_URL="http://127.0.0.1:${REME_DEMO_PORT}/typical-demo.html"
REME_DEMO_NPM_CACHE="/private/tmp/reme-npm-cache"

if [[ ! -x node_modules/.bin/vite ]] || \
  ! node scripts/check-native-deps.mjs >/dev/null 2>&1; then
  echo "检测到前端依赖缺失或与当前系统不兼容，正在干净重装…"
  npm_config_cache="$REME_DEMO_NPM_CACHE" npm ci || exit 1
fi
[[ -x node_modules/.bin/vite ]] || { echo "Vite 命令未正确安装" >&2; exit 1; }
node scripts/check-native-deps.mjs || exit 1

npm run dev -- --host 127.0.0.1 --port "$REME_DEMO_PORT" &
REME_DEMO_SERVER_PID=$!
trap 'kill "$REME_DEMO_SERVER_PID" 2>/dev/null' EXIT INT TERM
sleep 1
open "$REME_DEMO_URL"
wait "$REME_DEMO_SERVER_PID"
