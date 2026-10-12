---
title: "pgvector: vector search in Postgres with HNSW, and when a vector DB is overkill"
description: "Embeddings are easy; storing them next to your data is not. I loaded 100,000 vectors into a throwaway Postgres 17 with pgvector 0.8.7, measured exact versus HNSW and IVFFlat ANN search, tuned ef_search and probes, hit the post-filter trap, and noted when a dedicated vector database is worth it."
pubDate: 2026-12-28
lang: en
translationKey: pgvector
tags: [ai, devops]
featured: false
keywords:
  - pgvector
  - vector search Postgres
  - HNSW
  - nearest neighbour search
  - embeddings
---

The default advice for "add semantic search" is to stand up a vector database — a second stateful system and sync pipeline, for data already sitting in Postgres. **pgvector** adds a `vector(N)` column type and approximate nearest-neighbour indexes to the database you already run, so **vector search Postgres** style gets joins, `WHERE` clauses, and transactions for free. This is the hands-on version: what **embeddings** and ANN search are for, how **HNSW** and IVFFlat behave, and when a dedicated vector DB is worth it. Everything below ran in a throwaway `pgvector/pgvector:pg17` container (PostgreSQL 17.11, pgvector 0.8.7) on `127.0.0.1`, over 100,000 deterministic 64-dimensional vectors.

## What embeddings and nearest neighbour search are actually for

An embedding model turns text, an image, or a user into a fixed-length list of floats — 64 or 768 of them — positioned so semantically similar things land near each other. **Nearest neighbour search** is then: given a query vector, find the *k* rows whose vectors are closest. Exact search is brute force, `O(N · d)` per query: fine at 100k rows of 64 dims, minutes per query at ten million rows of 1536 dims. So we use **approximate** nearest neighbour (ANN) indexes and trade a little accuracy, called **recall**, for orders of magnitude of speed.

## Why vector search in Postgres is usually enough

The pitch for a separate vector DB is performance. The reality for most apps is that the embedding is one more column on a row you already have:

- **Your data is already in Postgres.** The vector lives next to the document, tenant id, timestamp, and permissions — no second source of truth, no sync job, no stale-index bug.
- **Joins, filters, and transactions come free.** `WHERE tenant_id = $1 AND created_at > now() - interval '30 days' ORDER BY embedding <-> $2 LIMIT 10` is one query and one round trip.
- **The ops surface is one you already run.** Same backups, monitoring, pool, and replicas. Same accounting as [database indexing basics](/posts/database-indexing/): an index trades write cost for read speed.
- **It scales further than people assume.** Millions of vectors on a single node is routine.

The honest caveats: ANN indexes are approximate, and filtering interacts with them badly — both measured below. The broader case for keeping search in the database is in [Postgres full-text search](/posts/full-text-search/).

## The lab: 100,000 deterministic vectors in a throwaway Postgres

I generated vectors deterministically from `md5` hashes — a cluster centre per category plus per-row noise — so every number is reproducible from the SQL and clearly labelled synthetic. The shape (clustered, 64 dims, 8 categories, 100k rows, 33 MB) is what matters.

```sql
CREATE FUNCTION det_vec(seed text, dim int, scale float8 DEFAULT 1.0) RETURNS vector
LANGUAGE sql IMMUTABLE AS $$
  SELECT ('[' || string_agg(round(((('x'||substr(md5(seed||':'||i),1,8))::bit(32)::int::float8
          /2147483647.0 - 0.5) * 2 * scale)::numeric,6)::text, ',' ORDER BY i) || ']')::vector
  FROM generate_series(0, dim-1) i;
$$;

CREATE TABLE items (id int PRIMARY KEY, category text, body text, embedding vector(64));
INSERT INTO items SELECT g, cats[1+(g%8)], 'doc '||g,
       det_vec('c:'||cats[1+(g%8)],64) + det_vec('n:'||g,64,0.35)   -- centre + noise
FROM generate_series(1,100000) g, (SELECT ARRAY['databases','networking','security','ai',
     'linux','astro','devops','embedded'] AS cats) c;
-- 100000 rows | 8 categories | 33 MB
```

