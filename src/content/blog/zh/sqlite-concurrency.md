---
title: "SQLite 并发实战：锁模型、WAL 模式，以及为什么你会遇到 database is locked"
description: "一篇基于真实实验的 SQLite locking 指南：默认回滚日志为什么会让第二个写者拿到 database is locked（SQLITE_BUSY）、WAL mode 如何让读不再与写冲突、busy_timeout 与 synchronous 的取舍，以及单写者规则下的工程设计与真实耗时数据。"
pubDate: 2027-01-08
lang: zh
translationKey: sqlite-concurrency
tags: [devops, python]
featured: false
keywords:
  - SQLite 锁
  - database is locked
  - WAL 模式
  - SQLITE_BUSY
  - busy_timeout
---

**SQLite 锁（SQLite locking）**是每个人都在事故现场认识 SQLite 的那部分：某个进程抛出 `sqlite3.OperationalError: database is locked`，日志被 `database is locked` 刷满，而你查到的建议是一堆玄学 pragma。这是我在真实数据库上跑出来的版本：**journal mode** 到底在干什么、默认模式为什么让两个写者相撞、**SQLITE_BUSY** 真正意味着什么、**WAL 模式**改变了什么（以及它*没有*改变什么）、以及你该拿它怎么办。下面每一个数字和每一条报错都来自真实运行——Python 3.14、SQLite 3.53.4、ext4-on-LUKS 磁盘——而不是凭记忆。

## 默认是回滚日志，而「回滚」意味着独占

一个新数据库处于 `delete` 模式——回滚日志。第一次写入之前，SQLite 会在数据库旁边创建一个 `-journal` 文件；提交时应用日志然后删除它。名字本身就说明了并发故事：为了保证回滚正确，写者会从 RESERVED 锁升级到 **EXCLUSIVE** 锁（排他锁）来完成提交，而在它拿到这把锁之前，其他所有写者都被挡在门外。

两个写者，不给任何等待，也不玩花样：

```python
import sqlite3

a = sqlite3.connect("db.sqlite3", timeout=0)   # timeout=0：完全不等
a.execute("BEGIN IMMEDIATE")
a.execute("INSERT INTO t VALUES ('A')")

b = sqlite3.connect("db.sqlite3", timeout=0)   # 第二个写者
b.execute("INSERT INTO t VALUES ('B')")        # <-- 人人都撞过的那一行
```

那次运行的真实输出：

```
Traceback (most recent call last):
  File "<stdin>", line 11, in <module>
sqlite3.OperationalError: database is locked
```

这就是 `SQLITE_BUSY` 以 Python `OperationalError` 的形式浮出水面。注意 `timeout=0`——默认情况下 `sqlite3.connect()` 会设置 **5 秒**的 busy timeout，所以在真实代码里，同样这一行不会立刻失败，而是先卡住五秒，*然后*才抛这个错。这正是你在 Celery/RQ/Sidekiq 这类 worker 里看到的「崩溃前那神秘的停顿五秒」。

## `database is locked` 到底意味着什么

`database is locked` 不是损坏，也不是 SQLite 会替你解开的死锁。它的意思是：*这个连接请求了一把锁，锁被占着，而 busy handler 放弃了*。SQLite 立刻告诉你真相，没有队列、没有公平性、没有顺序——谁先重试谁赢。

 busy handler 带来的差别有多大？同样的两进程相撞，写者持锁 3 秒，第二个写者试三种超时：

```
[holder] journal_mode=delete
[holder] write lock acquired (BEGIN IMMEDIATE), row inserted, holding 3.0s
--- probe with timeout=0s ---
[probe] timeout=0.0s -> OperationalError: database is locked (after 0.000306s, therefore immediate)
--- probe with timeout=1.5s ---
[probe] timeout=1.5s -> OperationalError: database is locked (after 1.502906s, therefore immediate)
[holder] committed -> lock released
--- probe with timeout=5s ---
[probe] timeout=5.0s -> INSERT committed in 2.432s (rows now: 4)
```

`busy_timeout`（Python 的 `timeout=`，原生 SQL 是 `PRAGMA busy_timeout=...`）是唯一决定你的失败是「瞬间」还是「有耐心」的旋钮。两个值都不能修复底层的冲突——它只是选择失败的口味。

## WAL 模式：读者不再在乎写者

WAL（write-ahead logging，预写日志）翻转了文件布局。写者不再重写主数据库，而是把新页追加到单独的 `-wal` 文件；读者读取主数据库加上 WAL 里的提交记录，看到一致快照。只要有 WAL 连接打开，数据库旁边就会出现两个 sidecar 文件——`db.sqlite3-wal` 和 `db.sqlite3-shm`（共享内存索引）。在最后一个连接干净关闭时，它们会被 checkpoint 进主库然后删除；下一个新的 WAL 连接又会把它们创建出来。

