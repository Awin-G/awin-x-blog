---
title: "Postgres backup 实战：pg_dump、pg_basebackup、快照与 WAL 归档怎么选"
description: "为什么直接拷一个正在运行的 Postgres 数据目录会出事，以及 pg_dump、卷快照、WAL 归档这三套方案分别该在什么时候用。包含具体命令、用 pg_restore 与 pg_ctl 做的恢复演练、常见的坑，以及给小规模自托管数据库的建议。"
pubDate: 2026-11-15
lang: zh
translationKey: postgres-backups
tags: [devops, self-hosting, linux]
featured: false
keywords:
  - Postgres backup
  - pg_dump vs pg_basebackup
  - 时间点恢复
  - WAL 归档
  - 恢复演练
---

一个真正可用的 **Postgres backup**，不是把数据目录复制一份，而是一份你恢复过、启动
过、能查询的数据。这行里的坑我几乎都踩过：把正在运行的集群 `tar` 出来，解包后数据库
根本起不来；每夜跑的 dump 从来没人测过；WAL 归档在一周前就悄悄停了，直到磁盘挂掉才
发现。所以这篇写的是老实话：每种方法实际给了你什么，以及当数据值钱到值得上额外机器
时，**时间点恢复（point-in-time recovery）**该放在哪一层。

Postgres 的备份大致分三类，它们不是互相取代，而是解决三个不同的问题。逻辑 dump
（`pg_dump`）可移植、能按对象挑选；快照快、覆盖整个集群；而持续 **WAL 归档**（建立在
`pg_basebackup` 之上）才是让你在 14:02 误删表之后能恢复到 14:01 的东西。按「你需要
拿回什么」来选，而不是按哪个流行来选。

## 为什么直接拷贝正在运行的 Postgres 数据目录不安全

数据目录并不是你想象中那个「数据库本体」。它是一堆 8 KB 页面加上一份 write-ahead
log 的缓存，而 Postgres 在运行时会持续改写它。对一个活着的集群做 `tar` 或
`cp -r $PGDATA`，读到的文件处在变化中途，而没有任何一个事务能横跨「所有文件」——这份
拷贝天生就是撕裂的：一个写了一半、恢复时校验和不过的页面；一个 `pg_control` 指向的
checkpoint，其对应的 WAL 段却没被复制。

结果就是：拷贝命令退出码是 0，归档大小看着也对，而 `pg_ctl start` 要么拒绝打开集
群，要么把它启进静默的损坏里。文件系统层面成功，数据层面失败。

诚实的出路只有两条：把它 dump 成一致的东西，或者把文件系统当作一个原子瞬间来做快照。
单纯复制文件，从来不是其中之一。

## 逻辑 dump：`pg_dump` 与 `pg_dumpall`

`pg_dump` 通过一个 MVCC 快照读取数据库，所以即使写入还在继续，dump 也是一致的某一
瞬间。它输出 SQL（plain 格式），或输出压缩的 custom/tar 格式，后者能让 `pg_restore`
按对象、并行地恢复。

```bash
# custom 格式：压缩、可按对象恢复——我的默认选择
pg_dump --format=custom --compress=9 --file=/srv/backup/app.dump appdb

# directory 格式，按表并行——最快的逻辑 dump
pg_dump --format=directory --jobs=4 --file=/srv/backup/appdir appdb

# 角色、表空间等集群级对象，pg_dump 不会包含
pg_dumpall --roles-only --file=/srv/backup/globals.sql
```

最该记住的一点：`pg_dump` 只备份**一个数据库**，也完全不包含拥有它的角色。把 dump
恢复到一台全新的集群上，你会在 `role "app_user" does not exist` 上失败，直到先跑过
`pg_dumpall --roles-only` 为止——「备份没问题，但恢复失败了」里有相当一部分都栽在这一
点上。

逻辑 dump 可移植——能往更新的版本、任何主机、任何厂商迁移——也便宜，可以留存很多份。
代价是时间：`pg_dump` 要把每一行重新序列化，`pg_restore` 要重建每一个索引，两者都随
数据库体积增长。

## 文件系统与卷快照

LVM、ZFS、btrfs 以及云厂商的卷快照，是在某一个瞬间抓取整个块设备，不需要逐行读，所
以无论数据库多大都是几秒钟。这份速度让它们很诱人，也让人容易用错。

对正在运行的集群做快照，得到的是*崩溃一致*的状态：等同于在那个瞬间直接拔电源。这本身
不算坏——Postgres 就是设计成能从 WAL 崩溃恢复的。但它只有在你**整个 `$PGDATA` 都在
同一块卷上，包括 `pg_wal/`** 时才一致。把 `pg_wal` 拆到另一块盘上，快照里的数据目录
就需要一块你没抓到的卷上的 WAL，注定恢复不了。

快照作为一层快速的本地副本、以及升级的回滚点都很棒：先快照，再跑迁移，如果它把你的
schema 吃掉了，一个 `zfs rollback` 就回来了。但把它当作*唯一*备份则很糟：往往导不出
来、绑死某个厂商，而且任何拿着 hypervisor 或云 API key 的人都能把它连同线上数据一起
删掉。

