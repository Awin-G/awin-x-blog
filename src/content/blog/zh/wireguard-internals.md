---
title: "WireGuard 内部工作原理：简明拆解它的密码学"
description: "简明拆解 WireGuard 的工作原理：拒绝协商的设计哲学，Curve25519、ChaCha20-Poly1305、BLAKE2s 与 HKDF 四大原语，Noise_IK 握手与前向保密，基于定时器的重新握手，端点漫游，以及为什么 AllowedIPs 就是加密路由。"
pubDate: 2026-11-19
lang: zh
translationKey: wireguard-internals
tags: [networking, security]
featured: false
keywords:
  - WireGuard 工作原理
  - WireGuard 握手
  - ChaCha20-Poly1305
  - Curve25519
  - Noise 协议
---

**WireGuard** 是那种少见的协议：一个下午就能把它彻底搞懂——不是因为浅，而是因为它刻意做得小。要回答 **WireGuard 工作原理**，你并不需要一份写满选项的规范；你只需要四个密码学原语和一种握手模式。整套东西就是 **Curve25519** 用来协商共享秘密，**ChaCha20-Poly1305** 用来加密数据包，**BLAKE2s** 用来做哈希，**HKDF** 负责把一个共享秘密扩展成协议真正需要的那几把彼此独立的密钥。下面每一个设计决定——没什么可协商、没有 CA、没有你需要调优的会话状态——都来自只选这四个、拒绝再加第五个。

## 设计哲学：小巧、固执、拒绝协商

在 Linux 内核里，WireGuard 只有几千行 C，而 OpenVPN 或一整套 TLS 栈是几十万行。这种小不是范围偶然缩小，它*就是*设计本身。协议固定了一套密码学套件，并且不提供任何更换方式：没有 `--cipher` 开关，没有套件列表，没有版本协商，也没有降级路径。当可接受的答案只有一个时，攻击者没法把你劝去用更弱的那个，也没人能把 2014 年的配置粘进生产环境。

另一个主张是：**一个对端就是一个公钥**——不是 IP 地址，不是证书，也不是用户名。这一下就把身份、路由和访问控制压缩进了同样的 32 字节里，也正是它让漫游和 `AllowedIPs` 表现得如此。WireGuard 只是一个数据面：它在密钥之间搬运数据包，把成员关系、发现和策略留给了别人。

## 四大原语：Curve25519、ChaCha20-Poly1305、BLAKE2s 与 HKDF

所有活儿由四个原语干完。下面说说每个的直觉。

### Curve25519：负责密钥交换

**Curve25519**（具体说是 X25519）是一个椭圆曲线 Diffie–Hellman 函数。每一方都有一个私钥标量和一个公钥点；你把自己的私钥与对方的公钥结合，就得到与他们相同的共享秘密，而只看得到这两个公钥的窃听者什么也得不到。这就是为什么 32 字节的密钥能顶替一张证书。

有两点要紧。*静态*密钥对是你的长期身份；*临时*密钥对每次握手都重新生成，用的是同一套数学。另外，X25519 是密钥协商，不是签名：WireGuard 靠「你能算出共享秘密」来认证，而不是靠校验签名。整个协议里没有任何签名算法。

### ChaCha20-Poly1305：负责保护数据

**ChaCha20-Poly1305** 是一种 AEAD——带关联数据的认证加密——它保护每一个传输包。ChaCha20 是负责加密的流密码；Poly1305 是证明密文未被改动的认证器。因为二者是一个合并操作，接收方要么解出一个真实的包，要么直接丢弃。不存在「读到被篡改的明文」这种状态。

它在纯软件下也很快，而且天然是常数时间的——这对缺少 AES 硬件加速的设备很重要。但 WireGuard 选它而非 AES-GCM 更重要的原因，是 ChaCha20-Poly1305 没有可以被误选的弱变体。

### BLAKE2s 与 HKDF：负责哈希与密钥派生

**BLAKE2s** 是哈希。它支撑着握手中的带密钥哈希与 MAC，并且在 32 位和 64 位 CPU 上都很快。

**HKDF** 是那个更安静的原语。一次 Diffie–Hellman 交换只给你*一个*共享秘密；一条能用的隧道需要*好几把*彼此独立的密钥——每个方向一把，每个会话一套。HKDF（RFC 5869）能把一个秘密扩展成任意多个独立密钥，每把都用一个文本标签隔开，这样为某个用途派生的密钥永远不会和别处的混淆。WireGuard 从不把裸的 DH 输出直接当密钥用，它总是先过一遍 HKDF。

