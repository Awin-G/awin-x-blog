---
title: "Encrypted DNS explained: DoT, DoH, and what they do (and don't) protect"
description: "A practical look at encrypted DNS: what plain DNS leaks and to whom, how DNS over TLS and DNS over HTTPS differ, what DoQ adds, what encryption protects (query content) and what it never hides (SNI, destination IPs, your resolver), the operator tradeoffs, and concrete Unbound and systemd-resolved setups."
pubDate: 2026-11-25
lang: en
translationKey: encrypted-dns
tags: [networking, security, self-hosting]
featured: false
keywords:
  - DNS over HTTPS
  - DNS over TLS
  - encrypted DNS
  - DoH vs DoT
  - Unbound
  - systemd-resolved
  - SNI
---

The first DNS query a laptop makes on a hotel network is usually a plaintext
broadcast of everywhere you are about to go. That is the pitch behind **encrypted
DNS**: wrap the question so the person in the middle cannot read it. It is a real
improvement, and it is also sold with more certainty than it deserves. **DNS over
TLS** and **DNS over HTTPS** hide the *content* of your queries, but they do not
hide the *destinations* you connect to next, and they do not stop your resolver
from seeing everything. This post covers what **DoH vs DoT** actually changes on
the wire, what stays visible, the operator tradeoffs nobody mentions in the
marketing, and how I set it up on my own machines.

If you want the underlying flow first, my earlier walkthrough of
[how DNS actually resolves](/posts/how-dns-resolves/) covers the stub resolver,
the recursive resolver, and the authoritative chain. This post assumes that and
focuses on the transport.

## What plain DNS leaks, and to whom

Classic DNS is UDP port 53, cleartext, no authentication. Every query is a little
postcard: the name you asked for, the record type, the answer, all readable by
anyone on the path. The interested parties are not hypothetical:

- **Your ISP or network operator** sees every name you resolve — that is a
  near-complete browsing history, reassembled without touching your TLS traffic.
- **On-path attackers** on open Wi-Fi can read queries and, with no DNSSEC,
  rewrite answers.
- **Anyone between you and your recursive resolver** — that often means the
  operator of whatever coffee shop, hotel, or carrier you are behind.

Worse, plain UDP DNS is trivially spoofable and is a historic DDoS amplifier.
Encryption fixes the confidentiality and tamper problems. It does not fix the
"someone upstream still answers for you" problem, which we will come back to.

## DNS over TLS (DoT): its own protocol on port 853

DoT takes the exact DNS wire format you already know and carries it over a TLS
session on **TCP port 853**. It is its own protocol on a dedicated port: a client
must know it wants DoT, and a network must choose to allow 853. That makes DoT
easy to reason about — it is DNS, over TLS, nothing else — and easy for firewalls
to identify and block.

Because it is a distinct port and protocol, DoT is the natural fit for a *system*
resolver. The OS configures one DoT endpoint, everything on the box benefits, and
applications are unchanged. That is the model `systemd-resolved` and Unbound
forwarding use.

## DNS over HTTPS (DoH): blending into port 443

DoH sends the same DNS messages as HTTP requests (RFC 8484) over HTTPS, usually
**port 443** — the same port as every other web request. The advantages are
concrete: it traverses any network that permits normal web traffic, it gets HTTP
caching and connection reuse, and it is indistinguishable from ordinary browsing
to a naive firewall. The cost is that it *is* indistinguishable: a network
administrator cannot tell your DoH query from a request for a cat photo without
deeper inspection, which is exactly why DoH is central to the enterprise debate.

DoH is what browsers ship first, because browsers already speak HTTP and control
their own TLS stack. It is the least invasive thing to enable for a single user
and the hardest thing to govern for a whole network.

## DoQ, briefly

**DNS over QUIC** (DoQ, RFC 9250) runs DNS over QUIC on UDP port 853. QUIC brings
stream multiplexing without head-of-line blocking, faster connection setup, and
per-stream flow control, so a recursive resolver answering many queries over one
connection wastes less head-of-line time than TCP-based DoT. Adoption is real but
narrower than DoT or DoH; treat it as the forward-looking option, not the default
you deploy today.

## DoH vs DoT: what encrypted DNS protects

Here is the honest scorecard. Encryption protects the **content and integrity** of
the query itself.

| Property | Plain DNS | DoT (853) | DoH (443) |
|---|---|---|---|
| Query name/type readable on-path | Yes | No | No |
| Answer tamper-proof (no DNSSEC) | No | Yes | Yes |
| Easy system-wide setup | — | Yes | Mixed |
| Blends with normal web traffic | — | No | Yes |
| Firewall can identify/block it | Trivially | Yes (port 853) | Hard |

