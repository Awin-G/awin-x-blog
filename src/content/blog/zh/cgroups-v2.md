---
title: "cgroups v2 实战：容器到底是怎么被限制的"
description: "在一台真实的 Docker 主机上动手拆解 cgroups v2：什么是 cgroup、v2 为什么要把控制器统一、v2 的文件系统布局与「内部不能有进程」规则、--memory 与 --cpus 如何映射到 memory.max 和 cpu.max、CPU throttling、内存记账、OOM kill、memory.high 与 memory.max 的区别，以及如何用 PSI 压力信号排查被杀或变慢的容器。"
pubDate: 2026-12-20
lang: zh
translationKey: cgroups-v2
tags: [linux, devops]
featured: false
keywords:
  - cgroups v2
  - 容器资源限制
  - memory.max
  - CPU throttling
  - OOMKilled
---

当某个容器在凌晨三点被干掉、`docker inspect` 里写着 `OOMKilled`，或者一个「CPU 明明很充裕」的服务仍然要花 40 秒才响应时，答案几乎都在 **cgroups v2** 里。cgroup 并不是容器的特性，它是内核的特性：把一组进程归到一起，然后对这个组计量并限制它能消耗的资源。Docker、systemd、Podman、Kubernetes 做的都只是往 cgroup 文件里写数字。一旦你能读懂这些文件，**容器资源限制**就不再是玄学。

下面全部是这台机器上真实容器的真实输出（Docker 29.9.0，内核 7.2.9，cgroup v2 统一层级，没有用 `--privileged`）。我在写这篇文章的过程中一边创建、一边销毁这些容器。

## 到底什么是 cgroup

一个 control group 是三样东西拼在一起的：

- 一个**进程的分组**，表现为伪文件系统里的一个目录；
- 一个**计量器**——`cpu.stat`、`memory.current`、`io.stat` 这类计数器；
- 一个**限制/控制器**——`cpu.max`、`memory.max`、`pids.max` 这类由内核在超出时强制执行的文​​件。

一切都是文件。没有系统调用要调，没有守护进程要问：你 `cat` 和 `echo` 就够了。这就是全部接口。

## v2 为什么存在：一个层级，而不是一堆

cgroup v1 是**每个控制器各自挂一个层级**：`/sys/fs/cgroup/memory/`、`/sys/fs/cgroup/cpu/`、`/sys/fs/cgroup/blkio/`，等等。一个进程可以在 memory 控制器下属于某个组，在 CPU 控制器下却属于完全另一个组，因为每个控制器都有自己独立的树。于是「这个进程的内存上限」和「这个进程的 CPU 上限」之间的关系根本无法表达——工具只能靠猜，内核也不断长出特例。

cgroup v2 用**单一统一层级**替换了这一切。你启用的每个控制器都作用于同一棵树、同一个位置。一个进程只存在于唯一一条路径上，它的内存、CPU、IO、pid 限制全都是同一个目录里的文件。

控制器怎么被打开，本身就说明了问题。每个 cgroup 都有 `cgroup.controllers`（父级给出的可用集合）和 `cgroup.subtree_control`（本级向下传给子级的集合）：

```console
$ cat /sys/fs/cgroup/cgroup.controllers
cpuset cpu io memory hugetlb pids rdma misc dmem
$ cat /sys/fs/cgroup/cgroup.subtree_control
cpuset cpu io memory hugetlb pids rdma misc dmem
```

在 systemd 主机上，systemd 会按需启用控制器。我自己的登录 scope 就精确报告了本地启用了哪些：

```console
$ cat /proc/self/cgroup
0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.kde.konsole-1523.scope/tab(1539).scope
$ cat /sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/cgroup.stat
nr_descendants 0
nr_subsys_cpu 1
nr_subsys_memory 1
nr_subsys_pids 1
```

## 真正要紧的几个控制器

四个控制器覆盖了几乎所有生产事故：

| 控制器 | 文件 | 作用 |
|---|---|---|
| `cpu` | `cpu.max`、`cpu.weight`、`cpu.stat` | 硬上限（配额）与相对份额；暴露 throttling 计数 |
| `memory` | `memory.max`、`memory.high`、`memory.current`、`memory.stat`、`memory.events` | 用量记账、回收、OOM |
| `io` | `io.max`、`io.weight`、`io.stat` | 按设备的带宽/IOPS 上限与份额 |
| `pids` | `pids.max`、`pids.current` | 防 fork 炸弹 |

还有更多（`cpuset`、`hugetlb`、`rdma`、`misc`，以及这个内核上的 `dmem`），但容器限制真正会编译成的，就是这四个。

## v2 的布局与「内部不能有进程」规则

整棵树就是一堆目录，每个目录里的文件名都一样。本机的一小部分：

