---
title: "IPv6 firewalling with nftables: one inet ruleset for both families"
description: "A hands-on IPv6 firewall lab: one nftables inet table for both address families, the ICMPv6 rules IPv6 cannot live without, link-local and multicast allowances, default-deny input, real allowed/blocked test output, and the ip6tables comparison."
pubDate: 2027-02-04
lang: en
translationKey: ipv6-firewalling-with-nftables
tags: [networking, security]
featured: false
keywords:
  - IPv6 firewall
  - nftables inet
  - ICMPv6
  - ip6tables vs nftables
  - default deny
---

Every box I run is dual stack now, and the week IPv6 went live taught me the
uncomfortable part: an **IPv6 firewall** is not IPv4 firewalling with longer
addresses. There is no NAT to hide a machine behind, ICMPv6 is load-bearing
rather than optional noise, and the tooling you inherited — `iptables` on one
side, `ip6tables` on the other — is precisely the duplication that the
**nftables `inet`** family exists to delete. So this post is the IPv6-specific
slice of the job: a real **default deny** input policy in one `inet` table,
tested with real allowed and blocked traffic, plus the **ICMPv6** rules that
IPv6 simply refuses to work without. I am not going to restate the general
nftables model — that is [nftables in
practice](/posts/nftables-in-practice/) — and I will assume you know what SLAAC
and a /64 are from [my practical IPv6 intro](/posts/ipv6-practical-intro/).
The lab below is two throwaway containers on a private IPv6 network, `NET_ADMIN`
capability only (no `--privileged`), my own boxes, cleaned up afterwards.

## Why IPv6 firewalling is a different job

Four differences matter more than everything else combined:

- **There is no NAT.** Every host holds a globally routable address, so the
  moment a v6 address is assigned, the machine is *potentially* reachable from
  the entire internet — firewalling stops being an optimisation and becomes the
  only boundary. IPv4's accident of obscurity is gone; your input policy is
  now a real security decision, not a formality.
- **ICMPv6 is mandatory, not friendly.** Neighbour Discovery (types 133–136)
  replaces ARP; Path MTU Discovery depends on "Packet Too Big" (type 2). Drop
  ICMPv6 wholesale and the stack cannot resolve neighbours or discover MTU.
  The v4 habit of "block ping" is, on v6, a self-inflicted outage.
- **Link-local and multicast are first-class traffic.** `fe80::/10` is how NDP,
  Router Advertisements and DHCPv6 talk; `ff02::/16` multicast is NDP's
  solicited-node and all-nodes group. A ruleset that only reasons about global
  unicast addresses filters the wrong half of the protocol.
- **ULA is not "private like RFC1918".** `fd00::/8` Unique Local Addresses give
  you routable, unfiltered-by-default lab space, but they are *your* addresses,
  not RFC1918's pretend-privacy. Anything with a `2000::/3` global address is on
  the public internet the second its prefix is routed.

