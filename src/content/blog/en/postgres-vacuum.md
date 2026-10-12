---
title: "Postgres vacuum, table bloat, and why your table is 10× bigger than it should be"
description: "Postgres vacuum explained with real output: I generated table bloat on a throwaway Postgres 17, tuned autovacuum thresholds, watched VACUUM mark dead tuples reusable while VACUUM FULL shrank the file, and checked wraparound with pg_stat_user_tables and pgstattuple."
pubDate: 2026-12-16
lang: en
translationKey: postgres-vacuum
tags: [devops, linux]
featured: false
keywords:
  - Postgres vacuum
  - table bloat
  - autovacuum
  - VACUUM FULL
  - dead tuples
---

I stood up a throwaway Postgres 17 in a container, built a one-million-row `orders` table, and then did to it what production does to a table: churned it. Everything below is pasted from that session, not reconstructed from memory. The headline number: after enough `UPDATE`s and a bulk `DELETE`, the heap file grew to **1389 MB for 790,605 live rows** — almost exactly **10× the 139 MB those same rows occupy after `VACUUM FULL`**. The data was fine. The table was bloated. This is **Postgres vacuum** in practice: **MVCC** and **dead tuples**, what **VACUUM** and **VACUUM FULL** actually do, how **autovacuum** decides when to run, and the two things that stop it from ever catching up.

Here is the whole setup, verbatim:

```sql
docker run --rm -d --name pgvac -e POSTGRES_PASSWORD=x \
  -p 127.0.0.1:55440:5432 postgres:17
docker exec pgvac psql -U postgres -Atc 'select version();'
-- PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2) on x86_64-pc-linux-gnu, compiled by gcc 14.2.0, 64-bit
```

## Why Postgres vacuum exists: MVCC, dead tuples, and where the space goes

Postgres uses **MVCC** (multi-version concurrency control): a writer never overwrites a row in place. An `UPDATE` writes a *new* version of the row and leaves the old one on disk; a `DELETE` just marks the row dead. This is what lets a reader keep a stable snapshot without blocking a writer. The cost is that the old versions have to live somewhere until no running transaction can still see them. Those leftovers are **dead tuples**.

A dead tuple is not free. It still occupies its slot in a heap page, so a table that is updated heavily grows even though the number of live rows is flat. Eventually the old versions become visible to *no one*, and then **vacuum** may reclaim them: it marks their space reusable, and a later insert can be placed there.

There is a subtlety worth knowing before you panic at a stats counter. If an `UPDATE` does not touch any indexed column, Postgres can do a **HOT update**: the new version goes on the same page, and the old slot is marked dead with only a line pointer. Page-level pruning reclaims that space lazily, on access, without a full vacuum. The practical consequence is that `pg_stat_user_tables.n_dead_tup` (an estimate) and the physically dead bytes `pgstattuple` reports can disagree wildly — and that a heavily churned table can be mostly *free space*, not mostly dead tuples. Both are bloat.

