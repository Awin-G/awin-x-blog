---
title: "Postgres vacuum 与表膨胀：为什么你的表比该有的大 10 倍"
description: "用真实输出讲清 Postgres vacuum：我在一次性 Postgres 17 里制造出真实的表膨胀，调了 autovacuum 阈值，看着 VACUUM 把 dead tuples 标记为可复用、VACUUM FULL 把文件真正缩小，并用 pg_stat_user_tables 和 pgstattuple 检查了 wraparound 与 bloat。"
pubDate: 2026-12-16
lang: zh
translationKey: postgres-vacuum
tags: [devops, linux]
featured: false
keywords:
  - Postgres vacuum
  - 表膨胀
  - autovacuum
  - VACUUM FULL
  - dead tuples
---

我在容器里起了一个一次性的 Postgres 17，建了一张一百万行的 `orders` 表，然后对它做了生产环境会做的事：反复折腾它。下面所有内容都是从那次会话直接粘出来的，不是凭记忆还原的。先看最扎眼的数字：经过足够的 `UPDATE` 和一次批量 `DELETE` 之后，堆文件涨到了 **1389 MB，而实际存活的行只有 790,605 行**——这几乎是同样这些行执行 `VACUUM FULL` 后所占 **139 MB 的整整 10 倍**。数据没问题，是表膨胀了。这篇讲的就是实践中的 **Postgres vacuum**：**MVCC** 与 **dead tuples**（死元组）、**VACUUM** 和 **VACUUM FULL** 到底各做了什么、**autovacuum** 如何决定何时运行，以及两件会让它永远追不上进度的事。

整套环境，原样如下：

```sql
docker run --rm -d --name pgvac -e POSTGRES_PASSWORD=x \
  -p 127.0.0.1:55440:5432 postgres:17
docker exec pgvac psql -U postgres -Atc 'select version();'
-- PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2) on x86_64-pc-linux-gnu, compiled by gcc 14.2.0, 64-bit
```

## Postgres vacuum 为什么存在：MVCC、dead tuples 与空间去哪了

Postgres 用的是 **MVCC**（多版本并发控制）：写操作永远不会原地覆盖一行。一次 `UPDATE` 会写出该行的*新版本*，把旧版本留在磁盘上；一次 `DELETE` 只是把该行标记为死。这正是读操作能在不阻塞写操作的前提下保持稳定快照的原因。代价就是：这些旧版本必须待在某处，直到没有任何运行中的事务还能看到它们。这些残留就是 **dead tuples**。

死元组不是免费的。它仍然占着堆页里的槽位，所以一张被频繁更新的表会在存活行数不变的情况下不断变大。最终，旧版本变得对*任何人*都不可见，此时 **vacuum** 才能回收它们：把它们的空间标记为可复用，之后的新插入就能落到那里。

在对着统计计数器惊慌之前，有个细节值得先搞清楚。如果一次 `UPDATE` 没有改动任何被索引的列，Postgres 可以做 **HOT 更新**：新版本落在同一页上，旧槽位只用一个行指针标记为死。页级的 pruning（修剪）会在后续访问时惰性地回收这块空间，不需要完整 vacuum。实际后果是：`pg_stat_user_tables.n_dead_tup`（一个估算值）和 `pgstattuple` 报告的物理死字节数可能相差极大——而且一张被反复折腾的表可能主要是*空闲空间*，而不是死元组。这两者都是膨胀。

