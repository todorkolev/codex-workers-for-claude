#!/usr/bin/env bash
#
# Install the "codex-workers" Claude Code plugin via the Claude CLI.
#
# This script is self-contained: it talks to the remote marketplace
# (the GitHub repo) and needs no local checkout. Any prior install of the
# plugin and its marketplace is removed first so re-running always yields a
# clean, up-to-date install.
#
# Usage (run from anywhere):
#   curl -fsSL https://raw.githubusercontent.com/todorkolev/codex-workers-for-claude/main/scripts/install.sh | bash
#
# or, from a checkout:
#   bash scripts/install.sh
#
# After it finishes, run `/reload-plugins` (or restart Claude Code) to load
# the plugin in an active session.

set -euo pipefail

MARKETPLACE="codex-workers"
PLUGIN="codex-workers@codex-workers"
SOURCE="todorkolev/codex-workers-for-claude"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

if ! command -v claude >/dev/null 2>&1; then
  echo "error: the 'claude' CLI was not found on PATH." >&2
  echo "       Install Claude Code first: https://docs.claude.com/en/docs/claude-code" >&2
  exit 1
fi

# 1. Remove any previously installed version (ignore errors when absent).
log "Removing existing plugin (if present)…"
claude plugin uninstall "$PLUGIN" -y >/dev/null 2>&1 || true

log "Removing existing marketplace (if present)…"
claude plugin marketplace remove "$MARKETPLACE" >/dev/null 2>&1 || true

# 2. Add the marketplace fresh from the GitHub repo.
log "Adding marketplace from $SOURCE…"
claude plugin marketplace add "$SOURCE"

# 3. Install the plugin.
log "Installing $PLUGIN…"
claude plugin install "$PLUGIN"

log "Done. Run /reload-plugins (or restart Claude Code) to activate it."
