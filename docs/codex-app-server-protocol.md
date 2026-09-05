# Codex App-Server Protocol — Ground Truth for the Bridge Adapter

This document records the **verified** behavior of `codex app-server` as observed
against Codex CLI **0.135.0** on linux. It is the single source of truth for
`src/bridge/codex-adapter.ts`. The exact generated TypeScript type bindings can be
regenerated from the installed Codex CLI with `codex app-server generate-ts --out
<dir>` (top-level + `v2/`) — grep them for precise field shapes. Treat this doc as
authoritative; treat generated types as reference. **The adapter must parse defensively** (Codex versions change;
unknown methods/fields must never crash the bridge).

## Transport

- Launch: `codex app-server` (no extra args needed; defaults to `stdio://`).
  Optionally pass `-c key=value` config overrides.
- Framing: **newline-delimited JSON** over stdio. Each JSON-RPC message is one
  line terminated by `\n`. This is NOT LSP Content-Length framing.
- Requests you send: `{"jsonrpc":"2.0","id":<number|string>,"method":"...","params":{...}}`.
  (The server tolerates a missing `jsonrpc` field on the way in, but always send it.)
- Responses from server: `{"id":<same id>,"result":{...}}` or `{"id":...,"error":{code,message,data?}}`.
  Note: responses observed WITHOUT a `jsonrpc` field — match on `id`.
- Notifications from server (no id): `{"method":"...","params":{...}}`.
- Server-initiated requests (approvals; have an `id` AND a `method`): you must reply
  with a `{"id":<their id>,"result":{...}}`.

### Distinguishing inbound messages
- Has `id` + `result`/`error`, no `method` → a **response** to one of your requests.
- Has `method`, no `id` → a **notification**.
- Has `method` AND `id` → a **server request** (approval / elicitation) you must answer.

## Handshake (verified)

1. Send `initialize`:
   ```json
   {"jsonrpc":"2.0","id":1,"method":"initialize",
    "params":{"clientInfo":{"name":"codex-workers","title":"Codex Workers for Claude","version":"<v>"},"capabilities":null}}
   ```
   Reply: `{"id":1,"result":{"userAgent":"...","codexHome":"...","platformFamily":"unix","platformOs":"linux"}}`
2. After initialize, the server proactively emits notifications such as
   `configWarning`, `remoteControl/status/changed`, `mcpServer/startupStatus/updated`.
   **Ignore unknown notifications.**
3. Send `thread/start` (see below) → get `threadId` from `result.thread.id`.
4. Send `turn/start` → get `turnId` from `result.turn.id`. Agent works; notifications stream.
5. Steer with `turn/steer`; interrupt with `turn/interrupt`; resume with `thread/resume`.

## Client → Server methods (the ones the adapter uses)

### `thread/start` → ThreadStartResponse
Params (all optional except none strictly required; we set cwd/sandbox/approvalPolicy/model):
```ts
{ cwd?: string, sandbox?: "read-only"|"workspace-write"|"danger-full-access",
  approvalPolicy?: AskForApproval, model?: string, baseInstructions?: string,
  developerInstructions?: string, ephemeral?: boolean, config?: Record<string,JsonValue> }
```
Response: `{ thread: { id, sessionId, path, cwd, status, ... }, model, modelProvider, sandbox, approvalPolicy, ... }`.
**threadId = result.thread.id** (a UUID, e.g. `019e75f9-6078-76b0-...`).
The thread's rollout file path is `result.thread.path` (useful for debugging/resume).

### `turn/start` → TurnStartResponse
```ts
{ threadId: string,
  input: Array<UserInput>,             // for text: [{ type:"text", text:"...", text_elements:[] }]
  cwd?: string, approvalPolicy?: AskForApproval, sandboxPolicy?: SandboxPolicy,
  model?: string, effort?: ReasoningEffort, outputSchema?: JsonValue }
```
Response: `{ turn: { id, items, status, ... } }`. **turnId = result.turn.id.**
NOTE: `turn/start` returns quickly with the turn id; the actual work streams as notifications
and ends with a `turn/completed` notification. Do NOT block on the response for completion.

### `turn/steer` → TurnSteerResponse
```ts
{ threadId: string, input: Array<UserInput>, expectedTurnId: string }
```
`expectedTurnId` is a precondition: the request fails if it is not the currently active turn.
Use this to inject a steering message into a RUNNING turn.

