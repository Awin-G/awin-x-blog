---
title: "Scapy tutorial: craft packets and sniff packets on your own loopback"
description: "Hands-on packet manipulation in Python: craft packets with Scapy — a crafted ICMP echo, an Ethernet/IP/TCP frame, a real DNS query — send them on your own loopback, and sniff the replies. Real show(), hexdump() and resolver output, plus the honest limits."
pubDate: 2027-01-04
lang: en
translationKey: scapy-packet-crafting
tags: [networking, python, security]
featured: false
keywords:
  - Scapy tutorial
  - craft packets
  - packet manipulation Python
  - sniff packets
  - ICMP
  - DNS query
  - hexdump
---

Reading a packet capture tells you what the network did. **Craft packets** and send
them and you learn what the network *believes*. That is the argument of this
**Scapy tutorial**: Scapy is a Python packet manipulation library, and the fastest
way I know to own a protocol is to build one of its packets by hand, send it to a
machine I own, and **sniff packets** coming back. No GUI teaches you that the TCP
flags live in byte 13 of the segment. Writing that byte yourself does.

Every command below is real output from a throwaway container running scapy 2.8.0
on Python 3.12 — a **packet manipulation Python** session aimed at the safest
possible target: `127.0.0.1`.

## What Scapy is, and why it teaches protocols better than a GUI

Scapy is a library, not a protocol analyser with scripting bolted on. You describe a
packet as a Python object — each layer a class, each field an attribute — stack the
layers with `/`, then push the result onto a raw socket. It captures, dissects and
replays too. The learning value is in the description step:

- **Every field has a name and a default.** You cannot set a TTL without noticing a
  TTL exists. In a GUI you scroll past fields you do not know.
- **The stack *is* the protocol.** `IP(dst=...) / TCP(dport=...)` literally encodes
  encapsulation: the bytes of one header, then the bytes of the next.
- **Same library, both ends.** You can craft the query *and* the response in one
  process — the only cheap way to learn why DNS has a transaction ID.

The trade-off: Scapy does not implement TCP for you. It will hand you a raw socket
and let you build a segment the kernel knows nothing about. That power is exactly
why the boundaries at the end matter.

## The lab: a throwaway container, loopback only

Everything runs in one disposable container. No host changes, no `sudo`, no
`--privileged` — just `NET_RAW`, the single capability a raw socket needs:

```bash
docker run -d --rm --name scapylab --cap-add=NET_RAW python:3.12-slim-bookworm sleep infinity
docker exec scapylab pip install scapy
docker exec scapylab sh -c 'grep CapEff /proc/self/status'
```

```text
CapEff:	00000000a80425fb
```

> **Authorised use only, loopback only.** Every packet in this article is
> addressed to `127.0.0.1` and captured on `lo` inside a container I own and
> delete afterwards. Loopback never touches a wire, so there is no third party,
> nothing to intercept and nobody to ask. Do not point the same code at a host
> you do not own — the last section explains why I do not either.

## Craft packets by stacking layers: Ether()/IP()/TCP(), ICMP() and DNS()

### Every layer is a class, and `/` stacks them

Start with the smallest useful packet. `IP()` fills in every field it has a default
for, `/` appends the next layer, `/ b"..."` appends raw bytes:

```python
from scapy.all import IP, ICMP, conf, raw

conf.verb = 0                       # silence per-packet chatter
pkt = IP(dst="127.0.0.1") / ICMP(type="echo-request", id=0x1337, seq=1)
pkt = pkt / b"scapy-loopback-lab"

pkt.show()
```

```text
###[ IP ]###
  version   = 4
  ihl       = None
  tos       = 0x0
  len       = None
  id        = 1
  flags     =
  frag      = 0
  ttl       = 64
  proto     = icmp
  chksum    = None
  src       = 127.0.0.1
  dst       = 127.0.0.1
  \options   \
###[ ICMP ]###
     type      = echo-request
     code      = 0
     chksum    = None
     id        = 0x1337
     seq       = 0x1
     unused    = b''
###[ Raw ]###
        load      = b'scapy-loopback-lab'
```

`src = 127.0.0.1` came from the routing table. `ihl`, `len` and both `chksum` fields
are `None` because they are *computed at build time*, not at construction time.
`raw()` builds it — the only thing that ever leaves the process:

```python
wire = raw(pkt)
print(wire)
print(len(wire), "bytes")
```

```text
b'E\x00\x00.\x00\x01\x00\x00@\x01|\xcc\x7f\x00\x00\x01\x7f\x00\x00\x01\x08\x00fK\x137\x00\x01scapy-loopback-lab'
46 bytes
```

