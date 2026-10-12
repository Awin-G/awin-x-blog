---
title: "PgBouncer 与 Postgres 连接池：复现一遍（以及 transaction mode 的坑）"
description: "用 Docker 亲手搭一套 Postgres 17 + PgBouncer 1.26 复现 Postgres 连接池：为什么每个连接都是一个进程、为什么调大 max_connections 只是把天花板挪高、session 与 transaction 池模式到底差在哪，以及 transaction mode 在会话状态、临时表、prepared statements 上具体怎么翻车——全部是真机输出。"
pubDate: 2026-12-18
lang: zh
translationKey: pgbouncer
tags: [devops, linux]
featured: false
keywords:
  - PgBouncer
  - Postgres 连接池
  - transaction mode
  - max_connections
  - SHOW POOLS
---

**PgBouncer** 是大多数团队在 Postgres 应用连接不够用时第一个想到的东西，但它为什么有效、又为什么反咬一口，很容易被讲错。我用 Docker 起了一套一次性的 Postgres 17 和 PgBouncer 1.26，让 40 个客户端同时打过去，看它到底发生了什么。**Postgres 连接池**把服务端后端进程从 40 个压到 5 个；一切到 **transaction mode**，会话状态、临时表、prepared statements、advisory lock 就以一种必须看到真机输出才会相信的方式崩掉。而那个条件反射式的修法——调大 **max_connections**——只是把天花板挪高，因为每个连接都是一个独立的操作系统进程，各有各的内存。

## 为什么 Postgres 每个连接都要 fork 一个进程——以及为什么调大 max_connections 是错的

Postgres 是基于进程、而不是基于线程的。每个客户端连接都会拿到一个自己的 `postgres` 后端进程，在宿主机上就能看到。

```console
$ docker exec pgdemo-pg ps -o pid=,rss=,args= -C postgres
    1 28564 postgres -c max_connections=100
   27  5960 postgres: checkpointer
   28  5940 postgres: background writer
   31  8812 postgres: autovacuum launcher

# 空闲 6 个进程：61 MB。随后 40 个客户端直连 127.0.0.1:55432：
$ docker exec pgdemo-pg sh -c "ps -o rss= -C postgres | awk '{s+=$1} END {print s/1024 \" MB\"}'"
636 MB     # 46 个进程，约每连接 14 MB
```

这就是「直接调大 `max_connections`」是陷阱的原因：不管你用不用，内存都被占着，而且天花板很硬。

```console
$ psql "postgres://appuser:secret@127.0.0.1:55432/app" -c "SELECT 1;"
psql: error: connection to server at "127.0.0.1", port 55432 failed:
FATAL:  sorry, too many clients already
```

真正的问题几乎从来不是「Postgres 要同时跑 100 条查询」。而是 400 个应用 worker，每人抱着一条空闲连接，用掉 400 个进程槽，实际上可能只跑 5 条查询。

## Postgres 连接池到底做了什么

连接池夹在你的应用和 Postgres 之间，把*客户端*连接和*服务端*连接解耦。几百个客户端连到 PgBouncer；PgBouncer 只维持少量真正的 Postgres 连接，在客户端真的需要跟数据库说话时，才把一个后端递给它。空闲连接不再是 Postgres 的负担。

<figure>
<svg viewBox="0 0 680 300" width="100%" role="img" aria-label="大量客户端连接汇聚到 PgBouncer，再被复用到少量 Postgres 后端进程上。">
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
<figcaption>PgBouncer 终结客户端连接，再把它们复用到一小撮真正的 Postgres 后端上。这里 40 个客户端共享 5 个后端，于是你付出的内存取决于池子大小，而不是客户端数量。</figcaption>
</figure>

同一个 40 客户端负载分别打向三个目标，用 `pg_stat_activity` 数服务端真实后端：

```console
### 40 个客户端直连 Postgres (127.0.0.1:55432)
 server_backends
-----------------
              40

### 同样 40 个客户端经 PgBouncer session 模式 (127.0.0.1:6432)
 server_backends
-----------------
              40

### 换成 transaction 模式 (127.0.0.1:6433)
 server_backends
-----------------
               5
```

直连和 session 模式都是每个客户端一个后端；transaction 模式把 40 个客户端压到了 5 个。这就是它的全部价值，而 session 模式那列「40 个后端」正是代价的第一个信号。

## PgBouncer 的池模式：session、transaction、statement

