---
title: "sqlite3 CLI 实战手册：不需要服务器的数据库"
description: "上手 sqlite3 CLI：打开数据库、掌握 dot 命令、导入导出 CSV、用 -line/-json/-csv 跑一次性 sqlite 命令、用 .read 写脚本、用 .backup（而不是 cp）做安全的 sqlite 备份、用 sqlite pragma 设置 WAL 与外键、读懂 EXPLAIN QUERY PLAN，并 ATTACH 多个数据库。"
pubDate: 2026-12-04
lang: zh
translationKey: sqlite-cli-cookbook
tags: [devops, linux]
featured: false
keywords:
  - sqlite3 CLI
  - sqlite 命令
  - sqlite 备份
  - sqlite pragma
  - WAL
---

大多数人都是通过某个应用里的驱动认识 SQLite 的，从来没有直接碰过 **sqlite3 CLI**。这很可惜，因为这个 shell 就是「整个数据库装在一个二进制里」：建一个文件、在上面跑 **sqlite 命令**、导入 CSV、做一次 **sqlite 备份**、看一眼查询计划，全程不需要装服务器、也不需要开端口。我每周都用它干真活——翻应用数据库、转换导出文件、上线前确认一条 **sqlite pragma**。这就是我当时想要的那本手册：真正重要的那些 **dot 命令**，配上真实的终端输出，全部在 SQLite 3.53.4 上跑出来。下面每段输出都来自一个临时数据库，不是修饰过的示意图。

整个会话就在一个临时目录里完成：

```bash
mkdir -p /tmp/opencode/work/sqlite-cookbook
cd /tmp/opencode/work/sqlite-cookbook
sqlite3 shop.db
```

最后那条命令会打开 `shop.db`，不存在就创建。当提示符变成 `sqlite>`，你就进入了 shell。用 `.quit` 或 Ctrl-D 退出。

## 用 sqlite3 CLI 打开数据库，以及你会长期使用的那些 dot 命令

**dot 命令**是 CLI 自带的一套小语言：以点开头、不用分号，专门回答那些你本来得写 SQL 才能问的问题。用得最频繁的四个是 `.tables`、`.schema`、`.mode` 和 `.headers`。

先载入一个小的商店 schema，开启 WAL，看看手里有什么：

```bash
sqlite3 shop.db <<'SQL'
PRAGMA journal_mode = WAL;
CREATE TABLE customers (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  email   TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL DEFAULT 'US'
);
CREATE TABLE orders (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  total_cents INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_orders_customer ON orders(customer_id);
SQL
```

`.tables` 列出所有表；`.schema` 打印能把它们重建出来的 DDL。注意 `.schema orders` 连该表上的索引一起显示了：

```sql
sqlite> .tables
customers     orders

sqlite> .schema orders
CREATE TABLE orders (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  total_cents INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_orders_customer ON orders(customer_id);
```

`.mode` 选输出格式，`.headers` 决定要不要打印列名。交互时最好看的默认值是 `box`：

```sql
sqlite> .headers on
sqlite> .mode box
sqlite> SELECT id, name, country FROM customers ORDER BY id;
╭────┬────────────────┬─────────╮
│ id │      name      │ country │
╞════╪════════════════╪═════════╡
│  1 │ Ada Lovelace   │ UK      │
│  2 │ Grace Hopper   │ US      │
│  3 │ Alan Turing    │ UK      │
│  4 │ Barbara Liskov │ US      │
╰────┴────────────────┴─────────╯
```

其他模式在脚本里各有用途：`column`、`list`、`csv`、`json`、`insert`。把其中任何一个写进家目录的 `.sqliterc`，每次启动就会自动生效。

## 用 .import 导入 CSV，以及那个列数陷阱

`.import FILE TABLE` 把 CSV 读进一张表；如果表不存在，就用表头那一行来建表。陷阱在于：如果表**已经存在**，`.import` 会去填它的**所有**列——所以一个四列的文件不能直接塞进五列的表。把一个四列文件喂给 `orders`，SQLite 会清清楚楚地告诉你哪里错了：

```sql
sqlite> .mode csv
sqlite> .import new_orders.csv orders
new_orders.csv:1: expected 5 columns but found 4 - filling the rest with NULL
new_orders.csv:1: INSERT failed: datatype mismatch
new_orders.csv:2: expected 5 columns but found 4 - filling the rest with NULL
new_orders.csv:2: INSERT failed: NOT NULL constraint failed: orders.created_at
...
```

那些行是被拒绝的，不是被悄悄弄坏的——但正确的做法是先把它导入一张与文件列数一致的临时表，再用 SQL 把数据搬过去。从 SQLite 3.32 起，`.import --csv --skip 1` 会跳过表头，免得它落进你的数据里：

```sql
sqlite> CREATE TEMP TABLE staging(customer_id INTEGER,total_cents INTEGER,status TEXT,created_at TEXT);
sqlite> .import --csv --skip 1 new_orders.csv staging
sqlite> SELECT count(*) AS staged FROM staging;
3
sqlite> INSERT INTO orders (customer_id,total_cents,status,created_at)
   ...>   SELECT customer_id,total_cents,status,created_at FROM staging;
sqlite> SELECT count(*) AS orders_now FROM orders;
9
```

