/**
 * Stderr-only logger.
 *
 * The bridge process speaks the MCP protocol over STDOUT, so NOTHING may ever
 * be written there outside the MCP transport. Every diagnostic goes to STDERR.
 *
 * Local-import convention: extensionless, e.g. `import { logger } from "./logger";`.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Minimum level to emit, controlled by `CODEX_WORKERS_LOG_LEVEL` (default "info"). */
function configuredLevel(): LogLevel {
  const raw = (process.env.CODEX_WORKERS_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

const minLevel = LEVEL_ORDER[configuredLevel()];

function write(level: LogLevel, args: unknown[]): void {
  if (LEVEL_ORDER[level] < minLevel) return;

  const parts = args.map((a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack ?? a.message;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  });

  const line = `[codex-workers] [${new Date().toISOString()}] [${level}] ${parts.join(" ")}\n`;
  // STDERR ONLY — never process.stdout (reserved for MCP).
  process.stderr.write(line);
}

/** Tiny stderr-only logger. Never writes to stdout. */
export const logger = {
  debug: (...args: unknown[]): void => write("debug", args),
  info: (...args: unknown[]): void => write("info", args),
  warn: (...args: unknown[]): void => write("warn", args),
  error: (...args: unknown[]): void => write("error", args),
};

export type Logger = typeof logger;
