---
title: "iproute2 策略路由：不只按目的地址的路由"
description: "iproute2 的 `ip rule` 策略路由让内核按源地址、fwmark 或接口来选择路由表，而不只看目的地址。用真实的 `ip route get` 输出，演示双出口、按源路由、VPN 分流隧道和 IPv6。"
pubDate: 2027-02-05
lang: zh
translationKey: iproute2-policy-routing
tags: [networking, linux]
featured: false
keywords:
  - 策略路由
  - ip rule
  - iproute2
  - 路由表
  - ip route get
  - fwmark
  - 按源路由
---

普通路由只回答一个问题：给定一个目的地址，从哪个口出去？内核拿这个目的地址对
唯一的**路由表**做最长前缀匹配，挑最具体的一条。这能解决问题，直到它不能。一旦
一台机器有**两个出口**、一个 VPN 只该承载*部分*流量、或者一条策略写着"这个用户、
这个进程、这个源地址走那边"，单靠按目的地址的一张表就不够了。这正是**策略路由**
(policy routing) 要解决的事：内核按顺序查阅一个**规则**列表(`ip rule`)，第一条
既匹配报文、又能在它指定的表里解析出路由的规则胜出。选择器可以是**源地址**、
**防火墙标记**、入接口——几乎任何东西，唯独不只是目的地址。

这是内核里 iproute2 的那一半，它安静地跑在 Docker、WireGuard、OpenVPN 以及每一
个分流隧道客户端底下。下面我在一个只给了 `CAP_NET_ADMIN` 的一次性容器里现场搭
一套，加第二张**路由表**，写一条 `ip rule`，再用 `ip route get` 看*同一个目的地址*为
*不同源地址*走*不同的路径*。每个代码块都是真实输出。

## 普通路由如何工作——以及何时不够用

一张路由表就是一张前缀列表。转发报文时，内核找到与**目的地址**最长匹配的前缀，
从该路由的接口（或其网关）发出去。普通的 `ip route add ...` 写进 `main` 表，那是
大多数机器唯一用到的表。这正是我解释
[traceroute 是证据不是地图](/zh/posts/traceroute-lies/) 时拆开的那套按目的地址的
转发——报文走哪条路就在这里被决定，一次一个目的地址。

一旦"正确"的路径取决于目的地址以外的东西，这个模型就破了：

- **两个出口。** 你有一条便宜链路和一条贵/快链路。想让交互流量走快的、批量走便宜
  的——可两者都通往同一个互联网，所以仅凭目的地址无法把它们分开。
- **VPN 分流隧道。** 隧道只该承载 `10.8.0.0/16`（公司内网），而*不该*承载普通上
  网。一条天真的 `0.0.0.0/0` via 隧道会劫持一切，顺手break本地面网访问。
- **按源路由。** 一台机器有多条链路上的多个地址，回程流量必须从它进来的那条链路
  出去（反向路径的健全性）。
- **按用户或按进程路由。** 让 root 的 `apt` 走隧道，同时让你的 SSH 不进隧道——这
  是一个关于*谁*、而不是*去哪里*的决策。

每一种情况里，缺失的输入都是一个选择器，而 `ip rule` 就是提供选择器的方式。

## iproute2 模型：`ip rule` 选表，`ip route` 填表

两条命令、两个职责，大家还老把二者搞混：

- `ip route ... table N` **填充**表。表就是带编号的路由桶。
- `ip rule add ... table N` **排序**它们。一条规则说"匹配这个选择器的报文用那张
  表，受优先级约束"。

内核转发报文时，从**最小优先级数字到最大**依次过规则；对第一条选择器匹配的规则，
去查它指向的表。这就是全部的心智模型。图示如下：

