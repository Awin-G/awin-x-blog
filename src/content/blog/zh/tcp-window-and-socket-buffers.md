---
title: "TCP 窗口缩放与套接字缓冲区：为什么长链路上传输慢"
description: "为什么 500 Mbit/s 的链路只跑出 14 Mbit/s：接收窗口、TCP 窗口缩放、带宽延迟积，以及套接字缓冲区与自动调优如何决定真实上限——全部用真实的 iperf3、tcpdump、netem 与 ss -ti 输出说话。"
pubDate: 2027-01-28
lang: zh
translationKey: tcp-window-and-socket-buffers
tags: [networking, linux]
featured: false
keywords:
  - TCP 窗口缩放
  - 带宽延迟积
  - 套接字缓冲区
  - ss -ti
  - tcp_rmem
---

两次 iperf3，同样两个容器，同样由我 shaping 出来的 50 ms、500 Mbit/s 路径。唯一变
化的，是允许多少字节**在途**：一次跑出 14.4 Mbit/s，另一次 445 Mbit/s。链路从头到尾
没动。我当时真正观察的，是**接收窗口**——TCP 接收方给予发送方的配额——以及它背后的
一整套机制：**TCP 窗口缩放**、**带宽延迟积**，还有内核**自动调优**替你悄悄长大的
**套接字缓冲区**。而在我动任何一个 sysctl 之前就告诉我“到底是哪个限制在起作用”的
工具，是 `ss -ti`。

本文不讲[拥塞控制](/zh/posts/tcp-congestion-control/)——那是发送方自己的窗口 `cwnd`，
我单独写过；也不讲[keepalive](/zh/posts/tcp-keepalive/)。本文讲的是*另一个*窗口：接
收方声明的那个，以及它如何在又长又肥的链路上悄悄压住你的传输。

## 接收窗口是对“未确认字节数”的配额

TCP 不允许发送方按线速猛灌。接收方声明一个**接收窗口**（`rwnd`）：它当前愿意容纳
多少字节。于是发送方在途且未被 ACK 的字节，最多只能有这么多。这是一个流控配额，存
在的原因是接收方缓冲区有限——塞得更多，内核就只能丢。

`ss` 会同时打印两个方向的窗口。在一次繁忙传输的发送方上，它自己声明的窗口永远停在默
认值：

```
$ ss -ti '( dport = :5201 )'
ESTAB 0 0 172.17.0.5:43868 172.17.0.4:5201
	 cubic wscale:10,10 rto:260 rtt:59.924/5.303 mss:1448 pmtu:1500 rcvmss:536 advmss:1448 cwnd:2964 ssthresh:2320 bytes_sent:135723405 bytes_acked:131856630 segs_out:93760 segs_in:2283 data_segs_out:93758 send 573Mbps lastsnd:4 lastrcv:2871 pacing_rate 688Mbps delivery_rate 479Mbps delivered:91088 app_limited busy:2870ms unacked:2671 rcv_space:14480 rcv_ssthresh:64088 minrtt:50.059 snd_wnd:18301952 rcv_wnd:64512
```

`rcv_wnd:64512`——**63 KB**。这个套接字不收数据，所以它自己声明的窗口整条连接都停在
默认值；真正起作用的是反方向的 `snd_wnd:18301952`——18 MB，是自动调优在接收方为发送
方长出来的。63 KB 是每个未调优套接字的起点，在局域网上绰绰有余；而在 50 ms 延迟的路
径上一文不值，下面的算术解释了一切。

## 带宽延迟积决定这个配额够不够用

两台主机之间的管道是装得下数据的。要把它灌满，你必须始终保持
`带宽 × 往返时延` 字节在途——这个量就是**带宽延迟积**（bandwidth-delay product，
BDP）。只要在途字节少于管道容量，链路就会空转，吞吐就恰好变成 `窗口 ÷ RTT`：

| 窗口 | RTT | 上限 |
|---|---|---|
| 63 KB | 50 ms | 约 10 Mbit/s |
| 63 KB | 100 ms | 约 5 Mbit/s |
| 3.1 MB | 50 ms | 500 Mbit/s |

