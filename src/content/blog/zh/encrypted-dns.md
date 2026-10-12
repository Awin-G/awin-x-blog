---
title: "加密 DNS 详解：DoT、DoH 究竟保护了什么（又没有保护什么）"
description: "一篇务实的加密 DNS 指南：明文 DNS 会泄露什么、泄露给谁；DNS over TLS 与 DNS over HTTPS 有何区别；DoQ 能带来什么；加密究竟保护了查询内容，又永远藏不住 SNI、目标 IP 和你所使用的解析器；运营者要面对的那些取舍；以及 Unbound 与 systemd-resolved 的具体配置。"
pubDate: 2026-11-25
lang: zh
translationKey: encrypted-dns
tags: [networking, security, self-hosting]
featured: false
keywords:
  - 加密 DNS
  - DNS over HTTPS
  - DNS over TLS
  - DoH vs DoT
  - Unbound
  - systemd-resolved
  - SNI
---

在一家酒店的网络里，笔记本发出的第一个 DNS 查询，往往就是把“你接下来要去哪儿”明信片一样广播出去。这正是**加密 DNS（encrypted DNS）** 的卖点：把问题包起来，让中间的人读不到。这是实打实的进步，但它被吹得比实际情况更笃定。**DNS over TLS** 和 **DNS over HTTPS** 能藏住你查询的*内容*，却藏不住你随后要连接的*目标*，也拦不住你自己的解析器看见一切。这篇文章讲清楚 **DoH vs DoT** 在链路层到底改变了什么、什么依然暴露、营销里绝口不提的运营者取舍，以及我自己是怎么在机器上配置的。

如果你想先搞懂底层的流程，我早前那篇[DNS 究竟是怎么解析的](/zh/posts/how-dns-resolves/)讲了存根解析器、递归解析器和权威链。本文默认你已经了解那些，只聚焦传输这一层。

## 明文 DNS 会泄露什么，又泄露给谁

传统 DNS 走 UDP 53 端口，明文、无认证。每一次查询都是一张明信片：你问的域名、记录类型、答案，路径上任何一个节点都能读到。感兴趣的人并不是假想出来的：

- **你的 ISP 或网络运营者**能看到你解析的每一个域名——这几乎等于一份完整的浏览历史，而且根本不需要碰你的 TLS 流量，就能把它拼出来。
- **路径上的攻击者**在开放 Wi-Fi 上可以读取查询，在没有 DNSSEC 的情况下还能改写应答。
- **你和递归解析器之间的一切**——这通常意味着你所在的那家咖啡馆、酒店或运营商的网络管理员。

更糟的是，明文 UDP DNS 极容易伪造，而且历史上一直是 DDoS 放大器。加密解决了机密性和篡改问题。但它解决不了“上游总有人在替你作答”这件事，我们后面会回到这点。

## DNS over TLS（DoT）：跑在自己协议上的 853 端口

DoT 把你早已熟悉的 DNS 线格式原封不动，装进一条 **TCP 853 端口**的 TLS 会话里传输。它是跑在专用端口上的自有协议：客户端必须知道自己要用 DoT，网络也必须主动放行 853。这让 DoT 很好推理——它就是 DNS over TLS，没别的——也很好被防火墙识别和封锁。

正因为它是一个独立的端口和协议，DoT 是*系统级*解析器的天然选择。操作系统配置一个 DoT 端点，机器上所有程序都受益，应用无需改动。`systemd-resolved` 和 Unbound 的转发模式用的就是这个模型。

## DNS over HTTPS（DoH）：混进 443 端口

DoH 把同样的 DNS 报文当作 HTTP 请求发出（RFC 8484），走 HTTPS，通常是 **443 端口**——和所有其他网页请求同一个端口。好处很具体：它能穿过任何允许正常网页流量的网络，能享受 HTTP 缓存和连接复用，对天真的防火墙来说和普通浏览毫无区别。代价也正在于它*确实*毫无区别：网络管理员若不深入检测，根本分不清你的 DoH 查询和一条请求猫图的请求——这正是 DoH 在企业治理争论里处于中心的原因。

DoH 是浏览器最先落地的形态，因为浏览器本来就会说 HTTP，也自己掌控 TLS 栈。对单个用户来说，它是最省事的一项设置；对整个网络来说，它是最难治理的东西。

## DoQ，简单说几句

**DNS over QUIC**（DoQ，RFC 9250）在 UDP 853 端口上用 QUIC 承载 DNS。QUIC 带来了没有队头阻塞的流多路复用、更快的建连，以及每流的流量控制，所以一个递归解析器在单条连接上应答大量查询时，队头等待会比基于 TCP 的 DoT 更少。它的采用是真实存在的，但范围比 DoT 和 DoH 窄；把它看成面向未来的选项，而不是今天就要部署的默认值。

## DoH vs DoT：加密 DNS 究竟保护了什么

下面是诚实的分账。加密保护的是查询本身的**内容与完整性**。

