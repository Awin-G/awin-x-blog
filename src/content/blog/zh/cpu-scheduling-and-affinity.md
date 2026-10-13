---
title: "CPU 调度实战：nice/renice、CPU 亲和性与 taskset，以及为什么某个核心被打满"
description: "一次在真实 8 核机器上的 Linux CPU 调度实战：CFS 如何按权重切分一个核心，为何 nice/renice 只在高负载下才起作用，CPU 亲和性与 taskset 何时有用何时帮倒忙，SCHED_FIFO 的危险，docker --cpus 如何经 cpu.max 限流，以及如何用 mpstat -P ALL 与 pidstat 定位被打满的核心。"
pubDate: 2027-01-14
lang: zh
translationKey: cpu-scheduling-and-affinity
tags: [linux, devops]
featured: false
keywords:
  - CPU 调度
  - nice renice
  - CPU 亲和性
  - taskset
  - 运行队列
  - cgroup cpu.weight
  - SCHED_FIFO
---

当一个本该空闲的服务把某个核心跑到 100%，而 `top` 仍显示机器很从容；或者一个你 `renice` 过的任务死活不肯让路——你看到的正是 Linux **CPU 调度**真正分配 CPU 的方式，而它并不像 man page 里的形容词承诺的那样。下面每个数字都来自我这台真实机器的输出（内核 7.2.9、cgroup v2 统一层级、Docker 29.9.0、单 NUMA 节点）。全程无 root，只用 `nice`/`renice`、`taskset`、`chrt`、`vmstat`、`/proc` 和 `docker --cpus`。先记住这句话：**nice 只是一种权重，只有在线争抢时才起作用**，**亲和性决定任务“能跑在哪个核心”，用错就是坑**，而 **`--cpus` 是一道硬配额，会心甘情愿地把一个 4 线程任务摁死在一个核心上**。把这三者搞混，你就会得到那个被人点名找上门的“单核打满”。

## 一页讲清 CFS：权重、vruntime 与 cpu.weight

Linux 用 **完全公平调度器（CFS）** 调度普通线程。不是固定时间片，而是对“争抢”的一个公平*份额*，权重来自每进程的 `weight`（由 nice 推导）或每组的 `cpu.weight`。每个可运行任务累积虚拟运行时间（`vruntime`）；调度器运行 **vruntime 最小**的任务，而 vruntime 以 `wall_time * (1024 / weight)` 递增——所以权重越大的任务消耗 vruntime 越慢，每个单位的 vruntime 换到越多 CPU。有两条事实贯穿全文：CFS 只瓜分**被争抢**的核心（有空闲核心时无从可分），而调权重的旋钮是每进程的 `nice` 和每组的 `cpu.weight`——同一个概念在容器尺度上的样子，我在 [cgroups v2](/zh/posts/cgroups-v2/) 一文里有深入展开。

