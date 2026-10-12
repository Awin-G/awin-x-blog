---
title: "RAG 实战：它本质上是个搜索问题"
description: "我在这个博客自己的文章上搭了一个微型检索系统——SQLite、256 维嵌入、BM25、RRF，并贴出真实输出。三个查询，其中一个彻底失败。RAG 到底是什么，为什么分块和检索质量决定一切，以及什么时候你根本不需要 RAG。"
pubDate: 2026-12-27
lang: zh
translationKey: rag-in-practice
tags: [ai, python]
featured: true
keywords:
  - RAG
  - 检索增强生成
  - 嵌入
  - 分块
  - 混合检索
---

我听到的关于 **RAG** 的争论，几乎都吵错了层次。大家在争用哪个大模型、哪个嵌入模型、要不要微调——而真正决定 **检索增强生成** 能不能用的，是它前面那一步搜索。RAG 不是一个模型。它是一道披着机器学习外衣的搜索题：找出能回答问题的少数几段文字，塞进上下文窗口，让模型去读。它出问题的时候，几乎从不出在生成环节，而是因为正确的那段文字压根没被检索出来。

我不想凭记忆写这句话，所以我用这个博客自己的文章搭了一个微型检索系统——SQLite、一个 256 维的嵌入模型、SQLite FTS5 里的 BM25，再加一层混合合并——把真实输出贴在下面。其中有一个查询是彻底失败的，我把它留着了。

## RAG 到底是什么

**检索增强生成**就两步，顺序固定：先检索，再生成。什么都不训练，权重一个都不改。你拿一个问题，在自己的文档上跑一次搜索，把最相关的几段连同一条简短指令贴进提示词：请依据这些内容回答。

这就是全部的诀窍，也解释了为什么 RAG 又便宜又脆弱。便宜，是因为你可以拿五分钟前刚写好的文档直接开搜；脆弱，是因为模型只能对它拿到的检索结果做推理。如果搜索返回的是错误的那五段，再强的模型也会写出一段流畅、自信、错误的回答——还顺手引用了错误的段落。

被吹起来的那版说法是「把你的数据喂给模型」。没有这种开关。存在的只有一份搜索索引、一套分块策略和一个排序函数，这三者的质量，就是你的 RAG 的质量。

## 流水线：分块 → 嵌入 → 存储 → 检索 → 重排 → 提示

六步，但重要性并不相等：

1. **分块** —— 把文档切成适合检索的单元。
2. **嵌入** —— 把每个块变成向量。
3. **存储** —— 把向量和原文放进可查询的地方（SQLite 就够）。
4. **检索** —— 找出候选块（向量搜索、关键词搜索，或两者都上）。
5. **重排** —— 用更慢但更准的打分器重新排序候选。
6. **提示** —— 把胜出的块拼进上下文窗口。

第 1 步和第 4 步决定结果。第 2、3、6 步基本是管道工程，第 5 步是随时能加上的廉价升级。大多数「RAG 不行」的抱怨，其实是第 1 步和第 4 步的抱怨。

