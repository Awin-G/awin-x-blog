---
title: "Prometheus in practice: scraping, PromQL you actually use, and alerting rules that don't cry wolf"
description: "A hands-on Prometheus walkthrough from a throwaway Docker stack: the pull model and scrape_configs, the exposition format, the PromQL you actually use, recording and alerting rules, the cardinality trap, and retention — all with real query output."
pubDate: 2026-12-12
lang: en
translationKey: prometheus-in-practice
tags: [devops, self-hosting]
featured: true
keywords:
  - Prometheus
  - PromQL
  - node_exporter
  - alerting rules
  - scrape_configs
  - histogram_quantile
  - cardinality
---

Most **Prometheus** writing starts with an architecture diagram and ends with a Grafana screenshot. I learn a tool by booting it, so that is what I did: a throwaway **Prometheus** plus **node_exporter** in Docker on `127.0.0.1`, five minutes to stand up, deleted the moment the numbers were in. This post is the parts I actually reach for — the pull model and `scrape_configs`, the exposition format, the **PromQL** that earns its place, **alerting rules** that point at things I would fix, and the two traps that quietly wreck an otherwise fine setup: cardinality and retention. Every block of output below came out of that container, unedited.

## Pull, not push: the one design choice everything follows from

Prometheus does not wait for services to push it metrics. It **pulls**: on a fixed interval it issues an HTTP `GET` to each target's `/metrics` and reads the text back. That one choice shapes everything.

- **Liveness is data.** A failed `GET` is `up = 0`, alertable like any series.
- **No agent-side drift.** The target exposes; Prometheus decides. Add a host by editing one file.
- **You can debug by hand.** `curl host:9100/metrics` is the same request the server makes.

On Linux the `/metrics` producer is almost always **node_exporter** — CPU, memory, disks, network, systemd states. Push has one good use: short-lived batch jobs, via the Pushgateway. Everything long-lived, you pull.

A scrape loop writes samples to a local time-series database; dashboards and alert rules read it back as **PromQL**. That path is the picture:

<figure>
<svg viewBox="0 0 680 250" width="100%" role="img" aria-label="Prometheus pulls metrics from targets such as node_exporter over HTTP on a scrape interval, stores the samples in its local TSDB, and answers PromQL queries from dashboards and alerting rules; a firing alert is handed to Alertmanager.">
  <defs>
    <marker id="p-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g stroke="currentColor" fill="none" stroke-width="1.5" opacity="0.7">
    <rect x="8" y="88" width="152" height="72" rx="8"/>
    <rect x="264" y="88" width="152" height="72" rx="8"/>
    <rect x="520" y="88" width="152" height="72" rx="8"/>
    <rect x="520" y="12" width="152" height="48" rx="8" stroke-dasharray="5 4"/>
  </g>
  <g stroke="#0f766e" stroke-width="1.6" fill="none" color="#0f766e">
    <line x1="162" y1="124" x2="260" y2="124" marker-end="url(#p-arrow)"/>
    <line x1="418" y1="124" x2="516" y2="124" marker-end="url(#p-arrow)"/>
    <line x1="596" y1="86" x2="596" y2="64" marker-end="url(#p-arrow)"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13">
    <text x="84" y="120" text-anchor="middle">Targets</text>
    <text x="340" y="120" text-anchor="middle">Prometheus</text>
    <text x="596" y="120" text-anchor="middle">PromQL</text>
    <text x="596" y="42" text-anchor="middle">Alertmanager</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="84" y="140" text-anchor="middle">node_exporter :9100</text>
    <text x="340" y="140" text-anchor="middle">scrape loop + TSDB</text>
    <text x="596" y="140" text-anchor="middle">query / alert rules</text>
    <text x="211" y="112" text-anchor="middle">GET /metrics</text>
    <text x="467" y="112" text-anchor="middle">evaluate</text>
    <text x="596" y="76" text-anchor="middle" font-size="10">ALERTS</text>
  </g>
</svg>
<figcaption>Pull, store, query, alert. The scrape loop is the only thing that writes; everything else — dashboards, rules, the API — only reads the TSDB through PromQL.</figcaption>
</figure>

## `prometheus.yml`: scrape_configs, targets, and a little relabeling

The config is small and worth reading end to end. Three top-level ideas: how often to collect, which rules to load, and which targets to collect from.

