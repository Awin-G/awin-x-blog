---
title: "Postgres 分区复现：什么时候真管用，什么时候只是表演"
description: "用一个用完即弃的 Postgres 16 容器，把一张 300 万行的表与它的声明式分区孪生表并排跑：真实的 EXPLAIN 计划展示分区裁剪、每个分区一份索引的现实、手动按月建分区、ATTACH 与 DETACH，以及为什么用丢弃分区做保留策略远胜 DELETE。"
pubDate: 2026-12-15
lang: zh
translationKey: postgres-partitioning
tags: [devops, linux]
featured: false
keywords:
  - Postgres 分区
  - 声明式分区
  - 分区裁剪
  - 表分区
  - DETACH
---

**Postgres 分区**常被当成大表的万能药，但有一半时候它只是表演：你贴上分区键，查询照旧扫全表，结果只是造出了一张更复杂的表。我想弄清楚这条界线究竟在哪，于是开了一个用完即弃的 Postgres 16 容器，建了一张 300 万行的表，又建了一张数据完全相同的**声明式分区**孪生表，对两者跑一模一样的查询。下面每一份计划、每一个行数、每一个耗时都是原样粘贴的；想先补词汇，去看[读懂 Postgres 的 EXPLAIN ANALYZE](/zh/posts/postgres-explain/)，索引理论看[数据库索引基础](/zh/posts/database-indexing/)。一句话结论：**声明式分区**在按时间做保留、以及查询能命中分区键时值回票价，其余场景纯属开销。

## 声明式分区到底做了什么

分区表是一个**自身不存任何数据**的虚父表——我实测 `pg_total_relation_size('events')` 就是 `0 bytes`。它持有一条路由规则和一组子表。运行时有三个动作：

- **路由。** 每条 `INSERT` 被送到键值范围匹配的那个分区。父表从不存行。
- **分区裁剪。** 计划器在生成计划之前检查 `WHERE`，丢掉所有不可能匹配的分区。这是全部分区的意义所在。
- **每个分区一份索引。** 在父表上 `CREATE INDEX` 会级联，在**每个分区上各建一份物理索引**。分区表上并不存在一个跨分区的全局索引。

父对象基本上只是一个名字、一种分区策略和一份子表目录：

```sql
CREATE TABLE events (
  id bigserial,
  tenant_id int NOT NULL,
  kind text NOT NULL,
  amount numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL
) PARTITION BY RANGE (created_at);
```

这是 PG10+ 的现代机制。它**不是**老式的表继承把戏（`CHECK` 约束加触发器路由）——声明式分区把路由和裁剪推给了执行器，所以既没有触发器要写，也没有 `constraint_exclusion` 要调。

## RANGE、LIST、HASH 一分钟讲完

- **RANGE** —— 每个分区覆盖一段连续区间，比如每个孩子一个月。时间戳的自然选择。
- **LIST** —— 每个分区一个显式取值集合，比如按区域或按租户等级各分一个。
- **HASH** —— 对键取模哈希，把行均匀摊到固定数量的分区上，没有天然顺序。适合摊负载，对保留策略毫无用处。

我用 RANGE，因为最有意思的行为（裁剪和丢旧数据）都在那里。

## 搭建：一张分区表，六个月度分区

手动按月建分区，每个三行——不需要 `pg_partman`：

```sql
CREATE TABLE events_2026_03 PARTITION OF events
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE events_2026_04 PARTITION OF events
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
-- ...每个月一张，2026-01 到 2026-06
```

我往两张表里装了**同一批** 300 万行生成数据，并在两者上都对 `(tenant_id, created_at)` 和 `created_at` 建了索引。在分区父表上，`CREATE INDEX ON events (tenant_id, created_at)` 产出了父表一个索引**加上六个物理索引**——每个分区一份：

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

