---
title: "Postgres 锁与死锁，亲手复现：pg_locks、SELECT FOR UPDATE、锁队列"
description: "在一次性 Postgres 17 容器里亲手复现 Postgres 锁与死锁：UPDATE 和 SELECT ... FOR UPDATE 到底锁了什么，如何用 pg_locks 连 pg_stat_activity 找到阻塞者，一个慢查询卡死所有人的锁队列，以及用锁顺序、SKIP LOCKED 和 lock_timeout 避免死锁。"
pubDate: 2026-12-06
lang: zh
translationKey: postgres-locks
tags: [devops, linux]
featured: false
keywords:
  - Postgres 锁
  - Postgres 死锁
  - pg_locks
  - SELECT FOR UPDATE
  - lock_timeout
---

**Postgres 锁**平时看不见，直到它突然显形——然后一个被遗忘的事务就能拖垮整个应用。这类问题我调试过太多次，早就不信那些示意图了，所以这次我起了一个一次性的 Postgres 17 容器，开两个 `psql` 会话，把每一种情形都真真正正地逼出来：一个行 `UPDATE` 把另一个 `UPDATE` 挡住、一条真实的 **Postgres 死锁**报错，以及一条待执行的 `ALTER TABLE` 把普通 `SELECT` 也冻住的锁队列。这篇就是那份终端记录：**`UPDATE`** 与 **`SELECT ... FOR UPDATE`** 到底锁了什么，怎么把 **`pg_locks`** 连到 **`pg_stat_activity`** 找出阻塞者，队列为什么会这样表现，以及两个能让「卡住的锁」不至于升级为「线上事故」的设置。

下面所有内容都是从终端直接粘出来的，不是事后还原。整套环境就这么多：

```sql
docker run --rm -d --name pglock -e POSTGRES_PASSWORD=x \
  -p 127.0.0.1:55432:5432 postgres:17
docker exec -i pglock psql -U postgres -c 'select version();'
--   PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2) on x86_64-pc-linux-gnu
```

主力表是一张 20 万行的任务队列；我用来观察第二个会话的那条查询，就是「找出阻塞者」那一节里的那条。

## 行锁与表锁：是两个层次，不是一个

Postgres 会在同一时刻在两个层次上加锁，把这两者混为一谈，是大多数困惑的来源。

**表级锁**加在关系本身，共有八种模式。每条语句至少会取一个 `ACCESS SHARE`（读）或 `ROW EXCLUSIVE`（写）。只有少数语句会取重锁：`ALTER TABLE`、`DROP`、`TRUNCATE` 和显式的 `LOCK TABLE` 会取 `ACCESS EXCLUSIVE`，它与**所有**模式冲突，连读也不例外。

**行级锁**存在元组上，在 `pg_locks` 里显示为 `locktype = 'tuple'`，另外还会在事务 id 上加一把锁（`locktype = 'transactionid'`），好让别的后端有东西可等。行锁并不是你可以廉价枚举的独立对象；它是行上的标记，也正是为什么一张表可以「只锁一行」却根本没被整表锁住。

关键规则：一次写操作会在整个事务期间持有 `ROW EXCLUSIVE` 表锁，尽管两笔对不同行的写并不冲突。这是有意为之——`ROW EXCLUSIVE` 与自身兼容，所以并发写没问题，但它与 `ACCESS EXCLUSIVE` **不**兼容。后面那节要讲的锁队列，就是这么来的。

## `UPDATE` 和 `SELECT ... FOR UPDATE` 到底锁了什么

两者都会取一把表级锁，但模式并不相同。`UPDATE` 取 `RowExclusiveLock`；`SELECT ... FOR UPDATE` 取 `RowShareLock`（更弱——它与其他 `RowShareLock` 不冲突）。然后两者都会锁住自己碰到的具体行。我在一个未提交事务里按住一行，让第二个会话去更新它：

```sql
-- 会话 1
BEGIN;
UPDATE jobs SET state = 'working' WHERE id = 1;
SELECT pg_sleep(8);
COMMIT;
-- 与此同时，会话 2
UPDATE jobs SET state = 'stolen' WHERE id = 1;
```

把 `pg_locks` 连到 `pg_stat_activity`，第二个会话的卡死状态一目了然：

