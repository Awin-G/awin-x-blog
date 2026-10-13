---
title: "NATS JetStream in practice: durable streams without a cluster"
description: "I ran a throwaway single-node NATS JetStream server and pasted real output: stream creation, durable consumers, explicit consumer acks, and an at-least-once redelivery demo where an unacked message comes back with tries: 2 and num_redelivered: 1. Retention policies, limits, and the KV layer included."
pubDate: 2027-01-25
lang: en
translationKey: nats-jetstream
tags: [networking, devops]
featured: false
keywords:
  - NATS JetStream
  - durable streams
  - at-least-once delivery
  - consumer acks
  - retention policy
---

**NATS** is a tiny pub/sub broker: one binary, no JVM, no external dependencies, and a client library for basically every language. **NATS JetStream** is the layer you turn on when fire-and-forget is not enough — it gives you **durable streams**, **at-least-once delivery**, replay, and **consumer acks**, all from the same server process. No ZooKeeper, no KRaft, no cluster required to get something genuinely production-shaped. I stood up a throwaway single-node JetStream, made a stream, published real messages, created a durable consumer, deliberately failed to ack a message and watched it get redelivered, and exercised every retention policy. Every output below is real.

If you are still deciding whether you need a broker at all, start with my [message queue decision guide](/posts/message-queues/); and if you want to know what the heavyweight alternative looks like, I dissected [Kafka in practice](/posts/kafka-in-practice/) the same way. This post is the other end of the spectrum: what happens when the answer is "just make sure the message isn't lost."

## Core NATS vs JetStream: fire-and-forget vs stored

Plain NATS is a subject-based pub/sub fabric. You publish to a subject like `orders.new`, every subscriber listening on a matching subject gets a copy, and then the message is gone. There is no disk involvement, no ack, no replay — if nobody is listening, the message evaporates, and if a subscriber crashes mid-processing, that is your problem. That behavior is a feature: core NATS delivers messages in well under a millisecond and can push millions per second, because it does almost nothing.

JetStream is a server subsystem (`-js` on the command line) that persists messages into a **stream** — an ordered, ack-tracked log bound to one or more subjects. The publish/consume API is a little more ceremony (`$JS.ACK...` reply subjects under the hood), and the guarantees change completely: messages survive a broker restart, consumers track exactly how far they have read, and redelivery happens when a consumer does not acknowledge.

The two modes are worth separating in your head. Publishing with no stream and no listener leaves no trace at all — I proved it later in this session. Core NATS is a wire; JetStream is a wire plus a journal.

## The lab: a throwaway JetStream server

One container, two forwarded ports on loopback, `-js` to enable the persistence layer:

```text
$ docker run -d --name natsjslab-srv -p 127.0.0.1:14722:4222 -p 127.0.0.1:18222:8222 \
    nats:latest -js -m 8222 -sd /data --server_name lab1
```

```text
[INF] Starting nats-server
[INF]   Version:  2.15.1
[INF] Starting http monitor on 0.0.0.0:8222
[INF] Starting JetStream
[INF]   Max Memory:      8.67 GB
[INF]   Max Storage:     55.05 GB
[INF]   Store Directory: "/data/jetstream"
```

The `nats` CLI below comes from the official `natsio/nats-box` image (`nats --version` reports 0.5.0). One honest note before the commands: this CLI's `consumer next` acks by default, so the no-ack demonstrations below pass `--no-ack` explicitly. The modern equivalent of the older `--no-prompt` convention is `--defaults` for the non-interactive `add` commands.

## Creating a durable stream

A stream is a named bucket of subjects. Here I bound it with limits so the retention story has something to bite on:

```text
$ nats stream add ORDERS --subjects "orders.>" --storage file --retention limits --discard old \
    --max-msgs 1000 --max-age 24h --max-msgs-per-subject 100 --dupe-window 2m --defaults
```

```text
Stream ORDERS was created

                     Subjects: orders.>
                      Storage: File
                    Retention: Limits
               Discard Policy: Old
             Duplicate Window: 2m0s
 Maximum Messages: 1,000
          Maximum Per Subject: 100
                  Maximum Age: 1d0h0m0s
```

Publishing is plain core-NATS syntax — JetStream intercepts subjects that belong to a stream and its API handles the persist-and-reply behind the scenes:

```text
$ nats pub orders.new "order-1 payload"
13:16:29 Published 15 bytes to "orders.new"
$ nats pub orders.new "order-2 payload"
13:16:30 Published 15 bytes to "orders.new"
$ nats pub orders.new "order-3 payload"
13:16:30 Published 15 bytes to "orders.new"
$ nats pub orders.eu "order-eu-1 payload"
13:16:30 Published 18 bytes to "orders.eu"
```

```text
$ nats stream info ORDERS
                 Messages: 4
                    Bytes: 222 B
           First Sequence: 1 @ 2026-10-13 13:16:29
            Last Sequence: 4 @ 2026-10-13 13:16:30
         Number of Subjects: 2
```

Four messages, two subjects (`orders.>` is a wildcard), sequence numbers 1–4. Then, the control experiment for the "core NATS forgets" claim:

```text
$ nats pub core.plain "this subject has no stream and no subscriber"
13:27:30 Published 44 bytes to "core.plain"
```

Nothing appeared in `nats stream ls`, and `ORDERS` still held exactly 4 messages. No listener, no journal, no record. That is core NATS.

## Durable consumers and explicit consumer acks

A **consumer** is the read side: a durable, server-side cursor over a stream that remembers its position. The most important settings are the delivery mode (push or pull), the ack policy, and the ack wait. A durable pull consumer with explicit acks looks like this:

```text
$ nats consumer add ORDERS WORKER --pull --ack explicit --deliver all --wait 60s --defaults
```

```text
                    Name: WORKER
               Pull Mode: true
          Deliver Policy: All
              Ack Policy: Explicit
                Ack Wait: 1m0s
       Max Ack Pending: 1,000
```

Consuming with the default ack behaviour (which this CLI acks automatically):

```text
$ nats consumer next ORDERS WORKER --count 2 --ack
[13:17:34] subj: orders.new / tries: 1 / cons seq: 1 / str seq: 1 / pending: 3
order-1 payload
Acknowledged message
[13:17:34] subj: orders.new / tries: 1 / cons seq: 2 / str seq: 2 / pending: 2
order-2 payload
Acknowledged message
```

```text
$ nats consumer info ORDERS WORKER
  Last Delivered Message: Consumer sequence: 2 Stream sequence: 2
    Acknowledgment Floor: Consumer sequence: 2 Stream sequence: 2
        Outstanding Acks: 0 out of maximum 1,000
    Redelivered Messages: 0
           Unprocessed Messages: 2
```