<figure>
<svg viewBox="0 0 720 300" width="100%" role="img" aria-label="A heap file after churn holds live and dead tuples mixed together. VACUUM marks the dead space reusable but leaves the file the same size; VACUUM FULL rewrites the table into a new, compact file and returns the space to the operating system.">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <text x="24" y="20" font-weight="600" font-size="14">After churn — live and dead tuples share the heap</text>
    <text x="24" y="137" font-weight="600" font-size="14">After VACUUM — space reusable, file size unchanged</text>
    <text x="24" y="243" font-weight="600" font-size="14">After VACUUM FULL — rewritten compact</text>
  </g>
  <!-- legend -->
  <g font-family="system-ui, sans-serif" font-size="11.5" fill="currentColor">
    <rect x="470" y="8" width="22" height="12" rx="3" fill="currentColor" opacity="0.75"/>
    <text x="498" y="18">live tuple</text>
    <rect x="586" y="8" width="22" height="12" rx="3" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="614" y="18" fill="#0f766e">dead</text>
  </g>
  <!-- row 1: live + dead mixed -->
  <g>
    <rect x="30" y="28" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="114" y="28" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="150" y="44" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
    <rect x="198" y="28" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="282" y="28" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="318" y="44" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
    <rect x="366" y="28" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="402" y="44" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
    <rect x="450" y="28" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="534" y="28" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="570" y="44" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
    <rect x="618" y="28" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="30" y="56" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="66" y="72" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
    <rect x="114" y="56" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="198" y="56" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="234" y="72" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
    <rect x="282" y="56" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="318" y="72" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
    <rect x="366" y="56" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="450" y="56" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="486" y="72" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
    <rect x="534" y="56" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="618" y="56" width="72" height="22" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="654" y="72" fill="#0f766e" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">×</text>
  </g>
  <!-- arrow 1 -->
  <line x1="360" y1="88" x2="360" y2="112" stroke="currentColor" stroke-width="1.5"/>
  <polygon points="360,118 355,108 365,108" fill="currentColor"/>
  <text x="372" y="106" font-family="system-ui, sans-serif" font-size="12" fill="currentColor">VACUUM — marks dead space reusable, does not rewrite</text>
  <!-- row 2: dead -> free -->
  <g>
    <rect x="30" y="156" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="114" y="156" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
    <rect x="198" y="156" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="282" y="156" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
    <rect x="366" y="156" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
    <rect x="450" y="156" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="534" y="156" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
    <rect x="618" y="156" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="30" y="184" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
    <rect x="114" y="184" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="198" y="184" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
    <rect x="282" y="184" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
    <rect x="366" y="184" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="450" y="184" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
    <rect x="534" y="184" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="618" y="184" width="72" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  </g>
  <text x="24" y="226" font-family="system-ui, sans-serif" font-size="11.5" fill="#0f766e">1389 MB still on disk — 89.7% of it is free space now</text>
  <!-- arrow 2 -->
  <line x1="360" y1="236" x2="360" y2="258" stroke="currentColor" stroke-width="1.5"/>
  <polygon points="360,264 355,254 365,254" fill="currentColor"/>
  <text x="372" y="252" font-family="system-ui, sans-serif" font-size="12" fill="currentColor">VACUUM FULL — rewrite, return space to the OS</text>
  <!-- row 3: packed -->
  <g>
    <rect x="30" y="270" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="114" y="270" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="198" y="270" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="282" y="270" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
    <rect x="366" y="270" width="72" height="22" rx="4" fill="currentColor" opacity="0.75"/>
  </g>
  <text x="450" y="285" font-family="system-ui, sans-serif" font-size="11.5" fill="#0f766e">139 MB</text>
</svg>
<figcaption>MVCC keeps old row versions as dead tuples. VACUUM marks that space reusable in place, so the file usually stays the same size — 89.7% of mine was free space. VACUUM FULL rewrites the whole table into a new file, which is the only one of the two that actually returns disk to the operating system.</figcaption>
</figure>

## VACUUM vs VACUUM FULL: mark reusable vs rewrite

**`VACUUM`** scans the table, finds dead tuples that no transaction can see anymore, and marks their space reusable for future rows. It also updates the visibility map (which makes index-only scans cheaper), removes dead index entries, and truncates *trailing* pages that are now entirely empty — but only the ones at the end of the file. It takes a `ShareUpdateExclusive` lock, which does not block normal reads or writes. This is the vacuum that autovacuum runs, and it is the one you should be running constantly.

**`VACUUM FULL`** does something different: it rewrites the entire table into a brand-new file, copying only live rows, then swaps the files and drops the old one. That is the only way to hand disk back to the operating system. The price is an `ACCESS EXCLUSIVE` lock that blocks *every* reader and writer for the whole rewrite, plus enough free disk to hold a second copy of the table.

Here is what a real churn did to my table. First, fresh and clean — 1M rows, 174 MB:

```sql
INSERT INTO orders SELECT g, g%10000,
       (ARRAY['pending','paid','shipped','refunded'])[1 + g%4],
       (g%1000)::numeric/10, repeat('x', 120)
FROM generate_series(1, 1000000) g;
VACUUM ANALYZE orders;

--  total  |  heap
-- 195 MB  | 174 MB     → ~174 bytes per row, no bloat
```

