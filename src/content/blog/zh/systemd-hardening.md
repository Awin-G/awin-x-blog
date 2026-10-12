---
title: "systemd 加固：用 systemd-analyze security 给守护进程做沙箱"
description: "如何在不弄坏服务的前提下给 systemd 单元做沙箱：真正重要的那些旋钮（NoNewPrivileges、ProtectSystem=strict、PrivateTmp、SystemCallFilter、CapabilityBoundingSet、dynamic user）、用 systemd-analyze security 量化、用 LoadCredential 管密钥的增量工作流，以及单元被弄坏后如何测试与回滚。"
pubDate: 2026-11-24
lang: zh
translationKey: systemd-hardening
tags: [security, systemd, linux]
featured: false
keywords:
  - systemd 加固
  - ProtectSystem
  - systemd-analyze security
  - 服务沙箱
  - NoNewPrivileges
---

我在服务器上跑的每个守护进程都从一个单元文件启动，而多年来我一直把它当成一层方便
的包装：一个 `ExecStart`、一个 `User`、一个重启策略。**systemd 加固** 改变了我读这个
文件的方式。单元文件不只是 systemd 启动进程的方式——它是那个进程与整台机器之间最后
一条可写的分界线。配错了，一个被攻陷的服务就拥有 `/etc`、`/home`，以及 root 拥有的
全部能力。配好了，同一个漏洞拿到的只是一个只读文件系统、零能力、以及它自己没要过的
任何网络协议栈。

麻烦之处在于，后一句话写起来容易，*弄坏* 也容易。一个沙箱过头的服务起不来，于是你
半夜三点在调挂载命名空间。下面就是我用的工作流：一次加一个旋钮地做 **服务沙箱**，用
`systemd-analyze security` 量化它，出错时廉价地回滚。

## systemd 加固：单元文件就是一条安全边界

多数加固建议把内核当成边界：seccomp、SELinux、一个受限的用户。systemd 位于内核
*之上*，把同样的原语交给你，作为按单元配置，并在每次启动、重启和 `daemon-reload` 时
自动施加。这就是它全部的魅力。一个 systemd 单元就是一份声明式的描述：「这个进程允许
接触什么」，由内核在 `main()` 运行之前强制。

这些层是叠加的。每一层彼此独立，而你跳过的每一层，都是攻击者保留下来的一层：

<figure>
<svg viewBox="0 0 640 300" width="100%" role="img" aria-label="systemd 沙箱的嵌套层次：最外是 cgroup 资源限制，最内是 NoNewPrivileges 与最小化用户身份，包裹着进程。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="20" y="20" width="600" height="260" rx="12"/>
    <rect x="60" y="55" width="520" height="225" rx="12"/>
    <rect x="100" y="90" width="440" height="190" rx="12"/>
    <rect x="140" y="125" width="360" height="155" rx="12"/>
    <rect x="180" y="160" width="280" height="120" rx="12"/>
  </g>
  <circle cx="320" cy="220" r="34" fill="none" stroke="currentColor" stroke-width="1.8"/>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="32" y="40" font-weight="600">资源限制（cgroup）</text>
    <text x="72" y="75">ProtectSystem、PrivateTmp、PrivateDevices</text>
    <text x="112" y="110">CapabilityBoundingSet</text>
    <text x="152" y="145">SystemCallFilter（seccomp）</text>
    <text x="192" y="180">NoNewPrivileges / dynamic user</text>
    <text x="320" y="224" text-anchor="middle" font-size="11">进程</text>
  </g>
</svg>
<figcaption>单元文件里的纵深防御：每一圈都是一个独立的内核机制，由 systemd 在启动时施加。跳过一圈不会削弱其他圈——只是少了一圈。</figcaption>
</figure>

值得在意的是失效成本，而不是正确性。如果一个服务以 root 运行、拥有完整文件系统访问、
没有 seccomp 过滤器，一个远程代码执行漏洞就会变成整机沦陷。同一个漏洞，若发生在一个
`CapabilityBoundingSet` 为空、`ProtectSystem=strict` 视图、且带 syscall 过滤器的单元
里，那只是一个读不到 `/home`、开不了套接字、写不出自己状态目录的进程。

## 真正重要的旋钮

指令有几百个。其中十来个承担了几乎全部分量，而最便宜的那几个几乎不花钱。

### 零成本的收益

`NoNewPrivileges=true` 为整个服务设置内核的 `no_new_privs` 位。它意味着这个进程，以及
它 fork 出的一切，永远无法获得新权限——没有 setuid 程序，没有文件能力，什么都没有。
一行，不改变行为，几乎应该加在每个单元上。`UMask=0077` 是同一类免费的收紧：新文件默认
不再对所有人可读。

### 文件系统：ProtectSystem 与 ReadWritePaths

