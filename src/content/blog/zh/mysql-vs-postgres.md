---
title: "MySQL vs PostgreSQL：真正会坑到你的那些实际差异"
description: "两者都很优秀，所以真正的差异落在默认值、类型和 SQL 方言上。这篇用一次性的 MySQL 8.4 与 PostgreSQL 17 容器跑出的真实输出，讲清隔离级别、NULL 与布尔类型的差异、标识符大小写、ON CONFLICT vs ON DUPLICATE KEY、RETURNING、jsonb、数组与范围类型，并给出一份决策清单。"
pubDate: 2026-12-11
lang: zh
translationKey: mysql-vs-postgres
tags: [devops, linux]
featured: false
keywords:
  - MySQL vs PostgreSQL
  - Postgres vs MySQL
  - ON CONFLICT vs ON DUPLICATE KEY
  - jsonb
  - 隔离级别
---

**MySQL vs PostgreSQL** 这类比较，通常以口水战收场，其实该以一张清单收场。两者都是成熟、开源、满足 ACID 的关系型数据库，都能让一个普通应用舒舒服服跑上好几年。日常工作中真正重要的差异，几乎从来不在于原始性能——而在于默认值、类型和 SQL 方言，而且它们会悄悄咬你，在你上线几周之后。这篇是务实版本，全部基于真实输出：我同时跑了一次性的 MySQL 8.4.11 和 PostgreSQL 17.11 容器，拿同样的问题去问两边，所以下面每一条行为你都能复现，而不是我无法自证的一次跑分。

## 两者都很优秀——选型通常取决于生态与运维

我见过的每一场 **Postgres vs MySQL** 争论，最后都会变成两个人在捍卫自己已经熟悉的那一个。这没什么用。两者都有真正的复制、真正的备份工具，以及比你手写 hint 更聪明的查询计划器。对一个普通的 Web 应用来说，选哪个都行。

老实的说法是：原始性能几乎从不是决定因素。真正起决定作用的通常是：

- **生态是否契合。** 你已经在用的语言、ORM 和托管平台。在 PlanetScale/Vitess 或托管的 RDS 集群上，MySQL 是原生的。如果你需要 PostGIS、pgvector 或 TimescaleDB，那答案就是 Postgres，MySQL 直接出局。
- **你的运维团队能驾驭什么。** 一套你已经做过故障切换的、无聊的 MySQL 副本集，胜过一套你在凌晨三点从没切过的 Postgres。
- **你具体需要哪些特性。** 真正的布尔类型、数组、范围类型、严格类型，以及可索引的二进制 JSON 类型，是 Postgres。通过 MySQL 复制生态获得极其廉价的读扩展，是 MySQL。

所以这不是一篇「谁赢了」的文章，而是一份会真实花掉你一下午的差异清单——让你意外的默认值、需要重写的方言，以及会悄悄改变结果的语义。

## 这些输出是怎么来的

两个容器，事后删掉，不做任何跑分声明：

```bash
docker run -d --name m -e MYSQL_ROOT_PASSWORD=x -p 127.0.0.1:13306:3306 mysql:8.4
docker run -d --name p -e POSTGRES_PASSWORD=x -p 127.0.0.1:15432:5432 postgres:17
```

下面每一条语句都是打在这两台服务器上的。行数故意很小，因为脱离你的 schema、硬件和查询组合的跑分，都是民间传说。

## 隔离级别：REPEATABLE READ 与 READ COMMITTED 是第一口真咬

分别问两边要默认值：

```sql
-- MySQL 8.4
SELECT @@transaction_isolation;
+-------------------------+
| @@transaction_isolation |
+-------------------------+
| REPEATABLE-READ         |
+-------------------------+

-- PostgreSQL 17
SHOW default_transaction_isolation;
 default_transaction_isolation
-------------------------------
 read committed
(1 row)
```

这不是冷知识。MySQL 的默认**隔离级别**是 REPEATABLE READ（走 InnoDB 的一致性快照）：在一个事务里，每一次普通 `SELECT` 看到的都是同一个被冻结的视图，哪怕期间别的事务提交了。Postgres 的默认值则是 READ COMMITTED：每条语句都取一个*新的*快照，所以同一事务里再次读取，会看到在它开始之后才提交的行。我用两个会话加 `SLEEP(3)` 验证了这一点。

```sql
-- MySQL REPEATABLE READ：快照被冻结
first_read | second_read | after_commit
       3   |      3      |      103        -- 并发的 UPDATE 在事务中途提交为 103
```

