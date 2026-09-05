# Development

How to build, type-check, and extend the Codex Worker Bridge, and how to
regenerate the Codex protocol bindings on demand. See
[architecture.md](./architecture.md) for the runtime design and
[codex-app-server-protocol.md](./codex-app-server-protocol.md) for the wire
protocol ground truth.

## Prerequisites

```text
- Node.js 20+   (verified: v20.20.2)
- Codex CLI     (verified: codex-cli 0.135.0, logged in via ChatGPT)
- Git
```

Install dev dependencies once:

```bash
npm install
```

## Repository layout (spec §6)

```text
codex-workers-for-claude/
  .claude-plugin/marketplace.json        # marketplace definition (spec §7)
  plugins/codex-workers/
    .claude-plugin/plugin.json           # plugin manifest (spec §8)
    .mcp.json                            # MCP server config (spec §9)
    skills/codex-worker/SKILL.md         # spec §25
    agents/codex-commander.md            # spec §26
    commands/codex-worker.md             # spec §27
    bin/codex-workers-bridge             # optional wrapper script
    dist/bridge.js                       # bundled bridge (committed, spec §34)
    README.md
  src/bridge/
    index.ts            # entry point
    mcp-server.ts       # MCP tool registration + dispatch
    codex-adapter.ts    # one codex app-server child + one thread
    worker-registry.ts  # registry, state transitions, §33 limits
    transcript-filter.ts# normalize + §22 forwarding + §23 summaries
    artifact-store.ts   # .codex-workers/ file layout (§14)
    worktree-manager.ts # isolated git worktrees (§24)
    safety.ts           # destructive blocklist + approval decisions (§31)
    config.ts           # env-resolved configuration (§9/§14)
    logger.ts           # stderr-only logging
    types.ts            # shared type contract (names match the spec)
  docs/
    architecture.md  usage.md  development.md
    spec.md  codex-app-server-protocol.md
```

The plugin must be self-contained: after install, Claude Code may copy
`plugins/codex-workers/` into a plugin cache, so the plugin must not depend on
anything outside that directory at runtime. That is why `dist/bridge.js` is
bundled and committed.

## Build (spec §34)

The bridge is written in TypeScript and bundled into a single JS file committed
into the plugin directory. This avoids requiring users to `npm install`.

```bash
npm run build
```

This runs (see `package.json`):

```bash
esbuild src/bridge/index.ts \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=esm \
  --banner:js="#!/usr/bin/env node" \
  --outfile=plugins/codex-workers/dist/bridge.js
```

Notes:

- Output is ESM (the package is `"type": "module"`) with a `#!/usr/bin/env node`
  shebang so it can also be invoked directly via the `bin/` wrapper.
- `target=node20` matches the supported runtime.
- `plugins/codex-workers/dist/` is intentionally **not** git-ignored — the
  bundled `bridge.js` MUST be committed (see `.gitignore`). Rebuild and commit
  `dist/bridge.js` whenever the bridge source changes.
- **Bump the version whenever the bridge changes.** The plugin cache is keyed by
  version (`plugins/codex-workers/.claude-plugin/plugin.json`), so a rebuilt
  `dist/bridge.js` shipped under the same version will **not** propagate — the
  installer sees the version already present and serves stale code. Bump
  `package.json` (inlined into the bridge handshake by the build) and
  `plugin.json` together, then rebuild. And note that even once the cache
  refreshes, the running MCP server only picks up the new bridge on a full
  Claude Code restart — not `/reload-plugins`.

## Type-check

```bash
npm run typecheck   # tsc --noEmit
```

The project is strictly typed: `strict`, `noUncheckedIndexedAccess`,
`noImplicitOverride`, `isolatedModules`, `moduleResolution: "bundler"` (see
`tsconfig.json`). Local imports are **extensionless** (e.g.
`import { logger } from "./logger";`) — the bundler resolves them.

Run both before committing:

```bash
npm run typecheck && npm run build
```

## Regenerating the Codex protocol bindings

The exact protocol types are **not committed** to this repo — they are large,
version-pinned generated code, regenerable on demand. Regenerate them (to a
scratch dir) when upgrading the Codex CLI, using the CLI's own generator:

```bash
codex app-server generate-ts --out /tmp/codex-app-server-ts
```

Useful flags (from `codex app-server generate-ts --help`):

- `-o, --out <DIR>` — output directory (required).
- `--experimental` — include experimental methods and fields.
- `-p, --prettier <PRETTIER_BIN>` — optionally format the generated files.

After regenerating:

1. Re-grep the bindings for any wire shapes the adapter relies on (e.g.
   `*ApprovalResponse.ts` decision enums) — never guess a shape; read the
   binding.
2. Update `docs/codex-app-server-protocol.md` if observed behavior changed.
   (That doc is the committed ground truth; the adapter follows it.)
3. Re-run `npm run typecheck && npm run build`.

> The regenerated bindings are reference material. The adapter still parses Codex
> output **defensively** — unknown methods/fields must never crash the bridge,
> because Codex versions change between regenerations.

## Coding rules

- **stdout is reserved for the MCP protocol.** Never write to `process.stdout`
  outside the MCP transport. All diagnostics go through `logger.ts` (stderr);
  each worker's `codex app-server` stderr is captured to its `error.log`.
- **Parse defensively.** Unknown JSON-RPC methods/fields are normalized to
  `unknown` and stored raw, never thrown.
- **Persist raw before filtering.** Every inbound line is appended to
  `events.ndjson` before the transcript filter runs.
- **Match the spec's type names exactly.** `src/bridge/types.ts` is the single
  source of truth; its names mirror the spec verbatim (§12–§22, §33).
- Keep functions focused and readable; keep pure modules (transcript filter,
  safety layer) free of I/O.

## Local smoke test

Verify Codex is reachable before debugging the bridge:

```bash
codex --version          # expect codex-cli 0.135.0+
codex login status       # expect "Logged in using ChatGPT"
```

The bridge fails fast if Codex is missing or not logged in (spec §32):

```json
{
  "state": "failed",
  "error": "Codex is unavailable",
  "recovery": "Check that Codex CLI is installed and logged in (codex login)."
}
```

## Development phases (spec §35)

The implementation follows these phases; they are a useful map for where new
work belongs.

### Phase 1 — Single worker MVP
`codex_worker_start`, `codex_worker_read_messages`, `codex_worker_steer`,
`codex_worker_collect_result`. Read-only mode only. Store `events.ndjson`,
`messages.md`, `result.json`.

### Phase 2 — Write mode and worktrees
`useWorktree`, `workspace-write`, changed files, `diff.patch`, diff summary.
Add safety rules.

### Phase 3 — Multi-worker support
Worker registry, parallel workers, `codex_worker_status`,
`codex_worker_interrupt`, per-run `manifest.json`.

### Phase 4 — Claude Code plugin UX
`skills/codex-worker/SKILL.md`, `agents/codex-commander.md`,
`commands/codex-worker.md`.

### Phase 5 — Ultracode / workflow integration
Example workflows: `investigate → implement → review → verify`.

### Phase 6 — Debug and replay
`codex_worker_debug_trace`, `full_events` mode, event replay.
