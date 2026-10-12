---
title: "tc netem: traffic shaping with measurable latency, loss, and rate limits"
description: "Use tc netem and tbf to emulate WAN latency, packet loss, and rate limits on Linux. Real measurements from a throwaway Docker container: ping RTT, throughput before/after, and tc -s counters."
pubDate: 2027-01-04
lang: en
translationKey: traffic-shaping-with-tc
tags: [networking, linux]
featured: false
keywords:
  - tc netem
  - traffic shaping
  - network emulation
  - tc qdisc
  - tbf
---

When I need to know how a service behaves on a real WAN link — high latency, a bit of packet loss, a capped uplink — I don't rent a satellite office. I use `tc netem` and a `tbf` qdisc on a spare interface and watch the counters move. Traffic shaping with `tc` (traffic control) is one of those Linux skills that looks like kernel wizardry until you realize a single `tc qdisc` command can add 100 ms of delay, drop 5 % of packets, or cap a backup job at 2 Mbit/s — all reproducible, all measurable.

In this post I'll run every experiment in a throwaway Docker container with `NET_ADMIN`, capture the real output, and show you exactly what `tc qdisc` did to my packets. No theory without proof.

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240" role="img" aria-label="Diagram of a qdisc queue on a Linux interface shaping packets with netem and tbf">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-auto">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- Interface box -->
  <rect x="200" y="60" width="240" height="120" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="320" y="85" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="14">eth0 (interface)</text>
  <!-- Queue slots -->
  <g fill="#0f766e">
    <rect x="220" y="100" width="30" height="30" rx="3"/>
    <rect x="260" y="100" width="30" height="30" rx="3"/>
    <rect x="300" y="100" width="30" height="30" rx="3"/>
    <rect x="340" y="100" width="30" height="30" rx="3" opacity="0.5"/>
    <rect x="380" y="100" width="30" height="30" rx="3" opacity="0.25"/>
  </g>
  <text x="320" y="150" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="12">qdisc (netem + tbf)</text>
  <!-- Incoming packet -->
  <rect x="60" y="105" width="40" height="24" rx="4" fill="none" stroke="#0f766e" stroke-width="2" stroke-dasharray="4 2"/>
  <text x="80" y="150" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="11">app</text>
  <line x1="100" y1="117" x2="215" y2="117" stroke="currentColor" stroke-width="2" marker-end="url(#arrow)"/>
  <!-- Outgoing packet -->
  <rect x="540" y="105" width="40" height="24" rx="4" fill="none" stroke="#0f766e" stroke-width="2"/>
  <text x="560" y="150" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="11">net</text>
  <line x1="425" y1="117" x2="535" y2="117" stroke="currentColor" stroke-width="2" marker-end="url(#arrow)"/>
  <!-- Labels -->
  <text x="320" y="40" text-anchor="middle" fill="#0f766e" font-family="monospace" font-size="12">delay 100ms ±10ms · loss 5% · rate 2mbit</text>
  <text x="320" y="210" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="11" opacity="0.6">egress path: app → qdisc → wire</text>
</svg>
<figcaption>A <code>tc qdisc</code> sits between your application and the network device. <code>netem</code> adds latency, jitter, and loss; <code>tbf</code> caps the rate. Everything is measurable with <code>tc -s</code>.</figcaption>
</figure>

## What tc qdiscs are (and where they sit)

Every Linux network interface has a **queueing discipline** (qdisc) attached to it. The qdisc decides what happens to a packet after the kernel hands it to the driver: send it now, hold it, drop it, or delay it. The default on most modern kernels is `noqueue` (for virtual interfaces like `lo`) or `fq_codel`/`pfifo_fast` (for real NICs). You can see the current qdisc with:

```bash
$ tc qdisc show dev lo
qdisc noqueue 0: root refcnt 2
```

That's loopback with no shaping — packets go out instantly. `tc` lets you replace that qdisc with something that actively shapes traffic. The tool comes from `iproute2` and runs on the host kernel; in a container you need `--cap-add=NET_ADMIN` (not `--privileged`) to manipulate qdiscs.

## tc netem: network emulation you can measure

`netem` (network emulator) is a qdisc that emulates WAN conditions: delay, jitter, packet loss, duplication, reordering, and corruption. It's the standard tool for testing how software behaves on a bad network — and it's built into the Linux kernel, so no extra packages are needed.

I started with baseline measurements on `lo`:

