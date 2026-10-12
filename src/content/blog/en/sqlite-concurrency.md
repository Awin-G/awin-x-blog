---
title: "SQLite concurrency: the locking model, WAL, and why you get \"database is locked\""
description: "A practical guide to SQLite locking with real experiments: why the default rollback journal returns \"database is locked\" (SQLITE_BUSY), how WAL mode lets readers run during a write, and the one-writer rule, with busy_timeout and synchronous trade-offs and real timings."
pubDate: 2027-01-08
lang: en
translationKey: sqlite-concurrency
tags: [devops, python]
featured: false
keywords:
  - SQLite locking
  - database is locked
  - WAL mode
  - SQLITE_BUSY
  - busy_timeout
---

**SQLite locking** is the part of SQLite everyone meets during an incident: one process dies with `sqlite3.OperationalError: database is locked`, your logs fill up with `database is locked`, and the advice you find is a pile of magic pragmas. This is the version I run on real databases: what the **journal mode** actually does, why the default one makes two writers collide, what **SQLITE_BUSY** really means, how **WAL mode** changes the picture (and what it does *not* change), and what to do about it. Every number and error below is from a real run — Python 3.14, SQLite 3.53.4, ext4-on-LUKS disk — not from memory.

## The default is a rollback journal, and rollback means exclusivity

A fresh database is in `delete` mode — a rollback journal. Before the first write, SQLite creates a `-journal` file next to the database; on commit, the journal is applied and deleted. The name tells you the concurrency story: to keep the rollback correct, the writer escalates from a RESERVED lock to an **EXCLUSIVE** lock for the commit, and while it can't get that, every other writer is shut out.

Two writers, zero tolerance, nothing fancy:

```python
import sqlite3

a = sqlite3.connect("db.sqlite3", timeout=0)   # timeout=0: do not wait at all
a.execute("BEGIN IMMEDIATE")
a.execute("INSERT INTO t VALUES ('A')")

b = sqlite3.connect("db.sqlite3", timeout=0)   # second writer
b.execute("INSERT INTO t VALUES ('B')")        # <-- the one everyone hits
```

Real output from that run:

```
Traceback (most recent call last):
  File "<stdin>", line 11, in <module>
sqlite3.OperationalError: database is locked
```

That is `SQLITE_BUSY` surfacing as Python's `OperationalError`. Note `timeout=0` — by default `sqlite3.connect()` sets a busy timeout of **5 seconds**, so in real code the same line doesn't fail instantly, it hangs for five seconds and *then* raises that error. That is exactly the "mystery five-second pause before the crash" pattern you see in Celery/RQ/Sidekiq-style workers.

## What `database is locked` actually means

`database is locked` is not corruption and not a deadlock SQLite will resolve for you. It means: *this connection asked for a lock, the lock was held, and the busy handler gave up*. SQLite tells you the truth, immediately, and there is no queue, no fairness, and no ordering — whoever retries next wins.

Watch the difference a busy handler makes. Same two-process collision, holder keeps the lock for 3 seconds, second writer tries three different timeouts:

```
[holder] journal_mode=delete
[holder] write lock acquired (BEGIN IMMEDIATE), row inserted, holding 3.0s
--- probe with timeout=0s ---
[probe] timeout=0.0s -> OperationalError: database is locked (after 0.000306s, therefore immediate)
--- probe with timeout=1.5s ---
[probe] timeout=1.5s -> OperationalError: database is locked (after 1.502906s, therefore immediate)
[holder] committed -> lock released
--- probe with timeout=5s ---
[probe] timeout=5.0s -> INSERT committed in 2.432s (rows now: 4)
```

