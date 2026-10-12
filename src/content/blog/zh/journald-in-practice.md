---
title: "journalctl 实战：你其实早就在用的 systemd journal"
description: "在一台真实的 Arch 主机上实操 journalctl：按 unit、优先级、时间过滤，实时跟踪日志，读取 _SYSTEMD_UNIT、_PID 等日志字段，写入自定义字段，用 -o json 做脚本化统计，以及用 --disk-usage 和 vacuum 管理 journald 日志保留。"
pubDate: 2027-01-13
lang: zh
translationKey: journald-in-practice
tags: [systemd, linux]
featured: false
keywords:
  - journalctl
  - systemd journal
  - 结构化日志
  - journald 日志保留
  - -o json
---

上周我的组网机器开始抽风：一条隧道每几秒重连一次，一整天不停。我的第一
直觉是错的——去翻日志文件。可这台机器上没有 `/var/log/syslog`，没有
`rsyslogd`，没有任何文件可以 tail。一切都已经在 **systemd journal** 里
了，而 `journalctl` 就是随系统附带的查询工具。下面就是我希望当年有人给
我讲的那趟课，全部输出都来自这台真实机器（systemd 262、Arch、uid 1000、
没有 root）。

## systemd journal 是什么，又不是什么

你其实早就有日志收集器了：`systemd-journald`，开机起一直在跑：

```
$ systemctl status systemd-journald --no-pager | head -5
● systemd-journald.service - Journal Service
     Loaded: loaded (/usr/lib/systemd/system/systemd-journald.service; static)
     Active: active (running) since Mon 2026-10-12 04:12:29 CST; 1 day 2h ago
 Invocation: 2b2b752b93d34dceb14e1636a48c33e9
TriggeredBy: ● systemd-journald-dev-log.socket
```

有四条通道喂它，每条日志都会记住自己从哪条通道来
（`_TRANSPORT`）：unit 的 stdout/stderr、`/dev/log` 这个 syslog 套接字、
内核 `kmsg`、以及 systemd 自己。

<figure>
<svg viewBox="0 0 640 250" width="100%" role="img" aria-label="journald 的四条输入通道：unit 的 stdout/stderr、/dev/log syslog 套接字、内核 kmsg、systemd 自身。journald 写入带索引的日志文件，对外提供 journalctl、journal-remote、gatewayd 与 vacuum。">
  <g fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="10" y="15" width="180" height="50" rx="8"/>
    <rect x="10" y="80" width="180" height="50" rx="8"/>
    <rect x="10" y="145" width="180" height="50" rx="8"/>
    <rect x="10" y="210" width="180" height="50" rx="8"/>
    <rect x="255" y="80" width="120" height="120" rx="8" stroke-dasharray="4 3"/>
    <rect x="430" y="15" width="200" height="50" rx="8"/>
    <rect x="430" y="80" width="200" height="50" rx="8"/>
    <rect x="430" y="145" width="200" height="50" rx="8"/>
    <rect x="430" y="210" width="200" height="50" rx="8"/>
  </g>
  <g stroke="currentColor" stroke-width="1.2" marker-end="url(#ah)">
    <line x1="195" y1="40" x2="250" y2="115"/>
    <line x1="195" y1="105" x2="250" y2="135"/>
    <line x1="195" y1="170" x2="250" y2="155"/>
    <line x1="195" y1="235" x2="250" y2="175"/>
    <line x1="380" y1="140" x2="425" y2="40"/>
    <line x1="380" y1="140" x2="425" y2="105"/>
    <line x1="380" y1="140" x2="425" y2="170"/>
    <line x1="380" y1="140" x2="425" y2="235"/>
  </g>
  <defs>
    <marker id="ah" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-size="12" fill="currentColor" font-family="sans-serif">
    <text x="25" y="45">unit stdout/stderr</text>
    <text x="25" y="110">/dev/log（syslog 接口）</text>
    <text x="25" y="175">内核 kmsg</text>
    <text x="25" y="240">systemd 自身</text>
    <text x="272" y="145" text-anchor="middle">journald</text>
    <text x="443" y="45">journalctl（查询）</text>
    <text x="443" y="110">日志文件（带索引）</text>
    <text x="443" y="175">remote / gatewayd</text>
    <text x="443" y="240">vacuum / rotate</text>
  </g>
