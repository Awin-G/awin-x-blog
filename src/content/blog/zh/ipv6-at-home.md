---
title: "IPv6 家庭网络：一步步把 IPv6 跑起来（运营商、路由器、防火墙、DNS）"
description: "一篇把 IPv6 家庭网络跑通的实操指南：先确认运营商真的做了前缀委派，再让路由器用 SLAAC 通告一个 /64，把 IPv6 防火墙收紧成默认拒绝入站，配好 AAAA 记录，并排查一条残缺 IPv6 路径造成的卡顿。"
pubDate: 2026-11-25
lang: zh
translationKey: ipv6-at-home
tags: [networking, self-hosting, linux]
featured: false
keywords:
  - IPv6 家庭网络
  - IPv6 防火墙
  - 前缀委派
  - SLAAC
  - 双栈
---

在家里打开 IPv6，名声一直不太好：半吊子支持它的运营商、带三种 DNS 模式却没有文档的路由器，还有一个悄悄把整个互联网放进来的防火墙。其实没必要这么复杂。把一个 **IPv6 家庭网络**跑起来就四步——确认运营商真的给了你一段前缀、让路由器把它通告出去、把 **IPv6 防火墙**收紧、修好 DNS。我在三个不同的运营商上做过这件事，每一次出问题都落在这四步里的某一步，从来不是什么玄学。这篇就是我当年想要的那份从头到尾的走查，从光猫往外捋。

如果你还不熟这套记号法，先看我那篇[动手版 IPv6 教程](/zh/posts/ipv6-practical-intro/)；这里我假定你知道 `/64` 是什么，只关心怎么把东西真正路由通。跟着做时，可以用 [IPv6 计算器](/zh/tools/ipv6/)展开任何一个地址。

## 运营商到底给不给你 IPv6？先查前缀委派

在动路由器之前，先搞清楚运营商给了你什么。大多数会给一段**前缀委派**（PD）：一个通过 PPPoE 或 DHCPv6 链路路由到你这边、通常是 `/56` 或 `/48` 的地址块。少数只给一个 `/64`（够一个局域网用，做分段就没戏了），还有些什么都不给。

最省事的测试，是把一台笔记本直接插到光猫/ONT 上，自己开口去要一段前缀：

```bash
# 直接问运营商的 DHCPv6 服务器愿意委派什么。
# Debian/Ubuntu：
sudo apt install wide-dhcpv6-client || sudo dnf install dhcp-client
sudo dhclient -6 -P -v eth0      # -P = 要一段前缀，而不是只要一个地址

# 或者看看路由器已经拿到了什么。找 /56 或 /48：
ip -6 addr show scope global
ip -6 route show | grep -v fe80
```

如果 WAN 上出现像 `2001:db8:1234:5600::1/64` 这样的全局地址，说明运营商至少给了一个 `/64`。如果 `dhclient -6 -P` 打印出长度为 56 或 48 的 `ia-pd` 块，那你就有了搭一个带分段的**IPv6 家庭网络**的空间。如果什么都没打印、直接超时，那你的运营商就是纯 IPv4，或者你得去账户门户里把 IPv6 打开——有些运营商默认是关着的。

一句话记重点：要看**委派前缀长度是 56 或 48，并且有一条经由运营商链路本地网关的默认路由**（`ip -6 route show default`）。这两样都在，运营商这头就算完事，剩下的都是你自己的活。

## 路由器这头：前缀委派、RA，以及 SLAAC 与 DHCPv6 之别

路由器有两个职责，把它们搞混正是大多数家庭网络出问题的地方。

**WAN 侧——把前缀要过来。** OpenWrt 里这是 `wan6`，协议选 *DHCPv6 client*，"Request IPv6-prefix of length" 设成 *Automatic*（或 `56`）。OPNsense 里叫 *WAN / DHCP6*，勾上 "Request only an IPv6 prefix"。跳过这一步，路由器只有一个 WAN 地址，没有东西可以分给局域网，于是所有客户端都留在 IPv4。

**LAN 侧——通告一个 /64。** 这是**路由器通告**（RA）的职责，而这里你要在 **SLAAC** 和 DHCPv6 之间做选择：

- **SLAAC**（RFC 4862）：路由器在 RA 里通告 `prefix::/64`，每台主机自己拼出地址。零状态、无租约，Android 也支持。这是正确的默认选择。
- **DHCPv6（无状态，"SLAAC + 其它信息"）**：主机仍旧靠 SLAAC 自配地址，但从 DHCPv6 取 DNS 服务器和其它选项。大多数家用路由器实际就是这么干的，由 RA 的 **O** 标志决定。
- **DHCPv6（有状态）**：路由器记录每一个地址。需要集中记账、或者必须下发固定地址时有用；在家里属于杀鸡用牛刀。

RA 里带着你会在 `rdisc6` 输出中看到的标志位：**M**（managed——用 DHCPv6 取地址）和 **O**（other——用 DHCPv6 取选项）。对家用局域网来说，"地址走 SLAAC、DNS 走 DHCPv6" 就是 M=0、O=1 这个甜点。