```console
$ find /sys/fs/cgroup -maxdepth 2 -type d | head
/sys/fs/cgroup
/sys/fs/cgroup/system.slice
/sys/fs/cgroup/system.slice/docker.service
/sys/fs/cgroup/user.slice
/sys/fs/cgroup/user.slice/user-1000.slice
/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service
```

这里有一条最容易踩的规则：在 v2 里，**一个 cgroup 不能同时容纳进程和子 cgroup**。这就是 `cgroup.type = domain` 与 `domain threaded` 以及 `cgroup.procs` 检查的意义。如果你创建 `/sys/fs/cgroup/foo/bar`，那么内核允许子级存在的前提是 `foo` 里已经没有进程了。这正是 systemd 把服务挂成叶子节点的原因：一个还想拥有按 worker 分组的服务，必须先把进程挪到一个叫 `service/workers` 的叶子里。

```
                          /
                    (root, 委派后不放进程)
                          |
        +-----------------+------------------+
        |                                    |
   system.slice                          user.slice
        |                                    |
  docker.service                    user-1000.slice
        |                                    |
  docker-<id>.scope                 user@1000.service
  cpu.max  memory.max  pids.max          app.slice
  cpu.stat memory.current                    |
                                       容器 / scope 叶子
```

<figure>
  <svg viewBox="0 0 760 400" role="img" aria-label="cgroup v2 统一层级与一个 Docker 容器 slice" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto">
    <defs>
      <marker id="arr" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
        <path d="M0,0 L9,4.5 L0,9 Z" fill="currentColor" opacity="0.55"/>
      </marker>
    </defs>
    <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13" fill="currentColor">
      <rect x="300" y="16" width="160" height="40" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.7"/>
      <text x="380" y="41" text-anchor="middle">/ (unified)</text>

      <path d="M380,56 V84" stroke="currentColor" stroke-opacity="0.5" fill="none" marker-end="url(#arr)"/>

      <rect x="150" y="92" width="180" height="40" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.7"/>
      <text x="240" y="117" text-anchor="middle">system.slice</text>

      <rect x="430" y="92" width="180" height="40" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.7"/>
      <text x="520" y="117" text-anchor="middle">user.slice</text>

      <path d="M240,132 V160" stroke="currentColor" stroke-opacity="0.5" fill="none" marker-end="url(#arr)"/>
      <path d="M520,132 V160" stroke="currentColor" stroke-opacity="0.5" fill="none" marker-end="url(#arr)"/>

      <rect x="150" y="168" width="180" height="40" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.7"/>
      <text x="240" y="193" text-anchor="middle">docker.service</text>

      <rect x="430" y="168" width="180" height="40" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.7"/>
      <text x="520" y="193" text-anchor="middle">user@1000.service</text>

      <path d="M240,208 V236" stroke="currentColor" stroke-opacity="0.5" fill="none" marker-end="url(#arr)"/>

      <rect x="120" y="244" width="240" height="128" rx="10" fill="#0f766e" fill-opacity="0.08" stroke="#0f766e" stroke-width="1.6"/>
      <text x="240" y="268" text-anchor="middle" fill="#0f766e">docker-&lt;cid&gt;.scope</text>
      <text x="240" y="292" text-anchor="middle" font-size="11.5" fill="#0f766e">cpu.max      50000 100000</text>
      <text x="240" y="312" text-anchor="middle" font-size="11.5" fill="#0f766e">memory.max   134217728</text>
      <text x="240" y="332" text-anchor="middle" font-size="11.5" fill="#0f766e">pids.max     64</text>
      <text x="240" y="352" text-anchor="middle" font-size="11.5" fill="#0f766e">cgroup.procs 1</text>

      <path d="M430,208 V320 H362" stroke="currentColor" stroke-opacity="0.5" fill="none" marker-end="url(#arr)"/>
      <text x="470" y="252" font-size="11.5" opacity="0.8">subtree_control</text>
      <text x="470" y="270" font-size="11.5" opacity="0.8">为子级启用</text>
      <text x="470" y="288" font-size="11.5" opacity="0.8">cpu、memory、pids</text>
    </g>
  </svg>
  <figcaption>一棵层级树，每条进程路径唯一。容器就是一片叶子 scope，和其他任何组拥有同样的控制器文件。</figcaption>
</figure>

## Docker 如何把 `--memory` 和 `--cpus` 映射到 cgroup 文件

用你平时的方式起一个容器，然后看 Docker 到底写了什么。容器在宿主机上的 cgroup 是 `/sys/fs/cgroup/system.slice/docker-<id>.scope`：

