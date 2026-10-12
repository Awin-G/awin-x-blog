---
title: "Reading Linux load average, and why it lies to you"
description: "Linux load average counts runnable and uninterruptible tasks, not CPU usage. Here is what the 1/5/15-minute numbers really measure, why I/O wait and D-state processes inflate them, why per-core normalisation matters, how container CPU quotas break the old rules, and what to run instead — vmstat, mpstat, PSI and iostat."
pubDate: 2026-11-14
lang: en
translationKey: linux-load-average
tags: [linux, devops]
featured: false
keywords:
  - Linux load average
  - why is load high
  - iowait
  - vmstat
  - pressure stall information
---

Every time someone pings me "the server is slow, load is 40, we're dying," I open a
shell and the first thing I type is not `top`. I type `vmstat`. Because the single
most misread number in operations is the **Linux load average**, and it lands in
the exact same mental bucket as "CPU busy." They are not the same thing, and the
gap between them is where a lot of bad decisions get made at 3 a.m.

This is the short, honest version: what load actually counts, why it goes up
without the CPU doing anything, why you must divide by core count before you panic,
why containers quietly broke the rule, and what I look at instead.

## What Linux load average actually is

The three numbers from `uptime` are **exponential moving averages of the runnable
and uninterruptible task count**. Not a percentage. Not a rate. A count of tasks
that were either runnable (wanting CPU) or stuck in uninterruptible sleep
(`D` state, typically blocked on I/O) at each sample.

```console
$ uptime
 03:14:07 up 41 days,  2:13,  3 users,  load average: 6.28, 4.91, 3.02

$ cat /proc/loadavg
6.28 4.91 3.02 3/812 40219
```

The first three fields are the 1-, 5- and 15-minute averages. The `3/812` means
three tasks are currently runnable out of 812 total, and `40219` is the last PID
handed out. The kernel samples this every five seconds (it used to be on every
tick), and folds each sample into three EWMA series with different time constants.
That is the whole mechanism: a low-pass filter over a task count.

Two things fall out of that definition and matter enormously. First, it is a
**count**, so its meaning depends on how many CPUs you have. Second, it includes
tasks that are not using CPU at all. Both are covered below.

## Why it is not CPU%: iowait and D-state processes

Here is the thing that trips everyone: a task blocked reading a slow disk is
counted as load. If MySQL is waiting on a failing SSD, or a backup is hammering a
spinning disk, those threads sit in `D` state — uninterruptible sleep, unkillable
until the I/O returns — and each one increments load. The CPU is idle the entire
time. Load climbs; **iowait** climbs; nothing is actually computing.

This is why "load high, CPU idle" is one of the most common and most misread
patterns in Linux. High **iowait** means you have a storage problem masquerading as
a CPU problem. `top` will show you the `%wa` field, and it is worth knowing that
`%wa` itself is measured oddly (a CPU ticking in idle-wait), but the signal is
real: the scheduler has runnable work but the storage layer will not complete.

```console
$ vmstat 1 5
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 0  6      0 812304  91024 2401888    0    0  3120  9408  512  980  3  1 12 84  0
 1  5      0 808920  91024 2401000    0    0  4088  8752  488  940  4  1 10 85  0
```

Read that `b` column: 5-6 tasks blocked in `D` state, and `wa` (iowait) around 84%.
`r` is near zero — nothing wants the CPU. Load average here will be pinned high by
the blocked tasks, but this box is not CPU-bound. It is disk-bound. Chase the disk,
not the CPU.

## Per-core normalisation

Load is a count of tasks; CPUs are a count of workers. The number that carries
information is the ratio. On a 4-core box, a load of 8 means two tasks per core
queued — genuinely saturated. On a 64-core box, a load of 8 means most cores are
idle. The same absolute number is a crisis on one machine and a quiet afternoon on
the other.

The heuristic I use: **divide load by the number of logical cores.** Below ~0.7,
relaxed. Around 1.0, fully occupied but keeping up. Above 1.0 sustained, a queue is
forming and latency is climbing. Well above the core count, you have a real
problem — but read the "which problem" section below before you act, because it
might be `D` state, not CPU.

```console
$ nproc
8
$ uptime | awk -F'load average:' '{print $2}'
 6.28, 4.91, 3.02
# 6.28 / 8 ≈ 0.79 per core — busy, not drowning
```

## Why load average misleads on modern systems

The formula has not changed in decades. The systems it runs on have.

**Many cores.** A 128-core box can absorb a load of 100 without anyone noticing.
The classic "load should stay under the CPU count" advisory was written when 4
cores was a lot.

