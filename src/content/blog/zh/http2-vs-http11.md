---
title: "HTTP/2 与 HTTP/1.1：到底改变了什么（以及什么没变）"
description: "一次动手对比 HTTP/2 与 HTTP/1.1：用一次性 nginx 容器跑出真实 curl 与 nghttp2 输出，讲清 HTTP/2 多路复用、HPACK 头压缩、nginx http2 配置、TCP 队头阻塞为何要靠 QUIC，以及在本地与高延迟链路上分别量到的诚实数字。"
pubDate: 2027-01-06
lang: zh
translationKey: http2-vs-http11
tags: [networking, nginx]
featured: false
keywords:
  - HTTP/2 与 HTTP/1.1
  - HTTP/2 多路复用
  - HPACK
  - 队头阻塞
  - nginx http2
---

最近我把一个安稳跑了多年 HTTP/1.1 的服务切到了 HTTP/2，然后仪表盘上几乎什么动静都没有。这不代表 HTTP/2 没用——恰恰因为如此，我才想把这个 **HTTP/2 与 HTTP/1.1** 的对比认真写下来：用真实服务器、真实 curl，而不是江湖传说。下面就是我当年希望有人递给我的那份材料：HTTP/1.1 到底错在哪，HTTP/2 真正解决了什么（二进制分帧、**HTTP/2 多路复用**、**HPACK**），它刻意没解决什么，为什么传输层的**队头阻塞**是另一个问题、该由 QUIC 收拾，以及怎样打开 `nginx http2` 而不出事故。

## 实验环境：一个一次性的 nginx，不用 sudo

下面每一个数字都是量出来的，不是想出来的。我在 `127.0.0.1:8443` 起了一个 `nginx:1.27-alpine`，给它一张自签名证书，生成了 50 个小文件，然后用 `curl 8.22.0` 和 `nghttp2 1.69.0` 去请求。延迟实验里我额外加了一个用户态 TCP 转发器，每个方向各延迟 50 ms，凑出 100 ms 的往返时间。全程不用 sudo、不动内核参数、不搞 docker 网络花样——量完我就把容器删了。

```bash
$ docker run -d --name h2lab --network host \
    -v "$PWD/nginx.conf":/etc/nginx/nginx.conf:ro \
    -v "$PWD/assets":/var/www:ro \
    -v "$PWD/certs":/etc/nginx/certs:ro \
    nginx:1.27-alpine
$ docker exec h2lab nginx -v
nginx version: nginx/1.27.5
```

```nginx
server {
    listen 8443 ssl;
    http2 on;
    listen 8443 quic reuseport;   # HTTP/3 走同端口的 UDP
    http3 on;

    server_name localhost;
    ssl_certificate     /etc/nginx/certs/cert.pem;
    ssl_certificate_key /etc/nginx/certs/key.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    root /var/www;
    add_header Alt-Svc 'h3=":8443"; ma=86400' always;
    location / { try_files $uri =404; }
}
```

整个 server 块就这么点东西。注意 `http2 on;` 是独立指令：从 **nginx 1.25.1** 开始，旧的 `listen 443 ssl http2;` 参数已被标记废弃，所以任何 2023 年年中之前写成的教程，都会让现代 nginx 打一行告警然后忽略那个参数。

## HTTP/1.1 错在哪：请求级队头阻塞与连接数天花板

HTTP/1.1 的 keep-alive 是一条严格按序排队的队列。一条连接、同一时刻只有一个请求在飞，响应也严格按请求顺序回来。由此产生的正是 HTTP/2 要解决的四个问题：

- **请求级队头阻塞。** 在同一条连接上，第 2 个请求要等第 1 个响应**完全结束**。一个慢端点——跑 400 ms 的报表、卡住的缩略图——会把排在它后面的所有请求一起拖死。
- **六条连接的天花板。** 唯一的现实绕法就是多开连接，而浏览器对每个源大约只给六条。当你的页面要 60 个子资源时，每条 socket 后面排着 10 个请求，第六条连接忙着记账而不是干活。
- **每条连接一次握手。** 这六条 socket 每条都要 TCP 握手加 TLS 握手，每次握手就是一到三个往返。在 100 ms 的链路上，建连的代价是以几百毫秒计的。
- **头部臃肿。** 每个请求都用明文重复同样的头部。一个 600 字节的 cookie（会话 cookie 加 CSRF token 是很常见的规模）意味着每次请求都要重发这一整块：

```text
request 1: 708 bytes of request headers on the wire
request 2: 708 bytes of request headers on the wire
request 3: 708 bytes of request headers on the wire
```

