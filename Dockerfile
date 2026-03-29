FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
  for attempt in 1 2 3; do \
    apt-get update && \
    apt-get install -y --fix-missing --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      fd-find \
      git \
      jq \
      python3 \
      ripgrep \
      sqlite3 \
      zsh && \
    break; \
    if [ "$attempt" -eq 3 ]; then \
      exit 1; \
    fi; \
    sleep 5; \
  done && \
  rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
  install -m 0755 /root/.local/bin/uv /usr/local/bin/uv && \
  ln -s /usr/bin/fdfind /usr/local/bin/fd

WORKDIR /workspace

COPY scripts/container-entrypoint.sh /usr/local/bin/container-entrypoint.sh
RUN chmod +x /usr/local/bin/container-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/container-entrypoint.sh"]
CMD ["sleep", "infinity"]
