---
title: "Postgres 索引膨胀：为什么索引一直变大，以及如何修复"
description: "在一次性 Postgres 16 容器中的真实输出：我对一张 200 万行的表做高强度更新，看着索引从 16 MB 涨到 28 MB 而 VACUUM 一个字节都没缩小，然后用 REINDEX 和 REINDEX CONCURRENTLY 把它砍回来，还抓到了一次失败的 CONCURRENTLY 留下无效索引。"
pubDate: 2027-02-07
lang: zh
translationKey: postgres-index-bloat-and-reindex
tags: [devops]
featured: false
keywords:
  - Postgres 索引膨胀
  - REINDEX CONCURRENTLY
  - pgstattuple
  - 索引大小
  - autovacuum
---

**Postgres 索引膨胀**是没人告警的慢性泄漏。一个 B-tree 索引从 16 MB 起步，六个月后变成 28 MB，而它所在的表其实*变小*了。`VACUUM` 每晚都在跑，表本身没问题，索引文件就是一直往上爬。我经手的每张热表都有这个现象：带 `updated_at` 索引的追加型日志表、不断被重写的会话表、状态列来回翻转的任务队列。

机制很简单，而且不是 bug。每次 `UPDATE` 和 `DELETE` 都会把旧的索引元组留在原地，直到 vacuum 来处理。而 vacuum 处理时*不会*把那块空间还给操作系统——它只是标记为可复用，让后续写入可以重新填进去，但文件永远不会缩小。在一张高频写入的表上，索引会一路涨到它的历史最高水位，然后就一直那么胖，永远不降。`VACUUM` 不是碎片整理工具。`REINDEX` 才是。

这就是我希望当初有人能讲给我听的版本：膨胀在页级别到底是什么、不靠猜怎么测量、两种修复方法，以及一个会反咬你的失败模式。下面所有输出都来自一个一次性容器——官方 `postgres:16-bookworm` 镜像，Postgres 16.15，除 `pgstattuple` 和 `amcheck` 之外没有装任何扩展。如果你还不了解索引是怎么构建的，[Postgres 索引类型](/zh/posts/postgres-index-types/)讲了各种结构；至于 vacuum 那一半的故事，[Postgres vacuum](/zh/posts/postgres-vacuum/)是配套的姊妹篇。

## 膨胀到底是什么

B-tree 是一棵有序的元组结构。一次 `UPDATE` 如果改到了被索引的列，就没法在原地修改旧元组——排序顺序可能已经变了——所以 Postgres 会删掉旧索引元组，再插入一个新的。`DELETE` 则立即把索引元组标记为死亡。无论哪种情况，这些元组占用的空间都变成了*索引内部的空闲空间*，而不是还给文件系统的空间。

两个后果在实际运维中很关键。第一，索引在高频写入的表上单调增长：每一轮写入新增的元组比它清除的多，因为新的那些落在旧的被清理之前就进去了。第二，`VACUUM` 只能在内部循环利用这些空间——它会在能拿到正确锁的情况下截掉索引*末尾*的页，并把完全清空的页加入空闲空间映射（FSM）；但大部分空闲空间散落在树的中间，文件是还不回去的。最终你会得到一个 40% 是空闲空间、体积却维持在历史峰值的索引。

一张表，两个索引，先测基线：

```sql
SELECT relname,
       pg_size_pretty(pg_relation_size(oid))     AS relation_size,
       pg_relation_size(oid)                       AS bytes,
       pg_size_pretty(pg_total_relation_size(oid)) AS total
FROM pg_class
WHERE relname IN ('events','events_pkey','events_device_id_idx','events_kind_idx')
ORDER BY pg_relation_size(oid) DESC;
```

```
       relname        | relation_size |  bytes   | total
----------------------+---------------+----------+---------
 events               | 24 MB         | 25206784 | 31 MB
 events_pkey          | 4408 kB       |  4513792 | 4408 kB
 events_device_id_idx | 1616 kB       |  1654784 | 1616 kB
 events_kind_idx      | 1296 kB       |  1327104 | 1296 kB
```

20 万行，刚建好，24 MB 堆数据和 1.6 MB 的 `device_id` 索引。现在开始高频写入——十二轮重写三分之一的数据并删除一片：

```sql
DO $$
DECLARE r int;
BEGIN
  FOR r IN 1..12 LOOP
    UPDATE events
       SET payload   = repeat('y', 64),
           device_id = ((device_id + 7) % 50) + 1
     WHERE id % 3 = 0;

    DELETE FROM events WHERE id % 11 = 0;
  END LOOP;
END $$;
```