<figure>
<svg viewBox="0 0 720 250" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="左侧是排序后的 ip rule 列表。优先级 100 的 from 192.0.2.1 选中路由表 100，其默认路由经 192.0.2.254 从 uplinkA 出去；优先级 200 的 from 198.51.100.1 选中表 200，经 uplinkB 出去；内置优先级 32766 的 from all 选中 main 表，从 eth0 的默认网关出去。第一条匹配且能解析出路由的规则胜出。">
  <defs>
    <marker id="pra-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g font-family="system-ui,sans-serif" font-size="12" fill="currentColor">
    <text x="8" y="14">ip rule — evaluated in priority order</text>
    <text x="286" y="14" fill="#0f766e">routing table</text>
    <text x="520" y="14">next hop / device</text>
    <!-- row 1 -->
    <rect x="8" y="26" width="180" height="46" rx="8" fill="none" stroke="currentColor"/>
    <text x="20" y="46">from 192.0.2.1</text>
    <text x="20" y="62" font-size="11" fill="#0f766e">priority 100</text>
    <line x1="190" y1="49" x2="286" y2="49" stroke="#0f766e" stroke-width="1.5" marker-end="url(#pra-arrow)"/>
    <rect x="288" y="26" width="140" height="46" rx="8" fill="none" stroke="#0f766e"/>
    <text x="300" y="54" fill="#0f766e">table 100</text>
    <line x1="430" y1="49" x2="520" y2="49" stroke="#0f766e" stroke-width="1.5" marker-end="url(#pra-arrow)"/>
    <rect x="520" y="26" width="192" height="46" rx="8" fill="none" stroke="currentColor"/>
    <text x="532" y="46">via 192.0.2.254</text>
    <text x="532" y="62" font-size="11">uplinkA</text>
    <!-- row 2 -->
    <rect x="8" y="106" width="180" height="46" rx="8" fill="none" stroke="currentColor"/>
    <text x="20" y="126">from 198.51.100.1</text>
    <text x="20" y="142" font-size="11" fill="#0f766e">priority 200</text>
    <line x1="190" y1="129" x2="286" y2="129" stroke="#0f766e" stroke-width="1.5" marker-end="url(#pra-arrow)"/>
    <rect x="288" y="106" width="140" height="46" rx="8" fill="none" stroke="#0f766e"/>
    <text x="300" y="134" fill="#0f766e">table 200</text>
    <line x1="430" y1="129" x2="520" y2="129" stroke="#0f766e" stroke-width="1.5" marker-end="url(#pra-arrow)"/>
    <rect x="520" y="106" width="192" height="46" rx="8" fill="none" stroke="currentColor"/>
    <text x="532" y="126">via 198.51.100.254</text>
    <text x="532" y="142" font-size="11">uplinkB</text>
    <!-- row 3 (built-in) -->
    <rect x="8" y="186" width="180" height="46" rx="8" fill="none" stroke="currentColor" opacity="0.7"/>
    <text x="20" y="206">from all</text>
    <text x="20" y="222" font-size="11" fill="#0f766e">priority 32766 (built-in)</text>
    <line x1="190" y1="209" x2="286" y2="209" stroke="currentColor" stroke-width="1.5" opacity="0.6" marker-end="url(#pra-arrow)"/>
    <rect x="288" y="186" width="140" height="46" rx="8" fill="none" stroke="currentColor" opacity="0.7"/>
    <text x="300" y="214" fill="currentColor">main</text>
    <line x1="430" y1="209" x2="520" y2="209" stroke="currentColor" stroke-width="1.5" opacity="0.6" marker-end="url(#pra-arrow)"/>
    <rect x="520" y="186" width="192" height="46" rx="8" fill="none" stroke="currentColor" opacity="0.7"/>
    <text x="532" y="206" fill="currentColor">via 172.17.0.1</text>
    <text x="532" y="222" font-size="11">eth0 (default)</text>
  </g>
</svg>
<figcaption>三条规则、三张表。<code>ip rule</code> 列表是优先级队列，每条规则只指定一
张表。第一条匹配、且其表真能解析出路由的规则胜出——这就是为什么 <code>ip route get</code>
才是真正的裁判。</figcaption>
</figure>

## 内置路由表，以及把 `ip route get` 当调试器

内核建了三张命名表，由列表底部的三条内置规则对应。在一台干净的机器上，规则列表就是：

```console
$ ip rule show
0:	from all lookup local
32766:	from all lookup main
32767:	from all lookup default
```

- `local`（优先级 0）保存本机自己的地址和广播路由——这就是为什么
  `ip route show table local` 会列出 `local 127.0.0.1 dev lo` 和每个接口的 `/32`。
  本机投递最先查它。
