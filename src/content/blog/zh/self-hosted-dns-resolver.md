---
title: "自建递归 DNS 解析器实战（以及哪些情况下你不该自建）"
description: "转发器与真正的递归 DNS 解析器有何区别，为什么值得自建 DNS（隐私、无上游日志、过滤、掌控权），可选方案（Unbound、Knot Resolver、dnsdist），一份加固过的 Unbound 配置——qname minimisation、DNSSEC、缓存调优、访问控制，以及必须避开的 open resolver 故障模式。"
pubDate: 2026-10-28
lang: zh
translationKey: self-hosted-dns-resolver
tags: [networking, self-hosting, security]
featured: false
keywords:
  - 递归 DNS 解析器
  - 自建 DNS
  - Unbound
  - qname 最小化
  - DNSSEC
---

我在自己的局域网里跑**递归 DNS 解析器**已经好几年了，它是少数几个我愿意从零重建的自托管服务之一。它同时也是最容易把事搞砸的服务之一：一台暴露在公网 IP 上、配置错误的解析器，不是什么有个性的玩具项目，而是一台别人几小时内就会找到的 DDoS 放大机。这篇就是我当初最想先读到的版本——**自建 DNS** 解析器和你大概率已经在用的转发器究竟差在哪，这些取舍为什么值得，一份具体的 **Unbound** 配置（含 **qname minimisation**、**DNSSEC**、缓存调优与访问控制），以及那些老老实实该用运营商解析器的情况。

## 转发器不是递归解析器

大多数人自建的“DNS 服务器”其实是*转发器*。路由器上的 `dnsmasq`、笔记本上的 `systemd-resolved`、以及开箱即用的每一个 Pi-hole 安装：它们把你的查询交给别人——`1.1.1.1`、`8.8.8.8`、你的运营商——然后把答案缓存下来。它们只是代理。仍有人在更上游替你走完整棵树。

真正的递归解析器自己走这棵树。它从根服务器开始，沿着转介走到顶级域，再走到该 zone 的权威服务器，最后返回答案——完整的流程我在[《DNS 究竟是怎么解析的》](/zh/posts/how-dns-resolves/)里拆解过。除非委派链本身要求，否则没有第三方看得到你的问题。

这个区别就是整件事的意义所在：

- **转发器**外包了信任。你的上游能看到你查询的每一个域名、按顺序、绑定在你的 IP 上。
- **递归解析器**把问题留在你自己的机器上。根和顶级域服务器只看到路径的碎片，权威服务器只看到最终那次查询，但没有任何一个运营方能看到你的完整浏览历史。

## 到底为什么要自建解析器

理由不是“更快”——在冷缓存下它通常并不快。理由是**掌控权**。

- **对抗上游日志的隐私。**你的运营商、公司的网络、公共解析器都在记录查询。把递归留在本地，意味着你完整查询流唯一存在的地方，是一台你能审计的机器上、属于你自己的缓存。
- **不受上游策略影响。**公共解析器会按运营方的决定做过滤、屏蔽或返回 NXDOMAIN。递归解析器只如实返回 DNS 真正说了什么。
- **按你自己的规则过滤。**你可以屏蔽追踪器、广告域名，或只针对某一台设备屏蔽某个主机名，而不用重定向别人的流量。
- **内部域名，一个解析器搞定。**递归解析器可以同时充当你自己局域网 zone（`home.lan`、`internal.example`）的权威服务器，客户端从同一台机器就能拿到分域解析（split-horizon）的答案。
- **自带 kill switch。**把局域网指向它之后，出站到公网的 53 端口可以完全丢弃——没有任何东西能悄悄绕过你的策略。

如果你的威胁模型是“我不想让运营商从我的 DNS 里拼出一份画像”，这就是你能做的最便宜、最有意义的一步。

## 选哪个解析器：Unbound、Knot Resolver，还是 dnsdist

三个名字几乎覆盖了所有真实部署场景，而它们并不能互相替代。

| 项目 | 定位 | 什么时候该用它 |
| --- | --- | --- |
| **Unbound** | 完整的递归解析器，做校验，也兼具轻量权威功能 | 你想要一个扎实的守护进程，和一份自己完全看得懂的配置 |
| **Knot Resolver** | 完整递归解析器，现代缓存，Lua 策略引擎 | 你需要可编程策略：按客户端返回不同答案、复杂规则 |
| **dnsdist** | DNS 负载均衡器 / 前端 | 你已有后端，需要限速、DoH/DoT、以及前置缓存 |

