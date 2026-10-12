---
title: "SQLite FTS5 in practice: full-text search in one file"
description: "SQLite FTS5 in practice: full-text search in one file. Real sqlite3 output — creating the index (standalone and external content), MATCH queries, bm25() ranking versus LIKE, highlight() and snippet(), the unicode61, porter and trigram tokenizers, maintenance, and the honest limits."
pubDate: 2027-01-02
lang: en
translationKey: sqlite-fts5
tags: [devops, python]
featured: false
keywords:
  - SQLite FTS5
  - full-text search SQLite
  - bm25
  - MATCH query
  - tokenizer
  - external content
  - trigram
---

"Add search" has an expensive default answer: stand up a search server. For a blog, a CLI tool, or an internal app, the honest answer is usually a **SQLite FTS5** virtual table — a real inverted index that lives in the same file as your data. No daemon, no sync pipeline, no cluster to babysit. This is **full-text search SQLite** style: what FTS5 actually does, how to create the index, the **MATCH query** syntax, how `bm25()` ranking behaves against a naive `LIKE`, what the **tokenizer** choice costs you, and where FTS5 honestly stops. Every number and output below is real — I ran SQLite 3.53.4 against a scratch database with 12 hand-written rows and a 50,000-row synthetic corpus, and pasted the output verbatim.

```sql
SELECT sqlite_version();

3.53.4
```

## What SQLite FTS5 is, and when it beats LIKE

`LIKE '%sqlite%'` feels like search and is not. It is a substring test that reads **every row**, and it orders results by whatever the plan produces — usually rowid. FTS5 does something different: it tokenizes your text into an inverted index, a mapping from term to the rows containing it. A query becomes a dictionary lookup plus some merge work instead of a table scan.

The plan difference is stark and worth seeing once:

```sql
EXPLAIN QUERY PLAN SELECT id FROM articles WHERE title LIKE '%sqlite%' OR body LIKE '%sqlite%';

QUERY PLAN
`--SCAN articles

EXPLAIN QUERY PLAN SELECT rowid FROM articles_fts WHERE articles_fts MATCH 'sqlite';

QUERY PLAN
`--SCAN articles_fts VIRTUAL TABLE INDEX 0:M2
```

On 50,000 rows, both queries return the same 5,000 rows, with very different amounts of work behind them:

```sql
.timer on
SELECT count(*) FROM big WHERE body LIKE '%fts5%';
SELECT count(*) FROM big_fts WHERE big_fts MATCH 'fts5';

5000
Run Time: real 0.007362 user 0.007144 sys 0.000146
5000
Run Time: real 0.000379 user 0.000345 sys 0.000035
```

Seven milliseconds against four tenths of a millisecond, on a small database. At a million rows the scan becomes seconds and the lookup still doesn't. `LIKE` is fine when your table is small and always will be — a hundred config rows don't need an index. FTS5 is for the moment the table grows or you want results in relevance order.

## Creating the index: standalone vs external content

There are two shapes. The standalone table stores the text inside the FTS index itself — you write to the FTS table and nowhere else. The more interesting shape is an **external content** table: the FTS index references a regular table, stores only tokens and rowids, and reads the original text back when a query needs to highlight or return it.

```sql
CREATE TABLE articles (
  id    INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body  TEXT NOT NULL
);

-- content='articles' + content_rowid=<pk> makes this an external content index
CREATE VIRTUAL TABLE articles_fts USING fts5(
  title, body,
  content='articles',
  content_rowid='id'
);

-- populate the index from the existing content table
INSERT INTO articles_fts(articles_fts) VALUES('rebuild');
```

The externals table is the one to prefer for a normal application table: no duplicated text, one copy of the data, and the content table stays authoritative. The cost is what you saw above — you are responsible for feeding the index, which I'll come back to in maintenance.

That duplication trade-off is measurable. The standalone FTS copy of the 5 MB synthetic table cost 2.7 MB of index data plus 0.5 MB of document-size metadata:

```sql
SELECT name, SUM(pgsize)/1024.0 AS kb FROM dbstat GROUP BY name;

big             | 5120.0
big_fts_data    | 2728.0
big_fts_docsize | 480.0
big_fts_idx     | 12.0
```

## The MATCH query syntax in one screen

FTS5's query language is small and worth knowing completely. Bare words are ANDed; `OR`, `NOT`, parentheses, `"quoted phrases"`, `prefix*`, `column:term` and `NEAR(...)` cover almost every search-box behavior. Same corpus, real output:

```sql
-- boolean
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
-- shapes
SELECT 'fts*  (prefix)'        AS q, group_concat(a.id) FROM articles_fts f JOIN articles a ON a.id=f.rowid
  WHERE articles_fts MATCH 'fts*';
SELECT '"single writer" (phrase)' AS q, group_concat(a.id) FROM articles_fts f JOIN articles a ON a.id=f.rowid
  WHERE articles_fts MATCH '"single writer"';
SELECT 'NEAR(writer commits, 3)'  AS q, group_concat(a.id) FROM articles_fts f JOIN articles a ON a.id=f.rowid
  WHERE articles_fts MATCH 'NEAR(writer commits, 3)';
SELECT 'title:fts5 OR title:trigram' AS q, group_concat(a.id) FROM articles_fts f JOIN articles a ON a.id=f.rowid
  WHERE articles_fts MATCH 'title:fts5 OR title:trigram';

q                        | 2
q                            | 3
q                          | 3
q                          | 2, 11
```

Two practical notes. `NEAR(term1 term2, n)` matches when the terms appear within `n` tokens of each other — phrase search with slop, useful when you don't want users to memorize exact quoting. And column filters like `title:fts5` let a title hit outrank later, or restrict a search to one column entirely.

The one footgun: this is a query *language*, not free text. Never splice raw user input into `MATCH`. Parameterize (`WHERE articles_fts MATCH ?`) and wrap untrusted terms yourself — usually by quoting every user word into a phrase — or a stray quote becomes a syntax error at best and an unintended boolean at worst.

## Ranking with bm25(): why relevance ordering matters

A match list in table order looks like a bug to users, because the third hit is often the one they wanted. `bm25()` gives FTS5 a relevance score: queryable through the normal machinery, ordered with `ORDER BY rank`. Scores are **negative** — more negative is a better match — and the function takes optional per-column weights.

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

Compare the same search expressed as `LIKE`:

```sql
SELECT id, title FROM articles WHERE title LIKE '%sqlite%' OR body LIKE '%sqlite%';

id|title
1|SQLite is enough for most applications
2|Getting started with FTS5
5|Tokenizers in practice
7|Running a personal blog on one machine
```

`LIKE` sees no notion of relevance, so it emits rowid order: row 2 before row 5. FTS5 knows row 1 has the query in its **title** (weight 10.0 against 1.0 for the body), that row 5's body says "sqlite" twice while row 2's says it once, and orders accordingly. Same rows, different answers — one is a relevance ranking, the other is an accident of insertion order. Head a weight at the title column and this becomes the whole backend of a half-decent site search: `ORDER BY rank LIMIT 20`.

## highlight() and snippet() for your search UI

Returning raw rows makes the user scan for why a row matched. `highlight(articles_fts, col, before, after)` wraps hits in markers for a whole column, and `snippet()` rents you a window of context around the best hit:

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

Column indexes are zero-based (`0` = title, `1` = body), and `snippet()` takes the ellipsis string and a token count. This is the half of the search UI that normally needs a separate templating step; FTS5 emits it straight out of the query.

## Tokenizers: unicode61, porter, trigram

The tokenizer is the least appreciated part of an FTS5 schema and changes what "match" means. It's chosen at `CREATE VIRTUAL TABLE` time and it's per-column. There are three built-ins worth knowing.

**unicode61** is the default: splits on non-alphanumeric characters, folds case, drops diacritics. That's why an uppercase query token matches a lowercase document without you trying:

```sql
SELECT 'case fold MATCH SQLITE -> ' || group_concat(rowid) FROM articles_fts
  WHERE articles_fts MATCH 'SQLITE';

case fold MATCH SQLITE -> 1,2,5,7
```

**porter** applies the Porter stemming algorithm, so `tokenize`, `tokenizer`, `tokenizers` collapse onto one stem and one query term finds them all:

```sql
SELECT 'unicode61 MATCH token -> ' || group_concat(rowid) FROM articles_fts
  WHERE articles_fts MATCH 'token';
SELECT 'porter    MATCH token -> ' || group_concat(rowid) FROM porter_fts
  WHERE porter_fts MATCH 'token';

unicode61 MATCH token -> 5
porter    MATCH token -> 2,5,8,11
```

Recall goes up; precision goes down — `porter` will match "indexes" when the user typed "index" whether or not that was right. Use it for prose search, where users type plain words. Not for identifiers, where the difference between `parse` and `parser` is the answer.

**trigram** splits text into three-character windows, which turns case-insensitive substring search into an index lookup — the thing `LIKE` cannot do at all:

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

`trigram` is the tokenizer for zsh-style partial words, code identifiers, and short fields like names or file paths. It's also the most expensive: more terms per row means a bigger index and more matches to verify.

## Maintenance: optimize and rebuild

FTS5 accumulates deletions into b-trees like anything else. `optimize` merges the segment structure into one tight tree and is safe to run after bulk changes; `rebuild` regenerates the whole index from the content table:

```sql
INSERT INTO articles_fts(articles_fts) VALUES('optimize');
INSERT INTO articles_fts(articles_fts) VALUES('rebuild');
```

`optimize` is hygiene you run weekly or after a big purge. `rebuild` is the recovery tool, and for an **external content** index it is also the *only* correct way to repair drift, because writing to the content table directly does not update the FTS shadow tables. Editing row 7 and searching for the new word proves it:

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

The content table had the row all along; the FTS index returned nothing until it was rebuilt. Two ways to never meet this bug: keep all writes through the FTS table (use the standalone shape), or put `AFTER INSERT/UPDATE/DELETE` triggers on the content table that mirror the change. I use triggers; the drift failure above is too quiet to discover in production.

## The limits: FTS5 is not a search cluster

I like FTS5 enough to want you to know where it stops.

**It's one database on one machine.** The index lives in the same file as the data; there is no replication of that file you can trust, and no network protocol to query it over. That's the same ledger I kept for SQLite in general in [SQLite is enough for most applications](/posts/sqlite-is-enough/) — the reads scale, the writes serialize, and "one machine" is the availability story.

**The ranking is basic.** `bm25()` with per-column weights is a good ranking function and a small one: fixed `k1`/`b` parameters, no synonyms, no boosting by recency, no learning-to-rank. Users who typo get nothing — `trigram` gives you substring search, which is not fuzzy matching, and neither tokenizer forgives edit distance.

**No faceting.** The usual "12 results in Python, 7 in SQL, 3 in Rust" sidebar is a `GROUP BY` over your own categories — the index can't do that aggregation for you, and on a large result set that scan runs on every query.

**Your operational surface is the database's.** No cluster health, no mappings, no reindex pipeline — that's why I'd start here and only migrate to a dedicated search engine when the search itself outgrows one file. If you want to see where that line sits, I wrote the Postgres versions of this comparison in [Postgres full-text search vs Elasticsearch](/posts/full-text-search/).

Until then, three commands are the whole stack: nothing about that requires another server. If you live in the terminal, the CLI habits for scripting all of this are in [SQLite CLI cookbook](/posts/sqlite-cli-cookbook/) — and my entire blog search runs on the shape described above.

<figure>
<svg viewBox="0 0 660 230" width="100%" role="img" aria-label="Diagram of an FTS5 inverted index: the documents tokenize into terms which map to posting lists of row ids, and a MATCH query looks up terms, ranks hits with bm25 and highlights them.">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
      <rect x="16" y="78" width="150" height="78" rx="8"/>
      <rect x="435" y="40" width="90" height="34" rx="6"/>
      <rect x="435" y="86" width="90" height="34" rx="6"/>
      <rect x="435" y="132" width="90" height="34" rx="6"/>
    </g>
    <text x="91" y="60" text-anchor="middle" font-size="12" opacity="0.75">content table</text>
    <text x="91" y="100" text-anchor="middle" font-size="11" font-family="ui-monospace, monospace">articles</text>
    <text x="91" y="118" text-anchor="middle" font-size="11" font-family="ui-monospace, monospace">title + body</text>
    <text x="91" y="140" text-anchor="middle" font-size="11">1 FTS5 · 2 tokenizers…</text>
    <text x="480" y="160" text-anchor="middle" font-size="11" opacity="0.75" fill="#0f766e">MATCH → rank bm25 → …</text>
    <text x="480" y="61" text-anchor="middle" font-size="11" font-family="ui-monospace, monospace">fts5 → [2]</text>
    <text x="480" y="107" text-anchor="middle" font-size="11" font-family="ui-monospace, monospace">trigram → [11]</text>
    <text x="480" y="153" text-anchor="middle" font-size="11" font-family="ui-monospace, monospace">wal → [3]</text>
    <text x="235" y="40" text-anchor="middle" font-size="12" opacity="0.75">tokenizer</text>
    <text x="235" y="60" text-anchor="middle" font-size="11" font-family="ui-monospace, monospace">unicode61</text>
    <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.7">
      <line x1="166" y1="118" x2="380" y2="118"/><path d="M376 114 l6 4 -6 4"/>
    </g>
    <text x="330" y="105" text-align="middle" text-anchor="middle" font-size="11" opacity="0.7">inverted index: term → posting list of rowids</text>
    <text x="330" y="150" text-anchor="middle" font-size="11" opacity="0.7">SELECT … WHERE articles_fts MATCH 'fts5 OR wal'</text>
  </g>
</svg>
<figcaption>The FTS5 index is a per-term posting list; a MATCH query is dictionary lookups plus a merge, `bm25()` orders what survives, and `highlight()` marks it.</figcaption>
</figure>
