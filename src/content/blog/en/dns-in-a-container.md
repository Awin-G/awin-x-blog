---
title: "Run a container DNS server: a CoreDNS lab you poke with dig"
description: "Stand up a container DNS server in minutes: a minimal CoreDNS Corefile serving a custom authoritative zone from a zone file, forwarding unknown names upstream, and every answer poked with dig @127.0.0.1 -p 15353 — including real NXDOMAIN, SERVFAIL, CNAME-chain and TTL output."
pubDate: 2026-12-08
lang: en
translationKey: dns-in-a-container
tags: [networking, self-hosting, linux]
featured: false
keywords:
  - container DNS server
  - CoreDNS
  - dnsmasq
  - dig
  - authoritative DNS
---

The fastest way I know to actually *understand* DNS is to run one and break it on
purpose. Not a resolver you point your laptop at and forget — a throwaway
**container DNS server** you can interrogate with `dig`, watch return NXDOMAIN,
and then feed a dead upstream so it fails with SERVFAIL. CoreDNS makes this a
two-file exercise: a `Corefile` and a zone file. In this post I build a minimal
setup that is **authoritative DNS** for `lab.example`, forwards everything else
upstream, and binds to a non-privileged port so nothing fights over port 53. Then
we poke it and read the answers.

Every command and answer below is real output from a CoreDNS 1.14.7 container and
dig 9.18.50.

## Why run a container DNS server at all

A local DNS server is not just a lab toy. The same shape solves real problems:

- **A lab** — give test machines real names (`api.lab.example`) that resolve the
  way production does, without touching `/etc/hosts` on every box.
- **Split-horizon** — answer `app.example.com` with the internal IP on the LAN
  and the public IP outside it, from one zone file.
- **Blocking and filtering** — blackhole ad and telemetry names at the resolver,
  which is what Pi-hole and AdGuard Home do under the hood.
- **Testing DNS changes** — authoritative-only answers, custom TTLs and deliberate
  NXDOMAIN are things you cannot easily get from a public resolver.

The trade-off is that you now own a service that, if exposed, is a reflection
amplifier. Run it bound to `127.0.0.1` while you learn, exactly as we do here.
(For the production version of a resolver, and when *not* to self-host one, see
[my notes on running your own recursive resolver](/posts/self-hosted-dns-resolver/).)

## CoreDNS vs dnsmasq vs BIND at a glance

All three can serve a zone. They are aimed at different jobs, and picking wrong
is why people fight their DNS setup.

| | CoreDNS | dnsmasq | BIND 9 |
|---|---|---|---|
| Written in | Go | C | C |
| Config style | `Corefile` (plugin chain) | one-line options | `named.conf` + zone files |
| Best at | service discovery, forwarding, small authoritative zones | LAN caching/forwarding, DHCP, wildcards | full-featured authoritative/recursive DNS |
| Zone file support | yes (via `file` plugin) | `addn-hosts` / `host-record`, no full zone files | yes, the reference implementation |
| Reload | rewrite `Corefile` or `coredns -reload` | restart | `rndc reload` |
| Feels like | a small web server | a router's DNS | a database engine |

If you want a DNS server because you want *DHCP plus easy host entries*, reach
for dnsmasq. If you need delegated zones, DNSSEC signing and secondary servers,
BIND is still the standard. For forwarding plus a couple of hand-written
authoritative zones in a container, CoreDNS has the least ceremony — which is
why it is what I use here.

## A minimal Corefile with an authoritative zone

CoreDNS is configured by a `Corefile`: a list of `zone:port { plugins }` blocks.
The important detail is that CoreDNS picks the **most specific** zone for a query,
so a zone block is authoritative for its names and a catch-all block forwards the
rest.

```text
# Corefile
lab.example:53 {
    file /etc/coredns/db.lab.example   # authoritative answers from a zone file
    log
    errors
}

servfail.lab:53 {
    forward . 192.0.2.1                 # a deliberately dead upstream
    errors
}

.:53 {
    forward . 1.1.1.1 8.8.8.8 {
        max_concurrent 1000
    }
    cache 30
    log
    errors
}
```

Three blocks, three roles: `lab.example` is served locally and authoritatively;
`servfail.lab` exists only so I can watch SERVFAIL appear; everything else is
forwarded to `1.1.1.1` and `8.8.8.8` with a 30-second cache. The `log` plugin
prints every query, which becomes our debugging window later.

## Serving a custom zone from a zone file

The `file` plugin reads an ordinary RFC 1035 zone file. A SOA and an NS record
are mandatory; after that I add two A records, a two-hop CNAME chain and a TXT
record, so there is something interesting to query.