`ProtectSystem=strict` 把整个文件系统对服务挂成只读，除了 `/dev`、`/proc`、`/sys`——
它们由各自的选项处理。这条指令把「攻陷后往 `/usr/bin` 写个后门」翻转为「写入失败」。
`ProtectHome=true` 把 `/home`、`/root` 和 `/run/user` 藏在空挂载或不可读挂载后面，堵住
从服务通往 SSH 密钥的最快路径。单独用 `ProtectSystem=strict` 会弄坏任何要写东西的
服务，所以你要有意识地用 `ReadWritePaths=` 把口子开回来：

```ini
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/api /var/cache/api
StateDirectory=api
```

`StateDirectory=api` 既创建 `/var/lib/api`，又把它标记为可写；对持久数据来说，这通常比
手写 `ReadWritePaths` 更干净。`/run` 里的套接字同理，用 `RuntimeDirectory`。

### 命名空间：PrivateTmp、PrivateDevices 之类

`PrivateTmp=true` 给服务自己的 `/tmp` 和 `/var/tmp`，于是某个守护进程里可预测临时文件
的 bug，无法被另一个用户进程拿来利用。`PrivateDevices=true` 把 `/dev` 换成一个最小
集合，没有裸磁盘、GPU、输入设备。`ProtectKernelTunables=true`、
`ProtectKernelModules=true`、`ProtectControlGroups=true` 分别封住对 `/proc/sys` 的写入、
内核模块加载、以及 cgroup 操作。任何不需要主机名的东西，`ProtectHostname=true` 和
`ProtectClock=true` 再拿掉两片环境权限。

### 系统调用与能力：SystemCallFilter 与 CapabilityBoundingSet

这两者把攻击面缩得最多，也最容易弄坏服务。`CapabilityBoundingSet=`（空）丢掉全部
Linux 能力；如果一个守护进程只是绑一个高位端口、读一个文件，它一个都不需要。
`SystemCallFilter=` 用 seccomp。别手写系统调用列表，从预设分组起步：

```ini
CapabilityBoundingSet=
AmbientCapabilities=
NoNewPrivileges=true
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources @obsolete
SystemCallArchitectures=native
```

`@system-service` 是给普通守护进程准备的精选白名单；第二行从那集合里再减掉特权、资源
和过时的调用。常见的坏法是一个服务需要某个具体东西——调用 `adjtimex` 的守护需要
`@clock`，调用 `setrlimit` 的需要 `@resources`，或者某个预制分组漏掉了一个裸系统调用。
把你能加的最窄的那个分组加回来，而不是整个列表。

### 动态用户与资源限制

`DynamicUser=yes` 是那个安静的赢家。与一个在多次运行间持续存在、必须被管理的真实账户
不同，systemd 在单元生命周期内分配一个临时的 UID/GID，单元停止时收回。没有可写的家
目录，没有会泄漏的 `/etc/passwd` 条目，也没有会发生碰撞的共享 UID。它与
`StateDirectory` 配合，仅在首次运行时做初始化。资源限制属于同一个块：`MemoryMax=`、
`CPUQuota=`、`TasksMax=`、`IOWeight=` 给 cgroup 一个上限，于是一个被攻陷或出故障的服务
在你考虑文件系统访问之前就已经被圈住了。

## 用 systemd-analyze security 量化服务沙箱

你不必猜一个单元暴露到什么程度。systemd 自带一个评分器，它读取单元的有效配置，标出它
认识的每条指令，然后打印一个暴露分：

```bash
$ systemd-analyze security api.service
  NAME                                            DESCRIPTION                                      EXPOSURE
✗ PrivateNetwork=                                 Service has access to the host's network            0.5
✓ User=/DynamicUser=                              Service runs under a transient non-root user        0.0
✓ CapabilityBoundingSet=~CAP_SYS_ADMIN            Service has no administrator privileges             0.0
✓ CapabilityBoundingSet=~CAP_SET(UID|GID|PCAP)    Service cannot change UID/GID or capabilities       0.0
✓ RestrictAddressFamilies=~AF_UNIX                Service cannot allocate any address family          0.0
✗ RestrictNamespaces=                             Service may create namespaces                       0.3
✓ LockPersonality=                                Service cannot change ABI personality               0.0
✓ MemoryDenyWriteExecute=                         Service cannot create writable executable memory    0.0
✓ RestrictRealtime=                               Service cannot acquire realtime scheduling          0.0
✓ SystemCallArchitectures=                        Service may execute only specific system calls      0.1
✓ SystemCallFilter=~@clock                        Service may only invoke known system calls          0.1

→ Overall exposure level for api.service: 1.7 OK 🙂
```

越低越好，而 `✗` 那几行就是你的待办清单。对任何必须在公网应答的服务，`PrivateNetwork=`
会故意保持红色。不带参数运行 `systemd-analyze security` 就能给机器上每个单元排名；把
那个暴露分当成一个*方向*，而不是一个分数——它看不到你应用的业务逻辑，只看得到它的
内核表面。

## 一个工作流：一次加一个旋钮地增量加固

错误是一次写四十条指令，然后去调是哪一条弄坏了服务。把它当成一个循环来做，并且永远
编辑一个 drop-in，而不是打包自带的单元：

