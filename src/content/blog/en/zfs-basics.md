---
title: "ZFS basics for people who just want snapshots (and won't lose data)"
description: "A no-theory ZFS basics guide: the four concepts that matter (pool, dataset, snapshot, scrub), the commands you actually type, why ZFS snapshots are not backups and how zfs send receive fixes that, the honest ZFS ARC answer for small machines, the ECC myth, and how to recover."
pubDate: 2026-11-16
lang: en
translationKey: zfs-basics
tags: [homelab, self-hosting, linux]
featured: false
keywords:
  - ZFS snapshots
  - ZFS basics
  - zfs send receive
  - ZFS ARC
  - scrub
  - pool
  - offsite backup
---

I did not learn ZFS by reading a manual. I learned it the way most people do: I
had data I could not afford to lose, I kept hearing that **ZFS snapshots** were
the answer, and I wanted it working tonight. This is the post I wish existed — the
**ZFS basics** that let you take snapshots and sleep, with none of the pool theory
you do not need yet.

If you take one thing from this page, take this: a snapshot on the same machine is
a great *undo button*, not a backup. The rest of the article is how to set it up,
and then how to actually get those snapshots somewhere else so a dead disk is not
a dead archive.

<figure>
<svg viewBox="0 0 640 190" width="100%" role="img" aria-label="A pool of disks holds datasets. Each dataset can be snapshotted. Snapshots stream offsite with zfs send to zfs receive.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="16" y="62" width="120" height="66" rx="8"/>
    <rect x="176" y="62" width="120" height="66" rx="8"/>
    <rect x="336" y="52" width="120" height="86" rx="8"/>
    <rect x="500" y="62" width="120" height="66" rx="8"/>
    <path d="M136 95 h40" marker-end="url(#a)"/>
    <path d="M296 95 h40" marker-end="url(#a)"/>
    <path d="M456 95 h44" marker-end="url(#a)"/>
    <path d="M456 95 c 0 -46 44 -46 44 0" opacity="0.25" stroke-dasharray="4 4"/>
    <defs>
      <marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
        <path d="M0 0 L8 4 L0 8 z" fill="currentColor"/>
      </marker>
    </defs>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="76" y="46">disks</text>
    <text x="236" y="46">dataset</text>
    <text x="396" y="40">snapshot</text>
    <text x="560" y="46">offsite</text>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" text-anchor="middle" opacity="0.9">
    <text x="76" y="90">sda sdb sdc</text>
    <text x="76" y="110" opacity="0.7">pool tank</text>
    <text x="236" y="90">tank/data</text>
    <text x="236" y="110" opacity="0.7">files live here</text>
    <text x="396" y="84">tank/data@2026-11-16</text>
    <text x="396" y="104" opacity="0.7">read-only, frozen</text>
    <text x="396" y="124" opacity="0.7">send | receive →</text>
    <text x="560" y="90">backup/data</text>
    <text x="560" y="110" opacity="0.7">different box</text>
  </g>
</svg>
<figcaption>A pool groups your disks. A dataset is a filesystem inside it. A snapshot freezes one dataset at one moment. <code>zfs send</code> streams that snapshot to another machine, which is what makes it a real backup.</figcaption>
</figure>

## ZFS basics: pool, dataset, snapshot, scrub

Four words. That is the whole vocabulary you need to start.

A **pool** is the storage. You hand ZFS one or more disks and it builds a single
unit out of them. You do not format partitions, you do not mount disks — you give
`zpool` raw devices and it owns them. I name mine `tank` because everyone does, and
because a name that boring is a name you will not forget.

A **dataset** is a filesystem inside the pool. It looks like a directory, it
behaves like one, but it is a seam where you can set compression, quotas, and take
snapshots independently. `tank/data` and `tank/media` can be backed up on
different schedules because they are different datasets.

A **snapshot** is a frozen, read-only view of a dataset at one instant. It takes
almost no space at first, because ZFS only stores the *changes* afterward — that
is what copy-on-write means. Snapshots are named with an `@`: `tank/data@2026-11-16`.

A **scrub** is ZFS walking every block, checking the checksums, and repairing
anything that does not match when it has redundancy to repair with. It is how you
find out a disk is quietly rotting *before* you need the data. You schedule it
monthly and forget about it.

That is the model. Everything else is detail.

## The commands you actually use

This is the entire working set for a basic setup. Create a pool, create a
dataset, snapshot it, look at the snapshots.

