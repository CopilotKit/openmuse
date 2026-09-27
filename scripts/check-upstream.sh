#!/usr/bin/env bash
# Check for upstream updates from copilotkit/OpenMuse.
# This is a one-way sync: it FETCHES only, never merges or pushes.
# Review the diff manually, then merge with: git merge --ff-only origin/main
set -euo pipefail

REPO_DIR="/home/ubuntu/OpenMuse"
LOG_FILE="${REPO_DIR}/.upstream-updates.log"
cd "$REPO_DIR"

NEW_HASH=$(git ls-remote https://github.com/copilotkit/OpenMuse.git HEAD 2>/dev/null | awk '{print $1}')
LOCAL_HASH=$(git rev-parse HEAD 2>/dev/null)

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [ "$NEW_HASH" = "$LOCAL_HASH" ]; then
  echo "[$TIMESTAMP] Up to date. Local: ${LOCAL_HASH:0:8}" >> "$LOG_FILE"
  exit 0
fi

# Fetch to inspect
git fetch origin main 2>/dev/null || true
COMMITS=$(git rev-list --oneline "${LOCAL_HASH}..${LOCAL_HASH}..origin/main}" 2>/dev/null | wc -l | tr -d ' ')
# Fallback if the above range is wrong
if [ -z "$COMMITS" ] || [ "$COMMITS" = "0" ]; then
  COMMITS=$(git rev-list --oneline "${LOCAL_HASH}..origin/main" 2>/dev/null | wc -l | tr -d ' ')
fi

if [ -n "$COMMITS" ] && [ "$COMMITS" -gt 0 ]; then
  echo "[$TIMESTAMP] NEW COMMITS AVAILABLE ($COMMITS). Local: ${LOCAL_HASH:0:8}, Upstream: ${NEW_HASH:0:8}" >> "$LOG_FILE"
  git log --oneline "${LOCAL_HASH}..origin/main" | head -20 >> "$LOG_FILE" 2>/dev/null || true
  # Save a diff summary for review
  git diff --stat "${LOCAL_HASH}" "origin/main" > "${REPO_DIR}/.upstream-diff-summary.txt" 2>/dev/null || true
  echo "Review with: git log --oneline ${LOCAL_HASH}..origin/main" >> "$LOG_FILE"
  echo "Apply with:  git merge --ff-only origin/main" >> "$LOG_FILE"
  echo "DIFF_SUMMARY=${REPO_DIR}/.upstream-diff-summary.txt" >> "$LOG_FILE"
else
  echo "[$TIMESTAMP] Hash mismatch but no new commits in range. Local: ${LOCAL_HASH:0:8}, Upstream: ${NEW_HASH:0:8}" >> "$LOG_FILE"
fi

echo "--- [Last 10 log entries] ---"
tail -10 "$LOG_FILE"
