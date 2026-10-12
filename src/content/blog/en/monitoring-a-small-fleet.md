---
title: "Server monitoring for a small fleet without the big stack"
description: "You do not need Prometheus and Grafana to know your servers are healthy. What actually breaks on a handful of boxes, the minimal toolset of node_exporter (or not), systemd checks and a dead man's switch, plus journald retention — and when a real stack earns its keep."
pubDate: 2026-10-28
lang: en
translationKey: monitoring-a-small-fleet
tags: [devops, self-hosting, linux]
featured: false
keywords:
  - server monitoring
  - small fleet monitoring
  - dead man's switch
  - node_exporter
  - alerting
---

I run a handful of servers — a blog, a couple of APIs, a mail relay, an overlay
node — and for years I put off "setting up monitoring properly," which to me
meant Prometheus, Grafana, Alertmanager, and a monitoring box that itself needs
monitoring. I never got around to it, and the machines stayed up anyway. This
post is how I do **server monitoring** now: a genuinely minimal approach to
**small fleet monitoring** that fits in a few files, tells me only what I can
act on, and uses a **dead man's switch** for the failure mode that breaks every
dashboard — a job that silently stops running.

## What actually breaks, and how you'd notice

My incident list is boring, and that is the point. Every real problem I have had
on a small fleet is here:

| Failure | How it shows up | How you notice today |
| --- | --- | --- |
| **Disk full** | writes fail, logs stop, databases wedge | the app errors, or nothing works at all |
| **Service down** | a crash loop, an OOM kill, a bad deploy | users tell you, or a smoke URL goes 502 |
| **Cert expiring** | browser warnings, broken API clients | the day it expires, not before |
| **Backup not running** | a timer that quietly stopped, a full disk, a bad credential | the day you need to restore |
| **Cert renewal breaking TLS** | reload failed, cert served is stale | again: the day a browser complains |

Three of the four "how you notice" answers are **"too late."** That is the gap I
care about: **small fleet monitoring** picks the smallest set of checks that
turns a "too late" into a "10 minutes ago."

## What a big stack measures that you do not need

Prometheus and Grafana are excellent, and I use them at work. But the standard
stack measures CPU, memory, load, throughput, disk I/O, request rates and
latency histograms by default, and for a couple of boxes serving a blog and a
small API, almost none of that changes a decision I make.

So I apply one test to every metric: **would a change in this number make me do
something?** Load spiking at 02:00 nightly is the backup, and I already know.
For a static site the number that matters is not p99, it is "is the page up at
all." The real failure of the big stack on a small fleet is that it turns
monitoring into a **dashboard you visit** instead of an **alert that visits
you**.

## The minimal toolset

Four pieces; skip any one deliberately:

1. **A health check script** that exits non-zero on a real problem.
2. **A `systemd` timer** to run it on a schedule, with `OnFailure=` wired to an
   alert. (Then [systemd timers beat cron](/posts/systemd-timers-vs-cron/) here,
   because a failing timer unit is something systemd will actually act on.)
3. **A dead man's switch** for jobs that are supposed to run forever.
4. **journald with a retention policy**, so "what happened" is queryable.

### Do you need node_exporter at all?

**node_exporter** turns a Linux box into Prometheus metrics — disk, CPU, memory,
filesystem, systemd unit states. It is the right tool *if* something will scrape
it and write alert rules on those series; without a scraper it is a process on
:9100 emitting numbers into the void.

- **If you will run Prometheus** (or a hosted scraper, or VictoriaMetrics), run
  node_exporter, collect the `node_systemd_unit_state`, filesystem and
  `node_textfile` metrics, and put your **alert rules** — not your dashboards —
  in version control. That is a real, good setup.
- **If you will not**, do not run node_exporter "just in case." A script that
  exits 1 and a unit that pages you covers disk, services and certs with zero
  new daemons.

I landed on "not yet": when I add Prometheus, this same check becomes one more
metric, with no rewrite.

```bash
# Only if something scrapes it — the useful collectors, not all of them
node_exporter \
  --collector.systemd \
  --collector.textfile.directory=/var/lib/node_exporter/textfile
```

```bash
# A timer/cron job can then publish a fact as a metric, no exporter code needed
printf 'backup_last_success_timestamp %s\n' "$(date +%s)" \
  > /var/lib/node_exporter/textfile/backup.prom
```

## A check script on a systemd timer

This is the whole pattern, in about forty lines. One script, one exit code:
zero means healthy, non-zero means page me.

```bash
#!/usr/bin/env bash
# /usr/local/sbin/healthcheck.sh — one box, one exit code
set -uo pipefail
fail=0
say() { echo "[healthcheck] $*"; }

# Disk: fail above 90% on any real filesystem
while read -r fs pct; do
  pct=${pct%\%}
  [ "$pct" -ge 90 ] && { say "DISK $fs at ${pct}%"; fail=1; }
done < <(df -P -x tmpfs -x devtmpfs --output=target,pcent | tail -n +2)

# Services that must be up
for unit in nginx sshd; do
  systemctl is-active --quiet "$unit" || { say "UNIT $unit down"; fail=1; }
done

# Served TLS cert: fail if it expires within 14 days
exp=$(echo | openssl s_client -connect 127.0.0.1:443 \
        -servername blog.awin-x.top 2>/dev/null \
      | openssl x509 -noout -enddate | cut -d= -f2)
if [ -n "$exp" ]; then
  left=$(( ( $(date -d "$exp" +%s) - $(date +%s) ) / 86400 ))
  [ "$left" -lt 14 ] && { say "CERT expires in ${left}d"; fail=1; }
fi

exit "$fail"
```

