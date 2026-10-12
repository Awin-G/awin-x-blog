---
title: "TCP 拥塞控制：Reno、CUBIC 与 BBR——你的吞吐为什么没跑满"
description: "TCP 拥塞控制，就是内核在几乎不了解路径的情况下自己决定发送速率。slow start、congestion avoidance、fast recovery 三个阶段，为什么 CUBIC 是 Linux 默认，BBR 如何建立带宽延迟积模型，怎么读 `ss -ti`，用 sysctl 切到 BBR，以及 bufferbloat。"
pubDate: 2026-11-30
lang: zh
translationKey: tcp-congestion-control
tags: [networking, linux]
featured: false
keywords:
  - TCP 拥塞控制
  - BBR vs CUBIC
  - TCP tuning
  - bufferbloat
  - 带宽延迟积
---

千兆链路只跑到 40 Mbit/s，而交换机、磁盘、CPU 全都闲着，这是一种很特别的失望。硬件没问题。你看到的是 **TCP 拥塞控制**：内核在完全不知道路径上到底有多少带宽的情况下，用来决定自己*被允许*发多快的那套规则。在一条又长又丢包的路径上，它决定了你是用掉链路的 5%，还是用掉 90%。

这个框架很重要，因为“拥塞控制”常被误读成“让它变快”。它几乎恰恰相反：一套分布式资源分配机制，每个 TCP 发送方各自独立运行，只靠 ACK 和丢包这点微弱反馈，去共享一张谁都看不全的网络。下面讲它做什么、经过哪些阶段、Reno、CUBIC 与 BBR 有何不同、怎样用 `ss -ti` 观察窗口，以及为什么 bufferbloat 是同一个故事在队列那一侧的说法。

## TCP 拥塞控制（congestion control）到底在做什么

一个 TCP 发送方有两个窗口。**接收窗口**是对端声明的；**拥塞窗口**（`cwnd`）则是发送方自己对“网络能装下多少”的猜测。任一瞬间，在途字节数不能超过 `min(cwnd, rwnd)`，所有有意思的事都在 `cwnd` 怎么变。

路径有一个容量，叫**带宽延迟积**（bandwidth-delay product，BDP）：瓶颈带宽乘以往返时延。这就是要把管道灌满、必须保持在途的字节数——一条 100 Mbit/s、RTT 100 ms 的路径需要约 1.25 MB 在途，远远超过默认窗口。在 `cwnd` 涨到 BDP 之前，你根本没在用这条链路，只是在等。

没人会告诉发送方 BDP 是多少：路由器既不公布队列深度，也不公布链路速率，于是经典发送方能拿到的信号只有两个——回得来的 ACK，和回不来的包。于是算法只能试探：一直加，加到出事为止，然后退。这就是*加性增、乘性减*（additive increase, multiplicative decrease，AIMD）：一切正常时每个 RTT 加一个报文段，丢包说明冲过了头就狠狠砍。加得慢、砍得快，系统才稳定而不剧烈震荡；它不是“跑快”，而是去搜一个未知的天花板。另一种做法是**拥塞崩溃（congestion collapse）**——无视丢包、按线速硬推，队列就会溢出，丢包触发重传，网络搬运的包更多、交付的却更少。

## 三个阶段：slow start、congestion avoidance、fast recovery

TCP 不会一跃跳到一个窗口大小然后祈祷，它是一级级爬上去的。

**慢启动（slow start）**是个误称——增长是指数的，只是起点很低。`cwnd` 从约十个报文段开始（RFC 6928），随着 ACK 返回**每个 RTT 翻一倍**：1、2、4、8、16……直到抵达 `ssthresh`（初始值极大）或出现丢包。慢启动是快速摸清未知 BDP 的方式；说它“慢”，只是相对于无所顾忌地猛灌而言。

**拥塞避免（congestion avoidance）**在 `cwnd` 越过 `ssthresh` 后接手。此时增长变成线性：大致**每个 RTT +1 MSS**，因为发送方已贴近天花板，只能挪而不能翻。这是稳态，也是一条长连接一生中大部分时间所处的阶段。