```bash
# 基线：这个服务现在暴露到什么程度？
systemd-analyze security api.service

# 以 drop-in 的形式加几条指令，不动打包的单元
sudo systemctl edit api.service     # 写入 /etc/systemd/system/api.service.d/override.conf

sudo systemctl daemon-reload
sudo systemctl restart api.service
systemctl status api.service
journalctl -u api.service -n 50

# 分数动了吗，动的正是你在意的那一项吗？
systemd-analyze security api.service
```

加两三条指令，重启，确认，再测量。用 `systemctl edit` 的 drop-in 工作，能让改动可审查、
可回退，并且在包升级重写原单元时依然存活。然后每一步都要证明服务确实*干完了它的活*
——一个能启动但连不上数据库的单元，是一个分更漂亮但已经坏了的服务。

## 不用全世界可读的文件来存密钥：LoadCredential

老套路是 `EnvironmentFile=/etc/api/env` 配 `0600` 权限，这没问题，直到出问题：值在进程
环境里，`/proc` 里可见，并被每个子进程继承。改为让 `LoadCredential=` 把密钥交给
systemd。systemd 以 root 读取文件，然后降权，只通过一个仅该服务可读的私有目录把内容
暴露出来：

```ini
LoadCredential=db_password:/etc/api/db_password
```

在服务内部，路径是 `$CREDENTIALS_DIRECTORY/db_password`；对 `Type=oneshot` 单元，`%d`
展开到同一个目录。密钥永远不碰环境变量，不出现在 `systemctl show` 里，单元停止时就被
删除。再配上 `StandardOutput=journal`，你就不必再担心某个密码泄漏进日志行。

## 当加固弄坏了一个正在工作的服务

一定会的。失效几乎总是服务在做某件你忘了它做的事，症状通常是启动失败，或者是 journal
深处一个权限错误，而不是一个干净的消息。做实验时留一个 root shell 开着，并记住常见
坏法的形状：

- **`ProtectSystem=strict`** 弄坏任何要写 `/var/log`、`/etc`、`/run` 或自身安装目录的
  东西。把路径加进 `ReadWritePaths=`。
- **`PrivateTmp=true`** 弄坏那些指望 `/tmp` 下有个与别的进程共享的套接字或状态文件的
  守护进程。
- **`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`** 弄坏需要开 netlink 套接字
  （`AF_NETLINK`）的服务，而大多数感知网络的守护进程都要。
- **`SystemCallFilter=~@resources`** 弄坏任何调用 `setrlimit`、`prlimit` 或
  `sched_setaffinity` 的东西。
- **`MemoryDenyWriteExecute=true`** 弄坏任何 JIT——Node、部分 Python C 扩展、.NET。对
  运行时编译的解释器留它关上。
- **`ProtectHome=true`** 弄坏配置或数据放在 `/home` 下的服务。

恢复应该是一条命令，这正是 drop-in 的意义所在。回退你的本地改动，reload，重启：

```bash
# 删除所有本地 drop-in，回到打包自带的单元
sudo systemctl revert api.service
sudo systemctl daemon-reload
sudo systemctl restart api.service
systemctl status api.service
```

从上往下读 journal，修那个*具体*缺失的权限，而不是删掉整个加固块。昂贵的那一行是
`MemoryDenyWriteExecute=true`，不是 `NoNewPrivileges=true`。

## 一个完整的加固单元

把上面拼起来，一个我愿意公开暴露的 API：

```ini
# /etc/systemd/system/api.service
[Unit]
Description=Public API
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/api --config /etc/api/config.yaml

# 临时身份，没有真实账户，没有家目录
DynamicUser=true
StateDirectory=api
RuntimeDirectory=api
WorkingDirectory=/var/lib/api

# 文件系统：除它自己拥有的之外，处处只读
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible

# 权限与系统调用表面
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources @obsolete
SystemCallArchitectures=native

# 资源上限与 umask
MemoryMax=512M
CPUQuota=150%
TasksMax=64
UMask=0077

# 由 systemd 提供的密钥，而不是一个全世界可读的文件
LoadCredential=db_password:/etc/api/db_password

[Install]
WantedBy=multi-user.target
```

注意这里没有 `ReadWritePaths`：`StateDirectory` 和 `RuntimeDirectory` 已经划出了
`/var/lib/api` 和 `/run/api`，`ProtectSystem=strict` 管住其余部分。这就是那个模式——
从最严格的视图起步，只把服务证明它需要的东西加回来，一次一个重启。

贯穿始终的一点是：systemd 加固不是一份粘贴一次的清单。它是一个测量循环：用
`systemd-analyze security` 看到暴露面，加上那条能让分数下降的最便宜指令，确认服务仍能
工作，继续。单元文件是干这件事的正确地方，因为它是唯一一处会在每次开机时生效、并在每次
重启后存活的地方。如果你还在搭整台机器，先从
[加固一台公网服务器](/zh/posts/hardening-a-public-server/) 里的操作系统级清单开始；如果
你要排维护任务，[systemd 定时器 vs cron](/zh/posts/systemd-timers-vs-cron/) 那篇从调度
这一侧讲了同一套机制。