## Distance operators, normalization, and cosine vs L2

pgvector gives you `<->` (L2/Euclidean), `<=>` (cosine), and `<#>` (negative inner product, negated so smaller still sorts first):

```sql
SELECT '[-1,0,0]'::vector <-> '[1,0,0]'::vector AS l2,        -- 2
       '[-1,0,0]'::vector <=> '[1,0,0]'::vector AS cosine,    -- 2   (1 - (-1))
       '[-1,0,0]'::vector <#> '[1,0,0]'::vector AS neg_inner; -- 1   (-(1 * -1))
```

Cosine is scale-invariant; L2 is not. Normalize your vectors to unit length and the two rank identically, with an exact relation: `l2_distance² = 2 · cosine_distance`.

```sql
WITH t AS (SELECT id, embedding, l2_normalize(embedding) AS e FROM items WHERE id IN (88656,37387,1))
SELECT a.id AS a, b.id AS b,
       round((a.embedding <-> b.embedding)::numeric,4) AS l2_raw,   -- 12.3826
       round((a.embedding <=> b.embedding)::numeric,4) AS cos_raw,  --  0.3598
       round((a.e <-> b.e)::numeric,4)                 AS l2_norm,  --  0.8482 = sqrt(2*0.3598)
       round((a.e <=> b.e)::numeric,4)                 AS cos_norm  --  0.3598
FROM t a, t b WHERE a.id < b.id;
```

Most embedding APIs already return unit vectors. Pick the operator that matches your model and build the index with the matching opclass (`vector_l2_ops`, `vector_cosine_ops`, `vector_ip_ops`) — the planner only uses an index whose opclass matches your `ORDER BY` operator.

## Exact nearest neighbour search is a sequential scan

Without an index, `ORDER BY embedding <-> q LIMIT 10` cannot stop early: Postgres scores every row, then sorts. The plan is a parallel sequential scan — **23 ms warm** (89 ms on the first, cold run):

```sql
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
SELECT id FROM items ORDER BY embedding <-> (SELECT v FROM q) LIMIT 10;

 Limit (actual rows=10 loops=1)
   ->  Gather Merge (actual rows=10 loops=1)          Workers Launched: 2
         ->  Sort (actual rows=8 loops=3)             Sort Method: top-N heapsort
               ->  Parallel Seq Scan on items (actual rows=33333 loops=3)
 Execution Time: 22.566 ms
```

At 100k × 64 that is tolerable; the point is the slope — double the rows, double the scan. At millions of 768-dim vectors this is seconds per query, and no B-tree helps: there is no ordering to index, so every row is a candidate.

<figure>
<svg viewBox="0 0 680 220" width="100%" role="img" aria-label="A text query is turned into an embedding vector, inserted into an HNSW graph index, and an approximate nearest neighbour search returns the top k rows ordered by distance.">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.45">
      <rect x="20" y="80" width="160" height="64" rx="8"/>
      <rect x="260" y="80" width="160" height="64" rx="8"/>
      <rect x="500" y="80" width="160" height="64" rx="8"/>
    </g>
    <rect x="260" y="80" width="160" height="64" rx="8" fill="none" stroke="#0f766e" stroke-width="2"/>
    <text x="100" y="55" text-anchor="middle" font-size="12" opacity="0.75">embed</text>
    <text x="340" y="55" text-anchor="middle" font-size="12" opacity="0.75">index</text>
    <text x="580" y="55" text-anchor="middle" font-size="12" opacity="0.75">search</text>
    <text x="100" y="106" text-anchor="middle" font-size="12" font-family="ui-monospace, monospace">"pg tips"</text>
    <text x="100" y="126" text-anchor="middle" font-size="11" font-family="ui-monospace, monospace">→ vector(64)</text>
    <text x="340" y="106" text-anchor="middle" font-size="12" font-family="ui-monospace, monospace">HNSW graph</text>
    <text x="340" y="126" text-anchor="middle" font-size="11">layers of neighbours</text>
    <text x="580" y="106" text-anchor="middle" font-size="12" font-family="ui-monospace, monospace">&lt;-&gt; q LIMIT k</text>
    <text x="580" y="126" text-anchor="middle" font-size="11">top-k rows</text>
    <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.7">
      <line x1="180" y1="112" x2="255" y2="112"/><path d="M250 108 l6 4 -6 4"/>
      <line x1="420" y1="112" x2="495" y2="112"/><path d="M490 108 l6 4 -6 4"/>
    </g>
    <text x="340" y="180" text-anchor="middle" font-size="12" fill="#0f766e">ANN: walk a few neighbours instead of scoring every row</text>
    <g stroke="#0f766e" stroke-width="1.5" fill="none" opacity="0.8">
      <line x1="340" y1="144" x2="340" y2="164"/><path d="M336 159 l4 6 4 -6"/>
    </g>
  </g>
