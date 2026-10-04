#!/usr/bin/env bash
# Check for upstream updates from copilotkit/OpenMuse.
#
# THIS IS A HARD FORK. `upstream` is read-only (its pushurl is never://blocked)
# and `origin` is Wiltermoodj/openmuse, where our work actually lands.
#
# There is NO fast-forward path: we are permanently diverged, so `git merge
# --ff-only upstream/main` cannot succeed and must not be attempted. Updates are
# cherry-picked selectively after review — most upstream commits are cosmetic or
# assume a hosted-execution model we deliberately do not use.
#
# Review, then cherry-pick what serves us:
#   git log --oneline upstream/main..$(git merge-base HEAD upstream/main) --reverse
#   git cherry-pick <sha>
#
# REPO_DIR defaults to the directory containing this script, but can be
# overridden via the REPO_DIR environment variable for portability.
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_FILE="${REPO_DIR}/.upstream-updates.log"
MAX_LOG_ENTRIES=100  # Keep the last 100 weekly checks (~2 years)

cd "$REPO_DIR"

NEW_HASH=$(git ls-remote https://github.com/copilotkit/OpenMuse.git HEAD 2>/dev/null | awk '{print $1}')
LOCAL_HASH=$(git merge-base HEAD upstream/main 2>/dev/null || git rev-parse HEAD 2>/dev/null)

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [ -z "$NEW_HASH" ]; then
  echo "[$TIMESTAMP] WARN: Could not reach GitHub (network issue or rate limit). Skipping check." >> "$LOG_FILE"
  exit 0
fi

if [ "$NEW_HASH" = "$LOCAL_HASH" ]; then
  echo "[$TIMESTAMP] Up to date with upstream. Base: ${LOCAL_HASH:0:8}" >> "$LOG_FILE"
  # Rotate log to prevent unbounded growth
  tail -n "$MAX_LOG_ENTRIES" "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  exit 0
fi

# Fetch upstream only — never our own fork (reading origin/main would compare
# our own work against itself and always report divergence).
git fetch upstream main 2>/dev/null || true

# Count upstream commits we have not yet seen: upstream..merge-base
COMMITS=$(git rev-list --oneline "${LOCAL_HASH}..upstream/main" 2>/dev/null | wc -l | tr -d ' ')

if [ -n "$COMMITS" ] && [ "$COMMITS" -gt 0 ]; then
  echo "[$TIMESTAMP] UPSTREAM AHEAD ($COMMITS commits, not merged — hard fork). Base: ${LOCAL_HASH:0:8}, Upstream: ${NEW_HASH:0:8}" >> "$LOG_FILE"
  git log --oneline "${LOCAL_HASH}..upstream/main" | head -20 >> "$LOG_FILE" 2>/dev/null || true
  # Save a diff summary for review
  git diff --stat "${LOCAL_HASH}" "upstream/main" > "${REPO_DIR}/.upstream-diff-summary.txt" 2>/dev/null || true
  echo "Review with:  git log --oneline ${LOCAL_HASH:0:8}..upstream/main --reverse" >> "$LOG_FILE"
  echo "Apply with:   git cherry-pick <sha>   (NOT merge --ff-only: we are hard-forked)" >> "$LOG_FILE"
  echo "DIFF_SUMMARY=${REPO_DIR}/.upstream-diff-summary.txt" >> "$LOG_FILE"
else
  echo "[$TIMESTAMP] Already at upstream tip. Base: ${LOCAL_HASH:0:8}, Upstream: ${NEW_HASH:0:8}" >> "$LOG_FILE"
fi

# Rotate log
tail -n "$MAX_LOG_ENTRIES" "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"

echo "--- [Last 10 log entries] ---"
tail -10 "$LOG_FILE"