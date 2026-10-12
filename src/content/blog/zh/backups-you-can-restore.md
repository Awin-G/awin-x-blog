---
title: "能真正恢复的备份：给个人 homelab 的 3-2-1 backup"
description: "一份务实的 3-2-1 backup 策略，写给只有一个人的 homelab：为什么唯一重要的指标是恢复成功而不是备份成功；该备份什么（数据、配置、密钥）；为什么拷贝正在运行的数据库是个陷阱；rsync、restic、borg 之间怎么选；如何用脚本加定时器搭一个「运行并校验」的循环；以及如何在你需要之前真正跑一次 test restore。"
pubDate: 2026-10-23
lang: zh
translationKey: backups-you-can-restore
tags: [self-hosting, linux, devops]
featured: false
keywords:
  - 3-2-1 backup
  - restic
  - 备份策略
  - test restore
  - 异地备份
---

每篇讲备份的文章都用同一句话开头：没人测试自己的备份。这话没错，但也无用，因为
它从不说该怎么做。下面是我当初给一台机器的 homelab 制定 **backup strategy** 时想读到
的版本。整套东西只靠一个想法立住：**3-2-1 backup** 不是一个你跑的任务，而是一句你得
去证明的断言——而唯一的证明方式，是你**真的执行过**一次 **test restore**。我用
**restic** 让这件事变得可证明。

我跑一台公网 VPS、一个 overlay 网络，以及几个小服务。影响范围不大，但那依然是我的
数据：博客源码、一个 Gitea 实例、配置、一个密码库、一份邮件队列。丢了任何一样都要
搭进去一个周末。所以备份不是打勾，它是这台机器上我唯一允许既无聊又吵闹的系统。

## 唯一重要的指标是恢复成功

备份完成，是一个承诺。恢复完成，是一个事实。它们不是同一件事，而两者之间的落差，
就是几十年来勒索软件和宕机栖息的地方。

`restic backup` 退出码是 0，`rsync` 退出码是 0，你的厂商快照标着一行绿色的
「successful」。这一切只证明数据被挪到了某处。它不证明数据可读、完整、能用你仍然
持有的密钥解密，也不证明它能恢复成一个能跑的服务。我亲眼见过一个「绿色」的每夜
任务产出被截断的归档，只因为拷贝途中磁盘写满，而退出码依然是 0。

所以我追踪的指标不是「上次备份：OK」，而是：

- 我上一次恢复东西并且成功了，是什么时候？
- 那次恢复是否包含让服务重新启动所需的配置和密钥？
- 我有没有计时，好知道真实的 RTO？

其他一切——工具、计划、异地桶——存在的意义都是为了服务这个数字。如果你从没恢复过，
你拥有的只是一个假设，不是备份。

## 把 3-2-1 backup 规则重新讲给真人听

经典规则：数据的 **3** 份副本，放在 **2** 种不同介质上，其中 **1** 份异地。对一个有磁带
库的团队，这是字面意思。对一个人，它需要翻译。

- **3 份副本**，意味着你的工作副本加上两份备份。大多数人的那份「备份」，其实是同一
  块盘另一个文件夹里的副本。那等于零份备份。
- **2 种介质**，实践上指两个失效域：本地磁盘，以及*另一台*机器或云桶。同一台机器里的
  第二块盘，只是给一台已经死掉的机器多存一份副本。
- **1 份异地**，意味着即使你的房子、你的房东，或者你的服务商删了你的账号，这份副本
  还活着。如果一场火、或一次被入侵会话里的 `rm -rf` 能够到所有副本，那你就等于没有。

我对「单机 homelab」的翻译是：VPS 上一份工作副本，overlay 网络上另一台主机上一个
restic 仓库，再加异地对象存储上一个 restic 仓库。两个工具，或一个工具两个目标——
都行。重点是两个相互独立的目标。

## 该备份什么：数据、配置、密钥

错误做法是备份「这台服务器」。你想要的不是服务器回来，而是服务回来。这拆成三类东西，
需要区别对待。

- **数据**——你无法重新生成的东西：数据库、博客的 markdown、上传的文件、邮件队列、
  密码库。这才是备份真正为之存在的东西。丢了就永远没了。
- **配置**——`nginx` 站点、systemd 单元、类 compose 文件、crontab、`.env`、防火墙规则。
  通常很小，而且往往正是让一次恢复耗时一小时还是十分钟的区别。备份它，能放进版本
  控制就放进去。
- **密钥**——TLS 私钥、数据库密码、API token、SSH 主机密钥。要备份，但要*加密*备份，
  永远不要明文进 git。一次把数据带回来、却没带回解密密钥的恢复，等于什么都没恢复。

### 数据库与文件的区别，以及为什么拷贝热库是个陷阱

