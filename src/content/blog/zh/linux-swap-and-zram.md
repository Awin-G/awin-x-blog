---
title: "Linux swap 与 zram：它们是什么，什么时候能救命"
description: "Linux swap 到底是什么（以及为什么它不是内存）、vm.swappiness 真正控制的是什么、如何用 vmstat 的 si/so、pswpin/pswpout 和 /proc/pressure 观察内存压力，以及什么时候 zram 比磁盘 swapfile 更好——全部真实输出，另加一次 Docker cgroup 限制下 400 MiB 分配实验。"
pubDate: 2027-02-01
lang: zh
translationKey: linux-swap-and-zram
tags: [linux, devops]
featured: false
keywords:
  - Linux swap
  - zram
  - vm.swappiness
  - 内存压力
  - swapfile
  - pswpin
---

两周前我写过[内存过量提交与 OOM 杀手](/zh/posts/oom-killer-and-overcommit/)，讲 Linux 如何让你
的 `malloc` 一直撒谎，直到你真的去碰那些页面。swap 是那个故事的另外一半，也是内存子系统里最
容易被误解的一个旋钮。人们把它叫做"额外的内存"，然后在一台 32 GB 内存加 32 GB swap 的机器死于
内存压力时大惊小怪。它不是额外的内存。它是一条溢流渠，而且管子非常细——在我现在这台机器上，
11.5 GiB 内存、SSD 上一块 8 GiB 的 `/swapfile`、外加一个 4 GiB 的 `zram0` 设备，这条渠此刻正
在真实地工作。

下面是要紧的版本：**Linux swap** 是什么、`vm.swappiness` 到底控制什么、如何在任何东西死掉之前
看到**内存压力**、以及为什么 **zram** 是我对小机器的默认答案。下面每个数字都来自这台机器。

## swap 是什么，以及它不是什么

swap 是内核可以把冷页面搬进去的磁盘后备空间。当匿名内存——进程的堆和栈——有一段时间没被碰过、
而内核又需要物理页框时，它就把这些页面写到某个 swap 区域，然后释放那块 RAM。进程本身毫无察觉
地继续运行；它的页表项现在指向一个 swap 槽位而不是一个物理页框。你再次碰到这个页面时，一次缺页
中断会把它读回来，代价是一次读操作。有两个后果构成了它的全部性格：

- **它不是容量。** 你不可能靠做一个 swapfile 就"增加 8 GB 内存"。你增加的是 8 GB 的*冷停车
  场*。如果工作集确实超过了 RAM，swap 是把一次硬崩溃变成一次缓慢爬行：它买的是时间，不是吞
  吐量。
- **它比 RAM 慢好几个数量级。** 一个命中缓存的页面花费纳秒级；一个要从 SATA SSD 读回来的页面
  是几百微秒，从机械硬盘回来则是毫秒级。

<figure>
<svg viewBox="0 0 720 252" width="100%" role="img" aria-label="Three overflow destinations for anonymous pages, in the order the kernel fills them: RAM itself, then a zram device that compresses pages into RAM at priority 100, then a swapfile on an SSD at priority minus one. When all three are full, the OOM killer fires.">
  <defs>
    <marker id="swp-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="10" y="14">anonymous pages leave RAM in this order</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="10" y="40" width="150" height="86" rx="8"/>
    <rect x="250" y="40" width="190" height="86" rx="8"/>
    <rect x="530" y="40" width="180" height="86" rx="8"/>
  </g>
  <g stroke="#0f766e" stroke-width="1.5" fill="none" opacity="0.9">
    <path d="M160 83 h80" marker-end="url(#swp-ar)"/>
    <path d="M440 83 h80" marker-end="url(#swp-ar)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="85" y="66" font-weight="600">RAM</text>
    <text x="85" y="88">11.5 GiB</text>
    <text x="85" y="108" font-size="11" opacity="0.7">nanoseconds</text>

    <text x="345" y="66" font-weight="600">zram0</text>
    <text x="345" y="88">4 GiB · zstd</text>
    <text x="345" y="108" font-size="11" opacity="0.7">priority 100 · 1.97:1</text>

    <text x="620" y="66" font-weight="600">/swapfile</text>
    <text x="620" y="88">8 GiB · SSD</text>
    <text x="620" y="108" font-size="11" opacity="0.7">priority −1</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.5">
    <rect x="10" y="176" width="700" height="46" rx="8"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="26" y="196">free RAM runs out first</text>
    <text x="26" y="214" font-size="11" opacity="0.7">cold pages park in zram, then on the file — the box gets slow, not dead</text>
  </g>
  <g fill="#0f766e" font-family="system-ui, sans-serif" font-size="12">
    <text x="694" y="205" text-anchor="end">the OOM killer waits behind all three</text>
  </g>
