---
title: "Writing a pcap parser in Python (and why you still want one)"
description: "A stdlib-only Python pcap parser you can read in one sitting: the global header and packet records, byte order and snaplen, when scapy or dpkt wins and when hand-parsing does, Ethernet → IPv4 → TCP 5-tuples, a pcapng primer, and streaming performance notes."
pubDate: 2026-11-07
lang: en
translationKey: writing-a-pcap-parser
tags: [networking, python]
featured: false
keywords:
  - pcap parser
  - Python pcap
  - scapy
  - packet analysis
  - pcapng
---

Packet analysis does not have to start with Wireshark. When I need one specific
answer across forty gigabytes of traffic on a box with no display, no root, and no
`scapy` in the interpreter, I write a **Python pcap parser** instead. It is about
eighty lines, it has zero dependencies, and it streams. This is that parser — and,
just as usefully, the point at which a **pcap parser** stops being the right tool
and you should reach for **scapy** or `dpkt` after all.

If you have read my notes on [reading a packet capture](/posts/reading-a-packet-capture/),
this is the layer underneath the GUI. When I am pulling apart somebody's traffic —
the same observe-first discipline as
[reverse-engineering a private HTTP API](/posts/reverse-engineering-a-private-api/) —
a hand parser is usually how I get the first real numbers.

## The pcap format: one global header, then a stream of records

Classic `pcap` is a 24-byte global header followed by zero or more packet records.
That is the entire format. The global header carries the magic number, major and
minor version, `thiszone`, `sigfigs`, `snaplen`, and the link-layer type. Two of
those fields do all the work.

**Byte order.** The magic number is `0xa1b2c3d4` stored in the writer's native
order. Read the first four bytes and you learn the endianness for free: if they
come back as `d4 c3 b2 a1`, the file is little-endian; `a1 b2 c3 d4` means
big-endian. A variant magic, `0xa1b23c4d`, means the timestamps are in nanoseconds
rather than microseconds. Get this wrong and every length you read is garbage, so
decode endianness first and thread it through every `struct` call.

**Snaplen** is the maximum number of bytes the capture tool promised to store per
packet. Each record has an `incl_len` (bytes actually present) and an `orig_len`
(the length on the wire before truncation). `incl_len` can never exceed `snaplen`,
and when you count bytes you must use `orig_len`, or every total you report will
underestimate the traffic. A record header is just four little integers:
`ts_sec`, `ts_usec`, `incl_len`, `orig_len`, followed by `incl_len` bytes of frame.

```python
import struct

# The four magics map to (endianness, timestamp resolution).
PCAP_MAGIC = {
    b"\xd4\xc3\xb2\xa1": ("<", "us"),  # little-endian, microseconds
    b"\xa1\xb2\xc3\xd4": (">", "us"),  # big-endian,    microseconds
    b"\x4d\x3c\xb2\xa1": ("<", "ns"),  # little-endian, nanoseconds
    b"\xa1\xb2\x3c\x4d": (">", "ns"),  # big-endian,    nanoseconds
}

GLOBAL_HDR = struct.Struct("IHHiIII")  # magic, vmaj, vmin, thiszone, sigfigs, snaplen, linktype
RECORD_HDR = struct.Struct("IIII")     # ts_sec, ts_usec, incl_len, orig_len
```

## A stdlib-only Python pcap parser

I lean on `struct.unpack_from` and `struct.iter_unpack` rather than hand-slicing
bytes, and I make the reader a generator so callers can stop early. The loop never
seeks, never knows the file size, and never holds more than one record at a time.

```python
def read_pcap(path):
    with open(path, "rb") as f:
        header = f.read(24)
        if len(header) < 24:
            raise ValueError("truncated pcap global header")

        endian = PCAP_MAGIC.get(header[:4])
        if endian is None:
            raise ValueError("not a classic pcap file (maybe pcapng?)")
        endian, _resolution = endian

        _, vmaj, vmin, _, _, snaplen, linktype = GLOBAL_HDR.unpack(endian + header)
        rec = struct.Struct(endian + "IIII")

        while True:
            raw = f.read(16)
            if len(raw) < 16:
                return  # clean EOF, or a truncated final record header
            ts_sec, ts_usec, incl_len, orig_len = rec.unpack(raw)
            frame = f.read(incl_len)
            if len(frame) < incl_len:
                return  # capture was cut mid-record
            yield linktype, snaplen, (ts_sec, ts_usec), orig_len, frame
```

Twelve lines of format and twenty of loop. That is the whole file format. Everything
hard about packet captures is above this layer, in the protocols.

## scapy and dpkt vs. parsing by hand

**scapy** is a language for packets, not a parser. It gives you `rdpcap()`, layers,
`.show()`, `.sprintf()` templates, and the ability to build and send replies. `dpkt`
is a thin, fast struct library — closer to what I have written above, but with every
protocol already decoded. Both are correct choices, and both are wrong for the same
reason: dependencies.

