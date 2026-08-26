# Codex Workers for Claude

> Use **Codex** as persistent, steerable workers inside **Claude Code** multi-agent workflows.

Claude Code stays the orchestrator. Codex becomes a worker that Claude can **start**,
**read from while it's still running**, **steer mid-task**, **interrupt**, and **collect
results from** — without losing visibility behind a black-box final answer.

```text
Claude Code / Ultracode  (orchestrator)
  ├─ Claude subagent: planner
  ├─ Claude subagent: reviewer
  ├─ Claude subagent: verifier
  └─ Claude subagent: Codex commander
        ↕  codex-worker-bridge (MCP)
        └─ Codex worker session(s)   ← real `codex` agents
```

By default Claude receives only **useful Codex messages and compact artifacts** (final
answer, changed files, diff/command summaries, artifact paths) — not every raw shell log.
Full debug traces are always preserved on disk and available on demand.

---

## How it works

Three layers, one local process boundary:

```text
Claude Code plugin        skills · agents · commands · MCP config
        │
codex-worker-bridge       local MCP server (Node) Claude Code talks to
        │   ├─ worker registry      ├─ transcript filter   ├─ artifact store
        │   ├─ worktree manager     ├─ safety layer        └─ Codex adapter
        ▼
Codex backend             `codex app-server` (JSON-RPC) → persistent Codex threads
```

The bridge speaks the Codex **app-server v2** protocol (newline-delimited JSON-RPC over
stdio): `thread/start` → `turn/start` → streamed notifications → `turn/steer` /
`turn/interrupt` / `thread/resume`. One `codex app-server` child + one thread per worker.
See [`docs/codex-app-server-protocol.md`](docs/codex-app-server-protocol.md) for the
verified protocol surface the adapter is built on.

---

## Requirements

