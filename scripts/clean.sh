#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export HOST_UID="$(id -u)"
export HOST_GID="$(id -g)"
export DOCKER_CONFIG="$ROOT_DIR/.cache/docker-config"
export DOCKER_CLI_PLUGIN_EXTRA_DIRS="${HOME}/.docker/cli-plugins"
export DOCKER_HOST="unix://${HOME}/.docker/run/docker.sock"

mkdir -p "$DOCKER_CONFIG"
mkdir -p "$DOCKER_CONFIG/cli-plugins"
for plugin in docker-buildx docker-compose; do
  target="/Applications/Docker.app/Contents/Resources/cli-plugins/$plugin"
  if [[ -x "$target" ]]; then
    ln -sf "$target" "$DOCKER_CONFIG/cli-plugins/$plugin"
  fi
done

docker compose down --remove-orphans --rmi local >/dev/null 2>&1 || true

rm -rf \
  .agency \
  .cache \
  dist \
  node_modules \
  apps/*/node_modules \
  packages/*/node_modules