我这条路径——500 Mbit/s、实测 RTT 50.093 ms——BDP 是 **3.125 MB**。63 KB 的窗口只
能灌满它的 2%。换交换机、换网卡、换 CPU 都改变不了这一点：缺的那 3 MB 必须*在途*，
而窗口说不行。

<figure>
<svg viewBox="0 0 640 300" width="100%" role="img" aria-label="时间线示意图。发送方的时间线上有四个数据段；其上的括号标出接收窗口，即允许未确认的字节数。更远处的虚线段表示带宽延迟积，即灌满整条管道所需的字节数。在接收方的时间线上，每个数据段发出一整个往返时间之后 ACK 返回。吞吐上限为窗口除以往返时间。">
  <defs>
    <marker id="arrowz5" markerWidth="7" markerHeight="7" refX="3" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.4" opacity="0.55" fill="none">
    <path d="M90 80 H600"/>
    <path d="M90 210 H600"/>
    <path d="M90 86 V74 M90 216 V204"/>
    <path d="M600 76 h14" marker-end="url(#arrowz5)"/>
    <path d="M600 206 h14" marker-end="url(#arrowz5)" transform="rotate(180 607 206)"/>
  </g>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="currentColor">
    <text x="16" y="64">发送方</text>
    <text x="16" y="236">接收方</text>
    <text x="132" y="46" fill="#0f766e">接收窗口（rwnd）：允许未确认的字节数</text>
    <text x="352" y="118" opacity="0.8">BDP = 带宽 × RTT</text>
    <text x="212" y="152">一次往返（RTT）</text>
    <text x="130" y="284">吞吐 ≤ 窗口 ÷ RTT</text>
  </g>
  <g fill="#0f766e">
    <rect x="130" y="72" width="42" height="16" rx="2"/>
    <rect x="180" y="72" width="42" height="16" rx="2"/>
    <rect x="230" y="72" width="42" height="16" rx="2"/>
    <rect x="280" y="72" width="42" height="16" rx="2"/>
    <rect x="340" y="72" width="42" height="16" rx="2" opacity="0.2"/>
    <rect x="390" y="72" width="42" height="16" rx="2" opacity="0.2"/>
    <rect x="440" y="72" width="42" height="16" rx="2" opacity="0.2"/>
    <rect x="490" y="72" width="42" height="16" rx="2" opacity="0.2"/>
    <rect x="540" y="72" width="42" height="16" rx="2" opacity="0.2"/>
  </g>
  <path d="M130 68 V56 H322 V68" fill="none" stroke="#0f766e" stroke-width="1.2"/>
  <path d="M322 90 V98 H596 V90" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>
  <path d="M172 84 C400 150 470 172 468 204" fill="none" stroke="currentColor" stroke-width="1.1" stroke-dasharray="5 4" marker-end="url(#arrowz5)" opacity="0.7"/>
  <g fill="currentColor" opacity="0.55">
    <circle cx="466" cy="210" r="4"/>
    <circle cx="502" cy="210" r="4"/>
    <circle cx="538" cy="210" r="4"/>
    <circle cx="574" cy="210" r="4"/>
  </g>
</svg>
<figcaption>接收窗口限制未确认字节数；带宽延迟积则是灌满整条管道所需的字节量。吞吐永远不可能超过窗口 ÷ RTT——所以 63 KB 的窗口在 100 ms 下就是 5 Mbit/s，链路多粗都一样。</figcaption>
</figure>

带宽和延迟都高的链路有个专门名字：**长肥网络**（long fat network）。BDP 越大，窗口
就越是要命。

## 窗口缩放：让窗口越过 64 KB 的 SYN 选项

麻烦在于 TCP 头里的窗口字段只有 16 位：最大只能声明 65535 字节。这在 1981 年绰绰有
余，在今天毫无希望。解法是**窗口缩放**（window scaling，RFC 1323）：双方在 SYN 里
各自宣告一个移位量（0–14），用它乘以窗口字段。于是有效窗口是
`win << scale`，缩放 10 就能把下面那个 64240 字节的字段变成 6.5 千万字节的窗口。
两个方向各自协商，并且由于窗口字段从第一个数据段起就要被使用，缩放因子必须赶在任
何数据传输之前定下来——这正是它必须在三次握手里敲定的原因：

