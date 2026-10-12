#!/usr/bin/env bash
#
# Generate the analytics report from nginx's per-vhost access log.
# Runs on TOWER via blog-analytics.timer. Writes static HTML + JSON to
# /var/www/stats, which nginx serves (password-protected).
#
set -euo pipefail

# GoAccess 1.3 aborts without $HOME (systemd doesn't set it), and we want the
# report rendered in China time regardless of the host timezone.
export HOME="${HOME:-/root}"
export TZ="${TZ:-Asia/Shanghai}"

OUT="/var/www/stats"
TITLE="blog.awin-x.top"
# Current + one rotation is plenty for a 30-day view.
LOGS=()
for f in /var/log/nginx/blog.access.log /var/log/nginx/blog.access.log.1; do
  [ -f "$f" ] && LOGS+=("$f")
done
[ "${#LOGS[@]}" -eq 0 ] && { echo "no logs yet"; exit 0; }

mkdir -p "$OUT"

# GoAccess flags differ across versions; build a tolerant invocation.
BASE=(goaccess "${LOGS[@]}" --log-format=COMBINED --no-query-string --ignore-crawlers)

# 1) Single-page HTML dashboard.
if ! "${BASE[@]}" -o "$OUT/index.html" --html-report-title="$TITLE" >/dev/null 2>&1; then
  goaccess "${LOGS[@]}" --log-format=COMBINED -o "$OUT/index.html" --html-report-title="$TITLE" >/dev/null 2>&1
fi

# 2) Machine-readable snapshot the agent can diff over time.
if ! "${BASE[@]}" -o "$OUT/report.json" >/dev/null 2>&1; then
  goaccess "${LOGS[@]}" --log-format=COMBINED -o "$OUT/report.json" >/dev/null 2>&1 || true
fi

# 3) A compact human summary (China time + UTC).
{
  echo "generated (Asia/Shanghai): $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "generated (UTC):           $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "log lines:                 $(wc -l < "${LOGS[0]}")"
} > "$OUT/meta.txt"

chmod 644 "$OUT"/* 2>/dev/null || true
