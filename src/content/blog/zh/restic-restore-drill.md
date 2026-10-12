---
title: "备份演练：证明你真的能恢复（用 restic）"
description: "一次完整的 restic 备份恢复演练，附真实输出：init、加密去重备份、restic forget 保留策略与 prune、check --read-data、删库重恢复、内容哈希与 diff 校验、定时器加 dead man's switch，以及 3-2-1 backup 的反模式。"
pubDate: 2026-12-13
lang: zh
translationKey: restic-restore-drill
tags: [self-hosting, devops, linux]
featured: false
keywords:
  - restic
  - 备份恢复演练
  - restic forget
  - 3-2-1 备份
  - 去重
---

每篇讲备份的文章都用同一句话开头：一个你从没恢复过的备份，是传闻，不是备份。
这话我也说。所以这一次我不写它——我用手里的 **restic** 真跑了一遍**备份恢复演练**：
造一份小而真实的数据集，备份它，删掉原始数据，再恢复回来，然后逐字节比对。下面
是真实的终端输出，包括我自己犯的一个「悄悄什么都没做」的错误。**3-2-1 backup** 的
意义不在于任务跑过了，而在于「能恢复」是一件被演示过的事实。

大多数 restic 入门文章都停在 `restic backup`：打印一行 `snapshot saved`，大家就
放松了。那是错的一半。对的那一半是演练：故意销毁源数据，从仓库把它重建出来，然后
证明重建的就是同一份数据。这篇文章就是那一半。

<figure>
<svg viewBox="0 0 660 150" width="100%" role="img" aria-label="生产数据被备份进一个加密、去重的 restic 仓库；恢复演练把它读回到一个临时目标目录，再用哈希和 diff 比对证明字节一致。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="8" y="46" width="120" height="58" rx="8"/>
    <rect x="182" y="46" width="140" height="58" rx="8"/>
    <rect x="376" y="46" width="120" height="58" rx="8"/>
    <rect x="540" y="46" width="112" height="58" rx="8"/>
    <path d="M128 75 h50" marker-end="url(#ar)"/>
    <path d="M322 75 h50" marker-end="url(#ar)"/>
    <path d="M496 75 h40" marker-end="url(#ar)"/>
    <path d="M596 104 c 0 30 -540 30 -540 0" stroke-dasharray="4 4" opacity="0.5"/>
    <defs>
      <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
        <path d="M0 0 L8 4 L0 8 z" fill="currentColor"/>
      </marker>
    </defs>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="68" y="72">生产数据</text>
    <text x="68" y="90" opacity="0.75">/srv/data</text>
    <text x="252" y="68">restic 备份</text>
    <text x="252" y="86" opacity="0.75">加密 + 去重</text>
    <text x="436" y="68">仓库</text>
    <text x="436" y="86" opacity="0.75">只有密文</text>
    <text x="596" y="72">恢复</text>
    <text x="596" y="90" opacity="0.75">+ 校验</text>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" text-anchor="middle" opacity="0.7">
    <text x="330" y="132">diff -rq · sha256sum · PRAGMA integrity_check</text>
  </g>
</svg>
<figcaption>演练流程：生产数据喂给一个加密、去重的仓库；恢复把它读回到一个临时目录；真正证明它成立的是哈希与 diff 比对，而不是绿色的退出码。</figcaption>
</figure>

## 为什么一个没恢复过的备份只是传闻

备份完成，是一个承诺。恢复完成，是一个事实。两者之间的落差，就是事故栖息的地方。

`restic backup` 退出码 0，只证明一份 snapshot 被写入了、被索引了。它不证明数据能
读回来、你的密码还能打开它、写入途中磁盘没被写满，也不证明启动服务所需的配置就在
这份 snapshot 里。我见过一个「成功」的任务产出一个缺少那个 `.env` 的仓库，而正是
那个文件让应用启动。绿色对勾，服务已死。

所以我追踪的指标不是「上次备份：OK」，而是：我上次恢复是什么时候、成功了吗、花了
多久？一次**恢复演练**，能在一个安静的下午把这个承诺变成事实，而不是在凌晨两点、磁盘
已经死了之后才发现那个落差。

