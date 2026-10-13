---
title: "Postgres Row Level Security: Multi-Tenancy Enforced by the Database"
description: "How Postgres RLS policies filter rows per tenant, the difference between ENABLE and FORCE, USING vs WITH CHECK, the pooler trap, and real isolation proofs you can reproduce."
pubDate: 2027-01-24
lang: en
translationKey: postgres-row-level-security
tags: [devops, security]
featured: false
keywords:
  - Postgres row level security
  - RLS
  - CREATE POLICY
  - multi-tenancy
  - current_setting
---

Most multi-tenant applications enforce isolation in the application layer: every query gets a `WHERE tenant_id = ?` clause that a developer must remember to include. Forget it once and you have a cross-tenant data leak. Postgres **row level security** (RLS) moves that guarantee into the database itself — the planner injects the predicate whether the query remembers it or not.

I have covered [postgres-triggers/](/posts/postgres-triggers/) and [postgres-locks/](/posts/postgres-locks/) before. RLS is the third pillar of Postgres data integrity, and for multi-tenancy it is often the right tool.

## What RLS actually is

When you enable RLS on a table, Postgres attaches a **policy** — a boolean expression — to that table. Every query (as a non-owner, non-superuser role) is automatically rewritten to include the policy's `USING` expression as an additional filter. You do not add it to your `WHERE` clause; the planner does.

```sql
CREATE TABLE documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    title text NOT NULL,
    body text
);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON documents
    FOR ALL
    TO PUBLIC
    USING (tenant_id = current_setting('app.tenant_id')::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

```
CREATE TABLE
ALTER TABLE
CREATE POLICY
```

The key line is `USING (tenant_id = current_setting('app.tenant_id')::uuid)`. The `current_setting` function reads a session variable — set per-request by your application — and the planner treats it as a constant for the duration of the query.

## Setting the tenant: `SET LOCAL` vs `SET`

Inside a transaction, use `SET LOCAL` so the variable is automatically cleared at commit/rollback:

```sql
BEGIN;
SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';
SELECT count(*) FROM documents;  -- only sees alpha's rows
COMMIT;
```

Using plain `SET` outside a transaction block is the **pooler trap**. If you share connections via PgBouncer in transaction mode, a `SET` (or `SET LOCAL` in an explicit transaction that gets pooled away) can leak to the next tenant who receives that connection. The safe pattern is:

- **Transaction pooling**: always use `SET LOCAL` inside explicit transactions, or use PgBouncer's `server_reset_query`.
- **Session pooling**: `SET` is acceptable, but you must still handle connection reuse carefully.

The variable does not need to exist in `postgresql.conf`. `current_setting('app.tenant_id')` returns an empty string until you set it, and the policy simply evaluates to false for all rows.

## Isolation proof: two tenants, real output

Let me prove it works. I spin up a throwaway Postgres 16 container, create two non-superuser roles, and test:

```sql
CREATE ROLE alpha_app LOGIN PASSWORD 'alpha_pass';
CREATE ROLE beta_app LOGIN PASSWORD 'beta_pass';
GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO alpha_app, beta_app;
```

Alpha tenant queries:

```sql
SET ROLE alpha_app;
BEGIN;
SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';
SELECT count(*) AS alpha_visible FROM documents;
COMMIT;
```

```
 alpha_visible
---------------
             1
```

Beta tenant queries:

```sql
SET ROLE beta_app;
BEGIN;
SET LOCAL app.tenant_id = '22222222-2222-2222-2222-222222222222';
SELECT count(*) AS beta_visible FROM documents;
COMMIT;
```

```
 beta_visible
--------------
            1
```

Each tenant sees exactly one row. Now the critical tests — cross-tenant write attempts:

Alpha tries to update Beta's row:

```sql
SET ROLE alpha_app;
BEGIN;
SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';
UPDATE documents SET body = 'hacked by alpha'
  WHERE tenant_id = '22222222-2222-2222-2222-222222222222';
COMMIT;
```

```
UPDATE 0
```

Zero rows affected. The `USING` clause hides the target row, so the `WHERE` clause never matches it.

Alpha tries to insert a row owned by Beta:

```sql
SET ROLE alpha_app;
BEGIN;
SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO documents (tenant_id, title, body)
VALUES ('22222222-2222-2222-2222-222222222222', 'fake beta doc', 'injected by alpha');
COMMIT;
```

```
ERROR:  new row violates row-level security policy for table "documents"
```

The `WITH CHECK` clause rejects it. This is the distinction: `USING` filters which rows you can see and modify; `WITH CHECK` validates new or updated rows against the policy.

## USING vs WITH CHECK

| Clause | Applies to | Purpose |
|--------|-----------|---------|
| `USING` | `SELECT`, `UPDATE`, `DELETE` | Filters existing rows visible to the query |
| `WITH CHECK` | `INSERT`, `UPDATE` | Validates new row values before write |

An `UPDATE` must satisfy both: the existing row must pass `USING` (so you can find it) and the new row must pass `WITH CHECK` (so you cannot reassign it to another tenant).

## FORCE ROW LEVEL SECURITY and the BYPASSRLS gotcha

By default, the **table owner** and **superusers** bypass RLS entirely. This is convenient for migrations but dangerous if your app connects as the owner.

```sql
-- Check RLS status
SELECT current_user,
       (SELECT relrowsecurity FROM pg_class WHERE relname = 'documents') AS rls_enabled,
       (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'documents') AS rls_forced;