<figure>
<svg viewBox="0 0 880 260" role="img" aria-label="两行式的 RAG 流水线。索引期：语料、分块、嵌入、存入带向量 BLOB 与 FTS5 的 SQLite。查询期：问题同时进入向量搜索和 BM25，结果用 RRF 融合，再重排，最后放进提示词交给大模型。" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px">
  <defs>
    <marker id="ar-zh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <text x="8" y="20" fill="#0f766e" font-size="11" letter-spacing="1.5">索引期 INDEX TIME</text>
  <g fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="8" y="30" width="150" height="44" rx="6"/>
    <rect x="196" y="30" width="150" height="44" rx="6"/>
    <rect x="384" y="30" width="150" height="44" rx="6"/>
    <rect x="572" y="30" width="300" height="44" rx="6" stroke="#0f766e"/>
    <rect x="8" y="170" width="150" height="44" rx="6"/>
    <rect x="196" y="118" width="150" height="44" rx="6"/>
    <rect x="196" y="196" width="150" height="44" rx="6"/>
    <rect x="384" y="157" width="150" height="44" rx="6"/>
    <rect x="572" y="157" width="150" height="44" rx="6"/>
    <rect x="760" y="157" width="112" height="44" rx="6"/>
  </g>
  <g fill="currentColor" text-anchor="middle">
    <text x="83" y="57">语料</text>
    <text x="271" y="57">分块</text>
    <text x="459" y="57">嵌入</text>
    <text x="722" y="57" fill="#0f766e">SQLite：向量 BLOB + FTS5</text>
    <text x="83" y="197">问题</text>
    <text x="271" y="145">向量搜索</text>
    <text x="271" y="223">BM25 搜索</text>
    <text x="459" y="184">RRF 融合</text>
    <text x="647" y="184">重排</text>
    <text x="816" y="184">提示 → 大模型</text>
  </g>
  <g fill="none" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar-zh)">
    <path d="M158 52 H190"/>
    <path d="M346 52 H378"/>
    <path d="M534 52 H566"/>
    <path d="M83 118 V166"/>
    <path d="M158 197 C176 197 178 145 190 142"/>
    <path d="M158 197 C176 197 178 215 190 218"/>
    <path d="M346 140 C366 140 368 176 378 178"/>
    <path d="M346 218 C366 218 368 182 378 180"/>
    <path d="M534 179 H566"/>
    <path d="M722 179 H754"/>
  </g>
  <path d="M722 78 V150" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#ar-zh)"/>
  <text x="8" y="140" fill="#0f766e" font-size="11" letter-spacing="1.5">查询期 QUERY TIME</text>
</svg>
<figcaption>整个系统。提示词左边的全部是搜索，失败也就发生在这里。嵌入和 BM25 是同一批块的两种视角；RRF 和重排只能重新排列检索已经找出来的东西。</figcaption>
</figure>

## 分块决定了你的上限

一个块就是检索的最小单位。如果答案被切成了两块，那没有任何模型、任何重排、任何提示词能补救——检索器会把半截答案交给模型，模型会用想象把另一半补上。

我在同样的 12 篇文章上比了两种策略。天真的那种——固定 500 字符窗口、100 字符重叠——是大多数教程演示的做法。我用的这种是标题感知：按 `##`/`###` 切分，尽量保持整节完整，只有当一节超过约 900 字符时才开窗。

```python
def split_long(text, max_chars=900, overlap=120):
    """Split on paragraph boundaries first; hard-window anything still too big."""
    if len(text) <= max_chars:
        return [text]
    paras, cur, chunks = text.split("\n\n"), "", []
    for p in paras:
        if len(p) > max_chars:          # a giant block (code fence, list, table)
            if cur:
                chunks.append(cur); cur = ""
            step = max_chars - overlap
            for i in range(0, len(p), step):
                chunks.append(p[i:i + max_chars])
            cur = p[-overlap:]
            continue
        if cur and len(cur) + len(p) + 2 > max_chars:
            chunks.append(cur)
            cur = cur[-overlap:] + "\n\n" + p
        else:
            cur = (cur + "\n\n" + p) if cur else p
    if cur:
        chunks.append(cur)
    return chunks
```

输出本身就是论据：

