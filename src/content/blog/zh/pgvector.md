---
title: "pgvector：用 HNSW 在 Postgres 里做向量搜索，以及什么时候向量数据库是杀鸡用牛刀"
description: "Embedding 不难，难的是把它放在数据旁边。我把 10 万个向量塞进一个用完即弃的 Postgres 17（pgvector 0.8.7），实测了精确搜索、HNSW 与 IVFFlat 的最近邻搜索，调了 ef_search 和 probes，踩了后过滤的坑，并写下什么时候才真的需要专用向量数据库。"
pubDate: 2026-12-28
lang: zh
translationKey: pgvector
tags: [ai, devops]
featured: false
keywords:
  - pgvector
  - Postgres 向量搜索
  - HNSW
  - 最近邻搜索
  - embeddings
---

一说到「加个语义搜索」，默认建议就是上一套向量数据库——对一个数据本来就躺在 Postgres 里的应用来说，那意味着第二个有状态系统、一条同步管道。**pgvector** 给你已经跑着的数据库加了一个 `vector(N)` 列类型和近似最近邻索引，于是 **Postgres 里的向量搜索**顺带就有了 join、`WHERE` 过滤和事务。这是亲手做一遍的版本：**embeddings** 和 ANN 搜索是干什么用的，**HNSW** 和 IVFFlat 的真实表现，以及什么时候专用向量数据库才值得。下面每个计划和耗时都来自一个用完即弃的 `pgvector/pgvector:pg17` 容器（PostgreSQL 17.11、pgvector 0.8.7），跑在 `127.0.0.1` 上，10 万个确定性的 64 维向量。

## Embedding 和最近邻搜索到底是干什么的

Embedding 模型把一段文本、一张图片或一个用户变成定长的浮点数组——64 个或 768 个——让语义相近的东西在坐标上靠得近。**最近邻搜索**于是就是：给一个查询向量，找出向量离它最近的 *k* 行。它是一个排序原语，不是过滤条件，支撑着「更多类似」、RAG 的语义检索、去重和推荐。

精确搜索是暴力枚举：对每一行算距离再排序，每次查询 `O(N · d)`。在 10 万行 64 维上没问题；在 1000 万行 1536 维上就是每次查询好几分钟。于是我们用**近似**最近邻（ANN）索引，用一点点精度（称为 **recall**，召回率）换几个数量级的速度。

## 为什么 Postgres 里的向量搜索通常就够了

专用向量数据库的卖点是性能。对大多数应用来说，现实是 embedding 只是你本来就有的一行上的**又一列**：

- **数据本来就在 Postgres 里。** 向量就住在文档、租户 id、时间戳和权限旁边——没有第二个事实来源，没有同步任务，没有「索引怎么过期了」的 bug。
- **Join、过滤、事务都是白送的。** `WHERE tenant_id = $1 AND created_at > now() - interval '30 days' ORDER BY embedding <-> $2 LIMIT 10` 就是一次查询、一次往返。
- **运维面是你本来就在跑的那一套。** 同一份备份、监控、连接池和只读副本就覆盖了向量。跟 [数据库索引基础](/zh/posts/database-indexing/) 是同一本账：索引是拿写入成本换读取速度。
- **它能扩展到的规模比大家以为的大。** 单节点上百万级向量是常规操作。

诚实的提醒：ANN 索引是近似的，而且过滤跟它配合得很糟——下面两个都实测了。把搜索留在数据库里的更完整论证见 [Postgres 全文检索](/zh/posts/full-text-search/)。

## 实验台：一个用完即弃的 Postgres 里放 10 万个确定性向量

我没下载 embedding 模型。我用 `md5` 哈希确定性地生成向量——每个类别一个簇心加上每行的噪声——所以每个数字都能从 SQL 复现，而且明确标注为合成数据。重要的是它的形状（成簇、64 维、8 个类别、10 万行、33 MB）。

```sql
CREATE FUNCTION det_vec(seed text, dim int, scale float8 DEFAULT 1.0) RETURNS vector
LANGUAGE sql IMMUTABLE AS $$
  SELECT ('[' || string_agg(round(((('x'||substr(md5(seed||':'||i),1,8))::bit(32)::int::float8
          /2147483647.0 - 0.5) * 2 * scale)::numeric,6)::text, ',' ORDER BY i) || ']')::vector
  FROM generate_series(0, dim-1) i;
$$;

CREATE TABLE items (id int PRIMARY KEY, category text, body text, embedding vector(64));
INSERT INTO items SELECT g, cats[1+(g%8)], 'doc '||g,
       det_vec('c:'||cats[1+(g%8)],64) + det_vec('n:'||g,64,0.35)   -- 簇心 + 噪声
FROM generate_series(1,100000) g, (SELECT ARRAY['databases','networking','security','ai',
     'linux','astro','devops','embedded'] AS cats) c;
-- 100000 rows | 8 categories | 33 MB
```

