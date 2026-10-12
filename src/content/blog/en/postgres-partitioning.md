---
title: "Postgres partitioning, reproduced: when it helps and when it's theater"
description: "A throwaway Postgres 16 container, a 3-million-row table and its declaratively partitioned twin: real EXPLAIN plans showing partition pruning, the index-per-partition reality, manual monthly partitions, ATTACH and DETACH, and why dropping a partition beats DELETE for retention."
pubDate: 2026-12-15
lang: en
translationKey: postgres-partitioning
tags: [devops, linux]
featured: false
keywords:
  - Postgres partitioning
  - declarative partitioning
  - partition pruning
  - table partitioning
  - DETACH
---

**Postgres partitioning** gets sold as a cure for big tables, and half the time it is theater: you slap on a partition key, your queries keep scanning everything, and you have invented a more complicated table. I wanted to know exactly where the line sits, so I spun up a throwaway Postgres 16 container, built a 3,000,000-row table and a **declaratively partitioned** twin holding the same bytes, and ran identical queries against both. Every plan, row count and timing below is pasted verbatim; if you want the vocabulary first, read [Reading EXPLAIN ANALYZE in Postgres](/posts/postgres-explain/), and for index theory see [Database indexing basics](/posts/database-indexing/). The short version: **declarative partitioning** pays for time-based retention and for queries that filter on the partition key, and it is pure overhead for everything else.

## What declarative partitioning actually does

A partitioned table is a virtual parent with **no storage of its own** — I measured `pg_total_relation_size('events')` at literally `0 bytes`. It owns a routing rule and a set of child tables. Three things happen at runtime:

- **Routing.** An `INSERT` is sent to the one partition whose key range matches. The parent never holds rows.
- **Partition pruning.** The planner examines the `WHERE` clause and drops every partition that cannot match, before the plan is built. This is the whole point.
- **Per-partition indexes.** `CREATE INDEX` on the parent cascades and builds a *separate physical index on every partition*. There is no single global index across a partitioned table.

The parent object is mostly a name, a partition strategy and a catalogue of children:

```sql
CREATE TABLE events (
  id bigserial,
  tenant_id int NOT NULL,
  kind text NOT NULL,
  amount numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL
) PARTITION BY RANGE (created_at);
```

That is the modern, PG10+ mechanism. It is *not* the old table-inheritance trick with `CHECK` constraints and trigger-based routing — declarative partitioning pushes routing and pruning into the executor, so there are no triggers to write and no `constraint_exclusion` to tune.

## RANGE, LIST, HASH in one minute

- **RANGE** — a contiguous span per partition, e.g. one calendar month per child. The natural fit for timestamps.
- **LIST** — an explicit set of values per partition, e.g. one partition per region or per tenant class.
- **HASH** — a modulo hash of the key spreads rows evenly across a fixed number of partitions, with no natural ordering. Good for sharding load, useless for retention.

I used RANGE because the interesting behaviour (pruning and dropping old data) lives there.

## The setup: one partitioned table, six monthly partitions

Creating monthly partitions by hand is three lines each — no `pg_partman` required:

```sql
CREATE TABLE events_2026_03 PARTITION OF events
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE events_2026_04 PARTITION OF events
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
-- ...one per month, 2026-01 through 2026-06
```

I loaded the *same* 3,000,000 generated rows into both tables and indexed both on `(tenant_id, created_at)` and `created_at`. On the partitioned parent, `CREATE INDEX ON events (tenant_id, created_at)` produced one index on the parent **plus six physical indexes** — one per partition:

```sql
SELECT tablename, indexname FROM pg_indexes
WHERE tablename LIKE 'events%' ORDER BY tablename, indexname;
```

```
   tablename    |                indexname
----------------+-----------------------------------------
 events         | idx_part_tenant_time
 events_2026_01 | events_2026_01_tenant_id_created_at_idx
 events_2026_02 | events_2026_02_tenant_id_created_at_idx
 events_2026_03 | events_2026_03_tenant_id_created_at_idx
 events_2026_04 | events_2026_04_tenant_id_created_at_idx
 events_2026_05 | events_2026_05_tenant_id_created_at_idx
 events_2026_06 | events_2026_06_tenant_id_created_at_idx
```

`\d+ events` shows the parent has six partitions and no rows of its own:

```
Partition key: RANGE (created_at)
Indexes:
    "idx_part_tenant_time" btree (tenant_id, created_at)
Partitions: events_2026_01 FOR VALUES FROM ('2026-01-01 ...') TO ('2026-02-01 ...'),
            events_2026_02 FOR VALUES FROM ('2026-02-01 ...') TO ('2026-03-01 ...'),
            events_2026_03 FOR VALUES FROM ('2026-03-01 ...') TO ('2026-04-01 ...'),
            events_2026_04 FOR VALUES FROM ('2026-04-01 ...') TO ('2026-05-01 ...'),
            events_2026_05 FOR VALUES FROM ('2026-05-01 ...') TO ('2026-06-01 ...'),
            events_2026_06 FOR VALUES FROM ('2026-06-01 ...') TO ('2026-07-01 ...')
```