```console
$ docker run -d --name cg-demo --memory=128m --cpus=0.5 --pids-limit=64 alpine sleep 600
$ docker inspect cg-demo | grep -E 'Memory|NanoCpus|PidsLimit'
            "Memory": 134217728,
            "NanoCpus": 500000000,
            "PidsLimit": 64,
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/cpu.max
50000 100000
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/memory.max
134217728
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/pids.max
64
```

所以 `--memory=128m` 就是 `memory.max=134217728` 字节（128 MiB，不是 128 MB）。`--cpus=0.5` 就是 `cpu.max = "50000 100000"`：每个 100000 微秒的周期里允许 50000 微秒的配额，也就是半个核。`--pids-limit=64` 就是 `pids.max=64`。`--cpus=2.5` 则变成 `250000 100000`。在容器内部，因为有了 cgroup namespace，同样的文件会以它自己的根目录形式出现：

```console
$ docker exec cg-demo cat /proc/self/cgroup
0::/
$ docker exec cg-demo cat /sys/fs/cgroup/memory.max
134217728
$ docker exec cg-demo cat /sys/fs/cgroup/memory.current
3215360
$ docker exec cg-demo cat /sys/fs/cgroup/cgroup.procs
1
```

## CPU shares、quota 与 weight

这是两套不同的机制，把它们搞混是经典错误。`cpu.max` 是**硬上限**：一个周期内，这个组就是拿不到更多 CPU。`cpu.weight`（v1 里叫 `cpu.shares`）是**相对份额**，只在父级被跑满时才起作用——它决定竞争时谁赢，而不是最高速度。

Docker 的 `--cpu-shares` 会映射进 `cpu.weight`，而且值并不是你输入的那些数字：

```console
$ # --cpu-shares=X  ->  cpu.weight
$ #  512  -> 59
$ # 1024  -> 100      (默认)
$ # 4096  -> 303
```

内核用 `weight = 1 + ((shares - 2) * 9999) / 262142` 换算每个原始 share，所以 1024 正好落在 100。如果你从不设置 shares，每个容器都拿到 weight 100，它们平分被争抢的 CPU——这正是为什么「邻居一忙我就慢」是 shares 问题，而「它永远超不过半个核」是 quota 问题。怎么区分两者在咬你，看最后一节。

## 内存记账、OOM，以及 `memory.high` 与 `memory.max`

内存才是容器真正死掉的地方。Docker 把 `--memory` 映射到 `memory.max`；内核把记在这个组账上的所有东西（匿名页、页缓存、内核结构）都算进 `memory.current` 和 `memory.stat`：

```console
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/memory.stat
anon 53248
file 1372160
kernel 380928
file_mapped 937984
slab 289376
```

存在两个上限文件，它们的区别就是全部要点：

- **`memory.high` 是软上限。** 越过它，内核会限流这个组、更卖力地回收，但不会杀任何东西。它是「让这个服务保持小巧」而不把一次尖峰变成崩溃的正确旋钮。
- **`memory.max` 是硬上限。** 当回收无法把这个组拉回 `memory.max` 以下时，OOM killer 就开火了。

一个用户委派的 scope 能把软/硬这一对同时显示出来（`systemd-run --user -p MemoryHigh=64M -p MemoryMax=128M`）：

```console
$ cat <scope>/memory.high     ->  67108864
$ cat <scope>/memory.max      ->  134217728
$ cat <scope>/memory.events   ->  high 177   max 0   oom 0   oom_kill 0
$ cat <scope>/memory.swap.current -> 120233984
```

一个分配量越过 64 MiB 的进程被限流，它的匿名页被压进了 swap（用掉 114 MiB swap），`memory.current` 就贴在 `memory.high` 附近徘徊——但 `max 0, oom_kill 0`：什么都没死。这就是**容器资源限制**作为压力阀而非断头台在起作用。

现在拿掉安全网。一个只有 `--memory=64m` 却无条件分配的容器：

```console
$ docker run -d --name cg-oom --memory=64m python:3.12-alpine \
    python3 -c "a=[]; [a.append(bytearray(4*1024*1024)) for _ in iter(int,1)]"
$ docker events --filter container=cg-oom --format '{{.Action}}' | sort -u
create
die
oom
start
$ docker wait cg-oom
137
$ docker inspect cg-oom --format 'OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}}'
OOMKilled=true ExitCode=137
```

退出码 137 是 128 + 9（SIGKILL），`OOMKilled=true` 是 Docker 给出的判决。内核这一侧的记录在 cgroup 的 `memory.events` 里，即使只有某个**子进程**被杀、容器本身还活着，它也照样留存：

```console
$ docker exec cg-mem cat /sys/fs/cgroup/memory.events
low 0
high 0
max 919
oom 1
oom_kill 1
oom_group_kill 0
$ docker exec cg-mem cat /sys/fs/cgroup/memory.peak
69525504
```

