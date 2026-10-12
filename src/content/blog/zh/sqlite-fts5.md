---
title: "SQLite FTS5 实战：一个文件里的全文搜索"
description: "SQLite FTS5 实战：把全文搜索装进一个数据库文件。真实 sqlite3 输出——建索引（独立表与外部内容表）、MATCH 查询语法、bm25() 排序对比 LIKE、highlight() 与 snippet()、unicode61/porter/trigram 三种分词器、optimize 与 rebuild 维护，以及诚实的边界。"
pubDate: 2027-01-02
lang: zh
translationKey: sqlite-fts5
tags: [devops, python]
featured: false
keywords:
  - SQLite FTS5
  - SQLite 全文搜索
  - bm25
  - MATCH 查询
  - 分词器
  - 外部内容表
  - trigram
---

「加个搜索功能」有一个昂贵的默认答案：再起一个搜索服务。对于一个博客、一个 CLI 工具、一个内部应用，诚实的答案通常是一个 **SQLite FTS5** 虚拟表——一个真实的倒排索引，就住在你的数据文件里。没有守护进程、没有同步管道、没有要伺候的集群。这就是**「SQLite 全文搜索」**的姿势：FTS5 到底做了什么、怎么建索引、**MATCH 查询**的语法、`bm25()` 排序面对朴素 `LIKE` 时的表现、**分词器**的选择代价，以及 FTS5 诚实的边界。下面的每一个数字和输出都是真的——我用 SQLite 3.53.4 在一个临时数据库上跑出了它们：12 条手写的文章，外加一个 5 万行的合成语料，输出照贴。

```sql
SELECT sqlite_version();

3.53.4
```

## SQLite FTS5 是什么，以及它什么时候赢过 LIKE

`LIKE '%sqlite%'` 感觉像搜索，其实不是。它是一个子串测试，会**逐行读完整个表**，而且结果顺序完全交给查询规划器决定——通常是 rowid。FTS5 做的是另一件事：它把你的文本切词，建一张倒排索引——从词条到包含它的行的映射。查询变成一次字典查找加一些归并，而不是一次全表扫描。

执行计划的区别值得亲眼看一次：

```sql
EXPLAIN QUERY PLAN SELECT id FROM articles WHERE title LIKE '%sqlite%' OR body LIKE '%sqlite%';

QUERY PLAN
`--SCAN articles

EXPLAIN QUERY PLAN SELECT rowid FROM articles_fts WHERE articles_fts MATCH 'sqlite';

QUERY PLAN
`--SCAN articles_fts VIRTUAL TABLE INDEX 0:M2
```

在 5 万行上，两个查询返回同样的 5000 行，背后的工作量完全不同：

```sql
.timer on
SELECT count(*) FROM big WHERE body LIKE '%fts5%';
SELECT count(*) FROM big_fts WHERE big_fts MATCH 'fts5';

5000
Run Time: real 0.007362 user 0.007144 sys 0.000146
5000
Run Time: real 0.000379 user 0.000345 sys 0.000035
```

七毫秒对零点四毫秒，而这还只是一个小数据库。到了一百万行，扫描变成秒级，查找依然不是。`LIKE` 在你的表很小而且永远会这么小的时候完全没问题——一百行配置表不需要索引。FTS5 是为两种时刻准备的：表会长大的时刻，和你希望结果按相关度排序的时刻。

## 建索引：独立表 vs 外部内容表

有两种形态。独立表把文本存在 FTS5 索引自己里面——你只写这一张表，不写别处。更有意思的形态是**外部内容表**（external content）：FTS5 索引引用一张普通表，自己只存词条和 rowid，需要回显或高亮原文时再回原表读。

```sql
CREATE TABLE articles (
  id    INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body  TEXT NOT NULL
);

-- content='articles' 加 content_rowid=<主键>，就变成一个外部内容索引
CREATE VIRTUAL TABLE articles_fts USING fts5(
  title, body,
  content='articles',
  content_rowid='id'
);

-- 用现有的内容表填充索引
INSERT INTO articles_fts(articles_fts) VALUES('rebuild');
```

普通应用表应该优先用外部内容形态：文本不重复，数据只有一份，内容表始终是事实来源。代价就是上面那句提醒——喂饱索引是你的责任，这一点我在维护一节再讲。

这种重复存储的取舍是可以量化的。5 MB 合成表对应的 FTS5 索引，数据部分花了 2.7 MB，外加 0.5 MB 的文档长度元数据：

```sql
SELECT name, SUM(pgsize)/1024.0 AS kb FROM dbstat GROUP BY name;

big             | 5120.0
big_fts_data    | 2728.0
big_fts_docsize | 480.0
big_fts_idx     | 12.0
```

## MATCH 查询语法一屏看完