`busy_timeout` (Python's `timeout=`, raw SQL `PRAGMA busy_timeout=...`) is the single knob that decides whether your failure is instant or patient. Neither value fixes the underlying collision — it just picks the flavor.

## WAL mode: readers stop caring about the writer

WAL (write-ahead logging) flips the file layout. Writers append new pages to a separate `-wal` file instead of rewriting the main database; readers consult the main database plus the WAL's commit records and see a consistent snapshot. Two sidecar files appear next to the database while any WAL connection is open — `db.sqlite3-wal` and `db.sqlite3-shm` (the shared-memory index). On a clean close of the last connection they are checkpointed in and deleted; the first new WAL connection re-creates them.

Switching over is one line, and it sticks:

```
$ sqlite3 app.db 'PRAGMA journal_mode=WAL;'
wal
$ sqlite3 app.db 'PRAGMA journal_mode; PRAGMA synchronous; PRAGMA wal_autocheckpoint;'
wal
2
1000
```

`2` for `synchronous` is FULL, `1000` pages is the default WAL auto-checkpoint threshold. Now the practical test — a writer holds an open transaction while a reader runs:

```
$ python3 exp2_wal.py
journal_mode       = 'wal'
sidecar files now  = ['wal.db-shm', 'wal.db-wal']

[writer] BEGIN IMMEDIATE + INSERT done (NOT committed); sidecars: ['wal.db-shm', 'wal.db-wal']
[reader] SELECT while writer is mid-transaction -> (1, 1) in 0.000126s  (sees old snapshot: no new row)
[writer2] OperationalError: database is locked (after 0.000225s) -> WAL has ONE writer too
[writer] committed
[reader2] SELECT after commit -> (2, 2)
```

Read that carefully, because it contains both promises and the fine print. The reader sailed through — `0.000126s`, no lock competition at all — even though the writer had uncommitted pages out. That is the whole WAL win, and it is the difference between "reads and writes share one file" and "reads and writes interrupt each other". And the fine print: **a second writer still got `database is locked`**. WAL changes who blocks the writer (nobody, now), not how many writers there may be.

Figure it in one picture — readers during a write, before and after:

<figure>
<svg viewBox="0 0 680 340" width="100%" role="img" aria-label="Two panels. Left: rollback journal mode — the writer takes an exclusive lock, readers and a second writer are blocked waiting. Right: WAL mode — the writer appends to the -wal file while two readers keep reading the database snapshot, though a second writer still waits.">
  <g font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="currentColor">
    <text x="170" y="24" text-anchor="middle">Rollback journal (default, journal_mode=delete)</text>
    <text x="510" y="24" text-anchor="middle">WAL mode (journal_mode=WAL)</text>
  </g>

  <!-- left panel: rollback -->
  <rect x="20" y="36" width="300" height="288" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
  <rect x="60" y="66" width="220" height="46" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="170" y="86" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">db.sqlite3</text>
  <text x="170" y="103" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="currentColor" opacity="0.7">+ db.sqlite3-journal</text>

  <rect x="60" y="126" width="220" height="26" rx="6" fill="#0f766e" opacity="0.15" stroke="#0f766e" stroke-width="1.5"/>
  <text x="70" y="143" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">writer1: RESERVED -> EXCLUSIVE</text>
  <text x="282" y="143" text-anchor="end" font-family="ui-monospace, monospace" font-size="12" fill="#0f766e">✗ in commit</text>

  <g font-family="ui-monospace, monospace" font-size="12" fill="currentColor">
    <text x="60" y="190">writer2</text>
    <text x="150" y="190">: BEGIN IMMEDIATE</text>
    <text x="282" y="190" text-anchor="end" fill="#0f766e">✗ database is locked</text>
    <text x="60" y="218">reader1</text>
    <text x="150" y="218">: SELECT ...</text>
    <text x="282" y="218" text-anchor="end" fill="currentColor" opacity="0.6">✗ waits (blocked at EXCLUSIVE)</text>
    <text x="60" y="246">reader2</text>
    <text x="150" y="246">: SELECT ...</text>
    <text x="282" y="246" text-anchor="end" fill="currentColor" opacity="0.6">✗ waits</text>
  </g>
  <text x="60" y="292" font-family="system-ui, sans-serif" font-size="11" fill="currentColor" opacity="0.7">everyone queues behind one writer</text>

  <!-- right panel: WAL -->
  <rect x="360" y="36" width="300" height="288" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
  <rect x="380" y="66" width="110" height="46" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="435" y="86" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">db.sqlite3</text>
  <text x="435" y="103" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="currentColor" opacity="0.7">+ -shm</text>
  <rect x="530" y="66" width="110" height="46" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="585" y="86" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="#0f766e">db.sqlite3-wal</text>
  <text x="585" y="103" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="#0f766e" opacity="0.8">append-only</text>

  <path d="M495 89 L524 89" stroke="#0f766e" stroke-width="1.5" fill="none" marker-end="url(#arr)"/>
  <defs>
    <marker id="arr" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 z" fill="#0f766e"/>
    </marker>
  </defs>
  <rect x="380" y="126" width="260" height="26" rx="6" fill="#0f766e" opacity="0.15" stroke="#0f766e" stroke-width="1.5"/>
  <text x="390" y="143" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">writer1: appends to -wal</text>
  <text x="632" y="143" text-anchor="end" font-family="ui-monospace, monospace" font-size="12" fill="#0f766e">✓ running</text>

  <g font-family="ui-monospace, monospace" font-size="12" fill="currentColor">
    <text x="380" y="190">reader1</text>
    <text x="470" y="190">: SELECT ...</text>
    <text x="632" y="190" text-anchor="end" fill="#0f766e">✓ snapshot</text>
    <text x="380" y="218">reader2</text>
    <text x="470" y="218">: SELECT ...</text>
    <text x="632" y="218" text-anchor="end" fill="#0f766e">✓ snapshot</text>
    <text x="380" y="246">writer2</text>
    <text x="470" y="246">: BEGIN IMMEDIATE</text>
    <text x="632" y="246" text-anchor="end" fill="#0f766e">✗ locked (1 writer max)</text>
  </g>
  <text x="380" y="292" font-family="system-ui, sans-serif" font-size="11" fill="currentColor" opacity="0.7">readers never block; still one writer at a time</text>
</svg>
<figcaption>Left: with the default rollback journal the writer holds a RESERVED-to-EXCLUSIVE lock for the commit, so readers pause at commit time and a second writer is shut out from the start. Right: in WAL mode the writer appends to the <code>-wal</code> file and readers keep serving snapshots — but WAL does not license a second writer.</figcaption>
</figure>

Under a *stream* of writes the reader story is even starker than one snapshot suggests. One writer committing in a tight loop, one reader with `timeout=0`, 300 attempts:

```
journal=delete  reader SELECTs:   0 ok, 300 failed in 0.00s  (['database is locked'])
journal=wal     reader SELECTs: 300 ok,   0 failed in 0.02s  (['no errors'])
```

Every single read failed under the rollback journal while the writer held it; in WAL, all 300 succeeded. If your app has a background job writing while your web tier reads, this table is the whole argument.

## The one-writer rule, in numbers

Five connections (a realistic pool), ten small transactions each, ten milliseconds of work inside each transaction, `busy_timeout=0`:

```
journal=delete  busy_timeout=0    -> 10 ok, 40 'database is locked', rows=10, wall=0.10s
journal=wal     busy_timeout=0    ->  9 ok, 41 'database is locked', rows=9,  wall=0.09s
```

WAL did not save anyone: 41 of 50 writes still failed. That is the honest **single writer** rule — in *any* journal mode, at most one writer holds the write lock at a time. WAL only removes the reader/writer fight, it does not create a second writer. The only correct fixes are architectural: one writer process, or a queue (a table, a list, a channel) that one writer drains.

Give those same five connections a real busy timeout and the failures evaporate into waiting:

```
journal=delete  busy_timeout=2    -> 50 ok,   0 'database is locked', rows=50, wall=0.73s
journal=wal     busy_timeout=2    -> 50 ok,   0 'database is locked', rows=50, wall=0.73s
```

50 writes × 10 ms of work ≈ 0.73 s wall — the writes are perfectly serialized, which is exactly what one writer means. So `busy_timeout` is not a hack when the write rate is modest; it's the admission controller for the single-writer constraint. What it is *not* is a fix for sustained write contention: past a few writers, wall time grows linearly with queue length and the honest answers are "batch commits" or "one writer".

## `synchronous`: how much crash guarantee you buy back with fsync

Durability in SQLite is governed by `PRAGMA synchronous`. FULL (2) fsyncs everything at commit; NORMAL (1) in WAL mode fsyncs only at checkpoints; OFF (0) never fsyncs and lets the OS page cache absorb orderings. Real numbers, 300 separate transactions on ext4-on-LUKS (`/tmp` is tmpfs on this box, where fsync is free — the numbers worth quoting come from `/`):

```
journal  sync       time   db bytes  wal bytes
delete   FULL     8.597s      16384          0
wal      FULL     3.767s       4096     1256632
wal      NORMAL    0.004s       4096     1256632
wal      OFF      0.004s       4096     1256632
```

Rollback+FULL pays ~28.7 ms per commit (journal delete + multiple fsyncs), WAL+FULL ~12.6 ms (one WAL-append fsync), and WAL+NORMAL rounds to **zero** — 2,000× faster than the default configuration for many-small-commits. That is why the WAL+NORMAL pair is the default recommendation for apps that die under the rollback journal. But read the guarantee carefully: with NORMAL, a power loss can roll back the most recent transactions — the file stays consistent and uncorrupted, you may just lose the last moments. That is a perfectly good trade for logs, metrics, and job queues; it is a bad one for money you've confirmed to a user.

One big transaction looks similar but tells you where the cost actually lives:

```
(a) 50,000 rows in ONE transaction
journal  sync       time   db bytes  wal bytes
delete   FULL     0.076s     884736          0
wal      FULL     0.058s       4096     898192
wal      NORMAL    0.050s       4096     898192
wal      OFF      0.049s       4096     898192
```

Batching fifty thousand rows into one transaction collapses the 100× gap to noise (0.076 s vs 0.049 s) — per-commit fsync is the tax, and batching is the exemption.

## The `-wal` file: auto-checkpoint and when it goes away

The WAL grows until something pushes it back into the database. `PRAGMA wal_autocheckpoint` defaults to 1000 pages (≈4 MB at the default 4096-byte page size): at the first commit that crosses the threshold, SQLite runs a checkpoint that copies WAL pages into the main file. Real trace, writing 1000 rows of 1 KB at a time:

```
page_size = 4096 bytes; threshold 1000 pages = 4096000 bytes
chunk 1: 1000 rows x 1KB -> wal =  1046512 bytes, db =     4096 bytes
chunk 3: 1000 rows x 1KB -> wal =  3131232 bytes, db =     4096 bytes
chunk 4: 1000 rows x 1KB -> wal =  4177712 bytes, db =  4112384 bytes   <- crossed 4096000
chunk 8: 1000 rows x 1KB -> wal =  4210672 bytes, db =  8220672 bytes
```

At chunk 4 the WAL passed the threshold and the database jumped from 4 KB to 4.1 MB — the auto-checkpoint working. Note the WAL *file* keeps its high-water size (run `PRAGMA wal_checkpoint(TRUNCATE)` to truncate it to 0, which returns `(0, 0, 0)` — busy, log, checkpointed — and works while readers come and go). A passive checkpoint needs readers to pass their snapshots; `TRUNCATE` blocks new readers briefly. If your `-wal` grows forever, check for a long-running reader pinning an old snapshot, and consider `PRAGMA journal_size_limit`.

## Why your ORM's connection pool makes it worse

Pool defaults are written for Postgres: ten, twenty, fifty connections. In SQLite every one of those connections is another candidate writer, so a pool doesn't spread the writes — it *guarantees* collisions (see 41/50 failures above). Worse, most ORMs check connections in and out per unit of work, which shuffles locks between requests. The rules I use: size for writes (1–2, or 1 for a single writer process), size larger for reads *only if* writes are rare, set an explicit timeout on every connection (some drivers default to no busy handler and fail instantly), and prefer a dedicated writer (a queue-draining process) over everyone fighting. If you use a queue table, remember `SELECT ... FOR UPDATE` doesn't exist here — claim rows with `UPDATE ... WHERE claimed = 0` inside a `BEGIN IMMEDIATE`, then commit.

## When to graduate to Postgres

Move when *any* of these is true, not when someone says SQLite doesn't scale: multiple writer processes on different hosts (SQLite locks a *file*; put it on a real shared filesystem and you've traded correctness for latency), write volume past what one serialized writer can absorb, long analytical writes that block your writer for seconds, or a need for row-level MVCC and per-row locking. The symptom that actually matters is your write queue growing faster than one writer drains it. Until then, WAL + a sane `busy_timeout` + one writer handles embarrassingly more than people expect — see [SQLite is enough](/posts/sqlite-is-enough/) for where that line is, and [SQLite FTS5](/posts/sqlite-fts5/) for one thing it does better than the server databases.

## The recipe, in order

1. `PRAGMA journal_mode=WAL` — one line, kills reader/writer blocking.
2. Set a real `busy_timeout` on every connection (2–10 s for web workers), not just Python's default 5 s you didn't know about.
3. Batch writes into few transactions; hold each transaction short.
4. Cut writer connections to one process, or funnel writes through a queue one process drains.
5. Pick `synchronous` deliberately: WAL+NORMAL as default, OFF only if losing the last transactions is acceptable.
6. Watch the `-wal` size; if it grows without bound, you have a reader pinning a snapshot or a missing checkpoint.
7. Only then, Postgres.

That's **SQLite locking** in practice: one writer by design, readers free under WAL, `database is locked` as the database telling you the truth about **SQLITE_BUSY** — and a short, ordered list of things to try before you migrate anything.
