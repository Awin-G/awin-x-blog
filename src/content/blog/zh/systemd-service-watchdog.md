---
title: "systemd 看门狗：重启挂死的服务，而不只是会崩溃的服务"
description: "Restart=on-failure 只能处理真正退出的进程，挂死的进程系统完全无感知。本文用真实的 systemd journal 输出演示如何用 WatchdogSec 加 sd_notify 心跳捕获卡死的服务，并覆盖 StartLimitBurst 崩溃循环保护与 Type=notify 就绪语义。"
pubDate: 2027-01-29
lang: zh
translationKey: systemd-service-watchdog
tags: [systemd, linux]
featured: false
keywords:
  - systemd 看门狗
  - Restart=on-failure
  - WatchdogSec
  - sd_notify
  - StartLimitBurst
---

很长时间里，我一直以为 `Restart=on-failure` 就等于"我的服务会自己回来"。
直到我发现某个服务已经死了两天，状态却还是绿色的 `active (running)`。它并非
以 systemd 能察觉的方式死掉——没有任何人调用过 `exit()`。进程卡死在一个系统调用
里，持着一把锁，谁都不应答。它是活着的。对 systemd 来说它**状态良好**。这正是
**systemd 看门狗**（systemd watchdog）要填补的缺口：它是让服务**挂死**时也能被
重启的机制，而不只是在**崩溃**时才重启。

下面所有输出都来自我真实的机器（systemd 262）。我没有 root 权限，所以示例用的
是 `systemctl --user` 下的用户单元——指令与系统服务完全一致，只是单元路径不同。
这些单元是我写出来、故意弄坏的，跑完之后已经清理干净。

## 崩溃与挂死，在 systemd 眼里是两回事

**崩溃**是一个事件：主进程以非零状态退出，或者被信号终止。systemd 能"看见"
这件事——waitpid() 的返回结果——并据此行动。而**挂死**是事件的缺席。进程还在
进程表里，`Restart=always` 没有任何东西可以反应，唯一的证据是你的 HTTP 接口
不再应答了。

<figure>
<svg viewBox="0 0 760 300" width="100%" role="img" aria-label="示意图：崩溃是 systemd 可观测的退出事件，Restart=on-failure 已经能处理；挂死是进程活着但不再推进，只有 WatchdogSec 配合定期 sd_notify 心跳才能发现，之后 systemd 发送 SIGABRT 并重启服务。">
  <defs>
    <marker id="wd-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor">
    <text x="16" y="30" font-weight="600">崩溃 —— 一个有退出事件</text>
    <text x="16" y="48" opacity="0.7" font-size="12">systemd 看到的是：waitpid() → status=3</text>

    <g stroke="#0f766e" stroke-width="1.5" fill="none">
      <rect x="16" y="60" width="180" height="52" rx="8"/>
      <rect x="280" y="60" width="200" height="52" rx="8"/>
    </g>
    <text x="106" y="90" text-anchor="middle">进程退出</text>
    <text x="380" y="90" text-anchor="middle">Restart=on-failure</text>
    <path d="M196 86 h74" stroke="#0f766e" stroke-width="1.5" marker-end="url(#wd-arrow)"/>
    <text x="233" y="78" text-anchor="middle" font-size="11" fill="#0f766e">RestartSec=1</text>
    <text x="496" y="90" text-anchor="middle">→ 新 PID</text>

    <text x="16" y="176" font-weight="600">挂死 —— 完全没有事件</text>
    <text x="16" y="194" opacity="0.7" font-size="12">systemd 什么也看不到，Restart= 无事可做</text>

    <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
      <rect x="16" y="206" width="180" height="52" rx="8"/>
    </g>
    <text x="106" y="228" text-anchor="middle">活着，但卡死</text>
    <text x="106" y="246" text-anchor="middle" font-size="11" opacity="0.7">持有锁，无应答</text>
    <path d="M196 232 h74" stroke="#0f766e" stroke-width="1.5" marker-end="url(#wd-arrow)"/>
    <text x="233" y="224" text-anchor="middle" font-size="11" fill="#0f766e">WatchdogSec=5</text>
    <g stroke="#0f766e" stroke-width="1.5" fill="none">
      <rect x="280" y="206" width="200" height="52" rx="8"/>
    </g>
    <text x="380" y="228" text-anchor="middle">sd_notify(WATCHDOG=1)</text>
    <text x="380" y="246" text-anchor="middle" font-size="11" opacity="0.7">中断 5 秒 → SIGABRT</text>
    <path d="M480 232 h60" stroke="#0f766e" stroke-width="1.5" marker-end="url(#wd-arrow)"/>
    <text x="560" y="228" text-anchor="middle">重启</text>
    <text x="560" y="246" text-anchor="middle" font-size="11" opacity="0.7">与崩溃同一套策略</text>
  </g>