<figure>
<svg viewBox="0 0 720 300" width="100%" role="img" aria-label="反复折腾后的堆文件里，存活元组与死元组混在一起。VACUUM 把死元组的空间标记为可复用，但文件大小不变；VACUUM FULL 把表重写成一个新的紧凑文件，并把空间还给操作系统。">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <text x="24" y="20" font-weight="600" font-size="14">折腾之后 —— 存活与死元组混在同一堆里</text>
    <text x="24" y="137" font-weight="600" font-size="14">VACUUM 之后 —— 空间可复用，文件大小不变</text>
    <text x="24" y="243" font-weight="600" font-size="14">VACUUM FULL 之后 —— 重写为紧凑布局</text>
  </g>
  <!-- legend -->
  <g font-family="system-ui, sans-serif" font-size="11.5" fill="currentColor">
    <rect x="470" y="8" width="22" height="12" rx="3" fill="currentColor" opacity="0.75"/>
    <text x="498" y="18">存活元组</text>
    <rect x="586" y="8" width="22" height="12" rx="3" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="614" y="18" fill="#0f766e">死元组</text>
  </g>
  <!-- row 1: live + dead mixed -->
  <g>
    <rect x="30" y="28" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="114" y="28" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="150" y="44" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
    <rect x="198" y="28" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="282" y="28" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="318" y="44" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
    <rect x="366" y="28" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="402" y="44" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
    <rect x="450" y="28" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="534" y="28" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="570" y="44" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
    <rect x="618" y="28" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="30" y="56" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="66" y="72" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
    <rect x="114" y="56" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="198" y="56" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="234" y="72" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
    <rect x="282" y="56" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="318" y="72" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
    <rect x="366" y="56" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="450" y="56" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="486" y="72" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
    <rect x="534" y="56" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="618" y="56" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="654" y="72" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
  </g>
  <!-- arrow 1 -->
  <line x1="360" y1="88" x2="360" y2="112" stroke="currentColor" stroke-width="1.5"/>
  <polygon points="360,118 355,108 365,108" fill="currentColor"/>
  <text x="372" y="106" font-family="system-ui, sans-serif" font-size="12" fill="currentColor">VACUUM —— 标记死空间可复用，不重写</text>
  <!-- row 2: dead -> free -->
  <g>
    <rect x="30" y="156" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="114" y="156" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
    <rect x="198" y="156" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="282" y="156" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
    <rect x="366" y="156" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
    <rect x="450" y="156" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="534" y="156" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
    <rect x="618" y="156" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="30" y="184" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
    <rect x="114" y="184" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="198" y="184" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
    <rect x="282" y="184" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
    <rect x="366" y="184" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="450" y="184" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
    <rect x="534" y="184" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="618" y="184" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  </g>
  <text x="24" y="226" font-family="system-ui, sans-serif" font-size="11.5" fill="#0f766e">磁盘上仍是 1389 MB —— 其中 89.7% 已是空闲空间</text>
  <!-- arrow 2 -->
  <line x1="360" y1="236" x2="360" y2="258" stroke="currentColor" stroke-width="1.5"/>
  <polygon points="360,264 355,254 365,254" fill="currentColor"/>
  <text x="372" y="252" font-family="system-ui, sans-serif" font-size="12" fill="currentColor">VACUUM FULL —— 重写，把空间还给操作系统</text>
  <!-- row 3: packed -->
  <g>
    <rect x="30" y="270" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="114" y="270" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="198" y="270" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="282" y="270" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="366" y="270" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
  </g>
  <text x="450" y="285" font-family="system-ui, sans-serif" font-size="11.5" fill="#0f766e">139 MB</text>
</svg>
<figcaption>MVCC 把旧行版本留作 dead tuples。VACUUM 原地把这些空间标记为可复用，所以文件通常大小不变——我这张表有 89.7% 是空闲空间。VACUUM FULL 把整张表重写进一个新文件，是两者中唯一真正把磁盘还给操作系统的那个。</figcaption>
</figure>

## VACUUM vs VACUUM FULL：标记可复用 vs 重写

**`VACUUM`** 扫描整张表，找出已无任何事务可见的死元组，把它们的空间标记为可供未来的行复用。它还会更新 visibility map（让 index-only scan 更便宜）、清理索引里的死条目、并截断*尾部*已经完全空的页——但只限文件末尾的那些页。它取的是 `ShareUpdateExclusive` 锁，不会阻塞普通的读或写。这就是 autovacuum 跑的那种 vacuum，也是你应该一直在跑的那种。

**`VACUUM FULL`** 做的完全是另一件事：它把整张表重写进一个全新文件，只复制存活的行，然后交换文件、丢掉旧文件。这是把磁盘交还给操作系统的唯一方式。代价是整个重写期间持有一把 `ACCESS EXCLUSIVE` 锁，阻塞*所有*读写，另外还需要足够放得下第二份表的空闲磁盘。

下面是真实折腾对我这张表做的事。先看新鲜干净的状态——100 万行，174 MB：

```sql
INSERT INTO orders SELECT g, g%10000,
       (ARRAY['pending','paid','shipped','refunded'])[1 + g%4],
       (g%1000)::numeric/10, repeat('x', 120)
FROM generate_series(1, 1000000) g;
VACUUM ANALYZE orders;

--  total  |  heap
-- 195 MB  | 174 MB     → 每行约 174 字节，没有膨胀
```

然后我关掉这张表的 autovacuum，好让膨胀可预测地堆积起来，再用反复的全表 `UPDATE` 加一次批量 `DELETE` 折腾它：