```sql
-- PostgreSQL READ COMMITTED：每条语句重新取快照
first_read | second_read | after_commit
       2   |     102     |      102        -- 同一个并发 UPDATE，在第二次读取时被看到
```

<figure>
<svg viewBox="0 0 680 250" width="100%" role="img" aria-label="时间线对比。在 MySQL 的 REPEATABLE READ 下，事务读到 3，一个并发 UPDATE 提交为 103，而同一事务仍然读到 3。在 PostgreSQL 的 READ COMMITTED 下，事务读到 2，UPDATE 提交为 102，下一次读取返回 102。">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <text x="20" y="24" font-weight="600" font-size="14">同一事务，两次读取，一次并发 UPDATE</text>

    <!-- MySQL -->
    <text x="20" y="72" font-size="12" font-weight="600">MySQL · REPEATABLE READ</text>
    <line x1="20" y1="96" x2="640" y2="96" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
    <circle cx="60" cy="96" r="6" fill="currentColor"/>
    <text x="60" y="120" font-size="11" text-anchor="middle">read = 3</text>
    <circle cx="300" cy="96" r="6" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="300" y="120" font-size="11" text-anchor="middle">UPDATE → 103</text>
    <text x="300" y="82" font-size="10" text-anchor="middle" opacity="0.7">（另一事务提交）</text>
    <circle cx="560" cy="96" r="6" fill="currentColor"/>
    <text x="560" y="120" font-size="11" text-anchor="middle">read = 3</text>
    <text x="560" y="140" font-size="10" text-anchor="middle" opacity="0.75">冻结——快照保持不变</text>

    <!-- Postgres -->
    <text x="20" y="184" font-size="12" font-weight="600">PostgreSQL · READ COMMITTED</text>
    <line x1="20" y1="208" x2="640" y2="208" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
    <circle cx="60" cy="208" r="6" fill="currentColor"/>
    <text x="60" y="232" font-size="11" text-anchor="middle">read = 2</text>
    <circle cx="300" cy="208" r="6" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="300" y="232" font-size="11" text-anchor="middle">UPDATE → 102</text>
    <circle cx="560" cy="208" r="6" fill="currentColor"/>
    <text x="560" y="232" font-size="11" text-anchor="middle">read = 102</text>
    <text x="560" y="252" font-size="10" text-anchor="middle" opacity="0.75">新鲜——重新取快照</text>
  </g>
</svg>
<figcaption>两个默认值都不算错，但它们改变了「读一次再读一次」的含义。依赖稳定快照的代码（报表、导出任务、读改写）在迁移之后行为会不一样。</figcaption>
</figure>

实际后果是：依赖稳定可重复读的代码——比如一次读多张表并期望它们彼此一致的报表——在 MySQL 上会「碰巧」正确，在 Postgres 上则需要 `BEGIN ISOLATION LEVEL REPEATABLE READ`（或 `SERIALIZABLE`）。而期望「再次读取能看到新数据」的代码，在 Postgres 上碰巧正确，在 MySQL 上则会读到旧值。两者都不是 bug，只是默认值不同。

## NULL、空字符串与布尔：宽松与严格

两个引擎都把 `NULL` 和 `''` 当作不同的值，这正是你想要的。不过在 Linux 上，MySQL 默认开着 SQL-mode 的严格模式（`STRICT_TRANS_TABLES`），所以真正分道扬镳的地方是*类型*，不是 NULL。

```sql
-- MySQL：BOOLEAN 其实只是 TINYINT(1)
SELECT TRUE AS t, FALSE AS f, TRUE + TRUE AS t_plus_t, (2 = 2) AS cmp;
+---+---+----------+-----+
| t | f | t_plus_t | cmp |
+---+---+----------+-----+
| 1 | 0 |        2 |   1 |
+---+---+----------+-----+
-- 它还会让别的整数塞进那个「布尔」列：
INSERT INTO t_null (id, active) VALUES (3, 3);
SELECT active FROM t_null WHERE id = 3;  -- 3
```

```sql
-- PostgreSQL：boolean 是真正的类型
SELECT 'yes'::boolean, 't'::boolean, 'on'::boolean;   -- t | t | t
INSERT INTO t_null (id, active) VALUES (5, '3');
ERROR:  invalid input syntax for type boolean: "3"
```

