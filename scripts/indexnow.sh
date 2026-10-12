#!/usr/bin/env bash
#
# Submit the published URL set to IndexNow, which fans out to Bing, Yandex,
# Naver and Seznam for near-instant indexing. Best-effort: never fail a deploy.
#
# Usage: indexnow.sh [release-dir]   (defaults to /var/www/blog)
#
set -euo pipefail

SITE_HOST="blog.awin-x.top"
WEBROOT="${1:-/var/www/blog}"
ENDPOINT="https://api.indexnow.org/indexnow"

# The IndexNow key file is a 32-hex-char .txt served from the site root.
KEY_FILE="$(ls "$WEBROOT" 2>/dev/null | grep -E '^[0-9a-f]{32}\.txt$' | head -1 || true)"
if [ -z "$KEY_FILE" ]; then
  echo "indexnow: no key file found in $WEBROOT (skipping)"
  exit 0
fi
KEY="${KEY_FILE%.txt}"

# Collect every URL across the generated sitemaps.
URLS="$(grep -rhoE '<loc>[^<]+</loc>' "$WEBROOT"/sitemap*.xml 2>/dev/null | sed -E 's#</?loc>##g' | sort -u || true)"
COUNT="$(printf '%s\n' "$URLS" | grep -c . || true)"
if [ "${COUNT:-0}" -eq 0 ]; then
  echo "indexnow: no URLs in sitemap (skipping)"
  exit 0
fi

BODY="$(printf '%s\n' "$URLS" | python3 -c '
import json, sys
urls = [l.strip() for l in sys.stdin if l.strip()]
host = sys.argv[1]
key = sys.argv[2]
print(json.dumps({
    "host": host,
    "key": key,
    "keyLocation": f"https://{host}/{key}.txt",
    "urlList": urls,
}))
' "$SITE_HOST" "$KEY")"

echo "indexnow: submitting $COUNT urls"
curl -sS -m 25 -X POST \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "$BODY" \
  -o /dev/null -w 'indexnow: HTTP %{http_code}\n' \
  "$ENDPOINT" || echo "indexnow: request failed (ignored)"
