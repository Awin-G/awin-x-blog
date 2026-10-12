---
title: "TCP congestion control: Reno, CUBIC, and BBR — why your throughput isn't what it could be"
description: "TCP congestion control is how the kernel picks its own send rate with almost no knowledge of the path. Slow start, congestion avoidance and fast recovery; why CUBIC is Linux's default; how BBR models the bandwidth-delay product; reading `ss -ti`; switching to BBR with sysctl; and bufferbloat."
pubDate: 2026-11-30
lang: en
translationKey: tcp-congestion-control
tags: [networking, linux]
featured: false
keywords:
  - TCP congestion control
  - BBR vs CUBIC
  - TCP tuning
  - bufferbloat
  - bandwidth-delay product
---

There is a particular kind of disappointment in watching a gigabit link top out
at 40 Mbit/s while the switch, the disks, and the CPU are all idle. The hardware is
fine. What you are looking at is **TCP congestion control**: the rules your kernel
uses to decide how fast it is *allowed* to send when it has no idea how much
bandwidth the path actually has. On a long or lossy path it is the difference
between using 5% of your link and using 90%.

The framing matters, because "congestion control" is usually misread as "make it
fast." It is almost the opposite: a distributed resource-allocation scheme every TCP
sender runs independently, using only the faint feedback of ACKs and loss to share a
network none of them can see. Here is what it does, the phases it moves through, how
Reno, CUBIC and BBR differ, how to watch the window with `ss -ti`, and why
bufferbloat is the same story told from the queue's side.

## What TCP congestion control actually does

A TCP sender has two windows. The **receive window** is what the peer advertised;
the **congestion window** (`cwnd`) is the sender's own guess at how much the network
can hold. At most `min(cwnd, rwnd)` bytes may be in flight, and everything
interesting is in how `cwnd` moves.

The path has a capacity called the **bandwidth-delay product** (BDP): bottleneck
bandwidth times round-trip time. That is how many bytes must be in flight to keep the
pipe full — a 100 Mbit/s path at 100 ms RTT needs about 1.25 MB in flight, *far* more
than a default window. Until `cwnd` reaches the BDP you are not using the link; you
are waiting.

Nobody tells the sender the BDP: routers publish neither queue depth nor link speed,
so the only signals a classic sender gets are ACKs coming back and packets not coming
back. So it probes: increase until something breaks, then back off. That is
*additive increase, multiplicative decrease* (AIMD) — add one segment per RTT while
things are healthy, cut hard when loss says you overshot. Add slow, cut fast keeps
the system stable instead of oscillating; it is not "go fast" but a search for an
unknown ceiling. The alternative is **congestion collapse** — ignore loss, push at
line rate, and queues overflow, loss triggers retransmissions, and the network
carries more packets while delivering fewer.

## The phases: slow start, congestion avoidance, fast recovery

TCP does not jump to a window size and hope. It climbs through phases.

**Slow start** is a misnomer — the growth is exponential, just starting low. `cwnd`
begins near ten segments (RFC 6928) and **doubles every RTT** as ACKs return: 1, 2,
4, 8, 16… until it reaches `ssthresh` (initially huge) or loss. Slow start discovers
an unknown BDP quickly; it is only "slow" compared to blasting, which is reckless.

**Congestion avoidance** takes over once `cwnd` passes `ssthresh`. Growth is now
linear — roughly **+1 MSS per RTT** — because the sender is near the ceiling and
inches instead of doubling. This is the steady state and where most of a long-lived
transfer's life is spent.

**Fast retransmit and fast recovery** handle loss without starting over. When a
segment is lost, the receiver keeps the later segments and re-ACKs the last in-order
byte, so the sender gets three duplicate ACKs — "one packet likely dropped, path
still working." It retransmits immediately, sets `ssthresh` to half of `cwnd`, halves
`cwnd`, and continues in congestion avoidance (*fast recovery*) instead of collapsing
to `cwnd = 1`. Only a timeout (no ACKs at all) resets to slow start. The figure below
is the shape all of this makes on a plot of `cwnd` against time.

