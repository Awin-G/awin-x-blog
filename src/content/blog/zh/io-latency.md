---
title: "磁盘 I/O 延迟排障：读懂 iostat、await 与 iowait"
description: "CPU 空闲却负载很高，问题通常出在磁盘。本文讲清怎么读 iostat -x 里的平均 await、%util 与队列深度，如何区分吞吐问题与延迟问题，用 iotop 和 /proc/<pid>/io 抓出真凶进程，并处理 fsync 密集、WAL、swap 抖动与日志刷屏。"
pubDate: 2026-11-22
lang: zh
translationKey: io-latency
tags: [devops, linux]
featured: false
keywords:
  - iostat
  - 磁盘 I/O 延迟
  - iowait
  - await
  - 队列深度
---

一台机器感觉很慢，CPU 却闲着，元凶通常是**磁盘 I/O 延迟**，而不是计算。负载平均值
统计的是卡在 `D` 状态的任务，所以在什么都没真跑的时候它照样往上涨；**iowait** 告诉你
有失速，却不告诉你慢的是哪块设备。能点名设备的那一个指标，是 **iostat** 里的平均
**await**。这就是我从「服务器好慢」走到「一块指定的设备、一个指定的进程、一个具体的
修法」所走的路径。

## 为什么负载平均值与 iowait 会藏住磁盘 I/O 延迟

我之前写过[为什么 Linux 负载平均值会骗人](/zh/posts/linux-load-average/)，
存储版本的剧情很短。一个阻塞在慢盘上的任务停在不可中断睡眠（`D` 状态），在 I/O 返回
之前杀都杀不掉，而每个这样的任务都给负载计数加一。这段时间 CPU 全程空闲。于是你得到
那个经典形状：负载顶得很高，`%us` 接近零，`%wa` 接近 100。

```console
$ vmstat 1 3
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 0 14      0 210400  39812 1890000    0    0  4096 12288  720 1440  2  1  3 94  0
 0 15      0 208900  39812 1889000    0    0  5120 13000  700 1420  2  1  2 95  0
```

`b` 是 14~15，`r` 是 0，`wa` 约 94%。这是一个披着 CPU 外衣的磁盘问题。但 **iowait**
反过来也是个坑：它是一个按 CPU 统计的计数器，只有当那颗 CPU 本来会空闲时才会计数。
它完全不说*哪一块*设备慢，而且在一台忙碌的多核机器上，哪怕某个容器正被共享卷饿着，
它也可能一直很低。把 iowait 当成「有东西阻塞在 I/O 上」的提示就够了——别把它当设备
指标。

## 该看的指标：await、%util、队列深度、百分位

四个数字，以及每个到底意味着什么：

- **`await`** —— 每个 I/O 请求从提交到完成的平均耗时，单位毫秒。它包含在队列里等待的
  时间*加上*设备真正处理这个请求的时间。`iostat` 把它拆成 `r_await` 和 `w_await`，这
  很重要，因为读和写在同块设备上的耗时特性差别极大。
- **`%util`** —— 设备至少有一个请求在途的墙上时钟占比。对单块机械盘，100% 就是饱和。
  对深队列的 NVMe，`%util` 可能读到 95%，而设备离极限还差得远。它是提示，不是判决。
- **队列深度**（新版 `iostat` 里叫 `aqu-sz`，老版本是 `avgqu-sz`）—— 平均在途请求数。
  就是它解释了 `await` *为什么*高：队列深，说明每个请求都在排队等前面的。
- **吞吐**（`r/s`、`w/s`、`rkB/s`、`wkB/s`）—— 对成本和容量有用，对延迟没用。

它们由**利特尔法则**连在一起：队列深度 ≈ 到达速率 × 延迟。知道两个，第三个就是算术。
所以「磁盘 100%」是一句没说完的话，直到你知道那是单条队列的 100%，还是设备在跑
80 万 IOPS 的 100%。

## 读懂 `iostat -x`：一次完整走读

一定要开扩展统计（`-x`），跳过无活动的设备（`-z`），并且忽略第一个采样——那是自开机
以来的平均，不是上一秒的。给个次数，拿到实时样本：

```console
$ iostat -xz 1 2
Device      r/s   w/s    rkB/s    wkB/s  %util  await  r_await  w_await  aqu-sz
nvme0n1    12.0  1840    256.0   74240.0   98.7   18.4     0.9     18.6    34.2
sda         0.2     6      8.0     384.0    3.1    6.2     4.1      6.3     0.0
```

