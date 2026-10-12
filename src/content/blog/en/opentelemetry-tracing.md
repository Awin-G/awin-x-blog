---
title: "Tracing explained: OpenTelemetry without the ceremony"
description: "The three pillars, where distributed tracing actually helps, the vocabulary (trace, span, trace context, attributes, sampling), and a minimal OpenTelemetry setup — instrumented app, OTLP export, Jaeger backend — with real spans, a real traceparent header, and measured sampling output."
pubDate: 2026-12-12
lang: en
translationKey: opentelemetry-tracing
tags: [devops, self-hosting]
featured: false
keywords:
  - OpenTelemetry
  - distributed tracing
  - Jaeger
  - trace context
  - OTLP
---

A request comes in, three services touch it, and the user says it was slow. You
look at logs on box A, they look fine. Metrics say p99 is up but not *why*. So
you start guessing. This is the exact question **distributed tracing** exists to
answer: for one request, across every hop, where did the time go? And
**OpenTelemetry** is the standard that made collecting that answer boring enough
to actually do. This post is the no-ceremony version: I stood up a throwaway
Jaeger, sent it real spans with `curl` and with the SDK, and pasted the raw
output below.

## The three pillars, and the one question tracing answers

Observability is usually drawn as three pillars: **logs**, **metrics**, and
**traces**. They are not competitors; they answer different questions.

| Pillar | Answers | Cost model |
| --- | --- | --- |
| Metrics | "Is it bad *right now*, and how many?" | cheap, aggregated, no per-request detail |
| Logs | "What *happened* in this code path?" | volume grows with traffic |
| **Traces** | "Which hop was slow for *this* request?" | per-request, sampled |

Metrics tell you the API is slow. Traces tell you it is slow because
`payment-service` took 50ms and the SQL insert inside it took 30ms of that. Logs
can tell you too — if you already know where to look and you paid for the log
volume. That last mile, "**which hop is slow**", is where tracing earns its keep.
It is the one pillar where a picture of a single request beats a thousand
aggregated numbers.

## The vocabulary, in the order you will meet it

**Trace** — the whole story of one request, from the edge to the last service.
Every span in it shares one **trace id** (32 hex chars). In my run below the
trace id was `714d9c1fe324840626692e57028ee06c`.

**Span** — one unit of work: an HTTP handler, a DB query, a function you chose to
time. A span has a name, a start, a duration, a **span id** (16 hex chars), and a
pointer to its parent span. That parent link is what turns a pile of spans into a
tree.

**Trace context** — the small bag of ids (trace id, span id, flags) that gets
carried *between* services. This is the part people underestimate. Everything is
easy until the request leaves your process.