<figure>
<svg viewBox="0 0 680 360" width="100%" role="img" aria-label="A partitioned parent table routes each row to one monthly RANGE partition. A query filtered to March is pruned to read only the March partition; the other five are never opened.">
  <g font-family="system-ui, sans-serif" fill="currentColor">
    <text x="340" y="24" text-anchor="middle" font-weight="600" font-size="14">One parent, six monthly partitions, one partition read</text>
  </g>
  <!-- parent -->
  <rect x="200" y="42" width="280" height="44" rx="7" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="340" y="62" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12">events</text>
  <text x="340" y="78" text-anchor="middle" font-size="10" opacity="0.8">PARTITION BY RANGE (created_at) · 0 bytes</text>
  <!-- bus -->
  <g stroke="currentColor" stroke-width="1.5" opacity="0.5" fill="none">
    <line x1="340" y1="86" x2="340" y2="118"/>
    <path d="M64 118 H604"/>
    <line x1="64" y1="118" x2="64" y2="150"/>
    <line x1="172" y1="118" x2="172" y2="150"/>
    <line x1="280" y1="118" x2="280" y2="150"/>
    <line x1="388" y1="118" x2="388" y2="150"/>
    <line x1="496" y1="118" x2="496" y2="150"/>
    <line x1="604" y1="118" x2="604" y2="150"/>
  </g>
  <!-- partitions (i = 0..5 at x = 16 + i*108, width 96) -->
  <g font-family="system-ui, sans-serif" font-size="11" text-anchor="middle">
    <rect x="16"  y="150" width="96" height="48" rx="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <text x="64"  y="172">2026-01</text><text x="64" y="188" font-size="9" opacity="0.75">513,810 rows</text>
    <rect x="124" y="150" width="96" height="48" rx="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <text x="172" y="172">2026-02</text><text x="172" y="188" font-size="9" opacity="0.75">464,090 rows</text>
    <rect x="232" y="150" width="96" height="48" rx="6" fill="none" stroke="#0f766e" stroke-width="2.2"/>
    <text x="280" y="172" font-weight="600">2026-03</text><text x="280" y="188" font-size="9" fill="#0f766e">513,812 rows</text>
    <rect x="340" y="150" width="96" height="48" rx="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <text x="388" y="172">2026-04</text><text x="388" y="188" font-size="9" opacity="0.75">497,238 rows</text>
    <rect x="448" y="150" width="96" height="48" rx="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <text x="496" y="172">2026-05</text><text x="496" y="188" font-size="9" opacity="0.75">513,812 rows</text>
    <rect x="556" y="150" width="96" height="48" rx="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <text x="604" y="172">2026-06</text><text x="604" y="188" font-size="9" opacity="0.75">497,238 rows</text>
  </g>
  <g font-size="10" fill="currentColor" opacity="0.85">
    <text x="280" y="222" text-anchor="middle" fill="#0f766e" font-family="ui-monospace, monospace">WHERE created_at &gt;= '2026-03-01' AND &lt; '2026-04-01'</text>
  </g>
  <g font-size="12" fill="currentColor">
    <text x="340" y="292" text-anchor="middle">Pruning removes the other five partitions during planning.</text>
    <text x="340" y="316" text-anchor="middle" opacity="0.8">They are never opened, never scanned, never read from disk.</text>
    <text x="340" y="340" text-anchor="middle" font-weight="600">273 ms vs 2165 ms on the unpartitioned twin.</text>
  </g>
</svg>
<figcaption>The parent stores nothing; rows live in the monthly children. A query bounded to March is pruned to a single partition, so five-sixths of the table is never touched.</figcaption>
</figure>

## Partition pruning, caught in a real plan

Same table, same 3M rows, one month's worth of data. Here is the partitioned query:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT kind, count(*), sum(amount)
FROM events
WHERE created_at >= '2026-03-01' AND created_at < '2026-04-01'
GROUP BY kind ORDER BY kind;
```

```
 Finalize GroupAggregate  (cost=9998.81..10000.14 rows=5 ...) (actual time=266.543..273.221 rows=5 loops=1)
   Buffers: shared hit=1521 read=2677
   ->  ...
         ->  Parallel Seq Scan on events_2026_03 events  (cost=0.00..7393.32 rows=214045 width=12)
               Filter: ((created_at >= '2026-03-01 00:00:00+00'::timestamptz) AND (created_at < '2026-04-01 00:00:00+00'::timestamptz))
               Buffers: shared hit=1505 read=2677
 Planning Time: 10.255 ms
 Execution Time: 273.373 ms
