---
title: "Prometheus Recording Rules and Federation: Pre-computing What You Ask for Often"
description: "Recording rules pre-compute expensive PromQL into new metrics on an interval. Federation pulls aggregated series from many Prometheus instances into one. Real output from a live setup with promtool, /api/v1/rules, and /federate."
pubDate: 2027-02-01
lang: en
translationKey: prometheus-recording-rules
tags: [devops, self-hosting]
featured: false
keywords:
  - Prometheus recording rules
  - rule_files
  - Prometheus federation
  - promtool
  - PromQL
---

If you have run Prometheus for any length of time, you have felt the pain: a dashboard with six panels, each running `avg_over_time(...[5m])` or `histogram_quantile(...)` over the same data, and every refresh hammers the query engine. The fix is a **recording rule** — a PromQL expression that Prometheus evaluates on a fixed interval and stores as a brand-new metric. The dashboard then queries the pre-computed metric, which is nearly free.

This article shows recording rules and federation working together on a live Prometheus, with real output from `promtool`, the HTTP API, and the `/federate` endpoint. It builds on the [Prometheus in practice](/posts/prometheus-in-practice/) and [Alertmanager in practice](/posts/alertmanager-in-practice/) articles — read those first if you are new to Prometheus.

## The problem: dashboards re-run the same expensive query

A typical dashboard panel might run:

```promql
1 - (avg_over_time(node_memory_MemAvailable_bytes[5m]) / avg_over_time(node_memory_MemTotal_bytes[5m]))
```

That expression scans five minutes of raw samples every time the panel refreshes. With ten panels on a dashboard, you multiply that cost by ten, and it repeats every 30 seconds. The query engine does the same work over and over, producing the same number (within the evaluation interval).

A recording rule flips the model: compute once, store the result, query the stored result as often as you like.

