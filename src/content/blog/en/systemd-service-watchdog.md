---
title: "systemd watchdog: restarting what hangs, not just what crashes"
description: "Restart=on-failure only catches processes that exit. This shows how WatchdogSec plus sd_notify heartbeats catch the ones that hang instead, with real systemd journal output, StartLimitBurst crash-loop protection, and Type=notify readiness."
pubDate: 2027-01-29
lang: en
translationKey: systemd-service-watchdog
tags: [systemd, linux]
featured: false
keywords:
  - systemd watchdog
  - Restart=on-failure
  - WatchdogSec
  - sd_notify
  - StartLimitBurst
---

I spent a long time believing `Restart=on-failure` meant "my service comes back".
Then I found a service that had been dead for two days with a green
`active (running)` badge. It wasn't dead in the way systemd notices — nobody had
called `exit()`. The process was wedged inside a syscall, holding a lock, answering
nothing. It was alive. To systemd it was *fine*. That is the gap the **systemd
watchdog** exists to close: it is the mechanism that restarts what **hangs**, not
just what **crashes**.

Everything here is real output from this machine (systemd 262). I have no root,
so the services are user units under `systemctl --user` — the directives are
identical to system services, only the unit path changes. I wrote the units,
broke them on purpose, and cleaned them up afterwards.

## A crash and a hang look nothing alike to systemd

A **crash** is an event: the main process exits with a non-zero status, or is
terminated by a signal. systemd sees *that* — a waitpid() result — and acts on
it. A **hang** is the absence of events. The process is still in the process
table, `Restart=always` has nothing to react to, and the only evidence is that
your HTTP endpoint stopped answering.

<figure>
<svg viewBox="0 0 760 300" width="100%" role="img" aria-label="A crash is an exit event that Restart=on-failure already handles. A hang is a live process that stops making progress, which only WatchdogSec with regular sd_notify heartbeats can detect, after which systemd sends SIGABRT and restarts the service.">
  <defs>
    <marker id="wd-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor">
    <text x="16" y="30" font-weight="600">CRASH — an exit event</text>
    <text x="16" y="48" opacity="0.7" font-size="12">systemd sees: waitpid() → status=3</text>

    <g stroke="#0f766e" stroke-width="1.5" fill="none">
      <rect x="16" y="60" width="180" height="52" rx="8"/>
      <rect x="280" y="60" width="200" height="52" rx="8"/>
    </g>
    <text x="106" y="90" text-anchor="middle">process exits</text>
    <text x="380" y="90" text-anchor="middle">Restart=on-failure</text>
    <path d="M196 86 h74" stroke="#0f766e" stroke-width="1.5" marker-end="url(#wd-arrow)"/>
    <text x="233" y="78" text-anchor="middle" font-size="11" fill="#0f766e">RestartSec=1</text>
    <text x="496" y="90" text-anchor="middle" stroke="#0f766e" stroke-width="1.5" fill="none">
      <tspan x="496" dy="0">→ new PID</tspan>
    </text>

    <text x="16" y="176" font-weight="600">HANG — no event at all</text>
    <text x="16" y="194" opacity="0.7" font-size="12">systemd sees: nothing. Restart= = nothing to do.</text>

    <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
      <rect x="16" y="206" width="180" height="52" rx="8"/>
    </g>
    <text x="106" y="228" text-anchor="middle">alive, wedged</text>
    <text x="106" y="246" text-anchor="middle" font-size="11" opacity="0.7">lock held, no replies</text>
    <path d="M196 232 h74" stroke="#0f766e" stroke-width="1.5" marker-end="url(#wd-arrow)"/>
    <text x="233" y="224" text-anchor="middle" font-size="11" fill="#0f766e">WatchdogSec=5</text>
    <g stroke="#0f766e" stroke-width="1.5" fill="none">
      <rect x="280" y="206" width="200" height="52" rx="8"/>
    </g>
    <text x="380" y="228" text-anchor="middle">sd_notify(WATCHDOG=1)</text>
    <text x="380" y="246" text-anchor="middle" font-size="11" opacity="0.7">missing for 5s → SIGABRT</text>
    <path d="M480 232 h60" stroke="#0f766e" stroke-width="1.5" marker-end="url(#wd-arrow)"/>
    <text x="560" y="228" text-anchor="middle">restart</text>
    <text x="560" y="246" text-anchor="middle" font-size="11" opacity="0.7">same policy as a crash</text>
  </g>
</svg>
<figcaption>A crash is a transition systemd can observe; a hang is a non-event. The watchdog turns "it stopped making progress" into something systemd can act on, by requiring the application to prove it is alive on a timer.</figcaption>
</figure>