```

```
 current_user | rls_enabled | rls_forced
--------------+-------------+------------
 postgres     | t           | f
```

`FORCE ROW LEVEL SECURITY` closes the owner hole — but **not** the superuser hole:

```sql
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
```

```
ALTER TABLE
```

Now the table owner is subject to policies. But the `postgres` superuser still bypasses:

```sql
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'postgres';
```

```
  rolname  | rolbypassrls
-----------+--------------
 postgres  | t
```

And any role with `BYPASSRLS` attribute also bypasses even `FORCE`:

```sql
CREATE ROLE auditor BYPASSRLS;
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'auditor';
```

```
  rolname  | rolbypassrls
---------+--------------
 auditor  | t
```

**Best practice**: application roles should never be superusers, never own the tables they query, and never have `BYPASSRLS`. Use a separate migration role that owns the schema but does not handle runtime queries.

## Policies with `TO role`

You can scope a policy to specific roles:

```sql
CREATE POLICY alpha_only_policy ON documents
    FOR SELECT
    TO alpha_app
    USING (tenant_id = '11111111-1111-1111-1111-111111111111');
```

```
CREATE POLICY
```

This adds an additional constraint: even if `app.tenant_id` is set to something else, `alpha_app` can only ever see Alpha's rows. Defence in depth — a bug in the application's tenant-setting logic cannot expose another tenant's data.

## Performance: index the policy predicate

The policy predicate is injected into every query, so it must be indexed just like any other `WHERE` clause:

```sql
CREATE INDEX idx_documents_tenant_id ON documents(tenant_id);
```

```
CREATE INDEX
```

Verify with `EXPLAIN`:

```sql
BEGIN;
SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';
EXPLAIN (ANALYZE, COSTS OFF)
  SELECT * FROM documents
  WHERE tenant_id = current_setting('app.tenant_id')::uuid;
COMMIT;
```

```
                               QUERY PLAN
------------------------------------------------------------------------
 Seq Scan on documents (actual time=0.008..0.010 rows=1 loops=1)
   Filter: (tenant_id = (current_setting('app.tenant_id'::text))::uuid)
   Rows Removed by Filter: 1
 Planning:
   Buffers: shared hit=59
 Planning Time: 0.960 ms
 Execution Time: 0.059 ms
```

The filter shows the policy predicate. With enough rows, the planner will choose an index scan on `idx_documents_tenant_id` instead of a sequential scan.

## Testing that isolation holds

Do not rely on reading policy definitions and assuming they work. Write tests that exercise the boundaries:

1. **Cross-tenant SELECT** returns zero rows.
2. **Cross-tenant UPDATE** affects zero rows.
3. **Cross-tenant INSERT** raises `ERROR: new row violates row-level security policy`.
4. **Tenant reassignment via UPDATE** (changing `tenant_id` to another tenant) is blocked by `WITH CHECK`.
5. **Table owner** (non-superuser) is subject to policies when `FORCE` is enabled.

A simple integration test suite that runs these five scenarios against a real Postgres instance will catch policy regressions far earlier than a production incident.

## Honest limits

RLS is not a complete security model:

- **It is not authentication.** You still need to authenticate users and map them to roles.
- **It is not authorization.** RLS filters rows; it does not grant or revoke table-level privileges. You still need `GRANT`/`REVOKE`.
- **It is not a backup.** A buggy policy that is too permissive will silently over-share data. Test aggressively.
- **Superusers always bypass.** If your application connects as `postgres`, RLS is decorative.
- **Performance cost is real.** Every query gets an extra predicate. Index it.

## When RLS beats app-level `WHERE tenant_id = ?`

Use RLS when:

- Multiple applications or services touch the same database.
- You want the database to enforce isolation even if application code is buggy.
- You have many query paths and cannot guarantee every developer remembers the tenant filter.
- You are building a platform where third-party code runs against your schema.

Stick with application-level filtering when:

- You have a single, well-tested application codebase.
- Your queries are already complex and adding planner-injected predicates makes them harder to optimize.
- You need tenant isolation only for a subset of tables and the overhead of RLS on every table is not worth it.

RLS is a powerful tool, but it is a database-level guarantee — not a substitute for secure application architecture. Use it as one layer in a defence-in-depth strategy, and test it like your data depends on it. Because it does.
