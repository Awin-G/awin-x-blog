---
title: "Postgres locks and deadlocks, reproduced: pg_locks, SELECT FOR UPDATE, lock queues"
description: "Postgres locks and deadlocks, reproduced on a throwaway Postgres 17. What UPDATE and SELECT ... FOR UPDATE lock, finding blockers with pg_locks and pg_stat_activity, the lock queue that stalls everything, and avoiding deadlocks with lock ordering, SKIP LOCKED and lock_timeout."
pubDate: 2026-12-06
lang: en
translationKey: postgres-locks
tags: [devops, linux]
featured: false
keywords:
  - Postgres locks
  - Postgres deadlock
  - pg_locks
  - SELECT FOR UPDATE
  - lock_timeout
---

**Postgres locks** are invisible until they are not, and then a single forgotten transaction stalls your whole application. I have debugged this enough times to distrust diagrams, so I stood up a throwaway Postgres 17 in a container, opened two `psql` sessions, and forced every situation to happen for real: a row `UPDATE` blocking another, a **Postgres deadlock** error, and the lock queue where one pending `ALTER TABLE` freezes a plain `SELECT`. This post is the transcript. What **`UPDATE`** and **`SELECT ... FOR UPDATE`** actually lock, how to find the blocker by joining **`pg_locks`** to **`pg_stat_activity`**, why the queue behaves the way it does, and the two settings that stop a stuck lock from becoming an outage.

Everything below is copied from the terminal, not reconstructed. Here is the whole setup:

```sql
docker run --rm -d --name pglock -e POSTGRES_PASSWORD=x \
  -p 127.0.0.1:55432:5432 postgres:17
docker exec -i pglock psql -U postgres -c 'select version();'
--   PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2) on x86_64-pc-linux-gnu
```

The workhorse table is a job queue of 200k rows; the observer query I run against a second session is the one from the "finding the blocker" section.

## Row locks vs table locks: two layers, not one

Postgres takes locks at two levels at the same time, and conflating them is the source of most confusion.

A **table-level lock** is taken on the relation itself, in one of eight modes. Every statement takes at least an `ACCESS SHARE` (reads) or a `ROW EXCLUSIVE` (writes). Only a few statements take the heavy ones: `ALTER TABLE`, `DROP`, `TRUNCATE` and explicit `LOCK TABLE` take `ACCESS EXCLUSIVE`, which conflicts with *everything*, including reads.

A **row-level lock** is stored on the tuple, shown in `pg_locks` as `locktype = 'tuple'`, plus a lock on the transaction id itself (`locktype = 'transactionid'`) so other backends can wait on whoever holds it. Row locks do not exist as a separate object you can enumerate cheaply; they are markers on rows, and they are why a table can be "locked" for one row without the table being locked at all.

The key rule: a write always takes a `ROW EXCLUSIVE` table lock for the duration of the transaction, even though two writes to different rows do not conflict. That is deliberate — `ROW EXCLUSIVE` is compatible with itself, so concurrent writers are fine, but it is *not* compatible with `ACCESS EXCLUSIVE`. Which is exactly how the lock queue in a later section is born.

## What `UPDATE` and `SELECT ... FOR UPDATE` actually lock

Both take a table-level lock, and they are not the same mode. `UPDATE` takes `RowExclusiveLock`; `SELECT ... FOR UPDATE` takes `RowShareLock` (weaker — it does not conflict with other `RowShareLock`s). Then both lock the specific rows they touch. I held one row in an open transaction and let a second session try to update it:

```sql
-- session 1
BEGIN;
UPDATE jobs SET state = 'working' WHERE id = 1;
SELECT pg_sleep(8);
COMMIT;
-- session 2, meanwhile
UPDATE jobs SET state = 'stolen' WHERE id = 1;
```

Joining `pg_locks` to `pg_stat_activity`, the second session is unmistakably stuck:

```text
 pid | state  | wait_event_type |  wait_event   |   locktype    | relation  |       mode          | granted | blocked_by |            query
-----+--------+-----------------+---------------+---------------+-----------+---------------------+---------+------------+-------------------------------
  86 | active | Timeout         | PgSleep       | relation      | jobs      | RowExclusiveLock    | t       | {}         | SELECT pg_sleep(8);
  93 | active | Lock            | transactionid | tuple         | jobs      | ExclusiveLock       | t       | {86}       | UPDATE jobs SET state='stolen' ...
  93 | active | Lock            | transactionid | relation      | jobs      | RowExclusiveLock    | t       | {86}       | UPDATE jobs SET state='stolen' ...
  93 | active | Lock            | transactionid | transactionid |           | ShareLock           | f       | {86}       | UPDATE jobs SET state='stolen' ...
```

Read it in order. `86` holds the transaction and the row; `93` has *granted* its own `RowExclusiveLock` on the table (so its own write is fine to start) but has an **ungranted** `ShareLock` on `transactionid` — it is waiting for `86` to finish. `wait_event_type = 'Lock'` is the tell: this backend is not doing work, it is parked. `blocked_by = {86}` is `pg_blocking_pids()` doing the graph walk for you.

`SELECT ... FOR UPDATE` produces the same shape with a weaker table lock — here the holder (199) shows `RowShareLock` and the waiter (206) shows the same ungranted `transactionid` `ShareLock`:

```text
 199 | access | Timeout | PgSleep    | relation      | jobs | RowShareLock     | t | {}
 206 | active | Lock    | transactionid | tuple      | jobs | ExclusiveLock  | t | {199}
 206 | active | Lock    | transactionid | relation   | jobs | RowShareLock    | t | {199}
 206 | active | Lock    | transactionid | transactionid | | ShareLock     | f | {199}
```

The practical difference: a plain `SELECT` (no `FOR UPDATE`) takes only `AccessShareLock` and is **never** blocked by another transaction's row lock; it does not wait and it reads the last committed version. `FOR UPDATE` is a promise to write, and it waits.

## Finding the blocker with `pg_locks` and `pg_stat_activity`

The query I used all the way through is worth memorizing. `pg_locks` tells you *what* is held; `pg_stat_activity` tells you *who* and *what they were running*; `pg_blocking_pids()` computes the wait graph so you do not have to.

```sql
SELECT a.pid, a.state, a.wait_event_type, a.wait_event,
       l.locktype, l.relation::regclass AS relation, l.mode, l.granted,
       pg_blocking_pids(a.pid) AS blocked_by,
       left(a.query, 46) AS query
FROM pg_stat_activity a
LEFT JOIN pg_locks l ON l.pid = a.pid
WHERE a.pid <> pg_backend_pid()
  AND a.datname = current_database()
  AND a.state <> 'idle'
ORDER BY a.pid, l.granted DESC, l.mode;
```

The filter that pays off is `wait_event_type = 'Lock'`. A backend doing real work shows `wait_event_type` of `IO`, `LWLock`, `Client`, or `Timeout` (as `SELECT pg_sleep` does). Only contention on a heavyweight lock shows `Lock`. If you alert on one thing, alert on the count of backends with `wait_event_type = 'Lock'` — that is your queue depth, and it is a leading indicator an outage is starting.

## The lock queue: why one slow query blocks everyone

This is the part that surprises people. Locks are granted **first in, first out**. A request that cannot be granted does not get skipped — it holds the queue, and everything compatible behind it waits too. Watch a reader hold `ACCESS SHARE` while an `ALTER TABLE` wants `ACCESS EXCLUSIVE`, and then a *third*, innocuous `SELECT` arrives:

```sql
-- S1: long reader, holds ACCESS SHARE for 8s
BEGIN; SELECT count(*) FROM jobs; SELECT pg_sleep(8); COMMIT;
-- S2: ALTER queues behind S1
ALTER TABLE jobs ADD COLUMN tmp_flag int;
-- S3: a plain SELECT that does NOT conflict with S1
SELECT count(*) FROM jobs;
```

```text
 108 | active | Timeout | PgSleep  | relation      | jobs | AccessShareLock     | t | {}
 115 | active | Lock    | relation | relation      | jobs | AccessExclusiveLock | f | {108}
 121 | active | Lock    | relation | relation      | jobs | AccessShareLock     | f | {115}
```

