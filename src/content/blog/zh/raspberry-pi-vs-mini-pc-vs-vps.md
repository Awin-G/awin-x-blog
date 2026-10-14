---
title: "树莓派 vs 迷你主机 vs VPS：服务到底该跑在哪里？"
description: "不是一份购物清单，而是一次决策：树莓派 vs 迷你主机 vs VPS，用一台笔记本和一台 1 核 VPS 上真实测得的 CPU、磁盘与 CPU steal 数据来判断，再加上功耗、TDP、公网 IP，以及 mesh VPN 的拆分方案。"
pubDate: 2027-02-17
lang: zh
translationKey: raspberry-pi-vs-mini-pc-vs-vps
tags: [homelab, self-hosting]
featured: false
keywords:
  - 树莓派 vs 迷你主机
  - homelab 硬件
  - VPS vs 家用服务器
  - 功耗
  - 总拥有成本
  - TDP
  - mesh VPN
---

每隔几周就有人用同一个句式问我：*我想在家跑某个服务——该买树莓派、迷你主机，还是干脆租个 VPS？* 以前我会回一份购物清单。那是错的，因为问题不是"该买什么"，而是"**这个服务到底该放在哪里**"——而后者的答案只取决于一件事：谁需要能连到它。

所以下面是我的答案，和我做所有事情一样：先看我能真正摸到的机器上的数字，并且诚实地把"我测不了的数字"圈出来。

这三种形态里我只拥有两种：一台我用来开发的笔记本级 x86 机器，一台托管这个博客的 1 核 VPS。**我没有树莓派。** 下面关于树莓派的每一句话都来自树莓派官方的产品简报（product brief），并且我会明确标注。一块我从未启动过的板子，你不该因为我的话就相信它。

## 我能真正测量的两台机器

先看开发机。它是一台 2017 年的笔记本——这恰是讨论"迷你主机"时最合适的参照物，因为它就是一个小机身里的 15 W 级 x86 芯片，而且在干真实的工作：

```console
$ nproc; LC_ALL=C lscpu | grep -E 'Model name|^CPU\(s\)|Core\(s\) per|Thread\(s\) per'
8
Model name:  Intel(R) Core(TM) i7-8550U CPU @ 1.80GHz
CPU(s):      8
Core(s) per socket: 4
Thread(s) per core:  2
$ LC_ALL=C free -m | head -2
               total        used        free      shared  buff/cache   available
Mem:          11833        7968         454         247        4032        3865
$ lsblk -d -o NAME,ROTA,SIZE,MODEL
NAME  ROTA   SIZE MODEL
sda      1 298.1G WDC WD3200BUCT-63TWBY0
sdb      0 238.5G Micron_1100_MTFDDAV256TBN
sdc      1 116.5G Card Reader
$ df -h /
/dev/mapper/cryptroot   234G  157G   65G  71% /
```

两块盘，而 `ROTA` 这一列就是全部重点：`sda` 会转（298 GB，`/data`），`sdb` 是 SATA SSD（238 GB，`/`）。同一台机器、同一个系统，IO 却天差地别——我下面会用数据回到这一点。

再看那台公网机器，只读 SSH：

```console
$ ssh -p622 root@88.218.79.95 'nproc; uptime; df -h /; grep -m1 "model name" /proc/cpuinfo'
1
 12:13:44 up 23 days, 20:56,  0 users,  load average: 2.07, 1.55, 0.74
/dev/vda1        14G  8.5G  4.2G  68% /
model name	: Intel(R) Xeon(R) CPU E5-2630 v4 @ 2.20GHz
```

**一核。981 MB 内存。14 GB 磁盘。而在一台自称只有 1 个 CPU 的机器上，负载是 2.07。** 这就是 VPS 体验的一句话总结：这台机器是那颗 10 核 Xeon 里的单独一个核，另外九个核正忙着别人的活。我在两个独立的 5 秒窗口里采样了 CPU steal——**一个是 0.60 %，另一个是 0.00 %**。共享是真的，但目前还温和，而这正是你在相信某一次跑分之前需要知道的事。

## 每种形态真正擅长什么

### 树莓派：GPIO 机器

Pi 5 不是一台小号的通用服务器，它是一块**碰巧能跑 Linux 的传感与执行板**。官方简报里的关键数字：Broadcom BCM2712，四核 Arm Cortex-A76 @ 2.4 GHz，每核 512 KB L2 加 2 MB 共享 L3，40 针 GPIO，一条 PCIe 2.0 x1 通道可通过 M.2 HAT 接 NVMe，以及 5 V/5 A USB-C 供电（板子上限 25 W，官方推荐 27 W 电源）。官方标价从 $45（1 GB）到 $175（8 GB）。**这些是规格书数字，不是我的实测。**

