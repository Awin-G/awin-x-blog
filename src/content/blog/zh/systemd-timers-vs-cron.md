---
title: "systemd 定时器 vs cron：我为什么不再用 cron 了"
description: "一篇务实的 systemd 定时器与 cron 对比：同一个任务分别写成 crontab 一行和 .service + .timer 一对，涵盖 journalctl 日志、Persistent=true 补跑、OnCalendar 语法、RandomizedDelaySec、资源限制、环境变量处理，以及 systemd-analyze calendar 技巧——最后诚实聊聊什么时候 cron 依然是对的。"
pubDate: 2026-10-20
lang: zh
translationKey: systemd-timers-vs-cron
tags: [systemd, linux, devops]
featured: false
keywords:
  - systemd 定时器 vs cron
  - systemd timer
  - OnCalendar
  - cron 替代方案
  - systemd-analyze calendar
  - journalctl
---

我用 cron 用了好几年，从没多想。直到我开始部署真正要紧的东西——这个博客、几个小
API、一个每晚的备份——cron 的失效模式就开始持续让我付出时间代价。任务静默消失；
一个「每晚都跑」的备份其实已经十一天没跑了；排查问题就是 grep `/var/log/syslog`
然后靠猜。

于是我把调度搬到了 systemd。不是因为信仰，而是因为这些问题的解法早就装在那台机器
上了。这就是我当初想先读到的、关于 **systemd 定时器 vs cron** 的诚实对比：同一个任务
两种写法、一条迁移路线，以及我如今仍然会用 cron 的场景。

## systemd 定时器 vs cron：一句话版本

**systemd timer** 不是用来替代 crontab 的调度器，它是一个 `.timer` 单元，用来触发一个
`.service` 单元。真正的工作写在普通的 service 定义里，因此它顺带继承了 systemd 本来
就会做的一切：依赖排序、journal 日志、cgroup、以及按单元隔离的沙箱。这几件事 cron
都得各自准备一套答案，而大多数情况下它的答案是「默认什么都没有」。

代价也是真实的：cron 是一行，systemd 定时器是两个小文件。如果你的任务只是在一台玩具
机器上 `echo hi >> /tmp/log`，那 cron 赢在省事。但只要这个任务存在一个你必须看得见的
失效场景，这两个文件就开始回本了。

## 同一个任务，两种写法

任务是这样：每晚 03:30，把数据库备份并传输到别处。

cron 版本是 `/etc/cron.d/backup` 里的一行——这既是它的吸引力，也正是它的问题所在：

```cron
# /etc/cron.d/backup
30 3 * * * backup /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1
```

systemd 版本是一个 service 加一个 timer。工作放在 service 里：

```ini
# /etc/systemd/system/backup.service
[Unit]
Description=Nightly database backup
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=backup
Group=backup
ExecStart=/usr/local/bin/backup.sh

# 由 cgroup 强制执行的资源限制与超时
MemoryMax=512M
CPUQuota=80%
TimeoutStartSec=30min

# 零成本的加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/backup
```

timer 只负责调度：

```ini
# /etc/systemd/system/backup.timer
[Unit]
Description=Run the nightly backup

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

用 `systemctl enable --now backup.timer` 启用。注意这对文件给了你 cron 那行根本无法
表达的东西：内存上限、CPU 配额、硬超时、受限的文件系统、抖动、以及补跑——全都在单元
里，而不是在一个你必须记得去加固的 shell 脚本里。

## 日志：journalctl 对比「祈祷」

cron 会把 `stdout`/`stderr` 邮件到 `MAILTO`——在一台没有 MTA 的机器上，这封邮件直接
消失；在有 MTA 的机器上，它进了一个没人看的邮箱。那句话就是那个「十一天前的备份」
bug 的完整解释。

用定时器时，service 的输出会自动进入 journal，并带上单元名：

```bash
# 这个任务说过的所有话
journalctl -u backup.service

# 只看最近一次运行
journalctl -u backup.service --since "1 day ago"

