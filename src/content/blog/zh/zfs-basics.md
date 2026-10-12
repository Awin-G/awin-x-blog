---
title: "只想用快照、又不想丢数据的 ZFS 入门"
description: "一份不讲理论的 ZFS 入门：真正要懂的四个概念（pool、dataset、snapshot、scrub），你实际会敲的那几条命令，为什么 ZFS snapshots 不是备份、以及 zfs send receive 如何补上这一课，小机器上 ZFS ARC 的诚实答案，ECC 的迷思，还有出事后怎么恢复。"
pubDate: 2026-11-16
lang: zh
translationKey: zfs-basics
tags: [homelab, self-hosting, linux]
featured: false
keywords:
  - ZFS snapshots
  - ZFS 入门
  - zfs send receive
  - ZFS ARC
  - scrub
  - pool
  - offsite backup
---

我不是靠读手册学会 ZFS 的。我和大多数人一样学会它：我手上有丢不起的数据，一直听人说
**ZFS snapshots** 就是答案，我想今晚就把它跑起来。这篇就是我当年希望存在的那篇文章——
让你能拍快照、能安心睡觉的那些 **ZFS 入门**知识，以及你现在还用不上的那一大堆 pool 理论
全都省掉。

如果整页你只带走一句话，那就带走这句：同一台机器上的快照是一个很好用的*撤销按钮*，不是
备份。文章剩下的部分，就是怎么把它搭起来，然后把这些快照真正送到别处去，好让一块盘坏掉
不等于一个归档没掉。

<figure>
<svg viewBox="0 0 640 190" width="100%" role="img" aria-label="一组磁盘组成 pool，pool 里有 dataset；每个 dataset 都能拍快照；快照通过 zfs send 到 zfs receive 传到异地。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="16" y="62" width="120" height="66" rx="8"/>
    <rect x="176" y="62" width="120" height="66" rx="8"/>
    <rect x="336" y="52" width="120" height="86" rx="8"/>
    <rect x="500" y="62" width="120" height="66" rx="8"/>
    <path d="M136 95 h40" marker-end="url(#a)"/>
    <path d="M296 95 h40" marker-end="url(#a)"/>
    <path d="M456 95 h44" marker-end="url(#a)"/>
    <path d="M456 95 c 0 -46 44 -46 44 0" opacity="0.25" stroke-dasharray="4 4"/>
    <defs>
      <marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
        <path d="M0 0 L8 4 L0 8 z" fill="currentColor"/>
      </marker>
    </defs>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="76" y="46">disks</text>
    <text x="236" y="46">dataset</text>
    <text x="396" y="40">snapshot</text>
    <text x="560" y="46">offsite</text>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" text-anchor="middle" opacity="0.9">
    <text x="76" y="90">sda sdb sdc</text>
    <text x="76" y="110" opacity="0.7">pool tank</text>
    <text x="236" y="90">tank/data</text>
    <text x="236" y="110" opacity="0.7">文件住在这里</text>
    <text x="396" y="84">tank/data@2026-11-16</text>
    <text x="396" y="104" opacity="0.7">只读、冻结</text>
    <text x="396" y="124" opacity="0.7">send | receive →</text>
    <text x="560" y="90">backup/data</text>
    <text x="560" y="110" opacity="0.7">另一台机器</text>
  </g>
</svg>
<figcaption>pool 把你的磁盘组成一个整体，dataset 是它里面的文件系统，snapshot 冻结某个 dataset 的某一刻。<code>zfs send</code> 把这个快照流式传到另一台机器——这才让它成为真正的备份。</figcaption>
</figure>

## ZFS 入门：pool、dataset、snapshot、scrub

四个词。开始之前你需要的全部词汇就这些。

一个 **pool（存储池）**就是那块存储。你把一块或多块磁盘交给 ZFS，它把它们组成一个
整体。你不去分区、不去挂载磁盘——你把裸设备交给 `zpool`，之后它们归它管。我把它叫
`tank`，因为大家都这么叫，也因为一个这么无聊的名字是你不会忘掉的。

一个 **dataset（数据集）**就是 pool 里的一个文件系统。它看起来像目录、用起来也像目录，
但它是一条接缝：你可以在上面单独设压缩、配额，单独拍快照。`tank/data` 和 `tank/media`
可以用不同的计划备份，因为它们是不同的 dataset。

一个 **snapshot（快照）**是某个 dataset 在某一瞬间被冻结下来的只读视图。它一开始几乎
不占空间，因为之后 ZFS 只存*变化*——这就是写时复制（copy-on-write）的含义。快照用
`@` 命名：`tank/data@2026-11-16`。

一次 **scrub**是 ZFS 遍历每一个数据块、校验校验和，并在有冗余可修时修复不匹配的地方。
它就是让你在真正需要数据*之前*，发现某块盘正在悄悄腐烂的手段。你每月安排一次，然后
忘了它。

模型就是这样，其余都是细节。

