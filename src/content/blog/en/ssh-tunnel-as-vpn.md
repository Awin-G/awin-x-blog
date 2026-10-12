---
title: "SSH tunnels as a poor man's VPN — and when to just use WireGuard"
description: "Local, remote and dynamic SSH port forwarding made concrete, plus ProxyJump for bastions, autossh and a systemd unit for persistence, and the honest point where an ssh tunnel stops being enough and you should run WireGuard or a mesh overlay instead."
pubDate: 2026-11-19
lang: en
translationKey: ssh-tunnel-as-vpn
tags: [networking, linux]
featured: false
keywords:
  - ssh tunnel
  - SOCKS proxy
  - remote port forwarding
  - autossh
  - poor man's VPN
---

I keep a soft rule for infrastructure: reach for the smallest tool that solves the problem in front of me, and only build an overlay when the problem is a *network* rather than a *service*. That rule is why I still type **ssh tunnel** commands most weeks in 2026, long after WireGuard became the obviously correct answer for site-to-site links. SSH is already installed on both ends and already authenticated, so a tunnel is one flag away. Calling it a **poor man's VPN** is not an insult — it is a genuinely good trade for reaching one database on the far side of a jump host, and a bad trade the moment you actually want a subnet. This post is the concrete version: the three forwards, the flags that keep them alive, and the honest line where I stop and run something else.

If you have not yet tamed the client config, my [advanced SSH](/posts/advanced-ssh/) piece covers `~/.ssh/config`, keys and `ssh-agent`; everything here builds on that foundation. And when the answer really is an overlay, my [EasyTier mesh walk-through](/posts/private-mesh-with-easytier/) is the other half of the story.

## Why an ssh tunnel is my first move

SSH gives you three kinds of port forwarding, and they all ride the same encrypted transport you already use for a shell. A **local forward** puts the listening socket on your side; a **remote forward** puts it on the far side; a **dynamic forward** turns the connection into a single-port **SOCKS proxy** that can reach anything the remote can. No new daemon, no new keys, no firewall rule on the far end, no kernel module. That is the entire appeal.

<figure>
<svg viewBox="0 0 660 210" width="100%" role="img" aria-label="The three SSH forwards side by side: local -L listens on your machine and reaches a service from the far side; remote -R listens on the far side and reaches a service on your machine; dynamic -D exposes one SOCKS5 port that can reach any TCP destination the far side can.">
  <defs>
    <marker id="sshf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" fill="none" opacity="0.35">
    <rect x="8" y="18" width="204" height="176" rx="8"/>
    <rect x="228" y="18" width="204" height="176" rx="8"/>
    <rect x="448" y="18" width="204" height="176" rx="8"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13">
    <text x="110" y="40" text-anchor="middle">-L  local</text>
    <text x="330" y="40" text-anchor="middle">-R  remote</text>
    <text x="550" y="40" text-anchor="middle">-D  dynamic</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="22" y="64" width="72" height="34" rx="6"/>
    <rect x="124" y="64" width="76" height="34" rx="6"/>
    <rect x="242" y="64" width="72" height="34" rx="6"/>
    <rect x="344" y="64" width="76" height="34" rx="6"/>
    <rect x="462" y="64" width="72" height="34" rx="6"/>
    <rect x="564" y="64" width="76" height="34" rx="6"/>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" color="currentColor">
    <line x1="94" y1="81" x2="122" y2="81" marker-end="url(#sshf-arrow)"/>
    <line x1="344" y1="81" x2="316" y2="81" marker-end="url(#sshf-arrow)"/>
    <line x1="534" y1="81" x2="562" y2="81" marker-end="url(#sshf-arrow)"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">
    <text x="58" y="86" text-anchor="middle">you:8080</text>
    <text x="162" y="86" text-anchor="middle">svc:5432</text>
    <text x="278" y="86" text-anchor="middle">you:3000</text>
    <text x="382" y="86" text-anchor="middle">vps:8080</text>
    <text x="498" y="86" text-anchor="middle">app:1080</text>
    <text x="602" y="86" text-anchor="middle">any host</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="110" y="126" text-anchor="middle">listen locally,</text>
    <text x="110" y="142" text-anchor="middle">connect from the far side</text>
    <text x="330" y="126" text-anchor="middle">listen on the far side,</text>
    <text x="330" y="142" text-anchor="middle">connect from here</text>
    <text x="550" y="126" text-anchor="middle">SOCKS5 on one port,</text>
    <text x="550" y="142" text-anchor="middle">any TCP destination</text>
    <text x="330" y="180" text-anchor="middle" opacity="0.9">one encrypted SSH transport carries all three</text>
  </g>