**快速重传与快速恢复（fast retransmit / fast recovery）**让丢包不必从头再来。某个报文段丢了，接收方会继续收下后续乱序段，并反复 ACK 它看到的最后一个按序字节，于是发送方收到三个重复 ACK——“多半只丢了一个包，路径还活着”。它立刻重传，把 `ssthresh` 设为 `cwnd` 的一半、`cwnd` 减半，然后以拥塞避免的节奏继续——这就是*快速恢复*——而不是塌回 `cwnd = 1`。只有超时（一个 ACK 都收不到）才回到慢启动。下图就是这一切在 `cwnd`—时间坐标上画出的形状。

<figure>
<svg viewBox="0 0 640 260" width="100%" role="img" aria-label="拥塞窗口随时间的曲线：慢启动阶段 cwnd 以陡峭的指数斜坡翻倍增长，拥塞避免阶段线性缓慢上升，一次丢包事件带来陡降与快速恢复，随后再次进入浅缓爬升的拥塞避免。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <path d="M60 20 V220 H610"/>
    <path d="M60 20 H55 M60 220 H55"/>
  </g>
  <g stroke="currentColor" stroke-width="1.6" fill="none" opacity="0.75">
    <path d="M60 214 L74 200 L88 182 L102 158 L114 130 L124 100 L132 78 L150 76 L180 72 L215 66 L255 59 L300 50 L336 42"/>
    <path d="M336 42 L344 96 L354 102" stroke="#0f766e"/>
    <path d="M354 102 L378 96 L410 88 L450 78 L495 67 L540 56 L560 51"/>
    <path d="M560 51 L566 100 L576 105" stroke="#0f766e"/>
    <path d="M576 105 L600 99"/>
    <path d="M336 42 V214 M560 51 V214" stroke-dasharray="4 4" opacity="0.45"/>
  </g>
  <circle cx="336" cy="42" r="3.5" fill="#0f766e"/>
  <circle cx="560" cy="51" r="3.5" fill="#0f766e"/>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="86" y="150" text-anchor="middle">slow start</text>
    <text x="86" y="164" text-anchor="middle" font-size="11" opacity="0.75">（每 RTT 翻倍）</text>
    <text x="230" y="52" text-anchor="middle">congestion avoidance</text>
    <text x="230" y="40" text-anchor="middle" font-size="11" opacity="0.75">（每 RTT +1 MSS）</text>
    <text x="450" y="60" text-anchor="middle">congestion avoidance</text>
    <text x="342" y="232" text-anchor="middle" font-size="11" fill="#0f766e">丢包</text>
    <text x="566" y="232" text-anchor="middle" font-size="11" fill="#0f766e">丢包</text>
    <text x="470" y="118" text-anchor="middle" font-size="11" opacity="0.8">快速恢复：减半，不重开</text>
    <text x="30" y="126" text-anchor="middle" font-size="12" opacity="0.85">cwnd</text>
    <text x="600" y="240" text-anchor="middle" font-size="12" opacity="0.85">时间</text>
  </g>
</svg>
<figcaption>拥塞窗口随时间变化：指数式的慢启动、线性的拥塞避免，然后一次丢包把窗口减半，并由快速恢复修好。每次丢包都会重新压低天花板，窗口就绕着它来回锯。</figcaption>
</figure>

## Reno、CUBIC 与 BBR：同一个问题的三种答案

所有算法在机制上一致——试探，然后后退。它们的分歧在于*什么才算“过了头”*，而这个差别值真实的吞吐。

**Reno** 是现代意义上的元老，逻辑正是上面那套 AIMD：每个 RTT 加一个 MSS，丢包减半。它的弱点在任何有像样时延的路径上都暴露无遗：当 `cwnd` 很大时，减半是一次*巨大*的砍，恢复期里要花几百个 RTT 才能爬回来。**NewReno** 补上了最坏情形——一次丢包不再多次跌回慢启动——但锯齿依旧。在长肥网络上，Reno 只在 BDP 附近来回震荡，永远停不下来。

**CUBIC** 自 Linux 2.6.19 起就是默认算法，有它的道理。它不用线性增长，而是让 `cwnd` 成为**距上次丢包时间的立方函数**：窗口还安全地低于上次丢包点时增长得很有攻击性，接近那个上限时再放平。大减半之后的恢复比 Reno 快得多；增长曲线对 RTT 的依赖也小得多，这让长 RTT 与短 RTT 的流更接近公平。CUBIC 依然*对丢包做反应*——只是更聪明。

### BBR vs CUBIC：建模路径，还是对丢包做反应

