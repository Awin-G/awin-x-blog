---
title: "Postgres 全文检索 vs Elasticsearch：什么时候你并不需要那个集群"
description: "在同一份语料上亲手对比 Postgres 全文检索与 Elasticsearch：tsvector、tsquery、ts_rank、GIN 索引、用 pg_trgm 做模糊/错别字搜索，真实的 EXPLAIN 计划与 ES 响应，Postgres 做不到的事，以及何时才值得上一个搜索集群的决策规则。"
pubDate: 2026-12-16
lang: zh
translationKey: full-text-search
tags: [devops, linux]
featured: false
keywords:
  - Postgres 全文检索
  - Postgres vs Elasticsearch
  - tsvector
  - pg_trgm
  - GIN 索引
---

一说到「加个搜索」，默认建议就是上一套 Elasticsearch。对一个博客、一个小 SaaS 或内部工具来说，那通常意味着一个集群、一份 index mapping、一条同步管道，以及一套你根本没要的 on-call 轮值。而 **Postgres 全文检索**只用几行代码就能把文本列变成带排序的结果，不用再跑第二个服务。这是 **Postgres vs Elasticsearch** 的诚实版本：`tsvector`、`tsquery`、`ts_rank`、**GIN 索引**和 `pg_trgm` 到底做了什么，Postgres 在哪里就不够用了，以及搜索引警究竟何时才真正值得。下面每个数字都是真的——我跑了一个用完即弃的 Postgres 17 和一个单节点 Elasticsearch 8.15，同一份语料，输出原样贴出。

## 五分钟上手 Postgres 全文检索：`tsvector`、`tsquery` 与 GIN

Postgres 从不直接搜原始文本。它把文档转成 `tsvector`——一个排好序、带位置的规范化词元（lexeme）列表；再把用户字符串转成 `tsquery`——一个关于词元的布尔表达式。`@@` 运算符判断向量是否匹配查询。

```sql
SELECT to_tsvector('english', 'The running dogs are running, and the database was indexed');

               to_tsvector
------------------------------------------
 'databas':8 'dog':3 'index':10 'run':2,5
```

这里已经有三件事：`running` 变成了 `run`，`database` 掉了元音，`the`、`are` 这类停用词被丢弃。这是字典在做词干还原（stemming）。`plainto_tsquery` 把友好的输入安全地转成查询，不用你手写运算符：

```sql
SELECT plainto_tsquery('english', 'full text search');
           plainto_tsquery
-------------------------------------
 'full' & 'text' & 'search'
```

搜索是一行，排序是第二行。`ts_rank` 给每个匹配打分；`setweight` 让标题比正文权重更高：

```sql
SELECT title, round(ts_rank(tsv, query)::numeric, 4) AS rank
FROM (
  SELECT title,
         setweight(to_tsvector('english', title), 'A') ||
         setweight(to_tsvector('english', body),  'B') AS tsv
  FROM docs
) d, LATERAL (SELECT to_tsquery('english','search | index') AS query) q
WHERE tsv @@ query
ORDER BY rank DESC LIMIT 5;

               title               |  rank
-----------------------------------+--------
 Full text search with tsvector    | 0.4255
 Database indexing basics          | 0.3344
 Fuzzy search with pg_trgm         | 0.3040
 Postgres full text search ranking | 0.3040
 Elasticsearch at scale            | 0.1216
```

这是一个真实的**相关性**信号——标题命中排在仅正文命中之前，两个真实匹配排在第三名之前。不需要任何集群。

## 让它变快的是 GIN 索引

没有索引时，`@@` 会对每一行求值 `to_tsvector`。在 20 万条文档上，这是一次并行顺序扫描，耗时 **5.5 秒**：

```sql
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF)
SELECT id FROM big_docs
WHERE to_tsvector('english', body) @@ to_tsquery('english','elasticsearch & cluster');

 Gather (actual rows=64307 loops=1)
   Workers Launched: 2
   ->  Parallel Seq Scan on big_docs (actual rows=21436 loops=3)
         Filter: (to_tsvector('english'::regconfig, body) @@ ...)
         Rows Removed by Filter: 45231
 Execution Time: 5494.103 ms
```

