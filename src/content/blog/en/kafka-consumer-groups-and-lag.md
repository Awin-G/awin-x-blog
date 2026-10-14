---
title: "Kafka consumer groups and lag: the number that tells you you're falling behind"
description: "A Kafka consumer group splits partitions across its consumers and commits offsets; consumer lag is the gap between committed offset and log end. Real output from a throwaway KRaft broker: lag growing, a live rebalance, and an offset reset."
pubDate: 2027-02-09
lang: en
translationKey: kafka-consumer-groups-and-lag
tags: [devops, self-hosting]
featured: false
keywords:
  - Kafka consumer group
  - consumer lag
  - kafka-consumer-groups
  - rebalance
  - offsets
---

**Consumer lag** is the single number that tells you whether your Kafka consumers are keeping up — and nobody looks at it until something is already on fire. A **Kafka consumer group** is a set of consumers that share the work of reading one topic: its partitions are divided among them, and each member commits an **offset** saying how far it got. Lag is simply `LOG-END-OFFSET - CURRENT-OFFSET`, per partition. When it climbs, you are falling behind — and the *rate* matters more than the absolute value.

I argued in [Kafka in practice](/posts/kafka-in-practice/) that Kafka is a log, not a queue, and in [the message queue decision guide](/posts/message-queues/) whether you needed a broker at all. This is the operational layer on top: what a consumer group does, how to read `kafka-consumer-groups --describe`, why lag grows, what a **rebalance** costs, and how to reset offsets once you have dug a hole. Everything below ran against a throwaway single-broker KRaft cluster (`apache/kafka:3.9.0`), output pasted verbatim.

```text
$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
    --create --topic orders --partitions 3 --replication-factor 1
Created topic orders.
```

Three partitions, one broker. That is the topology for the rest of this article — and also the hard ceiling on how much parallelism this topic can ever give you.

## What a Kafka consumer group actually is

A consumer group is a subscription to a topic under a **name**. Every consumer that joins with the same `group.id` becomes a member, and the broker's group coordinator hands out partitions so that **each partition is owned by exactly one member at any moment**. That is the entire rule, and it has one enormous consequence: parallelism inside a group is capped at the partition count. Three partitions means at most three consumers doing useful work.

I produced twelve keyed messages into `orders` — they spread evenly, 4 per partition — and ran a single consumer in the group `dlt-worker` to drain them:

```text
$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 --describe --group dlt-worker

Consumer group 'dlt-worker' has no active members.

GROUP           TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
dlt-worker      orders          0          4               4               0
dlt-worker      orders          1          4               4               0
dlt-worker      orders          2          4               4               0
```

`LAG 0` on every partition, and `has no active members` because the consumer exited cleanly after draining. The next consumer to join resumes from those committed offsets — not from the beginning. That is the group contract in one table.

Now watch what happens when I scale the group *up*. I restarted the consumer, let it catch up, then added members one at a time until there were four:

```text
$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 --describe --group dlt-worker --members

GROUP           CONSUMER-ID                                           HOST            CLIENT-ID        #PARTITIONS
dlt-worker      console-consumer-f4088647-6dcd-4ad7-bad6-ccf33240f6a4  /127.0.0.1      console-consumer  0
dlt-worker      console-consumer-9b53099e-df87-4e13-9e9b-b28b615c96bc  /127.0.0.1      console-consumer  1
dlt-worker      console-consumer-793325b8-a341-47d9-8bd5-62fea2cd7f41  /127.0.0.1      console-consumer  1
dlt-worker      console-consumer-48e42eb9-eb8a-4a90-8dbe-f0c428571b26  /127.0.0.1      console-consumer  1
```

Four consumers, three partitions, and `console-consumer-f4088647…` holds `#PARTITIONS 0`. It joined the group, it is heartbeating, it is burning CPU — and it will never process a single message. **Adding consumers to a group that is already at the partition cap buys you nothing but cost.** The fix is more partitions, not more consumers, and because partitions can only be added, never removed, that choice is close to permanent: existing keys keep hashing to their original partition, so repartitioning means a new topic, a dual-write period, and a cutover.