Now run it every five minutes; systemd handles the alerting through
`OnFailure=`.

```ini
# /etc/systemd/system/healthcheck.service
[Unit]
Description=Local health checks
OnFailure=alert@%n.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/healthcheck.sh
```

```ini
# /etc/systemd/system/healthcheck.timer
[Unit]
Description=Run health checks every 5 minutes

[Timer]
OnCalendar=*:0/5
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
```

The alert unit is a template, so every failing service reuses it — it just POSTs
to whatever you read (ntfy, a webhook, a mail relay).

```ini
# /etc/systemd/system/alert@.service
[Unit]
Description=Send alert for %i

[Service]
Type=oneshot
ExecStart=/usr/bin/curl -fsS -m 10 -d "job %i failed on $(hostname)" \
  https://ntfy.sh/your-private-topic
```

That is **alerting** on failure with no Prometheus and no Alertmanager. The unit
name says *which* check failed; `journalctl -u healthcheck` says why.

## The dead man's switch: for jobs that must always run

The checks above catch a thing that is *broken now*. They do not catch a thing
that has **silently stopped happening** — a backup timer someone disabled, a
renewal job that stopped firing. This is where a big stack fails worst, because
absence is hard to alert on: no metric, no event, no log line.

The fix is an inverted alert, a **dead man's switch**. Instead of alerting when
something is wrong, you alert when a heartbeat *stops arriving*. The job pings a
watchdog on success; if the ping does not arrive within the window, it pages
you. I use [Healthchecks](https://healthchecks.io/) for this — self-hostable,
and the free tier is fine for a small fleet.

```bash
#!/usr/bin/env bash
# /usr/local/sbin/backup.sh — with a dead man's switch
set -euo pipefail
URL="https://hc-ping.com/your-uuid-here"

# If the script dies anywhere, tell the watchdog and exit
trap 'curl -fsS -m 10 "$URL/fail" >/dev/null || true' ERR

# ... the actual backup work ...
pg_dump app | gzip > /srv/backups/app-$(date +%F).sql.gz

# Success: one ping. Miss this and the watchdog alerts you.
curl -fsS -m 10 --retry 3 "$URL" >/dev/null
```

A **dead man's switch** inverts that: the *absence* of a ping is the signal. A
watchdog that never hears from your nightly job pages you whether the job
crashed, the timer was disabled, or the box is off — failures a per-metric alert
cannot catch.

## Alert only on action-worthy conditions

The fastest way to make monitoring useless is to make alerts ignorable. My
rule: **if an alert fires and the correct response is "do nothing," delete the
alert.** Every page should map to an action — restart a unit, free disk, renew a
cert, fix a job.

- Alert on **"disk above 90%"**, not "disk I/O is high." One is a chore, the
  other is a fact.
- Alert on **"the cert expires in 14 days"**, not "TLS handshake latency moved."
- Alert on **"the backup did not check in"**, not "backup throughput dipped."
- Do **not** alert on CPU or memory alone. If the box is slow enough to matter,
  a smoke check on the actual service fails, and *that* is the alert.

An alert that fires often and means nothing trains you to ignore it.

## Logging you can actually query

Even with good alerts, the follow-up is always "what happened right before
this?" If logs vanish after a rotation, you are blind exactly when you need to
see. `journald` already collects stdout and stderr from every systemd unit and
the kernel, and `journalctl` is a real query interface — but only if you give
the journal a place to live and a budget.

```ini
# /etc/systemd/journald.conf
[Journal]
Storage=persistent
SystemMaxUse=500M
MaxRetentionSec=14day
ForwardToSyslog=no
```

Three properties matter. **Persistent** means the journal survives a reboot —
by default it may live only in `/run` and vanish. **`SystemMaxUse`** caps the
disk it can eat, so a chatty service can never fill the volume.
**`MaxRetentionSec`** ages logs out on a clock as well as a size, so "14 days" is
a promise, not a hope.

Then you can ask real questions without grepping rotated files:

```bash
# Everything a unit logged in the last hour
journalctl -u healthcheck --since "1 hour ago"

# Only errors, across every unit, since the last boot
journalctl -p err -b --no-pager
```

That is queryable logging with no Loki, no Elasticsearch, and no index to
maintain. The analytics side of logging is a
[different, log-based job](/posts/self-hosted-analytics/), sharing the same journal.

## When you do want Prometheus and Grafana

I am not arguing against the stack. I am arguing against installing it before
you have a question it answers. Get it out when any of these is true:

- **You have more than a handful of boxes**, where "which host is this?" stops
  being obvious.
- **You need trends** — "when do we run out of disk?" is a question a threshold
  check cannot answer, and a graph can.
- **You have SLOs or latency targets**, where p95/p99 over time is a real
  decision input.
- **Several people are on call** and need a shared, durable view.
- **You want to correlate** metrics across services, or alert on expressions
  like "disk filling faster than the retention window."

If any of those is true, this post's setup is not wasted — it becomes your
`OnFailure` handler and textfile metrics, feeding the stack you just added.
Prometheus and `node_exporter` come first, then alert rules, then Grafana last.

Where all of this runs is a handful of small boxes, and the shape of that fleet
is in [what I self-host in 2026](/posts/what-i-self-host-2026/). Monitoring did
not need to be a platform — just a short list, a script, and a watchdog that
notices silence.

Alert on what you would fix. Say nothing about the rest.
