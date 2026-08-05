#!/bin/sh
# 兼容旧路径；正式实现位于 scripts/setup/setup-mimo-env.sh。
set -eu
exec bash "$(dirname "$0")/setup/setup-mimo-env.sh" "$@"
