---
title: "Postgres index types: B-tree, GIN, GiST, BRIN and hash, with real plans"
description: "A hands-on tour of Postgres index types on one 2M-row table: when B-tree, GIN, GiST, BRIN and hash indexes are the right tool, when they are a mistake, real EXPLAIN (ANALYZE, BUFFERS) plans, real index sizes, and how CREATE INDEX CONCURRENTLY, INCLUDE, partial and expression options fit in."
pubDate: 2026-12-24
lang: en
translationKey: postgres-index-types
tags: [devops, linux]
featured: false
keywords:
  - Postgres index types
  - GIN vs GiST
  - BRIN index
  - CREATE INDEX CONCURRENTLY
  - B-tree
---

**Postgres index types** are not interchangeable, and picking the wrong one costs you either speed or disk — sometimes both. Everyone learns `CREATE INDEX` on a B-tree and stops there. Then a `jsonb` containment query scans 500,000 rows, a huge time-series table carries a 40 GB B-tree nobody needs, and a `WHERE token = ?` lookup sits behind an index twice the size of the data it protects. This post is the practical map: what B-tree, GIN, GiST, BRIN and hash are each *for*, when the planner will choose them, when choosing them is a mistake, and how the sizes and speeds actually compare. Every plan and every size below is real — I built one 2,000,000-row `events` table in a throwaway Postgres 16 container and pasted the output verbatim. If you want the fundamentals first, read [Database indexing basics](/posts/database-indexing/); for reading the plans themselves, see [Reading EXPLAIN ANALYZE](/posts/postgres-explain/).

## The five index types, and what each one is for

The index type is chosen by *the operator in your `WHERE` clause*, not by the table. Equality and ordering want a B-tree; containment wants GIN; overlap wants GiST; enormous and physically ordered wants BRIN; equality-only at minimum size wants a hash.

<figure>
<svg viewBox="0 0 640 230" width="100%" role="img" aria-label="Decision diagram: pick a Postgres index type from the operator in the WHERE clause. B-tree is the default for equality, range and ORDER BY; GIN for containment with @> and tsquery; GiST for overlap with && on ranges and geometry; BRIN for huge tables whose column tracks insert order; hash for equality only.">
  <defs>
    <marker id="idx-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="200" y="8" width="240" height="34" rx="8"/>
    <path d="M320 42 L66 96"  marker-end="url(#idx-arrow)"/>
    <path d="M320 42 L190 96" marker-end="url(#idx-arrow)"/>
    <path d="M320 42 L314 96" marker-end="url(#idx-arrow)"/>
    <path d="M320 42 L438 96" marker-end="url(#idx-arrow)"/>
    <path d="M320 42 L562 96" marker-end="url(#idx-arrow)"/>
  </g>
  <rect x="8" y="96" width="116" height="120" rx="8" fill="none" stroke="#0f766e" stroke-width="1.8"/>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="132" y="96" width="116" height="120" rx="8"/>
    <rect x="256" y="96" width="116" height="120" rx="8"/>
    <rect x="380" y="96" width="116" height="120" rx="8"/>
    <rect x="504" y="96" width="116" height="120" rx="8"/>
  </g>
  <g font-family="system-ui, sans-serif" font-size="13">
    <text x="320" y="30" text-anchor="middle" fill="currentColor">What does the WHERE clause do?</text>
    <text x="66"  y="122" text-anchor="middle" fill="#0f766e" font-weight="600">B-tree</text>
    <text x="66"  y="142" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">default</text>
    <text x="66"  y="160" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">= &lt; &gt; BETWEEN</text>
    <text x="66"  y="178" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">ORDER BY</text>
    <text x="190" y="122" text-anchor="middle" fill="currentColor" font-weight="600">GIN</text>
    <text x="190" y="142" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">contains</text>
    <text x="190" y="160" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">@&gt;  ?  tsquery</text>
    <text x="190" y="178" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">jsonb, arrays</text>
    <text x="314" y="122" text-anchor="middle" fill="currentColor" font-weight="600">GiST</text>
    <text x="314" y="142" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">overlaps</text>
    <text x="314" y="160" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">&amp;&amp;  @&gt;</text>
    <text x="314" y="178" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">ranges, geo</text>
    <text x="438" y="122" text-anchor="middle" fill="currentColor" font-weight="600">BRIN</text>
    <text x="438" y="142" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">huge table</text>
    <text x="438" y="160" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">column tracks</text>
    <text x="438" y="178" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">insert order</text>
    <text x="562" y="122" text-anchor="middle" fill="currentColor" font-weight="600">hash</text>
    <text x="562" y="142" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">equality</text>
    <text x="562" y="160" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">only,</text>
    <text x="562" y="178" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">smallest</text>
  </g>