再乘以 50 个子资源、乘以每次页面访问，你就在为同样这 700 字节反复付费——在移动网络、卫星链路、按流量计费的数据上，一遍又一遍。

## HTTP/2 加了什么：多路复用、HPACK 与二进制分帧

### 二进制分帧

HTTP/2 不再是文本协议。消息被切成二进制**帧**（HEADERS、DATA、SETTINGS、PING……），在同一条 TCP 连接上复用。每个请求/响应对应一条**流**，编号为奇数。解析更便宜也更无歧义，但分帧本身只是手段；目的是多路复用。

### HTTP/2 多路复用——真正的主角

一条连接、多条流、帧交错传输。下面是用 `curl 8.22` 加 `-Z`（并行且多路复用）拉三个文件的输出：

```text
$ curl -sk --http2 -Z -v -o /dev/null \
    https://localhost:8443/widget-01.js https://localhost:8443/widget-02.js https://localhost:8443/widget-03.js
* ALPN: curl offers h2,http/1.1
* ALPN: server accepted h2
* using HTTP/2
* [HTTP/2] [1] OPENED stream for https://localhost:8443/widget-01.js
* [HTTP/2] [1] [:method: GET]
* [HTTP/2] [1] [:path: /widget-01.js]
* [HTTP/2] [3] OPENED stream for https://localhost:8443/widget-02.js
* [HTTP/2] [3] [:path: /widget-02.js]
* [HTTP/2] [5] OPENED stream for https://localhost:8443/widget-03.js
* [HTTP/2] [5] [:path: /widget-03.js]
* Connection #0 to host localhost:8443 left intact
```

三个请求、一个 socket，流 ID 分别是 1、3、5——全都在**连接 #0** 上。同样的三次请求在 HTTP/1.1 下要么在一条连接上排队，要么得再开两条连接。