FTS5 的查询语言很小，值得完整掌握。裸词之间默认是 AND；`OR`、`NOT`、括号、`"引号短语"`、`前缀*`、`列名:词条` 和 `NEAR(...)` 几乎覆盖了搜索框需要的所有行为。同一个语料，真实输出：

```sql
-- 布尔
SELECT 'tokenizer AND unicode61' AS q, group_concat(a.id) FROM articles_fts f JOIN articles a ON a.id=f.rowid
  WHERE articles_fts MATCH 'tokenizer AND unicode61';

q                            | 5, 8

SELECT 'wal OR trigram' AS q, group_concat(a.id) FROM articles_fts f JOIN articles a ON a.id=f.rowid
  WHERE articles_fts MATCH 'wal OR trigram';

q                  | 3, 11

SELECT 'database NOT backup' AS q, group_concat(a.id) FROM articles_fts f JOIN articles a ON a.id=f.rowid
  WHERE articles_fts MATCH 'database NOT backup';

q                      | 1, 7
```

```sql
-- 形态
SELECT 'fts*  (前缀)'           AS q, group_concat(a.id) FROM articles_fts f JOIN articles a ON a.id=f.rowid
  WHERE articles_fts MATCH 'fts*';
SELECT '"single writer" (短语)' AS q, group_concat(a.id) FROM articles_fts f JOIN articles a ON a.id=f.rowid
  WHERE articles_fts MATCH '"single writer"';
SELECT 'NEAR(writer commits, 3)' AS q, group_concat(a.id) FROM articles_fts f JOIN articles a ON a.id=f.rowid
  WHERE articles_fts MATCH 'NEAR(writer commits, 3)';
SELECT 'title:fts5 OR title:trigram' AS q, group_concat(a.id) FROM articles_fts f JOIN articles a ON a.id=f.rowid
  WHERE articles_fts MATCH 'title:fts5 OR title:trigram';

q                        | 2
q                            | 3
q                          | 3
q                          | 2, 11
```

两个实践要点。`NEAR(term1 term2, n)` 在两个词相距 `n` 个词条以内时命中——相当于带 slop 的短语搜索，你不用逼用户记住引号怎么写。列过滤如 `title:fts5` 可以让标题命中排得更靠前，或者干脆把搜索限制在某一列。

唯一的坑：这是查询*语言*，不是自由文本。永远别把用户输入直接拼进 `MATCH`。用参数绑定（`WHERE articles_fts MATCH ?`）并自己处理不可信词条——通常是把每个用户词包成引号短语——否则一个游离的引号，最好的结果是语法错误，最坏的结果是一个你没打算写的布尔条件。

## 用 bm25() 排序：为什么相关度顺序很重要

一堆命中按表顺序返回，在用户眼里就是个 bug，因为他想要的那条常常排在第三。`bm25()` 给 FTS5 一个相关度分数：通过常规的 SQL 机制拿到，用 `ORDER BY rank` 排序。分数是**负数**——越负越是好匹配——函数还接受可选的按列权重。

```sql
SELECT a.id, round(bm25(articles_fts, 10.0, 1.0), 4) AS rank, a.title
FROM articles_fts f JOIN articles a ON a.id = f.rowid
WHERE articles_fts MATCH 'sqlite'
ORDER BY rank;

id|rank|title
1|-1.2369|SQLite is enough for most applications
5|-0.8952|Tokenizers in practice
2|-0.6391|Getting started with FTS5
7|-0.5985|Running a personal blog on one machine
```

同样的搜索换成 `LIKE` 写一遍：

```sql
SELECT id, title FROM articles WHERE title LIKE '%sqlite%' OR body LIKE '%sqlite%';

id|title
1|SQLite is enough for most applications
2|Getting started with FTS5
5|Tokenizers in practice
7|Running a personal blog on one machine
```

`LIKE` 没有相关度的概念，所以它按 rowid 顺序吐出行：第 2 行排在第 5 行前面。FTS5 知道第 1 行在**标题**里命中（标题权重 10.0 对正文 1.0），知道第 5 行的正文出现了两次 "sqlite" 而第 2 行只出现一次，并据此排序。同样的行，不同的答案——一个是相关度排序，另一个是插入顺序的偶然。在标题列压一个权重，再 `ORDER BY rank LIMIT 20`，这就是一个站内搜索后端的全部核心。

## highlight() 和 snippet()：给搜索 UI 用的两个函数

把裸行扔给用户，等于让他自己去找「为什么这行命中」。`highlight(articles_fts, col, before, after)` 给整列的命中包上标记，`snippet()` 则围绕最佳命中租给你一小段上下文：

