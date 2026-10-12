---
title: "How NAT traversal actually works: STUN, TURN, UDP hole punching, and why it sometimes fails"
description: "A mechanism-level explainer of NAT traversal: why NAT breaks P2P, the NAT taxonomy and why symmetric NAT is hard, how STUN finds your reflexive address, UDP hole punching step by step, TURN as relay fallback, ICE as the framework uniting them, and what CGNAT, port randomisation, QUIC, and WireGuard overlays change."
pubDate: 2026-10-17
lang: en
translationKey: nat-traversal-explained
tags: [networking, self-hosting, security]
featured: false
keywords:
  - NAT traversal
  - UDP hole punching
  - STUN TURN ICE
  - symmetric NAT
  - P2P networking
---

Two machines want to talk directly. Neither has a public address. One is behind a
home router, the other behind a carrier. This is the normal condition of the
internet, and it is exactly the condition that peer-to-peer networking cannot
survive without help. **NAT traversal** is the collection of tricks that gets a
direct path out of that situation — and the reason it works most of the time, and
fails in a specific, predictable set of cases, comes down to how the NAT in the
middle allocates mappings.

This is a mechanism-level walk-through. I cover why NAT breaks peer-to-peer, the
classic NAT taxonomy and why **symmetric NAT** is the hard case, how **STUN**
discovers your reflexive address, **UDP hole punching** step by step, **TURN** as
the relay fallback, **ICE** as the framework that ties them together, and what
changes in 2026: CGNAT, port randomisation, QUIC, and WireGuard overlays.

## Why NAT breaks peer-to-peer

NAT exists because IPv4 ran out of addresses and because networks want one egress
point for policy and statefulness. It does two things that matter here.

First, it **hides addresses**. Your laptop is `192.168.1.20`; the internet sees one
box, `203.0.113.7`. A peer cannot dial `192.168.1.20` — that address is meaningless
outside your LAN and exists in millions of others. You cannot advertise
reachability you do not own.

Second, it is **stateful and one-directional by default**. A NAT can only
translate a packet if it holds an entry mapping an internal `(ip, port)` to an
external `(ip, port)`. That entry is created when *your* side sends traffic out
first — outbound creates state, inbound needs it. An unsolicited SYN or UDP
datagram from the internet is dropped: there is no mapping to translate it
against. That asymmetry makes *listening* impossible and *dialing* possible.

Put together: two hosts behind NATs can each dial out, but neither can accept a
dial. P2P would be trivial with public addresses; NAT removes exactly the property
P2P needs. The discovery problem ("what address do I tell my peer?") and the
reachability problem ("will the packet actually arrive?") are both NAT's doing.

## The NAT taxonomy, and why symmetric NAT is the hard case

Folk taxonomies vary, but the classic four-category model (from RFC 3489-era
STUN) is a good predictor of whether hole punching will work. What distinguishes
them is how liberal the NAT is about **who may send inbound** to an existing
mapping, and how it chooses the external port.

| Type | Outbound mapping | Who can send inbound to the mapping |
| --- | --- | --- |
| Full-cone | One external port per internal `(ip, port)` | Anyone |
| Restricted cone | One external port per internal `(ip, port)` | Only hosts the internal side sent to, any port |
| Port-restricted cone | One external port per internal `(ip, port)` | Only the exact `(ip, port)` the internal side sent to |
| Symmetric | **A new external port per destination** | Only that one destination `(ip, port)` |

The first three are "cone" NATs: the external port is a stable function of the
internal endpoint, regardless of destination. That stability is the whole reason
hole punching works — you can predict the mapping and tell your peer about it.

**Symmetric NAT** breaks that. It allocates a *different* external port for each
*destination* you talk to. Predict the port for a peer and you will be wrong,
because the NAT will have picked another one. Worse, the very act of probing — you
sending to the peer's address — creates exactly the mapping the peer cannot
guess. Symmetric NAT usually appears on enterprise gear, some mobile carriers,
and increasingly behind CGNAT. It restricts inbound to the single `(ip, port)`
you last sent to, which is the most restrictive row in the table and the one that
defeats naive punching.