<figure>
<svg viewBox="0 0 880 310" width="100%" role="img" aria-labelledby="inet-fam-title inet-fam-desc" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">
  <title id="inet-fam-title">An nftables inet table filtering IPv4 and IPv6 with one chain</title>
  <desc id="inet-fam-desc">An IPv4 packet and an IPv6 packet both enter the same inet table input chain, whose rules allow a service port from both families and drop everything else by policy.</desc>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" fill="currentColor">
    <text x="120" y="46" text-anchor="middle" opacity="0.7">IPv4 packet</text>
    <text x="120" y="64" text-anchor="middle">172.17.0.10 → .9:8443</text>
    <text x="120" y="176" text-anchor="middle" opacity="0.7">IPv6 packet</text>
    <text x="120" y="194" text-anchor="middle">fd00:ab:ce::3 → ::2:8443</text>
  </g>
  <g fill="none" stroke="#0f766e" stroke-width="1.5">
    <rect x="20" y="26" width="200" height="52" rx="8" stroke-opacity="0.45"/>
    <rect x="20" y="156" width="200" height="52" rx="8" stroke-opacity="0.45"/>
    <line x1="220" y1="52" x2="290" y2="120"/>
    <line x1="220" y1="182" x2="290" y2="195"/>
    <rect x="292" y="26" width="330" height="262" rx="12"/>
    <line x1="622" y1="150" x2="700" y2="96"/>
    <line x1="622" y1="165" x2="700" y2="212"/>
  </g>
  <g stroke="#0f766e" stroke-width="1.5" fill="none">
    <polygon points="294,118 283,113 284,124" fill="#0f766e"/>
    <polygon points="704,96 693,91 694,102" fill="#0f766e" transform="rotate(35 704 96)"/>
    <polygon points="704,212 693,207 694,218" fill="#0f766e" transform="rotate(-35 704 212)"/>
  </g>
  <g fill="currentColor">
    <text x="457" y="54" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14" font-weight="600">table inet fw</text>
    <text x="457" y="74" text-anchor="middle" font-size="11" opacity="0.7">chain input · type filter hook input · priority filter</text>
    <text x="457" y="92" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" fill="#0f766e">policy drop</text>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11.5">
    <text x="310" y="122">iifname "lo" accept</text>
    <text x="310" y="142">ct state established,related accept</text>
    <text x="310" y="162">ip6 nexthdr ipv6-icmp icmpv6 type { nd-*, packet-too-big }</text>
    <text x="310" y="182">ip6 saddr fe80::/10 accept</text>
    <text x="310" y="202">ip6 daddr ff02::/16 accept</text>
    <text x="310" y="222" font-weight="600">tcp dport 8443 accept</text>
    <text x="310" y="242">ip6 saddr fd00:ab:ce::/64 tcp dport 2222 accept</text>
    <text x="310" y="270">counter drop</text>
  </g>
  <g fill="none" stroke="#0f766e" stroke-width="1.5">
    <rect x="706" y="70" width="154" height="52" rx="8"/>
    <rect x="706" y="186" width="154" height="52" rx="8" stroke-dasharray="5 4"/>
  </g>
  <g fill="currentColor" font-size="11">
    <text x="783" y="90" text-anchor="middle">local socket</text>
    <text x="783" y="106" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10" opacity="0.75">*:8443 (one listener)</text>
    <text x="783" y="206" text-anchor="middle">dropped · counted</text>
    <text x="783" y="222" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10" opacity="0.75">counter packets 12</text>
  </g>
</svg>
<figcaption>One <code>inet</code> table, one <code>input</code> chain at priority <code>filter</code>. The same rule sees an IPv4 SYN and an IPv6 SYN, so the ruleset that protects a box stops existing twice. In my lab the drop counter reached 12 packets while IPv4 and IPv6 traffic flowed through the same chain.</figcaption>
</figure>

## The nftables `inet` family: one table, both families

An nftables table's *family* is the first decision you make. `ip` filters IPv4
only, `ip6` filters IPv6 only, and `inet` filters both — one table, one set of
chains, one `nft list ruleset` view. That is the whole feature: a rule like
`tcp dport 8443 accept` inside an `inet` chain matches the IPv4 SYN from
`172.17.0.10` and the IPv6 SYN from `fd00:ab:ce::3` with a single line.

Two details only become visible with real traffic, and I want to show them
rather than assert them. First, how I *wrote* rules versus how the kernel
restates them in `nft list ruleset`:

```nft
# what I typed in the file:
meta nfproto ipv6 ip6 saddr fd00:ab:ce::/64 tcp dport 2222 accept
meta nfproto ipv6 icmpv6 type echo-request accept
```

```bash
# what nft list ruleset prints back:
	ip6 saddr fd00:ab:ce::/64 tcp dport 2222 accept
	icmpv6 type echo-request accept
```