<figure>
<svg viewBox="0 0 640 260" width="100%" role="img" aria-label="A congestion window plotted over time: slow start doubles cwnd on a steep exponential ramp, congestion avoidance creeps upward linearly, a loss event marks a sharp drop and fast recovery, then congestion avoidance resumes with a shallow climb.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <path d="M60 20 V220 H610"/>
    <path d="M60 20 H55 M60 220 H55"/>
  </g>
  <g stroke="currentColor" stroke-width="1.6" fill="none" opacity="0.75">
    <path d="M60 214 L74 200 L88 182 L102 158 L114 130 L124 100 L132 78 L150 76 L180 72 L215 66 L255 59 L300 50 L336 42"/>
    <path d="M336 42 L344 96 L354 102" stroke="#0f766e"/>
    <path d="M354 102 L378 96 L410 88 L450 78 L495 67 L540 56 L560 51"/>
    <path d="M560 51 L566 100 L576 105" stroke="#0f766e"/>
    <path d="M576 105 L600 99"/>
    <path d="M336 42 V214 M560 51 V214" stroke-dasharray="4 4" opacity="0.45"/>
  </g>
  <circle cx="336" cy="42" r="3.5" fill="#0f766e"/>
  <circle cx="560" cy="51" r="3.5" fill="#0f766e"/>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="86" y="150" text-anchor="middle">slow start</text>
    <text x="86" y="164" text-anchor="middle" font-size="11" opacity="0.75">(doubles / RTT)</text>
    <text x="230" y="52" text-anchor="middle">congestion avoidance</text>
    <text x="230" y="40" text-anchor="middle" font-size="11" opacity="0.75">(+1 MSS / RTT)</text>
    <text x="450" y="60" text-anchor="middle">congestion avoidance</text>
    <text x="342" y="232" text-anchor="middle" font-size="11" fill="#0f766e">loss</text>
    <text x="566" y="232" text-anchor="middle" font-size="11" fill="#0f766e">loss</text>
    <text x="470" y="118" text-anchor="middle" font-size="11" opacity="0.8">fast recovery: halve, don't restart</text>
    <text x="30" y="126" text-anchor="middle" font-size="12" opacity="0.85">cwnd</text>
    <text x="600" y="240" text-anchor="middle" font-size="12" opacity="0.85">time</text>
  </g>
</svg>
<figcaption>A congestion window over time: exponential slow start, linear congestion avoidance, then a loss that halves the window and is repaired by fast recovery. Each loss resets the ceiling, and the window saws its way around it.</figcaption>
</figure>

## Reno, CUBIC, and BBR: three answers to the same question

All algorithms agree on the mechanism — probe, then back off. They disagree on
*what counts as "too far"*, and that difference is worth real throughput.

**Reno** is the original of the modern era, and its logic is exactly the AIMD above:
add one MSS per RTT, halve on loss. Its weakness shows on any path with meaningful
delay: halving is a *huge* cut when `cwnd` is large, and recovery then takes hundreds
of RTTs. **NewReno** patches the worst case — a single loss repaired without multiple
slow-start entries — but keeps the sawtooth. On a long-fat network, Reno oscillates
around the BDP and never settles.

**CUBIC** has been the Linux default since 2.6.19 for a reason. Instead of a linear
increase, `cwnd` is a **cubic function of the time since the last loss**: grow
aggressively while the window is safely below the previous loss point, then flatten
near that ceiling. Recovery after a big loss is far faster than Reno's, and the
growth curve depends far less on RTT, which keeps long-RTT and short-RTT flows
closer to fair. CUBIC still *reacts to loss* — just more intelligently.

### BBR vs CUBIC: a model of the path versus a reaction to loss

Google's **BBR** throws out loss as the primary signal. Loss is a poor congestion
signal on modern links: buffers are deep, so a packet can drop long after the
bottleneck is full, and on wireless a packet can drop with no congestion at all.
Instead BBR builds a **model of the path** from two measurements it already has: the
**delivery rate** (how fast ACKs confirm data — the bottleneck bandwidth) and the
**minimum RTT** over a sliding window (a queue-free round trip). Multiply them and
you have the BDP. BBR then **paces** its sending to that bandwidth, holds the window
near the BDP, and periodically probes up for bandwidth and down for RTT.

The upside is large on lossy paths. Where CUBIC halves on *any* loss — including loss
unrelated to congestion — BBR keeps the measured rate, so a 1% random-loss link that
starves CUBIC may run near full speed. The tradeoffs:

- **It needs pacing and an `fq` qdisc.** Without `fq`, BBR cannot space packets at
  the modelled rate, loses much of its advantage, and can add bursty delay.
- **Loss is no longer the backstop.** Against **loss-based** flows BBR can be
  aggressive, filling the buffer to keep its delivery-rate estimate high — the
  unfairness early BBR earned criticism for. BBRv2/v3 add loss back as a secondary
  cap, but which version you run depends on your kernel's age.
- **It games a metric.** A sender that declines to back off on loss outcompetes one
  that does, so BBR on a shared link can push loss-based peers around. On one server
  against everyone else, that is a tax on them.

Reno is the baseline; CUBIC is the safe general-purpose default; BBR is a large win
on long, lossy, or deeply-buffered paths and a mild risk on shared ones. That is the
honest summary of **BBR vs CUBIC**.

## TCP tuning: seeing and changing the algorithm on Linux

Two commands cover most of it. `sysctl` shows and switches the algorithm, and the
qdisc matters as much as the algorithm: BBR wants `fq`.

```bash
# What is in use, and what is even available in this kernel?
sysctl net.ipv4.tcp_congestion_control
sysctl net.ipv4.tcp_available_congestion_control
# Typical output:
#   net.ipv4.tcp_congestion_control = cubic
#   net.ipv4.tcp_available_congestion_control = reno cubic bbr

# Switch to BBR for this runtime. fq gives BBR the pacing it assumes.
sysctl -w net.core.default_qdisc=fq
sysctl -w net.ipv4.tcp_congestion_control=bbr

# Persist it across reboots.
cat > /etc/sysctl.d/99-tcp-bbr.conf <<'EOF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
EOF
sysctl --system

# If bbr is missing from the list, load the module first:
lsmod | grep tcp_bbr || modprobe tcp_bbr
```

