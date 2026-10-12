---
title: "Postgres 流复制实战：streaming replication、pg_stat_replication 与手动 failover"
description: "从零复现 Postgres 复制：用 pg_basebackup 和 primary_conninfo 搭建物理 standby，读懂 pg_stat_replication 与 pg_stat_wal_receiver，测量真实的复制延迟，理解同步与异步的取舍，以及为什么 failover 依然要靠手动。"
pubDate: 2026-12-09
lang: zh
translationKey: postgres-replication
tags: [devops, linux]
featured: true
keywords:
  - Postgres replication
  - streaming replication
  - pg_stat_replication
  - failover
  - WAL
---

我总碰到同一个错误：有人搭了一个 **Postgres replication** 副本，看到视图里 `state = streaming` 出现过一次，就宣布数据库「高可用」了。然后主库一挂，什么都没发生——因为 **streaming replication** 只是搬字节，它不做任何决定。所以我用一对一次性容器把整套东西重新跑了一遍，并把终端原样抄了回来：一个用 `pg_basebackup` 和 `primary_conninfo` 搭起来的物理 standby，**`pg_stat_replication`** 与 `pg_stat_wal_receiver` 究竟报告了什么，一次真的复制过去的写入，一段实测的复制延迟，同步与异步之间的取舍，以及为什么 **failover** 仍然得由人（或工具）迈出那一步。

下面全部是两个 `postgres:17` 容器的真实输出，都只绑定在 `127.0.0.1`。跑完之后我把它们都删掉了。

## 复制是干什么用的——以及它不是什么

跑一个副本，有三个诚实的理由：

- **高可用。** 有一份随时跟得上、可以变成主库的热副本。
- **读扩展。** 把报表、分析、长 `SELECT` 丢给 **standby**，别让主库两头忙。
- **更省事的备份源。** 你可以对着副本跑 base backup，而不是在凌晨三点去压主库。

接下来是人们会跳过、而恰恰是出事故的那部分：

- **副本不是备份。** 它会在毫秒之内把你的 `DELETE`、你写错的 migration、你中的勒索软件加密全部重放一遍。备份是主库没了之后你还能**拿它恢复**的副本；副本是会跟着主库一起**走进灾难**的副本。（真正够格的备份看这篇：[Postgres backup 实战](/zh/posts/postgres-backups/)。）
- **streaming replication 不等于 failover。** 流复制协议本身没有选举、没有提升、没有客户端重定向。`streaming` 只说明字节在流。
- **standby 在 recovery 期间是只读的。** 你写不进去——这正是你要的，直到你把它提升为止。

## streaming replication 是怎么工作的

当 `wal_level = replica` 时，Postgres 会把足够多的细节写进 **WAL**，让另一台服务器能重建出同样的页面。主库上的 *walsender* 进程把这些 16 MB 的段推给 standby 上的 *walreceiver* 进程，后者先落盘、再重放。这就是**物理**复制：逐字节、整个集群、必须同大版本、单向。（逻辑复制是另一套模型：行级、可挑选、可跨版本——但那是另一篇文章。）

有两样东西会把 WAL 钉住，让主库不会在落后的 standby 眼皮底下把它回收掉。`wal_keep_size` 是一条粗放的底线——「以防万一」保留这么多。**replication slot** 则是精确版本：主库拒绝删除任何 slot 尚未确认的 WAL。我用的是 slot，这样一台断线落后的 standby 不会悄悄丢掉它还需要的那几段。

<figure>
<svg viewBox="0 0 680 250" width="100%" role="img" aria-label="示意图：主库通过复制协议单向地把 write-ahead log 推给只读的 standby，后者负责重放。">
  <defs>
    <marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <rect x="20" y="70" width="190" height="104" rx="10" fill="none" stroke="#0f766e" stroke-width="2"/>
  <rect x="470" y="70" width="190" height="104" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  <g fill="none" stroke="#0f766e" stroke-width="2">
    <line x1="214" y1="122" x2="462" y2="122" marker-end="url(#arw)"/>
  </g>
  <g fill="none" stroke="#0f766e" stroke-width="1.5" opacity="0.7">
    <rect x="272" y="108" width="18" height="26" rx="2"/>
    <rect x="298" y="108" width="18" height="26" rx="2"/>
    <rect x="324" y="108" width="18" height="26" rx="2"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="14">
    <text x="115" y="104" text-anchor="middle" font-weight="600" fill="#0f766e">Primary</text>
    <text x="115" y="128" text-anchor="middle" font-size="12" opacity="0.85">reads + writes</text>
    <text x="115" y="152" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" opacity="0.8">pg_stat_replication</text>
    <text x="565" y="104" text-anchor="middle" font-weight="600">Standby</text>
    <text x="565" y="128" text-anchor="middle" font-size="12" opacity="0.85">read-only, replays WAL</text>
    <text x="565" y="152" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" opacity="0.8">pg_stat_wal_receiver</text>
    <text x="340" y="52" text-anchor="middle" font-size="13" font-weight="600" fill="#0f766e">WAL stream (one way)</text>
    <text x="340" y="200" text-anchor="middle" font-size="12" opacity="0.8">primary_conninfo + standby.signal</text>
    <text x="340" y="222" text-anchor="middle" font-size="12" opacity="0.8">lag = sent_lsn − replay_lsn</text>
  </g>
