---
title: "MySQL vs PostgreSQL: the practical differences that bite you"
description: "Both databases are excellent, so the real differences are defaults, types, and SQL dialect. Real output from throwaway MySQL 8.4 and PostgreSQL 17 containers: isolation levels, NULL and boolean quirks, identifier case, ON CONFLICT vs ON DUPLICATE KEY, RETURNING, jsonb, arrays, and a decision list."
pubDate: 2026-12-11
lang: en
translationKey: mysql-vs-postgres
tags: [devops, linux]
featured: false
keywords:
  - MySQL vs PostgreSQL
  - Postgres vs MySQL
  - ON CONFLICT vs ON DUPLICATE KEY
  - jsonb
  - isolation level
---

**MySQL vs PostgreSQL** is the kind of comparison that usually ends in a flame war and should end in a checklist. Both are excellent, mature, ACID relational databases that will happily serve a normal application for years. The differences that matter day to day are almost never about raw speed — they are about defaults, types, and SQL dialect, and those bite quietly, weeks after you've shipped. This is the practical version, written from real output: I ran throwaway MySQL 8.4.11 and PostgreSQL 17.11 containers side by side and asked both the same questions, so everything below is behaviour you can reproduce, not a benchmark I can't defend.

## Both are excellent — the choice is usually ecosystem and ops

Every **Postgres vs MySQL** argument I have watched eventually collapses into two people defending the database they already know. That is not useful. Both have real replication, real backup tooling, and a query planner smarter than your hand-written hints. For a normal web application, either one is fine.

The honest framing is that raw power is almost never the deciding factor. What usually decides it:

- **Ecosystem fit.** The language, ORM, and hosting you already run. On PlanetScale/Vitess or a managed RDS cluster, MySQL is native. If you need PostGIS, pgvector, or TimescaleDB, Postgres is the answer and MySQL is a non-starter.
- **What your ops team can operate.** A boring MySQL replica set you have failed over before beats a Postgres you have never failed over at 3 a.m.
- **The specific features you need.** Real booleans, arrays, ranges, strict typing, and a binary JSON type you can index are Postgres. Very cheap read scaling through the MySQL replication ecosystem is MySQL.

So this is not a winner's piece. It is the list of differences that actually cost you an afternoon — defaults that surprise you, dialect you have to rewrite, and semantics that quietly change results.

## How I got these outputs

Two containers, deleted afterwards, no benchmark claims:

```bash
docker run -d --name m -e MYSQL_ROOT_PASSWORD=x -p 127.0.0.1:13306:3306 mysql:8.4
docker run -d --name p -e POSTGRES_PASSWORD=x -p 127.0.0.1:15432:5432 postgres:17
```

Every statement below was run against those two servers. Row counts are small on purpose, because a benchmark without your schema, hardware, and query mix is folklore.

## Isolation level: REPEATABLE READ vs READ COMMITTED is the first real bite

Ask each server for its default:

```sql
-- MySQL 8.4
SELECT @@transaction_isolation;
+-------------------------+
| @@transaction_isolation |
+-------------------------+
| REPEATABLE-READ         |
+-------------------------+

-- PostgreSQL 17
SHOW default_transaction_isolation;
 default_transaction_isolation
-------------------------------
 read committed
(1 row)
```

