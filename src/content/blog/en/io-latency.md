---
title: "Disk I/O latency troubleshooting: reading iostat, await and iowait"
description: "High load with an idle CPU is usually a disk problem. How to read iostat -x for average await, %util and queue depth, separate throughput problems from latency problems, catch a p99 stall with iotop and /proc/<pid>/io, and fix fsync-heavy writers, WAL, swap thrash and log spam."
pubDate: 2026-11-22
lang: en
translationKey: io-latency
tags: [devops, linux]
featured: false
keywords:
  - iostat
  - disk I/O latency
  - iowait
  - await
  - queue depth
---

When a box feels slow but the CPU is idle, the culprit is usually **disk I/O
latency**, not compute. Load average counts tasks stuck in `D` state, so it climbs
while nothing is actually running; **iowait** tells you there is a stall but not
which device. The metric that names the device is the average **await** in
**iostat**. This is the path I take from "the server is slow" to a named device, a
named process, and one specific fix.

## Why load average and iowait hide disk I/O latency

I have written before about [why Linux load average lies](/posts/linux-load-average/),
and the storage version of that story is short. A task blocked on a slow disk sits
in uninterruptible sleep (`D` state), unkillable until the I/O returns, and every
such task increments the load count. The CPU is idle the whole time. You get the
classic shape: load pinned high, `%us` near zero, `%wa` near 100.

```console
$ vmstat 1 3
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 0 14      0 210400  39812 1890000    0    0  4096 12288  720 1440  2  1  3 94  0
 0 15      0 208900  39812 1889000    0    0  5120 13000  700 1420  2  1  2 95  0
```

`b` is 14–15, `r` is 0, `wa` is ~94%. That is a disk problem wearing a CPU costume.
But **iowait** is a trap in the other direction too: it is a per-CPU counter that
only ticks when that CPU would otherwise have been idle. It says nothing about
*which* device is slow, and on a busy multi-core box it can stay low while a single
container starves on the shared volume. Treat iowait as a hint that something is
blocked on I/O — not as a device metric.

## The metrics that matter: await, %util, queue depth, percentiles

Four numbers, and what each one actually means:

- **`await`** — average time per I/O request, in milliseconds, from submission to
  completion. It includes time waiting in the queue *plus* time the device spent
  servicing the request. `iostat` splits it into `r_await` and `w_await`, which
  matters because reads and writes age very differently on the same device.
- **`%util`** — the fraction of wall-clock time the device had at least one request
  in flight. On a single spinning disk, 100% means saturated. On NVMe with deep
  queues, `%util` can read 95% while the device is nowhere near its limit. It is a
  hint, not a verdict.
- **Queue depth** (`aqu-sz` in newer `iostat`, `avgqu-sz` in older builds) — the
  average number of requests outstanding. This is the number that explains *why*
  `await` is high: if the queue is deep, each request is waiting its turn behind
  others.
- **Throughput** (`r/s`, `w/s`, `rkB/s`, `wkB/s`) — useful for cost and capacity,
  not for latency.

These are linked by **Little's law**: queue depth ≈ arrival rate × latency. Know two
and the third is arithmetic. That is why "the disk is at 100%" is an incomplete
sentence until you know whether it is 100% of a single queue or 100% of a device
doing 800k IOPS.

## Reading `iostat -x`: a walkthrough

Always ask for extended stats (`-x`), skip idle devices (`-z`), and ignore the
first sample — it is an average since boot, not since the previous second. Run it
with a count so you get a live sample:

```console
$ iostat -xz 1 2
Device      r/s   w/s    rkB/s    wkB/s  %util  await  r_await  w_await  aqu-sz
nvme0n1    12.0  1840    256.0   74240.0   98.7   18.4     0.9     18.6    34.2
sda         0.2     6      8.0     384.0    3.1    6.2     4.1      6.3     0.0
```

Reading left to right: `nvme0n1` is doing 12 reads and 1840 writes per second, so
this is a write-heavy workload. `%util` is 98.7 — the device is almost never idle.
`await` averages 18.4 ms, and the read/write split is the whole story: `r_await` is
0.9 ms while `w_await` is 18.6 ms. Reads are fine; writes are the problem. `aqu-sz`
is 34, meaning 34 writes are queued on average, which is exactly why `w_await` is
18 ms instead of ~1 ms. `sda` is idle and irrelevant.

