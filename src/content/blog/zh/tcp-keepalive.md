---
title: "TCP Keepalive 与心跳：服务器如何发现对端已死"
description: "半开连接可能滞留数小时。通过真实实验和计时数据，了解 TCP keepalive（SO_KEEPALIVE、TCP_KEEPIDLE）和应用层心跳如何检测死对端。"
pubDate: 2027-01-08
lang: zh
translationKey: tcp-keepalive
tags: [networking, linux]
featured: false
keywords:
  - TCP keepalive
  - 半开连接
  - TCP_KEEPIDLE
  - 心跳
  - SO_KEEPALIVE
---

你一定遇到过这种情况：服务器卡在一个永远不返回的 `recv()` 上，客户端早就消失了，却没人察觉。这就是**半开连接**问题，它是网络系统中最常见的静默故障之一。本文将展示对端不打招呼就消失时到底发生了什么、**TCP keepalive** 如何尝试解决它，以及为什么**应用层心跳**才是真正的答案。

## 什么是半开连接？

半开连接是指 TCP 连接的一方在没有发送 FIN 或 RST 的情况下消失。另一方完全不知道出了问题——从它的视角看，连接仍然是建立且健康的。

<figure>
<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="半开连接与 TCP keepalive 探测的时间线">
  <line x1="40" y1="60" x2="680" y2="60" stroke="currentColor" stroke-width="2"/>
  <line x1="40" y1="170" x2="680" y2="170" stroke="currentColor" stroke-width="2" stroke-dasharray="4 3"/>
  <!-- Server events -->
  <circle cx="80" cy="60" r="6" fill="#0f766e"/>
  <text x="80" y="40" text-anchor="middle" font-size="12" fill="currentColor">服务器 accept</text>
  <circle cx="240" cy="60" r="6" fill="#0f766e"/>
  <text x="240" y="40" text-anchor="middle" font-size="12" fill="currentColor">客户端发送数据</text>
  <circle cx="400" cy="60" r="6" fill="#0f766e"/>
  <text x="400" y="40" text-anchor="middle" font-size="12" fill="currentColor">客户端消失（无 FIN）</text>
  <circle cx="560" cy="60" r="6" fill="#0f766e"/>
  <text x="560" y="40" text-anchor="middle" font-size="12" fill="currentColor">Keepalive 放弃</text>
  <!-- Client events -->
  <circle cx="80" cy="170" r="6" fill="#0f766e"/>
  <text x="80" y="200" text-anchor="middle" font-size="12" fill="currentColor">connect()</text>
  <circle cx="240" cy="170" r="6" fill="#0f766e"/>
  <text x="240" y="200" text-anchor="middle" font-size="12" fill="currentColor">send()</text>
  <circle cx="400" cy="170" r="6" fill="currentColor"/>
  <text x="400" y="200" text-anchor="middle" font-size="12" fill="currentColor">SIGKILL / 断电</text>
  <!-- Probes -->
  <line x1="420" y1="60" x2="420" y2="170" stroke="#0f766e" stroke-width="1" marker-end="url(#arrow)"/>
  <line x1="460" y1="60" x2="460" y2="170" stroke="#0f766e" stroke-width="1" marker-end="url(#arrow)"/>
  <line x1="500" y1="60" x2="500" y2="170" stroke="#0f766e" stroke-width="1" marker-end="url(#arrow)"/>
  <text x="460" y="120" text-anchor="middle" font-size="10" fill="#0f766e">探测包</text>
  <defs>
    <marker id="arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#0f766e"/>
    </marker>
  </defs>
</svg>
<figcaption>半开连接：客户端在没有发送 FIN 的情况下消失。服务器的 keepalive 探测无人应答，直到内核声明对端死亡。</figcaption>
</figure>

这理论上罕见，但实践中极为常见。以下是真实场景：

- **进程被杀**：`SIGKILL`、OOM killer 或硬崩溃。操作系统可能发 FIN，也可能不发，取决于时机。
- **NAT 状态丢失**：NAT 网关或防火墙在空闲超时后静默遗忘连接映射。服务器的数据包被丢入虚空。
- **断电 / 网络分区**：对端机器断电或网络中断。没有 FIN，没有 RST，什么都没有。
- **移动设备休眠**：手机进入深度睡眠，TCP 协议栈停止响应。

在所有这些场景中，服务器的 socket 仍然处于 `ESTABLISHED` 状态。阻塞的 `recv()` 会永远等待。连接池会把死连接交给下一个毫不知情的调用者。

## TCP 为什么没有内置的存活检测

TCP 设计于网络可靠、端点可信的时代。协议没有内置的"你还在吗？"机制。服务器得知对端消失的唯一途径是：

1. 对端发送 FIN（优雅关闭）
2. 对端发送 RST（中止）
3. 服务器尝试发送数据并收到 ICMP 错误
4. 服务器自身的 TCP 协议栈重传超时（可能超过 15 分钟）