</svg>
<figcaption>崩溃是 systemd 能观测到的状态迁移；挂死则是"什么也没发生"。看门狗通过要求应用按定时器证明自己还活着，把"它不再推进了"变成 systemd 可以据此行动的信号。</figcaption>
</figure>

## 实验一：`Restart=on-failure` 确实会重启崩溃的进程

先看基线。一个唯一职责就是非零退出的服务：

```ini
[Unit]
Description=WD-test: crashes on purpose (Restart=on-failure)
[Service]
Type=simple
ExecStart=/tmp/opencode/work/systemd-watchdog/crash.sh
Restart=on-failure
RestartSec=1
StandardOutput=journal
```

```sh
$ systemctl --user start zz-wd-crash.service && sleep 4.5 \
    && systemctl --user show zz-wd-crash.service \
         -p NRestarts -p Restart -p RestartUSec -p ExecMainStatus
Restart=on-failure
RestartUSec=1s
NRestarts=3
ExecMainStatus=3
```

日志把整个过程讲得很清楚，每次失败一行：

```
zz-wd-crash.service: Main process exited, code=exited, status=3/NOTIMPLEMENTED
zz-wd-crash.service: Failed with result 'exit-code'.
zz-wd-crash.service: Scheduled restart job, restart counter is at 3.
zz-wd-crash.service: Started WD-test: crashes on purpose (Restart=on-failure).
```

`NRestarts` 是最值得信任的计数器——它是"这个服务被重启了多少次"的权威答案，
查一下就有，不必通读日志。注意 `RestartUSec=1s`：这就是 `RestartSec`，它并不是
摆设。没有它，一个瞬间死掉的服务会被密集重启，每次都吐一个 core 文件。`Type=`
以及其他单元指令的细节见 [systemd unit 文件 cookbook](/zh/posts/systemd-unit-cookbook/)；
这里只谈决定"死掉的东西会不会回来"的那一部分。

## 崩溃循环，以及拦住它的启动限制

让那个崩溃服务一直跑下去，重启计数器最终会表达另一个意思——拒绝启动。这就是
**StartLimitBurst** 和 **StartLimitIntervalSec** 在起作用：

```ini
[Unit]
Description=WD-test: crash loop, trips the start limit
[Service]
Type=simple
ExecStart=/tmp/opencode/work/systemd-watchdog/crash.sh
Restart=on-failure
RestartSec=1
StartLimitIntervalSec=10
StartLimitBurst=5
```

手动启动会立刻返回——重试都在后台进行：

```sh
$ systemctl --user start zz-wd-loop.service; sleep 8
$ systemctl --user show zz-wd-loop.service -p ActiveState -p NRestarts -p Result
ActiveState=failed
Result=start-limit-hit
NRestarts=5
```

日志则准确记录了它何时放弃：

```
zz-wd-loop.service: Scheduled restart job, restart counter is at 5.
zz-wd-loop.service: Start request repeated too quickly.
zz-wd-loop.service: Failed with result 'start-limit-hit'.
```

再手动要求重启，会得到一个诚实的"不"，以及出路：

