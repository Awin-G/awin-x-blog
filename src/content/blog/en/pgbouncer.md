---
title: "PgBouncer and Postgres connection pooling, reproduced (and the transaction-mode trap)"
description: "A hands-on look at Postgres connection pooling with PgBouncer: why every connection is a process, why raising max_connections only moves the ceiling, how pool modes differ, and the ways transaction mode broke session state, temp tables and prepared statements — with real output."
pubDate: 2026-12-18
lang: en
translationKey: pgbouncer
tags: [devops, linux]
featured: false
keywords:
  - PgBouncer
  - Postgres connection pooling
  - transaction mode
  - max_connections
  - SHOW POOLS
---

**PgBouncer** is what most teams reach for when a Postgres app runs out of connections, but the reason it works — and the reason it bites — is easy to get wrong. I stood up a throwaway Postgres 17 and PgBouncer 1.26 pair under Docker, pointed 40 clients at both, and watched what happened. **Postgres connection pooling** cut the server backends from 40 to 5; switching to **transaction mode** broke session state, temp tables, prepared statements, and advisory locks in ways that needed real output to believe. And the reflex fix — raising **max_connections** — only moves the ceiling, because each connection is an operating-system process with its own memory.

## Why Postgres forks a process per connection — and why raising max_connections is wrong

Postgres is process-based, not thread-based. Every client connection gets its own `postgres` backend process, which you can watch on the host.

```console
$ docker exec pgdemo-pg ps -o pid=,rss=,args= -C postgres
    1 28564 postgres -c max_connections=100
   27  5960 postgres: checkpointer
   28  5940 postgres: background writer
   31  8812 postgres: autovacuum launcher

# 6 processes idle: 61 MB. Then 40 clients connect directly to 127.0.0.1:55432:
$ docker exec pgdemo-pg sh -c "ps -o rss= -C postgres | awk '{s+=$1} END {print s/1024 \" MB\"}'"
636 MB     # 46 processes, ~14 MB per connection
```

That is why "just raise `max_connections`" is a trap: the memory is reserved whether or not the connection does work, and the ceiling is hard.

```console
$ psql "postgres://appuser:secret@127.0.0.1:55432/app" -c "SELECT 1;"
psql: error: connection to server at "127.0.0.1", port 55432 failed:
FATAL:  sorry, too many clients already
```

The real problem is almost never that Postgres must run 100 queries at once. It is that 400 application workers, each holding an idle connection, consume 400 process slots to run maybe 5 queries.

## What a Postgres connection pooling layer actually does

A connection pooler sits between your app and Postgres and decouples *client* connections from *server* connections. Hundreds of clients connect to PgBouncer; PgBouncer keeps a small set of real Postgres connections and hands one to a client only when that client actually needs to talk to the database. The idle connections stop being Postgres's problem.

