---
title: "systemd socket activation: start a service on the first connection, not at boot"
description: "systemd socket activation, made concrete: systemd owns the listening socket (ListenStream), starts your service on the first connection, and passes the fd via sd_listen_fds. Real systemctl --user output, the .socket/.service pair, systemd-socket-activate, and the honest tradeoffs."
pubDate: 2027-01-10
lang: en
translationKey: systemd-socket-activation
tags: [systemd, linux]
featured: false
keywords:
  - systemd socket activation
  - ListenStream
  - sd_listen_fds
  - .socket unit
  - LISTEN_FDS
---

Most services I run are always on: they `socket()`, `bind()`, `listen()`, then wait — holding a port and a process resident in RAM even if a request shows up twice a day. **systemd socket activation** flips that. systemd owns the listening socket, opens the port itself, and lets your service stay dead until the first connection — then it starts the service and hands it the already-open file descriptor. The service never calls `bind()`; it just accepts on a `ListenStream` fd it was given. Below I build a real socket-activated service under `systemctl --user` (no root), watch a connection bring it up from `inactive (dead)`, tear it down and watch the listener survive, and repeat it with `systemd-socket-activate`. All output is real, from this machine (systemd 262).

<figure>
<svg viewBox="0 0 640 250" width="100%" role="img" aria-label="systemd owns the listening socket on port 18765 while the service is inactive. When a client makes the first connection, systemd spawns demo-echo.service and passes it the listening fd as fd 3, which the program accepts on." xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="sock-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/></marker>
  </defs>
  <rect x="14" y="66" width="210" height="130" rx="12" fill="none" stroke="#0f766e" stroke-width="2.5"/>
  <g text-anchor="middle" font-family="system-ui, sans-serif">
    <text x="119" y="92" fill="#0f766e" font-weight="700" font-size="15">systemd</text>
    <text x="119" y="114" fill="#0f766e" font-size="11">owns the socket, no service yet</text>
    <text x="119" y="146" fill="currentColor" font-family="monospace" font-size="13">:18765 LISTEN</text>
    <text x="119" y="170" fill="currentColor" font-family="monospace" font-size="11" opacity="0.75">fd 3 held by the manager</text>
  </g>
  <g stroke="#0f766e" fill="none" stroke-width="2" marker-end="url(#sock-arrow)">
    <path d="M224 131 H274"/>
  </g>
  <text x="249" y="119" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">first connect</text>
  <text x="332" y="136" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12">spawn service</text>
  <g stroke="#0f766e" fill="none" stroke-width="2" marker-end="url(#sock-arrow)">
    <path d="M392 131 H442"/>
  </g>
  <text x="417" y="119" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">pass fd 3</text>
  <rect x="446" y="66" width="180" height="130" rx="12" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.7" stroke-dasharray="6 5"/>
  <g text-anchor="middle" font-family="system-ui, sans-serif">
    <text x="536" y="92" fill="currentColor" font-weight="700" font-size="14">demo-echo.service</text>
    <text x="536" y="114" fill="currentColor" font-size="11">inactive until connect</text>
    <text x="536" y="146" fill="currentColor" font-family="monospace" font-size="12">accept() on fd 3</text>
    <text x="536" y="170" fill="#0f766e" font-family="monospace" font-size="11">LISTEN_FDS=1</text>
  </g>
</svg>
<figcaption>The manager keeps the port open on its own descriptor; the service is spawned per demand and told which fd to accept on via <code>LISTEN_FDS</code> / <code>sd_listen_fds()</code>.</figcaption>
</figure>

## What systemd socket activation actually is

Normally the process that *serves* also *binds*: it creates the socket, attaches it to an address and port, calls `listen()`, then accepts. **systemd socket activation** moves the first three steps out of your program and into systemd. The `.socket` unit owns a `ListenStream=` (a TCP port, a UNIX socket path, and so on); systemd opens it and keeps it open. Your program's `.service` is not started at boot — it stays `inactive (dead)` with a `MainPID` of 0, no process and no resident memory. The first time a client connects, systemd notices the traffic, starts the service, and hands it the listening file descriptor.

