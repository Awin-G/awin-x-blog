#!/usr/bin/env bash
#
# Stable entrypoint for the deploy systemd unit.
#
# It takes the deploy lock FIRST (so concurrent runs — the timer plus a manual
# run — cannot race on git), brings the repo to the latest main, then runs the
# repo's deploy script with the lock already held.
#
set -euo pipefail

BASE="/srv/blog"
REPO="$BASE/repo"
BRANCH="main"
LOCK="/run/blog-deploy.lock"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another deploy is already running; skipping"
  exit 0
fi

git -C "$REPO" config --add safe.directory "$REPO" 2>/dev/null || true
git -C "$REPO" fetch --prune origin "$BRANCH"
git -C "$REPO" checkout --quiet --force "origin/$BRANCH"

BLOG_LOCK_HELD=1 exec bash "$REPO/scripts/deploy.sh" "$@"
