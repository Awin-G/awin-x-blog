---
title: "cgroups v2 in practice: how containers are actually limited"
description: "A hands-on tour of cgroups v2 on a real Docker host: why v2 unified the controllers, the filesystem layout, how --memory and --cpus map to memory.max and cpu.max, CPU throttling, memory accounting, OOM kills, memory.high vs memory.max, and using PSI to debug containers that die or crawl."
pubDate: 2026-12-20
lang: en
translationKey: cgroups-v2
tags: [linux, devops]
featured: false
keywords:
  - cgroups v2
  - container resource limits
  - memory.max
  - CPU throttling
  - OOMKilled
---

When a container gets killed at 3 a.m. with `OOMKilled` in `docker inspect`, or when a service that "has plenty of CPU" still takes 40 seconds to answer, the answer is almost always in **cgroups v2**. A cgroup is not a container feature — it is a kernel feature that groups processes and then meters and limits the resources that group may consume. Docker, systemd, Podman, and Kubernetes are all just writing numbers into cgroup files. Once you can read those files, **container resource limits** stop being magic.

Everything below is real output from real containers on this machine (Docker 29.9.0, kernel 7.2.9, cgroup v2 unified hierarchy, no `--privileged`). I created and destroyed the containers as I wrote this.

## What a cgroup actually is

A control group is three things bolted together:

- a **grouping** of processes, expressed as a directory in a pseudo-filesystem;
- a **meter** — counters such as `cpu.stat`, `memory.current`, `io.stat`;
- a **limit/controller** — files such as `cpu.max`, `memory.max`, `pids.max` that the kernel enforces when the group exceeds them.

Everything is files. There is no syscall to call and no daemon to ask: you `cat` and `echo`. That is the whole interface.

## Why v2 exists: one hierarchy instead of many

cgroup v1 mounted one separate hierarchy *per controller*: `/sys/fs/cgroup/memory/`, `/sys/fs/cgroup/cpu/`, `/sys/fs/cgroup/blkio/`, and so on. A process could be in one group under the memory controller and a completely different group under the CPU controller, because each controller had its own independent tree. That made the relationship between "this process's memory limit" and "this process's CPU limit" unrepresentable — tools had to guess, and the kernels grew special cases.

cgroup v2 replaces all of that with **a single unified hierarchy**. Every controller you enable applies to the same tree at the same place. A process lives at exactly one path, and its memory, CPU, IO, and pid limits are all files in the same directory.

The way a controller is switched on tells the story. Each cgroup has `cgroup.controllers` (what the parent makes available) and `cgroup.subtree_control` (what this level passes down to children):

```console
$ cat /sys/fs/cgroup/cgroup.controllers
cpuset cpu io memory hugetlb pids rdma misc dmem
$ cat /sys/fs/cgroup/cgroup.subtree_control
cpuset cpu io memory hugetlb pids rdma misc dmem
```

On a systemd host, systemd enables controllers as they are needed. My own login scope reports exactly which ones are active locally:

```console
$ cat /proc/self/cgroup
0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.kde.konsole-1523.scope/tab(1539).scope
$ cat /sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/cgroup.stat
nr_descendants 0
nr_subsys_cpu 1
nr_subsys_memory 1
nr_subsys_pids 1
```

## The controllers that matter

Four controllers cover almost every production incident:

| Controller | Files | What it does |
|---|---|---|
| `cpu` | `cpu.max`, `cpu.weight`, `cpu.stat` | hard cap (quota) and relative share; exposes throttling counters |
| `memory` | `memory.max`, `memory.high`, `memory.current`, `memory.stat`, `memory.events` | usage accounting, reclaim, OOM |
| `io` | `io.max`, `io.weight`, `io.stat` | per-device bandwidth/IOPS caps and shares |
| `pids` | `pids.max`, `pids.current` | fork-bomb protection |

There are more (`cpuset`, `hugetlb`, `rdma`, `misc`, and in this kernel `dmem`), but those four are what a container limit actually compiles down to.

## The v2 layout and the "no internal processes" rule

The tree is a set of directories, each with the same file names. A trimmed view of this host:

```console
$ find /sys/fs/cgroup -maxdepth 2 -type d | head
/sys/fs/cgroup
/sys/fs/cgroup/system.slice
/sys/fs/cgroup/system.slice/docker.service
/sys/fs/cgroup/user.slice
/sys/fs/cgroup/user.slice/user-1000.slice
/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service
```

