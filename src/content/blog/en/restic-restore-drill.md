---
title: "The backup drill: proving you can actually restore (with restic)"
description: "A restic backup restore drill, start to finish with real output: init, encrypted deduplicated backup, restic forget retention and prune, check --read-data, a wipe-and-restore, content-hash and diff verification, a timer plus a dead man's switch, and the 3-2-1 anti-patterns."
pubDate: 2026-12-13
lang: en
translationKey: restic-restore-drill
tags: [self-hosting, devops, linux]
featured: false
keywords:
  - restic
  - backup restore drill
  - restic forget
  - 3-2-1 backup
  - deduplication
---

Every backup post opens the same way: a backup you have never restored is a
rumour, not a backup. I say it too. So this time I did not write about it — I ran
a **backup restore drill** with **restic**: built a small realistic dataset,
backed it up, deleted the original, restored it, and compared the bytes. Below is
the real terminal output, including a mistake I made that quietly did nothing
until I looked. The point of a **3-2-1 backup** is not that the job ran; it is that
recovery is a demonstrated fact.

Most restic quickstarts stop at `restic backup`, print `snapshot saved`, and
relax. That is the wrong half. The half that matters is the drill: destroy the
source on purpose, rebuild it from the repository, then prove the rebuild is the
same data. This post is that half.

<figure>
<svg viewBox="0 0 660 150" width="100%" role="img" aria-label="Production data is backed up into an encrypted, deduplicated restic repository, and a restore drill reads it back into a scratch target where a hash and diff comparison proves the bytes match.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="8" y="46" width="120" height="58" rx="8"/>
    <rect x="182" y="46" width="140" height="58" rx="8"/>
    <rect x="376" y="46" width="120" height="58" rx="8"/>
    <rect x="540" y="46" width="112" height="58" rx="8"/>
    <path d="M128 75 h50" marker-end="url(#ar)"/>
    <path d="M322 75 h50" marker-end="url(#ar)"/>
    <path d="M496 75 h40" marker-end="url(#ar)"/>
    <path d="M596 104 c 0 30 -540 30 -540 0" stroke-dasharray="4 4" opacity="0.5"/>
    <defs>
      <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
        <path d="M0 0 L8 4 L0 8 z" fill="currentColor"/>
      </marker>
    </defs>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="68" y="72">production</text>
    <text x="68" y="90" opacity="0.75">/srv/data</text>
    <text x="252" y="68">restic backup</text>
    <text x="252" y="86" opacity="0.75">encrypt + dedup</text>
    <text x="436" y="68">repo</text>
    <text x="436" y="86" opacity="0.75">ciphertext only</text>
    <text x="596" y="72">restore</text>
    <text x="596" y="90" opacity="0.75">+ verify</text>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" text-anchor="middle" opacity="0.7">
    <text x="330" y="132">diff -rq · sha256sum · PRAGMA integrity_check</text>
  </g>
</svg>
<figcaption>The drill: production feeds an encrypted, deduplicated repository; the restore pulls it back into a scratch target; the hash and diff comparison — not the green exit code — is what proves it worked.</figcaption>
</figure>

## Why a backup you have not restored is a rumour

A completed backup is a promise. A completed restore is a fact. The gap between
them is where the outages live.

`restic backup` exiting 0 proves a snapshot was written and indexed. It does not
prove the data reads back, that your password still opens it, that the disk did
not fill mid-write, or that the config needed to boot the service is inside the
snapshot. I have seen a "successful" job produce a repository missing the one
`.env` that made the app start. Green check, dead service.

So the metric I track is not "last backup: ok". It is: when did I last restore,
did it work, and how long did it take? A **restore drill** converts the promise
into a fact on a quiet afternoon, instead of discovering the gap at 2 a.m. with
the disk already dead.

## A concrete restic restore drill, with real output

I ran this against a scratch directory, but nothing depends on Docker — restic is
a single static binary, so the same commands run on any box. The dataset is small
on purpose: thirteen files, a live SQLite database, a `pg_dump`-style dump,
config, and a couple of binary uploads, about 320 KiB.

The one-time setup: `restic init` creates the encrypted repository. Read the
output — it is the most important warning in the tool:

```console
$ export RESTIC_REPOSITORY=/srv/repo
$ export RESTIC_PASSWORD_FILE=/srv/restic-pass
$ restic init
created restic repository 93e77c5df7 at /srv/repo

Please note that knowledge of your password is required to access
the repository. Losing your password means that your data is
irrecoverably lost.
```

The password is not stored in the repository. Lose it and the ciphertext is
permanent noise. Every other decision below assumes you solved this first.

Now the backup. The first run reads everything:

