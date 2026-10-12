---
title: "Reverse engineering BLE: a practical method with GATT, snoop logs, and bleak"
description: "A hands-on method for reverse engineering BLE devices: enumerate BLE GATT services and characteristics with bluetoothctl, nRF Connect, and Python's bleak, capture the link with an HCI snoop log, read it in Wireshark, and reconstruct the app's protocol."
pubDate: 2026-10-27
lang: en
translationKey: reverse-engineering-a-ble-device
tags: [reverse-engineering, security, embedded]
featured: false
keywords:
  - reverse engineering BLE
  - BLE GATT
  - bluetoothctl
  - nRF Connect
  - HCI snoop log
---

Most tutorials on **reverse engineering BLE** start with a scan and end with one
magic write that happens to work on the author's desk. That is a demo, not a
method. A method is a fixed sequence — enumerate, capture, correlate, reproduce —
that still works on the device you actually own, where half the characteristics
are read-only, the interesting one is encrypted, and the control channel never
notifies you of anything.

The goal is not to break anything. It is to understand a device you own, so you
can drive it from code instead of a vendor app that insists on an account. Here,
**BLE GATT** is the attribute database the traffic reads and writes, and the rest
of this piece is the order in which I attack it: `bluetoothctl` first, `nRF
Connect` to cross-check, `bleak` to automate, and an **HCI snoop log** to see
what the official app does that I could not guess.

## What reverse engineering BLE actually means

BLE is not a byte stream. It is a small, structured database — the GATT server —
that sits behind a radio link. A client does not "send commands"; it reads
attributes and writes attributes, where every attribute has a 16-bit handle local
to the connection and a UUID that says what it is. Everything you learn comes
from three questions:

1. Which attributes exist, and what are their handles and UUIDs?
2. Which of them can I read, write, or subscribe to?
3. What values does the app move through them for the actions I care about?

Answer those and the protocol is no longer a mystery; miss them and you are
guessing at opaque bytes. So the method is unglamorous: enumerate the database,
capture the link, then correlate the two.

## BLE GATT in one page: services, characteristics, handles

A GATT server is a tree. The levels you actually touch:

- **Service** — a group of related data, identified by a UUID (e.g. `0x180F`
  Battery, or a 128-bit vendor UUID). Services can be primary or secondary.
- **Characteristic** — one value plus its permissions, identified by a UUID and
  placed at an **attribute handle**. The handle, not the UUID, is what appears in
  the raw ATT traffic.
- **Descriptor** — metadata on a characteristic. The one that matters is the
  **Client Characteristic Configuration Descriptor (CCCD, UUID `0x2902`)**,
  which enables or disables notifications.

A characteristic advertises `properties`. The relevant ones are `read`, `write`,
`write-without-response`, `notify`, and `indicate`. The last two are the async
channels:

- **Notify** is fire-and-forget. The peripheral pushes a value; the client does
  not acknowledge it. Cheaper, and can be dropped under a bad link.
- **Indicate** is acknowledged. The client sends a confirmation, so the
  peripheral knows the value arrived. More reliable, slower.

To receive either, a client must first write `0x0001` (notify) or `0x0002`
(indicate) to the CCCD of that characteristic. If you subscribe in code and get
nothing, the CCCD write is the first thing to check.

## Scanning and enumerating with bluetoothctl

On Linux, `bluetoothctl` is the fastest way to see the shape of a device. It is
interactive, but you can script it. Start a scan, list what it found, connect,
and then drop into the GATT submenu:

```bash
$ bluetoothctl
[bluetooth]# scan on
Discovery started
[NEW] Device AA:BB:CC:DD:EE:FF MySensor
[bluetooth]# scan off
[bluetooth]# connect AA:BB:CC:DD:EE:FF
[MySensor]# menu gatt
[MySensor]# list-attributes
Primary Service (Handle 0x0001): 00001800-0000-1000-8000-00805f9b34fb
  Characteristic: 00002a00-...  (Primary Service)
Descriptor: 00002901-...  (Characteristic User Description)
...
[MySensor]# select-attribute /org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF/service000a/char000b
[MySensor]# read
```

`list-attributes` prints services, characteristics, and descriptors with their
handles — sometimes in decimal, sometimes as `/org/bluez/...` paths. Read a
characteristic with `read`, write it with `write <value>`, and subscribe with
`notify on` (which allocates a notification slot) followed by `acquire-notify`
and a `monitor` in another terminal if you want to watch values live. A plain
`write <value>` uses write-with-response; when a characteristic is
write-without-response only, `bluetoothctl` picks the matching method
automatically.

