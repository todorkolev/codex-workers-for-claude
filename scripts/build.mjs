/**
 * Bundle the bridge into a single committed JS file (spec §34), inlining the
 * package version at build time via esbuild `--define:__BRIDGE_VERSION__`.
 *
 * We inline the version (rather than reading process.env.npm_package_version at
 * runtime) because the actual MCP launch is a bare `node dist/bridge.js`, where
 * that env var is unset — the bridge would otherwise always report a stale
 * literal. This keeps serverInfo/handshake in lock-step with package.json.
 */

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = typeof pkg.version === "string" ? pkg.version : "0.0.0-dev";

await build({
  entryPoints: [path.join(root, "src/bridge/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
  define: { __BRIDGE_VERSION__: JSON.stringify(version) },
  outfile: path.join(root, "plugins/codex-workers/dist/bridge.js"),
});

process.stderr.write(`built bridge.js (version ${version})\n`);
