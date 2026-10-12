---
title: "Postgres 窗口函数：替代循环的 SQL"
description: "窗口函数在不折叠行的情况下跨相关行计算值。学习 ROW_NUMBER、RANK、LAG、累计求和、frames 以及 top-N-per-group 模式，附真实查询输出。"
pubDate: 2027-01-03
lang: zh
translationKey: postgres-window-functions
tags: [devops, linux]
featured: false
keywords:
  - Postgres 窗口函数
  - ROW_NUMBER
  - PARTITION BY
  - top N per group
  - LAG LEAD
---

我过去常常写应用代码：从数据库取出所有行，在 Python 里循环遍历，手动计算排名、累计总额和差值。后来我发现了 Postgres 窗口函数——然后删掉了大量代码。

**窗口函数**（window function）在当前行的一组相关行上计算值，但不会把这些行折叠成单行输出。与 `GROUP BY` 将行合并为组不同，窗口函数保留每一行的完整性，并为每一行附加一个计算值。

语法很简单：

```sql
function_name() OVER (
    [PARTITION BY partition_expression]
    [ORDER BY sort_expression]
    [frame_clause]
)
```

`OVER` 子句定义了**窗口**——函数能看到的一组行。`PARTITION BY` 将行划分为组（类似 `GROUP BY`，但不折叠）。`OVER` 内部的 `ORDER BY` 定义每个分区内的排序。**frame 子句**进一步限制分区中哪些行对函数可见。

## 为什么窗口函数优于应用层循环

假设有一张订单表。你想计算每个用户的累计总额。不用窗口函数的话，你需要取出所有订单，在应用层循环累加。用窗口函数：

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

一条查询。没有循环。没有多次往返。数据库做了它最擅长的事。

## ROW_NUMBER、RANK 和 DENSE_RANK

这三个是排名的主力函数。它们只在处理并列值时不同：

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

- `ROW_NUMBER()` — 连续整数，无并列。始终是 1, 2, 3, 4。
- `RANK()` — 并列值获得相同排名，然后跳号。1, 2, 2, 4。
- `DENSE_RANK()` — 并列值获得相同排名，不跳号。1, 2, 2, 3。

需要每组恰好 N 行时用 `ROW_NUMBER()`。需要真正的竞赛排名时用 `RANK()`。

## LAG 和 LEAD：向前和向后看

`LAG` 访问前一行；`LEAD` 访问后一行。两者都需要 `OVER` 内部有 `ORDER BY`：

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

`LAG`/`LEAD` 的第三个参数是没有前一行/后一行时的默认值。不指定则返回 `NULL`。

## PARTITION BY：分组但不折叠

`PARTITION BY` 让窗口函数感觉像 `GROUP BY`——但行保持独立：

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

注意 `user_avg` 和 `user_order_count` 在分区内每行重复，而 `running_total` 逐行累加。`SUM(amount) OVER ()`——空 `OVER`——在整个结果集上计算。

## Frames：ROWS vs RANGE 和 UNBOUNDED PRECEDING

**frame** 定义分区内哪些行对聚合函数可见。当 `OVER` 内有 `ORDER BY` 但未指定 frame 时，默认是 `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`——包含所有与当前行并列的行。

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

