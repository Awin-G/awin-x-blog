---
title: "WireGuard from scratch: keys, peers, AllowedIPs, and what it won't do"
description: "A hands-on WireGuard tutorial: generate keys, write a wg-quick config, add peers, read AllowedIPs as cryptographic routing, build a two-host tunnel and a site-to-site route, diagnose with wg, and see exactly what WireGuard leaves to you."
pubDate: 2026-10-18
lang: en
translationKey: wireguard-from-scratch
tags: [networking, self-hosting, security]
featured: false
keywords:
  - WireGuard tutorial
  - WireGuard config
  - AllowedIPs explained
  - wg-quick
  - site-to-site VPN
---

**WireGuard** is the rare piece of infrastructure that does less than you expect and is better for it. There is no handshake daemon, no connection state machine you configure, no "phase 1 / phase 2" to get wrong. It is a small kernel module (or a userspace implementation on your phone and macOS) that speaks UDP, authenticates peers with static keys, and moves packets based on a single decisive field: `AllowedIPs`. This **WireGuard tutorial** walks from a bare machine to a working tunnel and a routed subnet, then spends real time on the part most guides skip — everything WireGuard deliberately refuses to do for you.

If you have ever fought an IPsec config, the whole thing will feel suspiciously small. That is the point.

## The design bet: keys identify peers, AllowedIPs routes

Two ideas carry the entire design:

1. **A peer is identified by its public key**, not by its IP address or a certificate. There is no CA, no chain of trust, no PKI to renew.
2. **`AllowedIPs` does double duty**: it is an *IP routing table* and an *access-control list* in one. A packet is sent to the peer whose `AllowedIPs` covers the destination, and a packet arriving from that peer is only accepted if its source falls inside the same set.

That second point is the one people get wrong for months. Hold it; we will come back to it after you have seen a config.

## Step 1 — Generate keys

You need one keypair per *interface*, not per host. The private key never leaves the machine; the public key is what you hand out. Do not generate keys with a password-protected PEM or a "wg genkey | openssl" chain — WireGuard has its own tooling and you should use it.

```bash
# server
umask 077
wg genkey | tee server.key | wg pubkey > server.pub

# client
umask 077
wg genkey | tee client.key | wg pubkey > client.pub

cat server.pub client.pub
```

A base64 WireGuard key is a raw Curve25519 scalar. There is nothing to renew, no expiry, no revocation list. Rotating a key means generating a new one and updating every peer that references it — which is exactly the gap an overlay network later fills for you.

## Step 2 — Write the two configs

I will use `10.9.0.0/24` as the tunnel network (never collide it with your LAN). The server is `10.9.0.1`, the client `10.9.0.2`. The server's public IP is `203.0.113.10` and it listens on `51820/udp`.

**Server — `/etc/wireguard/wg0.conf`:**

```ini
[Interface]
Address = 10.9.0.1/24
ListenPort = 51820
PrivateKey = <server.key contents>

[Peer]
# laptop
PublicKey = <client.pub contents>
AllowedIPs = 10.9.0.2/32
```

**Client — `/etc/wireguard/wg0.conf`:**

```ini
[Interface]
Address = 10.9.0.2/24
PrivateKey = <client.key contents>

[Peer]
PublicKey = <server.pub contents>
Endpoint = 203.0.113.10:51820
AllowedIPs = 10.9.0.0/24
PersistentKeepalive = 25
```

Note what is *not* here. The server config has no `Endpoint` for the client — the server does not know where the client is and does not care; it replies to whatever source address the last authenticated packet came from. The client has an `Endpoint` because it initiates. That asymmetry is the whole reason a laptop behind a home router can reach a VPS but the VPS cannot reach the laptop until the laptop talks first.

Bring them up:

```bash
sudo wg-quick up wg0
sudo systemctl enable wg-quick@wg0   # survive reboots
```

If you run services without Docker and want the tunnel managed by systemd rather than ad-hoc commands, this is the same unit-file discipline: see [self-hosting without Docker](/posts/self-hosting-without-docker/).

## AllowedIPs, properly: it is cryptographic routing

Now the important part. Read the client's `AllowedIPs = 10.9.0.0/24` as two statements at once:

- **Routing (outbound):** "Anything destined for `10.9.0.0/24`, hand to this peer." `wg-quick` installs this as a kernel route pointing at the `wg0` interface.
- **Crypto-routing (inbound):** "Only accept packets from this peer whose *source* is inside `10.9.0.0/24`." A packet arriving over the tunnel from that peer with any other source is dropped silently — before it ever reaches the routing table.

So `AllowedIPs` is not a firewall rule you pair with a route; it is *the* routing decision fused with authentication. The peer key proves *who* sent the packet, and `AllowedIPs` proves the packet has any business claiming that source address. That is why WireGuard has no concept of "spoofing" to configure — it is structurally prevented.

The consequence that bites people: **the two sides must agree**. If the client says it may send `10.9.0.0/24` but the server's `[Peer]` only allows `10.9.0.2/32`, the client's packets are accepted (source `10.9.0.2` is inside `/32`) but *return* traffic to `10.9.0.2` works while anything else dead-ends. Widen the client's server-side `AllowedIPs` to exactly what that peer is allowed to originate — and no more.

## Diagnostics with `wg` and `wg-quick`

`wg show` is the whole observability story, and it is enough. The **latest handshake** line is the one to check first: if it is blank, no peer has ever completed a handshake, and the problem is reachability or keys, not routing.

