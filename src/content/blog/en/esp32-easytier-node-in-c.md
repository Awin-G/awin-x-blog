---
title: "Making an ESP32-C3 a real EasyTier node: the wire protocol, in C"
description: "ESPTier reimplements the EasyTier v2.6.4 wire protocol in plain C on an ESP32-C3 — TCP framing, SipHash-1-3 identity, AES-128-GCM, route sync and forwarding — so a constrained MCU becomes a real, pingable member of an overlay network."
pubDate: 2026-10-13
lang: en
translationKey: esp32-easytier-node-in-c
tags: [esp32, networking, embedded, c, easytier]
featured: true
keywords:
  - EasyTier ESP32
  - ESP32-C3 networking
  - embedded overlay network
  - EasyTier wire protocol
  - ESP-IDF C
---

Everything this blog runs on lives behind an overlay network: the Git forge, the
deploy box, the machines that build it. There is a [field report on that
pipeline](/posts/how-this-blog-ships-itself/) if you want the topology. What
interested me was the other end of the dial — how small a node can be and still
be a *first-class* member of that overlay. Not a device that tunnels IP over
something home-grown, but one that a stock EasyTier peer lists, pings, and
forwards traffic through.

ESPTier is my answer: a plain-C reimplementation of EasyTier's actual wire
protocol, running the same portable core on Linux and on an ESP32-C3. This is a
field report on what the wire protocol really demands, which parts of embedded
networking on an ESP32-C3 feel like cheating (in a good way) and which do not,
and where I deliberately stopped.

## Why embedded networking here means a real wire protocol, not a lookalike

The easy version of this project is to invent a small UDP protocol and call it
"an overlay". I have done that before, and it fails the only test that matters:
does a stock peer from the real project accept you as a neighbour? So the target
is frozen and unglamorous — **EasyTier v2.6.4**, commit
`8428a89d2dabc94c97d370ec607c6ca142473626`. Older 2.4.5 nodes are explicitly out
of scope; I would rather be honest about one supported version than vague about
several.

The shape of the code follows from a constraint: the protocol half must not know
which chip it is on. `components/etcore` is portable C11 with **no OS
dependencies** — no `socket`, no `time`, no `rand`, no `printf`. It reaches the
outside world through two narrow interfaces, `et_transport` (`connect / send /
recv / close`, a TCP byte stream) and `et_platform` (`et_now_ms / et_fill_random
/ et_log`). The *same source* compiles as a host static library under CMake and
as an ESP-IDF component under ESP-IDF v5.4. Linux gets POSIX sockets and a TUN
device; the ESP32-C3 gets lwIP sockets, `esp_timer`, `esp_random`, and
`ESP_LOG`.

That split is not architectural purity for its own sake. It means the protocol
behaviour is byte-identical on both targets, so a handshake bug reproduced in a
host unit test is the *same bug* on the device — and the host test runs in a
second, not after a flash cycle.

## The frame is the contract: EasyTier's TCP wire protocol byte for byte

Every message is one TCP frame:

```text
frame = [ u32 LE outer_len ][ PeerManagerHeader 16B ][ payload ]
```

No magic prefix. All multi-byte integers are little-endian, including protobuf
varints. The 16-byte `PeerManagerHeader` carries `from_peer_id` (u32),
`to_peer_id` (u32), `packet_type` (u8), `flags` (u8), `forward_counter` (u8),
`reserved` (u8), and `len` (u32).

The whole thing hinges on one invariant that is easy to get wrong: `outer_len`
counts *actual bytes on the wire*, while the header's `len` field is the
*plaintext* payload length. For unencrypted frames they line up; for encrypted
ones the wire length is `16 + plaintext + 28` because of the AEAD tail (more on
that below). When decoding, you slice the payload using the *real frame length*,
never `hdr.len`. A lying `len` is a memory-safety bug waiting to happen, and on
an MCU there is no MMU to catch you.

`len` is capped at 2000, so a frame is at most 2004 bytes — which sets the
static receive buffer size, and therefore a hard ceiling on how much RAM one
peer costs. `packet_type` values in play: `Data=1`, `HandShake=2`, `Ping=4`,
`Pong=5`, `RpcReq=8`, `RpcResp=9`. Flags include `ENCRYPTED=0x01`,
`LATENCY_FIRST=0x02`, `EXIT_NODE=0x04`, `NO_PROXY=0x08`, `COMPRESSED=0x10`,
`NOT_SEND_TO_TUN=0x40`.

## Handshake and the SipHash-1-3 identity

