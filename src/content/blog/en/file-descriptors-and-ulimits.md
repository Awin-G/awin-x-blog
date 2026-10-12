---
title: "File descriptor limit: the 'too many open files' bug and how to fix it"
description: "What a file descriptor is, why files, sockets and pipes share one limit, how to read soft vs hard limits with ulimit -n and /proc/<pid>/limits, what EMFILE means, and a checklist for fixing 'too many open files' — raise the limit, then find the leak."
pubDate: 2027-01-06
lang: en
translationKey: file-descriptors-and-ulimits
tags: [linux, devops]
featured: false
keywords:
  - file descriptor limit
  - too many open files
  - ulimit -n
  - EMFILE
  - LimitNOFILE
  - lsof
  - /proc/pid/fd
---

Every few months a service of mine dies the same way: CPU fine, memory fine, logs full of `Too many open files`. The process is not out of RAM — it is out of **file descriptors**, the small integers the kernel hands out for every open file, socket, pipe and eventfd. When a process hits its **file descriptor limit**, the next `open()`, `socket()` or `accept()` fails with `EMFILE` ("Too many open files"), and a server that cannot `accept()` is a dead server. In this post I show what a file descriptor is, how to read the soft and hard limits with `ulimit -n` and `/proc/<pid>/limits`, what `EMFILE` actually means, and the two-part fix: raise the limit, then find the leak. All output below is real, captured on this machine.

## What a file descriptor actually is

<figure>
  <svg viewBox="0 0 560 240" role="img" aria-label="A process file descriptor table mapping small integers to kernel objects" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/>
      </marker>
    </defs>
    <text x="20" y="24" font-family="monospace" font-size="14" fill="currentColor">process fd table</text>
    <g font-family="monospace" font-size="13" fill="currentColor">
      <rect x="20" y="40" width="150" height="26" fill="none" stroke="currentColor"/>
      <text x="30" y="57">0 → /dev/null</text>
      <rect x="20" y="70" width="150" height="26" fill="none" stroke="currentColor"/>
      <text x="30" y="87">1 → socket</text>
      <rect x="20" y="100" width="150" height="26" fill="none" stroke="currentColor"/>
      <text x="30" y="117">2 → socket</text>
      <rect x="20" y="130" width="150" height="26" fill="none" stroke="currentColor"/>
      <text x="30" y="147">3 → file</text>
      <rect x="20" y="160" width="150" height="26" fill="none" stroke="currentColor"/>
      <text x="30" y="177">… → pipe, eventfd…</text>
    </g>
    <g stroke="currentColor" fill="none" marker-end="url(#arr)">
      <line x1="170" y1="53" x2="240" y2="53"/>
      <line x1="170" y1="83" x2="240" y2="83"/>
      <line x1="170" y1="113" x2="240" y2="113"/>
      <line x1="170" y1="143" x2="240" y2="143"/>
      <line x1="170" y1="173" x2="240" y2="173"/>
    </g>
    <g font-family="monospace" font-size="13" fill="currentColor">
      <text x="250" y="57">file (inode)</text>
      <text x="250" y="87">TCP socket</text>
      <text x="250" y="117">TCP socket</text>
      <text x="250" y="147">file (inode)</text>
      <text x="250" y="177">pipe / eventfd / …</text>
    </g>
    <text x="20" y="220" font-family="monospace" font-size="12" fill="currentColor">one integer = one slot = one kernel object</text>
  </svg>
  <figcaption>Every open file, socket, pipe or eventfd consumes exactly one slot in the process's file descriptor table.</figcaption>
</figure>

A file descriptor (fd) is just an index into a per-process table. The kernel keeps one table per process; each row points at some kernel object — an open file, a TCP socket, a pipe, an eventfd, an epoll instance. When you call `open()`, `socket()`, `pipe()` or `epoll_create()`, the kernel allocates the lowest free row and returns its number. When you `close()` it, the row is freed. That is the whole mechanism.

The consequence that bites people: **everything** consumes one fd. A listening socket is one fd. Every accepted connection is one fd. Every log file, every pipe to a subprocess, every timerfd — one fd each. A server that accepts a connection and forgets to close it leaks one fd per request, forever.

A plain shell already shows the shape of it:

```
$ ls -l /proc/self/fd
total 0
lr-x------ 1 awinx awinx 64 Oct 13 03:47 0 -> /dev/null
lrwx------ 1 awinx awinx 64 Oct 13 03:47 1 -> socket:[5059678]
lrwx------ 1 awinx awinx 64 Oct 13 03:47 2 -> socket:[5059680]
lr-x------ 1 awinx awinx 64 Oct 13 03:47 3 -> /proc/596590/fd
$ ls /proc/self/fd | wc -l
4
```

