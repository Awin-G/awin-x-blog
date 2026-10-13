---
title: "systemd-resolved in practice: the stub resolver you forgot you have"
description: "systemd-resolved is the local caching stub resolver on 127.0.0.53 that most systems already run — and quietly bypass. A hands-on tour of resolvectl, the cache, split DNS, DNS over TLS and mDNS, with real output from an Arch box."
pubDate: 2027-01-15
lang: en
translationKey: systemd-resolved
tags: [networking, systemd]
featured: false
keywords:
  - systemd-resolved
  - resolvectl
  - stub resolver
  - DNS over TLS
  - split DNS
---

There is a caching DNS resolver, a DoT client, a split-DNS engine and an mDNS
responder already running on your machine, started at boot, and you almost
certainly did not install it. It is **`systemd-resolved`** — the local **stub resolver**
that has shipped with systemd for a decade — and it is managed through one
command you have probably never typed: **`resolvectl`**.

Here is the twist I hit on my own Arch box, which is the whole reason I wrote
this. `systemd-resolved` is running *and listening on `127.0.0.53`*, but my apps
never touch it. Everything below is real output from that machine, trimmed only
where a dozen Docker bridge links would be noise. Nothing is fabricated, and I
flag every command that needed root — which, on this systemd 262 box, turns out
to be more than I expected. If you want the sent-down recursion story first, my
[How DNS actually resolves, step by step](/posts/how-dns-resolves/) is the
companion piece; this one is entirely about the local half.

<figure>
<svg viewBox="0 0 640 180" width="100%" role="img" aria-label="An app sends a query to the systemd-resolved stub on 127.0.0.53; a hit is served from cache, a miss is forwarded to the per-interface upstream over DNS over TLS" xmlns="http://www.w3.org/2000/svg" style="max-width:640px">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="currentColor"/>
    </marker>
  </defs>
  <rect x="12" y="60" width="110" height="56" rx="10" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="67" y="93" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" fill="currentColor">app</text>
  <line x1="122" y1="88" x2="208" y2="88" stroke="currentColor" stroke-width="2" marker-end="url(#arrow)"/>
  <text x="165" y="78" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="currentColor">query</text>
  <rect x="212" y="46" width="180" height="84" rx="12" fill="none" stroke="#0f766e" stroke-width="2"/>
  <text x="302" y="76" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" fill="currentColor">systemd-resolved</text>
  <text x="302" y="95" text-anchor="middle" font-family="monospace" font-size="13" fill="currentColor">127.0.0.53:53</text>
  <rect x="238" y="104" width="128" height="18" rx="9" fill="#0f766e"/>
  <text x="302" y="117" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#ffffff">cache hit?</text>
  <text x="302" y="38" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#0f766e">stub listener + cache</text>
  <line x1="392" y1="88" x2="478" y2="88" stroke="currentColor" stroke-width="2" marker-end="url(#arrow)"/>
  <text x="435" y="78" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="currentColor">miss</text>
  <rect x="482" y="56" width="146" height="64" rx="10" fill="none" stroke="#0f766e" stroke-width="2"/>
  <text x="555" y="82" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="currentColor">upstream</text>
  <text x="555" y="102" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#0f766e">DoT :853</text>
</svg>
<figcaption>Your app talks to the local <strong>systemd-resolved</strong> stub on <code>127.0.0.53</code>. A hit is served from cache; a miss is forwarded to the per-interface upstream — ideally over DNS over TLS. If nothing points at the stub, the cache is just dead weight.</figcaption>
</figure>

## What systemd-resolved actually is (and why it is already running)

Conceptually `systemd-resolved` is four things bolted together:

- A **caching stub resolver** on `127.0.0.53` (plus `127.0.0.54` for LLMNR). Every
  process that resolves through libc can point at it and share one cache.
- A **per-link DNS broker**. It does not keep "the DNS server"; it keeps a DNS
  server *per network interface* and decides, per name, which one to ask. That is
  split DNS, and it is the part people miss.
- A **crypto-aware forwarder**. It can send upstream queries over **DNS over TLS**
  (`DNSOverTLS=`) and try to validate DNSSEC, so a hostile LAN cannot trivially
  read or forge your answers.
- A **link-local name engine** for `LLMNR` and mDNS (`.local`), which is how your
  box finds `printer.local` or a Windows neighbour without a server.

It is not magic and it is not a recursive resolver in the "walk the root servers
myself" sense — it forwards to configured upstreams and caches the answers. I
come back to that distinction at the end, because it decides whether you keep it.

`resolvectl` is the whole control panel. `resolvectl --version` on my box:

```bash
$ resolvectl --version
systemd 262 (262-1-arch)
+PAM +AUDIT -SELINUX ... +GNUTLS +OPENSSL ...
```

and the service is healthy and socket-activated:

```bash
$ systemctl status systemd-resolved
● systemd-resolved.service - Network Name Resolution
     Loaded: loaded (/usr/lib/systemd/system/systemd-resolved.service; enabled; preset: enabled)
     Active: active (running) since Mon 2026-10-12 04:12:29 CST; 1 day 3h ago
   TriggeredBy: ● systemd-resolved-monitor.socket
               ● systemd-resolved-varlink.socket
   Main PID: 360 (systemd-resolve)
     Status: "Processing requests..."
```

Those two triggered sockets matter later — they are *why* one of the commands
below fails without root.

## systemd-resolved vs nss-dns, dnsmasq, and Unbound

People mix these up constantly. They are not the same layer:

| Solver | What it is | Caching | Per-interface | DoT/DoH | LLMNR/mDNS |
|---|---|---|---|---|---|
| glibc `nss-dns` | libc reads `/etc/resolv.conf`, sends plaintext | no | no | no | no |
| `dnsmasq` | separate daemon, forwarder + cache + DHCP | yes | partial | forwarding only | (via avahi) |
| `systemd-resolved` | the systemd resolver | yes | yes (native) | client, optional | built-in |
| `Unbound` | full recursive + validating resolver | yes | you wire it | to upstream | no |

The honest summary: if all you ever wanted was "read `/etc/resolv.conf` and
resolve," `nss-dns` still does that fine, and `resolvectl` adds nothing. If you
wanted a daemon with a cache and DHCP for a LAN, `dnsmasq` is the classic. If you
have `systemd` (you do) and multiple interfaces, a VPN, or want zero extra
packages, `systemd-resolved` is already solving it. Which brings us to the part
that trips everyone: the file that points apps at it.

## The 127.0.0.53 stub and the /etc/resolv.conf symlink

The way apps reach the stub is `/etc/resolv.conf`, and the way it *should* be
wired on a systemd box is as a symlink into `/run`:

```bash
# When systemd-resolved owns /etc/resolv.conf (mode: stub) this file is a
# symlink into /run/systemd/resolve/. These are the REAL files on this box:
$ ls -l /run/systemd/resolve/
-rw-r--r-- 1 systemd-resolve systemd-resolve 920 ... stub-resolv.conf   # the stub
-rw-r--r-- 1 systemd-resolve systemd-resolve 808 ... resolv.conf        # the uplinks

$ cat /run/systemd/resolve/stub-resolv.conf
nameserver 127.0.0.53
options edns0 trust-ad
search .
```

Two different files, and which one `/etc/resolv.conf` points at decides
everything:

- `stub-resolv.conf` has `nameserver 127.0.0.53` — apps hit the cache. **Use this.**
- `resolv.conf` lists the *actual uplinks* — apps bypass the cache and talk
  straight to `223.5.5.5`. This is the "give up, just use the upstreams" escape
  hatch. On a distro that wires things up you do
  `ln -sf ../run/systemd/resolve/stub-resolv.conf /etc/resolv.conf`.

Now the part I actually live with. On my box *neither* is symlinked. NetworkManager
writes its own file, so the stub is running but orphaned:

```bash
$ ls -l /etc/resolv.conf
-rw-r--r-- 1 root root 75 10月12日 16:50 /etc/resolv.conf       # a real file, not a symlink
$ cat /etc/resolv.conf
# Generated by NetworkManager
nameserver 223.5.5.5
nameserver 119.29.29.29

$ ss -tuln | grep 53
udp   UNCONN 0  0 127.0.0.54:53        0.0.0.0:*   # LLMNR stub
udp   UNCONN 0  0 127.0.0.53%lo:53     0.0.0.0:*   # DNS stub, LISTENING
tcp   LISTEN 0  0 127.0.0.53%lo:53     0.0.0.0:*
tcp   LISTEN 0  0 127.0.0.54:53        0.0.0.0:*
```

So the stub on `127.0.0.53` is up and healthy, and my default resolver is
`223.5.5.5`. `resolvectl status` prints the diagnosis in one word — **`resolv.conf
mode: foreign`**:

```bash
$ resolvectl status
Global
           Protocols: +LLMNR +mDNS -DNSOverTLS DNSSEC=no/unsupported
    resolv.conf mode: foreign
  Current DNS Server: 223.5.5.5
         DNS Servers: 223.5.5.5 119.29.29.29
Fallback DNS Servers: 9.9.9.9#dns.quad9.net 2620:fe::9#dns.quad9.net
                      1.1.1.1#cloudflare-dns.com ...

Link 3 (tun0)                                          # the VPN
    Current Scopes: DNS
         Protocols: -DefaultRoute +LLMNR +mDNS -DNSOverTLS DNSSEC=no/unsupported
Current DNS Server: 100.100.100.101
        DNS Domain: ~internal
     Default Route: no

Link 2 (wlp2s0)                                        # Wi-Fi, the default route
    Current Scopes: DNS LLMNR/IPv4 LLMNR/IPv6 mDNS/IPv4 mDNS/IPv6
         Protocols: +DefaultRoute +LLMNR +mDNS -DNSOverTLS DNSSEC=no/unsupported
Current DNS Server: 223.5.5.5
       DNS Servers: 223.5.5.5 119.29.29.29
     Default Route: yes
```

That is the entire thesis in one screen. `systemd-resolved` is running, the
cache exists, but `foreign` mode means most apps never see it — they read the
NetworkManager file and go straight to AliDNS. `resolvectl` and anything that
explicitly targets the stub *do* use the cache. That is "the stub resolver you
forgot you have," and the first fix on a box like this is to hand
`/etc/resolv.conf` back to the stub.

## Caching, resolvectl statistics, and why mine returns 权限不够

The cache is the payoff: repeated queries for a hot name are answered from RAM
in microseconds, and every process shares it. You inspect it and flush it with:

```bash
$ resolvectl statistics        # current cache size, hits/misses
$ resolvectl flush-caches      # drop everything
```

Except on my box, neither runs as a normal user:

```bash
$ resolvectl statistics
Failed to issue io.systemd.Resolve.Monitor.DumpStatistics() varlink call: 权限不够
$ resolvectl flush-caches
Failed to issue io.systemd.Resolve.Monitor.FlushCaches() varlink call: 权限不够
```