```

There is exactly one relation in the plan: `events_2026_03`. No `Append`, no other partition, no filtered-out work. `shared read=2677` is roughly one-sixth of the table's blocks. Now the identical query against the unpartitioned table with the same columns and an index on `created_at`:

```
 Finalize GroupAggregate  (cost=41329.14..41330.46 rows=5 ...) (actual time=2148.970..2164.542 rows=5 loops=1)
   Buffers: shared hit=16 read=25798 written=2524
   ->  ...
         ->  Parallel Bitmap Heap Scan on events_plain  (actual time=250.746..2010.668 rows=171271 loops=3)
               Recheck Cond: ((created_at >= '2026-03-01 ...') AND (created_at < '2026-04-01 ...'))
               Heap Blocks: exact=8692
               Buffers: shared read=25798 written=2524
               ->  Bitmap Index Scan on idx_plain_time  (actual time=242.595..242.595 rows=513812 loops=1)
 Planning Time: 2.873 ms
 Execution Time: 2164.724 ms
```

**273 ms versus 2165 ms** — an 8× gap, with the partitioned plan reading 2,677 blocks to the plain table's 25,798. Neither side is unindexed; the difference is that pruning lets Postgres avoid even *touching* five-sixths of the data, not merely seek past it. And pruning is decided at planning time, so a cheap `EXPLAIN` (no `ANALYZE`) shows it without running anything:

```
->  Parallel Seq Scan on events_2026_03 events  (cost=0.00..7393.32 rows=214045 width=6)
      Filter: ((created_at >= '2026-03-01 ...') AND (created_at < '2026-04-01 ...'))
```

### When the partition key can't prune

Pruning only works when the `WHERE` clause constrains the partition key. Filter on a tenant instead and every partition is fair game — the plan grows an `Append`, and its cost is the sum of its children:

```
 Aggregate  (cost=125.11..125.12 rows=1 width=8) (actual time=43.595..43.605 rows=1 loops=1)
   ->  Append  (cost=0.42..117.65 rows=2983 width=0) (actual time=4.745..42.893 rows=3000 loops=1)
         ->  Index Only Scan using events_2026_01_tenant_id_created_at_idx on events_2026_01 events_1 ...
         ->  Index Only Scan using events_2026_02_tenant_id_created_at_idx on events_2026_02 events_2 ...
         ->  Index Only Scan using events_2026_03_tenant_id_created_at_idx on events_2026_03 events_3 ...
         ->  Index Only Scan using events_2026_04_tenant_id_created_at_idx on events_2026_04 events_4 ...
         ->  Index Only Scan using events_2026_05_tenant_id_created_at_idx on events_2026_05 events_5 ...
         ->  Index Only Scan using events_2026_06_tenant_id_created_at_idx on events_2026_06 events_6 ...
```

One index lookup per partition, six plan branches, `Planning Time: 5.945 ms` for a query that returns 3,000 rows. That planning cost is the tax: on the earlier February query the partitioned table spent 10.3 ms planning versus 2.9 ms for the flat table, and the whole-range aggregate below cost 61.6 ms of planning alone.

## The index-per-partition reality

Because each partition has its own indexes, a query pruned to one partition uses only that partition's index. Filter on both the tenant and the month and the plan names a single physical index:

```
 Aggregate  (actual time=173.033..173.035 rows=1 loops=1)
   ->  Bitmap Heap Scan on events_2026_03 events  (actual time=0.376..172.380 rows=514 loops=1)
         Recheck Cond: ((tenant_id = 42) AND (created_at >= '2026-03-01 ...') AND (created_at < '2026-04-01 ...'))
         Heap Blocks: exact=514
         ->  Bitmap Index Scan on events_2026_03_tenant_id_created_at_idx
```

Only `events_2026_03_tenant_id_created_at_idx` appears. But this also means index count scales with partition count. Six monthly partitions gave me six copies of every parent index; a daily-partitioned table over a year gives you 365 small indexes to maintain, and every `CREATE INDEX` on the parent rebuilds all of them. A single 64 MB partition breaks down like this:

```
 event child              total   index
------------------------  -----   -----
 events_2026_03            64 MB   15 MB
 events_2026_04            62 MB   15 MB
 events_2026_05            64 MB   15 MB
