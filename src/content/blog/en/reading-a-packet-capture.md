---
title: "Reading your first packet capture: tcpdump + Wireshark without the overwhelm"
description: "Reading your first packet capture without the overwhelm: when a capture beats logs, how to capture correctly with tcpdump (-i, BPF filters, -w, snaplen), what the TCP handshake, retransmissions, RST and TLS bytes look like in Wireshark, and a worked 'why is this slow?' example."
pubDate: 2026-11-06
lang: en
translationKey: reading-a-packet-capture
tags: [networking, linux]
featured: false
keywords:
  - packet capture
  - tcpdump
  - Wireshark
  - analyze network traffic
  - BPF filter
  - retransmission
  - Follow TCP Stream
---

Logs tell you what your code *thought* happened. A **packet capture** tells you what actually crossed the wire. When a request is slow, hung, or resetting and your logs are a polite fiction, `tcpdump` plus **Wireshark** is the only tool that shows the conversation as the network saw it. The first time is intimidating — thousands of packets, a wall of hex, a protocol tree — but you do not need to read all of it. You need about six filters and three stories: the handshake, the retransmission, and the teardown.

This is how I **analyze network traffic** from zero: when a capture is the right move, how to capture cleanly, what the packets mean, the Wireshark features worth learning first, and a worked example of the most common question I get — *why is this connection slow?*

## When a packet capture beats reading logs (and when it doesn't)

Reach for a capture when the symptom lives *between* two programs you both control: the server logged the request, the client logged the response, and the numbers still don't add up. Specifically:

- **Timing.** "The API call took 8 seconds but the handler ran in 40 ms." The gap is on the wire — a retransmission, a stalled window, a slow DNS/TLS step, or a late accept.
- **Silent drops.** No error anywhere, no log line, just a timeout. Something dropped packets and told neither endpoint.
- **Reset mysteries.** `Connection reset by peer` with nothing in the application log. The RST came from the network, not your code.
- **Handshake failures.** TLS fails before HTTP exists, so your framework's logs never start.

Skip the capture when you have a clean stack trace (read the code), when the traffic is all TLS 1.3 and your question is about HTTP payloads, or when a shared link means you'd be capturing other people's traffic.

My rule: **logs answer "what did my program do"; captures answer "what did the network do to it."** When those disagree, the capture wins.

## Capturing correctly: tcpdump, interfaces, BPF filters, and files

### Pick the interface, and prefer `-n`

```bash
# List interfaces (no root needed):
tcpdump -D

# Capture on one interface, numeric output, no DNS lookups:
sudo tcpdump -i eth0 -n
```

`-i any` captures everywhere at once but uses Linux's cooked header, losing link-layer detail; on a server, name the interface. `-n` stops name and port resolution — on an idle link that lookup takes longer than the packets you came to see.

### A BPF filter is not optional

Unfiltered capture on a busy host is a firehose. A **BPF filter** (Berkeley Packet Filter) is the expression `tcpdump` hands to the kernel, so non-matching packets never reach userspace:

```bash
# One host, one port. The bread-and-butter filter.
sudo tcpdump -i eth0 -n 'host 10.0.0.5 and port 443'

# A conversation in either direction, HTTP or HTTPS:
sudo tcpdump -i eth0 -n 'host 10.0.0.5 and (port 80 or port 443)'

# A subnet talking to a subnet, knocking out SSH chatter:
sudo tcpdump -i eth0 -n 'net 10.0.0.0/24 and not port 22'

# Only connection setup/teardown control packets (SYN/FIN/RST set):
sudo tcpdump -i eth0 -n 'tcp[tcpflags] & (tcp-syn|tcp-fin|tcp-rst) != 0'
```

Filter on the **narrowest** thing you can name. `host` and `port` are cheap and readable; reach for `tcp[tcpflags]` only when you need control-plane packets. Decide host and port *before* you start, because rescanning a 2 GB file is miserable.

### Write to a file, and mind the snap length

Capture to a file and open it in Wireshark. This is the one place I always use `sudo`:

```bash
# -s 0 = capture the WHOLE packet (no truncation). -c 500 = stop after 500 packets.
sudo tcpdump -i eth0 -n -s 0 -c 500 \
  -w /tmp/slow-api.pcap 'host 10.0.0.5 and port 443'

# Watch it live while it's being written, from a second terminal:
sudo tcpdump -r /tmp/slow-api.pcap -n
```

**Snap length (`-s`)** is how many bytes of each packet are saved. `-s 0` means "all of it" and is what you want on a modern box. The old 96-byte default is enough for headers and control flags but silently truncates TLS records, so you can never extract a stream. If a capture looks complete but Follow TCP Stream gives you garbage, check the snap length first.

**Timestamps.** By default you get epoch-ish seconds; make them readable, and sync clocks on the machines you capture:

```bash
# Human-readable date-time on every line, using UTC:
sudo tcpdump -i eth0 -n -tttt -w /tmp/cap.pcap 'port 443'

# Check both ends agree on time (capture correlation depends on it):
timedatectl status | grep -i 'system clock\|NTP'
```

### Capture on both ends when you can