</svg>
<figcaption>日志从四扇门进来；受信任的 <code>_TRANSPORT</code> 字段告诉你每条日志走的是哪扇门（<code>stdout</code>、<code>syslog</code>、<code>kernel</code>、<code>journal</code>）。</figcaption>
</figure>

一条日志不是一行文本，而是一组 key=value 字段：消息本体、优先级，以及
一批受信任的元数据（`_PID`、`_SYSTEMD_UNIT`、`_BOOT_ID`、`_HOSTNAME`、
`_SOURCE_REALTIME_TIMESTAMP` 等），以带索引的二进制文件存放在
`/var/log/journal/<machine-id>/` 下。这正是它和纯文本文件的区别：文本日志
里「PID 582 在 06:00 到 06:02 之间打了什么」是 grep 加祈祷，在 journal 里
是索引查询。字段为什么胜过散文，我在
[真正能在凌晨三点帮你排障的结构化日志](/zh/posts/structured-logging/) 里
展开过。反面同样真实：这些是本地的、二进制的、单机的文件。journal 是很
好的*收件箱*，不是仓库。

## 我实际在用的 journalctl 命令

主角是 `easytier.service`，一条对端已经不在这个世界上的组网隧道。它
……相当能说：

```
$ journalctl -u easytier.service -b --no-pager | wc -l
314214
```

```
$ journalctl -u easytier.service -b -p err --no-pager
-- No entries --
```

314,214 行，**零条 error**——因为应用把自己的失败记成了 `INFO`：消息正文
里有「error」这个词，而 `PRIORITY=6` 说的却是另一回事。`-p` 过滤的是字
段，不是文本。这是最常见的 journalctl 陷阱：**严重级别是应用自己选的，
不是消息表面看起来的样子。**

那就按时间开窗：

```
$ journalctl -u easytier.service --since '2026-10-13 06:00' --until '2026-10-13 06:02' \
    --no-pager -o short-iso | head -5
2026-10-13T06:00:00+08:00 BOOK easytier-core[582]: 2026-10-13T06:00:00.661586273+08:00  INFO CORE::INSTANCE::CONNECTION: [f631f13d-e15a-4f52-9b05-8175b9e65788] connecting to peer dst=tcp://10.19.36.13:11010
2026-10-13T06:00:00+08:00 BOOK easytier-core[582]: 2026-10-13T06:00:00.723220791+08:00  INFO CORE::INSTANCE::CONNECTION: [f631f13d-e15a-4f52-9b05-8175b9e65788] connect to peer error dst="tcp://10.19.36.13:11010" ip_version="V4" error=TunnelError(
2026-10-13T06:00:00+08:00 BOOK easytier-core[582]:     IOError(
2026-10-13T06:00:00+08:00 BOOK easytier-core[582]:         Os {
2026-10-13T06:00:00+08:00 BOOK easytier-core[582]:             code: 113,
```

`No route to host`，每两秒一次，持续一整天。对端已经不在这个网络里。
「06:00 到 06:02 之间发生了什么」是一对参数的事，不是 `sed` 范围的事。
其余形成肌肉记忆的：

- `journalctl -b` 是本次启动，`-b -1` 是上一次；`--list-boots` 告诉你 `-1` 到底指哪次：

```
$ journalctl --list-boots
IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY
 -2 1add3ab9c2e54bf9a157e031a1d1a554 Wed 2026-10-07 23:52:32 CST Sun 2026-10-11 18:43:03 CST
 -1 e1957f396979484bab4890cf6b5e8e3d Sun 2026-10-11 18:43:35 CST Mon 2026-10-12 04:08:59 CST
  0 95dabdf369644974893a7d7afc7071aa Mon 2026-10-12 04:12:23 CST Tue 2026-10-13 06:10:04 CST
```

- `journalctl -f -t mytag`——带过滤的实时跟踪。我在 `-f` 已经跑起来之后一秒半，才启动写入方：

```
$ ( sleep 1.5; printf 'FOLLOW_TEST=works\n' | systemd-cat -t follow-demo ) &
$ timeout 4 journalctl -f -t follow-demo -o short-iso
2026-10-13T06:14:02+08:00 BOOK follow-demo[669473]: FOLLOW_TEST=works
```

  它不是 `tail -f`——是对整个 journal 的实时游标，过滤条件（`-u`、`-t`、
  字段匹配）在到达你屏幕之前就已经生效。
