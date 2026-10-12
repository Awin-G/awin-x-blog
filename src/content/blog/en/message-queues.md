---
title: "Do you actually need a message queue? pub/sub vs work queues, NATS, and RabbitMQ vs Kafka"
description: "Message queues answer every scaling question and usually are the wrong one. I ran throwaway NATS, RabbitMQ, and Postgres to show what a queue buys: pub/sub fan-out, a work queue with competing consumers, at-least-once redelivery into a dead letter queue, and a SQL table with FOR UPDATE SKIP LOCKED."
pubDate: 2026-12-10
lang: en
translationKey: message-queues
tags: [devops, networking]
featured: false
keywords:
  - message queue
  - pub/sub
  - NATS
  - RabbitMQ vs Kafka
  - at-least-once
---

**Message queue** is the default answer to every scaling question, and usually the wrong one. Adding NATS, RabbitMQ, or Kafka to a small system buys you a second distributed system to run, monitor, and get paged on — often to move work a table and a worker loop would have handled. This is the honest version: what a **message queue** solves, what you can do without one (a SQL table with `FOR UPDATE SKIP LOCKED`, an in-process channel, cron), the three real shapes (**pub/sub** versus work queue versus log), **at-least-once** versus exactly-once, and a decision guide across Redis, **NATS**, RabbitMQ, and Kafka. Every command below ran against throwaway containers, output pasted verbatim.

## What a message queue actually solves

A queue sits between a producer that has work and a consumer that does it. That indirection *is* the product, and it does five things:

- **Decouple** producer and consumer so neither must know the other is up, fast, or even written yet.
- **Absorb spikes** — a burst of 10,000 requests lands in the queue and drains at a rate the database can survive.
- **Retry** failed work without losing it, on the queue's schedule rather than the request's.
- **Fan out** one event to many independent consumers (billing, search index, email).
- **Move work off the request path**, so the user gets a response before the slow part runs.

Name which of the five you need before installing anything. If you cannot, the queue is pure overhead: another highly available system, another dashboard, another pager.

## What you can do without a message queue

### A database table is usually enough

The oldest queue in your stack is the table you already have. Keep a `jobs` table, let workers claim rows, and use `FOR UPDATE SKIP LOCKED` so two workers never grab the same row. Postgres, MySQL 8, and SQLite support it directly:

```sql
CREATE TABLE jobs (
  id      serial PRIMARY KEY,
  status  text NOT NULL DEFAULT 'pending',
  payload text NOT NULL
);
INSERT INTO jobs (payload) SELECT 'job-' || g FROM generate_series(1, 5) g;
```

Here it is for real, in two concurrent `psql` sessions: worker A claims two rows and holds the transaction open; a second later worker B runs the same query:

```text
-- worker A: claim up to 2 rows, then sleep 4s before committing
BEGIN;
SELECT id, payload FROM jobs
 WHERE status = 'pending'
 ORDER BY id
   FOR UPDATE SKIP LOCKED
 LIMIT 2;
 id | payload
----+---------
  1 | job-1
  2 | job-2
(2 rows)

-- worker B runs the SAME query at the same moment.
-- It does not block: SKIP LOCKED makes it ignore the rows A holds.
 id | payload
----+---------
  3 | job-3
  4 | job-4
(2 rows)
```

Worker A commits `UPDATE jobs SET status = 'done' WHERE id IN (1, 2)`, and the table ends up as you would hope:

```text
 id | status  | payload
----+---------+---------
  1 | done    | job-1
  2 | done    | job-2
  3 | pending | job-3
  4 | pending | job-4
  5 | pending | job-5
```

The reason this is often genuinely enough:

- **The claim is transactional with your business writes.** Marking a job done and writing the order row commit together, or not at all; with an external broker that becomes a distributed transaction.
- **You already run, back up, and monitor it.** No new HA system, no new dashboard.
- **Retries are a column.** `attempts = attempts + 1`, back off with `next_run_at`, and a **dead letter queue** is just `status = 'dead'` plus a query.

