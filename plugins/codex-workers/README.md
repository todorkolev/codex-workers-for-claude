# Codex Workers for Claude

Run **Codex as persistent, steerable workers** inside Claude Code workflows.

Claude stays the orchestrator; Codex acts as a worker. Claude can start one or
more Codex workers, read their messages *before* they finish, steer them during
or between turns, interrupt them, and collect compact results — while every raw
event is preserved locally.

```text
Claude Code / Ultracode
  ├─ Claude subagent: planner
  ├─ Claude subagent: reviewer
  ├─ Claude subagent: verifier
  └─ Claude subagent: Codex commander
        ↔ Codex worker session
```

By default Claude receives only useful Codex messages and compact artifacts, not
every raw tool log.

## Requirements

Install these locally before using the plugin:

```text
- Claude Code
- Codex CLI   (logged in: `codex login`)
- Node.js 20+
- Git
```

The bridge detects missing dependencies and returns a clear error. If Codex is
not installed or not logged in, tools fail fast with:

```json
{
  "state": "failed",
  "error": "Codex is unavailable",
  "recovery": "Check that Codex CLI is installed and logged in (codex login)."
}
```

## Install

This is a GitHub-hosted Claude Code plugin marketplace — no npm publishing
required. From inside Claude Code:

```text
/plugin marketplace add todorkolev/codex-workers-for-claude
/plugin install codex-workers@codex-workers
/reload-plugins
```

The plugin ships a bundled MCP bridge (`dist/bridge.js`), a `codex-worker`
skill, a `codex-commander` agent, and a `codex-worker` command. After install,
Claude Code may copy the plugin into a plugin cache; it is fully self-contained
and depends on nothing outside `plugins/codex-workers/`.

## Quickstart

Ask Claude (or the `codex-commander` agent) to delegate work to Codex. A
typical read-only investigation:

```ts
// 1. Start a read-only investigation worker
await codex_worker_start({
  workerId: "auth-investigator",
  task: "Investigate flaky auth session tests. Do not edit files. Return root cause, evidence, minimal fix strategy, and uncertainty.",
  sandboxPolicy: "read-only",
  approvalPolicy: "never",
});

// 2. Read its messages as it works
await codex_worker_read_messages({ workerId: "auth-investigator", maxChars: 6000 });

// 3. Steer it if it drifts off-scope
await codex_worker_steer({
  workerId: "auth-investigator",
  message: "Focus on session expiry and clock mocking. Ignore unrelated refactors.",
});

// 4. Collect a compact result + artifact paths
await codex_worker_collect_result({
  workerId: "auth-investigator",
  includeMessages: true,
  includeCommandSummary: true,
});
```

For a write task, set `useWorktree: true`, `sandboxPolicy: "workspace-write"`,
and `approvalPolicy: "on-request"` so Codex runs in an isolated git worktree and
you can review its `diff.patch` before applying. See
[`docs/usage.md`](../../docs/usage.md) for the full investigate → implement →
review → verify workflow and the Codex prompt contract.

## The seven MCP tools

All tools are exposed by the `codex-worker-bridge` MCP server.

| Tool | What it does |
|---|---|
| `codex_worker_start` | Start a Codex worker (creates artifacts, optional worktree, starts a thread + first turn). Returns `workerId`, `runId`, `threadId`, `turnId`, `state`, paths. |
| `codex_worker_read_messages` | Read filtered Codex messages incrementally (`sinceMessageId`, `maxMessages`, `maxChars`). No raw shell output. Sets `truncated` when clipped. |
| `codex_worker_steer` | Send a steering instruction. Steers the active turn if running, starts a new turn if idle, rejects if completed. |
| `codex_worker_status` | Get state, `runId`, `threadId`, current turn, transcript mode, message/event counts, changed files, last message time, error. |
| `codex_worker_collect_result` | Collect a compact result: final message, optional messages/diff summary/changed files/command summary, and always the artifact paths. Full events only on request. |
| `codex_worker_interrupt` | Interrupt the active turn, preserve logs, mark `interrupted`; the thread stays resumable. |
| `codex_worker_debug_trace` | Read raw debug events (`sinceEventId`, `maxEvents`, `maxChars`). Debugging only; token-heavy. |

## Transcript modes

Control how much output is forwarded to Claude (the rest is always stored
locally):

| Mode | Returns |
|---|---|
| `messages` | Only user-visible Codex messages. Lightweight collaboration. |
| `messages_plus_artifacts` | **Default.** Messages, final answer, changed files, diff summary, command/test summary, artifact paths. No raw command output. |
| `full_events` | Full raw Codex events. Debugging only; token-heavy. |

Raw command output is returned only when `transcriptMode: "full_events"` or
`includeFullEvents: true` on `codex_worker_collect_result`.

## Artifacts

Everything is preserved under the active project so you can drill in without
flooding Claude's context:

```text
.codex-workers/runs/<run-id>/
  manifest.json
  workers/<worker-id>/
    worker.json  events.ndjson  messages.md  result.json
    final.md  diff.patch  changed-files.txt  command-summary.md  error.log
```

## Safety

Default permissions follow the recommended profiles:

```text
review / planning      → read-only,        approvalPolicy=never,      no worktree
implementation         → workspace-write,   approvalPolicy=on-request, isolated worktree
dangerous full access  → disabled
```

There is no human at the bridge, so approval requests are decided
programmatically. The bridge **auto-denies** any command/patch matching the
destructive blocklist and **auto-approves** safe operations inside a worktree —
forwarding every approval request to Claude for visibility and storing it raw.

Blocked / approval-required commands:

```text
rm -rf            git reset --hard   git clean -fd      git push
npm publish       pnpm publish       docker system prune
drop database     terraform apply    kubectl delete
```

Hard rules: never run destructive commands by default; never allow write mode in
the main tree while another agent edits it; never allow two write workers in the
same directory; always preserve full event logs locally; always expose artifact
paths; always let Claude interrupt a worker; always keep Codex task scope
explicit.

## Build from source

The bridge is TypeScript bundled into a single committed file, so users never
need to `npm install`. To rebuild after changing `src/bridge/`:

```bash
npm install
npm run typecheck
npm run build      # esbuild → plugins/codex-workers/dist/bridge.js
```

`dist/bridge.js` is committed on purpose (it is not git-ignored). See
[`docs/development.md`](../../docs/development.md) for the full build,
type-check, and binding-regeneration workflow, and
[`docs/architecture.md`](../../docs/architecture.md) for the runtime design.

## License

MIT.
