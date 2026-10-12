---
title: "读懂你的第一次抓包：tcpdump + Wireshark，不再手足无措"
description: "一篇讲清怎么读第一次 packet capture：什么时候抓包比翻日志更管用，如何用 tcpdump（-i、BPF 过滤器、-w 存文件、snaplen）正确地抓，三次握手、重传、RST 与读不了的 TLS 字节在 Wireshark 里长什么样，以及一个“这条连接为什么慢”的实战排查例子。"
pubDate: 2026-11-06
lang: zh
translationKey: reading-a-packet-capture
tags: [networking, linux]
featured: false
keywords:
  - 抓包
  - tcpdump
  - Wireshark
  - 分析网络流量
  - BPF 过滤器
  - 重传
  - Follow TCP Stream
---

日志告诉你代码*以为*发生了什么，一份**抓包（packet capture）**告诉你线上实际传输了什么。当一个请求变慢、卡住或被重置，而日志又在粉饰太平，`tcpdump` 加 **Wireshark** 就是唯一能让你看到网络眼中那场对话的工具。第一次读它确实吓人——成千上万个包、满屏十六进制、一棵协议树——但你不需要全读。你大概只需要六个过滤器和三个故事：握手、重传、以及挥手。

这就是我从零开始**分析网络流量**的方式：什么时候该抓包、如何干净地抓、这些包到底在说什么、Wireshark 里哪几个功能最值得先学，以及一个针对我最常被问的问题——*这条连接为什么慢*——的实战例子。

## 什么时候抓包比翻日志更管用（以及什么时候不是）

当症状出现在你所控制的两个程序*之间*时就该抓包：服务端记下了请求、客户端记下了响应，可数字就是对不上。具体来说：

- **时序。** “API 调用花了 8 秒，但 handler 只跑了 40 毫秒。”这段差距就在线路上——一次重传、一个卡住的窗口、一步慢掉的 DNS/TLS，或者一次迟到的 accept。
- **静默丢包。** 到处没有报错、日志里也没有一行，就是超时。有东西丢了包，而且没告诉任何一端。
- **Reset 之谜。** `Connection reset by peer`，应用日志里却什么都没有。这个 RST 来自网络，不是你的代码。
- **握手失败。** TLS 还没等到 HTTP 出现就失败了，于是你框架的日志根本没开始记。

以下情况先别抓包：手上已有干净的调用栈（去读代码）、流量全是 TLS 1.3 而你想看的是 HTTP 载荷、或者你在共享链路上会抓到别人的流量。

我的准则：**日志回答“我的程序做了什么”；抓包回答“网络对它做了什么”。** 两者对不上时，听抓包的。

## 正确地抓包：tcpdump、接口、BPF 过滤器与文件

### 选对接口，并且优先加 `-n`

```bash
# 列出接口（不需要 root）：
tcpdump -D

# 在一个接口上抓包，数值输出，不做 DNS 解析：
sudo tcpdump -i eth0 -n
```

`-i any` 一次抓所有接口，但会带上 Linux 的 cooked 头，丢掉链路层细节；在服务器上还是点名接口。`-n` 会关掉主机名和端口的解析——在空闲链路上，那个解析花的时间比你要看的包还长。

### BPF 过滤器不是可选项

在繁忙主机上不加过滤地抓包就是开消防栓。**BPF 过滤器**（Berkeley Packet Filter）是 `tcpdump` 交给内核的表达式，不匹配的包根本不会被复制到用户态：

```bash
# 一个主机、一个端口。最基本的那条过滤器。
sudo tcpdump -i eth0 -n 'host 10.0.0.5 and port 443'

# 双向的整场对话，HTTP 或 HTTPS：
sudo tcpdump -i eth0 -n 'host 10.0.0.5 and (port 80 or port 443)'

# 子网与子网之间，顺手把 SSH 的噪声滤掉：
sudo tcpdump -i eth0 -n 'net 10.0.0.0/24 and not port 22'

# 只要连接建立/拆除的控制包（置了 SYN/FIN/RST 的）：
sudo tcpdump -i eth0 -n 'tcp[tcpflags] & (tcp-syn|tcp-fin|tcp-rst) != 0'
```

按你能说出的**最窄**条件过滤。`host` 和 `port` 便宜又好读；只有确实要看控制面包时才用 `tcp[tcpflags]`。开始前就把主机和端口定下来，因为回头重扫一个 2 GB 的文件是场灾难。