# 测试时实时跟随
journalctl -fu backup.timer
```

`--since`、`--until`、`-o json`、跨重启的持久化存储、以及日志轮转，全都免费。这是我
换过来的最大理由：排查第一步从「grep syslog 然后祈祷」变成了「一条不可能出错的命令」。

## 依赖与排序

cron 里没有「等网络通了再跑，然后跑那个」这种概念。你要么用 `&&` 把命令串起来，要么
加个 `sleep 30` 然后听天由命。这份听天由命，正是我见过的半数 crontab 都以一个 sleep
开头的原因。

systemd 定时器可以依赖真实的单元。上面 service 里的 `After=`/`Wants=network-online.target`
意味着：网络真的在线之前，systemd 不会启动备份。你同样可以对一个数据库、一个挂载点
或另一个服务做排序；而且一旦顺序不满足，systemd 会拒绝运行，而不是让它莫名其妙地
失败。

## OnCalendar：能读懂的调度语法

cron 的五个字段紧凑到让 `0 3 */2 * 5` 变成一道谜题。**OnCalendar** 表达式用几个字符
换来了可读性：

```ini
OnCalendar=*-*-* 03:30:00        # 每天 03:30
OnCalendar=Mon *-*-* 04:00:00    # 每周一 04:00
OnCalendar=*-*-1 02:00:00        # 每月 1 号
OnCalendar=Mon..Fri 09:00        # 工作日 09:00
OnCalendar=*:0/15                # 每 15 分钟
```

它覆盖了 cron 的能力，还支持亚分钟间隔和星期名称，读起来就是从左到右「日期，然后
时间」。两个坑要记住：只写 `OnCalendar` 而不加 `Persistent=true` 的定时器，会静默
跳过机器关机期间本该触发的那一次；而多行 `OnCalendar` 是取并集叠加（每一行都是独立
触发器），而不是覆盖。

## systemd-analyze calendar：那一个技巧

你不用猜某个表达式是不是你以为的意思。systemd 自带一个校验器，它会打印出人话解释
以及接下来几次的触发时间：

```bash
$ systemd-analyze calendar "Mon..Fri *-*-* 09:00:00"
  Original form: Mon..Fri *-*-* 09:00:00
Normalized form: Mon..Fri *-*-* 09:00:00
    Next elapse: Mon 2026-10-26 09:00:00 CST
       (in UTC): Mon 2026-10-26 01:00:00 UTC
       From now: 14h left
