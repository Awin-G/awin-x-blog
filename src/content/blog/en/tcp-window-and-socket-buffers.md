---
title: "TCP window scaling and socket buffers: why your transfer is slow on a long link"
description: "Why a 500 Mbit/s link delivers 14 Mbit/s: the receive window, TCP window scaling, the bandwidth-delay product, and how socket buffers and autotuning set your real ceiling — measured with real iperf3, tcpdump, netem, and ss -ti output."
pubDate: 2027-01-28
lang: en
translationKey: tcp-window-and-socket-buffers
tags: [networking, linux]
featured: false
keywords:
  - TCP window scaling
  - bandwidth-delay product
  - socket buffer
  - ss -ti
  - tcp_rmem
---

Two iperf3 runs, the same two containers, the same 50 ms, 500 Mbit/s path I shaped
between them. The only thing that changed was how many bytes were allowed in flight:
14.4 Mbit/s in one run, 445 Mbit/s in the other. The link never moved. What I was
actually watching was the **receive window** — the quota TCP's receiver grants the
sender — and the machinery behind it: **TCP window scaling**, the **bandwidth-delay
product**, and the **socket buffers** that autotuning grows on your behalf. And the
tool that told me which limit was binding, before I touched a single sysctl, was
`ss -ti`.

This article is not about [congestion control](/posts/tcp-congestion-control/) — the
sender's own window, `cwnd`, covered separately — or about
[keepalive](/posts/tcp-keepalive/). This is the *other* window: the one the receiver
advertises, and the one that quietly caps transfers on long, fat links.

## The receive window is a quota on unacknowledged bytes

TCP does not let a sender blast at line rate. The receiver advertises a **receive
window** (`rwnd`): how many bytes it is currently willing to hold. The sender may
have at most that many bytes *unacknowledged* on the wire and in the receiver's
buffer at once. It is a flow-control quota, and it exists because the receiver's
buffer is finite — send more than fits and the kernel drops it.

`ss` prints both windows. On the sender of a busy transfer, the window it advertises
never grows past the default:

```
$ ss -ti '( dport = :5201 )'
ESTAB 0 0 172.17.0.5:43868 172.17.0.4:5201
	 cubic wscale:10,10 rto:260 rtt:59.924/5.303 mss:1448 pmtu:1500 rcvmss:536 advmss:1448 cwnd:2964 ssthresh:2320 bytes_sent:135723405 bytes_acked:131856630 segs_out:93760 segs_in:2283 data_segs_out:93758 send 573Mbps lastsnd:4 lastrcv:2871 pacing_rate 688Mbps delivery_rate 479Mbps delivered:91088 app_limited busy:2870ms unacked:2671 rcv_space:14480 rcv_ssthresh:64088 minrtt:50.059 snd_wnd:18301952 rcv_wnd:64512
```

`rcv_wnd:64512` — **63 KB**. That socket never receives data, so its own advertised
window stays at the default for the whole transfer; the window that mattered was the
other direction, `snd_wnd:18301952` — 18 MB, which autotuning grew for the sender on
the receiver's side. 63 KB is where every untuned socket starts, and on a LAN that is
plenty. On a path with 50 ms of latency it is nothing, and here is the arithmetic
that explains why.

## The bandwidth-delay product decides whether that quota is enough

The pipe between two hosts holds data. To keep it full you must have
`bandwidth × round-trip time` bytes in flight at all times — that quantity is the
**bandwidth-delay product** (BDP). If fewer bytes are in flight than the pipe can
hold, the link idles and your throughput becomes exactly `window ÷ RTT`:

| window | RTT | ceiling |
|---|---|---|
| 63 KB | 50 ms | ~10 Mbit/s |
| 63 KB | 100 ms | ~5 Mbit/s |
| 3.1 MB | 50 ms | 500 Mbit/s |

