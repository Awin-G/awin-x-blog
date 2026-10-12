---
title: "Traceroute lies: what routing actually looks like (and how mtr tells the truth)"
description: "Classic traceroute is a flattering cartoon: ICMP rate limits, per-flow load balancing, hidden MPLS labels, asymmetric return paths and NAT all bend it. Learn to read paths honestly with tcptraceroute, mtr and fixed-flow probes, tell queuing from distance, and diagnose a real path problem."
pubDate: 2026-10-30
lang: en
translationKey: traceroute-lies
tags: [networking, linux]
featured: false
keywords:
  - traceroute
  - mtr
  - asymmetric routing
  - network troubleshooting
  - ICMP rate limit
  - MPLS
  - load balancing
---

Every network troubleshooting session starts the same way: you type `traceroute`,
get a tidy numbered list of hops, and start narrating — "it goes through
Frankfurt, then some CDN edge, then nothing." I have done this for years, and I
have to admit it: that list is closer to a rumor than a map. Traceroute lies,
gently and often. It lies because of **ICMP rate limits**, because per-flow **load
balancing** makes each probe take a different path, because **MPLS** hides the
hops that matter, because **asymmetric routing** means the return path was never
the one you drew, and because plenty of routers simply do not answer. `mtr` is not
more honest by magic — it gives you the one thing traceroute never did: time.

What follows: how the tool works, the ways it misleads you, how to probe a path you
can trust, how to read latency without panicking, and one traceroute that looks
broken but is only rate-limited. The short version: a traceroute is evidence, not
a map — a sample of one moment, on one flow.

## Why traceroute lies: the probe is not the path

The mechanism is beautifully lazy. `traceroute` sets TTL to 1 on its first probe;
the first router decrements it to 0, drops the packet, and returns an ICMP **Time
Exceeded**. The source of that ICMP is the router's address facing you — hop 1.
Bump TTL to 2, repeat, and you walk the path one router at a time. Notice what you
measured: not the path your traffic takes, but the path a series of *handcrafted
probes* took, plus each router's willingness to answer. Every failure mode below
attacks one of those two assumptions.

## ICMP TTL-expired rate limiting: the router that plays dumb

Routers live under constant TTL-expired traffic from scans, so almost every
production box **rate-limits ICMP Time Exceeded generation** — often one per
second, with the rest policed away. Your traceroute fires three probes per hop in
a tight burst; two or three get swallowed. The symptom is a `* * *` gap mid-path:

```
$ traceroute -n 203.0.113.10
 1  192.168.1.1      0.412 ms
 2  10.0.0.1         1.203 ms
 3  * * *
 4  * * *
 5  198.51.100.1    12.884 ms
 6  203.0.113.10    13.010 ms
```

The lazy reading is "a black hole at hop 3." The correct reading is "hops 3 and 4
declined to name themselves" — the packets got through, since hop 5 is right after
them. A router that skips ICMP errors still forwards data. Linux shows the policy:

```bash
sysctl net.ipv4.icmp_ratelimit   # 1000 = one packet per 1000 ms, i.e. 1/sec
sysctl net.ipv4.icmp_ratemask    # Time Exceeded (type 11) is in this mask
```

## Per-flow load balancing: one traceroute, many paths

Equal-cost multipath (ECMP) forwards *flows*, not packets, hashing a five-tuple:
source/destination IP, source/destination port, protocol. `traceroute` varies two
of those on purpose — a different UDP destination port per probe (33434 onward),
or a different ICMP id. Different hash, different link, different next hop. On a
load-balanced path you get a **lattice, not a line**: hop 4 flips between
10.0.4.1 and 10.0.4.2 across probes. Read as "flapping" or "a loop," it is usually
neither — you are sampling several parallel paths and printing them as one.

## MPLS, NAT and routers that simply don't reply

**MPLS** replaces per-hop IP forwarding with label-switched paths inside an ISP.
A label-switching router need not decrement the IP TTL in a way that emits an ICMP
error, so the whole ISP core collapses into one row of `* * *` between two edge
routers. Your trace says "one hop, 3 ms, then instant 40 ms" and you invent a 37 ms
mystery. There are nine routers in there, invisible by design.

**NAT** breaks it the other way. A probe crossing NAT returns an ICMP Time
Exceeded whose *quoted* packet was rewritten; some NATs drop these rather than
translate them back, and a hop goes silent. Many routers are also configured never
to send ICMP errors at all. A `* * *` is a shrug, not a wall.

## How to get a signal you can trust: tcptraceroute, mtr, fixed flow IDs

Fix "probes are special" by making the probe look like real traffic. A **TCP
traceroute** sends SYNs to a port that is actually open — 443, 22, whatever your
service listens on — so routers treat it like a normal connection and the *final*
host answers with a SYN-ACK instead of an ICMP port-unreachable that firewalls
drop.

```bash
# TCP-mode trace to a real port: -T = SYN probes, -p = destination port.
traceroute -n -T -p 443 203.0.113.10
tcptraceroute -n 203.0.113.10 443
```

Then `mtr`, which is what I reach for first: traceroute plus a loop, printing
running per-hop statistics so you see loss and latency as distributions instead of
single samples. A photograph versus a film.

