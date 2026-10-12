---
title: "Reverse engineer a serial protocol with a logic analyzer: UART decoding and SPI I2C"
description: "A hands-on method to reverse engineer a serial protocol from a logic analyzer capture: wire up UART and SPI I2C, find the baud rate, read the hex bytes, test hypotheses with checksums, and write a small Python decoder."
pubDate: 2026-11-07
lang: en
translationKey: decoding-a-serial-protocol
tags: [reverse-engineering, embedded, security]
featured: false
keywords:
  - reverse engineer serial protocol
  - logic analyzer
  - UART decoding
  - SPI I2C
  - checksum
---

When a device talks to something you do not control, the firmware is a black box.
The wire is not. A ten-dollar logic analyzer clipped onto the bus, plus a common
ground, turns that black box into a byte stream you can read. That is the whole
trick to **reverse engineer a serial protocol**: capture the voltages, decode the
bus, and reconstruct the meaning one byte at a time.

This is the method I use on my own bench. Nothing here needs a disassembler or a
firmware dump — it needs a **logic analyzer**, an oscilloscope-grade eye for
timing, and patience. The same discipline that cracked [a BLE
device](/posts/reverse-engineering-a-ble-device/) and [a private HTTP
API](/posts/reverse-engineering-a-private-api/) applies to a two-wire UART: observe,
capture, form a hypothesis, change one input, confirm.

## Identifying the bus first: UART decoding vs SPI I2C

Before you decode anything, work out what you are actually looking at. Three buses
cover most embedded devices, and they look different on a scope:

- **UART** — one wire per direction. The device's TX is your RX. Idle is high, and
  you see bursty groups of pulses with long gaps between them. No clock line.
- **I2C** — two wires, **SCL** (clock) and **SDA** (data), both pulled up to the
  rail and idle high. The clock only runs during a transfer.
- **SPI** — three or four wires: **SCLK**, **MOSI**, **MISO**, and a **CS/SS**
  chip-select that drops low for the duration of each transaction. There is a clock
  and there is almost always continuous traffic.

The tell is simple: count the active lines. Get the bus wrong and you will spend an
afternoon decoding noise.

## Wiring the logic analyzer: channels, ground, voltage

Ground first, always. Clip the analyzer's GND to a real ground pin on the target —
the board's ground, a header pin, the shield of a connector. Without a shared
ground reference, every channel floats and nothing decodes. This is the single most
common reason a first capture is garbage.

Then attach probes and name the channels in software before you capture. I use a
fixed convention so my notes stay readable:

```text
D0 -> UART TX (device -> me)   # or SCL for I2C, SCLK for SPI
D1 -> UART RX (me -> device)   # or SDA for I2C, MOSI for SPI
D2 -> CS / SS                  # SPI only
D3 -> MISO                     # SPI only
GND -> board ground            # non-negotiable
```

Voltage matters as much as wiring. Most logic analyzers expect 3.3 V logic and are
**not** 5 V tolerant. If the target runs at 5 V, either move a jumper to the 5 V
threshold or level-shift the signals. Feeding 5 V into a 3.3 V input is how you
kill the analyzer and waste a day.

