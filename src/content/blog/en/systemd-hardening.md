---
title: "systemd hardening: sandboxing your daemons with systemd-analyze security"
description: "How to sandbox systemd services without breaking them: the directives that matter (NoNewPrivileges, ProtectSystem=strict, PrivateTmp, SystemCallFilter, CapabilityBoundingSet, dynamic user), an incremental workflow measured with systemd-analyze security, and how to test and roll a unit back."
pubDate: 2026-11-24
lang: en
translationKey: systemd-hardening
tags: [security, systemd, linux]
featured: false
keywords:
  - systemd hardening
  - ProtectSystem
  - systemd-analyze security
  - service sandboxing
  - NoNewPrivileges
---

Every daemon I run on my servers is started from a unit file, and for years I
treated that file as a convenience wrapper: an `ExecStart`, a `User`, a restart
policy. **systemd hardening** changed how I read it. The unit file is not just
how systemd starts a process — it is the last writable line between that process
and the rest of the machine. Configure it wrong and a compromised service owns
`/etc`, `/home`, and every capability root has. Configure it well and the same
exploit gets a read-only filesystem, no capabilities, and no network stacks it
did not ask for.

The catch is that the second sentence is easy to *write* and easy to *break*. A
service sandboxed too aggressively fails to start, and then you are debugging
mount namespaces at midnight. This is the workflow I use to add
**service sandboxing** one knob at a time, measure it with
`systemd-analyze security`, and roll back cheaply when I get it wrong.

## systemd hardening: the unit file is a security boundary

Most hardening advice treats the kernel as the boundary: seccomp, SELinux, a
restricted user. systemd sits *above* the kernel and hands you the same
primitives as per-unit configuration, and it applies them automatically at every
start, restart, and `daemon-reload`. That is the whole appeal. A systemd unit is
a declarative description of "what this process may touch", enforced by the
kernel before `main()` runs.

The layers stack. Each one is independent, and each one you skip is a layer the
attacker keeps:

<figure>
<svg viewBox="0 0 640 300" width="100%" role="img" aria-label="Nested layers of a systemd sandbox, from cgroup limits at the outside to NoNewPrivileges and a minimal user at the centre, wrapping the process.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="20" y="20" width="600" height="260" rx="12"/>
    <rect x="60" y="55" width="520" height="225" rx="12"/>
    <rect x="100" y="90" width="440" height="190" rx="12"/>
    <rect x="140" y="125" width="360" height="155" rx="12"/>
    <rect x="180" y="160" width="280" height="120" rx="12"/>
  </g>
  <circle cx="320" cy="220" r="34" fill="none" stroke="currentColor" stroke-width="1.8"/>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="32" y="40" font-weight="600">resource limits (cgroup)</text>
    <text x="72" y="75">ProtectSystem, PrivateTmp, PrivateDevices</text>
    <text x="112" y="110">CapabilityBoundingSet</text>
    <text x="152" y="145">SystemCallFilter (seccomp)</text>
    <text x="192" y="180">NoNewPrivileges / dynamic user</text>
    <text x="320" y="224" text-anchor="middle" font-size="11">process</text>
  </g>
</svg>
<figcaption>Defence in depth in a unit file: each ring is a separate kernel mechanism, applied by systemd at start time. Skipping one does not weaken the others — it just leaves a ring missing.</figcaption>
</figure>

The reason to care is failure cost, not correctness. If a service runs as root
with full filesystem access and no seccomp filter, one remote code execution bug
turns into a full machine compromise. The same bug in a unit with an empty
`CapabilityBoundingSet`, a `ProtectSystem=strict` view, and a syscall filter is a
process that cannot read `/home`, cannot open a socket, and cannot write outside
its own state directory.

## The knobs that matter

There are hundreds of directives. A dozen of them carry almost all the weight,
and the cheapest ones are nearly free.

### The cheap wins

`NoNewPrivileges=true` sets the kernel's `no_new_privs` bit for the whole
service. It means the process, and everything it forks, can never gain privileges
— no setuid binary, no file capabilities, nothing. It is one line, it does not
change behavior, and it should be on almost every unit. `UMask=0077` is the same
kind of free tightening: new files stop being world-readable by default.

### Filesystem: ProtectSystem and ReadWritePaths

`ProtectSystem=strict` mounts the entire filesystem read-only for the service,
except for `/dev`, `/proc`, and `/sys`, which are handled by their own options.
That single directive flips "compromise writes a backdoor to `/usr/bin`" into "the
write fails". `ProtectHome=true` hides `/home`, `/root`, and `/run/user` behind
empty or unreadable mounts, closing the fastest path from a service to SSH keys.
On its own `ProtectSystem=strict` breaks every service that writes anything, so
you open it back up deliberately with `ReadWritePaths=`:

```ini
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/api /var/cache/api
StateDirectory=api
```

`StateDirectory=api` both creates `/var/lib/api` and marks it writable, which is
usually cleaner than a hand-written `ReadWritePaths` for persistent data. Use
`RuntimeDirectory` for `/run` sockets the same way.

### Namespaces: PrivateTmp, PrivateDevices, and friends

`PrivateTmp=true` gives the service its own `/tmp` and `/var/tmp`, so a
predictable-temp-file bug in one daemon cannot be weaponized by another user's
process. `PrivateDevices=true` swaps `/dev` for a minimal set without raw disk,
GPU, or input devices. `ProtectKernelTunables=true`, `ProtectKernelModules=true`,
and `ProtectControlGroups=true` block writes to `/proc/sys`, kernel module
loading, and cgroup manipulation. For anything that does not need a hostname,
`ProtectHostname=true` and `ProtectClock=true` remove two more pieces of ambient
authority.

### Syscalls and capabilities: SystemCallFilter and CapabilityBoundingSet

These two shrink the attack surface the most and break services the most.
`CapabilityBoundingSet=` (empty) drops every Linux capability; if the daemon only
binds a high port and reads a file, it needs none. `SystemCallFilter=` uses
seccomp. Start from the preset groups instead of listing syscalls by hand:

```ini
CapabilityBoundingSet=
AmbientCapabilities=
NoNewPrivileges=true
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources @obsolete
SystemCallArchitectures=native
```

`@system-service` is a curated allowlist for ordinary daemons; the second line
subtracts privileged, resource, and obsolete calls even from that set. The usual
breakage is a service that needs something specific — `@clock` for a daemon that
calls `adjtimex`, `@resources` for one that calls `setrlimit`, or a raw syscall a
canned group forgot. Add back the narrowest group you can, not the whole list.

### Dynamic user and resource limits

`DynamicUser=yes` is the quiet winner. Instead of a real account that persists
between runs and must be managed, systemd allocates a transient UID/GID for the
life of the unit and takes it away when the unit stops. There is no home to
write to, no `/etc/passwd` entry to leak, and no shared UID to collide with. It
pairs with `StateDirectory` and `Provoke` on first run only. Resource limits
belong in the same block: `MemoryMax=`, `CPUQuota=`, `TasksMax=`, and `IOWeight=`
give the cgroup a ceiling, so a compromised or buggy service is contained even
before you think about filesystem access.

## Measuring service sandboxing with systemd-analyze security

You do not have to guess how exposed a unit is. systemd ships a scorer that reads
a unit's effective configuration, flags every directive it recognizes, and prints
a single exposure number:

```bash
$ systemd-analyze security api.service
  NAME                                            DESCRIPTION                                      EXPOSURE
✗ PrivateNetwork=                                 Service has access to the host's network            0.5
✓ User=/DynamicUser=                              Service runs under a transient non-root user        0.0
✓ CapabilityBoundingSet=~CAP_SYS_ADMIN            Service has no administrator privileges             0.0
✓ CapabilityBoundingSet=~CAP_SET(UID|GID|PCAP)    Service cannot change UID/GID or capabilities       0.0
✓ RestrictAddressFamilies=~AF_UNIX                Service cannot allocate any address family          0.0
✗ RestrictNamespaces=                             Service may create namespaces                       0.3
✓ LockPersonality=                                Service cannot change ABI personality               0.0
✓ MemoryDenyWriteExecute=                         Service cannot create writable executable memory    0.0
✓ RestrictRealtime=                               Service cannot acquire realtime scheduling          0.0
✓ SystemCallArchitectures=                        Service may execute only specific system calls      0.1
✓ SystemCallFilter=~@clock                        Service may only invoke known system calls          0.1

→ Overall exposure level for api.service: 1.7 OK 🙂
```

Lower is better, and `✗` lines are your to-do list. `PrivateNetwork=` stays red on
purpose for anything that must answer on the internet. Run it against every unit
on the box with `systemd-analyze security` with no argument to see the whole
fleet ranked, and read the exposure number as a *direction*, not a grade — the
score cannot see your application's logic, only its kernel surface.

## A workflow: harden incrementally, one knob at a time

The mistake is writing forty directives at once and then debugging which one
broke the service. Do it as a loop, and always edit a drop-in instead of the
packaged unit:

