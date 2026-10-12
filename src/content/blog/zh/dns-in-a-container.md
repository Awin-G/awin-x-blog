---
title: "在容器里跑一个 DNS 服务器：用 dig 戳一戳 CoreDNS"
description: "几分钟搭起一个容器 DNS 服务器：一份最小的 CoreDNS Corefile，从 zone 文件提供自定义权威区域，未知域名转发上游，再用 dig @127.0.0.1 -p 15353 逐条戳它——包含真实的 NXDOMAIN、SERVFAIL、CNAME 链和 TTL 输出。"
pubDate: 2026-12-08
lang: zh
translationKey: dns-in-a-container
tags: [networking, self-hosting, linux]
featured: false
keywords:
  - 容器 DNS 服务器
  - CoreDNS
  - dnsmasq
  - dig
  - 权威 DNS
---

以我自己的经验，真正搞懂 DNS 最快的办法，就是自己跑一个、再故意把它弄坏。
不是那种配好就忘、指向笔记本用的解析器，而是一个用完就扔的**容器 DNS
服务器**：你随时能用 `dig` 盘它、看它返回 NXDOMAIN，再喂给它一个死掉的上游，
让它以 SERVFAIL 收场。用 CoreDNS 做这件事只需要两个文件：一个 `Corefile`
和一个 zone 文件。这篇我会搭一个最小环境，让它为 `lab.example` 充当**权威
DNS**，其余域名转发上游，并绑定到一个非特权端口，避免和 53 端口打架。然后我们
一条条地戳它、读它的回答。

下面每一条命令和每一段回答，都是在 CoreDNS 1.14.7 容器与 dig 9.18.50 上跑出来的
真实输出。

## 为什么要跑一个容器 DNS 服务器

本地 DNS 服务器不只是实验玩具，同样的形态能解决真实问题：

- **实验环境** —— 给测试机器真实的名字（`api.lab.example`），解析方式和生产一致，
  又不用去改每一台机器的 `/etc/hosts`。
- **分裂解析（split-horizon）** —— 从同一份 zone 文件里，让 `app.example.com`
  在局域网内指向内网 IP，在外网则指向公网 IP。
- **拦截与过滤** —— 在解析器层面把广告和遥测域名黑洞掉，Pi-hole 和 AdGuard Home
  底子做的正是这件事。
- **测试 DNS 变更** —— 只出权威回答、自定义 TTL、故意返回 NXDOMAIN，这些从公共
  解析器上都很难拿到。

代价是：你现在负责一个服务，一旦暴露出去，就是一个反射放大攻击源。学习阶段就把它
绑在 `127.0.0.1` 上，就像本文这样。（生产环境的解析器该怎么弄、以及什么时候**不该**
自建，见我[关于自建递归解析器的笔记](/zh/posts/self-hosted-dns-resolver/)。）

## CoreDNS、dnsmasq、BIND 速览

三者都能提供区域解析，但目标不同，选错了就是各种折腾 DNS 配置的根源。

| | CoreDNS | dnsmasq | BIND 9 |
|---|---|---|---|
| 语言 | Go | C | C |
| 配置风格 | `Corefile`（插件链） | 一行一个选项 | `named.conf` + zone 文件 |
| 擅长 | 服务发现、转发、小型权威区域 | 局域网缓存/转发、DHCP、通配符 | 全功能的权威/递归 DNS |
| zone 文件 | 支持（`file` 插件） | `addn-hosts` / `host-record`，无完整 zone 文件 | 支持，参考实现 |
| 重载 | 改 `Corefile` 或用 `coredns -reload` | 重启 | `rndc reload` |
| 感觉像 | 一个小型 Web 服务器 | 路由器里的 DNS | 一个数据库引擎 |

如果你要 DNS 是因为*想顺便要 DHCP 和简单的 host 记录*，用 dnsmasq；如果需要区域
委派、DNSSEC 签名和从服务器，BIND 仍是标准答案。而在容器里做转发、加几个手写的
权威区域，CoreDNS 的仪式感最少——所以我这里用它。

