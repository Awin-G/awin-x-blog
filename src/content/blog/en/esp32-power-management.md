---
title: "ESP32 power management: Wi-Fi, deep sleep and modem sleep on the ESP32-C3"
description: "A practical guide to ESP32 power management on the ESP32-C3: why the Wi-Fi radio dominates the budget, what active, modem sleep, light sleep and deep sleep each cost in connectivity, how DTIM and listen interval trade latency for battery life, and how to measure real current cheaply."
pubDate: 2026-10-31
lang: en
translationKey: esp32-power-management
tags: [esp32, embedded, networking]
featured: false
keywords:
  - ESP32 power management
  - ESP32 deep sleep
  - modem sleep
  - low power Wi-Fi
  - DTIM
---

Everyone who puts an ESP32-C3 on a battery hits the same wall. The datasheet
sleep current is in the microamps, yet the device dies in a weekend. The reason
is almost never the chip — it is the radio. Once **Wi-Fi** is on, **ESP32 power
management** stops being a story about the CPU and becomes a story about one
number: how many milliseconds per second the 2.4GHz modem is actually awake.
Next to a transmitting radio, the core clock, the peripherals and even a status
LED are rounding error.

These are field notes from C3 devices that mostly live on batteries. One honest
limit up front: exact milliamp and microamp figures depend on your board,
firmware and access point, so I will talk about *relative* magnitudes and, more
usefully, how to measure your own. The modes and tradeoffs travel; the numbers do
not. This assumes the ESP-IDF setup from
[getting started with the ESP32-C3](/posts/esp32-c3-getting-started/).

## Why the Wi-Fi radio dwarfs everything else

A C3 in its deepest sleep draws so little that a decent multimeter reads it as
noise. The moment it associates and starts listening, average current jumps by
orders of magnitude — the difference between a coin cell lasting months and the
same cell lasting a day or two.

Two things drive that jump. Receiving is not free — the radio wakes its receiver
for every beacon and DTIM window it promised to observe. And *transmitting*
briefly costs far more than receiving: a short full-power burst can pull tens of
times the idle-modem average for those milliseconds. The levers are always the
same — transmit less, receive less often, sleep deeper in between. Firmware that
"just keeps the connection alive" is quietly choosing the most expensive default.

## The ESP32 power modes, and what each costs your connectivity

**Active, no power save.** The CPU runs at full clock and the Wi-Fi receiver
stays on essentially all the time. Latency is the best you will get — the AP can
reach you whenever it wants — and the battery pays for it. Fine on mains, wrong
on a cell.

**Modem sleep (the default Wi-Fi power save).** The CPU keeps running, but the
driver negotiates with the AP to sleep the radio between beacons. The connection
stays *up*: you keep your IP, DHCP lease and TCP state, and the AP buffers
downlink frames until your next listen window. This is the middle ground most
always-on nodes should measure first.

**Light sleep.** The CPU halts between wakeups while RAM and Wi-Fi connection
state are retained. It saves more than modem sleep alone, but wakeups must be
frequent enough to catch the next beacon, and timing-critical tasks need care.
ESP-IDF wires this through `esp_pm` plus FreeRTOS tickless idle, so the scheduler
coordinates it.

**Deep sleep.** Everything except RTC memory is powered down. Current drops to
the microamp range, and you lose *all* state: connection, IP, RAM. On the next
wake you boot from scratch and reconnect — the tax you pay for the low average
current, and whether it is worth paying is the central design question.

## Modem sleep: staying on the network

Modem sleep is the best deal most always-on nodes will find. You stay a
first-class Wi-Fi client — the AP still knows you, still buffers your packets,
still delivers inbound TCP — but your receiver is off most of the time. The
driver exposes this directly:

```c
#include "esp_wifi.h"

/* Default for many apps, but be explicit so the choice is visible. */
ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_MIN_MODEM));

/* More aggressive: spend longer asleep between listen windows.
 * Cheaper on battery, worse on latency. */
// ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_MAX_MODEM));
```

`WIFI_PS_MIN_MODEM` wakes for every beacon and trades less latency for less
saving. `WIFI_PS_MAX_MODEM` listens less often and saves more, at the cost of
responsiveness. Neither drops the connection — the whole point of modem sleep,
and the reason it beats deep sleep for anything that must receive unprompted
traffic: a command topic, a doorbell, a home-automation controller. If your
device's job is to *be reachable*, you want modem sleep, not deep sleep.

## DTIM, listen intervals, and the latency/battery tradeoff

The access point is the other half of this negotiation. Beacons go out at a fixed
interval (commonly around 100ms), and every so often a beacon is a **DTIM** — a
Delivery Traffic Indication Message — which is when the AP flushes buffered
broadcast and multicast frames and tells sleeping clients "wake now, there is
traffic for you". A client's **listen interval** says how many beacons it may
skip between listens.

The arithmetic is simple: the longer your listen interval and the more DTIM
periods you skip, the longer your radio stays off and the lower your average
current — but the higher your latency, because downlink traffic waits in the AP's
buffer until your next window. On a typical home AP the beacon/DTIM periods are
tens to a couple hundred milliseconds; you do not control the AP side, only how
eagerly you observe it. You can nudge the client side through the station config:

```c
#include "esp_wifi.h"

wifi_config_t cfg = { 0 };
cfg.sta.listen_interval = 3;          /* skip up to this many beacons */
cfg.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
/* ... set ssid/password, then: */
ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &cfg));
```

Turning that knob up is the "low power Wi-Fi" trade: every skipped beacon is
battery saved and milliseconds added to your worst-case downlink latency. A
sensor that reports outward barely cares — be aggressive. An interactive node
should measure the delay users actually notice before tuning for power.

## ESP32 deep sleep and the reconnect cost

Deep sleep is the only mode that reaches the microamp floor, and it charges you a
full boot and reconnect on every wake. That cost is not one number but several:
radio wake and calibration, scanning, association, the four-way handshake, then
DHCP (or a static address to skip it) and DNS. In wall-clock terms it is often
seconds, and for most of that time the radio is burning power. Wake every ten
minutes and the reconnect energy can dominate the whole budget — so the right
question is not "how deeply can I sleep?" but "how rarely can I wake?".

```c
#include "esp_sleep.h"
#include "esp_log.h"

RTC_DATA_ATTR static int s_boot_count;  /* survives deep sleep */

void app_main(void)
{
    esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
    ESP_LOGI("power", "wake %d, cause %d", ++s_boot_count, (int)cause);

    /* ... connect, read the sensor, publish, disconnect ... */

    esp_sleep_enable_timer_wakeup(10ULL * 60 * 1000000);  /* 10 minutes */
    esp_deep_sleep_start();  /* does not return */
}
```

`RTC_DATA_ATTR` is the only RAM that survives; everything else is rebuilt on
wake. The sketch above is deliberately naive: a real device backs off, caches the
BSSID and channel to shorten the scan, and uses a static IP to skip DHCP. That is
where the honest engineering time goes.

## Measuring real current (a cheap way to profile)

You cannot optimize what you do not measure, and measuring is easier than it
sounds. The cheapest honest setup is a USB power meter or an inline shunt plus a
multimeter; it will not show microsecond TX spikes, but it shows the average,
which is what battery life depends on. For real precision, a current-profiling
tool (a Nordic PPK2, an INA219/INA260 breakout, a Joulescope) gives you a
waveform and lets you *see* the TX bursts and reconnect storms.

Whatever the instrument, the method is the same: measure one firmware in each
configuration — active, `WIFI_PS_MIN_MODEM`, `WIFI_PS_MAX_MODEM`, deep-sleep duty
cycle — over a few minutes and compare the *averages*. This is why I refuse to
invent numbers: a board's LDO quiescent draw, an unpopulated LED, a USB-UART
bridge that never sleeps, or a floating strapping pin can dominate the chip's own
sleep current. Your measurement is the truth; datasheet tables are a starting
point.

## Design guidance for low power Wi-Fi

Three shapes cover almost every battery ESP32-C3 project, and picking the right
one matters more than any single register tweak.

**Duty-cycled sensor (report periodically, never receive).** Use **deep sleep**
with a timer wake. Connect, publish, disconnect, sleep. Be aggressive: long
sleep intervals and a static IP. The average current is dominated by the *reconnect*
energy, so shorten the wake as much as possible and widen the period.

**Always-listening node (must receive unprompted).** Use **modem sleep**, not
deep sleep. You need the connection to persist, so the win is longer listen
intervals and fewer wakeups — but you can never reach deep-sleep currents because
the radio must keep checking in. This is the mode for controllers and anything
with a command channel.

**Mains-powered.** Stop optimizing. Run active mode with power save off and take
the lowest latency. Adding power saving here buys nothing and costs
responsiveness. The one thing worth doing is not wasting power: turn off unused
peripherals and LEDs.

In ESP-IDF, dynamic frequency scaling and automatic light sleep are configured
once through `esp_pm` — separate from the Wi-Fi power-save setting, coordinated
with FreeRTOS tickless idle:

```c
#include "esp_pm.h"
#include "esp_log.h"

void configure_dynamic_power(void)
{
    esp_pm_config_t pm = {
        .max_freq_mhz = 160,      /* peak the CPU only when there is work */
        .min_freq_mhz = 10,       /* drop the clock when idle */
        .light_sleep_enable = true,
    };
    ESP_ERROR_CHECK(esp_pm_configure(&pm));
}
```

This needs power management plus tickless idle enabled in `menuconfig`; the exact
paths move between releases, so look under *Component config* rather than
memorizing them. `esp_pm` and `esp_wifi_set_ps()` are partners, not alternatives
— the first governs the CPU and light sleep, the second the radio.

## What I would do first

Start by measuring the default: flash your always-connected firmware and watch
the average current — that baseline is usually worse than you expect. Then pick
which of the three shapes you are, apply exactly the mode it calls for, and
measure again. Modem sleep plus a longer listen interval is the cheapest large
win for anything that must stay reachable; deep sleep is deepest, but only if the
device truly does not need to be present between reports. Saving power on the
device is only half the design — as my
[ESP32-C3 EasyTier node](/posts/esp32-easytier-node-in-c/) shows, the server has
to tolerate a client that vanishes and returns. The surrounding ESP-IDF code
lives in the [getting started guide](/posts/esp32-c3-getting-started/).
