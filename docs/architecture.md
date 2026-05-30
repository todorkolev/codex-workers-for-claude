# Architecture

This document describes the runtime architecture of **Codex Workers for Claude**
(spec §3, §11) and how the MCP bridge talks to Codex via the
`codex app-server` protocol. The protocol is documented separately and is the
ground truth for the adapter:
[`codex-app-server-protocol.md`](./codex-app-server-protocol.md).

## 1. The three layers (spec §3)

```text
Claude Code plugin
  └─ provides skills, agents, commands, and MCP config

Codex Worker Bridge   (MCP server name: codex-worker-bridge)
  └─ local MCP server that Claude Code talks to over stdio

Codex backend
  └─ one `codex app-server` child process per worker
```

Claude Code stays the **orchestrator / commander**. Codex is the **worker**.
Claude never *becomes* Codex; it starts Codex workers, reads their messages,
steers them, interrupts them, and collects results. By default Claude receives
only useful Codex messages and compact artifacts — never every raw tool log.

## 2. Runtime topology (spec §11)

```text
Claude Code main session
  │
  ├─ Ultracode / dynamic workflow
  │
  ├─ Claude subagents
  │    ├─ planner
  │    ├─ reviewer
  │    ├─ verifier
  │    └─ codex-commander
  │
  └─ MCP server: codex-worker-bridge          (src/bridge/, bundled to dist/bridge.js)
       │
       ├─ MCP server          (mcp-server.ts)   — tool registration + dispatch
       ├─ worker registry     (worker-registry.ts)
       ├─ transcript filter   (transcript-filter.ts)
       ├─ artifact store      (artifact-store.ts)
       ├─ worktree manager    (worktree-manager.ts)
       ├─ safety layer        (safety.ts)
       └─ Codex adapter       (codex-adapter.ts)
            │
            └─ `codex app-server` child  ──►  Codex worker thread + turns
```

The bridge entry point is `src/bridge/index.ts`. Supporting modules:
`config.ts` (env-resolved configuration, spec §9/§14), `logger.ts`
(stderr-only logging), and `types.ts` (the shared type contract — names match
the spec verbatim).

## 3. Process model: one app-server per worker

A single `codex app-server` process can host multiple threads, but the bridge
runs **one `codex app-server` child process per worker**, each owning exactly
**one Codex thread**. This is the simplest robust choice and is what the
protocol doc recommends:

- clean kill on interrupt (no cross-talk between workers),
- isolated stderr per worker (bubblewrap warnings, etc.),
- a natural fit for the spec rule "one active Codex turn per worker" (§33).

The `CodexAdapter` interface (`src/bridge/types.ts`) encapsulates exactly one
child and one thread. Concurrency across workers is handled by the worker
registry, not by multiplexing threads inside a single adapter.

## 4. Transport and message handling

The adapter speaks **newline-delimited JSON-RPC over stdio** to the child — one
JSON object per line, terminated by `\n` (NOT LSP `Content-Length` framing).
See the protocol doc "Transport" for the exact framing rules. Inbound messages
are classified defensively:

| Shape | Meaning | Adapter action |
|---|---|---|
| has `id` + `result`/`error`, no `method` | response to one of our requests | resolve the pending request |
| has `method`, no `id` | notification | normalize + forward to subscribers |
| has `method` **and** `id` | server request (approval/elicitation) | answer with `{ id, result }` |

Defensive parsing is mandatory: Codex versions change, so **unknown methods and
unknown fields must never crash the bridge** (spec rule; protocol doc intro).
Every raw inbound line is persisted to `events.ndjson` *before* any filtering
(protocol doc "Always pipe and persist ALL raw inbound lines").

### Handshake and lifecycle (protocol doc "Handshake")

```text
initialize → thread/start → turn/start → (stream notifications) → turn/completed
                                  │
            turn/steer (active) ──┘   turn/interrupt   thread/resume
```

1. `initialize` — exchange client/server info.
2. `thread/start` → `threadId = result.thread.id`.
3. `turn/start` → `turnId = result.turn.id`. Returns quickly; the actual work
   streams as notifications and ends with a `turn/completed` notification. The
   adapter must **not** block on the `turn/start` response for completion.
4. Steer a running turn with `turn/steer` (precondition: `expectedTurnId` must
   be the active turn). Steer an **idle** worker by starting a fresh
   `turn/start` on the same `threadId` (see §6 below).
5. `turn/interrupt` to stop; `thread/resume` to continue a persisted thread.

## 5. Event normalization and transcript filtering (spec §12, §22, §23)

The transcript filter is pure and synchronous (no I/O). It maps each raw Codex
message to a `NormalizedCodexEvent` with a stable `normalizedType`, then applies
the §22 forwarding table per transcript mode:

```text
agent message      → messages, messages_plus_artifacts (the primary "Codex said")
plan update        → messages, messages_plus_artifacts
status             → messages_plus_artifacts (maybe in messages)
command started    → summary only in messages_plus_artifacts
command output     → never forwarded by default (stored raw)
command completed  → summary only in messages_plus_artifacts
file changed       → messages_plus_artifacts
diff available     → messages_plus_artifacts
approval request   → always forwarded (Claude visibility) + stored raw
error              → always forwarded
turn completed     → always forwarded
```

