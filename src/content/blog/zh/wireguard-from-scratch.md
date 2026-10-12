---
title: "WireGuard 从零开始：密钥、对端、AllowedIPs，以及它刻意不做的事"
description: "一份实操向的 WireGuard 教程：生成密钥、写 wg-quick 配置、添加对端、把 AllowedIPs 理解为“加密路由”，搭好两台主机之间的隧道与站点到站点的子网路由，用 wg 命令排查问题，并说清 WireGuard 究竟把哪些事留给了你自己。"
pubDate: 2026-10-18
lang: zh
translationKey: wireguard-from-scratch
tags: [networking, self-hosting, security]
featured: false
keywords:
  - WireGuard 教程
  - WireGuard 配置
  - AllowedIPs 详解
  - wg-quick
  - 站点到站点 VPN
---

**WireGuard** 是那种少见的基础设施：它做得比你预期更少，却因此更好用。没有握手守护进程，没有要你配置的连接状态机，也没有能配错的“第一阶段／第二阶段”。它就是一个走 UDP 的小内核模块（在手机和 macOS 上是用户态实现），用静态密钥认证对端，并依据唯一一个决定性字段——`AllowedIPs`——来决定包怎么走。这篇 **WireGuard 教程**从一台裸机开始，一步步搭出可用的隧道和一条子网路由，然后把真正的篇幅留给大多数指南跳过的部分：**WireGuard 刻意不替你做的一切**。

如果你以前被 IPsec 配置折磨过，这套东西会小得让你起疑。这正是它的设计意图。

## 设计赌注：密钥标识对端，AllowedIPs 负责路由

整个设计由两个想法撑起来：

1. **对端由其公钥标识**，不是 IP 地址，也不是证书。没有 CA，没有信任链，没有需要续期的 PKI。
2. **`AllowedIPs` 一身两职**：它既是一张 *IP 路由表*，又是一张 *访问控制表*。一个包会被交给 `AllowedIPs` 覆盖了目标地址的那个对端；而从该对端收到的包，只有当其来源地址落在同一集合里才会被接受。

第二点正是很多人会错上几个月的地方。先记住它——等你看过配置，我们还会回来。

## 第 1 步 —— 生成密钥

你需要的是每个*接口*一对密钥，而不是每台主机一对。私钥永不离开本机，公钥才是你要发出去的东西。别用带密码的 PEM，也别搞“wg genkey | openssl”这种链条——WireGuard 有自己的工具，用它就好。

```bash
# 服务端
umask 077
wg genkey | tee server.key | wg pubkey > server.pub

# 客户端
umask 077
wg genkey | tee client.key | wg pubkey > client.pub

cat server.pub client.pub
```

一个 base64 的 WireGuard 密钥就是一串裸的 Curve25519 标量。没有续期，没有过期时间，没有吊销列表。轮换密钥意味着生成新的，然后把所有引用到它的对端都改一遍——而这个缺口，正是后来 overlay 网络帮你补上的。

## 第 2 步 —— 写两份配置

我用 `10.9.0.0/24` 作为隧道网段（别和你的局域网撞车）。服务端是 `10.9.0.1`，客户端是 `10.9.0.2`。服务端公网 IP 为 `203.0.113.10`，监听 `51820/udp`。

**服务端 —— `/etc/wireguard/wg0.conf`：**

```ini
[Interface]
Address = 10.9.0.1/24
ListenPort = 51820
PrivateKey = <server.key 的内容>

[Peer]
# laptop
PublicKey = <client.pub 的内容>
AllowedIPs = 10.9.0.2/32
```

**客户端 —— `/etc/wireguard/wg0.conf`：**

```ini
[Interface]
Address = 10.9.0.2/24
PrivateKey = <client.key 的内容>

[Peer]
PublicKey = <server.pub 的内容>
Endpoint = 203.0.113.10:51820
AllowedIPs = 10.9.0.0/24
PersistentKeepalive = 25
```

注意这里*没有*什么。服务端配置里没有给客户端的 `Endpoint`——服务端根本不知道客户端在哪，也不关心；它只 replies 到最后一个通过认证的包来自的源地址。客户端有 `Endpoint`，因为它是发起方。正是这种不对称，让一个躲在家用路由器后面的笔记本能主动够到 VPS，而 VPS 在笔记本先开口之前够不到它。

