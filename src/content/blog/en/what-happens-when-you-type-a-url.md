---
title: "What happens when you type a URL: the whole path, briefly"
description: "A crisp end-to-end walk of what happens when you type a URL: browser cache, DNS resolution through stub, recursive and authoritative servers, the TCP handshake and slow start, the TLS 1.3 handshake, the reverse-proxy hop, cache headers, rendering, and HTTP/2 vs HTTP/3."
pubDate: 2026-11-10
lang: en
translationKey: what-happens-when-you-type-a-url
tags: [networking, linux, self-hosting]
featured: false
keywords:
  - what happens when you type a URL
  - DNS resolution
  - TCP handshake
  - TLS handshake
  - HTTP/3
---

Type a URL, press Enter, and a page appears. The gap between those two events is
the most-traveled road on the internet, and it is the one most of us learn as a
blur: browser cache, **DNS resolution**, **TCP handshake**, **TLS handshake**,
request, render. This is the map of **what happens when you type a URL** — one
pass over the whole path, with a link at each layer to the post that goes deep on
that layer. It is deliberately a map, not a novel: enough to know which hop to
suspect when a page is slow or broken, and where to read next.

## The map: what happens when you type a URL

Every request is the same walk, in the same order. The numbers on the right are
tiny for a warm cache and add up fast on a cold one.

```
you type https://blog.example.com/posts/   and press Enter
  |
  ├─ 1. browser cache / HSTS / service worker        ~0 ms        (maybe)
  ├─ 2. DNS resolution   stub -> recursive -> auth   ~0-50 ms     (cache: ~0)
  ├─ 3. TCP handshake    SYN -> SYN-ACK -> ACK       ~1 RTT
  ├─ 4. TLS handshake    SNI, cert, key_share        ~1 RTT       (TLS 1.3)
  ├─ 5. HTTP request     GET /posts/ HTTP/2          ~1 RTT
  ├─ 6. proxy hop -> app -> database                 app time
  ├─ 7. HTTP response    headers + body, compressed  bytes / RTT
  └─ 8. parse -> render  DOM, CSS, JS, paint         CPU + subresources
```

An **RTT** is one round trip — the time for a packet to leave and an answer to
come back. If your server is 40 ms away, that is the floor for every step that
needs a fresh round trip; a cold handshake spends three or four of them before a
single useful byte arrives.

## Before the network: browser cache, HSTS, and the URL bar

The first few hops never leave your machine, which is why people skip them — and
why they matter so much. The browser checks its own HTTP cache against the
response's `Cache-Control` and `ETag`. A hit means the whole trip below is
skipped and the page repaints from disk. HSTS may rewrite `http://` to `https://`
before a packet is sent, removing a redirect round trip. A service worker can
answer from a script cache with no network at all. A cold load skips all of this,
which is the honest answer to "why was it slow the first time and instant after?"

## DNS resolution: stub, recursive, authoritative

The URL has a name; the network routes by address. **DNS resolution** turns one
into the other, and it is cached at every level — browser, OS stub resolver, and
the recursive resolver — each for the record's TTL. Most of the time you pay
zero, because a recent lookup is still warm.

The roles are worth naming once: the **stub resolver** in your OS just forwards
the question; the **recursive resolver** does the walking (root, then TLD, then
the authoritative server that owns the zone) and caches everything it learns; the
**authoritative** server is the end of the line and never asks anyone else. The
full walk, including `CNAME` and DNSSEC caveats, is its own post: [how DNS
resolves, step by step](/posts/how-dns-resolves/).

```bash
# Follow the delegation yourself, bypassing every cache on the way:
dig +trace +nodnssec blog.example.com

# What a real cache miss costs, in the numbers that matter:
dig blog.example.com | grep -E 'Query time|SERVER'
```

## TCP handshake: SYN, SYN-ACK, ACK

With an address in hand, the client opens a connection. The **TCP handshake** is
three packets — the client sends `SYN`, the server answers `SYN-ACK`, the client
completes with `ACK` — which costs one full RTT before any data moves. This is
also where a connection can simply not exist: a firewall that drops `SYN`, a
routing black hole, or an overloaded backlog all show up here as a timeout.

The part people skip is what happens *after* the handshake. TCP starts slowly and
probes the path: **slow start** doubles the congestion window roughly every RTT,
so the first response is limited to a handful of packets and only later ones get
the full bandwidth. On a high-latency path this is a measurable tax, which is why
a CDN near the user — shortening every RTT — matters more than raw server CPU.

