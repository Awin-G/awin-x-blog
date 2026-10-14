---
title: "cgroup v2 io.max：限制单个容器的磁盘吞吐量"
description: "在一台 Docker 29 主机上实测：cgroup v2 的 io 控制器如何按容器限制磁盘吞吐量，--device-write-bps 到底写了什么，io.max 与 io.weight 的区别，以及为什么用 dd 测出来的数字是假的。"
pubDate: 2027-02-02
lang: zh
translationKey: cgroups-v2-io-limits
tags: [linux, devops]
featured: false
keywords:
  - cgroup v2 io.max
  - 容器 I/O 限制
  - device-write-bps
  - io.weight
  - PSI
---

在这台机器上，一个 4 KiB 随机读探针的耗时是 **292 µs**。然后我在同一块盘上用 `fio` 起了一个没有任何限制的普通容器、写一个 4 GB 文件，同样的探针掉到了 **4 IOPS、平均延迟 242 ms**——整整 830 倍的退化，起因只是邻居的一次写操作。这就是**容器 I/O 限制**存在的全部理由，而在 cgroup v2 里，这个开关叫 `io.max`。

下面所有内容都跑在这台博客背后的真实主机上：Docker 29.9.0，内核 **7.2.9-arch1-1**，cgroup v2 统一层级，systemd cgroup 驱动，没有 `--privileged`，没有 root。根文件系统是 ext4，位于 `/dev/mapper/cryptroot`——device-mapper 的 `dm-0`，主次设备号 **253:0**，架在 `/dev/sdb2`（8:18）也就是 `/dev/sdb`（8:16）之上。

## 为什么 I/O 限制跟 CPU、内存限制完全不是一回事

`--cpus=2` 和 `--memory=512m` 都很温和：一个队列，在使用点上生效。I/O 有三个不同之处，每一样都能咬人：

1. **限制是按设备的。** `io.max` 用主次设备号指定一个块设备。写 `/` 的容器被限制在 `253:0` 上，而不是 `sda`——那是同一台主机上的另一块物理盘。
2. **强制发生在块层。** 内核在 I/O 提交到设备时做节流，用户态完全看不见这个 cap，被限的进程只是看起来慢。
3. **缓冲写会把它藏起来。** `write()` 落进 page cache，从写者的角度看就已经"完成"了。这个 cap 最终仍然作用于回写（cgroup v2 会把缓冲回写记账到弄脏页面的那个 cgroup），但写进程早就离场了。

策略层面的区别也很重要：CPU 上限大多只是浪费空闲容量，而 I/O 上限是一个共享设备问题。所以想说"最多这么多"用 `io.max`（硬上限），想说"争用时按比例分"用 `io.weight`（相对份额）。

## 从 blkio 到 io：v2 的控制器

cgroup v1 的 `blkio` 有双重人格——`blkio.throttle.*` 管硬上限，`blkio.weight_device` 管比例份额，两者都是按设备的。cgroup v2 把它们统一成 **`io`**，只有两个文件：

| 文件 | 含义 | 示例 |
|---|---|---|
| `io.max` | **硬上限**，按设备：`rbps`、`wbps`、`riops`、`wiops` | `253:0 wbps=20971520` |
| `io.weight` | 争用时的**相对份额**，1–10000 | `default 100` |

Docker 的 `--device-read-bps`、`--device-write-bps`、`--device-read-iops`、`--device-write-iops`、`--blkio-weight` 都只是在写这几个文件。在 systemd 驱动的主机上，容器的 cgroup 是一个 scope，整个 io 面就在一个目录里：

```console
$ ls /sys/fs/cgroup/system.slice/docker-4a38af82255e5ee6e0e0207e9a22a166c61c130e25bb549e2d879cee9a064b77.scope | grep '^io'
io.bfq.weight
io.latency
io.max
io.pressure
io.prio.class
io.stat
io.weight
```

`io.stat` 是计数器，`io.pressure` 是停顿信号。不设上限时，`io.max` 是**空的**——默认容器就是无限额：

```console
$ docker run --rm cgio:latest sh -c 'echo "[$(cat /sys/fs/cgroup/io.max)]"'
[]
```

## `--device-write-bps` 到底写了什么

