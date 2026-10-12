---
title: "Consensus in practice: etcd, quorum, and why odd numbers matter"
description: "Consensus, learned by running it: a throwaway 3-node etcd cluster with real etcdctl output, a watch and a lease, a transaction, quorum proven by killing the leader, and why Raft wants odd numbers."
pubDate: 2026-12-14
lang: en
translationKey: consensus-and-etcd
tags: [devops, networking]
featured: false
keywords:
  - etcd
  - Raft consensus
  - quorum
  - leader election
  - linearizable
---

Every distributed system eventually hits the same wall: several machines, each with its own copy of the truth, and one that has just lost power. **Consensus** is the job of making them agree anyway — not on a single value, but on an *ordered log* of values, so every replica replays the same history in the same order. **etcd** is a small, reliable implementation of that idea, built on the **Raft consensus** algorithm, and Kubernetes, service discovery, and distributed locks all quietly stand on it. I wanted to show **quorum** with real numbers instead of a diagram, so I stood up a throwaway 3-node cluster on `127.0.0.1`, ran the operations people actually deploy it for, killed a node, and copied the terminal back out.

Everything below is real output from three `quay.io/coreos/etcd:v3.5.16` containers on host networking, bound to `127.0.0.1` and torn down afterward.

## The problem consensus solves: agree on one ordered log

The trick that makes consensus tractable is state-machine replication: if every replica starts from the same state and applies the same commands in the same order, they end in the same state. So the hard part is not agreeing on *a* value, but on the *order* of a stream of values — which is why Raft and Paxos are described as replicated logs.

Raft assumes *crash*-faults, not lying nodes (Byzantine fault tolerance is a much harder problem). And it does not try to be available always: under asynchrony with crashes, no algorithm guarantees both safety and liveness, so Raft keeps **safety always** and gives up **liveness** during a partition, staying available only while a majority can reach each other. That trade is why **quorum** is the central word here.

## Raft consensus in one page

Raft has three roles and one number: a node is **leader**, **follower**, or **candidate**; the **term** is a monotonically increasing integer that every election bumps, and seeing a higher term makes any node step down.

### Leader election

Followers expect a heartbeat from the leader. If none arrives within a randomized **election timeout** (etcd: roughly 1000 ms), a follower becomes a **candidate**, increments the term, votes for itself, and asks the others for theirs. A candidate that collects a **majority** wins; one that sees a higher term or an existing leader steps down. The randomization makes two nodes timing out at once unlikely.

### Log replication

Clients never write to a follower. A write goes to the leader, which appends it to its log and ships `AppendEntries` to the followers. Once a **majority of the cluster** — the leader counts itself — has the entry **persisted to disk** (the WAL is `fsync`ed), it is *committed*; only then does the leader apply it and answer the client. Durability lives in that fsync on a quorum of disks, not in RAM.

### Quorum = majority

For `N` nodes the quorum is `⌊N/2⌋ + 1`, and two facts follow. **Any two quorums intersect**, and since every committed entry was acked by a majority, a new leader's quorum must contain a node that saw every committed entry — so a leader missing committed data cannot be elected. That is *linearizability*. And you can lose `N − quorum` nodes and keep serving.

<figure>
<svg viewBox="0 0 680 268" width="100%" role="img" aria-label="A three-node Raft cluster. Node 1 is the leader; nodes 2 and 3 are followers. The leader replicates each entry to the followers and the entry is committed once a majority of two of three has fsynced it. The quorum here is the leader plus one follower.">
  <defs>
    <marker id="raft-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>

  <rect x="18" y="14" width="418" height="248" rx="16" fill="#0f766e" opacity="0.06" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="6 5"/>
  <text x="34" y="36" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12" font-weight="600">quorum = leader + 1 follower = 2 of 3</text>

  <rect x="250" y="52" width="180" height="82" rx="12" fill="none" stroke="#0f766e" stroke-width="2.5"/>
  <text x="340" y="86" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="16" font-weight="600">node 1</text>
  <text x="340" y="110" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12" font-weight="600">LEADER</text>

  <rect x="60" y="172" width="180" height="82" rx="12" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.65"/>
  <text x="150" y="206" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="16" font-weight="600">node 2</text>
  <text x="150" y="230" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12" opacity="0.8">follower · fsync WAL</text>

  <rect x="440" y="172" width="180" height="82" rx="12" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.65"/>
  <text x="530" y="206" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="16" font-weight="600">node 3</text>
  <text x="530" y="230" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12" opacity="0.8">follower · optional</text>

  <g fill="none" stroke="#0f766e" stroke-width="2">
    <line x1="300" y1="136" x2="176" y2="168" marker-end="url(#raft-arrow)"/>
    <line x1="382" y1="136" x2="506" y2="168" marker-end="url(#raft-arrow)"/>
  </g>
  <text x="238" y="158" text-anchor="end" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">AppendEntries</text>
