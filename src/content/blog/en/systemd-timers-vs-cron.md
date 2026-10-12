---
title: "systemd timers vs cron: why I stopped using cron"
description: "A look at systemd timers vs cron: same job as a crontab line vs a .service + .timer pair, journalctl logging, Persistent=true catch-up, OnCalendar syntax, RandomizedDelaySec, resource limits, environment handling, and the systemd-analyze calendar trick — plus when cron is still the right call."
pubDate: 2026-10-20
lang: en
translationKey: systemd-timers-vs-cron
tags: [systemd, linux, devops]
featured: false
keywords:
  - systemd timers vs cron
  - systemd timer
  - OnCalendar
  - cron alternative
  - systemd-analyze calendar
  - journalctl
---

I ran cron for years without thinking about it. Then I started deploying real
things — this blog, a few small APIs, a nightly backup — and cron's failure
modes kept costing me time. Jobs vanished silently. A backup that "ran every
night" hadn't run in eleven days. Debugging meant grepping `/var/log/syslog` and
guessing.

So I moved scheduling to systemd — not out of ideology, but because the fix for
every one of those problems was already installed. This is the honest
comparison of **systemd timers vs cron** I wish I'd read first, with the same job
written both ways, a migration path, and the cases where I still reach for cron.

## systemd timers vs cron: the short version

A **systemd timer** is not a scheduler that replaces cron's crontab; it is a
`.timer` unit that triggers a `.service` unit. The work lives in a normal service
definition, so it inherits everything systemd already knows how to do:
dependency ordering, the journal, cgroups, and per-unit sandboxing. Cron needs
its own answer to each of those, and for most of them the answer is "none by
default".

The trade is real: cron is one line; a systemd timer is two small files. On a toy
box, cron wins on ceremony. The moment your job has a failure mode you need to
see, the two files pay for themselves.

## The same job, twice

Here is one job: every night at 03:30, back up a database and ship it off-box.

The cron version is one line in `/etc/cron.d/backup` — which is exactly its
appeal and exactly its problem:

```cron
# /etc/cron.d/backup
30 3 * * * backup /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1
```

The systemd version is a service plus a timer. The service holds the work:

```ini
# /etc/systemd/system/backup.service
[Unit]
Description=Nightly database backup
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=backup
Group=backup
ExecStart=/usr/local/bin/backup.sh

# Resource limits and a deadline, enforced by cgroups
MemoryMax=512M
CPUQuota=80%
TimeoutStartSec=30min

# Cheap hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/backup
```

The timer holds only the schedule:

```ini
# /etc/systemd/system/backup.timer
[Unit]
Description=Run the nightly backup

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

Enable it with `systemctl enable --now backup.timer`. Note what the pair buys you
that the cron line cannot express: a memory ceiling, a CPU quota, a hard timeout,
a restricted filesystem, jitter, and catch-up — all in the unit, not in a shell
script you have to remember to harden.

## Logging: journalctl versus hoping

Cron mails `stdout`/`stderr` to `MAILTO` — which on a machine with no MTA goes
nowhere, and on one with an MTA goes to a mailbox nobody reads. That is the
eleven-day-old backup bug in one sentence.

With a timer, the service's output lands in the journal automatically, tagged
with the unit name:

```bash
# Everything this job has ever said
journalctl -u backup.service

# Just the most recent run
journalctl -u backup.service --since "1 day ago"

# Follow it live while you test
journalctl -fu backup.timer
```

`--since`, `--until`, `-o json`, persistent storage across reboots, and rotation
all come for free. This is the single biggest reason I switched: my first
debugging step went from "grep syslog and pray" to "one command that cannot be
wrong".

## Dependencies and ordering

Cron has no concept of "run this after that, as long as the network is up". You
either chain commands with `&&` or you add a `sleep 30` and hope. That hope is
why half the crontabs I've seen start with a sleep.

A systemd timer can require real units. The `After=`/`Wants=network-online.target`
in the service above means systemd won't start the backup before the network is
actually online. You can order against a database, a mount, or another service
the same way, and systemd will refuse to run the job out of order rather than
letting it fail mysteriously.

## OnCalendar: schedule syntax you can read

Cron's five fields are terse in a way that makes `0 3 */2 * 5` a puzzle. The
**OnCalendar** expression trades a few characters for readability:

```ini
OnCalendar=*-*-* 03:30:00        # every day at 03:30
OnCalendar=Mon *-*-* 04:00:00    # Mondays at 04:00
OnCalendar=*-*-1 02:00:00        # the 1st of every month
OnCalendar=Mon..Fri 09:00        # weekdays at 09:00
OnCalendar=*:0/15                # every 15 minutes
```

It covers what cron does, plus sub-minute intervals and named weekdays, and it
reads left to right as "date, then time". Two footguns: a timer with *only*
`OnCalendar` and no `Persistent=true` silently skips a fire the machine missed
while off, and repeated `OnCalendar` lines stack as a union of triggers, not an
override.

## systemd-analyze calendar: the one trick

You do not have to guess whether an expression means what you think. systemd
ships a validator, and it prints the human answer plus the next times it will
fire:

```bash
$ systemd-analyze calendar "Mon..Fri *-*-* 09:00:00"
  Original form: Mon..Fri *-*-* 09:00:00
