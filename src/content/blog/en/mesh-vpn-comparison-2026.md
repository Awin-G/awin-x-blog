---
title: "Mesh VPN comparison 2026: Tailscale vs ZeroTier, NetBird, Nebula, EasyTier"
description: "A mesh VPN comparison for 2026 — Tailscale vs ZeroTier, plus NetBird, Nebula and EasyTier — judged on control plane, data plane, L2 vs L3, NAT traversal, self-hosting and lock-in. No stale pricing tables, just the tradeoffs that decide a self-hosted VPN."
pubDate: 2026-10-15
lang: en
translationKey: mesh-vpn-comparison-2026
tags: [networking, self-hosting, homelab, easytier]
featured: true
keywords:
  - mesh VPN comparison
  - Tailscale vs ZeroTier
  - self-hosted VPN
  - WireGuard overlay
  - EasyTier
---

Someone asks me which mesh VPN to run roughly once a month, and the honest
answer is that a **mesh VPN comparison** in 2026 is less about features and more
about one question: *who owns the coordination server?* **Tailscale vs
ZeroTier** gets framed as a horse race, but the real fork in the road is whether
you accept a hosted control plane or insist on a **self-hosted VPN**. Underneath,
most of these tools are a **WireGuard overlay** with different membership models
— except the ones that *aren't* WireGuard at all, which is exactly where the
interesting tradeoffs live. This is the comparison I wish existed: Tailscale,
ZeroTier, NetBird, Nebula and **EasyTier**, ordered by architecture rather than by
a feature matrix that changes every quarter.

Disclosure, because it's relevant: this blog itself runs on an EasyTier mesh, and
I've taken that protocol apart far enough to reimplement a node in C. I'll try not
to let that tip the verdict.

## The axes that actually differ between mesh VPNs

Strip away the marketing pages and seven properties do the discriminating:

1. **Control plane** — a hosted service, a service you can self-host, or no
   controller at all.
2. **Data plane** — WireGuard-based, or a bespoke transport with its own crypto.
3. **Overlay layer** — L3 (IP routing) versus L2 (an Ethernet segment over UDP).
4. **NAT traversal and relays** — how nodes find each other, and what happens when
   hole punching fails.
5. **Self-hosting story** — how much of the product you actually control.
6. **Client breadth** — which operating systems and devices are first-class.
7. **Lock-in** — what it costs to leave.

Everything else — naming, ACLs, SSO, audit logs — is real, but it sits *on top*
of these, and it's the part vendors churn fastest. So I'm comparing the plumbing,
not the settings page.

## Control plane: centralised, self-hostable, or absent

Every overlay needs *coordination*: nodes must learn about each other, exchange
keys or addresses, and publish policy. The question is where that brain lives.