The part that surprised me the first time: the port is open the *whole* time. The socket lives in the manager, not in your service, so it survives the service's death and any restart. The service just attaches on demand — it is not a proxy and not a wrapper; your process accepts on a real socket, exactly as if it had created it.

## Why it's nice (and where it is just noise)

Four reasons I keep reaching for it:

- **No idle daemon.** A rarely-used service sits at zero resident memory until someone talks to it. On this machine the service was `inactive (dead)` with `MainPID 0` while the port still answered.
- **Restart without dropping the listener.** Because the manager holds the socket, you can stop, upgrade, and restart the service and incoming connections just queue in the backlog instead of getting `connection refused`. Demonstrated below.
- **Privilege separation.** For system services the manager (often root) can own a low port, and the service can run as an unprivileged `User=` and still accept on the fd it inherited — "listen on 443 in the manager, run the app as `nobody`."
- **Parallel boot.** Sockets are cheap, so systemd opens them up front and starts the services lazily in parallel as demand arrives, instead of serially waiting for each daemon to bind.

The honest cost is **indirection**. Your program did not open its socket, so the reflex "which process called `bind()`, is it up?" no longer points at your service. And it only works if your program cooperates: it must use an inherited fd. A service that hardcodes its own `socket()/bind()/listen()` ignores the passed fd and fails to bind, because the manager already owns the port. If the service is hot 24/7, must always be warm, or can't take an inherited fd, socket activation buys you nothing and adds a `.socket` file plus one more layer to reason about.

## The `.socket` unit and its `.service` pair

socket activation is a pairing: a `.socket` unit that says *where to listen*, and a `.service` unit of the same name that says *what to run*. Absent an explicit link, `demo-echo.socket` triggers `demo-echo.service`. Here are mine, verbatim from the scratch directory:

```ini
# demo-echo.socket
[Unit]
Description=Scratch echo socket (systemd owns this listener)

[Socket]
ListenStream=127.0.0.1:18765
# Accept= is left unset -> defaults to false -> ONE service instance that
# receives the listening fd as fd 3 and accepts connections itself.
# (Accept=yes would instead fork a per-connection unit, inetd-style, fd 0.)

[Install]
WantedBy=sockets.target
```

```ini
# demo-echo.service
[Unit]
Description=Echo listener started on first connection by demo-echo.socket

[Service]
Type=exec
ExecStart=/tmp/opencode/work/socket-activation/listener
Restart=on-failure
StandardOutput=journal
StandardError=journal
```

Two directives carry the weight:

- **`ListenStream=`** is the address systemd opens. `127.0.0.1:18765` is a TCP listener; a bare path (e.g. `/run/foo.sock`) is a UNIX socket; a bare `18765` binds IPv4+IPv6 on all interfaces. Repeat it for more sockets; siblings include `ListenDatagram=` for UDP and `ListenSequentialPacket=`.
- **`Accept=`** chooses the activation model. The default, `Accept=no`, starts **one** instance and hands it the *listening* fd (fd 3) to run an accept loop, like nginx. `Accept=yes` is the inetd model: systemd accepts each connection and forks a **per-connection** instance of a template service (usually `@.service`), passing the connected socket as fd 0 (stdin). One persistent accept loop versus one process per connection — pick deliberately.

Notice the service never references the socket. That is deliberate and it is the whole elegance: the program is agnostic about who opened its socket, which is why the same binary later works under `systemd-socket-activate`.

## How the program receives the fd: `sd_listen_fds`, `LISTEN_FDS`, fd 3