</svg>
<figcaption>物理流复制是单向的：主库推送 write-ahead log，standby 一边重放一边保持只读。所有要监控的东西都落在两个视图里，两侧各一个。</figcaption>
</figure>

## 搭建：base backup、`primary_conninfo`、standby 信号

整个集群的起点是一个开关（Postgres 16+ 里 `replica` 已是默认级别，但我还是显式写上）、一个允许复制的角色，以及一个物理 slot。

```bash
# 1. 主库：replica 级别的 WAL、给 sender 留出名额、一条 WAL 底线兜底
docker run -d --name pgprim -e POSTGRES_PASSWORD=secret -p 127.0.0.1:55433:5432 \
  postgres:17 \
  -c wal_level=replica -c max_wal_senders=10 -c wal_keep_size=64MB

# 2. 一个允许复制的角色，以及一个把 WAL 钉到 standby 确认为止的物理 slot
docker exec pgprim psql -U postgres -c \
  "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replpass';"
docker exec pgprim psql -U postgres -c \
  "SELECT pg_create_physical_replication_slot('standby_slot');"
```

```text
 pg_create_physical_replication_slot
-------------------------------------
 (standby_slot,)
(1 row)
```

standby 是通过复制协议做一次 base backup 建起来的。关键都在一个参数上：`-R` 会写下两个文件，把一个目录变成副本——`primary_conninfo`（怎么连主库）和 `standby.signal`（命令它进入 recovery、永不接受写入）。

```bash
# -Fp 明文格式（得到一个可直接启动的 PGDATA），-Xs 边拷边流式取 WAL，
# -R 自动写好 primary_conninfo + standby.signal
pg_basebackup -h pgprim -U replicator -D "$PGDATA" -Fp -Xs -P -R
```

```text
waiting for checkpoint
23258/23258 kB (100%), 1/1 tablespace
```

`-R` 会留下一个 `postgresql.auto.conf`，里面写着 `primary_conninfo = 'user=replicator … host=pgprim port=5432'`，外加一个 `standby.signal` 文件。我再补一行——standby 要用的 slot——然后用和普通服务器完全一样的二进制把它启起来：

```text
# postgresql.auto.conf
primary_conninfo   = 'user=replicator password=replpass host=pgprim port=5432'
primary_slot_name  = 'standby_slot'
# standby.signal（内容无所谓；文件存在本身就是那条命令）
```

没有任何「standby 模式」开关。`standby.signal` 是否存在，就是主库和 standby 之间的全部区别。下面这两台服务器这样描述自己：

```text
PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2) on x86_64-pc-linux-gnu

 wal_level                = replica
 max_wal_senders          = 10
 wal_keep_size            = 64MB
 synchronous_standby_names =      # 默认异步
```

## 用 `pg_stat_replication` 和 `pg_stat_wal_receiver` 验证

别信搭建过程，要读回来看。在**主库**上，`pg_stat_replication` 每个连上的 standby 占一行：

```sql
docker exec pgprim psql -U postgres -x -c \
  "select pid, application_name, client_addr, state, sync_state, sent_lsn,
          write_lsn, flush_lsn, replay_lsn, write_lag, flush_lag, replay_lag
     from pg_stat_replication;"
```

```text
-[ RECORD 1 ]----+----------------
pid              | 121
application_name | walreceiver
client_addr      | 172.19.0.3
state            | streaming
sync_state       | async
sent_lsn         | 0/3000000
write_lsn        | 0/3000000
flush_lsn        | 0/3000000
replay_lsn       | 0/3000000
write_lag        | 00:00:00.000062
flush_lag        | 00:00:00.000062
replay_lag       | 00:00:00.000062
```