<figure>
<svg viewBox="0 0 680 350" width="100%" role="img" aria-label="HTTP/1.1 需要多条连接、每条同时只有一个请求；HTTP/2 把所有请求作为多路复用的流跑在一条连接上。HTTP/1.1 连接与 HTTP/2 流的对比。">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" font-weight="600">
    <text x="20" y="24">HTTP/1.1：六条连接，每条同时只有一个请求在飞</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="65" y="46" text-anchor="middle">浏览器</text>
    <text x="610" y="46" text-anchor="middle">源站</text>
  </g>
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.45">
    <rect x="20" y="54" width="90" height="132" rx="8"/>
    <rect x="560" y="54" width="100" height="132" rx="8"/>
    <line x1="110" y1="63" x2="560" y2="63"/>
    <line x1="110" y1="87" x2="560" y2="87"/>
    <line x1="110" y1="111" x2="560" y2="111"/>
    <line x1="110" y1="135" x2="560" y2="135"/>
    <line x1="110" y1="159" x2="560" y2="159"/>
    <line x1="110" y1="183" x2="560" y2="183"/>
  </g>
  <g font-family="system-ui, sans-serif" font-size="9.5">
    <g fill="#0f766e" fill-opacity="0.85" stroke="#0f766e" stroke-width="1">
      <rect x="128" y="56"  width="20" height="14" rx="3"/>
      <rect x="128" y="80"  width="20" height="14" rx="3"/>
      <rect x="128" y="104" width="20" height="14" rx="3"/>
      <rect x="128" y="128" width="20" height="14" rx="3"/>
      <rect x="128" y="152" width="20" height="14" rx="3"/>
      <rect x="128" y="176" width="20" height="14" rx="3"/>
    </g>
    <g fill="#ffffff">
      <text x="138" y="66"  text-anchor="middle">r1</text>
      <text x="138" y="90"  text-anchor="middle">r2</text>
      <text x="138" y="114" text-anchor="middle">r3</text>
      <text x="138" y="138" text-anchor="middle">r4</text>
      <text x="138" y="162" text-anchor="middle">r5</text>
      <text x="138" y="186" text-anchor="middle">r6</text>
    </g>
    <g fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3" opacity="0.55">
      <rect x="156" y="56"  width="20" height="14" rx="3"/>
      <rect x="184" y="56"  width="20" height="14" rx="3"/>
      <rect x="156" y="80"  width="20" height="14" rx="3"/>
      <rect x="184" y="80"  width="20" height="14" rx="3"/>
      <rect x="156" y="104" width="20" height="14" rx="3"/>
      <rect x="184" y="104" width="20" height="14" rx="3"/>
      <rect x="156" y="128" width="20" height="14" rx="3"/>
      <rect x="184" y="128" width="20" height="14" rx="3"/>
      <rect x="156" y="152" width="20" height="14" rx="3"/>
      <rect x="184" y="152" width="20" height="14" rx="3"/>
      <rect x="156" y="176" width="20" height="14" rx="3"/>
      <rect x="184" y="176" width="20" height="14" rx="3"/>
    </g>
    <g fill="currentColor" font-size="10" opacity="0.7">
      <text x="212" y="66">在排队，等轮到自己</text>
      <text x="20" y="204">六次 TCP + TLS 握手，每个请求都重发一遍头部</text>
    </g>
  </g>
  <line x1="20" y1="222" x2="660" y2="222" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" font-weight="600">
    <text x="20" y="246">HTTP/2：一条连接，50 条多路复用的流</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="65" y="268" text-anchor="middle">浏览器</text>
    <text x="610" y="268" text-anchor="middle">源站</text>
  </g>
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.45">
    <rect x="20" y="276" width="90" height="66" rx="8"/>
    <rect x="560" y="276" width="100" height="66" rx="8"/>
  </g>
  <g stroke="#0f766e" stroke-width="2.5">
    <line x1="110" y1="309" x2="560" y2="309"/>
  </g>
  <g font-family="system-ui, sans-serif" font-size="9">
    <g fill="#0f766e" fill-opacity="0.18" stroke="#0f766e" stroke-width="1">
      <rect x="128" y="296" width="26" height="26" rx="4"/>
      <rect x="162" y="296" width="26" height="26" rx="4"/>
      <rect x="196" y="296" width="26" height="26" rx="4"/>
      <rect x="230" y="296" width="26" height="26" rx="4"/>
      <rect x="264" y="296" width="26" height="26" rx="4"/>
      <rect x="298" y="296" width="26" height="26" rx="4"/>
      <rect x="332" y="296" width="26" height="26" rx="4"/>
      <rect x="366" y="296" width="26" height="26" rx="4"/>
      <rect x="400" y="296" width="26" height="26" rx="4"/>
      <rect x="434" y="296" width="26" height="26" rx="4"/>
      <rect x="468" y="296" width="26" height="26" rx="4"/>
      <rect x="502" y="296" width="26" height="26" rx="4"/>
      <rect x="536" y="296" width="26" height="26" rx="4"/>
    </g>
    <g fill="#0f766e">
      <text x="141" y="313" text-anchor="middle">1</text>
      <text x="175" y="313" text-anchor="middle">3</text>
      <text x="209" y="313" text-anchor="middle">5</text>
      <text x="243" y="313" text-anchor="middle">7</text>
      <text x="277" y="313" text-anchor="middle">9</text>
      <text x="311" y="313" text-anchor="middle">11</text>
      <text x="345" y="313" text-anchor="middle">13</text>
      <text x="379" y="313" text-anchor="middle">15</text>
      <text x="413" y="313" text-anchor="middle">17</text>
      <text x="447" y="313" text-anchor="middle">19</text>
      <text x="481" y="313" text-anchor="middle">21</text>
      <text x="515" y="313" text-anchor="middle">23</text>
      <text x="549" y="313" text-anchor="middle">25</text>
    </g>
    <g fill="currentColor" font-size="10" opacity="0.7">
      <text x="20" y="336">一次握手即可，多条流的帧在同一条 socket 上交错</text>
    </g>
  </g>
</svg>
<figcaption>HTTP/1.1 给你的是少数几条有序队列；HTTP/2 给你的是一条连接上许多彼此独立、交错传输的流——所以连接数和队列深度不再是瓶颈。</figcaption>
</figure>

### HPACK：每条连接一本共享字典

每条 HTTP/2 连接两端都维护一张动态头部表。重复的头部变成一个字节的索引引用，新增的内容则做 Huffman 编码。`nghttp` 能直接把帧大小打出来。同样那个 600 字节 cookie、三个请求、一条连接：

```text
$ docker exec h2lab nghttp -v -n -H "cookie: session=aaa…(600 bytes)…" \
    https://localhost:8443/widget-01.js https://localhost:8443/widget-02.js https://localhost:8443/widget-03.js
[  0.021] send HEADERS frame <length=441, flags=0x05, stream_id=1>
[  0.021] send HEADERS frame <length=20,  flags=0x05, stream_id=3>
[  0.021] send HEADERS frame <length=20,  flags=0x05, stream_id=5>
[  0.021] recv HEADERS frame <length=135, flags=0x04, stream_id=1>
```

