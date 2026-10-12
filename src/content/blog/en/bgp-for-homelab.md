---
title: "BGP in a homelab: BIRD, FRR, and how far to go"
description: "A practical guide to BGP in a homelab: what the protocol actually does, when multi-homing, ISP failover, or your own IPv6 PI space justify it, the BIRD and FRR options, the concepts (AS, prefix, local-pref, route filtering) you must understand, a minimal config, and an honest recommendation."
pubDate: 2026-12-02
lang: en
translationKey: bgp-for-homelab
tags: [networking, linux, homelab]
featured: false
keywords:
  - BGP homelab
  - BIRD
  - FRR
  - multi-homing
  - route filtering
---

BGP is the protocol that holds the internet together: networks telling each other
which IP prefixes they can reach and which path to prefer, one autonomous system at
a time. Most people who want a **BGP homelab** do not need one, and I will say that
early. But there is a narrow set of real reasons to run BGP at home —
**multi-homing** across two ISPs, automatic failover when a link dies, or
announcing your own IPv6 **PI space** — and if you are in that group, the tools are
**BIRD** and **FRR** on a router you already own. Here is what BGP is, what a
homelab gets from it, the concepts to understand first, a minimal config, and an
honest answer to how far to go.

## What BGP actually is

BGP (Border Gateway Protocol) is a **path-vector** protocol that exchanges
reachability *between* networks, rather than computing shortest paths inside one.
Each independent network is an **autonomous system (AS)** with an **AS number
(ASN)** — an ISP, a cloud provider, a university. Your home network almost
certainly is not one; it is a stub that hangs off a single ISP and takes a default
route.

BGP is how those ASes say "I can reach `203.0.113.0/24`, and here is the AS path to
get there." Two properties surprise anyone arriving from OSPF:

- **It is policy, not math.** OSPF picks the shortest path the topology allows. BGP
  picks the path *you told it to prefer*, via attributes. One mis-set attribute
  blackholes a prefix while every link still reads "up."
- **It is trust between organizations.** You decide whose announcements to believe.
  Get that wrong and you advertise someone else's space, or accept a forged route —
  which is exactly what a BGP hijack is.

There are two flavours. **eBGP** runs between different ASes — that is the
internet. **iBGP** runs between routers inside one AS, carrying externally-learned
routes internally. The internal case is what shows up in most homelabs and, tellingly,
in Kubernetes: Calico and Cilium both use BGP to distribute pod and service routes.

## Why a BGP homelab: multi-homing, failover, and PI space

Three genuine reasons, in rough order of how many people they apply to.

### Multi-homing across two ISPs

With two connections — fibre plus a 5G modem, or two providers — the naive setup
sends everything out one link and switches only when that link goes down hard. That
is fragile: it breaks the moment the link is *up* but the path beyond it is not.
**Multi-homing** with BGP is the real version. Each provider gives you a session,
you announce your prefix to both, and the protocol decides which path inbound and
outbound traffic takes. When a session drops, the route withdraws and traffic moves
— automatically.

Two caveats. It only works end to end when you announce a prefix *you own*; one
provider's block cannot be announced to another. And BGP converges in seconds to
tens of seconds, not instantly, and only if both sides are configured correctly.

### Your own IPv6 PI space

The cleanest reason. **Provider-independent (PI)** space — realistically an IPv6
`/48` or `/40` from your regional internet registry — can be announced from
whichever provider you like, so you change ISPs without renumbering. That is the
whole point: the addresses are yours and routable from anywhere that accepts your
announcement. For IPv4 this is nearly impossible, because the free pool is gone and
a public IPv4 `/24` costs real money on the transfer market; for IPv6 it is close
to a formality.

### OSPF vs BGP: how to choose

The choice is less about size than about *what you are routing between*:

- **Static routes** are correct until they are not. For a stub with one uplink and a
  handful of subnets, static is honest engineering. Do not run BGP for its own sake.
- **OSPF** is an **interior** gateway protocol: one link-state domain, one
  organization, fast convergence, shortest paths. Use it *inside* your network —
  VLANs, lab subnets, overlay nodes. It assumes everyone is on the same team.
- **BGP** is an **exterior** gateway protocol: policy between organizations, path
  attributes, explicit control over what you accept and advertise. Use it *between*
  you and your providers, or when you need policy (local-pref, communities) rather
  than shortest-path.

The honest rule: **OSPF inside, BGP at the edge.** Most homelabs need neither, and
the ones that need BGP need it for exactly one link: the one to the outside.

