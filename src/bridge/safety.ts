/**
 * Safety layer — enforces the §31 destructive-command blocklist, decides how to
 * answer non-interactive Codex approval requests, and resolves the §37
 * recommended defaults.
 *
 * This module is PURE and SYNCHRONOUS: it performs no I/O. The adapter and tool
 * layer act on its decisions (persisting events, sending the JSON-RPC reply,
 * forwarding `approval_request` messages to Claude).
 *
 * Wire shapes are taken from the GROUND TRUTH protocol doc
 * (docs/codex-app-server-protocol.md "Server → Client requests") and the
 * generated bindings (regenerate with `codex app-server generate-ts --out <dir>`):
 *  - v1 (`ExecCommandApprovalResponse` / `ApplyPatchApprovalResponse`) carries a
 *    `ReviewDecision` = "approved" | "approved_for_session" | "denied" | "abort"
 *    | "timed_out" | { … amendments … }.
 *  - v2 (`CommandExecutionRequestApprovalResponse` / `FileChangeRequestApprovalResponse`)
 *    carries `CommandExecutionApprovalDecision` / `FileChangeApprovalDecision`
 *    = "accept" | "acceptForSession" | "decline" | "cancel" (+ amendments).
 *
 * The method name on the {@link CodexServerRequest} disambiguates which decision
 * vocabulary to use; we read it rather than guess.
 *
 * Local-import convention: extensionless (bundler moduleResolution + esbuild).
 */

import { logger } from "./logger";
import type {
  ApprovalDecision,
  CodexServerRequest,
  CodexWorkerStartInput,
  DestructiveCheck,
  ResolvedDefaults,
  SafetyLayer,
  TranscriptMode,
} from "./types";

/* ────────────────────────────────────────────────────────────────────────
 * §31 — Destructive-command blocklist
 *
 * Spec §31 lists the exact patterns. Each entry is matched case-insensitively
 * and is robust to flag spacing / ordering: the command is normalized (lower
 * cased, whitespace collapsed) and tested against a regex that permits extra
 * tokens between the recognizable parts where the spec implies a flag.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * A regex fragment matching the program's leading flag tokens, so that a
 * subcommand can be anchored to the FIRST POSITIONAL argument rather than
 * "anywhere after the program". This prevents a destructive verb from matching
 * an unrelated, non-adjacent token (e.g. `git config push.default …` must NOT
 * count as `git push`).
 *
 * It consumes any run of `-flag` / `--flag` tokens (each optionally followed by
 * its own value token, e.g. `git -C path`, `git -c key=val`) before the
 * subcommand. `[^\s]` is used (not `\S`) for readability.
 */
const LEADING_FLAGS = "(?:\\s+-[^\\s]+(?:\\s+[^\\s-][^\\s]*)?)*";

/**
 * Match a destructive verb that must be the FIRST POSITIONAL token after the
 * given program (any number of leading flags allowed). The verb is followed by
 * a hard boundary that is NOT `-` so hyphenated identifiers (e.g.
 * `kubectl delete-old`, `npm run publish-docs`) do not trip the rule.
 */
function subcommand(program: string, verb: string): RegExp {
  // After the verb, require whitespace or end-of-string — never `-` or word chars.
  return new RegExp(`\\b${program}\\b${LEADING_FLAGS}\\s+${verb}(?![\\w-])`);
}

/** Does the normalized command name `rm` carry a recursive flag (-r/-R/--recursive)? */
const RM_RECURSIVE = /(?:^|\s)(?:--recursive|-[a-z]*r[a-z]*|-r)(?![\w-])/i;
/** Does it carry a force flag (-f/--force)? */
const RM_FORCE = /(?:^|\s)(?:--force|-[a-z]*f[a-z]*|-f)(?![\w-])/i;
/** Does `git clean` carry a -d/--directories/-x flag? */
const CLEAN_DIR = /(?:^|\s)(?:--directories|-[a-z]*d[a-z]*|-d|-x)(?![\w-])/i;
/** Does `git clean` carry a force flag (-f/--force)? */
const CLEAN_FORCE = /(?:^|\s)(?:--force|-[a-z]*f[a-z]*|-f)(?![\w-])/i;

