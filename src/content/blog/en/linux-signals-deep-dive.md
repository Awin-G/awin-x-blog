---
title: "Linux Signals: kill vs kill -9, and the PID 1 Container Trap"
description: "Linux signals are asynchronous notifications, not message queues. Learn the difference between SIGTERM and SIGKILL, how signal handlers enable graceful shutdown, why sigprocmask defers delivery, and the PID 1 container trap where your app must handle SIGTERM itself."
pubDate: 2027-01-28
lang: en
translationKey: linux-signals-deep-dive
tags: [linux]
featured: false
keywords:
  - Linux signals
  - SIGTERM vs SIGKILL
  - signal handler
  - PID 1 container
  - graceful shutdown
---

Every Linux process lives under a constant rain of **signals** — small asynchronous notifications from the kernel, from other processes, or from the terminal. They are not message queues. There is no buffering, no delivery guarantee beyond a single pending bit per signal type, and no payload beyond the signal number itself. A signal interrupts whatever the process was doing and gives it a chance to react — or, if the process has no opinion, the kernel applies a default disposition: terminate, stop, or ignore.

Understanding signals is the difference between a system that shuts down cleanly and one that corrupts state. This post walks through the signals that matter, the handler pattern that makes graceful shutdown work, the mask mechanism that defers delivery, and the container PID 1 trap that catches almost everyone shipping their first Docker image.

## The signals that matter

`kill -l` lists every signal the system knows:

```
HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM STKFLT CHLD CONT STOP TSTP TTIN TTOU URG XCPU XFSZ VTALRM PROF WINCH POLL PWR SYS RTMIN RTMIN+1 ... RTMAX-1 RTMAX
```

You will touch maybe ten of these in practice:

| Signal | Number | Default | Use |
|--------|--------|---------|-----|
| `SIGTERM` | 15 | terminate | "Please shut down cleanly." |
| `SIGKILL` | 9 | terminate | "Die now." Uncatchable, unblockable. |
| `SIGINT` | 2 | terminate | Ctrl-C from the terminal. |
| `SIGHUP` | 1 | terminate | Terminal hangup; repurposed as config reload. |
| `SIGSTOP` | 19 | stop | Pause execution. Uncatchable. |
| `SIGCONT` | 18 | ignore | Resume a stopped process. |
| `SIGCHLD` | 17 | ignore | A child exited or stopped. |
| `SIGPIPE` | 13 | terminate | Write to a pipe with no reader. |

Two signals — `SIGKILL` and `SIGSTOP` — cannot be caught, blocked, or ignored. The kernel handles them directly. This is a safety guarantee: even a wedged process can always be killed.

## SIGTERM vs SIGKILL: the polite ask vs the hammer

`SIGTERM` (15) is a request. The process can catch it, run cleanup code, and exit with status 0. `SIGKILL` (9) is an order. The kernel tears the process down immediately — no handlers run, no atexit hooks fire, no buffers flush.

Here is a minimal Python program that installs a handler and shuts down gracefully:

```python
import signal, sys, time, os

shutdown = False

def handler(signum, frame):
    global shutdown
    name = signal.Signals(signum).name
    print(f"[{time.strftime('%H:%M:%S')}] caught {name} (signal {signum})", flush=True)
    print(f"[{time.strftime('%H:%M:%S')}] flushing buffers, closing files, exiting cleanly...", flush=True)
    shutdown = True

signal.signal(signal.SIGTERM, handler)
signal.signal(signal.SIGINT, handler)
print(f"PID {os.getpid()} running, handlers installed. Send SIGTERM or SIGINT.", flush=True)

while not shutdown:
    time.sleep(0.2)

print("Clean exit.", flush=True)
```

Send it `SIGTERM`:

```
$ python3 graceful.py &
PID 1125498 running, handlers installed. Send SIGTERM or SIGINT.
$ kill -TERM 1125498
[10:23:05] caught SIGTERM (signal 15)
[10:23:05] flushing buffers, closing files, exiting cleanly...
Clean exit.
exit code: 0
```

Now the same program, same state, but `kill -9`:

```
$ python3 graceful.py &
PID 1125586 running, handlers installed. Send SIGTERM or SIGINT.
$ kill -9 1125586
exit code: 137
```