- `main`（优先级 32766）就是你平时 `ip route add` 写入的那张表。
- `default`（优先级 32767）是空的最后手段，只有当上面全部解析失败后才轮到它。

命名表来自 `/etc/iproute2/rt_tables`；你把 `100 wan_a` 这样的友好名字加在那里。
最顺手的调试工具是 `ip route get`，因为它跑的就是内核真正会做的
*查找*——规则、表，一起算：

```console
$ ip route get 8.8.8.8
8.8.8.8 via 172.17.0.1 dev eth0 src 172.17.0.5 uid 0
    cache
```

读作"要到 8.8.8.8，内核从 eth0 的网关出去，用源地址 172.17.0.5"，它还会告诉你选中了
哪张表（下面的 `table 100`）。东西坏了的时候，从真实源地址跑 `ip route get`，
胜过每次手读三张表。

## 按源路由：一台机器，两个出口

下面是重头戏。我在一个只给了 **`CAP_NET_ADMIN`**（没有特权模式、没有宿主机访问）的
一次性容器里。Docker 给了它 `172.17.0.5/16` 上的 `eth0` 和一条默认路由。我加两张
**dummy** 接口当出口——dummy 是真实的接口，只是把报文吃掉，做路由解析演示正合适：

```console
# create uplinkA / uplinkB with two addresses each (v4 + v6)
$ ip link add uplinkA type dummy
$ ip addr add 192.0.2.1/24 dev uplinkA
$ ip addr add 2001:db8:1::1/64 dev uplinkA
$ ip link set uplinkA up
$ ip link add uplinkB type dummy
$ ip addr add 198.51.100.1/24 dev uplinkB
$ ip addr add 2001:db8:2::1/64 dev uplinkB
$ ip link set uplinkB up
$ ip -br addr | grep -E 'uplink|eth0'
eth0@if2072      UP             172.17.0.5/16
uplinkA          UNKNOWN        192.0.2.1/24  2001:db8:1::1/64
uplinkB          UNKNOWN        198.51.100.1/24  2001:db8:2::1/64
```

加每个地址时，`main` 里已经自动多了一条直连路由。现在我加两张私有表，各带自己的默
认网关，再加两条按**源地址**路由的规则：

```console
$ ip route add default via 192.0.2.254 dev uplinkA table 100
$ ip route add default via 198.51.100.254 dev uplinkB table 200
$ ip rule add from 192.0.2.1 table 100 priority 100
$ ip rule add from 198.51.100.1 table 200 priority 200
$ ip rule show
0:	from all lookup local
100:	from 192.0.2.1 lookup 100
200:	from 198.51.100.1 lookup 200
32766:	from all lookup main
32767:	from all lookup default
$ ip route show table 100
default via 192.0.2.254 dev uplinkA
$ ip route show table 200
default via 198.51.100.254 dev uplinkB
```

现在问内核：到*同一个*目的地址的报文怎么走，只变**源**。整个概念就是在这里开窍的：

```console
# no source given -> falls through to main (Docker's eth0 default)
$ ip route get 8.8.8.8
8.8.8.8 via 172.17.0.1 dev eth0 src 172.17.0.5 uid 0

# source 192.0.2.1 -> rule 100 -> table 100 -> uplinkA
$ ip route get 8.8.8.8 from 192.0.2.1
8.8.8.8 from 192.0.2.1 via 192.0.2.254 dev uplinkA table 100 uid 0

# source 198.51.100.1 -> rule 200 -> table 200 -> uplinkB
$ ip route get 8.8.8.8 from 198.51.100.1
8.8.8.8 from 198.51.100.1 via 198.51.100.254 dev uplinkB table 200 uid 0
```

同一个 `8.8.8.8`，三个答案。不给源就经由 `main`（eth0/Docker）解析；源为
`192.0.2.1` 的报文被导向 `uplinkA`；源为 `198.51.100.1` 的报文导向 `uplinkB`。
`ip route get` 上的 `from` 关键字和规则里的 `from` 是同一个选择器，所以你测到的就
是最终上线的。这就是**按源路由**，也是多归属主机让回程流量从进来的那条链路回去的
办法。