Google 的 **BBR** 干脆把丢包从主信号里踢了出去。在现代链路上，丢包是个糟糕的拥塞信号：缓冲区很深，一个包可能在瓶颈早已灌满之后很久才掉；而在无线链路上，掉包甚至和拥塞毫无关系。BBR 转而用两个它本来就有的测量去**给路径建模**：**交付速率**（ACK 确认数据的速度——即瓶颈带宽），以及滑动窗口内的**最小 RTT**（一趟无排队的往返）。两者相乘就是 BDP。BBR 然后把发包**按速配（pace）**到这个带宽上，把窗口维持在 BDP 附近，并周期性地向上试探更多带宽、向下试探更低 RTT。

在丢包路径上，收益很大。CUBIC 会把任何一次丢包——包括与拥塞无关的丢包——当作拥塞而减半；BBR 则维持测得的速率，于是一条 1% 随机丢包、把 CUBIC 饿得半死的链路，在 BBR 下可能接近满速。代价也是真实的：

- **它需要 pacing 和 `fq` qdisc。** 没有 `fq`，BBR 就无法按模型速率把包间隔开，会丢掉大半优势，还可能自己制造突发时延。
- **丢包不再是兜底信号。** 面对**基于丢包**的流，BBR 可能很有攻击性——把缓冲区灌满以维持交付速率估计的高位，这正是初代 BBR 招致批评的不公平之处。BBRv2/v3 把丢包作为二级上限重新引入，但你到底用的是哪版，取决于内核有多老。
- **它在套利一个指标。** 一个拒绝因丢包后退的发送方，自然会打败一个老实后退的，所以 BBR 放在共享链路上，能把基于丢包的对端挤到一边。只在一台服务器上打开、对着所有人，就是对别人的一种抽税。

Reno 是基线；CUBIC 是安全、通用的默认；BBR 在又长、又丢包、又深缓冲的路径上是大幅提升，在共享链路上则带着一点风险。这就是 **BBR vs CUBIC** 最诚实的一句话总结。

## TCP tuning：在 Linux 上查看并切换算法

两条命令能覆盖大半。`sysctl` 负责查看和切换算法，而 qdisc 和算法一样重要：BBR 想要 `fq`。

```bash
# 现在用的是什么，这个内核又到底支持哪些？
sysctl net.ipv4.tcp_congestion_control
sysctl net.ipv4.tcp_available_congestion_control
# 典型输出：
#   net.ipv4.tcp_congestion_control = cubic
#   net.ipv4.tcp_available_congestion_control = reno cubic bbr

# 在运行时切到 BBR。fq 给 BBR 提供它所假设的 pacing。
sysctl -w net.core.default_qdisc=fq
sysctl -w net.ipv4.tcp_congestion_control=bbr

# 持久化，跨重启都还在。
cat > /etc/sysctl.d/99-tcp-bbr.conf <<'EOF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
EOF
sysctl --system

# 若列表里没有 bbr，先加载模块：
lsmod | grep tcp_bbr || modprobe tcp_bbr
```

`ss -ti` 展示一条活连接此刻到底在干什么——当作“单个套接字的 `top`”来读：

```bash
$ ss -ti dst 203.0.113.10
State  Recv-Q Send-Q  Local Address:Port    Peer Address:Port
ESTAB  0      0       10.0.0.5:51234        203.0.113.10:443
	 cubic wscale:7,7 rto:204 rtt:24.5/2.1 ato:40 mss:1448
	 pmtu:1500 rcvmss:1448 advmss:1448 cwnd:42 ssthresh:38
	 bytes_acked:184210 bytes_received:9210 segs_out:1523 segs_in:640
	 send 19.8Mbps pacing_rate 39.6Mbps delivery_rate 19.2Mbps
	 busy:2340ms unacked:3 retrans:0/2 lost:1 reordering:5 rcv_rtt:26.1
```

逐字段读：