第一个请求 441 字节——那是 cookie 正在被索引——后面两个各只有 **20 字节**。而 HTTP/1.1 每次都发 708 字节。这就是 HPACK 在干活：三个 HTTP/1.1 请求共 2,124 字节请求头，HTTP/2 只要 481 字节，少了 77%；而且请求越多、连接活得越久，这个优势越大。

### Server Push：2015 年出生，被废弃，然后被删掉

HTTP/2 允许服务器推送客户端没要过的资源。但它比规范里写的更难用对，浏览器用不好它，它也和缓存模型打架。Chrome 先支持、又在 Chrome 106 里移除；RFC 现在把它描述为已废弃，而 **nginx 在 1.25.1 里彻底删掉了 server push**（`http2_push` 已作废，官方建议改用 `Link: rel=preload` 响应头，或 103 Early Hints）。如果你看到教程还在教你配 `http2_push`，那篇文章已经过期九年了。

## HTTP/2 没解决什么：TCP 队头阻塞

HTTP/2 消除了*请求层面*的队头阻塞——不再有请求要等另一个请求跑完。但它对*传输层面*的队头阻塞毫无办法，而这点最常绊倒人。HTTP/2 仍然跑在 TCP 上，TCP 交付的是一条有序字节流。第 2 段丢了，第 3、4、5 段就只能在内核缓冲区里干等，直到第 2 段重传到位——而此时这条连接上所有多路复用的流全都一起卡住。

这是一个故意把问题往上推的设计：真正的解药是 QUIC，它把顺序保证下沉到按流恢复，一次丢包只阻塞它自己那条流。这个我单独写在 [QUIC 与 HTTP/3 详解](/zh/posts/quic-and-http3/) 里了。对站点所有者的实用版本是：HTTP/2 是最大且最便宜的胜利，HTTP/3 是在有损移动链路上的胜利，而 `alt-svc` 就是服务器宣告后者的方式——我自己的博客响应里目前没有它，所以在我开启 QUIC 之前，它的 HTTP/2 就是故事的终点。

## HTTP/2 如何改写你的优化清单

那些 HTTP/1.1 时代的技巧，本来就是为了绕过连接数天花板和头部臃肿而存在的。到了 HTTP/2，其中好几个反而有害：

- **域名分片可以扔了。** 把资源拆到 `static1.example.com`…`static4.example.com` 是用额外 DNS 查询、额外握手和 HPACK 无法共享换来的几条 socket。在 HTTP/2 下这是纯亏。
- **雪碧图和 CSS/JS 合并且通常不合时宜。** 它们存在的意义是减少请求数。有了多路复用，40 个小请求很便宜，而一个改一行就整体失效的 400 KB 大包并不便宜。更小的、可独立缓存的文件才赢。
- **把所有东西内联是错的。** 内联 data URI 会废掉缓存，还会把不能缓存的 HTML 撑爆。文件就该是文件。
- **依然重要的：** 缓存（见 [HTTP 缓存详解](/zh/posts/http-caching/)）、压缩、面向有损链路的 HTTP/3/QUIC，以及 TLS 会话复用——让你唯一开的那条连接重开时也很便宜。

## 开启 nginx http2

改动就这么点，外加一步验证。在 nginx ≥ 1.25.1 上：

```nginx
server {
    listen 443 ssl;
    http2 on;                 # 不是：listen 443 ssl http2;
    # …
    add_header Alt-Svc 'h3=":443"; ma=86400' always;   # 如果你也跑 QUIC
}
```

如果是明文端点（内网，或者前面有 TLS 终止的负载均衡），`listen 8080; http2 on;` 同样有效——nginx 会用 h2c 和"已经知道"的客户端对话，完全不涉及 ALPN：

```bash
$ curl -s --http2-prior-knowledge -D - -o /dev/null http://127.0.0.1:8445/widget-01.js | head -1
HTTP/2 200
```

确认客户端到底协商出什么是两秒钟的事，而这正是大家最爱跳过的一步：

```bash
$ for v in 1.1 2 3; do curl -sk --http$v -s -D - -o /dev/null https://localhost:8443/widget-01.js | head -1; done
HTTP/1.1 200 OK
HTTP/2 200
HTTP/3 200
```

真实响应头里有两处值得注意：HTTP/2 会把头部名转为小写，并去掉 `Connection: keep-alive`（本来就只有一条连接需要保活）；如果你同时用 `http3 on;` 监听，响应里还会带上 **`alt-svc: h3=":8443"; ma=86400`**，浏览器正是靠它知道存在一个 QUIC 端点、下次可以试着连。在公网上你也能看到同样的形态——一个真在跑 HTTP/3 的站点会先回 `HTTP/2 103`（Early Hints）再回 `HTTP/2 200`，并给出 `alt-svc: h3=":443"`。