</svg>
<figcaption>Embeddings turn meaning into coordinates; an ANN index turns "score every row" into "walk a promising path". pgvector keeps both inside the database you already operate.</figcaption>
</figure>

## HNSW: the index that turns a scan into a search

An **HNSW** index is a multi-layer proximity graph: enter at the top, greedily descend toward the query, collect candidates. It gives strong recall and low latency, and unlike IVFFlat it can be built on an empty table and stays useful as rows arrive.

```sql
CREATE INDEX idx_items_hnsw ON items USING hnsw (embedding vector_l2_ops);
-- NOTICE: hnsw graph no longer fits into maintenance_work_mem after 67056 tuples
-- CREATE INDEX   Time: 45384.957 ms          index size: 54 MB

EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
SELECT id FROM items ORDER BY embedding <-> (SELECT v FROM q) LIMIT 10;

 Limit (actual rows=10 loops=1)
   ->  Index Scan using idx_items_hnsw on items (actual rows=10 loops=1)
         Order By: (embedding <-> (InitPlan 1).col1)
 Execution Time: 1.624 ms        -- 3.9 ms median across repeated runs
```

Two honest notes. The build cost is real: **45–64 s** and a **54 MB** index (larger than the 33 MB table) because the default `maintenance_work_mem` filled after 67k rows and the rest spilled to disk — raising it, and the container's `shm_size`, is the fix. And a **6×** speedup at 100k rows is unimpressive on purpose: the parallel seq scan is already cheap here. HNSW's edge grows with `N`. Defaults: `m = 16`, `ef_construction = 64`.

## IVFFlat vs HNSW: build, size, recall, latency

IVFFlat partitions vectors into `lists` k-means clusters and searches only the `probes` nearest ones. It is cheap to build and smaller, but needs representative data to exist *before* you build it, and degrades as rows are added without a rebuild. On my 100k rows, `lists = 100`: `probes = 1` returned 1 of the true top-10 in 0.54 ms; `probes = 10` returned 9 of 10 in ~4 ms; `probes = 100` (every list) returned all 10 in ~41 ms.

| | HNSW | IVFFlat |
|---|---|---|
| Build time (100k) | 45–64 s | 4.3 s |
| Index size | 54 MB | 27 MB |
| Build on empty table | yes | no (needs data first) |
| Recall knob | `hnsw.ef_search` | `ivfflat.probes` |
| Insert behaviour | good | degrades without rebuild |

Rule of thumb: **HNSW** when you need the best recall and can afford a slower, larger build; **IVFFlat** when the table is mostly static, you are memory-constrained, or you rebuild on a schedule.

## Tuning recall: `ef_search` and `probes` are the dial

For HNSW, `ef_search` is the query-time candidate list — bigger means more work and better recall. I ran 20 query vectors, compared each approximate top-10 against the exact top-10 (index scans disabled, so the ground truth is a real seq scan), and measured single-query latency separately:

| `hnsw.ef_search` | recall@10 | median latency |
|---|---|---|
| 1 | 5% | 0.8 ms |
| 10 | 42% | 1.9 ms |
| **40 (default)** | **77%** | **3.9 ms** |
| 100 | 94% | 5.8 ms |
| 200 | 98% | 7.6 ms |
| exact (no index) | 100% | 23 ms |