</svg>
<figcaption>The three forwards differ only in which side owns the listening socket. `-L` and `-R` are point-to-point; `-D` is a SOCKS5 proxy you can point any TCP client at.</figcaption>
</figure>

## Local port forwarding with `-L`: reach a remote service through a jump host

A local forward opens a socket on *your* machine and tunnels every connection to a destination reachable from *the remote* side. This is the tool for a service that only listens on loopback, or that only exists inside a private network.

```bash
# Syntax: -L [bind:]local_port:dest_host:dest_port
ssh -N -L 5432:db.internal:5432 jump
# in another terminal the database now looks local:
psql -h 127.0.0.1 -p 5432 -U app appdb
```

The destination `db.internal:5432` is resolved from the **jump host's** point of view, not yours. That is the whole trick: the name can be a private DNS record you cannot see, and the far side connects on your behalf. By default the listener binds to `127.0.0.1`; do not write `-L 0.0.0.0:5432:...` unless you genuinely mean to expose that port to your entire LAN. `-N` says "do not run a shell, just forward" — it stops SSH from allocating a pty and spawning a login.

## Remote port forwarding with `-R`: expose a local service

**Remote port forwarding** is the mirror image: the listener lives on *the remote*, and connections to it come back down the tunnel to *your* machine. That is how you show a local dev server to someone, or reach a box behind NAT where only outbound connections ever work.

```bash
# Syntax: -R [remote_bind:]remote_port:dest_host:dest_port
ssh -N -R 8080:localhost:3000 vps
# now, on the server 'vps':
curl http://127.0.0.1:8080   # served by your laptop's :3000
```

The `dest_host` here is resolved from *your* side, which is why `localhost:3000` reaches your laptop. By default the remote listener is loopback-only — the safe default. To bind it wider you need `GatewayPorts clientspecified` in the *server's* `sshd_config` plus an explicit bind address. Think hard before you do that: you are poking a hole through the far end's firewall straight into your machine.

## Dynamic forwarding with `-D`: a SOCKS proxy for a browser or app

The first two forwards are point-to-point; you decide the destination up front. The third one does not. Dynamic forwarding turns SSH into a **SOCKS proxy**: you point a client at one local port and it can reach *any* host the remote can reach, chosen at connect time.

```bash
ssh -N -D 1080 jump
# every request through this proxy exits from the far side's network
curl --socks5-hostname 127.0.0.1:1080 https://internal.example.com/
```

`--socks5-hostname` matters: it asks the proxy to resolve DNS on the remote side too, so internal names never leak to your local resolver and split-horizon DNS keeps working. Any browser can point its SOCKS5 host at `127.0.0.1:1080` for the same effect. This is the fastest way to reach an entire subnet behind a jump host without forwarding each service by hand — and the closest SSH gets to a VPN.

## ProxyJump: the bastion, without the ceremony

The chain I use most is a private host reachable only through a public bastion. **ProxyJump** opens a TCP connection through the bastion and then negotiates the SSH session end-to-end to the target, so your private key never leaves your laptop.

```bash
ssh -J jump@bastion.example.com deploy@10.0.0.5
# chain several hops, comma-separated, for nested networks
ssh -J jump@bastion.example.com,jump2@inner deploy@10.0.1.20
```

Prefer this over the old `ssh -A bastion` then `ssh db` pattern: no agent forwarding (a compromised bastion cannot borrow your keys), and the session is encrypted to the target rather than trusted to the bastion's shell. It is also the modern replacement for a `ProxyCommand nc %h %p` line — it handles IPv6, multiple hops and retries for you.

## Keeping an ssh tunnel alive: `-N`, `-f`, `ServerAliveInterval` and autossh

A tunnel that dies silently at 3 a.m. is worse than no tunnel, because something upstream is still trying to use it. Three flags turn a one-off command into something dependable:

- **`-N`** — no remote command, forward only.
- **`-f`** — authenticate, then drop into the background so your terminal stays yours.
- **`ServerAliveInterval 30`** with **`ServerAliveCountMax 3`** — a keepalive every 30 seconds keeps idle NAT and firewall mappings open, and kills the session within ~90 seconds once the link is genuinely gone.

