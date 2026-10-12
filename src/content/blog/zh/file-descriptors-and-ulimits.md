---
title: "文件描述符上限：「打开文件过多」的成因与修复"
description: "文件描述符是什么，为什么文件、套接字和管道共享同一个上限，如何用 ulimit -n 和 /proc/<pid>/limits 查看软限制与硬限制，EMFILE 的含义，以及修复「打开文件过多」的清单：先提高上限，再找到泄漏。"
pubDate: 2027-01-06
lang: zh
translationKey: file-descriptors-and-ulimits
tags: [linux, devops]
featured: false
keywords:
  - 文件描述符上限
  - 打开文件过多
  - ulimit -n
  - EMFILE
  - LimitNOFILE
  - lsof
  - /proc/pid/fd
---

每隔几个月，我的某个服务就会以同样的方式挂掉：CPU 正常，内存正常，日志里刷满 `Too many open files`。进程不是耗尽了 RAM——而是耗尽了**文件描述符**，也就是内核为每个打开的文件、套接字、管道和 eventfd 分配的小整数。当进程触及自己的**文件描述符上限**时，下一次 `open()`、`socket()` 或 `accept()` 就会以 `EMFILE`（"Too many open files"，打开文件过多）失败，而无法 `accept()` 的服务器就是一台死服务器。这篇文章里，我会讲清楚文件描述符是什么、如何用 `ulimit -n` 和 `/proc/<pid>/limits` 读取软限制与硬限制、`EMFILE` 到底意味着什么，以及修复的两步走：先提高上限，再找到泄漏。以下所有输出都是在这台机器上真实捕获的。

## 文件描述符到底是什么

<figure>
  <svg viewBox="0 0 560 240" role="img" aria-label="进程的进程文件描述符表，将小整数映射到内核对象" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/>
      </marker>
    </defs>
    <text x="20" y="24" font-family="monospace" font-size="14" fill="currentColor">进程的 fd 表</text>
    <g font-family="monospace" font-size="13" fill="currentColor">
      <rect x="20" y="40" width="150" height="26" fill="none" stroke="currentColor"/>
      <text x="30" y="57">0 → /dev/null</text>
      <rect x="20" y="70" width="150" height="26" fill="none" stroke="currentColor"/>
      <text x="30" y="87">1 → 套接字</text>
      <rect x="20" y="100" width="150" height="26" fill="none" stroke="currentColor"/>
      <text x="30" y="117">2 → 套接字</text>
      <rect x="20" y="130" width="150" height="26" fill="none" stroke="currentColor"/>
      <text x="30" y="147">3 → 文件</text>
      <rect x="20" y="160" width="150" height="26" fill="none" stroke="currentColor"/>
      <text x="30" y="177">… → 管道、eventfd…</text>
    </g>
    <g stroke="currentColor" fill="none" marker-end="url(#arr)">
      <line x1="170" y1="53" x2="240" y2="53"/>
      <line x1="170" y1="83" x2="240" y2="83"/>
      <line x1="170" y1="113" x2="240" y2="113"/>
      <line x1="170" y1="143" x2="240" y2="143"/>
      <line x1="170" y1="173" x2="240" y2="173"/>
    </g>
    <g font-family="monospace" font-size="13" fill="currentColor">
      <text x="250" y="57">文件（inode）</text>
      <text x="250" y="87">TCP 套接字</text>
      <text x="250" y="117">TCP 套接字</text>
      <text x="250" y="147">文件（inode）</text>
      <text x="250" y="177">管道 / eventfd / …</text>
    </g>
    <text x="20" y="220" font-family="monospace" font-size="12" fill="currentColor">一个整数 = 一个槽位 = 一个内核对象</text>
  </svg>
  <figcaption>每个打开的文件、套接字、管道或 eventfd，都会恰好消耗进程文件描述符表中的一个槽位。</figcaption>
</figure>

