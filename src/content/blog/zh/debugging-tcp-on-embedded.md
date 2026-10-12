---
title: "调试 ESP32 TCP：lwIP 缓冲区、重传与嵌入式网络故障"
description: "一份 ESP32 TCP 调试实战指南：lwIP socket 缓冲区、Wi-Fi 重传与 Nagle/延迟 ACK 的相互作用如何造成卡顿、复位与半开连接；哪些统计与 Wireshark 视图能真正揭示 TCP 重传；附 ESP-IDF 代码片段与排查清单。"
pubDate: 2026-11-03
lang: zh
translationKey: debugging-tcp-on-embedded
tags: [networking, embedded, esp32]
featured: false
keywords:
  - ESP32 TCP
  - lwIP
  - TCP 重传
  - 嵌入式网络
  - TCP_NODELAY
  - keepalive
  - Wireshark
---

ESP32 上的 TCP 不是"小型 Linux 机器上的 TCP"。它是 **lwIP**——socket 缓冲区只有
几 KB；是一个会在你脚下悄悄重传帧的 Wi-Fi 驱动；是一个通常只有一个任务在处理
收发的应用。当 **ESP32 TCP** 卡顿、复位或变成半开连接时，原因几乎从不是协议本身，
而总是某个缓冲区、某个时序假设，或者一段 **嵌入式网络** 代码里的生命周期 bug——
这些 bug 在主机世界里你本可以忽略。我在这上面丢掉的夜晚比任何加密 bug 都多，而几乎
每一次，修复点都藏在一个我此前没有打开的统计计数器里。

这篇是我当初想要的那份走查：lwIP 默认值如何背叛你、一次 **TCP 重传** 究竟是怎么
产生的、哪些工具说真话，以及那些看起来像网络故障、其实是你自己写的连接生命周期错误。

## 为什么 ESP32 TCP 会出问题：极小的 socket 缓冲区与 lwIP 默认值

首先要内化的一点：在嵌入式 lwIP 上，窗口是一个配置值，而不是可用内存的函数。
`CONFIG_LWIP_TCP_WND_DEFAULT` 是向对端通告的接收窗口——通常只有 5–6 KB，有时更小。
`CONFIG_LWIP_TCP_SND_BUF_DEFAULT` 限制了未确认的飞行中数据量。只要其中任何一个小于
你链路的带宽时延积，吞吐就会崩塌，发送方会停在一扇满窗口之前，而对线上其实什么都没错。

```conf
# sdkconfig.defaults — 真正改变 TCP 行为的几个旋钮
CONFIG_LWIP_MAX_SOCKETS=16                 # 每个 socket 都吃 RAM，数清你的 CID 数
CONFIG_LWIP_TCP_MSS=1460
CONFIG_LWIP_TCP_WND_DEFAULT=11680          # 接收窗口：8 * MSS
CONFIG_LWIP_TCP_SND_BUF_DEFAULT=11680      # 飞行中发送缓冲区
CONFIG_LWIP_TCP_QUEUE_OOSEQ=y              # 缓存乱序段……
CONFIG_LWIP_TCP_SACK_OUT=y                 # ……或者用 SACK 告诉对端
CONFIG_LWIP_TCP_RECVMBOX_SIZE=32
CONFIG_LWIP_TCPIP_RECVMBOX_SIZE=32
CONFIG_LWIP_TCP_MSL=60000
CONFIG_LWIP_TCP_FIN_WAIT_TIMEOUT=20000
CONFIG_LWIP_STATS=y                        # 调试时不可关闭
```

还有两个默认值很关键。关掉 `CONFIG_LWIP_TCP_QUEUE_OOSEQ` 意味着丢失一个段就会让整个
流停住直到重传；打开则以 RAM 为代价保住排序器。另外，TCP/IP 任务与你的应用共享
CPU——一个更高优先级任务里的 `while(1)` 会饿死 lwIP，表现出来的就是丢 ACK。

## Wi-Fi 重传伪装成 TCP 故障

802.11 在 MAC 层重传，对 TCP 不可见：一个因干扰而丢的帧通常会被驱动在微秒内重发，
TCP 根本不会察觉。但一旦驱动 *耗尽* 重传预算，帧就真的丢了，**这时** TCP 才会看到
丢包。因此，一个重传计数很高的信道，表现出来就是随机的 RTT 尖峰和 RTO 超时，看起来
像服务器的问题。在动 TCP 之前，先看 RSSI 和 Wi-Fi 驱动统计；一条停在 −85 dBm、
不断重传的链路，才是所有下游症状的根因。

