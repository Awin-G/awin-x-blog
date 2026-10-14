---
title: "OpenTelemetry metrics and exemplars: from a spike to the trace that caused it"
description: "Counters, gauges, and histograms; what an OTLP histogram becomes in Prometheus (_bucket/_sum/_count); why delta temporality silently freezes a counter; and exemplars — a metric sample carrying a trace_id. Real collector and PromQL output."
pubDate: 2027-02-10
lang: en
translationKey: opentelemetry-metrics-and-exemplars
tags: [devops, self-hosting]
featured: false
keywords:
  - OpenTelemetry metrics
  - exemplars
  - histogram vs summary
  - prometheusremotewrite
  - delta temporality
---

A p99 latency graph for `/checkout` went vertical and I could not tell you *which request* did it. Metrics are good at telling me **that** something is slow and **how many** things are slow. They are structurally bad at telling me **which one**. That last hop — from "the number went up" to "here is the span" — is what **exemplars** exist to close.

I stood up a throwaway OpenTelemetry Collector, a throwaway Prometheus, and a throwaway Jaeger, sent a real OTLP histogram with explicit buckets, and pasted the raw output below. Where something did not work the way I expected, I say so.

## What I actually ran

Three containers, all on `127.0.0.1`, official images: `otel/opentelemetry-collector-contrib:0.162.0`, `prom/prometheus:3.15.0`, `jaegertracing/all-in-one`.

```console
$ docker run -d --name otelcol --network otelnet \
    -p 127.0.0.1:4317:4317 -p 127.0.0.1:4318:4318 -p 127.0.0.1:8889:8889 \
    -v $PWD/otelcol.yaml:/etc/otelcol/config.yaml \
    otel/opentelemetry-collector-contrib:latest --config=/etc/otelcol/config.yaml

$ docker run -d --name prom --network otelnet -p 127.0.0.1:19091:9090 \
    -v $PWD/prometheus.yml:/etc/prometheus/prometheus.yml \
    prom/prometheus:latest --config.file=/etc/prometheus/prometheus.yml \
    --enable-feature=exemplar-storage
```

The collector config is deliberately small — one `otlp` receiver, a `prometheus` exporter on `:8889`, and a `debug` exporter so I can see what arrived before it is translated:

```yaml
receivers:
  otlp:
    protocols:
      http: { endpoint: 0.0.0.0:4318 }
processors:
  memory_limiter: { check_interval: 1s, limit_mib: 256, spike_limit_mib: 64 }
  batch: { send_batch_size: 512, timeout: 1s }
exporters:
  debug: { verbosity: detailed }
  prometheus:
    endpoint: 0.0.0.0:8889
    send_timestamps: true
    enable_open_metrics: true
service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug, prometheus]
```

If receivers/processors/exporters still feel like ceremony, I wrote the pipeline model up in [The OpenTelemetry Collector](/posts/opentelemetry-collector-pipelines/). Here I care only about what happens to a *metric*.

## The three instruments that matter

OpenTelemetry has a handful of metric instruments, but three carry almost all the weight:

| Instrument | What it is | Use it for | In PromQL |
| --- | --- | --- | --- |
| **Counter** | monotonic sum | requests, bytes, errors, jobs run | `rate()` / `increase()` |
| **Gauge** | a value right now | queue depth, open connections, cache size, temperature | raw value; `avg_over_time()` |
| **Histogram** | a distribution in buckets | latency, payload size, rows returned | `histogram_quantile()` |

The rule I use: **if the only thing that can happen to the number is "it goes up", it is a counter.** Counters are cheap to store and easy to reason about, because `rate()` makes them traffic-independent. Do not make a counter a gauge just because you also want the current value — `increase()` gives you that.

**Gauges** are for quantities that go down as well as up. The trap is `rate()` over a gauge, which is meaningless: a queue depth oscillating between 3 and 8 is not "5 units per second of queue".

**Histograms** are the interesting one, and the rest of this post is mostly about them. Use a histogram whenever the question is "how slow, for whom" rather than "how slow on average". Latency is a long-tailed distribution; a mean destroys exactly the information you need.

There is also `UpDownCounter` (for in-flight requests), and OTel **exponential histograms**, which map onto Prometheus native histograms — not tested here.

## From an OTLP histogram to `_bucket`/`_sum`/`_count`

