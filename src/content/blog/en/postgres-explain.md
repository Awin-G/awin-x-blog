---
title: "Reading EXPLAIN ANALYZE in Postgres: real query plans, real numbers"
description: "EXPLAIN, EXPLAIN ANALYZE and BUFFERS explained with real plans from a 1.5M-row table: how to read a Postgres query plan bottom-up, estimates vs actual rows, stale statistics, seq scan vs index scan, nested loop vs hash join, index-only scans, and a repeatable method for finding the slow query."
pubDate: 2026-12-07
lang: en
translationKey: postgres-explain
tags: [devops, linux]
featured: false
keywords:
  - EXPLAIN ANALYZE
  - Postgres query plan
  - seq scan vs index scan
  - query planner
  - BUFFERS
---

**EXPLAIN ANALYZE** is how you stop guessing about a slow query. `EXPLAIN` prints the **Postgres query plan** the planner intends to run; `EXPLAIN ANALYZE` runs the query and shows what actually happened, node by node — real rows, real milliseconds, real buffer counts. Everything below comes from a throwaway Postgres 16 container holding a 1.5M-row `orders` table, and every plan is pasted verbatim. If you want the index theory first, read [Database indexing basics](/posts/database-indexing/); this piece is about reading the numbers the **query planner** hands back.

## EXPLAIN vs EXPLAIN ANALYZE vs BUFFERS

`EXPLAIN` runs the planner but not the query, so it only knows estimates. For a single-customer lookup on an unindexed column it printed:

```sql
EXPLAIN
SELECT id, customer_id, total, created_at
FROM orders
WHERE customer_id = 41234;
```

```
 Bitmap Heap Scan on orders  (cost=4.66..121.57 rows=30 width=26)
   Recheck Cond: (customer_id = 41234)
   ->  Bitmap Index Scan on idx_orders_customer  (cost=0.00..4.65 rows=30 width=0)
         Index Cond: (customer_id = 41234)
```

Two numbers matter in every node: `cost=startup..total` (in arbitrary cost units) and `rows=N` (the *estimate*). `EXPLAIN ANALYZE` actually executes the query and adds `actual time=startup..total rows=N loops=N`. Add `BUFFERS` and each node also reports the 8 kB blocks it touched: `shared hit` came from cache, `shared read` came from disk, `written` were dirtied.

One warning: `ANALYZE` executes the query for real. On an `INSERT`/`UPDATE`/`DELETE` that means side effects. Wrap it in a transaction you can `ROLLBACK`, or run it on a copy.

## Read a Postgres query plan bottom-up

The plan is a tree. The most-indented nodes run first, and each one feeds rows to its parent. Read from the leaves up to the top, and treat `loops=N` as a multiplier: a node showing `actual rows=7 loops=3` actually produced 21 rows.

<figure>
<svg viewBox="0 0 660 340" width="100%" role="img" aria-label="A Postgres plan is a tree read bottom-up. Leaf scan nodes run first and feed rows upward; each parent consumes the rows of its children. The node with the largest rows times cost is the one to inspect first.">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <text x="330" y="24" text-anchor="middle" font-weight="600" font-size="14">A plan is a tree — read it bottom-up</text>
  </g>
  <!-- edges -->
  <g stroke="currentColor" stroke-width="1.5" opacity="0.5" fill="none">
    <line x1="330" y1="76" x2="330" y2="104"/>
    <line x1="330" y1="136" x2="140" y2="176"/>
    <line x1="330" y1="136" x2="520" y2="176"/>
  </g>
  <!-- root -->
  <rect x="240" y="44" width="180" height="32" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="330" y="64" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12">HashAggregate</text>
  <!-- middle -->
  <rect x="240" y="104" width="180" height="32" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="330" y="124" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12">Hash Join</text>
  <!-- leaves -->
  <rect x="40" y="176" width="200" height="32" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="140" y="196" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12">Seq Scan on orders</text>
  <rect x="420" y="176" width="200" height="32" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="520" y="196" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12">Hash → Seq Scan customers</text>
  <!-- annotations -->
  <g font-family="system-ui, sans-serif" font-size="12" fill="currentColor" opacity="0.8">
    <text x="330" y="240" text-anchor="middle">↑ rows flow up: a parent consumes a child's rows</text>
    <text x="140" y="266" text-anchor="middle">leaves run first</text>
    <text x="520" y="266" text-anchor="middle">the build side of the hash</text>
    <text x="330" y="300" text-anchor="middle" font-weight="600">The node with the largest rows × cost is the one to investigate.</text>
  </g>
</svg>
<figcaption>A plan is a tree: leaf scans run first and push rows up to their parent. Spend your attention on the node that processes the most rows for the most time, not on the top line.</figcaption>
</figure>

## Estimates vs actual rows: where the query planner lies