```console
$ sudo wg show
interface: wg0
  public key: Kq3f...server
  private key: (hidden)
  listening port: 51820

peer: 8Yc1...client
  endpoint: 198.51.100.22:51934
  allowed ips: 10.9.0.2/32
  latest handshake: 14 seconds ago
  transfer: 1.24 MiB received, 5.87 MiB sent
  persistent keepalive: every 25 seconds
```

Reading it:

- **No handshake at all** → wrong `Endpoint`, wrong port, or a firewall blocking UDP `51820`. `wg-quick` for a client also needs the server's public key to be correct, byte for byte.
- **Handshake was minutes ago and never renewed** → traffic stopped flowing; usually a NAT mapping timed out. This is what `PersistentKeepalive` fixes.
- **Handshake fine, but no ping** → an `AllowedIPs` mismatch or a missing route. Check `ip route get 10.9.0.2` on each side.
- `wg show wg0 dump` gives the same data machine-parseably, if you want to graph handshake age.

`wg-quick` is a shell wrapper: it saves the current config (`wg-quick save wg0`), or you can inspect what it would run with `wg-quick strip wg0`. When something is subtly wrong, `journalctl -u wg-quick@wg0` usually names the failing route or `resolvconf` call.

## Persistent keepalive, in one honest sentence

`PersistentKeepalive = 25` sends an authenticated empty packet every 25 seconds so the NAT on the *client's* side keeps a mapping open and the server can reach back. You need it on the peer that sits behind NAT and wants to be dialed. You do **not** need it on a server with a public IP, and you should not sprinkle it everywhere — it is periodic traffic that keeps radios awake on battery-powered devices.

## Routing a whole subnet — or everything

To make the server a gateway to a LAN behind it, add the remote network to the client's `AllowedIPs` and turn the server into a router.

Client:

```ini
[Peer]
PublicKey = <server.pub>
Endpoint = 203.0.113.10:51820
AllowedIPs = 10.9.0.0/24, 192.168.50.0/24   # the office LAN too
```

Server, to route for that LAN and translate addresses on the way out:

```bash
# server: forward and masquerade tunneled traffic into the LAN
sudo sysctl -w net.ipv4.ip_forward=1
sudo nft add table ip nat
sudo nft 'add chain ip nat postrouting { type nat hook postrouting priority 100; }'
sudo nft add rule ip nat postrouting ip saddr 10.9.0.0/24 oifname "eth0" masquerade

# and allow forwarding for wg0 in your firewall
```

That is a **site-to-site VPN** in miniature: two networks joined through one peer set. Change the client's `AllowedIPs` to `0.0.0.0/0` and you have a full-tunnel VPN — every packet goes through the server. Remember the inbound half of crypto-routing still applies: the server's `[Peer]` for that client must allow whatever source addresses the client will use, and `0.0.0.0/0` on the client means the client now accepts the server's `AllowedIPs` as the route for the entire internet, which will break DNS unless you also push a resolver.

## What WireGuard deliberately does not do

This is the section that saves you weeks. WireGuard is a data-plane protocol, and it gives you four specific non-features:

- **No NAT traversal.** It does not find peers, punch holes, or relay. If both ends are behind symmetric NAT, they simply will not connect until one of them is reachable or you run a relay. The mechanics of why are worth their own read: [NAT traversal, explained](/posts/nat-traversal-explained/).
- **No address assignment.** WireGuard will not hand out `10.9.0.2` to a new client. You type the addresses into every config by hand, and you must guarantee they never collide.
- **No key distribution.** There is no directory. Every peer must be re-deployed whenever any peer's key changes.
- **No user management.** There are no users, only keys. No SSO, no ACLs, no audit log, no "who revoked whom." A key is a peer, permanently, until you remove the `[Peer]` block everywhere.

That is not a bug list; it is a boundary. Everything above the wire — membership, discovery, policy, the settings page — is somebody else's job.

## Overlays and tooling that fill the gaps

When you do not want to hand-write keys and routes for twenty machines, two families of tools close the gap.

**Overlays** (Tailscale, EasyTier, NetBird and friends) keep WireGuard-like crypto but add a control plane: address assignment, NAT traversal with relays, ACLs, and key rotation. You trade a hosted-or-self-hosted coordinator for the operational work. I compare them head to head in the [mesh VPN comparison for 2026](/posts/mesh-vpn-comparison-2026/) — the short version is that the question is who owns the coordination server, not which features are listed.

**Thin tooling** stays in the kernel-WireGuard world and just automates it. `wg-easy` is a web UI that generates keys and configs, hands out QR codes, and writes peers back into a single interface — perfect for a personal hub with a dozen clients. `systemd` (`wg-quick@wg0`) makes the tunnel a first-class service so it starts at boot and restarts on failure. Neither adds NAT traversal or a control plane; they remove toil, not the boundary.

My rule of thumb: **two or three fixed hosts, or a site-to-site link → plain WireGuard.** It is a dozen lines, it never breaks, and you understand all of it. **Laptops that roam, phones, friends, anything that must find each other through NAT → an overlay.** Reach for `wg-easy` when you want extra clients without extra structure. Knowing which side of that line you are on is the whole skill.

## The short version

Generate a keypair per interface, write one `[Interface]` and one `[Peer]` block per side, and let `AllowedIPs` do routing and authentication at once. Add an `Endpoint` only on the side that dials. Use `PersistentKeepalive` only behind NAT. Widen `AllowedIPs` to route a subnet or the world, and narrow it to constrain a peer. Then accept the honest trade: WireGuard moves packets beautifully and coordinates nothing — and everything that coordinates is a second product layered on top.