| 属性 | 明文 DNS | DoT（853） | DoH（443） |
|---|---|---|---|
| 路径上可读查询域名/类型 | 是 | 否 | 否 |
| 应答防篡改（无 DNSSEC 时） | 否 | 是 | 是 |
| 便于系统级统一配置 | — | 是 | 参半 |
| 混同于普通网页流量 | — | 否 | 是 |
| 防火墙可识别/拦截 | 轻而易举 | 可以（853 端口） | 很难 |

最该记住的一点：**加密只是转移了信任，并没有消除信任。** 以前，你信任你的 ISP 不去记录或篡改；之后，你信任 `1.1.1.1`、`8.8.8.8` 或 `9.9.9.9`——而那个运营者如今取代 ISP，看到了全貌。你改变的是*谁*知情，而不是让这份知情消失。

<figure>
<svg viewBox="0 0 640 240" width="100%" role="img" aria-label="DNS 查询的三种走法：明文 DNS 把查询域名暴露给路径上每一跳；DNS over TLS 在 853 端口加密但仍暴露端口；DNS over HTTPS 把查询藏进 443 端口，与网页流量无从分辨。">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="16" y="26">明文 DNS（UDP 53）</text>
    <text x="16" y="106">DNS over TLS（853）</text>
    <text x="16" y="186">DNS over HTTPS（443）</text>

    <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
      <rect x="176" y="12" width="130" height="30" rx="6"/>
      <rect x="176" y="92" width="130" height="30" rx="6"/>
      <rect x="176" y="172" width="130" height="30" rx="6"/>
      <path d="M306 27 h44" marker-end="url(#arzh)"/>
      <path d="M306 107 h44" marker-end="url(#arzh)"/>
      <path d="M306 187 h44" marker-end="url(#arzh)"/>
    </g>

    <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
      <rect x="350" y="12" width="130" height="30" rx="6"/>
      <rect x="350" y="92" width="130" height="30" rx="6"/>
      <rect x="350" y="172" width="130" height="30" rx="6"/>
      <path d="M480 27 h44" marker-end="url(#arzh)"/>
      <path d="M480 107 h44" marker-end="url(#arzh)"/>
      <path d="M480 187 h44" marker-end="url(#arzh)"/>
    </g>

    <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
      <rect x="524" y="12" width="100" height="30" rx="6"/>
      <rect x="524" y="92" width="100" height="30" rx="6"/>
      <rect x="524" y="172" width="100" height="30" rx="6"/>
    </g>

    <text x="241" y="32" text-anchor="middle">查询：example.com</text>
    <text x="415" y="32" text-anchor="middle">可见</text>
    <text x="574" y="32" text-anchor="middle">ISP 记录</text>

    <text x="241" y="112" text-anchor="middle" opacity="0.75">&#9617;&#9617;加密字节&#9617;&#9617;</text>
    <text x="415" y="112" text-anchor="middle">目标端口 853</text>
    <text x="574" y="112" text-anchor="middle">只见端口，不见域名</text>

    <text x="241" y="192" text-anchor="middle" opacity="0.75">&#9617;&#9617;加密字节&#9617;&#9617;</text>
    <text x="415" y="192" text-anchor="middle">看似普通 HTTPS</text>
    <text x="574" y="192" text-anchor="middle">只能看到 IP</text>
  </g>
  <defs>
    <marker id="arzh" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>
<figcaption>明文 DNS 把查询域名暴露给每一跳。DoT 藏住了域名，却在 853 端口上昭告了自己的存在。DoH 既藏住域名也藏住协议，只剩一个解析器 IP。</figcaption>
</figure>

## 加密 DNS 没有保护什么

这是营销跳过的那部分。即便 DoH 或 DoT 全线铺开：

- **解析器仍然看得到你的查询。** 你只是把日志从 ISP 搬到了 Cloudflare、Google 或 Quad9。除非你自建解析器——见[自建递归 DNS 解析器](/zh/posts/self-hosted-dns-resolver/)——否则总有人握有全貌。
- **TLS 握手里的 SNI 是可见的。** 当你随后连接 `api.example.com` 时，你几乎每一次连接的 ClientHello 都会以明文携带 **SNI** 主机名。路径上任何人即使看到你的 DNS 是加密的，也知道你要去哪。修复方案是 ECH（Encrypted Client Hello），目前仍在逐步铺开。
- **目标 IP 是可见的。** 你连接的*那个* IP，网络看得见。在共享主机和 CDN 环境下这个 IP 是含糊的，但它仍是一个信号，而且与 SNI 极易关联。
- **时序与流量体积这些元数据依旧存在。** 谁、何时、多少、多频繁。
- **DNSSEC 是另一回事。** DoH/DoT 保证的是传输完整性；除非解析器自己做了 DNSSEC，否则它们并不验证应答的来源。

所以准确的说法是：加密 DNS 藏住的是*问题*，不是*这次访问*。它显著抬高被动监听的代价，但挡不住一个能看到 SNI 和 IP 的坚定观察者。

## 运营者要面对的取舍

加密对用户是胜利，对运营者历史上是头疼。诚实的取舍如下：

