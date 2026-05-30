/**
 * On-disk artifact store for a single Codex worker (spec §13/§14).
 *
 * Layout (rooted at the bridge's artifact base, §14):
 *
 *   <baseDir>/runs/<runId>/
 *     manifest.json                     ← run-level summary (all workers)
 *     workers/<workerId>/
 *       worker.json                     ← persisted WorkerRecord
 *       events.ndjson                   ← one raw inbound JSON-RPC line per row
 *       messages.md                     ← rendered transcript (markdown)
 *       result.json                     ← structured collect-result payload
 *       final.md                        ← agent's final answer
 *       diff.patch                      ← unified diff
 *       changed-files.txt               ← newline-separated changed paths
 *       command-summary.md              ← compact command/test summary (§23)
 *       error.log                       ← appended error lines
 *
 * Design rules (per protocol doc + spec):
 *   - All raw inbound lines are persisted BEFORE any filtering, so appendEvent
 *     must be cheap, append-only, and never lose data.
 *   - Directories/files are created lazily; we never throw because a directory
 *     was missing — every write re-ensures its parent dir first.
 *   - stdout is reserved for the MCP protocol; we only log to stderr (logger).
 *
 * Local-import convention: extensionless (bundler moduleResolution + esbuild).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./logger";
import type {
  ArtifactStore as ArtifactStoreInterface,
  RenderedMessage,
  WorkerArtifactPaths,
  WorkerRecord,
} from "./types";

/** Standard fixed file names inside a worker's artifact directory (spec §14). */
const FILE_NAMES = {
  workerJson: "worker.json",
  eventsNdjson: "events.ndjson",
  messagesMd: "messages.md",
  resultJson: "result.json",
  finalMd: "final.md",
  diffPatch: "diff.patch",
  changedFilesTxt: "changed-files.txt",
  commandSummaryMd: "command-summary.md",
  errorLog: "error.log",
} as const;

/** Run-level manifest file name (spec §14). */
const MANIFEST_NAME = "manifest.json";

/**
 * A single worker's row in the run-level `manifest.json`. A compact projection
 * of {@link WorkerRecord} so a run can be surveyed without opening each
 * `worker.json`.
 */
type ManifestWorkerEntry = {
  workerId: string;
  state: WorkerRecord["state"];
  threadId?: string;
  currentTurnId?: string;
  cwd: string;
  worktreePath?: string;
  transcriptMode: WorkerRecord["transcriptMode"];
  sandboxPolicy: WorkerRecord["sandboxPolicy"];
  approvalPolicy: WorkerRecord["approvalPolicy"];
  createdAt: string;
  updatedAt: string;
  artifactDir: string;
};

/** Top-level shape of `manifest.json`. */
type RunManifest = {
  runId: string;
  updatedAt: string;
  workers: Record<string, ManifestWorkerEntry>;
};

/**
 * Filesystem-backed {@link ArtifactStoreInterface} for one worker.
 *
 * Construct with the artifact base directory, the run id, and the worker id.
 * The constructor only computes paths; the backing directory is created on the
 * first write (or eagerly via {@link ArtifactStore.init}). Manifest updates are
 * serialized through an internal promise chain so concurrent
 * {@link updateManifest} calls perform a safe read-modify-write.
 */
export class ArtifactStore implements ArtifactStoreInterface {
  /** `<baseDir>/runs/<runId>`. */
  private readonly runDir: string;

  /** `<runDir>/workers/<workerId>`. */
  private readonly workerDir: string;

  /** `<runDir>/manifest.json`. */
  private readonly manifestPath: string;

  /** Absolute artifact paths exposed to the registry/tool layer (§13/§14). */
  public readonly artifactPaths: WorkerArtifactPaths;

  /** Serializes mutations to the shared run-level manifest. */
  private manifestChain: Promise<void> = Promise.resolve();

  /** Memoizes the worker-dir mkdir so we only stat/create once per write burst. */
  private workerDirReady: Promise<void> | undefined;