## 一份最小的 Corefile，带一个权威区域

CoreDNS 用 `Corefile` 配置：一列 `zone:port { plugins }` 块。关键细节是 CoreDNS
会为一次查询挑选**最具体**（最匹配）的区域块，于是某个区域块对它名下的名字是权威的，
而通配块则负责转发其余一切。

```text
# Corefile
lab.example:53 {
    file /etc/coredns/db.lab.example   # 从 zone 文件给出权威回答
    log
    errors
}

servfail.lab:53 {
    forward . 192.0.2.1                 # 一个故意死掉的上游
    errors
}

.:53 {
    forward . 1.1.1.1 8.8.8.8 {
        max_concurrent 1000
    }
    cache 30
    log
    errors
}
```

三个块，三种角色：`lab.example` 本地权威提供；`servfail.lab` 只为看 SERVFAIL 怎么
冒出来而存在；其余全部转发给 `1.1.1.1` 和 `8.8.8.8`，带 30 秒缓存。`log` 插件会
打印每一次查询，后面它就成了我们的调试窗口。

## 用 zone 文件提供自定义区域

`file` 插件读的是一个普通 RFC 1035 zone 文件。SOA 和 NS 记录是必需的；在此之上，
我加了两条 A 记录、一条两跳的 CNAME 链和一条 TXT 记录，好让查询有东西可看。

```text
; db.lab.example
$ORIGIN lab.example.
$TTL 3600

@       IN  SOA ns1.lab.example. admin.lab.example. (
                2026120801 ; serial
                7200       ; refresh
                3600       ; retry
                1209600    ; expire
                60 )       ; minimum  (负面缓存 TTL)

@       IN  NS      ns1.lab.example.
ns1     IN  A       10.10.0.53
api     IN  A       10.10.0.5
db      IN  A       10.10.0.6
short   IN  A       10.10.0.99
web     IN  CNAME   api.lab.example.
www     IN  CNAME   web.lab.example.
info    IN  TXT     "lab zone served by CoreDNS"
```

跑之前有两点值得留意。`www` 是指向 `web` 的 CNAME，而 `web` 又是指向 `api` 的
CNAME——这是一条合法的链，解析器必须一路跟到最终的 A 记录。另外 SOA 里最后一个
数字是 **minimum** 字段：它告诉各级缓存，本区域的 NXDOMAIN 该记多久，也就是负面
缓存 TTL。

## 在 Docker 里用非特权端口跑 CoreDNS

特权端口 53 需要 root，我们不想要那个。把主机上一个高位端口映射到容器的 53，并
绑定到回环地址，这样它就不会暴露到网络上。

```bash
docker run -d --name coredns-lab \
  -p 127.0.0.1:15353:53/udp \
  -p 127.0.0.1:15353:53/tcp \
  -v "$PWD/Corefile:/etc/coredns/Corefile:ro" \
  -v "$PWD/db.lab.example:/etc/coredns/db.lab.example:ro" \
  coredns/coredns:latest -conf /etc/coredns/Corefile
```

容器会打印它加载了哪些区域和版本号：

```text
.:53
lab.example.:53
servfail.lab.:53
CoreDNS-1.14.7
linux/amd64, go1.26.6
```

因为这个镜像极简、里面连 shell 都没有，我从第二个用完就扔的容器里跑 `dig`，让它
共享主机的网络命名空间。这样就能把工具留在主机之外：

```bash
docker run -d --name dig-lab --network host alpine:3.21 sleep infinity
docker exec dig-lab apk add --no-cache bind-tools
```

现在从 `dig-lab` 里就能访问 `127.0.0.1:15353` 了。

## 用 dig 查询权威区域

语法是服务器在前、端口在后：`dig @127.0.0.1 -p 15353 <名字> <类型>`。本地区域里的
一条 A 记录回来时会带 `aa`（authoritative answer，权威回答）标志，并拒绝递归：

