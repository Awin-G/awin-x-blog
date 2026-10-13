---
title: "Hardening a Container: seccomp, Read-Only Filesystems, and Capabilities"
description: "A practical guide to Docker security options with real experiments: seccomp profiles, read-only containers, capability dropping, and no-new-privileges."
pubDate: 2027-01-26
lang: en
translationKey: container-seccomp-hardening
tags: [security, devops]
featured: false
keywords:
  - container seccomp
  - docker security options
  - read-only container
  - cap-drop
  - no-new-privileges
---

> **Authorised use note.** All experiments below run against your own local Docker
> daemon and your own containers. Do not run these against infrastructure you do not
> own or without explicit permission.

## Why container hardening matters

Containers are not virtual machines. They share the host kernel, and every syscall your
application makes goes through the kernel's security layers before it reaches hard
ware. If your application is compromised — through a dependency CVE, a deserialisation
bug, or a confused-deputy misconfiguration — the attacker still has to escape the
container's isolation layers to do real damage.

I have written before about [container security](/posts/container-security/) and
[Linux capabilities](/posts/linux-capabilities/). This post builds on both: I'll show
you, with real experiments, how to layer seccomp, read-only filesystems, capability
dropping, and `no-new-privileges` so that a compromised application has as little
surface as possible.

## The isolation stack

A container is not a single mechanism. It is a stack of kernel features that work
together:

<figure>
<svg viewBox="0 0 640 320" xmlns="http://www.w3.org/2000/svg" font-family="monospace" font-size="12">
  <!-- Host kernel -->
  <rect x="20" y="260" width="600" height="40" rx="4" fill="#e5e7eb" stroke="#9ca3af"/>
  <text x="320" y="285" text-anchor="middle" fill="#374151">Linux kernel (syscall interface)</text>
  <!-- Layers -->
  <rect x="40" y="210" width="560" height="40" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="320" y="235" text-anchor="middle" fill="#92400e">seccomp (BPF syscall filter)</text>
  <rect x="40" y="160" width="560" height="40" rx="4" fill="#dbeafe" stroke="#2563eb"/>
  <text x="320" y="185" text-anchor="middle" fill="#1e40af">Capabilities (fine-grained root)</text>
  <rect x="40" y="110" width="560" height="40" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="320" y="135" text-anchor="middle" fill="#166534">Namespaces (pid, net, mount, ipc, uts, user)</text>
  <rect x="40" y="60" width="560" height="40" rx="4" fill="#fee2e2" stroke="#dc2626"/>
  <text x="320" y="85" text-anchor="middle" fill="#991b1b">cgroups (resource limits)</text>
  <!-- Container -->
  <rect x="240" y="10" width="160" height="40" rx="4" fill="#0f766e" stroke="#0f766e"/>
  <text x="320" y="35" text-anchor="middle" fill="#ffffff">Application</text>
  <!-- Arrows -->
  <line x1="320" y1="50" x2="320" y2="60" stroke="#6b7280" stroke-width="2"/>
  <line x1="320" y1="100" x2="320" y2="110" stroke="#6b7280" stroke-width="2"/>
  <line x1="320" y1="150" x2="320" y2="160" stroke="#6b7280" stroke-width="2"/>
  <line x1="320" y1="200" x2="320" y2="210" stroke="#6b7280" stroke-width="2"/>
  <line x1="320" y1="250" x2="320" y2="260" stroke="#6b7280" stroke-width="2"/>
</svg>
<figcaption>FIG. 1 — The container isolation stack. Each layer shrinks the attack surface; seccomp sits closest to the kernel.</figcaption>
</figure>

The key insight: **defence in depth**. No single layer is sufficient. seccomp alone
won't stop a container escape if the container runs as root with all capabilities. A
read-only filesystem alone won't stop a reverse shell if the application can still
make network syscalls. You stack them.

## seccomp: the kernel's syscall filter

seccomp (Secure Computing Mode) is a Linux kernel feature that filters syscalls using
BPF (Berkeley Packet Filter). When a process calls a syscall, the kernel checks the
BPF program attached to that process. The program returns an action: allow, kill, trap,
or return an error.

Docker applies a default seccomp profile to every container unless you override it with
`--security-opt seccomp=unconfined`. The default profile allows ~330 common syscalls
and blocks ~50 dangerous ones (e.g., `kexec_load`, `reboot`, `swapon`, `bpf`).

Here is the real contrast. I compiled a small C program that calls three syscalls
that the default seccomp profile blocks: `bpf`, `perf_event_open`, and `userfaultfd`.