<figure>
<svg viewBox="0 0 640 236" width="100%" role="img" aria-label="Two upstream ISPs connect over transit links to one router running BGP, which holds an autonomous system number and announces three prefixes to both providers.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="40"  y="18" width="150" height="50" rx="6"/>
    <rect x="450" y="18" width="150" height="50" rx="6"/>
    <rect x="190" y="110" width="260" height="66" rx="6"/>
    <rect x="70"  y="196" width="150" height="34" rx="6"/>
    <rect x="245" y="196" width="150" height="34" rx="6"/>
    <rect x="420" y="196" width="150" height="34" rx="6"/>
    <path d="M115 68 C115 95 280 90 280 110"/>
    <path d="M525 68 C525 95 360 90 360 110"/>
    <path d="M280 176 L145 196"/>
    <path d="M320 176 L320 196"/>
    <path d="M360 176 L495 196"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="115" y="40" text-anchor="middle">ISP A</text>
    <text x="115" y="56" text-anchor="middle" opacity="0.75">transit</text>
    <text x="525" y="40" text-anchor="middle">ISP B</text>
    <text x="525" y="56" text-anchor="middle" opacity="0.75">transit</text>
    <text x="320" y="134" text-anchor="middle">your router — BIRD / FRR</text>
    <text x="320" y="152" text-anchor="middle" opacity="0.75">your AS (e.g. AS64512)</text>
    <text x="320" y="168" text-anchor="middle" opacity="0.75">local-pref picks the winner</text>
    <text x="145" y="217" text-anchor="middle">203.0.113.0/24</text>
    <text x="320" y="217" text-anchor="middle">2001:db8::/32</text>
    <text x="495" y="217" text-anchor="middle">10.0.0.0/8</text>
  </g>
</svg>
<figcaption>What multi-homing looks like at the routing layer: one router, one autonomous system, two upstreams, and the prefixes it announces to both. local-pref, not luck, decides which path carries your traffic.</figcaption>
</figure>

## BIRD and FRR: the realistic options

Three ways people actually run BGP at home.

**1. BIRD or FRR on a router you own.** The mainstream. **BIRD** is tiny, fast, and
has a clean config language; it runs on OpenWrt, a Raspberry Pi, any Linux box.
**FRR** (Free Range Routing) is the Cisco-style stack in userspace: the syntax you
would meet in a data centre, a large feature set, and good integration with the
Linux kernel's multipath routing. If you already run a Linux router or OPNsense, you
install one of these and add a session.

**2. BGP as an overlay control plane.** You do not need public addresses or an ASN
to use the protocol. Mesh VPNs and container networks use BGP to distribute routes
*inside* a tunnel: each node announces the subnets it can reach, and the overlay
routes between them — the same idea as your pod network in Kubernetes. It is BGP as
an *internal* mechanism, genuinely useful and a great way to learn without touching
a registry. If the tunnel itself is the hard part, the mechanics are in [NAT
traversal, explained](/posts/nat-traversal-explained/); a concrete overlay is in
[building a private mesh VPN with EasyTier](/posts/private-mesh-with-easytier/).

**3. BGP to a public ASN over a tunnel.** The "real internet" path: obtain an ASN
and PI space, then peer with a provider — often over a WireGuard or GRE tunnel to a
VPS that already has a full BGP feed, using a service that announces your prefix for
you. It works, but this is where the difficulty concentrates.

### The difficulty of getting an ASN and PI space

People hand-wave this part; I will not. To announce to the global internet you
typically need all of: an **ASN**, **PI space** (an IPv4 `/24`, or an IPv6 `/48`+
from your RIR via a sponsoring LIR), and at least one **transit provider or tunnel
broker** willing to carry your routes. Each has cost and paperwork: an ASN plus IPv6
PI is a few hundred dollars a year through most LIRs, and a public IPv4 `/24` is
thousands on the open market. Some registries will not allocate directly to an
individual, so you go through an LIR. Then someone has to actually accept your
routes — and they extend that trust because you now hold a piece of the global
routing table. This is not a weekend project, and it is not free.

## Concepts you must understand before you announce anything

Five ideas do most of the work. Skip them and you will cause an outage — yours, or,
with a bad enough mistake, someone else's.

- **AS, ASN, and prefix.** An **AS** is an administrative domain; an **ASN** is its
  number; a **prefix** is the address block you announce. Announce only prefixes you
  are entitled to announce.
- **Peering vs transit.** **Transit** means someone carries your traffic to the whole
  internet for money; **peering** means two networks exchange routes because both
  benefit, usually without payment. A home setup almost always buys transit, or uses
  a tunnel broker.
- **local-pref.** The attribute you will use most: higher wins, and it is *local* —
  it steers your *outbound* traffic, so raise `local-pref` on routes from the ISP you
  prefer. The asymmetry bites: **inbound** traffic follows the AS-path length your
  neighbours see, which you can only nudge by announcing differently (prepends,
  communities).