- **中心化。** 如果所有人都默认用那几个公共 DoH 解析器，这些运营者就获得了一份过去分散在成千上万个 ISP 手中的全局流量视图。你用“分散的日志”换来了“集中的日志”。
- **企业可见性。** 企业 DNS 是一项安全控制：它知道哪些终端在访问恶意域名。浏览器层面的 DoH 会悄悄绕过它——这也是 Chrome 和 Firefox 都提供企业策略，用来关闭 DoH 并指向受管解析器的原因。
- **过滤、家长控制与强制门户（captive portal）。** Pi-hole、路由器级拦截和家庭过滤器都靠“用 DNS 作答”来工作。一个使用自己加密解析器的客户端直接就绕过去了。面向*指定*解析器的 DoT，以及网络级封锁 DoH，是常见的收拢手段。

这些都不说明加密 DNS 是坏的。它只说明“把 DoH 打开”是一个带二阶效应的决定，而不是闭着眼就能拨的开关。

## 怎么配置

四种现实可行的方案，从系统级到仅浏览器。

### Unbound 通过 DoT 转发

在本机跑 [Unbound](/zh/posts/self-hosted-dns-resolver/)，自己解析整棵树，只在需要可信转发器时，把*上游*那一段走 DoT。关键配置：

```conf
# /etc/unbound/unbound.conf.d/dot.conf
server:
    tls-cert-bundle: "/etc/ssl/certs/ca-certificates.crt"
    # 尽可能自己递归解析，根本不需要转发腿：

forward-zone:
    name: "."
    forward-tls-upstream: yes
    forward-addr: 1.1.1.1@853#cloudflare-dns.com
    forward-addr: 9.9.9.9@853#dns.quad9.net
```

如果你更愿意做纯递归解析——这是隐私立场最强的一种——就整段删掉 `forward-zone`，让 Unbound 从根服务器自己走下去；那正是[自建解析器那篇文章](/zh/posts/self-hosted-dns-resolver/)里的配置。用 `unbound-host -v -C /etc/unbound/unbound.conf example.com` 验证一下。

### systemd-resolved 启用 DoT

在较新的 Linux 桌面或服务器上，`systemd-resolved` 可以对选定的上游全局启用 DoT：

```ini
# /etc/systemd/resolved.conf.d/dot.conf
[Resolve]
DNS=1.1.1.1#cloudflare-dns.com 9.9.9.9#dns.quad9.net
DNSOverTLS=yes
DNSSEC=allow-downgrade
Domains=~.
FallbackDNS=
```

```bash
sudo systemctl restart systemd-resolved
resolvectl status            # 确认当前链路上出现 "+DNSOverTLS"
resolvectl query example.com # 显示使用的传输方式与应答的服务器
```

`DNSOverTLS=yes` 是严格模式：若上游拒绝 TLS，解析就会失败，而不会悄悄退回明文。这通常正是你想要的；如果你宁可降级也不愿中断，就用 `opportunistic`。

### 浏览器 DoH

Firefox 和 Chrome 允许你直接指定 DoH 解析器，独立于操作系统。Firefox：**设置 → 隐私与安全 → DNS over HTTPS → 最大保护**。Chrome：**设置 → 隐私和安全 → 安全 → 使用安全 DNS**。这是单用户见效最快的一招，也是网络管理员最头疼的一招。如果你管理终端，就下发企业策略把它关掉，并固定到你自己的解析器。

```bash
# 不用浏览器，直接确认某个 DoH 端点究竟怎么作答：
curl -sS -H 'accept: application/dns-json' \
  'https://cloudflare-dns.com/dns-query?name=example.com&type=A' \
  | jq '.Answer'
```

### 面向整个网络的自建解析器

终极形态：在你的局域网里跑一个 Unbound 实例做递归解析，对任何想在最后一段要加密的存根客户端提供 DoT。把 DHCP 的 6 号选项指向它，别让它在公网暴露，就能同时享受隐私和可用的过滤：

```bash
# 最后一段检查：通过 DoT 查询你自己的解析器，看看它给出的证书
kdig -d @192.168.1.10 +tls-ca +tls-hostname=resolver.lan example.com
```

## 我的建议

启用加密 DNS，但要清楚你买到了什么。我的默认做法：

1. **系统级：** 笔记本和服务器用 `systemd-resolved` 开 DoT，指向两个相互独立的上游。一个文件搞定，开箱即用。
2. **家庭网络：** 跑自建的递归 Unbound，让查询根本不离开你的网络。这是唯一一种“加密 DNS”甚至只能算你做过第二好的事情的局面。
3. **浏览器：** 你不管的机器，DoH 就留着；你管的机器群，用企业策略固定到自己的解析器。
4. **别假装它藏住了一切。** **SNI** 和目标 IP 依旧在那里。如果你的威胁模型正是一个握有这些信号的观察者，加密 DNS 只是一层，不是答案——在合适的地方把它和 ECH、VPN、Tor 组合起来。

问题从来不是“加密 DNS 好不好”，而是“我刚才把哪一份信任搬走了，又搬去了一个更好的地方吗？”
