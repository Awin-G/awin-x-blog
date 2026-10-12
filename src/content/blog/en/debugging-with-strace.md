---
title: "Debugging with strace: when the syscalls tell the story"
description: "A practical guide to syscall debugging with strace: when it beats a debugger or logs, how to attach to a process safely, how to read open/read/connect/futex output and errno, the filters worth memorising (-e trace, -f, -p, -y, -T, -tt), three real workthroughs, and where ltrace and bpftrace fit."
pubDate: 2026-11-27
lang: en
translationKey: debugging-with-strace
tags: [linux, devops]
featured: false
keywords:
  - strace
  - syscall debugging
  - troubleshooting
  - attach to process
  - futex
---

A debugger needs a breakpoint and a symbol. Logs need you to have predicted
the question weeks ago. But a lot of **troubleshooting** is about a process
doing something you never wrote a line of code for — waiting on a lock, failing
a `connect`, writing to a path you did not know about. That is where **strace**
earns its place. It is a blunt, honest instrument for **syscall debugging**: it
records every system call a program makes, with arguments and return values. And
because it works on any binary, including one you cannot rebuild, `strace` is
often the only way to **attach to a process** already running and ask it what it
is actually doing.

## What strace shows, and when it beats a debugger

A program does very little on its own. It reads files, allocates memory, opens
sockets, waits on futexes, and the kernel does the rest. Every one of those
crossings over the user/kernel boundary is a **syscall**, and `strace` sits on
that boundary and prints each one. That is the whole model, and it is worth
holding onto:

<figure>
<svg viewBox="0 0 640 220" width="100%" role="img" aria-label="A program makes a syscall; strace intercepts at the boundary and prints it; the kernel executes it and returns a result or errno.">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <rect x="10" y="30" width="180" height="70" rx="6" fill="currentColor" opacity="0.10" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="100" y="60" text-anchor="middle" opacity="0.9">your program</text>
    <text x="100" y="80" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" opacity="0.6">read(3, ...)</text>

    <rect x="230" y="30" width="180" height="70" rx="6" fill="currentColor" opacity="0.18" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="320" y="60" text-anchor="middle" opacity="0.9">strace (ptrace)</text>
    <text x="320" y="80" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" opacity="0.6">= -1 ENOENT</text>

    <rect x="450" y="30" width="180" height="70" rx="6" fill="currentColor" opacity="0.10" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="540" y="60" text-anchor="middle" opacity="0.9">kernel</text>
    <text x="540" y="80" text-anchor="middle" opacity="0.6">does the work</text>

    <line x1="190" y1="65" x2="230" y2="65" stroke="currentColor" stroke-width="1.5" marker-end="url(#a)"/>
    <line x1="410" y1="65" x2="450" y2="65" stroke="currentColor" stroke-width="1.5" marker-end="url(#a)"/>
    <defs>
      <marker id="a" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="currentColor"/>
      </marker>
    </defs>
    <text x="10" y="150" opacity="0.7" font-size="11">strace prints what crosses this line — arguments in, result or</text>
    <text x="10" y="168" opacity="0.7" font-size="11">errno out. No source, no symbols, no cooperation required.</text>
    <text x="10" y="200" font-family="ui-monospace, monospace" font-size="11" opacity="0.5">user space ————————————— kernel space</text>
  </g>
</svg>
<figcaption><code>strace</code> consumes the syscall stream at the user/kernel boundary via <code>ptrace</code>, so it sees exactly what the program asks the kernel for and exactly what comes back.</figcaption>
</figure>

A debugger tells you where a line of **your** code is slow or wrong. `strace`
tells you what the process is asking of the system, which is a different and
often more useful question. Three cases where I reach for it first:

- **You have no source or symbols.** A vendor binary, a stripped Go service, a
  closed-source agent. `strace` does not need either.
- **The failure is in the environment, not the code.** A missing file, a closed
  port, a permission bit. The program is fine; the world around it is not.
- **The process is already running and misbehaving.** You cannot restart it, and
  you cannot attach `gdb` to a live production process without risk. `strace -p`
  is lighter and answers "what is it doing right now."

## How to attach to a process — and the performance warning

The command everyone remembers is the attach form:

```console
$ sudo strace -p 4711
strace: Process 4711 attached
read(7, 0x7ffd1c2a3f10, 8192)  = -1 EAGAIN (Resource temporarily unavailable)
epoll_wait(4, [], 128, 1000)   = 0
```

That works, and it is magical the first time. But understand what it costs.
`strace` uses `ptrace`, which stops the target at **every** syscall entrance and
exit, hands control to `strace`, then resumes it. For a program doing thousands
of syscalls a second, that is a massive slowdown — often **10× to 100×**, and
sometimes worse. On a busy service, attaching `strace` is not a passive read; it
is a brake pedal. That is the warning, and it is not theoretical:

- Never attach casually to a latency-sensitive production process during peak.
- Prefer a short capture: attach, watch for a few seconds, detach.
- If the process is cheap to restart, `strace` a fresh instance with a **problem-
  reproducing input** instead of the live one.
- When you truly must observe a hot production path with low overhead, that is a
  job for `bpftrace`, not `strace` (see the neighbours section).

Two more things worth knowing. First, `-f` is the flag you will forget and then
need: it follows threads and child processes. Modern services are thread pools
and forked workers, and without `-f` you watch one thread and miss everything
interesting. Second, when attaching to a process inside a container or a
different namespace, `strace` must run with enough privilege to see it — usually
`sudo` on the host, or in the container's PID namespace.

## Reading the output: open, read, write, connect, futex — and errno

The output looks intimidating and is actually very regular. Each line is:

```text
syscall(arguments) = return_value
```

The return value is where the story lives. A non-negative return usually means
success (often a count of bytes or a file descriptor); `-1` means failure, and
`errno` names the reason. Learn to skim the right edge of the output and you are
most of the way to a diagnosis.

```console
$ strace -f -tt -T -y -e trace=openat,connect,read,write ./service
14:02:11.418932 openat(AT_FDCWD, "/etc/mysvc/config.yaml", O_RDONLY) = -1 ENOENT (No such file or directory)
14:02:11.419010 connect(5, {sa_family=AF_INET, sin_port=htons(5432), sin_addr=inet_addr("127.0.0.1")}, 16) = -1 ECONNREFUSED (Connection refused)
14:02:11.419104 openat(AT_FDCWD, "/var/lib/mysvc/state.db", O_RDWR|O_CREAT, 0644) = 9</fd>
14:02:11.419301 write(9, "{\"pid\":812}\n", 11) = 11 <0.000042>
```

Every syscall answers a specific question:

| Syscall | The question it answers | Common failures |
| --- | --- | --- |
| `openat` | What file is it trying to touch? | `ENOENT` (missing), `EACCES` (perms) |
| `read`/`write` | Is it moving data, and how much? | `EAGAIN` (non-blocking), `EPIPE` |
| `connect` | Where is it dialling out to? | `ECONNREFUSED`, `ETIMEDOUT` |
| `futex` | Is it blocked on a lock? | hangs at `FUTEX_WAIT` |
| `epoll_wait` | Is it idle, waiting for events? | long timeouts, no readiness |

`errno` is the point. `ENOENT` and `EACCES` look similar — both mean "I could
not open it" — but one is a wrong path and the other is a wrong user. `ECONNREFUSED`
means something is listening on that address but refused you; `ETIMEDOUT` means
nothing answered at all. Reading `errno` correctly is most of `syscall debugging`.

## Filters that make syscall debugging readable

Raw `strace` on a real program is a firehose. These flags turn it into something
you can read:

- **`-e trace=`** — filter by syscall. `-e trace=file` (everything touching
  paths), `-e trace=network`, or an explicit list like
  `-e trace=openat,connect,read,write`. This is the single biggest win.
- **`-f`** — follow forked children and threads.
- **`-p PID`** — attach to a running process (repeatable, comma-separated for
  several).
- **`-y`** — decode file descriptors to the path or socket they point at. Turns
  `read(7, ...)` into `read(7</var/log/mysvc.log>, ...)`.
- **`-T`** — print the wall-clock time each syscall took, in angle brackets.
- **`-tt`** — prefix timestamps (add another `t`, `-ttt`, for epoch seconds).

Put together, they give you a timeline you can actually reason about:

```console
$ sudo strace -f -tt -T -y -e trace=file -p 4711 2>&1 | head -n 20
14:05:02.100201 openat(AT_FDCWD, "/etc/mysvc/config.yaml", O_RDONLY) = -1 ENOENT (No such file or directory) <0.000021>
14:05:02.100502 openat(AT_FDCWD, "/etc/mysvc/config.yml",  O_RDONLY) = -1 ENOENT (No such file or directory) <0.000018>
14:05:02.100980 openat(AT_FDCWD, "/etc/mysvc/config.json", O_RDONLY) = 12</etc/mysvc/config.json> <0.000034>
```

Redirect `strace` to a file and grep it — `-o trace.log` keeps the program's own
stdout clean, which matters when you are running it interactively.

## Three real workthroughs

### 1. "File not found" — which path, exactly?

A service exits immediately with a generic `config not found`. The log does not
say which path it tried. One command ends the guessing:

```console
$ strace -f -e trace=openat,newfstatat ./mysvc 2>&1 | grep -i config
openat(AT_FDCWD, "/etc/mysvc/config.yaml", O_RDONLY) = -1 ENOENT
openat(AT_FDCWD, "/etc/mysvc/config.yml",  O_RDONLY) = -1 ENOENT
openat(AT_FDCWD, "/etc/mysvc/config.json", O_RDONLY) = 3
newfstatat(AT_FDCWD, "/etc/mysvc/plugins", ...) = -1 ENOENT
```

It parses YAML then YAML again then JSON — and the real problem is the next line:
the plugin directory is missing, so the service starts and dies. The application
message was true but useless; `strace` named the path. This is the same instinct
as [reading a Linux load average](/posts/linux-load-average/): do not trust the
summary, go look at the underlying event.

### 2. "Connection refused" — to what, and at what address?

A worker reports a database error. Is it the right host, the right port, IPv4 or
IPv6, a timeout or a refusal? `-y` and `-e trace=connect` answer it directly:

```console
$ sudo strace -f -yy -T -e trace=connect -p 4711 2>&1 | head
connect(5, {sa_family=AF_INET, sin_port=htons(5432), sin_addr=inet_addr("127.0.0.1")}, 16) = -1 ECONNREFUSED (Connection refused) <0.000311>
connect(6, {sa_family=AF_INET6, sin6_port=htons(5432), in6_addr=inet_pton(AF_INET6, "::1")}, 28) = -1 ECONNREFUSED (Connection refused) <0.000288>
```

The app is trying `127.0.0.1:5432` and `::1:5432`. Nothing is listening —
`ECONNREFUSED` (a RST) is different from a firewall dropping the packet, which
would show as `ETIMEDOUT` after a long `<...>` delay. On a container, `127.0.0.1`
is often the wrong address entirely: the database is on another service, and the
config inherited a loopback default. The syscall told us the address; the address
told us the bug. For latency-shaped questions, the same right-edge reading pairs
well with [I/O latency analysis](/posts/io-latency/).

### 3. "It's stuck" — futex, socket read, or deadlock?

The process is alive, using 0% CPU, and making no progress. Attach and look for
what it is blocked on:

```console
$ sudo strace -f -tt -T -p 4711
[pid  4730] futex(0x7f2a1c001234, FUTEX_WAIT_PRIVATE, 3, NULL <unfinished ...>
[pid  4731] futex(0x7f2a1c001234, FUTEX_WAIT_PRIVATE, 3, NULL <unfinished ...>
[pid  4711] read(12</dev/tcp? or socket>, ... <unfinished ...>
```

`futex(..., FUTEX_WAIT, ...)` means the thread is parked on a lock — a mutex,
a condition variable, a channel in Go. If several threads sit on the **same**
futex address, you have a contention or deadlock problem in application code,
not in the kernel. A thread blocked in `read()` on a socket with no timeout, or
in `epoll_wait` with a long timeout, is a different story: it is waiting for a
peer that never answered, which is exactly why timeouts matter when
[debugging TCP on embedded systems](/posts/debugging-tcp-on-embedded/). `strace`
does not fix either, but it tells you which one you have in seconds.

## Neighbours: ltrace and bpftrace

`strace` watches the kernel boundary. Two related tools watch other boundaries:

- **`ltrace`** intercepts **library calls** (`malloc`, `strcpy`, your own shared
  objects). It is handy when the interesting mistake is in user-space library
  usage rather than a syscall, but it is less maintained and slower — use it when
  `strace` shows the syscalls are fine.
- **`bpftrace`** uses eBPF to observe the kernel with **far lower overhead** and
  no stop-the-world `ptrace`. It can aggregate (histograms, counts), run on busy
  production systems, and trace syscalls, kernel functions, and more, all at once.
  The cost is a steeper language and a need for a modern kernel. When `strace`'s
  overhead is unacceptable — or when you need counts across millions of events —
  reach for `bpftrace`.

Rule of thumb: **`strace` for "what is this one process doing right now",
`ltrace` for library-level behaviour, `bpftrace` for fleet-scale, always-on
observability.**

## A safety note: do not strace a busy production process casually

I will say it plainly because it costs people incidents. `strace` pauses the
target at every syscall. On a high-throughput service that is a self-inflicted
outage: latency spikes, timeouts, dropped requests. Before you attach:

- Get permission and a maintenance window if the process is important.
- Prefer `-e trace=` to narrow the firehose, and keep the capture short.
- Use `-o file` so you are not blocked on a terminal.
- Consider reproducing with a fresh instance and the same input.
- If you need low-overhead, continuous coverage, use `bpftrace` instead.

`strace` is one of the highest-value tools in the *troubleshooting* kit precisely
because it needs nothing from the program — no source, no symbols, no restart.
Respect that same power: it can interrogate any process, and it can stall any
process. Used briefly, deliberately, and on something you are allowed to slow
down, it turns "I have no idea what it is doing" into a one-line answer.
