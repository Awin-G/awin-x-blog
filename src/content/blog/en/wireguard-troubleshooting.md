---
title: "WireGuard troubleshooting: the handshake is fine, so why is nothing working?"
description: "A practical WireGuard troubleshooting ladder built from real wg show, tcpdump and conntrack output: wrong public keys, missing AllowedIPs, PersistentKeepalive behind NAT, and MTU stalls. All reproduced in throwaway containers."
pubDate: 2027-01-12
lang: en
translationKey: wireguard-troubleshooting
tags: [networking, security]
featured: false
keywords:
  - WireGuard troubleshooting
  - wg show
  - AllowedIPs
  - WireGuard handshake
  - PersistentKeepalive
---

Every "my WireGuard tunnel is broken" report I've seen resolves to the same place: someone looked at `wg show`, saw what looked like health, and gave up. The trick is that `wg show` answers *two different questions* — is the cryptography talking, and is data moving — and most advice is written for only one of them at a time. This is the **WireGuard troubleshooting** ladder I actually use, every failure reproduced on real interfaces, ending in a checklist you can run mid-incident.

## The lab: real interfaces, no privileged containers

Everything below happened inside three ordinary containers with `--cap-add=NET_ADMIN --device=/dev/net/tun` — no `--privileged`, no root on the host:

```console
$ docker run -d --name peer-a --cap-add=NET_ADMIN --device=/dev/net/tun \
    --network wg-inet --ip 10.99.0.2 debian:bookworm-slim sleep infinity
```

The kernel's WireGuard module auto-loads inside the container (`/proc/modules` shows `wireguard` plus `libcurve25519`, `ip6_udp_tunnel`, `udp_tunnel`), so this is the real kernel implementation. If your host doesn't have the module, `wireguard-go` gives you a userspace interface with identical config and output — every test below behaves the same.

## The mental model: `wg show`, the WireGuard handshake, and transfer

`wg show` prints two lines per peer that carry almost all the diagnostic weight:

```console
$ wg show
interface: wg0
  public key: 59QhvjZMxCDl0ftITiOAmfAfO7mgbEcylF59x4Y8RyA=
  private key: (hidden)
  listening port: 51820

peer: jc/msZY/OZUhyw/A0FoRbboC7G6b80gIzGJkQZTUBxo=
  endpoint: 10.99.0.3:51821
  allowed ips: 10.0.0.0/24
  latest handshake: 2 seconds ago
  transfer: 476 B received, 532 B sent
```

- **`latest handshake`** answers the crypto/network question: keys agree, packets arrive. If it says "2 seconds ago", the *WireGuard handshake* is healthy and you're wasting time checking keys.
- **`transfer`** answers the data question: `received` and `sent` are inner-packet bytes this interface encrypts. A healthy peer grows both. **Recent handshake plus one-directional transfer means routing, not crypto** — the peer decrypts your packets and cannot route a reply.

Worth memorizing (visible in tcpdump): handshake *initiation* is 148 bytes, the *response* is 92, transport data is usually ~128, the idle keepalive is 32. That's how you tell them apart on the wire instantly.

## The failure ladder

Work top to bottom; each rung fails independently — that's the point.

<figure>
<svg viewBox="0 0 640 250" width="640" height="250" role="img" aria-label="WireGuard failure ladder: no handshake, handshake but no traffic, stalls on big packets, goes stale while idle" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif">
  <rect x="0" y="0" width="640" height="250" rx="8" fill="none" stroke="#0f766e" stroke-width="1.5" opacity="0.25"/>
  <g font-size="14" fill="currentColor">
    <!-- rung 1 -->
    <rect x="16" y="14" width="608" height="52" rx="6" fill="#0f766e" opacity="0.10"/>
    <text x="30" y="35" font-weight="700" fill="#0f766e">1 · No handshake</text>
    <text x="30" y="55">no "latest handshake" line · 148-byte initiations on the wire, no reply</text>
    <!-- rung 2 -->
    <rect x="16" y="74" width="608" height="52" rx="6" fill="#0f766e" opacity="0.10"/>
    <text x="30" y="95" font-weight="700" fill="#0f766e">2 · Handshake fine, no traffic</text>
    <text x="30" y="115">recent handshake, one-way "transfer" · AllowedIPs / cryptokey routing</text>
    <!-- rung 3 -->
    <rect x="16" y="134" width="608" height="52" rx="6" fill="#0f766e" opacity="0.10"/>
    <text x="30" y="155" font-weight="700" fill="#0f766e">3 · Traffic but big packets stall</text>
    <text x="30" y="175">small pings fine, 5 MB copy hangs · MTU / MSS over the tunnel</text>
    <!-- rung 4 -->
    <rect x="16" y="194" width="608" height="52" rx="6" fill="#0f766e" opacity="0.10"/>
    <text x="30" y="215" font-weight="700" fill="#0f766e">4 · Works, then goes stale while idle</text>
    <text x="30" y="235">behind NAT · PersistentKeepalive shorter than the NAT timeout</text>
  </g>
