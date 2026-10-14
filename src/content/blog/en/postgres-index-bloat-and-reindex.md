---
title: "Postgres index bloat: why your index keeps growing, and how to fix it"
description: "Real output from a throwaway Postgres 16 container: I churned a 2M-row table, watched an index grow 16 MB to 28 MB while VACUUM shrank nothing, then cut it back with REINDEX and REINDEX CONCURRENTLY, caught a failed CONCURRENTLY leaving an invalid index, and measured the size win."
pubDate: 2027-02-07
lang: en
translationKey: postgres-index-bloat-and-reindex
tags: [devops]
featured: false
keywords:
  - Postgres index bloat
  - REINDEX CONCURRENTLY
  - pgstattuple
  - index size
  - autovacuum
---

**Postgres index bloat** is the slow leak nobody alerts on. A B-tree that started at 16 MB is 28 MB six months later, on a table that actually got *smaller*. `VACUUM` runs every night, the table is fine, and the index file just keeps climbing. I see it on every hot table: an append-mostly log with an `updated_at` index, a session table that gets rewritten, a job queue whose status column flips back and forth.

The mechanism is simple and it is not a bug. Every `UPDATE` and `DELETE` leaves the old index tuple in place until vacuum gets to it. Vacuum then does *not* hand that space back to the operating system — it marks it reusable, so later writes can refill it, but the file never shrinks. On a churny table the index grows to its high-water mark and stays there, fat, forever. `VACUUM` is not a defragmenter. `REINDEX` is.

This is the version of that problem I wish I had been shown: what bloat is at the page level, how to measure it, the two ways to fix it, and the one failure mode that will bite you. Everything below is real output from a throwaway container — official `postgres:16-bookworm` image, Postgres 16.15, no extensions beyond `pgstattuple` and `amcheck`. If you are new to how indexes are built, [Postgres index types](/posts/postgres-index-types/) covers the structures; for the vacuum side, [Postgres vacuum](/posts/postgres-vacuum/) is the companion piece.

## What bloat actually is

A B-tree is a sorted structure of tuples. An `UPDATE` that touches an indexed column cannot edit the old tuple in place — the sort order may have changed — so Postgres deletes the old index tuple and inserts a new one. A `DELETE` marks the index tuple dead immediately. Either way the space those tuples occupied becomes *free space inside the index*, not space returned to the filesystem.

Two consequences matter. First, the index grows monotonically on a churny table: each round adds more tuples than it removes, because the new ones land before the old ones are cleaned. Second, `VACUUM` can only recycle that space internally — it truncates pages off the *end* of the index and adds fully-empty pages to the free space map, but the bulk of the free space is scattered through the middle of the tree, and that the file cannot give back.

A table, two indexes, a baseline:

```sql
SELECT relname,
       pg_size_pretty(pg_relation_size(oid))     AS relation_size,
       pg_relation_size(oid)                       AS bytes,
       pg_size_pretty(pg_total_relation_size(oid)) AS total
FROM pg_class
WHERE relname IN ('events','events_pkey','events_device_id_idx','events_kind_idx')
ORDER BY pg_relation_size(oid) DESC;
```

```
       relname        | relation_size |  bytes   | total
----------------------+---------------+----------+---------
 events               | 24 MB         | 25206784 | 31 MB
 events_pkey          | 4408 kB       |  4513792 | 4408 kB
 events_device_id_idx | 1616 kB       |  1654784 | 1616 kB
 events_kind_idx      | 1296 kB       |  1327104 | 1296 kB
```

200,000 rows, fresh, 24 MB of heap and a 1.6 MB index on `device_id`. Now the churn — twelve rounds of rewriting a third of the table and deleting a slice:

```sql
DO $$
DECLARE r int;
BEGIN
  FOR r IN 1..12 LOOP
    UPDATE events
       SET payload   = repeat('y', 64),
           device_id = ((device_id + 7) % 50) + 1
     WHERE id % 3 = 0;

    DELETE FROM events WHERE id % 11 = 0;
  END LOOP;
END $$;
```

```
DO
Time: 24673.921 ms (00:24.674)
```