```bash
# 1. Create a pool from raw disks (destroys anything already on them).
#    mirror = the two disks hold the same data, so one can die.
sudo zpool create tank mirror /dev/sdb /dev/sdc

# 2. A dataset is where your files actually live.
sudo zfs create tank/data
sudo chown -R "$USER" /tank/data
```

```bash
# 3. Snapshot it. Near-instant, near-free at the moment you take it.
sudo zfs snapshot tank/data@manual-before-upgrade

# 4. See your snapshots, with how much extra space each one costs.
zfs list -t snapshot
zfs list -t snapshot -o name,used,refer tank/data
```

Two habits make this safe. First, snapshot *before* anything risky — a config
change, an upgrade, a delete you are not sure about. Second, name snapshots with
the date when they are automated, so you can read the list later without guessing.

To roll back, you destroy the changes and return to the frozen point:

```bash
# Undo everything since the snapshot (this discards newer changes).
sudo zfs rollback tank/data@manual-before-upgrade
```

And when a snapshot has served its purpose, delete it — snapshots pin old blocks,
so a stale one keeps using space:

```bash
sudo zfs destroy tank/data@manual-before-upgrade
```

## zfs send receive: getting a snapshot off the box

Here is where it stops being a toy. `zfs send` takes a snapshot and streams it as
a byte stream; `zfs receive` writes that stream into a dataset on another system.
First send is the whole dataset. Every send after that can be **incremental** — it
transmits only the blocks that changed since the previous snapshot, which is why
offsite backups of a big dataset become small and fast.

```bash
# Full send the first time.
sudo zfs send tank/data@2026-11-16 | ssh offsite 'sudo zfs receive backup/data'

# After that, incremental: send only the delta since the last snapshot.
sudo zfs send -i tank/data@2026-11-15 tank/data@2026-11-16 \
  | ssh offsite 'sudo zfs receive backup/data'
```

The `-i` is the important flag. It says "starting from the older snapshot, send me
what became the newer one." On the receiving side, the dataset `backup/data`
becomes the matching point, and now your data exists on a second machine.

This is the mechanism behind [backups you can actually restore](/posts/backups-you-can-restore/):
snapshots are the source, `zfs send receive` is the transport. If you are still
deciding on a filesystem, I compared the alternatives in
[btrfs vs ZFS](/posts/btrfs-vs-zfs/).

## Why **ZFS snapshots** are not backups

This is the part I will not soften. A snapshot lives on the same pool as the data
it protects. If the pool dies — controller failure, a bad `zpool` command, a
stolen machine, ransomware that wipes the pool, a fire — every snapshot dies with
it. A snapshot protects you from *yourself*: a bad edit, a mistaken delete, a
botched upgrade. It does not protect you from losing the machine.

A backup has to be a copy on a *different* device, ideally in a *different place*,
and it has to survive the original being gone. Snapshots alone fail both tests.
That is exactly why the send/receive step above matters: the moment the snapshot
lands on the offsite box as its own dataset, it stops being an undo button and
starts being a backup.

Be blunt with yourself: if both copies are on the same physical box, you do not
have a backup. You have a very fast undo button. Both are useful. Only one is a
backup.

## ZFS ARC and RAM: the honest answer for small machines

The **ZFS ARC** is ZFS's read cache. It holds recently-read blocks in RAM so the
next read is instant, and by default it grows to use most of your free memory. On
a NAS with 32–64 GB that is the whole point and part of why ZFS feels fast.

But people read the old advice — "1 GB of RAM per TB of storage" — and panic on a
box with 8 GB. Here is the honest version. That rule describes a busy, large
array under load; it is not a boot requirement. ZFS will run on a small machine
fine. What happens is the ARC competes with your other services for memory, so you
put a ceiling on it.

```bash
# Cap the ARC at 2 GB instead of letting it fill RAM.
echo "options zfs zfs_arc_max=$((2*1024*1024*1024))" \
  | sudo tee /etc/modprobe.d/zfs.conf
sudo update-initramfs -u   # or the equivalent for your distro
# Reboot, then check what it settled at:
arc_summary | grep -i size
```

On modern OpenZFS (2.2 and later), the ARC also gives memory back under pressure
much more gracefully than it used to, so the panic is even less justified. A
practical rule: on 8 GB, cap it around 1–2 GB; on 16 GB, 4 GB is generous; only
let it eat everything on a dedicated storage box. If your machine is RAM-tight
and serving other things, that is a legitimate reason to prefer a lighter
filesystem — the comparison in [btrfs vs ZFS](/posts/btrfs-vs-zfs/) walks through
when that trade is worth it.

