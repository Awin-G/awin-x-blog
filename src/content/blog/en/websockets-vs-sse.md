---
title: "WebSockets vs SSE: pick the boring one"
description: "WebSocket or Server-Sent Events? I put a throwaway echo server and an events endpoint behind nginx, captured the real 101 handshake, the text/event-stream frames, reconnection with Last-Event-ID, and the buffering trap — then turned it into a decision list."
pubDate: 2026-12-21
lang: en
translationKey: websockets-vs-sse
tags: [networking, python]
featured: false
keywords:
  - WebSockets vs SSE
  - Server-Sent Events
  - WebSocket handshake
  - text/event-stream
  - long polling
---

**WebSockets vs SSE** is one of those choices people make by vibe and then live with for years. A **WebSocket** is a full-duplex channel built by *upgrading* an HTTP connection until it is no longer HTTP; **Server-Sent Events** are a one-way server-to-client stream carried as a long-lived `text/event-stream` response on ordinary HTTP. I built both from scratch — a Python **WebSocket handshake** and echo server, and a plain-HTTP **SSE** endpoint — put throwaway nginx in front of each on `127.0.0.1`, and recorded the real frames. The boring answer, most of the time: SSE until you actually need the other direction.

<figure>
<svg viewBox="0 0 720 250" width="100%" role="img" aria-label="Left: a WebSocket connection where client and server both send frames over one upgraded socket after a 101 Switching Protocols response. Right: Server-Sent Events where the client opens one HTTP GET and the server pushes text/event-stream events one way; the client never sends data on that connection.">
  <defs>
    <marker id="wss-arrow-c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
    <marker id="wss-arrow-t" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>

  <rect x="16" y="16" width="330" height="218" rx="8" fill="none" stroke="currentColor" stroke-width="1" opacity="0.4"/>
  <text x="181" y="42" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="14" font-weight="600">WebSocket &#8212; full duplex</text>

  <rect x="40" y="95" width="92" height="56" rx="6" fill="currentColor" opacity="0.06"/>
  <text x="86" y="128" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12">client</text>
  <rect x="230" y="95" width="92" height="56" rx="6" fill="currentColor" opacity="0.06"/>
  <text x="276" y="128" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12">server</text>

  <line x1="136" y1="113" x2="226" y2="113" stroke="currentColor" stroke-width="1.6" marker-end="url(#wss-arrow-c)"/>
  <line x1="226" y1="133" x2="136" y2="133" stroke="#0f766e" stroke-width="1.6" marker-end="url(#wss-arrow-t)"/>
  <text x="181" y="88" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="10">frames either way</text>
  <text x="181" y="176" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="10">one socket, upgraded from HTTP</text>
  <text x="181" y="192" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="10">101 Switching Protocols</text>
  <text x="181" y="214" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="10">text or binary, masked client&#8594;server</text>

  <rect x="374" y="16" width="330" height="218" rx="8" fill="none" stroke="currentColor" stroke-width="1" opacity="0.4"/>
  <text x="539" y="42" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="14" font-weight="600">Server-Sent Events &#8212; one way</text>

  <rect x="398" y="95" width="92" height="56" rx="6" fill="currentColor" opacity="0.06"/>
  <text x="444" y="128" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12">client</text>
  <rect x="588" y="95" width="92" height="56" rx="6" fill="currentColor" opacity="0.06"/>
  <text x="634" y="128" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12">server</text>

  <line x1="494" y1="123" x2="584" y2="123" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 3" marker-end="url(#wss-arrow-c)"/>
  <line x1="584" y1="123" x2="494" y2="123" stroke="#0f766e" stroke-width="1.8"/>
  <path d="M494 123 l10 -5 v10 z" fill="#0f766e"/>
  <text x="539" y="88" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="10">one HTTP GET stays open</text>
  <text x="539" y="176" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="10">server&#8594;client events only</text>
  <text x="539" y="192" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="10">Content-Type: text/event-stream</text>
  <text x="539" y="214" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="10">UTF-8 text, auto-reconnect built in</text>
</svg>
<figcaption>A WebSocket spends one request to become a two-way socket. SSE spends one request to become a one-way pipe — and keeps the reconnection logic for you.</figcaption>
</figure>

## What each one actually is

The two share a shape — one long-lived connection — and almost nothing else.

### WebSocket: one socket, both directions

A WebSocket begins life as an ordinary HTTP request carrying an `Upgrade: websocket` header. If the server agrees, it answers **101 Switching Protocols** and the connection stops being HTTP: what follows is a frame stream defined by RFC 6455, where either side can send a text or binary frame at any time. It is genuinely peer-to-peer at the application layer.

### Server-Sent Events: one direction, plain HTTP

Server-Sent Events never leave HTTP. The client makes a `GET`, and the server holds the response open, writing a small text format (`text/event-stream`) whenever it has news. The client cannot send application data on that same connection. That sounds like a limitation — and it is — but it buys you something enormous: the connection is *just a response*, so every HTTP tool, proxy, and load balancer already understands it, and the browser is the one doing the reconnecting.

## The WebSocket handshake, byte for byte

I wrote a raw-socket client rather than using a library, so the handshake is visible. It sends the required `Sec-WebSocket-Key`, and the server proves it understood by echoing a SHA-1-derived `Sec-WebSocket-Accept`:

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

Two details matter operationally. Client-to-server frames are **masked**; server-to-client frames are not — a reverse proxy that terminates the handshake but mishandles framing will break here, not at the header level. And the server log shows how a *broken* connection ends: with no close handshake, you get code **1006** ("abnormal closure"), not a clean 1000:

```text
[18:32:19.495] CONNECT path=/echo from=('127.0.0.1', 41494) version=13
[18:32:19.500] RECV  'hi'
[18:32:19.500] SENT  echo:hi
[18:32:19.501] CLOSED code=1006 reason=''
```

## Server-Sent Events and the text/event-stream format

My SSE server is Python's `http.server` writing `Content-Type: text/event-stream`. Each event is a few newline-terminated fields — `id:`, `event:`, `data:` — and a blank line ends the event. A leading colon is a comment (used for heartbeats). Here is what `curl -N` actually receives, including the response headers:

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

Notice `Cache-Control: no-cache` — an intermediary that caches this would freeze the stream. And `retry: 2000` tells the client to wait two seconds before reconnecting. That single field is the whole difference from a WebSocket on day one.

## Reconnect: what SSE hands you for free

A browser's `EventSource` reconnects automatically, and — this is the underrated part — it tells the server **where it left off**. On every reconnect it sends the last `id:` it saw as a `Last-Event-ID` request header. A server that honours it can replay only what the client missed. I reconnected with `Last-Event-ID: 3`:

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

No `id: 1`–`3` replay, no gap. With a WebSocket you get none of this. The connection just dies, and *your* client has to notice, back off, reconnect, and re-sync state. Here is my reconnect loop surviving a server restart mid-stream:

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

Exponential backoff, a cap, and — crucially — a way to know what you missed. That is a hundred lines you write once for WS and get for free from SSE. The trade is that SSE gives up custom request headers (no `Authorization` header from `EventSource`; you use cookies or a token in the query string), binary payloads, and the ability for the client to push.

## Behind nginx: `nginx upgrade` headers and buffering

This is where the boring choice pays rent. SSE through nginx is *almost* a normal proxied response; WebSockets need explicit upgrade plumbing. The config is small but specific:

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

Drop the two upgrade lines and the tunnel never opens. My raw client through nginx got a flat refusal — the upstream answered `426 Upgrade Required`, and the accept check failed:

```text
# no Upgrade/Connection forwarding
HTTP/1.1 426 Upgrade Required
Server: nginx/1.27.5
Content-Type: text/plain; charset=utf-8
Upgrade: websocket
    accept check: FAIL

# with map $http_upgrade $connection_upgrade
HTTP/1.1 101 Switching Protocols
Server: nginx/1.27.5
Connection: upgrade
Upgrade: websocket
Sec-WebSocket-Accept: 8TaBPKUEcNVf0S1EFOiEagBZ/Jg=
    accept check: OK
```

The `map` is doing real work: it sets `Connection: upgrade` when the client asked to upgrade and `Connection: close` otherwise, instead of clobbering every proxied request with `close`. That same nginx, proxying SSE, has a subtler footgun — **buffering**. With nginx's default `proxy_buffering on`, my events never arrived; nginx held them waiting for a buffer to fill. Turn it off and they stream immediately:

```text
$ curl -sN http://127.0.0.1:8080/sse      # proxy_buffering on
(no output for 5 s — events sit in nginx's buffer)

$ curl -sN http://127.0.0.1:8080/sse      # proxy_buffering off
  + 0.8s  id: 15
  + 0.8s  data: event 15 @ 18:35:44.447
  + 1.8s  id: 16
  + 1.8s  data: event 16 @ 18:35:45.447
  + 2.8s  id: 17
  + 2.8s  data: event 17 @ 18:35:46.447
```

The same rule applies to the request path: if you also run a caching layer, see [HTTP caching explained](/posts/http-caching/) for why `no-cache` and cache keys matter, and `X-Accel-Buffering: no` lets the app opt out of buffering per response when you cannot edit the proxy.

One more scaling note. SSE connections are stateless-ish: any replica can serve any client, and a dropped connection is just re-established by the browser. WebSockets are *stateful* sockets — behind a load balancer that means **sticky sessions**, or a pub/sub backplane (Redis, NATS) so the replica that holds the socket can be reached from anywhere. Long-lived sockets also interact badly with deploys; the drain dance in [graceful shutdown](/posts/graceful-shutdown/) is exactly what keeps them from dropping during a rolling restart.

## When a long poll is enough

Before either, ask whether the data is even push-shaped. If a client only needs updates every few seconds when it is already polling for something else, a **long polling** loop — hold the request until there is news or a timeout, then reissue it — is a few lines of ordinary HTTP, survives every proxy unchanged, and needs no upgrade, no buffering rule, and no client library. It wastes a connection on lulls and adds a round-trip of latency, so it is wrong for chat or live cursors. It is entirely right for a status badge that changes once a minute. The rule I use: **request/response updates that a user is already waiting on** → long poll; **continuous one-way stream** → SSE; **genuinely bidirectional or binary** → WebSocket.

## Backpressure and heartbeats

Both transports are TCP under the hood, so both can silently accumulate data when the client is slow. The application has to bound its outbound queue and decide what to drop rather than letting memory grow — a WS server that blasts frames at a stalled phone will happily buffer itself to death. Idle connections also die in the middle: NAT timeouts, corporate proxies, and long `proxy_read_timeout`s all cut quiet sockets. Send a periodic heartbeat on both. On SSE that is a comment line (`: heartbeat`), which the client ignores; on WS a tiny ping or text frame that the client answers. Silence is the enemy — a socket that has been quiet for a minute is not necessarily alive.

## The decision list

- **One-way server→client, text, updates over time** → **SSE**. You get auto-reconnect, `Last-Event-ID` replay, and it rides on HTTP/2 (where the old six-connections-per-domain limit on HTTP/1.1 disappears).
- **Client also sends data — chat, collaborative editing, game input** → **WebSocket**, and budget for sticky sessions and a backplane.
- **Binary or high-frequency** → **WebSocket**; SSE is UTF-8 text only.
- **Occasional status updates** → **long poll**; don't stand up a stream for it.
- **Behind nginx** → `map $http_upgrade $connection_upgrade` for WS, `proxy_buffering off` for SSE.
- **Multiple replicas** → SSE scales with plain round-robin; WS needs stickiness or pub/sub.
- **Always** → heartbeat + bounded outbound queue, or you will ship a slow-motion memory leak.

The boring pick is the one with fewer moving parts you have to run *and* operate. For a surprising share of "real-time" features, that pick is **Server-Sent Events** on plain HTTP; reach for the **WebSocket handshake** when the problem is actually two-way. Boring here is not a compromise — it is the version of the system that is still healthy at 3 a.m.
