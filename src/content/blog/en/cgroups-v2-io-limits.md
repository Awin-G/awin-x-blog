---
title: "cgroup v2 io.max: capping disk throughput per container"
description: "Real fio numbers on a Docker 29 host: how the cgroup v2 io controller caps per-container disk throughput, what --device-write-bps actually writes, io.max vs io.weight, and why buffered dd lies."
pubDate: 2027-02-02
lang: en
translationKey: cgroups-v2-io-limits
tags: [linux, devops]
featured: false
keywords:
  - cgroup v2 io.max
  - container I/O limits
  - device-write-bps
  - io.weight
  - PSI
---

On this machine, a 4 KiB random-read probe answered in **292 µs**. Then I started a plain, unlimited container writing a 4 GB file with `fio` on the same disk, and the same probe dropped to **4 IOPS with a 242 ms average latency** — a 830× regression caused by nothing but a neighbour's write. That is the whole argument for **container I/O limits**, and in cgroup v2 the knob is `io.max`.

Everything below ran on the real host behind this blog: Docker 29.9.0, kernel **7.2.9-arch1-1**, cgroup v2 unified hierarchy, systemd cgroup driver, no `--privileged`, no root. The root filesystem is ext4 on `/dev/mapper/cryptroot` — device-mapper `dm-0`, major:minor **253:0**, sitting on `/dev/sdb2` (8:18) of `/dev/sdb` (8:16).

## Why I/O limits behave nothing like CPU and memory limits

`--cpus=2` and `--memory=512m` are pleasant: one queue, enforced at the point of use. I/O differs in three ways that each bite:

1. **The limit is per device.** `io.max` names a block device by major:minor. My container writing to `/` is constrained on `253:0`, not on `sda` — a different physical disk on the same host.
2. **Enforcement is at the block layer.** The kernel throttles as I/O is submitted; nothing user-space sees the cap, the throttled process just looks slow.
3. **Buffered writes hide it.** A `write()` into the page cache is done from the writer's point of view. The cap still applies to the eventual writeback (cgroup v2 charges buffered writeback to the cgroup that dirtied the pages), but the writer has already left.

The policy difference matters too: a CPU cap mostly wastes idle capacity, while an I/O cap is a shared-device question. So use `io.max` for "never more than X" and `io.weight` for "when contended, share it like X".

## From blkio to io: the v2 controller

cgroup v1's `blkio` had a split personality — `blkio.throttle.*` for hard caps, `blkio.weight_device` for shares, both per-device. cgroup v2 unifies them into **`io`** with two files:

| File | Meaning | Example |
|---|---|---|
| `io.max` | **hard cap**, per device: `rbps`, `wbps`, `riops`, `wiops` | `253:0 wbps=20971520` |
| `io.weight` | **relative share** when contended, 1–10000 | `default 100` |

Docker's `--device-read-bps`, `--device-write-bps`, `--device-read-iops`, `--device-write-iops` and `--blkio-weight` are all writers for these files. On a systemd-driver host the container's cgroup is a scope, and the whole io surface is one directory:

```console
$ ls /sys/fs/cgroup/system.slice/docker-4a38af82255e5ee6e0e0207e9a22a166c61c130e25bb549e2d879cee9a064b77.scope | grep '^io'
io.bfq.weight
io.latency
io.max
io.pressure
io.prio.class
io.stat
io.weight
```

`io.stat` is the meter, `io.pressure` the stall signal. With no limit, `io.max` is **empty** — the default container is unlimited:

```console
$ docker run --rm cgio:latest sh -c 'echo "[$(cat /sys/fs/cgroup/io.max)]"'
[]
```

## What `--device-write-bps` actually writes

`docker run --device-write-bps /dev/dm-0:20mb` resolves the path to a major:minor and writes one line into the scope:

```console
$ cat /sys/fs/cgroup/system.slice/docker-4a38af82255e5ee6e0e0207e9a22a166c61c130e25bb549e2d879cee9a064b77.scope/io.max
253:0 rbps=20971520 wbps=20971520 riops=max wiops=max
```

`20mb` is Docker's binary notation: 20 MiB/s, hence `20971520`; `max` means uncapped on that field. `docker inspect` confirms the destination:

```console
$ docker inspect capped --format '{{json .HostConfig.BlkioDeviceWriteBps}} {{json .HostConfig.BlkioDeviceReadBps}}'
[{"Path":"/dev/dm-0","Rate":20971520}] [{"Path":"/dev/dm-0","Rate":20971520}]
```

There is a cgroup-namespace subtlety that changes what you can debug: inside the container `/proc/self/cgroup` says `0::/` and `/sys/fs/cgroup` is the container's *own* scope, mounted read-only.

