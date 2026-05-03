#!/bin/bash
# Wrapper for systemd. Sources nvm so the current default Node is on
# PATH regardless of which version is active — the .service file points
# at this script, not at a versioned node binary, so a `nvm install`
# upgrade doesn't silently break the timer.
set -euo pipefail

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" --no-use
  # Prefer the user's nvm-default; fall back to whatever's resolvable.
  nvm use default >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  for p in /usr/local/bin/node /usr/bin/node; do
    [ -x "$p" ] && { export PATH="$(dirname "$p"):$PATH"; break; }
  done
fi

exec node "$(dirname "$0")/watcher.js"