On the software side, use [PulseView / sigrok](https://sigrok.org/), which is open
source and supports nearly every clone chip. Sample rate is your first real
decision: you need at least 4–10 samples per bit. A 115200 baud line has an 8.68 µs
bit, so 1 MS/s gives you about 8 samples per bit — the floor. When in doubt, sample
faster.

## Finding the baud rate and UART decoding by eye

UART framing is fixed and worth memorizing: the line idles **high**, a **start
bit** pulls it low for one bit period, then 8 data bits arrive **least-significant
bit first**, an optional parity bit, and one or two **stop bits** return the line
high. The receiver samples the middle of each bit.

If you set the wrong baud rate, you get framing errors and garbage. Find the right
one from the capture itself. Zoom in until you can measure the shortest high pulse
— that is approximately one bit period. Invert it:

```text
bit period ≈ 104 µs   -> 1 / 104µs   ≈  9600 baud
bit period ≈ 17.4 µs  -> 1 / 17.4µs  ≈ 57600 baud
bit period ≈ 8.68 µs  -> 1 / 8.68µs  ≈ 115200 baud
```

If the decoded bytes are almost right but every other one is corrupted, you are
usually off by a factor — try 9600 vs 9600, or 115200 vs 57600. If the bytes are
plausible but the stop bit never confirms, you probably have parity enabled when
the device does not, or vice versa.

Once you have the number, let the tool do the work. sigrok decodes the stream
directly:

```bash
sigrok-cli -i capture.sr \
  -P uart:baudrate=115200:rx=D0 \
  -A uart=rx-data
```

## Reverse engineer a serial protocol: the hypothesis loop

Decoded bytes are not yet a protocol. The heart of this work is a loop you repeat
until the picture locks in:

1. **Form a hypothesis.** "The fourth byte is a command code." "Byte three is a
   length." "The first two bytes are a magic header."
2. **Change exactly one input** and capture again — press a different button, send
   a longer payload, set a new value.
3. **Diff the captures.** Fields that moved are data or state; fields that stayed
   are structure.

Do the same physical action twice and diff it. Anything that changes between two
identical actions — a counter, a nonce, a timestamp — is state you must reproduce.
Anything constant is structure you can rely on. Keep a running table of byte
offset, observed values, and your best guess. That table *is* the protocol.

For example, if I tap "mode" and byte 3 walks `01 -> 02 -> 03`, byte 3 is a mode
selector. If I send a longer message and byte 2 grows by exactly the payload
growth, byte 2 is a length field. This is controlled experimentation, not guessing,
and it converges fast.

## Confirming with checksums and length fields

Two features let you *prove* a hypothesis instead of hoping: **length fields** and
**checksums**. A length field that always equals the number of bytes that follow
the header is self-verifying. A checksum seals the frame.

The two checksums you will meet in embedded gear are trivial to compute. **XOR**
over the covered bytes:

```python
def xor8(data: bytes) -> int:
    c = 0
    for b in data:
        c ^= b
    return c
```

And the additive **sum8**, usually taken modulo 256:

```python
def sum8(data: bytes) -> int:
    return sum(data) & 0xFF
```

Take your candidate frame, strip the last byte, run both functions, and compare
against the byte the device actually sent. If one matches, you have found both the
checksum algorithm *and* the exact byte range it covers — often everything from the
header up to but not including the checksum. If neither matches, widen or shrink
the covered range and try again. A checksum that validates on ten captures in a row
is not a coincidence; it is the frame layout, confirmed.

## Worked example: decoding one frame

Suppose I capture this frame from a device while I tap a button:

```text
AA 55 05 01 10 40 00 11 BA
```

My hypothesis is a header, a length, a command, a 16-bit address, a 16-bit value,
and a trailing XOR checksum. Verify the length first: after the two-byte header,
`05` says five payload bytes follow — `01 10 40 00 11`, which is exactly five, then
one checksum byte. The length field holds.

Now verify the checksum. XOR everything from the header up to but not including the
last byte:

```text
AA ^ 55 ^ 05 ^ 01 ^ 10 ^ 40 ^ 00 ^ 11 = BA
```

`BA` is precisely the trailing byte. Both fields validate, so the layout is not a
guess anymore.

Putting it together with labels:

```text
AA 55         header / sync
05            length = 5 payload bytes
01            command  = write register
10 40         address  = 0x1040
00 11         value    = 0x0011
BA            XOR8 checksum (validated)
```

## Writing a small decoder in Python

Once the layout is proven, write the decoder so you never read hex by eye again.
This one parses the frame above into named fields and re-validates the checksum:

```python
from dataclasses import dataclass

HEADER = b"\xAA\x55"

@dataclass
class Frame:
    cmd: int
    addr: int
    value: int
    checksum_ok: bool

def xor8(data: bytes) -> int:
    c = 0
    for b in data:
        c ^= b
    return c

def decode(blob: bytes) -> Frame:
    if blob[:2] != HEADER:
        raise ValueError(f"bad header: {blob[:2].hex()}")
    length = blob[2]
    body = blob[3:3 + length]
    checksum = blob[3 + length]
    calc = xor8(blob[:3 + length])
    return Frame(
        cmd=body[0],
        addr=(body[1] << 8) | body[2],
        value=(body[3] << 8) | body[4],
        checksum_ok=(calc == checksum),
    )

if __name__ == "__main__":
    frame = decode(bytes([0xAA, 0x55, 0x05, 0x01, 0x10, 0x40, 0x00, 0x11, 0xBA]))
    print(frame)
    # Frame(cmd=1, addr=0x1040, value=0x11, checksum_ok=True)
```

From here, feed it a whole capture instead of a single frame: export the decoded
stream from sigrok, split it on the header bytes, and map each parsed frame to a
line of output. A vendor app's behaviour becomes a table of `cmd`/`addr`/`value`
rows you can diff between two runs — the same shape as the protocol you reconstruct
from [a private API](/posts/reverse-engineering-a-private-api/).

## When you get stuck

Honest edges, because there always are some:

- **It is not UART, SPI, or I2C.** RS-485 is UART over a differential pair, often
  half-duplex with a direction pin you must also probe; CAN and 1-Wire are their own
  worlds.
- **The payload is obfuscated.** Above the framing, some devices XOR or encrypt the
  body with a key derived at runtime. A valid checksum over encrypted bytes proves
  the framing and tells you nothing about the meaning — stop rather than brute-force
  someone else's key.
- **A length field you misread.** Off-by-one between "payload length" and "total
  frame length" will send you chasing phantom checksums. Nail the definition by
  testing both against real captures.
- **Sampling too slowly.** Aliasing invents bytes that were never on the wire.
- **No chip-select on SPI.** Without CS, byte boundaries are ambiguous; find the
  enable line or you are decoding noise.

## Only on hardware you own

Point this at your own board, your own sensor, your own appliance. Understanding a
device you possess so you can drive it from code is normal engineering. Breaking a
DRM scheme, reading someone else's device, or recovering a key you were never given
is not a puzzle to solve — it is a line to not cross. Check the rules where you
live and the terms attached to the thing, and if a step needs a secret that is not
yours, stop.

The method is neutral and that is the point. Clip on, share ground, find the baud
rate, read the bytes, form a hypothesis, change one input, confirm with the
checksum, then hand it to a decoder. The opaque two-wire bus becomes a protocol you
own a spec for.
