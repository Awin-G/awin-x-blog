---
title: "WireGuard Docker: what breaks in a container and how to fix it"
description: "WireGuard in a container looks easy until the kernel module, /dev/net/tun, and NET_ADMIN get in the way. A practical WireGuard Docker guide: host vs container namespaces, NET_ADMIN, wireguard-go, kill switch and routing traps, and secrets kept out of the image."
pubDate: 2026-11-29
lang: en
translationKey: wireguard-in-containers
tags: [networking, self-hosting, nginx]
featured: false
keywords:
  - WireGuard Docker
  - WireGuard container
  - NET_ADMIN
  - /dev/net/tun
  - wireguard-go
---

**WireGuard Docker** looks like a five-line Compose service until it isn't. The interface won't come up, or it comes up and leaks, or it works on your laptop and fails on the VPS. Almost every failure traces back to the same four things: the kernel module, `/dev/net/tun`, the `NET_ADMIN` capability, and the decision of *which network namespace* WireGuard should live in. This is what I learned running a **WireGuard container** on machines I don't fully control — one clean pattern, two acceptable ones, and a set of routing and key traps worth knowing before you copy a config from a forum.

## Why a WireGuard container is fiddly

WireGuard is not a daemon. It is not a process that opens a socket for you. On Linux it is a kernel module that registers a new kind of network interface, and a userspace tool (`wg`) that configures it over netlink. Everything awkward about containerizing it comes from that shape.

- **The interface is a kernel object.** Creating `wg0` is a privileged operation on the *network namespace* you're in. A process needs `CAP_NET_ADMIN` in that namespace, or the netlink call returns `Operation not permitted`.
- **The module must already be loaded.** Here's the good news: WireGuard has shipped in the mainline kernel since 5.6, so on any 2026 host the module is present and containers share the host kernel — you do **not** need to `modprobe` from inside. You only mount `/lib/modules` and grant `SYS_MODULE` if you run a custom or very old kernel. Most guides that tell you to do it are cargo-culting a 2018 problem.
- **`/dev/net/tun` is usually not needed — but often is.** The kernel implementation does **not** use a TUN device; it creates a `wg`-type interface directly. So a pure kernel-WireGuard container can come up without `/dev/net/tun` at all. You need it the moment you use a *userspace* stack (`wireguard-go`, boringtun), or an image that falls back to one. Passing it is cheap; relying on it when you don't have it is not.
- **Host networking vs a namespace is not a detail.** It decides who gets to use the tunnel. Get it wrong and the container has a perfectly healthy tunnel that carries none of the traffic you care about.

<figure>
<svg viewBox="0 0 660 210" width="100%" role="img" aria-label="Two diagrams. Left: WireGuard runs in the host namespace, so host apps reach wg0. Right: WireGuard runs in a container namespace that holds wg0 and the tun device, created with NET_ADMIN, and only the container's apps use it.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="8" y="30" width="300" height="160" rx="10"/>
    <rect x="352" y="30" width="300" height="160" rx="10"/>
    <rect x="28" y="52" width="120" height="40" rx="6"/>
    <rect x="176" y="52" width="110" height="40" rx="6"/>
    <rect x="28" y="128" width="258" height="40" rx="6"/>
    <rect x="372" y="52" width="260" height="70" rx="6"/>
    <rect x="372" y="140" width="120" height="40" rx="6"/>
    <rect x="512" y="140" width="120" height="40" rx="6"/>
    <path d="M148 72 H176"/>
    <path d="M88 128 V92"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12.5">
    <text x="158" y="22" text-anchor="middle" font-weight="600">host namespace</text>
    <text x="502" y="22" text-anchor="middle" font-weight="600">container namespace</text>
    <text x="88"  y="70" text-anchor="middle">host app</text>
    <text x="88"  y="86" text-anchor="middle">+ routing</text>
    <text x="231" y="70" text-anchor="middle">wg0 (kernel)</text>
    <text x="231" y="86" text-anchor="middle">udp 51820</text>
    <text x="157" y="152" text-anchor="middle">physical eth0 → internet</text>
    <text x="502" y="76" text-anchor="middle">wg0 + /dev/net/tun</text>
    <text x="502" y="93" text-anchor="middle">created with NET_ADMIN</text>
    <text x="502" y="110" text-anchor="middle">(veth → host → eth0)</text>
    <text x="432" y="164" text-anchor="middle">container app</text>
    <text x="572" y="164" text-anchor="middle">only it tunnels</text>
  </g>
