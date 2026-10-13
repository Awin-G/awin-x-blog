---
title: "io_uring 实战：为什么批量提交胜过每次 I/O 一次系统调用"
description: "io_uring 用用户态与内核共享的提交/完成环，取代每次 I/O 一次系统调用。基于 Linux 7.2 与 fio ioengine 的真实对比：队列深度带来什么、不改变什么，以及 SQPOLL 与注册缓冲区何时才值得用。"
pubDate: 2027-01-24
lang: zh
translationKey: io-uring-in-practice
tags: [linux, devops]
featured: false
keywords:
  - io_uring
  - 异步 I/O
  - fio ioengine
  - 队列深度
  - epoll
  - libaio
  - SQPOLL
---

每一次阻塞式 `read()` 都是一趟往返：线程陷入内核，内核找到数据（或者把你挂起直到数据就绪）、拷贝进你的缓冲区，然后把控制权还给你。当 I/O 很慢时，这趟往返等于免费——反正你都要等。可当存储很快时——页缓存、NVMe、tmpfs——系统调用本身就成了瓶颈。我在 profiling 一个日志采集器时正好撞上：设备利用率显示 60%，`iostat` 一脸轻松，而单线程读卡在 120 万 IOPS，这台机器显然还能更快。

**io_uring** 就是 Linux 给出的答案：别一次只向内核要一个 I/O。这篇文章讲实操：io_uring 到底是什么、与 `epoll` 和 `libaio` 的区别，以及在这台机器（内核 7.2.9、SATA SSD、8 核）上不同**队列深度**下 `fio ioengine` 的真实数字。我还用 liburing 写了一个小程序，把读操作以 32 个一批提交，与朴素的 `pread()` 循环对测。先剧透：同一个文件、同样的块，深度到位时 IOPS 提升 3.5 倍——也有一种情况下 io_uring 确实更慢。

## 问题：每次 I/O 一次系统调用，而 epoll 救不了

经典的同步模型很好理解，但吞吐很糟：

```c
for (i = 0; i < N; i++)
    n = pread(fd, buf, 4096, off);   /* 每个块一次系统调用、一次上下文切换、一次拷贝 */
```

1 亿个块就是 1 亿次系统调用，每次都伴随寄存器保存/恢复、SMAP/SMEP 开销和完整的返回路径。用线程可以把延迟藏起来，但代价是调度器唤醒和每个线程 8 MB 的栈。

`epoll` 常被当作解法，但它只解决"等待"：它告诉你某个fd**可读了**。你之后还是要调 `read()`——每次操作仍然一次系统调用加一次拷贝。它是就绪通知，不是 I/O 提交机制。对磁盘文件 I/O 它根本使不上劲。

`libaio`（AIO，`io_submit`）是更早的提交式尝试，从它的局限就能看出来：只支持普通文件上的 `O_DIRECT`，需要单独的 `io_setup` 系统调用和每线程一个 AIO 上下文，而且它"用户态轮询完成队列"的机制很吃 CPU（下面会看到——它是 QD=1 那场里唯一败北的引擎）。

## io_uring 是什么：两个环加一段共享队列

io_uring（5.1 合入，5.6 起可用）把 I/O 变成一个生产者/消费者问题，跑在内核与进程共享的内存上：