```text
 pid | state  | wait_event_type |  wait_event   |   locktype    | relation  |       mode          | granted | blocked_by |            query
-----+--------+-----------------+---------------+---------------+-----------+---------------------+---------+------------+-------------------------------
  86 | active | Timeout         | PgSleep       | relation      | jobs      | RowExclusiveLock    | t       | {}         | SELECT pg_sleep(8);
  93 | active | Lock            | transactionid | tuple         | jobs      | ExclusiveLock       | t       | {86}       | UPDATE jobs SET state='stolen' ...
  93 | active | Lock            | transactionid | relation      | jobs      | RowExclusiveLock    | t       | {86}       | UPDATE jobs SET state='stolen' ...
  93 | active | Lock            | transactionid | transactionid |           | ShareLock           | f       | {86}       | UPDATE jobs SET state='stolen' ...
```

按顺序读。`86` 持有事务和那一行；`93` 那把表上的 `RowExclusiveLock` 是**已授予**的（所以它自己的写可以开始），但它在 `transactionid` 上有一把**未授予**的 `ShareLock`——它在等 `86` 结束。`wait_event_type = 'Lock'` 就是信号：这个后端不是在干活，它是被停住了。`blocked_by = {86}` 则是 `pg_blocking_pids()` 替你走完了等待图。

`SELECT ... FOR UPDATE` 产生同样的形状，只是表锁更弱——这里持有者（199）显示 `RowShareLock`，等待者（206）同样显示未授予的 `transactionid` `ShareLock`：

```text
 199 | active | Timeout | PgSleep    | relation      | jobs | RowShareLock     | t | {}
 206 | active | Lock    | transactionid | tuple      | jobs | ExclusiveLock  | t | {199}
 206 | active | Lock    | transactionid | relation   | jobs | RowShareLock    | t | {199}
 206 | active | Lock    | transactionid | transactionid | | ShareLock     | f | {199}
```

实际差别在于：普通 `SELECT`（不带 `FOR UPDATE`）只取 `AccessShareLock`，永远**不会**被别人的行锁挡住；它不等，直接读最后一个已提交版本。`FOR UPDATE` 是一句「我打算写」的承诺，所以它会等。

## 用 `pg_locks` 和 `pg_stat_activity` 找出阻塞者

我全程用的这条查询值得背下来。`pg_locks` 告诉你**什么**被持有；`pg_stat_activity` 告诉你**谁**、以及它当时在跑什么；`pg_blocking_pids()` 则帮你算出等待图，省得自己拼。

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

真正值钱的过滤条件是 `wait_event_type = 'Lock'`。在干真活的后端，`wait_event_type` 会是 `IO`、`LWLock`、`Client` 或 `Timeout`（比如 `SELECT pg_sleep` 就是 `Timeout`）。只有重型锁上的争用才会显示 `Lock`。如果你只告警一件事，就告警 `wait_event_type = 'Lock'` 的后端数量——它就是你的队列深度，也是事故正在开始的先行指标。

## 锁队列：为什么一个慢查询会卡住所有人

这是最让人意外的一点。锁是**先进先出**授予的。一个拿不到锁的请求不会被跳过——它会占住队列，而后头所有即使本可兼容的请求也得跟着等。看一个读事务持有 `ACCESS SHARE`，同时一个 `ALTER TABLE` 想要 `ACCESS EXCLUSIVE`，然后第三条人畜无害的 `SELECT` 进场：

```sql
-- S1：长读事务，持有 ACCESS SHARE 共 8 秒
BEGIN; SELECT count(*) FROM jobs; SELECT pg_sleep(8); COMMIT;
-- S2：ALTER 排在 S1 后面
ALTER TABLE jobs ADD COLUMN tmp_flag int;
-- S3：一条与 S1 并不冲突的普通 SELECT
SELECT count(*) FROM jobs;
```

```text
 108 | active | Timeout | PgSleep  | relation      | jobs | AccessShareLock     | t | {}
 115 | active | Lock    | relation | relation      | jobs | AccessExclusiveLock | f | {108}
 121 | active | Lock    | relation | relation      | jobs | AccessShareLock     | f | {115}
```

