---
title: "IPv6 home network: getting IPv6 working at home (ISP, router, firewall, DNS)"
description: "A practical guide to an IPv6 home network: check that your ISP really does prefix delegation, get the router advertising a /64 over SLAAC, lock the IPv6 firewall to default-deny inbound, publish the right AAAA record, and debug the stall a broken IPv6 path causes."
pubDate: 2026-11-25
lang: en
translationKey: ipv6-at-home
tags: [networking, self-hosting, linux]
featured: false
keywords:
  - IPv6 home network
  - IPv6 firewall
  - prefix delegation
  - SLAAC
  - dual stack
---

Turning on IPv6 at home has a reputation for being a rabbit hole: an ISP that
half-supports it, a router with three DNS modes and no documentation, and a
firewall that quietly lets the whole internet in. It does not have to be. Getting
an **IPv6 home network** working is four steps — confirm the ISP actually gives
you a prefix, make the router advertise it, lock the **IPv6 firewall** down, and
fix DNS. I have done this on three different ISPs and every time the failure was
in one of those four places, never something mysterious. This is the walkthrough I
wish I had, from the modem outward.

If you are new to the notation, read [my hands-on IPv6
tutorial](/posts/ipv6-practical-intro/) first; here I assume you know what a `/64`
is and want the thing actually routed. You can expand any address with the [IPv6
calculator](/tools/ipv6/) while you follow along.

## Is your ISP actually giving you IPv6? Check prefix delegation

Before you touch the router, find out what your provider hands you. Most give a
**prefix delegation** (PD): a block of addresses routed to you over the PPPoE or
DHCPv6 link, usually a `/56` or `/48`. A few give a single `/64` (fine for one
LAN, useless for segments), and some give nothing at all.

The cheapest test is to plug a laptop straight into the modem/ONT and ask for a
prefix yourself:

```bash
# Ask the ISP's DHCPv6 server what it will delegate.
# Debian/Ubuntu:
sudo apt install wide-dhcpv6-client || sudo dnf install dhcp-client
sudo dhclient -6 -P -v eth0      # -P = request a prefix, not just one address

# Or watch what the router already got. Look for a /56 or /48:
ip -6 addr show scope global
ip -6 route show | grep -v fe80
```

If you see a global address like `2001:db8:1234:5600::1/64` on the WAN, the ISP
gave at least a `/64`. If `dhclient -6 -P` prints a `ia-pd` block of length 56 or
48, you have room for a real **IPv6 home network** with segments. If it prints
nothing and times out, your ISP is IPv4-only or you need to enable IPv6 in your
account portal — some ISPs ship IPv6 off by default.

What to look for, in one line: **a delegated prefix length of 56 or 48 and a
default route via a link-local ISP gateway** (`ip -6 route show default`). Both
present means the ISP side is done and the rest is yours.

## The router side: prefix delegation, RA, and SLAAC vs DHCPv6

The router has two jobs, and confusing them is where most home setups go wrong.

**WAN side — request the prefix.** In OpenWrt this is `wan6` with protocol
*DHCPv6 client*, "Request IPv6-prefix of length" set to *Automatic* (or `56`).
OPNsense calls it *WAN / DHCP6*, with "Request only an IPv6 prefix" enabled. If
you skip this, the router has a WAN address but nothing to hand to the LAN, and
every client stays on IPv4.

**LAN side — advertise a /64.** This is the **router advertisement** (RA) job, and
here you choose between **SLAAC** and DHCPv6:

- **SLAAC** (RFC 4862): the router advertises `prefix::/64` in an RA; each host
  builds its own address. Zero state, no leases, works on Android. This is the
  right default.
- **DHCPv6 (stateless, "SLAAC + other info")**: hosts still self-address via
  SLAAC, but pull DNS servers and other options from DHCPv6. This is what most
  home routers actually do, set by the RA's **O** flag.
- **DHCPv6 (stateful)**: the router tracks every address. Useful for central
  bookkeeping or when you must hand out fixed addresses; overkill at home.

The RA carries flag bits you will see in `rdisc6`: **M** (managed — use DHCPv6 for
addresses) and **O** (other — use DHCPv6 for options). For a home LAN, "SLAAC for
addresses, DHCPv6 for DNS" is the M=0, O=1 sweet spot.

