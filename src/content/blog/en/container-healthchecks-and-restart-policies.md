---
title: "Docker healthchecks: healthy is not the same as running"
description: "What a Docker healthcheck actually measures, with real runs: starting → healthy → unhealthy transitions read from docker inspect, why an unhealthy container never restarts itself, what each restart policy does after a crash and after docker stop, crash-loop backoff, and compose service_healthy."
pubDate: 2027-02-10
lang: en
translationKey: container-healthchecks-and-restart-policies
tags: [devops]
featured: false
keywords:
  - Docker healthcheck
  - container health
  - restart policy
  - service_healthy
  - start-period
---

A container can be `Up 40 seconds` and completely useless. The process is alive, the port is bound, `docker ps` looks fine — and every single request returns 503. I have debugged that shape of outage often enough that I stopped treating "running" as a health signal. Docker has a separate mechanism for the only question an operator actually has: is this container doing its job? That mechanism is the **Docker healthcheck**, and the gap between "running" and "healthy" is where whole afternoons go to die. This post is a run, not a documentation summary: I built a container that boots healthy, rots, recovers, crashes, and crash-loops, and pasted what Docker actually said at every step. Docker 29.9.0, no `sudo`, ports on `127.0.0.1` only. For the compose setup itself — networks, volumes, `.env` — see the [Docker Compose cookbook](/posts/docker-compose-cookbook/); this one is only about the health signal.

## What a HEALTHCHECK actually measures

Docker runs **your** command inside the container on an interval. Exit code 0 → one healthy probe. Non-zero exit, or the probe exceeding its timeout → one failed probe. That's the entire idea: a liveness opinion from *inside* the container, produced by a command you choose.

Without it, container health means exactly one thing: "PID 1 exists". That test catches nothing. A hung HTTP server, a full disk, a dead database connection, a config that points at a decommissioned backend — all of them are `running`. The healthcheck exists because `running` and `useful` are different predicates.

## The demo: one process, one dependency that can die

To make the difference visible I want a container whose process never dies but whose backend dependency can be broken on demand. A tiny Python app is enough — `/healthz` answers 200 only while its dependency is reachable:

```python
# app.py — the process stays alive; the dependency can be broken at runtime
import http.server, pathlib, time

DOWN = pathlib.Path("/tmp/backend-down")   # POST /break touches, /heal removes
WARMUP = 6.0                               # pretend slow boot
STARTED = time.time()

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    def _reply(self, code, body):
        self.send_response(code); self.send_header("Content-Type", "text/plain")
        self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path == "/healthz":
            if DOWN.exists() or time.time() - STARTED < WARMUP:
                self._reply(503, b'dependency "payments" not ready\n')
            else:
                self._reply(200, b"ok\n")
        elif self.path == "/":
            self._reply(200, b"app process alive\n")
        else:
            self._reply(404, b"nope\n")
    def do_POST(self):
        if self.path == "/break": DOWN.touch(); self._reply(200, b"broken\n")
        elif self.path == "/heal": DOWN.exists() and DOWN.unlink(); self._reply(200, b"healed\n")
        else: self._reply(404, b"nope\n")
    def log_message(self, *a): pass

http.server.HTTPServer(("0.0.0.0", 8080), H).serve_forever()
```

And the healthcheck command itself — note what it does **not** do. It doesn't check whether the process exists, and it is not `CMD ["true"]`:

```sh
# health.sh — exit 0 = healthy, anything else = unhealthy
wget -q -T 2 -O /dev/null http://127.0.0.1:8080/healthz
```

Three properties make that a *good* check: it touches a real dependency endpoint, it's cheap (loopback, a few milliseconds — it runs forever on an interval), and it fails loudly — `wget` exits non-zero on a 503, and the health log records the server's error text. A check of `CMD ["true"]` is a lie that never gets caught; `pgrep python` only re-tests what Docker already knows. The check is also arbitrary code running on a schedule inside your container — treat it with the same suspicion as anything else you bake into an image (I wrote about that trust boundary in [Container security basics](/posts/container-security/)).

Stick it in the image, with sane defaults:

```dockerfile
FROM python:3.13-alpine
WORKDIR /srv
COPY app.py health.sh ./
RUN chmod +x health.sh
EXPOSE 8080
CMD ["python", "app.py"]

# interval: probe every 3s | timeout: probe dies after 2s
# retries: 3 consecutive failures -> unhealthy | start-period: slow-boot grace
HEALTHCHECK --interval=3s --timeout=2s --retries=3 --start-period=5s CMD ["./health.sh"]
```

All four values have CLI equivalents, which override the image defaults — this is the run I did:

```console
$ docker run -d --name hc1 -p 127.0.0.1:8080:8080 \
    --health-interval=2s --health-retries=3 --health-start-period=5s \
    hc-demo:local
```

