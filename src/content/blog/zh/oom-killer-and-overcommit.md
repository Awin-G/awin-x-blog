---
title: "Linux 内存过量提交与 OOM 杀手：你的进程为什么被杀"
description: "什么是内存过量提交、vm.overcommit_memory 的三种模式、Committed_AS 与 CommitLimit 的关系、OOM 杀手如何用 oom_score 挑选牺牲者、cgroup 限制与全局杀手谁先动手、swap 的作用，以及如何读懂案发现场——全部来自一次性容器的真实输出。"
pubDate: 2027-01-11
lang: zh
translationKey: oom-killer-and-overcommit
tags: [linux, devops]
featured: false
keywords:
  - OOM killer
  - 内存过量提交
  - vm.overcommit_memory
  - oom_score
  - Committed_AS
  - memory.max
  - OOMKilled
---

凌晨三点，告警只有一行：`OOMKilled=true`。CPU 正常，磁盘正常，服务却死了。原因几乎总是同样的两段 Linux 行为在按设计工作：**内存过量提交**（memory overcommit）——内核允许你分配超过实际存在的内存；以及 **OOM 杀手**——当进程真正触碰这些内存时登场的清场者。我在一台真实机器上把这两者拆开来讲——一台 Arch 主机，12 GB 内存、12 GB swap、共享的 Docker 守护进程——全部实验都在一次性容器里完成，下面每一行输出都是真实的，不是装饰。如果你的第一反应是去看机器是不是也过载了，[负载平均值](/zh/posts/linux-load-average/)那篇也值得一看；这里只谈 RAM。

## 什么是内存过量提交

进程调用 `malloc(1 GB)` 时，内核发给你的是*虚拟*地址空间，不占用任何物理 RAM；只有真正写入时，页面才变成真实的（这就是"按需分页"）。由于大多数程序分配的比实际触碰的多，Linux 允许所有虚拟分配的总和超过物理内存加 swap。这就是**内存过量提交**，由一个 sysctl 控制：`vm.overcommit_memory`：

- `0` — 启发式（默认）：只拒绝"明显"的过量提交，然后听天由命。
- `1` — 总是过量提交：永远不拒绝任何分配。
- `2` — 从不过量提交：每次分配都必须装进 **CommitLimit** 这个硬性预算里。

这台主机跑的是默认的模式 0，比例 50：

```console
$ cat /proc/sys/vm/overcommit_memory /proc/sys/vm/overcommit_ratio
0
50
```

模式 2 下 **Committed_AS** 和 **CommitLimit** 才是真正可执行的法律，所以先讲这两个。

## Committed_AS 与 CommitLimit：没人盯着的预算

`/proc/meminfo` 直接暴露过量提交的账本。`CommitLimit` 是模式 2 会强制执行的预算：swap 加上内存乘以比例。`Committed_AS` 是内核对当前所有"已分配但未必已触碰"的映射需要多少内存的估计：

```console
$ grep -E 'MemTotal|MemAvailable|SwapTotal|Committed_AS|CommitLimit' /proc/meminfo
MemTotal:       12117272 kB
MemAvailable:    4579520 kB
SwapTotal:      12582904 kB
CommitLimit:    18641540 kB
Committed_AS:   18315056 kB
```

验证一下算术：`CommitLimit = SwapTotal + MemTotal × ratio/100 = 12582904 + 12117272 × 0.5 = 18641540 kB`。Committed_AS 是它的 98.3%——而这台共享主机后来一路漂到 104%、125%。在模式 0 下这完全合法：不拒绝任何分配，没人恐慌。真正能预测麻烦的数字是 **MemAvailable**（这里 4.5 GB），它计入了可回收的页缓存。Committed_AS 是金丝雀，不是扳机——要看趋势，不要对单次读数告警。

