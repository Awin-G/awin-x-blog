---
title: "MTU, MSS, and the path-MTU-discovery nightmare: why big packets stall"
description: "Why the 1500-byte MTU breaks under VPNs, overlays, and tunnels: fragmentation and the DF bit, MSS clamping with a working nftables rule, path MTU discovery and how filtered ICMP kills it, the classic TLS-hang symptom, and a diagnosis walkthrough with ping -M do, tracepath, and tcpdump."
pubDate: 2026-10-25
lang: en
translationKey: mtu-and-pmtud
tags: [networking, linux]
featured: false
keywords:
  - MTU
  - MSS clamping
  - path MTU discovery
  - fragmentation
  - PMTUD
  - nftables
  - VPN MTU
  - ICMP
---

There is a class of network bug that never shows up as a dropped connection, never
as a timeout on a ping, and never as anything in a `curl` to a small endpoint. It
shows up as "SSH logs in fine but `scp` hangs", "the API health check passes but
file uploads freeze", "TLS handshake completes then the first big HTTP response
stalls forever". The culprit is almost always **MTU** — the largest packet a link
will carry — and the machinery that is supposed to discover a smaller one along a
path: **MSS clamping** and **path MTU discovery**. It is the most boring, most
misdiagnosed failure on the internet, and once you understand three numbers you
will never spend three hours on it again.

This is a mechanism-first walk-through. I cover the 1500-byte world and why
encapsulation eats into it, **fragmentation** and the DF bit, MSS clamping, why
**path MTU discovery** breaks when ICMP is filtered, the classic symptom, and a
concrete diagnosis-and-fix walkthrough with `ping`, `tracepath`, `tcpdump`, and
nftables.

## The 1500-byte world, and why encapsulation eats into it

Ethernet's payload limit is 1500 bytes. That number is the **MTU** — *maximum
transmission unit* — the size of the largest IP packet a link will carry without
fragmenting it. Almost every host, NIC, switch, and cloud network defaults to it,
so for years you could pretend the entire path was 1500 bytes end to end.

The moment you introduce a tunnel, that stops being true. Encapsulation adds a
header, and the outer packet must still fit in the physical 1500 bytes. The inner
packet now has less room:

```
Physical link MTU: 1500 bytes
[ outer IP ][ GRE/ESP/UDP/WireGuard ][ inner IP packet ... ]
20 + 8 + 4  = 32 bytes of overhead
=> the payload can only be 1500 - 32 = 1468 bytes before the OUTER packet
   exceeds 1500 and needs fragmenting.
```

The overhead varies with the encapsulation. IPv4 outer + WireGuard (UDP 8 + WG 32)
typically costs 60 bytes. IPsec ESP over IPv4 adds ~50–73 depending on mode and
algorithms. GRE over IPv4 is 24. VXLAN (UDP + 8-byte VXLAN header) is 50. Stack two
tunnels and you subtract twice. **VPN MTU** problems are just this arithmetic: the
tunnel interface's MTU must be set to physical MTU minus the encapsulation cost, or
every packet the inner network thinks fits will be fragmented — or dropped — on
the way out. This is exactly the accounting you do when you build a
[WireGuard interface from scratch](/posts/wireguard-from-scratch/).

## Fragmentation, the DF bit, and IPv6