Key normalization rules (protocol doc "ThreadItem"):

- `agentMessage` on `item/completed` → `agent_message` (`text = item.text`).
  The agent's final answer is the last completed `agentMessage` before
  `turn/completed`; the adapter records it as `lastFinalMessage`.
- `commandExecution` `item/started` → `command_started`; `item/completed` →
  `command_completed`. `aggregatedOutput` is the FULL output — stored raw and
  summarized, **never** forwarded by default.
- `fileChange` `item/completed` → `file_changed`.
- `reasoning` deltas → `status`, generally dropped from forwarded messages.

Command activity is summarized rather than dumped (spec §23). Raw command output
is returned to Claude only when `transcriptMode = "full_events"` or
`includeFullEvents = true`.

The three transcript modes (spec §12):

- `messages` — only user-visible Codex messages (lightweight collaboration).
- `messages_plus_artifacts` — **default**: messages, final answer, changed files,
  diff summary, command/test summary, artifact paths (no raw command output).
- `full_events` — full raw Codex events (debugging only; token-heavy).

## 6. Steering: active turn vs. idle worker

Steering depends on worker state (protocol doc "Idle vs. new turn"):

- **running** → `turn/steer` against the active turn (`expectedTurnId`).
- **idle** (previous turn completed) → a fresh `turn/start` on the same thread.
- **completed** → reject with `accepted: false` (spec §17.3, §32).

The tool layer inspects worker state and the registry to pick the right adapter
call; the adapter exposes both `steerTurn` and `startTurnIfIdle`.

## 7. Worker state machine (spec §13)

```text
created → starting → running ──► idle ──► (steer) running
                        │  │        │
                        │  └─► waiting_for_approval ─► running
                        │
                        ├─► completed
                        ├─► interrupted   (turn/interrupt; thread kept alive for resume)
                        └─► failed        (Codex unavailable / error / timeout)
```

The registry owns state transitions and enforces them; it also refreshes
`updatedAt` on every patch. `waitFor` on `codex_worker_start`
(`started | first_message | idle | completed`) controls how long the start tool
blocks before returning.

## 8. Artifact store (spec §14)

All raw and filtered output is persisted under the active project:

```text
.codex-workers/
  runs/<run-id>/
    manifest.json
    workers/<worker-id>/
      worker.json          # WorkerRecord snapshot
      events.ndjson        # every raw inbound line (written before filtering)
      messages.md          # filtered, forwarded messages
      result.json          # structured result
      final.md             # agent's final answer
      diff.patch           # unified diff (write workers)
      changed-files.txt
      command-summary.md   # §23 compact command/test summary
      error.log            # stderr + bridge errors (non-fatal warnings too)
```

The artifact base is `<CLAUDE_PROJECT_DIR>/.codex-workers` (see `config.ts`).
Every tool result exposes artifact paths so Claude can drill in without flooding
its context (spec §32 "Large output").

## 9. Worktree manager (spec §24)

Write-capable workers run in isolated git worktrees so the main working tree is
never edited under another agent. Path `.worktrees/codex-<worker-id>`, branch
`codex/<run-id>/<worker-id>`:

```bash
git worktree add .worktrees/codex-auth-fix -b codex/2026-05-30-001/auth-fix
```

Rules: never two write workers in the same directory; prefer worktrees for any
write-enabled task; Claude reviews the diff before applying it; worktrees are
easy to delete after the run.

## 10. Safety layer (spec §31; protocol doc "Server → Client requests")

There is **no human at the bridge**, so approvals are decided programmatically:

- `approvalPolicy: "never"` + `sandbox: "read-only"` → Codex should not request
  approvals at all.
- `approvalPolicy: "on-request"` (write workers) → Codex MAY send approval
  requests (`execCommandApproval`, `applyPatchApproval`, etc.). The safety layer:
  - **denies** anything matching the destructive blocklist (`rm -rf`,
    `git reset --hard`, `git clean -fd`, `git push`, `npm`/`pnpm publish`,
    `docker system prune`, `drop database`, `terraform apply`, `kubectl delete`)
    and records an auto-denied `approval_request` event;
  - otherwise **approves** within a worktree + workspace-write.
- Every approval request is forwarded to Claude as an `approval_request` message
  *and* stored raw, so Claude has visibility even though the bridge auto-decided.

The exact decision-string enum is read from the generated
`*ApprovalResponse.ts` bindings (regenerate with `codex app-server generate-ts --out <dir>`) —
never guessed.

## 11. Concurrency limits (spec §33)

Enforced by the worker registry:

```ts
const limits = {
  maxWorkersPerRun: 16,
  maxWriteWorkersPerRun: 4,
  maxMessageCharsPerRead: 12000,
  maxRawEventCharsPerRead: 20000,
};
```

Multiple read-only workers may share a repo; multiple write workers are allowed
only in separate worktrees; one active turn per worker; many workers per run.

## 12. stdout discipline

The bridge process speaks the **MCP protocol over stdout**. Nothing else may
ever be written there. All diagnostics go to stderr via `logger.ts`, and each
worker's stderr from its `codex app-server` child is captured to that worker's
`error.log` (bubblewrap warnings are non-fatal; see protocol doc
"Errors / availability").
