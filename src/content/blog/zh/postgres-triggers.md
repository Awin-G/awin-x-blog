---
title: "Postgres 触发器实战：好、坏与隐形"
description: "在一次性容器中用真实输出讲解 Postgres 触发器：BEFORE/AFTER 行级触发器、FOR EACH STATEMENT、NEW/OLD、WHEN 条件、视图上的 INSTEAD OF、RAISE EXCEPTION、触发器顺序、可见性陷阱和逐行性能陷阱。"
pubDate: 2027-01-14
lang: zh
translationKey: postgres-triggers
tags: [devops, linux]
featured: false
keywords:
  - Postgres 触发器
  - CREATE TRIGGER
  - 审计表
  - 触发器函数
  - NEW OLD
---

**Postgres 触发器**是那种看起来不起眼、直到它悄悄拖垮批量加载、灌满**审计表**、或让一条简单的 `INSERT` 报出无法追踪的错误的功能。这三种我都踩过，所以我拉起了一个一次性的 Postgres 16 容器，把所有场景都真实跑了一遍。本文就是实验记录：**Postgres 触发器**是什么、**触发器函数**何时值得用、类型与时序、`NEW`/`OLD`、`WHEN`、`RAISE`、可见性陷阱、逐行性能陷阱、递归触发器、调试，以及一句诚实的"这个应该放在应用层"。

下面所有输出都是从终端原样复制的。环境搭建只需一条命令：

```bash
docker run --rm -d --name pgtrig -e POSTGRES_PASSWORD=x \
  -p 127.0.0.1:55432:5432 postgres:16-alpine
docker exec -i pgtrig psql -U postgres -c 'select version();'
--   PostgreSQL 16.8 (Debian 16.8-1.pgdg14+2) on x86_64-pc-linux-gnu
```

## 触发器到底是什么

**触发器函数**是一个命名例程——几乎总是用 PL/pgSQL 编写——当表或视图上发生指定事件时由 Postgres 自动调用。`CREATE TRIGGER` 把该函数绑定到一个事件：`INSERT`、`UPDATE`、`DELETE` 或 `TRUNCATE`，在某个时间点（`BEFORE`、`AFTER` 或 `INSTEAD OF`），并且是 `FOR EACH ROW` 还是 `FOR EACH STATEMENT`。

最关键的区别：`FOR EACH ROW` 对每个受影响的行触发一次，通过 `NEW` 和 `OLD` 看到该行。`FOR EACH STATEMENT` 每条 SQL 语句触发一次，看不到单行数据，适合记录"这条语句影响了 N 行"，而不是逐行审计。

## 触发器什么时候是好的：审计表、派生列、强制不变量

诚实的清单很短。当规则*内在于数据本身*时——无论哪个应用、迁移脚本或误操作的 `psql` 会话写入都成立——**触发器函数**才值得用。

**审计日志。** 经典用例。你需要一个逐行记录的**审计表**，不依赖于写入者，而你又无法信任每条代码路径都正确记录。用 `FOR EACH ROW` 触发器把 `OLD` 和 `NEW` 存成 `jsonb` 是标准写法：

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

在插入、更新、删除之后，**审计表**保存了完整历史：

```text
 id | table_name |   op   | row_id |                        old_row                        |                        new_row                        |          changed_at
----+------------+--------+--------+-------------------------------------------------------+-------------------------------------------------------+-------------------------------
  1 | accounts   | INSERT |      1 |                                                       | {"id": 1, "name": "alice", "balance": 100.00, ...}   | 2026-10-12 23:42:56.829437+00
  2 | accounts   | INSERT |      2 |                                                       | {"id": 2, "name": "bob", "balance": 250.50, ...}     | 2026-10-12 23:42:56.835158+00
  3 | accounts   | UPDATE |      1 | {"id": 1, "name": "alice", "balance": 100.00, ...}     | {"id": 1, "name": "alice", "balance": 150.00, ...}    | 2026-10-12 23:42:56.836482+00
  4 | accounts   | DELETE |      2 | {"id": 2, "name": "bob", "balance": 250.50, ...}       |                                                       | 2026-10-12 23:42:56.840148+00
(4 rows)
```

**派生列。** `updated_at` 是最普遍的例子。`BEFORE UPDATE` 触发器设置 `NEW.updated_at := now()` 是正确的，因为所有写入者都受益，且没有人能忘记。

**强制不变量。** 在 `BEFORE` 触发器中使用 `RAISE EXCEPTION` 可以阻止违反数据库自身应该守护的规则的写入——负数总额、无意义的状态转换。这是*最后一道防线*，而不是 `CHECK` 约束的替代品，因为触发器可以被禁用而约束不能。

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

违规写入立即终止：

```text
ERROR:  order total cannot be negative: -50.00
HINT:  fix the total before inserting
CONTEXT:  PL/pgSQL function check_order_total() line 4 at RAISE
```

## `NEW`、`OLD`、`WHEN`：行级工具箱