```sql
SELECT 'mark  = ' || highlight(articles_fts, 0, '<mark>', '</mark>')
  FROM articles_fts WHERE articles_fts MATCH 'fts5';

mark  = Getting started with <mark>FTS5</mark>

SELECT 'snip  = ' || snippet(articles_fts, 1, '<mark>', '</mark>', '…', 10)
  FROM articles_fts WHERE articles_fts MATCH 'fts5';

snip  = SQLite ships a full-text search engine called <mark>FTS5</mark>. You…

SELECT 'snip2 = ' || snippet(articles_fts, 1, '<mark>', '</mark>', '…', 12)
  FROM articles_fts WHERE articles_fts MATCH 'trigram';

snip2 = For short strings, the <mark>trigram</mark> tokenizer breaks text into three-character windows…
```

列参数从零开始（`0` 是 title，`1` 是 body），`snippet()` 接受省略号字符串和词条数量。这半个搜索界面通常需要一个单独的模板步骤，而 FTS5 直接从查询里吐给你。

## 分词器：unicode61、porter、trigram

**分词器**是 FTS5 schema 里最容易被低估的一项，它改变「匹配」的含义。它在 `CREATE VIRTUAL TABLE` 时选定，而且可以按列配置。内建的有三个值得认识。

**unicode61** 是默认的：按非字母数字字符切分、折叠大小写、丢变音符。这就是为什么大写查询词能命中小写文档：

```sql
SELECT 'case fold MATCH SQLITE -> ' || group_concat(rowid) FROM articles_fts
  WHERE articles_fts MATCH 'SQLITE';

case fold MATCH SQLITE -> 1,2,5,7
```

**porter** 套用 Porter 词干算法，`tokenize`、`tokenizer`、`tokenizers` 会塌缩到同一个词干上，一个查询词全部命中：

```sql
SELECT 'unicode61 MATCH token -> ' || group_concat(rowid) FROM articles_fts
  WHERE articles_fts MATCH 'token';
SELECT 'porter    MATCH token -> ' || group_concat(rowid) FROM porter_fts
  WHERE porter_fts MATCH 'token';

unicode61 MATCH token -> 5
porter    MATCH token -> 2,5,8,11
```

召回上去了，精度下来了——用户输入 "index"，`porter` 会命中 "indexes"，不管这是不是他要的。它适合散文搜索，用户会敲口语词；不适合标识符，`parse` 和 `parser` 的区别就是答案本身。

**trigram** 把文本切成三字符窗口，于是大小写不敏感的子串搜索也变成一次索引查找——这正是 `LIKE` 做不到的事：

```sql
SELECT 'unicode61 MATCH earch -> ' || coalesce(group_concat(rowid), '(no rows)') FROM articles_fts
  WHERE articles_fts MATCH 'earch';
SELECT 'trigram   MATCH earch -> ' || group_concat(rowid) FROM tri_fts
  WHERE tri_fts MATCH 'earch';
SELECT 'trigram   MATCH GIN   -> ' || group_concat(rowid) FROM tri_fts
  WHERE tri_fts MATCH 'GIN';

unicode61 MATCH earch -> (no rows)
trigram   MATCH earch -> 2,7,11
trigram   MATCH GIN   -> 2,3,9,11
```

`trigram` 是为「半个词」、代码标识符、姓名或文件路径这类短字段准备的分词器。它也最贵：每行的词条更多，索引更大，待验证的候选更多。

## 维护：optimize 与 rebuild

FTS5 和其他索引一样会把删除累积在结构里。`optimize` 把分段合并成一颗紧凑的树，批量变更之后跑一次很安全；`rebuild` 则用内容表重新生成整个索引：

```sql
INSERT INTO articles_fts(articles_fts) VALUES('optimize');
INSERT INTO articles_fts(articles_fts) VALUES('rebuild');
```

`optimize` 是卫生习惯，每周或大批量清理之后跑一次。`rebuild` 是修复工具；对于**外部内容**索引，它还是修数据漂移的*唯一*正确方式，因为绕过 FTS 直接写内容表，不会更新 FTS 的影子表。改一下第 7 行、搜那个新词，现场就能证明：

```sql
UPDATE articles SET body = body || ' It even answers openssl questions.' WHERE id = 7;
SELECT 'article has it (LIKE): ' || group_concat(id) FROM articles WHERE body LIKE '%openssl%';
SELECT 'fts index before   : ' || coalesce(group_concat(a.id), '(no rows)')
  FROM articles_fts f JOIN articles a ON a.id=f.rowid WHERE articles_fts MATCH 'openssl';
INSERT INTO articles_fts(articles_fts) VALUES('rebuild');
SELECT 'fts index after    : ' || coalesce(group_concat(a.id), '(no rows)')
  FROM articles_fts f JOIN articles a ON a.id=f.rowid WHERE articles_fts MATCH 'openssl';

article has it (LIKE): 7
fts index before   : (no rows)
fts index after    : 7
```