```text
$ dig @127.0.0.1 -p 15353 api.lab.example A
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 19584
;; flags: qr aa rd; QUERY: 1, ANSWER: 1, AUTHORITY: 1, ADDITIONAL: 1
;; WARNING: recursion requested but not available

;; ANSWER SECTION:
api.lab.example.	3600	IN	A	10.10.0.5
```

那个 `aa` 标志，正是权威服务器和递归服务器的全部区别。公共解析器回答一个自己并不
拥有的名字时，永远不设这个位；而我们的服务器回答的正是它真正拥有的区域。

查 CNAME 链时，dig 会把每一跳都打印出来，停在最终的 A 记录上：

```text
$ dig @127.0.0.1 -p 15353 www.lab.example A
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 16861
;; flags: qr aa rd; QUERY: 1, ANSWER: 3, AUTHORITY: 1, ADDITIONAL: 1

;; ANSWER SECTION:
www.lab.example.	3600	IN	CNAME	web.lab.example.
web.lab.example.	3600	IN	CNAME	api.lab.example.
api.lab.example.	3600	IN	A	10.10.0.5
```

TXT 记录同理，而 `+short` 会在你只想要值时把那些排场都剥掉：

```text
$ dig @127.0.0.1 -p 15353 info.lab.example TXT
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 20407
;; flags: qr aa rd; QUERY: 1, ANSWER: 1, AUTHORITY: 1, ADDITIONAL: 1

;; ANSWER SECTION:
info.lab.example.	3600	IN	TXT	"lab zone served by CoreDNS"

$ dig @127.0.0.1 -p 15353 +short www.lab.example
web.lab.example.
api.lab.example.
10.10.0.5
```

## 把未知域名转发上游

`lab.example` 之外的名字会落到 `.:53` 块里被转发出去。这里的 `example.com` 由上游
回答，缓存 30 秒——注意标志变了（没有 `aa`，而有可递归 `ra`）：

```text
$ dig @127.0.0.1 -p 15353 example.com A
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1760
;; flags: qr rd ra ad; QUERY: 1, ANSWER: 2, AUTHORITY: 0, ADDITIONAL: 1

;; ANSWER SECTION:
example.com.		30	IN	A	104.20.23.154
example.com.		30	IN	A	172.66.147.243
```

这就是你最该内化的那条分界：本地数据是权威的，其余一切都只是别人答案的缓存。把
你平常用的转发器指向一个加密上游，就能两头兼得——DoT 和 DoH 见
[加密 DNS 详解](/zh/posts/encrypted-dns/)。

## 调试：NXDOMAIN 与 SERVFAIL、CNAME 链、TTL

现在到了最有用的部分。四种失败模式在浏览器里长得一模一样，在 `dig` 眼里却天差地别。

**NXDOMAIN** 的意思是“这个名字权威地不存在”。因为我们的服务器拥有这个区域，它
会带着 `aa` 这么说，并附上 SOA，好让缓存知道负面 TTL：

```text
$ dig @127.0.0.1 -p 15353 missing.lab.example A
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 37084
;; flags: qr aa rd; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; AUTHORITY SECTION:
lab.example.	3600	IN	SOA	ns1.lab.example. admin.lab.example. 2026120801 7200 3600 1209600 60
```

注意它和 **NODATA** 的区别：名字 `api.lab.example` 是存在的，只是没有 TXT 记录。
那是一个零回答的 NOERROR，而不是 NXDOMAIN——这是最容易被人误读的一种 DNS 响应：

```text
$ dig @127.0.0.1 -p 15353 api.lab.example TXT
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 55543
;; flags: qr aa rd; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1
```

**SERVFAIL** 的意思是服务器回答不了。为了逼出它，我把 `servfail.lab` 指向
`192.0.2.1`——TEST-NET-1 里一个哪儿也去不了的地址。上游永不回复，CoreDNS 只能
放弃，客户端就看到 SERVFAIL：

```text
$ dig @127.0.0.1 -p 15353 nx.servfail.lab A +time=15 +tries=1
;; ->>HEADER<<- opcode: QUERY, status: SERVFAIL, id: 44624
;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1
```

