---
title: "btrfs vs ZFS for a homelab: what I'd actually pick, and why"
description: "A practical btrfs vs ZFS comparison for a homelab: what they share (checksums, snapshots, send/receive, RAID-like redundancy), where they diverge (in-kernel per-file vs integrated volume management and RAIDZ), the memory/ARC and licensing trade-offs, and a recommendation per scenario."
pubDate: 2026-11-12
lang: en
translationKey: btrfs-vs-zfs
tags: [homelab, self-hosting, linux]
featured: false
keywords:
  - btrfs vs ZFS
  - filesystem snapshots
  - homelab storage
  - RAIDZ
  - send receive
---

I get asked **btrfs vs ZFS** roughly once a month, usually by someone who just
bought a couple of drives for a homelab and wants permission to stop reading. So
here is the version I give: both give you **filesystem snapshots**, checksums and
**send receive** replication, and both can turn a stack of disks into something
that survives a disk dying. For most homelabs either one is fine, and the choice
comes down to RAM, how many disks you have, and how much you fear the day it
breaks. This is what I run and what I would pick.

I will say up front that I am biased toward boring. **homelab storage** is not a
place to be clever; it is a place to be able to recover at 2am with no internet.

## What btrfs and ZFS actually share

It is worth being fair about this, because the differences get all the airtime.
Both are copy-on-write filesystems with a modern feature set:

- **Checksums on data and metadata.** Silent corruption is detected, not
  absorbed. If you have redundancy, it can be repaired.
- **Snapshots** that are near-instant and cheap, because nothing is copied.
- **Send/receive** replication, so a snapshot can be streamed to another machine.
- **RAID-like redundancy** built in — btrfs `raid1`/`raid10`, ZFS `mirror`/RAIDZ.
- **Subvolumes/datasets**, so you can snapshot one tree without the rest.
- **Compression and scrubbing** to periodically verify the data is still good.

If you have only ever used ext4, the important shift is the same in both: a
snapshot is not a backup you can `cp`, but it is a fantastic *source* for one.
That is the point where they join the plan in
[backups you can actually restore](/posts/backups-you-can-restore/).

## Where they diverge

The architectures are genuinely different, and that difference explains most
practical advice.

### btrfs: in-kernel and per-file flexible

btrfs lives in the mainline Linux kernel — no module to compile, no DKMS to fight
after every upgrade. It is a filesystem first and a volume manager second: it
manages devices, but capabilities can be set per file and per directory. You
can have one subvolume with `compress=zstd`, another with `compress=no`; you can
turn `nodatacow` on for a VM image or a database file and leave it off elsewhere.
That granularity is the real btrfs advantage, and it is why it is lovely on a
single disk.

The cost is that btrfs is an evolving filesystem. Its RAID5/6 write-hole problem
is well known and still means: do not use btrfs `raid5`/`raid6` for data. `raid1`
and `raid10` are considered stable. Metadata and data profiles are configured
per-chunk, which is powerful and confusing in equal measure.

### ZFS: integrated volume management and mature RAIDZ

ZFS treats the whole stack as one thing. You hand it disks, it owns the pools,
datasets, compression, encryption, and RAID. It is not really "a filesystem you
put on a partition" — with ZFS on Linux you typically do not use the kernel
partitioner at all, you give `zpool` raw devices. That integration is why RAIDZ
is so dependable: it was designed with the checksums and the pool as one system
from the start, and it has a decade and a half of production hardening behind it.

You lose the per-file knobs. Compression, recordsize and similar are set per
dataset, not per file, though `recordsize` per dataset covers most needs. In
exchange you get a mature, predictable, well-documented stack with `zpool scrub`,
`zfs send`, and a large body of operators who have already hit your bug.

## The memory question: ARC and RAM

This is the difference people feel in a homelab.

ZFS uses the **ARC** — Adaptive Replacement Cache — as its read cache, and by
default it will happily use most free RAM. On a NAS with 32–128 GB that is great
and a large part of why ZFS feels fast. On a small box it is the thing you tune,
because a default install on an 8 GB machine can pressure other services. You can
cap it (`zfs_arc_max`), and on modern ZFS with the OpenZFS 2.2 "ARC on Linux"
behavior it returns memory more gracefully, but you still plan for it.

btrfs does not have a giant read cache of its own; it leans on the page cache.
That makes it more forgiving on low-RAM machines and VMs out of the box. It does
not magically make it faster — the cache just is not ZFS's ARC.

Rough rule I use: if the machine has 16 GB or less and also runs other things,
btrfs has a lower planning burden. If it is a dedicated storage box with plenty of
RAM, ARC is a feature, not a tax.

## Licensing and recovery tooling

ZFS on Linux is OpenZFS, under the CDDL, which is not GPL-compatible — so it
cannot be merged into the mainline kernel and ships either as an out-of-tree
module (DKMS) or bundled in distributions that arrange it. In practice this works
fine on Debian, Ubuntu, Proxmox, TrueNAS and friends. But it means kernel upgrades
and ZFS module rebuilds can, very occasionally, be a dance. If you run
[Proxmox rather than plain Linux](/posts/proxmox-vs-plain-linux/), this is already
solved for you — Proxmox ships a matched kernel and ZFS.

