---
title: "SQLite VACUUM, integrity_check, and a database file that won't shrink"
description: "A SQLite file that grows and never shrinks is the freelist. See real before/after numbers for page_count, freelist_count, VACUUM, auto_vacuum, incremental_vacuum, VACUUM INTO, and integrity_check vs quick_check."
pubDate: 2027-01-20
lang: en
translationKey: sqlite-vacuum-and-integrity
tags: [devops, python]
featured: false
keywords:
  - SQLite VACUUM
  - PRAGMA integrity_check
  - auto_vacuum
  - database file size
  - freelist
---

You deleted 99% of the rows and your SQLite file did not get smaller. The database is 58 MB on disk, the app barely uses it, and every `ls -lh` says the same thing. This is not a bug and it is not a leak — it is the freelist, and it is the single most common surprise in SQLite maintenance. I hit it on a log table once, spent an afternoon convinced the driver was caching, and now I measure it before I say a word. The whole topic is one idea: **SQLite VACUUM** returns space, the freelist is why the **database file size** stays put, and `PRAGMA integrity_check` tells you whether the file is still lying. Let me build a real database, break it, and shrink it — with the actual numbers.

Everything below is reproducible with `sqlite3` and nothing else. No sudo, no network, no `ollama`.

## Why a SQLite file grows and never shrinks (the freelist)

SQLite stores everything in fixed-size **pages** — 4096 bytes by default. A table is a b-tree of pages. When you `DELETE` rows, SQLite does not hand those pages back to the filesystem. It unlinks them from the table's b-tree and threads them onto an internal free list — the **freelist** — so the *next* insert can reuse them instead of growing the file. That is deliberate and usually correct: a churning table would otherwise resize its file a thousand times a day. The cost is that `DELETE` shrinks your logical database, not your file. The pages still count toward the file; they are just marked free.

I'll prove it. Build a 200k-row table, then keep 2,000 rows:

```bash
$ sqlite3 events.db "CREATE TABLE events(id INTEGER PRIMARY KEY, ts TEXT, kind TEXT, payload TEXT);"
$ sqlite3 events.db "WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM c WHERE x<200000)
  INSERT INTO events(ts,kind,payload)
  SELECT datetime('now','-'||x||' seconds'),'event-'||(x%7),
         substr(hex(randomblob(120)),1,240) FROM c;"

$ ls -l events.db
-rw-r--r-- 1 root root 58671104 events.db      # 56 MiB, 200k rows
```

Fifty-six mebibytes, `page_size` 4096, `page_count` 14324, `freelist_count` 0. Now delete almost everything:

```bash
$ sqlite3 events.db "DELETE FROM events WHERE id>2000;"
$ sqlite3 events.db "SELECT count(*) FROM events;"
2000

$ sqlite3 events.db "PRAGMA page_size; PRAGMA page_count; PRAGMA freelist_count;"
4096
14324
14179
$ ls -l events.db
-rw-r--r-- 1 root root 58671104 events.db      # unchanged
```

One percent of the rows survived and the file is byte-for-byte identical: still `page_count` 14324, still 58,671,104 bytes. The 198,000 deleted rows did not vanish — their 14,179 pages slid onto the freelist. Live data is `14324 - 14179 = 145` pages, about 593,920 bytes. The rest is free space the OS still sees as file.

<figure>
<svg viewBox="0 0 720 168" width="720" height="168" role="img" aria-label="Before VACUUM most pages are freelist; after VACUUM the file is truncated to live pages" xmlns="http://www.w3.org/2000/svg">
  <text x="0" y="14" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">before delete → after delete → after VACUUM</text>
  <!-- before/after delete: same 14,324-page file; 145 used, 14,179 on the freelist -->
  <rect x="0" y="28" width="6" height="26" fill="currentColor"/>
  <rect x="6" y="28" width="439" height="26" fill="currentColor" opacity="0.18"/>
  <rect x="0" y="34" width="445" height="2" fill="currentColor" opacity="0.4"/>
  <text x="0" y="72" font-family="ui-monospace,monospace" font-size="11" fill="currentColor" opacity="0.75">14,324 pages · 145 used · 14,179 freelist · file stays 58,671,104 B</text>
  <!-- after VACUUM: truncated to just the live pages -->
  <rect x="0" y="92" width="6" height="26" fill="currentColor"/>
  <path d="M12 92 l-10 -8 M12 92 l-10 8 M14 118 l-10 -8 M14 118 l-10 8" stroke="currentColor" stroke-width="1.5" fill="none"/>
  <text x="0" y="136" font-family="ui-monospace,monospace" font-size="11" fill="currentColor" opacity="0.75">145 pages · freelist_count 0 · file truncated to 593,920 B</text>
  <text x="470" y="140" font-family="ui-monospace,monospace" font-size="11" fill="currentColor" opacity="0.55">= VACUUM rewrites + truncates</text>