它赢在三件事：**3.3 V 数字 IO 加上 I2C、SPI、UART 排针**——x86 主机和 VPS 都给不了你这个，所以"读个传感器、吸个继电器"不是妥协，而是唯一正确答案；**待机功耗只有个位数瓦**，可以长年通电；以及**便宜到可以当一次性的**扔在室外柜里。

它输在两件事，说实话。**CPU 和 IO**——四核 2.4 GHz 拿来做去广告 DNS 绰绰有余，拿来编译就没戏。以及**SD 卡脆弱性**：microSD 是默认启动介质，而一个常年开机、一边写日志一边写数据库的服务，恰好就是最能搞坏卡的那类负载。Pi 5 的 PCIe 通道能通过 M.2 HAT 从 NVMe 启动来根治这个问题——代价是额外花钱、额外多一个会坏的部件。我想测自己的读卡器来给你看损伤，但没能如愿：`/dev/sdc1` 对我的非特权用户不可读，所以我不会编造 SD 卡的数字。Pi 也同样要自己承担可用性：没有公网 IP、没有电池、没有故障转移。

### 迷你主机：家里的盒子

迷你主机就是我这台开发机近似的形态：15 W 级 x86 芯片、一块真 SSD、8–16 GB 内存、安静、能放上书架。让这个品类成立的东西是它的 **TDP**——我这颗 i7-8550U 标称 **15 W**，可配置 TDP-up 25 W、TDP-down 10 W（均为 Intel 官方规格；要记住 TDP 是*热设计*数字，不是墙上的功耗）。

诚实的代价是：**硬件归你。** 没有租金、没有吵闹的邻居、是真的盘、真的有升级路径——换 SSD、加内存，或者把盘搬到新机器上数据还跟着走。相应地，电费、风扇噪音、硬盘故障、跳闸，以及凌晨三点"怎么掉线了"的排查也都归你。没有别人为你的可用性值班。

### VPS：别人的可用性

VPS 是三种形态里唯一到手就带**公网 IP 和别人的运维**的：不用伺候硬件、有快照按钮、有 IPv6 段，电力与网络是别人的本职工作。你付出的是：永远在付租金、CPU 是共享的（上面刚测过）、磁盘是 hypervisor 给什么就是什么，而住宅宽带上的公网 IPv4 恰恰是大多数家庭 ISP 不肯卖你的东西。

## 真正决定选择的五个标准

忘掉型号。选形态的是这五点：**三年功耗**（唯一永不停止、也最会惩罚"看着便宜"的开销）；**IO**——不是 CPU 核数，因为核可以共享，机械盘不行；**可用性与备份责任**——谁在凌晨被叫起来，以及数据在别处还有一份；**公网 IP / 可达性**——谁必须能连上；以及**噪音与升级路径**——你能不能跟它睡一个屋，以及它能不能长大。

## 实测与规格书分开放

下面是我所有论断及其来源，因为"来自规格书"和"我实测的"不是同一种论断：

| 项目 | 数值 | 来源 |
|---|---|---|
| 开发机 CPU | i7-8550U，4C/8T，基频 1.80 GHz，最高 4.00 GHz，L3 8 MiB | 实测（`lscpu`） |
| 开发机 CPU TDP | 15 W（cTDP-up 25 W，cTDP-down 10 W） | **规格书**（Intel） |
| 开发机磁盘 | SSD 顺序 303 MiB/s／HDD 顺序 70 MiB/s | 实测（`fio`） |
| VPS CPU | Xeon E5-2630 v4 @ 2.20 GHz 的 1 个 vCPU，981 MB 内存 | 实测（只读 SSH） |
| VPS CPU 争抢 | 1 vCPU 上负载 2.07；steal 0.60 %／0.00 % | 实测（`/proc/stat`） |
| VPS 磁盘 | 顺序 0.79–2.7 GB/s（3.4 倍波动）；4 KiB 随机 3,323 IOPS | 实测（`dd`、`pread`） |
| Pi 5 CPU | BCM2712，4×Cortex-A76 @ 2.4 GHz，L3 2 MiB | **规格书**（树莓派） |
| Pi 5 功耗 | 上限 25 W，推荐 27 W 电源 | **规格书** |
| *我这台*的墙上功耗 | **未测**——见下文 | — |