`121`'s `AccessShareLock` does not conflict with `108`'s `AccessShareLock` — both are reads. It is blocked anyway, by `115`, the *pending* `ALTER`. The queue is FIFO, so the cheaper, later request lines up behind the expensive, earlier one. This is how a migration that waits on a long report takes down reads: not because reads conflict with reads, but because they queue behind the migration. If you have ever had "the site froze during a schema change" with no lock error, this is the mechanism, and it is the strongest argument for setting `lock_timeout` on migrations.

## The Postgres deadlock error and how to read it

Deadlocks are the queue facing itself: A waits on B while B waits on A. Postgres detects the cycle after `deadlock_timeout` and aborts one transaction. I made two transactions lock the same two rows in opposite order:

```sql
-- A                                -- B
BEGIN;                             BEGIN;
UPDATE accounts SET balance = balance - 10 WHERE id = 1;
                                   UPDATE accounts SET balance = balance + 20 WHERE id = 2;
UPDATE accounts SET balance = balance + 10 WHERE id = 2;  -- waits on B
                                   UPDATE accounts SET balance = balance - 20 WHERE id = 1;  -- closes the cycle
COMMIT;                            COMMIT;
```

The error is verbose on purpose — it names both processes and both stuck statements:

```text
ERROR:  deadlock detected
DETAIL:  Process 148 waits for ShareLock on transaction 761; blocked by process 149.
Process 149 waits for ShareLock on transaction 760; blocked by process 148.
HINT:  See server log for query details.
CONTEXT:  while updating tuple (0,2) in relation "accounts"
```

And the server log adds the two offending statements, which is what you actually fix:

```text
[148] DETAIL:  Process 148 waits for ShareLock on transaction ...; blocked by process 149.
[148]        Process 148: UPDATE accounts SET balance = balance + 10 WHERE id = 2;
[148]        Process 149: UPDATE accounts SET balance = balance - 20 WHERE id = 1;
```

Read it as a cycle, not an error. Process 148 took the first lock and lost; 149 committed. Check the outcome and you can prove it: `alice` is 80, `bob` is 120 — the entire rollback of A, including the part that looked like it succeeded.

## Avoiding deadlocks: consistent lock ordering, short transactions

You do not "fix" a deadlock by retrying harder. You remove the cycle. The cause above is that A and B touched the same two rows in **opposite order**. If both always lock the lower id first, no cycle can form.

```sql
-- the fix: a canonical order, enforced in application code
BEGIN;
SELECT balance FROM accounts WHERE id IN (1, 2) ORDER BY id FOR UPDATE;
UPDATE accounts SET balance = balance - 10 WHERE id = 1;
UPDATE accounts SET balance = balance + 10 WHERE id = 2;
COMMIT;
```

Two more rules from the same reproduction. **Keep transactions short** — the longer the open transaction, the wider the window where it holds a lock someone else wants, and the whole `pg_sleep(8)` above exists only to make that window visible. And **never hold a lock across a network call or user think-time**. Every deadlock fix is a cycle-removal plus a smaller window; retry logic is only a band-aid for the ones you missed, and it must retry the *whole* transaction, not the failed statement.

<figure>
<svg viewBox="0 0 680 300" width="100%" role="img" aria-label="Two transactions interleaving into a deadlock. T1 locks row 1 then requests row 2; T2 locks row 2 then requests row 1. Each request waits on the other, forming a cycle that Postgres breaks by aborting one transaction.">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <text x="20" y="26" font-weight="600" font-size="14">Time →</text>
    <text x="70" y="60" font-weight="600" font-size="13">T1</text>
    <text x="70" y="200" font-weight="600" font-size="13">T2</text>
  </g>
  <g stroke="currentColor" stroke-width="2" opacity="0.55">
    <line x1="110" y1="52" x2="660" y2="52"/>
    <line x1="110" y1="192" x2="660" y2="192"/>
  </g>
  <!-- T1 events -->
  <g font-family="ui-monospace, monospace" font-size="12" fill="currentColor">
    <circle cx="180" cy="52" r="6" fill="currentColor"/>
    <text x="180" y="40" text-anchor="middle">UPDATE id=1</text>
    <circle cx="430" cy="52" r="6" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="430" y="40" text-anchor="middle">UPDATE id=2</text>
    <circle cx="180" cy="192" r="6" fill="currentColor"/>
    <text x="180" y="212" text-anchor="middle">UPDATE id=2</text>
    <circle cx="430" cy="192" r="6" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="430" y="212" text-anchor="middle">UPDATE id=1</text>
  </g>
  <!-- the cycle -->
  <g fill="none" stroke="currentColor" stroke-width="2" marker-unit="strokeWidth">
    <path d="M 430 52 C 470 90, 470 150, 430 192" stroke-dasharray="6 4"/>
    <path d="M 430 192 C 390 150, 390 90, 430 52" stroke-dasharray="6 4"/>
  </g>
  <g font-family="system-ui, sans-serif" font-size="12.5" font-weight="600">
    <text x="560" y="112" text-anchor="middle" fill="currentColor">waits for T2</text>
    <text x="560" y="140" text-anchor="middle" fill="currentColor">waits for T1</text>
  </g>
  <text x="340" y="278" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="currentColor" opacity="0.85">T1 holds row 1 and wants row 2; T2 holds row 2 and wants row 1 → a cycle with no progress</text>