```console
$ restic backup /srv/data --host blog-vps --tag host:drill,role:blog
no parent snapshot found, will read all files

Files:          13 new,     0 changed,     0 unmodified
Dirs:           15 new,     0 changed,     0 unmodified
Added to the repository: 330.333 KiB (319.476 KiB stored)

processed 13 files, 321.484 KiB in 0:00
snapshot eb840398 saved
```

The next night, almost nothing is new — **deduplication** in action: a 321 KiB
tree where the repository grew by 5.5 KiB because one file changed.

```console
$ restic backup /srv/data --host blog-vps --tag host:drill,role:blog
using parent snapshot eb840398

Files:           0 new,     1 changed,    12 unmodified
Dirs:            0 new,     6 changed,     9 unmodified
Added to the repository: 5.499 KiB (2.697 KiB stored)

processed 13 files, 321.518 KiB in 0:00
snapshot 55b2cc84 saved
```

I let it run for ten nights, pinning each snapshot's time with `--time` to
simulate a week of history. The list is the truth of what you can restore:

```console
$ restic snapshots
ID        Time                 Host        Tags                  Paths      Size
---------------------------------------------------------------------------------------
eb840398  2026-10-03 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.484 KiB
55b2cc84  2026-10-04 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.518 KiB
20334f84  2026-10-05 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.551 KiB
7818323d  2026-10-06 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.584 KiB
12c6b55b  2026-10-07 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.617 KiB
719105e8  2026-10-08 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.650 KiB
58eacf5e  2026-10-09 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.684 KiB
7745a0b5  2026-10-10 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.717 KiB
2a183a32  2026-10-11 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.750 KiB
4e6261dd  2026-10-12 03:30:00  blog-vps    host:drill,role:blog  /srv/data  321.783 KiB
---------------------------------------------------------------------------------------
Timestamps shown in UTC
10 snapshots
```

## Retention with restic forget, and why prune is not optional

Ten snapshots is fine; ten thousand is a repo nobody can afford offsite. `restic
forget` applies a retention policy — a week of dailies, a month of weeklies, a
year of monthlies:

```console
$ restic forget --compact --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --dry-run
Applying Policy: keep 7 daily, 4 weekly, 12 monthly snapshots
keep 9 snapshots:
...                                        (the kept snapshots, abbreviated)

remove 1 snapshots:
ID        Time                 Host      Tags        Size
----------------------------------------------------------------
20334f84  2026-10-05 03:30:00  blog-vps  host:drill  321.551 KiB
                                         role:blog
----------------------------------------------------------------
Timestamps shown in UTC
1 snapshots

Would have removed the following snapshots:
{20334f84}
```

I always run `--dry-run` first — it lists the exact IDs it would delete before it
deletes anything. The less obvious part: **the policy is a union, not a cap**. I
asked to keep 7 daily but it kept 9, because two older snapshots were also the
"oldest weekly" and "oldest monthly" ones. `forget` keeps a snapshot if *any* rule
wants it. Do not assume `--keep-daily 7` leaves exactly seven.

Dropping `--dry-run` removes them, and `--prune` reclaims the space they held:

```console
$ restic forget --compact --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune
Applying Policy: keep 7 daily, 4 weekly, 12 monthly snapshots
...
[0:00] 100.00%  1 / 1 files deleted
1 snapshots have been removed, running prune
loading all snapshots...
finding data that is still in use for 9 snapshots
[0:00] 100.00%  9 / 9 snapshots
searching used packs...
collecting packs for deletion and repacking
[0:00] 100.00%  20 / 20 packs processed

to repack:            92 blobs / 341.822 KiB
this removes:          0 blobs / 0 B
to delete:             8 blobs / 2.384 KiB
total prune:           8 blobs / 2.384 KiB
remaining:            92 blobs / 337.506 KiB
unused size after prune: 0 B (0.00% of remaining size)

repacking packs
[0:00] 100.00%  18 / 18 packs repacked
rebuilding index
[0:00] 100.00%  11 / 11 indexes processed
[0:00] 100.00%  11 / 11 old indexes deleted
removing 20 old packs
[0:00] 100.00%  20 / 20 files deleted
done
```

`forget` alone only deletes snapshot references; the data blobs stay until `prune`
runs. Forgetting without pruning is how a repository gets fat while its snapshot
list looks tidy.

### The gotcha that makes restic forget do nothing

Here is the mistake I made. By default `restic forget` groups snapshots by **host
and path** and applies the policy to each group separately. I first ran each
backup in a fresh container, so every snapshot got a different hostname — ten
groups of one — and `--keep-daily 7` kept all ten. The command exited 0. Nothing
was wrong. Nothing was pruned either. Pin `--host` explicitly and keep backup
paths stable, or retention quietly becomes a no-op. A drill is how you notice.

