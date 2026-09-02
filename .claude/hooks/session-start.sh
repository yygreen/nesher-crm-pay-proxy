#!/bin/bash
# SessionStart hook — Claude Code on the web only.
# Installs the (tiny) dependency set so `npm test` and `node --check` work at once.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
# npm install (not ci) so the cached container layer is reused between sessions.
npm install --no-audit --no-fund