<figure>
  <svg viewBox="0 0 800 300" role="img" aria-label="本机 Committed_AS 达到 CommitLimit 的 98.3%，以及内存耗尽时内核挑选 oom_score 最高的进程" xmlns="http://www.w3.org/2000/svg">
    <text x="20" y="26" font-family="ui-monospace, monospace" font-size="13" fill="currentColor">Committed_AS vs CommitLimit — /proc/meminfo, this host (mode 0, ratio 50)</text>
    <rect x="20" y="44" width="370" height="30" fill="none" stroke="currentColor"/>
    <text x="398" y="64" font-family="ui-monospace, monospace" font-size="13" fill="currentColor">CommitLimit 18641540 kB</text>
    <rect x="20" y="88" width="363" height="30" fill="#0f766e"/>
    <text x="398" y="108" font-family="ui-monospace, monospace" font-size="13" fill="currentColor">Committed_AS 18315056 kB = 98.3%</text>
    <text x="440" y="26" font-family="ui-monospace, monospace" font-size="13" fill="currentColor">the OOM pick — highest oom_score wins</text>
    <rect x="440" y="44" width="330" height="34" fill="#0f766e"/>
    <text x="450" y="66" font-family="ui-monospace, monospace" font-size="13" fill="currentColor">baloo_file rss 1.4 GB score 842</text>
    <rect x="440" y="88" width="200" height="34" fill="none" stroke="currentColor"/>
    <text x="450" y="110" font-family="ui-monospace, monospace" font-size="13" fill="currentColor">firefox rss 786 MB score 840</text>
    <rect x="440" y="132" width="150" height="34" fill="none" stroke="currentColor"/>
    <text x="450" y="154" font-family="ui-monospace, monospace" font-size="13" fill="currentColor">opencode rss 708 MB score 826</text>
    <text x="440" y="204" font-family="ui-monospace, monospace" font-size="13" fill="currentColor">biggest RSS → highest score → killed first</text>
  </svg>
  <figcaption>本机 CommitLimit 占用率常年 98.3%，模式 0 说这没问题。当某个 cgroup 耗尽时，内核给每个任务打分，先杀最大的：KDE 索引器 baloo_file 以 842 分居首。</figcaption>
</figure>

## cgroup 限制先于全局 OOM 杀手动手

在任何现代 Linux 上，真正会杀你进程的 OOM 杀手通常是 **cgroup** 那个，而不是全局那个。每个容器都有 `memory.max`；当 cgroup 的记账达到上限、回收又释放不出足够内存时，内核在*这个 cgroup 内部*杀进程——主机上其他进程毫发无损。证据：一个 512 MB 上限的容器，加一只每次吃 1 MiB 的 Python 内存 hog：

```console
$ docker run --name kill-lab --memory=512m --memory-swap=512m \
    -v /tmp/opencode/work/oom:/lab python:3-alpine python /lab/hog.py 900
allocated 448 MiB
allocated 480 MiB
EXIT_CODE=137
$ docker inspect -f 'Status={{.State.Status}} ExitCode={{.State.ExitCode}} OOMKilled={{.State.OOMKilled}}' kill-lab
Status=exited ExitCode=137 OOMKilled=true
```

退出码 137 是 128 + SIGKILL，`OOMKilled=true` 是每个编排系统都会盯的标志位。cgroup 自己的账本记录了发生了什么——`oom_kill 1`，且 `memory.peak` 恰好钉在 `memory.max`：

```console
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/memory.events
low 0
high 0
max 38
oom 1
oom_kill 1
oom_group_kill 0
sock_throttled 0
$ cat .../memory.max .../memory.peak .../memory.swap.max
536870912
536870912
0
```

`memory.peak`（历史最高水位）与 512 MiB 上限分毫不差；`swap.max` 为 0 是因为这次运行我禁用了 swap。`memory.max` 一族机制的完整拆解是我的 [cgroups v2 实战](/zh/posts/cgroups-v2/)；这里只强调一点：**cgroup OOM 先动手，在组内动手，全局杀手还没醒。** 两个独立见证者对上了时间。Docker 发出事件：

```console
$ docker events --filter event=oom --filter event=die
2026-10-13T06:15:30.048619721+08:00 container oom 9dcb8523fc48126a970af89a2b39ffbd136701b317bdb3022ae7f6bd4f071202 (image=python:3-alpine, name=kill-lab)
2026-10-13T06:15:30.251137436+08:00 container die 9dcb8523fc48126a970af89a2b39ffbd136701b317bdb3022ae7f6bd4f071202 (execDuration=0, exitCode=137, image=python:3-alpine, name=kill-lab)
```

