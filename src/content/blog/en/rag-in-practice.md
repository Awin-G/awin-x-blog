---
title: "RAG in practice: it's mostly a search problem"
description: "I built a tiny retrieval system over this blog's own posts — SQLite, 256-dim embeddings, BM25, RRF — and pasted the real output. Three queries, one that fails completely. What RAG actually is, why chunking and retrieval quality dominate everything, and when you do not need RAG at all."
pubDate: 2026-12-27
lang: en
translationKey: rag-in-practice
tags: [ai, python]
featured: true
keywords:
  - RAG
  - retrieval augmented generation
  - embeddings
  - chunking
  - hybrid search
---

Every argument I hear about **RAG** is about the wrong layer. People debate which LLM, which embedding model, whether to fine-tune — while the thing that decides whether **retrieval augmented generation** works at all is the search step in front of it. RAG is not a model. It is a search problem wearing a machine-learning costume: find the few passages that answer the question, put them in the context window, and let the model read them. When it breaks, it almost never breaks at generation. It breaks because the right passage was never retrieved.

I did not want to write that from memory. So I built a tiny retrieval system over this blog's own posts — SQLite, a 256-dimension embedding model, BM25 through SQLite's FTS5, and a hybrid merge — and pasted the real output below. It includes one query where the search fails outright, and I kept it in.

## What RAG actually is

**Retrieval augmented generation** is two steps, in this order: retrieve, then generate. Nothing is trained. No weights change. You take a question, run a search over your own documents, and paste the top passages into the prompt with a short instruction: answer using these.

That is the whole trick, and it is why RAG is cheap and why it is fragile. Cheap, because you can point it at documents you wrote five minutes ago. Fragile, because the model can only reason over what the search hands it. If the search returns the wrong five chunks, a frontier model will write a fluent, confident, wrong answer — and cite the wrong chunk while doing it.

The hype version says "give the model your data." There is no such switch. There is a search index, a chunking policy, and a ranking function, and the quality of those three is the quality of your RAG.

## The pipeline: chunk → embed → store → retrieve → rerank → prompt

Six steps, and they are not equally important:

1. **Chunk** — cut documents into retrieval-sized units.
2. **Embed** — turn each chunk into a vector.
3. **Store** — put vectors and text somewhere queryable (SQLite is enough).
4. **Retrieve** — find candidate chunks (vector search, keyword search, or both).
5. **Rerank** — reorder the candidates with a slower, better scorer.
6. **Prompt** — assemble the winners into the context window.

Steps 1 and 4 decide the outcome. Steps 2, 3, and 6 are mostly plumbing, and step 5 is a cheap upgrade you can add later. Most "RAG is bad" complaints are step 1 and step 4 complaints.

<figure>
<svg viewBox="0 0 880 260" role="img" aria-label="Two-row RAG pipeline. Index time: corpus, chunk, embed, store in SQLite with vectors and FTS5. Query time: question goes to vector search and BM25 in parallel, results are fused with RRF, reranked, then placed in the prompt for the LLM." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px">
  <defs>
    <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <text x="8" y="20" fill="#0f766e" font-size="11" letter-spacing="1.5">INDEX TIME</text>
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
    <text x="83" y="57">corpus</text>
    <text x="271" y="57">chunk</text>
    <text x="459" y="57">embed</text>
    <text x="722" y="57" fill="#0f766e">SQLite: vec BLOB + FTS5</text>
    <text x="83" y="197">question</text>
    <text x="271" y="145">vector search</text>
    <text x="271" y="223">BM25 search</text>
    <text x="459" y="184">RRF fuse</text>
    <text x="647" y="184">rerank</text>
    <text x="816" y="184">prompt → LLM</text>
  </g>
  <g fill="none" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)">
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
  <path d="M722 78 V150" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#ar)"/>
  <text x="8" y="140" fill="#0f766e" font-size="11" letter-spacing="1.5">QUERY TIME</text>
</svg>
<figcaption>The whole system. Everything to the left of the prompt is search, and that is where the failures live. Embeddings and BM25 are two views of the same chunks; RRF and reranking only reorder what retrieval already found.</figcaption>
</figure>


## Chunking decides your ceiling

