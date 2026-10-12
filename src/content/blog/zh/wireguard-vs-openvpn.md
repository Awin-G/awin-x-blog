---
title: "WireGuard vs OpenVPN：2026 年最诚实的对比"
description: "一份公允的 2026 年 WireGuard vs OpenVPN 对比：设计与代码量、加密方式（Noise 对 TLS）、内核与用户态性能、漫游、NAT 穿越、配置复杂度、UDP 443 回退、企业级认证与客户端支持——附带决策表、明确建议，以及各自的适用场景。"
pubDate: 2026-10-24
lang: zh
translationKey: wireguard-vs-openvpn
tags: [networking, self-hosting, security]
featured: false
keywords:
  - WireGuard vs OpenVPN
  - WireGuard
  - OpenVPN
  - VPN 对比
  - UDP 443
---

**WireGuard vs OpenVPN** 是每个自托管玩家迟早都会去搜的对比，而大多数答案要么过时了十年，要么带着粉丝滤镜。这里是诚实版。**WireGuard** 是一个内核优先的小协议，只有一套固定的加密算法，几乎没有配置面。**OpenVPN** 是一个二十岁的用户态 **TLS VPN**，能跑在 UDP 或 TCP 上——包括 443 端口——并且带有一套至今没人完全取代的企业级功能。配置得当的前提下，两者都安全。它们是为不同问题而造的，一份有用的 2026 年 **VPN 对比**，最后会落在“取决于三件事”上。

## 设计与代码量：极简 vs 完整工具箱

**WireGuard** 大约几千行 C 代码，主体跑在 Linux 内核里。它只做一件事：在以公钥互相标识的对端之间，建立一条加密的 UDP 隧道。没有加密套件协商，没有插件系统，没有压缩层，也没有要你调的连接状态机。

**OpenVPN** 大约十万行代码，外加它所链接的 TLS 库。它是一个框架：终结 TLS、协商数据通道加密、支持证书颁发机构、用户名/密码认证、插件，以及一个管理接口。大不是缺点——正是它撑起了那些企业级功能——但它是更大的一块需要维护的面。

实际翻译过来：WireGuard 的简单，意味着更少的出错路径；OpenVPN 的庞大，意味着更多能力与更多旋钮，这既是卖点，也是陷阱。

## 加密方式：Noise vs TLS VPN

**WireGuard** 使用 **Noise 协议框架**，配一套固定而偏执的算法：Curve25519 做密钥交换，ChaCha20-Poly1305 做认证加密，BLAKE2s 做哈希，SipHash 做哈希表键。它没有加密套件灵活性。你无法协商出更弱的套件，这正是重点——根本不存在可降级的东西。

**OpenVPN** 是一个 **TLS VPN**：它先建立一条 TLS 控制通道（通常用证书，有时再叠一层用户名/密码），然后协商数据通道加密，比如 AES-GCM 或 ChaCha20-Poly1305。这份灵活性是双刃剑。配置得当，OpenVPN 和 WireGuard 一样强。配置得懒——用了老的 CBC 加密、弱的 DH 组、从论坛上抄来一份 2014 年的配置——它就可能弱得多。加密灵活性让你几乎能与任何东西互通；它也让你有机会把自己打穿。

诚实的结论：配置现代化时，两者都安全。如果你想要一个**无法**被错配成弱加密的协议，WireGuard 在设计上就赢了。如果你需要和一个老旧的、或受监管的技术栈互通，OpenVPN 的灵活性正是它至今仍在的原因。

## 性能：内核 vs 用户态

性能是人们争论最多、数据最少的一个维度，所以我就定性地说。**内核 WireGuard** 把数据面放在内核里，意味着没有上下文切换，也没有每个包在用户态与内核态之间的拷贝。它以低 CPU 开销换来高吞吐。**OpenVPN** 传统上跑在用户态，多出每个包的拷贝和上下文切换；在同样的硬件上，它历来要吃掉更多 CPU 才能达到相同吞吐。

两个前提让这个对比保持公平。第一，这在很大程度上**因人而异**——取决于 CPU、网卡、MTU、加密算法和调优——我不会报一个吞吐数字，因为任何我给出的数字在你的硬件上都会是错的。第二，差距正在缩小：OpenVPN 现在有数据通道卸载（DCO），在 Linux 上把数据面推进内核；而 WireGuard 在没有内核实现的平台上（macOS、iOS、Windows 的官方客户端）跑在用户态，内核优势并不适用。