```c
wifi_ap_record_t ap;
esp_wifi_sta_get_ap_info(&ap);
ESP_LOGI(TAG, "rssi=%d ch=%d", ap.rssi, ap.primary);
/* TCP 的 RTO 每丢一次就翻倍；抖动的 RTT 是 Wi-Fi 问题，
   而不是拥塞问题。盯住 lwIP 统计里反复出现的 RTO。 */
```

也要注意反过来的陷阱：Wi-Fi 省电模式会让射频在信标之间休眠，凭空加上几十毫秒延迟。
在快速请求/响应流量下，这种延迟会触发虚假重传。先把省电关掉测一遍，再去怪协议栈。

## 读懂症状：卡顿、复位与半开连接

要学会辨认每种故障的签名，而不是一遇到"它坏了"就靠猜：

- **突发后卡死。** 发送方填满窗口，接收方应用从不调用 `recv()`，窗口降到零，发送方
  永远阻塞。症状：吞吐爬升后变成一条水平线。
- **半开连接。** 对端重启了，或 NAT/防火墙清掉了状态。你这边仍以为 socket 处于
  `ESTABLISHED`，往虚空中写入，直到撞上一次重传超时——往往是数分钟。
- **莫名其妙的 RST。** 通常是你自己的 bug：在对端仍在写入时关闭 socket，或复用了一个
  broker/服务器还占着的客户端 ID。
- **反复的 TCP 重传，数据段与 ACK 完全一致。** 真的丢包，或者 ACK 根本没回来，因为
  接收路径被饿死了。
- **窗口满 / 零窗口探测。** 这是接收端的背压。线路没问题，是你的消费者太慢。

最省时间的区分：每次都重传 *同一段* 序列号是路径问题，而"先慢后平"是缓冲区/应用问题。

## 说真话的工具

先在设备上开 lwIP 计数器。启用 `CONFIG_LWIP_STATS=y`，include `lwip/stats.h`，
定时或在某条连接出问题时把它们 dump 出来：

```c
#include "lwip/stats.h"
#include "lwip/priv/tcp_priv.h"

void tcp_dump_stats(void)
{
#if LWIP_STATS
    stats_display_proto(&lwip_stats.tcp, "TCP");
    /* 关注：xmit（发出的段数）、rexmit（重传）、
       drop、chkerr（校验和）、memerr（缓冲区耗尽）、
       rto（超时）。rexmit 上升且 memerr 也在涨，
       说明你缺的是缓冲区，不是带宽。 */
#endif
}
```

然后把视角移开一跳：在对端抓包，让 Wireshark 说出协议栈到底在干什么。`tcpdump` 写出
文件，而 Wireshark 的分析字段才让抓包可读：

```bash
# 在 ESP32 旁边的服务器/路由器上抓。 -s 0 保留完整载荷。
sudo tcpdump -i any -nn -s 0 -w esp32.pcap 'host 192.168.1.50 and tcp'

# 然后在 Wireshark 里，这几个显示过滤器就是全部要点：
#   tcp.analysis.retransmission      -> 真丢包，或 ACK 路径被饿死
#   tcp.analysis.fast_retransmission -> 重复 ACK，多半是乱序
#   tcp.analysis.zero_window         -> 接收端应用没有排空
#   tcp.analysis.window_full         -> 发送方停住，背压
#   tcp.flags.reset == 1             -> 突然拆连；先看是谁发的
#   tcp.len == 0 && tcp.flags.ack    -> keepalive 探测 vs 应用数据
```

要看 RTT 曲线图，而不是单个报文。呈锯齿且逐次翻倍的是重传退避；一条平线配周期性
尖峰的是射频重传。

## TCP_NODELAY、Nagle 与延迟 ACK 的对峙

这是嵌入式里最经典的相互作用。Nagle 算法会在前一个段未确认时扣住一个小段；而接收端
的延迟 ACK 又在等第二个段或一个定时器。如果你的应用以请求/响应的方式写小消息，你
就可能 *每次交互* 都卡上 40–200 ms——一个"慢网络"，其实是两个彬彬有礼的算法在互相等待。

在你可控的一侧修掉它：

```c
int one = 1;
setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
```

`TCP_NODELAY` 关闭 Nagle。对于话多的协议——MQTT、Modbus-over-TCP、自定义控制回路——
你需要打开它。但不要全局关掉之后又开始发大量小写入；应在应用缓冲区里合并，然后
一次性 flush。

