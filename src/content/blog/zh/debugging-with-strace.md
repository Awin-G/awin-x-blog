---
title: "用 strace 调试：当系统调用自己讲出故事"
description: "一份用 strace 做系统调用调试的实战指南：它何时胜过调试器或日志、如何安全地附加到进程、怎么读 open/read/connect/futex 输出与 errno、值得背下来的过滤器（-e trace、-f、-p、-y、-T、-tt）、三个真实排查过程，以及 ltrace 和 bpftrace 各自的位置。"
pubDate: 2026-11-27
lang: zh
translationKey: debugging-with-strace
tags: [linux, devops]
featured: false
keywords:
  - strace
  - 系统调用调试
  - 故障排查
  - 附加到进程
  - futex
---

调试器需要断点和符号。日志需要你在几周前就预言到这个问题。但大量**故障排查**
真正面对的，是一个进程在做你从未写过一行代码的事——等一把锁、`connect` 失败、
往一个你根本不知道的路径里写东西。**strace** 正是为此存在的。它是一件笨拙而诚实
的**系统调用调试**工具：它记录程序发出的每一次系统调用，连同参数和返回值。而且
因为它对任何二进制都有效（包括你无法重新编译的那些），当你**附加到进程**
（attach to process）去问「你现在到底在干什么」时，`strace` 常常是唯一能开口的
那个。

## strace 展示什么，以及它什么时候胜过调试器

程序自己做的事其实很少。它读文件、申请内存、开 socket、等 futex，剩下的都交给
内核。每一次从用户态跨到内核态，都是一次**系统调用（syscall)**，而 `strace` 就
守在这条边界上，把每一次都打印出来。整个模型就这么多，值得记住：

<figure>
<svg viewBox="0 0 640 220" width="100%" role="img" aria-label="程序发起系统调用；strace 在边界处拦截并打印；内核执行后返回结果或 errno。">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <rect x="10" y="30" width="180" height="70" rx="6" fill="currentColor" opacity="0.10" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="100" y="60" text-anchor="middle" opacity="0.9">你的程序</text>
    <text x="100" y="80" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" opacity="0.6">read(3, ...)</text>

    <rect x="230" y="30" width="180" height="70" rx="6" fill="currentColor" opacity="0.18" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="320" y="60" text-anchor="middle" opacity="0.9">strace (ptrace)</text>
    <text x="320" y="80" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" opacity="0.6">= -1 ENOENT</text>

    <rect x="450" y="30" width="180" height="70" rx="6" fill="currentColor" opacity="0.10" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="540" y="60" text-anchor="middle" opacity="0.9">内核</text>
    <text x="540" y="80" text-anchor="middle" opacity="0.6">干活</text>

    <line x1="190" y1="65" x2="230" y2="65" stroke="currentColor" stroke-width="1.5" marker-end="url(#a)"/>
    <line x1="410" y1="65" x2="450" y2="65" stroke="currentColor" stroke-width="1.5" marker-end="url(#a)"/>
    <defs>
      <marker id="a" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="currentColor"/>
      </marker>
    </defs>
    <text x="10" y="150" opacity="0.7" font-size="11">strace 打印穿过这条线的每一笔——进去的是参数，出来的是</text>
    <text x="10" y="168" opacity="0.7" font-size="11">结果或 errno。不需要源码、符号或对方配合。</text>
    <text x="10" y="200" font-family="ui-monospace, monospace" font-size="11" opacity="0.5">用户空间 ————————————— 内核空间</text>
  </g>
</svg>
<figcaption><code>strace</code> 通过 <code>ptrace</code> 在用户态/内核态边界处消费系统调用流，因此它精确地看到程序向内核要什么、又拿回什么。</figcaption>
</figure>

调试器告诉你**你自己的**代码哪里慢、哪里错。`strace` 告诉你进程在向系统要什么，
这是另一个、往往更有用的问题。三种我会第一时间伸手去拿它的情况：