Re-parsing our own bytes shows what Scapy computed: `ihl = 5` (a 20-byte IPv4
header), `len = 46`, `IP chksum = 0x7ccc`, `ICMP chksum = 0x664b`. 20 header + 8
ICMP header + 18 payload = 46, and the checksums you never wrote are correct.

### Reading a stack back: show() and ls()

Here is the classic first Scapy program, a full Ethernet/IP/TCP frame:

```python
from scapy.all import Ether, IP, TCP

pkt = (Ether(src="02:00:00:00:00:02", dst="02:00:00:00:00:01")
       / IP(src="127.0.0.1", dst="127.0.0.1", ttl=64)
       / TCP(sport=40001, dport=8080, flags="S", seq=1000, window=64240))

print(len(pkt), "bytes")          # Ether 14 + IP 20 + TCP 20, no payload
pkt.show()
```

```text
54 bytes
###[ Ethernet ]###
  dst       = 02:00:00:00:00:01
  src       = 02:00:00:00:00:02
  type      = IPv4
###[ IP ]###
  ttl       = 64
  proto     = tcp
  chksum    = None
###[ TCP ]###
  sport     = 40001
  dport     = http_alt
  seq       = 1000
  ack       = 0
  flags     = S
  window    = 64240
  chksum    = None
  options   = []
```

Three details worth pausing on. `type = IPv4` and `dport = http_alt`: Scapy
resolves enums to names, so `0x0800` prints as `IPv4` and `8080` prints as
`http_alt`. `chksum = None` again — computed at build. And `options = []`: TCP
options are their own layer list, which is how you add MSS or a window scale factor.

`ls()` is the introspection view — every field, its Scapy type, its current value
and its default. Here it is on the DNS layer we use later, which is how you
discover what a layer can do:

```python
ls(DNS())
```

```text
length     : ShortField (Cond)                   = None            ('None')
id         : ShortField                          = 0               ('0')
qr         : BitField  (1 bit)                   = 0               ('0')
opcode     : BitEnumField                        = 0               ('0')
aa         : BitField  (1 bit)                   = 0               ('0')
tc         : BitField  (1 bit)                   = 0               ('0')
rd         : BitField  (1 bit)                   = 1               ('1')
ra         : BitField  (1 bit)                   = 0               ('0')
rcode      : BitEnumField                        = 0               ('0')
qdcount    : FieldLenField                       = None            ('None')
ancount    : FieldLenField                       = None            ('None')
nscount    : FieldLenField                       = None            ('None')
arcount    : FieldLenField                       = None            ('None')
qd         : _DNSPacketListField                 = [<DNSQR  |>]    ('[<DNSQR  |>]')
an         : _DNSPacketListField                 = []              ('[]')
```

Abridged a little — `z`, `ad`, `cd`, `ns` and `ar` are in the real output. The four
`*count` fields are `FieldLenField`: leave them as `None` and Scapy counts the
records you actually attached. That is the whole DNS header in one listing.

## show() vs hexdump(): the tree interprets, the bytes are

`show()` is a dissection — Scapy decided where each field starts and printed a name.
`hexdump()` shows the bytes with an offset and an ASCII column, like Wireshark's
bytes pane. Use both: read the tree, verify with the hex.

```python
hexdump(pkt)
```

```text
0000  02 00 00 00 00 01 02 00 00 00 00 02 08 00 45 00  ..............E.
0010  00 28 00 01 00 00 40 06 7C CD 7F 00 00 01 7F 00  .(....@.|.......
0020  00 01 9C 41 1F 90 00 00 03 E8 00 00 00 00 50 02  ...A..........P.
0030  FA F0 F7 35 00 00                                ...5..
```

Reading it back by hand is the exercise that makes `show()` trustworthy:

```python
b = raw(pkt)
b[12:14].hex()                   # '0800' -> EtherType = IPv4
b[14] >> 4, b[14] & 0x0F         # 4 5    -> IPv4, IHL 5 = 20-byte header
b[23]                            # 6      -> IP protocol = TCP
int.from_bytes(b[34:36], 'big')  # 40001  -> TCP source port
b[47]                            # 0x2    -> flags = SYN
```

```text
0800
4 5
6
40001
0x2
```

Parsing those bytes back gives a packet whose bytes are bit-identical — which is
where the last line of the next block bites:

```python
p2 = Ether(b)
print(p2.summary())
print(raw(p2) == b)
print(p2 == pkt)
```