<figure>
  <svg viewBox="0 0 760 420" width="100%" role="img" aria-labelledby="wg-kd-zh-title" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">
    <title id="wg-kd-zh-title">WireGuard 密钥派生</title>
    <g fill="none" stroke="#0f766e" stroke-width="1.5">
      <rect x="60" y="40" width="280" height="42" rx="8"/>
      <rect x="420" y="40" width="280" height="42" rx="8"/>
      <rect x="60" y="94" width="280" height="42" rx="8"/>
      <rect x="420" y="94" width="280" height="42" rx="8"/>
    </g>
    <g fill="currentColor" text-anchor="middle">
      <text x="200" y="66">Curve25519 DH：s_i × s_r</text>
      <text x="560" y="66">Curve25519 DH：s_i × e_r</text>
      <text x="200" y="120">Curve25519 DH：e_i × s_r</text>
      <text x="560" y="120">Curve25519 DH：e_i × e_r</text>
    </g>
    <line x1="200" y1="136" x2="200" y2="160" stroke="currentColor" stroke-opacity="0.5"/>
    <line x1="560" y1="136" x2="560" y2="160" stroke="currentColor" stroke-opacity="0.5"/>
    <line x1="200" y1="160" x2="560" y2="160" stroke="currentColor" stroke-opacity="0.5"/>
    <line x1="380" y1="160" x2="380" y2="180" stroke="#0f766e" stroke-width="2"/>
    <polygon points="380,190 373,176 387,176" fill="#0f766e"/>
    <rect x="230" y="192" width="300" height="46" rx="8" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="380" y="220" text-anchor="middle" fill="currentColor">链密钥 ck（用 BLAKE2s 混合）</text>
    <line x1="380" y1="238" x2="380" y2="256" stroke="#0f766e" stroke-width="2"/>
    <polygon points="380,266 373,252 387,252" fill="#0f766e"/>
    <rect x="270" y="268" width="220" height="42" rx="8" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="380" y="294" text-anchor="middle" fill="currentColor">HKDF(ck, label)</text>
    <line x1="380" y1="310" x2="380" y2="330" stroke="currentColor" stroke-opacity="0.5"/>
    <line x1="200" y1="330" x2="560" y2="330" stroke="currentColor" stroke-opacity="0.5"/>
    <line x1="200" y1="330" x2="200" y2="346" stroke="#0f766e" stroke-width="2"/>
    <polygon points="200,356 193,342 207,342" fill="#0f766e"/>
    <line x1="560" y1="330" x2="560" y2="346" stroke="#0f766e" stroke-width="2"/>
    <polygon points="560,356 553,342 567,342" fill="#0f766e"/>
    <rect x="60" y="358" width="280" height="44" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.4"/>
    <rect x="420" y="358" width="280" height="44" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="200" y="385" text-anchor="middle" fill="currentColor">K1：发起方 → 响应方</text>
    <text x="560" y="385" text-anchor="middle" fill="currentColor">K2：响应方 → 发起方</text>
  </svg>
  <figcaption>从共享秘密到传输密钥：四次 Curve25519 交换汇入一个 BLAKE2s 链密钥，再由 HKDF 扩展成每个方向各一把、彼此独立的 ChaCha20-Poly1305 密钥。</figcaption>
</figure>

## WireGuard 握手：一轮往返完成的 Noise_IK

WireGuard 的握手是 **Noise 协议**框架的一个实例，模式名为 `Noise_IKpsk2`。把这个名字读成一句关于「谁知道什么」的话：`K` 表示发起方在发出第一个字节之前就已经知道响应方的静态公钥；`I` 表示发起方在第一条消息里带上自己的静态公钥；`p` 和 `s2` 是 WireGuard 的补充——可选的预共享密钥，以及用 BLAKE2s 作哈希。实际中，`IK` 正是两端配置里都要列出对方公钥的原因：每一方在开口之前就已知自己在跟谁说话。

整个 **WireGuard 握手**只有一轮往返、两条消息。

