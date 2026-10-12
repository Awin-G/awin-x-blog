---
title: "btrfs vs ZFS 选哪个：一个 homelab 的真实选择与理由"
description: "一份务实的 btrfs vs ZFS 对比，写给 homelab。讲清两者的共同点（校验和、filesystem snapshots、send receive、类 RAID 冗余），差异在哪（btrfs 在内核里、按文件更灵活；ZFS 集成的卷管理与成熟的 RAIDZ），内存与 ARC、许可证和恢复工具链上的取舍，并用一张决策表和分场景的推荐收尾。"
pubDate: 2026-11-12
lang: zh
translationKey: btrfs-vs-zfs
tags: [homelab, self-hosting, linux]
featured: false
keywords:
  - btrfs vs ZFS
  - filesystem snapshots
  - homelab storage
  - RAIDZ
  - ARC
  - send receive
---

平均每月都有人问我一次 **btrfs vs ZFS**，通常是刚给 homelab 买了两块盘、想找个理由
停止再读下去的人。这就是我给出的版本：两者都能给你 **filesystem snapshots**、校验和
与 **send receive** 复制，都能把一堆盘变成「坏一块还活着」的东西。对大多数 homelab
来说，随便选哪个都行，真正的分水岭是内存、你有几块盘，以及你有多怕它某天崩掉。下面
是我自己在跑什么、以及我会怎么选。

先说清楚：我偏爱无聊的方案。**homelab storage** 不是一个耍聪明的地方，它是一个让你
在凌晨两点、没有网络的情况下还能恢复过来的地方。

## btrfs 和 ZFS 到底有什么共同点

这点值得先讲公平，因为差异抢走了所有注意力。两者都是写时复制（copy-on-write）的
文件系统，特性都很现代：

- **数据与元数据都有校验和。** 静默损坏会被发现，而不是被吞掉；有冗余就能修复。
- **快照**几乎是瞬时且廉价的，因为什么都不复制。
- **send/receive** 复制，能把一个快照流式传到另一台机器。
- **类 RAID 的冗余**是内置的——btrfs 有 `raid1`/`raid10`，ZFS 有 `mirror`/RAIDZ。
- **子卷 / 数据集（subvolume / dataset）**，让你能只快照一棵子树而不动其余。
- **压缩与 scrub**，用来定期验证数据还是好的。

如果你以前只用过 ext4，那关键转变在两边是一样的：快照不是你能 `cp` 走的备份，但它是
一个极好的备份*来源*。正是在这一点上，它们进入了
[能真正恢复的备份](/zh/posts/backups-you-can-restore/)里的那套方案。

## 它们在哪里分道扬镳

两者架构确实不同，而这个不同解释了大部分实践层面的建议。

### btrfs：在内核里，按文件更灵活

btrfs 住在 Linux 主线内核里——不用编译模块，不用每次升级后跟 DKMS 搏斗。它首先是个
文件系统、其次才是卷管理器：它也管设备，但能力可以按文件和目录来设。你可以让一个子卷
`compress=zstd`、另一个 `compress=no`；可以对一个虚拟机镜像或数据库文件打开
`nodatacow`，别处保持关闭。这种细粒度才是 btrfs 真正的好处，也是它在单盘上讨人喜欢的
原因。

代价是 btrfs 是一个仍在演化的文件系统。它 RAID5/6 的 write-hole 问题众所周知，结论
仍然是：别用 btrfs 的 `raid5`/`raid6` 存数据；`raid1` 和 `raid10` 才算稳定。元数据和
数据 profile 是按 chunk 分别配置的，既强大又同样地让人困惑。

### ZFS：集成的卷管理与成熟的 RAIDZ

