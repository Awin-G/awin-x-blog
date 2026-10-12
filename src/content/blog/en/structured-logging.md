---
title: "Structured logging that actually helps you debug at 3am"
description: "Why print statements and unstructured logs fail you at 3am, what structured logging with JSON logs really means, what to log at each log level, how to propagate a correlation id, the journald reality including journalctl -o json, sampling, and a quick Python/Go/Node comparison."
pubDate: 2026-11-15
lang: en
translationKey: structured-logging
tags: [devops, linux]
featured: false
keywords:
  - structured logging
  - JSON logs
  - journald
  - log levels
  - correlation id
---

It is 3am and an alert says the API is throwing errors. You SSH in, run
`journalctl -u api`, and get a wall of this:

```
failed to charge user
retrying...
failed to charge user
cache miss
failed to charge user
```

Three identical lines: which one belongs to the failing request? Which user? How
long did the call take? You start grepping by timestamp and guessing. This is the
part of **observability** nobody puts on a slide: not dashboards, just answering
"what happened to *that one request*" in under a minute. **Structured logging**
is the cheapest upgrade that gets you there — no log aggregator, no paid SaaS,
no YAML longer than your app.

## Why print and unstructured logs fail you at 3am

A `print()` line is written for the human sitting next to you right now. It
encodes everything in prose that only makes sense with full context you no
longer have at 3am, hours later, on a different machine:

- **You cannot filter by a field that isn't a field.** `grep "charge"` matches
  the log line, the retry message, and a debug line that happens to mention it.
- **You cannot answer "how many".** Counting failures means regexing timestamps
  and hoping the format never changed.
- **You cannot correlate.** The request that triggered the failure is in one
  place, the DB timeout in another, and nothing connects them.
- **You cannot parse it reliably.** Someone adds an emoji, a stack trace lands
  mid-line, and your `awk` breaks.

The fix is not "log more". It is **log the same thing, as data**: fixed keys,
stable types, one line per event. That is all **structured logging** means. The
rest — collectors, dashboards, alerting — sits on top and is optional.

## What structured logging actually means

Two ideas only:

1. **Key/value pairs.** Every event is a set of named fields, not a sentence.
2. **One event per line, machine-parsable.** The most common encoding is
   **JSON logs** — one JSON object per line ("JSON Lines"), no wrapping array,
   no pretty-printing.

That is it — no schema registry, no custom binary format, no logger emitting
seventeen protocols. A good starting contract:

- `ts` — ISO 8601, UTC, millisecond precision.
- `level` — lowercase, from a fixed small set.
- `msg` — a short, *constant* string describing the event. Not interpolated.
- **Everything variable goes in its own field** — `request_id`, `route`,
  `status`, `duration_ms`, `err`.

The "msg is constant" rule is the one people break first, and it is the one
that matters most. `msg: "charge failed for user 42"` is a sentence again;
`msg: "charge failed", user_id: 42` is queryable.

<figure>
<svg viewBox="0 0 620 150" width="100%" role="img" aria-label="A request id is generated at the proxy, copied into a header, logged by the app, and passed to the database so all three tiers share one identifier.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="16" y="48" width="120" height="54" rx="8"/>
    <rect x="250" y="48" width="120" height="54" rx="8"/>
    <rect x="484" y="48" width="120" height="54" rx="8"/>
    <path d="M136 75 h108" marker-end="url(#a)"/>
    <path d="M370 75 h108" marker-end="url(#a)"/>
  </g>
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="76" y="72">proxy</text>
    <text x="76" y="90" opacity="0.75">generates id</text>
    <text x="310" y="72">app</text>
    <text x="310" y="90" opacity="0.75">logs + forwards</text>
    <text x="544" y="72">database</text>
    <text x="544" y="90" opacity="0.75">application_name</text>
    <text x="190" y="66" opacity="0.9">X-Request-ID</text>
    <text x="424" y="66" opacity="0.9">same id</text>
  </g>
</svg>
<figcaption>One correlation id, minted once at the edge, reused at every tier.</figcaption>
</figure>

## A concrete log line

Here is one event I actually grep for, the error case:

```json
{"ts":"2026-11-15T09:41:07.123Z","level":"error","msg":"charge failed","request_id":"8f3c1d2e","route":"POST /charge","user_id":1042,"status":502,"duration_ms":412,"err":"upstream timeout","upstream":"stripe","retry":2}
```

Read it without me: a charge failed, on `POST /charge`, after 412ms, because
Stripe timed out, on the second retry, for user 1042, in request
`8f3c1d2e`. Now I can `jq` this, count it, group it, and — most importantly —
pull every line from that one request:

```bash
journalctl -u api.service -o cat --since "09:40" | jq -c 'select(.request_id=="8f3c1d2e")'
```

## What to log at each level

**Log levels** are a promise about who needs to act, not about how important the
code feels. Break that promise and everything becomes `info` and you are back to
grepping.

| Level | Means | Examples |
| --- | --- | --- |
| `debug` | Off in production, on when you are hunting | cache keys, SQL, branch taken |
| `info` | Normal state change, worth a record | startup, config loaded, deploy id, job finished |
| `warn` | Recoverable, someone should glance | retry, deprecation, fallback path taken |
| `error` | An operation failed, a human may need to act | charge failed, DB unreachable |
| `fatal` | The process is going down | can't bind port, invariant violated |

Rules I use:

- **One `info` line per request**, at the end, with `status` and `duration_ms`.
  Not one at the start *and* the end, not one per middleware.
- **`debug` costs nothing when it's off**, so be generous — but never build the
  expensive string unless the level is enabled.
- **`error` should be rare enough to alert on.** If it is normally 4,000/hour, a
  real signal is hidden in the noise.

### What never to log

Not negotiable:

- **Secrets**: API keys, bearer tokens, passwords, session cookies, private
  keys, connection strings with embedded credentials.
- **PII**: raw emails, names, phone numbers, addresses, card numbers, national
  IDs. Log an internal `user_id`; join to the PII elsewhere.
- **Giant payloads**: full request/response bodies, base64 blobs, full HTML,
  every row of a query result. They blow up disk, cost, and readability at once.
- **Unbounded user input**: raw query strings, headers, `User-Agent`, filenames.

Two habits make it survivable:

1. **Redact at the logger, not at every call site.** A formatter that drops or
   masks known-sensitive keys (`authorization`, `password`, `token`, `cookie`)
   catches the line a tired colleague adds.
2. **Log identifiers, not values.** `user_id`, `order_id`, `request_id` are
   safe and tiny — and usually all you actually need.

## Correlation ids, and how to propagate them

A **correlation id** (also `request_id`, `trace_id`) is a random string that
identifies one logical request and appears on *every* log line that request
touches. It is the single highest-leverage field you can add.

The pattern, from the diagram above:

1. **Mint it at the edge.** Your reverse proxy generates an id if the client did
   not send one, and always sets it on the way in. In nginx:

   ```nginx
   map $http_x_request_id $req_id {
       default $http_x_request_id;
       ""      $request_id;
   }
   add_header X-Request-ID $req_id always;
   proxy_set_header X-Request-ID $req_id;
   ```

2. **Bind it in the app.** Read the header once, attach it to your logger, and
   never pass it around by hand. All three ecosystems carry request-scoped
   context without threading an argument: `contextvars` in Python,
   `context.Context` in Go, `AsyncLocalStorage` in Node.
3. **Forward it downstream.** Copy the header on every outbound HTTP call. For a
   database, set `application_name` to the id so slow-query logs line up. If you
   already use W3C **traces**, reuse `traceparent` instead of a second scheme.
4. **Trust, but sanitize.** Accept a client-supplied id only if it matches a
   cheap pattern (hex, length-bounded). Otherwise a malicious client can inject
   newlines or forge correlation.

The payoff is the query from earlier: one id from a bug report, one
`journalctl ... | jq`, the whole story.

## The journald reality

On a normal Linux box your app writes JSON to stdout and **journald** stores it.
It is free, already installed, and has binary search — but it is not a log
*aggregator*, and it knows nothing about your JSON keys. What it gives you:

- **Metadata for free**: `PRIORITY`, `_PID`, `_SYSTEMD_UNIT`, `_COMM`,
  `SYSLOG_IDENTIFIER`, `__REALTIME_TIMESTAMP`, and the boot id.
- **`-o json` to get it out** as one JSON object per line, which you then shape
  with `jq`:

  ```bash
  journalctl -u api.service -o json --since "1 hour ago" \
    | jq -r 'select(.PRIORITY=="3") | .MESSAGE | fromjson
             | "\(.ts) \(.route) \(.status) \(.err)"'
  ```

  Note the `.MESSAGE | fromjson`: journald wrapped your JSON in its own JSON, so
  you unwrap your line out of the `MESSAGE` field. Other useful modes: `-o cat`,
  `-o json-pretty`, `-f`, `-p err`, `-b`, `--utc`.