### `turn/interrupt` → TurnInterruptResponse
```ts
{ threadId: string, turnId: string }
```

### `thread/resume` → ThreadResumeResponse
```ts
{ threadId: string, cwd?, sandbox?, approvalPolicy?, model?, ... }
```
Resumes a previously-started thread (sessions persist under `~/.codex/sessions/...`).
Prefer resuming by `threadId`.

### Idle vs. new turn (for steering when idle)
When a worker is idle (previous turn completed), "steering" should be a fresh `turn/start`
on the same `threadId` (NOT `turn/steer`, which targets an active turn). The adapter must
expose both and the registry/tool layer decides which based on worker state.

### `UserInput` shape
```ts
type UserInput =
  | { type:"text", text:string, text_elements:[] }
  | { type:"image", url:string, detail? }
  | { type:"localImage", path:string, detail? }
  | { type:"skill", name:string, path:string }
  | { type:"mention", name:string, path:string };
```
For our purposes always use `{ type:"text", text, text_elements: [] }`.

### Enums
```ts
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type AskForApproval = "untrusted" | "on-failure" | "on-request" | "never" | { granular: {...} };
type ReasoningEffort = "none"|"minimal"|"low"|"medium"|"high"|"xhigh"; // codex 0.135; 0.153+ adds "max","ultra",… and accepts arbitrary strings
```
Spec maps: sandboxPolicy "read-only"|"workspace-write" → SandboxMode (same strings).
approvalPolicy "never"|"on-request" → AskForApproval (same strings).
effort → ReasoningEffort verbatim (same strings). The bridge forwards the
caller's string unchanged and lets Codex validate it, so the accepted set is
version-dependent: codex 0.135 enforced a strict ladder
"none"|"minimal"|"low"|"medium"|"high"|"xhigh" (ceiling "xhigh"; unknown values
rejected with "unknown variant"), while codex 0.153 expands it ("max", "ultra",
…) and accepts arbitrary effort strings at config load. Treat the engine, not
this doc, as authoritative.

## Server → Client notifications (method → meaning → normalized type)

| method | payload (key fields) | normalize to |
|---|---|---|
| `thread/started` | `{ thread }` | status |
| `thread/status/changed` | `{ threadId, status }` | status |
| `turn/started` | `{ threadId, turn }` | status |
| `turn/completed` | `{ threadId, turn }` | turn_completed |
| `turn/plan/updated` | `{ threadId, turnId, explanation, plan: TurnPlanStep[] }` | plan_update |
| `turn/diff/updated` | `{ threadId, turnId, diff: string }` | diff_available |
| `item/started` | `{ item: ThreadItem, threadId, turnId, startedAtMs }` | depends on item.type |
| `item/completed` | `{ item: ThreadItem, threadId, turnId, completedAtMs }` | depends on item.type |
| `item/agentMessage/delta` | `{ threadId, turnId, itemId, delta: string }` | agent_message_delta |
| `item/plan/delta` | `{ threadId, turnId, ... }` | plan_update |
| `item/commandExecution/outputDelta` | `{ ... , chunk }` | command_output |
| `command/exec/outputDelta` | `{ ... }` | command_output |
| `item/fileChange/patchUpdated` | `{ ... }` | file_changed |
| `item/fileChange/outputDelta` | `{ ... }` | file_changed |
| `item/reasoning/textDelta`, `.../summaryTextDelta`, `.../summaryPartAdded` | reasoning stream | status (low priority; usually drop) |
| `process/exited`, `process/outputDelta` | background process | command_* |
| `error` | `{ error: TurnError, willRetry, threadId, turnId }` | error |
| `configWarning`, `remoteControl/status/changed`, `mcpServer/startupStatus/updated`, `mcpServer/...`, `account/...`, `thread/tokenUsage/updated`, `skills/changed`, `hook/started`, `hook/completed`, etc. | misc | unknown (store raw, do not forward) |

