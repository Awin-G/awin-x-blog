---
title: "journalctl in practice: the systemd journal you're already running"
description: "A hands-on tour of journalctl and the systemd journal on a real Arch host: filter by unit, priority and time, follow logs live, read journal fields like _SYSTEMD_UNIT and _PID, add custom fields, script with -o json, and manage journald retention with --disk-usage and vacuum."
pubDate: 2027-01-13
lang: en
translationKey: journald-in-practice
tags: [systemd, linux]
featured: false
keywords:
  - journalctl
  - systemd journal
  - structured logs
  - journald retention
  - -o json
---

Last week my overlay-network box started flapping: a tunnel reconnected
every few seconds, all day. My first instinct was wrong — I reached for
a log file. There is no `/var/log/syslog` on this box, no `rsyslogd`,
nothing to tail. Everything is already in the **systemd journal**, and
`journalctl` is the query tool that comes with it. Tour below, with
real output from this machine (systemd 262, Arch, uid 1000, no root).

## What the systemd journal is, and what it isn't

You already have a log collector: `systemd-journald`, running since boot:

```
$ systemctl status systemd-journald --no-pager | head -5
● systemd-journald.service - Journal Service
     Loaded: loaded (/usr/lib/systemd/system/systemd-journald.service; static)
     Active: active (running) since Mon 2026-10-12 04:12:29 CST; 1 day 2h ago
 Invocation: 2b2b752b93d34dceb14e1636a48c33e9
TriggeredBy: ● systemd-journald-dev-log.socket
```

Four channels feed it, and each entry remembers which one it came
through (`_TRANSPORT`): unit stdout/stderr, the `/dev/log` syslog
socket, kernel `kmsg`, and systemd itself.

<figure>
<svg viewBox="0 0 640 250" width="100%" role="img" aria-label="Four ingress channels into journald: unit stdout and stderr, the /dev/log syslog socket, kernel kmsg, and systemd itself. journald writes indexed journal files and serves journalctl, plus journal-remote, gatewayd and vacuum.">
  <g fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="10" y="15" width="180" height="50" rx="8"/>
    <rect x="10" y="80" width="180" height="50" rx="8"/>
    <rect x="10" y="145" width="180" height="50" rx="8"/>
    <rect x="10" y="210" width="180" height="50" rx="8"/>
    <rect x="255" y="80" width="120" height="120" rx="8" stroke-dasharray="4 3"/>
    <rect x="430" y="15" width="200" height="50" rx="8"/>
    <rect x="430" y="80" width="200" height="50" rx="8"/>
    <rect x="430" y="145" width="200" height="50" rx="8"/>
    <rect x="430" y="210" width="200" height="50" rx="8"/>
  </g>
  <g stroke="currentColor" stroke-width="1.2" marker-end="url(#ah)">
    <line x1="195" y1="40" x2="250" y2="115"/>
    <line x1="195" y1="105" x2="250" y2="135"/>
    <line x1="195" y1="170" x2="250" y2="155"/>
    <line x1="195" y1="235" x2="250" y2="175"/>
    <line x1="380" y1="140" x2="425" y2="40"/>
    <line x1="380" y1="140" x2="425" y2="105"/>
    <line x1="380" y1="140" x2="425" y2="170"/>
    <line x1="380" y1="140" x2="425" y2="235"/>
  </g>
  <defs>
    <marker id="ah" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-size="12" fill="currentColor" font-family="sans-serif">
    <text x="25" y="45">unit stdout/stderr</text>
    <text x="25" y="110">/dev/log (syslog API)</text>
    <text x="25" y="175">kernel kmsg</text>
    <text x="25" y="240">systemd itself</text>
    <text x="272" y="145" text-anchor="middle">journald</text>
    <text x="443" y="45">journalctl (query)</text>
    <text x="443" y="110">journal files (indexed)</text>
    <text x="443" y="175">remote / gatewayd</text>
    <text x="443" y="240">vacuum / rotation</text>
  </g>