## The state machine: starting, healthy, unhealthy

Probes start the moment the container does. During `start-period` failures are *forgiven* — they don't count toward `retries`, which is what keeps a slow-booting app out of trouble. One second in, the probe is already failing (the app has a 6-second warmup) but the state is still `starting`:

```console
$ docker ps --filter name=hc1 --format '{{.Names}}: {{.Status}}'
hc1: Up 1 second (health: starting)
```

Once the warmup ends and a probe returns 0, the state flips to `healthy` — and `docker inspect` shows the full history, including the forgiven failures:

```console
$ docker inspect --format '{{json .State.Health}}' hc1
{
    "Status": "healthy",
    "FailingStreak": 0,
    "Log": [
        {
            "Start": "2026-10-14T14:29:47.929109373+08:00",
            "End": "2026-10-14T14:29:48.000139024+08:00",
            "ExitCode": 1,
            "Output": "wget: server returned error: HTTP/1.0 503 Service Unavailable\n"
        },
        {
            "Start": "2026-10-14T14:29:50.000982508+08:00",
            "End": "2026-10-14T14:29:50.053917693+08:00",
            "ExitCode": 0,
            "Output": ""
        },
        {
            "Start": "2026-10-14T14:29:52.054474173+08:00",
            "End": "2026-10-14T14:29:52.11014442+08:00",
            "ExitCode": 0,
            "Output": ""
        }
    ]
}
```

That log — last few probes, each with an `ExitCode` and its `Output` — is the whole debugging surface. When you get paged, this is what you read.

<figure>
<svg viewBox="0 0 720 330" role="img" aria-label="State machine: starting becomes healthy when a probe passes, healthy becomes unhealthy after consecutive failures, unhealthy returns to healthy when the dependency recovers, and healthy becomes exited when the process dies. Exited feeds the restart policies, which may launch a new container after a backoff, or with no policy the container stays down. Unhealthy has no arrow to any restart: it never triggers one by itself.">
  <defs>
    <marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="none" stroke="currentColor" stroke-width="1.4" marker-end="url(#arw)">
    <rect x="40" y="56" width="150" height="44" rx="8"/>
    <rect x="265" y="56" width="150" height="44" rx="8" stroke="#0f766e" stroke-width="2.4"/>
    <rect x="490" y="56" width="150" height="44" rx="8"/>
    <rect x="265" y="196" width="150" height="44" rx="8"/>
    <rect x="560" y="196" width="150" height="44" rx="8" stroke-dasharray="5 4"/>
    <line x1="190" y1="78" x2="263" y2="78"/>
    <line x1="415" y1="78" x2="488" y2="78"/>
    <path d="M565 100 V190 H310 V106"/>
    <line x1="340" y1="100" x2="340" y2="194"/>
    <path d="M265 218 H152 V106"/>
    <line x1="415" y1="218" x2="558" y2="218"/>
    <line x1="565" y1="100" x2="565" y2="140" stroke-dasharray="3 3"/>
  </g>
  <g fill="#0f766e" font-family="ui-monospace, monospace" font-size="14" text-anchor="middle">
    <text x="340" y="83">healthy</text>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="14" text-anchor="middle">
    <text x="115" y="83">starting</text>
    <text x="565" y="83">unhealthy</text>
    <text x="340" y="223">exited</text>
    <text x="635" y="216">stays down</text>
  </g>
  <g fill="currentColor" font-size="11" text-anchor="middle">
    <text x="226" y="66">probe exits 0</text>
    <text x="451" y="66">N fails in a row</text>
    <text x="207" y="207">restart policy fires</text>
    <text x="207" y="241">backoff grows</text>
    <text x="487" y="207">policy: no</text>
    <text x="440" y="180">dependency recovers</text>
    <text x="356" y="152">process exits</text>
    <text x="565" y="158" font-size="14">✗</text>
    <text x="565" y="174">unhealthy never restarts anything</text>
    <text x="635" y="236" opacity="0.75">no new container</text>
  </g>
</svg>
<figcaption>The three health states, and the only path that creates a new container. Failures inside the start-period are forgiven; <code>retries</code> counts <em>consecutive</em> failures after it. The missing arrow is the whole lesson: <code>unhealthy</code> is not an exit, so no restart policy reacts to it — and an <code>exited</code> container only comes back if a policy actually fires.</figcaption>
</figure>

## The gotcha: unhealthy does not restart anything

Now the part everyone gets wrong, including me the first time. I break the dependency and confirm the process is still serving — then wait:

```console
$ curl -s -X POST http://127.0.0.1:8080/break
backend broken
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/
200
```

Both true at once: the root path answers 200 (the process is alive), `/healthz` answers 503 (the job it exists to do is broken). Twenty seconds later — ten probe intervals — the state has flipped:

```console
$ docker ps --filter name=hc1 --format '{{.Names}}: {{.Status}}'
hc1: Up 20 seconds (unhealthy)
```

And here is the trap. I attach a restart policy to the *unhealthy* container and wait another twenty seconds:

```console
$ docker update --restart=always hc1
hc1

$ docker ps --filter name=hc1 --format '{{.Names}}: {{.Status}}'
hc1: Up 57 seconds (unhealthy)

$ docker inspect -f 'status={{.State.Status}} exitCode={{.State.ExitCode}} restartCount={{.RestartCount}}' hc1
status=running exitCode=0 restartCount=0

$ docker top hc1 | tail -1
root    1263786    1263760    1    14:29    ?    00:00:00    python app.py
```

Nothing happened, and nothing *will* happen. `restartCount=0`, PID 1 is still the original `python app.py`. Restart policies react to **container exit** — a signal that only appears when the process dies. An unhealthy container is a running container; Docker will leave it serving 503s forever. The health status is a signal *for other systems to read*: compose startup gates, load balancers, monitoring dashboards, and you. It is not a supervisor trigger. (Kubernetes is the exception that proves the rule — there, liveness probes are wired to the kubelet's restart action, which is exactly the piece plain Docker doesn't have.)

One nice property: health is a live signal, not a latch. Heal the dependency and the next passing probe flips it back with no restart at all:

```console
$ curl -s -X POST http://127.0.0.1:8080/heal
backend healed
$ docker inspect -f 'status={{.State.Status}} failingStreak={{.State.Health.FailingStreak}}' hc1
status=running failingStreak=0
```

## Restart policies: what restarts, and when

So what *does* restart a container? An exit, plus a policy. I ran one crash-happy image (`echo boot $(date -u +%T); exit 1`) under every policy. With the default, a crash is terminal:

```console
$ docker run -d --name no1 hc-crash:local
# 8 seconds later:
$ docker inspect -f 'no1: status={{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}}' no1
no1: status=exited exit=1 restarts=0
```

`on-failure` turns that into a crash loop — watch the restart counter climb while the backoff stretches the interval:

```console
$ for t in 3 9 9 9; do sleep $t; docker inspect -f 'restarts={{.RestartCount}} status={{.State.Status}}' on2; done
restarts=3 status=running
restarts=7 status=restarting
restarts=8 status=restarting
restarts=8 status=restarting
```

`always` and `unless-stopped` don't care about the exit code — same crash loop with `exit=1`:

```console
$ docker inspect -f 'always1: status={{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}}' always1
always1: status=restarting exit=1 restarts=6
$ docker inspect -f 'unless1: status={{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}}' unless1
unless1: status=restarting exit=1 restarts=6
```

And the two edge cases that matter in production. First, `on-failure` means *failure* — a clean exit 0 never restarts:

```console
$ docker run -d --name ok0 --restart=on-failure alpine:3.21 sh -c "echo clean exit 0; exit 0"
# 6 seconds later:
$ docker inspect -f 'ok0 (exit 0, on-failure): status={{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}}' ok0
ok0 (exit 0, on-failure): status=exited exit=0 restarts=0
```

Second, a deliberate stop is always respected — no policy fights you:

```console
$ docker ps -a --filter name=always1 --format 'always1 after stop: {{.Status}}'
always1 after stop: Exited (1) 4 seconds ago
$ docker ps -a --filter name=unless1 --format 'unless1 after stop: {{.Status}}'
unless1 after stop: Exited (1) 2 seconds ago
```

The only difference between `always` and `unless-stopped` is what happens when the *daemon* restarts: `always` brings stopped containers back up, `unless-stopped` leaves alone the ones you stopped. That's a documented difference I couldn't demo here without restarting the daemon, so treat it as spec, not output. The summary table:

| Policy | exit ≠ 0 | exit 0 | after `docker stop` | across daemon restart |
|---|---|---|---|---|
| `no` | stays dead | stays dead | stays stopped | stays stopped |
| `on-failure` | restarts (backoff) | **stays dead** | stays stopped | only if it was running when it died |
| `always` | restarts | restarts | stays stopped | restarts |
| `unless-stopped` | restarts | restarts | stays stopped | stays stopped |

## Crash loops and the restart backoff

A crash loop with `on-failure` is worth one careful look, because the daemon throttles it. Boot lines from `docker logs --timestamps` of a container that dies instantly, over and over:

```console
$ docker logs --timestamps on1 | head -12
2026-10-14T06:32:25.685838187Z boot 06:32:25
2026-10-14T06:32:26.056640038Z boot 06:32:26
2026-10-14T06:32:27.015917963Z boot 06:32:27
2026-10-14T06:32:28.145552094Z boot 06:32:28
2026-10-14T06:32:29.320655496Z boot 06:32:29
2026-10-14T06:32:31.561327287Z boot 06:32:31
2026-10-14T06:32:35.011422004Z boot 06:32:35
2026-10-14T06:32:41.809518027Z boot 06:32:41
2026-10-14T06:32:54.833300872Z boot 06:32:54
```