Use `scapy` when you are **exploring**. When you do not yet know what you are looking
for, when you want to type a one-liner and see fields, when you are building
packets, or when protocol coverage (VXLAN, SCTP, DNS-over-HTTPS, a hundred others)
saves you a week. Use `dpkt` when you want speed and a stable API and are happy to
add one C-accelerated dependency.

Parse by hand when the question is **narrow and the data is huge**. My rules:

- **Targeted extraction.** I want one field — the 5-tuple, a TCP flag, a TLS SNI —
  not a full protocol model. Pulling in `scapy` for that is a sledgehammer.
- **Huge files.** A hand parser streams a 40 GB capture in constant memory.
  Convenience wrappers that build a packet object per frame are what run out of RAM.
- **No dependencies.** A capture box, a container, a locked-down production host, a
  reviewer who must reproduce your numbers. `import struct` always works.
- **Correctness you can audit.** Eighty lines you fully understand beat a library
  you trust. When the numbers matter, I want to read every line that produced them.

The honest answer is that they compose: prototype the question in `scapy`, then
rewrite the hot path by hand once you know exactly which bytes you need.

## Packet analysis from raw bytes: Ethernet → IPv4 → TCP

A capture is link-layer frames. On Ethernet that is 14 bytes of header — destination
MAC, source MAC, and a 2-byte EtherType — and then the payload. `0x0800` is IPv4,
`0x86DD` is IPv6, and `0x8100` is an 802.1Q VLAN tag, which inserts four more bytes
and can stack. Skip VLAN tags before you assume IPv4, or you will silently drop
tagged traffic.

The IPv4 header is where a lot of naive parsers break. The first byte packs the
version in the high nibble and the header length (IHL) in the low nibble, *in 32-bit
words*, so the real header is `ihl * 4` bytes and is usually — but not always —
20. Options make it longer; ignoring IHL is the classic off-by-some-bytes bug that
turns ports into nonsense. `protocol` at offset 9 tells you the next layer: 6 is
TCP, 17 is UDP, 1 is ICMP.

```python
import socket

ETHERTYPE_IPV4, ETHERTYPE_VLAN = 0x0800, 0x8100

def parse_ethernet_ipv4(frame):
    # Returns (proto, src_ip, src_port, dst_ip, dst_port, l4_len) or None.
    if len(frame) < 14:
        return None
    _dst, _src, ethertype = struct.unpack_from("!6s6sH", frame, 0)
    off = 14
    while ethertype == ETHERTYPE_VLAN:            # 802.1Q, possibly stacked
        if len(frame) < off + 4:
            return None
        ethertype = struct.unpack_from("!H", frame, off + 2)[0]
        off += 4
    if ethertype != ETHERTYPE_IPV4 or len(frame) < off + 20:
        return None

    ver_ihl = frame[off]
    ihl = (ver_ihl & 0x0F) * 4
    if (ver_ihl >> 4) != 4 or ihl < 20 or len(frame) < off + ihl:
        return None

    proto = frame[off + 9]                        # 6 TCP, 17 UDP
    total_len = struct.unpack_from("!H", frame, off + 2)[0]
    src_ip = socket.inet_ntoa(frame[off + 12:off + 16])
    dst_ip = socket.inet_ntoa(frame[off + 16:off + 20])

    if proto not in (6, 17):                      # only TCP/UDP have ports
        return None
    l4 = off + ihl
    if len(frame) < l4 + 4:
        return None
    src_port, dst_port = struct.unpack_from("!HH", frame, l4)
    return proto, src_ip, src_port, dst_ip, dst_port, total_len
```

TCP is the easy part: ports are the first four bytes of the segment, and the data
offset lives in the high nibble of byte 12. But watch two traps. Fragmented IPv4
has no L4 header past the first fragment — check the fragment offset at offset 6–7
before you trust a "port" you just read. And `total_len` is the *IP* length, not the
frame length; for byte accounting, prefer the record's `orig_len`.

## Extracting the 5-tuple and byte counts

The **5-tuple** is protocol, source IP, source port, destination IP, destination
port. It is the key that identifies a flow, and almost every question I have about a
capture reduces to grouping on it. Once `parse_ethernet_ipv4` returns that plus the
length, the rest is `collections`.

```python
from collections import Counter, defaultdict

def flows(path, top=10):
    per_flow = defaultdict(int)
    for linktype, snaplen, ts, orig_len, frame in read_pcap(path):
        parsed = parse_ethernet_ipv4(frame)
        if parsed is None:
            continue  # IPv6, ARP, non-initial fragment, malformed
        proto, sip, sport, dip, dport, _ip_len = parsed
        per_flow[(proto, sip, sport, dip, dport)] += orig_len
    return Counter(per_flow).most_common(top)
```