</svg>
<figcaption>The WireGuard troubleshooting ladder. Diagnose by evidence on the wire, not by configuration guesses.</figcaption>
</figure>

## Reading `wg show` and `wg show all dump`

`wg show all dump` is the machine-readable form, and it's what you paste into an issue: one line per interface (private key, public key, listen port, fwmark), then one line per peer, adding endpoint, allowed IPs, last-handshake timestamp (0 = never), rx/tx bytes, and keepalive interval:

```console
$ wg show all dump
wg0	...	jc/msZY/OZUhyw/A0FoRbboC7G6b80gIzGJkQZTUBxo=	51821	off
wg0	59QhvjZMxCDl0ftITiOAmfAfO7mgbEcylF59x4Y8RyA=	(none)	10.99.0.2:51820	10.0.0.0/24	1791843996	532	476	off
```

Three things to read from those lines. The endpoint `10.99.0.2:51820` was **never configured** on this peer — WireGuard stores the last authenticated source address (roaming), so an endpoint there doesn't prove anyone wrote it in a file. The timestamp is the last handshake as epoch seconds (0 = never). And there is no handshake *counter* — to prove movement, take two dumps a minute apart and compare rx/tx.

## Failure 1: no handshake — the wrong public key

I configured `peer-a`'s peer entry with a key that doesn't match `peer-b`'s private key — the famous copy-paste failure, where one side regenerated keys and only half the config followed:

```console
$ wg show
interface: wg0
  public key: 59QhvjZMxCDl0ftITiOAmfAfO7mgbEcylF59x4Y8RyA=
  private key: (hidden)
  listening port: 51820

peer: z+bdVjjlqjKNS0mKCw1aY+ZJF2T/5N79dESUJU9BfW8=
  endpoint: 10.99.0.3:51821
  allowed ips: 10.0.0.0/24

$ ping -c 3 -W 2 10.0.0.2
3 packets transmitted, 0 received, 100% packet loss
```

Note what's missing: no `latest handshake` line, and no `transfer` line. The first is the one that matters — a peer with no `latest handshake` line has never completed a handshake with you.

The wire tells the rest. Every initiation retries every five seconds, and nothing comes back:

```console
$ tcpdump -ni eth0 'udp port 51821'
22:27:00.393546 IP 10.99.0.2.51820 > 10.99.0.3.51821: UDP, length 148
22:27:05.747055 IP 10.99.0.2.51820 > 10.99.0.3.51821: UDP, length 148
```

Initiation out, no 92-byte response — the signature of a **key mismatch**. It's also the signature of a firewall dropping UDP, so tell them apart by *where the packets stop*: with a key mismatch the 148-byte packet reaches the far end, which silently discards it; if it never arrives, you're hunting a firewall or a wrong endpoint. Fix: the *correct* key in `wg set wg0 peer <server-public-key> endpoint ... allowed-ips ...` on both sides, then `wg syncconf wg0 <(wg-quick strip wg0)`.

## Failure 2: handshake fine, zero traffic — `AllowedIPs`

This is the failure the title is about, and it's boringly common: a typo in `AllowedIPs`. On `peer-b` I changed the peer's allowed IPs to `10.88.0.0/24` (one transposed octet) and left `peer-a` alone:

```console
$ wg show            # on peer-a — crypto is fine!
peer: jc/msZY/OZUhyw/A0FoRbboC7G6b80gIzGJkQZTUBxo=
  endpoint: 10.99.0.3:51821
  allowed ips: 10.0.0.0/24
  latest handshake: 16 seconds ago
  transfer: 124 B received, 660 B sent

$ ping -c 4 -W 1 10.0.0.2
4 packets transmitted, 0 received, 100% packet loss
```

Handshake recent, `sent` growing, `received` frozen near zero — rung 2: not crypto, but `peer-b` receiving, decrypting, and then dropping your packets. Here's why, and it's the most important concept in this article.

`AllowedIPs` does **two jobs**. Inside WireGuard it is the *cryptokey routing table*: when `peer-b` decrypts a packet it checks that the source address falls inside some peer's `AllowedIPs`, and when it generates traffic it uses `AllowedIPs` to pick *which peer's key encrypts the reply. With the typo, the decrypted packet fails that check and is dropped inside `wg0` — it never reaches the kernel, so no ICMP, no TCP reset, nothing. Meanwhile the kernel's *routing table* still looks healthy, which is what makes this trap so deep:

```console
$ ip route        # on peer-b — this LOOKS fine
default via 10.99.0.254 dev eth0
10.0.0.0/24 dev wg0 proto kernel scope link src 10.0.0.2
$ ip route get 10.0.0.1
10.0.0.1 dev wg0 src 10.0.0.2 uid 0
    cache
```

That `10.0.0.0/24 dev wg0` line comes from the `/24` address you assigned to the interface, *not* from `AllowedIPs` — so `ip route` is allowed to lie here, and the replies die inside the interface, below the routing table. The capture confirms both halves: handshake completes, requests go in, nothing comes out.

```console
$ tcpdump -ni eth0 'udp port 51821'    # on peer-b
22:27:35.365972 IP 10.99.0.2.51820 > 10.99.0.3.51821: UDP, length 148   # initiation
22:27:35.366158 IP 10.99.0.3.51821 > 10.99.0.2.51820: UDP, length 92     # response
22:27:35.366293 IP 10.99.0.2.51820 > 10.99.0.3.51821: UDP, length 128   # data in
22:27:36.403993 IP 10.99.0.2.51820 > 10.99.0.3.51821: UDP, length 128   # data in
```

Fix on the wrong side and the counters flip within one ping:

```console
$ wg set wg0 peer "$(cat p_a.pub)" allowed-ips 10.0.0.0/24     # on peer-b
$ ping -c 3 -W 1 10.0.0.2
3 packets transmitted, 3 received, 0% packet loss
```

Habit to build: recent handshake plus one-way transfer means diffing the `allowed ips` lines on both peers against the addresses each side actually owns — the far side's cryptokey routing doesn't cover you.

## Failure 3: works, then dies while idle — `PersistentKeepalive` and NAT

Now `peer-a` sits behind a NAT router (`nat-r`, a container doing `MASQUERADE` with `net.ipv4.ip_forward=1`) — exactly like a laptop at a coffee shop. The tunnel is established and traffic flows. Look at what `peer-b` knows about its peer:

```console
$ wg show all dump     # on peer-b
wg0	...	3Z8oUm9ikTLd8f8zjUV4nvGcsDTGSYJpWNMHHALuq28=	51821	off
wg0	V3kQJ1HslySBTWSvKzz6NnEtdGlDk91J3SVyk3hAPzc=	(none)	10.99.0.1:51820	10.0.0.0/24	1791844916	820	732	off
```

`10.99.0.1:51820` is the NAT router's public address, not the peer's — `peer-b` only ever sees post-NAT packets. The mapping this depends on lives in the router's connection tracking:

```console
$ conntrack -L -p udp     # on nat-r
udp      17 7 src=10.99.0.2 dst=10.99.0.3 sport=51820 dport=51821 src=10.99.0.3 dst=10.99.0.1 sport=51821 dport=51820 [ASSURED] mark=0 use=1
```