Subtract consecutive timestamps and the backoff is unmistakable: 0.4, 1.0, 1.1, 1.2, 2.2, 3.5, 6.8, 13.0 seconds — roughly doubling each round. The loop self-throttles, which is good for the host (your box won't melt) and bad for you (your "restarted" service is actually up for a few seconds every ten). `RestartCount` climbing in monitoring is the tell. Compose and Swarm behave the same way. The fix for a crash loop is never a tighter restart interval — it's the thing causing the exit. And a container that crash-loops is usually telling you the image's entrypoint expects something the environment doesn't have, which healthchecks can't fix for you.

## Compose: waiting for healthy, not just started

Healthchecks pay off immediately in compose. The old `depends_on: [api]` only waits for "container started", which is exactly the useless state from the beginning of this post. The condition form waits for health:

```yaml
services:
  api:
    image: hc-demo:local
    ports: ["127.0.0.1:8080:8080"]
    healthcheck:                       # yes, you can define it here too
      test: ["CMD", "/srv/health.sh"]
      interval: 3s
      timeout: 2s
      retries: 2
      start_period: 8s

  waiter:                              # waits for "healthy", not "started"
    image: alpine:3.21
    depends_on:
      api:
        condition: service_healthy
    command: ["sh", "-c", "echo WAITER_STARTED_AT=$(date -u +%T.%N)"]

  impolite:                            # old list form: zero waiting
    image: alpine:3.21
    depends_on: [api]
    command: ["sh", "-c", "echo IMPOLITE_STARTED_AT=$(date -u +%T.%N)"]
```

Compose literally prints the gate working (network lines trimmed):

```console
$ docker compose -p hcdemo -f compose.health.yaml up -d
 Container hcdemo-api-1 Creating
 Container hcdemo-api-1 Created
 Container hcdemo-impolite-1 Creating
 Container hcdemo-waiter-1 Creating
 Container hcdemo-impolite-1 Created
 Container hcdemo-waiter-1 Created
 Container hcdemo-api-1 Starting
 Container hcdemo-api-1 Started
 Container hcdemo-impolite-1 Starting
 Container hcdemo-api-1 Waiting
 Container hcdemo-impolite-1 Started
 Container hcdemo-api-1 Healthy
 Container hcdemo-waiter-1 Starting
 Container hcdemo-waiter-1 Started
```

`impolite` starts immediately while `api` is still warming up; `waiter` doesn't start until after `Healthy`. The service clocks make the gap concrete:

```console
$ docker compose -p hcdemo -f compose.health.yaml logs -t --no-log-prefix
2026-10-14T06:36:15.569603460Z IMPOLITE_STARTED_AT=06:36:15.
2026-10-14T06:36:23.568650727Z WAITER_STARTED_AT=06:36:23.
```

Eight seconds later — right when the api's own probes started passing. (Busybox `date` dropped the `%N` nanoseconds, hence the odd trailing dot; the second part of each timestamp is the daemon's.) Everything else in that stack — networks, secrets, volume layout — is in the [Compose cookbook](/posts/docker-compose-cookbook/); the health gate is the part that turns `depends_on` from a lie into an ordering guarantee.

## A bad healthcheck is worse than none

Healthchecks are cheap insurance — a few milliseconds of loopback every few seconds — but the insurance only pays out if the check is honest. What I took away from this run:

- **Check a dependency, not the process.** `true`, `pgrep`, and `test -f /tmp/ok` report green for containers that serve nothing. The check should fail when the container's *job* fails.
- **Give slow boots a `start-period`.** Without it, a database restore or a JVM warmup eats your retries and the container is born unhealthy. With it, failures during the grace window are forgiven.
- **Keep it cheap and local.** This runs forever, on an interval, inside every replica. Loopback endpoint, two-second timeout, done.
- **`retries` absorbs blips; it doesn't create outages.** Two or three consecutive failures is a real signal; one shouldn't page anyone.
- **Know what does *not* react to health:** the restart policies. An unhealthy container is a running container — if you want the exit, something else must be the supervisor: a watchdog container that curates the unhealthy state, an orchestrator, or a load balancer that ejects the instance.
- **Match the policy to the failure mode.** `on-failure` for workers that should exit on bad input; `always`/`unless-stopped` for daemons that must come back. A crash loop with a growing backoff is a bug report, not a strategy.

Running is a fact about a PID. Healthy is a judgment about a service. Docker will happily give you the first and never check the second — unless you write the check, and unless you remember that a check without an actor that reacts to it is just a green light on a dead dashboard.
