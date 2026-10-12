---
title: "systemd unit file 速查：ExecStart、重启、定时器与校验"
description: "我真正会用到的 systemd unit file 指令：ExecStart、EnvironmentFile、User、After 与 WantedBy 的区别、Restart=on-failure 与启动次数上限、Type=simple/exec/oneshot 的差别、journal 日志、定时器，以及用 systemctl edit 写 drop-in、用 systemd-analyze verify 抓出一个真实报错并当场修好。"
pubDate: 2026-12-26
lang: zh
translationKey: systemd-unit-cookbook
tags: [systemd, linux]
featured: false
keywords:
  - systemd unit file
  - ExecStart
  - systemd-analyze verify
  - systemctl edit
  - Restart=on-failure
---

我关于 **systemd unit file** 的大部分知识，都是靠写错学来的——`Restart=` 拼错一个字母、`ExecStart` 指向了错误的路径、一个服务明明已经死了却报告「started」。这篇文章就是我当初想要的那本速查：真正干活的那些指令、看起来可选其实关键的那些，以及比它们都更有用的东西——在 `systemctl start` 之前先把作业检查一遍。

下面全部是这台机器上的真实输出（systemd 262）。我这里没有 root，所以能跑起来的例子都是 `systemctl --user` 下的用户服务；指令本身一字不差，区别只在查找路径（`/etc/systemd/system` 对 `~/.config/systemd/user`）。

## unit 文件就是一个包含三个字段段的普通 INI

unit 文件就是普通的 INI。后缀决定 *unit 类型*——`.service`、`.timer`、`.socket`、`.target`、`.mount`、`.path`——而对一个服务来说，值得你关注的只有三个段：

- **`[Unit]`**——元信息与顺序：`Description`、`After`、`Wants`、`Requires`、`Documentation`。
- **`[Service]`**——运行什么、怎么运行：`ExecStart`、`User`、`WorkingDirectory`、`Restart`、`Type`。
- **`[Install]`**——`systemctl enable` 时挂接什么：几乎总是 `WantedBy=multi-user.target`。

`[Unit]` 和 `[Install]` 被所有 unit 类型共享；`[Service]` 只属于 `.service`。搞清楚一条指令属于哪个段，是「不闹笑话」的一半。

<figure>
<svg viewBox="0 0 620 150" width="100%" role="img" aria-label="unit 文件的三个字段段对应三个阶段：[Unit] 段描述顺序与依赖，[Service] 段描述运行的进程，[Install] 段描述 systemctl enable 会挂接什么。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="16" y="46" width="176" height="70" rx="8"/>
    <rect x="222" y="46" width="176" height="70" rx="8"/>
    <rect x="428" y="46" width="176" height="70" rx="8"/>
    <path d="M192 81 h30" marker-end="url(#ar)"/>
    <path d="M398 81 h30" marker-end="url(#ar)"/>
  </g>
  <defs>
    <marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="104" y="28" opacity="0.9">排序与依赖</text>
    <text x="104" y="72">[Unit]</text>
    <text x="104" y="92" opacity="0.75">After, Wants, Requires</text>
    <text x="310" y="28" opacity="0.9">运行</text>
    <text x="310" y="72">[Service]</text>
    <text x="310" y="92" opacity="0.75">ExecStart, User, Restart</text>
    <text x="516" y="28" opacity="0.9">启用</text>
    <text x="516" y="72">[Install]</text>
    <text x="516" y="92" opacity="0.75">WantedBy</text>
  </g>
</svg>
<figcaption>一个文件，三个阶段：<code>[Unit]</code> 决定启动顺序，<code>[Service]</code> 定义进程，<code>[Install]</code> 决定 <code>systemctl enable</code> 挂接什么。</figcaption>
</figure>

## ExecStart 以及真正干活的那些指令

这是我写的几乎所有长期运行服务的形状。注意绝对路径，以及 `EnvironmentFile` 前面那个 `-`：

