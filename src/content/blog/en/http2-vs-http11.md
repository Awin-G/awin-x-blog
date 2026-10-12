---
title: "HTTP/2 vs HTTP/1.1: what actually changed (and what didn't)"
description: "A hands-on HTTP/2 vs HTTP/1.1 comparison: real curl and nghttp2 output from a throwaway nginx showing HTTP/2 multiplexing, HPACK header compression, the nginx http2 config, why TCP head-of-line blocking still needs QUIC, and honest localhost vs high-latency measurements."
pubDate: 2027-01-06
lang: en
translationKey: http2-vs-http11
tags: [networking, nginx]
featured: false
keywords:
  - HTTP/2 vs HTTP/1.1
  - HTTP/2 multiplexing
  - HPACK
  - head-of-line blocking
  - nginx http2
---

I recently switched a service that had been happily serving HTTP/1.1 for years over to HTTP/2, and almost nothing moved on the dashboards. That is not an argument against HTTP/2 — it is the reason I wanted to write the **HTTP/2 vs HTTP/1.1** comparison down properly, with a real server, real curls, and honest numbers instead of folklore. What follows is the version I wish I'd had: what HTTP/1.1 got wrong, what HTTP/2 actually fixed (binary framing, **HTTP/2 multiplexing**, **HPACK**), what it deliberately left alone, why TCP-level **head-of-line blocking** is a different problem that belongs to QUIC, and how to switch `nginx http2` on without breaking anything.

## The lab: one throwaway nginx, no sudo

Everything below is measured, not asserted. I started `nginx:1.27-alpine` on `127.0.0.1:8443`, gave it a self-signed certificate, generated 50 tiny assets, and pointed `curl 8.22.0` and `nghttp2 1.69.0` at it. For the latency experiment I added a userspace TCP relay that delays every direction by 50 ms, giving a 100 ms round trip. No sudo, no kernel tuning, no docker network tricks — and I deleted the container when I was done.

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
    listen 8443 quic reuseport;   # HTTP/3 on the same port, UDP
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

That is the whole server. Note `http2 on;` as a separate directive: since **nginx 1.25.1** the old `listen 443 ssl http2;` parameter is deprecated, so any tutorial written before mid-2023 will make a modern nginx log a warning and ignore the flag.

## What HTTP/1.1 got wrong: request-level head-of-line blocking and the connection ceiling

HTTP/1.1 keep-alive is a strictly in-order queue. One connection, one request in flight at a time, and responses come back in the order they were asked for. The consequences are the four problems HTTP/2 exists to solve:

- **Request-level head-of-line blocking.** On a single connection, request #2 waits for request #1's response to *finish*. One slow endpoint — a report that takes 400 ms, a thumbnail that hangs — stalls every request queued behind it on that socket.
- **The six-connection ceiling.** The only real workaround is more connections, and browsers cap them at roughly six per origin. When your page needs 60 subresources, the queue is 10 deep per socket and the sixth connection is doing the accounting, not the work.
- **A handshake per connection.** Each of those six sockets costs a TCP handshake plus a TLS handshake, and each of those costs a round trip or three. On a 100 ms link, establishing a connection is measured in hundreds of milliseconds.
- **Header bloat.** Every request repeats the same headers in plain text. With one 600-byte cookie (a session cookie plus a CSRF token is realistic), each request re-sends the same block:

```text
request 1: 708 bytes of request headers on the wire
request 2: 708 bytes of request headers on the wire
request 3: 708 bytes of request headers on the wire
```

Multiply by 50 subresources and by every page view, and you are paying for the same 700 bytes over and over — over mobile radios, over satellite links, over metered data.

## What HTTP/2 adds: multiplexing, HPACK and binary framing

### Binary framing

HTTP/2 stops being a text protocol. Messages are split into binary **frames** (HEADERS, DATA, SETTINGS, PING…) that are multiplexed over one TCP connection. Each request/response pair gets a **stream** with an odd-numbered ID. Parsing is cheaper and unambiguous, but the framing is mostly a means to an end; the end is multiplexing.

### HTTP/2 multiplexing — the actual headline

One connection, many streams, frames interleaved. Here is `curl 8.22` fetching three assets with `-Z` (parallel, multiplexed):

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

Three requests, one socket, stream IDs 1, 3 and 5 — all of them on **connection #0**. Over HTTP/1.1 the same three fetches either queue on one socket or need two extra sockets.

