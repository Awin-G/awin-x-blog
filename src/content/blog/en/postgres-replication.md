---
title: "Postgres replication, reproduced: streaming replication and manual failover"
description: "Postgres replication reproduced end to end: building a physical standby with pg_basebackup and primary_conninfo, reading pg_stat_replication and pg_stat_wal_receiver, measuring real lag, the synchronous tradeoff, and why failover stays manual."
pubDate: 2026-12-09
lang: en
translationKey: postgres-replication
tags: [devops, linux]
featured: true
keywords:
  - Postgres replication
  - streaming replication
  - pg_stat_replication
  - failover
  - WAL
---

I keep meeting the same mistake: someone stands up a **Postgres replication** replica, sees `state = streaming` once, and declares the database "highly available". Then the primary dies and nothing happens, because **streaming replication** moves bytes — it does not decide anything. So I rebuilt the whole thing on a throwaway pair of containers and copied the terminal back out: a physical standby built with `pg_basebackup` and `primary_conninfo`, what **`pg_stat_replication`** and `pg_stat_wal_receiver` actually report, a write that really replicates, a measured replication lag, the synchronous-vs-asynchronous tradeoff, and why **failover** is still a step a human (or a tool) has to take.

Everything below is real output from two `postgres:17` containers bound to `127.0.0.1`, torn down afterward.

## What replication is for — and what it is not

There are three honest reasons to run a replica:

- **High availability.** A warm copy exists, already caught up, ready to become the primary.
- **Read scaling.** Send reporting, analytics, and long `SELECT`s to the **standby** so the primary is not doing double duty.
- **A cheaper backup source.** You can run a base backup against the replica instead of loading the primary at 03:00.

Now the part people skip, because it is the part that causes incidents:

- **A replica is not a backup.** It replays your `DELETE`, your bad migration, and your ransomware encryption within milliseconds. A backup is a copy you can restore *from* after the primary is gone; a replica is a copy that follows the primary *into* the disaster. (See [Postgres backup, honestly](/posts/postgres-backups/) for what actually qualifies.)
- **Streaming replication is not failover.** There is no election, no promotion, and no client redirection in the streaming protocol itself. `streaming` only means the bytes are flowing.
- **The standby is read-only while it is in recovery.** You cannot write to it, which is exactly what you want — until you promote it.

## How streaming replication works

<figure>
<svg viewBox="0 0 680 250" width="100%" role="img" aria-label="Diagram: a primary server streams the write-ahead log one way over the replication protocol to a read-only standby, which replays it.">
  <defs>
    <marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <rect x="20" y="70" width="190" height="104" rx="10" fill="none" stroke="#0f766e" stroke-width="2"/>
  <rect x="470" y="70" width="190" height="104" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  <g fill="none" stroke="#0f766e" stroke-width="2">
    <line x1="214" y1="122" x2="462" y2="122" marker-end="url(#arw)"/>
  </g>
  <g fill="none" stroke="#0f766e" stroke-width="1.5" opacity="0.7">
    <rect x="272" y="108" width="18" height="26" rx="2"/>
    <rect x="298" y="108" width="18" height="26" rx="2"/>
    <rect x="324" y="108" width="18" height="26" rx="2"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="14">
    <text x="115" y="104" text-anchor="middle" font-weight="600" fill="#0f766e">Primary</text>
    <text x="115" y="128" text-anchor="middle" font-size="12" opacity="0.85">reads + writes</text>
    <text x="115" y="152" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" opacity="0.8">pg_stat_replication</text>
    <text x="565" y="104" text-anchor="middle" font-weight="600">Standby</text>
    <text x="565" y="128" text-anchor="middle" font-size="12" opacity="0.85">read-only, replays WAL</text>
    <text x="565" y="152" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" opacity="0.8">pg_stat_wal_receiver</text>
    <text x="340" y="52" text-anchor="middle" font-size="13" font-weight="600" fill="#0f766e">WAL stream (one way)</text>
    <text x="340" y="200" text-anchor="middle" font-size="12" opacity="0.8">primary_conninfo + standby.signal</text>
    <text x="340" y="222" text-anchor="middle" font-size="12" opacity="0.8">lag = sent_lsn − replay_lsn</text>
  </g>
