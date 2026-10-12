---
title: "homelab 里的 BGP：BIRD、FRR，以及该走多远"
description: "一篇务实的 BGP homelab 指南：BGP 这个协议到底在做什么，什么时候 multi-homing、ISP 故障切换，或者你自己的 IPv6 PI space 才值得上它，BIRD 与 FRR 的现实选项，你必须先搞懂的概念（AS、prefix、local-pref、路由过滤），一份最小的可用配置，以及一个坦诚的建议。"
pubDate: 2026-12-02
lang: zh
translationKey: bgp-for-homelab
tags: [networking, linux, homelab]
featured: false
keywords:
  - BGP homelab
  - BIRD
  - FRR
  - 多宿主（multi-homing）
  - 路由过滤（route filtering）
---

BGP 是把整个互联网粘在一起的那套协议：网络之间互相告诉对方，自己能到达哪些 IP
前缀、该优先走哪条路径，一个自治系统接着一个。大多数人想搞 **BGP homelab**，其实
根本不需要它，这话我先说在前面。但确实有一小撮很实在的理由，会让你在家里跑
BGP——跨两个 ISP 做 **multi-homing（多宿主）**、一条链路挂掉时自动故障切换，或者宣告
你自己的 IPv6 **PI space**——如果你正属于这一类，那么实际能用的工具，就是在你已经有的
路由器上跑 **BIRD** 和 **FRR**。这篇文章讲：BGP 到底是什么、homelab 能从它这儿得到
什么、动手宣告之前必须先搞懂哪些概念、一份极小的可用配置，以及一个坦诚的答案——
该走多远。

## BGP 到底是什么

BGP（Border Gateway Protocol，边界网关协议）是一种**路径向量（path-vector）**
协议，它的工作是在**网络之间**交换可达性，而不是在一个网络内部计算最短路径。每一个
独立的网络就是一个**自治系统（AS，autonomous system）**，用一个 **AS 号（ASN）**
标识——ISP、云厂商、大学，这些都是 AS。你家里的网络几乎肯定不是：它只是一个挂在单一
ISP 下面、拿一条默认路由的 stub。

BGP 就是这些 AS 之间互相说"我能到达 `203.0.113.0/24`，到达它要经过这样一条 AS
path"的方式。有两件事会让从 OSPF 过来的人感到意外：

- **它是策略，不是算术。** OSPF 选拓扑允许的最短路径。BGP 选的是**你叫它优先走**的
  那条，靠各种属性实现。一个属性设错，就会在每条链路都还显示"up"的时候，把一个前缀
  打进黑洞（blackhole）。
- **它是组织之间的信任。** 你不只是在算路由，你是在决定"相信谁的宣告"。这一步做错，
  你要么宣告了别人的地址段，要么接受了伪造的路由——这正是 BGP 劫持（BGP hijack）的
  本质。

BGP 有两种形态。**eBGP** 跑在不同 AS 之间——那就是互联网。**iBGP** 跑在同一个 AS
内部的路由器之间，把从外部学到的路由互相传递。内部这一种，才是大多数 homelab 里出现
的那种，而且很能说明问题的是——Kubernetes 里也在用：Calico 和 Cilium 都用 BGP 在
节点之间分发 pod 和 service 路由。

## 什么样的 BGP homelab 值得上：multi-homing、故障切换与 PI space

三个真实的理由，大致按适用人数从多到少排列。

### 跨两个 ISP 做 multi-homing

有两条线路时——光纤加一个 5G modem，或者两家运营商——最朴素的做法是把所有流量都从一条
链路出去，只有当它彻底断了才切到另一条。这很脆弱：只要链路是 **up 的**、但它后面的路径
已经不通了，这套就失效。用 BGP 做 **multi-homing** 才是真正的版本。每家运营商给你一条
会话，你把自己的前缀同时宣告给他们两家，由协议来决定入向和出向流量各走哪条路径。当一条
会话断掉，路由被撤销，流量就自动切过去。

有两个坑我不打算藏着。第一，只有当你要宣告的前缀是**你自己的**时，multi-homing 才能端到
端生效；某家运营商给你的地址段，你没法拿去向另一家宣告。第二，BGP 的收敛是几秒到几十秒，
不是瞬时，而且前提是两边都配置正确。

### 你自己的 IPv6 PI space