`docker run --device-write-bps /dev/dm-0:20mb` 会把路径解析成主次设备号，然后往 scope 里写一行：

```console
$ cat /sys/fs/cgroup/system.slice/docker-4a38af82255e5ee6e0e0207e9a22a166c61c130e25bb549e2d879cee9a064b77.scope/io.max
253:0 rbps=20971520 wbps=20971520 riops=max wiops=max
```

`20mb` 是 Docker 的二进制记法：20 MiB/s，所以是 `20971520`；`max` 表示该字段不限。`docker inspect` 能看到它落在哪：

```console
$ docker inspect capped --format '{{json .HostConfig.BlkioDeviceWriteBps}} {{json .HostConfig.BlkioDeviceReadBps}}'
[{"Path":"/dev/dm-0","Rate":20971520}] [{"Path":"/dev/dm-0","Rate":20971520}]
```

还有一个 cgroup 命名空间的细节，它决定了你能看到什么：容器里 `/proc/self/cgroup` 写的是 `0::/`，而 `/sys/fs/cgroup` 是容器**自己那个** scope，而且是只读挂载。

```console
$ docker exec capped sh -c 'cat /proc/self/cgroup; cat /sys/fs/cgroup/io.max'
0::/
253:0 rbps=20971520 wbps=20971520 riops=max wiops=max
$ docker exec capped sh -c 'echo "253:0 wbps=1048576" > /sys/fs/cgroup/io.max'
sh: 1: cannot create /sys/fs/cgroup/io.max: Read-only file system
```

只读是对的——限制属于编排者，不属于容器。

## 实测：142 MiB/s 对 18 MiB/s

负载是 1 MiB 顺序写：`fio --direct=1 --ioengine=libaio --iodepth=8`，12 秒，写到一个绑定挂载到 `/` 的目录。先是不设限：

```console
Run status group 0 (all jobs):
  WRITE: bw=142MiB/s (149MB/s), 142MiB/s-142MiB/s (149MB/s-149MB/s), io=1717MiB (1800MB), run=12051-12051msec
```

同样的命令，加上 `--device-write-bps /dev/dm-0:20mb`：

```console
Run status group 0 (all jobs):
  WRITE: bw=18.1MiB/s (19.0MB/s), 18.1MiB/s-18.1MiB/s (19.0MB/s-19.0MB/s), io=224MiB (235MB), run=12375-12375msec
```

142 → 18.1 MiB/s。为了公平，我把两个容器**同时**跑起来，让它们面对同一时刻的设备争用（这台主机上还有别的容器在跑，所以绝对上限会漂移，有参考价值的是比例）：无限额的 **89.5 MiB/s**，限流的 **18.8 MiB/s**，十秒里分别写了 909 MiB 和 192 MiB。

`io.stat` 是看着计数器走的地方。在一次 10 秒的限流运行里三次采样：

```console
$ cat .../io.stat            # 开始前
8:16 rbytes=385024 wbytes=0 rios=8 wios=0 dbytes=0 dios=0
253:0 rbytes=385024 wbytes=0 rios=8 wios=0 dbytes=0 dios=0
$ cat .../io.stat            # 第 5 秒
8:16 rbytes=1425408 wbytes=96468992 rios=28 wios=736 dbytes=0 dios=0
253:0 rbytes=1425408 wbytes=96468992 rios=28 wios=736 dbytes=0 dios=0
$ cat .../io.stat            # 第 10 秒
8:16 rbytes=1425408 wbytes=209715200 rios=28 wios=1600 dbytes=0 dios=0
253:0 rbytes=1425408 wbytes=209715200 rios=28 wios=1600 dbytes=0 dios=0
```

整整十秒，`209715200` 字节。每 20 MiB 一秒，一个字节都不差。（同一份 I/O 在 `8:16` 和 `253:0` 下都出现——分别是 dm 层和物理盘——所以要查你的限制所在的那个设备。）

字节不是唯一的轴，另外两个字段是 IOPS。一个 4 KiB 随机写流，把写 IOPS 压到 200：