That one line already gives me the shape: a write-bound device with a deep queue. It
does not yet tell me whether the fix is more IOPS, a shorter queue, or a less
pathological writer.

## Throughput problems vs latency problems

These are different diseases with different cures, and `%util` cannot tell them
apart. A backup copying 500 MB/s at 20 ms `await` is a throughput problem: plenty of
work, flat latency. A database doing 4000 tiny `fsync` writes per second at 20 ms
`await` is a latency problem: little data, every request expensive. Same `await`,
opposite fixes.

<figure>
<svg viewBox="0 0 640 260" width="100%" role="img" aria-label="Latency stays flat as offered I/O load rises, then bends sharply upward at the saturation knee. Queue depth rises in the same region.">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <line x1="60" y1="220" x2="600" y2="220" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
    <line x1="60" y1="220" x2="60" y2="30" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
    <text x="600" y="240" text-anchor="end" opacity="0.7">offered I/O load (r/s + w/s) &#8594;</text>
    <text x="22" y="30" opacity="0.7">latency</text>
    <path d="M60 205 L320 165 L400 110 L448 45" fill="none" stroke="currentColor" stroke-width="2" opacity="0.35" stroke-dasharray="4 3"/>
    <text x="452" y="49" opacity="0.55">%util / queue depth</text>
    <path d="M60 205 C 200 203, 300 195, 360 175 C 400 160, 420 120, 440 60" fill="none" stroke="currentColor" stroke-width="2.5"/>
    <text x="235" y="200" opacity="0.75">latency (await)</text>
    <circle cx="392" cy="155" r="4" fill="currentColor"/>
    <line x1="392" y1="155" x2="392" y2="220" stroke="currentColor" stroke-width="1" stroke-dasharray="3 3" opacity="0.4"/>
    <text x="398" y="212" opacity="0.75">knee = saturation</text>
    <text x="72" y="200" font-family="ui-monospace, monospace" font-size="11" opacity="0.5">flat: the queue absorbs bursts</text>
  </g>
</svg>
<figcaption>The same disk, two regimes. Left of the knee, latency is flat and adding load is nearly free. Right of the knee, throughput is already maxed and every extra request just deepens the queue and multiplies <code>await</code>.</figcaption>
</figure>

The knee is the whole point. Below it, a healthy disk hides short bursts in its
queue and `await` stays flat. Above it, extra load converts directly into latency:
same throughput, worse `await`, worse p99. If a graph shows `%util` at 100% and
`await` climbing, you are past the knee — adding work cannot help.

## Finding the culprit process

Device-level numbers tell you *where*; the next step is *who*.

**`iotop`** gives a live, per-process view sorted by I/O — the fastest way to see
one runaway writer among a hundred idlers. `pidstat -d` is the scriptable version:
it prints per-process read/write rates over an interval, which is what you actually
want in a log.

```console
$ iotop -oPa          # -o: only processes doing I/O, -P: per process, -a: accumulated
$ pidstat -d 1 5      # per-process I/O rates, one line per process per second
```

**`/proc/<pid>/io`** is the ground truth and never lies about which process to
charge. `write_bytes` counts bytes that actually went to the block layer;
`cancelled_write_bytes` counts pages that were dirtied and then thrown away before
ever hitting disk — useful for spotting a writer that is wasting the disk it gets.

```console
$ cat /proc/$(pgrep -x postgres)/io
read_bytes:    918273645
write_bytes:  4471293840
cancelled_write_bytes: 812304
```

Inside containers, read **cgroup** counters instead, because `iotop` inside a
namespace often sees the wrong thing (`io.stat` on cgroup v2, `blkio.throttle*` on
v1):

```console
$ cat /sys/fs/cgroup/system.slice/postgresql.service/io.stat
8:0 rbytes=918273645 wbytes=4471293840 rios=120441 wios=981223 dbytes=0 dios=0
```

## Common causes