```console
$ python chunk_compare.py
posts=12
fixed 500/100 : 455 chunks  p50=500 chars
heading-aware   : 313 chunks  p50=662 chars
fixed windows containing an odd number of ``` fences (split inside a code block): 155/455
```

三分之一的固定窗口把一个代码块从中间切开了。一个从 `bash` 围栏中间开始的块，已经丢掉了上下文，给它做嵌入几乎等于给噪声做嵌入。标题感知分块把 455 个块压到 313 个，而且每个块都知道自己从哪来。

我还会在**嵌入之前**把文章标题和标题路径拼到每个块前面。这是性价比最高的一招——块不再是一段匿名的文字，它开始自带标签：

````text
Bash strict mode and the mistakes that bite in production — What bash strict mode actually buys you / `-e` (`errexit`): stop on a failed command

Without it, a failure is just a line that prints an error and moves on:

```bash
#!/usr/bin/env bash
rm -f priceless.txt
cp missing-source.txt priceless.txt   # fails
echo "backup looks done"
```
````

## 嵌入：一张地图，不是一次查表

**嵌入**把语义压缩成一个定长向量，用余弦相似度衡量两段意思有多近。一个好的嵌入模型会把「命令失败时让脚本停下来」放到「set -e」旁边，哪怕两句话没有一个共同的词。价值就在这里：它按意思搜，不按拼写搜。

这个实验里我用了一个真正很小的模型——`minishlab/potion-base-8M`，一个 **256 维**的静态嵌入模型。它不是哈希小把戏，而是一个蒸馏过的句子嵌入模型。它在 CPU 上毫秒级跑完，不需要 GPU。对一个小语料来说它绰绰有余；如果不够，换掉它只是改一行的事。

把向量以 blob 存进 SQLite，在 Python 里算余弦。几千个块是瞬间的事，而且你不需要再起一个服务：

```python
db.executescript("""
    CREATE TABLE chunks(
        id INTEGER PRIMARY KEY, slug TEXT, url TEXT, heading TEXT,
        part INTEGER, text TEXT, embed_text TEXT, dim INTEGER, vec BLOB);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
        embed_text, content='chunks', content_rowid='id',
        tokenize="unicode61 remove_diacritics 2");
""")
```

第二张表就是我后面要回来说的重点：SQLite 的 FTS5 让你在同一个文件里拿到真正的 BM25 关键词搜索，不多一个依赖。

## 真实检索：三个查询

语料是这个博客的 12 篇文章，313 个块，一个 1.3 MB 的 SQLite 文件。向量搜索是对 blob 算余弦；BM25 是 `bm25(chunks_fts)`；混合用倒数排名融合（RRF）把两者合并。第一个查询——一句没有任何共同关键词的改写：

```console
QUERY: how do I make a shell script stop when a command fails

### vector (potion-base-8M, cosine)
1. bash-strict-mode  score=0.716   § (intro)
2. systemd-unit-cookbook  score=0.672   § Restart=on-failure and the start limit
3. bash-strict-mode  score=0.671   § The one-paragraph summary
4. bash-strict-mode  score=0.633   § (intro)
5. bash-strict-mode  score=0.598   § ... / `-e` (`errexit`): stop on a failed command

### BM25 (SQLite FTS5)
1. bash-strict-mode  score=12.989   § (intro)
2. bash-strict-mode  score=12.723   § ... / `-e` (`errexit`): stop on a failed command
3. awk-and-sed  score=12.655   § When to stop and use Python or jq
4. bash-strict-mode  score=9.619   § What bash strict mode actually buys you
5. bash-strict-mode  score=9.215   § ... / A function, and the `local x=$(cmd)` trap
```

两个检索器都落在正确的文章上。向量搜索从没见过 `set -e` 这个词，却把严格模式的开头排到了第一——这就是嵌入在干活。BM25 也精确命中了 `errexit` 那一节，混合检索把两边都保住了。这才是 RAG 该有的样子。

第二个查询是两种方法分道扬镳的地方。它是密集的术语，而且**具体哪一节**很重要：

```console
QUERY: EXPLAIN ANALYZE Bitmap Heap Scan cost estimate vs actual rows

### vector (potion-base-8M, cosine)
1. postgres-explain  score=0.693   § (intro)
2. postgres-explain  score=0.654   § Node types worth knowing / seq scan vs index scan
3. postgres-explain  score=0.640   § Index-only scans: when the index *is* the query
4. postgres-explain  score=0.629   § Estimates vs actual rows: where the query planner lies
5. postgres-explain  score=0.610   § Node types worth knowing / seq scan vs index scan