A chunk is the unit of retrieval. If an answer is split across two chunks, no model, no reranking, and no prompt fixes it — the retriever will hand the model half an answer, and the model will fill the other half in from imagination.

I compared two policies over the same 12 posts. The naive one — fixed 500-character windows with 100 characters of overlap — is what most tutorials show. The one I used is heading-aware: split on `##`/`###`, keep the section together, and only window a section if it exceeds ~900 characters.

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

The output is the argument:

```console
$ python chunk_compare.py
posts=12
fixed 500/100 : 455 chunks  p50=500 chars
heading-aware   : 313 chunks  p50=662 chars
fixed windows containing an odd number of ``` fences (split inside a code block): 155/455
```

A third of the fixed windows cut a code block in half. A chunk that starts in the middle of a `bash` fence has lost its context; embedding it is close to embedding noise. Heading-aware chunking cut 455 chunks to 313, and every chunk knows where it came from.

I also prepend the post title and the heading path to every chunk *before* embedding it. This is the cheapest retrieval win available — the chunk stops being an anonymous paragraph and starts carrying its own label:

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

## Embeddings: a map, not a lookup

**Embeddings** compress meaning into a fixed-length vector, and cosine similarity measures how close two meanings are. A good embedding model puts "stop the script when a command fails" near "set -e" even though the two share no words. That is the whole value: it searches by meaning, not spelling.

For this experiment I used a genuinely tiny model — `minishlab/potion-base-8M`, a static embedding model with **256 dimensions**. It is not a hash trick; it is a distilled sentence embedding. It runs on CPU in milliseconds and needs no GPU. For a small corpus it is more than enough, and if it is not, swapping it is a one-line change.

Store the vectors as blobs in SQLite and compute cosine in Python. For a few thousand chunks that is instant, and you avoid running a second service:

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

That second table is the point I will come back to: SQLite's FTS5 gives you real BM25 keyword search in the same file, with no extra dependency.

## Real retrieval: three queries

The corpus is 12 posts from this blog, 313 chunks, one 1.3 MB SQLite file. Vector search is cosine over the blobs; BM25 is `bm25(chunks_fts)`; hybrid fuses the two with Reciprocal Rank Fusion. Here is the first query — a paraphrase with no shared keywords:

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

Both retrievers land on the right post. The vector search never sees the word `set -e`, yet ranks the strict-mode intro first — that is the embedding doing its job. BM25 also finds the exact `errexit` section, and hybrid keeps both. This is what RAG is supposed to look like.

The second query is where the two methods split. It is dense jargon, and the *exact* section matters:

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

Vector search finds the right *post* and then fills its top slot with the generic intro. BM25 goes straight to the section literally titled "EXPLAIN vs EXPLAIN ANALYZE vs BUFFERS." When a user pastes identifiers, error strings, or function names, keyword search is not nostalgia — it is the better tool. This is the same lesson as [Postgres full-text search vs Elasticsearch](/posts/full-text-search/): ranking is a modelling decision, and one ranker is never enough.

## The failure: confidently wrong

Now the honest part. Third query, and I did not pick it to be flattering. A user who does not know the header name asks:

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

The correct answer is the section titled **"Accept-Ranges, Range, Content-Range, 206 and 416 in one breath"**, which opens with `Accept-Ranges: bytes` in bold. None of the three retrievers returns it. Not vector, not BM25, not the hybrid. The vector search ranks that chunk **43rd of 313** — below a dozen unrelated chunks — and the hybrid's *first* result is from the wrong post entirely (`http-caching`), because it scored respectably in both lists and RRF rewards agreement.

Feed those five chunks to any model and it will write a confident paragraph about caching, because caching is what it was handed. That is the failure mode people mislabel as hallucination. The model did not invent the answer from nothing; it answered from bad retrieval, which is worse, because it looks sourced.

## Evaluate retrieval before blaming the model

You cannot fix retrieval you do not measure. Build a tiny gold set — 20 questions, each with the one chunk that answers it — and compute **recall@k**: is the gold chunk in the top *k*? Do it on retrieval alone, with no LLM in the loop.

```console
$ python evaluate.py
corpus: 313 chunks | recall@k = gold chunk present in top-k