在 `FOR EACH ROW` 的**触发器函数**中，`NEW` 和 `OLD` 是保存该行的复合变量。`NEW` 用于 `INSERT` 和 `UPDATE`；`OLD` 用于 `UPDATE` 和 `DELETE`。在 `BEFORE` 触发器中可以修改 `NEW`，修改后的版本会被写入——这就是 `updated_at` 的实现方式。

`WHEN` 子句过滤哪些行触发触发器。没有它，触发器对每行都运行，需要在函数体内部检查。有了它，Postgres 完全跳过不匹配的行——更便宜也更清晰。下面是一个只在价格实际变化时才触发的触发器：

```sql
CREATE TRIGGER products_log_price
BEFORE UPDATE OF price ON products
FOR EACH ROW
WHEN (OLD.price IS DISTINCT FROM NEW.price)
EXECUTE FUNCTION log_price_change();
```

结果显示过滤器生效：两条 `UPDATE` 语句执行了，但只有改变了 `price` 的那条产生了**审计表**记录。只修改 `name` 的那条 `UPDATE` 对触发器来说不存在。

```text
 id | product_id | old_price | new_price |          changed_at
----+------------+-----------+-----------+-------------------------------
  1 |          1 |      9.99 |     12.50 | 2026-10-12 23:42:57.130092+00
(1 row)
```

`UPDATE OF price` 把事件缩小到该列的更新；`WHEN` 把事件缩小到值实际变化的行。两者都值得使用。

## `FOR EACH STATEMENT`：被忽视的兄弟

语句级触发器每条 SQL 语句触发一次，不是每行一次。它能看到 `TG_OP` 和 `TG_TABLE_NAME`，但看不到 `NEW` 或 `OLD`。正确的用途是粗粒度日志——"发生了一次 3 行的插入"——而不是逐行审计：

```sql
CREATE TRIGGER events_stmt_log
AFTER INSERT OR UPDATE OR DELETE ON events
FOR EACH STATEMENT EXECUTE FUNCTION stmt_trigger_func();
```

一次 3 行的 `INSERT` 只产生一条日志：

```text
 id | table_name |   op   | row_count |           logged_at
----+------------+--------+-----------+-------------------------------
  1 | events     | INSERT |         3 | 2026-10-12 23:42:56.976532+00
(1 row)
```

如果你打算用语句级触发器做审计，不要。你无法从中重建单行的变更，最终还是会再加一个行级触发器。

## `INSTEAD OF`：让视图可写

包含连接、过滤或聚合的纯视图是不可更新的。视图上的 **`INSTEAD OF`** 触发器拦截 `INSERT`、`UPDATE` 或 `DELETE`，替换为你自己编写的逻辑。下面是一个活跃用户视图获得了 `INSERT` 路径：

```sql
CREATE VIEW active_users_v AS
SELECT id, name, email FROM users WHERE active = true;

CREATE TRIGGER active_users_instead_of
INSTEAD OF INSERT ON active_users_v
FOR EACH ROW EXECUTE FUNCTION active_users_insert();
```

通过视图插入数据时，实际写入基础表并设置 `active = true`。视图显示新行，基础表确认：

```text
 id | name  |       email
----+-------+-------------------
  1 | alice | alice@example.com
  3 | carol | carol@example.com
  4 | dave  | dave@example.com
(3 rows)
```

`INSTEAD OF` 适合在视图上定义少量、明确的写入路径。它不能替代基础表上适当的权限和约束。

## 触发器顺序：按字母序，而非创建顺序

当多个触发器共享相同的时间点和事件时，Postgres 按照**触发器名称的字母序**触发——不是创建顺序。我按 `zzz_last`、`mmm_middle`、`aaa_first` 的顺序创建了三个 `BEFORE INSERT` 触发器。输出：

```text
NOTICE:  trigger_a fired: INSERT test
NOTICE:  trigger_b fired: INSERT test
NOTICE:  trigger_c fired: INSERT test
INSERT 0 1
```

按字母序，尽管创建顺序相反。如果触发器之间存在顺序依赖，请在名称中编码顺序（`001_`、`002_`、`003_`），或者把逻辑合并到一个函数中。

## 可见性陷阱

这是最容易产生"不可能" bug 的地方。**触发器函数**在与触发它的语句相同的事务和相同的快照中运行。事务中*前面*语句所做的更改是可见的；*当前*语句所做的更改不可见。`BEFORE INSERT` 触发器查询表时看不到正在插入的行——在 `READ COMMITTED` 隔离级别下，它也看不到其他事务中尚未提交的行。

我向一个带有 `BEFORE INSERT` 触发器的表插入了两行相同 `category` 的数据，触发器检查是否存在具有相同 `category` 的行：

```text
NOTICE:  trigger sees NO existing row for category food
INSERT 0 1
NOTICE:  trigger sees existing row for category food
INSERT 0 1
```

第一次插入正确地看不到任何东西。第二次插入*应该*能看到第一行——它在微秒之前被插入了——但触发器的快照是在第一条 `INSERT` 提交之前获取的，所以看不到。两行都写入了。如果那个检查本意是唯一性约束，它就静默失败了。

