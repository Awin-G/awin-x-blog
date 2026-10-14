---
title: "预算有限的家用实验室：你真正需要什么，什么纯属浪费"
description: "不靠想象、靠实测：一套家用服务栈在内存、磁盘和功耗上到底花多少。一台二手迷你主机对一台 VPS 的真实三年总成本，以及哪些设备对大多数人纯属浪费。"
pubDate: 2027-02-19
lang: zh
translationKey: homelab-on-a-budget
tags: [homelab, self-hosting]
featured: false
keywords:
  - 家用实验室预算
  - 家用实验室总成本
  - 迷你主机家用实验室
  - 电费成本
  - 二手硬件
---

大多数人搭建自己的第一套**预算有限的家用实验室**时，都会把钱花错地方。不是因为设备贵，而是因为他们为一个想象中的负载买单，而不是为真正会跑的负载买单。所以，我不用购物清单开头，先用实测数据开头。

我这个博客跑在一台只有 **981 MB 内存、1 个 vCPU** 的 VPS 上。不是实验机，不是机架——只是能提供静态文件的最便宜的东西。让我问问它此刻到底在干什么。

```console
$ ssh -p622 root@88.218.79.95
$ free -m | awk '/Mem:/{print $2" MB total, "$3" MB used, "$7" MB available"}'
981 MB total, 84 MB used, 753 MB available

$ for p in nginx easytier-core vaultwarden mariadbd sms.smtp.server syncserver; do \
    printf '%-16s %s MB\n' "$p" \
      "$(pgrep -f "$p" | xargs -r ps -o rss= -p | awk '{s+=$1} END{printf "%.1f", s/1024}')"; \
  done
nginx            6.3 MB
easytier-core    6.1 MB
vaultwarden      9.2 MB
mariadbd         7.4 MB
sms.smtp.server  6.4 MB
syncserver       3.2 MB
```

这是一台 Web 服务器、一个 VPN 守护进程、一个密码管理器、一个数据库、一个 SMTP 服务和一个同步服务——**六个服务一共约 39 MB 内存**。整台机器报告总共用了 84 MB（其余是操作系统，以及一个刚好在运行的构建进程）。磁盘：总共 14 GB，已用 8.5 GB，其中大部分是 613 MB 的博客仓库。

对一大类家用服务栈来说，这就是诚实的真实需求：**几十 MB 内存、一个核心、几 GB 磁盘**。不是 64 GB 内存加一颗 Xeon。

## 一套家用服务栈真正需要什么（实测）

我正在打字的这台开发机，用的是 2017 年的笔记本 CPU——i7-8550U，4 核 8 线程，11.8 GB 内存，一块 234 GB 的系统盘，另外还挂着两块盘。它跑着五个 Docker 容器、一个 VPN 守护进程和一个本地模型服务，一点也不吃力。

```console
$ nproc; lscpu | grep -E 'Model name|^CPU\(s\)'
8
Model name:          Intel(R) Core(TM) i7-8550U CPU @ 1.80GHz
CPU(s):              8
$ free -m | awk '/Mem:/{print $2" MB total, "$3" MB used"}'
11833 MB total, 8832 MB used
$ df -h /
Filesystem              Size  Used Avail Use% Mounted on
/dev/mapper/cryptroot   234G  152G   70G  69% /
```

所以一套家用服务栈的真实需求很有限，也很好说清楚：

- **算力：** 一个现代核心，就够跑静态站点、几个容器和一个 VPN。两到四个核心，能给你跑 CI 任务或构建的余量。
- **内存：** 4 GB 已经很宽裕，8 GB 很舒服。博客主机在不到 100 MB 里完成全部工作。
- **存储：** 几百 GB 的 SSD。真正需要 TB 级容量的只有影音库，而那是另一种爱好。
- **备份：** 在机器之外、经过验证、平淡无奇。这是人们最容易跳过、然后后悔的需求。
- **网络：** 你本来就有的路由器。VPN 守护进程只有几 MB，不需要单独一台机器。

## 真正便宜又好用的东西