把它们拉起来：

```bash
sudo wg-quick up wg0
sudo systemctl enable wg-quick@wg0   # 重启后自动恢复
```

如果你习惯不用 Docker 跑服务、并且希望隧道由 systemd 托管而不是临时命令，那套 unit 文件的纪律是一样的：可以看[不用 Docker 的自托管](/zh/posts/self-hosting-without-docker/)。

## AllowedIPs 的正解：它就是加密路由

现在讲重点。把客户端那句 `AllowedIPs = 10.9.0.0/24` 同时读成两句话：

- **出站路由：**“凡目标在 `10.9.0.0/24` 的，都交给这个对端。”`wg-quick` 会把它落实为一条指向 `wg0` 接口的内核路由。
- **入站加密路由：**“只接受来自这个对端、且*来源*落在 `10.9.0.0/24` 内的包。”从该对端经隧道过来、来源不在其中的包会被静默丢弃——在它抵达路由表之前就被丢掉。

所以 `AllowedIPs` 不是一条要你再配条路由去搭配的防火墙规则，它*就是*路由决策，且与认证融为一体。对端密钥证明*谁*发的包，`AllowedIPs` 则证明这个包有权声称那个源地址。这就是为什么 WireGuard 里没有“防欺骗”这一项可配置——它在结构上就已经被阻止了。

真正会咬到人的后果是：**两边的说法必须一致**。如果客户端说自己可以发 `10.9.0.0/24`，但服务端的 `[Peer]` 只放行 `10.9.0.2/32`，那么客户端的包会被接受（来源 `10.9.0.2` 落在 `/32` 内），回到 `10.9.0.2` 的流量也通，但别的都会走进死胡同。把服务端的 `AllowedIPs` 放宽到恰好等于该对端被允许发起的地址——不多给一点。

## 用 `wg` 和 `wg-quick` 排查

`wg show` 就是全部的可见性，而且够用了。先看 **latest handshake** 那一行：如果它是空的，说明没有任何对端完成过握手，问题出在可达性或者密钥，而不是路由。

```console
$ sudo wg show
interface: wg0
  public key: Kq3f...server
  private key: (hidden)
  listening port: 51820

peer: 8Yc1...client
  endpoint: 198.51.100.22:51934
  allowed ips: 10.9.0.2/32
  latest handshake: 14 seconds ago
  transfer: 1.24 MiB received, 5.87 MiB sent
  persistent keepalive: every 25 seconds
```

读法：

- **完全没有握手** → `Endpoint` 错了、端口错了，或者防火墙挡住了 UDP `51820`。客户端侧的 `wg-quick` 还要求服务端公钥逐字节正确。
- **握手停在几分钟前、再没更新** → 流量断了；通常是 NAT 映射超时。这正是 `PersistentKeepalive` 要修的。
- **握手正常，但 ping 不通** → `AllowedIPs` 不匹配或缺路由。两边都看一眼 `ip route get 10.9.0.2`。
- `wg show wg0 dump` 给出同样的数据，但可机器解析——如果你想绘制握手年龄曲线用得上。

`wg-quick` 是个 shell 包装：它能保存当前配置（`wg-quick save wg0`），你也可以用 `wg-quick strip wg0` 看它到底会执行什么。出微妙问题时，`journalctl -u wg-quick@wg0` 通常能直接点名失败的那条路由或 `resolvconf` 调用。

## persistent keepalive，一句话讲清

`PersistentKeepalive = 25` 每 25 秒发一个带认证的空包，好让*客户端*一侧的 NAT 保持映射打开，从而服务端能反向找到它。你需要它的，是那个位于 NAT 之后、又希望被拨入的对端。公网 IP 的服务端**不**需要，也不要到处撒——它是周期性流量，会让电池设备上的无线电一直醒着。

## 路由整个子网——或者整个世界

要让服务端成为它后面那个局域网的网关，就把远端网段加到客户端的 `AllowedIPs`，并把服务端变成路由器。

客户端：

```ini
[Peer]
PublicKey = <server.pub>
Endpoint = 203.0.113.10:51820
AllowedIPs = 10.9.0.0/24, 192.168.50.0/24   # 连办公室局域网一起
```

