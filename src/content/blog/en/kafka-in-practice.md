---
title: "Kafka in practice: it's a log, not a queue (and that changes everything)"
description: "Kafka is not a queue — it is an append-only, partitioned log with consumer offsets, and that one difference unlocks replay and independent consumers. I ran a throwaway single-broker KRaft cluster and pasted the real topic, consumer-group, and log-compaction output."
pubDate: 2026-12-17
lang: en
translationKey: kafka-in-practice
tags: [devops, networking]
featured: false
keywords:
  - Kafka
  - Kafka consumer group
  - Kafka partitions
  - event streaming
  - KRaft
---

**Kafka** is not a queue, and that one sentence explains most of the confusion around it. A classic queue hands a message to one worker and the message is gone; Kafka keeps an append-only **log** that many independent readers — each a **Kafka consumer group** walking its own **offsets** — can replay at their own pace. That difference is what turns a message bus into an **event streaming** platform, and it is also why Kafka is simultaneously the exactly-right tool for some problems and laughably over-engineered for others. I stood up a throwaway single-broker Kafka in **KRaft** mode (no ZooKeeper), ran the commands people actually deploy it for, and pasted the terminal back out. Every output below is real.

If you are still deciding whether you need a broker at all, my [message queue decision guide](/posts/message-queues/) is the prerequisite; this post is what happens when the answer is "a log, specifically." The replication underneath is the same idea as [consensus and etcd](/posts/consensus-and-etcd/), applied to a stream.

## What Kafka actually is: an append-only log

Forget the queue vocabulary for a minute. A Kafka topic is a named stream. Every topic is split into **Kafka partitions**, and each partition is a plain, append-only sequence of records, each stamped with a monotonically increasing number called an **offset**. Producers always append. Consumers never remove anything — they just remember how far they have read by committing offsets. A record sitting at offset 3 stays at offset 3 for everyone; if you go back and read it again, it is still offset 3.

A broker (or a cluster of brokers) stores those partitions on disk, and each partition is replicated to a configured number of brokers so a machine loss does not lose the log. Modern Kafka runs in **KRaft** mode, where the cluster's own metadata is kept in a Kafka log and managed by a controller quorum — the ZooKeeper dependency is gone. Creating a topic with four partitions is one command:

```text
$ docker exec kafka-demo /opt/kafka/bin/kafka-topics.sh --bootstrap-server 127.0.0.1:9092 \
    --create --topic orders --partitions 4 --replication-factor 1
Created topic orders.

$ docker exec kafka-demo /opt/kafka/bin/kafka-topics.sh --bootstrap-server 127.0.0.1:9092 \
    --describe --topic orders
Topic: orders	TopicId: yF2pitsBTHOp8ePxuApscw	PartitionCount: 4	ReplicationFactor: 1	Configs:
	Topic: orders	Partition: 0	Leader: 1	Replicas: 1	Isr: 1	Elr:
	Topic: orders	Partition: 1	Leader: 1	Replicas: 1	Isr: 1	Elr:
	Topic: orders	Partition: 2	Leader: 1	Replicas: 1	Isr: 1	Elr:
	Topic: orders	Partition: 3	Leader: 1	Replicas: 1	Isr: 1	Elr:
```

`Isr` is the in-sync replica set — the brokers that are fully caught up for that partition. On a single-broker demo it is trivially `1`; in production it is the number you watch when a disk stalls.

