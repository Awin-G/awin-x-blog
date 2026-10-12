---
title: "Idempotency keys, explained with real failures (retry safety for APIs)"
description: "The idempotency key pattern, learned the hard way: double charges, duplicate records, and the retry-safety bug behind them. Why networks force retries, how at-least-once delivery makes exactly-once impossible, and a server-side implementation that replays stored results and survives concurrency."
pubDate: 2026-11-10
lang: en
translationKey: idempotency-keys
tags: [devops, self-hosting, python]
featured: false
keywords:
  - idempotency key
  - idempotent API
  - retry safety
  - at-least-once
  - exactly-once
---

The first time I lost money to this bug I did not understand it. A payment request timed out, my code retried, and the customer got charged twice. Nothing in the logs was wrong: both requests succeeded. The server did what it was told, twice, because I never told it the two requests were the same one. That is the whole problem an **idempotency key** exists to solve. An **idempotent API** turns "I might send this twice" into "sending this twice has the same effect as sending it once." Without it, **retry safety** is an illusion and **at-least-once** delivery quietly becomes duplicate writes.

## The class of bug: a retried request charges twice

- A payment times out, the client retries, the customer is charged twice.
- A signup form double-submits, and you get two users with the same email.
- A queue redelivers a message, and an order ships twice.

In each case the request was well-formed, the server logic was correct, and the outcome was still wrong. The failure is not in either request — it is in the gap between them, where the system forgot two identical requests were meant to be one operation. And it only surfaces *after* the network hiccups, exactly when you can least afford it.

## Why networks force retries — and why retry safety needs the server

Here is the uncomfortable truth that makes this unavoidable: **a client cannot reliably know whether a request succeeded.**

From the caller's point of view there are three outcomes, and two look identical:

1. The server got the request, processed it, and you got a `200`.
2. The server got the request, processed it, and the response was lost on the way back.
3. The server never got the request.

Cases 2 and 3 are indistinguishable: you sent bytes and got no response. The only sane reaction to "no response" is to retry — if it was case 3, retrying is correct; if it was case 2, retrying is exactly the double charge. You cannot tell them apart, so you retry, and case 2 becomes a duplicate.

This is not a bug in HTTP; it is a consequence of a network that can drop a packet at any moment. TCP retransmits *segments*, but it knows nothing about your application's semantics: it can tell you a stream of bytes arrived, not that "charge the card" happened once. Timeouts, connection resets, and load balancers killing idle connections all produce the same client-side ambiguity.

Retries are not optional. Clients retry, queues redeliver, load balancers replay — and as I found [reverse-engineering a private API](/posts/reverse-engineering-a-private-api/), replaying requests fast teaches you which endpoints already created the thing you were about to create.

## The idempotency key pattern for an idempotent API

The fix is a contract: the client labels an operation, the server remembers it.

### The client generates the key

Before sending a request that must not be duplicated, the client generates a unique key — usually a UUIDv4 — and puts it in a header:

```
POST /v1/charges
Idempotency-Key: 8f14e45f-ea0b-4c1d-9a2e-2f3b6c7d8e9f
Content-Type: application/json

{"amount": 4200, "currency": "usd", "customer": "cus_123"}
```

The key identifies the *attempt*, not the request. A retry sends the **same** key; a genuinely new charge sends a new one. That is the entire interface: the client changes one header, not its retry logic. But the key must be generated once, before the first attempt, and persisted across retries — a key regenerated per attempt looks like a safeguard and protects nothing.

### The server stores key → result and replays it

On the server:

1. Read the key from the header.
2. Look it up in the store.
3. If it exists **and the operation finished**, return the stored response verbatim — same status, same body. Do not re-run the work.
4. If it exists **and the operation is still running**, return `409 Conflict` (or wait) so the caller does not stack up work.
5. If it does not exist, record the key as `in_progress`, run the operation, store the final status and body, and return.

Step 3 is the heart of it: the retry is not *processed*, it is *answered*.

### Scope the key

A key means nothing in isolation. Scope it to the **account or merchant** (so one tenant cannot collide with another or leak a result across tenants), the **endpoint** (`POST /charges` and `POST /refunds` should not share a namespace), and a **time window**. I use `(account_id, endpoint, key)`. Scope on the key alone and two customers collide, the second replayed a result belonging to the first — a data leak disguised as a feature.

### Handle concurrent duplicates

The case people forget is two requests arriving at once with the same key — a double-submit, or a retry while the first request is still in flight. If the logic is "check, then insert," both requests miss, both run, and you get the double charge. Make the insert itself the lock: a unique constraint (or `INSERT ... ON CONFLICT DO NOTHING`, or a Redis `SET NX`) so only one request can *claim* the key. The loser sees it exists and is `in_progress`, and returns a conflict instead of doing the work. **Concurrency** here is a correctness concern, not a performance one — a check-then-act implementation is a race condition with extra steps.

## Idempotency is not retries, and not at-least-once

These three get used interchangeably and they are not the same thing.

- **Retries** are a client behaviour, forced by an unreliable network. On their own they *create* the duplicate problem.
- **At-least-once** is a delivery guarantee. Queues and webhooks promise every message arrives *at least* once — meaning they may deliver it more than once. They are honest about the network, not about duplicates.
- **Idempotency** is a server property: applying the same operation twice has the same effect as applying it once. It is what makes at-least-once delivery *usable*.

And **exactly-once**? As an end-to-end guarantee across an unreliable network, it does not exist. You build exactly-once *effects* — at-most-once side effects — by combining at-least-once delivery with an idempotent consumer. That is the honest version: not a transport guarantee, but a deduplication layer on top of at-least-once. Anyone selling true exactly-once over a network is selling a name for "at-least-once plus idempotency." Stop trying to prevent retries; make the operation safe to repeat.