</svg>
<figcaption>Two transactions that grab the same pair of rows in opposite order always risk this cycle. Postgres breaks it by aborting one, but the real fix is upstream: make every code path lock the same rows in the same order.</figcaption>
</figure>

## Queues: `FOR UPDATE SKIP LOCKED` and `NOWAIT`

If your "lock" is really a work queue, waiting is the wrong behavior — you want a different row. Two modifiers change the blocking semantics entirely, and I timed both against the held row:

```text
-- FOR UPDATE NOWAIT: fail fast instead of queueing
ERROR:  could not obtain lock on row in relation "jobs"
Time: 0.838 ms

-- FOR UPDATE SKIP LOCKED: ignore the locked row and move on
SELECT id FROM jobs WHERE id = 1 FOR UPDATE SKIP LOCKED;
 id
----
(0 rows)
```

`NOWAIT` returns an error immediately, which is right when the caller can do something useful with "busy right now". `SKIP LOCKED` returns *zero rows* rather than waiting, and that is the whole basis of a safe Postgres job queue: many workers run `SELECT ... FROM jobs WHERE state='pending' ... LIMIT 1 FOR UPDATE SKIP LOCKED`, and each one gets a different pending row without ever colliding. It is also a double-edged tool — `SKIP LOCKED` gives a non-repeatable view of the table, so never use it for anything where "the row I skipped" matters.

## Safety nets: `lock_timeout` and `statement_timeout`

The last reproduction is the one that keeps a bad day from becoming an outage. `lock_timeout` bounds how long a statement will *wait for a lock*; `statement_timeout` bounds its *total runtime*.

```text
-- lock_timeout: stop queueing after 1s
SET lock_timeout = '1s';
UPDATE jobs SET state = 'x' WHERE id = 1;
ERROR:  canceling statement due to lock timeout
Time: 1000.974 ms

-- statement_timeout: bound the whole statement
SET statement_timeout = '500ms';
SELECT pg_sleep(5);
ERROR:  canceling statement due to statement timeout
Time: 500.207 ms
```

Note which is which. My waiter was blocked *acquiring* a lock, so `lock_timeout` fired and the statement never even ran. `statement_timeout` is broader — it would have killed the query anyway, but it also counts time spent doing actual work, so as a lock guard it is blunt. Use both: `lock_timeout` on interactive paths and especially on migrations (so a migration queues for seconds, not minutes, then gives up and retries), and `statement_timeout` as a backstop so no single query can run forever. Neither prevents deadlocks; they only cap how long you suffer one, which is often the difference between a slow page and an incident.

## What I actually take away

Locks are a queue, and the queue is fair — which is exactly why a slow, late, or ordered-wrong request can stall everyone behind it. The whole debugging loop fits in one query (`pg_locks` ⨝ `pg_stat_activity`, filtered on `wait_event_type = 'Lock'`, with `pg_blocking_pids`), and the whole prevention fits in three rules: lock rows in a consistent order, keep transactions short, and give every statement a `lock_timeout`. Indexes shape the same access paths you lock, so it is worth understanding both together — see [database indexing basics](/posts/database-indexing/) for why a query with no index takes so much longer *while holding a lock*, and [backups you can restore](/posts/postgres-backups/) for the other half of not losing the data these transactions were protecting.
