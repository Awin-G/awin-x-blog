---
title: "Postgres backup, honestly: pg_dump vs pg_basebackup, snapshots, and WAL archiving"
description: "Why copying a live Postgres data directory fails, and how to choose among pg_dump, volume snapshots, and WAL archiving. Concrete commands, restore drills with pg_restore and pg_ctl recovery, the gotchas, and a recommendation for a small self-hosted database."
pubDate: 2026-11-15
lang: en
translationKey: postgres-backups
tags: [devops, self-hosting, linux]
featured: false
keywords:
  - Postgres backup
  - pg_dump vs pg_basebackup
  - point-in-time recovery
  - WAL archiving
  - restore drill
---

A working **Postgres backup** is not a copy of the data directory. It is a copy you
have restored, started, and queried. I have unpacked a `tar` of a running cluster
into a database that would not start — so this is the honest version of what each
method actually gives you, and where **point-in-time recovery** fits once your data
is worth the extra machinery.

Postgres offers three families of backup, and they are tools for three different
problems. A logical dump (`pg_dump`) is portable and surgical. A snapshot is fast
and whole. Continuous **WAL archiving** (built on `pg_basebackup`) is what lets you
recover to 14:01 when you dropped the table at 14:02. Pick by what you need to get
back, not by what is trending.

## Why copying a running Postgres data directory is unsafe

The data directory is not the database in the sense you want. It is a cache of 8 KB
pages plus a write-ahead log, and Postgres rewrites it while it runs. A `tar` or
`cp -r $PGDATA` of a live cluster reads files mid-change, and no transaction spans
"all files" — the copy is torn by construction: a half-written page that fails its
checksum, a `pg_control` pointing at a checkpoint whose WAL segments were not
copied. The copy exits 0, the archive is the right size, and `pg_ctl start` either
refuses to open the cluster or opens it into silent corruption.

Two honest ways out: dump it to something consistent, or snapshot the filesystem as
one atomic moment. A plain copy is never one of them.

## Logical dumps: `pg_dump` and `pg_dumpall`

`pg_dump` reads the database through a single MVCC snapshot, so the dump is a
consistent view of one moment even while writers keep going. It emits SQL (plain),
or a compressed custom/tar format that `pg_restore` can restore selectively and in
parallel.

```bash
# Custom format: compressed, restorable object-by-object — my default
pg_dump --format=custom --compress=9 --file=/srv/backup/app.dump appdb

# Directory format, parallel across tables — the fastest logical dump
pg_dump --format=directory --jobs=4 --file=/srv/backup/appdir appdb

# Roles, tablespaces and other cluster objects pg_dump does NOT include
pg_dumpall --roles-only --file=/srv/backup/globals.sql
```

The one thing to internalize: `pg_dump` backs up **one database** and none of the
roles that own it. Restore it onto a fresh cluster and you fail on
`role "app_user" does not exist` until `pg_dumpall --roles-only` has run first — a
surprising share of "the backup was fine but the restore failed".

Logical dumps are portable — any version forward, any host, any provider — and
cheap to keep many of. The cost is time: `pg_dump` re-serializes every row and
`pg_restore` rebuilds every index, so both scale with database size.

## Filesystem and volume snapshots

LVM, ZFS, btrfs, and cloud volume snapshots capture the block device at one instant
without reading row by row, so they take seconds regardless of size. That speed is
why they are tempting, and why they are easy to misuse.

A snapshot of a running cluster is *crash-consistent*: equivalent to pulling the
power at that moment. That is not automatically broken — Postgres is built to
crash-recover from WAL — but it is only consistent if **all of `$PGDATA` is on the
same volume, including `pg_wal/`**. Split `pg_wal` onto a separate disk and the
snapshot holds a data directory whose needed WAL lives on a volume you did not
capture.

Snapshots make a fine fast local layer and upgrade rollback: snapshot, run the
migration, and if it eats your schema you are one `zfs rollback` away. They are a
poor *only* backup: often not exportable, tied to one provider, and exactly as
deletable as the live data by anyone holding the hypervisor or API key.

## `pg_dump` vs `pg_basebackup`: which one you actually want

