---
title: "Postgres JSONB in Practice: When a Document Column Beats a Table"
description: "A hands-on guide to Postgres JSONB: jsonb operators, GIN indexing with jsonb_ops vs jsonb_path_ops, containment queries, and when a document column is the right — or wrong — tool."
pubDate: 2026-12-30
lang: en
translationKey: postgres-jsonb
tags: [devops, linux]
featured: false
keywords:
  - Postgres JSONB
  - jsonb operators
  - GIN index jsonb
  - jsonb vs json
  - containment
---

Postgres JSONB is one of those features that looks like a niche add-on until the day your schema stops fitting into rows and columns. Then it becomes the tool you reach for — sometimes wisely, sometimes not. In this post I'll walk through what `jsonb` actually is, the **jsonb operators** that matter in daily work, how a **GIN index jsonb** strategy changes query performance, and — just as important — when you should *not* reach for a document column.

All queries below were run against a throwaway Postgres 17 container with a realistic `products` table containing nested documents. Real output, real plans.

## What JSONB Is (and Isn't)

`jsonb` is a binary, parsed representation of JSON. Unlike the `json` type — which stores the raw text verbatim — `jsonb` parses the document, discards whitespace, removes duplicate keys, and sorts object keys. The result is slightly larger on disk but far faster to query because the database never has to re-parse the text.

```sql
SELECT '{"b": 2, "a": 1, "a": 3}'::json  AS json_dup,
       '{"b": 2, "a": 1, "a": 3}'::jsonb AS jsonb_dedup;
```

```
         json_dup         |   jsonb_dedup
--------------------------+------------------
 {"b": 2, "a": 1, "a": 3} | {"a": 3, "b": 2}
(1 row)
```

Notice how `jsonb` kept only the last `"a"` value and reordered the keys. This normalization is why `jsonb` supports indexing and containment checks — the binary form has a stable, comparable structure.

## The JSONB Operators That Matter

You don't need to memorize twenty operators. Five cover most real work.

### `->` and `->>`: Extract Values

`->` returns a `jsonb` value (keeping the JSON type); `->>` returns `text`.

```sql
SELECT name,
       attrs->'brand'  AS brand_json,
       attrs->>'brand' AS brand_text
FROM products LIMIT 3;
```

```
        name         | brand_json | brand_text
---------------------+------------+------------
 Mechanical Keyboard | "Keychron" | Keychron
 Wireless Mouse      | "Logitech" | Logitech
 USB-C Hub           | "Anker"    | Anker
(3 rows)
```

Use `->` when you need to chain further (e.g. `attrs->'switch'->>'type'`). Use `->>` when you want a plain string for display or comparison.

### `#>` and `#>>`: Path Extraction

When you need a value several levels deep, `#>` takes a path array and returns `jsonb`; `#>>` returns `text`.

```sql
SELECT name,
       attrs#>'{switch,type}'      AS switch_type,
       attrs#>>'{firmware,name}'    AS firmware_name
FROM products
WHERE attrs ? 'switch' LIMIT 3;
```

```
        name         |   switch_type   | firmware_name
---------------------+-----------------+---------------
 Mechanical Keyboard | "Gateron Brown" | QMK
(1 row)
```

### `@>`: Containment

This is the operator that makes JSONB shine. `@>` asks: "does the left document contain the right document as a subset?"

```sql
SELECT name FROM products WHERE attrs @> '{"wireless": true}';
```

```
          name
-------------------------
 Mechanical Keyboard
 Wireless Mouse
 Noise-Cancel Headphones
 Smart Plug
 Raspberry Pi 5
(5 rows)
```

Containment works at any depth. `attrs @> '{"switch": {"type": "Gateron Brown"}}'` would match only the keyboard. This is the query pattern that a GIN index accelerates.

### `?`: Key Existence

`?` checks whether a top-level key exists. `?|` and `?&` accept arrays of keys.

```sql
SELECT name FROM products WHERE attrs ? 'anc';
```

```
          name
-------------------------
 Noise-Cancel Headphones
(1 row)
```

### `jsonb_path_query`: SQL/JSON Path Language