**一台二手迷你主机。** 退役的第六到第八代 Intel 迷你主机（就是二手市场上大量出现的小型办公机）是最佳平衡点。现实的价位区间是机器 **¥800–1,500**，500 GB SSD **¥250–450**——价格因地区和时机差别很大，所以请按本地行情判断，别轻信任何一个数字，包括我给的。它待机约 8–12 W，安静，小到可以放在架子上。

**一块 SSD。** 买你今年会用到的容量。一块 500 GB 盘能装下的容器、镜像和笔记，比大多数人一辈子会创建的还多。

**UPS 是可选项。** 如果你的供电稳定，迷你主机能安然度过短暂断电——静态站点不在乎，多数服务也会自行恢复。如果你经常遇到电压不稳，或者机器在做对写入敏感的事，一台小型在线互动式 UPS（大约 ¥200–400）是值得的。它是保险，不是必需品。

**一块 Pi 干一件事。** 单板计算机恰好擅长一件事：几乎不耗电地长期在线（5 W 级别）。DNS 拦截、VPN 端点、小型的在线监测。它不是通用服务器，你也不该假装它是。

**你本来就有的旧笔记本。** 这是清单上最便宜的家用实验室：**硬件成本 ¥0**，因为沉没成本早就沉没了。笔记本甚至还自带 UPS（电池）和一块用于配置的屏幕。如果你还不确定自己到底需不需要家用实验室，这就是该先做的实验。

## 对大多数人来说纯属浪费的东西

- **机架。** 你只有一两台机器。一个架子就是机架。机架的存在是为了容纳几十个机箱、管理风道和线缆；在家里，它只会积灰。
- **万兆网（10GbE）。** 你的宽带不是 10 Gb，你的磁盘才是瓶颈，手机的一条串流连 1 Gb 都跑不满。千兆以太网是给一个你并不存在的问题准备的实验室式方案。
- **企业级设备。** 老的 1U 服务器买起来便宜，用起来很贵——见下面的算术。它们还吵到你最后会把它关掉，这又违背了初衷。
- **只跑一个虚拟机的虚拟机管理器。** 虚拟化只有在你要跑多个隔离客户机时才值回它的复杂度。只有一个负载时，你要的是包管理器和 systemd，而不是 hypervisor。我在[《Proxmox 还是纯 Linux》](/zh/posts/proxmox-vs-plain-linux/)里已经论证过这点，上面那份实测栈就是证明：一切都能装进一个普通操作系统里。
- **"以防万一"的冗余容量。** 博客主机用了 **981 MB 里的 84 MB**、**14 GB 里的 8.5 GB**。"以防万一"买来的容量，是你付了钱、供了电、做了散热、还给它做备份、却什么都没换来的容量。按你现有的负载买；二手市场明年还在。
- **从未验证过的冗余。** 一块从未恢复过数据的第二块盘，不叫备份。见下文。

## 真实的三年家用实验室总成本

预算到这一步才见真章。我写了个小脚本，算三年内的**家用实验室总成本**——电费加上硬件摊销——再跟租一台 VPS 做对比。先说两条诚实的免责声明：我手上没有功率计，所以功率数字是**各类硬件的典型标称待机/负载值**；电价是一个**假设**（中国居民第一档电价，约 ¥0.56/kWh；实际费率大致在 ¥0.5–0.6，且因地区和档位而异）。

```js
// 3-year TCO: owning a homelab box vs renting a VPS.
const HOURS_3YR = 3 * 365 * 24;      // 26,280 h
const TARIFF = 0.56;                 // ¥/kWh (assumption)
const kwh  = (w) => w * HOURS_3YR / 1000;
const elec = (w) => kwh(w) * TARIFF;

const scenarios = [                  // name, upfront ¥, avg watts
  ['Used mini PC + SSD (+UPS)',   1200 + 350 + 300, 18],
  ['Used mini PC + SSD (no UPS)', 1200 + 350,       18],
  ['Used 1U enterprise server',   900,              90],
  ['Old laptop (already owned)',  0,                12],
  ['Pi-class board + PSU + SD',   400,               5],
];
```

跑一遍，你得到的是一张真实的表，而不是一种感觉：

