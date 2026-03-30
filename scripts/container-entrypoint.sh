#!/usr/bin/env bash
set -euo pipefail

mkdir -p \
  /workspace/.agency \
  /workspace/.cache/home \
  /workspace/.cache/xdg \
  /workspace/.cache/npm \
  /workspace/.cache/pnpm/home \
  /workspace/.cache/pnpm/store \
  /workspace/.cache/python \
  /workspace/.cache/uv \
  /workspace/.cache/playwright

exec "$@"
