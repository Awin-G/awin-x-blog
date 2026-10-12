---
title: "Load testing your own service: hey benchmark, latency percentiles, and the p99 knee"
description: "A load test answers three questions — your capacity, where it breaks, and whether your last change helped. Run a hey benchmark against your own container, read latency percentiles instead of the mean, find the knee where throughput plateaus and p99 climbs, and correlate it with server CPU."
pubDate: 2026-12-14
lang: en
translationKey: load-testing
tags: [devops, linux]
featured: false
keywords:
  - load testing
  - hey benchmark
  - latency percentiles
  - p99
  - throughput
---

Load testing is not a number you paste into a README. It answers three questions: how much load this service takes, where it stops keeping up, and whether the change you just shipped helped or hurt. Everything else — the headline "Requests/sec", the "we served N million requests" brag — is noise. So let me run a throwaway service in a container, hit it with a **hey benchmark** across a range of concurrency, and read the **latency percentiles** honestly. Somewhere in the middle, **throughput** stops climbing while **p99** starts to run away. That point has a name: the knee.

## What you are actually trying to learn

- **Capacity.** "1,500 req/s at p99 under 100 ms on one core" is a number you can provision against and alert on.
- **Where it breaks.** Which resource saturates first: CPU, a connection pool, a lock, or the generator itself.
- **Whether a change helped.** Change one thing, re-run the same test on the same box, compare p99 at fixed concurrency. That is the only honest way to know.
- **Vanity numbers.** Total requests served, "peak rps" with no latency, a chart from a different machine on a different day. Throughput without latency is a mood, not a result.

## Pick a tool: hey, wrk, k6, ab

They all send HTTP; they differ in what they tell you and what they cost the client.

- **`ab`** is installed everywhere — its main virtue. Single-threaded, and without `-k` it opens a connection per request, so it measures TCP setup more than your app. Reports the mean, not percentiles.
- **`hey`** is my default for a quick answer: one self-contained binary, p50/p95/p99 and the status distribution out of the box, `-z` duration, `-c` concurrency, `-m`/`-d` for method and body. Low client overhead.
- **`wrk`** is for real pressure — a C core with LuaJIT scripting, thousands of connections from a few threads: `wrk -t4 -c200 -d30s --latency`.
- **`k6`** is for tests that must be *repeatable and gated*: scenarios, ramping stages, thresholds that fail the run, archived output. My choice for CI, soaks, and spikes.

Rule of thumb: `hey` for a one-off question, `wrk` for maximum raw load, `k6` when the result must be reproducible and pass/fail, `ab` only for a sanity check.

## Do it safely: your own box, a local container

A load test is indistinguishable from a denial-of-service attack. Never aim a generator at a host you do not own — not a competitor, not a public API, not "just ten concurrent" at somebody's small blog. Even a modest burst can take a small service down, and in many places that is a crime. Your own loopback and your own containers are the only safe targets.

The whole experiment is a tiny Python image with two routes: `/pool` (an 8-slot worker pool plus a 5 ms simulated downstream wait, like a database call) and `/work` (raw CPU), both capped at one CPU.

```bash
# throwaway network + the app, capped at one core, reachable only inside Docker
docker network create loadtest-net
docker run -d --name ltapp --network loadtest-net --cpus=1 loadtest-app

# the generator joins the same private network. No published ports, no public IPs.
docker run --rm --network loadtest-net rcmorano/docker-hey \
  -z 15s -c 1 http://ltapp:8000/pool
```

Neither container touches the host network.

## Design a test that resembles your traffic

A load test is a model, and the wrong knobs tell you nothing. Before typing `-c 1000`:

- **Hit the right paths, in the right mix.** One endpoint tells you about that endpoint; real traffic is mostly cheap reads with a few expensive writes, and if ten percent of requests hit a slow route, model that.
- **Send a real payload.** A bodyless GET against `/` measures your HTTP parser; if the endpoint takes a JSON POST, send a JSON POST.
- **Keep connections alive.** `hey` and `wrk` reuse connections; `ab` needs `-k`. Reconnecting per request measures TCP and TLS, not your handler.
- **Warm up.** Caches fill, JITs compile, pools open. Throw away the first seconds.
- **Choose closed or open loop deliberately.** `hey` and `wrk` are *closed-loop*: each worker waits for its response, so a slow response reduces the offered rate. A fixed arrival rate (`k6`'s `constant-arrival-rate`) keeps pushing when you slow down — which is what reveals collapse.

## The sweep: find the knee, not the peak

One run at one concurrency is a point. A sweep is a curve, and the curve is the result. Only `-c` changes:

```bash
for c in 1 2 4 8 16 32 64 128 256; do
  docker run --rm --network loadtest-net rcmorano/docker-hey \
    -z 15s -c "$c" http://ltapp:8000/pool
done
```

```text
conc  reqs/sec   p50      p95      p99      max      non2xx  appcpu
1     181.6      0.0055   0.0056   0.0056   0.0070s  0       5%
2     362.1      0.0055   0.0056   0.0057   0.0085s  0       9%
4     724.7      0.0055   0.0056   0.0058   0.0084s  0       16%
8     1452.7     0.0055   0.0057   0.0058   0.0126s  0       35%
16    1544.4     0.0103   0.0106   0.0155   0.2226s  0       43%
32    1544.8     0.0206   0.0213   0.0363   0.2320s  0       44%
64    1543.4     0.0413   0.0420   0.0775   0.2484s  0       40%
128   1542.1     0.0828   0.0841   0.1605   0.2891s  0       42%
256   1537.3     0.1657   0.1708   0.3275   0.4961s  0       43%
```

Read two columns. Throughput climbs linearly to **1,452 req/s at c=8**, then barely moves: 1,544 at c=16, 1,537 at c=256. Nine times the load, the same throughput. Meanwhile p50 latency goes 5.5 ms → 165 ms, a thirty-fold increase. That is what "past the knee" means: you pay latency and gain nothing.

<figure>
<svg viewBox="0 0 660 320" width="100%" role="img" aria-label="Throughput rises with concurrency and plateaus at about 1500 requests per second around concurrency 8, while p99 latency stays flat and then climbs steeply after the same point.">
  <g stroke="currentColor" stroke-width="1" opacity="0.18" fill="none">
    <line x1="60" y1="40" x2="620" y2="40"/>
    <line x1="60" y1="145" x2="620" y2="145"/>
    <line x1="60" y1="250" x2="620" y2="250"/>
    <line x1="60" y1="40" x2="60" y2="250"/>
    <line x1="620" y1="40" x2="620" y2="250"/>
  </g>
  <line x1="270" y1="40" x2="270" y2="250" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.9"/>
  <polyline fill="none" stroke="#0f766e" stroke-width="2.5"
    points="60,226.2 130,202.5 200,154.9 270,59.3 340,47.3 410,47.3 480,47.4 550,47.5 620,48.2"/>
  <polyline fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="6 4"
    points="60,246.6 130,246.6 200,246.5 270,246.5 340,240.7 410,228.2 480,203.5 550,153.7 620,53.5"/>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12" opacity="0.85">
    <text x="52" y="44" text-anchor="end">1600</text>
    <text x="52" y="149" text-anchor="end">800</text>
    <text x="52" y="254" text-anchor="end">0</text>
    <text x="628" y="44">350ms</text>
    <text x="628" y="149">175ms</text>
    <text x="628" y="254">0</text>
    <text x="60" y="270" text-anchor="middle">1</text>
    <text x="200" y="270" text-anchor="middle">4</text>
    <text x="340" y="270" text-anchor="middle">16</text>
    <text x="480" y="270" text-anchor="middle">64</text>
    <text x="620" y="270" text-anchor="middle">256</text>
    <text x="340" y="292" text-anchor="middle" opacity="0.7">concurrency (log₂)</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="276" y="34" fill="#0f766e" font-weight="600">knee (c≈8)</text>
    <rect x="66" y="18" width="18" height="3" fill="#0f766e"/>
    <text x="90" y="24">throughput (req/s)</text>
    <rect x="196" y="18" width="18" height="3" fill="currentColor"/>
    <text x="220" y="24">p99 latency</text>
  </g>
</svg>
<figcaption>The same sweep, drawn. Throughput (solid, left axis) saturates near 1,500 req/s by concurrency 8; from there, p99 latency (dashed, right axis) is the only thing that still moves. The knee is the last concurrency that buys throughput — everything to its right costs latency for nothing.</figcaption>
</figure>

The knee is c=8 — the number to design around. In production I sit *below* it, at 50–70% of it, so a spike has somewhere to go. ## Latency percentiles: why the mean lies and p99 is what you feel

The mean is the most reported and least useful latency number: a handful of slow requests vanish into it. If 99 requests take 5 ms and one takes 5,000 ms, the mean is ~55 ms — a number no user experienced. **Latency percentiles** describe the shape instead:

- **p50** is the typical request: half are faster, half slower.
- **p95/p99** are the tail. p99 = 100 ms means one request in a hundred waits longer.
- **max** is a single sample, the noisiest thing on the report. A hint, not a metric.

Compare my two saturating runs of `/pool`:

```text
$ hey -z 15s -c 64 http://ltapp:8000/pool
  Requests/sec: 1542.16
  50% in 0.0413 secs      # p50
  95% in 0.0425 secs
  99% in 0.0777 secs      # p99
  Slowest: 0.3244 secs
  [200] 23198 responses

$ hey -z 15s -c 256 http://ltapp:8000/pool
  Requests/sec: 1537.46
  50% in 0.1656 secs
  99% in 0.3275 secs      # p99 is now 2x p50
  Slowest: 0.6476 secs
  [200] 23317 responses
```

Same throughput (1,542 vs 1,537 — a rounding error). The difference is entirely in the tail: p99 doubled from 78 ms to 328 ms. The mean would have hidden that; p99 refused to. That is why **p99** is the number on my dashboard, and why "we average 40 ms" from a load test is a sentence I no longer believe.

And a page that fans out to ten services inherits the worst tail among them: your service's p99 becomes your page's near-p50.

## Correlate with the server: the client is half the story

The client tells you *what* happened; the server tells you *why*. Add a `/stats` route — counters, in-flight count, process CPU, server-side latency — and read it right after a run:

```text
$ curl -s http://ltapp:8000/stats | jq .
{"uptime_s": 12.5, "requests": {"total": 15528, "/pool": 15528},
 "in_flight": 1, "max_in_flight": 64, "process_cpu_s": 3.93,
 "latency_ms": {"/pool": {"n": 15528, "p50": 41.0, "p95": 41.5,
                          "p99": 77.1, "max": 113.8}}}
```

Two facts jump out. The server's own p50 (41.0 ms) matches the client's (41.3 ms) almost exactly — the latency is inside the app, not in the network. And the app used only ~38% of one core (`docker stats` sampled 31–38%, dropping to 4% when load stopped): it is **not** CPU-bound. The bottleneck is the 8-slot pool, with ~56 requests queued behind it at c=64. The fix is a bigger pool, a faster downstream, or a cache — not a bigger CPU.

Now the CPU-bound route, the opposite story:

```text
$ hey -z 15s -c 50 http://ltapp:8000/work
  Requests/sec: 141.88
  50% in 0.3096 secs
  99% in 0.6995 secs
  Slowest: 4.5789 secs
  [200] 2156 responses
```

`/work` burns CPU, pinned at ~100% for the whole run. But sit with the counter-intuitive part: at c=1 the same route served **227 req/s**; at c=50 it served **142**. Fifty times the concurrency *reduced* throughput. Past the knee, extra concurrency does not queue politely — it adds context-switching, memory churn, and contention, and the tail explodes (max 4.6 s). More load is not more throughput.

The correlation checklist: CPU pegged (scale up or do less work), pool full (raise it or speed up the dependency), error counter climbing (you are not saturated, you are broken), generator itself maxed (check its CPU).

## Load, soak, and spike are three different tests

The sweep is a **load test**: steady, ramping, looking for capacity and the knee. Two more shapes answer different questions:

- **Soak.** Same moderate load, for hours. The metric is *drift*, not peak: does memory climb, do file descriptors leak, does a pool slowly starve, does p99 creep at hour three? Services that pass a five-minute test routinely fall over at five hours. I run soaks overnight, never in the loop after a one-line change.
- **Spike.** A burst well past capacity, then back to normal. The question is not "does it hold" — it will not — but *does it recover*: does the queue drain, do connections close, does a breaker reset, or does one bad minute leave the service degraded for an hour? Use `k6` with `ramping-vus` or a `constant-arrival-rate` executor, because a closed-loop generator backs off exactly when you want it to keep pushing.

## A laptop load test is indicative, not gospel

Every number above came from one machine running both the app and the generator.

- **The generator competes with the app** — same CPU, kernel, and thermal budget. As concurrency rises, some of what I measured is the generator's cost, not the service's.
- **Loopback is not a network.** No real RTT, loss, MTU surprises, or TLS.
- **`--cpus=1` is an honour-system cgroup on a shared kernel**, on a box also running Prometheus during these runs. The absolute rate is not a production number.
- **What transfers**: the *shape* of the curve, the knee's location relative to your config, the *relative* effect of a change on the same box, and the failure mode you found. The absolute "1,542 req/s" is a property of my laptop, not your service.

If you need an absolute capacity number, put the generator on a separate machine, pin its cores away from the app's, and re-run the sweep.

## What I do now

- State the goal first — capacity, breaking point, or did-my-change-help — then build the smallest test that answers it.
- Default to a **hey benchmark** sweep (`1 2 4 8 16 32 64 128 256`), 15 seconds each, and read the curve, never a single point.
- Report **latency percentiles** (p50/p95/p99), not the mean; treat p99 as what users feel.
- Find the knee, then run production at 50–70% of it so a spike has headroom.
- Correlate client numbers with server CPU, in-flight count, and error rate — every time.
- Separate load, soak, and spike, because they fail differently.
- Always test my own box or a throwaway container, never a host I do not own.

A load test is only as good as the honesty you bring to reading it. Once you can see the knee, it pairs naturally with the thing that protects it — [rate limiting](/posts/rate-limiting/) is mostly about keeping real traffic on the safe side of that line. And when you want the deploy itself to survive the test, [zero-downtime deploys](/posts/zero-downtime-deploys/) are what let you re-run it without an outage.