```text
Ether / IP / TCP 127.0.0.1:40001 > 127.0.0.1:http_alt S
True
False
```

That last `False` is a real Scapy gotcha, not a bug. `pkt` was never built, so its
`len` and `chksum` are still `None`; `p2` was parsed from 54 real bytes and has
values. Compare `raw()` output when you care whether two packets are the same
packet.

<figure>
<svg viewBox="0 0 640 300" width="100%" role="img" aria-label="Three stacked layer bars built in Scapy: the Ethernet header with dst MAC, src MAC and EtherType; the IPv4 header with version and IHL, total length, protocol, checksum and source and destination addresses; the TCP header with source port, destination port, sequence number, acknowledgement, flags, window and checksum. An arrow points down from the stack to raw() and hexdump().">
  <g fill="none" stroke="currentColor" stroke-width="1.25" opacity="0.5">
    <rect x="36" y="34" width="568" height="38" rx="6"/>
    <rect x="36" y="104" width="568" height="38" rx="6"/>
    <rect x="36" y="174" width="568" height="38" rx="6"/>
  </g>
  <g stroke="#0f766e" stroke-width="1.25" fill="none" opacity="0.85">
    <rect x="40" y="38" width="176" height="30" rx="4"/>
    <rect x="220" y="38" width="176" height="30" rx="4"/>
    <rect x="400" y="38" width="76" height="30" rx="4"/>
    <rect x="40" y="108" width="60" height="30" rx="4"/>
    <rect x="104" y="108" width="72" height="30" rx="4"/>
    <rect x="180" y="108" width="60" height="30" rx="4"/>
    <rect x="244" y="108" width="84" height="30" rx="4"/>
    <rect x="332" y="108" width="140" height="30" rx="4"/>
    <rect x="476" y="108" width="124" height="30" rx="4"/>
    <rect x="40" y="178" width="72" height="30" rx="4"/>
    <rect x="116" y="178" width="72" height="30" rx="4"/>
    <rect x="192" y="178" width="108" height="30" rx="4"/>
    <rect x="304" y="178" width="108" height="30" rx="4"/>
    <rect x="416" y="178" width="56" height="30" rx="4"/>
    <rect x="476" y="178" width="60" height="30" rx="4"/>
    <rect x="540" y="178" width="60" height="30" rx="4"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11">
    <text x="128" y="57" text-anchor="middle">dst MAC · 6 B</text>
    <text x="308" y="57" text-anchor="middle">src MAC · 6 B</text>
    <text x="438" y="57" text-anchor="middle">type · 2 B</text>
    <text x="70" y="127" text-anchor="middle">ver/IHL</text>
    <text x="140" y="127" text-anchor="middle">len</text>
    <text x="210" y="127" text-anchor="middle">proto</text>
    <text x="286" y="127" text-anchor="middle">checksum</text>
    <text x="402" y="127" text-anchor="middle">src 127.0.0.1</text>
    <text x="538" y="127" text-anchor="middle">dst 127.0.0.1</text>
    <text x="76" y="197" text-anchor="middle">sport</text>
    <text x="152" y="197" text-anchor="middle">dport</text>
    <text x="246" y="197" text-anchor="middle">sequence</text>
    <text x="358" y="197" text-anchor="middle">ack</text>
    <text x="444" y="197" text-anchor="middle">flags</text>
    <text x="506" y="197" text-anchor="middle">window</text>
    <text x="570" y="197" text-anchor="middle">cksum</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="36" y="24" opacity="0.75">Ether() — 14 bytes on the wire</text>
    <text x="36" y="94" opacity="0.75">IP() — 20 bytes</text>
    <text x="36" y="164" opacity="0.75">TCP() — 20 bytes</text>
  </g>
  <g fill="none" stroke="currentColor" stroke-width="1.25" opacity="0.5" marker-end="url(#scapylayers)">
    <path d="M620 53 H632 V193 H620"/>
  </g>
  <defs>
    <marker id="scapylayers" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="36" y="246">Ether() / IP() / TCP()</text>
    <text x="36" y="266" opacity="0.75">→ raw(): 54 bytes</text>
    <text x="36" y="284" opacity="0.75">→ hexdump(): offset, hex, ASCII</text>
  </g>
</svg>
<figcaption>One Scapy packet is a stack of layer objects. Each bar is one header and its fields are the attributes you set; <code>raw()</code> turns the whole stack into the bytes on the wire.</figcaption>
</figure>

## Sending and receiving: sr, sr1, send and sniff

Four functions cover almost everything, and the difference is whether you want an
answer.