<figure>
<svg viewBox="0 0 660 300" width="100%" role="img" aria-label="Decision diagram: for a portable single database use pg_dump; for a fast whole-cluster copy use pg_basebackup or a snapshot; for point-in-time recovery use WAL archiving on top of a base backup.">
  <g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.55">
    <rect x="230" y="10" width="200" height="46" rx="8"/>
    <path d="M330 56 V 100 H 115 V 150"/>
    <path d="M330 56 V 150"/>
    <path d="M330 56 V 100 H 545 V 150"/>
  </g>
  <rect x="20" y="150" width="190" height="120" rx="8" fill="none" stroke="#0f766e" stroke-width="2"/>
  <rect x="235" y="150" width="190" height="120" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.55"/>
  <rect x="450" y="150" width="190" height="120" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.55"/>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="14">
    <text x="330" y="38" text-anchor="middle">What do you need back?</text>
    <text x="115" y="180" text-anchor="middle" font-weight="600" fill="#0f766e">Portable &amp; surgical</text>
    <text x="115" y="204" text-anchor="middle" font-family="ui-monospace, monospace" font-size="13">pg_dump / pg_dumpall</text>
    <text x="115" y="230" text-anchor="middle" font-size="12" opacity="0.8">one DB, any version</text>
    <text x="115" y="250" text-anchor="middle" font-size="12" opacity="0.8">the small-DB default</text>
    <text x="330" y="180" text-anchor="middle" font-weight="600">Fast &amp; whole</text>
    <text x="330" y="204" text-anchor="middle" font-family="ui-monospace, monospace" font-size="13">pg_basebackup / snapshot</text>
    <text x="330" y="230" text-anchor="middle" font-size="12" opacity="0.8">the cluster, seconds</text>
    <text x="330" y="250" text-anchor="middle" font-size="12" opacity="0.8">same major version</text>
    <text x="545" y="180" text-anchor="middle" font-weight="600">Point-in-time</text>
    <text x="545" y="204" text-anchor="middle" font-family="ui-monospace, monospace" font-size="13">WAL archiving + base</text>
    <text x="545" y="230" text-anchor="middle" font-size="12" opacity="0.8">recover to any moment</text>
    <text x="545" y="250" text-anchor="middle" font-size="12" opacity="0.8">seconds of RPO</text>
  </g>
</svg>
<figcaption>Three methods, three jobs. A small self-hosted database should start in the accent box — a logical dump you have actually restored — and only add the third when losing a day of writes would genuinely hurt.</figcaption>
</figure>

`pg_basebackup` is the physical counterpart to `pg_dump`. Instead of SQL, it copies
the cluster's files over the replication protocol, streaming a consistent base
backup plus the WAL needed to make it recoverable.

```bash
# Consistent physical base backup, WAL streamed alongside (-X stream)
pg_basebackup --pgdata=/srv/backup/base --format=tar --wal-method=stream --checkpoint=fast

# Or plain format (a ready-to-start data directory), compressed on the way out
pg_basebackup --pgdata=/srv/backup/base --format=plain --wal-method=stream --compress=server-zstd
```

The trade-off mirrors `pg_dump`'s. `pg_basebackup` is fast and captures the whole
cluster including roles and tablespaces in one shot, but the result is only
restorable into the **same major version** — a copy of a 15 cluster will not open
under Postgres 17 — and it is not selective: no "just this table". By itself it is
a single snapshot of whenever you ran it, whose real purpose is as the anchoring
base for WAL archiving. So: `pg_dump` when you want something you can carry
anywhere and open object by object; `pg_basebackup` when you want speed and a whole
cluster, and you are building a recovery capability rather than one file to keep.

## WAL archiving and point-in-time recovery

Continuous **WAL archiving** turns a periodic base backup into the ability to
recover to *any* moment. The server ships every completed 16 MB WAL segment
somewhere durable; a restore replays the base backup, then the archived WAL up to
the instant you choose. That instant is the point: you do not restore "last night's
backup", you restore "the state at 14:01:30, one second before the `DELETE`".

Three settings on the primary turn it on, plus a base backup to start from:

```conf
# postgresql.conf
wal_level = replica                 # enough detail to rebuild pages
archive_mode = on
archive_command = 'test ! -f /srv/wal-archive/%f && cp %p /srv/wal-archive/%f'
# PostgreSQL 15+: an archive_library command is the modern alternative
# max_wal_senders and archive_timeout are worth setting too
```

`archive_command` must return 0 only when the segment is durably stored. The
`test ! -f` guard makes it idempotent so a re-tried segment does not clobber a good
one. Once the first base backup exists, every later one plus the WAL in the archive
is a recoverable history. Restoring to a point in time is that base backup plus a
recovery target:

```bash
# 1. Restore the base backup into an empty PGDATA, then add recovery config
tar -xf /srv/backup/base/base.tar -C "$PGDATA"
# 2. In postgresql.conf (PG12+; no more recovery.conf):
#    restore_command = 'cp /srv/wal-archive/%f %p'
#    recovery_target_time = '2026-11-15 14:01:30+00'
#    recovery_target_action = 'promote'
# 3. The presence of this file is what tells Postgres to recover:
touch "$PGDATA/recovery.signal"
# 4. Start it — it replays WAL, promotes, and accepts writes
pg_ctl -D "$PGDATA" -l /var/log/postgresql/recover.log start
```

Watch the log for `consistent recovery state reached` and `database system is ready
to accept connections`. If it never reaches that line, you are missing WAL — exactly
the failure a restore drill exists to catch before you need it.

## Restore drills: prove `pg_restore` and `pg_ctl` recovery work

A backup is a hypothesis; a restore is the test. Once a month, restore into a
scratch location and start the service. Same ritual as in
[backups you can actually restore](/posts/backups-you-can-restore/), just with
Postgres commands.

```bash
# Logical dump: restore into a scratch database, dropping objects first
createdb restore_test
pg_restore --clean --if-exists --jobs=4 --dbname=restore_test /srv/backup/app.dump
psql restore_test -c 'SELECT count(*) FROM orders;'   # prove it is real data

# Physical/PITR: restore the base, let it replay, then read the recovery log
pg_ctl -D /srv/backup/recover -l recover.log start
psql -p 5433 -c 'SELECT pg_is_in_recovery();'         # f → promoted, done
```

Time every drill and write the number down: that is your real RTO, and it is almost
always longer than you guessed. Restoring `globals.sql` first, starting the cluster
on a spare port, and querying one table turns "the backup ran" into "the backup
works".

## The gotchas that bite after the restore succeeds

- **Large databases.** `pg_dump` and `pg_restore` scale with size, so measure the
  dump *and* the restore. A strategy whose restore takes longer than your outage
  tolerance is not a strategy.
- **Bloat.** A dump reflects live rows plus any dead tuples still visible; a table
  bloated fivefold dumps five times bigger and slower. `VACUUM` (or `pg_repack` for
  zero downtime) before big backups if size matters.
- **Sequences.** `pg_dump` records `setval` for sequences it owns, but restore
  objects selectively and sequences drift, so the next `INSERT` collides. After a
  partial restore, check `last_value` against `max(id)`.
- **Extensions.** The dump emits `CREATE EXTENSION`, not the extension's code, so
  `pgcrypto`, `postgis`, or `pg_stat_statements` must be installed on the target
  first. Test on a fresh host, not the one that has them.
- **Roles and tablespaces.** `pg_dump` does not carry them; pair every per-database
  dump with `pg_dumpall --roles-only`, and remember grants survive only if the roles
  exist.
- **Silent archive failure.** If `archive_command` starts failing, `pg_wal/` grows
  until the disk fills and the primary stops. Alert on `pg_stat_archiver`: a rising
  `failed_count` or a stale `last_archived_time` is the alarm people discover only
  during a failed recovery.

## What I recommend for a small self-hosted database

For the database most homelabs and small products run — one box, tens of gigabytes,
writes every few seconds — do the boring thing completely:

1. **A nightly logical dump of every database**, custom format, plus
   `pg_dumpall --roles-only` for the globals. Encrypt and ship it offsite with
   restic, and keep a retention policy (7 daily, 4 weekly, 12 monthly) so a mistake
   noticed in a month is still recoverable.
2. **A restore drill you actually run.** Weekly, automated to a scratch instance;
   quarterly, by hand, timed. This converts a dump into a backup for an afternoon a
   quarter.
3. **Add PITR only when the data is precious.** Turn on WAL archiving and a daily
   `pg_basebackup` if losing the last 24 hours of writes would truly hurt — money,
   user content you cannot recreate, a system of record. It roughly doubles the
   operational surface: extra WAL storage, a monitored `archive_command`, and a
   recovery procedure you must also rehearse.

The ordering matters: a tested nightly dump beats an untested PITR every time,
because a backup you can restore in twenty minutes is worth more than a perfect
recovery chain you have never traversed. And if the database is small enough that a
single file and WAL mode would do, read [SQLite is enough](/posts/sqlite-is-enough/)
before you add a server to back up at all.