## Where to store keys, and for how long

The store must be shared across instances, durable across restarts, and able to enforce that uniqueness.

- **A relational table** is the default: it gives you the unique constraint for free and can sit in the same transaction as the business write.
- **Redis** works well with `SET key value NX EX ttl` for the claim plus a stored result — fast, but it is a cache, so assume loss is possible.
- **In-process memory** is wrong: it breaks with two instances and vanishes on deploy.

Retention is a trade-off. Too short, and a late retry — a queue redelivering an hour later, a mobile client reconnecting overnight — arrives after the key is gone and duplicates the work. Too long, and the table grows without bound. A reasonable default is **24 hours**, aligned with the longest retry window any client is allowed. Stripe's published behaviour is the common reference point: keys are remembered for a bounded window, and reusing a key with a *different* request body is an error, not a silent replay. That rule catches client bugs instead of hiding them. The same request gets the same answer; a different request under the same key is worth rejecting.

## Mistakes that cost me real time

Every one of these I have shipped.

- **Keys that are not unique.** Deriving the key from the request body (`hash(payload)`) looks clever until two legitimate, identical requests — two coffees, same amount, same second — collapse into one charge. The key must identify the *attempt*, not the *content*.
- **Storing nothing.** Sending the key is the easy half. If the server never persists it, the key is decoration — I have seen a client send an `Idempotency-Key` header for months to an endpoint that ignored it.
- **Treating GET as unsafe.** `GET` and `HEAD` are safe and idempotent by definition and must not have side effects. If `GET /orders/42` creates something, the method is lying and no key will save you. Do not force keys onto reads, either — it adds ceremony without safety.
- **Forgetting the key in the response.** If the stored response does not echo the key (or the resource ID), the client cannot correlate a retry with the original result. Echo it — it turns double-submit debugging into a glance instead of forensics.

## A small server-side implementation

Here is the shape I use, in Python. The store is a table with a unique constraint; the claim is the lock.

```python
import json, uuid, hashlib
from datetime import datetime, timedelta

class IdempotencyStore:
    """One row per (account, endpoint, key). Unique constraint = the lock."""

    def claim(self, account_id, endpoint, key, request_fingerprint):
        # INSERT ... ON CONFLICT DO NOTHING RETURNING id
        # Returns a row only if WE won the race; None if someone else holds it.
        row = self.db.execute(
            """
            INSERT INTO idempotency_keys
                (account_id, endpoint, key, fingerprint, state, created_at)
            VALUES (%s, %s, %s, %s, 'in_progress', now())
            ON CONFLICT (account_id, endpoint, key) DO NOTHING
            RETURNING id
            """,
            (account_id, endpoint, key, request_fingerprint),
        ).fetchone()
        return row is not None  # True = we own the operation

    def load(self, account_id, endpoint, key):
        return self.db.execute(
            """SELECT state, fingerprint, status_code, body
               FROM idempotency_keys
               WHERE account_id=%s AND endpoint=%s AND key=%s""",
            (account_id, endpoint, key),
        ).fetchone()

    def finish(self, account_id, endpoint, key, status_code, body):
        self.db.execute(
            """UPDATE idempotency_keys
               SET state='done', status_code=%s, body=%s, finished_at=now()
               WHERE account_id=%s AND endpoint=%s AND key=%s""",
            (status_code, json.dumps(body), account_id, endpoint, key),
        )
```

And the request handler that uses it:

```python
def create_charge(req):
    key = req.headers.get("Idempotency-Key")
    if not key:
        return error(400, "Idempotency-Key required")

    account_id = req.account.id
    endpoint = "POST /v1/charges"
    fingerprint = hashlib.sha256(req.raw_body).hexdigest()

    # 1. Is this key already known?
    existing = store.load(account_id, endpoint, key)
    if existing:
        if existing.fingerprint != fingerprint:
            return error(422, "Idempotency-Key reused with different body")
        if existing.state == "in_progress":
            return error(409, "Request with this key is still in progress")
        # Replay the original result. Do NOT run the charge again.
        return Response(existing.status_code, existing.body)

    # 2. Try to claim it. If we lose the race, someone else is doing the work.
    if not store.claim(account_id, endpoint, key, fingerprint):
        return error(409, "Request with this key is already being processed")

    # 3. We own it. Run the operation exactly once, inside the same
    #    transaction as the business write where possible.
    try:
        result = charge_card(req.json)          # the side effect
        store.finish(account_id, endpoint, key, 201, result)
        return Response(201, result)
    except Exception:
        # A failure that did not commit should free the key so a retry
        # can make progress. A failure *after* commit must not.
        store.release(account_id, endpoint, key)
        raise
```

Two details carry the safety. `ON CONFLICT DO NOTHING` makes concurrent duplicates collapse into one winner instead of two charges. And the fingerprint check turns a client bug — same key, different request — into a loud `422` instead of a silent wrong replay.

## What I do now

- Generate the key on the client, once, before the first attempt, and persist it across retries.
- Store `key → (status, body)` on the server, scoped to account and endpoint, with a unique constraint as the lock.
- Replay the stored result on a duplicate instead of re-running the work.
- Return `409` for a key still in progress; never stack work on the same key.
- Keep keys for a bounded window — I use 24 hours — and reject a reused key with a different body.
- Accept **at-least-once** as the delivery model and build the idempotent consumer on top, instead of chasing a transport-level **exactly-once** that does not exist.

None of this is clever — just enough discipline to move a whole class of "it charged twice" incidents from possible to impossible. The reasoning is identical whether the endpoint is a payment or a self-hosted service, and I keep the latter alive as described in [what I self-host in 2026](/posts/what-i-self-host-2026/). The network will duplicate your requests. Design like you know that.