The single most useful thing to internalise: **encryption moves trust, it does not
remove it.** Before, you trusted your ISP not to log or tamper. After, you trust
`1.1.1.1`, `8.8.8.8`, or `9.9.9.9` — and that operator now sees the whole picture
instead of your ISP. You have changed *who* knows; you have not made the knowledge
disappear.

<figure>
<svg viewBox="0 0 640 240" width="100%" role="img" aria-label="Three ways a DNS query travels: plain DNS shows the query name in cleartext to every hop, DNS over TLS encrypts it on port 853 but reveals the port, DNS over HTTPS encrypts it inside port 443 and is indistinguishable from web traffic.">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="16" y="26">plain DNS (UDP 53)</text>
    <text x="16" y="106">DNS over TLS (853)</text>
    <text x="16" y="186">DNS over HTTPS (443)</text>

    <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
      <rect x="176" y="12" width="130" height="30" rx="6"/>
      <rect x="176" y="92" width="130" height="30" rx="6"/>
      <rect x="176" y="172" width="130" height="30" rx="6"/>
      <path d="M306 27 h44" marker-end="url(#ar)"/>
      <path d="M306 107 h44" marker-end="url(#ar)"/>
      <path d="M306 187 h44" marker-end="url(#ar)"/>
    </g>

    <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
      <rect x="350" y="12" width="130" height="30" rx="6"/>
      <rect x="350" y="92" width="130" height="30" rx="6"/>
      <rect x="350" y="172" width="130" height="30" rx="6"/>
      <path d="M480 27 h44" marker-end="url(#ar)"/>
      <path d="M480 107 h44" marker-end="url(#ar)"/>
      <path d="M480 187 h44" marker-end="url(#ar)"/>
    </g>

    <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
      <rect x="524" y="12" width="100" height="30" rx="6"/>
      <rect x="524" y="92" width="100" height="30" rx="6"/>
      <rect x="524" y="172" width="100" height="30" rx="6"/>
    </g>

    <text x="241" y="32" text-anchor="middle">query: example.com</text>
    <text x="415" y="32" text-anchor="middle">visible</text>
    <text x="574" y="32" text-anchor="middle">ISP logs it</text>

    <text x="241" y="112" text-anchor="middle" opacity="0.75">&#9617;&#9617;encrypted bytes&#9617;&#9617;</text>
    <text x="415" y="112" text-anchor="middle">Dst port 853</text>
    <text x="574" y="112" text-anchor="middle">sees port, not name</text>

    <text x="241" y="192" text-anchor="middle" opacity="0.75">&#9617;&#9617;encrypted bytes&#9617;&#9617;</text>
    <text x="415" y="192" text-anchor="middle">looks like normal HTTPS</text>
    <text x="574" y="192" text-anchor="middle">sees IP only</text>
  </g>
  <defs>
    <marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>
<figcaption>Plain DNS exposes every hop to the query name. DoT hides the name but announces itself on port 853. DoH hides the name and the protocol, leaving only the resolver IP.</figcaption>
</figure>

## What encrypted DNS does not protect

This is the part the marketing skips. Even with DoH or DoT everywhere:

- **The resolver still sees your queries.** You moved the log from your ISP to
  Cloudflare, Google, or Quad9. Unless you run your own resolver — see
  [running your own recursive DNS resolver](/posts/self-hosted-dns-resolver/) —
  somebody still has the full picture.
- **The SNI in the TLS handshake is visible.** When you then connect to
  `api.example.com`, the ClientHello carries the **SNI** hostname in cleartext for
  almost every connection you make. Anyone on-path sees where you are going even
  though your DNS was encrypted. Encrypted Client Hello (ECH) is the fix, and it
  is still rolling out.
- **The destination IP is visible.** You connect to *an* IP, and the network sees
  it. With shared hosting and CDNs that IP is ambiguous, but it is still a signal,
  and it is trivially correlated with the SNI.
- **Timing and volume metadata survive.** Who, when, how much, how often.
- **DNSSEC is separate.** DoH/DoT guarantee transport integrity; they do not
  validate the answer's origin unless the resolver does DNSSEC itself.

So the accurate claim is: encrypted DNS hides the *question*, not the *visit*. It
raises the cost of passive surveillance meaningfully. It does not defeat a
determined observer who can see SNI and IPs.

## The tradeoffs for operators

Encryption is a user win and, historically, an operator headache. The honest
tradeoffs:

- **Centralisation.** If everyone defaults to a handful of public DoH resolvers,
  those operators get a global view of traffic that used to be spread across
  thousands of ISPs. You traded distributed logging for concentrated logging.
- **Enterprise visibility.** Corporate DNS is a security control: it knows which
  endpoints talk to malware domains. Browser-level DoH silently bypasses it,
  which is why Chrome and Firefox both ship enterprise policies to disable DoH
  and point at a managed resolver.
- **Filtering, parental controls, and captive portals.** Pi-hole, router-level
  blocking, and family filters all work by answering DNS. A client that uses its
  own encrypted resolver walks straight around them. DoT to a *chosen* resolver
  and network-level DoH blocking are the common containment strategies.

None of this makes encrypted DNS bad. It means "just turn on DoH" is a decision
with second-order effects, not a default you flip without thinking.

## How to set it up

Four realistic options, from system-wide to browser-only.

### Unbound forwarding over DoT

Run [Unbound](/posts/self-hosted-dns-resolver/) locally, resolve the tree itself,
and forward the *upstream* leg over DoT only when you need a trusted forwarder.
The key settings:

```conf
# /etc/unbound/unbound.conf.d/dot.conf
server:
    tls-cert-bundle: "/etc/ssl/certs/ca-certificates.crt"
    # resolve recursively yourself; no forward leg at all when possible:

forward-zone:
    name: "."
    forward-tls-upstream: yes
    forward-addr: 1.1.1.1@853#cloudflare-dns.com
    forward-addr: 9.9.9.9@853#dns.quad9.net
```

If you would rather resolve recursively — the strongest privacy position — drop
the `forward-zone` entirely and let Unbound walk from the root; that is the config
in the [self-hosted resolver post](/posts/self-hosted-dns-resolver/). Verify with
`unbound-host -v -C /etc/unbound/unbound.conf example.com`.

### systemd-resolved with DoT

On a modern Linux desktop or server, `systemd-resolved` can speak DoT to your
chosen upstreams system-wide:

```ini
# /etc/systemd/resolved.conf.d/dot.conf
[Resolve]
DNS=1.1.1.1#cloudflare-dns.com 9.9.9.9#dns.quad9.net
DNSOverTLS=yes
DNSSEC=allow-downgrade
Domains=~.
FallbackDNS=
```

```bash
sudo systemctl restart systemd-resolved
resolvectl status            # confirm "+DNSOverTLS" on the current link
resolvectl query example.com # shows the transport and which server answered
```

`DNSOverTLS=yes` is strict: if the upstream refuses TLS, resolution fails rather
than silently falling back to cleartext. That is usually what you want; use
`opportunistic` if you would rather degrade than break.

### Browser DoH

Firefox and Chrome let you pick a DoH resolver directly, independent of the OS.
Firefox: **Settings → Privacy & Security → DNS over HTTPS → Max Protection**.
Chrome: **Settings → Privacy and security → Security → Use secure DNS**. This is
the fastest single-user win and the thing that most annoys network admins. If you
manage endpoints, set the enterprise policy that disables it and pins your own
resolver instead.

```bash
# Confirm what a DoH endpoint actually answers, without a browser:
curl -sS -H 'accept: application/dns-json' \
  'https://cloudflare-dns.com/dns-query?name=example.com&type=A' \
  | jq '.Answer'
```

### A self-hosted resolver for the whole network

The endgame: one Unbound instance on your LAN resolving recursively, with DoT for
any stub clients that want encryption on the last hop. Point your DHCP option 6 at
it, keep it off the public internet, and enjoy both privacy and working filters:

```bash
# Last-hop check: query your own resolver over DoT and see the cert it presents
kdig -d @192.168.1.10 +tls-ca +tls-hostname=resolver.lan example.com
```

## The recommendation

Enable encrypted DNS, but know what you bought. My defaults:

1. **System-wide:** `systemd-resolved` with DoT to two independent upstreams for
   laptops and servers. It is one file and it just works.
2. **Home network:** run your own recursive Unbound, so the queries stop leaving
   your network at all. This is the only configuration where "encrypted DNS" is
   even the second-best thing you did.
3. **Browsers:** leave DoH on for people you do not manage; pin your own resolver
   via enterprise policy for fleets you do.
4. **Do not pretend it hides everything.** The **SNI** and the destination IP are
   still there. If your threat model is an observer with those signals, encrypted
   DNS is one layer, not the answer — combine it with ECH, a VPN, and Tor where
   appropriate.

The question is never "is encrypted DNS good?" It is "which trust did I just
move, and did I move it somewhere better?"
