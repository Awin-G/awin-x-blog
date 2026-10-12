---
title: "WireGuard 排障：握手正常，为什么却什么都不通？"
description: "一份实用的 WireGuard 排障阶梯，全部基于真实的 wg show、tcpdump 与 conntrack 输出：公钥配错、AllowedIPs 打错、NAT 后面的 PersistentKeepalive、MTU 让大包卡死——每个故障都在一次性容器里真实复现。"
pubDate: 2027-01-12
lang: zh
translationKey: wireguard-troubleshooting
tags: [networking, security]
featured: false
keywords:
  - WireGuard 排障
  - wg show
  - AllowedIPs
  - WireGuard 握手
  - PersistentKeepalive
---

我见过的每一份「我的 WireGuard 隧道坏了」的报告，最后都停在同一个地方：某人看了一眼 `wg show`，觉得看起来是健康的，然后就放弃了。关键在于，`wg show` 回答的是*两个不同的问题*——加密在不在通信，数据在不在流动——而绝大多数建议（包括手册页）一次只讲其中一个。这篇文章是我实际在用的 **WireGuard 排障**阶梯，每个故障都在真实接口上复现过，最后附上一张你在事故现场也能照着跑的检查清单。

## 实验环境：真接口，无特权容器

下面的一切都发生在三个普通容器里，只给了 `--cap-add=NET_ADMIN --device=/dev/net/tun`——没有 `--privileged`，主机上也不需要 root：

```console
$ docker run -d --name peer-a --cap-add=NET_ADMIN --device=/dev/net/tun \
    --network wg-inet --ip 10.99.0.2 debian:bookworm-slim sleep infinity
```

内核的 WireGuard 模块会在容器里自动加载（`/proc/modules` 里有 `wireguard` 以及 `libcurve25519`、`ip6_udp_tunnel`、`udp_tunnel`），所以这是真的内核实现。如果你的机器上没有这个模块，`wireguard-go` 会给你一个用户态接口，配置和输出完全一致——下面每个测试的行为都一模一样。

## 心智模型：`wg show`、WireGuard 握手与 transfer

`wg show` 给每个对端打印两行，诊断价值几乎全在其中：

```console
$ wg show
interface: wg0
  public key: 59QhvjZMxCDl0ftITiOAmfAfO7mgbEcylF59x4Y8RyA=
  private key: (hidden)
  listening port: 51820

peer: jc/msZY/OZUhyw/A0FoRbboC7G6b80gIzGJkQZTUBxo=
  endpoint: 10.99.0.3:51821
  allowed ips: 10.0.0.0/24
  latest handshake: 2 seconds ago
  transfer: 476 B received, 532 B sent
```

- **`latest handshake`（最近一次握手）**回答「加密/网络」问题：密钥一致、包能到达。如果它显示「2 seconds ago」，说明 *WireGuard 握手*是健康的，再去查密钥就是浪费时间。
- **`transfer`（传输量）**回答「数据」问题：`received` 和 `sent` 是这个接口加密的内层字节数。健康的对端两边都涨。**握手很新 + transfer 单向 = 路由问题，不是加密问题**——对端解密了你的包，却无法把回复路由回来。

值得记住几个包长（抓包时就能看到）：握手*发起*是 148 字节，握手*响应*是 92，传输数据通常约 128，空闲保活是 32。在网线上一眼就能把它们区分开。

## 排障阶梯

从上到下逐级排查；每一级都会独立失败——这正是阶梯的意义所在。