## 距离运算符、归一化，以及 cosine 与 L2

pgvector 给你三个运算符：`<->`（L2/欧氏距离）、`<=>`（cosine 距离），以及 `<#>`（**负**内积，取负是为了让「越小越近」依然能正确排序）：

```sql
SELECT '[-1,0,0]'::vector <-> '[1,0,0]'::vector AS l2,        -- 2
       '[-1,0,0]'::vector <=> '[1,0,0]'::vector AS cosine,    -- 2   (1 - (-1))
       '[-1,0,0]'::vector <#> '[1,0,0]'::vector AS neg_inner; -- 1   (-(1 * -1))
```

Cosine 距离对缩放不敏感，L2 则敏感。先把向量归一化到单位长度，两者排序就完全一致，而且有精确关系：`l2_distance² = 2 · cosine_distance`。

```sql
WITH t AS (SELECT id, embedding, l2_normalize(embedding) AS e FROM items WHERE id IN (88656,37387,1))
SELECT a.id AS a, b.id AS b,
       round((a.embedding <-> b.embedding)::numeric,4) AS l2_raw,   -- 12.3826
       round((a.embedding <=> b.embedding)::numeric,4) AS cos_raw,  --  0.3598
       round((a.e <-> b.e)::numeric,4)                 AS l2_norm,  --  0.8482 = sqrt(2*0.3598)
       round((a.e <=> b.e)::numeric,4)                 AS cos_norm  --  0.3598
FROM t a, t b WHERE a.id < b.id;
```

大多数 embedding API 返回的已经是单位向量。选跟你模型训练方式匹配的运算符，并用匹配的 opclass（`vector_l2_ops`、`vector_cosine_ops`、`vector_ip_ops`）建索引——规划器只会用 opclass 与 `ORDER BY` 运算符一致的那个索引。

## 精确最近邻搜索就是一次顺序扫描

没有索引时，`ORDER BY embedding <-> q LIMIT 10` 没法提前停：Postgres 必须给每一行打分再排序。计划是一次并行顺序扫描——**热缓存 23 ms**（第一次冷启动 89 ms）：

```sql
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
SELECT id FROM items ORDER BY embedding <-> (SELECT v FROM q) LIMIT 10;

 Limit (actual rows=10 loops=1)
   ->  Gather Merge (actual rows=10 loops=1)          Workers Launched: 2
         ->  Sort (actual rows=8 loops=3)             Sort Method: top-N heapsort
               ->  Parallel Seq Scan on items (actual rows=33333 loops=3)
 Execution Time: 22.566 ms
```

在 10 万 × 64 维上这还算能忍；重点是斜率——行数翻倍，扫描就翻倍。到几百万个 768 维向量时，这就是每次查询好几秒，而且 B-tree 帮不上忙：根本没有可索引的顺序，每一行都是候选。

<figure>
<svg viewBox="0 0 680 220" width="100%" role="img" aria-label="一段文本查询被转成 embedding 向量，插入 HNSW 图索引，近似最近邻搜索按距离返回前 k 行。">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.45">
      <rect x="20" y="80" width="160" height="64" rx="8"/>
      <rect x="260" y="80" width="160" height="64" rx="8"/>
      <rect x="500" y="80" width="160" height="64" rx="8"/>
    </g>
    <rect x="260" y="80" width="160" height="64" rx="8" fill="none" stroke="#0f766e" stroke-width="2"/>
    <text x="100" y="55" text-anchor="middle" font-size="12" opacity="0.75">编码</text>
    <text x="340" y="55" text-anchor="middle" font-size="12" opacity="0.75">索引</text>
    <text x="580" y="55" text-anchor="middle" font-size="12" opacity="0.75">搜索</text>
    <text x="100" y="106" text-anchor="middle" font-size="12" font-family="ui-monospace, monospace">"pg tips"</text>
    <text x="100" y="126" text-anchor="middle" font-size="11" font-family="ui-monospace, monospace">→ vector(64)</text>
    <text x="340" y="106" text-anchor="middle" font-size="12" font-family="ui-monospace, monospace">HNSW 图</text>
    <text x="340" y="126" text-anchor="middle" font-size="11">多层邻居结构</text>
    <text x="580" y="106" text-anchor="middle" font-size="12" font-family="ui-monospace, monospace">&lt;-&gt; q LIMIT k</text>
    <text x="580" y="126" text-anchor="middle" font-size="11">前 k 行</text>
    <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.7">
      <line x1="180" y1="112" x2="255" y2="112"/><path d="M250 108 l6 4 -6 4"/>
      <line x1="420" y1="112" x2="495" y2="112"/><path d="M490 108 l6 4 -6 4"/>
    </g>
    <text x="340" y="180" text-anchor="middle" font-size="12" fill="#0f766e">ANN：走几个邻居，而不是给每一行打分</text>
    <g stroke="#0f766e" stroke-width="1.5" fill="none" opacity="0.8">
      <line x1="340" y1="144" x2="340" y2="164"/><path d="M336 159 l4 6 4 -6"/>
    </g>
  </g>