内核日志用 `journalctl -k` 读，是完整的验尸报告——杀手从缺页路径进入、用量恰好顶到上限、以及被选中的受害者：

```console
$ journalctl -k --since "2026-10-13 06:15:29" --until "2026-10-13 06:15:31"
python invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=0
 memory: usage 524288kB, limit 524288kB, failcnt 23
 swap: usage 0kB, limit 0kB, failcnt 0
 oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=docker-9dcb8523….scope,mems_allowed=0,oom_memcg=/system.slice/docker-9dcb8523….scope,task_memcg=/system.slice/docker-9dcb8523….scope,task=python,pid=671666,uid=0
 Memory cgroup out of memory: Killed process 671666 (python) total-vm:531600kB, anon-rss:522724kB, file-rss:5348kB, shmem-rss:0kB, UID:0 pgtables:1084kB oom_score_adj:0
```

`constraint=CONSTRAINT_MEMCG` 是内核在作证：耗尽的是 cgroup 限制，不是整机。下面的调用栈（`do_anonymous_page ← … ← mem_cgroup_out_of_memory ← out_of_memory ← oom_killer`）是 hog 在自己写新页面时死掉——过量提交契约兑现的精确瞬间。

## 内核如何挑选受害者：oom_score 与 oom_score_adj

内核给每个任务打 0–1000 分，杀分最高的。主导输入是 RSS——你越大，死时释放的越多——再经 `oom_score_adj` 调整。任何进程的分数在 `/proc/<pid>/oom_score`，调整值在 `/proc/<pid>/oom_score_adj`。这台主机是 KDE 桌面，所以打分表是公开的：

| 进程 | RSS | oom_score | oom_score_adj |
|---|---|---|---|
| baloo_file（KDE 索引器） | 1405976 kB | **842** | 200 |
| firefox | 813976 kB | 841 | 200 |
| opencode | 686728 kB | 826 | 200 |
| 我的 zsh | 8088 kB | 800 | 200 |

排序与 RSS 排序完全一致——baloo_file 是这台机器第一个会牺牲的进程。容器里规则相同；64 MB 的盒子里两只 hog：

```console
host pid=828500 score=668 adj=0 rss=63140 kB  python /lab/hog.py 56
host pid=828501 score=666 adj=0 rss=9476 kB   python /lab/hog.py 4
```

`oom_score_adj`（范围 −1000…1000）是手动覆盖：−1000 让进程不可被杀，+1000 让它成为首选受害者。标准技巧是保护那个不能丢的进程（sshd、你的 agent 运行时、数据库）。这台机器上一个诚实的发现：在容器*内部*写 `oom_score_adj` 会被拒绝——`echo -1000 > /proc/$$/oom_score_adj` 即使以容器 root 执行也报 `Permission denied`；该文件由主机的 LSM 策略管辖。要把设置放在有权限的地方：`docker run --oom-score-adj=-1000`、systemd unit 的 `OOMScoreAdjust=-1000`，或以 root 在主机上设置。

## swap：你的进程活下来（或没活下来）的原因

第一次 kill-lab 运行其实*没能*杀掉进程。`--memory=512m` 加 Docker 默认 swap（除非另行指定，否则是内存上限的 2 倍），同一只 hog 吃了 **900 MiB 并正常退出 0**——内核把超额部分推进了 swap，没有杀任何东西。在 384 MB 上限、开启 swap 的情况下，我实时看到了交接：常驻内存钉在上限，swap 越堆越高：

```console
[376 MiB] rss_now=401915904 swap_now=0        peak=401915904 … max 0    oom_kill 0
[377 MiB] rss_now=402587648 swap_now=62386176 peak=402665472 … max 4    oom_kill 0
[500 MiB] rss_now=402632704 swap_now=136556544 peak=402681856 … max 570  oom_kill 0
[600 MiB] rss_now=402636800 swap_now=241250304 peak=402681856 … max 984  oom_kill 0
survived: finished allocating
```

