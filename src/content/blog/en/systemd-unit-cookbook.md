---
title: "systemd unit file cookbook: ExecStart, restarts, timers, and validation"
description: "The systemd unit file directives I actually use: ExecStart, EnvironmentFile, User, After vs WantedBy, Restart=on-failure and start limits, Type=simple vs exec vs oneshot, journal logging, timers, systemctl edit drop-ins, and a real systemd-analyze verify failure I fix."
pubDate: 2026-12-26
lang: en
translationKey: systemd-unit-cookbook
tags: [systemd, linux]
featured: false
keywords:
  - systemd unit file
  - ExecStart
  - systemd-analyze verify
  - systemctl edit
  - Restart=on-failure
---

Most of what I know about the **systemd unit file** I learned by getting it wrong — a typo in `Restart=`, an `ExecStart` pointing at the wrong path, a service that reported "started" while it was already dead. This is the cookbook I wish I'd had: the directives that do the real work, the ones that only look optional, and — more useful than any of them — how to check your work before `systemctl start`.

Everything below is real output from this machine (systemd 262). I have no root here, so the running examples are user services under `systemctl --user`; the directives are byte-for-byte the same, only the search path changes (`/etc/systemd/system` versus `~/.config/systemd/user`).

## A unit file is three sections in a plain INI file

A unit file is just INI. The suffix selects the *unit type* — `.service`, `.timer`, `.socket`, `.target`, `.mount`, `.path` — and for a service there are three sections worth your attention:

- **`[Unit]`** — metadata and ordering: `Description`, `After`, `Wants`, `Requires`, `Documentation`.
- **`[Service]`** — what to run and how: `ExecStart`, `User`, `WorkingDirectory`, `Restart`, `Type`.
- **`[Install]`** — what `systemctl enable` wires up: almost always `WantedBy=multi-user.target`.

`[Unit]` and `[Install]` are shared by every unit type; `[Service]` exists only for `.service`. Knowing which section a directive belongs to is half of not embarrassing yourself.

<figure>
<svg viewBox="0 0 620 150" width="100%" role="img" aria-label="A unit file's three sections map to three phases: the [Unit] section describes ordering and dependencies, the [Service] section describes the running process, and the [Install] section describes what systemctl enable wires up.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="16" y="46" width="176" height="70" rx="8"/>
    <rect x="222" y="46" width="176" height="70" rx="8"/>
    <rect x="428" y="46" width="176" height="70" rx="8"/>
    <path d="M192 81 h30" marker-end="url(#ar)"/>
    <path d="M398 81 h30" marker-end="url(#ar)"/>
  </g>
  <defs>
    <marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="104" y="28" opacity="0.9">order &amp; depend</text>
    <text x="104" y="72">[Unit]</text>
    <text x="104" y="92" opacity="0.75">After, Wants, Requires</text>
    <text x="310" y="28" opacity="0.9">run</text>
    <text x="310" y="72">[Service]</text>
    <text x="310" y="92" opacity="0.75">ExecStart, User, Restart</text>
    <text x="516" y="28" opacity="0.9">enable</text>
    <text x="516" y="72">[Install]</text>
    <text x="516" y="92" opacity="0.75">WantedBy</text>
  </g>
</svg>
<figcaption>One file, three phases: <code>[Unit]</code> orders the start, <code>[Service]</code> defines the process, <code>[Install]</code> decides what <code>systemctl enable</code> links.</figcaption>
</figure>

## ExecStart and the directives that do real work

Here is the shape of nearly every long-running service I write. Note the absolute paths and the `-` on `EnvironmentFile`:

```ini
[Unit]
Description=My API
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
User=myapp
WorkingDirectory=/opt/myapp
EnvironmentFile=-/etc/myapp/env
ExecStart=/opt/myapp/bin/myapp --serve
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=3s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

A few of these earn a sentence each:

- **`ExecStart=`** must be an absolute path to an executable. There is no shell, so `>` redirection or `&&` does nothing unless you explicitly run `/bin/sh -c '...'`. `$VAR` and `${VAR}` are expanded from the environment systemd has composed.
- **`EnvironmentFile=-/etc/myapp/env`** sets variables (`KEY=value`, one per line). The leading `-` means *ignore it if the file is missing* — useful for optional secrets, dangerous if you expect it to always exist.
- **`WorkingDirectory=`** sets the cwd and, with it, where relative paths land. Pair it with `ProtectSystem=strict` later and this stays honest.
- **`User=`** drops privileges. Omitting it means the service runs as root, which is why it is the first line of every review I do.
- **`ExecReload=`** is what `systemctl reload` runs. `$MAINPID` is expanded to the running PID.

## After, Wants, Requires versus WantedBy

This is the pair people conflate most. They live in different sections because they answer different questions.

- **`After=`/`Before=`** set *ordering only*. They do not start anything. Both units can start; systemd just sequences them.
- **`Wants=`** is a soft dependency: start this other unit too, but if it fails, carry on.
- **`Requires=`** is hard: if the required unit fails *and this unit is being started because of it*, this one is pulled down with it.
- **`WantedBy=`** is about `enable`, not runtime. It is the answer to "name the target that should pull this unit in at boot."

The classic bug is assuming `After=network-online.target` gets you a network. It does not — it only orders you after the network *if something else started it*. If you need it up, say so: `Wants=network-online.target` (and on `Type=oneshot` setups, `Requires=` when failure must abort).

## Type=simple vs exec vs oneshot vs forking

`Type=` tells systemd *when it may consider the service running*, and getting it wrong changes your failure semantics. I proved the difference to myself with a deliberately missing binary:

```console
$ systemctl --user start cookbook-type-simple.service; echo "rc=$?"
rc=0
$ systemctl --user start cookbook-type-exec.service; echo "rc=$?"
Job for cookbook-type-exec.service failed because the control process exited with error code.
See "systemctl --user status cookbook-type-exec.service" and "journalctl --user -xeu cookbook-type-exec.service" for details.
rc=1
```

With `Type=simple`, systemd treated the service as started the moment it forked, so `start` returned success and the service died a moment later (`status=203/EXEC`) — a silent-ish failure you find later in the journal. With `Type=exec`, systemd waited for the `exec()` to succeed, so `start` failed immediately and loudly. For anything I run, `Type=exec` is the default I reach for.

The four that matter: **`simple`** starts the moment the process forks (fine for quick scripts, hides exec errors); **`exec`** waits for a successful exec; **`oneshot`** expects the process to exit and only counts as started when it does — the right type for a timer's payload; **`forking`** is for classic daemons that background themselves, where `ExecStart` returns after the parent exits and systemd tracks the child (add `PIDFile=`). If your app speaks `sd_notify`, use `notify` and it can even signal "ready" after it has warmed caches.

## Restart=on-failure and the start limit

`Restart=on-failure` is the one-line fix for "it died at 3 a.m." It restarts when the process exits non-zero, is killed by a signal, or times out — but *not* on a clean `exit 0`, and not when you `systemctl stop` it yourself. `RestartSec=` spaces the attempts out. I made a script that always exits 1 to watch the guardrail:

```console
$ journalctl --user -u cookbook-flaky.service -o short-iso | tail -6
2026-10-12T18:43:14+08:00 BOOK systemd[905]: Scheduled restart job, restart counter is at 2.
2026-10-12T18:43:14+08:00 BOOK systemd[905]: Started Cookbook flaky demo.
2026-10-12T18:43:14+08:00 BOOK flaky.sh[466807]: attempt: will fail with exit 1
2026-10-12T18:43:14+08:00 BOOK systemd[905]: Failed with result 'exit-code'.
2026-10-12T18:43:17+08:00 BOOK systemd[905]: Scheduled restart job, restart counter is at 3.
2026-10-12T18:43:17+08:00 BOOK systemd[905]: Start request repeated too quickly.
2026-10-12T18:43:17+08:00 BOOK systemd[905]: Failed with result 'start-limit-hit'.
```

A crash loop without a ceiling is worse than a crash. `StartLimitIntervalSec=` (default 10s) and `StartLimitBurst=` (default 5) cap restarts inside a window, after which systemd gives up with `start-limit-hit` and leaves the unit failed for you to inspect. Set `StartLimitIntervalSec=0` only when you *want* an infinite restart loop.

## Logging: StandardOutput=journal

The default already sends stdout and stderr to the journal, so `StandardOutput=journal` is mostly documentation. The payoff is `journalctl`, which knows about units instead of files:

```console
$ systemctl --user status cookbook-heartbeat.service --no-pager
* cookbook-heartbeat.service - Cookbook heartbeat demo
     Loaded: loaded (/home/awinx/.config/systemd/user/cookbook-heartbeat.service; disabled; preset: enabled)
     Active: active (running) since Mon 2026-10-12 18:42:49 CST; 7s ago
   Main PID: 466441 (heartbeat.sh)
      Tasks: 2 (limit: 14160)
     Memory: 1.4M (peak: 2.7M)
        CGroup: /user.slice/user-1000.slice/user@1000.service/app.slice/cookbook-heartbeat.service
                |-466441 /bin/sh /tmp/opencode/work/systemd-units/heartbeat.sh
                `-466580 sleep 3

Oct 12 18:42:49 BOOK heartbeat.sh[466441]: heartbeat start tag=blog-demo pid=466441
Oct 12 18:42:52 BOOK heartbeat.sh[466441]: heartbeat tick=2 tag=blog-demo

$ journalctl --user -u cookbook-heartbeat.service -n 3 -o short-iso
2026-10-12T18:42:49+08:00 BOOK heartbeat.sh[466441]: heartbeat start tag=blog-demo pid=466441
2026-10-12T18:42:52+08:00 BOOK heartbeat.sh[466441]: heartbeat tick=2 tag=blog-demo
2026-10-12T18:42:55+08:00 BOOK heartbeat.sh[466441]: heartbeat tick=3 tag=blog-demo
```

For system services drop `--user`. Add `-f` to follow, `--since "1 hour ago"` to window, and `-o json` when you want to pipe it somewhere. No more `>> /var/log/app.log 2>&1`.