在同一个表达式上建一个 **GIN 索引**，计划就变成 bitmap index scan，时间降到 **84 毫秒**——约 65 倍——而索引只有 4 MB，表是 44 MB：

```sql
CREATE INDEX idx_big_docs_fts ON big_docs USING GIN (to_tsvector('english', body));

 Gather (actual rows=64307 loops=1)
   ->  Parallel Bitmap Heap Scan on big_docs (actual rows=21436 loops=3)
         Recheck Cond: (to_tsvector('english'::regconfig, body) @@ ...)
         ->  Bitmap Index Scan on idx_big_docs_fts (actual rows=64307 loops=1)
 Execution Time: 83.788 ms

 gin_index_size | table_size
----------------+------------
 4096 kB        | 44 MB
```

这 20 万行上，GIN 索引构建耗时 11.8 秒——一次性成本；代价是此后每次 `INSERT` 和 `UPDATE` 都要维护它。这跟任何索引是同一本账；写入成本的记账方式见 [数据库索引基础](/zh/posts/database-indexing/)。

<figure>
<svg viewBox="0 0 660 210" width="100%" role="img" aria-label="查询字符串被规范化为 tsquery，通过 tsvector 词元的 GIN 索引匹配，再用 ts_rank 排序，得到有序结果。">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.45">
      <rect x="20" y="70" width="130" height="60" rx="8"/>
      <rect x="265" y="70" width="130" height="60" rx="8"/>
      <rect x="510" y="70" width="130" height="60" rx="8"/>
    </g>
    <rect x="265" y="70" width="130" height="60" rx="8" fill="none" stroke="#0f766e" stroke-width="2"/>
    <text x="85" y="45" text-anchor="middle" font-size="12" opacity="0.75">输入</text>
    <text x="330" y="45" text-anchor="middle" font-size="12" opacity="0.75">规范化</text>
    <text x="575" y="45" text-anchor="middle" font-size="12" opacity="0.75">排序</text>
    <text x="85" y="96" text-anchor="middle" font-size="12" font-family="ui-monospace, monospace">"search index"</text>
    <text x="330" y="90" text-anchor="middle" font-size="12" font-family="ui-monospace, monospace">'search' &amp; 'index'</text>
    <text x="330" y="110" text-anchor="middle" font-size="11" font-family="ui-monospace, monospace">tsquery</text>
    <text x="575" y="90" text-anchor="middle" font-size="12" font-family="ui-monospace, monospace">ts_rank DESC</text>
    <text x="575" y="110" text-anchor="middle" font-size="11">top-k 行</text>
    <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.7">
      <line x1="150" y1="100" x2="260" y2="100"/><path d="M255 96 l6 4 -6 4"/>
      <line x1="395" y1="100" x2="505" y2="100"/><path d="M500 96 l6 4 -6 4"/>
    </g>
    <text x="330" y="165" text-anchor="middle" font-size="12" fill="#0f766e">GIN 索引：词元 → 行 id 的倒排表</text>
    <g stroke="#0f766e" stroke-width="1.5" fill="none" opacity="0.8">
      <line x1="330" y1="130" x2="330" y2="150"/><path d="M326 145 l4 6 4 -6"/>
    </g>
  </g>
</svg>
<figcaption>每一类全文查询都是这个形状：把输入规范化成 tsquery，经由 GIN 索引把词元变成行 id，再打分排序。Elasticsearch 做的也是这三步——只是它跑在一个独立的分布式服务里。</figcaption>
</figure>

## 词干、字典，以及它「顺便」吸收掉的那个错别字

`to_tsvector('english', ...)` 用的是 Snowball 英文词干器加一份停用词表。这就是为什么 `running`、`runs`、`run` 都塌缩成 `run`——一个朴素 `ILIKE '%run%'` 做不到的真实相关性收益。但词干还原不是拼写纠错，值得看清这条界线在哪：