</svg>
<figcaption>先是 RAM，然后是压缩内存设备，最后才是磁盘文件——优先级决定顺序，而 swap 在 OOM 杀手介入之前先为你买到时间。</figcaption>
</figure>

"分区还是文件"已经没什么可争的了。真正重要的是*它背后是什么*：

```console
$ swapon --show
NAME       TYPE      SIZE USED PRIO
/swapfile  file        8G 4.8G   -1
/dev/zram0 partition   4G   4G  100

$ cat /proc/swaps
Filename				Type		Size		Used		Priority
/swapfile                               file		8388604		5050808		-1
/dev/zram0                              partition	4194300		4192988		100
```

只要 `swapon` 接受了，文件和分区的行为完全一样。有意思的是 **PRIO** 这一列：内核优先填充优先级高
的区域，所以这台机器会先把 `zram0`（优先级 100）填满，之后很久才碰那个 8 GiB 的文件（优先级
−1）。

## 内核发布 swap 流量的三个地方

`/proc/vmstat` 保存着累计计数器——自开机以来，单位是**页而不是字节**：

```console
$ grep -E '^(pswpin|pswpout|pgmajfault|oom_kill|pgsteal|pgscan)' /proc/vmstat
pgsteal_kswapd 94466120
pgsteal_direct 9298304
pgsteal_anon 11145892
pgsteal_file 92653892
pgscan_anon 17363079
pgscan_file 100806074
pswpin 284531
pswpout 1893087
pgmajfault 4119003
oom_kill 8
```

开机 2.3 天：换出 1,893,087 页（约 7.2 GiB），换入 284,531 页（约 1.1 GiB）。只有一小部分回
来了——那些被换出的页面是冷的，再也没被需要过。

接着是压力停顿信息（PSI），这才是我真正会设告警的地方：

```console
$ cat /proc/pressure/memory
some avg10=0.00 avg60=0.00 avg300=0.04 total=150168596
full avg10=0.00 avg60=0.00 avg300=0.04 total=130432321
```

`some` 是至少有一个任务因内存回收而停顿的时间百分比，`full` 是*所有*任务都停顿的时间百分比。
这里 `avg300=0.04` 意思是最近五分钟里有 0.04%——没什么可看的。非零并且在爬升，说明任务已经在
等待，这远早于 OOM 杀手动手，而且常常发生在 `free -m` 还显示大量"空闲"内存的时候。

`vmstat` 把这一切压缩成两个要紧的列，`si` 和 `so`——换入和换出，单位 KiB/s：

```console
$ vmstat 1 5
procs -----------memory---------- ---swap-- -----io---- --system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st gu
 2  0 9246904 370180 90300 3427532   5   38  1005  8221 5474 4239 17  2 80  1  0  0
 2  0 9246904 367352 90300 3429856   0     0  1896     0 5367 3136 22  1 77  0  0  0
 2  0 9246904 367296 90300 3429856   0     0     0     0 5382 3136 27  1 73  0  0  0
 1  2 9246904 236436 90300 3429856   0     0     0 256672 25281 50677 20  7 63  9  0  0
 1  0 9246896 359356 90308 3429856   0     0     0   132 6410 5480 14  1 70 14  0  0
```

`so` 出现一次 38 KiB/s 然后又归零，那是背景噪声。`si` 和 `so` 连续几分钟停在几百或几千，就是
"缓慢爬行"那种情形——而且如果同时伴随高 `wa`，故事讲的是 I/O 而不是计算。这是
[load average](/zh/posts/linux-load-average/)陷阱的另一种扮相：机器看起来很忙，其实每个任务都停
在 D 状态等一个页面。