That is a complete, dependency-free flow accounting tool. Note what it deliberately
does *not* do: reassemble TCP streams, handle IPv6, or decode application data. It
answers one question well, and it will do so on captures larger than your RAM.

## pcapng: blocks, not records

Modern `tcpdump -w` and Wireshark write **pcapng** by default, and it is a different
container. There is no global header and no flat record list. Instead the file is a
sequence of length-prefixed blocks: a 4-byte block type, a 4-byte total length, the
body, then the total length repeated as a trailer (so you can walk the file
backwards). The important block types are the Section Header Block (`0x0A0D0D0A`,
which carries its own byte-order magic), the Interface Description Block
(`0x00000001`, which carries the link type and snaplen per interface), the Enhanced
Packet Block (`0x00000006`), and the Simple Packet Block (`0x00000003`).

The practical consequences are small but fatal if ignored: link type is now
per-interface, so each packet references an interface id and you keep a table from
id to `linktype`; and packets can carry a timestamp with a per-interface resolution.
The good news is that pcapng is *easier* to stream, because every block is
self-describing.

```python
BLOCK_SECTION_HDR    = 0x0A0D0D0A
BLOCK_INTERFACE_DESC = 0x00000001
BLOCK_ENHANCED_PKT   = 0x00000006
BLOCK_SIMPLE_PKT     = 0x00000003

def iter_pcapng_blocks(f):
    """Yield (block_type, body) for every block in an open pcapng file."""
    while True:
        head = f.read(8)                    # type + total length
        if len(head) < 8:
            return                          # EOF
        btype, blen = struct.unpack("<II", head)
        if blen < 12:
            return                          # corrupt
        body = f.read(blen - 12)            # minus 8-byte head, 4-byte trailer
        f.read(4)                           # trailing length copy
        yield btype, body
```

Detect the format by the first four bytes: `0x0A0D0D0A` means pcapng, so the pcap
magic lookup above will cleanly reject it. A robust tool sniffs both and dispatches.

## A practical example: top talkers

The question I am asked most often is "who is using all the bandwidth". Group by the
6-tuple of addresses plus protocol, sum `orig_len`, and print the head:

```python
def top_talkers(path, limit=10, threshold_mb=1.0):
    bytes_by_pair = Counter()
    for _link, _snap, _ts, orig_len, frame in read_pcap(path):
        parsed = parse_ethernet_ipv4(frame)
        if parsed is None:
            continue
        proto, sip, _sp, dip, _dp, _ip_len = parsed
        bytes_by_pair[(sip, dip, proto)] += orig_len

    floor = threshold_mb * 1_000_000
    ranked = [(k, v) for k, v in bytes_by_pair.items() if v >= floor]
    ranked.sort(key=lambda kv: kv[1], reverse=True)
    for (sip, dip, proto), nbytes in ranked[:limit]:
        name = {6: "TCP", 17: "UDP"}.get(proto, str(proto))
        print(f"{sip:>15} -> {dip:<15} {name:<4} {nbytes / 1e6:9.2f} MB")
```

Swap the key to `(proto, sip, sport, dip, dport)` and a `defaultdict(int)` for
`Counter` and you get connections over a byte threshold instead — the same loop, a
different question. That reuse is the point: the parsing is done once, and every new
question is a different `dict` key.

## Performance notes: stream, never slurp

Everything above shares one property — it never holds the file in memory. Some
numbers from my own use, because they changed how I write these tools:

- **`struct.unpack_from` beats slicing.** Slicing a `bytes` object copies; unpacking
  at an offset does not. On a 10 million packet trace the difference is real.
- **Never `list(rdpcap(...))`.** This is the single most common way to OOM a capture
  box. Generate; consume one frame at a time.
- **Precompile `Struct` objects.** Building the format string per record is a hidden
  allocation in a hot loop. `struct.Struct` once, `unpack` many times.
- **Count bytes with `orig_len`, not `incl_len`.** Otherwise `snaplen` silently
  truncates your totals.
- **Filter early.** Check EtherType and protocol before you touch ports. Most frames
  in a real capture are not the thing you are looking for.
- **Add an index if you must seek.** If you need random access, a pre-pass that
  records `offset -> timestamp` in a small sidecar lets you jump without re-reading.

A pure-Python parser managed on the order of a few hundred thousand to a couple
million frames per second in my tests, faster with `memoryview` and `iter_unpack`
for the fixed-size headers. `dpkt` will beat you on raw throughput. That is fine —
you are not competing with it, you are refusing to depend on it.

Hand-writing a pcap parser is not the pragmatic default. `scapy` is. But there is a
large, boring, very real class of jobs — one question, enormous files, no dependencies
allowed — where eighty lines of `struct` you fully understand is the fastest correct
answer. Write it once, keep it, and reach for it the next time someone asks who is
eating the bandwidth.
