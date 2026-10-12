---
title: "Log aggregation with Grafana Loki: cheap logs, real queries"
description: "Grafana Loki indexes labels instead of full text, and that is what makes log aggregation cheap. Real Loki 3.4 output: pushing lines, LogQL stream selectors, line filters, rate() metric queries, and the label cardinality trap."
pubDate: 2027-01-10
lang: en
translationKey: loki-log-aggregation
tags: [devops, self-hosting]
featured: false
keywords:
  - Grafana Loki
  - LogQL
  - log aggregation
  - label cardinality
  - Promtail
---

Logs are the cheapest telemetry you will ever collect — until you try to keep a
week of them. One busy service writes gigabytes a day; centralise a dozen and the
storage bill stops being a joke. **Grafana Loki** takes a different trade than
the Elastic stack: it indexes *labels*, not log lines. That one decision is what
makes **log aggregation** affordable on a homelab budget, and this post is a
hands-on walkthrough of it — real Loki 3.4.1, real pushes, real **LogQL** output.

## Why logs get expensive, and what Loki does differently

Traditional **log aggregation** (ELK, Splunk) works like a search engine. Every
line is parsed and tokenised into an inverted index, and that index is frequently
as large as — or larger than — the raw text it points at; you pay for it at ingest
(CPU, memory, disk) and again at query.

Loki inverts the trade-off. It writes log lines into compressed **chunks** on
cheap storage — local disk, S3, GCS — and builds an index over **labels** only:
the key/value pairs describing where a line came from (`job`, `service`,
`level`). The log line itself is never indexed: you pick streams by label, then
filter the lines with a substring or regex match. It is the same philosophy as
Prometheus, pointed at logs. If you read
[my Prometheus write-up](/posts/prometheus-in-practice/), the mental model
transfers directly — a stream is a series, and LogQL is PromQL with a line
filter bolted on. For "which service started erroring ten minutes ago, and how
often", it is the cheapest correct answer I know.

## Architecture: agents push, Loki stores chunks, Grafana queries

The data path has exactly three parts:

1. **Agent** (Promtail, Fluent Bit, Grafana Alloy) tails log files, attaches
   labels, and pushes to `/loki/api/v1/push`.
2. **Loki** deduplicates, compresses lines into chunks, writes the label index,
   and stores both on the configured backend.
