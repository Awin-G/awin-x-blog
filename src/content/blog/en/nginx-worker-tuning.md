---
title: "nginx worker tuning: worker_processes, worker_connections, and the limits that bite"
description: "nginx worker tuning measured on real throwaway containers: why worker_processes auto equals one worker per core, the worker_connections max-connections math, and the ulimit -n / worker_rlimit_nofile ceiling that actually bites. Real warnings, real fix."
pubDate: 2027-02-07
lang: en
translationKey: nginx-worker-tuning
tags: [nginx, devops]
featured: false
keywords:
  - nginx worker_processes
  - worker_connections
  - nginx tuning
  - worker_rlimit_nofile
  - keepalive
---

Every so often some blog tells you to copy a "production-ready nginx.conf" with `worker_processes 100000;` and a pile of magic numbers. I did the opposite: I ran the stock nginx config on throwaway containers, pushed real load at it, then changed one thing at a time and wrote down what actually moved — including two real failures I provoked on purpose. The knobs below are the whole of nginx worker tuning in practice: `worker_processes`, `worker_connections`, `worker_rlimit_nofile`, and keepalive. Everything was measured on `nginx/1.27.5` (`nginx:1.27-alpine`) on an 8-core box, serving a 30-byte static file to `hey` on a private Docker network. No invented output — the two error logs below are ones I actually caused.

This is not the config cookbook: for location matching, `try_files`, and gzip I already wrote [an nginx config cookbook](/posts/nginx-cookbook/), and the load-testing method — percentiles, knees, correlating with server CPU — lives in [load testing your own service](/posts/load-testing/). This piece is only about the worker-level limits and the numbers they produce.

## The process model: one master, N single-threaded workers

nginx is a master process plus a pool of workers. The master owns the listening sockets, parses the config, and never serves requests. Each worker is a separate, **single-threaded**, event-driven process (`epoll` on Linux): it holds thousands of connections in its event loop and does non-blocking I/O on all of them at once. That is why one worker can serve thousands of mostly-idle keepalive connections — but also why a worker is exactly one core's worth of CPU. More workers than cores does not add capacity; it adds context switches and cache thrash.

So `worker_processes auto;` — the default in the official image — sets one worker per core. Verified, not believed:

```text
$ docker exec ngx sh -c 'ps -o pid,ppid,args | grep nginx'
    1     0 nginx: master process nginx -g daemon off;
   30     1 nginx: worker process
   31     1 nginx: worker process
   32     1 nginx: worker process
   33     1 nginx: worker process
   34     1 nginx: worker process
   35     1 nginx: worker process
   36     1 nginx: worker process
   37     1 nginx: worker process
```

Eight workers on an eight-core box. `auto` is right almost always. The exceptions are real but narrow: pin workers onto specific cores with `worker_cpu_affinity` when you need cache locality, or set an explicit number when the box is shared and you are deliberately fencing nginx to a slice of it. A container that sees eight cores will start eight workers even under `--cpus=1` — if you cap a container's CPU, cap it above the worker count or set `worker_processes` explicitly.

## worker_connections: the per-worker ceiling and the max-connections math

`worker_connections` is the max number of **simultaneous connections one worker will hold** — client connections *and* upstream connections *and* proxied connections, each connection costing a file descriptor. The stock value is 1024, straight from the effective config:

```text
$ docker exec ngx nginx -T | sed -n '1,20p'
worker_processes  auto;
events {
    worker_connections  1024;
}
http {
    sendfile        on;
    #tcp_nopush     on;
    keepalive_timeout  65;
    #gzip  on;
}
```

The headline math everyone quotes:

```text
max concurrent connections = worker_processes × worker_connections
                           = 8 × 1024 = 8192   (stock values)
```

But three subtractions come due before you ever reach it. Per worker, the listener, epoll, the log fds, and every in-flight upstream connection all eat into the same 1024 — and when nginx *proxies*, each client request consumes **two** connections (client + upstream), halving the effective client ceiling. For a proxy box the honest formula is closer to `workers × (worker_connections − 2 × concurrent_upstreams)`.

What happens when you smash into it? I set `worker_connections 64` and pushed 300 concurrent connections at it:

```text
$ hey -z 10s -c 300 http://ngx-small/
  Requests/sec: 24876.5801        # every request still got a 200

$ docker logs ngx-small
[warn] 32#32: 64 worker_connections are not enough, reusing connections
[warn] 34#34: 64 worker_connections are not enough, reusing connections
[warn] 31#31: 64 worker_connections are not enough, reusing connections
[warn] 35#35: 64 worker_connections are not enough, reusing connections
[warn] 33#33: 64 worker_connections are not enough, reusing connections
[warn] 37#37: 64 worker_connections are not enough, reusing connections
[warn] 30#30: 64 worker_connections are not enough, reusing connections
[warn] 36#36: 64 worker_connections are not enough, reusing connections
```

One line per worker. Note the honest nuance: in this keepalive microbenchmark nginx degraded *gracefully* — it closed and recycled idle keepalive connections (`reusing connections`) and every one of the 24,876 req/s still answered `200`. Under harsher conditions — clients holding connections open without requests, upstreams stalling, a connection flood aimed at the accept queue — the same exhaustion turns into refused connections and resets. The warning is the early signal; do not wait for the visible failure.

## worker_rlimit_nofile: the limit that actually binds

Here is the trap in the headline math: `worker_connections` is per worker, but so is the **file-descriptor limit**, and the smaller of the two wins. This container's soft limit was exactly 1024:

```text
$ docker exec ngx sh -c 'ulimit -n'
1024
$ docker exec ngx sh -c 'grep "Max open files" /proc/$(pgrep nginx | sed -n 2p)/limits'
Max open files            1024                 524288               files
```

So the stock config's `worker_connections 1024` quietly equals the stock fd limit — 8,192 total connections is *already* the container ceiling before you subtract the listener and the logs. Raise `worker_connections` without raising the fd limit and nginx tells you at startup, which I reproduced by setting 8192:

```text
$ docker run ... -v tuned-nginx.conf:/etc/nginx/nginx.conf nginx:1.27-alpine
[warn] 38#38: 8192 worker_connections exceed open file resource limit: 1024
nginx: the configuration file /etc/nginx/nginx.conf test is successful
```

It keeps that promise badly. I ran a container with a soft fd limit of **256** (`--ulimit nofile=256:4096`) and the stock-ish `worker_connections 1024`, then aimed 2000 concurrent connections at it. During the run, workers were pinned at the wall — 193 to 253 open fds each against the 256 limit:

```text
worker 36 limits: 256 soft, fds_open=253
worker 35 limits: 256 soft, fds_open=219
```

and the error log filled with the real thing — 152 lines of this:

```text
[docker logs ngx-fdlow]
[crit] 30#30: accept4() failed (24: No file descriptors available)
[crit] 35#35: accept4() failed (24: No file descriptors available)
[crit] 37#37: accept4() failed (24: No file descriptors available)
[crit] 33#33: accept4() failed (24: No file descriptors available)
[crit] 36#36: accept4() failed (24: No file descriptors available)
... 152 in 8 seconds
```

`24` is EMFILE — errno 24 is the classic "too many open files", which modern kernels word as "No file descriptors available". Every one of those lines is an incoming connection nginx could not even accept; clients see resets or hangs, not 502s. 2000 connections ÷ 8 workers ≈ 250 fds per worker — the arithmetic predicted it exactly.

The fix is one directive, and it works because it can be raised inside a hard limit. Same container, same load, one added line:

```nginx
worker_rlimit_nofile 4096;   # raise the workers' fd limit above the
events { worker_connections 1024; }   # connection count, within the hard limit
```

The master raises each worker's limit to 4096 at startup (hard limit was 4096, so it succeeds), and under the identical 2000-connection load:

```text
$ docker logs ngx-fdfix | grep -c 'No file descriptors available'
0
$ docker exec ngx-fdfix sh -c 'grep "Max open files" /proc/$(pgrep -f "nginx: worker" | head -1)/limits'
Max open files            4096                 4096                 files
$ hey -z 8s -c 2000 http://ngx-fdfix/
  Requests/sec: 29029.2874     # same throughput; zero refusals
```

Throughput did not change (29,029 vs 29,263 req/s — noise). That is the point: the fd fix buys *reliability at the edge*, not raw speed. nginx tuning is full of knobs that only matter once you are near a limit — which is why you tune against measurements, not folklore.

## Keepalive: the cheapest requests/sec you will ever get

A served keepalive request is a request with no TCP handshake. `keepalive_timeout` defaults to 65 seconds, which is generous and fine. I turned it off — `keepalive_timeout 0;` — and re-ran the same load on the same tuned config:

```text
keepalive_timeout 65   ->  Requests/sec: 39527.9401   p50 1.0 ms  p99 5.1 ms
keepalive_timeout 0    ->  Requests/sec: 12150.6553   p50 3.9 ms  p99 8.7 ms
```

A 3× throughput collapse from one directive, all of it spent on connection setup. Two related defaults matter at high request counts: `keepalive_requests` (1000 by default) closes a connection after 1000 requests on it, and `keepalive_time` is the header-timeout backstop for slow clients. On the other side of the proxy, upstream keepalive is a separate directive — you need an `upstream` block with `keepalive N;` and `proxy_set_header Connection "";` per location — and every idle upstream connection parked there is one more fd counted against `worker_connections`. Keepalive is not free; it is just cheaper than the handshake.

## The cheap kernel wins, honestly ranked

The usual "must-have" list is `sendfile`, `tcp_nopush`, `tcp_nodelay`, and `open_file_cache`. I ran the bundle against the stock config at three concurrencies. The full tuned config:

```nginx
worker_processes        auto;
worker_rlimit_nofile    4096;          # only meaningful if the hard limit allows it
events { worker_connections 8192; }
http {
    sendfile        on;                 # kernel-side file copy, zero user-space hops
    tcp_nopush      on;                 # batch headers+body into full segments
    tcp_nodelay     on;                 # ...but don't sit on the last partial segment
    keepalive_timeout   65;
    keepalive_requests  10000;          # stop recycling conns every 1000 requests
    open_file_cache          max=10000 inactive=30s;
    open_file_cache_valid    60s;
    open_file_cache_min_uses 2;
    open_file_cache_errors   on;
    # gzip stays off: the file under test is 30 bytes (see the cookbook for real gzip)
    server { listen 80; root /usr/share/nginx/html; location / { index index.html; } }
}
```

Real numbers, same box, same 30-byte file:

```text
        c=1              c=50             c=100
stock   5,709.58 req/s   21,927.01 req/s  21,116.02 req/s
       (p99 0.3 ms)      (p99 8.6 ms)     (p99 15.6 ms)
tuned   8,246.49 req/s   39,527.94 req/s  38,403.32 req/s
       (p99 0.2 ms)      (p99 5.1 ms)     (p99 8.4 ms)
```

Roughly 2× at concurrency, and lower latency everywhere. But I changed several things at once, so I isolated them — and one result inverted the folklore:

- **`access_log off` was the biggest single mover.** Same tuned config with logging back on: 34,472 and 26,818 req/s at c=50 across two runs — a third to half of the log-off throughput, on a file a write per request. Every request costs a `write()` to disk; if you do not read your logs line-by-line, buffer them (`access_log ... buffer=32k;`) or sample them.
- **`multi_accept on` made things worse.** With it on, per-worker CPU during load was visibly skewed — one worker at ~40%, one at 0% while hey kept 60 connections open:

```text
$ /proc/<pid>/stat ticks, 3s window, c=60:
worker 35  cpu_ticks=119  est_cpu=40%
worker 36  cpu_ticks=0    est_cpu=0%
worker 34  cpu_ticks=38   est_cpu=13%
```

Each accept wake-up lets one worker grab a batch of connections while the others idle — exactly the imbalance the docs warn about. Dropping `multi_accept` restored even distribution with the same throughput (34,384–38,771 req/s at c=50). My final config above does **not** include it.