<figure>
<svg viewBox="0 0 640 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Recording rule flow diagram">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-auto">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <style>
    .box { fill: none; stroke: currentColor; stroke-width: 1.5; rx: 4; }
    .label { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; fill: currentColor; }
    .small { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; fill: currentColor; opacity: 0.7; }
    .expensive { color: #b91c1c; }
    .cheap { color: #0f766e; }
    .neutral { color: #374151; }
  </style>
  <!-- Expensive path -->
  <text x="10" y="20" class="label expensive">Without recording rule</text>
  <rect x="10" y="30" width="160" height="50" class="box expensive"/>
  <text x="20" y="50" class="label expensive">Dashboard refresh</text>
  <text x="20" y="65" class="small expensive">runs PromQL now</text>
  <line x1="170" y1="55" x2="200" y2="55" stroke="currentColor" class="expensive" marker-end="url(#arrow)"/>
  <rect x="200" y="30" width="180" height="50" class="box expensive"/>
  <text x="210" y="50" class="label expensive">Expensive PromQL</text>
  <text x="210" y="65" class="small expensive">avg_over_time[5m] scan</text>
  <line x1="380" y1="55" x2="410" y2="55" stroke="currentColor" class="expensive" marker-end="url(#arrow)"/>
  <rect x="410" y="30" width="100" height="50" class="box expensive"/>
  <text x="420" y="50" class="label expensive">Slow</text>
  <text x="420" y="65" class="small expensive">repeated cost</text>
  <!-- Recording rule path -->
  <text x="10" y="110" class="label cheap">With recording rule</text>
  <rect x="10" y="120" width="160" height="50" class="box neutral"/>
  <text x="20" y="140" class="label neutral">Recording rule</text>
  <text x="20" y="155" class="small neutral">every 30s</text>
  <line x1="170" y1="145" x2="200" y2="145" stroke="currentColor" class="cheap" marker-end="url(#arrow)"/>
  <rect x="200" y="120" width="180" height="50" class="box cheap"/>
  <text x="210" y="140" class="label cheap">Pre-computed metric</text>
  <text x="210" y="155" class="small cheap">stored in TSDB</text>
  <line x1="380" y1="145" x2="410" y2="145" stroke="currentColor" class="cheap" marker-end="url(#arrow)"/>
  <rect x="410" y="120" width="100" height="50" class="box cheap"/>
  <text x="420" y="140" class="label cheap">Cheap query</text>
  <text x="420" y="155" class="small cheap">instant lookup</text>
</svg>
<figcaption>FIG. 1 — A recording rule pre-computes the expensive expression on an interval; dashboards query the stored result instead of re-scanning raw samples.</figcaption>
</figure>

## What a recording rule is

A recording rule is a PromQL expression that Prometheus evaluates on a fixed interval (default: the `evaluation_interval` from the global config). The result is written back into the TSDB under a new metric name that you choose. From that point on, the new metric behaves like any other: you can query it, alert on it, graph it, and federate it.

The syntax lives in a separate YAML file referenced by `rule_files` in the main config:

```yaml
groups:
  - name: node_recording
    interval: 30s
    rules:
      - record: job:node_memory_usage:ratio5m
        expr: |
          1 - (
            avg_over_time(node_memory_MemAvailable_bytes[5m])
            /
            avg_over_time(node_memory_MemTotal_bytes[5m])
          )
```

Three fields matter:

- **`groups`** — a list of rule groups. Each group has a name, an optional `interval` (overrides the global evaluation interval for this group), and a list of `rules`.
- **`record`** — the name of the new metric that will be created. This is what you query later.
- **`expr`** — the PromQL expression to evaluate. The result is stored as a new time series with the name from `record`.

You can also attach **`labels`** to a rule, which adds static labels to every series it produces.

## Live demo: a recording rule from zero to federated

I ran a throwaway Prometheus with a node-exporter target and a single recording rule. Here is the full setup and the real output at each step.

### The rule file

The complete `recording.yml`:

```yaml
groups:
  - name: node_recording
    interval: 30s
    rules:
      - record: job:node_memory_usage:ratio5m
        expr: |
          1 - (
            avg_over_time(node_memory_MemAvailable_bytes[5m])
            /
            avg_over_time(node_memory_MemTotal_bytes[5m])
          )
```

The main config references it:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - "recording.yml"

scrape_configs:
  - job_name: 'node'
    static_configs:
      - targets: ['localhost:9100']
```

### promtool check rules

Before reloading Prometheus, validate the file with `promtool`:

```console
$ promtool check rules recording.yml
Checking recording.yml
  SUCCESS: 1 rules found
```

`promtool` parses the YAML, checks the PromQL syntax, and confirms the rule structure. It catches typos in metric names, malformed expressions, and invalid interval formats before they cause runtime errors.

### The new metric appears

After Prometheus loads the rule file and the `interval` (30s) passes, the rule starts producing data. Query the rules API to see its health:

```json
{
  "status": "success",
  "data": {
    "groups": [
      {
        "name": "node_recording",
        "file": "/etc/prometheus/recording.yml",
        "rules": [
          {
            "name": "job:node_memory_usage:ratio5m",
            "query": "1 - (avg_over_time(node_memory_MemAvailable_bytes[5m]) / avg_over_time(node_memory_MemTotal_bytes[5m]))",
            "labels": {},
            "health": "ok",
            "evaluationTime": 0.000227469,
            "lastEvaluation": "2026-10-14T03:24:51.571453842Z",
            "type": "recording"
          }
        ],
        "interval": 30,
        "limit": 0,
        "evaluationTime": 0.000255283,
        "lastEvaluation": "2026-10-14T03:24:51.571430076Z"
      }
    ]
  }
}
```

The key fields:

- **`health: "ok"`** — the rule evaluated successfully on its last run.
- **`evaluationTime: 0.000227469`** — how long the evaluation took (sub-millisecond for this simple expression).
- **`lastEvaluation`** — the timestamp of the most recent evaluation.
- **`type: "recording"`** — distinguishes it from alerting rules.

Now query the new metric directly:

```console
$ curl -s 'http://localhost:9090/api/v1/query' \
    --data-urlencode 'query=job:node_memory_usage:ratio5m'
```

```json
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "__name__": "job:node_memory_usage:ratio5m",
          "instance": "localhost:9100",
          "job": "node"
        },
        "value": [1791948311.687, "0.7272438878982002"]
      }
    ]
  }
}
```

The metric `job:node_memory_usage:ratio5m` now exists in the TSDB. It has the `instance` and `job` labels from the source series, plus the value computed by the expression. A dashboard panel can query this metric and get an instant result.

### The expensive query it replaces

For comparison, the raw PromQL expression (what the dashboard would run without a recording rule):

```console
$ curl -s 'http://localhost:9090/api/v1/query' \
    --data-urlencode 'query=1 - (avg_over_time(node_memory_MemAvailable_bytes[5m]) / avg_over_time(node_memory_MemTotal_bytes[5m]))'
```

```json
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "instance": "localhost:9100",
          "job": "node"
        },
        "value": [1791948322.370, "0.7255751954730405"]
      }
    ]
  }
}
```

Same value (within the evaluation interval), but the query engine had to scan five minutes of raw samples to compute it. With a recording rule, that scan happens once every 30 seconds; every dashboard refresh reads a single pre-computed point.

The gap widens with complexity. A `histogram_quantile` over a `rate()` with many label combinations, or a `sum()` across hundreds of series, can take hundreds of milliseconds per evaluation. Pre-compute it once, and the dashboard cost drops to a simple lookup.

## Naming conventions: level:metric:operations

Prometheus has a convention for recording rule names: **`level:metric:operations`**.

- **`level`** — the aggregation level: `job`, `instance`, `service`, `cluster`, etc.
- **`metric`** — the base metric name, usually matching the source metric.
- **`operations`** — the operations applied, in order: `rate5m`, `sum`, `avg`, etc.

Examples:

| Name | Meaning |
|------|---------|
| `job:node_memory_usage:ratio5m` | Memory usage ratio per job, averaged over 5m |
| `instance:node_cpu_usage:ratio5m` | CPU usage ratio per instance, averaged over 5m |
| `job:node_disk_used:ratio1h` | Disk used ratio per job, averaged over 1h |
| `service:http_requests:rate5m` | HTTP request rate per service, over 5m |

The convention makes it obvious what a metric represents and at what level of aggregation. It also prevents collisions: two rules that compute the same thing at different levels get different names.

## Federation: one global view from many locals

Federation lets a "global" Prometheus pull selected metrics from one or more "local" Prometheus instances via the `/federate` endpoint. The global instance scrapes the locals, stores the data, and provides a single query interface for dashboards and alerts.

The global config:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'federate-local'
    honor_labels: true
    metrics_path: '/federate'
    params:
      'match[]':
        - '{job="node"}'
    static_configs:
      - targets: ['prom-local:9090']
```