<figure>
<svg viewBox="0 0 660 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="io_uring 提交队列与完成队列环在用户态与内核之间共享的示意图">
  <!-- user space box -->
  <rect x="20" y="30" width="620" height="105" rx="8" fill="none" stroke="currentColor" stroke-width="1" opacity="0.35"/>
  <text x="32" y="24" fill="currentColor" font-size="11" font-family="monospace" opacity="0.7">用户态（你的进程）</text>

  <!-- SQ ring -->
  <circle cx="180" cy="82" r="52" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <circle cx="180" cy="82" r="26" fill="#0f766e" opacity="0.12"/>
  <text x="180" y="86" fill="currentColor" font-size="12" text-anchor="middle">SQ 环</text>
  <text x="180" y="148" fill="currentColor" font-size="10" text-anchor="middle" font-family="monospace">由你填写的 SQE</text>

  <!-- CQ ring -->
  <circle cx="480" cy="82" r="52" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <circle cx="480" cy="82" r="26" fill="#0f766e" opacity="0.12"/>
  <text x="480" y="86" fill="currentColor" font-size="12" text-anchor="middle">CQ 环</text>
  <text x="480" y="148" fill="currentColor" font-size="10" text-anchor="middle" font-family="monospace">由你收割的结果</text>

  <!-- fill arrow to SQ -->
  <line x1="180" y1="155" x2="180" y2="196" stroke="#0f766e" stroke-width="1.5" marker-end="url(#arrow)"/>
  <text x="192" y="180" fill="currentColor" font-size="10" font-family="monospace">一次填最多 32 个 SQE</text>

  <!-- kernel box -->
  <rect x="20" y="200" width="620" height="80" rx="8" fill="none" stroke="currentColor" stroke-width="1" opacity="0.35"/>
  <text x="32" y="194" fill="currentColor" font-size="11" font-family="monospace" opacity="0.7">内核</text>
  <text x="330" y="248" fill="currentColor" font-size="11" text-anchor="middle" font-family="monospace">io_uring_enter（一次最多提交 N 个）——完成后逐个写入 CQ 环</text>

  <!-- completion arrow back up -->
  <line x1="480" y1="196" x2="480" y2="155" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#arrow)"/>
  <text x="494" y="180" fill="currentColor" font-size="10" font-family="monospace">直接查看——零系统调用</text>

  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 z" fill="#0f766e"/>
    </marker>
  </defs>
</svg>
<figcaption>io_uring 的契约：你把提交队列项写进内核会读取的环，用一次 <code>io_uring_enter</code> 提交整批，内核在操作完成时把结果写进完成环，你完全可以不发出任何系统调用就看结果。</figcaption>
</figure>

提交队列（SQ）是一个环形缓冲区，你往里填 SQE 条目（"从偏移 X 读 4k 到缓冲区 B"）。完成队列（CQ）是内核往里写结果的另一个环。你可以用**一次** `io_uring_enter` 系统调用提交 32、64 甚至 1000 个操作，然后直接在用户态轮询 CQ 环——**检查完成根本不需要系统调用**，因为这个环本来就是共享内存。一次系统调用对应**一批**，而不是一个 I/O。

与几种替代方案的对比：

- **vs. `epoll`**：epoll 只告诉你何时该调 `read()`/`write()`，每次 I/O 仍然要一次系统调用加一次拷贝；io_uring 本身就是那次 I/O 调用。
- **vs. `libaio`**：io_uring 支持带缓冲的文件 I/O（不强制 `O_DIRECT`），不需要每线程的 AIO 上下文，支持注册文件与缓冲区，操作种类也更多（fsync、超时、socket、面向 NVMe 的 `uring_cmd`）。
- **vs. 线程**：io_uring 让"深度 1"没有"深度 1 的代价"：一个线程可以让成千上万个操作在途，而每个线程的唤醒都要付一次上下文切换。

## fio ioengine 的真实数字

先说环境。以下全部实测于本机：内核 7.2.9-arch1-1、8 核、Micron 1100 SATA SSD（LUKS on sdb2，ext4），外加 tmpfs 提供页缓存视角。fio 3.42，liburing 2.15。io_uring 在本机是启用的：

```sh
$ cat /proc/sys/kernel/io_uring_disabled
0
```

我用 fio 的三种引擎（`--ioengine=psync|libaio|io_uring`）跑完全相同的任务。以下为两次 8 秒运行的中位数。

**页缓存（tmpfs），`randread --bs=4k`**——设备就是内存，剩下的差异就是纯粹的提交路径开销：

| 引擎 / 形态 | IOPS | 平均延迟 | p99 延迟 | CPU |
|---|---|---|---|---|
| psync，QD=1 | 472,239 | 1.9 µs | 4.3 µs | 98.7% |
| libaio，QD=1 | 335,670 | 2.7 µs | 5.5 µs | 98.5% |
| io_uring，QD=1 | 99,275 | 9.6 µs | 18.8 µs | 58.2% |
| libaio，QD=32 ×4 任务 | 985,237 | 129.9 µs | 187.4 µs | 98.8% |
| io_uring，QD=32 ×4 任务 | 944,180 | 134.9 µs | 553.0 µs | 82.6% |