### 写进文件，并留意 snap 长度

要正经研究的，就抓进文件再用 Wireshark 打开。这是我唯一每次都会用 `sudo` 的地方：

```bash
# -s 0 = 抓整包（不截断）。-c 500 = 抓满 500 个包就停。
sudo tcpdump -i eth0 -n -s 0 -c 500 \
  -w /tmp/slow-api.pcap 'host 10.0.0.5 and port 443'

# 在另一个终端里，边写边看：
sudo tcpdump -r /tmp/slow-api.pcap -n
```

**Snap 长度（`-s`）**是每个包保存多少字节。`-s 0` 表示“全都要”，在现代机器上就用它。老式的 96 字节默认值够放头和 TCP 控制标志，却会悄悄截断 TLS 记录，于是你永远拼不出一个流。如果抓包看起来完整、但 Follow TCP Stream 出来的是乱码，先查 snap 长度。

**时间戳。** 默认给的是类似 epoch 的秒数；让它可读，并把你抓包的机器时钟对齐：

```bash
# 每一行都带上可读的日期时间，用 UTC：
sudo tcpdump -i eth0 -n -tttt -w /tmp/cap.pcap 'port 443'

# 确认两端时间一致（抓包对齐全靠它）：
timedatectl status | grep -i 'system clock\|NTP'
```

### 能的话，两端都抓

对新手抓包习惯最有用的一步升级：**在客户端和服务端同时跑 `tcpdump`。** 一个报文段离开客户端却没到服务端，那是网络问题；到了服务端却一直没被回复，那是服务端问题。单侧抓包分不清这两者——这也正是让[单侧的 traceroute 会骗人](/zh/posts/traceroute-lies/)的同一个道理。

```bash
# 客户端与服务端，同一个墙钟窗口，各自写文件：
# 客户端：
sudo tcpdump -i eth0 -n -w /tmp/cap-client.pcap 'host 203.0.113.9 and port 443'
# 服务端：
sudo tcpdump -i eth0 -n -w /tmp/cap-server.pcap 'host 198.51.100.7 and port 443'
```

## 你在 Wireshark 里会看到的结构

打开文件，Wireshark 会列出一个个包。每一条普通 TCP 连接讲的都是同一个短故事。

**三次握手。** 客户端发 `SYN`、服务端回 `SYN/ACK`、客户端再回 `ACK`。连接就是在这里诞生（或没有诞生）的。如果你只看到一个 `SYN`、然后又是一个 `SYN`，却没有 `SYN/ACK`，那服务端从没应答——或者它的应答从没回来。

**序列号与 ACK。** TCP 流里的每个字节都有序列号。Wireshark 默认显示*相对*序列号（`Seq=1`、`Seq=1461`），于是你读的是它们之间的关系，而不是巨大的绝对计数。**`Ack=` 字段是一句不断更新的“到此为止我都收到了”。** 数据流动时看它往上爬，就是一场健康的对话。当同一个 `Seq=` 带着同样的载荷再次出现，那就是一次**重传**——发送方认定有个报文段丢了。

**重传。** 被标红的那些行，通常是 `[TCP Retransmission]`。偶尔一个算噪声；成片出现才是信号——某个有丢包的一跳、一条慢链路，或者一个窗口满了的接收方。这是抓包能告诉你的最有价值的东西，也是下面实战例子的核心。反复出现同样大小的报文段，也是 MTU 黑洞的标志，所以这篇和 [MTU 与路径 MTU 发现](/zh/posts/mtu-and-pmtud/)最好一起读。

**RST。** 一个 `RST` 把连接直接掐断：对端在有数据在途时关了 socket、有防火墙注入了 reset、或是对端崩了。它就是刻意地粗暴——没有礼貌的挥手，只有“停”。

**FIN/ACK 挥手。** 优雅关闭：一侧发 `FIN, ACK`、对端回 `ACK`，然后另一侧同样来一遍。如果一次握手之后，紧跟着一个从未发过任何字节的一侧发来的 `FIN`，那就是某个应用在开它并不用的连接。

**你读不了的 TLS 字节。** 握手之后几乎一切都是不透明的 `TLS` 记录——先是 `Client Hello`（它的 SNI 仍能告诉你请求的是哪个主机名），然后是 Wireshark 没有 key log 就解不开的 `Application Data`。这没关系：时序、尺寸、reset 和重传都还在，即便载荷是一堵密文墙，它们也能解释掉大多数“慢”的 bug。

