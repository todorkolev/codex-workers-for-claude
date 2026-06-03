/**
 * Codex app-server adapter — the bridge's transport to a single `codex
 * app-server` child process and one Codex thread.
 *
 * Process model (protocol doc "Concurrency / lifecycle notes"): ONE
 * `codex app-server` child per adapter/worker. This gives clean isolation —
 * a single thread, isolated stderr, and a clean kill on interrupt/dispose.
 *
 * Wire format (protocol doc "Transport"): NEWLINE-DELIMITED JSON-RPC over
 * stdio. Each line on the child's stdout is exactly one JSON object:
 *   - `{ id, result }` / `{ id, error }`, no `method`  → response to our request
 *   - `{ method, params }`, no `id`                    → notification
 *   - `{ method, id, params }`                         → server-initiated
 *                                                        request (approval)
 *
 * Defensive parsing: Codex versions change. `JSON.parse` is always wrapped;
 * unknown methods / unexpected shapes are logged and forwarded raw but NEVER
 * crash the bridge. stdout of THIS process is reserved for the MCP protocol —
 * we only ever log to stderr (via the shared logger).
 *
 * Local-import convention: extensionless (bundler moduleResolution + esbuild).
 */

import {
  spawn,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { Readable } from "node:stream";
import * as readline from "node:readline";
import {
  type AdapterThreadOptions,
  type CodexAdapter,
  type CodexAvailability,
  type CodexServerRequest,
} from "./types";
import { logger } from "./logger";

/* ────────────────────────────────────────────────────────────────────────
 * Internal wire helpers (kept minimal; we read the vendored bindings for the
 * authoritative shapes and parse everything defensively).
 * ──────────────────────────────────────────────────────────────────────── */

/** A pending JSON-RPC request awaiting its `{ id, result|error }` response. */
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  method: string;
};

/** A JSON-RPC id (we always send numbers; the protocol allows strings too). */
type JsonRpcId = number | string;

/** A `text` user input element (protocol doc "UserInput shape"). */
function textInput(text: string): Array<{ type: "text"; text: string; text_elements: [] }> {
  return [{ type: "text", text, text_elements: [] }];
}

/** Map our `sandboxPolicy` to the Codex `SandboxMode` wire string. */
function toSandboxMode(
  policy: AdapterThreadOptions["sandboxPolicy"],
): "read-only" | "workspace-write" | "danger-full-access" {
  // Spec maps all three strings 1:1 onto Codex SandboxMode. "danger-full-access"
  // runs Codex unsandboxed (no bwrap/namespace, no command approval) and is only
  // ever reached when the caller explicitly opts in (see safety.resolveDefaults).
  return policy;
}

/** Narrow an unknown value to a plain record without throwing. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/** Read a string property from an unknown record, or `undefined`. */
function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/* ────────────────────────────────────────────────────────────────────────
 * Adapter implementation
 * ──────────────────────────────────────────────────────────────────────── */

/** Options for constructing a {@link CodexAppServerAdapter}. */
export type CodexAdapterOptions = {
  /** Working directory for the child `codex app-server` (worker cwd/worktree). */
  cwd: string;
  /** Version string reported in the `initialize` handshake (clientInfo.version). */
  version: string;
  /** Override the `codex` executable path/name (defaults to "codex"). */
  codexBin?: string;
};

const CLIENT_NAME = "codex-workers";
const CLIENT_TITLE = "Codex Workers for Claude";

/**
 * Owns one `codex app-server` child process and one Codex thread. Implements
 * {@link CodexAdapter}; see that interface (and the protocol doc) for the
 * contract behind every method.
 */
export class CodexAppServerAdapter implements CodexAdapter {
  private readonly cwd: string;
  private readonly version: string;
  private readonly codexBin: string;

  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutReader: readline.Interface | undefined;
  private stderrReader: readline.Interface | undefined;

  /** Monotonic JSON-RPC request id counter. */
  private nextId = 1;
  /** In-flight requests keyed by id. */
  private readonly pending = new Map<JsonRpcId, PendingRequest>();

