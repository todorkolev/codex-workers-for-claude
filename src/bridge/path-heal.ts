/**
 * Registry path self-heal (spec: install robustness).
 *
 * Claude Code's plugin registry (`~/.claude/plugins/installed_plugins.json` and
 * `known_marketplaces.json`) stores **absolute** install paths. Those paths are
 * written using the `$HOME` of whatever environment ran the install. When the
 * same `~/.claude` is later used from a different environment — e.g. a plugin
 * installed inside a devcontainer as user `node` (`/home/node/...`) but then
 * loaded on a host where `$HOME` is `/home/user` — the recorded paths point at a
 * directory that does not exist, so Claude Code silently fails to load the
 * plugin (an unnamed "1 error during load").
 *
 * This module reconciles those recorded paths with reality. For each absolute
 * path recorded under `.claude/`, if the recorded location is missing but the
 * same suffix re-rooted onto the *actual* `.claude` directory (the one we are
 * reading the registry from) exists on disk, we rewrite the prefix. The anchor
 * is the registry file's own location, NOT a hardcoded old-home string, so it
 * repairs any stale prefix — not just `/home/node`.
 *
 * NOTE ON REACHABILITY: when the bridge is running, its own `installPath`
 * already resolved this session (that is how `dist/bridge.js` got launched), so
 * self-heal at bridge start is chiefly a no-op safety net that (a) fixes a stale
 * marketplace `installLocation` while the plugin itself loads, and (b) keeps the
 * registry pointing at the environment that last successfully ran the bridge.
 * The cold-start case — where nothing in the plugin runs at all — is recovered
 * by the standalone `scripts/repair-plugin-paths.mjs` doctor, which shares this
 * algorithm but runs as plain Node without needing the plugin to load.
 *
 * Local-import convention: extensionless, e.g. `import { healRegistryPaths } from "./path-heal";`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** One rewritten path, for reporting/logging. */
export type HealedPath = {
  file: string;
  from: string;
  to: string;
};

/** Outcome of a heal pass. `changedFiles` is empty when nothing needed fixing. */
export type HealResult = {
  /** The `.claude` directory we anchored on (base of the registry). */
  claudeDir: string;
  /** Individual path rewrites applied (or that would be applied in dry-run). */
  healed: HealedPath[];
  /** Files actually rewritten on disk (empty in dry-run). */
  changedFiles: string[];
  /**
   * Paths that are missing on disk AND could not be re-rooted to an existing
   * location — reported so callers can surface a real problem instead of a
   * silent no-op.
   */
  unresolved: HealedPath[];
};

/** Resolve the active `.claude` directory (honours `CLAUDE_CONFIG_DIR`). */
export function resolveClaudeDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim() !== "") return path.resolve(override);
  return path.join(os.homedir(), ".claude");
}

/** The two registry files that carry absolute install paths. */
export function registryFiles(claudeDir: string): string[] {
  const pluginsDir = path.join(claudeDir, "plugins");
  return [
    path.join(pluginsDir, "installed_plugins.json"),
    path.join(pluginsDir, "known_marketplaces.json"),
  ];
}

const CLAUDE_MARKER = `${path.sep}.claude${path.sep}`;

/**
 * Re-root a single recorded path onto `claudeDir` when the recorded location is
 * missing. Returns the corrected path (verified to exist) or `null` when the
 * value is not a re-rootable `.claude` path, is already valid, or the re-rooted
 * candidate does not exist either.
 */
export function rerootIfStale(value: string, claudeDir: string): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  // Only touch absolute paths that live under a `.claude` directory.
  if (!path.isAbsolute(value)) return null;
  const markerIdx = value.indexOf(CLAUDE_MARKER);
  if (markerIdx < 0) return null;

  // Already valid → nothing to do.
  if (fs.existsSync(value)) return null;

  // Suffix after `.../.claude/` re-rooted onto the real `.claude` dir.
  const afterClaude = value.slice(markerIdx + CLAUDE_MARKER.length);
  const candidate = path.join(claudeDir, afterClaude);
  if (candidate === value) return null;
  if (!fs.existsSync(candidate)) return null;
  return candidate;
}

/** Recursively rewrite qualifying string values in-place; returns edits made. */
function healNode(
  node: unknown,
  claudeDir: string,
  file: string,
  healed: HealedPath[],
  unresolved: HealedPath[],
): unknown {
  if (typeof node === "string") {
    const fixed = rerootIfStale(node, claudeDir);
    if (fixed) {
      healed.push({ file, from: node, to: fixed });
      return fixed;
    }
    // Missing-and-unfixable `.claude` path → report as unresolved.
    if (
      path.isAbsolute(node) &&
      node.indexOf(CLAUDE_MARKER) >= 0 &&
      !fs.existsSync(node)
    ) {
      unresolved.push({ file, from: node, to: node });
    }
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item) =>
      healNode(item, claudeDir, file, healed, unresolved),
    );
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = healNode(v, claudeDir, file, healed, unresolved);
    }
    return out;
  }
  return node;
}

/**
 * Reconcile the Claude Code plugin registry's absolute paths with reality.
 *
 * Best-effort and side-effect-safe: any unreadable/malformed file is skipped,
 * and nothing is written unless a rewrite both (a) is needed and (b) resolves to
 * an existing path. A `.bak` copy is made before the first write to each file.
 *
 * @param opts.claudeDir  Anchor directory (defaults to {@link resolveClaudeDir}).
 * @param opts.apply      When false, diagnose only (no writes). Default true.
 */
export function healRegistryPaths(opts?: {
  claudeDir?: string;
  apply?: boolean;
}): HealResult {
  const claudeDir = opts?.claudeDir ?? resolveClaudeDir();
  const apply = opts?.apply ?? true;

  const healed: HealedPath[] = [];
  const unresolved: HealedPath[] = [];
  const changedFiles: string[] = [];

  for (const file of registryFiles(claudeDir)) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue; // Missing/unreadable registry file — skip.
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // Malformed JSON — do not touch.
    }

    const before = healed.length;
    const next = healNode(parsed, claudeDir, file, healed, unresolved);
    const fileChanged = healed.length > before;
    if (!fileChanged || !apply) continue;

    try {
      // Preserve a one-time backup, then write atomically via temp + rename.
      const backup = `${file}.bak`;
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, file);
      changedFiles.push(file);
    } catch {
      // Roll the in-memory record back for this file: we did not persist it.
      healed.length = before;
    }
  }

  return { claudeDir, healed, changedFiles, unresolved };
}
