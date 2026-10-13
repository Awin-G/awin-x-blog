---
title: "Postgres triggers in practice: the good, the bad, and the invisible"
description: "Postgres triggers explained with real output from a throwaway container: BEFORE/AFTER row triggers, FOR EACH STATEMENT, NEW/OLD, WHEN conditions, INSTEAD OF on views, RAISE EXCEPTION, trigger ordering, the visibility gotcha, and the per-row performance trap."
pubDate: 2027-01-14
lang: en
translationKey: postgres-triggers
tags: [devops, linux]
featured: false
keywords:
  - Postgres triggers
  - CREATE TRIGGER
  - audit table
  - trigger function
  - NEW OLD
---

**Postgres triggers** are one of those features that seem trivial until they quietly break your bulk load, flood your **audit table**, or make a simple `INSERT` fail with an error you cannot trace. I have been bitten by all three, so I stood up a throwaway Postgres 16 container and forced every situation to happen for real. This post is the transcript: what **Postgres triggers** are, when a **trigger function** earns its keep, the types and timing, `NEW`/`OLD`, `WHEN`, `RAISE`, the visibility gotcha, the per-row performance trap, recursive triggers, debugging, and an honest "put this in the app instead" note.

Everything below is copied from the terminal. The setup is one command:

```bash
docker run --rm -d --name pgtrig -e POSTGRES_PASSWORD=x \
  -p 127.0.0.1:55432:5432 postgres:16-alpine
docker exec -i pgtrig psql -U postgres -c 'select version();'
--   PostgreSQL 16.8 (Debian 16.8-1.pgdg14+2) on x86_64-pc-linux-gnu
```

## What a trigger actually is

A **trigger function** is a named routine — almost always written in PL/pgSQL — that Postgres calls automatically when a specified event happens on a table or view. `CREATE TRIGGER` binds that function to an event: `INSERT`, `UPDATE`, `DELETE`, or `TRUNCATE`, at a point in time (`BEFORE`, `AFTER`, or `INSTEAD OF`), and either `FOR EACH ROW` or `FOR EACH STATEMENT`.

The distinction that matters most: `FOR EACH ROW` fires once per affected row and sees that row through `NEW` and `OLD`. `FOR EACH STATEMENT` fires once per SQL statement, does not see individual rows, and is the right choice for logging "this statement touched N rows" rather than auditing each row.

## When triggers are right: audit table, derived columns, invariants

The honest list is short. A **trigger function** earns its keep when the rule is *intrinsic to the data* — true no matter which application, migration script, or accidental `psql` session writes to the table.

**Audit trails.** The canonical use case. You want a row-by-row **audit table** no matter who writes, and you cannot trust every code path to log correctly. A `FOR EACH ROW` trigger capturing `OLD` and `NEW` as `jsonb` is the standard shape:

```sql
CREATE TABLE audit_log (
    id bigserial PRIMARY KEY,
    table_name text NOT NULL,
    op text NOT NULL,
    row_id int NOT NULL,
    old_row jsonb,
    new_row jsonb,
    changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION audit_trigger_func() RETURNS trigger AS $$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        INSERT INTO audit_log (table_name, op, row_id, old_row)
        VALUES (TG_TABLE_NAME, TG_OP, OLD.id, to_jsonb(OLD));
        RETURN OLD;
    ELSIF (TG_OP = 'UPDATE') THEN
        INSERT INTO audit_log (table_name, op, row_id, old_row, new_row)
        VALUES (TG_TABLE_NAME, TG_OP, NEW.id, to_jsonb(OLD), to_jsonb(NEW));
        RETURN NEW;
    ELSIF (TG_OP = 'INSERT') THEN
        INSERT INTO audit_log (table_name, op, row_id, new_row)
        VALUES (TG_TABLE_NAME, TG_OP, NEW.id, to_jsonb(NEW));
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER accounts_audit
AFTER INSERT OR UPDATE OR DELETE ON accounts
FOR EACH ROW EXECUTE FUNCTION audit_trigger_func();
```

After an insert, an update, and a delete, the **audit table** holds the full history:

```text
 id | table_name |   op   | row_id |                        old_row                        |                        new_row                        |          changed_at
----+------------+--------+--------+-------------------------------------------------------+-------------------------------------------------------+-------------------------------
  1 | accounts   | INSERT |      1 |                                                       | {"id": 1, "name": "alice", "balance": 100.00, ...}   | 2026-10-12 23:42:56.829437+00
  2 | accounts   | INSERT |      2 |                                                       | {"id": 2, "name": "bob", "balance": 250.50, ...}     | 2026-10-12 23:42:56.835158+00
  3 | accounts   | UPDATE |      1 | {"id": 1, "name": "alice", "balance": 100.00, ...}     | {"id": 1, "name": "alice", "balance": 150.00, ...}    | 2026-10-12 23:42:56.836482+00
  4 | accounts   | DELETE |      2 | {"id": 2, "name": "bob", "balance": 250.50, ...}       |                                                       | 2026-10-12 23:42:56.840148+00
(4 rows)
```

**Derived columns.** `updated_at` is the universal example. A `BEFORE UPDATE` trigger setting `NEW.updated_at := now()` is correct because every writer benefits and no writer can forget it.

**Enforcing invariants.** A `RAISE EXCEPTION` in a `BEFORE` trigger blocks writes that violate a rule the database itself should enforce — a negative total, a status transition that makes no sense. This is a *last line of defense*, not a replacement for `CHECK` constraints, because triggers can be disabled and constraints cannot.

```sql
CREATE OR REPLACE FUNCTION check_order_total() RETURNS trigger AS $$
BEGIN
    IF NEW.total < 0 THEN
        RAISE EXCEPTION 'order total cannot be negative: %', NEW.total
            USING ERRCODE = 'check_violation',
                  HINT = 'fix the total before inserting';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_check_total
BEFORE INSERT OR UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION check_order_total();
```

The offending write dies immediately:

```text
ERROR:  order total cannot be negative: -50.00
HINT:  fix the total before inserting
CONTEXT:  PL/pgSQL function check_order_total() line 4 at RAISE
```

## `NEW`, `OLD`, `WHEN`: the row-level toolkit

In a `FOR EACH ROW` **trigger function**, `NEW` and `OLD` are composite variables holding the row. `NEW` exists for `INSERT` and `UPDATE`; `OLD` exists for `UPDATE` and `DELETE`. In a `BEFORE` trigger you can modify `NEW` and the modified version is what gets written — that is how `updated_at` works.

The `WHEN` clause filters which rows fire the trigger. Without it, the trigger runs for every row and you check inside the function. With it, Postgres skips the call entirely for non-matching rows — cheaper and clearer. Here a price-change trigger fires only when the price actually changes:

```sql
CREATE TRIGGER products_log_price
BEFORE UPDATE OF price ON products
FOR EACH ROW
WHEN (OLD.price IS DISTINCT FROM NEW.price)
EXECUTE FUNCTION log_price_change();
```

The results show the filter working: two `UPDATE` statements were issued, but only the one that changed `price` produced an audit entry. The `UPDATE` that only changed `name` was invisible to the trigger.

```text
 id | product_id | old_price | new_price |          changed_at
----+------------+-----------+-----------+-------------------------------
  1 |          1 |      9.99 |     12.50 | 2026-10-12 23:42:57.130092+00
(1 row)
```

`UPDATE OF price` narrows the event to updates of that column; `WHEN` narrows it to rows where the value actually changed. Both are worth using.

## `FOR EACH STATEMENT`: the overlooked sibling

A statement-level trigger fires once per SQL statement, not once per row. It sees `TG_OP` and `TG_TABLE_NAME` but not `NEW` or `OLD`. The right use is coarse logging — "an insert of 3 rows happened" — not per-row auditing:

```sql
CREATE TRIGGER events_stmt_log
AFTER INSERT OR UPDATE OR DELETE ON events
FOR EACH STATEMENT EXECUTE FUNCTION stmt_trigger_func();
```

An `INSERT` of three rows produces exactly one log entry:

```text
 id | table_name |   op   | row_count |           logged_at
----+------------+--------+-----------+-------------------------------
  1 | events     | INSERT |         3 | 2026-10-12 23:42:56.976532+00
(1 row)
```

If you are tempted to use a statement trigger for auditing, do not. You cannot reconstruct individual row changes from it, and you will end up adding a row trigger anyway.

## `INSTEAD OF`: making views writable

Plain views are not updatable when they contain joins, filters, or aggregates. An **`INSTEAD OF`** trigger on a view intercepts `INSERT`, `UPDATE`, or `DELETE` and replaces it with logic you write. Here a view over active users gains an `INSERT` path:

```sql
CREATE VIEW active_users_v AS
SELECT id, name, email FROM users WHERE active = true;

CREATE TRIGGER active_users_instead_of
INSTEAD OF INSERT ON active_users_v
FOR EACH ROW EXECUTE FUNCTION active_users_insert();
```

Inserting through the view inserts into the base table with `active = true`. The view shows the new row; the base table confirms it:

```text
 id | name  |       email
----+-------+-------------------
  1 | alice | alice@example.com
  3 | carol | carol@example.com
  4 | dave  | dave@example.com
(3 rows)
```

`INSTEAD OF` is the right tool for a small, well-defined write path through a view. It is not a replacement for proper permissions and constraints on the base table.

## Trigger ordering: alphabetical, not creation order

When multiple triggers share the same timing point and event, Postgres fires them in **alphabetical order by trigger name** — not the order you created them. I created three `BEFORE INSERT` triggers named `zzz_last`, `mmm_middle`, and `aaa_first`, in that order. The output:

```text
NOTICE:  trigger_a fired: INSERT test
NOTICE:  trigger_b fired: INSERT test
NOTICE:  trigger_c fired: INSERT test
INSERT 0 1
```

Alphabetical, despite reverse creation order. If you have an ordering dependency between triggers, encode it in the names (`001_`, `002_`, `003_`) or merge the logic into one function.

## The visibility gotcha

This is the one that produces the most "impossible" bugs. A **trigger function** runs inside the same transaction and the same snapshot as the statement that fired it. Changes made by *earlier* statements in that transaction are visible; changes made by the *current* statement are not. A `BEFORE INSERT` trigger querying the table will not see the row being inserted — and in `READ COMMITTED`, it also will not see rows from other transactions that are still in flight.

I inserted two rows with the same `category` into a table with a `BEFORE INSERT` trigger that checks for existing rows:

```text
NOTICE:  trigger sees NO existing row for category food
INSERT 0 1
NOTICE:  trigger sees existing row for category food
INSERT 0 1
```

The first insert correctly saw nothing. The second insert *should* have seen the first row — it was inserted microseconds earlier — but the trigger's snapshot was taken before the first `INSERT` committed, so it saw nothing. Both rows landed. If that check was meant to be a uniqueness guard, it silently failed.

The lesson: **do not use a trigger to enforce uniqueness across rows in the same statement or transaction.** Use a unique constraint. Triggers see a stale snapshot; constraints do not.

## The per-row performance trap

`FOR EACH ROW` triggers are the default and the danger. Every affected row calls the **trigger function**, which parses, plans, and executes — even if the function body is trivial. I inserted 10,000 rows into a table with an `AFTER INSERT` trigger that wrote to an audit table, then repeated the same insert with the trigger disabled:

```text
-- with trigger
INSERT 0 10000
Time: 185.433 ms

-- trigger disabled
INSERT 0 10000
Time: 43.334 ms
```

The trigger added **142 ms** — a 4.3× slowdown — on a trivial audit insert. Now scale that to a real function with a few branches and an index lookup per row, and a 500k-row bulk load that should take seconds takes minutes.

The mitigation is not to avoid triggers; it is to be deliberate:

- Use `FOR EACH STATEMENT` when you do not need per-row data.
- Make row triggers cheap: no branching on `TG_OP` if the trigger only handles one operation, no per-row subqueries if you can batch them.
- Disable triggers during bulk loads (`ALTER TABLE ... DISABLE TRIGGER ...`) and re-enable after, accepting that you must audit the load separately.
- For bulk sync, prefer a single `INSERT INTO ... SELECT` with a statement-level audit over row-by-row application inserts.

