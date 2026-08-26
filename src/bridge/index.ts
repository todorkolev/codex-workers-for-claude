/**
 * Bridge entrypoint — the `codex-worker-bridge` MCP server process.
 *
 * Lifecycle:
 *   1. Probe Codex availability (spec §32). On failure we STILL start the MCP
 *      server so Claude can connect — every tool then returns the structured
 *      "Codex is unavailable" failure (the server factory re-checks lazily).
 *   2. Establish a stable per-process `runId` (spec §14, date+counter style),
 *      derived from the existing run directories so it never collides.
 *   3. Build the MCP server (registers the seven tools) and connect it to a
 *      stdio transport.
 *
 * stdout is reserved for the MCP protocol. Every diagnostic goes to stderr via
 * the shared logger.
 *
 * Local-import convention: extensionless (bundler moduleResolution + esbuild).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { config } from "./config";
import { logger } from "./logger";
import { checkCodexAvailable } from "./codex-adapter";
import { createMcpServer } from "./mcp-server";
import { healRegistryPaths } from "./path-heal";

/**
 * Best-effort reconciliation of stale absolute paths in Claude Code's plugin
 * registry (see path-heal.ts). Runs before anything else and NEVER throws —
 * a broken heal must not take down the bridge. Opt out with
 * `CODEX_WORKERS_NO_SELF_HEAL=1`.
 */
function selfHealRegistryPaths(): void {
  if (process.env.CODEX_WORKERS_NO_SELF_HEAL === "1") return;
  try {
    const result = healRegistryPaths({ apply: true });
    for (const h of result.healed) {
      logger.info(`self-heal: rewrote stale registry path`, {
        from: h.from,
        to: h.to,
      });
    }
    if (result.changedFiles.length > 0) {
      logger.info(
        `self-heal: reconciled ${result.changedFiles.length} registry file(s) to the current environment.`,
      );
    }
    for (const u of result.unresolved) {
      logger.warn(
        `self-heal: recorded path is missing and could not be repaired automatically`,
        { path: u.from, hint: "run scripts/repair-plugin-paths.mjs" },
      );
    }
  } catch (err) {
    logger.warn("self-heal: skipped (non-fatal)", err);
  }
}

/**
 * Bridge version, inlined at build time via esbuild `--define:__BRIDGE_VERSION__`
 * (the build script reads it from package.json). We do NOT read
 * `process.env.npm_package_version` — it is unset for the actual MCP launch
 * (bare `node dist/bridge.js`), which would pin the version to a stale literal.
 * `declare` keeps the symbol typed without emitting it; the `typeof` guard makes
 * source-mode (ts-node/typecheck) tolerant when the define is absent.
 */
declare const __BRIDGE_VERSION__: string;
const BRIDGE_VERSION: string =
  typeof __BRIDGE_VERSION__ === "string" ? __BRIDGE_VERSION__ : "0.0.0-dev";

/**
 * Allocate a stable per-process run id of the form `YYYY-MM-DD-NNN` (spec §14),
 * choosing the lowest unused counter for today under `<artifactBase>/runs/`.
 * Never throws: a missing/unreadable runs directory simply yields counter 001.
 */
async function allocateRunId(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const runsDir = path.join(config.artifactBase, "runs");

  let existing: string[] = [];
  try {
    existing = await fs.readdir(runsDir);
  } catch {
    // No runs directory yet → first run of the day.
    existing = [];
  }

  const prefix = `${today}-`;
  let maxCounter = 0;
  for (const name of existing) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    const n = Number.parseInt(suffix, 10);
    if (Number.isFinite(n) && n > maxCounter) maxCounter = n;
  }

  const counter = (maxCounter + 1).toString().padStart(3, "0");
  return `${prefix}${counter}`;
}

/** Boot the bridge: probe Codex, build the server, connect stdio. */
async function main(): Promise<void> {
  logger.info(`codex-worker-bridge v${BRIDGE_VERSION} starting`, {
    projectDir: config.projectDir,
    artifactBase: config.artifactBase,
  });

  // Reconcile any stale absolute paths left in Claude Code's plugin registry by
  // an install performed under a different `$HOME` (best-effort; never throws).
  selfHealRegistryPaths();

  // §32: probe but DO NOT abort — the server still starts so tools can return
  // the structured "Codex is unavailable" failure.
  const availability = await checkCodexAvailable();
  if (!availability.available) {
    logger.warn(
      "Codex is unavailable at startup; tools will return a failure result.",
      { recovery: availability.recovery },
    );
  } else {
    logger.info("Codex CLI is available and logged in.");
  }

  const runId = await allocateRunId();
  logger.info(`run id: ${runId}`);

  const server = createMcpServer({
    runId,
    version: BRIDGE_VERSION,
    checkCodexAvailable,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server connected over stdio; awaiting tool calls.");

  // Keep the process alive until stdin closes / the transport ends.
  const shutdown = (signal: string): void => {
    logger.info(`received ${signal}; shutting down.`);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  // Last-resort guard: log to stderr and exit non-zero. Never write to stdout.
  logger.error("fatal: bridge failed to start", err);
  process.exit(1);
});