`NTILE(4)` 将行分成四个大致相等的桶。`FIRST_VALUE` 和 `LAST_VALUE` 配合显式 frame 给出有序分区中的第一个和最后一个值。

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240" role="img" aria-label="窗口函数分区和 frame 示意图">
  <defs>
    <style>
      .box { fill: #f0fdfa; stroke: #0f766e; stroke-width: 1.5; }
      .frame { fill: #ccfbf1; stroke: #0f766e; stroke-width: 2; stroke-dasharray: 4 2; }
      .label { font-family: system-ui, sans-serif; font-size: 13px; fill: #134e4a; }
      .small { font-family: system-ui, sans-serif; font-size: 11px; fill: #0f766e; }
    </style>
  </defs>
  <text x="20" y="24" class="label" font-weight="bold">分区: user_id = 1</text>
  <rect x="20" y="40" width="120" height="36" class="box" rx="4"/>
  <text x="80" y="63" text-anchor="middle" class="small">行 1</text>
  <rect x="150" y="40" width="120" height="36" class="box" rx="4"/>
  <text x="210" y="63" text-anchor="middle" class="small">行 2</text>
  <rect x="280" y="40" width="120" height="36" class="box" rx="4"/>
  <text x="340" y="63" text-anchor="middle" class="small">行 3</text>
  <rect x="410" y="40" width="120" height="36" class="box" rx="4"/>
  <text x="470" y="63" text-anchor="middle" class="small">行 4</text>
  <rect x="280" y="40" width="120" height="36" class="frame" rx="4"/>
  <text x="340" y="95" text-anchor="middle" class="small">当前行</text>
  <text x="20" y="130" class="label" font-weight="bold">Frame: ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW</text>
  <rect x="20" y="146" width="120" height="36" class="frame" rx="4"/>
  <text x="80" y="169" text-anchor="middle" class="small">行 1</text>
  <rect x="150" y="146" width="120" height="36" class="frame" rx="4"/>
  <text x="210" y="169" text-anchor="middle" class="small">行 2</text>
  <rect x="280" y="146" width="120" height="36" class="frame" rx="4"/>
  <text x="340" y="169" text-anchor="middle" class="small">行 3</text>
  <rect x="410" y="146" width="120" height="36" class="box" rx="4" opacity="0.4"/>
  <text x="470" y="169" text-anchor="middle" class="small">行 4</text>
  <text x="20" y="210" class="small">随着当前行向前推进，frame 也随之滑动。</text>
</svg>
<figcaption>分区对行分组；frame 定义函数在每一步看到哪些行。</figcaption>
</figure>

## 杀手级模式：top N per group

这是替代最多应用层代码的查询。"每个用户取前 2 个订单"：

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

这个模式始终如一：CTE 中使用 `ROW_NUMBER()`，外层查询按排名过滤。如果需要包含并列值，将 `ROW_NUMBER()` 换成 `RANK()`。

## 窗口函数 vs 自连接：真实计划对比

"每个用户前 2 名"的自连接等价写法使用相关子查询：

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

相同的结果。截然不同的计划。窗口函数方案：

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

自连接方案：

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

窗口函数计划是单次 `WindowAgg` 遍历已排序的流——一遍完成，无子查询。自连接计划运行相关 `SubPlan`，对外层每一行扫描一次 `orders`（20 次循环，20 次 buffer 命中）。在这个小数据集上窗口函数快约 1.6 倍。在 1M 行时，差距是数量级的。

## 会踩的坑

**1. 默认 frame 包含并列值。** 当你在 `OVER` 中写 `ORDER BY` 但不指定 frame 时，默认是 `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`——包含所有与当前行并列的行。这使得 `LAST_VALUE` 返回当前行而非真正的最后一个值：

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

使用 `LAST_VALUE` 或累计聚合时，始终显式指定 frame。

**2. `OVER` 内部的 `ORDER BY` 与外层 `ORDER BY` 不同。** `OVER` 中的 `ORDER BY` 定义窗口排序。外层 `ORDER BY` 仅对最终输出排序。两者可以不同。

**3. 窗口函数在 `WHERE`、`GROUP BY` 和 `HAVING` 之后执行。** 不能在 `WHERE` 子句中使用窗口函数。请使用 CTE 或子查询。

**4. 性能：窗口函数需要排序。** `WindowAgg` 节点需要已排序的输入。如果 `PARTITION BY` 和 `ORDER BY` 的列没有索引，Postgres 会排序——中等数据量没问题，但大规模时需要关注。在 `(user_id, amount DESC)` 上建立索引可以让 Postgres 在 top-N-per-group 查询中跳过排序。

## 什么时候使用窗口函数

- 累计总额、移动平均、累计求和
- 排名和 top-N-per-group
- 不使用自连接访问前一行/后一行
- 使用 `NTILE` 进行百分位和分桶
- 去重（每组保留最新行）

窗口函数是那些一旦内化就会改变你写 SQL 方式的功能之一。你不再用循环思考，而是开始用集合思考。数据库承担重任，你的应用代码变得更简洁。

更多关于 Postgres 如何执行这些查询的信息，请参阅 [Postgres EXPLAIN](/zh/posts/postgres-explain/) 和 [数据库索引](/zh/posts/database-indexing/)。