### BM25 (SQLite FTS5)
1. postgres-explain  score=27.477   § EXPLAIN vs EXPLAIN ANALYZE vs BUFFERS
2. postgres-explain  score=27.066   § Node types worth knowing / seq scan vs index scan
3. postgres-explain  score=23.626   § Node types worth knowing / seq scan vs index scan
4. postgres-explain  score=23.274   § Node types worth knowing / nested loop vs hash join
5. postgres-index-types  score=22.103   § GIN vs GiST: ranges, geometry, and overlap
```

向量搜索找到了正确的**文章**，然后让泛泛的开头占了第一。BM25 直接命中标题就叫「EXPLAIN vs EXPLAIN ANALYZE vs BUFFERS」的那一节。当用户粘贴的是标识符、报错字符串或函数名时，关键词搜索不是怀旧——它就是更合适的工具。这和 [Postgres 全文搜索对比 Elasticsearch](/zh/posts/full-text-search/) 是同一课：排序是一个建模决策，而单一的排序器永远不够。

## 失败案例：自信地答错

下面是诚实的部分。第三个查询，我不是挑它来好看的。一个不知道那个头字段名字的用户会这样问：

```console
QUERY: which HTTP header tells the client it may resume a download

### vector (potion-base-8M, cosine)
1. http-range-requests  score=0.528   § Testing with curl -r
2. http-caching  score=0.524   § The layers of HTTP caching, and who obeys whom
3. http-range-requests  score=0.524   § (intro)
4. http-range-requests  score=0.519   § (intro)
5. http-range-requests  score=0.481   § Enabling it in nginx, and what quietly breaks it

### BM25 (SQLite FTS5)
1. http-range-requests  score=12.406   § Why a generated response usually can't do ranges
2. http-range-requests  score=11.682   § Multi-range requests: several slices in one response
3. http-range-requests  score=11.520   § Enabling it in nginx, and what quietly breaks it
4. http-caching  score=11.286   § The layers of HTTP caching, and who obeys whom
5. http-range-requests  score=10.975   § Why a generated response usually can't do ranges

### hybrid (RRF)
1. http-caching  score=0.032 [bm25+vec]   § The layers of HTTP caching, and who obeys whom
2. http-range-requests  score=0.030 [bm25+vec]   § Why download managers and video players depend on this
...
```

正确答案是标题为 **「Accept-Ranges, Range, Content-Range, 206 and 416 in one breath」** 的那一节，开头第一行加粗写着 `Accept-Ranges: bytes`。三个检索器没有一个把它找出来。向量没有，BM25 没有，混合也没有。向量搜索把那个块排在 **313 名里的第 43 名**——排在一堆毫不相关的块后面——而混合检索的**第一名**来自完全错误的文章（`http-caching`），因为它在两个榜单里都排得不错，而 RRF 恰恰奖励这种一致性。

把这五段喂给任何模型，它都会写出一段关于缓存的自信文字，因为它拿到的就是缓存。这就是被人误叫作「幻觉」的失败模式。模型不是凭空编造的答案，它是基于糟糕的检索在回答——而后者更糟，因为它看起来有出处。

## 在怪模型之前，先评测检索

你无法修复你从不测量的东西。建一个很小的标准集——20 个问题，每个配上一个能回答它的块——然后算 **recall@k**：正确的块有没有进前 *k*？只测检索本身，不放大模型。

```console
$ python evaluate.py
corpus: 313 chunks | recall@k = gold chunk present in top-k

query                                                       vec@1  vec@5  bm25@1  bm25@5  hyb@5  gold_rank(vec)
how do I make a shell script stop when a command fails          0      1       0       1      1   5/313
EXPLAIN ANALYZE Bitmap Heap Scan cost estimate vs actual        0      0       1       1      1   8/313
which HTTP header tells the client it may resume a downl        0      0       0       0      0  43/313
```

三个查询，正确块进前五的比例：向量 1/3，BM25 2/3，混合 2/3。第一个查询里，向量搜索的第一名是错的，但它的 recall@5 仍然是 1——这正是为什么你要先取 20 个候选，再让后面的环节排序，而不是取 3 个然后祈祷。第三个查询里，所有方法都失败了，而且再怎么调提示词也救不回来。

这也是为什么我把检索评测当成和 [评测 Agent 输出](/zh/posts/running-coding-agents/) 一样的纪律：先定义什么叫「对」，单独测量那个组件，然后才去怪它的上一层。

## 混合检索：BM25 依然重要

**混合检索**同时跑关键词和向量，再把两个排名列表合并。我用的是倒数排名融合（RRF），它不需要做分数校准——只看名次：

```python
RRF_K = 60
def hybrid_search(query, k=5):
    vec = vector_search(query, k=k * 3)
    bm = bm25_search(query, k=k * 3)
    fused = {}
    for rank, r in enumerate(vec, 1):
        fused.setdefault(r["id"], [r, 0.0])[1] += 1.0 / (RRF_K + rank)
    for rank, r in enumerate(bm, 1):
        fused.setdefault(r["id"], [r, 0.0])[1] += 1.0 / (RRF_K + rank)
    return sorted(fused.values(), key=lambda x: -x[1])[:k]