Its limits are real too: polling adds latency, a hot table means lock contention and `VACUUM` bloat, there is no push, and throughput is capped by one primary. Past a few hundred jobs per second, or when you need fan-out to many services, it sends you shopping.

### An in-process channel

If the work never needs to survive a restart, a channel is a queue:

```go
// an in-process queue: no network, no broker, no serialization
jobs := make(chan Job, 1024)
for i := 0; i < 4; i++ {          // four workers, one channel
    go func() {
        for j := range jobs {
            process(j)
        }
    }()
}
jobs <- Job{ID: 8842}             // producer
```

Backpressure comes free: when the buffer fills, the producer blocks — exactly the signal you want. The trade-off: when the process exits, every queued job is gone, and retries across restarts are yours to solve.

### Cron, for periodic work

Much "queue" work is really "do this every N minutes". A `systemd` timer or cron job that scans for due work and processes it idempotently needs no broker and no worker daemon — as long as the job is safe to run twice, which is a property of the consumer. How to make it safe: [idempotency keys](/posts/idempotency-keys/).

## The three shapes: work queue, pub/sub, and log

"Message queue" names three different things, and picking the wrong one is where the pain lives.

<figure>
<svg viewBox="0 0 720 200" width="100%" role="img" aria-label="Three messaging shapes side by side. A work queue delivers each message to exactly one of several competing workers. pub/sub fans every message out to every subscriber, each getting its own copy. A log stores an ordered, retained sequence that independent readers can each read at their own offset.">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11">
    <text x="10" y="16" font-size="13" font-weight="600">Work queue</text>
    <rect x="10" y="40" width="62" height="28" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="41" y="58" text-anchor="middle">producer</text>
    <path d="M72 54 L96 54" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <rect x="96" y="30" width="34" height="60" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <line x1="96" y1="50" x2="130" y2="50" stroke="currentColor" stroke-width="1"/>
    <line x1="96" y1="70" x2="130" y2="70" stroke="currentColor" stroke-width="1"/>
    <path d="M130 40 L160 40" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <path d="M130 60 L160 60" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <path d="M130 80 L160 80" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <rect x="160" y="30" width="62" height="20" rx="4" fill="none" stroke="currentColor"/>
    <text x="191" y="44" text-anchor="middle">worker 1</text>
    <rect x="160" y="50" width="62" height="20" rx="4" fill="none" stroke="currentColor"/>
    <text x="191" y="64" text-anchor="middle">worker 2</text>
    <rect x="160" y="70" width="62" height="20" rx="4" fill="none" stroke="currentColor"/>
    <text x="191" y="84" text-anchor="middle">worker 3</text>
    <text x="10" y="118" opacity="0.75">each message → ONE worker</text>

    <text x="250" y="16" font-size="13" font-weight="600">pub/sub</text>
    <rect x="250" y="74" width="62" height="28" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="281" y="92" text-anchor="middle">producer</text>
    <path d="M312 88 L336 88" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <rect x="336" y="74" width="46" height="28" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="359" y="92" text-anchor="middle">topic</text>
    <path d="M382 88 L412 44" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <path d="M382 88 L412 88" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <path d="M382 88 L412 132" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <rect x="412" y="34" width="60" height="20" rx="4" fill="none" stroke="currentColor"/>
    <text x="442" y="48" text-anchor="middle">sub A</text>
    <rect x="412" y="78" width="60" height="20" rx="4" fill="none" stroke="currentColor"/>
    <text x="442" y="92" text-anchor="middle">sub B</text>
    <rect x="412" y="122" width="60" height="20" rx="4" fill="none" stroke="currentColor"/>
    <text x="442" y="136" text-anchor="middle">sub C</text>
    <text x="250" y="118" opacity="0.75">each message → EVERY subscriber</text>

    <text x="500" y="16" font-size="13" font-weight="600">log / stream</text>
    <rect x="500" y="46" width="42" height="30" fill="none" stroke="currentColor"/>
    <rect x="542" y="46" width="42" height="30" fill="none" stroke="currentColor"/>
    <rect x="584" y="46" width="42" height="30" fill="none" stroke="currentColor"/>
    <rect x="626" y="46" width="42" height="30" fill="none" stroke="currentColor"/>
    <rect x="668" y="46" width="42" height="30" fill="none" stroke="currentColor"/>
    <text x="521" y="65" text-anchor="middle">1</text>
    <text x="563" y="65" text-anchor="middle">2</text>
    <text x="605" y="65" text-anchor="middle">3</text>
    <text x="647" y="65" text-anchor="middle">4</text>
    <text x="689" y="65" text-anchor="middle">5</text>
    <path d="M521 100 L521 76" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <text x="521" y="114" text-anchor="middle">reader A</text>
    <path d="M626 100 L626 76" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <text x="626" y="114" text-anchor="middle">reader B</text>
    <path d="M626 132 C 626 156, 521 156, 521 132" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#ar)"/>
    <text x="573" y="164" text-anchor="middle" opacity="0.75">replay</text>
    <text x="500" y="186" opacity="0.75">retained + ordered: each reader has its own offset</text>

    <defs>
      <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
        <path d="M0 0 L8 4 L0 8 z" fill="currentColor"/>
      </marker>
    </defs>
  </g>