<figure>
  <svg viewBox="0 0 760 300" role="img" aria-label="CFS 按权重切分一个被争抢的核心，而 taskset 亲和性决定任务能跑在哪些核心上" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto">
    <defs>
      <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
        <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" opacity="0.55"/>
      </marker>
    </defs>
    <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12.5" fill="currentColor">
      <text x="28" y="24" font-size="13.5">CFS：一个被争抢的核心按权重切分</text>
      <text x="404" y="24" font-size="13.5">亲和性（taskset）：可运行在哪些核心</text>
      <line x1="388" y1="12" x2="388" y2="272" stroke="currentColor" stroke-opacity="0.22"/>

      <text x="28" y="50" font-size="11.5" opacity="0.85">核心 0，一个固定时间窗（实验 B）：</text>
      <rect x="28" y="58" width="277" height="26" rx="6" fill="#0f766e" fill-opacity="0.55"/>
      <rect x="305" y="58" width="59" height="26" rx="6" fill="#0f766e" fill-opacity="0.2" stroke="#0f766e"/>
      <text x="38" y="75" fill="currentColor">任务 A · nice 5 · 权重 291 · ~82%</text>
      <path d="M186,104 L330,70" stroke="currentColor" stroke-opacity="0.4" marker-end="url(#arr)"/>
      <text x="28" y="108" font-size="11.5" opacity="0.85">任务 B · nice 19 · 权重 15 · ~14%</text>
      <text x="28" y="140" font-size="11" opacity="0.72">按权重分配，故负载下 B 被饿死——但不会归零。</text>

      <text x="404" y="50" font-size="11.5" opacity="0.85">四个单线程忙循环：</text>
      <rect x="404" y="60" width="34" height="26" rx="5" fill="#0f766e" fill-opacity="0.5"/><text x="418" y="77" text-anchor="middle" font-size="11">T</text>
      <rect x="444" y="60" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
      <rect x="484" y="60" width="34" height="26" rx="5" fill="#0f766e" fill-opacity="0.5"/><text x="498" y="77" text-anchor="middle" font-size="11">T</text>
      <rect x="524" y="60" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
      <rect x="564" y="60" width="34" height="26" rx="5" fill="#0f766e" fill-opacity="0.5"/><text x="578" y="77" text-anchor="middle" font-size="11">T</text>
      <rect x="604" y="60" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
      <rect x="644" y="60" width="34" height="26" rx="5" fill="#0f766e" fill-opacity="0.5"/><text x="658" y="77" text-anchor="middle" font-size="11">T</text>
      <rect x="684" y="60" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
      <text x="404" y="98" font-size="11" opacity="0.7">0<tspan dx="2">…</tspan><tspan dx="2">7</tspan></text>
      <text x="404" y="118" font-size="11.5" opacity="0.85">不绑定 → 调度器分散到多核 → 每个约 1.9s</text>

      <text x="404" y="146" font-size="11.5" opacity="0.85">taskset -c 0 → 四个都挤上核心 0：</text>
      <rect x="404" y="152" width="34" height="26" rx="5" fill="#0f766e" fill-opacity="0.85"/><text x="421" y="169" text-anchor="middle" font-size="11" fill="currentColor">4×</text>
      <rect x="444" y="152" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
      <rect x="484" y="152" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
      <rect x="524" y="152" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
      <rect x="564" y="152" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
      <rect x="604" y="152" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
      <rect x="644" y="152" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
      <rect x="684" y="152" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
      <text x="404" y="200" font-size="11.5" opacity="0.85">1 个核心跑 4 份活 → 每个约 6.2s（被串行化）</text>
      <text x="404" y="230" font-size="11" opacity="0.72">亲和性决定任务“能跑在哪”，而非权重，也非上限。</text>
    </g>
  </svg>
  <figcaption>左：两个可运行任务在同一个被争抢的核心上按 CFS 权重分割（nice 5 对 nice 19）——一大片与一小条，来自实验 B。右：同样四个忙循环，不绑定（分散到多核，快）与用 <code>taskset -c 0</code> 绑定（全挤在一个核心，串行化）——实验 C。<code>currentColor</code> 让图形跟随明暗主题，<code>#0f766e</code> 是强调色。</figcaption>
</figure>

## nice 与 renice：一个让人失望的相对权重

`nice` 设置进程权重，`renice` 在运行时改它。每上调一级 nice，权重乘以 1.25，所以 **nice 0 = 权重 1024、nice +19 = 权重 15**——约 68× 的差距。很多人据此以为 +19 几乎会让任务停摆。两个实验说明并非如此。

**1. 有空闲核心时，nice 是空操作。** 核心空闲时 CFS 无从可分，权重被完全忽略：

```console
$ ./burn time 3 victim2 & vp=$! ; renice +19 -p $vp ; wait      # 空闲核心上的单个任务
   old priority 5, new priority 19
TIME  victim2  window= 3.00s  cpu_used= 2.987s   # 照样拿到一整个核心
```

一个 nice +19 的孤任务在 3s 墙上时间里烧掉了 **2.987s 的 CPU**——整整一个核心。Renice 什么都没改变，因为没有别的任务来抢。

