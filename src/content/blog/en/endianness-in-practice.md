---
title: "Endianness in practice: why the bytes come out backwards"
description: "Byte order explained with real programs: dumping a 32-bit integer on x86, htonl and network byte order, the raw-struct-over-a-socket bug, Modbus registers, and how to detect and byte-swap endianness."
pubDate: 2027-02-13
lang: en
translationKey: endianness-in-practice
tags: [embedded, c]
featured: false
keywords:
  - endianness
  - little vs big endian
  - htonl
  - network byte order
  - byte swap
---

You write `uint32_t t = 1000000;` in your firmware, you send it over UART, and
the other side prints `1078071040`. Nothing is corrupt. Nothing is lost. You have
just been introduced to **endianness**: the order in which the bytes of a
multi-byte value sit in memory, and it is the same argument that makes `htonl`
exist at all. This is the whole subject, with real output from real programs on
an x86_64 box — no hand-waving about "it depends on the platform".

Everything below is real. The C programs were compiled with `gcc 16.2.1` and run
on this x86_64 Linux box; the Python programs were run under Python 3.14. I dumped
the bytes rather than asserting what they should be, because that is the only way
this lesson sticks.

## Little vs big endian: what endianness actually is

A 32-bit value has four bytes. Endianness answers one question: when you store
that value at address `A`, which byte goes at `A`?

- **Little endian** — the *least* significant byte goes first. `0x11223344`
  becomes `44 33 22 11`. Used by x86, x86-64, and modern ARM.
- **Big endian** — the *most* significant byte goes first. `0x11223344`
  becomes `11 22 33 44`. Used by the network stack (that is why it is called
  **network byte order**), by Modbus, by many older MCUs, and by a lot of
  peripherals where the datasheet simply says "MSB first".

Two machines can agree on every type, every size, every alignment and still
disagree on the bytes. That is the entire problem.

Who uses which, in practice: x86 and x86-64 are little endian, always. ARM in its
common configuration (Cortex-M, Cortex-A, Apple silicon) is little endian by
default but the architecture is bi-endian — some toolchains can build either.
PowerPC and Motorola/Freescale parts are usually big endian. RISC-V is little
endian in every mainstream implementation. MIPS is famous for existing in both
flavours with the *same* chip model numbers, which is why cross-compiling for
MIPS is a rite of passage in embedded. The network stack is big endian
everywhere, which is where `htonl` and the name "network byte order" come from.

