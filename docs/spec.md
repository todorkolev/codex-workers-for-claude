# Codex Workers for Claude — Implementation Specification

## 1. Purpose

**Codex Workers for Claude** is a Claude Code plugin that lets Claude Code use Codex as a persistent, steerable worker inside multi-agent workflows.

The target behavior is:

```text
Claude Code / Ultracode
  ├─ Claude subagent: planner
  ├─ Claude subagent: reviewer
  ├─ Claude subagent: verifier
  └─ Claude subagent: Codex commander
        ↔ Codex worker session
```

Claude remains the orchestrator. Codex acts as a worker. Claude can start Codex workers, read their messages, steer them, interrupt them, and collect results.

By default, Claude should receive only useful Codex messages and compact artifacts, not every raw tool log.

---

## 2. Product Name

```text
Codex Workers for Claude
```

Recommended package/plugin name:

```text
codex-workers
```

Recommended MCP server name:

```text
codex-worker-bridge
```

---

## 3. Core Concept

The system has three layers:

```text
Claude Code plugin
  └─ provides skills, agents, commands, and MCP config

Codex Worker Bridge
  └─ local MCP server that Claude Code talks to

Codex backend
  └─ Codex CLI / Codex App Server / persistent Codex sessions
```

Claude Code does not directly become Codex.

Instead:

```text
Claude = orchestrator / commander
Codex = worker
Plugin = Claude Code integration layer
MCP bridge = communication channel
```

---

## 4. Main Goals

### Must have

1. Distribute as a Claude Code plugin.
2. Installable directly from GitHub.
3. No npm publishing required.
4. Include a local MCP bridge bundled with the plugin.
5. Allow Claude to start one or more Codex workers.
6. Allow Claude to read Codex messages before the task finishes.
7. Allow Claude to steer Codex during or between turns.
8. Allow Claude to interrupt Codex.
9. Allow Claude to collect final result and artifacts.
10. Support multiple Codex workers.
11. Store full debug logs locally.
12. Send compact messages to Claude by default.

### Should have

1. Support isolated git worktrees for write-capable workers.
2. Support Claude Code Ultracode / dynamic workflows.
3. Provide a Codex commander subagent.
4. Provide a Claude Code skill for using Codex workers.
5. Support transcript modes:
   - messages only
   - messages plus artifacts
   - full debug events
6. Support resumable worker sessions.
7. Support compact command/test summaries.

### Non-goals

1. Do not replace Claude’s model with Codex.
2. Do not make Codex a hidden backend for Claude subagents.
3. Do not return only the final Codex message.
4. Do not stream all raw shell output into Claude by default.
5. Do not require users to install from npm.
6. Do not require an npm account for distribution.

---

## 5. Distribution Model

The project should be distributed as a **GitHub-hosted Claude Code plugin marketplace**.

Users install it with:

```text
/plugin marketplace add YOUR_GITHUB_USER/codex-workers-for-claude
/plugin install codex-workers@codex-workers
/reload-plugins
```

The GitHub repository should contain both:

1. The plugin marketplace definition.
2. The actual plugin implementation.

---

## 6. Repository Layout

Recommended layout:

```text
codex-workers-for-claude/
  .claude-plugin/
    marketplace.json

  plugins/
    codex-workers/
      .claude-plugin/
        plugin.json

      .mcp.json

      skills/
        codex-worker/
          SKILL.md

      agents/
        codex-commander.md

      commands/
        codex-worker.md

      bin/
        codex-workers-bridge

      dist/
        bridge.js

      README.md

  src/
    bridge/
      index.ts
      mcp-server.ts
      codex-adapter.ts
      worker-registry.ts
      transcript-filter.ts
      artifact-store.ts
      worktree-manager.ts
      safety.ts

  docs/
    architecture.md
    usage.md
    development.md
```

The plugin must be self-contained. After installation, Claude Code may copy the plugin to a plugin cache, so the plugin should not depend on files outside `plugins/codex-workers/`.