</svg>
<figcaption>Physical streaming replication is one-directional: the primary ships the write-ahead log, and the standby replays it while staying read-only. Everything you monitor lives in two views, one on each side.</figcaption>
</figure>

When `wal_level = replica`, Postgres writes enough detail into the **WAL** for another server to rebuild the same pages. A *walsender* process on the primary streams those 16 MB segments to a *walreceiver* process on the standby, which writes and then replays them. This is **physical** replication: byte-for-byte, whole cluster, same major version, one direction. (Logical replication is the other model: row-level, selective, cross-version — but that is a different post.)

Two things pin WAL so the primary does not recycle it under a lagging standby. `wal_keep_size` is a blunt floor — keep this much around "just in case". A **replication slot** is the precise version: the primary refuses to remove any WAL the slot has not confirmed. I use slots, so a disconnected standby cannot silently lose the segments it still needs.

## Setting it up: base backup, `primary_conninfo`, standby signal

The whole cluster starts with one flag (`replica` is the default level in Postgres 16+, but I set it explicitly), a role that may stream, and a physical slot.

```bash
# 1. Primary: replica-level WAL, room for senders, a WAL floor for safety
docker run -d --name pgprim -e POSTGRES_PASSWORD=secret -p 127.0.0.1:55433:5432 \
  postgres:17 \
  -c wal_level=replica -c max_wal_senders=10 -c wal_keep_size=64MB

# 2. A role allowed to stream, and a physical slot that pins WAL until the standby has it
docker exec pgprim psql -U postgres -c \
  "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replpass';"
docker exec pgprim psql -U postgres -c \
  "SELECT pg_create_physical_replication_slot('standby_slot');"
```

```text
 pg_create_physical_replication_slot
-------------------------------------
 (standby_slot,)
(1 row)
```

The standby is built from a base backup taken over the replication protocol. One flag does the hard part: `-R` writes the two files that turn a directory into a replica — `primary_conninfo` (how to reach the primary) and `standby.signal` (the order to recover and never accept writes).

```bash
# -Fp plain output (a ready PGDATA), -Xs streams WAL alongside the copy,
# -R writes primary_conninfo + standby.signal for you
pg_basebackup -h pgprim -U replicator -D "$PGDATA" -Fp -Xs -P -R
```

```text
waiting for checkpoint
23258/23258 kB (100%), 1/1 tablespace
```

`-R` leaves behind a `postgresql.auto.conf` with `primary_conninfo = 'user=replicator … host=pgprim port=5432'` and a `standby.signal` file. I add one line — the slot the standby should use — then start it with the same binary as any server:

```text
# postgresql.auto.conf
primary_conninfo   = 'user=replicator password=replpass host=pgprim port=5432'
primary_slot_name  = 'standby_slot'
# standby.signal (contents irrelevant; presence is the instruction)
```

No special "standby mode" flag. The presence of `standby.signal` is the whole difference between a primary and a standby. Here is what the two servers say about themselves:

```text
PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2) on x86_64-pc-linux-gnu

 wal_level                = replica
 max_wal_senders          = 10
 wal_keep_size            = 64MB
 synchronous_standby_names =      # async by default
```

## Verifying with `pg_stat_replication` and `pg_stat_wal_receiver`

Do not trust the setup; read it back. On the **primary**, `pg_stat_replication` has one row per connected standby:

```sql
docker exec pgprim psql -U postgres -x -c \
  "select pid, application_name, client_addr, state, sync_state, sent_lsn,
          write_lsn, flush_lsn, replay_lsn, write_lag, flush_lag, replay_lag
     from pg_stat_replication;"
```

```text
-[ RECORD 1 ]----+----------------
pid              | 121
application_name | walreceiver
client_addr      | 172.19.0.3
state            | streaming
sync_state       | async
sent_lsn         | 0/3000000
write_lsn        | 0/3000000
flush_lsn        | 0/3000000
replay_lsn       | 0/3000000
write_lag        | 00:00:00.000062
flush_lag        | 00:00:00.000062
replay_lag       | 00:00:00.000062
```

