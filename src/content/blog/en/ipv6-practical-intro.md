---
title: "IPv6 for beginners: a hands-on IPv6 tutorial you can finish"
description: "A practical IPv6 tutorial for people who avoided it: why the address math is simpler (prefixes, /64, SLAAC, no NAT), what changes operationally (nftables, ip -6, AAAA, listening on [::]), why dual stack is pragmatic, the gotchas, and how to test it on one box."
pubDate: 2026-10-23
lang: en
translationKey: ipv6-practical-intro
tags: [networking, linux, self-hosting]
featured: false
keywords:
  - IPv6 tutorial
  - IPv6 for beginners
  - SLAAC
  - dual stack
  - ip6tables
---

Most people who avoided IPv6 did not avoid it because it is hard. They saw a
128-bit hexadecimal address, a paragraph about why NAT is evil, and a subnet
calculator — and closed the tab. I understand. So this is the **IPv6 tutorial** I
wish someone had handed me: no ideology, no "IPv4 is dead" speeches, just what
changes for someone running real machines — **SLAAC**, no NAT, listening on `[::]`
— and how to prove it on one box before touching production. If you are **IPv6 for
beginners** and mildly afraid, that is the right posture.

For what you actually do — host a service, firewall a server, point a DNS record
at it — IPv6 asks for *less* bookkeeping than IPv4. NAT is gone, the mask is one
number you rarely change, and hosts configure themselves. The fear is mostly
notation; learn a few `nftables` lines and one sysctl and you are operational.

<figure>
<svg viewBox="0 0 604 132" width="100%" role="img" aria-label="An IPv6 address is eight 16-bit groups. The first four groups (64 bits) are the network prefix; the last four identify the interface.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="16"  y="50" width="68" height="46" rx="6"/>
    <rect x="88"  y="50" width="68" height="46" rx="6"/>
    <rect x="160" y="50" width="68" height="46" rx="6"/>
    <rect x="232" y="50" width="68" height="46" rx="6"/>
    <rect x="304" y="50" width="68" height="46" rx="6"/>
    <rect x="376" y="50" width="68" height="46" rx="6"/>
    <rect x="448" y="50" width="68" height="46" rx="6"/>
    <rect x="520" y="50" width="68" height="46" rx="6"/>
    <path d="M16 40 v-8 h288 v8" fill="none"/>
    <path d="M304 40 v-8 h284 v8" fill="none"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="15">
    <text x="50"  y="79" text-anchor="middle">1</text>
    <text x="122" y="79" text-anchor="middle">2</text>
    <text x="194" y="79" text-anchor="middle">3</text>
    <text x="266" y="79" text-anchor="middle">4</text>
    <text x="338" y="79" text-anchor="middle">5</text>
    <text x="410" y="79" text-anchor="middle">6</text>
    <text x="482" y="79" text-anchor="middle">7</text>
    <text x="554" y="79" text-anchor="middle">8</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" opacity="0.8">
    <text x="160" y="24" text-anchor="middle">network prefix  ·  /64</text>
    <text x="446" y="24" text-anchor="middle">interface identifier</text>
    <text x="302" y="122" text-anchor="middle" opacity="0.7">one IPv6 address = 8 × 16 bits = 128 bits</text>
  </g>
</svg>
<figcaption>An IPv6 address is eight 16-bit groups. The first four (the /64 prefix) are what your provider routes to you; the last four identify the interface and are usually self-assigned.</figcaption>
</figure>

## IPv6 for beginners: why the address math and SLAAC are simpler than they look

An IPv6 address is 128 bits in eight groups of four hex digits, with two
shortcuts: drop leading zeros in a group, and collapse one run of all-zero groups
to `::`. So `2001:0db8:0000:0000:0000:0000:0000:0001` is `2001:db8::1`. The
notation is uglier than IPv4's four octets, but the *arithmetic you perform* is
dramatically simpler.

### A prefix is just a count of fixed leading bits

`2001:db8:abcd:12::/64` means "the first 64 bits are the network." That is the
entire address-to-mask relationship: no dotted mask to convert in your head, no
`255.255.255.0` ↔ `/24` ↔ "borrowed bits" ritual. The `/64` *is* the mask.

### Forget subnet calculators: it is /64, nearly always

Here is the number that frees you: **RFC 6177** and common practice say give every
LAN a `/64` and let hosts choose the rest. A `/64` holds 2^64 addresses — you will
never exhaust it. Your ISP typically delegates a `/56` or `/48`; each LAN takes one
`/64` from it. Because the boundary lands on hex digits, carving subnets is
counting in hex, not binary:

```bash
# Provider delegates 2001:db8:1000::/56 — that is 256 /64s.
# Assign one per LAN by bumping the 4th group. No math:
#   2001:db8:1000:00::/64    main LAN
#   2001:db8:1000:01::/64    lab
#   2001:db8:1000:02::/64    guest
# The host part is the trailing /64. You are done subnetting.
```

### SLAAC: your hosts address themselves

**SLAAC** (Stateless Address Autoconfiguration) sounds exotic and is the nicest
part of IPv6. Your router periodically sends **Router Advertisements** (RAs)
announcing the local prefix; each host takes the prefix, generates its own 64-bit
interface identifier, and adds them. No DHCP pool, no lease database, no "address
already in use." It is standardised in RFC 4862 (SLAAC) and RFC 4861 (Neighbour
Discovery) and works everywhere. DHCPv6 exists for central bookkeeping — the RA's
**M** and **O** flags say whether hosts fetch addresses or just options — but for a
homelab SLAAC alone suffices.

### There is no NAT, and that is the point

IPv4 routers rewrote addresses so many hosts hid behind one public IP. IPv6 has no
shortage, so every host gets a globally routable address and the router just
*routes*. The fear — "is everything exposed?" — misses that **the firewall is the
security boundary now**. NAT was never a security feature; it was an accident that
hid things. You swap implicit hiding for an explicit allow-list: more work up
front, far more honest. For why NAT is not a wall, see [how NAT traversal actually
works](/posts/nat-traversal-explained/).

## What actually changes operationally

### DNS: add AAAA records, do not remove A

An **AAAA record** is IPv6's `A` record. The whole dual-stack story lives here:
keep your `A`, add an `AAAA` beside it, and clients follow their own preference.
Happy Eyeballs races IPv4 and IPv6 and uses whichever answers first.

```dns
; Both records for the same name. Clients choose.
blog.example.com.   3600  IN  A     203.0.113.7
blog.example.com.   3600  IN  AAAA  2001:db8:1000:1::7
```

Never publish an `AAAA` for a host with no working IPv6 path: clients will try it,
time out, and your service will feel slow to exactly the users who have IPv6.

### Listening addresses and `[::]`

Applications do not change; only the bind address does. `0.0.0.0:8080` is "every
IPv4 address"; IPv6 spells it `[::]:8080`. In URLs, IPv6 literals go in brackets —
`http://[2001:db8::1]:8080/` — because colons already separate host from port.

```bash
ss -6 -lntp          # IPv6 TCP listeners
ss -4 -lntp          # IPv4 TCP listeners
```

```nginx
server {
    listen      [::]:80;
    listen      80;          # keep the IPv4 listener too: this is dual stack
    server_name blog.example.com;
}
```

On Linux a socket bound to `[::]` also accepts IPv4 unless
`net.ipv6.bindv6only=1`, so "it works on v4" does not prove a v6 listener. Check
with `ss -6`.

### Firewalling with `nftables` and `ip6tables`

The real work is here, and it is smaller than you fear. `nftables` handles both
families, so one ruleset covers v4 and v6. On the legacy tools, the v6 twin of
`iptables` is `ip6tables`, and rules do not carry over.

```nftables
# /etc/nftables.conf — one `inet` table covers IPv4 and IPv6 at once.
table inet filter {
    chain input {
        type filter hook input priority 0; policy drop;

        ct state established,related accept
        iif lo accept

        # ICMPv6 is not optional (see gotchas) — allow the essentials.
        ip6 nexthdr ipv6-icmp accept

        tcp dport { 22, 80, 443 } accept
    }
}
```

```bash
# Legacy equivalent, IPv6 only — mirrors iptables rule-for-rule:
ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A INPUT -p ipv6-icmp -j ACCEPT
ip6tables -A INPUT -p tcp --dport 22 -j ACCEPT
ip6tables -P INPUT DROP
```

The rule not to forget is the ICMPv6 line. Dropping all ICMPv6 — a habit from
"block ping" IPv4 advice — breaks IPv6 outright.

## Why dual stack is the pragmatic path

You should not choose. **Dual stack** runs IPv4 and IPv6 on the same host at once:
same service, both listeners, both DNS records. It is the industry default because
it is the only migration with no flag day. IPv4-only clients keep working, IPv6
clients get the shorter path, and you upgrade one segment at a time.

