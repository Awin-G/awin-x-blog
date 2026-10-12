---
title: "Database indexing basics that actually help: composite indexes and EXPLAIN ANALYZE"
description: "A practical guide to database indexing: what an index really is and what it costs, why \"add an index\" is often wrong, composite index column order and the leftmost prefix, covering indexes, when the query planner ignores you, and how to read EXPLAIN ANALYZE."
pubDate: 2026-11-18
lang: en
translationKey: database-indexing
tags: [devops, linux]
featured: false
keywords:
  - database indexing
  - composite index
  - EXPLAIN ANALYZE
  - query planner
  - covering index
---

**Database indexing** is the one change that turns a query from seconds into milliseconds — and the one that quietly makes every write slower and every table bigger. Most advice stops at "add an index", which is why so many databases end up with a dozen indexes nothing uses and a few slow queries that still scan the whole table. The index is not the goal; the query is. This is the practical version: what an index actually is, what it costs, how **composite index** column order works, when the **query planner** ignores you, and how to read **EXPLAIN ANALYZE** until it tells you the truth. Examples are Postgres; the ideas transfer to any B-tree.

## What an index really is — and what it costs

An index is a second, sorted copy of part of your data. That is the whole trick. A table is an unordered pile of rows; an index is a B-tree whose keys are kept in order, so the engine can binary-search instead of reading every row. When you write `WHERE email = 'a@b.com'`, a sequential scan reads all rows and tests each one; with an index on `email`, the engine walks a few pages and lands on the row.

The cost is easy to forget because you pay it later, on every write and on disk:

- **Every write maintains every index.** An `INSERT` writes the row plus one entry per index. An `UPDATE` that changes an indexed column rewrites those entries. A delete tombstones them.
- **Indexes take disk.** Sometimes more than the table they sit on.
- **They can bloat.** Under churn, dead entries accumulate until `VACUUM` reclaims them, and a bloated index still gets read.

```sql
CREATE INDEX idx_orders_customer ON orders (customer_id);

-- what did that just cost me?
SELECT pg_size_pretty(pg_relation_size('idx_orders_customer')) AS index_size,
       pg_size_pretty(pg_relation_size('orders'))              AS table_size;
```

So an index is a trade: faster reads, slower writes, more disk. That trade is usually worth it — but only against a query you have actually looked at.

## Why "add an index" is often wrong without looking at the query

An index only helps if it matches the shape of the query. The planner is not searching for "an index"; it is asking whether *this specific access path* can answer *this specific predicate*. An index on `email` is useless to a query that filters `lower(email)`, because the sorted keys are the original values. An index on `status` is often useless when 99% of rows share the same status, because reading the whole table is cheaper than following millions of pointers.

The order of operations matters, and it is the opposite of what people do. Look at the query first, then decide what index would serve it. "The table is slow, add indexes everywhere" produces the bloated-index database with the same slow query it started with.

## Composite index column order and the leftmost prefix

A composite (multi-column) index is sorted by the first column, then the second within ties of the first, and so on — like a phone book sorted by last name, then first name. That ordering rule is the **leftmost prefix** rule: an index on `(a, b, c)` can serve queries that constrain `a`, or `a, b`, or `a, b, c`. It cannot efficiently serve a query that only constrains `b`, or `b, c`, because those values are scattered across the whole index.

