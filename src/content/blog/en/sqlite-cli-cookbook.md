---
title: "The sqlite3 CLI cookbook: the database you can use without a server"
description: "Hands-on with the sqlite3 CLI: open a database, use the dot commands, import and export CSV, run one-off sqlite commands with -line/-json/-csv, script them with .read, take a safe sqlite backup instead of cp, set WAL and foreign keys with sqlite pragma, and read EXPLAIN QUERY PLAN."
pubDate: 2026-12-04
lang: en
translationKey: sqlite-cli-cookbook
tags: [devops, linux]
featured: false
keywords:
  - sqlite3 CLI
  - sqlite commands
  - sqlite backup
  - sqlite pragma
  - WAL
---

Most people meet SQLite through a driver inside some application and never touch the **sqlite3 CLI**. That is a shame, because the shell is the whole database in one binary: create a file, run **sqlite commands** against it, import a CSV, take a **sqlite backup**, inspect a plan, and never install a server or open a port. I use it for real work every week — poking at an app's database, converting exports, checking a **sqlite pragma** before shipping. This is the cookbook I wish I had: the **dot commands** that matter, with the actual terminal output, generated on SQLite 3.53.4. Everything below is real output from a throwaway database, not a cleaned-up illustration.

The whole session lives in a scratch directory:

```bash
mkdir -p /tmp/opencode/work/sqlite-cookbook
cd /tmp/opencode/work/sqlite-cookbook
sqlite3 shop.db
```

That last command opens `shop.db`, creating it if it does not exist. When the prompt changes to `sqlite>`, you are inside the shell. Quit with `.quit` or Ctrl-D. Because the database is a file, nothing is running between sessions — there is no daemon to start, no port to check, and no credentials to configure. That is the point of the whole tool: the smallest possible step between a question and an answer. The shell keeps a history in `~/.sqlite_history`, so the query you ran last week is usually one arrow-key away.

## Opening a database with the sqlite3 CLI and the dot commands you will live in

**Dot commands** are the CLI's own mini-language. They start with a dot, take no semicolon, and answer questions you would otherwise write SQL for. The four you use constantly are `.tables`, `.schema`, `.mode`, and `.headers`.

Load a small shop schema, turn on WAL, and look at what you have:

```bash
sqlite3 shop.db <<'SQL'
PRAGMA journal_mode = WAL;
CREATE TABLE customers (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  email   TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL DEFAULT 'US'
);
CREATE TABLE orders (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  total_cents INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_orders_customer ON orders(customer_id);
SQL
```

`.tables` lists the tables; `.schema` prints the DDL that would recreate them. Note that `.schema orders` also shows the index on that table:

```sql
sqlite> .tables
customers     orders

sqlite> .schema orders
CREATE TABLE orders (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  total_cents INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_orders_customer ON orders(customer_id);
```

`.mode` chooses the output format and `.headers` decides whether column names are printed. The nicest interactive default is `box`:

```sql
sqlite> .headers on
sqlite> .mode box
sqlite> SELECT id, name, country FROM customers ORDER BY id;
╭────┬────────────────┬─────────╮
│ id │      name      │ country │
╞════╪════════════════╪═════════╡
│  1 │ Ada Lovelace   │ UK      │
│  2 │ Grace Hopper   │ US      │
│  3 │ Alan Turing    │ UK      │
│  4 │ Barbara Liskov │ US      │
╰────┴────────────────┴─────────╯
```

Other modes earn their keep in scripts: `column`, `list`, `csv`, `json`, `insert`. Put any of them in a `.sqliterc` file in your home directory and they load on every session.

## Importing CSV with .import, and the column-count trap

`.import FILE TABLE` reads CSV into a table, creating the table from the header row if it does not exist. The trap is that if the table *does* exist, `.import` fills **all** of its columns — so a file with four columns cannot go straight into a five-column table. Feed a four-column file to `orders` and SQLite tells you exactly what went wrong:

```sql
sqlite> .mode csv
sqlite> .import new_orders.csv orders
new_orders.csv:1: expected 5 columns but found 4 - filling the rest with NULL
new_orders.csv:1: INSERT failed: datatype mismatch
new_orders.csv:2: expected 5 columns but found 4 - filling the rest with NULL
new_orders.csv:2: INSERT failed: NOT NULL constraint failed: orders.created_at
...
```

The rows are rejected, not silently mangled — but the right pattern is to stage the file into a temp table that matches it, then move the data with SQL. Since SQLite 3.32, `.import --csv --skip 1` skips the header so it does not land in your data:

```sql
sqlite> CREATE TEMP TABLE staging(customer_id INTEGER,total_cents INTEGER,status TEXT,created_at TEXT);
sqlite> .import --csv --skip 1 new_orders.csv staging
sqlite> SELECT count(*) AS staged FROM staging;
3
sqlite> INSERT INTO orders (customer_id,total_cents,status,created_at)
   ...>   SELECT customer_id,total_cents,status,created_at FROM staging;
sqlite> SELECT count(*) AS orders_now FROM orders;
9
```

Staging gives you a chance to validate before the data touches the real table, which matters more than the two lines it costs.

## Querying from the shell: one-off sqlite commands with -line, -json, -csv

You rarely need the interactive prompt for a one-off query. The shell takes flags that set the mode for you, which is what makes it a scripting tool:

```bash
sqlite3 -line shop.db "SELECT id,status,total_cents FROM orders WHERE status='paid' ORDER BY total_cents DESC LIMIT 2;"
         id: 4
     status: paid
total_cents: 78000

         id: 2
     status: paid
total_cents: 12500

sqlite3 -json shop.db "SELECT name,country FROM customers ORDER BY id LIMIT 2;"
[{"name":"Ada Lovelace","country":"UK"},
{"name":"Grace Hopper","country":"US"}]

sqlite3 -csv -header shop.db "SELECT id,name FROM customers ORDER BY id LIMIT 2;"
id,name
1,"Ada Lovelace"
2,"Grace Hopper"
```

`-line` is for reading, `-json` is for piping into `jq`, `-csv` is for spreadsheets and other tools. Add `-header` to any of them. For anything longer than one statement, pass the SQL through a heredoc or a file — the shell runs each statement in order and stops on error.

## sqlite backup: .backup, .dump, and why cp fails on a live database

This is the section to tattoo on your arm. In WAL mode, committed transactions live in the `-wal` file until a checkpoint folds them back into the main file. Copy only the main file and you copy a database that is missing data — or missing the schema entirely. I opened a live connection, wrote 5,000 rows, and copied the file both ways while the connection stayed open:

```bash
$ ls -l live.db live.db-wal
-rw-r--r-- 1 me me   4096 Dec  4 11:20 live.db
-rw-r--r-- 1 me me  98912 Dec  4 11:20 live.db-wal

$ cp live.db torn.db                  # WRONG: ignores the -wal file
$ sqlite3 live.db ".backup good.db"   # RIGHT: online backup
$ sqlite3 torn.db "SELECT count(*) FROM events;"
Error: no such table: events
$ sqlite3 good.db "SELECT count(*) FROM events;"
5000
```

The `cp` copy is 4 KB of schema-less main file; the real data is still in the log, and the copy has no `events` table at all. A `cp` that happens to catch a checkpoint looks fine and is the most dangerous kind. The `.backup` command uses SQLite's online backup API: it takes a consistent snapshot while the database is being written, and it is safe on a live file.

```bash
# consistent snapshot of a running database
sqlite3 /var/lib/app/app.db ".backup '/srv/backup/app.db'"

# always verify the result before you trust it
sqlite3 /srv/backup/app.db "PRAGMA integrity_check;"
```

`.dump` is the other tool, and it is a different thing. It emits the schema and every row as SQL text, which makes it ideal for version-controlling a small database or moving it between machines:

```bash
$ sqlite3 shop.db ".dump" | head -3
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE customers (
...
$ sqlite3 shop.db ".dump" > shop.sql
$ sqlite3 reloaded.db < shop.sql
$ sqlite3 reloaded.db "SELECT count(*) FROM orders;"
9
```

Use `.backup` for binary, drop-in copies; use `.dump` when you want a diffable text artifact. For the same reason `cp` is unsafe, a filesystem snapshot of a *running* WAL database needs the `-wal` file too — which is exactly what `.backup` handles for you. The cost of getting this wrong is the worst kind: the copy opens fine, `SELECT`s return rows, and you only discover the gap the day you need a restore. The broader lesson shows up in [Backups you can actually restore](/posts/backups-you-can-restore/).

## sqlite pragma: WAL, foreign keys, and integrity checks

A **sqlite pragma** is a per-connection or per-database setting accessed as `PRAGMA name = value`. Four of them pay for themselves immediately.

`journal_mode = WAL` is the single highest-leverage change for a read-heavy app; it persists in the file header, so setting it once is enough. `foreign_keys` is off by default per connection and must be turned on explicitly — the pragma does not persist:

```sql
sqlite> PRAGMA journal_mode;
wal
sqlite> PRAGMA foreign_keys;   -- a fresh connection
0
sqlite> PRAGMA foreign_keys = ON;
sqlite> INSERT INTO orders (customer_id,total_cents,created_at) VALUES (999,100,'2026-12-05');
Error near line 1: FOREIGN KEY constraint failed
```

Before the pragma, that orphan insert would have succeeded silently. `integrity_check` is the one to run on a backup or after anything suspicious — `quick_check` is a faster, less thorough variant:

```bash
$ sqlite3 shop.db "PRAGMA integrity_check;"
ok
$ sqlite3 shop.db "PRAGMA quick_check;"
ok
```

Two more worth knowing: `busy_timeout` (wait for the write lock instead of failing instantly with `SQLITE_BUSY`) and `synchronous = NORMAL` (fast and safe under WAL). Set them in `.sqliterc` or at the top of every connection. If you want the reasoning behind WAL's one-writer model, it is in [SQLite is enough](/posts/sqlite-is-enough/).

## EXPLAIN QUERY PLAN: making the planner talk

`EXPLAIN QUERY PLAN` is how you find out whether SQLite is using your index. It shows the access path, not the timings — for a small database that is plenty. Before an index on `status`, the plan is a full scan; after, it is a search:

```sql
sqlite> EXPLAIN QUERY PLAN SELECT id,total_cents FROM orders WHERE status='paid';
QUERY PLAN
`--SCAN orders

sqlite> CREATE INDEX idx_orders_status ON orders(status);
sqlite> EXPLAIN QUERY PLAN SELECT id,total_cents FROM orders WHERE status='paid';
QUERY PLAN
`--SEARCH orders USING INDEX idx_orders_status (status=?)

sqlite> EXPLAIN QUERY PLAN SELECT c.name,o.total_cents
   ...>   FROM customers c JOIN orders o ON o.customer_id=c.id WHERE c.country='UK';
QUERY PLAN
|--SCAN c
`--SEARCH o USING INDEX idx_orders_customer (customer_id=?)
```

Read it as: `SCAN` means every row, `SEARCH ... USING INDEX` means a lookup, and the nested indentation is the join order. If a query you expected to be indexed shows `SCAN`, look for a function on the column, a type mismatch, or low selectivity before you add another index — the same discipline as [database indexing basics](/posts/database-indexing/).

## .read, ATTACH, and loading extensions

A `.read FILE` runs a script of dot commands and SQL, which turns a folder of queries into a reusable report. Define it once:

```sql
.headers on
.mode column
.width 20 8 12
SELECT c.name, o.status, o.total_cents
FROM customers c JOIN orders o ON o.customer_id = c.id
ORDER BY o.total_cents DESC LIMIT 3;
```

```bash
$ sqlite3 shop.db ".read report.sql"
        name           status   total_cents
--------------------  --------  ------------
Alan Turing           paid             78000
Alan Turing           pending          45000
Ada Lovelace          paid             12500
```

`ATTACH` gives one connection several databases at once, addressed by schema name — the clean way to move rows between files without dumping:

```sql
sqlite> ATTACH DATABASE 'archive.db' AS archive;
sqlite> CREATE TABLE archive.orders_2025 (id INTEGER PRIMARY KEY, total_cents INTEGER);
sqlite> INSERT INTO archive.orders_2025 (total_cents)
   ...>   SELECT total_cents FROM main.orders WHERE created_at < '2026-11-20';
sqlite> SELECT count(*) AS archived FROM archive.orders_2025;
2
sqlite> SELECT count(*) AS still_live FROM main.orders WHERE created_at >= '2026-11-20';
7
```

Extensions load with `.load` in the shell. The CLI enables extension loading by default — you can see the flag in `.dbconfig` — while a library embedding SQLite keeps it off, which is why the same call from Python fails until you enable it explicitly:

```sql
sqlite> .dbconfig
     load_extension on
...
```
```python
>>> import sqlite3
>>> sqlite3.connect(":memory:").load_extension("./nope.so")
OperationalError: not authorized
```

Plenty of extensions are already compiled in and need no loading at all — JSON and full-text search are the everyday examples:

```sql
sqlite> SELECT sqlite_version(),
   ...>        json_extract('{"a":1,"b":[2,3]}','$.b[1]');
3.53.4|3
sqlite> CREATE VIRTUAL TABLE notes USING fts5(body);
sqlite> INSERT INTO notes(body) VALUES ('sqlite is a library, not a server');
sqlite> SELECT body FROM notes WHERE notes MATCH 'library';
sqlite is a library, not a server
```

## The cookbook, shortened

The commands that cover ninety percent of real use: `.tables` and `.schema` to see what you have, `.mode` and `.headers` to shape output, `.import --csv --skip 1` to load a file, `-line`/`-json`/`-csv` for scripted queries, `.backup` (never `cp`) for a live database, `PRAGMA journal_mode=WAL` plus `foreign_keys=ON` and `integrity_check`, `EXPLAIN QUERY PLAN` when something feels slow, `.read` for scripts, and `ATTACH` when one file is not enough. That is a complete database toolkit in one binary you already have — no daemon, no port, no connection string. Keep a scratch directory like the one above and the next "can you check the app's database?" becomes a two-minute task instead of a deployment.
