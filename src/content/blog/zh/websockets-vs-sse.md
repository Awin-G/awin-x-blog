---
title: "WebSocket 还是 SSE：选那个无聊的"
description: "WebSocket 还是 Server-Sent Events？我把一个回声服务器和一个事件端点放到 nginx 后面，抓下了真实的 101 握手、text/event-stream 帧、带 Last-Event-ID 的重连，以及缓冲那个坑——最后整理成一份决策清单。"
pubDate: 2026-12-21
lang: zh
translationKey: websockets-vs-sse
tags: [networking, python]
featured: false
keywords:
  - WebSocket 与 SSE
  - Server-Sent Events
  - WebSocket 握手
  - text/event-stream
  - 长轮询
---

**WebSocket 还是 SSE**，是那种凭感觉随手选一个、然后要用很多年的决定。**WebSocket** 是一条全双工通道，靠把一条 HTTP 连接*升级*成不再是 HTTP 而来；**Server-Sent Events** 则是单向的服务端到客户端数据流，作为一条长期挂起的 `text/event-stream` 响应跑在普通 HTTP 上。我把两者都从零搭了一遍——一个 Python 的 **WebSocket 握手**与回声服务器，一个纯 HTTP 的 **SSE** 端点——各自放到一次性的 nginx 后面，全在 `127.0.0.1`，录下了真实的帧。无聊的答案在大多数情况下是：先用 SSE，等到你真的需要另一个方向再说。

