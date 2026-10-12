---
title: "Redis Sentinel vs Redis Cluster: a real failover, real hash slots, and which you need"
description: "The practical difference between Redis Sentinel and Redis Cluster: a real failover demo with three sentinels, a real MOVED redirect and 16384 hash slots with a 3-master cluster, the honest costs of each, and a decision list for which one your setup actually needs."
pubDate: 2027-01-11
lang: en
translationKey: redis-sentinel-vs-cluster
tags: [devops, self-hosting]
featured: false
keywords:
  - Redis Sentinel
  - Redis Cluster
  - failover
  - hash slots
  - MOVED
---

People ask "Redis Sentinel or Redis Cluster?" the way they ask "hammer or screwdriver" — as if the two were interchangeable. They are not. **Redis Sentinel** and **Redis Cluster** solve two different problems: Sentinel gives you automatic **failover** for a dataset that fits on one node, Cluster gives you horizontal scaling by sharding across **hash slots**. Most services need the first; many never need the second. I stood both up in throwaway containers (Redis 8.10), killed a primary and watched Sentinel promote the replica, built a 3-master cluster and caught a genuine `MOVED`. Everything below is pasted from the real run.

## Two problems, not one

Get the problem statement right before touching tooling:

1. **Availability:** my primary dies. Who promotes the replica, who rewires the rest, and how do clients find the new primary? That is **failover**. The dataset still lives on exactly one primary.
2. **Capacity:** my dataset or write throughput no longer fits on one node. No amount of failover helps — the data must spread across many nodes. That is **sharding**.

Sentinel answers problem 1. Cluster answers problem 2 *and* ships its own per-shard failover. Running Cluster when you only needed problem 1 solved is the most common over-engineering mistake I see with Redis.

<figure>
<svg viewBox="0 0 680 330" width="100%" role="img" aria-label="Two diagrams. Left: Redis Sentinel — three sentinel processes watch a primary and one replica; when the primary dies, the sentinels promote the replica, which becomes the new primary. Right: Redis Cluster — a key is hashed with CRC16 modulo 16384 to a hash slot, and each slot range lives on a specific master node.">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="30" y="28" font-weight="600" font-size="14">Sentinel: failover, one logical primary</text>
    <g>
      <rect x="30" y="46" width="62" height="30" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="61" y="65" text-anchor="middle" font-size="12">S1</text>
      <rect x="100" y="46" width="62" height="30" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="131" y="65" text-anchor="middle" font-size="12">S2</text>
      <rect x="170" y="46" width="62" height="30" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="201" y="65" text-anchor="middle" font-size="12">S3</text>
    </g>
    <text x="252" y="65" font-size="11" opacity="0.75">quorum 2/3</text>
    <rect x="40" y="130" width="88" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.55"/>
    <text x="84" y="150" text-anchor="middle" font-size="12">primary</text>
    <text x="84" y="166" text-anchor="middle" font-size="11" opacity="0.6">(killed)</text>
    <rect x="170" y="130" width="88" height="44" rx="8" fill="none" stroke="#0f766e" stroke-width="2"/>
    <text x="214" y="150" text-anchor="middle" font-size="12" fill="#0f766e" font-weight="600">replica</text>
    <text x="214" y="166" text-anchor="middle" font-size="11" opacity="0.7">becomes primary</text>
    <g stroke="currentColor" stroke-width="1.5" fill="none">
      <path d="M61 76 L70 130" stroke-dasharray="4 3"/>
      <path d="M131 76 L140 130" stroke-dasharray="4 3"/>
      <path d="M201 76 L210 130" stroke-dasharray="4 3"/>
    </g>
    <path d="M214 118 L90 118" stroke="#0f766e" stroke-width="2" fill="none" marker-end="url(#arrowTeal)"/>
    <text x="152" y="112" text-anchor="middle" font-size="11" fill="#0f766e">promote</text>
    <text x="30" y="210" font-size="11" opacity="0.75">clients ask a sentinel for the master address;</text>
    <text x="30" y="228" font-size="11" opacity="0.75">the dataset stays on exactly one node.</text>
    <line x1="330" y1="20" x2="330" y2="300" stroke="currentColor" stroke-width="1" opacity="0.25"/>
    <text x="360" y="28" font-weight="600" font-size="14">Cluster: sharding by hash slots</text>
    <rect x="360" y="46" width="104" height="30" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="412" y="65" text-anchor="middle" font-size="12">key “cart:7”</text>
    <rect x="486" y="46" width="150" height="30" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="561" y="65" text-anchor="middle" font-size="11">CRC16 mod 16384</text>
    <path d="M464 61 L486 61" stroke="currentColor" stroke-width="1.5" fill="none" marker-end="url(#arrowTeal)"/>
    <g>
      <rect x="360" y="110" width="130" height="34" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="425" y="131" text-anchor="middle" font-size="11">M1: slots 0–5460</text>
      <rect x="360" y="152" width="130" height="34" rx="6" fill="none" stroke="#0f766e" stroke-width="2"/>
      <text x="425" y="173" text-anchor="middle" font-size="11" fill="#0f766e" font-weight="600">M2: 5461–10922</text>
      <rect x="360" y="194" width="130" height="34" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="425" y="215" text-anchor="middle" font-size="11">M3: 10923–16383</text>
    </g>
    <text x="510" y="110" font-size="11" opacity="0.75">slot 9546 → M2</text>
    <path d="M561 76 L561 131" stroke="currentColor" stroke-width="1.5" fill="none" marker-end="url(#arrowTeal)"/>
    <path d="M561 131 L490 152" stroke="#0f766e" stroke-width="2" fill="none" marker-end="url(#arrowTeal)"/>
    <text x="360" y="252" font-size="11" opacity="0.75">each key lives on exactly one master;</text>
    <text x="360" y="270" font-size="11" opacity="0.75">wrong node answers MOVED with the right one.</text>
    <defs>
      <marker id="arrowTeal" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
        <path d="M0 0 L8 4 L0 8 z" fill="context-stroke"/>
      </marker>
    </defs>
  </g>