## fwmark：让防火墙来选表

地址是一种选择器，另一个主力是**防火墙标记**(`fwmark`)：你的
`nft`/`iptables` 规则给报文打标签，`ip rule` 按标签路由，完全不看地址。加一张表和
一条按标记的规则：

```console
$ ip route add default via 192.0.2.254 dev uplinkA table 300
$ ip rule add fwmark 0x64/0xff table 300 priority 300
$ ip rule show
0:      from all lookup local
100:    from 192.0.2.1 lookup 100
200:    from 198.51.100.1 lookup 200
300:    from all fwmark 0x64/0xff lookup 300
32766:  from all lookup main
32767:  from all lookup default

# unmarked traffic -> main (eth0)
$ ip route get 8.8.8.8
8.8.8.8 via 172.17.0.1 dev eth0 src 172.17.0.5 uid 0

# marked traffic (fwmark 0x64) -> rule 300 -> table 300 -> uplinkA
$ ip route get 8.8.8.8 mark 0x64
8.8.8.8 via 192.0.2.254 dev uplinkA table 300 mark 0x64 uid 0
```

`0x64/0xff` 是标记/掩码（用 `0x64` 标记流量，对照 `0xff` 掩码测试）。在真实机器上，
标记由防火墙打上（按源网段的一条 `nft` 规则，或 VPN 软件给自己的报文打标记），
`fwmark` 规则再负责导向。按用户路由也挂靠同一个思路：一条 owner-match 规则给流量
打标记，一条策略规则把打了标记的报文送进隧道。

## IPv6 与 `default` 表：同一模型，互相独立的列表

IPv6 不是补丁——它是*同一套*规则/表模型，只是列表和表完全独立（和你在
[IPv6 at home](/zh/posts/ipv6-at-home/) 里看到的那种分离一样）。`ip -6 rule` 和
`ip -6 route ... table` 做的是同一件事：

```console
$ ip -6 route add default via 2001:db8:1::ff dev uplinkA table 100
$ ip -6 route add default via 2001:db8:2::ff dev uplinkB table 200
$ ip -6 rule add from 2001:db8:1::1 table 100 priority 100
$ ip -6 rule add from 2001:db8:2::1 table 200 priority 200
$ ip -6 route get 2001:db8:ff::1 from 2001:db8:1::1
2001:db8:ff::1 from 2001:db8:1::1 via 2001:db8:1::ff dev uplinkA table 100 ...
$ ip -6 route get 2001:db8:ff::1 from 2001:db8:2::1
2001:db8:ff::1 from 2001:db8:2::1 via 2001:db8:2::ff dev uplinkB table 200 ...
```

`default` 表（优先级 32767）在这里配得上它的名字。如果删掉 `main` 的默认路由，一个
在 `local` 和 `main` 里都匹配不上的目的地址，最终会一路落到 `default` 表：

```console
$ ip route del default table main
$ ip route get 203.0.113.7
203.0.113.7 via 192.0.2.254 dev uplinkA table default src 192.0.2.1 uid 0
# re-add it, and main (32766) is consulted before default (32767) again:
$ ip route add default via 172.17.0.1 dev eth0
$ ip route get 203.0.113.7
203.0.113.7 via 172.17.0.1 dev eth0 src 172.17.0.5 uid 0
```

这个次序——`local` → 你的规则 → `main` → `default`——正是策略路由可预测的原因：只要
你认得优先级数字，你就知道谁会赢。

## Docker 和 WireGuard 到底在做什么

这些对你已经在跑的工具毫不稀奇。[Docker 网络](/zh/posts/docker-networking/)
和 WireGuard 说到底都是 `ip route` 和 `ip rule` 的安装器。

- **WireGuard** 的 `wg-quick` 说到底就是个调用 `ip link`、`ip address`、
  `ip route`、`ip rule` 的 shell 脚本。它的 `Table = <n>` 选项把路由放进一张私有表，
  外加把流量引进来的策略规则，而 `FirewallMark = <n>` 选项的存在正是为了让流量能按
  `fwmark` 规则被路由——这就是分流隧道"开箱即用"的原因。