There is a subtlety worth internalizing: **mapping behaviour and filtering
behaviour are independent**. A NAT can use endpoint-independent mapping
(cone-like, stable port) but address-dependent filtering. The modern vocabulary
from RFC 4787 describes the two axes separately. For traversal, the mapping axis
usually decides success; the filtering axis decides whether the first probe gets
through.

## STUN: discovering your reflexive address

You need to know the public `(ip, port)` your NAT assigned you before you can
tell anyone to send there. That is what **STUN** (Session Traversal Utilities for
NAT) does. A STUN client sends a Binding Request to a public STUN server; the
server looks at the source address of the packet as it arrived and reflects it
back in a Binding Response. That observed address is your **server-reflexive**
candidate.

```
Client                    NAT (203.0.113.7)         STUN server
  |                             |                        |
  |-- Binding Request -------------------------------->  |
  |   (src 192.168.1.20:54321)  |                        |
  |                             | allocates              |
  |                             | 203.0.113.7:62000      |
  |                             |                        |
  |  <---------------------- Binding Response ---------  |
  |   XOR-MAPPED-ADDRESS = 203.0.113.7:62000             |
```

STUN is cheap (a couple of UDP round trips) and stateless on the server. It is
not a relay and it does not know anything about your peer. Two important realities:

- **Ask more than one server.** If two STUN servers return *different* external
  ports for the same local socket, you are behind symmetric NAT (or a NAT that
  maps per-server). That single comparison is the cheapest symmetric-NAT detector
  you have.
- **STUN tells you nothing about filtering.** Knowing your external port does not
  mean a peer's packet to it will be allowed through; that depends on the
  filtering axis. You find that out by trying.

If you only ever remember one thing about STUN: it answers "what do I look like
from outside?" — never "can I be reached?"

## UDP hole punching, step by step

Hole punching is the coordination trick. The insight is that while neither peer
can *accept* an unsolicited inbound packet, both can *create* the mapping that
lets the other one in — if they do it in the right order. UDP is the medium of
choice because it has no connection handshake, so a punched mapping persists as
long as the NAT's UDP timer allows, and no stack sends an RST when the first
packet looks unexpected.

The only requirement is a **rendezvous server**: a third host with a public
address that both peers can reach and that they trust enough to exchange
addresses. In ICE this is the signaling channel; in a mesh VPN it is the anchor
node.

```
Alice          Rendezvous (pub)          Bob
  |                   |                    |
  | 1. register       |                    |
  |------------------>|                    |
  |                   |<------ register ---|
  |                   |                    |
  | 2. "who's in the room?"                |
  |------------------>|                    |
  |<-- Bob=198.51.100.9:40000 ------------>
  |                   |--- Alice=203.0.113.7:62000 -->
  |                   |                    |
  | 3. punch: send UDP to Bob's addr       |
  |---------------------------------------->  (NAT-A opens mapping
  |                   |                      toward Bob; may be dropped
  |                   |                      by B's filter initially)
  | 4. punch: send UDP to Alice's addr     |
  |<----------------------------------------  (NAT-B opens mapping
  |                   |                      toward Alice)
  | 5. now both mappings exist:            |
  |<================= direct UDP =========>|
```