---

## 7. Marketplace Manifest

File:

```text
.claude-plugin/marketplace.json
```

Example:

```json
{
  "name": "codex-workers",
  "owner": {
    "name": "Codex Workers for Claude"
  },
  "plugins": [
    {
      "name": "codex-workers",
      "description": "Run Codex as steerable workers inside Claude Code workflows.",
      "source": "./plugins/codex-workers",
      "homepage": "https://github.com/YOUR_GITHUB_USER/codex-workers-for-claude",
      "repository": "https://github.com/YOUR_GITHUB_USER/codex-workers-for-claude",
      "license": "MIT"
    }
  ]
}
```

---

## 8. Plugin Manifest

File:

```text
plugins/codex-workers/.claude-plugin/plugin.json
```

Example:

```json
{
  "name": "codex-workers",
  "displayName": "Codex Workers for Claude",
  "description": "Use Codex as persistent steerable workers from Claude Code.",
  "author": {
    "name": "YOUR_NAME"
  },
  "homepage": "https://github.com/YOUR_GITHUB_USER/codex-workers-for-claude",
  "repository": "https://github.com/YOUR_GITHUB_USER/codex-workers-for-claude",
  "license": "MIT",
  "skills": "./skills",
  "agents": "./agents",
  "commands": "./commands",
  "mcpServers": "./.mcp.json"
}
```

---

## 9. MCP Configuration

File:

```text
plugins/codex-workers/.mcp.json
```

Recommended config:

```json
{
  "mcpServers": {
    "codex-workers": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/bridge.js"],
      "env": {
        "CODEX_WORKERS_PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT}",
        "CODEX_WORKERS_DATA": "${CLAUDE_PLUGIN_DATA}",
        "CODEX_WORKERS_PROJECT_DIR": "${CLAUDE_PROJECT_DIR}"
      }
    }
  }
}
```

Alternative using a wrapper script:

```json
{
  "mcpServers": {
    "codex-workers": {
      "command": "${CLAUDE_PLUGIN_ROOT}/bin/codex-workers-bridge",
      "args": [],
      "env": {
        "CODEX_WORKERS_PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT}",
        "CODEX_WORKERS_DATA": "${CLAUDE_PLUGIN_DATA}",
        "CODEX_WORKERS_PROJECT_DIR": "${CLAUDE_PROJECT_DIR}"
      }
    }
  }
}
```

---

## 10. User Requirements

The user should have these installed locally:

```text
- Claude Code
- Codex CLI
- Node.js
- Git
```

The user should be logged in to Codex:

```bash
codex login
```

The plugin should detect missing dependencies and return clear errors.

---

## 11. Runtime Architecture

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
  └─ MCP server: codex-worker-bridge
       │
       ├─ worker registry
       ├─ transcript filter
       ├─ artifact store
       ├─ worktree manager
       ├─ safety layer
       └─ Codex adapter
            │
            └─ Codex worker sessions
```

---

## 12. Transcript Modes

Implement three transcript modes:

```ts
type TranscriptMode =
  | "messages"
  | "messages_plus_artifacts"
  | "full_events";
```

### `messages`

Return only user-visible Codex messages.

Use for lightweight collaboration.

### `messages_plus_artifacts`

Default mode.

Return:

```text
- Codex messages
- final answer
- changed files
- diff summary
- command/test summary
- artifact paths
```

Do not include raw command output by default.

### `full_events`

Return full raw Codex events.

Use only for debugging.

This may be token-heavy.

---

## 13. Worker State

Each Codex worker has a stable `workerId`.

```ts
type WorkerState =
  | "created"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "idle"
  | "completed"
  | "interrupted"
  | "failed";
