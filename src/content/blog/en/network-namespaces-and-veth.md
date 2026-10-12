---
title: "Network namespaces and veth: a fake network on one machine"
description: "Build a tiny multi-host network inside one Linux box with ip netns, veth pairs, a bridge and NAT. A hands-on walkthrough for testing routing, overlays and firewall rules without extra hardware, verified with ping, ip route and tcpdump."
pubDate: 2026-10-21
lang: en
translationKey: network-namespaces-and-veth
tags: [linux, networking, devops]
featured: false
keywords:
  - network namespaces
  - ip netns
  - veth pair
  - Linux networking
  - container networking
---

You want to test a routing rule, an overlay config, or a firewall policy. You do
not want to spin up three VMs, wire them together, and wait for cloud images to
boot. You do not need to. Linux can hand you a complete, isolated network stack —
interfaces, routes, ARP tables, firewall rules — as a **network namespace**, and
**veth pairs** can wire two of those stacks together exactly like a cable. Do this
a few times and you have a small multi-host network living inside a single box:
hosts that ping each other, a switch in the middle, and a router with NAT out to
the real internet.

This is the walkthrough I use for **Linux networking** experiments, and it is the
same machinery that sits under **container networking**. We will create two
namespaces, connect them with a **veth pair**, add a bridge, set up **NAT** so one
can reach the internet, and verify everything with `ping`, `ip route`, and
`tcpdump`. Then I will cover what it is actually good for and where it bites.

## Why network namespaces work: one kernel, many stacks

A network namespace is a copy of the kernel's network stack: its own interfaces,
its own routing table, its own `iptables`/`nftables` rules, its own socket space.
A process inside one sees only its namespace. This is precisely the isolation a
container gets — Docker, Podman, and Kubernetes all put a container's network into
a namespace. When you `ip netns exec ns1 ping 10.0.0.2`, you are inside `ns1`'s
view of the world, and `ns1`'s kernel networking is fully real, just walled off
from the default namespace (the host).

They are cheap. No VM, no hypervisor, no second kernel. Creating one is a
`mount --bind`, effectively, and they share the same kernel as everything else.

## Step 1 — Create two namespaces

Everything here needs `CAP_NET_ADMIN`, so run it with `sudo` (or from a privileged
container). `ip netns` is the front-end; it also mounts a per-namespace
`/var/run/netns` handle so you can refer to a namespace by name.

```bash
# create two isolated hosts
sudo ip netns add ns1
sudo ip netns add ns2

# confirm
ip netns list
```

The handle is what lets you say `ip netns exec ns1 ...` instead of juggling PIDs.
Each namespace starts with only a loopback interface, and that loopback starts
**down**. Remember that — it is the source of one classic bug.

```bash
sudo ip netns exec ns1 ip link show
```

## Step 2 — Wire the veth pair

A **veth pair** is two virtual interfaces joined at the hip: whatever enters one
end exits the other, like an Ethernet cable with a plug on each end. You create
the pair, then move one end into each namespace.

```bash
# a cable with two ends, both initially in the host
sudo ip link add veth1 type veth peer name veth2

# plug one end into ns1, the other into ns2
sudo ip link set veth1 netns ns1
sudo ip link set veth2 netns ns2
```

Now each end lives in a different stack. The host can no longer see `veth1` or
`veth2`; they exist inside their namespaces. This is the whole trick — a wire that
spans two network stacks.

## Step 3 — Assign addresses and ping

Configure addressing and bring interfaces up. Loopback needs `up` regardless,
because a lot of software assumes it exists.

```bash
# ns1
sudo ip netns exec ns1 ip addr add 10.0.0.1/24 dev veth1
sudo ip netns exec ns1 ip link set veth1 up
sudo ip netns exec ns1 ip link set lo up

# ns2
sudo ip netns exec ns2 ip addr add 10.0.0.2/24 dev veth2
sudo ip netns exec ns2 ip link set veth2 up
sudo ip netns exec ns2 ip link set lo up
```

With both ends up on the same `/24`, the kernel installs a connected route
automatically (adding an address to an interface creates the route for that
subnet). Ping across the cable:

```console
$ sudo ip netns exec ns1 ping -c2 10.0.0.2
PING 10.0.0.2 (10.0.0.2) 56(84) bytes of data.
64 bytes from 10.0.0.2: icmp_seq=1 ttl=64 time=0.061 ms
64 bytes from 10.0.0.2: icmp_seq=2 ttl=64 time=0.063 ms
```

`ttl=64` says nothing routed it — this is two hosts on one wire. Check the route
table to see why it worked:

```console
$ sudo ip netns exec ns1 ip route
10.0.0.0/24 dev veth1 proto kernel scope link src 10.0.0.1
```

One connected route, no default. `ns1` can reach `ns2` because both sit inside the
`10.0.0.0/24` "on-link" range. If you point them at different subnets with no
router in between, this stops working immediately — which is exactly the lesson.

## Step 4 — Put a bridge in the middle

A veth pair is a point-to-point cable, so it scales to two hosts. To make a
switch that connects several, use a **network bridge** — a software L2 switch.
Create it in the host, then slave each namespace's end to it.

```bash
# a virtual switch in the host
sudo ip link add br0 type bridge
sudo ip link set br0 up

# create two more namespace "hosts"
sudo ip netns add ns3
sudo ip link add veth3 type veth peer name br-veth3
sudo ip link set veth3 netns ns3
sudo ip link set br-veth3 master br0   # host-side end plugged into the switch
sudo ip link set br-veth3 up

# ns3 on the switch
sudo ip netns exec ns3 ip addr add 10.0.0.3/24 dev veth3
sudo ip netns exec ns3 ip link set veth3 up
sudo ip netns exec ns3 ip link set lo up
```

`ns3` is now on the same L2 segment as `ns1` and `ns2` — assuming they are on the
switch too, they can all ping each other and the bridge learns their MACs. The
bridge behaves like an unmanaged switch: it floods unknown destinations, learns
source MACs, and forwards. To move `ns1`/`ns2` onto it, create a host-side veth
per namespace and master it to `br0`, the same way.

## Step 5 — Add NAT so a namespace can reach the internet

Now the interesting part: give a namespace a gateway and let it reach the world.
The host is our router. Two things are required: **enable IP forwarding** on the
host, and **masquerade** (NAT) the namespaces' source addresses on the host's
outbound interface.

First, create a dedicated link/namespace for the "LAN" and give the host a leg on
it. I will route `10.99.0.0/24` for the namespace and let the host own
`10.99.0.1`:

```bash
# a veth from the host into a namespace that will be our "external" host
sudo ip netns add ns4
sudo ip link add veth4 type veth peer name host-veth4
sudo ip link set veth4 netns ns4
sudo ip addr add 10.99.0.1/24 dev host-veth4
sudo ip link set host-veth4 up

# ns4 side
sudo ip netns exec ns4 ip addr add 10.99.0.2/24 dev veth4
sudo ip netns exec ns4 ip link set veth4 up
sudo ip netns exec ns4 ip link set lo up

# ns4 points at the host as its gateway
sudo ip netns exec ns4 ip route add default via 10.99.0.1
```

Then turn the host into a NAT router. Find the host's real uplink first — I will
assume `eth0`.

```bash
# 1. allow forwarding in the kernel
sudo sysctl -w net.ipv4.ip_forward=1

# 2. rewrite the source of namespace traffic leaving eth0
sudo nft add table ip nat
sudo nft 'add chain ip nat postrouting { type nat hook postrouting priority srcnat; }'
sudo nft add rule ip nat postrouting ip saddr 10.99.0.0/24 oifname "eth0" masquerade
```

If you are on the older tooling, the `iptables` equivalent is one line:

```bash
sudo iptables -t nat -A POSTROUTING -s 10.99.0.0/24 -o eth0 -j MASQUERADE
```

Now `ns4` can ping the internet by IP:

```console
$ sudo ip netns exec ns4 ping -c2 1.1.1.1
64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.4 ms
```

Note `ttl=57`: the packets were routed (one hop off 64 at the host, then the real
internet ate a few). DNS is not configured — that is a separate concern, so
`ping 1.1.1.1` works while `ping example.com` does not until you add a
`/etc/resolv.conf` inside the namespace.