这是最干净的理由。**PI（provider-independent，独立于运营商）**地址空间——现实中就是
你的区域互联网注册机构（RIR）给你的一个 IPv6 `/48` 或 `/40`——可以从你想用的任何一家
运营商宣告出去，于是换 ISP 不用重新编址任何事情。这就是 PI 的全部意义：地址是你的，任何
接受你宣告的地方都能路由过来。IPv4 想做到同样的事几乎不可能，因为免费池早就枯竭，一个
公网 IPv4 `/24` 在转让市场上是真金白银；而 IPv6 这基本就是走个形式。

### OSPF 还是 BGP：怎么选

这个选择与其说看规模，不如说看**你在哪两者之间做路由**：

- **静态路由**在它不成立之前都是对的。对一个只有一条上行、几个子网的 stub 来说，静态
  就是诚实的工程。别为了用 BGP 而用 BGP。
- **OSPF** 是**内部**网关协议：单一链路状态域、单一组织、收敛快、算最短路径。用它做你
  网络**内部**的路由——你的 VLAN、你的 lab 子网、你的 overlay 节点。它默认大家在同一个
  团队里。
- **BGP** 是**外部**网关协议：组织之间的策略、路径属性、对你接收和宣告什么有明确控制。
  用它来做你和运营商**之间**，或者当你真正需要策略（local-pref、communities）而不是
  最短路径的时候。

诚实的规则是：**内部用 OSPF，边缘用 BGP。** 大多数 homelab 两者都不需要；而需要 BGP
的那些，也只为恰好一条链路需要它——通向外面的那一条。

<figure>
<svg viewBox="0 0 640 236" width="100%" role="img" aria-label="两家上游 ISP 通过 transit 链路连到一台跑 BGP 的路由器，这台路由器持有自治系统号，并把三个前缀同时宣告给两家运营商。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="40"  y="18" width="150" height="50" rx="6"/>
    <rect x="450" y="18" width="150" height="50" rx="6"/>
    <rect x="190" y="110" width="260" height="66" rx="6"/>
    <rect x="70"  y="196" width="150" height="34" rx="6"/>
    <rect x="245" y="196" width="150" height="34" rx="6"/>
    <rect x="420" y="196" width="150" height="34" rx="6"/>
    <path d="M115 68 C115 95 280 90 280 110"/>
    <path d="M525 68 C525 95 360 90 360 110"/>
    <path d="M280 176 L145 196"/>
    <path d="M320 176 L320 196"/>
    <path d="M360 176 L495 196"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="115" y="40" text-anchor="middle">ISP A</text>
    <text x="115" y="56" text-anchor="middle" opacity="0.75">transit</text>
    <text x="525" y="40" text-anchor="middle">ISP B</text>
    <text x="525" y="56" text-anchor="middle" opacity="0.75">transit</text>
    <text x="320" y="134" text-anchor="middle">你的路由器 — BIRD / FRR</text>
    <text x="320" y="152" text-anchor="middle" opacity="0.75">你的 AS（例如 AS64512）</text>
    <text x="320" y="168" text-anchor="middle" opacity="0.75">local-pref 决定走哪条</text>
    <text x="145" y="217" text-anchor="middle">203.0.113.0/24</text>
    <text x="320" y="217" text-anchor="middle">2001:db8::/32</text>
    <text x="495" y="217" text-anchor="middle">10.0.0.0/8</text>
  </g>
</svg>
<figcaption>multi-homing 在路由层的样子：一台路由器、一个自治系统、两家上游，以及它同时宣告给两家的那些前缀。决定流量走哪条路径的是 local-pref，而不是运气。</figcaption>
</figure>

## BIRD 与 FRR：现实中的几种选择

真正在家里跑 BGP 的方式有三种。

**1. 在你自己拥有的路由器上跑 BIRD 或 FRR。** 这是主流。**BIRD** 小巧、快，配置语言
干净利落；它能跑在 OpenWrt、树莓派、任何一台 Linux 机器上。**FRR**（Free Range
Routing）是用户态的 Cisco 风格协议栈：你在数据中心里会遇到的那套语法、非常庞大的
功能集，以及与 Linux 内核多路径路由的良好集成。如果你已经在跑一台 Linux 路由器或者
OPNsense，装上其中一个，加一条会话就行。