`121` 的 `AccessShareLock` 与 `108` 的 `AccessShareLock` 并不冲突——两者都是读。可它还是被挡住了，被 `115` 那条**待执行**的 `ALTER` 挡住。队列是先进先出，所以更便宜、更晚到的请求，排在了更昂贵、更早到的请求后面。这就是「一个等长报表的迁移把读全拖垮」的机制：不是读和读冲突，而是它们排在了迁移后面。如果你遇到过「改表结构时网站莫名卡死、日志里却没有锁错误」，原因就是它，这也是给迁移设置 `lock_timeout` 最有力的理由。

## Postgres 死锁报错，以及怎么读它

死锁就是队列撞上了自己：A 等 B，同时 B 等 A。Postgres 在 `deadlock_timeout` 之后检测到环，然后中止其中一个事务。我让两个事务以相反顺序锁同样两行：

```sql
-- A                                -- B
BEGIN;                             BEGIN;
UPDATE accounts SET balance = balance - 10 WHERE id = 1;
                                   UPDATE accounts SET balance = balance + 20 WHERE id = 2;
UPDATE accounts SET balance = balance + 10 WHERE id = 2;  -- 等 B
                                   UPDATE accounts SET balance = balance - 20 WHERE id = 1;  -- 闭环
COMMIT;                            COMMIT;
```

报错啰嗦是刻意的——它点名了两个进程和两条卡住的语句：

```text
ERROR:  deadlock detected
DETAIL:  Process 148 waits for ShareLock on transaction 761; blocked by process 149.
Process 149 waits for ShareLock on transaction 760; blocked by process 148.
HINT:  See server log for query details.
CONTEXT:  while updating tuple (0,2) in relation "accounts"
```

服务端日志还会补上那两条肇事语句，而这才是你真正要去改的东西：

```text
[148] DETAIL:  Process 148 waits for ShareLock on transaction ...; blocked by process 149.
[148]        Process 148: UPDATE accounts SET balance = balance + 10 WHERE id = 2;
[148]        Process 149: UPDATE accounts SET balance = balance - 20 WHERE id = 1;
```

把它当**一个环**来读，而不是当一条错误来读。进程 148 先拿了第一把锁，然后输了；149 提交了。查一下结果就能证明：`alice` 是 80，`bob` 是 120——A 整个回滚了，包括那部分看起来已经成功的操作。

## 避免死锁：一致的加锁顺序、短事务

死锁不是靠「更用力地重试」修好的，而是靠消除环。上面那个病的根因是 A 和 B 以**相反顺序**动了同样两行。只要两者都永远先锁较小的 id，就不可能成环。

```sql
-- 修法：一个固定顺序，在应用代码里强制执行
BEGIN;
SELECT balance FROM accounts WHERE id IN (1, 2) ORDER BY id FOR UPDATE;
UPDATE accounts SET balance = balance - 10 WHERE id = 1;
UPDATE accounts SET balance = balance + 10 WHERE id = 2;
COMMIT;
```

从同一次复现还能得出另外两条规则。**保持事务短**——事务开得越久，它持有、别人又想要的锁的存在窗口就越宽，上面那段 `pg_sleep(8)` 存在的唯一目的，就是把这个窗口显形。还有，**绝不要跨着网络调用或用户思考时间持锁**。每一个死锁修复都是「消灭环 + 缩小窗口」；重试逻辑只是给漏网之鱼用的创可贴，而且它必须重试**整个**事务，而不是失败的那条语句。

<figure>
<svg viewBox="0 0 680 300" width="100%" role="img" aria-label="两个事务交错成死锁。T1 锁住行 1 后请求行 2；T2 锁住行 2 后请求行 1。两个请求互相等待，形成环，Postgres 通过中止其中一个事务来打破它。">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <text x="20" y="26" font-weight="600" font-size="14">时间 →</text>
    <text x="70" y="60" font-weight="600" font-size="13">T1</text>
    <text x="70" y="200" font-weight="600" font-size="13">T2</text>
  </g>
  <g stroke="currentColor" stroke-width="2" opacity="0.55">
    <line x1="110" y1="52" x2="660" y2="52"/>
    <line x1="110" y1="192" x2="660" y2="192"/>
  </g>
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
  <g fill="none" stroke="currentColor" stroke-width="2">
    <path d="M 430 52 C 470 90, 470 150, 430 192" stroke-dasharray="6 4"/>
    <path d="M 430 192 C 390 150, 390 90, 430 52" stroke-dasharray="6 4"/>
  </g>
  <g font-family="system-ui, sans-serif" font-size="12.5" font-weight="600">
    <text x="560" y="112" text-anchor="middle" fill="currentColor">等待 T2</text>
    <text x="560" y="140" text-anchor="middle" fill="currentColor">等待 T1</text>
  </g>
  <text x="340" y="278" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="currentColor" opacity="0.85">T1 持有行 1 想要行 2；T2 持有行 2 想要行 1 → 一个无法推进的环</text>