<figure>
<svg viewBox="0 0 640 250" width="640" height="250" role="img" aria-label="WireGuard 排障阶梯：没有握手、握手正常但没流量、大包卡死、空闲后失效" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif">
  <rect x="0" y="0" width="640" height="250" rx="8" fill="none" stroke="#0f766e" stroke-width="1.5" opacity="0.25"/>
  <g font-size="14" fill="currentColor">
    <!-- 1 -->
    <rect x="16" y="14" width="608" height="52" rx="6" fill="#0f766e" opacity="0.10"/>
    <text x="30" y="35" font-weight="700" fill="#0f766e">1 · 完全没有握手</text>
    <text x="30" y="55">没有 latest handshake 行 · 网上有 148 字节发起包，没有响应</text>
    <!-- 2 -->
    <rect x="16" y="74" width="608" height="52" rx="6" fill="#0f766e" opacity="0.10"/>
    <text x="30" y="95" font-weight="700" fill="#0f766e">2 · 握手正常，但没有流量</text>
    <text x="30" y="115">握手很新、transfer 单向 · AllowedIPs / 密码密钥路由</text>
    <!-- 3 -->
    <rect x="16" y="134" width="608" height="52" rx="6" fill="#0f766e" opacity="0.10"/>
    <text x="30" y="155" font-weight="700" fill="#0f766e">3 · 有流量，大包卡死</text>
    <text x="30" y="175">小 ping 正常，5 MB 拷贝挂住 · 隧道上的 MTU / MSS</text>
    <!-- 4 -->
    <rect x="16" y="194" width="608" height="52" rx="6" fill="#0f766e" opacity="0.10"/>
    <text x="30" y="215" font-weight="700" fill="#0f766e">4 · 能用，一空闲就失效</text>
    <text x="30" y="235">在 NAT 后面 · PersistentKeepalive 要短于 NAT 超时</text>
  </g>
</svg>
<figcaption>WireGuard 排障阶梯。以网络上的证据下诊断，而不是靠猜配置。</figcaption>
</figure>

## 读 `wg show` 和 `wg show all dump`

`wg show all dump` 是机器可读形式，也是你应该贴进 issue 的东西：每个接口一行（私钥、公钥、监听端口、fwmark），然后每个对端一行，追加 endpoint、allowed IPs、最近握手时间戳（0 = 从未）、rx/tx 字节数和保活间隔：

```console
$ wg show all dump
wg0	...	jc/msZY/OZUhyw/A0FoRbboC7G6b80gIzGJkQZTUBxo=	51821	off
wg0	59QhvjZMxCDl0ftITiOAmfAfO7mgbEcylF59x4Y8RyA=	(none)	10.99.0.2:51820	10.0.0.0/24	1791843996	532	476	off
```

从这几行里读三件事。endpoint `10.99.0.2:51820` 在这个对端上**从未被配置过**——WireGuard 会记住最近一个通过认证的源地址（漫游机制），所以那里出现一个 endpoint 并不代表谁在文件里写过它。时间戳是 Unix 秒的最近握手时间（0 = 从未握过手）。而且输出里没有握手*计数器*——想证明流量在动，就隔一分钟取两次 dump 对比 rx/tx。

## 故障 1：完全没有握手——公钥配错

我给 `peer-a` 的对端条目配了一个和 `peer-b` 私钥不匹配的密钥——这就是著名的复制粘贴事故：一边重新生成了密钥，配置只改了一半：

```console
$ wg show
interface: wg0
  public key: 59QhvjZMxCDl0ftITiOAmfAfO7mgbEcylF59x4Y8RyA=
  private key: (hidden)
  listening port: 51820

peer: z+bdVjjlqjKNS0mKCw1aY+ZJF2T/5N79dESUJU9BfW8=
  endpoint: 10.99.0.3:51821
  allowed ips: 10.0.0.0/24

$ ping -c 3 -W 2 10.0.0.2
3 packets transmitted, 0 received, 100% packet loss
```

注意输出里*少了什么*：没有 `latest handshake` 行，也没有 `transfer` 行。前者才是关键——没有 `latest handshake` 行的对端，从未和你完成过握手。

网络上的证据讲完了剩下的故事。每个发起包每五秒重试一次，什么都不会回来：

```console
$ tcpdump -ni eth0 'udp port 51821'
22:27:00.393546 IP 10.99.0.2.51820 > 10.99.0.3.51821: UDP, length 148
22:27:05.747055 IP 10.99.0.2.51820 > 10.99.0.3.51821: UDP, length 148
```