<figure>
<svg viewBox="0 0 660 300" width="100%" role="img" aria-label="A Kafka topic with three partitions split across two consumers in one group. Each partition bar is mostly committed and read, with a hatched tail at the right end representing consumer lag, the gap between the last committed offset and the log end.">
  <defs>
    <marker id="cgar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
    <pattern id="cglag" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="0" y2="7" stroke="#0f766e" stroke-width="2" stroke-opacity="0.4"/>
    </pattern>
  </defs>

  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">
    <text x="12" y="16">topic: orders</text>
    <text x="120" y="16" opacity="0.6">3 partitions · group dlt-worker</text>
  </g>

  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" fill="currentColor">
    <text x="12" y="52" opacity="0.8">p0</text>
    <rect x="48" y="40" width="200" height="16" fill="#0f766e" fill-opacity="0.16"/>
    <rect x="248" y="40" width="72" height="16" fill="url(#cglag)"/>
    <rect x="48" y="40" width="200" height="16" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
    <rect x="248" y="40" width="72" height="16" fill="none" stroke="#0f766e" stroke-width="1.2" stroke-dasharray="4 3"/>
    <text x="256" y="72" opacity="0.65">committed</text>
    <text x="336" y="72" fill="#0f766e">LAG</text>

    <text x="12" y="122" opacity="0.8">p1</text>
    <rect x="48" y="110" width="140" height="16" fill="#0f766e" fill-opacity="0.16"/>
    <rect x="188" y="110" width="132" height="16" fill="url(#cglag)"/>
    <rect x="48" y="110" width="140" height="16" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
    <rect x="188" y="110" width="132" height="16" fill="none" stroke="#0f766e" stroke-width="1.2" stroke-dasharray="4 3"/>
    <text x="196" y="142" fill="#0f766e">LAG</text>

    <text x="12" y="192" opacity="0.8">p2</text>
    <rect x="48" y="180" width="276" height="16" fill="#0f766e" fill-opacity="0.16"/>
    <rect x="324" y="180" width="60" height="16" fill="url(#cglag)"/>
    <rect x="48" y="180" width="276" height="16" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
    <rect x="324" y="180" width="60" height="16" fill="none" stroke="#0f766e" stroke-width="1.2" stroke-dasharray="4 3"/>
    <text x="332" y="212" fill="#0f766e">LAG</text>
  </g>

  <g fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2">
    <path d="M150 66 C150 110 70 160 70 232" marker-end="url(#cgar)"/>
    <path d="M250 142 C265 190 290 210 295 232" marker-end="url(#cgar)"/>
    <path d="M200 208 C200 222 160 220 150 232" marker-end="url(#cgar)"/>
  </g>

  <g fill="none" stroke="currentColor" stroke-opacity="0.5">
    <rect x="12" y="234" width="150" height="48" rx="8"/>
    <rect x="220" y="234" width="150" height="48" rx="8"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" text-anchor="middle">
    <text x="87" y="254">consumer A</text>
    <text x="87" y="271" opacity="0.65">owns p0, p2</text>
    <text x="295" y="254">consumer B</text>
    <text x="295" y="271" opacity="0.65">owns p1</text>
  </g>
</svg>
<figcaption>FIG. 1 — One group, three partitions, two consumers. Each partition is owned by exactly one member, and lag is the unread tail at the right end of each bar. A third or fourth consumer on this topic holds zero partitions.</figcaption>
</figure>

## Offsets, COMMITTED vs LOG-END, and where lag comes from

Offsets are per-partition, monotonically increasing integers — positions in the append-only log. A consumer tracks two of them:

- **CURRENT-OFFSET** is the last offset the group has *committed*. It is the durable bookmark: if every consumer died right now, this is where a restarted consumer resumes from.
- **LOG-END-OFFSET** is the offset of the next record that will be appended — the head of the log at this instant.

**Consumer lag is the difference between them**, per partition, and nothing else. `LAG 0` does not mean "no work", it means "caught up at this instant". `LAG 600` means six hundred records have landed in the log that this group has not committed past.

Committing is a separate decision from reading, and the default is auto-commit every five seconds — which is why freshly-consumed data can still show lag for a few seconds, and why a crash between "processed" and "committed" costs you at-least-once redelivery rather than silent loss. Process, then commit, in that order.

## Reading `kafka-consumer-groups --describe`

This is the tool, and it is most of the dashboard you need:

```text
$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 --describe --group dlt-worker --state

GROUP                     COORDINATOR (ID)          ASSIGNMENT-STRATEGY  STATE     #MEMBERS
dlt-worker                localhost:9092  (1)                            Stable   1
```

Add `--members` for who-owns-what and `--export` for machine-readable output. Three things to read in the plain `--describe` output: **per-partition LAG** (never only the sum — one hot partition hides behind healthy ones), the **CONSUMER-ID** column (`-` means the group has no active members at all), and the group **STATE** (`Stable`, `Empty`, `PreparingRebalance`, `CompletingRebalance`, `Dead`). A group stuck in `PreparingRebalance` is consuming nothing while it argues about ownership.

## What makes consumer lag grow

I stopped the consumer entirely and produced eighteen more messages. Nothing committed them:

```text
$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 --describe --group dlt-worker

Consumer group 'dlt-worker' has no active members.

GROUP           TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
dlt-worker      orders          0          4               10              6
dlt-worker      orders          1          4               10              6
dlt-worker      orders          2          4               10              6
```