</svg>
<figcaption>Embedding 把语义变成坐标；ANN 索引把「给每一行打分」变成「沿着有希望的路走」。pgvector 把两者都留在你本来就在运维的那个数据库里。</figcaption>
</figure>

## HNSW：把扫描变成搜索的索引

**HNSW** 索引是一张多层邻近图：从顶层进入，贪心地朝查询点下降，收集候选。它召回率高、延迟低，而且与 IVFFlat 不同，它可以在空表上建，并且随着新行插入依然有效。

```sql
CREATE INDEX idx_items_hnsw ON items USING hnsw (embedding vector_l2_ops);
-- NOTICE: hnsw graph no longer fits into maintenance_work_mem after 67056 tuples
-- CREATE INDEX   Time: 45384.957 ms          index size: 54 MB

EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
SELECT id FROM items ORDER BY embedding <-> (SELECT v FROM q) LIMIT 10;

 Limit (actual rows=10 loops=1)
   ->  Index Scan using idx_items_hnsw on items (actual rows=10 loops=1)
         Order By: (embedding <-> (InitPlan 1).col1)
 Execution Time: 1.624 ms        -- 反复运行的中位数 3.9 ms
```

两点要诚实地说。构建成本是真的：**45–64 秒**，索引 **54 MB**（比 33 MB 的表还大），因为默认 `maintenance_work_mem` 在 6.7 万行后就不够用，剩下的溢写到了磁盘——调大它，以及容器的 `shm_size`，就是解法。而 10 万行上只有 **6×** 的提升，是故意显得平淡：这个规模下并行顺序扫描本来就便宜。HNSW 的优势随 `N` 增长。默认参数是 `m = 16`、`ef_construction = 64`。

## IVFFlat vs HNSW：构建、体积、召回、延迟

IVFFlat 把向量划分成 `lists` 个 k-means 簇，只搜索最近的 `probes` 个簇。它构建便宜、体积更小，但需要在建索引**之前**就有代表性数据，而且不重建的话会随新行插入而退化。在我这 10 万行、`lists = 100` 上：`probes = 1` 只返回了真实前 10 里的 1 个，0.54 ms；`probes = 10` 返回 10 个里的 9 个，约 4 ms；`probes = 100`（每个簇）返回全部 10 个，约 41 ms。

| | HNSW | IVFFlat |
|---|---|---|
| 构建时间（10 万行） | 45–64 s | 4.3 s |
| 索引体积 | 54 MB | 27 MB |
| 能否在空表上建 | 能 | 不能（需要先有数据） |
| 召回旋钮 | `hnsw.ef_search` | `ivfflat.probes` |
| 插入行为 | 良好 | 不重建就会退化 |

经验法则：要最好的召回、能接受更慢更大的构建，就用 **HNSW**；表基本是静态的、内存吃紧、或者你按计划重建，就用 **IVFFlat**。

## 调召回：`ef_search` 和 `probes` 就是那个旋钮

对 HNSW 来说，`ef_search` 是查询时的候选列表大小——越大越费算力，召回也越好。我跑了 20 个查询向量，把每个近似前 10 跟精确前 10 比对（关掉索引扫描，保证基准是真正的顺序扫描），再单独测单查询延迟：

| `hnsw.ef_search` | recall@10 | 延迟中位数 |
|---|---|---|
| 1 | 5% | 0.8 ms |
| 10 | 42% | 1.9 ms |
| **40（默认）** | **77%** | **3.9 ms** |
| 100 | 94% | 5.8 ms |
| 200 | 98% | 7.6 ms |
| 精确（无索引） | 100% | 23 ms |

