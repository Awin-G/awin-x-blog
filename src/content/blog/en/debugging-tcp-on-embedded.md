---
title: "Debugging ESP32 TCP: lwIP buffers, retransmission, and embedded networking faults"
description: "A field guide to debugging ESP32 TCP: how lwIP socket buffers, Wi-Fi retries and Nagle/delayed-ACK interactions produce stalls, resets and half-open connections, which stats and Wireshark views actually reveal a TCP retransmission, and an ESP-IDF snippet plus a checklist."
pubDate: 2026-11-03
lang: en
translationKey: debugging-tcp-on-embedded
tags: [networking, embedded, esp32]
featured: false
keywords:
  - ESP32 TCP
  - lwIP
  - TCP retransmission
  - embedded networking
  - TCP_NODELAY
---

TCP on an ESP32 is not "TCP on a small Linux box". It is **lwIP** with a few
kilobytes of socket buffer, a Wi-Fi driver that silently retries frames underneath
you, and an application that usually runs in one task. When **ESP32 TCP** stalls,
resets, or goes half-open, the cause is rarely the protocol itself — it is almost
always a buffer, a timing assumption, or a lifecycle bug in **embedded networking**
code that the host-side world lets you ignore. I have lost more evenings to this
than to any crypto bug, and nearly every time the fix was visible in a stat counter
I had not enabled.

This post is the walkthrough I wish I had: how lwIP defaults betray you, how a
**TCP retransmission** is really born, which tools tell the truth, and the
connection-lifecycle mistakes that look like network failures but are your own.

## Why ESP32 TCP misbehaves: tiny socket buffers and lwIP defaults

The first thing to internalise: on embedded lwIP, the window is a config value, not
a function of available RAM. `CONFIG_LWIP_TCP_WND_DEFAULT` is the receive window
advertised to the peer — often 5–6 KB, sometimes less. `CONFIG_LWIP_TCP_SND_BUF_DEFAULT`
caps unacknowledged in-flight data. If either is smaller than the round-trip
bandwidth product of your link, throughput collapses and the sender parks against a
full window even though nothing is wrong on the wire.

```conf
# sdkconfig.defaults — the knobs that actually change TCP behaviour
CONFIG_LWIP_MAX_SOCKETS=16                 # each socket costs RAM; count your CIDs
CONFIG_LWIP_TCP_MSS=1460
CONFIG_LWIP_TCP_WND_DEFAULT=11680          # receive window: 8 * MSS
CONFIG_LWIP_TCP_SND_BUF_DEFAULT=11680      # in-flight send buffer
CONFIG_LWIP_TCP_QUEUE_OOSEQ=y              # queue out-of-order segments...
CONFIG_LWIP_TCP_SACK_OUT=y                 # ...or tell the peer with SACK
CONFIG_LWIP_TCP_RECVMBOX_SIZE=32
CONFIG_LWIP_TCPIP_RECVMBOX_SIZE=32
CONFIG_LWIP_TCP_MSL=60000
CONFIG_LWIP_TCP_FIN_WAIT_TIMEOUT=20000
CONFIG_LWIP_STATS=y                        # non-negotiable for debugging
```

Two more defaults matter. `CONFIG_LWIP_TCP_QUEUE_OOSEQ` off means a single lost
segment stalls the whole stream until retransmission; on keeps the sorter alive at
the cost of RAM. And the TCP/IP task priority shares the CPU with your application —
a tight `while(1)` in a higher-priority task starves lwIP and shows up as missed
ACKs.

## Wi-Fi retries masquerading as TCP trouble

802.11 retransmits at the MAC layer, invisible to TCP: a frame lost to interference
is often re-sent by the driver within microseconds and TCP never notices. But when
the driver *exhausts* its retry budget, the frame is dropped and **then** TCP sees
loss. So a channel with high retry counts presents as random RTT spikes and RTO
timeouts that look like a server problem. Before touching TCP, check RSSI and the
Wi-Fi driver statistics; a link sitting at −85 dBm with retries is the root cause of
every downstream symptom.