## 一次具体的 restic 恢复演练，附真实输出

我在一个临时目录里跑它，但这里没有任何东西依赖 Docker——restic 是一个静态二进制，
同样的命令在任何机器上都能跑。数据集故意做得很小：十三个文件、一个活的 SQLite 库、
一个 `pg_dump` 风格的转储、配置，和几个二进制上传文件，大约 320 KiB。

一次性设置：`restic init` 创建加密仓库。仔细读它的输出——那是这个工具里最重要的警告：

```console
$ export RESTIC_REPOSITORY=/srv/repo
$ export RESTIC_PASSWORD_FILE=/srv/restic-pass
$ restic init
created restic repository 93e77c5df7 at /srv/repo

Please note that knowledge of your password is required to access
the repository. Losing your password means that your data is
irrecoverably lost.
```

密码并不存在仓库里。丢了它，密文就是一堆永久的噪声。下面每一个设计决策，都先假设
你已经解决了这一件事。

然后是备份。第一次全量读取：

```console
$ restic backup /srv/data --host blog-vps --tag host:drill,role:blog
no parent snapshot found, will read all files

Files:          13 new,     0 changed,     0 unmodified
Dirs:           15 new,     0 changed,     0 unmodified
Added to the repository: 330.333 KiB (319.476 KiB stored)

processed 13 files, 321.484 KiB in 0:00
snapshot eb840398 saved
```

第二晚几乎没有新东西——这就是**去重**在起作用：一棵 321 KiB 的目录树，只因为一个
文件改动，仓库只长了 5.5 KiB。

```console
$ restic backup /srv/data --host blog-vps --tag host:drill,role:blog
using parent snapshot eb840398

Files:           0 new,     1 changed,    12 unmodified
Dirs:            0 new,     6 changed,     9 unmodified
Added to the repository: 5.499 KiB (2.697 KiB stored)

processed 13 files, 321.518 KiB in 0:00
snapshot 55b2cc84 saved
```

我让它跑了十个晚上，用 `--time` 把每份 snapshot 的时间钉住，模拟一周的历史。这份
列表就是「你能恢复什么」的真相：

```console
$ restic snapshots
ID        Time                 Host        Tags                  Paths      Size
---------------------------------------------------------------------------------------
eb840398  2026-10-03 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.484 KiB
55b2cc84  2026-10-04 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.518 KiB
20334f84  2026-10-05 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.551 KiB
7818323d  2026-10-06 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.584 KiB
12c6b55b  2026-10-07 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.617 KiB
719105e8  2026-10-08 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.650 KiB
58eacf5e  2026-10-09 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.684 KiB
7745a0b5  2026-10-10 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.717 KiB
2a183a32  2026-10-11 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.750 KiB
4e6261dd  2026-10-12 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.783 KiB
---------------------------------------------------------------------------------------
Timestamps shown in UTC
10 snapshots
```

## 用 restic forget 做保留策略，以及为什么 prune 不是可选项

十份 snapshot 没问题；一万份就是一个没人负担得起异地保存的仓库。`restic forget`
施加保留策略——一周的每日、一个月的每周、一年的每月：

```console
$ restic forget --compact --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --dry-run
Applying Policy: keep 7 daily, 4 weekly, 12 monthly snapshots
keep 9 snapshots:
...                                        (the kept snapshots, abbreviated)

remove 1 snapshots:
ID        Time                 Host      Tags        Size
----------------------------------------------------------------
20334f84  2026-10-05 03:30:00  blog-vps  host:drill  321.551 KiB
                                         role:blog
----------------------------------------------------------------
Timestamps shown in UTC
1 snapshots

Would have removed the following snapshots:
{20334f84}
```

我每次都先跑 `--dry-run`——它会在真正删除之前，列出它要删掉的确切 ID。不那么明显的
一点是：**策略是「并集」，不是「上限」**。我要求保留 7 个每日，它却保留了 9 个，因为
有两个更老的 snapshot 同时还是「最老的每周」和「最老的每月」。只要*任意*一条规则想要
某个 snapshot，`forget` 就会留下它。别以为 `--keep-daily 7` 就一定只剩七个。

