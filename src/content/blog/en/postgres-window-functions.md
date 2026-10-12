---
title: "Postgres window functions: the SQL that replaces your loops"
description: "Window functions compute across related rows without collapsing them. Learn ROW_NUMBER, RANK, LAG, running totals, frames, and the top-N-per-group pattern with real query output."
pubDate: 2027-01-03
lang: en
translationKey: postgres-window-functions
tags: [devops, linux]
featured: false
keywords:
  - Postgres window functions
  - ROW_NUMBER
  - PARTITION BY
  - top N per group
  - LAG LEAD
---

I used to write application code that fetched rows, looped over them in Python, and computed rankings, running totals, and deltas by hand. Then I discovered Postgres window functions — and deleted a lot of code.

A **window function** computes a value across a set of rows related to the current row, without collapsing those rows into a single output row. Unlike `GROUP BY`, which merges rows into groups, window functions keep every row intact and attach a computed value to each one.

The syntax is simple:

```sql
function_name() OVER (
    [PARTITION BY partition_expression]
    [ORDER BY sort_expression]
    [frame_clause]
)
```

The `OVER` clause defines the **window** — the set of rows the function sees. `PARTITION BY` divides rows into groups (like `GROUP BY`, but without collapsing). `ORDER BY` inside `OVER` defines the order within each partition. The **frame clause** further restricts which rows in the partition are visible to the function.

## Why window functions beat application-side loops

Consider a table of orders. You want a running total per user. Without window functions, you'd fetch all orders, loop in your application, and accumulate. With window functions:

```sql
SELECT order_id, user_id, amount, ordered_at,
       SUM(amount) OVER (PARTITION BY user_id ORDER BY ordered_at
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total
FROM orders
WHERE user_id IN (1, 2)
ORDER BY user_id, ordered_at;
```

```
 order_id | user_id | amount | ordered_at | running_total
----------+---------+--------+------------+---------------
        1 |       1 | 120.00 | 2024-01-05 |        120.00
        2 |       1 |  75.50 | 2024-01-12 |        195.50
        3 |       1 | 200.00 | 2024-02-01 |        395.50
        4 |       1 |  45.00 | 2024-02-15 |        440.50
        5 |       2 | 300.00 | 2024-01-08 |        300.00
        6 |       2 | 150.00 | 2024-01-20 |        450.00
        7 |       2 |  89.99 | 2024-02-10 |        539.99
(7 rows)
```

One query. No loop. No round-trips. The database does the work it was built to do.

## ROW_NUMBER, RANK, and DENSE_RANK

These three are the workhorses of ranking. They differ only in how they handle ties:

```sql
SELECT order_id, user_id, amount,
       ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY amount DESC) AS rn,
       RANK()       OVER (PARTITION BY user_id ORDER BY amount DESC) AS rnk,
       DENSE_RANK() OVER (PARTITION BY user_id ORDER BY amount DESC) AS dr
FROM orders
ORDER BY user_id, rn;
```

```
 order_id | user_id | amount | rn | rnk | dr
----------+---------+--------+----+-----+----
        3 |       1 | 200.00 |  1 |   1 |  1
        1 |       1 | 120.00 |  2 |   2 |  2
        2 |       1 |  75.50 |  3 |   3 |  3
        4 |       1 |  45.00 |  4 |   4 |  4
        5 |       2 | 300.00 |  1 |   1 |  1
        6 |       2 | 150.00 |  2 |   2 |  2
        7 |       2 |  89.99 |  3 |   3 |  3
        8 |       3 | 500.00 |  1 |   1 |  1
        9 |       3 | 220.00 |  2 |   2 |  2
       12 |       4 | 310.00 |  1 |   1 |  1
       10 |       4 | 180.00 |  2 |   2 |  2
       11 |       4 |  95.00 |  3 |   3 |  3
       13 |       5 | 250.00 |  1 |   1 |  1
       14 |       5 | 175.00 |  2 |   2 |  2
       15 |       6 | 400.00 |  1 |   1 |  1
       16 |       6 | 130.00 |  2 |   2 |  2
       17 |       7 | 275.00 |  1 |   1 |  1
       18 |       7 |  60.00 |  2 |   2 |  2
       19 |       8 | 350.00 |  1 |   1 |  1
       20 |       8 | 190.00 |  2 |   2 |  2
(20 rows)
```