Read the four LSNs left to right: `sent_lsn` is how much the primary has put on the wire, `write_lsn` how much the standby has received, `flush_lsn` how much it has fsynced, and `replay_lsn` how much it has actually applied. The three `*_lag` intervals are "how long ago did the standby reach this stage", not a duration of work — which is why they can read as near-zero on an idle primary.

On the **standby**, the mirror view is `pg_stat_wal_receiver`, plus the one question that matters most:

```sql
docker exec pgstandby psql -U postgres -x -c \
  "select pid, status, receive_start_lsn, written_lsn, flushed_lsn, latest_end_lsn,
          slot_name, sender_host, sender_port from pg_stat_wal_receiver;"
docker exec pgstandby psql -U postgres -c "select pg_is_in_recovery();"
```

```text
-[ RECORD 1 ]-----+-------------
pid               | 37
status            | streaming
receive_start_lsn | 0/3000000
written_lsn       | 0/30B89F8
flushed_lsn       | 0/30B89F8
latest_end_lsn    | 0/30B89F8
slot_name         | standby_slot
sender_host       | pgprim
sender_port       | 5432

 pg_is_in_recovery
-------------------
 t
(1 row)
```

`status = streaming` means WAL is arriving; `pg_is_in_recovery() = t` means it is still a replica and will not accept writes. If `status` were `waiting` or `stopped`, the standby is up but not connected — that is the state a monitoring check must catch, and it is invisible to a plain "is Postgres running" probe.

## A write that replicates, and a standby that refuses writes

Insert on the primary and read it back on the standby:

```sql
-- on the primary
INSERT INTO demo(note) VALUES ('replicated from primary') RETURNING id, note;
-- on the standby
SELECT id, note FROM demo ORDER BY id;
```

```text
 id |          note
----+-------------------------
  3 | replicated from primary
(1 row)

 id |          note
----+-------------------------
  1 | row one
  2 | row two
  3 | replicated from primary
(3 rows)
```

And the property that makes a standby a standby — it refuses your writes:

```text
docker exec pgstandby psql -U postgres -c "INSERT INTO demo(note) VALUES ('should fail');"
ERROR:  cannot execute INSERT in a read-only transaction
```

That error is a feature, and it is also the reason promotion is not optional.

## Monitoring replication lag

Lag is the distance between the primary's position and what the standby has replayed. To see it move, I paused replay on the standby, wrote 200,000 rows on the primary, and asked the primary what it saw:

```text
# pause applying WAL on the standby, then write a lot on the primary
docker exec pgstandby psql -U postgres -c "select pg_wal_replay_pause();"
docker exec pgprim  psql -U postgres -c \
  "INSERT INTO demo(note) SELECT 'bulk '||g FROM generate_series(1,200000) g;"
INSERT 0 200000

 application_name |   state   | sent_lsn  | flush_lsn | replay_lsn | pending |   replay_lag
------------------+-----------+-----------+-----------+------------+---------+-----------------
 walreceiver      | streaming | 0/47FE000 | 0/4000000 | 0/3002168  | 24 MB   | 00:00:01.505076

 pg_wal_lsn_diff(sent_lsn, replay_lsn) = 29935184     -- bytes the standby has not replayed
```

`flush_lsn` (0/4000000) is ahead of `replay_lsn` (0/3002168): the standby received the WAL but had not applied it. `pg_wal_lsn_diff(sent_lsn, replay_lsn)` turns that game of LSNs into a number you can alert on — 29,935,184 bytes, about 24 MB. The standby agrees with itself:

```text
 pg_is_in_recovery | pg_last_wal_receive_lsn | pg_last_wal_replay_lsn
-------------------+-------------------------+------------------------
 t                 | 0/4000000               | 0/3002168

# resume replay and it catches up
 application_name |   state   | pending |   replay_lag
------------------+-----------+---------+-----------------
 walreceiver      | streaming | 0 bytes | 00:00:00.869134
```