## Experiment 1: `Restart=on-failure` really does restart a crash

The baseline. A service whose only job is to exit non-zero:

```ini
[Unit]
Description=WD-test: crashes on purpose (Restart=on-failure)
[Service]
Type=simple
ExecStart=/tmp/opencode/work/systemd-watchdog/crash.sh
Restart=on-failure
RestartSec=1
StandardOutput=journal
```

```sh
$ systemctl --user start zz-wd-crash.service && sleep 4.5 \
    && systemctl --user show zz-wd-crash.service \
         -p NRestarts -p Restart -p RestartUSec -p ExecMainStatus
Restart=on-failure
RestartUSec=1s
NRestarts=3
ExecMainStatus=3
```

The journal tells the whole story, one line per failure:

```
zz-wd-crash.service: Main process exited, code=exited, status=3/NOTIMPLEMENTED
zz-wd-crash.service: Failed with result 'exit-code'.
zz-wd-crash.service: Scheduled restart job, restart counter is at 3.
zz-wd-crash.service: Started WD-test: crashes on purpose (Restart=on-failure).
```

`NRestarts` is the counter to trust — it is the canonical "how many times did
this get restarted" answer, and it survives a lookup without reading logs. Note
`RestartUSec=1s`: that is `RestartSec`, and it is not decoration. Without it a
service that dies instantly would be restarted in a tight loop and eat a core
file each time. Details on `Type=` and the rest of the unit directives live in
the [systemd unit cookbook](/posts/systemd-unit-cookbook/); this is only the
part that decides whether *a thing that died* comes back.

## The crash loop, and the start limit that stops it

Leave that crash service running and the restart counter eventually means
something different — a refusal to start. This is **StartLimitBurst** and
**StartLimitIntervalSec** at work:

```ini
[Unit]
Description=WD-test: crash loop, trips the start limit
[Service]
Type=simple
ExecStart=/tmp/opencode/work/systemd-watchdog/crash.sh
Restart=on-failure
RestartSec=1
StartLimitIntervalSec=10
StartLimitBurst=5
```

The manual start returns immediately — the retries happen in the background:

```sh
$ systemctl --user start zz-wd-loop.service; sleep 8
$ systemctl --user show zz-wd-loop.service -p ActiveState -p NRestarts -p Result
ActiveState=failed
Result=start-limit-hit
NRestarts=5
```

and the journal records exactly when it gave up:

```
zz-wd-loop.service: Scheduled restart job, restart counter is at 5.
zz-wd-loop.service: Start request repeated too quickly.
zz-wd-loop.service: Failed with result 'start-limit-hit'.
```

Asking for a restart by hand gets you an honest "no" plus the way out:

```sh
$ systemctl --user start zz-wd-loop.service
Job for zz-wd-loop.service failed because start of the service was attempted too often.
See "systemctl --user status zz-wd-loop.service" and "journalctl --user -xeu zz-wd-loop.service" for details.
To force a start use "systemctl --user reset-failed zz-wd-loop.service"
followed by "systemctl --user start zz-wd-loop.service" again.
```

Two things worth knowing here. First, the defaults (5 starts per 10s) are
aggressive for a service that legitimately crashes on boot while waiting for a
disk — raise `StartLimitIntervalSec` and `StartLimitBurst` together. Second, a
start-limit hit is a *different failure* from the crash: `Result=start-limit-hit`,
not `exit-code`. When you grep a journal for `Failed with result`, that
distinction is the first clue.

## Killed is not crashed

A little counter-intuitive but important: **`Restart=on-failure` also restarts a
service that was killed**, because being terminated by a signal it did not
handle is a failure. I started a `sleep 3000` service, sent SIGKILL to its main
PID, and got it back:

```sh
$ systemctl --user start zz-wd-killed.service; sleep 1
$ kill -9 $(systemctl --user show zz-wd-killed.service -p MainPID --value)
$ systemctl --user show zz-wd-killed.service -p MainPID -p NRestarts
MainPID=1130713
NRestarts=1
```

```
zz-wd-killed.service: Main process exited, code=killed, status=9/KILL)
zz-wd-killed.service: Failed with result 'signal'.
zz-wd-killed.service: Scheduled restart job, restart counter is at 1.
```

The new `MainPID` (1130722) is the proof: a different process. So OOM kills,
`pkill`, and the kernel reaper are all covered by `Restart=`. The service I
could not bring back was the one that never received a signal at all.

## Why `Restart=always` does not save you from a hang

`Restart=` reacts to the *termination* of the main process. A wedged process has
not terminated. It holds its memory, its file descriptors and its locks, and it
sits there. `always` is just as blind as `on-failure` — the policy is asked
"did the process exit?", the answer is no, and nothing happens.

