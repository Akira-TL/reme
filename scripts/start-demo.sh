#!/bin/sh
# 兼容旧路径；正式实现位于 scripts/demo/start-local-demo.sh。
set -eu
exec sh "$(dirname "$0")/demo/start-local-demo.sh" "$@"