`pool_mode` 决定一个客户端能持有多久的服务端连接。三种模式是在复用与兼容之间做取舍。

- **session** —— 后端在整个会话期间都归客户端所有，和直连一模一样。兼容性最好，但对空闲但开着的客户端没有任何复用收益。`pool_size` 仍然限制后端数量，超出的客户端会排队。
- **transaction** —— 后端只在一个事务期间归客户端，事务结束即归还。真正的大头在这里：40 个客户端用 5 个后端，因为大多数客户端大多数时间是空闲的。代价是任何*会话级*的东西都不再可靠。
- **statement** —— 后端只为单条语句持有，多语句事务基本不可能，所以几乎没人用。

我用了同一个镜像各起一个实例，一种模式一个，所以对比是同类比同类。在某个东西需要会话状态之前，客户端根本感觉不到差别。

## transaction mode 的坑，现场复现

这一段才是真正引发事故的地方。在 transaction mode 下，客户端连续两个事务可能跑在两个不同后端上，而且 PgBouncer 默认**不会**在客户端之间重置后端（`server_reset_query_always = 0`），于是状态既会丢失，也会泄漏。我用 10 个并发 worker 共享一个 5 连接池，复现了四种故障。

### 会话状态：`SET` 丢了，还变成了别人的

worker 在一个事务里设一个会话 GUC，在下一个事务里读它。

```console
### session 模式 (127.0.0.1:6432, pool_size 40)
port 6432: 10 workers x 40 checks = 400
  preserved            : 400
  lost (back to default): 0
  leaked (other worker) : 0

### transaction 模式 (127.0.0.1:6433, pool_size 5)
port 6433: 10 workers x 40 checks = 400
  preserved            : 33
  lost (back to default): 4
  leaked (other worker) : 363
    worker w0 read marker 'w5' set by another connection
    worker w2 read marker 'w5' set by another connection
```

400 次读取里只有 33 次读到了自己的值。4 次读到了默认值，而 363 次读到了**另一个 worker 设的值**——后端在客户端之间从来没被清理过。这不只是「你的 `SET` 不生效」，而是「你邻居的 `SET` 现在对你也可见」。`SET search_path`、`SET timezone`、`SET statement_timeout`、`SET ROLE`——在 transaction mode 里全都不安全。

### 临时表会消失（也会泄漏）

```console
### 临时表，transaction 模式 (127.0.0.1:6433)
port 6433: 10 workers x 30 iterations
  temp table still there : 283
  temp table vanished    : 17
  first error: relation "scratch" does not exist

### 临时表，session 模式 (127.0.0.1:6432)
  temp table still there : 300
  temp table vanished    : 0
```

300 次迭代里有 17 次撞上 `relation "scratch" does not exist`——临时表活在一个客户端已经不再持有的后端上。那 283 次「还在」就是泄漏：在共享后端上那张表留了下来，别的客户端甚至能往里插数据。`WITH HOLD` 游标和 `LISTEN`/`NOTIFY` 是同一个坑。

### prepared statements：最快搞崩应用的方式

跨事务的 SQL 级 `PREPARE`/`EXECUTE` 就是抽奖。

```console
port 6433: 10 workers x 30 PREPARE/EXECUTE pairs
  worked : 22
  failed : 278
     274x prepared statement "q" already exists
       4x prepared statement "q" does not exist
```

300 次里失败了 278 次。使用协议级命名 prepared statement 的驱动，只要 `max_prepared_statements` 关着，就会撞上同一堵墙，也就是经典的 `pgbench` 失败：

```console
$ pgbench -M prepared -c 8 -t 30 -f prep.sql -p 6434   # max_prepared_statements=0
pgbench: error: ERROR:  prepared statement "P_0" already exists
pgbench: error: client 5 script 0 aborted in command 0 query 0:
    ERROR:  prepared statement "P_0" does not exist
number of transactions actually processed: 39/240
error: Run was aborted; the above results are incomplete.
```

较新的 PgBouncer（这里是 1.26）把 `max_prepared_statements` 默认设为 200，并按客户端跟踪协议级 prepared statement，所以同样的命令打到默认池子上就是干净的：

```console
$ pgbench -M prepared -c 8 -t 30 -f prep.sql -p 6433   # max_prepared_statements=200
number of transactions actually processed: 240/240
number of failed transactions: 0 (0.000%)
tps = 2330.187580
```