The fix is to invert the question: stop asking systemd to notice a death, and
make the application prove it is *alive* on a timer. That is **`WatchdogSec=`**
with **`sd_notify`** heartbeats — the **systemd watchdog** proper.

## Experiment 2: a healthy `WatchdogSec=5` heartbeat

The contract: if the time between two `WATCHDOG=1` notifications exceeds
`WatchdogSec`, the service is failed and killed with SIGABRT. Here is the
smallest client I could write (in C, because `libsystemd` gives me
`sd_notify` for free):

```c
sd_notify(0, "READY=1\nSTATUS=started, heartbeating every 1000ms");

for (;;) {
    usleep(period * 1000);
    sd_notifyf(0, "STATUS=heartbeat #%ld\nWATCHDOG=1", ticks);
}
```

```ini
[Unit]
Description=WD-test: Type=notify + WatchdogSec, healthy heartbeat
[Service]
Type=notify
ExecStart=/tmp/opencode/work/systemd-watchdog/hb 1000 0
WatchdogSec=5
Restart=always
RestartSec=1
NotifyAccess=main
```

Running it, the heartbeat shows up as a moving `WatchdogTimestamp` — the last
time the watchdog was petted:

```sh
$ systemctl --user start zz-wd-hb.service && sleep 2 \
    && systemctl --user show zz-wd-hb.service -p WatchdogTimestamp --value
Wed 2026-10-14 10:34:19 CST     # ~3.5s after start
$ sleep 4; systemctl --user show zz-wd-hb.service -p ActiveState -p NRestarts
ActiveState=active
NRestarts=0
```

Alive well past the 5s limit with `NRestarts=0` — the only way that happens. My
first attempt at this client, though, was killed on a loop, and the journal is
instructive:

```
zz-wd-hb.service: Watchdog timeout (limit 5s)!
zz-wd-hb.service: Killing process 1131652 (hb) with signal SIGABRT.
systemd-coredump: Stack trace of thread 1131652:
  #1  __nanosleep (libc.so.6 + 0xe0ee7)
  #3  n/a (/tmp/opencode/work/systemd-watchdog/hb + 0x1162)
zz-wd-hb.service: Main process exited, code=dumped, status=6/ABRT
zz-wd-hb.service: Failed with result 'watchdog'.
```

Look at the stack trace: the process was killed *inside `usleep()`* — perfectly
alive, perfectly wedged as far as systemd was concerned. The bug was one
argument: I had written `sd_notify(1, "READY=1…")`, and the `1` tells
`sd_notify` to remove `$NOTIFY_SOCKET` from the environment afterwards. Every
heartbeat after that had no socket to send to, and systemd never heard a single
ping. The fix is `sd_notify(0, …)`. If you implement a watchdog client in any
language, that is the first thing to check.

## Experiment 3: the hang that triggers it

Now the actual test. Same program and unit, but after 8 seconds of healthy
heartbeat the program stops pinging — simulating a deadlock — while staying alive:

```sh
$ systemctl --user start zz-wd-wedge.service && sleep 6
$ systemctl --user show zz-wd-wedge.service -p ActiveState -p NRestarts
ActiveState=active          # still fine — the hang hasn't outlived the limit
NRestarts=0
$ sleep 12; systemctl --user show zz-wd-wedge.service -p ActiveState -p NRestarts \
    -p WatchdogTimestamp
ActiveState=active
WatchdogTimestamp=Wed 2026-10-14 10:34:52 CST   # the last successful ping
NRestarts=1
```

The journal marks the whole arc, including the moment the application wedged:

```
hb: WEDGING - no more WATCHDOG=1 pings (pid 1132727 still alive)
zz-wd-wedge.service: Watchdog timeout (limit 5s)!
zz-wd-wedge.service: Killing process 1132727 (hb) with signal SIGABRT.
zz-wd-wedge.service: Main process exited, code=dumped, status=6/ABRT
zz-wd-wedge.service: Failed with result 'watchdog'.
zz-wd-wedge.service: Scheduled restart job, restart counter is at 2.
```

Four and a bit seconds after the last ping, the process was aborted, and a new
one started. That is the difference from a crash: the trigger is a *missed
heartbeat*, not an exit code. And note `Failed with result 'watchdog'` — that
single string in `journalctl -u` tells you why a service restarted, which matters
when you are grepping a month of logs for the reason.

If you write in Python, the same client is four lines with `ctypes` — no
package needed:

```python
import ctypes, time
lib = ctypes.CDLL("libsystemd.so.0")
lib.sd_notify(0, b"READY=1")
while True:
    lib.sd_notify(0, b"WATCHDOG=1")
    time.sleep(1)
```

