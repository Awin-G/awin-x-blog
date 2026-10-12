---
title: "Rate limiting beyond a counter: token buckets, nginx limit_req, HTTP 429"
description: "One counter per IP is not rate limiting. A practical guide to what you are actually protecting, why fixed and sliding windows fail, how a token bucket handles bursts, where to enforce, how to rate limit without Redis, and how to return an honest 429 with Retry-After."
pubDate: 2026-11-17
lang: en
translationKey: rate-limiting
tags: [devops, networking, python]
featured: false
keywords:
  - rate limiting
  - token bucket
  - nginx limit_req
  - HTTP 429
  - sliding window
---

Every tutorial starts the same way: a `dict` of IPs, an `if hits > N: reject`, and a claim the problem is solved. Then a whole NAT'd office of two hundred people cannot log in because one of them was scraping, and you learn that **rate limiting** is not a counting problem. It is a question of what you are protecting, who shares an identity, and what you do when you get it wrong. A **token bucket** handles the burst a flat counter cannot, **nginx limit_req** handles cheap enforcement, and an honest **HTTP 429** answers "am I blocking a real person?" None of the three is a counter.

## What rate limiting is actually protecting against

Before picking an algorithm, name the enemy. These are not the same problem.

- **Abuse.** Credential stuffing, spam signups, brute-forcing a token. *Many cheap requests from many sources*; limit tightly per identity.
- **Scraping.** A client pulling your catalog faster than any human. The signal is *volume per account over hours*, which a per-second counter never sees.
- **Expensive endpoints.** One request to `/export` running a 30-second query. The right protection is a low concurrency cap, not a request rate.
- **Accidental loops.** A retry with no backoff, a client polling in `while true`, a partner retrying a 500 forever. Here the "attacker" is your own user, and a hard limit is a kindness.

"100 requests per minute per IP" is a single number pretending to cover all four. It will be too loose for `/export`, too strict for pagination, and blind to a scraper that stays under it on purpose.

## Why one counter per IP fails

The per-IP counter is the default because it is easy, not because it is right. It breaks in three predictable ways:

- **Shared NAT.** A company, a school, a mobile carrier's CGNAT — thousands of real users, one egress IP. You throttle all of them for one bad actor.
- **Distributed clients.** Anyone motivated has a proxy pool; ten thousand IPs at one request each is trivial. Per-IP limits cost the attacker nothing.
- **Bursty legitimate use.** A dashboard firing twenty XHRs on load is one user doing normal things; a per-second counter sees a spike and rejects half.

A fourth, quieter one: **IPv6**. One subscriber controls a `/64` — billions of addresses — so a per-IP limit that was tight under IPv4 is free to bypass.

## The algorithms: fixed window, sliding window, token bucket, leaky bucket

### Fixed window

Divide time into buckets (say, per minute) and count per bucket. Cheap — one integer, one TTL. The flaw is the boundary: 100 requests at 12:59:59 and 100 at 13:00:00 is a 200-request burst in two seconds.

### Sliding window

Two fixes, both trading accuracy for memory.

- **Sliding window log** stores every request timestamp and counts those inside the last N seconds. Exact, but memory grows with the limit — fine for a few expensive endpoints, wasteful for millions of keys.
- **Sliding window counter** keeps the current and previous window counts and interpolates: `prev * (1 - elapsed/window) + current`. The usual compromise: a few bytes per key, no boundary cliff, a small approximation you will never notice.

### Token bucket

A bucket holds up to `capacity` tokens and refills at a steady `rate`. Each request costs a token; no token, no request. Two knobs instead of one: `rate` is the long-term average, `capacity` is the burst you tolerate. This matches reality, because real traffic is bursty. It is the one I reach for by default.