<figure>
<svg viewBox="0 0 680 300" width="100%" role="img" aria-label="Many client connections converge on PgBouncer, which multiplexes them onto a small number of Postgres backend processes.">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <text x="70" y="22" text-anchor="middle" font-weight="600" font-size="13">clients</text>
    <text x="340" y="22" text-anchor="middle" font-weight="600" font-size="13">PgBouncer</text>
    <text x="600" y="22" text-anchor="middle" font-weight="600" font-size="13">Postgres</text>
  </g>
  <g fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.65">
    <rect x="18" y="42" width="104" height="18" rx="4"/>
    <rect x="18" y="68" width="104" height="18" rx="4"/>
    <rect x="18" y="94" width="104" height="18" rx="4"/>
    <rect x="18" y="120" width="104" height="18" rx="4"/>
    <rect x="18" y="146" width="104" height="18" rx="4"/>
    <rect x="18" y="172" width="104" height="18" rx="4"/>
    <rect x="18" y="198" width="104" height="18" rx="4"/>
    <rect x="18" y="224" width="104" height="18" rx="4"/>
  </g>
  <text x="70" y="266" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="currentColor">40 clients</text>
  <g stroke="#0f766e" stroke-width="1" fill="none" opacity="0.5">
    <path d="M122 51 C 190 51 200 150 250 150"/>
    <path d="M122 77 C 190 77 200 150 250 150"/>
    <path d="M122 103 C 190 103 200 150 250 150"/>
    <path d="M122 129 C 190 129 200 150 250 150"/>
    <path d="M122 155 C 190 155 200 150 250 150"/>
    <path d="M122 181 C 190 181 200 150 250 150"/>
    <path d="M122 207 C 190 207 200 150 250 150"/>
    <path d="M122 233 C 190 233 200 150 250 150"/>
  </g>
  <rect x="250" y="60" width="180" height="180" rx="16" fill="none" stroke="#0f766e" stroke-width="2.5"/>
  <text x="340" y="132" text-anchor="middle" font-family="system-ui, sans-serif" font-size="19" font-weight="700" fill="#0f766e">PgBouncer</text>
  <text x="340" y="156" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">pool_size = 5</text>
  <text x="340" y="180" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="currentColor" opacity="0.8">one backend per</text>
  <text x="340" y="195" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="currentColor" opacity="0.8">transaction</text>
  <g stroke="#0f766e" stroke-width="1" fill="none" opacity="0.5">
    <path d="M430 150 C 470 150 480 66 520 66"/>
    <path d="M430 150 C 470 150 480 108 520 108"/>
    <path d="M430 150 C 470 150 480 150 520 150"/>
    <path d="M430 150 C 470 150 480 192 520 192"/>
    <path d="M430 150 C 470 150 480 234 520 234"/>
  </g>
  <g fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.85">
    <rect x="520" y="50" width="130" height="32" rx="6"/>
    <rect x="520" y="92" width="130" height="32" rx="6"/>
    <rect x="520" y="134" width="130" height="32" rx="6"/>
    <rect x="520" y="176" width="130" height="32" rx="6"/>
    <rect x="520" y="218" width="130" height="32" rx="6"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="11">
    <text x="585" y="70" text-anchor="middle">backend</text>
    <text x="585" y="112" text-anchor="middle">backend</text>
    <text x="585" y="154" text-anchor="middle">backend</text>
    <text x="585" y="196" text-anchor="middle">backend</text>
    <text x="585" y="238" text-anchor="middle">backend</text>
  </g>
</svg>
<figcaption>PgBouncer terminates the client connections and multiplexes them onto a small pool of real Postgres backends. Here 40 clients share 5 backends, so the memory you pay for is a function of the pool size, not the client count.</figcaption>
</figure>

Here is the same 40-client workload pointed at three targets, counting real backends on the Postgres side with `pg_stat_activity`:

```console
### 40 clients straight to Postgres (127.0.0.1:55432)
 server_backends
-----------------
              40

### the same 40 clients through PgBouncer, session mode (127.0.0.1:6432)
 server_backends
-----------------
              40

### session replaced with transaction mode (127.0.0.1:6433)
 server_backends
-----------------
               5
```

Direct and session mode cost one backend per client; transaction mode collapsed 40 clients onto 5. That is the entire value proposition, and the "40 backend" column in session mode is the first hint of the tradeoff.

## PgBouncer pool modes: session, transaction, statement

`pool_mode` decides how long a client holds a server connection. The three modes trade multiplexing for compatibility.

- **session** — the backend is held for the whole session, exactly like a direct connection. Maximum compatibility, no multiplexing for idle-but-open clients. `pool_size` still caps backends, so extra clients queue.
- **transaction** — the backend is held for one transaction, then released. This is where the big win lives: 40 clients on 5 backends, because most clients are idle most of the time. Anything *session-scoped* stops working.
- **statement** — the backend is held for a single statement, so multi-statement transactions are effectively impossible. Almost nobody uses it.

I ran one PgBouncer instance per mode from the same image, so the comparison is apples to apples. The difference is invisible until something needs session state.

