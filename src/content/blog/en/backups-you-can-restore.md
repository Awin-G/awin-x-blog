---
title: "Backups you can actually restore: 3-2-1 backup for a one-person homelab"
description: "A blunt 3-2-1 backup strategy for a one-person homelab: why the only metric that matters is a successful restore, what to back up (data, config, secrets), how to choose between rsync, restic and borg, how to automate a run-and-verify loop, and how to run a real test restore before you need one."
pubDate: 2026-10-23
lang: en
translationKey: backups-you-can-restore
tags: [self-hosting, linux, devops]
featured: false
keywords:
  - 3-2-1 backup
  - restic
  - backup strategy
  - test restore
  - offsite backup
---

Every backup post opens with the same line: nobody tests their backups. True, and
useless, because it never says what to do instead. This is the version I wish I
had when I started running a **backup strategy** for a homelab of one box. The
whole thing rests on one idea: a **3-2-1 backup** is not a job you run, it is a
claim you have to prove — and the only way to prove it is a **test restore** you
have actually performed. **restic** is what I use to make that provable.

I run one public VPS, an overlay network, and a handful of services. Small blast
radius, but still my data: the blog source, a Gitea instance, config, a password
vault, a mail spool. The backup is not a checkbox; it is the one system on the box
I allow to be boring and loud at once.

## The only metric that matters is a successful restore

A backup that completed is a promise. A restore that completed is a fact. These
are not the same event, and the gap between them is where decades of ransoms and
outages live.

`restic backup` exits 0, `rsync` exits 0, your vendor snapshot says "successful"
in green. That only proves data moved somewhere. It does not prove the data is
readable, complete, decryptable with a key you still have, or restorable into a
working service. I have watched a "green" job produce truncated archives because
a disk filled up mid-copy, exit code still 0.

So the metric I track is not "last backup: ok". It is:

- When was the last time I restored something and it worked?
- Did the restore include the config and secrets needed to start the service?
- Did I time it, so I know the real RTO?

Everything else — tool, schedule, offsite bucket — serves that number. If you
have never restored, you have a hypothesis, not a backup.

## The 3-2-1 backup rule, restated for real people

The classic rule: **3** copies of the data, on **2** different media, with **1**
offsite. For a team with a tape library this is literal. For one person it needs
a translation.

- **3 copies** means the working copy plus two backups. Most people have one
  "backup" that is really another folder on the same disk — zero backups.
- **2 media** in practice means two failure domains: the local disk and a
  *different* machine or cloud bucket. A second disk in the same box is a second
  copy of a dead box.
- **1 offsite** means the copy survives your house, your landlord, or your
  provider deleting your account. If a fire or a `rm -rf` from a compromised
  session can reach all copies, you have none.

My translation for a homelab of one: the working copy on the VPS, a restic repo
on a second host over the overlay, a restic repo on object storage elsewhere. One
tool with two targets is fine — two independent targets is the point.

## What to back up: data vs config vs secrets

The mistake is backing up "the server". You do not want the server back, you want
the services back. That splits into three kinds of things, and they need
different treatment.

- **Data** — what you cannot regenerate: the database, the blog's markdown,
  uploads, the mail spool, a password vault. Lose it and it is gone forever.
- **Config** — `nginx` sites, systemd units, crontabs, `.env` files, firewall
  rules. Small, and usually what makes a restore take an hour instead of ten
  minutes. Back it up, and keep it in version control if you can.
- **Secrets** — TLS keys, database passwords, API tokens, SSH host keys. Back
  them up *encrypted*, never in plaintext git. A restore that brings the data back
  but not the keys to decrypt it has restored nothing.

### The database-vs-files distinction, and why a live copy is a trap

Files and databases want different things. Files are calm — copy the bytes, they
are the bytes. A running database is not. Copying `data/` or the `.sqlite` file
while the engine is writing produces a torn, inconsistent file: it may look fine
and fail to open, or open and silently be missing a transaction. That is the
trap — success at the filesystem level, failure at the data level.