如果对端 simply 消失——没有 FIN，没有 RST——以上都不会触发。连接就那样开着、无用，直到有其他东西介入。

我跑了一个简单实验来演示。Python 服务器接受连接，客户端发一条消息然后被 `SIGSTOP` 冻结（模拟一个永远不发 FIN 的挂起进程）：

```text
[server] listening on 127.0.0.1:18923
[client] connected, sent data, pid=613965 — now sleeping forever
[server] accepted connection from ('127.0.0.1', 44866)
[server] recv: b'hello from client'

--- ss -o BEFORE client freeze ---
Netid Recv-Q Send-Q Local Address:Port  Peer Address:Port
tcp   0      0          127.0.0.1:18923    127.0.0.1:44866

[experiment] freezing client pid=613965 with SIGSTOP (no FIN, no RST)...
[experiment] client is frozen. Server still thinks connection is open.

--- ss -o AFTER client freeze ---
Netid Recv-Q Send-Q Local Address:Port  Peer Address:Port
tcp   0      0          127.0.0.1:18923    127.0.0.1:44866

[server] now calling recv() — will block because no FIN arrived...
[server] recv TIMED OUT after 5.00s — connection is half-open, server has no idea peer is dead
```

`ss -o` 输出显示客户端冻结后连接仍然是 `ESTABLISHED`。服务器的 `recv()` 阻塞直到超时。如果没有超时，它会永远等待。

## TCP Keepalive：SO_KEEPALIVE 和三个旋钮

Linux 提供了内核级的 **TCP keepalive** 机制。在 socket 上启用后，内核在连接空闲时发送周期性探测包。如果对端在多次探测后仍无响应，内核声明连接死亡并唤醒任何阻塞的 `recv()`。

启用它需要 `SO_KEEPALIVE` 加三个调优旋钮：

```python
import socket

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)

# 空闲连接首次探测前的秒数
sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 2)

# 探测之间的秒数
sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 1)

# 声明死亡前的失败探测次数
sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)
```

使用这些设置，内核等待 2 秒空闲时间，然后每 1 秒发送一次探测。3 次探测失败后（总共约 5 秒），连接被声明死亡。

你可以用 `ss -o` 看到 keepalive 计时器：

```text
Netid Recv-Q Send-Q            Local Address:Port  Peer Address:Port
tcp   0      0                     127.0.0.1:18924    127.0.0.1:36822 timer:(keepalive,1.997sec,0)
```

`timer:(keepalive,1.997sec,0)` 字段显示内核的 keepalive 计时器在倒计时。归零时发送探测，计时器重置。

以下是启用 keepalive 并冻结客户端的完整实验：

```text
[server] listening on 127.0.0.1:18924
[client] connected, pid=614003 — sleeping forever
[server] accepted from ('127.0.0.1', 36822)
[server] enabled SO_KEEPALIVE, TCP_KEEPIDLE=2, TCP_KEEPINTVL=1, TCP_KEEPCNT=3

--- ss -o with keepalive timer ---
Netid Recv-Q Send-Q            Local Address:Port  Peer Address:Port
tcp   0      0                     127.0.0.1:18924    127.0.0.1:36822 timer:(keepalive,1.997sec,0)

[experiment] freezing client pid=614003 with SIGSTOP...
[server] calling recv() — keepalive probes should detect frozen peer...
[server] recv TIMED OUT after 15.01s
```

在回环上，内核会 ACK 自己的探测（冻结进程的 TCP 协议栈仍在内核层面响应），所以 keepalive 不会触发。在真正对端消失的真实网络上，探测无人应答，内核在约 5 秒后声明连接死亡。

### 默认 2 小时空闲问题

问题在于：Linux 默认的 `TCP_KEEPIDLE` 是 **7200 秒（2 小时）**。默认间隔 75 秒，默认次数 9 次探测。这意味着死对端在 2 小时内完全不被察觉，最坏情况下 2 小时 + 9×75 秒 ≈ 2 小时 11 分钟后才声明连接死亡。

对大多数应用来说，这没用。一个 keepalive 超时 2 小时的 Web 服务器会愉快地为死连接服务数小时，耗尽文件描述符和内存。

## 应用层心跳：真正的答案

如果需要及时的故障检测，**应用层心跳**是标准解决方案。思路很简单：应用在 TCP 之上定义 ping/pong 协议。如果 ping 超时无应答，应用关闭连接。

这是一个最小心跳实现：

