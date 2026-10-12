---
title: "真正有用的数据库索引基础：复合索引与 EXPLAIN ANALYZE"
description: "一份务实的数据库索引指南：索引到底是什么、要付出什么代价（写入与磁盘）；为什么「加个索引」往往是错的、要先看查询；复合索引的列顺序与最左前缀；覆盖索引；查询计划器什么时候无视你的索引（类型不匹配、列上套函数、选择性太低、统计过期）；怎么读懂 EXPLAIN ANALYZE，以及一套方法：先找到真正慢的那条查询。"
pubDate: 2026-11-18
lang: zh
translationKey: database-indexing
tags: [devops, linux]
featured: false
keywords:
  - 数据库索引
  - 复合索引
  - EXPLAIN ANALYZE
  - 查询计划器
  - 覆盖索引
---

**数据库索引**是把查询从「秒」变成「毫秒」的那一个改动，也是悄悄让每次写入变慢、每张表变大的那一个。大多数建议到「加个索引」就停了，于是很多数据库攒下一打没人用的索引，以及几条仍然全表扫描的慢查询。索引不是目的，查询才是。这篇是务实版本：索引到底是什么、要付出什么代价、**复合索引**的列顺序怎么定、**查询计划器**什么时候无视你，以及怎么读 **EXPLAIN ANALYZE**，直到它说实话。示例用 Postgres，但思路适用于任何 B-tree。

## 索引到底是什么——以及它要花掉什么

索引就是数据的第二份、排好序的副本。整个把戏就这一句。表是一堆无序的行；索引是一棵 B-tree，键保持有序，于是引擎可以二分查找，而不用读每一行。当你写 `WHERE email = 'a@b.com'` 时，顺序扫描会读所有行、逐行判断；有了 `email` 上的索引，引擎走几个页就落到那一行。

代价容易被忘记，因为你是在以后才付：每一次写入、每一块磁盘。

- **每次写入都要维护每个索引。** 一条 `INSERT` 会写行，外加每个索引一条记录；改到被索引列的 `UPDATE` 会重写那些记录；删除会给它们打上墓碑标记。
- **索引占磁盘。** 有时比它所在的那张表还大。
- **它们会膨胀。** 频繁增删下，死记录不断累积，直到 `VACUUM` 回收；而膨胀后的索引照样要读。

```sql
CREATE INDEX idx_orders_customer ON orders (customer_id);

-- 刚才那一下花掉了什么？
SELECT pg_size_pretty(pg_relation_size('idx_orders_customer')) AS index_size,
       pg_size_pretty(pg_relation_size('orders'))              AS table_size;
```

所以索引是一笔交易：读更快，写更慢，占更多磁盘。这笔交易通常值——但前提是你真的对着一条看过的查询来做。

## 为什么「加个索引」往往是错的——先看查询

只有当索引匹配查询的形状时，它才有用。计划器不是在找「某个索引」，它在问：*这条特定的访问路径*能不能回答*这个特定的谓词*。`email` 上的索引对一条筛选 `lower(email)` 的查询毫无用处，因为排好序的键是原值。`status` 上的索引在 99% 的行都共享同一个 status 时通常也没用，因为读整张表比跟着几百万个指针更便宜。

顺序很重要，而且和大多数人的做法相反：先看查询，再决定什么样的索引能服务它。「表慢，到处加索引」的产物，就是那个带着同样慢查询的膨胀索引数据库。

## 复合索引的列顺序与最左前缀

复合（多列）索引先按第一列排序，在第一列相同的组内再按第二列排，以此类推——就像电话簿先按姓排、再按名排。这条排序规则就是**最左前缀**（leftmost prefix）规则：`(a, b, c)` 上的索引可以服务约束了 `a`、或 `a, b`、或 `a, b, c` 的查询；它无法有效服务只约束 `b`、或 `b, c` 的查询，因为这些值散落在整个索引里。

