#!/usr/bin/env bash
# 一键启动（Linux / macOS）
cd "$(dirname "$0")" || exit 1
exec node start.js "$@"