去掉 `--dry-run` 就真的删掉它们，`--prune` 回收它们占的空间：

```console
$ restic forget --compact --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune
Applying Policy: keep 7 daily, 4 weekly, 12 monthly snapshots
...
[0:00] 100.00%  1 / 1 files deleted
1 snapshots have been removed, running prune
loading all snapshots...
finding data that is still in use for 9 snapshots
[0:00] 100.00%  9 / 9 snapshots
searching used packs...
collecting packs for deletion and repacking
[0:00] 100.00%  20 / 20 packs processed

to repack:            92 blobs / 341.822 KiB
this removes:          0 blobs / 0 B
to delete:             8 blobs / 2.384 KiB
total prune:           8 blobs / 2.384 KiB
remaining:            92 blobs / 337.506 KiB
unused size after prune: 0 B (0.00% of remaining size)

repacking packs
[0:00] 100.00%  18 / 18 packs repacked
rebuilding index
[0:00] 100.00%  11 / 11 indexes processed
[0:00] 100.00%  11 / 11 old indexes deleted
removing 20 old packs
[0:00] 100.00%  20 / 20 files deleted
done
```

`forget` 单独使用时只删除 snapshot 的引用；数据 blob 会一直留到 `prune` 运行。只
forget 不 prune，就是仓库越来越胖、而 snapshot 列表看起来还很整洁的原因。

### 那个让 restic forget 什么都没做的坑

这是我犯的错。默认情况下，`restic forget` 按**主机和路径**给 snapshot 分组，并对每组
分别施加策略。我最初每次备份都在一个全新的容器里跑，于是每份 snapshot 都拿到了不同的
主机名——十组，每组一个——`--keep-daily 7` 于是把十个全留下了。命令退出码是 0。什么都
没出错，也什么都没被 prune。显式钉住 `--host`，并保持备份路径稳定，否则保留策略会悄悄
变成空操作。演练，就是你发现空操作的方式。

## restic check：检查字节，而不只是元数据

`restic check` 校验仓库结构——索引、树、pack——便宜到可以每次备份后都跑。但「元数据
一致」不等于「字节可读」。后者要靠 `--read-data`：

```console
$ restic check --read-data
using temporary cache in /tmp/restic-check-cache-1742438661
create exclusive lock for repository
load indexes
check all packs
check snapshots, trees and blobs
[0:00] 100.00%  10 / 10 snapshots
read all data
[0:00] 100.00%  20 / 20 packs
no errors were found
```

`--read-data` 会把每个 blob 拉回来、解密、校验校验和。在一个 TB 级仓库上，每晚都做太
贵了；用 `--read-data-subset=5%` 定期抽样，每月做一次全量。一个过不了
`check --read-data` 的仓库不是备份，是一个倒计时。

## 恢复演练，一步一步来

我分两个阶段跑：生产环境还在时先跑一次**非破坏性**演练，再做**破坏性**证明。

第一阶段恢复到临时目录，并和活数据比对。注意 restic 的路径语义：它会在目标目录*之下*
重建 snapshot 的绝对路径，所以 `/srv/data` 会落在 `/srv/restore/srv/data`。

```console
$ restic restore latest --target /srv/restore
restoring snapshot 4e6261dd of [/srv/data] at 2026-10-12 03:30:00 +0000 UTC by root@blog-vps to /srv/restore
Summary: Restored 28 files/dirs (321.783 KiB) in 0:00

$ diff -rq data restore/srv/data
(no differences: the restored tree is byte-identical)
```

`diff -rq` 按内容回答「文件一样吗？」，但哈希在换台机器之后依然成立、还能跨机器对齐，
所以我还会比对清单：