**2. 高负载下它确实咬人，但很粗。** 这台机器默认把我启动的每个进程都放在 **nice 5**（一个友好的包装层），所以诚实的对比是 nice 5 对一个被我主动 `renice` 下去的任务。十六个忙循环喂满八个核心；一个“受害者”跑固定的 3s 时间窗，报告它实际拿到的 CPU 秒数：

```console
$ for i in $(seq 1 16); do ./burn time 8 load & done     # 16 个任务 > 8 个核心
$ ./burn time 3 victim-default                            # 受害者，默认 nice 5
TIME  victim-default  window= 3.00s  cpu_used= 2.473s
$ ./burn time 3 victim2 & vp=$! ; renice +19 -p $vp       # 同一受害者，renice 到 +19
   old priority 5, new priority 19
TIME  victim-reniced  window= 3.09s  cpu_used= 0.412s
```

Renice 到 +19 把受害者从 **2.47s 砍到 0.41s** 的 CPU——约 6×，效果是真实的。但它既*不是*权重表暗含的约 68×，也*不是*零：CFS 仍会给低权重任务一小片，而它极小的 vruntime 让它在核心一空出的瞬间就重新够格。所以 `nice` 适合把批处理任务*轻推*到交互任务之后，而不适合当作 CPU 上限。抬高优先级需要 `CAP_SYS_NICE`——`nice -n -5` 会以 `Permission denied` 失败——因此我们普通人只能把任务往下压。

## CPU 亲和性：taskset 与 sched_setaffinity，何时有用何时有害

亲和性是一个任务**可以**运行的核心位掩码；`taskset` 是 `sched_setaffinity(2)` 系统调用的命令行前端。与 nice 不同，它不改变任务拿到*多少* CPU，只改变*哪些核心*参与。这让它比 nice 更危险，因为用错会实打实地拖垮吞吐。同样的负载，绑定与不绑定，两种形态：

```console
$ for i in 1 2 3 4; do ./burn work 600000000 C1 & done; wait            # 不绑定
WORK  C1-unpinned-2  wall= 1.811s  cpu= 1.802s  ncpu=8 cpus={0,1,2,3,4,5,6,7,}
$ for i in 1 2 3 4; do taskset -c 0 ./burn work 600000000 C2 & done; wait   # 全部绑到核心 0
WORK  C2-core0-4     wall= 6.157s  cpu= 1.533s  ncpu=1 cpus={0,}
```

不绑定时它们并发跑在四个核心上，各自 **约 1.8s** 完成；绑到单核心后它们共享一个 CPU，各自 **约 6.2s**——慢 3.4×，而每进程 `cpu` 几乎没动（约 1.5s）。**把并行任务绑到一个核心，就是把它串行化。** 再看单个任务：

```console
$ ./burn work 600000000 D1                 # 不绑定
WORK  D1-unpinned  wall= 1.511s  cpu= 1.505s  ncpu=8 cpus={0,1,2,3,4,5,6,7,}
$ taskset -c 2 ./burn work 600000000 D2
WORK  D2-core2     wall= 1.504s  cpu= 1.502s  ncpu=1 cpus={2,}
```

几乎没有差别——该退役的迷思：**把单线程任务绑到某个核心并不会加速。** Linux 本就倾向于让一个孤任务待在暖和的核心上，你只是剥夺了调度器的自由，却没改变它的选择。亲和性在结构性的场景里*确实*有用：**隔离**——把延迟敏感的进程钉在专属核心（cpuset/`taskset`）上，远离嘈杂的批处理；**局部性**——让热的多线程工作线程留在同一个核心/簇内，使 L1/L2 与内存保持本地；把中断与 RT 线程从你在意的核心上挪开。当它**过度约束**时*就*有害——把并行工作绑到太少核心会扼杀负载均衡。默认选择：让 CFS 去均衡，只带着测量过的理由去绑定。

## 实时策略：SCHED_FIFO / SCHED_RR 及其危险

`SCHED_FIFO` 与 `SCHED_RR` 跑在所有 CFS 工作之前，优先级 1–99，越高立即抢占越低。它不是更快的 CFS，而是另一种制度；一旦失控，就是一把对准整台机器的手枪。设置它需要我没有的特权，所以诚实的演示就是这道权限边界，以及唯一限制伤害的那个旋钮：