Unbound 是我的默认选择：单个 C 二进制、无运行时依赖、有文档完整的配置，而且它的安全记录来自“只干一件事”。当你需要策略引擎、也熟悉它的 Lua 钩子时，Knot Resolver 非常出色。dnsdist 根本不是解析器——它是你放在解析器*前面*、用来吸收滥用流量并终结加密传输的那一层。

## 一份具体的 Unbound 配置

下面是一个加固过的起点。它只监听局域网、校验 DNSSEC、启用 qname 最小化、调优缓存，并拒绝一切它不该回答的东西。

```yaml
# /etc/unbound/unbound.conf.d/local.conf
server:
    verbosity: 1
    interface: 10.0.0.1
    interface: ::1
    port: 53
    do-ip4: yes
    do-ip6: yes
    do-udp: yes
    do-tcp: yes

    # 访问控制：只服务局域网。这是最重要的一行。
    access-control: 10.0.0.0/8 allow
    access-control: 192.168.0.0/16 allow
    access-control: 0.0.0.0/0 refuse
    access-control: ::/0 refuse

    # 加固
    hide-identity: yes
    hide-version: yes
    harden-glue: yes
    harden-dnssec-stripped: yes
    harden-below-nxdomain: yes
    harden-referral-path: yes
    use-caps-for-id: yes
    qname-minimisation: yes
    qname-minimisation-strict: yes

    # DNSSEC：校验，且失败即失败
    auto-trust-anchor-file: "/var/lib/unbound/root.key"
    val-clean-additional: yes
    val-log-level: 2

    # 显式指定根提示，而不是盲信打包好的文件
    root-hints: "/var/lib/unbound/root.hints"

    # 缓存调优
    msg-cache-size: 64m
    rrset-cache-size: 128m
    cache-min-ttl: 60
    cache-max-ttl: 86400
    prefetch: yes
    prefetch-key: yes
    serve-expired: yes
    serve-expired-ttl: 86400
```

其中最重要的几行，按重要性排序：

- **`access-control`**——末尾那条 `0.0.0.0/0 refuse` 保证即使防火墙漏了，这台机器也拒绝成为开放解析器。永远不要把它暴露到公网。
- **`qname-minimisation: yes`**——解析器向根请求的是尽可能短的名字（先 `.`，再 `com.`，再 `example.com.`），而不是把完整查询泄露给上游。严格模式下，除非必要否则根本不发送任何消息。
- **`auto-trust-anchor-file`**——启用 DNSSEC 校验。`val-clean-additional` 会剥掉 additional 段里的伪造记录；校验开启时，被篡改的答案返回 `SERVFAIL`，而不是一个地址。
- **`harden-glue`、`harden-referral-path`**——拦掉 Kaminsky 时代那些缓存投毒攻击所利用的 off-path 类别。

验证它是真的在校验，而不只是嘴上说说：

```bash
# 已签名的域名必须校验通过（rcode 为 NOERROR，ad 标志置位）
dig +dnssec @10.0.0.1 cloudflare.com

# 故意做坏的 DNSSEC 测试域名必须失败
dig +dnssec @10.0.0.1 dnssec-failed.org
# 期望：status: SERVFAIL —— 如果你拿到 A 记录，说明校验没开。
```

然后再确认它是从根开始解析、而不是走转发器：

```bash
unbound-control status
unbound-control lookup www.example.com
dig +trace @10.0.0.1 www.example.com
```

## 加密最后一跳：DoT 与 DoH

对公网的递归本身仍是明文 UDP。如果你的解析器要跨过一段不可信链路，那就干脆把递归整件事挪出本机，改为通过 **DoT** 或 **DoH** 向受信任的上游转发：

```yaml
forward-zone:
    name: "."
    forward-tls-upstream: yes
    forward-addr: 1.1.1.1@853#cloudflare-dns.com
    forward-addr: 9.9.9.9@853#dns.quad9.net
```

但要诚实地看待这个取舍：`forward-tls-upstream` 让网络路径变私密了，却把你的查询流交给了那个上游。你不可能同时拥有完整递归*和*通往它的加密传输——权威服务器不会说 DoT。解析器处在敌对链路时，真正的解法通常是 VPN，而不是对着第三方用 DoT。**DoT DoH** 保护的是存根到解析器这一跳；它本身并不让递归变私密。

## 性能与现实

要对自己诚实：你得到的是什么。一台冷递归解析器*比*一台缓存里已经装着半个互联网的大型公共解析器要慢。

