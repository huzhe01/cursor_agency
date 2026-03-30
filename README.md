# Cursor Agency

Cursor Agency is a Docker-first research prototype for a minimal coding agent runtime.
It is not a clone of Cursor. The goal is narrower: provide a practical, inspectable agent loop for local repositories with indexing, planning, tool execution, approvals, diff review, and a minimal browser console.

The runtime is designed around a simple software engineering workflow:

`gather context -> plan -> act -> verify`

## What This Project Provides

- A host-side wrapper script: `./agency`
- A containerized development/runtime environment
- A local code index built on `SQLite FTS + embedding rerank`
- A verifier-driven agent runtime with approvals for write and shell actions
- Budget-driven single-session context management with rolling summaries
- A persistent session/artifact store under `.agency/`
- A CLI for task execution and interactive chat
- A minimal web console for sessions, diff preview, approval handling, and SSE streaming
- Local Python + DuckDB analysis execution inside the containerized runtime

## Host Compatibility

The repository is intended to run on:

- macOS with Docker Desktop
- Linux hosts such as Ubuntu with Docker Engine or Docker Desktop and Docker Compose v2

The host does not need local installations of:

- Node.js
- pnpm
- Python
- uv
- sqlite3

The `./agency` script is not a compiled binary. It is a Bash wrapper that starts the containerized runtime for you.

### Linux support

`./agency` has been adapted to run on Linux hosts directly.

Behavior by platform:

- On macOS, it auto-detects Docker Desktop plugin locations and Docker Desktop's local socket when available.
- On Linux, it uses the system Docker installation and common Compose plugin directories, and does not force a macOS-specific `DOCKER_HOST`.

That means Ubuntu users can run the same `./agency` commands as macOS users, as long as Docker and Compose are available.

## Prerequisites

### macOS

Required:

- Docker Desktop
- Bash

Optional but recommended:

- Cursor.app for editing and Dev Containers attachment

### Linux / Ubuntu

Required:

- Docker Engine or Docker Desktop for Linux
- Docker Compose v2 (`docker compose`)
- Bash

Optional but recommended:

- Cursor or VS Code with Dev Containers support

Before using the wrapper, verify:

```bash
docker version
docker compose version
```

If those commands work, `./agency` should work.

## Quick Start

### 1. Configure the model provider

Create a local environment file:

```bash
cp .env.example .env.local
```

Fill in either OpenAI-compatible or Volcengine Ark-compatible settings.

Example for a generic OpenAI-compatible provider:

```env
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://your-openai-compatible-endpoint/v1
OPENAI_MODEL=gpt-4.1-mini
OPENAI_EMBED_MODEL=text-embedding-3-small
```

Example for Volcengine Ark:

```env
ARK_API_KEY=...
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_ENDPOINT_ID=your-endpoint-id
```

The runtime also accepts `OPENAI_*` variables directly when using Ark's OpenAI-compatible API.

Optional verifier/backend settings:



```env
VERIFIER_API_KEY=
VERIFIER_MODEL=
VERIFIER_BASE_URL=
AGENCY_MAX_EXECUTION_ROUNDS=3
AGENCY_CONTEXT_TOKEN_BUDGET=12000
AGENCY_CONTEXT_RESERVE_TOKENS=2500
AGENCY_TOOL_OUTPUT_CHAR_LIMIT=3500
AGENCY_SUMMARY_TRIGGER_RATIO=0.8
AGENCY_DEFAULT_BACKEND=local
E2B_API_KEY=
E2B_TEMPLATE_ID=
```

### 2. Bootstrap the environment

```bash
./agency bootstrap
```

This command:

- builds the Docker image
- installs workspace dependencies inside the container
- prepares the local cache layout under `.cache/`
- creates a project-local Python environment at `.cache/python/.venv`
- installs `duckdb`, `pandas`, and `pyarrow` into that project-local environment

### 3. Check the runtime

```bash
./agency doctor
```

This verifies:

- provider configuration
- key runtime commands inside the container
- state/cache directories
- index availability

### 4. Build the code index

```bash
./agency index
```

### 5. Run the agent

```bash
./agency task "Summarize this repository"
./agency chat
./agency web --port 3000
```

The web console will be available at:

- `http://127.0.0.1:3000`

## Typical Developer Workflow

```bash
./agency bootstrap
./agency doctor
./agency index
./agency task "Find the indexing entrypoints"
./agency chat
```

For long-running editor attachment:

```bash
./agency up
```

Then attach your editor to the Compose service defined in `.devcontainer/devcontainer.json`.

To open a shell inside the runtime container:

```bash
./agency shell
```

To stop the long-running service:

```bash
./agency down
```

## Build, Typecheck, and Validation

Day-to-day use does not require a manual host-side build step. The runtime uses `tsx` inside the container.

For maintainers and CI, these are the important validation commands:

```bash
docker compose run --rm dev pnpm typecheck
docker compose run --rm dev pnpm build
docker compose run --rm dev pnpm smoke
```

What they do:

- `typecheck`: TypeScript type validation
- `build`: compile the TypeScript project with `tsc`
- `smoke`: environment + index smoke test

If you are on Ubuntu or another Linux host, these commands are identical.

## How `./agency` Works

`./agency` is the host entrypoint. It is responsible for:

- exporting host UID/GID to avoid root-owned files in the workspace
- redirecting Docker CLI state into `.cache/docker-config`
- adapting Docker CLI plugin discovery for macOS and Linux
- invoking `docker compose` with the right service and command

It does **not** embed the runtime environment inside itself.

The actual runtime lives in:

- the Docker image defined by `Dockerfile`
- the Compose service defined by `compose.yaml`
- the repository-mounted workspace at `/workspace` inside the container

## Runtime Layout

Host repository root:

- `/Users/huzhe/project/cursor_agency` on the current macOS machine
- on Linux, this will simply be wherever the repository is cloned

Inside the container, the repository is always mounted as:

- `/workspace`

Important state paths:

- host: `./.agency/index.sqlite`
- container: `/workspace/.agency/index.sqlite`
- host: `./.agency/sessions/`
- container: `/workspace/.agency/sessions/`
- host: `./.cache/`
- container: `/workspace/.cache/`

These are the same files, seen from two different path namespaces because the repository is bind-mounted into the container.

## Architecture Overview

The codebase is intentionally split into small packages.

### `apps/cli`

Container-side CLI entrypoint.

Main responsibilities:

- parse commands
- create the runtime
- provide interactive chat REPL
- start the web console

Key file:

- `apps/cli/src/index.ts`

### `packages/core`

The agent control plane.

Responsibilities:

- configuration loading
- provider/model adapter
- runtime event streaming
- context budgeting and rolling summary generation
- session persistence
- approval queueing
- task/chat runtime loop
- browser console server

Important files:

- `packages/core/src/config.ts`
- `packages/core/src/context.ts`
- `packages/core/src/events.ts`
- `packages/core/src/openai.ts`
- `packages/core/src/runtime.ts`
- `packages/core/src/approvals.ts`
- `packages/core/src/session-store.ts`
- `packages/core/src/console-server.ts`
- `packages/core/src/doctor.ts`

### `packages/indexer`

Local repository indexing and retrieval.

Responsibilities:

- file scanning
- ignore handling
- chunking source files
- SQLite/FTS persistence
- vector reranking
- incremental rebuilds
- file watching

Key file:

- `packages/indexer/src/index.ts`

### `packages/tools`

Tool definitions exposed to the model.

Responsibilities:

- tool schemas
- approval levels
- workspace file operations
- exact text replacement
- patch application
- shell execution
- diff inspection

Key file:

- `packages/tools/src/index.ts`

### `scripts`

Operational scripts used by the project.

Important files:

- `scripts/docker-env.sh`: shared Docker environment bootstrap for macOS/Linux
- `scripts/container-entrypoint.sh`: container-side directory bootstrap
- `scripts/clean.sh`: project-local cleanup
- `scripts/purge.sh`: cleanup plus `.env.local` removal
- `scripts/smoke.ts`: smoke validation

## Agent Runtime Behavior

The runtime is intentionally conservative.

Current behavior:

- retrieve indexed context first
- generate a structured round plan with acceptance checks
- trim and compress context before each execution step
- execute tool calls iteratively
- require approval for write and shell tools
- collect evidence for each round
- run rule-first verification after each round
- replan when verification fails and stop only on `PASS` or `BLOCKED`

Important tooling currently includes:

- `read_file`
- `list_files`
- `search_code`
- `read_multiple_files`
- `search_index`
- `replace_exact_text`
- `write_patch`
- `apply_unified_patch`
- `run_shell`
- `run_python_script`
- `run_duckdb_sql`
- `inspect_table`
- `assert_table_checks`
- `read_diff`

Editing behavior:

- `replace_exact_text` is the default narrow edit primitive
- it replaces all exact matches in one file
- it fails on zero matches
- it can assert `expected_occurrences`
- it supports `dry_run` preview mode
- `apply_unified_patch` remains the fallback for structured changes

`apply_unified_patch` supports:

- single-file patch application
- multi-file patch application
- `dry_run` preview mode

Data-analysis tooling supports:

- Python script execution in the local container runtime
- DuckDB SQL execution
- table inspection
- structured table assertions such as row count, exact columns, null checks, value ranges, and aggregate equality

## Web Console

The browser console is intentionally minimal, but it is useful for reviewing agent activity without staying in the terminal.

Current capabilities:

- submit asynchronous tasks
- create a persistent chat session
- send follow-up chat messages
- subscribe to a per-session SSE event stream
- inspect plans, finals, verification output, and events
- preview diffs
- inspect artifacts
- approve or deny pending write/shell actions

## Repository Structure

```text
.
├── .devcontainer/
├── apps/
│   └── cli/
├── packages/
│   ├── core/
│   ├── indexer/
│   └── tools/
├── scripts/
├── Dockerfile
├── compose.yaml
├── agency
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
└── README.md
```

## State and Cleanup

All project runtime state is kept inside the repository so it can be inspected and removed predictably.

State locations:

- `.agency/`: index database, sessions, plans, artifacts, diffs
- `.cache/`: pnpm/npm/uv/playwright caches and local Docker CLI config

Cleanup commands:

```bash
./agency clean
./agency purge
```

Behavior:

- `clean` removes containers, project-local images, caches, indexes, and installed dependencies, but keeps `.env.local`
- `purge` does the same and also removes `.env.local`

To fully remove the project from a machine:

```bash
./agency purge
rm -rf <repo-path>
```

## Linux Notes for GitHub Users

On Ubuntu or other Linux hosts, the intended setup is:

1. Install Docker Engine and Docker Compose v2
2. Clone the repository
3. Create `.env.local`
4. Run:

```bash
chmod +x agency
./agency bootstrap
./agency doctor
./agency index
./agency task "Summarize this repository"
```

No host-side Node.js or Python installation is required.

If your Docker installation is healthy, the developer workflow is the same on Linux and macOS.

## Current Scope

This repository is a practical prototype, not a full commercial IDE agent.

Included:

- local indexing
- verifier-driven plan/execute/verify loop
- single-session context budgeting and rolling summaries
- tool calling
- exact text replacement
- approvals
- CLI and Web streaming output
- session persistence
- CLI
- minimal web console
- Python + DuckDB analysis execution
- optional E2B backend abstraction

Not included yet:

- multi-agent orchestration
- browser-native subagents
- remote/team indexing
- tab completion
- evaluation/RL infrastructure
- session recovery after server restart for in-memory chat state

## License / Contribution Notes

If you plan to open this repository to external contributors, the next useful additions would be:

- an explicit license file
- issue templates
- contribution guidelines
- CI for `typecheck`, `build`, and `smoke`
