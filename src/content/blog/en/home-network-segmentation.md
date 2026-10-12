---
title: "Home network segmentation: why, and how far to go"
description: "A practical guide to home network segmentation: the real risks from IoT gear and lateral movement, the options ranked from a free guest network to a VLAN home network with a managed switch, a concrete topology, firewall rules, and an honest take on how far to go."
pubDate: 2026-11-04
lang: en
translationKey: home-network-segmentation
tags: [networking, security, homelab]
featured: false
keywords:
  - home network segmentation
  - VLAN home network
  - IoT VLAN
  - firewall rules
  - guest network
---

Your home network is probably flat. One Wi-Fi password, one subnet, and everything
on it — laptops, phones, the thermostat, the robot vacuum, a cheap IP camera, three
Raspberry Pis, and the NAS that holds every photo you have ever taken. That
works fine, right up until one device is compromised, and then it does not. This
post is about **home network segmentation**: what it actually buys you, the
options ranked from free to serious, and — the part most write-ups skip — where
to stop. I will argue that a **guest network** and one lab segment get you 80% of
the value, and that the rest is often over-engineering.

## The threats and annoyances that actually matter

### IoT devices that phone home

A smart plug does not need to reach your laptop. It needs power and a
cloud endpoint, usually over plain, unauthenticated HTTP. Yet on a flat network
it can scan every host, hit your NAS on port 445, and probe the admin page of
your router. The fix is not "trust the vendor" — it is to give these devices
a network where the only things they can reach are the internet and their own
kind.

### A compromised camera

The cheapest cameras are famous for this. Default credentials, forgotten
firmware from 2019, a cloud AI feature you never asked for. When one is popped,
what matters is not that it died — they all do eventually — but **what it can
reach next**. On a flat network: everything. On a segmented one: a small **IoT
VLAN** where the worst it can do is join a botnet and reboot itself.

### Lateral movement

This is the real reason to segment. An attacker rarely wins in one jump. They land
on the weakest device, then move sideways: from the camera to the NAS, from the
NAS to your unlocked laptop, from the laptop to your password manager. Each hop
requires them to see and reach the next host. Segmentation removes the paths,
because a firewall rule that says "IoT cannot initiate to Trusted" is a wall that
lateral movement cannot cross.

### Guest access

Guests want Wi-Fi. You do not want their phone — patched or not, running whatever
they installed last week — browsing your LAN. A **guest network** is the cheapest
segmentation there is and it is worth it for this alone.

### Keeping labs off family devices

The other, quieter threat: *you*. A lab box running a vulnerable service you
deliberately broke, a router you are reflashing at 11pm, a broadcast storm from a
misconfigured VM. Family devices should not be collateral damage of your hobby.
Segmentation is as much about blast radius as it is about attackers.

## The options, cheapest to serious

### Option 1 — Guest SSID on the existing router (free, 10 minutes)

Most consumer routers already have a guest-network toggle. Turn it on. By default
it isolates guests from the main LAN and from each other, which is exactly what
you want for visiting phones. If your router lets you point it at a separate
subnet, even better. This is the highest value-per-minute move in the entire
post, and you should do it today.

What it does not give you: control. There is usually no rule editor — guests are
isolated or they are not. And it does nothing for your own IoT gear, which sits on
the main LAN with your laptop.

### Option 2 — A second router (cheap, real separation)

Put a second router (any OpenWrt-capable box, an old spare, a mini-PC) behind your
main one and hang the lab or IoT gear off it. Now you have two routed subnets and
a real **firewall** in between, with **firewall rules** you actually control. It
is the poor man's segmentation: no VLANs, no managed switch, and it works.

The cost is NAT: the inner router hides everything behind it, so reaching a lab
service from your laptop needs a port-forward or a route. That is annoying but
survivable, and if you only need the lab to reach *out*, it is perfect.

### Option 3 — VLAN home network with a managed switch + AP

This is the "proper" answer, and it needs three things to line up:

- A **router/firewall** that supports VLAN interfaces (OpenWrt, OPNsense, pfSense,
  a UniFi gateway).
- A **managed switch** that speaks 802.1Q, so one physical port can carry several
  VLANs as a trunk.
- An **access point that maps multiple SSIDs to multiple VLANs** — this is the
  piece people forget. A cheap AP will happily broadcast "MyNet" and
  "MyNet-Guest" and hand both to the same untagged LAN. If the AP cannot tag each
  SSID with a VLAN ID, Wi-Fi segmentation never happens, no matter how good your
  switch is.

Get all three and you have true **VLAN home network** isolation: devices on
different subnets, sharing switches and cables, kept apart by 802.1Q tags and
firewall policy. This is where most homelabbers land, and it is the right ceiling
for most people.

### Option 4 — Overlay-based separation

Instead of segmenting the physical LAN, you build a virtual one on top. An overlay
VPN — EasyTier, Tailscale, WireGuard tunnels — puts machines on their own private
address space with its own access rules, independent of whatever the physical
network looks like. I use this constantly; see
[a private mesh VPN with EasyTier](/posts/private-mesh-with-easytier/) for the
pattern. Overlays are great for reaching lab machines, and they compose well with
per-node policy.

Two caveats. First, an overlay is a *layer on top* — if an IoT device is already
on your flat LAN, putting your laptop on a mesh does not stop the camera from
scanning the NAS. You have added a path, not removed one. Second, overlays
themselves have to traverse NAT; if that ever fails, the mechanics are in
[NAT traversal, explained](/posts/nat-traversal-explained/). Use overlays to
connect *your* trusted machines, and VLANs to wall off *untrusted* ones.