<figure>
<svg viewBox="0 0 720 250" width="100%" role="img" aria-label="左侧：一条 WebSocket 连接，客户端与服务端在收到 101 Switching Protocols 后，通过这条升级过的套接字双向发送帧。右侧：Server-Sent Events，客户端发起一次 HTTP GET，服务端单向推送 text/event-stream 事件；客户端不会在这条连接上发送数据。">
  <defs>
    <marker id="wss-arrow-c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
    <marker id="wss-arrow-t" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>

  <rect x="16" y="16" width="330" height="218" rx="8" fill="none" stroke="currentColor" stroke-width="1" opacity="0.4"/>
  <text x="181" y="42" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="14" font-weight="600">WebSocket&#160;&#8212;&#160;全双工</text>

  <rect x="40" y="95" width="92" height="56" rx="6" fill="currentColor" opacity="0.06"/>
  <text x="86" y="128" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12">客户端</text>
  <rect x="230" y="95" width="92" height="56" rx="6" fill="currentColor" opacity="0.06"/>
  <text x="276" y="128" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12">服务端</text>

  <line x1="136" y1="113" x2="226" y2="113" stroke="currentColor" stroke-width="1.6" marker-end="url(#wss-arrow-c)"/>
  <line x1="226" y1="133" x2="136" y2="133" stroke="#0f766e" stroke-width="1.6" marker-end="url(#wss-arrow-t)"/>
  <text x="181" y="88" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="10">两个方向都能发帧</text>
  <text x="181" y="176" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="10">一条套接字，由 HTTP 升级而来</text>
  <text x="181" y="192" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="10">101 Switching Protocols</text>
  <text x="181" y="214" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="10">文本或二进制，客户端&#8594;服务端需掩码</text>

  <rect x="374" y="16" width="330" height="218" rx="8" fill="none" stroke="currentColor" stroke-width="1" opacity="0.4"/>
  <text x="539" y="42" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="14" font-weight="600">Server-Sent Events&#160;&#8212;&#160;单向</text>

  <rect x="398" y="95" width="92" height="56" rx="6" fill="currentColor" opacity="0.06"/>
  <text x="444" y="128" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12">客户端</text>
  <rect x="588" y="95" width="92" height="56" rx="6" fill="currentColor" opacity="0.06"/>
  <text x="634" y="128" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12">服务端</text>

  <line x1="494" y1="123" x2="584" y2="123" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 3" marker-end="url(#wss-arrow-c)"/>
  <line x1="584" y1="123" x2="494" y2="123" stroke="#0f766e" stroke-width="1.8"/>
  <path d="M494 123 l10 -5 v10 z" fill="#0f766e"/>
  <text x="539" y="88" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="10">一次 HTTP GET，一直挂着</text>
  <text x="539" y="176" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="10">只有服务端&#8594;客户端事件</text>
  <text x="539" y="192" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="10">Content-Type: text/event-stream</text>
  <text x="539" y="214" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="10">UTF-8 文本，内置自动重连</text>
</svg>
<figcaption>WebSocket 花掉一次请求，把自己变成一条双向套接字。SSE 花掉一次请求，把自己变成一根单向管道——顺带把重连逻辑也替你办了。</figcaption>
</figure>

## 它们各自到底是什么

两者只有一个共同点——一条长连接——除此之外几乎毫不相干。

### WebSocket：一条套接字，双向

WebSocket 也是以一次普通 HTTP 请求开场的，只是带上了 `Upgrade: websocket` 头。服务端同意的话就回 **101 Switching Protocols**，这条连接从此不再是 HTTP：之后是按 RFC 6455 定义的帧流，任意一端随时可以发一个文本帧或二进制帧。在应用层，它是真正意义上的对等连接。

### Server-Sent Events：单向，跑在普通 HTTP 上

Server-Sent Events 从头到尾没离开 HTTP。客户端发一个 `GET`，服务端把响应一直挂着，有消息时就往里写一小段文本格式（`text/event-stream`）。客户端不能在同一条连接上发送应用数据。听着像是限制——它确实是——但它换来了一件极大的好事：这条连接*只是一个响应*，所以每一个 HTTP 工具、代理和负载均衡器本来就懂它，而负责重连的是浏览器。

## WebSocket 握手，逐字节看

我没有用库，而是写了一个裸套接字客户端，好让握手过程完全可见。它发送必需的 `Sec-WebSocket-Key`，服务端则回一个由 SHA-1 派生的 `Sec-WebSocket-Accept`，以此证明自己看懂了：

```text
$ python3 ws_raw_client.py 8765 /echo
>>> REQUEST
GET /echo HTTP/1.1
Host: 127.0.0.1:8765
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: L0djQYCc605T97MpwuEgqQ==
Sec-WebSocket-Version: 13

<<< RESPONSE
HTTP/1.1 101 Switching Protocols
Date: Mon, 12 Oct 2026 10:32:19 GMT
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: oqtVDUdtM9wNsI2p2wAGJXRYaWs=
Server: Python/3.14 websockets/17.2
    accept check: OK

>>> send text frame 'hi' (masked, client->server)
<<< frame opcode=0x1 len=7 payload=b'echo:hi' (+1 ms)
    opcode 0x1 = text frame, server->client is UNMASKED
```

有两个细节在运维上很要命。客户端到服务端的帧是**加了掩码**的，服务端到客户端的帧不加——一个能正确终结握手、却把分帧搞错的反向代理，会在这里出问题，而不是在头部。另外，服务端日志展示了连接*坏掉*时是什么样：没有关闭握手，你拿到的是 **1006**（异常关闭），而不是干净的 1000：

```text
[18:32:19.495] CONNECT path=/echo from=('127.0.0.1', 41494) version=13
[18:32:19.500] RECV  'hi'
[18:32:19.500] SENT  echo:hi
[18:32:19.501] CLOSED code=1006 reason=''
```

## Server-Sent Events 与 text/event-stream 格式

我的 SSE 服务端就是 Python 的 `http.server` 在写 `Content-Type: text/event-stream`。每个事件就是几个以换行结尾的字段——`id:`、`event:`、`data:`——再以一个空行结束该事件。行首的冒号是注释（用来发心跳）。下面是 `curl -N` 实际收到的东西，连响应头一起：

```text
$ curl -sN -D - http://127.0.0.1:8081/events
HTTP/1.1 200 OK
Server: BaseHTTP/0.6 Python/3.14.7
Date: Mon, 12 Oct 2026 10:33:27 GMT
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

retry: 2000

id: 1
event: tick
data: event 1 @ 18:33:28.422

id: 2
event: tick
data: event 2 @ 18:33:29.422

id: 3
event: tick
data: event 3 @ 18:33:30.423
```

注意 `Cache-Control: no-cache`——中间任何一层要是把这条响应缓存了，整个流就冻住了。还有 `retry: 2000`，它告诉客户端重连前等两秒。最开始与 WebSocket 的全部差别，就在这一个字段上。

## 重连：SSE 白送给你的东西

浏览器的 `EventSource` 会自动重连，而且——这点最被低估——它会告诉服务端**自己断在哪里了**。每次重连，它都把最后看到的那个 `id:` 作为 `Last-Event-ID` 请求头发出去。服务端只要认这个头，就能只补发客户端漏掉的部分。我用 `Last-Event-ID: 3` 重连了一次：

```text
$ curl -sN -H 'Last-Event-ID: 3' http://127.0.0.1:8081/events
id: 4
event: tick
data: event 4 @ 18:33:31.423

id: 5
event: tick
data: event 5 @ 18:33:32.423

id: 6
event: tick
data: event 6 @ 18:33:33.423
```

没有重放 `id: 1`–`3`，也没有断档。用 WebSocket 你一点都拿不到这些。连接就是死了，得靠*你的*客户端去察觉、退避、重连、再把状态对齐。下面是我的重连循环在一次流中途的服务端重启里活下来的过程：

```text
[18:33:05.066] connected (attempt 1)
[18:33:05.067] recv 'echo:hello'
[18:33:07.383] disconnected: ConnectionClosedError: no close frame received or sent
[18:33:07.383] reconnect in 0.5s
[18:33:07.885] disconnected: ConnectionRefusedError: [Errno 111] Connect call failed
[18:33:07.885] reconnect in 1.0s
[18:33:08.886] disconnected: ConnectionRefusedError: [Errno 111] Connect call failed
[18:33:08.886] reconnect in 2.0s
[18:33:10.888] disconnected: ConnectionRefusedError: [Errno 111] Connect call failed
[18:33:10.888] reconnect in 4.0s
[18:33:14.895] connected (attempt 5)
[18:33:14.898] recv 'echo:hello'
[18:33:17.898] recv 'hb:18:33:17.897'
```

指数退避、上限，以及最关键的——知道自己漏了什么。这在 WS 那边是你写一次的一百行代码，在 SSE 这边则是白拿。代价是 SSE 放弃了几样东西：自定义请求头（`EventSource` 不能发 `Authorization`，你得用 Cookie 或把 token 放进查询串）、二进制载荷，以及客户端回推的能力。

## 放到 nginx 之后：nginx upgrade 头与缓冲

无聊选择的价值就在这里兑现。SSE 穿过 nginx 基本上就是一个普通的被代理响应；WebSocket 则需要显式的升级管道。配置不长，但很具体：

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 127.0.0.1:8080;

  location /ws {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }

  location /sse {
    proxy_pass http://127.0.0.1:8081/events;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    add_header X-Accel-Buffering no;
    proxy_read_timeout 3600s;
  }
}
```

把两行升级头去掉，隧道根本打不开。我的裸客户端穿过 nginx 时被干脆地拒了——上游回了 `426 Upgrade Required`，accept 校验失败：

```text
# 没有转发 Upgrade/Connection
HTTP/1.1 426 Upgrade Required
Server: nginx/1.27.5
Content-Type: text/plain; charset=utf-8
Upgrade: websocket
    accept check: FAIL