结论：如果每核的原始吞吐很重要，而且你在 Linux 上，内核 WireGuard 通常占优。否则，把两者看作大致相当，并测量你自己的环境。

## 漫游与移动性

WireGuard 用一个对端的**公钥**、而不是它的 IP 地址来标识它。当一个通过认证的包从新的源地址到达时，WireGuard 只是把回复的目标端点更新一下。这就是无缝漫游：一台笔记本从 Wi-Fi 切到蜂窝网络，隧道不用重连就继续开着。

OpenVPN 把一个会话绑在它底层的连接上。客户端 IP 一变，会话通常就断了、然后重连，这中间涉及一次新的 TLS 握手和一段可见的中断。keepalive 和重协商设置能缓解，但它的模型是面向连接的。

对手机、笔记本，以及任何会移动的设备来说，这是每天都会感受到的、对 WireGuard 有利的差别。

## NAT 穿越：谁都不给你

这是几乎每个对比都搞错的地方。**WireGuard 和 OpenVPN 都不做 NAT 穿越。** 两者都是数据面。都不做 STUN 式发现，都不打洞，也都不中继。如果两个对端都躲在对称 NAT 后面，没有任何一个协议能凭空变出一条直连路径。

它们各自能提供的都很有限。WireGuard 只会把回复发到最后一个通过认证的包的源地址，而 `PersistentKeepalive` 能让 NAT 映射保持打开，好让对端反向够到它。OpenVPN 也有自己的 keepalive 行为。但*发现*对端、协调打洞、并在打不通时中继，是 **overlay** 的活儿——Tailscale、NetBird、EasyTier 之类。我在[2026 年 mesh VPN 横评](/zh/posts/mesh-vpn-comparison-2026/)里详细讲过这一层：发现与中继活在隧道之上，不在隧道之内。

所以，如果你真正的问题是“NAT 后面的两台机器必须互相找到对方”，那你根本不是在 WireGuard 和 OpenVPN 之间做选择。你是在选一个 overlay，而 WireGuard 往往是它底下的传输层。

## 配置复杂度

WireGuard 的配置短到能装进脑子里。每一边一个 interface 块、一个 peer 块，加上每个接口一对密钥。

```ini
# /etc/wireguard/wg0.conf —— 一个完整的客户端
[Interface]
Address = 10.9.0.2/24
PrivateKey = <client.key>

[Peer]
PublicKey = <server.pub>
Endpoint = 203.0.113.10:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
```

OpenVPN 需要一套 PKI：一个 CA、服务端与客户端证书、一份 `server.conf`，以及一个打包或引用它们的 `.ovpn` 配置。仪式更多，能出错的地方也更多。

```bash
# OpenVPN：用 easy-rsa 建 CA 和客户端证书，然后启动服务端
./easyrsa init-pki
./easyrsa build-ca nopass
./easyrsa build-server-full server nopass
./easyrsa build-client-full laptop nopass
openvpn --config /etc/openvpn/server.conf
```

不过这套仪式也换来了点东西：吊销。用 OpenVPN，你吊销一个客户端证书，它就失效了，不用碰任何别人。用 WireGuard，你得在每一个引用它的对端上删掉那段 `[Peer]`——这正是 overlay 和 `wg-easy` 这类工具存在的理由。WireGuard 这一侧（含密钥与 `AllowedIPs`）的完整走查在 [WireGuard 从零开始](/zh/posts/wireguard-from-scratch/)。

## UDP vs TCP/443：面对受限网络

WireGuard 只说 **UDP**。它快而干净，但 UDP 很容易被封，在管控严格的公司网络或酒店网络里常常就是被封的。没有原生的 WireGuard-over-TCP；人们会借助 `udp2raw` 这类工具把它包一层，那是多出来的一个活动部件。

OpenVPN 能跑在 **TCP** 上，包括 **TCP/443**，在粗浅的防火墙眼里它就跟普通 HTTPS 一样。在只放行网页流量的网络里，TCP/443 常常是*唯一*的出路。代价是真实的：在 TCP 里套 TCP 会导致“重传之上再重传”（TCP meltdown），一条有丢包的流会拖住它后面的一切。跑在 443 端口的 UDP 是个有用的折中——在浅层嗅探器看来它像 QUIC——但它终究是 UDP，终究能被封。

