---
title: "Postgres 行级安全：由数据库强制执行的多租户隔离"
description: "Postgres RLS 策略如何按租户过滤行、ENABLE 与 FORCE 的区别、USING 与 WITH CHECK、连接池陷阱，以及可复现的真实隔离验证。"
pubDate: 2027-01-24
lang: zh
translationKey: postgres-row-level-security
tags: [devops, security]
featured: false
keywords:
  - Postgres 行级安全
  - RLS
  - CREATE POLICY
  - 多租户
  - current_setting
---

大多数多租户应用在应用层强制执行隔离：每条查询都带上 `WHERE tenant_id = ?` 子句，开发者必须记得添加。忘一次就是跨租户数据泄露。Postgres **行级安全**（RLS）将这一保证移入数据库本身——无论查询是否记得写过滤条件，规划器都会自动注入谓词。

我之前已经写过 [postgres-triggers/](/zh/posts/postgres-triggers/) 和 [postgres-locks/](/zh/posts/postgres-locks/)。RLS 是 Postgres 数据完整性的第三支柱，对于多租户场景往往是正确的工具。

## RLS 到底是什么

在表上启用 RLS 后，Postgres 会为该表附加一个**策略**——一个布尔表达式。每条查询（以非属主、非超级用户角色执行）都会被自动重写，将策略的 `USING` 表达式作为额外过滤器注入。你不需要把它加到 `WHERE` 子句中；规划器会自动完成。

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

关键行是 `USING (tenant_id = current_setting('app.tenant_id')::uuid)`。`current_setting` 函数读取一个会话变量——由应用在每个请求中设置——规划器在查询期间将其视为常量。

## 设置租户：`SET LOCAL` vs `SET`

在事务内部，使用 `SET LOCAL` 让变量在 commit/rollback 时自动清除：

```sql
BEGIN;
SET LOCAL app.tenant_id = '11111111-1111-1111-1111-111111111111';
SELECT count(*) FROM documents;  -- 只能看到 alpha 的行
COMMIT;
```

在事务块外使用普通 `SET` 是**连接池陷阱**。如果你通过 PgBouncer 以事务模式共享连接，`SET`（或显式事务中因连接被池化而丢失的 `SET LOCAL`）可能泄漏到下一个获得该连接的租户。安全模式是：

- **事务池化**：始终在显式事务内使用 `SET LOCAL`，或使用 PgBouncer 的 `server_reset_query`。
- **会话池化**：`SET` 是可接受的，但你仍须谨慎处理连接复用。

该变量不需要存在于 `postgresql.conf` 中。在设置之前，`current_setting('app.tenant_id')` 返回空字符串，策略对所有行 simplemente 求值为 false。

## 隔离证明：两个租户，真实输出

让我证明它有效。我启动一个一次性 Postgres 16 容器，创建两个非超级用户角色，然后测试：

```sql
CREATE ROLE alpha_app LOGIN PASSWORD 'alpha_pass';
CREATE ROLE beta_app LOGIN PASSWORD 'beta_pass';
GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO alpha_app, beta_app;
```

Alpha 租户查询：

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

Beta 租户查询：

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

每个租户只看到一行。现在进行关键测试——跨租户写入尝试：

Alpha 尝试更新 Beta 的行：

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

零行受影响。`USING` 子句隐藏了目标行，因此 `WHERE` 子句永远不会匹配它。

Alpha 尝试插入 Beta 拥有的行：

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

`WITH CHECK` 子句拒绝了它。这就是区别所在：`USING` 过滤你能看到和修改哪些行；`WITH CHECK` 在写入前验证新行或更新后的行是否符合策略。

## USING vs WITH CHECK

| 子句 | 适用操作 | 用途 |
|------|---------|------|
| `USING` | `SELECT`、`UPDATE`、`DELETE` | 过滤查询中可见的现有行 |
| `WITH CHECK` | `INSERT`、`UPDATE` | 写入前验证新行的值 |

`UPDATE` 必须同时满足两个条件：现有行必须通过 `USING`（以便你能找到它），新行必须通过 `WITH CHECK`（以便你不能将其重新分配给另一个租户）。

## FORCE ROW LEVEL SECURITY 与 BYPASSRLS 陷阱