Here is the rule people trip over: in v2 **a cgroup may not contain both processes and child cgroups**. That is `cgroup.type = domain` vs `domain threaded` and the `cgroup.procs` check. If you create `/sys/fs/cgroup/foo/bar`, then `foo` must be empty of processes before the kernel lets the child exist. This is why systemd mounts services as leaves: a service that also wants per-worker subgroups has to move its processes down into a leaf called e.g. `service/workers` first.

```
                          /
                    (root, no procs once delegated)
                          |
        +-----------------+------------------+
        |                                    |
   system.slice                          user.slice
        |                                    |
  docker.service                    user-1000.slice
        |                                    |
  docker-<id>.scope                 user@1000.service
  cpu.max  memory.max  pids.max          app.slice
  cpu.stat memory.current                    |
                                       container / scope leaves
```

<figure>
  <svg viewBox="0 0 760 400" role="img" aria-label="cgroup v2 unified hierarchy with a Docker container slice" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto">
    <defs>
      <marker id="arr" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
        <path d="M0,0 L9,4.5 L0,9 Z" fill="currentColor" opacity="0.55"/>
      </marker>
    </defs>
    <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13" fill="currentColor">
      <rect x="300" y="16" width="160" height="40" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.7"/>
      <text x="380" y="41" text-anchor="middle">/ (unified)</text>

      <path d="M380,56 V84" stroke="currentColor" stroke-opacity="0.5" fill="none" marker-end="url(#arr)"/>

      <rect x="150" y="92" width="180" height="40" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.7"/>
      <text x="240" y="117" text-anchor="middle">system.slice</text>

      <rect x="430" y="92" width="180" height="40" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.7"/>
      <text x="520" y="117" text-anchor="middle">user.slice</text>

      <path d="M240,132 V160" stroke="currentColor" stroke-opacity="0.5" fill="none" marker-end="url(#arr)"/>
      <path d="M520,132 V160" stroke="currentColor" stroke-opacity="0.5" fill="none" marker-end="url(#arr)"/>

      <rect x="150" y="168" width="180" height="40" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.7"/>
      <text x="240" y="193" text-anchor="middle">docker.service</text>

      <rect x="430" y="168" width="180" height="40" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.7"/>
      <text x="520" y="193" text-anchor="middle">user@1000.service</text>

      <path d="M240,208 V236" stroke="currentColor" stroke-opacity="0.5" fill="none" marker-end="url(#arr)"/>

      <rect x="120" y="244" width="240" height="128" rx="10" fill="#0f766e" fill-opacity="0.08" stroke="#0f766e" stroke-width="1.6"/>
      <text x="240" y="268" text-anchor="middle" fill="#0f766e">docker-&lt;cid&gt;.scope</text>
      <text x="240" y="292" text-anchor="middle" font-size="11.5" fill="#0f766e">cpu.max      50000 100000</text>
      <text x="240" y="312" text-anchor="middle" font-size="11.5" fill="#0f766e">memory.max   134217728</text>
      <text x="240" y="332" text-anchor="middle" font-size="11.5" fill="#0f766e">pids.max     64</text>
      <text x="240" y="352" text-anchor="middle" font-size="11.5" fill="#0f766e">cgroup.procs 1</text>

      <path d="M430,208 V320 H362" stroke="currentColor" stroke-opacity="0.5" fill="none" marker-end="url(#arr)"/>
      <text x="470" y="252" font-size="11.5" opacity="0.8">subtree_control</text>
      <text x="470" y="270" font-size="11.5" opacity="0.8">enables cpu, memory,</text>
      <text x="470" y="288" font-size="11.5" opacity="0.8">pids for children</text>
    </g>
  </svg>
  <figcaption>One hierarchy, one path per process. A container is a single leaf scope holding the same controller files every other group has.</figcaption>
</figure>

## How Docker maps `--memory` and `--cpus` to cgroup files

Start a container the way you normally would, then look at what Docker actually wrote. The container's host cgroup is `/sys/fs/cgroup/system.slice/docker-<id>.scope`:

```console
$ docker run -d --name cg-demo --memory=128m --cpus=0.5 --pids-limit=64 alpine sleep 600
$ docker inspect cg-demo | grep -E 'Memory|NanoCpus|PidsLimit'
            "Memory": 134217728,
            "NanoCpus": 500000000,
            "PidsLimit": 64,
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/cpu.max
50000 100000
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/memory.max
134217728
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/pids.max
64
```

So `--memory=128m` is `memory.max=134217728` bytes (128 MiB, not 128 MB). `--cpus=0.5` is `cpu.max = "50000 100000"`: a quota of 50000 microseconds allowed every 100000-microsecond period, i.e. half a core. `--pids-limit=64` is `pids.max=64`. `--cpus=2.5` becomes `250000 100000`. Inside the container, thanks to the cgroup namespace, the same files appear as its own root:

```console
$ docker exec cg-demo cat /proc/self/cgroup
0::/
$ docker exec cg-demo cat /sys/fs/cgroup/memory.max
134217728
$ docker exec cg-demo cat /sys/fs/cgroup/memory.current
3215360
$ docker exec cg-demo cat /sys/fs/cgroup/cgroup.procs
1
```

## CPU shares vs quota vs weights

These are two different mechanisms and mixing them up is the classic mistake. `cpu.max` is a **hard ceiling**: over the period, the group simply does not get more CPU. `cpu.weight` (v1 called it `cpu.shares`) is a **relative share** that only matters when a parent is saturated — it decides who wins the contention, not the top speed.

Docker's `--cpu-shares` maps into `cpu.weight`, and the values are not the numbers you typed:

```console
$ # --cpu-shares=X  ->  cpu.weight
$ #  512  -> 59
$ # 1024  -> 100      (default)
$ # 4096  -> 303
```

The kernel converts each raw share with `weight = 1 + ((shares - 2) * 9999) / 262142`, so 1024 lands on exactly 100. If you never set shares, every container gets weight 100 and they split contended CPU equally — which is why "it's slow when the neighbour is busy" is a shares question, while "it can never exceed 0.5 core" is a quota question. See the last section for how to tell which one is biting.

## Memory accounting, OOM, and `memory.high` vs `memory.max`

Memory is where containers actually die. Docker maps `--memory` to `memory.max`; the kernel counts everything charged to the group (anonymous pages, page cache, kernel structures) in `memory.current` and `memory.stat`:

```console
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/memory.stat
anon 53248
file 1372160
kernel 380928
file_mapped 937984
slab 289376
```

Two ceiling files exist, and the difference is the whole point:

- **`memory.high` is a soft ceiling.** Cross it and the kernel throttles the group and reclaims harder, but it does not kill anything. It is the right knob for "keep this service small" without turning a spike into a crash.
- **`memory.max` is the hard ceiling.** When reclaim cannot get the group back under `memory.max`, the OOM killer fires.

A user-delegated scope makes the soft/hard pair visible at once (`systemd-run --user -p MemoryHigh=64M -p MemoryMax=128M`):

```console
$ cat <scope>/memory.high     ->  67108864
$ cat <scope>/memory.max      ->  134217728
$ cat <scope>/memory.events   ->  high 177   max 0   oom 0   oom_kill 0
$ cat <scope>/memory.swap.current -> 120233984
```

A process allocating past 64 MiB was throttled, its anonymous pages were pushed to swap (114 MiB of swap in use) and `memory.current` hovered right at `memory.high` — but `max 0, oom_kill 0`: nothing died. That is **container resource limits** working as a pressure valve rather than a guillotine.

Now remove the safety net. A container with only `--memory=64m` that allocates unconditionally:

```console
$ docker run -d --name cg-oom --memory=64m python:3.12-alpine \
    python3 -c "a=[]; [a.append(bytearray(4*1024*1024)) for _ in iter(int,1)]"
$ docker events --filter container=cg-oom --format '{{.Action}}' | sort -u
create
die
oom
start
$ docker wait cg-oom
137
$ docker inspect cg-oom --format 'OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}}'
OOMKilled=true ExitCode=137
```

Exit code 137 is 128 + 9 (SIGKILL) and `OOMKilled=true` is Docker's verdict. The kernel-side record lives in `memory.events` on the cgroup, and it survives even when only a *child* process was killed and the container itself kept running:

```console
$ docker exec cg-mem cat /sys/fs/cgroup/memory.events
low 0
high 0
max 919
oom 1
oom_kill 1
oom_group_kill 0
$ docker exec cg-mem cat /sys/fs/cgroup/memory.peak
69525504
```