## vm.swappiness：它到底控制什么

这里传播最广的谣言是：`vm.swappiness` 是"内核多积极地使用 swap"，或者"它保留多少空闲内存"。
两者都不是。它只调和一件事：**在压力下回收时，内核应该优先驱逐匿名页面（必须去 swap）还是文件
页面（页面缓存，可以直接丢弃再重新读入）？**

```console
$ cat /proc/sys/vm/swappiness
100

$ sysctl vm.swappiness
vm.swappiness = 100
```

取值范围是 0–100（新内核最高可到 200）。低值把回收推向丢弃页面缓存——对想保住缓冲缓存的数据
库是好事。高值把回收推向换出匿名页面、保住页面缓存，当 swap 的目标*本身就是 RAM*（zram 或
Zswap）时这是对的：你用压缩后的匿名内存去换未压缩的文件缓存，通常还赚了。

这台机器跑 100，是刻意的：它的 swap 是一个 4 GiB 的 zram 设备，所以"换出"是一次压缩操作，而不
是一次 I/O 操作。在一台背后是真实磁盘的大型数据库服务器上，`vm.swappiness=10` 说的是"先回收我
的页面缓存，再动任何匿名内存"。这个数字是一项策略，而策略取决于你的 swap 究竟是什么。

## 为什么大内存机器也需要 swap

1. **它为"OOM 杀手永远不开枪"买到时间。** Linux 会过量提交内存，所以内核发出去的比存在的多。
   账单到期时，swap 先把差额吸收掉：机器变慢，你被呼叫，你还有机会修。没有 swap，另一种结局就
   是 [OOM 杀手](/zh/posts/oom-killer-and-overcommit/)毫无预警地射杀你最大的进程。
2. **它吸收进程自己都忘了的冷数据。** Java 堆、notebook 内核、空闲容器。没人碰它们，但它们占
   着 RAM。

反驳一方的论点：一个真正耗尽了内存的机器上的 swap 是一台**测谎仪**，不是解药。这里 `free -m`
显示 3.4 GiB"可用"，同时 9 GiB 的 swap 正在使用中——这是"冷数据安全停放"的健康情形，完全不像一
台在抖动的机器。

## 实验：400 MiB 撞上 256 MiB 的墙

空谈 swap 不花成本，所以我量了。同一个分配器——400 MiB 匿名内存，每页都碰过——在三个一次性容
器里各跑一遍，每个都挂 cgroup v2 内存限制：

| 运行 | `--memory` | `--memory-swap` | 结果 |
|------|-----------|------------------|------|
| A | 256m | 256m（无 swap 余量） | **被 OOM 杀掉**，停在 192 MiB |
| B | 256m | 512m | 跑完，4.85 s |
| C | 4g | —（无需回收） | 跑完，0.29 s |

运行 A，没有可以溢流的地方：

```console
$ docker run --rm --memory=256m --memory-swap=256m \
    -v $PWD/alloc.py:/alloc.py:ro python:3.12-slim sh /lab.sh 400 64 2
  alloc   64 MiB resident  elapsed=   0.05s
  alloc  128 MiB resident  elapsed=   0.09s
  alloc  192 MiB resident  elapsed=   0.12s
Killed
--- cgroup v2 memory ledger, read from inside the container ---
memory.max               268435456
memory.peak              268435456
memory.swap.max          0
memory.swap.current      0
memory.events            low 0 high 0 max 58 oom 1 oom_kill 1 oom_group_kill 0 ...
```

`memory.peak` 正好等于 `memory.max`，`oom_kill 1`，`memory.swap.max 0`。容器撞上了墙，内核挑
了一个牺牲品。根本没有地方可以溢流。

运行 B，同一个分配器、同一个内存限制，但有 256 MiB 的 swap 余量：

