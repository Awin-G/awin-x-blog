---
title: "SQLite 就够了：在生产环境里使用 SQLite（以及什么时候不该用）"
description: "一份务实的主张：为什么对于博客、CLI 和内部工具，SQLite in production 常常是够用的；SQLite 到底是什么（embedded database、库、文件）；它的「单写者」并发模型与 WAL mode；busy_timeout、用 backup API 做在线备份、迁移；以及 SQLite vs Postgres 到底什么时候才成为一个真问题，而不是条件反射。"
pubDate: 2026-11-09
lang: zh
translationKey: sqlite-is-enough
tags: [devops, self-hosting, linux]
featured: false
keywords:
  - SQLite in production
  - SQLite vs Postgres
  - WAL mode
  - embedded database
  - backup
---

在一屋子后端工程师面前提到 **SQLite in production**，你会得到两种反应之一：一种是「从没上过线」的人的耸肩，另一种是「它根本扩展不了」的说教。两者都在回答一个没人问过的问题。对于一个博客、一个 CLI、一个内部工具来说，问题不是「Google 用什么」，而是「能满足未来两年不崩的最小数据库是什么」。大多数时候答案是 SQLite，而人们避开它的原因，其实是对 SQLite 到底是什么犯了一个范畴错误。所以让我先为 **SQLite in production** 辩护，再诚实地讲清楚：它究竟什么时候不够用，以及 **SQLite vs Postgres** 从哪一刻起才变成一个真问题。

## 为什么对 SQLite 的条件反射通常是错的

那个反射叫「玩具数据库」。它来自移动应用和教程——在那里 SQLite 是本地缓存，从来不是事实来源。那是一种真实用法，但不是唯一用法，而且它给整整一代人教了一个错的结论。

SQLite 被轻视更深层的原因，是人们在拿它和一个*服务器*比。Postgres 和 MySQL 是网络服务：有连接池、有为并发调优的查询规划器、有后台维护，还有一整套运维面。SQLite 不是它的缩小版。拿服务器数据库的标准去评判它，就像拿一辆自行车去比它能拖多重的挂车——技术上是个成立的比较，但基本无关紧要。

这种条件反射的代价是具体的。你不用一个文件加一个库，换来的却是：多一个要部署的进程、一个要监控的守护进程、一个要轮换的连接串、要备份的凭据、每次查询多一跳网络，以及一个「你的应用还活着但它却可能已经挂了」的服务。对于一个小应用，这是一堆买不到任何你真正需要的东西的运维工作。一个工人、一台机器时的诚实默认值应该是 SQLite，而 Postgres 应该是那次刻意的升级，而不是反过来。

## SQLite 到底是什么：一个 embedded database、一个库、一个文件

剥掉那些框架，SQLite 就是三样东西：

- **一个库。** 不是你要运行的二进制，而是你链接进自己进程的一个 C 库。没有服务器、没有 socket、没有端口。
- **一个 embedded database。** 它跑*在进程内*。一次查询是一次函数调用，而不是一次网络往返——所以查询延迟以微秒计，而不是毫秒。
- **一个文件。** 所有状态都在一个文件里（在 WAL mode 下，外加一个预写日志和一个共享内存文件）。复制这个文件，你就复制了整个数据库。光是这一条事实，就让备份、测试和本地开发变得近乎易如反掌。

这就是全部架构。也正是 SQLite 成为这个星球上部署量最大的数据库引擎的原因——它在你的手机里、浏览器里，以及大约一万个从没为数据库服务器付过钱的地方。

## SQLite 的并发模型：单写者与 WAL mode

这一节决定 SQLite 到底适不适合你，所以请仔细读。SQLite 允许**同一时刻只有一个写入者**。一直是如此。读与写通过锁来协调，而现代的默认方式是预写日志。

在旧的 rollback journal 模式下，写入者会阻塞所有读取者。在 **WAL mode** 下，读取者与写入者互不阻塞：写入发生时，读取者看到一致的快照，而改动追加到日志里。WAL *没有*改变的，是单写者规则。你得到的是许多并发读和恰好一个写入者，串行化。如果两个写同时到达，一个会等待（最多等 `busy_timeout`），或者以 `SQLITE_BUSY` 失败。

对于 SQLite 面向的那些工作负载，这没问题，因为写很短、读占主导。陷阱是长写事务。当你调一个外部 API 或者等一把锁的时候，还把一个写事务开着，会让你的整个应用都在它后面排队，而且再怎么调也修不好。把写事务保持得短一些，你几乎不会遇到争用。

## SQLite vs Postgres：真正的限制

真正要紧的限制有三条，而围绕它们的营销通常被夸大了。

### 它是单机的

SQLite 的数据是一台机器文件系统上的一个文件。那台机器挂了，数据库的可用性就只等于那台机器。你没法让两个应用服务器通过 NFS 写同一个文件——网络文件系统上的文件锁不可靠，这么做会损坏数据。一台机器，一个文件系统。

这是条硬限制，但「一台机器」在 2026 年是巨大的容量。一台现代 NVMe 的机器能扛的读和短写，比大多数内部工具一辈子产生的还多。限制是真的；但它卡不卡住*你*，是另一个问题。

### 写并发才是真正的天花板

单机关乎可用性；写并发关乎吞吐。因为写是串行的，一个写密集的工作负载——许多并发 worker 的高频插入、一个分析摄入、一个队列——会很快撞上天花板。如果你的应用在每个用户的每个请求上都写一次，那 SQLite 就是错的工具，你应该早点这么说。

### 它没有网络协议

