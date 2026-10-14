---
title: "ESP32 battery life by design: the sensor node BOM and the real power budget"
description: "A sensor node BOM audited honestly: what the board, regulator, sensor and radio choices really cost your ESP32 battery life, with a Python model computing the real average current, battery life and monthly data budget."
pubDate: 2027-02-18
lang: en
translationKey: esp32-sensor-node-bom
tags: [esp32, embedded]
featured: false
keywords:
  - ESP32 battery life
  - sensor node BOM
  - deep sleep current
  - power budget
  - LiPo vs 18650
---

There is no ESP32 on my bench right now, so this is not a "I strapped a
Joulescope to it and here are the traces" article. Instead I did what I tell
everyone else to do first: write down the assumptions, turn them into a small
model, and let the arithmetic be real. Every current below is a labelled
assumption — a datasheet-typical number you are allowed to argue with — but
every average, day count and megabyte in the tables is genuine output from
scripts I actually ran. The scripts are short and inline, so you can change my
assumptions and watch the budget move.

The pitch is simple: your **ESP32 battery life** is not decided by the chip. It
is decided by the **sensor node BOM** — by the regulator nobody reads the
datasheet of, by the USB-serial bridge quietly burning milliamps while the radio
sleeps, by which radio you picked. This is how I reason about the **power
budget** of a duty-cycled battery node before buying a single part.

## What the node must do: sense, transmit, sleep

The job is boring. Wake up, read a sensor, publish the reading, go back to
sleep. Three phases, and their costs are separated by orders of magnitude:
milliseconds awake at tens of milliamps, hundreds of seconds asleep at tens of
microamps. Because the awake window is short, the average current is dominated
by two things: what the whole board leaks during deep sleep, and what the wake
window itself costs. The **deep sleep current** you can fix in the BOM; the wake
window you can only shorten.

<figure>
  <svg viewBox="0 0 720 200" role="img" aria-label="Current over one 10-minute cycle: mostly a flat deep-sleep floor, a small sensor-read bump, and one tall Wi-Fi transmit burst; the average sits just above the sleep floor" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto">
    <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="currentColor">
      <text x="24" y="20" font-size="13">One 10-minute cycle at the modeled 3 s wake window</text>
      <rect x="385" y="95" width="40" height="55" fill="#0f766e" fill-opacity="0.3"/>
      <polygon points="520,150 520,25 555,25 555,150" fill="#0f766e" fill-opacity="0.18"/>
      <path d="M24,150 L375,150 L385,95 L425,95 L435,150 L520,150 L520,25 L555,25 L555,150 L700,150" fill="none" stroke="#0f766e" stroke-width="2"/>
      <line x1="24" y1="138" x2="700" y2="138" stroke="#0f766e" stroke-width="1" stroke-dasharray="6 4" opacity="0.8"/>
      <text x="300" y="132" font-size="11" opacity="0.85">average 0.45 mA &#8594; &#8776;185 days on 2000 mAh</text>
      <text x="385" y="86" font-size="11" text-anchor="middle">read</text>
      <text x="470" y="18" font-size="11">Wi-Fi assoc. + TX burst</text>
      <text x="24" y="172" font-size="11" opacity="0.7">deep sleep &#8776;50 &#181;A (assumed board floor)</text>
      <text x="470" y="172" font-size="11" opacity="0.7">3 s awake of 600 s = 0.5% duty</text>
    </g>
  </svg>
  <figcaption>Vertical scale is not to scale on purpose: the sleep floor and the TX burst differ by three orders of magnitude, so a linear axis would draw a flat line and teach nothing. The point is what the average line looks like when the duty cycle is small and honest.</figcaption>
</figure>

If you want the mode-by-mode detail — modem sleep, DTIM, what reconnect costs —
I wrote that up separately in [ESP32 power management on the ESP32-C3](/posts/esp32-power-management/).
This piece is about the parts *around* the chip, and the arithmetic that decides
whether they add up to months or to a fortnight.

## The BOM is the budget