**Attributes** — key/value metadata on a span: `http.request.method`,
`http.response.status_code`, `db.system`. Use the standard
[semantic conventions](https://opentelemetry.io/docs/specs/semconv/) so your
dashboards survive a language change; the names are boring on purpose.

**Sampling** — deciding, up front, whether a given trace is recorded at all.
Ideally the decision is made once at the root and inherited, so a trace is either
whole or absent, never half-captured.

<figure>
<svg viewBox="0 0 720 210" width="100%" role="img" aria-label="One trace spanning three services. frontend handles GET /cart at the root; it calls checkout-api's POST /checkout, which calls SELECT carts and then an HTTP client span to payment-service; payment-service runs POST /charge which contains an INSERT payments span. Each span is drawn as a bar whose length is its duration, so the bottom-most bar shows where the time went.">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11">
    <text x="10" y="18" font-size="13" font-weight="600">One trace, three services (bars = duration)</text>

    <text x="10" y="52" opacity="0.85">frontend</text>
    <rect x="120" y="40" width="420" height="18" rx="3" fill="#0f766e" opacity="0.85"/>
    <text x="130" y="53" fill="#ffffff" font-size="10">GET /cart</text>

    <text x="10" y="84" opacity="0.85">checkout-api</text>
    <rect x="150" y="72" width="370" height="18" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="160" y="85" font-size="10">POST /checkout</text>
    <rect x="165" y="94" width="70" height="14" rx="2" fill="none" stroke="currentColor" stroke-dasharray="3 2"/>
    <text x="240" y="105" font-size="9" opacity="0.8">SELECT carts</text>
    <rect x="255" y="112" width="230" height="14" rx="2" fill="none" stroke="currentColor" stroke-dasharray="3 2"/>
    <text x="490" y="123" font-size="9" opacity="0.8">HTTP POST /charge</text>

    <text x="10" y="146" opacity="0.85">payment-service</text>
    <rect x="270" y="134" width="205" height="18" rx="3" fill="#0f766e" opacity="0.6"/>
    <text x="280" y="147" font-size="10">POST /charge</text>
    <rect x="285" y="156" width="150" height="14" rx="2" fill="#0f766e" opacity="0.35"/>
    <text x="440" y="167" font-size="9">INSERT payments</text>

    <line x1="120" y1="30" x2="120" y2="182" stroke="currentColor" stroke-width="1" opacity="0.4"/>
    <text x="120" y="196" text-anchor="middle" opacity="0.75">0ms</text>
    <line x1="540" y1="30" x2="540" y2="182" stroke="currentColor" stroke-width="1" opacity="0.4"/>
    <text x="540" y="196" text-anchor="middle" opacity="0.75">~105ms</text>
  </g>
</svg>
<figcaption>Six spans, one trace id. The bottom-most bars are where the milliseconds went: the payment insert is inside the payment call, which is inside checkout, which is inside the page load. That nesting is the entire value of a trace.</figcaption>
</figure>

## OpenTelemetry is the standard, not the backend

**OpenTelemetry** (OTel) is a vendor-neutral spec plus SDKs plus a wire protocol.
It has three pieces, and conflating them is the usual source of confusion:

- **API + SDK** — what you instrument against, in your language.
- **OTLP** — the OpenTelemetry Protocol, the format spans travel in. OTLP has
  two encodings, gRPC (port 4317) and HTTP/protobuf or HTTP/JSON (port 4318).
- **A backend** — where spans land and get displayed: **Jaeger**, Grafana Tempo,
  or a commercial tool. OTel does not include one, deliberately.

The payoff is that switching backends is a config change, and instrumenting one
service is the same shape regardless of language.

## A minimal setup: what a real span looks like

I started a throwaway backend. Jaeger all-in-one accepts OTLP directly, so
there is nothing else to run:

```bash
docker run -d --name otel-jaeger \
  -p 127.0.0.1:16686:16686 \
  -p 127.0.0.1:4318:4318 \
  -p 127.0.0.1:4317:4317 \
  jaegertracing/all-in-one:latest
```

You do not even need an SDK to prove the pipe works. OTLP/HTTP takes JSON, so
`curl` can send one hand-written span and Jaeger will render it:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST http://127.0.0.1:4318/v1/traces \
  -H "Content-Type: application/json" \
  --data @curl-span.json
# 200
```

```json
{
  "data": ["checkout-api"],
  "total": 1,
  "limit": 0,
  "offset": 0,
  "errors": null
}
```

That `200` is the whole first milestone: your app's span would take the exact
same path. Now the interesting version — a real **distributed tracing** run. I
wrote three small Python services (`frontend`, `checkout-api`,
`payment-service`), each with its own `TracerProvider` exporting to OTLP over
HTTP, and ran one request end to end:

```python
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider(resource=Resource.create({"service.name": "checkout-api"}))
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint="http://127.0.0.1:4318/v1/traces"))
)
```

Then I asked Jaeger what it had. `/api/services` is the honest check that
spans arrived, not just that they were sent:

```bash
curl -s http://127.0.0.1:16686/api/services | python3 -m json.tool
```

```json
{
  "data": ["checkout-api", "jaeger-all-in-one", "frontend", "payment-service"],
  "total": 4,
  "limit": 0,
  "offset": 0,
  "errors": null
}
```

Three services, because three processes each reported their own. Pulling the
actual trace back out of `/api/traces` gives the tree, with durations in
microseconds:

```
traceID: 714d9c1fe324840626692e57028ee06c  spans: 6
frontend         GET /cart              dur= 105817us  parent=ROOT
checkout-api     POST /checkout         dur=  82547us  parent=dfd48770a6cbef5d
checkout-api     SELECT carts           dur=  12125us  parent=1a9c149893e3c3de
checkout-api     HTTP POST /charge      dur=  70042us  parent=1a9c149893e3c3de
payment-service  POST /charge           dur=  50341us  parent=d43c03903dde9800
payment-service  INSERT payments        dur=  30133us  parent=b683bec70fdbc296
```

There it is — the answer to "which hop is slow", without a single guess. The
`SELECT carts` is 12ms; the payment call is 50ms and most of *that* is the
database insert. You can also read the attributes off any span:

```
payment-service POST /charge
  otel.scope.name       = payment-service
  payment.amount_cents  = 4200   (int64)
  payment.currency      = usd    (string)
  span.kind             = internal