The single most useful comparison is `rows=` against `actual rows=`. When they are close, the planner chose a sane path. When the estimate is off by orders of magnitude, every decision above it is built on a false premise — usually bad statistics. Here is a fresh table holding 500 rows, one `ANALYZE`, then a 500,000-row bulk load without re-analyzing:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM signups WHERE plan = 'pro';
```

```
 Gather  (cost=1000.00..6263.62 rows=1 width=17) (actual time=0.411..75.434 rows=500000 loops=1)
   ->  Parallel Seq Scan on signups  (cost=0.00..5263.52 rows=1 width=17) (actual time=0.058..40.527 rows=166667 loops=3)
         Filter: (plan = 'pro'::text)
```

The planner predicted **1 row**. It got **500,000**. The query still returns correct results, but the plan was chosen for a world that no longer exists. After `ANALYZE signups;` the same query estimates `rows=500050` and the estimate matches reality. That mismatch — not raw slowness — is what turns a good plan into a nested loop doing 500,000 index lookups.

## Node types worth knowing

You do not need all sixty-odd plan nodes. These cover most real plans:

- **Seq Scan** — reads every block of a table. Cheap per row, expensive per table.
- **Index Scan** — walks a B-tree, then fetches rows from the heap, one pointer at a time.
- **Bitmap Index/Heap Scan** — collects matching row locations in a bitmap, sorts them by physical location, then fetches the heap in order. Good for a moderate number of rows.
- **Nested Loop** — for each outer row, run the inner side. Excellent when the outer side is tiny and the inner side is indexed.
- **Hash Join** — build a hash table from the smaller side, probe it with the larger. The default for joining big sets.
- **Sort** — often fed by `ORDER BY` or a merge; watch for `Sort Method: external merge` (it spilled to disk).
- **Aggregate** — `count`, `sum`, `GROUP BY`. `Partial`/`Finalize` means the work was split across parallel workers.

### seq scan vs index scan

Same query, two states. Before any index on `customer_id`, the planner had no choice:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, customer_id, total, created_at FROM orders WHERE customer_id = 41234;
```

```
 Gather  (cost=1000.00..29037.50 rows=30 width=26) (actual time=4.127..73.843 rows=20 loops=1)
   ->  Parallel Seq Scan on orders  (cost=0.00..28034.50 rows=12 width=26) (actual time=7.355..63.968 rows=7 loops=3)
         Filter: (customer_id = 41234)
         Rows Removed by Filter: 499993
         Buffers: shared hit=13837 read=6385
```

`Rows Removed by Filter: 499993` is the tell: it read the whole table to find 20 rows. After `CREATE INDEX idx_orders_customer ON orders (customer_id);` the same query becomes:

```
 Bitmap Heap Scan on orders  (cost=4.66..121.57 rows=30 width=26) (actual time=0.057..0.110 rows=20 loops=1)
   ->  Bitmap Index Scan on idx_orders_customer  (cost=0.00..4.65 rows=30 width=0) (actual time=0.042..0.042 rows=20 loops=1)
```

73 ms became 0.2 ms, and `Buffers: shared hit=13837 read=6385` collapsed to a couple of index pages. When the predicate is a single key, Postgres switches to a plain `Index Scan`:

```
 Index Scan using orders_pkey on orders  (cost=0.43..8.45 rows=1 width=23) (actual time=0.070..0.071 rows=1 loops=1)
   Index Cond: (id = 900000)
   Buffers: shared hit=5 read=2
```

And for a moderately selective value — `status = 'refunded'`, about 2% of 1.5M rows — it prefers a bitmap so it can fetch the heap in physical order:

```
 Bitmap Heap Scan on orders  (cost=335.76..21924.12 rows=29850 width=18) (actual time=6.625..82.905 rows=30242 loops=1)
   Heap Blocks: exact=15744
   ->  Bitmap Index Scan on idx_orders_status  (cost=0.00..328.30 rows=29850 width=0) (actual time=3.998..3.999 rows=30242 loops=1)
```

### nested loop vs hash join

Join size picks the algorithm. Look up one customer and the planner loops:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT c.name, o.id, o.total
FROM orders o JOIN customers c ON c.id = o.customer_id
WHERE o.customer_id = 41234;
```

```
 Nested Loop  (cost=4.95..130.18 rows=30 width=24) (actual time=0.121..0.319 rows=20 loops=1)
   ->  Index Scan using customers_pkey on customers c  (cost=0.29..8.31 rows=1 width=14) (actual time=0.047..0.048 rows=1 loops=1)
   ->  Bitmap Heap Scan on orders o  (cost=4.66..121.57 rows=30 width=18) (actual time=0.068..0.259 rows=20 loops=1)
