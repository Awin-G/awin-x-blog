---
title: "QUIC and HTTP/3 explained: what actually changed"
description: "A concrete walk through QUIC and HTTP/3: the TCP head-of-line blocking and handshake problems they fix, UDP transport with built-in TLS 1.3, streams and connection migration, the 0-RTT and 1-RTT handshake, QPACK, UDP 443 in nginx and Caddy, and how to test it."
pubDate: 2026-11-30
lang: en
translationKey: quic-and-http3
tags: [networking, nginx]
featured: false
keywords:
  - QUIC
  - HTTP/3
  - TCP head-of-line blocking
  - connection migration
  - 0-RTT
---

Every time a page loads faster than it *should* over flaky Wi-Fi, there is a
decent chance **QUIC** and **HTTP/3** are the reason. The two names travel
together, but they are different layers, and the reason HTTP/3 exists at all is a
specific, measurable defect in TCP called **TCP head-of-line blocking**. I have
been slowly turning HTTP/3 on across the services I run, and my honest summary is
this: it fixes a narrow set of problems very well, it buys you a new set of
operational headaches on UDP, and it is not a universal latency switch. This post
is what actually changed — protocol by protocol, plus how to test and observe it
on your own server. If the cryptography underneath is new to you, my
[TLS 1.3 handshake](/posts/tls-1-3-handshake/) walkthrough is the prerequisite;
QUIC is essentially that handshake with a transport welded on.

## What QUIC actually solves

Three long-standing complaints, in rough order of how much they matter.

### TCP head-of-line blocking

TCP delivers **one ordered byte stream**. If segment 2 is lost, segments 3, 4 and
5 may have already arrived, but TCP will not hand any of them to the application
until segment 2 is retransmitted and the gap is filled. On a clean link you never
notice. On a lossy one, every loss stalls *everything* behind it, even data that
has nothing to do with the lost bytes.

HTTP/2 was supposed to fix this by multiplexing many requests over one TCP
connection — and it made things *worse* on lossy links. Dozens of streams now
share one ordered byte stream, so a single dropped packet freezes all of them at
once. This is the problem QUIC was built to kill: it moves multiplexing *below*
the ordering guarantee, into independent streams.

<figure>
<svg viewBox="0 0 680 250" width="100%" role="img" aria-label="TCP delivers one ordered byte stream, so a single lost segment stalls everything behind it; QUIC multiplexes independent streams, so a lost packet blocks only its own stream.">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="20" y="26" font-weight="600">TCP: one ordered byte stream</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.5">
    <rect x="20"  y="42" width="150" height="46" rx="8"/>
    <rect x="190" y="42" width="150" height="46" rx="8" stroke-dasharray="6 5"/>
    <rect x="360" y="42" width="150" height="46" rx="8"/>
    <rect x="530" y="42" width="130" height="46" rx="8"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="95"  y="70" text-anchor="middle">seg 1</text>
    <text x="265" y="70" text-anchor="middle">seg 2 ✗ lost</text>
    <text x="435" y="70" text-anchor="middle">seg 3</text>
    <text x="595" y="70" text-anchor="middle">seg 4</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5" opacity="0.75">
    <text x="300" y="108" text-anchor="middle">everything behind the gap is buffered, undelivered, until seg 2 is retransmitted</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="20" y="152" font-weight="600">QUIC: independent streams</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none">
    <g fill="currentColor" fill-opacity="0.16">
      <rect x="20"  y="166" width="95" height="40" rx="7"/>
      <rect x="224" y="166" width="95" height="40" rx="7" stroke-dasharray="6 5"/>
      <rect x="428" y="166" width="95" height="40" rx="7" fill-opacity="0.06"/>
    </g>
    <g fill="currentColor" fill-opacity="0.05">
      <rect x="122" y="166" width="95" height="40" rx="7"/>
      <rect x="326" y="166" width="95" height="40" rx="7"/>
      <rect x="530" y="166" width="95" height="40" rx="7"/>
    </g>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="67"  y="191" text-anchor="middle">A1 ✓</text>
    <text x="169" y="191" text-anchor="middle">B1 ✓</text>
    <text x="271" y="191" text-anchor="middle">A2 ✗ lost</text>
    <text x="373" y="191" text-anchor="middle">B2 ✓</text>
    <text x="475" y="191" text-anchor="middle">A3 ⏸</text>
    <text x="577" y="191" text-anchor="middle">B3 ✓</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5" opacity="0.75">
    <text x="340" y="228" text-anchor="middle">only stream A waits for its retransmit; stream B keeps flowing past the gap</text>
  </g>