```yaml
# prometheus.yml
global:
  scrape_interval: 5s
  evaluation_interval: 5s
  external_labels:
    site: homelab

rule_files:
  - /etc/prometheus/rules.yml

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]

  - job_name: node
    static_configs:
      - targets: ["node-exporter:9100"]
        labels:
          role: host
          env: prod

  # A deliberately dead target, so we can see up == 0 and a real firing alert.
  - job_name: ghost-app
    static_configs:
      - targets: ["ghost-app:8080"]
```

`job_name` becomes the `job` label on every series; `static_configs` is the hand-written target list; `labels` adds labels to every series in the group. I used an aggressive 5s interval for the demo — 15s is the sane default.

Two things trip people up. Every scrape gets a synthetic `up` and `scrape_duration_seconds` whether or not the target answered, so a dead target is still visible. And `instance` defaults to the `host:port` you wrote, so `instance="node-exporter:9100"` is a container name, not a hostname — fix it in relabeling if you care.

**Relabeling, briefly.** `relabel_configs` runs *before* a scrape and decides *whether and where* to scrape. `metric_relabel_configs` runs *after*, on the samples — this is where you drop a noisy metric or a cardinality bomb. Same syntax, different moment:

```yaml
    # before the scrape: drop anything tagged to-scrape=false
    relabel_configs:
      - source_labels: [to_scrape]
        regex: "false"
        action: drop
```

Now bring it up in a throwaway network and ask the API which targets are actually up. No privileged flags, `127.0.0.1` only:

```bash
$ docker network create prom-net
$ docker run -d --name node-exporter --network prom-net prom/node-exporter:latest
$ docker run -d --name prometheus --network prom-net \
    -p 127.0.0.1:19090:9090 \
    -v "$PWD/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
    -v "$PWD/rules.yml:/etc/prometheus/rules.yml:ro" \
    prom/prometheus:latest

$ curl -s 'localhost:19090/api/v1/targets?state=active' | # trimmed
  python3 -c 'import sys,json;d=json.load(sys.stdin);[print(t["labels"]["job"],t["scrapeUrl"],t["health"]) for t in d["data"]["activeTargets"]]'
ghost-app http://ghost-app:8080/metrics down
node http://node-exporter:9100/metrics up
prometheus http://localhost:9090/metrics up
```

There it is: two targets `up`, one deliberately `down` (it resolves to nothing), and a `lastError` explaining exactly why. That is the whole diagnosis loop, and it is a `curl`.

## The exposition format, and instrumenting your own code

A target's `/metrics` is plain text, one sample per line, with `# HELP` and `# TYPE` comments. This is real output from the node_exporter in the stack:

```text
# HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.
# TYPE node_cpu_seconds_total counter
node_cpu_seconds_total{cpu="0",mode="idle"} 39716.74
# HELP node_memory_MemAvailable_bytes Memory information field MemAvailable_bytes.
node_memory_MemAvailable_bytes 4.852969472e+09
```

Three types cover almost everything. A **counter** only goes up (`_total` by convention). A **gauge** goes up and down. A **histogram** counts observations into `le` buckets and exposes `_sum` and `_count`, which makes latency percentiles possible; a **summary** cannot be aggregated across instances, so prefer histograms.

For your own service, use a client library and count what you would act on: suffix counters with `_total`, keep unbounded values (user IDs, request IDs, full URLs, error strings) out of labels, and serve `/metrics` cheaply. That last rule is the cardinality trap on the producer's side.

## PromQL you actually use

Queries go through the same HTTP API the UI uses: `GET /api/v1/query?query=…`. The simplest one answers "is everything reachable" — here is the raw JSON for `up`, trimmed to one series:

```json
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "__name__": "up",
          "env": "prod",
          "instance": "node-exporter:9100",
          "job": "node",
          "role": "host"
        },
        "value": [1791796978.112, "1"]
      }
    ]
  }
}
```

`resultType: vector` means one value per series right now: the labels are the identity, `value` is `[timestamp, value]`. Stripped down, `up{job="node"} => 1`. A `rate()` needs at least two samples and returns nothing on a fresh target — a very common first-hour confusion.

**Counters become rates.** `rate()` takes a counter over a range and returns per-second averages, handling counter resets. The raw counters here are ~40,000 seconds of CPU — meaningless as a number.

```text
rate(node_cpu_seconds_total{mode="user"}[1m]){cpu=0,...} => 0.1503463111111091
rate(node_cpu_seconds_total{mode="user"}[1m]){cpu=1,...} => 0.16478844444443771
rate(node_cpu_seconds_total{mode="user"}[1m]){cpu=2,...} => 0.13590417777778047
```