这就是差异的整体「味道」。MySQL 的 `BOOLEAN` 只是 `TINYINT(1)` 的语法糖；一个「为真」的列可以存 `3`。Postgres 会拒绝胡来的值，同时也接受你意料之中的布尔字面量（`yes`、`on`、`t`）。如果你依赖 `WHERE active = 1` 表示「真」，MySQL 会纵容你一辈子；Postgres 则会逼你写成 `WHERE active IS TRUE`。

## 标识符大小写与排序规则：悄悄匹配到错误行的 WHERE

这里藏着两个不同的意外。第一是**标识符大小写**。Postgres 会把不带引号的标识符折叠成小写，所以 `Customers`、`CUSTOMERS`、`customers` 都是同一张表。而在 Linux 上（`lower_case_table_names = 0`），MySQL 把表名当作大小写*敏感*的，在 macOS、Windows、Linux 之间来回的代码检出，正是因为这个原因经常「人肉爆炸」。

```sql
-- MySQL：以 "Customers" 创建；下面这句会失败
SELECT * FROM CUSTOMERS;
ERROR 1146 (42S02): Table 'shop.CUSTOMERS' doesn't exist
-- 而 "customers" 会是另一张*不同的*表

-- PostgreSQL：三个名字都指向同一张小写表
SELECT id, name FROM CUSTOMERS;   -- 成功
SELECT id, name FROM customers;   -- 成功
```

第二点要危险得多：**默认的字符串比较**。MySQL 的默认排序规则是大小写不敏感的（`utf8mb4_0900_ai_ci`），所以 `'a' = 'A'` 为真，`WHERE name = 'X'` 会匹配到 `'x'`。Postgres 默认大小写敏感，只能用 `ILIKE`，或者建 `citext`／小写索引才能匹配。

```sql
-- MySQL
SELECT 'a' = 'A' AS eq;                      -- 1
SELECT COUNT(*) FROM t_null WHERE name = 'X'; -- 1  （匹配到了 'x'）

-- PostgreSQL
SELECT 'a' = 'A' AS eq, 'a' ILIKE 'A' AS ilike;  -- f | t
SELECT COUNT(*) FROM t_null WHERE name = 'X';     -- 0
```

把一个 MySQL 应用迁到 Postgres 而没注意到这点，大小写不敏感的查找就会变成「用户不存在」的 bug；反过来把 Postgres 迁到 MySQL，一个 email 唯一约束可能就变成去重噩梦。挑一种，明确写下来（`citext` 列，或者在 `lower(email)` 上建函数唯一索引），并写进文档。

## Upsert：ON CONFLICT vs ON DUPLICATE KEY，以及缺失的 RETURNING

Upsert 几乎是每个 ORM 都会撞上的方言差异。Postgres 写作 `INSERT ... ON CONFLICT`，MySQL 写作 `INSERT ... ON DUPLICATE KEY UPDATE`。

```sql
-- MySQL
INSERT INTO counters (name, hits) VALUES ('pageviews', 1)
  ON DUPLICATE KEY UPDATE hits = hits + 1;
```

```sql
-- PostgreSQL
INSERT INTO counters (name, hits) VALUES ('pageviews', 1)
  ON CONFLICT (name) DO UPDATE SET hits = counters.hits + 1
  RETURNING name, hits;

  name    | hits
----------+------
 pageviews |    2
(1 row)
```

除了写法，还有两个真实差异：

1. **`ON CONFLICT` 要点名冲突目标**——`(name)`——所以你能选择由哪个唯一索引来吸收这次冲突。`ON DUPLICATE KEY UPDATE` 会在这张表*任意*唯一键上触发，这就是为什么一张带三个唯一约束的表，可能以出人意料的方式更新到「错的那个」。
2. **`ON CONFLICT` 能返回，MySQL 不能。** Postgres 的 `RETURNING` 能在同一次往返里把写入的行还给你，而且对 `INSERT`、`UPDATE`、`DELETE` 都有效。这是我在用 MySQL 时最想念的一点。

MySQL 完全没有 `RETURNING`——它是硬语法错误——所以你只能模拟。常见的技巧是用 `LAST_INSERT_ID()` 把值偷渡出来，但注意这条边有多锋利：走 update 分支时你必须自己设置它，而且它一次只带一个整数。