- [Claude Code](https://docs.claude.com/en/docs/claude-code)
- [Codex CLI](https://developers.openai.com/codex/cli) — logged in (`codex login`)
- Node.js ≥ 18
- Git

The bridge detects a missing/logged-out Codex and returns a clear, actionable error.

## Install

From inside Claude Code:

```text
/plugin marketplace add todorkolev/codex-workers-for-claude
/plugin install codex-workers@codex-workers
/reload-plugins
```

### One-line install (for agents / terminals)

The repo ships an [`scripts/install.sh`](scripts/install.sh) that drives the `claude`
CLI: it removes any prior install, re-adds the marketplace, and installs the plugin. It's
self-contained (pulls from the remote marketplace, no checkout needed), so an agent can
run it directly:

```bash
curl -fsSL https://raw.githubusercontent.com/todorkolev/codex-workers-for-claude/main/scripts/install.sh | bash
```

Then run `/reload-plugins` (or restart Claude Code) to activate it.

The repo ships the pre-bundled bridge (`plugins/codex-workers/dist/bridge.js`), so there's
**no npm install and no npm account required** to use it.

### Troubleshooting: plugin silently fails to load

If Claude Code reports something like `Reloaded: 0 plugins … 7 agents …` with
`1 error during load` and the `codex_worker_*` tools / `codex-workers:codex-commander`
agent never appear, the cause is almost always **stale absolute paths in Claude Code's
plugin registry**.

Claude Code stores *absolute* install paths in `~/.claude/plugins/installed_plugins.json`
and `known_marketplaces.json`, using the `$HOME` of whatever environment ran the install.
This repo's devcontainer runs as user `node` (`remoteUser: "node"`), so installing the
plugin **from inside the devcontainer** writes `/home/node/...` paths. If that same
`~/.claude` is later used from a host or container where `$HOME` differs (e.g.
`/home/user`), the recorded paths point at a directory that does not exist and the loader
fails with an unnamed error — even though `dist/` and everything else are intact.

**Fix it with the bundled doctor** (plain Node, no build or checkout of the plugin needed —
works even when the plugin is completely dead):

```bash
# diagnose (safe, read-only)
node scripts/repair-plugin-paths.mjs
# repair (backs up each file, rewrites the stale prefix to the real one)
node scripts/repair-plugin-paths.mjs --fix
```

Or straight from the web with no checkout:

```bash
curl -fsSL https://raw.githubusercontent.com/todorkolev/codex-workers-for-claude/main/scripts/repair-plugin-paths.mjs | node - --fix
```

Then `/reload-plugins` and restart the session so the MCP server binds.

The bridge also **self-heals on startup**: whenever it runs it reconciles the registry's
recorded paths with the environment that actually launched it (disable with
`CODEX_WORKERS_NO_SELF_HEAL=1`). That covers drift once the plugin loads, but the very
first cold-start break — where nothing in the plugin runs — needs the doctor above.

To avoid the mismatch entirely, install the plugin from the environment you actually run
Claude Code in, rather than from inside the devcontainer while sharing `~/.claude`.

## Quickstart

With the plugin installed, just ask Claude:

```text
Use a Codex worker to investigate why the auth session tests are flaky.
```

Claude picks up the `codex-worker` skill, starts a **read-only** Codex worker, streams its
findings as they arrive, steers it if it drifts off-scope, and hands you a compact summary
with artifact paths. For write tasks it isolates the worker in a dedicated git worktree and
reviews the diff before anything touches your tree.

A fuller, scripted example (investigate → implement → review → verify) lives in
[`docs/usage.md`](docs/usage.md).

---

## MCP tools

| Tool | Purpose |
|---|---|
| `codex_worker_start` | Start a Codex worker on a scoped task |
| `codex_worker_read_messages` | Read filtered Codex messages (before completion) |
| `codex_worker_steer` | Inject steering into a running turn (or a new turn when idle) |
| `codex_worker_status` | Get worker state, counts, changed files |
| `codex_worker_collect_result` | Collect final message + compact result + artifact paths |
| `codex_worker_interrupt` | Interrupt an active worker (logs preserved, resumable) |
| `codex_worker_debug_trace` | Read raw Codex events (debugging) |

## Transcript modes

| Mode | Claude receives |
|---|---|
| `messages` | Codex messages only |
| `messages_plus_artifacts` | messages + changed files + diff/command summaries + artifact paths **(default)** |
| `full_events` | full raw Codex events (token-heavy; debugging only) |

## Safety

- Review/planning workers default to **read-only**, `approvalPolicy: never`.
- Implementation workers run **workspace-write** inside an **isolated git worktree**
  (`.worktrees/codex-<worker-id>`, branch `codex/<run-id>/<worker-id>`); never two write
  workers in the same directory.
- Destructive commands (`rm -rf`, `git reset --hard`, `git clean -fd`, `git push`,
  `npm/pnpm publish`, `docker system prune`, `drop database`, `terraform apply`,
  `kubectl delete`, …) are auto-denied by the safety layer.
- All raw events are persisted to disk; Claude can interrupt any worker at any time.

## Artifacts

Each run writes to `<project>/.codex-workers/runs/<run-id>/`:

```text
manifest.json
workers/<worker-id>/
  worker.json   events.ndjson   messages.md   result.json
  final.md      diff.patch      changed-files.txt   command-summary.md   error.log
```

---

## Repository layout

```text
codex-workers-for-claude/
├─ .claude-plugin/marketplace.json     # marketplace entry (install point)
├─ plugins/codex-workers/              # the installable, self-contained plugin
│  ├─ .claude-plugin/plugin.json
│  ├─ .mcp.json                        # registers the bridge MCP server
│  ├─ bin/codex-workers-bridge         # launch wrapper
│  ├─ dist/bridge.js                   # bundled MCP bridge (committed)
│  ├─ skills/codex-worker/SKILL.md
│  ├─ agents/codex-commander.md
│  ├─ commands/codex-worker.md
│  └─ README.md
├─ src/bridge/                         # MCP bridge source (TypeScript)
│  ├─ index.ts  mcp-server.ts  codex-adapter.ts  worker-registry.ts
│  ├─ transcript-filter.ts  artifact-store.ts  worktree-manager.ts
│  └─ safety.ts  types.ts  config.ts  logger.ts
├─ scripts/
│  ├─ install.sh                       # one-line plugin install via the claude CLI
│  ├─ build.mjs                        # esbuild bundler
│  └─ smoke/e2e-worker.mjs             # end-to-end acceptance test
└─ docs/
   ├─ spec.md                          # original specification
   ├─ architecture.md · usage.md · development.md
   └─ codex-app-server-protocol.md     # adapter ground truth
```

## Build from source

```bash
npm install
npm run typecheck
npm run build      # esbuild bundle → plugins/codex-workers/dist/bridge.js
```

The bundled `dist/bridge.js` is committed so the plugin runs without an install step.

## Test

```bash
node scripts/smoke/e2e-worker.mjs   # starts a real read-only Codex worker; exits 0 on PASS
```

This drives the built bridge end-to-end through the MCP tools: start → poll → read messages
→ collect result → verify on-disk artifacts.

## Documentation

- [Architecture](docs/architecture.md) — layers, runtime, design decisions
- [Usage & examples](docs/usage.md) — orchestration patterns, MCP usage, prompt contract
- [Development](docs/development.md) — build, phases, regenerating protocol bindings
- [Codex app-server protocol](docs/codex-app-server-protocol.md) — adapter ground truth
- [Specification](docs/spec.md) — the original spec this project implements

## License

MIT