```sql
ALTER TABLE orders SET (autovacuum_enabled = false);
UPDATE orders SET total = total + 1;   -- 反复执行
DELETE FROM orders WHERE customer_id % 5 = 0;

SELECT relname, n_live_tup, n_dead_tup,
       pg_size_pretty(pg_relation_size(relid)) AS heap
FROM pg_stat_user_tables WHERE relname = 'orders';

--  relname | n_live_tup | n_dead_tup |  heap
--  orders  |     790605 |    7199682 | 1389 MB
```

估算的死元组有 720 万，堆文件是 80 万行真正所需空间的十倍。`pgstattuple` 告诉你空间究竟落在哪里——注意那个巨大的空闲空间数字，就是我前面提到的 HOT 空间：

```sql
CREATE EXTENSION IF NOT EXISTS pgstattuple;
SELECT table_len, tuple_count, dead_tuple_count,
       pg_size_pretty(dead_tuple_len) AS dead_bytes,
       pg_size_pretty(free_space)     AS free_bytes, free_percent
FROM pgstattuple('orders');

--  table_len | tuple_count | dead_tuple_count | dead_bytes | free_bytes | free_percent
--  1389 MB   |      800000 |           800072 |     133 MB |    1085 MB |        78.12
```

现在跑普通的 `VACUUM`。盯住两行：它移除了死元组，而它移除的页数正好是零：

```sql
VACUUM (VERBOSE) orders;

-- INFO:  finished vacuuming "postgres.public.orders": index scans: 1
-- pages: 0 removed, 177769 remain, 177769 scanned (100.00% of total)
-- tuples: 800072 removed, 800000 remain, 0 are dead but not yet removable
-- index scan needed: 159992 pages ... had 7199511 dead item identifiers removed

SELECT pg_size_pretty(pg_relation_size('orders')) AS heap_after_plain_vacuum;
--  1389 MB
```

这就是本节的全部要点，用一个数字说清：`VACUUM` 回收了 **7,199,511 个死索引条目和 800,072 个死元组**，而文件**仍然不多不少是 1389 MB**，只是 `free_percent = 89.73` 了。它把空间变成可复用，但没有压缩表。只有 `VACUUM FULL` 做到了：

```sql
VACUUM FULL orders;   -- Time: 7617.521 ms (00:07.618)

SELECT pg_size_pretty(pg_relation_size('orders'))      AS heap,
       pg_size_pretty(pg_total_relation_size('orders')) AS total;
--  heap    | total
--  139 MB  | 156 MB
```

七秒的排他锁，把 1389 MB 变成了 139 MB。这就是为什么 `VACUUM FULL` 是维护窗口里的工具，而不是可以每小时排一次的修复手段。（如果你想搞清楚这样一张表上的*执行计划*为什么会走偏，那是另一个话题——见 [Postgres EXPLAIN](/zh/posts/postgres-explain/)。）

## autovacuum：阈值、系数，以及如何为一台偏重数据库的小机器调优

autovacuum 是一组后台 worker，它们会逐表判断：「自上次以来死掉的行够不够多，值不值得跑一趟？」这个判断是「阈值 + 表的一个比例」：

```
当 dead_tuples > autovacuum_vacuum_threshold
                + autovacuum_vacuum_scale_factor × n_live_tup 时触发 vacuum
```

Postgres 17 的默认值看着人畜无害，直到你在一张大表上算一遍：

```sql
SHOW autovacuum_naptime;                 -- 1min
SHOW autovacuum_vacuum_threshold;        -- 50
SHOW autovacuum_vacuum_scale_factor;     -- 0.2
SHOW autovacuum_vacuum_insert_threshold; -- 1000
SHOW autovacuum_vacuum_insert_scale_factor; -- 0.2
SHOW autovacuum_max_workers;             -- 3
```

`scale_factor` 为 `0.2` 意味着 autovacuum 会等到**整张表 20% 都是死的**才来看一眼。在一张一亿行的表上，那就是清理还没开始前就已有两千万行死元组——这正是表会变成应有大小 10 倍的原因。为了看它真的触发，我建了一张 20 万行的 `events` 表，把每一行更新了三次，再算出它自己的阈值：

```sql
SELECT relname, n_live_tup, n_dead_tup,
       current_setting('autovacuum_vacuum_threshold')::int
         + (current_setting('autovacuum_vacuum_scale_factor')::numeric
            * n_live_tup)::int AS dead_threshold
FROM pg_stat_user_tables WHERE relname = 'events';

--  relname | n_live_tup | n_dead_tup | dead_threshold
--  events  |     321088 |     400000 |          64268
```

