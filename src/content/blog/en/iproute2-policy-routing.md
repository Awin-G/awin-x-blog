---
title: "Policy routing with iproute2: routing on more than the destination"
description: "Policy routing with iproute2 lets `ip rule` pick a routing table by source address, fwmark, or interface — not just the destination. Real `ip route get` output for two uplinks, source-based routing, split tunnels, and IPv6."
pubDate: 2027-02-05
lang: en
translationKey: iproute2-policy-routing
tags: [networking, linux]
featured: false
keywords:
  - policy routing
  - ip rule
  - iproute2
  - routing table
  - ip route get
  - fwmark
  - source-based routing
---

Normal routing answers one question: given a destination address, which way out?
The kernel longest-prefix-matches that destination against a single **routing
table** and picks the most specific route. It works, until it doesn't. The moment a
box has **two uplinks**, a VPN that must carry only *some* traffic, or a policy
that says "this user, this process, this source address goes that way," one
destination-keyed table is not enough. That is what **policy routing** is for: the
kernel consults an ordered list of **rules** (`ip rule`), and the first rule that
both matches the packet *and* resolves a route in the table it names wins. The
selector can be the **source address**, a **firewall mark**, the incoming
interface — almost anything but the destination alone.

This is the iproute2 half of the kernel, and it quietly runs under Docker,
WireGuard, OpenVPN, and every split-tunnel client. Below I build it live in a
throwaway container with only `CAP_NET_ADMIN`, add a second **routing table**,
write an `ip rule`, and use `ip route get` to watch the *same destination* take
*different paths* for different sources. Every block is real output.

## How normal routing works — and when it isn't enough

A routing table is a list of prefixes. To forward a packet, the kernel finds the
longest prefix that matches the **destination** and sends it out the route's
interface (or to its gateway). Plain `ip route add ...` writes to the `main` table,
and that is the only table most boxes ever use. This is the same destination-keyed
forwarding I pulled apart when I showed that
[traceroute is evidence, not a map](/posts/traceroute-lies/) — the path a packet
takes is decided here, one destination at a time.

The model breaks the instant the *right* path depends on something other than the
destination:

- **Two uplinks.** You have a cheap link and an expensive/fast link. You want
  interactive traffic on the fast one and bulk on the cheap one — but both reach
  the same internet, so destination alone cannot separate them.
- **VPN split tunnel.** The tunnel should carry `10.8.0.0/16` (work) but *not*
  general internet. A naive `0.0.0.0/0` via the tunnel hijacks everything and
  breaks local LAN access.
- **Source-based routing.** A machine with several addresses on several links, and
  return traffic must leave the way it came in (reverse-path sanity).
- **Per-user or per-process routing.** Send root's `apt` over the tunnel and keep
  your SSH out of it — a decision about *who*, not *where*.

In every case the missing input is a selector, and `ip rule` is how you supply it.

## The iproute2 model: `ip rule` picks a table, `ip route` fills it

Two commands, two jobs, and people constantly mix them up:

- `ip route ... table N` **populates** tables. Tables are just numbered buckets of
  routes.
- `ip rule add ... table N` **orders** them. A rule says "packets matching this
  selector use that table, subject to priority."

Routing a packet walks the rules from the **lowest priority number to the highest**
and, for the first rule whose selector matches, consults that rule's table. That is
the whole mental model. Here it is:

<figure>
<svg viewBox="0 0 720 250" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="An ordered ip rule list on the left. Priority 100 'from 192.0.2.1' selects routing table 100 whose default is via 192.0.2.254 out uplinkA; priority 200 'from 198.51.100.1' selects table 200 via uplinkB; and the built-in priority 32766 'from all' selects the main table, leaving via eth0's default gateway. The first rule that matches and resolves a route wins.">
  <defs>
    <marker id="pra-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g font-family="system-ui,sans-serif" font-size="12" fill="currentColor">
    <text x="8" y="14">ip rule — evaluated in priority order</text>
    <text x="286" y="14" fill="#0f766e">routing table</text>
    <text x="520" y="14">next hop / device</text>
    <!-- row 1 -->
    <rect x="8" y="26" width="180" height="46" rx="8" fill="none" stroke="currentColor"/>
    <text x="20" y="46">from 192.0.2.1</text>
    <text x="20" y="62" font-size="11" fill="#0f766e">priority 100</text>
    <line x1="190" y1="49" x2="286" y2="49" stroke="#0f766e" stroke-width="1.5" marker-end="url(#pra-arrow)"/>
    <rect x="288" y="26" width="140" height="46" rx="8" fill="none" stroke="#0f766e"/>
    <text x="300" y="54" fill="#0f766e">table 100</text>
    <line x1="430" y1="49" x2="520" y2="49" stroke="#0f766e" stroke-width="1.5" marker-end="url(#pra-arrow)"/>
    <rect x="520" y="26" width="192" height="46" rx="8" fill="none" stroke="currentColor"/>
    <text x="532" y="46">via 192.0.2.254</text>
    <text x="532" y="62" font-size="11">uplinkA</text>
    <!-- row 2 -->
    <rect x="8" y="106" width="180" height="46" rx="8" fill="none" stroke="currentColor"/>
    <text x="20" y="126">from 198.51.100.1</text>
    <text x="20" y="142" font-size="11" fill="#0f766e">priority 200</text>
    <line x1="190" y1="129" x2="286" y2="129" stroke="#0f766e" stroke-width="1.5" marker-end="url(#pra-arrow)"/>
    <rect x="288" y="106" width="140" height="46" rx="8" fill="none" stroke="#0f766e"/>
    <text x="300" y="134" fill="#0f766e">table 200</text>
    <line x1="430" y1="129" x2="520" y2="129" stroke="#0f766e" stroke-width="1.5" marker-end="url(#pra-arrow)"/>
    <rect x="520" y="106" width="192" height="46" rx="8" fill="none" stroke="currentColor"/>
    <text x="532" y="126">via 198.51.100.254</text>
    <text x="532" y="142" font-size="11">uplinkB</text>
    <!-- row 3 (built-in) -->
    <rect x="8" y="186" width="180" height="46" rx="8" fill="none" stroke="currentColor" opacity="0.7"/>
    <text x="20" y="206">from all</text>
    <text x="20" y="222" font-size="11" fill="#0f766e">priority 32766 (built-in)</text>
    <line x1="190" y1="209" x2="286" y2="209" stroke="currentColor" stroke-width="1.5" opacity="0.6" marker-end="url(#pra-arrow)"/>
    <rect x="288" y="186" width="140" height="46" rx="8" fill="none" stroke="currentColor" opacity="0.7"/>
    <text x="300" y="214" fill="currentColor">main</text>
    <line x1="430" y1="209" x2="520" y2="209" stroke="currentColor" stroke-width="1.5" opacity="0.6" marker-end="url(#pra-arrow)"/>
    <rect x="520" y="186" width="192" height="46" rx="8" fill="none" stroke="currentColor" opacity="0.7"/>
    <text x="532" y="206" fill="currentColor">via 172.17.0.1</text>
    <text x="532" y="222" font-size="11">eth0 (default)</text>
  </g>
</svg>
<figcaption>Three rules, three tables. The <code>ip rule</code> list is the priority
queue; each rule only names a table. First matching rule whose table actually
resolves a route wins — which is why <code>ip route get</code> is the real oracle.</figcaption>
</figure>

## The built-in routing tables, and `ip route get` as the debugger

There are three named tables created by the kernel, matched by three built-in rules
at the bottom of the list. On a fresh box the rule list is exactly:

```console
$ ip rule show
0:	from all lookup local
32766:	from all lookup main
32767:	from all lookup default
```