</svg>
<figcaption>Under TCP, ordering is per-connection, so one lost segment freezes every multiplexed request. QUIC orders per <em>stream</em>, so a loss only stalls the stream it belongs to — the packets of the other streams are delivered immediately.</figcaption>
</figure>

### Slow handshakes

Opening a classic HTTPS connection costs **two round trips** before the first
byte of application data: one RTT for the TCP handshake, then one for the TLS
handshake. QUIC fuses them — the transport handshake *is* the TLS 1.3 handshake —
so a fresh connection is one RTT, and a resumed one can be zero. On a 200 ms
mobile RTT, that is a couple hundred milliseconds saved on every cold connection,
which is exactly the kind of connection a user notices.

### Ossified middleboxes

TCP's header is fixed and inspected by firewalls, NATs and "security" appliances
the world over. New TCP options get silently dropped by middleboxes that never
saw them, which is why transport innovation stalled for two decades — a problem
literally named **protocol ossification**. QUIC sidesteps it by running inside UDP
payloads and encrypting almost its entire header, so middleboxes see an opaque
UDP flow and cannot selectively break new extensions. The cost of that choice is
the operational reality I get to later.

## What QUIC is

QUIC is a general-purpose transport protocol, standardised alongside HTTP/3, and
it is easiest to understand as three deliberate decisions.

### UDP instead of TCP

QUIC runs in **userspace over UDP**, reimplementing what TCP did — reliability,
ordering, congestion control, retransmission — as a library. This makes it
deployable without kernel or OS upgrades and lets it evolve at the speed of the
shipping application. UDP is only the container; the reliability logic is all
QUIC's.

### TLS 1.3 built in

TLS 1.3 is not layered on top of QUIC, it is *part* of it. QUIC uses the TLS 1.3
handshake to derive keys, but carries the messages in its own packet format rather
than TLS records. That is why QUIC has no TLS-over-TCP, no separate record layer,
and why the security review overlaps so heavily with the one in my
[TLS 1.3 post](/posts/tls-1-3-handshake/).

### Streams and connection IDs

QUIC carries **frames** — `STREAM`, `ACK`, `CRYPTO`, `MAX_DATA` — inside packets.
A connection has many **streams**, each independently ordered and flow-controlled,
so the figure above holds at the protocol level. And a connection is named by a
**connection ID**, not by the IP-and-port four-tuple. That decoupling is what makes
**connection migration** possible.

## HTTP/3 on top of QUIC

HTTP/3 is HTTP semantics — methods, status codes, headers, all the caching rules
in my [HTTP caching](/posts/http-caching/) notes — carried over QUIC streams.
There is no TCP and no TLS record layer underneath; each request/response runs on
its own QUIC stream, so one stalled response no longer blocks the others the way
it does under HTTP/2-over-TCP.

The other visible change is header compression. HTTP/2 used **HPACK**, whose
dynamic table is stateful and order-sensitive: headers must be decoded in the
order they were encoded. That reintroduces head-of-line blocking at the *header*
layer. HTTP/3 replaces it with **QPACK**, which keeps the compression ratio by
sending table updates on dedicated unidirectional streams, so an out-of-order
packet no longer wedges the header decoder. If you ever wondered why a protocol
needed a new compression scheme to escape a problem it just introduced, this is
why.

## 0-RTT and connection migration

A first QUIC connection is **1-RTT**: the client's `CRYPTO` frames carry the TLS
1.3 ClientHello, and both key agreement and transport negotiation complete in a
single round trip. On resumption, a stored session ticket lets the client send
**0-RTT** early data immediately. The tradeoff is unchanged from TLS 1.3: 0-RTT
data is replayable and gives up forward secrecy, so I never allow it for
state-changing requests — read-only `GET`s only.

**Connection migration** is the more interesting promise. Because the connection
is identified by its connection ID, a client can switch networks — Wi-Fi to
cellular, one IP to another — and keep the *same* streams alive instead of
reconnecting. The server validates the new path before trusting it, so a spoofed
source address cannot be turned into a reflection amplifier. In practice: a video
call or a large download survives the moment your phone drops Wi-Fi, without a
visible hiccup.

## What it means operationally

### UDP 443 must actually work

HTTP/3 listens on **UDP 443**, and that is where the day-two problems live:

- **Blocked UDP.** Corporate networks, some hotels and hardened firewalls block
  or rate-limit UDP 443. This is why HTTP/3 needs an `Alt-Svc` advertisement over
  TCP and why clients must be able to fall back to TCP without a stall.
- **NAT timeouts.** UDP flows expire faster than TCP in many NATs, so long-idle
  QUIC connections silently die. Keepalives mitigate it; sometimes disabling
  HTTP/3 for a NATed client is the pragmatic answer.
- **Amplification and rate limiting.** QUIC Initial packets are padded to 1200
  bytes and require a validated token before the server sends much, which limits
  amplification. Your own edge still needs UDP-aware DDoS filtering and rate
  limits, because "it's UDP" is not a security model.
- **Middlebox fairness.** Some networks deprioritise UDP, so a healthy HTTP/3
  setup still needs its TCP fallback.

### nginx and Caddy

nginx gained HTTP/3 in 1.25. Here is the shape of a minimal TLS server that
advertises it, on both UDP and TCP 443:

```nginx
# /etc/nginx/conf.d/blog.conf  (nginx >= 1.25)
server {
    listen 443 ssl;
    listen 443 quic reuseport;          # HTTP/3 lives on UDP 443
    http2 on;
    server_name blog.awin-x.top;

    ssl_certificate     /etc/letsencrypt/live/blog.awin-x.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/blog.awin-x.top/privkey.pem;

    # Advertise HTTP/3 to clients that are still on TCP:
    add_header Alt-Svc 'h3=":443"; ma=86400' always;

    location / { root /srv/blog; }
}
```

Remember the firewall rule, or none of it matters:

```bash
# Open UDP 443 as well as TCP 443
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
```

Caddy is the opposite extreme — HTTP/3 is on by default when a site has TLS,
with no extra configuration. That convenience is a good reason to reach for Caddy
on small deployments and reserve the nginx tuning for when I need finer control.

## The honest current state

Support is broad now: every major browser, `curl` when built against a QUIC
library, and the main servers and CDNs. The hard parts are debugging and knowing
when to leave it off.

Debugging is genuinely harder. Most of the wire is encrypted, so classic
port-443 packet inspection gives you little. The useful tools are protocol-aware
`curl`, the **qlog** format, and Wireshark with a per-session key log:

```bash
# Does this server actually speak HTTP/3, and does it advertise it?
curl -V                                  # look for HTTP3 in the feature list
curl --http3 -sI https://blog.awin-x.top | grep -i alt-svc
# Sample output:
# alt-svc: h3=":443"; ma=86400

# Capture and filter QUIC, then decrypt with a key log for deeper analysis
sudo tshark -i eth0 -f 'udp port 443' -w quic.pcapng
# Client side: SSLKEYLOGFILE=/tmp/keys.log <browser or curl>
# Wireshark: Preferences → Protocols → TLS → (Pre)-Master-Secret log filename
```

You can also point `openssl s_client` at a QUIC endpoint to exercise the
handshake directly, and Chromium's `chrome://net-export` dumps exactly which
connection used h3 and where it fell back.

```bash
openssl s_client -quic -connect blog.awin-x.top:443 \
  -servername blog.awin-x.top -alpn h3 </dev/null 2>&1 | head
```

And when does it **not** help? On a clean local network with no packet loss, the
difference is close to noise — QUIC's win comes from loss and from new
connections, not steady-state throughput. If a client already has a warm
connection, the handshake savings are already banked. Very high single-flow
throughput can actually regress, because userspace UDP processing and encryption
cost more CPU than a kernel TCP path. And if UDP 443 is blocked on the networks
your users are on, you have paid the complexity for nothing but a fallback. The
right default is to *offer* HTTP/3 and let clients choose, not to force it.

## What I actually check

My loop when enabling or debugging HTTP/3:

1. Confirm the server listens on UDP 443 and the host firewall allows it.
2. Confirm `Alt-Svc` is advertised on the TCP response.
3. Test with `curl --http3` and compare against a forced `--http1.1` baseline.
4. Capture with `tshark`/qlog only when something is actually wrong — and expect
   to need a key log to read anything.

QUIC did not reinvent HTTP. It fixed two concrete transport defects — per-stream
ordering and handshake round trips — and paid for that fix with a UDP operational
surface you now own. Know which of your users are on lossy links, advertise h3,
keep the TCP path healthy, and the change is worth it.