Now the NAT mapping expires (the lab container ran with `nf_conntrack_udp_timeout=8`; a home router typically gives UDP 30 seconds, and I deleted the entry with `conntrack -D -p udp` so the demo doesn't wait). The tunnel sits idle, then `peer-b` tries to start the conversation itself — and handshakes that would complete in a millisecond on a LAN vanish:

```console
$ ping -c 4 -W 1 10.0.0.1        # on peer-b
4 packets transmitted, 0 received, 100% packet loss

$ wg show                        # on peer-b — fresh peer, no handshake yet
peer: V3kQJ1HslySBTWSvKzz6NnEtdGlDk91J3SVyk3hAPzc=
  endpoint: 10.99.0.1:51820
  allowed ips: 10.0.0.0/24
  transfer: 0 B received, 148 B sent

$ wg show                        # on peer-a — last handshake is ancient
  latest handshake: 1 minute, 12 seconds ago
```

The router's capture shows exactly where they die: at the public IP, with no reply ever leaving:

```console
$ tcpdump -ni eth0 'udp port 51820'   # on nat-r
22:42:52.033646 IP 10.99.0.3.51821 > 10.99.0.1.51820: UDP, length 148
22:42:57.554937 IP 10.99.0.3.51821 > 10.99.0.1.51820: UDP, length 148
```

Initiations retry every five seconds forever, and the NAT quietly drops them because no mapping brings them to `peer-a`. You may also spot a 32-byte packet from `peer-a` — WireGuard sends an empty keepalive while a session is alive, which incidentally rebuilds the mapping. Don't lean on that: the session ages out and the keepalive stops. The supported mechanism is `PersistentKeepalive`, set **on the peer behind the NAT**, shorter than the NAT's mapping timeout (25 seconds vs. a typical 30-second UDP timeout). The lab's UDP timeout was 8 seconds, so I used 2:

```console
$ wg set wg0 peer "$(cat p_b.pub)" persistent-keepalive 2      # on peer-a
$ wg show | tail -3
  latest handshake: 12 seconds ago
  transfer: 2.35 KiB received, 3.02 KiB sent
  persistent keepalive: every 2 seconds
```

With keepalives refreshing the mapping, the next initiation passes, the handshake completes in seconds, and `transfer` counts both directions again. The router's capture shows the whole repair cycle, each packet visible twice — before the NAT rewrite (`10.99.0.2` → `10.99.0.1`) and after:

```console
$ tcpdump -ni eth0 'udp port 51820'   # on nat-r
22:45:28.594865 IP 10.99.0.2.51820 > 10.99.0.3.51821: UDP, length 32    # A's keepalive
22:45:28.594875 IP 10.99.0.1.51820 > 10.99.0.3.51821: UDP, length 32    # ... same packet, SNATed
22:45:28.751503 IP 10.99.0.3.51821 > 10.99.0.1.51820: UDP, length 148   # B's initiation, to public IP
22:45:28.751528 IP 10.99.0.3.51821 > 10.99.0.2.51820: UDP, length 148   # ... delivered to A
22:45:28.751743 IP 10.99.0.2.51820 > 10.99.0.3.51821: UDP, length 92    # handshake response
```

## Failure 4: handshake fine, small packets fine, big packets gone — MTU

The last rung is the ugliest, because small things work. On a 1400-byte underlay path with a wrongly sized `wg0` (I set the interface MTU to 1500 — every encapsulated packet grows a few dozen bytes: measured on the wire, a 1500-byte inner packet leaves as a 1532-byte UDP datagram), small traffic is perfect and anything large dies silently:

```console
$ ping -M do -c 2 -W 1 -s 1312 10.0.0.2
2 packets transmitted, 0 received, 100% packet loss
```

One caveat about my lab: Docker's veth happily carried the oversize frames anyway (an offload artifact), so to reproduce the real symptom I added one rule on the receiving side dropping oversized UDP frames — the behaviour of any PPPoE, mobile, or fragment-hostile path:

```console
$ iptables -A INPUT -p udp --dport 51821 -m length --length 1401:1600 -j DROP
```

TCP makes it lethal, because the handshake and small requests work and bulk data doesn't. With the bad MTU, a 5 MiB stream over `nc`, checked after 15 seconds:

```console
$ timeout 15 sh -c 'dd if=/dev/zero bs=1M count=5 | nc -N 10.0.0.2 5555'   # on peer-a
$ ls -l rxbad.bin    # on peer-b
-rw-r--r-- 1 root root 0 Oct 12 23:03 rxbad.bin
```

Zero bytes out of 5242880. After the fix below, the same transfer completes in full.

Remote shell alive, small `curl` alive, `git clone` hanging at the same byte every time. The fix is arithmetic, applied on **both** interfaces: wg MTU ≤ path MTU − ~80 (hence the usual 1420 on a 1500 Ethernet path; 1300–1340 on a 1400 path):

```console
$ ip link set wg0 mtu 1300      # on both peers
$ ping -M do -c 2 -s 1272 10.0.0.2
2 packets transmitted, 2 received, 0% packet loss
$ ping -M do -c 1 -s 1472 10.0.0.2
ping: local error: message too long, mtu=1300
```

That second failure is the *desirable* one: immediate, local, and it names the interface. `-M do` ("don't fragment") is the most useful flag in this article — it turns a silent stall into a message. For TCP, the tunnel-side fix is an MSS clamp on the server (`iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu`) — what people mean by "it worked after I added the MSS rule".

## The checklist

In order, and yes, it's boring on purpose:

1. `wg show` — handshake age, and both `transfer` counters.
2. No handshake line → compare public keys on both sides, then endpoint/UDP reachability. `tcpdump 'udp port 51820'`: 148-out-no-92 = a key; nothing out = network/firewall.
3. Handshake recent but one-way transfer → diff the `allowed ips` lines on both peers against the addresses each side owns. Rung 2, always.
4. Dies when idle → find who is behind NAT; `PersistentKeepalive` on that side, below the NAT timeout (25 for 30).
5. Small works, big stalls → MTU on both wg interfaces, and `ping -M do -s <limit>`.
6. Check both sides of every step, and always with a capture running. `wg show` tells you where to look; only the wire tells you who's lying.

Setup, key rotation, and the keys-and-AllowedIPs ceremony are in [WireGuard from scratch](/posts/wireguard-from-scratch/); running the same tunnel in a container (and the permission model that makes `--cap-add=NET_ADMIN` enough) is in [WireGuard in containers](/posts/wireguard-in-containers/). The containers used for this article are destroyed; the commands above are the whole reproduction.