The `params` block selects which metrics to pull. Here, `{job="node"}` pulls all series with `job="node"` — including the recording rule output, because recording rules inherit the labels of their source series.

### The /federate endpoint

Query the local Prometheus directly to see what federation would pull:

```console
$ curl -s 'http://localhost:9090/federate?match[]=%7Bjob%3D%22node%22%7D'
```

The output is Prometheus text format. Among the federated series is the recording rule metric:

```
# TYPE job:node_memory_usage:ratio5m untyped
job:node_memory_usage:ratio5m{instance="localhost:9100",job="node"} 0.7272438878982002 1791948291570
```

The recording rule output is federated just like any other metric. The global Prometheus stores it and makes it queryable.

### Querying the federated data

On the global Prometheus, the recording rule metric is available:

```console
$ curl -s 'http://localhost:9091/api/v1/query' \
    --data-urlencode 'query=job:node_memory_usage:ratio5m'
```

```json
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "__name__": "job:node_memory_usage:ratio5m",
          "instance": "localhost:9100",
          "job": "node"
        },
        "value": [1791948311.705, "0.7272438878982002"]
      }
    ]
  }
}
```

The value matches the local Prometheus (within the federation scrape interval). A dashboard pointed at the global instance sees the pre-computed metric without ever touching the local Prometheus.

### When federation is right (and when it isn't)

Federation is the right tool when:

- You have **multiple Prometheus instances** (per-cluster, per-region, per-tenant) and need a **single query interface** for cross-cutting dashboards or alerts.
- You want to **aggregate a subset of metrics** (not everything) from locals into a central view.
- You need a **simple, pull-based** topology without external dependencies.

Federation is **not** a long-term store. It does not deduplicate, compress, or retain data beyond the global instance's own retention. For long-term storage, global queryability across a fleet, or high-availability, use a dedicated system:

- **Thanos** — sidecar + store gateway + query layer, works with object storage.
- **Mimir** (formerly Cortex) — multi-tenant, horizontally scalable, object storage backend.
- **VictoriaMetrics** — single-binary or cluster, efficient compression, Prometheus-compatible.

Federation is a lightweight aggregation layer. It is not a replacement for a real long-term store.

## The cardinality cost

Every recording rule creates new time series. The cardinality of the output depends on the labels of the source series and the expression:

- A rule that aggregates away labels (e.g., `sum(...) by (job)`) produces **fewer** series than the source.
- A rule that preserves all labels (e.g., `avg_over_time(...[5m])` without aggregation) produces the **same** number of series as the source.
- A rule that adds labels (via `labels:`) can produce **more** series.

The cost is storage and memory. Each new series consumes TSDB blocks and is held in memory for recent data. A rule that creates 10,000 new series on a busy Prometheus is 10,000 more series to store, compact, and query.

Before adding a rule, ask: how many source series match the expression? If the answer is "thousands", the rule will create thousands of new series. Make sure the benefit (faster dashboards, stable alerting) justifies the cost.

## Do you need it?

For a single small Prometheus — one instance, a handful of targets, a few dashboards — **probably not**. The query engine is fast enough for simple expressions, and the operational complexity of managing rule files, validating with `promtool`, and monitoring rule health is not worth it.

Recording rules earn their keep when:

- **Dashboards are slow** because panels re-run expensive PromQL on every refresh.
- **Alerts need a stable series** — a recording rule ensures the alert expression queries a pre-computed metric, not a raw expression that might behave differently at evaluation time.
- **Multiple consumers** (dashboards, alerts, other rules) need the same computation — compute once, use everywhere.
- **Federation** — recording rules let you pre-compute at the local level and federate the result, reducing the load on the global instance.

Start with one rule for your most expensive dashboard query. Measure the improvement. Add more only when the benefit is clear.

## Conclusion

Recording rules are Prometheus's answer to "stop computing the same thing over and over." You write a PromQL expression, Prometheus evaluates it on an interval, and the result becomes a new metric that is cheap to query, alert on, and federate. Federation then lets you pull those pre-computed metrics from many locals into a single global view.

The tools are simple: a YAML file in `rule_files`, `promtool check rules` for validation, `/api/v1/rules` for health, and `/federate` for aggregation. The discipline is naming (`level:metric:operations`) and cardinality awareness (every new rule creates new series).

For a single small Prometheus, recording rules are optional. For a fleet, they are essential.