## The ECC myth

You will read, repeatedly, that ZFS "needs" ECC RAM. It does not. ZFS is not more
dangerous on non-ECC memory, and non-ECC memory does not corrupt ZFS in some
special way. What is true is that ZFS *trusts* RAM more than most filesystems —
it caches aggressively and verifies checksums in memory — so a genuinely failing
RAM stick can cause more visible damage on ZFS than on ext4, which mostly trusts
the disk to be right anyway.

The correct read: ECC is good insurance for *any* serious storage box, and it is
not a prerequisite for running ZFS. Buy ECC if your budget and board allow it,
because a memory error can hurt you regardless of filesystem. Do not let the myth
stop you from running ZFS on a normal machine with normal RAM. Millions of people
do, every day, without incident.

## Recovery when something goes wrong

Most ZFS mistakes are recoverable, and the honest skill is knowing the difference
between "roll back" and "stop touching it."

**I changed or deleted a file.** Snapshot, roll back — covered above. This is the
common case and it is easy.

**I deleted a dataset by accident.** If the snapshot still exists, you can clone
it back into a live dataset without a full restore:

```bash
sudo zfs clone tank/data@2026-11-16 tank/data-restored
# Inspect /tank/data-restored, copy out what you need, then clean up:
sudo zfs destroy tank/data-restored
```

**A disk failed.** ZFS tells you, loudly, in `zpool status`. Replace the disk and
resilver — it rebuilds the missing data from the surviving copy:

```bash
zpool status            # see which disk is faulted
sudo zpool replace tank /dev/sdb /dev/sdd
sudo zpool status -v    # watch the resilver finish
```

**The pool will not mount after a bad shutdown.** Before you run anything
destructive, try importing it read-only, and let ZFS roll back the last few
transactions if needed:

```bash
sudo zpool import -F -n tank   # -n = dry run, show what it would do
sudo zpool import -F tank      # then actually import, rolling back txgs
```

The one rule above all others: when a pool is misbehaving, **do not run
`zpool destroy` or `-f` flags** because a forum told you to. Import read-only,
get the data off, and ask for help before you make the situation permanent. The
data being on a second box — the send/receive you set up earlier — is what turns
a disaster into an inconvenience.

## A nightly snapshot and offsite send

Here is the whole thing wired together. This script keeps seven daily snapshots
locally and ships each new one to an offsite box. Put it in cron at 02:30, or as a
systemd timer if that is your style.

```bash
#!/usr/bin/env bash
set -euo pipefail

DATASET="tank/data"
DEST_HOST="offsite"
DEST_DATASET="backup/data"
TODAY="$(date +%F)"
YESTERDAY="$(date -d yesterday +%F)"

# 1. Take today's snapshot.
zfs snapshot "${DATASET}@${TODAY}"

# 2. Send it offsite. If yesterday's snapshot exists there, send only the delta.
if ssh "${DEST_HOST}" "zfs list -t snapshot -H -o name" | grep -q "@${YESTERDAY}$"; then
  zfs send -i "${DATASET}@${YESTERDAY}" "${DATASET}@${TODAY}" \
    | ssh "${DEST_HOST}" "zfs receive ${DEST_DATASET}"
else
  zfs send "${DATASET}@${TODAY}" \
    | ssh "${DEST_HOST}" "zfs receive ${DEST_DATASET}"
fi

# 3. Drop local snapshots older than 7 days.
zfs list -t snapshot -H -o name "${DATASET}" \
  | awk -F@ -v cutoff="$(date -d '7 days ago' +%F)" '$2 < cutoff' \
  | xargs -r -n1 zfs destroy
```

Add one more line to a monthly cron and you have self-healing storage:

```bash
# First Sunday of the month, verify every block and repair what redundancy allows.
zpool scrub tank
```

## The short version

Learn four words — pool, dataset, snapshot, scrub. Use four commands —
`zpool create`, `zfs create`, `zfs snapshot`, `zpool scrub`. Then add `zfs send
receive` and get those snapshots onto a second machine, because **ZFS snapshots**
are an undo button and only the offsite copy is a backup. Cap the **ZFS ARC** if
your box is small, ignore the ECC myth, and know that `zpool import -F` and a
cloned snapshot will save you long before you ever need to panic.
