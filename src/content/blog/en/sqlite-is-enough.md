---
title: "SQLite is enough: using SQLite in production (and when it isn't)"
description: "A practical case for SQLite in production: what it really is, its one-writer concurrency model and WAL mode, busy_timeout, online backups with the backup API, migrations, and exactly when SQLite vs Postgres becomes a real decision instead of a reflex."
pubDate: 2026-11-09
lang: en
translationKey: sqlite-is-enough
tags: [devops, self-hosting, linux]
featured: false
keywords:
  - SQLite in production
  - SQLite vs Postgres
  - WAL mode
  - embedded database
  - backup
---

Ask about **SQLite in production** in a room of backend engineers and you get one of two reactions: a shrug from people who have never shipped it, or a lecture about how it "doesn't scale". Both are answering a question nobody asked. For a blog, a CLI, or an internal tool, the question is not "what does Google run", it is "what is the smallest database that will not fall over for the next two years". Most of the time the answer is SQLite, and the reason people avoid it is a category error about what SQLite even is. So let me make the case for **SQLite in production**, then be honest about exactly when it stops being enough and **SQLite vs Postgres** becomes a real decision.

## Why the knee-jerk against SQLite is usually wrong

The reflex is "toy database". It comes from mobile apps and tutorials where SQLite is a local cache, never the source of truth. That is a real use, but it is not the only one, and it taught a generation the wrong lesson.

The deeper reason SQLite gets dismissed is that people compare it to a *server*. Postgres and MySQL are network services with connection pools, a planner tuned for concurrency, background maintenance, and a whole operational surface. SQLite is not a smaller version of that. Judging it by server-database criteria is like judging a bicycle by how well it tows a trailer — technically a valid comparison, mostly irrelevant.

The cost of the knee-jerk is concrete. Instead of a file and a library, you take on a second process to deploy, a daemon to monitor, a connection string to rotate, credentials to back up, a network hop on every query, and a service that can be down while your app is up. For a small app, that is a pile of operational work that buys you nothing you needed. The honest default for one worker on one machine should be SQLite, and Postgres should be the deliberate upgrade, not the other way around.

## What SQLite actually is: an embedded database, a library, a file

Strip away the framing and SQLite is three things:

- **A library.** Not a binary you run, but a C library you link into your process. There is no server, no socket, no port.
- **An embedded database.** It runs *in-process*. A query is a function call, not a network round trip, which is why query latency is measured in microseconds, not milliseconds.
- **A file.** All state lives in one file (plus, in WAL mode, a write-ahead log and a shared-memory file). Copy the file and you have copied the database. That single fact makes backup, testing, and local development almost trivially easy.

That is the whole architecture. It is also why SQLite is the most deployed database engine on the planet — it is inside your phone, your browser, and about ten thousand other places that never paid for a database server.

## SQLite's concurrency model: one writer, WAL mode

This is the part that decides whether SQLite works for you, so read it carefully. SQLite allows **one writer at a time**. It always has. Readers and writers are managed through locking, and the modern default is write-ahead logging.

In the legacy rollback-journal mode, a writer blocks all readers. In **WAL mode**, readers and the writer do not block each other: readers see a consistent snapshot while a write happens, and changes append to the log. What WAL does *not* change is the single-writer rule. You get many concurrent readers and exactly one writer, serialized. If two writes arrive at once, one waits (up to `busy_timeout`) or fails with `SQLITE_BUSY`.

For the workloads SQLite is meant for, this is fine, because writes are short and reads dominate. The trap is long write transactions. Holding a write transaction open while you call an external API or wait on a lock serializes your whole app behind it, and no amount of tuning fixes that. Keep write transactions short and you will rarely see contention.

## SQLite vs Postgres: the real limits

There are three limits that actually matter, and the marketing around them is usually exaggerated.

### It is a single machine

SQLite's data is a file on one machine's filesystem. If that machine dies, the database is only as available as the machine. You cannot run two app servers writing to the same file over NFS — file locking over network filesystems is unreliable, and doing so corrupts data. One machine, one filesystem.

That is a hard limit, but "one machine" is a huge amount of capacity in 2026. A modern box with NVMe handles more reads and short writes than most internal tools will ever generate. The limit is real; whether it binds *you* is a separate question.

### Write concurrency is the real ceiling

Single-machine is about availability; write concurrency is about throughput. Because writes serialize, a write-heavy workload — high-frequency inserts from many concurrent workers, an analytics ingest, a queue — will hit the ceiling fast. If your app writes on every request from every user, SQLite is the wrong tool and you should say so early.

### There is no network protocol

SQLite speaks function calls, not a wire protocol. There is no client to connect remotely, no `psql` across the network, no read replica to point at. Everything that talks to the database must run on the same host. For a blog or an internal tool this is a feature; for a fleet of services it is a wall.