For more complex filtering inside arrays or nested structures, Postgres provides `jsonb_path_query` with a JSON path expression.

```sql
SELECT name,
       jsonb_path_query(attrs, '$.ports[*] ? (@ == "USB-C")') AS usbc_port
FROM products
WHERE attrs @> '{"ports": ["USB-C"]}';
```

```
        name         | usbc_port
---------------------+-----------
 Mechanical Keyboard | "USB-C"
 Wireless Mouse      | "USB-C"
 USB-C Hub           | "USB-C"
 Webcam              | "USB-C"
 Portable SSD        | "USB-C"
 Raspberry Pi 5      | "USB-C"
(6 rows)
```

## Updating Nested Keys

`jsonb_set` updates a value at a path without touching the rest of the document:

```sql
UPDATE products
SET attrs = jsonb_set(attrs, '{firmware,version}', '"0.25"')
WHERE name = 'Mechanical Keyboard';

SELECT attrs->'firmware' FROM products WHERE name = 'Mechanical Keyboard';
```

```
                    ?column?
-------------------------------------------------
 {"name": "QMK", "layers": 4, "version": "0.25"}
(1 row)
```

There's also `jsonb_insert` for arrays and `jsonb_set(..., create_missing := true)` to create intermediate keys that don't exist yet.

## Aggregating Back to JSON

`jsonb_agg` collects rows back into a JSON array — useful for APIs that expect a document response:

```sql
SELECT jsonb_agg(jsonb_build_object('name', name, 'brand', attrs->>'brand'))
AS product_summary FROM products;
```

```
                                                                                                                                                                                                                                        product_summary
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 [{"name": "Wireless Mouse", "brand": "Logitech"}, {"name": "USB-C Hub", "brand": "Anker"}, {"name": "Monitor Light Bar", "brand": "BenQ"}, {"name": "Webcam", "brand": "Elgato"}, {"name": "Standing Desk", "brand": "FlexiSpot"}, {"name": "Noise-Cancel Headphones", "brand": "Sony"}, {"name": "Portable SSD", "brand": "Samsung"}, {"name": "Smart Plug", "brand": "TP-Link"}, {"name": "Raspberry Pi 5", "brand": "Raspberry Pi"}, {"name": "Mechanical Keyboard", "brand": "Keychron"}]
(1 row)
```

## GIN Index JSONB: jsonb_ops vs jsonb_path_ops

A GIN (Generalized Inverted Index) index on a `jsonb` column is what makes containment and existence queries fast. Postgres offers two operator classes:

- **`jsonb_ops`** (default): indexes every key and value as separate entries. Supports `@>`, `?`, `?|`, `?&`.
- **`jsonb_path_ops`**: indexes only path/value hashes. Supports only `@>` but produces a smaller index.

```sql
CREATE INDEX idx_attrs_gin  ON products USING gin (attrs jsonb_ops);
CREATE INDEX idx_attrs_path ON products USING gin (attrs jsonb_path_ops);

SELECT indexname, pg_size_pretty(pg_relation_size(indexname::regclass)) AS size
FROM pg_indexes WHERE tablename = 'products' AND indexname LIKE 'idx_attrs%';
```

```
   indexname    | size
----------------+-------
 idx_attrs_gin  | 16 kB
 idx_attrs_path | 16 kB
(2 rows)
```

On this small dataset both are 16 kB, but at scale `jsonb_path_ops` is typically 20–40% smaller because it stores fewer index entries. The trade-off: it only accelerates `@>` containment, not `?` existence checks.

### What EXPLAIN Shows

Here's the honest truth about small tables: the planner often prefers a sequential scan because it's cheaper than an index lookup.

```sql
EXPLAIN SELECT name FROM products WHERE attrs @> '{"wireless": true}';
```

```
                       QUERY PLAN
---------------------------------------------------------
 Seq Scan on products  (cost=0.00..1.12 rows=1 width=32)
   Filter: (attrs @> '{"wireless": true}'::jsonb)
(2 rows)
```

This is correct behavior — with 10 rows, a seq scan is faster. The GIN index pays off at thousands of rows and above. To see the index in action you'd need a larger dataset, but the principle holds: GIN turns a full-table JSON parse into an index probe.