Normalized form: Mon..Fri *-*-* 09:00:00
    Next elapse: Mon 2026-10-26 09:00:00 CST
       (in UTC): Mon 2026-10-26 01:00:00 UTC
       From now: 14h left
```

`Normalized form` tells you what systemd actually parsed — the fastest way to
catch a day-of-week or timezone mistake. `Next elapse` proves the schedule is
what you meant. I run this before enabling any new timer, and it has caught more
bugs than any review.

## Persistent=true: catching up on missed runs

This is the **cron alternative** feature I did not know I needed. `Persistent=true`
makes systemd remember the last time the timer fired, and if the scheduled moment
passed while the machine was off or suspended, it runs the job once on the next
boot.

That is the correct behavior for a backup, a certificate renewal, or a cache
warm-up: the job has a job to do, not a deadline to meet. With cron, a box that
was down at 03:30 simply loses that day's backup, and unless you are checking,
you will not know for a week.

## Accuracy and RandomizedDelaySec

Two more knobs cron makes you fake with sleeps. `AccuracySec` lets systemd
coalesce wakeups — the default is 1 minute, and loosening it lets the kernel batch
timers to save power. `RandomizedDelaySec` adds jitter, which matters when many
machines run the same job and you do not want them all hitting a server at the
same second:

```ini
[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=600
AccuracySec=1min
```

Ten minutes of jitter, spread by the scheduler itself, is one line. The cron
equivalent is `$((RANDOM % 600))` inside the script plus a `sleep`, and it lies to
you about when the job actually starts.

## Resource limits and environment

Cron runs your job with a nearly empty environment. `PATH` is truncated, your
`~/.bashrc` is not sourced, and the classic bug is a script that works in your
shell and fails under cron because `node`, `npm`, or a virtualenv is not on
`PATH`. The fix is to hardcode paths or source a profile in every script.

A systemd service declares its environment explicitly, so there is no ambient
state to guess at:

```ini
[Service]
Environment=PATH=/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-/etc/backup/env
```

`EnvironmentFile=-` (the `-` means "missing file is fine") is where secrets and
per-host values live. Beyond environment, the unit gets real resource control
through cgroups — `MemoryMax=`, `CPUQuota=`, `TasksMax=`, `IOWeight=` — which cron
has no equivalent for at all. A runaway job is killed instead of eating the box.

## When a systemd timer fails, you can see it

Failure visibility is where the two diverge most. A cron job that fails is a line
in a log or a bounce email you never configured. A failed systemd unit is a
first-class state:

```bash
systemctl list-timers --all          # what fires next, and when it last ran
systemctl status backup.service      # exit code, exit reason, last log lines
systemctl --failed                   # every broken unit on the box
```

`list-timers` alone is worth the migration: it shows the next elapse, the last
elapse, and how long ago — a scheduling view cron has never given you. And
because a failed unit is visible to the rest of the system, you can attach
`OnFailure=` to the unit and have it fire a notification service, or alert on
`systemctl --failed` from your monitoring. The failure stops being silent.

## Migrating from cron to a systemd timer

The move is mechanical, and you can do it one job at a time:

1. Write the script so its exit code is honest — `set -euo pipefail`, and exit
   non-zero on failure. systemd keys off that code.
2. Convert each crontab line into a `.service` that runs the script, and a
   `.timer` whose `OnCalendar` matches the old schedule.
3. Verify the schedule with `systemd-analyze calendar`.
4. `systemctl daemon-reload`, then `systemctl enable --now name.timer`. Check the
   very next run with `journalctl -u name.service` before you trust it.
5. Comment out (do not delete) the cron line, run both for a few days, then
   remove it. Belt and braces while you learn the timer's habits.

Keep one job per timer. Bundling ten jobs into one service means one failing job
marks the whole unit failed and you cannot see which. `OnUnitActiveSec=1h` and
`OnBootSec=` are the timer equivalents of "every N minutes" and "@reboot" if your
old schedule used those.

## When cron is still the right tool

I am not telling you to rip cron out everywhere. Cron is still the better choice
when:

- **The system is tiny or minimal.** Alpine, BusyBox, a container with no systemd,
  a router — cron (or `crond`) is there and systemd is not. Two files are worse
  than one line when one line is all the platform supports.
- **You want a user crontab.** A per-user `crontab -e` runs as that user with no
  root at hand, which is genuinely convenient on a shared box. systemd user
  timers exist, but they need `loginctl enable-linger` and a running user
  manager, which is more moving parts than a personal `crontab -e`.
- **It is throwaway.** A one-off `@reboot` for a lab VM, or a job you will delete
  next week, does not deserve a unit file and a `daemon-reload`.

The rule I use: cron for the small, disposable, and systemd-less; a **systemd
timer** for anything I would be annoyed to discover had silently stopped. If a
job's failure would make me lose data, miss a renewal, or waste an afternoon
debugging, it belongs in a unit.

That is the whole argument for moving off cron. Not that cron is broken — it is
not — but that for jobs that matter, the journal, the dependencies, the
`Persistent=true` catch-up, and a `systemctl status` that tells the truth are all
already on the box. The same machinery runs this site; if you want to see one
box doing all of it, read [self-hosting without Docker](/posts/self-hosting-without-docker/)
and [how this blog ships itself](/posts/how-this-blog-ships-itself/).