```console
$ docker exec capped sh -c 'cat /proc/self/cgroup; cat /sys/fs/cgroup/io.max'
0::/
253:0 rbps=20971520 wbps=20971520 riops=max wiops=max
$ docker exec capped sh -c 'echo "253:0 wbps=1048576" > /sys/fs/cgroup/io.max'
sh: 1: cannot create /sys/fs/cgroup/io.max: Read-only file system
```

Read-only is correct — limits belong to the orchestrator.

## The measurement: 142 MiB/s against 18 MiB/s

The workload is a 1 MiB sequential write with `fio --direct=1 --ioengine=libaio --iodepth=8`, 12 seconds, to a bind mount on `/`. First, no limit:

```console
Run status group 0 (all jobs):
  WRITE: bw=142MiB/s (149MB/s), 142MiB/s-142MiB/s (149MB/s-149MB/s), io=1717MiB (1800MB), run=12051-12051msec
```

The identical command with `--device-write-bps /dev/dm-0:20mb`:

```console
Run status group 0 (all jobs):
  WRITE: bw=18.1MiB/s (19.0MB/s), 18.1MiB/s-18.1MiB/s (19.0MB/s-19.0MB/s), io=224MiB (235MB), run=12375-12375msec
```

142 → 18.1 MiB/s. To make it airtight I ran both containers **at the same instant** so they shared device contention (this host has other containers running, so the absolute ceiling moves; the ratio is the interesting number): plain **89.5 MiB/s** vs capped **18.8 MiB/s**, 909 MiB vs 192 MiB in ten seconds.

`io.stat` is where you watch the meter tick. Sampled inside a 10-second capped run:

```console
$ cat .../io.stat            # before
8:16 rbytes=385024 wbytes=0 rios=8 wios=0 dbytes=0 dios=0
253:0 rbytes=385024 wbytes=0 rios=8 wios=0 dbytes=0 dios=0
$ cat .../io.stat            # 5 s in
8:16 rbytes=1425408 wbytes=96468992 rios=28 wios=736 dbytes=0 dios=0
253:0 rbytes=1425408 wbytes=96468992 rios=28 wios=736 dbytes=0 dios=0
$ cat .../io.stat            # 10 s in
8:16 rbytes=1425408 wbytes=209715200 rios=28 wios=1600 dbytes=0 dios=0
253:0 rbytes=1425408 wbytes=209715200 rios=28 wios=1600 dbytes=0 dios=0
```

`209715200` bytes in exactly ten seconds. Twenty MiB per second, to the byte. (The same I/O shows under both `8:16` and `253:0` — the dm layer and the physical disk — so query the device your limit is on.)

Bytes are not the only axis; the other two fields are IOPS. A 4 KiB random-write stream capped at 200 write IOPS:

```console
$ docker run --rm --device-write-iops /dev/dm-0:200 ... fio --rw=randwrite --bs=4k ...
253:0 rbps=max wbps=max riops=max wiops=200
   iops        : min=   40, max=   264, avg=146.13, stdev=  73.97, samples=15
  WRITE: bw=516KiB/s (528kB/s), 516KiB/s-516KiB/s (528kB/s), io=4384KiB (4489kB), run=8502-8502msec
```

The same workload uncapped: 33,559 IOPS at 131 MiB/s. **146 vs 33,559 IOPS — 230× less — while the byte rate moved from 131 MiB/s to 516 KiB/s.** A bandwidth cap would not have helped this workload at all, because it was barely moving bytes.

## The device must be on the I/O path