文件描述符（fd）不过是一个指向每进程表的索引。内核为每个进程维护一张表；每一行指向某个内核对象——一个打开的文件、一个 TCP 套接字、一个管道、一个 eventfd、一个 epoll 实例。当你调用 `open()`、`socket()`、`pipe()` 或 `epoll_create()` 时，内核分配最低的空闲行并返回它的编号。当你 `close()` 它时，该行被释放。机制就这么简单。

真正让人吃亏的后果是：**一切**都消耗一个 fd。一个监听套接字是一个 fd。每个被接受的连接是一个 fd。每个日志文件、每个通往子进程的管道、每个 timerfd——各占一个 fd。一个接受了连接却忘记关闭的服务器，就会按请求数量永久泄漏 fd。

一个普通的 shell 就能看出它的形状：

```
$ ls -l /proc/self/fd
total 0
lr-x------ 1 awinx awinx 64 Oct 13 03:47 0 -> /dev/null
lrwx------ 1 awinx awinx 64 Oct 13 03:47 1 -> socket:[5059678]
lrwx------ 1 awinx awinx 64 Oct 13 03:47 2 -> socket:[5059680]
lr-x------ 1 awinx awinx 64 Oct 13 03:47 3 -> /proc/596590/fd
$ ls /proc/self/fd | wc -l
4
```

四个 fd：stdin、两个套接字（这个 shell 的 stdout 和 stderr 是套接字，因为它的输出被捕获了），以及 `/proc/self/fd` 目录本身。`socket:[...]` 条目是内核套接字，方括号里的数字是内核 inode 号。

## 软限制与硬限制：ulimit -n 的数字从哪来

每个进程都有两个数字：**软限制**（内核当前强制执行的值）和**硬限制**（非特权进程可以把软限制提升到的上限）。`ulimit -n` 打印软限制；`ulimit -Hn` 打印硬限制。权威的查看方式是 `/proc/<pid>/limits`：

```
$ ulimit -n
524288
$ ulimit -Sn
524288
$ ulimit -Hn
524288
$ grep 'open files' /proc/self/limits
Max open files            524288               524288               files
```

在这台机器上，软限制和硬限制都是 524288。在典型的服务器上它们不同——比如软限制 1024、硬限制 65536——而这个差距就是你可以不借助 root 就能认领的空间。

这些数字的来源，按优先级排列：

- **Docker**：`docker run` 上的 `--ulimit nofile=SOFT:HARD`，或守护进程的默认值。容器不会继承宿主机的限制。
- **systemd**：单元文件 `[Service]` 段中的 `LimitNOFILE=`。大多数守护进程的限制实际上就是它设置的。
- **登录 PAM**：`/etc/security/limits.conf` 应用于登录会话（以及任何经过 PAM 的东西）。在这台机器上它是空的——没有任何非注释行——所以沿用默认值。
- **内核天花板**：`fs.nr_open` 是绝对的单进程最大值；`fs.file-max` 是系统级总量。任何东西都不能超过它们，root 也不行。

```
$ cat /proc/sys/fs/file-max /proc/sys/fs/nr_open
9223372036854775807
2147483584
```

配置长这样：

```
# /etc/security/limits.conf — 在登录时通过 PAM 生效
*         soft    nofile      65536
*         hard    nofile      65536
```

```
# /etc/systemd/system/myapp.service
[Service]
LimitNOFILE=65536
```

```
$ docker run --ulimit nofile=65536:65536 ...
```

## 实时观察文件描述符

我常用的三个工具，按顺序：

- `ls /proc/<pid>/fd` —— 原始表。`ls /proc/<pid>/fd | wc -l` 就是数量。
- `lsof -p <pid>` —— 同一张表的解码版：文件类型、路径、套接字状态。
- `ss -tlnp` —— 哪个进程拥有哪个监听套接字。

来自后文的服务器实验：

