---
title: "Postgres 索引类型：B-tree、GIN、GiST、BRIN 与 hash（附真实执行计划）"
description: "在一张 200 万行的表上实操 Postgres 的五种索引：B-tree、GIN、GiST、BRIN 与 hash 各自适合什么、什么时候选它们是错的、真实的 EXPLAIN (ANALYZE, BUFFERS) 计划、真实的索引体积，以及 CREATE INDEX CONCURRENTLY、INCLUDE、部分索引与表达式索引怎么用。"
pubDate: 2026-12-24
lang: zh
translationKey: postgres-index-types
tags: [devops, linux]
featured: false
keywords:
  - Postgres 索引类型
  - GIN vs GiST
  - BRIN 索引
  - CREATE INDEX CONCURRENTLY
  - B-tree
---

**Postgres 索引类型**不是可以随便互换的：选错一个，你要么损失速度，要么浪费磁盘——有时两者都损失。所有人学会在 B-tree 上 `CREATE INDEX` 之后就停下来了。然后一条 `jsonb` 包含查询扫了 50 万行，一张巨大的时序表上挂着一个没人需要的 40 GB B-tree，一个 `WHERE token = ?` 查询背后是一个比它保护的数据还大两倍的索引。这一篇是实用的地图：B-tree、GIN、GiST、BRIN 与 hash 各自*为了什么*而存在、计划器什么时候会选它们、什么时候选它们是错的，以及体积和速度到底怎么权衡。下面每一份计划和每一个体积都是真实的——我在一个用完即弃的 Postgres 16 容器里建了一张 200 万行的 `events` 表，输出全部原样粘贴。如果你想先补基础，去看[数据库索引基础](/zh/posts/database-indexing/)；想学怎么读计划本身，去看[读懂 EXPLAIN ANALYZE](/zh/posts/postgres-explain/)。

## 五种索引类型，以及各自为了什么

索引类型是由你 `WHERE` 子句里的*那个操作符*决定的，而不是由表决定的。等值与排序要 B-tree；包含要 GIN；重叠要 GiST；极大且物理有序要 BRIN；只做等值、追求最小体积要 hash。

<figure>
<svg viewBox="0 0 640 230" width="100%" role="img" aria-label="决策图：根据 WHERE 子句里的操作符选择 Postgres 索引类型。B-tree 是等值、范围与 ORDER BY 的默认选择；GIN 用于 @> 与 tsquery 的包含；GiST 用于范围与几何的 && 重叠；BRIN 用于列与插入顺序一致的超大表；hash 仅用于等值。">
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
    <text x="320" y="30" text-anchor="middle" fill="currentColor">WHERE 子句在做什么？</text>
    <text x="66"  y="122" text-anchor="middle" fill="#0f766e" font-weight="600">B-tree</text>
    <text x="66"  y="142" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">默认</text>
    <text x="66"  y="160" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">= &lt; &gt; BETWEEN</text>
    <text x="66"  y="178" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">ORDER BY</text>
    <text x="190" y="122" text-anchor="middle" fill="currentColor" font-weight="600">GIN</text>
    <text x="190" y="142" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">包含</text>
    <text x="190" y="160" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">@&gt;  ?  tsquery</text>
    <text x="190" y="178" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">jsonb、数组</text>
    <text x="314" y="122" text-anchor="middle" fill="currentColor" font-weight="600">GiST</text>
    <text x="314" y="142" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">重叠</text>
    <text x="314" y="160" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">&amp;&amp;  @&gt;</text>
    <text x="314" y="178" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">范围、几何</text>
    <text x="438" y="122" text-anchor="middle" fill="currentColor" font-weight="600">BRIN</text>
    <text x="438" y="142" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">超大表</text>
    <text x="438" y="160" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">列与插入</text>
    <text x="438" y="178" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">顺序一致</text>
    <text x="562" y="122" text-anchor="middle" fill="currentColor" font-weight="600">hash</text>
    <text x="562" y="142" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">仅等值</text>
    <text x="562" y="160" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">体积</text>
    <text x="562" y="178" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.85">最小</text>
  </g>