`rss_now` 从不超过 402653184（384 MiB）；溢出部分走上坡路进入 `swap_now`，一路到 230 MiB，而 `max` 计数器——软限制节流计数——爬到 984，`oom_kill` 始终为 0。这就是全部交易：swap 把一次击杀变成缓慢。这也是为什么上面击杀运行时 `--memory-swap=512m`（与 `--memory` 相等）很关键：它拆掉了逃生口，同样的分配模式在 512 MiB 处死亡，而不是苟延残喘到 900。还有一个相关发现：Docker 的 `--memory-reservation` 映射到 cgroup 的 **memory.low**，不是 `memory.high`——软*节流*旋钮必须写到主机上的 cgroup 文件里，而 `memory.events` 中的 `max` 计数器就是它的指纹。

## 真实成因：内存泄漏、失控的缓存、太紧的上限

现实中真正产生 OOM 击杀的，是四类东西：

- **内存泄漏**。经典款。RSS 单调增长直到上限；`memory.peak` 像上面的击杀运行一样收敛到 `memory.max`。要修的是 bug，不是上限。
- **失控的缓存**。正当负载（构建缓存、内存队列）随输入增长而不设上限。症状相同，药方不同：在应用代码里给缓存设界。
- **容器上限设得太低**。最尴尬的成因：软件没问题，是你挑的数字错了。按繁忙实例的 `memory.peak` 加余量来定，而不是按空闲 RSS。
- **fork 炸弹**。基本已被解决的问题，我有收据：`:(){ :|:& };:` 在 `--memory=64m` 的容器里**578 ms 内退出码 0，全程没有 OOM 击杀**——cgroup v2 下，组满时 `fork()` 本身就失败，炸弹在一秒内饿死。加 `--pids-limit=64` 会更快自灭。别为 fork 炸弹失眠；为那个泄漏失眠。

想更早预警，这个内核在 `/proc/pressure/memory` 暴露压力停顿信息（本机 `some avg300=0.11`）——非零就意味着任务已经在回收上停顿，远早于任何进程死亡。

## 读懂案发现场：journalctl、memory.events、OOMKilled

进程死了，四件物证讲完整个故事。按这个顺序查：

1. `journalctl -k --since "<时间>" | grep -i oom`——内核的验尸报告：谁调用了杀手、cgroup 用量与上限、受害者的 `anon-rss`、`constraint=CONSTRAINT_MEMCG`。
2. `docker inspect -f '{{.State.OOMKilled}}' <容器>`——编排系统依据的标志位；配合 `ExitCode=137` 一起看。
3. cgroup 账本：`memory.events`（`oom_kill` 计真实击杀数）、`memory.peak`（对比 `memory.max` 的最高水位）、`memory.swap.current`（有多少被换出而不是被杀）。
4. 幸存进程的 `/proc/<pid>/oom_score` 与 `oom_score_adj`——内核当时查阅的那张表，机器还活着就能读。

## 在它发生之前阻止它

- 按繁忙实例的 `memory.peak` 加余量设置 `memory.max`；用 `--memory-reservation`（memory.low）让回收在硬墙*之前*开始。
- 对趋势告警，不对单点告警：`Committed_AS / CommitLimit` 持续爬过 ~80%、`memory.events` 的 `oom_kill` 在涨、`/proc/pressure/memory` 的 `some` 非零。
- 让正确的进程当受害者：给那个不能丢的进程 `--oom-score-adj=-1000`；内核的默认答案本来就是"最大的 RSS"。
- 给能 fork 的东西设上限：`--pids-limit` 零成本，把 fork 炸弹变成无关紧要的小事。
- 修掉泄漏。每一次 OOM 击杀都是内核在强制执行应用许下的诺言；上限只决定它*何时*收账。

契约很简单：Linux 信任了你的 `malloc`，你触碰了超出存在的内存，OOM 杀手开枪打死了组里最大的进程来还债。读懂账本，把上限设对，凌晨三点的告警就不再是谜。
