# OpenCoxswain

<p align="center">
  <strong>A local-first coding assistant with a four-tier agent structure.</strong>
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

You talk to one Assistant. It splits the work across parallel Agents and reports each result as it lands.

> **Status: 0.x, early.** Usable day to day on Windows. Expect rough edges.

## How it works

```
User ────────→ Supervisor   Cross-project view, conflict resolution, priority calls
  │
  └─→ Assistant             One persistent session per project. The main entry point.
        │
        └─→ Agent           One Agent per task. Edits code directly, accepts follow-ups.
```

| Tier | Scope | Lifetime |
| --- | --- | --- |
| **Supervisor** | Every project at once | Global, backend only |
| **Assistant** | One project | Persistent per project, survives restarts |
| **Agent** | One task | Created per task, can be followed up |

Naming follows [docs/glossary.md](docs/glossary.md). The tier names are always capitalized.

## Install

There is no published installer yet. Build from source.

Requirements: **Node.js ≥ 22** and **pnpm 10**. Rust 1.77+ is needed only for the desktop installer.

```bash
pnpm install
pnpm build
```

## Quick start

```bash
# Command line
export OPENCOXSWAIN_LLM_API_KEY=sk-...
pnpm runtime --project D:/work/my-app

# With the web UI
node apps/runtime/dist/cli.js --project D:/work/my-app --serve --static apps/web/dist
# open http://127.0.0.1:47900

# Desktop app
pnpm app:build     # output in apps/shell/src-tauri/target/release/bundle/nsis/
```

The runtime serves the API and the UI on the same port, so there is no second server and no CORS setup.

## Features

- **Persistent Assistant.** One session per project. Close the app and reopen it; the conversation is still there.
- **Parallel execution and independent reporting.** Each Agent settles and reports on its own, without waiting for the others.
- **Concurrent messages without interruption.** New messages queue in an inbox and are read after the current turn.
- **Read-only tasks never wait.** Tasks with `writeScope: ["readonly"]` run in parallel with everything. Writing tasks are mutually exclusive on overlapping write scopes.
- **Ask the Agent again.** Open any Agent to inspect its full trace and continue with context.
- **Blocker classification.** The Assistant sorts a stalled Agent into retryable, environment, or needs-your-decision, and only then interrupts you.
- **Memory.** Local Markdown, global and per-project. Rejects temporary instructions, vague preferences, and secrets.
- **Usage limits.** Set a per-task and daily token cap. The run actually stops when the cap is hit.
- **Approval for irreversible actions.** Deletes, pushes, releases, payments, and outbound messages pause for your decision before running. Timeouts default to reject.
- **Replayable SSE.** Reconnects with `?after=` replay missed events. If the backlog is too large, the client gets an explicit notice and refetches a snapshot.
- **Task templates.** Bug fix, feature, docs, refactor, research. Templates prefill, they never dispatch.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCOXSWAIN_LLM_API_KEY` | empty | Model key. `DEEPSEEK_API_KEY` is also accepted. Can be set in the UI instead. |
| `OPENCOXSWAIN_LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI-compatible endpoint |
| `OPENCOXSWAIN_LLM_MODEL` | `deepseek-chat` | Model name |
| `OPENCOXSWAIN_LLM_FILE` | `~/.opencoxswain/llm.json` | Key file written by the UI. Environment variables take precedence. |
| `OPENCOXSWAIN_DB` | `~/.opencoxswain/runtime.db` | SQLite database |
| `OPENCOXSWAIN_MEMORY` | `~/.opencoxswain/memory` | Memory directory |
| `OPENCOXSWAIN_PORT` | `47900` | HTTP port |
| `OPENCOXSWAIN_TOKEN` | generated | Local API token. Usually leave alone. |
| `OPENCOXSWAIN_IM_FILE` | `~/.opencoxswain/im.json` | Telegram channel config |
| `OPENCOXSWAIN_TELEGRAM_TOKEN` | empty | Telegram bot token, takes precedence over the config file |
| `TAURI_SIGNING_PRIVATE_KEY` | empty | Release builds only. See [docs/release.md](docs/release.md). |

## Security

The runtime binds to `127.0.0.1` only and requires `Authorization: Bearer <token>` on every API call. The token is generated on first start and stored in `~/.opencoxswain/token`.

Model keys are encrypted with Windows DPAPI, which derives the key from the current user account. A copied key file does not decrypt on another machine or account.

CORS is restricted to the local UI origin. Any other web page you open cannot reach the API.

> An early version shipped with `Access-Control-Allow-Origin: *` and no authentication. That allowed any page in your browser to call the local API and dispatch commands. The current version rejects those calls.

Report vulnerabilities privately. See [SECURITY.md](SECURITY.md). Do not open a public issue.

## Desktop app on Windows

The installer is not code-signed, so SmartScreen shows "Windows protected your PC" on first run. Choose **More info → Run anyway**. The updater signature is separate and only proves that an update came from this application.

## Development

```bash
pnpm test        # unit tests, no browser and no network
pnpm e2e         # browser interaction tests against a running server
pnpm typecheck
pnpm app:check   # Rust shell compile check
```

The e2e suite needs a built server:

```bash
pnpm build
node apps/runtime/dist/cli.js --serve --static apps/web/dist --port 47910
pnpm e2e
```

Unit tests are driven by a scripted fake model. They cover the full pipeline from user message to Agent writing a file and the Assistant reporting it, parallel read-only dispatch with no queueing, follow-up context retention, identical behaviour across the in-memory and SQLite stores, and restart recovery.

Browser tests are separate because controlled inputs (`input`, `select`, `textarea`) misbehave under jsdom or happy-dom with React 18. Real browsers do not have that problem.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the code map and the contribution workflow.

## Known limitations

- **Plan approval does not auto-advance.** Approving a plan does not start the next step yet.
- **Windows only.** Linux and macOS have no CI coverage.
- **No published release.** Auto-update needs a public `latest.json`, which is not hosted yet.

## Repository layout

| Path | Description |
| --- | --- |
| `apps/runtime` | The runtime: all four tiers, plus the HTTP/SSE server |
| `apps/web` | Workspace UI: pick a project, talk to the Assistant, watch Agents |
| `apps/shell` | Tauri 2 desktop shell |
| `apps/daemon`, `apps/desktop` | Legacy, kept but not developed |
| `packages/{shared,core,adapters,memory,plugin-api}` | Legacy kernel and packages |
| `packages/dsh-bao` | Frozen dsh plugin, kept as a design reference |
| `docs/` | Design notes and records. Start at [docs/README.md](docs/README.md). |
| `docs/project-status.md` | Full project snapshot: structure, features, data model, API |

## Documentation

- [docs/architecture.md](docs/architecture.md): tier boundaries and module layout
- [docs/glossary.md](docs/glossary.md): naming authority for code, docs, and UI
- [docs/release.md](docs/release.md): release and update process
- [docs/README.md](docs/README.md): full index

## License

Apache-2.0. See [LICENSE](LICENSE).
