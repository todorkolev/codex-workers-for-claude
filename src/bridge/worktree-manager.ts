/**
 * Git worktree manager for write-capable Codex workers (spec §24).
 *
 * Each write-enabled worker runs in an isolated git worktree so that two
 * workers never write to the same directory and the main Claude session can
 * review a clean diff before applying it. Worktree layout:
 *
 *   path:   <project>/.worktrees/codex-<workerId>
 *   branch: codex/<runId>/<workerId>
 *
 * All git invocations go through `execFile` (no shell), so worker/run ids are
 * passed as argv elements and never interpolated into a command string.
 *
 * Local-import convention: extensionless, e.g. `import { config } from "./config";`.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { config } from "./config";
import { logger } from "./logger";
import type { WorktreeInfo, WorktreeManager } from "./types";

const execFileAsync = promisify(execFile);

/** Directory (relative to the project root) that holds all managed worktrees. */
const WORKTREES_DIRNAME = ".worktrees";

/**
 * Run `git` with the given arguments inside {@link config.projectDir}.
 * Returns trimmed stdout; on failure raises an Error carrying git's stderr.
 */
async function git(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: config.projectDir,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      throw new Error(
        "git executable not found on PATH; the worktree manager requires git.",
      );
    }
    const detail = (e.stderr ?? e.message ?? String(err)).trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

/**
 * Verify that {@link config.projectDir} is inside a git working tree. Surfaces
 * a clear, actionable error otherwise (spec §24: worktrees require a repo).
 */
