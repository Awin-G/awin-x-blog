---
title: "IPv6 SLAAC and Router Advertisements, Reproduced"
description: "How a host gets an IPv6 address without DHCP — RS/RA exchange, prefix information, A/M/O flags, EUI-64 vs stable-privacy, and real radvd output."
pubDate: 2027-01-16
lang: en
translationKey: ipv6-slaac-and-ra
tags: [networking, linux]
featured: false
keywords:
  - IPv6 SLAAC
  - router advertisement
  - radvd
  - EUI-64
  - RS RA
---

If you have ever enabled IPv6 on a Linux host and watched a global address appear without touching DHCP, you have seen **IPv6 SLAAC** (Stateless Address Autoconfiguration) in action. This post reproduces the entire flow — from a router's `radvd` advertisement to a host's auto-configured address — inside throwaway Docker containers, and explains every flag and option along the way.

We will cover:

- The RS/RA exchange and what a **router advertisement** actually contains
- The A/M/O flags and how they steer hosts toward SLAAC or **DHCPv6**
- **EUI-64** vs stable-privacy address generation
- The default route from the RA
- Why "just enable IPv6" often gives you a global address you did not firewall
- How to debug with `ip -6 addr`, `ip -6 route`, `rdisc6`, and `tcpdump icmp6`

## The Lab Setup

I ran two throwaway Debian containers on a Docker bridge network. The router container ran `radvd`; the host container ran plain `iproute2` and `rdisc6`. No DHCP server anywhere.

The router's `radvd.conf`:

```conf
interface eth0
{
    AdvSendAdvert on;
    AdvManagedFlag off;
    AdvOtherConfigFlag off;
    prefix fd00:dead:beef:1::/64
    {
        AdvOnLink on;
        AdvAutonomous on;
        AdvRouterAddr off;
    };
    RDNSS fd00:dead:beef:1::1
    {
    };
};
```

The router was given a static ULA address:

```console
$ ip -6 addr add fd00:dead:beef:1::1/64 dev eth0
$ sysctl -w net.ipv6.conf.all.forwarding=1
net.ipv6.conf.all.forwarding = 1
```

## The RS → RA Exchange

When a host brings up an IPv6-enabled interface, it sends a **Router Solicitation (RS)** to `ff02::2` (all routers). Routers reply with a **Router Advertisement (RA)** to `ff02::1` (all nodes). Here is the RA captured with `tcpdump` on the router:

```console
$ tcpdump -i eth0 -vv icmp6
tcpdump: listening on eth0, link-type EN10MB (Ethernet), snapshot length 262144 bytes
23:54:54.068011 IP6 (flowlabel 0x2b2df, hlim 255, next-header ICMPv6 (58) payload length: 80) fe80::f0d6:17ff:fe20:e09a > ip6-allnodes: [icmp6 sum ok] ICMP6, router advertisement, length 80
	hop limit 64, Flags [none], pref medium, router lifetime 1800s, reachable time 0ms, retrans timer 0ms
	  prefix info option (3), length 32 (4): fd00:dead:beef:1::/64, Flags [onlink, auto], valid time 86400s, pref. time 14400s
	    0x0000:  40c0 0001 5180 0000 3840 0000 0000 fd00
	    0x0010:  dead beef 0001 0000 0000 0000 0000
	  rdnss option (25), length 24 (3):  lifetime 600s, addr: fd00:dead:beef:1::1
	    0x0000:  0000 0000 0258 fd00 dead beef 0001 0000
	    0x0010:  0000 0000 0001
	  source link-address option (1), length 8 (1): f2:d6:17:20:e0:9a
	    0x0000:  f2d6 1720 e09a
```

Let us decode the key fields:

| Field | Value | Meaning |
|-------|-------|---------|
| `hop limit` | 64 | The router's recommended hop limit |
| `Flags [none]` | — | M=0, O=0 (no DHCPv6) |
| `router lifetime` | 1800s | How long this router is a default gateway |
| `prefix info` | `fd00:dead:beef:1::/64` | The subnet to auto-configure from |
| `Flags [onlink, auto]` | — | L=1 (on-link), A=1 (autonomous / SLAAC) |
| `rdnss` | `fd00:dead:beef:1::1` | Recursive DNS server |
| `source link-address` | `f2:d6:17:20:e0:9a` | Router's MAC |