两个诚实的意外。QD=1 时，io_uring 单操作比阻塞 pread *更慢*（9.6 µs vs 1.9 µs）——环的间接开销每个批次要付一次，而深度 1 时"批次"就是一个操作。但它的 CPU 只用一半，因为它没有把线程阻塞在设备上。QD=32 时 IOPS 打平（都逼近 100 万，受内存带宽限制），但 io_uring **少用 16 个百分点的 CPU**——提交+收割的开销摊到了 32 个操作上。整篇的论点就浓缩在这一张表里：io_uring 不会让设备更快，它让你的核空闲下来。

**真实 SSD（ext4 on LUKS），`randread --bs=4k --direct=1`，2 GiB 文件：**

| 引擎 / 形态 | IOPS | 平均延迟 | CPU |
|---|---|---|---|
| psync，QD=1 | 5,859 | 169.7 µs | 8.4% |
| libaio，QD=1 | 5,679 | 175.0 µs | 9.1% |
| io_uring，QD=1 | 5,632 | 176.3 µs | 9.6% |
| libaio，QD=32 | 58,638 | 545.2 µs | 58.1% |
| io_uring，QD=32 | 59,817 | 534.1 µs | 56.9% |
| psync，32 进程 × QD=1 | 60,093 | 531.0 µs | 3.1% |

这里设备是瓶颈（每个操作 170 µs 的 SATA 延迟压倒一切），所以**所有引擎在任何深度都打平**——深度把 IOPS 放大 10 倍（5.6k → 59k），与提交 API 无关。CPU 列讲完了剩下的故事：32 个阻塞的 `psync` 进程需要 32 的聚合队列深度，它们靠当 32 个爱上下文切换的进程做到了；io_uring 只需要一个线程，且每次完成都没有阻塞唤醒。（反过来看，psync 的 3.1% CPU 有误导性——被阻塞的线程不烧 CPU，恰恰因为设备慢。）

以及 io_uring *不*赢的地方——大块顺序深读，任何引擎都一样：

```
seqread 1m QD=16 nj=1:  libaio 510 IOPS   io_uring 509 IOPS
```

一次大的顺序读是带宽问题，提交批量无关紧要。这与我之前那篇 [fio 深挖](/posts/disk-io-and-fio/)的结论一致：让工具匹配负载所在的轴。

## C 程序：一次 submit 提交 32 个 I/O

fio 的表格有说服力，但最干净的演示还是我自己的程序：用三种方式走读同一个文件的同一个 64 MiB 区域，4k 一块。以下是 io_uring 路径的核心循环：

```c
while (done < NBLOCKS) {
    int inflight = 0;
    while (inflight < BATCH && done + inflight < NBLOCKS) {   /* BATCH = 32 */
        struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
        if (!sqe) break;
        off_t off = (off_t)((done + inflight) * BS) % REGION;
        io_uring_prep_read(sqe, fd, bufs[inflight], BS, off);
        sqe->user_data = done + inflight;
        inflight++;
    }
    io_uring_submit(&ring);          /* 一次系统调用搞定 32 个操作 */
    submits++;

    int reaped = 0;
    while (reaped < inflight) {       /* 窥探 CQ 环，仅在为空时等待 */
        struct io_uring_cqe *cqe;
        io_uring_wait_cqe(&ring, &cqe);
        sink[cqe->user_data & (BS - 1)] ^= bufs[cqe->user_data % BATCH][0];
        reaped++;
        io_uring_cqe_seen(&ring, cqe);
    }
    done += inflight;
}
```

编译：`gcc -O2 -o bench bench.c -luring`。真实输出（5 次运行取中位数，SSD 上 2 GiB 文件，`O_DIRECT`）：

```text
file=/var/tmp/fio-uring-bench/testfile mode=O_DIRECT kernel=7.2.9-arch1-1 io_uring_disabled=0  liburing=2.15
  pread      wall= 0.797s  IOPS=    20549  cpu= 0.16s (20.1%)  ios/submit=1.0
  uring      wall= 0.227s  IOPS=    72061  cpu= 0.05s (22.4%)  ios/submit=32.0
  uring-sqp  wall= 0.222s  IOPS=    73822  cpu= 0.23s (104.9%)  ios/submit=32.0
  uring-reg  wall= 0.227s  IOPS=    72304  cpu= 0.05s (23.7%)  ios/submit=32.0
```