## Verifying with ip route, ping and tcpdump

Three tools prove everything. `ip route` tells you what the stack *thinks*; `ping`
proves the data path; `tcpdump` shows you the packets themselves.

```bash
# what does ns4 believe about the world?
sudo ip netns exec ns4 ip route
# default via 10.99.0.1 dev veth4
# 10.99.0.0/24 dev veth4 proto kernel scope link src 10.99.0.2

# watch the hairpin: packets should arrive un-NATed on veth4,
# then appear NATed going out eth0
sudo ip netns exec ns4 tcpdump -ni veth4 icmp
```

`tcpdump` is where the "aha" lands. Inside `ns4`, look at the source of a packet
to `1.1.1.1`: it is `10.99.0.2`, the private address. On the host, `tcpdump -ni
eth0 icmp` shows the same packet with source `203.0.113.7` — the host's address.
That single pair of captures is the whole of NAT: a per-connection rewrite of the
source, plus the reverse translation on the return path. It is the same mechanism
I unpack in [NAT traversal, explained](/posts/nat-traversal-explained/), only here
you can watch it live.

## What this is actually for

This is not a party trick; it is how you test network code without a lab.

- **Overlay and VPN configs.** You can build a fake WAN of "remote" namespaces on
  one host and test an overlay's route installation, MTU handling, and NAT
  traversal behaviour before you touch real hardware. It is the fastest way to
  sanity-check something like [a private mesh VPN](/posts/private-mesh-with-easytier/)
  in a reproducible sandbox.
- **Reproducing routing bugs.** "It works on my LAN but not over the tunnel" is
  usually an MTU, route, or reverse-path-filtering problem. Namespaces let you
  recreate the exact topology and bisect it in seconds.
- **CI.** Kernel namespaces are root-cheap and fast to create, which is why
  network test suites (and container runtimes, and integration tests for overlays)
  use them. You get isolation between parallel CI jobs for free.
- **Learning.** There is no better way to *see* that a "default gateway" is just a
  route, that a bridge is just a MAC-learning switch, and that NAT is just a
  rewrite rule.

## Pitfalls that will waste your afternoon

- **Loopback starts down.** If `ping 127.0.0.1` fails inside a namespace, you
  forgot `ip link set lo up`. Many daemons die silently without it.
- **Namespaces vanish on reboot.** They are not persistent. Recreate them in
  scripts, or `ip netns` handles stored under `/run` are gone after a reboot. For
  anything repeatable, wrap the setup in a shell script you can rerun.
- **`ip netns exec` vs `ip -n`.** Both work; `ip -n ns1 addr` is shorter but
  cannot run arbitrary commands. Use `ip netns exec` when you need to run non-`ip`
  programs.
- **Forwarding is off by default.** A namespace acting as a router needs
  `net.ipv4.ip_forward=1`. NAT silently does nothing without it.
- **`rp_filter` and asymmetric paths.** With strict reverse-path filtering on,
  packets from a namespace can be dropped because the return route "does not make
  sense." Loosen it (`net.ipv4.conf.*.rp_filter`) when you are deliberately
  building asymmetric topologies.
- **No DNS, no ARP help.** A namespace has no resolver until you write one, and a
  bridge does not route between subnets — it only switches within one.
- **Firewall defaults.** If a namespace cannot reach the host or the internet, check
  `nft list ruleset` in *both* the namespace and the host; a `DROP` policy in
  either is enough to kill it.
- **Cleanup.** `sudo ip netns delete ns1` removes the namespace and its interfaces
  in one shot. Do it — forgetting leaves veth ends piled up in the host.

## The short version

A **network namespace** is a private copy of the Linux network stack, and a
**veth pair** is a cable between two of them. Wire two namespaces and you have two
hosts; put a **bridge** between several and you have a switch; add
`ip_forward` and a **MASQUERADE** rule and the host becomes a router with **NAT**.
Verify with `ip route`, `ping`, and `tcpdump` — those three tell you whether the
stack believes it can route, whether packets actually flow, and what they look
like on the wire. Nothing here needs a hypervisor, a second machine, or a cloud
account: it is one `ip netns` away, and it is the same substrate containers and
overlays are built on.
