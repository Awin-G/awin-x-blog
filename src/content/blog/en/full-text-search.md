---
title: "Postgres full-text search vs Elasticsearch: when you don't need the cluster"
description: "A hands-on comparison of Postgres full-text search and Elasticsearch on the same corpus: tsvector, tsquery, ts_rank, GIN indexes, pg_trgm for typo search, real EXPLAIN plans and ES responses, what Postgres does not do, and the decision rule for when a search cluster earns its keep."
pubDate: 2026-12-16
lang: en
translationKey: full-text-search
tags: [devops, linux]
featured: false
keywords:
  - Postgres full-text search
  - Postgres vs Elasticsearch
  - tsvector
  - pg_trgm
  - GIN index
---

The default advice for "add search" is to stand up Elasticsearch. For a blog, a small SaaS, or an internal tool, that is usually a cluster, an index mapping, a sync pipeline, and an on-call rotation you did not ask for. **Postgres full-text search** already turns a text column into ranked results in a few lines, with no second service to run. This is the honest version of **Postgres vs Elasticsearch**: what `tsvector`, `tsquery`, `ts_rank`, a **GIN index**, and `pg_trgm` actually do, where Postgres stops being enough, and the decision rule for when a search engine is genuinely worth it. Every number below is real — I ran a throwaway Postgres 17 and a single-node Elasticsearch 8.15 over the same corpus, and pasted the output verbatim.

## Postgres full-text search in five minutes: `tsvector`, `tsquery`, and GIN

Postgres never searches raw text. It converts a document into a `tsvector` — a sorted list of normalized lexemes with positions — and converts a user string into a `tsquery` — a boolean expression over lexemes. The `@@` operator asks whether the vector matches the query.

```sql
SELECT to_tsvector('english', 'The running dogs are running, and the database was indexed');

               to_tsvector
------------------------------------------
 'databas':8 'dog':3 'index':10 'run':2,5
```

Notice three things already: `running` became `run`, `database` lost its vowels, and stopwords like `the` and `are` were dropped. That is the dictionary doing stemming. `plainto_tsquery` turns friendly input into a safe query without you writing operators:

```sql
SELECT plainto_tsquery('english', 'full text search');
           plainto_tsquery
-------------------------------------
 'full' & 'text' & 'search'
```

Searching is one line, and ranking is a second. `ts_rank` scores each match; `setweight` lets the title count for more than the body:

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

That is a real relevance signal — the title match outranks the body-only match, and two genuine matches beat the third. No cluster required.

## The GIN index is what makes it fast

Without an index, `@@` evaluates `to_tsvector` on every row. On 200,000 documents, that is a parallel sequential scan and **5.5 seconds**:

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

A single **GIN index** over the same expression changes the plan to a bitmap index scan and drops the time to **84 ms** — about 65× — for an index that is 4 MB against a 44 MB table:

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

The GIN index took 11.8 s to build on those 200k rows — a one-time cost, and the trade-off is that every `INSERT` and `UPDATE` now maintains it. This is the same ledger you keep for any index; see [Database indexing basics](/posts/database-indexing/) for the write-cost accounting.

<figure>
<svg viewBox="0 0 660 210" width="100%" role="img" aria-label="A query string is normalized into a tsquery, matched against a GIN index of tsvector lexemes, then ranked with ts_rank to produce ordered results.">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.45">
      <rect x="20" y="70" width="130" height="60" rx="8"/>
      <rect x="265" y="70" width="130" height="60" rx="8"/>
      <rect x="510" y="70" width="130" height="60" rx="8"/>
    </g>
    <rect x="265" y="70" width="130" height="60" rx="8" fill="none" stroke="#0f766e" stroke-width="2"/>
    <text x="85" y="45" text-anchor="middle" font-size="12" opacity="0.75">input</text>
    <text x="330" y="45" text-anchor="middle" font-size="12" opacity="0.75">normalize</text>
    <text x="575" y="45" text-anchor="middle" font-size="12" opacity="0.75">rank</text>
    <text x="85" y="96" text-anchor="middle" font-size="12" font-family="ui-monospace, monospace">"search index"</text>
    <text x="330" y="90" text-anchor="middle" font-size="12" font-family="ui-monospace, monospace">'search' &amp; 'index'</text>
    <text x="330" y="110" text-anchor="middle" font-size="11" font-family="ui-monospace, monospace">tsquery</text>
    <text x="575" y="90" text-anchor="middle" font-size="12" font-family="ui-monospace, monospace">ts_rank DESC</text>
    <text x="575" y="110" text-anchor="middle" font-size="11">top-k rows</text>
    <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.7">
      <line x1="150" y1="100" x2="260" y2="100"/><path d="M255 96 l6 4 -6 4"/>
      <line x1="395" y1="100" x2="505" y2="100"/><path d="M500 96 l6 4 -6 4"/>
    </g>
    <text x="330" y="165" text-anchor="middle" font-size="12" fill="#0f766e">GIN index: lexeme → posting list of row ids</text>
    <g stroke="#0f766e" stroke-width="1.5" fill="none" opacity="0.8">
      <line x1="330" y1="130" x2="330" y2="150"/><path d="M326 145 l4 6 4 -6"/>
    </g>
  </g>