```sh
$ systemctl --user start zz-wd-loop.service
Job for zz-wd-loop.service failed because start of the service was attempted too often.
See "systemctl --user status zz-wd-loop.service" and "journalctl --user -xeu zz-wd-loop.service" for details.
To force a start use "systemctl --user reset-failed zz-wd-loop.service"
followed by "systemctl --user start zz-wd-loop.service" again.
```

这里有两点值得记住。第一，默认值（10 秒内 5 次）对于那些在开机时合理崩溃一下、
等待磁盘的服务来说太紧了——要提高就同时调整 `StartLimitIntervalSec` 和
`StartLimitBurst`。第二，触发启动限制是**另一种失败**，与崩溃不同：
`Result=start-limit-hit` 而不是 `exit-code`。当你在日志里 grep `Failed with
result` 时，这个区别就是第一条线索。

## 被 kill 不等于崩溃

有点反直觉但很重要：**`Restart=on-failure` 也会重启被 kill 掉的服务**，因为被
一个它没有捕获的信号终止，同样算失败。我启动了一个 `sleep 3000` 的服务，向它的
主 PID 发了 SIGKILL，然后它就回来了：

```sh
$ systemctl --user start zz-wd-killed.service; sleep 1
$ kill -9 $(systemctl --user show zz-wd-killed.service -p MainPID --value)
$ systemctl --user show zz-wd-killed.service -p MainPID -p NRestarts
MainPID=1130713
NRestarts=1
```

```
zz-wd-killed.service: Main process exited, code=killed, status=9/KILL)
zz-wd-killed.service: Failed with result 'signal'.
zz-wd-killed.service: Scheduled restart job, restart counter is at 1.
```

新的 `MainPID`（1130722）就是证据：进程已经换了人。所以 OOM kill、`pkill`、
内核回收器写进系统的信号，全都在 `Restart=` 的覆盖范围内。唯一救不回来的，是
那个从头到尾没收到任何信号的服务。

## 为什么 `Restart=always` 救不了挂死

`Restart=` 响应的是主进程的**终止**。挂死的进程并没有终止。它占着内存、文件描述符
和锁，就那么坐在那里。`always` 和 `on-failure` 一样盲目——策略被问的是"进程退出
了吗？"，答案是否，于是什么都不发生。

修法是把问题倒过来：别指望 systemd 发现死亡，让应用按定时器证明自己**活着**。
这就是 **`WatchdogSec=`** 配合 **`sd_notify`** 心跳——也就是**systemd 看门狗**的
正体。

## 实验二：一个健康的 `WatchdogSec=5` 心跳

契约是这样的：如果两次 `WATCHDOG=1` 通知之间的间隔超过 `WatchdogSec`，服务就会被
置为失败并以 SIGABRT 杀死。下面是我能写出来的最小客户端（用 C，因为 `libsystemd`
白送 `sd_notify`）：

```c
sd_notify(0, "READY=1\nSTATUS=started, heartbeating every 1000ms");

for (;;) {
    usleep(period * 1000);
    sd_notifyf(0, "STATUS=heartbeat #%ld\nWATCHDOG=1", ticks);
}
```

```ini
[Unit]
Description=WD-test: Type=notify + WatchdogSec, healthy heartbeat
[Service]
Type=notify
ExecStart=/tmp/opencode/work/systemd-watchdog/hb 1000 0
WatchdogSec=5
Restart=always
RestartSec=1
NotifyAccess=main
```

跑起来之后，心跳体现为不断变化的 `WatchdogTimestamp`——即最后一次安抚看门狗的时间：

```sh
$ systemctl --user start zz-wd-hb.service && sleep 2 \
    && systemctl --user show zz-wd-hb.service -p WatchdogTimestamp --value
Wed 2026-10-14 10:34:19 CST     # 启动后约 3.5 秒
$ sleep 4; systemctl --user show zz-wd-hb.service -p ActiveState -p NRestarts
ActiveState=active
NRestarts=0
```

安稳地活过了 5 秒限制，且 `NRestarts=0`——这是唯一可能的解释。不过我第一版的客户端
被反复杀死，而那段日志非常有教育意义：