40 万死元组对上 64,268 的阈值：远远超标，worker 跑了。几秒后：

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, autovacuum_count
FROM pg_stat_user_tables WHERE relname = 'events';

--  relname | n_live_tup | n_dead_tup |        last_autovacuum        | autovacuum_count
--  events  |     300000 |          0 | 2026-10-12 09:51:52.698117+00 |                3
```

对于一个**小型、偏重数据库的工作负载**——一台机器上一个繁忙的库——为庞大机群调出来的默认值通常都是错的。把比例系数调低，并为每张表设置现实的阈值，让 vacuum 以小而频繁的切片运行，而不是一次巨大的全表扫描：

```sql
ALTER TABLE orders SET (
  autovacuum_vacuum_scale_factor = 0.02,   -- 死掉 2% 就动手，而不是 20%
  autovacuum_vacuum_threshold    = 1000,
  autovacuum_vacuum_cost_limit   = 1000    -- 让 worker 睡前多做点活
);

SELECT relname, reloptions FROM pg_class WHERE relname = 'orders';
--  orders | {autovacuum_vacuum_scale_factor=0.02,autovacuum_vacuum_threshold=1000,autovacuum_vacuum_cost_limit=1000}
```

经验法则：在小机器上，把热表的 `autovacuum_vacuum_scale_factor` 降到 `0.01–0.05`；调高 `autovacuum_vacuum_cost_limit`（和/或调低 `autovacuum_vacuum_cost_delay`），让 worker 真的能跑完；如果有许多繁忙的表在彼此后面排队，就把 `autovacuum_max_workers` 调高。

## 监控表膨胀：pg_stat_user_tables、pgstattuple 和那条 size 查询

你不需要一套监控栈才能看见膨胀；你需要的是一条查询和一个你记得住的比例。每行占用的字节数就是那个信号：

```sql
SELECT relname,
       pg_size_pretty(pg_relation_size(relid)) AS size,
       n_live_tup,
       pg_size_pretty((pg_relation_size(relid) / greatest(n_live_tup,1))::bigint)
         AS bytes_per_live_row
FROM pg_stat_user_tables
ORDER BY pg_relation_size(relid) DESC LIMIT 5;

--  relname |  size   | n_live_tup | bytes_per_live_row
--  orders  | 1389 MB |     790605 | 1841 bytes
--  events  |  195 MB |     300000 |  682 bytes
--  ledger  |   14 MB |      50000 |  298 bytes
```

每存活行 1841 字节，对上同样这些行新鲜时所需的 174 字节，就是你那 10 倍——浓缩在一列里。`pg_stat_user_tables` 给你 `n_live_tup`、`n_dead_tup`、`last_autovacuum` 和 `autovacuum_count`；把元组计数器当作估算值，别当圣旨。想要物理真相时，`pgstattuple` 会扫描整张关系并精确报告 `dead_tuple_len` 和 `free_space`（就是上面那段 JSON 格式的输出）。对一次长时间运行的 vacuum，`pg_stat_progress_vacuum` 会显示它的推进：

```sql
SELECT phase, heap_blks_scanned AS scanned, heap_blks_total AS total,
       num_dead_item_ids AS dead_ids, indexes_processed || '/' || indexes_total AS indexes
FROM pg_stat_progress_vacuum;

--     phase     | scanned | total | dead_ids | indexes
--  scanning heap |      28 | 53334 |     1260 | 0/0
--  scanning heap |     353 | 53334 |    15885 | 0/0
--  scanning heap |     658 | 53334 |    29610 | 0/0
```

## 事务 ID 回卷（wraparound）：绝不能发生的那种故障

每个事务都会拿到一个 32 位 ID，而它们总共只有约 40 亿个。Postgres 用模运算来比较 ID，所以如果某个数据库让它的 ID 计数器一路绕了整整一圈，旧行看起来就会像*来自未来*，服务器宁可拒绝启动也不会损坏数据。硬上限是 2³¹ ≈ 21 亿个事务。安全阀是**冻结（freezing）**：vacuum 把旧行标记为永久可见，这才让 ID 计数器能安全地向前推进。

这就是为什么 `age(datfrozenxid)` 是一个你该当作油量表来盯的数字。在我的全新集群上它很小，但这条查询值得一直留着：

```sql
SELECT datname,
       age(datfrozenxid) AS xid_age,
       current_setting('autovacuum_freeze_max_age')::bigint AS freeze_max_age,
       2147483648 - age(datfrozenxid) AS xids_until_wraparound