async function assertGitRepo(): Promise<void> {
  try {
    const out = (await git(["rev-parse", "--is-inside-work-tree"])).trim();
    if (out !== "true") {
      throw new Error(
        `${config.projectDir} is not a git working tree (cannot create worktrees).`,
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Not a git repository at ${config.projectDir}: ${detail}. ` +
        "Worktrees require the project to be a git repository.",
    );
  }
}

/**
 * Parse the output of `git worktree list --porcelain` into a flat list.
 *
 * The porcelain format emits one attribute per line, with records separated by
 * a blank line. Each record begins with `worktree <abs-path>` and may include
 * `branch refs/heads/<name>`, `detached`, `bare`, `HEAD <sha>`, etc. Parsing is
 * intentionally defensive: unknown lines are ignored and malformed records are
 * skipped rather than throwing.
 */
function parseWorktreePorcelain(stdout: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = [];
  let currentPath: string | undefined;
  let currentBranch: string | undefined;

  const flush = (): void => {
    if (currentPath !== undefined) {
      result.push({
        worktreePath: currentPath,
        branch: currentBranch ?? "",
      });
    }
    currentPath = undefined;
    currentBranch = undefined;
  };

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    const sep = line.indexOf(" ");
    const key = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? "" : line.slice(sep + 1);

    if (key === "worktree") {
      // A new record begins; flush any in-progress one defensively.
      flush();
      currentPath = value;
    } else if (key === "branch") {
      // e.g. "refs/heads/codex/<run>/<worker>" → "codex/<run>/<worker>".
      currentBranch = value.startsWith("refs/heads/")
        ? value.slice("refs/heads/".length)
        : value;
    }
    // Other keys (HEAD, detached, bare, locked, prunable, ...) are ignored.
  }
  flush();

  return result;
}

/**
 * Default {@link WorktreeManager} implementation backed by `git worktree`.
 * Stateless: all truth lives in git itself.
 */
class GitWorktreeManager implements WorktreeManager {
  /**
   * Create `.worktrees/codex-<workerId>` on branch `codex/<runId>/<workerId>`
   * from `baseBranch` (default `"main"`). Guards against a duplicate path: if a
   * worktree already exists at the target path, the call fails with a clear
   * error rather than letting git produce a confusing message (spec §24 rule 1:
   * never allow two write workers in the same directory).
   */
  async createWorktree(
    runId: string,
    workerId: string,
    baseBranch = "main",
  ): Promise<WorktreeInfo> {
    await assertGitRepo();

    const worktreePath = path.join(
      config.projectDir,
      WORKTREES_DIRNAME,
      `codex-${workerId}`,
    );
    const branch = `codex/${runId}/${workerId}`;

    const existing = await this.listWorktrees();
    if (existing.some((w) => path.resolve(w.worktreePath) === worktreePath)) {
      throw new Error(
        `A worktree already exists at ${worktreePath}; ` +
          `refusing to create a duplicate for worker ${workerId}.`,
      );
    }

    logger.info(
      `creating worktree ${worktreePath} on branch ${branch} from ${baseBranch}`,
    );
    await git([
      "worktree",
      "add",
      worktreePath,
      "-b",
      branch,
      baseBranch,
    ]);

    return { worktreePath, branch };
  }

  /**
   * Remove a worktree previously created by {@link createWorktree}. Uses
   * `--force` so an unclean tree (the common case after a write worker runs)
   * does not block teardown (spec §24 rule 4: worktrees should be easy to
   * delete after the run).
   */
  async removeWorktree(worktreePath: string): Promise<void> {
    logger.info(`removing worktree ${worktreePath}`);
    await git(["worktree", "remove", "--force", worktreePath]);
  }

  /**
   * List existing worktrees managed under `.worktrees/`. The repository's main
   * worktree and any unrelated worktrees are filtered out so callers only see
   * the ones this manager owns.
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    const stdout = await git(["worktree", "list", "--porcelain"]);
    const managedRoot =
      path.join(config.projectDir, WORKTREES_DIRNAME) + path.sep;

    return parseWorktreePorcelain(stdout).filter((w) => {
      const resolved = path.resolve(w.worktreePath);
      return resolved.startsWith(managedRoot);
    });
  }

  /**
   * Compute a unified diff of `dir`'s working tree against HEAD, including
   * untracked (newly created) files. Codex app-server v2 reports file changes
   * only inside `item/fileChange` items and never emits a `turn/diff/updated`
   * notification, so the bridge derives `diff.patch` from git itself — the
   * canonical "what would be applied" view.
   *
   * Works for any write worker's directory: an isolated worktree (the normal
   * case, where `dir` starts clean so only the worker's changes appear) or, less
   * commonly, a write worker running directly in the project tree.
   *
   * The operation is NON-DESTRUCTIVE: it runs against a throwaway index file
   * (`GIT_INDEX_FILE`) seeded from HEAD, so the worker's / user's real git index
   * is never touched. `add --intent-to-add` into that scratch index makes
   * untracked files render as additions; tracked modifications and deletions
   * already show in `git diff HEAD`. Best-effort: a non-repo or git failure
   * surfaces as a thrown Error for the caller to swallow.
   *
   * NOTE: for a write worker in the project tree (no worktree), the diff is
   * working-tree-vs-HEAD, so any pre-existing uncommitted edits are included
   * alongside the worker's — unavoidable without separate baseline tracking.
   * Isolated worktrees (the recommended write mode) do not have this caveat.
   */
  async diffWorkdir(dir: string): Promise<string> {
    // A scratch index OUTSIDE the repo, so it never appears in the diff itself.
    const scratch = mkdtempSync(path.join(os.tmpdir(), "codex-diff-"));
    const indexFile = path.join(scratch, "index");
    const env = { ...process.env, GIT_INDEX_FILE: indexFile };
    const run = async (args: string[]): Promise<string> => {
      const { stdout } = await execFileAsync("git", ["-C", dir, ...args], {
        env,
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    };
    // Exclude the bridge's own bookkeeping dirs so they never pollute the diff
    // of a write worker running directly in the project tree (a worktree never
    // contains these, so the excludes are harmless no-ops there).
    const excludePathspec = [
      ".",
      ":(exclude).codex-workers",
      `:(exclude)${WORKTREES_DIRNAME}`,
    ];
    try {
      await run(["read-tree", "HEAD"]); // seed scratch index from HEAD
      await run(["add", "--intent-to-add", "--all", "--", ...excludePathspec]);
      return await run(["diff", "HEAD", "--", ...excludePathspec]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/** Eagerly-constructed singleton worktree manager for the bridge process. */
export const worktreeManager: WorktreeManager = new GitWorktreeManager();

export { GitWorktreeManager };