从左到右读这四个 LSN：`sent_lsn` 是主库已经上网的量，`write_lsn` 是 standby 收到的量，`flush_lsn` 是它 fsync 过的量，`replay_lsn` 是它真正重放过的量。三个 `*_lag` 间隔说的是「standby 是多久之前到达这一步的」，而不是干了多久的活——所以在一个空闲的主库上它们会显示成接近零。

在 **standby** 上，对应的镜像是 `pg_stat_wal_receiver`，外加那个最重要的问题：

```sql
docker exec pgstandby psql -U postgres -x -c \
  "select pid, status, receive_start_lsn, written_lsn, flushed_lsn, latest_end_lsn,
          slot_name, sender_host, sender_port from pg_stat_wal_receiver;"
docker exec pgstandby psql -U postgres -c "select pg_is_in_recovery();"
```

```text
-[ RECORD 1 ]-----+-------------
pid               | 37
status            | streaming
receive_start_lsn | 0/3000000
written_lsn       | 0/30B89F8
flushed_lsn       | 0/30B89F8
latest_end_lsn    | 0/30B89F8
slot_name         | standby_slot
sender_host       | pgprim
sender_port       | 5432

 pg_is_in_recovery
-------------------
 t
(1 row)
```

`status = streaming` 表示 WAL 正在到达；`pg_is_in_recovery() = t` 表示它还是副本、不会接受写入。如果 `status` 变成 `waiting` 或 `stopped`，说明 standby 活着但没连上——这正是监控必须抓住的状态，而一个「Postgres 进程还在不在」的探针根本看不见它。

## 一次会复制过去的写入，以及一个拒绝写入的 standby

在主库插入，再去 standby 读回来：

```sql
-- 在主库上
INSERT INTO demo(note) VALUES ('replicated from primary') RETURNING id, note;
-- 在 standby 上
SELECT id, note FROM demo ORDER BY id;
```

```text
 id |          note
----+-------------------------
  3 | replicated from primary
(1 row)

 id |          note
----+-------------------------
  1 | row one
  2 | row two
  3 | replicated from primary
(3 rows)
```

以及让 standby 之所以是 standby 的那个性质——它会拒绝你的写入：

```text
docker exec pgstandby psql -U postgres -c "INSERT INTO demo(note) VALUES ('should fail');"
ERROR:  cannot execute INSERT in a read-only transaction
```

这个报错是个特性，也正是 promotion 不可省略的原因。

## 监控复制延迟

延迟就是主库的位置和 standby 已重放位置之间的差距。为了让它动起来，我在 standby 上暂停了重放，在主库写了 20 万行，然后问主库它看到了什么：

```text
# 在 standby 上暂停重放，然后在主库上写一大批
docker exec pgstandby psql -U postgres -c "select pg_wal_replay_pause();"
docker exec pgprim  psql -U postgres -c \
  "INSERT INTO demo(note) SELECT 'bulk '||g FROM generate_series(1,200000) g;"
INSERT 0 200000

 application_name |   state   | sent_lsn  | flush_lsn | replay_lsn | pending |   replay_lag
------------------+-----------+-----------+-----------+------------+---------+-----------------
 walreceiver      | streaming | 0/47FE000 | 0/4000000 | 0/3002168  | 24 MB   | 00:00:01.505076

 pg_wal_lsn_diff(sent_lsn, replay_lsn) = 29935184     -- standby 尚未重放的字节数
```

`flush_lsn`（0/4000000）跑在了 `replay_lsn`（0/3002168）前面：standby 已经收到 WAL，但还没应用。`pg_wal_lsn_diff(sent_lsn, replay_lsn)` 把这场 LSN 的数字游戏变成一个你能告警的数——29,935,184 字节，约 24 MB。standby 自己也是这么说的：

```text
 pg_is_in_recovery | pg_last_wal_receive_lsn | pg_last_wal_replay_lsn
-------------------+-------------------------+------------------------
 t                 | 0/4000000               | 0/3002168

# 恢复重放，它立刻追上
 application_name |   state   | pending |   replay_lag
------------------+-----------+---------+-----------------
 walreceiver      | streaming | 0 bytes | 00:00:00.869134
```

两条我吃过亏才学会的告警经验。**字节和秒回答的是不同问题**：`pg_wal_lsn_diff` 的字节数是容量问题（磁盘会不会被撑爆？），而 `replay_lag` 是对用户可见的陈旧度（副本正在提供的数据有多旧？）。另外，**slot 会改变故障模式**：没有它，一台落后太多的 standby 会以 `requested WAL segment has already been removed` 报错停下，然后悄悄脱同步；有了它，主库会一直保留 WAL，故障就转移到主库的磁盘上。对 `pg_replication_slots` 里 `active = false` 的情况告警，别等磁盘替你报警。