```
zz-wd-hb.service: Watchdog timeout (limit 5s)!
zz-wd-hb.service: Killing process 1131652 (hb) with signal SIGABRT.
systemd-coredump: Stack trace of thread 1131652:
  #1  __nanosleep (libc.so.6 + 0xe0ee7)
  #3  n/a (/tmp/opencode/work/systemd-watchdog/hb + 0x1162)
zz-wd-hb.service: Main process exited, code=dumped, status=6/ABRT
zz-wd-hb.service: Failed with result 'watchdog'.
```

看那个栈回溯：进程是在 `usleep()` 里被杀死的——它活得很好，只是在 systemd 眼里
彻底卡死了。问题出在一个参数上：我写的是 `sd_notify(1, "READY=1…")`，那个 `1`
会让 `sd_notify` 在发送后把 `$NOTIFY_SOCKET` 从环境变量里删掉。之后每一次心跳都
没有 socket 可发，systemd 一个ping都没收到。修法是 `sd_notify(0, …)`。无论你用
什么语言实现看门狗客户端，这都是第一件该检查的事。

## 实验三：真正触发它的挂死

现在是关键测试。同样的程序和单元，但在健康心跳 8 秒之后，程序停止发送ping——
模拟死锁——同时保持存活：

```sh
$ systemctl --user start zz-wd-wedge.service && sleep 6
$ systemctl --user show zz-wd-wedge.service -p ActiveState -p NRestarts
ActiveState=active          # 还好——挂死还没超过时限
NRestarts=0
$ sleep 12; systemctl --user show zz-wd-wedge.service -p ActiveState -p NRestarts \
    -p WatchdogTimestamp
ActiveState=active
WatchdogTimestamp=Wed 2026-10-14 10:34:52 CST   # 最后一次成功的 ping
NRestarts=1
```

日志标记了完整弧线，包括应用卡住的那一刻：

```
hb: WEDGING - no more WATCHDOG=1 pings (pid 1132727 still alive)
zz-wd-wedge.service: Watchdog timeout (limit 5s)!
zz-wd-wedge.service: Killing process 1132727 (hb) with signal SIGABRT.
zz-wd-wedge.service: Main process exited, code=dumped, status=6/ABRT
zz-wd-wedge.service: Failed with result 'watchdog'.
zz-wd-wedge.service: Scheduled restart job, restart counter is at 2.
```

最后一次心跳之后大约四秒多，进程被中止，新的进程启动。这就是与崩溃的区别：
触发器是**漏掉的心跳**，而不是退出码。注意 `Failed with result 'watchdog'`——
在 `journalctl -u` 里这单独一个字符串就告诉你服务为什么重启，当你要在一个月的
日志里翻找原因时，这很关键。

如果你用 Python，同样的客户端用 `ctypes` 四行就够，不需要装任何包：

```python
import ctypes, time
lib = ctypes.CDLL("libsystemd.so.0")
lib.sd_notify(0, b"READY=1")
while True:
    lib.sd_notify(0, b"WATCHDOG=1")
    time.sleep(1)
```

正是这个脚本让下面那套配方单元保持 `NRestarts=0`。

## `Type=simple` 与 `Type=notify`

**`Type=notify`** 买到的是就绪语义：systemd 会等 `READY=1` 才认为启动任务完成，
所以依赖它的单元不会对一个半成品服务启动。**`Type=simple`** 则是在 fork 出进程的
那一刻就宣布"active"。同样是 3 秒的启动过程，对"何时就绪"却有两种截然不同的答案：

```sh
# Type=simple  （ExecStart 先睡 3 秒才算"就绪"）
`systemctl start` blocked for 0.28s
ExecMainStartTimestamp=Wed 2026-10-14 10:38:40 CST
ActiveEnterTimestamp=Wed 2026-10-14 10:38:40 CST

# Type=notify   （同样 3 秒，然后 systemd-notify --ready）
`systemctl start` blocked for 3.03s
ExecMainStartTimestamp=Wed 2026-10-14 10:38:40 CST
ActiveEnterTimestamp=Wed 2026-10-14 10:38:43 CST
```