3. **Grafana** queries Loki with LogQL and renders log panels or metric graphs.

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 250" width="720" height="250" role="img" aria-label="Promtail and other agents push labelled log streams to Loki over POST /loki/api/v1/push. Loki stores gzip-compressed chunks of log lines on object storage, plus a small label index that maps label sets to streams. Grafana queries everything with LogQL and renders log panels and metric graphs.">
  <defs>
    <marker id="loki-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <style>
    .box  { fill: none; stroke: currentColor; stroke-width: 2; }
    .t    { font-family: system-ui, sans-serif; font-size: 13px; fill: currentColor; }
    .s    { font-family: system-ui, sans-serif; font-size: 11px; fill: currentColor; opacity: 0.75; }
    .b    { font-family: system-ui, sans-serif; font-size: 13px; fill: currentColor; font-weight: bold; }
    .teal { font-family: system-ui, sans-serif; font-size: 11px; fill: #0f766e; }
    .arrow{ stroke: #0f766e; stroke-width: 2; fill: none; marker-end: url(#loki-arrow); }
    .inner{ fill: none; stroke: currentColor; stroke-width: 1.5; opacity: 0.6; }
  </style>
  <rect class="box" x="16" y="80" width="150" height="84" rx="8"/>
  <text class="b" x="91" y="112" text-anchor="middle">Promtail</text>
  <text class="s" x="91" y="132" text-anchor="middle">tails /var/log</text>
  <text class="s" x="91" y="148" text-anchor="middle">attaches labels</text>
  <path class="arrow" d="M166 122 L212 122"/>
  <text class="teal" x="189" y="112" text-anchor="middle">push</text>
  <rect class="box" x="214" y="32" width="260" height="180" rx="8"/>
  <text class="b" x="344" y="60" text-anchor="middle" font-size="15">Loki</text>
  <text class="s" x="344" y="78" text-anchor="middle">POST /loki/api/v1/push</text>
  <rect class="inner" x="230" y="92" width="110" height="66" rx="4"/>
  <text class="t" x="285" y="116" text-anchor="middle" font-weight="bold">chunks</text>
  <text class="s" x="285" y="133" text-anchor="middle">gzip'd lines</text>
  <text class="s" x="285" y="149" text-anchor="middle">on object store</text>
  <rect class="inner" x="352" y="92" width="110" height="66" rx="4"/>
  <text class="t" x="407" y="116" text-anchor="middle" font-weight="bold">label index</text>
  <text class="s" x="407" y="133" text-anchor="middle">job · service</text>
  <text class="s" x="407" y="149" text-anchor="middle">level → streams</text>
  <text class="s" x="344" y="178" text-anchor="middle">high-cardinality fields stay in the line</text>
  <path class="arrow" d="M474 122 L520 122"/>
  <text class="teal" x="497" y="112" text-anchor="middle">LogQL</text>
  <rect class="box" x="522" y="80" width="150" height="84" rx="8"/>
  <text class="b" x="597" y="112" text-anchor="middle">Grafana</text>
  <text class="s" x="597" y="132" text-anchor="middle">log panels</text>
  <text class="s" x="597" y="148" text-anchor="middle">metric panels</text>
  <text class="teal" x="360" y="238" text-anchor="middle">the index holds labels only — never the log line itself</text>
</svg>
<figcaption>Agents push labelled streams to Loki, which stores compressed chunks and a tiny label index. Grafana reads both back with LogQL, so the same data can be a log panel or a graph.</figcaption>
</figure>

The agent does the labelling, Loki is close to a dumb store, and all the
intelligence lives in the query language. That split is why Loki is one binary
with no external dependency — no ZooKeeper, no Elasticsearch cluster.

## Running a real Loki: config, a real push, and the label index

I ran a throwaway Loki 3.4.1 (single binary, filesystem storage, `127.0.0.1`,
no auth). All output below comes from one fresh instance with an empty data
directory. This is the whole config — there is nothing else:

```yaml
auth_enabled: false

server:
  http_listen_port: 3100

common:
  instance_addr: 127.0.0.1
  path_prefix: /loki-data
  storage:
    filesystem:
      chunks_directory: /loki-data/chunks
      rules_directory: /loki-data/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  reject_old_samples: true
  reject_old_samples_max_age: 168h
  allow_structured_metadata: true
  retention_period: 168h

compactor:
  working_directory: /loki-data/compactor
  retention_enabled: true
  delete_request_store: filesystem
```

### Pushing log lines

The push API is plain JSON — one stream per label set, one `[timestamp, line]`
pair per entry, and the response is `HTTP 204` with an empty body: fire and forget,
because Loki acknowledges the batch, not each line.

```bash
$ curl -sS -X POST http://127.0.0.1:3100/loki/api/v1/push \
    -H "Content-Type: application/json" \
    -d '{"streams":[{"stream":{"job":"blog-demo","level":"info","service":"api"},
        "values":[["1791841400000000000","GET /posts/loki-log-aggregation 200 12ms"]]}]}' \
    -w "HTTP %{http_code}\n"
HTTP 204
```

### What the label index actually holds

```bash
$ curl -s http://127.0.0.1:3100/loki/api/v1/labels
{"status":"success","data":["job","level","service","service_name"]}

$ curl -s http://127.0.0.1:3100/loki/api/v1/label/level/values
{"status":"success","data":["error","info"]}

$ curl -s -G http://127.0.0.1:3100/loki/api/v1/series \
    --data-urlencode 'match[]={job="blog-demo"}'
{"status":"success","data":[
  {"job":"blog-demo","level":"info","service":"nginx","service_name":"nginx"},
  {"job":"blog-demo","level":"error","service":"api","service_name":"api"},
  {"job":"blog-demo","level":"info","service":"api","service_name":"api"}]}
```

Four label *names* for seven log lines — that is the entire index; three are
mine (`job`, `level`, `service`), and `service_name` is injected by Loki 3.x's
default `discover_service_name`. Query results additionally carry `detected_level`
(from `discover_log_levels: true`), which never shows up in `/labels`. Every
unique label combination is a **stream**, and a stream is the unit of storage:
one chunk, one index entry. Three label sets above, three streams, seven lines.

## LogQL: stream selectors, line filters, and metric queries

LogQL has three layers, and you compose them left to right: a **stream
selector** in braces, **line filters** after a pipe, and optionally a **metric
query** wrapped around the whole thing.

### Stream selector

```bash
$ curl -s -G http://127.0.0.1:3100/loki/api/v1/query_range \
    --data-urlencode 'query={job="blog-demo"}' \
    --data-urlencode "start=$((EPOCHSECONDS-900))000000000" \
    --data-urlencode "end=$EPOCHSECONDS000000000" \
    --data-urlencode 'limit=4' | python3 -m json.tool
```

```json
{
  "resultType": "streams",
  "result": [
    {
      "stream": {
        "detected_level": "error",
        "job": "blog-demo",
        "level": "error",
        "service": "api",
        "service_name": "api"
      },
      "values": [
        ["1791841405000000000", "ERROR upstream 502 bad gateway from 10.0.0.5:8080"],
        ["1791841404000000000", "ERROR database connection refused: timeout after 30s"]
      ]
    },
    {
      "stream": {
        "detected_level": "info",
        "job": "blog-demo",
        "level": "info",
        "service": "nginx",
        "service_name": "nginx"
      },
      "values": [
        ["1791841407000000000", "192.168.1.43 - - [13/Oct/2026:04:20:19 +0000] \"GET /posts/structured-logging HTTP/1.1\" 200 892"],
        ["1791841406000000000", "192.168.1.42 - - [13/Oct/2026:04:20:18 +0000] \"GET /zh/posts/loki-log-aggregation HTTP/1.1\" 200 1234"]
      ]
    }
  ],
  "stats": {
    "summary": {
      "totalLinesProcessed": 7,
      "totalEntriesReturned": 4,
      "totalBytesProcessed": 458,
      "execTime": 0.006074
    }
  }
}
```

Line order is newest-first (`direction=backward` is the default). The `stats`
block is the part I actually read: `totalLinesProcessed: 7` against
`totalEntriesReturned: 4` is `limit=4` doing its job.

### Line filters

`|=` substring, `!=` exclusion, `|~` regex (add `(?i)` for case-insensitive).
They run *after* the stream is selected, so the label set stays cheap while the
text search does the precise work:

```bash
$ curl -s -G http://127.0.0.1:3100/loki/api/v1/query_range \
    --data-urlencode 'query={job="blog-demo"} |= "ERROR"' \
    --data-urlencode "start=$((EPOCHSECONDS-900))000000000" \
    --data-urlencode "end=$EPOCHSECONDS000000000" | python3 -m json.tool
```

```json
{
  "resultType": "streams",
  "result": [
    {
      "stream": {"detected_level": "error", "job": "blog-demo", "level": "error",
                 "service": "api", "service_name": "api"},
      "values": [
        ["1791841405000000000", "ERROR upstream 502 bad gateway from 10.0.0.5:8080"],
        ["1791841404000000000", "ERROR database connection refused: timeout after 30s"]
      ]
    }
  ],
  "stats": {"summary": {"totalLinesProcessed": 7, "totalEntriesReturned": 2}}
}
```

Seven lines scanned, two returned — the five-millisecond cost (`execTime:
0.004581`) of not having a full-text index, and it is fine.

### Metric queries

Wrap the log query in a range function and you get a Prometheus-style time series
out of log text. This is what makes Loki worth running even if you never open a
log panel:

```bash
$ curl -s -G http://127.0.0.1:3100/loki/api/v1/query_range \
    --data-urlencode 'query=rate({job="blog-demo"} |= "ERROR" [1m])' \
    --data-urlencode "start=$((EPOCHSECONDS-900))000000000" \
    --data-urlencode "end=$EPOCHSECONDS000000000" \
    --data-urlencode 'step=60' | python3 -m json.tool
```

```json
{
  "resultType": "matrix",
  "result": [
    {
      "metric": {"detected_level": "error", "job": "blog-demo", "level": "error",
                 "service": "api", "service_name": "api"},
      "values": [[1791841440, "0.03333333333333333"]]
    }
  ]
}
```

Two error lines in a 60-second window: 2 / 60 = `0.0333` lines per second —
checkable by hand, which is what you want from a dashboard. Aggregations work
too:

```json
{
  "resultType": "matrix",
  "result": [
    {"metric": {"service": "api"},   "values": [[1791841440, "0.016666666666666666"],
                                                [1791841500, "0.016666666666666666"]]},
    {"metric": {"service": "nginx"}, "values": [[1791841440, "0.006666666666666667"],
                                                [1791841500, "0.006666666666666667"]]}
  ]
}
```

That is `sum by (service) (rate({job="blog-demo"}[5m]))` — 5 api lines and 2
nginx lines over 300 seconds, matching the raw counts. And `| json | unwrap
duration_ms` pulls numeric fields out of structured lines, so logs become latency
percentiles:

```bash
$ curl -s -G .../loki/api/v1/query_range \
    --data-urlencode 'query=quantile_over_time(0.95, {job="blog-demo"} | json | unwrap duration_ms [5m])' ...
{"resultType":"matrix",
 "result":[{"metric":{"job":"blog-demo","service":"api","host":"demo-1","env":"test",
                      "level":"error","path":"/zh/posts/loki-log-aggregation","status":"500",
                      "duration_ms":"926","msg":"request handled"},
            "values":[[1791841140,"926"]]}]}
```

Logs into latency percentiles, no metrics pipeline required. Note that parsed
fields come back in `metric` — they are per-line data, they never enter the index.

## Promtail: the agent does the labelling

Promtail is the default shipper: it tails files, tracks byte offsets in a
positions file, and attaches the labels you configure. A minimal config with a
pipeline stage that promotes only the low-cardinality field to a label:

```yaml
server:
  http_listen_port: 9080

clients:
  - url: http://loki:3100/loki/api/v1/push

positions:
  filename: /run/promtail/positions.yaml

scrape_configs:
  - job_name: blog-demo
    static_configs:
      - targets: [localhost]
        labels:
          job: blog-demo
          service: api
          host: demo-1
          env: test
          __path__: /var/log/blog-demo/*.log
    pipeline_stages:
      - json:
          expressions:
            level: level
            status: status
            path: path
            duration_ms: duration_ms
      - labels:
          level:            # promote only this one to a label
      - timestamp:
          source: ts
          format: RFC3339
```

After it picked up a ten-line JSON log file, its positions file proved it had
read the whole thing:

```bash
$ docker exec promtail-cat /run/promtail/positions.yaml
positions:
  /var/log/blog-demo/api.log: "1152"
```

And the lines in Loki carry the agent's labels plus Loki's automatic ones:

```json
{
  "stream": {
    "detected_level": "info", "env": "test", "filename": "/var/log/blog-demo/api.log",
    "host": "demo-1", "job": "blog-demo", "level": "info", "service": "api",
    "service_name": "api"
  },
  "values": [
    ["1791841114074267075", "{\"ts\": \"2026-10-12T21:38:19Z\", \"level\": \"info\", \"status\": 201, \"path\": \"/api/v1/comments\", \"duration_ms\": 2230, \"msg\": \"request handled\"}"]
  ]
}
```

`status` and `path` stayed inside the line — high cardinality, searchable with
`| json | status >= 500`, never indexed. That is the whole discipline in one
config. (Structured logging is what makes this cheap; see
[Structured logging](/posts/structured-logging/) for the producer side.)

The Grafana leg, verified the same way: a throwaway Grafana with a Loki
datasource proxied to `http://loki:3100`, queried through `/api/ds/query`,
returned the same `ERROR upstream 502` line as Grafana data frames.

## Label cardinality: the mistake that costs the most

This is the part that bites. **Keep label
cardinality low**: every unique label combination is a new stream, and each
stream costs memory, a chunk, and an index entry.

I measured it. Same machine, same config, 500 log lines pushed twice — once with
low-cardinality labels, once with `request_id` as a label:

```bash
=== before cardA ===
  loki_ingester_memory_streams=3  labels_bytes=203
=== after cardA (500 lines, 1 stream) ===
  loki_ingester_memory_streams=4  labels_bytes=250
  delta streams=1  delta label bytes=47
=== after cardB (the same 500 lines, request_id as a label) ===
  loki_ingester_memory_streams=504  labels_bytes=35250
  delta streams=500  delta label bytes=35000
```

Identical log content. Index cost: **47 bytes versus 35,000 bytes — 745×** — and
500 live streams instead of 1. Label metadata runs about 70 bytes per stream, so a
million unique `request_id`s a day is ~70 MB of index *per day* before you store a
single line of log.

Loki also refuses to let you get this badly wrong. `max_label_names_per_series`
defaults to 15, and pushing 18 is a hard error:

```bash
$ curl -sS -X POST http://127.0.0.1:3100/loki/api/v1/push -H "Content-Type: application/json" -d @limit.json
entry for stream '{job="limit-demo", l00="v", ... l15="v", service="api", service_name="api"}' has 18 label names; limit 15
```

The rules I actually use:

- **Good labels:** `job`, `service`, `level`, `env`, `instance`, `host` — bounded
  sets, dozens of values at most.
- **Bad labels:** `request_id`, `user_id`, `trace_id`, `url_path`, `ip` —
  unbounded. Put them in the line and filter with `|=` / `|~` / `| json`.
- **Test:** if you would not `GROUP BY` it in SQL, do not label with it.
- **Check:** `loki_ingester_memory_streams` and `..._labels_bytes` are the two
  gauges to alert on. A stream count that tracks traffic instead of service count
  is the bug.

The classic incident: someone adds `trace_id` as a label so tracing "just works",
stream count goes vertical with traffic, and the fix is demoting it back into the
line. Cardinality is the one Loki mistake that is expensive to make and free to
avoid.

## Retention and storage

Retention is a schema-period concern, not a bolt-on. With the TSDB index (default
since 2.4), `period: 24h` opens a new index table daily and the compactor deletes
tables older than `retention_period: 168h`:

```yaml
limits_config:
  retention_period: 168h        # 7 days, shown as "1w" in /config

compactor:
  working_directory: /loki-data/compactor
  retention_enabled: true
  delete_request_store: filesystem   # <- required, see below
```

Two real gotchas: enabling retention without `delete_request_store` fails
validation outright, which is exactly what my first attempt did:

```
level=error msg="error running loki" err="CONFIG ERROR: invalid compactor config:
compactor.delete-request-store should be configured when retention is enabled"
```

Second, `reject_old_samples_max_age: 168h` silently drops lines older than a
week: a safety net for clock skew, and a confusing reason for "missing logs" when
an agent replays a backlog.

For storage: chunks are gzip-compressed (`chunk_encoding: gzip` is the default)
and the label index grows with stream count — the cardinality argument restated.
Measured here: 1,008 lines, 80,001 bytes of push payload, 504 streams, 35,250
bytes of label metadata, 168 KB on disk, most of it the 500 streams I created to
prove a point. Filesystem storage is fine for one box; S3/GCS once you need a
second writer.

## Loki vs ELK, and Loki vs journald

**ELK** is a search engine with opinions: Elasticsearch, Logstash or Beats,
Kibana, and the inverted index you pay for on top. It wins when the question is
"find every line mentioning this phrase in 2 TB of logs", or when you want
aggregations over log *content*. Loki wins everywhere else: one binary, one
storage backend, a query language you half-know from PromQL, and a storage bill
that does not need a CFO. Honest about the trade: Loki is bad at ad-hoc full-text
search, and no amount of labels fixes that.

**journald** is not a competitor, it is the local floor. On one Linux box,
`journalctl -u nginx --since "10 min ago" -p err` is faster than any aggregator
and already installed. The moment you have two hosts and need to correlate, or a
rotation policy, or someone who cannot SSH, journald is not enough — and Promtail
can read journald directly, so you centralise without touching the apps.

## When grep on a few servers is genuinely enough

Under five boxes and a small team, a well-organised `grep` over SSH is a real
strategy, not a phase you grow out of. `ansible all -i inv -m shell -a 'grep -c
ERROR /var/log/app.log'` answers "is anything erroring?" in seconds with zero new
infrastructure. The break points are specific:

- you need to **correlate** across services or hosts in one view;
- someone without SSH access needs to read logs;
- retention must exceed local disk;
- you want to **alert on a pattern** ("5xx rate above 1% for 5 minutes");
- you want `rate()` and quantiles from the same data you grep.

Cross the first two and a single Loki container on a $5 VPS is the cheapest step
up. Below them, `grep` is genuinely the right tool and Loki is overhead.

## Wrapping up

**Grafana Loki** is not trying to be Elasticsearch. It is trying to be the
cheapest way to answer "what is happening in my logs right now", by indexing
labels instead of full text, compressing chunks onto object storage, and reusing
the Prometheus model you already have in your head. Label with low-cardinality
fields only, keep interesting values in the line and filter them with LogQL,
alert on stream count as well as log rate, and set retention in the schema plus
compactor. Start there and Loki stays boring — the highest compliment I can pay
a logging stack.

---

*Also in this series: [Structured logging that actually helps you debug at
3am](/posts/structured-logging/) and [Prometheus in
practice](/posts/prometheus-in-practice/).*
