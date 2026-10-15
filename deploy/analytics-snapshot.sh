#!/usr/bin/env bash
#
# Daily analytics snapshot — append ONE compact line per day, so the ~2-month
# observation window has trend data (the live GoAccess report only shows the
# current window).
#
# Runs on TOWER via blog-analytics-snapshot.timer. Idempotent: re-running on the
# same day replaces that day's line.
#
# Output: /var/www/stats/history.tsv, tab-separated:
#   date  total_requests  unique_visitors  unique_files  bandwidth  top_pages  referrers
#         crawlers  top_articles
#
# The last two columns were added 2026-10-15 because they are what the December
# review actually needs: which crawler is (or is not) working the site, and which
# articles get requested by something that is not a bot. Older lines simply have
# fewer columns.
set -euo pipefail

REPORT="${REPORT:-/var/www/stats/report.json}"
HISTORY="${HISTORY:-/var/www/stats/history.tsv}"
LOGS="${LOGS:-/var/log/nginx/blog.access.log /var/log/nginx/blog.access.log.1}"

if [ ! -f "$REPORT" ]; then
  echo "analytics-snapshot: no report at $REPORT" >&2
  exit 1
fi

python3 - "$REPORT" "$HISTORY" "$LOGS" <<'PY'
import json, os, re, sys, datetime
from collections import Counter

report, history = sys.argv[1], sys.argv[2]
logs = sys.argv[3].split()

try:
    d = json.load(open(report))
except Exception as e:  # noqa: BLE001
    print(f"analytics-snapshot: cannot parse report: {e}", file=sys.stderr)
    sys.exit(1)

g = d.get("general", {}) or {}
def rows(name):
    return ((d.get(name) or {}).get("data") or [])

day = datetime.date.today().isoformat()
top = ", ".join(f"{r.get('data')}({r.get('hits', {}).get('count', 0)})" for r in rows("requests")[:3])
referrers = ", ".join(f"{r.get('data')}({r.get('hits', {}).get('count', 0)})" for r in rows("referring_sites")[:3])

# --- crawler breakdown + non-bot article requests, straight from the raw logs ---
NAMED = ["Googlebot", "GoogleOther", "bingbot", "Baiduspider", "YandexBot", "AhrefsBot"]
counts = {k: 0 for k in NAMED}
other_bots = 0
articles = Counter()
BOT = re.compile(
    r"bot|crawl|spider|scan|python-|curl|wget|Go-http|monitor|zgrab|masscan|"
    r"facebookexternalhit|Semrush|PetalBot|Bytespider|Ahrefs|HeadlessChrome",
    re.I,
)

for path in logs:
    if not os.path.exists(path):
        continue
    with open(path, errors="replace") as fh:
        for line in fh:
            # combined log format: ... "request" status size "referer" "ua"
            parts = line.split('"')
            ua = parts[-2] if len(parts) >= 2 else ""
            hit = None
            for k in NAMED:
                if k.lower() in ua.lower():
                    hit = k
                    break
            if hit:
                counts[hit] += 1
            elif BOT.search(ua):
                other_bots += 1
            elif ua:
                m = re.search(r"GET /(?:zh/)?posts/([a-z0-9-]+)/", line)
                if m:
                    articles[m.group(1)] += 1

crawlers = " ".join(f"{k}={counts[k]}" for k in NAMED) + f" other={other_bots}"
top_articles = ", ".join(f"{slug}({n})" for slug, n in articles.most_common(3)) or "-"

line = "\t".join([
    day,
    str(g.get("total_requests", 0)),
    str(g.get("unique_visitors", 0)),
    str(g.get("unique_files", 0)),
    str(g.get("bandwidth", 0)),
    top,
    referrers,
    crawlers,
    top_articles,
])

existing = []
if os.path.exists(history):
    existing = [l for l in open(history).read().splitlines() if l and not l.startswith(day + "\t")]
existing.append(line)
open(history, "w").write("\n".join(sorted(existing)) + "\n")
print("analytics-snapshot:", line)
PY