```

Each worker should track:

```ts
type WorkerRecord = {
  workerId: string;
  runId: string;
  threadId?: string;
  currentTurnId?: string;
  state: WorkerState;
  cwd: string;
  worktreePath?: string;
  transcriptMode: TranscriptMode;
  sandboxPolicy: "read-only" | "workspace-write";
  approvalPolicy: "never" | "on-request";
  createdAt: string;
  updatedAt: string;
  artifactPaths: {
    workerJson: string;
    eventsNdjson: string;
    messagesMd: string;
    resultJson: string;
    finalMd?: string;
    diffPatch?: string;
    changedFilesTxt?: string;
    commandSummaryMd?: string;
  };
};
```

---

## 14. Artifact Layout

Inside the active project:

```text
.codex-workers/
  runs/
    <run-id>/
      manifest.json
      workers/
        <worker-id>/
          worker.json
          events.ndjson
          messages.md
          result.json
          final.md
          diff.patch
          changed-files.txt
          command-summary.md
          error.log
```

Example:

```text
.codex-workers/runs/2026-05-30-001/workers/auth-fix/
  worker.json
  events.ndjson
  messages.md
  result.json
  final.md
  diff.patch
  changed-files.txt
```

---

## 15. MCP Tool: `codex_worker_start`

Start a Codex worker.

Input:

```ts
type CodexWorkerStartInput = {
  workerId: string;
  task: string;
  cwd?: string;
  useWorktree?: boolean;
  baseBranch?: string;
  transcriptMode?: "messages" | "messages_plus_artifacts" | "full_events";
  sandboxPolicy?: "read-only" | "workspace-write";
  approvalPolicy?: "never" | "on-request";
  model?: string;
  effort?: "low" | "medium" | "high";
  instructions?: string;
  timeoutMs?: number;
  waitFor?: "started" | "first_message" | "idle" | "completed";
};
```

Output:

```ts
type CodexWorkerStartOutput = {
  workerId: string;
  runId: string;
  threadId?: string;
  turnId?: string;
  state: WorkerState;
  cwd: string;
  worktreePath?: string;
  transcriptMode: TranscriptMode;
  messagesPath: string;
  eventsPath: string;
};
```

Behavior:

1. Validate `workerId`.
2. Create artifact directory.
3. Optionally create git worktree.
4. Start Codex worker session.
5. Start Codex turn with the task.
6. Begin consuming Codex output.
7. Store all raw events locally.
8. Store filtered messages separately.
9. Return worker metadata.

Default:

```ts
transcriptMode = "messages_plus_artifacts";
sandboxPolicy = "read-only";
approvalPolicy = "never";
waitFor = "started";
```

---

## 16. MCP Tool: `codex_worker_read_messages`

Read filtered Codex messages.

Input:

```ts
type CodexWorkerReadMessagesInput = {
  workerId: string;
  sinceMessageId?: string;
  maxMessages?: number;
  maxChars?: number;
};
```

Output:

```ts
type CodexWorkerReadMessagesOutput = {
  workerId: string;
  state: WorkerState;
  messages: Array<{
    id: string;
    timestamp: string;
    role: "codex";
    type: "message" | "plan" | "status" | "final" | "error";
    text: string;
  }>;
  nextMessageId?: string;
  truncated: boolean;
};
```

Rules:

1. Return filtered messages only.
2. Do not return raw shell output.
3. Respect `maxChars`.
4. Include `truncated: true` when clipping output.

---

## 17. MCP Tool: `codex_worker_steer`

Send a steering instruction to Codex.

Input:

```ts
type CodexWorkerSteerInput = {
  workerId: string;
  message: string;
  priority?: "normal" | "urgent";
};
```

Output:

```ts
type CodexWorkerSteerOutput = {
  workerId: string;
  accepted: boolean;
  state: WorkerState;
  turnId?: string;
  reason?: string;
};
```

Behavior:

1. If the worker is running, steer the active Codex turn.
2. If the worker is idle, start a new turn in the same worker session.
3. If the worker is completed, return `accepted: false`.
4. Store the steering instruction in worker metadata.

Example steering messages:

```text
Focus only on the failing auth tests. Do not refactor unrelated code.