<figure>
<svg viewBox="0 0 720 360" width="100%" role="img" aria-label="Diagram: one nginx master process owns the shared listening socket and a pool of eight worker processes. Each worker's connections are capped by worker_connections, and every connection, file, and upstream socket also spends from that worker's file-descriptor ceiling of ulimit -n or worker_rlimit_nofile.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <line x1="360" y1="64" x2="360" y2="92"/>
    <path d="M360 96 l-5 -9 h10 z" fill="currentColor" stroke="none"/>
  </g>
  <rect x="230" y="14" width="260" height="50" rx="9" fill="none" stroke="#0f766e" stroke-width="1.6"/>
  <text x="360" y="36" text-anchor="middle" fill="#0f766e" font-family="ui-monospace, monospace" font-size="13">master process</text>
  <text x="360" y="54" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11.5">parses config, owns the listen socket</text>
  <text x="360" y="120" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5" opacity="0.8">shared listening socket — workers compete to accept()</text>
  <g fill="none" stroke="currentColor" stroke-width="1.3">
    <rect x="20"  y="140" width="160" height="74" rx="8"/>
    <rect x="200" y="140" width="160" height="74" rx="8"/>
    <rect x="380" y="140" width="160" height="74" rx="8"/>
    <rect x="560" y="140" width="140" height="74" rx="8"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="12.5">
    <text x="100" y="162" text-anchor="middle">worker 1</text>
    <text x="280" y="162" text-anchor="middle">worker 2</text>
    <text x="460" y="162" text-anchor="middle">worker 3</text>
    <text x="630" y="162" text-anchor="middle">… worker 8</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5" opacity="0.85">
    <text x="100" y="184" text-anchor="middle">1 thread, epoll</text>
    <text x="280" y="184" text-anchor="middle">1 thread, epoll</text>
    <text x="460" y="184" text-anchor="middle">1 thread, epoll</text>
    <text x="630" y="184" text-anchor="middle">one per core</text>
    <text x="100" y="202" text-anchor="middle">conns, files, upstreams</text>
    <text x="280" y="202" text-anchor="middle">conns, files, upstreams</text>
    <text x="460" y="202" text-anchor="middle">conns, files, upstreams</text>
  </g>
  <g fill="none" stroke="#0f766e" stroke-width="1.4">
    <rect x="40" y="236" width="290" height="44" rx="8"/>
    <rect x="370" y="236" width="300" height="44" rx="8"/>
  </g>
  <g font-family="ui-monospace, monospace" font-size="12">
    <text x="185" y="256" text-anchor="middle" fill="#0f766e">worker_connections</text>
    <text x="185" y="273" text-anchor="middle" fill="#0f766e">per worker, any connection</text>
    <text x="520" y="256" text-anchor="middle" fill="currentColor">ulimit -n / worker_rlimit_nofile</text>
    <text x="520" y="273" text-anchor="middle" fill="currentColor">fd budget — the real ceiling</text>
  </g>
  <text x="360" y="252" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="13" opacity="0.7">vs</text>
  <text x="360" y="316" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12" opacity="0.85">max clients = workers × min(worker_connections, fd limit) − proxies − logs</text>
</svg>
<figcaption>Two ceilings per worker, not one. `worker_connections` counts every connection the worker holds; the file-descriptor limit pays for those connections plus files and upstream sockets. Whichever is smaller decides when the wall arrives — and at 8 workers, a per-worker limit of 250 fds is a 2,000-connection wall, which is exactly where I hit it.</figcaption>
</figure>

One caveat on the throughput table: the whole run lived inside one box, client and server sharing the same kernel. A `docker stats` sample during the stock c=100 run showed nginx itself at 121% CPU of eight cores — the server was *not* the bottleneck there; the client and the loopback path were part of the ceiling. That is the [load-testing lesson](/posts/load-testing/) again: read the server's CPU before believing any req/s headline. The relative effects and the failure modes transfer; the absolute numbers are a property of my laptop, not yours.

## Is the juice worth the squeeze?

For a static site on a one- or two-core box, the stock config is genuinely fine: `auto` workers, 1024 connections each, defaults everywhere. My baseline still served 21,927 req/s at c=50 — a number most blogs will never see. Tuning pays in three specific situations, and each has a measurement attached:

1. **You are proxying.** Client + upstream connections double-count against `worker_connections`, and the fd limit binds first. Raise `worker_rlimit_nofile` and `worker_connections` together, well above your peak `concurrency × 2`.
2. **You have thousands of keepalive clients** (a chat feed, an SSE endpoint, a slow mobile population). Connections sit idle for minutes; count them against `worker_connections`, not request rate.
3. **You actually hit a wall.** Then it will not be subtle: `worker_connections are not enough` in the log, or `accept4() failed (24: No file descriptors available)`. Both are one-Google-answer problems once you have seen them here.

What I actually do now: keep `worker_processes auto;`, set `worker_rlimit_nofile` to something the hard limit allows (32k is a safe default; it is just a ceiling, not an allocation), raise `worker_connections` only in step with it, leave `sendfile`/`tcp_nopush`/`tcp_nodelay` on, add `open_file_cache` for static roots, watch the error log for the two warnings above, and leave `multi_accept` and colossal connection counts to people who measured. Tune with a load test in hand, change one thing, and when the numbers stop moving, stop.