`ss -ti` shows what a live connection is actually doing — read it like `top` for
one socket:

```bash
$ ss -ti dst 203.0.113.10
State  Recv-Q Send-Q  Local Address:Port    Peer Address:Port
ESTAB  0      0       10.0.0.5:51234        203.0.113.10:443
	 cubic wscale:7,7 rto:204 rtt:24.5/2.1 ato:40 mss:1448
	 pmtu:1500 rcvmss:1448 advmss:1448 cwnd:42 ssthresh:38
	 bytes_acked:184210 bytes_received:9210 segs_out:1523 segs_in:640
	 send 19.8Mbps pacing_rate 39.6Mbps delivery_rate 19.2Mbps
	 busy:2340ms unacked:3 retrans:0/2 lost:1 reordering:5 rcv_rtt:26.1
```

Field by field:

- **`cubic`** — the algorithm in force, then **`rtt:24.5/2.1`**: a 24.5 ms smoothed
  round-trip with 2.1 ms of variance. Quiet `rtt` with low `send ` means the window
  is the limit, not the network.
- **`cwnd:42 ssthresh:38`** — 42 MSS in flight with the threshold just below, so the
  connection is in *congestion avoidance* and recently recovered from a loss.
- **`retrans:0/2 lost:1`** — a `lost` count that keeps climbing on a long transfer is
  the smoking gun for loss-based back-off: the algorithm treats it as congestion
  whether or not it is.
- **`delivery_rate 19.2Mbps` vs `send 19.8Mbps`** — the model's estimate of what the
  path delivers; far below link speed with `rtt` creeping up means window-limited or
  queued. **`pacing_rate`** is what BBR paces against.

The decisive diagnostic: if `rtt` is flat and low while `send` is low and `cwnd` is
small, you are limited by the *algorithm's slow climb*, not the path — the case where
switching algorithms changes everything. When you suspect the route instead,
[`traceroute-lies`](/posts/traceroute-lies/) covers separating real path loss from
ICMP noise, and `retrans` in `ss -ti` confirms it against ground truth.

## When it matters, and when it doesn't

**It matters when the BDP is large or the path is lossy:**

- **Long-fat networks.** A 1 Gbit/s path at 100 ms RTT has a BDP around 12.5 MB.
  CUBIC and BBR both reach it eventually; Reno never settles. On intercontinental
  transfers, algorithm choice is worth multiples of throughput.
- **Lossy links.** Satellite, mobile, and congested Wi-Fi lose packets for reasons
  unrelated to congestion. A loss-based algorithm reads every drop as "slow down"
  and leaves bandwidth on the table; this is BBR's home turf.
- **VPNs and tunnels.** An encapsulated flow still runs the same congestion control
  over its *inner* packets, but the tunnel MTU and the extra queueing on the tunnel
  endpoints change the picture. If large transfers *stall* rather than run slow, that
  is a different bug — read [MTU and PMTUD](/posts/mtu-and-pmtud/) before touching
  `sysctl`.

**It does not matter on a LAN.** On a 1 Gbit/s switch with 0.2 ms RTT, the BDP is
about 25 KB — a few dozen segments. `cwnd` reaches it during slow start, and the
transfer is limited by the application, the disk, or the CPU, not the network.
Switching to BBR here changes nothing you can measure, and the same holds for
container-to-container and loopback traffic.

The rule in one line: **congestion control matters when `bandwidth × RTT` is much
larger than your window, or when packet loss lies about congestion.** Both are absent
on a LAN, and both are routine on the public internet.

## Bufferbloat: the queue you can't see

Everything above assumes the network's queue is shallow. Often it is not, and that
is **bufferbloat**. A router with a 500 ms buffer on a 100 Mbit/s link will absorb
the entire congestion window without dropping a packet, so the sender keeps growing
`cwnd` — no loss, no signal to back off — until the standing queue is hundreds of
milliseconds deep. Latency climbs, jitter explodes, video calls stutter, and TCP is
behaving perfectly by its own rules: the problem is the queue, not the algorithm.

That is why BBR's minimum-RTT measurement is valuable: it can see the queue that
loss-based algorithms cannot, because the queue stays invisible until it overflows.
It is also why the fix is at the **queue** end: an **AQM** (active queue management)
qdisc such as `fq_codel` or `CAKE` drops or marks packets *before* the buffer is
full, signalling congestion early and bounding queueing delay. That is why BBR pairs
with `fq`, and why good routers default to `fq_codel`. Congestion control decides how
hard to push; the qdisc decides how long a packet waits.

## The two sentences to remember

Congestion control is a search: probe until something breaks, cut hard, creep back.
CUBIC is the safe default that reacts to loss; BBR is the model-based alternative
that wins where loss is a lie but can misbehave when everyone else plays by the old
rules.

So when a transfer underperforms: check `rtt`, `cwnd`, and `retrans` in `ss -ti`. If
the window is small and RTT is clean, the algorithm is holding you back — try BBR
with `fq`. If RTT climbs while throughput holds, a buffer is filling; fix the queue.
On a LAN, go do something more useful.