```
$ ss -tlnp | grep 8766
LISTEN 65     64         127.0.0.1:8766       0.0.0.0:*    users:(("python3",pid=608200,fd=3))
```

这一行告诉我：监听者是 pid 608200、fd 3，backlog 为 64。

## 故障：EMFILE，以及它更安静的表亲 ENFILE

`EMFILE`（errno 24）表示*这个进程的* fd 表满了。`ENFILE`（errno 23）表示*系统级*的表满了——所有进程加在一起耗尽了 `fs.file-max`。`EMFILE` 是常见的那种；`ENFILE` 很少见，通常意味着内核层面的问题，或者进程数量真的太多了。

下面是一个最小复现程序。它打开回环 TCP 套接字，直到内核拒绝为止：

```python
# leak.py — 打开套接字直到 EMFILE
import errno, os, socket, time

sockets = []
try:
    while True:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind(("127.0.0.1", 0))
        s.listen(1)
        sockets.append(s)
except OSError as e:
    print(f"opened {len(sockets)} sockets before failure")
    print(f"error: errno={e.errno} ({errno.errorcode.get(e.errno, '?')}): {e}")
    print(f"my pid: {os.getpid()}")
    time.sleep(25)
```

在子 shell 里降低软限制来运行它：

```
$ bash -c 'ulimit -n 256; python3 -u leak.py'
opened 253 sockets before failure
error: errno=24 (EMFILE): [Errno 24] Too many open files
my pid: 594982
inspect me now:  ls /proc/594982/fd | wc -l
$ ls /proc/594982/fd | wc -l
256
$ grep 'open files' /proc/594982/limits
Max open files            256                  256                  files
```

253 个套接字加上解释器自己的三个标准 fd，恰好把表填满到 256。用普通文件也是一样的结果：

```
$ bash -c 'ulimit -n 128; python3 -c "import errno; ..."'
opened 125 files before failure
error: errno=24 (EMFILE): [Errno 24] Too many open files: '/tmp/opencode/work/fd-ulimits/filler.txt'
```

接下来是生产环境中真正要紧的版本：一台 `accept()` 失败的服务器。这个服务器在回环地址上监听、接受连接，而——就是这个 bug——从不关闭它们：

```
$ bash -c 'ulimit -n 64; python3 -u server.py 8766' &
$ python3 client.py          # 打开 200 个连接
opened 50
opened 100
connection 125 failed: timed out
client holding 124 connections
```

服务器的日志：

```
accepted #58 from ('127.0.0.1', 58952)
accepted #59 from ('127.0.0.1', 58960)
accept() died after 59 connections: errno=24 (EMFILE): [Errno 24] Too many open files
```

接受了 59 个连接之后，`accept()` 开始失败。客户端的第 125 个连接超时——服务器还在监听，但它无法再接受新的 fd，于是新连接堵在 backlog 里。检查这个垂死的进程：

```
$ grep 'open files' /proc/608200/limits
Max open files            64                   64                   files
$ ls /proc/608200/fd | wc -l
64
$ lsof -p 608200 | awk 'NR>1 {print $5}' | sort | uniq -c
      1 CHR
      2 DIR
      1 FIFO
     60 IPv4
     15 REG
```

fd 表里恰好有 64 个条目——也就是上限。lsof 的行中有 60 行是 IPv4 套接字：监听套接字，加上 59 个从未关闭的被接受连接。其余的是解释器自己的文件（二进制文件、映射的库、cwd、root）。

## 为什么 fd 泄漏看起来像内存泄漏的表亲

在泄漏进程吞吃 fd 的同时观察它的内存：

```
$ grep VmRSS /proc/609478/status
VmRSS:	   14692 kB
$ ls /proc/609478/fd | wc -l
256
```

RSS 是 14 MB，而且在 fd 数量爬向上限时几乎不动——套接字和文件消耗的是内核内存，不是用户态 RSS。所以在你所有的内存监控图上，这个进程看起来都很健康，而它的 fd 表却在不断填满。症状不是"进程变大了"，而是"进程停止处理新工作"。如果你只监控内存，fd 泄漏就是隐形的，直到服务倒下的那一天。