- `local` (priority 0) holds the box's own addresses and broadcast routes — it is
  why `ip route show table local` lists `local 127.0.0.1 dev lo` and every
  interface's `/32`. Local delivery consults it first.
- `main` (priority 32766) is the table your ordinary `ip route add` writes to.
- `default` (priority 32767) is the empty last resort, consulted only after
  everything above has failed to resolve a route.

Named tables come from `/etc/iproute2/rt_tables`; that is where you add a friendly
name for a number like `100 wan_a`. The forever-useful tool is `ip route get`,
because it runs the *actual* lookup the kernel will run — rules, tables, and all:

```console
$ ip route get 8.8.8.8
8.8.8.8 via 172.17.0.1 dev eth0 src 172.17.0.5 uid 0
    cache
```

Read that as "to reach 8.8.8.8 the kernel leaves via eth0's gateway using source
172.17.0.5," and it tells you which table won (`table 100` below). When something is
broken, `ip route get` from the real source beats reading three tables by hand.

## Source-based routing: two uplinks, one box

Here is the payoff. I am inside a throwaway container with **only `CAP_NET_ADMIN`**
(no privileged mode, no host access). Docker handed it `eth0` at `172.17.0.5/16`
with a default route. I add two **dummy** interfaces to act as uplinks — a dummy is
a real interface that just eats packets, perfect for a route-resolution demo:

```console
# create uplinkA / uplinkB with two addresses each (v4 + v6)
$ ip link add uplinkA type dummy
$ ip addr add 192.0.2.1/24 dev uplinkA
$ ip addr add 2001:db8:1::1/64 dev uplinkA
$ ip link set uplinkA up
$ ip link add uplinkB type dummy
$ ip addr add 198.51.100.1/24 dev uplinkB
$ ip addr add 2001:db8:2::1/64 dev uplinkB
$ ip link set uplinkB up
$ ip -br addr | grep -E 'uplink|eth0'
eth0@if2072      UP             172.17.0.5/16
uplinkA          UNKNOWN        192.0.2.1/24  2001:db8:1::1/64
uplinkB          UNKNOWN        198.51.100.1/24  2001:db8:2::1/64
```

Adding each address already created a connected route in `main`. Now I add two
private tables, each with its own default gateway, and two rules that route by
**source address**:

```console
$ ip route add default via 192.0.2.254 dev uplinkA table 100
$ ip route add default via 198.51.100.254 dev uplinkB table 200
$ ip rule add from 192.0.2.1 table 100 priority 100
$ ip rule add from 198.51.100.1 table 200 priority 200
$ ip rule show
0:	from all lookup local
100:	from 192.0.2.1 lookup 100
200:	from 198.51.100.1 lookup 200
32766:	from all lookup main
32767:	from all lookup default
$ ip route show table 100
default via 192.0.2.254 dev uplinkA
$ ip route show table 200
default via 198.51.100.254 dev uplinkB
```

Now ask the kernel where a packet to the *same* destination goes, varying only the
**source**. This is the moment the whole concept clicks:

```console
# no source given -> falls through to main (Docker's eth0 default)
$ ip route get 8.8.8.8
8.8.8.8 via 172.17.0.1 dev eth0 src 172.17.0.5 uid 0

# source 192.0.2.1 -> rule 100 -> table 100 -> uplinkA
$ ip route get 8.8.8.8 from 192.0.2.1
8.8.8.8 from 192.0.2.1 via 192.0.2.254 dev uplinkA table 100 uid 0

# source 198.51.100.1 -> rule 200 -> table 200 -> uplinkB
$ ip route get 8.8.8.8 from 198.51.100.1
8.8.8.8 from 198.51.100.1 via 198.51.100.254 dev uplinkB table 200 uid 0
```

Same `8.8.8.8`, three answers. Unspecified source resolves through `main`
(eth0/Docker); a packet sourced `192.0.2.1` is funnelled out `uplinkA`; a packet
sourced `198.51.100.1` out `uplinkB`. The `from` keyword on `ip route get` is the same selector as the `from` in the
rule, so what you test is what ships. That is **source-based routing** — how a
multi-homed host keeps return traffic on the link it came in on.