Two alerting notes I learned the hard way. **Bytes and seconds answer different questions**: `pg_wal_lsn_diff` in bytes is capacity (will the disk fill?), while `replay_lag` is user-visible staleness (how old is the data a replica serves?). And a **slot changes the failure mode**: without one, a standby that falls too far behind stops with `requested WAL segment has already been removed` and drifts out of sync silently; with one, the primary keeps the WAL, so the failure moves to the primary's disk. Alert on `pg_replication_slots` where `active = false` before the disk alerts for you.

## Synchronous vs asynchronous: the latency/data-loss tradeoff

By default replication is **asynchronous**: the primary commits and returns, and the standby catches up whenever it catches up. Fast, but a crash of the primary can lose the last few transactions the standby had not received.

Promote the standby into the synchronous set by naming it on the primary:

```sql
ALTER SYSTEM SET synchronous_standby_names = 'walreceiver';
SELECT pg_reload_conf();

 synchronous_standby_names | sync_state | sync_priority
--------------------------+------------+---------------
 walreceiver              | sync       |             1
```

`sync_state` flips from `async` to `sync`, and now `COMMIT` returns only after the standby has *flushed* the WAL — the moment the guarantee becomes real. The cost is the round trip: with `synchronous_commit = on`, every commit pays the network plus the standby's fsync. On my loopback containers the difference was lost in fsync noise, but the shape is the point:

- **Async** → lowest latency, RPO of "a few transactions" on primary loss.
- **`synchronous_commit = remote_write`** → the standby has written but not fsynced; a small window, less latency.
- **`synchronous_commit = on`** → the standby has fsynced before you commit; RPO of zero, latency of a round trip.

And the trap: if the named synchronous standby disappears, `COMMIT`s **block** until it returns or you change the setting. Synchronous replication buys durability with availability, so never make it synchronous with a single named standby unless you also accept that your primary will stall when that standby dies.

## Promotion and failover are manual

Failing over is two facts you have to prove: the standby flips out of recovery, and the old primary stops being one. I promoted the standby with one command:

```sql
-- on the standby
SELECT pg_promote(wait => true);     -- pg_promote
SELECT pg_is_in_recovery();          -- f  → it is now a primary
INSERT INTO demo(note) VALUES ('written on the promoted node') RETURNING note;
INSERT 0 1
```

```text
# the old primary has no receivers left; the promoted node has no wal_receiver row
select count(*) from pg_stat_replication;    -- 0  (old primary, alone)
select count(*) from pg_stat_wal_receiver;   -- 0  (promoted node, now primary)
```

`pg_promote()` makes the standby writable. That is the entire mechanism. Everything *around* it — deciding the primary is really dead, fencing the old primary so it does not come back and split-brain, repointing clients, rebuilding a new standby — is on you. This is the gap between "replication" and "high availability", and it is usually where the outage actually happens.

Tools automate it because the manual version is where people make mistakes: **Patroni** (with etcd/Consul as consensus, the most common self-hosted choice), **repmgr** (simpler, Postgres-native, ties into the same tooling), and managed platforms that hide all of it. Whatever you pick, the point stands: the failover path must be tested on a schedule, because an untested failover is a hypothesis, not a capability.

## What I recommend

For a small self-hosted database, in order:

1. **Get backups right first.** A replica is not a backup; a restore drill is what saves you. Replication is the *second* thing you add.
2. **Run one async standby with a physical slot.** It costs little, gives you failover headroom and a read target, and the slot prevents the silent out-of-sync failure.
3. **Monitor `state`, `pg_is_in_recovery()`, and lag in bytes.** A standby that is up but disconnected looks healthy to everything except these.
4. **Practice `pg_promote()` on a spare box.** Know your RTO before you need it, and write down the client-repointing steps.
5. **Only then consider synchronous.** Turn it on when losing even one committed transaction is unacceptable — and only with a failover story for the standby, because `sync` will block `COMMIT`s when the standby is gone.

Streaming replication gives you a copy current to the millisecond. It gives you neither a backup nor failover. Knowing exactly where that line sits — and how to read it off `pg_stat_replication` — is most of the job. When the replica goes quiet, the next thing you will reach for is not replication at all: it is the [lock queue](/posts/postgres-locks/) or the WAL, depending on which side died.