结论不是「prepared statements 坏了」，而是：**搞清楚你的驱动在做什么、你的 PgBouncer 版本支持什么。** 在驱动里关掉 prepared statement（JDBC 的 `prepareThreshold=0`、asyncpg 的 `statement_cache_size=0`）是另一种常见绕法。

### advisory lock 会活过事务

`pg_advisory_lock` 是会话级的，不是事务级的。在一个后端上加锁，客户端走了，锁还留在那儿。

```console
client A on backend 33: took pg_advisory_lock(42)
client B on backend 34: pg_try_advisory_lock(42) -> False (false = blocked)
pg_locks: pid=33 mode=ExclusiveLock granted=True
```

一个客户端的会话锁挡住了一个毫不相干的客户端，因为在 transaction mode 里「会话」本身就是个外来概念。请改用 `pg_advisory_xact_lock`——Postgres 会在提交时自动释放。

## 读管理控制台：SHOW POOLS、SHOW STATS、SHOW CLIENTS、SHOW SERVERS

PgBouncer 有一个虚拟的 `pgbouncer` 库，像连普通库一样连上去就行。40 个客户端猛打 transaction 池子时，它这样报告：

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

`cl_active` 5、`cl_waiting` 35、`sv_active` 5——40 个客户端、5 个服务端，35 个客户端在排队，最坏等待 2.87 秒。如果生产里 `maxwait` 一路往上爬，就是 `pool_size` 对你的负载来说太小了。

`SHOW STATS` 补上流量数字：我看到 `total_client_login_count` 是 165，对应 5 个服务端；而 `total_xact_count ÷ total_server_assignment_count` 说明每个服务端槽位扛了多少事务——越高说明复用越好。`SHOW SERVERS` 直接确认数量：五行，每一行都是一个真实后端。

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

`SHOW CLIENTS` 是这张映射的另一侧：40 行，状态是 `active` 或 `waiting`，等待那些的 `wait_us` 在往上涨。`CLIENTS` 很多、`SERVERS` 很少——这就是池子在干活。

## 池子该开多大：pool size 怎么定

定容量不是「Postgres 允许多少就给多少」。Postgres 真正能并发执行的查询数，取决于有多少 CPU 核在干有用的活；多余的后端只会带来内存和上下文切换。一个常见起点是让 `pool_size` 接近核数再加点余量——混合负载下大约 **2× 核数**。真正要盯的是总和：每个 PgBouncer 池 `(database, user)` 最多留 `default_pool_size` 个后端，它们全都在抢同一个 `max_connections`。

```ini
[pgbouncer]
pool_mode = transaction
default_pool_size = 20      ; 每个 (database, user)
max_client_conn = 1000     ; 允许同时连接的客户端数
max_db_connections = 40    ; 跨所有用户的硬上限，作为保险
reserve_pool_size = 5      ; 突发
reserve_pool_timeout = 3
server_reset_query_always = 1  ; 在 tx 模式下用性能换正确性
```

上线后盯着 `SHOW POOLS` 里的 `cl_waiting` 和 `maxwait`：正常负载下 `cl_waiting` 不为零，说明太小；服务端大量空闲、`total_xact_count` 很低，说明太大。

## 什么时候你根本不需要 PgBouncer

如果你只有一个不大的应用实例、自带一个小连接池——比如 10 条连接——那加 PgBouncer 什么都换不来，还得付一跳网络、多一个要监控的东西，以及完整的 transaction mode 翻车清单。单进程配一个固定池，根本不会把 `max_connections` 用满，而 `session` 模式不过是一条更慢的直连。

当流量的**形状**不对时，你才需要池子：很多应用实例、很多 worker 线程、每个都开连接的 serverless 函数，或者一台你没法调大 `max_connections` 的 Postgres。那时候，把客户端连接和服务端连接解耦就不再是优化，而是你唯一还挡在「too many clients already」前面的东西。底下那套连接机制——一个后端到底怎么执行一条查询——值得先搞懂，见[Postgres 怎么运行一条查询](/zh/posts/postgres-explain/)；而 transaction mode 的这些毛病，和[Postgres 锁与事务如何等待](/zh/posts/postgres-locks/)里的那些是同源的。

一句话版本：PgBouncer 是对的工具，transaction mode 是大多数应用对的选择，而所有的坑都围绕会话状态。把 prepared statement 支持打开，把 `SET` 挪进事务里用 `SET LOCAL`，把 advisory lock 换成事务级那种，并且在你认定「越小越安全」之前先看一眼 `SHOW POOLS`。