```bash
# Baseline: what does this service expose right now?
systemd-analyze security api.service

# Add a few directives as a drop-in, leaving the packaged unit untouched
sudo systemctl edit api.service     # writes /etc/systemd/system/api.service.d/override.conf

sudo systemctl daemon-reload
sudo systemctl restart api.service
systemctl status api.service
journalctl -u api.service -n 50

# Did the number move, and for the metric you cared about?
systemd-analyze security api.service
```

Add two or three directives, restart, confirm, re-measure. Working in `systemctl
edit` drop-ins keeps the change reviewable and reversible, and it survives a
package upgrade that rewrites the original unit. Then prove the service actually
*does its job* after each step — a unit that starts but cannot reach its database
is a broken service with a prettier score.

## Secrets without a world-readable file: LoadCredential

The old pattern is `EnvironmentFile=/etc/api/env` with mode `0600`, which is fine
until it is not: the value is in the process environment, visible in `/proc`, and
inherited by every child. `LoadCredential=` hands the secret to systemd instead.
systemd reads the file as root, drops privilege, and exposes the content only
through a private directory that the service alone can read:

```ini
LoadCredential=db_password:/etc/api/db_password
```

Inside the service the path is `$CREDENTIALS_DIRECTORY/db_password`, and for a
`Type=oneshot` unit `%d` expands to the same directory. The secret never touches
the environment, never appears in `systemctl show`, and is removed when the unit
stops. Pair it with `StandardOutput=journal` and you can stop worrying about a
password leaking into a log line.

## When hardening breaks a working service

It will. The failure is almost always a service doing something you forgot it
did, and the symptom is usually a start failure or a permission error deep in the
journal rather than a clean message. Keep a root shell open while you experiment,
and remember the shapes of the common breakages:

- **`ProtectSystem=strict`** breaks anything that writes to `/var/log`, `/etc`,
  `/run`, or its own install directory. Add the path to `ReadWritePaths=`.
- **`PrivateTmp=true`** breaks daemons that expect a socket or state file under
  `/tmp` shared with another process.
- **`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`** breaks services that
  open netlink sockets (`AF_NETLINK`), which is most network-aware daemons.
- **`SystemCallFilter=~@resources`** breaks anything calling `setrlimit`,
  `prlimit`, or `sched_setaffinity`.
- **`MemoryDenyWriteExecute=true`** breaks any JIT — Node, some Python C
  extensions, .NET. Leave it off for interpreters that compile at runtime.
- **`ProtectHome=true`** breaks a service whose config or data lives under
  `/home`.

Recovery should be one command, which is why drop-ins matter. Revert your local
changes, reload, and restart:

```bash
# Remove every local drop-in and go back to the packaged unit
sudo systemctl revert api.service
sudo systemctl daemon-reload
sudo systemctl restart api.service
systemctl status api.service
```

Read the journal top-down and fix the *specific* missing right rather than
deleting the whole hardening block. `MemoryDenyWriteExecute=true` was the
expensive line, not `NoNewPrivileges=true`.

## A hardened unit, end to end

Putting it together, a public API that I would be comfortable exposing:

```ini
# /etc/systemd/system/api.service
[Unit]
Description=Public API
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/api --config /etc/api/config.yaml

# Transient identity, no real account, no home directory
DynamicUser=true
StateDirectory=api
RuntimeDirectory=api
WorkingDirectory=/var/lib/api

# Filesystem: read-only everywhere except what it owns
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible

# Privilege and syscall surface
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources @obsolete
SystemCallArchitectures=native

# Resource ceiling and umask
MemoryMax=512M
CPUQuota=150%
TasksMax=64
UMask=0077

# Secret provisioned by systemd, not a world-readable file
LoadCredential=db_password:/etc/api/db_password

[Install]
WantedBy=multi-user.target
```

Note that `ReadWritePaths` is absent: `StateDirectory` and `RuntimeDirectory`
already carve out `/var/lib/api` and `/run/api`, and `ProtectSystem=strict`
handles the rest. That is the pattern — start from the strictest view and add
back exactly what the service proves it needs, one restart at a time.

The through-line is that systemd hardening is not a checklist you paste once. It
is a measurement loop: see the exposure with `systemd-analyze security`, add the
cheapest directive that moves it, confirm the service still works, and keep going.
The unit file is the right place to do it because it is the one place that
applies on every boot and survives every restart. If you are still building the
rest of the box, start with the OS-level checklist in
[hardening a public server](/posts/hardening-a-public-server/), and if you schedule
maintenance jobs, the [systemd timers vs cron](/posts/systemd-timers-vs-cron/)
post covers the same machinery from the scheduling side.