**2. 把 BGP 当作 overlay 的控制平面。** 用这个协议不需要公网地址，也不需要 ASN。
mesh VPN 和容器网络用 BGP 在**隧道内部**分发路由：每个节点宣告自己能到达的子网，由
overlay 在它们之间做路由——和你 Kubernetes 里 pod 网络是同一个思路。这是把 BGP 当作
**内部**机制来用，非常实用，也是不碰任何注册机构就能学习它的好办法。如果难的是隧道本身，
机制在[《NAT 穿透到底是怎么工作的》](/zh/posts/nat-traversal-explained/)里；一个具体的
overlay 例子在[《用 EasyTier 搭一张私有 mesh VPN》](/zh/posts/private-mesh-with-easytier/)
里。

**3. 通过隧道把 BGP 接到一个公网 ASN 上。** 这是"真实互联网"那条路：拿到一个 ASN 和
PI space，然后和一家运营商建立对等——通常是通过一条通向某台已经有完整 BGP 全表的 VPS 的
WireGuard 或 GRE 隧道，再借助一个愿意替你宣告前缀的服务。它行得通。但难度也正是集中
在这里。

### 申请 ASN 和 PI space 到底有多难

这部分很多人一笔带过；我不。要想向全球互联网宣告，你通常需要凑齐这些东西：一个
**ASN**、**PI space**（一个 IPv4 `/24`，或者通过一家保荐 LIR 从你的 RIR 拿到的 IPv6
`/48`+），以及至少一家愿意承载你路由的**transit 运营商或隧道代理商**。每一样都有成本
和文书工作：ASN 加 IPv6 PI 通过大多数 LIR 一年要几百美元，而一个公网 IPv4 `/24` 在公开
市场上是几千美元。有些注册机构不直接分配给个人，所以你得通过一家 LIR。然后还得有人
真的接受你的路由——而他们愿意给出这份信任，是因为你现在已经握住了全球路由表的一小块。
这不是一个周末就能搞完的项目，也不免费。

## 你必须先搞懂的概念

五个概念干了大部分活。跳过它们，你会造成一次故障——你自己的，或者，如果错得足够离谱，
别人的。

- **AS、ASN 与 prefix。** **AS** 是一个管理域；**ASN** 是它的编号；**prefix（前缀）**
  是你宣告的地址块。你从某个 ASN 宣告前缀。第一件要刻进脑子的事：只宣告你有权宣告的
  前缀。
- **peering 与 transit。** **transit（转接）**是指有人收你钱，把你的流量带到整个互联
  网；**peering（对等）**是指两张网络因为双方都获益而互相交换路由，通常不涉及付费。
  家里的部署几乎总是买 transit，或者用隧道代理商，而不是真正意义上的对等。
- **local-pref。** 你会用得最多的属性：值越大越优先，而且它是**本地**决定——它操控你的
  **出向**流量，所以把你想优先那家运营商学来的路由的 `local-pref` 调高即可。这个不对称
  会咬人：**入向**流量走的是你邻居看到的 AS path 长度，那个你只能靠不同的宣告方式去
  影响（prepend、communities）。
- **communities。** 挂在路由上、在网络之间携带含义的标记值（"别把这个宣告给我的对端"、
  "prepend 两次"）。运营商都会公布自己的 community 列表；你在导出时贴上它们，来影响
  你的前缀被如何对待。它们是约定，不是标准——去读你运营商的文档。
- **路由过滤（route filtering），以及为什么你必须过滤。** 这条没有商量余地。**过滤你
  接收的：** 拒绝 bogon 和 martian（私有、回环、组播、未分配段），拒绝 AS path 里已经
  包含你自己 AS 的路由（那是环路），拒绝任何比你预期更具体的前缀。**过滤你宣告的：**
  只宣告你自己的前缀——永远不要宣告默认路由，永远不要宣告运营商的地址段。不做过滤的
  BGP，就是把一次配置错误变成一次全球性事故的途径。你的运营商也应该过滤你，但别假设
  他们一定做了。

## 一个极小的 BIRD 本地实验

你不需要公网 ASN 就能学会这一切，在一台 Linux 机器上用两个 network namespace 就行
——正是我[那篇 network namespaces 与 veth](/zh/posts/network-namespaces-and-veth/)里
用的技巧。一条 `veth`，两边各跑一个 BIRD，两个私有 ASN。下面是一侧最小可用的 BIRD 2
配置，它的过滤不是摆设：