</svg>
<figcaption>按操作符选索引类型，而不是按表选。B-tree 是默认；只有当谓词是包含、重叠，或需要对超大且有序的表做范围扫描时，才去用其他类型。</figcaption>
</figure>

| 类型 | 最适合 | 加速的操作符 | 本表体积（200 万行） |
|---|---|---|---|
| **B-tree** | 等值、范围、`ORDER BY`、`IN` | `=`、`<`、`>`、`BETWEEN`、`LIKE 'x%'` | 14–43 MB |
| **GIN** | `jsonb`、数组、全文的包含 | `@>`、`?`、`@@`（tsquery）、数组的 `&&` | 4.8 MB / 154 MB |
| **GiST** | 范围、几何、最近邻 | 范围上的 `&&`、`@>`、`<@`、`=` | 79 MB |
| **BRIN** | 超大表、物理有序的列 | `=`、`<`、`>`、`BETWEEN`（粗粒度） | **32 kB** |
| **hash** | 仅等值、追求最小体积 | `=` | 64 MB |

## B-tree：默认选择，通常也是正确答案

B-tree 把键保持有序，因此同一个结构能同时服务等值、范围和排序。测试表里有一个 `user_id` 列，并带一个覆盖它的索引：

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

200 万行里的 40 行，读 43 个块，1 毫秒找到。同一个索引还能顺手处理排序——计划里不会出现 Sort 节点：

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

`Index Scan Backward` 就是 B-tree 反向走它的键——`ORDER BY ... DESC LIMIT 10` 根本没有排序，取到十行就停了。这就是 B-tree 之所以是默认的原因：它同时做等值、范围和排序，而且还能被做成覆盖索引、部分索引或表达式索引。

## GIN：`jsonb`、数组与全文的包含

GIN 把你的数据倒排：每个键或数组元素都指向包含它的那些行。这正是 `jsonb @>`、`?`、`tsquery @@` 和数组 `@>` 需要的。对 jsonb 键做高选择性的包含，是它最亮眼的地方：

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

一行，2.6 毫秒，12 个块。但一旦谓词不再有选择性，GIN 就*是错的*。同一个索引换成一个常见键，反而比不用它还慢：

```sql
-- 使用 GIN 索引
SELECT count(*) FROM events WHERE payload @> '{"plan": "team"}'  -- 470 ms，69,310 buffers
-- 同一谓词，关掉索引扫描：纯顺序扫描
SELECT count(*) FROM events WHERE payload @> '{"plan": "team"}'  -- 291 ms，约 69,000 buffers
```

GIN 计划花了 470 毫秒去读一个 154 MB 的索引再加堆表；顺序扫描只按顺序读一遍堆表，291 毫秒就做完了同样的活。计划器的估算（`rows=202020`，实际 50 万）差得足够大，以至于它选了更慢的计划。GIN 大约在选择性低于 1–2% 时才划算；再高，顺序扫描就赢，而这个索引纯粹是写入开销。数组列上的 GIN 有一模一样的悬崖——`tags @> ARRAY['violet','wholesale']` 命中 6.7% 的行，跑了 441 毫秒，而顺序扫描只要 293 毫秒。为高选择性的查询建 GIN，而不是因为某列是 `jsonb` 就建。

## GIN vs GiST：范围、几何与重叠

**GIN vs GiST** 是人们最容易搞错的问题。GIN 读得快、写得慢；GiST 更均衡，还能回答最近邻和重叠查询。对范围类型来说，`&&`（重叠）和 `@>`（包含）是 GiST 的主场：

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

1 万行，17 毫秒。经验法则：如果操作符是包含（`@>`、`?`、`@@`），优先 GIN；如果是重叠或距离（`&&`、`<->`），优先 GiST。GIN 不支持范围上的 `&&`；GiST 做全文不如 GIN。两者都足够“有损”，所以计划几乎总会先读一个堆块位图再回表复查。