同样的文件、同样的块，墙上时间差 3.5 倍：**20,549 → 72,061 IOPS**，每 32 个操作一次 `io_uring_submit`，而不是每个操作一次 `pread`。页缓存版本（同样代码，不用 `O_DIRECT`）单独展示了提交路径：pread 853,937 IOPS vs 批量 io_uring **1,364,467 IOPS**——同样的数据，多 60%。

注意什么没用：SQPOLL（`IORING_SETUP_SQPOLL`，让内核线程 busy-poll SQ 环，从而完全跳过提交系统调用）在这里只换来约 2% 的 IOPS，却赔上一整个核（CPU 104.9%——轮询线程在空转）。在页缓存那次里它反而*更差*：1,157,842 vs 1,364,467 IOPS，因为这个速度下唤醒路径打败自旋。SQPOLL 在特定场景下光彩，不是默认选项。

## SQPOLL 与注册缓冲区，简单说

- **SQPOLL** 用内核线程忙轮询 SQ 环来省掉提交系统调用，本质是用一个专用 CPU 换一次系统调用。我的实测结论是：要测，别默认开；它在 fio 里是 `--sqthread_poll=1`，是选项，不是免费午餐。
- **注册缓冲区**（`IORING_REGISTER_BUFFERS`，fio 的 `--fixedbufs=1`）一次性钉住缓冲区，内核不必每个操作重新映射。在这个量级下实测持平（72,304 vs 72,061 IOPS）——这是诚实的：它的收益要在缓冲区数量巨大、在途操作极多、或 NVMe 级延迟让每次映射不再免费时才显现。而做这个实验时我撞上了一个真实的移植性坑，正好引出下面的注意事项。

有一个坑是我实测出来的，不是想当然的：liburing 的 `io_uring_prep_read_fixed()` 会把 SQE 的 `addr` 字段清零（内核本该只用 `buf_index`）。本内核上每个 fixed 读都返回 `-EFAULT`；补上一个非 NULL 的 `addr`——正是 fio 引擎的做法——立刻就好了。事情不大，但教训是普世的：**在你的内核上**测 io_uring 特性，因为它们依赖内核版本，有时甚至依赖补丁级别。

## 诚实的注意事项

1. **内核版本决定一切。** `io_uring` 5.1 才有、5.6 才好用，此后不断增加操作；有些环境干脆禁用它（看 `cat /proc/sys/kernel/io_uring_disabled`——`0` 全开、`1` 非特权禁、`2` 全禁）。BSD 没有它。请写好回退路径。
2. **攻击面。** io_uring 出过可被利用的漏洞，加固环境会故意关掉它（某些容器运行时和沙箱 profile 会限制这些系统调用）。如果你要部署进别人的加固镜像，先验证再依赖。
3. **它不是魔法。** 当设备是瓶颈时（我这块 SATA SSD 在 QD=32），引擎打平；当负载是一条又深又顺序的流时，引擎打平。io_uring 的回报在深度：小 I/O 多、存储快、每个 I/O 的 CPU 很要命的场景。
4. **带缓冲 I/O 也有坑。** io_uring 的带缓冲读在某些情况下仍可能在内核里阻塞（老内核需要 `IOSQE_ASYNC` 才能跳出请求内阻塞）——新内核能内联处理更多，但还是查一下你的版本。

## 我需要它吗？

如果你的服务在做深度超过 4 的小随机 I/O——向量库、缓存层、数据库——而你现在用线程池逼近它，那就去测真实深度下的每个 I/O 的 CPU 和单操作延迟。如果你被一块慢盘的单一指标卡住，或者在做顺序流，大概率不需要。动手重写之前先 benchmark：这台机器上 SSD 的 QD=32 下 libaio 和 io_uring 打平，同样的实验换 NVMe 或 tmpfs 存储可能倒向任何一边。检查工具就在手边——`fio --ioengine=`——运行时状态是 `cat /proc/sys/kernel/io_uring_disabled`。

在所有噪声之外站得住的还是最初那个模式：批量摊薄固定成本。每 32 次读一次提交，把同一个文件上的 0.797 秒变成了 0.227 秒。无论你用 io_uring 还是别的方案到达这个效果，杠杆都是它。

---

*相关阅读：[让数字说话的磁盘 I/O 基准测试：fio、IOPS 与 fsync](/zh/posts/disk-io-and-fio/) · [读懂 Linux 负载平均值，以及它为什么会骗你](/zh/posts/linux-load-average/)*
