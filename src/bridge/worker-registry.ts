/**
 * In-memory worker registry (spec §13, §24, §31, §33).
 *
 * Holds every {@link WorkerRecord} for the current run in a `Map`, enforces the
 * §33 concurrency limits and the §31/§24 "HARD" write-isolation rules at
 * start time, and validates §13 lifecycle transitions on every state move.
 *
 * Pure in-memory: no filesystem or process I/O. The artifact store persists
 * records to disk; this module only owns the live view and the invariants.
 *
 * Local-import convention: extensionless, resolved by esbuild/bundler.
 */

import * as path from "node:path";
import {
  limits,
  type CodexWorkerStartInput,
  type ResolvedDefaults,
  type WorkerRecord,
  type WorkerRecordPatch,
  type WorkerRegistry as WorkerRegistryInterface,
  type WorkerState,
} from "./types";
import { logger } from "./logger";

/* ────────────────────────────────────────────────────────────────────────
 * §13 — legal state transitions
 * ──────────────────────────────────────────────────────────────────────── */

/** Terminal states: a worker in one of these never transitions again. */
const TERMINAL_STATES: ReadonlySet<WorkerState> = new Set<WorkerState>([
  "completed",
  "interrupted",
  "failed",
]);

/**
 * §13 lifecycle graph. Maps each state to the set of states it may move to.
 * Re-entering the same state is always tolerated (idempotent updates), so it is
 * NOT enumerated here. Terminal states have no outgoing edges.
 */
const LEGAL_TRANSITIONS: Readonly<Record<WorkerState, ReadonlySet<WorkerState>>> = {
  created: new Set<WorkerState>(["starting", "failed", "interrupted"]),
  starting: new Set<WorkerState>(["running", "idle", "failed", "interrupted"]),
  running: new Set<WorkerState>([
    "waiting_for_approval",
    "idle",
    "completed",
    "failed",
    "interrupted",
  ]),
  waiting_for_approval: new Set<WorkerState>([
    "running",
    "idle",
    "completed",
    "failed",
    "interrupted",
  ]),
  idle: new Set<WorkerState>([
    "running",
    "completed",
    "failed",
    "interrupted",
  ]),
  completed: new Set<WorkerState>([]),
  interrupted: new Set<WorkerState>([]),
  failed: new Set<WorkerState>([]),
};

/* ────────────────────────────────────────────────────────────────────────
 * workerId validation
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Filesystem-safe slug: lowercase/uppercase letters, digits, `-` and `_`.
 * Must be non-empty and bounded so it is safe as a directory name and as a git
 * branch/worktree component (spec §24).
 */
const WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_WORKER_ID_LEN = 64;

