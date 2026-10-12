---
title: "Graceful shutdown and connection draining, reproduced"
description: "I ran a throwaway nginx in front of a one-second app, sent SIGTERM mid-flight, and watched requests die as 502 Bad Gateway — then fixed it with real connection draining: why deploys cause 502s, nginx reload vs restart, Kubernetes preStop, and a per-stack graceful-shutdown checklist."
pubDate: 2026-12-19
lang: en
translationKey: graceful-shutdown
tags: [devops, nginx]
featured: false
keywords:
  - graceful shutdown
  - SIGTERM
  - connection draining
  - zero-downtime deploy
  - 502 Bad Gateway
---

A **graceful shutdown** should be boring: on **SIGTERM**, the process stops accepting new work, finishes what is already in flight, then exits. Most processes do the opposite — they die the instant the signal lands, and every request they were holding dies with them. That gap is where a routine deploy becomes a page full of **502 Bad Gateway**. I reproduced it with a throwaway nginx in front of a tiny app that takes one second per request, sent **SIGTERM** mid-flight, and watched **connection draining** either happen or not — the mechanic a real **zero-downtime deploy** depends on.

The setup was a throwaway `nginx:1.27.5` proxying `python:3.14` on a Docker bridge network, all on `127.0.0.1`, no privileges. Everything below is real output.

## What SIGTERM should do — and what it usually does

`SIGTERM` is the polite signal: unlike `SIGKILL` it is catchable, and the intended contract is three steps:

1. stop accepting new connections (stop reading the listening socket),
2. finish the requests already in flight,
3. exit.

Most programs do step 3 and only step 3. The default disposition of `SIGTERM` is "terminate immediately", so unless the app installs a handler, requests are still open when the process dies — the client sees a reset, or a **502** if a proxy is in front.

The shutdown looks like this:

<figure>
<svg viewBox="0 0 760 330" width="100%" role="img" aria-label="Timeline of a graceful shutdown. SIGTERM stops the process accepting new connections; in-flight requests finish inside the drain window; a request arriving after SIGTERM is refused; the process exits when the window closes.">
  <rect x="60" y="70" width="230" height="185" fill="currentColor" opacity="0.05"/>
  <rect x="290" y="70" width="350" height="185" fill="#0f766e" opacity="0.10"/>
  <text x="175" y="60" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12">accepting new connections</text>
  <text x="465" y="60" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12" font-weight="600">drain window: finish in-flight, refuse new</text>
  <line x1="290" y1="70" x2="290" y2="285" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5 4"/>
  <text x="290" y="302" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">SIGTERM</text>
  <line x1="640" y1="70" x2="640" y2="285" stroke="currentColor" stroke-width="1.5"/>
  <text x="640" y="302" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">exit 0</text>
  <line x1="60" y1="285" x2="706" y2="285" stroke="currentColor" stroke-width="1.5"/>
  <path d="M706 285 l-10 -5 v10 z" fill="currentColor"/>
  <text x="712" y="290" fill="currentColor" font-family="system-ui, sans-serif" font-size="10">t</text>
  <rect x="180" y="110" width="200" height="16" rx="3" fill="#0f766e"/>
  <text x="390" y="123" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">in-flight request &#8594; 200</text>
  <rect x="220" y="145" width="180" height="16" rx="3" fill="#0f766e" opacity="0.8"/>
  <text x="410" y="158" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">in-flight request &#8594; 200</text>
  <rect x="320" y="185" width="60" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="4 3"/>
  <line x1="334" y1="188" x2="366" y2="198" stroke="currentColor" stroke-width="2"/>
  <line x1="366" y1="188" x2="334" y2="198" stroke="currentColor" stroke-width="2"/>
  <text x="392" y="198" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">new request &#8594; 502</text>
</svg>
<figcaption>A graceful shutdown is a race with a deadline. Requests that were already accepted on the left finish inside the drain window; anything that arrives after SIGTERM is the load balancer's problem to stop sending.</figcaption>
</figure>