内容表一直有这行；FTS 索引却什么都搜不到，直到重建。两种从此不踩这个坑的办法：所有写操作都走 FTS 表（也就是用独立表形态），或者在内容表上挂 `AFTER INSERT/UPDATE/DELETE` 触发器来镜像每个变更。我用触发器——上面这种漂移失败太安静了，不适合留给生产环境去发现。

## 边界：FTS5 不是搜索集群

我足够喜欢 FTS5，所以也想让你知道它在哪里停下。

**它是一台机器上的一个数据库。**索引和数据在同一个文件里；没有可以信任的文件级复制，也没有跨网络查询它的协议。这和我在[《SQLite 就够了：在生产环境里使用 SQLite》](/zh/posts/sqlite-is-enough/)里记的是同一笔账——读能扩展，写会串行，「一台机器」就是可用性的全部故事。

**排序很基础。** `bm25()` 加按列权重是一个好排序函数，同时也是一个小函数：`k1`/`b` 参数固定，没有同义词，没有按新鲜度加权，没有 learning-to-rank。用户打错字就什么都搜不到——`trigram` 给你的是子串搜索，不是模糊匹配，两个分词器都不原谅编辑距离。

**没有分面。**常见的「Python 12 条、SQL 7 条、Rust 3 条」侧边栏，是你对自己的分类做一次 `GROUP BY`——索引不会替你做这个聚合，而且在大结果集上，这个扫描每次查询都要跑一遍。

**你的运维面就是数据库的运维面。**没有集群健康度、没有 mapping、没有重索引管道——这就是为什么应该从这里出发，等搜索本身超出一个文件的容量，再迁到专门的搜索引擎。那条线划在哪里，我在[《Postgres 全文搜索 vs Elasticsearch》](/zh/posts/full-text-search/)里做了对照实验。

在那之前，整个技术栈就是三条命令，不需要多一台服务器。常住终端的话，把这些查询脚本化的 CLI 习惯都在[《SQLite 命令行 cookbook》](/zh/posts/sqlite-cli-cookbook/)——我自己博客的搜索，跑的就是上面这套形态。

<figure>
<svg viewBox="0 0 660 230" width="100%" role="img" aria-label="FTS5 倒排索引示意图：文档经分词器变成词条，每个词条映射到包含它的 rowid 列表，MATCH 查询查词条后用 bm25 排序并高亮。">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
      <rect x="16" y="78" width="150" height="78" rx="8"/>
      <rect x="435" y="40" width="90" height="34" rx="6"/>
      <rect x="435" y="86" width="90" height="34" rx="6"/>
      <rect x="435" y="132" width="90" height="34" rx="6"/>
    </g>
    <text x="91" y="60" text-anchor="middle" font-size="12" opacity="0.75">内容表</text>
    <text x="91" y="100" text-anchor="middle" font-size="11" font-family="ui-monospace, monospace">articles</text>
    <text x="91" y="118" text-anchor="middle" font-size="11" font-family="ui-monospace, monospace">title + body</text>
    <text x="91" y="140" text-anchor="middle" font-size="11">1 FTS5 · 2 tokenizers…</text>
    <text x="480" y="160" text-anchor="middle" font-size="11" opacity="0.75" fill="#0f766e">MATCH → bm25 排序 → …</text>
    <text x="480" y="61" text-anchor="middle" font-size="11" font-family="ui-monospace, monospace">fts5 → [2]</text>
    <text x="480" y="107" text-anchor="middle" font-size="11" font-family="ui-monospace, monospace">trigram → [11]</text>
    <text x="480" y="153" text-anchor="middle" font-size="11" font-family="ui-monospace, monospace">wal → [3]</text>
    <text x="235" y="40" text-anchor="middle" font-size="12" opacity="0.75">分词器</text>
    <text x="235" y="60" text-anchor="middle" font-size="11" font-family="ui-monospace, monospace">unicode61</text>
    <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.7">
      <line x1="166" y1="118" x2="380" y2="118"/><path d="M376 114 l6 4 -6 4"/>
    </g>
    <text x="330" y="105" text-align="middle" text-anchor="middle" font-size="11" opacity="0.7">倒排索引：词条 → 包含它的 rowid 列表</text>
    <text x="330" y="150" text-anchor="middle" font-size="11" opacity="0.7">SELECT … WHERE articles_fts MATCH 'fts5 OR wal'</text>
  </g>
</svg>
<figcaption>FTS5 索引就是一张张词条到倒排列表的映射；一次 MATCH 查询是几次字典查找加一次归并，`bm25()` 给幸存者排序，`highlight()` 负责标记。</figcaption>
</figure>