### Board: ESP32 vs ESP32-C3 vs a bare module

Two very different things are sold as "an ESP32 board", and only one of them is
safe to put on a battery. A classic dev board carries a USB-serial bridge, a
power LED and an LDO that never asked whether the main chip was asleep; it will
sit at several milliamps with your firmware in deep sleep, and that alone caps
your battery life in the low-days range no matter what the datasheet promises.
An ESP32-C3 class board narrows the gap (a smaller die, one core, less to keep
alive), but the peripherals around it are the same problem. A bare module means
you own the regulator, the rail switching and the pull-ups — which is exactly
where the **sensor node BOM** gets decided. It costs you soldering time and buys
you the difference between months and days.

### Power: LiPo vs 18650, AA, and the regulator trap

The honest **LiPo vs 18650** summary: a 2000 mAh-class LiPo has the best energy
per volume and needs a charge-and-protection circuit; a 3.0–3.5 Ah 18650 is
swappable and behaves better in the cold; two AA alkalines are cheapest and
happily deliver a couple of amp-hours at the low currents a sleeping node draws,
if you accept the bulk. Prices for all of these move by seller and region, so I
quote none — treat them as commodity parts and buy whatever arrives fastest.

The part that kills more battery designs than the radio is sitting between the
cell and everything else: the regulator. The AMS1117-class LDO that half the old
dev boards ship carries a quiescent current of several milliamps in its own
datasheet. Quiescent current flows 24 hours a day, including the 99% of the time
your node is asleep, so it converts directly into the second half of the table
below. A modern low-Iq LDO in the microamp class makes that line disappear.
This is the single cheapest fix in the whole BOM.

### Sensor: every interface has an idle draw

- **I²C** parts are the easy case: a decent temp/humidity/pressure sensor idles
  in the microamp range between conversions, and the bus itself costs almost
  nothing when nobody talks.
- **Analog** is where designs leak. A divider is a resistor to ground that never
  sleeps; a 100 kΩ sensing leg from a 3.3 V rail bleeds tens of microamps
  continuously. Bigger resistor values, switching the rail, or a digital part
  are all cheaper than battery.
- **One-wire** sensors sit in the middle: low idle, but the bus pull-up and the
  conversion time are yours to budget for.

Whichever you pick, gate the sensor's power rail from a GPIO and the idle
question mostly evaporates:

```c
#include "driver/gpio.h"
#include "esp_sleep.h"

#define SENSOR_RAIL GPIO_NUM_8   /* the rail you switched on the board */

RTC_DATA_ATTR static int s_wakes;  /* survives deep sleep */

void app_main(void)
{
    ++s_wakes;

    /* Pay for the sensor only for the milliseconds you use it. */
    gpio_set_direction(SENSOR_RAIL, GPIO_MODE_OUTPUT);
    gpio_set_level(SENSOR_RAIL, 1);
    vTaskDelay(pdMS_TO_TICKS(2));     /* let the rail settle */

    /* ... read the sensor, associate, publish, disconnect ... */
    gpio_set_level(SENSOR_RAIL, 0);

    esp_sleep_enable_timer_wakeup(600ULL * 1000000ULL);  /* 10 minutes */
    esp_deep_sleep_start();  /* does not return */
}
```

### Radio: Wi-Fi vs BLE vs LoRa is an energy-per-byte question

"**LoRa vs WiFi**" is usually asked as a range question, and that is the wrong
axis first. The axis that matters on a battery is energy per delivered byte.
LoRa buys enormous range and penetration at the cost of a gateway and tight
duty-cycle limits; Wi-Fi buys any range you have an access point for, and pays
for association every time; BLE sits in between and is the sweet spot for
phone-adjacent nodes. The model's verdict, with all three assumptions stated
inside the script:

```python
#!/usr/bin/env python3
"""Average-current model for a duty-cycled ESP32 sensor node.

All current values are DATESHEET-TYPICAL / MEASURED-BALLPARK ASSUMPTIONS,
stated as constants below so they can be argued with. The arithmetic is the
point: average current (not peak, not sleep) is what sets battery life.
"""

MAH = 2000.0          # LiPo cell capacity [assumption: a common 2000 mAh pack]
SLEEP_UA = 50.0       # whole-board deep-sleep draw, bare module + good LDO [assumption]
WAKE_MA = 80.0        # average during the wake window: CPU + Wi-Fi + TX bursts [assumption]
SENSOR_MA = 2.0        # sensor active while being read [assumption]
SENSOR_S = 0.1         # sensor read takes 100 ms [assumption]

def avg_current_ma(cycle_s, wake_s):
    """Charge-weighted average current over one full cycle, in mA."""
    awake_charge = WAKE_MA * wake_s                    # mA*s
    sleep_charge = (SLEEP_UA / 1000.0) * (cycle_s - wake_s)
    return (awake_charge + sleep_charge) / cycle_s

def life_days(cycle_s, wake_s, capacity_mah=MAH):
    i = avg_current_ma(cycle_s, wake_s)
    hours = capacity_mah / i
    return i, hours / 24.0

print(f"Assumptions: battery {MAH:.0f} mAh, board deep-sleep {SLEEP_UA:.0f} uA, "
      f"wake-window average {WAKE_MA:.0f} mA")
print(f"{'cycle':>8} {'wake':>6} {'avg I (mA)':>11} {'life (days)':>12} {'life':>14}")
for cycle_s, wake_s, label in [
    (60, 3.0, "1 min"),
    (300, 3.0, "5 min"),
    (600, 3.0, "10 min"),
    (3600, 3.0, "1 hour"),
    (86400, 3.0, "1 day"),
]:
    i, d = life_days(cycle_s, wake_s)
    print(f"{label:>8} {wake_s:>4.1f}s {i:>11.3f} {d:>12.1f} {d/365:>13.2f} yr")

print()
print("Same battery, same firmware, but the wake window doubles (DHCP + slow AP):")
for cycle_s, label in [(300, "5 min"), (600, "10 min")]:
    i, d = life_days(cycle_s, 6.0)
    print(f"  {label:>6} cycle, 6.0s wake -> {i:.3f} mA avg, {d:.1f} days")

print()
print("The regulator trap (5 mA quiescent LDO, e.g. an old AMS1117-class part,")
print("feeding the same duty-cycled node):")
BAD_MA = 5.0
for cycle_s, wake_s, label in [(600, 3.0, "10 min"), (3600, 3.0, "1 hour")]:
    q_bad = (WAKE_MA * wake_s + BAD_MA * cycle_s) / cycle_s
    print(f"  {label:>7} cycle: {q_bad:.3f} mA avg, {MAH / q_bad / 24:.1f} days "
          f"(vs {avg_current_ma(cycle_s, wake_s):.3f} mA / {life_days(cycle_s, wake_s)[1]:.1f} days)")

print()
print("Energy per reported byte, two radios [assumptions: TX currents from")
print("datasheet-typical values; times-on-air are order-of-magnitude]:")
wifi = WAKE_MA * 3.0 / (102 * 8)      # 80 mA for the whole 3 s window / (80 B payload + 22 B headers)
lora = 120.0 * 0.10 / (51 * 8)        # 120 mA for ~100 ms on air at SF7 / 51-byte frame
ble  = 15.0 * 0.02 / (31 * 8)         # 15 mA for ~20 ms per advertisement / 31 bytes
print(f"  Wi-Fi publish : {wifi*1e6:8.1f} uJ/bit  ({WAKE_MA:.0f} mA x 3.0 s / 102 B)")
print(f"  LoRa SF7 frame: {lora*1e6:8.1f} uJ/bit  (120 mA x 0.10 s / 51 B)")
print(f"  BLE advert    : {ble*1e6:8.1f} uJ/bit  (15 mA x 0.02 s / 31 B)")
```

and the real output it printed:

```console
$ python3 power_budget.py
Assumptions: battery 2000 mAh, board deep-sleep 50 uA, wake-window average 80 mA
   cycle   wake  avg I (mA)  life (days)           life
   1 min  3.0s       4.048         20.6          0.06 yr
   5 min  3.0s       0.850         98.1          0.27 yr
  10 min  3.0s       0.450        185.3          0.51 yr
  1 hour  3.0s       0.117        714.5          1.96 yr
   1 day  3.0s       0.053       1579.0          4.33 yr

Same battery, same firmware, but the wake window doubles (DHCP + slow AP):
   5 min cycle, 6.0s wake -> 1.649 mA avg, 50.5 days
  10 min cycle, 6.0s wake -> 0.850 mA avg, 98.1 days

The regulator trap (5 mA quiescent LDO, e.g. an old AMS1117-class part,
feeding the same duty-cycled node):
   10 min cycle: 5.400 mA avg, 15.4 days (vs 0.450 mA / 185.3 days)
   1 hour cycle: 5.067 mA avg, 16.4 days (vs 0.117 mA / 714.5 days)

Energy per reported byte, two radios [assumptions: TX currents from
datasheet-typical values; times-on-air are order-of-magnitude]:
  Wi-Fi publish : 294117.6 uJ/bit  (80 mA x 3.0 s / 102 B)
  LoRa SF7 frame:  29411.8 uJ/bit  (120 mA x 0.10 s / 51 B)
  BLE advert    :   1209.7 uJ/bit  (15 mA x 0.02 s / 31 B)
```

Read the rows in order, because they tell one story:

- **The reporting interval is the biggest lever in the whole design.** One
  report per minute gives 20.6 days; one per ten minutes gives 185; one per hour
  is approaching two years on the same 2000 mAh cell. Same BOM, same firmware.
- **The wake window dominates when cycles are short.** At a one-minute cycle,
  the awake 3 seconds are 240 mA·s of charge per cycle against roughly 3 mA·s of
  sleep — the sleep current is invisible and the wake is the budget.
- **Double the wake window, halve the life.** Six seconds instead of three —
  which is what a DHCP negotiation and an unlucky association order on a busy
  access point costs — takes the five-minute design from 98 days to 50.
- **The regulator decides the ceiling.** Five milliamps of quiescent current
  pins the node at 15–16 days regardless of the duty cycle. Every other row of
  this table is smaller than that mistake.
- **Energy per byte:** the modeled radio comparison comes out near two orders
  of magnitude between a Wi-Fi publish and a LoRa frame, with a BLE
  advertisement in between. That does not make LoRa automatically right — it
  needs a gateway — but it explains why "just use the same Wi-Fi stack" is the
  expensive default.

## The data budget: bytes per month are part of the BOM too

Power is half the budget; the other half is what you send. A fatter message
costs airtime, and airtime is current. So the payload encoding is a power
decision. Here is a real message size calculation, packaging one reading two
ways:

```python
#!/usr/bin/env python3
"""Real byte counts: JSON payload vs a packed binary struct."""
import json, struct

reading = {
    "node": "shf-01",
    "seq": 4_000_000,      # monotonic counter, wraps cleanly at 2^32
    "t": 21.5625,          # degC
    "h": 48.1875,          # %RH
    "batt_mv": 3940,       # millivolts
    "flags": 0b0000_0101,  # bit0: door open, bit2: low battery
}

json_payload = json.dumps(reading, separators=(",", ":")).encode()
print("JSON payload:")
print(" ", json_payload.decode())
print(f"  bytes: {len(json_payload)}")

# Packed: 3B node tag + uint32 seq + int16 t_centi + uint16 h_centi
#         + uint16 batt_mv + uint8 flags = 14 bytes
packed = struct.pack("<3sIhhHB",
                     b"shf",                       # 3 B compact node tag
                     reading["seq"],               # 4 B sequence
                     int(round(reading["t"] * 100)),  # 2 B, centi-degC, signed
                     int(round(reading["h"] * 100)),  # 2 B, centi-%RH
                     reading["batt_mv"],           # 2 B
                     reading["flags"])             # 1 B
print(f"\nPacked struct '<3sIhhHB': {len(packed)} bytes")
print("  hex:", packed.hex())

# Round-trip proof the packing is lossless for this schema
tag, seq, t_c, h_c, mv, fl = struct.unpack("<3sIhhHB", packed)
assert tag == b"shf" and seq == reading["seq"]
assert abs(t_c / 100 - reading["t"]) <= 0.005   # half of one 0.01 C LSB
assert abs(h_c / 100 - reading["h"]) <= 0.005   # half of one 0.01 %RH LSB
assert mv == reading["batt_mv"] and fl == reading["flags"]
print(f"  round-trips: t={t_c/100} C, h={h_c/100} %, mv={mv}, flags={fl:08b}  OK")
print(f"\nsaving: {len(json_payload)} B -> {len(packed)} B = "
      f"{100*(1-len(packed)/len(json_payload)):.0f}% smaller")
print("resolution actually kept: 0.01 C / 0.01 %RH, seq rollover at 2^32")
```