<figure>
<svg viewBox="0 0 700 430" width="100%" role="img" aria-label="A topic named orders with four partitions, each an append-only sequence of numbered offsets. Consumer group audit-svc has two members: member one reads partitions 0 and 1, member two reads partitions 2 and 3. A second group, search-svc, reads all four partitions independently with its own offsets.">
  <defs>
    <marker id="kafka-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>

  <text x="16" y="26" fill="currentColor" font-family="system-ui, sans-serif" font-size="14" font-weight="600">topic: orders — an append-only, partitioned log</text>

  <rect x="16" y="52" width="330" height="100" rx="12" fill="#0f766e" opacity="0.06" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="6 5"/>
  <rect x="16" y="160" width="330" height="100" rx="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="6 5" opacity="0.6"/>

  <!-- partition rows -->
  <text x="30" y="80" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12" font-weight="600">p0</text>
  <rect x="74" y="62" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="92" y="81" text-anchor="middle" fill="currentColor" font-size="11">0</text>
  <rect x="116" y="62" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="134" y="81" text-anchor="middle" fill="currentColor" font-size="11">1</text>
  <rect x="158" y="62" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="176" y="81" text-anchor="middle" fill="currentColor" font-size="11">2</text>
  <rect x="200" y="62" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="218" y="81" text-anchor="middle" fill="currentColor" font-size="11">3</text>
  <rect x="242" y="62" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="260" y="81" text-anchor="middle" fill="currentColor" font-size="11">4</text>
  <text x="288" y="80" fill="currentColor" opacity="0.7" font-family="system-ui, sans-serif" font-size="10">offsets →</text>

  <text x="30" y="134" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12" font-weight="600">p1</text>
  <rect x="74" y="116" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="92" y="135" text-anchor="middle" fill="currentColor" font-size="11">0</text>
  <rect x="116" y="116" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="134" y="135" text-anchor="middle" fill="currentColor" font-size="11">1</text>
  <rect x="158" y="116" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="176" y="135" text-anchor="middle" fill="currentColor" font-size="11">2</text>
  <rect x="200" y="116" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="218" y="135" text-anchor="middle" fill="currentColor" font-size="11">3</text>
  <rect x="242" y="116" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="260" y="135" text-anchor="middle" fill="currentColor" font-size="11">4</text>

  <text x="30" y="188" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12" font-weight="600">p2</text>
  <rect x="74" y="170" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="92" y="189" text-anchor="middle" fill="currentColor" font-size="11">0</text>
  <rect x="116" y="170" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="134" y="189" text-anchor="middle" fill="currentColor" font-size="11">1</text>
  <rect x="158" y="170" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="176" y="189" text-anchor="middle" fill="currentColor" font-size="11">2</text>
  <rect x="200" y="170" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="218" y="189" text-anchor="middle" fill="currentColor" font-size="11">3</text>
  <rect x="242" y="170" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="260" y="189" text-anchor="middle" fill="currentColor" font-size="11">4</text>

  <text x="30" y="242" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12" font-weight="600">p3</text>
  <rect x="74" y="224" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="92" y="243" text-anchor="middle" fill="currentColor" font-size="11">0</text>
  <rect x="116" y="224" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="134" y="243" text-anchor="middle" fill="currentColor" font-size="11">1</text>
  <rect x="158" y="224" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="176" y="243" text-anchor="middle" fill="currentColor" font-size="11">2</text>
  <rect x="200" y="224" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="218" y="243" text-anchor="middle" fill="currentColor" font-size="11">3</text>
  <rect x="242" y="224" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="260" y="243" text-anchor="middle" fill="currentColor" font-size="11">4</text>

  <text x="356" y="98" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">member 1 of audit-svc</text>
  <text x="356" y="114" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">committed p0 → 3, p1 → 2</text>
  <text x="356" y="206" fill="currentColor" opacity="0.8" font-family="system-ui, sans-serif" font-size="11">member 2 of audit-svc</text>
  <text x="356" y="222" fill="currentColor" opacity="0.8" font-family="system-ui, sans-serif" font-size="11">committed p2 → 3, p3 → 2</text>

  <g stroke="#0f766e" fill="none" stroke-width="2">
    <line x1="181" y1="152" x2="150" y2="300" marker-end="url(#kafka-arrow)"/>
    <line x1="181" y1="260" x2="215" y2="300" marker-end="url(#kafka-arrow)"/>
    <line x1="352" y1="210" x2="520" y2="300" marker-end="url(#kafka-arrow)"/>
  </g>

  <rect x="16" y="302" width="300" height="106" rx="12" fill="none" stroke="#0f766e" stroke-width="2"/>
  <text x="30" y="326" fill="#0f766e" font-family="system-ui, sans-serif" font-size="13" font-weight="600">consumer group: audit-svc</text>
  <text x="30" y="348" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">2 members split the 4 partitions.</text>
  <text x="30" y="366" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">Each partition → exactly one member.</text>
  <text x="30" y="388" fill="currentColor" opacity="0.75" font-family="system-ui, sans-serif" font-size="11">A member leaving triggers a rebalance.</text>

  <rect x="368" y="302" width="316" height="106" rx="12" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.7"/>
  <text x="382" y="326" fill="currentColor" font-family="system-ui, sans-serif" font-size="13" font-weight="600">consumer group: search-svc</text>
  <text x="382" y="348" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">Reads the same four partitions</text>
  <text x="382" y="366" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">from offset 0, with its own offsets.</text>
  <text x="382" y="388" fill="currentColor" opacity="0.75" font-family="system-ui, sans-serif" font-size="11">Nothing is consumed away from audit-svc.</text>
</svg>
<figcaption>One topic, four partitions, each an append-only sequence of offsets. Members of a group split the partitions; a second, independent group reads the same records from their own offsets. Nothing a reader does removes data from the log.</figcaption>
</figure>

## Kafka partitions and ordering guarantees

The partition is the unit of both parallelism and ordering in Kafka. Records within a single partition are strictly ordered by offset, and that order is the only ordering Kafka promises. Across partitions there is no global order at all.