</svg>
<figcaption>Three shapes, three guarantees. A work queue means "someone handles it once"; pub/sub means "everyone who cares gets a copy"; a log means "it is still there and you can re-read it".</figcaption>
</figure>

### Work queue: one consumer per message

Also called competing consumers: you publish a job, any one worker picks it up and finishes it. Add workers and throughput rises with no coordination. This is the shape for background jobs, emails, thumbnails, and the SQL table above.

### pub/sub: every subscriber gets a copy

The publisher has no idea who is listening. One `order.created` event reaches billing, the search indexer, the email service, and an audit log, each at its own pace, and new consumers are added without touching the producer. The catch: pub/sub alone has no memory. If a subscriber is down when the message goes out, it is gone — durability is a separate switch.

### Log/stream: ordered and replayable

A log is an append-only sequence with offsets. Readers do not consume and delete; they advance a cursor, or rewind it. That buys replay (rebuild a search index), fan-out to independent consumers, and retention as a policy — and the most operational machinery, because those offsets and that retention must live somewhere.

## NATS in practice: pub/sub and queue groups

NATS is small, fast, and has one of the cleanest mental models: subjects, and queue groups on those subjects. I ran `nats-server v2.10.29` with JetStream and pointed the `nats` CLI at it.

First, plain **pub/sub** — two subscribers on one subject, one publish, both receive it:

```text
$ nats sub demo.audit        # subscriber A
$ nats sub demo.audit        # subscriber B
$ nats pub demo.audit 'order.created id=8842'
09:08:12 Published 21 bytes to "demo.audit"

# subscriber A
09:08:10 Subscribing on demo.audit
[#1] Received on "demo.audit"
order.created id=8842

# subscriber B
09:08:10 Subscribing on demo.audit
[#1] Received on "demo.audit"
order.created id=8842
```

Now the work queue. Same subject, but the subscribers join a **queue group** with `--queue`. Six jobs to three workers; each job goes to exactly one:

```text
$ nats sub demo.jobs --queue workers   # worker-1, worker-2, worker-3
$ for i in 1 2 3 4 5 6; do nats pub demo.jobs "job-$i"; done

# worker-1: job-3, job-5, job-6
# worker-2: job-1, job-2
# worker-3: job-4
```

Six published, six delivered, none doubled — the 3 / 2 / 1 split is how the broker distributed them. That is the whole difference between the shapes: drop `--queue` for fan-out, keep it for a work queue, in the same product.

## RabbitMQ vs Kafka, and where Redis fits

### RabbitMQ: a smart broker, dumb consumers

RabbitMQ is the classic work-queue broker: declare queues, bind them to exchanges, consumers compete. I ran `rabbitmq:3.13.7` with a tiny `pika` producer/consumer pair — six durable jobs, a seventh "poison" job the consumer rejects, and a dead-letter exchange routing it to `jobs.dlq`.

