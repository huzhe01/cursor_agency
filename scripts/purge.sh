#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/docker-env.sh"
agency_export_docker_env "$ROOT_DIR"

"$ROOT_DIR/scripts/clean.sh"
rm -f .env.local