`Type=simple` 下两个时间戳完全相同——程序还没准备好，systemd 就已经收工了。
`Type=notify` 下两者正好差一个启动时间，`ActiveEnterTimestamp` 说的是真话。

有一个我原本以为、后来靠测试纠正的误解：我以为看门狗只在 `Type=notify` 下才生效。
并不是。我在 `Type=simple` 下跑了一个普通的 `sleep 3000`，带 `WatchdogSec=5`、
完全没有通知代码，它照样死了：

```
zz-wd-nonotify.service: Watchdog timeout (limit 5s)!
zz-wd-nonotify.service: Killing process 1135165 (sleep) with signal SIGABRT.
zz-wd-nonotify.service: Failed with result 'watchdog'.
```

两种类型下看门狗都会被武装；`Type=` 只决定就绪是否被纳入等待。真正关键的是
`NotifyAccess`，它决定谁的通知算数：`main`（主进程）、`exec` 还是 `all`。我那个
委托给 `systemd-notify` 辅助子进程的 `Type=notify` 单元，在默认
`NotifyAccess=main` 下以 `Failed with result 'timeout'` 失败，因为ping来自子进程
PID——唯一的症状就是那个 90 秒的启动超时。

## 我实际在用的配方

```ini
[Unit]
Description=recipe-unit: watchdog + restart + start limits
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10
[Service]
Type=notify
ExecStart=/usr/bin/python3 /tmp/opencode/work/systemd-watchdog/hb.py
WatchdogSec=30
Restart=always
RestartSec=5
NotifyAccess=main
StandardOutput=journal
SyslogIdentifier=recipe
[Install]
WantedBy=default.target
```

`systemd-analyze verify` 接受了它——并且抓出了我初稿里一个真实错误：我把启动限制写
进了 `[Service]`：

```
~/.config/systemd/user/zz-wd-recipe.service:10: Unknown key 'StartLimitIntervalSec' in section [Service], ignoring.
```

`StartLimit*` 属于 `[Unit]`。这个校验工具免费、离线可用，cookbook 那篇也很依赖它。
校验并运行之后：

```sh
$ systemctl --user show zz-wd-recipe.service -p ActiveState -p NRestarts \
    -p StartLimitBurst -p StartLimitIntervalUSec
ActiveState=active
NRestarts=0
StartLimitBurst=10
StartLimitIntervalUSec=5min
```

这些数字里有几个判断。1 秒心跳配 `WatchdogSec=30`，留了 29 次漏ping的余量——
紧到能发现真正的卡死，松到一次缓慢的 GC 停顿不会重启你的数据库。启动昂贵时，
`RestartSec=5` 比 `1` 更合适。启动限制现在是 5 分钟内 10 次：既能防崩溃循环，
又能容忍一次真实的、对着慢磁盘的启动期失败。

日志和旋钮同样重要。`StandardOutput=journal` 加 `SyslogIdentifier=` 意味着
`journalctl -t recipe` 能找到一切，而真正重要的三个字符串是 `Failed with result
'watchdog'`、`... timeout (limit 5s)!` 和 `Scheduled restart job`。在读任何栈
回溯之前，先 grep 这三个。

## 该怎么用

`Restart=on-failure` 是地板不是天花板：它覆盖退出、信号和 kill，而
`StartLimitBurst` 防止坏单元刷爆你的日志。挂死是它结构上无法覆盖的场景，解法是
一个指令加一次函数调用：单元里写 `WatchdogSec=`，应用里用定时器调
`sd_notify(WATCHDOG=1)`。在相信那个绿色状态徽章之前，先查 `NRestarts` 和
`WatchdogTimestamp`——那个从周二起就悄悄卡死的服务，就是这样被发现的。如果你
还想让这些单元不至于被攻破后成为突破口，[systemd 加固](/zh/posts/systemd-hardening/)
那篇是后续。

文中所有单元都已停止并从 `~/.config/systemd/user/` 删除；用户管理器只剩它原本
那两个 Avahi 失败单元，没有别的东西。