```python
import socket, time

PING_INTERVAL = 1.0   # ping 之间的秒数
PING_TIMEOUT = 2.0    # 等待 pong 的秒数
MAX_MISSED = 3        # 声明死亡前的丢失 ping 次数

last_ping = time.monotonic()
missed = 0

while True:
    now = time.monotonic()
    if now - last_ping >= PING_INTERVAL:
        sock.sendall(b'ping')
        last_ping = now

    sock.settimeout(PING_TIMEOUT)
    try:
        data = sock.recv(1024)
        if data == b'pong':
            missed = 0
        elif data == b'':
            break  # 正常关闭
    except socket.timeout:
        missed += 1
        if missed >= MAX_MISSED:
            break  # 对端已死
```

以下是针对冻结客户端运行的真实输出：

```text
[server] listening on 127.0.0.1:18925
[client] connected, pid=613966 — sleeping forever (no heartbeat)
[server] accepted from ('127.0.0.1', 55276)
[server] starting application-level heartbeat: ping every 1s, timeout 2s

[experiment] freezing client pid=613966 with SIGSTOP...
[server] heartbeat timeout #1 at t=0.0s
[server] sent ping at t=2.0s
[server] heartbeat timeout #2 at t=2.0s
[server] sent ping at t=4.0s
[server] heartbeat timeout #3 at t=4.0s
[server] DECLARED PEER DEAD after 3 missed heartbeats (4.0s total)
```

应用在 4 秒内检测到死对端。这才是生产环境中真正需要的及时检测。

## TCP Keepalive 与应用心跳对比

| 方面 | TCP Keepalive | 应用心跳 |
|---|---|---|
| 检测时间 | 分钟到小时（可调） | 秒级（完全可控） |
| 粒度 | 每 socket，内核级 | 每连接，应用逻辑 |
| 流量开销 | 最小（小探测包） | 取决于协议设计 |
| 穿越 NAT | 可以（如果 NAT 超时 > 空闲时间） | 可以（如果 NAT 超时 > 间隔） |
| 误报 | 很少（内核保守） | 慢链路上可能 |
| 实现 | 一次 `setsockopt` 调用 | 需要协议 + 状态机 |
| 可见性 | 通过 `ss -o` 看内核计时器 | 应用日志/指标 |

关键洞察：TCP keepalive 是粗粒度的安全网，不是存活协议。聊胜于无，但对大多数实时故障检测来说太慢。应用心跳让你完全控制检测时间、超时语义和恢复行为。

## 代理、负载均衡器和 NAT 超时

即使有完美的 keepalive 和心跳，中间基础设施仍可能杀死你的连接：

- **NAT 网关**：大多数 NAT 设备的空闲超时从 5 分钟到 1 小时不等。如果心跳间隔比 NAT 超时更长，NAT 映射消失，数据包被静默丢弃。
- **负载均衡器**：AWS NLB 有 350 秒空闲超时。nginx `proxy_read_timeout` 默认 60 秒。HAProxy `timeout client` 默认 1 小时。
- **云代理**：Cloudflare 的 TCP 连接空闲超时为 100 秒。

经验法则：心跳间隔必须短于路径中最短的超时时间。如果后面有 5 分钟超时的 NAT，就每 30-60 秒发一次心跳。

nginx 可以这样调空闲超时：

```nginx
location / {
    proxy_pass http://backend;
    proxy_read_timeout 30s;
    proxy_send_timeout 30s;
}
```

AWS NLB 的空闲超时固定为 350 秒且不可更改——你必须比这更频繁地发心跳。

## 生产环境死对端检测清单

以下是我对任何网络服务的实用清单：

1. **在所有服务器 socket 上启用 `SO_KEEPALIVE`**。免费且能捕获一些情况。
2. **将 `TCP_KEEPIDLE` 调至合理值**（30-60 秒），如果你依赖内核 keepalive。
3. **实现应用层心跳**，对任何需要及时故障检测的连接（WebSocket、RPC、数据库池、消息队列）。
4. **心跳间隔设为低于路径中最短的 NAT/LB 空闲超时**。
5. **记录和度量心跳失败**——它们是网络问题的预警信号。
6. **处理连接清理**——心跳失败时关闭连接并从池中移除。
7. **用真实网络条件测试**——回环测试无法揭示 NAT 或防火墙行为。

## 结论

半开连接是沉默的杀手：没有错误，没有日志，没有信号——只有一个服务器永远等待一个永远不会响应的对端。TCP keepalive（`SO_KEEPALIVE` + `TCP_KEEPIDLE`）是有用的安全网，但默认 2 小时空闲超时对大多数应用来说太慢。应用层心跳——一个简单的 ping/pong 协议，带可配置的间隔和超时——才是及时故障检测的真正答案。

最佳防御是分层的：启用内核 keepalive 作为后备，实现应用心跳及时检测，并将两者都调得比任何中间基础设施的空闲超时更短。未来的你，在凌晨 3 点调试生产问题时，会感谢现在的你。

---

*相关：[嵌入式设备上的 TCP 调试](/zh/posts/debugging-tcp-on-embedded/) · [Go 实现 TCP 代理](/zh/posts/tcp-proxy-in-go/)*
