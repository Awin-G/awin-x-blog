#!/usr/bin/env bash
#
# Install / update the blog deployment on TOWER. Idempotent — safe to re-run.
# Run as root:   bash /srv/blog/repo/deploy/install.sh
#
set -euo pipefail

BASE="/srv/blog"
REPO="$BASE/repo"
GIT_URL="https://git.awin-x.top/awinx/blog.git"
BRANCH="main"
DOMAIN="blog.awin-x.top"

log() { printf '\n=== %s ===\n' "$*"; }

log "dependencies"
for pkg in git rsync; do
  command -v "$pkg" >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y "$pkg"; }
done

log "layout"
mkdir -p "$BASE/releases" "$BASE/state"

log "clone / update repository"
if [ ! -d "$REPO/.git" ]; then
  git clone --branch "$BRANCH" "https://git.awin-x.top/awinx/blog.git" "$REPO"
fi
git -C "$REPO" config --add safe.directory "$REPO" 2>/dev/null || true

log "install deploy script"
install -m 0755 "$REPO/scripts/deploy.sh" "$BASE/deploy.sh"

log "systemd units"
install -m 0644 "$REPO/deploy/blog-deploy.service" /etc/systemd/system/blog-deploy.service
install -m 0644 "$REPO/deploy/blog-deploy.timer" /etc/systemd/system/blog-deploy.timer
systemctl daemon-reload

log "first deploy (creates the current release)"
FORCE=1 "$BASE/deploy.sh"

log "nginx vhost"
install -m 0644 "$REPO/deploy/nginx-blog.conf" /etc/nginx/sites-available/blog
ln -sfn /etc/nginx/sites-available/blog /etc/nginx/sites-enabled/blog

log "webroot symlink"
if [ -L /var/www/blog ] || [ ! -e /var/www/blog ]; then rm -f /var/www/blog; fi
ln -sfn "$BASE/current" /var/www/blog

if [ ! -f "/etc/nginx/cert/$DOMAIN.pem" ]; then
  echo "WARNING: /etc/nginx/cert/$DOMAIN.pem is missing — TLS will fail until the cert lands."
fi

nginx -t
systemctl reload nginx

log "enable auto-deploy timer"
systemctl enable --now blog-deploy.timer

log "verify"
systemctl is-active blog-deploy.timer && echo "timer ok"
ls -l /var/www/blog
echo
echo "Done. Blog is live at https://$DOMAIN/"