/**
 * The §31 blocklist. Each entry is a predicate over the normalized command.
 *
 * Design:
 *  - Subcommand rules (git push, npm publish, kubectl delete, terraform apply,
 *    docker system prune) anchor the verb to the program's first positional
 *    argument via {@link subcommand}, so unrelated later tokens never match and
 *    hyphenated names (`publish-docs`) are excluded.
 *  - Flag-combination rules (rm -rf, git clean -fd) are flag-agnostic about
 *    short/long mixing: they require BOTH the recursive/force (or force/dir)
 *    tokens to be present in any order/spelling.
 */
type FlagBlocklistEntry = {
  rule: string;
  /** Predicate over the normalized command string. */
  test: (normalized: string) => boolean;
};

const RM_PUSH = subcommand("git", "push");
const NPM_PUBLISH = subcommand("npm", "publish");
const PNPM_PUBLISH = subcommand("pnpm", "publish");
const KUBECTL_DELETE = subcommand("kubectl", "delete");
const TERRAFORM_APPLY = subcommand("terraform", "apply");
const GIT_RESET_HARD = /\bgit\b(?:\s+\S+)*?\s+reset\b(?:\s+\S+)*?\s+--hard\b/;
const DOCKER_SYSTEM_PRUNE =
  /\bdocker\b(?:\s+\S+)*?\s+system\b(?:\s+\S+)*?\s+prune\b/;
const DROP_DATABASE = /\bdrop\b\s+database\b/;

const BLOCKLIST: readonly FlagBlocklistEntry[] = [
  {
    rule: "rm -rf",
    // rm … with BOTH recursive and force flags, in any order/spelling/mixing.
    test: (n) => /\brm\b/.test(n) && RM_RECURSIVE.test(n) && RM_FORCE.test(n),
  },
  {
    rule: "git reset --hard",
    test: (n) => GIT_RESET_HARD.test(n),
  },
  {
    rule: "git clean -fd",
    // git clean with BOTH a force flag and a -d/-x directory flag, any order.
    test: (n) =>
      /\bgit\b(?:\s+\S+)*?\s+clean\b/.test(n) &&
      CLEAN_FORCE.test(n) &&
      CLEAN_DIR.test(n),
  },
  {
    rule: "git push",
    test: (n) => RM_PUSH.test(n),
  },
  {
    rule: "npm publish",
    test: (n) => NPM_PUBLISH.test(n),
  },
  {
    rule: "pnpm publish",
    test: (n) => PNPM_PUBLISH.test(n),
  },
  {
    rule: "docker system prune",
    test: (n) => DOCKER_SYSTEM_PRUNE.test(n),
  },
  {
    rule: "drop database",
    test: (n) => DROP_DATABASE.test(n),
  },
  {
    rule: "terraform apply",
    test: (n) => TERRAFORM_APPLY.test(n),
  },
  {
    rule: "kubectl delete",
    test: (n) => KUBECTL_DELETE.test(n),
  },
] as const;

/**
 * Normalize a command for matching: lower-case, strip a leading `sudo`, collapse
 * runs of whitespace (incl. newlines/tabs) to a single space, and trim. This is
 * what makes the blocklist robust to flag spacing without making the patterns
 * unreadable.
 */
function normalizeCommand(cmd: string): string {
  return cmd
    .toLowerCase()
    .replace(/[\s]+/g, " ")
    .replace(/^\s*sudo\s+/, "")
    .trim();
}

/* ────────────────────────────────────────────────────────────────────────
 * Approval-request extraction (defensive)
 *
 * We must never throw on an unexpected wire shape — Codex versions change. Every
 * accessor below tolerates `unknown` and missing/renamed fields, returning a
 * best-effort string or undefined.
 * ──────────────────────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extract a shell command string from exec-approval params (v1 + v2 shapes). */