Then I turned autovacuum off for this table so the bloat would accumulate predictably, and churned it with repeated full-table `UPDATE`s plus a bulk `DELETE`:

```sql
ALTER TABLE orders SET (autovacuum_enabled = false);
UPDATE orders SET total = total + 1;   -- run repeatedly
DELETE FROM orders WHERE customer_id % 5 = 0;

SELECT relname, n_live_tup, n_dead_tup,
       pg_size_pretty(pg_relation_size(relid)) AS heap
FROM pg_stat_user_tables WHERE relname = 'orders';

--  relname | n_live_tup | n_dead_tup |  heap
--  orders  |     790605 |    7199682 | 1389 MB
```

7.2 million estimated dead tuples, and a heap ten times what 800k rows need. `pgstattuple` shows where the space actually sits — note the huge free-space figure, the HOT-space I mentioned earlier:

```sql
CREATE EXTENSION IF NOT EXISTS pgstattuple;
SELECT table_len, tuple_count, dead_tuple_count,
       pg_size_pretty(dead_tuple_len) AS dead_bytes,
       pg_size_pretty(free_space)     AS free_bytes, free_percent
FROM pgstattuple('orders');

--  table_len | tuple_count | dead_tuple_count | dead_bytes | free_bytes | free_percent
--  1389 MB   |      800000 |           800072 |     133 MB |    1085 MB |        78.12
```

Now the plain `VACUUM`. Watch two lines: it removes the dead tuples, and it removes exactly zero pages:

```sql
VACUUM (VERBOSE) orders;

-- INFO:  finished vacuuming "postgres.public.orders": index scans: 1
-- pages: 0 removed, 177769 remain, 177769 scanned (100.00% of total)
-- tuples: 800072 removed, 800000 remain, 0 are dead but not yet removable
-- index scan needed: 159992 pages ... had 7199511 dead item identifiers removed

SELECT pg_size_pretty(pg_relation_size('orders')) AS heap_after_plain_vacuum;
--  1389 MB
```

That is the whole point of this section, in one number. `VACUUM` reclaimed **7,199,511 dead index entries and 800,072 dead tuples**, and the file was **still exactly 1389 MB**, now with `free_percent = 89.73`. It made the space reusable; it did not shrink the table. Only `VACUUM FULL` did:

```sql
VACUUM FULL orders;   -- Time: 7617.521 ms (00:07.618)

SELECT pg_size_pretty(pg_relation_size('orders'))      AS heap,
       pg_size_pretty(pg_total_relation_size('orders')) AS total;
--  heap    | total
--  139 MB  | 156 MB
```

Seven seconds of exclusive lock turned 1389 MB into 139 MB. That is why `VACUUM FULL` is a maintenance-window tool, not a fix you schedule hourly. (If you want to understand why the *plans* over a table like this go wrong, that is a different topic — see [Postgres EXPLAIN](/posts/postgres-explain/).)

## Autovacuum: thresholds, factors, and how to tune for a small, DB-heavy box

Autovacuum is a set of background workers that decide, per table, "have enough rows died since last time to make this worth it?" The decision is a threshold plus a fraction of the table:

```
vacuum when dead_tuples > autovacuum_vacuum_threshold
                       + autovacuum_vacuum_scale_factor × n_live_tup
```

The defaults shipping in Postgres 17 look harmless until you do the arithmetic on a big table:

```sql
SHOW autovacuum_naptime;                 -- 1min
SHOW autovacuum_vacuum_threshold;        -- 50
SHOW autovacuum_vacuum_scale_factor;     -- 0.2
SHOW autovacuum_vacuum_insert_threshold; -- 1000
SHOW autovacuum_vacuum_insert_scale_factor; -- 0.2
SHOW autovacuum_max_workers;             -- 3
```

A `scale_factor` of `0.2` means autovacuum waits until **20% of the table is dead** before it looks. On a 100M-row table that is 20M dead rows before cleanup even starts — which is exactly how tables get 10× bigger than they should be. To watch it fire for real, I made a 200k-row `events` table, updated every row three times, and computed its own threshold:

```sql
SELECT relname, n_live_tup, n_dead_tup,
       current_setting('autovacuum_vacuum_threshold')::int
         + (current_setting('autovacuum_vacuum_scale_factor')::numeric
            * n_live_tup)::int AS dead_threshold
FROM pg_stat_user_tables WHERE relname = 'events';

--  relname | n_live_tup | n_dead_tup | dead_threshold
--  events  |     321088 |     400000 |          64268
```

400,000 dead tuples against a 64,268 threshold: comfortably over, and the worker ran. Seconds later:

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, autovacuum_count
FROM pg_stat_user_tables WHERE relname = 'events';

--  relname | n_live_tup | n_dead_tup |        last_autovacuum        | autovacuum_count
--  events  |     300000 |          0 | 2026-10-12 09:51:52.698117+00 |                3
```

For a **small, DB-heavy workload** — one busy database on one box — the defaults tuned for giant fleets are usually wrong. Drop the scale factor and set realistic thresholds per table, so vacuum runs in small, frequent slices instead of one giant pass:

```sql
ALTER TABLE orders SET (
  autovacuum_vacuum_scale_factor = 0.02,   -- act when 2% is dead, not 20%
  autovacuum_vacuum_threshold    = 1000,
  autovacuum_vacuum_cost_limit   = 1000    -- let the worker do more before sleeping
);

SELECT relname, reloptions FROM pg_class WHERE relname = 'orders';
--  orders | {autovacuum_vacuum_scale_factor=0.02,autovacuum_vacuum_threshold=1000,autovacuum_vacuum_cost_limit=1000}
```

The rules of thumb: on a small box, lower `autovacuum_vacuum_scale_factor` to `0.01–0.05` on your hot tables; raise `autovacuum_vacuum_cost_limit` (and/or lower `autovacuum_vacuum_cost_delay`) so the worker actually finishes; and raise `autovacuum_max_workers` if you have many busy tables and they are queuing behind each other.

## Monitoring table bloat: pg_stat_user_tables, pgstattuple, and the size query

You do not need a monitoring stack to see bloat; you need one query and a ratio you remember. The per-row number is the tell:

```sql
SELECT relname,
       pg_size_pretty(pg_relation_size(relid)) AS size,
       n_live_tup,
       pg_size_pretty((pg_relation_size(relid) / greatest(n_live_tup,1))::bigint)
         AS bytes_per_live_row
FROM pg_stat_user_tables
ORDER BY pg_relation_size(relid) DESC LIMIT 5;

--  relname |  size   | n_live_tup | bytes_per_live_row
--  orders  | 1389 MB |     790605 | 1841 bytes
--  events  |  195 MB |     300000 |  682 bytes
--  ledger  |   14 MB |      50000 |  298 bytes
```

1841 bytes per live row against the 174 bytes the same rows need fresh is your 10×, in one column. `pg_stat_user_tables` gives you `n_live_tup`, `n_dead_tup`, `last_autovacuum` and `autovacuum_count`; treat the tuple counters as estimates, not gospel. When you want the physical truth, `pgstattuple` scans the relation and reports `dead_tuple_len` and `free_space` exactly (as in the JSON above). For a long-running vacuum, `pg_stat_progress_vacuum` shows it moving:

```sql
SELECT phase, heap_blks_scanned AS scanned, heap_blks_total AS total,
       num_dead_item_ids AS dead_ids, indexes_processed || '/' || indexes_total AS indexes
FROM pg_stat_progress_vacuum;

--     phase     | scanned | total | dead_ids | indexes
--  scanning heap |      28 | 53334 |     1260 | 0/0
--  scanning heap |     353 | 53334 |    15885 | 0/0
--  scanning heap |     658 | 53334 |    29610 | 0/0
```

## Transaction ID wraparound: the failure that must never happen

Every transaction gets a 32-bit ID, and there are only ~4 billion of them. Postgres compares IDs with modular arithmetic, so if a database ever lets its ID counter wrap all the way around, old rows look like they are *from the future* and the server refuses to start rather than corrupt data. The hard limit is 2³¹ ≈ 2.1 billion transactions. The safety valve is **freezing**: vacuum marks old rows as permanently visible, which is what lets the ID counter advance safely.

That is why `age(datfrozenxid)` is a number you watch like a fuel gauge. On my fresh cluster it was tiny, but the query is the one to keep:

```sql
SELECT datname,
       age(datfrozenxid) AS xid_age,
       current_setting('autovacuum_freeze_max_age')::bigint AS freeze_max_age,
       2147483648 - age(datfrozenxid) AS xids_until_wraparound