```console
$ (cd data && find . -type f -print0 | sort -z | xargs -0 sha256sum) > /tmp/live.sha256
$ (cd restore/srv/data && find . -type f -print0 | sort -z | xargs -0 sha256sum) > /tmp/restored.sha256
$ diff /tmp/live.sha256 /tmp/restored.sha256
(all 13 hashes match)
```

第二阶段才是诚实的版本：先记下哈希，销毁原始数据，恢复，再比对。没有留生产副本兜底。

```console
$ (cd data && find . -type f -print0 | sort -z | xargs -0 sha256sum) | tee /tmp/original.sha256
61e4b364901df759b038b6fc8f74e9fbc302d06052650a9c6a3990c358ac32a3  ./etc/nginx/sites-enabled/blog.conf
530c005cd52c2534300659fbd4be2faf3260af32ef5a20795c46ed12213963ea  ./etc/systemd/system/blog.service
ec5f7e7f8126bd88d8d600a807ab1460fe17c2807cf115303771d4eb40ce4195  ./srv/backup/db.dump
...
$ rm -rf data
$ ls data
ls: cannot access 'data': No such file or directory

$ restic restore latest --target /srv/restore
restoring snapshot 4e6261dd of [/srv/data] at 2026-10-12 03:30:00 +0000 UTC by root@blog-vps to /srv/restore
Summary: Restored 28 files/dirs (321.783 KiB) in 0:00
```

然后是证明：恢复出来的字节，就是原来的字节；恢复出来的数据库不只是存在，而且能打开：

```console
$ (cd restore/srv/data && find . -type f -print0 | sort -z | xargs -0 sha256sum) > /tmp/restored.sha256
$ diff /tmp/original.sha256 /tmp/restored.sha256
(all 13 hashes match)

$ sqlite3 restore/srv/data/var_app.db 'PRAGMA integrity_check; SELECT count(*) FROM posts;'
ok
3
```

「哈希全对」加上「SQLite 完整性检查通过」，比一句「恢复命令成功了」强得多。
`restic diff` 能直接比对两份 snapshot，而 `restic stats --mode raw-data` 会告诉你加密
和去重省下了什么——这里，约 2.9 MiB 的逻辑数据住在一个 337 KiB 的仓库里：

```console
$ restic stats --mode raw-data
scanning...
[0:00] 100.00%  9 / 9 snapshots, 92 blobs, 337.506 KiB
Stats in raw-data mode:
     Snapshots processed:  9
        Total Blob Count:  92
 Total Uncompressed Size:  378.362 KiB
              Total Size:  337.506 KiB
    Compression Progress:  100.00%
       Compression Ratio:  1.12x
Compression Space Saving:  10.80%
```

## 加密、去重、可异地：3-2-1 backup 的落地

三个特性，三个让你觉得 restic 值得学的理由。

**加密**——异地副本放在别人的电脑上是安全的。restic 在客户端加密，字节离开这台机器
之前就已经是密文，所以对象存储、一台便宜 VPS，或者朋友的服务器，手里拿到的永远只有
密文。

**去重**——很多版本也负担得起。每晚全量副本会逼得人只剩三天的历史；内容定义分块让
你可以保留一周的每日加上一年的每月——这正是 `restic forget` 的意义——因为没变的块
只存一次。

**可异地**——副本要在源失效时活下来。restic 能对接本地磁盘、SFTP、S3、Backblaze B2，
以及任何 rclone 能到达的地方，`restic copy` 还能在仓库之间镜像 snapshot。我对一个人的
**3-2-1** 的翻译是：机器上一份工作副本，第二台主机上一个加密仓库，再加对象存储里一个
`rm -rf` 或者一块死盘都够不到的第二仓库。

## 该备份什么，该排除什么

备份你无法重新生成的东西：应用数据和数据库、让服务保持原本行为的配置，还有密钥。
restic 会加密一切，所以一个明文密钥文件放在*仓库里*是安全的——但仓库密码不是，放在
它旁边的密钥文件也不是。把 restic 密码存进密码管理器*并且*写在纸上，因为一次恢复了
数据却没能拿到解密密钥的恢复，什么也没恢复。

然后把噪声排除掉，否则备份会毫无理由地又慢又贵：

