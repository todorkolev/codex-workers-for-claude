/**
 * Bridge runtime configuration, resolved from the environment variables the
 * plugin's `.mcp.json` sets (spec §9). Pure module: reading it has no side
 * effects beyond resolving paths.
 *
 * Local-import convention: extensionless, e.g. `import { config } from "./config";`.
 */

import * as path from "node:path";
import { limits } from "./types";

/** Read an env var, returning `fallback` when unset or empty. */
function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value;
}

/**
 * Resolved bridge configuration.
 *
 * - `pluginRoot`  — `CLAUDE_PLUGIN_ROOT` (where `dist/bridge.js` lives).
 * - `dataDir`     — `CLAUDE_PLUGIN_DATA` (plugin-private scratch, optional).
 * - `projectDir`  — the active project (`CLAUDE_PROJECT_DIR`), default cwd.
 * - `artifactBase`— `<projectDir>/.codex-workers` (spec §14).
 */
export type BridgeConfig = {
  pluginRoot?: string;
  dataDir?: string;
  projectDir: string;
  artifactBase: string;
};

/** Resolve {@link BridgeConfig} from the current process environment (spec §9, §14). */
export function loadConfig(): BridgeConfig {
  const pluginRoot = env("CODEX_WORKERS_PLUGIN_ROOT");
  const dataDir = env("CODEX_WORKERS_DATA");
  const projectDir = path.resolve(
    env("CODEX_WORKERS_PROJECT_DIR", process.cwd()) as string,
  );
  const artifactBase = path.join(projectDir, ".codex-workers");

  return { pluginRoot, dataDir, projectDir, artifactBase };
}

/** Eagerly-resolved configuration for the running bridge process. */
export const config: BridgeConfig = loadConfig();

/** Re-export of the §33 shared limits for convenience. */
export { limits };