```ini
[Unit]
Description=My API
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
User=myapp
WorkingDirectory=/opt/myapp
EnvironmentFile=-/etc/myapp/env
ExecStart=/opt/myapp/bin/myapp --serve
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=3s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

其中几条各值得一句话：

- **`ExecStart=`** 必须是指向可执行文件的绝对路径。这里没有 shell，所以 `>` 重定向或 `&&` 都不起作用——除非你显式地跑 `/bin/sh -c '...'`。`$VAR` 与 `${VAR}` 会从 systemd 组装好的环境里展开。
- **`EnvironmentFile=-/etc/myapp/env`** 设置变量（`KEY=value`，一行一个）。开头的 `-` 表示*文件不存在就忽略*——对可选密钥很有用，但如果你指望它一定存在，就很危险。
- **`WorkingDirectory=`** 设置工作目录，相对路径就落在这里。之后再配上 `ProtectSystem=strict`，它才真的诚实。
- **`User=`** 降权。不写就意味着服务以 root 运行——所以这是我 review 每一个 unit 时看的第一行。
- **`ExecReload=`** 是 `systemctl reload` 执行的命令。`$MAINPID` 会展开成正在运行的 PID。

## After、Wants、Requires 与 WantedBy

这是最容易被混为一谈的一对。它们待在不同的段里，因为它们回答的是不同的问题。

- **`After=`/`Before=`** 只设定*顺序*。它们不会启动任何东西。两个 unit 都可以启动，systemd 只是排了先后。
- **`Wants=`** 是软依赖：把这个 unit 也启动起来，但它失败了你也继续。
- **`Requires=`** 是硬依赖：如果被依赖的 unit 失败*且本 unit 正是因为它才被拉起*，本 unit 也会被连带停掉。
- **`WantedBy=`** 是关于 `enable` 的，不是运行时的。它回答的是「开机时该由哪个 target 把我拉起来」。

经典的坑是以为 `After=network-online.target` 就能拿到网络。并不能——它只是说*如果有别的什么东西启动了网络*，你就排在它后面。如果你需要网络起来，要明说：`Wants=network-online.target`（在 `Type=oneshot` 的场景下，若失败必须中止就用 `Requires=`）。

## Type=simple / exec / oneshot / forking

`Type=` 告诉 systemd *什么时候可以认为服务已经跑起来了*，写错会改变你的失败语义。我用一个故意不存在的二进制验证给自己看：

```console
$ systemctl --user start cookbook-type-simple.service; echo "rc=$?"
rc=0
$ systemctl --user start cookbook-type-exec.service; echo "rc=$?"
Job for cookbook-type-exec.service failed because the control process exited with error code.
See "systemctl --user status cookbook-type-exec.service" and "journalctl --user -xeu cookbook-type-exec.service" for details.
rc=1
```

用 `Type=simple` 时，systemd 在 fork 出进程的那一刻就认定服务已启动，于是 `start` 返回成功，服务随后才死掉（`status=203/EXEC`）——这种近乎静默的失败你只能在日志里事后发现。用 `Type=exec` 时，systemd 会等 `exec()` 成功，所以 `start` 立刻、响亮地失败。凡是我要跑的东西，`Type=exec` 都是我的默认选择。

真正重要的四个：**`simple`** 在进程 fork 的瞬间就算启动（适合快速脚本，但会掩盖 exec 错误）；**`exec`** 等待 exec 成功；**`oneshot`** 期待进程自己退出，只有退出才算启动完成——这是定时器负载的正确类型；**`forking`** 给那些会自我后台化的经典守护进程用，`ExecStart` 在父进程退出后返回，systemd 去跟踪子进程（记得配 `PIDFile=`）。如果你的程序会说 `sd_notify`，那就用 `notify`，它甚至能在warm 好缓存之后再发「ready」。

## Restart=on-failure 与启动次数上限

`Restart=on-failure` 是「凌晨三点它死了」的一行修复方案。当进程非零退出、被信号杀死或超时时它会重启——但*不会*在干净的 `exit 0` 时重启，你自己 `systemctl stop` 时也不会。`RestartSec=` 拉开两次尝试的间隔。我写了一个永远 `exit 1` 的脚本来看这道护栏：

```console
$ journalctl --user -u cookbook-flaky.service -o short-iso | tail -6
2026-10-12T18:43:14+08:00 BOOK systemd[905]: Scheduled restart job, restart counter is at 2.
2026-10-12T18:43:14+08:00 BOOK systemd[905]: Started Cookbook flaky demo.
2026-10-12T18:43:14+08:00 BOOK flaky.sh[466807]: attempt: will fail with exit 1
2026-10-12T18:43:14+08:00 BOOK systemd[905]: Failed with result 'exit-code'.
2026-10-12T18:43:17+08:00 BOOK systemd[905]: Scheduled restart job, restart counter is at 3.
2026-10-12T18:43:17+08:00 BOOK systemd[905]: Start request repeated too quickly.
2026-10-12T18:43:17+08:00 BOOK systemd[905]: Failed with result 'start-limit-hit'.
```

没有上限的崩溃重启循环比一次崩溃更糟。`StartLimitIntervalSec=`（默认 10s）和 `StartLimitBurst=`（默认 5）限制一个窗口内的重启次数，超出后 systemd 以 `start-limit-hit` 放弃，把 unit 留在 failed 状态等你检查。只有当你*确实想要*无限重启循环时，才把 `StartLimitIntervalSec=0`。

## 日志：StandardOutput=journal

默认就会把 stdout 和 stderr 送进 journal，所以 `StandardOutput=journal` 更多是「写明白」。真正的回报是 `journalctl`，它认识的是 unit 而不是文件：

```console
$ systemctl --user status cookbook-heartbeat.service --no-pager
* cookbook-heartbeat.service - Cookbook heartbeat demo
     Loaded: loaded (/home/awinx/.config/systemd/user/cookbook-heartbeat.service; disabled; preset: enabled)
     Active: active (running) since Mon 2026-10-12 18:42:49 CST; 7s ago
   Main PID: 466441 (heartbeat.sh)
      Tasks: 2 (limit: 14160)
     Memory: 1.4M (peak: 2.7M)
        CGroup: /user.slice/user-1000.slice/user@1000.service/app.slice/cookbook-heartbeat.service
                |-466441 /bin/sh /tmp/opencode/work/systemd-units/heartbeat.sh
                `-466580 sleep 3

Oct 12 18:42:49 BOOK heartbeat.sh[466441]: heartbeat start tag=blog-demo pid=466441
Oct 12 18:42:52 BOOK heartbeat.sh[466441]: heartbeat tick=2 tag=blog-demo

$ journalctl --user -u cookbook-heartbeat.service -n 3 -o short-iso
2026-10-12T18:42:49+08:00 BOOK heartbeat.sh[466441]: heartbeat start tag=blog-demo pid=466441
2026-10-12T18:42:52+08:00 BOOK heartbeat.sh[466441]: heartbeat tick=2 tag=blog-demo
2026-10-12T18:42:55+08:00 BOOK heartbeat.sh[466441]: heartbeat tick=3 tag=blog-demo
```