Stop editing and explain your current hypothesis.

Run only targeted tests first.

Prepare a minimal diff and pause before broad changes.
```

---

## 18. MCP Tool: `codex_worker_status`

Get worker state.

Input:

```ts
type CodexWorkerStatusInput = {
  workerId: string;
};
```

Output:

```ts
type CodexWorkerStatusOutput = {
  workerId: string;
  state: WorkerState;
  runId: string;
  threadId?: string;
  currentTurnId?: string;
  cwd: string;
  worktreePath?: string;
  transcriptMode: TranscriptMode;
  messageCount: number;
  rawEventCount: number;
  changedFiles?: string[];
  lastMessageAt?: string;
  error?: string;
};
```

---

## 19. MCP Tool: `codex_worker_collect_result`

Collect the current or final worker result.

Input:

```ts
type CodexWorkerCollectResultInput = {
  workerId: string;
  includeMessages?: boolean;
  includeDiffSummary?: boolean;
  includeChangedFiles?: boolean;
  includeCommandSummary?: boolean;
  includeFullEvents?: boolean;
  maxChars?: number;
};
```

Output:

```ts
type CodexWorkerCollectResultOutput = {
  workerId: string;
  state: WorkerState;
  finalMessage?: string;
  messages?: string;
  changedFiles?: string[];
  diffSummary?: string;
  commandSummary?: string;
  artifactPaths: {
    workerJson: string;
    messagesMd: string;
    eventsNdjson: string;
    finalMd?: string;
    diffPatch?: string;
    changedFilesTxt?: string;
    commandSummaryMd?: string;
  };
  fullEvents?: unknown[];
  truncated: boolean;
};
```

Behavior:

1. Return compact result by default.
2. Always include artifact paths.
3. Include full events only if explicitly requested.
4. Truncate large results safely.

---

## 20. MCP Tool: `codex_worker_interrupt`

Interrupt an active worker.

Input:

```ts
type CodexWorkerInterruptInput = {
  workerId: string;
  reason?: string;
};
```

Output:

```ts
type CodexWorkerInterruptOutput = {
  workerId: string;
  interrupted: boolean;
  state: WorkerState;
};
```

Behavior:

1. Interrupt the active Codex turn.
2. Preserve logs.
3. Mark state as `interrupted`.
4. Allow later resume or steering if possible.

---

## 21. MCP Tool: `codex_worker_debug_trace`

Read raw debug events.

Input:

```ts
type CodexWorkerDebugTraceInput = {
  workerId: string;
  sinceEventId?: string;
  maxEvents?: number;
  maxChars?: number;
};
```

Output:

```ts
type CodexWorkerDebugTraceOutput = {
  workerId: string;
  events: unknown[];
  nextEventId?: string;
  eventsPath: string;
  truncated: boolean;
};
```

Use only for debugging.

---

## 22. Event Filtering

Normalize Codex output internally.

```ts
type NormalizedCodexEvent = {
  id: string;
  timestamp: string;
  workerId: string;
  threadId?: string;
  turnId?: string;
  rawType: string;
  normalizedType:
    | "agent_message_delta"
    | "agent_message"
    | "plan_update"
    | "status"
    | "command_started"
    | "command_output"
    | "command_completed"
    | "file_changed"
    | "diff_available"
    | "approval_request"
    | "turn_completed"
    | "error"
    | "unknown";
  text?: string;
  data?: unknown;
};
```

Forwarding rules:

| Event type | Store raw | Include in messages | Include in messages_plus_artifacts |
|---|---:|---:|---:|
| agent message | yes | yes | yes |
| plan update | yes | yes | yes |
| status | yes | maybe | yes |
| command started | yes | no | summary only |
| command output | yes | no | no |
| command completed | yes | no | summary only |
| file changed | yes | no | yes |
| diff available | yes | no | yes |
| approval request | yes | yes | yes |
| error | yes | yes | yes |
| turn completed | yes | yes | yes |

---

## 23. Command and Test Summaries

The bridge should summarize command activity without dumping logs.

Example:

```md
## Command Summary