One trap first: **PID 1 ignores signals it has no handler for.** My first run sent `SIGTERM` and nothing happened — the app kept serving, because Python was PID 1. That is why containers ship a tiny init (`docker run --init`, Compose `init: true`) that forwards signals to a child that can handle them.

## Why a deploy causes 502s

The outage is a race between two independent decisions:

- the **load balancer / reverse proxy** decides when to stop routing to an instance, and
- the **app** decides when to stop accepting connections.

If the app stops accepting before the proxy stops sending, the proxy keeps dialing a socket nobody is listening on. Every request in that window fails. The app did nothing *wrong*; the two sides just disagreed about the order. The whole craft of **connection draining** is making the proxy go first and giving the app a grace window to finish.

Under load, that tiny window is exactly where your slowest requests live.

## The failure: SIGTERM with no handler

The app sleeps one second per request and, in the "no drain" build, installs no signal handler. I fire six concurrent requests through nginx and send `SIGTERM` at 0.4s:

```text
$ ./run-case.sh 6 0.4
>>> sending SIGTERM to app container
HTTP 502  0.597s  req=4
HTTP 502  0.601s  req=3
HTTP 502  0.601s  req=2
HTTP 502  0.604s  req=6
HTTP 502  0.604s  req=5
HTTP 502  0.611s  req=1
```

All six fail, and they fail *early* — around 0.6s instead of the full 1.0s. The requests had a second of work left; the process just vanished underneath them. The app log tells the same story from the inside: six `START` lines and not a single `FINISH`.

```text
START  req=1 active=1
START  req=5 active=2
START  req=6 active=3
START  req=2 active=4
START  req=3 active=5
START  req=4 active=6
# process terminated — no FINISH lines ever print
```

nginx names the cause exactly, in its error log:

```text
[error] upstream prematurely closed connection while reading response
        header from upstream, upstream: "http://172.22.0.2:8080/"
```

"Prematurely closed" is nginx's way of saying the upstream TCP connection went away before a response header arrived. The client gets **502**.

## The fix: drain in-flight, then exit

Now the app handles the signal. On `SIGTERM` it stops accepting, waits for the in-flight counter to reach zero, and exits:

```python
def on_term(signum, frame):
    log("signal received: stop accepting, drain in-flight")
    threading.Thread(target=server.shutdown, daemon=True).start()

signal.signal(signal.SIGTERM, on_term)   # only installed when draining is on

server.serve_forever()                   # returns once shutdown() stops the accept loop
while active_requests > 0:               # work already accepted keeps running
    time.sleep(0.05)
sys.exit(0)
```

Same six requests, same mid-flight signal, one difference in behavior:

```text
$ DRAIN=1 ./run-case.sh 6 0.4
>>> sending SIGTERM to app container
HTTP 200  1.001s  req=5
HTTP 200  1.001s  req=1
HTTP 200  1.001s  req=6
HTTP 200  1.001s  req=3
HTTP 200  1.001s  req=4
HTTP 200  1.001s  req=2
```

And the log, now with the shutdown visible:

```text
signal 15 received: stop accepting, drain in-flight
accept loop stopped; waiting for in-flight requests
FINISH req=1 elapsed=1.00s
FINISH req=4 elapsed=1.00s
...
all in-flight done; exiting cleanly
```

Six 200s instead of six 502s — most of what "we handle SIGTERM properly" means.

## New requests during the drain still fail

Draining does not make the instance invincible, and this is the part people skip: while it finishes old work, it is *not* accepting new connections. Anything the proxy sends now fails:

```text
IN-FLIGHT req=A  200  3.00s     # accepted before SIGTERM, finishes
IN-FLIGHT req=B  200  3.04s
NEW       req=C  502  1.96s     # proxy sent a new connection into a closed listener
```