```bash
# Live matrix; -T / -P give the TCP-probe benefit.
mtr -T -P 443 -n 203.0.113.10
# Report mode: 100 cycles is enough to separate real loss from transient noise.
mtr -T -P 443 -n -c 100 -r 203.0.113.10
```

For load-balanced paths, pin the flow. ECMP's hash rewrites itself the moment a
port changes, so hold the 4-tuple constant — and use a fixed Paris flow id — to
walk **one** link instead of sampling the fabric.

```bash
# Pin source/dest port and flow id so the hash never changes: identical hops
# across a run mean a single path; differing hops mean you were sampling.
traceroute -n -p 443 -s 40000 -N 1 203.0.113.10
```

## Reading latency: queuing versus path

Resist adding the numbers up. A hop's latency is the RTT to that **router's control
plane**, generated as its lowest-priority job. A loaded router can show 200 ms at
hop 5 and 20 ms at hop 6 — impossible for a real path, and simply that router being
slow to *generate ICMP*, not slow to *forward*. That is control-plane **queuing**.
So: a spike at one hop followed by normal hops later means "ignore that hop"; a
spike that *persists* for every hop after means a real, additive increase.

The other tell is loss. Loss that starts at hop N and continues to the destination
is real. Loss at hop N that *disappears* at hop N+1 is a rate-limited generator or
an artifact — the end host still sees every packet. Loss on hop 5 with zero loss at
the destination is not a path problem; loss on hop 5 that shows up at the
destination is.

## Asymmetric routing: the return path is a different story

Traceroute only shows the **forward** path — outbound probes getting errors back.
The packets your server replies with often travel a completely different sequence
of providers, especially with anycast, CDN edges, or dual upstreams. This is
**asymmetric routing**, and on the public internet it is the norm, not the
exception. It matters because almost every real symptom — a stalled `git clone`, a
handshake that never finishes — is about the *pair* of directions. A path that
looks flawless forward can be broken on the return, invisible from one end.

## A traceroute that looks broken but is only rate-limited

A user reports `api.example.com` is "flaky from the office." I run this:

```
$ traceroute -n api.example.com
 1  192.168.1.1       0.3 ms
 2  10.0.0.1          0.9 ms
 3  * * *
 4  * * *
 5  * * *
 6  * * *
 7  198.51.100.7     14.2 ms
 8  198.51.100.9     14.4 ms
 9  * * *
10  203.0.113.20     15.1 ms
```

The story writes itself: "hop 3 is a black hole, everything after is fiction."
Except `curl` to that host completes, in 15 ms — matching hop 10. The packets are
getting through; nothing is a black hole. Hops 3–6 are a carrier's **MPLS core**
refusing to generate ICMP, and hop 9 is a firewall that answers data but not
probes. Ugly graph, healthy path. The tell is the one from above: **the
destination answers and its latency matches the last visible hop.** If the thing
you're talking to is reachable and fast, every `* * *` above it is a silent
router, not a broken one.

## How to actually diagnose a path problem

When the complaint is real, stop taking one snapshot.

**1. Run `mtr` over time.** One traceroute is a single sample of a stochastic
process; `mtr -c 200` gives loss percentages and jitter per hop.

```bash
# Read loss on the LAST row: if the destination shows 0%, every gap above is
# cosmetic.
mtr -T -P 443 -n -c 200 -r api.example.com | tee /tmp/mtr-api.txt
```

**2. Test from both ends.** The only way to see asymmetric routing is to run the
same probes from the far side and compare. If forward is clean and reverse is not,
you have found the direction that matters.

**3. Correlate with TCP retransmits, not just ICMP.** ICMP loss is a proxy; real
loss shows up unambiguously in kernel TCP counters.

```bash
ss -tin dst api.example.com            # per-connection retransmits, RTT, RTO
nstat -az TcpRetransSegs TcpExtTCPSynRetrans
watch -n1 'nstat -z TcpRetransSegs TcpExtTCPSynRetrans | tail -3'
```

If `mtr` shows 0% at the destination but `TcpExtTCPSynRetrans` keeps climbing, you
have a real problem ICMP never mentioned — classic ECMP path flapping, or a link
dropping data but not probes. Retransmits are ground truth; ICMP is hearsay.

**4. Bring in the third leg.** If large transfers die but small ones live, that is
more likely PMTU than routing — go read [MTU and PMTUD](/posts/mtu-and-pmtud/). If
lookups are slow but connections are fine, the path is not your problem; the
resolver is — see [how DNS resolves](/posts/how-dns-resolves/). Separating "the
route is bad" from "something on the route is bad" is most of the work.

## What it means to say "the route went through X"

The honest sentence is not "the traffic went through Frankfurt." It is: *"at
14:02, my probes to this destination returned TTL-expired messages from these
routers; the destination answered with an RTT of 15 ms; over 200 probes the
destination showed 0.2% loss."* That is a claim you can defend.

A traceroute is a sketch of a path drawn by strangers who may decline to identify
themselves, over a fabric that changes per flow, with a return leg you cannot see.
Accept that and it stops being a lie: one cheap probe, worth exactly what you pay
for it — and worth a great deal more when you run it two hundred times, from both
ends, and cross-check it against your TCP counters.
