---
title: "nftables in practice: replacing iptables without the pain"
description: "A practical nftables guide: the tables/chains/rules model, a complete default-deny nftables ruleset for a server, sets and named intervals for IP lists, masquerade and port-forwarding NAT, persistence, and how to read the ruleset without locking yourself out."
pubDate: 2026-11-26
lang: en
translationKey: nftables-in-practice
tags: [linux, networking, security]
featured: false
keywords:
  - nftables
  - iptables to nftables
  - nftables ruleset
  - firewall
  - masquerade
---

`nftables` is the firewall that finally makes Linux packet filtering feel like one
thing instead of four. If you have ever maintained an `iptables` ruleset, you know
the ritual: `iptables` for IPv4, `ip6tables` for IPv6, legacy on one distro and
`iptables-nft` on another, `ipset` for any list worth having, and a quiet dread
every time you edit a live chain. Converting **iptables to nftables** is not just a
syntax change — it replaces four tools with a single `nft` binary and turns the
**firewall** into something you can read top to bottom. I have migrated every box I
run, from a home router to public VPSes, and this is the walkthrough I wish someone
had handed me.

## The mental model: tables → chains → rules

There are exactly three nouns in nftables, and once they click the rest is syntax.

- **Table** — a namespace that groups chains. Every table has a *family*: `ip`,
  `ip6`, `inet`, `arp`, `bridge`, or `netdev`. The one you almost always want is
  **`inet`**, which holds IPv4 and IPv6 rules together. That single choice deletes
  the entire `iptables`/`ip6tables` duplication.
- **Chain** — an ordered list of rules. A chain attached to a **hook** sees real
  traffic; a regular chain is just a subroutine you `jump` to. A hooked chain needs
  three things: a `type` (`filter`, `nat`, `route`), a `hook` (`prerouting`,
  `input`, `forward`, `output`, `postrouting`) and a `priority`.
- **Rule** — a match plus a statement. `tcp dport 443 accept` is a rule. Rules run
  top to bottom inside their chain, first match wins, and `policy` decides what
  happens if nothing matched.

**Priority** is the part people trip on. The kernel runs chains in ascending
priority order at each hook, across *all* tables. A `nat` chain at `priority
dstnat` (`-100`) therefore runs before a `filter` chain at `priority filter` (`0`)
on the same hook. You rarely type numbers — the named values exist so you never
have to.