  private readonly rawMessageCbs: Array<(msg: unknown) => void> = [];
  private readonly serverRequestCbs: Array<(req: CodexServerRequest) => void> = [];
  private readonly stderrCbs: Array<(line: string) => void> = [];

  private _threadId: string | undefined;
  private _turnId: string | undefined;
  private _lastFinalMessage: string | undefined;
  /** Reasoning effort to apply on every `turn/start` (set via startThread/resumeThread). */
  private _effort: AdapterThreadOptions["effort"];

  /** Resolvers waiting for the current turn to end (turn/completed or error). */
  private turnEndWaiters: Array<() => void> = [];

  private disposed = false;
  /** Set once the child exits; rejects any subsequent/in-flight requests. */
  private exitError: Error | undefined;

  constructor(opts: CodexAdapterOptions) {
    this.cwd = opts.cwd;
    this.version = opts.version;
    this.codexBin = opts.codexBin ?? "codex";
  }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  async init(): Promise<void> {
    if (this.child) {
      throw new Error("CodexAppServerAdapter.init() already called");
    }

    const child = spawn(this.codexBin, ["app-server"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.on("error", (err) => {
      // Spawn failure (e.g. codex not on PATH) or runtime process error.
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error("codex app-server process error:", error);
      this.failAll(error);
    });

    child.on("exit", (code, signal) => {
      logger.info(
        `codex app-server exited (code=${String(code)} signal=${String(signal)})`,
      );
      const reason =
        this.disposed
          ? "codex app-server disposed"
          : `codex app-server exited (code=${String(code)} signal=${String(signal)})`;
      this.failAll(new Error(reason));
    });

    // Line-oriented stdout: each line is one JSON-RPC message.
    this.stdoutReader = readline.createInterface({ input: child.stdout });
    this.stdoutReader.on("line", (line) => this.handleStdoutLine(line));

    // Line-oriented stderr: warnings (bubblewrap notes, etc.) → onStderr.
    this.stderrReader = readline.createInterface({ input: child.stderr });
    this.stderrReader.on("line", (line) => {
      if (line.length === 0) return;
      for (const cb of this.stderrCbs) {
        try {
          cb(line);
        } catch (err) {
          logger.error("onStderr callback threw:", err);
        }
      }
    });

    // Handshake. Protocol doc "Handshake": send `initialize`, await result.
    await this.request("initialize", {
      clientInfo: {
        name: CLIENT_NAME,
        title: CLIENT_TITLE,
        version: this.version,
      },
      capabilities: null,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    this.stdoutReader?.close();
    this.stderrReader?.close();

    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.failAll(new Error("codex app-server disposed"));
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("exit", done);
      try {
        child.kill("SIGTERM");
      } catch (err) {
        logger.warn("error sending SIGTERM to codex app-server:", err);
        done();
        return;
      }
      // Escalate to SIGKILL if it does not exit promptly.
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        done();
      }, 2000);
      if (typeof timer.unref === "function") timer.unref();
    });

    this.failAll(new Error("codex app-server disposed"));
  }

  /* ── thread / turn control ─────────────────────────────────────────── */

  async startThread(opts: AdapterThreadOptions): Promise<string> {
    // `thread/start` does not accept `effort` (ReasoningEffort is a turn/start
    // param per v2/TurnStartParams.ts). Carry it onto adapter state so every
    // turn/start applies it.
    this._effort = opts.effort;

    const result = await this.request("thread/start", {
      cwd: opts.cwd,
      sandbox: toSandboxMode(opts.sandboxPolicy),
      approvalPolicy: opts.approvalPolicy,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.instructions !== undefined
        ? { baseInstructions: opts.instructions }
        : {}),
    });