query                                                       vec@1  vec@5  bm25@1  bm25@5  hyb@5  gold_rank(vec)
how do I make a shell script stop when a command fails          0      1       0       1      1   5/313
EXPLAIN ANALYZE Bitmap Heap Scan cost estimate vs actual        0      0       1       1      1   8/313
which HTTP header tells the client it may resume a downl        0      0       0       0      0  43/313
```

Three queries, gold chunk in the top 5: vector 1/3, BM25 2/3, hybrid 2/3. On query one, vector search's top-1 was wrong and its recall@5 was still 1 — which is exactly why you retrieve 20 candidates and let a later stage sort them, instead of retrieving 3 and hoping. On query three, everything failed, and no prompt tuning would have rescued it.

This is also why I treat retrieval evaluation as the same discipline as [evaluating agent output](/posts/running-coding-agents/): define what "correct" means, measure the component in isolation, and only then blame the next component up.

## Hybrid search: BM25 still matters

**Hybrid search** runs keyword and vector retrieval, then merges the ranked lists. I used Reciprocal Rank Fusion, which needs no score calibration — it only cares about rank position:

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

**BM25** still matters because it is exact where embeddings are fuzzy. It finds rare tokens — `PIPESTATUS`, `Accept-Ranges`, `EXPLAIN ANALYZE` — that a 256-dimension vector compresses into the general neighbourhood of "bash things" or "HTTP things." Embeddings win on paraphrase and intent; BM25 wins on identifiers and jargon. Real queries are both, often in the same sentence, which is why the default should be hybrid, not vector-only.

## Reranking is the cheapest upgrade

Retrieval is optimized for speed over thousands of chunks, so it is approximate. Reranking is a second pass over the top ~50 candidates with a slower, more accurate scorer — a cross-encoder, or an LLM asked to score each passage for relevance. You pay for 50 scores instead of 50,000, and you fix most ordering mistakes before they reach the prompt. On the second query above, reranking the top 5 would have promoted the `EXPLAIN ANALYZE` section that BM25 already had at rank 1 and vector had buried at rank 8. Add it after you have recall; it cannot recover a chunk that retrieval never returned.

## The failure modes, in the order I hit them

- **Bad chunks.** Answers split across boundaries, code fences cut in half, headings detached from their sections. Fix: heading-aware chunking, contextual prefixes, check for dangling fences.
- **Embedding mismatch.** A model trained on prose doing poorly on code, identifiers, or a second language. Fix: measure recall on *your* queries; try a second model.
- **No reranking.** The right chunk is at rank 12 and never reaches the prompt. Fix: retrieve 20–50, rerank to 5.
- **Context dilution.** Ten mediocre chunks crowd out the one good one, and the model averages them. Fix: fewer, better chunks — three precise passages beat ten vague ones.
- **Hallucination when retrieval misses.** The query returns plausible neighbours with no answer, and the model fills the gap. Fix: retrieve, then *check* — if the best score is low, say "I don't know" instead of generating. Refusing is a feature.

## When you do not need RAG

RAG is not the default answer to "use my data." Three cases where it is the wrong tool:

- **It fits in the context window.** If your whole knowledge base is 30 pages, paste it. A long-context model with the real text beats a retrieval pipeline that might miss the right chunk.
- **The problem is the prompt, not the knowledge.** If the model has the facts and still answers badly, more retrieval adds noise. Fix the instructions.
- **The task is a skill, not a lookup.** If you need a consistent style, format, or behaviour across thousands of calls, fine-tuning changes the model; retrieval does not.

RAG is for the case in the middle: too much text to paste, too factual to trust the weights, changing too fast to fine-tune.

## The honest summary

I built the whole thing in a throwaway container: one SQLite file, 313 chunks, a 256-dimension embedding model, FTS5 for BM25, RRF for hybrid, recall@k to check myself. Then I deleted the container and the index, because the point was the numbers, not the artifact.

The lesson survived the cleanup. **RAG** is a search system with a language model bolted on the end, and the language model is the part you can least afford to blame. Chunk well. Retrieve both ways. Measure recall before you touch the prompt. And when retrieval comes back empty, teach the model to say so — a confident answer to a question you never found the source for is the most expensive bug in the pipeline.
