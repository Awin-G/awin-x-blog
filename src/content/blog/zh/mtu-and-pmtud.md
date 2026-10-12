---
title: "MTU、MSS 与路径 MTU 发现：大包为何悄悄卡死"
description: "一篇讲清 MTU 为什么会在大包上出故障：1500 字节的世界如何被 VPN、overlay、隧道吃掉，分片与 DF 位，MSS clamping 一条能用的 nftables 规则，路径 MTU 发现为何被过滤的 ICMP 毁掉，TLS 握完却卡死的经典症状，以及用 ping -M do、tracepath、tcpdump 的实战排查流程。"
pubDate: 2026-10-25
lang: zh
translationKey: mtu-and-pmtud
tags: [networking, linux]
featured: false
keywords:
  - MTU
  - MSS clamping
  - 路径 MTU 发现
  - 分片
  - PMTUD
  - nftables
  - VPN MTU
  - ICMP
---

有一类网络故障，从来不会表现为连接被拒、ping 超时，也不会在访问小接口的 `curl`
里露头。它的表现是：“SSH 能登进去，但 `scp` 卡住”“API 健康检查通过，文件上传却冻住”
“TLS 握手走完，第一个大的 HTTP 响应就永远停在那”。元凶几乎总是 **MTU**——一条链路能扛
的最大包长——以及本该在大包失败前发现更小值的机制：**MSS clamping** 与 **路径 MTU 发现**。
这是互联网上最无聊、最常被误诊的故障；而只要你记住三个数字，就再也不会在这上面耗掉三小时。

这是一篇讲机制的文章。我按顺序讲：1500 字节的世界为何被封装吃掉、**分片**与 DF 位、
MSS clamping、**路径 MTU 发现**为何在 ICMP 被过滤时崩溃、经典症状，以及一套用
`ping`、`tracepath`、`tcpdump` 和 nftables 的具体排查与修复流程。

## 1500 字节的世界，封装如何把它吃掉

以太网的载荷上限是 1500 字节。这个数字就是 **MTU**（最大传输单元）——一条链路在不分片
的前提下能承载的最大 IP 包长。几乎每一台主机、网卡、交换机和云网络都默认用它，所以多年来
你可以假装整条路径从头到尾都是 1500 字节。

一旦你引入隧道，这个假设立刻不成立。封装会加头，而外层包仍要塞进物理的 1500 字节里，于是
内层包的空间变少了：

```
物理链路 MTU：1500 字节
[ 外层 IP ][ GRE/ESP/UDP/WireGuard ][ 内层 IP 包 ... ]
20 + 8 + 4  = 32 字节开销
=> 内层载荷最多只能 1500 - 32 = 1468 字节，否则外层包超过 1500，需要分片。
```

开销随封装方式变化。IPv4 外层 + WireGuard（UDP 8 + WG 32）一般是 60 字节。IPsec ESP over
IPv4 视模式与算法加约 50–73。GRE over IPv4 是 24。VXLAN（UDP + 8 字节 VXLAN 头）是 50。
叠两层隧道就减去两次。**VPN MTU** 的麻烦其实就是这道算术：隧道接口的 MTU 必须设成物理 MTU
减去封装开销，否则内层网络以为放得下的每个包，出去时要么被分片、要么被丢弃。你在
[从零搭 WireGuard](/zh/posts/wireguard-from-scratch/) 时做的，正是这笔账。

## 分片、DF 位与 IPv6

当一个 IP 包大于链路的 MTU，IPv4 有两个选择：把它**分片**成更小的 IP 片段、在终点重组；
或者，如果这个包带着 **DF（不分片）位**，就丢弃它，并回一条 ICMP “目标不可达：需要分片”
（type 3，code 4）。

分片听起来像个体面的回退，实际不是，现代协议栈都在躲它：

- **代价高。** 分片只在最终主机重组，每个片段各走各的路径，重组缓冲区是经典的 DoS 靶子
  （分片重叠攻击、teardrop）。
- **它掩盖了尺寸错误。** 会分片的路由器“悄悄修好”了配置错误，于是你永远不知道路径其实是坏的。
- **它经常被丢。** 很多中间盒和防火墙直接丢弃分片，而不是转发。

正因为如此，**现代 TCP 给每个报文段都置上 DF**，并期望发现一个更小的 MTU，而不是靠分片绕过。
IPv6 更进一步：**路由器根本不分片**。只有源端能分片，而且必须先发现正确的 MTU。发现错了，
IPv6 就直接丢掉你的包，并回一条简短的 ICMPv6 “Packet Too Big”——前提是这条消息能回到你手上。

## MSS clamping：提前告诉 TCP 正确的尺寸

TCP 不必等一个包被卡住才知道 MTU。它可以在握手时协商。在 SYN/SYN-ACK 握手里，双方各自声明
自己的 **MSS**（最大报文段长度）：它愿意接收的最大 TCP 载荷，*不含* TCP/IP 头。

