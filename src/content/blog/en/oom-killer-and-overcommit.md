---
title: "Linux memory overcommit and the OOM killer: why your process died"
description: "What memory overcommit is, the three vm.overcommit_memory modes, Committed_AS vs CommitLimit, why the OOM killer picks the biggest RSS via oom_score, cgroup limits vs the global killer, swap's role, and how to read the evidence — all with real output from throwaway containers."
pubDate: 2027-01-11
lang: en
translationKey: oom-killer-and-overcommit
tags: [linux, devops]
featured: false
keywords:
  - OOM killer
  - memory overcommit
  - vm.overcommit_memory
  - oom_score
  - Committed_AS
  - memory.max
  - OOMKilled
---

It is 3 a.m., the alert is one line: `OOMKilled=true`. CPU was fine, the disk was fine, and the service died anyway. The reason is almost always the same two pieces of Linux behavior working as designed: **memory overcommit**, the deal that you may allocate more memory than exists, and the **OOM killer**, the reaper that fires when processes actually touch that memory. I tear both apart on a real machine — an Arch host with 12 GB of RAM, 12 GB of swap, and a shared Docker daemon — using throwaway containers so every line of output below is genuine, not decorative. If your first instinct is to check whether the box is also overloaded, the [load average](/posts/linux-load-average/) angle is worth a look too; here it is purely about RAM.

## What memory overcommit actually is

When a process calls `malloc(1 GB)`, the kernel hands out *virtual* address space and charges nothing against physical RAM; pages become real only when written. Because most programs allocate more than they touch, Linux lets the sum of all virtual allocations exceed RAM plus swap. That is **memory overcommit**, controlled by one sysctl, `vm.overcommit_memory`:

- `0` — heuristic (default): refuse only "obvious" overcommits, then hope for the best.
- `1` — always overcommit: never refuse an allocation.
- `2` — never overcommit: every allocation must fit inside **CommitLimit**, a hard accounting budget.

This host runs the default, mode 0, with the default ratio of 50:

```console
$ cat /proc/sys/vm/overcommit_memory /proc/sys/vm/overcommit_ratio
0
50
```

Mode 2 is where **Committed_AS** and **CommitLimit** become enforceable law, so let me show them before anything else.

## Committed_AS vs CommitLimit: the budget nobody watches

`/proc/meminfo` exposes the overcommit accounting directly. `CommitLimit` is the budget mode 2 would enforce: swap plus RAM times the ratio. `Committed_AS` is the kernel's current estimate of what every allocated-but-not-necessarily-touched mapping would need:

```console
$ grep -E 'MemTotal|MemAvailable|SwapTotal|Committed_AS|CommitLimit' /proc/meminfo
MemTotal:       12117272 kB
MemAvailable:    4579520 kB
SwapTotal:      12582904 kB
CommitLimit:    18641540 kB
Committed_AS:   18315056 kB
```

Check the math: `CommitLimit = SwapTotal + MemTotal × ratio/100 = 12582904 + 12117272 × 0.5 = 18641540 kB`. Committed_AS sits at 98.3% of that — and this shared host later drifted to 104%, then 125%. Under mode 0 that is legal: no allocation is refused, nobody panics. The number that predicts trouble is **MemAvailable** (4.5 GB here), which counts reclaimable page cache. Committed_AS is a canary, not a trigger — watch the trend, not single readings.

<figure>
  <svg viewBox="0 0 800 300" role="img" aria-label="Committed_AS at 98.3 percent of CommitLimit on this host, and the kernel picking the process with the highest oom_score when memory runs out" xmlns="http://www.w3.org/2000/svg">
    <text x="20" y="26" font-family="ui-monospace, monospace" font-size="13" fill="currentColor">Committed_AS vs CommitLimit — /proc/meminfo, this host (mode 0, ratio 50)</text>
    <rect x="20" y="44" width="370" height="30" fill="none" stroke="currentColor"/>
    <text x="398" y="64" font-family="ui-monospace, monospace" font-size="13" fill="currentColor">CommitLimit 18641540 kB</text>
    <rect x="20" y="88" width="363" height="30" fill="#0f766e"/>
    <text x="398" y="108" font-family="ui-monospace, monospace" font-size="13" fill="currentColor">Committed_AS 18315056 kB = 98.3%</text>
    <text x="440" y="26" font-family="ui-monospace, monospace" font-size="13" fill="currentColor">the OOM pick — highest oom_score wins</text>
    <rect x="440" y="44" width="330" height="34" fill="#0f766e"/>
    <text x="450" y="66" font-family="ui-monospace, monospace" font-size="13" fill="currentColor">baloo_file rss 1.4 GB score 842</text>
    <rect x="440" y="88" width="200" height="34" fill="none" stroke="currentColor"/>
    <text x="450" y="110" font-family="ui-monospace, monospace" font-size="13" fill="currentColor">firefox rss 786 MB score 840</text>
    <rect x="440" y="132" width="150" height="34" fill="none" stroke="currentColor"/>
    <text x="450" y="154" font-family="ui-monospace, monospace" font-size="13" fill="currentColor">opencode rss 708 MB score 826</text>
    <text x="440" y="204" font-family="ui-monospace, monospace" font-size="13" fill="currentColor">biggest RSS → highest score → killed first</text>
  </svg>
  <figcaption>This host idles at 98.3% of its CommitLimit and mode 0 says that is fine. When a cgroup runs dry, the kernel scores every task and kills the biggest: the KDE indexer baloo_file tops the table at 842.</figcaption>