### `ThreadItem` discriminated union (carried by `item/started` & `item/completed`)
```ts
type ThreadItem =
  | { type:"userMessage", id, content: UserInput[] }
  | { type:"agentMessage", id, text: string, phase, memoryCitation }   // <-- the assistant's message
  | { type:"plan", id, text: string }
  | { type:"reasoning", id, summary: string[], content: string[] }
  | { type:"commandExecution", id, command: string, cwd, processId, source,
      status: CommandExecutionStatus, commandActions, aggregatedOutput: string|null,
      exitCode: number|null, durationMs: number|null }
  | { type:"fileChange", id, changes: FileUpdateChange[], status: PatchApplyStatus }
  | { type:"mcpToolCall", ... } | { type:"dynamicToolCall", ... } | { type:"collabAgentToolCall", ... };
```
Normalization rules for items:
- `agentMessage` on `item/completed` → normalized `agent_message` (text = item.text). This is the
  primary "Codex said" message. (Deltas via `item/agentMessage/delta` are the streaming form;
  you can ignore deltas for the messages transcript and just use the completed item, OR accumulate
  deltas — completed item is simpler and authoritative.)
- `plan` item or `turn/plan/updated` → `plan_update`.
- `commandExecution` on `item/started` → `command_started` (text = the command).
- `commandExecution` on `item/completed` → `command_completed` (command, exitCode, durationMs;
  aggregatedOutput is the FULL output — store raw, summarize, do NOT forward by default).
- `fileChange` on `item/completed` → `file_changed` (changes = list of {path, ...}).
- `reasoning` → low value; map to `status` and generally drop from forwarded messages.

### Final message of a turn
The agent's final answer is the last `agentMessage` item completed before `turn/completed`.
The adapter should record the most recent completed `agentMessage` text as `finalMessage`
when `turn/completed` arrives.

## Server → Client requests (approvals — server sends a request WITH an id; you MUST respond)

Methods observed in the protocol (ServerRequest union):
- `execCommandApproval` / `item/commandExecution/requestApproval`
- `applyPatchApproval` / `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`
- `account/chatgptAuthTokens/refresh`, `attestation/generate` (infra — respond per generated schema)

Approval response shapes (regenerate the bindings with `codex app-server generate-ts --out <dir>` to inspect):
- `ExecCommandApprovalResponse`, `ApplyPatchApprovalResponse` etc. carry a decision such as
  `{ decision: "approved" | "approved_for_session" | "denied" | "abort" }` (grep the generated
  `*ApprovalResponse.ts` for the exact enum — do not guess; read the file).

Bridge policy for approvals (non-interactive — there is no human at the bridge):
- With `approvalPolicy: "never"` and `sandbox: "read-only"`, Codex should not request approvals.
- With `approvalPolicy: "on-request"` (write workers), Codex MAY send approval requests. The
  **safety layer** decides the response:
  - If the command/patch matches the destructive blocklist (rm -rf, git reset --hard, git clean -fd,
    git push, npm/pnpm publish, docker system prune, drop database, terraform apply, kubectl delete)
    → respond DENIED and record an `approval_request` event flagged as auto-denied.
  - Otherwise, within a worktree + workspace-write, respond APPROVED and record the event.
- Every approval request is forwarded to Claude as an `approval_request` normalized message AND
  stored raw, so Claude has visibility even though the bridge auto-decided.

## Errors / availability
- If `codex` is not on PATH or `codex login status` is not logged in, the adapter must fail fast:
  return `{ state:"failed", error:"Codex is unavailable", recovery:"Check that Codex CLI is installed and logged in (codex login)." }`.
- Detect login via `codex login status` (prints "Logged in using ChatGPT") or via app-server `getAuthStatus`.
- The app-server prints a stderr warning about bubblewrap when sandboxing prerequisites are missing;
  this is non-fatal (it uses bundled bubblewrap). Capture stderr to the worker error.log but do not treat as failure.

## Concurrency / lifecycle notes
- One `codex app-server` process can host multiple threads. The adapter MAY run one app-server
  process per worker (simpler isolation) OR one shared app-server multiplexing threads. Spec wants
  "one active Codex turn per worker"; simplest robust choice for the MVP is **one app-server child
  process per worker** (clean kill on interrupt, isolated stderr, no cross-talk). Document the choice.
- On `turn/interrupt`, send the interrupt, await the `turn/completed`/`error`, mark state `interrupted`,
  keep the child alive so the thread can be resumed/steered later (spec §20.4).
- Always pipe and persist ALL raw inbound lines to `events.ndjson` before any filtering.
