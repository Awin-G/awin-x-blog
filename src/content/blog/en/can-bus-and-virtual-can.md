---
title: "CAN bus on Linux with vcan: embedded networking you can test without hardware"
description: "Set up a CAN bus on Linux with SocketCAN and a virtual vcan0 interface: real frames, real arbitration rules, candump, cansend, cansniffer, CAN-FD, and the path to real hardware."
pubDate: 2027-02-11
lang: en
translationKey: can-bus-and-virtual-can
tags: [embedded, networking]
featured: false
keywords:
  - CAN bus
  - SocketCAN
  - candump
  - vcan
  - arbitration
---

I learned the **CAN bus** by never touching one. Linux gives you a virtual CAN
interface one `ip link add` away, and the whole toolchain — SocketCAN plus
`candump`, `cansend` and friends — behaves exactly as it does on a car. That is how
I got from "CAN is the automotive thing" to reading frames, filtering them and
understanding arbitration, on a laptop with no transceiver and no ECU.

Every command and byte of output below came out of a throwaway container on my dev
box (`ubuntu:24.04`, `--cap-add=NET_ADMIN`, no `--privileged`). `can-utils` and
`iproute2` were not installed; I installed them inside the container, and they are
gone now that the container is. The one place where I used a model instead of a live
bus is labelled as such.

## What CAN is: a bus with no addresses

CAN (Controller Area Network) is a broadcast, multi-master bus for vehicles and
industrial control. Three properties of the specification matter more than the rest:

- **No addresses.** A frame has a message ID and up to eight bytes of payload, and
  every node on the bus receives it. There are no node IDs.
- **Message IDs carry priority.** IDs name the *message*, not the sender, and a
  lower ID means higher priority.
- **Access is CSMA/CR.** When two masters talk at once the contenders resolve it
  bitwise instead of destroying the frame. Nothing is lost and no retry timer is
  needed — the loser falls silent and retries after the current frame ends.

Physically it is a differential pair (CAN_H/CAN_L) carrying a dominant 0 and a
recessive 1, which is why it survives the electrical environment of a car. Classic
CAN runs at 500 kbit/s or 1 Mbit/s, and 120Ω terminators at both ends keep
reflections down.

## The frame: 11-bit and 29-bit IDs, DLC and data

There are two frame formats: CAN 2.0A ("standard") uses an 11-bit ID, 0x000–0x7FF,
and CAN 2.0B ("extended") uses 29 bits. Both carry a DLC (data length code, 0–8) and
up to eight bytes of payload, plus a remote-request variant that asks a node to send
a given ID.

Bring the virtual interface up and send one:

```text
$ ip link add dev vcan0 type vcan
$ ip link set up vcan0
$ ip -details link show vcan0
3: vcan0: <NOARP,UP,LOWER_UP> mtu 2060 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000
    link/can  promiscuity 0  allmulti 0 minmtu 0 maxmtu 0
    vcan addrgenmode eui64 numtxqueues 1 numrxqueues 1 gso_max_size 65536 gso_max_segs 65535 tso_max_size 65536 tso_max_segs 65535 gro_max_size 65536
```

The `link/can` is the tell: this is a SocketCAN interface, and everything you'd do
to a real `can0` works here. Now a standard frame, and an extended one:

```text
$ cansend vcan0 123#DEADBEEF
$ cansend vcan0 12345678#DEADBEEF
$ candump vcan0
  vcan0  12345678   [4]  DE AD BE EF
  vcan0       123   [4]  DE AD BE EF
```

`123#DEADBEEF` is an 11-bit ID `0x123`, DLC 4, payload `DE AD BE EF`.
`12345678#...` is a 29-bit ID. (`candump` right-aligns the ID, which is how you can
tell at a glance that one of them is extended.) A remote frame is a special case:

```text
$ cansend vcan0 123#R
$ candump vcan0
  vcan0  123   [0]  remote request
```

Send a handful in an order that is deliberately not sorted, and `candump -L` — the
log-file format on stdout — gives you the same frames with timestamps and the raw
wire representation, which is what you paste into a bug report:

```text
$ candump -L vcan0
(1791967959.294730) vcan0 456#01
(1791967959.295476) vcan0 123#02
(1791967959.296132) vcan0 7DF#03
(1791967959.296800) vcan0 000#04
```

## Why the ID is not an address

Because every node receives every frame, an ID is a *subject line*, not a
destination. A body controller that cares about door switches listens for `0x1A0`;
an engine controller that does not simply ignores it. This is what trips up people
coming from TCP/IP or Modbus: nothing routes your frame to a node, and the sender
does not know or care whether anyone is listening.

Filtering is where the bus stays cheap, and it happens in the controller (an
MCP2515 does it in hardware with masks and filters over two receive buffers), in the
kernel per socket, or in your process. The same receive filter as a few lines of C,
this one accepting only `0x123`:

```c
struct can_filter rfilter[1];
rfilter[0].can_id = 0x123;
rfilter[0].can_mask = CAN_SFF_MASK;   /* all 11 bits must match */
setsockopt(s, SOL_CAN_RAW, CAN_RAW_FILTER, rfilter, sizeof(rfilter));
```

Frames `456`, `123`, `7DF`, `456`, `123` were sent while that program was blocked in
`read()`, and it woke on exactly one of them:

```text
received can_id=0x123 can_dlc=3 data=C0 FF EE
```

`candump` has the same ability on the command line, which is the quick way to
narrow a busy bus to one message:

```text
$ candump vcan0,123:7FF
  vcan0  123   [1]  AB
  vcan0  123   [1]  CD
```

`123:7FF` means "accept ID 0x123, mask the entire 11-bit ID field". The `456` and
`7DF` frames that were sent at the same time never appear.

<figure>
<svg viewBox="0 0 640 268" width="100%" role="img" aria-label="Two nodes arbitrate. Node A sends ID 0x456, node B sends 0x123. Their IDs differ in the very first, most significant bit: A writes a recessive 1, B a dominant 0, so A goes silent and 0x123 gets the bus. A retries after the current frame ends.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="46" y="150" width="180" height="54" rx="8"/>
    <rect x="414" y="150" width="180" height="54" rx="8"/>
    <line x1="136" y1="204" x2="136" y2="244" stroke-dasharray="5 4"/>
    <line x1="504" y1="204" x2="504" y2="244"/>
    <line x1="70" y1="247" x2="570" y2="247" stroke-width="6" opacity="0.35"/>
    <path d="M136 244 l0 0" />
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="136" y="182">node A</text>
    <text x="504" y="182">node B</text>
    <text x="320" y="46">first differing bit: dominant 0 beats recessive 1</text>
    <text x="136" y="132" opacity="0.85">0x456</text>
    <text x="504" y="132" opacity="0.85">0x123</text>
  </g>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="15" text-anchor="middle">
    <text x="136" y="112" fill="currentColor">10001010110</text>
    <text x="504" y="112" fill="currentColor">00100100011</text>
  </g>
  <g stroke="#0f766e" stroke-width="2">
    <line x1="106" y1="118" x2="122" y2="118"/>
    <line x1="474" y1="118" x2="490" y2="118"/>
    <line x1="106" y1="140" x2="122" y2="140"/>
    <line x1="474" y1="140" x2="490" y2="140"/>
    <line x1="106" y1="118" x2="106" y2="140"/>
    <line x1="122" y1="118" x2="122" y2="140"/>
    <line x1="474" y1="118" x2="474" y2="140"/>
    <line x1="490" y1="118" x2="490" y2="140"/>
  </g>
  <g fill="#0f766e" font-family="system-ui, sans-serif" font-size="12" text-anchor="middle">
    <text x="136" y="264">stops transmitting, retries after this frame</text>
    <text x="504" y="264">wins the bus, frame continues</text>
    <text x="320" y="140" opacity="0.9">0x123 leaves the bus as the winning frame</text>
  </g>