## `pg_dump` vs `pg_basebackup`：你到底想要哪个

<figure>
<svg viewBox="0 0 660 300" width="100%" role="img" aria-label="决策图：要可移植的单个数据库用 pg_dump；要快速覆盖整个集群用 pg_basebackup 或快照；要时间点恢复则在 base backup 之上叠加 WAL 归档。">
  <g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.55">
    <rect x="230" y="10" width="200" height="46" rx="8"/>
    <path d="M330 56 V 100 H 115 V 150"/>
    <path d="M330 56 V 150"/>
    <path d="M330 56 V 100 H 545 V 150"/>
  </g>
  <rect x="20" y="150" width="190" height="120" rx="8" fill="none" stroke="#0f766e" stroke-width="2"/>
  <rect x="235" y="150" width="190" height="120" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.55"/>
  <rect x="450" y="150" width="190" height="120" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.55"/>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="14">
    <text x="330" y="38" text-anchor="middle">你需要拿回什么？</text>
    <text x="115" y="180" text-anchor="middle" font-weight="600" fill="#0f766e">可移植、按对象</text>
    <text x="115" y="204" text-anchor="middle" font-family="ui-monospace, monospace" font-size="13">pg_dump / pg_dumpall</text>
    <text x="115" y="230" text-anchor="middle" font-size="12" opacity="0.8">单个库，任意版本</text>
    <text x="115" y="250" text-anchor="middle" font-size="12" opacity="0.8">小库的默认方案</text>
    <text x="330" y="180" text-anchor="middle" font-weight="600">快、覆盖整集群</text>
    <text x="330" y="204" text-anchor="middle" font-family="ui-monospace, monospace" font-size="13">pg_basebackup / 快照</text>
    <text x="330" y="230" text-anchor="middle" font-size="12" opacity="0.8">整个集群，几秒钟</text>
    <text x="330" y="250" text-anchor="middle" font-size="12" opacity="0.8">仅限同一大版本</text>
    <text x="545" y="180" text-anchor="middle" font-weight="600">时间点恢复</text>
    <text x="545" y="204" text-anchor="middle" font-family="ui-monospace, monospace" font-size="13">WAL 归档 + base</text>
    <text x="545" y="230" text-anchor="middle" font-size="12" opacity="0.8">恢复到任意时刻</text>
    <text x="545" y="250" text-anchor="middle" font-size="12" opacity="0.8">RPO 到秒级</text>
  </g>
</svg>
<figcaption>三种方法，对应三件事。小规模自托管数据库应该从左边的强调框起步——一份你真的恢复过的逻辑 dump——只有当「丢掉一天写入」真的会让你疼时，才再加上第三种。</figcaption>
</figure>

`pg_basebackup` 是 `pg_dump` 的物理版对位。它不走 SQL，而是通过复制协议把集群的文件
拷过来，流式地给出一份一致的 base backup，外加让它可恢复所需要的 WAL。

```bash
# 一致的物理 base backup，WAL 同步流式传输（-X stream）
pg_basebackup --pgdata=/srv/backup/base --format=tar --wal-method=stream --checkpoint=fast

# 或者 plain 格式（一个可直接启动的数据目录），并在传输时压缩
pg_basebackup --pgdata=/srv/backup/base --format=plain --wal-method=stream --compress=server-zstd
```

权衡正好和 `pg_dump` 相反。`pg_basebackup` 很快，一次抓下整个集群（含角色、表空
间），但产物只能恢复到**同一大版本**——一个 15 集群的拷贝在 Postgres 17 下打不开——
而且无法挑选：「只要这张表」做不到。它本身只是你运行它那一刻的一张快照，真正的用途是
作为 WAL 归档的锚定 base。所以：想要能带到任何地方、按对象打开的东西，用 `pg_dump`；
想要速度和整集群、并且是在构建一种恢复能力而不是留一个文件，用 `pg_basebackup`。

## WAL 归档与时间点恢复

持续 **WAL 归档**把「定期一份 base backup」升级成「能恢复到*任意*时刻」。服务端把每一
个写满的 16 MB WAL 段送到某个持久的地方；恢复时先回放 base backup，再回放归档里的
WAL，一直到你选定的那个瞬间。这个瞬间才是重点：你恢复的不是「昨晚的备份」，而是
「14:01:30、那条 `DELETE` 之前一秒」的状态。

在主库上打开它需要三项配置，外加一份初始的 base backup：

```conf
# postgresql.conf
wal_level = replica                 # 提供足够信息以重建页面
archive_mode = on
archive_command = 'test ! -f /srv/wal-archive/%f && cp %p /srv/wal-archive/%f'
# PostgreSQL 15+：用 archive_library 命令是更现代的做法
# max_wal_senders 和 archive_timeout 也值得设置
```

`archive_command` 只有在段确实持久落盘后才能返回 0。那句 `test ! -f` 让它幂等，重试
时才不会覆盖掉一个好段。第一份 base backup 存在之后，之后每一份 base backup 加上归档
里的 WAL，就构成一段可恢复的历史。恢复到某个时间点，就是这份 base backup 加上一个
恢复目标：