```sql
-- MySQL 模拟 RETURNING
INSERT INTO counters (name, hits) VALUES ('pageviews', 1)
  ON DUPLICATE KEY UPDATE hits = LAST_INSERT_ID(hits + 1);
SELECT LAST_INSERT_ID() AS returned_hits;   -- 3

INSERT INTO counters (name, hits) VALUES ('pageviews', 1) RETURNING name, hits;
ERROR 1064 (42000): You have an error in your SQL syntax ... near 'RETURNING name, hits'
```

对于必须返回每一行新状态的多行 upsert，MySQL 会把你逼进一个事务：先 upsert，再单独 `SELECT`。Postgres 一条语句搞定。（MariaDB 确实实现了 `RETURNING`；只有 MySQL 本尊没有。）

## Postgres vs MySQL 的类型对比：jsonb、数组、枚举、范围

这一节里 Postgres 客观领先，也通常是人们选它的真正原因。

**JSON。** MySQL 有 `JSON` 类型，而且是动真格的——它会做归一化和校验。Postgres 两者都有：`json`（原始文本，连相等运算符都没有）和 `jsonb`（解析过、规范化、可索引）。`jsonb` 的差异不是装饰性的：

```sql
-- PostgreSQL：jsonb 会归一化并支持比较；json 连相等运算都没有
SELECT '{"b":1,"a":2}'::jsonb;      -- {"a": 2, "b": 1}
SELECT '{"b":1,"a":2}'::jsonb = '{"a":2,"b":1}'::jsonb;  -- t
SELECT '{"b":1,"a":2}'::json   = '{"a":2,"b":1}'::json;  -- ERROR: operator does not exist: json = json
SELECT '{"a":1,"b":2}'::jsonb @> '{"a":1}'::jsonb;       -- t  （包含）
-- 而且可以直接建索引：
CREATE INDEX ON evt USING gin (payload);
```

```sql
-- MySQL：JSON 能用，但你不能给这一列建索引——只能给生成的路径
CREATE INDEX idx_evt_payload ON evt (payload);
ERROR 3152 (42000): JSON column 'payload' supports indexing only via generated columns
                      on a specified JSON path.
-- 变通做法：
ALTER TABLE evt ADD COLUMN kind VARCHAR(32)
  GENERATED ALWAYS AS (payload->>'$.kind') STORED;
CREATE INDEX idx_evt_kind ON evt (kind);
```

所以「有没有 JSON」是错的问题——两边都有。「我能不能给 JSON 字段建索引、能不能廉价地做包含查询」才是对的，而那是 `jsonb`。

**数组、范围、枚举。** Postgres 三者都是一等类型；MySQL 前两个都没有，第三个则是个怪异版本。

```sql
-- PostgreSQL
SELECT ARRAY[1,2,3] @> ARRAY[2] AS contains, 2 = ANY(ARRAY[1,2,3]) AS any_hit;   -- t | t
SELECT daterange('2026-01-01','2026-02-01') && daterange('2026-01-15','2026-03-01');  -- t
CREATE TYPE mood AS ENUM ('sad','ok','happy');
SELECT 'ok'::mood < 'happy'::mood;   -- t  （枚举按定义顺序排序）
```

```sql
-- MySQL
SELECT ARRAY[1,2,3];
ERROR 1064 (42000): ... near '[1,2,3]'
SELECT daterange('2026-01-01','2026-02-01');
ERROR 1305 (42000): FUNCTION shop.daterange does not exist
```

MySQL 的 `ENUM` 存在，但值得点名，因为它是个坑：它内部按整数位置存储，所以排序遵循*定义顺序*而非字母顺序，而且往中间插入一个值会重新编号。

```sql
-- MySQL：枚举按内部索引排序，而不是按值
SELECT id, mood, mood+0 AS internal_index FROM tasks ORDER BY mood;
| 2 | sad   | 1 |
| 1 | ok    | 2 |
| 3 | happy | 3 |
```

Postgres 的枚举是带真实顺序的真类型，并且 `ALTER TYPE ... ADD VALUE` 是安全的。如果你的领域有一套固定词汇表，这就是一个不小的差异。

## 窗口函数与 CTE：差距基本已经补上

说点好话：这已经不是区分因素了。从 MySQL 8.0 起，两个引擎都支持窗口函数和递归 CTE，语法实质上完全一致。

```sql
-- 同一条查询，两个引擎
SELECT name, dept, salary,
       RANK() OVER (PARTITION BY dept ORDER BY salary DESC) AS rnk
FROM ...;
-- ann | eng | 120 | 1
-- bob | eng |  90 | 2
-- cid | ops | 100 | 1
```