The best upgrade to a beginner's capture habit: **run `tcpdump` on the client and the server at the same time.** A segment leaving the client and never arriving at the server is a network problem. A segment arriving at the server but never answered is a server problem. A one-sided capture can't tell you which — the same lesson that makes [traceroute's one-sided view misleading](/posts/traceroute-lies/).

```bash
# Client and server, same wall-clock window, both writing to files:
# client:
sudo tcpdump -i eth0 -n -w /tmp/cap-client.pcap 'host 203.0.113.9 and port 443'
# server:
sudo tcpdump -i eth0 -n -w /tmp/cap-server.pcap 'host 198.51.100.7 and port 443'
```

## The anatomy of what you'll see in Wireshark

Open the file and Wireshark shows a list of packets. Every plain TCP connection tells the same short story.

**The three-way handshake.** `SYN` from the client, `SYN/ACK` from the server, `ACK` back. This is where the connection is (or isn't) born. If you only see a `SYN`, then another `SYN`, and no `SYN/ACK`, the server never answered — or its answer never came back.

**Sequence numbers and ACKs.** Every byte of a TCP stream has a sequence number. Wireshark shows *relative* numbers by default (`Seq=1`, `Seq=1461`), so you read relationships instead of huge absolute counters. The **`Ack=` field is the running "I have received everything up to here."** Watch it climb as data flows. When the same `Seq=` reappears with the same payload, that's a **retransmission** — the sender assumed a segment was lost.

**Retransmissions.** The red rows, usually `[TCP Retransmission]`. One is noise; a repeating pattern is the signal — a lossy hop, a slow link, or a receiver whose window is full. It's the most useful thing a capture shows you, and it's the core of the worked example below. A repeating same-sized segment is also the signature of an MTU black hole, which is why this post and [MTU and PMTUD](/posts/mtu-and-pmtud/) are read together.

**RST.** A single `RST` cuts a connection off: the peer closed with data in flight, a firewall injected a reset, or the peer crashed. Abrupt on purpose — no polite teardown, just "stop."

**FIN/ACK teardown.** The graceful close: `FIN, ACK` from one side, `ACK` back, then the same from the other. If a handshake is followed by a `FIN` from a side that never sent a byte, an application is opening connections it doesn't use.

**TLS bytes you can't read.** After the handshake almost everything is an opaque `TLS` record — a `Client Hello` (whose SNI still tells you which hostname was requested) then `Application Data` Wireshark can't decrypt without a key log. That's fine: timing, sizes, resets, and retransmissions stay visible and explain most "slow" bugs even when the payload is ciphertext.

## The Wireshark features worth learning first

You don't need the whole toolbar. Five things cover 95% of first-week debugging.

**Display filters vs capture filters.** They're different languages. A *capture* filter (`host 10.0.0.5 and port 443`) is BPF and decides what gets recorded. A *display* filter (`ip.addr == 10.0.0.5 && tcp.port == 443`) only hides rows you already captured. When nothing shows up, check you're not typing a capture filter into the display bar.

**Expert Information.** `Analyze → Expert Information` collapses the capture into warnings and notes: retransmissions, duplicate ACKs, zero-window, resets. It's the fastest way to find the anomaly without scanning 5,000 rows.

**`tcp.analysis.retransmission`.** The display filter that earns its keep — it shows only segments the sender had to resend, and it's the first thing I type on a slow-connection capture:

```text
tcp.analysis.retransmission
tcp.analysis.duplicate_ack
tcp.analysis.zero_window
tcp.flags.reset == 1
```

The first catches loss, the second is receivers saying "I'm missing something," the third is a receiver telling the sender to stop, and the fourth isolates every reset. Add `tcp.stream eq N` to lock onto one connection.

**Follow TCP Stream.** Right-click any packet → **Follow → TCP Stream**. Wireshark reassembles the bidirectional conversation into one window, client bytes one colour and server bytes another. For unencrypted protocols it's a full transcript; for TLS you still see how many bytes each side sent and where the conversation stopped.

## How to analyze network traffic: a worked "why is this connection slow?"

The classic ticket: *"The mobile client's upload to our API took 12 seconds. The server says it handled the request in 200 ms."* Both teams are telling the truth. Capture on both ends and the gap explains itself.

```bash
# Capture both sides in the same window, full packets, filtered tight:
# client:
sudo tcpdump -i any -n -s 0 -w /tmp/up-client.pcap 'host 203.0.113.9 and port 443'
# server:
sudo tcpdump -i eth0 -n -s 0 -w /tmp/up-server.pcap 'host 198.51.100.7 and port 443'
```

Open the server capture and find the retransmissions:

```text
tcp.analysis.retransmission
```

Suppose it's empty — no loss on the server's side. Run the same filter on the client. If that's empty too, the wire isn't losing packets; look at *timing*. Sort by `Time` and measure the gap between the client's first data segment and the server's first ACK: if the server acknowledges 6 seconds after the data arrives, the kernel got it but the application didn't read it — a full receive window, a blocking handler, or a slow disk write. Confirm with the window field:

```text
tcp.analysis.zero_window
tcp.window_size_value < 1000
```

A `[TCP ZeroWindow]` line means the receiver advertised a zero-byte window — "stop, I can't take any more." The sender pauses, so the application sees a slow request even though every packet arrived. That's a **receiver-side problem**: fix the receive buffer or the consumer, not the network. Conversely, repeating `[TCP Retransmission]` on the client but clean arrivals on the server means a one-directional lossy hop: routing or carrier.

A clean 300 ms gap before the first byte of each round-trip isn't a bug — it's distance plus a small initial window: latency, not loss. Fix the congestion window or move the endpoint closer.

## A short checklist before you ask for help

- **Filter before you capture.** Host and port, not the whole NIC.
- **`-s 0`** so the file is actually useful in Wireshark.
- **Capture both ends** and sync clocks; a one-sided capture can't assign blame.
- **Read the handshake first**, then retransmissions, then the close.
- **Display filter, not capture filter**, when nothing appears.
- **`tcp.analysis.retransmission` first** on any "slow" complaint.
- **Follow TCP Stream** to stop thinking in rows and start reading a conversation.

A packet capture isn't a firehose to memorise — it's three short stories and five filters. Learn those and the wall of hex becomes the clearest debugging log you own.