我没有自己的墙上瓦数，也不打算编。这台笔记本的 RAPL 能耗计数器是存在的（`/sys/class/powercap/intel-rapl:0/energy_uj`），但我的用户读不了，而我也没有功率计插座。**想要诚实的功耗数字，就买一个功率计插座**——它是 homelab 硬件里最便宜的仪器，能把"大概 10 W"变成一个事实。

## 我能测的：CPU 与 IO

一个小 C 基准程序（xorshift + LCG，无内存分配，`gcc -O2`），多次跑取最好：

```console
$ ./bench 1 200000000
threads=1 iters_per_thread=200000000 total_iters=200000000 seconds=0.820 Mops/s=244.0
$ ./bench 4 100000000
threads=4 iters_per_thread=100000000 total_iters=400000000 seconds=0.585 Mops/s=684.0
$ uptime
 19:30:08 up 2 days, 15:17,  1 user,  load average: 5.71, 7.83, 6.81
```

四线程给出单线程的 **2.8 倍**而不是 4 倍——一台笔记本的功耗与散热上限，而它的规格书 TDP 只有 15 W。也请注意负载均值：**8 线程上是 5.71**。我跑分的时候这台机器在干别的活，所以反复单线程跑出来的数字落在 176 到 259 Mops/s 之间。这个波动不是要藏起来的噪声，它就是一台忙碌机器诚实的样貌，也是"一次 VPS 跑分说明不了任何事"的原因。

同一个串行负载放到 VPS 上，用 Python：

```console
# on the VPS: trial-division primes < 300000, best of 3
{"bench": "trial-division primes < 300000", "primes": 25997, "best_seconds": 1.156, "threads": 1}
```

而开发机上是 **0.889 秒**——同样的 Python 代码，VPS 慢约 1.3 倍，尽管纸面上它的 CPU 是一颗 10 核、85 W 的 Xeon。一个共享 vCPU 就是一个共享 vCPU。

然后是真正能终结大多数 homelab 争论的部分——**磁盘 IO**，同一台机器，`direct=1` 绕过页缓存：

```console
$ fio --name=ssd_seq --rw=read --bs=1M --size=256M --direct=1 --filename=$HOME/b.dat
   READ: bw=303MiB/s (318MB/s), io=256MiB (268MB), run=844-844msec
$ fio --name=ssd_rnd --rw=randread --bs=4k --size=256M --direct=1 --iodepth=16
   READ: bw=9.88MiB/s (10.4MB/s), io=256MiB (268MB), run=25915-25915msec
$ fio --name=hdd_seq --rw=read --bs=1M --size=256M --direct=1 --filename=/data/backup/home/b.dat
   READ: bw=70.3MiB/s (73.7MB/s), io=256MiB (268MB), run=3640-3640msec
$ fio --name=hdd_rnd --rw=randread --bs=4k --size=16M --direct=1 --iodepth=1
   READ: bw=193KiB/s (198kB/s), io=16.0MiB (16.8MB), run=84943-84943msec
```

再读一遍最后一行：**每秒 49 次 4 KiB 随机读**——同一个测试的 256 MiB 版本，120 秒都没跑完。一台机器、两块盘，**顺序差 4 倍、随机差 50 倍**，而且测的是一块*状况良好*的机械盘，不是一张用旧的卡。这个数字能在"插张大 SD 卡的树莓派就是 NAS"这句话说出口之前就杀掉它。

再看 VPS 的磁盘——这是关于"租用共享硬件"的包袱梗：

```console
$ for i in 1 2 3; do dd if=/dev/vda of=/dev/null bs=1M count=512 iflag=direct 2>&1|tail -1; done
536870912 bytes (537 MB, 512 MiB) copied, 0.570641 s, 941 MB/s
536870912 bytes (537 MB, 512 MiB) copied, 0.21896 s, 2.5 GB/s
536870912 bytes (537 MB, 512 MiB) copied, 0.199249 s, 2.7 GB/s
$ python3 -c 'random 4KiB pread over /dev/vda, 2000 reads'
device=/dev/vda size=15032385536 bytes  random 4KiB pread: 2000 reads in 0.60 s = 3323 IOPS
```

在我历次会话里，顺序读在 **0.79 到 2.7 GB/s** 之间波动——同一块设备差出 3.4 倍，因为宿主机的存储和缓存是共享的。4 KiB 随机 **3,323 IOPS** 完全够用（背后显然有 NVMe），但那个顺序数字移动了三倍。**租来的 CPU 和租来的盘，都活在别人的日程表里。**