```console
$ docker run --rm --memory=256m --memory-swap=512m \
    -v $PWD/alloc.py:/alloc.py:ro -v $PWD/lab.sh:/lab.sh:ro python:3.12-slim sh /lab.sh 400 64 3
  alloc   64 MiB resident  elapsed=   0.04s
  alloc  128 MiB resident  elapsed=   0.08s
  alloc  192 MiB resident  elapsed=   0.12s
  alloc  256 MiB resident  elapsed=   0.23s
  alloc  320 MiB resident  elapsed=   0.49s
  alloc  384 MiB resident  elapsed=   0.76s
  alloc  400 MiB resident  elapsed=   0.82s
alloc done: 400 MiB in 0.83s
  pass 1: re-touch 400 MiB in    2.06s  (wall    2.89s)
  pass 2: re-touch 400 MiB in    1.95s  (wall    4.84s)
swap counters delta (this host, /proc/vmstat): pswpin+0 pswpout+0 pgfault+229857 pgmajfault+26607
checksum=335 total=4.85s
--- cgroup v2 memory ledger, read from inside the container ---
memory.events            low 0 high 0 max 5823 oom 0 oom_kill 0 oom_group_kill 0 ...
memory.stat              ... pgsteal_direct 238420 pswpin 0 pswpout 0 pgfault 305343
                              pgmajfault 27249 ... zswpin 198149 zswpout 236312 zswpwb 0 ...
```

在运行 A 里被杀死的那同一个 400 MiB，在这里跑完了。代价写在日志里：重新触碰工作集每遍要
**2.06 s，而对照运行里是 0.02 s**，约 100 倍的降速，总运行时间从 0.29 s 变成 4.85 s——这就是"缓
慢爬行"：进程跑完了，但它驱逐过的每一个页面都得重新缺页读回。

一个必须说明的细节：容器自己的计数器显示 `pswpout 0` 而 `zswpout 236312`。它回收的页面从没到
达磁盘——这台机器开着 **Zswap**（`/sys/module/zswap/parameters/enabled` = `Y`），匿名页面先被压
缩进一个 RAM 池；`pgmajfault+26607` 配上 `pswpout+0` 正是"有主缺页但没有 swap 设备 I/O"的特
征。所以这 4.85 s 是*压缩*的代价，不是磁盘的代价；如果落点是机械硬盘会糟糕得多——这个数字这台
机器在没有 root 的情况下无法给我。

## zram：住在 RAM 里的 swap

**zram** 是一个压缩 RAM 块设备：你创建它，告诉它对外声明多少逻辑空间，选一个压缩算法，像对待
其他设备一样 `mkswap` 再 `swapon`。写进去的页面用 zstd 或 lz4 压缩后存在 RAM 里——拿 CPU 周期
换零磁盘 I/O 和零闪存磨损。

这台机器有一个，而且它确实在挣自己的饭钱：

```console
$ lsmod | grep zram
zram                   73728  1
842_decompress         20480  1 zram
842_compress           24576  1 zram
lz4hc_compress         20480  1 zram

$ cat /sys/block/zram0/comp_algorithm
lzo-rle lzo lz4 lz4hc [zstd] deflate 842

$ zramctl
NAME       ALGORITHM DISKSIZE DATA COMPR TOTAL STREAMS MOUNTPOINT
/dev/zram0 zstd            4G   3G  1.5G  1.5G         [SWAP]

$ cat /sys/block/zram0/mm_stat
3249025024 1633331173 1650630656        0 1658478592     8047    38669   262816   331180
```

`mm_stat` 这几个字段是 `orig_data`、`compr_data`、`mem_used`，单位字节：3.03 GiB 的页面安放在
1.54 GiB 的 RAM 里，**压缩比 1.97:1**。把那些东西原本占用的 RAM 省下一半，而且完全不碰磁盘，用
一个核的 zstd 来换很划算。

从零创建一个的命令——这些标注为*配方*而非输出，因为给 zram 设备设定容量的 sysfs 条目只有 root
可写：