This is a genuine systemd-262 change I want on the record: cache statistics and
flushing moved off the old D-Bus method (`DumpStatistics` is gone — calling it
directly answers `Unknown method`) onto the privileged `io.systemd.Resolve.Monitor`
varlink socket, which rejects unprivileged callers with `权限不够` ("permission
denied"). So on this host, **`resolvectl statistics` and `flush-caches` both need
root**, while the read-only queries in the next sections do not. I have no sudo
here, so the honest answer is: I can't show you live hit/miss counters from an
unprivileged shell on `262`. On older systemd (≤ 252) they used to come back as a
table of `Current Cache Size` / `Cache Hits` / `Cache Misses` with no such
demotion.

## Per-link DNS and split DNS (`resolvectl domain`)

This is the feature that makes resolved worth keeping when you have more than one
network. It routes each *name* to the right link. Read the domains with
`resolvectl domain`:

```bash
$ resolvectl domain
Global:
Link 3 (tun0): ~internal
Link 60 (br-c9b53f86be7f):
...
Link 2 (wlp2s0):
```

`~internal` on `tun0` is a **routing domain**. The leading `~` means "send names
under `internal` to *this* link's resolver, but do not append it as a search
suffix." Combined with `Default Route: no` on the VPN and `yes` on Wi-Fi, the
policy is exactly a split-horizon: `db.internal` goes to the tunnel's resolver
(`100.100.100.101`, fed by the Easytier daemon running `tun0=10.126.126.3/24`),
and everything else uses Wi-Fi's `223.5.5.5`. If you *want* a VPN to steal all
DNS, that link needs `Default Route: yes`, which you set with `resolvectl
default-route tun0 yes` (needs root) — the "upstream `~.`" sentinel domain does
the same thing as a routing entry.

To show the mechanic in a controlled way I stood up a throwaway resolver on a
private Docker network — no image pull needed, `coredns/coredns` was already
local. It serves only an internal zone:

```bash
# Corefile served by the container (trimmed):
lab.internal.:53 {
    hosts { 10.99.0.42 api.lab.internal
            10.99.0.43 db.lab.internal
            fallthrough }
    whoami
    log
}
docker run -d --name corednsdemo --net dnsdemo -p 1053:53/udp -p 1053:53/tcp \
  coredns/coredns -conf /etc/coredns/Corefile

# From a second container on the same network:
$ nslookup api.lab.internal corednsdemo
Name:   api.lab.internal
Address: 10.99.0.42

$ nslookup example.com corednsdemo
** server can't find example.com: REFUSED
```

`*.lab.internal` resolves to the planted address; a public name is `REFUSED`.
That is precisely what a per-link resolver does: it authoritatively answers *its*
suffix and refuses the rest, which is why split DNS routes by suffix instead of
by "the DNS server." I confirmed it off-network too, straight from the host on the
published port:

```
QUERY api.lab.internal -> 127.0.0.1:1053  answers=1  A=['10.99.0.42']
QUERY db.lab.internal  -> 127.0.0.1:1053  answers=1  A=['10.99.0.43']
```

## DNS over TLS (DNSOverTLS) and DNSSEC

The status screen showed `-DNSOverTLS DNSSEC=no/unsupported` — DoT off and, in this
config, DNSSEC unsupported. You flip DoT with a drop-in (`DNSOverTLS=yes` for
must-use, `opportunistic` to try), then point a link's `DNS=` at a DoT-capable
server such as `1.1.1.1#cloudflare-dns.com`. Enabling and reloading need root
(edit the drop-in, `systemctl restart systemd-resolved`), so I verified the
*transport* without privileges the way you can too — a bare TLS handshake to
Cloudflare's resolver port:

```bash
$ openssl s_client -connect 1.1.1.1:853
subject=CN=cloudflare-dns.com
issuer=CN=SSL.com SSL Intermediate CA ECC R2
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Verify return code: 0 (ok)
```

`CN=cloudflare-dns.com` with `Verify return code: 0 (ok)` is the proof that the
resolver speaks DoT and presents a chain that validates to the auth-name you
would configure — no `TCP/853` sniffer, no root. Once resolved itself is on DoT,
`resolvectl query` tells you per answer; note my plaintext result carries the flag
`acquired via local or encrypted transport: no`:

```bash
$ resolvectl query blog.awin-x.top
blog.awin-x.top: 88.218.79.95                               -- link: wlp2s0
-- Information acquired via protocol DNS in 55.4ms.
-- Data is authenticated: no; Data was acquired via local or encrypted transport: no
-- Data from: network
```

That last line doubles as the DNSSEC readout: `authenticated: no` today, and it
would flip to `yes` with a validating upstream and `DNSSEC=yes`. (Note the same
line is *not* your certificate check — trust the `openssl` handshake for that.)
For a private domain you would not publish, DNSSEC is overkill; for a public one,
pick an upstream that validates and let resolved trust the `AD` bit, which is what
`options trust-ad` in the stub file is for.

## The three confusions that keep biting

**Editing `/etc/resolv.conf` gets overwritten.** It says `# Generated by
NetworkManager`. Anything you type there is regenerated on the next reconnect.
Configure the thing that owns it — NetworkManager, or `systemd-resolved` via
`resolvectl` and a `resolved.conf.d/` drop-in — never the file. (My global
`DNS=223.5.5.5 119.29.29.29`, for example, comes from
`/etc/systemd/resolved.conf.d/99-easytier-dns.conf`, not from me editing
resolv.conf.)

**VPN DNS "not applying."** A VPN coming up does not mean its resolver wins. My
`tun0` has `Default Route: no`, so general lookups still go to Wi-Fi. Only names
under `~internal` use the tunnel. If you want the VPN to catch everything, mark it
default-route (root) — otherwise this is correct split-DNS behaviour, not a bug.

**`.local` collisions.** `*.local` is reserved for mDNS/LLMNR, so *decide* it is a
local link name and never forward it to unicast. Consequence: a real DNS zone
ending in `.local` will never resolve, and a multi-homed `.local` name can
flicker between hosts. My query shows the failure is also just "nobody answered":

```bash
$ resolvectl query foo.local
foo.local: resolve call failed: All attempts to contact name servers or networks failed
```

No responder on the link, and no unicast fallback — by design.

## When to replace systemd-resolved with Unbound or dnsmasq

Keep resolved when: it is already running, you want per-link split DNS, you use a
VPN, and caching + optional DoT is all you need. Do not fight it.

Reach for something else when your needs outgrow a forwarder. The clear line:
resolved *forwards and caches*; **Unbound** *recurses and validates* end to end
with qname minimisation, and **dnsmasq** is still the small-box champion when you
want cache + DHCP + ad-blocking upstreams in one binary. If you specifically want
a resolver that walks the root servers itself, does DNSSEC validation locally, or
serves a whole LAN, you have outgrown a stub — that is the topic of my
[Running your own recursive DNS resolver](/posts/self-hosted-dns-resolver/) post.
On this box, with a VPN doing split DNS, resolved already earns its keep; the only
change I would make is repoint `/etc/resolv.conf` at `127.0.0.53` so the cache I
never disabled finally gets used.