Here is the metric I actually posted to `http://127.0.0.1:4318/v1/metrics` (OTLP/HTTP, JSON encoding), trimmed to the histogram. Note the `explicitBounds` and the `bucketCounts` array, which is one longer than the bounds — the last count is the `+Inf` overflow bucket:

```json
{
  "name": "http.server.request.duration",
  "unit": "ms",
  "histogram": {
    "aggregationTemporality": 2,
    "dataPoints": [{
      "attributes": [{ "key": "http.route", "value": { "stringValue": "/checkout" } }],
      "count": "6", "sum": 391.0, "min": 3.0, "max": 180.0,
      "bucketCounts": ["2", "2", "1", "1", "0"],
      "explicitBounds": [10.0, 25.0, 50.0, 100.0],
      "exemplars": [{
        "timeUnixNano": "1791959284359035552",
        "asDouble": 180.0,
        "spanId": "00f067aa0ba902b7",
        "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
      }]
    }]
  }
}
```

The collector's `debug` exporter confirms what arrived — and note it already shows the exemplar:

```text
Metric #1
Descriptor:
     -> Name: http.server.request.duration
     -> Unit: ms
     -> DataType: Histogram
     -> AggregationTemporality: Cumulative
HistogramDataPoints #0
Data point attributes:
     -> http.route: Str(/checkout)
Count: 6
Sum: 391.000000
Min: 3.000000
Max: 180.000000
ExplicitBounds #0: 10.000000
ExplicitBounds #1: 25.000000
ExplicitBounds #2: 50.000000
ExplicitBounds #3: 100.000000
Buckets #0, Count: 2
Buckets #1, Count: 2
Buckets #2, Count: 1
Buckets #3, Count: 1
Buckets #4, Count: 0
Exemplars:
Exemplar #0
     -> Trace ID: 4bf92f3577b34da6a3ce929d0e0e4736
     -> Span ID: 00f067aa0ba902b7
     -> Value: 180.000000
     -> FilteredAttributes:
          -> http.route: Str(/checkout)
```

Now the Prometheus exposition from `curl http://127.0.0.1:8889/metrics`:

```text
# HELP http_server_request_duration_milliseconds HTTP request duration
# TYPE http_server_request_duration_milliseconds histogram
http_server_request_duration_milliseconds_bucket{http_route="/checkout",le="10"} 2
http_server_request_duration_milliseconds_bucket{http_route="/checkout",le="25"} 4
http_server_request_duration_milliseconds_bucket{http_route="/checkout",le="50"} 5
http_server_request_duration_milliseconds_bucket{http_route="/checkout",le="100"} 6
http_server_request_duration_milliseconds_bucket{http_route="/checkout",le="+Inf"} 6
http_server_request_duration_milliseconds_sum{http_route="/checkout"} 391
http_server_request_duration_milliseconds_count{http_route="/checkout"} 6
```

(Real output carries extra labels — `job`, `otel_scope_name`, `otel_scope_version` — and a timestamp, because I set `send_timestamps: true`. Trimmed for width.)

Three things to notice, because all three surprise people:

1. **The name changed.** Dots became underscores, and the unit `ms` was appended as `_milliseconds`. Your dashboard query is `http_server_request_duration_milliseconds_bucket`, not `http.server.request.duration`.
2. **The buckets are cumulative.** `le="25"` is 4, which *includes* the 2 requests under 10 ms. The `+Inf` bucket always equals `_count`.
3. **`_sum` and `_count` are free.** The histogram carries them, so you get the mean *and* the distribution from one instrument.

That is the whole translation: OTel histograms are Prometheus histograms, because Prometheus histograms are the only widely-supported aggregatable distribution primitive there is.

## Histogram vs summary, honestly

Prometheus has a second distribution type: the **summary**. It computes quantiles *client-side* and exports them as `_count`, `_sum`, and `{quantile="0.5"}`, `{quantile="0.95"}` series.

Summaries are tempting because the quantiles are exact and free. They are also a trap:

- **Summary quantiles cannot be aggregated.** You cannot add two p95s, and you cannot average them either. Ten instances each exporting a p95 give you no fleet-wide p95 — the data needed was thrown away at the client.
- **A histogram's bucket boundaries are fixed at instrument creation.** It is worse *per-instance* (interpolation error inside a bucket) but aggregatable *across* instances, which is the case you actually have.

This is why OpenTelemetry has no summary instrument at all: **aggregatability beats per-instance precision.** A fleet-wide p95 that is 3% off is useful; ten exact per-instance p95s are not.