</svg>
<figcaption>The shape of every full-text query: normalize the input into a tsquery, turn lexemes into row ids through the GIN index, then score and sort. Elasticsearch does the same three steps — it just runs them as a separate distributed service.</figcaption>
</figure>

## Stemming, dictionaries, and the typo it accidentally absorbs

`to_tsvector('english', ...)` uses the Snowball English stemmer plus a stopword list. That is why `running`, `runs`, and `run` collapse to `run` — a real relevance win that a naive `ILIKE '%run%'` cannot match. But stemming is not spell-correction, and it is worth seeing where the line is:

```sql
SELECT to_tsvector('english','postgres')   AS correct,
       to_tsvector('english','postgrs')    AS typo_suffix,
       to_tsvector('english','postgeres')  AS typo_infix;
  correct   | typo_suffix |  typo_infix
------------+-------------+-------------
 'postgr':1 | 'postgr':1  | 'postger':1
```

`postgrs` happens to stem to `postgr`, the same as `postgres`, so this *suffix* typo is masked by luck. `postgeres` does not — its lexeme is `postger`, which matches nothing. Stemming is morphology, not fuzzy matching, and the difference shows up the moment a typo lands in the middle of a word.

## `pg_trgm`: real fuzzy and typo-tolerant search

For actual typo tolerance in Postgres, reach for the **pg_trgm** extension. It breaks strings into three-character grams and measures overlap, so `postgrs` still finds `Postgres`:

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

`<%` (word similarity) is the useful operator here: it asks whether the pattern resembles *any* word in the document, rather than the whole string at once. A GIN index with `gin_trgm_ops` makes `%`, `<%`, and `LIKE '%...%'` searches index-backed instead of sequential scans. So Postgres *can* do typo search — it just is not on by default, and it is a separate index with its own cost.

## What Postgres full-text search does not do

This is the part the enthusiastic blog posts skip:

- **Typo tolerance is opt-in.** You must add `pg_trgm` and design around it; ES gives you `fuzziness` on every field for free.
- **Facets and aggregations are your job.** There is no `terms` aggregation; you write `GROUP BY` over expressions and it runs at query time, not from a precomputed structure. ES builds aggregations into the engine.
- **Scale is single-node.** Postgres full-text scales vertically and with read replicas. For billions of documents across many nodes with shard-level parallelism, an engine designed as a distributed inverted index is the right tool.
- **Relevance tuning is shallow.** `ts_rank` and weights are coarse. ES has BM25 with tunable k1/b, function scores, boosting, and per-field analysis. If relevance is your product, that gap matters.
- **Highlighting exists, but modestly.** Be fair to Postgres: `ts_headline` does produce snippets — `ts_headline('english', body, to_tsquery('english','tsvector|tsquery'), 'StartSel=<b>, StopSel=</b>')` returned `Postgres can build a <b>tsvector</b> ... with <b>tsquery</b>`. It is just not as fast or as configurable as ES `highlight`.
- **Cross-language analyzers and custom pipelines** are limited to what dictionaries and extensions you install.

## Postgres vs Elasticsearch on the same 200k-document corpus

I indexed the same 200,000 generated documents into both. The Elasticsearch numbers come from a single-node 8.15 container, 512 MB heap, security disabled, one shard — which is *not* a real cluster, and I will say so again below.