The handshake is deliberately simple and **unencrypted**. The dialing side sends
`HandshakeRequest` first: a `magic` constant (which the receiver does not even
validate), a runtime-random `my_peer_id`, `version=1`, the `network_name`, and a
`network_secret_digest` that **must be exactly 32 bytes**. The other side
replies with its own request. We only check `packet_type==2` and
`len(digest)==32`, then lift the peer's `peer_id` out of it.

The identity itself comes from SipHash-1-3 (`c=1, d=3`) with key `(0,0)`, which
is byte-for-byte the same thing as Rust's `DefaultHasher`. Writing
`network_name` then `network_secret` and folding `finish().to_be_bytes()` back
into the hasher yields a 32-byte digest; the same construction over just the
secret yields the 16-byte `key128` used for encryption. A subtle rule: `finish()`
does **not** consume or reset the state, so subsequent `write()` calls keep
accumulating. Get that wrong and your digest is plausible-looking and wrong,
which is the worst kind of wrong.

There is one behavioural detail worth calling out because it is where
"interoperable" becomes "correct": if the peer's returned digest does not match
ours, the connection goes to a **terminal dead state and never retries**. A bad
secret is not a transient failure; hammering a peer that rejected your key is
just rude.

## AES-128-GCM and the 28-byte tail

Payloads are encrypted with **AES-128-GCM** using a *network-wide* key derived
from the secret, not a per-session key. Only the payload is encrypted — the 16-byte
header stays in the clear. A random 12-byte nonce goes with it, the AAD is empty,
and the frame grows a tail of `tag(16) || nonce(12)`, tag first. The
`ENCRYPTED` flag is set to match.

Two things matter for a constrained target. First, the nonce comes from the
injected RNG callback; if RNG fails, we **refuse to emit the packet** rather than
degrade to a predictable nonce. Second, `HandShake`, `Ping`, and `Pong` are
never encrypted, while `Data`, `RpcReq`, and `RpcResp` always are. The AES-GCM
primitive is vendored and shared between host and device, so there is exactly one
implementation of the scary part.

## Route sync is what makes you pingable

A successful handshake gets you a live TCP connection and nothing else. To be
*addressable* you have to synchronise the route table, and this is where the real
EasyTier's assumptions bite.

Sync rides on the RPC layer as `OspfRouteRpc`, `method_index=1`, with
`domain_name` set to the network name. The envelope is a `RpcPacket`, carried as
an encrypted `RpcReq`/`RpcResp`. One landmine: `compression_info` must be
`None`, and you must not advertise `accepted_algo=Zstd` — if you do, the peer
will happily send you Zstd-compressed RPC bodies that you cannot decompress.
Advertising a capability you do not implement is a self-inflicted outage.

The request carries your `peer_id`, a stable `session_id`, and
`is_initiator=true`, plus a list of `RoutePeerInfo`. The critical constraint:
EasyTier resolves IP-to-peer *only through the route table*, and it **skips any
peer whose `version` is 0**. So unless you broadcast a `RoutePeerInfo` with
`version >= 1` for yourself, you simply cannot be pinged — there is no other
path. You also need to refresh within 90 seconds or the peer is aged out
(`REMOVE_UNREACHABLE_PEER_INFO_AFTER`). We advertise our own address as a
big-endian 4-byte integer (`10.9.9.9` becomes `0x0A090909`), a 24-bit prefix,
and an `easytier_version` string of `"2.6.4-esptier"` so it is obvious in the
peer list which node is the odd one out.

There is also a global adjacency matrix, `conn_bitmap`, a bit per (source,
destination) pair packed LSB-first. The rule that took a while to internalise:
you must broadcast the *whole known matrix*, not just your own row. Chained
topologies only converge if every node forwards its neighbours' rows.

## Forwarding: becoming a transit hop

Once routing works, relaying is mostly about *not* doing things. `to_peer_id` is
the **final** destination, not the next hop. `forward_counter` starts at 1 and is
incremented per hop, with frames dropped once it exceeds 7 — a cheap loop guard
for a network with no global topology view. A transit node does **not** decrypt
and re-encrypt: the payload is moved byte-for-byte, header fields untouched.

The next hop is the "reverse path" — the connection we learned the route on — not
a Dijkstra computation. That is a deliberate simplification that works for the
tree-ish topologies we target. And `HandShake`, `Ping`, and `Pong` are dropped by
a transit node entirely, because they are per-connection, not end-to-end. That
last rule is enforced by a quirk: EasyTier swaps only `packet_type` when
answering a `Ping` with a `Pong`, leaving `to_peer_id` pointed at the *peer's own*
id. Treat those three types at the connection layer, never in the forwarding
path, and everything lines up.