<figure>
<svg viewBox="0 0 640 150" width="100%" role="img" aria-label="运营商通过前缀委派把一段前缀交给路由器，路由器再通过路由器通告向局域网通告一个 /64，防火墙挡在地处全局可路由的主机前面。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="8"   y="52" width="104" height="46" rx="6"/>
    <rect x="168" y="34" width="132" height="82" rx="6"/>
    <rect x="356" y="52" width="120" height="46" rx="6"/>
    <rect x="532" y="34" width="100" height="82" rx="6"/>
    <path d="M112 75 H168" marker-end="none"/>
    <path d="M300 75 H356"/>
    <path d="M476 75 H532"/>
    <path d="M168 116 v10 H300 v-10" opacity="0.4"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="60"  y="72" text-anchor="middle">运营商</text>
    <text x="60"  y="88" text-anchor="middle" opacity="0.75">DHCPv6-PD</text>
    <text x="234" y="70" text-anchor="middle">路由器 / WAN</text>
    <text x="234" y="88" text-anchor="middle" opacity="0.75">拿到 /56</text>
    <text x="234" y="106" text-anchor="middle" opacity="0.75">通告 /64</text>
    <text x="416" y="72" text-anchor="middle">RA + SLAAC</text>
    <text x="416" y="88" text-anchor="middle" opacity="0.75">局域网前缀</text>
    <text x="582" y="70" text-anchor="middle">IPv6 防火墙</text>
    <text x="582" y="88" text-anchor="middle" opacity="0.75">主机</text>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" opacity="0.8">
    <text x="140" y="26" text-anchor="middle">前缀委派</text>
    <text x="328" y="26" text-anchor="middle">路由器通告</text>
  </g>
</svg>
<figcaption>通往一个可用 IPv6 家庭网络的路径：运营商委派前缀，路由器在局域网上通告 /64，防火墙挡在全局可路由的主机前面。</figcaption>
</figure>

从任意一台客户端验证局域网：

```bash
# 我有没有全局 IPv6 地址？路由器的下一跳是谁？
ip -6 addr show scope global
ip -6 route show default           # 应该指向一个 fe80:: 的链路本地网关
rdisc6 -1 eth0                     # 收一条路由器通告并打印出来
# 找：Prefix 2001:db8:1234:5601::/64、flags M=0 O=1、valid lifetime
```

要回答"我的**路由器通告**到底有没有到？"，`rdisc6` 是最快的办法。如果它什么都不打印，那就是路由器根本没在通告，无论运营商委派了什么，每台客户端都会只剩 IPv4。

## IPv6 防火墙不是可选项：默认拒绝入站

这就是至今仍让很多人意外的地方。你的 IPv4 路由器把整个局域网藏在一个地址后面，于是"什么都没暴露"感觉上是对的，但那只是碰巧。IPv6 没有 NAT：每台主机都有一个**全局可路由地址**，挡在 NAS 和端口扫描器之间的唯一东西就是防火墙。NAT 从来不是安全边界；在 IPv6 上这个"碰巧"没有了，所以你必须刻意把边界造出来。

模型就一句话：**默认拒绝入站，放行 established 与 related，再放行你真正对外提供的少数服务。** 用 `nftables`，一张 `inet` 表同时覆盖 IPv4 和 IPv6：

```nftables
# /etc/nftables.conf —— WAN 入站。仍放行回包，拒绝新的入站连接。
table inet filter {
    chain input {
        type filter hook input priority 0; policy drop;

        ct state established,related accept   # 你发起的连接的回包
        iif lo accept

        ip6 nexthdr ipv6-icmp accept          # 必需——见下文
        ip6 nexthdr tcp dport { 22, 80, 443 } accept
    }
    chain forward {
        type filter hook forward priority 0; policy drop;
        ct state established,related accept
    }
}
```

传统工具上写法一模一样，只是仅限 IPv6：

```bash
# ip6tables 版本，对应大家都需要的那两条放行：
ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A INPUT -p ipv6-icmp -j ACCEPT
ip6tables -A INPUT -p tcp --dport 22 -j ACCEPT
ip6tables -P INPUT DROP
```

别把 IPv4 那套"封掉所有 ICMP"的建议照抄过来。在 IPv6 上，ICMPv6 承载着邻居发现、路由器通告和路径 MTU 发现；把它丢了，网络会以一种看起来随机的方式半死。如果你用的是家用路由器，这项设置通常是"IPv4 防火墙"旁边的一个"IPv6 防火墙"开关——确认它开着，而且关键是要确认入站默认被拒，而不是某些廉价固件出厂就带的"全部放行"模式。

## DNS、AAAA 记录，以及"IPv6 更慢"的迷思

**DNS 永远是同一个故事：留着你的 `A`，加一条 `AAAA record`。** 双栈的意思就是同一条名字上两条记录，由客户端自己挑。