```text
; db.lab.example
$ORIGIN lab.example.
$TTL 3600

@       IN  SOA ns1.lab.example. admin.lab.example. (
                2026120801 ; serial
                7200       ; refresh
                3600       ; retry
                1209600    ; expire
                60 )       ; minimum  (negative-cache TTL)

@       IN  NS      ns1.lab.example.
ns1     IN  A       10.10.0.53
api     IN  A       10.10.0.5
db      IN  A       10.10.0.6
short   IN  A       10.10.0.99
web     IN  CNAME   api.lab.example.
www     IN  CNAME   web.lab.example.
info    IN  TXT     "lab zone served by CoreDNS"
```

Two things worth noting before running it. `www` is a CNAME to `web`, which is a
CNAME to `api` — a legitimate chain that a resolver has to follow to the final A
record. And the last number in the SOA is the **minimum** field: the negative TTL
that tells caches how long to remember an NXDOMAIN for this zone.

## Running CoreDNS in Docker on a non-privileged port

Privileged port 53 needs root, which we do not want. Map a high host port to the
container's 53, and bind it to loopback so it is not on the network.

```bash
docker run -d --name coredns-lab \
  -p 127.0.0.1:15353:53/udp \
  -p 127.0.0.1:15353:53/tcp \
  -v "$PWD/Corefile:/etc/coredns/Corefile:ro" \
  -v "$PWD/db.lab.example:/etc/coredns/db.lab.example:ro" \
  coredns/coredns:latest -conf /etc/coredns/Corefile
```

The container logs the zones it loaded and the version:

```text
.:53
lab.example.:53
servfail.lab.:53
CoreDNS-1.14.7
linux/amd64, go1.26.6
```

Because the image is a minimal one with no shell, I run `dig` from a second
throwaway container that shares the host network namespace. That keeps tools off
the host machine:

```bash
docker run -d --name dig-lab --network host alpine:3.21 sleep infinity
docker exec dig-lab apk add --no-cache bind-tools
```

Now `127.0.0.1:15353` is reachable from inside `dig-lab`.

## Querying the authoritative zone with dig

The syntax is server first, port second: `dig @127.0.0.1 -p 15353 <name> <type>`.
An A record in the local zone comes back with the `aa` (authoritative answer)
flag and refuses to recurse:

```text
$ dig @127.0.0.1 -p 15353 api.lab.example A
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 19584
;; flags: qr aa rd; QUERY: 1, ANSWER: 1, AUTHORITY: 1, ADDITIONAL: 1
;; WARNING: recursion requested but not available

;; ANSWER SECTION:
api.lab.example.	3600	IN	A	10.10.0.5
```

That `aa` flag is the whole difference between an authoritative server and a
recursive one. A public resolver answering for a name it does not own never sets
it; our server answers for a zone it actually owns.

Ask for the CNAME chain and dig prints every hop, ending at the A record:

```text
$ dig @127.0.0.1 -p 15353 www.lab.example A
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 16861
;; flags: qr aa rd; QUERY: 1, ANSWER: 3, AUTHORITY: 1, ADDITIONAL: 1

;; ANSWER SECTION:
www.lab.example.	3600	IN	CNAME	web.lab.example.
web.lab.example.	3600	IN	CNAME	api.lab.example.
api.lab.example.	3600	IN	A	10.10.0.5
```

TXT records work the same way, and `+short` strips the ceremony when you only
want the value:

```text
$ dig @127.0.0.1 -p 15353 info.lab.example TXT
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 20407
;; flags: qr aa rd; QUERY: 1, ANSWER: 1, AUTHORITY: 1, ADDITIONAL: 1

;; ANSWER SECTION:
info.lab.example.	3600	IN	TXT	"lab zone served by CoreDNS"

$ dig @127.0.0.1 -p 15353 +short www.lab.example
web.lab.example.
api.lab.example.
10.10.0.5
```

## Forwarding unknown names upstream

Names outside `lab.example` fall through to the `.:53` block and are forwarded.
Here `example.com` is answered by the upstream, cached for 30 seconds — note the
flags change (no `aa`, recursion available):

```text
$ dig @127.0.0.1 -p 15353 example.com A
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1760
;; flags: qr rd ra ad; QUERY: 1, ANSWER: 2, AUTHORITY: 0, ADDITIONAL: 1

;; ANSWER SECTION:
example.com.		30	IN	A	104.20.23.154
example.com.		30	IN	A	172.66.147.243
```

That is the split you should internalise: local data is authoritative, everything
else is a cache of someone else's answer. Point your normal forwarder at an
encrypted upstream and you get the best of both — see
[encrypted DNS explained](/posts/encrypted-dns/) for DoT and DoH.

## Debugging: NXDOMAIN vs SERVFAIL, CNAMEs and TTLs

Now the useful part. Four failure modes look identical in a browser and completely
different to `dig`.