发起包出去，没有 92 字节的响应——这是**密钥不匹配**的签名。它同时也是防火墙丢 UDP 的签名，所以要靠*包停在哪里*区分：密钥不匹配时，148 字节的发起包会到达对端，然后被默默丢弃；如果包根本没到，你要找的是防火墙或者 endpoint 写错。修复：在两边用 `wg set wg0 peer <server-public-key> endpoint ... allowed-ips ...` 放上*正确*的密钥，然后 `wg syncconf wg0 <(wg-quick strip wg0)`。

## 故障 2：握手正常、零流量——`AllowedIPs`

这就是标题说的那种故障，而且平常得让人无聊：`AllowedIPs` 打错了一个八位组。我在 `peer-b` 上把对端的 allowed IPs 改成 `10.88.0.0/24`（挪位了一个数字），`peer-a` 保持原样：

```console
$ wg show            # peer-a —— 加密明明是好的！
peer: jc/msZY/OZUhyw/A0FoRbboC7G6b80gIzGJkQZTUBxo=
  endpoint: 10.99.0.3:51821
  allowed ips: 10.0.0.0/24
  latest handshake: 16 seconds ago
  transfer: 124 B received, 660 B sent

$ ping -c 4 -W 1 10.0.0.2
4 packets transmitted, 0 received, 100% packet loss
```

握手很新，`sent` 在涨，`received` 几乎冻在零——第 2 级：不是加密问题，而是 `peer-b` 收到、解密、然后丢弃了你的包。原因如下，这是全文最重要的概念。

`AllowedIPs` 干**两件事**。在 WireGuard 内部，它是*密码密钥路由表*（cryptokey routing）：`peer-b` 解密一个包时，会检查源地址是否落在某个对端的 `AllowedIPs` 里；`peer-b` 自己发流量时，也靠 `AllowedIPs` 选*用哪个对端的密钥*加密回复。打错之后，解密后的包过不了这道检查，在 `wg0` 内部就被丢掉——根本到不了内核，所以没有 ICMP、没有 TCP RST，什么都没有。与此同时，内核的*路由表*看起来依然健康，这就是这个陷阱最深的地方：

```console
$ ip route        # peer-b —— 看起来完全正常
default via 10.99.0.254 dev eth0
10.0.0.0/24 dev wg0 proto kernel scope link src 10.0.0.2
$ ip route get 10.0.0.1
10.0.0.1 dev wg0 src 10.0.0.2 uid 0
    cache
```

那条 `10.0.0.0/24 dev wg0` 来自你给接口配的 `/24` 地址，*不是*来自 `AllowedIPs`——所以 `ip route` 在这里说谎是正常的，回复包死在路由表下面的接口里。抓包确认了两半：握手完成，请求进去，什么都不出来。

```console
$ tcpdump -ni eth0 'udp port 51821'    # peer-b
22:27:35.365972 IP 10.99.0.2.51820 > 10.99.0.3.51821: UDP, length 148   # 发起
22:27:35.366158 IP 10.99.0.3.51821 > 10.99.0.2.51820: UDP, length 92     # 响应
22:27:35.366293 IP 10.99.0.2.51820 > 10.99.0.3.51821: UDP, length 128   # 数据进
22:27:36.403993 IP 10.99.0.2.51820 > 10.99.0.3.51821: UDP, length 128   # 数据进
```

在错的那一侧改对，计数器一个 ping 之内就翻转：

```console
$ wg set wg0 peer "$(cat p_a.pub)" allowed-ips 10.0.0.0/24     # peer-b
$ ping -c 3 -W 1 10.0.0.2
3 packets transmitted, 3 received, 0% packet loss
```

要养成的习惯：只要「握手很新 + transfer 单向」，就把两个对端上的 `allowed ips` 行和各自实际拥有的隧道地址对一遍——对端的密码密钥路由没有覆盖到你。

## 故障 3：能用，一空闲就死——`PersistentKeepalive` 与 NAT