- `journalctl -k`——内核消息也是 journal 条目（本次启动这里 11,959 行），
  和 unit 日志一样可以按时间过滤。
- `journalctl -o cat`——只要消息本体，适合拿去找刷屏行：

```
$ journalctl -u easytier.service --since '1 hour ago' --no-pager -o cat | sort | uniq -c | sort -rn | head -3
   1664 )
    694         Os {
    694             message: "No route to host",
```

## 字段：文本文件里 grep 不出来的那一半

`journalctl -o verbose` 会把一条日志完整展开——这是一个 user service 停
止时的条目：

```
$ journalctl --user -u cookbook-heartbeat.service -n 1 -o verbose
Mon 2026-10-12 18:44:20.388473 CST [s=30e8d7b479634a969546b2b7c9da3775;i=2d9b99;b=95dabdf369644974893a7d7afc7071aa;m=c2e584e60;t=65da26165768a;x=3fee6115d101388f]
    PRIORITY=6
    SYSLOG_FACILITY=3
    TID=905
    SYSLOG_IDENTIFIER=systemd
    _TRANSPORT=journal
    _PID=905
    _UID=1000
    _GID=1000
    _COMM=systemd
    _EXE=/usr/lib/systemd/systemd
    _CMDLINE=/usr/lib/systemd/systemd --user
    _SYSTEMD_CGROUP=/user.slice/user-1000.slice/user@1000.service/init.scope
    _BOOT_ID=95dabdf369644974893a7d7afc7071aa
    _MACHINE_ID=b28faf4a0b4a42048f13d6be379f6b10
    _HOSTNAME=BOOK
    CODE_FILE=src/core/job.c
    CODE_LINE=632
    CODE_FUNC=job_emit_start_message
    USER_UNIT=cookbook-heartbeat.service
    MESSAGE=Stopping Cookbook heartbeat demo...
    JOB_TYPE=stop
    MESSAGE_ID=de5b426a63be47a7b6ac3eaac82e2f6f
    USER_INVOCATION_ID=ecd9732670d74c1487a52194a33ca23f
    JOB_ID=2724
    _SOURCE_REALTIME_TIMESTAMP=1791801860388473
```

带下划线的字段由 journald 设置，写日志的进程伪造不了；其余由发送方给。
过滤就是 `字段=值` 的形式：

```
$ journalctl -b --no-pager -o short-iso _PID=582 | head -2
2026-10-13T06:13:19+08:00 BOOK easytier-core[582]:     ),
2026-10-13T06:13:19+08:00 BOOK easytier-core[582]: )
```

```
$ journalctl -b --no-pager _TRANSPORT=kernel | wc -l
13061
```

一个坑了我十分钟的细节：`_SYSTEMD_UNIT=cookbook-heartbeat.service` 对
**用户** service 一无所获。user unit 落在 `_SYSTEMD_USER_UNIT`（服务自己
的行）和 `USER_UNIT`（管理器的作业消息）里——而且不带 `--user` 的
`journalctl -u X` 根本不匹配 user unit：

```
$ journalctl -u cookbook-heartbeat.service --no-pager -o short-iso -n 2
-- No entries --
$ journalctl --user -u cookbook-heartbeat.service --no-pager -o short-iso -n 2
2026-10-12T18:44:20+08:00 BOOK systemd[905]: Stopping Cookbook heartbeat demo...
2026-10-12T18:44:20+08:00 BOOK systemd[905]: Stopped Cookbook heartbeat demo...
```

### 写自己的字段（顺便辟个谣）

`systemd-cat -t TAG` 设置的是 `SYSLOG_IDENTIFIER`，这是真字段，可以用
`journalctl -t TAG` 过滤：

```
$ printf 'EVENT=deploy\nSTATUS=ok\nrequest_id=7f3a\n' | systemd-cat -t journald-demo
$ journalctl -t journald-demo -o cat
EVENT=deploy
STATUS=ok
request_id=7f3a
```

但那些 `KEY=value` 行**没有**变成字段——看结构化视图，每一行原样落进了
`MESSAGE`：

