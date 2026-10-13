---
title: "CPU scheduling in practice: nice/renice, CPU affinity, taskset — and why one core is pegged"
description: "A hands-on tour of Linux CPU scheduling on an 8-core box: how CFS shares a core by weight, why nice/renice only bites under load, when CPU affinity and taskset help vs hurt, the SCHED_FIFO danger, how docker --cpus throttles via cpu.max, and how to spot a pegged core with mpstat -P ALL and pidstat."
pubDate: 2027-01-14
lang: en
translationKey: cpu-scheduling-and-affinity
tags: [linux, devops]
featured: false
keywords:
  - CPU scheduling
  - nice renice
  - CPU affinity
  - taskset
  - run queue
  - cgroup cpu.weight
  - SCHED_FIFO
---

When a service that should be idle has one core at 100% while `top` still shows the box comfortable, or a job you `renice`d refuses to get out of the way, you are seeing how Linux **CPU scheduling** really shares cores — not what the man-page adjectives promise. Everything below is real output from my 8-core machine (kernel 7.2.9, cgroup v2 unified, Docker 29.9.0, one NUMA node). No root: just `nice`/`renice`, `taskset`, `chrt`, `vmstat`, `/proc`, and `docker --cpus`. Worth memorizing up front: **nice is a weight that only bites under contention**, **CPU affinity decides *where* a task runs and is a foot-gun in the wrong hands**, and **`--cpus` is a hard quota that will happily pin a 4-thread job to one core**. Mix those three up and you get the single pegged core people page me about.

## CFS in one page: weights, vruntime, and cpu.weight

Linux schedules ordinary threads with the **Completely Fair Scheduler (CFS)**. Not fixed slices — a fair *share of contention*, weighted by a per-process `weight` (derived from nice) or, for groups, `cpu.weight`. Each runnable task accrues virtual runtime (`vruntime`); the scheduler runs whichever task has the **smallest vruntime**, and vruntime advances by `wall_time * (1024 / weight)`, so a heavier task burns it slowly and gets more CPU per unit of it. Two facts drive the rest: CFS only divides *contended* cores (free cores mean nothing to divide), and the weight knobs are `nice` per-process and `cpu.weight` per-group — the same idea at container scale, which my [cgroups v2](/posts/cgroups-v2/) post covers in depth.

<figure>
  <svg viewBox="0 0 760 300" role="img" aria-label="CFS splits one contended core by weight, while taskset affinity decides which cores a task may run on" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto">
    <defs>
      <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
        <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" opacity="0.55"/>
      </marker>
    </defs>
    <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12.5" fill="currentColor">
      <text x="28" y="24" font-size="13.5">CFS: a contended core is split by weight</text>
      <text x="404" y="24" font-size="13.5">Affinity (taskset): which cores it may use</text>
      <line x1="388" y1="12" x2="388" y2="272" stroke="currentColor" stroke-opacity="0.22"/>

      <text x="28" y="50" font-size="11.5" opacity="0.85">core 0, one fixed window (Experiment B):</text>
      <rect x="28" y="58" width="277" height="26" rx="6" fill="#0f766e" fill-opacity="0.55"/>
      <rect x="305" y="58" width="59" height="26" rx="6" fill="#0f766e" fill-opacity="0.2" stroke="#0f766e"/>
      <text x="38" y="75" fill="currentColor">task A · nice 5 · weight 291 · ~82%</text>
      <path d="M186,104 L330,70" stroke="currentColor" stroke-opacity="0.4" marker-end="url(#arr)"/>
      <text x="28" y="108" font-size="11.5" opacity="0.85">task B · nice 19 · weight 15 · ~14%</text>
      <text x="28" y="140" font-size="11" opacity="0.72">Split by weight, so B is starved under load — but not to zero.</text>

      <text x="404" y="50" font-size="11.5" opacity="0.85">four 1-core spinners:</text>
      <rect x="404" y="60" width="34" height="26" rx="5" fill="#0f766e" fill-opacity="0.5"/><text x="418" y="77" text-anchor="middle" font-size="11">T</text>
      <rect x="444" y="60" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
      <rect x="484" y="60" width="34" height="26" rx="5" fill="#0f766e" fill-opacity="0.5"/><text x="498" y="77" text-anchor="middle" font-size="11">T</text>
      <rect x="524" y="60" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
      <rect x="564" y="60" width="34" height="26" rx="5" fill="#0f766e" fill-opacity="0.5"/><text x="578" y="77" text-anchor="middle" font-size="11">T</text>
      <rect x="604" y="60" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
      <rect x="644" y="60" width="34" height="26" rx="5" fill="#0f766e" fill-opacity="0.5"/><text x="658" y="77" text-anchor="middle" font-size="11">T</text>
      <rect x="684" y="60" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
      <text x="404" y="98" font-size="11" opacity="0.7">0<tspan dx="2">…</tspan><tspan dx="2">7</tspan></text>
      <text x="404" y="118" font-size="11.5" opacity="0.85">unpinned → scheduler spreads them → ~1.9s each</text>

      <text x="404" y="146" font-size="11.5" opacity="0.85">taskset -c 0 → all four packed onto core 0:</text>
      <rect x="404" y="152" width="34" height="26" rx="5" fill="#0f766e" fill-opacity="0.85"/><text x="421" y="169" text-anchor="middle" font-size="11" fill="currentColor">4×</text>
      <rect x="444" y="152" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
      <rect x="484" y="152" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
      <rect x="524" y="152" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
      <rect x="564" y="152" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
      <rect x="604" y="152" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
      <rect x="644" y="152" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
      <rect x="684" y="152" width="34" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
      <text x="404" y="200" font-size="11.5" opacity="0.85">1 core, four times the work → ~6.2s each (serialized)</text>
      <text x="404" y="230" font-size="11" opacity="0.72">Affinity decides WHERE a task may run — not its weight, not its limit.</text>
    </g>
  </svg>
  <figcaption>Left: two runnable tasks on one contended core divide it by CFS weight (nice 5 vs nice 19) — a big slice and a sliver, from Experiment B. Right: the same four spinners unpinned (spread across cores, fast) versus pinned by <code>taskset -c 0</code> (all on one core, serialized) — Experiment C. <code>currentColor</code> lets the diagram follow light/dark theme; <code>#0f766e</code> is the accent.</figcaption>
