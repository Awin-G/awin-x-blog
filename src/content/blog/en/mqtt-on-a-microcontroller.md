---
title: "What actually fits: running an MQTT ESP32 stack on a constrained microcontroller"
description: "MQTT fits a microcontroller's budget better than most IoT messaging stacks — a two-byte minimum header, publish/subscribe decoupling, and QoS you can dial down. Here is what an MQTT ESP32 system actually costs once TLS, certificates and reconnects enter the picture."
pubDate: 2026-10-31
lang: en
translationKey: mqtt-on-a-microcontroller
tags: [esp32, embedded, networking]
featured: false
keywords:
  - MQTT ESP32
  - MQTT microcontroller
  - esp-mqtt
  - IoT messaging
  - QoS
---

Every few months someone asks me to put "just a little" MQTT on a board: a sensor
that reports a temperature, a relay a dashboard can flip. The instinct is to reach
for the same stack you would run in a container, and that instinct is wrong —
**MQTT on microcontroller** hardware is not hard because the protocol is heavy; the
protocol is remarkably light. It is hard because of everything wrapped around it:
TLS, certificates, clocks and reconnects. For **IoT messaging** it remains one of
the few protocols that genuinely fits an MCU. The
[ESP32-C3 getting started notes](/posts/esp32-c3-getting-started/) cover the
toolchain if you need it.

## Why MQTT on microcontroller hardware fits IoT messaging

MQTT wins on MCUs for structural reasons, not because it is fashionable:

- **The header is tiny.** The fixed header is two bytes minimum: one control byte
  and a remaining-length field that is one byte for any payload under 128 bytes. A
  `PUBLISH` carrying a single sensor reading is smaller than an HTTP request line.
- **Publish/subscribe decouples the device.** A device publishes to a topic and
  forgets; it does not care whether one dashboard, ten, or nobody is listening. A
  device that also needs commands subscribes to its own command topic.
- **QoS is a dial, not a switch.** You choose per message how much delivery
  guarantee to buy, from "fire and forget" to an acknowledged handshake.
- **It survives bad links by design.** Keepalive, the last will, retain and clean
  sessions all exist to make an unreliable edge plausible to a reliable core.

The protocol needs little: a TCP socket, a timer, a handful of bytes of state per
connection. The trouble is that almost nobody runs MQTT alone.

## The MQTT ESP32 memory reality: what a TLS connection really costs

On an **MQTT ESP32** deployment the MQTT layer itself is cheap; TLS is the bill,
and the handshake is the largest single allocation your firmware will ever make.

- **MQTT packet buffers** are small and bounded. You size an in-buffer and an
  out-buffer, and with an `esp-mqtt` default of a couple of KB each you can hold a
  payload far larger than any sane sensor message.
- **The TLS handshake is a transient spike.** mbedTLS needs record buffers in both
  directions *plus* scratch space while it computes the session. Peak handshake
  heap is comfortably an order of magnitude larger than the MQTT buffers, and it
  fails only when a task stack or the DNS cache is also holding memory.
- **Steady state is smaller but not free.** Once the session is up, the inbound and
  outbound record buffers stay resident alongside the socket and the MQTT task
  stack: several KB of heap committed for as long as the session lives.
- **Keepalive keeps it alive.** You pay that heap continuously, so the interval
  matters. Set keepalive below the path's NAT and firewall idle timeouts (often
  60–120 seconds) without sending `PINGREQ` for no reason. Enable session
  resumption and TLS session tickets: a reconnect that reuses a ticket skips the
  expensive handshake.

So open the TLS session when you need it, keep the handshake margins in your
free-heap budget, and never let it run when heap is already stressed. Measure your
worst case with `esp_get_free_heap_size()` around the connect and treat it as a
hard floor: the spike depends on cipher suite, chain length and buffer sizes.

## Bringing up esp-mqtt in ESP-IDF

The ESP-IDF MQTT client is a thin wrapper over the protocol, and its configuration
struct is where you encode almost every decision in this article. This is a
complete, minimal bring-up with TLS, a stable client id, keepalive and last will:

```c
#include "mqtt_client.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"

static esp_mqtt_client_handle_t s_client;

static void mqtt_event_handler(void *args, esp_event_base_t base,
                               int32_t event_id, void *event_data);

esp_mqtt_client_handle_t mqtt_start(const char *uri)
{
    const esp_mqtt_client_config_t cfg = {
        .broker = {
            .address = { .uri = uri },   // "mqtts://broker.example:8883"
            .verification = { .crt_bundle_attach = esp_crt_bundle_attach },
        },
        .credentials = {
            .client_id = "sensor-a17",   // stable and unique per device
            .authentication = {
                .certificate = (const char *)client_crt_pem, // mTLS, if used
                .key         = (const char *)client_key_pem,
            },
        },
        .session = {
            .keepalive = 60,             // seconds; stay under NAT idle timeouts
            .disable_clean_session = false,
            .last_will = {
                .topic   = "fleet/sensor-a17/availability",
                .msg     = "offline",
                .msg_len = 7,
                .qos     = 1,
                .retain  = 1,
            },
        },
        .network = {
            .reconnect_timeout_ms = 5000,
            .timeout_ms           = 10000,
        },
    };
    s_client = esp_mqtt_client_init(&cfg);
    esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID,
                                   mqtt_event_handler, NULL);
    esp_mqtt_client_start(s_client);
    return s_client;
}
```

The event handler is where the honest design lives — and where the most common bug
lives: a hand-rolled reconnect loop on top of a client that already backs off.

```c
static void mqtt_event_handler(void *args, esp_event_base_t base,
                               int32_t event_id, void *event_data)
{
    switch (event_id) {
    case MQTT_EVENT_CONNECTED:
        // Announce ourselves as retained state, then listen for commands.
        esp_mqtt_client_publish(s_client, "fleet/sensor-a17/availability",
                                "online", 0, 1, 1);  // QoS 1, retained
        esp_mqtt_client_subscribe(s_client, "fleet/sensor-a17/cmd/#", 1);
        break;

    case MQTT_EVENT_DISCONNECTED:
        // Do NOT reconnect by hand here. esp-mqtt already backs off and retries;
        // stacking your own loop on top is how you build a reconnect storm.
        break;

    default:
        break;
    }
}
```

## QoS 0 vs 1 vs 2: paying only for what you need

QoS is not a quality dial to "turn up". It is a per-message-class cost: RAM, round
trips, and state you must keep across a reboot.

- **QoS 0 — at most once.** Send and forget. No acknowledgement, no stored state,
  no retry. Use it for high-rate telemetry where a lost sample is harmless because
  the next one is along in a moment. The correct default for sensor streams.
- **QoS 1 — at least once.** The receiver acknowledges with `PUBACK`; the sender
  keeps the message in flight until it arrives and may redeliver. Duplicates are
  possible, so make the payload idempotent — a state change, a counter set to an
  absolute value, not "increment by one". Use it for commands and anything you
  would genuinely miss. It costs one in-flight message slot of RAM and one round
  trip.
- **QoS 2 — exactly once.** A four-way handshake with state on both ends. It is the
  right answer for money moving between brokers and the wrong answer for a battery
  sensor: it doubles the protocol state and adds two round trips for a guarantee
  most sensor data never needed.

The split I ship: **QoS 0 for telemetry, QoS 1 for commands, state and the last
will, QoS 2 almost never.** Keep the in-flight window small — one or two
outstanding messages — because the window is RAM you are holding open.

## Retain and last will: making an unreliable device legible

A device that loses power cannot send a goodbye. Two features paper over that,
and they are worth more than any QoS setting:

**Retain** tells the broker to remember the last message on a topic and hand it to
every new subscriber immediately, so a dashboard shows the current temperature the
instant it connects. Use it for low-rate state and availability topics; do not
retain a high-rate stream, because the broker keeps one copy per retained topic.

**The last will** is a message you register at connect time. If the connection dies
without a clean `DISCONNECT`, the broker publishes it on your behalf. Point it at a
retained availability topic so a device that simply vanished is marked offline
instead of leaving a stale "online" forever:

```text
fleet/<device-id>/availability   # retained "online" / LWT "offline"
```

One caveat that bites people: a *clean* disconnect suppresses the will. If you
shut down on purpose, publish an empty retained message (or "offline") yourself
before disconnecting, or the broker keeps advertising you as online.

## Topic design for many devices

Topics are a hierarchy, and their layout decides how cheap subscriptions are and
how safely you can use wildcards across a fleet.

```text
fleet/<device-id>/state        # retained JSON: last known state
fleet/<device-id>/availability # retained "online"/"offline" (LWT target)
fleet/<device-id>/telemetry    # QoS 0, high rate
fleet/<device-id>/cmd/#        # device subscribes; broker routes commands in
$SYS/broker/...                # broker health — dashboards read, devices do not
```

Rules I have settled on:

- **Put the variable at the end.** `fleet/sensor-a17/telemetry` lets a dashboard
  subscribe to `fleet/+/telemetry` cheaply; a topic where the device id is last
  defeats every wildcard.
- **Devices publish into their own namespace and subscribe only to their own
  command topic.** Never let a device subscribe to `#`.
- **Keep the payload small and self-describing.** Put units and timestamps in the
  message, not in an ever-deeper topic. A topic is a routing address, not a schema.