```bash
$ ping -c 5 -i 0.2 127.0.0.1 | tail -2
rtt min/avg/max/mdev = 0.020/0.024/0.031/0.003 ms
```

Zero shaping: sub-millisecond RTT. Now I added 100 ms of delay with ±10 ms jitter:

```bash
$ tc qdisc add dev lo root netem delay 100ms 10ms
$ tc qdisc show dev lo
qdisc netem 8001: root refcnt 2 limit 1000 delay 100ms  10ms

$ ping -c 5 -i 0.2 127.0.0.1 | tail -2
rtt min/avg/max/mdev = 191.343/197.231/206.342/5.917 ms
```

The RTT jumped from 0.024 ms to 197 ms — almost exactly 200 ms, because a packet traverses `lo` twice (out and back), and `netem` delays each direction by 100 ms. The `mdev` of 5.9 ms shows the jitter is real, not a constant offset.

Next I layered on 5 % packet loss:

```bash
$ tc qdisc change dev lo root netem delay 100ms 10ms loss 5%
$ ping -c 20 -i 0.2 127.0.0.1 | tail -3
20 packets transmitted, 17 received, 15% packet loss, time 3824ms
rtt min/avg/max/mdev = 189.739/200.373/211.389/5.438 ms, pipe 2

$ tc -s qdisc show dev lo
qdisc netem 8001: root refcnt 2 limit 1000 delay 100ms  10ms loss 5%
 Sent 4410 bytes 45 pkt (dropped 3, overlimits 0 requeues 0)
```

I configured 5 % loss and measured 15 % — that's randomness for you (20 samples is small). The `tc -s` counters are the ground truth: **3 packets dropped** by the qdisc, right there in the output. This is why `tc -s` matters: your ping stats are a sample, but the kernel counter is exact.

## Rate limiting with tbf (and htb for fairness)

`netem` corrupts and delays; `tbf` (token bucket filter) **caps the rate**. It's the qdisc you want for "don't let this backup job saturate the uplink." I served a 4 MB file over HTTP and measured the download speed before and after:

```bash
# baseline, no shaping
$ curl -o /dev/null -s -w "speed_download=%{speed_download} B/s  time_total=%{time_total}s\n" http://127.0.0.1:8080/bigfile
speed_download=755730450 B/s  time_total=0.005550s

# add tbf: 2 Mbit/s, 128 KB burst, 400 ms latency
$ tc qdisc add dev lo root tbf rate 2mbit burst 1mbit latency 400ms
$ tc qdisc show dev lo
qdisc tbf 8008: root refcnt 2 rate 2Mbit burst 128Kb lat 400ms

$ curl -o /dev/null -s --max-time 30 -w "speed_download=%{speed_download} B/s  time_total=%{time_total}s\n" http://127.0.0.1:8080/bigfile
speed_download=251565 B/s  time_total=16.672842s
```

The download went from **755 MB/s to 251 KB/s** — a 3000× slowdown, right at the configured 2 Mbit/s (250 KB/s). The 4 MB file took 16.7 s instead of 5 ms. Here are the counters:

```bash
$ tc -s qdisc show dev lo
qdisc tbf 8008: root refcnt 2 rate 2Mbit burst 128Kb lat 400ms
 Sent 4299539 bytes 161 pkt (dropped 4, overlimits 268 requeues 0)
```

`overlimits 268` means the kernel tried to send 268 more packets than the token bucket allowed. `dropped 4` means 4 packets were discarded because the queue was full. This is the proof that shaping happened — the kernel counted every violation.

**A word about burst and collapse:** my first tbf attempt used `burst 32kbit` (4 KB). The download stalled for 61 s and transferred nothing — TCP collapsed because the token bucket was too small to fill the congestion window. `burst` controls how many packets can be sent instantly before tokens run out; too small and you kill TCP, too large and you lose shaping granularity. `1mbit` (128 KB) is a sane default for a 2 Mbit/s limit.

For **fair sharing** between multiple flows, `htb` (hierarchical token bucket) is the tool. You define classes with guaranteed rates and optional ceilings, then steer packets into classes with filters:

```bash
$ tc qdisc add dev lo root handle 1: htb default 12
$ tc class add dev lo parent 1: classid 1:11 htb rate 2mbit burst 15k
$ tc class add dev lo parent 1: classid 1:12 htb rate 5mbit burst 15k
$ tc filter add dev lo protocol ip parent 1:0 prio 1 u32 match ip dport 8080 0xffff flowid 1:11

$ tc -s filter show dev lo parent 1:
filter protocol ip pref 1 u32 chain 0 fh 800::800 order 2048 key ht 800 bkt 0 *flowid 1:11 not_in_hw (rule hit 111 success 68)
  match 00001f90/0000ffff at 20 (success 68)
```