系统服务去掉 `--user`。加 `-f` 跟随，加 `--since "1 hour ago"` 限定时间窗，想接管道就加 `-o json`。再也不用 `>> /var/log/app.log 2>&1`。

## 定时器：cron 的替代品

一个定时器是一对：`.timer` 说*何时*，`.service` 说*做什么*。service 是负载（通常是 `Type=oneshot`），timer 只负责触发它。

```ini
# ~/.config/systemd/user/cookbook-tick.timer
[Unit]
Description=Run cookbook-tick every 10 minutes

[Timer]
OnCalendar=*:0/10
Persistent=true
Unit=cookbook-tick.service

[Install]
WantedBy=timers.target
```

`OnCalendar=` 不是 cron 语法，而你不必背它——`systemd-analyze calendar` 会解析它，*并告诉你下次触发时间*：

```console
$ systemd-analyze calendar 'Mon..Fri *-*-* 09:00:00'
Normalized form: Mon..Fri *-*-* 09:00:00
    Next elapse: Tue 2026-10-13 09:00:00 CST
       From now: 14h left
$ systemd-analyze calendar '*:0/15'
Normalized form: *-*-* *:00/15:00
    Next elapse: Mon 2026-10-12 18:45:00 CST
       From now: 1min 53s left
$ systemd-analyze calendar 'every monday'
Failed to parse calendar specification 'every monday': Invalid argument
```

第三行才是我跑它的理由：错的表达式会在这里大声报错，而不是静悄悄地永不触发。接着启用并确认：