One more flag earns its keep and almost nobody uses it: **`ExitOnForwardFailure yes`**. Without it, if the far-side port is already taken, SSH happily stays connected and forwards nothing — a silent failure you debug for an hour. With it, SSH exits so your supervisor can retry.

```bash
ssh -fN \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -L 5432:db.internal:5432 jump
```

For flaky links, **autossh** wraps SSH and restarts it when the connection drops. The modern invocation disables autossh's own echo-port monitoring (`-M 0`) and leans on the SSH keepalives instead, which is both simpler and more reliable:

```bash
autossh -M 0 -fN \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -L 5432:db.internal:5432 jump
```

## A persistent ssh tunnel as a systemd unit

On any systemd host I skip `autossh` entirely: systemd is already the supervisor, and mixing two restart mechanisms just means two places to look when it breaks. A unit gives you start-at-boot, restart-on-failure, and `journalctl` for free.

```ini
# /etc/systemd/system/ssh-tunnel-db.service
[Unit]
Description=Persistent SSH tunnel to db.internal:5432
After=network-online.target
Wants=network-online.target

[Service]
User=deepseek
ExecStart=/usr/bin/ssh -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -i /home/deepseek/.ssh/id_ed25519 \
  -L 5432:db.internal:5432 jump
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ssh-tunnel-db
systemctl status ssh-tunnel-db      # and: journalctl -u ssh-tunnel-db -f
```

Two details that bite: a system service does not inherit your shell's `ssh-agent`, so point `-i` at a real key file and make sure the key is readable by `User=`; and quote every option you pass as `-o` so the unit parser does not split on spaces. For a per-user tunnel, put the same file in `~/.config/systemd/user/` and use `systemctl --user enable --now`.

## What an ssh tunnel does not give you

This is the section that saves you a week, because SSH tunnels look like a VPN right up until they do not:

- **No L3 interface.** There is no `tun0`, no routing table, no address you can `ping`. You forward ports; you do not join a network.
- **No UDP, no ICMP.** Forwarding carries TCP (plus a little X11 and agent plumbing). Game traffic, QUIC, DNS-over-UDP, WireGuard itself — none of it goes through a plain SSH forward.
- **One protocol per forward.** `-L` and `-R` are one port pair each; `-D` is TCP-only SOCKS5, and plenty of apps ignore SOCKS or refuse to use it for some traffic. "Multiple protocols seamlessly" is not on the menu.
- **No roaming.** When your laptop changes IP, the TCP connection under the tunnel dies and you reconnect. WireGuard peers re-learn each other from any authenticated packet; SSH cannot.
- **Performance is mediocre and collapse-prone.** Everything rides one TCP connection, so you get TCP-over-TCP meltdown under packet loss, one flow's head-of-line blocking, and no kernel fast path. Fine for a database session; unpleasant for bulk transfer.

## ssh tunnel vs WireGuard and EasyTier

WireGuard is the honest opposite: a real L3 interface in the kernel. Point `AllowedIPs` at a subnet and you get routing, any protocol, ICMP, roaming, and near-line-rate throughput. The price is setup — keys, configs per interface, a route or two, root on both ends — and the fact that WireGuard deliberately does nothing to *find* peers, so NAT traversal is on you. An overlay like [EasyTier](/posts/private-mesh-with-easytier/) closes that last gap: it keeps the WireGuard-like data plane but adds rendezvous, hole punching and relays, so laptops and phones find each other without hand-written endpoints.

So the trade is not "secure vs insecure" — SSH is encrypted end-to-end too. It is **one service vs a network**: SSH tunnels cost nothing to start and scale to exactly one port pair at a time; an overlay costs an afternoon to set up and then behaves like a LAN forever.

## The honest recommendation

Reach for an **ssh tunnel** when you already have SSH access to a hop that can see the thing you want, you need exactly that thing, and you need it now — one database, one internal dashboard, one dev server to show a colleague, one browser session through a SOCKS proxy. It is one command, it leaves no footprint, and `-J` plus a systemd unit makes it boring enough to keep.

Reach for **WireGuard or a mesh overlay** the moment any of these is true: you want more than a handful of services, you need UDP or arbitrary protocols, you need the thing to survive a laptop changing networks, or you care about throughput. Two or three fixed hosts and a subnet → plain WireGuard. Roaming laptops, phones, machines behind NAT → an overlay like EasyTier.

The shortest version I can give: **SSH for a service, an overlay for a network.** A poor man's VPN is a great deal — right up until you notice you are trying to build a network out of port forwards.