从左往右读：`nvme0n1` 每秒 12 次读、1840 次写，所以这是写密集负载。`%util` 是 98.7——
设备几乎从不空闲。`await` 平均 18.4 ms，而读写拆分才是全部剧情：`r_await` 只有
0.9 ms，`w_await` 却是 18.6 ms。读没事，写才是问题。`aqu-sz` 是 34，意味着平均有 34
个写请求在排队，这正是 `w_await` 是 18 ms 而不是 1 ms 的原因。`sda` 闲着，无关。

这一行已经给出了形状：一块写受限、队列很深的设备。它还没告诉我，该修的是更多 IOPS、
更短的队列，还是一个更不病态的写入者。

## 吞吐问题 vs 延迟问题

这是两种不同的病，药也不同，而 `%util` 分不清它们。一个备份以 500 MB/s 跑出 20 ms 的
`await`，那是吞吐问题：活儿很多，延迟平坦。一个数据库每秒做 4000 次微型 `fsync` 写入、
`await` 也是 20 ms，那是延迟问题：数据很少，但每个请求都很贵。同样的 `await`，相反的
修法。

<figure>
<svg viewBox="0 0 640 260" width="100%" role="img" aria-label="随着施加的 I/O 负载上升，延迟先保持平坦，然后在饱和拐点处急剧上翘。队列深度在同一区间上升。">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <line x1="60" y1="220" x2="600" y2="220" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
    <line x1="60" y1="220" x2="60" y2="30" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
    <text x="600" y="240" text-anchor="end" opacity="0.7">施加的 I/O 负载 (r/s + w/s) &#8594;</text>
    <text x="22" y="30" opacity="0.7">延迟</text>
    <path d="M60 205 L320 165 L400 110 L448 45" fill="none" stroke="currentColor" stroke-width="2" opacity="0.35" stroke-dasharray="4 3"/>
    <text x="452" y="49" opacity="0.55">%util / 队列深度</text>
    <path d="M60 205 C 200 203, 300 195, 360 175 C 400 160, 420 120, 440 60" fill="none" stroke="currentColor" stroke-width="2.5"/>
    <text x="235" y="200" opacity="0.75">延迟 (await)</text>
    <circle cx="392" cy="155" r="4" fill="currentColor"/>
    <line x1="392" y1="155" x2="392" y2="220" stroke="currentColor" stroke-width="1" stroke-dasharray="3 3" opacity="0.4"/>
    <text x="398" y="212" opacity="0.75">拐点 = 饱和</text>
    <text x="72" y="200" font-family="ui-monospace, monospace" font-size="11" opacity="0.5">平坦区：队列吸收突发</text>
  </g>
</svg>
<figcaption>同一块磁盘，两种状态。拐点左侧，延迟平坦，加负载几乎免费。拐点右侧，吞吐已经到顶，每多一个请求只会把队列压得更深、把 <code>await</code> 成倍放大。</figcaption>
</figure>

拐点就是全部要害。在它下方，一块健康的磁盘用队列吸收短突发，`await` 保持平坦。在它
上方，额外的负载直接换算成延迟：吞吐不变，`await` 更差，p99 更差。如果一张图上
`%util` 是 100% 且 `await` 在往上爬，你就已经越过拐点了——再加活也帮不上忙。

## 找出真凶进程

设备级数字告诉你*在哪里*；下一步是*谁*。

**`iotop`** 给出一份按 I/O 排序的实时逐进程视图——在一百个闲着的进程里揪出一个失控
写入者，这是最快的办法。`pidstat -d` 是可脚本化的版本：它按间隔打印逐进程的读/写速率，
这正是你真正想记进日志的东西。

```console
$ iotop -oPa          # -o：只看有 I/O 的进程，-P：按进程，-a：累计
$ pidstat -d 1 5      # 逐进程 I/O 速率，每秒每个进程一行
```

**`/proc/<pid>/io`** 是地面的真相，在「该把账记在谁头上」这件事上从不说谎。
`write_bytes` 数的是真正下到块层的字节；`cancelled_write_bytes` 数的是被弄脏、又在落盘
之前被丢弃的页——用来识别一个白白浪费了磁盘的写入者很管用。

```console
$ cat /proc/$(pgrep -x postgres)/io
read_bytes:    918273645
write_bytes:  4471293840
cancelled_write_bytes: 812304
```

在容器里，改读 **cgroup** 计数器，因为命名空间里的 `iotop` 常常看到错的东西（cgroup v2
看 `io.stat`，v1 看 `blkio.throttle*`）：

```console
$ cat /sys/fs/cgroup/system.slice/postgresql.service/io.stat
8:0 rbytes=918273645 wbytes=4471293840 rios=120441 wios=981223 dbytes=0 dios=0
```

## 常见成因

- **fsync 密集的负载。** 一次 `fsync` 会等设备把写入变得持久。一个每条记录都 `fsync`
  一次的负载，会把一块快 SSD 变成慢设备，因为每次调用都要付设备整轮的刷盘延迟。