```
$ tcpdump -i eth0 -c 2 'tcp[tcpflags] & tcp-syn != 0' -n
02:46:40.101134 IP 172.17.0.5.55950 > 172.17.0.4:5201: Flags [S], seq 663357360, win 64240, options [mss 1460,sackOK,TS val 1191131545 ecr 0,nop,wscale 10], length 0
02:46:40.101144 IP 172.17.0.4:5201 > 172.17.0.5:55950: Flags [S.], seq 188291870, ack 663357361, win 65160, options [mss 1460,sackOK,TS val 1317947941 ecr 1191131545,nop,wscale 10], length 0
```

两个 SYN 都带 `wscale 10`；此后整条连接双方都会应用它。只要有一方不带这个选项，这条
连接就禁用缩放，窗口永远卡在 64 KB 以下——一个会删 SYN 选项的旧盒子，就能悄悄压住你
的吞吐。

## 套接字缓冲区：窗口真正从哪里来

内核声明的窗口，是套接字接收缓冲区 `SO_RCVBUF` 的函数（发送侧的兄弟是
`SO_SNDBUF`）。Linux 上有三样东西控制这些缓冲区，而它们的相互作用就是整个故事：

```
$ sysctl net.ipv4.tcp_rmem net.ipv4.tcp_wmem net.core.rmem_max net.core.wmem_max net.core.rmem_default
net.ipv4.tcp_rmem = 4096	131072	33554432
net.ipv4.tcp_wmem = 4096	16384	4194304
net.core.rmem_max = 4194304
net.core.wmem_max = 4194304
net.core.rmem_default = 212992
```

- **`net.ipv4.tcp_rmem` / `tcp_wmem`**——`最小值 默认值 最大值`，TCP **自动调优**
  用的就是它。新套接字从默认值起步（212992 字节，也就是 `ss -tim` 里空闲连接的
  `rb131072`），随着连接认识到自己需要更多而向最大值增长。这里接收侧自动调优的上限
  是 **32 MB**，而发送侧只有 4 MB。
- **`net.core.rmem_max` / `wmem_max`**——这是*应用程序*用
  `setsockopt(SO_RCVBUF)` 设置时的上限。这里是 4 MB。
- **内核会把你设的值翻倍。** 应用请求 `SO_RCVBUF=1M`，`ss -tim` 报的是
  `skmem:(r0,rb2097152,t0,tb2097152,f0,w0,o0,bl0,d0)`——真实分配 2 MiB，因为内
  核要为记账开销预留等量空间。其中约 75% 会成为声明的窗口。

第三条规则对读测量数据很重要：实际在途字节大约是应用请求值的 1.3–1.4 倍。意外的是：
在这台机器上，自动调优轻松声明了 **18 MB** 的接收窗口（就是上面抓取里的
`snd_wnd:18301952`），尽管 `rmem_max` 只有 4 MB。自动调优受 `tcp_rmem[2]` 约束；
`rmem_max` 只约束显式的 `setsockopt`。“把 rmem_max 调大就能放大窗口”这句话，只对你
自己写的应用成立——它管不到内核自己的自动调优器，后者的旋钮是 `tcp_rmem`。

## 用 `ss -ti` 诊断：到底哪个限制在起作用

新版 `ss -ti` 会为每个连接打印几乎你需要的一切——用套接字过滤
（`ss -ti 'dport = :5201'`）锁定你关心的那一端：

- `cwnd` / `ssthresh`——发送方的拥塞窗口与慢启动门限。
- `rtt:` `均值/抖动` 与 `minrtt`——往返时延，含路径底噪。
- `bytes_received`、`segs_in`、`unacked`、`busy`——传了多少、在途多少。
- `rcv_space` / `rcv_ssthresh`——自动调优器的当前目标与天花板。
- `rcv_wnd` / `snd_wnd`——两个方向的当前窗口（已乘好缩放因子）。
- `skmem`——已分配缓冲区（`rb` = 接收缓冲，`tb` = 发送缓冲）。
- `rwnd_limited`、`sndbuf_limited`、`app_limited`——**处在每种限流状态下的时长**，
  以毫秒和百分比给出。就是这个字段终结了瞎猜。

## 实验：一条 50 ms、500 Mbit/s 的管道

在 Docker 网桥上，两个容器之间的 veth 通道能跑 24 Gbit/s：