</svg>
<figcaption>A 3-node Raft cluster. Writes go to the leader, are replicated to followers, and commit once a majority (2 of 3) has fsynced them. Node 3's acknowledgement is not needed for this write — but it is needed to survive a second failure.</figcaption>
</figure>

## Why quorum wants odd numbers

Put the arithmetic in a table and the "odd numbers" folklore explains itself.

| Nodes `N` | Quorum `⌊N/2⌋+1` | Failures tolerated `⌊(N−1)/2⌋` |
|----------:|------------------:|------------------------------:|
| 1 | 1 | 0 |
| 2 | 2 | **0** |
| 3 | 2 | 1 |
| 4 | 3 | 1 |
| 5 | 3 | 2 |
| 6 | 4 | 2 |
| 7 | 4 | 3 |

A 2-node cluster is the trap: its quorum is 2, so **losing either node stops all writes** — no more available than one node at twice the cost. There is no 2-node high availability. A 4-node cluster tolerates the same one failure as a 3-node one while paying for an extra node and an extra fsync ack per write, and it can partition 2-2, leaving *both* halves unable to elect a leader. A 5-node cluster tolerates two simultaneous failures, which is why production control planes often use five.

So the useful sizes are 1, 3, 5, 7. Odd just means no wasted node: with `N` even the majority threshold equals the one for `N−1`, so the extra node buys only latency and money. Even clusters are also likelier to partition symmetrically — exactly when neither side can make progress.

## What etcd gives you

etcd packages Raft behind a useful API:

- **A linearizable key-value store.** `put`/`get`/`delete` operate on the replicated log, and a default `get` is linearizable — it goes through the leader, so you cannot read a stale value.
- **Watches.** A stream of changes from a revision onward, so controllers and config reloaders learn about updates without polling.
- **Leases.** A TTL attached to keys. Keep it alive or the key disappears on its own — the primitive behind leader election and locks.
- **Transactions.** Compare-and-swap over multiple keys in one atomic step, the basis of locks and optimistic concurrency.

Kubernetes keeps its entire cluster state in etcd — every object, plus its own leader-election `Lease` records. Service discovery uses watches; locks and leader election use leases and transactions. Patroni uses etcd as the consensus store for [Postgres replication](/posts/postgres-replication/) failover — even "the database" leans on a consensus primitive. And the total order you reach for here is exactly what [message queues](/posts/message-queues/) are careful *not* to promise.

## Standing up a cluster and reading quorum off the terminal

Three containers, host networking, one process per node:

```bash
docker run -d --name etcd-n1 --network host quay.io/coreos/etcd:v3.5.16 etcd \
  --name n1 \
  --initial-advertise-peer-urls http://127.0.0.1:2380 \
  --listen-peer-urls http://127.0.0.1:2380 \
  --listen-client-urls http://127.0.0.1:2379 \
  --advertise-client-urls http://127.0.0.1:2379 \
  --initial-cluster "n1=http://127.0.0.1:2380,n2=http://127.0.0.1:2480,n3=http://127.0.0.1:2580" \
  --initial-cluster-token etcd-lab-token --initial-cluster-state new
# ...same for etcd-n2 (2479/2480) and etcd-n3 (2579/2580)
```

`endpoint status` is the single most useful command: it tells you who the leader is, right now.

