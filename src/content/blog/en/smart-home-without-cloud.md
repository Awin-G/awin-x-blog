---
title: "A local smart home: no cloud smart home with Home Assistant and Zigbee"
description: "Why cloud-default smart homes are a liability, how a local smart home with Home Assistant, Zigbee, Z-Wave and local MQTT works, how to pick devices that survive if the vendor dies, and the honest hard parts nobody mentions."
pubDate: 2026-12-01
lang: en
translationKey: smart-home-without-cloud
tags: [self-hosting, homelab, networking]
featured: false
keywords:
  - local smart home
  - Home Assistant
  - no cloud smart home
  - Zigbee
  - Matter
---

I have run both kinds of smart home. First the aisle-of-plastic version: a
handful of Wi-Fi bulbs and plugs, each with its own app, each with an account, each
phoning home. Then, after the third "server is unreachable" weekend, I tore it out
and built a **local smart home**: one hub on my own network, **Zigbee** devices that
talk to it directly, **MQTT** for the clever stuff, and no vendor account anywhere.
This is why I did it, how a **no cloud smart home** actually works, and — because I
am not selling you anything — the parts that are still genuinely hard.

## Why cloud-default smart homes are a liability

The default smart home is a leased one. You buy the hardware, but the vendor keeps
the keys: the brain is a server you do not own, in a region you did not choose, on a
schedule you cannot see.

- **Outages are your problem now.** When the vendor's backend hiccups, your lights
  stop responding to the app — even though the light is three feet away and your
  network is fine. I have had a house where the wall switch worked and the "smart"
  part did not, which is a genuinely worse experience than no smart home at all.
- **EOL hubs brick what you bought.** This is the ugly one. Companies fold, or decide
  a hub generation is done, and a firmware kill-switch turns working hardware into
  e-waste. Your devices were never yours; you were renting access to them.
- **Privacy is the default tax.** A cheap camera is a lens in your living room with a
  vendor-side AI pipeline. Even without malice, you are trusting the vendor's
  retention policy, their breach history, and their contractors. Some of it is
  legitimate — but you never got to decide.
- **Subscriptions.** Motion alerts, cloud recordings, "advanced" scenes: features that
  run perfectly well on a chip the size of your thumbnail, gated behind a monthly fee.
- **No local control.** The worst one. If the internet is down, the cloud is down,
  and your "smart" home is a set of dumb devices with broken apps.

None of these are hypothetical. They are all the same root cause: the control plane
lives somewhere you do not control.

## What a local-first smart home actually looks like

The local-first version inverts the diagram. Devices talk to a hub on your LAN, the
hub talks to your phone, and the internet becomes an optional extra instead of a
dependency.

<figure>
  <svg viewBox="0 0 720 260" role="img" aria-labelledby="local-title local-desc" xmlns="http://www.w3.org/2000/svg">
    <title id="local-title">Local smart home topology: devices talk to a local hub over Zigbee, Z-Wave or Matter</title>
    <desc id="local-desc">Sensors, plugs and bulbs connect wirelessly to a Home Assistant hub on the local network. The hub serves phones and dashboards locally, and the internet is an optional branch, not a requirement.</desc>
    <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <!-- devices -->
      <rect x="20" y="30" width="110" height="36" rx="6"/>
      <rect x="20" y="92" width="110" height="36" rx="6"/>
      <rect x="20" y="154" width="110" height="36" rx="6"/>
      <!-- hub -->
      <rect x="250" y="80" width="150" height="60" rx="8" stroke-width="2.5"/>
      <!-- local clients -->
      <rect x="500" y="30" width="120" height="36" rx="6"/>
      <rect x="500" y="110" width="120" height="36" rx="6"/>
      <!-- internet -->
      <rect x="500" y="196" width="120" height="36" rx="6" stroke-dasharray="5 4"/>
      <!-- links devices -> hub -->
      <path d="M130 48 C 190 48, 200 100, 250 104"/>
      <path d="M130 110 C 190 110, 200 110, 250 110"/>
      <path d="M130 172 C 190 172, 200 120, 250 116"/>
      <!-- links hub -> local -->
      <path d="M400 100 C 450 100, 460 48, 500 48"/>
      <path d="M400 112 C 450 112, 460 128, 500 128"/>
      <!-- optional internet -->
      <path d="M400 128 C 450 128, 470 214, 500 214" stroke-dasharray="5 4"/>
    </g>
    <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
      <text x="75" y="53">Sensors</text>
      <text x="75" y="115">Plugs</text>
      <text x="75" y="177">Bulbs</text>
      <text x="325" y="105">Home</text>
      <text x="325" y="123">Assistant</text>
      <text x="560" y="53">Phone</text>
      <text x="560" y="133">Dashboard</text>
      <text x="560" y="219">Internet (optional)</text>
    </g>
  </svg>
  <figcaption>Devices, a local hub, your own clients — the cloud is a branch you can pull, not a wire you depend on.</figcaption>
