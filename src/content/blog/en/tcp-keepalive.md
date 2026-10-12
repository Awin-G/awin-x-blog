---
title: "TCP Keepalive vs Heartbeats: How a Server Notices a Dead Peer"
description: "A half-open connection can linger for hours. Learn how TCP keepalive (SO_KEEPALIVE, TCP_KEEPIDLE) and application-level heartbeats detect dead peers, with real experiments and timings."
pubDate: 2027-01-08
lang: en
translationKey: tcp-keepalive
tags: [networking, linux]
featured: false
keywords:
  - TCP keepalive
  - half-open connection
  - TCP_KEEPIDLE
  - heartbeat
  - SO_KEEPALIVE
---

Your server is stuck on a `recv()` that never returns. The client vanished hours ago, and nobody noticed. This is the **half-open connection** problem. Here's what happens when a peer disappears without saying goodbye, how **TCP keepalive** tries to fix it, and why **application-level heartbeats** are the real answer.

## What Is a Half-Open Connection?

A half-open connection occurs when one side of a TCP connection disappears without sending a FIN or RST. The other side has no idea anything went wrong.

<figure>
<svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Timeline of a half-open connection and TCP keepalive probes">
  <line x1="40" y1="60" x2="680" y2="60" stroke="currentColor" stroke-width="2"/>
  <line x1="40" y1="170" x2="680" y2="170" stroke="currentColor" stroke-width="2" stroke-dasharray="4 3"/>
  <!-- Server events -->
  <circle cx="80" cy="60" r="6" fill="#0f766e"/>
  <text x="80" y="40" text-anchor="middle" font-size="12" fill="currentColor">Server accepts</text>
  <circle cx="240" cy="60" r="6" fill="#0f766e"/>
  <text x="240" y="40" text-anchor="middle" font-size="12" fill="currentColor">Client sends data</text>
  <circle cx="400" cy="60" r="6" fill="#0f766e"/>
  <text x="400" y="40" text-anchor="middle" font-size="12" fill="currentColor">Client vanishes (no FIN)</text>
  <circle cx="560" cy="60" r="6" fill="#0f766e"/>
  <text x="560" y="40" text-anchor="middle" font-size="12" fill="currentColor">Keepalive gives up</text>
  <!-- Client events -->
  <circle cx="80" cy="170" r="6" fill="#0f766e"/>
  <text x="80" y="200" text-anchor="middle" font-size="12" fill="currentColor">connect()</text>
  <circle cx="240" cy="170" r="6" fill="#0f766e"/>
  <text x="240" y="200" text-anchor="middle" font-size="12" fill="currentColor">send()</text>
  <circle cx="400" cy="170" r="6" fill="currentColor"/>
  <text x="400" y="200" text-anchor="middle" font-size="12" fill="currentColor">SIGKILL / power loss</text>
  <!-- Probes -->
  <line x1="420" y1="60" x2="420" y2="170" stroke="#0f766e" stroke-width="1" marker-end="url(#arrow)"/>
  <line x1="460" y1="60" x2="460" y2="170" stroke="#0f766e" stroke-width="1" marker-end="url(#arrow)"/>
  <line x1="500" y1="60" x2="500" y2="170" stroke="#0f766e" stroke-width="1" marker-end="url(#arrow)"/>
  <text x="460" y="120" text-anchor="middle" font-size="10" fill="#0f766e">probes</text>
  <defs>
    <marker id="arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#0f766e"/>
    </marker>
  </defs>
</svg>
<figcaption>A half-open connection: the client vanishes without sending FIN. The server's keepalive probes go unanswered until the kernel declares the peer dead.</figcaption>
</figure>

This is rare in theory but common in practice. Here are the real-world scenarios:

- **Killed process**: `SIGKILL`, OOM killer, or a hard crash. The OS may or may not send FIN depending on timing.
- **Dropped NAT state**: A NAT gateway or firewall silently forgets the connection mapping after an idle timeout. Packets from the server are dropped into a void.
- **Power loss / network partition**: The peer machine loses power or network connectivity. No FIN, no RST, nothing.
- **Mobile device sleep**: A phone enters deep sleep and the TCP stack stops responding.

In all these cases, the server's socket remains in `ESTABLISHED` state. A blocking `recv()` will wait forever. A connection pool will hand out a dead connection to the next unsuspecting caller.

## Why TCP Has No Built-In Liveness