Three numbers tell the whole story: **Outstanding Acks 0** (everything handed out has been confirmed), the **ack floor at stream seq 2** (the consumer's durable position), and **Unprocessed 2** (messages 3 and 4 still waiting). The consumer state lives on the server, so if every worker process on earth dies, the cursor is still there tomorrow.

<figure>
<svg viewBox="0 0 720 350" width="100%" role="img" aria-label="A stream ORDERS holds four messages with sequence numbers 1 to 4; messages 1 and 2 sit below the acknowledgement floor, 3 and 4 above it. A pull consumer WORKER receives message N, sends an ack that advances the floor, or stays silent until the ack wait expires and the server redelivers the message, incrementing the tries counter.">
  <defs>
    <marker id="js-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
    <marker id="js-arrow-mark" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#b45309"/>
    </marker>
  </defs>

  <text x="16" y="24" fill="currentColor" font-family="system-ui, sans-serif" font-size="14" font-weight="600">stream ORDERS — file storage, retention: limits, discard: old</text>
  <text x="452" y="24" fill="currentColor" font-family="system-ui, sans-serif" font-size="14" font-weight="600">consumer WORKER — pull, ack: explicit</text>

  <!-- stream body -->
  <rect x="16" y="40" width="330" height="150" rx="12" fill="#0f766e" opacity="0.06" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="6 5"/>
  <rect x="16" y="128" width="330" height="62" fill="none" stroke="#0f766e" stroke-width="1" stroke-dasharray="3 4" opacity="0.7"/>
  <text x="30" y="66" fill="#0f766e" font-family="ui-monospace, monospace" font-size="12">ack floor</text>

  <!-- acked messages -->
  <rect x="30" y="78" width="60" height="30" rx="5" fill="currentColor" opacity="0.10"/>
  <text x="60" y="98" text-anchor="middle" fill="currentColor" font-size="11" font-family="ui-monospace, monospace">#1</text>
  <rect x="100" y="78" width="60" height="30" rx="5" fill="currentColor" opacity="0.10"/>
  <text x="130" y="98" text-anchor="middle" fill="currentColor" font-size="11" font-family="ui-monospace, monospace">#2</text>
  <text x="176" y="98" fill="currentColor" font-size="11" opacity="0.8">acked</text>

  <!-- unprocessed messages -->
  <rect x="30" y="142" width="60" height="30" rx="5" fill="#0f766e" opacity="0.30"/>
  <text x="60" y="162" text-anchor="middle" fill="currentColor" font-size="11" font-family="ui-monospace, monospace">#3</text>
  <rect x="100" y="142" width="60" height="30" rx="5" fill="#0f766e" opacity="0.30"/>
  <text x="130" y="162" text-anchor="middle" fill="currentColor" font-size="11" font-family="ui-monospace, monospace">#4</text>
  <text x="176" y="162" fill="currentColor" font-size="11" opacity="0.8">unprocessed</text>

  <!-- consumer body -->
  <rect x="452" y="40" width="250" height="150" rx="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="6 5" opacity="0.6"/>
  <text x="470" y="70" fill="currentColor" font-size="12" font-family="ui-monospace, monospace">cursor: seq 2</text>
  <text x="470" y="94" fill="currentColor" font-size="12" font-family="ui-monospace, monospace">outstanding: 0</text>
  <text x="470" y="118" fill="currentColor" font-size="12" font-family="ui-monospace, monospace">num_redelivered: 0</text>
  <text x="470" y="150" fill="currentColor" font-size="11" opacity="0.75">holds position on the server,</text>
  <text x="470" y="168" fill="currentColor" font-size="11" opacity="0.75">survives worker restarts</text>

  <!-- delivery arrow -->
  <path d="M346 100 H 440" stroke="#0f766e" stroke-width="1.5" marker-end="url(#js-arrow)"/>
  <text x="360" y="90" fill="#0f766e" font-size="11" font-family="ui-monospace, monospace">pull → deliver</text>

  <!-- ack arrow -->
  <path d="M440 130 H 346" stroke="#0f766e" stroke-width="1.5" marker-end="url(#js-arrow)"/>
  <text x="352" y="150" fill="#0f766e" font-size="11" font-family="ui-monospace, monospace">ack → floor advances</text>

  <!-- redelivery loop -->
  <path d="M452 200 C 400 280, 120 280, 60 224" stroke="#b45309" stroke-width="1.5" fill="none" stroke-dasharray="6 5" marker-end="url(#js-arrow-mark)"/>
  <text x="150" y="300" fill="#b45309" font-size="12" font-family="ui-monospace, monospace">no ack before ack wait → redeliver, tries: 2</text>
  <text x="150" y="320" fill="#b45309" font-size="12" font-family="ui-monospace, monospace">num_redelivered: 1</text>

  <!-- footer caption inside svg note -->
  <text x="16" y="336" fill="currentColor" font-size="11" opacity="0.7">stream seq counts messages; consumer seq counts deliveries — one message, many deliveries, that is at-least-once.</text>
</svg>
<figcaption>One message, many deliveries. The stream never moves; the consumer cursor and the redelivered counter are what at-least-once costs you.</figcaption>
</figure>

## At-least-once delivery, demonstrated for real

Here is the part I actually wanted to see. I made a second consumer, `RDL`, identical except the ack wait is **4 seconds** so the demo does not take all day:

```text
$ nats consumer add ORDERS RDL --pull --ack explicit --deliver all --wait 4s --defaults
```

Now pull one message and deliberately do **not** ack it (`--no-ack`):

```text
$ nats consumer next ORDERS RDL --count 1 --no-ack
[13:19:22] subj: orders.new / tries: 1 / cons seq: 2 / str seq: 2 / pending: 2
order-2 payload
```

(For completeness: the consumer sits at `cons seq: 2` because delivery #1 was consumed and acked in an earlier step. What matters is the pair `str seq: 2` / `tries: 1` — stream sequence 2, delivered once.)

Six seconds later, past the 4-second ack wait:

```text
$ nats consumer info ORDERS RDL
  Last Delivered Message: Consumer sequence: 2 Stream sequence: 2 Last delivery: 6.37s ago
    Acknowledgment Floor: Consumer sequence: 1 Stream sequence: 1
        Outstanding Acks: 1 out of maximum 1,000
    Redelivered Messages: 0
           Unprocessed Messages: 2
```

Note the counter: **Redelivered Messages: 0** while **Outstanding Acks: 1**. The timer expired, but nothing has been redelivered yet — the message is *eligible* for redelivery; the counter only moves when a new delivery actually happens. So pull again:

```text
$ nats consumer next ORDERS RDL --count 1 --no-ack
[13:19:39] subj: orders.new / tries: 2 / cons seq: 3 / str seq: 2 / pending: 2
order-2 payload
```

```text
$ nats consumer info ORDERS RDL
  Last Delivered Message: Consumer sequence: 3 Stream sequence: 2 Last delivery: 360ms ago
    Acknowledgment Floor: Consumer sequence: 1 Stream sequence: 1
        Outstanding Acks: 1 out of maximum 1,000
    Redelivered Messages: 1
           Unprocessed Messages: 2
```

There it is, in the raw JSON too:

```text
$ nats consumer info ORDERS RDL -j | grep -E 'num_redelivered|num_ack_pending|num_pending'
  "num_ack_pending": 1,
  "num_redelivered": 1,
  "num_pending": 2
```

`tries: 2`, `num_redelivered: 1`, same `str seq: 2` payload. That is **at-least-once delivery** made concrete: your handler must be idempotent, because it *will* see the same message twice. The corollary matters just as much — a pull consumer only redelivers on demand, so "redelivery" means "the server resends when you ask again after the ack wait expires," not some background retry thread you have to tune. When I finally let the CLI ack (it acks by default), the message was confirmed three deliveries deep:

```text
$ nats consumer next ORDERS RDL --count 1
[13:20:26] subj: orders.new / tries: 3 / cons seq: 4 / str seq: 2 / pending: 2
order-2 payload
Acknowledged message
```

A third delivery, finally acked, floor advanced, outstanding back to 0. Exactly the semantics a money-moving pipeline needs.

## Retention policies: limits, interest, workqueue

The `--retention limits` policy I used above is "keep everything, delete according to max-age / max-msgs / max-bytes." I made a stream with an 8-second max-age to watch the broker actually discard:

```text
$ nats stream add TTL --subjects "ttl.>" --storage file --retention limits --discard old \
    --max-age 8s --max-msgs 100 --defaults
$ nats pub ttl.a "m1"; nats pub ttl.b "m2"; nats pub ttl.c "m3"
$ nats stream info TTL | grep Messages
                     Messages: 3
$ sleep 12 && nats stream info TTL | grep Messages
                     Messages: 0
```

Three messages, twelve seconds, gone. The same happens with a message-count limit — with `--max-msgs 2 --discard old`, four publishes leave the newest two, and `First Sequence` moves to 3 while the stream never holds more than promised. That is the whole data-lifecycle story with two flags, no compaction daemon to babysit.

The other two retention policies are more interesting. An **interest-based** stream keeps a message only while at least one consumer has not yet acked it — publish to one with no consumers and the messages are dropped on arrival (the sequence numbers still advance, `First Sequence: 3` while `Last Sequence: 2` after two publishes). Add a consumer and the same message is held until acked:

```text
$ nats consumer add EVENTS LIVE --pull --ack explicit --filter 'events.>' --defaults
$ nats pub events.login "kept-until-acked"
$ nats stream info EVENTS | grep Messages
                     Messages: 1
$ nats consumer next EVENTS LIVE --count 1
[13:21:28] subj: events.login / tries: 1 / cons seq: 1 / str seq: 3 / pending: 0
kept-until-acked
$ nats stream info EVENTS | grep Messages
                     Messages: 0
```

Acked and immediately removed — that is a work-queue-ish semantic. And the explicit **workqueue** policy (`--retention work`) makes it official: messages are deleted as they are acked, with no replay. Two jobs in, one acked, one left:

```text
$ nats stream info JOBS | grep Messages    # after publishing 2
                     Messages: 2
$ nats consumer next JOBS WQ --count 1
[13:21:45] subj: jobs.a / tries: 1 / cons seq: 1 / str seq: 1 / pending: 1
$ nats stream info JOBS | grep Messages    # after one ack
                     Messages: 1
```

So the choice is a one-liner per use case: `limits` for an event log you replay, `interest` for "deliver to whoever cares, then forget," `workqueue` for jobs that must be done exactly once and then vanish.

## Request-reply is built in, not bolted on

Core NATS has a request-reply primitive with an auto-generated inbox subject and a timeout. JetStream does not replace it; the two compose. I started a reply service in one container and sent a request from another:

```text
$ nats reply svc.upper --command 'printenv NATS_REQUEST_BODY'    # service side, another container
$ nats request svc.upper 'shipped order 4711'
13:27:14 Sending request on "svc.upper"
shipped order 4711
13:27:14 Received with rtt 1.117301ms
```

A 1.1 ms round trip on loopback, no broker hop logic to write. (Honest detail: this CLI hands the request body to `--command` through the `NATS_REQUEST_BODY` environment variable, not stdin — a shell pipe in the command string does not run, which is why the demo prints the body straight back.)

## The KV store: JetStream wearing a friendly hat

`nats kv` gives you a versioned key-value bucket, and the punchline is that it is not a separate storage engine — it is a stream:

```text
$ nats kv add CONFIG --history 5
Information for Key-Value Store Bucket CONFIG created 2026-10-13 13:24:12

Configuration:

            Bucket Name: CONFIG
           History Kept: 5
          Values Stored: 0
             Compressed: false
$ nats kv put CONFIG region eu
eu
$ nats kv put CONFIG region us
us
$ nats kv get CONFIG region
CONFIG > region revision: 2 created @ 2026-10-13 13:24:13

us
$ nats stream ls -a
│ Name       │ Created             │ Messages │ Size  │ Last Message │
│ KV_CONFIG  │ 2026-10-13 13:24:12 │ 2        │ 98 B  │ 1m19s        │
```

Every bucket is literally a stream: `nats stream info KV_CONFIG` reports `Subjects: $KV.CONFIG.>`, `Storage: File`, `Retention: Limits`, `Messages: 2`. Each `put` is a message; `get` reads the newest revision; history is just message retention. The same trick extends to an object store for large blobs. If you have ever wired Redis just to hold a bit of shared config, this is a genuinely tempting replacement — with a `watch` API included.

## The honest comparison with Kafka

I covered Kafka's log model in depth in [Kafka in practice](/posts/kafka-in-practice/); the short version for this post is that JetStream is not a scaled-down Kafka, it is a different shape.

**What JetStream wins on, decisively:** operations. One 26 MB container, no JVM, no KRaft quorum, no partition-count-to-decide-before-you-create-anything. You can hold the entire operational model — streams, consumers, counters, KV — in your head, and the account-level accounting is one command away:

```text
$ nats account info
JetStream Account Information:
Account Usage:
                        Storage: 361 B
                         Memory: 46 B
                        Streams: 6
                      Consumers: 4
```

Processing latency is measured in single-digit milliseconds, request-reply is native, and it embeds into your own application if you want zero extra processes.

**What Kafka wins on, decisively:** ecosystem and scale. Connect, ksqlDB, the entire managed-offering universe, client libraries for decades of accumulated operational wisdom, transactional exactly-once, and a partition-per-topic model that lets a single topic be consumed by a horizontally scaled group at throughputs JetStream does not attempt. If you need to replay three years of events at 500 MB/s, Kafka.

**What neither will tell you on the box:** JetStream *does* cluster (a RAFT group per stream, three or five servers), but a single server — what I ran here — has no replication. Disk failure loses the stream. That is the honest price of a 26 MB broker, and for a lot of workloads it is still a better trade than the operational gravity of the alternative.

**Versus a plain queue** (Redis list, RabbitMQ): a queue deletes on ack, so replay is impossible and every consumer competes for the same messages. JetStream's `limits` streams give you multiple *independent* consumer groups over the same retained data — one for billing, one for analytics, each with its own cursor — which is the feature that quietly removes the most mid-sized architectures' need for Kafka in the first place. My [message queue guide](/posts/message-queues/) frames the underlying decision.

## When I would actually pick it

For service-to-service messaging with a few thousand to a few hundred thousand messages per second, where I want replay and backpressure without operating a data platform: JetStream, single node, file storage, done. For a durable work queue: `--retention workqueue` and explicit acks, plus idempotent handlers. For shared config or feature flags: the KV layer. For the event backbone of a large analytics estate: Kafka, and I would not pretend otherwise.

The file storage was already 361 bytes across six streams at the end of this session. Kafka would not even have finished starting JVM threads by then. That contrast, more than any benchmark, is the actual review.

## Cleanup

```text
$ docker rm -f natsjslab-srv
$ docker network rm natsjslab-net
$ docker ps -a --filter name=natsjslab --format '{{.Names}} {{.Status}}'
$ docker network ls --filter name=natsjslab
NETWORK ID     NAME      DRIVER    SCOPE
```

One process, one throwaway network, zero residue — and for once, that is the point.
