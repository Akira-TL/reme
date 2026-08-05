#!/bin/zsh
SCRIPT_DIR="${0:A:h}"
ROOT="${SCRIPT_DIR:h:h:h}"
exec bash "$ROOT/scripts/demo/start-frontend-preview.sh" typical-demo.html