`max 919` means the group hit its limit almost a thousand times on the way down; `oom 1` / `oom_kill 1` is the actual kill. `memory.peak` shows it topped out at ~66 MiB. If you want the whole cgroup killed together rather than one unlucky process, that is `memory.oom.group` — Docker sets it for you.

## PSI: the modern pressure signal

`cpu.stat` and `memory.current` tell you *what a group used*. They do not tell you whether it was *starved*. For that, v2 ships Pressure Stall Information: how much wall-clock time tasks were stalled waiting for a resource.

```console
$ cat /proc/pressure/cpu
some avg10=35.80 avg60=29.25 avg300=14.95 total=641150672
$ cat /proc/pressure/memory
some avg10=1.47 avg60=1.77 avg300=0.96 total=57989785
```

`some` is "at least one task stalled"; `full` (present for memory and io) is "every task stalled". The same numbers exist per cgroup, which is how you point at one container instead of the whole box:

```console
$ docker exec cg-mem cat /sys/fs/cgroup/memory.pressure
some avg10=0.40 avg60=0.14 avg300=0.03 total=107658
full avg10=0.40 avg60=0.14 avg300=0.03 total=107658
$ docker exec cg-mem cat /sys/fs/cgroup/io.pressure
some avg10=0.72 avg60=0.13 avg300=0.02 total=93314
```

A rising `full` on `memory.pressure` is the early warning that `memory.max` is about to be a problem. `io.pressure` spiking while `io.stat` bytes stay low means the container is queuing behind disk, not writing.

## Debugging throttled and OOM-killed containers

**CPU throttling** is invisible in `top` and obvious in `cpu.stat`. Run one busy loop at `--cpus=0.5` and watch the counters:

```console
$ docker run -d --name cg-cpu --cpus=0.5 alpine sh -c 'while :; do :; done'
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/cpu.max
50000 100000
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/cpu.stat
usage_usec 6110614
nr_periods 123
nr_throttled 120
throttled_usec 5814808
```

`nr_throttled 120` out of `nr_periods 123` — the group was throttled in 98% of its periods, and it burned 5.8 seconds of its 12-second life waiting. Notice `usage_usec` is 6.1 s: it used exactly the half-core it was allowed, so this is not a slow CPU problem, it is a quota problem. `docker stats` agrees the ceiling is real:

```console
$ docker stats --no-stream cg-cpu
NAME      CPU %     MEM USAGE / LIMIT   MEM %   PIDS
cg-cpu    49.54%    416KiB / 11.56GiB   0.00%   1
```

49.54% is the 50% quota, pinned. The diagnostic recipe falls out directly from the files:

1. **Killed with 137 / `OOMKilled=true`?** Read `memory.events` → `oom_kill`. Raise `--memory`, or set `memory.high` just below `memory.max` so a burst reclaims and swaps instead of dying.
2. **Slow but idle CPU?** Read `cpu.stat` → if `nr_throttled` tracks `nr_periods`, raise `--cpus` (quota). If instead `nr_throttled` is low but latency is bad and `cpu.pressure` is high, it is contention — raise `--cpu-shares` (weight).
3. **Erratic latency, low throughput?** Read `memory.pressure` and `io.pressure`. PSI `full` climbing is your signal.
4. **Fork bomb / "resource temporarily unavailable"?** `pids.current` vs `pids.max`.

That is the entire job: group a process, meter it, set a ceiling, and read the files when the ceiling bites. If you want the network side of the same container model, [Docker networking](/posts/docker-networking/) is the companion piece; and once you are reading kernel-side files, it is worth tightening the rest of the sandbox with [container security](/posts/container-security/).

## The one-paragraph summary

cgroups v2 is a single unified filesystem tree. A container is one leaf cgroup whose files — `cpu.max`, `cpu.weight`, `memory.max`, `memory.high`, `pids.max`, `io.max` — are exactly what `--cpus`, `--cpu-shares`, `--memory`, `--pids-limit`, and `--blkio-weight` write. Quota is a hard ceiling, weight is a share of contention; `memory.max` kills, `memory.high` throttles; `cpu.stat` and `memory.events` record what happened, and PSI `/proc/pressure` records how much it hurt. Read those files and you never have to guess why a container died.