- **第一次查询很贵。**根 → 顶级域 → 权威，在你的查询有结果之前就是三次往返。公共解析器把这笔成本摊到几百万人头上；你得自己付。
- **缓存预热是真的，但收益不大。**一台全新的解析器什么都不持有。`prefetch` 和 `serve-expired` 让热门域名保持温暖，`unbound-control` 也能预先灌入你的常用域名——但除非你有很多客户端，收益其实有限。
- **延迟主要取决于最后一跳。**一旦进了缓存，本地解析器在 1 毫秒内就能作答。这是浏览体验上的*感知*收益，不是带宽收益。
- **根提示很重要。**一份过期的 `root.hints` 会让每一次冷查询都绕到错误或已死的 anycast 节点上。定期刷新它，永远不要把它当成静态文件：

```bash
# 每月刷新根提示（根主服务器自 2019 年以来一直是稳定的）
curl -s https://www.internic.net/domain/named.root -o /var/lib/unbound/root.hints
systemctl restart unbound
```

- **内存是调优旋钮。**`rrset-cache-size` 与 `msg-cache-size` 之和应大于你客户端会触碰到的域名工作集；对家庭或小型办公室来说，128 MB 的 rrset 缓存已经相当宽裕。

## 故障模式：开放解析器问题

这里开始，自建 DNS 就不好玩了。

**开放解析器（open resolver）**会回答任何人的递归查询。这使它成为一件 DDoS 放大的武器：攻击者用一个伪造的源 IP——你的——发出 DNS 查询，解析器就把一个大得多的响应轰向受害者。一个小查询会变成 50×–100× 大小的回复，而有一些僵尸网络，在机器一上线几分钟内就会扫到 53 端口。

防御手段，按顺序：

1. **只绑定局域网接口**——绝不要 `0.0.0.0`。上面的 `access-control` 是兜底；接口绑定才是主墙。
2. **在边界丢弃出站 53 端口。**你的解析器应该是唯一被允许在 UDP/TCP 53 上和公网通信的东西，这样一台被攻陷的客户端就无法变成恶意源：

```bash
# nftables：允许局域网客户端访问解析器，阻断直连出站的 53
nft add rule inet filter output udp dport 53 ip daddr 10.0.0.1 accept
nft add rule inet filter forward udp dport 53 drop
nft add rule inet filter forward tcp dport 53 drop
```

3. **限速并封顶。**即使在局域网内，一个失控的客户端也不应该拖垮所有人：

```yaml
server:
    ratelimit: 200            # 每客户端响应/秒，过载时翻倍
    ip-ratelimit: 50          # 每源 IP 查询/秒
    num-queries-per-thread: 4096
```

4. **打开 RRL（响应限速）。**Unbound 的 `ip-ratelimit` 加上 `ratelimit` 能抑制伪造源的洪水。如果你真的要服务很多客户端，就把 [dnsdist 放到前面](/zh/posts/self-hosting-without-docker/)，在滥用流量抵达解析器之前就吸收掉。
5. **监控它。**查询量飙升、突然涌来大量 `TXT` 或 `ANY`、或者来自你子网之外发往 53 端口的流量，都意味着你被人利用了。为它配告警，别等那封滥用投诉邮件。

## 什么时候你该直接用运营商的解析器

递归不是免费的，而诚实的答案是：大多数人就不该自己搭。以下情况请跳过：

- **你在用一台到处跑的笔记本。**在不断切换网络的机器上跑解析器，意味着解析器一不可达，你的查询就全废了。用系统存根加一个靠谱的 DoH/DoT 上游。
- **你的上游本来就可信又近。**一台运行良好、距离只有几毫秒、缓存巨大的运营商解析器，在延迟和策略上都能打赢一台冷的本地解析器。如果你信任那个运营方，你并没损失多少。
- **你想要零维护。**递归需要刷新根提示、处理信任锚轮换、更新版本、做监控。托管的解析器一个都不需要。
- **你已经在用不错的加密转发器了。**`systemd-resolved` 或浏览器里的 DoH 配置，能给你绝大多数的路径隐私，而完全没有被滥用的风险。

当你有稳定的网络、不止寥寥几个客户端、一个真实的隐私理由，以及把机器防火墙配置到位的纪律时，再自建递归解析器。否则，一个可信的解析器——配上 DoT 或 DoH——才是更聪明、更无聊、也更正确的选择。重点不是跑更多软件，而是你清楚地知道：究竟是谁在看你的查询，以及为什么。