Read the default row carefully: out of the box, on this deliberately hard clustered set, HNSW returned **77% of the true top-10**. If you never touch `ef_search`, your "top 10" is not the top 10. `SET hnsw.ef_search = 100` buys 94% recall for 5.8 ms — still 4× faster than exact. It is per-session, so raise it for a slow, high-quality path and leave it low for autocomplete.

Recall is therefore a product decision, not a database setting. On my test query the exact 10th neighbour was `80720` at distance `3.3353`, while the default HNSW search returned `76040` at `3.3489` — a near-miss, exactly the kind of invisible error you are accepting. A "similar documents" widget tolerates 90% recall; a dedup job that must never miss a near-duplicate does not — there you raise `ef_search`/`probes` to near 100% or pay for the exact scan.

## Filtering + vector search: the post-filter trap

This is the failure mode that bites people. HNSW finds the nearest *rows*, then Postgres applies your `WHERE`. If the filter is selective and the nearest rows do not match, the index returns fewer than *k* — or zero.

```sql
SET hnsw.ef_search = 40;  SET hnsw.iterative_scan = off;
SELECT id, category FROM items WHERE category = 'ai'
ORDER BY embedding <-> (SELECT v FROM q) LIMIT 10;

 Limit (actual rows=0 loops=1)
   ->  Index Scan using idx_items_hnsw on items (actual rows=0 loops=1)
         Filter: (category = 'ai'::text)      Rows Removed by Filter: 40
 Execution Time: 4.090 ms
```

Fast and completely wrong: it scanned 40 candidates, filtered out all of them, returned nothing. pgvector 0.8 fixes this with **iterative scans** — keep scanning until you have *k* matching rows:

```sql
SET hnsw.iterative_scan = relaxed_order;
SET hnsw.max_scan_tuples = 100000;   -- default 20000; raise for selective filters

 Limit (actual rows=10 loops=1)
   ->  Index Scan using idx_items_hnsw on items (actual rows=10 loops=1)
         Filter: (category = 'ai'::text)      Rows Removed by Filter: 16000
 Execution Time: 96.251 ms
```

Now it returns 10 rows in 96 ms, 8 of 10 matching the exact filtered answer. Filtered vector search is a different workload: for a filter most rows pass, a plain `WHERE` is fine; for a selective one, iterative scanning makes results correct at the cost of a much larger scan. If a filter is central to your pattern, a partial index (`... WHERE category = 'ai'`) is often cleaner.

## pgvector vs a dedicated vector DB: the decision list

Stay with **pgvector** when your data is already in Postgres; you need joins, transactions, or `WHERE` filters alongside the vector; you are in the millions-of-vectors range; you value one system to back up and monitor; and you can tune `ef_search` and filtered search.

Reach for a **dedicated vector DB** (Qdrant, Milvus, Weaviate, and friends) when at least one is genuinely true:

1. **Scale beyond one node.** Hundreds of millions to billions of vectors, sharded across machines, with horizontal write throughput — pgvector is single-node.
2. **Aggressive compression is the point.** Binary and product quantization to fit billions of vectors in RAM; pgvector keeps full-precision vectors and a large graph.
3. **Built-in hybrid search and rich filtering.** Tuned BM25 + vector fusion, multi-tenant isolation, per-field filtering as first-class features.
4. **You are memory- and build-bound, or ops are not your constraint.** More control over index memory, quantization, and build scheduling — or you already run the cluster.

None of those is "I want fast similarity search". At a hundred thousand or a few million vectors, pgvector answers that in one query on the database you already run.

## The short version

Add a `vector(N)` column, store your embeddings, and start with an exact `ORDER BY embedding <-> $1 LIMIT k`. When it gets slow, add an **HNSW** index, raise `ef_search` until recall is good enough, and handle selective filters with iterative scans or partial indexes. Watch build time and index size, and measure recall against a real ground truth instead of trusting the default. Only reach for a dedicated vector DB when scale, compression, or hybrid search is the actual bottleneck.

All of this ran in a throwaway `pgvector/pgvector:pg17` container on `127.0.0.1`, torn down afterwards. Your hardware will differ, but the shapes, the trade-offs, and the post-filter trap are the same everywhere.
