/**
 * Transcript filter — pure, synchronous mapping of raw Codex `app-server`
 * messages into the bridge's version-stable {@link NormalizedCodexEvent} shape,
 * plus the §22 forwarding rules, §16 render rules, and the §23 command summary.
 *
 * This module performs NO I/O. It NEVER throws on malformed input: unknown
 * methods, missing fields, or wrong types collapse to a `"unknown"` event (or
 * are skipped where the §22 table says to drop them). The Codex wire shapes
 * mirrored here are taken from `docs/codex-app-server-protocol.md` and the
 * generated bindings (regenerate with `codex app-server generate-ts --out <dir>`;
 * notably `v2/ThreadItem.ts`, `v2/TurnPlanUpdatedNotification.ts`,
 * `v2/TurnDiffUpdatedNotification.ts`, `v2/ErrorNotification.ts`,
 * `v2/CommandExecutionStatus.ts`, `v2/FileUpdateChange.ts`).
 *
 * Local-import convention (bundler moduleResolution + esbuild): extensionless.
 */

import type {
  NormalizedCodexEvent,
  NormalizedCodexEventType,
  NormalizeContext,
  RenderedMessage,
  TranscriptFilter,
  TranscriptMode,
} from "./types";

/* ────────────────────────────────────────────────────────────────────────
 * Determinism context
 *
 * The {@link TranscriptFilter} interface fixes the normalize signature as
 * `(raw, ctx: NormalizeContext)`. To keep `normalizeRawMessage` PURE and
 * deterministic, callers supply a monotonic id source and a clock through
 * extra (structurally-optional) fields on the context object. Reading them is
 * defensive: when absent we fall back to a best-effort id and the wall clock.
 * ──────────────────────────────────────────────────────────────────────── */

/** Context accepted by {@link TranscriptFilterImpl.normalizeRawMessage}. */
export type NormalizeContextExt = NormalizeContext & {
  /** Stable, monotonic event id for this normalized event (caller-controlled). */
  id?: string;
  /** Deterministic clock returning an ISO-8601 timestamp. */
  now?: () => string;
};

/* ────────────────────────────────────────────────────────────────────────
 * Defensive accessors — never throw, never assume a shape.
 * ──────────────────────────────────────────────────────────────────────── */