文件和数据库想要的东西不一样。文件通常很安静——拷字节，它就是那些字节。正在运行的
数据库不是。在引擎写盘时拷贝 `data/` 或那个 `.sqlite` 文件，产出的是一个撕裂、不一致的
文件，它可能看起来没问题却打不开，也可能打开了、却静默地少了一笔事务。这就是陷阱：
一个在文件系统层面成功、在数据层面失败的备份。

你有两个诚实的选项。先 dump 再备份，可移植且一致：

```bash
# Postgres：产出一份一致的逻辑 dump，然后备份这份 dump
pg_dump --format=custom --file=/srv/backup/db.dump mydb
restic backup /srv/backup/db.dump

# SQLite：用内置的在线备份，绝不要裸 cp 一个正在写的文件
sqlite3 /var/lib/app/app.db ".backup '/srv/backup/app.db'"
```

或者用文件系统快照（LVM、ZFS、btrfs），然后备份快照——它天然一致。不能作为选项的，
是对一个正在运行的数据库目录伸手 `cp` 或 `rsync`，然后称之为完工。要么 dump，要么
快照。

## 工具分级：rsync、restic、borg、厂商快照

没有哪个工具能通吃。每个问题各有一层工具。

- **rsync**——是镜像，不是备份。适合配置和大量冷数据，快，到处都有。它的缺陷就是
  镜像本身：你删一个文件，它跟着删副本；你要是中了勒索软件，镜像跟着一起沦陷。可以
  用，但要知道它给你的是一份实时副本，不是历史。
- **restic**——我的默认选择。单个静态二进制，默认加密，内容寻址、可去重，基于快照
  并支持保留策略，既能对本地仓库也能对对象存储（S3、B2、rclone）。它给你版本历史
  和真正的完整性校验。
- **borg**——另一个正经选项。去重和压缩出色，某些负载下更快，并且强制更严格的仓库
  模型。你要是已经熟悉 borg，就继续用 borg；这里的论点不是 borg 对 restic，而是
  带保留策略的快照，对单纯的镜像。
- **厂商快照**——ZFS send、btrfs 快照、云厂商卷快照。作为*第三*份副本没问题，作为唯一
  副本则危险：它们与磁盘处在同一个失效域，往往无法导出，而快照和原始数据一样，谁拿着
  API 密钥谁就能删。

### 为什么加密、去重、异地的备份重要

三个特性，三个具体理由。

- **加密**：异地副本是别人的机器。对象存储会被入侵，被偷的笔记本上放着你整个仓库，
  服务商能看到你的桶。一份未加密的异地备份，是你亲手安排的数据泄露。让字节在离开
  这台机器之前就加密，远端永远看不到明文。
- **去重**：你才养得起保留很多版本。每晚做全量拷贝，正是人们只敢留三天历史的原因。
  去重让 `--keep-daily 7 --keep-weekly 4 --keep-monthly 12` 变得便宜，于是一个月后才
  发现的错误依然能救回来。
- **异地**：副本必须能挺过它来源地点的故障。本地磁盘、火灾、被入侵的登录，除非有一份
  副本在完全不同的地方，否则它们是同一个事件。

## 一个具体的 restic 备份策略

下面是完整的做法：一个仓库放在第二台主机上作本地仓库，再加第二个异地目标。一次性
初始化：

```bash
# 初始化一个加密仓库。这个命令不会备份它自己的密码——
# 把密码存进你的密码库，否则你就只能永远留着这堆密文了。
export RESTIC_REPOSITORY=sftp:backup@second-host:/srv/restic/blog
export RESTIC_PASSWORD_FILE=/etc/restic/blog.pass
restic init
```

每夜备份，带排除规则，退出码即一次性完整性信号：

```bash
#!/usr/bin/env bash
# /usr/local/bin/backup.sh
set -euo pipefail
export RESTIC_REPOSITORY=sftp:backup@second-host:/srv/restic/blog
export RESTIC_PASSWORD_FILE=/etc/restic/blog.pass

pg_dump --format=custom --file=/srv/stage/db.dump mydb
sqlite3 /var/lib/app/app.db ".backup '/srv/stage/app.db'"

restic backup /srv/stage /etc /srv/www \
  --exclude='*.sock' --exclude='*/cache/*' --tag host:vps

# 保留策略：留真正的历史，而不只是昨晚
restic forget \
  --keep-daily 7 --keep-weekly 4 --keep-monthly 12 \
  --prune

# 回读仓库的随机一小部分并校验校验和
restic check --read-data-subset=5%
```

然后是异地目标，同一个脚本、第二个仓库——`restic copy` 把快照搬进去，而不必维护两份
各自独立的、得分别裁剪的历史：

```bash
export RESTIC_REPOSITORY=sftp:backup@second-host:/srv/restic/blog
restic copy --repo2 s3:s3.example.com/blog-backup
```