## The transaction-mode trap, reproduced

This is the part that actually causes incidents. In transaction mode, a client's two consecutive transactions may run on two different backends, and PgBouncer does **not** reset the backend between clients by default (`server_reset_query_always = 0`), so state can both vanish and leak. I reproduced four failures with 10 concurrent workers sharing a pool of 5.

### Session state: `SET` went missing — and came back as someone else's

A worker sets a session GUC in one transaction and reads it in the next.

```console
### session mode (127.0.0.1:6432, pool_size 40)
port 6432: 10 workers x 40 checks = 400
  preserved            : 400
  lost (back to default): 0
  leaked (other worker) : 0

### transaction mode (127.0.0.1:6433, pool_size 5)
port 6433: 10 workers x 40 checks = 400
  preserved            : 33
  lost (back to default): 4
  leaked (other worker) : 363
    worker w0 read marker 'w5' set by another connection
    worker w2 read marker 'w5' set by another connection
```

Only 33 of 400 reads saw their own value. 4 got the default, and 363 read a marker **another worker had set** — the backend was never cleaned up between clients. This is not just "your `SET` doesn't stick"; it is "your neighbour's `SET` is now visible to you". `SET search_path`, `SET timezone`, `SET statement_timeout`, `SET ROLE` — all of it is unsafe in transaction mode.

### Temp tables vanish (and leak)

```console
### temp table, transaction mode (127.0.0.1:6433)
port 6433: 10 workers x 30 iterations
  temp table still there : 283
  temp table vanished    : 17
  first error: relation "scratch" does not exist

### temp table, session mode (127.0.0.1:6432)
  temp table still there : 300
  temp table vanished    : 0
```

17 of 300 iterations hit `relation "scratch" does not exist` — the temp table lived on a backend the client no longer held. The 283 "still there" are the leak: on a shared backend the table stuck around and other clients could even insert into it. Same trap applies to `WITH HOLD` cursors and `LISTEN`/`NOTIFY`.

### Prepared statements: the fastest way to break your app

SQL-level `PREPARE`/`EXECUTE` across transactions is a lottery.

```console
port 6433: 10 workers x 30 PREPARE/EXECUTE pairs
  worked : 22
  failed : 278
     274x prepared statement "q" already exists
       4x prepared statement "q" does not exist
```

278 of 300 failed. Drivers that use named prepared statements at the protocol level hit the same wall the moment `max_prepared_statements` is off, which is the classic `pgbench` failure:

```console
$ pgbench -M prepared -c 8 -t 30 -f prep.sql -p 6434   # max_prepared_statements=0
pgbench: error: ERROR:  prepared statement "P_0" already exists
pgbench: error: client 5 script 0 aborted in command 0 query 0:
    ERROR:  prepared statement "P_0" does not exist
number of transactions actually processed: 39/240
error: Run was aborted; the above results are incomplete.
```

Modern PgBouncer (1.26 here) defaults `max_prepared_statements` to 200 and tracks protocol-level prepared statements per client, so the same run against the default pooler is clean:

```console
$ pgbench -M prepared -c 8 -t 30 -f prep.sql -p 6433   # max_prepared_statements=200
number of transactions actually processed: 240/240
number of failed transactions: 0 (0.000%)
tps = 2330.187580
```

The lesson is not "prepared statements are broken". It is: **know what your driver does and what your PgBouncer version supports.** Disabling prepared statements in the driver (`prepareThreshold=0` in JDBC, `statement_cache_size=0` for asyncpg) is the other common workaround.

### Advisory locks outlive the transaction

`pg_advisory_lock` is session-scoped, not transaction-scoped. Take it on one backend and it stays there after your client moves on.

```console
client A on backend 33: took pg_advisory_lock(42)
client B on backend 34: pg_try_advisory_lock(42) -> False (false = blocked)
pg_locks: pid=33 mode=ExclusiveLock granted=True
```