## 你实际会用到的命令

一个基础配置的全部工作集就在这。建 pool、建 dataset、拍快照、看快照。

```bash
# 1. 用裸盘建一个 pool（会毁掉盘上原有的一切）。
#    mirror = 两块盘存同样的数据，坏一块也没事。
sudo zpool create tank mirror /dev/sdb /dev/sdc

# 2. dataset 才是你文件真正住的地方。
sudo zfs create tank/data
sudo chown -R "$USER" /tank/data
```

```bash
# 3. 拍快照。几乎是瞬时、当下几乎不占空间。
sudo zfs snapshot tank/data@manual-before-upgrade

# 4. 看你的快照，以及每个快照额外占了多少空间。
zfs list -t snapshot
zfs list -t snapshot -o name,used,refer tank/data
```

两个习惯让它安全。第一，任何有风险的操作*之前*都先拍快照——改配置、升级、你不确定的
删除。第二，自动化快照用日期命名，这样你日后读列表时不用猜。

要回滚，就丢掉那些变化、回到冻结的那一刻：

```bash
# 撤销这个快照之后的所有改动（会丢弃较新的变化）。
sudo zfs rollback tank/data@manual-before-upgrade
```

当快照完成使命后，删掉它——快照会钉住旧数据块，一个过期的快照会一直占着空间：

```bash
sudo zfs destroy tank/data@manual-before-upgrade
```

## zfs send receive：把快照送出这台机器

从这里开始它就不是玩具了。`zfs send` 把一个快照变成字节流；`zfs receive` 把这个流写进
另一台系统上的 dataset。第一次 send 是整个 dataset，之后每一次都能是**增量**的——它只
传自上一个快照以来变化过的数据块，这就是为什么大 dataset 的异地备份能变得又小又快。

```bash
# 第一次，完整发送。
sudo zfs send tank/data@2026-11-16 | ssh offsite 'sudo zfs receive backup/data'

# 之后用增量：只发自上一个快照以来的差异。
sudo zfs send -i tank/data@2026-11-15 tank/data@2026-11-16 \
  | ssh offsite 'sudo zfs receive backup/data'
```

`-i` 是关键的那个旗标。它的意思是「从较旧的快照开始，把变成较新快照的那部分发给我」。
在接收端，`backup/data` 会成为对应的位置，于是你的数据现在存在于第二台机器上。

这就是[能真正恢复的备份](/zh/posts/backups-you-can-restore/)背后的机制：快照是来源，
`zfs send receive` 是传输。如果你还在挑文件系统，我在
[btrfs vs ZFS](/zh/posts/btrfs-vs-zfs/) 里对比过几种选择。

## 为什么 **ZFS snapshots** 不是备份

这部分我不会软化。快照和它所保护的数据住在同一个 pool 上。如果 pool 死了——控制器
故障、一条错的 `zpool` 命令、机器被偷、把 pool 抹掉的勒索软件、一场火灾——所有快照
都跟着死。快照保护你免于*你自己*：一次改错、一次误删、一次搞砸的升级。它不保护你免于
丢掉整台机器。

备份必须是*另一台设备*上的副本，最好在*另一个地方*，而且必须在原件没了之后依然活着。
只有快照这两条都不满足。这正是上面 send/receive 那一步重要的原因：当快照作为自己的
dataset 落到异地机器上的那一刻，它就不再是撤销按钮，而开始成为备份。

对自己狠一点：如果两份拷贝在同一台物理机器上，你就没有备份，你有一个非常快的撤销
按钮。两个都有用，但只有一个是备份。

## ZFS ARC 与内存：给小机器的诚实答案

**ZFS ARC** 是 ZFS 的读缓存。它把最近读过的块留在内存里，好让下一次读是瞬时的，默认
情况下它会一直长到吃掉大部分空闲内存。在一台 32–64 GB 的 NAS 上，这正是它的意义，也
是 ZFS 感觉快的一部分原因。

但人们读到那句老建议——「每 TB 存储配 1 GB 内存」——然后在 8 GB 的机器上吓坏了。诚实
的版本是这样。那条规则描述的是一个大而繁忙的阵列在负载下的表现，它不是启动的必要条件。
ZFS 在小机器上跑得好好的。实际发生的是 ARC 会和你的其他服务抢内存，所以你给它设个
上限。

```bash
# 把 ARC 限制在 2 GB，而不是让它填满内存。
echo "options zfs zfs_arc_max=$((2*1024*1024*1024))" \
  | sudo tee /etc/modprobe.d/zfs.conf
sudo update-initramfs -u   # 或你发行版对应的命令
# 重启后，看看它稳定在哪：
arc_summary | grep -i size
```