Exit code 137 = 128 + 9. The handler never ran. No output, no cleanup, no flush. The kernel reclaimed the process and everything it held.

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240" role="img" aria-label="SIGTERM is caught and handled; SIGKILL is not">
  <defs>
    <style>
      .box { fill: #f7f6f2; stroke: #0f766e; stroke-width: 1.5; }
      .box-red { fill: #fef2f2; stroke: #dc2626; stroke-width: 1.5; }
      .arrow { stroke: #0f766e; stroke-width: 2; fill: none; marker-end: url(#teal); }
      .arrow-red { stroke: #dc2626; stroke-width: 2; fill: none; marker-end: url(#red); }
      .label { font-family: ui-monospace, monospace; font-size: 13px; fill: #0f1513; }
      .label-sm { font-family: ui-monospace, monospace; font-size: 11px; fill: #4b5563; }
      .title { font-family: ui-monospace, monospace; font-size: 14px; font-weight: 700; fill: #0f766e; }
      .title-red { font-family: ui-monospace, monospace; font-size: 14px; font-weight: 700; fill: #dc2626; }
    </style>
    <marker id="teal" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#0f766e"/></marker>
    <marker id="red" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <!-- SIGTERM path -->
  <text x="20" y="30" class="title">SIGTERM (15) — caught</text>
  <rect x="20" y="45" width="120" height="50" rx="4" class="box"/>
  <text x="80" y="75" text-anchor="middle" class="label">kill -TERM</text>
  <line x1="140" y1="70" x2="200" y2="70" class="arrow"/>
  <rect x="200" y="45" width="140" height="50" rx="4" class="box"/>
  <text x="270" y="75" text-anchor="middle" class="label">handler runs</text>
  <line x1="340" y1="70" x2="400" y2="70" class="arrow"/>
  <rect x="400" y="45" width="140" height="50" rx="4" class="box"/>
  <text x="470" y="75" text-anchor="middle" class="label">clean exit (0)</text>
  <!-- SIGKILL path -->
  <text x="20" y="140" class="title-red">SIGKILL (9) — uncatchable</text>
  <rect x="20" y="155" width="120" height="50" rx="4" class="box-red"/>
  <text x="80" y="185" text-anchor="middle" class="label">kill -9</text>
  <line x1="140" y1="180" x2="200" y2="180" class="arrow-red"/>
  <rect x="200" y="155" width="140" height="50" rx="4" class="box-red"/>
  <text x="270" y="185" text-anchor="middle" class="label">kernel reclaims</text>
  <line x1="340" y1="180" x2="400" y2="180" class="arrow-red"/>
  <rect x="400" y="155" width="140" height="50" rx="4" class="box-red"/>
  <text x="470" y="185" text-anchor="middle" class="label">exit 137, no cleanup</text>
  <!-- Note -->
  <text x="20" y="225" class="label-sm">SIGKILL and SIGSTOP cannot be caught, blocked, or ignored — by design.</text>
</svg>
<figcaption>FIG. 1 — SIGTERM gives the process a chance to clean up; SIGKILL does not.</figcaption>
</figure>

The rule of thumb: **always try `SIGTERM` first, wait a few seconds, then escalate to `SIGKILL`.** `systemctl stop`, `docker stop`, and `kubectl delete` all follow this pattern — they send SIGTERM, wait for a grace period (default 10 s in Docker, 90 s in systemd), then send SIGKILL. If your app handles SIGTERM correctly, you never see the SIGKILL.

## Signal handlers and graceful shutdown

A signal handler is a function the kernel calls when the signal arrives. In Python you install one with `signal.signal(signal.SIGTERM, handler)`. In C, `sigaction(2)` is the modern interface (avoid `signal(2)` — its semantics vary across UNIX versions).

The handler should do as little as possible. Set a flag, write to a pipe, or post to an event loop — then return. The real cleanup happens in the main loop. This is because most functions are not async-signal-safe; calling `printf` or `malloc` from a handler can deadlock if the signal interrupted those same functions mid-operation.

The shell equivalent is `trap`:

```bash
#!/bin/bash
echo "[$(date +%H:%M:%S)] script started, PID $$"

cleanup() {
    echo "[$(date +%H:%M:%S)] trap triggered — cleaning up temp files, releasing lock..."
    exit 0
}
trap cleanup SIGTERM SIGINT

while true; do
    sleep 0.2
done
```

Run it and send SIGTERM:

```
$ ./trap_demo.sh &
[10:23:25] script started, PID 1125597
$ kill -TERM 1125597
[10:23:25] trap triggered — cleaning up temp files, releasing lock...
exit code: 0
```

The `trap` fires, cleanup runs, exit code 0. Without the trap, the shell would die immediately with exit code 143 (128 + 15).

## Signal masks and deferred delivery

A process can **block** signals. A blocked signal is not lost — it becomes *pending* and is delivered the moment it is unblocked. This is how critical sections protect themselves from interruption.

```python
import signal, time, os

print(f"PID {os.getpid()}", flush=True)

def handler(signum, frame):
    print(f"[{time.strftime('%H:%M:%S')}] DELIVERED: {signal.Signals(signum).name}", flush=True)

signal.signal(signal.SIGTERM, handler)
signal.signal(signal.SIGUSR1, handler)

mask = {signal.SIGTERM, signal.SIGUSR1}
signal.pthread_sigmask(signal.SIG_BLOCK, mask)
print(f"[{time.strftime('%H:%M:%S')}] signals blocked: SIGTERM, SIGUSR1", flush=True)
print(f"[{time.strftime('%H:%M:%S')}] sending SIGTERM and SIGUSR1 (they will be pending)...", flush=True)

os.kill(os.getpid(), signal.SIGTERM)
os.kill(os.getpid(), signal.SIGUSR1)
print(f"[{time.strftime('%H:%M:%S')}] pending signals: {signal.sigpending()}", flush=True)

print(f"[{time.strftime('%H:%M:%S')}] unblocking after 2 seconds...", flush=True)
time.sleep(2)
signal.pthread_sigmask(signal.SIG_UNBLOCK, mask)
print(f"[{time.strftime('%H:%M:%S')}] unblocked. Waiting...", flush=True)
time.sleep(1)
print("done.", flush=True)
```

Output:

```
PID 1125590
[10:23:25] signals blocked: SIGTERM, SIGUSR1
[10:23:25] sending SIGTERM and SIGUSR1 (they will be pending)...
[10:23:25] pending signals: {<Signals.SIGUSR1: 10>, <Signals.SIGTERM: 15>}
[10:23:25] unblocking after 2 seconds...
[10:23:27] DELIVERED: SIGUSR1
[10:23:27] DELIVERED: SIGTERM
[10:23:27] unblocked. Waiting...
done.
```

Both signals were sent at 10:23:25 but delivered at 10:23:27 — two seconds of deferral. In C, the equivalent is `sigprocmask(2)` (or `pthread_sigmask(2)` in multithreaded programs). This is the mechanism that lets a process finish a non-interruptible operation before handling the shutdown request.

## SIGHUP: the reload convention

`SIGHUP` (1) originally meant "the terminal hung up." When you close an SSH session, the kernel sends SIGHUP to the session leader and its children. The default action is to terminate.

Long-running daemons repurposed SIGHUP as a **reload** signal: instead of dying, they re-read their configuration. nginx, sshd, and most syslog implementations do this. The convention is now universal enough that operators type `kill -HUP <pid>` without a second thought.

```python
import signal, time, os

config_reloads = 0

def reload_handler(signum, frame):
    global config_reloads
    config_reloads += 1
    print(f"[{time.strftime('%H:%M:%S')}] SIGHUP received — reloading config (reload #{config_reloads})", flush=True)

signal.signal(signal.SIGHUP, reload_handler)
print(f"PID {os.getpid()} running, watching for SIGHUP...", flush=True)

for i in range(30):
    time.sleep(0.2)
    if i == 5:
        os.kill(os.getpid(), signal.SIGHUP)
    if i == 15:
        os.kill(os.getpid(), signal.SIGHUP)

print(f"[{time.strftime('%H:%M:%S')}] done. Total config reloads: {config_reloads}", flush=True)
```

```
PID 1125593 running, watching for SIGHUP...
[10:23:26] SIGHUP received — reloading config (reload #1)
[10:23:28] SIGHUP received — reloading config (reload #2)
[10:23:31] done. Total config reloads: 2
```

The process survives both signals and keeps running. This is the pattern behind `systemctl reload nginx` — it sends SIGHUP, not SIGTERM.

## The PID 1 container trap

In a normal Linux system, PID 1 is `init` (or `systemd`). It has a special kernel privilege: **default signal dispositions are not installed for it.** If PID 1 does not install a handler for SIGTERM, the kernel does nothing when SIGTERM arrives — the signal is silently discarded. This is by design: init must not die from a stray signal.

When you run a container, your application becomes PID 1. If it does not handle SIGTERM, `docker stop` will send SIGTERM, wait 10 seconds, then SIGKILL the container. Your app never gets a chance to clean up.

Here is a minimal Python program that handles SIGTERM:

```python
import signal, sys, time, os

def handler(signum, frame):
    print(f"[{time.strftime('%H:%M:%S')}] PID 1 caught {signal.Signals(signum).name} — shutting down", flush=True)
    sys.exit(0)

signal.signal(signal.SIGTERM, handler)
print(f"PID {os.getpid()} (container PID 1) running with SIGTERM handler", flush=True)

while True:
    time.sleep(0.2)
```

**Exec form** — `CMD ["python", "/app.py"]` — python *is* PID 1:

```
$ docker run -d --name sig-exec signals-exec
$ docker stop sig-exec
PID 1 (container PID 1) running with SIGTERM handler
[02:23:59] PID 1 caught SIGTERM — shutting down
```

The handler runs. Clean shutdown.

**Shell form** — a wrapper script where `sh` stays as PID 1 and python is a child:

```dockerfile
RUN echo '#!/bin/sh' > /entrypoint.sh \
 && echo 'python /app.py &' >> /entrypoint.sh \
 && echo 'wait' >> /entrypoint.sh \
 && chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]
```

```
$ docker run -d --name sig-shell3 signals-shell3
$ docker stop sig-shell3
PID 7 (container PID 1) running with SIGTERM handler
```

The handler never runs. `sh` is PID 1, and the kernel does not install default signal dispositions for PID 1 — so SIGTERM is silently discarded. `docker stop` waits 10 seconds, then sends SIGKILL. The python process is killed without any chance to clean up.

The fix is one of:

1. **Use the exec form** in your Dockerfile: `CMD ["python", "app.py"]` — no shell wrapper, your app is PID 1.
2. **Use an init system** like [`tini`](https://github.com/krallin/tini): `ENTRYPOINT ["tini", "--"]` + `CMD ["python", "app.py"]`. `tini` is PID 1, forwards signals to your app, and reaps zombies.
3. **Handle SIGTERM in your entrypoint script** — if you must use a shell wrapper, trap SIGTERM and forward it:

```sh
#!/bin/sh
python /app.py &
PID=$!
trap "kill -TERM $PID; wait $PID" TERM INT
wait $PID
```

The same principle applies to systemd units — see [systemd unit cookbook](/posts/systemd-unit-cookbook/) for how `ExecStop` and `TimeoutStopSec` interact with this. And if you are wondering why your container sometimes takes exactly 10 seconds to stop, it is the Docker daemon's grace period expiring before SIGKILL.

## SIGSTOP and SIGCONT: pause and resume

`SIGSTOP` (19) pauses a process. Like SIGKILL, it cannot be caught. `SIGCONT` (18) resumes it. This is what `Ctrl-Z` in a terminal triggers — the shell sends SIGSTOP to the foreground job.

```
$ python3 graceful.py &
PID 1125588 running, handlers installed. Send SIGTERM or SIGINT.
$ kill -STOP 1125588
--- sending SIGCONT ---
$ kill -CONT 1125588
$ kill -TERM 1125588
[10:23:26] caught SIGTERM (signal 15)
[10:23:26] flushing buffers, closing files, exiting cleanly...
Clean exit.
exit code: 0
```

The process was frozen mid-execution, resumed, then shut down normally. Job control in every shell is built on these two signals.

## SIGPIPE: the silent killer

When you write to a pipe whose read end is closed, the kernel sends `SIGPIPE` (13) to the writer. The default action is to terminate. This is why `yes | head -1` exits cleanly — `head` closes the pipe after one line, `yes` gets SIGPIPE, and dies.

Most programs never see SIGPIPE because they check write errors. But if you install a SIGPIPE handler (or ignore it), `write(2)` returns `-1` with `errno = EPIPE` instead, and you must handle the error explicitly.

## Checklist

- [ ] **Handle SIGTERM** in every long-running process. Set a flag, stop accepting work, flush buffers, close files, exit 0.
- [ ] **Never rely on SIGKILL** for normal shutdown. It is the last resort, not the mechanism.
- [ ] **Use `sigprocmask`** to defer signals during critical sections — block before, unblock after.
- [ ] **Repurpose SIGHUP** for config reload in daemons. Operators expect it.
- [ ] **In Docker, use the exec form** or `tini`. Never let a shell wrapper be PID 1 without a trap.
- [ ] **Test your shutdown**: `kill -TERM <pid>`, wait, check exit code. Do not wait for a production deploy to find out your handler is broken.
- [ ] **Respect the escalation ladder**: SIGTERM → wait → SIGKILL. `systemctl stop` and `docker stop` already do this; your scripts should too.

Signals are the kernel's way of telling a process "something happened — you decide what to do about it." The processes that survive are the ones that decide well.