The alternatives have sharp edges: IPv6-only with NAT64/DNS64 needs working DNS64
infrastructure or half the internet vanishes, and a tunnel to a broker is fine for
a learning box and miserable in production. Dual stack costs one extra line per
service and one extra record per host; in exchange, nothing breaks *because* of
IPv6. So turn IPv6 on everywhere, publish `AAAA` where you can truly answer, and
treat "v6 sometimes works" as a bug to fix, not a state to accept.

## The gotchas that actually bite

A handful of behaviours feel wrong when you arrive from IPv4.

### Link-local addresses and `fe80::`

Every interface gets a **link-local** address in `fe80::/10` automatically, even
without a router. It is valid only on that one link and never routed, so `fe80::1`
means a different machine on every wire. Two consequences: ping and SSH targets
need a **zone** (`fe80::1%eth0`), and the `fe80::` entries in `ip -6 addr` are
normal, not errors. They are also how Neighbour Discovery and RAs work underneath
— do not disable them.

### Privacy extensions change your source address

Many systems derive the interface identifier from the MAC address (EUI-64), which
leaks hardware identity and tracks a host across networks. **Privacy extensions**
(RFC 8981) generate random, rotating identifiers instead. Most desktops enable
them; most servers do not.

```bash
# Prefer a stable address but also keep rotating temporary ones:
echo 'net.ipv6.conf.all.use_tempaddr = 2' | sudo tee /etc/sysctl.d/40-ipv6.conf
sudo sysctl --system
ip -6 addr show dev eth0     # expect both a stable and a temporary address
```

The catch: if you firewall or ACL by source address, decide now whether you trust
the stable address (server-like) or the temporary one (client-like), or your
allow-lists will rot.

### MTU and the ICMPv6 dependency

IPv6 routers do not fragment — only the sender does, via Path MTU Discovery, which
depends on ICMPv6 "Packet Too Big" messages. Block ICMPv6 and PMTUD fails
silently: small requests work, large ones hang forever.

```bash
# 1500 byte link minus IPv6+TCP headers → try a 1452-byte payload:
ping6 -M do -s 1452 -c 3 2001:4860:4860::8888
# "-M do" = do not fragment. "Message too long" tells you to go lower.
```

### ICMPv6 is required, not optional

A firewall that drops all ICMP also drops Neighbour Discovery, RAs, and PMTUD, and
the network half-dies. Permit ICMPv6 — at minimum types 1, 2, 128, and 129.

## A hands-on IPv6 tutorial: test it on one box

You do not need a second machine, and certainly not a new ISP.

```bash
# A Unique Local Address block (fd00::/8) is IPv6's private range.
sudo ip link add dummy0 type dummy
sudo ip link set dummy0 up
sudo ip -6 addr add fd00:dead:beef::1/64 dev dummy0

ip -6 addr show dev dummy0     # addressing
ip -6 route show               # routes
ip -6 neigh show dev dummy0    # neighbour discovery
ping6 -c 3 ::1                 # loopback over IPv6: the simplest proof
```

For real routed IPv6, most ISPs and VPS providers hand you a prefix; if yours does
not, a tunnel broker (Hurricane Electric's `tunnelbroker.net`) gives a routed `/64`
over your existing IPv4 — fine for learning, wrong in production. With a real
address:

```bash
ping6 -c 3 2001:4860:4860::8888          # Google DNS over IPv6
# Force IPv6 for HTTP — proves address, route, DNS, and remote service:
curl -6 -sS -o /dev/null -w '%{http_code} %{remote_ip}\n' https://example.com
dig +short AAAA example.com
```

If `curl -6` prints an address and a `200`, IPv6 is real on that box end to end. To
get reachability *without* waiting on ISP prefix delegation, a private overlay is
the shortcut — [I build one with
EasyTier](/posts/private-mesh-with-easytier/) — though it only solves "reach my own
machines," not "be reachable by the public internet."

## When you do not need to bother

- **A pure client machine on an IPv4-only network.** If your laptop only consumes
  the internet, IPv6 buys you nothing today.
- **A locked-down appliance behind someone else's network.** A printer or a Pi on
  a guest LAN you never expose: neutral work with no payoff.
- **A homelab that lives inside an overlay.** If every machine you care about is
  already reachable through a mesh, you solved addressing with another tool; public
  IPv6 is a second project.
- **A team with no v6 traffic to serve.** Adding `AAAA` for a 100% IPv4 audience
  adds a failure mode without adding users.

But note the shape of those cases: they are all "I only consume," never "I serve."
The moment you host something, IPv6 stops being optional. My advice stands: turn
it on, dual stack everything you serve, publish `AAAA` only where it truly answers,
and let IPv4 carry the rest until it does not have to.