```sql
SELECT to_tsvector('english','postgres')   AS correct,
       to_tsvector('english','postgrs')    AS typo_suffix,
       to_tsvector('english','postgeres')  AS typo_infix;
  correct   | typo_suffix |  typo_infix
------------+-------------+-------------
 'postgr':1 | 'postgr':1  | 'postger':1
```

`postgrs` 碰巧词干化成 `postgr`，和 `postgres` 一样，于是这个**后缀**错别字靠运气被掩盖了。`postgeres` 则不会——它的词元是 `postger`，谁都匹配不上。词干是词法，不是模糊匹配；一旦错别字落在一个词的中间，差别立刻显现。

## `pg_trgm`：真正的模糊与错别字搜索

想在 Postgres 里获得真正的错别字容忍，就该用 **pg_trgm** 扩展。它把字符串切成三字符组并计算重叠度，于是 `postgrs` 依然能找到 `Postgres`：

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

SELECT similarity('postgres','postgrs');        -- 0.54545456
SELECT show_trgm('postgres');
 {"  p"," po","es ","gre","ost","pos","res","stg","tgr"}

SELECT title, round(word_similarity('postgrs', title)::numeric, 3) AS sim
FROM docs WHERE 'postgrs' <% title ORDER BY sim DESC;
               title               | word_sim
-----------------------------------+----------
 Running Postgres in production    |    0.750
 Postgres full text search ranking |    0.750
```

`<%`（词相似度）才是这里有用的运算符：它问的是这个模式是否像文档里**任意一个词**，而不是整串一起比。带 `gin_trgm_ops` 的 GIN 索引可以让 `%`、`<%` 以及 `LIKE '%...%'` 变成走索引，而不是顺序扫描。所以 Postgres **能**做错别字搜索——只是它默认不开，而且是一个独立索引、有它自己的成本。

## Postgres 全文检索做不到的事

这是那些热情洋溢的文章会跳过的一段：

- **错别字容忍需要手动开启。** 你得加 `pg_trgm` 并围绕它设计；ES 对每个字段免费给你 `fuzziness`。
- **分面（facets）与聚合是你自己的活。** 没有 `terms` 聚合这种东西；你写 `GROUP BY`，它在查询时计算，而非来自预计算结构。ES 把聚合做进了引擎。
- **扩展是单节点的。** Postgres 全文检索靠纵向扩容和只读副本。当文档达到数十亿、需要跨多节点、分片级并行时，一个天生就是分布式倒排索引的引擎才是对的工具。
- **相关性调优很浅。** `ts_rank` 与权重都很粗。ES 有可调 k1/b 的 BM25、function score、boosting，以及逐字段的 analysis。如果相关性就是你的产品，这个差距很要紧。
- **高亮有，但比较朴素。** 对 Postgres 要公平：`ts_headline` 确实能生成摘要——`ts_headline('english', body, to_tsquery('english','tsvector|tsquery'), 'StartSel=<b>, StopSel=</b>')` 返回了 `Postgres can build a <b>tsvector</b> ... with <b>tsquery</b>`。只是没有 ES 的 `highlight` 那么快、那么可配置。
- **跨语言分析与自定义管道**受限于你能装哪些字典和扩展。

## 在同样的 20 万文档语料上：Postgres vs Elasticsearch

我把同样的 20 万个生成文档索引进了两边。Elasticsearch 的数字来自一个单节点 8.15 容器、512 MB 堆、关闭 security、单分片——这**不是**一个真实集群，下面我会再说一遍。

| 维度 | Postgres 全文检索 | Elasticsearch |
|---|---|---|
| 搭建 | 内置，零额外服务 | 容器/集群 + mapping + 客户端 |
| 错别字容忍 | `pg_trgm`，需显式建索引 | 逐字段 `fuzziness`，内置 |
| 排序 | `ts_rank` + `setweight`（粗） | BM25、function score、boosting |
| 分面/聚合 | 查询时手写 `GROUP BY` | `terms`/`date_histogram` 等工程化聚合 |
| 高亮 | `ts_headline` | `highlight`，快且可配置 |
| 20 万文档索引体积 | 4 MB GIN（另有 44 MB 表） | 27.6 MB store |
| 20 万文档构建时间 | GIN 构建 11.8 s | 批量导入约 25 s（约 7,900 docs/s） |
| 20 万文档查询 | 33–99 ms（bitmap index scan） | 2–43 ms（filter cache 已热） |
| 分布式扩展 | 只读副本 | 跨节点分片 |
| 事务、join、外键 | 原生支持 | 不支持 |
| 运维面 | 你本来就在跑的一个进程 | 集群、堆、分片、同步 |

等价的 Elasticsearch 查询和分面确实很舒服：

```jsonc
// 带高亮的相关性搜索
POST /docs2/_search
{ "query": { "multi_match": { "query": "search index", "fields": ["title^2","body"] } },
  "highlight": { "fields": { "body": {} } }, "size": 3 }