- **`cubic`**——当前生效的算法，后面跟着 **`rtt:24.5/2.1`**：平滑往返 24.5 ms，抖动 2.1 ms。`rtt` 很安静、`send ` 速率却低，说明限制在窗口而不在网络。
- **`cwnd:42 ssthresh:38`**——在途 42 个 MSS，阈值恰好在其下，所以这条连接正处于*拥塞避免*，且刚从一次丢包中恢复。
- **`retrans:0/2 lost:1`**——如果一条长传输里 `lost` 持续上涨，那正是基于丢包后退的铁证：算法把它当成拥塞，无论它是不是。
- **`delivery_rate 19.2Mbps` 对比 `send 19.8Mbps`**——模型对“路径实际交付了多少”的估计；远低于链路速率、`rtt` 还在涨，说明被窗口限住或正排在别人的队列里。**`pacing_rate`** 则是 BBR 用来间隔发包的值。

决定性的诊断：如果 `rtt` 又平又低，而 `send` 也低、`cwnd` 又小，那你的吞吐是被*算法爬得太慢*卡住的，不是路径——这正是切换算法能改变一切的情形。若你怀疑的是路由，[`traceroute-lies`](/zh/posts/traceroute-lies/) 讲了怎么把真实路径丢包和 ICMP 噪声分开，而 `ss -ti` 里的 `retrans` 能拿地面真相去印证它。

## 什么时候重要，什么时候不重要

**BDP 大、或路径丢包时，它很重要：**

- **长肥网络。** 一条 1 Gbit/s、RTT 100 ms 的路径，BDP 约 12.5 MB。CUBIC 和 BBR 最终都能爬到；Reno 停不下来。跨洲传输里，算法选择值好几倍的吞吐。
- **丢包链路。** 卫星、移动网络、拥塞的 Wi-Fi，都会因与拥塞无关的原因丢包。基于丢包的算法把每次掉包都读成“慢下来”，白白把带宽留在桌上；这正是 BBR 的主场。
- **VPN 与隧道。** 被封装的一条流仍在为它的*内层*包运行同一套拥塞控制，但隧道 MTU 和隧道端点上多出来的排队会改变图景。如果大传输是*卡死*而不是变慢，那是另一个 bug——动 `sysctl` 之前先读 [MTU 与 PMTUD](/zh/posts/mtu-and-pmtud/)。

**在局域网里，它不重要。** 一台 1 Gbit/s 交换机上 RTT 0.2 ms，BDP 约 25 KB——几十个报文段而已。`cwnd` 在慢启动里就够到了，传输通常被应用、磁盘或 CPU 限住，而不是网络。在这里切到 BBR，你量不出任何变化；本机容器之间和 loopback 流量也一样。

一句话的规则：**当 `带宽 × RTT` 远大于你的窗口，或当丢包在撒谎说“拥塞”时，拥塞控制才重要。** 这两个条件在局域网上都不成立，在公网上都是家常便饭。

## bufferbloat：你看不见的那条队列

以上一切都默认网络里的队列很浅。可它常常不浅，这就是 **bufferbloat**。一台在 100 Mbit/s 链路上挂着 500 ms 缓冲区的路由器，能把整个拥塞窗口吞下去而一个包都不丢，于是发送方一路涨 `cwnd`——没有丢包，没有后退信号——直到常态排队深达几百毫秒。延迟爬升、抖动爆炸、视频通话卡顿，而 TCP 按它自己的规则运行得完美无缺：问题在队列，不在算法。

这正是 BBR 的最小 RTT 测量有价值的原因：它能看见基于丢包的算法看不见的那条队列，因为队列在溢出之前一直隐形。也正是修法要落在**队列**那一头的原因：像 `fq_codel` 或 `CAKE` 这样的 **AQM**（主动队列管理）qdisc 会在缓冲区*满之前*就丢包或标记，尽早发出拥塞信号，把排队时延约束住。这就是 BBR 要配 `fq`、好路由器默认用 `fq_codel` 的原因。拥塞控制决定用多大力气推，qdisc 决定一个包在队里等多久。

## 值得记住的两句话

拥塞控制是一次搜索：试探到出事为止，狠砍，再慢慢爬回来。CUBIC 是那个安全、对丢包做反应的默认；BBR 是那个基于模型的备选，在丢包会撒谎的地方胜出，却在别人都按旧规则玩时可能失态。

所以，当一次传输跑不动时：先看 `ss -ti` 里的 `rtt`、`cwnd` 和 `retrans`。如果窗口小、RTT 干净，那是算法在拖你后腿——配上 `fq` 试试 BBR。如果吞吐还撑着、RTT 却在爬，那是缓冲区在被灌满；去修队列。而在局域网上，就去干点更有用的事吧。
