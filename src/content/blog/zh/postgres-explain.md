---
title: "读懂 Postgres 的 EXPLAIN ANALYZE：真实查询计划与真实数字"
description: "用一张 150 万行的表跑出的真实计划，讲清 EXPLAIN、EXPLAIN ANALYZE 与 BUFFERS 的区别：如何自下而上读 Postgres 查询计划、估算行数与实际行数为何对不上（统计过期）、顺序扫描与索引扫描、嵌套循环与哈希连接、仅索引扫描，以及一套可复用的方法：先找到慢查询，再盯住行数×代价最大的那个节点。"
pubDate: 2026-12-07
lang: zh
translationKey: postgres-explain
tags: [devops, linux]
featured: false
keywords:
  - EXPLAIN ANALYZE
  - Postgres 查询计划
  - seq scan vs index scan
  - 查询计划器
  - BUFFERS
---

**EXPLAIN ANALYZE** 是你停止对慢查询瞎猜的方式。`EXPLAIN` 打印的是**查询计划器**打算执行的 **Postgres 查询计划**；`EXPLAIN ANALYZE` 会真正执行这条查询，然后逐节点告诉你实际发生了什么——真实行数、真实毫秒、真实缓冲区计数。下面所有内容都来自一个用完即弃的 Postgres 16 容器，里面是一张 150 万行的 `orders` 表，每一份计划都是原样粘贴的。如果你想先补索引理论，去看[数据库索引基础](/zh/posts/database-indexing/)；这一篇讲的是怎么读计划器交给你的那些数字。

## EXPLAIN 与 EXPLAIN ANALYZE 与 BUFFERS 的区别

`EXPLAIN` 只跑计划器、不跑查询，所以它只知道估算值。对一次「按未加索引的列查单个客户」的操作，它打印出：

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

每个节点里有两个数字最重要：`cost=启动..总计`（任意的代价单位）和 `rows=N`（**估算**行数）。`EXPLAIN ANALYZE` 会真的执行查询，再补上 `actual time=启动..总计 rows=N loops=N`。加上 `BUFFERS`，每个节点还会汇报它碰过的 8 kB 块：`shared hit` 来自缓存，`shared read` 来自磁盘，`written` 是被弄脏的块。

一个提醒：`ANALYZE` 是真跑查询。对 `INSERT`/`UPDATE`/`DELETE` 来说这意味着副作用。把它包进一个可以 `ROLLBACK` 的事务，或者在一份拷贝上跑。

## 自下而上读 Postgres 查询计划

计划是一棵树。缩进最深的节点最先执行，然后把行喂给它的父节点。从叶子往上读到顶，并记住 `loops=N` 是个乘数：一个显示 `actual rows=7 loops=3` 的节点，实际产出了 21 行。

<figure>
<svg viewBox="0 0 660 340" width="100%" role="img" aria-label="Postgres 计划是一棵树，要自下而上读。叶子扫描节点最先执行并把行向上喂；每个父节点消费子节点的行。行数乘以代价最大的那个节点，就是最该先看的节点。">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <text x="330" y="24" text-anchor="middle" font-weight="600" font-size="14">计划是一棵树——自下而上读</text>
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
    <text x="330" y="240" text-anchor="middle">↑ 行向上流动：父节点消费子节点的行</text>
    <text x="140" y="266" text-anchor="middle">叶子最先执行</text>
    <text x="520" y="266" text-anchor="middle">哈希的构建侧</text>
    <text x="330" y="300" text-anchor="middle" font-weight="600">行数 × 代价最大的节点，才是最该先查的。</text>
  </g>
</svg>
<figcaption>计划是一棵树：叶子扫描最先执行，把行向上推给父节点。把注意力花在处理行数最多、耗时最长的那个节点上，而不是顶层那一行。</figcaption>
</figure>

## 估算行数与实际行数：查询计划器会在哪里说谎

最有用的对比就是 `rows=` 和 `actual rows=`。两者接近，说明计划器选了一条合理的路径；估算差了数量级，它上面的每一个决策都建立在错误前提上——通常是统计信息过期。下面这张新表先有 500 行，跑一次 `ANALYZE`，然后一次性灌入 50 万行却不再分析：

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM signups WHERE plan = 'pro';
```

```
 Gather  (cost=1000.00..6263.62 rows=1 width=17) (actual time=0.411..75.434 rows=500000 loops=1)
   ->  Parallel Seq Scan on signups  (cost=0.00..5263.52 rows=1 width=17) (actual time=0.058..40.527 rows=166667 loops=3)
         Filter: (plan = 'pro'::text)
```

计划器预测 **1 行**，实际拿到 **500000 行**。结果依然正确，但这个计划是按一个已经不存在的世界选的。执行 `ANALYZE signups;` 之后，同一条查询估算变成 `rows=500050`，与真实值吻合。正是这种错配——而不是单纯的慢——把一个好计划变成做 50 万次索引探测的嵌套循环。

## 值得认识的节点类型

你不需要背下六十多个计划节点，下面这些覆盖了大多数真实计划：

- **Seq Scan** — 读表的每一个块。摊到每行便宜，摊到整张表昂贵。
- **Index Scan** — 走 B-tree，再一个一个指针地把行从堆里取回来。
- **Bitmap Index/Heap Scan** — 先把命中的行位置收进一个位图，按物理位置排序，再按顺序取堆。适合中等数量的行。
- **Nested Loop** — 对每个外层行，跑一遍内层。外层极小、内层有索引时极佳。
- **Hash Join** — 用较小的一侧建哈希表，用较大的一侧去探测。连接大集合时的默认选择。
- **Sort** — 常由 `ORDER BY` 或归并触发；留意 `Sort Method: external merge`（说明溢写到了磁盘）。
- **Aggregate** — `count`、`sum`、`GROUP BY`。出现 `Partial`/`Finalize` 说明工作被拆给了并行 worker。

### seq scan vs index scan

同一条查询，两种状态。在 `customer_id` 上加索引之前，计划器别无选择：

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

`Rows Removed by Filter: 499993` 就是破绽：为了找 20 行，它读完了整张表。执行 `CREATE INDEX idx_orders_customer ON orders (customer_id);` 之后，同一条查询变成：

```
 Bitmap Heap Scan on orders  (cost=4.66..121.57 rows=30 width=26) (actual time=0.057..0.110 rows=20 loops=1)
   ->  Bitmap Index Scan on idx_orders_customer  (cost=0.00..4.65 rows=30 width=0) (actual time=0.042..0.042 rows=20 loops=1)
