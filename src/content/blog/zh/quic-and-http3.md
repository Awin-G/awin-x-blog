---
title: "QUIC 与 HTTP/3 详解：到底改变了什么"
description: "一次讲清 QUIC 与 HTTP/3：它们要解决的 TCP 队头阻塞、握手过慢与中间盒僵化，基于 UDP、内建 TLS 1.3、流与连接迁移，0-RTT 与 1-RTT 握手、QPACK，以及 nginx 与 Caddy 里的 UDP 443 运维和测试方法。"
pubDate: 2026-11-30
lang: zh
translationKey: quic-and-http3
tags: [networking, nginx]
featured: false
keywords:
  - QUIC
  - HTTP/3
  - TCP 队头阻塞
  - 连接迁移
  - 0-RTT
---

每当一个页面在不稳定的 Wi-Fi 下加载得比"应该"的更快，背后很可能就是 **QUIC** 与 **HTTP/3** 在起作用。这两个名字总是一起出现，但它们处于不同的层，而 HTTP/3 之所以存在，根源是 TCP 里一个具体且可测量的缺陷：**TCP 队头阻塞**。我一直在给自己跑的服务逐步开启 HTTP/3，诚实的总结是：它把一小类问题解决得非常好，代价是你在 UDP 上多背了一套运维麻烦，而且它并不是一把万能降延迟的开关。这篇讲的就是到底改变了什么——逐个协议地讲，外加如何在你自己服务器上测试和观察。如果底层的密码学对你来说是新东西，我那篇 [TLS 1.3 握手](/zh/posts/tls-1-3-handshake/) 是前置阅读；QUIC 本质上就是把那套握手和一个传输层焊在了一起。

## QUIC 到底解决了什么

三个由来已久的抱怨，大致按重要性排序。

### TCP 队头阻塞

TCP 交付的是**一条有序的字节流**。如果第 2 段丢了，第 3、4、5 段可能早就到了，但在第 2 段被重传、缺口被填上之前，TCP 一个字节都不会交给应用层。在干净链路上你根本感觉不到。而在有丢包的链路上，每一次丢包都会卡住它后面的*一切*，哪怕这些数据和丢失的字节毫无关系。

HTTP/2 本来想用"在一条 TCP 连接上多路复用多个请求"来解决这个问题——结果在有丢包的链路上反而**更糟**。几十条流现在共享同一条有序字节流，于是一个丢包会同时冻结它们全部。这就是 QUIC 要干掉的问题：它把多路复用挪到顺序保证*之下*，放进彼此独立的流里。

<figure>
<svg viewBox="0 0 680 250" width="100%" role="img" aria-label="TCP 交付一条有序字节流，因此单个丢失的段会卡住它后面的一切；QUIC 多路复用彼此独立的流，所以一个丢包只阻塞它自己所属的那条流。">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="20" y="26" font-weight="600">TCP：一条有序字节流</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.5">
    <rect x="20"  y="42" width="150" height="46" rx="8"/>
    <rect x="190" y="42" width="150" height="46" rx="8" stroke-dasharray="6 5"/>
    <rect x="360" y="42" width="150" height="46" rx="8"/>
    <rect x="530" y="42" width="130" height="46" rx="8"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="95"  y="70" text-anchor="middle">段 1</text>
    <text x="265" y="70" text-anchor="middle">段 2 ✗ 丢失</text>
    <text x="435" y="70" text-anchor="middle">段 3</text>
    <text x="595" y="70" text-anchor="middle">段 4</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5" opacity="0.75">
    <text x="300" y="108" text-anchor="middle">缺口之后的一切都被缓冲、不予交付，直到段 2 被重传</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="20" y="152" font-weight="600">QUIC：彼此独立的流</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none">
    <g fill="currentColor" fill-opacity="0.16">
      <rect x="20"  y="166" width="95" height="40" rx="7"/>
      <rect x="224" y="166" width="95" height="40" rx="7" stroke-dasharray="6 5"/>
      <rect x="428" y="166" width="95" height="40" rx="7" fill-opacity="0.06"/>
    </g>
    <g fill="currentColor" fill-opacity="0.05">
      <rect x="122" y="166" width="95" height="40" rx="7"/>
      <rect x="326" y="166" width="95" height="40" rx="7"/>
      <rect x="530" y="166" width="95" height="40" rx="7"/>
    </g>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="67"  y="191" text-anchor="middle">A1 ✓</text>
    <text x="169" y="191" text-anchor="middle">B1 ✓</text>
    <text x="271" y="191" text-anchor="middle">A2 ✗ 丢失</text>
    <text x="373" y="191" text-anchor="middle">B2 ✓</text>
    <text x="475" y="191" text-anchor="middle">A3 ⏸</text>
    <text x="577" y="191" text-anchor="middle">B3 ✓</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5" opacity="0.75">
    <text x="340" y="228" text-anchor="middle">只有流 A 在等它自己的重传；流 B 越过缺口继续流动</text>
  </g>