Address and protocol matches already imply the family, so nftables drops my
redundant `meta nfproto ipv6`. It is accepted syntax and useful when a rule
genuinely has no other family hint, but in practice `icmpv6 type …` and
`ip6 saddr …` are the family scoping you want. Second, the ICMPv6 type names
are symbolic, and you can ask nftables for the table:

```bash
$ nft describe icmpv6 type
pre-defined symbolic constants (in decimal):
	destination-unreachable       	                   1
	packet-too-big                	                   2
	time-exceeded                 	                   3
	parameter-problem             	                   4
	echo-request                  	                 128
	echo-reply                    	                 129
	nd-neighbor-solicit           	                 135
	nd-neighbor-advert            	                 136
```

That is how I know types 133–136 are NDP and 2 is PMTUD: short names instead of
magic numbers in a ruleset you will read again in a year. (The full listing
includes MLD and the redirect/renumbering types too.)

## The default-deny ruleset, with the IPv6 essentials

Here is the complete file I loaded — one `inet` table, `policy drop` on input,
and the handful of v6-specific allowances in the middle. The lab addresses are
ULA (`fd00::/8`) so nothing public is involved.

```nft
#!/usr/sbin/nft -f
# /root/fw6.nft — one `inet` table: default-deny input, IPv4 AND IPv6.

flush ruleset

table inet fw {
    chain input {
        type filter hook input priority filter; policy drop;

        # 1. loopback is always local
        iifname "lo" accept

        # 2. replies to connections WE opened, plus their ICMP errors
        ct state established,related accept
        ct state invalid drop

        # 3a. ICMPv6 the stack itself generates and consumes:
        #     NDP (133-136) and Packet-Too-Big for PMTUD.
        ip6 nexthdr icmpv6 icmpv6 type {
            nd-router-solicit, nd-router-advert,
            nd-neighbor-solicit, nd-neighbor-advert,
            packet-too-big
        } accept

        # 3b. neighbours talk to us from link-local addresses
        ip6 saddr fe80::/10 accept

        # 3c. NDP/MLD use link-local multicast groups as destinations
        ip6 daddr ff02::/16 accept

        # 4. ping in either family, rate-limited so it stays cheap
        ip  protocol icmp icmp type echo-request limit rate over 30/second counter drop
        ip  protocol icmp icmp type echo-request accept
        meta nfproto ipv6 icmpv6 type echo-request limit rate over 30/second counter drop
        meta nfproto ipv6 icmpv6 type echo-request accept

        # 5. the service: ONE rule, BOTH families
        tcp dport 8443 accept

        # 6. a service that must exist on the v6 overlay only
        meta nfproto ipv6 ip6 saddr fd00:ab:ce::/64 tcp dport 2222 accept

        # 7. everything else is dropped, and counted
        counter drop
    }

    chain forward {
        type filter hook forward priority filter; policy drop;
    }

    chain output {
        type filter hook output priority filter; policy accept;
    }
}
```

```bash
$ nft --check -f /root/fw6.nft   # syntax only, applies nothing (silent = OK)
$ nft -f /root/fw6.nft           # atomic load
$ nft list ruleset               # what is actually running
table inet fw {
	chain input {
		type filter hook input priority filter; policy drop;
		iifname "lo" accept
		ct state established,related accept
		ct state invalid drop
		ip6 nexthdr ipv6-icmp icmpv6 type { packet-too-big, nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept
		ip6 saddr fe80::/10 accept
		ip6 daddr ff02::/16 accept
		ip protocol icmp icmp type echo-request limit rate over 30/second counter packets 0 bytes 0 drop
		ip protocol icmp icmp type echo-request accept
		icmpv6 type echo-request limit rate over 30/second counter packets 0 bytes 0 drop
		icmpv6 type echo-request accept
		tcp dport 8443 accept
		ip6 saddr fd00:ab:ce::/64 tcp dport 2222 accept
		counter packets 0 bytes 0 drop
	}

	chain forward {
		type filter hook forward priority filter; policy drop;
	}

	chain output {
		type filter hook output priority filter; policy accept;
	}
}
```