</svg>
<figcaption>Arbitration is decided one bit at a time, most significant first. A node writing a recessive 1 while another writes a dominant 0 sees the mismatch and gives up immediately — so the lower ID wins by construction, and the loser's frame is retried a moment later. Because arbitration is non-destructive, no bandwidth is lost to collisions.</figcaption>
</figure>

## Arbitration: why a lower ID wins

CSMA/CR works like this. Everybody listens before and while transmitting (carrier
sense). The ID field goes out most-significant bit first. A node that writes a 1 but
reads back a 0 detects that someone else is writing the more important bit, stops
transmitting, and waits for the next idle. The first bit at which two IDs differ
decides.

Two senders on my `vcan0`, hammering `456#01` and `123#02` at the same instant,
look like this in the dump — and the counts afterwards are the giveaway:

```text
$ grep -c '456#01' /tmp/arbitration.log
6591
$ grep -c '123#02' /tmp/arbitration.log
6597
$ head -4 /tmp/arbitration.log
(1791967965.300812) vcan0 456#01
(1791967965.300898) vcan0 123#02
(1791967965.301452) vcan0 456#01
(1791967965.301610) vcan0 123#02
```

And here is the honest part: **vcan does not arbitrate.** There is no physical bus,
no dominant and recessive levels, so there is nothing to resolve — the kernel hands
frames to the interface's transmit queue in the order they arrive, which is why the
two IDs interleave roughly evenly instead of `0x123` starving `0x456`. To see the
rule itself, I wrote the bus's decision procedure down in sixty lines of C (a model,
not a capture):

```text
$ ./arb 456 123
  A id=0x456  10001010110
  B id=0x123  00100100011

  at bit 10: A sends 1, B sends 0 -> B drives dominant, A loses
  loser goes silent and retries after the current frame ends
  => the frame now on the bus is id=0x123

$ ./arb 7DF 1A0
  at bit 10: A sends 1, B sends 0 -> B drives dominant, A loses
  => the frame now on the bus is id=0x1A0
```

That is the whole of CAN's quality of service: the lowest ID always gets through. A
node that spams a low ID can starve everyone else — a real and common bus failure.
High-rate messages get low IDs, and past roughly 60–70% bus load you get latency
spikes rather than dropped frames. An ID is not a name; it is a ticket into the bus
queue, so choose it deliberately.

## vcan: the same bus with no wires

`vcan` is a virtual CAN bus in the kernel: frames you transmit are delivered to the
same interface's receive queue immediately, and nowhere else. Nothing is lost,
acked, errored or arbitrated — and that is what makes it useful. You get the real
SocketCAN ABI, the real frame parsing, the real `can-utils`, and none of the
physics. My whole test rig was this:

```text
$ docker run -d --name vcan-lab --cap-add=NET_ADMIN ubuntu:24.04 sleep 1200
$ docker exec vcan-lab apt-get install -y iproute2 can-utils
$ docker exec vcan-lab ip link add dev vcan0 type vcan
$ docker exec vcan-lab ip link set up vcan0
```

Gone the moment the container exits. It is the right environment for developing a
decoder, replaying a log from a field service call (`canplayer`), running a CI test
against a mock ECU, or teaching a workshop where the budget for transceivers is
zero.

## The tools: candump, cansend, cansniffer and friends

`can-utils` is small enough to know completely. `candump` reads the bus (`-L` adds
timestamps, `<id>,<id>:<mask>` filters), `cansend` writes it, and `cansniffer` gives
you a live per-ID view — one line per message, sorted by ID, with frames-per-window
counters, which is how you find the ID you want on an unknown bus (I stripped the
terminal escape sequences so it survives pasting). `cangen`, `canplayer` and the
`cangw` gateway complete the set; the gateway forwards frames between interfaces,
which is how you stitch a test rig out of two `vcan` interfaces and a real adapter.

```text
$ cansniffer vcan0
00001 | 123 | DE AD BE EF             ....
00001 | 1A0 | 01 02 03 04 05 06 07 08 ........
00001 | 456 | CA FE                   ..
```