## BRIN 索引：本身就有序的超大表

BRIN 索引对每个块范围（默认 128 个页面）只存该范围内列的最小值和最大值。对于物理顺序与逻辑顺序一致的列，这点摘要就足以跳过几乎所有数据——而且这个索引几乎不占地方。这里的 `created_at` 列与插入顺序完全相关：

```
 attname    | correlation
------------+-------------
 created_at |           1
 user_id    | 0.016
```

同一列、同一条查询、一天的数据，B-tree 与 BRIN 对比：

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

BRIN 索引是 **32 kB 对 43 MB——大约小 1300 倍**——而且它只读了 9 个索引页，而不是 239 个。B-tree 在耗时上仍然赢，因为它做的是*仅索引*扫描，根本没碰堆表。一旦你要求返回 B-tree 里没带的列，堆表就成了两者的主要开销：

```
-- B-tree：索引扫描 + 堆表        Buffers: shared hit=2981 read=239   Execution Time: 47.469 ms
-- BRIN：  位图 + 堆表            Buffers: shared hit=3081            Execution Time: 41.067 ms
```

现在 BRIN 相当甚至更快，而且小了上千倍。这就是权衡：BRIN 适合追加型、按时间范围查询的表——日志、指标、事件——这类场景下索引必须极小。它在无序的列上*是错的*（`user_id`，相关性 0.016）：每个块范围都横跨整个取值域，所以计划器会正确地忽略它。伸手拿 BRIN 之前先看 `pg_stats.correlation`；如果接近零，就用 B-tree。

## hash 索引：只做等值，体积最小

hash 索引只存每个键的 32 位哈希，所以它只能回答 `=`，别的都不行——不能范围、不能排序、不能仅索引扫描。从 Postgres 10 起它有了 WAL 日志、崩溃安全，所以不再是个玩具。在这张表上，session token 的 hash 索引是 64 MB，而 B-tree 是 113 MB：

```sql
-- 用 B-tree
SELECT id FROM events WHERE session_token = 'tok_' || md5('1999999');
 Index Scan using idx_events_session_bt on events  (actual time=1.059..1.062 rows=1)   Buffers: shared hit=1 read=4
-- 用 hash 索引
 Index Scan using idx_events_session_hash on events (actual time=0.041..0.042 rows=1)  Buffers: shared hit=3
```

同样的计划形状，同样的一行，磁盘少一半。只有当某列*永远*只用 `=` 比较、表很大、而你想要更小的索引时，才选 hash。否则 B-tree 只多占一点空间，还白送你范围查询。

## 体积 vs 速度：200 万行的真实代价

一张表，十五个索引，索引字节数超过了堆表本身：

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
 idx_events_refunded      | btree |  11 MB   (部分索引：status = 'refunded')
 idx_events_tags_gin      | gin   | 4.8 MB
 idx_events_created_brin  | brin  |  32 kB
```

539 MB 的堆表配了 735 MB 的索引。GIN 和 GiST 是贵的那两个——它们每行要存很多条目——而 BRIN 基本免费。这些字节里的每一个，在每次 `INSERT` 和 `UPDATE` 时也都要维护。

## `CREATE INDEX CONCURRENTLY`、`INCLUDE`、部分索引与表达式索引

普通的 `CREATE INDEX` 会取一把在整个构建期间阻塞写入的锁。`CREATE INDEX CONCURRENTLY` 不会——它取的是 `ShareUpdateExclusiveLock`，读写都能继续。你可以实时看到：当并发构建在 200 万行的表上运行时，`pg_locks` 里只有：

```
           mode           | granted | relname
--------------------------+---------+---------
 ShareUpdateExclusiveLock | t       | events