```console
$ docker run --rm --device-write-iops /dev/dm-0:200 ... fio --rw=randwrite --bs=4k ...
253:0 rbps=max wbps=max riops=max wiops=200
   iops        : min=   40, max=   264, avg=146.13, stdev=  73.97, samples=15
  WRITE: bw=516KiB/s (528kB/s), 516KiB/s-516KiB/s (528kB/s), io=4384KiB (4489kB), run=8502-8502msec
```

同样负载不限额：33,559 IOPS，131 MiB/s。**146 对 33,559 IOPS——差了 230 倍——而字节率只从 131 MiB/s 变成 516 KiB/s。** 对这种负载，带宽上限根本没用，因为它几乎没在搬字节。

## 设备必须在 I/O 路径上

<figure>
<svg viewBox="0 0 720 340" role="img" aria-label="两个容器共享一个块设备；吵闹的那个被 io.max 限制，探针保住了自己的延迟" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto">
  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13" fill="currentColor">
    <rect x="60" y="24" width="250" height="64" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.75"/>
    <text x="185" y="48" text-anchor="middle">容器 A（吵闹的）</text>
    <text x="185" y="70" text-anchor="middle" font-size="11" opacity="0.75">io.max 253:0 wbps=20MiB/s</text>

    <rect x="410" y="24" width="250" height="64" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.75"/>
    <text x="535" y="48" text-anchor="middle">容器 B（探针）</text>
    <text x="535" y="70" text-anchor="middle" font-size="11" opacity="0.75">不限额 — 3168 IOPS</text>

    <path d="M185,88 V150" stroke="currentColor" stroke-opacity="0.45"/>
    <path d="M535,88 V150" stroke="currentColor" stroke-opacity="0.45"/>
    <path d="M185,150 H535" stroke="currentColor" stroke-opacity="0.45"/>
    <path d="M360,150 V196" stroke="currentColor" stroke-opacity="0.45"/>

    <rect x="300" y="196" width="120" height="34" rx="17" fill="#0f766e" fill-opacity="0.14" stroke="#0f766e" stroke-width="1.5"/>
    <text x="360" y="218" text-anchor="middle" fill="#0f766e" font-size="12">阀门 20MiB/s</text>
    <text x="432" y="218" font-size="11" opacity="0.7">（只在 A 的路径上）</text>

    <path d="M360,230 V262" stroke="currentColor" stroke-opacity="0.45"/>
    <rect x="180" y="262" width="360" height="50" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.75"/>
    <text x="360" y="284" text-anchor="middle">同一个块设备</text>
    <text x="360" y="301" text-anchor="middle" font-size="11" opacity="0.75">253:0 dm-0 (cryptroot) → 8:16 sdb</text>
  </g>
</svg>
<figcaption>同一个设备，一个被限、一个自由。因为 `io.max` 是按设备的，它只对它所命名的路径生效：不限额时邻居 4 IOPS，上了限额 3168 IOPS。</figcaption>
</figure>

正因为限制是按设备的，写错设备是最经典的翻车方式：参数被接受，文件也写进去了，但什么都没被限流。这台主机上有第二块盘 `/dev/sda`（298 GB），根文件系统从不碰它。试试一边让容器写 `/`、一边把写限制加到它身上：

```console
$ docker run --rm --device-write-bps /dev/sda:20mb -v /var/tmp/cgiotest/data:/data cgio:latest sh -c 'cat /sys/fs/cgroup/io.max; fio ...'
8:0 rbps=max wbps=20971520 riops=max wiops=max
  WRITE: bw=105MiB/s (110MB/s), 105MiB/s-105MiB/s (110MB/s-110MB/s), io=841MiB (882MB), run=8005-8005msec
```

限制明明白白写在文件里，105 MiB/s 照样从它头上过去，因为 `8:0` 不在这次写的路径上。写一个不存在的设备会当场报错，这正好提示了正确的找法：

```console
$ docker run --rm --device-write-bps /dev/sdz1:20mb cgio:latest true
docker: Error response from daemon: stat /dev/sdz1: no such file or directory
```

用 `df /` → `lsblk` 找，然后顺着栈追到真正在 I/O 路径上的那个主次设备号。有 LUKS 或 LVM 时，限制 dm 设备或者它上/下面的物理盘都行——两处都在路径上——不在路径上的盘就不行。

## page cache 陷阱：别用 `dd` 测限额