<figure>
<svg viewBox="0 0 604 180" width="100%" role="img" aria-label="A token bucket over time: tokens refill at a fixed rate up to a capacity ceiling, and requests consume tokens in bursts.">
  <g stroke="currentColor" stroke-width="1" opacity="0.25" fill="none">
    <line x1="60" y1="30" x2="584" y2="30"/>
    <line x1="60" y1="150" x2="584" y2="150"/>
    <line x1="60" y1="30" x2="60" y2="150"/>
  </g>
  <polyline fill="none" stroke="currentColor" stroke-width="2"
    points="60,150 180,30 180,78 300,30 300,90 420,30 420,126 540,30 540,54 584,30"/>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" opacity="0.85">
    <text x="636" y="34" text-anchor="end">capacity</text>
    <text x="636" y="154" text-anchor="end">0</text>
    <text x="66" y="170" font-family="system-ui, sans-serif">time →</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12" opacity="0.7">
    <text x="200" y="20" text-anchor="middle">refill</text>
    <text x="430" y="150" text-anchor="middle">burst of 8 consumes immediately</text>
  </g>
</svg>
<figcaption>A token bucket refills linearly to a ceiling; a burst spends the savings at once. The <code>rate</code> sets the long-term average, the <code>capacity</code> sets how much burst you forgive.</figcaption>
</figure>

### Leaky bucket

The mirror image: requests drip out at a fixed rate, and anything over capacity is dropped or queued. You buy a perfectly smooth output rate with latency for the queued requests. Use it when a slow *downstream* needs smoothing, not when you care about response time.

## Where to enforce: edge, app, or key

You can limit in three places, and each sees a different thing.

- **At the edge (nginx, a CDN, a load balancer).** Cheapest — it rejects before your app wakes — but it sees only `$binary_remote_addr` and maybe a header. Good for blunt per-IP floods, useless for per-user fairness because it does not know who is authenticated.
- **In the app.** Slower, but it knows the account, endpoint, plan, and cost. This is where "free tier gets 60/min, paid gets 6000/min" lives.
- **Per key vs per IP vs per user.** Prefer the strongest identity you have. `$binary_remote_addr` is a transport fact; an API key or user ID is a business fact. Limit on the business fact and you survive NAT, CGNAT, and IPv6 rotation. Fall back to IP only for unauthenticated routes like login.

A layered setup is normal: a loose per-IP limit at the edge, a strict per-user limit in the app, and a separate concurrency cap on endpoints that actually cost money.

## nginx limit_req: blunt, cheap, and enough for a lot

