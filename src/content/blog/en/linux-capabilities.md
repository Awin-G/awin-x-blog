---
title: "Linux capabilities, demystified: root's powers, itemised"
description: "A hands-on Linux capabilities guide with real Docker demos: why root is too much power, how ~40 capabilities split it up, the five sets, capsh, /proc/self/status, getcap/setcap, bounding sets, CAP_SYS_ADMIN, and the drop-all-add-back recipe."
pubDate: 2027-01-18
lang: en
translationKey: linux-capabilities
tags: [security, linux]
featured: false
keywords:
  - Linux capabilities
  - CAP_NET_RAW
  - capsh
  - cap-drop
  - setcap
---

**Linux capabilities** are the answer to a question every sysadmin eventually asks: "Why does a process need to be *root* just to send a raw packet?" Before Linux 2.2, the answer was binary — a process was either fully privileged (root) or not. That meant any program that needed *one* special power (binding a low port, sending a ping, changing a file's owner) had to run as root, and if that program was buggy, your whole machine was compromised. **Capabilities** split root's monolithic power into ~40 fine-grained permissions that can be granted independently, so a process gets exactly what it needs and nothing more. In this article I walk through the model, the five sets, the tools (`capsh`, `getcap`, `setcap`, `/proc/self/status`), how containers use them for least privilege, why `CAP_SYS_ADMIN` is called "the new root", and a practical recipe you can use today. Every demo ran in a throwaway Docker container — no `--privileged`, no sudo on the host.

## Why root is too much power

The traditional Unix privilege model is brutally simple: uid 0 (root) can do everything, everyone else can do very little. The problem is not that root is powerful — it's that "everything" is a lot. Root can:

- Read and write every file on the system, regardless of permissions
- Bind to any port, including privileged ports below 1024
- Send and receive raw network packets (crafting arbitrary packets)
- Load kernel modules, mount filesystems, change the system time
- Trace and kill any process
- Change file ownership, bypass DAC (discretionary access control)

If a single one of those powers is needed by a program — say, a network diagnostic tool that needs to send custom ICMP packets — that program historically had to run as root. And once it runs as root, any vulnerability in it (buffer overflow, logic bug, library flaw) gives the attacker *all* those powers, not just the one the program needed.

Capabilities fix this by breaking root's "everything" into individual, grantable permissions. Instead of "root or nothing", you can say "this process may send raw packets, but may not load kernel modules or change the system time."

<figure>
<svg viewBox="0 0 680 215" width="100%" role="img" aria-label="One large box on the left labelled root containing many small capability boxes. Arrows point from those small boxes to a second large box on the right containing only three of them, showing how root's powers are split into individual capabilities and then a process receives only the three it needs.">
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.5">
    <rect x="10" y="28" width="320" height="170" rx="12"/>
    <rect x="360" y="28" width="310" height="170" rx="12"/>
    <rect x="40" y="50" width="62" height="28" rx="5"/>
    <rect x="110" y="50" width="62" height="28" rx="5"/>
    <rect x="180" y="50" width="62" height="28" rx="5"/>
    <rect x="250" y="50" width="62" height="28" rx="5"/>
    <rect x="40" y="86" width="62" height="28" rx="5"/>
    <rect x="110" y="86" width="62" height="28" rx="5"/>
    <rect x="180" y="86" width="62" height="28" rx="5"/>
    <rect x="250" y="86" width="62" height="28" rx="5"/>
    <rect x="40" y="122" width="62" height="28" rx="5"/>
    <rect x="110" y="122" width="62" height="28" rx="5"/>
    <rect x="180" y="122" width="62" height="28" rx="5"/>
    <rect x="250" y="122" width="62" height="28" rx="5"/>
    <rect x="75" y="160" width="62" height="28" rx="5"/>
    <rect x="145" y="160" width="62" height="28" rx="5"/>
    <rect x="215" y="160" width="62" height="28" rx="5"/>
    <rect x="390" y="50" width="120" height="40" rx="6" fill="#0f766e" fill-opacity="0.15"/>
    <rect x="390" y="110" width="120" height="40" rx="6" fill="#0f766e" fill-opacity="0.15"/>
    <rect x="530" y="75" width="120" height="40" rx="6" fill="#0f766e" fill-opacity="0.15"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="170" y="20" text-anchor="middle" font-weight="600">root (uid 0)</text>
    <text x="515" y="20" text-anchor="middle" font-weight="600">this process</text>
    <text x="71" y="69" text-anchor="middle">CAP_NET_RAW</text>
    <text x="141" y="69" text-anchor="middle">CAP_SYS_ADMIN</text>
    <text x="211" y="69" text-anchor="middle">CAP_CHOWN</text>
    <text x="281" y="69" text-anchor="middle">CAP_KILL</text>
    <text x="71" y="105" text-anchor="middle">CAP_SETUID</text>
    <text x="141" y="105" text-anchor="middle">CAP_SYS_TIME</text>
    <text x="211" y="105" text-anchor="middle">CAP_SYS_MODULE</text>
    <text x="281" y="105" text-anchor="middle">… ~40 total</text>
    <text x="71" y="141" text-anchor="middle">CAP_NET_BIND</text>
    <text x="141" y="141" text-anchor="middle">CAP_SYS_PTRACE</text>
    <text x="211" y="141" text-anchor="middle">CAP_MKNOD</text>
    <text x="281" y="141" text-anchor="middle">CAP_AUDIT</text>
    <text x="106" y="179" text-anchor="middle">CAP_FOWNER</text>
    <text x="176" y="179" text-anchor="middle">CAP_SETPCAP</text>
    <text x="246" y="179" text-anchor="middle">…</text>
    <text x="450" y="75" text-anchor="middle">CAP_NET_RAW</text>
    <text x="450" y="135" text-anchor="middle">CAP_NET_BIND_SERVICE</text>
    <text x="590" y="100" text-anchor="middle">CAP_CHOWN</text>
  </g>
  <g stroke="#0f766e" stroke-width="1.6" fill="none" marker-end="url(#arrow)">
    <line x1="340" y1="64" x2="388" y2="70"/>
    <line x1="340" y1="94" x2="388" y2="125"/>
    <line x1="340" y1="136" x2="528" y2="95"/>
  </g>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
</svg>
<figcaption>Before capabilities: root is one big box of every power. After: each power is a separate capability, and a process receives only the three it needs — <code>CAP_NET_RAW</code>, <code>CAP_NET_BIND_SERVICE</code>, <code>CAP_CHOWN</code> — while the rest stay behind.</figcaption>
</figure>

## The ~40 capabilities: root, itemised

Linux defines roughly 40 named capabilities (the exact count varies slightly by kernel version). Each one maps to a specific privileged operation. The most common ones you'll encounter in the wild:

| Capability | What it allows |
|---|---|
| `CAP_CHOWN` | Change file ownership (chown) |
| `CAP_DAC_OVERRIDE` | Bypass file read/write/execute permission checks |
| `CAP_NET_RAW` | Send/receive raw packets, use raw sockets |
| `CAP_NET_BIND_SERVICE` | Bind to ports below 1024 |
| `CAP_SYS_ADMIN` | Mount filesystems, load modules, and much more — "the new root" |
| `CAP_SYS_PTRACE` | Trace and inspect other processes |
| `CAP_KILL` | Send signals to processes you don't own |
| `CAP_SETUID` | Change the effective uid of a process |
| `CAP_SETPCAP` | Transfer capabilities to/from other processes |

A full list lives in `man 7 capabilities`. The key insight is that these are *independent* — granting `CAP_NET_RAW` does not grant `CAP_CHOWN`, and vice versa.

## The five sets: where capabilities live

Each capability can exist in one or more of five sets attached to a process. Understanding these sets is the key to understanding how capabilities actually work:

- **Effective (CapEff)**: The capabilities the process is currently *using* to make permission checks. If a capability is in this set, the process can exercise it right now.
- **Permitted (CapPrm)**: The capabilities the process is *allowed* to have. This is the maximum it can gain — it can "raise" a capability from permitted to effective at will.
- **Inheritable (CapInh)**: Capabilities that survive across an `execve()` (when a process replaces itself with a new program). Only matters if the new program has file capabilities set.
- **Bounding (CapBnd)**: The *ceiling* — a process can never gain a capability outside its bounding set, no matter what. This is the set that `--cap-drop=ALL` actually shrinks.
- **Ambient (CapAmb)**: Capabilities that are automatically available to child processes, even if they don't have file capabilities. Designed to make file capabilities easier to use in practice.

You can read all five at any time from `/proc/self/status`:

```
$ grep -E "^Cap" /proc/self/status
CapInh:	0000000000000000
CapPrm:	0000000000002000
CapEff:	0000000000002000
CapBnd:	0000000000002000
CapAmb:	0000000000000000
```

These are 64-bit hex masks — each bit represents one capability. To decode them:

```
$ capsh --decode=0000000000002000
0x0000000000002000=cap_net_raw
```

That's a process with exactly one capability: `CAP_NET_RAW`.

## capsh: the Swiss-army knife for capabilities

`capsh` is a tool from the `libcap2-bin` package that lets you inspect and manipulate capabilities from the command line. The most useful invocation is `capsh --print`, which shows your current state:

```
$ capsh --print
Current: cap_wake_alarm=i
Bounding set =cap_chown,cap_dac_override,cap_dac_read_search,cap_fowner,cap_fsetid,cap_kill,cap_setgid,cap_setuid,cap_setpcap,cap_linux_immutable,cap_net_bind_service,cap_net_broadcast,cap_net_admin,cap_net_raw,cap_ipc_lock,cap_ipc_owner,cap_sys_module,cap_sys_rawio,cap_sys_chroot,cap_sys_ptrace,cap_sys_pacct,cap_sys_admin,cap_sys_boot,cap_sys_nice,cap_sys_resource,cap_sys_time,cap_sys_tty_config,cap_mknod,cap_lease,cap_audit_write,cap_audit_control,cap_setfcap,cap_mac_override,cap_mac_admin,cap_syslog,cap_wake_alarm,cap_block_suspend,cap_audit_read,cap_perfmon,cap_bpf,cap_checkpoint_restore
Ambient set =
Current IAB: cap_wake_alarm
Securebits: 00/0x0/1'b0 (no-new-privs=0)
uid=1000(awinx) euid=1000(awinx)
gid=1000(awinx)
Guessed mode: HYBRID (4)
```

Notice: even as a normal user, I have a *bounding set* of ~40 capabilities. They're in the bounding set (the ceiling) but not in the effective set — so I *could* gain them if a setuid binary or file capability lets me, but I'm not using them right now. `capsh` also supports `--drop=`, `--addamb=`, and `--decode=` for interactive capability work.

## The CAP_NET_RAW demo: ping fails, ping succeeds

Here's the experiment that makes everything concrete. I'll use Docker to run two containers — one with *no* capabilities at all, and one with just `CAP_NET_RAW` added back. Then I'll test a raw ICMP socket, which requires `CAP_NET_RAW`.

First, the container with `--cap-drop=ALL`:

```
$ docker run --rm --cap-drop=ALL cap-demo sh -c '
    python3 -c "
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)
    print(\"RAW SOCKET: SUCCESS - have CAP_NET_RAW\")
except PermissionError as e:
    print(f\"RAW SOCKET: DENIED - {e}\")
    "'
RAW SOCKET: DENIED - [Errno 1] Operation not permitted
```

Now the same container with `--cap-drop=ALL --cap-add=NET_RAW`:

```
$ docker run --rm --cap-drop=ALL --cap-add=NET_RAW cap-demo sh -c '
    python3 -c "
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)
    print(\"RAW SOCKET: SUCCESS - have CAP_NET_RAW\")
except PermissionError as e:
    print(f\"RAW SOCKET: DENIED - {e}\")
    "'
RAW SOCKET: SUCCESS - have CAP_NET_RAW
```

Same kernel, same container image, same user (root inside the container). The only difference is one capability. And here's the crucial point: the capability is what matters, not the uid. The process is root in *both* cases — but without `CAP_NET_RAW` in the bounding set, even root cannot create a raw socket. This is the whole point of least privilege.

You might notice that `ping` itself *works* even with `--cap-drop=ALL`, at least on modern kernels. That's because Linux has a sysctl `net.ipv4.ping_group_range` that allows certain groups to use ICMP sockets without `CAP_NET_RAW`:

```
$ cat /proc/sys/net/ipv4/ping_group_range
0	2147483647
```

That setting allows all groups to use ping sockets (a convenience feature). But raw sockets — which let you craft *arbitrary* packets — still require `CAP_NET_RAW`. Don't confuse the two.

## Reading capabilities from /proc/self/status

Let's look at the capability sets directly in each scenario. With `--cap-drop=ALL`:

```
$ docker run --rm --cap-drop=ALL cap-demo sh -c '
    grep -E "^Cap" /proc/self/status &&
    echo "" &&
    capsh --decode=$(grep CapEff /proc/self/status | awk "{print \$2}") &&
    capsh --decode=$(grep CapBnd /proc/self/status | awk "{print \$2}")'
CapInh:	0000000000000000
CapPrm:	0000000000000000
CapEff:	0000000000000000
CapBnd:	0000000000000000
CapAmb:	0000000000000000

0x0000000000000000=

0x0000000000000000=
```

Every set is empty. The bounding set is zero — this process can *never* gain a capability, no matter what binaries it runs. With `--cap-add=NET_RAW`:

```
$ docker run --rm --cap-drop=ALL --cap-add=NET_RAW cap-demo sh -c '
    grep -E "^Cap" /proc/self/status &&
    echo "" &&
    capsh --decode=$(grep CapEff /proc/self/status | awk "{print \$2}")'
CapInh:	0000000000000000
CapPrm:	0000000000002000
CapEff:	0000000000002000
CapBnd:	0000000000002000
CapAmb:	0000000000000000

0x0000000000002000=cap_net_raw
```

Now the bounding set, permitted, and effective all contain exactly `cap_net_raw`. The `capsh --print` output in this container confirms it:

```
$ docker run --rm --cap-drop=ALL --cap-add=NET_RAW cap-demo capsh --print
Current: cap_net_raw=ep
Bounding set =cap_net_raw
Ambient set =
uid=0(root) euid=0(root)
Guessed mode: HYBRID (4)
```

`ep` means "effective + permitted". The bounding set has shrunk from ~40 capabilities to exactly one. That's least privilege in action.

## File capabilities vs setuid root

There are two ways to grant a non-root process a specific capability: **setuid root** and **file capabilities**.

A setuid-root binary is owned by root and has the setuid bit set, so when you run it, the process gets root's *full* privilege. That's the old model — all or nothing. A **file capability** attaches specific capabilities to a binary, so running it grants only those capabilities, not full root.

The `getcap` command shows file capabilities on a binary. On a typical Debian/Ubuntu system, `ping` has a file capability instead of being setuid root:

```
$ getcap /usr/bin/ping
/usr/bin/ping cap_net_raw=ep
```

That means: when any user runs `ping`, the process automatically gets `CAP_NET_RAW` in its effective and permitted sets. Let's see it in action. I'll copy `ping`, give it a file capability, and watch `chown` fail then succeed with `CAP_CHOWN`:

```
$ cp /usr/bin/ping /tmp/ping-test
$ setcap cap_net_raw+ep /tmp/ping-test
$ getcap /tmp/ping-test
/tmp/ping-test cap_net_raw=ep

$ ls -la /tmp/ping-test
-rwxr-xr-x 1 root root 156136 Oct 13 00:38 /tmp/ping-test

$ /tmp/ping-test -c 1 -W 2 127.0.0.1
PING 127.0.0.1 (127.0.0.1) 56(84) bytes of data.
64 bytes from 127.0.0.1: seq=0 ttl=64 time=0.034 ms

--- 127.0.0.1 ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 0.034/0.034/0.034/0.000 ms

$ setcap -r /tmp/ping-test
$ getcap /tmp/ping-test
(empty = caps removed)
```

The same principle applies to `chown`. Here's a demo showing a shell copy with `CAP_CHOWN` that can change file ownership without being root:

```
$ cp /bin/sh /tmp/dash-cown
$ setcap cap_chown+ep /tmp/dash-cown
$ getcap /tmp/dash-cown
/tmp/dash-cown cap_chown=ep

$ /tmp/dash-cown -c "chown 1000:1000 /tmp/testfile && echo chown NOW WORKS with CAP_CHOWN"
chown NOW WORKS with CAP_CHOWN
```

File capabilities are the modern replacement for setuid. They grant *specific* powers rather than the whole of root. The tradeoff is complexity — you need to manage them with `setcap`/`getcap`, and not all filesystems support them (most modern ones do).

## How containers use capabilities: the Docker story

Docker containers start with a default set of ~14 capabilities — a curated list that's broader than what a typical process needs. The default set includes `CAP_NET_RAW`, `CAP_CHOWN`, `CAP_DAC_OVERRIDE`, `CAP_SETUID`, `CAP_SETGID`, `CAP_NET_BIND_SERVICE`, and a few others. This is why `ping` works inside a container without any special configuration.

The `--cap-drop` and `--cap-add` flags let you adjust this set. The security best practice is **drop all, add back only what you need**:

```
$ docker run --rm --cap-drop=ALL --cap-add=NET_RAW cap-demo sh -c 'ping -c 1 -W 2 127.0.0.1'
PING 127.0.0.1 (127.0.0.1) 56(84) bytes of data.
64 bytes from 127.0.0.1: seq=0 ttl=64 time=0.055 ms

--- 127.0.0.1 ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 0.055/0.055/0.055/0.000 ms
```

This container can ping (because we added `CAP_NET_RAW` back) but cannot chown files, bind low ports, change the system time, load kernel modules, or do any of the other ~39 things the default set would allow. If the container is compromised, the attacker's capabilities are bounded by exactly what we added back.

The bounding set is the key. When you use `--cap-drop=ALL`, Docker sets the container's bounding set to empty. Even if a binary inside the container has file capabilities or is setuid root, the bounding set acts as a ceiling that caps what those mechanisms can grant. No binary, no exploit, no setuid trick can give the process a capability outside its bounding set.

## CAP_SYS_ADMIN: the "new root" problem

Not all capabilities are created equal. `CAP_SYS_ADMIN` is a grab-bag of administrative powers — mounting filesystems, manipulating namespaces, configuring the network, loading modules, and much more. It's so broad that security practitioners call it "the new root." Granting `CAP_SYS_ADMIN` to a container is often equivalent to giving it full root on the host, because the container can use those powers to escape its namespace and access the host.

This is why the default Docker set *does* include `CAP_SYS_ADMIN` — many workloads need it (Docker-in-Docker, some storage drivers, certain monitoring tools). But if you don't need it, drop it:

```
$ docker run --rm --cap-drop=ALL cap-demo sh -c 'capsh --print'
Current: =ep
Bounding set =
Ambient set =
uid=0(root) euid=0(root)
```

An empty bounding set. The process is root by uid, but it has no capabilities at all. It can't mount, can't ptrace, can't do anything privileged. This is the container equivalent of `setuid` on a stripped binary — the shell says "root" but the kernel says "no."

## The practical recipe: drop all, add back the one you need

The recipe I use for every container that doesn't need a broad default set:

1. **Start with `--cap-drop=ALL`** — strip the bounding set to zero.
2. **Add back only what the application needs** — e.g., `--cap-add=NET_RAW` for a network tool, `--cap-add=NET_BIND_SERVICE` for a web server on port 80.
3. **Combine with other hardening** — `--read-only` filesystem, `--security-opt=no-new-privileges`, a non-root `--user`, and resource limits.

A concrete example — a container that only needs to bind port 80 and nothing else:

```
$ docker run --rm --cap-drop=ALL --cap-add=NET_BIND_SERVICE --read-only cap-demo sh -c 'echo "I can bind port 80, and nothing else"'
I can bind port 80, and nothing else
```

That's the whole philosophy: **least privilege**. Not "root with extra steps," but a process that has exactly the powers its job requires — no more, no less.

If you're running containers in production, audit what capabilities each one actually needs. Most don't need most of the defaults. The [container security basics](/posts/container-security/) and [hardening a public server](/posts/hardening-a-public-server/) articles are good companions for this work.

## Wrapping up

Linux capabilities are the mechanism that makes least privilege practical on Linux. They split root's monolithic power into ~40 independent permissions, organize them into five sets (effective, permitted, inheritable, bounding, ambient), and let you grant exactly what a process needs — no more. The tools are simple: `capsh` to inspect and manipulate, `getcap`/`setcap` to manage file capabilities, `/proc/self/status` to read the raw masks, and Docker's `--cap-drop`/`--cap-add` to apply the model in containers.

The key takeaway: **the bounding set is the ceiling**. Drop it to zero, add back only what you need, and you've shrunk the attack surface from "all of root" to "the one power this program actually uses." That's the difference between a compromised container that can read your host's files and one that can do exactly one thing — nothing more.