<figure>
<svg viewBox="0 0 660 300" width="100%" role="img" aria-label="An index on (a,b,c) is sorted by a, then b, then c. Queries that constrain a leftmost prefix — a, a plus b, or a plus b plus c — can use the index. Queries that start at b or c cannot.">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <text x="150" y="26" text-anchor="middle" font-weight="600" font-size="14">B-tree leaves: index on (a, b, c)</text>
    <text x="490" y="26" text-anchor="middle" font-weight="600" font-size="14">Can the planner use it?</text>
  </g>
  <!-- left: sorted leaves -->
  <g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
    <rect x="40" y="44" width="220" height="28" rx="6"/>
    <rect x="40" y="78" width="220" height="28" rx="6"/>
    <rect x="40" y="112" width="220" height="28" rx="6"/>
    <rect x="40" y="146" width="220" height="28" rx="6"/>
  </g>
  <rect x="34" y="38" width="232" height="108" rx="8" fill="none" stroke="#0f766e" stroke-width="2"/>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="13">
    <text x="150" y="63" text-anchor="middle">a=1, b=2, c=30</text>
    <text x="150" y="97" text-anchor="middle">a=1, b=2, c=31</text>
    <text x="150" y="131" text-anchor="middle">a=1, b=5, c=10</text>
    <text x="150" y="165" text-anchor="middle">a=2, b=1, c=99</text>
  </g>
  <text x="34" y="188" font-family="system-ui, sans-serif" font-size="12" fill="#0f766e">all rows with a=1 sit together</text>
  <!-- right: queries -->
  <g font-family="ui-monospace, monospace" font-size="13" fill="currentColor">
    <text x="350" y="63">WHERE a = 1</text>
    <text x="350" y="97">WHERE a = 1 AND b = 2</text>
    <text x="350" y="131">WHERE a = 1 AND b = 2 AND c = 3</text>
    <text x="350" y="165">WHERE b = 2</text>
    <text x="350" y="199">WHERE b = 2 AND c = 3</text>
    <text x="350" y="233">WHERE a = 1 AND c = 3</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="15" font-weight="700">
    <text x="620" y="63" fill="#0f766e">✓</text>
    <text x="620" y="97" fill="#0f766e">✓</text>
    <text x="620" y="131" fill="#0f766e">✓</text>
    <text x="620" y="165" fill="currentColor">✗</text>
    <text x="620" y="199" fill="currentColor">✗</text>
    <text x="620" y="233" fill="currentColor">~</text>
  </g>
  <text x="350" y="262" font-family="system-ui, sans-serif" font-size="12" fill="currentColor" opacity="0.8">~ uses a=1 only; c=3 is filtered after the fetch</text>
</svg>
<figcaption>A composite index serves a query only when the query constrains a leftmost prefix of its columns. Put equality columns first, then the column you sort or range on. Order the columns for your queries, not alphabetically.</figcaption>
</figure>

The rule of thumb for ordering columns:

- **Equality columns first**, in any order among themselves.
- **Then the range or sort column** — `ORDER BY` and `>`/`<` cannot both use columns to their right for ordering.
- **Then any columns you only fetch**, if you want a covering index.

```sql
-- a dashboard filters by tenant and status, then sorts by recency
SELECT * FROM events
WHERE tenant_id = 42 AND status = 'open'
ORDER BY created_at DESC
LIMIT 20;

-- equality, then equality, then the sort column
CREATE INDEX idx_events_tenant_status_created
  ON events (tenant_id, status, created_at DESC);
```

Swap `status` and `created_at` and the sort has to happen in memory again. Column order is not cosmetic.

## Covering indexes: when the index is the query

If an index contains every column a query needs, the engine can answer it from the index alone and skip the table entirely — an "index-only scan". In Postgres you usually keep the index keys lean and attach the extra columns with `INCLUDE`, which stores them in the leaves without affecting the sort order.

```sql
CREATE INDEX idx_orders_customer_covering
  ON orders (customer_id) INCLUDE (total, created_at);

EXPLAIN ANALYZE
SELECT total, created_at FROM orders WHERE customer_id = 42;
-- a win shows up as "Index Only Scan"
```

Two caveats. Index-only scans depend on the visibility map, so a table that has not been vacuumed recently still touches the heap — that "Heap Fetches" number in the plan. And every extra `INCLUDE` column is more disk and more write cost. Cover the hot query, not every query.

## When the query planner ignores your index

You made the index, the plan still says `Seq Scan`. Usually one of these:

- **A function or expression on the column.** `WHERE date(created_at) = '2026-01-01'` cannot use an index on `created_at`, because the planner would have to evaluate the function on every row. Rewrite as a range (`created_at >= '2026-01-01' AND created_at < '2026-01-02'`) or build an expression index: `CREATE INDEX ON events (date(created_at))`.
- **A type mismatch forcing a cast.** Comparing a column to a value of a different type can cast the *column* rather than the literal (`WHERE created_at::date = ...`, or comparing `text` against a differently-typed value), which defeats the index the same way a function does.
- **Low selectivity.** An index on a boolean, or on a `status` where most rows are the same value, rarely helps a query that matches most of the table. A sequential scan is the cheaper plan, and the planner is right.
- **Stale statistics.** The planner decides using row estimates from `pg_stat_analyze` data. After a bulk load, those stats are wrong until autovacuum or a manual `ANALYZE orders;` catches up — and a plan built on stale stats can be catastrophically off.

Notice the pattern: three of the four are about the *query or the stats*, not the index. Adding a second index does not fix a function on a column.

## Reading `EXPLAIN` and `EXPLAIN ANALYZE` for the basics

`EXPLAIN` shows the plan the planner *would* run. `EXPLAIN ANALYZE` actually executes the query and adds real timings and row counts. For anything beyond a toy query, always add `BUFFERS` and run it on a copy or in a transaction you can roll back, because `ANALYZE` runs it for real.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders
WHERE customer_id = 42 AND status = 'paid'
ORDER BY created_at DESC
LIMIT 20;
```

You do not need to read every operator. Read for four things:

- **Scan type on the big table.** `Seq Scan` on a large table is the first thing to explain. `Index Scan` / `Index Only Scan` are usually what you wanted.
- **Estimated rows vs actual rows.** The most useful signal in the whole plan. If the planner estimated 10 rows and got 100,000, it chose the wrong strategy on purpose, and the fix is `ANALYZE`, not another index.
- **`Buffers` and `Heap Fetches`.** How much I/O the plan really touched, independent of cache warmth.
- **`actual time` per node, and loop counts.** A nested loop that runs 50,000 times at 0.01 ms each is still half a second.

The skill is narrow: find the largest estimated-vs-actual gap and the most expensive node, and fix that. Then re-read the plan to confirm the numbers moved.

## The patterns that keep coming up

Most real-world indexing needs are a handful of shapes. `WHERE x AND y ORDER BY z` is the classic: put the equality columns first, then the sort column, as in the `events` example above. Two more recur constantly.

**Foreign keys.** Postgres does *not* create an index on the referencing side automatically. Deleting or updating a parent row makes the engine find every child row, and without an index on the child's foreign-key column that is a full scan — inside a lock. Index every `*_id` foreign key you actually query or delete on.

```sql
-- child side of the FK: needed for fast joins and cascade checks
CREATE INDEX idx_order_items_order_id ON order_items (order_id);
```

**Partial indexes.** When a query only ever cares about a slice of the table — a job queue that only polls `status = 'pending'` — index just that slice. The index is tiny, cheaper to maintain, and still exactly the right shape.

```sql
CREATE INDEX idx_jobs_pending ON jobs (run_at)
  WHERE status = 'pending';
```

## A method: find the slow query first

Do not start from the table. Start from the query that is actually slow, measured. In Postgres, `pg_stat_statements` gives you that. Rank by **total** time, not mean — a query that takes 20 ms but runs a million times matters more than one that takes 2 s once.

```sql
SELECT calls,
       round(total_exec_time)   AS total_ms,
       round(mean_exec_time, 2) AS mean_ms,
       rows,
       left(query, 60) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

Then the loop is: take the top query, run `EXPLAIN (ANALYZE, BUFFERS)` on it, find the expensive node or the estimated-vs-actual gap, design one index that matches the predicates and sort, re-run `EXPLAIN`, and confirm the plan changed *and* the timing dropped. Finally, check the write cost you just added, and drop the index if it did not earn its keep.

That is the whole discipline: measure the query, shape the index to it, verify with the plan, and watch what the index costs on writes. It is the same in SQLite (`EXPLAIN QUERY PLAN`) and MySQL (`EXPLAIN`), and it starts with the same question — not "what index should I add", but "what is my query actually doing". Indexes only pay off while the data is there to serve, which is why they and the [backup plan](/posts/postgres-backups/) matter together. And on SQLite the rules are identical — see [SQLite is enough](/posts/sqlite-is-enough/) for where the trade-offs land in one file.