One client's session lock blocked an unrelated client, because in transaction mode "session" is a foreign concept. Use `pg_advisory_xact_lock` instead — Postgres releases it at commit.

## Reading the admin console: SHOW POOLS, SHOW STATS, SHOW CLIENTS, SHOW SERVERS

PgBouncer has a virtual `pgbouncer` database you connect to like any other. With 40 clients hammering the transaction pooler, here is what it reports:

```console
$ psql "postgres://postgres:secret@127.0.0.1:6433/pgbouncer" -c "SHOW POOLS;" -x
database              | app
user                  | postgres
cl_active             | 5
cl_waiting            | 35
sv_active             | 5
sv_idle               | 0
maxwait               | 2
maxwait_us            | 872725
pool_mode             | transaction
```

`cl_active` 5, `cl_waiting` 35, `sv_active` 5 — 40 clients, 5 servers, and 35 clients queued with a worst-case wait of 2.87 s. If `maxwait` creeps up in production, your `pool_size` is too small for your workload.

`SHOW STATS` adds the traffic numbers: I saw `total_client_login_count` 165 against 5 servers, and `total_xact_count ÷ total_server_assignment_count` tells you how much work each server slot carries — higher means better multiplexing. `SHOW SERVERS` confirms the count: five rows, each a real backend.

```console
$ psql .../pgbouncer -c "SHOW SERVERS;"
 type |   user   | database | state  | remote_pid
 S    | postgres | app      | active |         33
 S    | postgres | app      | active |         34
 S    | postgres | app      | active |         35
 S    | postgres | app      | active |         36
 S    | postgres | app      | active |         37
(5 rows)
```

`SHOW CLIENTS` shows the other side of the map: 40 rows, states `active` or `waiting`, with `wait_us` climbing on the waiting ones. Many `CLIENTS`, few `SERVERS` — that is the pool working.

## Sizing the pool: what pool size to pick

Sizing is not "as many as Postgres allows". Postgres can only execute as many queries concurrently as it has CPU cores doing useful work; extra backends add memory and context switching. A common starting point is `pool_size` near the number of cores, plus some headroom — say **2× cores** for a mixed workload. The ceiling that actually matters is the sum: every PgBouncer pool `(database, user)` keeps up to `default_pool_size` backends, and all of them compete for the same `max_connections`.

```ini
[pgbouncer]
pool_mode = transaction
default_pool_size = 20      ; per (database, user)
max_client_conn = 1000     ; clients that may connect at once
max_db_connections = 40    ; hard cap across every user, for safety
reserve_pool_size = 5      ; burst
reserve_pool_timeout = 3
server_reset_query_always = 1  ; trade safety for correctness in tx mode
```

Watch `cl_waiting` and `maxwait` in `SHOW POOLS` after deployment: nonzero `cl_waiting` under normal load means too small; idle servers with low `total_xact_count` means too big.

## When you do not need PgBouncer at all

If you run one small app instance with its own modest pool — say 10 connections — adding PgBouncer buys you nothing and costs you a network hop, another thing to monitor, and the full transaction-mode footgun list. A single process with a fixed pool will not exhaust `max_connections`, and `session` mode would just be a slower direct connection.

You need a pooler when the *shape* of the traffic is wrong: many app instances, many worker threads, serverless functions that each open a connection, or a Postgres server whose `max_connections` you cannot raise. That is when decoupling client connections from server connections stops being an optimization and starts being the only thing standing between you and "too many clients already". The connection mechanics underneath — how one backend executes a query — are worth understanding first, in [how Postgres runs a query](/posts/postgres-explain/), and the transaction-mode troubles rhyme with the ones in [Postgres locks and how transactions wait](/posts/postgres-locks/).

The short version: PgBouncer is the right tool, transaction mode is the right mode for most apps, and the trap is entirely about session state. Turn on prepared-statement support, move `SET` statements inside transactions with `SET LOCAL`, replace advisory locks with their transaction-scoped form, and check `SHOW POOLS` before you assume smaller is safer.