```
$ journalctl -t journald-demo -o json -n 1
{"SYSLOG_IDENTIFIER":"journald-demo","_PID":"668653", ..., "_TRANSPORT":"stdout", "MESSAGE":"request_id=7f3a", "PRIORITY":"6", "_UID":"1000"}
```

往 `systemd-cat` 管道 `KEY=value` 就是网上流传的「自定义字段」偏方，在
systemd 262 上它并不管用。真正有效的是原生 journal 套接字——它是一个
**数据报**套接字，所以 `printf ... | socat - UNIX-CONNECT:/run/systemd/journal/socket`
会以 `Protocol wrong type for socket` 失败（我试过）。一次 `sendmsg`
就行：

```python
import socket
s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
s.connect("/run/systemd/journal/socket")
s.send(b"MESSAGE=deploy note\nDEPLOY_ENV=prod\nREQUEST_ID=7f3a\n")
```

```
$ journalctl DEPLOY_ENV=prod --no-pager -o short-iso
2026-10-13T06:15:55+08:00 BOOK python3[673881]: custom field demo via native protocol
```

`DEPLOY_ENV=prod` 从此可索引。真实代码里用 `sd_journal_send()` 或语言绑
定效果相同；这个演示只是证明线上格式就是纯文本、由你定义——这就是给
cron 和 shell 脚本的日志盖 `REQUEST_ID=`、`ENV=`、`DEPLOY_SHA=` 的办
法。

普通的 `logger` 同样管用——它写 `/dev/log`，journald 本来就在听，所以
syslog 时代的工具原样能跑：

```
$ logger -t logger-demo -p user.info "hello from plain logger"
$ journalctl -t logger-demo --no-pager -o short-iso
2026-10-13T06:13:37+08:00 BOOK logger-demo[668656]: hello from plain logger
```

（`logger --journald` 在这台机器上以 `无法写入 journald 项` 失败——我的
shell 是 `zh_CN.UTF-8`，systemd 就用中文回话，这句的意思是「写入日志条
目失败」。`logger` 和 `systemd-cat` 都正常。）

## -o json：把 journal 当数据源

`-o json` 每条日志输出一个 JSON 对象，字段全带，包括 `__CURSOR`。这台机
器没有 `jq`，那就 `python3`。本次启动的话痨排行：

```python
journalctl -b --no-pager -o json | python3 -c '
import sys, json, collections
c = collections.Counter()
for line in sys.stdin:
    try: d = json.loads(line)
    except Exception: continue
    c[d.get("_SYSTEMD_UNIT") or d.get("_SYSTEMD_USER_UNIT")
      or d.get("SYSLOG_IDENTIFIER") or "?"] += 1
for u, n in c.most_common(6):
    print(f"{n:8d}  {u}")
'
```

```
  314214  easytier.service
   18197  mihomo.service
   12721  kernel
    9110  user@1000.service
    7437  ollama.service
    4333  init.scope
```

同样的形状可以出优先级直方图——本次启动 99.9% 是 `info`，`err` 25 条、
`crit` 15 条，就是这么知道的：

```
  368942  info
   10478  warning
     684  notice
     110  debug
      25  err
      15  crit
```

嫌字段多？`-o json --output-fields=MESSAGE,PRIORITY` 可以瘦身
（`__CURSOR` 这类受信任字段会保留，这是设计使然，方便你分页）。字段过滤
加 `--output-fields` 加游标，就是「程序化消费 journal」的全部内容。

那 15 条 `crit` 也说明了字段优于文本：`systemd-coredump` 条目的正文是
栈回溯，但结构化视图里 `COREDUMP_EXE`、`COREDUMP_SIGNAL_NAME`、
`COREDUMP_TID` 都是字段。「本次启动哪些二进制崩过？」就是
`journalctl -b COREDUMP_SIGNAL_NAME=SIGABRT`。文本日志上你试试。

## journald 日志保留：磁盘占用、vacuum，以及哪些需要 root

这台机器的 `/etc/systemd/journald.conf` 是出厂默认：

```
$ grep -nE 'Storage|SystemMaxUse|RuntimeMaxUse|MaxRetentionSec|ForwardToSyslog|MaxLevelStore' /etc/systemd/journald.conf
20:#Storage=persistent
21:#Compress=yes
22:#Seal=yes
23:#SplitMode=uid
27:#SystemMaxUse=
31:#RuntimeMaxUse=
35:#MaxRetentionSec=0
37:#ForwardToSyslog=no
42:#MaxLevelStore=debug
```