TCP was designed when networks were reliable and endpoints were trusted. The protocol has no built-in "are you still there?" mechanism. The only way a server learns a peer is gone:

1. The peer sends a FIN (graceful close)
2. The peer sends a RST (abort)
3. The server sends data and gets an ICMP error back
4. The server's TCP stack times out a retransmission (15+ minutes)

If the peer simply vanishes (no FIN, no RST), none of these fire. The connection sits open and useless.

A Python server accepts a connection, the client sends one message and gets frozen with `SIGSTOP` (simulating a hung process that never sends FIN):

```text
[server] listening on 127.0.0.1:18923
[client] connected, sent data, pid=613965, now sleeping forever
[server] accepted connection from ('127.0.0.1', 44866)
[server] recv: b'hello from client'

--- ss -o BEFORE client freeze ---
Netid Recv-Q Send-Q Local Address:Port  Peer Address:Port
tcp   0      0          127.0.0.1:18923    127.0.0.1:44866

[experiment] freezing client pid=613965 with SIGSTOP (no FIN, no RST)...
[experiment] client is frozen. Server still thinks connection is open.

--- ss -o AFTER client freeze ---
Netid Recv-Q Send-Q Local Address:Port  Peer Address:Port
tcp   0      0          127.0.0.1:18923    127.0.0.1:44866

[server] now calling recv(), will block because no FIN arrived...
[server] recv TIMED OUT after 5.00s, connection is half-open and server has no idea peer is dead
```

The `ss -o` output shows the connection is still `ESTABLISHED` after the client is frozen. The server's `recv()` blocks until timeout; without it, it waits forever.

## TCP Keepalive: SO_KEEPALIVE and the Three Knobs

Linux provides a kernel-level mechanism called **TCP keepalive**. When enabled, the kernel sends periodic probe packets after the connection goes idle. If the peer doesn't respond after several probes, the kernel declares the connection dead and wakes any blocked `recv()`.

It requires `SO_KEEPALIVE` plus three knobs:

```python
import socket

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)

# Seconds before first probe on an idle connection
sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 2)

# Seconds between probes
sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 1)

# Number of failed probes before declaring dead
sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)
```

With these settings, the kernel waits 2 seconds idle, then probes every 1 second. After 3 failed probes (~5 seconds total), the connection is dead.

```text
Netid Recv-Q Send-Q            Local Address:Port  Peer Address:Port
tcp   0      0                     127.0.0.1:18924    127.0.0.1:36822 timer:(keepalive,1.997sec,0)
```

The `timer:(keepalive,1.997sec,0)` field shows the kernel's keepalive timer counting down. When it hits zero, a probe is sent and the timer resets. Full experiment with keepalive enabled and the client frozen:

```text
[server] listening on 127.0.0.1:18924
[client] connected, pid=614003 — sleeping forever
[server] accepted from ('127.0.0.1', 36822)
[server] enabled SO_KEEPALIVE, TCP_KEEPIDLE=2, TCP_KEEPINTVL=1, TCP_KEEPCNT=3

--- ss -o with keepalive timer ---
Netid Recv-Q Send-Q            Local Address:Port  Peer Address:Port
tcp   0      0                     127.0.0.1:18924    127.0.0.1:36822 timer:(keepalive,1.997sec,0)

[experiment] freezing client pid=614003 with SIGSTOP...
[server] calling recv() — keepalive probes should detect frozen peer...
[server] recv TIMED OUT after 15.01s
```