先落临时表让你有机会在数据碰到真表之前做校验，这个价值远超它多花的两行。

## 从 shell 直接查询：一次性 sqlite 命令，-line、-json、-csv

一次性查询很少需要进交互提示符。shell 提供了一些标志直接帮你设好模式，这正是它作为脚本工具好用的原因：

```bash
sqlite3 -line shop.db "SELECT id,status,total_cents FROM orders WHERE status='paid' ORDER BY total_cents DESC LIMIT 2;"
         id: 4
     status: paid
total_cents: 78000

         id: 2
     status: paid
total_cents: 12500

sqlite3 -json shop.db "SELECT name,country FROM customers ORDER BY id LIMIT 2;"
[{"name":"Ada Lovelace","country":"UK"},
{"name":"Grace Hopper","country":"US"}]

sqlite3 -csv -header shop.db "SELECT id,name FROM customers ORDER BY id LIMIT 2;"
id,name
1,"Ada Lovelace"
2,"Grace Hopper"
```

`-line` 用来读，`-json` 用来管进 `jq`，`-csv` 用来喂电子表格和其他工具。三者都可以加 `-header`。超过一条语句的查询，就用 heredoc 或文件传进去——shell 会按顺序执行，遇到错误就停。

## sqlite 备份：.backup、.dump，以及为什么 cp 对活库会翻车

这一节值得纹在手臂上。在 WAL 模式下，已提交的事务会待在 `-wal` 文件里，直到某次 checkpoint 把它们折回主文件。只复制主文件，你复制到的就是一个缺数据的数据库——甚至缺整个 schema。我开了一个保持不关的连接、写入 5000 行，然后在连接仍然打开时用两种方式各复制了一份：

```bash
$ ls -l live.db live.db-wal
-rw-r--r-- 1 me me   4096 Dec  4 11:20 live.db
-rw-r--r-- 1 me me  98912 Dec  4 11:20 live.db-wal

$ cp live.db torn.db                  # 错：忽略了 -wal 文件
$ sqlite3 live.db ".backup good.db"   # 对：在线备份
$ sqlite3 torn.db "SELECT count(*) FROM events;"
Error: no such table: events
$ sqlite3 good.db "SELECT count(*) FROM events;"
5000
```

那份 `cp` 出来的副本只有 4 KB 的、没有 schema 的主文件；真正的数据还在日志里，副本里连 `events` 表都没有。而一次恰好赶上 checkpoint 的 `cp` 看起来完全正常——那才是最危险的。`.backup` 用的是 SQLite 的在线备份 API：在数据库被写入的同时取一份一致的快照，对活文件是安全的。

```bash
# 对运行中的数据库取一致快照
sqlite3 /var/lib/app/app.db ".backup '/srv/backup/app.db'"

# 信任它之前，永远先验证
sqlite3 /srv/backup/app.db "PRAGMA integrity_check;"
```

`.dump` 是另一件工具，性质不同。它把 schema 和每一行都导出成 SQL 文本，所以特别适合把一个小数据库纳入版本控制，或者在机器之间搬运：

```bash
$ sqlite3 shop.db ".dump" | head -3
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE customers (
...
$ sqlite3 shop.db ".dump" > shop.sql
$ sqlite3 reloaded.db < shop.sql
$ sqlite3 reloaded.db "SELECT count(*) FROM orders;"
9
```

要做二进制的、能直接顶替的副本，用 `.backup`；想要一个能 diff 的文本产物，用 `.dump`。同样因为 `cp` 不安全，对**运行中**的 WAL 数据库做文件系统快照也必须带上 `-wal` 文件——而这正是 `.backup` 替你处理的事。这个教训更大的一面写在[你真的能还原的备份](/zh/posts/backups-you-can-restore/)里。

## sqlite pragma：WAL、外键与完整性检查

**sqlite pragma** 是「按连接」或「按数据库」的设置，写法就是 `PRAGMA name = value`。其中四条马上就能回本。

`journal_mode = WAL` 是读多写少的应用里收益最高的一个改动；它会持久化在文件头里，所以设一次就够。`foreign_keys` 默认关闭、且是按连接生效的，必须显式打开——这个 pragma 不会持久化：

```sql
sqlite> PRAGMA journal_mode;
wal
sqlite> PRAGMA foreign_keys;   -- 一条新连接
0
sqlite> PRAGMA foreign_keys = ON;
sqlite> INSERT INTO orders (customer_id,total_cents,created_at) VALUES (999,100,'2026-12-05');
Error near line 1: FOREIGN KEY constraint failed
```

打开这个 pragma 之前，那条「孤儿」插入会默默成功。`integrity_check` 则是备份之后、或任何心里发毛时该跑的——`quick_check` 是更快但不那么彻底的版本：

```bash
$ sqlite3 shop.db "PRAGMA integrity_check;"
ok
$ sqlite3 shop.db "PRAGMA quick_check;"
ok
```