```text
$ etcdctl --endpoints=2379,2479,2579 endpoint status --write-out=table
+-----------------------+-----------------+---------+---------+-----------+------------+-----------+------------+--------------------+--------+
|       ENDPOINT        |       ID        | VERSION | DB SIZE | IS LEADER | IS LEARNER | RAFT TERM | RAFT INDEX | RAFT APPLIED INDEX | ERRORS |
+-----------------------+-----------------+---------+---------+-----------+------------+-----------+------------+--------------------+--------+
| http://127.0.0.1:2379 | c25e5b1c0555423 |  3.5.16 |   20 kB |      true |      false |         2 |         11 |                 11 |        |
| http://127.0.0.1:2479 | f2fadaf659e19a3 |  3.5.16 |   20 kB |     false |      false |         2 |         11 |                 11 |        |
| http://127.0.0.1:2579 |  b5de7d28e0c8b6 |  3.5.16 |   20 kB |     false |      false |         2 |         11 |                 11 |        |
+-----------------------+-----------------+---------+---------+-----------+------------+-----------+------------+--------------------+--------+

$ etcdctl --endpoints=2379,2479,2579 endpoint health --write-out=table
+-----------------------+--------+-------------+-------+
|       ENDPOINT        | HEALTH |    TOOK     | ERROR |
+-----------------------+--------+-------------+-------+
| http://127.0.0.1:2379 |   true |  6.649745ms |       |
| http://127.0.0.1:2479 |   true |  7.072436ms |       |
| http://127.0.0.1:2579 |   true | 11.039627ms |       |
+-----------------------+--------+-------------+-------+
```

`IS LEADER = true` marks the leader; `RAFT TERM` matches across nodes, and `RAFT INDEX` equal to `RAFT APPLIED INDEX` means every node has caught up. `member list` shows the configuration Raft is deciding on:

```text
$ etcdctl --endpoints=2379,2479,2579 member list --write-out=table
+-----------------+---------+------+-----------------------+-----------------------+------------+
|       ID        | STATUS  | NAME |      PEER ADDRS       |     CLIENT ADDRS      | IS LEARNER |
+-----------------+---------+------+-----------------------+-----------------------+------------+
|  b5de7d28e0c8b6 | started |   n3 | http://127.0.0.1:2580 | http://127.0.0.1:2579 |      false |
| c25e5b1c0555423 | started |   n1 | http://127.0.0.1:2380 | http://127.0.0.1:2379 |      false |
| f2fadaf659e19a3 | started |   n2 | http://127.0.0.1:2480 | http://127.0.0.1:2479 |      false |
+-----------------+---------+------+-----------------------+-----------------------+------------+
```

### Reading, writing, and watching a change arrive

```text
$ etcdctl put /config/site/theme dark
OK

$ etcdctl get /config/site/theme
/config/site/theme
dark

# a watch open in one terminal, then a put in another:
$ etcdctl watch /config/site/theme
PUT
/config/site/theme
nord
```

The watch fired with the *change*, not a poll result — Raft's log, streamed to the client from whatever revision it asked for.

### Transactions: compare-and-swap, the basis of locks

A transaction compares one or more keys and runs one set of requests if the comparison holds, another if not — optimistic concurrency: a writer commits only if the world still looks the way it assumed.

```text
# only advance version if the theme is still "nord":
$ etcdctl txn
compares:
success requests (get, put, del):
failure requests (get, put, del):
SUCCESS

OK

# a stale writer that still thinks the theme is "dark" is rejected:
$ etcdctl txn
compares:
success requests (get, put, del):
failure requests (get, put, del):
FAILURE

/config/site/version
2
```

The stale writer's `put /config/site/version 3` never ran; the failure branch did. That single property — "make this write conditional on a value I read" — is what turns a key-value store into a lock service.

### Leases: TTL, and what happens when a client dies

```text
$ etcdctl lease grant 10
lease 5423a12f6b7d1d11 granted with TTL(10s)

$ etcdctl put /locks/leader node-a --lease=5423a12f6b7d1d11
OK

$ etcdctl lease timetolive 5423a12f6b7d1d11 --keys
lease 5423a12f6b7d1d11 granted with TTL(10s), remaining(9s), attached keys([/locks/leader])

# ...wait 11s without keepalive...
$ etcdctl get /locks/leader
$ echo $?
0
$ etcdctl lease timetolive 5423a12f6b7d1d11
lease 5423a12f6b7d1d11 already expired
```

No delete was issued; the key vanished because its lease lapsed. That is the entire mechanism of failure detection in a lease-based lock.

## Proving quorum by killing nodes

I stopped the **leader**, node 1:

```text
$ etcdctl --endpoints=2479,2579 endpoint status --write-out=table
+-----------------------+-----------------+---------+---------+-----------+------------+-----------+------------+--------------------+--------+
|       ENDPOINT        |       ID        | VERSION | DB SIZE | IS LEADER | IS LEARNER | RAFT TERM | RAFT INDEX | RAFT APPLIED INDEX | ERRORS |
+-----------------------+-----------------+---------+---------+-----------+------------+-----------+------------+--------------------+--------+
| http://127.0.0.1:2479 | f2fadaf659e19a3 |  3.5.16 |   20 kB |      true |      false |         3 |         26 |                 26 |        |
| http://127.0.0.1:2579 |  b5de7d28e0c8b6 |  3.5.16 |   20 kB |     false |      false |         3 |         26 |                 26 |        |
+-----------------------+-----------------+---------+---------+-----------+------------+-----------+------------+--------------------+--------+

$ etcdctl --endpoints=2479,2579 put /config/site/theme solar
OK
```

Two things moved: `RAFT TERM` went 2 → 3, so a new election happened, and the leader is now node 2. The remaining two of three still form a quorum, so writes continue — the failover people mean by "highly available", at the cost of about one election timeout.

Then I stopped node 2 as well, leaving one of three:

```text
$ etcdctl --endpoints=2579 endpoint health --write-out=table
+-----------------------+--------+--------------+---------------------------+
|       ENDPOINT        | HEALTH |     TOOK     |           ERROR           |
+-----------------------+--------+--------------+---------------------------+
| http://127.0.0.1:2579 |  false | 3.001579531s | context deadline exceeded |
+-----------------------+--------+--------------+---------------------------+
Error: unhealthy cluster

$ etcdctl --endpoints=2579 put /config/site/theme aqua
Error: context deadline exceeded
```

With only one of three nodes there is no quorum, so the survivor cannot elect itself leader or commit anything. Note the *shape* of the failure: the write did not return "no", it **blocked** until the client's deadline. The node is up, its data intact — it just refuses to lie to you. Bring the others back and it rejoins.

## Leader election as a pattern: hold a lease, keep it alive

The lease demo above *is* leader election. Candidates all try to create the same key, say `/locks/leader`, under a lease, with a transaction that succeeds only if the key does not already exist (compare `create_revision == 0`). Exactly one wins. The winner holds the lease and renews it with `KeepAlive`; the losers watch the key. If the leader crashes or its network drops, its lease stops being renewed, the key expires after the TTL, the watchers wake, and one of them wins the next transaction. Failover takes on the order of the TTL — which is why leases are short, a few seconds.

Two footnotes I keep having to explain. **Ownership is a lease, not a flag:** you are leader *while your lease is alive*, so re-check before acting and treat a keepalive failure as losing the election. **Reads are not free of consensus:** a follower can serve a stale read, so decide from the leader or from a watch at a known revision. And Kubernetes uses this same pattern — each leader-election group is a `Lease` object, which underneath is just a leased key in etcd.

## The costs: fsync, latency, and "do not put big data in it"

Consensus is not free, and the price shows up in three places.

- **Every write pays a round trip plus a disk sync.** A commit waits for the slowest quorum member to `fsync` — a few hundred microseconds on a good SSD, an RTT across regions. More nodes worsens the tail, so five nodes measure slower than three. Keep etcd on a fast, dedicated disk.
- **No quorum means writes stall, not fail fast.** A minority node blocks, as the demo showed — correct, but your availability equals your quorum.
- **etcd is a control plane, not a data store.** The whole keyspace lives in memory, values are size-limited, and the default quota is small — it is built for small keys and a few hundred thousand of them. Put blobs in object storage and the *pointer* in etcd; big values bloat the Raft log and make snapshots painful.

## What I recommend

- **Run 3 nodes for almost everything; 5 only if you must survive two simultaneous failures** and accept the latency. Never 2.
- **Watch the quorum metrics:** leader changes (`etcd_server_leader_changes_seen_total`), whether a leader exists (`etcd_server_has_leader`), apply latency, and DB size versus quota. A cluster that is up but keeps losing its leader has a disk or network problem.
- **Use the right primitive:** leases for leader election and locks, watches for config and service discovery, transactions for compare-and-swap. Do not poll what you can watch.
- **Keep it small, boring, and on fast disks.**

The odd-numbers rule is just the majority rule seen from the side: quorum is what lets a group of machines tell the truth about an ordered log while some of them are dying. And it is the substrate under the systems you already trust — the [replication](/posts/postgres-replication/) you configure and the [queues](/posts/message-queues/) you pour events into both assume that someone already agreed on the order.