**A hosted control plane** (Tailscale, ZeroTier's Central) is the lowest-effort
option by a mile. Each node phones home, authenticates through the vendor, and
receives the current peer set. You get SSO, ACLs, and a dashboard without running
anything. The costs are equally predictable: your network can't form *new*
connections if the coordinator is unreachable, you're depending on someone else's
uptime, and your topology metadata lives with them. Existing direct sessions
usually survive an outage, but you can't bring new nodes online blind.

**A self-hostable control plane** splits the difference. NetBird ships its own
management and signal servers you can run yourself (it also offers a hosted
version). ZeroTier's controller is open source and can run on your own box, even
though the default is their cloud. Tailscale's client is open, but its
coordination server is not — the community answer is **Headscale**, an
independent reimplementation of the protocol. It works well, but it is not
official and trails the hosted product.

**No controller at all** is the third path. Nebula expects you to run
"lighthouse" nodes and your own certificate authority. EasyTier is peer-to-peer
by design: a node is bootstrapped by pointing it at one or more peers, then the
mesh converges. Neither has an account to log into. That's the most independence
you can buy, and it's also the most operations you sign up for.

## Data plane: WireGuard-based vs custom

**WireGuard overlay** products reuse a small, audited, well-understood crypto
core. Tailscale's transport is WireGuard-derived (largely in userspace off Linux);
NetBird is built on WireGuard directly. You get the benefit of a crypto stack that
a lot of people have stared at, and on Linux you can often keep the fast kernel
path in the picture.

The rest rolled their own. ZeroTier speaks a **custom UDP protocol** (its own
transport and key exchange). Nebula uses a **Noise-based** encrypted transport of
its own. EasyTier has its own protocol that rides over UDP, TCP, WebSocket, or
QUIC and — a nice trick — can even carry traffic *inside* WireGuard (`wg://`).

None of this is a security verdict by itself: all of these encrypt, and all use
modern primitives. The real distinction is **who wrote and audited the crypto**
and what the custom protocol buys. Bespoke transports can multiplex better, do L2,
or pull cleverer NAT tricks; they also ask you to trust a smaller audit surface.
For a homelab either fine. For regulated work, "it's WireGuard underneath" is the
easier sentence to defend.

## L2 vs L3 overlay

Most meshes are **L3**: each node gets a virtual IP in one flat subnet, and
applications just see a routable network. That's usually what you want — mount
NFS, hit an API, `curl` a virtual IP.

**ZeroTier** is the notable L2-first design: it can be an **Ethernet segment over
UDP**, carrying broadcast and multicast so DHCP, mDNS discovery, and even non-IP
protocols work as if everyone were on the same switch. The cost is overhead and a
bigger blast radius — one broadcast domain across the internet is a broadcast
domain that can misbehave across the internet.

Pick L2 only when you genuinely need broadcast semantics or a legac device that
won't route. Otherwise L3 is less to reason about. (Most tools, including the L3
ones, still give you "subnet routers" or "gateways" to expose a real LAN behind a
node.)

## NAT traversal and relays

This is where every overlay earns or loses its keep. Two nodes behind NAT can't
just dial each other: they need STUN-style discovery to learn their public
mappings, then coordinated **hole punching** to open a path through both. When that
fails — symmetric NAT, aggressive CGNAT, locked-down firewalls — traffic falls
back to a **relay** both sides can reach.

The names differ, the shape is identical: Tailscale has **DERP**, ZeroTier has
roots and "moons," NetBird has a relay, Nebula has **lighthouses**, EasyTier has
relays. The engineering truth that follows is the same everywhere:

- The rendezvous node is on the **critical path for forming** a connection. Run
  more than one, ideally at different providers.
- The relay is the **failure path**, but it becomes the data path for every pair
  that can't hole-punch, so size it accordingly.
- **Don't design a topology that requires direct paths.** Hole punching is
  best-effort. If your plan breaks when two nodes relay, your plan is wrong.

## Self-hosting story

This is the axis people actually care about, so let me be concrete:

- **Nebula** and **EasyTier** are self-hosted by construction. There is no cloud
  to opt out of — the CA, or the shared secret, is yours.
- **NetBird** treats self-hosting as a first-class option with an open management
  server.
- **ZeroTier** lets you run your own controller, with the hosted Central as the
  default.
- **Tailscale** is the hosted-first product here; the self-hosted route is
  Headscale, community-maintained.

Worth saying: "self-hosted" doesn't have to mean "container sprawl." The public
node anchoring my mesh is a plain VPS running a systemd service, no Docker
involved — the same approach I wrote up in
[self-hosting without Docker](/posts/self-hosting-without-docker/). A control
plane, like any daemon, is happy as a unit file.

## Client breadth and lock-in

**Client breadth:** Tailscale and ZeroTier have the widest reach, including mobile
and NAS packages. NetBird's coverage is broad and improving. Nebula's is lighter
and more manual — great for a fleet you control, less so for phones. EasyTier
covers plenty of platforms and is the outlier in one direction: it's small enough
to run on embedded hardware, which I proved the hard way. The rule here is simple:
**check the current platform list yourself**, because "we support X" is a moving
target.

**Lock-in** tracks the control plane. If the coordination, identity, and ACLs are
a vendor's cloud, that's your exit cost even when the data plane is open source.
Nebula and EasyTier have the least: your CA or your secret is the trust anchor, and
there's no account to migrate. NetBird and self-hosted ZeroTier land in the middle.
Hosted Tailscale is the most convenient and the stickiest. Migration, in every
case, means renumbering and re-keying nodes — so weigh it before you scale, not
after.

