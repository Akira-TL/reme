#!/bin/zsh
cd "${0:A:h}"
REME_PORT=4174
REME_URL="http://127.0.0.1:${REME_PORT}"
REME_NPM_CACHE_DIR="/private/tmp/reme-npm-cache"

if [[ ! -d node_modules ]]; then
  npm_config_cache="$REME_NPM_CACHE_DIR" npm install || exit 1
fi

npm run dev -- --host 127.0.0.1 --port "$REME_PORT" &
REME_SERVER_PID=$!
trap 'kill "$REME_SERVER_PID" 2>/dev/null' EXIT INT TERM
sleep 1
open "$REME_URL"
wait "$REME_SERVER_PID"
