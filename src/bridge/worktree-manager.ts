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
}

/** Eagerly-constructed singleton worktree manager for the bridge process. */
export const worktreeManager: WorktreeManager = new GitWorktreeManager();

export { GitWorktreeManager };
