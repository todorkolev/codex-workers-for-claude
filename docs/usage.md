# Usage

How to drive Codex workers from Claude Code through the `codex-worker-bridge`
MCP tools. This covers an end-to-end workflow (spec §28), concrete tool calls
(spec §29), and the prompt contract every Codex task should follow (spec §30).

For installation and the tool reference, see the plugin
[README](../plugins/codex-workers/README.md). For internals, see
[architecture.md](./architecture.md).

## The seven tools at a glance

| Tool | Purpose |
|---|---|
| `codex_worker_start` | Start a Codex worker (thread + first turn). |
| `codex_worker_read_messages` | Read filtered Codex messages incrementally. |
| `codex_worker_steer` | Send a steering instruction (active turn or new turn). |
| `codex_worker_status` | Get worker state, counts, changed files. |
| `codex_worker_collect_result` | Collect compact result + artifact paths. |
| `codex_worker_interrupt` | Interrupt an active worker (logs preserved). |
| `codex_worker_debug_trace` | Read raw debug events (debugging only). |

Default operating mode: `transcriptMode: "messages_plus_artifacts"`,
`sandboxPolicy: "read-only"`, `approvalPolicy: "never"`, `waitFor: "started"`.

## Example workflow (spec §28)

User task:

```text
Fix flaky auth session tests and verify no regression.
```

Recommended orchestration — Claude stays the commander throughout:

```text
1. Claude planner subagent
   - inspect repo
   - identify likely files/tests
   - define precise Codex tasks

2. Codex worker A: investigation
   - read-only, no edits
   - find root cause

3. Codex worker B: implementation
   - isolated worktree, workspace-write
   - minimal patch

4. Claude reviewer subagent
   - review Codex B's diff
   - compare against Codex A's findings

5. Codex worker C: adversarial review
   - read-only
   - challenge the final patch

6. Claude main agent
   - reconcile findings
   - apply / keep / reject the patch
   - present the final result
```

The general pattern for any non-trivial task:

```text
investigate → implement → review → verify
```

Run investigation and adversarial review as read-only workers; run
implementation/refactor/test-repair as workspace-write workers in their own
worktrees. Keep Claude in the loop: read messages periodically and steer rather
than waiting for a single black-box final answer.

## Example MCP usage (spec §29)

### 1. Start an investigation worker (read-only)

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
  approvalPolicy: "never",
});
```

### 2. Read messages while it works

```ts
await codex_worker_read_messages({
  workerId: "auth-investigator",
  maxChars: 6000,
});
```

Use `sinceMessageId` (the previous call's `nextMessageId`) to page forward
without re-reading. When `truncated: true`, fall back to the artifact paths
instead of asking for more inline text.

### 3. Steer the worker

```ts
await codex_worker_steer({
  workerId: "auth-investigator",
  message: `
Focus specifically on session expiry and clock mocking.
Ignore unrelated refactors.
`,
});
```

If the worker is **running**, this injects a steering message into the active
turn; if it is **idle**, it starts a fresh turn in the same session; if it is
**completed**, it returns `accepted: false` with a reason.

### 4. Collect the result (compact)

```ts
await codex_worker_collect_result({
  workerId: "auth-investigator",
  includeMessages: true,
  includeDiffSummary: false,
  includeChangedFiles: false,
  includeCommandSummary: true,
});
```

The result is compact by default and always includes artifact paths. Request
`includeFullEvents: true` only when debugging.

### 5. Start an implementation worker (worktree + write)

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
  approvalPolicy: "on-request",
});
```

This creates `.worktrees/codex-auth-fix-impl` on branch
`codex/<run-id>/auth-fix-impl`. Review the resulting `diff.patch` before
applying it to the main tree.

### 6. Check status and interrupt if needed

```ts
await codex_worker_status({ workerId: "auth-fix-impl" });

// If it goes off-scope or runs too long:
await codex_worker_interrupt({
  workerId: "auth-fix-impl",
  reason: "Scope creep — pausing to re-plan.",
});
```

Interrupt preserves all logs, marks the worker `interrupted`, and keeps the
thread alive so it can be resumed or steered later.

### 7. Debugging only

```ts
await codex_worker_debug_trace({
  workerId: "auth-fix-impl",
  maxEvents: 50,
});
```

Returns raw normalized/raw events. Use only when a worker fails or behaves
unexpectedly — this is token-heavy.

## Prompt contract for Codex workers (spec §30)

Every Codex worker task should follow this structure. A precise, scoped prompt
is the single most effective steering tool you have.

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

### Worked example

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

## When to steer

Steer Codex when it:

- goes off-scope,
- starts broad refactors,
- misses an edge case,
- needs to focus on specific files or tests.

Useful steering messages:

```text
Focus only on the failing auth tests. Do not refactor unrelated code.

Stop editing and explain your current hypothesis.

Run only targeted tests first.

Prepare a minimal diff and pause before broad changes.
```

## Synthesizing Codex output for the main workflow

When you report a worker's results upward, distinguish clearly:

- what Codex **said**,
- what Claude **agrees with**,
- what Claude **rejects**,
- what should be **done next**.

For a returned worker summary, include: `workerId`, the task, Codex's
conclusion, changed files, diff summary, tests run, risks, and the recommended
next step. Do not hide Codex behind a black-box final response — keep its
messages visible and keep full traces in the artifacts.