function extractCommand(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;

  // v1 ExecCommandApprovalParams: `command: Array<string>`.
  const arr = params["command"];
  if (Array.isArray(arr) && arr.every((p) => typeof p === "string")) {
    const joined = (arr as string[]).join(" ").trim();
    return joined.length > 0 ? joined : undefined;
  }

  // v2 CommandExecutionRequestApprovalParams: `command?: string | null`.
  if (typeof arr === "string" && arr.trim().length > 0) return arr.trim();

  return undefined;
}

/**
 * Extract a single searchable text blob from a patch/file-change approval so the
 * blocklist can be applied to any embedded shell snippets. Covers v1
 * `ApplyPatchApprovalParams.fileChanges` (a map of FileChange) and v2
 * `FileChangeRequestApprovalParams` shapes by stringifying defensively.
 */
function extractPatchText(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  const changes = params["fileChanges"] ?? params["changes"] ?? params["files"];
  if (changes === undefined) return undefined;
  try {
    return JSON.stringify(changes);
  } catch {
    return undefined;
  }
}

/** Best-effort human reason string carried on most approval params. */
function extractReason(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  const reason = params["reason"];
  return typeof reason === "string" && reason.length > 0 ? reason : undefined;
}

/* ────────────────────────────────────────────────────────────────────────
 * Method classification + decision vocabulary
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The category of a server-initiated request:
 *  - "exec"        — a command-execution approval (decision body).
 *  - "patch"       — a file-change / apply-patch approval (decision body).
 *  - "permissions" — a permissions-escalation approval whose response is NOT a
 *    `{ decision }` body but `{ permissions, scope }` (no extra grants = deny).
 *  - "unsupported" — any other server request the bridge does not implement
 *    (elicitation, tool user-input, infra auth/attestation). Answered with a
 *    JSON-RPC error so Codex can fall back; never a fabricated `{ decision }`.
 */
type ApprovalKind = "exec" | "patch" | "permissions" | "unsupported";

/** Which protocol vocabulary a method uses for its decision enum. */
type DecisionDialect = "review" | "v2";

type MethodInfo = { kind: ApprovalKind; dialect: DecisionDialect };

/**
 * Classify a server-request method into (a) what it is and (b) which decision
 * vocabulary its response uses. Method names are taken verbatim from the
 * protocol doc's ServerRequest union and the vendored bindings.
 */
function classifyMethod(method: string): MethodInfo {
  switch (method) {
    // v1 (ReviewDecision: "approved" | "denied" | …)
    case "execCommandApproval":
      return { kind: "exec", dialect: "review" };
    case "applyPatchApproval":
      return { kind: "patch", dialect: "review" };

    // v2 ("accept" | "decline" | …)
    case "item/commandExecution/requestApproval":
      return { kind: "exec", dialect: "v2" };
    case "item/fileChange/requestApproval":
      return { kind: "patch", dialect: "v2" };

    // Permissions escalation — response is { permissions, scope } (no { decision }).
    case "item/permissions/requestApproval":
      return { kind: "permissions", dialect: "v2" };

    default:
      // Known approval-ish names still classify; everything else is unsupported
      // (elicitation, tool user-input, account/attestation infra) and is
      // answered with a JSON-RPC error rather than a fabricated decision body.
      if (/command|exec/i.test(method)) return { kind: "exec", dialect: "v2" };
      if (/patch|filechange|file_change/i.test(method)) {
        return { kind: "patch", dialect: "v2" };
      }
      return { kind: "unsupported", dialect: "v2" };
  }
}

/** The wire decision string for "allow", per the method's dialect. */
function approveDecision(dialect: DecisionDialect): string {
  return dialect === "review" ? "approved" : "accept";
}

/** The wire decision string for "block", per the method's dialect. */
function denyDecision(dialect: DecisionDialect): string {
  return dialect === "review" ? "denied" : "decline";
}