</svg>
<figcaption>Entries arrive from four doors; the trusted <code>_TRANSPORT</code> field tells you which one each came through (<code>stdout</code>, <code>syslog</code>, <code>kernel</code>, <code>journal</code>).</figcaption>
</figure>

An entry is not a line of text. It's key=value fields: the message, a
priority, and trusted metadata (`_PID`, `_SYSTEMD_UNIT`, `_BOOT_ID`,
`_HOSTNAME`, `_SOURCE_REALTIME_TIMESTAMP`, …), stored in indexed binary
files under `/var/log/journal/<machine-id>/`. That's the difference
from plain files: with text logs, "everything PID 582 logged between
06:00 and 06:02" is grep and prayer; in the journal it's an indexed
lookup. Fields beat prose — argued at length in
[structured logging that actually helps you debug at 3am](/posts/structured-logging/).
The flip side is as real: local, binary, single-host files. The journal
is a great *inbox*, not a warehouse.

## The journalctl commands I actually run

The subject: `easytier.service`, an overlay tunnel whose peer stopped
existing. It has been... talkative:

```
$ journalctl -u easytier.service -b --no-pager | wc -l
314214
```

```
$ journalctl -u easytier.service -b -p err --no-pager
-- No entries --
```

314,214 lines and **zero errors** — because the app logs its failures
at `INFO`: the word "error" is in the payload while `PRIORITY=6` says
otherwise. `-p` filters the field, not the text. This is the most
common journalctl trap: severity is whatever the application chose, not
whatever the message looks like.

Window it in time instead:

```
$ journalctl -u easytier.service --since '2026-10-13 06:00' --until '2026-10-13 06:02' \
    --no-pager -o short-iso | head -5
2026-10-13T06:00:00+08:00 BOOK easytier-core[582]: 2026-10-13T06:00:00.661586273+08:00  INFO CORE::INSTANCE::CONNECTION: [f631f13d-e15a-4f52-9b05-8175b9e65788] connecting to peer dst=tcp://10.19.36.13:11010
2026-10-13T06:00:00+08:00 BOOK easytier-core[582]: 2026-10-13T06:00:00.723220791+08:00  INFO CORE::INSTANCE::CONNECTION: [f631f13d-e15a-4f52-9b05-8175b9e65788] connect to peer error dst="tcp://10.19.36.13:11010" ip_version="V4" error=TunnelError(
2026-10-13T06:00:00+08:00 BOOK easytier-core[582]:     IOError(
2026-10-13T06:00:00+08:00 BOOK easytier-core[582]:         Os {
2026-10-13T06:00:00+08:00 BOOK easytier-core[582]:             code: 113,
```

`No route to host`, every two seconds, for a day. The peer is gone from
this network. "What happened between 06:00 and 06:02?" is one flag pair,
not a `sed` range. The rest of my muscle memory:

- `journalctl -b` — this boot; `-b -1` — the previous one. `--list-boots` says what `-1` even means:

```
$ journalctl --list-boots
IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY
 -2 1add3ab9c2e54bf9a157e031a1d1a554 Wed 2026-10-07 23:52:32 CST Sun 2026-10-11 18:43:03 CST
 -1 e1957f396979484bab4890cf6b5e8e3d Sun 2026-10-11 18:43:35 CST Mon 2026-10-12 04:08:59 CST
  0 95dabdf369644974893a7d7afc7071aa Mon 2026-10-12 04:12:23 CST Tue 2026-10-13 06:10:04 CST
```

- `journalctl -f -t mytag` — follow, filtered. I started a writer a second and a half after `-f` was already running:

```
$ ( sleep 1.5; printf 'FOLLOW_TEST=works\n' | systemd-cat -t follow-demo ) &
$ timeout 4 journalctl -f -t follow-demo -o short-iso
2026-10-13T06:14:02+08:00 BOOK follow-demo[669473]: FOLLOW_TEST=works
```

  Not `tail -f` — a live cursor over the whole journal, with the same
  filters applied before anything reaches you.