</figure>

## nice and renice: a relative weight that disappoints

`nice` sets a process's weight and `renice` changes it live. Each nice step multiplies weight by 1.25, so **nice 0 = weight 1024 and nice +19 = weight 15** — a ~68× gap. People read that and expect +19 to nearly stop a task. Two experiments say otherwise.

**1. Idle cores make nice a no-op.** With free cores, CFS has nothing to divide, so weight is ignored:

```console
$ ./burn time 3 victim2 & vp=$! ; renice +19 -p $vp ; wait      # lone task on idle cores
   old priority 5, new priority 19
TIME  victim2  window= 3.00s  cpu_used= 2.987s   # got a whole core anyway
```

A nice +19 lone task burned **2.987s of CPU in a 3s window** — a whole core. Renice changed nothing; no other task wanted it.

**2. Under contention it bites, but coarsely.** This host runs each process I launch at **nice 5** by default (a polite wrapper), so the honest comparison is nice 5 against a job I actively `renice`d down. Sixteen busy loops saturate eight cores; a victim runs a fixed 3s window and reports the CPU-seconds it was actually granted:

```console
$ for i in $(seq 1 16); do ./burn time 8 load & done     # 16 tasks > 8 cores
$ ./burn time 3 victim-default                            # victim at default nice 5
TIME  victim-default  window= 3.00s  cpu_used= 2.473s
$ ./burn time 3 victim2 & vp=$! ; renice +19 -p $vp       # same victim, reniced to +19
   old priority 5, new priority 19
TIME  victim-reniced  window= 3.09s  cpu_used= 0.412s
```

Renicing to +19 cut the victim from **2.47s to 0.41s** of CPU — about 6× less, a real effect. But it is *not* the ~68× the weight table implies, and *not* zero: CFS still hands the low-weight task a slice, and its tiny vruntime keeps it eligible the instant a core frees. So `nice` is the right tool for *nudging* a batch job behind an interactive one and the wrong one as a CPU limit. Raising priority needs `CAP_SYS_NICE` — `nice -n -5` fails with `Permission denied` — so the rest of us can only move a task *down*.

## CPU affinity: taskset and sched_setaffinity, help vs hurt

Affinity is a mask of the CPUs a task **may** run on; `taskset` is the shell front-end to the `sched_setaffinity(2)` syscall. Unlike nice, it does not change *how much* CPU a task gets — only *which cores* are in play. That makes it more dangerous than nice, because used wrongly it genuinely wrecks throughput. Same workload, pinned vs unpinned, two shapes:

```console
$ for i in 1 2 3 4; do ./burn work 600000000 C1 & done; wait            # unpinned
WORK  C1-unpinned-2  wall= 1.811s  cpu= 1.802s  ncpu=8 cpus={0,1,2,3,4,5,6,7,}
$ for i in 1 2 3 4; do taskset -c 0 ./burn work 600000000 C2 & done; wait   # all on core 0
WORK  C2-core0-4     wall= 6.157s  cpu= 1.533s  ncpu=1 cpus={0,}
```

Unpinned they run concurrently and each finishes in **~1.8s**; pinned to a single core they timeshare it and each takes **~6.2s** — 3.4× slower, while per-process `cpu` barely moves (`~1.5s`). **Pinning a parallel job to one core serializes it.** Now the same for a single task:

```console
$ ./burn work 600000000 D1                 # unpinned
WORK  D1-unpinned  wall= 1.511s  cpu= 1.505s  ncpu=8 cpus={0,1,2,3,4,5,6,7,}
$ taskset -c 2 ./burn work 600000000 D2
WORK  D2-core2     wall= 1.504s  cpu= 1.502s  ncpu=1 cpus={2,}
```

Essentially no difference — the myth to retire: **pinning a single-threaded task does not speed it up.** Linux already wants to keep a lone runnable task on a warm core; you have only removed the scheduler's freedom. Affinity *helps* structurally: **isolating** a latency-sensitive process on a dedicated core (cpuset/`taskset`) away from a noisy batch load; **locality** for a hot multi-threaded worker, keeping its threads within one core/cluster so L1/L2 and memory stay local; and keeping IRQs and RT threads off cores you care about. It *hurts* when it over-constrains — pinning parallel work to too few cores kills load-balancing. Default: let CFS balance, and pin only with a measured reason.

## Real-time policies: SCHED_FIFO / SCHED_RR and the danger

`SCHED_FIFO` and `SCHED_RR` run ahead of all CFS work, with priorities 1–99; higher preempts lower immediately. Not a faster CFS but a different regime; a runaway one is a foot-gun aimed at the whole machine. Setting them needs privilege I do not have, so the honest demonstration is the permission boundary and the one knob that limits damage:

```console
$ chrt -f 10 ./burn work 200000000           # raise an ordinary task to SCHED_FIFO prio 10
chrt: failed to set pid 0's policy: Operation not permitted     # needs CAP_SYS_NICE
$ chrt -p 1
pid 1's current scheduling policy: SCHED_OTHER
pid 1's current scheduling priority: 0
$ cat /proc/sys/kernel/sched_rt_runtime_us /proc/sys/kernel/sched_rt_period_us
1000000
1000000
```

That `EPERM` is defence one — no RT priority by accident. Defence two is the RT throttle: `sched_rt_runtime_us` over an `sched_rt_period_us` window. Its default `950000/1000000` lets normal tasks keep 5% of the CPU no matter what an RT busy-loop does. **This box is set to `1000000/1000000` — RT throttling is effectively off**, so a high-priority `SCHED_FIFO` busy-loop could legitimately wedge it here. Real-time is for audio deadlines (JACK), `DPDK`, and kernel threads like `migration/0` and `ksoftirqd` — never application logic you merely want to "go fast."

## How --cpus throttles: cgroup cpu.weight vs cpu.max

Containers cap CPU through cgroup v2, and the two files behave completely differently. **`cpu.max`** is `quota period`, a **hard cap**: `100000 100000` means "1.0 CPU per 100ms period," `docker run --cpus=N` writes it, and exceeding it **force-deschedules the whole group** until the next period. **`cpu.weight`** is **relative** (default 100) — the group-scale twin of nice, which only matters when the parent's cores are contended and does nothing on free cores. I ran four busy processes that *want* four CPUs inside a container, then read the container's `cpu.stat` from the host over a 4s window:

```console
# docker run -d --cpus=4 ... ; CG=/sys/fs/cgroup/system.slice/docker-<id>.scope
$ cat $CG/cpu.max ; sample cpu.stat for 4s
400000 100000
  effective CPUs: 3.99   nr_throttled +6  / +40 periods   # got the 4 it wanted, barely throttled
$ # same workload with --cpus=1
100000 100000
  effective CPUs: 1.01   nr_throttled +40 / +40 periods   # pinned to 1 CPU, throttled every period
$ # same workload with --cpus=0.5
50000 100000
  effective CPUs: 0.50   nr_throttled +41 / +41 periods   # half a CPU, throttled every period
```