```console
$ systemctl --user enable --now cookbook-tick.timer
Created symlink '/home/awinx/.config/systemd/user/timers.target.wants/cookbook-tick.timer' → '/home/awinx/.config/systemd/user/cookbook-tick.timer'.
$ systemctl --user list-timers cookbook-tick.timer --no-pager
NEXT                            LEFT     LAST                        PASSED UNIT                ACTIVATES
Mon 2026-10-12 18:50:00 CST     4min 37s Mon 2026-10-12 18:43:26 CST -      cookbook-tick.timer cookbook-tick.service
```

`Persistent=true` 会在停机后补跑错过的任务——这是 cron 从来没有的补跑行为。如果你正在迁移，我写过一篇完整的 [systemd 定时器 vs cron](/zh/posts/systemd-timers-vs-cron/) 对比。

## 不用 fork 整个 unit：systemctl edit 与 drop-in

永远不要直接改 `/usr/lib` 里发行版自带的 unit。`systemctl edit` 会把一段片段写进 `<unit>.d/override.conf`，叠加在原 unit 之上，并且能在包升级后幸存：

```console
$ systemctl --user cat cookbook-heartbeat.service
# /home/awinx/.config/systemd/user/cookbook-heartbeat.service
[Service]
ExecStart=.../heartbeat.sh
Restart=on-failure
RestartSec=2

# /home/awinx/.config/systemd/user/cookbook-heartbeat.service.d/override.conf
[Service]
RestartSec=10
Restart=no

$ systemctl --user show cookbook-heartbeat.service -p Restart -p RestartSec
Restart=no
RestartSec=10
```

drop-in 的值胜出，而 `systemctl cat` 会给你看合并后的整摞内容，所以你永远能看清*为什么*。记住两条规则：需要列出的指令在被重新赋值时会先清空，所以单独一行的 `ExecStart=` 会清掉继承来的那一条，再放上你的替换值；`systemctl edit --full` 改的是私有副本而不是 drop-in（自己的机器上没问题，对发行版 unit 就挺冒险）。`systemctl revert <unit>` 会移除所有覆盖。

## 用 systemd-analyze verify 校验

这是我每次启动前都会做的事。我故意写了一个既拼错、路径又错的服务：

```ini
[Service]
ExecStart=/usr/bin/myapp --serve
EnvironmentFile=/etc/myapp/env
Restart=onfailure
```

`systemd-analyze verify` 拒绝被糊弄：

```console
$ systemd-analyze verify ./broken.service
/tmp/opencode/work/systemd-units/broken.service:10: Failed to parse Restart=onfailure, ignoring: Invalid argument
broken.service: Command /usr/bin/myapp is not executable: No such file or directory
```

两条真实的报错行，任何一条都会变成凌晨三点的谜题。把拼写改成 `on-failure`，把 `ExecStart` 指向真实二进制，同一条命令就安静下来并退出 0：

```console
$ systemd-analyze verify ./fixed.service; echo "exit=$?"
exit=0
```

verify 不只是拼写检查器。它会解析依赖，并强制若干硬性要求：

```console
$ systemd-analyze verify ./no-exec.service
no-exec.service: Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing.
Unit no-exec.service has a bad unit file setting.

$ systemd-analyze verify ./deps.service
deps.service: Failed to create deps.service/start: Unit missing.service not found.
```

有两个诚实的限制。第一，把指令放错段只会是警告，仍然退出 0：

```console
$ systemd-analyze verify ./section-error.service
/tmp/opencode/work/systemd-units/section-error.service:7: Unknown key 'WantedBy' in section [Service], ignoring.
$ echo $?
0
```

第二，`verify` 不校验你的 `[Install]` 目标——`WantedBy=no-such.target` 照样通过——所以要看输出，别只盯退出码。然后 `daemon-reload`，再 `systemctl start`。

## 走到这里

unit 文件是一件小而可检查的产物：三个段、一小把指令，以及两条命令（`systemd-analyze verify`、`systemd-analyze calendar`），它们能在进程诞生之前抓出大部分错误。如果你想更进一步，自然的下一步是缩小服务能碰到的东西——我在 [systemd 加固](/zh/posts/systemd-hardening/) 里用 `systemd-analyze security` 量化地走了一遍（我那个演示服务未加固时 9.4 UNSAFE，沙箱化后 2.7 OK）。写文件，校验它，然后信任它。