<figure>
<svg viewBox="0 0 660 300" width="100%" role="img" aria-label="(a,b,c) 上的索引先按 a 排，再按 b，再按 c。约束了最左前缀的查询——a、a 加 b、或 a 加 b 加 c——可以用到这个索引；从 b 或 c 开始的查询用不到。">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <text x="150" y="26" text-anchor="middle" font-weight="600" font-size="14">B-tree 叶子：(a, b, c) 上的索引</text>
    <text x="490" y="26" text-anchor="middle" font-weight="600" font-size="14">计划器能用上吗？</text>
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
  <text x="34" y="188" font-family="system-ui, sans-serif" font-size="12" fill="#0f766e">所有 a=1 的行挨在一起</text>
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
  <text x="350" y="262" font-family="system-ui, sans-serif" font-size="12" fill="currentColor" opacity="0.8">~ 只用到 a=1；c=3 在取回后再过滤</text>
</svg>
<figcaption>复合索引只有在查询约束了它最左的一串前缀时才起作用。把等值列放前面，然后放你要排序或做范围查询的那一列。列顺序要按查询来排，不是按字母。</figcaption>
</figure>

列顺序的经验法则：

- **等值列放最前**，它们彼此之间的顺序无所谓。
- **然后是范围或排序列**——`ORDER BY` 和 `>`/`<` 不能同时利用它右侧的列来排序。
- **最后是你只想取回的列**，如果你想做覆盖索引。

```sql
-- 一个看板按租户和状态过滤，再按时间倒排
SELECT * FROM events
WHERE tenant_id = 42 AND status = 'open'
ORDER BY created_at DESC
LIMIT 20;

-- 等值、等值、然后是排序列
CREATE INDEX idx_events_tenant_status_created
  ON events (tenant_id, status, created_at DESC);
```

把 `status` 和 `created_at` 调换，排序就又得在内存里做了。列顺序不是好看不好看的问题。

## 覆盖索引：当索引本身就是查询

如果一个索引包含了查询需要的所有列，引擎就能只靠索引回答，完全跳过表——这就是「仅索引扫描」（index-only scan）。在 Postgres 里通常做法是：索引键保持精简，用 `INCLUDE` 把额外列挂上去，它们存放在叶子里、不影响排序顺序。

```sql
CREATE INDEX idx_orders_customer_covering
  ON orders (customer_id) INCLUDE (total, created_at);

EXPLAIN ANALYZE
SELECT total, created_at FROM orders WHERE customer_id = 42;
-- 吃到好处的标志是出现 "Index Only Scan"
```

两个注意点。仅索引扫描依赖可见性映射（visibility map），所以一张最近没被 vacuum 的表仍然会碰堆——就是计划里那个 "Heap Fetches" 数字。而且每个额外的 `INCLUDE` 列都意味着更多磁盘和更多写入成本。覆盖那条热查询，而不是所有查询。

## 查询计划器什么时候无视你的索引

索引建好了，计划里还是 `Seq Scan`。通常是下面之一：

- **对列用了函数或表达式。** `WHERE date(created_at) = '2026-01-01'` 用不上 `created_at` 上的索引，因为计划器得对每一行求值这个函数。改写成范围（`created_at >= '2026-01-01' AND created_at < '2026-01-02'`），或建一个表达式索引：`CREATE INDEX ON events (date(created_at))`。
- **类型不匹配导致强制转换。** 把列和一个不同类型的值比较，可能转的是*列*而不是字面量（`WHERE created_at::date = ...`，或拿 `text` 和另一个类型的值比较），这跟函数一样会废掉索引。
- **选择性太低。** boolean 上的索引，或在大多数行都相同的 `status` 上的索引，对一条命中大半张表的查询很少有帮助。顺序扫描才是更便宜的计划，而计划器是对的。
- **统计信息过期。** 计划器靠 `pg_statistic` 里的行数估计来决策。一次批量导入之后，直到 autovacuum 或手动 `ANALYZE orders;` 追上之前，这些统计都是错的——而基于过期统计做出的计划可能错得离谱。

