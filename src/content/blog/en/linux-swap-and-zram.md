---
title: "Linux swap and zram: what they are, and when they save you"
description: "What Linux swap actually is (and why it is not RAM), what vm.swappiness really controls, how to read memory pressure from vmstat si/so, pswpin/pswpout and /proc/pressure, and when zram beats a disk swapfile — real output, plus a 400 MiB allocation test under a Docker cgroup limit."
pubDate: 2027-02-01
lang: en
translationKey: linux-swap-and-zram
tags: [linux, devops]
featured: false
keywords:
  - Linux swap
  - zram
  - vm.swappiness
  - memory pressure
  - swapfile
  - pswpin
---

Two weeks ago I wrote about [the OOM killer and memory overcommit](/posts/oom-killer-and-overcommit/)
and how Linux lets your `malloc` lie until you touch the pages. Swap is the other half of
that story, and the most misunderstood knob in the memory subsystem. People call it "extra
RAM" and then act surprised when a box with 32 GB of RAM and 32 GB of swap dies of memory
pressure. It is not extra RAM. It is an overflow spillway with a very narrow pipe — and on
this machine, 11.5 GiB of RAM, an 8 GiB `/swapfile` on an SSD and a 4 GiB `zram0` device,
that spillway is doing real work right now.

The practical version: what **Linux swap** is, what `vm.swappiness` actually controls, how
to see **memory pressure** before anything dies, and why **zram** is my default answer for
small machines. Every number below came off this host.

## What swap is, and what it is not

Swap is disk-backed space the kernel can move cold pages into. When anonymous memory — a
process's heap and stack — has not been touched for a while and the kernel needs frames, it
writes those pages out and frees the RAM. The process keeps running untouched; its page table
entries now point at a swap slot instead of a frame. Touch the page again and a page fault
brings it back, at the cost of a read. Two consequences are the whole personality of the thing:

- **It is not capacity.** You cannot "add 8 GB of RAM" by making a swapfile. You have added
  8 GB of *cold parking*. If the working set genuinely exceeds RAM, swap turns a hard crash
  into a slow crawl: it buys time, not throughput.
- **It is orders of magnitude slower than RAM.** A cached page costs nanoseconds; one that
  comes back from a SATA SSD costs hundreds of microseconds, from a spinning disk,
  milliseconds.

<figure>
<svg viewBox="0 0 720 252" width="100%" role="img" aria-label="Three overflow destinations for anonymous pages, in the order the kernel fills them: RAM itself, then a zram device that compresses pages into RAM at priority 100, then a swapfile on an SSD at priority minus one. When all three are full, the OOM killer fires.">
  <defs>
    <marker id="swp-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="10" y="14">anonymous pages leave RAM in this order</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="10" y="40" width="150" height="86" rx="8"/>
    <rect x="250" y="40" width="190" height="86" rx="8"/>
    <rect x="530" y="40" width="180" height="86" rx="8"/>
  </g>
  <g stroke="#0f766e" stroke-width="1.5" fill="none" opacity="0.9">
    <path d="M160 83 h80" marker-end="url(#swp-ar)"/>
    <path d="M440 83 h80" marker-end="url(#swp-ar)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="85" y="66" font-weight="600">RAM</text>
    <text x="85" y="88">11.5 GiB</text>
    <text x="85" y="108" font-size="11" opacity="0.7">nanoseconds</text>

    <text x="345" y="66" font-weight="600">zram0</text>
    <text x="345" y="88">4 GiB · zstd</text>
    <text x="345" y="108" font-size="11" opacity="0.7">priority 100 · 1.97:1</text>

    <text x="620" y="66" font-weight="600">/swapfile</text>
    <text x="620" y="88">8 GiB · SSD</text>
    <text x="620" y="108" font-size="11" opacity="0.7">priority −1</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.5">
    <rect x="10" y="176" width="700" height="46" rx="8"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="26" y="196">free RAM runs out first</text>
    <text x="26" y="214" font-size="11" opacity="0.7">cold pages park in zram, then on the file — the box gets slow, not dead</text>
  </g>
  <g fill="#0f766e" font-family="system-ui, sans-serif" font-size="12">
    <text x="694" y="205" text-anchor="end">the OOM killer waits behind all three</text>
  </g>
</svg>
<figcaption>RAM first, then the compressed-RAM swap device, then the disk file — priority decides the order, and swap buys time before the OOM killer gets involved at all.</figcaption>
</figure>

There is no "partition vs file" drama left to have. What matters is *what backs it*:

```console
$ swapon --show
NAME       TYPE      SIZE USED PRIO
/swapfile  file        8G 4.8G   -1
/dev/zram0 partition   4G   4G  100

$ cat /proc/swaps
Filename				Type		Size		Used		Priority
/swapfile                               file		8388604		5050808		-1
/dev/zram0                              partition	4194300		4192988		100
```

A file and a partition behave identically once `swapon` accepts them. The **PRIO** column is
the interesting one: the kernel prefers higher priority areas first, so this host fills
`zram0` (priority 100) long before it touches the 8 GiB file (priority −1).

## The three places the kernel publishes swap traffic

`/proc/vmstat` holds the cumulative counters — since boot, in **pages, not bytes**:

```console
$ grep -E '^(pswpin|pswpout|pgmajfault|oom_kill|pgsteal|pgscan)' /proc/vmstat
pgsteal_kswapd 94466120
pgsteal_direct 9298304
pgsteal_anon 11145892
pgsteal_file 92653892
pgscan_anon 17363079
pgscan_file 100806074
pswpin 284531
pswpout 1893087
pgmajfault 4119003
oom_kill 8
```

Over 2.3 days of uptime: 1,893,087 pages out (≈ 7.2 GiB) against 284,531 in (≈ 1.1 GiB). Only
a fraction ever came back — the pages that went to swap were cold and never needed again.

Then pressure stall information, which is what I actually alert on:

```console
$ cat /proc/pressure/memory
some avg10=0.00 avg60=0.00 avg300=0.04 total=150168596
full avg10=0.00 avg60=0.00 avg300=0.04 total=130432321
```

`some` is the percentage of time at least one task was stalled on memory reclaim, `full` the
time *all* tasks were. `avg300=0.04` means 0.04% of the last five minutes — nothing to see.
Nonzero and climbing means tasks are already waiting, long before an OOM kill, and often with
plenty of "free" RAM still on the `free -m` line.

`vmstat` compresses all of it into two columns that matter, `si` and `so` — swap in and
swap out, in KiB per second:

```console
$ vmstat 1 5
procs -----------memory---------- ---swap-- -----io---- --system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st gu
 2  0 9246904 370180 90300 3427532   5   38  1005  8221 5474 4239 17  2 80  1  0  0
 2  0 9246904 367352 90300 3429856   0     0  1896     0 5367 3136 22  1 77  0  0  0
 2  0 9246904 367296 90300 3429856   0     0     0     0 5382 3136 27  1 73  0  0  0
 1  2 9246904 236436 90300 3429856   0     0     0 256672 25281 50677 20  7 63  9  0  0
 1  0 9246896 359356 90308 3429856   0     0     0   132 6410 5480 14  1 70 14  0  0
```

A `so` of 38 KiB/s once and then nothing is background noise. `si` and `so` sitting at hundreds
or thousands for minutes is the "slow crawl" case — and alongside high `wa` the story is I/O,
not compute. That is the [load average](/posts/linux-load-average/) trap in another costume:
the box looks busy because every task is parked in D state waiting for a page.

## vm.swappiness: what it actually controls

The most repeated myth here is that `vm.swappiness` is "how aggressively the kernel uses
swap" or "how much RAM it keeps free". It is neither. It tunes one trade-off: **when
reclaiming under pressure, should the kernel prefer evicting anonymous pages (which must go
to swap) or file pages (page cache, which can be dropped and re-read)?**

```console
$ cat /proc/sys/vm/swappiness
100

$ sysctl vm.swappiness
vm.swappiness = 100
```

The range is 0–100 (modern kernels accept up to 200). Low values bias reclaim toward dropping
page cache — good for a database whose buffer cache you want to keep. High values bias it
toward swapping anonymous pages out and keeping the page cache hot, which is right when the
swap target is *itself RAM* (zram or Zswap): you trade compressed anonymous memory for
uncompressed file cache, and usually win.

This host runs 100, deliberately: its swap is a 4 GiB zram device, so "swapping out" is a
compression operation, not an I/O operation. On a big database server backed by a real disk,
`vm.swappiness=10` says "reclaim my page cache before you touch anything anonymous". The number
is a policy, and the policy depends on what your swap actually is.

## Why swap matters even on a big-RAM box

1. **It buys time for the OOM killer to never fire.** Linux overcommits memory, so the kernel
   hands out more than exists. When the bill comes due, swap absorbs the difference: the box
   gets slow, you get paged, you get to fix it. Without swap the alternative is the
   [OOM killer](/posts/oom-killer-and-overcommit/) shooting your largest process with no
   warning at all.
2. **It absorbs cold data a process forgot it had.** Java heaps, notebook kernels, idle
   containers. Nobody touches them, but they hold RAM.