Here is the same data answering the two questions, in Prometheus 3.15:

```promql
# fleet-wide p95, computed from the buckets
histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_milliseconds_bucket[2m])))
# -> 97.5

# request rate
sum(rate(http_server_request_duration_milliseconds_count[2m]))
# -> 0.1333

# the "average" latency everyone asks for
sum(rate(http_server_request_duration_milliseconds_sum[2m]))
  / sum(rate(http_server_request_duration_milliseconds_count[2m]))
# -> 103.5
```

Look at the last two numbers. The mean latency was **103.5 ms** while the p95 was **97.5 ms** — the average is *worse than* the 95th percentile, because a handful of 180 ms requests drag it up. With only the average you would conclude "the endpoint is a bit slow" when the truth is "95% of requests are under 100 ms and a small tail is not". Use histograms, not averages — and if you must pick one number, pick an agreed percentile.

## Delta vs cumulative: the gotcha that freezes your counter

Every OTel sum and histogram carries an **aggregation temporality**. `Cumulative` means "total since the process started". `Delta` means "what happened since the last report".

Prometheus is a pull system and its counters are cumulative by definition. So what happens when a delta-temporality sum reaches a `prometheus` exporter? I sent the same delta batch (`+10`) four times and scraped between each:

```text
after delta batch 1 -> jobs_processed_fixed_total{job="checkout-api",...} 10
after delta batch 2 -> jobs_processed_fixed_total{job="checkout-api",...} 10
after delta batch 3 -> jobs_processed_fixed_total{job="checkout-api",...} 10
after delta batch 4 -> jobs_processed_fixed_total{job="checkout-api",...} 10
```

Forty jobs were processed and the counter never moved. The exporter wrote each delta straight into the `_total` series, so the counter is pinned at one interval's worth of work. `rate()` over it returns the *delta* divided by the scrape interval — which looks plausible, which is what makes this so nasty. The collector logs confirm the input really was delta:

```text
     -> Name: jobs.processed.fixed
     -> DataType: Sum
     -> IsMonotonic: true
     -> AggregationTemporality: Delta
```

The fix is a processor: `deltatocumulative` accumulates deltas into cumulative counters before the exporter sees them.

```yaml
processors:
  deltatocumulative:
    max_stale: 5m
service:
  pipelines:
    metrics:
      processors: [memory_limiter, deltatocumulative, batch]
```

Same four batches, same collector, one extra processor:

```text
after delta batch 1 -> jobs_processed_fixed_total{job="checkout-api",...} 10
after delta batch 2 -> jobs_processed_fixed_total{job="checkout-api",...} 20
after delta batch 3 -> jobs_processed_fixed_total{job="checkout-api",...} 30
after delta batch 4 -> jobs_processed_fixed_total{job="checkout-api",...} 40
```

Why does this bite in practice? The *default* temporality differs between OTel SDKs and between exporter types, so a pipeline that behaves for one service can silently misreport another. Check what your SDK actually exports (`Cumulative` in the debug output is your proof), and put `deltatocumulative` in the metrics pipeline whenever anything upstream might send deltas. The inverse processor, `cumulativetodelta`, exists for TSDBs that want deltas.

## Exemplars: a metric sample that carries a `trace_id`

Now the payoff. An **exemplar** is an optional annotation attached to a *single observation* inside a histogram or counter: the observed value plus the `trace_id` and `span_id` of the request that produced it. It never participates in aggregation, it does not affect `_count` or `_sum`, and it is discarded after a retention window. It is a pointer.