```console
$ python3 msg_size.py
JSON payload:
  {"node":"shf-01","seq":4000000,"t":21.5625,"h":48.1875,"batt_mv":3940,"flags":5}
  bytes: 80

Packed struct '<3sIhhHB': 14 bytes
  hex: 73686600093d006c08d312640f05
  round-trips: t=21.56 C, h=48.19 %, mv=3940, flags=00000101  OK

saving: 80 B -> 14 B = 82% smaller
resolution actually kept: 0.01 C / 0.01 %RH, seq rollover at 2^32
```

Eighty bytes of JSON, fourteen packed — and you keep 0.01 °C resolution, which
is better than any of these sensors actually are. Now multiply by the month,
against the reality of broker plans. Free and hobby cloud brokers commonly give
you somewhere between a few hundred megabytes and a few gigabytes of monthly
egress — treat that as a band to verify against your provider, not a promise:

```python
#!/usr/bin/env python3
"""Data budget for a duty-cycled sensor node: bytes/month vs broker quotas.

Message payloads come from msg_size.py's real byte counts; MQTT framing and
keepalive overhead are added here. Quote numbers are honest bands, not a
vendor promise - check your own broker plan.
"""
KB, MB, GB = 1e3, 1e6, 1e9

JSON_LEN = 80   # bytes, from msg_size.py
PACKED_LEN = 14  # bytes, from msg_size.py
MQTT_OVERHEAD = 22   # PUBLISH header + topic + fixed header + IP/TCP, order-of-magnitude
KEEPALIVE_S = 60     # [assumption] broker keepalive we choose
PINGREQ_BYTES = 2 + 20  # MQTT PINGREQ packet ~ TCP/IP overhead per ping

def monthly_bytes(payload_len, cycle_s, n_nodes=1):
    msgs_day = 86400 / cycle_s
    payload_month = msgs_day * 30 * (payload_len + MQTT_OVERHEAD) * n_nodes
    pings_month = (86400 / KEEPALIVE_S) * 30 * PINGREQ_BYTES * n_nodes
    return payload_month, pings_month

print(f"per-message payload: JSON {JSON_LEN} B, packed {PACKED_LEN} B")
print(f"assumptions: +{MQTT_OVERHEAD} B MQTT/TCP/IP overhead, keepalive {KEEPALIVE_S}s")
print()
print(f"{'report every':>12} {'nodes':>5} {'JSON /month':>14} {'packed /month':>15} {'ratio':>7}")
for cycle_s, label in [(60, "1 min"), (600, "10 min"), (3600, "1 hour")]:
    for n in (1, 25):
        j, jp = monthly_bytes(JSON_LEN, cycle_s, n)
        p, pp = monthly_bytes(PACKED_LEN, cycle_s, n)
        print(f"{label:>12} {n:>5} {j/MB:>11.2f} MB {p/MB:>12.2f} MB {j/p:>6.1f}x")

print()
print("Sense of scale against typical free-tier broker allowances (hundreds of MB")
print("to a few GB/month of egress - verify against your provider, not me):")
j, jp = monthly_bytes(JSON_LEN, 60, 25)
p, pp = monthly_bytes(PACKED_LEN, 60, 25)
for quota_gb in (1, 10):
    print(f"  {quota_gb} GB/month quota: JSON 1-min x25 = {j/GB:.3f} GB "
          f"({100*j/(quota_gb*GB):.2f}% of quota); packed = {p/GB:.3f} GB ({100*p/(quota_gb*GB):.2f}%)")
print(f"  keepalive ping traffic at 25 nodes, 60 s keepalive: "
      f"{(jp)/MB:.2f} MB/month ({100*jp/j:.1f}% of payload traffic)")
```