## Side-by-side: the architecture that doesn't change

| Project | Control plane | Data plane | Overlay | Self-host control plane | Membership model |
|---|---|---|---|---|---|
| **Tailscale** | Hosted (closed server) | WireGuard-derived | L3 | Via Headscale (community) | Identity + ACLs from control plane |
| **ZeroTier** | Hosted by default | Custom UDP | L2 (Ethernet), L3 options | Yes (open controller) | Network ID + authorised members |
| **NetBird** | Open, self-hostable | WireGuard | L3 | Yes (first-class) | IdP / SSO + ACL |
| **Nebula** | None (you run lighthouses) | Custom (Noise-based) | L3 | Only mode | Certificates from your own CA |
| **EasyTier** | Decentralised (no controller) | Custom over UDP/TCP/WS/QUIC/WG | L3 | Only mode | Network name + shared secret |

Qualitative on purpose. These are architectural and stable; free-tier limits,
seat counts and prices are not — see the note at the end.

## The same job in five CLIs

The onboarding shape tells you a lot about the model. These are the common,
stable forms; flags drift, so treat them as signposts, not gospel.

```bash
# Tailscale: authenticate to the hosted control plane
sudo tailscale up

# ZeroTier: join a network by its 16-digit ID (authorise it in Central)
sudo zerotier-cli join 8056c2e21c000001

# NetBird: register with your management server / IdP, then connect
sudo netbird up

# Nebula: run with a config and a host cert signed by your CA
sudo nebula -config /etc/nebula/config.yml

# EasyTier: no controller — just a network name, a secret, and a peer to meet
sudo easytier-core \
  --network-name awin-mesh \
  --network-secret "$(cat ~/.config/et/secret)" \
  --dhcp --peers udp://anchor.example.com:11010
```

Read them in order and the philosophy leaks out: Tailscale authenticates you,
ZeroTier authorises you, NetBird registers you, Nebula trusts a certificate you
signed, EasyTier just asks whether you know the secret.

## Where EasyTier fits on this blog

I run EasyTier here, so I'll say plainly why: a decentralised model means **no
control-plane dependency and no account**, the mesh converges from a peer list,
and it's light enough to run on a machine I can hold in two fingers. The
walkthrough — install, form the mesh, verify with `easytier-cli peer`, expose a
service — is in
[building a private mesh with EasyTier](/posts/private-mesh-with-easytier/). The
part that sold me on the protocol rather than the marketing was
[running a real node on an ESP32-C3 in C](/posts/esp32-easytier-node-in-c/): if
the mesh holds a route table and an encrypted handshake in 400KB of RAM, it's a
real protocol.

That's a preference, not a claim that it wins every axis. It has no hosted SSO, no
dashboard, and the shared secret is an all-or-nothing boundary. Know what you're
buying.

## How to choose

- **Want zero ops, a small team, SSO/ACLs, and you're fine with a hosted brain:**
  Tailscale.
- **Need LAN-style L2, broadcast, or a stubborn legacy device:** ZeroTier.
- **Want open source plus a self-hosted control plane plus WireGuard plus
  IdP-driven ACLs:** NetBird.
- **Have a fixed fleet you fully control, want your own CA and no accounts,
  possibly air-gapped:** Nebula.
- **Want decentralised, no controller, embedded-friendly, cheapest to run and
  fully yours:** EasyTier.
- **Already committed to Tailscale but must self-host the control plane:** try
  Headscale — but go in knowing it's community-maintained.
- **Whatever you pick:** run two rendezvous nodes at different providers, verify
  that paths are actually direct, and treat the secret or CA key as the perimeter.

## Verify current specifics with each vendor

I did not put free-tier device limits, seat counts, prices, or a feature-by-feature
checkmark grid in this post on purpose: those change constantly, and a blog is a
terrible place to freeze them. Use this article for the **architecture and the
tradeoffs** — control plane, data plane, L2/L3, NAT traversal, self-hosting,
lock-in — and then check each vendor's current pricing and platform pages before
you commit. The architecture will still be true next year; the numbers won't.