| function | what it does | reach for it when |
|---|---|---|
| `send(pkt)` | fires the packet, returns a count | you only want the packet on the wire |
| `sr(pkt)` | sends, returns answered **and** unanswered | you care about probes that never answered |
| `sr1(pkt)` | sends, returns the **first** reply | one answer: a ping, a DNS reply, a SYN-ACK |
| `sniff(...)` | captures, returns a packet list | you want to see everything, including your own |

`sr1` is the workhorse:

```python
reply = sr1(IP(dst="127.0.0.1") / ICMP(type="echo-request", id=0x1337, seq=1)
            / b"scapy-loopback-lab", iface="lo", timeout=2)
print(reply.summary())
print(reply[ICMP].type, reply[ICMP].id, bytes(reply[ICMP].payload))
```

```text
IP / ICMP 127.0.0.1 > 127.0.0.1 echo-reply 0 / Raw
0 4919 b'scapy-loopback-lab'
```

`type = 0` is `echo-reply`, `id = 4919` is `0x1337` — ours — and the kernel echoed
the payload back. A real ICMP round trip, from a packet I typed by hand.

### What sniff() shows that send() never will

`send()` returns a count. `sniff()` returns the conversation, including what the
kernel did behind your back. Start an `AsyncSniffer` on `lo`, then send a crafted
ICMP echo, a crafted DNS query, and a crafted TCP SYN at a plain listener:

```python
sniffer = AsyncSniffer(iface="lo", count=20)
sniffer.start()
sr1(IP(dst="127.0.0.1")/ICMP(type="echo-request", id=0x99, seq=7)/b"sniff me", iface="lo")
sr1(IP(dst="127.0.0.1")/UDP(sport=41010, dport=5353)
    /DNS(id=0x7777, rd=1, qd=DNSQR(qname="scapy.lab", qtype="A")), iface="lo")
send(IP(dst="127.0.0.1")/TCP(sport=41011, dport=8080, flags="S", seq=500), iface="lo")
sniffer.stop()

seen, uniq = set(), []
for p in sniffer.results:          # each frame crosses lo twice
    if raw(p) in seen:
        continue
    seen.add(raw(p))
    uniq.append(p)
print(len(sniffer.results), "frames,", len(uniq), "unique")
for p in uniq:
    print(p.summary())
```

```text
16 frames, 8 unique
Ether / IP / ICMP 127.0.0.1 > 127.0.0.1 echo-request 0 / Raw
Ether / IP / ICMP 127.0.0.1 > 127.0.0.1 echo-reply 0 / Raw
Ether / IP / UDP / mDNS Qry b'scapy.lab.'
Ether / IP / UDP / DNS Ans 127.0.0.1
Ether / IP / ICMP / IPerror / UDPerror / DNS Ans 127.0.0.1
Ether / IP / TCP 127.0.0.1:41011 > 127.0.0.1:http_alt S
Ether / IP / TCP 127.0.0.1:http_alt > 127.0.0.1:41011 SA
Ether / IP / TCP 127.0.0.1:41011 > 127.0.0.1:http_alt R
```

Three things in there no tutorial mentions. **Every frame appears twice** — on
loopback the packet crosses `lo` once on the way out and once on the way in, and a
`PF_PACKET` capture sees both. `tcpdump -i lo -c 6 icmp` agrees: it printed `4
packets received by filter / 2 packets captured` for one echo. **The `IPerror /
UDPerror` frame**: I sent the DNS query from source port 41010 with nothing bound
to it, so when dnsmasq's answer arrived the kernel replied with ICMP *port
unreachable* and quoted the offending IP and UDP headers inside the error. **The
SYN got a real SYN-ACK, and then a real RST** — both of them from the kernel,
because the packet I crafted was a perfectly ordinary segment. Note that I never
sent the RST: it is the stack answering a SYN-ACK it has no socket state for.

## A real DNS query against a local resolver

A DNS query is the best Scapy exercise there is: two layers you already know, one
you do not, and a real answer to check against. Run a real resolver in the same
container on an unprivileged port, so nothing fights over 53:

```bash
docker exec scapylab sh -c 'dnsmasq --no-daemon --port=5353 \
  --listen-address=127.0.0.1 --bind-interfaces --no-resolv --no-hosts \
  --address=/scapy.lab/127.0.0.1 \
  --txt-record=scapy.lab,"hello from a real dnsmasq in the lab container" \
  --log-queries'
```

Then build the query. `DNS()` is the message; `DNSQR()` is one question:

```python
q = IP(dst="127.0.0.1") / UDP(sport=41000, dport=5353) / DNS(
        id=0x4D3F, rd=1, qd=DNSQR(qname="scapy.lab", qtype="A"))
ans = sr1(q, iface="lo", timeout=3)

print(ans[DNS].rcode, ans[DNS].qr, [rr.rdata for rr in ans[DNS].an])
print(ans[UDP].sport, ans[UDP].dport)
```

```text
0 1 ['127.0.0.1']
5353 41000
```

Read that output carefully: `rcode = 0` is NOERROR, `qr = 1` marks a response
rather than a query, `an` holds the answer record with `rdata = 127.0.0.1`, and the
reply came **from** port 5353 **to** our port 41000 — the 5-tuple reversed, as it
should be. (Scapy prints `dport` as `mdns`, because 5353 is the mDNS port.)

`show()` on the response is the payoff — the counts the RFC describes are right
there as fields:

```text
###[ DNS ]###
  id        = 19775
  qr        = 1
  opcode    = QUERY
  aa        = 1
  tc        = 0
  rd        = 1
  ra        = 1
  z         = 0
  ad        = 0
  cd        = 0
  rcode     = ok
  qdcount   = 1
  ancount   = 1
  nscount   = 0
  arcount   = 0
  \qd        \
   |###[ DNS Question Record ]###
   |  qname     = b'scapy.lab.'
   |  qtype     = A
   |  qclass    = IN
  \an        \
   |###[ DNS Resource Record ]###
   |  rrname    = b'scapy.lab.'
   |  type      = A
   |  rclass    = IN
   |  ttl       = 0
   |  rdata     = 127.0.0.1
  \ns        \
  \ar        \
```

Change one word and you get a different kind of answer, which is how you learn to
*read* DNS failures instead of guessing. A TXT query against the same name returns
the string dnsmasq was configured with:

```text
TXT answer: [[b'hello from a real dnsmasq in the lab container']]
```

And a name the resolver has no zone and no upstream for:

```text
rcode: 5  ancount: 0
###[ DNS ]###
  qr        = 1
  rcode     = refused
  aa        = 0
  qdcount   = 1
  ancount   = 0
```

`rcode = 5` is REFUSED — dnsmasq saying "not mine, and I have nowhere to ask".
That is a different failure from NXDOMAIN ("I asked, it does not exist") and from
SERVFAIL ("I asked and the upstream broke"). Telling those three apart is half of
debugging DNS, and you can produce all of them locally in a minute.

## The honest boundaries: NET_RAW, your machines only, and why the internet isn't a lab

**Only your own machines.** Everything above targets `127.0.0.1` inside a container
I started and deleted. Loopback is the one destination where you cannot affect a
third party, because the packets never leave the netns. To practise with two hosts,
use two containers on a private bridge network you own, or a VM with a host-only
adapter.

**Raw sockets need `NET_RAW`.** A raw socket means the kernel stops putting its own
headers on your packet: you supply everything. On this host, as an ordinary user, a
plain `socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW)` raises
`PermissionError: [Errno 1] Operation not permitted` — and so does the same Python
inside a container started with `--cap-drop=ALL`. Docker's default capability set
already includes `NET_RAW`, so `--cap-add=NET_RAW` is belt and braces in a
container; on a bare host, or with capabilities dropped, it is the difference
between working and a traceback.

**`NET_RAW` is not a licence.** It lets you send arbitrary bytes; it does not make a
packet legitimate. Forging a source address, injecting a response into someone
else's connection, or scanning a network you do not control are not "advanced
Scapy" — they are unauthorised access. The test is boring: if you cannot name the
person or system you would need to ask, do not send the packet.

**Scapy does not do TCP for you.** Build a segment with the wrong sequence number
and the other end just RSTs you: the TCP state machine lives in the kernel, not in
your script.

**The internet isn't a lab.** One crafted packet at a random host is cheap to you
and visible to someone. It lands in a log, trips a rate limiter, and turns a fun
afternoon into an abuse report. Everything interesting here fits inside one
interface.

## What I take away

Building packets is a protocol education you cannot get from reading. `show()` tells
you what a header *means*, `hexdump()` tells you where it *is*, and `sniff()` tells
you what the kernel did about it. Once you have sent an ICMP echo you assembled
yourself and watched a real resolver answer a DNS query you assembled yourself, RFCs
stop being prose and start being field tables.

For the reverse direction — starting from bytes somebody else captured — see how to
[read a packet capture](/posts/reading-a-packet-capture/) and what is actually
inside the file in [writing a pcap parser in
Python](/posts/writing-a-pcap-parser/).