</svg>
<figcaption>在 TCP 下，顺序是"每连接"的，所以一个丢失的段会冻结所有多路复用的请求。QUIC 的顺序是<strong>每流</strong>的，因此一次丢包只卡住它所属的那条流——其他流的包会立即被交付。</figcaption>
</figure>

### 握手太慢

建立一条经典的 HTTPS 连接，在应用数据的第一个字节之前要花**两个往返**：一个 RTT 用于 TCP 握手，再来一个用于 TLS 握手。QUIC 把两者合二为一——传输层握手*就是* TLS 1.3 握手——所以全新连接是一个 RTT，恢复连接可以是零。在 200 ms 的移动网络 RTT 下，这意味着每一次冷连接都省下几百毫秒，而这恰恰是用户能感知到的那类连接。

### 僵化的中间盒

TCP 的头部是固定的，全世界的防火墙、NAT 和"安全"设备都在检查它。新增的 TCP 选项会被那些从没见过它的中间盒悄悄丢弃，这就是传输层创新停滞了二十年的原因——这个问题的名字就叫**协议僵化（protocol ossification）**。QUIC 绕开了它：把内容放进 UDP 载荷里，并加密几乎全部自己的头部。于是中间盒看到的只是一个不透明的 UDP 流，无法有选择地破坏新扩展。这个选择的代价，就是我后面要讲的运维现实。

## QUIC 是什么

QUIC 是一个通用传输协议，与 HTTP/3 一同标准化；把它理解成三个刻意的决定最容易。

### 用 UDP 而不是 TCP

QUIC 在**用户态、基于 UDP** 运行，把 TCP 过去做的事——可靠性、有序、拥塞控制、重传——重新实现成一个库。这让它无需内核或操作系统升级就能部署，也能以应用发版的速度演进。UDP 只是容器；可靠性逻辑全部属于 QUIC 自己。

### 内建 TLS 1.3

TLS 1.3 不是叠在 QUIC 之上，而是它的一部分。QUIC 用 TLS 1.3 握手来派生密钥，但用自己的一套包格式承载这些消息，而不是 TLS 记录层。这就是为什么 QUIC 里没有"TLS over TCP"、没有独立的记录层，也是为什么它的安全审查与我那篇 [TLS 1.3](/zh/posts/tls-1-3-handshake/) 里的审查高度重叠。

### 流与连接 ID

QUIC 在包内承载**帧**——`STREAM`、`ACK`、`CRYPTO`、`MAX_DATA`。一条连接包含许多**流**，每条流独立有序、独立做流控，所以上面那张图在协议层是成立的。而一条连接是由**连接 ID** 命名的，不是由 IP+端口的四元组命名的。正是这种解耦，让**连接迁移**成为可能。

## 构建在 QUIC 之上的 HTTP/3

HTTP/3 就是 HTTP 语义——方法、状态码、头部，以及我那篇 [HTTP 缓存](/zh/posts/http-caching/) 笔记里的全部缓存规则——承载在 QUIC 流之上。下面没有 TCP，也没有 TLS 记录层；每一个请求/响应跑在自己的 QUIC 流上，所以一个卡住的响应不会再像 HTTP/2-over-TCP 那样阻塞其他响应。

另一个肉眼可见的变化是头部压缩。HTTP/2 用的是 **HPACK**，它的动态表是有状态且对顺序敏感的：头部必须按编码时的顺序解码。这就在*头部*这一层重新引入了队头阻塞。HTTP/3 用 **QPACK** 替换它，通过专用单向流发送表更新来保住压缩率，于是一个乱序包不再会卡死头部解码器。如果你曾好奇为什么一个协议需要一种新的压缩方案来逃离它自己刚引入的问题，原因就在这里。

## 0-RTT 与连接迁移

首次 QUIC 连接是 **1-RTT**：客户端的 `CRYPTO` 帧承载 TLS 1.3 的 ClientHello，密钥协商和传输协商在一个往返内一起完成。恢复连接时，保存的会话票据让客户端可以立刻发送 **0-RTT** 早期数据。代价与 TLS 1.3 完全一样：0-RTT 数据可被重放，并且放弃了前向保密，所以对任何会改变状态的请求我都不允许它——只用于只读的 `GET`。

**连接迁移**是更有意思的承诺。因为连接由其连接 ID 标识，客户端可以切换网络——从 Wi-Fi 到蜂窝、从一个 IP 到另一个 IP——并保持*同一条*流继续存活，而不是重新连接。服务器会在信任新路径之前先验证它，所以伪造的源地址无法被用作反射放大。落到实际：一次视频通话或一次大文件下载，能在你手机掉 Wi-Fi 的瞬间存活下来，没有可见的卡顿。

## 它在运维上意味着什么

### UDP 443 必须真的能用

HTTP/3 监听在 **UDP 443**，而第二天的麻烦全在这里：