The producer decides the partition: if a record has no key, it is spread round-robin (or by sticky batching) across partitions; if it has a key, Kafka hashes that key, so all records with the same key land in the same partition and therefore keep their relative order. Produce six keyed order events and read them back:

```text
$ printf 'user-1:created order 100\nuser-2:created order 101\nuser-1:paid order 100\n
user-3:created order 102\nuser-2:paid order 101\nuser-3:paid order 102\n' \
  | docker exec -i kafka-demo /opt/kafka/bin/kafka-console-producer.sh \
      --bootstrap-server 127.0.0.1:9092 --topic orders --property parse.key=true --property key.separator=:

$ docker exec kafka-demo /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server 127.0.0.1:9092 \
    --topic orders --from-beginning --max-messages 6 --property print.partition=true \
    --property print.offset=true --property print.key=true
Partition:0	Offset:0	user-1	created order 100
Partition:0	Offset:1	user-2	created order 101
Partition:0	Offset:2	user-1	paid order 100
Partition:0	Offset:3	user-2	paid order 101
Partition:3	Offset:0	user-3	created order 102
Partition:3	Offset:1	user-3	paid order 102
```

`user-1` and `user-2` hashed to partition 0; `user-3` landed on partition 3. Crucially, `created order 100` at offset 0 precedes `paid order 100` at offset 2 on the same partition, so a consumer processing partition 0 in order sees one user's events in the order they happened. **Kafka partitions** are also the ceiling on parallelism: a topic with four partitions can keep at most four consumers busy *within a single group*.

## A log, not a queue: what changes

Now the mental-model shift. In a queue, reading a message deletes it; a second consumer sees an empty queue. In a log, reading is non-destructive — it just advances *your* offset. Two consequences fall straight out.

**Replay.** Any consumer can start from offset 0 and re-read the entire history, as long as retention keeps the data. That is how you rebuild a search index, bootstrap a new microservice, or re-run a fixed bug in a downstream job.

**Multiple independent consumers.** Every consumer group has its own offsets. Start a brand-new group against the same topic and it reads everything from the beginning, independently of everyone else:

```text
$ docker exec kafka-demo /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server 127.0.0.1:9092 \
    --topic orders --group search-svc --from-beginning --max-messages 15 \
    --property print.partition=true --property print.offset=true --property print.key=true
Partition:0	Offset:0	user-1	created order 100
Partition:0	Offset:1	user-2	created order 101
Partition:0	Offset:2	user-1	paid order 100
Partition:0	Offset:3	user-2	paid order 101
Partition:0	Offset:4	user-1	shipped order 100
Partition:0	Offset:5	user-2	shipped order 101
Partition:0	Offset:6	user-1	refunded order 100
Partition:0	Offset:7	user-2	delivered order 101
Partition:0	Offset:8	user-1	note order 100
Partition:0	Offset:9	user-2	note order 101
Partition:0	Offset:10	user-1	closed order 100
Partition:3	Offset:0	user-3	created order 102
Partition:3	Offset:1	user-3	paid order 102
Partition:3	Offset:2	user-3	shipped order 102
Partition:3	Offset:3	user-3	note order 102
```

An audit service and a search-index service both read the same topic, neither steals events from the other, and adding a third consumer changes nothing for the first two. That is the whole point of **event streaming** as opposed to a work queue.

## Kafka consumer groups and rebalancing

A **Kafka consumer group** is the unit of scale-out. Add members to a group and Kafka assigns partitions across them; the guarantee is that, within one group, each partition is read by exactly one member at a time. Two members of a group split a four-partition topic cleanly:

```text
$ docker exec kafka-demo /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server 127.0.0.1:9092 \
    --describe --group audit-svc
GROUP      TOPIC   PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG  CONSUMER-ID                HOST        CLIENT-ID
audit-svc  orders  0          4               4               0    console-consumer-1134bb44  /127.0.0.1  console-consumer
audit-svc  orders  1          0               0               0    console-consumer-1134bb44  /127.0.0.1  console-consumer
audit-svc  orders  2          0               0               0    console-consumer-dd6c5758  /127.0.0.1  console-consumer
audit-svc  orders  3          2               2               0    console-consumer-dd6c5758  /127.0.0.1  console-consumer
```

Member one owns partitions 0 and 1, member two owns 2 and 3. `CURRENT-OFFSET` is the committed position; `LOG-END-OFFSET` is the tail of the log; the difference is `LAG` — the number of records a group is behind. Stop the consumers, let events pile up, and lag grows without rewriting anything:

```text
$ docker exec kafka-demo /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server 127.0.0.1:9092 \
    --all-groups --describe
GROUP       TOPIC   PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
audit-svc   orders  0          8               11              3
audit-svc   orders  1          0               0               0
audit-svc   orders  2          0               0               0
audit-svc   orders  3          3               4               1
search-svc  orders  0          11              11              0
search-svc  orders  1          0               0               0
search-svc  orders  2          0               0               0
search-svc  orders  3          4               4               0
```