**cgroup and container quotas.** This is the big one. Inside a container limited to
2 CPUs via `cpu.max`, Linux load average — read from `/proc/loadavg` — reflects
the **host**, not your cgroup. Your container can be at load 0.4 while the host
sits at 60, and vice versa: your container can be throttled to a crawl while the
host load looks calm. CPU quota throttling lives in
`cpu.stat` (`nr_throttled`, `throttled_usec`), not in load average. If you run
Kubernetes with CPU limits, this is the number that matters and load will never
show it.

```console
$ cat /sys/fs/cgroup/cpu.max          # cgroup v2, container limit
200000 100000                          # 2 CPUs per 100ms period

$ grep throttled /sys/fs/cgroup/cpu.stat
nr_throttled 10482
throttled_usec 8120344112              # ~2.25 CPU-hours stolen by the quota
```

**D-state inflation, revisited.** On a fleet of containers sharing one noisy
storage backend, every container's load can be inflated by the same disk. You get
a fleet-wide "high load" alert that points at 40 pods, all of them victims of one
`iowait` source.

## What to look at instead

Load average is a symptom with no specificity. Reach for tools that name the
resource:

- **`vmstat 1`** — the columns that matter are `r` (run queue), `b` (blocked/D),
  `wa` (iowait), `si`/`so` (swap). It separates "CPU wants" from "I/O blocks" in one
  line.
- **`mpstat -P ALL 1`** — per-core, to catch a single hot CPU while the average
  looks fine.
- **`iostat -xz 1`** — `%util` and `await` on the device, which is where the `b`
  column came from.
- **`/proc/pressure`** — **pressure stall information** (PSI), the honest modern
  answer. It reports the fraction of wall-clock time some/all tasks were stalled on
  CPU, memory or I/O — the closest thing to "how much is this hurting me."

```console
$ cat /proc/pressure/io
some avg10=41.20 avg60=38.90 avg300=12.30 total=981230112
full avg10=22.10 avg60=19.80 avg300=6.05 total=502113900
```

`some` means at least one task was stalled on I/O; `full` means *every* runnable
task was. A `full` of 20%+ is a machine where work is genuinely waiting on the
disk. That is far more actionable than a load of 40.

Pair this with the fleet habits from
[monitoring a small fleet](/posts/monitoring-a-small-fleet/) — alert on the
symptom you can act on, not the count you cannot.

## A short worked example

A box reports load 40 on 8 cores. Panic says "five times over capacity." The
diagnosis takes three commands.

```console
$ uptime
 09:02:11 up 12 days,  load average: 40.10, 33.80, 12.05
$ vmstat 1 3
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 0 37      0 120400  40120  980000    0    0 12040 14000  600 1200  2  1  5 92  0
 0 38      0 118900  40120  979000    0    0 11800 13900  580 1180  2  1  4 93  0
$ cat /proc/pressure/io
some avg10=55.10 avg60=48.20 avg300=15.00 total=482112309
full avg10=39.90 avg60=33.40 avg300=10.00 total=210044100
```

`b` is 37, `r` is 0, `wa` is 92%. Nearly all the "load" is 37 tasks stuck in `D`
state on I/O, and PSI confirms half the machine's wall-clock is stalled on the same
disk. The fix is storage — a degraded disk, a runaway writer, or a saturated
backing volume — not CPU. If you had "fixed" this by adding CPU or shrinking the
container, you would have made it worse. The same discipline shows up in
[debugging TCP on embedded systems](/posts/debugging-tcp-on-embedded/): measure the
layer that is actually blocking before you tune the layer you can see.

## "Load is 40, is it bad?" — three quick reads

The number alone is useless; the context makes it a decision. Three concrete cases:

**Load 40 on 64 cores, 100% CPU, `r` around 40, PSI cpu `some` 60%.** This is real
CPU saturation. The run queue is long and full, not blocked. Scale out, find the
hot loop, or accept the latency — but this is genuinely a CPU problem.

**Load 40 on 64 cores, CPU 10% used, `b` around 38, PSI io `full` 35%.** Not a CPU
problem at all. You have ~38 tasks blocked on a slow disk. Fix the storage path;
more CPU does nothing.

**Load 40 on a 2-core container, host load 55, `cpu.stat` shows heavy throttling.**
The container is being starved by its quota, not by the CPU. Load here is a host
artefact; the number you raise a ticket about is `nr_throttled`.

**Load 40 on 8 cores, CPU 90%, `r` 8, falling 1-minute average.** A burst that is
already resolving. Wait. Not every spike needs a runbook.

The common thread: **load average tells you something is queueing, never what.**
The first question is always "queueing on the CPU, or on I/O, or on a quota?" Only
`vmstat`, PSI and a per-core view separate those, and only then does "40" mean
anything at all.