</svg>
<figcaption>Pick the index type from the operator, not the table. B-tree is the default; reach for the others only when the predicate is containment, overlap, or a huge insert-ordered scan.</figcaption>
</figure>

| Type | Best for | Operators it accelerates | Size here (2M rows) |
|---|---|---|---|
| **B-tree** | equality, range, `ORDER BY`, `IN` | `=`, `<`, `>`, `BETWEEN`, `LIKE 'x%'` | 14–43 MB |
| **GIN** | containment in `jsonb`, arrays, full-text | `@>`, `?`, `@@` (tsquery), `&&` on arrays | 4.8 MB / 154 MB |
| **GiST** | ranges, geometry, nearest-neighbour | `&&`, `@>`, `<@`, `=` on ranges | 79 MB |
| **BRIN** | huge tables, physically ordered column | `=`, `<`, `>`, `BETWEEN` (coarse) | **32 kB** |
| **hash** | equality only, minimum size | `=` | 64 MB |

## B-tree: the default, and usually the answer

A B-tree keeps its keys sorted, so it serves equality, range and sort from the same structure. The test table has a `user_id` column and a covering index on it:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, total, created_at FROM events WHERE user_id = 41234;
```

```
 Bitmap Heap Scan on events  (cost=4.74..162.35 rows=40) (actual time=0.750..1.005 rows=40 loops=1)
   Recheck Cond: (user_id = 41234)
   Heap Blocks: exact=40
   Buffers: shared read=43
   ->  Bitmap Index Scan on idx_events_user_incl  (cost=0.00..4.73 rows=40 width=0) (actual time=0.732..0.732 rows=40 loops=1)
         Index Cond: (user_id = 41234)
```

40 rows out of 2,000,000, found in 1 ms by reading 43 blocks. The same index handles ordering for free — no sort node appears:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, total FROM events WHERE total > 499.90 ORDER BY total DESC LIMIT 10;
```

```
 Limit  (cost=0.43..40.69 rows=10 width=14) (actual time=0.034..0.084 rows=10 loops=1)
   ->  Index Scan Backward using idx_events_total on events  (cost=0.43..1796.13 rows=446 width=14) (actual time=0.033..0.082 rows=10 loops=1)
         Index Cond: (total > 499.90)
         Buffers: shared hit=3 read=10
```

`Index Scan Backward` is the B-tree walking its keys in reverse — the `ORDER BY ... DESC LIMIT 10` never sorts, it just stops after ten. This is why B-tree is the default: it does equality, range, and sorting, and it can be made covering, partial, or an expression index.

## GIN: containment on `jsonb`, arrays and full text

GIN inverts your data: each key or array element points at the rows that contain it. That is exactly what `jsonb @>`, `?`, `tsquery @@` and array `@>` need. A selective containment on a jsonb key is where it shines:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, payload FROM events WHERE payload @> '{"order_ref": "ord_1999999"}';
```

```
 Bitmap Heap Scan on events  (cost=39.64..809.83 rows=200 width=124) (actual time=2.566..2.568 rows=1 loops=1)
   Recheck Cond: (payload @> '{"order_ref": "ord_1999999"}'::jsonb)
   Heap Blocks: exact=1
   Buffers: shared hit=4 read=8
   ->  Bitmap Index Scan on idx_events_payload_gin  (cost=0.00..39.59 rows=200 width=0) (actual time=2.538..2.539 rows=1 loops=1)
```

One row, 2.6 ms, 12 blocks. But GIN is a *mistake* the moment the predicate stops being selective. The same index on a common key is slower than not using it:

```sql
-- with the GIN index
SELECT count(*) FROM events WHERE payload @> '{"plan": "team"}'  -- 470 ms, 69,310 buffers
-- same predicate, index scans disabled: plain seq scan
SELECT count(*) FROM events WHERE payload @> '{"plan": "team"}'  -- 291 ms, ~69,000 buffers
```

The GIN plan spent 470 ms reading a 154 MB index plus the heap; the sequential scan did the same work in 291 ms by reading the heap once, in order. The planner's estimate (`rows=202020`, actually 500,000) was bad enough that it picked the slower plan. GIN pays off below roughly 1–2 % selectivity; above that, a sequential scan wins and the index is pure write overhead. A GIN index on an array column shows the same cliff — `tags @> ARRAY['violet','wholesale']` matched 6.7 % of rows and ran in 441 ms, while the seq scan took 293 ms. Build GIN for the selective queries, not because a column is a `jsonb`.

## GIN vs GiST: ranges, geometry, and overlap

**GIN vs GiST** is the question people get wrong most often. GIN is fast to read and slow to write; GiST is balanced and can also answer nearest-neighbour and overlap queries. For a range type, `&&` (overlap) and `@>` (contains) are GiST's home turf:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, price_range FROM events WHERE price_range @> 5000::numeric;
```