`irate()` uses only the last two samples — jumpy, good for a "what just changed" panel, bad for alerting because one slow scrape skews it. `increase()` is `rate()` multiplied by the range in seconds, so it returns a count rather than a per-second rate:

```text
increase(node_network_receive_bytes_total{device="eth0"}[1m]){...} => 5843.1594000000005
```

**Aggregate, then ask.** `rate()` returns one series per CPU, and nobody wants eight. The aggregation operators (`sum`, `avg`, `min`, `max`, `count`, `topk`) fold them; `by` keeps the labels you name, `without` drops the ones you name and keeps the rest.

```text
sum by (mode) (rate(node_cpu_seconds_total[1m]))
{mode=idle} => 1.6643598833330575
{mode=iowait} => 0.6462703666666662
{mode=system} => 0.3225777333333336
{mode=user} => 1.4573601166666552
```

A gauge is read directly — no `rate()` — and `offset` lets you compare against the past by shifting the query back in time:

```text
node_memory_MemAvailable_bytes{instance="node-exporter:9100"} => 4797026304
node_memory_MemAvailable_bytes offset 30s{...}                => 4814864384
```

**Percentiles need a histogram.** This is where **histogram_quantile** earns its keep. It reads the `le` buckets, and the only correct pattern aggregates with `sum by (le)` first:

```text
histogram_quantile(0.95, sum by (le) (rate(prometheus_http_request_duration_seconds_bucket[5m])))
{} => 0.095
```

That is p95 HTTP request duration inside Prometheus: 95 milliseconds. Two warnings. A histogram quantile *interpolates* between bucket boundaries, so it is only as precise as your buckets — design the layout around the latency you care about. And the result must be labelled `le`; forgetting `sum by (le)` is the classic empty-result bug.

## Recording rules: precompute the expensive answer

PromQL is evaluated at query time. If a dashboard or an alert runs the same heavy expression forever, precompute it: a **recording rule** writes the result back into the TSDB as a new series on every `evaluation_interval`, so later queries are cheap.

```yaml
# rules.yml
groups:
  - name: node.rules
    rules:
      - record: instance:node_cpu_utilisation:rate1m
        expr: 1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[1m]))
```

The output is not special — it is just a series you can query by name, which is the point:

```text
instance:node_cpu_utilisation:rate1m{instance="node-exporter:9100"} => 0.7792161701389255
```

Follow `level:metric:operation` naming — `instance:node_cpu_utilisation:rate1m` reads as "instance-level node CPU utilisation, 1-minute rate" — so the name says what the expression does. Recording rules are not free: each adds series and evaluation cost, so record only what a dashboard or alert leans on.

## Alerting rules, and whether you actually need Alertmanager

An **alerting rule** is a recording rule with a verdict. It has an `expr`, an optional `for` (how long the condition must hold before firing — your first defence against flapping), `labels`, and `annotations` carrying the message.

```yaml
      - alert: TargetDown
        expr: up == 0
        for: 10s
        labels:
          severity: page
        annotations:
          summary: "Target {{ $labels.job }}/{{ $labels.instance }} is down"
          runbook: "https://blog.awin-x.top/posts/monitoring-a-small-fleet/"

      - alert: HostMemoryLow
        expr: node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.10
        for: 1m
        labels:
          severity: warning
```

Validate before you deploy — config errors are otherwise a silent `CrashLoopBackOff`:

```text
$ docker exec prometheus promtool check config /etc/prometheus/prometheus.yml
Checking /etc/prometheus/prometheus.yml
  SUCCESS: 1 rule files found
 SUCCESS: /etc/prometheus/prometheus.yml is valid prometheus config file syntax

Checking /etc/prometheus/rules.yml
  SUCCESS: 3 rules found
```

Because I left a dead target in the config, `up == 0` becomes true and the rule fires. Prometheus tracks alert state (`inactive → pending → firing`) and republishes it as the `ALERTS` metric, so you can query your alerts from outside:

```text
$ curl -s 'localhost:19090/api/v1/query' --data-urlencode 'query=ALERTS' | # trimmed
  python3 -c '...'
ALERTS{alertname=TargetDown,alertstate=firing,instance=ghost-app:8080,job=ghost-app,severity=page} => 1
```