```
$ iperf3 -c 172.17.0.4 -t 2
[ ID] Interval           Transfer     Bitrate         Retr  Cwnd
[  5]   0.00-1.00   sec  2.81 GBytes  24.1 Gbits/sec  124    594 KBytes
[  5]   1.00-2.00   sec  2.76 GBytes  23.7 Gbits/sec   38    436 KBytes
```

（两秒内 162 次重传：跑到 24 Gbit/s，发送方终究会超过内核里某个会丢包的环节——提醒
我们 `Cwnd` 与 `Retr` 是最该先看的两列。）

现在我把客户端容器的出口 shaping 成一条“长肥”链路——500 Mbit/s、50 ms 延迟——用
netem，客户端容器带 `NET_ADMIN`：

```
$ tc qdisc replace dev eth0 root netem delay 50ms rate 500mbit limit 10000
$ ping -c 4 -i 0.3 172.17.0.4
...
rtt min/avg/max/mdev = 50.066/50.093/50.120/0.019 ms
```

BDP = 500 Mbit/s × 0.05 s = **3.125 MB**。同一个客户端、同一个服务端，只改 iperf3 的
`-w`：

```
$ iperf3 -c 172.17.0.4 -t 4 -w 64K
[  5]   0.00-4.00   sec  6.88 MBytes  14.4 Mbits/sec    0            sender
[  5]   0.00-4.05   sec  6.88 MBytes  14.2 Mbits/sec                  receiver
```

| 客户端 `-w` | sender 速率 | 推算在途字节 |
|---|---|---|
| 64 K | 14.4 Mbit/s | 约 90 KB |
| 256 K | 57.7 Mbit/s | 约 360 KB |
| 1 M | 214 Mbit/s | 约 1.34 MB |
| 4 M | 445 Mbit/s | 触及速率上限（500 Mbit/s） |
| 默认（自动调优） | 420 Mbit/s | 瓶颈是链路，不是窗口 |

每一轮 `Retr` 都是 **0**：被 shaping 过的无损路径上，拥塞控制无事可做，窗口就是唯一
的天花板。吞吐严格按 窗口 ÷ RTT 爬升，直到 500 Mbit/s 的速率上限接管——正是图里那
条定律。而完全不做任何调优时，自动调优把管道灌到了 420 Mbit/s。

## 证明问题在接收方：掐住它的自动调优上限

相关不等于因果，所以我把实验反过来。我把服务端重启，把它的接收自动调优上限压到
64 KB，客户端一概不动：

```
$ docker run -d --name srv2 --sysctl net.ipv4.tcp_rmem="4096 131072 65536" ... iperf3 -s
$ docker exec srv2 sysctl net.ipv4.tcp_rmem
net.ipv4.tcp_rmem = 4096	131072	65536

$ iperf3 -c 172.17.0.9 -t 4
[  5]   0.00-4.00   sec  8.00 MBytes  16.8 Mbits/sec    0            sender
[  5]   0.00-4.05   sec  7.00 MBytes  14.5 Mbits/sec                  receiver
```

同一个客户端、同一条 netem、同一个 BDP：之前 420 Mbit/s，之后 **14.5 Mbit/s**。唯一
的变化是服务端网络命名空间里的 `net.ipv4.tcp_rmem`。这就是带宽延迟积的实付：64 KB ÷
50 ms ≈ 10 Mbit/s，再加上前面说的记账余量。

一个很有启发性的怪现象：给这一轮加上 `-w 4M`，速率又跳回 444 Mbit/s，尽管服务端上
限仍被掐着。服务端上的 `ss -ti` 解释了原因——
`rcv_space:6286976 rcv_wnd:6241920 wscale:7,7`：接收缓冲区被显式设成了几 MB，而显式
设置的缓冲区会覆盖自动调优上限。iperf3 自己的 `-w` 帮助写的是 *"set send/receive
socket buffer sizes"*——这个值会作用到测试的接收端，所以那一轮并非“接收小、发送
大”，而是“两头都大”。想围绕 `-w` 设计实验的话，值得先记住这点。

## 并行流：八倍窗口代替一个窗口