- `npm test -- auth`: failed
  - likely issue: session expiry expectation mismatch
  - full output stored in `events.ndjson`

- `npm run typecheck`: passed
```

Raw command output should only be returned when:

```ts
includeFullEvents = true
```

or:

```ts
transcriptMode = "full_events"
```

---

## 24. Worktree Strategy

For write-capable Codex workers, use isolated git worktrees.

Recommended defaults:

| Task type | Worktree | Sandbox |
|---|---:|---|
| review | no | read-only |
| planning | no | read-only |
| investigation | optional | read-only |
| implementation | yes | workspace-write |
| refactor | yes | workspace-write |
| test repair | yes | workspace-write |

Worktree path:

```text
.worktrees/codex-<worker-id>
```

Branch name:

```text
codex/<run-id>/<worker-id>
```

Example:

```bash
git worktree add .worktrees/codex-auth-fix -b codex/2026-05-30-001/auth-fix
```

Rules:

1. Never allow two write workers in the same directory.
2. Prefer worktrees for any write-enabled Codex task.
3. Main Claude session should review the diff before applying it.
4. Worktrees should be easy to delete after the run.

---

## 25. Claude Code Skill

File:

```text
plugins/codex-workers/skills/codex-worker/SKILL.md
```

Suggested content:

```md
---
name: codex-worker
description: Use Codex as a persistent worker controlled by Claude. Use when Claude should delegate coding, review, debugging, or implementation work to Codex while retaining the ability to read Codex messages and steer it during execution.
---

Use the `codex-worker-bridge` MCP tools.

Default behavior:

1. Start Codex with `transcriptMode: "messages_plus_artifacts"`.
2. Use `read-only` sandbox for planning and review.
3. Use `workspace-write` only for implementation tasks.
4. Use a separate worktree for every write-capable Codex worker.
5. Read Codex messages periodically.
6. Steer Codex when:
   - it goes off-scope
   - it starts broad refactors
   - it misses an edge case
   - it needs to focus on specific files/tests
7. Collect final result with:
   - messages
   - changed files
   - diff summary
   - command summary
   - artifact paths

Do not request full raw Codex events unless debugging is required.

When summarizing Codex output, distinguish:
- what Codex said
- what Claude agrees with
- what Claude rejects
- what should be done next
```

---

## 26. Claude Commander Agent

File:

```text
plugins/codex-workers/agents/codex-commander.md
```

Suggested content:

```md
# Codex Commander

You control one or more Codex workers through the `codex-worker-bridge` MCP tools.

Your job is to:
1. define precise Codex tasks
2. start Codex workers
3. read Codex messages
4. steer Codex when needed
5. collect results
6. produce compact synthesis for the main Claude workflow

Default transcript mode:

```text
messages_plus_artifacts
```

Use full debug traces only if Codex fails or behaves unexpectedly.

For write tasks, always use isolated worktrees.

When returning results, include:
- workerId
- task
- Codex conclusion
- changed files
- diff summary
- tests run
- risks
- recommended next step
```

---

## 27. Optional Command

File:

```text
plugins/codex-workers/commands/codex-worker.md
```

Suggested purpose:

```md
# Codex Worker

Start or manage Codex workers from Claude Code.

Use this command when the user wants Codex to:
- investigate
- implement
- review
- debug
- compare alternatives
- act as an adversarial reviewer

Prefer message-plus-artifact mode.
Use full debug mode only on request.
```

---

## 28. Example Workflow

User task:

```text
Fix flaky auth session tests and verify no regression.
```

Recommended orchestration:

```text
1. Claude planner subagent
   - inspect repo
   - identify likely files/tests
   - define tasks

2. Codex worker A: investigation
   - read-only
   - find root cause
   - no edits

3. Codex worker B: implementation
   - isolated worktree
   - minimal patch