<figure>
<svg viewBox="0 0 640 176" width="640" height="176" role="img" aria-label="The 32-bit value 0x11223344 stored little-endian as 44 33 22 11 and big-endian as 11 22 33 44, with byte addresses 0 to 3" style="max-width:100%;height:auto">
  <style>
    .hd { font: 600 13px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; }
    .bx { fill: none; stroke: #0f766e; stroke-width: 1.5; }
    .by { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; text-anchor: middle; }
    .ad { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; text-anchor: middle; opacity: .55; }
    .lb { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #0f766e; }
    .sub { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; opacity: .55; }
  </style>
  <text class="hd" x="0" y="14">value 0x11223344 in memory</text>
  <text class="lb" x="0" y="47">little endian</text>
  <text class="sub" x="0" y="61">x86, x86-64, ARM</text>
  <g>
    <rect class="bx" x="150" y="26" width="48" height="32" rx="3"/>
    <rect class="bx" x="202" y="26" width="48" height="32" rx="3"/>
    <rect class="bx" x="254" y="26" width="48" height="32" rx="3"/>
    <rect class="bx" x="306" y="26" width="48" height="32" rx="3"/>
    <text class="by" x="174" y="47">44</text>
    <text class="by" x="226" y="47">33</text>
    <text class="by" x="278" y="47">22</text>
    <text class="by" x="330" y="47">11</text>
    <text class="ad" x="174" y="72">+0</text>
    <text class="ad" x="226" y="72">+1</text>
    <text class="ad" x="278" y="72">+2</text>
    <text class="ad" x="330" y="72">+3</text>
  </g>
  <text class="lb" x="0" y="128">big endian</text>
  <text class="sub" x="0" y="142">network, Modbus, many MCUs</text>
  <g>
    <rect class="bx" x="150" y="108" width="48" height="32" rx="3"/>
    <rect class="bx" x="202" y="108" width="48" height="32" rx="3"/>
    <rect class="bx" x="254" y="108" width="48" height="32" rx="3"/>
    <rect class="bx" x="306" y="108" width="48" height="32" rx="3"/>
    <text class="by" x="174" y="129">11</text>
    <text class="by" x="226" y="129">22</text>
    <text class="by" x="278" y="129">33</text>
    <text class="by" x="330" y="129">44</text>
    <text class="ad" x="174" y="154">+0</text>
    <text class="ad" x="226" y="154">+1</text>
    <text class="ad" x="278" y="154">+2</text>
    <text class="ad" x="330" y="154">+3</text>
  </g>
</svg>
<figcaption>FIG. 1 — One value, two byte orders. The same four bytes mean two
different numbers depending on which end you read them from.</figcaption>
</figure>

### Byte order is not bit order

A related confusion, because both get called "that endianness thing". Byte order
is about *which byte* of a multi-byte value comes first. **Bit order** is about
which bit of a *single* byte goes out first on the wire — an asynchronous UART is
LSB-first, whereas SPI, I2C and Modbus are MSB-first. They are independent: a
UART can send a big-endian 16-bit value, LSB-first within each byte. When I am
reverse-engineering an unknown bus I keep the two questions separate: which bit
leaves first, and which byte leaves first.

## How to SEE it: dump the bytes

Stop reasoning about endianness and start printing it. The trick is to look at
the object through an `unsigned char *`, which is the only pointer type the
standard guarantees to alias everything.

```c
#include <stdint.h>
#include <stdio.h>
#include <arpa/inet.h>

int main(void) {
    uint32_t v = 0x11223344u;
    unsigned char *p = (unsigned char *)&v;
    printf("bytes at increasing addresses: ");
    for (size_t i = 0; i < sizeof v; i++) printf("%02x ", p[i]);
    printf("\n");
    printf("htonl(0x11223344) bytes:      ");
    uint32_t n = htonl(v);
    unsigned char *q = (unsigned char *)&n;
    for (size_t i = 0; i < sizeof n; i++) printf("%02x ", q[i]);
    printf("\n");
    return 0;
}
```

```
$ gcc -O2 -o dump dump.c && ./dump
bytes at increasing addresses: 44 33 22 11
htonl(0x11223344) bytes:      11 22 33 44
```

The least significant byte, `0x44`, sits at the *lowest address*. That is a
little-endian host, which is what x86 gives you. And `htonl` handed me the
reversed bytes, which is what a big-endian peer expects.

In Python the same information is one attribute away, which makes it the fastest
place to check when a script disagrees with a device:

```
$ python3 -c "import sys; print(sys.byteorder)"
little
```

`xxd` says the same thing about anything on disk. A Python program writing the
value `0xA1B2C3D4` twice:

```python
import struct
open("le.bin", "wb").write(struct.pack("<Ii", 0xA1B2C3D4, 305419896))
open("be.bin", "wb").write(struct.pack(">Ii", 0xA1B2C3D4, 305419896))
```

```
$ xxd le.bin
00000000: d4c3 b2a1 7856 3412                      ....xV4.
$ xxd be.bin
00000000: a1b2 c3d4 1234 5678                      .....4Vx.
$ file le.bin be.bin
le.bin: pcap capture file, microsecond ts (little-endian) - version 22136.4660
be.bin: pcap capture file, microseconds ts (big-endian) - version 4660.22136
```

`44 33 22 11` versus `11 22 33 44` is the whole article. Note the bonus: `file`
recognised my throwaway file as a pcap, purely from that magic number, and told
me the byte order. Byte-order sniffing is exactly how [my pcap parser](/posts/writing-a-pcap-parser/)
decides how to read a capture written by somebody else's machine.

## Network byte order and what htonl really does

`htons` (host to network short) and `htonl` (host to network long) convert from
whatever order your CPU uses into big-endian. A slightly longer variant of the
program above, which also prints the network-order and byte-swapped forms:

```
$ ./bytes
uint32 0x11223344:          44 33 22 11
htonl(0x11223344):          11 22 33 44

endianness:                 little

htonl(1) =                  16777216
__builtin_bswap32(v) =      1144201745

union { u32 i; u8 c[4]; }: c[0] = 1 -> little endian
```

Two things to take from that.

**`htonl(1)` is 16777216 here.** That is the portable endianness test: on a
big-endian host it would be `1`, on a little-endian host it is `1 << 24`. If you
need to know the byte order at runtime, this is a one-liner that works
everywhere and needs no `configure`.

**`htons` and `htonl` are not byte swaps.** They are *host-to-network*
conversions, and on a big-endian host they are complete no-ops. That is not a
detail — it is the reason a `htons` unit test is nearly worthless:

```c
uint16_t v = 0x1234;
assert(htons(v) == 0x3412);   /* passes on x86, fails nowhere-yet */
```

That assertion only proves you are on a little-endian machine. It is a real
gotcha for tests: a test suite written on x86 and run later on a big-endian CI
runner will start failing on an assertion that was never testing the protocol in
the first place. Assert on the *bytes you actually put on the wire*, not on the
return value of `htons`.

The reason the conversion exists is that the Internet engineers chose a byte
order and stuck to it, and BSD sockets follow that choice all the way down:
`struct sockaddr_in`'s `sin_port` and `sin_addr` are in network byte order, which
is why you pass `htons(8080)` to `bind()` and never `8080` directly. Everything
above the socket is your own business, so if your protocol goes over TCP you have
one boundary to convert at and one place to get it right.

The reverse conversions `ntohs`/`ntohl` are the same functions in the other
direction, and they round-trip: `ntohl(htonl(x)) == x` on every platform.

## The classic bug: sending a raw struct over a socket

This is where endianness stops being trivia. It is tempting: `write(fd, &msg,
sizeof msg)` takes four seconds to write. Here is what it actually puts on the
wire.

```c
#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/wait.h>

struct reading {            /* 1 + 4 + 2 = 7 bytes of fields */
    uint8_t  id;
    uint32_t t;             /* milliseconds */
    uint16_t value;
};

static void show(const char *label, const void *b, size_t n) {
    printf("%-26s", label);
    for (size_t i = 0; i < n; i++) printf("%02x ", ((const unsigned char *)b)[i]);
    printf("\n");
}

int main(void) {
    struct reading r = { .id = 7, .t = 1000000u, .value = 0x1122 };
    unsigned char dirty[sizeof r];

    memset(dirty, 0xAA, sizeof dirty);      /* pretend stack garbage */
    memcpy(dirty, &r, sizeof r);
    show("we send (12 bytes):", dirty, sizeof r);

    int sv[2];                             /* child = the peer */
    socketpair(AF_UNIX, SOCK_STREAM, 0, sv);
    if (fork() == 0) { close(sv[0]); write(sv[1], dirty, sizeof r); _exit(0); }

    unsigned char got[64];                 /* parent = the receiver */
    ssize_t n = read(sv[0], got, sizeof got);
    wait(NULL);
    show("peer reads (12 bytes):", got, n);

    struct reading back;
    memcpy(&back, got, sizeof back);
    printf("receiver decodes: id=%u t=%u value=0x%04x\n",
           back.id, back.t, back.value);

    /* the same data from a big-endian MCU: 7 bytes, no padding */
    unsigned char be[7] = { r.id, 0x00, 0x0f, 0x42, 0x40, 0x11, 0x22 };
    show("MCU sends (7 bytes):", be, sizeof be);
    uint32_t wrong, right;
    memcpy(&wrong, be + 1, 4);             /* host order -- a lie */
    right = ((uint32_t)be[1] << 24) | ((uint32_t)be[2] << 16)
          | ((uint32_t)be[3] << 8) | (uint32_t)be[4];
    printf("t as host uint32: %u   t big endian: %u   ratio %.0f\n",
           wrong, right, (double)wrong / right);
    return 0;
}
```

```
$ gcc -O2 -Wall -Wextra -o wirebug wirebug.c && ./wirebug
we send (12 bytes):       07 aa aa aa 40 42 0f 00 22 11 aa aa
peer reads (12 bytes):    07 aa aa aa 40 42 0f 00 22 11 aa aa
receiver decodes: id=7 t=1000000 value=0x1122
MCU sends (7 bytes):      07 00 0f 42 40 11 22
t as host uint32: 1078071040   t big endian: 1000000   ratio 1078
```

Read the output, because it contains three separate bugs.

**Padding.** `sizeof(struct reading)` is 12, not 7 — `offsetof(t)` is 4 and
`offsetof(value)` is 8, so the compiler filled the gaps. The `aa aa aa` between
`id` and `t` are those padding bytes, which I forced to `0xAA` to make them
visible; in real code they are whatever happened to be on the stack. You just sent
uninitialised stack memory to a peer — that is also how you leak data you did not
mean to send.

**Endianness.** `t` goes out as `40 42 0f 00`. Look at what a Modbus-style MCU
sends for the same value: `00 0f 42 40`. Reading *those* bytes as a host
`uint32_t` gives `1078071040` instead of `1000000` — off by a factor of 1078.
The direction is symmetric: the MCU reads my `40 42 0f 00` as `1078071040` too.

**Length.** Same struct, 12 bytes versus 7. A protocol that says "12 bytes" and a
peer that sends 7 never even get to argue about the numbers.

The cruel part is the first three lines: the round trip through a real
`socketpair()` works perfectly. Both processes on x86, same struct definition,
same compiler — the bug is invisible until one end moves.

## Detecting endianness, and byte-swapping

You rarely need to detect it. The compiler already knows. `__BYTE_ORDER__` is
available at compile time on GCC and Clang:

```c
#if __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
    /* big endian */
#endif
```

A runtime version via a union is legal, fast, and — at `-O2` — folded away
entirely. `objdump` on the binary I compiled shows `host_is_big_endian()` inlined
and reduced to an immediate `0`; the function does not exist in the binary at
all. And the `htonl(1)` trick above gives you the answer with no headers.

The one place you genuinely need to detect it is reading a *file or a frame that
carries its own order*, and the idiomatic way is to read a known magic value and
check which way round it is. If you read the four bytes `a1 b2 c3 d4` you are
looking at a big-endian source; if you read `d4 c3 b2 a1` it was little endian.
That single test decides how you read the rest of the file, which is exactly what
pcap, and every other self-describing binary format, does.

For explicit **byte swap** work, use `__builtin_bswap32` / `__builtin_bswap16`
(and `__builtin_bswap64` if you need it). I checked what gcc 16 actually emits
for a non-constant input — one instruction, no loop:

```
$ gcc -O2 -std=c11 -o swap swap.c && ./swap
bswap32(0x11223344) = 0x44332211
bswap16(0x1234)     = 0x3412
$ objdump -d swap --no-show-raw-insn | sed -n '/<sw>:/,/^$/p'
    1190:	mov    %edi,%eax
    1192:	bswap  %eax
    1194:	ret
```

Pure Python's equivalent is a slice reversal: `x.to_bytes(4, "big")[::-1]`.

## Where it bites in embedded

**A sensor register.** Many ADC and IMU chips stream multi-byte samples MSB
first. A 3-byte register reading `7f 12 34`:

```python
raw = bytes([0x7F, 0x12, 0x34])
raw.hex(" "), int.from_bytes(raw, "big"), int.from_bytes(raw, "little")
```

```
'7f 12 34' 8327732 3412735
```

Correct answer, per the datasheet: 8327732. The little-endian reading is 3412735
— off by a factor of about 2.4. Sign makes it worse: the same bytes read as
signed big-endian give `-60876`, while an unsigned little-endian read gives
`3412735`. When a value that should be negative comes out huge and positive,
suspect byte order first.

**Modbus.** Every field in a Modbus frame is big-endian, without exception, and
there is no flag to say so. Registers 1000, 258 and 48879 look like this:

```python
regs = [1000, 258, 0xBEEF]
wire = b"".join(struct.pack(">H", r) for r in regs)
for r in regs:
    onwire = struct.pack(">H", r)
    print("reg 0x%04x: big-endian read %6d | little-endian read %6d"
          % (r, struct.unpack(">H", onwire)[0], struct.unpack("<H", onwire)[0]))
```

```
reg 0x03e8: big-endian read   1000 | little-endian read  59395
reg 0x0102: big-endian read    258 | little-endian read    513
reg 0xbeef: big-endian read  48879 | little-endian read  61374
```

If you have been reverse-engineering an unknown device, the same logic is your
friend: my walkthrough on [decoding a serial protocol](/posts/decoding-a-serial-protocol/)
— capture the bytes, form a hypothesis about their meaning, test it — is exactly
the method for working out which byte order an undocumented device uses. Try both
and see which one gives values that change plausibly when the physical input
changes.

**File formats.** pcap sniffs its own magic (shown above). PNG is big-endian.
BMP is little-endian. WAV chunks are little-endian. PostScript and JPEG are
big-endian. The format tells you; you just have to read that part of the spec.

**File formats on an MCU.** SPI flash parts typically stream big-endian in their
command protocol but little-endian — or vendor-specific — in their JEDEC ID and
SFDP tables. If a flash chip returns an ID that is a byte-swapped version of what
the datasheet shows, this is why.

## The rule: define the wire format, convert at the boundary

The lesson from the struct bug is not "endianness is hard". It is that a struct
is not a serialisation format. A struct describes *your* compiler's layout
decisions: padding, alignment, field order, and byte order. None of those are
part of your protocol unless you write them down.

So write it down, and then write the codec once. Here is the same `struct
reading` done properly — an explicit nine-byte frame, every field's offset,
width and byte order stated in a comment, and `static_assert` on the layout so a
compiler change cannot silently move a field:

```c
struct reading {            /* 1 + 4 + 2 = 7 bytes of fields */
    uint8_t  id;
    uint32_t t;             /* milliseconds */
    uint16_t value;
};
static_assert(offsetof(struct reading, id)    == 0, "id at 0");
static_assert(offsetof(struct reading, t)     == 4, "t at 4");
static_assert(offsetof(struct reading, value) == 8, "value at 8");

static void put_u16(unsigned char *b, uint16_t v) { b[0] = v >> 8; b[1] = v; }
static void put_u32(unsigned char *b, uint32_t v) {
    b[0] = v >> 24; b[1] = v >> 16; b[2] = v >> 8; b[3] = v;
}
static void put_reading(unsigned char *b, struct reading r) {
    b[0] = r.id;
    put_u32(b + 1, r.t);      /* offset 1, 4 bytes, big endian */
    put_u16(b + 5, r.value);  /* offset 5, 2 bytes, big endian */
    b[7] = 0;                 /* reserved */
    b[8] = 0;
}
```

```
$ gcc -O2 -std=c11 -o codec codec.c && ./codec
sizeof(struct reading) = 12, sizeof(frame) = 9
frame on the wire:      07 00 0f 42 40 11 22 00 00
decoded back:           id=7 t=1000000 value=0x1122
```

The frame is nine bytes, always nine bytes, on any host, with no padding and no
host byte order in it. The cost is about five lines per field, which is the
cheapest insurance in embedded work.

What I do instead of `memcpy`ing structs:

1. **Write the wire format down explicitly** — byte offsets, widths, and byte
   order for every field. "u16 big endian at offset 4" is a specification;
   "send the struct" is not.
2. **Serialise field by field at the boundary** — `put_u32(buf + 4, v)`, or
   `struct.pack(">Iih", …)`, or a codec with a schema. One place converts,
   everywhere else works in host types.
3. **Never send a raw struct across a process, machine, or architecture
   boundary.** Not over a socket, not into a file, not into shared memory.
4. **Test against bytes, not values** — assert the frame is `00 0f 42 40`, which
   is a statement about the protocol. `assert(htons(x) == …)` is a statement
   about your laptop.
5. **Reserve bytes, do not let the compiler insert them.** Packing the struct
   (`__attribute__((packed))`) looks tempting but trades padding for unaligned
   accesses, which some ARM and MIPS cores trap on. An explicit `b[7] = 0` costs
   nothing and is visible in the spec.

Endianness is not going away. It lives in every bus you touch, and the bytes
really do come out backwards — on around half the hardware in the world.