`\d+ events` 显示父表有六个分区，自身没有行：

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
<svg viewBox="0 0 680 360" width="100%" role="img" aria-label="分区父表把每一行路由到一个月度 RANGE 分区。限定到三月的查询被裁剪为只读三月这一个分区，其余五个从不被打开。">
  <g font-family="system-ui, sans-serif" fill="currentColor">
    <text x="340" y="24" text-anchor="middle" font-weight="600" font-size="14">一个父表，六个月度分区，只读一个分区</text>
  </g>
  <!-- parent -->
  <rect x="200" y="42" width="280" height="44" rx="7" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="340" y="62" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12">events</text>
  <text x="340" y="78" text-anchor="middle" font-size="10" opacity="0.8">PARTITION BY RANGE (created_at) · 0 字节</text>
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
  <!-- partitions -->
  <g font-family="system-ui, sans-serif" font-size="11" text-anchor="middle">
    <rect x="16"  y="150" width="96" height="48" rx="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <text x="64"  y="172">2026-01</text><text x="64" y="188" font-size="9" opacity="0.75">513,810 行</text>
    <rect x="124" y="150" width="96" height="48" rx="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <text x="172" y="172">2026-02</text><text x="172" y="188" font-size="9" opacity="0.75">464,090 行</text>
    <rect x="232" y="150" width="96" height="48" rx="6" fill="none" stroke="#0f766e" stroke-width="2.2"/>
    <text x="280" y="172" font-weight="600">2026-03</text><text x="280" y="188" font-size="9" fill="#0f766e">513,812 行</text>
    <rect x="340" y="150" width="96" height="48" rx="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <text x="388" y="172">2026-04</text><text x="388" y="188" font-size="9" opacity="0.75">497,238 行</text>
    <rect x="448" y="150" width="96" height="48" rx="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <text x="496" y="172">2026-05</text><text x="496" y="188" font-size="9" opacity="0.75">513,812 行</text>
    <rect x="556" y="150" width="96" height="48" rx="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <text x="604" y="172">2026-06</text><text x="604" y="188" font-size="9" opacity="0.75">497,238 行</text>
  </g>
  <g font-size="10" fill="currentColor" opacity="0.85">
    <text x="280" y="222" text-anchor="middle" fill="#0f766e" font-family="ui-monospace, monospace">WHERE created_at &gt;= '2026-03-01' AND &lt; '2026-04-01'</text>
  </g>
  <g font-size="12" fill="currentColor">
    <text x="340" y="292" text-anchor="middle">裁剪在计划阶段就把另外五个分区丢掉。</text>
    <text x="340" y="316" text-anchor="middle" opacity="0.8">它们从不被打开、从不被扫描、从不从磁盘读取。</text>
    <text x="340" y="340" text-anchor="middle" font-weight="600">273 毫秒 对 未分区孪生表的 2165 毫秒。</text>
  </g>
</svg>
<figcaption>父表不存任何东西；行都住在月度孩子里。限定到三月的查询被裁剪成只读一个分区，于是全表六分之五根本不会被碰到。</figcaption>
</figure>

## 在真实计划里抓到分区裁剪

同一张表，同样 300 万行，只取一个月的数据。这是分区查询：

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

计划里只有一个关系：`events_2026_03`。没有 `Append`，没有其他分区，没有被过滤掉的功。`shared read=2677` 大约是整张表块数的六分之一。现在对未分区表跑完全相同的查询，列相同、`created_at` 上也有索引：

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

**273 毫秒 对 2165 毫秒**——8 倍差距，分区计划读 2677 个块，扁平表读 25798 个。两边都不是没索引；差别在于裁剪让 Postgres 连**碰都碰不到**六分之五的数据，而不只是在其中绕过去。而且裁剪是在计划阶段决定的，所以一次便宜的 `EXPLAIN`（不带 `ANALYZE`）不用真的执行就能看到：

```
->  Parallel Seq Scan on events_2026_03 events  (cost=0.00..7393.32 rows=214045 width=6)
      Filter: ((created_at >= '2026-03-01 ...') AND (created_at < '2026-04-01 ...'))
```

### 当分区键裁不掉时

裁剪只在你用 `WHERE` 约束了分区键时生效。改成按租户筛选，每个分区都可能有份——计划里长出一个 `Append`，代价是所有孩子的总和：

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

每个分区一次索引查找，六个计划分支，一条只返回 3000 行的查询花了 `Planning Time: 5.945 ms`。这份计划开销就是税：前面那条二月查询，分区表花了 10.3 毫秒规划，扁平表只花 2.9 毫秒；下面这条全表聚合光规划就花了 61.6 毫秒。

## 每个分区一份索引的现实

因为每个分区有自己的索引，被裁到单个分区的查询只用那个分区的索引。同时按租户和月份筛选，计划里只点名一个物理索引：

```
 Aggregate  (actual time=173.033..173.035 rows=1 loops=1)
   ->  Bitmap Heap Scan on events_2026_03 events  (actual time=0.376..172.380 rows=514 loops=1)
         Recheck Cond: ((tenant_id = 42) AND (created_at >= '2026-03-01 ...') AND (created_at < '2026-04-01 ...'))
         Heap Blocks: exact=514
         ->  Bitmap Index Scan on events_2026_03_tenant_id_created_at_idx
```

只出现 `events_2026_03_tenant_id_created_at_idx`。但这也意味着索引数量随分区数放大。六个月度分区让我把父表每个索引各复制了六份；按天分区一年的表会给你 365 个小索引要维护，而每次在父表上 `CREATE INDEX` 都会全部重建。单个 64 MB 分区大致长这样：

