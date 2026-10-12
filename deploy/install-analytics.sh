#!/usr/bin/env bash
#
# Install / update GoatCounter (cookie-less analytics) on TOWER. Idempotent.
# Run as root:   bash /srv/blog/repo/deploy/install-analytics.sh
#
set -euo pipefail

DOMAIN="stats.awin-x.top"
EMAIL="xuebao@mail.awin-x.top"
BIN="/usr/local/bin/goatcounter"
VERSION="v2.7.0"
DBDIR="/var/lib/goatcounter"
WEBROOT="/var/www/stats"
CRED="/root/goatcounter-credentials.txt"
DIR="$(cd "$(dirname "$0")" && pwd)"

log() { printf '\n=== %s ===\n' "$*"; }

log "dns record"
python3 "$DIR/tools/dnspod_set.py" stats A 88.218.79.95 600 || echo "  (DNS step failed — check credentials)"

log "user + dirs"
id goatcounter >/dev/null 2>&1 || useradd --system --home "$DBDIR" --shell /usr/sbin/nologin goatcounter
mkdir -p "$DBDIR" "$WEBROOT"

log "binary"
if [ ! -x "$BIN" ]; then
  curl -sL "https://github.com/arp242/goatcounter/releases/download/$VERSION/goatcounter-$VERSION-linux-amd64.gz" | gunzip > "$BIN"
  chmod +x "$BIN"
fi
"$BIN" version

log "credentials"
if [ ! -f "$CRED" ]; then
  openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 24 > "$CRED"
  chmod 600 "$CRED"
fi
PW="$(cat "$CRED")"

log "database + site"
DB="sqlite+$DBDIR/db.sqlite3"
if ! "$BIN" db test -db "$DB" >/dev/null 2>&1; then
  "$BIN" db create site -db "$DB" -vhost "$DOMAIN" -user.email "$EMAIL" -user.password "$PW"
else
  echo "database already present"
fi
chown -R goatcounter:goatcounter "$DBDIR"

log "service"
install -m 0644 "$DIR/goatcounter.service" /etc/systemd/system/goatcounter.service
systemctl daemon-reload
systemctl enable --now goatcounter.service
sleep 1
systemctl is-active goatcounter.service

log "nginx (http, for the ACME challenge)"
cat > /etc/nginx/sites-available/stats-http <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { proxy_pass http://127.0.0.1:8081; proxy_set_header Host \$host; }
}
EOF
ln -sfn /etc/nginx/sites-available/stats-http /etc/nginx/sites-enabled/stats-http
nginx -t && systemctl reload nginx

log "tls"
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
    --non-interactive --agree-tos --no-eff-email --preferred-challenges http -m "$EMAIL" \
    || certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --no-eff-email -m "$EMAIL"
fi

log "nginx (tls, final)"
rm -f /etc/nginx/sites-enabled/stats-http /etc/nginx/sites-available/stats-http
install -m 0644 "$DIR/nginx-stats.conf" /etc/nginx/sites-available/stats
ln -sfn /etc/nginx/sites-available/stats /etc/nginx/sites-enabled/stats
nginx -t && systemctl reload nginx

log "verify"
curl -sS -o /dev/null -w "https://%{url_effective} -> %{http_code}\n" "https://$DOMAIN/" || true
echo
echo "Dashboard : https://$DOMAIN/"
echo "Login     : $EMAIL"
echo "Password  : stored in $CRED"