/* ════════════════════════════════════════════════════════════════════════
 * SafetyLayer implementation
 * ════════════════════════════════════════════════════════════════════════ */

class DefaultSafetyLayer implements SafetyLayer {
  /* §31 — destructive command check. */
  isDestructiveCommand(cmd: string): DestructiveCheck {
    if (typeof cmd !== "string" || cmd.trim().length === 0) {
      return { blocked: false };
    }
    const normalized = normalizeCommand(cmd);
    for (const entry of BLOCKLIST) {
      if (entry.test(normalized)) {
        return { blocked: true, rule: entry.rule };
      }
    }
    return { blocked: false };
  }

  /*
   * §31 / protocol "Bridge policy for approvals" — non-interactive decision.
   *
   * There is no human at the bridge. Write workers run with
   * approvalPolicy="on-request" inside an isolated worktree, so:
   *   - deny anything matching the destructive blocklist (record auto-denied),
   *   - otherwise approve within the worktree.
   *
   * The returned shape tells the tool layer HOW to answer:
   *   - exec/patch → JSON-RPC `result` with a `{ decision }` body in the
   *     method's dialect ("approved"/"denied" or "accept"/"decline");
   *   - permissions → JSON-RPC `result` with the correct permissions-escalation
   *     shape `{ permissions, scope }`; denial = grant NO extra permissions;
   *   - unsupported (elicitation, tool user-input, infra auth/attestation) →
   *     JSON-RPC `error` (-32601) so Codex falls back, never a fabricated body.
   */
  decideApproval(req: CodexServerRequest): ApprovalDecision {
    const method = typeof req?.method === "string" ? req.method : "";
    const { kind, dialect } = classifyMethod(method);

    // Server requests the bridge does not implement: fail-closed with a real
    // JSON-RPC error rather than a fabricated `{ decision }` body these methods
    // do not define (elicitation, tool user-input, account/attestation infra).
    if (kind === "unsupported") {
      const reason =
        `Unsupported server request "${method || "<unknown>"}" — replied with ` +
        `JSON-RPC error -32601 (not handled by the bridge; Codex falls back).`;
      logger.warn("safety.decideApproval: unsupported server request", method);
      return {
        decision: "unsupported",
        reason,
        responseKind: "error",
        raw: undefined,
        errorCode: -32601,
      };
    }

    // Permissions escalation: deny by granting NO additional permissions. The
    // response schema is `{ permissions, scope }`, NOT `{ decision }`.
    if (kind === "permissions") {
      const why = extractReason(req.params);
      const reason =
        "Auto-denied permissions escalation (no additional grants)" +
        (why ? ` — ${why}` : ".");
      return {
        decision: "denied",
        reason,
        responseKind: "result",
        raw: { permissions: {}, scope: "turn" },
      };
    }

    if (kind === "exec") {
      const command = extractCommand(req.params);
      if (command === undefined) {
        // Could not read a command from a known exec method: fail safe → deny.
        const decision = denyDecision(dialect);
        const reason =
          "Exec approval with no parseable command — denied (fail-safe).";
        logger.warn("safety.decideApproval: unparseable exec command", method);
        return { decision, reason, responseKind: "result", raw: { decision } };
      }

      const check = this.isDestructiveCommand(command);
      if (check.blocked) {
        const decision = denyDecision(dialect);
        const reason =
          `Auto-denied: command matches destructive rule "${check.rule}" ` +
          `(${command}).`;
        return { decision, reason, responseKind: "result", raw: { decision } };
      }

      const decision = approveDecision(dialect);
      const why = extractReason(req.params);
      const reason =
        `Auto-approved within worktree (workspace-write): ${command}` +
        (why ? ` — ${why}` : "");
      return { decision, reason, responseKind: "result", raw: { decision } };
    }

    // kind === "patch": approve file-change/patch application within the
    // worktree, but still scan the serialized patch for embedded destructive
    // shell snippets (defense in depth).
    const patchText = extractPatchText(req.params);
    if (patchText !== undefined) {
      const check = this.isDestructiveCommand(patchText);
      if (check.blocked) {
        const decision = denyDecision(dialect);
        const reason =
          `Auto-denied: patch contains destructive command matching rule ` +
          `"${check.rule}".`;
        return { decision, reason, responseKind: "result", raw: { decision } };
      }
    }

    const decision = approveDecision(dialect);
    const why = extractReason(req.params);
    const reason =
      "Auto-approved patch within isolated worktree" +
      (why ? ` — ${why}` : ".");
    return { decision, reason, responseKind: "result", raw: { decision } };
  }