服务端，为那个局域网做路由，并在出口做地址转换：

```bash
# 服务端：放行转发，并把隧道流量伪装进局域网
sudo sysctl -w net.ipv4.ip_forward=1
sudo nft add table ip nat
sudo nft 'add chain ip nat postrouting { type nat hook postrouting priority 100; }'
sudo nft add rule ip nat postrouting ip saddr 10.9.0.0/24 oifname "eth0" masquerade

# 并在防火墙里放行 wg0 的转发
```

这就是一个微型的**站点到站点 VPN**：两个网络通过一组对端连在一起。把客户端的 `AllowedIPs` 改成 `0.0.0.0/0`，你就得到了全隧道 VPN——每个包都走服务端。别忘了加密路由的入站那一半依然生效：服务端为该客户端写的 `[Peer]` 必须放行客户端会用到的源地址；而客户端上的 `0.0.0.0/0` 意味着现在它接受服务端的 `AllowedIPs` 作为去往整个互联网的路由——除非你也下发一个解析器，否则 DNS 会断。

## WireGuard 刻意不做的事

这一节能帮你省下几周时间。WireGuard 是一个数据面协议，它给了你四个明确的“不做”：

- **不做 NAT 穿越。** 它不发现对端，不打洞，不中继。如果两端都在对称 NAT 后面，它们就是连不上，除非有一端可达，或者你自建中继。背后的原理值得单独一读：[NAT 穿越详解](/zh/posts/nat-traversal-explained/)。
- **不做地址分配。** WireGuard 不会给新客户端发一个 `10.9.0.2`。你得把地址手写进每份配置，还得保证它们永不冲突。
- **不做密钥分发。** 没有目录服务。任何对端的密钥一变，每个对端都得重新部署。
- **不做用户管理。** 这里没有用户，只有密钥。没有 SSO，没有 ACL，没有审计日志，没有“谁吊销了谁”。一个密钥就是永久的一个对端，直到你在所有地方删掉那段 `[Peer]`。

这不是一份 bug 清单，而是一条边界。线路之上的一切——成员管理、发现、策略、那个设置页面——都是别人的活儿。

## 补上缺口的 overlay 与工具

当你不想为二十台机器手写密钥和路由时，两类工具来补缺口。

**Overlay**（Tailscale、EasyTier、NetBird 之类）保留了类 WireGuard 的加密，但加了一个控制面：地址分配、带中继的 NAT 穿越、ACL、密钥轮换。你用“托管或自建协调服务器”换来了这些运维活儿。我在[2026 年 mesh VPN 横评](/zh/posts/mesh-vpn-comparison-2026/)里逐项对比过——简短版是：问题在于谁拥有协调服务器，而不是功能列表上写了什么。

**轻量工具**则留在内核 WireGuard 的世界里，只是把它自动化。`wg-easy` 是个 Web UI，会生成密钥和配置、发二维码、把对端写回同一个接口——对“一个个人枢纽加十来个客户端”再合适不过。`systemd`（`wg-quick@wg0`）把隧道变成一等服务，开机自启、失败重启。两者都不提供 NAT 穿越或控制面；它们消除的是琐事，不是那条边界。

我的经验法则：**两三个固定主机，或者一条点到点／站点到站点的链路 → 直接用裸 WireGuard。** 十几行配置，几乎不会坏，而且你全懂。**会到处漫游的笔记本、手机、朋友、任何必须在 NAT 间互相找到对方的设备 → 上 overlay。** 想要更多客户端但不想引入更多结构时，就顺手用 `wg-easy`。搞清楚自己站在哪条线的哪一侧，就是全部的本事。

## 简短版

每个接口生成一对密钥，两边各写一个 `[Interface]` 和一个 `[Peer]`，让 `AllowedIPs` 同时负责路由与认证。只在拨号的那一侧加 `Endpoint`。只在 NAT 后面用 `PersistentKeepalive`。放宽 `AllowedIPs` 去路由一个子网乃至整个世界，收紧它去约束某个对端。然后接受这笔诚实的交换：WireGuard 把包搬得极漂亮，却什么都不协调——而所有协调的事，都是叠在它之上的第二个产品。
