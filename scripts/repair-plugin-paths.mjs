#!/usr/bin/env node
/**
 * Doctor + repair for stale Claude Code plugin-registry paths.
 *
 * Claude Code stores ABSOLUTE install paths in
 *   ~/.claude/plugins/installed_plugins.json
 *   ~/.claude/plugins/known_marketplaces.json
 * using the `$HOME` of whatever environment ran the install. When the same
 * `~/.claude` is later used from a different environment (classic case: the
 * plugin installed inside a devcontainer as user `node` writes `/home/node/...`,
 * but the plugin is then loaded on a host where `$HOME` is `/home/user`), the
 * recorded paths point at a directory that does not exist and Claude Code
 * silently fails to load the plugin ("1 error during load", nothing named).
 *
 * This script reconciles those recorded paths with reality. It anchors on the
 * ACTUAL location of the registry files (not a hardcoded old-home string), so it
 * repairs any stale prefix. It is plain Node with no dependencies and needs no
 * build step or plugin checkout — run it even when the plugin is completely
 * dead:
 *
 *   node scripts/repair-plugin-paths.mjs          # diagnose only (safe)
 *   node scripts/repair-plugin-paths.mjs --fix     # back up + rewrite
 *
 * Or straight from the web, no checkout needed:
 *
 *   curl -fsSL https://raw.githubusercontent.com/todorkolev/codex-workers-for-claude/main/scripts/repair-plugin-paths.mjs | node - --fix
 *
 * After a fix: run /reload-plugins and restart the session so the MCP server
 * binds.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const APPLY = process.argv.includes("--fix");
const CLAUDE_MARKER = `${path.sep}.claude${path.sep}`;

function resolveClaudeDir() {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim() !== "") return path.resolve(override);
  return path.join(os.homedir(), ".claude");
}

function registryFiles(claudeDir) {
  const pluginsDir = path.join(claudeDir, "plugins");
  return [
    path.join(pluginsDir, "installed_plugins.json"),
    path.join(pluginsDir, "known_marketplaces.json"),
  ];
}

/** Re-root a stale `.claude` path onto `claudeDir`; null if not applicable. */
function rerootIfStale(value, claudeDir) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!path.isAbsolute(value)) return null;
  const idx = value.indexOf(CLAUDE_MARKER);
  if (idx < 0) return null;
  if (fs.existsSync(value)) return null; // already valid
  const candidate = path.join(claudeDir, value.slice(idx + CLAUDE_MARKER.length));
  if (candidate === value || !fs.existsSync(candidate)) return null;
  return candidate;
}

function walk(node, claudeDir, file, healed, unresolved) {
  if (typeof node === "string") {
    const fixed = rerootIfStale(node, claudeDir);
    if (fixed) {
      healed.push({ file, from: node, to: fixed });
      return fixed;
    }
    if (path.isAbsolute(node) && node.indexOf(CLAUDE_MARKER) >= 0 && !fs.existsSync(node)) {
      unresolved.push({ file, from: node });
    }
    return node;
  }
  if (Array.isArray(node)) return node.map((n) => walk(n, claudeDir, file, healed, unresolved));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, claudeDir, file, healed, unresolved);
    return out;
  }
  return node;
}

const claudeDir = resolveClaudeDir();
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

console.log(bold("codex-workers · plugin-path doctor"));
console.log(dim(`anchor: ${claudeDir}`));
console.log("");

let totalHealed = 0;
let totalUnresolved = 0;
let changedFiles = 0;
let anyFile = false;

for (const file of registryFiles(claudeDir)) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    console.log(dim(`skip  ${file} (not found)`));
    continue;
  }
  anyFile = true;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log(red(`skip  ${file} (malformed JSON — not touched)`));
    continue;
  }

  const healed = [];
  const unresolved = [];
  const next = walk(parsed, claudeDir, file, healed, unresolved);

  if (healed.length === 0 && unresolved.length === 0) {
    console.log(green(`ok    ${file}`));
    continue;
  }

  console.log(bold(file));
  for (const h of healed) {
    console.log(`  ${yellow("stale")} ${h.from}`);
    console.log(`  ${green("→ fix")} ${h.to}`);
  }
  for (const u of unresolved) {
    console.log(`  ${red("missing")} ${u.from}`);
    console.log(`  ${dim("        no matching path under the current .claude — cannot auto-repair")}`);
  }

  totalHealed += healed.length;
  totalUnresolved += unresolved.length;

  if (APPLY && healed.length > 0) {
    const backup = `${file}.bak`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
    changedFiles += 1;
    console.log(green(`  wrote ${file}  (backup: ${path.basename(backup)})`));
  }
}

console.log("");
if (!anyFile) {
  console.log(yellow("No registry files found. Is Claude Code installed for this user?"));
  console.log(dim(`Looked under ${path.join(claudeDir, "plugins")}. Set CLAUDE_CONFIG_DIR if your config lives elsewhere.`));
  process.exit(0);
}

if (totalHealed === 0 && totalUnresolved === 0) {
  console.log(green("All recorded plugin paths resolve. Nothing to do."));
  process.exit(0);
}

if (APPLY) {
  if (changedFiles > 0) {
    console.log(green(`Repaired ${totalHealed} path(s) across ${changedFiles} file(s).`));
    console.log("Next: run /reload-plugins, then restart the session so the MCP server binds.");
  }
  if (totalUnresolved > 0) {
    console.log(yellow(`${totalUnresolved} path(s) could not be auto-repaired (see 'missing' above).`));
    process.exit(2);
  }
  process.exit(0);
} else {
  if (totalHealed > 0) {
    console.log(bold(`Found ${totalHealed} stale path(s). Re-run with --fix to repair:`));
    console.log(`  node ${path.relative(process.cwd(), process.argv[1]) || process.argv[1]} --fix`);
  }
  if (totalUnresolved > 0) {
    console.log(yellow(`${totalUnresolved} path(s) are missing with no re-rootable match.`));
  }
  process.exit(1);
}