  /*
   * §15 / §37 — recommended defaults, per field and independent.
   *
   * Spec §15's Default block is authoritative for any field the caller did NOT
   * set: transcriptMode="messages_plus_artifacts", sandboxPolicy="read-only",
   * approvalPolicy="never", waitFor="started" (waitFor is resolved in the tool
   * layer). §37 profiles are RECOMMENDATIONS for the caller, not an auto-escalation
   * the bridge performs — a lone approvalPolicy:"on-request" must NOT silently
   * flip the sandbox to workspace-write.
   *
   * Therefore each unset field falls back to the §15 flat default, with ONE
   * scoped exception: when the caller signals a clear WRITE intent — by setting
   * sandboxPolicy to a writing mode ("workspace-write" or "danger-full-access")
   * or requesting an isolated worktree (useWorktree:true) — the §37
   * implementation profile is applied to fill the OTHER still-unset fields
   * (approvalPolicy → on-request, useWorktree → true). The sandbox itself is
   * never escalated by anything other than an explicit sandboxPolicy or a
   * worktree request, preserving the §15 read-only default for review/approval
   * workers. In particular "danger-full-access" (unsandboxed, full host access,
   * no command approval) is NEVER a default — it is only ever the resolved
   * sandbox when the caller passes it explicitly.
   */
  resolveDefaults(input: CodexWorkerStartInput): ResolvedDefaults {
    // A worktree request is itself a write signal (you only isolate writes).
    // "danger-full-access" is a writing mode too, so it counts as write intent.
    const wantsWrite =
      input.sandboxPolicy === "workspace-write" ||
      input.sandboxPolicy === "danger-full-access" ||
      input.useWorktree === true;
    const base = wantsWrite ? IMPLEMENTATION : SPEC15_DEFAULTS;

    const transcriptMode: TranscriptMode =
      input.transcriptMode ?? base.transcriptMode;
    // Sandbox only ever escalates when the caller explicitly set it or asked
    // for a worktree; otherwise the §15 read-only default wins.
    const sandboxPolicy = input.sandboxPolicy ?? base.sandboxPolicy;
    const approvalPolicy = input.approvalPolicy ?? base.approvalPolicy;
    const useWorktree = input.useWorktree ?? base.useWorktree;

    return { transcriptMode, sandboxPolicy, approvalPolicy, useWorktree };
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Default profiles (§15 hard defaults + §37 implementation recommendation)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Spec §15 "Default" block — the flat, per-field defaults that win for any field
 * the caller did not set (absent an explicit write signal).
 */
const SPEC15_DEFAULTS: ResolvedDefaults = {
  transcriptMode: "messages_plus_artifacts",
  sandboxPolicy: "read-only",
  approvalPolicy: "never",
  useWorktree: false,
};

/**
 * Spec §37 implementation recommendation — used ONLY to fill unset fields when
 * the caller has signalled write intent (explicit workspace-write sandbox or an
 * explicit worktree request).
 */
const IMPLEMENTATION: ResolvedDefaults = {
  transcriptMode: "messages_plus_artifacts",
  sandboxPolicy: "workspace-write",
  approvalPolicy: "on-request",
  useWorktree: true,
};

/** The shared, stateless safety layer instance for the bridge. */
export const safety: SafetyLayer = new DefaultSafetyLayer();

/** Export the class for testing / alternative wiring. */
export { DefaultSafetyLayer };