## keepalive 与应用层心跳

TCP keepalive 是给 *死对端* 的存活探测，不是健康检查。在 lwIP 上你可以打开
`SO_KEEPALIVE` 并调定时器，但默认值是小时级，而且该探测只能发现"协议栈还在应答 TCP"
的对端。一个进程活着但已经卡死的对端，能通过每一次 keepalive。

```c
int idle = 10, intvl = 5, cnt = 3;   // ESP-IDF lwIP 上单位是秒
setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof(one));
setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE,  &idle,  sizeof(idle));
setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &intvl, sizeof(intvl));
setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT,   &cnt,   sizeof(cnt));
```

用 keepalive 在对端消失后回收半开 socket，并 *额外* 加一个应用层心跳（一条对端必须
应答的极小消息）来发现"socket 活着、进程已死"。如果什么都不超时，故障在上游：没有
keepalive、没有心跳，还有一个永不排空的接收窗口。

## Wi-Fi 上的 MTU 与分片

Wi-Fi 的 MTU 是 1500，但空口比有线多了一层开销，任何跑在 ESP32 上的隧道或 VPN 又会
再吃掉一部分。如果你把 MSS 设得太高，链路远未饱和就会出现静默黑洞或严重分片。这和
有线场景是同一种病，只是尾巴更长：[MTU、MSS 与路径 MTU 发现](/zh/posts/mtu-and-pmtud/)
是机制优先的版本，可直接套用。对于一台同时讲 overlay 协议的设备——比如我的
[用 C 把 ESP32-C3 做成 EasyTier 节点](/zh/posts/esp32-easytier-node-in-c/)——你要把
MSS 夹到隧道，而不是射频。

## 连接生命周期 bug：不排空、阻塞事件循环、泄露 socket

嵌入式硬件上的多数"TCP bug"，其实是穿着网络外衣的应用 bug：

- **不排空 socket。** 一条还有未读字节的 TCP 连接会占用接收窗口。一旦你停止调用
  `recv()`，对端就被阻塞。永远读到 `EAGAIN` 再去做别的。
- **阻塞事件循环。** 在 Wi-Fi 事件处理器或 lwIP 线程回调里做阻塞式 `recv()` 会拖住
  整个协议栈。用专门的 RX 任务、非阻塞 socket，或 `poll()`。
- **泄露 socket。** 每次 `socket()` 都消耗 `CONFIG_LWIP_MAX_SOCKETS` 中的一个名额和
  RAM。在重连路径上忘了 `close()`，池子很快耗尽，之后每条新连接都失败——症状读起来
  就像服务器拒绝连接。

```c
/* 非阻塞排空：绝不在一条活着的 socket 上留下缓冲字节。 */
fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
char buf[512];
for (;;) {
    int n = recv(fd, buf, sizeof(buf), 0);
    if (n > 0)      { handle(buf, n); continue; }
    if (n == 0)     { /* 对端关闭：close 并重连 */ break; }
    if (errno == EAGAIN || errno == EWOULDBLOCK) break;
    if (errno == EINTR) continue;
    /* ECONNRESET、ETIMEDOUT 等 */
    break;
}
close(fd);
```

## 排查清单

- [ ] 打开 `CONFIG_LWIP_STATS=y`，并能读到 `lwip_stats.tcp.rexmit` / `memerr`。
- [ ] 在碰 TCP 之前，先查 RSSI 与 Wi-Fi 重传计数。
- [ ] `CONFIG_LWIP_MAX_SOCKETS` ≥ 峰值并发数；每个 `close()` 都成对出现。
- [ ] 请求/响应协议打开 `TCP_NODELAY`；载荷由应用自行合并。
- [ ] `SO_KEEPALIVE` + 调好的 `TCP_KEEPIDLE/INTVL/CNT`，再加一个应用心跳。
- [ ] `recv()` 循环排空到 `EAGAIN`；不在 lwIP 线程上做阻塞读。
- [ ] 任何隧道/overlay 都夹 MSS；端到端验证 MTU。
- [ ] 在对端抓包，看 RTT 曲线与 `tcp.analysis.*`，而不是单个报文。

协议栈几乎从不说谎。当 ESP32 把你晾在那里时，它通常已经在某个计数器或某张曲线图里
告诉你：你让它做的事，缓冲区、射频或你自己的代码根本交付不了。