```text
# two competing consumers on the SAME queue, draining six jobs
worker-1: ack        job-1
worker-1: ack        job-3
worker-1: ack        job-5
worker-1: NACK -> DLQ  job-BOOM
worker-2: ack        job-2
worker-2: ack        job-4
worker-2: ack        job-6
```

One message that never succeeds does not wedge the queue; it is `NACK`ed without requeue and lands in the **dead letter queue**, visible as an ordinary queue:

```text
$ rabbitmqctl list_queues name messages messages_ready messages_unacknowledged
name      messages  messages_ready  messages_unacknowledged
jobs.dlq  1         1               0
jobs      0         0               0
```

That `jobs 0 / jobs.dlq 1` is the whole point of a broker: routing, acknowledgement, redelivery, and a parking lot for poison messages, all first-class with a dashboard. RabbitMQ fits when you want rich routing and modest ceremony, at modest message *rate*.

### Kafka: a log, and the operations to match

Kafka is a distributed, partitioned log, not a queue. Topics retain for a configured time, consumers track offsets within a group, ordering holds inside a partition. It shines at high-throughput streams, replay, and many independent readers of the same data. So "**RabbitMQ vs Kafka**" is not a fair fight: RabbitMQ delivers each message once; Kafka keeps a durable, replayable history. Run Kafka when you need that history and throughput; for ten thousand jobs a day it is a large machine to feed.

### Redis: fast, and honest about it

Redis is the smallest step up from the in-process channel. `LPUSH`/`BRPOP` is a work queue, `PUBLISH`/`SUBSCRIBE` is best-effort pub/sub, and Streams (`XADD`/`XREADGROUP` plus `XACK`) give consumer groups and a durable log. In-memory first: excellent at coordination, terrible as a system of record. I covered the queue-versus-stream trade-off and persistence caveats in [Redis patterns that earn their place](/posts/redis-patterns/).

## at-least-once, exactly-once, and idempotent consumers

The honest delivery promise is **at-least-once**: a message will be delivered, but a retry or redelivery can hand it to a consumer twice. Exactly-once is mostly a story about a *transaction boundary*, not the network.

I made the redelivery real on JetStream: a pull consumer with `--max-deliver 3` and a 2-second ack window, receiving but never acknowledging.

<figure>
<svg viewBox="0 0 700 170" width="100%" role="img" aria-label="An at-least-once delivery loop: the broker delivers a message, the consumer processes it, then tries to acknowledge. If the ack never arrives before the visibility timeout, the broker redelivers it. After the maximum number of attempts the message is moved to a dead letter queue.">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <rect x="20" y="60" width="120" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="80" y="80" text-anchor="middle">broker stores</text>
    <text x="80" y="96" text-anchor="middle" opacity="0.75">the message</text>
    <rect x="280" y="60" width="150" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="355" y="80" text-anchor="middle">consumer processes</text>
    <text x="355" y="96" text-anchor="middle" opacity="0.75">then sends ack</text>
    <path d="M140 82 L276 82" stroke="currentColor" stroke-width="1.5" marker-end="url(#b)"/>
    <text x="208" y="74" text-anchor="middle" font-size="11">deliver</text>
    <path d="M280 118 C 200 150, 160 150, 120 128" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#b)"/>
    <text x="200" y="160" text-anchor="middle" font-size="11">no ack → redeliver</text>
    <rect x="490" y="60" width="180" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="580" y="80" text-anchor="middle">dead letter queue</text>
    <text x="580" y="96" text-anchor="middle" opacity="0.75">after max attempts</text>
    <path d="M430 82 L486 82" stroke="currentColor" stroke-width="1.5" marker-end="url(#b)"/>
    <text x="458" y="74" text-anchor="middle" font-size="11">give up</text>
    <defs>
      <marker id="b" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
        <path d="M0 0 L8 4 L0 8 z" fill="currentColor"/>
      </marker>
    </defs>
  </g>
</svg>
<figcaption>at-least-once with a bounded number of attempts. The loop is the feature; the dead letter queue is where the loop stops.</figcaption>
</figure>