- **UDP 被拦。** 企业网络、部分酒店和加固过的防火墙会拦截或限速 UDP 443。这就是 HTTP/3 需要通过 `Alt-Svc` 在 TCP 上做通告、以及客户端必须能无停顿地回退到 TCP 的原因。
- **NAT 超时。** 在许多 NAT 里，UDP 流的过期比 TCP 快，所以长时间空闲的 QUIC 连接会悄悄死掉。保活可以缓解；有时对某个位于 NAT 后的客户端关掉 HTTP/3 才是最务实的答案。
- **放大与限速。** QUIC 的 Initial 包会被填充到 1200 字节，并且在服务器大量发送之前要求一个已验证的令牌，这限制了放大攻击。但你的边缘仍然需要感知 UDP 的 DDoS 过滤和速率限制，因为"它是 UDP"并不是一套安全模型。
- **中间盒公平性。** 有些网络会给 UDP 降优先级，所以一个健康的 HTTP/3 部署仍然需要 TCP 回退路径。

### nginx 与 Caddy

nginx 从 1.25 起获得 HTTP/3。下面是一个同时在 UDP 与 TCP 443 上对外**通告** HTTP/3 的最小 TLS 服务器长什么样：

```nginx
# /etc/nginx/conf.d/blog.conf  (nginx >= 1.25)
server {
    listen 443 ssl;
    listen 443 quic reuseport;          # HTTP/3 跑在 UDP 443 上
    http2 on;
    server_name blog.awin-x.top;

    ssl_certificate     /etc/letsencrypt/live/blog.awin-x.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/blog.awin-x.top/privkey.pem;

    # 向仍在 TCP 上的客户端通告 HTTP/3：
    add_header Alt-Svc 'h3=":443"; ma=86400' always;

    location / { root /srv/blog; }
}
```

别忘了防火墙规则，否则上面全白搭：

```bash
# 除 TCP 443 外，也要放行 UDP 443
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
```

Caddy 是另一个极端——只要站点有 TLS，HTTP/3 就默认开启，无需任何额外配置。对小型部署来说，这份省心就是选择 Caddy 的好理由；而当我需要更精细的控制时，才会去调 nginx。

## 诚实的现状

如今支持面已经很广：所有主流浏览器、用 QUIC 库编译的 `curl`，以及主要的服务器和 CDN。难的部分在于调试，以及知道什么时候该把它关掉。

调试确实更难。线上大部分内容是加密的，所以经典的 443 端口抓包给不了你太多信息。真正有用的工具是懂协议的 `curl`、**qlog** 格式，以及配合会话密钥日志的 Wireshark：

```bash
# 这台服务器到底说不说 HTTP/3，又是否对外通告？
curl -V                                  # 在特性列表里找 HTTP3
curl --http3 -sI https://blog.awin-x.top | grep -i alt-svc
# 示例输出：
# alt-svc: h3=":443"; ma=86400

# 抓取并过滤 QUIC，再用密钥日志解密做更深入的分析
sudo tshark -i eth0 -f 'udp port 443' -w quic.pcapng
# 客户端侧：SSLKEYLOGFILE=/tmp/keys.log <浏览器或 curl>
# Wireshark：Preferences → Protocols → TLS → (Pre)-Master-Secret log filename
```

你也可以把 `openssl s_client` 指向一个 QUIC 端点，直接跑一遍握手；而 Chromium 的 `chrome://net-export` 会精确导出哪条连接用了 h3、又在哪里发生了回退。

```bash
openssl s_client -quic -connect blog.awin-x.top:443 \
  -servername blog.awin-x.top -alpn h3 </dev/null 2>&1 | head
```

那它什么时候**没**用？在无丢包的干净本地网络里，差异几乎等同于噪声——QUIC 的收益来自丢包和新建连接，而不是稳态吞吐。如果客户端已经有一条热连接，握手的节省早就落袋为安了。极高的单流吞吐甚至可能倒退，因为用户态 UDP 处理与加密比内核的 TCP 路径更费 CPU。而如果你用户所在的网络封了 UDP 443，你就为一条回退路径白白付出了全部复杂度。正确的默认是*提供* HTTP/3 让客户端自己选，而不是强制它。

## 我实际会检查什么

我在开启或调试 HTTP/3 时的循环：

1. 确认服务器在 UDP 443 上监听，且主机防火墙放行。
2. 确认 TCP 响应里通告了 `Alt-Svc`。
3. 用 `curl --http3` 测试，并与强制 `--http1.1` 的基线对比。
4. 只在确实出问题时才用 `tshark`/qlog 抓包——并做好"需要密钥日志才能读懂任何东西"的准备。

QUIC 并没有重造 HTTP。它修掉了两个具体的传输层缺陷——每流有序与握手往返——并为这个修补付出了你现在要亲自承担的 UDP 运维面。搞清楚你的哪些用户处在有丢包的链路上，对外通告 h3，保持 TCP 路径健康，这个改变就值得。