`limit_req` is a leaky bucket using `$binary_remote_addr` by default. Two parameters do all the work: `burst` (how much over the rate is tolerated) and `nodelay` (serve the burst immediately instead of spacing it out, which would add latency to a real user's page load).

```nginx
# /etc/nginx/conf.d/rate-limit.conf
limit_req_zone $binary_remote_addr zone=perip:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=expensive:10m rate=1r/s;
limit_req_status 429;

server {
    location /api/ {
        limit_req zone=perip burst=20 nodelay;
        proxy_pass http://app;
    }

    # A different bucket for the endpoint that costs 30 seconds of CPU.
    location /api/export/ {
        limit_req zone=expensive burst=2 nodelay;
        proxy_pass http://app;
    }
}
```

The `10m` zone holds roughly 160k IPs; if it fills, old entries are evicted, not dropped. Note what nginx does *not* do: its `429` carries no `Retry-After`. Compute one in the app, or approximate it with `add_header Retry-After 1 always;` — an honest guess beats a missing header.

## Rate limiting without Redis on a small service

Redis is the reflex answer for a shared counter, and for a fleet it is correct. For a single small service it is a dependency, a failure mode, and a latency hop you may not need. My default order:

1. **In-process first.** One process, one `dict` of token buckets. No network, no SPOF. Wrong the moment you run a second instance — exactly right if you run one, and it is ten lines.
2. **A shared store when you scale out.** Add Redis only when you have more than one process: use it for the global ceiling while keeping the in-process bucket as a cheap first filter. The store is consulted only when a request is already suspicious.

```python
import time

class TokenBucket:
    """Lazy refill: no background timer, just arithmetic on each call."""
    def __init__(self, capacity, refill_per_sec):
        self.capacity = capacity
        self.rate = refill_per_sec
        self.tokens = capacity
        self.updated = time.monotonic()

    def allow(self, cost=1.0):
        now = time.monotonic()
        # Refill for elapsed time, capped at capacity — that cap IS the burst allowance.
        self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
        self.updated = now
        if self.tokens >= cost:
            self.tokens -= cost
            return True, 0.0
        # Not enough tokens: tell the caller how long until this request fits.
        wait = (cost - self.tokens) / self.rate
        return False, wait
```

`allow()` returns both the verdict and a `Retry-After` value — the whole reason to prefer a token bucket over a counter: the wait time falls out of the math instead of being invented.

When you add a shared store, keep it dumb: an atomic fixed-window counter as a coarse global ceiling, checked only after the local bucket says yes. If it is down, fail open — losing your global limit for a minute beats taking the whole service down with Redis.

```python
class Limiter:
    def __init__(self, shared=None):
        self.shared = shared          # redis client, or None
        self.local = {}               # key -> TokenBucket, per process

    def allow(self, key, cost=1.0):
        bucket = self.local.setdefault(key, TokenBucket(20, 10))
        ok, wait = bucket.allow(cost)
        if not ok:
            return False, wait
        if self.shared is None:
            return True, 0.0
        # Coarse global ceiling only after the cheap local check passed.
        window = int(time.time()) // 60
        k = f"rl:{key}:{window}"
        count = self.shared.incr(k)
        if count == 1:
            self.shared.expire(k, 120)   # forget the window after it ends
        if count > 600:
            return False, 60 - (time.time() % 60)
        return True, 0.0
```

## Returning a correct HTTP 429 with Retry-After

A bare `429` is a load amplifier: a client that gets one retries immediately and makes the flood worse. **HTTP 429** exists so you can tell it to back off.

```
HTTP/1.1 429 Too Many Requests
Retry-After: 3
RateLimit-Limit: 10
RateLimit-Remaining: 0
RateLimit-Reset: 3
Content-Type: application/json

{"error": "rate_limited", "retry_after": 3}
```

`Retry-After` takes seconds or an HTTP date; seconds are easier and right for short windows. The `RateLimit-*` fields (IETF draft convention) let a good client throttle *before* it is rejected. Match the wait you send to the wait `allow()` computed, and be consistent between edge and app — two different `Retry-After` values for one limit is worse than none.

## The failure mode: rate-limiting yourself and blocking real users

The dangerous failure is not under-limiting; it is a limit that quietly rejects the people you wanted. Ways I have done exactly that:

- **Limiting by IP behind a CDN.** Every request arrives from the CDN's edge IPs, so you throttle your own proxy. Trust only the CDN's ranges and its real-client-IP header, never `X-Forwarded-For` blindly.
- **One bucket for many routes.** Login and reads sharing a bucket logs out users who merely have the page open. Scope limits to the route.
- **Limiting retries that are safe to retry.** A `429` on top of a failed charge is the worst answer — that is what [idempotency keys](/posts/idempotency-keys/) are for.
- **Forgetting health checks and internal traffic.** Your own monitor tripping the limit turns a healthy service into a "down" alert.
- **No observability.** If you cannot see how often you return `429` and to whom, you are guessing. Alert on the rejection ratio, not the raw count.

And the sneaky one: **rate-limiting yourself**. An aggressive in-process limit on a service that fans out internally — a worker calling its own API — will throttle your own traffic. Whitelist loopback callers and test with realistic bursts.

## What I do now

- Name the threat first, then choose the number: abuse, scraping, cost, and loops want different limits.
- Default to a **token bucket** — `rate` for the average, `capacity` for the burst — and limit on user or API key before IP.
- Use **sliding window** only when I must count per-unit-time, accepting the counter's approximation over the log's memory cost.
- Enforce blunt floods with **nginx limit_req** at the edge, per-user fairness in the app, and keep it in-process until I run more than one instance.
- Always return **429** with a `Retry-After` derived from the math that rejected the request, and watch the rejection rate as a first-class metric.

A rate limit that blocks real users is an outage with extra steps. If you want to know how fast a protected endpoint can be replayed before it pushes back, that is what [reverse-engineering a private API](/posts/reverse-engineering-a-private-api/) teaches — and it tells you whether your limit is a wall or a suggestion. A counter per IP is neither. Build the one that matches the threat.