4. Claude reviewer subagent
   - review Codex B diff
   - compare against Codex A findings

5. Codex worker C: adversarial review
   - read-only
   - challenge final patch

6. Claude main agent
   - reconcile findings
   - apply/keep/reject patch
   - present final result
```

---

## 29. Example MCP Usage

Start an investigation worker:

```ts
await codex_worker_start({
  workerId: "auth-investigator",
  task: `
Investigate flaky auth session tests.
Do not edit files.
Focus on root cause and minimal fix strategy.

Return:
1. probable root cause
2. evidence
3. minimal fix strategy
4. uncertainty
`,
  transcriptMode: "messages_plus_artifacts",
  sandboxPolicy: "read-only",
  approvalPolicy: "never"
});
```

Read messages:

```ts
await codex_worker_read_messages({
  workerId: "auth-investigator",
  maxChars: 6000
});
```

Steer worker:

```ts
await codex_worker_steer({
  workerId: "auth-investigator",
  message: `
Focus specifically on session expiry and clock mocking.
Ignore unrelated refactors.
`
});
```

Collect result:

```ts
await codex_worker_collect_result({
  workerId: "auth-investigator",
  includeMessages: true,
  includeDiffSummary: false,
  includeChangedFiles: false,
  includeCommandSummary: true
});
```

Start implementation worker:

```ts
await codex_worker_start({
  workerId: "auth-fix-impl",
  task: `
Implement the minimal fix for the flaky auth session tests.
Use the findings from auth-investigator.
Keep the patch small.
Run only targeted tests unless necessary.
`,
  useWorktree: true,
  baseBranch: "main",
  transcriptMode: "messages_plus_artifacts",
  sandboxPolicy: "workspace-write",
  approvalPolicy: "on-request"
});
```

---

## 30. Prompt Contract for Codex Workers

Every Codex worker task should follow this structure:

```md
## Task

Clear instruction.

## Scope

Files, modules, or tests in scope.

## Out of Scope

What not to touch.

## Constraints

- Keep patch minimal.
- Do not refactor unrelated code.
- Do not modify public APIs unless necessary.
- Prefer targeted tests first.

## Output Required

Return:
1. Findings
2. Changes made or proposed
3. Tests run
4. Risks
5. Recommended next step
```

Example:

```md
## Task

Investigate why auth session expiry tests are flaky.

## Scope

