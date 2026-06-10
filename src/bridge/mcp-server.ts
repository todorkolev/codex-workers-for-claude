/**
 * MCP server wiring (spec §15–§21) — registers the SEVEN Codex-worker tools and
 * drives the registry + adapter + filter + store + worktree + safety layers.
 *
 * Responsibilities:
 *   - Build a {@link McpServer} (`@modelcontextprotocol/sdk`) named per spec §2.
 *   - Register the seven tools with their EXACT §15–§21 input/output shapes
 *     (zod raw shapes for input validation).
 *   - Own one {@link WorkerRuntime} per worker: a `codex app-server` child
 *     (adapter), the worker's {@link ArtifactStore}, and the accumulated
 *     normalized event stream that the read/status/collect/debug tools project.
 *   - Persist ALL raw inbound events to `events.ndjson` BEFORE any filtering;
 *     forward only the filtered messages per the worker's transcript mode.
 *   - Auto-answer Codex approval requests through {@link SafetyLayer.decideApproval}
 *     and record an `approval_request` event each time.
 *
 * stdout is reserved for the MCP protocol; this module logs only to stderr.
 *
 * Local-import convention: extensionless (bundler moduleResolution + esbuild).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { config } from "./config";
import { logger } from "./logger";
import { ArtifactStore } from "./artifact-store";
import { CodexAppServerAdapter } from "./codex-adapter";
import { transcriptFilter } from "./transcript-filter";
import { worktreeManager } from "./worktree-manager";
import { safety } from "./safety";
import { WorkerRegistry } from "./worker-registry";
import {
  limits,
  type CheckCodexAvailable,
  type CodexAdapter,
  type CodexAvailability,
  type CodexServerRequest,
  type CodexWorkerStartInput,
  type CodexWorkerStartOutput,
  type CodexWorkerCollectResultOutput,
  type CodexWorkerMessage,
  type CodexWorkerReadMessagesOutput,
  type CodexWorkerSteerOutput,
  type CodexWorkerStatusOutput,
  type CodexWorkerInterruptOutput,
  type CodexWorkerDebugTraceOutput,
  type NormalizedCodexEvent,
  type RenderedMessage,
  type WorkerRecord,
  type WorkerState,
} from "./types";
import type { NormalizeContextExt } from "./transcript-filter";

/* ════════════════════════════════════════════════════════════════════════
 * Constants
 * ════════════════════════════════════════════════════════════════════════ */

/** Spec §2 recommended MCP server name. */
const SERVER_NAME = "codex-worker-bridge";

/** Spec §32 — uniform "Codex is unavailable" failure copy. */
const UNAVAILABLE_ERROR = "Codex is unavailable";
const UNAVAILABLE_RECOVERY =
  "Check that Codex CLI is installed and logged in.";

/** Default base branch for worktrees when none is supplied (spec §24). */
const DEFAULT_BASE_BRANCH = "main";

/** Hard ceiling on how long a `waitFor: "completed"` await blocks the tool. */
const DEFAULT_COMPLETED_TIMEOUT_MS = 10 * 60 * 1000;

/** Idle-detection window: time after the last forwarded message with no
 *  active turn that we treat the worker as "idle" for `waitFor: "idle"`. */
const IDLE_SETTLE_MS = 1500;

/* ════════════════════════════════════════════════════════════════════════
 * Per-worker runtime
 * ════════════════════════════════════════════════════════════════════════ */

/** A normalized event paired with whether it was forwarded to Claude. */
type StoredEvent = NormalizedCodexEvent;

/**
 * Owns the live state for ONE worker: its adapter (one `codex app-server`
 * child), its on-disk {@link ArtifactStore}, and the accumulated normalized
 * event stream. The tool handlers read projections of this runtime.
 */
class WorkerRuntime {
  readonly adapter: CodexAdapter;

  /** All normalized events in arrival order (mirror of `events.ndjson`). */
  private readonly events: StoredEvent[] = [];

  /** All rendered transcript messages in arrival order (mirror of messages.md). */
  private readonly messages: RenderedMessage[] = [];

  /** Raw inbound line count (every persisted event, pre-filter). */
  private rawEventCount = 0;

  /** Monotonic id source for normalized events (stable within this process). */
  private eventSeq = 0;

  /** Resolvers waiting for the first forwarded message (`waitFor: first_message`). */
  private firstMessageWaiters: Array<() => void> = [];
  /** Resolvers waiting for the turn to complete (`waitFor: completed`). */
  private completedWaiters: Array<() => void> = [];

  /** Timestamp (ms) of the most recent forwarded message; drives idle detection. */
  private lastMessageMs = 0;

  /** True once a `turn_completed` (or terminal error) has been observed. */
  private turnEnded = false;

  /** Standard §14 artifact files actually written to disk this run. */
  private readonly writtenArtifacts = new Set<
    "finalMd" | "diffPatch" | "changedFilesTxt" | "commandSummaryMd"
  >();

  constructor(
    private readonly record: WorkerRecord,
    readonly store: ArtifactStore,
    adapter: CodexAdapter,
    private readonly registry: WorkerRegistry,
  ) {
    this.adapter = adapter;
  }

  /* ── wiring ──────────────────────────────────────────────────────────── */

  /**
   * Subscribe to the adapter: persist every raw event, normalize it, forward
   * filtered messages, and answer approval requests through the safety layer.
   * Must be called once after the adapter is constructed and before the first
   * turn starts.
   */
  wire(): void {
    this.adapter.onRawMessage((raw) => {
      void this.handleRaw(raw);
    });

    this.adapter.onServerRequest((req) => {
      void this.handleServerRequest(req);
    });

    this.adapter.onStderr((line) => {
      // bubblewrap notes and other warnings — store, never forward (§32).
      void this.store.writeError(`[stderr] ${line}`).catch((err) => {
        logger.warn("failed to persist stderr line", err);
      });
    });
  }