## 最该先学会的 Wireshark 功能

你不需要整个工具栏。五样东西覆盖第一周调试的 95%。

**显示过滤器 vs 抓包过滤器。** 它们是两套语言。*抓包*过滤器（`host 10.0.0.5 and port 443`）是 BPF，决定记下什么；*显示*过滤器（`ip.addr == 10.0.0.5 && tcp.port == 443`）只是把已经抓到的行藏起来。当列表空空如也时，先看你有没有把抓包过滤器敲进了显示栏。

**Expert Information。** `Analyze → Expert Information` 把整份抓包收拢成警告与提示：重传、重复 ACK、零窗口、reset。第一次阅读时，这是不扫五千行就找到异常的最快办法。

**`tcp.analysis.retransmission`。** 最值回票价的显示过滤器——它只显示发送方不得不重发的报文段，是我在慢连接抓包上敲的第一样东西：

```text
tcp.analysis.retransmission
tcp.analysis.duplicate_ack
tcp.analysis.zero_window
tcp.flags.reset == 1
```

第一条抓住丢包，第二条是接收方在喊“我少了点东西”，第三条是接收方叫发送方停下，第四条把所有 reset 收到一张清单里。知道连接编号后，加 `tcp.stream eq N` 就能锁定单条连接。

**Follow TCP Stream。** 右键任意包 → **Follow → TCP Stream**。Wireshark 把这条双向对话重组成一个窗口：客户端字节一种颜色，服务端字节另一种颜色。对未加密协议，这是整场交换的完整记录；对 TLS，你仍能看到每侧发了多少字节、以及对话在哪里停住。

## 分析网络流量：实战“这条连接为什么慢？”

经典工单：*“手机客户端上传到我们 API 花了 12 秒。服务端说它在 200 毫秒内就处理完了。”* 两边说的都是真话。两端各抓一份，差距自己就会说明问题。

```bash
# 同一个窗口抓两端，整包，过滤器收紧：
# 客户端：
sudo tcpdump -i any -n -s 0 -w /tmp/up-client.pcap 'host 203.0.113.9 and port 443'
# 服务端：
sudo tcpdump -i eth0 -n -s 0 -w /tmp/up-server.pcap 'host 198.51.100.7 and port 443'
```

先打开服务端的抓包，找重传：

```text
tcp.analysis.retransmission
```

假设它是空的——服务端这侧没有丢包。把同一条过滤器放到客户端抓包上。如果也是空的，线路就没在丢包，转而看*时序*。按 `Time` 列排序，量一下客户端第一个数据段与服务端第一个 ACK 之间的间隔：要是服务端在数据到达 6 秒后才确认，那就是内核收到了、应用却没读——接收窗口满了、handler 被阻塞，或者一次慢的磁盘写。用窗口字段确认：

```text
tcp.analysis.zero_window
tcp.window_size_value < 1000
```

`[TCP ZeroWindow]` 这行意味着接收方宣告了零字节窗口——“停，我收不下了。”发送方于是暂停，应用便看到一次很慢的请求，尽管每个包都到了。这是**接收侧的问题**：该修的是接收缓冲区或消费者，而不是网络。反过来，若客户端抓包里反复出现 `[TCP Retransmission]`，而服务端抓包显示这些报文段都好好的，那就是一个单方向的丢包跳：路由或运营商的问题，不是应用。

若时序是每个往返之前都有一道干净的 300 毫秒间隔，那不是 bug——那是距离加上一个很小的初始窗口：是延迟，不是丢包。要修的是拥塞窗口，或者把端点挪近。

## 求助之前的一份短清单

- **先过滤再抓。** 主机和端口，不要整块网卡。
- **`-s 0`**，这样文件在 Wireshark 里才真的有用。
- **两端都抓**并对齐时钟；单侧抓包无法定责。
- **先读握手**，再看重传，最后看关闭。
- **显示过滤器，不是抓包过滤器**——当什么都没出现时。
- 任何“慢”的抱怨，**先 `tcp.analysis.retransmission`**。
- 用 **Follow TCP Stream** 停止按行思考，开始读一整场对话。

抓包不是要背下来的消防栓——它只是三个短故事和五个过滤器。学会这些，那堵十六进制墙就会变成你手上最清晰的调试日志。