</svg>
<figcaption>两个事务以相反顺序抓同一对行，就总会冒这个环的风险。Postgres 通过中止其中一个来打破它，但真正的修法在上游：让每条代码路径都以相同顺序锁相同的行。</figcaption>
</figure>

## 队列：`FOR UPDATE SKIP LOCKED` 与 `NOWAIT`

如果你的「锁」其实是一条工作队列，那等待就是错的行为——你想要的是另一行。两个修饰词会彻底改变阻塞语义，我对着那行被持有的数据各计时了一次：

```text
-- FOR UPDATE NOWAIT：快速失败，而不是排队
ERROR:  could not obtain lock on row in relation "jobs"
Time: 0.838 ms

-- FOR UPDATE SKIP LOCKED：忽略被锁的行，继续走
SELECT id FROM jobs WHERE id = 1 FOR UPDATE SKIP LOCKED;
 id
----
(0 rows)
```

`NOWAIT` 立刻返回错误，当调用方对「现在忙」能做出有用反应时，这是对的。`SKIP LOCKED` 不是等待，而是返回**零行**——这正是安全的 Postgres 任务队列的全部基础：许多 worker 都跑 `SELECT ... FROM jobs WHERE state='pending' ... LIMIT 1 FOR UPDATE SKIP LOCKED`，每个拿到不同的待处理行，永远不会撞车。它也是把双刃剑——`SKIP LOCKED` 给你的是一个不可重复读的视图，所以别用在「被我跳过的那一行要紧」的任何地方。

## 安全网：`lock_timeout` 与 `statement_timeout`

最后这段复现，是防止糟心的一天变成事故的关键。`lock_timeout` 限制一条语句**等锁**最多等多久；`statement_timeout` 限制它的**总运行时长**。

```text
-- lock_timeout：等 1 秒就别再排队了
SET lock_timeout = '1s';
UPDATE jobs SET state = 'x' WHERE id = 1;
ERROR:  canceling statement due to lock timeout
Time: 1000.974 ms

-- statement_timeout：给整条语句封顶
SET statement_timeout = '500ms';
SELECT pg_sleep(5);
ERROR:  canceling statement due to statement timeout
Time: 500.207 ms
```

注意哪个是哪个。我的等待者是卡在**获取锁**上，所以是 `lock_timeout` 触发，那条语句压根没运行。`statement_timeout` 更宽——它本来也能杀掉这条查询，但它同时会把真正干活的时间也算进去，所以当作锁守卫是钝的。两个都设：交互路径上、尤其是迁移上设 `lock_timeout`（让迁移只排队几秒而非几分钟，然后放弃重试），再用 `statement_timeout` 兜底，保证没有任何一条查询能永久跑下去。两者都不能防止死锁；它们只是限制你被死锁折磨多久——而这往往就是「页面变慢」和「线上事故」的区别。

## 我真正的收获

锁是一支队列，而队列是公平的——正因如此，一个慢的、晚到的、顺序错了的请求，能把它后面所有人一起卡住。整个调试回路可以压缩成一条查询（`pg_locks` ⨝ `pg_stat_activity`，用 `wait_event_type = 'Lock'` 过滤，再带上 `pg_blocking_pids`），整个预防可以压缩成三条规则：以一致顺序锁行、保持事务短、给每条语句一个 `lock_timeout`。索引塑造的正是你加锁时走的那些访问路径，所以两者值得一起理解——想看「没有索引的查询为什么在**持锁期间**会慢那么多」，见[数据库索引基础](/zh/posts/database-indexing/)；想看「别弄丢这些事务正在保护的数据」的另一半，见[你能恢复的备份](/zh/posts/postgres-backups/)。