## restic check: the bytes, not just the metadata

`restic check` verifies the repository's structure — index, trees, packs — cheap
enough to run after every backup. But "metadata is consistent" is not "the bytes
are readable". That is `--read-data`:

```console
$ restic check --read-data
using temporary cache in /tmp/restic-check-cache-1742438661
create exclusive lock for repository
load indexes
check all packs
check snapshots, trees and blobs
[0:00] 100.00%  10 / 10 snapshots
read all data
[0:00] 100.00%  20 / 20 packs
no errors were found
```

`--read-data` pulls every blob back, decrypts it, and checks its checksum. On a
terabyte repository that is too expensive nightly; use `--read-data-subset=5%` on
a schedule and the full read monthly. A repository that fails `check --read-data`
is not a backup, it is a countdown.

## The restore drill, step by step

I run it in two phases: a **non-destructive** drill while production is still up,
then the **destructive** proof.

Phase one restores into a scratch target and compares it to the live data. Note
restic's path semantics: it recreates the snapshot's absolute paths *under* the
target, so `/srv/data` lands at `/srv/restore/srv/data`.

```console
$ restic restore latest --target /srv/restore
restoring snapshot 4e6261dd of [/srv/data] at 2026-10-12 03:30:00 +0000 UTC by root@blog-vps to /srv/restore
Summary: Restored 28 files/dirs (321.783 KiB) in 0:00

$ diff -rq data restore/srv/data
(no differences: the restored tree is byte-identical)
```

`diff -rq` answers "are the files the same?" by content, but hashes survive being
moved elsewhere and line up across machines, so I compare manifests too:

```console
$ (cd data && find . -type f -print0 | sort -z | xargs -0 sha256sum) > /tmp/live.sha256
$ (cd restore/srv/data && find . -type f -print0 | sort -z | xargs -0 sha256sum) > /tmp/restored.sha256
$ diff /tmp/live.sha256 /tmp/restored.sha256
(all 13 hashes match)
```

Phase two is the honest version: record the hashes, destroy the original, restore,
compare. No production copy left to fall back on.

```console
$ (cd data && find . -type f -print0 | sort -z | xargs -0 sha256sum) | tee /tmp/original.sha256
61e4b364901df759b038b6fc8f74e9fbc302d06052650a9c6a3990c358ac32a3  ./etc/nginx/sites-enabled/blog.conf
530c005cd52c2534300659fbd4be2faf3260af32ef5a20795c46ed12213963ea  ./etc/systemd/system/blog.service
ec5f7e7f8126bd88d8d600a807ab1460fe17c2807cf115303771d4eb40ce4195  ./srv/backup/db.dump
...
$ rm -rf data
$ ls data
ls: cannot access 'data': No such file or directory

$ restic restore latest --target /srv/restore
restoring snapshot 4e6261dd of [/srv/data] at 2026-10-12 03:30:00 +0000 UTC by root@blog-vps to /srv/restore
Summary: Restored 28 files/dirs (321.783 KiB) in 0:00
```

Then the proof that the restored bytes are the original bytes, and that the
restored database is not just present but openable:

```console
$ (cd restore/srv/data && find . -type f -print0 | sort -z | xargs -0 sha256sum) > /tmp/restored.sha256
$ diff /tmp/original.sha256 /tmp/restored.sha256
(all 13 hashes match)

$ sqlite3 restore/srv/data/var_app.db 'PRAGMA integrity_check; SELECT count(*) FROM posts;'
ok
3
```

A hash match plus a passing SQLite integrity check is a far stronger statement
than "the restore command succeeded". `restic diff` compares two snapshots
directly, and `restic stats --mode raw-data` shows what encryption and dedup
bought you — here, ~2.9 MiB of logical data in a 337 KiB repository:

```console
$ restic stats --mode raw-data
scanning...
[0:00] 100.00%  9 / 9 snapshots, 92 blobs, 337.506 KiB
Stats in raw-data mode:
     Snapshots processed:  9
        Total Blob Count:  92
 Total Uncompressed Size:  378.362 KiB
              Total Size:  337.506 KiB
    Compression Progress:  100.00%
       Compression Ratio:  1.12x
Compression Space Saving:  10.80%
```

## Encrypted, deduplicated, offsite: the 3-2-1 backup in practice

Three properties, three reasons restic earns the learning curve.

**Encrypted** means the offsite copy is safe on someone else's computer. restic
encrypts on the client before bytes leave the box, so object storage, a cheap VPS,
or a friend's server only ever holds ciphertext.