- **数据库 WAL。** Postgres 和 MySQL 都在提交时 `fsync` 它们的预写日志。组提交能摊薄，
  但 WAL 设备一慢，就给提交延迟钉下一个 CPU 再怎么加都补不回来的硬地板。
- **超大文件。** 一次几 GB 的 `cp`、一个构建 tarball、或者一次快照，会灌满页缓存、触
  发回写，并在那个工具早就返回之后继续把设备压满。
- **swap 抖动。** 如果 `vmstat` 显示 `si`/`so` 大于零，内存压力已经变成了磁盘延迟。在
  虚拟机上，这把每一次缺页都变成一次网络往返。
- **吵闹的邻居。** 在共享 EBS、vSAN 或宿主本地磁盘上，你的 `await` 有一部分是别人的
  负载。你能看见的那块设备，并不是你共享的那块设备上唯一的写入者。
- **日志刷屏。** 每个请求一行 debug 日志，如果是同步写、或者落在急于刷盘的 fs 上，就是
  一场自己招来的 `fsync` 风暴。

## 修法

把修法和「你是超了吞吐上限还是超了延迟上限」对上。

**批量写入。** 最便宜的一手。用分块缓冲刷新代替逐条刷新，用 `group commit`，写更少更大
的记录。吞吐（更少的操作数）和延迟（更短的队列）两头都受益。

**小心调 `vm.dirty_*`。** 脏页回写控制内核何时开始刷盘，它是一笔延迟/吞吐的交易：

```console
# 调低 = 延迟更平滑、突发吞吐更低；除非你知道原因，否则别往上调
vm.dirty_background_bytes = 268435456   # 脏页到 256 MiB 就开始回写
vm.dirty_bytes            = 536870912   # 脏页到 512 MiB 就阻塞写入者
vm.dirty_expire_centisecs = 1500        # 脏超过 15s 的页就刷
vm.dirty_writeback_centisecs = 500      # 每 5s 唤醒一次回写线程
```

把 `dirty_bytes` 调低，能让刷盘突发更小、`await` 更低，代价是内核永远不会一次性用满整
块盘。调高能让寻道合并，却恰好制造出你想修的那种长停顿。一次只改一个值，盯着 `await`
看。

**更快的盘或更多 IOPS。** 如果 `%util` 顶死、队列又深，那设备是真的没容量了。更多
IOPS（SATA 换 NVMe、云盘上配 provisioned IOPS）能把拐点抬高。

**拆分设备。** 把 WAL、日志和批量数据放到不同设备上，让一个没法把另一个饿死。一块专用
的 WAL 卷，是数据库存储上最值的一个决定。

**少记日志。** 降到 `info`，对 `debug` 采样，并让日志异步化。你通常会发现，那些正在偷
走你磁盘的东西，你有 90% 从来没读过。

如果你在管一支舰队，把告警挂到你能采取行动的症状上，而不是那个原始数字——
[监控一支小舰队](/zh/posts/monitoring-a-small-fleet/)里的那套纪律在这里直接适用。

## 延迟看的是 p99，不是均值

`iostat` 最重要的一条局限：它打印的每一个 `await` 都是**均值**。iostat 没有百分位输出。
而均值会藏住尾巴。一块平均 `await` 只有 2 ms 的设备，仍然可能把 200 ms 给到 1% 的请求，
因为那些请求排在了一次刷盘或一次突发的后面。那 1% 才是用户能感觉到的东西：它是你的
p99，而这是 `iostat` 看不见的。

同一类里还有两个坑。第一，平均 `await` 包含排队时间，所以两块均值相同的设备可能有截然
不同的尾巴——一块稳定 2 ms，另一块在 0.2 ms 和 400 ms 之间来回横跳。第二，拿一个很长
的间隔去平均，会把短停顿整段抹掉。

改为去拿分布。`biolatency`（eBPF）打印块层 I/O 延迟的直方图，而且它作用在真实设备上，
不是均值上：

```console
$ biolatency -m 1        # 单位 ms 的延迟直方图，每 1s 刷新
```

一旦你能看见形状，「磁盘很慢」就变成一句你可以动手的话：直方图平坦，说明服务时间稳定；
长长的右尾巴，说明排队或刷盘停顿；双峰的直方图，通常意味着两个不同的负载在共用一块
设备。每一种都有不同的修法，而没有一种能在均值里看见。

主线是这样：**负载平均值和 iowait 告诉你「有队列」；`iostat` 点名设备并把读和写分开；
`iotop` 和 `io.stat` 点名进程；延迟直方图告诉你这到底是吞吐见顶，还是尾部停顿。**
去量尾巴，去修真正卡住的那一环，别再调那颗从来就不是问题的 CPU。