Read the normalisations: `ip6 nexthdr icmpv6` became `ip6 nexthdr ipv6-icmp`,
and the echo pairs lost the redundant `meta nfproto ipv6`. The pair trick in
rule 4 matters: the first line drops only what *exceeds* the rate (its counter
stays at zero in a healthy lab), the second accepts everything else — a cheap
way to survive a ping flood without blocking ICMPv6 outright.

## Testing it: real allowed and real blocked traffic

The rig: `srv6` is the box under test (`fd00:ab:ce::2` on eth0, `172.17.0.9` on
eth1), `cli6` is a plain client (`fd00:ab:ce::3`, `172.17.0.10`). One listener
serves both families — python bound to `::`:

```bash
$ ss -lntp
State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess
LISTEN 0      4096      127.0.0.11:37605      0.0.0.0:*
LISTEN 0      5                  *:8443             *:*    users:(("python3",pid=3558,fd=3))
```

Now the traffic. Both families pass, through one ruleset:

```bash
$ ping6 -c 3 fd00:ab:ce::2                 # IPv6, allowed
PING fd00:ab:ce::2(fd00:ab:ce::2) 56 data bytes
64 bytes from fd00:ab:ce::2: icmp_seq=1 ttl=64 time=0.104 ms
64 bytes from fd00:ab:ce::2: icmp_seq=2 ttl=64 time=0.075 ms
64 bytes from fd00:ab:ce::2: icmp_seq=3 ttl=64 time=0.056 ms

--- fd00:ab:ce::2 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2058ms
rtt min/avg/max/mdev = 0.056/0.078/0.104/0.019 ms

$ ping -c 3 172.17.0.9                      # IPv4, same ruleset
PING 172.17.0.9 (172.17.0.9) 56(84) bytes of data.
64 bytes from 172.17.0.9: icmp_seq=1 ttl=64 time=0.115 ms
64 bytes from 172.17.0.9: icmp_seq=2 ttl=64 time=0.047 ms
64 bytes from 172.17.0.9: icmp_seq=3 ttl=64 time=0.062 ms

--- 172.17.0.9 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2026ms
rtt min/avg/max/mdev = 0.047/0.074/0.115/0.029 ms
```

The service rule covers both families — note the `remote_ip`:

```bash
$ curl -6 -m 5 -sS -o /dev/null -w 'HTTP %{http_code} via %{remote_ip}\n' http://[fd00:ab:ce::2]:8443/
HTTP 200 via fd00:ab:ce::2
$ curl -4 -m 5 -sS -o /dev/null -w 'HTTP %{http_code} via %{remote_ip}\n' http://172.17.0.9:8443/
HTTP 200 via 172.17.0.9
```

And a port with no rule, in both families — the connection just times out,
because `policy drop` discards instead of rejecting:

```bash
$ sh -c 'curl -6 -m 4 -sS -o /dev/null -w "%{http_code} via %{remote_ip}\n" http://[fd00:ab:ce::2]:9999/; echo curl exit=$?'
curl: (28) Connection timed out after 4000 milliseconds
000 via
curl exit=28
```

Proof that the drop really happened in the firewall — the final counter is the
policy drop:

```bash
$ nft list chain inet fw input
table inet fw {
	chain input {
		type filter hook input priority filter; policy drop;
		iifname "lo" accept
		ct state established,related accept
		ct state invalid drop
		ip6 nexthdr ipv6-icmp icmpv6 type { packet-too-big, nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept
		ip6 saddr fe80::/10 accept
		ip6 daddr ff02::/16 accept
		ip protocol icmp icmp type echo-request limit rate over 30/second counter packets 0 bytes 0 drop
		ip protocol icmp icmp type echo-request accept
		icmpv6 type echo-request limit rate over 30/second counter packets 0 bytes 0 drop
		icmpv6 type echo-request accept
		tcp dport 8443 accept
		ip6 saddr fd00:ab:ce::/64 tcp dport 2222 accept
		counter packets 8 bytes 560 drop
	}
}
```