`Storage=` 被注释掉意味着 `auto`：因为 `/var/log/journal` 目录存在，日志
就落在这里（持久化，重启不丢）；否则落 `/run/log/journal`（tmpfs，重启
即失）。每次启动 journald 都会报告 runtime 那一半的额度——本次启动：

```
2026-10-12T04:12:23+08:00 archlinux systemd-journald[138]: Runtime Journal (/run/log/journal/f5f1729d1761426ebca70f7bd3e687e1) is 8M, max 236.6M, 228.6M free.
```

当前占用：

```
$ journalctl --disk-usage
Archived and active journals take up 292.8M in the file system.
```

<figure>
<svg viewBox="0 0 640 220" width="100%" role="img" aria-label="journald 日志保留机制：journald 轮转文件，用 SystemMaxUse= 限制磁盘总量、RuntimeMaxUse= 限制 tmpfs，压力下先删最旧的归档文件。--vacuum-size 与 --vacuum-time 则从最旧的一端成批清理归档。">
  <g fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="10" y="90" width="620" height="40" rx="8"/>
    <rect x="10" y="140" width="305" height="60" rx="8"/>
    <rect x="325" y="140" width="305" height="60" rx="8"/>
  </g>
  <g fill="currentColor" opacity="0.25">
    <rect x="24" y="102" width="44" height="16" rx="3"/>
    <rect x="72" y="102" width="44" height="16" rx="3"/>
    <rect x="120" y="102" width="44" height="16" rx="3"/>
    <rect x="168" y="102" width="44" height="16" rx="3"/>
    <rect x="216" y="102" width="44" height="16" rx="3"/>
    <rect x="264" y="102" width="44" height="16" rx="3"/>
    <rect x="312" y="102" width="44" height="16" rx="3"/>
    <rect x="360" y="102" width="44" height="16" rx="3"/>
    <rect x="408" y="102" width="44" height="16" rx="3"/>
    <rect x="456" y="102" width="44" height="16" rx="3"/>
    <rect x="504" y="102" width="44" height="16" rx="3"/>
    <rect x="552" y="102" width="44" height="16" rx="3"/>
  </g>
  <g stroke="currentColor" stroke-width="1.2" marker-end="url(#vh)">
    <line x1="590" y1="110" x2="590" y2="60"/>
  </g>
  <defs>
    <marker id="vh" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-size="12" fill="currentColor" font-family="sans-serif">
    <text x="10" y="80">较旧的归档文件（最先删）───── 较新的活动文件（正在写）</text>
    <text x="598" y="55" text-anchor="end">SystemMaxUse= / RuntimeMaxUse=</text>
    <text x="24" y="165">journalctl --vacuum-size=200M</text>
    <text x="339" y="165">journalctl --vacuum-time=2weeks</text>
    <text x="24" y="188">从最旧一端成批清理</text>
    <text x="339" y="188">从最旧一端成批清理</text>
  </g>
</svg>
<figcaption>保留策略有两半：<code>journald.conf</code> 里的自动上限（轮转，然后删最旧）和手动的 <code>--vacuum-*</code>。两者都从最旧一端删——<em>正在</em>写的那个永远不会是受害者。</figcaption>
</figure>

这些上限都配在 `journald.conf`：`SystemMaxUse=`（默认占文件系统 10%，
上限 4G）、tmpfs 那份的 `RuntimeMaxUse=`、以及硬性年龄截止的
`MaxRetentionSec=`。

现在是诚实部分——我是 uid 1000，vacuum 就轮不到我了。

```
$ journalctl --vacuum-size=50M
Vacuuming done, freed 0B of archived journals from /var/log/journal.
Vacuuming done, freed 0B of archived journals from /run/log/journal.
Failed to delete archived journal /var/log/journal/b28faf4a0b4a42048f13d6be379f6b10/system@30e8d7b479634a969546b2b7c9da3775-0000000000243587-00065d421a615ccd.journal: 权限不够
Vacuuming done, freed 0B of archived journals from /var/log/journal/b28faf4a0b4a42048f13d6be379f6b10.
```