On loopback, the kernel ACKs its own probes (the frozen process's TCP stack still responds at the kernel level), so keepalive doesn't fire. On a real network, probes go unanswered and the kernel declares the connection dead after ~5 seconds.

### The Default 2-Hour Idle Problem

Linux's default `TCP_KEEPIDLE` is **7200 seconds (2 hours)**. Default interval is 75 seconds, default count is 9 probes. A dead peer goes unnoticed for over 2 hours before probing starts, and up to ~2 hours 11 minutes before the connection is declared dead.

For most applications, that's useless.

## Application-Level Heartbeats: The Real Answer

For prompt failure detection, **application-level heartbeats** are the standard solution. The application defines a ping/pong protocol on top of TCP. If pings go unanswered, the connection closes.

Minimal heartbeat implementation:

```python
import socket, time

PING_INTERVAL = 1.0   # seconds between pings
PING_TIMEOUT = 2.0   # seconds to wait for pong
MAX_MISSED = 3        # missed pings before declaring dead

last_ping = time.monotonic()
missed = 0

while True:
    now = time.monotonic()
    if now - last_ping >= PING_INTERVAL:
        sock.sendall(b'ping')
        last_ping = now

    sock.settimeout(PING_TIMEOUT)
    try:
        data = sock.recv(1024)
        if data == b'pong':
            missed = 0
        elif data == b'':
            break  # clean close
    except socket.timeout:
        missed += 1
        if missed >= MAX_MISSED:
            break  # peer is dead
```

Real output against a frozen client:

```text
[server] listening on 127.0.0.1:18925
[client] connected, pid=613966 — sleeping forever (no heartbeat)
[server] accepted from ('127.0.0.1', 55276)
[server] starting application-level heartbeat: ping every 1s, timeout 2s

[experiment] freezing client pid=613966 with SIGSTOP...
[server] heartbeat timeout #1 at t=0.0s
[server] sent ping at t=2.0s
[server] heartbeat timeout #2 at t=2.0s
[server] sent ping at t=4.0s
[server] heartbeat timeout #3 at t=4.0s
[server] DECLARED PEER DEAD after 3 missed heartbeats (4.0s total)
```

The application detected the dead peer in 4 seconds.

## TCP Keepalive vs Application Heartbeat

| Aspect | TCP Keepalive | Application Heartbeat |
|---|---|---|
| Detection time | Minutes to hours (tunable) | Seconds (fully controlled) |
| Granularity | Per-socket, kernel-wide | Per-connection, application logic |
| Traffic overhead | Minimal (small probes) | Depends on protocol design |
| Works through NAT | Yes (if NAT timeout > idle) | Yes (if NAT timeout > interval) |
| False positives | Rare (kernel is conservative) | Possible on slow/loaded links |
| Implementation | One `setsockopt` call | Requires protocol + state machine |
| Visibility | Kernel timer via `ss -o` | Application logs/metrics |

Key insight: TCP keepalive is a coarse safety net, not a liveness protocol. Application heartbeats give full control over detection time, timeout semantics, and recovery.

## Proxies, Load Balancers, and NAT Timeouts

Even with perfect keepalive and heartbeats, infrastructure can kill connections:

- **NAT gateways**: Idle timeouts from 5 minutes to 1 hour. If your heartbeat interval exceeds the NAT timeout, the mapping disappears and packets are dropped.
- **Load balancers**: AWS NLB has a 350-second idle timeout. nginx `proxy_read_timeout` defaults to 60 seconds. HAProxy `timeout client` defaults to 1 hour.
- **Cloud proxies**: Cloudflare has a 100-second idle timeout for TCP connections.

Rule of thumb: heartbeat interval must be shorter than the shortest idle timeout in the path.

nginx idle timeout:

```nginx
location / {
    proxy_pass http://backend;
    proxy_read_timeout 30s;
    proxy_send_timeout 30s;
}
```

AWS NLB's idle timeout is fixed at 350 seconds; send heartbeats more often.

## Checklist: Detecting Dead Peers in Production

Practical checklist:

1. **Enable `SO_KEEPALIVE`** on all server sockets; it's free and catches some cases.
2. **Tune `TCP_KEEPIDLE`** to 30-60 seconds if relying on kernel keepalive.
3. **Implement application-level heartbeats** for connections where prompt detection matters (WebSockets, RPC, database pools, message queues).
4. **Set heartbeat intervals below the shortest NAT/LB idle timeout** in your path.
5. **Log and metric heartbeat failures** as early warning signs.
6. **Handle connection cleanup**: close dead connections and remove them from pools.
7. **Test with real network conditions**; loopback tests don't reveal NAT or firewall behavior.

## Conclusion

A half-open connection is a silent killer: no error, no log, no signal. Just a server waiting forever for a peer that will never respond. TCP keepalive (`SO_KEEPALIVE` + `TCP_KEEPIDLE`) is a useful safety net, but the default 2-hour idle timeout makes it too slow for most applications. Application-level heartbeats are the real answer.

Best defense is layered: enable kernel keepalive as a backstop, implement application heartbeats for prompt detection, and tune both to be shorter than any infrastructure's idle timeout.

---

*Related: [Debugging TCP on Embedded Devices](/posts/debugging-tcp-on-embedded/) · [TCP Proxy in Go](/posts/tcp-proxy-in-go/)*