```c
wifi_ap_record_t ap;
esp_wifi_sta_get_ap_info(&ap);
ESP_LOGI(TAG, "rssi=%d ch=%d", ap.rssi, ap.primary);
/* TCP RTO doubles on every loss; a spiky RTT is a Wi-Fi problem,
   not a congestion one. Watch for repeated RTO in lwIP stats. */
```

Note also the reverse trap: Wi-Fi power-save makes the radio sleep between beacons,
adding tens of milliseconds of latency. During fast request/response traffic that
latency triggers spurious retransmissions. Test with power save disabled before
blaming the stack.

## Reading the symptoms: stalls, resets, and half-open connections

Learn the signature of each failure instead of pattern-matching on "it broke":

- **Stall after a burst.** Sender fills the window, receiver app never calls `recv()`,
  window goes to zero, sender blocks forever. Symptom: throughput ramps then flatlines.
- **Half-open connection.** The peer rebooted or a NAT/firewall dropped state. Your
  side still believes the socket is `ESTABLISHED` and writes into the void until it
  hits a retransmission timeout — often minutes.
- **RST out of nowhere.** Usually your own bug: closing a socket while the peer is
  mid-write, or reusing a client ID the broker/server still holds.
- **Repeated TCP retransmission with identical data-ack pairs.** Real loss, or an ACK
  that never arrives because the receive path is starved.
- **Window-full / zero-window probes.** Receiver-side backpressure. The wire is fine;
  your consumer is slow.

The distinction that saves the most time: loss that repeats the *same* sequence on
every retry is a path problem, while slow-then-flat is a buffer/app problem.

## The tools that tell the truth

Start on the device with lwIP counters. Enable `CONFIG_LWIP_STATS=y`, include
`lwip/stats.h`, and dump them on a timer or when a connection misbehaves:

```c
#include "lwip/stats.h"
#include "lwip/priv/tcp_priv.h"

void tcp_dump_stats(void)
{
#if LWIP_STATS
    stats_display_proto(&lwip_stats.tcp, "TCP");
    /* Watch: xmit (segments sent), rexmit (retransmissions),
       drop, chkerr (checksum), memerr (buffer exhaustion),
       rto (timeouts). A climbing rexmit with rising memerr
       means you are out of buffers, not out of bandwidth. */
#endif
}
```

Then move one hop away: capture on the peer and let Wireshark name what the stack is
doing. `tcpdump` writes the file; Wireshark's analysis fields are what make it
legible.

```bash
# On the server/router next to the ESP32. -s 0 keeps full payloads.
sudo tcpdump -i any -nn -s 0 -w esp32.pcap 'host 192.168.1.50 and tcp'

# Then in Wireshark, these display filters are the whole game:
#   tcp.analysis.retransmission      -> real loss or a starved ACK path
#   tcp.analysis.fast_retransmission -> duplicate ACKs, likely reordering
#   tcp.analysis.zero_window         -> receiver app not draining
#   tcp.analysis.window_full         -> sender parked, backpressure
#   tcp.flags.reset == 1             -> abrupt teardown; check who sent it
#   tcp.len == 0 && tcp.flags.ack    -> keepalive probes vs app data
```

Read the RTT graph, not individual packets. A sawtooth that doubles is
retransmission-backoff; a flat line with periodic spikes is radio retries.

## TCP_NODELAY, Nagle, and the delayed-ACK standoff

This is the classic embedded interaction. Nagle's algorithm withholds a small segment
while an earlier one is unacknowledged; the receiver's delayed ACK waits for a
second segment or a timer. If your app writes small messages in a request/response
pattern, you can get a 40–200 ms stall *per exchange* — a "slow network" that is
actually two polite algorithms waiting for each other.

Fix it on the side you control:

```c
int one = 1;
setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
```

`TCP_NODELAY` disables Nagle. For a chatty protocol — MQTT, Modbus-over-TCP, a custom
control loop — you want it on. Do not disable it globally and then send megabytes in
tiny writes; coalesce in your application buffer instead and flush once.