<figure>
<svg viewBox="0 0 640 150" width="100%" role="img" aria-label="An ISP delegates a prefix over prefix delegation to the router, which advertises a /64 over router advertisements to the LAN, where a firewall sits in front of hosts.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="8"   y="52" width="104" height="46" rx="6"/>
    <rect x="168" y="34" width="132" height="82" rx="6"/>
    <rect x="356" y="52" width="120" height="46" rx="6"/>
    <rect x="532" y="34" width="100" height="82" rx="6"/>
    <path d="M112 75 H168" marker-end="none"/>
    <path d="M300 75 H356"/>
    <path d="M476 75 H532"/>
    <path d="M168 116 v10 H300 v-10" opacity="0.4"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="60"  y="72" text-anchor="middle">ISP</text>
    <text x="60"  y="88" text-anchor="middle" opacity="0.75">DHCPv6-PD</text>
    <text x="234" y="70" text-anchor="middle">Router / WAN</text>
    <text x="234" y="88" text-anchor="middle" opacity="0.75">gets /56</text>
    <text x="234" y="106" text-anchor="middle" opacity="0.75">advertises /64</text>
    <text x="416" y="72" text-anchor="middle">RA + SLAAC</text>
    <text x="416" y="88" text-anchor="middle" opacity="0.75">LAN prefix</text>
    <text x="582" y="70" text-anchor="middle">IPv6 firewall</text>
    <text x="582" y="88" text-anchor="middle" opacity="0.75">hosts</text>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" opacity="0.8">
    <text x="140" y="26" text-anchor="middle">prefix delegation</text>
    <text x="328" y="26" text-anchor="middle" >router advertisement</text>
  </g>
</svg>
<figcaption>The path to a working IPv6 home network: the ISP delegates a prefix, the router advertises a /64 on the LAN, and a firewall sits in front of globally routable hosts.</figcaption>
</figure>

Verify the LAN from any client:

```bash
# Do I have a global IPv6 address, and where did the router come from?
ip -6 addr show scope global
ip -6 route show default           # should point at a link-local fe80:: gateway
rdisc6 -1 eth0                     # receive one router advertisement and print it
# Look for: Prefix 2001:db8:1234:5601::/64, flags M=0 O=1, valid lifetime
```

`rdisc6` is the fastest way to answer "is my `router advertisement` arriving at
all?" If it prints nothing, the router is not advertising and every client will be
IPv4-only no matter what the ISP delegated.

## The IPv6 firewall is not optional: default-deny inbound

Here is the part that still surprises people. Your IPv4 router hid the whole LAN
behind one address, so "nothing is exposed" felt true by accident. IPv6 has no
NAT: each host has a **globally routable address**, and the only thing standing
between your NAS and a port scanner is the firewall. NAT was never a security
boundary; on IPv6 that accident is gone, so you must build the boundary on
purpose.

The model is one line to remember: **default-deny inbound, allow established and
related, allow the few services you actually expose.** With `nftables`, one `inet`
table covers IPv4 and IPv6 at once:

```nftables
# /etc/nftables.conf — WAN inbound. Still allows replies, blocks new inbound.
table inet filter {
    chain input {
        type filter hook input priority 0; policy drop;

        ct state established,related accept   # replies to what you started
        iif lo accept

        ip6 nexthdr ipv6-icmp accept          # REQUIRED — see below
        ip6 nexthdr tcp dport { 22, 80, 443 } accept
    }
    chain forward {
        type filter hook forward priority 0; policy drop;
        ct state established,related accept
    }
}
```

The legacy twin works the same, IPv6 only:

```bash
# ip6tables mirror of the two accept lines everyone needs:
ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A INPUT -p ipv6-icmp -j ACCEPT
ip6tables -A INPUT -p tcp --dport 22 -j ACCEPT
ip6tables -P INPUT DROP
```

Do not copy "block all ICMP" advice from IPv4. On IPv6, ICMPv6 carries Neighbour
Discovery, router advertisements, and Path MTU Discovery; drop it and the network
half-dies in ways that look random. If you run a consumer router, the setting is
usually a single "IPv6 firewall" toggle next to "IPv4 firewall" — confirm it is on
and, crucially, that inbound is denied by default rather than an "allow all" mode
some cheap firmware ships with.

## DNS, the AAAA record, and the "IPv6 is slower" myth

**DNS is the same story as always: keep your `A`, add an `AAAA record`.** Dual
stack means both records on the same name and the client picks.

