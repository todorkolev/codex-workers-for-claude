---
description: Start or manage Codex workers from Claude Code via the codex-workers MCP tools.
argument-hint: [task or worker instruction]
---

# Codex Worker

Start or manage Codex workers from Claude Code using the `codex-workers` MCP server tools.

Use this command when the user wants Codex to:
- investigate
- implement
- review
- debug
- compare alternatives
- act as an adversarial reviewer

## Request

$ARGUMENTS

## How to handle it

Use the `codex-workers` MCP tools:

- `codex_worker_start` — start a Codex worker on a scoped task.
- `codex_worker_read_messages` — read filtered Codex messages while it works.
- `codex_worker_steer` — steer the worker during or between turns.
- `codex_worker_status` — check worker state.
- `codex_worker_collect_result` — collect the current or final result with artifact paths.
- `codex_worker_interrupt` — interrupt an active worker.
- `codex_worker_debug_trace` — read raw debug events (debugging only).

Guidance:

1. Prefer message-plus-artifact mode (`transcriptMode: "messages_plus_artifacts"`). Use full debug mode (`transcriptMode: "full_events"` / `codex_worker_debug_trace` / `includeFullEvents: true`) only on request.
2. Use `read-only` sandbox with `approvalPolicy: "never"` for investigation, review, and planning.
3. Use `workspace-write` with `approvalPolicy: "on-request"` and `useWorktree: true` for implementation, refactor, and test-repair tasks. Never run two write workers in the same directory.
4. Give Codex an explicit, scoped task (Task / Scope / Out of Scope / Constraints / Output Required).
5. Read messages and steer while Codex works; interrupt if it goes off the rails.
6. Collect the result compactly and report: Codex conclusion, changed files, diff summary, tests run, risks, and recommended next step.

If no task is provided, ask the user what Codex should do, or report the status of existing workers with `codex_worker_status`.