- `ROW_NUMBER()` — sequential integers, no ties. Always 1, 2, 3, 4.
- `RANK()` — ties get the same rank, then skips. 1, 2, 2, 4.
- `DENSE_RANK()` — ties get the same rank, no skip. 1, 2, 2, 3.

Use `ROW_NUMBER()` when you need exactly N rows per group. Use `RANK()` when you want true competition ranking.

## LAG and LEAD: looking backward and forward

`LAG` accesses a previous row; `LEAD` accesses a subsequent row. Both require `ORDER BY` inside `OVER`:

```sql
SELECT order_id, user_id, amount, ordered_at,
       LAG(amount, 1, 0)  OVER (PARTITION BY user_id ORDER BY ordered_at) AS prev_amount,
       LEAD(amount, 1, 0) OVER (PARTITION BY user_id ORDER BY ordered_at) AS next_amount
FROM orders
WHERE user_id IN (1, 2)
ORDER BY user_id, ordered_at;
```

```
 order_id | user_id | amount | ordered_at | prev_amount | next_amount
----------+---------+--------+------------+-------------+-------------
        1 |       1 | 120.00 | 2024-01-05 |           0 |       75.50
        2 |       1 |  75.50 | 2024-01-12 |      120.00 |      200.00
        3 |       1 | 200.00 | 2024-02-01 |       75.50 |       45.00
        4 |       1 |  45.00 | 2024-02-15 |      200.00 |           0
        5 |       2 | 300.00 | 2024-01-08 |           0 |      150.00
        6 |       2 | 150.00 | 2024-01-20 |      300.00 |       89.99
        7 |       2 |  89.99 | 2024-02-10 |      150.00 |           0
(7 rows)
```

The third argument to `LAG`/`LEAD` is the default value when there's no previous/next row. Without it, you get `NULL`.

## PARTITION BY: grouping without collapsing

`PARTITION BY` is what makes window functions feel like `GROUP BY` — except rows stay individual:

```sql
SELECT order_id, user_id, amount, ordered_at,
       SUM(amount) OVER (PARTITION BY user_id ORDER BY ordered_at
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total,
       AVG(amount) OVER (PARTITION BY user_id) AS user_avg,
       COUNT(*)   OVER (PARTITION BY user_id) AS user_order_count,
       SUM(amount) OVER () AS grand_total
FROM orders
WHERE user_id IN (1, 2)
ORDER BY user_id, ordered_at;
```

```
 order_id | user_id | amount | ordered_at | running_total |       user_avg       | user_order_count | grand_total
----------+---------+--------+------------+---------------+----------------------+------------------
        1 |       1 | 120.00 | 2024-01-05 |        120.00 | 110.1250000000000000 |                4 |      980.49
        2 |       1 |  75.50 | 2024-01-12 |        195.50 | 110.1250000000000000 |                4 |      980.49
        3 |       1 | 200.00 | 2024-02-01 |        395.50 | 110.1250000000000000 |                4 |      980.49
        4 |       1 |  45.00 | 2024-02-15 |        440.50 | 110.1250000000000000 |                4 |      980.49
        5 |       2 | 300.00 | 2024-01-08 |        300.00 | 179.9966666666666667 |                3 |      980.49
        6 |       2 | 150.00 | 2024-01-20 |        450.00 | 179.9966666666666667 |                3 |      980.49
        7 |       2 |  89.99 | 2024-02-10 |        539.99 | 179.9966666666666667 |                3 |      980.49
(7 rows)
```

Notice how `user_avg` and `user_order_count` repeat for every row in the partition, while `running_total` accumulates. `SUM(amount) OVER ()` — empty `OVER` — computes across the entire result set.