  /** Persist + normalize + forward one raw inbound message. Never throws. */
  private async handleRaw(raw: unknown): Promise<void> {
    this.rawEventCount += 1;

    // 1. Persist the raw line FIRST (durable audit log, pre-filter).
    try {
      await this.store.appendEvent(raw);
    } catch (err) {
      logger.error("failed to append raw event", err);
    }

    // 2. Normalize defensively (the filter never throws).
    const ctx: NormalizeContextExt = {
      workerId: this.record.workerId,
      threadId: this.adapter.threadId,
      turnId: this.adapter.turnId,
      id: `evt-${(this.eventSeq += 1).toString().padStart(6, "0")}`,
      now: () => new Date().toISOString(),
    };
    const evt = transcriptFilter.normalizeRawMessage(raw, ctx);
    this.events.push(evt);

    // 3. Track turn lifecycle for waitFor semantics. A completed turn with no
    //    follow-up steering settles the worker to "idle" (steerable between
    //    turns, §17.2); the explicit terminal "completed" state is reached only
    //    via waitFor:"completed" (see applyWaitFor) so §17.2 idle-steering and
    //    §17.3 reject-on-completed both hold.
    if (evt.normalizedType === "turn_completed") {
      this.turnEnded = true;
      if (this.registry.get(this.record.workerId)?.state === "running") {
        this.safeTransition("idle");
      }
      // Materialize the standard §14 artifact files now so they always exist for
      // any worker that produced a final answer / diff / changed files / commands,
      // even if collect_result is never called (§14, §24.3).
      await this.flushStandardArtifacts();
    }

    // 4. Forward filtered messages per the worker's transcript mode.
    if (transcriptFilter.shouldForward(evt, this.record.transcriptMode)) {
      const rendered = transcriptFilter.renderMessage(evt);
      if (rendered) {
        this.messages.push(rendered);
        this.lastMessageMs = Date.now();
        try {
          await this.store.appendMessage(rendered);
        } catch (err) {
          logger.error("failed to append message", err);
        }
        this.releaseFirstMessage();
      }
    }

    // 5. Release completion waiters once the turn ends.
    if (this.turnEnded) {
      this.releaseCompleted();
    }
  }

  /** Decide + answer an approval request, recording an event each time (§31). */
  private async handleServerRequest(req: CodexServerRequest): Promise<void> {
    let decision: {
      decision: string;
      reason: string;
      responseKind: "result" | "error";
      raw: unknown;
      errorCode?: number;
    };
    try {
      decision = safety.decideApproval(req);
    } catch (err) {
      // Fail safe: never crash; deny with a generic reason.
      logger.error("safety.decideApproval threw; denying", err);
      decision = {
        decision: "denied",
        reason: "internal error",
        responseKind: "result",
        raw: { decision: "denied" },
      };
    }

    // Record an approval_request normalized event (forwarded + stored).
    const ctx: NormalizeContextExt = {
      workerId: this.record.workerId,
      threadId: this.adapter.threadId,
      turnId: this.adapter.turnId,
      id: `evt-${(this.eventSeq += 1).toString().padStart(6, "0")}`,
      now: () => new Date().toISOString(),
    };
    const isAllow = decision.decision === "approved" || decision.decision === "accept";
    const label = isAllow ? "Auto-approved" : "Auto-denied";
    const evt: NormalizedCodexEvent = {
      id: ctx.id!,
      timestamp: ctx.now!(),
      workerId: this.record.workerId,
      threadId: this.adapter.threadId,
      turnId: this.adapter.turnId,
      rawType: req.method,
      normalizedType: "approval_request",
      text: `${label}: ${decision.reason}`,
      data: { request: { id: req.id, method: req.method, params: req.params }, decision: decision.decision },
    };
    this.events.push(evt);
    try {
      await this.store.appendEvent({
        method: "bridge/approvalDecision",
        params: { id: req.id, requestMethod: req.method, decision: decision.decision, reason: decision.reason },
      });
    } catch (err) {
      logger.error("failed to persist approval decision", err);
    }

    // Surface the approval as a transcript message for visibility (§22).
    const rendered = transcriptFilter.renderMessage(evt);
    if (rendered) {
      this.messages.push(rendered);
      this.lastMessageMs = Date.now();
      try {
        await this.store.appendMessage(rendered);
      } catch (err) {
        logger.error("failed to append approval message", err);
      }
      this.releaseFirstMessage();
    }

    // Briefly mark waiting_for_approval, then back to running (best-effort).
    this.safeTransition("waiting_for_approval");

    // Answer the request. Unsupported server requests get a JSON-RPC error so
    // Codex can fall back; approvals/permissions get a `result` body.
    try {
      if (decision.responseKind === "error") {
        this.adapter.respondError(
          req.id,
          decision.errorCode ?? -32601,
          decision.reason,
        );
      } else {
        this.adapter.respond(req.id, decision.raw);
      }
    } catch (err) {
      logger.error("failed to respond to approval request", err);
    }

    // Decision sent; the turn continues (or Codex ends it). Return to running.
    if (this.registry.get(this.record.workerId)?.state === "waiting_for_approval") {
      this.safeTransition("running");
    }
  }

  /* ── waitFor primitives ──────────────────────────────────────────────── */