```ini
# /etc/bird/bird.conf —— 双 namespace 实验里的一侧
router id 192.0.2.1;

protocol device {}

protocol direct {
  ipv4;                # 学习直连子网，供我们宣告
}

# 允许发给邻居的东西：只有我们自己的地址段
filter own_out {
  if net ~ [ 10.10.0.0/16{16,24} ] then accept;
  reject;
}

# 我们愿意相信邻居的东西
filter sane_in {
  # 拒绝 bogon / 私有 / 默认 / 组播
  if net ~ [ 0.0.0.0/0, 10.0.0.0/8, 127.0.0.0/8,
              169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16,
              224.0.0.0/4 ] then reject;
  # 拒绝 AS path 里已经出现过我们自己 AS 的路由：环路
  if bgp_path ~ [ = 64512, * = ] then reject;
  accept;
}

protocol bgp peer_lab {
  local 192.0.2.1 as 64512;
  neighbor 192.0.2.2 as 64513;
  ipv4 {
    import filter sane_in;
    export filter own_out;
    next hop self;
  };
}
```

把它跑起来，看看协议做出了什么决定：

```console
$ sudo birdc configure
$ sudo birdc show protocols all peer_lab   # 会话状态、收发的路由
$ sudo birdc show route                     # RIB，带 AS path
$ ip route show proto bird                  # BIRD 推进内核的那部分
```

最后两行才是重点：通过 BGP 学到的路由进入 BIRD 的 RIB，而 BIRD 选中的那些被安装进内核
的 FIB。这个拆分——控制平面做决定，数据平面做转发——就是完整的心智模型。

## 同一件事的 FRR 写法

同样的策略用 FRR 写出来是这样。prefix list 控制你宣告什么，route-map 在导入时设置
`local-pref`：

```
router bgp 64512
 bgp router-id 192.0.2.1
 neighbor 198.51.100.1 remote-as 64500
 neighbor 198.51.100.1 description isp-a
 address-family ipv4 unicast
  neighbor 198.51.100.1 route-map ISP-A-IN in
  neighbor 198.51.100.1 route-map OWN-OUT out
 exit-address-family
!
route-map ISP-A-IN permit 10
 set local-preference 200
!
ip prefix-list OWN seq 10 permit 10.10.0.0/16 le 24
route-map OWN-OUT permit 10
 match ip address prefix-list OWN
```

对 ISP A 学来的一切设 `local-preference 200`，意味着只要它的会话还在，出向流量就优先
走 A；一旦 A 掉线，它的路由消失，B 就自动胜出。这一行，基本就是"multi-homing 故障切换"
的全部含义。

## 坦诚的建议：该走多远

**大多数 homelab 根本就不该跑 BGP。** 一条上行、几个子网：用静态路由或者 OSPF。要配置
的东西更少，能弄坏的东西更少，而且你也没有故障切换可赚——因为压根没有可切换的对象。
在单 ISP 的网络里加 BGP 是爱好，不是工程——只要你把它称作爱好，那就是个很好的理由。

**内部跑 OSPF（或者继续用静态），只有当你真正 multi-homing 时才去够 BGP。** 两条真实
上行加自动故障切换，或者一个应当在换 ISP 后依然存活的 IPv6 PI 前缀：BGP 就是对的工具，
而且这是它唯一一个能回本的情形。两条会话、狠狠过滤、用 `local-pref` 挑个偏爱的——这就是
一个完整的设计。

**在碰任何公网的东西之前，先在 lab 里学会它。** 上面那个 namespace 实验免费、可回滚，
并且教你所有要紧的概念。只有当你确实想向互联网宣告时，才去申请 ASN 和 PI space——那时
你握住的是一块全球路由。隐藏成本也要知道：每年都要交的钱、一个替你承载路由的运营商，以及
两个方向都必须过滤，否则你就成了下一个关于 BGP 劫持的反面教材。

## 一句话总结

BGP 是在自治系统之间交换前缀的路径向量协议，而且它是由策略驱动的，这一点 OSPF 永远
不是。homelab 想要它无非三个诚实的理由：跨两个 ISP 做 **multi-homing**、宣告你自己的
IPv6 **PI space**，或者想学互联网到底怎么路由。实际用的工具是 **BIRD** 和 **FRR**；
把 BGP 用在 overlay 上则完全不需要 ASN。在你宣告任何东西之前，先搞懂 AS/ASN、peering
与 transit、**local-pref**、communities，尤其是**路由过滤**。对大多数人来说，答案就是
内部用静态或 **OSPF**、完全不碰 BGP；只有当你确实 multi-homing、或者就是想学时，才去跑
BGP——而那种情况下，先在一个 namespaces 实验里把它学会。
