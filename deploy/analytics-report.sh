#!/usr/bin/env bash
#
# Generate the analytics report from nginx's per-vhost access log.
# Runs on TOWER via blog-analytics.timer. Writes static HTML + JSON to
# /var/www/stats, which nginx serves (password-protected).
#
# Two quirks handled here:
#   * GoAccess 1.3 aborts if $HOME is unset (systemd doesn't set it).
#   * GoAccess ignores $TZ, so we rewrite log timestamps to +0800 (China time)
#     before parsing, giving the report in Asia/Shanghai without changing the
#     host timezone.
#
set -euo pipefail

export HOME="${HOME:-/root}"

OUT="/var/www/stats"
TITLE="blog.awin-x.top"
RAW=()
for f in /var/log/nginx/blog.access.log /var/log/nginx/blog.access.log.1; do
  [ -f "$f" ] && RAW+=("$f")
done
[ "${#RAW[@]}" -eq 0 ] && { echo "no logs yet"; exit 0; }

mkdir -p "$OUT"

# --- Convert timestamps to China time (+0800) -------------------------------
CONV="$(mktemp /tmp/blog-access-cst.XXXXXX)"
trap 'rm -f "$CONV"' EXIT
python3 - "$CONV" "${RAW[@]}" <<'PY'
import sys, re, datetime
out, files = sys.argv[1], sys.argv[2:]
pat = re.compile(r'\[(\d{2}/[A-Za-z]{3}/\d{4}:\d{2}:\d{2}:\d{2}) ([+-]\d{4})\]')

def conv(m):
    dt = datetime.datetime.strptime(m.group(1) + ' ' + m.group(2), '%d/%b/%Y:%H:%M:%S %z')
    dt = dt.astimezone(datetime.timezone.utc) + datetime.timedelta(hours=8)
    return '[' + dt.strftime('%d/%b/%Y:%H:%M:%S') + ' +0800]'

with open(out, 'w') as w:
    for f in files:
        try:
            with open(f, errors='replace') as r:
                for line in r:
                    w.write(pat.sub(conv, line))
        except FileNotFoundError:
            pass
PY

LOG="$CONV"

# --- GoAccess ---------------------------------------------------------------
BASE=(goaccess "$LOG" --log-format=COMBINED --no-query-string --ignore-crawlers)

if ! "${BASE[@]}" -o "$OUT/index.html" --html-report-title="$TITLE" >/dev/null 2>&1; then
  goaccess "$LOG" --log-format=COMBINED -o "$OUT/index.html" --html-report-title="$TITLE" >/dev/null 2>&1
fi

if ! "${BASE[@]}" -o "$OUT/report.json" >/dev/null 2>&1; then
  goaccess "$LOG" --log-format=COMBINED -o "$OUT/report.json" >/dev/null 2>&1 || true
fi

# --- Summary (China time + UTC) --------------------------------------------
{
  echo "generated (Asia/Shanghai): $(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "generated (UTC):           $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "log lines:                 $(wc -l < "$LOG")"
} > "$OUT/meta.txt"

chmod 644 "$OUT"/* 2>/dev/null || true