<figure>
  <svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A histogram bucket carrying an exemplar that links to the trace that produced it">
    <defs>
      <marker id="exarrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#0f766e"/>
      </marker>
    </defs>
    <g font-family="ui-monospace, monospace" font-size="11" fill="currentColor">
      <line x1="30" y1="196" x2="336" y2="196" stroke="currentColor" stroke-width="1"/>
      <line x1="30" y1="196" x2="30" y2="54" stroke="currentColor" stroke-width="1"/>
      <rect x="44"  y="140" width="44" height="56"  fill="currentColor" opacity="0.16" stroke="currentColor"/>
      <rect x="98"  y="140" width="44" height="56"  fill="currentColor" opacity="0.16" stroke="currentColor"/>
      <rect x="152" y="168" width="44" height="28"  fill="currentColor" opacity="0.16" stroke="currentColor"/>
      <rect x="206" y="168" width="44" height="28"  fill="currentColor" opacity="0.16" stroke="currentColor"/>
      <rect x="260" y="86"  width="44" height="110" fill="#0f766e" opacity="0.20" stroke="#0f766e" stroke-width="1.5"/>
      <circle cx="282" cy="78" r="4.5" fill="#0f766e"/>
      <text x="66"  y="212" text-anchor="middle">10</text>
      <text x="120" y="212" text-anchor="middle">25</text>
      <text x="174" y="212" text-anchor="middle">50</text>
      <text x="228" y="212" text-anchor="middle">100</text>
      <text x="282" y="212" text-anchor="middle">+Inf</text>
      <text x="30" y="46">count</text>
      <text x="282" y="68" text-anchor="middle" fill="#0f766e">exemplar</text>
      <path d="M 296 78 C 350 78, 372 104, 408 112" fill="none" stroke="#0f766e" stroke-width="1.5"
            stroke-dasharray="4 3" marker-end="url(#exarrow)"/>
      <text x="410" y="62">trace_id = 4bf92f35…e4736</text>
      <rect x="410" y="100" width="272" height="24" rx="3" fill="#0f766e" opacity="0.20" stroke="#0f766e"/>
      <text x="420" y="116">GET /checkout            3.90 s</text>
      <rect x="430" y="132" width="72" height="20" rx="3" fill="currentColor" opacity="0.16" stroke="currentColor"/>
      <text x="438" y="146">db.query</text>
      <text x="410" y="178" opacity="0.75">the same request, as a span</text>
    </g>
  </svg>
  <figcaption>FIG. 1 — The last bucket carries an exemplar: the observed value plus the <code>trace_id</code> of the request that produced it. Follow the id and you land on the exact span.</figcaption>
</figure>

I attached an exemplar to the 180 ms observation in the payload at the top, and it survived all the way to the scrape endpoint — but only under a specific set of conditions, which I had to discover the hard way.

**First, the exporter must be allowed to speak OpenMetrics.** With `enable_open_metrics: false`, even a client that explicitly asks for OpenMetrics gets the classic format:

```console
$ curl -s -D- -o /dev/null -H 'Accept: application/openmetrics-text; version=1.0.0' \
    http://127.0.0.1:8889/metrics | grep -i content-type
Content-Type: text/plain; version=0.0.4; charset=utf-8; escaping=underscores
```

**Second, the scraper must negotiate.** With `enable_open_metrics: true`, the same URL returns classic text when you just `curl` it, and OpenMetrics when you ask:

```console
$ curl -s -H 'Accept: application/openmetrics-text; version=1.0.0' \
    http://127.0.0.1:8889/metrics | grep -E 'le="\+Inf"'
http_server_request_duration_milliseconds_bucket{http_route="/checkout",...,le="+Inf"} 6 1.791959284359e+09 # {trace_id="4bf92f3577b34da6a3ce929d0e0e4736",span_id="00f067aa0ba902b7"} 180.0 1.7919592843590355e+09
```

There it is: the sample line, then `# {trace_id="…",span_id="…"} 180.0 <timestamp>` appended as an exemplar comment. In the Prometheus text format the same scrape has no exemplar at all. **If your scrape format is `text/plain`, you have no exemplars and no error telling you so.**

**Third, Prometheus has to be told to keep them.** Prometheus 3.15 returned an empty list from `query_exemplars` until I restarted it with the feature flag:

```console
$ docker run -d --name prom ... prom/prometheus:latest \
    --config.file=/etc/prometheus/prometheus.yml --enable-feature=exemplar-storage
```

After that the exemplar is queryable through the API:

```console
$ curl -s --get --data-urlencode 'query=http_server_request_duration_milliseconds_bucket' \
    --data-urlencode "start=$(date -d '-10 min' +%s)" --data-urlencode "end=$(date +%s)" \
    http://127.0.0.1:19091/api/v1/query_exemplars
```

```text
series: http_server_request_duration_milliseconds_bucket le=+Inf
  exemplar: {'span_id': '00f067aa0ba902b7', 'trace_id': '4bf92f3577b34da6a3ce929d0e0e4736'} value=180
```

And now the hop that justifies the feature. I also sent a span with that exact `trace_id` through the collector's trace pipeline to Jaeger, and asked Jaeger for it:

```console
$ curl -s http://127.0.0.1:16686/api/traces/4bf92f3577b34da6a3ce929d0e0e4736
```