默认情况下，**表属主**和**超级用户**完全绕过 RLS。这对迁移很方便，但如果应用以属主身份连接则很危险。

```sql
-- 检查 RLS 状态
SELECT current_user,
       (SELECT relrowsecurity FROM pg_class WHERE relname = 'documents') AS rls_enabled,
       (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'documents') AS rls_forced;
```

```
 current_user | rls_enabled | rls_forced
--------------+-------------+------------
 postgres     | t           | f
```

`FORCE ROW LEVEL SECURITY` 封堵了属主漏洞——但**不能**封堵超级用户漏洞：

```sql
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
```

```
ALTER TABLE
```

现在表属主也受策略约束。但 `postgres` 超级用户仍然绕过：

```sql
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'postgres';
```

```
  rolname  | rolbypassrls
-----------+--------------
 postgres  | t
```

任何具有 `BYPASSRLS` 属性的角色也会绕过即使 `FORCE` 设置：

```sql
CREATE ROLE auditor BYPASSRLS;
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'auditor';
```

```
  rolname  | rolbypassrls
---------+--------------
 auditor  | t
```

**最佳实践**：应用角色永远不应是超级用户，永远不应拥有它们查询的表，永远不应具有 `BYPASSRLS`。使用一个独立的迁移角色来拥有架构但不处理运行时查询。

## 使用 `TO role` 的策略

你可以将策略限定到特定角色：

```sql
CREATE POLICY alpha_only_policy ON documents
    FOR SELECT
    TO alpha_app
    USING (tenant_id = '11111111-1111-1111-1111-111111111111');
```

```
CREATE POLICY
```

这添加了一个额外约束：即使 `app.tenant_id` 被设置为其他值，`alpha_app` 也只能看到 Alpha 的行。纵深防御——应用设置租户逻辑中的 bug 无法暴露其他租户的数据。

## 性能：为策略谓词建立索引

策略谓词被注入到每条查询中，因此它必须像任何其他 `WHERE` 子句一样被索引：

```sql
CREATE INDEX idx_documents_tenant_id ON documents(tenant_id);
```

```
CREATE INDEX
```

用 `EXPLAIN` 验证：

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

过滤器显示了策略谓词。当数据量足够大时，规划器会选择 `idx_documents_tenant_id` 的索引扫描而非顺序扫描。

## 验证隔离确实生效

不要依赖阅读策略定义并假设它们有效。编写测试来验证边界：

1. **跨租户 SELECT** 返回零行。
2. **跨租户 UPDATE** 影响零行。
3. **跨租户 INSERT** 抛出 `ERROR: new row violates row-level security policy`。
4. **通过 UPDATE 重新分配租户**（将 `tenant_id` 改为另一个租户）被 `WITH CHECK` 阻止。
5. **表属主**（非超级用户）在启用 `FORCE` 时受策略约束。

一个针对真实 Postgres 实例运行这五个场景的简单集成测试套件，将比生产事故更早发现策略回归。

## 诚实的局限

RLS 不是完整的安全模型：

- **它不是认证。** 你仍然需要认证用户并将其映射到角色。
- **它不是授权。** RLS 过滤行；它不授予或吊销表级权限。你仍然需要 `GRANT`/`REVOKE`。
- **它不是备份。** 过于宽松的策略会静默地过度共享数据。积极测试。
- **超级用户始终绕过。** 如果你的应用以 `postgres` 连接，RLS 形同虚设。
- **性能开销是真实的。** 每条查询都会多一个谓词。为它建立索引。

## 何时 RLS 优于应用层 `WHERE tenant_id = ?`

在以下情况使用 RLS：

- 多个应用或服务访问同一数据库。
- 你希望数据库强制执行隔离，即使应用代码有 bug。
- 你有很多查询路径，无法保证每个开发者都记得租户过滤器。
- 你正在构建一个第三方代码针对你 schema 运行的平台。

在以下情况坚持应用层过滤：

- 你有一个单一、经过良好测试的应用代码库。
- 你的查询已经很复杂，添加规划器注入的谓词使它们更难优化。
- 你只需要对部分表进行租户隔离，在每张表上承担 RLS 的开销不值得。

RLS 是一个强大的工具，但它是数据库级别的保证——不是安全应用架构的替代。将其用作纵深防御策略中的一层，并像你的数据依赖它一样测试它。因为它确实如此。