另一个经典杠杆不是把窗口放大，而是让窗口变多。在一条 shaping 到 100 ms RTT 的
loopback 上（`tc qdisc add dev lo root netem delay 50ms`，实测 100.085 ms），一个
64 KB 窗口的单流：

```
$ iperf3 -c 127.0.0.1 -t 10 -w 64K
[  5]   0.00-10.00  sec  11.1 MBytes  9.33 Mbits/sec    0            sender

$ ss -ti | grep -A1 '127.0.0.1:5201'
ESTAB 0 123258 127.0.0.1:34150 127.0.0.1:5201
	 cubic wscale:1,1 rto:301 rtt:100.688/1.263 mss:61629 pmtu:65535 rcvmss:536 advmss:65483 cwnd:10 bytes_sent:1557273 bytes_acked:1434016 segs_out:33 segs_in:24 data_segs_out:31 send 49Mbps lastsnd:64 lastrcv:1667 lastack:64 pacing_rate 97.9Mbps delivery_rate 4.93Mbps delivered:30 busy:1666ms rwnd_limited:1402ms(84.2%) ...
```

内核自己的判词：`rwnd_limited:1402ms(84.2%)`——84.2% 的时间它都在受接收窗口限制。再
注意 `mss:61629`：loopback 的 [MTU](/zh/posts/mtu-and-pmtud/) 是 65535，所以两个段
就已经超过 64 KB 窗口了。现在换成八条流：

```
$ iperf3 -c 127.0.0.1 -t 10 -w 64K -P 8 | tail -4
[SUM] 0.00-10.00  sec  87.2 MBytes  73.2 Mbits/sec    0             sender
[SUM] 0.00-10.10  sec  86.6 MBytes  71.9 Mbits/sec                  receiver
```

八条 9.3 Mbit/s 的流，合计 **73.2 Mbit/s**——每条连接都有自己的窗口，于是并行把任何
单窗口乘以流数。这正是下载管理器和并行 CDN 取用的全部窍门，而且不需要任何调优。

## 窗口不是唯一的限制：`cwnd` 照样说话

真正的约束是 `min(cwnd, rwnd)`。`cwnd` 还小的时候，再大的窗口也没用；而 `cwnd` 一见丢
包就缩——在我这条局域网上它显然见到了（基线那一轮两秒 162 次重传；`ss` 抓取里
`cwnd:2964 ssthresh:2320` 那条处于拥塞避免的连接）。两者的失效方式不同：

- **受 rwnd 限制：** `Retr` 接近 0，`rwnd_limited%` 很高，`minrtt` 贴近基线 RTT。
  接收方的配额是天花板，放宽它。
- **受 cwnd 限制：** `Retr` 上升，`rtt` 明显高于 `minrtt`，`cwnd` 上下锯。那是
  [拥塞控制](/zh/posts/tcp-congestion-control/) 的地盘——BBR，或者把丢包修掉。

## 实用清单

按我的经验，诚实的回答是：**什么都别改，先证伪。**

1. **用算术复现。** `ping` 出 RTT，`iperf3` 出吞吐，算出 BDP。如果实测吞吐已经很接
   近 BDP，窗口就不是你的问题——到此为止。
2. **在真实传输中读 `ss -ti`。** `rwnd_limited` vs `Retr` vs `sndbuf_limited` 会告
   诉你是哪个限制在起作用。没测过的东西永远不要调。
3. **如果是 rwnd：** 接收方自动调优上限（`net.ipv4.tcp_rmem` 的 max）就是旋钮。把它
   提到覆盖 BDP——这里 32 MB 已经远超这条路径需要的 3.125 MB，所以默认那一轮零配置
   就跑到了 420 Mbit/s。
4. **如果你的应用显式设 `SO_RCVBUF`：** 记住 `rmem_max` 会封顶、内核会翻倍；真要
   按应用设置的值算，就把 `rmem_max` 也一起提。
5. **并行是正当的止血。** 客户端你能控制、服务端碰不到的时候，多开几条自带窗口的
   流，正是浏览器和下载管理器在做的事。
6. **只在链路又长又肥时调。** RTT 只有几毫秒时，默认窗口和自动调优早就把路径打满
   了；在那里每提一个 sysctl，只是把内存压力从网络挪到主机。

做完实验我删掉了容器；本文里每个数字，都是它们打印出来的。