btrfs is GPL and in the kernel, so it comes with the distro and needs nothing
installed. That is the entire licensing story most homelab users care about.

Recovery is where the field tilts. ZFS has older, thicker tools: `zpool import`
with `-F`/`-X` for transaction rollback, import by ID, a very long track record.
btrfs has `btrfs check` and `btrfs rescue`, and snapshots have saved me more than
once, but the perception — largely earned — is that when btrfs goes wrong, the
recovery story is thinner. Both will lose data if you use them wrong; ZFS just has
more people who have already been there.

## The practical questions I ask before choosing

Before the recommendation, these are the questions that actually decide it.

### One disk, or many?

A single disk changes everything. On one disk you have no redundancy either way,
so the filesystems are competing on snapshots, compression and features — and
btrfs wins on convenience: in-kernel, per-subvolume compression, `nodatacow` where
you need it. With many disks, ZFS's pool model and RAIDZ maturity are the reason
people pick it.

### What is the RAM budget?

Below ~16 GB shared with other services: prefer btrfs, or plan to cap ARC.
Dedicated box with room: either, but ZFS's cache is a nice bonus.

### Do I want snapshots as the backbone of backups?

Both. But note that snapshots are *local*. The moment you rely on **filesystem
snapshots** as your backup, you have a single point of failure and a disk-filling
surprise waiting. Snapshots feed a real backup; they do not replace one. See
[backups you can restore](/posts/backups-you-can-restore/).

### Can I send/receive to an offsite?

Yes on both, and this is the feature I care about most, because it makes backups
incremental and cheap.

```bash
# btrfs: snapshot, then stream it offsite
btrfs subvolume snapshot -r /srv/data /srv/snapshots/data-$(date +%F)
btrfs send /srv/snapshots/data-2026-11-12 \
  | ssh offsite 'btrfs receive /backup/data'
```

```bash
# ZFS: snapshot, then stream it offsite
zfs snapshot tank/data@2026-11-12
zfs send tank/data@2026-11-12 \
  | ssh offsite 'zfs receive backup/data'
```

The second run of either is incremental: you send only the delta from the previous
snapshot. That is the whole argument for picking a CoW filesystem in the first
place — offsite backups that scale with change, not with total size.

### How bad is it when it breaks?

Be honest about your own skills, not the filesystem's reputation. ZFS gives you
more recovery levers and a larger knowledge base. btrfs gives you simpler setup
and `btrfs scrub` that is easy to schedule. Ask whether you would rather debug an
import failure or a `btrfs check --repair` (which you should treat as a last
resort, not a routine command).

## What I'd pick by scenario

- **Single-disk laptop or small server.** btrfs. In-kernel, no DKMS, per-file
  options, snapshots for cheap rollback, and it does not want to eat your RAM.
  Use `raid1` across two disks only if you actually have two.
- **Small NAS array (3–8 disks).** ZFS with RAIDZ or mirrors. This is the case
  ZFS was built for: one pool, one scrub, mature parity, and send/receive to an
  offsite. Budget the ARC, ideally 1 GB per TB plus headroom.
- **"I just want it to work."** Whichever your platform ships and supports.
  On TrueNAS it is ZFS. On a stock desktop distro it is btrfs. Do not get clever
  fighting the platform you have.

## Decision table

| Situation | btrfs | ZFS |
| --- | --- | --- |
| Single disk | Best fit: in-kernel, flexible | Works, but ARC and setup are overkill |
| 2 mirrored disks | Good (`raid1`) | Good (`mirror`) |
| 3+ disks, paritied array | Avoid RAID5/6 | **RAIDZ** is the reason to choose ZFS |
| RAM ≤ 16 GB, shared box | Lower burden | Cap `zfs_arc_max` |
| Dedicated storage, 32 GB+ | Fine | ARC turns it into a cache win |
| Snapshots for rollback | Yes, subvolumes | Yes, datasets |
| Send/receive offsite | Native, incremental | Native, incremental |
| Recovery when it breaks | Thinner tooling | Mature `zpool import -F/-X` |
| Kernel / licensing | GPL, mainline | CDDL, out-of-tree or bundled |
| Per-file tuning | Yes (`nodatacow`, per-subvol) | Per-dataset only |

## Performance varies — so test your own

I am deliberately not quoting benchmarks. Both filesystems perform well, and the
number you would copy from a blog post depends on your drives, your recordsize or
compression setting, whether the workload is random reads or sequential writes,
and how much cache you can afford. The honest advice is: pick one, learn its two
or three tuning knobs, and measure your actual workload. A filesystem that is 5%
slower on a synthetic test but that you can recover at 2am is the faster one in
practice.

If you want one line: **btrfs for one disk and tight RAM, ZFS for a real array and
a real RAM budget.** And in both cases, snapshots plus **send receive** to
somewhere else, because the filesystem is not the backup.
