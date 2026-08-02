#!/bin/zsh
cd "${0:A:h}"
REME_DEMO_PORT=4174
REME_DEMO_URL="http://127.0.0.1:${REME_DEMO_PORT}/typical-demo.html"
REME_DEMO_NPM_CACHE="/private/tmp/reme-npm-cache"

if [[ ! -d node_modules ]]; then
  npm_config_cache="$REME_DEMO_NPM_CACHE" npm install || exit 1
fi

npm run dev -- --host 127.0.0.1 --port "$REME_DEMO_PORT" &
REME_DEMO_SERVER_PID=$!
trap 'kill "$REME_DEMO_SERVER_PID" 2>/dev/null' EXIT INT TERM
sleep 1
open "$REME_DEMO_URL"
wait "$REME_DEMO_SERVER_PID"