When an IP packet is larger than a link's MTU, IPv4 has two options: **fragment**
it into smaller IP fragments that reassemble at the destination, or, if the packet
has the **DF (Don't Fragment) bit** set, drop it and send back an ICMP "Destination
Unreachable: Fragmentation Needed" (type 3, code 4).

Fragmentation sounds like a graceful fallback. It is not, and modern stacks avoid
it:

- **It is expensive.** Fragments are reassembled only at the final host, so every
  fragment takes its own path and the reassembly buffer is a classic DoS target
  (fragment overlap attacks, teardrop).
- **It hides sizing errors.** A router that fragments silently "fixes" a
  misconfiguration, so you never learn the path is broken.
- **It is often dropped.** Many middleboxes and firewalls discard fragments rather
  than forward them.

For these reasons, **modern TCP sets DF on every segment** and expects a smaller
MTU to be discovered rather than fragmented around. IPv6 goes further: **routers
do not fragment at all**. Only the source fragments, and it must discover the
correct MTU beforehand. Get that discovery wrong and IPv6 just drops your packets
with a terse ICMPv6 Packet Too Big — IF that message reaches you.

## MSS clamping: telling TCP the right size up front

TCP does not have to wait for a broken packet to learn about MTU. It can negotiate
it. In the SYN/SYN-ACK handshake, each side advertises its **MSS** (Maximum Segment
Size): the largest TCP payload it is willing to receive, *not counting* the TCP/IP
headers.

```
MSS = MTU - IP header - TCP header
    = 1500 - 20 - 20 = 1460   (IPv4, no options)
    = 1500 - 40 - 20 = 1440   (IPv6)
```

The trap: a host computes MSS from *its own* interface MTU, which is usually 1500.
It has no idea that the middle of the path is a 1420-byte tunnel. So it advertises
1460, sends a 1500-byte packet, and the tunnel has to either fragment it or drop it
and rely on PMTUD to save the day.

**MSS clamping** rewrites the MSS option in packets crossing a router so the
endpoints negotiate a size that actually fits. You do it on the tunnel ingress —
the router that owns both the 1500-byte physical side and the smaller tunnel side —
so the hosts on both sides believe the path is smaller than it is.

## MSS clamping in nftables (and the iptables equivalent)

The canonical rule clamps forwarded TCP SYN and SYN-ACK packets whose outbound
interface is the tunnel to a safe MSS. Note the `tcp flags syn` match — this is a
*both-ends* operation, and clamping SYN/SYN-ACK covers both directions of the
handshake.

```bash
#!/usr/sbin/nft -f
# /etc/nftables.d/mss-clamp.nft
#
# Clamp TCP MSS on traffic leaving via the tunnel interface. 1420 is MTU minus
# encapsulation overhead: 1500 - 60 (IPv4 + WireGuard) = 1440, minus 20 bytes of
# safety margin for stacked/tunnelled paths below the overlay.
table inet mssclamp {
    chain forward {
        type filter hook forward priority filter; policy accept;

        # Clamp MSS for IPv4 TCP handshakes leaving through wg0.
        oifname "wg0" tcp flags syn tcp option maxseg size set 1360

        # Clamp MSS for IPv6 TCP handshakes leaving through wg0.
        # IPv6 header is 40 bytes, so the packet's own MTU budget is 20 smaller.
        oifname "wg0" tcp flags syn tcp option maxseg size set 1340
    }
}
```

The older iptables form is the same idea and is often what you will find in
existing setups:

```bash
# Clamp MSS to 1360 for TCP SYN packets leaving wg0 (prefer nftables 2026)
iptables -t mangle -A FORWARD -o wg0 -p tcp --tcp-flags SYN,RST SYN \
    -j TCPMSS --set-mss 1360

# Or, more robustly, clamp to whatever strictly fits the outgoing interface:
iptables -t mangle -A FORWARD -o wg0 -p tcp --tcp-flags SYN,RST SYN \
    -j TCPMSS --clamp-mss-to-pmtu
```

`--clamp-mss-to-pmtu` is elegant because it derives the value from the route's MTU
instead of a hardcoded number; nftables has no direct equivalent, so in nftables
you hardcode a value that is conservative for the path. Pick the smallest MTU any
leg of the path will have and subtract 40/60.

## Path MTU discovery, and why a filtered ICMP kills it

When clamping is not in place — you cannot always control every hop — the network
relies on **path MTU discovery (PMTUD)**. A host sends a full-size packet with DF
set; an intermediate router whose link is too small drops it and replies with ICMP
"Fragmentation Needed" carrying the next-hop MTU; the sender lowers its MSS and
retransmits. That is the whole mechanism, and it is fragile for one blunt reason:
**it depends on ICMP making the round trip back to the sender.**

The single most common cause of MTU black holes is a firewall that drops ICMP
"Fragmentation Needed" (type 3, code 4) — usually as a side effect of an
aggressive default "drop all ICMP" policy. The data packet is dropped because it
is too big; the ICMP message that would tell the sender to shrink is dropped
because it is ICMP. The sender retransmits the same too-big packet, forever. No
error reaches the application; the connection simply stalls.

This is the connection between this problem and hardening servers: a blanket
`drop icmp` rule is exactly what creates MTU black holes. Allow at minimum ICMP
types 3 and 4 (and for IPv6, **all** of ICMPv6 types 1–4 — IPv6 cannot function
without them). The same failure mode bites NAT traversal when ICMP is filtered in
the path; the [NAT traversal piece](/posts/nat-traversal-explained/) is the
control-plane cousin of this one.

## The classic symptom: small requests work, large ones stall

Recognise this shape:

- `ping` with default (small) payload succeeds.
- `ssh` connects, and typing works — but `scp`, `git clone`, or `rsync` hangs at 0%.
- TLS handshake completes (small ServerHello), then the first large HTTP response
  or a `POST` with a real body freezes.
- Small API calls return instantly; uploads, file downloads, and anything with a
  big body stall and eventually time out.

The reason is size-dependent: the handshake, the health check, and the SYN all fit
in a small packet. The first full-size data segment crosses the narrow hop, gets
dropped (DF set, ICMP filtered), and never arrives. The connection is *open* — you
can see an established socket on both ends — but no bytes larger than the smallest
MTU on the path ever get through.

## Diagnosis walkthrough

Work from the inside out. First, find the floor with `ping` and its
don't-fragment switch. On Linux, `-M do` sets DF and forbids fragmentation; if the
path is narrower than your payload, the ping fails with a local
"Message too long" or a timeout.

```bash
# Baseline: small packet always works.
ping -c 2 -M do -s 1200 10.8.0.1

# Find the real MTU: -s is the ICMP payload, so add 28 bytes (20 IP + 8 ICMP).
# Try 1400 payload => 1428-byte packet. If this fails but 1300 works, the
# usable MTU is between 1328 and 1428.
ping -c 2 -M do -s 1400 10.8.0.1

# Local MTU of the interface you're leaving by:
ip link show wg0 | grep -o 'mtu [0-9]*'
```

Next, let the kernel tell you where the path narrows. `tracepath` (no root needed)
performs PMTUD for you and prints the MTU it discovers hop by hop; when it prints
`pmtu 1420` then hangs with `no reply`, you have found a black hole.

```bash
tracepath -n 10.8.0.1
#  1?: [LOCALHOST]     pmtu 1420
#  1:  192.168.1.1      0.412ms
#  2:  10.8.0.1         0.730ms  pmtu 1420
#  3:  10.8.0.1         0.730ms  # once it stops shrinking, 1420 is the floor
```

Then confirm with `tcpdump`, watching for the tell-tale retransmission of an
identically sized segment. Run it on both ends if you can:

```bash
# On the tunnel endpoint: look for full-size segments that repeat, and any
# ICMP 'frag needed' that never made it back.
tcpdump -ni wg0 -v 'tcp and (tcp[tcpflags] & tcp-syn != 0 or ip[6:2] & 0x1fff != 0)'
# A healthy path shows SYNs with MSS ~1360. A black hole shows repeated
# 1500-byte segments with no advancing ACK, and no ICMP in the other direction.
```

The decisive check: if `ping -M do -s 1400` fails but `-s 1300` passes, and a
parallel `tcpdump` shows an ICMP "fragmentation needed" arriving on an unrelated
interface or not at all, you have a PMTUD black hole. Fix it in one of two places:
clamp MSS, or shrink the tunnel MTU.

## Practical fixes

**1. Clamp MSS at the tunnel ingress** (see the nftables rule above). This is the
robust fix: it tells the endpoints the correct size up front, so no full-size
packet ever hits the narrow link. Do it on both the IPv4 and IPv6 forward chains.

**2. Set the tunnel interface MTU correctly.** Never leave a tunnel at 1500. The
correct value is the physical MTU minus the encapsulation overhead, and it must
match on **both** ends:

```bash
# WireGuard: physical 1500 - 60 (IPv4+UDP+WG) = 1440; use a margin if the
# underlying path is itself tunnelled (common on mobile/cloud).
ip link set dev wg0 mtu 1420

# Verify the stack computes the right MSS from it:
ip route get 10.8.0.1                 # shows the device and its mtu
ss -tin 'dst 10.8.0.1' | grep -o 'mss:[0-9]*'   # negotiated MSS on a live conn
```

**3. Stop dropping ICMP wholesale.** Keep the messages that make the internet work.
A minimal nftables policy allows ICMP type 3 (destination-unreachable, which
includes code 4 fragmentation-needed) and type 4 (source-quench) for IPv4, and
ICMPv6 types 1–4 for IPv6:

```bash
# Allow the ICMP messages PMTUD depends on. Everything else can still be
# rate-limited rather than silently dropped.
nft add rule inet filter input  icmp type { destination-unreachable, time-exceeded, parameter-problem } accept
nft add rule inet filter input  icmpv6 type { destination-unreachable, packet-too-big, time-exceeded, parameter-problem } accept
# NOTE: on IPv4, fragmentation-needed is a CODE of destination-unreachable, not a
# separate type — matching the type matches the code too.
```

## The three numbers worth memorising

- **MTU 1500** is the physical world; every tunnel subtracts from it.
- **MSS = MTU − 40 (IPv4) / − 60 (IPv6)** is what TCP should negotiate, and MSS
  clamping is how you make it negotiate the smaller path value.
- **PMTUD** discovers the narrow hop *only if* ICMP "fragmentation needed" is
  allowed back. Filter that ICMP and you have built a black hole that drops
  every large packet while letting every small one through.

If a connection opens but stalls under load, you now know the first thing to check:
`ping -M do -s`, `tracepath` for the floor, `tcpdump` for the repeated full-size
segment — then clamp the MSS and fix the tunnel MTU. The bug that cost you three
hours is a 60-byte header you forgot to subtract.