```console
$ chrt -f 10 ./burn work 200000000           # 把普通任务提到 SCHED_FIFO 优先级 10
chrt: failed to set pid 0's policy: Operation not permitted     # 需要 CAP_SYS_NICE
$ chrt -p 1
pid 1's current scheduling policy: SCHED_OTHER
pid 1's current scheduling priority: 0
$ cat /proc/sys/kernel/sched_rt_runtime_us /proc/sys/kernel/sched_rt_period_us
1000000
1000000
```

那句 `EPERM` 是第一道防线——不会意外获得 RT 优先级。第二道是 RT 节流：一个 `sched_rt_period_us` 窗口内的 `sched_rt_runtime_us`。它默认的 `950000/1000000` 能让普通任务无论如何都保住 5% 的 CPU。**这台机器是 `1000000/1000000`——RT 节流实际上被关掉了**，所以一个高优先级的 `SCHED_FIFO` 忙循环在这里完全可能把机器卡死。实时策略是给音频截止期（JACK）、`DPDK`，以及 `migration/0`、`ksoftirqd` 这类内核线程用的——绝不要给你“只是想跑快点”的应用逻辑用。

## --cpus 如何限流：cgroup 的 cpu.weight 与 cpu.max

容器通过 cgroup v2 限制 CPU，而这两个文件的行为截然不同。**`cpu.max`** 是 `quota period`，一道**硬上限**：`100000 100000` 意为“每 100ms 周期 1.0 个 CPU”，`docker run --cpus=N` 写的就是它，一旦超额就**强制把整个组踢出运行**直到下个周期。**`cpu.weight`** 是**相对**的（默认 100）——nice 的组级孪生，只在父级核心被*争抢*时才起作用，空闲核心上毫无效果。我在容器里跑了四个*want*四个 CPU 的忙进程，然后从宿主机在 4s 窗口内读取该容器的 `cpu.stat`：

```console
# docker run -d --cpus=4 ... ; CG=/sys/fs/cgroup/system.slice/docker-<id>.scope
$ cat $CG/cpu.max ; sample cpu.stat for 4s
400000 100000
  effective CPUs: 3.99   nr_throttled +6  / +40 periods   # 拿到想要的 4，几乎不被节流
$ # 同一负载，--cpus=1
100000 100000
  effective CPUs: 1.01   nr_throttled +40 / +40 periods   # 被钉在 1 CPU，每个周期都被节流
$ # 同一负载，--cpus=0.5
50000 100000
  effective CPUs: 0.50   nr_throttled +41 / +41 periods   # 半个 CPU，每个周期都被节流
```

结论很干脆：负载从没变，只有 `cpu.max` 在变。在 `--cpus=1` 下真实吞吐被钉死在 **1.01 CPU**，且 **40/40** 个周期都被节流——每 100ms 强制停顿一次。一个“内存充足”的四线程服务却总是半天才回，通常正是这个：卡在配额上，而非 CPU 慢。`nr_throttled` 很低但延迟很差，说明是争抢而非配额——那是 `cpu.weight` 的地盘。Docker 参数到这些文件的映射见 [cgroups v2](/zh/posts/cgroups-v2/) 一文。

## NUMA，简要说一句

NUMA 是亲和性之所以重要的原因：在多路主机上，访问本地内存快、跨节点慢，所以要任务与数据在同一节点（`numactl --cpunodebind/--membind`，再加亲和性）。在*这台*机器上它无关紧要——`lscpu` 只报一个节点（`NUMA node0 CPU: 0-7`）——这正是上面的数字都在讲核心而非节点的原因。一旦剖析里出现跨节点访问，那就是亲和性与内存放置一起调的那一层。

## 诊断被打满的核心：mpstat -P ALL、运行队列与 pidstat

