#!/usr/bin/env bash
# Provision the dev environment for the Codex Workers for Claude plugin.
# Runs once after the container is created.
set -euo pipefail

echo "==> Configuring git for worktree-based Codex workers (spec §24)"
# The bridge creates worktrees under .worktrees/ and branches under codex/<run>/<worker>.
# A sane default branch name avoids 'master' surprises when workers branch off.
git config --global init.defaultBranch main
# Mark the workspace as a safe directory (volume-mounted dirs can trip ownership checks).
git config --global --add safe.directory "$(pwd)" || true

echo "==> Installing project dependencies"
if [ -f package-lock.json ]; then
  npm ci
elif [ -f package.json ]; then
  npm install
else
  # Greenfield repo (spec only, no package.json yet). Make the build toolchain
  # from spec §34 available so `esbuild ... --outfile=.../bridge.js` works.
  echo "    no package.json yet — installing build toolchain globally"
  npm install -g esbuild typescript
fi

echo "==> Installing the Claude Code CLI (plugin host, spec §10)"
npm install -g @anthropic-ai/claude-code || \
  echo "    WARN: could not install @anthropic-ai/claude-code — install manually if needed"

echo "==> Installing the Codex CLI (worker backend, spec §10)"
npm install -g @openai/codex || \
  echo "    WARN: could not install @openai/codex — install manually if needed"

echo ""
echo "==> Done. Versions:"
node --version
npm --version
git --version
command -v claude >/dev/null 2>&1 && claude --version || echo "claude: not on PATH"
command -v codex  >/dev/null 2>&1 && codex --version  || echo "codex: not on PATH"

echo ""
echo "Next steps:"
echo "  - Log in to Codex:  codex login"
echo "  - Build the bridge: esbuild src/bridge/index.ts --bundle --platform=node \\"
echo "                        --target=node20 --outfile=plugins/codex-workers/dist/bridge.js"