</svg>
<figcaption>The namespace you put WireGuard in is the namespace whose traffic gets tunneled. Run it on the host and every host process can use it; run it in the container and only the container can.</figcaption>
</figure>

## The options at a glance

There are really only three answers, ranked by how much you're allowed to touch the host:

1. **WireGuard in the host network namespace.** Simplest and most capable, at the cost of container isolation. Use when the whole machine should route through the tunnel.
2. **WireGuard in a container namespace with `NET_ADMIN` + `/dev/net/tun`.** The tunnel is scoped to that container. Use when *one* service should exit through a specific tunnel.
3. **A userspace implementation (`wireguard-go`, boringtun).** Use when you cannot use the kernel module or cannot hold host capabilities.

## Option 1: WireGuard in the host network namespace

If the whole box should use the tunnel, run WireGuard against the host's namespace with `network_mode: host`:

```yaml
services:
  wg:
    image: lscr.io/linuxserver/wireguard:latest
    network_mode: host            # wg0 belongs to the host
    cap_add:
      - NET_ADMIN
    volumes:
      - ./config:/config
    restart: unless-stopped
```

Now `wg0` appears on the host and every host process can use it. But be honest with yourself: at this point the container is buying you almost nothing. You have host networking and host capabilities; the only isolation left is the process's own filesystem. If that's all you wanted, install WireGuard on the host and manage it with a systemd unit — that's the whole argument in [self-hosting without Docker](/posts/self-hosting-without-docker/), and a `wg-quick@wg0.service` is genuinely less to reason about than a Compose file that grants `NET_ADMIN`.

## Option 2: a container with NET_ADMIN and /dev/net/tun

This is the interesting case: one app, one exit. The classic use is a download client or a scraping worker that must egress through a specific VPN, while the rest of the host stays on its normal route.

```yaml
services:
  vpn:
    image: lscr.io/linuxserver/wireguard:latest
    cap_add:
      - NET_ADMIN                 # required: create wg0 in this namespace
    devices:
      - /dev/net/tun:/dev/net/tun # only if a userspace stack is in play
    sysctls:
      - net.ipv4.conf.all.src_valid_mark=1
    ports:
      - "51820:51820/udp"
    volumes:
      - ./config:/config          # keys and wg0.conf live here, not in the image
    restart: unless-stopped

  client:
    image: curlimages/curl:latest
    network_mode: "service:vpn"   # shares the vpn container's namespace
    depends_on:
      - vpn
    command: ["curl", "-s", "https://ifconfig.me"]
```

The second service is the point. `network_mode: "service:vpn"` puts `client` in the *same* network namespace as `vpn`, so it inherits `wg0` and its routes without needing any capability of its own. That is the clean way to say "this process, and only this process, tunnels" — no host-wide default route is touched.

Two notes from running this in practice. First, `net.ipv4.conf.all.src_valid_mark=1` is not decorative: `wg-quick` routes the encapsulated UDP packets using a firewall mark, and without this sysctl the kernel rejects them as martians under a full-tunnel default route. Second, if you can't use `network_mode: service:` (say the client is a long-lived daemon with its own ports), the alternative is a small routing sidecar that shares the namespace the same way.

## Option 3: wireguard-go when you can't touch the host

If the kernel module is unavailable — an old kernel, a locked-down container, macOS in CI — a userspace implementation does the crypto and hands packets to a TUN device. Userspace removes the *kernel-module* dependency; it does not remove the need to create an interface. You still need `NET_ADMIN` and `/dev/net/tun`, unless you give the process its own unprivileged namespace, where it holds `NET_ADMIN` only over itself:

```bash
# userspace, inside a throwaway user+net namespace: no host privileges
unshare --user --map-root-user --net --mount --uts --fork \
  sh -c '
    wireguard-go wg0
    wg set wg0 private-key /config/wg0.key \
       peer <server.pub> \
       endpoint 203.0.113.10:51820 \
       allowed-ips 0.0.0.0/0 \
       persistent-keepalive 25
    ip -6 addr add fd00::2/64 dev wg0 2>/dev/null || true
    ip -4 addr add 10.9.0.2/24 dev wg0
    ip link set wg0 up
    ip route add default dev wg0
    wg show
  '
```