<figure>
  <svg viewBox="0 0 760 400" width="100%" role="img" aria-labelledby="wg-hs-zh-title" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">
    <title id="wg-hs-zh-title">WireGuard 握手</title>
    <desc id="wg-hs-zh-desc">发起方与响应方在一轮往返内交换临时密钥与静态密钥，随后各自派生传输密钥。</desc>
    <text x="140" y="26" text-anchor="middle" fill="currentColor" font-weight="600">发起方</text>
    <text x="620" y="26" text-anchor="middle" fill="currentColor" font-weight="600">响应方</text>
    <line x1="140" y1="42" x2="140" y2="252" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="4 4"/>
    <line x1="620" y1="42" x2="620" y2="252" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="4 4"/>
    <line x1="148" y1="124" x2="610" y2="124" stroke="#0f766e" stroke-width="2"/>
    <polygon points="618,124 604,117 604,131" fill="#0f766e"/>
    <text x="384" y="90" text-anchor="middle" fill="currentColor">1）临时公钥、静态公钥（加密）、</text>
    <text x="384" y="106" text-anchor="middle" fill="currentColor">时间戳、MACs</text>
    <line x1="612" y1="200" x2="150" y2="200" stroke="#0f766e" stroke-width="2"/>
    <polygon points="142,200 156,193 156,207" fill="#0f766e"/>
    <text x="384" y="176" text-anchor="middle" fill="currentColor">2）临时公钥、MACs</text>
    <rect x="60" y="272" width="640" height="48" rx="8" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="380" y="292" text-anchor="middle" fill="currentColor">双方基于 Curve25519 Diffie-Hellman 链运行 HKDF</text>
    <text x="380" y="310" text-anchor="middle" fill="#0f766e" font-weight="600">→ 两把传输密钥，每个方向各一把</text>
    <rect x="60" y="336" width="640" height="48" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="380" y="356" text-anchor="middle" fill="currentColor">数据：ChaCha20-Poly1305，64 位计数器 nonce</text>
    <text x="380" y="376" text-anchor="middle" fill="currentColor" font-size="12">按定时器重新握手；旧密钥随即销毁</text>
  </svg>
  <figcaption>一轮往返完成的 Noise_IK：消息 1 带上发起方的临时公钥和静态公钥，消息 2 带上响应方的临时公钥，随后双方用 HKDF 各自派生出相互独立的传输密钥。</figcaption>
</figure>

真正在线上传的东西：

```text
发起方                                      响应方
  e_i = 新生成的临时密钥对
  m1：e_i、encrypted(s_i)、时间戳、MACs  ─────────────►
                                              e_r = 新生成的临时密钥对
  ◄───────────── m2：e_r、encrypted(空)、MACs
  双方：对 DH 链运行 HKDF → 两把传输密钥
  数据：ChaCha20-Poly1305，64 位计数器 nonce
```

### 静态密钥负责认证，临时密钥带来前向保密

两类密钥，两种职责。**静态**密钥是长期的，用来证明你*是谁*：只有持有私钥那一半的人，才能算出解密第一条消息所需的共享秘密，所以身份不是被「声称」的，而是被「证明」的。**临时**密钥每次握手生成、用完即擦除，它们买到的是 **前向保密（forward secrecy）**：会话的传输密钥来自牵涉临时秘密的 Diffie–Hellman，因此即使攻击者录下了你全部流量、事后又偷走了你的静态私钥，也无法解密昨天的会话——那些临时私钥早已不在内存里。

把直觉记清楚：你的长期密钥只负责为会话「背书」，它并不加密你的数据。真正保护数据的是那个谁都留不住的秘密。

可选的预共享密钥再加一层：把它混进握手后，攻击者必须同时攻破一个临时秘密和这把 PSK 才能解密抓到的会话——这是对未来量子计算机的常规对冲。

### 用定时器取代重新协商

因为没有什么可协商的，重新握手不是一段对话，而是一个时钟。WireGuard 会按定时器、或在数据量足够大之后重新握手，且总由当初发起会话的那一方启动。这些常量很短，而且公开：

```c
#define REKEY_AFTER_TIME     120            /* 每 120 秒重新握手            */
#define REKEY_AFTER_MESSAGES (1ULL << 60)   /* ……或每这么多条消息           */
#define REJECT_AFTER_TIME    180            /* 密钥硬性过期                 */
#define REKEY_TIMEOUT        5              /* 重试丢失的握手               */
```

旧密钥会短暂保留，好让在途的包不丢，随后销毁。硬性过期的意思是：一个沉默下去的对端无法永远把会话挂着。没有 hello，没有能力交换——只有一个双方本就一致的定时器。

## 漫游与保活：endpoint 不是身份