切换只要一行，而且是持久的：

```
$ sqlite3 app.db 'PRAGMA journal_mode=WAL;'
wal
$ sqlite3 app.db 'PRAGMA journal_mode; PRAGMA synchronous; PRAGMA wal_autocheckpoint;'
wal
2
1000
```

`synchronous` 的 `2` 是 FULL，`1000` 页是默认的 WAL 自动 checkpoint 阈值。现在做实测——写者持有一个打开的事务，读者同时读：

```
$ python3 exp2_wal.py
journal_mode       = 'wal'
sidecar files now  = ['wal.db-shm', 'wal.db-wal']

[writer] BEGIN IMMEDIATE + INSERT done (NOT committed); sidecars: ['wal.db-shm', 'wal.db-wal']
[reader] SELECT while writer is mid-transaction -> (1, 1) in 0.000126s  (sees old snapshot: no new row)
[writer2] OperationalError: database is locked (after 0.000225s) -> WAL has ONE writer too
[writer] committed
[reader2] SELECT after commit -> (2, 2)
```

仔细读这段输出，因为它同时包含了两条承诺和一条注意事项。读者毫发无伤地穿过——`0.000126s`，完全没有锁竞争——尽管写者还有未提交的页在外面。这就是 WAL 的全部胜利，也是「读写共用一个文件」和「读写互相打断」之间的区别。而注意事项是：**第二个写者依然拿到了 `database is locked`**。WAL 改变的是谁阻塞写者（现在没人阻塞），而不是「可以有几个写者」。

用一张图看懂写入期间读写的命运，前后对比：

<figure>
<svg viewBox="0 0 680 340" width="100%" role="img" aria-label="左右两个面板。左：回滚日志模式——写者持有排他锁，读者和第二个写者都被阻塞等待。右：WAL 模式——写者向 -wal 文件追加数据，两个读者继续读数据库快照，但第二个写者仍然在等。">
  <g font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="currentColor">
    <text x="170" y="24" text-anchor="middle">回滚日志（默认，journal_mode=delete）</text>
    <text x="510" y="24" text-anchor="middle">WAL 模式（journal_mode=WAL）</text>
  </g>

  <!-- 左：rollback -->
  <rect x="20" y="36" width="300" height="288" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
  <rect x="60" y="66" width="220" height="46" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="170" y="86" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">db.sqlite3</text>
  <text x="170" y="103" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="currentColor" opacity="0.7">+ db.sqlite3-journal</text>

  <rect x="60" y="126" width="220" height="26" rx="6" fill="#0f766e" opacity="0.15" stroke="#0f766e" stroke-width="1.5"/>
  <text x="70" y="143" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">writer1: RESERVED -> EXCLUSIVE</text>
  <text x="282" y="143" text-anchor="end" font-family="ui-monospace, monospace" font-size="12" fill="#0f766e">✗ in commit</text>

  <g font-family="ui-monospace, monospace" font-size="12" fill="currentColor">
    <text x="60" y="190">writer2</text>
    <text x="150" y="190">: BEGIN IMMEDIATE</text>
    <text x="282" y="190" text-anchor="end" fill="#0f766e">✗ database is locked</text>
    <text x="60" y="218">reader1</text>
    <text x="150" y="218">: SELECT ...</text>
    <text x="282" y="218" text-anchor="end" fill="currentColor" opacity="0.6">✗ waits (blocked at EXCLUSIVE)</text>
    <text x="60" y="246">reader2</text>
    <text x="150" y="246">: SELECT ...</text>
    <text x="282" y="246" text-anchor="end" fill="currentColor" opacity="0.6">✗ waits</text>
  </g>
  <text x="60" y="292" font-family="system-ui, sans-serif" font-size="11" fill="currentColor" opacity="0.7">everyone queues behind one writer</text>

  <!-- 右：WAL -->
  <rect x="360" y="36" width="300" height="288" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
  <rect x="380" y="66" width="110" height="46" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="435" y="86" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">db.sqlite3</text>
  <text x="435" y="103" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="currentColor" opacity="0.7">+ -shm</text>
  <rect x="530" y="66" width="110" height="46" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="585" y="86" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="#0f766e">db.sqlite3-wal</text>
  <text x="585" y="103" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="#0f766e" opacity="0.8">append-only</text>

  <path d="M495 89 L524 89" stroke="#0f766e" stroke-width="1.5" fill="none" marker-end="url(#arr)"/>
  <defs>
    <marker id="arr" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 z" fill="#0f766e"/>
    </marker>
  </defs>
  <rect x="380" y="126" width="260" height="26" rx="6" fill="#0f766e" opacity="0.15" stroke="#0f766e" stroke-width="1.5"/>
  <text x="390" y="143" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">writer1: appends to -wal</text>
  <text x="632" y="143" text-anchor="end" font-family="ui-monospace, monospace" font-size="12" fill="#0f766e">✓ running</text>

  <g font-family="ui-monospace, monospace" font-size="12" fill="currentColor">
    <text x="380" y="190">reader1</text>
    <text x="470" y="190">: SELECT ...</text>
    <text x="632" y="190" text-anchor="end" fill="#0f766e">✓ snapshot</text>
    <text x="380" y="218">reader2</text>
    <text x="470" y="218">: SELECT ...</text>
    <text x="632" y="218" text-anchor="end" fill="#0f766e">✓ snapshot</text>
    <text x="380" y="246">writer2</text>
    <text x="470" y="246">: BEGIN IMMEDIATE</text>
    <text x="632" y="246" text-anchor="end" fill="#0f766e">✗ locked (1 writer max)</text>
  </g>
  <text x="380" y="292" font-family="system-ui, sans-serif" font-size="11" fill="currentColor" opacity="0.7">readers never block; still one writer at a time</text>
