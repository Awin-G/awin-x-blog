#!/usr/bin/env bash
#
# Blog deploy script — runs ON TOWER (the public box).
#
#   git pull  ->  npm ci  ->  astro build  ->  atomic symlink swap
#
# Idempotent: exits early when the built commit already matches origin/main.
# Force a rebuild with:  FORCE=1 /srv/blog/deploy.sh
#
set -euo pipefail

BASE="/srv/blog"
REPO="$BASE/repo"
RELEASES="$BASE/releases"
STATE="$BASE/state"
WEBROOT="/var/www/blog"          # symlink -> current release
BRANCH="main"
KEEP_RELEASES=4
LOCK="/run/blog-deploy.lock"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Keep the live nginx vhost in sync with the repo, safely: apply, test, revert
# on failure. Idempotent and cheap.
sync_nginx() {
  local conf="$REPO/deploy/nginx-blog.conf"
  local live="/etc/nginx/sites-available/blog"
  [ -f "$conf" ] || return 0
  [ -f "$live" ] || { install -m 0644 "$conf" "$live" && ln -sfn "$live" /etc/nginx/sites-enabled/blog; }
  cmp -s "$conf" "$live" && return 0
  local bak; bak="$(mktemp)"
  cp -a "$live" "$bak"
  install -m 0644 "$conf" "$live"
  if nginx -t 2>/dev/null; then
    systemctl reload nginx && log "nginx vhost updated + reloaded"
  else
    cp -a "$bak" "$live"
    log "nginx vhost change failed validation; reverted"
  fi
  rm -f "$bak"
}

# Single-flight: never run two deploys at once.
exec 9>"$LOCK"
if ! flock -n 9; then
  log "another deploy is already running; skipping"
  exit 0
fi

command -v node >/dev/null || { log "ERROR: node not found"; exit 1; }
command -v npm  >/dev/null || { log "ERROR: npm not found";  exit 1; }

mkdir -p "$RELEASES" "$STATE"

# ---- 1. Fetch -------------------------------------------------------------
if [ ! -d "$REPO/.git" ]; then
  log "cloning repository"
  git clone --branch "$BRANCH" --depth 1 "https://git.awin-x.top/awinx/blog.git" "$REPO"
else
  git -C "$REPO" config --add safe.directory "$REPO" 2>/dev/null || true
  git -C "$REPO" fetch --prune origin "$BRANCH"
fi
TARGET="$(git -C "$REPO" rev-parse "origin/$BRANCH")"
LAST="$(cat "$STATE/last-built" 2>/dev/null || true)"

if [ "${FORCE:-0}" != "1" ] && [ "$LAST" = "$TARGET" ] && [ -e "$WEBROOT/index.html" ]; then
  log "already at $TARGET — nothing to do"
  sync_nginx
  exit 0
fi
log "deploying $TARGET (was: ${LAST:-none})"

# ---- 2. Checkout ----------------------------------------------------------
git -C "$REPO" checkout --quiet --force "$TARGET"
git -C "$REPO" clean -qfd -e node_modules -e dist

# ---- 3. Build -------------------------------------------------------------
cd "$REPO"
if [ -f package-lock.json ]; then
  log "npm ci"
  npm ci --no-audit --no-fund --loglevel=error
else
  npm install --no-audit --no-fund --loglevel=error
fi
log "astro build"
npm run build --silent

if [ ! -f "$REPO/dist/index.html" ]; then
  log "ERROR: build produced no dist/index.html"
  exit 1
fi

# ---- 4. Publish atomically ------------------------------------------------
REL="$RELEASES/$(date -u +%Y%m%d%H%M%S)-${TARGET:0:7}"
mkdir -p "$REL"
rsync -a --delete --chmod=D755,F644 "$REPO/dist/" "$REL/"

# Atomic swap: create new symlink then rename over the old one.
ln -sfn "$REL" "$BASE/current.tmp"
mv -Tf "$BASE/current.tmp" "$BASE/current"
ln -sfn "$BASE/current" "$WEBROOT.tmp"
mv -Tf "$WEBROOT.tmp" "$WEBROOT"

echo "$TARGET" > "$STATE/last-built"
log "published $(basename "$REL") -> $WEBROOT"

# ---- 5. Sync nginx vhost (safe: apply, test, revert) ----------------------
sync_nginx

# ---- 5. Announce to search engines (best-effort) --------------------------
if [ -x "$REPO/scripts/indexnow.sh" ] || [ -f "$REPO/scripts/indexnow.sh" ]; then
  bash "$REPO/scripts/indexnow.sh" "$REL" || log "indexnow: skipped"
fi

# ---- 6. Prune -------------------------------------------------------------
ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf

log "done in $(basename "$REL")"