## fwmark: let the firewall pick the table

Addresses are one selector. The other workhorse is a **firewall mark** (`fwmark`):
your `nft`/`iptables` rule tags a packet, and `ip rule` routes on the tag without
caring about addresses. Add a table and a mark-based rule:

```console
$ ip route add default via 192.0.2.254 dev uplinkA table 300
$ ip rule add fwmark 0x64/0xff table 300 priority 300
$ ip rule show
0:      from all lookup local
100:    from 192.0.2.1 lookup 100
200:    from 198.51.100.1 lookup 200
300:    from all fwmark 0x64/0xff lookup 300
32766:  from all lookup main
32767:  from all lookup default

# unmarked traffic -> main (eth0)
$ ip route get 8.8.8.8
8.8.8.8 via 172.17.0.1 dev eth0 src 172.17.0.5 uid 0

# marked traffic (fwmark 0x64) -> rule 300 -> table 300 -> uplinkA
$ ip route get 8.8.8.8 mark 0x64
8.8.8.8 via 192.0.2.254 dev uplinkA table 300 mark 0x64 uid 0
```

The `0x64/0xff` is a mark/mask (mark this traffic with `0x64`, tested against a mask
of `0xff`). On a real box the firewall applies the mark (an `nft` rule per source network, or
VPN software tagging its own packets) and the `fwmark` rule does the steering.
Per-user routing chains off the same idea: an owner-match rule marks traffic, a
policy rule sends it down a tunnel.

## IPv6 and the `default` table: same model, independent lists

IPv6 is not bolted on — it is the *same* rule/table model with fully independent
lists and tables (the same separation you already see in
[IPv6 at home](/posts/ipv6-at-home/)). `ip -6 rule` and `ip -6 route ... table` do
the identical thing:

```console
$ ip -6 route add default via 2001:db8:1::ff dev uplinkA table 100
$ ip -6 route add default via 2001:db8:2::ff dev uplinkB table 200
$ ip -6 rule add from 2001:db8:1::1 table 100 priority 100
$ ip -6 rule add from 2001:db8:2::1 table 200 priority 200
$ ip -6 route get 2001:db8:ff::1 from 2001:db8:1::1
2001:db8:ff::1 from 2001:db8:1::1 via 2001:db8:1::ff dev uplinkA table 100 ...
$ ip -6 route get 2001:db8:ff::1 from 2001:db8:2::1
2001:db8:ff::1 from 2001:db8:2::1 via 2001:db8:2::ff dev uplinkB table 200 ...
```

The `default` table (priority 32767) earns its name here. If I remove `main`'s
default, a destination that matches nothing in `local` or `main` finally falls
through all the way to the `default` table:

```console
$ ip route del default table main
$ ip route get 203.0.113.7
203.0.113.7 via 192.0.2.254 dev uplinkA table default src 192.0.2.1 uid 0
# re-add it, and main (32766) is consulted before default (32767) again:
$ ip route add default via 172.17.0.1 dev eth0
$ ip route get 203.0.113.7
203.0.113.7 via 172.17.0.1 dev eth0 src 172.17.0.5 uid 0
```

That ordering — `local` → your rules → `main` → `default` — is the exact reason
policy routing is predictable: as long as you know the priority numbers, you know
what wins.

## What Docker and WireGuard are really doing

None of this is exotic to the tools you already run. [Docker networking](/posts/docker-networking/)
and WireGuard are, under the hood, installers of `ip route` and `ip rule`.

- **WireGuard's** `wg-quick` is literally a shell script that calls `ip link`,
  `ip address`, `ip route`, and `ip rule`. Its `Table = <n>` option puts routes in a
  private table plus the policy rules to steer traffic into it, and
  `FirewallMark = <n>` exists precisely so traffic can be routed on an `fwmark`
  rule — which is why split tunneling "just works."