For comparison, here's a query that *cannot* use the GIN index efficiently:

```sql
EXPLAIN SELECT name FROM products WHERE attrs->>'brand' = 'Keychron';
```

```
                        QUERY PLAN
----------------------------------------------------------
 Seq Scan on products  (cost=0.00..1.15 rows=1 width=32)
   Filter: ((attrs ->> 'brand'::text) = 'Keychron'::text)
(2 rows)
```

The `->>` operator extracts text and compares it — the GIN index doesn't help here. If you frequently query by a specific extracted value, that value deserves a real column (or at least an expression index).

## When JSONB Is the Right Tool

JSONB earns its place when:

- **Attributes are sparse or evolving.** A product catalog where some items have `firmware`, others have `sensor`, and next month someone adds `ai_features`. Adding a column for each is schema churn; a `jsonb` column absorbs the variation.
- **You're storing external payloads.** Webhook bodies, API responses, configuration blobs — data you need to keep and occasionally query but don't need to join on.
- **Metadata is flexible.** User preferences, feature flags, A/B test assignments — things that vary per entity but aren't queried relationally.
- **You need containment queries.** "Find all products where `attrs @> '{"wireless": true, "ports": ["USB-C"]}'`" is a single indexed lookup.

## When JSONB Is the Wrong Tool

Reach for a regular table instead when:

- **You query the value relationally.** `WHERE attrs->>'status' = 'active'` on every request is a sign that `status` should be a real column with a B-tree index.
- **You need constraints.** `CHECK` constraints on JSONB are possible but awkward. Foreign keys, `NOT NULL`, and `UNIQUE` are native to columns.
- **Data integrity matters.** JSONB is schemaless by design. If you need to guarantee that every row has a `user_id` and it's an integer, a column enforces that; JSONB does not.
- **You're JSONB-ing everything.** A table where 90% of columns are `jsonb` is a schema smell. The database can't optimize what it can't see.

## Combining JSONB with Normal Columns

The pragmatic pattern is a hybrid: hot, queried fields as real columns; the rest as JSONB.

```sql
CREATE TABLE orders (
    id          bigserial PRIMARY KEY,
    user_id     bigint NOT NULL REFERENCES users(id),
    status      text NOT NULL,
    total       numeric(12,2) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    metadata    jsonb
);
```

`user_id`, `status`, and `total` are queried constantly — they get proper types, constraints, and indexes. `metadata` holds everything else: shipping notes, discount codes, A/B variants, third-party payloads. You get relational integrity where you need it and flexibility where you don't.

## Performance and Storage Notes

- **TOAST compression:** Large JSONB values are compressed and stored out-of-line. A 50 KB document doesn't bloat your row.
- **Index size:** GIN indexes are larger than B-tree indexes on the same data. `jsonb_path_ops` is smaller than `jsonb_ops` but supports fewer operators.
- **Write amplification:** Every `jsonb_set` that changes a document creates a new version of the whole document (MVCC). Frequent small updates to large documents are expensive.
- **Partial indexes:** You can index only rows that match a condition: `CREATE INDEX ON products USING gin (attrs) WHERE attrs ? 'firmware'`.

## Decision List

Use JSONB when:

1. The data is document-shaped and varies per row.
2. You query by containment (`@>`) or key existence (`?`).
3. You don't need relational constraints on the fields inside.
4. The alternative is dozens of nullable columns or an EAV table.

Don't use JSONB when:

1. You'll query the extracted value with `=`, `<`, `>` in every request.
2. You need foreign keys, unique constraints, or NOT NULL on inner fields.
3. The data is highly relational and joins are the primary access path.
4. You're using it because designing a schema feels like work.

Postgres JSONB is a powerful tool in the same way a well-stocked workshop is powerful — the trick is knowing which tool to reach for. When the data is genuinely document-shaped, JSONB with a GIN index gives you query performance that would take significant application code to replicate. When the data is relational, no amount of `jsonb_path_query` wizardry will beat a proper table.

For more on indexing strategies, see [Database Indexing](/posts/database-indexing/) and [Postgres Index Types](/posts/postgres-index-types/).