The filter matched 68 packets to class `1:11` (the 2 Mbit/s class) and sent everything else to the default class `1:12` (5 Mbit/s). On loopback both directions share the interface, so the request packets got shaped while response packets went to the default class — a good reminder that `tc` is **per-direction**.

## Reading the counters with tc -s

The `-s` flag turns `tc` from a configuration tool into a measurement instrument. Every qdisc keeps kernel-level counters: packets sent, bytes sent, drops, overlimits, and backlog. The pattern is always the same:

```bash
$ tc -s qdisc show dev lo
 Sent 4299539 bytes 161 pkt (dropped 4, overlimits 268 requeues 0)
 backlog 0b 0p requeues 0
```

- **Sent** — packets and bytes that made it out
- **dropped** — packets discarded (queue full or loss configured)
- **overlimits** — packets that wanted to exceed the rate but were held
- **backlog** — packets currently waiting in the queue

I use these counters in two ways: to prove a shaping rule is active (before/after diff), and to detect when a queue is saturated (growing backlog + rising drops). It's the same philosophy I apply to [load average](/posts/linux-load-average/) and [IO latency](/posts/io-latency/): measure the kernel's own counters, not a proxy.

## Where this actually gets used

- **Reproducing a slow network.** A customer reports timeouts on their 50 Mbit/s link with 2 % packet loss. Instead of guessing, I run `netem delay 30ms loss 2%` on my test interface and reproduce their exact conditions.
- **Testing timeouts and retries.** Does my HTTP client actually retry after a 30 s timeout, or does it give up? Add `netem delay 35s` and watch. Does my retry logic create a thundering herd? Add `loss 10%` and find out.
- **Limiting a backup job.** `rsync` over a saturated uplink makes SSH unusable. `tbf rate 20mbit` on the backup interface caps it without touching the application.
- **Fair sharing in a multi-tenant box.** `htb` with per-class rates keeps one tenant's bulk transfer from starving another's latency-sensitive traffic.

## The honest limits of tc

Traffic shaping is powerful but not free. The limitations are real:

- **Egress is easy, ingress is hard.** Shaping outbound traffic (`dev eth0 root`) works out of the box. Shaping **inbound** traffic requires an Intermediate Functional Block (IFB) device and a filter to redirect ingress packets to it:

  ```bash
  $ ip link add ifb0 type ifb
  $ ip link set dev ifb0 up
  $ tc qdisc add dev lo handle ffff: ingress
  $ tc filter add dev lo parent ffff: protocol ip u32 match u32 0 0 action mirred egress redirect dev ifb0
  $ tc qdisc add dev ifb0 root netem delay 50ms

  $ ping -c 5 -i 0.2 127.0.0.1 | tail -2
  rtt min/avg/max/mdev = 100.053/100.112/100.143/0.031 ms
  ```

  The RTT doubled to 100 ms — 50 ms on the IFB (ingress) plus 50 ms on `lo` (egress). It works, but it's three commands and an extra device.

- **Per-interface, per-direction.** A qdisc applies to one interface in one direction. Shaping "all traffic" means configuring every interface, or using `tc` on a bridge or `ifb` to centralize it.
- **Fiddly filters.** The `u32` filter syntax is powerful but opaque — `match ip dport 8080 0xffff at 20` is matching at byte offset 20, and getting the offset wrong silently breaks everything. I spent three iterations on the htb filter before the counters showed packets actually matching.
- **No application awareness.** `tc` sees packets, not processes. "Limit Chrome to 1 Mbit/s" requires `cgroup` + `tc` or `iptables` marks — a whole other article.

## The bottom line

`tc` is the Linux kernel's built-in network laboratory. `tc netem` gives you measurable latency, jitter, and loss; `tbf` gives you a hard rate cap; `htb` gives you fair sharing. Every claim in this post came from real counters in a throwaway container — I made the mistakes (TCP collapse from a tiny burst, a filter matching the wrong offset, a veth pair that bypassed the qdisc entirely) so you don't have to.

The next time someone asks "does our app work on a slow network?", you can answer in one line: `tc qdisc add dev eth0 root netem delay 100ms loss 5%`. And when they ask "how do you know it's working?", you'll have `tc -s` to prove it.