当一个对端移动时——笔记本从 Wi-Fi 切到蜂窝、手机换基站——它的源地址变了。WireGuard 不会掉线，因为它从不把会话绑在地址上，而是绑在一个静态公钥上。一旦从一个新的 `IP:port` 收到有效的、通过认证的包，WireGuard 就更新它回复该对端所用的 endpoint，因为只有真正的对端才持有能认证这个包的密钥。漫游是「身份即密码学」的副产品，而不是后来硬贴上去的功能。

这也正是服务端不必为拨入的客户端配置 `Endpoint` 的原因——它从第一个认证包里就学到了。客户端之所以有 `Endpoint`，是因为它才是发起方。

保活是这件事的小跟班。NAT 设备过一阵子就会忘掉一条 UDP 映射；一旦忘掉，服务端就再也够不到客户端。`PersistentKeepalive = 25` 每 25 秒发一个经过认证的空包，让这条映射保热。它不是 NAT 穿透，也不会创造一条路径——只是阻止已有的那条过期。搭在 NAT 后面的一侧才设它，别处就别设，因为那是以唤醒无线电为代价的周期性流量。

## AllowedIPs 就是加密路由

`AllowedIPs` 是「路由决定」与「认证决定」融为一体的产物。出方向，它是一张路由表：目标地址落在某个对端 `AllowedIPs` 里的包被交给该对端。入方向，它是在包被对端密钥认证*之后*才评估的源过滤——只有源地址同样落在这个集合里，来自该对端的包才会被接受。

因为检查是在一个已认证的包上进行的，地址伪造不是一个你能配出的错误，而是结构上不可能。推论——也是把人绊倒的那部分——是两边必须一致：把某个对端的 `AllowedIPs` 放宽到恰好它被允许发起的那些地址，不多不少。这些失效模式我在[《WireGuard 从零开始》](/zh/posts/wireguard-from-scratch/)里走过一遍。

## 诚实的边界

上面这一切，都是协议保持小巧、把自己那一件事做好。同样的极简也带来四条真实边界，早点知道能省下几周：

- **没有动态密钥分发。** 没有目录，没有控制面，没有「加入网络」这一步：新对端就是手写的一段配置，轮换任何一把密钥都意味着去改每一个引用它的对端。
- **没有 NAT 穿透。** 它不会发现对端、打洞或中继，也没有 STUN 客户端和会合点。两个都在对称 NAT 后面的对端就是碰不上面——机制见[《NAT 穿透详解》](/zh/posts/nat-traversal-explained/)。
- **只能用 UDP。** 没有 TCP 模式，也没有内置的 443 端口回退。在直接封掉 UDP 的网络上——某些酒店、某些企业网——纯 WireGuard 就是不可用。
- **只有密钥，没有用户。** 没有 SSO，没有按用户的 ACL，没有吊销列表，没有审计日志。`wg` 能告诉你握手有多新、收发了多少字节，可观测性就这么多。

这些都不是待修的 bug，而是一个数据面的边界。线上的东西——发现、成员、策略、吊销——都是在它之上叠加的第二件产品。

## 最小配置

最小的诚实例子：一台有公网地址的服务端和一个客户端。注意它有多小，也注意密码学替你决定的事——服务端那一侧没有客户端 endpoint，身份就是公钥。

```ini
# 服务端：/etc/wireguard/wg0.conf
[Interface]
Address = 10.9.0.1/24
ListenPort = 51820
PrivateKey = <server.key>

[Peer]                        # 那台笔记本
PublicKey = <client.pub>      # 身份，而不是地址
AllowedIPs = 10.9.0.2/32      # 路由 + 源过滤，合二为一

# 客户端：/etc/wireguard/wg0.conf
[Interface]
Address = 10.9.0.2/24
PrivateKey = <client.key>

[Peer]
PublicKey = <server.pub>
Endpoint = 203.0.113.10:51820
AllowedIPs = 10.9.0.0/24
PersistentKeepalive = 25
```

## 小结

WireGuard 就是四个原语加一个想法。Curve25519 协商出一个秘密；HKDF 把它拆成彼此独立的密钥；ChaCha20-Poly1305 把它们变成经过认证的包；BLAKE2s 把握手串起来。握手是一轮往返的 Noise_IK——静态密钥证明身份，临时密钥带来前向保密，定时器取代重新协商。漫游和 `AllowedIPs` 是同一个选择的副产品：一个对端*就是*一个公钥，所以它碰巧在用的地址，只是要把回复发往的地方。

你得到的是一条极小巧、极快、极难配错的隧道。你没得到的——发现、密钥分发、NAT 穿透、TCP 回退、用户——是那条诚实的边界，而所有填补它的东西，都住在协议之上，而不是协议里面。