# 配上 map $http_upgrade $connection_upgrade
HTTP/1.1 101 Switching Protocols
Server: nginx/1.27.5
Connection: upgrade
Upgrade: websocket
Sec-WebSocket-Accept: 8TaBPKUEcNVf0S1EFOiEagBZ/Jg=
    accept check: OK
```

那个 `map` 是在做实事：当客户端请求升级时它设成 `Connection: upgrade`，否则设成 `Connection: close`，而不是把每一条被代理的请求都粗暴地按 `close` 处理。同一台 nginx 在代理 SSE 时，还藏着一个更隐蔽的坑——**缓冲**。用 nginx 默认的 `proxy_buffering on`，我的事件一条都没到；nginx 把它们攒在缓冲里，等着被填满。关掉它，事件就立刻流出来：

```text
$ curl -sN http://127.0.0.1:8080/sse      # proxy_buffering on
(5 秒内没有输出——事件卡在 nginx 的缓冲里)

$ curl -sN http://127.0.0.1:8080/sse      # proxy_buffering off
  + 0.8s  id: 15
  + 0.8s  data: event 15 @ 18:35:44.447
  + 1.8s  id: 16
  + 1.8s  data: event 16 @ 18:35:45.447
  + 2.8s  id: 17
  + 2.8s  data: event 17 @ 18:35:46.447