The order matters. Step 3 may be dropped by Bob's filter, but it creates Alice's
outbound mapping toward Bob's address. When Bob's step-4 packet arrives, that
mapping already exists and permits it (for a restricted NAT, because Alice sent to
Bob's exact address). Symmetrically, Bob's packet creates his mapping, so Alice's
*retransmitted* packet now passes. So step 5 normally needs a retransmission: the
first punch in each direction opens the door, the second walks through it.

```pseudo
# Per peer, once addresses are exchanged over rendezvous:
for attempt in 1..N:
    sendto(bob_addr, "PUNCH")     # keep opening/refreshing my mapping
    recv()                        # a PUNCH from Bob means the hole is live
    if peer_seen: break
    sleep(backoff)                # retransmission is REQUIRED, not optional
if not peer_seen:
    fall back to relay            # (see TURN below)
```

Two operational notes. First, punching is a **timing and keepalive** problem:
NAT UDP mappings expire (often 30–120 seconds of idleness, sometimes less on
CGNAT), so a live path needs periodic traffic or it silently dies. Second, once a
path is open you should switch to a **short encrypted keepalive** — this is why
real protocols do not punch once and forget.

## TURN: the relay you pay for

When punching fails — symmetric NAT on either side, a firewall that drops
everything, or two peers that simply cannot be made to agree on a path — the only
remaining option is to stop trying to go direct. **TURN** (Traversal Using Relays
around NAT) allocates a **relay address** on a public server. Both peers send
their traffic to the relay; the relay forwards it. From each NAT's point of view,
this is just ordinary outbound traffic to a public server, which always works.

```
Alice ----(outbound UDP)----> TURN relay <----(outbound UDP)---- Bob
        (NAT-A mapping)                 (NAT-B mapping)
```

TURN is the guaranteed fallback and the reason NAT traversal is *reliable* rather
than merely *probabilistic*. It is also the expensive part: all data for that pair
now transits your relay, with real egress cost and added latency — the path is no
longer the shortest one, but whichever detour both NATs permit. That is the entire
economic argument behind "prefer direct, relay only when necessary": a relayed
session can cost orders of magnitude more than a direct one. UDP TURN is normal;
TCP or TLS TURN exists for networks that drop UDP entirely, at a latency penalty.

## ICE: the framework that unifies them

In practice you never implement STUN or TURN in isolation. **ICE** (Interactive
Connectivity Establishment) is the state machine that runs the whole thing:
gather candidates, exchange them over signaling, pair them up, test them, and
pick the best one that works.

Each side gathers:

- **Host candidates** — local addresses (useful on a LAN).
- **Server-reflexive candidates** — the STUN-discovered public mappings.
- **Relayed candidates** — the TURN-allocated addresses.

These are exchanged via a signaling channel (your app's own protocol — WebRTC's
offer/answer, a mesh VPN's peer list). Then ICE performs **connectivity checks**:
it sends a STUN Binding Request from each local candidate to each remote
candidate and watches for a response. A pair that answers both ways is a working
path. ICE ranks the working pairs by preference — direct before relayed, lower
latency first — and nominates the best. It also keeps alternates alive so a path
can fail over without renegotiating.

The ICE takeaway: **traversal is a negotiation, not a protocol**. STUN gives you
addresses, hole punching gives you a path, TURN gives you a guarantee, and ICE is
the policy that orders them.

## What changed by 2026

The classical picture is still the right mental model, but the environment
shifted.

- **CGNAT is the new normal.** Many residential and mobile users sit behind
  carrier-grade NAT, sometimes in layers. You do not own a public address at all;
  the "public" mapping lives inside the carrier's NAT. CGNAT frequently uses
  endpoint-dependent (symmetric) mapping — the worst case for punching — so relay
  usage is higher than a decade ago. Some deployments share one address across
  subscribers by port range, which changes nothing conceptually but makes
  hand-testing useless.
- **Port randomisation.** Many NATs pick external ports from a large random pool
  rather than sequentially. This does not change *whether* punching works (the
  coordination is out-of-band), but it kills every "predict the next port"
  heuristic and defeats naive port scans.
- **QUIC and UDP-based transport.** QUIC rides on UDP and carries its own
  connection ID, so continuity is independent of the IP/port tuple. A QUIC
  connection can therefore survive a NAT rebinding that would kill TCP. It does
  not make punching easier by itself, but it makes a punched path more resilient.
- **WireGuard-based overlays.** Modern mesh VPNs ([like the one I run
  here](/posts/private-mesh-with-easytier/)) encapsulate their protocol in UDP,
  run STUN-like discovery *inside* the overlay to find each other's reflexively
  mapped endpoints, then punch. The result is a flat virtual subnet where every
  node can address every other node, with relays as a routing-layer fallback. What
  these overlays do and do not give you is [in this companion
  piece](/posts/mesh-vpn-comparison-2026/).

## The one-paragraph summary

NAT breaks P2P because it hides addresses and refuses unsolicited inbound traffic.
STUN tells you the address your NAT assigned you, but not whether anyone can
reach it. Hole punching exploits the fact that outbound creates state, so a
coordinated mutual dial lets each side's packets pass the other's filter —
provided the NAT kept the port stable. Symmetric NAT and CGNAT are hostile because
they allocate ports per destination, which is why TURN exists: a relay that always
works and always costs. ICE is the framework that tries direct first and falls
back to the relay, and it is why "NAT traversal" is best understood not as a
single protocol but as an ordered set of bets on how the middleboxes will behave.