So draining alone is not enough — pair it with the proxy *stopping* traffic. The correct order is: tell the load balancer to stop sending → wait a beat → send `SIGTERM` → let the app drain. Kubernetes models that beat, and so should you.

## What nginx does when an upstream disappears

nginx makes this explicit. With `max_fails=0` it never marks the backend "down", so you see the truth instead of a cached failure. Knobs that matter:

- `proxy_next_upstream off;` — don't silently retry a *different* backend, which hides a broken deploy behind a slow 200.
- `proxy_connect_timeout 1s;` — bound how long a client waits for a socket that is no longer listening (I saw a **504** when the port refused instead of reset).
- `keepalive N;` with `proxy_http_version 1.1;` and `proxy_set_header Connection "";` — reuse upstream connections, which is faster but means the proxy must also retire keepalive connections when an upstream leaves.

nginx also has two very different ways to go down:

```text
nginx -s reload   →  HTTP 200 ×4   workers replaced, in-flight requests never interrupted
nginx -s quit     →  HTTP 200 ×4   graceful shutdown: drain, then exit
nginx -s stop     →  HTTP 000 ×4   fast shutdown: connections cut mid-response
```

`reload` is the zero-downtime primitive: the master reads new config, starts fresh workers, and lets old ones finish. `quit` is graceful shutdown. `stop` yanks the cable — clients get nothing (`000` is curl reporting a connection that died with no HTTP response at all). Most people who think they want "restart" actually want `reload`; I go deeper in the [nginx config cookbook](/posts/nginx-cookbook/).

## Kubernetes: preStop and terminationGracePeriodSeconds

The orchestrator cannot fix a broken shutdown, but it gives you two handles. When a pod is deleted, Kubernetes removes it from Service endpoints *and* starts the termination countdown at the same time — so a **`preStop`** hook delays the app, letting endpoint removal reach kube-proxy and the load balancer first. `terminationGracePeriodSeconds` bounds the whole thing; when it expires, `SIGKILL` follows.

```yaml
terminationGracePeriodSeconds: 30   # budget: must exceed longest in-flight request + queue
lifecycle:
  preStop:
    exec: { command: ["sh", "-c", "sleep 5"] }   # let deregistration reach the proxies
```

The distinction that trips people up: a **readiness probe** controls *new* traffic; a **liveness probe** decides whether a stuck process gets *restarted*. A draining app should fail readiness while staying alive — never fail liveness during shutdown, or the kubelet kills the requests you were saving. That "announce unready, then drain" handshake is the core of my [zero-downtime deploy](/posts/zero-downtime-deploys/) setup.

## A per-stack graceful-shutdown checklist

Everything above is the same three steps with different spellings. Match the timeout to your slowest request, and on every stack make sure the process actually receives `SIGTERM`:

```ini
# systemd
[Service]
KillSignal=SIGTERM      # the polite signal
KillMode=mixed          # signal the main process, then the whole cgroup
TimeoutStopSec=30       # then SIGKILL; must exceed longest request + queue
```

```dockerfile
# Dockerfile
STOPSIGNAL SIGTERM      # what `docker stop` sends; default is already SIGTERM, be explicit
```

```yaml
# compose.yaml
services:
  app:
    init: true                    # PID 1 signal forwarding + zombie reaping
    stop_grace_period: 30s        # docker stop's patience before SIGKILL
```

The checklist, compressed: (1) install a `SIGTERM` handler that stops accepting but finishes in-flight work; (2) make sure the signal reaches the process — `exec` in entrypoints, `init: true` for PID 1; (3) stop routing before you stop accepting (nginx upstream weight, Kubernetes `preStop`, or a deregistration delay); (4) set the stop timeout longer than your slowest request; (5) prefer reload over restart, and drain over both.

None of this is exotic: one handler, one counter, one honest handshake with the proxy. The 502s were never the app failing — just the app and the load balancer disagreeing about who leaves the room first. Get the order right and the deploy is invisible, which is exactly what you want.