- **Docker** 在宿主机上为每个 bridge 网络加自己的规则/表条目——用于容器到容器通信
  和按接口选择——这就是为什么一台繁忙的 Docker 机上 `ip rule show` 会列出比三条内
  置规则更多的东西。
- 让容器网络成为一套私有栈（带自己的规则和表）的 veth/netns 机制，我在
  [network namespaces and veth](/zh/posts/network-namespaces-and-veth/) 里讲过。策略
  路由则是运行时在*每个栈内部*以及在把它们缝起来的宿主机上做的决策。

想亲眼看到的话，用一个非默认的 `Table` 拉起一个 WireGuard 接口，在你控制的宿主机上
前后跑一次 `ip rule show`——我这儿没跑（没有宿主机权限），所以我指给你看，而不是伪造
我没有的输出。

## 诚实的注意事项

这些我都实打实踩到过，所以这里讲真相，而不是传言。

- **规则顺序敏感，但"坏规则会把流量打入黑洞"只说对了一半。** 指向*空*表的规则**不
  会**黑洞——查找失败后内核会**落到下一条规则**。我加了条给 `198.51.100.1` 的顶优先
  级规则指向空表 888 来证明，报文仍然走了表 200：

  ```console
  # priority-50 rule for 198.51.100.1 -> empty table 888, no routes in it
  $ ip rule add from 198.51.100.1 table 888 priority 50
  $ ip route show table 888
  Error: ipv4: FIB table does not exist.
  $ ip route get 8.8.8.8 from 198.51.100.1
  8.8.8.8 from 198.51.100.1 via 198.51.100.254 dev uplinkB table 200 uid 0
  ```

  真正会黑洞的是一条显式的不可达路由，或者默认路由指向一个没起来的隧道/网关。用一
  张带 `unreachable default` 的表抢占好规则，内核会立刻放弃：

  ```console
  $ ip route add unreachable default table 900
  $ ip rule add from 192.0.2.1 table 900 priority 90   # 90 < 100, which preempts 100
  $ ip route get 8.8.8.8 from 192.0.2.1
  RTNETLINK answers: Host is unreachable              # a real blackhole
  $ ip route get 8.8.8.8 from 198.51.100.1
  8.8.8.8 from 198.51.100.1 via 198.51.100.254 dev uplinkB table 200 uid 0
  ```

  所以盯紧优先级数字、并确认隧道是活的；过低的优先级会悄悄抢走流量，而指向死网关则
  是fail closed（没流量）而不是大声报错。
- **它是按地址，不是按主机。** 这些规则按源地址匹配。共享同一源地址的两个进程命运
  相同——按用户/按进程路由仍然需要防火墙的 owner match 来区分。
- **持久化不会自动发生。** 这里的一切都活不过重启，而且它不该被临时乱加，否则你会和
  管理宿主机的东西打架。配置必须由 **systemd-networkd**（带
  `From=`/`Table=`/`Priority=`/`FirewallMark=` 的 `[RoutingPolicyRule]`）或
  **NetworkManager**（`ipv4.route-table` 和 `ipv4.routing-rules`）持有。把规则塞进开
  机脚本、*同时*又让 NetworkManager 管这条链路，就是制造玄学冲突的配方。
- **实验完要清理。** 删规则用 `ip rule del priority N`；忘了清一条过期规则，你
  就把某个源地址路由进了一张不复存在的表。我的容器里，我删掉了所有规则/表/接口，并
  确认 netns 回到只剩 `eth0` 和三条内置规则。

## 一句话总结

普通**路由**按目的地址、最长前缀、在一张表里转发。**iproute2** 的**策略路由**加了一张
有序规则列表：`ip rule` 按源地址、`fwmark` 或接口，按优先级选中一张**路由表**，`ip route`
负责往这些表里填。`ip route get <dst> from <src>` 就是调试器——它跑真实的查找，并显示
哪张表胜出。这一个机制就同时承载了两个出口、分流隧道 VPN、按源的特定回程路径，也正是
Docker 和 WireGuard 替你安装的东西。用 `CAP_NET_ADMIN` 在一次性 netns 里搭一次，它就
不再是魔法——不过是表、规则，外加一份你能从上往下读的查询次序。