`max 919` 意味着这个组在走向死亡的路上几乎撞了一千次上限；`oom 1` / `oom_kill 1` 才是真正的那一刀。`memory.peak` 显示它顶点到了约 66 MiB。如果你想让整个 cgroup 一起被杀，而不是只挑一个倒霉的进程，那是 `memory.oom.group`——Docker 已经替你设好了。

## PSI：现代的压力信号

`cpu.stat` 和 `memory.current` 告诉你一个组**用了**什么，却不告诉你它是否被**饿着**。为此 v2 提供了 Pressure Stall Information：任务因等待资源而被阻塞的挂钟时间有多少。

```console
$ cat /proc/pressure/cpu
some avg10=35.80 avg60=29.25 avg300=14.95 total=641150672
$ cat /proc/pressure/memory
some avg10=1.47 avg60=1.77 avg300=0.96 total=57989785
```

`some` 表示「至少有一个任务被阻塞」；`full`（memory 和 io 才有）表示「所有任务都被阻塞」。同样的数字在每个 cgroup 里都有，这让你能指向单个容器而不是整台机器：

```console
$ docker exec cg-mem cat /sys/fs/cgroup/memory.pressure
some avg10=0.40 avg60=0.14 avg300=0.03 total=107658
full avg10=0.40 avg60=0.14 avg300=0.03 total=107658
$ docker exec cg-mem cat /sys/fs/cgroup/io.pressure
some avg10=0.72 avg60=0.13 avg300=0.02 total=93314
```

`memory.pressure` 的 `full` 持续上升，就是 `memory.max` 快要出问题的早期警报。`io.stat` 字节数不高而 `io.pressure` 飙升，则说明容器在磁盘后面排队，而不是在写盘。

## 排查被限流和被 OOM 杀掉的容器

**CPU throttling** 在 `top` 里看不见，在 `cpu.stat` 里一目了然。用 `--cpus=0.5` 跑一个忙循环，盯着计数器：

```console
$ docker run -d --name cg-cpu --cpus=0.5 alpine sh -c 'while :; do :; done'
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/cpu.max
50000 100000
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/cpu.stat
usage_usec 6110614
nr_periods 123
nr_throttled 120
throttled_usec 5814808
```

`nr_periods 123` 里有 `nr_throttled 120`——这个组 98% 的周期都被限流，12 秒寿命里有 5.8 秒花在等待上。注意 `usage_usec` 是 6.1 秒：它恰好用掉了被允许的半个核，所以这不是 CPU 太慢的问题，而是配额的问题。`docker stats` 也确认这个上限是真实存在的：

```console
$ docker stats --no-stream cg-cpu
NAME      CPU %     MEM USAGE / LIMIT   MEM %   PIDS
cg-cpu    49.54%    416KiB / 11.56GiB   0.00%   1
```

49.54% 就是那 50% 的配额，顶死了。诊断流程直接从这些文件里掉出来：

1. **退出码 137 / `OOMKilled=true`？** 读 `memory.events` → `oom_kill`。调高 `--memory`，或者把 `memory.high` 设在略低于 `memory.max` 的位置，让一次突发去做回收和 swap，而不是送死。
2. **CPU 空闲但很慢？** 读 `cpu.stat` → 如果 `nr_throttled` 紧跟 `nr_periods`，调高 `--cpus`（配额）。反之如果 `nr_throttled` 很低、延迟却差、`cpu.pressure` 很高，那就是争抢——调高 `--cpu-shares`（weight）。
3. **延迟忽高忽低、吞吐很低？** 读 `memory.pressure` 和 `io.pressure`。PSI 的 `full` 往上爬就是信号。
4. **fork 炸弹 / 「资源暂时不可用」？** 看 `pids.current` 对 `pids.max`。

整套工作就这一件事：把进程归到一组、给它计量、设一个上限、在上限咬人时读这些文件。如果你想看同一套容器模型在网络侧的样子，[Docker 网络](/zh/posts/docker-networking/)是配套的一篇；而既然你已经会读内核侧的文件，也值得顺手把沙箱的其余部分收紧：[容器安全](/zh/posts/container-security/)。

## 一段话总结

cgroups v2 是一棵统一的文件系统树。一个容器就是一片叶子 cgroup，它的文件——`cpu.max`、`cpu.weight`、`memory.max`、`memory.high`、`pids.max`、`io.max`——正是 `--cpus`、`--cpu-shares`、`--memory`、`--pids-limit`、`--blkio-weight` 写下的内容。quota 是硬上限，weight 是争抢时的份额；`memory.max` 会杀，`memory.high` 只限流；`cpu.stat` 和 `memory.events` 记录发生了什么，PSI 的 `/proc/pressure` 记录这有多疼。读懂这些文件，你就再也不用猜容器为什么死了。