Two honest options. Dump-then-back-up, portable and consistent:

```bash
# Postgres: a consistent logical dump, then back up the dump
pg_dump --format=custom --file=/srv/backup/db.dump mydb
restic backup /srv/backup/db.dump

# SQLite: use the built-in online backup, never a bare cp of a hot file
sqlite3 /var/lib/app/app.db ".backup '/srv/backup/app.db'"
```

Or filesystem snapshots (LVM, ZFS, btrfs) and back up the snapshot — consistent
by construction. What is not an option is `cp` or `rsync` on a live database
directory and calling it done: dump it, or snapshot it.

## Tooling tiers: rsync, restic, borg, vendor snapshots

There is no single tool, only a tier for each problem.

- **rsync** — a mirror, not a backup. Great for config and large cold data, fast,
  everywhere. Its flaw is the mirror itself: delete a file and it deletes the
  copy; get hit by ransomware and the mirror follows. It gives you one live copy,
  not history.
- **restic** — my default. Single static binary, encrypted by default, deduplicated,
  snapshot-based with retention policies, and it talks to both a local repo and
  object storage (S3, B2, rclone). It gives you version history and a real
  integrity check.
- **borg** — the other serious option. Excellent deduplication and compression, and
  it forces a stricter repository model. If you know borg, keep borg; the argument
  is not borg vs restic, it is snapshotting with retention vs mirroring.
- **Vendor snapshots** — ZFS send, btrfs snapshots, cloud volume snapshots. Fine as
  a *third* copy, dangerous as your only one: same failure domain as the disk,
  often not exportable, and exactly as deletable as the data by whoever holds the
  API key.

### Why an encrypted, deduplicated, offsite backup matters

Three properties, three concrete reasons.

- **Encrypted**: the offsite copy is someone else's computer. Object storage gets
  breached, a stolen laptop holds your repo, the provider reads your bucket. An
  unencrypted offsite backup is a data leak you scheduled. Encrypt before the
  bytes leave the box so the remote side never sees plaintext.
- **Deduplicated**: you can afford to keep many versions. Full copies every night
  are why people keep only three days of history. Dedup makes `--keep-daily 7
  --keep-weekly 4 --keep-monthly 12` cheap, so a mistake you notice in a month is
  still recoverable.
- **Offsite**: the copy must survive the failure of its source. Local disk, fire,
  and a compromised login are the same event unless one copy is somewhere else
  entirely.

## A concrete restic backup strategy

Here is the whole thing for one repo, local repository on a second host, then a
second target offsite. One-time setup:

```bash
# Initialise an encrypted repo. The password is not backed up by this command —
# store it in your password vault, or you get to keep the ciphertext forever.
export RESTIC_REPOSITORY=sftp:backup@second-host:/srv/restic/blog
export RESTIC_PASSWORD_FILE=/etc/restic/blog.pass
restic init
```

The nightly backup, with exclude and one-shot integrity from the exit code:

```bash
#!/usr/bin/env bash
# /usr/local/bin/backup.sh
set -euo pipefail
export RESTIC_REPOSITORY=sftp:backup@second-host:/srv/restic/blog
export RESTIC_PASSWORD_FILE=/etc/restic/blog.pass

pg_dump --format=custom --file=/srv/stage/db.dump mydb
sqlite3 /var/lib/app/app.db ".backup '/srv/stage/app.db'"

restic backup /srv/stage /etc /srv/www \
  --exclude='*.sock' --exclude='*/cache/*' --tag host:vps

# Retention: keep a real history, not just last night
restic forget \
  --keep-daily 7 --keep-weekly 4 --keep-monthly 12 \
  --prune

# Read back a random slice of the repo and verify checksums
restic check --read-data-subset=5%
```

Then the offsite target, same script, second repository — `restic copy` moves
snapshots over without two independent histories to prune twice:

```bash
export RESTIC_REPOSITORY=sftp:backup@second-host:/srv/restic/blog
restic copy --repo2 s3:s3.example.com/blog-backup
```

`restic forget` is the part people skip, then wonder why the repo is 400 GB:
`--prune` reclaims space, forgetting alone just marks snapshots for deletion. And
`restic check --read-data-subset=5%` separates "metadata is fine" from "bytes are
readable"; run the full `--read-data` occasionally, not nightly.

## Automating with a run-and-verify loop

A **backup strategy** that depends on you remembering to run it is not a strategy.
Put the script on a timer and make the loop verify itself. I use systemd for this:
run and verification live in units, and a failure is a visible state, not a log
line nobody reads.

```ini
# /etc/systemd/system/backup.timer
[Unit]
Description=Run the nightly backup

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
```

`Persistent=true` is the important line: if the box was off at 03:30, the job runs
once on next boot instead of skipping a day. Pair the timer with a service running
`backup.sh`, and add an `OnFailure=` unit that pages you — or the staleness check
below, alerting when the newest snapshot is over 48 hours old:

```bash
# Alert if the latest snapshot is stale — a job that stopped silently
LATEST=$(restic snapshots --latest 1 --json | jq -r '.[0].time')
AGE=$(( ( $(date +%s) - $(date -d "$LATEST" +%s) ) / 3600 ))
[ "$AGE" -lt 48 ] || echo "backup stale: ${AGE}h" | mail -s "backup stale" me@example.com
```

The verify half matters more: "the timer fired" is not "the backup is good".
Make the absence of fresh, verified snapshots an alarm.

## The test restore ritual: run a restore drill

This is the section that turns a backup into a restorable backup. Once a quarter,
restore for real, into a scratch location, and time it. Not "restic ls". An
actual restore.

```bash
# List what you have, then restore one snapshot to a scratch dir
restic snapshots
restic restore latest --target /tmp/restore --include /srv/www

# Prove the database dump is usable, not just present
mkdir /tmp/restore/db && cd /tmp/restore/db
pg_restore --clean --if-exists --dbname=restore_test /tmp/restore/srv/stage/db.dump

# And prove the files are the files
diff -rq /tmp/restore/srv/www /srv/www | head
```

The drill answers three questions out loud: did it restore, does it run, how long
did it take? If the restored service will not start because the `.env` was not in
the backup, you found the bug on a quiet afternoon instead of at 2 a.m. after a
disk death. A **test restore** you have done once beats any dashboard.

Keep the ritual cheap, or you will skip it. Automate the drill too: restore the
latest snapshot to a scratch VM weekly, start the service, curl its health
endpoint, tear it down. The quarterly human drill then just confirms the
automation told the truth.

## Anti-patterns that quietly cost you everything

- **Backups on the same disk.** The most common "backup" is a folder next to the
  original. One dead disk takes both. One bad `rm -rf` takes both.
- **Untested backups.** A backup you have never restored is a hope with a green
  checkmark. Until a restore works, you do not have a backup; you have a copy and
  a feeling.
- **Backup jobs that silently fail.** The cron line with output to nowhere, the
  timer never re-enabled after an upgrade, the bucket whose credentials expired —
  all fail *quietly*, for weeks. The fix is to alert on staleness, not success:
  alert when the newest verified snapshot is too old, and you catch every one of
  these, including the ones you did not predict.
- **A mirror where you wanted history.** `rsync --delete` and volume snapshots
  replicate your deletion and your corruption. Keep at least one target with
  version history and retention.

None of this is exotic: one script, one timer, two independent encrypted targets,
a retention policy, and a restore drill you actually run. The tooling is free;
the discipline is the whole cost. For the box this runs on, start with [what I
self-host in 2026](/posts/what-i-self-host-2026/) and
[self-hosting without Docker](/posts/self-hosting-without-docker/) — a backup is
only as good as the services it is meant to bring back.
