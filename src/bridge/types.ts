/**
 * Shared type contract for the Codex Workers bridge.
 *
 * This is the single source of truth every other bridge module compiles
 * against. Type NAMES here intentionally match `docs/spec.md` verbatim
 * (§12–§22, §33) and the service INTERFACES describe the seams between the
 * adapter, registry, filter, artifact store, worktree manager, and safety
 * layer (§11).
 *
 * Local-import convention (bundler moduleResolution + esbuild): import without
 * file extensions, e.g. `import { WorkerRecord } from "./types";`.
 */

/* ────────────────────────────────────────────────────────────────────────
 * §12 — Transcript modes
 * ──────────────────────────────────────────────────────────────────────── */

/** Spec §12. Controls how much of a worker's output is forwarded to Claude. */
export type TranscriptMode =
  | "messages"
  | "messages_plus_artifacts"
  | "full_events";

/* ────────────────────────────────────────────────────────────────────────
 * §13 — Worker state + record
 * ──────────────────────────────────────────────────────────────────────── */

/** Spec §13. Lifecycle state of a single Codex worker. */
export type WorkerState =
  | "created"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "idle"
  | "completed"
  | "interrupted"
  | "failed";

/** Spec §13/§14. Absolute paths to a worker's on-disk artifacts. */
export type WorkerArtifactPaths = {
  workerJson: string;
  eventsNdjson: string;
  messagesMd: string;
  resultJson: string;
  finalMd?: string;
  diffPatch?: string;
  changedFilesTxt?: string;
  commandSummaryMd?: string;
};

/** Spec §13. Full tracked state for one Codex worker. */
export type WorkerRecord = {
  workerId: string;
  runId: string;
  threadId?: string;
  currentTurnId?: string;
  state: WorkerState;
  cwd: string;
  worktreePath?: string;
  transcriptMode: TranscriptMode;
  sandboxPolicy: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "never" | "on-request";
  createdAt: string;
  updatedAt: string;
  artifactPaths: WorkerArtifactPaths;
};

/* ────────────────────────────────────────────────────────────────────────
 * §22 — Normalized Codex event
 * ──────────────────────────────────────────────────────────────────────── */

/** Spec §22. The internal, version-stable shape of a single Codex event. */
export type NormalizedCodexEventType =
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

/** Spec §22. Codex output normalized for storage, filtering, and rendering. */
export type NormalizedCodexEvent = {
  id: string;
  timestamp: string;
  workerId: string;
  threadId?: string;
  turnId?: string;
  rawType: string;
  normalizedType: NormalizedCodexEventType;
  text?: string;
  data?: unknown;
};

/* ────────────────────────────────────────────────────────────────────────
 * §15 — codex_worker_start
 * ──────────────────────────────────────────────────────────────────────── */

/** Spec §15. Input to `codex_worker_start`. */
export type CodexWorkerStartInput = {
  workerId: string;
  task: string;
  cwd?: string;
  /**
   * true: the bridge creates a fresh worktree + branch for the worker.
   * false (with cwd): bring your own directory; the bridge uses it as-is.
   * Do NOT pass true for a directory/branch you pre-created — git rejects the
   * duplicate branch ("a branch named ... already exists").
   */
  useWorktree?: boolean;
  baseBranch?: string;
  transcriptMode?: "messages" | "messages_plus_artifacts" | "full_events";
  /**
   * Sandbox policy for the Codex worker. Defaults to "read-only".
   * "workspace-write" allows edits within the working dir/worktree.
   * "danger-full-access" runs Codex UNSANDBOXED with full host access and no
   * command approval — opt-in ONLY (never a default), intended for environments
   * where the Codex sandbox (bwrap/namespaces) cannot initialize. See §31.
   */
  sandboxPolicy?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "never" | "on-request";
  model?: string;
  /**
   * Codex reasoning effort, forwarded verbatim to `turn/start`. The bridge does
   * NOT gate the value — the engine validates it — so it tracks whatever your
   * codex version accepts and grows with the engine. The accepted set is
   * version-dependent: codex 0.135 was strict
   * ("none"|"minimal"|"low"|"medium"|"high"|"xhigh", ceiling "xhigh"); codex
   * 0.153 expands it ("max", "ultra", …) and accepts arbitrary strings. Omit to
   * let the Codex config's `model_reasoning_effort` decide.
   */
  effort?: string;
  instructions?: string;
  timeoutMs?: number;
  waitFor?: "started" | "first_message" | "idle" | "completed";
};