The host's initial state — only a link-local address, no global prefix:

```console
$ ip -6 addr show eth0
2: eth0@if1452: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default  link-netnsid 0
    inet6 fe80::7ca7:21ff:fe19:fad5/64 scope link tentative
       valid_lft forever preferred_lft forever
```

## The A/M/O Flags

The three flags in the RA header tell the host how to configure itself:

- **M (Managed)** — Set to 1, the host must use **DHCPv6** to obtain its address. With M=0, the host uses SLAAC.
- **O (Other)** — Set to 1, the host should use **DHCPv6** for "other" configuration (DNS servers, NTP, etc.) even if it uses SLAAC for its address.
- **A (Autonomous)** — Per-prefix flag. Set to 1, the host may auto-configure an address from this prefix using SLAAC.

In our capture, `Flags [none]` means M=0 and O=0, and the prefix has `Flags [onlink, auto]` meaning A=1. Pure SLAAC, no DHCPv6.

When you send an RS with `rdisc6`, the tool decodes the RA for you:

```console
$ rdisc6 -1 eth0
Soliciting ff02::2 (ff02::2) on eth0...

Hop limit                 :           64 (      0x40)
Stateful address conf.    :           No
Stateful other conf.      :           No
Router preference         :       medium
Router lifetime           :         1800 (0x00000708) seconds
 Prefix                   : fd00:dead:beef:1::/64
  On-link                 :          Yes
  Autonomous address conf.:          Yes
  Valid time              :        86400 (0x00015180) seconds
  Pref. time              :        14400 (0x00003840) seconds
 Recursive DNS server     : fd00:dead:beef:1::1
 Source link-layer address: F2:D6:17:20:E0:9A
 from fe80::f0d6:17ff:fe20:e09a
```

## SLAAC: How the Host Builds Its Address

After receiving the RA, the host auto-configures its address. Here is the result:

```console
$ ip -6 addr show eth0
2: eth0@if1452: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default  link-netnsid 0
    inet6 fd00:dead:beef:1:c40f:92cc:4745:970e/64 scope global temporary dynamic
       valid_lft 86400sec preferred_lft 14400sec
    inet6 fd00:dead:beef:1:7ca7:21ff:fe19:fad5/64 scope global dynamic mngtmpaddr
       valid_lft 86400sec preferred_lft 14400sec
    inet6 fe80::7ca7:21ff:fe19:fad5/64 scope link
       valid_lft forever preferred_lft forever
```

Two global addresses appeared:

1. **A temporary address** (`fd00:dead:beef:1:c40f:92cc:4745:970e`) — the stable-privacy address used for outgoing connections. Its interface identifier is randomly generated and rotated periodically.
2. **An EUI-64 address** (`fd00:dead:beef:1:7ca7:21ff:fe19:fad5`) — derived from the MAC address, used for incoming connections.

### EUI-64 Derivation

The EUI-64 interface identifier is computed from the 48-bit MAC address:

```console
$ cat /sys/class/net/eth0/address
7e:a7:21:19:fa:d5
```

The algorithm:

1. Split the MAC in half: `7e:a7:21` + `19:fa:d5`
2. Insert `ff:fe` in the middle: `7e:a7:21:ff:fe:19:fa:d5`
3. Flip the 7th bit (U/L bit) of the first byte: `7e` → `7c` (binary `01111110` → `01111100`)
4. Resulting IID: `7c:a7:21:ff:fe:19:fa:d5`
5. Full address: `fd00:dead:beef:1:7ca7:21ff:fe19:fad5`

This matches the actual address exactly.

### Stable Privacy

The temporary address uses a **randomly generated** interface identifier, not the EUI-64 one. This prevents tracking across networks — the address changes over time (default: prefer temporary, rotate every 24 hours). The kernel creates the EUI-64 address as a "managed temporary" (`mngtmpaddr`) backup so incoming connections always have a stable destination.

## The Default Route

The RA also installs a default route. The host's routing table after SLAAC:

```console
$ ip -6 route show
fd00:dead:beef:1::/64 dev eth0 proto kernel metric 256 expires 86399sec pref medium
fe80::/64 dev eth0 proto kernel metric 256 pref medium
default via fe80::f0d6:17ff:fe20:e09a dev eth0 proto ra metric 1024 expires 1799sec hoplimit 64 pref medium
```

The `default via` line is the router's link-local address, installed with `proto ra` — it came from the RA, not from any routing daemon.

## Connectivity

```console
$ ping6 -c 3 -I eth0 fd00:dead:beef:1::1
PING fd00:dead:beef:1::1(fd00:dead:beef:1::1) from fd00:dead:beef:1:c40f:92cc:4745:970e eth0: 56 data bytes
64 bytes from fd00:dead:beef:1::1: icmp_seq=1 ttl=64 time=0.123 ms
64 bytes from fd00:dead:beef:1::1: icmp_seq=2 ttl=64 time=0.073 ms
64 bytes from fd00:dead:beef:1::1: icmp_seq=3 ttl=64 time=0.052 ms

--- fd00:dead:beef:1::1 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2068ms
rtt min/avg/max/mdev = 0.052/0.082/0.123/0.029 ms
```

End-to-end connectivity with zero manual address configuration.

## SLAAC vs DHCPv6

| | SLAAC | DHCPv6 |
|---|-------|--------|
| Address source | Prefix from RA + self-generated IID | Assigned by DHCPv6 server |
| Default route | From RA | From RA (or DHCPv6) |
| DNS servers | RDNSS option in RA (or DHCPv6) | DHCPv6 |
| M flag | 0 | 1 |
| O flag | 0 | 1 (for DNS) |
| Server required | No | Yes (DHCPv6 server) |
| Use case | Home networks, simple deployments | Enterprise, policy control |

Most home networks use SLAAC. The M=1 / O=1 combination is common in enterprises that want centralized address assignment and DNS distribution.

## Why "Just Enable IPv6" Can Be a Security Problem

When you enable IPv6 on a host and the network has a router sending RAs, the host will:

1. Auto-configure a global address (if the A flag is set)
2. Install a default route via the RA router
3. Start sending traffic over IPv6 — **without any firewall rules you wrote**

If your firewall only has IPv4 rules, IPv6 traffic passes unchecked. This is the "shadow network" problem: you think you have no global IPv6 exposure, but SLAAC silently gave you a routable address.

**Mitigation:** If you do not want IPv6, disable it explicitly:

```bash
sysctl -w net.ipv6.conf.all.disable_ipv6=1
sysctl -w net.ipv6.conf.default.disable_ipv6=1
```

Or, if you want IPv6 but want to control it, use `accept_ra=0` and configure addresses manually, or run a DHCPv6 server with your own policies.

## Debugging

```console
# Show all IPv6 addresses
$ ip -6 addr show

# Show IPv6 routes (look for "proto ra" for RA-installed routes)
$ ip -6 route show

# Check RA acceptance
$ sysctl net.ipv6.conf.eth0.accept_ra net.ipv6.conf.eth0.accept_ra_defrtr

# Send an RS and decode the RA
$ rdisc6 eth0

# Capture RA/RS packets
$ tcpdump -i eth0 -vv icmp6

# Force address regeneration (temporary addresses)
$ sysctl -w net.ipv6.conf.eth0.use_tempaddr=2
```

If SLAAC is not working, check in order:

1. Is IPv6 enabled on the interface? (`disable_ipv6=0`)
2. Is the interface accepting RAs? (`accept_ra=1`)
3. Is the router actually sending RAs? (`tcpdump icmp6`)
4. Does the RA have the A flag set? (`rdisc6` decodes it)

## Summary

**IPv6 SLAAC** is a beautifully simple protocol: the router advertises a prefix, the host appends a self-generated interface identifier, and connectivity exists. No server, no lease, no manual configuration. The **router advertisement** carries not just the prefix but also flags (A/M/O), default route, DNS servers, and lifetime information. **radvd** is the standard Linux daemon that turns a host into an IPv6 router by sending these advertisements.

The same simplicity that makes SLAAC convenient also makes it easy to overlook — which is why understanding the RA packet and the flags is essential for anyone running networks.

---

*Related: [IPv6 Practical Introduction](/posts/ipv6-practical-intro/) · [IPv6 at Home](/posts/ipv6-at-home/)*