Four fds: stdin, two sockets (this shell's stdout and stderr are sockets because its output is captured), and the `/proc/self/fd` directory itself. The `socket:[...]` entries are kernel sockets; the number in brackets is the kernel inode.

## Soft vs hard limits: where the ulimit -n number comes from

Every process has two numbers: a **soft limit** (what the kernel enforces right now) and a **hard limit** (the ceiling a non-privileged process may raise the soft limit to). `ulimit -n` prints the soft limit; `ulimit -Hn` prints the hard one. The authoritative view is `/proc/<pid>/limits`:

```
$ ulimit -n
524288
$ ulimit -Sn
524288
$ ulimit -Hn
524288
$ grep 'open files' /proc/self/limits
Max open files            524288               524288               files
```

On this host soft and hard are both 524288. On a typical server they differ — say 1024 soft, 65536 hard — and the gap is the headroom you can claim without root.

Where the numbers come from, in order of precedence:

- **Docker**: `--ulimit nofile=SOFT:HARD` on `docker run`, or the daemon default. Containers do not inherit the host's limit.
- **systemd**: `LimitNOFILE=` in the unit's `[Service]` section. This is what actually sets the limit for most daemons.
- **Login PAM**: `/etc/security/limits.conf` applies to login sessions (and anything that goes through PAM). On this box it is empty — no non-comment lines — so the defaults stand.
- **The kernel ceiling**: `fs.nr_open` is the absolute per-process maximum; `fs.file-max` is the system-wide total. Nothing can exceed these, not even root.

```
$ cat /proc/sys/fs/file-max /proc/sys/fs/nr_open
9223372036854775807
2147483584
```

The config looks like this:

```
# /etc/security/limits.conf — applied at login via PAM
*         soft    nofile      65536
*         hard    nofile      65536
```

```
# /etc/systemd/system/myapp.service
[Service]
LimitNOFILE=65536
```

```
$ docker run --ulimit nofile=65536:65536 ...
```

## Watching file descriptors in real time

Three tools I reach for, in order:

- `ls /proc/<pid>/fd` — the raw table. `ls /proc/<pid>/fd | wc -l` is the count.
- `lsof -p <pid>` — the same table, decoded: file types, paths, socket states.
- `ss -tlnp` — which process owns which listening socket.

From the server experiment later in this post:

```
$ ss -tlnp | grep 8766
LISTEN 65     64         127.0.0.1:8766       0.0.0.0:*    users:(("python3",pid=608200,fd=3))
```

That one line tells me the listener is pid 608200, fd 3, with a backlog of 64.

## The failure: EMFILE, and its quieter cousin ENFILE

`EMFILE` (errno 24) means *this process's* fd table is full. `ENFILE` (errno 23) means the *system-wide* table is full — every process together has exhausted `fs.file-max`. `EMFILE` is the common one; `ENFILE` is rare and usually means a kernel-level problem or a genuinely huge number of processes.

Here is a minimal reproducer. It opens loopback TCP sockets until the kernel refuses:

```python
# leak.py — open sockets until EMFILE
import errno, os, socket, time

sockets = []
try:
    while True:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind(("127.0.0.1", 0))
        s.listen(1)
        sockets.append(s)
except OSError as e:
    print(f"opened {len(sockets)} sockets before failure")
    print(f"error: errno={e.errno} ({errno.errorcode.get(e.errno, '?')}): {e}")
    print(f"my pid: {os.getpid()}")
    time.sleep(25)
```

Run it under a lowered soft limit in a subshell:

```
$ bash -c 'ulimit -n 256; python3 -u leak.py'
opened 253 sockets before failure
error: errno=24 (EMFILE): [Errno 24] Too many open files
my pid: 594982
inspect me now:  ls /proc/594982/fd | wc -l
$ ls /proc/594982/fd | wc -l
256
$ grep 'open files' /proc/594982/limits
Max open files            256                  256                  files
```

253 sockets plus the interpreter's own three standard fds fill the table to exactly 256. The same thing happens with plain files:

```
$ bash -c 'ulimit -n 128; python3 -c "import errno; ..."'
opened 125 files before failure
error: errno=24 (EMFILE): [Errno 24] Too many open files: '/tmp/opencode/work/fd-ulimits/filler.txt'
```

Now the version that matters in production: a server whose `accept()` fails. This server listens on loopback, accepts connections, and — the bug — never closes them:

```
$ bash -c 'ulimit -n 64; python3 -u server.py 8766' &
$ python3 client.py          # opens 200 connections
opened 50
opened 100
connection 125 failed: timed out
client holding 124 connections
```

The server's log:

```
accepted #58 from ('127.0.0.1', 58952)
accepted #59 from ('127.0.0.1', 58960)
accept() died after 59 connections: errno=24 (EMFILE): [Errno 24] Too many open files
```

Fifty-nine connections in, `accept()` starts failing. The client's connection 125 times out — the server is still listening, but it cannot accept another fd, so new connections stall in the backlog. Inspecting the dying process:

```
$ grep 'open files' /proc/608200/limits
Max open files            64                   64                   files
$ ls /proc/608200/fd | wc -l
64
$ lsof -p 608200 | awk 'NR>1 {print $5}' | sort | uniq -c
      1 CHR
      2 DIR
      1 FIFO
     60 IPv4
     15 REG
```

The fd table holds exactly 64 entries — the limit. Sixty of the lsof rows are IPv4 sockets: the listening socket plus 59 accepted connections that were never closed. The rest are the interpreter's own files (binary, mapped libraries, cwd, root).

## Why an fd leak looks like a memory leak's cousin

Watch the leaking process's memory while it eats fds:

```
$ grep VmRSS /proc/609478/status
VmRSS:	   14692 kB
$ ls /proc/609478/fd | wc -l
256
```

RSS is 14 MB and barely moves as the fd count climbs to the limit — sockets and files cost kernel memory, not userspace RSS. So the process looks healthy on every memory graph you have, while its fd table fills and fills. The symptom is not "the process got big"; it is "the process stopped doing new work". If you monitor only memory, an fd leak is invisible until the day the service falls over.

## Raising the limit buys time; finding the leak is the fix

Docker makes the limit explicit and proves it inside the container:

```
$ ulimit -n                      # on the host
524288
$ docker run --rm alpine:3.21 sh -c 'ulimit -n'
1024
$ docker run --rm --ulimit nofile=64:64 alpine:3.21 sh -c 'ulimit -Sn; ulimit -Hn'
64
64
```

The container does not inherit the host's 524288 — it gets the daemon default of 1024, and `--ulimit nofile=64:64` pins it to 64. And the failure follows the limit down:

```
$ docker run --rm --ulimit nofile=64:64 alpine:3.21 sh -c 'i=3; while [ $i -lt 70 ]; do eval "exec $i<>/dev/null" || { echo "open failed at fd $i"; break; }; i=$((i+1)); done'
sh: eval: line 0: can't create /dev/null: No file descriptors available
$ docker run --rm --ulimit nofile=64:64 debian:bookworm-slim bash -c 'i=3; while [ $i -lt 70 ]; do if eval "exec $i<>/dev/null"; then i=$((i+1)); else echo "open failed at fd $i"; break; fi; done'
bash: line 1: /dev/null: Too many open files
open failed at fd 64
```

Inside the container, fds 3–63 open fine and fd 64 fails — the same `EMFILE`, with the shell's own wording ("No file descriptors available" in busybox, "Too many open files" in bash).

So the fix has two halves, and the order matters:

1. **Find the leak first.** If the fd count grows without bound, raising the limit only delays the crash. Watch `ls /proc/<pid>/fd | wc -l` over time, or `lsof -p <pid>` grouped by type, and diff after load. The leak is usually a missing `close()` on an error path, a connection pool that never shrinks, or a library that opens something per request.
2. **Then raise the limit** for the usage you actually need. In a subshell: `bash -c 'ulimit -n 65536; exec myapp'`. For a daemon: `LimitNOFILE=` in the systemd unit. For a container: `--ulimit nofile=`. For a login service: `/etc/security/limits.conf`. Raise the soft limit toward the hard limit; only root can raise the hard limit, and never past `fs.nr_open`.

## Checklist

When a service logs `Too many open files`:

- [ ] Confirm the limit: `ulimit -n`, `ulimit -Hn`, `grep 'open files' /proc/<pid>/limits`.
- [ ] Count the fds: `ls /proc/<pid>/fd | wc -l`, and `lsof -p <pid>` to group them by type.
- [ ] Watch the count over time — a leak grows, a busy server plateaus.
- [ ] Find the leak before raising anything: missing `close()`, per-request opens, pools that never shrink.
- [ ] Raise the limit to match legitimate usage: `LimitNOFILE=` for systemd, `--ulimit nofile=` for Docker, `limits.conf` for login sessions.
- [ ] Alert on fd usage (say 80% of the limit) so the next leak pages you before customers notice.

The bug is never the number — it is the gap between the number and the code. Raise the limit, yes, but go find the leak.

---

If you want to see a failing `open()` at syscall level, my post on [debugging with strace](/posts/debugging-with-strace/) walks through exactly that. And if your server was slow *before* it ran out of fds, start with [Linux load average](/posts/linux-load-average/) — the two failure modes often travel together.