ZFS 把整摞东西当成一件事。你把盘交给它，池、数据集、压缩、加密和 RAID 都归它管。它
其实不太像「装在一个分区上的文件系统」——在 Linux 上用 ZFS，你通常根本不碰内核分区表，
而是把裸设备交给 `zpool`。正是这种集成，让 RAIDZ 如此可靠：它从设计之初就把校验和与
池当成一个系统，并且有十五年的生产环境锤炼。

你失去的是按文件的旋钮。压缩、recordsize 之类是按数据集设的，不是按文件——不过按数据
集的 `recordsize` 已经能覆盖大多数需求。换来的是一套成熟、可预期、文档齐全的栈：`zpool
scrub`、`zfs send`，以及一大群已经踩过你那个 bug 的运维。

## 内存这道题：ARC 与 RAM

这是 homelab 里人们能切身感到的差异。

ZFS 用 **ARC**（Adaptive Replacement Cache，自适应替换缓存）做读缓存，默认会慷慨地
用掉大部分空闲内存。在一台 32–128 GB 的 NAS 上这很棒，也是 ZFS 感觉快的很大一部分
原因。但在小机器上，这就是你要调的东西：一台 8 GB 的机器默认装上去，可能会给其它服务
造成内存压力。你可以给它设上限（`zfs_arc_max`），而在较新的 OpenZFS 2.2 的「Linux 上
的 ARC」行为下，它会更优雅地归还内存——但你仍然要为它做规划。

btrfs 没有自己那个巨大的读缓存，它靠 page cache。这让它在低内存机器和虚拟机上开箱更
宽容。它并不会魔术般地更快——只是缓存不是 ZFS 的 ARC 而已。

我用的粗略规则：如果机器内存 16 GB 或更少、还跑着别的东西，btrfs 的规划负担更小。如果
是一台内存充裕的专用存储机，ARC 是特性，不是税。

## 许可证与恢复工具链

Linux 上的 ZFS 是 OpenZFS，采用 CDDL，与 GPL 不兼容——所以它没法合并进主线内核，只能
以树外模块（DKMS）的形式发布，或由发行版自己捆绑。实践中这在 Debian、Ubuntu、Proxmox、
TrueNAS 这类系统上都没问题。但这也意味着内核升级和 ZFS 模块重编偶尔会变成一段舞。如果
你跑的是 [Proxmox 而不是普通 Linux](/zh/posts/proxmox-vs-plain-linux/)，这个问题已经
替你解决了——Proxmox 发布的是内核与 ZFS 配套的版本。

btrfs 是 GPL 且在主线内，随发行版一起来，什么都不用装。这就是大多数 homelab 用户
在意的全部许可证故事。

恢复才是天平倾斜的地方。ZFS 的工具更老、更厚：`zpool import` 的 `-F`/`-X` 能做事务
回滚，能按 ID 导入，有很长的历史记录。btrfs 有 `btrfs check` 和 `btrfs rescue`，快照
也确实不止一次救过我，但那个印象——大体上是挣来的——是当 btrfs 出问题时，恢复的路子
更窄。两者用错了都会丢数据；只是 ZFS 有更多人已经走过那条路。

## 选之前我会问的实践问题

在给推荐之前，真正决定答案的是这几个问题。

### 一块盘，还是很多块？

单盘会改变一切。只有一块盘时，两边都没有冗余，于是竞争点落在快照、压缩和特性上——
btrfs 靠便利性胜出：在内核里、按子卷配压缩、需要时用 `nodatacow`。多盘时，ZFS 的池
模型和 RAIDZ 的成熟度，才是人们选它的原因。

### 内存预算多少？

在 16 GB 以下、还要和别的服务共享时：优先 btrfs，或者准备给 ARC 设上限。专用机器且
空间充裕：都行，但 ZFS 的缓存是额外的好处。

### 我要不要把快照当成备份的骨架？

都可以。但要注意快照是*本地*的。一旦你把 **filesystem snapshots** 当成备份本身，你就
有了一个单点故障和一个正在等着你的「把盘塞满」的意外。快照是去喂一个真备份的，它不
替代备份。参见[能真正恢复的备份](/zh/posts/backups-you-can-restore/)。