</figure>

## cgroup limits fire before the global OOM killer

On any modern Linux, the OOM killer that reaches for your process is usually the **cgroup** one, not the global one. Every container gets a `memory.max`; when the cgroup's charges hit it and reclaim cannot free enough, the kernel kills something *inside that cgroup* — the host's other processes are untouched. Proof: a container capped at 512 MB and a Python hog that eats memory in 1 MiB chunks:

```console
$ docker run --name kill-lab --memory=512m --memory-swap=512m \
    -v /tmp/opencode/work/oom:/lab python:3-alpine python /lab/hog.py 900
allocated 448 MiB
allocated 480 MiB
EXIT_CODE=137
$ docker inspect -f 'Status={{.State.Status}} ExitCode={{.State.ExitCode}} OOMKilled={{.State.OOMKilled}}' kill-lab
Status=exited ExitCode=137 OOMKilled=true
```

Exit code 137 is 128 + SIGKILL, and `OOMKilled=true` is the flag every orchestrator keys on. The cgroup ledger shows what happened — `oom_kill 1`, and `memory.peak` pinned at exactly `memory.max`:

```console
$ cat /sys/fs/cgroup/system.slice/docker-<id>.scope/memory.events
low 0
high 0
max 38
oom 1
oom_kill 1
oom_group_kill 0
sock_throttled 0
$ cat .../memory.max .../memory.peak .../memory.swap.max
536870912
536870912
0
```

`memory.peak` (the high-water mark) equals the 512 MiB limit to the byte; `swap.max` is 0 because I disabled swap for this run. The mechanics of `memory.max` and friends is the subject of my [cgroups v2 write-up](/posts/cgroups-v2/); here the point is only this: **the cgroup OOM fires first, inside the group, before the global killer wakes up.** Two witnesses agree on the timing. Docker emits an event:

```console
$ docker events --filter event=oom --filter event=die
2026-10-13T06:15:30.048619721+08:00 container oom 9dcb8523fc48126a970af89a2b39ffbd136701b317bdb3022ae7f6bd4f071202 (image=python:3-alpine, name=kill-lab)
2026-10-13T06:15:30.251137436+08:00 container die 9dcb8523fc48126a970af89a2b39ffbd136701b317bdb3022ae7f6bd4f071202 (execDuration=0, exitCode=137, image=python:3-alpine, name=kill-lab)
```

And the kernel log, read with `journalctl -k`, shows the full autopsy — the killer entering through the page-fault path, usage at exactly the limit, and the chosen victim:

```console
$ journalctl -k --since "2026-10-13 06:15:29" --until "2026-10-13 06:15:31"
python invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=0
 memory: usage 524288kB, limit 524288kB, failcnt 23
 swap: usage 0kB, limit 0kB, failcnt 0
 oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=docker-9dcb8523….scope,mems_allowed=0,oom_memcg=/system.slice/docker-9dcb8523….scope,task_memcg=/system.slice/docker-9dcb8523….scope,task=python,pid=671666,uid=0
 Memory cgroup out of memory: Killed process 671666 (python) total-vm:531600kB, anon-rss:522724kB, file-rss:5348kB, shmem-rss:0kB, UID:0 pgtables:1084kB oom_score_adj:0
```

`constraint=CONSTRAINT_MEMCG` is the kernel testifying that a cgroup limit, not the machine, ran out. The call trace underneath (`do_anonymous_page ← … ← mem_cgroup_out_of_memory ← out_of_memory ← oom_killer`) is the hog dying on its own write to a fresh page — the moment the overcommit deal comes due.

## How the kernel picks the victim: oom_score and oom_score_adj

The kernel scores every task 0–1000 and kills the highest. The dominant input is RSS — the bigger you are, the more you free when you die — adjusted by `oom_score_adj`. Read any process's score at `/proc/<pid>/oom_score` and its adjustment at `/proc/<pid>/oom_score_adj`. This host is a KDE desktop, so here is the live table:

| process | RSS | oom_score | oom_score_adj |
|---|---|---|---|
| baloo_file (KDE indexer) | 1405976 kB | **842** | 200 |
| firefox | 813976 kB | 841 | 200 |
| opencode | 686728 kB | 826 | 200 |
| my zsh shell | 8088 kB | 800 | 200 |

The ordering is exactly the RSS ordering — baloo_file is the first thing this machine would sacrifice. The same rule holds in containers; two hogs in a 64 MB box:

```console
host pid=828500 score=668 adj=0 rss=63140 kB  python /lab/hog.py 56
host pid=828501 score=666 adj=0 rss=9476 kB   python /lab/hog.py 4
```