## From a host simulator to a real device: M0 to M6

I built this in numbered milestones, all merged on `master`, and each one is a
falsifiable claim:

- **M0** — repo skeleton, host build, ESP32-C3 skeleton that runs `idf.py build`,
  plus SipHash-1-3, protobuf primitives, and a golden-vector generator.
- **M1** — `PeerManagerHeader`/TCP framing, `HandshakeRequest`, and the peer
  state machine driven by a fake transport.
- **M2** — real handshake plus AES-128-GCM; the host simulator joins a real
  network and holds `UP` through Ping/Pong keepalive.
- **M3** — minimal `SyncRouteInfo` in both directions; we appear in
  `easytier-cli peer` and can be pinged by real nodes.
- **M4** — bare-IPv4 data plane: ICMP echo reply and UDP echo, round-tripping
  across nodes.
- **M5** — the ESP32-C3 joins real Wi-Fi and reproduces M3/M4 on hardware.
- **M6** — multiple direct peers, the global adjacency matrix, and destination
  based forwarding, so a real node routes *through* our transit node.

## Running it: host first, then the board

The host path needs no hardware and no privileges, and it is where I would start
if you want to see this work:

```bash
cmake -S . -B build && cmake --build build
scripts/testnet.sh up
build/apps/host_sim/host_sim --network-name et_test --network-secret et-test-secret \
  --peer 127.0.0.1:11110 --my-ipv4 10.9.9.9/24 --hostname nodeA
# in another shell:
easytier-cli -p 127.0.0.1:15988 peer
```

The `easytier-cli peer` output should show `10.9.9.9/24 nodeA` with
`version=2.6.4-esptier`. Note the port discipline: everything here is a *test*
port (listener `11110`, RPC `15988`). A production overlay may be listening on
`11010`/`15888` on the same box, and the scripts refuse to start rather than
stomp on it.

On the board, the same core compiles under ESP-IDF v5.4:

```bash
scripts/install_idf.sh
. ~/dev/tools/esp/esp-idf/export.sh
cd apps/esp32
idf.py set-target esp32c3
idf.py -p /dev/ttyACM0 flash monitor
```

The device is Wi-Fi **STA** and dials out to the peer host, so it needs a
2.4GHz AP (the ESP32-C3 is 2.4GHz-only) and the host firewall to admit the
inbound `11110/tcp`. A successful bring-up logs `WiFi connected, got IP ...`
followed by `peer <id> UP`. From there, `scripts/e2e_m5.sh` starts a real node,
flashes the board, captures the serial log with a bounded timeout, and asserts
both that the device appears in the real node's peer list and that UDP/ICMP
round-trips.

## What it costs on the chip, and what I chose not to do

The polling task runs on a **24KB** stack. That number is not arbitrary: the M6
sync path nests route-request encoding, the RPC envelope, and the `conn_bitmap`
scratch buffer underneath the peer TX frame buffer, and 16KB stopped being
enough. The core caps out at 4 direct peers, each with roughly a 4KB receive
buffer, and it does not grow memory at runtime. The current device firmware only
connects a single peer (slot 0); the multi-peer and forwarding work is validated
on the host, and the ESP32-C3 has no PSRAM to lean on for more.

I want to be equally clear about the edges. There is **no** NAT traversal, relay
discovery, or public-server discovery. Routing is reverse-path, not full
OSPF/Dijkstra. Secure mode, the Noise handshake, and credentials are not
implemented — only the legacy path. Non-TCP tunnels (UDP, WS, WG, QUIC), LAN
broadcast discovery, IPv6, compression, ACLs, exit nodes, and Magic DNS are all
absent, and 2.4.5 interop is out of scope. The dev host also has no `tcpdump`,
so transit in M4/M6 is demonstrated with the route table's `next_hop_ipv4` and
application-layer counters (`UDP_REPLY`/`ICMP_REPLY`) rather than byte-level
`.pcap` captures. If you need wire evidence, the RPC stream can be captured
through the project's framing proxy into a fixture — which is exactly how the
handshake and route encoders are tested.

That list is long, but it is the point. Making a constrained MCU a genuine
member of a real mesh VPN is not about reimplementing all of EasyTier; it is
about implementing the *interoperable subset* precisely, proving each claim with
a milestone, and knowing — and stating — where the subset ends. Which is the same
bargain [the rest of this stack](/posts/how-this-blog-ships-itself/) makes: pick
a small surface, automate it, and be honest about the boundary.