</figure>

The pieces:

- **A local hub.** **Home Assistant** on a small mini-PC or a dedicated appliance is
  the common answer. It runs on my network, its database is a file I back up, and it
  keeps working when my ISP does not. It also speaks every protocol at once, which
  matters because no single radio covers a house well.
- **Zigbee** (and **Z-Wave**) for the mesh. These run on their own radios, usually on
  a USB stick plugged into the hub, and form a **self-healing mesh** — every
  mains-powered device repeats for its neighbors. They do not use your Wi-Fi, so a
  house full of sensors does not turn your 2.4 GHz band into soup. A $30 stick and a
  coordinator are the entire infrastructure.
- **Local MQTT.** **MQTT** is the lingua franca for devices the hub cannot speak to
  natively: ESP32 boards, DIY sensors, Zigbee2MQTT bridges, anything you flash
  yourself. Point a broker at `localhost`, and your devices publish state to a topic
  tree you own. If you want the pattern for the small end, see
  [MQTT on a microcontroller](/posts/mqtt-on-a-microcontroller/).
- **No vendor account.** The rule I hold to: if onboarding a device requires me to
  create an account on someone's website, it is not going in. A local hub lets you
  enforce that.

## The "will it still work if the vendor dies?" test

This is the single most useful filter when buying, and almost nobody runs it. Before
you buy, ask three questions:

1. **Does it still work offline?** Unplug your WAN cable, then try to turn the light
   on. If the app hangs on a spinner, the product is a thin client for someone's
   server, not a smart device.
2. **Can a local controller talk to it without the vendor?** If it speaks **Zigbee**,
   **Z-Wave**, or **Matter** over a local thread, you can pair it to your own hub and
   the vendor's cloud is irrelevant. If it only speaks "vendor cloud over HTTPS," walk
   away.
3. **What happens at EOL?** Look for a product that either exposes a local API or has
   a documented path to keep functioning — not one where the app is the only control
   surface.

The practical winner is boring: **Zigbee** sensors, plugs, and bulbs are cheap,
battery-friendly, and nearly all of them pair to a local coordinator. Bonus points if
you avoid the vendor's own hub entirely.

## The honest hard parts

I would not respect a post that only sold the dream. Here is what still hurts:

- **Matter is not automatically local.** Matter is a real improvement — a shared
  application layer so devices and controllers interoperate — but it says nothing
  about where the *controller* lives. Many "Matter" products still want a vendor app,
  a vendor account, and a cloud fabric for setup, remote access, or firmware. Pairing
  one to Home Assistant over your local Thread border router is genuinely local; using
  the vendor's app is not. Same protocol, different topology. Read the fine print.
- **Firmware updates.** Going cloud-free means you own patching. Some devices update
  over Zigbee via your coordinator; some need the vendor app; some *never* update,
  which is a security decision you are now making. It is a real chore — and it is the
  same chore you were already trusting a vendor to do for you, just visible now.
