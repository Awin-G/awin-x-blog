---
title: "SQLite JSON: Querying JSON in a Single File (and When to Normalize)"
description: "SQLite's JSON1 extension lets you query, filter, and index JSON stored in a TEXT column — json_extract, ->>, json_each, and the generated-column trick that makes it fast."
pubDate: 2027-01-31
lang: en
translationKey: sqlite-json1-and-generated-columns
tags: [devops, python]
featured: false
keywords:
  - SQLite JSON
  - json_extract
  - generated column
  - json_each
  - index a JSON field
---

I've been reaching for SQLite more and more as the default datastore for side projects, homelab tooling, and local-first apps. If you're coming from Postgres or MongoDB, the idea of stuffing JSON into a single file feels either liberating or reckless — and honestly, it's both. SQLite ships with a JSON1 extension that makes JSON a first-class citizen, but it comes with a storage reality and a performance trick you need to understand before you commit.

This post is the practical guide I wish I'd had: the functions that matter, the generated-column pattern that makes JSON queryable at speed, and the honest guidance on when to keep JSON and when to normalize it into real columns. If you're new to SQLite itself, start with [SQLite is enough](/posts/sqlite-is-enough/) and the [SQLite CLI cookbook](/posts/sqlite-cli-cookbook/).

## Why JSON in SQLite is genuinely useful

The case for JSON in SQLite isn't "MongoDB lite" — it's that a surprising amount of real data is **leaf data**: blobs you write once, read whole, and rarely filter by. Think configuration files, API response caches, event payloads, device telemetry, or a list of tags. Normalizing every one of those into a child table is overhead you don't need.

SQLite stores JSON as plain `TEXT`. There is no binary JSON type, no special encoding — just the string, byte-for-byte as you inserted it. This matters because every call to `json_extract` re-parses the text. For a 200-byte config blob you read ten times a day, that's free. For a 50 MB JSON document you query 1,000 times a second, it's a bottleneck. Know which side of that line you're on.

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  doc TEXT NOT NULL
);

INSERT INTO events (doc) VALUES
('{"sensor":"temp-1","reading":23.5,"unit":"C","tags":["indoor","lab"],"ts":"2026-10-14T08:00:00Z"}'),
('{"sensor":"temp-2","reading":19.8,"unit":"C","tags":["outdoor","roof"],"ts":"2026-10-14T08:05:00Z"}'),
('{"sensor":"hum-1","reading":62.1,"unit":"%","tags":["indoor","lab"],"ts":"2026-10-14T08:10:00Z"}'),
('{"sensor":"temp-1","reading":24.1,"unit":"C","tags":["indoor","lab"],"ts":"2026-10-14T08:15:00Z"}'),
('{"sensor":"press-1","reading":1013.2,"unit":"hPa","tags":["outdoor"],"ts":"2026-10-14T08:20:00Z"}');
```

That's the entire schema. No migration when a new sensor type shows up with extra fields — just insert a different JSON shape. That flexibility is the whole point.

## The JSON1 functions that matter

SQLite's JSON1 extension gives you a focused set of tools. You don't need all of them; these four cover 95 % of real work.

### json_extract and the -> / ->> operators

`json_extract(doc, '$.sensor')` pulls a value out by JSONPath. The `->` operator is shorthand that returns JSON (keeping quotes on strings); `->>` returns unquoted text. Use `->>` when you want to compare or index a string value.

```sql
SELECT id, doc->'$.sensor' AS arrow_json, doc->>'$.sensor' AS arrow_text
FROM events LIMIT 3;
```

```
id  arrow_json  arrow_text
--  ----------  ----------
 1  "temp-1"    temp-1
 2  "temp-2"    temp-2
 3  "hum-1"     hum-1
```

`->` gives you `"temp-1"` (a JSON string literal with quotes); `->>` gives you `temp-1` (bare text). For filtering and indexing, `->>` is almost always what you want.

### json_each and json_tree: arrays into rows

`json_each` is a table-valued function — it expands a JSON array into rows. This is how you query "all events tagged `indoor`":

```sql
SELECT e.id, je.key, je.value AS tag
FROM events e, json_each(e.doc, '$.tags') je
WHERE e.id = 1;
```

```
id  key   tag
--  ---  ------
 1    0  indoor
 1    1  lab
