#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VENV_DIR="${ROOT_DIR}/.cache/python/.venv"
mkdir -p "${ROOT_DIR}/.cache/python"

if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  uv venv "$VENV_DIR"
fi

uv pip install \
  --python "${VENV_DIR}/bin/python" \
  --upgrade \
  duckdb \
  pandas \
  pyarrow