- **Use `$share` groups when several backend workers must load-balance a
  subscription**, instead of each worker subscribing separately.

## The failure modes you only see in production

### Reconnect storms

A site-wide power cut reboots every device at once, and they all reconnect on the
same schedule, pointed at the same broker. The broker hits its connection limit,
devices fail, back off, and retry in lockstep forever. Fix it on both sides:
configure `reconnect_timeout_ms`, add jitter to your own retry timing so the fleet
does not move as one flock, and cap the broker's `max_connections` so it degrades
instead of dying.

### Broker backpressure and queues

MQTT gives a publisher no flow control beyond TCP. A slow subscriber with QoS 1
makes the broker queue messages for it; when the queue fills, the broker drops —
which is correct, but silent if you are not watching. Keep `max_queued_messages`
bounded, keep QoS 1 off high-rate topics, and watch `$SYS/broker/messages/*` so a
persistent subscriber never looks healthy while it is being flooded.

### The clock has to be right before TLS does anything

A freshly booted ESP32 believes it is 1970, so every certificate looks "not yet
valid" and the handshake fails for a reason that has nothing to do with your
credentials. Synchronise time *before* you open a TLS connection:

```c
#include "esp_sntp.h"
#include <time.h>

static bool time_is_plausible(void)
{
    setenv("TZ", "UTC0", 1);
    tzset();
    esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, "pool.ntp.org");
    esp_sntp_init();

    time_t now = 0;
    // Wait, bounded, for a clock past 2025 — then certs can validate.
    for (int i = 0; i < 100 && now < 1735689600; ++i) {
        vTaskDelay(pdMS_TO_TICKS(100));
        time(&now);
    }
    return now >= 1735689600;
}
```

If you genuinely cannot reach an NTP server, pin the broker certificate or its
public-key hash instead — but do not "fix" the clock by disabling verification.
That trades a flaky handshake for a silent man-in-the-middle.

### mTLS certificate storage

Per-device client certificates sound clean and get awkward fast. The certificate
and private key have to live on flash, which means NVS or an embedded PEM string.
A private key baked into firmware is one shared secret across every unit and is
trivially extractable from a firmware dump; a key provisioned into NVS at
manufacturing is better, but only meaningful with flash encryption and secure boot
enabled. Plan for rotation before you ship a thousand units, and ship one CA
certificate rather than a whole browser-style trust bundle — the bundle is RAM and
flash you do not need.

## The broker side: Mosquitto basics

None of the device work matters if the broker is a default install. Mosquitto is
small enough to reason about, and a locked-down listener is a handful of lines:

```conf
# /etc/mosquitto/conf.d/site.conf
listener 8883
allow_anonymous false
password_file /etc/mosquitto/passwd
acl_file      /etc/mosquitto/acl

cafile       /etc/mosquitto/certs/ca.crt
certfile     /etc/mosquitto/certs/broker.crt
keyfile      /etc/mosquitto/certs/broker.key
require_certificate true          # enable this only for mTLS

persistence true
persistence_location /var/lib/mosquitto/

# Blast-radius limits: the broker degrades instead of dying
max_connections     500
max_queued_messages 1000          # bounded; beyond this the broker drops
```

The ACL file is what makes "many devices" safe: give each device id write access
to `fleet/<id>/#`, read access to `fleet/<id>/cmd/#`, and deny everything else by
default. Then test with exactly the credentials a device would use:

```bash
# Subscribe the way a device would, with the same certs and QoS.
mosquitto_sub -h broker.example -p 8883 \
  --cafile ca.crt --cert client.crt --key client.key \
  -t 'fleet/+/availability' -q 1 -v

# A retained availability message arrives instantly for a fresh subscriber.
mosquitto_sub -h broker.example -p 8883 --cafile ca.crt \
  -t 'fleet/sensor-a17/availability' -C 1 -v
```

## What actually fits

The honest summary is short. The protocol fits easily — a two-byte header and a
handful of bytes of connection state are nothing on an ESP32. The **esp-mqtt**
client fits, as long as you respect the TLS handshake spike and do not hand-roll
reconnection. QoS 0 and QoS 1 cover essentially every real fleet; QoS 2 is a
promise you rarely need and always pay for. Retain and the last will do more for
operational sanity than any delivery guarantee. The failures that will actually
page you are boring ones: a clock that is wrong before TLS, a private key on flash
with no encryption, and a thousand devices reconnecting in lockstep.

Everything above happens *over* the network, which means the network underneath
matters just as much. If your broker answers on an overlay rather than a public
hostname, the same constraints show up there too — [putting an ESP32-C3 on an
overlay as a real node](/posts/esp32-easytier-node-in-c/) is a longer story about
what that costs. Pick a small surface, automate it, and be honest about where the
subset ends.