My path — 500 Mbit/s at a measured 50.093 ms RTT — has a BDP of **3.125 MB**. A 63 KB
window can only fill 2% of it. No upgrade to the switch, the NIC, or the CPU changes
that; the missing 3 MB would have to be *in flight*, and the window says it may not
be.

<figure>
<svg viewBox="0 0 640 300" width="100%" role="img" aria-label="Timeline diagram. A sender's timeline carries four data segments; a bracket above them marks the receive window, the number of bytes allowed to be unacknowledged. Ghost segments extend further to the bandwidth-delay product, the bytes needed to fill the whole pipe. On the receiver's timeline, ACKs return one round-trip time after each segment is sent. Throughput is at most the window divided by the round-trip time.">
  <defs>
    <marker id="arrow5" markerWidth="7" markerHeight="7" refX="3" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.4" opacity="0.55" fill="none">
    <path d="M90 80 H600"/>
    <path d="M90 210 H600"/>
    <path d="M90 86 V74 M90 216 V204"/>
    <path d="M600 76 h14" marker-end="url(#arrow5)"/>
    <path d="M600 206 h14" marker-end="url(#arrow5)" transform="rotate(180 607 206)"/>
  </g>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="currentColor">
    <text x="16" y="64">sender</text>
    <text x="16" y="236">receiver</text>
    <text x="132" y="46" fill="#0f766e">receive window (rwnd): bytes allowed unACKed</text>
    <text x="352" y="118" opacity="0.8">BDP = bandwidth × RTT</text>
    <text x="212" y="152">one round trip (RTT)</text>
    <text x="130" y="284">throughput ≤ window ÷ RTT</text>
  </g>
  <g fill="#0f766e">
    <rect x="130" y="72" width="42" height="16" rx="2"/>
    <rect x="180" y="72" width="42" height="16" rx="2"/>
    <rect x="230" y="72" width="42" height="16" rx="2"/>
    <rect x="280" y="72" width="42" height="16" rx="2"/>
    <rect x="340" y="72" width="42" height="16" rx="2" opacity="0.2"/>
    <rect x="390" y="72" width="42" height="16" rx="2" opacity="0.2"/>
    <rect x="440" y="72" width="42" height="16" rx="2" opacity="0.2"/>
    <rect x="490" y="72" width="42" height="16" rx="2" opacity="0.2"/>
    <rect x="540" y="72" width="42" height="16" rx="2" opacity="0.2"/>
  </g>
  <path d="M130 68 V56 H322 V68" fill="none" stroke="#0f766e" stroke-width="1.2"/>
  <path d="M322 90 V98 H596 V90" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>
  <path d="M172 84 C400 150 470 172 468 204" fill="none" stroke="currentColor" stroke-width="1.1" stroke-dasharray="5 4" marker-end="url(#arrow5)" opacity="0.7"/>
  <g fill="currentColor" opacity="0.55">
    <circle cx="466" cy="210" r="4"/>
    <circle cx="502" cy="210" r="4"/>
    <circle cx="538" cy="210" r="4"/>
    <circle cx="574" cy="210" r="4"/>
  </g>
</svg>
<figcaption>The receive window caps how many bytes may be unacknowledged; the bandwidth-delay product is what it takes to keep the pipe full. Throughput can never exceed window ÷ RTT — so a 63 KB window at 100 ms is 5 Mbit/s, however fat the link is.</figcaption>
</figure>

A link with both high bandwidth and high latency has a name for this condition:
**long fat network**. The larger the BDP, the more the window matters.

## Window scaling: the SYN option that lets a window pass 64 KB

The catch is that the window field in the TCP header is 16 bits wide: it can
advertise at most 65535 bytes. That was plenty in 1981 and is hopeless today. The
fix is **window scaling** (RFC 1323): each side announces, in the SYN, a shift count
(0–14) by which the window field is multiplied. The effective window is
`win << scale`, so scale 10 turns the 64240-byte field below into a 62 MiB window.
Both directions are negotiated separately, and because the window field is used from
the very first data segment, the scale must be known before any data flows — which
is exactly why the handshake is where it is agreed:

```
$ tcpdump -i eth0 -c 2 'tcp[tcpflags] & tcp-syn != 0' -n
02:46:40.101134 IP 172.17.0.5.55950 > 172.17.0.4:5201: Flags [S], seq 663357360, win 64240, options [mss 1460,sackOK,TS val 1191131545 ecr 0,nop,wscale 10], length 0
02:46:40.101144 IP 172.17.0.4:5201 > 172.17.0.5.55950: Flags [S.], seq 188291870, ack 663357361, win 65160, options [mss 1460,sackOK,TS val 1317947941 ecr 1191131545,nop,wscale 10], length 0
```

Both SYNs carry `wscale 10`; both sides will apply it for the rest of the connection.
If either side omits the option, scaling is disabled and the window is stuck below
64 KB — one reason a legacy middlebox that strips SYN options can quietly cap your
throughput.

## Socket buffers: where the window actually comes from

The window the kernel advertises is a function of the socket's receive buffer,
`SO_RCVBUF` (and its send-side sibling `SO_SNDBUF`). Three things control these
buffers on Linux, and the interaction is the whole story:

```
$ sysctl net.ipv4.tcp_rmem net.ipv4.tcp_wmem net.core.rmem_max net.core.wmem_max net.core.rmem_default
net.ipv4.tcp_rmem = 4096	131072	33554432
net.ipv4.tcp_wmem = 4096	16384	4194304
net.core.rmem_max = 4194304
net.core.wmem_max = 4194304
net.core.rmem_default = 212992
```

- **`net.ipv4.tcp_rmem` / `tcp_wmem`** — `min default max`, used by TCP's
  **autotuning**. New sockets start at the default (212992 bytes, the `rb131072`
  you can see in `ss -tim` on an idle socket) and grow toward the max as the
  connection learns it needs more room. Here the receive autotuning ceiling is
  **32 MB** while the send ceiling is 4 MB.
- **`net.core.rmem_max` / `wmem_max`** — a cap on what an *application* may set with
  `setsockopt(SO_RCVBUF)`. 4 MB here.
- **The kernel doubles what you set.** Ask an app for `SO_RCVBUF=1M` and `ss -tim`
  reports `skmem:(r0,rb2097152,t0,tb2097152,f0,w0,o0,bl0,d0)` — 2 MiB actually
  allocated, because the kernel reserves an equal amount for bookkeeping overhead.
  Of that, roughly 75% becomes advertised window.

That third rule matters when you read measurements: the bytes *in flight* land around
1.3–1.4× whatever an application requests. The surprise: on this box, autotuning
happily advertised an **18 MB** receive window (`snd_wnd:18301952` above) even though
`rmem_max` is 4 MB. Autotuning is bounded by `tcp_rmem[2]`; `rmem_max` only binds
explicit `setsockopt`. "Raise rmem_max to raise the window" is advice for
applications you control — it does nothing for the kernel's autotuner, whose lever is
`tcp_rmem`.

## `ss -ti` as the diagnostic: which limit is actually binding

Modern `ss -ti` prints, per connection, nearly everything you need — use a socket filter
(`ss -ti 'dport = :5201'`) to isolate the side you care about:

- `cwnd` / `ssthresh` — the sender's congestion window and slow-start threshold.
- `rtt:` `avg/jitter` and `minrtt` — round-trip time including the path's base delay.
- `bytes_received`, `segs_in`, `unacked`, `busy` — how much moved, how much is in flight.
- `rcv_space` / `rcv_ssthresh` — the autotuner's current target and ceiling.
- `rcv_wnd` / `snd_wnd` — current windows in each direction (already scaled).
- `skmem` — allocated buffers (`rb` = receive buffer, `tb` = send buffer).
- `rwnd_limited`, `sndbuf_limited`, `app_limited` — **time spent in each limit
  state**, in milliseconds and percent. This is the field that ends the guessing.

## The experiment: a 50 ms, 500 Mbit/s pipe

