#!/usr/bin/env bash
#
# Stable entrypoint for the deploy systemd unit.
#
# It brings the repo to the latest main, then runs the *repo's* deploy script,
# so changes to scripts/deploy.sh take effect on the next run without a manual
# reinstall of this file.
#
set -euo pipefail

BASE="/srv/blog"
REPO="$BASE/repo"
BRANCH="main"

git -C "$REPO" config --add safe.directory "$REPO" 2>/dev/null || true
git -C "$REPO" fetch --prune origin "$BRANCH"
git -C "$REPO" checkout --quiet --force "origin/$BRANCH"

exec bash "$REPO/scripts/deploy.sh" "$@"