## Timers as the cron replacement

A timer is a pair: a `.timer` that says *when* and a `.service` that says *what*. The service is the payload (usually `Type=oneshot`), and the timer only triggers it.

```ini
# ~/.config/systemd/user/cookbook-tick.timer
[Unit]
Description=Run cookbook-tick every 10 minutes

[Timer]
OnCalendar=*:0/10
Persistent=true
Unit=cookbook-tick.service

[Install]
WantedBy=timers.target
```

`OnCalendar=` is not cron syntax, and you do not have to memorize it — `systemd-analyze calendar` parses it *and tells you the next fire time*:

```console
$ systemd-analyze calendar 'Mon..Fri *-*-* 09:00:00'
Normalized form: Mon..Fri *-*-* 09:00:00
    Next elapse: Tue 2026-10-13 09:00:00 CST
       From now: 14h left
$ systemd-analyze calendar '*:0/15'
Normalized form: *-*-* *:00/15:00
    Next elapse: Mon 2026-10-12 18:45:00 CST
       From now: 1min 53s left
$ systemd-analyze calendar 'every monday'
Failed to parse calendar specification 'every monday': Invalid argument
```

That third line is why I run it: bad expressions fail loudly here instead of silently never firing. Then enable and confirm:

```console
$ systemctl --user enable --now cookbook-tick.timer
$ systemctl --user list-timers cookbook-tick.timer --no-pager
NEXT                        LEFT LAST PASSED UNIT                ACTIVATES
Mon 2026-10-12 18:50:00 CST 6min -    -      cookbook-tick.timer cookbook-tick.service
```

`Persistent=true` re-runs a missed job after downtime — the catch-up behaviour cron never had. I wrote a full [systemd timers vs cron](/posts/systemd-timers-vs-cron/) comparison if you are migrating.

## Overrides without forking: systemctl edit and drop-ins

Never edit the packaged unit in `/usr/lib`. `systemctl edit` drops a snippet into `<unit>.d/override.conf` that layers on top and survives package upgrades:

```console
$ systemctl --user cat cookbook-heartbeat.service
# /home/awinx/.config/systemd/user/cookbook-heartbeat.service
[Service]
ExecStart=.../heartbeat.sh
Restart=on-failure
RestartSec=2

# /home/awinx/.config/systemd/user/cookbook-heartbeat.service.d/override.conf
[Service]
RestartSec=10
Restart=no

$ systemctl --user show cookbook-heartbeat.service -p Restart -p RestartSec
Restart=no
RestartSec=10
```

The drop-in's values win, and `systemctl cat` shows you the merged stack so you can always see *why*. Two rules to remember: list directives reset when re-assigned, so `ExecStart=` on its own line clears the inherited one before your replacement; and `systemctl edit --full` edits a private copy instead of a drop-in (fine for a machine you own, risky for a distro unit). `systemctl revert <unit>` removes all overrides.

## Validating with systemd-analyze verify

Here is the part I do before every start. I wrote a service with a typo and a bad path on purpose:

```ini
[Service]
ExecStart=/usr/bin/myapp --serve
EnvironmentFile=/etc/myapp/env
Restart=onfailure
```

`systemd-analyze verify` refuses to be fooled:

```console
$ systemd-analyze verify ./broken.service
/tmp/opencode/work/systemd-units/broken.service:10: Failed to parse Restart=onfailure, ignoring: Invalid argument
broken.service: Command /usr/bin/myapp is not executable: No such file or directory
```

Two real finding lines, both of which would have been a 3 a.m. puzzle. Fix the typo to `on-failure`, point `ExecStart` at a real binary, and the same command goes quiet and exits 0:

```console
$ systemd-analyze verify ./fixed.service; echo "exit=$?"
exit=0
```

Verify is not just a spell-checker. It resolves dependencies and enforces a few hard requirements:

```console
$ systemd-analyze verify ./no-exec.service
no-exec.service: Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing.
Unit no-exec.service has a bad unit file setting.

$ systemd-analyze verify ./deps.service
deps.service: Failed to create deps.service/start: Unit missing.service not found.
```

Two honest limits. First, a directive in the wrong section is only a warning and still exits 0:

```console
$ systemd-analyze verify ./section-error.service
/tmp/opencode/work/systemd-units/section-error.service:7: Unknown key 'WantedBy' in section [Service], ignoring.
$ echo $?
0
```

Second, `verify` does not validate your `[Install]` target — `WantedBy=no-such.target` passes — so read the output, do not just check the exit code. Then `daemon-reload` and `systemctl start`.

## Where this leaves you

The unit file is a small, checkable artifact: three sections, a handful of directives, and two commands (`systemd-analyze verify`, `systemd-analyze calendar`) that catch most mistakes before a process exists. If you want to go further, the natural next step is shrinking what the service can touch — I walk through that, measured with `systemd-analyze security` (my demo service scores 9.4 UNSAFE untouched, 2.7 OK once sandboxed), in [systemd hardening](/posts/systemd-hardening/). Write the file, verify it, then trust it.