规则：在宽松网络里，两个协议都优先用 UDP。在只允许 TCP/443 的恶劣网络里，OpenVPN 的 TCP 模式是 WireGuard 给不了的逃生口。

## 生态与企业级功能

WireGuard 没有*用户*的概念。只有对端，而对端就是一个密钥。这意味着没有内置的 SSO、没有 MFA、没有按用户的 ACL、没有吊销列表、没有审计日志。这些每一样都得由别的东西叠上去——一个 overlay、一个管理界面，或者你自己的脚本。

OpenVPN 是为组织而生的。它用 PAM、LDAP 或 RADIUS 认证用户；它通过插件支持 **MFA**（比如 TOTP）；它通过证书吊销列表做到**按客户端吊销**；它提供管理接口用于脚本化、按用户配置和连接审计。商业版的 OpenVPN Access Server 在此基础上更进一步。

对家庭实验室来说，“没有用户，只有密钥”没问题，甚至更好。对一家必须在一次操作里吊销离职员工访问权、并且能在审计里证明的公司来说，OpenVPN 的成熟不是怀旧——那就是它的功能。

## 客户端支持

两者都无处不在，只是尾巴不同。WireGuard 随 Linux 内核发布，并为 Windows、macOS、iOS、Android 和 BSD 提供官方客户端；它正越来越多地被内建进路由器和 NAS 固件。OpenVPN 是更老、更广的那张网：被烧进无数路由器、老旧设备和企业级 VPN 集中器，而且有些老设备一辈子只会说 OpenVPN 或 IPsec。

如果你有一抽屉必须接入隧道的旧硬件，先看 OpenVPN。对任何现代设备而言，WireGuard 的客户端支持已经足够完整。

## 决策表

| 维度 | WireGuard | OpenVPN |
|---|---|---|
| 设计 | 内核优先的小协议 | 用户态的大型 TLS 框架 |
| 代码量 | 约数千行 | 约数十万行 |
| 加密 | 固定的 Noise 套件，不协商 | TLS + 协商数据加密 |
| 性能 | 内核数据面，低 CPU | 用户态；DCO 缩小差距 |
| 漫游 | 无缝（以公钥标识） | 绑定连接；会重连 |
| NAT 穿越 | 不提供 | 不提供 |
| 配置 | 两个短块 + 密钥 | PKI、证书、服务端与客户端配置 |
| 受限网络 | 仅 UDP | UDP，或 TCP/443 回退 |
| 企业认证 | 无内置（需叠 overlay） | LDAP/RADIUS/PAM、MFA、CRL 吊销 |
| 客户端广度 | 现代平台，Linux 内核内 | 最广，含老旧设备 |
| 最适合作默认 | 点到点、现代部署 | 回退、老旧设备、企业认证 |

## 怎么选

**默认选 WireGuard**：点到点链路、站点到站点隧道，以及现代部署。它更小、在 Linux 上更快、漫游更好，而且很难被错配成弱配置。如果你需要发现、ACL 和吊销，就在它上面叠一个 overlay，而不是改用一个更重的协议。

**当下面三件事之一成立时，选 OpenVPN。** 你需要一个 **TCP/443 回退**来穿过封 UDP 的网络。你必须支持只会 OpenVPN 的**老旧设备**。或者你需要**成熟的企业级认证**——开箱即用的 LDAP、MFA 和按客户端吊销。在这些场景里，OpenVPN 不是旧选择，而是正确选择。

同时也别丢掉诚实的那一半：**配置得当时，两者都安全。** 协议很少是薄弱环节；泄露的密钥、过时的加密算法、暴露的管理端口才是。选一个契合你约束的，认真地配置它，并在约束变化时重新审视这个决定。

## 简短版

WireGuard 是一个内核优先的小协议，只有一套强加密、更好的漫游和内核数据面——是点到点与现代机群的正确默认。OpenVPN 是一个庞大而灵活的 TLS VPN，能跑 TCP/443、支持最广的客户端，并带着至今无人完全取代的企业认证与吊销功能。两者都不做 NAT 穿越——那是 overlay 的活儿。配置得当时，两者都不弱。默认用 WireGuard；把 OpenVPN 留给受限网络、老旧硬件，以及需要真正用户管理的组织。