```bash
# 1. 把 base backup 恢复到空的 PGDATA，然后加上恢复配置
tar -xf /srv/backup/base/base.tar -C "$PGDATA"
# 2. 在 postgresql.conf 里（PG12+，已经不用 recovery.conf 了）：
#    restore_command = 'cp /srv/wal-archive/%f %p'
#    recovery_target_time = '2026-11-15 14:01:30+00'
#    recovery_target_action = 'promote'
# 3. 这个文件的存在，就是告诉 Postgres 去做恢复
touch "$PGDATA/recovery.signal"
# 4. 启动——它会回放 WAL、promote、然后开始接受写入
pg_ctl -D "$PGDATA" -l /var/log/postgresql/recover.log start
```

盯住日志里的 `consistent recovery state reached` 和 `database system is ready to
accept connections`。如果它一直没走到那一行，说明归档里缺 WAL——而这正是恢复演练要
在你还不需要它之前就抓出来的那种失败。

## 恢复演练：证明 `pg_restore` 与 `pg_ctl` 恢复真的能用

备份是一个假设，恢复才是检验。每个月，把数据恢复到一个临时位置，把服务起起来。这跟
[能真正恢复的备份](/zh/posts/backups-you-can-restore/) 里讲的是同一套仪式，只是换成
Postgres 的命令。

```bash
# 逻辑 dump：恢复到一个临时库，先清掉已有对象
createdb restore_test
pg_restore --clean --if-exists --jobs=4 --dbname=restore_test /srv/backup/app.dump
psql restore_test -c 'SELECT count(*) FROM orders;'   # 证明它确实是真数据

# 物理 / PITR：恢复 base，让它回放，然后读恢复日志
pg_ctl -D /srv/backup/recover -l recover.log start
psql -p 5433 -c 'SELECT pg_is_in_recovery();'         # f → 已 promote，完成
```

每次演练都掐表，把数字记下来：那就是你真实的 RTO，而且几乎总比你估的长。先恢复
`globals.sql`、在一个备用端口上把集群起起来、再查一张表——这一步就把「备份跑过了」变
成了「备份是能用的」。

## 恢复成功之后才会咬你的那些坑

- **大数据库。** `pg_dump` 和 `pg_restore` 都随体积增长，所以要同时测 dump *和*恢复。
  一个恢复耗时超过你停机容忍度的方案，不算方案。
- **膨胀（bloat）。** dump 反映的是活着的行，加上任何仍然可见的死元组；一张膨胀了五倍
  的表，dump 出来就是五倍大、五倍慢。在意体积的话，大备份前先 `VACUUM`（要零停机就
  用 `pg_repack`）。
- **序列（sequence）。** `pg_dump` 会为它拥有的序列记录 `setval`，但如果你只挑部分对
  象恢复，序列就会漂移，下一次 `INSERT` 直接撞主键。部分恢复之后，拿 `last_value` 和
  `max(id)` 对一下。
- **扩展（extension）。** dump 里只有 `CREATE EXTENSION`，没有扩展本身的代码，所以
  `pgcrypto`、`postgis`、`pg_stat_statements` 必须先装在目标端。要在干净主机上测，而
  不是在那台本来就装好了的机器上测。
- **角色与表空间。** `pg_dump` 不携带它们；每个单库 dump 都要配上
  `pg_dumpall --roles-only`。记住，只有角色存在时，授权才会跟着恢复。
- **归档静默失败。** 一旦 `archive_command` 开始失败，`pg_wal/` 会一直涨到磁盘写满、
  主库停摆。要盯 `pg_stat_archiver`：`failed_count` 持续上升，或
  `last_archived_time` 变得陈旧，就是警报——而人们往往是在一次失败的恢复里才第一次
  发现它。

## 给小规模自托管数据库的建议

对于大多数 homelab 和小产品跑的数据库——一台机器、几十 GB、每隔几秒就有写入——把无聊
的事做彻底就好：

1. **每夜对每个数据库做逻辑 dump**，custom 格式，外加 `pg_dumpall --roles-only` 拿
   全局对象。加密后用 restic 送到异地，并配一条留存策略（7 日、4 周、12 月），这样一
   个月后才发现的问题依然救得回来。
2. **一套你真的会跑的恢复演练。** 每周自动恢复到临时实例；每季度手工做一次、掐表。这
   一步把 dump 变成备份，代价是每季度一个下午。
3. **只有当数据珍贵时才加 PITR。** 如果丢掉最近 24 小时的写入会真的让你疼——钱、用户
   产生且无法再生的内容、一份台账——就打开 WAL 归档加每日一次 `pg_basebackup`。它大体
   上让运维面翻倍：额外的 WAL 存储、一个要被监控的 `archive_command`，以及一套你也必须
   排练过的恢复流程。

顺序很重要：一份测过的每夜 dump，永远胜过一套没测过的 PITR；因为二十分钟能恢复的备
份，比一条你从未走通的完美恢复链更值钱。而如果这个数据库小到单文件加 WAL 模式就够用，
那就在给它加一台服务器之前先读 [SQLite 已经够用了](/zh/posts/sqlite-is-enough/)。