## Frames: ROWS vs RANGE and UNBOUNDED PRECEDING

A **frame** defines which rows within the partition are visible to the aggregate. The default frame when you have `ORDER BY` is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` — which includes all rows that tie with the current row.

```sql
SELECT order_id, user_id, amount,
       NTILE(4) OVER (ORDER BY amount) AS quartile,
       FIRST_VALUE(amount) OVER (PARTITION BY user_id ORDER BY ordered_at
                                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS first_order_amt,
       LAST_VALUE(amount)  OVER (PARTITION BY user_id ORDER BY ordered_at
                                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS last_order_amt
FROM orders
WHERE user_id IN (1, 2)
ORDER BY user_id, ordered_at;
```

```
 order_id | user_id | amount | quartile | first_order_amt | last_order_amt
----------+---------+--------+----------+-----------------+----------------
        1 |       1 | 120.00 |        2 |          120.00 |         120.00
        2 |       1 |  75.50 |        1 |          120.00 |          75.50
        3 |       1 | 200.00 |        3 |          120.00 |         200.00
        4 |       1 |  45.00 |        1 |          120.00 |          45.00
        5 |       2 | 300.00 |        4 |          300.00 |         300.00
        6 |       2 | 150.00 |        3 |          300.00 |         150.00
        7 |       2 |  89.99 |        2 |          300.00 |          89.99
(7 rows)
```

`NTILE(4)` divides rows into four roughly equal buckets. `FIRST_VALUE` and `LAST_VALUE` with an explicit frame give you the first and last values in the ordered partition.

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240" role="img" aria-label="Window function partition and frame diagram">
  <defs>
    <style>
      .box { fill: #f0fdfa; stroke: #0f766e; stroke-width: 1.5; }
      .frame { fill: #ccfbf1; stroke: #0f766e; stroke-width: 2; stroke-dasharray: 4 2; }
      .label { font-family: system-ui, sans-serif; font-size: 13px; fill: #134e4a; }
      .small { font-family: system-ui, sans-serif; font-size: 11px; fill: #0f766e; }
    </style>
  </defs>
  <text x="20" y="24" class="label" font-weight="bold">Partition: user_id = 1</text>
  <rect x="20" y="40" width="120" height="36" class="box" rx="4"/>
  <text x="80" y="63" text-anchor="middle" class="small">row 1</text>
  <rect x="150" y="40" width="120" height="36" class="box" rx="4"/>
  <text x="210" y="63" text-anchor="middle" class="small">row 2</text>
  <rect x="280" y="40" width="120" height="36" class="box" rx="4"/>
  <text x="340" y="63" text-anchor="middle" class="small">row 3</text>
  <rect x="410" y="40" width="120" height="36" class="box" rx="4"/>
  <text x="470" y="63" text-anchor="middle" class="small">row 4</text>
  <rect x="280" y="40" width="120" height="36" class="frame" rx="4"/>
  <text x="340" y="95" text-anchor="middle" class="small">current row</text>
  <text x="20" y="130" class="label" font-weight="bold">Frame: ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW</text>
  <rect x="20" y="146" width="120" height="36" class="frame" rx="4"/>
  <text x="80" y="169" text-anchor="middle" class="small">row 1</text>
  <rect x="150" y="146" width="120" height="36" class="frame" rx="4"/>
  <text x="210" y="169" text-anchor="middle" class="small">row 2</text>
  <rect x="280" y="146" width="120" height="36" class="frame" rx="4"/>
  <text x="340" y="169" text-anchor="middle" class="small">row 3</text>
  <rect x="410" y="146" width="120" height="36" class="box" rx="4" opacity="0.4"/>
  <text x="470" y="169" text-anchor="middle" class="small">row 4</text>
  <text x="20" y="210" class="small">The frame slides forward as the current row advances.</text>
</svg>
<figcaption>A partition groups rows; a frame defines which rows the function sees at each step.</figcaption>
</figure>

## The killer pattern: top N per group

This is the query that replaces the most application code. "Give me the top 2 orders per user":

```sql
WITH ranked AS (
    SELECT o.order_id, o.user_id, u.name, o.amount, o.ordered_at,
           ROW_NUMBER() OVER (PARTITION BY o.user_id ORDER BY o.amount DESC) AS rn
    FROM orders o
    JOIN users u ON u.user_id = o.user_id
)
SELECT order_id, user_id, name, amount, ordered_at
FROM ranked
WHERE rn <= 2
ORDER BY user_id, amount DESC;
```

```
 order_id | user_id | name  | amount | ordered_at
----------+---------+-------+--------+------------
        3 |       1 | Alice | 200.00 | 2024-02-01
        1 |       1 | Alice | 120.00 | 2024-01-05
        5 |       2 | Bob   | 300.00 | 2024-01-08
        6 |       2 | Bob   | 150.00 | 2024-01-20
        8 |       3 | Carol | 500.00 | 2024-01-15
        9 |       3 | Carol | 220.00 | 2024-02-05
       12 |       4 | Dave  | 310.00 | 2024-02-12
       10 |       4 | Dave  | 180.00 | 2024-01-10
       13 |       5 | Eve   | 250.00 | 2024-01-18
       14 |       5 | Eve   | 175.00 | 2024-02-08
       15 |       6 | Frank | 400.00 | 2024-01-22
       16 |       6 | Frank | 130.00 | 2024-02-14
       17 |       7 | Grace | 275.00 | 2024-01-28
       18 |       7 | Grace |  60.00 | 2024-02-20
       19 |       8 | Heidi | 350.00 | 2024-02-02
       20 |       8 | Heidi | 190.00 | 2024-02-18
(16 rows)
```

The pattern is always the same: CTE with `ROW_NUMBER()`, outer query filters on the rank. Change `ROW_NUMBER()` to `RANK()` if ties should be included.

## Window functions vs self-joins: the real plan comparison

The self-join equivalent of "top 2 per user" uses a correlated subquery:

```sql
SELECT o.order_id, o.user_id, u.name, o.amount, o.ordered_at
FROM orders o
JOIN users u ON u.user_id = o.user_id
WHERE (
    SELECT COUNT(*)
    FROM orders o2
    WHERE o2.user_id = o.user_id
      AND o2.amount > o.amount
) < 2
ORDER BY o.user_id, o.amount DESC;
```

Same result. Very different plan. Here's the window function approach:

```
                                         QUERY PLAN
---------------------------------------------------------------------------------------------
 Subquery Scan on ranked (actual time=0.143..0.157 rows=16 loops=1)
   Buffers: shared hit=8
   ->  WindowAgg (actual time=0.142..0.154 rows=16 loops=1)
         Run Condition: (row_number() OVER (?) <= 2)
         Buffers: shared hit=8
         ->  Sort (actual time=0.136..0.138 rows=20 loops=1)
               Sort Key: o.user_id, o.amount DESC
               Sort Method: quicksort  Memory: 26kB
               Buffers: shared hit=8
               ->  Hash Join (actual time=0.055..0.061 rows=20 loops=1)
                     Hash Cond: (o.user_id = u.user_id)
                     Buffers: shared hit=2
                     ->  Seq Scan on orders o (actual time=0.008..0.009 rows=20 loops=1)
                           Buffers: shared hit=1
                     ->  Hash (actual time=0.016..0.017 rows=8 loops=1)
                           Buckets: 1024  Batches: 1  Memory Usage: 9kB
                           Buffers: shared hit=1
                           ->  Seq Scan on users u (actual time=0.005..0.006 rows=8 loops=1)
                                 Buffers: shared hit=1
 Planning:
   Buffers: shared hit=135
 Planning Time: 1.686 ms
 Execution Time: 0.339 ms
(23 rows)
```

And the self-join:

```
                                            QUERY PLAN
--------------------------------------------------------------------------------------------------
 Incremental Sort (actual time=0.325..0.328 rows=16 loops=1)
   Sort Key: o.user_id, o.amount DESC
   Presorted Key: o.user_id
   Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
   Buffers: shared hit=26
   ->  Merge Join (actual time=0.248..0.260 rows=16 loops=1)
         Merge Cond: (u.user_id = o.user_id)
         Buffers: shared hit=23
         ->  Index Scan using users_pkey on users u (actual time=0.027..0.030 rows=8 loops=1)
               Buffers: shared hit=2
         ->  Sort (actual time=0.215..0.217 rows=16 loops=1)
               Sort Key: o.user_id
               Sort Method: quicksort  Memory: 25kB
               Buffers: shared hit=21
               ->  Seq Scan on orders o (actual time=0.037..0.187 rows=16 loops=1)
                     Filter: ((SubPlan 1) < 2)
                     Rows Removed by Filter: 4
                     Buffers: shared hit=21
                     SubPlan 1
                       ->  Aggregate (actual time=0.008..0.008 rows=1 loops=20)
                             Buffers: shared hit=20
                             ->  Seq Scan on orders o2 (actual time=0.005..0.006 rows=1 loops=20)
                                   Filter: ((amount > o.amount) AND (user_id = o.user_id))
                                   Rows Removed by Filter: 19
                                   Buffers: shared hit=20
 Planning:
   Buffers: shared hit=134
 Planning Time: 1.791 ms
 Execution Time: 0.555 ms
(29 rows)
```

The window function plan is a single `WindowAgg` over a sorted stream — one pass, no subqueries. The self-join plan runs a correlated `SubPlan` that scans `orders` once per outer row (20 loops, 20 buffer hits). On this tiny dataset the window function is ~1.6x faster. At 1M rows, the difference is orders of magnitude.

## Gotchas that will bite you

**1. Default frame includes ties.** When you write `ORDER BY` inside `OVER` without a frame, the default is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` — which includes all rows that tie with the current row. This makes `LAST_VALUE` return the current row, not the true last value:

```sql
SELECT order_id, user_id, amount, ordered_at,
       LAST_VALUE(amount) OVER (PARTITION BY user_id ORDER BY ordered_at) AS default_last,
       LAST_VALUE(amount) OVER (PARTITION BY user_id ORDER BY ordered_at
                                ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS correct_last
FROM orders
WHERE user_id = 1
ORDER BY ordered_at;
```

```
 order_id | user_id | amount | ordered_at | default_last | correct_last
----------+---------+--------+------------+--------------+--------------
        1 |       1 | 120.00 | 2024-01-05 |       120.00 |        45.00
        2 |       1 |  75.50 | 2024-01-12 |        75.50 |        45.00
        3 |       1 | 200.00 | 2024-02-01 |       200.00 |        45.00
        4 |       1 |  45.00 | 2024-02-15 |        45.00 |        45.00
(4 rows)
```

Always specify the frame explicitly when using `LAST_VALUE` or running aggregates.

**2. `ORDER BY` inside `OVER` is not the same as the outer `ORDER BY`.** The `ORDER BY` in `OVER` defines the window order. The outer `ORDER BY` only sorts the final output. They can be different.

**3. Window functions are evaluated after `WHERE`, `GROUP BY`, and `HAVING`.** You can't use a window function in a `WHERE` clause. Use a CTE or subquery.

**4. Performance: window functions sort.** The `WindowAgg` node requires sorted input. If your `PARTITION BY` and `ORDER BY` columns aren't indexed, Postgres will sort — which is fine for moderate data but worth watching at scale. An index on `(user_id, amount DESC)` would let Postgres skip the sort in the top-N-per-group query.

## When to reach for window functions

- Running totals, moving averages, cumulative sums
- Ranking and top-N-per-group
- Accessing previous/next rows without self-joins
- Percentiles and bucketing with `NTILE`
- Deduplication (keep the latest row per group)

Window functions are one of those features that, once internalized, change how you write SQL. You stop thinking in loops and start thinking in sets. The database does the heavy lifting, and your application code gets simpler.

For more on how Postgres executes these queries, see [Postgres EXPLAIN](/posts/postgres-explain/) and [database indexing](/posts/database-indexing/).