现在 `peer-a` 坐在一个 NAT 路由器（`nat-r`，一个跑 `MASQUERADE`、`net.ipv4.ip_forward=1` 的容器）后面——就像咖啡馆里的一台笔记本。隧道已建立，流量正常。看看 `peer-b` 知道它的对端是什么：

```console
$ wg show all dump     # peer-b
wg0	...	3Z8oUm9ikTLd8f8zjUV4nvGcsDTGSYJpWNMHHALuq28=	51821	off
wg0	V3kQJ1HslySBTWSvKzz6NnEtdGlDk91J3SVyk3hAPzc=	(none)	10.99.0.1:51820	10.0.0.0/24	1791844916	820	732	off
```

`10.99.0.1:51820` 是 NAT 路由器的公网地址，不是对端的——`peer-b` 从来只见过 NAT 之后的包。这一切依赖的映射活在路由器的连接跟踪表里：

```console
$ conntrack -L -p udp     # nat-r
udp      17 7 src=10.99.0.2 dst=10.99.0.3 sport=51820 dport=51821 src=10.99.0.3 dst=10.99.0.1 sport=51821 dport=51820 [ASSURED] mark=0 use=1
```

现在 NAT 映射过期了（实验容器的 `nf_conntrack_udp_timeout=8`；家用路由器通常给 UDP 30 秒，我用 `conntrack -D -p udp` 直接删掉，省得干等）。隧道空闲一会儿，然后 `peer-b` 想主动发起对话——在局域网上毫秒级完成的握手就这样消失了：

```console
$ ping -c 4 -W 1 10.0.0.1        # peer-b
4 packets transmitted, 0 received, 100% packet loss

$ wg show                        # peer-b —— 全新对端，握手还没有
peer: V3kQJ1HslySBTWSvKzz6NnEtdGlDk91J3SVyk3hAPzc=
  endpoint: 10.99.0.1:51820
  allowed ips: 10.0.0.0/24
  transfer: 0 B received, 148 B sent

$ wg show                        # peer-a —— 上次握手已经很久以前
  latest handshake: 1 minute, 12 seconds ago
```

路由器的抓包精确显示了它们死在哪里：死在公网 IP 上，一个回复都发不出来：

```console
$ tcpdump -ni eth0 'udp port 51820'   # nat-r
22:42:52.033646 IP 10.99.0.3.51821 > 10.99.0.1.51820: UDP, length 148
22:42:57.554937 IP 10.99.0.3.51821 > 10.99.0.1.51820: UDP, length 148
```

发起包每五秒重试一次，永不停止，而 NAT 静静地把它们丢掉，因为没有映射能带它们找到 `peer-a`。你可能还会发现一个来自 `peer-a` 的 32 字节包——会话存活时 WireGuard 自己会发空保活包，顺带把映射重建起来。别指望这个：会话会老化，保活会停。官方机制是 `PersistentKeepalive`，配在*NAT 后面的那个对端*上，并且必须短于 NAT 的映射超时（25 秒对典型的 30 秒 UDP 超时）。实验里 UDP 超时是 8 秒，所以我用了 2：

```console
$ wg set wg0 peer "$(cat p_b.pub)" persistent-keepalive 2      # peer-a
$ wg show | tail -3
  latest handshake: 12 seconds ago
  transfer: 2.35 KiB received, 3.02 KiB sent
  persistent keepalive: every 2 seconds
```

保活刷新着映射，下一个发起包就能通过，几秒内握手完成，`transfer` 重新两个方向一起涨。路由器上的抓包完整展示了整个修复周期，每个包出现两次——NAT 改写之前（`10.99.0.2` → `10.99.0.1`）和之后：

```console
$ tcpdump -ni eth0 'udp port 51820'   # nat-r
22:45:28.594865 IP 10.99.0.2.51820 > 10.99.0.3.51821: UDP, length 32    # A 的保活
22:45:28.594875 IP 10.99.0.1.51820 > 10.99.0.3.51821: UDP, length 32    # …同一个包，SNAT 后
22:45:28.751503 IP 10.99.0.3.51821 > 10.99.0.1.51820: UDP, length 148   # B 的发起，发往公网 IP
22:45:28.751528 IP 10.99.0.3.51821 > 10.99.0.2.51820: UDP, length 148   # …被送到 A
22:45:28.751743 IP 10.99.0.2.51820 > 10.99.0.3.51821: UDP, length 92    # 握手响应
```