如果你还在 MySQL 5.7，升级吧——光这一条就值。剩下的边角差异很小：Postgres 允许你强制物化 CTE（`WITH x AS MATERIALIZED`），这是一个 MySQL 计划器不对外暴露的调优杠杆。如果你刚接触读查询计划，我另一篇讲[怎么读 Postgres 的 EXPLAIN 输出](/zh/posts/postgres-explain/)的文章，会带你走一遍这里遇到的同类查询形态；而那些 index lookup 背后的最左前缀规则，两个引擎是相同的，这正是[数据库索引基础](/zh/posts/database-indexing/)的主题。

## 扩展、工具链与复制生态

两个截然不同的生态，而决策中「系统层面」的那一半就住在这里。

- **Postgres：扩展是护城河。** `CREATE EXTENSION` 让你在同一个事务型数据库里拿到 PostGIS、pgvector、TimescaleDB、`pg_stat_statements`、`pg_trgm`、`hstore` 等等。如果你的路线图里有地理空间、向量检索或时序，这一个理由就够了。
- **MySQL：复制是护城河。** 围绕 MySQL 复制的生态——Vitess、PlanetScale、ProxySQL、组复制，以及读副本扇出的成熟度——更深，而且把读扩展铺到很宽确实更便宜。以逻辑复制为先的工具文化（binlog CDC 进 Kafka 之类）在这里也最强。

纯工具层面两边很接近：MySQL 这边有 `mysqldump`/`mysqlsh`、`mysqlpump` 和 MySQL Enterprise Backup；Postgres 那边有 `pg_dump`/`pg_restore`、`pg_basebackup` 和 `pgBackRest`。两边都有出色的托管产品，谁都不缺。

## 运维故事：备份、升级、故障切换

老实说，在高层次上这两者是可以类比的，差异更多是文化上的：

- **备份。** 逻辑备份（`pg_dump`、`mysqldump`）和物理备份（WAL 归档 / `pg_basebackup` 对 InnoDB redo/binlog）两边都有。Postgres 基于 WAL 归档的时间点恢复（PITR）是范本；MySQL 基于 binlog 的 PITR 同样真实。但无论哪边，救你命的是*演练过的恢复*，这也是我写[真正能恢复的备份](/zh/posts/backups-you-can-restore/)而不是写 dump 命令的原因。
- **升级。** MySQL 8.x 的升级路径很好走，原地小版本升级是常规操作。Postgres 历史上更倾向于让你用 `pg_upgrade`（link/copy 模式，或者更慢的 dump-reload），大版本升级需要一个正经计划。现在两边都提供逻辑复制作为低停机迁移路径。
- **故障切换。** 托管和自管理两边都有答案——Postgres 这边是 Patroni/etcd、repmgr 或托管集群；MySQL 这边是 Group Replication/InnoDB Cluster、orchestrator 或托管集群。老实的重点不是哪个更好，而是你的团队演练过哪个。

## 那到底选哪个？一份决策清单

别再问哪个数据库更快了，按顺序问这些：

1. **你需要某个 Postgres 扩展吗？** PostGIS、pgvector、TimescaleDB——如果是，选 Postgres，到此为止。
2. **你需要一个可索引、能做包含查询的 JSON 文档字段吗？** Postgres `jsonb`。MySQL 也能，但只能通过生成列。
3. **你需要数组、范围或严格布尔吗？** Postgres。MySQL 的 `ENUM`／`BOOLEAN` 怪癖是你迟早要交的税。
4. **你是否已经在托管的 MySQL 上，且有一套你信任的副本拓扑？** 那就留下——除非 1–3 中有一条成立。
5. **你团队的运维经验是否一边倒？** 选那个无聊、熟悉、顺手的。故障切换是人的问题，不是数据库特性的问题。
6. **你只是在交付一个小应用，只想要简单？** 哪个都行。如果真的很小，[SQLite 往往就够了](/zh/posts/sqlite-is-enough/)，整个决定都可以往后放。

结论很无聊：**MySQL vs PostgreSQL** 很少是能力问题，几乎总是匹配度问题。了解默认值，了解方言，然后选那个你团队能在凌晨三点开起来的那一个。真正会咬人的地方，不是选了「错」的引擎，而是不知道 MySQL 的默认是 REPEATABLE READ、它的比较是大小写不敏感的、而 `RETURNING` 是 Postgres 独有的奢侈。
