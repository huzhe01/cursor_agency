# Cursor Agency

A Docker-only Cursor primitive prototype. The host only needs Docker Desktop and Cursor.

## Host policy

- No global `npm`, `pnpm`, `pip`, or Python virtualenv setup.
- No shell profile changes.
- All runtime state stays inside this repository under `.agency/` or `.cache/`.
- The wrapper also redirects Docker CLI state into `.cache/docker-config` so builds do not need to write under `~/.docker`.

## Quick start

1. Copy `.env.example` to `.env.local` and fill in `OPENAI_API_KEY`.
2. Run `./agency bootstrap`.
3. Run `./agency doctor`.
4. Run `./agency index`.
5. Run `./agency task "describe the login flow"`.

For Volcengine Ark OpenAI-compatible endpoints, set `ARK_API_KEY`, `ARK_BASE_URL`, and `ARK_ENDPOINT_ID` in `.env.local`.

## Commands

- `./agency bootstrap`: install workspace dependencies inside the container
- `./agency doctor`: verify container runtime, env vars, and state directories
- `./agency index [--watch]`: build or refresh `.agency/index.sqlite`
- `./agency task "..."`: run a single plan-execute-verify task
- `./agency chat`: start an interactive REPL with session logging
- `./agency web`: start a minimal web console on `http://127.0.0.1:3000`
- `./agency up`: start a long-running dev container for attaching Cursor Dev Containers
- `./agency shell`: open a shell inside the container
- `./agency clean`: remove compose resources and project caches, keep `.env.local`
- `./agency purge`: same as clean, plus delete `.env.local`

## State layout

- `.agency/index.sqlite`: local full-text and embedding index
- `.agency/sessions/`: task and chat transcripts, plans, artifacts, snapshots
- `.cache/`: pnpm, npm, uv, and other runtime caches

## Agent behavior

- The runtime now biases toward a Cursor-like gather -> plan -> act -> verify loop.
- It prefers `apply_unified_patch` for precise edits after reading files.
- If the configured embedding endpoint fails, indexing and retrieval automatically fall back to lexical-only mode.

## Uninstall

Run `./agency purge`, then delete the repository directory. That removes project containers, local images built by this project, cached dependencies, indexes, logs, and the local secrets file.