## 同步与异步：延迟与丢数据的取舍

默认情况下复制是**异步**的：主库提交完就返回，standby 什么时候追上算什么时候。快，但主库崩溃时可能丢掉 standby 还没收到的最后几笔事务。

在主库上点名，把 standby 拉进同步集合：

```sql
ALTER SYSTEM SET synchronous_standby_names = 'walreceiver';
SELECT pg_reload_conf();

 synchronous_standby_names | sync_state | sync_priority
--------------------------+------------+---------------
 walreceiver              | sync       |             1
```

`sync_state` 从 `async` 翻成 `sync`，此时 `COMMIT` 只有在 standby **flush** 过 WAL 之后才返回——保证在这一刻才成为真的。代价是一个往返：`synchronous_commit = on` 时，每次提交都要付网络加上 standby 的 fsync。在我这套 loopback 容器上，这点差别被 fsync 的噪声淹没了，但形状才是重点：

- **异步** → 延迟最低，主库丢失时 RPO 是「几笔事务」。
- **`synchronous_commit = remote_write`** → standby 已写入但未 fsync；一个小窗口，延迟更小。
- **`synchronous_commit = on`** → 提交前 standby 已 fsync；RPO 为零，代价是一个往返的延迟。

还有个陷阱：如果被点名的那台同步 standby 消失了，`COMMIT` 会**一直阻塞**，直到它回来、或者你改掉配置。同步复制是用可用性换持久性，所以除非你也能接受「那台 standby 一死、主库就卡住」，否则别只点名一台 standby 来做同步。

## Promotion 与 failover 是手动操作

做 failover 就是要证明两件事：standby 翻出 recovery，旧主库不再是主库。我用一条命令提升了 standby：

```sql
-- 在 standby 上
SELECT pg_promote(wait => true);     -- pg_promote
SELECT pg_is_in_recovery();          -- f  → 它现在已经是主库
INSERT INTO demo(note) VALUES ('written on the promoted node') RETURNING note;
INSERT 0 1
```

```text
# 旧主库不再有接收者；被提升的节点不再有 wal_receiver 记录
select count(*) from pg_stat_replication;    -- 0  （旧主库，孤零零）
select count(*) from pg_stat_wal_receiver;   -- 0  （被提升的节点，现在是主库）
```

`pg_promote()` 让 standby 变为可写。整个机制就这么多。围绕它的一切——判断主库是不是真的死了、给旧主库做 fencing 以免它复活造成脑裂、把客户端重新指过去、再重建一台新的 standby——都是你自己的事。这就是「复制」和「高可用」之间的那条缝，而事故通常就发生在这条缝里。

有工具来自动化这一步，而它们存在，正是因为纯手动的地方最容易出错：**Patroni**（配合 etcd/Consul 做共识，自托管里最常见的选型）、**repmgr**（更简单、Postgres 原生、能接进同一套工具链），以及把这一切都藏起来的托管平台。不管选哪个，要点不变：failover 路径必须定期演练，因为一次没演练过的 failover 只是一个假设，不是一项能力。

## 我的建议

对一个小规模自托管数据库，按这个顺序来：

1. **先把备份做对。** 副本不是备份，救你命的是恢复演练。复制是你**第二步**才加的东西。
2. **跑一台带物理 slot 的异步 standby。** 成本不高，却给你 failover 的余量和读的目标，而 slot 挡住了那个会悄悄脱同步的故障。
3. **监控 `state`、`pg_is_in_recovery()` 和以字节计的延迟。** 一台活着但断线的 standby，除了这几项之外，在别处看起来都很健康。
4. **在空闲机器上练 `pg_promote()`。** 在真需要之前先知道自己的 RTO，并把客户端重新指向的步骤写下来。
5. **到这一步再考虑同步。** 当丢掉哪怕一笔已提交事务都不可接受时才开它——而且要同时为 standby 准备一套 failover 方案，因为 standby 一没，`sync` 会让 `COMMIT` 阻塞。

流复制给你一份精确到毫秒的副本。它不给你备份，也不给你 failover。弄清楚这条线到底划在哪里——以及怎么从 `pg_stat_replication` 上把它读出来——就已经是这份工作的大部分了。当真的一台副本陷入沉默时，你接下来要翻的其实不是复制：取决于挂的是哪一边，要么是[锁队列](/zh/posts/postgres-locks/)，要么是 WAL。