- **fsync-heavy workloads.** A single `fsync` waits for the device to make the write
  durable. A workload that does one `fsync` per record turns a fast SSD into a slow
  device, because each call pays the device's full flush latency.
- **Database WAL.** Postgres and MySQL both `fsync` their write-ahead log on commit.
  Group commit amortises it, but a slow WAL device sets a hard floor on commit
  latency no amount of CPU can fix.
- **Huge files.** A multi-gigabyte `cp`, a build tarball, or a snapshot fills the
  page cache, triggers writeback, and saturates the device long after the tool
  returned.
- **Swap thrash.** If `vmstat` shows `si`/`so` above zero, memory pressure has
  become disk latency. On a VM this turns every page fault into a network round
  trip.
- **Noisy neighbours.** On shared EBS, vSAN, or a hypervisor's local disk, your
  `await` is partly someone else's workload. The device you can see is not the only
  writer on the device you share.
- **Log spam.** A debug log line per request, synchronous or on a filesystem that
  flushes eagerly, is a self-inflicted `fsync` storm.

## Fixes

Match the fix to whether you are over the throughput limit or over the latency
limit.

**Batch writes.** The cheapest win. Buffer and flush in blocks instead of per
record, use `group commit`, and write fewer, larger records. This cuts both
throughput (fewer operations) and latency (shorter queues).

**Tune `vm.dirty_*` — carefully.** Dirty page writeback controls when the kernel
starts flushing, and it is a latency/throughput trade:

```console
# lower = smoother latency, lower burst throughput; raise only if you know why
vm.dirty_background_bytes = 268435456   # start writeback at 256 MiB dirty
vm.dirty_bytes            = 536870912   # block writers at 512 MiB dirty
vm.dirty_expire_centisecs = 1500        # flush pages dirty > 15s
vm.dirty_writeback_centisecs = 500      # wake the flusher every 5s
```

Setting `dirty_bytes` low keeps the flush bursts small and `await` low, at the cost
of the kernel never using the whole disk at once. Setting it high lets seeks
coalesce but produces exactly the long stalls you were trying to fix. Change one
value at a time and watch `await`.

**Faster disk or more IOPS.** If `%util` is pinned and the queue is deep, the device
is genuinely out of capacity. More IOPS (NVMe over SATA, provisioned IOPS on cloud
volumes) raises the knee.

**Separate devices.** Put the WAL, the logs, and the bulk data on different devices
so one cannot starve the others. A dedicated WAL volume is the single best database
storage decision.

**Less logging.** Drop to `info`, sample `debug`, and make logging asynchronous.
You usually discover you never read 90% of what was costing you the disk.

If you run a fleet, wire the alert to the symptom you can act on rather than the
raw number — the discipline from
[monitoring a small fleet](/posts/monitoring-a-small-fleet/) applies directly here.

## Latency is p99, not the mean

The single most important limitation of `iostat`: every `await` it prints is a
**mean**. iostat has no percentile output. And means hide tails. A device with a
2 ms mean `await` can still deliver 200 ms to 1% of requests, because those requests
landed behind a flush or a burst. That 1% is what users feel: it is your p99, and it
is invisible to `iostat`.

Two more traps in the same family. First, mean `await` includes queue time, so two
devices with identical means can have very different tails — one is consistently
2 ms, the other alternates 0.2 ms and 400 ms. Second, averaging over a long interval
washes out short stalls entirely.

Get the distribution instead. `biolatency` (eBPF) prints a histogram of block I/O
latency, and it works on the actual device, not the mean:

```console
$ biolatency -m 1        # latency histogram in ms, refreshed every 1s
```

Once you can see the shape, "the disk is slow" becomes a statement you can act on:
flat histogram means a steady service time; a long right tail means queueing or
flush stalls; a bimodal histogram usually means two different workloads sharing one
device. Every one of those has a different fix, and none of them is visible in the
mean.

The through-line: **load average and iowait tell you a queue exists; `iostat` names
the device and splits read from write; `iotop` and `io.stat` name the process; the
latency histogram tells you whether it is a throughput ceiling or a tail stall.**
Measure the tail, fix the stage that is actually blocking, and stop tuning the CPU
that was never the problem.