<figure>
  <svg viewBox="0 0 800 360" width="100%" role="img" aria-labelledby="nft-path-title nft-path-desc" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">
    <title id="nft-path-title">The netfilter packet path through nftables hooks</title>
    <desc id="nft-path-desc">A packet enters at prerouting, hits the routing decision, then goes to input for local delivery or forward for transit, and finally to postrouting on the way out.</desc>
    <g fill="none" stroke="#0f766e" stroke-width="1.5">
      <rect x="20" y="178" width="70" height="44" rx="8" stroke-opacity="0.4"/>
      <rect x="140" y="178" width="130" height="44" rx="8"/>
      <rect x="320" y="178" width="130" height="44" rx="8"/>
      <rect x="440" y="68" width="120" height="44" rx="8"/>
      <rect x="610" y="68" width="150" height="44" rx="8" stroke-opacity="0.4"/>
      <rect x="610" y="178" width="150" height="44" rx="8"/>
      <rect x="440" y="278" width="120" height="44" rx="8"/>
      <rect x="610" y="278" width="150" height="44" rx="8"/>
    </g>
    <g stroke="#0f766e" stroke-width="1.5">
      <line x1="90" y1="200" x2="130" y2="200"/><polygon points="134,200 124,195 124,205" fill="#0f766e"/>
      <line x1="270" y1="200" x2="310" y2="200"/><polygon points="314,200 304,195 304,205" fill="#0f766e"/>
      <line x1="385" y1="178" x2="385" y2="90"/><line x1="385" y1="90" x2="430" y2="90"/><polygon points="434,90 424,85 424,95" fill="#0f766e"/>
      <line x1="560" y1="90" x2="600" y2="90"/><polygon points="604,90 594,85 594,95" fill="#0f766e"/>
      <line x1="685" y1="112" x2="685" y2="168"/><polygon points="685,172 680,162 690,162" fill="#0f766e"/>
      <line x1="385" y1="222" x2="385" y2="300"/><line x1="385" y1="300" x2="430" y2="300"/><polygon points="434,300 424,295 424,305" fill="#0f766e"/>
      <line x1="560" y1="300" x2="600" y2="300"/><polygon points="604,300 594,295 594,305" fill="#0f766e"/>
      <line x1="685" y1="222" x2="685" y2="268"/><polygon points="685,272 680,262 690,262" fill="#0f766e"/>
      <line x1="760" y1="300" x2="778" y2="300"/><polygon points="782,300 772,295 772,305" fill="#0f766e"/>
    </g>
    <g fill="currentColor" text-anchor="middle">
      <text x="55" y="205">in</text>
      <text x="205" y="198" font-weight="600">prerouting</text>
      <text x="205" y="214" font-size="10" opacity="0.7">nat · dstnat · -100</text>
      <text x="385" y="205">routing decision</text>
      <text x="500" y="88" font-weight="600">input</text>
      <text x="500" y="104" font-size="10" opacity="0.7">filter · 0</text>
      <text x="685" y="94">local process</text>
      <text x="685" y="198" font-weight="600">output</text>
      <text x="685" y="214" font-size="10" opacity="0.7">filter · 0</text>
      <text x="500" y="298" font-weight="600">forward</text>
      <text x="500" y="314" font-size="10" opacity="0.7">filter · 0</text>
      <text x="685" y="298" font-weight="600">postrouting</text>
      <text x="685" y="314" font-size="10" opacity="0.7">nat · srcnat · +100</text>
      <text x="770" y="292" font-size="10" opacity="0.7">out</text>
    </g>
  </svg>
  <figcaption>Every packet crosses the same five hooks. A chain only sees traffic if you hook it there: <code>prerouting</code> before the routing decision, <code>input</code> or <code>forward</code> after it, and <code>postrouting</code> on the way out.</figcaption>
</figure>

## From iptables to nftables: what actually changed

- **One tool.** `nft` replaces `iptables`, `ip6tables`, `arptables`, `ebtables`
  and `ipset`.
- **One address-family view.** `table inet` matches IPv4 and IPv6 in the same rule,
  so you stop maintaining two parallel rulesets.
- **You define the chains.** There is no fixed `INPUT`/`OUTPUT`/`FORWARD` to
  append to. You create a chain and hook it where you want it.
- **Sets are native.** An IP list is a first-class object with fast membership
  lookups — no separate `ipset` tool, no generating a chain per address.
- **Atomic loads.** `nft -f ruleset.nft` swaps the *entire* ruleset in one
  transaction. If any line fails to parse, nothing is applied.
- **A real config file.** The ruleset is text you keep in version control, not the
  accumulated residue of a hundred `iptables -A` commands.

```bash
# the old world
iptables  -A INPUT -p tcp --dport 22 -j ACCEPT
ip6tables -A INPUT -p tcp --dport 22 -j ACCEPT
iptables  -A INPUT -j DROP

# the new world: one table, one chain, both families
nft add table inet filter
nft add chain inet filter input '{ type filter hook input priority filter; policy drop; }'
nft add rule  inet filter input tcp dport 22 accept
```

In practice I do not type `nft add` interactively. I write the whole rule set in a
file and load it — which is the next section.

## A real nftables ruleset for a server

This is the ruleset I put on a public box: **default deny** on input, allow
loopback, allow established, drop invalid, allow SSH and HTTP(S), and drop
everything else with a counter so I can watch the noise.