```console
$ ls -l /sys/block/zram0/disksize /sys/block/zram0/reset
-rw-r--r-- 1 root root 4096 10月12日 04:12 /sys/block/zram0/disksize
--w------- 1 root root 4096 10月14日 11:25 /sys/block/zram0/reset

# modprobe zram num_devices=1
# echo zstd > /sys/block/zram0/comp_algorithm
# echo 4G   > /sys/block/zram0/disksize
# mkswap /dev/zram0
# swapon --priority 100 /dev/zram0
```

（上面中文的月份是这台机器的 locale，不是笔误。）

这个实验我以 uid 1000 的身份运行，所以没有创建第二个设备，也没有动正在运行的那个——上面的数字
来自观察它，而不是构建它。在 systemd 主机上，声明式的做法是 `zram-generator`
（`/etc/systemd/zram-generator.conf`，`zram-size = min(ram / 2, 4096)`）；Fedora 和树莓派系
OS 镜像默认就带这个，这正是它们在 2 GB 内存上依然顺手的原因。

## SSD 上的 swap：磨损、延迟，以及为什么现在 swapfile 挺好用

这里的 `/swapfile` 是加密 ext4 根分区上的 8 GiB，背后是一块 SATA SSD：

```console
$ findmnt -T /swapfile
TARGET SOURCE                FSTYPE OPTIONS
/      /dev/mapper/cryptroot ext4   rw,relatime

$ lsblk -o NAME,SIZE,TYPE,ROTA,MODEL
sdb           238.5G disk     0 Micron_1100_MTFDDAV256TBN
`-sdb2          238G part     0
  `-cryptroot   238G crypt     0
```

`ROTA 0` 表示没有旋转盘片，所以一次 swap 读入是一次 4 KiB 随机读——几十微秒，比所有人都记得的
机械硬盘快几千倍。磨损是真的，但可测量：以 2.3 天 1,893,087 页的 `pswpout` 计，这台机器每天往
swap 写约 **3 GiB**，意味着一个 8 GiB 的 swapfile 大约每 2.7 天被完整重写一遍——这只是任何现代
TLC 硬盘写入预算的一小部分，而且你还能像这里一样抬高 zram 优先级，让压缩设备吸收大部分流量，
把它压得更低。

关于"分区还是文件"：swapfile 需要一个能把它映射到块的文件系统，ext4 和 XFS 早就支持，Btrfs 要
到 5.0 时代才真正可用。在 ext4 上，用 `dd` 建文件以确保没有空洞，然后 `mkswap`、`swapon`，并持
久化：

```console
# dd if=/dev/zero of=/swapfile bs=1M count=4096 status=progress
# chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
# grep swapfile /etc/fstab
/swapfile none swap sw 0 0
```

这三行同样是配方；这台机器的 swapfile 早就存在，我不会只为图个好看就再加一个。

## 我的配方

- **一个容量为内存一半、上限 4 GiB、高优先级的 zram 设备。** zstd，
  `swapon --priority 100`。几乎所有 swap 流量都该落在这里。
- **一个不大的磁盘 swapfile 作为兜底**——可能休眠的桌面用 1–2 倍内存，服务器上就干脆 2–4 GiB，
  优先级 −1。它是紧急溢流渠，不是内存扩展。
- **`vm.swappiness` 按落点调，不按传言调。** 桌面或树莓派上 swap 是 zram → 100。数据库前面是磁
  盘 swap → 10。
- **盯压力，别盯空闲内存。** `pswpin`/`pswpout` 的增量、`vmstat` 的 `si`/`so`，以及
  `/proc/pressure/memory` 的 `some avg60`。PSI 数值几分钟内越过约 1% 就告警，`pswpin` 持续上
  升也告警。
- **永远不要拿 swap 当内存泄漏的解药。** swap 把运行 A 变成了运行 B：同一个进程、同一个限制，
  17 倍的墙上时间。那是缓刑，不是解决。真要找的是那个实际占着内存的东西——用
  [OOM 杀手那篇](/zh/posts/oom-killer-and-overcommit/)里同一套排查方法。

一句话版本：swap 是内核的承诺——一个你没用到的冷页面不必占用 RAM；zram 是把这个承诺兑现而且
完全不碰磁盘；`vm.swappiness` 则只是你在告诉内核，你认为哪些页面更冷。