- `journalctl -k` — kernel messages as journal entries (11,959 this boot here), time-filterable like any unit.
- `journalctl -o cat` — messages only, for `sort | uniq -c` on the chatty lines:

```
$ journalctl -u easytier.service --since '1 hour ago' --no-pager -o cat | sort | uniq -c | sort -rn | head -3
   1664 )
    694         Os {
    694             message: "No route to host",
```

## Fields: the part you can't grep out of a file

`journalctl -o verbose` dumps one entry in full — here, a user service
stopping:

```
$ journalctl --user -u cookbook-heartbeat.service -n 1 -o verbose
Mon 2026-10-12 18:44:20.388473 CST [s=30e8d7b479634a969546b2b7c9da3775;i=2d9b99;b=95dabdf369644974893a7d7afc7071aa;m=c2e584e60;t=65da26165768a;x=3fee6115d101388f]
    PRIORITY=6
    SYSLOG_FACILITY=3
    TID=905
    SYSLOG_IDENTIFIER=systemd
    _TRANSPORT=journal
    _PID=905
    _UID=1000
    _GID=1000
    _COMM=systemd
    _EXE=/usr/lib/systemd/systemd
    _CMDLINE=/usr/lib/systemd/systemd --user
    _SYSTEMD_CGROUP=/user.slice/user-1000.slice/user@1000.service/init.scope
    _BOOT_ID=95dabdf369644974893a7d7afc7071aa
    _MACHINE_ID=b28faf4a0b4a42048f13d6be379f6b10
    _HOSTNAME=BOOK
    CODE_FILE=src/core/job.c
    CODE_LINE=632
    CODE_FUNC=job_emit_start_message
    USER_UNIT=cookbook-heartbeat.service
    MESSAGE=Stopping Cookbook heartbeat demo...
    JOB_TYPE=stop
    MESSAGE_ID=de5b426a63be47a7b6ac3eaac82e2f6f
    USER_INVOCATION_ID=ecd9732670d74c1487a52194a33ca23f
    JOB_ID=2724
    _SOURCE_REALTIME_TIMESTAMP=1791801860388473
```

Underscore fields are set by journald and can't be forged by the
logging process; the rest come from the sender. Filters are
`FIELD=value` pairs:

```
$ journalctl -b --no-pager -o short-iso _PID=582 | head -2
2026-10-13T06:13:19+08:00 BOOK easytier-core[582]:     ),
2026-10-13T06:13:19+08:00 BOOK easytier-core[582]: )
```

```
$ journalctl -b --no-pager _TRANSPORT=kernel | wc -l
13061
```