在现代 OpenZFS（2.2 及以后），ARC 在内存吃紧时交还内存也比以前从容得多，所以那种恐慌
就更没有道理了。一条实用规则：8 GB 上限制在 1–2 GB；16 GB 上给 4 GB 就很宽裕了；只有
在专门的存储机上才让它随便吃。如果你的机器内存紧张、还跑着别的东西，那是一个合理地
选择更轻的文件系统的理由——[btrfs vs ZFS](/zh/posts/btrfs-vs-zfs/) 里讨论了这个取舍
什么时候值得。

## ECC 的迷思

你会反复读到，ZFS「需要」ECC 内存。它不需要。ZFS 在非 ECC 内存上并不会更危险，非 ECC
内存也不会以某种特殊方式损坏 ZFS。真实情况是：ZFS 对内存的*信任*比大多数文件系统更多
——它激进地缓存，并在内存里校验——所以一条真正在坏的 ECC 内存条，在 ZFS 上造成的可见
损坏可能比在 ext4 上更多，而后者本来就基本默认磁盘是对的。

正确的理解是：对*任何*认真的存储机器来说，ECC 都是好保险，但它不是跑 ZFS 的前提。如果
预算和主板允许，就买 ECC，因为内存错误不管用什么文件系统都可能伤到你。别让这个迷思
拦住你在普通机器、普通内存上跑 ZFS。每天都有几百万人这么做，平安无事。

## 出事了怎么恢复

大多数 ZFS 失误都能恢复，而真正的本事在于分清「回滚」和「别再碰它」的区别。

**我改了一个文件或者删了它。** 快照、回滚——上面讲过。这是常见情况，也很好办。

**我不小心删了一个 dataset。** 如果快照还在，你可以把它克隆回一个活的 dataset，而不
需要做完整恢复：

```bash
sudo zfs clone tank/data@2026-11-16 tank/data-restored
# 检查 /tank/data-restored，把你要的拷出来，然后清理：
sudo zfs destroy tank/data-restored
```

**一块盘坏了。** ZFS 会大声告诉你，就在 `zpool status` 里。换盘，然后 resilver——它会
用幸存的副本把缺失的数据重建出来：

```bash
zpool status            # 看哪块盘处于 faulted
sudo zpool replace tank /dev/sdb /dev/sdd
sudo zpool status -v    # 看着 resilver 完成
```

**重启一次之后 pool 挂不上了。** 在跑任何破坏性命令之前，先试着只读导入，需要的话让
ZFS 回滚最后几个事务：

```bash
sudo zpool import -F -n tank   # -n = 空跑，先看它想干什么
sudo zpool import -F tank      # 再真正导入，回滚 txg
```

凌驾于一切之上的一条规则：当一个 pool 不对劲时，**不要因为论坛让你这么干就跑
`zpool destroy` 或者 `-f` 旗标**。只读导入，把数据取出来，在让局面变成永久之前先去
求助。数据在第二台机器上——就是你早先搭好的那个 send/receive——才是把一场灾难变成一点
麻烦的关键。

## 一个每晚快照 + 异地发送的例子

下面是把整套东西接起来的样子。这个脚本在本地保留七天每日快照，并把每个新快照发到一台
异地机器。放进 02:30 的 cron，或者写成 systemd timer，随你喜欢。

```bash
#!/usr/bin/env bash
set -euo pipefail

DATASET="tank/data"
DEST_HOST="offsite"
DEST_DATASET="backup/data"
TODAY="$(date +%F)"
YESTERDAY="$(date -d yesterday +%F)"

# 1. 拍今天的快照。
zfs snapshot "${DATASET}@${TODAY}"

# 2. 发到异地。如果那边已有昨天的快照，就只发增量。
if ssh "${DEST_HOST}" "zfs list -t snapshot -H -o name" | grep -q "@${YESTERDAY}$"; then
  zfs send -i "${DATASET}@${YESTERDAY}" "${DATASET}@${TODAY}" \
    | ssh "${DEST_HOST}" "zfs receive ${DEST_DATASET}"
else
  zfs send "${DATASET}@${TODAY}" \
    | ssh "${DEST_HOST}" "zfs receive ${DEST_DATASET}"
fi

# 3. 删掉本地超过七天的快照。
zfs list -t snapshot -H -o name "${DATASET}" \
  | awk -F@ -v cutoff="$(date -d '7 days ago' +%F)" '$2 < cutoff' \
  | xargs -r -n1 zfs destroy
```

再往每月 cron 里加一行，你就有了能自我修复的存储：

```bash
# 每月第一个周日，校验每个数据块，并在冗余允许的范围内修复。
zpool scrub tank
```

## 简版总结

记住四个词——pool、dataset、snapshot、scrub。用四条命令——`zpool create`、
`zfs create`、`zfs snapshot`、`zpool scrub`。然后加上 `zfs send receive`，把这些快照
弄到第二台机器上，因为 **ZFS snapshots** 是一个撤销按钮，只有异地那份拷贝才是备份。
机器小就给 **ZFS ARC** 设个上限，别理会 ECC 迷思，并且知道 `zpool import -F` 和一个
克隆出来的快照会救你，远在你需要慌张之前。