## A concrete topology

Four segments: Trusted, IoT, Lab, Guest. One trunk from the firewall down to a
managed switch and an AP.

```
                       Internet
                          │
                    ┌─────┴─────┐
                    │  modem /  │
                    │  ONT      │
                    └─────┬─────┘
                          │ WAN
                   ┌──────┴────────┐
                   │ Edge firewall │   (OPNsense / OpenWrt)
                   │  802.1Q trunk │
                   └──┬────────┬───┘
                 trunk│        │trunk
            ┌─────────┴──┐  ┌──┴─────────┐
            │ managed    │  │  Wi-Fi AP  │
            │ switch     │  │ SSID→VLAN  │
            └─┬───┬───┬──┘  └──┬─────┬───┘
              │   │   │        │     │
        VLAN10│   │   │        │     │
      (wired) │   │   │        │     │
              │   │   │        │     │
           ┌──┴┐ ┌┴──┐ ┌┴──┐   │     │
           │NAS│ │Pi │ │PC │   │     │
           └───┘ └───┘ └───┘   │     │
                               │     │
                        VLAN10 │     │ VLAN20
                      (Trusted)│     │ (IoT)
                               │     │
                          ┌────┴┐ ┌──┴───────┐
                          │phone│ │cameras,  │
                          │laptop│ │plugs, TV │
                          └─────┘ └──────────┘

  VLAN 10 Trusted  — laptops, phones, NAS          (full internet, limited cross)
  VLAN 20 IoT      — cameras, plugs, TV            (internet only, no LAN)
  VLAN 30 Lab      — servers, dev boxes            (internet, reachable from Trusted)
  VLAN 40 Guest    — visitor devices               (internet only, isolated)
```

The AP broadcasts four SSIDs, each tagged to its VLAN. Wired lab machines sit on
tagged ports; the NAS lives on Trusted so it stays reachable.

## Firewall rules example

The model is **default deny** on the forward chain, plus two policies: IoT can
reach the internet but never the LAN, and Trusted can initiate to Lab but not the
reverse. Here is an nftables sketch:

```
table inet filter {
  chain forward {
    type filter hook forward priority 0; policy drop;

    # let replies and pinned connections through
    ct state established,related accept

    # Trusted: full internet
    iifname "vlan10" oifname "wan0" accept
    # Trusted -> Lab: I can reach my servers
    iifname "vlan10" oifname "vlan30" accept
    # Lab -> Trusted: only as a reply (see established,related above)
    # Lab: internet
    iifname "vlan30" oifname "wan0" accept
    # IoT: internet, nothing else
    iifname "vlan20" oifname "wan0" accept
    # Guest: internet only, isolated
    iifname "vlan40" oifname "wan0" accept

    # everything else (IoT->LAN, Guest->LAN, Lab->Trusted new) is dropped
  }
}
```

Read it top to bottom and the whole point of segmentation is visible: the IoT and
Guest rules go to `wan0` and nowhere else. A camera that gets owned has one exit,
to the internet, and zero paths to your NAS. That is **lateral movement** stopped
by four lines.

The classic gotcha here is discovery: Chromecast, AirPlay, and mDNS/SSDP broadcasts
do not cross VLAN boundaries. Casting from your phone (Trusted) to a TV (IoT) will
just break. The fix is an mDNS repeater or IGMP proxy, or — the pragmatic choice —
put the TV on Trusted and only the genuinely untrusted devices on IoT.

## The costs, honestly

- **Managed gear.** A managed 8-port switch and a VLAN-capable AP are real money —
  roughly $100–$300 combined for decent UniFi/Omada/Aruba Instant On kit. Your
  existing ISP router almost certainly cannot do this.
- **APs that tag SSIDs.** Confirm before buying. "Multiple SSIDs" is not the same
  as "multiple SSIDs mapped to VLANs," and the datasheet will not spell it out.
- **Maintenance.** Every new device is a decision: which VLAN? Chase a broken cast
  once and you will understand why flat networks survive in most homes. Add
  per-VLAN DHCP, DNS, and IPv6 router advertisements and it is a small project,
  not an afternoon.
- **Debugging.** When something cannot reach something, you now check the switch
  config, the trunk tagging, the firewall, and the host. That is four places
  instead of one.

## What I actually recommend

Start small and stop when the pain stops.

1. **Today:** turn on the guest network. Free, immediate, isolates visitors.
2. **This weekend:** put your lab (or your IoT junk) behind a second router or its
   own subnet. Two segments, one firewall rule set. This covers the threats that
   actually happen.
3. **Only if you enjoy it, or the device count justifies it:** add VLANs, a managed
   switch, and a tagging AP. Do it to learn, or because you have twenty IoT
   devices — not because a blog post told you to.

Most home networks need two or three segments, not five. A camera on an isolated
VLAN and a guest SSID eliminate the realistic attacks; a tenth VLAN does not. Pick
the smallest segmentation that removes the paths you actually care about, and
spend the saved weekend doing something else.

## The short version

**Home network segmentation** is about blast radius, not perfection. The concrete
threats — IoT devices phoning home, a popped camera, lateral movement, guest
devices, your own lab — are all addressed by a **guest network** plus one isolated
**IoT VLAN** and a default-deny **firewall rules** stance. Guest SSID first, a
second router next, and a full VLAN setup on a managed switch only when you have
the gear, the AP that can tag SSIDs, and the patience to maintain it. Segment to
the point where the realistic attacks fail, then stop.