```
 分区子表                 总计    索引
------------------------  -----   -----
 events_2026_03            64 MB   15 MB
 events_2026_04            62 MB   15 MB
 events_2026_05            64 MB   15 MB
```

整张 5 分区、252 万行的表总计 312 MB；未分区孪生表索引配置相同，但在一次 `DELETE` 之后占了 409 MB。分区甚至可能**更省空间**，因为丢分区是直接释放文件，而不是留下死页。

## 表分区与保留策略：DETACH、DROP 还是 DELETE

这里分区不再是可选项。要从没分区的表里删掉最老的那个月：

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

删掉 513,810 行花了 **63 秒**——而且空间并不还给操作系统；只有 `VACUUM FULL` 或整表重写才能回收，两者都要排他锁。在分区孪生表上，保留只是两条目录操作：

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

**18 毫秒**，没有逐行操作，没有膨胀，磁盘即时回收。`DETACH` 是元数据变更，只在父表上短暂拿一把 `ACCESS EXCLUSIVE` 锁；`DROP` 直接解链文件。被摘下的表就是一张普通表，你可以先归档、导出或交给冷存储。这种不对称——63 秒的翻腾对两条快速 DDL——就是给时序表分区最硬的理由。这也是为什么保留任务应该是定时的 `DETACH`/`DROP`，并用一个**预先建好**的下月分区兜底，让插入永不失败。

## ATTACH：把一张独立表提升为分区

反向操作让你在父表之外造好分区再挂上去。我造了一张七月表，灌了 50 万行，建好索引，然后挂接：

```sql
CREATE TABLE events_2026_07 (LIKE events INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
-- 灌入七月数据，然后：
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

`ATTACH` 只花了 101 毫秒，因为索引已经存在，而且表的约束已经证明它只装着七月行。若没有那个索引，`ATTACH` 会在同一把锁下替你建——安全做法是先在独立表上建好索引，再挂接，这样锁很短。批量回填也是这个套路：在侧面加载并建索引，最后挂接。

### 唯一约束的限制

分区悄悄禁止了一件你可能依赖的事。对分区键之外列建普通唯一索引会被拒：

```sql
CREATE UNIQUE INDEX events_id_uniq ON events (id);
```

```
ERROR:  unique constraint on partitioned table must include all partitioning columns
DETAIL:  UNIQUE constraint on table "events" lacks column "created_at" which is part of the partition key.
```

Postgres 没有跨分区的全局唯一索引。只有键**包含**分区键时才能强制唯一——`UNIQUE (id, created_at)`——而这通常不是你想要的那个约束。如果你需要全局唯一的代理键，就在别处生成（序列、UUID v7，或一张单独的查找表），别指望分区表来管。

## 什么时候 Postgres 分区只是表演

- **小表。** 裁剪一张能塞进缓存的 3 GB 表省不下什么，只是多加了计划节点。几亿行以下，一个索引通常就是全部答案。
- **不筛分区键的查询。** 每条这种查询都变成对 N 个分区的 `Append`，各有各的索引、各分一份规划时间。
- **热路径上的规划开销。** 一条每秒执行上千次的查询，10 毫秒的规划是你从没预算过的真实 CPU。
- **太多太小的分区。** 一张跨多年的表按天分区意味着几百个索引、臃肿的目录和塞满 `Append` 分支的计划。分区粒度应该匹配保留粒度，而不是日历的粒度。
- **ORM / 工具盲区。** 很多 ORM 和迁移工具不建模分区表：它们发出忽略路由的 `INSERT ... RETURNING id`，指望 `ALTER TABLE` 面对单个物理表，或者生成一个父表会拒绝的唯一索引。上线前先检查你的数据层。
- **外键与跨分区连接。** 能跑，但每个连接都按分区扇出，计划器的工作更难。

## 一份决策清单

1. 表是否大到丢旧数据会疼？如果痛点是保留，就**按时间列做 RANGE 分区**，把保留做成 `DETACH`/`DROP` 任务。
2. 你最热的查询是否约束了分区键？是，裁剪就会回本。不是，就停手——分区不会让它们更快。
3. 有没有东西需要在非键列上全局唯一？有，就先在表外解决唯一性。
4. 你的 ORM 懂分区表吗？迁生产之前先验证。
5. 让分区大小匹配保留粒度：月度通常够用；只有确实按天丢数据才按天。
6. 预先建好下个分区，并保留一个 `DEFAULT` 分区兜底，让漏掉的范围永不丢插入。

上面这些都不需要 profiler 或托管服务。一个用完即弃的容器、`generate_series` 和 `EXPLAIN (ANALYZE, BUFFERS)` 就给了我计划、行数和毫秒数——而真正告诉你**表分区**是在干活还是在添乱的，是计划，不是宣传语。