同一个 cap，用 `dd` 测两遍。带 `conv=fsync` 时，cap 一目了然：

```console
$ docker exec capped dd if=/dev/zero of=/data/dd2 bs=1M count=200 conv=fsync
209715200 bytes (210 MB, 200 MiB) copied, 11.1285 s, 18.8 MB/s
$ docker exec plain   dd if=/dev/zero of=/data/dd1 bs=1M count=200 conv=fsync
209715200 bytes (210 MB, 200 MiB) copied, 2.39799 s, 87.5 MB/s
```

去掉 `fsync`，`dd` 就开始撒谎：三秒结束，还报告 **170 MB/s**。字节进了 page cache，cap 只是挪到了回写阶段——你可以在 `dd` 退出后看着容器的 `io.stat` 以被限的速率赶上：

```console
$ docker exec capped dd if=/dev/zero of=/data/dd3 bs=1M count=500
524288000 bytes (524 MB, 500 MiB) copied, 3.08741 s, 170 MB/s
$ grep wbytes .../io.stat     # dd 返回的那一瞬间
253:0 rbytes=1536000 wbytes=662708224 rios=45 wios=5058 dbytes=0 dios=0
# 6 秒后
253:0 rbytes=1536000 wbytes=788537344 rios=45 wios=6018 dbytes=0 dios=0
# 又 6 秒后
253:0 rbytes=1536000 wbytes=914366464 rios=45 wios=6978 dbytes=0 dios=0
```

每个区间增加 125,829,120 字节——六秒 120 MiB，约 21 MB/s。盘真的被限住了，只是那个**进程**体感不到。这就是为什么一个"被限住"的容器可以看起来很健康好几小时，然后把一个等着数据落盘的数据库卡死；也是为什么用缓冲 I/O 测限额毫无意义。请用 `fio --direct=1`（`dd` 就用 `oflag=direct`）。

cap 也不会降低延迟——对拥有它的那个容器来说，它只是把带宽换成了等待。被限的写者自己的延迟从微秒级涨到了秒级：50 分位 802 ms，99 分位 3.57 s，而它实际只写了 15.8 MiB/s。

## `io.weight` 是另一件工具，而在本文里它什么都没做

`io.max` 说"最多这么多"；`io.weight` 说"争用时按这个比例分"（1–10000，默认 100）。权重只在有东西竞争时才有意义——盘空着的时候它毫无作用。于是我同时起两个不限额的容器，一个 `--blkio-weight 100`，一个 `--blkio-weight 900`，让它们抢同一块盘：

```console
$ docker logs wA | grep 'WRITE: bw='   # --blkio-weight 100
  WRITE: bw=91.7MiB/s (96.1MB/s), ..., io=1384MiB (1451MB), run=15095-15095msec
$ docker logs wB | grep 'WRITE: bw='   # --blkio-weight 900
  WRITE: bw=94.4MiB/s (98.9MB/s), ..., io=1427MiB (1496MB), run=15122-15122msec
```

9 倍的权重差，换来 3% 的吞吐差——噪声级别。容器里的文件也说明它什么都没设：

```console
$ docker run --rm --blkio-weight 400 cgio:latest cat /sys/fs/cgroup/io.weight
default 100
```

而按设备的形式比没用更糟——在这台主机上它直接**让容器起不来**：

```console
$ docker run --rm --blkio-weight-device /dev/dm-0:400 cgio:latest true
docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: error setting cgroup config for procHooks process: setting device weight "253:0 400": write /sys/fs/cgroup/system.slice/docker-3d43cf244a0e6e17b794a01555faef79de4fe2c796ebbc31492693a91c260b4d.scope/io.bfq.weight: operation not supported
```

原因在调度器。这台主机上 `cat /sys/block/sdb/queue/scheduler` 报的是 `none [mq-deadline] kyber bfq`：**`io.weight` 只有 `bfq`（以及 `io.cost` 模型）实现，`mq-deadline` 和 `kyber` 都没有。** runc 把按设备的权重写进 `io.bfq.weight`，内核返回 `EOPNOTSUPP`，容器启动前就死了；全局的 `--blkio-weight` 则是被静默丢弃。这一轮我没能切调度器（需要主机 root），所以请把这当作我证据的诚实边界：在默认主机上，可靠好用的是 `io.max`。