A gotcha that cost me ten minutes: `_SYSTEMD_UNIT=cookbook-heartbeat.service`
returns nothing for a **user** service. User units live in
`_SYSTEMD_USER_UNIT` (the service's own lines) and `USER_UNIT` (the
manager's job messages) — and plain `journalctl -u X` needs `--user` to
match them:

```
$ journalctl -u cookbook-heartbeat.service --no-pager -o short-iso -n 2
-- No entries --
$ journalctl --user -u cookbook-heartbeat.service --no-pager -o short-iso -n 2
2026-10-12T18:44:20+08:00 BOOK systemd[905]: Stopping Cookbook heartbeat demo...
2026-10-12T18:44:20+08:00 BOOK systemd[905]: Stopped Cookbook heartbeat demo...
```

### Writing your own fields (and a myth to kill)

`systemd-cat -t TAG` sets `SYSLOG_IDENTIFIER`, a real field you filter
with `journalctl -t TAG`:

```
$ printf 'EVENT=deploy\nSTATUS=ok\nrequest_id=7f3a\n' | systemd-cat -t journald-demo
$ journalctl -t journald-demo -o cat
EVENT=deploy
STATUS=ok
request_id=7f3a
```

But those `KEY=value` lines did **not** become fields — check the
structured view: each line landed verbatim in `MESSAGE`:

```
$ journalctl -t journald-demo -o json -n 1
{"SYSLOG_IDENTIFIER":"journald-demo","_PID":"668653", ..., "_TRANSPORT":"stdout", "MESSAGE":"request_id=7f3a", "PRIORITY":"6", "_UID":"1000"}
```

Piping `KEY=value` into `systemd-cat` is the "custom fields" trick half
the internet recommends, and on systemd 262 it does not work. The
native journal socket does — it's a **datagram** socket, so
`printf ... | socat - UNIX-CONNECT:/run/systemd/journal/socket` fails
with `Protocol wrong type for socket` (I tried). One `sendmsg` works:

```python
import socket
s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
s.connect("/run/systemd/journal/socket")
s.send(b"MESSAGE=deploy note\nDEPLOY_ENV=prod\nREQUEST_ID=7f3a\n")
```

```
$ journalctl DEPLOY_ENV=prod --no-pager -o short-iso
2026-10-13T06:15:55+08:00 BOOK python3[673881]: custom field demo via native protocol
```

`DEPLOY_ENV=prod` is now indexable. In real code you'd get the same
from `sd_journal_send()` or a binding; this proves the wire format is
plain text and yours — how you stamp `REQUEST_ID=`, `ENV=`,
`DEPLOY_SHA=` onto entries from cron jobs and scripts.

Plain `logger` also works — it writes to `/dev/log`, where journald
already listens, so syslog-era tools run unchanged:

```
$ logger -t logger-demo -p user.info "hello from plain logger"
$ journalctl -t logger-demo --no-pager -o short-iso
2026-10-13T06:13:37+08:00 BOOK logger-demo[668656]: hello from plain logger
```

(`logger --journald` fails on this box with `无法写入 journald 项` — my
shell is `zh_CN.UTF-8`, so systemd answers in Chinese; that means
"failed to write journal entry". `logger` and `systemd-cat` both work.)

## -o json: the journal as a data source

`-o json` prints one JSON object per entry, every field included,
`__CURSOR` among them. No `jq` on this box, so `python3` it is. Top
talkers this boot:

```python
journalctl -b --no-pager -o json | python3 -c '
import sys, json, collections
c = collections.Counter()
for line in sys.stdin:
    try: d = json.loads(line)
    except Exception: continue
    c[d.get("_SYSTEMD_UNIT") or d.get("_SYSTEMD_USER_UNIT")
      or d.get("SYSLOG_IDENTIFIER") or "?"] += 1
for u, n in c.most_common(6):
    print(f"{n:8d}  {u}")
'
```

```
  314214  easytier.service
   18197  mihomo.service
   12721  kernel
    9110  user@1000.service
    7437  ollama.service
    4333  init.scope
```

The same shape gives a priority histogram — how I know this boot is
99.9% `info` with 25 `err` and 15 `crit`:

```
  368942  info
   10478  warning
     684  notice
     110  debug
      25  err
      15  crit
```

Want fewer fields? `-o json --output-fields=MESSAGE,PRIORITY` trims the
payload (`__CURSOR` stays, by design, so you can paginate). Field
filter plus `--output-fields` plus a cursor is the whole
"consume the journal programmatically" story in one line.

The 15 `crit` entries also sell fields over text: a `systemd-coredump`
entry's payload is a stack trace, but the structured view carries
`COREDUMP_EXE`, `COREDUMP_SIGNAL_NAME`, `COREDUMP_TID` as fields.
"Which binaries coredumped this boot?" is `journalctl -b
COREDUMP_SIGNAL_NAME=SIGABRT`. Try that on a text log.

## journald retention: disk usage, vacuum, and what needs root

This host ships an entirely default `/etc/systemd/journald.conf`:

```
$ grep -nE 'Storage|SystemMaxUse|RuntimeMaxUse|MaxRetentionSec|ForwardToSyslog|MaxLevelStore' /etc/systemd/journald.conf
20:#Storage=persistent
21:#Compress=yes
22:#Seal=yes
23:#SplitMode=uid
27:#SystemMaxUse=
31:#RuntimeMaxUse=
35:#MaxRetentionSec=0
37:#ForwardToSyslog=no
42:#MaxLevelStore=debug
```

`Storage=` commented means `auto`: logs go to `/var/log/journal`
(persistent) because that directory exists, else `/run/log/journal`
(tmpfs, lost on reboot). journald announces the runtime half at every
boot — from this one:

```
2026-10-12T04:12:23+08:00 archlinux systemd-journald[138]: Runtime Journal (/run/log/journal/f5f1729d1761426ebca70f7bd3e687e1) is 8M, max 236.6M, 228.6M free.
```

Current spending:

```
$ journalctl --disk-usage
Archived and active journals take up 292.8M in the file system.
```

<figure>
<svg viewBox="0 0 640 220" width="100%" role="img" aria-label="Journal retention: journald rotates files at SystemMaxUse, caps total disk with SystemMaxUse= and runtime tmpfs with RuntimeMaxUse=, and deletes oldest archived files first under pressure. Vacuum removes archived files in bulk from the oldest end.">
  <g fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="10" y="90" width="620" height="40" rx="8"/>
    <rect x="10" y="140" width="305" height="60" rx="8"/>
    <rect x="325" y="140" width="305" height="60" rx="8"/>
  </g>
  <g fill="currentColor" opacity="0.25">
    <rect x="24" y="102" width="44" height="16" rx="3"/>
    <rect x="72" y="102" width="44" height="16" rx="3"/>
    <rect x="120" y="102" width="44" height="16" rx="3"/>
    <rect x="168" y="102" width="44" height="16" rx="3"/>
    <rect x="216" y="102" width="44" height="16" rx="3"/>
    <rect x="264" y="102" width="44" height="16" rx="3"/>
    <rect x="312" y="102" width="44" height="16" rx="3"/>
    <rect x="360" y="102" width="44" height="16" rx="3"/>
    <rect x="408" y="102" width="44" height="16" rx="3"/>
    <rect x="456" y="102" width="44" height="16" rx="3"/>
    <rect x="504" y="102" width="44" height="16" rx="3"/>
    <rect x="552" y="102" width="44" height="16" rx="3"/>
  </g>
  <g stroke="currentColor" stroke-width="1.2" marker-end="url(#vh)">
    <line x1="590" y1="110" x2="590" y2="60"/>
  </g>
  <defs>
    <marker id="vh" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-size="12" fill="currentColor" font-family="sans-serif">
    <text x="10" y="80">older archived files (deleted first) ───── newer active files (being written)</text>
    <text x="598" y="55" text-anchor="end">SystemMaxUse= / RuntimeMaxUse=</text>
    <text x="24" y="165">journalctl --vacuum-size=200M</text>
    <text x="339" y="165">journalctl --vacuum-time=2weeks</text>
    <text x="24" y="188">bulk trim from the oldest end</text>
    <text x="339" y="188">bulk trim from the oldest end</text>
  </g>
</svg>
<figcaption>Retention has two halves: automatic caps in <code>journald.conf</code> (rotate, then delete oldest) and manual <code>--vacuum-*</code>. Both always delete from the oldest end — whatever is <em>currently</em> writing is never the victim.</figcaption>
</figure>

The caps live in `journald.conf`: `SystemMaxUse=` (default 10% of the
filesystem, max 4G), `RuntimeMaxUse=` for tmpfs, `MaxRetentionSec=` for
a hard age cutoff.

Now the honest part — I'm uid 1000, so vacuum is out of reach.

```
$ journalctl --vacuum-size=50M
Vacuuming done, freed 0B of archived journals from /var/log/journal.
Vacuuming done, freed 0B of archived journals from /run/log/journal.
Failed to delete archived journal /var/log/journal/b28faf4a0b4a42048f13d6be379f6b10/system@30e8d7b479634a969546b2b7c9da3775-0000000000243587-00065d421a615ccd.journal: 权限不够
Vacuuming done, freed 0B of archived journals from /var/log/journal/b28faf4a0b4a42048f13d6be379f6b10.
```

`权限不够` is permission denied, once per file it couldn't delete; it
freed 0 B and still exited 0 — check for those error lines, not the
exit status. `--vacuum-time=2d` behaved identically, and
`journalctl --rotate` failed outright (`Failed to issue
io.systemd.Journal.Rotate() varlink call: 权限不够`). Vacuuming and
rotation are root (or Polkit-granted) jobs. Reading is not: here the
files are `root:systemd-journal 0640` plus ACLs for `wheel` and `adm`,
and I'm in `wheel` — so an unprivileged shell reads all 377,274
entries of this boot:

```
$ journalctl -b --no-pager -o short-iso | wc -l
377274
$ journalctl --user -b --no-pager -o short-iso | wc -l
9934
```

The journal is *not* world-readable the way `/var/log/syslog` often is.
(`journalctl --verify` walks the files and prints `PASS:` per file —
worth running after a crash.)

## Getting logs out of the journal

Defaults keep logs local, and this box shows it: `ForwardToSyslog=no`,
no rsyslog installed (`which rsyslogd` finds nothing), and the shipping
units installed but off:

```
$ systemctl status systemd-journal-remote --no-pager | head -3
○ systemd-journal-remote.service - Journal Remote Sink Service
     Loaded: loaded (/usr/lib/systemd/system/systemd-journal-remote.service; indirect; preset: disabled)
     Active: inactive (dead)
```

Your options, by setup cost:

1. `ForwardToSyslog=yes` — re-emit everything to `/dev/log` for rsyslog. For when something downstream expects syslog.
2. `systemd-journal-remote` — listens on UDP/TCP for journal entries from other hosts.
3. `systemd-journal-upload` — the push side; pair with remote for a systemd-native central log.
4. `systemd-journal-gatewayd` — HTTP access, including `/entries?...&output=json`.
5. Any shipper you run — Promtail scrapes the journal natively, Filebeat has a journald input, or `journalctl -o json -f --cursor <saved>` into your own pipeline.

`__CURSOR` is the bookmark: ship "everything after cursor X" and a
crash between batches costs you nothing.

## The tradeoffs, honestly

For anything short-lived on one host — service logs, cron output,
kernel messages, coredumps, "why did it crash", "who restarted what" —
the journal wins: structured, indexed, correlated by boot and unit,
attached to the process that produced it, installed by default. A
fresh Arch box gets all of it with nothing to install.

Where it loses:

- **Long-term retention is a fight.** "Keep 90 days" is a `journald.conf` knob you'll set too large, on a disk shared with everything else — and the vacuum runs later than you'd like.
- **Single host by design.** Federation means extra software (remote, upload, gatewayd, or a shipper). The moment you want "12 machines, one query, one policy", you're designing centralisation — Loki/ELK territory, fed by the same `-o json` output.
- **Binary and local.** No `zgrep` over an archive; a broken boot can take the runtime journal with it.
- **Not a database.** Every query is a scan of the indexed files. `-u X -p err --since yesterday` over a million entries is fine; ad-hoc exploration across five fields on eight machines is not.

My setup is the boring layered answer: journald keeps a few days
locally with `SystemMaxUse=` for 3am questions *on the box*; a shipper
drains `-o json` into Loki for the cross-host ones. The
[systemd unit cookbook](/posts/systemd-unit-cookbook/) covers the
producer side — getting output into the journal is half the battle.

## The five commands worth memorising

```
journalctl -u foo.service -b -p err --since '1 hour ago'   # what broke recently
journalctl -f -t mytag                                     # watch one writer live
journalctl -b -k                                           # kernel, this boot
journalctl -o json | python3 ...                           # answer a question, once
journalctl --disk-usage                                    # before you wonder why /
```

The log system you already have beats the one you were about to
install. Spend twenty minutes with `journalctl -o verbose` on your own
logs first — once you see the fields, you can't go back to grepping.