**NXDOMAIN** means "the name does not exist, authoritatively". Because our server
owns the zone, it says so with `aa` and includes the SOA so caches know the
negative TTL:

```text
$ dig @127.0.0.1 -p 15353 missing.lab.example A
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 37084
;; flags: qr aa rd; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; AUTHORITY SECTION:
lab.example.	3600	IN	SOA	ns1.lab.example. admin.lab.example. 2026120801 7200 3600 1209600 60
```

Notice the difference from **NODATA**: the name `api.lab.example` exists, but it
has no TXT record. That is a NOERROR answer with zero answers, not NXDOMAIN — the
single most misread DNS response:

```text
$ dig @127.0.0.1 -p 15353 api.lab.example TXT
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 55543
;; flags: qr aa rd; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1
```

**SERVFAIL** means the server could not answer. To force it, I pointed
`servfail.lab` at `192.0.2.1`, an address in TEST-NET-1 that goes nowhere. The
upstream never replies, so CoreDNS gives up and the client sees SERVFAIL:

```text
$ dig @127.0.0.1 -p 15353 nx.servfail.lab A +time=15 +tries=1
;; ->>HEADER<<- opcode: QUERY, status: SERVFAIL, id: 44624
;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1
```

The `log` plugin tells you *why* without guessing — the upstream read timed out:

```text
[ERROR] plugin/errors: 2 nx.servfail.lab. A: read udp 172.17.0.6:38908->192.0.2.1:53: i/o timeout
[INFO] 172.17.0.1:43065 - 41700 "A IN ns1.lab.example. udp 56 false 1232" NOERROR qr,aa,rd 104 0.00010104s
[INFO] 172.17.0.1:55595 - 38277 "A IN nope.lab.example. udp 57 false 1232" NXDOMAIN qr,aa,rd 113 0.000084484s
```

**TTLs** are the last thing to watch. The `aa` records carry the zone's 3600, but
forwarded answers are cached, so the TTL counts down between two queries seconds
apart:

```text
$ dig @127.0.0.1 -p 15353 example.com A +noall +answer
example.com.		21	IN	A	104.20.23.154
example.com.		21	IN	A	172.66.147.243
$ sleep 4
$ dig @127.0.0.1 -p 15353 example.com A +noall +answer
example.com.		17	IN	A	104.20.23.154
example.com.		17	IN	A	172.66.147.243
```

That is why "DNS propagation" is really "cache expiry": nobody is pushing the new
record anywhere, the old answer is just sitting in caches until its TTL runs out.

## Cleaning up

Two containers, both disposable:

```bash
docker rm -f coredns-lab dig-lab
```

The whole lab is a `Corefile` and a zone file you can check into a repo and rerun
in seconds.

## What I take away

DNS stops being magic the moment you run a tiny **authoritative DNS** server and
read its answers yourself. A container DNS server like this CoreDNS setup gives
you a safe place to see the `aa` flag, a real CNAME chain, NXDOMAIN versus
NODATA, a SERVFAIL caused by a dead upstream, and a TTL ticking down. Whether you
graduate to dnsmasq on a router or a hardened BIND in production, the mental
model you build here is the same one every resolver is built on.

<figure>
<svg viewBox="0 0 640 180" width="100%" role="img" aria-label="A dig client queries the CoreDNS container on 127.0.0.1 port 15353. Names inside the lab.example zone are answered locally with the authoritative flag; anything else is forwarded upstream to 1.1.1.1 and cached.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="16" y="60" width="140" height="60" rx="8"/>
    <rect x="250" y="44" width="150" height="92" rx="8"/>
    <rect x="488" y="60" width="136" height="60" rx="8"/>
    <path d="M156 90 h88" marker-end="url(#dnslab)"/>
    <path d="M400 80 h88" marker-end="url(#dnslab)"/>
    <path d="M488 120 H400" marker-end="url(#dnslab)"/>
  </g>
  <defs>
    <marker id="dnslab" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12" text-anchor="middle">
    <text x="86" y="84">dig</text>
    <text x="86" y="102" opacity="0.75">@127.0.0.1 -p 15353</text>
    <text x="325" y="74">CoreDNS container</text>
    <text x="325" y="94" opacity="0.75">zone file: lab.example</text>
    <text x="325" y="114" opacity="0.75">forward . 1.1.1.1</text>
    <text x="556" y="84">upstream</text>
    <text x="556" y="102" opacity="0.75">1.1.1.1</text>
    <text x="200" y="82" opacity="0.9">query</text>
    <text x="444" y="72" opacity="0.9">forward</text>
    <text x="444" y="136" opacity="0.9">cached answer</text>
  </g>
</svg>
<figcaption>One query, two paths: names in <code>lab.example</code> are answered locally and authoritatively from the zone file, while everything else is forwarded upstream and cached.</figcaption>
</figure>
