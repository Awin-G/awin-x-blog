---
title: "Building a private mesh VPN with EasyTier across my homelab machines"
description: "I replaced a hub-and-spoke WireGuard setup with an EasyTier mesh VPN: one overlay network name and secret, peers that punch through NAT for direct P2P paths, and a relay only when they can't. A concrete homelab walk-through — install, form the private mesh, verify routes, and expose a service."
pubDate: 2026-10-14
lang: en
translationKey: private-mesh-with-easytier
tags: [networking, self-hosting, homelab, easytier]
featured: false
keywords:
  - EasyTier mesh VPN
  - private mesh network
  - overlay network homelab
  - WireGuard alternative
  - P2P VPN
---

Every machine I actually care about — a dev box, a self-hosted Git forge, the
public box that serves this site — used to hang off a hub-and-spoke VPN: one
always-on endpoint, everything dialing into it, every packet taking a triangle
through a box that might be an ocean away. This post is how I moved to an
overlay network instead. A private **mesh VPN** built with **EasyTier**, where
each node tries to reach every other node directly and only falls back to a relay
when NAT gets in the way. It is the same kind of **overlay network** a homelab
reaches for a WireGuard alternative to get, minus the per-peer keypairs to
babysit.

I am not going to pretend this is exotic. It is the practical version: what the
mesh changes, how EasyTier's model works, and a walk-through you can copy. I will
mark the parts that move between releases, because a lot of them do.

## Mesh VPN vs hub-and-spoke: what the overlay actually changes

A hub-and-spoke VPN (classic WireGuard, a single VPS running as the gateway) has
one property that ruins everything as you add machines: **every path goes through
the hub**. Dev box to Gitea is dev box → hub → Gitea, even if the two are on the
same LAN. That means the hub pays for all bandwidth, becomes a single point of
failure, and sets a latency floor you cannot fix from the client side.

A **P2P VPN** mesh flips the default. Nodes still need to *find* each other — a
rendezvous point still exists — but once they have met, the traffic can take the
direct path. The hub degrades from "carrier of all data" to "matchmaker," and a
relay only appears when a direct path is impossible.

The second difference is smaller but matters daily: a mesh overlay is usually a
**flat L3 subnet**. Each node gets a virtual IP in one range (EasyTier commonly
uses something like `10.144.144.0/24`), and from an application's point of view
it is a normal routable network. `ping tower`, `curl http://10.144.144.3:3000`,
mount an NFS share — no per-service tunnel to configure, no `wg-quick` stanza per
destination.

The hard part is the same one every overlay inherits: **NAT traversal**. Two
nodes both behind NAT cannot simply dial each other. They need STUN-style
discovery to learn their public mappings, then coordinated hole punching to open
a path through both. It works often. It fails when a NAT is symmetric or a
firewall is aggressive, and that failure mode is where relays earn their keep.

## How EasyTier models a network

EasyTier is decentralized — there is no client/server distinction. Any node that
can reach any other node in the network can join, and the rest of the mesh learns
about it. Four concepts cover most of it.

### Identity is a name and a secret

A private network is defined by exactly two strings: the **network name** and the
**network secret**. Two nodes with the same name and secret are in the same
overlay; a wrong secret is rejected outright, not retried forever. That is the
whole membership model — no certificate authority, no per-user accounts. Which is
also the honest downside: the secret *is* the perimeter, so treat it like an SSH
private key, not like a Wi-Fi password you share.

### Peers, relays, and P2P paths

You bootstrap a node by pointing it at one or more **peers** (a public IP, a DNS
name, or a community shared node). Once connected, nodes exchange reachability
information and try to upgrade each connection to a direct P2P link. If hole
punching succeeds, data flows peer-to-peer; if it does not, traffic is **relayed**
through a node that both sides can reach. The relay is ordinary infrastructure,
not magic — it is the same node that did the introduction, and it is exactly the
resource you size for.

### Routing that behaves like OSPF