Between two containers on a Docker bridge I have a veth path that does 24 Gbit/s:

```
$ iperf3 -c 172.17.0.4 -t 2
[ ID] Interval           Transfer     Bitrate         Retr  Cwnd
[  5]   0.00-1.00   sec  2.81 GBytes  24.1 Gbits/sec  124    594 KBytes
[  5]   1.00-2.00   sec  2.76 GBytes  23.7 Gbits/sec   38    436 KBytes
```

(162 retransmissions in two seconds: at 24 Gbit/s the sender eventually outruns
whatever drops packets in the stack — a reminder that `Cwnd` and `Retr` are the first
columns to watch.)

Now I shape the client's egress into a "long fat" link — 500 Mbit/s with 50 ms of
delay — using netem inside the client container, which has `NET_ADMIN`:

```
$ tc qdisc replace dev eth0 root netem delay 50ms rate 500mbit limit 10000
$ ping -c 4 -i 0.3 172.17.0.4
...
rtt min/avg/max/mdev = 50.066/50.093/50.120/0.019 ms
```

BDP = 500 Mbit/s × 0.05 s = **3.125 MB**. Same client, same server, only the iperf3
`-w` flag changes:

```
$ iperf3 -c 172.17.0.4 -t 4 -w 64K
[  5]   0.00-4.00   sec  6.88 MBytes  14.4 Mbits/sec    0            sender
[  5]   0.00-4.05   sec  6.88 MBytes  14.2 Mbits/sec                  receiver
```

| client `-w` | sender bitrate | implied bytes in flight |
|---|---|---|
| 64 K | 14.4 Mbit/s | ~90 KB |
| 256 K | 57.7 Mbit/s | ~360 KB |
| 1 M | 214 Mbit/s | ~1.34 MB |
| 4 M | 445 Mbit/s | rate cap (500 Mbit/s) |
| default (autotuned) | 420 Mbit/s | the link, not the window |

`Retr` stayed at **0** for every run: with a shaped, lossless path there was nothing
for congestion control to react to, and the window was the only ceiling. Throughput
tracked window ÷ RTT until the 500 Mbit/s rate cap took over — exactly the law from
the figure. And with no tuning at all, autotuning filled the pipe to 420 Mbit/s.

## Proving it is the receiver: clamp its autotuning ceiling

Correlation is not causation, so I inverted the experiment. I restarted the server
with its receive autotuning ceiling clamped to 64 KB and left the client untouched:

```
$ docker run -d --name srv2 --sysctl net.ipv4.tcp_rmem="4096 131072 65536" ... iperf3 -s
$ docker exec srv2 sysctl net.ipv4.tcp_rmem
net.ipv4.tcp_rmem = 4096	131072	65536

$ iperf3 -c 172.17.0.9 -t 4
[  5]   0.00-4.00   sec  8.00 MBytes  16.8 Mbits/sec    0            sender
[  5]   0.00-4.05   sec  7.00 MBytes  14.5 Mbits/sec                  receiver
```

Same client, same netem, same BDP: 420 Mbit/s before, **14.5 Mbit/s** after. The
only change was `net.ipv4.tcp_rmem` in the server's network namespace. That is the
bandwidth-delay product being paid in full: 64 KB ÷ 50 ms ≈ 10 Mbit/s, plus the
accounting slack.

One instructive oddity: adding `-w 4M` to that same run jumped back to 444 Mbit/s,
even with the server's ceiling clamped. `ss -ti` on the server explains why —
`rcv_space:6286976 rcv_wnd:6241920 wscale:7,7`: the receiver's buffer was set
explicitly to a few MB, and an explicit buffer overrides the autotuning ceiling.
iperf3's own `-w` help text says it *"set send/receive socket buffer sizes"* — the
value is applied at the receiving end of the test, so that run was not "small
receiver, big sender" but "both ends big". Worth knowing before you design an
experiment around `-w`.

## Parallel streams: eight windows instead of one