### 我能不能 send/receive 到异地？

两者都可以，而这正是我最在意的特性，因为它让备份变成增量、变得便宜。

```bash
# btrfs：先打快照，再把快照流到异地
btrfs subvolume snapshot -r /srv/data /srv/snapshots/data-$(date +%F)
btrfs send /srv/snapshots/data-2026-11-12 \
  | ssh offsite 'btrfs receive /backup/data'
```

```bash
# ZFS：先打快照，再把快照流到异地
zfs snapshot tank/data@2026-11-12
zfs send tank/data@2026-11-12 \
  | ssh offsite 'zfs receive backup/data'
```

第二次跑任何一个都是增量的：只发送相对上一个快照的差量。这就是当初选一个 CoW 文件系统
的全部理由——异地备份的规模随「变化量」而非「总量」增长。

### 它崩掉时有多糟？

对自己诚实一点，看你的技能，而不是文件系统的名声。ZFS 给你更多恢复的把手和更大的知识
库；btrfs 给你更简单的搭建和容易排期的 `btrfs scrub`。问问自己：你更愿意去调试一个
import 失败，还是一个 `btrfs check --repair`（后者应被当作最后手段，而不是日常命令）。

## 分场景我会怎么选

- **单盘笔记本或小服务器。** btrfs。在内核里、不用 DKMS、有按文件的选项、快照带来廉价
  回滚，而且不觊觎你的内存。只有当你真有两块盘时才用 `raid1`。
- **小型 NAS 阵列（3–8 块盘）。** ZFS，用 RAIDZ 或镜像。这正是 ZFS 被造出来的场景：
  一个池、一次 scrub、成熟的校验冗余，还能 send/receive 到异地。给 ARC 留预算，理想
  是每 TB 约 1 GB 再加余量。
- **「我只想它能用」。** 你的平台发布并支持哪个就用哪个。TrueNAS 上是 ZFS，原版桌面
  发行版上是 btrfs。别跟手里的平台较劲去耍聪明。

## 决策表

| 场景 | btrfs | ZFS |
| --- | --- | --- |
| 单块盘 | 最合适：在内核里、灵活 | 能用，但 ARC 和搭建是杀鸡用牛刀 |
| 两块镜像盘 | 好（`raid1`） | 好（`mirror`） |
| 3 块以上、带校验的阵列 | 避开 RAID5/6 | **RAIDZ** 正是选 ZFS 的理由 |
| 内存 ≤ 16 GB、共享机器 | 负担更小 | 给 `zfs_arc_max` 设上限 |
| 专用存储、32 GB 以上 | 没问题 | ARC 把内存变成缓存收益 |
| 用快照做回滚 | 可以，子卷 | 可以，数据集 |
| send/receive 到异地 | 原生、增量 | 原生、增量 |
| 崩掉后的恢复 | 工具链更窄 | 成熟的 `zpool import -F/-X` |
| 内核 / 许可证 | GPL，主线内 | CDDL，树外或捆绑 |
| 按文件调优 | 可以（`nodatacow`、按子卷） | 只能按数据集 |

## 性能因环境而异——请测你自己的

我刻意不引用任何基准数字。两者性能都不差，而你能从一篇博客里抄到的数字，取决于你的
硬盘、你的 recordsize 或压缩设置、负载是随机读还是顺序写，以及你能拿出多少缓存。诚实
的建议是：选一个，学会它那两三个调优旋钮，然后实测你自己的负载。一个在合成测试里慢 5%、
但你凌晨两点能救回来的文件系统，在实践中更快。

如果只留一句话：**单盘且内存紧张选 btrfs，真阵列且有真内存预算选 ZFS。** 而无论哪种，
都要把快照加上 **send receive** 送到别处，因为文件系统不是备份。