Decisive: the workload never changed, only `cpu.max`. At `--cpus=1` real throughput pins to **1.01 CPU** and it is throttled in **40 of 40** periods — a forced stall every 100ms. A four-thread service with "plenty of RAM" that answers in hops is usually exactly this: quota-bound, not slow. Low `nr_throttled` with bad latency means contention instead — `cpu.weight` territory. The Docker-flag-to-file mapping is in the [cgroups v2](/posts/cgroups-v2/) post.

## NUMA, briefly

NUMA is why affinity exists at scale: on a multi-socket host, local memory is fast and remote memory slow, so you keep a task and its data on the same node (`numactl --cpunodebind/--membind`, plus affinity). On *this* box it is moot — `lscpu` reports one node (`NUMA node0 CPU: 0-7`) — which is exactly why the numbers above are about cores, not nodes. If cross-node access ever shows up in a profile, that is where affinity and memory placement get tuned together.

## Diagnosing a pegged core: mpstat -P ALL, the run queue, and pidstat

The reason "one core is pegged" stays invisible is that the aggregate hides it. One spinner pinned to core 3 on a box with a background tenant: the 8-core **average says 71% idle, yet core 3 is at 0% idle**:

```text
     CPU   %usr %nice  %sys %iowait  %irq %soft %steal %idle
     cpu   15.5  12.4   0.4   0.0   0.2   0.2   0.0  71.2
    cpu1   99.0   0.0   0.0   0.0   1.0   0.0   0.0   0.0
    cpu3    0.0  99.0   0.0   0.0   1.0   0.0   0.0   0.0
```

Two things fall out. First, **`mpstat -P ALL` is the tool, not `top`**: the per-core `%idle` surfaces the hot core that the `cpu` average eats (0% on core 3 vs 71% overall). Second, core 3 lands in **`%nice`** while the tenant's core 1 lands in **`%usr`** — same "100% busy," different column, purely because my host processes run at nice 5 and the container's at nice 0; on a nice-0 box the hog reads `~100% %usr`. (sysstat isn't installed here, so this is a `/proc/stat` reader printing mpstat's columns; `mpstat -P ALL 1` gives the same table directly.)

Then the **run queue** — `vmstat`'s `r` column — tells a *pegged core* from an *overloaded box*. One pinned task keeps `r` low; oversubscription pushes it past the core count:

```text
$ vmstat 1 2             # one spinner pinned to core 3 → run queue stays ~1
 r  b ... in     cs  us sy id
 2  0 ... 5976  4728  34  1 65
$ # 12 CPU-bound tasks on 8 cores:
13  0 ... 10933 4676  99  1  0     # r=13 > 8 cores → saturated
```

`r` at 1–2 with a core at 0% idle is a *single busy core* — a single-threaded or mis-pinned job. `r` climbing past `nproc` means genuinely saturated, more CPUs. `pidstat` then names the culprit and confirms it owns the core:

```console
$ ./pidstat.py 973244 1 2
     Time      PID    %CPU  Command
 07:55:55   973244  100.0  burn
```

That ties into [reading Linux load average](/posts/linux-load-average/): on an 8-core box, load 3.9 with `r ≈ 13` and one core at 0% idle is "high load, comfortable average, one core screaming." The recipe: `mpstat -P ALL 1` to find *which* core; `taskset -pc <pid>` to see if it's *pinned*; `chrt -p <pid>` for an RT policy; and the container's `cpu.max`/`cpu.stat` if it lives under a cap.

## What I actually reach for

1. **Relative share?** `renice +n` a batch job behind an interactive one — a nudge under load, nothing when cores are free.
2. **Hard cap?** `cpu.max` / `--cpus=N` — absolute, and it *will* throttle; watch `cpu.stat` `nr_throttled`.
3. **Isolation or locality?** pin with `taskset`/cpuset, but only a parallel job you measured slowing down unpinned (Experiment C) — never a lone task expecting a speedup.
4. **Reaching for `SCHED_FIFO`?** Only for audio or a dataplane thread on a box you own — and check `sched_rt_runtime_us` first.

One paragraph to keep: CFS divides *contended* cores by weight (`nice` per-process, `cpu.weight` per-group) — so nice is a nudge, not a limit, and idle cores defeat it; affinity masks *where* a task runs, good for latency isolation and memory locality, ruinous when it serializes parallel work; `SCHED_FIFO`/`RR` jump the queue and can wedge a box (especially here, with throttling off); `--cpus` is a hard `cpu.max` quota; and NUMA is the affinity story once you leave one socket. For a pegged core: `mpstat -P ALL` (the average lies), the `vmstat` run queue, then `pidstat` to name the process.