The other classic lever is not to widen the window but to have more of them. On a
loopback shaped to 100 ms RTT (`tc qdisc add dev lo root netem delay 50ms`,
100.085 ms measured), one stream with a 64 KB window:

```
$ iperf3 -c 127.0.0.1 -t 10 -w 64K
[  5]   0.00-10.00  sec  11.1 MBytes  9.33 Mbits/sec    0            sender

$ ss -ti | grep -A1 '127.0.0.1:5201'
ESTAB 0 123258 127.0.0.1:34150 127.0.0.1:5201
	 cubic wscale:1,1 rto:301 rtt:100.688/1.263 mss:61629 pmtu:65535 rcvmss:536 advmss:65483 cwnd:10 bytes_sent:1557273 bytes_acked:1434016 segs_out:33 segs_in:24 data_segs_out:31 send 49Mbps lastsnd:64 lastrcv:1667 lastack:64 pacing_rate 97.9Mbps delivery_rate 4.93Mbps delivered:30 busy:1666ms rwnd_limited:1402ms(84.2%) ...
```

The kernel's own verdict: `rwnd_limited:1402ms(84.2%)` — it was receive-window
limited 84% of the time. Note also `mss:61629`: on loopback the [MTU](/posts/mtu-and-pmtud/)
is 65535, so two segments are already more than a 64 KB window. Now eight streams:

```
$ iperf3 -c 127.0.0.1 -t 10 -w 64K -P 8 | tail -4
[SUM] 0.00-10.00  sec  87.2 MBytes  73.2 Mbits/sec    0             sender
[SUM] 0.00-10.10  sec  86.6 MBytes  71.9 Mbits/sec                  receiver
```

**73.2 Mbit/s** from eight 9.3 Mbit/s streams — each connection gets its own window,
so parallelism multiplies whatever single window you have. That is the entire trick
behind download managers and parallel CDN fetches, and it needs no tuning at all.

## The window is not the only limit: `cwnd` still applies

The real constraint is `min(cwnd, rwnd)`. A giant window does nothing while `cwnd` is
small, and `cwnd` collapses at the first sign of loss — which my LAN path definitely
saw (162 retransmissions in the baseline run; `cwnd:2964 ssthresh:2320` in the `ss`
capture from a connection in congestion avoidance). The two fail differently:

- **rwnd-limited:** `Retr` near zero, high `rwnd_limited%`, `minrtt` near base RTT.
  The receiver's quota is the ceiling; widen it.
- **cwnd-limited:** `Retr` climbing, `rtt` well above `minrtt`, `cwnd` sawing. That
  is [congestion control](/posts/tcp-congestion-control/) territory — BBR, or fixing
  the loss.

## The practical checklist

In my experience the honest answer is: **change nothing, and prove it first.**

1. **Reproduce with math.** `ping` the RTT, `iperf3` the throughput, compute the BDP.
   If your measured throughput is already near the BDP, the window is not your
   problem — stop here.
2. **Read `ss -ti` during a real transfer.** `rwnd_limited` vs `Retr` vs
   `sndbuf_limited` tells you which limit binds. Never tune what you have not
   measured.
3. **If it is rwnd:** the receiver's autotuning ceiling (`net.ipv4.tcp_rmem` max) is
   the knob. Raise it to cover the BDP — 32 MB here was already far more than the
   3.125 MB this path needed, which is why the default run hit 420 Mbit/s with zero
   configuration.
4. **If your app sets `SO_RCVBUF` explicitly:** remember `rmem_max` caps it and the
   kernel doubles it; raise `rmem_max` too if the app's setting is what matters.
5. **Parallelism is a legitimate stopgap.** Client you control, server you can't
   touch — more streams with their own windows is exactly what browsers and download
   managers do.
6. **Tune only when the link is long and fat.** Below a few ms RTT the default window
   and autotuning already saturate the path; every sysctl you raise there just moves
   memory pressure from the network to the host.

I removed the containers when I was done; every number in this article is what they
printed.