另外两条也值得知道：`busy_timeout`（去等写锁，而不是立刻以 `SQLITE_BUSY` 失败）和 `synchronous = NORMAL`（在 WAL 下又快又安全）。把它们写进 `.sqliterc`，或放在每个连接的开头。WAL 单写者模型背后的道理，在 [SQLite 就够了](/zh/posts/sqlite-is-enough/)里。

## EXPLAIN QUERY PLAN：让计划器开口说话

`EXPLAIN QUERY PLAN` 是查明 SQLite 有没有用上你索引的办法。它展示访问路径，不展示耗时——对一个小数据库来说这已经够了。在 `status` 上建索引之前，计划是全表扫描；建好之后，变成查找：

```sql
sqlite> EXPLAIN QUERY PLAN SELECT id,total_cents FROM orders WHERE status='paid';
QUERY PLAN
`--SCAN orders

sqlite> CREATE INDEX idx_orders_status ON orders(status);
sqlite> EXPLAIN QUERY PLAN SELECT id,total_cents FROM orders WHERE status='paid';
QUERY PLAN
`--SEARCH orders USING INDEX idx_orders_status (status=?)

sqlite> EXPLAIN QUERY PLAN SELECT c.name,o.total_cents
   ...>   FROM customers c JOIN orders o ON o.customer_id=c.id WHERE c.country='UK';
QUERY PLAN
|--SCAN c
`--SEARCH o USING INDEX idx_orders_customer (customer_id=?)
```

读法是：`SCAN` 表示逐行读，`SEARCH ... USING INDEX` 表示按索引查找，缩进体现连接顺序。如果一条你以为该走索引的查询却显示 `SCAN`，先去看是不是列上套了函数、类型不匹配，或者选择性太低，再考虑加新索引——这跟[数据库索引基础](/zh/posts/database-indexing/)是同一套纪律。

## .read、ATTACH，以及加载扩展

`.read FILE` 会执行一份由 dot 命令和 SQL 组成的脚本，能把一堆查询变成一份可复用的报告。定义一次：

```sql
.headers on
.mode column
.width 20 8 12
SELECT c.name, o.status, o.total_cents
FROM customers c JOIN orders o ON o.customer_id = c.id
ORDER BY o.total_cents DESC LIMIT 3;
```

```bash
$ sqlite3 shop.db ".read report.sql"
        name           status   total_cents
--------------------  --------  ------------
Alan Turing           paid             78000
Alan Turing           pending          45000
Ada Lovelace          paid             12500
```

`ATTACH` 让一条连接同时挂上多个数据库，用 schema 名寻址——这是在文件之间搬数据、又不用 dump 的干净做法：

```sql
sqlite> ATTACH DATABASE 'archive.db' AS archive;
sqlite> CREATE TABLE archive.orders_2025 (id INTEGER PRIMARY KEY, total_cents INTEGER);
sqlite> INSERT INTO archive.orders_2025 (total_cents)
   ...>   SELECT total_cents FROM main.orders WHERE created_at < '2026-11-20';
sqlite> SELECT count(*) AS archived FROM archive.orders_2025;
2
sqlite> SELECT count(*) AS still_live FROM main.orders WHERE created_at >= '2026-11-20';
7
```

扩展在 shell 里用 `.load` 加载。CLI 默认就开启了扩展加载——你可以在 `.dbconfig` 里看到这个开关——而把 SQLite 嵌进库里的程序则默认关闭，所以同一个调用从 Python 发出会失败，直到你显式打开：

```sql
sqlite> .dbconfig
     load_extension on
...
```
```python
>>> import sqlite3
>>> sqlite3.connect(":memory:").load_extension("./nope.so")
OperationalError: not authorized
```

很多扩展本来就编进去了、根本不用加载——JSON 和全文搜索就是日常例子：

```sql
sqlite> SELECT sqlite_version(),
   ...>        json_extract('{"a":1,"b":[2,3]}','$.b[1]');
3.53.4|3
sqlite> CREATE VIRTUAL TABLE notes USING fts5(body);
sqlite> INSERT INTO notes(body) VALUES ('sqlite is a library, not a server');
sqlite> SELECT body FROM notes WHERE notes MATCH 'library';
sqlite is a library, not a server
```

## 手册精简版

真正覆盖九成使用场景的命令是：用 `.tables` 和 `.schema` 看你手里有什么，用 `.mode` 和 `.headers` 塑形输出，用 `.import --csv --skip 1` 载入文件，用 `-line`/`-json`/`-csv` 做脚本化查询，对活库用 `.backup`（永远别用 `cp`），`PRAGMA journal_mode=WAL` 加上 `foreign_keys=ON` 和 `integrity_check`，觉得慢时 `EXPLAIN QUERY PLAN`，脚本用 `.read`，一个文件不够就 `ATTACH`。这就是一个完整的数据库工具箱，装在你本来就有的一个二进制里——没有守护进程、没有端口、没有连接串。像上面那样留一个临时目录，下一次「你能看下应用的数据库吗」就变成两分钟的活，而不是一次部署。