Notice what is *not* on the list: "not ACID", "corrupts under load", "can't do joins". SQLite is fully ACID, supports joins, indexes, CTEs, window functions, JSON, full-text search, and transactions. The concerns people raise about correctness are mostly myths; the concerns about scale are real but narrower than advertised.

## How to use SQLite in production well

The difference between SQLite that works and SQLite that bites you is a handful of settings and habits.

### Turn on WAL mode

WAL is the single highest-leverage change. Set it once; it persists in the database file.

```sql
-- run once, persisted in the DB header
PRAGMA journal_mode = WAL;
```

Do it at startup on every connection anyway — it is idempotent — and remember it creates a `-wal` and a `-shm` sibling file. Backups must account for them.

### Set busy_timeout

With one writer, contention is not a failure, it is a wait. Without a timeout, SQLite returns `SQLITE_BUSY` immediately, turning a brief overlap into an app-level error. `busy_timeout` tells SQLite how long to wait for the lock before giving up.

```sql
PRAGMA busy_timeout = 5000;  -- wait up to 5s instead of failing instantly
PRAGMA synchronous = NORMAL; -- safe with WAL, much faster than FULL
```

With WAL, `synchronous = NORMAL` is durable against application crashes and only risks the last transactions on an OS crash or power loss — a trade most small apps are happy to make. Enable `FOREIGN KEYS` explicitly too, per connection, because it is off by default.

### Backups: the backup API and `.backup`

Never `cp` a live SQLite file. In WAL mode especially, copying the main file alone gives you a torn database: committed transactions may still be in the log. Use the online backup API or the `.backup` command, which take a consistent snapshot while the database is running.

```bash
# consistent online snapshot, safe on a live database
sqlite3 /var/lib/app/app.db ".backup '/srv/backup/app.db'"

# verify it before trusting it
sqlite3 /srv/backup/app.db "PRAGMA integrity_check;"
```

For a service with a restic-based pipeline, back up the *snapshot*, not the hot file — the same lesson as in [Backups you can actually restore](/posts/backups-you-can-restore/). If you would rather avoid shelling out, every serious binding exposes a backup function; in Python it is `sqlite3.Connection.backup`.

```python
import sqlite3
src = sqlite3.connect("app.db")
dst = sqlite3.connect("/srv/backup/app.db")
with dst:
    src.backup(dst)   # consistent, incremental, no .backup shell-out
```

### Migrations

SQLite's `ALTER TABLE` is limited — you can add a column, rename a table, but not drop or change a column's type in older versions. The reliable pattern is the one every migration tool uses: version the schema, and for complex changes create a new table, copy, drop, rename, all inside one transaction.

```sql
BEGIN;
CREATE TABLE user_new (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
INSERT INTO user_new SELECT id, email FROM user;
DROP TABLE user;
ALTER TABLE user_new RENAME TO user;
PRAGMA user_version = 3;   -- track the schema version in the file itself
COMMIT;
```

`PRAGMA user_version` is a cheap migration ledger stored in the file header, and it survives backups and copies. Alembic, Diesel, sqlx, and most other ecosystems support SQLite targets, so you rarely write this by hand — but you should know what they are doing.

## When to graduate to Postgres

Move to Postgres when one of these is true, not when a blog post scares you:

- **Multiple machines must write.** Replicas, failover, or two app servers need Postgres (or another networked engine).
- **Writes are the workload.** Sustained concurrent writes, an ingest pipeline, a job queue at volume.
- **You need the server feature set.** Rich roles and permissions, logical replication, extensions like PostGIS, streaming backups, `pg_stat_statements`.
- **Operational separation matters.** Someone else needs to connect from elsewhere, or the database must be independently scaled, backed up, and restored.

Before that, the migration is usually a day of work: the schema and most queries carry over, and you swap SQLite for a driver. Doing it late is a deliberate cost; doing it early is paying that cost for years of capacity you never needed.

## Concrete guidance by app type

Different apps, different answers:

- **A blog.** SQLite is not just enough, it is ideal. Read-heavy, one writer (you), no HA requirement. WAL mode, `busy_timeout`, and a `.backup` dropped into your [self-hosting setup](/posts/self-hosting-without-docker/) is the whole database story. This is what I run.
- **A CLI.** SQLite is already in the box. One file per project or user, no server to install, trivially portable, and easy to test because a fresh database is a temp file.
- **An internal tool.** SQLite until writes or machines multiply. A dashboard read by twenty people and written by one cron job will never outgrow one file. Watch write concurrency, not user count.

The rule I use: pick SQLite, and write down the two conditions that would force a move to Postgres for *this* app. Then revisit only when one of them is actually met.