```

Join the whole table and it reclaims the cost by hashing instead:

```
 Hash Join  (cost=1492.00..29604.77 rows=625000 width=9) (actual time=20.521..289.723 rows=500000 loops=3)
   Hash Cond: (o.customer_id = c.id)
   ->  Parallel Seq Scan on orders o  (cost=0.00..26472.00 rows=625000 width=10) (actual time=0.024..65.910 rows=500000 loops=3)
   ->  Hash  (cost=867.00..867.00 rows=50000 width=7) (actual time=20.124..20.124 rows=50000 loops=3)
         ->  Seq Scan on customers c  (cost=0.00..867.00 rows=50000 width=7) (actual time=0.019..7.830 rows=50000 loops=3)
```

A nested loop here would be 1.5M indexed probes; a hash join reads each side once. That is the whole reason the planner cares so much about the row estimate from the previous section.

## Stale statistics and `ANALYZE`

The planner's `rows=` estimates come from statistics that autovacuum refreshes after roughly 10% of a table changes. After a bulk load, autovacuum has not run yet, so `reltuples` still says 500 while the table holds 500,500 rows. That is exactly the mismatch above. The fix is mundane:

```sql
ANALYZE orders;          -- refresh planner statistics for one table
VACUUM (ANALYZE) orders; -- reclaim dead tuples and re-analyze in one pass
```

`ANALYZE` samples the table and rewrites the histograms. `VACUUM` reclaims space from dead rows. On tables you bulk-load, run `ANALYZE` at the end of the load — cheap insurance against a plan built for yesterday's data.

## Index-only scans: when the index *is* the query

If an index contains every column a query needs, Postgres can answer from the index alone and never touch the table. `INCLUDE` adds payload columns without changing the sort order:

```sql
VACUUM (ANALYZE) orders;
CREATE INDEX idx_orders_status_inc ON orders (status) INCLUDE (total);

EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*), sum(total) FROM orders WHERE status = 'refunded';
```

```
 Aggregate  (cost=1086.81..1086.82 rows=1 width=40) (actual time=8.796..8.798 rows=1 loops=1)
   ->  Index Only Scan using idx_orders_status_inc on orders  (cost=0.43..944.05 rows=28550 width=6) (actual time=0.120..5.174 rows=30242 loops=1)
         Index Cond: (status = 'refunded'::text)
         Heap Fetches: 0
```

8.8 ms versus 84 ms for the bitmap plan above, with `Heap Fetches: 0` proving the table was never read. Those heap fetches are why you must vacuum: the visibility map has to say the pages are all-visible, or the scan still dips into the heap for each row.

## When the planner picks a seq scan and is right

A `Seq Scan` is not a failure. Here is a query matching 85% of the table:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*), round(avg(total),2) FROM orders WHERE status = 'paid';
```

```
 Finalize Aggregate  (cost=31692.33..31692.35 rows=1 width=40) (actual time=133.047..138.697 rows=1 loops=1)
   ->  Gather  (cost=31692.11..31692.32 rows=2 width=40) (actual time=132.919..138.671 rows=3 loops=1)
         ->  Partial Aggregate  (cost=30692.11..30692.12 rows=1 width=40) (actual time=128.853..128.854 rows=1 loops=3)
               ->  Parallel Seq Scan on orders  (cost=0.00..28034.50 rows=531521 width=6) (actual time=0.031..76.227 rows=424698 loops=3)
                     Filter: (status = 'paid'::text)
                     Rows Removed by Filter: 75302
```

It reads 1.27M rows in 139 ms across three workers. An index on `status` would visit most of the table's heap pages anyway, plus every index entry — strictly more work. When a predicate matches most of the table, the sequential scan is the cheap plan, and the planner is right to ignore your index.

## A repeatable method

1. **Find the slow query.** Check `pg_stat_statements` ordered by `total_exec_time`, not by what feels slow.
2. **Measure it cold and hot.** Run `EXPLAIN (ANALYZE, BUFFERS)` twice; the first run shows disk reads, the second shows cache hits.
3. **Compare `rows=` to `actual rows=` on every node.** A large gap means bad stats (run `ANALYZE`) or a correlated column the planner cannot see. Fix the estimate before touching indexes.
4. **Find the biggest rows × cost node** and read its children. That is where the time goes, not the `Execution Time` headline.
5. **Change one thing, re-measure.** An index, a rewritten predicate, a wider `INCLUDE`, or a fresh `ANALYZE` — one variable at a time.

None of this needs a profiler or a managed dashboard. A throwaway container, `generate_series`, and `EXPLAIN (ANALYZE, BUFFERS)` will teach you more about your queries than any article — including this one. If Postgres turns out to be overkill for the workload, the same habits transfer: see [SQLite is enough](/posts/sqlite-is-enough/) for the smaller-footprint case.
