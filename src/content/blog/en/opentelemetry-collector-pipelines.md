---
title: "The OpenTelemetry Collector: Your Pipeline Between App and Backend"
description: "How the OpenTelemetry Collector decouples apps from backends via receivers, processors, and exporters — with real OTLP output from a throwaway container."
pubDate: 2027-02-03
lang: en
translationKey: opentelemetry-collector-pipelines
tags: [devops, self-hosting]
featured: false
keywords:
  - OpenTelemetry Collector
  - OTLP
  - collector pipeline
  - receivers processors exporters
  - tail sampling
---

If you've read my post on [OpenTelemetry tracing](/posts/opentelemetry-tracing/), you know how to instrument an app to emit spans. But those spans have to go *somewhere*. That "somewhere" is usually not your application's code — it's a separate piece of infrastructure called the **OpenTelemetry Collector**. This post is about what the Collector does, how its pipeline model works, and when you actually need one.

## Why a Collector Exists

Without a Collector, every application would need to know how to talk to every backend: Jaeger's API, Prometheus's remote-write, Loki's push endpoint, Honeycomb's key, Datadog's agent. Change backends and you re-instrument every service. That's a vendor lock-in nightmare.

The Collector inverts that. Your apps speak **OTLP** (OpenTelemetry Protocol) — one protocol, one SDK call — and the Collector translates to whatever backend you use today. Switch from Jaeger to Tempo? Change one config file, redeploy one binary, zero app changes.

Two deployment patterns exist:

- **Agent**: one Collector per host, scraping local apps. Like a local syslog daemon.
- **Gateway**: a central fleet of Collectors receiving OTLP from all agents, doing heavy processing (tail sampling, enrichment) once.

For a self-hoster running a handful of services, agent mode on each box is plenty.

## The Pipeline Model: Receivers → Processors → Exporters

The Collector's config is built from three component types connected by named pipelines:

```yaml
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch, attributes]
      exporters: [debug]
    metrics:
      receivers: [otlp, prometheus]
      processors: [memory_limiter, batch]
      exporters: [debug]
```

Each signal type (traces, metrics, logs) gets its own pipeline. A receiver feeds data in, processors transform it, exporters ship it out. Components are referenced by name — the same `otlp` receiver can feed both traces and metrics pipelines.

<figure>
  <svg viewBox="0 0 720 180" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Collector pipeline diagram">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/>
      </marker>
    </defs>
    <g font-family="ui-monospace, monospace" font-size="12">
      <!-- Receivers -->
      <rect x="20" y="60" width="120" height="60" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="80" y="85" text-anchor="middle" fill="currentColor">Receivers</text>
      <text x="80" y="103" text-anchor="middle" fill="#0f766e" font-size="10">otlp · prometheus</text>
      <!-- Arrow 1 -->
      <line x1="140" y1="90" x2="180" y2="90" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)"/>
      <!-- Processors -->
      <rect x="180" y="60" width="120" height="60" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="240" y="85" text-anchor="middle" fill="currentColor">Processors</text>
      <text x="240" y="103" text-anchor="middle" fill="#0f766e" font-size="10">batch · attributes</text>
      <!-- Arrow 2 -->
      <line x1="300" y1="90" x2="340" y2="90" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)"/>
      <!-- Exporters -->
      <rect x="340" y="60" width="120" height="60" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="400" y="85" text-anchor="middle" fill="currentColor">Exporters</text>
      <text x="400" y="103" text-anchor="middle" fill="#0f766e" font-size="10">otlp · debug · loki</text>
      <!-- Signal labels -->
      <text x="80" y="40" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.7">OTLP/gRPC</text>
      <text x="240" y="40" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.7">memory_limiter</text>
      <text x="400" y="40" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.7">backend</text>
    </g>
  </svg>
  <figcaption>FIG. 1 — A traces pipeline: OTLP in, processed, shipped to a backend.</figcaption>
</figure>

## Receivers: Getting Data In

Receivers listen for incoming telemetry. The two you'll actually use:

- **`otlp`** — accepts OTLP over gRPC (port 4317) and HTTP (port 4318). This is what your instrumented apps send to. Supports protobuf and JSON encoding.
- **`prometheus`** — scrapes Prometheus-format endpoints. Useful for existing exporters you don't want to rewrite.

Here's the receiver config from my test container:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
  prometheus:
    config:
      scrape_configs:
        - job_name: 'otel-collector'
          scrape_interval: 5s
          static_configs:
            - targets: ['127.0.0.1:8888']
```

I sent a real trace via OTLP/HTTP JSON:

```bash
curl -s -X POST http://127.0.0.1:4318/v1/traces \
  -H "Content-Type: application/json" \
  -d @trace.json
# Response: {"partialSuccess":{}}
```

## Processors: Transforming Data

Processors sit between receivers and exporters. The ones that matter:

### memory_limiter

Checks memory usage before every other processor. If you're near the limit, it drops data rather than OOM-killing the Collector. Always put it first:

```yaml
processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 100
    spike_limit_mib: 20