```

**BM25** 依然重要，因为它在嵌入模糊的地方是精确的。它能找到稀有词——`PIPESTATUS`、`Accept-Ranges`、`EXPLAIN ANALYZE`——而 256 维的向量会把它们压进「bash 那类东西」或「HTTP 那类东西」的大致邻域。嵌入在改写和意图上赢，BM25 在标识符和术语上赢。真实的查询两者都有，而且常常出现在同一句话里，所以默认应该是混合，而不是纯向量。

## 重排是性价比最高的升级

检索为了在几千个块上追求速度，本身就是近似的。重排是对前 50 个左右的候选做第二遍，用更慢、更准的打分器——一个 cross-encoder，或者让大模型给每段的相关性打分。你只为 50 次打分付钱，而不是 5 万次，就能在它们进入提示词之前修正大多数排序错误。拿上面第二个查询来说，对前五做重排，会把 BM25 本来就排第一、而向量埋到第八的 `EXPLAIN ANALYZE` 那一节提上来。等你有了召回率再加它；它救不回一个检索从没返回过的块。

## 我踩到的失败模式，按频率排序

- **坏块。** 答案被切在边界上、代码围栏被切成两半、标题和它的小节分家。解法：标题感知分块、上下文前缀、检查有没有落单的围栏。
- **嵌入不匹配。** 在散文上训练的模型，遇到代码、标识符或第二种语言就拉胯。解法：在**你自己的**查询上测召回率；换第二个模型试试。
- **没有重排。** 正确的块在第 12 名，永远进不了提示词。解法：取 20–50 个，重排到 5 个。
- **上下文稀释。** 十个平庸的块把唯一一个好块挤了出去，模型把它们平均了一下。解法：更少、更好的块——三段精确的胜过十段含糊的。
- **检索落空时的幻觉。** 查询返回了一堆看起来相关、其实没有答案的邻居，模型就自己填空。解法：检索之后要**检查**——如果最高分很低，就说「我不知道」，而不是硬生成。会拒答是一个特性。

## 什么时候你不需要 RAG

RAG 不是「用我的数据」的默认答案。有三种情况它是错的工具：

- **它放得进上下文窗口。** 如果你的知识库总共 30 页，直接贴进去。带真实文本的长上下文模型，胜过一条可能漏掉正确块的检索流水线。
- **问题是提示词，不是知识。** 如果模型已经有事实却答得不好，再加检索只会加噪声。去改指令。
- **任务是技能，不是查表。** 如果你需要的是在成千上万次调用里保持一致的风格、格式或行为，微调改变的是模型；检索做不到。

RAG 适用于中间那种情况：文本多到贴不进去，事实性强到不能只信权重，变化快到没法微调。

## 诚实的总结

整个东西我是在一个用完就扔的容器里搭的：一个 SQLite 文件、313 个块、一个 256 维嵌入模型、FTS5 做 BM25、RRF 做混合、recall@k 用来检查自己。然后我把容器和索引都删了，因为重点是那些数字，不是那个产物。

清理之后，结论留了下来。**RAG** 是一套搜索系统，末尾接了一个语言模型，而语言模型恰恰是你最不该去怪的那部分。好好分块。两个方向都检索。动提示词之前先测召回率。当检索空手而归时，教会模型说出来——对你根本没找到出处的问题给出一个自信的回答，是这条流水线里最贵的 bug。
