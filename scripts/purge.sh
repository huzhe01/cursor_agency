#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export DOCKER_CONFIG="$ROOT_DIR/.cache/docker-config"
export DOCKER_CLI_PLUGIN_EXTRA_DIRS="${HOME}/.docker/cli-plugins"
export DOCKER_HOST="unix://${HOME}/.docker/run/docker.sock"

"$ROOT_DIR/scripts/clean.sh"
rm -f .env.local