- **没有源码或符号。** 厂商的二进制、被 strip 过的 Go 服务、闭源 agent。`strace`
  两者都不需要。
- **故障在环境里，不在代码里。** 少了一个文件、端口没开、权限位不对。程序本身没
  问题，是它周围的世界不对。
- **进程已经在跑、且正在抽风。** 你不能重启它，也不能冒着风险把 `gdb` 挂到一个
  活着的生产进程上。`strace -p` 更轻，能直接回答「它此刻在干什么」。

## 如何附加到进程（attach to process）——以及性能警告

大家记得住的命令就是附加形式：

```console
$ sudo strace -p 4711
strace: Process 4711 attached
read(7, 0x7ffd1c2a3f10, 8192)  = -1 EAGAIN (Resource temporarily unavailable)
epoll_wait(4, [], 128, 1000)   = 0
```

这能行，第一次用时简直像魔法。但要先搞清楚它的代价。`strace` 用的是 `ptrace`，
它会在**每一次**系统调用的进入和退出处停下目标进程，把控制权交给 `strace`，然后
再放它继续跑。对于一个每秒做几千次系统调用的程序，这是巨大的拖累——通常是
**10 倍到 100 倍**，有时更糟。对一个繁忙的服务来说，挂上 `strace` 不是被动观察，
而是踩了一脚刹车。这个警告不是理论：

- 永远不要在生产高峰随手附着一个对延迟敏感的进程。
- 尽量短采：挂上、看几秒、脱离。
- 如果进程重启成本不高，就用一个能**复现问题的输入**去 `strace` 一个新实例，而
  不是对活着的那个动手。
- 如果你确实需要以极低开销观察一条热门生产路径，那是 `bpftrace` 的活，不是
  `strace`（见后面「邻居」一节）。

还有两件值得知道的事。第一，`-f` 是你总会忘了带、然后才发现需要的那个标志：它
会跟随线程和子进程。现代服务都是线程池和 fork 出来的 worker，没有 `-f`，你只是
盯着一个线程，错过所有有意思的东西。第二，当你要附着的进程在容器或别的命名空间
里时，`strace` 必须有足够的权限才能看到它——通常是宿主机上的 `sudo`，或者进入
容器的 PID 命名空间。

## 读懂输出：open、read、write、connect、futex 与 errno

输出看着吓人，其实非常规整。每一行都是：

```text
syscall(arguments) = return_value
```

故事就藏在返回值里。非负的返回值通常表示成功（往往是字节数或文件描述符）；
`-1` 表示失败，而 `errno` 说出了原因。学会只扫输出的右边缘，你就已经走到诊断的
大半路程了。

```console
$ strace -f -tt -T -y -e trace=openat,connect,read,write ./service
14:02:11.418932 openat(AT_FDCWD, "/etc/mysvc/config.yaml", O_RDONLY) = -1 ENOENT (No such file or directory)
14:02:11.419010 connect(5, {sa_family=AF_INET, sin_port=htons(5432), sin_addr=inet_addr("127.0.0.1")}, 16) = -1 ECONNREFUSED (Connection refused)
14:02:11.419104 openat(AT_FDCWD, "/var/lib/mysvc/state.db", O_RDWR|O_CREAT, 0644) = 9</fd>
14:02:11.419301 write(9, "{\"pid\":812}\n", 11) = 11 <0.000042>
```

每一种系统调用都在回答一个具体的问题：

| 系统调用 | 它回答的问题 | 常见失败 |
| --- | --- | --- |
| `openat` | 它想碰哪个文件？ | `ENOENT`（不存在）、`EACCES`（权限） |
| `read`/`write` | 它在搬数据吗，搬了多少？ | `EAGAIN`（非阻塞）、`EPIPE` |
| `connect` | 它在往哪里拨出去？ | `ECONNREFUSED`、`ETIMEDOUT` |
| `futex` | 它是不是卡在锁上了？ | 停在 `FUTEX_WAIT` |
| `epoll_wait` | 它是不是在空等事件？ | 超时过长、始终没就绪 |