```

`json_tree` is the recursive version — it walks the entire document, every nesting level, and returns every key/value pair. Useful for debugging or for "find any field named X anywhere in the doc":

```sql
SELECT key, type, value FROM json_tree((SELECT doc FROM events WHERE id = 1)) LIMIT 12;
```

```
  key     type                                                 value
-------  ------  -------------------------------------------------------------------------------------------------
         object  {"sensor":"temp-1","reading":23.5,"unit":"C","tags":["indoor","lab"],"ts":"2026-10-14T08:00:00Z"}
sensor   text    temp-1
reading  real                                                                                                 23.5
unit     text    C
tags     array   ["indoor","lab"]
      0  text    indoor
      1  text    lab
ts       text    2026-10-14T08:00:00Z
```

### json_set, json_patch, and building JSON

You can modify JSON in place with `json_set` (set a single path) or `json_patch` (merge a JSON object, RFC 7396 style). Both return a new JSON string — JSON in SQLite is immutable.

```sql
SELECT json_set(doc, '$.reading', 99.9) AS after_set FROM events WHERE id = 1;
```

```
-------------------------------------------------------------------------------------------------
{"sensor":"temp-1","reading":99.9,"unit":"C","tags":["indoor","lab"],"ts":"2026-10-14T08:00:00Z"}
```

```sql
SELECT json_patch(doc, '{"reading": 88.8, "extra": true}') AS after_patch FROM events WHERE id = 1;
```

```
--------------------------------------------------------------------------------------------------------------
{"sensor":"temp-1","reading":88.8,"unit":"C","tags":["indoor","lab"],"ts":"2026-10-14T08:00:00Z","extra":true}
```

And you can build JSON from rows with `json_object` and `json_group_array` — handy for exporting query results as a JSON payload:

```sql
SELECT json_group_array(json_object('sensor', sensor, 'reading', reading)) AS payload
FROM (SELECT json_extract(doc,'$.sensor') AS sensor, json_extract(doc,'$.reading') AS reading FROM events);
```

```
------------------------------------------------------------------------------------
[{"sensor":"temp-1","reading":23.5},{"sensor":"temp-2","reading":19.8},{"sensor":"hum-1","reading":62.1},{"sensor":"temp-1","reading":24.1},{"sensor":"press-1","reading":1013.2}]
```

## The performance trick: a generated column with an index

Here's the thing that makes SQLite JSON genuinely usable at scale. You can create a **generated column** — a virtual column whose value is computed from an expression — and then index it. SQLite materializes the generated column (with `STORED`) and the index makes lookups O(log n) instead of O(n).

```sql
CREATE TABLE events2 (
  id INTEGER PRIMARY KEY,
  doc TEXT NOT NULL,
  sensor TEXT GENERATED ALWAYS AS (json_extract(doc, '$.sensor')) STORED
);
CREATE INDEX idx_events2_sensor ON events2(sensor);
```

The generated column `sensor` is computed at write time and stored on disk. You never insert into it directly — it's derived from `doc`. Now a query that filters on `sensor` uses the index:

```sql
EXPLAIN QUERY PLAN SELECT * FROM events2 WHERE sensor = 'temp-1';
```

```
QUERY PLAN
`--SEARCH events2 USING INDEX idx_events2_sensor (sensor=?)
```

That `SEARCH ... USING INDEX` is the good plan. Compare it to the same query against the raw expression on the unindexed table:

```sql
EXPLAIN QUERY PLAN SELECT * FROM events WHERE json_extract(doc, '$.sensor') = 'temp-1';
```