</svg>
<figcaption>左：默认回滚日志下，写者在提交期间持有 RESERVED → EXCLUSIVE 锁，读者在提交瞬间被挡下，第二个写者从一开始就被拒。右：WAL 模式下写者向 <code>-wal</code> 追加，读者继续读快照——但 WAL 并没有颁发第二张写者通行证。</figcaption>
</figure>

在*持续*写入流下，读者的处境比一次快照更极端。一个写者紧凑循环提交，一个读者用 `timeout=0`，试 300 次：

```
journal=delete  reader SELECTs:   0 ok, 300 failed in 0.00s  (['database is locked'])
journal=wal     reader SELECTs: 300 ok,   0 failed in 0.02s  (['no errors'])
```

回滚日志下读者全灭，WAL 下 300 次全过。如果你的应用有后台任务在写、Web 层在读，这张表就是全部论据。

## 用数字看「一个写者」规则

五个连接（现实中的连接池规模），每个十个小事务，每个事务内部十毫秒工作，`busy_timeout=0`：

```
journal=delete  busy_timeout=0    -> 10 ok, 40 'database is locked', rows=10, wall=0.10s
journal=wal     busy_timeout=0    ->  9 ok, 41 'database is locked', rows=9,  wall=0.09s
```

WAL 没有救任何人：50 次写入仍然失败了 41 次。这就是诚实的 **single writer** 规则——在*任何* journal mode 下，同一时刻最多只有一个写者持有写锁。WAL 只是移除了读者/写者之争，它不会凭空造出第二个写者。唯一正确的修法是架构上的：一个写者进程，或者一个由唯一写者消费的队列（一张表、一个 list、一个 channel）。

同样这五个连接，给一个真实的 busy timeout，失败就化成了等待：

```
journal=delete  busy_timeout=2    -> 50 ok,   0 'database is locked', rows=50, wall=0.73s
journal=wal     busy_timeout=2    -> 50 ok,   0 'database is locked', rows=50, wall=0.73s
```

50 次写入 × 10 ms 工作 ≈ 0.73 s 墙钟时间——写入被完美串行化，这正是「一个写者」的含义。所以当写入速率不大时，`busy_timeout` 不是权宜之计，而是单写者约束的准入控制器。但它对持续的写入竞争*不是*解药：写者一多，墙钟时间随队列长度线性增长，诚实的答案是「合并提交」或者「单写者」。

## `synchronous`：你用 fsync 买回多少崩溃保证

SQLite 的持久性由 `PRAGMA synchronous` 决定。FULL（2）在提交时 fsync 一切；WAL 下的 NORMAL（1）只在 checkpoint 时 fsync；OFF（0）从不 fsync，让操作系统的页缓存吞下顺序。真实数字，ext4-on-LUKS 上 300 个独立事务（这台机器的 `/tmp` 是 tmpfs，fsync 近乎免费——值得引用的数字来自 `/`）：

```
journal  sync       time   db bytes  wal bytes
delete   FULL     8.597s      16384          0
wal      FULL     3.767s       4096     1256632
wal      NORMAL    0.004s       4096     1256632
wal      OFF      0.004s       4096     1256632
```

回滚+FULL 每次提交约 28.7 ms（删日志 + 多次 fsync），WAL+FULL 约 12.6 ms（一次 WAL 追加 fsync），而 WAL+NORMAL 直接归零——对于大量小提交，比默认配置快约 **两千倍**。这就是「死在回滚日志下」的应用该换成 WAL+NORMAL 的原因。但请仔细读这条保证：NORMAL 下，断电可能回滚最近提交的几个事务——文件仍然一致、未损坏，你只是可能丢掉最后片刻。对于日志、指标、任务队列，这是很好的交易；对于你已经向用户确认过的钱，这是糟糕的。