</svg>
<figcaption>The two shapes of the solution. Sentinel moves the role when a machine dies; Cluster moves the keys so no single machine has to hold them all.</figcaption>
</figure>

## Redis Sentinel: failover without sharding

Sentinel is a separate process — three, ideally — doing exactly three jobs: **monitoring** (is the primary answering?), **failover** (promote a replica and rewire the rest when it isn't), and **configuration discovery** (tell clients who the primary is now). It keeps a single logical primary; your dataset never splits.

### Setup: one primary, one replica, three sentinels

```bash
$ docker run -d --name r-primary --network redis-ha -p 127.0.0.1:6379:6379 redis:8-alpine
$ docker run -d --name r-replica --network redis-ha redis:8-alpine redis-server --replicaof r-primary 6379
```

Each sentinel gets one config file:

```bash
port 26379
sentinel monitor mymaster 172.19.0.2 6379 2
sentinel down-after-milliseconds mymaster 5000
sentinel failover-timeout mymaster 10000
sentinel parallel-syncs mymaster 1
```

That trailing `2` is the **quorum**: how many sentinels must agree the primary is down before a failover may start. I ran three sentinels and asked one what it knew:

```text
$ docker exec s1 redis-cli -p 26379 SENTINEL master mymaster   # selected fields
flags	master
down-after-milliseconds	5000
num-slaves	1
num-other-sentinels	2
quorum	2
failover-timeout	10000
parallel-syncs	1
```

I wrote `SET pricing:hot "19.99"` on the primary and read it back from the replica; the replica's `INFO replication` said `role:slave`, `master_host:172.19.0.2`, `master_link_status:up`.

### Killing the primary: what Sentinel actually does

Then `docker kill r-primary` — SIGKILL, no graceful shutdown. Meanwhile a throwaway client looped: ask Sentinel for the current master, `GET pricing:hot` from it, sleep a second, repeat. Slices of both logs:

```text
22:18:15 master=172.19.0.2:6379 -> 19.99        <- client, healthy
22:18:16 master=172.19.0.2:6379 -> 19.99        <- last success before the kill
22:18:59 master=172.19.0.2:6379 -> Could not connect to Redis at 172.19.0.2:6379: Host is unreachable
22:19:00 master=172.19.0.3:6379 -> 19.99        <- new primary, same data
22:19:01 master=172.19.0.3:6379 -> 19.99
```

The client never reconnected to a hardcoded IP and hoped — each iteration it ran `SENTINEL get-master-addr-by-name mymaster` and used the answer. That is the whole integration contract. Note the 22:18:16 → 22:18:59 gap: the connection to the dead IP hung until the kernel gave up — a production client behaves identically unless you set tight timeouts and retry against a freshly discovered address.

Sentinel's own log, same seconds, is the failover in order:

```text
22:18:21.936 # +sdown master mymaster 172.19.0.2 6379
22:18:22.012 # +odown master mymaster 172.19.0.2 6379 #quorum 2/2
22:18:22.012 # +try-failover master mymaster 172.19.0.2 6379
22:18:22.013 # +vote-for-leader 0739ae1b00fe75351dd41f3ecbae101f43ad16e0 1
22:18:22.089 # +elected-leader master mymaster 172.19.0.2 6379
22:18:22.089 # +failover-state-select-slave master mymaster 172.19.0.2 6379
22:18:22.173 # +selected-slave slave 172.19.0.3:6379 172.19.0.3 6379 @ mymaster 172.19.0.2 6379
22:18:23.049 # +failover-state-reconf-slaves master mymaster 172.19.0.2 6379
22:18:23.120 # +switch-master mymaster 172.19.0.2 6379 172.19.0.3 6379
```

Read the chain in order: one sentinel saw silence (`+sdown`), the second agreed (`+odown ... #quorum 2/2`), the sentinels elected a single orchestrator (`+elected-leader`) so only one acts, it picked the best replica (`+selected-slave`) and sent it `SLAVEOF NO ONE` — visible as `role:master` in `INFO replication`. `+switch-master` is the moment the rest of the world learns the new address. Detection cost the configured five seconds (kill 22:18:16, `+sdown` 22:18:21.9); election and promotion took about one more. The knobs are `down-after-milliseconds` and `failover-timeout`.

Sentinel also healed the wreckage unprompted. The old primary came back later — `docker start r-primary` — and Sentinel reconfigured it into a replica of the new primary, persisting the reconfiguration with `CONFIG REWRITE` so it survives restarts:

```text
$ docker exec r-primary redis-cli INFO replication
# Replication
role:slave
master_host:172.19.0.3
master_link_status:up
```

`GET pricing:hot` on it returned `19.99`: the key written before the kill survived because replication had already shipped it to the node that got promoted — Sentinel moves the *role*, the replica's data becomes the primary's data. The new primary also carried `master_replid2` set to the old primary's replication ID (`5c5d4fd4...`), which lets a returning node resume from a partial resync instead of a full copy.

### Quorum: why three sentinels

Quorum is where the arithmetic bites. With **three sentinels and quorum 2** you survive one dead sentinel (2 remain, still a majority) and can still fail over while it's gone. A single sentinel is a single point of failure deciding your database's fate: if it loses network it will happily "fail over" while the real primary is alive and fine, giving you two writers. Use odd counts — 3 for a small setup, 5 spread across failure domains — keep them off the Redis nodes when you can, and remember they're cheap: a few MB of RAM each.

### What the client does: discovery, not magic

Sentinel is not a proxy — clients participate: subscribe to the `+switch-master` pub/sub event, poll `SENTINEL get-master-addr-by-name` (what my loop did), or use a client library with Sentinel support (redis-py, Lettuce, Jedis all have it). A replica will serve reads if you point at it explicitly; Sentinel will not route your reads for you.

## Redis Cluster: hash slots and real scaling

Cluster is a different animal: every node is a shard, data is partitioned by key, and failover happens per shard automatically, no Sentinel involved:

```bash
$ docker run -d --name c1 --network redis-cluster redis:8-alpine \
    redis-server --cluster-enabled yes --cluster-config-file nodes.conf --port 6379 \
    --cluster-node-timeout 2000 --appendonly yes
# ... c2 and c3 identical ...
$ docker run --rm --network redis-cluster redis:8-alpine \
    redis-cli --cluster create c1:6379 c2:6379 c3:6379 --cluster-replicas 0 --cluster-yes
>>> Performing hash slots allocation on 3 nodes...
Master[0] -> Slots 0 - 5460
Master[1] -> Slots 5461 - 10922
Master[2] -> Slots 10923 - 16383
[OK] All 16384 slots covered.
```

### 16384 slots, assigned once

The keyspace is chopped into **16384 hash slots**. A key's slot is `CRC16(key) mod 16384` — deterministic, no lookup table, every node computes it identically. Each slot is owned by exactly one master, and `CLUSTER NODES` writes the map down:

```text
$ docker exec c1 redis-cli CLUSTER NODES
b8fd1c3704e73068b973a040765dffbc716fb257 172.22.0.4:6379@16379 master - 0 1791843648095 3 connected 10923-16383
c720456a5d1f451edbbbe167f0b9f98643284129 172.22.0.3:6379@16379 master - 0 1791843648196 2 connected 5461-10922
d4133a12f6cb7164bc933f690241134b5931e040 172.22.0.2:6379@16379 myself,master - 0 0 1 connected 0-5460

$ docker exec c1 redis-cli CLUSTER INFO
cluster_state:ok
cluster_slots_assigned:16384
cluster_slots_ok:16384
cluster_known_nodes:3
cluster_size:3
```

`CLUSTER INFO` is your health readout: `cluster_state:ok` means every assigned slot has a serving owner. The `@16379` ports are the cluster bus — the gossip channel nodes use to monitor each other and run their own per-shard failover.

### A real MOVED redirect

Now the part people quote but rarely run. Take a key, ask which slot it hashes to, then send it to a node that doesn't own that slot:

```text
$ docker exec c1 redis-cli CLUSTER KEYSLOT cart:7
9546
$ docker exec c1 redis-cli SET cart:7 "3 items"
MOVED 9546 172.22.0.3:6379
$ docker exec c1 redis-cli -c SET cart:7 "3 items"
OK
$ docker exec c2 redis-cli GET cart:7
"3 items"
```

That `MOVED 9546 172.22.0.3:6379` is the protocol saying, permanently: slot 9546 lives on 172.22.0.3, stop asking me. `redis-cli -c` follows redirects and caches the map; smart client libraries do the same and refresh on `MOVED`. During a live reshard you may instead see `ASK`, which is temporary — "the key is migrating, try the target for this request, but the map hasn't changed."

### Multi-key operations and the CROSSSLOT wall

Here is the constraint that decides most "can I use Cluster?" questions. Keys in one atomic operation must live in one slot, because the command executes on one node:

```text
$ docker exec c1 redis-cli MSET user:1000 alex cart:7 x
CROSSSLOT Keys in request don't hash to the same slot
$ docker exec c1 redis-cli CLUSTER KEYSLOT user:1000
1649
$ docker exec c1 redis-cli CLUSTER KEYSLOT cart:7
9546
```

`GET`, `SET`, `INCR` are fine anywhere — each key routes to its owner. But `MSET`, multi-key `MGET`/`DEL`, `SUNION`, Lua scripts, and `MULTI`/`EXEC` transactions across keys all demand one slot. The escape hatch is **hash tags**: only the substring inside braces is hashed, so you can co-locate keys deliberately.

```text
$ docker exec c1 redis-cli CLUSTER KEYSLOT '{cart}:7'
15997
$ docker exec c1 redis-cli CLUSTER KEYSLOT '{cart}:8'
15997
$ docker exec c1 redis-cli -c MSET '{cart}:7' '3 items' '{cart}:8' '1 item'
OK
$ docker exec c1 redis-cli -c MGET '{cart}:7' '{cart}:8'
1) "3 items"
2) "1 item"
```

And a shard is a shard. My cluster ended with two keys — `session:42` on c1, `cart:7` on c2 — and `KEYS *` on each node returned only its own. No command lists the whole cluster's keys; you visit every node or use a client that fans out.

## The honest cost of each

**Sentinel, honestly:** three extra processes to run and monitor; a short true outage window during failover — seconds, with in-flight writes lost unless your client waits; no scaling story at all, the primary is still the throughput ceiling. In exchange you keep normal client semantics, no redirects, and no data-model constraints, and reads scale by adding replicas. Backups and persistence stay your separate problem: Sentinel will faithfully replicate a bad `DELETE` too (see [Redis patterns that actually earn their place](/posts/redis-patterns/)).

**Cluster, honestly:** six nodes as the smallest sane production shape (3 masters + 3 replicas); a cluster-aware client is mandatory (redirect handling, slot-map caching, per-node pools) or nothing works; the slot model restricts multi-key semantics, and that leaks into your schema (`{user}:1`-style keys everywhere); operations gain new failure modes — resharding is a real migration you plan, failover is per shard so errors surface unevenly, and each node's memory is a hard planning number. What you buy: memory and write throughput that scale linearly by adding shards, plus automatic failover without a second system. And if the open question is whether you need Redis at all, that comparison is [Redis vs Memcached](/posts/redis-vs-memcached/) — HA is downstream of it.

## Which one do you actually need

A decision list, ordered by how most services should go:

- **Single node, plus backups, plus good persistence settings.** If the dataset fits in one box's RAM, the keyspace is rebuildable (a cache, a rate limiter, a session store), and minutes of downtime after a crash is tolerable — you are done. RDB/AOF to durable storage beats a second daemon you never test.
- **Sentinel, when availability is the requirement and capacity is not.** Failover in seconds, dataset still fits one node. Writes land on one primary, so plan for the failover window losing in-flight commands. Use 3 sentinels, quorum 2, set `down-after-milliseconds` to 2–5× normal ping RTT so a network blip doesn't trigger a failover, and make your client discover the master instead of hardcoding it.
- **Cluster, when you have outgrown one node — memory or throughput, not fear.** Checklist before committing: the dataset comfortably exceeds one node's RAM (or writes saturate it), access patterns are single-key or hash-taggable, your client library genuinely supports cluster mode, and someone will own resharding and node replacement. If any of those is false, the cluster will cause more outages than the machine death it protects against.

Order matters: backups buy durability, Sentinel buys availability, Cluster buys capacity. Pay for exactly what you lack — the expensive mistake is buying capacity when you lacked availability, or buying either when you lacked durability all along.