FROM pg_database WHERE datname = 'postgres';

--  datname  | xid_age | freeze_max_age | xids_until_wraparound
--  postgres |      39 |      200000000 |            2147483589
```

`autovacuum_freeze_max_age` (default 200,000,000) is the point at which Postgres forces a vacuum to freeze rows even if bloat is low, and that vacuum **cannot be cancelled** by ordinary means. If `age(datfrozenxid)` is climbing toward 200M, you have a table not getting vacuumed at all. Delay is the danger: on a busy system the margin between "fine" and "not accepting commands to avoid wraparound data loss" can shrink fast.

## Long-running transactions block vacuum

This is the piece people miss. Vacuum can only reclaim a dead tuple once **no live snapshot can still see it**. A single transaction that stays open — an idle-in-transaction session, a forgotten `BEGIN`, a long analytics query — pins the oldest snapshot, and vacuum must leave everything newer than it in place. I opened one `REPEATABLE READ` transaction, then, from another session, deleted half a table and vacuumed it:

```sql
-- session A (kept open)
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM ledger;
SELECT pg_sleep(45); COMMIT;

-- session B
SELECT pid, state, now() - xact_start AS xact_age
FROM pg_stat_activity
WHERE datname = 'postgres' AND xact_start IS NOT NULL AND pid <> pg_backend_pid();
--  pid | state  |    xact_age     | query
--  206 | active | 00:00:03.121582 | BEGIN ISOLATION LEVEL REPEATABLE READ; ...

DELETE FROM ledger WHERE id % 2 = 0;   -- DELETE 50000
VACUUM (VERBOSE) ledger;

-- INFO:  finished vacuuming "postgres.public.ledger": index scans: 0
-- pages: 0 removed, 1819 remain, 1819 scanned (100.00% of total)
-- tuples: 0 removed, 100000 remain, 50000 are dead but not yet removable
```

`50000 are dead but not yet removable` — vacuum did nothing, because session A's snapshot could still see those rows. The bloat piled up and would keep piling up until that transaction ended. The fix is not a vacuum setting; it is `idle_in_transaction_session_timeout` and discipline about not holding transactions open. Locks and long transactions tend to arrive together, which is why this pairs with [Postgres locks](/posts/postgres-locks/).

## A practical Postgres vacuum checklist

- **Know your baseline.** Run the bytes-per-live-row query on your biggest tables; anything above ~2–3× the fresh row width is bloat worth investigating.
- **Check the clock, not just the count.** `last_autovacuum` should be recent on tables that change daily. A blank or stale timestamp on a busy table is the real alarm.
- **Tune per table, for a small box.** `autovacuum_vacuum_scale_factor = 0.02`, a raised `autovacuum_vacuum_cost_limit`, and enough `autovacuum_max_workers` beat any global default.
- **Find the blockers before tuning.** Query for long-lived `xact_start` values; a forgotten open transaction defeats every threshold. Set `idle_in_transaction_session_timeout`.
- **Watch wraparound headroom.** Track `age(datfrozenxid)` and treat a steady climb toward `autovacuum_freeze_max_age` as urgent.
- **Use `VACUUM FULL` surgically.** It takes an `ACCESS EXCLUSIVE` lock and needs disk for a second copy — so run it in a window, on the one table that earned it, and prefer `pg_repack` if you cannot afford the lock.
- **Let plain `VACUUM` do the daily work.** It is the only form you can run constantly, and on a well-tuned autovacuum you rarely need anything else.

None of this is exotic; it is the ordinary cost of MVCC. But it is easy to forget, because nothing breaks until a table is ten times its natural size or a transaction ID counter runs out of room. Measure, tune the thresholds down, kill the long transactions, and `VACUUM` will quietly keep your tables honest.