`ALERTS` is more useful than it looks: it is how you build a "no alerts are flowing" meta-alert, and how a status page or log-based checker can read Prometheus state without speaking PromQL.

Do you need **Alertmanager**? It is a separate process that receives firing alerts and handles the heavy lifting: grouping, de-duplication, inhibition, silencing, and routing to email, Slack, ntfy, or a webhook. It also owns the dead-man's-switch pattern — a `watchdog` alert that always fires, which an external service alarms on when the heartbeat *stops*. One person, one channel: a rule plus a thirty-line notifier is legitimate. More than one destination, a maintenance window, or several hosts: Alertmanager pays for itself. Pair it with the watchdog, and see [how I monitor a small fleet](/posts/monitoring-a-small-fleet/) for the minimal version.

The bigger rule is in the title: **alerts must not cry wolf.** An expression is alert-worthy only if the correct response is to act. Alert on `up == 0`, on a disk predicted to fill inside your retention window (`predict_linear`), on a certificate expiring soon — not on high CPU, which is a fact, not a task. Use `for:` generously, and keep `severity: page` rules few enough that you read all of them. The same discipline applies to [a status page](/posts/status-page/), where a green light that lies is worse than none.

## The cardinality trap: the labels that quietly kill you

A time series is a metric name plus one unique label combination. **Every new combination is a new series**, and series cost memory, disk, and query time forever. The classic mistake is a high-cardinality value in a label: user ID, request ID, full URL path, session token, error message, a raw timestamp. A metric that looks like one line can be a million series two weeks later.

You can audit this from the API. Total active series, then the metrics contributing most of them:

```text
count({__name__=~".+"}) => 1669
topk(5, count by (__name__)({__name__=~".+"}))
node_cpu_seconds_total              => 64
prometheus_http_requests_total      => 64
node_scrape_collector_success       => 49
node_scrape_collector_duration_seconds => 49
prometheus_http_request_duration_seconds_bucket => 40
```

This tiny stack is already at ~1,700 series: `node_cpu_seconds_total` alone is 64 because it is `8 CPUs × 8 modes`. Nothing here is pathological — but swap `cpu` for `url_path` on a real service and the same multiplier hits your traffic. The fixes, in order: do not emit the label; drop it with `metric_relabel_configs`; aggregate it away in a recording rule. Watch your series count like you watch disk.

## Retention and storage: decide before you need the data

Prometheus stores everything in a local TSDB — two-hour blocks, a write-ahead log, compaction — and it will eat that disk forever unless you bound it, by time or by size:

```bash
$ docker run -d --name prometheus --network prom-net \
    -p 127.0.0.1:19090:9090 \
    -v "$PWD/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
    -v "$PWD/rules.yml:/etc/prometheus/rules.yml:ro" \
    prom/prometheus:latest \
    --storage.tsdb.retention.time=15d \
    --storage.tsdb.retention.size=10GB
```

Retention is really a cardinality calculation: samples per second ≈ series ÷ scrape interval. At 15s, 1,700 series is ~113 samples/s — a rounding error. At 1,000,000 series it is ~67,000 samples/s, and no retention flag saves you; fix the labels. When you genuinely need years of history, keep local retention short and `remote_write` to VictoriaMetrics, Thanos, or Mimir. For a few hosts and weeks of trend, local storage with an explicit bound is enough.

## Prometheus vs a log-based checker

These are different tools for different questions, and picking wrong is expensive.

- **Prometheus is for numbers over time**: rates, ratios, percentiles, "how much / how fast / how many," compared across hosts and windows. It is cheap, it is already there, and it is the only sane way to ask "is this getting worse?"
- **A log-based checker is for events**: exact strings, individual errors, "did this specific thing happen." Logs carry the high-cardinality detail that would be a cardinality bomb as a metric, and `journalctl -u thing --since` needs no exporter at all.

The honest answer for a couple of boxes is that [a script, a timer, and a watchdog](/posts/monitoring-a-small-fleet/) cover disk, services, and certs with zero new daemons. Add Prometheus when you have several hosts, a trend question a threshold cannot answer, or an SLO — and it becomes the thing your scripts feed, not a replacement for them. Metrics tell you *that* something changed; logs tell you *why*. Reach for the one that answers the question in front of you.

The whole stack in this post was three `docker run` commands and two files. That is the promise of **Prometheus**: the hard part is never the install, it is deciding what is worth a series, what is worth a page, and what to let go.

```bash
$ docker rm -f prometheus node-exporter && docker network rm prom-net
```