仔细看默认那一行：开箱即用，在这份刻意做难的成簇数据上，HNSW 只返回了**真实前 10 的 77%**。如果你从不碰 `ef_search`，你的「前 10」就不是前 10。`SET hnsw.ef_search = 100` 用 5.8 ms 换来 94% 的召回——仍然比精确快 4 倍。它是按会话生效的，所以你可以给慢速高质量路径调高，给自动补全留低。

所以召回是个**产品决策**，不是数据库设置。在我的测试查询里，精确的第 10 名是 `80720`，距离 `3.3353`；默认 HNSW 搜索返回的是 `76040`，距离 `3.3489`——一次擦肩而过，正是你在接受的那种微小、看不见的误差。一个「相似文档」组件能容忍 90% 召回；一个绝不能漏掉近似重复的去重任务不能——那里你就把 `ef_search`/`probes` 调到接近 100%，或者为必须正确的查询付精确扫描的代价。

## 过滤 + 向量搜索：后过滤的坑

这是最容易咬人的失败模式。HNSW 先找最近的**行**，然后 Postgres 才应用你的 `WHERE`。如果过滤很选择性，而最近的那些行又不匹配，索引返回的行数就会少于 *k*——甚至为零。

```sql
SET hnsw.ef_search = 40;  SET hnsw.iterative_scan = off;
SELECT id, category FROM items WHERE category = 'ai'
ORDER BY embedding <-> (SELECT v FROM q) LIMIT 10;

 Limit (actual rows=0 loops=1)
   ->  Index Scan using idx_items_hnsw on items (actual rows=0 loops=1)
         Filter: (category = 'ai'::text)      Rows Removed by Filter: 40
 Execution Time: 4.090 ms
```

又快又完全错误：它扫了 40 个候选，全被过滤掉，返回空。pgvector 0.8 用**迭代扫描**修好了这个问题——一直扫到凑齐 *k* 个匹配行为止：

```sql
SET hnsw.iterative_scan = relaxed_order;
SET hnsw.max_scan_tuples = 100000;   -- 默认 20000；选择性过滤要调大

 Limit (actual rows=10 loops=1)
   ->  Index Scan using idx_items_hnsw on items (actual rows=10 loops=1)
         Filter: (category = 'ai'::text)      Rows Removed by Filter: 16000
 Execution Time: 96.251 ms
```

现在它 96 ms 返回 10 行，其中 8 个跟精确过滤结果一致。带过滤的向量搜索是另一种负载：对大多数行都通过的过滤，一个普通 `WHERE` 就够了；对选择性的过滤，迭代扫描才能让结果正确，代价是扫描量大得多。如果某个过滤是你查询模式的核心，部分索引（`... WHERE category = 'ai'`）通常更干净。

## pgvector vs 专用向量数据库：决策清单

留在 **pgvector**：数据本来就在 Postgres 里；你需要在向量之外做 join、事务或 `WHERE` 过滤；你处在百万级向量的量级；你重视只维护一套要备份和监控的系统；而且你愿意调 `ef_search` 和过滤搜索。

上**专用向量数据库**（Qdrant、Milvus、Weaviate 之类），当下面至少一条真的成立：

1. **规模超出单节点。** 几亿到几十亿向量，跨机器分片，还要横向写入吞吐——pgvector 是单节点的。
2. **激进压缩就是重点。** 用二值化和乘积量化把几十亿向量塞进内存；pgvector 保留全精度向量和一张大图。
3. **内置混合搜索和丰富过滤。** 调好的 BM25 + 向量融合、多租户隔离、把逐字段过滤做成一等特性。
4. **你受限于内存和构建，或者运维不是你的约束。** 需要对索引内存、量化和构建调度有更多控制——或者集群本来就在你手上。

这些里没有一条是「我想要快速的相似度搜索」。在十万到几百万向量的量级上，pgvector 用一条查询就能回答，就在你本来就在跑的那个数据库上。

## 一句话版本

加一个 `vector(N)` 列，存下你的 embedding，先用精确的 `ORDER BY embedding <-> $1 LIMIT k`。慢了就加 **HNSW** 索引，把 `ef_search` 调到召回够用，选择性过滤用迭代扫描或部分索引处理。留意构建时间和索引体积，并且拿真实基准去测召回，而不是相信默认值。把向量留在数据身边——只有当规模、压缩或混合搜索才是真正的瓶颈时，才去上专用向量数据库。

以上全部跑在一个用完即弃的 `pgvector/pgvector:pg17` 容器里、监听 `127.0.0.1`，之后我就把它拆了。数字来自我这台机器，你的硬件会不同——但那些形状、取舍和后过滤的坑，到哪里都一样。