The counter-argument: swap on a box that is truly out of memory is a **lie detector**, not a
fix. `free -m` here shows 3.4 GiB "available" while 9 GiB of swap is in use — the healthy
"cold stuff parked safely" case, nothing like a box thrashing.

## The experiment: 400 MiB against a 256 MiB wall

The same allocator — 400 MiB of anonymous memory, every page touched — run three ways in
throwaway containers, each with a cgroup v2 memory limit:

| run | `--memory` | `--memory-swap` | result |
|-----|-----------|------------------|--------|
| A | 256m | 256m (no swap headroom) | **OOM-killed** at 192 MiB |
| B | 256m | 512m | finished, 4.85 s |
| C | 4g | — (nothing to reclaim) | finished, 0.29 s |

Run A, no swap to spill into:

```console
$ docker run --rm --memory=256m --memory-swap=256m \
    -v $PWD/alloc.py:/alloc.py:ro python:3.12-slim sh /lab.sh 400 64 2
  alloc   64 MiB resident  elapsed=   0.05s
  alloc  128 MiB resident  elapsed=   0.09s
  alloc  192 MiB resident  elapsed=   0.12s
Killed
--- cgroup v2 memory ledger, read from inside the container ---
memory.max               268435456
memory.peak              268435456
memory.swap.max          0
memory.swap.current      0
memory.events            low 0 high 0 max 58 oom 1 oom_kill 1 oom_group_kill 0 ...
```

`memory.peak` is exactly `memory.max`, `oom_kill 1`, `memory.swap.max 0`. The container
hit the wall and the kernel chose a victim. There was nowhere to spill.

Run B, identical allocator, identical memory limit, but 256 MiB of swap headroom:

```console
$ docker run --rm --memory=256m --memory-swap=512m \
    -v $PWD/alloc.py:/alloc.py:ro -v $PWD/lab.sh:/lab.sh:ro python:3.12-slim sh /lab.sh 400 64 3
  alloc   64 MiB resident  elapsed=   0.04s
  alloc  128 MiB resident  elapsed=   0.08s
  alloc  192 MiB resident  elapsed=   0.12s
  alloc  256 MiB resident  elapsed=   0.23s
  alloc  320 MiB resident  elapsed=   0.49s
  alloc  384 MiB resident  elapsed=   0.76s
  alloc  400 MiB resident  elapsed=   0.82s
alloc done: 400 MiB in 0.83s
  pass 1: re-touch 400 MiB in    2.06s  (wall    2.89s)
  pass 2: re-touch 400 MiB in    1.95s  (wall    4.84s)
swap counters delta (this host, /proc/vmstat): pswpin+0 pswpout+0 pgfault+229857 pgmajfault+26607
checksum=335 total=4.85s
--- cgroup v2 memory ledger, read from inside the container ---
memory.events            low 0 high 0 max 5823 oom 0 oom_kill 0 oom_group_kill 0 ...
memory.stat              ... pgsteal_direct 238420 pswpin 0 pswpout 0 pgfault 305343
                              pgmajfault 27249 ... zswpin 198149 zswpout 236312 zswpwb 0 ...
```

The same 400 MiB that got the process killed in run A completed here. The price is in the log:
re-touching the working set took **2.06 s per pass versus 0.02 s** in the control run, a ~100×
slowdown, and total runtime went from 0.29 s to 4.85 s — the "slow crawl", where every page the
process had evicted had to be faulted back in.

One honest nuance: the container's own counters show `pswpout 0` and `zswpout 236312`. Its
reclaimed pages never reached the disk — this host runs **Zswap**
(`/sys/module/zswap/parameters/enabled` = `Y`), so anonymous pages were compressed into a RAM
pool first; `pgmajfault+26607` with `pswpout+0` is major faults with no swap device I/O. So the
4.85 s is the cost of *compression*, not of disk, and a spinning-disk landing zone would be far
worse — a number this box cannot show me without root.

## zram: swap that lives in RAM

**zram** is a compressed RAM block device: you create it, tell it how much logical space to
advertise, pick a compressor, `mkswap` it and `swapon` it like any other device. Pages written
into it are compressed with zstd or lz4 and stored in RAM — CPU cycles traded for zero disk I/O
and zero flash wear.

This host has one, and it is genuinely earning its keep:

```console
$ lsmod | grep zram
zram                   73728  1
842_decompress         20480  1 zram
842_compress           24576  1 zram
lz4hc_compress         20480  1 zram

$ cat /sys/block/zram0/comp_algorithm
lzo-rle lzo lz4 lz4hc [zstd] deflate 842

$ zramctl
NAME       ALGORITHM DISKSIZE DATA COMPR TOTAL STREAMS MOUNTPOINT
/dev/zram0 zstd            4G   3G  1.5G  1.5G         [SWAP]

$ cat /sys/block/zram0/mm_stat
3249025024 1633331173 1650630656        0 1658478592     8047    38669   262816   331180
```