| Dimension | Postgres full-text | Elasticsearch |
|---|---|---|
| Setup | built in, zero extra services | container/cluster + mapping + client |
| Typo tolerance | `pg_trgm`, explicit index | `fuzziness` per field, built in |
| Ranking | `ts_rank` + `setweight` (coarse) | BM25, function scores, boosting |
| Facets/aggregations | hand-written `GROUP BY` at query time | `terms`/`date_histogram` aggs, engineered |
| Highlighting | `ts_headline` | `highlight`, fast and configurable |
| 200k-doc index size | 4 MB GIN (+ 44 MB table) | 27.6 MB store |
| 200k-doc build time | 11.8 s GIN build | ~25 s bulk load (~7,900 docs/s) |
| Query on 200k docs | 33–99 ms (bitmap index scan) | 2–43 ms (filter cache warm) |
| Distributed scale | read replicas | shards across nodes |
| Transactions, joins, FKs | yes, native | no |
| Ops surface | one process you already run | cluster, heap, shards, sync |

The equivalent Elasticsearch query and the facet are genuinely pleasant:

```jsonc
// ranked search with highlighting
POST /docs2/_search
{ "query": { "multi_match": { "query": "search index", "fields": ["title^2","body"] } },
  "highlight": { "fields": { "body": {} } }, "size": 3 }
// → 5.2047 "Database indexing basics"  hl: A composite <em>index</em> ...
// → 3.5337 "Fuzzy search with pg_trgm"
// → 3.1022 "Full text search with tsvector"  hl: A GIN <em>index</em> makes it fast.

// facet
{ "size": 0, "query": { "match": { "body": "query" } },
  "aggs": { "by_topic": { "terms": { "field": "topic", "size": 5 } } } }
// → total hits: 2   databases: 2
```

The facet returned `databases: 2`, matching the `GROUP BY` I hand-wrote in Postgres. Fuzzy search `postgrs` returned `Running Postgres in production` and `Postgres full text search ranking` with no configuration at all. On 200k documents, both databases were in the tens of milliseconds — on this scale, the performance gap is not the reason to choose.

## The operational cost of a search cluster for a small app

Here is what the table does not show. The Postgres column is a process you probably already run, already back up, already monitor, and already have a connection pool for. The Elasticsearch column is a second stateful system with its own failure modes:

- **A second source of truth.** Your data lives in Postgres and is *copied* into the index. You now need a sync path, and to decide what happens when it falls behind or a write fails halfway.
- **JVM and heap tuning.** I had to cap the heap at 512 MB to keep the container sane; production means thinking about heap sizing, GC, and the field data cache.
- **Cluster knowledge.** Shards, replicas, reindexing, mapping changes that require a rebuild, split-brain, and version upgrades with breaking changes.
- **The machine cost.** Even a single tiny node needs a few hundred MB of RAM to sit idle. On a VPS where the whole app might be 1 GB, that is the difference between a $5 plan and a $20 one.

For a small app, that is a real tax paid every month for a feature Postgres could have delivered in an afternoon. This is the same trade as [SQLite is enough](/posts/sqlite-is-enough/): the small option is usually the right one until a specific measured need says otherwise.

## The decision rule: start with Postgres

Start with Postgres full-text search. Build the `tsvector`, add the GIN index, rank with `ts_rank`, and add `pg_trgm` when users start making typos. Run it under your real load and measure.

Reach for a search engine only when one of these is actually true:

1. **Facets and aggregations are the product.** Filters, ranges, counts on top of counts — the query-time `GROUP BY` becomes the bottleneck, and a purpose-built engine wins.
2. **Relevance is competitive.** You are tuning BM25, boosting fields, running A/B tests on ranking. Postgres gives you a coarse knob; ES gives you a console.
3. **Scale demands distribution.** Billions of documents, high write throughput, shard-level parallelism, and cross-node availability — that is beyond a single Postgres.
4. **The language/text pipeline is the hard part.** Many languages, custom analyzers, tokenizers, synonyms, and n-grams as first-class concepts.

Until one of those is true, the cluster is a second system to operate for a feature you could ship in a Postgres query. The right answer for "add search" is usually the database you already have.