/** Throw a clear Error if `id` is not a valid filesystem-safe worker slug. */
function assertValidWorkerId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("workerId is required and must be a non-empty string");
  }
  if (id.length > MAX_WORKER_ID_LEN) {
    throw new Error(
      `workerId "${id}" is too long (max ${MAX_WORKER_ID_LEN} characters)`,
    );
  }
  if (!WORKER_ID_RE.test(id)) {
    throw new Error(
      `workerId "${id}" is not a filesystem-safe slug ` +
        "(allowed: letters, digits, '-', '_'; must start alphanumeric)",
    );
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */

/** True when a worker no longer occupies a concurrency slot. */
function isTerminal(state: WorkerState): boolean {
  return TERMINAL_STATES.has(state);
}

/** A workspace-write worker is one whose sandbox policy permits edits. */
function isWriteWorker(sandboxPolicy: WorkerRecord["sandboxPolicy"]): boolean {
  return sandboxPolicy === "workspace-write";
}

/**
 * The directory a write worker will actually mutate. When a worktree is in
 * use the writes land in `.worktrees/codex-<workerId>` (unique per worker), so
 * collisions are impossible; otherwise the worker writes directly into `cwd`
 * (potentially the main tree). Normalized to an absolute path for comparison.
 */
function effectiveWriteDir(
  cwd: string,
  worktreePath: string | undefined,
): string {
  const dir = worktreePath && worktreePath.length > 0 ? worktreePath : cwd;
  return path.resolve(dir);
}

/* ────────────────────────────────────────────────────────────────────────
 * Registry
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Concrete {@link WorkerRegistryInterface}. One instance per bridge process /
 * run; all workers it tracks share the same `runId`.
 */
export class WorkerRegistry implements WorkerRegistryInterface {
  private readonly workers = new Map<string, WorkerRecord>();

  /**
   * @param now Injectable clock for deterministic timestamps in tests.
   *            Defaults to `Date.now`. Always rendered as ISO-8601.
   */
  constructor(private readonly now: () => number = Date.now) {}

  /** Current ISO-8601 timestamp from the injected clock. */
  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * Validate that starting a worker with these options is permitted (§24, §31,
   * §33). Throws a clear, user-facing Error on the first violation; returns
   * void when the start is allowed. Does NOT mutate state.
   */
  assertCanStart(
    opts: CodexWorkerStartInput & { resolved: ResolvedDefaults },
  ): void {
    const { workerId, resolved } = opts;

    // 1. workerId must be a valid filesystem-safe slug.
    assertValidWorkerId(workerId);

    // 2. No duplicate live worker for this id.
    const existing = this.workers.get(workerId);
    if (existing && !isTerminal(existing.state)) {
      throw new Error(
        `worker "${workerId}" already exists in state "${existing.state}"; ` +
          "choose a unique workerId or collect/interrupt the existing one",
      );
    }

    // Workers that still occupy a concurrency slot (non-terminal). A previous
    // terminal worker reusing the same id frees its slot.
    const active = this.list().filter(
      (w) => w.workerId !== workerId && !isTerminal(w.state),
    );

    // 3. §33 — max workers per run.
    if (active.length >= limits.maxWorkersPerRun) {
      throw new Error(
        `cannot start worker "${workerId}": ` +
          `maxWorkersPerRun (${limits.maxWorkersPerRun}) reached ` +
          `(${active.length} active)`,
      );
    }

    const willWrite = isWriteWorker(resolved.sandboxPolicy);
    if (willWrite) {
      // 4. §33 — max write workers per run.
      const activeWriters = active.filter((w) => isWriteWorker(w.sandboxPolicy));
      if (activeWriters.length >= limits.maxWriteWorkersPerRun) {
        throw new Error(
          `cannot start write worker "${workerId}": ` +
            `maxWriteWorkersPerRun (${limits.maxWriteWorkersPerRun}) reached ` +
            `(${activeWriters.length} active)`,
        );
      }

      // 5. §24/§31 — HARD rule: never two workspace-write workers in the same
      //    directory, and never write in the main tree if another writer is
      //    already active there.
      //
      //    When this worker uses a worktree its write dir is
      //    `.worktrees/codex-<workerId>` (unique per worker, allocated later by
      //    the worktree manager), so it can never collide and we skip the
      //    check. Without a worktree it writes directly into `cwd`; if any other
      //    active writer also targets that resolved directory, refuse.
      if (!resolved.useWorktree && opts.cwd) {
        const myDir = effectiveWriteDir(opts.cwd, undefined);
        for (const w of activeWriters) {
          const otherDir = effectiveWriteDir(w.cwd, w.worktreePath);
          if (otherDir === myDir) {
            throw new Error(
              `cannot start write worker "${workerId}" in "${myDir}": ` +
                `write worker "${w.workerId}" is already active in that ` +
                "directory (no two writers may share a directory, and the " +
                "main tree may not be written while another writer is active " +
                "there); use a worktree (useWorktree: true) or a distinct cwd",
            );
          }
        }
      }
    }
  }

  /**
   * Register a new worker record. Throws if a live worker already holds the id
   * or if the id is not a valid slug. The record is stored verbatim; callers
   * own the canonical `createdAt`/`updatedAt`/`artifactPaths`.
   */
  create(record: WorkerRecord): WorkerRecord {
    assertValidWorkerId(record.workerId);

    const existing = this.workers.get(record.workerId);
    if (existing && !isTerminal(existing.state)) {
      throw new Error(
        `worker "${record.workerId}" already exists in state ` +
          `"${existing.state}"`,
      );
    }

    this.workers.set(record.workerId, record);
    logger.debug("worker registered", {
      workerId: record.workerId,
      runId: record.runId,
      state: record.state,
      sandboxPolicy: record.sandboxPolicy,
    });
    return record;
  }

  /** Look up a worker by id, or `undefined` if unknown. */
  get(id: string): WorkerRecord | undefined {
    return this.workers.get(id);
  }

  /** Snapshot of all worker records (insertion order). */
  list(): WorkerRecord[] {
    return Array.from(this.workers.values());
  }

  /**
   * Apply a partial patch, refreshing `updatedAt`. Identity/immutable fields
   * (`workerId`, `runId`, `createdAt`, `artifactPaths`) are excluded by
   * {@link WorkerRecordPatch}'s type. A `state` change in the patch is routed
   * through {@link transition} so §13 legality is always enforced.
   */
  update(id: string, patch: WorkerRecordPatch): WorkerRecord {
    const current = this.requireWorker(id);

    // Validate any state change before applying the rest of the patch.
    if (patch.state !== undefined && patch.state !== current.state) {
      this.assertLegalTransition(current.state, patch.state, id);
    }

    const next: WorkerRecord = {
      ...current,
      ...patch,
      // Preserve identity/immutable fields regardless of patch contents.
      workerId: current.workerId,
      runId: current.runId,
      createdAt: current.createdAt,
      artifactPaths: current.artifactPaths,
      updatedAt: this.timestamp(),
    };

    this.workers.set(id, next);
    return next;
  }

  /**
   * Move a worker to `next`, validating the §13 transition. A no-op move to the
   * current state is allowed and only bumps `updatedAt`.
   */
  transition(id: string, next: WorkerState): WorkerRecord {
    const current = this.requireWorker(id);
    if (next !== current.state) {
      this.assertLegalTransition(current.state, next, id);
    }

    const updated: WorkerRecord = {
      ...current,
      state: next,
      updatedAt: this.timestamp(),
    };
    this.workers.set(id, updated);
    logger.debug("worker transition", {
      workerId: id,
      from: current.state,
      to: next,
    });
    return updated;
  }

  /* ── internals ──────────────────────────────────────────────────────── */

  /** Fetch a worker or throw a clear "unknown worker" Error. */
  private requireWorker(id: string): WorkerRecord {
    const record = this.workers.get(id);
    if (!record) {
      throw new Error(`unknown worker "${id}"`);
    }
    return record;
  }

  /** Throw if moving `from → to` is not a legal §13 transition. */
  private assertLegalTransition(
    from: WorkerState,
    to: WorkerState,
    id: string,
  ): void {
    if (isTerminal(from)) {
      throw new Error(
        `worker "${id}" is in terminal state "${from}" and cannot ` +
          `transition to "${to}"`,
      );
    }
    if (!LEGAL_TRANSITIONS[from].has(to)) {
      throw new Error(
        `illegal state transition for worker "${id}": "${from}" → "${to}"`,
      );
    }
  }
}