“某个核心被打满”之所以看不见，是因为聚合值把它藏了。一个绑到核心 3 的忙循环，外加一个后台租户：8 核**平均值显示 71% 空闲，而核心 3 却是 0% 空闲**：

```text
     CPU   %usr %nice  %sys %iowait  %irq %soft %steal %idle
     cpu   15.5  12.4   0.4   0.0   0.2   0.2   0.0  71.2
    cpu1   99.0   0.0   0.0   0.0   1.0   0.0   0.0   0.0
    cpu3    0.0  99.0   0.0   0.0   1.0   0.0   0.0   0.0
```

两点一跃而出。其一，**该用的是 `mpstat -P ALL`，不是 `top`**：每核的 `%idle` 才能暴露被 `cpu` 平均值吃掉的热核（核心 3 是 0%，总体是 71%）。其二，核心 3 落在 **`%nice`** 列，而租户的核心 1 落在 **`%usr`** 列——同样是“100% 忙”，却在不同列，纯粹因为我的宿主进程在 nice 5、容器的在 nice 0；在 nice 0 的机器上，这个忙循环会显示为约 `100% %usr`。（这里没装 sysstat，所以这是一个读 `/proc/stat`、按 mpstat 的列打印的小工具；`mpstat -P ALL 1` 会直接给出同样的表。）

然后是**运行队列**——`vmstat` 的 `r` 列——用来区分*单核打满*与*整机过载*。一个绑定任务让 `r` 保持很低；超额订阅则把它推过核心数：

```text
$ vmstat 1 2             # 一个忙循环绑在核心 3 → 运行队列维持约 1
 r  b ... in     cs  us sy id
 2  0 ... 5976  4728  34  1 65
$ # 8 核上 12 个 CPU 密集任务：
13  0 ... 10933 4676  99  1  0     # r=13 > 8 核 → 已饱和
```

`r` 停在 1–2 却有核心处于 0% 空闲，说明是*单个繁忙核心*——单线程或绑错核的任务。`r` 爬过 `nproc` 才是真饱和、真该加核。接着 `pidstat` 点名元凶，并确认它确实占着那个核心：

```console
$ ./pidstat.py 973244 1 2
     Time      PID    %CPU  Command
 07:55:55   973244  100.0  burn
```

这与[读懂 Linux 负载平均值](/zh/posts/linux-load-average/)正好衔接：8 核机器上，负载 3.9、`r ≈ 13`、某核 0% 空闲，就是“负载高、均值舒服、单核哀嚎”的经典场面。配方：`mpstat -P ALL 1` 找*哪个*核心；`taskset -pc <pid>` 看它是否*被绑定*；`chrt -p <pid>` 查实时策略；若在容器里再看它的 `cpu.max`/`cpu.stat`。

## 我实际会先做的几件事

1. **要相对共享？** 用 `renice +n` 把批处理任务压到交互任务之后——负载下是个轻推，核心空闲时毫无作用。
2. **要硬上限？** `cpu.max` / `--cpus=N`——绝对，且它*就是会*节流；盯 `cpu.stat` 的 `nr_throttled`。
3. **要隔离或局部性？** 用 `taskset`/cpuset 绑定，但只针对你*测过*不绑定会变慢的并行任务（实验 C）——别给孤任务期待加速。
4. **想伸手拿 `SCHED_FIFO`？** 只在音频或数据面线程、且机器归你所有时——并先看一眼 `sched_rt_runtime_us`。

留一段收尾：CFS 按权重瓜分*被争抢*的核心（每进程 `nice`、每组 `cpu.weight`）——所以 nice 是轻推不是上限，空闲核心会让它失效；亲和性遮罩任务“能跑在哪”，利于延迟隔离与内存局部性，却在串行化并行任务时毁掉一切；`SCHED_FIFO`/`RR` 插队且能把机器卡死（此处尤甚，节流已关）；`--cpus` 是一道硬的 `cpu.max` 配额；而 NUMA 是离开单路之后的亲和性故事。定位被打满的核心：`mpstat -P ALL`（均值会说谎）、`vmstat` 运行队列（打满 vs 饱和），再用 `pidstat` 点名进程。