```console
Assumptions: 26,280 h over 3 yrs, tariff ¥0.56/kWh

| Setup                        | Upfront | Electricity (3 yr) | TCO (3 yr) | ¥/mo equiv | Elec % |
|------------------------------|---------|--------------------|------------|------------|--------|
| Used mini PC + SSD (+UPS)    | ¥1,850  | ¥265 (473 kWh)     | ¥2,115     | ¥59        | 13%    |
| Used mini PC + SSD (no UPS)  | ¥1,550  | ¥265 (473 kWh)     | ¥1,815     | ¥50        | 15%    |
| Used 1U enterprise server    | ¥900    | ¥1,325 (2365 kWh)  | ¥2,225     | ¥62        | 60%    |
| Old laptop (already owned)   | ¥0      | ¥177 (315 kWh)     | ¥177       | ¥5         | 100%   |
| Pi-class board + PSU + SD    | ¥400    | ¥74 (131 kWh)      | ¥474       | ¥13        | 16%    |
| VPS at ¥20/mo                | ¥0      | — (included)       | ¥720       | ¥20        | —      |
| VPS at ¥40/mo                | ¥0      | — (included)       | ¥1,440     | ¥40        | —      |
| VPS at ¥60/mo                | ¥0      | — (included)       | ¥2,160     | ¥60        | —      |

Payback vs "mini PC, no UPS" (¥1,550 upfront, ~¥7.4/mo in power):
  vs VPS ¥20/mo: 123 months (10.2 yrs) — beyond the 3-yr window
  vs VPS ¥40/mo:  47 months (4.0 yrs)  — beyond the 3-yr window
  vs VPS ¥60/mo:  29 months (2.5 yrs)
```

<figure>
<svg viewBox="0 0 760 250" role="img" aria-label="三年总持有成本，按硬件、UPS 与电费堆叠" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">
  <text x="0" y="20" fill="currentColor" font-size="13" font-family="ui-monospace,monospace">3-year TCO — where the money goes</text>
  <g font-size="12" font-family="ui-monospace,monospace" fill="currentColor">
    <text x="160" y="66" text-anchor="end">Mini PC (owned)</text>
    <text x="160" y="128" text-anchor="end">1U server</text>
    <text x="160" y="190" text-anchor="end">VPS ¥40/mo</text>
  </g>
  <rect x="170" y="46" width="295" height="32" fill="#0f766e"/>
  <rect x="465" y="46" width="57" height="32" fill="#0f766e" opacity="0.5"/>
  <rect x="522" y="46" width="50" height="32" fill="currentColor" opacity="0.3"/>
  <rect x="170" y="108" width="171" height="32" fill="#0f766e"/>
  <rect x="341" y="108" width="252" height="32" fill="currentColor" opacity="0.3"/>
  <rect x="170" y="170" width="274" height="32" fill="currentColor" opacity="0.18"/>
  <g font-size="12" font-family="ui-monospace,monospace" fill="currentColor">
    <text x="580" y="66">¥2,115</text>
    <text x="601" y="128">¥2,225</text>
    <text x="452" y="190">¥1,440</text>
  </g>
  <g font-size="11" font-family="ui-monospace,monospace" fill="currentColor">
    <rect x="170" y="224" width="12" height="12" fill="#0f766e"/>
    <text x="188" y="234">hardware</text>
    <rect x="270" y="224" width="12" height="12" fill="#0f766e" opacity="0.5"/>
    <text x="288" y="234">UPS</text>
    <rect x="340" y="224" width="12" height="12" fill="currentColor" opacity="0.3"/>
    <text x="358" y="234">electricity</text>
  </g>
</svg>
<figcaption>在 ¥0.56/kWh 下，电费只占迷你主机家用实验室的约 13%——但同样的事用一台二手 1U 服务器来做，电费占 60%。硬件是一次性成本；瓦特是永远的。</figcaption>
</figure>

## 电费成本的算术

公式简单到不能再简单：`瓦特 × 小时 × ¥/kWh`。三年就是 `瓦特 × 26,280 ÷ 1000 × 0.56`。从中能得出两件任何购物清单都不会告诉你的事：