```nft
#!/usr/sbin/nft -f
# /etc/nftables.conf — default-deny firewall for a public server

flush ruleset

table inet filter {
    chain input {
        type filter hook input priority filter; policy drop;

        # 1. loopback always talks to itself
        iifname "lo" accept

        # 2. replies to connections we opened, plus ICMP errors
        ct state established,related accept
        ct state invalid drop

        # 3. the ICMP we actually want (v4 and v6 in one place)
        ip  protocol icmp   icmp   type { echo-request, destination-unreachable, time-exceeded } accept
        ip6 nexthdr  icmpv6 icmpv6 type { echo-request, destination-unreachable, packet-too-big, time-exceeded, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept

        # 4. SSH: allow, but throttle floods of new connections per source
        tcp dport 22 ct state new limit rate over 8/minute burst 4 packets
        tcp dport 22 accept

        # 5. the web
        tcp dport { 80, 443 } accept

        # 6. everything left is dropped, and counted
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

A few things worth calling out:

- `flush ruleset` makes the file self-contained: loading it replaces whatever else
  was there, so the file is the whole truth.
- Order matters. `ct state established,related accept` must come before the default
  drop, or replies to your *own* outbound SSH die.
- `limit rate over 8/minute` only bites when one source opens more *new* connections
  than the burst allows; normal logins never notice it.
- `policy drop` on `forward` matters the moment the box routes — a router, or a
  host running VMs behind a bridge. That is where a segmentation policy lives; if
  you are dividing a network, see [home network segmentation](/posts/home-network-segmentation/).
- If **Docker** is present, its published ports write their own rules. Keep service
  ports on loopback and reverse-proxy them. My
  [VPS hardening checklist](/posts/hardening-a-public-server/) covers that plus the
  rest of the pre-flight work — SSH keys, fail2ban, unattended upgrades.

## Managing IP lists with sets and named intervals

Sets are where nftables pulls decisively ahead of iptables. A set is a named
collection of values that a rule can match against in one step.

```nft
table inet filter {
    # a named set of exact addresses
    set admin_hosts {
        type ipv4_addr
        flags interval
        elements = { 198.51.100.7, 203.0.113.0/24 }
    }

    # a named interval set: ranges and CIDRs, auto-merged
    set bogons {
        type ipv4_addr
        flags interval
        auto-merge
        elements = {
            0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16,
            172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4
        }
    }

    chain input {
        type filter hook input priority filter; policy drop;
        # ...
        ip saddr @bogons drop
        tcp dport 22 ip saddr @admin_hosts accept
        # ...
    }
}
```

Update a live set without touching the rest of the firewall:

```bash
# add one address to a running set — applies instantly
nft add element    inet filter admin_hosts { 203.0.113.55 }
# remove it
nft delete element inet filter admin_hosts { 203.0.113.55 }
# inspect what a set holds
nft list set inet filter admin_hosts
```

Because a match is a set lookup rather than a chain of comparisons, a set holding
ten thousand addresses costs roughly the same per packet as one holding ten. That
is the difference between a **firewall** you can grow and one you keep apologising
for. The `flags interval` plus `auto-merge` combination is what lets you write
`10.0.0.0-10.0.0.255` next to overlapping CIDRs and have nftables collapse them
into a minimal interval set on its own.

## NAT: masquerade, source NAT, and port forwarding

nftables NAT is just a normal chain with `type nat`. Put source NAT in a
`postrouting` chain; **masquerade** rewrites the source address to whatever the
outgoing interface's address is, which is exactly what a dynamic WAN wants.

```nft
table inet nat {
    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;
        oifname "eth0" masquerade
    }
}
```

On a static link, prefer explicit SNAT so nothing depends on the interface
address changing — `oifname "eth0" snat to 203.0.113.10`.

Port forwarding is destination NAT in `prerouting`:

```nft
table inet nat {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        # public :8080 -> internal web server
        iifname "eth0" tcp dport 8080 dnat to 10.0.0.5:80
        # public :2222 -> a lab box's SSH
        iifname "eth0" tcp dport 2222 dnat to 10.0.0.9:22
    }
}
```

Two things people forget. First, forwarding needs `net.ipv4.ip_forward=1` and a
matching `accept` in the `forward` chain — masquerade does not open the forward
path by itself.

```bash
sudo sysctl -w net.ipv4.ip_forward=1
echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-forward.conf
```

```nft
    chain forward {
        type filter hook forward priority filter; policy drop;
        iifname "eth0" oifname "lan0" ct state established,related accept
        iifname "eth0" oifname "lan0" tcp dport { 22, 80 } accept
    }