## 看争用：PSI

`io.stat` 只能告诉你一个容器做了多少 I/O，说不清有没有东西在*等*。这就是 PSI，它有四个文件——`cpu`、`memory`、`io`、`irq`：

```console
$ cat /proc/pressure/io
some avg10=29.45 avg60=23.31 avg300=21.19 total=3946711619
full avg10=27.24 avg60=21.73 avg300=19.44 total=3380691331
```

`some` = 系统里*至少有一个*任务因 I/O 停顿的时间百分比（这里是在那个不限额的 hog 正写盘时采的）；`full` = 所有任务都卡在 I/O 上、完全跑不动的时间百分比。两个都是 10/60/300 秒的衰减平均，外加一个单调递增的 `total`（微秒）。`full` 27% 就是一台被磁盘拖死的机器。

先说一个注意事项：PSI 是全系统口径，而且有底噪——这台繁忙的主机上，我还没动手之前 `/proc/pressure/io` 的 `some` 就常年在 15–20%。按 cgroup 读的那份才是外科手术刀，因为每个 cgroup 都有自己的 `io.pressure`：

```console
$ cat .../io.pressure            # 空闲容器
some avg10=0.00 avg60=0.00 avg300=0.00 total=0
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
$ cat .../io.pressure            # 跑完一次 10 秒限额运行
some avg10=0.00 avg60=0.00 avg300=0.00 total=6450
$ cat .../io.pressure            # 跑完一次 10 秒无限额运行
some avg10=0.09 avg60=0.02 avg300=0.00 total=25679
```

毫秒级的停顿，精确归因到一个容器。这才是该拿去做告警的东西。

## 回报：cap 把邻居的延迟还了回来

开头那个探针，跑三遍，每次 8 秒的 4 KiB 随机读、队列深度 1，同时另一个容器在写同一块盘：

| 场景 | IOPS | 平均延迟 |
|---|---|---|
| 只跑探针 | 3,414 | 291.56 µs |
| 邻居在写，不限额 | **4** | **242.31 ms** |
| 邻居在写，限额 20 MiB/s | 3,168 | 314.19 µs |

cap 让探针回到它单独跑时 3,414 IOPS 中的 3,168——吞吐恢复到 93%，延迟只高 23 µs——而吵闹的容器仍然写了 15.8 MiB/s。这不是抽象的公平：这是一个 4 IOPS 的数据库变回 3,168 IOPS 的数据库。

## 实操建议

- **限额要加在吵闹的邻居身上，而不是所有人身上。** 用 `io.stat`（谁拿走了设备上大部分 `wbytes`）和邻居的 `io.pressure` 找出它；给安静的容器加限额什么也换不到。
- **写对设备。** `df /` → `lsblk`，然后顺着栈追到路径上真正的主次设备号；不在路径上的盘会被静默忽略。
- **用 `fio --direct=1` 测，别只靠 `dd`。** 缓冲写能在磁盘被限到 20 的时候给你报出 170 MB/s。
- **选对轴：** 流式负载用 `wbps`，小 I/O 负载用 `wiops`，两者互相独立。
- **小心 page cache 遮丑：** 看 `io.pressure`，以及主机侧的 `grep -E 'Dirty|Writeback' /proc/meminfo`。
- **用 PSI 决定什么时候该限：** 某个 cgroup 的 `io.pressure` `full` 持续增长时就该告警。
- **别指望 `io.weight` 救场。** 在 `mq-deadline` 主机上它要么被忽略、要么直接致命；`bfq`/`io.cost` 是针对整块设备的另一个独立决定。

机制背景——什么是 cgroup、`--memory` 和 `--cpus` 怎么映射到文件——见[cgroups v2 实战](/zh/posts/cgroups-v2/)。要测的是负载本身而不是限额，看[磁盘 I/O 基准测试](/zh/posts/disk-io-and-fio/)。

*相关阅读：[cgroups v2 实战：容器到底是怎么被限制的](/zh/posts/cgroups-v2/) · [Disk I/O benchmarks that mean something](/zh/posts/disk-io-and-fio/) · [Disk I/O latency troubleshooting](/zh/posts/io-latency/)*