`权限不够` 就是权限拒绝，每个删不动的文件报一次；它释放了 0 B，退出码
却仍是 0——所以要看这些错误行，别只看退出码。`--vacuum-time=2d` 表现
一模一样，而 `journalctl --rotate` 直接失败（`Failed to issue
io.systemd.Journal.Rotate() varlink call: 权限不够`）。vacuum 和轮转是
root（或 Polkit 授权）的活。读则不然：这里日志文件是
`root:systemd-journal 0640` 外加给 `wheel` 和 `adm` 的 ACL，而我在
`wheel` 组——所以一个非特权 shell 就能读本次启动全部 377,274 条日志：

```
$ journalctl -b --no-pager -o short-iso | wc -l
377274
$ journalctl --user -b --no-pager -o short-iso | wc -l
9934
```

journal 并不像 `/var/log/syslog` 那样人人可读。（`journalctl --verify`
会走查所有文件、逐文件打印 `PASS:`——机器崩过之后值得一跑。）

## 把日志送出 journal

默认配置让日志留在本地，这台机器就是活证：`ForwardToSyslog=no`，没装
rsyslog（`which rsyslogd` 一无所获），而随 systemd 附带的外发组件装
着、但关着：

```
$ systemctl status systemd-journal-remote --no-pager | head -3
○ systemd-journal-remote.service - Journal Remote Sink Service
     Loaded: loaded (/usr/lib/systemd/system/systemd-journal-remote.service; indirect; preset: disabled)
     Active: inactive (dead)
```

按搭建成本排序的选项：

1. `ForwardToSyslog=yes`——把所有日志重新发给 `/dev/log` 给 rsyslog。只有下游本来就吃 syslog 时才值得。
2. `systemd-journal-remote`——监听 UDP/TCP，接收别的机器发来的 journal 条目。
3. `systemd-journal-upload`——推送那一侧；和 remote 配对就是一套 systemd 原生的中心日志，不用额外软件。
4. `systemd-journal-gatewayd`——HTTP 访问，包括 `/entries?...&output=json`。
5. 你本来在跑的 shipper——Promtail 原生抓 journal，Filebeat 有 journald input，或者 `journalctl -o json -f --cursor <saved>` 接你自己的管道。

`__CURSOR` 就是那个书签：只发「游标 X 之后的所有」，批与批之间崩了也不
丢。

## 权衡，说实话

单机上任何短生命周期的东西——服务日志、cron 输出、内核消息、coredump、
「它为什么崩了」「谁重启了什么」——journal 全胜：结构化、带索引、按启动
和 unit 关联、贴着产出它的进程、而且默认就装。一台全新的 Arch 什么额外
软件都不用装就有这一切。

它输的地方：

- **长期保留是场硬仗。**「全留 90 天」是一个你会调过大的 `journald.conf` 参数，磁盘还要和别的所有东西分。vacuum 动手也总比你希望的晚。
- **天生单机。**联邦化意味着额外软件（remote、upload、gatewayd 或 shipper）。从你想要「12 台机器、一个查询、一套保留策略」那一刻起，你在做的就叫中心化——那是 Loki/ELK 的地盘，喂给它的正是同一份 `-o json` 输出。
- **二进制且本地。**没法对归档 `zgrep`；一次异常启动可能连 runtime journal 一起带走。
- **不是数据库。**每次查询都是一次全索引扫描。`-u X -p err --since yesterday` 扫一百万条没问题；八台机器五个字段的临时探索就不行。

我的方案是无聊的分层答案：journald 用 `SystemMaxUse=` 在本地留几天，应对
凌晨三点*当场*要答的问题；shipper 把 `-o json` 排进 Loki，应对跨机器、
跨几周的问题。[systemd unit 文件 cookbook](/zh/posts/systemd-unit-cookbook/)
覆盖生产端那一半——先把输出送进 journal，战斗就赢了一半。

## 值得记住的五条命令

```
journalctl -u foo.service -b -p err --since '1 hour ago'   # 最近什么坏了
journalctl -f -t mytag                                     # 盯着一个写入方
journalctl -b -k                                           # 本次启动的内核
journalctl -o json | python3 ...                           # 一次性回答问题
journalctl --disk-usage                                    # 在纳闷 / 为什么满之前
```

你早就拥有的这套日志系统，比那个你正打算装的更好。先花二十分钟对自己的
日志跑一遍 `journalctl -o verbose` 吧——见过字段之后，你就再也回不去
grep 了。