```

Second, the DNAT happens in `prerouting`, before the routing decision, so the
`forward` filter chain sees the packet already destined for the internal host.

## Persistence: keeping your firewall across reboots

A ruleset lives in the kernel and dies with the machine. The fix is a file plus a
unit.

```bash
# /etc/nftables.conf is loaded by the nftables.service unit at boot
sudo nft --check -f /etc/nftables.conf   # syntax check, apply nothing
sudo nft -f /etc/nftables.conf           # apply now (atomic)

# Debian / Ubuntu
sudo systemctl enable --now nftables
systemctl status nftables --no-pager

# capture what is actually running back into the file
sudo sh -c 'nft list ruleset > /etc/nftables.conf'
```

On the RHEL/Fedora family the unit is also `nftables.service`, but it loads
`/etc/sysconfig/nftables.conf`, which `include`s your file. Whichever distro, the
model is the same: the file is the source of truth, the unit replays it at boot,
and because `nft -f` is atomic, a broken file never leaves you half-configured.

## Reading the ruleset with `nft list ruleset`

Half the value of one tool is one view.

```bash
nft list ruleset               # every table, both address families
nft list table inet filter     # just the filter table
nft -a list ruleset            # annotate each rule with its handle
nft list sets                  # your IP lists and their elements
nft monitor                    # live tail of ruleset changes
```

Handles are how you delete a single rule — `nft delete rule inet filter input
handle 27` — and `nft list ruleset` emits a file that is itself a valid ruleset,
which is why the persistence round-trip above works.

## Don't lock yourself out

There is one rule for remote firewalls: never be the *only* reason you cannot get
back in. Concretely: allow your SSH port before you ever set a default-drop policy,
keep a second session open, and know how to reach the provider's console.

```bash
# 1. save what is running NOW, before changing anything
sudo nft list ruleset > /root/nftables.rollback.nft

# 2. arm an automatic rollback: if you are not back in 5 minutes, revert
sudo sh -c 'sleep 300; nft -f /root/nftables.rollback.nft' &

# 3. apply the new ruleset (a syntax error here changes nothing)
sudo nft -f /etc/nftables.conf

# 4. log in from a NEW terminal and confirm access
ssh -p 22 deploy@203.0.113.10 'echo still here'
#    then cancel the timer
sudo pkill -f 'sleep 300'
```

If step 4 fails, do nothing: five minutes later the old ruleset is back and your
session recovers. Validate first with `nft --check -f` and this habit will cost you
nothing and save you a console trip.

## The short version

**iptables to nftables** is mostly subtraction. Four tools become one; two
rulesets (IPv4 and IPv6) become one `inet` table; the `ipset` dance disappears into
native sets. The mental model is three words — tables, chains, rules — plus hooks
and priorities, and then the whole **firewall** is a file you can read. Write a
default-deny `input` with `policy drop`; allow `lo`, `established,related`, the
ICMP you need, SSH and 80/443; drop the rest with a counter. Add NAT in a `nat`
chain — **masquerade** in `postrouting`, `dnat` in `prerouting`. Persist it as
`/etc/nftables.conf` behind the `nftables.service` unit, and before you load it on
a remote machine, arm a five-minute rollback and verify from a second session. Do
it once and iptables starts to look like the painful version.