- **Voice assistants want the cloud.** Alexa and Google are cloud services, full stop.
  You can bridge your local hub to them (Home Assistant has integrations), but when
  the bridge dies or the vendor changes terms, the voice control dies with it. Local
  voice is getting better but is still an enthusiast project. If voice is
  non-negotiable, accept that the mic is a cloud device and wall it off accordingly.
- **Wi-Fi device spam.** Every cheap Wi-Fi bulb is another 2.4 GHz station, another
  DHCP lease, another thing with a vendor-tracking SDK. Ten of them and your router's
  client table looks like a small office. This is a strong argument for Zigbee: the
  radios do not touch your Wi-Fi, and the hub presents one clean interface.

## Network implications

A local hub does not remove the network question; it changes it. Your hub, your
broker, and any DIY devices should live on a segment that is not your phone's,
because "local" does not mean "trusted" — it means "controlled by me." Give the hub
and its devices their own **IoT VLAN**, allow outbound internet only where you need
it, and let your trusted devices reach the hub by rule rather than by flat-network
proximity. I wrote the whole pattern in
[home network segmentation](/posts/home-network-segmentation/); the short version is
one isolated segment, default-deny between it and your laptops, and a small allow
list for the hub's own outbound calls (time sync, updates, and the voice bridge if
you keep one).

## A pragmatic starter path

You do not need to rebuild your house in a weekend.

1. **Buy a hub and a radio.** A mini-PC or a supported SBC running **Home
   Assistant**, plus a **Zigbee** USB coordinator. That is the whole foundation.
2. **Start with one device class.** Plugs or temperature sensors. Add two or three,
   confirm they survive a WAN unplug, then expand. Zigbee infrastructure scales by
   adding mains-powered repeaters, so buy a couple of smart plugs early.
3. **Add MQTT when you hit a wall.** The moment you have an ESP32 or a device with no
   native integration, stand up a broker and bridge it.
4. **Segment the network.** One IoT VLAN for the hub and its friends, one rule set.
5. **Only then think about voice.** And only with eyes open about where the audio
   goes.

Here is the config snippet I actually use to keep a Zigbee2MQTT bridge and a local
sensor on the same broker, with a dedicated topic prefix so nothing leaks into my
other services:

```yaml
# docker-compose.yml (excerpt) — local-only MQTT for the smart home
services:
  mosquitto:
    image: eclipse-mosquitto:2
    restart: unless-stopped
    ports:
      - "127.0.0.1:1883:1883"   # bind to loopback, not 0.0.0.0
    volumes:
      - ./mosquitto:/mosquitto/config

# mosquitto/config/mosquitto.conf
#   listener 1883 127.0.0.1
#   allow_anonymous false
#   password_file /mosquitto/config/passwd

# zigbee2mqtt/configuration.yaml (excerpt)
mqtt:
  server: mqtt://127.0.0.1:1883
  base_topic: zigbee2mqtt
  user: zigbee
  password: !secret mqtt_password
homeassistant:
  discovery_topic: homeassistant
frontend:
  port: 8081
```

Two details earn their keep there: the broker binds to `127.0.0.1` so nothing on the
LAN can reach it unless I let it, and `base_topic` keeps the smart home's traffic in
its own namespace. Local-first is not just a topology; it shows up in the defaults.

## The short version

A **no cloud smart home** is not about hating the cloud. It is about putting the
control plane on hardware you own, so an outage, an acquisition, or a fee change does
not reach into your hallway. Buy a hub, run **Home Assistant**, prefer **Zigbee** and
local **MQTT** over vendor apps, and run the "will it work offline?" test on every
device before you pay. Be honest that **Matter** can still be cloud-flavored, that you
now own firmware updates, that voice assistant integrations re-import the cloud you
left, and that a flat network of Wi-Fi gadgets is its own mess. Then segment it, start
with three sensors, and stop when your house gets boring. Boring is the goal — boring
means it works when the internet does not.