```

`Normalized form` 告诉你 systemd 实际解析成了什么——这是抓出星期或时区错误最快的
办法。`Next elapse` 证明调度就是你想要的那个。我在启用任何新定时器前都会先跑一遍，
它抓到的 bug 比任何 code review 都多。

## Persistent=true：补跑错过的执行

这是我当初不知道自己需要的 **cron 替代方案** 特性。`Persistent=true` 让 systemd
记住定时器上次触发的时间；如果预定的时刻在机器关机或休眠时错过了，它会在下次开机时
补跑一次。

对于备份、证书续期或缓存预热来说，这才是正确行为：这个任务有活要干，而不是有截止
时间要守。用 cron 的话，一台在 03:30 关机的机器就是直接丢掉当天的备份；除非你主动
检查，否则一周内你都不会知道。

## 精度与 RandomizedDelaySec

还有两个旋钮，cron 只能靠 sleep 去伪造。`AccuracySec` 让 systemd 合并唤醒——默认是
1 分钟，放宽它能让内核批量处理定时器以省电。`RandomizedDelaySec` 加上抖动，当许多
机器跑同一个任务、你又不希望它们在同一秒一起打某个服务器时，这就很重要：

```ini
[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=600
AccuracySec=1min
```

十分钟抖动，由调度器自己铺开，只要一行。cron 的等价物是脚本里的
`$((RANDOM % 600))` 加一个 `sleep`，而且它会对你撒谎——你无法确知任务到底几点开始。

## 资源限制与环境变量

cron 跑你的任务时，环境几乎是空的。`PATH` 被截断，`~/.bashrc` 不会被 source，而最
经典的 bug 就是：脚本在你 shell 里能跑，在 cron 下就失败，因为 `node`、`npm` 或某个
virtualenv 不在 `PATH` 上。解法是在每个脚本里硬编码路径，或者每次 source 一份 profile。

systemd service 会显式声明它的环境，没有隐形状态要猜：

```ini
[Service]
Environment=PATH=/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-/etc/backup/env
```

`EnvironmentFile=-`（那个 `-` 表示「文件不存在也没关系」）就是放密钥和按主机取值的地方。
除了环境，单元还通过 cgroup 拿到真正的资源控制——`MemoryMax=`、`CPUQuota=`、
`TasksMax=`、`IOWeight=`——cron 对这些完全没有对应物。跑飞的进程会被杀掉，而不是把
整台机器吃掉。

## systemd 定时器失败时，你看得见

失败可见性是两者差别最大的地方。cron 任务失败，就是日志里的一行，或者一封你从没配置
过的退信。而一个失败的 systemd 单元是一种一等状态：

```bash
systemctl list-timers --all          # 下次何时触发，上次何时跑的
systemctl status backup.service      # 退出码、退出原因、最后的日志
systemctl --failed                   # 机器上所有坏掉的单元
```

单是 `list-timers` 就值回迁移成本：它显示下次触发、上次触发、以及距今多久——这种调度
视图 cron 从来没给过你。而且因为失败的单元对整个系统可见，你可以给单元挂上
`OnFailure=` 去触发一个通知服务，或者在监控里对 `systemctl --failed` 报警。失败不再
是静默的了。

## 从 cron 迁移到 systemd 定时器

迁移是机械的，而且可以一个任务一个任务地做：

1. 把脚本写好，让它的退出码诚实——`set -euo pipefail`，失败时返回非零。systemd 靠
   这个退出码判断成败。
2. 每一行 crontab 转成一个运行该脚本的 `.service`，加一个 `OnCalendar` 与旧调度一致的
   `.timer`。
3. 用 `systemd-analyze calendar` 验证调度。
4. `systemctl daemon-reload`，然后 `systemctl enable --now name.timer`。在信任它之前，
   用 `journalctl -u name.service` 检查紧接着的第一次运行。
5. 注释掉（不要删）原来那行 cron，两个一起跑几天，再删掉它。在你摸清定时器脾气之前，
   多一层保险。

一个定时器只放一个任务。把十个任务打包进一个 service，意味着一个任务失败就把整个单元
标记为失败，而你看不出是哪一个。如果你的旧调度用的是「每 N 分钟」或 `@reboot`，
对应的定时器写法就是 `OnUnitActiveSec=1h` 和 `OnBootSec=`。

## 什么时候 cron 依然是对的

我不是在劝你把 cron 从所有地方拆掉。下列情况下，cron 仍然是更好的选择：

- **系统很小或很精简。** Alpine、BusyBox、一个没有 systemd 的容器、一台路由器——
  cron（或 `crond`）在，systemd 不在。当平台只支持一行时，两个文件比一行更糟。
- **你想要用户级 crontab。** 每个用户的 `crontab -e` 就以该用户身份运行，不必动
  root 权限，在共享机器上确实方便。systemd 用户定时器是存在，但需要
  `loginctl enable-linger` 和一个运行中的用户管理器，对个人 `crontab -e` 来说活动
  部件更多。
- **它是用完就扔的。** 实验用虚拟机上的一次性 `@reboot`，或者下周就删掉的任务，
  不值得一个单元文件和一次 `daemon-reload`。

我用的规则是：小而一次性、或没有 systemd 的场景用 cron；只要一个任务「悄悄停了」会让
我难受，就用 **systemd timer**。如果一个任务的失败会让我丢数据、错过续期、或者浪费一个
下午去排查，它就该待在单元里。

这就是我从 cron 搬走的全部理由。不是说 cron 坏了——它没坏——而是对于要紧的任务，
journal、依赖、`Persistent=true` 补跑，以及一个会说真话的 `systemctl status`，本来
就都在机器上。本站跑的就是同一套机制；如果你想看一台机器如何靠它完成所有这些，读
[不用 Docker 的自托管](/zh/posts/self-hosting-without-docker/) 和
[这个博客如何自己发布自己](/zh/posts/how-this-blog-ships-itself/)。