- src/auth/**
- tests/auth/**
- test utilities related to fake timers or clock mocking

## Out of Scope

- UI changes
- unrelated auth refactors
- dependency upgrades

## Constraints

Do not edit files. Produce a root-cause analysis and minimal patch strategy.

## Output Required

Return:
1. probable root cause
2. evidence
3. minimal fix strategy
4. test coverage needed
5. uncertainty
```

---

## 31. Safety Rules

Default permissions:

```text
review/planning: read-only, approvalPolicy=never
implementation: workspace-write, approvalPolicy=on-request, isolated worktree
dangerous full access: disabled
```

Hard rules:

1. Never run destructive commands by default.
2. Never allow write mode in the main working tree if another agent is editing it.
3. Never allow multiple write workers in the same directory.
4. Always preserve full event logs locally.
5. Always expose artifact paths to Claude.
6. Always let Claude interrupt a worker.
7. Always keep Codex task scope explicit.

Commands requiring explicit approval or blocking:

```text
rm -rf
git reset --hard
git clean -fd
git push
npm publish
pnpm publish
docker system prune
drop database
terraform apply
kubectl delete
```

---

## 32. Error Handling

### Codex unavailable

Return:

```json
{
  "state": "failed",
  "error": "Codex is unavailable",
  "recovery": "Check that Codex CLI is installed and logged in."
}
```

### Worker timeout

Behavior:

1. Mark worker as failed or interrupted.
2. Preserve logs.
3. Return last messages and artifact paths.

### Steering rejected

Return:

```json
{
  "accepted": false,
  "reason": "Worker is completed"
}
```

### Large output

Return:

```json
{
  "truncated": true,
  "artifactPaths": {
    "messagesMd": "...",
    "eventsNdjson": "..."
  }
}
```

Never flood Claude context.

---

## 33. Concurrency Rules

The bridge should support:

```text
- multiple read-only workers in the same repo
- multiple write workers only in separate worktrees
- one active Codex turn per worker
- multiple workers per Claude workflow run
```

Recommended limits:

```ts
const limits = {
  maxWorkersPerRun: 16,
  maxWriteWorkersPerRun: 4,
  maxMessageCharsPerRead: 12000,
  maxRawEventCharsPerRead: 20000
};
```

---

## 34. Build Strategy

Use TypeScript internally, but bundle the bridge into a single JS file committed into the plugin directory.

Example build command:

```bash
esbuild src/bridge/index.ts \
  --bundle \
  --platform=node \
  --target=node20 \
  --outfile=plugins/codex-workers/dist/bridge.js
```

The distributed plugin should include:

```text
plugins/codex-workers/dist/bridge.js
```

This avoids requiring users to install your package from npm.

---

## 35. Development Phases

### Phase 1: Single Worker MVP

Implement:

```text
codex_worker_start
codex_worker_read_messages
codex_worker_steer
codex_worker_collect_result
```

Use read-only mode only.

Store:

```text
events.ndjson
messages.md
result.json
```

### Phase 2: Write Mode and Worktrees

Add:

```text
useWorktree
workspace-write
changed files
diff.patch
diff summary
```

Add safety rules.

### Phase 3: Multi-Worker Support

Add:

```text
worker registry
parallel workers
worker status
interrupt
per-run manifest
```

### Phase 4: Claude Code Plugin UX

Add:

```text
skills/codex-worker/SKILL.md
agents/codex-commander.md
commands/codex-worker.md
```

### Phase 5: Ultracode / Workflow Integration

Add example workflows:

```text
investigate → implement → review → verify
```

### Phase 6: Debug and Replay

Add:

```text
codex_worker_debug_trace
full_events mode
event replay
```

---

## 36. Acceptance Criteria

### MVP

1. User can install plugin from GitHub.
2. Claude Code loads the plugin.
3. MCP bridge starts successfully.
4. Claude can start a Codex worker.
5. Claude can read Codex messages before completion.
6. Claude can steer a worker.
7. Claude can collect final result.
8. Full raw logs are stored locally.
9. Default output is compact.
10. Large outputs are truncated with artifact paths.

### Full Scope

1. Claude Code can launch multiple Claude subagents.
2. Some Claude subagents can act as Codex commanders.
3. Multiple Codex workers can run in parallel.
4. Write workers use isolated worktrees.
5. Claude can interrupt workers.
6. Claude receives message-plus-artifact summaries.
7. Full debug events are available on demand.
8. Safety rules prevent destructive behavior by default.

---

## 37. Recommended Defaults

For review/planning:

```ts
{
  transcriptMode: "messages_plus_artifacts",
  sandboxPolicy: "read-only",
  approvalPolicy: "never",
  useWorktree: false
}
```

For implementation:

```ts
{
  transcriptMode: "messages_plus_artifacts",
  sandboxPolicy: "workspace-write",
  approvalPolicy: "on-request",
  useWorktree: true
}
```

For debugging:

```ts
{
  transcriptMode: "full_events"
}
```

---

## 38. Summary

The final system should work like this:

```text
Claude Code Ultracode = orchestrator
Claude subagents = planners, reviewers, verifiers, Codex commanders
Codex workers = persistent coding agents
MCP bridge = bidirectional control layer
Message transcript = default shared channel
Full events = optional debug trace
Worktrees = safe write isolation
GitHub plugin = distribution mechanism
```

The most important principle:

```text
Do not hide Codex behind a black-box final response.
Expose Codex messages continuously, allow Claude to steer, and keep full traces locally.
```