When systemd starts an `Accept=no` service it does three things before `exec()`: it duplicates the listening socket into the process's fd **3**, and sets two environment variables — `LISTEN_FDS` (how many fds were passed) and `LISTEN_PID` (the pid they were passed *to*, so a forked child cannot silently reuse them). The idiomatic reader is the libsystemd helper `sd_listen_fds()`, which checks `LISTEN_PID == getpid()`, returns the count, and puts the first fd at `SD_LISTEN_FDS_START` (3). My tiny listener prints what it receives so the mechanism is visible:

```c
/* listener.c — a deliberately tiny socket-activated listener.
 *
 * It does NOT create the listening socket. systemd owns it, does the
 * bind()+listen(), and passes the fd to us at startup (fd 3). We read
 * the fd via sd_listen_fds(), accept() on it, and answer with our own
 * PID so the activation is visible. Works identically under
 * `systemctl --user` (fd inherited as fd 3) and `systemd-socket-activate`.
 *
 * Build: gcc -O2 -Wall -o listener listener.c -lsystemd
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <systemd/sd-daemon.h>

int main(void) {
    /* Capture the raw env systemd set, before sd_listen_fds consumes it. */
    const char *raw_fds = getenv("LISTEN_FDS");
    const char *raw_pid = getenv("LISTEN_PID");

    /* unset_env=1: validate LISTEN_PID == getpid() AND unset the vars, so
     * a forked/exec'd child cannot passively reuse a stale fd number. */
    int n = sd_listen_fds(1);
    if (n < 0) { fprintf(stderr, "sd_listen_fds failed: %s\n", strerror(-n)); return 1; }
    if (n != 1) { fprintf(stderr, "expected exactly 1 inherited fd, got %d\n", n); return 1; }

    int fd = SD_LISTEN_FDS_START;   /* == 3, first fd systemd passed us */

    printf("listener up: pid=%d LISTEN_FDS=%s LISTEN_PID=%s "
           "-> sd_listen_fds()=%d listening_fd=%d\n",
           (int)getpid(), raw_fds ? raw_fds : "(unset)",
           raw_pid ? raw_pid : "(unset)", n, fd);
    fflush(stdout);

    signal(SIGPIPE, SIG_IGN);       /* a client hang-up must not kill us */

    for (;;) {
        struct sockaddr_in peer;
        socklen_t plen = sizeof peer;
        int c = accept(fd, (struct sockaddr *)&peer, &plen);
        if (c < 0) { if (errno == EINTR) continue; perror("accept"); continue; }

        char body[256];
        ssize_t r = read(c, body, sizeof body - 1);
        if (r < 0) r = 0;
        body[r] = '\0';
        while (r > 0 && (body[r-1] == '\n' || body[r-1] == '\r')) body[--r] = '\0';
        char out[256];
        int len = snprintf(out, sizeof out,
            "handled by socket activation: pid=%d listening_fd=%d received=\"%s\" (%zd bytes)\n",
            (int)getpid(), fd, body, r);
        (void)write(c, out, (size_t)len);

        printf("accepted %s:%u -> served by pid=%d on inherited_fd=%d received=\"%s\"\n",
               inet_ntoa(peer.sin_addr), (unsigned)ntohs(peer.sin_port),
               (int)getpid(), fd, body);
        fflush(stdout);
        close(c);
    }
    return 0;
}
```

Build with `gcc -O2 -Wall -o listener listener.c -lsystemd`. The telling lines are `sd_listen_fds(1)` resolving to a single fd, then `accept(fd, …)` acting on it — we never call `socket()` or `bind()`, because systemd already did the listen for us. `sd_listen_fds(1)` returning 1 is the proof the fd arrived intact.

## Real activation under `systemctl --user`

Symlink the two units into `~/.config/systemd/user`, `daemon-reload`, and start **the socket** — not the service. The service stays dead until a client shows up:

```console
$ systemctl --user enable --now demo-echo.socket
Created symlink '/home/awinx/.config/systemd/user/sockets.target.wants/demo-echo.socket' → '/tmp/opencode/work/socket-activation/demo-echo.socket'.

$ ss -tln | grep 18765
LISTEN 0      4096       127.0.0.1:18765      0.0.0.0:*

$ systemctl --user status demo-echo.socket --no-pager
● demo-echo.socket - Scratch echo socket (systemd owns this listener)
     Active: active (listening) since Tue 2026-10-13 04:23:28 CST
   Triggers: ● demo-echo.service
     Listen: 127.0.0.1:18765 (Stream)

$ systemctl --user status demo-echo.service --no-pager
○ demo-echo.service - Echo listener started on first connection ...
     Active: inactive (dead)
TriggeredBy: ● demo-echo.socket
```

The port is `LISTEN`ing and the socket unit is `active (listening)`, but the service is `inactive (dead)` with no process — the entire promise in three lines. The socket advertises `Triggers: demo-echo.service`; the service reports `TriggeredBy: demo-echo.socket`. systemd has already linked the pair.

Now connect, and watch the service come up from nothing:

```console
$ python3 -c 'import socket; s=socket.create_connection(("127.0.0.1",18765)); s.sendall(b"first-connection\n"); print("client got:", s.recv(200).decode().strip())'
client got: handled by socket activation: pid=614805 listening_fd=3 received="first-connection" (16 bytes)

$ journalctl --user -u demo-echo.service --no-pager
Starting Echo listener started on first connection by demo-echo.socket...
Started Echo listener started on first connection by demo-echo.socket.
listener up: pid=614805 LISTEN_FDS=1 LISTEN_PID=614805 -> sd_listen_fds()=1 listening_fd=3
accepted 127.0.0.1:55546 -> served by pid=614805 on inherited_fd=3 received="first-connection"
```

`MainPID` was 0 a second ago; the journal shows the service came alive as pid 614805. The startup line is the whole mechanism in one place: systemd set `LISTEN_FDS=1` and `LISTEN_PID=614805`, which `sd_listen_fds()` resolved to `listening_fd=3` — the exact fd the manager handed it. It then unsets those vars so a forked child can't reuse a stale number.

## Restart without dropping the listener

Here is the property I cared about most. I stop the **service** and ask whether the port is still open:

```console
$ systemctl --user stop demo-echo.service
Stopping 'demo-echo.service', but its triggering units are still active:
demo-echo.socket

$ ss -tln | grep 18765
LISTEN 0      4096       127.0.0.1:18765      0.0.0.0:*
$ systemctl --user is-active demo-echo.service
inactive
```

systemd even warns that the socket is still active — and `ss` confirms it: the listener survived the service's death, so any client that connects during the gap just waits in the backlog instead of being refused. Reconnect and a fresh process is spawned, on the same port:

```console
$ python3 -c 'import socket; s=socket.create_connection(("127.0.0.1",18765)); s.sendall(b"second-connection\n"); print("client got:", s.recv(200).decode().strip())'
client got: handled by socket activation: pid=615413 listening_fd=3 received="second-connection" (17 bytes)

$ journalctl --user -u demo-echo.service --no-pager | grep -E 'listener up|accepted'
listener up: pid=614805 LISTEN_FDS=1 LISTEN_PID=614805 -> sd_listen_fds()=1 listening_fd=3
accepted 127.0.0.1:55546 -> served by pid=614805 on inherited_fd=3 received="first-connection"
listener up: pid=615413 LISTEN_FDS=1 LISTEN_PID=615413 -> sd_listen_fds()=1 listening_fd=3
accepted 127.0.0.1:38462 -> served by pid=615413 on inherited_fd=3 received="second-connection"
```

Upgrade the binary, stop the service, restart it — the socket never blinks, and the next connection wakes a brand-new process. This is also the model that makes zero-downtime of the *listener* trivial: the socket's lifecycle is decoupled from the service's.

One consequence that bit me during teardown: an already-spawned instance holds its own copy of the listener via fd 3, so `disable`ing the socket does **not** kill a running service — the port stays open until it exits. `ss -tlnp` even showed `users:(("listener",pid=615413,fd=3))` after the units were gone. Activate, then clean up the service *and* the socket.