</svg>
<figcaption>Deleting rows moves pages onto the freelist; the file does not change. VACUUM rewrites the live pages and truncates the file back to what is actually used.</figcaption>
</figure>

`dbstat` confirms which b-tree holds the space. Aggregate mode shows the whole table:

```sql
sqlite> SELECT name, pageno, ncell, payload FROM dbstat WHERE aggregate=1 AND name='events';
events|144|2142|544000
```

The `events` table now occupies 144 pages. The other 13,682 are freelist. This is the number that explains the mystery: `page_count * page_size` (the file size) minus `freelist_count * page_size` (the free space) is what you actually use.

## Reading the bloat: page_count × page_size vs freelist_count

**Database file size** is the OS-level byte count; it never lies but never self-corrects either. The freelist is the invisible middle. To read true bloat, combine them:

```sql
-- how much of the file is dead?
sqlite> SELECT
  page_count AS total_pages,
  page_count - freelist_count AS live_pages,
  freelist_count AS free_pages,
  ROUND(100.0*freelist_count/page_count,1) AS pct_free
FROM pragma_page_count(), pragma_freelist_count();
total_pages|live_pages|free_pages|pct_free
14324|145|14179|99.0
```

Ninety-nine percent free. That is my action threshold, give or take: if `pct_free` is single digits, do nothing; if it's 50% or more and the file is more than a few MB, it is worth thinking about. `PRAGMA page_size` tells you the multiplier — `14179 * 4096 ≈ 56 MiB` of reclaimable space sitting in a file that `du` still charges you for.

## SQLite VACUUM: the rewrite that actually returns the space

**SQLite VACUUM** is a full rebuild. It copies every live page into a fresh, compact database — no freelist, no gaps, defragmented — then swaps it into place and truncates the file. Same result:

```bash
$ sqlite3 events.db "PRAGMA page_count; PRAGMA freelist_count;" ; ls -l events.db
14324
14179
-rw-r--r-- 1 root root 58671104 events.db

$ sqlite3 events.db "VACUUM;"

$ sqlite3 events.db "PRAGMA page_count; PRAGMA freelist_count;" ; ls -l events.db
145
0
-rw-r--r-- 1 root root 593920 events.db
```

58,671,104 bytes → 593,920 bytes. A 99% reduction, `freelist_count` to 0, all 2,000 rows intact. That is VACUUM working as designed. Two costs hide in the word "rewrite". Disk: VACUUM builds the compacted database in a temporary file, so peak usage is roughly the current file size on the same filesystem. The lock: it is a write transaction over the whole database and needs exclusive access, so it blocks — or fails with `database is locked` — when a long reader or writer is active, and on a big file it can run for minutes. That is why I never VACUUM casually (below).

One more real behaviour: VACUUM is also the *only* way to change a couple of persisted settings. `PRAGMA page_size` and `PRAGMA auto_vacuum` only take effect after a VACUUM, and it must be in the same connection that set them:

```bash
$ sqlite3 events.db "PRAGMA page_size=8192; PRAGMA page_size; VACUUM; PRAGMA page_size; PRAGMA page_count;"
4096      # setting is pending, file is still 4096
4096      # ...still pending
8192      # only now, after VACUUM
71
```

## auto_vacuum = FULL vs INCREMENTAL, and PRAGMA incremental_vacuum

If you'd rather not schedule VACUUMs, `PRAGMA auto_vacuum` moves free pages back automatically. It must be set before the database has content (or changed by a VACUUM), because it rewrites every page to track a **pointer map**. There are two modes on top of `NONE`:

- **FULL (1):** as soon as a transaction commits and leaves free pages at the end of the file, SQLite truncates the file. Automatic, always-compact, and slightly slower on every commit.
- **INCREMENTAL (2):** free pages go on the freelist but the file is *not* truncated automatically. You reclaim on your own schedule with `PRAGMA incremental_vacuum`.

Same 200k-then-delete dance on three databases, `auto_vacuum` set at creation:

```bash
# after inserting 200k rows and deleting 198k, file size per mode:
auto_vacuum=NONE   -> 58671104 bytes   (freelist keeps the space)
auto_vacuum=FULL   -> 598016  bytes    (file auto-truncated on commit)
auto_vacuum=INCREMENTAL -> 58744832 bytes   (not truncated; slightly *larger* than NONE — the pointer-map pages)
```

`INCREMENTAL` looks like it did nothing, and that is the honest part: it does not truncate for you. You decide when:

```bash
# bring the INCREMENTAL db back down to size:
$ sqlite3 av.db "PRAGMA freelist_count; PRAGMA page_count;" ; ls -l av.db
14179
14342
-rw-r--r-- 1 root root 58744832 av.db

$ sqlite3 av.db "PRAGMA incremental_vacuum;"

$ sqlite3 av.db "PRAGMA freelist_count; PRAGMA page_count;" ; ls -l av.db
0
146
-rw-r--r-- 1 root root 598016 av.db
```

`PRAGMA incremental_vacuum` reclaimed 58.7 MB → 0.57 MB, dropping `freelist_count` to 0. So the trade is real: `FULL` autovacuum shrinks for you but pays per commit and stores a pointer map that adds pages (my one-row test file grew from a few hundred bytes to 12,288 bytes the moment I turned it on). `INCREMENTAL` keeps writes cheap and lets you batch the reclaim into one `incremental_vacuum` call at a quiet moment — my usual pick for write-heavy log tables. `NONE` is the default and the right choice for most databases; you just accept the occasional manual VACUUM. This is the same "one writer" world I covered in [SQLite concurrency](/posts/sqlite-concurrency/) — these pragmas all sit on the same write lock.

## VACUUM INTO: a consistent online copy

`VACUUM INTO 'file.db'` is VACUUM's cousin with a different job: it writes a freshly compacted copy *to a new file* and leaves the database itself untouched. Because it produces a compact, self-contained image, it's an excellent online backup — you get a consistent snapshot even while readers are active, in WAL mode, mid-write:

```bash
$ rm -f backup.db
$ sqlite3 events.db "VACUUM INTO 'backup.db';"
$ sqlite3 backup.db "SELECT count(*) FROM events;"
2000
$ sqlite3 backup.db "PRAGMA integrity_check;"
ok
```

The source is unchanged, the copy is compact and defragmented, and the row count matches. I tried it on a WAL database with a connection mid-transaction and the copy still verified `ok` — VACUUM INTO reads a stable snapshot, so unlike a raw `cp` of the file (which can catch a half-written WAL), it is safe to run live. For scheduled backups it is the one-liner I reach for, a good complement to the backup-API and `.backup` approach in [SQLite is enough](/posts/sqlite-is-enough/).

## PRAGMA integrity_check vs quick_check: what a corrupt page looks like

`quick_check` and `integrity_check` scan the file for damage. `integrity_check` is the thorough one: it walks every b-tree, verifies cell structure, checks that index entries point back to real table rows, and re-validates NOT NULL and UNIQUE constraints against a temporary index. `quick_check` runs the same structural walk but skips the expensive index-vs-table and constraint cross-checks — so it's much cheaper and usually plenty for a routine "is this file obviously broken?" probe. On my good, freshly vacuumed database both are clean:

```sql
sqlite> PRAGMA quick_check;
ok
sqlite> PRAGMA integrity_check;
ok
```

Now I corrupt a *copy* with `dd` — 200 bytes of garbage written straight into a data page — and re-check it. Page size is 4096, so offset 40960 lands inside the table b-tree:

```bash
$ cp events.db corrupt.db
$ printf 'GARBAGEGARBAGEGARBAGEGARBAGE' | dd of=corrupt.db bs=1 seek=40960 count=200 conv=notrunc status=none
$ sqlite3 corrupt.db "PRAGMA quick_check;"
Error: database disk image is malformed
*** in database main ***
Tree 2 page 11: btreeInitPage() returns error code 11
```

`btreeInitPage() returns error code 11` is SQLite reading a page header and failing to make sense of it — the page's cell-pointer array or header bytes no longer describe a valid b-tree page. `PRAGMA integrity_check` reports the same malformed error here, because this is structural damage that even the cheap check catches. The scope lesson: a byte-flip in a page *header* or *cell-pointer array* trips both; subtler damage — an index that disagrees with its table, or a NOT NULL row — is what `integrity_check` catches and `quick_check` may wave through. Run `integrity_check` when you restore a backup or weekly on an important file; run `quick_check` for a cheap periodic pulse. If integrity_check fails and you have no backup, `.recover` can sometimes pull rows from a dying file — see the [SQLite CLI cookbook](/posts/sqlite-cli-cookbook/).

## PRAGMA optimize: keep the query planner honest

There's one more pragma that belongs in maintenance, and it is not about space. The query planner uses stats in `sqlite_stat1` to pick indexes, and those stats go stale after big changes — then plans regress and nobody knows why. `PRAGMA optimize` is the cheap, scheduled fix: it runs `ANALYZE` only on tables that changed enough to matter, and it's designed to be nearly free when nothing moved. On my small databases it correctly decided to do nothing. Force the underlying work and you see the effect:

```sql
sqlite> EXPLAIN QUERY PLAN SELECT * FROM orders WHERE cust=42;
QUERY PLAN
`--SCAN orders
sqlite> ANALYZE;                -- what PRAGMA optimize selectively triggers
sqlite> SELECT tbl, idx, stat FROM sqlite_stat1;
orders|idx_orders_cust|30000 30
sqlite> EXPLAIN QUERY PLAN SELECT * FROM orders WHERE cust=42;
QUERY PLAN
`--SEARCH orders USING INDEX idx_orders_cust (cust=?)
```

A table scan became an index seek once the planner had row counts. If you restore a backup or bulk-load data, run `PRAGMA optimize;` right after — it is cheap and only touches tables that changed.

## Honest operational advice: don't VACUUM casually

Here is the part that keeps you out of trouble, learned the way I learn things — by making a file expensive to touch once.

1. **VACUUM is not free.** It rewrites the whole database, holds the write lock, and needs roughly the file's size in temporary disk. On a multi-gigabyte database it is a planned maintenance window, not a query. On small databases (the ones almost everything runs on) it's a millisecond operation and totally fine.
2. **Don't schedule a blind VACUUM on a huge, append-heavy table.** An events or audit table grows forever; a nightly VACUUM of it is a nightly full rewrite that barely helps. Fix a one-time bloated file with a single VACUUM, or use `auto_vacuum=INCREMENTAL` with periodic `incremental_vacuum`, and archive or partition the cold rows instead. Reclaiming free space does nothing if you never stop growing.
3. **Decide auto_vacuum at creation.** `NONE` for the common case, `INCREMENTAL` for churn-heavy files, `FULL` only if you truly want always-compact and can pay per commit. Changing it later means a one-time VACUUM that also adds pointer-map pages — know it makes the file a little bigger before it makes it smaller.
4. **Back up with VACUUM INTO, verify with integrity_check.** `VACUUM INTO 'backup.db'` gives you a compact, consistent online snapshot; `PRAGMA integrity_check` on the copy tells you it's real before you need it. A backup you never integrity-checked is a hope, not a backup.
5. **Watch the embarrassing metric.** `freelist_count / page_count` over 50% on a file bigger than a few MB is your signal. Below that, leave it alone.

The whole story is one equation: **database file size** is `page_count * page_size`, the **freelist** is the free space SQLite reuses instead of returning, and **SQLite VACUUM** — or `incremental_vacuum`, or `auto_vacuum=FULL` — is how you turn that free space back into a smaller file. It's unglamorous, it's what a real engineer checks before panicking, and it's the difference between "the file won't shrink" and knowing exactly why.