<figure>
<svg viewBox="0 0 680 350" width="100%" role="img" aria-label="HTTP/1.1 needs several connections with one request in flight each; HTTP/2 carries all requests as multiplexed streams over a single connection. Comparison of HTTP/1.1 connections and HTTP/2 streams.">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" font-weight="600">
    <text x="20" y="24">HTTP/1.1: six connections, one request in flight each</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="65" y="46" text-anchor="middle">browser</text>
    <text x="610" y="46" text-anchor="middle">origin</text>
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
      <text x="212" y="66">queued, waiting their turn</text>
      <text x="20" y="204">six TCP + TLS handshakes; every request repeats its headers</text>
    </g>
  </g>
  <line x1="20" y1="222" x2="660" y2="222" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" font-weight="600">
    <text x="20" y="246">HTTP/2: one connection, 50 multiplexed streams</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="65" y="268" text-anchor="middle">browser</text>
    <text x="610" y="268" text-anchor="middle">origin</text>
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
      <text x="20" y="336">one handshake; frames of many streams interleaved on one socket</text>
    </g>
  </g>
</svg>
<figcaption>HTTP/1.1 gives you a handful of ordered queues; HTTP/2 gives you one connection with many independent, interleaved streams — which is why connection count and queue depth stop being the bottleneck.</figcaption>
</figure>

### HPACK: a shared dictionary per connection

Every HTTP/2 connection maintains a dynamic header table on both sides. Repeated headers become one-byte indexed references, and anything new is Huffman-coded. `nghttp` shows the frame sizes directly. Same 600-byte cookie, three requests, one connection:

```text
$ docker exec h2lab nghttp -v -n -H "cookie: session=aaa…(600 bytes)…" \
    https://localhost:8443/widget-01.js https://localhost:8443/widget-02.js https://localhost:8443/widget-03.js
[  0.021] send HEADERS frame <length=441, flags=0x05, stream_id=1>
[  0.021] send HEADERS frame <length=20,  flags=0x05, stream_id=3>
[  0.021] send HEADERS frame <length=20,  flags=0x05, stream_id=5>
[  0.021] recv HEADERS frame <length=135, flags=0x04, stream_id=1>
```

441 bytes for the first request — that is the cookie being indexed — then **20 bytes** for each of the other two. HTTP/1.1 sent 708 bytes every time. That is HPACK doing its job: 2,124 bytes of request headers over three HTTP/1.1 requests versus 481 bytes over HTTP/2, a 77% reduction, and the win grows with the number of requests on the connection.

### Server push: born in 2015, deprecated, deleted

HTTP/2 could push resources the client had not asked for. It was also harder to get right than the spec suggested, browsers never used it well, and it fought the cache model. Chrome shipped it and then removed it in Chrome 106; the RFC now describes it as deprecated, and **nginx removed server push entirely in 1.25.1** (`http2_push` is obsolete; the suggested replacement is a `Link: rel=preload` response header, or 103 Early Hints). If you find a guide telling you to configure `http2_push`, it is nine years stale.

## What HTTP/2 does not fix: TCP head-of-line blocking

HTTP/2 removes head-of-line blocking *at the request level* — no request waits for another to complete. It does nothing about head-of-line blocking *at the transport level*, and this is the part that trips people up. HTTP/2 still runs over TCP, and TCP delivers one ordered byte stream. Lose segment 2, and segments 3, 4 and 5 sit in the kernel buffer until 2 is retransmitted — and now every multiplexed stream on that connection stalls with it.

That is a deliberate design decision to push up a layer: the fix is QUIC, which moves the ordering guarantee into per-stream recovery so one loss only blocks its own stream. I wrote that one up separately in [QUIC and HTTP/3 explained](/posts/quic-and-http3/). The practical version for a site owner: HTTP/2 is the biggest easy win, HTTP/3 is the win on lossy mobile links, and `alt-svc` is how a server advertises the latter — my blog's own responses currently carry none, which is why its HTTP/2 is the end of the story until I enable QUIC.

## What HTTP/2 changes in your optimisation checklist

The HTTP/1.1-era tricks existed to work around the connection ceiling and header bloat. On HTTP/2, several of them actively hurt:

- **Domain sharding is obsolete.** Splitting assets across `static1.example.com`…`static4.example.com` bought you extra sockets at the price of extra DNS lookups, extra handshakes, and no HPACK sharing. On HTTP/2 it is pure loss.
- **Sprite sheets and CSS/JS concatenation are usually wrong.** They exist to reduce request count. With multiplexing, 40 small requests are cheap, while one 400 KB bundle that invalidates on every edit is not. Smaller, individually cached files win.
- **Inlining everything is wrong.** Inlining data URIs defeats the cache and bloats the HTML you cannot cache anyway. Keep files as files.
- **What still matters:** caching (see [HTTP caching explained](/posts/http-caching/)), compression, HTTP/3/QUIC for lossy links, and TLS session reuse so the one connection you do open is cheap to reopen.

## Turning on nginx http2

That is the whole change, plus one verification step. On nginx ≥ 1.25.1:

```nginx
server {
    listen 443 ssl;
    http2 on;                 # not: listen 443 ssl http2;
    # …
    add_header Alt-Svc 'h3=":443"; ma=86400' always;   # if you also run QUIC
}
```

For a cleartext endpoint (inside your own network, or behind a TLS-terminating load balancer) `listen 8080; http2 on;` also works — nginx will speak h2c to a client that arrives with prior knowledge, no ALPN involved:

```bash
$ curl -s --http2-prior-knowledge -D - -o /dev/null http://127.0.0.1:8445/widget-01.js | head -1
HTTP/2 200
```

Confirming what the client actually negotiated is a two-second job, and it is the step people skip:

```bash
$ for v in 1.1 2 3; do curl -sk --http$v -s -D - -o /dev/null https://localhost:8443/widget-01.js | head -1; done
HTTP/1.1 200 OK
HTTP/2 200
HTTP/3 200
```

Two things to notice in the real headers: HTTP/2 lowercases header names and drops `Connection: keep-alive` (there is only ever one connection to keep alive), and if you also listen with `http3 on;` the response carries **`alt-svc: h3=":8443"; ma=86400`**, which is how a browser learns that a QUIC endpoint exists and can be tried next time. On the public internet you can see the same shape — a real site that does HTTP/3 answers `HTTP/2 103` (Early Hints) followed by `HTTP/2 200` and `alt-svc: h3=":443"`.

## Honest measurement: localhost vs a 100 ms link

Five ways to fetch the same 50 assets, all from the same origin.

**On localhost (RTT ≈ 0), 15 runs, whole batch, wall clock:**

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

**Throughput and header bytes, with `h2load` (nghttp2), 1000 requests against one asset, run inside the same container:**

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

**Across the 100 ms RTT link, same 50 assets, 3 runs:**

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

Read those honestly:

- **On localhost the win is small — 1.1–1.3x for the batch**, because with no latency the thing HTTP/2 removes (waiting for round trips) barely exists. Anyone promising you 10x from HTTP/2 on a LAN is selling something.
- **The header win is real and unconditional:** 36% fewer header bytes measured by `h2load`, and 77% fewer request-header bytes in the cookie example. That holds on every link, at every latency, and it is the one number here that never depends on the path.
- **The concurrency win is real too:** 2.6x the throughput with one tenth the connections, and `connect` time dropping from a 53 ms median to 7 ms, because 10 handshakes replaced 100.
- **The dramatic win needs latency.** 16.5x faster than a single-connection HTTP/1.1 page load, and 3.4x faster than the browser's best six-connection effort, on a 100 ms link. This is what a phone on a mediocre mobile connection experiences.
- **One caveat on my own numbers:** the 100 ms link is a userspace TCP relay that delays each chunk, not a real WAN, and TLS session reuse was off so every batch paid fresh handshakes. Treat the localhost table as solid and the latency table as indicative of direction and rough magnitude, not as a benchmark to quote at a conference.

## The short version

Turn on `http2 on;` — it is one directive, it is never slower in a way you will notice, and it buys you HPACK plus multiplexing for free. Then stop doing the HTTP/1.1 workarounds: sharding, sprite sheets, and eager inlining all become noise. If your users are on mobile networks, the next real step is QUIC over UDP, described in [QUIC and HTTP/3 explained](/posts/quic-and-http3/). And whatever you do, measure on your own traffic: on localhost HTTP/2 looks like a rounding error, and on a high-latency link it looks like a different protocol.
