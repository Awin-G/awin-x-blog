#!/usr/bin/env bash
#
# Install / update server-side analytics on TOWER. Idempotent.
# GoAccess parses the per-vhost nginx access log; the report is served at
# https://stats.awin-x.top/ behind HTTP basic auth.
#
# Run as root:   bash /srv/blog/repo/deploy/install-analytics.sh
#
set -euo pipefail

DOMAIN="stats.awin-x.top"
EMAIL="xuebao@mail.awin-x.top"
WEBROOT="/var/www/stats"
CRED="/root/blog-stats-credentials.txt"
HTPASS="/etc/nginx/.htpasswd-blog-stats"
DIR="$(cd "$(dirname "$0")" && pwd)"

log() { printf '\n=== %s ===\n' "$*"; }

log "dns record"
python3 "$DIR/tools/dnspod_set.py" stats A 88.218.79.95 600 || echo "  (DNS step failed)"

log "install goaccess"
command -v goaccess >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y goaccess; }
goaccess --version | head -1

log "report script"
mkdir -p /srv/blog/analytics "$WEBROOT"
install -m 0755 "$DIR/analytics-report.sh" /srv/blog/analytics/report.sh

log "basic auth"
if [ ! -f "$CRED" ]; then
  openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 20 > "$CRED"
  chmod 600 "$CRED"
fi
PW="$(cat "$CRED")"
printf 'stats:%s\n' "$(openssl passwd -apr1 "$PW")" > "$HTPASS"
chmod 640 "$HTPASS"
chown root:www-data "$HTPASS" 2>/dev/null || true

log "systemd timer"
install -m 0644 "$DIR/blog-analytics.service" /etc/systemd/system/blog-analytics.service
install -m 0644 "$DIR/blog-analytics.timer" /etc/systemd/system/blog-analytics.timer
systemctl daemon-reload

log "retire goatcounter (superseded by server-side analytics)"
systemctl disable --now goatcounter 2>/dev/null || true

log "nginx: stats vhost (as needed for the cert)"
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  cat > /etc/nginx/sites-available/stats-tmp <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
}
EOF
  ln -sfn /etc/nginx/sites-available/stats-tmp /etc/nginx/sites-enabled/stats-tmp
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
    --non-interactive --agree-tos --no-eff-email --preferred-challenges http -m "$EMAIL"
  rm -f /etc/nginx/sites-enabled/stats-tmp /etc/nginx/sites-available/stats-tmp
fi

install -m 0644 "$DIR/nginx-stats.conf" /etc/nginx/sites-available/stats
ln -sfn /etc/nginx/sites-available/stats /etc/nginx/sites-enabled/stats
rm -f /etc/nginx/sites-enabled/stats-http /etc/nginx/sites-available/stats-http

log "nginx: blog vhost (adds the per-vhost access log)"
install -m 0644 "$DIR/nginx-blog.conf" /etc/nginx/sites-available/blog
nginx -t && systemctl reload nginx

log "first report"
/srv/blog/analytics/report.sh
systemctl enable --now blog-analytics.timer

log "verify"
curl -sS -o /dev/null -w "stats (with auth) -> %{http_code}\n" -u "stats:$PW" "https://$DOMAIN/" || true
echo
echo "Dashboard : https://$DOMAIN/  (user: stats)"
echo "Password  : stored in $CRED"
echo "Raw JSON  : $WEBROOT/report.json"
