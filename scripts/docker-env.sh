#!/usr/bin/env bash
set -euo pipefail

agency_export_docker_env() {
  local root_dir="$1"
  local os_name
  local plugin_dirs=("${HOME}/.docker/cli-plugins")

  os_name="$(uname -s)"

  export HOST_UID="${HOST_UID:-$(id -u)}"
  export HOST_GID="${HOST_GID:-$(id -g)}"
  export DOCKER_CONFIG="${DOCKER_CONFIG:-$root_dir/.cache/docker-config}"

  mkdir -p "$DOCKER_CONFIG"
  mkdir -p "$DOCKER_CONFIG/cli-plugins"

  if [[ "$os_name" == "Darwin" ]]; then
    local docker_desktop_plugins="/Applications/Docker.app/Contents/Resources/cli-plugins"
    local plugin
    for plugin in docker-buildx docker-compose; do
      if [[ -x "$docker_desktop_plugins/$plugin" ]]; then
        ln -sf "$docker_desktop_plugins/$plugin" "$DOCKER_CONFIG/cli-plugins/$plugin"
      fi
    done

    if [[ -z "${DOCKER_HOST:-}" && -S "${HOME}/.docker/run/docker.sock" ]]; then
      export DOCKER_HOST="unix://${HOME}/.docker/run/docker.sock"
    fi
  fi

  if [[ "$os_name" == "Linux" ]]; then
    plugin_dirs+=(
      "/usr/local/lib/docker/cli-plugins"
      "/usr/lib/docker/cli-plugins"
      "/usr/libexec/docker/cli-plugins"
    )
  fi

  export DOCKER_CLI_PLUGIN_EXTRA_DIRS
  DOCKER_CLI_PLUGIN_EXTRA_DIRS="$(IFS=:; printf '%s' "${plugin_dirs[*]}")"
}