Eight packets, 560 bytes — the retransmitted SYNs of the blocked connection
attempts, counted at the last rule. One honest caveat: `nft monitor trace` was
silent in my containers (the per-packet trace facility needs a context my lab
netns did not grant), so counters were my packet-level evidence; plain
`nft monitor`, which watches ruleset changes, worked fine — this is its real
output when I added a rule live:

```bash
$ nft add rule inet fw input tcp dport 9443 accept        # in one shell
add rule inet fw input tcp dport 9443 accept              # nft monitor, another shell
# new generation 13 by process 1207483 (nft)
```

Link-local traffic proves the `fe80::/10` allowance — and the zone ID is
mandatory, exactly as in the intro post:

```bash
$ ping6 -I eth0 -c 2 fe80::fc29:25ff:fe16:9846%eth0      # from cli6, to srv6's link-local
ping6: Warning: source address might be selected on device other than: eth0
PING fe80::fc29:25ff:fe16:9846%eth0(fe80::fc29:25ff:fe16:9846%eth0) from :: eth0: 56 data bytes
64 bytes from fe80::fc29:25ff:fe16:9846%eth0: icmp_seq=1 ttl=64 time=0.084 ms
64 bytes from fe80::fc29:25ff:fe16:9846%eth0: icmp_seq=2 ttl=64 time=0.060 ms

--- fe80::fc29:25ff:fe16:9846%eth0 ping statistics ---
2 packets transmitted, 2 received, 0% packet loss, time 1016ms
rtt min/avg/max/mdev = 0.060/0.072/0.084/0.012 ms
```

## ICMPv6: what breaking it actually looks like

I deliberately made the classic mistake so you never have to: drop all ICMPv6
on the input hook, then force a fresh neighbour resolution.

```bash
$ nft insert rule inet fw input ip6 nexthdr ipv6-icmp counter drop
$ ip -6 neigh flush dev eth0             # forget what we learnt about peers
$ ping6 -c 2 fd00:ab:ce::3                # srv6 -> cli6: needs NDP to resolve
PING fd00:ab:ce::3(fd00:ab:ce::3) 56 data bytes

--- fd00:ab:ce::3 ping statistics ---
2 packets transmitted, 0 received, 100% packet loss, time 1015ms

$ ping6 -c 2 fd00:ab:ce::2                # cli6 -> srv6: the echo itself is dropped
--- fd00:ab:ce::2 ping statistics ---
2 packets transmitted, 0 received, +2 errors, 100% packet loss, time 1013ms

$ ping -c 2 172.17.0.9                     # IPv4 on the same box: perfectly fine
2 packets transmitted, 2 received, 0% packet loss, time 1031ms
rtt min/avg/max/mdev = 0.059/0.074/0.089/0.015 ms
```

That is the whole failure mode: the host still has full IPv4 connectivity and
feels healthy, while IPv6 is dead — neighbour solicitations go out, the
advertisements coming back are dropped at the input hook, and `ip -6 neigh`
never reaches `REACHABLE`. The counter shows the cost of the mistake:

```bash
$ nft -a list chain inet fw input | head -6
table inet fw {
	chain input { # handle 1
		type filter hook input priority filter; policy drop;
		ip6 nexthdr ipv6-icmp counter packets 11 bytes 952 drop # handle 20
		iifname "lo" accept # handle 4
```

Remove the bad rule and the network recovers on its own — NDP simply finishes
its job:

```bash
$ nft delete rule inet fw input handle 20
$ ip -6 neigh flush dev eth0
$ ping6 -c 2 fd00:ab:ce::2                  # from cli6
2 packets transmitted, 2 received, 0% packet loss, time 1043ms

$ ip -6 neigh show dev eth0
fd00:ab:ce::3 lladdr de:52:e7:55:19:1b DELAY
```

So the practical rule, which RFC 4890 says in a louder voice: never drop ICMPv6
wholesale. NDP types (133–136) and `packet-too-big` (2) must pass; echo-request
(128) is fine to rate-limit, and echo-reply plus `destination-unreachable` are
best handled through `ct state established,related`, which the earlier rule
already covers.

## `ip6tables` vs `nftables`, on a modern distro

"**ip6tables vs nftables**" is not the 2010 migration story anymore. On Debian
12 the shipped `iptables` *is* an nft backend:

```bash
$ iptables --version
iptables v1.8.9 (nf_tables)
```

Which means the legacy workflow still works — and still maintains a *separate*
v6 ruleset beside the v4 one:

```bash
$ ip6tables -A INPUT -p tcp --dport 22 -j ACCEPT
$ ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
$ ip6tables -A INPUT -p ipv6-icmp -j ACCEPT
$ ip6tables -A INPUT -p tcp --dport 8443 -j ACCEPT
$ ip6tables -P INPUT DROP
$ ip6tables -L INPUT -n -v
Chain INPUT (policy DROP 0 packets, 0 bytes)
 pkts bytes target     prot opt in     out     source               destination
    0     0 ACCEPT     6    --  *      *       ::/0                 ::/0                 tcp dpt:22
    0     0 ACCEPT     0    --  *      *       ::/0                 ::/0                 ctstate RELATED,ESTABLISHED
    0     0 ACCEPT    58    --  *      *       ::/0                 ::/0
    0     0 ACCEPT     6    --  *      *       ::/0                 ::/0                 tcp dpt:8443
```

Two views, one kernel: `nft list ruleset` shows my `inet` table *and* the
legacy `ip6 filter` table it wrote, side by side, with a warning attached:

```bash
table inet fw {
	chain input {
		type filter hook input priority filter; policy drop;
		# ... the ruleset above, unchanged
	}
	# forward/output chains omitted here
}
table ip6 filter {
	chain INPUT {
		type filter hook input priority filter; policy drop;
		tcp dport 22 counter packets 0 bytes 0 accept
		ct state related,established counter packets 0 bytes 0 accept
		meta l4proto ipv6-icmp counter packets 0 bytes 0 accept
		tcp dport 8443 counter packets 0 bytes 0 accept
	}
}
# Warning: table ip6 filter is managed by iptables-nft, do not touch!
```

Note the stacking gotcha in that output: both chains hook `input` at the same
priority, so both *apply* — the legacy `ip6` table's policy drop is a second
net under my `inet` chain (and it was still counting ICMPv6 my table had
already accepted). Mixing the two tools means reasoning about two overlapping
rulesets; writing one `inet` table means there is exactly one file to read. If
you keep any legacy rules around after migrating, check which family tables
still exist with `nft list tables` before you trust a `curl`.

## The minimal working ruleset

Adapting this to a real box is substitution, not redesign: your real interfaces
(`iifname "eth0"` where useful), your real service ports, your real address
policy — allow global `2000::/3` sources or a ULA range deliberately, never by
accident. For persistence the story is unchanged from the nftables post:
`/etc/nftables.conf` behind `nftables.service`, `nft --check` before every
load, and a rollback timer before you touch a firewall over SSH.

The one thing I would tattoo: **never drop ICMPv6 wholesale.** Allow NDP and
`packet-too-big` unconditionally, allow link-local `fe80::/10` sources and
`ff02::/16` multicast destinations, rate-limit echo, and let `ct state
established,related` carry the error messages back. Everything above that —
default deny, counters, one `inet` table for both families — is mundane by
comparison, and that is the point.