FROM pg_database WHERE datname = 'postgres';

--  datname  | xid_age | freeze_max_age | xids_until_wraparound
--  postgres |      39 |      200000000 |            2147483589
```

`autovacuum_freeze_max_age`（默认 200,000,000）是 Postgres 强制触发一次 vacuum 来冻结行的那条线，即便膨胀很低也会触发，而且这次 vacuum **无法用普通手段取消**。如果 `age(datfrozenxid)` 正朝 2 亿爬升，说明有张表根本没在被 vacuum。延迟才是危险所在：在繁忙的系统上，「没事」和「为避免 wraparound 数据丢失而拒绝执行命令」之间的余量会缩得很快。

## 长事务会阻塞 vacuum

这是最容易被错过的一块。vacuum 只有在**没有任何活跃快照还能看到**一个死元组之后，才能回收它。单个一直开着的事务——一个 idle-in-transaction 的会话、一个被遗忘的 `BEGIN`、一条很长的分析查询——会钉住最老的快照，vacuum 就必须把它之后的全部元组原样留下。我开了一个 `REPEATABLE READ` 事务，然后从另一个会话删掉半张表并 vacuum 它：

```sql
-- 会话 A（一直开着）
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM ledger;
SELECT pg_sleep(45); COMMIT;

-- 会话 B
SELECT pid, state, now() - xact_start AS xact_age
FROM pg_stat_activity
WHERE datname = 'postgres' AND xact_start IS NOT NULL AND pid <> pg_backend_pid();
--  pid | state  |    xact_age     | query
--  206 | active | 00:00:03.121582 | BEGIN ISOLATION LEVEL REPEATABLE READ; ...

DELETE FROM ledger WHERE id % 2 = 0;   -- DELETE 50000
VACUUM (VERBOSE) ledger;

-- INFO:  finished vacuuming "postgres.public.ledger": index scans: 0
-- pages: 0 removed, 1819 remain, 1819 scanned (100.00% of total)
-- tuples: 0 removed, 100000 remain, 50000 are dead but not yet removable
```

`50000 are dead but not yet removable`——vacuum 什么都没做，因为会话 A 的快照仍然能看到那些行。膨胀堆了起来，而且会一直堆下去，直到那个事务结束。解药不是某个 vacuum 设置，而是 `idle_in_transaction_session_timeout`，以及不把事务长时间开着的自律。锁和长事务往往一起出现，所以这一节和 [Postgres 锁](/zh/posts/postgres-locks/) 是配套的。

## 一份实用的 Postgres vacuum 检查清单

- **摸清基线。** 在你最大的几张表上跑那条「每存活行字节数」查询；一旦超过新行宽度的约 2–3 倍，就是值得查的膨胀。
- **看时钟，不只看计数。** 在每天都有变动的表上，`last_autovacuum` 应该是近期的。繁忙表上一个空白或陈旧的 `last_autovacuum` 才是真正的警报。
- **逐表调优，为小机器而调。** `autovacuum_vacuum_scale_factor = 0.02`、调高的 `autovacuum_vacuum_cost_limit`，加上够用的 `autovacuum_max_workers`，胜过任何全局默认值。
- **先找阻塞者再调参。** 查那些 `xact_start` 很久远的会话；一个被遗忘的开放事务能让所有阈值失效。设置 `idle_in_transaction_session_timeout`。
- **盯住 wraparound 余量。** 追踪 `age(datfrozenxid)`，一旦它稳定地朝 `autovacuum_freeze_max_age` 爬升，就当作紧急事项处理。
- **外科手术式地用 `VACUUM FULL`。** 它取 `ACCESS EXCLUSIVE` 锁，还需要一份表的磁盘空间——所以在窗口期跑、只对该跑的那一张表跑；如果承受不起这把锁，优先用 `pg_repack`。
- **让普通 `VACUUM` 干日常的活。** 它是唯一你能一直跑的形式，而在调好的 autovacuum 之下，你很少需要别的。

这些都不算稀奇，它就是 MVCC 的日常代价。但它很容易被忘记，因为在一张表涨到天然大小的十倍、或者事务 ID 计数器快没地方之前，什么都不会坏。去测量、把阈值调低、干掉长事务，`VACUUM` 就会安静地让你的表保持诚实。