  /** Resolve once at least one message has been forwarded (or immediately). */
  waitForFirstMessage(): Promise<void> {
    if (this.messages.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.firstMessageWaiters.push(resolve));
  }

  /** Resolve once the active turn has completed (or immediately if already). */
  waitForCompleted(): Promise<void> {
    if (this.turnEnded || this.adapter.turnId === undefined) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.completedWaiters.push(resolve));
  }

  /**
   * Resolve once the worker is "idle": the active turn has ended (or there is
   * no active turn) and no new message has arrived for {@link IDLE_SETTLE_MS}.
   * Falls through to {@link waitForCompleted} which is the dominant signal.
   */
  async waitForIdle(): Promise<void> {
    await this.waitForCompleted();
    // Give any trailing trailing item/completed a brief window to land.
    const sinceLast = Date.now() - this.lastMessageMs;
    if (this.lastMessageMs > 0 && sinceLast < IDLE_SETTLE_MS) {
      await delay(IDLE_SETTLE_MS - sinceLast);
    }
  }

  private releaseFirstMessage(): void {
    const waiters = this.firstMessageWaiters;
    this.firstMessageWaiters = [];
    for (const w of waiters) safeCall(w);
  }

  private releaseCompleted(): void {
    const waiters = this.completedWaiters;
    this.completedWaiters = [];
    for (const w of waiters) safeCall(w);
  }

  /* ── projections used by the tools ───────────────────────────────────── */

  /** All forwarded transcript messages (read-messages source). */
  getMessages(): RenderedMessage[] {
    return this.messages;
  }

  /** All normalized events (debug-trace + command-summary + diff source). */
  getEvents(): NormalizedCodexEvent[] {
    return this.events;
  }

  /** Total raw inbound line count (status.rawEventCount). */
  getRawEventCount(): number {
    return this.rawEventCount;
  }

  /** True once a `turn_completed` (or terminal error) has been observed. */
  hasTurnEnded(): boolean {
    return this.turnEnded;
  }

  /**
   * Reset turn-lifecycle tracking for a freshly-started turn (start or steer),
   * so subsequent `waitFor` awaits block on the NEW turn rather than resolving
   * immediately on the previous turn's `turnEnded` flag.
   */
  markTurnStarted(): void {
    this.turnEnded = false;
  }

  /** ISO timestamp of the most recent forwarded message, if any. */
  getLastMessageAt(): string | undefined {
    const last = this.messages[this.messages.length - 1];
    return last?.timestamp;
  }

  /** The most recent agent final message, preferring the adapter's tracker. */
  getFinalMessage(): string | undefined {
    if (this.adapter.lastFinalMessage !== undefined) {
      return this.adapter.lastFinalMessage;
    }
    // Fall back to the last forwarded `message`-type line.
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i];
      if (m && m.type === "message") return m.text;
    }
    return undefined;
  }

  /**
   * Latest unified diff observed via `turn/diff/updated` events, if any. Codex
   * app-server v2 does not emit these, so this is usually empty for v2 workers;
   * {@link flushStandardArtifacts} then derives the diff from the worktree.
   */
  getLatestDiff(): string | undefined {
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const evt = this.events[i];
      if (evt && evt.normalizedType === "diff_available" && evt.text) {
        return evt.text;
      }
    }
    return undefined;
  }

  /** Distinct changed-file paths gleaned from file_changed events. */
  getChangedFiles(): string[] {
    const seen = new Set<string>();
    for (const evt of this.events) {
      if (evt.normalizedType !== "file_changed") continue;
      const data = isRecord(evt.data) ? evt.data : undefined;
      const item = data && isRecord(data["item"]) ? (data["item"] as Record<string, unknown>) : data;
      const changes = item && Array.isArray(item["changes"]) ? item["changes"] : undefined;
      if (!changes) continue;
      for (const change of changes) {
        if (isRecord(change) && typeof change["path"] === "string") {
          seen.add(change["path"]);
        }
      }
    }
    return Array.from(seen);
  }

  /**
   * Persist the standard §14 artifact files (final.md, diff.patch,
   * changed-files.txt, command-summary.md) whenever the underlying data exists,
   * INDEPENDENT of any collect-result include* flags. The flags only control
   * what is inlined into the response; the files on disk must always exist so
   * §24.3/README's "review diff.patch before applying" contract holds and the
   * returned artifactPaths never point at missing files. Best-effort: never throws.
   */
  async flushStandardArtifacts(): Promise<void> {
    const final = this.getFinalMessage();
    if (final !== undefined && final.length > 0) {
      await this.store.writeFinal(final).catch(() => {});
      this.writtenArtifacts.add("finalMd");
    }

    // Prefer a diff streamed via `turn/diff/updated` (forward-compat); fall back
    // to deriving it from git, since Codex app-server v2 reports changes only
    // inside `item/fileChange` items and never emits that notification. The git
    // diff is the canonical "what would be applied" view. Applies to any write
    // worker: its isolated worktree when present, else its working dir.
    let diff = this.getLatestDiff();
    if (diff === undefined || diff.length === 0) {
      const diffDir =
        this.record.worktreePath ??
        (this.record.sandboxPolicy === "workspace-write" ||
        this.record.sandboxPolicy === "danger-full-access"
          ? this.record.cwd
          : undefined);
      if (diffDir) {
        diff = await worktreeManager.diffWorkdir(diffDir).catch(() => undefined);
      }
    }
    if (diff !== undefined && diff.length > 0) {
      await this.store.writeDiff(diff).catch(() => {});
      this.writtenArtifacts.add("diffPatch");
    }

    const files = this.getChangedFiles();
    if (files.length > 0) {
      await this.store.writeChangedFiles(files).catch(() => {});
      this.writtenArtifacts.add("changedFilesTxt");
    }

    // Only write a command summary if at least one command was actually run.
    if (this.getEvents().some((e) =>
      e.normalizedType === "command_started" ||
      e.normalizedType === "command_completed",
    )) {
      const summary = transcriptFilter.summarizeCommands(this.getEvents());
      await this.store.writeCommandSummary(summary).catch(() => {});
      this.writtenArtifacts.add("commandSummaryMd");
    }
  }

  /** Mark a standard artifact as written (used when a tool writes one directly). */
  markArtifactWritten(
    key: "finalMd" | "diffPatch" | "changedFilesTxt" | "commandSummaryMd",
  ): void {
    this.writtenArtifacts.add(key);
  }

  /**
   * Project the artifactPaths object for a result/collect response. The four
   * always-present files (worker.json, messages.md, events.ndjson) are included
   * unconditionally; the optional §14 files are included only when actually
   * written this run, so no returned path points at a missing file (§19).
   */
  getResultArtifactPaths(): CodexWorkerCollectResultOutput["artifactPaths"] {
    const ap = this.record.artifactPaths;
    return {
      workerJson: ap.workerJson,
      messagesMd: ap.messagesMd,
      eventsNdjson: ap.eventsNdjson,
      ...(this.writtenArtifacts.has("finalMd") ? { finalMd: ap.finalMd } : {}),
      ...(this.writtenArtifacts.has("diffPatch") ? { diffPatch: ap.diffPatch } : {}),
      ...(this.writtenArtifacts.has("changedFilesTxt")
        ? { changedFilesTxt: ap.changedFilesTxt }
        : {}),
      ...(this.writtenArtifacts.has("commandSummaryMd")
        ? { commandSummaryMd: ap.commandSummaryMd }
        : {}),
    };
  }

  /** Best-effort legal state transition; logs and swallows illegal moves. */
  safeTransition(next: WorkerState): WorkerRecord | undefined {
    try {
      return this.registry.transition(this.record.workerId, next);
    } catch (err) {
      logger.debug("skipping illegal/no-op transition", {
        workerId: this.record.workerId,
        next,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.registry.get(this.record.workerId);
    }
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * Tool input zod shapes (EXACT §15–§21 inputs)
 * ════════════════════════════════════════════════════════════════════════ */

const transcriptModeSchema = z.enum([
  "messages",
  "messages_plus_artifacts",
  "full_events",
]);
// "danger-full-access" runs Codex UNSANDBOXED with full host access and no
// command approval. It is opt-in only (never a default; see resolveDefaults)
// and is for environments where the Codex sandbox cannot initialize.
const sandboxPolicySchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const approvalPolicySchema = z.enum(["never", "on-request"]);

const startInputShape = {
  workerId: z.string(),
  task: z.string(),
  cwd: z.string().optional(),
  useWorktree: z.boolean().optional(),
  baseBranch: z.string().optional(),
  transcriptMode: transcriptModeSchema.optional(),
  sandboxPolicy: sandboxPolicySchema.optional(),
  approvalPolicy: approvalPolicySchema.optional(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
  instructions: z.string().optional(),
  timeoutMs: z.number().optional(),
  waitFor: z.enum(["started", "first_message", "idle", "completed"]).optional(),
} as const;

const readMessagesInputShape = {
  workerId: z.string(),
  sinceMessageId: z.string().optional(),
  maxMessages: z.number().optional(),
  maxChars: z.number().optional(),
} as const;

const steerInputShape = {
  workerId: z.string(),
  message: z.string(),
  priority: z.enum(["normal", "urgent"]).optional(),
} as const;

const statusInputShape = {
  workerId: z.string(),
} as const;

const collectResultInputShape = {
  workerId: z.string(),
  includeMessages: z.boolean().optional(),
  includeDiffSummary: z.boolean().optional(),
  includeChangedFiles: z.boolean().optional(),
  includeCommandSummary: z.boolean().optional(),
  includeFullEvents: z.boolean().optional(),
  maxChars: z.number().optional(),
} as const;

const interruptInputShape = {
  workerId: z.string(),
  reason: z.string().optional(),
} as const;

const debugTraceInputShape = {
  workerId: z.string(),
  sinceEventId: z.string().optional(),
  maxEvents: z.number().optional(),
  maxChars: z.number().optional(),
} as const;

/* ════════════════════════════════════════════════════════════════════════
 * Server factory
 * ════════════════════════════════════════════════════════════════════════ */

/** Options for {@link createMcpServer}. */
export type CreateMcpServerOptions = {
  /** Stable per-process run id (spec §14), e.g. `2026-05-29-001`. */
  runId: string;
  /** Server version reported in the adapter handshake / MCP serverInfo. */
  version: string;
  /** Availability probe (spec §32). Re-checked lazily on the first start. */
  checkCodexAvailable: CheckCodexAvailable;
  /** Factory for a worker adapter (injectable for tests; defaults to the real one). */
  adapterFactory?: (cwd: string, version: string) => CodexAdapter;
};

/**
 * Build (but do not connect) the MCP server with all seven tools registered.
 * The caller connects it to a transport (see `index.ts`).
 */
export function createMcpServer(opts: CreateMcpServerOptions): McpServer {
  const { runId, version, checkCodexAvailable } = opts;
  const adapterFactory =
    opts.adapterFactory ??
    ((cwd: string, v: string): CodexAdapter =>
      new CodexAppServerAdapter({ cwd, version: v }));

  const registry = new WorkerRegistry();
  const runtimes = new Map<string, WorkerRuntime>();

  /** Cached availability; first start re-probes, later starts reuse it. */
  let availability: CodexAvailability | undefined;
  const ensureAvailable = async (): Promise<CodexAvailability> => {
    if (availability === undefined || availability.available === false) {
      availability = await checkCodexAvailable();
    }
    return availability;
  };

  const server = new McpServer(
    { name: SERVER_NAME, version },
    { capabilities: { tools: {} } },
  );

  /* ── codex_worker_start (§15) ──────────────────────────────────────────── */
  server.registerTool(
    "codex_worker_start",
    {
      description:
        "Start a Codex worker session and begin a turn with the given task. " +
        "Returns worker metadata and artifact paths once the requested " +
        "lifecycle point (waitFor) is reached. " +
        "sandboxPolicy defaults to read-only; workspace-write permits edits. " +
        'Pass sandboxPolicy="danger-full-access" ONLY to run Codex ' +
        "unsandboxed with full host access and no command approval (for " +
        "environments where the Codex sandbox cannot initialize) — never a " +
        "default; it must be explicitly requested.",
      inputSchema: startInputShape,
    },
    async (args) => {
      const input = args as CodexWorkerStartInput;
      try {
        const avail = await ensureAvailable();
        if (!avail.available) {
          return failure(unavailableStart(input.workerId, runId));
        }

        // §37 defaults via the safety layer (preserves explicit fields).
        const resolved = safety.resolveDefaults(input);
        const cwd = resolveCwd(input.cwd);

        // §24/§31 write-isolation check (one writer per directory).
        registry.assertCanStart({ ...input, cwd, resolved });

        // Allocate artifact paths up-front so they exist in the record.
        const store = new ArtifactStore(config.artifactBase, runId, input.workerId);
        await store.init();

        // §24: write workers run in an isolated worktree when requested.
        let worktreePath: string | undefined;
        let workerCwd = cwd;
        if (resolved.useWorktree) {
          const info = await worktreeManager.createWorktree(
            runId,
            input.workerId,
            input.baseBranch ?? DEFAULT_BASE_BRANCH,
          );
          worktreePath = info.worktreePath;
          workerCwd = info.worktreePath;
        }

        const now = new Date().toISOString();
        const record: WorkerRecord = {
          workerId: input.workerId,
          runId,
          state: "created",
          cwd: workerCwd,
          worktreePath,
          transcriptMode: resolved.transcriptMode,
          sandboxPolicy: resolved.sandboxPolicy,
          approvalPolicy: resolved.approvalPolicy,
          createdAt: now,
          updatedAt: now,
          artifactPaths: store.artifactPaths,
        };
        registry.create(record);
        await persistRecord(store, registry, record.workerId);

        // Spin up the adapter (one app-server child) and wire it up.
        const adapter = adapterFactory(workerCwd, version);
        const runtime = new WorkerRuntime(record, store, adapter, registry);
        runtime.wire();
        runtimes.set(input.workerId, runtime);

        registry.transition(input.workerId, "starting");
        await adapter.init();

        const threadId = await adapter.startThread({
          cwd: workerCwd,
          sandboxPolicy: resolved.sandboxPolicy,
          approvalPolicy: resolved.approvalPolicy,
          model: input.model,
          effort: input.effort,
          instructions: input.instructions,
        });
        registry.update(input.workerId, { threadId });

        const turnId = await adapter.startTurn(buildTaskPrompt(input));
        registry.update(input.workerId, {
          currentTurnId: turnId,
          state: "running",
        });
        await persistRecord(store, registry, input.workerId);

        // waitFor semantics (§15 default "started").
        const waitFor = input.waitFor ?? "started";
        await applyWaitFor(runtime, waitFor, input.timeoutMs);

        const finalRecord = registry.get(input.workerId)!;
        const out: CodexWorkerStartOutput = {
          workerId: finalRecord.workerId,
          runId: finalRecord.runId,
          threadId: finalRecord.threadId,
          turnId: finalRecord.currentTurnId,
          state: finalRecord.state,
          cwd: finalRecord.cwd,
          worktreePath: finalRecord.worktreePath,
          transcriptMode: finalRecord.transcriptMode,
          messagesPath: finalRecord.artifactPaths.messagesMd,
          eventsPath: finalRecord.artifactPaths.eventsNdjson,
        };
        return ok(out);
      } catch (err) {
        // Mark the worker failed (best-effort) and surface a structured error.
        const rt = runtimes.get(input.workerId);
        if (rt) rt.safeTransition("failed");
        const message = errorMessage(err);
        await rt?.store.writeError(`start failed: ${message}`).catch(() => {});
        logger.error("codex_worker_start failed", err);
        return failure({
          workerId: input.workerId,
          runId,
          state: "failed",
          error: message,
          recovery: UNAVAILABLE_RECOVERY,
        });
      }
    },
  );

  /* ── codex_worker_read_messages (§16) ──────────────────────────────────── */
  server.registerTool(
    "codex_worker_read_messages",
    {
      description:
        "Read filtered Codex messages for a worker (never raw shell output). " +
        "Supports incremental reads via sinceMessageId and truncation via " +
        "maxMessages/maxChars.",
      inputSchema: readMessagesInputShape,
    },
    async (args) => {
      const { workerId, sinceMessageId, maxMessages, maxChars } = args as {
        workerId: string;
        sinceMessageId?: string;
        maxMessages?: number;
        maxChars?: number;
      };
      const runtime = runtimes.get(workerId);
      const record = registry.get(workerId);
      if (!runtime || !record) {
        return failure(unknownWorker(workerId));
      }

      const all = runtime.getMessages();
      const startIdx = sinceMessageId
        ? all.findIndex((m) => m.id === sinceMessageId) + 1
        : 0;
      const slice = all.slice(Math.max(startIdx, 0));

      const charBudget = clampCharBudget(maxChars, limits.maxMessageCharsPerRead);
      const messages: CodexWorkerMessage[] = [];
      let used = 0;
      let truncated = false;
      let lastReturnedId: string | undefined;

      for (const m of slice) {
        // Stop conditions. The char-budget guard requires at least one message
        // already collected so a single oversized message is never skipped
        // (it is returned clipped below); mirrors the debug_trace guard.
        if (
          (maxMessages !== undefined && messages.length >= maxMessages) ||
          (messages.length > 0 && used + m.text.length > charBudget)
        ) {
          truncated = true;
          break;
        }
        // Clip a single oversized message to the budget rather than dropping it
        // (§16 "Respect maxChars", §32 "never silently drop").
        let text = m.text;
        if (messages.length === 0 && text.length > charBudget) {
          text = text.slice(0, charBudget);
          truncated = true;
        }
        messages.push({
          id: m.id,
          timestamp: m.timestamp,
          role: "codex",
          type: m.type,
          text,
        });
        used += text.length;
        lastReturnedId = m.id;
      }

      // The cursor is exclusive-of-RETURNED: resuming with sinceMessageId =
      // lastReturnedId continues from the boundary message (startIdx = idx+1),
      // so no message is ever dropped. Only emit a cursor when more remain.
      const moreRemain = startIdx + messages.length < all.length;
      const nextMessageId = moreRemain ? lastReturnedId : undefined;

      const out: CodexWorkerReadMessagesOutput = {
        workerId,
        state: record.state,
        messages,
        nextMessageId,
        truncated,
      };
      return ok(out);
    },
  );

  /* ── codex_worker_steer (§17) ──────────────────────────────────────────── */
  server.registerTool(
    "codex_worker_steer",
    {
      description:
        "Send a steering instruction to a Codex worker. Steers the active " +
        "turn when running, starts a new turn when idle, and is rejected when " +
        "the worker has reached a terminal state.",
      inputSchema: steerInputShape,
    },
    async (args) => {
      const { workerId, message } = args as {
        workerId: string;
        message: string;
        priority?: "normal" | "urgent";
      };
      const runtime = runtimes.get(workerId);
      const record = registry.get(workerId);
      if (!runtime || !record) {
        return failure(unknownWorker(workerId));
      }

      // §17.3 — completed/terminal workers reject steering (§32 "Steering rejected").
      if (isTerminalState(record.state)) {
        const out: CodexWorkerSteerOutput = {
          workerId,
          accepted: false,
          state: record.state,
          reason: `Worker is ${record.state}`,
        };
        return ok(out);
      }

      try {
        let turnId: string | undefined;
        const activeTurn = runtime.adapter.turnId;
        // A new/steered turn is in flight; reset turn-lifecycle tracking so any
        // subsequent waitFor blocks on this turn, not the previous one.
        runtime.markTurnStarted();
        if (activeTurn !== undefined && record.state === "running") {
          // §17.1 — steer the active turn.
          await runtime.adapter.steerTurn(message, activeTurn);
          turnId = runtime.adapter.turnId;
        } else {
          // §17.2 — idle worker: start a fresh turn in the same session.
          turnId = await runtime.adapter.startTurnIfIdle(message);
        }
        runtime.safeTransition("running");
        registry.update(workerId, { currentTurnId: turnId });
        await persistRecord(runtime.store, registry, workerId);

        const out: CodexWorkerSteerOutput = {
          workerId,
          accepted: true,
          state: registry.get(workerId)!.state,
          turnId,
        };
        return ok(out);
      } catch (err) {
        const out: CodexWorkerSteerOutput = {
          workerId,
          accepted: false,
          state: registry.get(workerId)?.state ?? record.state,
          reason: errorMessage(err),
        };
        logger.warn("codex_worker_steer rejected", err);
        return ok(out);
      }
    },
  );

  /* ── codex_worker_status (§18) ─────────────────────────────────────────── */
  server.registerTool(
    "codex_worker_status",
    {
      description: "Get the current state and counters for a Codex worker.",
      inputSchema: statusInputShape,
    },
    async (args) => {
      const { workerId } = args as { workerId: string };
      const runtime = runtimes.get(workerId);
      const record = registry.get(workerId);
      if (!runtime || !record) {
        return failure(unknownWorker(workerId));
      }

      const changedFiles = runtime.getChangedFiles();
      const out: CodexWorkerStatusOutput = {
        workerId,
        state: record.state,
        runId: record.runId,
        threadId: record.threadId,
        currentTurnId: record.currentTurnId,
        cwd: record.cwd,
        worktreePath: record.worktreePath,
        transcriptMode: record.transcriptMode,
        messageCount: runtime.getMessages().length,
        rawEventCount: runtime.getRawEventCount(),
        changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
        lastMessageAt: runtime.getLastMessageAt(),
        error: lastErrorText(runtime),
      };
      return ok(out);
    },
  );

  /* ── codex_worker_collect_result (§19) ─────────────────────────────────── */
  server.registerTool(
    "codex_worker_collect_result",
    {
      description:
        "Collect the current or final worker result: final message plus " +
        "optional messages, changed files, diff summary, command summary, and " +
        "(only on request) full raw events. Always returns artifact paths.",
      inputSchema: collectResultInputShape,
    },
    async (args) => {
      const input = args as {
        workerId: string;
        includeMessages?: boolean;
        includeDiffSummary?: boolean;
        includeChangedFiles?: boolean;
        includeCommandSummary?: boolean;
        includeFullEvents?: boolean;
        maxChars?: number;
      };
      const runtime = runtimes.get(input.workerId);
      const record = registry.get(input.workerId);
      if (!runtime || !record) {
        return failure(unknownWorker(input.workerId));
      }

      const charBudget = clampCharBudget(
        input.maxChars,
        limits.maxMessageCharsPerRead,
      );
      let truncated = false;

      const clip = (text: string | undefined): string | undefined => {
        if (text === undefined) return undefined;
        if (text.length <= charBudget) return text;
        truncated = true;
        return text.slice(0, charBudget);
      };

      // Always materialize the standard §14 artifact files first (independent of
      // the include* flags) so every returned path is valid (§14, §19, §24.3).
      await runtime.flushStandardArtifacts();

      // Final message (always attempted; truncated to budget). flushStandardArtifacts
      // already persisted the untruncated answer to final.md.
      const rawFinal = runtime.getFinalMessage();
      const finalMessage = clip(rawFinal);

      // Optional messages blob (controls INLINING only, not what is written).
      let messages: string | undefined;
      if (input.includeMessages) {
        const blob = runtime
          .getMessages()
          .map((m) => `[${m.type}] ${m.text}`)
          .join("\n\n");
        messages = clip(blob);
      }

      // Optional changed files (inlined when requested; file always materialized).
      let changedFiles: string[] | undefined;
      const files = runtime.getChangedFiles();
      if (input.includeChangedFiles && files.length > 0) {
        changedFiles = files;
      }

      // Optional diff summary (inlined when requested; diff.patch always written).
      let diffSummary: string | undefined;
      if (input.includeDiffSummary) {
        const diff = runtime.getLatestDiff();
        if (diff !== undefined) {
          diffSummary = clip(summarizeDiff(diff));
        }
      }

      // Optional command summary (§23) (inlined when requested; file always written).
      let commandSummary: string | undefined;
      if (input.includeCommandSummary) {
        commandSummary = clip(
          transcriptFilter.summarizeCommands(runtime.getEvents()),
        );
      }

      // Full events only on explicit request (or full_events mode) (§19.3/§23).
      let fullEvents: unknown[] | undefined;
      if (input.includeFullEvents || record.transcriptMode === "full_events") {
        fullEvents = runtime.getEvents();
      }

      // Project only the artifact files actually written this run (§19).
      const artifactPaths = runtime.getResultArtifactPaths();
      const out: CodexWorkerCollectResultOutput = {
        workerId: input.workerId,
        state: record.state,
        finalMessage,
        messages,
        changedFiles,
        diffSummary,
        commandSummary,
        artifactPaths,
        fullEvents,
        truncated,
      };
      await runtime.store.writeResult(out).catch(() => {});
      return ok(out);
    },
  );

  /* ── codex_worker_interrupt (§20) ──────────────────────────────────────── */
  server.registerTool(
    "codex_worker_interrupt",
    {
      description:
        "Interrupt a Codex worker's active turn, preserving logs. The worker " +
        "is marked interrupted and may be resumed/steered later.",
      inputSchema: interruptInputShape,
    },
    async (args) => {
      const { workerId, reason } = args as { workerId: string; reason?: string };
      const runtime = runtimes.get(workerId);
      const record = registry.get(workerId);
      if (!runtime || !record) {
        return failure(unknownWorker(workerId));
      }

      if (isTerminalState(record.state)) {
        const out: CodexWorkerInterruptOutput = {
          workerId,
          interrupted: false,
          state: record.state,
        };
        return ok(out);
      }

      try {
        await runtime.adapter.interruptTurn();
        if (reason) {
          await runtime.store
            .writeError(`interrupted: ${reason}`)
            .catch(() => {});
        }
        runtime.safeTransition("interrupted");
        await persistRecord(runtime.store, registry, workerId);
        const out: CodexWorkerInterruptOutput = {
          workerId,
          interrupted: true,
          state: registry.get(workerId)!.state,
        };
        return ok(out);
      } catch (err) {
        logger.error("codex_worker_interrupt failed", err);
        const out: CodexWorkerInterruptOutput = {
          workerId,
          interrupted: false,
          state: registry.get(workerId)?.state ?? record.state,
        };
        return ok(out);
      }
    },
  );

  /* ── codex_worker_debug_trace (§21) ────────────────────────────────────── */
  server.registerTool(
    "codex_worker_debug_trace",
    {
      description:
        "Read raw normalized Codex debug events for a worker (debugging only). " +
        "Supports incremental reads via sinceEventId and truncation.",
      inputSchema: debugTraceInputShape,
    },
    async (args) => {
      const { workerId, sinceEventId, maxEvents, maxChars } = args as {
        workerId: string;
        sinceEventId?: string;
        maxEvents?: number;
        maxChars?: number;
      };
      const runtime = runtimes.get(workerId);
      const record = registry.get(workerId);
      if (!runtime || !record) {
        return failure(unknownWorker(workerId));
      }

      const all = runtime.getEvents();
      const startIdx = sinceEventId
        ? all.findIndex((e) => e.id === sinceEventId) + 1
        : 0;
      const slice = all.slice(Math.max(startIdx, 0));

      const charBudget = clampCharBudget(maxChars, limits.maxRawEventCharsPerRead);
      const events: unknown[] = [];
      let used = 0;
      let truncated = false;
      let nextEventId: string | undefined;

      for (const evt of slice) {
        const size = JSON.stringify(evt).length;
        if (
          (maxEvents !== undefined && events.length >= maxEvents) ||
          (events.length > 0 && used + size > charBudget)
        ) {
          truncated = true;
          nextEventId = evt.id;
          break;
        }
        events.push(evt);
        used += size;
      }

      const out: CodexWorkerDebugTraceOutput = {
        workerId,
        events,
        nextEventId,
        eventsPath: record.artifactPaths.eventsNdjson,
        truncated,
      };
      return ok(out);
    },
  );

  return server;
}

/* ════════════════════════════════════════════════════════════════════════
 * waitFor application
 * ════════════════════════════════════════════════════════════════════════ */

/** Await the requested lifecycle point, bounded by an optional timeout. */
async function applyWaitFor(
  runtime: WorkerRuntime,
  waitFor: NonNullable<CodexWorkerStartInput["waitFor"]>,
  timeoutMs: number | undefined,
): Promise<void> {
  if (waitFor === "started") return;

  const budget = timeoutMs ?? DEFAULT_COMPLETED_TIMEOUT_MS;

  const wait =
    waitFor === "first_message"
      ? runtime.waitForFirstMessage()
      : waitFor === "idle"
        ? runtime.waitForIdle()
        : runtime.waitForCompleted();

  await withTimeout(wait, budget);

  // Reflect the settled state once the active turn has ended.
  if (waitFor === "completed" || waitFor === "idle") {
    if (runtime.adapter.turnId === undefined && runtime.hasTurnEnded()) {
      // waitFor:"completed" is an explicit signal that the caller treats this
      // worker as finished — land in the §13 terminal "completed" state so
      // §17.3 (steering rejected) and §19 (final-result) hold. waitFor:"idle"
      // keeps the worker steerable between turns (§17.2) by landing in "idle".
      runtime.safeTransition(waitFor === "completed" ? "completed" : "idle");
    }
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * Result + error helpers
 * ════════════════════════════════════════════════════════════════════════ */

/** Shape of the structured payload an MCP tool returns to the client. */
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

/** Wrap a success payload as an MCP tool result (text + structuredContent). */
function ok(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/** Wrap a structured failure payload (§32) as an MCP error tool result. */
function failure(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

/** §32 "Codex is unavailable" failure shaped like a start output. */
function unavailableStart(workerId: string, runId: string): Record<string, unknown> {
  return {
    workerId,
    runId,
    state: "failed",
    error: UNAVAILABLE_ERROR,
    recovery: UNAVAILABLE_RECOVERY,
  };
}

/** Uniform "unknown worker" failure payload. */
function unknownWorker(workerId: string): Record<string, unknown> {
  return {
    workerId,
    state: "failed",
    error: `Unknown worker "${workerId}"`,
    recovery: "Start the worker with codex_worker_start before referencing it.",
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * Small utilities
 * ════════════════════════════════════════════════════════════════════════ */

/** True for §13 terminal worker states. */
function isTerminalState(state: WorkerState): boolean {
  return state === "completed" || state === "interrupted" || state === "failed";
}

/** Clamp a caller-supplied char budget to the spec §33 hard maximum. */
function clampCharBudget(requested: number | undefined, hardMax: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return hardMax;
  }
  return Math.min(Math.floor(requested), hardMax);
}

/** Resolve a worker cwd against the project dir; default to the project dir. */
function resolveCwd(cwd: string | undefined): string {
  if (cwd === undefined || cwd.length === 0) return config.projectDir;
  return cwd;
}

/**
 * Build the worker prompt. The §30 task contract is supplied by the caller in
 * `task`; any extra `instructions` were already passed to `thread/start` as
 * base instructions, so the turn input is just the task text.
 */
function buildTaskPrompt(input: CodexWorkerStartInput): string {
  return input.task;
}

/** Persist the current worker record + manifest row to disk (best-effort). */
async function persistRecord(
  store: ArtifactStore,
  registry: WorkerRegistry,
  workerId: string,
): Promise<void> {
  const record = registry.get(workerId);
  if (!record) return;
  try {
    await store.writeWorkerJson(record);
    await store.updateManifest(record);
  } catch (err) {
    logger.warn("failed to persist worker record", err);
  }
}

/** Summarize a unified diff into a compact +adds/-dels per-file overview. */
function summarizeDiff(diff: string): string {
  const lines = diff.split("\n");
  const files: Array<{ path: string; added: number; removed: number }> = [];
  let current: { path: string; added: number; removed: number } | undefined;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const parts = line.split(" ");
      const bPath = parts[parts.length - 1] ?? "";
      const path = bPath.replace(/^b\//, "");
      current = { path, added: 0, removed: 0 };
      files.push(current);
    } else if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    } else if (current && line.startsWith("+")) {
      current.added += 1;
    } else if (current && line.startsWith("-")) {
      current.removed += 1;
    }
  }

  if (files.length === 0) {
    return "## Diff Summary\n\n_No file changes detected in the diff._";
  }
  const rows = files.map(
    (f) => `- \`${f.path}\`: +${f.added} / -${f.removed}`,
  );
  return ["## Diff Summary", "", ...rows].join("\n");
}

/** Last error-typed transcript line for status.error, if any. */
function lastErrorText(runtime: WorkerRuntime): string | undefined {
  const messages = runtime.getMessages();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.type === "error") return m.text;
  }
  return undefined;
}

/** Race a promise against a timeout; resolves (does not reject) on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger.debug(`waitFor timed out after ${ms}ms`);
      resolve();
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeout,
  ]);
}

/** Promise that resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
}

/** Call a zero-arg function, swallowing and logging any throw. */
function safeCall(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logger.error("waitFor waiter threw", err);
  }
}

/** Narrow an unknown value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