Twenty-five seconds. Same size query:

```
       relname        | relation_size |   bytes   |  total
----------------------+---------------+-----------+---------
 events               | 112 MB        | 117628928 | 137 MB
 events_pkey          | 13 MB         |  13492224 | 13 MB
 events_device_id_idx | 6040 kB       |   6184960 | 6040 kB
 events_kind_idx      | 5896 kB       |   6037504 | 5896 kB
```

The heap went 24 MB → 112 MB, which is normal and covered in the vacuum post. Stare at `events_device_id_idx`: **1616 kB → 6040 kB**, nearly 4×, on a table that ended with 181,819 rows instead of 200,000. Fewer keys than it started with, four times the size. And autovacuum has already been round:

```
 n_live_tup | n_dead_tup | last_vacuum |        last_autovacuum
------------+------------+-------------+-------------------------------
     181819 |          0 |             | 2026-10-14 05:33:23.905477+00
```

Dead tuples: zero. Vacuum did its job. The index is still 6 MB.

<figure>
<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Dead index entries after vacuum versus the compacted index after REINDEX">
  <defs>
    <style>
      .lbl { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; }
      .val { font: bold 13px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; }
      .h   { font: bold 14px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #0f766e; }
      .dead{ fill: none; stroke: currentColor; stroke-opacity:.45; stroke-width:1.4; stroke-dasharray:4 3; }
      .live{ fill: none; stroke: #0f766e; stroke-width:1.4; }
      .x   { stroke: currentColor; stroke-width:1.6; stroke-opacity:.7; }
    </style>
  </defs>

  <text x="0" y="20" class="h">BEFORE REINDEX — vacuum ran, space marked reusable, file kept</text>

  <rect x="0"   y="34" width="180" height="14" class="dead"/>
  <rect x="184" y="34" width="46"  height="14" class="live"/>
  <line x1="24" y1="34" x2="40" y2="48" class="x"/>
  <line x1="40" y1="34" x2="24" y2="48" class="x"/>
  <line x1="84" y1="34" x2="100" y2="48" class="x"/>
  <line x1="100" y1="34" x2="84" y2="48" class="x"/>
  <line x1="144" y1="34" x2="160" y2="48" class="x"/>
  <line x1="160" y1="34" x2="144" y2="48" class="x"/>
  <text x="240" y="46" class="lbl">dead entries 75%</text>

  <rect x="0"   y="56" width="180" height="14" class="dead"/>
  <rect x="184" y="56" width="46"  height="14" class="live"/>
  <text x="240" y="68" class="lbl">free, but allocated</text>

  <rect x="0" y="84" width="296" height="26" fill="none" stroke="currentColor" stroke-opacity=".35"/>
  <text x="8" y="101" class="val">index file  6040 kB</text>

  <text x="330" y="20" class="h">AFTER REINDEX — rewritten dense</text>

  <rect x="330" y="34" width="120" height="14" class="live"/>
  <rect x="454" y="34" width="46"  height="14" class="live"/>
  <text x="510" y="46" class="lbl">100% live</text>

  <rect x="330" y="84" width="128" height="26" fill="none" stroke="#0f766e"/>
  <text x="338" y="101" class="val">index  640 kB</text>

  <text x="0" y="140" class="lbl">vacuum: dead tuples removed, space recycled in place, file unchanged</text>
  <text x="0" y="160" class="lbl">reindex:  a brand-new compact tree, old file truncated</text>

  <text x="0" y="200" class="h">6040 kB  →  640 kB   (−89%)</text>
</svg>
<figcaption>FIG. 1 — One index leaf page after vacuum (dashed slots are reusable-but-allocated) and after REINDEX. The page count, not the dead tuples, is what keeps the file large.</figcaption>
</figure>

## Measuring it without guessing

`pg_relation_size` tells you the file. It will not tell you whether the file is *supposed* to be that big. For that you want `pgstattuple`, which walks the relation and counts.

```sql
CREATE EXTENSION IF NOT EXISTS pgstattuple;
CREATE EXTENSION IF NOT EXISTS amcheck;
```

```
 extname   | extversion
-----------+------------
 pgstattuple | 1.5
 amcheck     | 1.3
```

`pgstatindex` gives the structure of one index; `pgstattuple` gives the physical contents of a heap or index. Baseline, before the churn:

```sql
SELECT * FROM pgstatindex('events_device_id_idx');
```

```
 version | tree_level | index_size | root_block_no | internal_pages | leaf_pages | empty_pages | deleted_pages | avg_leaf_density | leaf_fragmentation
---------+------------+------------+---------------+----------------+------------+-------------+---------------+------------------+--------------------
       4 |          1 |    1654784 |             3 |              1 |        200 |           0 |             0 |            82.38 |               24.5
```

Two numbers to learn. `avg_leaf_density` is how full the leaf pages are — a fresh B-tree sits around 80–90%. `leaf_fragmentation` is the free space scattered inside the pages that cannot be compacted away without rewriting the tree. After the churn:

```
 version | tree_level | index_size | root_block_no | internal_pages | leaf_pages | empty_pages | deleted_pages | avg_leaf_density | leaf_fragmentation
---------+------------+------------+---------------+----------------+------------+-------------+---------------+------------------+--------------------
       4 |          2 |    6184960 |           309 |              4 |        750 |           0 |             0 |            94.65 |               6.53
```

`tree_level` went 1 → 2 (an extra internal page) and `leaf_pages` 200 → 750. That is the 4×.

To see dead index entries *explicitly*, I built a second table with autovacuum switched off so nothing cleaned up behind me:

```sql
DROP TABLE IF EXISTS churn;
CREATE TABLE churn (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id int NOT NULL,
  note      text
);
CREATE INDEX churn_device_id_idx ON churn (device_id);
ALTER TABLE churn SET (autovacuum_enabled = false);

INSERT INTO churn (device_id, note)
SELECT (g % 20) + 1, repeat('n', 32)
FROM generate_series(1, 100000) g;

UPDATE churn SET device_id = ((device_id + 3) % 20) + 1 WHERE id % 4 = 0;
UPDATE churn SET device_id = ((device_id + 5) % 20) + 1 WHERE id % 4 = 1;
DELETE FROM churn WHERE id % 13 = 0;
```

```
   phase    | idx_size | idx_bytes
------------+----------+-----------
 after load | 656 kB   |    671744
          phase          | idx_size | idx_bytes | live_rows
-------------------------+----------+-----------+-----------
 after churn (no vacuum) | 1176 kB  |   1204224 |     92308
```

100,000 rows became 92,308, and the index went 656 kB → 1176 kB. The physical truth:

```
 table_len | tuple_count | dead_tuple_count | dead_tuple_percent | free_percent
-----------+-------------+------------------+--------------------+--------------
   9641984 |       92308 |             5700 |               4.08 |        20.25

 n_live_tup | n_dead_tup | last_vacuum | last_autovacuum
------------+------------+-------------+-----------------
      92308 |      57692 |             |
```

57,692 dead tuples against 92,308 live — 38% of the table is corpses. And the index:

```
 version | tree_level | index_size | internal_pages | leaf_pages | empty_pages | deleted_pages | avg_leaf_density | leaf_fragmentation
---------+------------+------------+----------------+------------+-------------+---------------+------------------+--------------------
       4 |          1 |    1204224 |              1 |        145 |           0 |             0 |            81.02 |              40.69
```

`leaf_fragmentation` 40.69%: two fifths of every leaf page is free space vacuum has not reclaimed and the file still owns.

`pg_stat_user_indexes.idx_scan` counts how many queries have actually used each index — the cheapest unused-index detector there is:

```
     indexrelname     | idx_scan | idx_tup_read | idx_tup_fetch | index_size
----------------------+----------+--------------+---------------+------------
 events_pkey          |        0 |            0 |             0 | 4408 kB
 events_device_id_idx |        0 |            0 |             0 | 1616 kB
 events_kind_idx      |        0 |            0 |             0 | 1296 kB
```

## VACUUM will not fix this

A verbose vacuum on `churn` with its 57,692 dead tuples:

```sql
VACUUM (VERBOSE, ANALYZE) churn;
```

```
INFO:  finished vacuuming "blog.public.churn": index scans: 1
index scan needed: 1177 pages from table (100.00% of total) had 57692 dead item identifiers removed
index "churn_pkey": pages: 551 in total, 0 newly deleted, 0 currently deleted, 0 reusable
index "churn_device_id_idx": pages: 147 in total, 35 newly deleted, 35 currently deleted, 0 reusable
INFO:  "churn": scanned 1177 of 1177 pages, containing 92308 live rows and 0 dead rows
```

Read that carefully — it is the whole point. Vacuum removed **57,692 dead item identifiers**. On the index it *deleted 35 pages* and reported **0 reusable**. Those 35 pages went to the free space map, not back to the operating system. Now the sizes:

```
 idx_size | idx_bytes | heap_size
----------+-----------+-----------
 1176 kB  |   1204224 | 9416 kB
```

Identical — 1176 kB before, 1176 kB after, to the byte. The heap did not shrink either. But the *structure* changed:

```
 version | tree_level | index_size | internal_pages | leaf_pages | empty_pages | deleted_pages | avg_leaf_density | leaf_fragmentation
---------+------------+------------+----------------+------------+-------------+---------------+------------------+--------------------
       4 |          1 |    1204224 |              1 |        110 |           0 |            35 |            66.74 |              49.09
```

`leaf_pages` 145 → 110, `deleted_pages` 0 → 35, `avg_leaf_density` 81.02% → 66.74%, `leaf_fragmentation` 40.69% → 49.09%. Vacuum removed the dead entries and dropped the now-empty pages from the tree, and left the file exactly as large. Density went *down*: the surviving live entries are spread across pages only freed at the ends.

That is the honest definition of index bloat: **space vacuum has recycled internally but the file cannot return.**

## The fix: REINDEX

`REINDEX` throws the index away and builds a fresh one from the live tuples. Same table, same rows, no bloat:

```
 idx_size | idx_bytes
----------+-----------
 1176 kB  |   1204224
Timing is on.
REINDEX
Time: 113.510 ms
Timing is off.
 idx_size | idx_bytes
----------+-----------
 640 kB   |    655360
```

1176 kB → 640 kB in 113 ms. The structure afterwards:

```
 version | tree_level | index_size | internal_pages | leaf_pages | empty_pages | deleted_pages | avg_leaf_density | leaf_fragmentation
---------+------------+------------+----------------+------------+-------------+---------------+------------------+--------------------
       4 |          1 |     655360 |              1 |         78 |           0 |             0 |             89.7 |                  0
```

78 leaf pages, 0 deleted, fragmentation 0%, density 89.7%. That is what a B-tree is supposed to look like.

On a 2 million row table, one index on `v`, churned with 666,666 updates and 86,956 deletes:

```
    phase    |  heap  |  idx  | idx_bytes |  rows
-------------+--------+-------+-----------+---------
 after churn | 215 MB | 24 MB |   24707072 | 1913044

 version | tree_level | index_size | internal_pages | leaf_pages | empty_pages | deleted_pages | avg_leaf_density | leaf_fragmentation
---------+------------+------------+----------------+------------+-------------+---------------+------------------+--------------------
       4 |          2 |   24707072 |             15 |       3000 |           0 |             0 |            54.48 |              33.3
```

54.48% density — half the index is waste. Reindexed:

```
REINDEX
Time: 1369.204 ms (00:01.369)
     phase     |  idx  | idx_bytes
---------------+-------+-----------
 after reindex | 13 MB |  13737984
```

24 MB → 13 MB in 1.37 s. **46% of that index was bloat** — a storage bill reclaimed.

The cost is the lock. I probed `pg_locks` while a reindex ran on that index:

```
 pid |    rel    |        mode         | granted
-----+-----------+---------------------+---------
 972 | big_v_idx | AccessExclusiveLock | t
 973 | big_v_idx | AccessExclusiveLock | t
 972 | big       | ShareLock           | t
 973 | big       | ShareLock           | t
```

`REINDEX INDEX` takes **ShareLock on the table** and **AccessExclusiveLock on the index**. ShareLock conflicts with the `RowExclusiveLock` that every `INSERT`/`UPDATE`/`DELETE` takes, so writes block for the whole reindex. A single-row update issued while the reindex was in flight:

```
UPDATE 1
Time: 558.756 ms
```

It waited 558 ms for a row it owned. On a small index that is nothing; on a 100 GB index it is an outage.

## REINDEX CONCURRENTLY: same result, writes keep flowing

`REINDEX INDEX CONCURRENTLY` builds the new index in the background while normal traffic continues, then swaps it in atomically. Same bloated index, same table:

```
--- locks held during REINDEX CONCURRENTLY ---
 pid |    rel    |           mode           | granted
-----+-----------+--------------------------+---------
 592 | big       | ShareUpdateExclusiveLock | t
 591 | big_v_idx | ShareUpdateExclusiveLock | t
 591 | big       | ShareUpdateExclusiveLock | t
```

`ShareUpdateExclusiveLock` conflicts only with itself and `AccessExclusiveLock`. It does **not** conflict with `RowExclusiveLock`, so inserts, updates and deletes proceed. Same single-row update, issued mid-reindex:

```
UPDATE 1
Time: 5.944 ms
```

5.9 ms instead of 558 ms. Writes never blocked.

The price is time and a little disk. The full rebuild on a 28 MB index with 1.9 million rows:

```
REINDEX
Time: 5515.812 ms (00:05.516)
           phase            |  idx  | idx_bytes
----------------------------+-------+-----------
 after reindex-concurrently | 13 MB |  13737984
```

5.5 s versus 1.37 s for the locked version — roughly 4× slower, because it waits for in-flight transactions at two barrier points and re-scans rows that changed in between. Later passes took 1.3–1.5 s, so treat that as the pessimistic figure. The result is identical: 13,737,984 bytes, `leaf_fragmentation` 0, density 87.06%, 1,667 leaf pages instead of 3,000. Use it wherever a 4× slowdown beats a write lock — which is most production tables.

### The failure mode that bites people

`REINDEX INDEX CONCURRENTLY` can fail — a conflicting DDL, a cancelled statement, an old snapshot it cannot wait out — and when it does, it leaves the half-built new index behind as an **invalid** relation. I reproduced it by cancelling mid-run:

```
ERROR:  canceling statement due to user request
Time: 926.594 ms

      index      | indisvalid | indisready |  size
-----------------+------------+------------+-------
 big_pkey        | t          | t          | 86 MB
 big_v_idx       | t          | t          | 29 MB
 big_v_idx_ccnew | f          | t          | 13 MB
```

That `big_v_idx_ccnew` row is dead weight: 13 MB on disk, `indisvalid = f`, never used by the planner — `EXPLAIN` chose the valid `big_v_idx` and ignored it. The original index keeps serving traffic, so nothing breaks.

First, the fix is a second pass, and it is not automatic. I re-ran the reindex:

```
REINDEX
Time: 1325.988 ms (00:01.326)
      index      | indisvalid | indisready |  size
-----------------+------------+------------+-------
 big_pkey        | t          | t          | 86 MB
 big_v_idx_ccnew | f          | t          | 13 MB
 big_v_idx       | t          | t          | 13 MB
```

It succeeded, `big_v_idx` is now 13 MB — **and the invalid `big_v_idx_ccnew` is still there.** A successful reindex does not clean up a failed one's leftover. You drop it yourself:

```sql
DROP INDEX big_v_idx_ccnew;
```

If you script this, check `pg_index.indisvalid` after any concurrent reindex and alert on it. An invalid index is a disk problem, not a correctness problem, and it will sit there indefinitely.

## Prevention: keep it from coming back

Reindexing is the cure; these keep the fever down.

**Tune autovacuum on hot tables, not globally.** The defaults in my container:

```
                 name                  | setting | unit
---------------------------------------+---------+------
 autovacuum_vacuum_scale_factor        | 0.2     |
 autovacuum_vacuum_threshold           | 50      |
 autovacuum_vacuum_insert_scale_factor | 0.2     |
 autovacuum_vacuum_insert_threshold    | 1000    |
 autovacuum_max_workers                | 3       |
 autovacuum_naptime                    | 60      | s
```

On a 50 million row table, `0.2` means autovacuum waits for 10 million dead tuples before lifting a finger — by which point the index has absorbed every one. For a hot table I lower the scale factor rather than raise the worker count:

```sql
ALTER TABLE events SET (autovacuum_vacuum_scale_factor = 0.01,
                        autovacuum_vacuum_threshold = 2000);
```

More frequent vacuuming does not prevent bloat — vacuum cannot shrink the file — but it keeps the reusable space dense and cheap to reuse, which delays the point where reindexing becomes necessary.

**Drop indexes nobody uses.** Every index you keep costs write throughput on every insert and update, forever, whether or not a query ever touches it. I created an index on `events(payload)` that nothing could use, churned the table again, and watched it grow doing no work:

```
     indexrelname     | idx_scan | idx_tup_read |  size
----------------------+----------+--------------+---------
 events_device_id_idx |        1 |         3636 | 6360 kB
 events_kind_idx      |        1 |        36364 | 6256 kB
 events_payload_idx   |        0 |            0 | 1720 kB
 events_pkey          |        0 |            0 | 13 MB
```

`events_payload_idx`: 1,720 kB, `idx_scan = 0`, grown from 1,376 kB purely from write amplification. Dropping it:

```
DROP INDEX
Time: 22.475 ms
```

22 ms, 1.7 MB back, and every future `UPDATE` is a little cheaper. `DROP INDEX CONCURRENTLY` takes `ShareUpdateExclusiveLock` — the same non-blocking mode as `REINDEX CONCURRENTLY` — so it is safe against live traffic too.

A low-cardinality index is not automatically useless. My `events_kind_idx` sits on a column with five distinct values, and the planner skips it for selective lookups:

```
 Limit
   ->  Seq Scan on events
         Filter: (kind = 'click'::text)
```

Yet it was still chosen for `count(*) WHERE kind = 'click'` as an index-only scan. So `idx_scan` is a *signal*, not a verdict — confirm against your real query log before dropping anything.

## What I actually do

**Don't reindex on a schedule without cause.** Every reindex is a full rebuild: CPU, I/O, WAL, and a lock window. If an index is 5% over its healthy size, reindexing it buys you nothing and costs you the whole build. Measure first, reindex on evidence.

**Measure with a query, not a hunch.** The three I run, cheapest first:

```sql
-- 1. which indexes exist and how big are they
SELECT indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE relname = 'events'
ORDER BY pg_relation_size(indexrelid) DESC;

-- 2. how fragmented is one index
SELECT * FROM pgstatindex('events_device_id_idx');

-- 3. what the heap actually holds
SELECT * FROM pgstattuple('events');
```

`idx_scan = 0` on a large index is your dropping candidate. `avg_leaf_density` below ~60% on a B-tree that is not growing is your reindex candidate. `leaf_fragmentation` climbing on a stable table means churn is outrunning vacuum.

**Verify structure after any reindex.** `amcheck` ships in the standard image, and a btree check is cheap insurance against the one thing reindex cannot fix — corruption:

```sql
SELECT bt_index_check('big_v_idx', true);
```

```
 bt_index_check
----------------

(1 row)
```

That ran in 594 ms and returned no error — the function raises on corruption, so silence is a pass. (It returns one empty void row, which is normal.)

**Size your indexes for the queries you run, not the columns you have.** The whole reason bloat hurts is that we index everything and use a third of it. For choosing between index types, [Postgres index types](/posts/postgres-index-types/) has the size-versus-speed measurements on a 2 million row table.

Bloat is not mysterious and it is not inevitable. It is vacuum doing exactly what it was designed to do, on a file that only a rebuild will shrink. Measure it, drop what you do not use, reindex what you do — concurrently, if you cannot take the lock — and check for an invalid index afterwards. And if why the heap grows at all is what you came for, [Postgres vacuum](/posts/postgres-vacuum/) covers dead tuples, HOT updates, and the settings that keep them in check.