```bash
restic backup /srv /etc /var/lib/app \
  --exclude='/proc' --exclude='/sys' --exclude='/dev' --exclude='/run' \
  --exclude='**/node_modules' --exclude='**/.cache' --exclude='**/cache' \
  --exclude='**/tmp' --exclude='*.sock' --exclude='/var/log' --exclude='/var/cache' \
  --tag host:blog-vps
```

排除*可重新生成*的东西，而不是*难搞*的东西：最经典的翻车，是排除了构建目录，后来才
发现重新构建需要一个你已经没有的工具链和网络。关于「数据库 vs 文件」的区分，以及更
完整的 3-2-1 讨论，我写在[能真正恢复的备份](/zh/posts/backups-you-can-restore/)里了；
如果仓库建在 ZFS 上，[ZFS 基础](/zh/posts/zfs-basics/)讲了快照那一半。

## 给演练排班：一个定时器加一个 dead man's switch

一个要靠你记着去跑的备份，只是一个愿望。把它放到 systemd 定时器上，并且——更重要
——把它的*缺席*变成告警。

```ini
# /etc/systemd/system/restic-backup.timer
[Unit]
Description=Run the nightly restic backup

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
```

`Persistent=true` 意味着 03:30 时关机的机器，会在下次启动时补跑一次，而不是悄悄跳过
一天。service 跑脚本，`OnFailure=` 给失败一个去处：

```ini
# /etc/systemd/system/restic-backup.service
[Unit]
Description=Nightly restic backup
OnFailure=notify-admin@%n.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/restic-backup.sh
```

真正的安全网是一个 **dead man's switch**：备份必须*回来报到*，而告警在没有报到时
触发。成功时在脚本最后一行 ping 一个心跳服务，所以只有上面每一步都退出 0，它才会执行：

```bash
# /usr/local/bin/restic-backup.sh  (tail)
set -euo pipefail
restic backup /srv /etc --tag host:blog-vps
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune
restic check

# dead man's switch: this only fires if every step above succeeded
curl -fsS --retry 3 https://hc-ping.com/your-uuid-here
```

一个监控服务——healthchecks、Uptime Kuma，或者一个去 ping `/fail` 端点的 cron——会在
心跳没到时报你。再配一个直接的陈旧度检查，这样连「任务成功了但不再产出新 snapshot」
也能抓到：

```bash
# Alert when the newest snapshot is more than 30 hours old
latest=$(restic snapshots --latest 1 --json | jq -r '.[0].time')
age=$(( ( $(date +%s) - $(date -d "$latest" +%s) ) / 3600 ))
[ "$age" -lt 30 ] || echo "backup stale: ${age}h" | mail -s "backup stale" me@example.com
```

对「陈旧」告警，而不是对「成功」告警。每一种静默失败——过期的桶凭证、被一次升级
禁用的定时器、写满的磁盘——都会表现为「没有新的、已验证的 snapshot」，而这正是
dead man's switch 能注意到的东西。

## 那些悄悄让你失去一切的反模式

- **同盘备份。** 最常见的「备份」是原始数据旁边的一个文件夹。一块死盘，或者一次手抖
  的 `rm -rf`，两份一起没。
- **不做校验。** 一个退出码为 0 的任务，加上一次你从没跑过的恢复，就是盖着绿色对勾的
  传闻。`check --read-data` 证明字节；演练证明流程。两样都要，而且要排进日程。
- **仓库密码没有安全保存。** `restic init` 已经在它自己的输出里警告过你：丢了密码，
  数据就永久没了。把它放进密码管理器，并且写在纸上，锁进一个你伸手能拿到的抽屉。
- **想要历史，却用了镜像。** `rsync --delete` 和卷快照会复制你的删除和损坏。至少留
  一个带版本历史和保留策略的目标。

一个脚本、一个定时器、一个 dead man's switch，再加一次你真的会跑的恢复演练，胜过任何
仪表盘。工具是免费的；纪律才是全部成本。一个你恢复过的备份不是传闻——它是你自己拥有
的事实。