```

没有 `AccessExclusiveLock`，所以插入一直在流动。代价是时间——它要扫两遍表，并等待事务——而且它不能在事务块里运行：

```
CREATE INDEX CONCURRENTLY idx_events_browser_con ON events ((payload ->> 'browser'));
CREATE INDEX
Time: 3389.759 ms
```

`INCLUDE` 让 B-tree 变成覆盖索引：把过滤列放进键里，把要返回的列放进载荷，计划就变成无回表的仅索引扫描：

```sql
CREATE INDEX idx_events_user_incl ON events (user_id) INCLUDE (status, total);
EXPLAIN (ANALYZE, BUFFERS) SELECT status, total FROM events WHERE user_id = 41234;
```

```
 Index Only Scan using idx_events_user_incl on events  (cost=0.43..5.13 rows=40 width=12) (actual time=0.042..0.055 rows=40 loops=1)
   Index Cond: (user_id = 41234)
   Heap Fetches: 0
```

**部分索引**只索引一个切片——比如那个只轮询 `status = 'pending'` 的队列，或者这里只索引退款行（11 MB，而不是 43 MB）：

```sql
CREATE INDEX idx_events_refunded ON events (created_at) WHERE status = 'refunded';
SELECT count(*) FROM events WHERE status = 'refunded' AND created_at >= '2024-01-14';
```

```
   ->  Parallel Index Only Scan using idx_events_refunded on events  (actual time=0.518..31.324 rows=73067 loops=3)
         Index Cond: (created_at >= '2024-01-14 00:00:00+00'::timestamp with time zone)
         Heap Fetches: 0                                    Execution Time: 47.855 ms
```

**表达式索引**让你能索引一个计算值——`lower(email)`、一次类型转换，或一次 `jsonb` 提取——然后像普通键一样查询它：

```sql
CREATE INDEX idx_events_orderref_expr ON events ((payload ->> 'order_ref'));
EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM events WHERE (payload ->> 'order_ref') = 'ord_1999999';
```

```
 Index Scan using idx_events_orderref_expr on events  (cost=0.43..8.45 rows=1 width=8) (actual time=0.748..0.750 rows=1 loops=1)
   Index Cond: ((payload ->> 'order_ref'::text) = 'ord_1999999'::text)
```

谓词必须与索引表达式完全一致，否则计划器不会用它。

## 怎么检查计划器到底做了什么

`EXPLAIN (ANALYZE, BUFFERS)` 是事实来源，而 `pg_stat_user_indexes` 会告诉你哪些索引是死重量：

```
       indexrelname       | idx_scan |  size
--------------------------+----------+---------
 idx_events_created_brin  |        3 | 32 kB
 idx_events_refunded      |        3 | 11 MB
 idx_events_payload_gin   |        2 | 154 MB
 idx_events_session_hash  |        0 | 64 MB
 idx_events_created_bt    |        0 | 43 MB
```

`idx_scan = 0` 而体积又是几百 MB 的索引，就是该删的候选——它在白白消耗你的写入。想要机器可读的计划，`EXPLAIN (FORMAT JSON)` 会把同一棵树返回成 JSON，脚本可以遍历它；而构建被中断后想找出坏索引：

```sql
SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relkind = 'i' AND NOT i.indisvalid;
```

`CREATE INDEX CONCURRENTLY` 如果中途失败，可能留下一个无效索引；它会被计划器忽略，必须删掉重建。

## 记住这些

类型跟着操作符走：等值、范围与排序用 B-tree；`jsonb`、数组与全文的包含用 GIN；范围与几何重叠用 GiST；超大且插入有序的表用 BRIN；仅等值用 hash。体积跟着类型走：BRIN 几乎免费，GIN 和 GiST 很贵，一张表很容易索引字节比数据还多。唯一能确认你选对了的办法就是读计划——建好索引，跑 `EXPLAIN (ANALYZE, BUFFERS)`，确认节点和 buffers 变了。这个习惯，再加上用 `pg_stat_user_indexes` 退役那些没人用的索引，就是全部功课。