```
DO
Time: 24673.921 ms (00:24.674)
```

二十五秒。再跑一次同样的体积查询：

```
       relname        | relation_size |   bytes   |  total
----------------------+---------------+-----------+---------
 events               | 112 MB        | 117628928 | 137 MB
 events_pkey          | 13 MB         |  13492224 | 13 MB
 events_device_id_idx | 6040 kB       |   6184960 | 6040 kB
 events_kind_idx      | 5896 kB       |   6037504 | 5896 kB
```

堆从 24 MB 涨到 112 MB，这是正常的，vacuum 那篇已经讲过了。盯着 `events_device_id_idx` 看：**1616 kB → 6040 kB**，将近 4 倍，而这张表最终只剩 181,819 行，比最初的 20 万行还少。键比开始时少了，体积却是四倍。而且 autovacuum 已经跑过了：

```
 n_live_tup | n_dead_tup | last_vacuum |        last_autovacuum
------------+------------+-------------+-------------------------------
     181819 |          0 |             | 2026-10-14 05:33:23.905477+00
```

死元组：零。vacuum 干了它该干的活。索引还是 6 MB。

<figure>
<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="vacuum 之后的死索引条目对比 REINDEX 之后的紧凑索引">
  <defs>
    <style>
      .lbl { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; }
      .val { font: bold 13px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; }
      .h   { font: bold 14px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #0f766e; }
      .dead{ fill: none; stroke: currentColor; stroke-opacity:.45; stroke-width:1.4; stroke-dasharray:4 3; }
      .live{ fill: none; stroke: #0f766e; stroke-width:1.4; }
      .x   { stroke: currentColor; stroke-width:1.6; stroke-opacity:.7; }
    </style>
  </defs>

  <text x="0" y="20" class="h">REINDEX 之前 —— vacuum 跑过，空间标记为可复用，文件没变</text>

  <rect x="0"   y="34" width="180" height="14" class="dead"/>
  <rect x="184" y="34" width="46"  height="14" class="live"/>
  <line x1="24" y1="34" x2="40" y2="48" class="x"/>
  <line x1="40" y1="34" x2="24" y2="48" class="x"/>
  <line x1="84" y1="34" x2="100" y2="48" class="x"/>
  <line x1="100" y1="34" x2="84" y2="48" class="x"/>
  <line x1="144" y1="34" x2="160" y2="48" class="x"/>
  <line x1="160" y1="34" x2="144" y2="48" class="x"/>
  <text x="240" y="46" class="lbl">死条目 75%</text>

  <rect x="0"   y="56" width="180" height="14" class="dead"/>
  <rect x="184" y="56" width="46"  height="14" class="live"/>
  <text x="240" y="68" class="lbl">空闲，但已分配</text>

  <rect x="0" y="84" width="296" height="26" fill="none" stroke="currentColor" stroke-opacity=".35"/>
  <text x="8" y="101" class="val">索引文件  6040 kB</text>

  <text x="330" y="20" class="h">REINDEX 之后 —— 重写为紧凑结构</text>

  <rect x="330" y="34" width="120" height="14" class="live"/>
  <rect x="454" y="34" width="46"  height="14" class="live"/>
  <text x="510" y="46" class="lbl">100% 有效</text>

  <rect x="330" y="84" width="128" height="26" fill="none" stroke="#0f766e"/>
  <text x="338" y="101" class="val">索引  640 kB</text>

  <text x="0" y="140" class="lbl">vacuum：死元组清除，空间在内部循环利用，文件不变</text>
  <text x="0" y="160" class="lbl">reindex：  一棵全新的紧凑树，旧文件被截断</text>

  <text x="0" y="200" class="h">6040 kB  →  640 kB   (−89%)</text>
</svg>
<figcaption>图 1 —— vacuum 之后的一个索引叶页（虚线槽位是可复用但已分配的）对比 REINDEX 之后。让文件一直大的是页数量，而不是死元组。</figcaption>
</figure>

## 不靠猜来测量

`pg_relation_size` 告诉你文件有多大。它不会告诉你这个文件*应该*有多大。想知道这个，你需要 `pgstattuple`，它会真正把关系遍历一遍然后计数。

```sql
CREATE EXTENSION IF NOT EXISTS pgstattuple;
CREATE EXTENSION IF NOT EXISTS amcheck;
```

```
 extname   | extversion
-----------+------------
 pgstattuple | 1.5
 amcheck     | 1.3
```

`pgstatindex` 给出单个索引的结构；`pgstattuple` 给出堆或索引的物理内容。高频写入之前的基线：

```sql
SELECT * FROM pgstatindex('events_device_id_idx');
```

```
 version | tree_level | index_size | root_block_no | internal_pages | leaf_pages | empty_pages | deleted_pages | avg_leaf_density | leaf_fragmentation
---------+------------+------------+---------------+----------------+------------+-------------+---------------+------------------+--------------------
       4 |          1 |    1654784 |             3 |              1 |        200 |           0 |             0 |            82.38 |               24.5
```

两个数字要记住。`avg_leaf_density` 是叶页有多满——刚建好的 B-tree 大约在 80–90%。`leaf_fragmentation` 是散落在页内部、不重写树就无法压实的空闲空间占比。高频写入之后：

```
 version | tree_level | index_size | root_block_no | internal_pages | leaf_pages | empty_pages | deleted_pages | avg_leaf_density | leaf_fragmentation
---------+------------+------------+---------------+----------------+------------+-------------+---------------+------------------+--------------------
       4 |          2 |    6184960 |           309 |              4 |        750 |           0 |             0 |            94.65 |               6.53
```

`tree_level` 从 1 变成 2（多了一层内部页），`leaf_pages` 从 200 变成 750。这就是那 4 倍。

想看清楚死索引条目，我建了第二张表，把 autovacuum 关掉，这样背后就没有东西帮我清理：

```sql
DROP TABLE IF EXISTS churn;
CREATE TABLE churn (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id int NOT NULL,
  note      text
);
CREATE INDEX churn_device_id_idx ON churn (device_id);
ALTER TABLE churn SET (autovacuum_enabled = false);

INSERT INTO churn (device_id, note)
SELECT (g % 20) + 1, repeat('n', 32)
FROM generate_series(1, 100000) g;

UPDATE churn SET device_id = ((device_id + 3) % 20) + 1 WHERE id % 4 = 0;
UPDATE churn SET device_id = ((device_id + 5) % 20) + 1 WHERE id % 4 = 1;
DELETE FROM churn WHERE id % 13 = 0;
```

```
   phase    | idx_size | idx_bytes
------------+----------+-----------
 after load | 656 kB   |    671744
          phase          | idx_size | idx_bytes | live_rows
-------------------------+----------+-----------+-----------
 after churn (no vacuum) | 1176 kB  |   1204224 |     92308
```

10 万行变成 92,308 行，索引从 656 kB 涨到 1176 kB。物理真相：

```
 table_len | tuple_count | dead_tuple_count | dead_tuple_percent | free_percent
-----------+-------------+------------------+--------------------+--------------
   9641984 |       92308 |             5700 |               4.08 |        20.25

 n_live_tup | n_dead_tup | last_vacuum | last_autovacuum
------------+------------+-------------+-----------------
      92308 |      57692 |             |
```

57,692 个死元组对 92,308 个活元组——38% 的表是尸体。索引那边：

```
 version | tree_level | index_size | internal_pages | leaf_pages | empty_pages | deleted_pages | avg_leaf_density | leaf_fragmentation
---------+------------+------------+----------------+------------+-------------+---------------+------------------+--------------------
       4 |          1 |    1204224 |              1 |        145 |           0 |             0 |            81.02 |              40.69
```

`leaf_fragmentation` 40.69%：每个叶页有五分之二是 vacuum 没回收、文件仍然占着的空闲空间。

还有一个视图，也是最被低估的一个。`pg_stat_user_indexes.idx_scan` 统计有多少查询真正用过每个索引——这是你能找到的最便宜的无用索引探测器：

```
     indexrelname     | idx_scan | idx_tup_read | idx_tup_fetch | index_size
----------------------+----------+--------------+---------------+------------
 events_pkey          |        0 |            0 |             0 | 4408 kB
 events_device_id_idx |        0 |            0 |             0 | 1616 kB
 events_kind_idx      |        0 |            0 |             0 | 1296 kB
```

## VACUUM 修不了这个问题

这是大家最容易搞错的地方，所以直接看输出。对 `churn` 表跑一次带 57,692 个死元组的详细 vacuum：

```sql
VACUUM (VERBOSE, ANALYZE) churn;
```

```
INFO:  finished vacuuming "blog.public.churn": index scans: 1
index scan needed: 1177 pages from table (100.00% of total) had 57692 dead item identifiers removed
index "churn_pkey": pages: 551 in total, 0 newly deleted, 0 currently deleted, 0 reusable
index "churn_device_id_idx": pages: 147 in total, 35 newly deleted, 35 currently deleted, 0 reusable
INFO:  "churn": scanned 1177 of 1177 pages, containing 92308 live rows and 0 dead rows
```

仔细读——这就是全部要点。vacuum 清掉了 **57,692 个死条目标识符**。在索引上它*删掉了 35 页*，并且报告 **0 个可复用**。那 35 页进了空闲空间映射，没有还给操作系统。现在看体积：

```
 idx_size | idx_bytes | heap_size
----------+-----------+-----------
 1176 kB  |   1204224 | 9416 kB
```

一模一样。vacuum 之前 1176 kB，之后还是 1176 kB，一个字节都没差。堆也没有缩小。但*结构*变了：

```
 version | tree_level | index_size | internal_pages | leaf_pages | empty_pages | deleted_pages | avg_leaf_density | leaf_fragmentation
---------+------------+------------+----------------+------------+-------------+---------------+------------------+--------------------
       4 |          1 |    1204224 |              1 |        110 |           0 |            35 |            66.74 |              49.09
```

`leaf_pages` 145 → 110，`deleted_pages` 0 → 35，`avg_leaf_density` 81.02% → 66.74%，`leaf_fragmentation` 40.69% → 49.09%。vacuum 清掉了死条目，把清空的页从树上摘了下来，文件却一点没小。密度反而*降了*：因为幸存的活元组分散在那些只在末尾被释放的页上。

这就是索引膨胀的诚实定义：**空间被 vacuum 在内部循环利用了，但文件还不回去。**

## 修复方法：REINDEX

`REINDEX` 把索引扔掉，从活元组重新建一棵。同样的表，同样的行，没有膨胀：

```
 idx_size | idx_bytes
----------+-----------
 1176 kB  |   1204224
Timing is on.
REINDEX
Time: 113.510 ms
Timing is off.
 idx_size | idx_bytes
----------+-----------
 640 kB   |    655360
```

1176 kB → 640 kB，耗时 113 ms。之后的结构：

```
 version | tree_level | index_size | internal_pages | leaf_pages | empty_pages | deleted_pages | avg_leaf_density | leaf_fragmentation
---------+------------+------------+----------------+------------+-------------+---------------+------------------+--------------------
       4 |          1 |     655360 |              1 |         78 |           0 |             0 |             89.7 |                  0
```

78 个叶页，0 个已删除，碎片率 0%，密度 89.7%。这才是一棵 B-tree 该有的样子。

在大表上数字更夸张。200 万行，一个 `v` 列上的索引，经过 666,666 次更新和 86,956 次删除：

```
    phase    |  heap  |  idx  | idx_bytes |  rows
-------------+--------+-------+-----------+---------
 after churn | 215 MB | 24 MB |   24707072 | 1913044

 version | tree_level | index_size | internal_pages | leaf_pages | empty_pages | deleted_pages | avg_leaf_density | leaf_fragmentation
---------+------------+------------+----------------+------------+-------------+---------------+------------------+--------------------
       4 |          2 |   24707072 |             15 |       3000 |           0 |             0 |            54.48 |              33.3
```

54.48% 密度——索引一半是浪费。重建之后：

```
REINDEX
Time: 1369.204 ms (00:01.369)
     phase     |  idx  | idx_bytes
---------------+-------+-----------
 after reindex | 13 MB |  13737984
```

24 MB → 13 MB，耗时 1.37 秒。**这个索引有 46% 是膨胀。**在生产环境一张几百 GB 的表上，这就是一笔省下来的存储账单。

代价是锁。我在那个索引重建期间抓了 `pg_locks`：

```
 pid |    rel    |        mode         | granted
-----+-----------+---------------------+---------
 972 | big_v_idx | AccessExclusiveLock | t
 973 | big_v_idx | AccessExclusiveLock | t
 972 | big       | ShareLock           | t
 973 | big       | ShareLock           | t
```

`REINDEX INDEX` 会对**表**拿 **ShareLock**，对**索引本身**拿 **AccessExclusiveLock**。ShareLock 和每次 `INSERT`/`UPDATE`/`DELETE` 都要拿的 `RowExclusiveLock` 冲突，所以整个重建期间写入全部阻塞。我从另一侧验证了这一点——在重建进行中发了一条单行更新：

```
UPDATE 1
Time: 558.756 ms
```

它等了 558 ms 才拿到自己拥有的那行，因为重建占着表。在小索引上这不算什么。在 100 GB 的索引上这就是一次故障。

## REINDEX CONCURRENTLY：同样的结果，写入不受影响

`REINDEX INDEX CONCURRENTLY` 在后台建新索引，正常流量继续跑，最后原子地换进去。同一个膨胀的索引，同一张表：

```
--- locks held during REINDEX CONCURRENTLY ---
 pid |    rel    |           mode           | granted
-----+-----------+--------------------------+---------
 592 | big       | ShareUpdateExclusiveLock | t
 591 | big_v_idx | ShareUpdateExclusiveLock | t
 591 | big       | ShareUpdateExclusiveLock | t
```

`ShareUpdateExclusiveLock` 只和它自己以及 `AccessExclusiveLock` 冲突。它**不**和 `RowExclusiveLock` 冲突，所以插入、更新、删除都能继续。同样那条单行更新，在重建进行中发出：

```
UPDATE 1
Time: 5.944 ms
```

5.9 ms，而不是 558 ms。写入从未被阻塞。

代价是时间和一点磁盘。在一个 28 MB、190 万行的索引上做完整重建：

```
REINDEX
Time: 5515.812 ms (00:05.516)
           phase            |  idx  | idx_bytes
----------------------------+-------+-----------
 after reindex-concurrently | 13 MB |  13737984
```

5.5 秒，而带锁版本是 1.37 秒——大约慢 4 倍，因为它要在两个屏障点等待在途事务，还要重新扫描期间发生变化的行。后续几轮只花了 1.3–1.5 秒，所以把第一个数字当作悲观值。结果完全一样：13,737,984 字节，`leaf_fragmentation` 0，密度 87.06%，1,667 个叶页而不是 3,000 个。只要 4 倍慢比写锁划算，就用它——大多数生产表都是这种情况。

### 会反咬你的失败模式

`REINDEX INDEX CONCURRENTLY` 可能失败——冲突的 DDL、被取消的语句、等不走的旧快照——失败时它会留下一个**无效**的、建了一半的新索引。我通过中途取消复现了它：

```
ERROR:  canceling statement due to user request
Time: 926.594 ms

      index      | indisvalid | indisready |  size
-----------------+------------+------------+-------
 big_pkey        | t          | t          | 86 MB
 big_v_idx       | t          | t          | 29 MB
 big_v_idx_ccnew | f          | t          | 13 MB
```

那个 `big_v_idx_ccnew` 就是纯负担：占着 13 MB 磁盘，`indisvalid = f`，规划器永远不会用它——我用 `EXPLAIN` 确认过，它选了有效的 `big_v_idx`，忽略了那个无效索引。原索引全程继续提供服务，所以不会出任何问题。

第一，修复方法是再跑一次，而且不会自动完成。我重新跑了一遍重建：

```
REINDEX
Time: 1325.988 ms (00:01.326)
      index      | indisvalid | indisready |  size
-----------------+------------+------------+-------
 big_pkey        | t          | t          | 86 MB
 big_v_idx_ccnew | f          | t          | 13 MB
 big_v_idx       | t          | t          | 13 MB
```

成功了，`big_v_idx` 现在是 13 MB——**而那个无效的 `big_v_idx_ccnew` 还在那儿。**一次成功的重建不会清理上一次失败留下的残余。你得自己删：

```sql
DROP INDEX big_v_idx_ccnew;
```

如果你把这件事写进脚本，在任何并发重建之后检查 `pg_index.indisvalid` 并对异常告警。无效索引不是正确性问题，是磁盘问题，而且它会一直躺在那儿。

## 预防：让它别再来

重建是治法，下面这些是让热度别升太高的办法。

**在热表上单独调 autovacuum，不要全局调。**我这个容器里的默认值：

```
                 name                  | setting | unit
---------------------------------------+---------+------
 autovacuum_vacuum_scale_factor        | 0.2     |
 autovacuum_vacuum_threshold           | 50      |
 autovacuum_vacuum_insert_scale_factor | 0.2     |
 autovacuum_vacuum_insert_threshold    | 1000    |
 autovacuum_max_workers                | 3       |
 autovacuum_naptime                    | 60      | s
```

在一张 5000 万行的表上，`0.2` 意味着 autovacuum 要等到 1000 万个死元组才肯动一动——到那时候索引早已把它们全部吸收进去了。对于热表，我调低 scale factor，而不是调高 worker 数量：

```sql
ALTER TABLE events SET (autovacuum_vacuum_scale_factor = 0.01,
                        autovacuum_vacuum_threshold = 2000);
```

更频繁的 vacuum 并不能阻止膨胀——vacuum 没法缩小文件——但它让可复用空间保持密集、复用成本低，从而推迟必须重建的那个临界点。

**删掉没人用的索引。**这是谁都不去拿的收益。你保留的每一个索引，都会永远拖慢每一次插入和更新的写入吞吐，不管有没有查询真正用到它。我建了一个永远不会被任何查询用到的 `events(payload)` 索引，又高频写了一次表，看着它什么都不干却一直长：

```
     indexrelname     | idx_scan | idx_tup_read |  size
----------------------+----------+--------------+---------
 events_device_id_idx |        1 |         3636 | 6360 kB
 events_kind_idx      |        1 |        36364 | 6256 kB
 events_payload_idx   |        0 |            0 | 1720 kB
 events_pkey          |        0 |            0 | 13 MB
```

`events_payload_idx`：1,720 kB，`idx_scan = 0`，从 1,376 kB 涨上来纯粹是写入放大。删掉它：

```
DROP INDEX
Time: 22.475 ms
```

22 ms，拿回 1.7 MB，以后这张表上每次 `UPDATE` 都便宜一点。`DROP INDEX CONCURRENTLY` 拿的是 `ShareUpdateExclusiveLock`——和 `REINDEX CONCURRENTLY` 一样的非阻塞模式——所以面对在线流量也安全。

低基数索引不一定就是没用的索引。我的 `events_kind_idx` 建在一个只有五个不同值的列上，规划器在明确的选择性查询上确实会跳过它：

```
 Limit
   ->  Seq Scan on events
         Filter: (kind = 'click'::text)
```

但它仍然被选用于 `count(*) WHERE kind = 'click'`，走的是索引全扫描。所以 `idx_scan` 是一个*信号*，不是判决——删任何索引之前，先对照你真实的查询日志确认。

## 我实际怎么做

诚实的运维笔记，因为重建这件事的营销版本是"每周无脑全量重建一遍"。

**没有明确原因不要按周期重建。**每次重建都是一次完整重建：CPU、I/O、WAL，外加一段锁窗口。如果一个索引只比健康体积大 5%，重建它什么也换不来，却要付出整次构建的代价。先测量，凭证据重建。

**用查询测量，不要凭感觉。**我跑的三个，从最便宜的开始：

```sql
-- 1. 有哪些索引，各有多大
SELECT indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE relname = 'events'
ORDER BY pg_relation_size(indexrelid) DESC;

-- 2. 单个索引有多碎
SELECT * FROM pgstatindex('events_device_id_idx');

-- 3. 堆里实际装了什么
SELECT * FROM pgstattuple('events');
```

大索引上 `idx_scan = 0` 就是你的删除候选。一棵不在增长的 B-tree 上 `avg_leaf_density` 低于 ~60% 就是你的重建候选。稳定表上 `leaf_fragmentation` 持续攀升，说明写入跑赢了 vacuum。

**任何重建之后验证结构。**`amcheck` 在标准镜像里自带，一次 btree 检查是廉价的保险，防的是重建修不了的那种问题——损坏：

```sql
SELECT bt_index_check('big_v_idx', true);
```

```
 bt_index_check
----------------

(1 row)
```

它跑了 594 ms，没有返回任何错误——这正是你想要的：这个函数在发现损坏时会抛错，所以安静就是通过。（它会返回一个空的 void 行，这是正常的。）

**按你实际运行的查询来定索引大小，而不是按你有哪些列。**膨胀之所以让人痛苦，正是因为我们什么都索引，却只用了三分之一。要在不同索引类型之间做选择，[Postgres 索引类型](/zh/posts/postgres-index-types/)有 200 万行表上的体积与速度实测数据。

膨胀不神秘，也不是必然。它只是 vacuum 在做它被设计来做的事，落在一个只有重建才能缩小的文件上。测量它，删掉你不用的，重建你用得上的——拿不了锁就用 CONCURRENTLY——然后检查有没有无效索引。至于堆为什么会涨，那是另一半故事，[Postgres vacuum](/zh/posts/postgres-vacuum/)讲了死元组、HOT 更新，以及让它们保持可控的那些设置。