- **Retention you must set yourself.** By default journald may be volatile or
  capped small, and *older logs rotate away exactly when you need them*. Pin it:

  ```ini
  [Journal]
  Storage=persistent
  SystemMaxUse=2G
  MaxRetentionSec=2week
  ```

  Then `journalctl --disk-usage` to see reality and `journalctl --vacuum-time=2week`
  to reclaim. This is the same disk-pressure problem I described in
  [Monitoring a small fleet](/posts/monitoring-a-small-fleet/) — logs are the
  quiet contributor.
- **Rate limiting.** journald drops messages under a burst (default ~10k per 30s
  per service) and tells you only via a `Suppressed N messages` entry. Log
  per-row in a loop and you lose exactly the lines you want. Tune
  `RateLimitIntervalSec`/`RateLimitBurst` — or better, stop logging in the loop.

If you need a real correlation id *as a journald field* (so you can
`journalctl CORRELATION_ID=8f3c...`), emit it via the native protocol —
`systemd.journal` from Python, `sd_journal_send` from C, or a service
`LogExtraFields=` line. Otherwise `-o json | jq` is fine and cheaper.

## Sampling and cost

Logs cost money in three places: **disk** and retention, **CPU** in your app,
and **egress** once you ship them. The instinct is to log everything; the
correct move is to keep the useful fraction.

- **Always keep errors and warnings.** These are cheap and rare; never sample
  them away.
- **Sample `info` and `debug` by rate, not randomly per line.** Random per-line
  sampling scatters one request across half-logged states. Prefer "log every
  request whose `duration_ms > 500`", or a fixed 1-in-N on hot paths.
- **Cap cardinality.** Don't put `user_id` in a metrics label, and don't log a
  distinct `msg` per code path — both explode your aggregation bill.
- **Aggregate in the app.** A counter and one summary line per minute beats a
  million lines nobody reads.

A rough target: if you cannot afford to keep 14 days of it, you are not
sampling enough.

## The same thing in Python, Go, and Node

You do not write JSON by hand. Every ecosystem has a logger that does it and
manages level and context for you.

**Python** — `structlog`, which gives you key-value calls and per-request context:

```python
import structlog, contextvars, uuid, time

structlog.configure(processors=[
    structlog.contextvars.merge_contextvars,
    structlog.processors.add_log_level,
    structlog.processors.TimeStamper(fmt="iso", utc=True),
    structlog.processors.JSONRenderer(),
])
log = structlog.get_logger()

def handle(request):
    structlog.contextvars.bind_contextvars(
        request_id=request.headers.get("X-Request-ID", uuid.uuid4().hex))
    t0 = time.perf_counter()
    log.info("request start", route=f"{request.method} {request.path}")
    try:
        result = do_work(request)
        log.info("request done", status=200,
                 duration_ms=round((time.perf_counter() - t0) * 1000))
        return result
    except UpstreamTimeout as e:
        log.error("charge failed", status=502, err=str(e), upstream="stripe")
        raise
```

**Go** — the standard library's `log/slog` (1.21+) with a JSON handler. No
dependency needed:

```go
package main

import (
	"context"
	"log/slog"
	"os"
	"time"
)

func main() {
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	log := slog.New(h)

	ctx := context.WithValue(context.Background(), "request_id", "8f3c1d2e")
	t0 := time.Now()
	log.InfoContext(ctx, "request done",
		"request_id", ctx.Value("request_id"),
		"route", "POST /charge",
		"status", 200,
		"duration_ms", time.Since(t0).Milliseconds())
}
```

**Node** — `pino`, fast by default, JSON by default, with child loggers for
context:

```js
import pino from "pino";

const base = pino({ level: process.env.LOG_LEVEL ?? "info" });

export function handle(req, res) {
  const log = base.child({ request_id: req.headers["x-request-id"] ?? crypto.randomUUID() });
  const t0 = performance.now();
  log.info({ route: `${req.method} ${req.url}` }, "request start");
  res.on("finish", () =>
    log.info({ status: res.statusCode, duration_ms: Math.round(performance.now() - t0) },
      "request done"));
}
```

Three different APIs, one output shape: a JSON object per line with the same
field names. That sameness is the whole point — your `jq` queries, your alerts,
and your grep habits work across all three, and across machines. My
[Go for network tools](/posts/go-for-network-tools/) notes and my piece on
[load average](/posts/linux-load-average/) lean on the same "small tools,
readable output" instinct.

## The one-sentence version

Print tells a human a story; **structured logging** gives a machine facts.
Log constants in `msg`, put the variables in fields, give every request a
**correlation id**, keep error lines rare and honest, never log secrets or
payloads, and let **journald** hold the disk while you query it with `-o json`.
Do that much and 3am stops being a guessing game.