## 提高上限只是买时间，找到泄漏才是修复

Docker 让限制变得明确，并在容器内部证明了它：

```
$ ulimit -n                      # 在宿主机上
524288
$ docker run --rm alpine:3.21 sh -c 'ulimit -n'
1024
$ docker run --rm --ulimit nofile=64:64 alpine:3.21 sh -c 'ulimit -Sn; ulimit -Hn'
64
64
```

容器并不继承宿主机的 524288——它拿到的是守护进程默认值 1024，而 `--ulimit nofile=64:64` 把它钉在 64。故障也随之下降：

```
$ docker run --rm --ulimit nofile=64:64 alpine:3.21 sh -c 'i=3; while [ $i -lt 70 ]; do eval "exec $i<>/dev/null" || { echo "open failed at fd $i"; break; }; i=$((i+1)); done'
sh: eval: line 0: can't create /dev/null: No file descriptors available
$ docker run --rm --ulimit nofile=64:64 debian:bookworm-slim bash -c 'i=3; while [ $i -lt 70 ]; do if eval "exec $i<>/dev/null"; then i=$((i+1)); else echo "open failed at fd $i"; break; fi; done'
bash: line 1: /dev/null: Too many open files
open failed at fd 64
```

在容器内部，fd 3–63 都能正常打开，而 fd 64 失败——同样是 `EMFILE`，只是用了 shell 自己的措辞（busybox 里是 "No file descriptors available"，bash 里是 "Too many open files"）。

所以修复分两步，而且顺序很重要：

1. **先找泄漏。** 如果 fd 数量无上限地增长，提高限制只会推迟崩溃。随时间观察 `ls /proc/<pid>/fd | wc -l`，或者按类型分组的 `lsof -p <pid>`，并在负载之后做 diff。泄漏通常是错误路径上漏掉的 `close()`、从不收缩的连接池，或者每次请求都打开点什么东西的库。
2. **然后再提高上限**，匹配你实际需要的用量。在子 shell 里：`bash -c 'ulimit -n 65536; exec myapp'`。守护进程：systemd 单元里的 `LimitNOFILE=`。容器：`--ulimit nofile=`。登录服务：`/etc/security/limits.conf`。把软限制朝硬限制方向提高；只有 root 能提高硬限制，而且永远不能超过 `fs.nr_open`。

## 排查清单

当服务日志出现 `Too many open files` 时：

- [ ] 确认限制：`ulimit -n`、`ulimit -Hn`、`grep 'open files' /proc/<pid>/limits`。
- [ ] 数一数 fd：`ls /proc/<pid>/fd | wc -l`，以及按类型分组的 `lsof -p <pid>`。
- [ ] 随时间观察数量——泄漏会增长，繁忙但健康的服务器会趋于平稳。
- [ ] 在提高任何限制之前先找到泄漏：漏掉的 `close()`、每次请求都打开的东西、从不收缩的池。
- [ ] 把上限提高到匹配合法用量的水平：systemd 用 `LimitNOFILE=`，Docker 用 `--ulimit nofile=`，登录会话用 `limits.conf`。
- [ ] 对 fd 使用率告警（比如上限的 80%），让下一次泄漏在用户发现之前先找到你。

这个 bug 从来不是数字本身的问题——而是数字与代码之间的差距。提高上限，没错，但一定要去找到那个泄漏。

---

如果你想看一个失败的 `open()` 在系统调用层面的样子，我的文章 [用 strace 调试](/zh/posts/debugging-with-strace/) 正好完整地走了这个过程。而如果你的服务器在耗尽 fd *之前*就先变慢了，那就从 [Linux 负载平均值](/zh/posts/linux-load-average/) 开始——这两种故障模式经常结伴出现。