`restic forget` 是人们跳过、然后又纳闷仓库怎么变成 400 GB 的那一步。真正回收空间的
是 `--prune`；只 forget 只是把快照标记为待删除。而 `restic check
--read-data-subset=5%`，就是「元数据没问题」与「实际字节可读」之间的区别。偶尔在一个
不着急的夜里跑一次完整的 `restic check --read-data`，不必每晚都跑。

## 用「运行并校验」的循环做自动化

一个指望你记得去跑的 **backup strategy** 不是策略。把脚本挂到定时器上，并让这个循环
自我校验。我正是因此用 systemd：运行与它的校验都住在单元里，而失败是一种可见状态，
不是没人读的日志里的一行。

```ini
# /etc/systemd/system/backup.timer
[Unit]
Description=Run the nightly backup

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
```

`Persistent=true` 是关键的一行：如果 03:30 时机器是关着的，任务会在下次开机时补跑
一次，而不是静默跳过一天。给这个定时器配一个跑 `backup.sh` 的 service，再加一个真正
能通知到你的 `OnFailure=` 单元，或者一小段「最新快照超过 48 小时就告警」的检查：

```bash
# 最新快照太旧就告警——也就是任务悄悄停了
LATEST=$(restic snapshots --latest 1 --json | jq -r '.[0].time')
AGE=$(( ( $(date +%s) - $(date -d "$LATEST" +%s) ) / 3600 ))
[ "$AGE" -lt 48 ] || echo "backup stale: ${AGE}h" | mail -s "backup stale" me@example.com
```

校验的一半比运行的一半更重要。「定时器响了」不等于「备份是好的」。把「没有新的、
已验证的快照」这件事本身变成一个告警。

## test restore 的仪式：跑一次恢复演练

这一节，才是把「备份」变成「可恢复的备份」的地方。每季度一次，真正恢复，恢复到一块
临时位置，并计时。不是 `restic ls`，是一次真正的恢复。

```bash
# 先列出你有什么，然后把某个快照恢复到临时目录
restic snapshots
restic restore latest --target /tmp/restore --include /srv/www

# 证明数据库 dump 是可用的，而不只是存在
mkdir /tmp/restore/db && cd /tmp/restore/db
pg_restore --clean --if-exists --dbname=restore_test /tmp/restore/srv/stage/db.dump

# 再证明文件就是那些文件
diff -rq /tmp/restore/srv/www /srv/www | head
```

演练有三个问题，你要逐个大声回答：恢没恢复成功，它能不能跑起来，花了多长时间？如果
恢复出来的服务因为 `.env` 不在备份里而启动不了，那你是用了一个安静的下午发现了这个
bug，而不是在磁盘坏掉之后的凌晨两点。一次做过的 **test restore**，比任何仪表盘都值钱。

让这个仪式保持便宜很重要——如果它要一小时的手工搭建，你就会跳过它。把演练也自动化：
每周把最新快照恢复到一个临时 VM，启动服务，`curl` 它的健康检查端点，再拆掉。这样
每季度的人工演练，就只剩确认自动化没有说谎。

## 那些悄悄让你失去一切的 anti-pattern

- **备份在同一块盘上。** 最常见的「备份」就是原数据旁边的一个文件夹。一块盘坏，
  两份一起没。一次 `rm -rf`，两份一起没。它不过是你自己错误的快照，仅此而已。
- **没测试过的备份。** 一个你从没恢复过的备份，是一个带着绿色对勾的希望。在恢复成功
  之前，你没有备份；你有一份副本和一种感觉。
- **会静默失败的备份任务。** 输出流向虚空的 cron 行、升级后没被重新启用的定时器、
  凭据过期的云桶——它们全都*悄无声息地*失败，而且一失败就是几周。唯一的解法是对
  「过期」告警，而不是对「成功」告警：当最新的已验证快照太旧时就报警，你就能抓住
  上面每一种情况，包括你没能预见的那些。
- **想要历史，却搭了镜像。** `rsync --delete` 和卷快照会连同你的删除和损坏一起复制。
  至少保留一个带版本历史和保留策略的目标。
- **密钥放错地方。** 密钥在备份里却不在密码库，或者反过来在密码库却不在备份里，都是
  一种丢失访问权的方式。有意识地做决定，然后测一遍。

这些没有一样是玄学。一个脚本、一个定时器、两个相互独立的加密目标、一条保留策略，
再加一次你真的会跑的恢复演练。工具是免费的；纪律才是全部成本。如果你想看看跑这套
东西的那台机器的整体背景，可以先读[我在 2026 年自建了什么](/zh/posts/what-i-self-host-2026/)
和[不用 Docker 的自托管](/zh/posts/self-hosting-without-docker/)——备份的好坏，取决于它要
带回来的那些服务。