/** Spec §15. Output of `codex_worker_start`. */
export type CodexWorkerStartOutput = {
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

/* ────────────────────────────────────────────────────────────────────────
 * §16 — codex_worker_read_messages
 * ──────────────────────────────────────────────────────────────────────── */

/** Spec §16. Input to `codex_worker_read_messages`. */
export type CodexWorkerReadMessagesInput = {
  workerId: string;
  sinceMessageId?: string;
  maxMessages?: number;
  maxChars?: number;
};

/** Spec §16. A single filtered message forwarded to Claude. */
export type CodexWorkerMessage = {
  id: string;
  timestamp: string;
  role: "codex";
  type: "message" | "plan" | "status" | "final" | "error";
  text: string;
};

/** Spec §16. Output of `codex_worker_read_messages`. */
export type CodexWorkerReadMessagesOutput = {
  workerId: string;
  state: WorkerState;
  messages: CodexWorkerMessage[];
  nextMessageId?: string;
  truncated: boolean;
};

/* ────────────────────────────────────────────────────────────────────────
 * §17 — codex_worker_steer
 * ──────────────────────────────────────────────────────────────────────── */

/** Spec §17. Input to `codex_worker_steer`. */
export type CodexWorkerSteerInput = {
  workerId: string;
  message: string;
  priority?: "normal" | "urgent";
};

/** Spec §17. Output of `codex_worker_steer`. */
export type CodexWorkerSteerOutput = {
  workerId: string;
  accepted: boolean;
  state: WorkerState;
  turnId?: string;
  reason?: string;
};

/* ────────────────────────────────────────────────────────────────────────
 * §18 — codex_worker_status
 * ──────────────────────────────────────────────────────────────────────── */

/** Spec §18. Input to `codex_worker_status`. */
export type CodexWorkerStatusInput = {
  workerId: string;
};

/** Spec §18. Output of `codex_worker_status`. */
export type CodexWorkerStatusOutput = {
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

/* ────────────────────────────────────────────────────────────────────────
 * §19 — codex_worker_collect_result
 * ──────────────────────────────────────────────────────────────────────── */

/** Spec §19. Input to `codex_worker_collect_result`. */
export type CodexWorkerCollectResultInput = {
  workerId: string;
  includeMessages?: boolean;
  includeDiffSummary?: boolean;
  includeChangedFiles?: boolean;
  includeCommandSummary?: boolean;
  includeFullEvents?: boolean;
  maxChars?: number;
};

/** Spec §19. Output of `codex_worker_collect_result`. */
export type CodexWorkerCollectResultOutput = {
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

/* ────────────────────────────────────────────────────────────────────────
 * §20 — codex_worker_interrupt
 * ──────────────────────────────────────────────────────────────────────── */

/** Spec §20. Input to `codex_worker_interrupt`. */
export type CodexWorkerInterruptInput = {
  workerId: string;
  reason?: string;
};

/** Spec §20. Output of `codex_worker_interrupt`. */
export type CodexWorkerInterruptOutput = {
  workerId: string;
  interrupted: boolean;
  state: WorkerState;
};

/* ────────────────────────────────────────────────────────────────────────
 * §21 — codex_worker_debug_trace
 * ──────────────────────────────────────────────────────────────────────── */

/** Spec §21. Input to `codex_worker_debug_trace`. */
export type CodexWorkerDebugTraceInput = {
  workerId: string;
  sinceEventId?: string;
  maxEvents?: number;
  maxChars?: number;
};

/** Spec §21. Output of `codex_worker_debug_trace`. */
export type CodexWorkerDebugTraceOutput = {
  workerId: string;
  events: unknown[];
  nextEventId?: string;
  eventsPath: string;
  truncated: boolean;
};

/* ────────────────────────────────────────────────────────────────────────
 * §33 — Concurrency / size limits
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Spec §33. Size limits shared across the bridge.
 *
 * Note: there is intentionally NO cap on the number of workers (or write
 * workers) launched in parallel. Concurrency is bounded only by the §24/§31
 * single-writer-per-directory rule (two writers may never share a directory),
 * which is a correctness guarantee, not a count limit.
 */
export const limits = {
  maxMessageCharsPerRead: 12000,
  maxRawEventCharsPerRead: 20000,
} as const;

export type Limits = typeof limits;

/* ════════════════════════════════════════════════════════════════════════
 * Service interfaces (the seams between bridge modules, §11)
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Options for starting or resuming a Codex thread on the adapter's child
 * `codex app-server` process. Mirrors `thread/start` params
 * (see docs/codex-app-server-protocol.md "thread/start").
 */
export type AdapterThreadOptions = {
  cwd: string;
  sandboxPolicy: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "never" | "on-request";
  model?: string;
  /** Reasoning effort forwarded verbatim to `turn/start`; see CodexWorkerStartInput.effort. */
  effort?: string;
  /** Extra base/developer instructions appended to the worker prompt contract. */
  instructions?: string;
};

/**
 * A server-initiated request from Codex that the bridge MUST answer with a
 * matching `{ id, result }`. Approval requests carry BOTH `method` and `id`
 * (see protocol doc "Server → Client requests"). The adapter forwards the raw
 * shape; the safety layer decides the response.
 */
export type CodexServerRequest = {
  id: number | string;
  method: string;
  params?: unknown;
};

/**
 * Owns exactly ONE `codex app-server` child process and ONE thread (spec §33:
 * "one active Codex turn per worker"; protocol doc: one app-server child per
 * worker for clean isolation). Parses inbound newline-delimited JSON-RPC
 * defensively — unknown methods/fields must never throw.
 *
 * See docs/codex-app-server-protocol.md for every wire shape referenced here.
 */
export interface CodexAdapter {
  /** Spawn the child, perform the `initialize` handshake. */
  init(): Promise<void>;

  /** `thread/start` → returns `threadId` (result.thread.id). */
  startThread(opts: AdapterThreadOptions): Promise<string>;

  /** `turn/start` with `{ type:"text", text }` → returns `turnId`. */
  startTurn(text: string): Promise<string>;

  /**
   * `turn/steer` against a RUNNING turn. `expectedTurnId` is a precondition;
   * the call rejects if it is not the active turn.
   */
  steerTurn(text: string, expectedTurnId: string): Promise<void>;

  /**
   * Steer when idle: starts a fresh `turn/start` on the existing thread and
   * returns the new `turnId`. Used by the tool layer when the worker is idle
   * (a real `turn/steer` would fail without an active turn).
   */
  startTurnIfIdle(text: string): Promise<string>;

  /** `turn/interrupt` against the active turn; awaits turn end. */
  interruptTurn(): Promise<void>;

  /** `thread/resume` for a previously-started thread. */
  resumeThread(threadId: string, opts: AdapterThreadOptions): Promise<void>;

  /** Subscribe to every raw inbound JSON-RPC message (responses + notifications). */
  onRawMessage(cb: (msg: unknown) => void): void;

  /** Subscribe to server-initiated requests (approvals) that need a `respond`. */
  onServerRequest(cb: (req: CodexServerRequest) => void): void;

  /** Subscribe to raw stderr lines from the child (warnings, bubblewrap notes). */
  onStderr(cb: (line: string) => void): void;

  /** Answer a server-initiated request with `{ id, result }`. */
  respond(id: number | string, result: unknown): void;

  /**
   * Answer a server-initiated request with a JSON-RPC `{ id, error }`. Used to
   * fail-closed on server requests the bridge does not implement (infra /
   * elicitation), so Codex can fall back rather than receive a fabricated body.
   */
  respondError(id: number | string, code: number, message: string): void;

  /** Kill the child process and release resources. */
  dispose(): Promise<void>;

  /** Current Codex thread id, if a thread has been started. */
  readonly threadId: string | undefined;

  /** Current active turn id, if a turn is in flight. */
  readonly turnId: string | undefined;

  /** Text of the most recent completed `agentMessage` before `turn/completed`. */
  readonly lastFinalMessage: string | undefined;
}

/** Availability probe result for the Codex CLI (spec §32). */
export type CodexAvailability = {
  available: boolean;
  error?: string;
  recovery?: string;
};

/**
 * Fail-fast check that the Codex CLI is installed and logged in (spec §32,
 * protocol doc "Errors / availability"). Never throws.
 */
export type CheckCodexAvailable = () => Promise<CodexAvailability>;

/** Context needed to normalize a raw Codex message into a {@link NormalizedCodexEvent}. */
export type NormalizeContext = {
  workerId: string;
  threadId?: string;
  turnId?: string;
};

/** A single rendered transcript line (subset of {@link CodexWorkerMessage}). */
export type RenderedMessage = {
  id: string;
  timestamp: string;
  role: "codex";
  type: CodexWorkerMessage["type"];
  text: string;
};

/**
 * Normalizes raw Codex events and applies the §22 forwarding rules. Pure /
 * synchronous: it never performs I/O.
 */
export interface TranscriptFilter {
  /** Map one raw inbound message to a normalized event (spec §22). */
  normalizeRawMessage(raw: unknown, ctx: NormalizeContext): NormalizedCodexEvent;

  /** Decide whether an event is forwarded to Claude for the given mode (§22 table). */
  shouldForward(evt: NormalizedCodexEvent, mode: TranscriptMode): boolean;

  /** Render a forwardable event as a transcript message, or null to drop it. */
  renderMessage(evt: NormalizedCodexEvent): RenderedMessage | null;

  /** Build a compact command/test summary from command events (spec §23). */
  summarizeCommands(events: NormalizedCodexEvent[]): string;
}

/**
 * Owns per-run/per-worker artifact directories and all file writers (spec
 * §14). All writers are async (filesystem I/O) and must persist raw events
 * before any filtering (protocol doc: "persist ALL raw inbound lines").
 */
export interface ArtifactStore {
  /** Resolve (and create on disk) the artifact paths for a worker. */
  readonly artifactPaths: WorkerArtifactPaths;

  /** Append one raw event line to `events.ndjson`. */
  appendEvent(raw: unknown): Promise<void>;

  /** Append one rendered message to `messages.md`. */
  appendMessage(message: RenderedMessage): Promise<void>;

  /** Write the structured `result.json`. */
  writeResult(result: unknown): Promise<void>;

  /** Write the agent's final answer to `final.md`. */
  writeFinal(text: string): Promise<void>;

  /** Write the unified diff to `diff.patch`. */
  writeDiff(diff: string): Promise<void>;

  /** Write the changed-file list to `changed-files.txt`. */
  writeChangedFiles(paths: string[]): Promise<void>;

  /** Write the command/test summary to `command-summary.md`. */
  writeCommandSummary(summary: string): Promise<void>;

  /** Persist the worker record to `worker.json`. */
  writeWorkerJson(record: WorkerRecord): Promise<void>;

  /** Append an error to `error.log`. */
  writeError(message: string): Promise<void>;

  /** Update the run-level `manifest.json` with this worker's summary. */
  updateManifest(record: WorkerRecord): Promise<void>;
}

/** Result of creating a git worktree (spec §24). */
export type WorktreeInfo = {
  worktreePath: string;
  branch: string;
};

/**
 * Manages isolated git worktrees for write-capable workers (spec §24).
 * Worktree path `.worktrees/codex-<workerId>`, branch `codex/<runId>/<workerId>`.
 */
export interface WorktreeManager {
  /** Create `.worktrees/codex-<workerId>` on `codex/<runId>/<workerId>` from `baseBranch`. */
  createWorktree(
    runId: string,
    workerId: string,
    /** Base to branch from; defaults to the project's current HEAD. */
    baseBranch?: string,
  ): Promise<WorktreeInfo>;

  /** Remove a worktree previously created by {@link createWorktree}. */
  removeWorktree(path: string): Promise<void>;

  /** List existing worktrees managed under `.worktrees/`. */
  listWorktrees(): Promise<WorktreeInfo[]>;

  /**
   * Compute a unified diff of `dir`'s working tree against HEAD, including
   * untracked (newly created) files. Used to populate `diff.patch` for write
   * workers, since Codex app-server v2 does not emit `turn/diff/updated`
   * notifications. Non-destructive: leaves the real git index untouched.
   */
  diffWorkdir(dir: string): Promise<string>;
}

/** Result of the destructive-command check (spec §31). */
export type DestructiveCheck = {
  blocked: boolean;
  rule?: string;
};

/** A bridge decision for a Codex approval request (spec §31, protocol doc). */
export type ApprovalDecision = {
  /**
   * A short label for the disposition recorded on the forwarded
   * `approval_request` event (e.g. "approved" | "denied" | "decline" |
   * "unsupported"). NOT necessarily a wire field — see {@link ApprovalDecision.raw}.
   */
  decision: string;
  /** Human-readable rationale recorded on the forwarded approval_request event. */
  reason: string;
  /**
   * How the adapter must answer the server request:
   *  - "result": send a JSON-RPC `{ id, result: raw }` (approval/permissions reply);
   *  - "error":  send a JSON-RPC `{ id, error: { code, message } }` (the bridge
   *    does not implement this server request — let Codex fall back).
   */
  responseKind: "result" | "error";
  /** The JSON-RPC `result` body to send when `responseKind === "result"`. */
  raw: unknown;
  /** The JSON-RPC error code to send when `responseKind === "error"` (default -32601). */
  errorCode?: number;
};

/** Resolved defaults for a worker, per the §37 recommended-defaults tables. */
export type ResolvedDefaults = {
  transcriptMode: TranscriptMode;
  sandboxPolicy: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "never" | "on-request";
  useWorktree: boolean;
};

/**
 * Enforces the §31 safety rules and §37 recommended defaults. Pure /
 * synchronous (no I/O); the adapter and tool layer act on its decisions.
 */
export interface SafetyLayer {
  /** True (with the matched rule) if a command is on the destructive blocklist (§31). */
  isDestructiveCommand(cmd: string): DestructiveCheck;

  /**
   * Decide how to answer a Codex approval request (§31, protocol doc): deny
   * destructive commands/patches, otherwise approve within a worktree.
   */
  decideApproval(req: CodexServerRequest): ApprovalDecision;

  /** Fill in §37 recommended defaults from partial worker-start input. */
  resolveDefaults(input: CodexWorkerStartInput): ResolvedDefaults;
}

/** A partial update applied to a {@link WorkerRecord} (timestamps managed by the registry). */
export type WorkerRecordPatch = Partial<
  Omit<WorkerRecord, "workerId" | "runId" | "createdAt" | "artifactPaths">
>;

/**
 * In-memory registry of all workers for a run, enforcing the §31/§24
 * write-isolation rule and §13 state transitions. No cap on parallel workers.
 */
export interface WorkerRegistry {
  /**
   * Throw if starting a worker with these options would violate the
   * single-writer-per-directory rule (no two writers in the same write dir).
   */
  assertCanStart(opts: CodexWorkerStartInput & { resolved: ResolvedDefaults }): void;

  /** Register a new worker record. */
  create(record: WorkerRecord): WorkerRecord;

  /** Look up a worker by id, or undefined if unknown. */
  get(id: string): WorkerRecord | undefined;

  /** List all worker records. */
  list(): WorkerRecord[];

  /** Apply a patch to a worker, refreshing `updatedAt`. */
  update(id: string, patch: WorkerRecordPatch): WorkerRecord;

  /** Move a worker to a new state if the transition is legal (§13). */
  transition(id: string, next: WorkerState): WorkerRecord;
}