Two groups, same topic, two independent sets of offsets. When a member joins or leaves a group — or dies without saying goodbye — Kafka triggers a **rebalance** and redistributes partitions. During the rebalance consumption pauses; that pause is the single most common source of surprise latency in Kafka-backed systems. If a member crashed, its committed offsets survive: when it comes back, it resumes exactly where it left off and drains the lag, and so do the offsets shown above.

## Retention, offsets, and log compaction

A log that never deletes anything is a disk-space problem, so Kafka prunes it by policy, not by consumption. The default for a normal topic is time-based deletion — on my broker, `log.retention.hours=168` (seven days) and `log.retention.bytes=-1` (no size cap), with cleanup driven by `log.cleanup.policy=delete`. You can also cap a topic by size. Because deletion is by age or bytes rather than by read, a slow consumer can lose data it never saw — a real design constraint, not a footnote.

The other policy is **log compaction**. On a compacted topic Kafka keeps the *latest* value for every key and eventually discards older ones, turning the topic into a durable, replayable changelog rather than a transient stream. Create a compacted topic and watch the cleaner collapse duplicate keys:

```text
$ ... --create --topic user-profiles --partitions 4 --replication-factor 1 \
      --config cleanup.policy=compact --config segment.ms=1000

# five records for two keys were written, then a sixth append rolled the segment:
$ docker exec kafka-demo /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server 127.0.0.1:9092 \
    --topic user-profiles --from-beginning --property print.offset=true --property print.key=true
Partition:3	Offset:0	user-3	{"name":"Carol"}
Partition:0	Offset:3	user-1	{"name":"Ada Lovelace"}
Partition:0	Offset:4	user-2	{"name":"Bob B."}
Partition:0	Offset:5	user-1	{"name":"Ada L3"}
```

Offsets 0–2 on partition 0 are simply gone — superseded by later writes for the same keys — while the offsets that remain are preserved, holes and all. Consumers still see a consistent, ordered stream per key. This is why compacted topics are the right home for "current state" (Kafka's own `__consumer_offsets` is compacted), and why a compacted topic should never be your only copy of append-only events.

## When Kafka is the right tool, and when it is overkill

Kafka earns its keep when at least one of these is true:

- **You need replay.** Rebuilding a projection, reindexing, or reprocessing history is a first-class operation.
- **Several independent consumers need the same stream.** Fan-out is free and each reader has its own offsets.
- **Throughput and durability matter.** Kafka is a genuinely high-throughput, disk-backed, replicated log; it is exceptionally good at moving a lot of events reliably.
- **Ordering per key is required.** Keyed records land on one partition and stay ordered.

And it is the wrong tool when none of those holds. If you have a small app that needs to hand work to a background worker, a database table with `FOR UPDATE SKIP LOCKED` or a lightweight broker like NATS or Redis Streams will do it with a fraction of the operational surface — the reasoning is spelled out in the [message queue post](/posts/message-queues/). Adopting Kafka for a handful of jobs per minute is buying a distributed system to avoid writing a `jobs` table.

## The operational weight, honestly

That single-broker demo is not production, and pretending otherwise is how teams get burned. A real Kafka deployment means: multiple brokers, a replication factor of at least 3, rack-aware placement so a rack loss does not take a partition's replicas with it, and monitoring for far more than uptime. The four signals I would page on are **consumer lag** (a group silently falling behind), **under-replicated partitions** (replicas that have drifted out of the ISR), **offline partitions**, and **disk usage** against retention. You also own partition-count choices that are painful to change later, rebalances that pause consumers, schema evolution (usually via a Schema Registry), and broker upgrades that must roll one broker at a time.

None of that is a reason to avoid Kafka when the problem is genuinely an event stream. It is a reason to be honest that Kafka is infrastructure, with an on-call rotation attached. The log-versus-queue mental model is what tells you whether you signed up for the right thing: if you want a message delivered once and forgotten, you want a queue; if you want a durable, replayable history that many readers can walk at their own pace, you want a log — and that is exactly what Kafka is.

## Frequently asked questions

**Does consuming a message delete it?** No. You advance your consumer group's offset; the record stays until retention or compaction removes it. Another group reads it happily.

**How many partitions should I use?** Enough to saturate your target consumer parallelism, and no more — partitions carry files, replication, and rebalance cost. You can add partitions later, but keyed ordering across the change is not preserved for existing keys.

**Is ordering guaranteed globally?** No. Ordering is per partition. To keep one entity's events ordered, give them the same key.

**What is the difference between retention and compaction?** Retention deletes records by age or size regardless of keys. Compaction keeps the latest record per key and discards older ones. They can be combined on one topic.