## 故障 4：握手正常、小包正常、大包全灭——MTU

最后一级最难看，因为小东西都是好的。在 1400 字节的底层链路上，`wg0` 的 MTU 配错（我把它设成 1500——每个封装包都会大出几十字节：实测 1500 字节的内层包出去时是 1532 字节的 UDP 数据报），小流量完美，大流量静默死亡：

```console
$ ping -M do -c 2 -W 1 -s 1312 10.0.0.2
2 packets transmitted, 0 received, 100% packet loss
```

关于实验环境要说句实话：Docker 的 veth 照样把这些超大帧送了出去（offload 造成的假象），所以为了复现真实症状，我在接收侧加了一条规则丢过大的 UDP 帧——这才是任何 PPPoE、移动网络或见不得分片的路径会有的行为：

```console
$ iptables -A INPUT -p udp --dport 51821 -m length --length 1401:1600 -j DROP
```

TCP 让这个问题致命：握手和小请求都好着，批量数据不行。MTU 错误时一个 5 MiB 的 `nc` 流，等 15 秒之后看结果：

```console
$ timeout 15 sh -c 'dd if=/dev/zero bs=1M count=5 | nc -N 10.0.0.2 5555'   # peer-a
$ ls -l rxbad.bin    # peer-b
-rw-r--r-- 1 root root 0 Oct 12 23:03 rxbad.bin
```

5242880 字节里收到 0 个。按下面的方法修好后，同一个传输完整收满。

远程登录活着，小 `curl` 活着，`git clone` 每次都卡在同一个字节数。修复是算术题，而且**两边**都要改：wg MTU ≤ 路径 MTU − 约 80（所以 1500 以太网路上通常是 1420；1400 的路径上用 1300–1340）：

```console
$ ip link set wg0 mtu 1300      # 两个对端都改
$ ping -M do -c 2 -s 1272 10.0.0.2
2 packets transmitted, 2 received, 0% packet loss
$ ping -M do -c 1 -s 1472 10.0.0.2
ping: local error: message too long, mtu=1300
```

第二种失败才是*想要*的：立刻、本地、还点名了接口。`-M do`（不分片）是这篇文章里最有用的一个参数——它把静默卡死变成一条消息。对 TCP 来说，隧道侧的修复是在服务端加 MSS 钳制（`iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu`）——也就是人们说的「加了 MSS 规则就好了」。

## 检查清单

按顺序来，刻意无聊：

1. `wg show` —— 握手时间，以及两个 `transfer` 计数器。
2. 没有握手行 → 两边核对公钥，然后查 endpoint/UDP 可达性。`tcpdump 'udp port 51820'`：只出去 148 没有 92 = 密钥问题；连包都不出 = 网络/防火墙。
3. 握手新但 transfer 单向 → 对比两边对端的 `allowed ips` 和各自实际拥有的地址。永远是第 2 级。
4. 一空闲就死 → 找出谁在 NAT 后面；`PersistentKeepalive` 加在那一边，短于 NAT 超时（25 对 30）。
5. 小通大卡 → 两个 wg 接口的 MTU，再用 `ping -M do -s <上限>` 验证。
6. 每一步都查两边，而且始终开着抓包。`wg show` 告诉你看哪儿；只有网线告诉你谁在说谎。

密钥、证书轮换和密钥与 AllowedIPs 的完整仪式见 [WireGuard 从零开始](/zh/posts/wireguard-from-scratch/)；同样的隧道跑在容器里（以及让 `--cap-add=NET_ADMIN` 就足够的权限模型）见 [WireGuard 在容器里](/zh/posts/wireguard-in-containers/)。本文用到的容器已全部销毁；上面的命令就是全部复现过程。
