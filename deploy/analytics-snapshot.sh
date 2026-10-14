#!/usr/bin/env bash
#
# Daily analytics snapshot — append ONE compact line per day from the GoAccess
# JSON report, so the ~2-month observation window has trend data (the live
# report only shows the current window).
#
# Runs on TOWER via blog-analytics-snapshot.timer. Idempotent: re-running on the
# same day replaces that day's line.
#
# Output: /var/www/stats/history.tsv
#   date <TAB> total_requests <TAB> unique_visitors <TAB> unique_files <TAB> bandwidth <TAB> top_pages
set -euo pipefail

REPORT="${REPORT:-/var/www/stats/report.json}"
HISTORY="${HISTORY:-/var/www/stats/history.tsv}"

if [ ! -f "$REPORT" ]; then
  echo "analytics-snapshot: no report at $REPORT" >&2
  exit 1
fi

python3 - "$REPORT" "$HISTORY" <<'PY'
import json, os, sys, datetime

report, history = sys.argv[1], sys.argv[2]
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

line = "\t".join([
    day,
    str(g.get("total_requests", 0)),
    str(g.get("unique_visitors", 0)),
    str(g.get("unique_files", 0)),
    str(g.get("bandwidth", 0)),
    top,
    referrers,
])

existing = []
if os.path.exists(history):
    existing = [l for l in open(history).read().splitlines() if l and not l.startswith(day + "\t")]
existing.append(line)
open(history, "w").write("\n".join(sorted(existing)) + "\n")
print("analytics-snapshot:", line)
PY