```

同样的规则也适用于请求路径：如果你还跑着缓存层，[HTTP 缓存详解](/zh/posts/http-caching/) 里讲了 `no-cache` 和缓存键为什么重要；而当你改不了代理时，`X-Accel-Buffering: no` 让应用可以逐响应地退出缓冲。

还有一个扩容上的要点。SSE 连接基本是无状态的：任何一个副本都能服务任意客户端，连接断了浏览器自己会重连。WebSocket 则是*有状态*的套接字——放到负载均衡器后面，就意味着**会话粘滞（sticky sessions）**，或者一套发布/订阅骨干（Redis、NATS），好让任何副本都能找到持有那条套接字的副本。长套接字和部署也处不好关系；[优雅关闭](/zh/posts/graceful-shutdown/) 里那套排空动作，正是让它们在滚动重启期间不掉线的关键。

## 什么时候长轮询就够了

在两者之前，先问一句：这些数据真的是"推送型"的吗？如果客户端本来就在轮询别的东西，只是顺带每隔几秒想要一次更新，那么一个**长轮询**循环——把请求挂住，直到有消息或超时，然后再发起下一个——就是几行普通 HTTP，穿过所有代理都不用改，不需要升级、不需要缓冲规则、不需要客户端库。它在平静期会浪费一条连接，也额外多一个往返的延迟，所以对聊天或实时光标来说是错的；但对一分钟才变一次的状态徽标来说，它完全够用。我用的准则是：**用户在等的、请求/响应式的更新** → 长轮询；**持续的单向流** → SSE；**真正双向或二进制** → WebSocket。

## 背压与心跳

两种传输底层都是 TCP，所以客户端一慢，两边都会悄悄堆积数据。应用必须给自己的发送队列设上限，并想好该丢什么，而不是任由内存涨上去——一个对着卡住的手机猛推帧的 WS 服务端，会开开心心把自己缓冲到死。空闲连接也会在中间莫名死掉：NAT 超时、企业代理、以及过长的 `proxy_read_timeout`，都会把安静的套接字剪掉。两边都要定期发心跳。SSE 上就是一行注释（`: heartbeat`），客户端会忽略它；WS 上则是一个小小的 ping 或文本帧，让客户端回一声。沉默是敌人——一条安静了一分钟的套接字，未必还活着。

## 决策清单

- **单向的 服务端→客户端、文本、随时间更新** → **SSE**。你白拿自动重连、`Last-Event-ID` 补发，而且它能跑在 HTTP/2 上（HTTP/1.1 时代那个每域六连接的限制就此消失）。
- **客户端也要发数据——聊天、协同编辑、游戏输入** → **WebSocket**，同时把会话粘滞和骨干网算进预算。
- **二进制或高频** → **WebSocket**；SSE 只支持 UTF-8 文本。
- **偶发的状态更新** → **长轮询**；别为此专门立一条流。
- **放在 nginx 后面** → WS 要 `map $http_upgrade $connection_upgrade`，SSE 要 `proxy_buffering off`。
- **多副本** → SSE 用普通轮询就能扩；WS 需要粘滞或发布/订阅。
- **永远** → 心跳 + 有上限的发送队列，否则你会交付一个慢动作的内存泄漏。

无聊的那个选择，是要你*运行*和*运维*的活动部件更少的那个。对于相当大一部分"实时"功能来说，这个选择就是跑在普通 HTTP 上的 **Server-Sent Events**；只有当问题真的是双向的，才去动用 **WebSocket 握手**。这里的无聊不是妥协——它是那个凌晨三点还依然健康的系统版本。