`errno` 才是重点。`ENOENT` 和 `EACCES` 看起来很像——都表示「打不开」——但一个是
路径错了，另一个是用户错了。`ECONNREFUSED` 意味着那个地址上确实有东西在监听，
只是拒绝了你；`ETIMEDOUT` 意味着根本没人应答。把 `errno` 读对，就完成了
**系统调用调试**的大部分工作。

## 让系统调用调试（syscall debugging）可读的过滤器

对真实程序跑裸的 `strace` 就是消防栓。下面这些标志把它变成人能读的东西：

- **`-e trace=`** —— 按系统调用过滤。`-e trace=file`（所有碰路径的）、
  `-e trace=network`，或像 `-e trace=openat,connect,read,write` 这样的显式列表。
  这是收益最大的一个。
- **`-f`** —— 跟随 fork 出来的子进程和线程。
- **`-p PID`** —— 附加到正在运行的进程（可重复、可用逗号分隔多个）。
- **`-y`** —— 把文件描述符解码成它指向的路径或 socket。把 `read(7, ...)` 变成
  `read(7</var/log/mysvc.log>, ...)`。
- **`-T`** —— 用尖括号打印每次系统调用的墙钟耗时。
- **`-tt`** —— 加上时间戳前缀（再多一个 `t`，即 `-ttt`，就是 epoch 秒）。

合起来用，你就得到一条真正能推理的时间线：

```console
$ sudo strace -f -tt -T -y -e trace=file -p 4711 2>&1 | head -n 20
14:05:02.100201 openat(AT_FDCWD, "/etc/mysvc/config.yaml", O_RDONLY) = -1 ENOENT (No such file or directory) <0.000021>
14:05:02.100502 openat(AT_FDCWD, "/etc/mysvc/config.yml",  O_RDONLY) = -1 ENOENT (No such file or directory) <0.000018>
14:05:02.100980 openat(AT_FDCWD, "/etc/mysvc/config.json", O_RDONLY) = 12</etc/mysvc/config.json> <0.000034>
```

把 `strace` 重定向到文件再 grep——`-o trace.log` 能让程序自己的 stdout 保持干净，
这在交互式运行时很重要。

## 三个真实排查过程

### 1.「文件找不到」——到底是哪个路径？

一个服务启动即退出，只给了句笼统的 `config not found`。日志没说它试了哪个路径。
一条命令就能终止猜测：

```console
$ strace -f -e trace=openat,newfstatat ./mysvc 2>&1 | grep -i config
openat(AT_FDCWD, "/etc/mysvc/config.yaml", O_RDONLY) = -1 ENOENT
openat(AT_FDCWD, "/etc/mysvc/config.yml",  O_RDONLY) = -1 ENOENT
openat(AT_FDCWD, "/etc/mysvc/config.json", O_RDONLY) = 3
newfstatat(AT_FDCWD, "/etc/mysvc/plugins", ...) = -1 ENOENT
```

它先试 YAML、再试 YAML、然后试 JSON——而真正的问题在下一行：插件目录不存在，
所以服务启动后就死了。应用的消息是真话但没用；`strace` 说出了那个路径。这跟
[读懂 Linux 负载平均值](/zh/posts/linux-load-average/) 是同一种直觉：别信摘要，
去看底层的事件。

### 2.「连接被拒绝」——被谁、在哪个地址？

一个 worker 报数据库错误。是主机错了、端口错了、IPv4 还是 IPv6、超时还是拒绝？
`-y` 加 `-e trace=connect` 直接回答：

```console
$ sudo strace -f -yy -T -e trace=connect -p 4711 2>&1 | head
connect(5, {sa_family=AF_INET, sin_port=htons(5432), sin_addr=inet_addr("127.0.0.1")}, 16) = -1 ECONNREFUSED (Connection refused) <0.000311>
connect(6, {sa_family=AF_INET6, sin6_port=htons(5432), in6_addr=inet_pton(AF_INET6, "::1")}, 28) = -1 ECONNREFUSED (Connection refused) <0.000288>
```