```
QUERY PLAN
`--SCAN events
```

That `SCAN` is a full table scan — SQLite has to re-parse every row's JSON to evaluate the predicate. On 1,000 rows, negligible. On 1,000,000 rows with a 5 ms query budget, it's the difference between "instant" and "timeout." The generated column is the middle ground: you keep the schema flexibility of JSON, but the field you filter on lives in a real, indexed column.

## json_valid as a CHECK constraint

Because JSON is just `TEXT`, nothing stops you from inserting malformed JSON — until you add a `CHECK` constraint:

```sql
CREATE TABLE events3 (
  id INTEGER PRIMARY KEY,
  doc TEXT NOT NULL CHECK (json_valid(doc))
);
INSERT INTO events3 (doc) VALUES ('{"ok":true}');
INSERT INTO events3 (doc) VALUES ('{bad json}');
```

```
Error near line 13: CHECK constraint failed: json_valid(doc)
```

`json_valid` returns 1 for well-formed JSON and 0 for anything else. As a `CHECK`, it enforces data integrity at the database layer — your application can't write garbage even if it tries. The cost is that SQLite re-validates the text on every insert, but for typical payloads that's microseconds.

<figure>
<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="JSON document flows into a generated column and then into an index">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <style>
    .box { fill: none; stroke: #0f766e; stroke-width: 1.5; rx: 6; }
    .label { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; fill: currentColor; }
    .small { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; fill: currentColor; opacity: 0.75; }
    .arrow { stroke: #0f766e; stroke-width: 1.5; fill: none; marker-end: url(#arrow); }
  </style>
  <rect class="box" x="20" y="60" width="160" height="120" rx="6"/>
  <text class="label" x="100" y="85" text-anchor="middle">doc (TEXT)</text>
  <text class="small" x="100" y="105" text-anchor="middle">{"sensor":"temp-1",</text>
  <text class="small" x="100" y="120" text-anchor="middle">"reading":23.5,...}</text>
  <text class="small" x="100" y="145" text-anchor="middle">json_extract</text>
  <text class="small" x="100" y="160" text-anchor="middle">'$.sensor'</text>
  <path class="arrow" d="M 180 120 L 230 120"/>
  <rect class="box" x="230" y="60" width="160" height="120" rx="6"/>
  <text class="label" x="310" y="85" text-anchor="middle">sensor (STORED)</text>
  <text class="small" x="310" y="105" text-anchor="middle">generated column</text>
  <text class="small" x="310" y="125" text-anchor="middle">"temp-1"</text>
  <text class="small" x="310" y="150" text-anchor="middle">materialized at</text>
  <text class="small" x="310" y="165" text-anchor="middle">write time</text>
  <path class="arrow" d="M 390 120 L 440 120"/>
  <rect class="box" x="440" y="60" width="180" height="120" rx="6"/>
  <text class="label" x="530" y="85" text-anchor="middle">idx_sensor</text>
  <text class="small" x="530" y="105" text-anchor="middle">B-tree index</text>
  <text class="small" x="530" y="125" text-anchor="middle">O(log n) lookup</text>
  <text class="small" x="530" y="150" text-anchor="middle">SEARCH instead</text>
  <text class="small" x="530" y="165" text-anchor="middle">of SCAN</text>
</svg>
<figcaption>JSON document → generated column → index. The generated column is derived from the JSON, stored on disk, and indexed for fast lookups.</figcaption>
</figure>

## The honest guidance: when to keep JSON, when to normalize

After working with this pattern across several projects, here's my rule of thumb:

**Keep JSON when:**
- The data is leaf data — you read it whole, never filter by individual fields.
- The schema is genuinely unstable — new fields appear frequently, and you don't want a migration every week.
- You're caching API responses or config blobs that you trust and rarely query into.

**Normalize into real columns when:**
- You filter or join on a specific field in most queries — make it a real column (or a generated column with an index).
- You need referential integrity — foreign keys don't work on JSON fields.
- The JSON document is large (multi-KB) and you only need a few fields — extract those fields into real columns and optionally keep the full blob.

**The generated column is the middle ground** when you want both: schema flexibility for the parts that change, and query performance for the parts you filter on. You store the JSON blob for the full document, but the hot fields are indexed and queryable.

The mistake I see people make is treating JSON in SQLite as either "always fine" or "always a hack." Neither is true. It's a tool with a clear performance profile: free for leaf data, cheap with a generated column for filtered fields, and expensive if you try to index inside a deeply nested path that SQLite's query planner can't use. Know which case you're in, and JSON in SQLite will serve you well.

---

*If you're building on SQLite, you might also find useful the [SQLite CLI cookbook](/posts/sqlite-cli-cookbook/) for everyday commands, and [SQLite is enough](/posts/sqlite-is-enough/) for the case against reaching for Postgres by default.*