## TLS handshake: SNI, certificate, key exchange

Then the connection is encrypted. In the **TLS handshake**, the client's
`ClientHello` carries **SNI** — the hostname, in the clear — which lets one IP
serve many sites and tells the server which certificate to present. The server
returns its certificate chain and proves it holds the private key; both sides
derive a shared session key with an ephemeral key exchange (`key_share`,
usually X25519).

TLS 1.3 folds this into **one round trip**: the client guesses the group and
sends its key share up front, so the server can encrypt from its first reply.
That is one RTT saved over TLS 1.2 on every fresh connection. 0-RTT can save one
more on a resumed connection, at the cost of replay risk. The message-by-message
version, including how to read it in `openssl s_client`, lives in [the TLS 1.3
handshake walkthrough](/posts/tls-1-3-handshake/).

```bash
# See the SNI-bearing handshake and the exact certificate that answered:
openssl s_client -connect blog.example.com:443 \
  -servername blog.example.com -tls1_3 </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

## The HTTP request and the proxy hop

Now, finally, a request: a method and path, a `Host` header, and whatever the
page needs (`Accept`, cookies, auth). On any real deployment the connection does
not land on the app directly. It lands on a **reverse proxy** — nginx, Caddy,
Traefik — which terminates TLS, rewrites headers (`X-Forwarded-For`,
`X-Forwarded-Proto`), serves static files and cached responses, and forwards only
what the application must answer. This is the hop that the textbook diagrams
erase, and it is where a lot of latency and a lot of bugs live.

## The server: reverse proxy, application, database

Past the proxy: the application (or a static file) computes a response. In a
dynamic app that usually means one or more database queries, maybe a cache lookup
(a hit is sub-millisecond, a miss plus a round trip is not), and a template
render. This is the only step measured in *CPU time* rather than RTT, and it is
the one an engineer can actually profile — `strace`, a query log, an APM span.

## The response and browser rendering

The response comes back with a status, headers, and a body. `Content-Encoding`
(gzip, Brotli, zstd) shrinks the bytes; `Cache-Control` and `ETag` decide whether
the browser may skip this whole trip next time. Then **browser rendering** begins:
parse HTML into the DOM, build the CSSOM, form the render tree, lay out, paint,
composite — and, along the way, fetch the CSS, JS, fonts, and images the HTML
references. Each subresource can trigger its own DNS, TCP, and TLS steps, which is
why the waterfall is long even when the first byte was fast. A render-blocking
script stops layout until it downloads *and* executes.

## HTTP/2, HTTP/3, and connection reuse

The path above is for a *fresh* connection. Real pages reuse: keep-alive holds
TCP open, and **HTTP/2** multiplexes many requests over one connection, ending
head-of-line blocking at the HTTP layer. **HTTP/3** runs over QUIC instead of TCP,
removing the transport-level head-of-line blocking and folding the transport and
TLS handshakes together — a first connection can be established in one round trip,
and a resumed one in zero. This is the reason the same page on a good CDN can feel
significantly faster without a single change to the application.

## Where the latency comes from

Add it up and the targets are obvious:

- **Cold, far, and unencrypted-once**: DNS cache miss + TCP + TLS + request =
  three to four RTTs before content. Warm and reused: zero of them.
- **Distance**: every RTT, not every byte, is the tax. Move the server closer or
  put a CDN in front.
- **Slow start** limits the first response's throughput more than bandwidth does.
- **The proxy hop** and **database** show up as server time, not network time —
  often the largest single number on a dynamic page.
- **Rendering** subresources multiply the whole sequence per asset.

```bash
# Break one request down by phase — the fastest way to see where time goes:
curl -o /dev/null -s -w \
'dns %{time_namelookup}  connect %{time_connect}  tls %{time_appconnect}  ttfb %{time_starttransfer}  total %{time_total}\n' \
https://blog.example.com/
```

## The one-paragraph summary

A URL press walks a fixed road: the browser cache may answer it locally; DNS
resolution turns the name into an address through a stub and a recursive resolver;
the TCP handshake opens the connection in one RTT and slow start throttles the
first bytes; the TLS handshake, one RTT in 1.3, authenticates the server via SNI
and its certificate and agrees a key; the HTTP request reaches a reverse proxy
that forwards to the app and its database; the response carries cache headers that
decide whether next time skips the whole trip; and the browser parses, renders,
and fetches subresources. Latency is round trips plus server time plus CPU — so
cache aggressively, move closer, reuse connections with HTTP/2 and HTTP/3, and
suspect the hop you cannot see.