That exact script keeps my recipe unit below at `NRestarts=0`.

## `Type=simple` versus `Type=notify`

**`Type=notify`** buys you readiness: systemd waits for `READY=1` before
considering the start job done, so dependents do not start against a half-born
service. **`Type=simple`** declares "active" the moment it forked the process.
Same 3-second startup, two very different answers about when it was ready:

```sh
# Type=simple  (ExecStart sleeps 3s, then it is "ready")
`systemctl start` blocked for 0.28s
ExecMainStartTimestamp=Wed 2026-10-14 10:38:40 CST
ActiveEnterTimestamp=Wed 2026-10-14 10:38:40 CST

# Type=notify   (same 3s, then systemd-notify --ready)
`systemctl start` blocked for 3.03s
ExecMainStartTimestamp=Wed 2026-10-14 10:38:40 CST
ActiveEnterTimestamp=Wed 2026-10-14 10:38:43 CST
```

With `Type=simple` the two timestamps are identical — systemd was already done
before the program was. With `Type=notify` they differ by exactly the startup
time, and `ActiveEnterTimestamp` tells the truth.

One misconception I had to fix by testing: I assumed the watchdog only worked
with `Type=notify`. It does not. I ran a plain `sleep 3000` under `Type=simple`
with `WatchdogSec=5` and no notification code at all, and it died anyway:

```
zz-wd-nonotify.service: Watchdog timeout (limit 5s)!
zz-wd-nonotify.service: Killing process 1135165 (sleep) with signal SIGABRT.
zz-wd-nonotify.service: Failed with result 'watchdog'.
```

The watchdog is armed either way; `Type=` only decides whether readiness is
gated. What *does* matter is `NotifyAccess`, which decides whose notifications
count: `main` (the main process), `exec`, or `all`. My `Type=notify` unit that
delegated to a `systemd-notify` helper child failed with `Failed with result
'timeout'` under the default `NotifyAccess=main`, because the ping came from a
child PID — the 90-second start timeout was the only symptom.

## The recipe I actually use

```ini
[Unit]
Description=recipe-unit: watchdog + restart + start limits
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10
[Service]
Type=notify
ExecStart=/usr/bin/python3 /tmp/opencode/work/systemd-watchdog/hb.py
WatchdogSec=30
Restart=always
RestartSec=5
NotifyAccess=main
StandardOutput=journal
SyslogIdentifier=recipe
[Install]
WantedBy=default.target
```

`systemd-analyze verify` accepted it — and caught a real mistake in my first
draft, where I had put the start limits in `[Service]`:

```
~/.config/systemd/user/zz-wd-recipe.service:10: Unknown key 'StartLimitIntervalSec' in section [Service], ignoring.
```

`StartLimit*` belongs to `[Unit]`. The verify tool is free and offline; the
unit cookbook post leans on it too. Verified and running:

```sh
$ systemctl --user show zz-wd-recipe.service -p ActiveState -p NRestarts \
    -p StartLimitBurst -p StartLimitIntervalUSec
ActiveState=active
NRestarts=0
StartLimitBurst=10
StartLimitIntervalUSec=5min
```

Some judgement calls in those numbers. `WatchdogSec=30` with a 1s heartbeat
gives 29 missed pings of slack — tight enough to notice a real stall, loose
enough that one slow GC pause does not restart your database. `RestartSec=5`
beats `1` when startup is expensive. And the start limit is now 10 starts in 5
minutes: crash-loop protection that still tolerates a genuine boot-time failure
against a slow disk.

The logging matters as much as the knobs. `StandardOutput=journal` plus
`SyslogIdentifier=` means `journalctl -t recipe` finds everything, and the three
strings that matter are `Failed with result 'watchdog'`, `... timeout (limit
5s)!`, and `Scheduled restart job`. Grep for those before you read a single
stack trace.

## What to do with this

`Restart=on-failure` is a floor, not a ceiling: it covers exits, signals and
kills, and `StartLimitBurst` keeps a broken unit from shredding your logs. The
hang is the case it structurally cannot cover, and the fix is one directive plus
one function call: `WatchdogSec=` in the unit, `sd_notify(WATCHDOG=1)` on a
timer in the application. Check `NRestarts` and `WatchdogTimestamp` before you
believe a green status badge — that is how you find the service that has been
quietly wedged since Tuesday. If you also want to keep those units from being
the thing that gets owned, the [systemd hardening](/posts/systemd-hardening/)
post is the follow-up.

Every unit above has been stopped and removed from `~/.config/systemd/user/`;
the user manager is back to its two pre-existing Avahi failures and nothing
else.