```dns
blog.example.com.   3600  IN  A     203.0.113.7
blog.example.com.   3600  IN  AAAA  2001:db8:1234:5601::7
```

Now the myth. People say "IPv6 is slower" and reach for a benchmark, but the real
cause is usually a **broken IPv6 path**: the router hands out a global address and
an `AAAA` record exists, but the prefix is not actually routed, or the firewall
drops something it should not. Clients try IPv6 first, wait out a timeout, then
fall back to IPv4 — so your network feels slow precisely because IPv6 is *half*
working. Happy Eyeballs hides some of this, but not a dead path with no RST.

Test the path directly instead of guessing:

```bash
ping6 -c 3 2001:4860:4860::8888                  # Google DNS over IPv6
dig +short AAAA example.com                       # is there a v6 record?
curl -6 -sS -o /dev/null -w '%{http_code} %{remote_ip}\n' https://example.com
# Force v6 only and time it. A multi-second hang = broken path, not "slow v6".
time curl -6 -sS -o /dev/null https://example.com
```

If `curl -6` hangs and `curl -4` is instant, you have a connectivity bug to fix —
not a reason to disable IPv6. The honest fix is to make v6 work or remove the
`AAAA`; leaving a dead path published is the worst option.

## A home lab behind it: no NAT, so firewall specific hosts

Segmentation does not change on IPv6, but the *tool* does. With no NAT, you do not
port-forward to a lab box — you route to its real address and firewall it. If you
already run segments ([home network
segmentation](/posts/home-network-segmentation/)), each VLAN gets its own `/64`
from your delegated prefix, and the rule is per-host:

```nftables
# Expose the lab web server, and nothing else, to the internet.
ip6 daddr 2001:db8:1234:5602::10 tcp dport { 80, 443 } accept
# Lab -> Trusted is reply-only (established) above; new Lab->Trusted is dropped.
```

Two practical consequences worth internalising. First, **NAT is gone**: no port
forwarding, no "which host is 8080 forwarded to", no hairpin weirdness — from the
internet or from your own LAN, a host is reached at its own address. Second, a
host you *do not* firewall is reachable, so the moment you add a lab subnet you
must also decide what it exposes. Keep [IPv6 firewall](/tools/ipv6/) policy
explicit per host and you never need to guess.

## Troubleshooting: no RA, wrong prefix, CGNAT and IPv6-only

When it does not work, it is almost always one of these:

- **No global address on the client.** Check `rdisc6 -1 eth0` on the client. No
  RA means the router is not advertising — check the LAN interface has the
  delegated prefix assigned and RA/SLAAC is enabled. If the RA arrives but the
  prefix is `::/64` or missing, the router got no PD.
- **Address with `fe80::` only.** Link-local works, global does not: the PD
  request failed. Re-check the WAN6/DHCPv6 client settings and the ISP portal.
- **A `/64` but you want segments.** Your ISP delegated a single LAN's worth. You
  cannot split it — either request a larger prefix (some ISPs enable `/56` on
  request) or route a ULA `fd00::/8` internally and NAT66 at the edge (last
  resort).
- **Address looks public but nothing routes.** Confirm where the prefix is
  advertised: `ip -6 route show` should show the delegated `/64` as a connected
  route on the LAN interface, and a default route via `fe80::...`.
- **CGNAT and IPv6-only.** Some carriers run **CGNAT** on IPv4 (you share a public
  address) and lean on IPv6 for real reachability — for them IPv6 is not optional,
  it is the only way to be reachable. The other extreme is an **IPv6-only** access
  network with NAT64/DNS64 for IPv4 destinations; there, `AAAA` works, `A` goes
  through a translator, and pure-IPv4 apps fail. Know which world you are in
  before you debug DNS.

## The short version

An **IPv6 home network** is four deliberate moves. Confirm the ISP's **prefix
delegation** — a `/56` or `/48` and a default route via a link-local gateway. Make
the router request that prefix and advertise a `/64` with **SLAAC** (plus DHCPv6
for DNS). Turn on a real **default-deny, established-allowed IPv6 firewall**,
because every host is now globally routable. Publish an `AAAA record` beside your
`A` only where IPv6 truly answers, and if it feels slow, measure the path before
you blame the protocol. Do those four and the rest is quiet — which is exactly
what you want from a network.