- **Docker** adds its own rule/table entries on the host for each bridge network —
  for container-to-container communication and interface-keyed selection — which is
  why `ip rule show` on a busy Docker host lists more than the three built-ins.
- The veth/netns machinery that makes a container's network a private stack (with its
  own rules and tables) I covered in
  [network namespaces and veth](/posts/network-namespaces-and-veth/). Policy routing
  is what a runtime decides *inside* each stack and on the stitching host.

To see it, bring up a WireGuard interface with a non-default `Table` and run
`ip rule show` before and after on a host you control — I didn't here (no host
privileges), so I'll point at it rather than fake output I don't have.

## The honest caveats

I ran into all of these live, so here is the truth rather than the folklore.

- **Rules are order-sensitive, and "a bad rule blackholes traffic" is only half
  true.** A rule that points at an *empty* table does **not** blackhole — the lookup
  fails and the kernel **falls through** to the next rule. I proved it by adding a
  top-priority rule for `198.51.100.1` into an empty table 888, and the packet still
  routed via table 200:

  ```console
  # priority-50 rule for 198.51.100.1 -> empty table 888, no routes in it
  $ ip rule add from 198.51.100.1 table 888 priority 50
  $ ip route show table 888
  Error: ipv4: FIB table does not exist.
  $ ip route get 8.8.8.8 from 198.51.100.1
  8.8.8.8 from 198.51.100.1 via 198.51.100.254 dev uplinkB table 200 uid 0
  ```

  What *does* blackhole is an explicit unreachable route, or a table whose default
  points at a tunnel/gateway that isn't up. Preempt the good rule with a table that
  has an `unreachable default` and the kernel gives up immediately:

  ```console
  $ ip route add unreachable default table 900
  $ ip rule add from 192.0.2.1 table 900 priority 90   # 90 < 100, which preempts 100
  $ ip route get 8.8.8.8 from 192.0.2.1
  RTNETLINK answers: Host is unreachable              # exit code 2, a real blackhole
  $ ip route get 8.8.8.8 from 198.51.100.1
  8.8.8.8 from 198.51.100.1 via 198.51.100.254 dev uplinkB table 200 uid 0
  ```

  So watch priority numbers and check for a live tunnel; a too-low priority silently
  captures traffic, and a dead gateway fails closed (no traffic) instead of loudly.
- **It is per-address, not per-host.** These rules key on the source address. Two
  processes sharing one source address share one fate — per-user/per-process routing
  still needs the firewall's owner match to disambiguate.
- **Persistence is not automatic.** Nothing here survives a reboot, and it should not
  be applied ad hoc or you will fight whatever manages the host. The config has to be
  owned by **systemd-networkd** (`[RoutingPolicyRule]` with `From=`/`Table=`/
  `Priority=`/`FirewallMark=`) or **NetworkManager** (`ipv4.route-table` and
  `ipv4.routing-rules`). Putting rules in a boot script *and* letting NetworkManager
  manage the link is how you get mysterious conflicts.
- **Clean up after experiments.** Deleting a rule is `ip rule del priority N`; forget
  a stale rule and you have routed a source address into a table that no longer
  exists. In my container I removed every rule/table/interface and confirmed the netns
  was back to just `eth0` and the three built-in rules.

## The short version

Normal **routing** forwards on the destination, longest-prefix, in one table.
**Policy routing** with **iproute2** adds an ordered rule list: `ip rule` selects a
**routing table** by source address, `fwmark`, or interface, ordered by priority, and
`ip route` fills those tables. `ip route get <dst> from <src>` is the debugger — it
runs the real lookup and shows which table won. That single mechanism is what carries
two uplinks, split-tunnel VPNs, and source-specific return paths, and it is exactly
what Docker and WireGuard install for you. Build it once in a throwaway netns with
`CAP_NET_ADMIN` and it stops being magic: just tables, rules, and a readable order of
consultation.
