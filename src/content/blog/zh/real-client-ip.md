---
title: "穿过代理拿到真实客户端 IP：nginx real_ip、X-Forwarded-For 与 proxy_protocol"
description: "一旦在应用前面放上 CDN、负载均衡或反向代理，$remote_addr 就变成了代理自己，而不是你的用户。本文讲清 X-Forwarded-For、X-Real-IP、Forwarded 的语义，nginx real_ip 如何用 set_real_ip_from 与 real_ip_recursive 重写客户端地址，为什么 proxy_protocol 更难被伪造，以及盲目信任一个不是你写的头部会带来什么后果。"
pubDate: 2026-12-21
lang: zh
translationKey: real-client-ip
tags: [networking, nginx]
featured: false
keywords:
  - X-Forwarded-For
  - 真实客户端 IP
  - nginx real_ip
  - proxy_protocol
  - 可信代理
---

在你把 CDN 或负载均衡放到应用前面的那一天，日志里的每一行都会开始显示同一个地址。`$remote_addr` 变成了你自己的代理，基于 IP 的限流器只看得见一个客户端，而你精心搭建的审计线索就此作废。解决办法不是某个配置开关，而是先想清楚：链路里有哪几跳，你才愿意相信它告诉你的**真实客户端 IP**。本文用一次性的容器搭出 client → CDN → nginx → app 的链路，抓下每一层真正看到的东西，演示 **nginx real_ip** 与 **proxy_protocol** 如何找回原始地址，然后演示一条写错的指令如何让攻击者用一个手打的头部就伪造出这个地址。

如果你想先补 nginx 基础，可以看我的 [nginx 配置手册](/zh/posts/nginx-cookbook/)；容器部分见 [Docker 网络那篇](/zh/posts/docker-networking/)。