- **Communities.** Tagged values on routes that carry meaning between networks ("do
  not announce this", "prepend twice"). Providers publish community lists; you attach
  them on export to shape how your prefix is treated. They are conventions, not a
  standard — read your provider's docs.
- **Route filtering, and why you must filter.** Non-negotiable. **Filter what you
  accept:** reject bogons and martians (private, loopback, multicast, unallocated
  ranges), reject routes whose AS path already contains your own AS (a loop), and
  reject anything more specific than you expect. **Filter what you advertise:**
  announce only your own prefix — never a default, never your provider's space.
  Unfiltered BGP is how a misconfiguration becomes a global incident. Your provider
  should filter you too, but assume they might not.

## A tiny BIRD local lab

You can learn all of this without a public ASN, using two network namespaces on one
Linux box — the technique from my [network namespaces and
veth](/posts/network-namespaces-and-veth/) write-up. One `veth`, BIRD on each side,
two private ASNs. A minimal BIRD 2 config for one side, with filtering that is not
decorative:

```ini
# /etc/bird/bird.conf — one side of a two-namespace lab
router id 192.0.2.1;

protocol device {}

protocol direct {
  ipv4;                # learn the connected subnets we can announce
}

# What we are allowed to send to a neighbour: only our own space.
filter own_out {
  if net ~ [ 10.10.0.0/16{16,24} ] then accept;
  reject;
}

# What we are willing to believe from a neighbour.
filter sane_in {
  # reject bogon / private / default / multicast
  if net ~ [ 0.0.0.0/0, 10.0.0.0/8, 127.0.0.0/8,
              169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16,
              224.0.0.0/4 ] then reject;
  # reject a route that already passed through our own AS: a loop
  if bgp_path ~ [ = 64512, * = ] then reject;
  accept;
}

protocol bgp peer_lab {
  local 192.0.2.1 as 64512;
  neighbor 192.0.2.2 as 64513;
  ipv4 {
    import filter sane_in;
    export filter own_out;
    next hop self;
  };
}
```

Bring it up and look at what the protocol decided:

```console
$ sudo birdc configure
$ sudo birdc show protocols all peer_lab   # session state, routes in/out
$ sudo birdc show route                     # the RIB, with AS paths
$ ip route show proto bird                  # what BIRD pushed into the kernel
```

The last two lines are the point: routes learned over BGP land in BIRD's RIB, and
the ones BIRD selects are installed in the kernel's FIB. That split — control plane
decides, data plane forwards — is the entire mental model.

## An FRR sketch for the same job

Same policy in FRR. A prefix list controls what you announce; a route-map sets
`local-pref` on import:

```
router bgp 64512
 bgp router-id 192.0.2.1
 neighbor 198.51.100.1 remote-as 64500
 neighbor 198.51.100.1 description isp-a
 address-family ipv4 unicast
  neighbor 198.51.100.1 route-map ISP-A-IN in
  neighbor 198.51.100.1 route-map OWN-OUT out
 exit-address-family
!
route-map ISP-A-IN permit 10
 set local-preference 200
!
ip prefix-list OWN seq 10 permit 10.10.0.0/16 le 24
route-map OWN-OUT permit 10
 match ip address prefix-list OWN
```

`local-preference 200` on everything from ISP A means outbound traffic prefers A
while its session is up; if A drops, its routes vanish and B wins. That one line is
most of what "multi-homing failover" means.

## The honest recommendation: how far to go

**Most homelabs should not run BGP at all.** One uplink, a few subnets: use static
routes or OSPF. It is less to configure, less to break, and there is no failover to
gain because there is nothing to fail over to. Adding BGP to a single-ISP network is
a hobby, not engineering — a fine reason to do it, as long as you call it that.

**Run OSPF (or keep static) inside, and reach for BGP only when you genuinely
multi-home.** Two real uplinks with automatic failover, or your own IPv6 PI prefix
that should survive an ISP change: BGP is the right tool, and that is the one case
where it pays for itself. Two sessions, filtered hard, `local-pref` to pick a
favourite — that is a complete design.

**Learn it in the lab before you touch anything public.** The namespace lab above is
free, reversible, and teaches every concept that matters. Only get an ASN and PI
space if you truly want to announce to the internet — you then own a piece of global
routing. The hidden costs are annual fees, a provider to carry your routes, and
filtering in both directions, or you become the next cautionary tale about BGP
hijacks.

## The short version

BGP is the path-vector protocol that exchanges prefixes between autonomous systems,
and it is policy-driven in a way OSPF never is. A homelab wants it for three honest
reasons: **multi-homing** across two ISPs, announcing your own IPv6 **PI space**, or
learning how the internet actually routes. The practical tools are **BIRD** and
**FRR**; the overlay use of BGP needs no ASN at all. Understand AS/ASN, peering vs
transit, **local-pref**, communities, and above all **route filtering** before you
announce anything. For most people the answer is static or **OSPF** inside and no
BGP at all; run BGP only when you truly multi-home or want to learn — and in that
case, learn it in a namespaces lab first.