## Testing without any unit files: `systemd-socket-activate`

You do not need a `.socket` unit to exercise the mechanism — `systemd-socket-activate` binds a port and spawns your program on the first connection, in one command. I pointed it at the exact same binary on a fresh port:

```console
$ systemd-socket-activate -l 127.0.0.1:18766 ./listener &
$ python3 -c 'import socket; s=socket.create_connection(("127.0.0.1",18766)); s.sendall(b"via systemd-socket-activate\n"); print("client got:", s.recv(200).decode().strip())'
client got: handled by socket activation: pid=615573 listening_fd=3 received="via systemd-socket-activate" (27 bytes)
```

and `systemd-socket-activate`'s own output narrates the fd hand-off:

```
Listening on 127.0.0.1:18766 as 3.
Communication attempt on fd 3.
Executing: /tmp/opencode/work/socket-activation/listener
listener up: pid=615573 LISTEN_FDS=1 LISTEN_PID=615573 -> sd_listen_fds()=1 listening_fd=3
accepted 127.0.0.1:44704 -> served by pid=615573 on inherited_fd=3 received="via systemd-socket-activate"
```

`as 3` is it reporting the listener will be fd 3; `Communication attempt on fd 3` is the trigger; `Executing: ...` is the spawn. It is the fastest way to check your `sd_listen_fds()` wiring before you touch a unit file — and because the program is socket-source-agnostic, the identical binary worked here and under the real `.socket`.

## Validate the pair before you wire it in

`systemd-analyze verify` catches the mistakes you cannot see in the file. My clean pair is silent:

```console
$ systemd-analyze verify ./demo-echo.socket ./demo-echo.service; echo "exit=$?"
exit=0
```

But it is not a rubber stamp. A typo in `Accept=`, and a `.socket` whose `.service` does not exist, both fail loudly:

```console
$ systemd-analyze verify ./broken-accept.socket
broken-accept.socket: Failed to parse Accept=maybe, ignoring: Invalid argument
broken-accept.socket: service broken-accept.service not loaded, socket cannot be started.
```

That second line encodes the pairing rule: a `.socket` needs a matching `.service` to trigger, and verify will tell you when it cannot find one. Run it before `daemon-reload`.

## When it is not worth it

The boundaries, not a hammer:

- **Always-hot services.** If your app serves steady traffic you already keep it resident; socket activation saves nothing and adds indirection.
- **First-connection latency.** The first client after an idle pays the process start cost in-line. If a cold start blows an SLO, keep it warm.
- **Apps that must own the socket.** Software doing raw `bind()` with special options, or managing its own socket lifecycle, may fight the manager. It only helps if the program accepts an inherited fd.
- **`Accept=no` expects a long-running accept loop**, so a fire-and-forget one-shot per connection belongs under `Accept=yes` — and then you pay a fork per connection.
- **Stateful reasoning.** "Which pid holds the port" gets non-obvious when the manager owns the socket and respawns the service, as the teardown above shows.

For everything else — a low-traffic sidecar, an internal tool used a few times a day, a service that should bind a privileged port into an unprivileged binary — it is the difference between "a daemon is always running" and "the port is waiting to be used."

## Where this leaves you

A socket-activated service is three small, checkable artifacts: a `.socket` with one `ListenStream=`, a `.service` that accepts the fd it is handed, and a program that reads it with `sd_listen_fds()`. systemd owns the socket, starts you on the first connection, and lets you restart the service without ever dropping the port. For the unit-file mechanics, my [systemd unit file cookbook](/posts/systemd-unit-cookbook/) covers `ExecStart`, `Type`, and validation; and once the service starts on demand, the natural next step is shrinking what the running process can touch, which I do in [systemd hardening](/posts/systemd-hardening/). Open the socket, verify it, then let the connection do the starting.