```dns
blog.example.com.   3600  IN  A     203.0.113.7
blog.example.com.   3600  IN  AAAA  2001:db8:1234:5601::7
```

现在说迷思。人们说"IPv6 更慢"，然后跑去跑分，但真正的原因往往是**一条残缺的 IPv6 路径**：路由器下发了全局地址、`AAAA` 记录也存在，可那段前缀其实没被真正路由，或者防火墙误挡了什么。客户端会先试 IPv6，等一个超时，再退回 IPv4——所以你的网络感觉慢，恰恰是因为 IPv6 *只做了一半*。Happy Eyeballs 能遮掉一部分，但遮不掉一条没有 RST 的死路径。

别猜，直接测那条路径：

```bash
ping6 -c 3 2001:4860:4860::8888                  # 走 IPv6 ping 谷歌 DNS
dig +short AAAA example.com                       # 有没有 v6 记录？
curl -6 -sS -o /dev/null -w '%{http_code} %{remote_ip}\n' https://example.com
# 强制只走 v6 并计时。卡好几秒 = 路径坏了，不是"v6 慢"。
time curl -6 -sS -o /dev/null https://example.com
```

如果 `curl -6` 卡住、而 `curl -4` 秒回，那你面对的是一个要修的连通性 bug——不是关掉 IPv6 的理由。诚实的做法是把 v6 修通，或者把 `AAAA` 撤掉；把一条死路径挂着对外发布，是最糟的选择。

## 后面跑一个家庭实验环境：没有 NAT，所以按主机防火墙

分段这件事在 IPv6 上不变，变的是*工具*。没有 NAT，你不再把端口转发到实验机器上——你直接路由到它的真实地址，然后给它配上防火墙。如果你已经在做分段（[家庭网络分段](/zh/posts/home-network-segmentation/)），那么每个 VLAN 从委派前缀里拿走自己的一个 `/64`，规则是按主机写的：

```nftables
# 把实验用的 Web 服务器暴露出去，别的一概不放。
ip6 daddr 2001:db8:1234:5602::10 tcp dport { 80, 443 } accept
# 实验网 -> 信任网是新连接会被丢（上面已有 established 放行回包）。
```

有两点值得内化。第一，**NAT 没了**：没有端口转发、没有"8080 到底转给了哪台机器"、没有 hairpin 那些怪事——无论从互联网还是从你自己的局域网，都是直接访问主机自己的地址。第二，一台你*没有*配防火墙的主机会是可直达的，所以你一加实验子网，就必须同时决定它对外暴露什么。让 [IPv6 防火墙](/zh/tools/ipv6/)策略按主机显式写清楚，你就永远不用猜。

## 排障：没有 RA、前缀不对、CGNAT 与 IPv6-only

出问题时，几乎总是下面这几种：

- **客户端没有全局地址。** 在客户端上 `rdisc6 -1 eth0`。没有 RA 就是路由器没在通告——检查 LAN 接口是否分到了委派前缀、RA/SLAAC 是否开启。如果 RA 到了但前缀是 `::/64` 或干脆没有，那就是路由器没拿到 PD。
- **只有 `fe80::` 地址。** 链路本地能用、全局用不了：PD 请求失败了。回头检查 WAN6/DHCPv6 客户端设置和运营商门户。
- **只有一个 /64，你却想分段。** 运营商只委派了一个局域网的分量。你是切不开它的——要么申请更大的前缀（有些运营商申请后会给 `/56`），要么内部路由一段 ULA `fd00::/8`、在出口做 NAT66（下策）。
- **地址看着像公网，却什么都路由不通。** 确认前缀是在哪儿通告的：`ip -6 route show` 里那个委派的 `/64` 应该以已连接路由出现在 LAN 接口上，默认路由经由 `fe80::...`。
- **CGNAT 与 IPv6-only。** 有些运营商在 IPv4 上跑 **CGNAT**（你和别人共用一个公网地址），把真正的可达性押在 IPv6 上——对他们来说 IPv6 不是可选，而是唯一能被访问到的方式。另一个极端是 **IPv6-only** 接入网，用 NAT64/DNS64 去访问 IPv4 目的地；在那里 `AAAA` 正常、`A` 要过一层翻译，纯 IPv4 的应用会挂。排 DNS 之前，先搞清楚自己在哪个世界。

## 一句话收尾

**IPv6 家庭网络**就是四个刻意的动作。确认运营商的**前缀委派**——一个 `/56` 或 `/48`，外加一条经由链路本地网关的默认路由。让路由器去要那段前缀，并用 **SLAAC**（DNS 交给 DHCPv6）通告一个 `/64`。打开一个真正**默认拒绝、放行 established 的 IPv6 防火墙**，因为现在每台主机都是全局可路由的。在你的 `A` 旁边加一条只在 IPv6 真能应答时才发布的 `AAAA record`，如果感觉慢，先量那条路径再怪协议。这四步做完，剩下的就是安静——而这正是你想要的网络状态。