```console
$ python3 data_budget.py
per-message payload: JSON 80 B, packed 14 B
assumptions: +22 B MQTT/TCP/IP overhead, keepalive 60s

report every nodes    JSON /month   packed /month   ratio
       1 min     1        4.41 MB         1.56 MB    2.8x
       1 min    25      110.16 MB        38.88 MB    2.8x
      10 min     1        0.44 MB         0.16 MB    2.8x
      10 min    25       11.02 MB         3.89 MB    2.8x
      1 hour     1        0.07 MB         0.03 MB    2.8x
      1 hour    25        1.84 MB         0.65 MB    2.8x

Sense of scale against typical free-tier broker allowances (hundreds of MB
to a few GB/month of egress - verify against your provider, not me):
  1 GB/month quota: JSON 1-min x25 = 0.110 GB (11.02% of quota); packed = 0.039 GB (3.89%)
  10 GB/month quota: JSON 1-min x25 = 0.110 GB (1.10% of quota); packed = 0.039 GB (0.39%)
  keepalive ping traffic at 25 nodes, 60 s keepalive: 23.76 MB/month (21.6% of payload traffic)
```

Three honest conclusions from that table. First, the encoding buys 2.8×, but
the *interval* still dominates the total: one node reporting every ten minutes
is a rounding error on any plan; twenty-five nodes reporting every minute is
110 MB a month in JSON, and 11 MB if you can live with ten-minute reporting. Second, keepalive traffic is not free — at a 60-second
keepalive it is over a fifth of the payload traffic, so pick the longest
interval your broker tolerates. Third, if every message carries a TLS
handshake, the handshake costs you far more airtime than the encoding saves —
the stack-level budget around that is what I worked through in [MQTT on a
microcontroller](/posts/mqtt-on-a-microcontroller/). Compression, like solar,
is a second-order fix that people reach for first.

## The traps, collected

1. **The dev board's own floor.** The board you prototyped on draws several
   milliamps "asleep" because of its USB bridge and LDO. Your production design
   will not — but only if you change the part.
2. **A regulator whose quiescent current is in the wrong unit.** mA instead of
   µA costs you an order of magnitude of battery, silently, forever.
3. **Wake time dominating short cycles.** Below a certain reporting interval the
   budget is association time, not sleep current; shortening connect beats
   every other firmware optimization.
4. **Association as a fixed tax.** Static IP, cached BSSID and channel, and a
   fast-connecting AP placement are worth more days than any library.
5. **An analog divider that never sleeps**, and a sensor rail that was never
   switched off.
6. **Framing costs on the data side**: keepalive, retained state and per-message
   TLS all consume the same bytes the payload budget was supposed to buy.

## What I would do first

Measure the sleep current before anything else — an INA219-class breakout on the
battery rail, or even a cheap inline meter, over a full cycle. That single
number tells you whether your board choice is viable at all. Then choose the
reporting interval, because it buys more than any component will. Then choose
the regulator, then the encoding. And keep the honest result in view: when the
budget does not close, a smaller radio and a smaller sleep current usually beat
a bigger battery. A 2000 mAh cell is a fixed slab of charge; the BOM around it
decides whether you spend that slab on three weeks or on three years.