**Deduplicated** means many versions are affordable. Full nightly copies force
people down to three days of history; content-defined chunking lets you keep a
week of dailies and a year of monthlies — the whole point of `restic forget` —
because unchanged blocks are stored once.

**Offsite-capable** means the copy survives the failure of its source. restic
speaks to local disks, SFTP, S3, Backblaze B2, and anything rclone reaches, and
`restic copy` mirrors snapshots between repositories. My translation of **3-2-1**
for one person: the working copy on the box, an encrypted repo on a second host,
and a second repo in object storage that a lone `rm -rf` or a dead disk cannot
reach.

## What to back up, and what to exclude

Back up what you cannot regenerate: application data and databases, the config
that made a service behave the way it did, and secrets. restic encrypts
everything, so a plaintext key file is safe *inside the repository* — but the
repository password is not, and neither is a secrets file sitting beside it. Keep
the restic password in a manager *and* on paper, because a restore that recovers
the data but not the key decrypts nothing.

Then exclude the noise, or backups get slow and expensive for no reason:

```bash
restic backup /srv /etc /var/lib/app \
  --exclude='/proc' --exclude='/sys' --exclude='/dev' --exclude='/run' \
  --exclude='**/node_modules' --exclude='**/.cache' --exclude='**/cache' \
  --exclude='**/tmp' --exclude='*.sock' --exclude='/var/log' --exclude='/var/cache' \
  --tag host:blog-vps
```

Exclude *regenerable* things, not *hard* things: the classic failure is excluding
the build directory and later discovering the build needs a toolchain and a
network you no longer have. For the database-versus-files distinction and a deeper
walk through 3-2-1, see
[backups you can actually restore](/posts/backups-you-can-restore/); if the
repository lives on ZFS, [ZFS basics](/posts/zfs-basics/) covers the snapshot half.

## Scheduling the drill: a timer and a dead man's switch

A backup that depends on you remembering is a wish. Put it on a systemd timer, and
make its *absence* an alarm.

```ini
# /etc/systemd/system/restic-backup.timer
[Unit]
Description=Run the nightly restic backup

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
```

`Persistent=true` means a box that was off at 03:30 runs the job once on next boot
instead of silently skipping a day. The service runs the script, and `OnFailure=`
gives a failure somewhere to go:

```ini
# /etc/systemd/system/restic-backup.service
[Unit]
Description=Nightly restic backup
OnFailure=notify-admin@%n.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/restic-backup.sh
```

The real safety net is a **dead man's switch**: the backup must *report in*, and
the alarm fires when the report is missing. Success pings a heartbeat service as
the last line of the script, so it only runs if everything above exited 0:

```bash
# /usr/local/bin/restic-backup.sh  (tail)
set -euo pipefail
restic backup /srv /etc --tag host:blog-vps
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune
restic check

# dead man's switch: this only fires if every step above succeeded
curl -fsS --retry 3 https://hc-ping.com/your-uuid-here
```

A monitoring service — healthchecks, Uptime Kuma, or a cron job hitting the
`/fail` endpoint — then pages you if no heartbeat arrives. Pair it with a direct
staleness check, so you also catch the job that "succeeded" but stopped producing
snapshots:

```bash
# Alert when the newest snapshot is more than 30 hours old
latest=$(restic snapshots --latest 1 --json | jq -r '.[0].time')
age=$(( ( $(date +%s) - $(date -d "$latest" +%s) ) / 3600 ))
[ "$age" -lt 30 ] || echo "backup stale: ${age}h" | mail -s "backup stale" me@example.com
```

Alert on staleness, not on success. Every silent failure — expired bucket
credentials, a timer disabled by an upgrade, a full disk — shows up as "no fresh
verified snapshot", which is exactly what a dead man's switch notices.

## Anti-patterns that quietly cost you everything

- **The backup on the same disk.** The most common "backup" is a folder next to
  the original. One dead disk, or one bad `rm -rf`, takes both copies.
- **No verify.** A job that exits 0 and a restore you have never run is a rumour
  with a green checkmark. `check --read-data` proves the bytes; a drill proves the
  workflow. Do both, on a calendar.
- **A repository without the password stored safely.** `restic init` warned you in
  its own output: lose the password and the data is irrecoverably gone. Keep it in
  a password manager and on paper in a drawer you can physically reach.
- **A mirror where you wanted history.** `rsync --delete` and volume snapshots
  replicate your deletions and your corruption. Keep at least one target with
  version history and retention.

One script, one timer, one dead man's switch, and a restore drill you actually run
beats any dashboard. The tooling is free; the discipline is the entire cost. A
backup you have restored is not a rumour — it is a fact you own.