<figure>
<svg viewBox="0 0 720 250" width="100%" role="img" aria-label="一个请求从客户端流经 CDN、负载均衡、nginx 和应用的示意图。每一跳 TCP 只能看到上一跳的地址，因此 nginx 必须从 X-Forwarded-For 或 PROXY 协议重写 $remote_addr。">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="16" y="76" width="112" height="52" rx="6"/>
    <rect x="160" y="76" width="112" height="52" rx="6"/>
    <rect x="304" y="76" width="112" height="52" rx="6"/>
    <rect x="448" y="76" width="112" height="52" rx="6" stroke="#0f766e" stroke-width="2.5"/>
    <rect x="592" y="76" width="112" height="52" rx="6"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="72" y="107">Client</text>
    <text x="216" y="107">CDN</text>
    <text x="360" y="107">LB</text>
    <text x="504" y="107" fill="#0f766e">nginx</text>
    <text x="648" y="107">App</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" marker-end="url(#arrow)">
    <line x1="130" y1="102" x2="156" y2="102"/>
    <line x1="274" y1="102" x2="300" y2="102"/>
    <line x1="418" y1="102" x2="444" y2="102"/>
    <line x1="562" y1="102" x2="588" y2="102"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" text-anchor="middle" opacity="0.85">
    <text x="143" y="150">看到 客户端</text>
    <text x="287" y="150">看到 CDN</text>
    <text x="431" y="150">看到 LB</text>
    <text x="575" y="150">看到 nginx</text>
  </g>
  <g fill="currentColor" font-family="ui-monospace, Menlo, monospace" font-size="10.5" text-anchor="middle" opacity="0.7">
    <text x="143" y="60">XFF: -</text>
    <text x="287" y="60">XFF: client</text>
    <text x="431" y="60">XFF: client, cdn</text>
    <text x="575" y="60">XFF: client, cdn, lb</text>
  </g>
  <g fill="#0f766e" font-family="system-ui, sans-serif" font-size="11.5" text-anchor="middle">
    <text x="504" y="176">real_ip / proxy_protocol</text>
    <text x="504" y="194">重写 $remote_addr</text>
    <text x="504" y="212">为客户端地址——前提是可信</text>
  </g>
  <g stroke="#0f766e" stroke-width="1.5" fill="none" marker-end="url(#arrow)">
    <line x1="504" y1="184" x2="504" y2="132"/>
  </g>
</svg>
<figcaption>每一跳 TCP 永远只看得见上一跳。nginx 可以从 <code>X-Forwarded-For</code> 或 PROXY 协议里找回客户端——但前提是它被允许信任携带该头部的那个来源。</figcaption>
</figure>

## 为什么反向代理背后 `$remote_addr` 是代理的 IP

代理并不会替你转发数据包；它终止你的 TCP 连接，读完请求，再向下一跳**新建**一条连接。地址不会被保留——每条连接的三层源地址只是"谁开的这条连接"。所以在应用这一侧，对端永远是最后一个代理，绝不可能是真人。

我用私有网桥（`172.31.7.0/24`）上的三个容器复现了这件事：

- `realip-app` —— 一个极简 Python echo 服务，打印自己的对端与转发头部（`172.31.7.10`）
- `realip-proxy` —— 边缘 nginx（`172.31.7.11`）
- `realip-cdn` —— 冒充 CDN 的第二个 nginx（`172.31.7.12`），对外暴露 `127.0.0.1:8080`

从宿主机 `curl` 打到 CDN，CDN 代理到边缘，边缘再代理到应用：

```bash
$ docker network create --subnet 172.31.7.0/24 realip
$ curl -s http://127.0.0.1:8080/            # through cdn -> edge -> app
{
  "app_sees_peer": "172.31.7.11",
  "app_sees_headers": {
    "Host": "127.0.0.1",
    "X-Forwarded-For": "172.31.7.1, 172.31.7.12",
    "X-Real-IP": "172.31.7.12"
  }
}
```

应用的 TCP 对端是 `172.31.7.11`（边缘 nginx）。边缘的访问日志也好不到哪去——它只知道 CDN：

```text
172.31.7.12 - - [12/Oct/2026:10:33:46 +0000] "GET /s1-honest HTTP/1.1" 200 171 "-" "curl/8.22.0"
```

真正的客户端（`172.31.7.1`，这里用 Docker 网关顶替"互联网"）在连接元数据里根本不存在。它只活在 `X-Forwarded-For` 这个头部字符串里。这一行就把整个问题说完了：**客户端 IP 现在属于应用数据，而不属于连接状态。** 任何建立在连接状态之上的东西——日志、`limit_req`、`allow`/`deny`、fail2ban——都在悄无声息地对着错误的身份生效。

## 三个头部：X-Forwarded-For、X-Real-IP、Forwarded

没有任何一个标准被所有人遵守，所以大多数栈里三者并存：

- **`X-Forwarded-For`** —— 逗号分隔的列表。每个代理**追加**它看到的地址：`client, proxy1, proxy2`。最左边那条被声称是原始客户端，后面每个条目是一跳。因为每一跳都是在收到的内容上追加，所以列表长度等于"愿意设置它的跳数"。
- **`X-Real-IP`** —— 单个地址，由最近的代理设置。简单直接，也是不少 nginx 配方默认发出的那个（`proxy_set_header X-Real-IP $remote_addr`）。
- **`Forwarded`** —— RFC 7239 定义的头部，携带 `for=`、`by=`、`proto=`、`host=`，可带引号与 IPv6 方括号。它更正确，但被发出的机会更少；nginx 没有内置的 `$forwarded` 变量。

在上面的抓取里，应用收到 `X-Forwarded-For: 172.31.7.1, 172.31.7.12`：CDN 追加了它看到的客户端，边缘又追加了 CDN。注意条目数：**两个代理对应两条记录**，这只在每个受控跳都做了追加时才成立。如果某个头部本应有两条却只到了一条，那就是第一处线索——某一跳把它删掉或者伪造了。

## nginx real_ip：set_real_ip_from、real_ip_header、real_ip_recursive

`ngx_http_realip_module` 已经内置于官方 nginx 镜像。它把 `$remote_addr`（以及 `$remote_port`）替换成来自某个头部的地址——但**仅限来自你明确点名的那几个代理的连接**：

```nginx
server {
    listen 80;

    # Trust the CDN and nobody else.
    set_real_ip_from 172.31.7.12;
    real_ip_header    X-Forwarded-For;
    real_ip_recursive on;

    location / {
        proxy_pass http://172.31.7.10:9000;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP       $remote_addr;
    }
}
```

- **`set_real_ip_from`** —— 可信来源。接受地址或 CIDR；每个网段写一条。对于任何对端不在这个集合里的连接，模块会忽略该头部，所以陌生连接无法往里塞地址。
- **`real_ip_header`** —— 读哪个头部（`X-Forwarded-For`、`X-Real-IP`、`proxy_protocol` 或 `Forwarded`）。
- **`real_ip_recursive`** —— 设为 `on` 时，nginx 从右往左遍历 `X-Forwarded-For` 列表，丢弃那些本身就落在某个 `set_real_ip_from` 范围里的地址，停在第一个**不**可信的地址上。设为 `off`（默认）时，它只取**最后**一条。

`$realip_remote_addr` 变量保存着重写之前的原始对端，用它就能排查模块到底有没有生效：

```text
remote_addr=172.31.7.1  realip_remote=172.31.7.12  xff="172.31.7.1"            req="GET /s2-honest HTTP/1.1"
remote_addr=172.31.7.1  realip_remote=172.31.7.12  xff="203.0.113.7, 172.31.7.1" req="GET /s2-spoof HTTP/1.1"
```

对比一下没开这个模块的同一台边缘，`$remote_addr` 就卡在 CDN 上：

```text
172.31.7.12 - - "GET /s1-honest HTTP/1.1" 200
172.31.7.12 - - "GET /s1-spoof  HTTP/1.1" 200
```

现在客户端地址对了——而且注意第二行。一个怀有恶意的客户端发了 `X-Forwarded-For: 203.0.113.7`，CDN 老老实实追加了自己的对端，列表就变成 `203.0.113.7, 172.31.7.1`。因为只有 CDN 可信，递归模式跳过了那条可信的 `172.31.7.12`，停在既不可信又真实的 `172.31.7.1` 上，**被伪造的最左那条被正确地忽略了**。

## 陷阱：无条件信任任意的 X-Forwarded-For

现在改坏一行。把 `set_real_ip_from 172.31.7.12;` 换成 `set_real_ip_from 0.0.0.0/0;`——"信任所有客户端"。同样三个请求，但攻击者现在可以给每个请求自选一个身份：

```text
remote_addr=203.0.113.7  ... xff="203.0.113.7, 172.31.7.1"  req="GET /bypass-a HTTP/1.1"
remote_addr=198.51.100.9 ... xff="198.51.100.9, 172.31.7.1" req="GET /bypass-b HTTP/1.1"
remote_addr=10.0.0.1     ... xff="10.0.0.1, 172.31.7.1"     req="GET /bypass-c HTTP/1.1"
```

每个请求都被记成一个全新客户端。这正是一种**伪造（spoofing）**原语，一次性毁掉三样东西：

1. **日志与取证** —— 你手里关于攻击者的唯一记录，如今由攻击者自己控制。
2. **限流** —— `limit_req_zone ... key=$binary_remote_addr` 会给每个伪造身份各自一个桶，于是一轮暴力破解永远撞不到限流阈值。同样的花招也绕过按 IP 的配额与锁定。
3. **IP 白名单** —— 如果 `allow 10.0.0.0/8;` 是对着一个头部求值的，外部攻击者只要设 `X-Forwarded-For: 10.0.0.1`（就像 `bypass-c` 那样），就能从正门大摇大摆走进去。

反面同样常见，而且出现在逻辑走捷径的应用里：一个应用直接读 `X-Forwarded-For` 并取**第一个**值，对信任问题毫无概念。在我的抓取里，应用收到 `X-Forwarded-For: 203.0.113.7, 172.31.7.1, 172.31.7.1`——第 0 位就是那个谎。规则很直白也很绝对：**转发头部是一句声明。只有当它来自你信任的一跳时才是证据，而且你前面的每一跳都必须往它后面追加过。** 如果链路中有任何一跳把客户端头部原样透传，最左的值就由攻击者控制，没有例外。

## proxy_protocol：一个更难撒谎的四层前奏

基于头部的转发有个结构性弱点：它终究只是一个 HTTP 头部，任何客户端都能随手打一个。PROXY 协议用一个办法堵上这个口子——把客户端地址放在 **HTTP 请求之前，位于 TCP 层**。nginx 会把连接的起始几个字节当作它来读，而这个头部之所以存在，只因为它前面的代理被配置成会发出它。

在监听上启用它，再让 `real_ip` 去消费它：

```nginx
server {
    listen 80 proxy_protocol;      # this socket now REQUIRES a PROXY header
    set_real_ip_from 172.31.7.0/24; # the LB is the only allowed source
    real_ip_header   proxy_protocol;
    location / {
        proxy_pass http://172.31.7.10:9000;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP       $remote_addr;
    }
}
```

一个不会说这门协议的普通 HTTP 客户端会被直接拒掉——nginx 试图把 `GET / HTTP/1.1` 当成 PROXY 行来解析，然后失败：

```text
[error] broken header: "GET /plain HTTP/1.1" while reading PROXY protocol, client: 172.31.7.1
```

而一个**确实**会说这门协议的客户端（这里是一个五行 Python socket，发出 `PROXY TCP4 198.51.100.42 ...`）会被接受，nginx 从前奏里重写客户端地址：

```text
remote_addr=198.51.100.42  realip_remote=172.31.7.1  proxy_protocol_addr=198.51.100.42  req="GET / HTTP/1.1"
```

为什么它比头部更安全？因为在常规部署里，终端客户端伪造不了它：要发一条 PROXY 行，你必须裸连到那个期望它的套接字上；而 `real_ip_header proxy_protocol` 只有在连接对端落在 `set_real_ip_from` 之内时才会采信那个地址。在上面这次抓取里，`realip_remote=172.31.7.1` 是真实对端，`198.51.100.42` 是被声称的客户端——信任是逐跳显式给出的。代价是 `proxy_protocol` 是每个连接的设置：在一个非代理客户端也会访问的监听上启用它，就会像上面的 `broken header` 错误那样把那个客户端搞挂。当你**自己**掌控前面那一跳（自建 LB、HAProxy、AWS NLB、Cloudflare）时它是正确的工具；不掌控时它则是过度设计。

## 你的日志和限流都挂在这个决定上

下游的一切都以你解析出的身份为准：

- **访问日志** —— 只要出现代理，使用 `$remote_addr` 的 `log_format` 就是错的。同时记录 `$remote_addr` *和*原始的 `$http_x_forwarded_for`，才能分辨哪个是真实地址、哪个是转发来的。
- **限流** —— 只有 `$remote_addr` 就是客户端时，`limit_req_zone $binary_remote_addr zone=...` 才有意义。否则一个被伪造或被折叠的地址会让限流器要么形同虚设，要么在上百个用户挤在同一个 NAT 地址后面时苛刻得不讲道理。
- **allow/deny 与 WAF 规则** —— 它们对解析后的地址求值，所以一个错误的 `real_ip` 配置会把"仅限内部"的规则降级成一句建议。
- **应用层检查** —— 任何直接读 `X-Forwarded-For` 的东西，都必须执行与 nginx **相同**的信任策略，否则你就有了两套互相矛盾的"客户端"定义。

## 逐层检查清单：CDN → LB → nginx → app

每一跳都得尽到自己的本分；只要有一环薄弱，整条链就可被伪造。

- **CDN** —— 必须把客户端地址**追加**到任何进来的 `X-Forwarded-For` 上（既不能替换，也不能盲目透传），并公开它真实的边缘网段好让你去信任。多数厂商会发布列表；只接受你会去更新的那些网段。
- **LB / 反向代理** —— 启用 `proxy_protocol`，或者自己设置 `X-Forwarded-For`；确保它会覆盖 `X-Real-IP`，而不是把客户端自带的值原封不动转下去。如果它讲 PROXY 协议，就把后端监听配置成必须要求它。
- **nginx** —— `set_real_ip_from` 只写紧邻前面那一跳的 CIDR（不要写 `0.0.0.0/0`），选那一跳真正会设置的头部，遇到列表时就开 `real_ip_recursive on`。用日志里的 `$realip_remote_addr` 验证；如果它是空的，说明模块根本没生效。
- **App** —— 只在来自本机 nginx/内网时才信任转发头部，若必须自行解析就从列表右侧取地址，绝不用客户端提供的头部去做授权。
- **任何地方** —— 除非承载头部的连接本身被限制在可信跳内，否则永远不要用一个头部去决定白名单。这一条规则就能挡掉上面那一整类绕过。

心智模型很小。每一跳只看得见上一跳；客户端地址是随带在数据里的一句声明；而这句声明要变成证据，唯一的方式是：碰过它的每一跳都是你信任的，而且是追加而不是复读。把信任集合搞对——窄、逐跳、并在日志中验证——那么 `X-Forwarded-For`、`X-Real-IP`、`real_ip` 和 `proxy_protocol` 就会彼此对齐。搞错了，你发布的客户端 IP 就是任人挑选的。