```text
traceID: 4bf92f3577b34da6a3ce929d0e0e4736
  spanID: 00f067aa0ba902b7 | op: GET /checkout | dur: 3900000 us
  service: checkout-api
  tags: {'http.request.method': 'GET', 'url.path': '/checkout',
         'http.response.status_code': 200, 'db.system': 'postgresql',
         'otel.status_code': 'OK', 'span.kind': 'server'}
```

The spike, the exemplar, and the span all agree: a 180 ms observation in the `(100, +Inf]` bucket, produced by a request that took 3.9 s end-to-end. In a real UI this is one click: hover the spike, click the exemplar, land on the trace. The metric told you *that* and *how many*; the exemplar told you *which*.

Two caveats. Exemplars only exist if traces do — if you have not set up tracing yet, [start there](/posts/opentelemetry-tracing/). And they are per-observation, so a distribution is what makes them interesting; a counter can carry one too, but "the 137th request" is less useful than "the 180 ms one".

## What the collector is doing in all this

I covered the pipeline model [elsewhere](/posts/opentelemetry-collector-pipelines/), so just the metrics-specific parts:

**`prometheus` receiver** — pulls existing Prometheus endpoints into OTel. I pointed it at Prometheus's own `/metrics` and it ingested **518 series** in one scrape; the exposition shows the provenance:

```text
prometheus_build_info{branch="HEAD",goarch="amd64",...,instance="prom:9090",job="prometheus-itself",
  otel_scope_name="github.com/open-telemetry/opentelemetry-collector-contrib/receiver/prometheusreceiver",...} 1
```

That is the migration path: point the receiver at your existing exporters, then run everything through one pipeline.

**`prometheus` exporter vs `prometheusremotewrite`** — the exporter is the pull path I used: the collector holds the data, Prometheus scrapes it. `prometheusremotewrite` is the push path, for backends that do not scrape (Mimir, Thanos, VictoriaMetrics, a hosted Prometheus). Push is what you want at scale, but I did not test exemplars over remote write here — whether they survive depends on the protocol version and the backend, so verify it before relying on it.

**`memory_limiter` and `batch`** — metrics arrive in bursts and the collector will happily buffer itself to death. `memory_limiter` first in every pipeline, `batch` after it. This is the most common cause of a collector OOM.

**Cardinality control.** I sent one counter with five datapoints, each carrying a unique `user.id`:

```text
cache_misses_total{...,user_id="u0"} 1
cache_misses_total{...,user_id="u1"} 1
cache_misses_total{...,user_id="u2"} 1
cache_misses_total{...,user_id="u3"} 1
cache_misses_total{...,user_id="u4"} 1
```

Five series from five requests. At real traffic that is unbounded — one series per user, per endpoint, per status code. A `transform` processor can strip the label before it reaches the backend:

```yaml
processors:
  transform:
    metric_statements:
      - context: datapoint
        statements:
          - delete_key(attributes, "user.id")
```

```text
cache_misses_total{job="api",...} 5
```

One series instead of five. But be honest about what just happened: the value shown is **one of the five datapoints (the last one), not the sum**. `delete_key` merges *identity*; it does not aggregate. When I sent values 1 through 5, the surviving series read `5`, not `15`. If you need the sum, drop the label at the SDK (a metric *view*), or aggregate deliberately — never assume the collector did arithmetic for you.

## What I'd actually do

- **Instrument RED, not everything.** Per service: **R**ate, **E**rrors, **D**uration — a counter for requests, a counter for errors, a histogram for duration. Per host: **U**tilization, **S**aturation, **E**rrors. Those answer most incidents; the other two hundred metrics mostly cost money.
- **Histograms, not averages, not summaries.** A mean of a long tail describes nobody (103.5 ms vs 97.5 ms above). A summary cannot be aggregated across instances.
- **Assume delta temporality will find you.** Check the debug output; put `deltatocumulative` in the pipeline. The failure mode is a frozen counter, not an error.
- **Cardinality is a budget.** `user.id`, `request.id`, raw `url.path`, anything UUID-shaped must not be a label. Strip centrally with `transform`.
- **Exemplars are the cheapest win here.** Three things must line up (OpenMetrics on the exporter, OpenMetrics in the scrape, exemplar storage in Prometheus), and then every latency spike becomes clickable. If traces already flow, turn them on.

Metrics are the pillar that tells you where to look. Exemplars make "where to look" a link instead of a search.