## 诚实测量：本地 vs 100 ms 链路

同一个源、同一批 50 个文件，五种拉法。

**本地（RTT ≈ 0），跑 15 次，整批墙钟时间：**

```text
50 assets from https://localhost:8443, 15 runs per mode

HTTP/1.1  1 conn, sequential
    median   23.6 ms | min   21.6 | max   25.3 | TCP conns 1 | TLS handshakes 1 | h2 streams 0
HTTP/1.1  6 conns, parallel
    median   27.8 ms | min   23.6 | max   33.4 | TCP conns 6 | TLS handshakes 6 | h2 streams 0
HTTP/2    1 conn, multiplexed
    median   20.9 ms | min   20.3 | max   25.3 | TCP conns 1 | TLS handshakes 1 | h2 streams 50

speed-up of HTTP/2 multiplexing on localhost: 1.13x vs 1-connection h1, 1.33x vs 6-connection h1
```

**吞吐与头部字节数，用 `h2load`（nghttp2），1000 个请求打同一个文件，在同一个容器里跑：**

```text
$ h2load --h1 -n 1000 -c 100 -m 10 https://localhost:8443/widget-01.js   # HTTP/1.1
finished in 114.04ms, 8769.16 req/s
traffic: 412.11KB total, 215.82KB headers (space savings 0.00%)
connect  :  min 27.12ms  median 53.32ms  max 81.37ms

$ h2load -n 1000 -c 10 -m 100 https://localhost:8443/widget-01.js        # HTTP/2
finished in 43.00ms, 23256.90 req/s
traffic: 292.47KB total, 131.84KB headers (space savings 36.02%)
connect  :  min 3.41ms   median 7.44ms   max 15.35ms
```

**跨过 100 ms RTT 的链路，同样 50 个文件，跑 3 次：**

```text
50 assets across a 100 ms RTT link, 3 runs each

HTTP/1.1  1 conn  sequential (50 x RTT)
    median    5.20 s  (min 5.20 s)  TCP conns=1  TLS handshakes=1  h2 streams=0
HTTP/1.1  6 conns parallel
    median    1.07 s  (min 1.07 s)  TCP conns=6  TLS handshakes=6  h2 streams=0
HTTP/2    1 conn  50 multiplexed streams
    median    0.31 s  (min 0.31 s)  TCP conns=1  TLS handshakes=1  h2 streams=50

HTTP/2 speed-up on a 100 ms link: 16.5x vs 1-connection h1, 3.4x vs 6-connection h1
```

这些数字要诚实地读：

- **在本地，收益很小——整批只有 1.1–1.3x**，因为没有延迟，HTTP/2 消除的那个东西（等往返）基本不存在。谁要是在局域网上跟你承诺 HTTP/2 有 10 倍，他大概在卖东西。
- **头部的收益是实打实且无条件的：** `h2load` 实测头部字节少 36%，cookie 那个例子里请求头少 77%。这在任何链路、任何延迟下都成立，也是这里唯一不取决于网络路径的数字。
- **并发收益也是真的：** 连接数降到十分之一，吞吐反而 2.6 倍，`connect` 中位数从 53 ms 掉到 7 ms，因为 10 次握手替代了 100 次。
- **戏剧性的收益需要延迟。** 比单连接 HTTP/1.1 的页面加载快 16.5 倍，比浏览器拼命开六条连接还快 3.4 倍——这是 100 ms 链路的结果，也就是信号一般的手机上发生的日常。
- **对我自己的数字也要打个折：** 那条 100 ms 链路是用户态 TCP 转发器按数据块加延迟，不是真广域网；而且我关掉了 TLS 会话复用，所以每批都付了全新握手。本地那张表是硬的，延迟那张表当方向和量级看，别当可以拿去大会引用的基准。

## 简短结论

把 `http2 on;` 打开——就一条指令，你绝不会以能察觉的方式变慢，还白拿 HPACK 和多路复用。然后停掉那些 HTTP/1.1 时代的绕法：域名分片、雪碧图、急着内联，全都成了噪音。如果你的用户在移动网络上，下一步真正有价值的是基于 UDP 的 QUIC，见 [QUIC 与 HTTP/3 详解](/zh/posts/quic-and-http3/)。无论如何，在自己的流量上量一次：在本地 HTTP/2 看起来像个舍入误差，而在高延迟链路上，它像是另一个协议。