```
MSS = MTU - IP 头 - TCP 头
    = 1500 - 20 - 20 = 1460   （IPv4，无选项）
    = 1500 - 40 - 20 = 1440   （IPv6）
```

陷阱在于：主机是用*自己接口*的 MTU 去算 MSS 的，而接口通常是 1500。它根本不知道路径中间
有一段 1420 字节的隧道。于是它声明 1460，发出一个 1500 字节的包，隧道只能选择分片、或者丢掉
它并指望 PMTUD 兜底。

**MSS clamping** 就是改写跨越路由器的包里的 MSS 选项，让端点协商出一个真正放得下的尺寸。
要在隧道入网点做——也就是同时拥有 1500 字节物理侧和更小隧道侧的那台路由器——这样两侧的主机
都会认为路径比实际更小。

## nftables 里的 MSS clamping（以及 iptables 等价写法）

经典规则是把“出接口是隧道”的转发型 TCP SYN/SYN-ACK 包的 MSS clamp 到一个安全值。注意
`tcp flags syn` 匹配——这是一项*两端*操作，clamp SYN/SYN-ACK 才能覆盖握手的两个方向。

```bash
#!/usr/sbin/nft -f
# /etc/nftables.d/mss-clamp.nft
#
# 把从隧道接口出去的 TCP MSS clamp 住。1420 = MTU 减去封装开销：
# 1500 - 60（IPv4 + WireGuard）= 1440，再留 20 字节余量给 overlay 之下叠加的路径。
table inet mssclamp {
    chain forward {
        type filter hook forward priority filter; policy accept;

        # 对经由 wg0 出去的 IPv4 TCP 握手做 MSS clamp。
        oifname "wg0" tcp flags syn tcp option maxseg size set 1360

        # 对经由 wg0 出去的 IPv6 TCP 握手做 MSS clamp。
        # IPv6 头是 40 字节，比 IPv4 多 20，所以值要再小 20。
        oifname "wg0" tcp flags syn tcp option maxseg size set 1340
    }
}
```

老式的 iptables 写法是同一个思路，也是你在既有环境里最常遇到的：

```bash
# 对从 wg0 出去的 TCP SYN 包把 MSS clamp 到 1360（2026 年了，优先用 nftables）
iptables -t mangle -A FORWARD -o wg0 -p tcp --tcp-flags SYN,RST SYN \
    -j TCPMSS --set-mss 1360

# 或者更稳健地，按出接口严格能放下的值来 clamp：
iptables -t mangle -A FORWARD -o wg0 -p tcp --tcp-flags SYN,RST SYN \
    -j TCPMSS --clamp-mss-to-pmtu
```

`--clamp-mss-to-pmtu` 很优雅，因为它从路由的 MTU 推导数值，而不是写死；nftables 没有直接等价物，
所以用 nftables 时你写死一个对整条路径都保守的值。取路径上任何一段会出现的最小 MTU，再减去
40/60。

## 路径 MTU 发现，以及被过滤的 ICMP 如何杀死它

当没有做 clamping、而你又无法控制每一跳时，网络就依赖 **路径 MTU 发现（path MTU
discovery，PMTUD）**。主机发出一个置了 DF 的满尺寸包；某个链路太小的中间路由器丢弃它，并回一条
携带下一跳 MTU 的 ICMP“需要分片”；发送方据此调小 MSS 并重传。整个机制就这些，而它脆弱的原因
粗暴而单一：**它依赖 ICMP 能成功回传到发送方。**

MTU 黑洞最常见的成因，就是某个防火墙丢弃了 ICMP“需要分片”（type 3，code 4）——通常是一条
激进的“默认全丢 ICMP”策略的副作用。数据包因为太大被丢；本该通知发送方调小的那条 ICMP 因为
“是 ICMP”也被丢。发送方于是永远重传同一个过大的包。应用层收不到任何错误，连接就这么停住。

这正是这个问题与服务器加固之间的关联：一条无差别的 `drop icmp` 规则，恰恰会制造 MTU 黑洞。
至少放行 ICMP type 3 和 4（对 IPv6 则是 **全部** ICMPv6 type 1–4——没有它们 IPv6 无法运作）。
同一种失败模式也会在 ICMP 被路径过滤时咬到 NAT 穿透；[NAT 穿透那篇](/zh/posts/nat-traversal-explained/)
是这一篇的控制面表亲。

## 经典症状：小请求正常，大请求卡死

认准这个形状：

- 默认（小载荷）的 `ping` 成功。
- `ssh` 能连上，敲键盘有反应——但 `scp`、`git clone`、`rsync` 停在 0%。
- TLS 握手完成（ServerHello 很小），随后第一个大的 HTTP 响应、或一个带真实 body 的 `POST` 冻住。
- 小 API 调用秒回；上传、文件下载，以及任何 body 较大的请求都卡住并最终超时。

原因与尺寸相关：握手、健康检查、SYN 都塞得进小包。第一个满尺寸的数据段跨过那条窄一跳，被丢弃
（DF 置位、ICMP 被过滤），再也到不了。连接是*开着*的——两端都能看到 established 套接字——但
凡大于路径上最小 MTU 的字节，一个都过不去。