大批量写入看起来差别不大，但这恰好告诉你成本在哪：

```
(a) 50000 rows in ONE transaction
journal  sync       time   db bytes  wal bytes
delete   FULL     0.076s     884736          0
wal      FULL     0.058s       4096     898192
wal      NORMAL    0.050s       4096     898192
wal      OFF      0.049s       4096     898192
```

把五万行塞进一个事务，百倍差距坍缩成噪声（0.076 s 对 0.049 s）——按提交计费的 fsync 才是那笔税，而合并提交就是免税额度。

## `-wal` 文件：自动 checkpoint 与它的生命周期

WAL 会一直增长，直到有人把它推回主数据库。`PRAGMA wal_autocheckpoint` 默认 1000 页（默认 4096 字节页大小下约 4 MB）：在第一个越过阈值的提交上，SQLite 运行一次 checkpoint，把 WAL 页拷进主文件。真实轨迹，每次写 1000 行、每行 1 KB：

```
page_size = 4096 bytes; threshold 1000 pages = 4096000 bytes
chunk 1: 1000 rows x 1KB -> wal =  1046512 bytes, db =     4096 bytes
chunk 3: 1000 rows x 1KB -> wal =  3131232 bytes, db =     4096 bytes
chunk 4: 1000 rows x 1KB -> wal =  4177712 bytes, db =  4112384 bytes   <- crossed 4096000
chunk 8: 1000 rows x 1KB -> wal =  4210672 bytes, db =  8220672 bytes
```

第 4 块 WAL 越过阈值，主库从 4 KB 跳到 4.1 MB——自动 checkpoint 在工作。注意 WAL *文件*仍保持高水位大小（`PRAGMA wal_checkpoint(TRUNCATE)` 可把它截断回 0，返回 `(0, 0, 0)`——busy、log、checkpointed——并且在读者来去时依然有效）。被动 checkpoint 需要读者放过它们的旧快照；`TRUNCATE` 会短暂挡住新读者。如果你的 `-wal` 无限增长，去查有没有长命读者钉住旧快照，并考虑 `PRAGMA journal_size_limit`。

## 为什么你的 ORM 连接池会让事情更糟

连接池的默认值是照着 Postgres 写的：十个、二十个、五十个连接。在 SQLite 里每一个连接都是候选写者，所以池子并不能分摊写入——它*保证*相撞（看上面 41/50 的失败）。更糟的是，多数 ORM 按工作单元借还连接，这会把锁在请求之间反复易手。我用的规则：按写者数量定池子大小（1–2，单写者进程就 1），只有当写入稀少时才为读取扩大池子；显式给每个连接设 timeout（某些驱动默认没有 busy handler，会瞬间失败）；优先一个专门的写者（消费队列的进程），而不是人人打架。如果你用队列表，记住这里没有 `SELECT ... FOR UPDATE`——用 `UPDATE ... WHERE claimed = 0` 在 `BEGIN IMMEDIATE` 里抢行，然后提交。

## 什么时候毕业到 Postgres

满足以下任意一条再搬，而不是因为有人说 SQLite 不能扩展：多个写进程分布在不同主机（SQLite 锁的是*文件*；把它放到真正的共享文件系统上，你是用正确性换延迟）、写入量超过一个串行写者能吸收的上限、长耗时的分析型写入会把你的写者堵住几秒、或者需要行级 MVCC 和逐行锁。真正重要的症状是：你的写队列增长速度超过一个写者的消费速度。在那之前，WAL + 合理的 `busy_timeout` + 单写者扛下的东西远比人们以为的多——参见[《SQLite 就够了》](/zh/posts/sqlite-is-enough/)那条线画在哪，以及[《用 SQLite FTS5 做全文检索》](/zh/posts/sqlite-fts5/)这件它做得比服务器数据库更好的事。

## 配方，按顺序

1. `PRAGMA journal_mode=WAL`——一行代码，消除读者/写者互卡。
2. 给每个连接设置真实的 `busy_timeout`（Web worker 用 2–10 秒），而不是你以为没有、其实默认 5 秒的那个值。
3. 把写入合并进少量事务；让每个事务尽可能短。
4. 把写连接收敛到一个进程，或者让所有写入经过一个进程消费的队列。
5. 有意识地选 `synchronous`：默认 WAL+NORMAL，只有能接受丢掉最后几个事务时才用 OFF。
6. 盯住 `-wal` 大小；无界增长说明有读者钉着快照，或缺了 checkpoint。
7. 到这一步，才考虑 Postgres。

这就是实践中的 **SQLite locking**：设计上一个写者，WAL 下读者自由，`database is locked` 是数据库对你陈述 **SQLITE_BUSY** 的真相——以及在迁移任何东西之前，一份可以照着做的、有先后的清单。