## 总拥有成本，不带购物清单

完整的三年的总拥有成本表我已经写在[《预算之内的 homelab》](/zh/posts/homelab-on-a-budget/)里了，这里不重复。此处关键的是这套算术的*形状*，好让你用自己的数字重算：

- 三年电费是 `瓦数 × 26,280 小时 ÷ 1000 × ¥/kWh`。在低功耗 x86 机器上它只是总额的*少数*，硬件占大头；在一台二手 1U 服务器上它变成*大头*，这就是"捡便宜的企业级设备"是最贵的 homelab 错误的原因。
- 一台便宜的 VPS 是**租金**，一条直线：`¥/月 × 36`。在每月几十块的档位上，三年算下来和一台二手迷你主机是同一个量级——而且它不会坏、不会断电，还自带一个你在家里买不到的公网 IP。
- 真正要紧的分界线不是"哪个更便宜"，而是"**哪一笔开销到第四年还在跑**"。硬件会摊薄到零，租金不会。

诚实的说法：树莓派买起来最便宜，迷你主机在你已经有了之后养起来最便宜，而 VPS 是*最不用去想*的那个。

## 决策树

按顺序回答：

1. **它需要公网 URL、公网 IP，还是"哪怕我家停电它也要在"？** → **VPS。** 这里没有第二种形态自带公网 IP 或别人的可用性。（怎么选见[《如何选 VPS》](/zh/posts/choosing-a-vps/)。）
2. **它是媒体、备份、一个大本地库，还是你每月都要重搭一遍的实验？** → **迷你主机。** 本地的字节、本地的带宽、没有按 GB 计的租金。
3. **它要接传感器、继电器、电机或 GPIO 排针吗？** → **树莓派。** 唯一带 IO 引脚的形态。
4. **不确定？** → 先用你已经有的机器，再租一台最小的 VPS 扛住公网边缘。两件事都可逆。

盒子*里面*跑什么另当别论：一两个工作负载时，plain Linux 加 systemd 每次都赢过 hypervisor——我在[《Proxmox vs plain Linux》](/zh/posts/proxmox-vs-plain-linux/)里论证过。

## 为什么不全都要——我实际在用的拆分

化解这场争论的答案不是"选一个"，而是**"按谁必须连到来拆分"**：

- **面向公网的 → VPS。** 这个博客的 nginx、VPN 入口、任何陌生人的浏览器会碰的东西。它有公网 IP 和可用性。
- **大的、私有的、无聊的 → 家里的盒子。** 备份、媒体、折腾用的 lab，任何以几百 GB 计的东西。它有盘，且不收租金。
- **用 mesh VPN 把它们连起来**，而不是端口转发。我自己的 VPS 在 nginx、密码管理器和数据库旁边跑着 `easytier-core`，mesh 让家里的盒子可达而不向互联网暴露任何一个端口——配置写在[《用 EasyTier 搭私有 mesh》](/zh/posts/private-mesh-with-easytier/)。

背后的规则：**把必须可达的东西放在有公网 IP 的那台机器上，把必须持久的东西放在你控制的那台机器上。** VPS 可能因为一次账单纠纷消失，家里的盘可能悄悄死掉；用 mesh VPN 把两者接起来，两者就合成一个乏味、可恢复的系统。