## 排查流程

由内向外查。先用 `ping` 的禁止分片开关找到下界。Linux 上 `-M do` 会置上 DF 并禁止分片；
若路径比你的载荷还窄，ping 会以本地 “Message too long” 或超时失败。

```bash
# 基线：小包总是能过。
ping -c 2 -M do -s 1200 10.8.0.1

# 找真实 MTU：-s 是 ICMP 载荷，所以要加 28 字节（20 IP + 8 ICMP）。
# 试 1400 载荷 => 1428 字节的包。若它失败而 1300 通过，可用 MTU 在 1328 与 1428 之间。
ping -c 2 -M do -s 1400 10.8.0.1

# 你出站那个接口的本地 MTU：
ip link show wg0 | grep -o 'mtu [0-9]*'
```

接下来让内核告诉你路径在哪变窄。`tracepath`（不需要 root）会替你跑 PMTUD，并逐跳打印它发现
的 MTU；当它打出 `pmtu 1420` 后就以 `no reply` 卡住，你就找到一个黑洞了。

```bash
tracepath -n 10.8.0.1
#  1?: [LOCALHOST]     pmtu 1420
#  1:  192.168.1.1      0.412ms
#  2:  10.8.0.1         0.730ms  pmtu 1420
#  3:  10.8.0.1         0.730ms  # 一旦不再下降，这个 1420 就是底
```

再用 `tcpdump` 确认，盯住那个标志性的现象：同样尺寸的报文段被反复重传。能的话两端都抓：

```bash
# 在隧道端点上：找反复出现、尺寸相同的满包，以及始终没回来的 ICMP 'frag needed'。
tcpdump -ni wg0 -v 'tcp and (tcp[tcpflags] & tcp-syn != 0 or ip[6:2] & 0x1fff != 0)'
# 健康的路径会看到 MSS 约 1360 的 SYN。黑洞则表现为反复出现的 1500 字节报文段、
# ACK 不推进，且另一方向始终没有 ICMP。
```

决定性的判据：若 `ping -M do -s 1400` 失败而 `-s 1300` 通过，同时并行抓的 `tcpdump` 显示
一条 ICMP“需要分片”出现在无关的接口上、或者压根没出现，那就是 PMTUD 黑洞。修它的地方只有两处：
clamp MSS，或调小隧道 MTU。

## 实战修复

**1. 在隧道入网点做 MSS clamp**（见上面的 nftables 规则）。这是最稳健的修法：它在最前面就把正确
尺寸告诉端点，于是满尺寸包永远不会撞上窄链路。IPv4 和 IPv6 的 forward 链都要做。

**2. 正确设置隧道接口 MTU。** 永远不要把隧道留在 1500。正确值是物理 MTU 减去封装开销，并且
**两端**必须一致：

```bash
# WireGuard：物理 1500 - 60（IPv4+UDP+WG）= 1440；若底层路径本身也是隧道
# （移动/云上很常见），再留点余量。
ip link set dev wg0 mtu 1420

# 验证协议栈据此算出正确的 MSS：
ip route get 10.8.0.1                 # 显示出口设备及其 mtu
ss -tin 'dst 10.8.0.1' | grep -o 'mss:[0-9]*'   # 一条活跃连接协商到的 MSS
```

**3. 别再无差别丢 ICMP。** 留下那些让互联网能运转的消息。一条最小 nftables 策略会放行 IPv4 的
ICMP type 3（目标不可达，其中就包含 code 4 需要分片）与 type 4，以及 IPv6 的 ICMPv6 type 1–4：

```bash
# 放行 PMTUD 依赖的 ICMP 消息。其余依旧可以限速，而不是悄悄丢弃。
nft add rule inet filter input  icmp type { destination-unreachable, time-exceeded, parameter-problem } accept
nft add rule inet filter input  icmpv6 type { destination-unreachable, packet-too-big, time-exceeded, parameter-problem } accept
# 注：在 IPv4 上，fragmentation-needed 是 destination-unreachable 的一个 CODE，不是独立 type——
# 匹配 type 就一并匹配了 code。
```

## 值得背下来的三个数字

- **MTU 1500** 是物理世界；每一层隧道都从它身上减去开销。
- **MSS = MTU − 40（IPv4）/ − 60（IPv6）** 是 TCP 该协商的值，而 MSS clamping 就是你让它去
  协商更小路径值的办法。
- **PMTUD** *只有在* ICMP“需要分片”被允许回传时，才能发现那条窄一跳。过滤掉这条 ICMP，你就
  造了一个黑洞：放走每一个小包，丢掉每一个大包。

如果一条连接能打开、却在有负载时停住，你现在知道第一件该查的事了：用 `ping -M do -s` 摸底下界、
用 `tracepath` 找那条窄一跳、用 `tcpdump` 抓反复出现的满尺寸报文段——然后 clamp MSS、修好隧道
MTU。那个花掉你三小时的 bug，是一个你忘了减掉的 60 字节头。