For how busy the bus is, `canbusload` estimates bits-on-the-wire against the nominal
bitrate — 27% of a hypothetical 500 kbit/s `vcan0` while the sender loop was
running. The columns are received frames, used bits in total, and used bits for
payload; you must pass the bitrate, because a virtual interface does not have one.

```text
$ canbusload vcan0@500000
 vcan0@500000  1430  135850  45760      0  27%
```

The interface's own counters are plain link statistics, identical in shape to
`eth0`:

```text
$ ip -s link show vcan0
    RX:  bytes packets errors dropped  missed   mcast
         32004   17795      0       0       0       0
    TX:  bytes packets errors dropped carrier collsns
         32004   17795      0       0       0       0
```

## CAN-FD: same socket, bigger payload

CAN-FD (Flexible Data rate) keeps the arbitration phase at the classic speed, runs
the data phase faster, and raises the payload from 8 to 64 bytes. Remote frames are
gone and the DLC now denotes length directly. For anything that speaks ISO-TP — UDS,
OBD-II requests bigger than 7 bytes — one FD frame replaces a multi-frame burst,
which matters more than the extra bitrate.

On Linux CAN-FD is the same SocketCAN stack; the interface is simply declared
FD-capable, and the `vcan0` above is not:

```text
$ cansend vcan0 123##1DEADBEEF
CAN interface is not CAN FD capable - sorry.
```

The check is the interface MTU: CAN-FD frames need `CANFD_MTU` (72) rather than
`CAN_MTU` (16). Set it on a down interface and the same frame goes out:

```text
$ ip link set vcan0 down
$ ip link set vcan0 mtu 72
$ ip link set vcan0 up
$ cansend vcan0 123##1DEADBEEF
$ cansend vcan0 12345678##0DEADBEEFCAFEBABE1122334455667788
$ cansend vcan0 456#0102030405
$ candump vcan0
  vcan0  123  [04]  DE AD BE EF
  vcan0  12345678  [16]  DE AD BE EF CA FE BA BE 11 22 33 44 55 66 77 88
  vcan0       456   [5]  01 02 03 04 05
```

A 16-byte payload is impossible in classic CAN, and the classic 3-hex-digit and
extended 8-hex-digit IDs are unchanged: FD is a framing upgrade, not a new network.
On real hardware, capability comes from the controller (an MCP2517 or MCP2518
rather than an MCP2515) and the driver's bit timing, not from an MTU set by hand.

## From vcan0 to a real can0

A real bus is three additions: a chip that speaks the protocol, a transceiver that
drives the differential pair, and termination. After the hardware is wired, the
Linux side is unremarkable:

```text
$ ip link set can0 type can bitrate 500000
$ ip link set up can0
$ candump can0
```

`can0` comes from a driver — `mcp251x` for an MCP2515 off SPI, `peak_usb` for a PCAN
dongle, a built-in controller on a board — and from that moment your code does not
know or care which one it talks to. `ip -details link show can0` then shows the real
bitrate, sample point and controller mode, which `vcan0` does not have.

For an ESP32 the cheap end of the spectrum already has the peripheral: the ESP32,
S3 and C3 include a TWAI controller (CAN 2.0B) in silicon, exposed in ESP-IDF as
`twai_driver_install`, `twai_start` and `twai_message_t` — wire a transceiver such as
an SN65HVD230 to two pins and you have a real node. An MCP2515 over SPI works too,
at the cost of extra pins, an IRQ line, and driver code where the TWAI needs none.
Same trade as on the [EasyTier node](/posts/esp32-easytier-node-in-c/): the protocol
logic is portable, the transport underneath decides how much of your budget the
hardware takes. And if you need to reverse whatever is already on the wire, the
method from [the serial-protocol post](/posts/decoding-a-serial-protocol/) applies
verbatim, only with `candump` where a logic analyzer channel used to be.

Two cautions. Put 120Ω at each end of the real bus and only there — two terminators
per bus, not one per node. And do not "test" on a vehicle you do not own;
everything above ran on a virtual interface inside a container that existed for
twenty minutes and is now gone.