// → 5.2047 "Database indexing basics"  hl: A composite <em>index</em> ...
// → 3.5337 "Fuzzy search with pg_trgm"
// → 3.1022 "Full text search with tsvector"  hl: A GIN <em>index</em> makes it fast.

// 分面
{ "size": 0, "query": { "match": { "body": "query" } },
  "aggs": { "by_topic": { "terms": { "field": "topic", "size": 5 } } } }
// → total hits: 2   databases: 2
```

分面返回了 `databases: 2`，与我在 Postgres 里手写的 `GROUP BY` 一致。模糊搜索 `postgrs` 在零配置下就返回了 `Running Postgres in production` 和 `Postgres full text search ranking`。在 20 万文档上，两个数据库都在几十毫秒级——在这个量级上，性能差距并不是选择它的理由。

## 小应用跑一个搜索集群的运维成本

以下是表格没体现的东西。Postgres 那一列，是你大概本来就在跑、已经在备份、已经在监控、也已经有连接池的那个进程。Elasticsearch 那一列，则是第二个有状态系统，带着它自己的一整套故障模式：

- **第二个事实来源。** 数据住在 Postgres 里，又被**复制**进索引。你现在需要一条同步路径，还要决定它落后了、或某次写入写到一半失败时怎么办。
- **JVM 与堆调优。** 为了容器不失控，我不得不把堆压到 512 MB；上线则意味着琢磨堆大小、GC 和 field data cache。
- **集群知识。** 分片、副本、重建索引、需要重建的 mapping 变更、脑裂、以及带破坏性变更的版本升级。
- **机器成本。** 哪怕一个很小的节点，闲置也要几百 MB 内存。在一台整个应用可能才 1 GB 的 VPS 上，这就是 $5 套餐和 $20 套餐的差别。

对小应用来说，这是每月都要交的一笔真实的税，用来换一个 Postgres 一个下午就能交付的功能。这跟 [SQLite 就够了](/zh/posts/sqlite-is-enough/) 是同一笔取舍：小的那个选项通常是对的，直到某个被测量过的具体需求说「不」。

## 决策规则：先从 Postgres 开始

先从 Postgres 全文检索开始。建好 `tsvector`，加上 GIN 索引，用 `ts_rank` 排序，用户开始打错字时再加 `pg_trgm`。放在真实负载下跑并测量。

只有在下面某一条真的成立时，才上搜索引擎：

1. **分面和聚合就是产品本身。** 过滤、区间、计数之上再计数——查询时的 `GROUP BY` 成了瓶颈，这时专门的引擎就赢了。
2. **相关性是竞争点。** 你在调 BM25、给字段加权、对排序做 A/B 测试。Postgres 给你一个粗旋钮；ES 给你一个控制台。
3. **规模要求分布式。** 数十亿文档、高写入吞吐、分片级并行、跨节点可用性——这已经超出单个 Postgres。
4. **语言/文本管道才是难点。** 多语言、自定义 analyzer、tokenizer、同义词、n-gram，都是一等概念。

在这些之一成立之前，那个集群只是为了一个你本可以用一条 Postgres 查询交付的功能，多养了一个系统。「加个搜索」的正确答案，通常就是你手上已经有的那个数据库。