<figure>
<svg viewBox="0 0 720 340" role="img" aria-label="Two containers sharing one block device; the noisy one is capped by io.max while the probe keeps its latency" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto">
  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13" fill="currentColor">
    <rect x="60" y="24" width="250" height="64" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.75"/>
    <text x="185" y="48" text-anchor="middle">container A (noisy)</text>
    <text x="185" y="70" text-anchor="middle" font-size="11" opacity="0.75">io.max 253:0 wbps=20MiB/s</text>

    <rect x="410" y="24" width="250" height="64" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.75"/>
    <text x="535" y="48" text-anchor="middle">container B (probe)</text>
    <text x="535" y="70" text-anchor="middle" font-size="11" opacity="0.75">no limit — 3168 IOPS</text>

    <path d="M185,88 V150" stroke="currentColor" stroke-opacity="0.45"/>
    <path d="M535,88 V150" stroke="currentColor" stroke-opacity="0.45"/>
    <path d="M185,150 H535" stroke="currentColor" stroke-opacity="0.45"/>
    <path d="M360,150 V196" stroke="currentColor" stroke-opacity="0.45"/>

    <rect x="300" y="196" width="120" height="34" rx="17" fill="#0f766e" fill-opacity="0.14" stroke="#0f766e" stroke-width="1.5"/>
    <text x="360" y="218" text-anchor="middle" fill="#0f766e" font-size="12">valve 20MiB/s</text>
    <text x="432" y="218" font-size="11" opacity="0.7">(on A's path only)</text>

    <path d="M360,230 V262" stroke="currentColor" stroke-opacity="0.45"/>
    <rect x="180" y="262" width="360" height="50" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.75"/>
    <text x="360" y="284" text-anchor="middle">one block device</text>
    <text x="360" y="301" text-anchor="middle" font-size="11" opacity="0.75">253:0 dm-0 (cryptroot) → 8:16 sdb</text>
  </g>
</svg>
<figcaption>One shared device, one capped and one free. Because `io.max` is per device, it only bites on the path it names: 4 IOPS for the uncapped neighbour, 3168 IOPS once the cap is on.</figcaption>
</figure>

Because the limit is per-device, naming the wrong device is the classic failure: the flag is accepted, the file is written, and nothing is throttled. This host has a second disk, `/dev/sda` (298 GB), which the root filesystem never touches. Capping writes to it while the container writes to `/`:

```console
$ docker run --rm --device-write-bps /dev/sda:20mb -v /var/tmp/cgiotest/data:/data cgio:latest sh -c 'cat /sys/fs/cgroup/io.max; fio ...'
8:0 rbps=max wbps=20971520 riops=max wiops=max
  WRITE: bw=105MiB/s (110MB/s), 105MiB/s-105MiB/s (110MB/s-110MB/s), io=841MiB (882MB), run=8005-8005msec
```

The limit is in the file, and 105 MiB/s sails past it, because `8:0` is not on that write's path. A device that does not exist fails loudly, which is a hint about how to find the right one:

```console
$ docker run --rm --device-write-bps /dev/sdz1:20mb cgio:latest true
docker: Error response from daemon: stat /dev/sdz1: no such file or directory
```

Find it with `df /` → `lsblk`, then follow the stack to the major:minor on the I/O path. With LUKS or LVM you can cap either the dm device or the physical disk above/below it — both are on the path — but not a disk that isn't.

## The page-cache trap: don't benchmark limits with `dd`

Same cap, measured with `dd` twice. With `conv=fsync` the cap is obvious:

```console
$ docker exec capped dd if=/dev/zero of=/data/dd2 bs=1M count=200 conv=fsync
209715200 bytes (210 MB, 200 MiB) copied, 11.1285 s, 18.8 MB/s
$ docker exec plain   dd if=/dev/zero of=/data/dd1 bs=1M count=200 conv=fsync
209715200 bytes (210 MB, 200 MiB) copied, 2.39799 s, 87.5 MB/s
```

Drop the `fsync` and `dd` lies: three seconds, claiming **170 MB/s**. The bytes went to the page cache; the cap simply moved to writeback, and you can watch the container's `io.stat` catch up at the capped rate after `dd` has exited:

```console
$ docker exec capped dd if=/dev/zero of=/data/dd3 bs=1M count=500
524288000 bytes (524 MB, 500 MiB) copied, 3.08741 s, 170 MB/s
$ grep wbytes .../io.stat     # the moment dd returns
253:0 rbytes=1536000 wbytes=662708224 rios=45 wios=5058 dbytes=0 dios=0
# 6 s later
253:0 rbytes=1536000 wbytes=788537344 rios=45 wios=6018 dbytes=0 dios=0
# 6 s later again
253:0 rbytes=1536000 wbytes=914366464 rios=45 wios=6978 dbytes=0 dios=0
```

Each interval adds 125,829,120 bytes — 120 MiB in six seconds, ~21 MB/s. The disk really is capped; the *process* just does not experience it. That is why a "capped" container can look fine for hours and then stall a database that needs data flushed, and why a limit test with buffered I/O is worthless. Use `fio --direct=1` (or `oflag=direct` with `dd`).

A cap also does not reduce latency — for the container that owns it, it converts bandwidth into waiting. The throttled writer's own latency went from microseconds to seconds: 50th percentile 802 ms, 99th percentile 3.57 s, for 15.8 MiB/s of real work.

## `io.weight` is the other tool, and here it did nothing

`io.max` says "never more than this"; `io.weight` says "when contended, divide it like this" (1–10000, default 100). Weights only matter when something competes — on an idle disk they are irrelevant. So I ran two unlimited containers at once, one at `--blkio-weight 100`, one at `--blkio-weight 900`, and let them fight over the same disk:

```console
$ docker logs wA | grep 'WRITE: bw='   # --blkio-weight 100
  WRITE: bw=91.7MiB/s (96.1MB/s), ..., io=1384MiB (1451MB), run=15095-15095msec
$ docker logs wB | grep 'WRITE: bw='   # --blkio-weight 900
  WRITE: bw=94.4MiB/s (98.9MB/s), ..., io=1427MiB (1496MB), run=15122-15122msec
```

A 9× weight difference bought a 3% throughput difference — noise. The container's file agrees that nothing was set:

```console
$ docker run --rm --blkio-weight 400 cgio:latest cat /sys/fs/cgroup/io.weight
default 100
```

And the per-device form is worse than useless here — on this host it *prevents the container from starting*:

```console
$ docker run --rm --blkio-weight-device /dev/dm-0:400 cgio:latest true
docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: error setting cgroup config for procHooks process: setting device weight "253:0 400": write /sys/fs/cgroup/system.slice/docker-3d43cf244a0e6e17b794a01555faef79de4fe2c796ebbc31492693a91c260b4d.scope/io.bfq.weight: operation not supported
```

The reason is the scheduler. `cat /sys/block/sdb/queue/scheduler` here reports `none [mq-deadline] kyber bfq`: **`io.weight` is implemented only by `bfq` (and the `io.cost` model), not by `mq-deadline` or `kyber`.** runc writes per-device weights to `io.bfq.weight`, the kernel returns `EOPNOTSUPP`, and the container dies before it starts; global `--blkio-weight` is silently dropped. I could not switch the scheduler in this session (it needs root on the host), so treat that as the honest boundary of my evidence: on a stock host, `io.max` is the knob that reliably works.

## Seeing contention: PSI

`io.stat` says how much I/O a container did; it cannot say whether anything was *waiting*. That is PSI, and it has four files — `cpu`, `memory`, `io`, `irq`:

```console
$ cat /proc/pressure/io
some avg10=29.45 avg60=23.31 avg300=21.19 total=3946711619
full avg10=27.24 avg60=21.73 avg300=19.44 total=3380691331
```

`some` = the percentage of time *at least one* task on the system was stalled on I/O (sampled while my uncapped hog was writing); `full` = nothing could run at all because everything was blocked on I/O. Decaying averages over 10/60/300 s, plus a monotone `total` in microseconds. `full` at 27% is a disk-bound machine.

Two caveats from real data. PSI is system-wide and has a floor: on this busy host `/proc/pressure/io` sits at 15–20% `some` before I start anything. The per-cgroup version is the surgical tool, because every cgroup has its own `io.pressure`:

```console
$ cat .../io.pressure            # idle container
some avg10=0.00 avg60=0.00 avg300=0.00 total=0
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
$ cat .../io.pressure            # after a 10 s capped run
some avg10=0.00 avg60=0.00 avg300=0.00 total=6450
$ cat .../io.pressure            # after a 10 s uncapped run
some avg10=0.09 avg60=0.02 avg300=0.00 total=25679
```

Stall in milliseconds, attributed to exactly one container. That is what you alert on.

## The payoff: the cap gives the neighbour its latency back

The opening probe, three times, 8 seconds of 4 KiB random reads at queue depth 1 while another container wrote to the same disk:

| Scenario | IOPS | avg latency |
|---|---|---|
| probe alone | 3,414 | 291.56 µs |
| neighbour writing, uncapped | **4** | **242.31 ms** |
| neighbour writing, capped at 20 MiB/s | 3,168 | 314.19 µs |

The cap put the probe back to 3,168 of its 3,414 solo IOPS — 93% of the throughput, with latency 23 µs higher — while the noisy container still wrote 15.8 MiB/s. Not fairness in the abstract: a 4-IOPS database becoming a 3,168-IOPS database again.

## Practical guidance

- **Cap the noisy neighbour, not everyone.** Find it from `io.stat` (who owns most of the device's `wbytes`) and from the neighbours' `io.pressure`. Capping a quiet container buys nothing.
- **Name the right device.** `df /` → `lsblk`, then follow the stack to the major:minor actually on the path. A disk that isn't on the path silently does nothing.
- **Test with `fio --direct=1`, never `dd` alone.** Buffered writes show 170 MB/s where the disk is capped at 20.
- **Pick the axis.** `wbps` for streaming, `wiops` for small-I/O workloads; they are independent.
- **Watch for page-cache masking.** Check `io.pressure` and, host-wide, `grep -E 'Dirty|Writeback' /proc/meminfo`.
- **Use PSI to decide when to cap.** Alert when a cgroup's `io.pressure` `full` grows steadily.
- **Do not expect `io.weight` to save you.** On an `mq-deadline` host it is ignored or fatal; `bfq`/`io.cost` is a separate, deliberate decision about the whole device.

The mechanical background — what a cgroup is, how `--memory` and `--cpus` map to files — is in [cgroups v2 in practice](/posts/cgroups-v2/). For benchmarking the workload rather than the limit, see [Disk I/O benchmarks that mean something](/posts/disk-io-and-fio/).

*Related: [cgroups v2 in practice: how containers are actually limited](/posts/cgroups-v2/) · [Disk I/O benchmarks that mean something: fio, IOPS, and fsync](/posts/disk-io-and-fio/) · [Disk I/O latency troubleshooting](/posts/io-latency/)*