Rather than a static next-hop, EasyTier nodes exchange routes and each computes a
shortest path over a cost metric. That is the OSPF-like part: add a node, and the
mesh re-converges; a link goes bad, and paths shift; a node in the middle can act
as transit for two others that cannot see each other directly. You rarely need to
think about it, but you *do* get to inspect it — `easytier-cli route` shows the
next hop and cost for each advertised prefix, which is how you prove a path is
actually direct and not quietly relaying.

### Encryption and the trust model

The data plane is encrypted by default with an AEAD cipher (AES-GCM or
ChaCha20-Poly1305, selectable) keyed from the **shared network secret**, so this
is where the WireGuard comparison is fair but imprecise. Like WireGuard it is a
modern encrypted tunnel; unlike WireGuard it is a *network-wide* key derived from
one secret rather than a per-peer public-key exchange. Newer releases add a
Noise-based secure handshake, but the trust anchor never stops being the secret
you distributed. If it leaks, the whole overlay is compromised at once — there is
no per-link revocation.

## Install EasyTier

There are several supported paths; pick one. All of them ship two binaries:
`easytier-core` (the node) and `easytier-cli` (the client that talks to a running
node over RPC, by default on port `15888`).

```bash
# 1. Prebuilt release: download the archive for your OS/arch, unzip, then:
./easytier-core --version

# 2. One-click install script (Linux) — installs to /opt/easytier and
#    registers a systemd service:
wget -O /tmp/easytier.sh \
  "https://raw.githubusercontent.com/EasyTier/EasyTier/main/script/install.sh"
sudo bash /tmp/easytier.sh install

# 3. Docker:
docker run -d --privileged --network host easytier/easytier:latest
```

> Note: install methods, URL paths, and the exact service unit name are
> version-dependent. The commands above are the shapes you will see across v2.x;
> confirm against the project's installation page for the release you are on.

## Form a private mesh network

The shortest version is two nodes on the command line. The first node is your
"anchor" — the one with a stable address the others can dial:

```bash
# On the anchor node (give it a fixed virtual IP):
sudo easytier-core \
  --network-name awin-mesh \
  --network-secret "$(cat ~/.config/et/secret)" \
  --hostname anchor \
  --ipv4 10.144.144.1
```

```bash
# On every other node (DHCP-style virtual IP, dial the anchor):
sudo easytier-core \
  --network-name awin-mesh \
  --network-secret "$(cat ~/.config/et/secret)" \
  --hostname devbox \
  --dhcp \
  --peers udp://anchor.example.com:11010
```

The `--peers` flag accepts a URL, so the transport is explicit: `udp://`,
`tcp://`, `ws://`, `wg://`, `quic://`. UDP is the usual choice because it is the
one that hole-punches most readily. You can list several peers for redundancy,
and it is worth pointing every node at the same list so they agree on the
rendezvous set. Default listener ports are `11010/tcp` and `11010/udp`; the RPC
portal defaults to `15888`.

For anything long-lived I use a config file instead of a growing command line.
Here is the shape (TOML, loaded with `-c`):

```toml
instance_name = "default"
hostname = "devbox"
dhcp = true
listeners = ["tcp://0.0.0.0:11010", "udp://0.0.0.0:11010"]

[network_identity]
network_name = "awin-mesh"
network_secret = "REPLACE_WITH_YOUR_SECRET"

[[peer]]
uri = "udp://anchor.example.com:11010"

[[peer]]
uri = "udp://backup-relay.example.com:11010"
```

```bash
sudo easytier-core -c ./easytier.toml
```

> The config schema and key names change between releases. The layout above is
> representative of v2.x; if a key is rejected, run `easytier-core --help` or use
> the project's online config assistant to generate a file for your version
> rather than guessing.

## Verify connectivity

Do not trust "it started." Ask the node what it knows:

```bash
# Who is in my network, and are they direct or relayed?
easytier-cli peer

# Where does traffic to each prefix actually go, and at what cost?
easytier-cli route

# What does this node think it is (virtual IP, hostname, id)?
easytier-cli node
```

What I look for in `peer` output: two nodes on the same LAN should show a low
`cost` and a `tunnel_proto` of `udp` (direct), not a relay hop. If everything
shows `cost = 2+`, you are probably relaying — check the `next_hop` column in
`route` and fix the transitive hop. And when the peer list is populated but ping
still fails, it is almost always the **host firewall** dropping the inbound
virtual interface, not the overlay.

```bash
ping -c 3 10.144.144.2
```

## Expose a service across the mesh

Once nodes share the flat subnet, the simplest thing is to bind the service and
address it by virtual IP — no port forwarding, no reverse proxy. That is the
whole point of an L3 overlay.

When a service can only bind to localhost, or when the node has no TUN device
(e.g. you started it `--no-tun`), use **port forward** to bridge a local socket
onto the virtual network:

```bash
# Bind 127.0.0.1:8500 locally and forward it to 10.144.144.3:3000 in the mesh:
sudo easytier-core \
  --port-forward tcp://127.0.0.1:8500/10.144.144.3:3000
```

The destination must be a virtual IP that exists in the route table — there is no
fallback to the host network, so a typo becomes a silent no-route rather than a
connection to the wrong machine. On the far side, `curl 127.0.0.1:8500` now
reaches a service on another node.

## When NAT wins: relays, symmetric NAT, and the security model

Let me be blunt about the limits, because the marketing never is.

- **NAT traversal is best-effort, not guaranteed.** UDP hole punching works
  through most home routers. Symmetric NAT (common on some CGNAT and mobile
  networks) is hostile to it. EasyTier throws a birthday-attack technique at
  symmetric NAT too, but it can be rate-limited or blocked by an ISP — so do not
  build a plan that *requires* a direct path. Always have a publicly reachable
  node in the peer list, and accept that some pairs will relay.
- **The relay is the failure path, and it is on the critical path.** If your only
  public node dies, nodes behind NAT lose their rendezvous. Run two, ideally in
  different providers.
- **The secret is the security boundary.** Encryption is on by default, but the
  membership check is the shared secret and the data key derives from it. Rotate
  it by reconfiguring every node at once; there is no partial rotation. If you
  want to run a public-facing node, look at the private-mode and relay-whitelist
  options so your node is not quietly forwarding strangers' traffic.
- **This is not "invisible on the wire."** The overlay hides internals from the
  public internet, but the encrypted transport still egresses from real public
  IPs with real timing. It is a private network, not a mixnet.

None of that is disqualifying. It is just what "P2P with a fallback" honestly
means.

## The smallest node in the mesh

The reason I trust EasyTier's protocol design more than its marketing is that I
took it apart. I reimplemented its wire protocol in plain C and ran a real,
pingable overlay node on an **ESP32-C3**, a microcontroller with 400KB of RAM —
that is [the whole ESPTier field report](/posts/esp32-easytier-node-in-c/). If a
node that small can hold a route table, do the encrypted handshake, and appear in
`easytier-cli peer`, then the "mesh" here is a real protocol and not a wrapper
around three endpoints.

This blog runs on that same overlay: the Git forge is only reachable over the
private mesh, and the public machine that builds these pages pulls from it inside
the trust boundary. That pipeline is [documented in full
here](/posts/how-this-blog-ships-itself/).

## What I would tell you before you start

Pick one public node as an anchor, run a second one somewhere independent, put
the same peer list on every machine, and use a config file rather than a command
line you will forget. Then verify with `easytier-cli peer` and `route` before you
convince yourself the mesh is direct — the first time you see `cost = 1` and
`tunnel_proto = udp` on a pair that used to triangle through a VPS, you will
understand why the mesh is worth the extra NAT-traversal complexity. Keep the
relay as a fallback, keep the secret as a secret, and the overlay will be the
least interesting, most reliable part of your homelab.