1. **在中国的居民电价下，迷你主机的电费并不是最大的一笔。** 18 W × 26,280 h = 473 kWh = 三年 ¥265——约占总成本的 13%。硬件才是大头。
2. **一旦你买错硬件，或者住在电价贵的地方，电费立刻变成最大的一笔。** 一台待机 90 W 的二手 1U 服务器，三年烧掉 2,365 kWh = ¥1,325——**占它总成本的 60%**，比买机器本身还贵。如果电价更高，比如 ¥1.00/kWh，同一台迷你主机的电费几乎翻倍到 ¥473，服务器则飙到 ¥2,365。

所以"电费往往是最贵的成本"这句话，诚实的版本是：它是那笔**永远不会停**的成本，也是那笔惩罚"看起来便宜"的交易的成本。一台 ¥900 的服务器，如果运行要花 ¥1,325，它就不是一台 ¥900 的服务器。当人们说家用实验室很贵时，他们通常说的是瓦特。

## 迷你主机家用实验室 vs VPS

这个取舍，人们会在两个方向上同时搞错。看三年：

- 一台**预算型 VPS**（¥20–40/月）往往比买一台新迷你主机*更便宜*。按 ¥40/月算，三年是 ¥1,440——低于迷你主机的 ¥2,115——而且你从不碰硬件、从不听风扇、从不断电。按上面的脚本，回本点大约在 ¥40/月下的**四年**，以及 ¥60/月下的约 **2.5 年**。
- **迷你主机家用实验室**在你本来就拥有硬件时胜出（旧笔记本那一行：总共 ¥177），在你需要的 VPS 很贵时（内存或 CPU 超出 ¥40 套餐给的范围），在你需要本地存储或 GPU 时，或者你就是想拥有它时胜出。

大多数人该听到的务实答案是：**面向公网的部分租一台便宜的 VPS，实验部分用你本来就有的机器。** 这差不多就是我做的——博客跑在那台便宜的机器上，实验跑在笔记本上。我刻意保持一份很短的 2026 年自托管清单；清单之所以短，是因为最便宜的服务栈，就是你需要维护得最少的那个。

## 诚实的建议

- **从能解决你问题的最小东西开始。** 通常就是一台 VPS 或你已有的笔记本。等某个地方真的痛了再升级，而不是提前升级。
- **在买更多之前先备份。** 一台镜像着一块没有备份的盘的第二台机器，是同一个错误的两个副本。先让一份经过验证、在机器之外的备份跑起来。
- **先买第二块盘，再买第二台机器。** 数据的冗余胜过算力的容量。镜像你真正在乎的那块盘，比多一个跑容器的节点更值。
- **升级之前先测量。** 跑一下 `free -m`、`df -h`、`ps aux --sort=-%mem`。如果你只用了 981 MB 里的 84 MB，那你的问题不是内存。上面那些数字，正是我没有买更大机器的原因：我没法拿真实测量去为它辩护。

## 这个博客自己的服务栈到底用了多少

所以整个要点，再平实地测一遍：

| | 博客主机 | 开发笔记本 |
|---|---|---|
| CPU | 1 vCPU | i7-8550U，4 核 8 线程 |
| 内存 | 981 MB（已用 84 MB） | 11.8 GB |
| 磁盘 | 14 GB（已用 8.5 GB） | 234 GB 系统盘 + 2 块盘 |
| 服务 | nginx、easytier、vaultwarden、MariaDB、SMTP、同步——共约 39 MB | 5 个容器 + VPN + 本地模型 |

这个博客用**不到 100 MB 的内存**，提供两种语言的 254 篇文章、一条 OG 图片流水线和一个 VPN 端点。你可能会看到它的负载均值偏高（我查看时是 3.09），那是当时刚好在跑一次 Astro 构建，不是稳态——这本身就是教训：要在正确的时刻测量，否则你会为了修复一个只持续九十秒的尖峰而买硬件。

预算有限的家用实验室，不是一个缩小版的数据中心。它是这样一种觉悟：大多数家用负载都很小；二手市场卖着完全够用的小机器；真正会不断累积的成本是电费——所以买小、买二手，把省下的钱花在一块备份盘上。