Because the netns is private, the default route you install only affects this process tree. That's a poor-man's sidecar with no image build and no capabilities on the host.

## The kill switch and the routing traps

A tunnel that silently falls back to the clear internet is worse than no tunnel. Three traps cause almost all of it.

**The default route inside the namespace.** `AllowedIPs = 0.0.0.0/0` makes `wg-quick` install a default route *in whatever namespace wg0 lives in*. In Option 2, that's the container's namespace — exactly what you want. If you'd rather wire routes yourself, set `Table = off` in the `[Interface]` block and add routes by hand.

**The kill switch.** `wg-quick`'s routes keep traffic in the tunnel only while the interface is up. If the tunnel drops and the interface is removed, the fallback default route takes over and traffic leaks. A real kill switch is a firewall rule that permits only the tunnel and the WireGuard endpoint, and drops everything else:

```bash
# hard kill switch: no wg0, no internet
nft add table inet wgkill
nft add chain inet wgkill output '{ type filter hook output priority 0; policy drop; }'
nft add rule inet wgkill output oifname "wg0" accept
nft add rule inet wgkill output ip daddr 203.0.113.10 udp dport 51820 accept
nft add rule inet wgkill output oifname "lo" accept
```

With that policy, a dead tunnel means a dead connection, never a silent exit.

**DNS leaks are a test, not a route.** A full tunnel does not magically change which resolver you use — inside a container you may still be pointed at Docker's embedded `127.0.0.11`, or the host's `resolv.conf`. The fix is to set the resolver explicitly, but the discipline is to *verify*, not assume:

```bash
# what route would this packet take?
ip route get 1.1.1.1                 # should say "dev wg0"
# which resolver answered, and from where?
dig +short whoami.akamai.net @$(awk '/nameserver/{print $2; exit}' /etc/resolv.conf)
# what does the world think my IP is?
curl -s https://ifconfig.me; echo
```

Run all three from *inside* the container that shares the namespace, not from the host. If the IP that comes back isn't the VPN's, you have a leak — and now you know which layer dropped it.

## Keys and config without baking them into the image

The most common container mistake is the same one as in any service: secrets in the build. Never `COPY wg0.conf` into an image, and never pass the private key as an `ENV` var — environment variables are visible to anyone who can run `docker inspect`. Instead, generate keys on the host and mount them read-only:

```bash
umask 077
wg genkey | tee ./config/wg0.key | wg pubkey > ./config/wg0.pub
chmod 700 ./config
```

```yaml
services:
  vpn:
    image: lscr.io/linuxserver/wireguard:latest
    cap_add: [NET_ADMIN]
    devices: ["/dev/net/tun:/dev/net/tun"]
    secrets:
      - wg_private_key
    volumes:
      - ./config:/config:rw
    restart: unless-stopped

secrets:
  wg_private_key:
    file: ./config/wg0.key
```

The config volume is the interface: the image stays generic, the machine-specific keys and `wg0.conf` live on disk, and rotating a key is editing one file and reloading — no rebuild. Keep that directory `0700`, version nothing from it in Git, and back it up like any other secret. The same key-rotation discipline applies whether the tunnel is in a container or on the host, and it's spelled out in [WireGuard from scratch](/posts/wireguard-from-scratch/).

## WireGuard Docker vs installing it on the host

Here's my honest rule.

**Install on the host** when there is one tunnel and one machine, and everything on that machine should use it. You get the kernel fast path, `wg-quick@wg0` as a boot-time unit, no capability juggling, and one place — `wg show`, `ip route` — to debug. This is what I do on a VPS. The [self-hosting without Docker](/posts/self-hosting-without-docker/) case applies almost in full.

**Use a WireGuard container** when you need *per-service* exits (three clients, three egress regions), when you want the tunnel and its userspace tooling pinned and reproducible, or when a single `network_mode: service:vpn` sidecar is cleaner than a host firewall dance. The container earns its place through *scoping*, not through security theatre.

What you never get for free either way: NAT traversal, address assignment, or key distribution. A container does not fix WireGuard's boundaries — it just moves where the interface lives. Decide the namespace first, grant only `NET_ADMIN` and `/dev/net/tun` if you actually need them, keep the keys on a mounted volume, and test the leak instead of trusting the config.