不用猜，`log` 插件会告诉你*为什么*——上游读取超时了：

```text
[ERROR] plugin/errors: 2 nx.servfail.lab. A: read udp 172.17.0.6:38908->192.0.2.1:53: i/o timeout
[INFO] 172.17.0.1:43065 - 41700 "A IN ns1.lab.example. udp 56 false 1232" NOERROR qr,aa,rd 104 0.00010104s
[INFO] 172.17.0.1:55595 - 38277 "A IN nope.lab.example. udp 57 false 1232" NXDOMAIN qr,aa,rd 113 0.000084484s
```

**TTL** 是最后要盯的东西。`aa` 记录带的是区域的 3600，但转发来的回答会被缓存，
所以相隔几秒的两次查询之间，TTL 会往下掉：

```text
$ dig @127.0.0.1 -p 15353 example.com A +noall +answer
example.com.		21	IN	A	104.20.23.154
example.com.		21	IN	A	172.66.147.243
$ sleep 4
$ dig @127.0.0.1 -p 15353 example.com A +noall +answer
example.com.		17	IN	A	104.20.23.154
example.com.		17	IN	A	172.66.147.243
```

这就是为什么“DNS 传播”实际上是“缓存过期”：没有人把新记录推送到哪里去，旧答案
只是待在各级缓存里，直到它的 TTL 跑完。

## 收尾清理

两个容器，都是用完即弃：

```bash
docker rm -f coredns-lab dig-lab
```

整个实验就是一个 `Corefile` 加一个 zone 文件，可以提交进仓库、几秒钟内重跑。

## 我的收获

当你亲手跑起一个小小的**权威 DNS** 服务器、并自己读它的回答时，DNS 就不再是魔法
了。像这套 CoreDNS 这样的容器 DNS 服务器，给你一个安全的地方去看见 `aa` 标志、
真实的 CNAME 链、NXDOMAIN 与 NODATA 的区别、由死上游导致的 SERVFAIL，以及一个
正在倒数的 TTL。无论你以后进阶到路由器上的 dnsmasq，还是生产环境里加固过的
BIND，你在这里建立的这套心智模型都是一样的——每一个解析器都建立在它之上。

<figure>
<svg viewBox="0 0 640 180" width="100%" role="img" aria-label="一个 dig 客户端向 127.0.0.1 端口 15353 上的 CoreDNS 容器发起查询。lab.example 区域内的名字由本地带权威标志回答；其余一切转发上游到 1.1.1.1 并缓存。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="16" y="60" width="140" height="60" rx="8"/>
    <rect x="250" y="44" width="150" height="92" rx="8"/>
    <rect x="488" y="60" width="136" height="60" rx="8"/>
    <path d="M156 90 h88" marker-end="url(#dnslabzh)"/>
    <path d="M400 80 h88" marker-end="url(#dnslabzh)"/>
    <path d="M488 120 H400" marker-end="url(#dnslabzh)"/>
  </g>
  <defs>
    <marker id="dnslabzh" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12" text-anchor="middle">
    <text x="86" y="84">dig</text>
    <text x="86" y="102" opacity="0.75">@127.0.0.1 -p 15353</text>
    <text x="325" y="74">CoreDNS 容器</text>
    <text x="325" y="94" opacity="0.75">zone 文件：lab.example</text>
    <text x="325" y="114" opacity="0.75">forward . 1.1.1.1</text>
    <text x="556" y="84">上游</text>
    <text x="556" y="102" opacity="0.75">1.1.1.1</text>
    <text x="200" y="82" opacity="0.9">查询</text>
    <text x="444" y="72" opacity="0.9">转发</text>
    <text x="444" y="136" opacity="0.9">缓存的回答</text>
  </g>
</svg>
<figcaption>一次查询，两条路径：<code>lab.example</code> 里的名字由 zone 文件在本地权威回答，其余一切转发上游并缓存。</figcaption>
</figure>