This is not trivia. In MySQL, the default **isolation level** is REPEATABLE READ (through InnoDB's consistent snapshot): inside one transaction, every plain `SELECT` sees the same frozen view, even if another transaction commits meanwhile. In Postgres the default is READ COMMITTED: each statement takes a *fresh* snapshot, so a re-read inside the same transaction sees rows that were committed after it started. I proved it with two sessions and a `SLEEP(3)`.

```sql
-- MySQL REPEATABLE READ: the snapshot is frozen
first_read | second_read | after_commit
       3   |      3      |      103        -- concurrent UPDATE committed 103 mid-transaction
```

```sql
-- PostgreSQL READ COMMITTED: each statement re-snapshots
first_read | second_read | after_commit
       2   |     102     |      102        -- same concurrent UPDATE, seen on the second read
```

<figure>
<svg viewBox="0 0 680 250" width="100%" role="img" aria-label="Timeline comparison. In MySQL REPEATABLE READ a transaction reads 3, a concurrent update commits 103, and the same transaction still reads 3. In PostgreSQL READ COMMITTED the transaction reads 2, the update commits 102, and the next read returns 102.">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <text x="20" y="24" font-weight="600" font-size="14">Same transaction, two reads, one concurrent UPDATE</text>

    <!-- MySQL -->
    <text x="20" y="72" font-size="12" font-weight="600">MySQL · REPEATABLE READ</text>
    <line x1="20" y1="96" x2="640" y2="96" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
    <circle cx="60" cy="96" r="6" fill="currentColor"/>
    <text x="60" y="120" font-size="11" text-anchor="middle">read = 3</text>
    <circle cx="300" cy="96" r="6" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="300" y="120" font-size="11" text-anchor="middle">UPDATE → 103</text>
    <text x="300" y="82" font-size="10" text-anchor="middle" opacity="0.7">(another tx commits)</text>
    <circle cx="560" cy="96" r="6" fill="currentColor"/>
    <text x="560" y="120" font-size="11" text-anchor="middle">read = 3</text>
    <text x="560" y="140" font-size="10" text-anchor="middle" opacity="0.75">frozen — snapshot held</text>

    <!-- Postgres -->
    <text x="20" y="184" font-size="12" font-weight="600">PostgreSQL · READ COMMITTED</text>
    <line x1="20" y1="208" x2="640" y2="208" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
    <circle cx="60" cy="208" r="6" fill="currentColor"/>
    <text x="60" y="232" font-size="11" text-anchor="middle">read = 2</text>
    <circle cx="300" cy="208" r="6" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="300" y="232" font-size="11" text-anchor="middle">UPDATE → 102</text>
    <circle cx="560" cy="208" r="6" fill="currentColor"/>
    <text x="560" y="232" font-size="11" text-anchor="middle">read = 102</text>
    <text x="560" y="252" font-size="10" text-anchor="middle" opacity="0.75">fresh — re-snapshotted</text>
  </g>
</svg>
<figcaption>Neither default is wrong, but they change what "read then read again" means. Code that relies on a stable snapshot (reporting, export jobs, read-modify-write) behaves differently after a port.</figcaption>
</figure>

The practical consequence: code that leans on a stable repeatable read — a report that reads several tables and expects them to agree — works by accident on MySQL and needs `BEGIN ISOLATION LEVEL REPEATABLE READ` (or `SERIALIZABLE`) on Postgres. Code that expects a re-read to see fresh data works by accident on Postgres and is stale on MySQL. Neither is a bug; the default is just different.

## NULL, empty string, and boolean: loose vs strict

Both engines treat `NULL` and `''` as different values, which is what you want. MySQL on Linux, though, keeps SQL-mode strictness on by default (`STRICT_TRANS_TABLES`), so the *type* story is where they diverge, not the NULL story.

```sql
-- MySQL: BOOLEAN is really TINYINT(1)
SELECT TRUE AS t, FALSE AS f, TRUE + TRUE AS t_plus_t, (2 = 2) AS cmp;
+---+---+----------+-----+
| t | f | t_plus_t | cmp |
+---+---+----------+-----+
| 1 | 0 |        2 |   1 |
+---+---+----------+-----+
-- and it will happily store other integers in that "boolean" column:
INSERT INTO t_null (id, active) VALUES (3, 3);
SELECT active FROM t_null WHERE id = 3;  -- 3
```

```sql
-- PostgreSQL: boolean is a real type
SELECT 'yes'::boolean, 't'::boolean, 'on'::boolean;   -- t | t | t
INSERT INTO t_null (id, active) VALUES (5, '3');
ERROR:  invalid input syntax for type boolean: "3"
```

That is the whole flavour of the difference. MySQL's `BOOLEAN` is syntax sugar for `TINYINT(1)`; a column that is "true" can hold `3`. Postgres rejects nonsense, and it also accepts the boolean literals you'd expect (`yes`, `on`, `t`). If you rely on `WHERE active = 1` meaning "true", MySQL lets you get away with it forever; Postgres makes you say `WHERE active IS TRUE`.

## Identifier case and collation: the silent WHERE that matches the wrong rows

Two separate surprises live here. First, **identifier case**. Postgres folds unquoted identifiers to lowercase, so `Customers`, `CUSTOMERS`, and `customers` are all the same table. MySQL on Linux (`lower_case_table_names = 0`) treats table names as case-*sensitive*, and checkouts that move between macOS, Windows, and Linux regularly break for exactly this reason.

```sql
-- MySQL: created as "Customers"; this fails
SELECT * FROM CUSTOMERS;
ERROR 1146 (42S02): Table 'shop.CUSTOMERS' doesn't exist
-- and "customers" would be a *different* table

-- PostgreSQL: all three names resolve to the same lowercase table
SELECT id, name FROM CUSTOMERS;   -- works
SELECT id, name FROM customers;   -- works
```

Second, and far more dangerous: **default string comparison**. MySQL's default collation is case-insensitive (`utf8mb4_0900_ai_ci`), so `'a' = 'A'` is true and a `WHERE name = 'X'` matches `'x'`. Postgres is case-sensitive by default and only matches with `ILIKE` or a `citext`/lowercase index.

```sql
-- MySQL
SELECT 'a' = 'A' AS eq;                      -- 1
SELECT COUNT(*) FROM t_null WHERE name = 'X'; -- 1  (matched 'x')

-- PostgreSQL
SELECT 'a' = 'A' AS eq, 'a' ILIKE 'A' AS ilike;  -- f | t
SELECT COUNT(*) FROM t_null WHERE name = 'X';     -- 0
```

Porting a MySQL app to Postgres without noticing this turns case-insensitive lookups into "user not found" bugs, and porting Postgres to MySQL can turn a unique email constraint into a de-duplication nightmare. Pick one, be explicit about it (a `citext` column or a functional unique index on `lower(email)`), and write it down.

## Upsert: ON CONFLICT vs ON DUPLICATE KEY, and the missing RETURNING

Upserts are where dialect differences show up in almost every ORM. Postgres spells it `INSERT ... ON CONFLICT`, MySQL spells it `INSERT ... ON DUPLICATE KEY UPDATE`.

```sql
-- MySQL
INSERT INTO counters (name, hits) VALUES ('pageviews', 1)
  ON DUPLICATE KEY UPDATE hits = hits + 1;
```

```sql
-- PostgreSQL
INSERT INTO counters (name, hits) VALUES ('pageviews', 1)
  ON CONFLICT (name) DO UPDATE SET hits = counters.hits + 1
  RETURNING name, hits;

  name    | hits
----------+------
 pageviews |    2
(1 row)
```

Two real differences beyond spelling:

1. **`ON CONFLICT` names the conflict target** — `(name)` — so you choose which unique index absorbs the conflict. `ON DUPLICATE KEY UPDATE` fires on *any* unique key in the table, which is why a table with three unique constraints can update the "wrong" one in surprising ways.
2. **`ON CONFLICT` returns; MySQL does not.** Postgres's `RETURNING` gives you the written row back in the same round trip, and it works on `INSERT`, `UPDATE`, and `DELETE`. This is the difference I miss most when I'm on MySQL.

MySQL has no `RETURNING` at all — it is a hard syntax error — so you emulate it. The usual trick is to smuggle the value out through `LAST_INSERT_ID()`, but note how sharp the edge is: on the update path you must set it yourself, and it only carries one integer.

```sql
-- MySQL emulating RETURNING
INSERT INTO counters (name, hits) VALUES ('pageviews', 1)
  ON DUPLICATE KEY UPDATE hits = LAST_INSERT_ID(hits + 1);
SELECT LAST_INSERT_ID() AS returned_hits;   -- 3

INSERT INTO counters (name, hits) VALUES ('pageviews', 1) RETURNING name, hits;
ERROR 1064 (42000): You have an error in your SQL syntax ... near 'RETURNING name, hits'
```

For a multi-row upsert that must return every row's new state, MySQL forces you into a transaction: do the upsert, then a separate `SELECT`. Postgres does it in one statement. (MariaDB does implement `RETURNING`; it is MySQL proper that does not.)

## Postgres vs MySQL on types: jsonb, arrays, enums, ranges

This is the section where Postgres is objectively ahead, and it is usually the real reason people pick it.

**JSON.** MySQL has a `JSON` type and it is real — it normalizes and validates. Postgres has both `json` (raw text, no equality operator) and `jsonb` (parsed, canonical, indexable). The `jsonb` difference is not cosmetic:

```sql
-- PostgreSQL: jsonb normalizes and compares; json does not even have equality
SELECT '{"b":1,"a":2}'::jsonb;      -- {"a": 2, "b": 1}
SELECT '{"b":1,"a":2}'::jsonb = '{"a":2,"b":1}'::jsonb;  -- t
SELECT '{"b":1,"a":2}'::json   = '{"a":2,"b":1}'::json;  -- ERROR: operator does not exist: json = json
SELECT '{"a":1,"b":2}'::jsonb @> '{"a":1}'::jsonb;       -- t  (containment)
-- and you can index it directly:
CREATE INDEX ON evt USING gin (payload);
```

```sql
-- MySQL: JSON works, but you cannot index the column — only a generated path
CREATE INDEX idx_evt_payload ON evt (payload);
ERROR 3152 (42000): JSON column 'payload' supports indexing only via generated columns
                      on a specified JSON path.
-- the workaround:
ALTER TABLE evt ADD COLUMN kind VARCHAR(32)
  GENERATED ALWAYS AS (payload->>'$.kind') STORED;
CREATE INDEX idx_evt_kind ON evt (kind);
```

So "does it have JSON" is the wrong question — both do. "Can I index a JSON field and query containment cheaply" is the right one, and that is `jsonb`.

**Arrays, ranges, enums.** Postgres has all three as first-class types; MySQL has none of the first two and a quirky version of the third.

```sql
-- PostgreSQL
SELECT ARRAY[1,2,3] @> ARRAY[2] AS contains, 2 = ANY(ARRAY[1,2,3]) AS any_hit;   -- t | t
SELECT daterange('2026-01-01','2026-02-01') && daterange('2026-01-15','2026-03-01');  -- t
CREATE TYPE mood AS ENUM ('sad','ok','happy');
SELECT 'ok'::mood < 'happy'::mood;   -- t  (enums are ordered by definition)
```

```sql
-- MySQL
SELECT ARRAY[1,2,3];
ERROR 1064 (42000): ... near '[1,2,3]'
SELECT daterange('2026-01-01','2026-02-01');
ERROR 1305 (42000): FUNCTION shop.daterange does not exist
```

MySQL's `ENUM` exists but is a trap worth naming: it is stored as an integer position, so ordering follows the *definition order*, not alphabetical order, and adding a value in the middle renumbers it.

```sql
-- MySQL: enum sorts by internal index, not by value
SELECT id, mood, mood+0 AS internal_index FROM tasks ORDER BY mood;
| 2 | sad   | 1 |
| 1 | ok    | 2 |
| 3 | happy | 3 |
```

Postgres enums are a real type with a real order and safe `ALTER TYPE ... ADD VALUE`. If your domain has a fixed vocabulary, that is a meaningful difference.

## Window functions and CTEs: the gap mostly closed

A positive note: this is no longer a differentiator. Since MySQL 8.0, both engines support window functions and recursive CTEs, and the syntax is effectively identical.

```sql
-- same query, both engines
SELECT name, dept, salary,
       RANK() OVER (PARTITION BY dept ORDER BY salary DESC) AS rnk
FROM ...;
-- ann | eng | 120 | 1
-- bob | eng |  90 | 2
-- cid | ops | 100 | 1
```

If you are on MySQL 5.7, upgrade — this alone is worth it. The remaining edges are small: Postgres lets you force CTE materialisation (`WITH x AS MATERIALIZED`), which is a real tuning lever the MySQL planner does not expose. And if reading query plans is new to you, my companion post on [reading Postgres EXPLAIN output](/posts/postgres-explain/) walks through the same query shapes you'd meet here; the leftmost-prefix rules behind those index lookups are the same in both engines, which is what [database indexing basics](/posts/database-indexing/) is about.

## Extensions, tooling, and the replication ecosystem

Two very different ecosystems, and this is where the "systems" half of the decision lives.

- **Postgres: extensions are the moat.** `CREATE EXTENSION` gives you PostGIS, pgvector, TimescaleDB, `pg_stat_statements`, `pg_trgm`, `hstore`, and more, all inside the same transactional database. If your roadmap includes geospatial, vector search, or time-series, this decides the question for you.
- **MySQL: replication is the moat.** The ecosystem around MySQL replication — Vitess, PlanetScale, ProxySQL, group replication, and the maturity of read-replica fan-out — is deeper, and it is genuinely cheaper to scale reads out very wide. A logical-replication-first tooling culture (binlog CDC into Kafka etc.) is also strongest here.

In tooling terms they are close: `mysqldump`/`mysqlsh`, `mysqlpump`, and MySQL Enterprise Backup on one side; `pg_dump`/`pg_restore`, `pg_basebackup`, and `pgBackRest` on the other. Both have excellent managed offerings. Neither is starved.

## The operational story: backups, upgrades, failover

At a high level, honestly, these are comparable and the differences are cultural:

- **Backups.** Logical (`pg_dump`, `mysqldump`) and physical (WAL archiving / `pg_basebackup` vs InnoDB redo/binlog) exist on both. Postgres point-in-time recovery via WAL archive is the reference model; MySQL's binlog-based PITR is equally real. Either way, the thing that saves you is a *tested restore*, which is why I write about [backups you can actually restore](/posts/backups-you-can-restore/) rather than about the dump command.
- **Upgrades.** MySQL's 8.x upgrade path is well-trodden, and in-place minor upgrades are routine. Postgres historically nudged you toward `pg_upgrade` (link/copy mode or the slower dump-reload), and major versions require a real plan. Both now offer logical replication as a low-downtime migration path.
- **Failover.** Both have managed and self-managed answers — Patroni/etcd, repmgr, or a managed cluster on the Postgres side; Group Replication/InnoDB Cluster, orchestrator, or a managed cluster on MySQL's. The honest point is not which is better but which your team has rehearsed.

## So which one? A decision list

Stop asking which database is faster and ask these, in order:

1. **Do you need a Postgres extension?** PostGIS, pgvector, TimescaleDB — if yes, Postgres, and stop here.
2. **Do you need a JSON document field you can index and query by containment?** Postgres `jsonb`. MySQL can, but only through generated columns.
3. **Do you need arrays, ranges, or strict booleans?** Postgres. MySQL's `ENUM`/`BOOLEAN` quirks are a tax you will pay eventually.
4. **Are you already on managed MySQL with a replica topology you trust?** Stay there — unless one of 1–3 is true.
5. **Is your team's operational experience one-sided?** Pick the boring, familiar one. Failover is a people problem, not a database-feature problem.
6. **Are you shipping a small app and just want simplicity?** Either. If it is truly small, [SQLite is often enough](/posts/sqlite-is-enough/) and you can defer this whole decision.

The punchline is the boring one: **MySQL vs PostgreSQL** is rarely a question of capability and almost always a question of fit. Know the defaults, know the dialect, and pick the one your team can run at 3 a.m. The bite comes from not knowing that MySQL's default is REPEATABLE READ, that its comparison is case-insensitive, and that `RETURNING` is a Postgres-only luxury — not from picking the "wrong" engine.
