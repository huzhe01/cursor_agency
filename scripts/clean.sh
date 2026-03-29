#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/docker-env.sh"
agency_export_docker_env "$ROOT_DIR"

docker compose down --remove-orphans --rmi local >/dev/null 2>&1 || true

rm -rf \
  .agency \
  .cache \
  dist \
  node_modules \
  apps/*/node_modules \
  packages/*/node_modules
