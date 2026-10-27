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
#         crawlers  top_articles  browser_ips
#
# The last three columns were added 2026-10-15/17 because they are what the December
# review actually needs: which crawler is (or is not) working the site, which articles
# real clients ask for (ranked by DISTINCT IP, not hits), and how many browser-shaped
# clients there were. Older lines simply have fewer columns.
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

# --- crawler breakdown + human-ish article requests, straight from the raw logs ---
NAMED = ["Googlebot", "GoogleOther", "bingbot", "Baiduspider", "YandexBot", "AhrefsBot"]
counts = {k: 0 for k in NAMED}
other_bots = 0
articles = {}          # slug -> set of client IPs
human_ips = set()
ua_stats = {}          # ua -> [hits, set(ips)]  (used to spot distributed scrapers)
rows_after_ua = []     # (line, ua, ip) kept for a second pass
BOT = re.compile(
    r"bot|crawl|spider|scan|python-|curl|wget|Go-http|monitor|zgrab|masscan|"
    r"facebookexternalhit|Semrush|PetalBot|Bytespider|Ahrefs|HeadlessChrome",
    re.I,
)
# CLI tools are not visitors either — and this catches the orchestrator's own
# verification requests (curl 8.x from the dev box), which otherwise polluted the
# numbers: ~674 of them in the first three days.
TOOLISH = re.compile(
    r"^(curl|wget|python|Go-http|Java|libwww|okhttp|axios|node-fetch|HTTPie|HTTP\b)",
    re.I,
)

for path in logs:
    if not os.path.exists(path):
        continue
    with open(path, errors="replace") as fh:
        for line in fh:
            # combined log format: ip - - [time] "request" status size "referer" "ua"
            ip = line.split(" ", 1)[0]
            parts = line.split('"')
            ua = parts[-2] if len(parts) >= 2 else ""
            hit = None
            for k in NAMED:
                if k.lower() in ua.lower():
                    hit = k
                    break
            if hit:
                counts[hit] += 1
                continue
            if not ua or ua == "-" or BOT.search(ua) or TOOLISH.match(ua):
                other_bots += 1
                continue
            if "Mozilla" not in ua:
                other_bots += 1
                continue
            # Record per-UA so we can spot distributed scrapers below.
            st = ua_stats.setdefault(ua, [0, set()])
            st[0] += 1
            st[1].add(ip)
            rows_after_ua.append((line, ua, ip))

# A distributed scraper is one *fixed* UA spread over many IPs with ~1 request each
# (a proxy pool, so the per-IP rate limit never trips). This is exactly what showed
# up on 2026-10-21..27: one fake "Mac Chrome/142" UA, 157 IPs, 177 requests.
# Counting those IPs as "visitors" is how a scraper looks like growth.
scraper_uas = {
    ua for ua, (n, ips) in ua_stats.items() if len(ips) >= 20 and n / max(len(ips), 1) < 1.5
}
scraped = 0

for line, ua, ip in rows_after_ua:
    if ua in scraper_uas:
        scraped += 1
        continue
    human_ips.add(ip)
    m = re.search(r"GET /(?:zh/)?posts/([a-z0-9-]+)/", line)
    if m:
        articles.setdefault(m.group(1), set()).add(ip)

crawlers = " ".join(f"{k}={counts[k]}" for k in NAMED) + f" other={other_bots}"
if scraped:
    crawlers += f" scraped={scraped}"
top_articles = (
    ", ".join(f"{slug}({len(ips)})" for slug, ips in sorted(articles.items(), key=lambda kv: -len(kv[1]))[:3])
    or "-"
)

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
    str(len(human_ips)),
])

existing = []
if os.path.exists(history):
    existing = [l for l in open(history).read().splitlines() if l and not l.startswith(day + "\t")]
existing.append(line)
open(history, "w").write("\n".join(sorted(existing)) + "\n")
print("analytics-snapshot:", line)
PY