SQLite 说的是函数调用，不是线上协议。没有客户端能远程连它，没有跨机的 `psql`，没有可指定的只读副本。所有跟这个数据库讲话的东西，都必须跑在同一台主机上。对一个博客或内部工具来说这是优点；对一群服务来说这是一堵墙。

请注意什么*不在*这份清单上：「不是 ACID」「负载下会损坏」「不能做 join」。SQLite 完全 ACID，支持 join、索引、CTE、窗口函数、JSON、全文搜索和事务。人们提的那些关于正确性的担忧大多是迷思；关于规模的担忧是真的，但比宣传的要窄得多。

## 如何把 SQLite in production 用好

「能用」的 SQLite 和「咬你一口」的 SQLite 之间，差的只是几项设置和习惯。

### 打开 WAL mode

WAL 是杠杆最高的一个改动。设一次，它就会持久化在数据库文件里。

```sql
-- 跑一次，持久化在 DB 头部
PRAGMA journal_mode = WAL;
```

也还是在每个连接启动时都设一遍——它是幂等的——并且记住它会生成一个 `-wal` 和一个 `-shm` 兄弟文件。备份必须把它们算进去。

### 设置 busy_timeout

只有单写者时，争用不是失败，而是等待。没有超时的话，SQLite 会立刻返回 `SQLITE_BUSY`，把一个短暂的重叠变成应用层的报错。`busy_timeout` 告诉 SQLite，在放弃之前该等这把锁多久。

```sql
PRAGMA busy_timeout = 5000;  -- 最多等 5 秒，而不是立刻失败
PRAGMA synchronous = NORMAL; -- 配 WAL 是安全的，比 FULL 快得多
```

配 WAL 时，`synchronous = NORMAL` 对应用崩溃是可持久化的，只会在操作系统崩溃或断电时丢掉最后几个事务——大多数小应用都乐意做这个交换。也请显式启用 `FOREIGN KEYS`，按连接设置，因为它默认是关的。

### 备份：backup API 与 `.backup`

绝不要 `cp` 一个正在运行的 SQLite 文件。尤其是在 WAL mode 下，只复制主文件会给你一个撕裂的数据库：已提交的事务可能还在日志里。请用在线 backup API 或 `.backup` 命令，它们在数据库运行期间取一份一致的快照。

```bash
# 一致的在线快照，对运行中的数据库安全
sqlite3 /var/lib/app/app.db ".backup '/srv/backup/app.db'"

# 信任它之前先校验它
sqlite3 /srv/backup/app.db "PRAGMA integrity_check;"
```

如果服务用的是基于 restic 的流水线，就备份那个*快照*，而不是热文件——这和第[「能真正恢复的备份」](/zh/posts/backups-you-can-restore/)里是同一课。如果你不想调 shell，每个正经的绑定都暴露了备份函数；在 Python 里是 `sqlite3.Connection.backup`。

```python
import sqlite3
src = sqlite3.connect("app.db")
dst = sqlite3.connect("/srv/backup/app.db")
with dst:
    src.backup(dst)   # 一致、增量，不用去 shell 里调 .backup
```

### 迁移

SQLite 的 `ALTER TABLE` 很有限——你能加列、重命名表，但在旧版本里不能删列或改列的类型。可靠的做法就是所有迁移工具都在用的那套：给 schema 打版本，对于复杂改动，就在同一个事务里新建表、复制、删除、重命名。

```sql
BEGIN;
CREATE TABLE user_new (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
INSERT INTO user_new SELECT id, email FROM user;
DROP TABLE user;
ALTER TABLE user_new RENAME TO user;
PRAGMA user_version = 3;   -- 把 schema 版本记在文件自身里
COMMIT;
```

`PRAGMA user_version` 是一份存在文件头里的廉价迁移台账，它会跟着备份和复制一起活下去。Alembic、Diesel、sqlx 以及大多数生态都支持 SQLite 目标，所以你很少需要手写这些——但你该知道它们在干什么。

## 什么时候该升级到 Postgres

当下面某一条成立时才迁移到 Postgres，而不是因为一篇博客吓到你了：

- **必须有多台机器写入。** 副本、故障转移，或者两个应用服务器，都需要 Postgres（或另一个网络化引擎）。
- **写本身才是工作负载。** 持续的并发写、一个摄入流水线、一个上了量的任务队列。
- **你需要服务器那一整套特性。** 丰富的角色与权限、逻辑复制、PostGIS 这类扩展、流式备份、`pg_stat_statements`。
- **运维上的隔离很重要。** 别人需要从别处连接，或者数据库必须能被独立地扩容、备份和恢复。

在那之前，迁移通常是一天的活儿：schema 和大多数查询都能带过去，你把 SQLite 换成一个驱动就是了。晚点做是刻意的成本；早点做，就是为多年你根本不需要的容量提前买单。

## 按应用类型的具体建议

不同的应用，不同的答案：

- **一个博客。** SQLite 不只是够用，它是最理想的。读密集、只有一个写入者（你）、没有高可用要求。WAL mode、`busy_timeout`，再把一份 `.backup` 丢进你的[自托管架构](/zh/posts/self-hosting-without-docker/)里，这就是数据库的全部故事。我就是这么跑的。
- **一个 CLI。** SQLite 本来就在系统里。一个项目或一个用户一个文件，不用装服务器、天然便携，而且好测试——因为一个全新的数据库就是一个临时文件。
- **一个内部工具。** 在写或者机器变多之前都用 SQLite。一个二十个人读、一个 cron job 写的看板，永远不会撑爆一个文件。盯写并发，别盯用户数。

我用的规则是：选 SQLite，然后为*这个*应用写下两个会迫使你迁到 Postgres 的条件。之后只有当其中之一真的被触及时，再来重新考虑。