Those `mm_stat` fields are `orig_data`, `compr_data`, `mem_used` in bytes: 3.03 GiB of
pages sitting inside 1.54 GiB of RAM, a **1.97:1 ratio**. Freeing half the RAM that stuff
occupied, with no disk in the loop, is a good trade for one core of zstd.

The commands to create one from scratch — labelled as *the recipe*, not output, because
the sysfs entries that size a zram device are root-only:

```console
$ ls -l /sys/block/zram0/disksize /sys/block/zram0/reset
-rw-r--r-- 1 root root 4096 10月12日 04:12 /sys/block/zram0/disksize
--w------- 1 root root 4096 10月14日 11:25 /sys/block/zram0/reset

# modprobe zram num_devices=1
# echo zstd > /sys/block/zram0/comp_algorithm
# echo 4G   > /sys/block/zram0/disksize
# mkswap /dev/zram0
# swapon --priority 100 /dev/zram0
```

(The Chinese month names above are this host's locale, not a typo.)

I ran this lab as uid 1000, so I created no second device and did not touch the running one —
the numbers above come from inspecting it, not building it. On a systemd host the declarative
route is `zram-generator` (`/etc/systemd/zram-generator.conf`,
`zram-size = min(ram / 2, 4096)`); Fedora and Raspberry Pi OS ship exactly this, which is why
they feel fine on 2 GB of RAM.

## Swap on SSD: wear, latency, and why a swapfile is fine now

The `/swapfile` here is 8 GiB on an encrypted ext4 root backed by a SATA SSD:

```console
$ findmnt -T /swapfile
TARGET SOURCE                FSTYPE OPTIONS
/      /dev/mapper/cryptroot ext4   rw,relatime

$ lsblk -o NAME,SIZE,TYPE,ROTA,MODEL
sdb           238.5G disk     0 Micron_1100_MTFDDAV256TBN
`-sdb2          238G part     0
  `-cryptroot   238G crypt     0
```

`ROTA 0` means no spinning platters, so a swap-in is a random 4 KiB read — tens of
microseconds, thousands of times faster than the mechanical disk everyone remembers being slow.
Wear is real but measurable: at 1,893,087 pages of `pswpout` over 2.3 days, this box writes
about **3 GiB/day** to swap, meaning an 8 GiB swapfile is fully rewritten roughly every 2.7
days — a modest slice of any modern TLC drive's write budget, and you shrink it further by
raising the zram priority (as here) so the compressed device absorbs most of the traffic.

On "partition or file": a swapfile needs a filesystem that can map it to blocks, which ext4
and XFS have done forever and Btrfs only reached properly in the 5.0 era. On ext4, make the
file with `dd` so it has no holes, then `mkswap`, `swapon`, and persist it:

```console
# dd if=/dev/zero of=/swapfile bs=1M count=4096 status=progress
# chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
# grep swapfile /etc/fstab
/swapfile none swap sw 0 0
```

Those three lines are the recipe too; this host's swapfile already exists, and I was not going
to add a second one just for prettier output.

## My recipe

- **A zram device at half your RAM, capped at 4 GiB, high priority.** zstd,
  `swapon --priority 100`. Nearly all swap traffic should land here.
- **A modest disk swapfile as the backstop** — 1–2× RAM for desktops where you might
  hibernate, or a flat 2–4 GiB on servers, at priority −1. An emergency spillway, not a
  memory extension.
- **`vm.swappiness` tuned to the landing zone, not to folklore.** zram-backed on a desktop
  or Pi → 100. Disk-backed swap in front of a database → 10.
- **Watch pressure, not free RAM.** `pswpin`/`pswpout` deltas, `vmstat` `si`/`so`, and
  `/proc/pressure/memory` `some avg60`. Alert on the PSI number crossing ~1% for a few
  minutes, and on `pswpin` climbing steadily.
- **Never treat swap as the fix for a leak.** Swap turned run A into run B: same process, same
  limit, 17× the wall time. A reprieve, not a resolution — find the thing actually holding
  memory, using the same investigation as the
  [OOM killer post](/posts/oom-killer-and-overcommit/).

The one-sentence version: swap is the kernel's promise that a cold page you were not using does
not have to occupy RAM, zram is that promise kept without touching a disk, and `vm.swappiness`
is you telling the kernel which pages you consider colder.