Eighteen messages, `LAG 6` on each of the three partitions. The four causes that matter in practice:

1. **A stopped or crashed consumer.** If the whole group is gone, nothing commits and lag grows in a straight line. That is the table above.
2. **A processing rate below the arrival rate.** A slow downstream, a lock, GC pauses, an N+1 query per record. This is the one that creeps — it never looks like an incident until it does.
3. **A burst.** I produced 3,000 messages in a couple of seconds while a healthy consumer was live, and caught it mid-drain:

```text
$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 --describe --group dlt-worker
dlt-worker      orders     0     8312     8912     600
dlt-worker      orders     1     16612    17812    1200
dlt-worker      orders     2     16612    17812    1200
```

A flat `LAG 0` that spikes to 3,000 and returns to zero in under half a minute is not an incident — it is a healthy consumer absorbing a spike. This is exactly why **you alert on the rate of change, not the absolute value**: a lag number with no slope is about as informative as a CPU graph with no time axis.

4. **Too few partitions for the consumers you already run.** If the group is at the partition cap, scaling the deployment out does nothing, and the only lever left is repartitioning.

## Rebalancing: what triggers it, and what it costs

A rebalance happens whenever group membership or subscription changes: a consumer joins or leaves, a consumer's `session.timeout.ms` expires, someone subscribes to an additional topic, or the partition count changes. The group must agree on a new assignment, and during that agreement it is not consuming.

Here is a real one. One consumer, `console-consumer-9b53099e…`, held all three partitions; then I started a second, `console-consumer-793325b8…`. Before and after, straight from `--describe`:

```text
# before — one consumer owns everything
dlt-worker      orders     0     10     10     0     console-consumer-9b53099e-df87-4e13-9e9b-b28b615c96bc  /127.0.0.1
dlt-worker      orders     1     10     10     0     console-consumer-9b53099e-df87-4e13-9e9b-b28b615c96bc  /127.0.0.1
dlt-worker      orders     2     10     10     0     console-consumer-9b53099e-df87-4e13-9e9b-b28b615c96bc  /127.0.0.1

# after — second consumer joined
dlt-worker      orders     0     10     10     0     console-consumer-793325b8-a341-47d9-8bd5-62fea2cd7f41  /127.0.0.1
dlt-worker      orders     1     10     10     0     console-consumer-793325b8-a341-47d9-8bd5-62fea2cd7f41  /127.0.0.1
dlt-worker      orders     2     10     10     0     console-consumer-9b53099e-df87-4e13-9e9b-b28b615c96bc  /127.0.0.1
```

The sticky assignor kept what it could: `9b53099e` kept `orders-2` and the newcomer took `orders-0` and `orders-1`. And from the first consumer's own log — this is the pause, in its own words:

```text
[2026-10-14 06:53:28,156] INFO Revoke previously assigned partitions orders-0, orders-1, orders-2
    (org.apache.kafka.clients.consumer.internals.ConsumerRebalanceListenerInvoker)
[2026-10-14 06:53:28,159] INFO Successfully joined group with generation
    Generation{generationId=4, memberId='console-consumer-9b53099e-...', protocol='range'}
[2026-10-14 06:53:28,160] INFO Finished assignment for group at generation 4:
    {console-consumer-9b53099e-...=Assignment(partitions=[orders-2]),
     console-consumer-793325b8-...=Assignment(partitions=[orders-0, orders-1])}
[2026-10-14 06:53:28,163] INFO Adding newly assigned partitions: orders-2
```

Note `Revoke previously assigned partitions orders-0, orders-1, orders-2`. Under the default **eager** protocol every member gives up *everything* before the new assignment is handed out. The consumer stops polling, in-flight work is discarded, then it re-joins, takes a generation bump (`generationId=4`), and re-fetches the committed offset for the partitions it now owns. Consumption does not slow down; it stops for the duration.

Two mitigations worth knowing. **Cooperative rebalancing** (`partition.assignment.strategy=CooperativeStickyAssignor`, or the `consumer` group protocol on modern clients) revokes only the partitions that actually move, so unaffected partitions keep streaming. **Static group membership** (`group.instance.id`) lets a consumer that restarts quickly rejoin with its previous assignment and skip the rebalance entirely — exactly what you want for a rolling deployment.

The failure mode to fear is a rebalance storm: consumers keep timing out because GC pauses or long batches exceed `session.timeout.ms`, so the group rebalances, which makes them slower, so they time out again. Size `max.poll.interval.ms` honestly for your slowest batch and treat rebalance rate as a first-class alert.

## Where offsets live: `__consumer_offsets` and the coordinator

There is no magic. Committed offsets are records in an internal, compacted topic called `__consumer_offsets`, and each group is pinned to one of its fifty partitions by hashing the group id. That partition's leader is the group's **coordinator** — the broker that arbitrates membership and stores the group's state:

```text
$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
    --describe --topic __consumer_offsets
Topic: __consumer_offsets   TopicId: 2Pz8USrWTpC5_kwEZ1Zhcw   PartitionCount: 50
    ReplicationFactor: 1   Configs: compression.type=producer,cleanup.policy=compact,segment.bytes=104857600
```

`cleanup.policy=compact` means the broker keeps only the newest commit per key, forever — which is why you can restart a group weeks later and it resumes exactly where it stopped. The `COORDINATOR (ID)` column from `--describe --state` is simply the leader of that partition. I scanned all fifty partitions, printing only the ones whose records mention our group:

```text
$ for p in $(seq 0 49); do
>   n=$(docker exec kafka-lag-demo /opt/kafka/bin/kafka-console-consumer.sh \
>         --bootstrap-server localhost:9092 --topic __consumer_offsets --partition $p \
>         --offset earliest --timeout-ms 3000 --property print.key=true 2>/dev/null \
>       | strings | grep -c dlt-worker)
>   [ "$n" != "0" ] && echo "partition $p -> $n records mention dlt-worker"
> done
partition 25 -> 1029 records mention dlt-worker

$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-get-offsets.sh \
    --bootstrap-server localhost:9092 --topic __consumer_offsets
__consumer_offsets:25:1050
```

With one broker, `localhost:9092 (id=1)` is the coordinator because it leads every partition. Two operational consequences follow regardless of cluster size: `__consumer_offsets` is the topic to watch for broker disk growth, and if the broker hosting a hot group's coordinator dies, every group on that partition rebalances.

## `auto.offset.reset` and resetting offsets by hand

`auto.offset.reset` decides what happens when a consumer has **no committed offset** for a partition — a brand-new group, or an offset that aged out of `__consumer_offsets`. The default, `latest`, means "start at the head of the log", which silently skips everything already there. I proved it with two fresh groups reading a topic that already held 36 unread messages:

```text
# group 'reporting', auto.offset.reset=latest (the default)
Processed a total of 0 messages
$ ... --describe --group reporting
reporting      orders     0     12     12     0
reporting      orders     1     12     12     0
reporting      orders     2     12     12     0

# group 'backfill', auto.offset.reset=earliest
Processed a total of 36 messages
$ ... --describe --group backfill
backfill      orders     0     12     12     0
backfill      orders     1     12     12     0
backfill      orders     2     12     12     0
```

Zero messages versus thirty-six. If you want a new group to read history, set `auto.offset.reset=earliest` and accept the one-time replay; if you want it to see only new traffic, `latest` is correct. The trap is not knowing which one you got.

When offsets are simply wrong, `kafka-consumer-groups.sh` resets them. **The group must be stopped**, and the default behaviour is a dry run — exactly the safety you want before touching production offsets:

```text
$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 --group dlt-worker --topic orders \
    --reset-offsets --to-earliest --dry-run

GROUP           TOPIC           PARTITION   NEW-OFFSET
dlt-worker      orders          0           0
dlt-worker      orders          1           0
dlt-worker      orders          2           0
```

```text
# the same command with --execute instead of --dry-run
GROUP           TOPIC           PARTITION   NEW-OFFSET
dlt-worker      orders          0           0
dlt-worker      orders          1           0
dlt-worker      orders          2           0
```

After the execute the group sits at `LAG 12` on every partition and the next consumer replays the whole topic. The other useful specifications are `--to-latest` (the "I give up on this backlog" button), `--to-datetime`, `--by-duration`, `--to-offset`, `--shift-by N`, and `--from-file` for a precise replay driven by a saved CSV. One sharp edge I hit for real: `--to-latest` and `--shift-by` cannot be combined, and the tool says so by dumping its entire help text at you.

## The honest operational advice

- **Alert on lag per partition, and on its rate of change.** A partition at 50,000 and falling is fine. A partition at 500 and rising for an hour is not. Sums hide the partition that matters.
- **Alert on rebalance rate.** More than a handful per hour on a stable deployment means your timeouts are wrong, not that Kafka is broken.
- **Add partitions, not consumers, when you need throughput** — and do it early and deliberately, because partitions cannot be removed and repartitioning a keyed topic breaks the ordering you relied on.
- **Never use `auto.offset.reset` as a recovery mechanism.** It only applies when there is nothing to resume from; a group with a wrong committed offset needs a deliberate `--reset-offsets`.
- **Watch `__consumer_offsets` disk growth**, and the lag of your own lag-exporting consumer. A monitoring consumer that falls behind is worse than no monitoring at all.

`kafka-consumer-groups --describe` is not a debug tool you reach for during an incident. It is the primary health signal of every streaming system you will ever run, and it is one command long.