`oom_score_adj` (range −1000…1000) is the manual override: −1000 makes a process unkillable, +1000 makes it the preferred victim. The standard trick is protecting the one process you cannot lose (sshd, your agent's runtime, the database). Honest finding from this machine: writing `oom_score_adj` from *inside* a container is denied — `echo -1000 > /proc/$$/oom_score_adj` fails with `Permission denied` even as container root; the host's LSM policy governs that file. Set it where the privilege lives: `docker run --oom-score-adj=-1000`, a systemd unit's `OOMScoreAdjust=-1000`, or from the host as root.

## Swap: the reason your process survived — or did not

The first kill-lab run actually *failed* to kill. With `--memory=512m` and Docker's default swap (which is 2× the memory limit unless you say otherwise), the same hog ate **900 MiB and exited 0** — the kernel pushed the excess to swap instead of killing anything. With a 384 MB limit and swap enabled, I watched the handoff live: resident memory pinned at the ceiling while swap climbed past it:

```console
[376 MiB] rss_now=401915904 swap_now=0        peak=401915904 … max 0    oom_kill 0
[377 MiB] rss_now=402587648 swap_now=62386176 peak=402665472 … max 4    oom_kill 0
[500 MiB] rss_now=402632704 swap_now=136556544 peak=402681856 … max 570  oom_kill 0
[600 MiB] rss_now=402636800 swap_now=241250304 peak=402681856 … max 984  oom_kill 0
survived: finished allocating
```

`rss_now` never exceeds 402653184 (384 MiB); the overflow walks uphill into `swap_now`, reaching 230 MiB while the `max` counter — the soft-limit throttle count — climbs to 984 and `oom_kill` stays 0. That is the whole trade: swap converts a kill into slowness. This is also why `--memory-swap=512m` (equal to `--memory`) mattered in the kill run: it removes the escape hatch, so the same allocation pattern dies at 512 MiB instead of limping to 900. One related finding: Docker's `--memory-reservation` maps to cgroup **memory.low**, not `memory.high` — the soft *throttle* knob must be written to the cgroup file on the host, and the `max` counter in `memory.events` is its fingerprint.

## The real causes: a leak, a runaway cache, a tight limit

Four things actually generate OOM kills in the wild:

- **A leak.** The classic. RSS grows monotonically until the limit; `memory.peak` converges to `memory.max` exactly like the kill run above. The fix is the bug, not the limit.
- **A runaway cache.** Legitimate workloads (build caches, in-memory queues) that grow with input instead of being capped. Same symptom, different medicine: bound the cache in application code.
- **A container limit set too low.** The most embarrassing cause: the software is fine, the number you picked was wrong. Right-size against a busy instance's `memory.peak`, not its idle RSS.
- **A fork bomb.** Mostly a solved problem, and I have the receipt: `:(){ :|:& };:` in a container with `--memory=64m` **exited 0 in 578 ms with no OOM kill at all** — under cgroup v2, `fork()` itself fails when the group is full, so the bomb starves in under a second. With `--pids-limit=64` it self-extinguishes even faster. Don't lose sleep over fork bombs; lose sleep over the leak.

For early warning, this kernel exposes pressure stall information at `/proc/pressure/memory` (`some avg300=0.11` here) — nonzero means tasks are already stalling on reclaim, long before anything dies.

## Reading the evidence: journalctl, memory.events, OOMKilled

When a process dies, four artifacts tell the story. Check them in this order:

1. `journalctl -k --since "<when>" | grep -i oom` — the kernel's autopsy: who invoked the killer, the cgroup usage vs limit, the victim's `anon-rss`, `constraint=CONSTRAINT_MEMCG`.
2. `docker inspect -f '{{.State.OOMKilled}}' <container>` — the flag orchestrators act on; pair it with `ExitCode=137`.
3. The cgroup ledger: `memory.events` (`oom_kill` counts actual kills), `memory.peak` (high-water mark vs `memory.max`), `memory.swap.current` (how much was swapped instead).
4. `/proc/<pid>/oom_score` and `oom_score_adj` for the survivors — the same table the kernel consulted, still readable while the box lives.

## Prevent it before it happens

- Set `memory.max` from a busy instance's `memory.peak` plus headroom; use `--memory-reservation` (memory.low) so reclaim starts *before* the hard wall.
- Alert on trends, not points: `Committed_AS / CommitLimit` climbing past ~80%, `memory.events` `oom_kill` incrementing, nonzero `some` pressure in `/proc/pressure/memory`.
- Make the right process the victim: `--oom-score-adj=-1000` for the one thing you cannot lose; the kernel's default answer is already "the biggest RSS".
- Cap what can fork: `--pids-limit` costs nothing and turns a fork bomb into a non-event.
- Fix the leak. Every OOM kill is the kernel enforcing a promise the application made; the limit only decides *when* it collects.

The deal is simple: Linux trusted your `malloc`, you touched more than existed, and the OOM killer paid the debt by shooting the biggest process in the group. Read the ledger, size the limit, and the 3 a.m. alert stops being a mystery.