注意这个规律：四条里有三条是关于*查询或统计*的，不是关于索引的。再加一个索引修不好「列上套了函数」这件事。

## 读懂 EXPLAIN 与 EXPLAIN ANALYZE 的基础

`EXPLAIN` 显示计划器*打算*执行什么。`EXPLAIN ANALYZE` 会真正执行查询，并附上真实耗时和行数。对于玩具查询以外的东西，永远加上 `BUFFERS`，并在副本上、或在一个可以回滚的事务里跑，因为 `ANALYZE` 是真跑。

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders
WHERE customer_id = 42 AND status = 'paid'
ORDER BY created_at DESC
LIMIT 20;
```

你不需要读懂每个算子。看四件事就够：

- **大表上的扫描类型。** 大表上的 `Seq Scan` 是第一个要解释的。`Index Scan` / `Index Only Scan` 通常才是你想要的。
- **估计行数 vs 实际行数。** 整份计划里最有用的信号。如果计划器估了 10 行、实际拿到 100,000 行，它是*故意*选错了策略，而解药是 `ANALYZE`，不是再来一个索引。
- **`Buffers` 和 `Heap Fetches`。** 它们告诉你这个计划真的碰了多少 I/O，与缓存热不热无关。
- **每个节点的 `actual time`，以及循环次数。** 一个跑 50,000 次、每次 0.01 ms 的嵌套循环，也是半秒钟。

技巧很窄：找出估计与实际差距最大的那个节点、以及最贵的那个节点，把它修好。然后重读计划，确认数字确实动了。

## 反复出现的几种模式

现实中的索引需求大多就是几种形状。`WHERE x AND y ORDER BY z` 是经典：等值列放前面，然后是排序列，就像上面 `events` 那个例子。还有两种会不停出现。

**外键。** Postgres *不会*自动在引用侧建索引。删除或更新父行时，引擎要找出所有子行，而子表的外键列上如果没有索引，那就是一次全表扫描——而且是在锁里做的。每一个你真的会去查询或删除的 `*_id` 外键，都给它建索引。

```sql
-- 外键的子表侧：快速 join 和级联检查都需要它
CREATE INDEX idx_order_items_order_id ON order_items (order_id);
```

**部分索引。** 当一条查询只关心表里的一小片——比如一个任务队列只轮询 `status = 'pending'`——那就只索引那一片。索引很小、维护更便宜，形状却完全正确。

```sql
CREATE INDEX idx_jobs_pending ON jobs (run_at)
  WHERE status = 'pending';
```

## 一个方法：先找到那条慢查询

别从表出发，从真正慢的那条查询出发，而且要是有测量的。在 Postgres 里，`pg_stat_statements` 给你这个。按**总**时间排，不要按平均时间——一条 20 ms 但跑了一百万次的查询，比一条 2 s 只跑一次的更重要。

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

然后是这套循环：取排第一的查询，对它跑 `EXPLAIN (ANALYZE, BUFFERS)`，找出昂贵的节点或估计与实际的差距，设计一个匹配谓词与排序的索引，重跑 `EXPLAIN`，确认计划变了*并且*耗时降了。最后检查你刚加上去的写入成本，如果这个索引不值，就把它删掉。

这就是全部纪律：度量查询、把索引塑造成查询的样子、用计划验证、并留意索引在写入端的代价。在 SQLite（`EXPLAIN QUERY PLAN`）和 MySQL（`EXPLAIN`）里是同一回事，而且都从同一个问题开始——不是「我该加什么索引」，而是「我的查询到底在做什么」。索引只有在数据还在、还能服务的时候才有价值，所以它和[备份方案](/zh/posts/postgres-backups/)要一起考虑。如果你用的是 SQLite，规则一模一样——看[《SQLite 就够了》](/zh/posts/sqlite-is-enough/)了解这些取舍在单文件里落点如何。