## keepalive vs application heartbeats

TCP keepalive is a liveness probe for *dead peers*, not a health check. On lwIP you
enable `SO_KEEPALIVE` and tune the timers, but the defaults are in hours, and the
probe only detects a peer whose stack still answers TCP. A peer that is up but hung
will pass every keepalive.

```c
int idle = 10, intvl = 5, cnt = 3;   // seconds on ESP-IDF lwIP
setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof(one));
setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE,  &idle,  sizeof(idle));
setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &intvl, sizeof(intvl));
setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT,   &cnt,   sizeof(cnt));
```

Use keepalive to reap half-open sockets after a peer vanishes, and *add* an
application heartbeat (a tiny message the peer must answer) to detect a live socket
with a dead process. When nothing ever times out, the failure is upstream: no
keepalive, no heartbeat, and a receive window that never drains.

## MTU and fragmentation on Wi-Fi

Wi-Fi's MTU is 1500, but the air interface adds overhead a wired link does not, and
any tunnel or VPN over the ESP32 subtracts further. If you set MSS too high, you get
silent black-holes or heavy fragmentation long before the link is saturated. This is
the same disease as the wired case, with a longer tail: [MTU, MSS, and path MTU
discovery](/posts/mtu-and-pmtud/) is the mechanism-first version, and it applies
verbatim. On a device that also speaks an overlay protocol — as in my [ESP32-C3
EasyTier node in C](/posts/esp32-easytier-node-in-c/) — you clamp MSS to the tunnel,
not the radio.

## Connection lifecycle bugs: draining, blocking, and leaks

Most "TCP bugs" on embedded hardware are application bugs wearing a network costume:

- **Not draining the socket.** A live TCP connection with unread bytes holds a
  receive window. If you stop calling `recv()`, the peer blocks. Always read until
  `EAGAIN`, then act.
- **Blocking the event loop.** A blocking `recv()` inside the Wi-Fi event handler or
  lwIP-thread callback stalls the stack. Use a dedicated RX task, non-blocking
  sockets, or `poll()`.
- **Leaked sockets.** Each `socket()` consumes one of `CONFIG_LWIP_MAX_SOCKETS` and
  RAM. Forgetting `close()` on a reconnect path exhausts the pool and every new
  connection fails — a symptom that reads like a server refusing connections.

```c
/* Non-blocking drain: never leave buffered bytes on a live socket. */
fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
char buf[512];
for (;;) {
    int n = recv(fd, buf, sizeof(buf), 0);
    if (n > 0)      { handle(buf, n); continue; }
    if (n == 0)     { /* peer closed: close and reconnect */ break; }
    if (errno == EAGAIN || errno == EWOULDBLOCK) break;
    if (errno == EINTR) continue;
    /* ECONNRESET, ETIMEDOUT, etc. */
    break;
}
close(fd);
```

## Checklist

- [ ] `CONFIG_LWIP_STATS=y`, and a way to read `lwip_stats.tcp.rexmit` / `memerr`.
- [ ] RSSI and Wi-Fi retry counts checked *before* touching TCP.
- [ ] `CONFIG_LWIP_MAX_SOCKETS` ≥ peak concurrent sockets; every `close()` paired.
- [ ] `TCP_NODELAY` on for request/response protocols; payloads coalesced by hand.
- [ ] `SO_KEEPALIVE` + tuned `TCP_KEEPIDLE/INTVL/CNT`, plus an app heartbeat.
- [ ] `recv()` loop drains until `EAGAIN`; no blocking read on the lwIP thread.
- [ ] MSS clamped for any tunnel/overlay; MTU verified end to end.
- [ ] Capture on the peer, read the RTT graph and `tcp.analysis.*`, not one packet.

The stack is almost never lying. When an ESP32 hangs up on you, it is usually
reporting, in a counter or a graph, that you asked it to do something the buffers,
the radio, or your own code could not deliver.