## Recursive triggers

A trigger that writes to its own table fires itself. I created an `AFTER INSERT` trigger that inserted a row with `depth + 1`, capped at 3:

```text
 id | depth
----+-------
  1 |     0
  2 |     1
  3 |     2
  4 |     3
(4 rows)
```

One explicit insert became four rows through recursion. This is powerful for hierarchical data and terrifying when accidental. Guard recursive triggers with a `WHEN` clause that stops the chain (`WHEN (NEW.depth < 3)`), and consider whether a recursive CTE in the application would be clearer.

## Debugging triggers

Three tools do most of the work. First, `RAISE NOTICE` inside the **trigger function** shows you that it fired and what it saw:

```sql
RAISE NOTICE 'trigger_fired: % %', TG_OP, NEW.id;
```

Second, `pg_trigger` is the catalog. `pg_get_triggerdef()` gives you the full `CREATE TRIGGER` definition:

```sql
SELECT t.tgname, c.relname AS table_name, pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal
ORDER BY c.relname, t.tgname;
```

```text
      trigger_name       |   table_name    |                                                                                 definition
-------------------------+-----------------+----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 accounts_audit          | accounts        | CREATE TRIGGER accounts_audit AFTER INSERT OR DELETE OR UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION audit_trigger_func()
 events_stmt_log         | events          | CREATE TRIGGER events_stmt_log AFTER INSERT OR DELETE OR UPDATE ON public.events FOR EACH STATEMENT EXECUTE FUNCTION stmt_trigger_func()
 orders_check_total      | orders          | CREATE TRIGGER orders_check_total BEFORE INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION check_order_total()
 ...
(12 rows)
```

Third, `\d table_name` lists triggers with their timing and event — the fastest way to see what is attached:

```text
Triggers:
    accounts_audit AFTER INSERT OR DELETE OR UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION audit_trigger_func()
```

If a trigger is misbehaving, `ALTER TABLE ... DISABLE TRIGGER ...` is your circuit breaker. If a trigger is slow, log the row count and the time, not guesses.

## When to put it in the app instead

The honest counterweight. Triggers are the wrong home for:

- **Business logic that varies by caller.** If only the billing service needs to know that an order changed, the trigger fires for every writer — including the migration that fixes data.
- **Cross-service side effects.** Calling an external API, publishing to a message queue, or sending email from a **trigger function** is a recipe for stuck transactions and phantom effects. The write succeeds, the HTTP call hangs, the transaction stays open. Use the transactional outbox pattern instead: write an `outbox` row in the same transaction, relay it asynchronously.
- **`NOTIFY` fan-out done badly.** A trigger that `NOTIFY`s on every row change of a hot table will flood your listeners. Batch the notifications, or emit from the application where you can throttle.
- **Anything that must be visible to the triggering statement.** The visibility gotcha above means the trigger cannot see the statement's own writes — if you need that, you are in application code territory.

The rule of thumb: if the rule is *about the data*, use a trigger. If the rule is *about the workflow*, use the application.

## The good, the bad, and the invisible

**The good:** audit trails, `updated_at`, enforced invariants, and writable views are exactly what triggers do best. They run in the same transaction, so they cannot be forgotten by a new code path, and they apply even to manual `psql` fixes.

**The bad:** hidden business logic that fires for every writer, cross-service side effects in the transaction path, and `NOTIFY` storms. A trigger is a tax on every write; if the tax only benefits one caller, it belongs in that caller's code.

**The invisible:** the visibility gotcha and the per-row cost. The first produces logic bugs that look like data corruption; the second produces slow queries that look like missing indexes. Neither announces itself.

Use triggers for the data, keep the workflow in the app, and when in doubt, check `pg_trigger` — the catalog always tells you what is actually attached.

---

Related: [Postgres LISTEN/NOTIFY](/posts/postgres-listen-notify/), [Postgres locks and deadlocks](/posts/postgres-locks/).