```

The Collector logged it at startup:

```
2026-10-14T04:31:49.205Z  info  memorylimiter@v0.162.0/memorylimiter.go:109
  Memory limiter configured  {"limit_mib": 100, "spike_limit_mib": 20, "check_interval": 1}
```

### batch

Buffers telemetry and sends it in batches instead of one request per span. Dramatically reduces CPU and network overhead:

```yaml
processors:
  batch:
    send_batch_size: 512
    timeout: 5s
```

You can see the batch processor at work in the Collector's own metrics:

```
otelcol_processor_batch_batch_send_size_count{processor="batch"} 7
otelcol_processor_batch_batch_send_size_sum{processor="batch"} 141
```

### attributes

Inserts, updates, or deletes attributes on telemetry. I used it to tag every span with an environment:

```yaml
processors:
  attributes:
    actions:
      - key: environment
        value: dev
        action: insert
      - key: dropped_field
        action: delete
```

The debug exporter printed the span with `environment: dev` added — proof the processor ran:

```
Span #0
    Name           : test-operation
    ...
Attributes:
     -> http.method: Str(GET)
     -> http.status_code: Int(200)
     -> environment: Str(dev)
```

### filter

Drops telemetry matching a condition. I configured it to exclude the Collector's own uptime and CPU metrics from the output:

```yaml
processors:
  filter/metrics:
    metrics:
      exclude:
        match_type: strict
        metric_names:
          - otelcol_process_uptime
          - otelcol_process_cpu_seconds
```

The filter processor logged its config and the debug output confirmed those metrics were gone — `otelcol_process_memory_rss` and `scrape_samples_scraped` were there, but not the two I excluded.

### tail_sampling

The most sophisticated processor. It waits until a trace is *complete* before deciding whether to keep it. This lets you keep 100% of errors and slow requests while sampling only 1% of routine traffic:

```yaml
processors:
  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    expected_new_traces_per_sec: 10000
    policies:
      - name: keep-errors
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: sample-1-percent
        type: probabilistic
        probabilistic:
          sampling_percentage: 1
```

For a self-hoster, `tail_sampling` is probably overkill — but it's the answer to "how do I get full traces for interesting requests without drowning in data."

## Exporters: Shipping Data Out

Exporters send telemetry to backends. The ones worth knowing:

- **`otlp`** — forwards OTLP to another Collector or directly to a backend that speaks OTLP (Tempo, Jaeger with OTLP support).
- **`debug`** — prints telemetry to the Collector's logs. Invaluable during setup, useless in production.
- **`prometheusremotewrite`** — pushes metrics to Prometheus-compatible backends (Mimir, Cortex, VictoriaMetrics).
- **`loki`** — pushes logs to Loki.

A typical self-hosted setup might look like:

```yaml
exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  prometheusremotewrite:
    endpoint: http://victoria:8428/api/v1/write
```

## The Collector's Own Metrics

The Collector exposes Prometheus metrics at `:8888/metrics` — how many spans it received, processed, and sent, plus its own memory and CPU usage:

```
otelcol_receiver_accepted_spans{receiver="otlp",transport="http"} 1
otelcol_exporter_sent_spans{exporter="debug"} 1
otelcol_process_memory_rss 2.1272576e+08
otelcol_process_uptime 54.007314091
```

These tell you if the Collector is healthy, backed up, or dropping data. The Prometheus receiver in my config scraped this endpoint every 5 seconds — the Collector monitoring itself.

## Agent vs Gateway

**Agent mode** runs one Collector per host, usually as a sidecar or systemd service. It's simple: apps on that host send OTLP locally, the agent forwards to the backend. This is what I'd recommend for self-hosting.

**Gateway mode** runs a centralized fleet. Agents forward OTLP to the gateway, which does heavy processing (tail sampling, consistent hashing for routing). You need this when you have dozens of services and want to centralize decisions.

For one server and a few containers? Agent mode on that server. Done.

## Config Validation

The Collector validates config at startup and on `--config ... validate`. A bad config fails fast:

```bash
$ otelcol-contrib --config bad-config.yaml validate
Error: service::pipelines::traces: references processor "memory_limiter" which is not configured
Exited with code 1
```

Always validate before deploying a config change.

## Honest Advice

The Collector is powerful but it's *another thing to run*. If you have one app and one backend, you might skip it entirely — point your SDK at the backend directly. If you have multiple apps, want to switch backends later, or need tail sampling, the Collector pays for itself immediately.

For self-hosting: run one agent per host with `memory_limiter` → `batch` → your exporter. That's it. You get protocol decoupling, batched shipping, and the flexibility to change backends without touching app code. That's the whole point.

My [structured logging](/posts/structured-logging/) setup can ship logs through the same Collector — one pipeline for traces, one for metrics, one for logs, all configured in one YAML file. One process, three signals, zero app changes when you switch backends.

The Collector doesn't make telemetry *good* — it makes it *portable*. The quality comes from how you instrument, which I covered in my [OpenTelemetry tracing](/posts/opentelemetry-tracing/) post. But without the Collector, your telemetry is locked to whatever backend you chose on day one. With it, you can change your mind tomorrow for the price of a config edit.