Two habits save time. First, `info AA:BB:CC:DD:EE:FF` shows advertised services
before you connect. Second, write the handles down as you go — you will need them
to read the capture later, because the sniffer sees handles, never UUIDs.

## Enumerating with nRF Connect

`bluetoothctl` is good for scripting but clumsy for exploring; **nRF Connect for
Mobile** is the cross-check I reach for next. It shows the full GATT table as a
tree, renders each characteristic's properties as icons (R, W, N, I), lets you
tap to read, write a hex string, or toggle notify, and logs inbound
notifications with timestamps. It also reports the **MTU** it negotiated.

Its real value is that log, on the same phone that runs the vendor app. Run both,
reproduce an action in the vendor app, then watch what moved in nRF Connect. It
is the cheapest protocol oracle you will ever get.

## Enumerating services with bleak

For anything you want to repeat, move to Python. `bleak` is cross-platform and
gives you the same view as `bluetoothctl` with an API attached. This enumerates
every service and characteristic, with handles and properties:

```python
import asyncio
from bleak import BleakClient

ADDRESS = "AA:BB:CC:DD:EE:FF"

async def main() -> None:
    async with BleakClient(ADDRESS) as client:
        for service in client.services:
            print(f"[service] {service.uuid}  {service.description}")
            for char in service.characteristics:
                props = ",".join(char.properties)
                print(f"  [char] {char.uuid}  handle=0x{char.handle:04x}  {props}")

if __name__ == "__main__":
    asyncio.run(main())
```

The `handle` column is the link between this Python view and the packet capture
below. If a handle shows `0x0014` here, that is the number you grep for in
Wireshark.

## Reading vs writing characteristics

Reading returns a current value. Writing changes state. The two are not
interchangeable, and `bleak` makes the distinction explicit:

```python
VENDOR_CHAR = "0000fff2-0000-1000-8000-00805f9b34fb"

# Read the current value.
value = await client.read_gatt_char(VENDOR_CHAR)
print("read:", value.hex(" "))

# Write with response (ATT opcode 0x12). Reliable, acknowledged.
await client.write_gatt_char(VENDOR_CHAR, bytes([0x01, 0x00, 0x00, 0x00]), response=True)

# Write without response (ATT opcode 0x52). Faster, silently dropped if it fails.
await client.write_gatt_char(VENDOR_CHAR, bytes([0x02, 0x01]), response=False)
```

Two traps. First, a **write-without-response** can vanish if the link is busy; if
a command "sometimes works", that is why. Second, the default ATT MTU is 23
bytes, which leaves 20 bytes of payload. Send a 32-byte frame and it is truncated
or rejected — negotiate a larger MTU before writing long values, and be aware
that many devices silently cap what they accept.

## Subscribing to a notification

To watch the device push data, subscribe to a characteristic. Under the hood
`bleak` writes the CCCD for you, then invokes your callback per notification:

```python
import asyncio
from bleak import BleakClient

ADDRESS = "AA:BB:CC:DD:EE:FF"
NOTIFY_CHAR = "0000fff1-0000-1000-8000-00805f9b34fb"

def on_notify(_char, data: bytearray) -> None:
    print("notify:", data.hex(" "))

async def main() -> None:
    async with BleakClient(ADDRESS) as client:
        await client.start_notify(NOTIFY_CHAR, on_notify)
        await asyncio.sleep(60)          # watch while you poke the device
        await client.stop_notify(NOTIFY_CHAR)

if __name__ == "__main__":
    asyncio.run(main())
```

Run this, then trigger the physical action you care about — press the button,
change the temperature, move the device. Whatever appears in the callback is the
device's real, high-rate channel, and it is usually far more informative than any
read.

## Capturing the link with an HCI snoop log

Everything so far relies on you guessing which action to take. The **HCI snoop
log** removes the guessing: it records the actual bytes the vendor app exchanged,
including the parts it never exposes. On Android, enable developer options, turn
on **Enable Bluetooth HCI snoop log**, reproduce the action in the vendor app,
then collect the log:

```bash
# Android: pull the capture out of a bug report.
adb bugreport bugreport.zip
unzip -j bugreport.zip '*btsnoop_hci.log' -d .
wireshark btsnoop_hci.log

# Linux: capture live while the vendor app talks to the device.
sudo btmon -w capture.btsnoop
```