```

Note `span.kind` — `server`, `client`, `producer`, `consumer`, or `internal`.
The client/server pairing across a hop is how a backend knows to draw the arrow
between services.

## The hard part: propagation across services

A single-process trace is easy because the SDK holds the "current span" and any
new span just nests under it. The genuinely hard part is the cross-process hop.
When `frontend` calls `checkout-api`, nothing in the network tells checkout which
trace it belongs to — you have to carry it.

The standard is **W3C trace context**, and the carrier is one HTTP header,
`traceparent`. It is three fields: version, trace id, parent span id, flags.

```python
from opentelemetry.propagate import inject, extract

# In the caller, while the client span is current:
headers = {}
inject(headers)
# headers["traceparent"] = "00-<trace-id>-<span-id>-<flags>"

# In the callee, before starting the server span:
ctx = extract(request.headers)
with tracer.start_as_current_span("POST /checkout", context=ctx):
    ...
```

I printed the header my `frontend` actually emitted:

```
outgoing traceparent: 00-714d9c1fe324840626692e57028ee06c-dfd48770a6cbef5d-03
```

That is the whole mechanism. The problems start one layer out from the happy
path, and they are worth knowing before you rely on tracing:

- **Every boundary must propagate.** HTTP has a standard header; message queues,
  cron jobs, and background workers do not. A trace that stops at a queue looks
  complete and is a lie.
- **`inject` must run while the *right* span is current.** I hit this myself: I
  injected before opening the client span, and the payment span's parent became
  the checkout *server* span instead of the *client* span. The trace renders
  fine; the arrow is just wrong.
- **Async and thread pools hide context.** Anything that hops threads or event
  loops must carry the context explicitly, or spans orphan into new traces.
- **The header is not trusted input.** A backend should validate `traceparent`
  (`tracestate` even more so) rather than blindly continuing whatever arrives.

## Sampling, and what traces actually cost

You cannot keep every trace at volume. A 10-service call path at 5 spans each is
50 spans per request; at 1000 rps that is 50,000 spans a second, every second.
Sampling is the lever.

The default and usually-correct choice is a **head sampler**: decide at the root
and let the decision flow down, so traces are complete. `ParentBased` wraps
another sampler and makes children respect the root's verdict. I measured what a
`TraceIdRatioBased` root sampler actually keeps across 2000 traces:

```
ratio=1.0    started=2000  exported= 2000  (100.0%)
ratio=0.25   started=2000  exported=  480  (24.0%)
ratio=0.1    started=2000  exported=  201  (10.1%)
ratio=0.01   started=2000  exported=   30  (1.5%)
```

Two things to take from that table. First, it works: container memory, network,
and storage all scale with the ratio. Second, it does not land exactly on the
number — 0.25 gave 24%, 0.1 gave 10.1%. That is fine and worth internalizing: a
ratio sampler is statistical, not a quota.

The cost decision is not "do we sample" but **which** sampler. A uniform ratio
drops the rare slow request exactly as often as the boring fast one — precisely
when you need it. Better: sample on the tail, keep all traces that exceeded a
latency threshold, and set a floor ratio so you still have a baseline. And keep
`parentbased_always_off` in your pocket for health checks and load balancer
probes, which are pure noise.

## When logs and metrics are enough

Tracing is not free, and the biggest lie in observability content is that you
need all three pillars on day one. If you run one process on one box, tracing
buys you almost nothing you cannot get from good logs with a correlation id —
that is [structured logging](/posts/structured-logging/), and it is where I would
start every time.

Reach for tracing when these are true:

- **You have a request that spans services.** No second hop, no distributed
  trace to draw.
- **"Which hop is slow" is a question you actually ask.** If your p99 is fine and
  your incidents are disk-full and cert-expiry, you need
  [monitoring for a small fleet](/posts/monitoring-a-small-fleet/), not spans.
- **Your log volume has become the problem.** Traces carry the same relational
  information at a fraction of the bytes, because they are sampled and
  structured by construction.

Skip it when: single service, low traffic, incidents that are all resource
exhaustion, or a team that will not maintain the pipeline. A `TraceProvider` that
exports into a backend nobody looks at is a cost centre with a nice flamegraph.
Start with logs, add metrics when you need rates and alerts, add traces the first
time a slow request sends you grepping across three machines.

## The short version

Metrics tell you something is wrong, logs tell you what happened, and traces tell
you *where* — which hop, one request, end to end. OpenTelemetry makes the
collection vendor-neutral and boring; OTLP carries it; Jaeger or Tempo shows it;
a `traceparent` header stitches services together. The ceremony people complain
about is mostly propagation and sampling — the two parts that are genuinely hard,
and the two parts worth understanding before you scale them. Stand up Jaeger,
`curl` one span into it, and get the first trace on screen. Everything after that
is refinement.