```

For the whole 5-partition, 2.52M-row table the total was 312 MB; the unpartitioned twin — indexed identically, but after a `DELETE` — sat at 409 MB. Partitioning can even use *less* space, because dropping a partition releases its files instead of leaving dead pages behind.

## Table partitioning and retention: DETACH, DROP, or DELETE

This is where partitioning stops being optional. To delete the oldest month from the unpartitioned table:

```sql
DELETE FROM events_plain WHERE created_at < '2026-02-01';
VACUUM (ANALYZE) events_plain;
```

```
DELETE 513810
Time: 42889.701 ms (00:42.890)
VACUUM
Time: 20133.191 ms (00:20.133)
```

**63 seconds** to remove 513,810 rows — and the space is not returned to the OS; only `VACUUM FULL` or a rewrite reclaims it, and both take an exclusive lock. On the partitioned twin, retention is two catalogue operations:

```sql
ALTER TABLE events DETACH PARTITION events_2026_02;
DROP TABLE events_2026_02;
```

```
ALTER TABLE
Time: 4.782 ms
DROP TABLE
Time: 13.431 ms
```

**18 ms**, with no row-by-row work, no bloat, and instant disk reclaim. `DETACH` is a metadata change taking a brief `ACCESS EXCLUSIVE` lock on the parent; `DROP` unlinks the file. The detached table is a normal table, so you can archive it, dump it, or hand it to cold storage first. That asymmetry — 63 seconds of churn versus two fast DDL statements — is the strongest reason to partition a time-series table. It is also why the retention job should be a scheduled `DETACH`/`DROP`, guarded by a *pre-created* next-month partition so inserts never fail.

## ATTACH: promoting a standalone table

The reverse move lets you build a partition outside the parent and hook it in. I built a July table, filled 500,000 rows, indexed it, then attached it:

```sql
CREATE TABLE events_2026_07 (LIKE events INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
-- insert July rows, then:
CREATE INDEX events_2026_07_tenant_id_created_at_idx ON events_2026_07 (tenant_id, created_at);
ALTER TABLE events ATTACH PARTITION events_2026_07
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
```

```
INSERT 0 500000
Time: 4422.122 ms (00:04.422)
CREATE INDEX
Time: 929.148 ms
ALTER TABLE
Time: 101.178 ms
```

`ATTACH` took 101 ms because the index already existed and the table's constraints proved it only held July rows. Without that index, `ATTACH` builds it for you under the same lock — the safe pattern is to create the index on the standalone table *first*, then attach, so the lock is short. This is also how bulk backfills work: load and index off to the side, attach at the end.

### The unique-constraint limit

Partitioning quietly forbids something you may rely on. A plain unique index on the partition key's other columns is rejected:

```sql
CREATE UNIQUE INDEX events_id_uniq ON events (id);
```

```
ERROR:  unique constraint on partitioned table must include all partitioning columns
DETAIL:  UNIQUE constraint on table "events" lacks column "created_at" which is part of the partition key.
```

Postgres has no global unique index across partitions. You can enforce uniqueness only if the key *includes* the partition key — `UNIQUE (id, created_at)` — which usually is not the constraint you wanted. If you need a globally unique surrogate key, generate it elsewhere (a sequence, UUID v7, or a separate lookup table) rather than relying on the partitioned table to police it.

## When Postgres partitioning is theater

- **Small tables.** Pruning a 3 GB table that fits in cache saves nothing but adds planning nodes. Below a few hundred million rows, an index is usually the whole answer.
- **Queries that don't filter the partition key.** Every such query becomes an `Append` over N partitions, each with its own index and its own share of planning time.
- **Planning overhead on hot paths.** 10 ms of planning on a query executed thousands of times per second is real CPU you never budgeted.
- **Too many tiny partitions.** Daily partitions over a multi-year table mean hundreds of indexes, bloated catalogues and plans full of `Append` branches. Partition granularity should match retention granularity, not the calendar's.
- **ORM / tooling blind spots.** Many ORMs and migration tools do not model partitioned tables: they emit `INSERT ... RETURNING id` that ignores routing, expect a single physical table for `ALTER TABLE`, or generate a unique index the parent will reject. Check your data layer before committing.
- **Foreign keys and cross-partition joins.** They work, but each join fans out per partition and the planner's job gets harder.

## A decision list

1. Is the table large enough that dropping old data hurts? If retention is the pain, **partition by RANGE on the time column** and make retention a `DETACH`/`DROP` job.
2. Do your hottest queries bound the partition key? If yes, pruning will pay. If no, stop — partitioning will not speed them up.
3. Does anything need a globally unique constraint on a non-key column? If yes, solve uniqueness outside the table first.
4. Does your ORM understand partitioned tables? Verify before you migrate production.
5. Choose partition size to match retention: monthly is usually enough; daily only if you truly drop days.
6. Pre-create the next partition and keep a `DEFAULT` partition as a backstop so a missed range never drops an insert.

Nothing above needed a profiler or a managed service. A throwaway container, `generate_series`, and `EXPLAIN (ANALYZE, BUFFERS)` gave me the plans, the row counts and the milliseconds — and the plans, not the marketing, are what tell you whether **table partitioning** is doing work or just adding ceremony.