/** True only for non-null plain objects (records we can index by string). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a string field, or `undefined` if absent / not a string. */
function str(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

/** Read a finite-number field, or `undefined` if absent / not a number. */
function num(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Read a nested record field, or `undefined`. */
function rec(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = obj[key];
  return isRecord(value) ? value : undefined;
}

/** Read an array field, or `undefined`. */
function arr(obj: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = obj[key];
  return Array.isArray(value) ? value : undefined;
}

/* ────────────────────────────────────────────────────────────────────────
 * Implementation
 * ──────────────────────────────────────────────────────────────────────── */

/** Concrete, stateless {@link TranscriptFilter}. Safe to share as a singleton. */
export class TranscriptFilterImpl implements TranscriptFilter {
  /**
   * Map one raw inbound JSON-RPC message to a {@link NormalizedCodexEvent}
   * (spec §22). Dispatches on `method`; for `item/started` / `item/completed`
   * it further dispatches on `item.type` (protocol doc "ThreadItem"). Anything
   * unrecognized — or any non-object input — becomes a `"unknown"` event with
   * the raw payload preserved in `data` so nothing is ever lost.
   */
  normalizeRawMessage(
    raw: unknown,
    ctx: NormalizeContext,
  ): NormalizedCodexEvent {
    const ext = ctx as NormalizeContextExt;
    const id =
      typeof ext.id === "string" && ext.id.length > 0 ? ext.id : "evt-unknown";
    const timestamp =
      typeof ext.now === "function" ? ext.now() : new Date().toISOString();

    const base = {
      id,
      timestamp,
      workerId: ctx.workerId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
    };

    // Non-object inbound line (parse failure upstream, primitives, arrays).
    if (!isRecord(raw)) {
      return {
        ...base,
        rawType: typeof raw,
        normalizedType: "unknown",
        data: raw,
      };
    }

    const method = str(raw, "method");
    const params = rec(raw, "params");

    // A response or any line without a method is not a forwardable event.
    if (method === undefined) {
      return {
        ...base,
        rawType: rec(raw, "result") !== undefined ? "response" : "unknown",
        normalizedType: "unknown",
        data: raw,
      };
    }

    // Carry the real thread/turn ids from the payload when present; they are
    // more authoritative than the caller-provided context for streamed events.
    const threadId = (params && str(params, "threadId")) ?? base.threadId;
    const turnId =
      (params && (str(params, "turnId") ?? str(params, "turn_id"))) ??
      base.turnId;
    const ev = { ...base, threadId, turnId, rawType: method };

    switch (method) {
      /* ── Status-class notifications ─────────────────────────────────── */
      case "thread/started":
      case "thread/status/changed":
      case "turn/started":
        return {
          ...ev,
          normalizedType: "status",
          text: this.statusText(method, params),
          data: params ?? raw,
        };

      /* ── Turn lifecycle ─────────────────────────────────────────────── */
      case "turn/completed":
        return {
          ...ev,
          normalizedType: "turn_completed",
          data: params ?? raw,
        };

      /* ── Plan updates ───────────────────────────────────────────────── */
      case "turn/plan/updated":
      case "item/plan/delta":
        return {
          ...ev,
          normalizedType: "plan_update",
          text: params ? this.planText(params) : undefined,
          data: params ?? raw,
        };

      /* ── Diff updates ───────────────────────────────────────────────── */
      case "turn/diff/updated":
        return {
          ...ev,
          normalizedType: "diff_available",
          text: params ? str(params, "diff") : undefined,
          data: params ?? raw,
        };

      /* ── Streaming agent message deltas ─────────────────────────────── */
      case "item/agentMessage/delta":
        return {
          ...ev,
          normalizedType: "agent_message_delta",
          text: params ? str(params, "delta") : undefined,
          data: params ?? raw,
        };

      /* ── Streaming command output ───────────────────────────────────── */
      case "item/commandExecution/outputDelta":
      case "command/exec/outputDelta":
      case "process/outputDelta":
        return {
          ...ev,
          normalizedType: "command_output",
          data: params ?? raw,
        };

      /* ── File-change streaming (patch updates) ──────────────────────── */
      case "item/fileChange/patchUpdated":
      case "item/fileChange/outputDelta":
        return {
          ...ev,
          normalizedType: "file_changed",
          text: params ? this.fileChangedText(params) : undefined,
          data: params ?? raw,
        };

      /* ── Background process lifecycle ───────────────────────────────── */
      case "process/exited":
        return {
          ...ev,
          normalizedType: "command_completed",
          data: params ?? raw,
        };

      /* ── Reasoning streams: low value → status, normally dropped ────── */
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/summaryPartAdded":
        return { ...ev, normalizedType: "status", data: params ?? raw };

      /* ── Turn-level error ───────────────────────────────────────────── */
      case "error":
        return {
          ...ev,
          normalizedType: "error",
          text: params ? this.errorText(params) : undefined,
          data: params ?? raw,
        };

      /* ── Item lifecycle: dispatch on item.type ──────────────────────── */
      case "item/started":
        return this.normalizeItem(ev, params, "started", raw);
      case "item/completed":
        return this.normalizeItem(ev, params, "completed", raw);

      default:
        break;
    }

    /* ── Server-initiated approval requests ───────────────────────────── */
    if (this.isApprovalMethod(method)) {
      return {
        ...ev,
        normalizedType: "approval_request",
        text: this.approvalText(method, params),
        data: params ?? raw,
      };
    }

    // Everything else (configWarning, tokenUsage, mcp/account chatter, …):
    // store raw, never forward.
    return { ...ev, normalizedType: "unknown", data: params ?? raw };
  }

  /**
   * Decide whether a normalized event is forwarded to Claude for `mode`,
   * implementing the spec §22 forwarding-rules table across all three modes.
   *
   * - `messages`               — only user-visible messages.
   * - `messages_plus_artifacts`— messages + artifact-class events (file/diff),
   *   plus the "summary only" command lifecycle (command output is still
   *   dropped; the summary is built separately via {@link summarizeCommands}).
   * - `full_events`            — forward everything that was stored.
   */
  shouldForward(evt: NormalizedCodexEvent, mode: TranscriptMode): boolean {
    if (mode === "full_events") {
      // Debug mode: forward every stored event verbatim.
      return true;
    }

    const t = evt.normalizedType;

    // Always-forwarded user-visible messages (both non-debug modes). The §22
    // table marks "status" as "maybe" for `messages`; we forward it (it is a
    // user-visible state change) but renderMessage drops empty/no-text ones.
    switch (t) {
      case "agent_message":
      case "plan_update":
      case "status":
      case "approval_request":
      case "error":
      case "turn_completed":
        return true;
      default:
        break;
    }

    if (mode === "messages") {
      // messages: nothing else (no deltas, no command/file/diff events).
      return false;
    }

    // messages_plus_artifacts: add artifact-class events. Command lifecycle is
    // "summary only" — the compact summary is produced by summarizeCommands(),
    // not by forwarding individual command_started/command_completed lines, so
    // those are NOT forwarded here. Raw command output is never forwarded.
    switch (t) {
      case "file_changed":
      case "diff_available":
        return true;
      default:
        return false;
    }
  }

  /**
   * Render a forwardable event as a single transcript line (spec §16 message
   * shape), or `null` to drop it. `type` is constrained to
   * `message | plan | status | final | error`; command/file/diff/delta events
   * have no user-facing line and return `null`.
   */
  renderMessage(evt: NormalizedCodexEvent): RenderedMessage | null {
    const make = (
      type: RenderedMessage["type"],
      text: string | undefined,
    ): RenderedMessage | null => {
      const trimmed = (text ?? "").trim();
      if (trimmed.length === 0) return null;
      return {
        id: evt.id,
        timestamp: evt.timestamp,
        role: "codex",
        type,
        text: trimmed,
      };
    };

    switch (evt.normalizedType) {
      case "agent_message":
        return make("message", evt.text);
      case "plan_update":
        return make("plan", evt.text);
      case "status":
        return make("status", evt.text);
      case "approval_request":
        // Surface approvals as a status line so Claude has visibility even
        // though the safety layer auto-decides.
        return make("status", evt.text ?? "Codex requested an approval.");
      case "error":
        return make("error", evt.text ?? "Codex reported an error.");
      case "turn_completed":
        // The final answer is carried as an agent_message; the bare
        // turn_completed marker is not itself user-facing.
        return null;
      default:
        // deltas, command_*, file_changed, diff_available, unknown.
        return null;
    }
  }

  /**
   * Build the compact "## Command Summary" markdown (spec §23) from the
   * commandExecution events in `events`. Lists each command with a pass/fail
   * derived from its exit code (0 ⇒ passed, non-zero ⇒ failed, unknown ⇒
   * unknown). NEVER includes raw command output — that lives in `events.ndjson`.
   */
  summarizeCommands(events: NormalizedCodexEvent[]): string {
    type Row = { command: string; status: "passed" | "failed" | "unknown" };
    const rows: Row[] = [];

    for (const evt of events) {
      if (
        evt.normalizedType !== "command_started" &&
        evt.normalizedType !== "command_completed"
      ) {
        continue;
      }
      const data = isRecord(evt.data) ? evt.data : undefined;
      const item = data ? rec(data, "item") : undefined;

      const command =
        (item && str(item, "command")) ??
        (data && str(data, "command")) ??
        evt.text;
      if (command === undefined || command.trim().length === 0) continue;

      const status = this.commandStatus(item, data);

      if (evt.normalizedType === "command_started") {
        // Only record a "started" row if no completion will cover it; we add
        // it provisionally and let a later "completed" with the same command
        // upgrade the status.
        const existing = rows.find((r) => r.command === command.trim());
        if (!existing) rows.push({ command: command.trim(), status });
        else if (existing.status === "unknown") existing.status = status;
      } else {
        // command_completed: authoritative status.
        const existing = rows.find(
          (r) => r.command === command.trim() && r.status === "unknown",
        );
        if (existing) existing.status = status;
        else rows.push({ command: command.trim(), status });
      }
    }

    const lines = ["## Command Summary", ""];
    if (rows.length === 0) {
      lines.push("_No commands were executed._");
      return lines.join("\n");
    }
    for (const row of rows) {
      lines.push(`- \`${row.command}\`: ${row.status}`);
    }
    lines.push("");
    lines.push("Full output stored in `events.ndjson`.");
    return lines.join("\n");
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Internal helpers
   * ──────────────────────────────────────────────────────────────────── */

  /** Dispatch `item/started` | `item/completed` by `params.item.type`. */
  private normalizeItem(
    ev: {
      id: string;
      timestamp: string;
      workerId: string;
      threadId?: string;
      turnId?: string;
      rawType: string;
    },
    params: Record<string, unknown> | undefined,
    phase: "started" | "completed",
    raw: unknown,
  ): NormalizedCodexEvent {
    const item = params ? rec(params, "item") : undefined;
    const unknownItem: NormalizedCodexEvent = {
      ...ev,
      normalizedType: "unknown",
      data: params ?? raw,
    };
    if (item === undefined) return unknownItem;

    const itemType = str(item, "type");
    const map = (
      normalizedType: NormalizedCodexEventType,
      text?: string,
    ): NormalizedCodexEvent => ({
      ...ev,
      normalizedType,
      text,
      data: params,
    });

    switch (itemType) {
      case "agentMessage":
        // The authoritative "Codex said" message lands on item/completed.
        return phase === "completed"
          ? map("agent_message", str(item, "text"))
          : // A started agentMessage has no settled text yet → low-value status.
            map("status");

      case "plan":
        return map("plan_update", str(item, "text"));

      case "reasoning":
        // Reasoning is low value; map to status (renderMessage drops empties).
        return map("status");

      case "commandExecution":
        return phase === "started"
          ? map("command_started", str(item, "command"))
          : map("command_completed", str(item, "command"));

      case "fileChange":
        return phase === "completed"
          ? map("file_changed", this.fileChangedText(item))
          : map("file_changed", this.fileChangedText(item));

      case "userMessage":
        // Echo of our own input — not a Codex message.
        return map("status");

      case "webSearch":
      case "mcpToolCall":
      case "dynamicToolCall":
      case "collabAgentToolCall":
      case "imageView":
      case "imageGeneration":
      case "enteredReviewMode":
      case "exitedReviewMode":
      case "contextCompaction":
      case "hookPrompt":
        // Tool/infra items: stored raw, mapped to status, generally dropped.
        return map("status");

      default:
        return unknownItem;
    }
  }

  /** True for any server-initiated approval-request method. */
  private isApprovalMethod(method: string): boolean {
    switch (method) {
      case "execCommandApproval":
      case "item/commandExecution/requestApproval":
      case "applyPatchApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
        return true;
      default:
        return false;
    }
  }

  /** Human-readable summary for a status notification. */
  private statusText(
    method: string,
    params: Record<string, unknown> | undefined,
  ): string | undefined {
    switch (method) {
      case "thread/started":
        return "Codex thread started.";
      case "turn/started":
        return "Codex started a turn.";
      case "thread/status/changed": {
        const status = params ? rec(params, "status") : undefined;
        const kind = status ? str(status, "type") : undefined;
        return kind ? `Codex thread status: ${kind}.` : undefined;
      }
      default:
        return undefined;
    }
  }

  /** Render a plan update as a checklist (spec §22 plan_update). */
  private planText(params: Record<string, unknown>): string | undefined {
    const steps = arr(params, "plan");
    const explanation = str(params, "explanation");
    const lines: string[] = [];
    if (explanation && explanation.trim().length > 0) lines.push(explanation.trim());

    if (steps) {
      for (const raw of steps) {
        if (!isRecord(raw)) continue;
        const step = str(raw, "step");
        if (step === undefined) continue;
        const status = str(raw, "status");
        const mark =
          status === "completed"
            ? "[x]"
            : status === "inProgress"
              ? "[~]"
              : "[ ]";
        lines.push(`- ${mark} ${step}`);
      }
    }

    const text = lines.join("\n").trim();
    return text.length > 0 ? text : undefined;
  }

  /** Render the changed-file list from a fileChange item or patch update. */
  private fileChangedText(
    source: Record<string, unknown>,
  ): string | undefined {
    const changes = arr(source, "changes");
    if (!changes) return undefined;
    const paths: string[] = [];
    for (const change of changes) {
      if (!isRecord(change)) continue;
      const path = str(change, "path");
      if (path === undefined) continue;
      const kind = rec(change, "kind");
      const kindType = kind ? str(kind, "type") : undefined;
      paths.push(kindType ? `${kindType}: ${path}` : path);
    }
    if (paths.length === 0) return undefined;
    return `Changed files:\n${paths.map((p) => `- ${p}`).join("\n")}`;
  }

  /** Extract the human-readable message from an `error` notification. */
  private errorText(params: Record<string, unknown>): string | undefined {
    const error = rec(params, "error");
    if (error) {
      const message = str(error, "message");
      const details = str(error, "additionalDetails");
      if (message && details) return `${message}\n${details}`;
      if (message) return message;
    }
    // Some error shapes carry a top-level message string.
    return str(params, "message");
  }

  /** Build a visibility line for an auto-decided approval request. */
  private approvalText(
    method: string,
    params: Record<string, unknown> | undefined,
  ): string {
    const reason = params ? str(params, "reason") : undefined;
    const command = params ? str(params, "command") : undefined;
    const isPatch =
      method === "applyPatchApproval" ||
      method === "item/fileChange/requestApproval";

    let head: string;
    if (command) head = `Codex requested approval to run: \`${command}\``;
    else if (isPatch) head = "Codex requested approval to apply a patch.";
    else head = "Codex requested an approval.";

    return reason && reason.trim().length > 0 ? `${head}\n${reason.trim()}` : head;
  }

  /** Map a commandExecution item's exit code/status to pass/fail/unknown. */
  private commandStatus(
    item: Record<string, unknown> | undefined,
    data: Record<string, unknown> | undefined,
  ): "passed" | "failed" | "unknown" {
    // Prefer the explicit exit code (0 ⇒ passed) when present.
    const exitCode =
      (item && num(item, "exitCode")) ?? (data && num(data, "exitCode"));
    if (exitCode !== undefined) return exitCode === 0 ? "passed" : "failed";

    // Fall back to the CommandExecutionStatus enum.
    const status = (item && str(item, "status")) ?? (data && str(data, "status"));
    if (status === "completed") return "passed";
    if (status === "failed" || status === "declined") return "failed";
    return "unknown";
  }
}

/** Shared, stateless singleton (the filter holds no mutable state). */
export const transcriptFilter: TranscriptFilter = new TranscriptFilterImpl();