```text
$ nats pub demo.orders 'charge-card order=8842 amount=19.99'
09:08:39 Published 35 bytes to "demo.orders"

$ nats consumer next ORDERS worker --no-ack --timeout 5s   # attempt 1
[09:08:39] subj: demo.orders / tries: 1 / cons seq: 1 / str seq: 1
charge-card order=8842 amount=19.99

$ nats consumer next ORDERS worker --no-ack --timeout 5s   # attempt 2 (redelivery)
[09:08:41] subj: demo.orders / tries: 2 / cons seq: 2 / str seq: 1
charge-card order=8842 amount=19.99

$ nats consumer next ORDERS worker --no-ack --timeout 5s   # attempt 3 (again)
[09:08:43] subj: demo.orders / tries: 3 / cons seq: 3 / str seq: 1
charge-card order=8842 amount=19.99

$ nats consumer next ORDERS worker --no-ack --timeout 3s   # attempt 4
nats: error: no message received: nats: timeout
```

Read the same `str seq: 1` on all three lines: one message, delivered three times, because the consumer never acked. At `max-deliver=3` the broker stops handing it out — and the stream still holds it (`"messages": 1`), so it is parked, not lost. That is **at-least-once** in one screenshot, and the reason your consumer must be idempotent: give each unit of work a unique key and make reprocessing a no-op — mechanics in [idempotency keys](/posts/idempotency-keys/).

Exactly-once, when advertised, means the broker plus a transactional consumer deduplicate *within one system* — Kafka transactions, or a dedup table. The moment work leaves that boundary for an email API or a payment processor, you are back to at-least-once plus idempotence. Plan for the retry.

## The operational cost: another highly available system

This is the part that never makes the slide. Every broker is a system that can fail on its own:

- **Availability.** One NATS node is a single point of failure; a three-node cluster is a quorum to reason about, upgrade one at a time, and watch. Your queue's uptime becomes your app's uptime.
- **Disk and retention.** A log retains; a queue fills. Someone must decide what happens when the volume fills.
- **Monitoring and alerting** — queue depth, consumer lag, redelivery rate, dead letter count. Queue depth growing is the first sign of trouble; you want an alert, not an incident-time discovery.
- **Backpressure.** A fast producer against a slow consumer grows the queue without bound. In-process it is free (the producer blocks); across a broker you choose a policy — pause, drop, or shed load at the edge.
- **Poison messages and dead letter queues.** One message requeued forever keeps a worker busy until it is moved aside. That is what the DLQ is for; it also needs an owner, because an unread DLQ is a data loss you did not notice.
- **Upgrades and migrations** of yet another stateful service, with its own compatibility rules.

None of this argues against brokers. It argues against them *until the problem they solve is actually your problem*.

## A decision guide

- **A table with `SKIP LOCKED`** — default for one application, work that fits in one primary, jobs transactional with your data.
- **An in-process channel** — work that can be lost on restart, or free backpressure inside one process.
- **Redis** — already running, high throughput, and losing a few queued items on failure is acceptable. Move to Streams for consumer groups and acks.
- **NATS** — a small, fast broker with clean pub/sub and work queues in one product, at a tiny operational footprint.
- **RabbitMQ** — rich routing (exchanges, bindings, priorities) and per-message acks plus dead letter queues as first-class features, at moderate message rate. The "**RabbitMQ vs Kafka**" choice usually resolves here unless you need history.
- **Kafka** — a durable, replayable, ordered log at high throughput with many independent consumers. Pay for it only when you need it.

## The short version

A **message queue** decouples, absorbs spikes, and buys retries and fan-out; it costs another distributed system to run. Start with the table you already have and `FOR UPDATE SKIP LOCKED`, and move to a broker when you can name the property you are missing — a lighter footprint feels different from fan-out, which feels different from a replayable log. Pick by shape — work queue, **pub/sub**, or log — and assume **at-least-once** delivery, because your consumer must be idempotent whether the broker is NATS, RabbitMQ, or Kafka.