```
 Bitmap Heap Scan on events  (cost=298.22..28561.36 rows=10556 width=24) (actual time=12.978..16.991 rows=10000 loops=1)
   Recheck Cond: (price_range @> '5000'::numeric)
   ->  Bitmap Index Scan on idx_events_range_gist  (cost=0.00..295.58 rows=10556 width=0) (actual time=12.899..12.900 rows=10000 loops=1)
         Index Cond: (price_range @> '5000'::numeric)
```

10,000 rows in 17 ms. Rule of thumb: if the operator is containment (`@>`, `?`, `@@`), prefer GIN; if it is overlap or distance (`&&`, `<->`), prefer GiST. GIN does not support `&&` on ranges; GiST does not do full-text as well. Both are lossy enough that the plan almost always reads a bitmap of heap blocks and rechecks.

## BRIN index: huge tables that are already in order

A BRIN index stores, for each block range (128 pages by default), only the minimum and maximum value in it. On a column whose physical order matches its logical order, that summary is enough to skip almost everything — and the index is almost free. The `created_at` column here is perfectly correlated with insertion order:

```
 attname    | correlation
------------+-------------
 created_at |           1
 user_id    | 0.016
```

The B-tree and BRIN on that same column, same query, one day of data:

```
-- B-tree (43 MB)
 Index Only Scan using idx_events_created_bt on events  (actual time=0.069..13.550 rows=86400)
   Buffers: shared hit=1 read=239                     Execution Time: 19.011 ms

-- BRIN (32 kB)
 Bitmap Heap Scan on events  (actual time=0.810..33.208 rows=86400)
   ->  Bitmap Index Scan on idx_events_created_brin  (actual time=0.362..0.363 rows=30720)
         Buffers: shared hit=9
   Heap Blocks: lossy=3072                             Execution Time: 38.563 ms
```

The BRIN index is **32 kB against 43 MB — about 1,300× smaller** — and it read 9 index pages instead of 239. The B-tree still won on wall time because it was an *index-only* scan that never touched the heap. Ask for a column the B-tree does not carry and the heap dominates both:

```
-- B-tree: index scan + heap        Buffers: shared hit=2981 read=239   Execution Time: 47.469 ms
-- BRIN:   bitmap + heap            Buffers: shared hit=3081            Execution Time: 41.067 ms
```

Now BRIN is equal-or-faster and a thousand times smaller. That is the trade: BRIN is right for append-only tables — logs, metrics, events — queried by a time range, where the index must be tiny. It is a *mistake* on an uncorrelated column (`user_id`, correlation 0.016): every block range spans the whole value domain, so the planner correctly ignores it. Check `pg_stats.correlation` before you reach for BRIN; if it is near zero, use a B-tree.

## Hash indexes: equality only, at minimum size

A hash index stores only a 32-bit hash of each key, so it can answer `=` and nothing else — no ranges, no ordering, no index-only scans. Since Postgres 10 it is WAL-logged and crash-safe, so it is no longer a curiosity. On this table a hash index on the session token is 64 MB against the B-tree's 113 MB:

```sql
-- with the B-tree
SELECT id FROM events WHERE session_token = 'tok_' || md5('1999999');
 Index Scan using idx_events_session_bt on events  (actual time=1.059..1.062 rows=1)   Buffers: shared hit=1 read=4
-- with the hash index
 Index Scan using idx_events_session_hash on events (actual time=0.041..0.042 rows=1)  Buffers: shared hit=3
```

Same plan shape, same single row, half the disk. Choose hash only when the column is *only* ever compared with `=`, the table is large, and you want the smaller index. Otherwise a B-tree costs a little more space and gives you range queries for free.

## Sizes vs speed: what 2 million rows actually costs

One table, fifteen indexes, and the index bytes exceed the heap:

```
 heap  | all_indexes |  total
-------+-------------+---------
 539 MB | 735 MB      | 1274 MB

 idx_events_payload_gin   | gin   | 154 MB
 idx_events_session_bt    | btree | 113 MB
 idx_events_range_gist    | gist  |  79 MB
 idx_events_user_incl     | btree |  69 MB
 idx_events_session_hash  | hash  |  64 MB
 idx_events_created_bt    | btree |  43 MB
 idx_events_user          | btree |  14 MB
 idx_events_refunded      | btree |  11 MB   (partial: status = 'refunded')
 idx_events_tags_gin      | gin   | 4.8 MB
 idx_events_created_brin  | brin  |  32 kB
```

