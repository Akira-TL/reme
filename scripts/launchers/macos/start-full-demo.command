#!/bin/zsh
SCRIPT_DIR="${0:A:h}"
ROOT="${SCRIPT_DIR:h:h:h}"
exec zsh "$ROOT/scripts/demo/start-local-demo.sh"
