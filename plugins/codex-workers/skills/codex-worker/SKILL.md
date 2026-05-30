---
name: codex-worker
description: Use Codex as a persistent worker controlled by Claude. Use when Claude should delegate coding, review, debugging, or implementation work to Codex while retaining the ability to read Codex messages and steer it during execution.
---

Use the `codex-workers` MCP server tools to run Codex as a steerable worker. Claude stays the orchestrator; Codex is the worker.

## Tools

- `codex_worker_start` — start a Codex worker on a task.
- `codex_worker_read_messages` — read filtered Codex messages while it works.
- `codex_worker_steer` — send a steering instruction during or between turns.
- `codex_worker_status` — check worker state, message/event counts, and changed files.
- `codex_worker_collect_result` — collect the current or final result plus artifact paths.
- `codex_worker_interrupt` — interrupt an active worker.
- `codex_worker_debug_trace` — read raw debug events (debugging only).

## Default behavior

1. Start Codex with `transcriptMode: "messages_plus_artifacts"`.
2. Use `read-only` sandbox for planning and review.
3. Use `workspace-write` only for implementation tasks.
4. Use a separate worktree for every write-capable Codex worker (`useWorktree: true`).
5. Read Codex messages periodically with `codex_worker_read_messages`.
6. Steer Codex when:
   - it goes off-scope
   - it starts broad refactors
   - it misses an edge case
   - it needs to focus on specific files/tests
7. Collect final result with `codex_worker_collect_result`, including:
   - messages
   - changed files
   - diff summary
   - command summary
   - artifact paths

Do not request full raw Codex events unless debugging is required. Prefer `codex_worker_read_messages` and `codex_worker_collect_result` over `codex_worker_debug_trace`. Reserve `transcriptMode: "full_events"` and `includeFullEvents: true` for when Codex fails or behaves unexpectedly.

## Recommended defaults

For review / planning:

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

## Task prompt contract

Give every Codex worker an explicit, scoped task:

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
1. Findings
2. Changes made or proposed
3. Tests run
4. Risks
5. Recommended next step
```

## Synthesizing Codex output

When summarizing Codex output for the main Claude workflow, distinguish:
- what Codex said
- what Claude agrees with
- what Claude rejects
- what should be done next

## Safety

- Never let a write worker run in a directory another agent is editing; never run two write workers in the same directory.
- Always keep Codex task scope explicit, preserve the full event logs locally, and expose artifact paths to Claude.
- Always be ready to `codex_worker_interrupt` a worker that goes off the rails.