<figure>
<svg viewBox="0 0 760 300" role="img" aria-label="树莓派、迷你主机与 VPS 在功耗、CPU、磁盘、GPIO 和公网 IP 上的对比" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">
  <g font-family="ui-monospace,monospace" font-size="11">
    <rect x="8" y="8" width="236" height="284" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
    <rect x="8" y="8" width="236" height="30" rx="6" fill="#0f766e"/>
    <text x="22" y="28" fill="#ffffff" font-size="13" font-weight="700">Raspberry Pi</text>
    <text x="22" y="56" fill="currentColor" opacity="0.6">power</text>
    <text x="86" y="56" fill="currentColor">single-digit W idle</text>
    <text x="22" y="76" fill="currentColor" opacity="0.6">cpu</text>
    <text x="86" y="76" fill="currentColor">4xA76 @ 2.4 GHz</text>
    <text x="22" y="96" fill="currentColor" opacity="0.6">disk</text>
    <text x="86" y="96" fill="currentColor">microSD (fragile)</text>
    <text x="22" y="116" fill="currentColor" opacity="0.6">gpio</text>
    <text x="86" y="116" fill="currentColor">40-pin header</text>
    <text x="22" y="136" fill="currentColor" opacity="0.6">public ip</text>
    <text x="86" y="136" fill="currentColor">none</text>
    <line x1="22" y1="156" x2="230" y2="156" stroke="currentColor" stroke-opacity="0.2"/>
    <text x="22" y="180" fill="#0f766e" font-weight="700">use when</text>
    <text x="22" y="200" fill="currentColor">sensors, relays,</text>
    <text x="22" y="218" fill="currentColor">embedded, GPIO</text>
    <text x="22" y="248" fill="currentColor" opacity="0.6">you own the uptime</text>

    <rect x="262" y="8" width="236" height="284" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
    <rect x="262" y="8" width="236" height="30" rx="6" fill="#0f766e"/>
    <text x="276" y="28" fill="#ffffff" font-size="13" font-weight="700">Mini PC (x86)</text>
    <text x="276" y="56" fill="currentColor" opacity="0.6">power</text>
    <text x="340" y="56" fill="currentColor">6-15 W idle</text>
    <text x="276" y="76" fill="currentColor" opacity="0.6">cpu</text>
    <text x="340" y="76" fill="currentColor">4-8 cores, real</text>
    <text x="276" y="96" fill="currentColor" opacity="0.6">disk</text>
    <text x="340" y="96" fill="currentColor">SATA / NVMe SSD</text>
    <text x="276" y="116" fill="currentColor" opacity="0.6">gpio</text>
    <text x="340" y="116" fill="currentColor">none</text>
    <text x="276" y="136" fill="currentColor" opacity="0.6">public ip</text>
    <text x="340" y="136" fill="currentColor">none (NAT)</text>
    <line x1="276" y1="156" x2="484" y2="156" stroke="currentColor" stroke-opacity="0.2"/>
    <text x="276" y="180" fill="#0f766e" font-weight="700">use when</text>
    <text x="276" y="200" fill="currentColor">media, backups,</text>
    <text x="276" y="218" fill="currentColor">homelab, big disks</text>
    <text x="276" y="248" fill="currentColor" opacity="0.6">you own the hardware</text>

    <rect x="516" y="8" width="236" height="284" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
    <rect x="516" y="8" width="236" height="30" rx="6" fill="#0f766e"/>
    <text x="530" y="28" fill="#ffffff" font-size="13" font-weight="700">VPS</text>
    <text x="530" y="56" fill="currentColor" opacity="0.6">power</text>
    <text x="594" y="56" fill="currentColor">someone else's bill</text>
    <text x="530" y="76" fill="currentColor" opacity="0.6">cpu</text>
    <text x="594" y="76" fill="currentColor">1 shared vCPU</text>
    <text x="530" y="96" fill="currentColor" opacity="0.6">disk</text>
    <text x="594" y="96" fill="currentColor">hypervisor image</text>
    <text x="530" y="116" fill="currentColor" opacity="0.6">gpio</text>
    <text x="594" y="116" fill="currentColor">none</text>
    <text x="530" y="136" fill="currentColor" opacity="0.6">public ip</text>
    <text x="594" y="136" fill="currentColor">yes, included</text>
    <line x1="530" y1="156" x2="738" y2="156" stroke="currentColor" stroke-opacity="0.2"/>
    <text x="530" y="180" fill="#0f766e" font-weight="700">use when</text>
    <text x="530" y="200" fill="currentColor">public site, public</text>
    <text x="530" y="218" fill="currentColor">IP, always-on</text>
    <text x="530" y="248" fill="currentColor" opacity="0.6">you rent forever</text>
  </g>
</svg>
<figcaption>FIG. 三种形态，三种要还的债：树莓派让你还 IO，迷你主机让你还可用性，VPS 让你还租金。三者都不让你还 CPU——每一种都有"够用"的那一份。</figcaption>
</figure>

## 我会怎么做

如果今天你来问我，而我桌上没有树莓派、另外两种都在手边：**租一台能扛住你公网边缘的最小 VPS，其余全跑在你已有的那台机器上。** 只有在一根线需要插进排针时才加树莓派。当"你已经有的那台"不够用了再买迷你主机——而且先买 SSD，再买机器。

我唯一拒绝作为依据的就是单次跑分。我上面这些数字，会因为机器当时在忙别的而浮动 50 %，会因为一块从未搬动的磁盘而浮动 3.4 倍。**测你的真实负载，在你的机器上，在它真正会运行的时段测。** 这是唯一能扛住现实检验的 homelab 硬件建议。