    const threadId = this.extractThreadId(result);
    if (threadId === undefined) {
      throw new Error("thread/start response missing thread.id");
    }
    this._threadId = threadId;
    return threadId;
  }

  async resumeThread(threadId: string, opts: AdapterThreadOptions): Promise<void> {
    this._effort = opts.effort;

    const result = await this.request("thread/resume", {
      threadId,
      cwd: opts.cwd,
      sandbox: toSandboxMode(opts.sandboxPolicy),
      approvalPolicy: opts.approvalPolicy,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.instructions !== undefined
        ? { baseInstructions: opts.instructions }
        : {}),
    });

    // The resume response echoes the thread; keep our id authoritative but
    // refresh from the response when present.
    this._threadId = this.extractThreadId(result) ?? threadId;
  }

  async startTurn(text: string): Promise<string> {
    const threadId = this.requireThread();
    // effort (ReasoningEffort) is a turn/start param; the protocol maps our
    // "low"|"medium"|"high" strings 1:1, so no remapping is needed.
    const result = await this.request("turn/start", {
      threadId,
      input: textInput(text),
      ...(this._effort !== undefined ? { effort: this._effort } : {}),
    });

    const turnId = this.extractTurnId(result);
    if (turnId === undefined) {
      throw new Error("turn/start response missing turn.id");
    }
    // The turn finishes ASYNC via a `turn/completed` notification — we return
    // immediately and do NOT block on completion here.
    this._turnId = turnId;
    return turnId;
  }

  async startTurnIfIdle(text: string): Promise<string> {
    // Steering an idle worker is a fresh turn on the existing thread.
    return this.startTurn(text);
  }

  async steerTurn(text: string, expectedTurnId: string): Promise<void> {
    const threadId = this.requireThread();
    const result = await this.request("turn/steer", {
      threadId,
      input: textInput(text),
      expectedTurnId,
    });

    // `turn/steer` echoes the (possibly new) active turn id.
    const rec = asRecord(result);
    const turnId = rec ? readString(rec["turnId"]) : undefined;
    if (turnId !== undefined) {
      this._turnId = turnId;
    }
  }

  async interruptTurn(): Promise<void> {
    const threadId = this._threadId;
    const turnId = this._turnId;
    if (threadId === undefined || turnId === undefined) {
      // Nothing in flight to interrupt; treat as a no-op.
      return;
    }

    // Arm a waiter BEFORE sending so we never miss the terminal notification.
    const ended = this.waitForTurnEnd();
    try {
      await this.request("turn/interrupt", { threadId, turnId });
    } catch (err) {
      // The interrupt request itself may race with turn completion; log and
      // still await the terminal notification below.
      logger.warn("turn/interrupt request rejected:", err);
    }

    // Await the `turn/completed`/`error` so callers see a settled turn. Keep
    // the child alive (the thread can be resumed/steered later, spec §20.4).
    await ended;
  }

  /* ── inbound routing ───────────────────────────────────────────────── */

  private handleStdoutLine(line: string): void {
    if (line.trim().length === 0) return;

    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      // Never crash on malformed output — Codex may emit non-JSON noise.
      logger.warn("dropping non-JSON line from codex app-server:", err, line);
      return;
    }

    const rec = asRecord(msg);
    if (!rec) {
      logger.warn("dropping non-object JSON-RPC message:", line);
      return;
    }

    const hasId = "id" in rec && rec["id"] !== null && rec["id"] !== undefined;
    const hasMethod = typeof rec["method"] === "string";
    const hasResultOrError = "result" in rec || "error" in rec;

    // Forward EVERY raw inbound message so the store persists all of them
    // (protocol doc: "persist ALL raw inbound lines"). Do this first and
    // defensively — a buggy subscriber must not drop the message routing.
    this.emitRaw(msg);

    if (hasId && hasMethod) {
      // Server-initiated request (approval / elicitation): has BOTH id+method.
      this.routeServerRequest(rec);
      return;
    }

    if (hasId && hasResultOrError && !hasMethod) {
      // Response to one of our requests.
      this.settlePending(rec);
      return;
    }

    if (hasMethod) {
      // Notification (no id). Track turn lifecycle / final message; the raw
      // form was already forwarded above for normalization/persistence.
      this.handleNotification(rec["method"] as string, rec["params"]);
      return;
    }

    // Unknown shape — already forwarded raw; nothing else to do.
    logger.debug("unrecognized JSON-RPC message shape:", line);
  }

  private routeServerRequest(rec: Record<string, unknown>): void {
    const id = rec["id"];
    const method = rec["method"];
    if (
      (typeof id !== "number" && typeof id !== "string") ||
      typeof method !== "string"
    ) {
      logger.warn("malformed server request (bad id/method):", rec);
      return;
    }
    const req: CodexServerRequest = { id, method, params: rec["params"] };
    for (const cb of this.serverRequestCbs) {
      try {
        cb(req);
      } catch (err) {
        logger.error("onServerRequest callback threw:", err);
      }
    }
  }

  private settlePending(rec: Record<string, unknown>): void {
    const id = rec["id"] as JsonRpcId;
    const pending = this.pending.get(id);
    if (!pending) {
      logger.warn("response for unknown request id:", id);
      return;
    }
    this.pending.delete(id);

    if ("error" in rec && rec["error"] !== undefined && rec["error"] !== null) {
      const errRec = asRecord(rec["error"]);
      const message = errRec ? (readString(errRec["message"]) ?? "") : "";
      const code = errRec ? errRec["code"] : undefined;
      pending.reject(
        new Error(
          `codex ${pending.method} failed: ${message || "unknown error"}` +
            (code !== undefined ? ` (code ${String(code)})` : ""),
        ),
      );
      return;
    }

    pending.resolve(rec["result"]);
  }

  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case "turn/started": {
        // (Re)capture the active turn id so it survives a retryable error that
        // momentarily cleared it (protocol doc: turn/started → { threadId, turn }).
        const p = asRecord(params);
        const turn = p ? asRecord(p["turn"]) : undefined;
        const turnId = turn ? readString(turn["id"]) : undefined;
        if (turnId !== undefined) this._turnId = turnId;
        break;
      }
      case "item/completed": {
        // Track the most recent completed `agentMessage` as the final message.
        const p = asRecord(params);
        const item = p ? asRecord(p["item"]) : undefined;
        if (item && item["type"] === "agentMessage") {
          const text = readString(item["text"]);
          if (text !== undefined) this._lastFinalMessage = text;
        }
        break;
      }
      case "turn/completed": {
        // Terminal: clear active turn, release any interrupt waiters.
        this._turnId = undefined;
        this.resolveTurnEnd();
        break;
      }
      case "error": {
        // A turn-level error ends the turn ONLY when it is not retryable. When
        // `willRetry === true`, Codex retries the SAME turn and a later
        // turn/completed will arrive — keep _turnId and do NOT release waiters
        // (protocol doc: error → { error, willRetry, threadId, turnId };
        // v2/ErrorNotification.ts: willRetry: boolean).
        const p = asRecord(params);
        if (p && p["willRetry"] === true) break;
        this._turnId = undefined;
        this.resolveTurnEnd();
        break;
      }
      default:
        // Unknown / low-value notification — already forwarded raw. Ignore.
        break;
    }
  }

  /* ── subscriptions / responses ─────────────────────────────────────── */

  onRawMessage(cb: (msg: unknown) => void): void {
    this.rawMessageCbs.push(cb);
  }

  onServerRequest(cb: (req: CodexServerRequest) => void): void {
    this.serverRequestCbs.push(cb);
  }

  onStderr(cb: (line: string) => void): void {
    this.stderrCbs.push(cb);
  }

  respond(id: JsonRpcId, result: unknown): void {
    // Answer a server-initiated request with `{ id, result }`.
    this.write({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    // Fail-closed on an unsupported server request with a JSON-RPC error so
    // Codex can fall back (never a fabricated `result` body it cannot read).
    this.write({ id, error: { code, message } });
  }

  /* ── readonly accessors ────────────────────────────────────────────── */

  get threadId(): string | undefined {
    return this._threadId;
  }

  get turnId(): string | undefined {
    return this._turnId;
  }

  get lastFinalMessage(): string | undefined {
    return this._lastFinalMessage;
  }

  /* ── private plumbing ──────────────────────────────────────────────── */

  /** Send a JSON-RPC request and await its response. */
  private request(method: string, params: unknown): Promise<unknown> {
    if (this.exitError) {
      return Promise.reject(this.exitError);
    }
    if (!this.child) {
      return Promise.reject(
        new Error(`cannot send ${method}: adapter not initialized`),
      );
    }

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Serialize one JSON-RPC message and write it as a single newline line. */
  private write(message: unknown): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      throw new Error("codex app-server stdin is not writable");
    }
    const line = `${JSON.stringify(message)}\n`;
    child.stdin.write(line);
  }

  private emitRaw(msg: unknown): void {
    for (const cb of this.rawMessageCbs) {
      try {
        cb(msg);
      } catch (err) {
        logger.error("onRawMessage callback threw:", err);
      }
    }
  }

  private requireThread(): string {
    const threadId = this._threadId;
    if (threadId === undefined) {
      throw new Error("no Codex thread started; call startThread() first");
    }
    return threadId;
  }

  /** Resolve a promise once the current turn reaches a terminal notification. */
  private waitForTurnEnd(): Promise<void> {
    if (this._turnId === undefined) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.turnEndWaiters.push(resolve);
    });
  }

  private resolveTurnEnd(): void {
    const waiters = this.turnEndWaiters;
    this.turnEndWaiters = [];
    for (const resolve of waiters) {
      try {
        resolve();
      } catch (err) {
        logger.error("turn-end waiter threw:", err);
      }
    }
  }

  /** Reject all in-flight requests and release turn waiters on exit/dispose. */
  private failAll(error: Error): void {
    if (!this.exitError) this.exitError = error;
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of pending) {
      try {
        p.reject(error);
      } catch (err) {
        logger.error("error rejecting pending request:", err);
      }
    }
    this.resolveTurnEnd();
  }

  /** Pull `result.thread.id` defensively from a thread response. */
  private extractThreadId(result: unknown): string | undefined {
    const rec = asRecord(result);
    const thread = rec ? asRecord(rec["thread"]) : undefined;
    return thread ? readString(thread["id"]) : undefined;
  }

  /** Pull `result.turn.id` defensively from a turn response. */
  private extractTurnId(result: unknown): string | undefined {
    const rec = asRecord(result);
    const turn = rec ? asRecord(rec["turn"]) : undefined;
    return turn ? readString(turn["id"]) : undefined;
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Availability probe (spec §32, protocol doc "Errors / availability")
 * ──────────────────────────────────────────────────────────────────────── */

const UNAVAILABLE_RECOVERY =
  "Check that Codex CLI is installed and logged in (codex login).";

/**
 * Fail-fast probe that the Codex CLI is installed and logged in. Never throws.
 *
 * We verify login via `codex login status` (prints e.g. "Logged in using
 * ChatGPT"). A missing binary surfaces as a spawn `error` / non-zero exit.
 */
export const checkCodexAvailable: () => Promise<CodexAvailability> = () =>
  new Promise<CodexAvailability>((resolve) => {
    let settled = false;
    const finish = (value: CodexAvailability): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn("codex", ["login", "status"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (err) {
      finish({
        available: false,
        error: "Codex is unavailable",
        recovery: UNAVAILABLE_RECOVERY,
      });
      logger.warn("failed to spawn `codex login status`:", err);
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    // Guard against a hung process.
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish({
        available: false,
        error: "Codex is unavailable",
        recovery: UNAVAILABLE_RECOVERY,
      });
    }, 10000);
    if (typeof timer.unref === "function") timer.unref();

    child.on("error", () => {
      clearTimeout(timer);
      // ENOENT etc. — `codex` not on PATH.
      finish({
        available: false,
        error: "Codex is unavailable",
        recovery: UNAVAILABLE_RECOVERY,
      });
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`.toLowerCase();
      const loggedIn =
        code === 0 || combined.includes("logged in");
      if (loggedIn) {
        finish({ available: true });
        return;
      }
      finish({
        available: false,
        error: "Codex is unavailable",
        recovery: UNAVAILABLE_RECOVERY,
      });
    });
  });
