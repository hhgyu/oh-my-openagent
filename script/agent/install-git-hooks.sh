#!/usr/bin/env bash
# Point git at the committed hooks in .githooks/ (core.hooksPath). Called by setup.sh; safe to run on its own
# and to re-run. It never replaces a hooks path you already set, and it does not take over a .git/hooks
# directory that already holds your own hooks, because core.hooksPath would silently disable them.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

log() { printf '[git-hooks] %s\n' "$*"; }

current="$(git config --get core.hooksPath || true)"
if [ "$current" = ".githooks" ]; then
  log "core.hooksPath is already .githooks"
  exit 0
fi
if [ -n "$current" ]; then
  log "WARN: core.hooksPath is '$current'; leaving it. Call .githooks/pre-commit from your own pre-commit to get the format check."
  exit 0
fi

hooks_dir="$(git rev-parse --git-common-dir)/hooks"
own_hooks=""
if [ -d "$hooks_dir" ]; then
  for hook in "$hooks_dir"/*; do
    [ -f "$hook" ] || continue
    case "$hook" in *.sample) continue ;; esac
    own_hooks="$own_hooks $(basename "$hook")"
  done
fi
if [ -n "$own_hooks" ]; then
  log "WARN: $hooks_dir already holds hooks ($own_hooks ); leaving core.hooksPath unset. Call .githooks/pre-commit from your own pre-commit to get the format check."
  exit 0
fi

git config core.hooksPath .githooks
log "core.hooksPath set to .githooks (pre-commit format check)"