The file is in **btsnoop** format, which Wireshark reads directly. On Linux,
`btmon` records the kernel's HCI traffic — no root-free phone needed, but note it
captures every adapter event, so filter aggressively.

## Reading the HCI snoop log in Wireshark

An HCI capture is noisy: connection events, L2CAP framing, LMP chatter, the lot.
You want the ATT layer, and this handful of display filters covers most of a
session:

```text
btatt                    # all ATT requests, responses, and notifications
btatt.opcode == 0x1b     # Handle Value Notification (server -> client)
btatt.opcode == 0x1d     # Handle Value Indication
btatt.handle == 0x0014   # everything touching one attribute handle
btatt.uuid16 == 0x2a00   # writes/reads to Device Name, by UUID
btsmp                    # pairing: pairing request/response, key exchange
```

The workflow is: find the handles from `bluetoothctl`/`bleak`, filter to that
handle, then read the values in order. A control session reads like a sentence —
a write with an opcode in the first byte, then a notification carrying the
device's reply at the same or a related handle. Line the packets up against the
timeline of what you did in the vendor app, and the protocol falls out.

## Pairing and bonding: why some devices need it

If a characteristic refuses you, the error tells you which wall you hit. ATT
errors to expect:

- `0x05 Insufficient Authentication` — you have not bonded, or the link is not
  encrypted.
- `0x0F Insufficient Encryption` — pairing is required before this attribute is
  usable.
- `0x08 Insufficient Authorization` — you are bonded but lack a needed condition.

**Pairing** is the one-time exchange of keys; **bonding** is storing them so the
next connection encrypts immediately. Vendor characteristics often require that
bonded, encrypted link before they hand over a value or accept a write. If
`bluetoothctl` reads `0x05`, run `pair AA:BB:CC:DD:EE:FF` and `trust
AA:BB:CC:DD:EE:FF` before `connect`, then retry. If pairing demands a passkey you
do not have, that is a deliberate barrier, not a puzzle to force.

## Reconstructing the app's protocol

Now all the pieces combine. With the snoop log in hand and the GATT table mapped,
you reconstruct the protocol by correlation:

1. **Instrument the app.** Note the time and the action each time you do
   something in the vendor app.
2. **Filter the capture** to the handles those actions touched, sorted by time.
3. **Diff two identical actions.** Fields that change are state — a counter, a
   nonce, a sequence number; fields that stay are structure.
4. **Replay in `bleak`.** Send the captured write, subscribe to the reply
   characteristic, and confirm the same notification comes back.
5. **Vary one thing at a time** until you can predict the write for a new input.

This is the same discipline as [reverse-engineering a private HTTP
API](/posts/reverse-engineering-a-private-api/): observe, capture, replay,
then automate — and the same instinct that decoded [a campus captive
portal](/posts/ruijie-campus-portal-reverse-engineering/) applies to a two-byte
BLE opcode. Keep a table of opcode → meaning as you fill it in; the table is the
protocol.

## When you'll get stuck

Honest limits, because the method has edges:

- **Encrypted vendor characteristics.** Some devices gate the interesting
  characteristic behind an application-layer cipher whose key is derived during a
  cloud pairing step. Bonding gets you the encrypted link; it does not get you
  the app key. Without that key the bytes are opaque, and brute force is not the
  answer.
- **No notify on the control channel.** If a control characteristic never
  notifies, you cannot passively watch state. Poll the read characteristic on a
  timer instead, and remember the device may rate-limit that.
- **Write-without-response that silently drops.** No error comes back. Verify by
  reading the state afterwards; do not trust the write.
- **iOS GATT caching.** iOS caches services per bonded device. After a firmware
  update, delete and re-pair to see new handles.
- **Handles that move between firmware versions.** Never hard-code a handle;
  resolve it from the UUID at runtime.

## Authorised use: your own devices only

Point this at hardware you own and are allowed to inspect. Reverse engineering
your own light bulb, sensor, or bike computer to automate your own access is
normal engineering. Defeating a device lock you are not entitled to bypass,
reading another person's data, or breaking an encrypted channel whose key you
were never given is not — that is the boundary, not a puzzle. Follow the law and
the terms that apply where you are; if a step requires someone else's secret,
stop.

The method itself is neutral, and that is the point. Scan, enumerate, capture,
correlate, replay. Do it on your own bench, keep the notes, and the opaque vendor
app becomes a two-byte protocol you understand.