  constructor(
    private readonly baseDir: string,
    private readonly runId: string,
    private readonly workerId: string,
  ) {
    this.runDir = path.join(baseDir, "runs", runId);
    this.workerDir = path.join(this.runDir, "workers", workerId);
    this.manifestPath = path.join(this.runDir, MANIFEST_NAME);

    this.artifactPaths = {
      workerJson: path.join(this.workerDir, FILE_NAMES.workerJson),
      eventsNdjson: path.join(this.workerDir, FILE_NAMES.eventsNdjson),
      messagesMd: path.join(this.workerDir, FILE_NAMES.messagesMd),
      resultJson: path.join(this.workerDir, FILE_NAMES.resultJson),
      finalMd: path.join(this.workerDir, FILE_NAMES.finalMd),
      diffPatch: path.join(this.workerDir, FILE_NAMES.diffPatch),
      changedFilesTxt: path.join(this.workerDir, FILE_NAMES.changedFilesTxt),
      commandSummaryMd: path.join(this.workerDir, FILE_NAMES.commandSummaryMd),
    };
  }

  /** Absolute path to the worker's `error.log` (not part of WorkerArtifactPaths). */
  public get errorLogPath(): string {
    return path.join(this.workerDir, FILE_NAMES.errorLog);
  }

  /**
   * Eagerly create the worker directory. Optional — every writer also ensures
   * its directory — but useful right after a worker is registered so the path
   * exists before the first event arrives.
   */
  public async init(): Promise<void> {
    await this.ensureWorkerDir();
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Append-only writers
   * ────────────────────────────────────────────────────────────────────── */

  /**
   * Append one raw inbound message to `events.ndjson` as a single JSON line.
   * Persists the message exactly as received (no filtering) — this is the
   * durable audit log. Unserializable input is recorded as a wrapped error row
   * rather than dropped.
   */
  public async appendEvent(raw: unknown): Promise<void> {
    let line: string;
    try {
      line = JSON.stringify(raw);
    } catch (err) {
      // Never lose the fact that an event arrived; record a defensive stand-in.
      line = JSON.stringify({
        __unserializable__: true,
        error: errorMessage(err),
        preview: safePreview(raw),
      });
    }
    await this.appendLine(this.artifactPaths.eventsNdjson, line + "\n");
  }

  /**
   * Append one rendered transcript message to `messages.md`. Each message is
   * a small markdown block headed by its type/timestamp/id.
   */
  public async appendMessage(message: RenderedMessage): Promise<void> {
    await this.appendLine(this.artifactPaths.messagesMd, renderMessageBlock(message));
  }

  /** Append a line to `error.log`, prefixed with an ISO timestamp. */
  public async writeError(message: string): Promise<void> {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    await this.appendLine(this.errorLogPath, line);
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Whole-file writers (overwrite)
   * ────────────────────────────────────────────────────────────────────── */

  /** Write the structured `result.json` (pretty-printed). */
  public async writeResult(result: unknown): Promise<void> {
    await this.writeFile(this.artifactPaths.resultJson, stringify(result) + "\n");
  }

  /** Write the agent's final answer to `final.md`. */
  public async writeFinal(text: string): Promise<void> {
    await this.writeFile(this.artifactPaths.finalMd!, ensureTrailingNewline(text));
  }

  /** Write the unified diff to `diff.patch`. */
  public async writeDiff(diff: string): Promise<void> {
    await this.writeFile(this.artifactPaths.diffPatch!, ensureTrailingNewline(diff));
  }

  /** Write the changed-file list (one path per line) to `changed-files.txt`. */
  public async writeChangedFiles(paths: string[]): Promise<void> {
    const body = paths.length > 0 ? paths.join("\n") + "\n" : "";
    await this.writeFile(this.artifactPaths.changedFilesTxt!, body);
  }

  /** Write the command/test summary (markdown, §23) to `command-summary.md`. */
  public async writeCommandSummary(summary: string): Promise<void> {
    await this.writeFile(
      this.artifactPaths.commandSummaryMd!,
      ensureTrailingNewline(summary),
    );
  }

  /** Persist the worker record to `worker.json` (pretty-printed). */
  public async writeWorkerJson(record: WorkerRecord): Promise<void> {
    await this.writeFile(this.artifactPaths.workerJson, stringify(record) + "\n");
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Run-level manifest
   * ────────────────────────────────────────────────────────────────────── */

  /**
   * Insert/update this worker's row in the run-level `manifest.json`.
   *
   * Manifest mutations are serialized through {@link manifestChain} so that
   * concurrent callers (or sibling workers sharing the run dir) perform a safe
   * read-modify-write rather than racing on the file. The manifest is keyed by
   * `workerId`, so re-runs simply overwrite the prior row.
   */
  public async updateManifest(record: WorkerRecord): Promise<void> {
    const entry = toManifestEntry(record, this.workerDir);
    const run = this.runDir;
    const manifestPath = this.manifestPath;
    const runId = this.runId;

    const next = this.manifestChain.then(async () => {
      const manifest = await readManifest(manifestPath, runId);
      manifest.workers[record.workerId] = entry;
      manifest.updatedAt = new Date().toISOString();
      await ensureDir(run);
      await writeFileAtomic(manifestPath, stringify(manifest) + "\n");
    });

    // Keep the chain alive even if this update fails, but log the failure.
    this.manifestChain = next.catch((err) => {
      logger.error("artifact-store: manifest update failed", {
        workerId: record.workerId,
        runId,
        error: errorMessage(err),
      });
    });

    await next;
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Internal helpers
   * ────────────────────────────────────────────────────────────────────── */

  /** Ensure the worker directory exists (memoized for the common burst case). */
  private ensureWorkerDir(): Promise<void> {
    if (!this.workerDirReady) {
      this.workerDirReady = ensureDir(this.workerDir).catch((err) => {
        // Reset the memo so a later write can retry creating the directory.
        this.workerDirReady = undefined;
        throw err;
      });
    }
    return this.workerDirReady;
  }

  /** Append to a file inside the worker dir, lazily creating the dir first. */
  private async appendLine(filePath: string, data: string): Promise<void> {
    await this.ensureWorkerDir();
    await fs.appendFile(filePath, data, "utf8");
  }

  /** Overwrite a file inside the worker dir, lazily creating the dir first. */
  private async writeFile(filePath: string, data: string): Promise<void> {
    await this.ensureWorkerDir();
    await writeFileAtomic(filePath, data);
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * Module-private utilities
 * ════════════════════════════════════════════════════════════════════════ */

/** `mkdir -p`. Idempotent; resolves even if the directory already exists. */
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Write a file atomically: write to a sibling temp file then rename over the
 * target, so a crashed/concurrent reader never sees a half-written file.
 */
async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tmp, data, "utf8");
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup of the temp file on a failed rename.
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Read `manifest.json`, returning a fresh empty manifest if it is missing or
 * unparseable (defensive: a corrupt manifest must never crash the bridge).
 */
async function readManifest(
  manifestPath: string,
  runId: string,
): Promise<RunManifest> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    // Missing file (or unreadable) → start fresh.
    return { runId, updatedAt: new Date().toISOString(), workers: {} };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RunManifest>;
    const workers =
      parsed && typeof parsed.workers === "object" && parsed.workers !== null
        ? (parsed.workers as Record<string, ManifestWorkerEntry>)
        : {};
    return {
      runId: typeof parsed.runId === "string" ? parsed.runId : runId,
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
      workers,
    };
  } catch (err) {
    logger.warn("artifact-store: manifest.json was unparseable; rewriting", {
      manifestPath,
      error: errorMessage(err),
    });
    return { runId, updatedAt: new Date().toISOString(), workers: {} };
  }
}

/** Project a {@link WorkerRecord} into its compact manifest row. */
function toManifestEntry(
  record: WorkerRecord,
  workerDir: string,
): ManifestWorkerEntry {
  return {
    workerId: record.workerId,
    state: record.state,
    threadId: record.threadId,
    currentTurnId: record.currentTurnId,
    cwd: record.cwd,
    worktreePath: record.worktreePath,
    transcriptMode: record.transcriptMode,
    sandboxPolicy: record.sandboxPolicy,
    approvalPolicy: record.approvalPolicy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    artifactDir: workerDir,
  };
}

/** Render a transcript message as a small markdown block for `messages.md`. */
function renderMessageBlock(message: RenderedMessage): string {
  const header = `### [${message.type}] ${message.timestamp} (${message.id})`;
  const body = message.text.replace(/\s+$/u, "");
  return `${header}\n\n${body}\n\n`;
}

/** Pretty-print JSON with stable 2-space indentation. */
function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Ensure the given text ends with exactly one trailing newline. */
function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : text + "\n";
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Best-effort short string preview of a value that failed to serialize. */
function safePreview(value: unknown): string {
  try {
    return String(value).slice(0, 500);
  } catch {
    return "<unrepresentable>";
  }
}