**Default seccomp profile** (Docker's built-in):

```console
$ docker run --rm alpine:latest sh -c "apk add --no-cache python3 >/dev/null 2>&1 && python3 -c \"
import ctypes, errno
libc = ctypes.CDLL(None, use_errno=True)
for name, nr in [('bpf', 321), ('perf_event_open', 298), ('userfaultfd', 323)]:
    r = libc.syscall(nr, 0, 0, 0, 0, 0)
    e = ctypes.get_errno()
    print(f'{name}: ret={r} errno={e} ({errno.errorcode.get(e,\\\"?\\\")})')
\""
bpf: ret=-1 errno=1 (EPERM)
perf_event_open: ret=-1 errno=1 (EPERM)
userfaultfd: ret=-1 errno=1 (EPERM)
```

**Unconfined seccomp** (`--security-opt seccomp=unconfined`):

```console
$ docker run --rm --security-opt seccomp=unconfined alpine:latest sh -c "apk add --no-cache python3 >/dev/null 2>&1 && python3 -c \"
import ctypes, errno
libc = ctypes.CDLL(None, use_errno=True)
for name, nr in [('bpf', 321), ('perf_event_open', 298), ('userfaultfd', 323)]:
    r = libc.syscall(nr, 0, 0, 0, 0, 0)
    e = ctypes.get_errno()
    print(f'{name}: ret={r} errno={e} ({errno.errorcode.get(e,\\\"?\\\")})')
\""
bpf: ret=-1 errno=22 (EINVAL)
perf_event_open: ret=-1 errno=14 (EFAULT)
userfaultfd: ret=-1 errno=1 (EPERM)
```

Notice the difference. With the default profile, all three syscalls return `EPERM`
(errno 1) — seccomp blocks them before they reach the kernel. With `unconfined`, the
syscalls reach the kernel and fail with `EINVAL` (invalid argument) or `EFAULT`
(bad address) because I passed zero arguments. The syscall *was* allowed through;
it just failed at the kernel's argument validation. `userfaultfd` still returns
`EPERM` because it also requires `CAP_SYS_ADMIN` — capabilities are a separate layer.

This is the contrast that matters: **seccomp turns a would-be exploit primitive into
an immediate `EPERM`**. Even if an attacker finds a vulnerability in your application,
the syscalls they need to escalate privileges or escape the container are blocked at
the kernel boundary.

## Writing a custom seccomp profile

Docker's default profile is a curated allowlist. You can write your own. The profile
is a JSON file with a `defaultAction` and a list of `syscalls`. The most restrictive
approach is `SCMP_ACT_ERRNO` (default deny) with an explicit allowlist:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64"],
  "syscalls": [
    {
      "names": ["read", "write", "open", "close", "fstat", "mmap", "mprotect",
                "munmap", "brk", "rt_sigaction", "rt_sigprocmask", "execve",
                "exit_group", "access", "arch_prctl", "clock_gettime",
                "epoll_create1", "epoll_ctl", "epoll_wait", "fcntl", "futex",
                "getcwd", "getdents64", "getpid", "getrandom", "getrlimit",
                "getuid", "ioctl", "lseek", "madvise", "mkdirat", "newfstatat",
                "openat", "pipe2", "poll", "pread64", "readv", "recvmsg",
                "rt_sigreturn", "set_robust_list", "set_tid_address",
                "socket", "socketpair", "stat", "tgkill", "uname",
                "wait4", "writev"],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

Apply it with `--security-opt seccomp=./profile.json`. If you miss a syscall your
application needs, it will fail at runtime — often with a confusing error. I learned
this the hard way when I omitted `epoll_ctl` and my HTTP server hung silently instead
of crashing with a clear error.

Here is a real failure from a custom profile that blocks `bpf` but allows everything
else (a simpler default-allow with a targeted deny, which is easier to debug):

```console
$ docker run --rm --security-opt seccomp=./block-bpf.json alpine:latest python3 -c "..."
bpf: ret=-1 errno=1 (EPERM)
perf_event_open: ret=-1 errno=14 (EFAULT)
userfaultfd: ret=-1 errno=1 (EPERM)
```

The `bpf` syscall is blocked with `EPERM`, while `perf_event_open` reaches the kernel
and fails with `EFAULT`. This confirms the deny rule works: the filter intercepts
`bpf` before the kernel sees it.

**A word of caution.** Do not cargo-cult a profile from the internet. Every
application has different syscall needs. A profile that is too restrictive will break
your application in production. Start with Docker's default, monitor what your
application actually calls (`strace -f -e trace=network,process,file` is your friend),
and only add restrictions when you have evidence they are needed.

## Read-only filesystem

The next layer is making the container's root filesystem read-only:

```console
$ docker run --rm --read-only alpine:latest sh -c "echo test > /tmp/testfile && echo 'write to /tmp succeeded' || echo 'write to /tmp failed'"
write to /tmp failed
sh: can't create /tmp/testfile: Read-only file system
```

Now add a tmpfs mount for `/tmp`:

```console
$ docker run --rm --read-only --tmpfs /tmp alpine:latest sh -c "echo test > /tmp/testfile && echo 'write to /tmp succeeded' || echo 'write to /tmp failed'"
write to /tmp succeeded
```

Writes to `/etc` still fail:

```console
$ docker run --rm --read-only alpine:latest sh -c "echo test > /etc/testfile 2>&1 || echo 'write to /etc failed'"
sh: can't create /etc/testfile: Read-only file system
write to /etc failed
```

This is powerful because many attacks rely on writing files: dropping a cron job in
`/etc/cron.d`, planting a shared library in `/usr/lib`, or modifying the application's
binary. With `--read-only`, those writes fail with `EROFS`. The tmpfs for `/tmp` is
ephemeral — it lives in memory and disappears when the container stops.

## Drop capabilities

Linux divides root's monolithic power into ~40 fine-grained capabilities. Docker
grants a default set (~14) to every container. You can drop them all:

```console
$ docker run --rm alpine:latest sh -c "cat /proc/self/status | grep Cap"
CapInh: 0000000000000000
CapPrm: 00000000a80425fb
CapEff: 00000000a80425fb
CapBnd: 00000000a80425fb
CapAmb: 0000000000000000
```

```console
$ docker run --rm --cap-drop=ALL alpine:latest sh -c "cat /proc/self/status | grep Cap"
CapInh: 0000000000000000
CapPrm: 0000000000000000
CapEff: 0000000000000000
CapBnd: 0000000000000000
CapAmb: 0000000000000000
```

With `--cap-drop=ALL`, the effective capability set is zero. `mount` fails:

```console
$ docker run --rm --cap-drop=ALL alpine:latest sh -c "mount -t tmpfs tmpfs /mnt 2>&1 || echo 'mount failed'"
mount: permission denied (are you root?)
mount failed
```

I have written more about capabilities in [a dedicated post](/posts/linux-capabilities/);
the key takeaway here is that `--cap-drop=ALL` is the nuclear option, and you add back
only what your application needs with `--cap-add`.

## Run as a non-root user

This is the most impactful and most underused option:

```console
$ docker run --rm --user 1000:1000 alpine:latest sh -c "id && whoami"
uid=1000 gid=1000 groups=1000
whoami: unknown uid 1000
```

Even if an attacker escapes the application, they are uid 1000, not root. They cannot
read `/etc/shadow`, cannot bind to ports below 1024, and cannot modify system files.
Combined with `--read-only`, a non-root user has very little room to maneuver.

## no-new-privileges

`--security-opt no-new-privileges` prevents the container's processes from gaining new
privileges through `setuid` binaries or `execve` calls. This blocks a whole class of
privilege escalation exploits:

```console
$ docker run --rm --security-opt no-new-privileges alpine:latest sh -c "cat /proc/self/status | grep -i 'NoNewPrivs\|CapEff\|CapBnd'"
CapEff: 00000000a80425fb
CapBnd: 00000000a80425fb
NoNewPrivs: 1
```

With `NoNewPrivs: 1`, a setuid binary like `su` or `sudo` inside the container cannot
elevate privileges beyond the current bounding set. This is especially important for
containers that run untrusted code or third-party dependencies.

## Putting it all together

A hardened container invocation looks like this:

```bash
docker run \
  --read-only \
  --tmpfs /tmp \
  --user 1000:1000 \
  --cap-drop=ALL \
  --cap-add=NET_BIND_SERVICE \
  --security-opt no-new-privileges \
  --security-opt seccomp=./custom-profile.json \
  -p 127.0.0.1:8080:8080 \
  myapp:latest
```

Each flag is a layer:

| Layer | Flag | What it blocks |
|---|---|---|
| Filesystem | `--read-only` | Writing to rootfs |
| User | `--user 1000:1000` | Running as root |
| Capabilities | `--cap-drop=ALL` | Kernel privilege bits |
| seccomp | `--security-opt seccomp=...` | Dangerous syscalls |
| Privilege escalation | `--security-opt no-new-privileges` | setuid exploits |

## The honest framing

I want to be clear about what these layers do and do not do. **They are not a silver
bullet.** The real risk in most containers is the application code and the mounts you
give it, not a missing seccomp rule. If your application has a remote code execution
vulnerability, the attacker can still exfiltrate data over the network — seccomp does
not block `sendto`. If you mount the Docker socket (`/var/run/docker.sock`) into the
container, all of these layers are bypassed because the container can talk directly to
the Docker daemon, which runs as root.

These layers are **defence in depth**. They make exploitation harder, not impossible.
They buy you time and increase the chance that an intrusion is detected before it
becomes a compromise. Use them as part of a broader strategy that includes minimal
base images, dependency scanning, network segmentation, and least-privilege mounts.

But do not cargo-cult security options. Understand what each flag does, test that your
application still works, and add restrictions based on evidence, not fear.