735 MB of indexes for a 539 MB heap. GIN and GiST are the expensive ones — they store many entries per row — and BRIN is effectively free. Every one of those bytes is also maintained on every `INSERT` and `UPDATE`.

## `CREATE INDEX CONCURRENTLY`, `INCLUDE`, partial and expression

A plain `CREATE INDEX` takes a lock that blocks writes to the table for the whole build. `CREATE INDEX CONCURRENTLY` does not — it takes a `ShareUpdateExclusiveLock`, which lets reads and writes continue. You can see it live: while a concurrent build ran on the 2M-row table, `pg_locks` showed only:

```
           mode           | granted | relname
--------------------------+---------+---------
 ShareUpdateExclusiveLock | t       | events
```

No `AccessExclusiveLock`, so inserts kept flowing. The cost is time — it scans the table twice and waits on transactions — and it cannot run inside a transaction block:

```
CREATE INDEX CONCURRENTLY idx_events_browser_con ON events ((payload ->> 'browser'));
CREATE INDEX
Time: 3389.759 ms
```

`INCLUDE` makes a B-tree covering: put the filter column in the key, the returned columns in the payload, and the plan becomes an index-only scan with no heap fetches:

```sql
CREATE INDEX idx_events_user_incl ON events (user_id) INCLUDE (status, total);
EXPLAIN (ANALYZE, BUFFERS) SELECT status, total FROM events WHERE user_id = 41234;
```

```
 Index Only Scan using idx_events_user_incl on events  (cost=0.43..5.13 rows=40 width=12) (actual time=0.042..0.055 rows=40 loops=1)
   Index Cond: (user_id = 41234)
   Heap Fetches: 0
```

**Partial** indexes index a slice — the queue that only polls `status = 'pending'`, or here just the refunded rows (11 MB instead of 43 MB):

```sql
CREATE INDEX idx_events_refunded ON events (created_at) WHERE status = 'refunded';
SELECT count(*) FROM events WHERE status = 'refunded' AND created_at >= '2024-01-14';
```

```
   ->  Parallel Index Only Scan using idx_events_refunded on events  (actual time=0.518..31.324 rows=73067 loops=3)
         Index Cond: (created_at >= '2024-01-14 00:00:00+00'::timestamp with time zone)
         Heap Fetches: 0                                    Execution Time: 47.855 ms
```

**Expression** indexes let you index a computed value — a `lower(email)`, a cast, or a `jsonb` extraction — and query it as an ordinary key:

```sql
CREATE INDEX idx_events_orderref_expr ON events ((payload ->> 'order_ref'));
EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM events WHERE (payload ->> 'order_ref') = 'ord_1999999';
```

```
 Index Scan using idx_events_orderref_expr on events  (cost=0.43..8.45 rows=1 width=8) (actual time=0.748..0.750 rows=1 loops=1)
   Index Cond: ((payload ->> 'order_ref'::text) = 'ord_1999999'::text)
```

The predicate has to match the index expression exactly, or the planner will not use it.

## How to check what the planner actually did

`EXPLAIN (ANALYZE, BUFFERS)` is the ground truth, and `pg_stat_user_indexes` tells you which indexes are dead weight:

```
       indexrelname       | idx_scan |  size
--------------------------+----------+---------
 idx_events_created_brin  |        3 | 32 kB
 idx_events_refunded      |        3 | 11 MB
 idx_events_payload_gin   |        2 | 154 MB
 idx_events_session_hash  |        0 | 64 MB
 idx_events_created_bt    |        0 | 43 MB
```

An index with `idx_scan = 0` and a size in the hundreds of MB is a candidate to drop — it is costing you writes for nothing. For machine-readable plans, `EXPLAIN (FORMAT JSON)` returns the same tree as JSON that a script can walk, and to find broken indexes after an interrupted build:

```sql
SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relkind = 'i' AND NOT i.indisvalid;
```

`CREATE INDEX CONCURRENTLY` can leave an invalid index behind if it fails partway; it is ignored by the planner and must be dropped and rebuilt.

## What to remember

The type follows the operator: B-tree for equality, range and sort; GIN for containment on `jsonb`, arrays and full-text; GiST for ranges and geometry overlap; BRIN for huge insert-ordered tables; hash for equality only. Size follows the type: BRIN is nearly free, GIN and GiST are expensive, and a table can easily carry more index bytes than data. The only way to know you chose right is to read the plan — build the index, run `EXPLAIN (ANALYZE, BUFFERS)`, and confirm the node and the buffers changed. That habit, plus `pg_stat_user_indexes` to retire the indexes nothing uses, is the whole job.