应用在试 `127.0.0.1:5432` 和 `::1:5432`。那里没有任何东西在监听——
`ECONNREFUSED`（一个 RST）和防火墙丢包是两回事，后者会在很长一段 `<...>` 延迟后
表现为 `ETIMEDOUT`。在容器里，`127.0.0.1` 往往根本是错的地址：数据库在另一个
服务上，而配置继承了一个 loopback 的默认值。系统调用告诉了我们地址，地址又告诉
了我们 bug。对于延迟类的问题，这种只看右边缘的读法，刚好可以和
[I/O 延迟分析](/zh/posts/io-latency/) 搭配。

### 3.「它卡住了」——futex、socket read，还是死锁？

进程还活着，CPU 占用 0%，但毫无进展。附着上去，看它卡在哪：

```console
$ sudo strace -f -tt -T -p 4711
[pid  4730] futex(0x7f2a1c001234, FUTEX_WAIT_PRIVATE, 3, NULL <unfinished ...>
[pid  4731] futex(0x7f2a1c001234, FUTEX_WAIT_PRIVATE, 3, NULL <unfinished ...>
[pid  4711] read(12</dev/tcp? or socket>, ... <unfinished ...>
```

`futex(..., FUTEX_WAIT, ...)` 意味着线程停在一把锁上——互斥量、条件变量、Go 里的
channel。如果有多个线程停在**同一个** futex 地址上，你面对的是应用代码里的竞争
或死锁问题，不是内核问题。而一个线程卡在没设超时的 socket `read()` 上、或者卡在
带长超时的 `epoll_wait` 里，就是另一回事了：它在等一个永远不会应答的对端，这正
是超时在[调试嵌入式 TCP](/zh/posts/debugging-tcp-on-embedded/) 时如此重要的原因。
`strace` 两个都修不了，但它能几秒钟内告诉你手里的是哪一个。

## 邻居：ltrace 与 bpftrace

`strace` 盯的是内核边界。有两个相关工具盯的是别的边界：

- **`ltrace`** 拦截的是**库调用**（`malloc`、`strcpy`、你自己的共享对象）。当
  真正有意思的错误出在用户态库的使用方式上、而不是某次系统调用时，它很好用；
  但它维护得不如 strace、也更慢——在 `strace` 表明系统调用都正常时再用它。
- **`bpftrace`** 用 eBPF 观测内核，开销**低得多**，也没有那种让全世界停下的
  `ptrace`。它还能做聚合（直方图、计数），可以在繁忙的生产系统上跑，一次就能
  同时追踪系统调用、内核函数等等。代价是语言更陡、需要较新的内核。当 `strace`
  的开销不可接受时——或者你需要跨越几百万个事件去统计——就用 `bpftrace`。

经验法则：**`strace` 用来问「这一个进程此刻在干什么」，`ltrace` 用来观察库层级
的行为，`bpftrace` 用来做集群规模、常开式的可观测性。**

## 安全提醒：不要随意 strace 繁忙的生产进程

我要把这话说白，因为它让人付出过事故的代价。`strace` 会在每一次系统调用处暂停
目标。在一个高吞吐的服务上，这就是自己制造的一次故障：延迟尖峰、超时、请求被
丢。动手之前：

- 如果进程重要，先拿到许可和一段维护窗口。
- 用 `-e trace=` 把消防栓收窄，并让采集尽量短。
- 用 `-o file`，免得自己被终端阻塞住。
- 考虑用一个新实例、同样的输入去复现。
- 如果你需要低开销、常开式的观察，改用 `bpftrace`。

`strace` 是这个**故障排查**工具箱里价值最高的工具之一，恰恰因为它对程序什么都
不要求——不要源码、不要符号、不要重启。也请尊重它同等的威力：它能盘问任何进程，
也能拖停任何进程。短暂地、有意识地、用在一个你有权让它变慢的东西上，它就把
「我完全不知道它在干什么」变成一行答案。