```

73 毫秒变成 0.2 毫秒，`Buffers: shared hit=13837 read=6385` 也塌缩成几个索引页。当条件命中单个键时，Postgres 会换成普通的 `Index Scan`：

```
 Index Scan using orders_pkey on orders  (cost=0.43..8.45 rows=1 width=23) (actual time=0.070..0.071 rows=1 loops=1)
   Index Cond: (id = 900000)
   Buffers: shared hit=5 read=2
```

而对一个中等选择性的值——`status = 'refunded'`，约占 150 万行的 2%——它偏好位图，这样可以按物理顺序取堆：

```
 Bitmap Heap Scan on orders  (cost=335.76..21924.12 rows=29850 width=18) (actual time=6.625..82.905 rows=30242 loops=1)
   Heap Blocks: exact=15744
   ->  Bitmap Index Scan on idx_orders_status  (cost=0.00..328.30 rows=29850 width=0) (actual time=3.998..3.999 rows=30242 loops=1)
```

### 嵌套循环 vs 哈希连接

连接的规模决定了用哪种算法。只查一个客户时，计划器选择循环：

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

连接整张表时，它改用哈希来收回代价：

```
 Hash Join  (cost=1492.00..29604.77 rows=625000 width=9) (actual time=20.521..289.723 rows=500000 loops=3)
   Hash Cond: (o.customer_id = c.id)
   ->  Parallel Seq Scan on orders o  (cost=0.00..26472.00 rows=625000 width=10) (actual time=0.024..65.910 rows=500000 loops=3)
   ->  Hash  (cost=867.00..867.00 rows=50000 width=7) (actual time=20.124..20.124 rows=50000 loops=3)
         ->  Seq Scan on customers c  (cost=0.00..867.00 rows=50000 width=7) (actual time=0.019..7.830 rows=50000 loops=3)
```

这里如果用嵌套循环，就是 150 万次索引探测；哈希连接把每一侧只读一遍。这正是计划器如此在意上一节那个行数估算的全部原因。

## 统计过期与 `ANALYZE`

计划器的 `rows=` 估算来自统计信息，autovacuum 大约在表变化 10% 后刷新它。一次批量导入之后，autovacuum 还没来得及跑，`reltuples` 仍然写着 500，而表里已经有 500500 行——这就是上面那个错配。修法很平常：

```sql
ANALYZE orders;          -- 刷新一张表的计划器统计信息
VACUUM (ANALYZE) orders; -- 一趟里回收死元组并重新分析
```

`ANALYZE` 采样表并重写直方图；`VACUUM` 回收死行占用的空间。对批量导入的表，在导入结束时跑一次 `ANALYZE`——用很小的代价，换掉一个照着昨天的数据选出来的计划。

## 仅索引扫描：当索引**就是**查询本身

如果一个索引包含了查询需要的所有列，Postgres 就能只靠索引回答，完全不碰表。`INCLUDE` 用来附加载荷列，而不改变排序顺序：

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

8.8 毫秒，对比上面那位图计划的 84 毫秒，`Heap Fetches: 0` 证明表根本没被读。那些 heap fetch 正是你必须 vacuum 的原因：可见性映射必须标记这些页是 all-visible，否则扫描仍会为每一行去堆里看一眼。

## 当计划器选择顺序扫描，而且它是对的

`Seq Scan` 不是失败。下面这条查询命中了整张表的 85%：

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

它用三个 worker 在 139 毫秒里读了 127 万行。给 `status` 加索引反而会访问表里几乎所有的堆页，外加每一条索引项——纯粹做更多功。当条件命中整张表的大部分时，顺序扫描就是便宜的计划，计划器无视你的索引是对的。

## 一套可复用的方法

1. **先找到慢查询。** 看 `pg_stat_statements`，按 `total_exec_time` 排序，而不是凭感觉。
2. **冷热各测一次。** `EXPLAIN (ANALYZE, BUFFERS)` 跑两遍；第一遍显示磁盘读，第二遍显示缓存命中。
3. **逐个节点对比 `rows=` 和 `actual rows=`。** 差距大意味着统计过期（跑 `ANALYZE`），或者存在计划器看不见的相关列。先修估算，再动索引。
4. **找出 行数 × 代价 最大的节点**，读它的子节点。时间花在那里，不在 `Execution Time` 那个标题上。
5. **一次只改一处，然后重测。** 一个索引、一次谓词改写、一个更宽的 `INCLUDE`，或者一次新的 `ANALYZE`——一次一个变量。

这些都不需要 profiler 或托管仪表盘。一个用完即弃的容器、`generate_series` 和 `EXPLAIN (ANALYZE, BUFFERS)`，教给你的查询知识会比任何文章都多——包括这一篇。如果 Postgres 对这个负载来说太重，同样的习惯可以迁移：更小体量的场景见 [SQLite 就够了](/zh/posts/sqlite-is-enough/)。