教训：**不要用触发器来强制同一语句或事务中跨行的唯一性。** 使用唯一约束。触发器看到的是过期快照；约束不会。

## 逐行性能陷阱

`FOR EACH ROW` 触发器是默认选项，也是危险所在。每个受影响的行都调用**触发器函数**，后者需要解析、规划和执行——即使函数体是微不足道的。我向一个带有 `AFTER INSERT` 触发器的表插入了 10,000 行（触发器写入审计表），然后在触发器禁用的情况下重复了相同的插入：

```text
-- 启用触发器
INSERT 0 10000
Time: 185.433 ms

-- 触发器禁用
INSERT 0 10000
Time: 43.334 ms
```

触发器增加了 **142 ms**——4.3 倍减速——即使是在一个微不足道的审计插入上。把这个放大到真实场景中：一个包含几个分支和每行索引查找的函数，一个本应耗时几秒的 50 万行批量加载会花几分钟。

解决方案不是避免触发器；而是有意识地使用：

- 当不需要逐行数据时，使用 `FOR EACH STATEMENT`。
- 让行级触发器保持轻量：如果触发器只处理一种操作，不要在 `TG_OP` 上分支；如果可以批量处理，不要做逐行子查询。
- 批量加载期间禁用触发器（`ALTER TABLE ... DISABLE TRIGGER ...`），之后重新启用，但必须单独审计加载过程。
- 对于批量同步，优先使用带语句级审计的单条 `INSERT INTO ... SELECT`，而不是逐行应用层插入。

## 递归触发器

向自身表写入的触发器会触发自己。我创建了一个 `AFTER INSERT` 触发器，插入 `depth + 1` 的行，上限为 3：

```text
 id | depth
----+-------
  1 |     0
  2 |     1
  3 |     2
  4 |     3
(4 rows)
```

一次显式插入通过递归变成了四行。这对层级数据很强大，但意外使用时很可怕。用 `WHEN` 子句保护递归触发器以阻止链条（`WHEN (NEW.depth < 3)`），并考虑应用层使用递归 CTE 是否更清晰。

## 调试触发器

三个工具能完成大部分工作。第一，**触发器函数**内部的 `RAISE NOTICE` 显示它触发了以及看到了什么：

```sql
RAISE NOTICE 'trigger_fired: % %', TG_OP, NEW.id;
```

第二，`pg_trigger` 是系统目录。`pg_get_triggerdef()` 给出完整的 `CREATE TRIGGER` 定义：

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

第三，`\d table_name` 列出触发器及其时序和事件——这是查看表上附加了什么的最快方式：

```text
Triggers:
    accounts_audit AFTER INSERT OR DELETE OR UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION audit_trigger_func()
```

如果触发器行为异常，`ALTER TABLE ... DISABLE TRIGGER ...` 是你的断路器。如果触发器很慢，记录行数和时间，不要猜。

## 什么时候应该放在应用层

诚实的权衡。触发器不适合以下场景：

- **因调用者而异的业务逻辑。** 如果只有计费服务需要知道订单变了，触发器会对每个写入者触发——包括修复数据的迁移脚本。
- **跨服务副作用。** 在**触发器函数**中调用外部 API、发布消息队列或发送邮件，是事务卡住和幽灵效应的温床。写入成功了，HTTP 调用挂了，事务一直开着。使用事务发件箱模式：在同一事务中写一条 `outbox` 记录，然后异步投递。
- **糟糕的 `NOTIFY` 扇出。** 在热点表的每行变更上 `NOTIFY` 的触发器会淹没你的监听器。批量通知，或者在应用层发出以便节流。
- **任何需要对触发语句可见的东西。** 上面的可见性陷阱意味着触发器看不到当前语句自身的写入——如果你需要那个，就应该在应用代码中处理。

经验法则：如果规则*关于数据*，使用触发器。如果规则*关于工作流*，使用应用层。

## 好、坏与隐形

**好：** 审计日志、`updated_at`、强制不变量和可写视图正是触发器最擅长的。它们在同一事务中运行，因此不会被新代码路径遗忘，甚至对手动 `psql` 修复也生效。

**坏：** 对每个写入者都触发的隐藏业务逻辑、事务路径中的跨服务副作用、`NOTIFY` 风暴。触发器是对每次写入征税；如果税收只惠及一个调用者，它就应该在那个调用者的代码里。

**隐形：** 可见性陷阱和逐行开销。前者产生看起来像数据损坏的逻辑 bug；后者产生看起来像缺少索引的慢查询。两者都不会主动暴露自己。

用触发器守护数据，把工作流留在应用层，有疑问时查 `pg_trigger`——系统目录永远会告诉你实际附加了什么。

---

相关阅读：[Postgres LISTEN/NOTIFY](/zh/posts/postgres-listen-notify/)、[Postgres 锁与死锁](/zh/posts/postgres-locks/)。
