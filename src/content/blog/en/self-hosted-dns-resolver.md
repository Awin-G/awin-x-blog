---
title: "Running your own recursive DNS resolver (and when you shouldn't)"
description: "Forwarders vs a true recursive DNS resolver, why self-hosted DNS is worth it for privacy and filtering, practical options (Unbound, Knot Resolver, dnsdist), a hardened Unbound config with qname minimisation and DNSSEC, and the open resolver failure modes to avoid."
pubDate: 2026-10-28
lang: en
translationKey: self-hosted-dns-resolver
tags: [networking, self-hosting, security]
featured: false
keywords:
  - recursive DNS resolver
  - self-hosted DNS
  - Unbound
  - qname minimisation
  - DNSSEC
---

I have run a **recursive DNS resolver** on my LAN for years, and it is one of the
few self-hosted services I would build again from scratch. It is also one of the
easiest to get catastrophically wrong: a misconfigured resolver on a public IP is
not a quirky pet project, it is a DDoS amplifier that someone else will find
within hours. This post is the version I wish I had read first — what a
**self-hosted DNS** resolver actually is versus the forwarder you probably already
run, why the tradeoffs are worth it, a concrete **Unbound** config with **qname
minimisation**, **DNSSEC**, cache tuning and access control, and the honest cases
where you should just use your provider's resolver.

## A forwarder is not a recursive resolver

Most "DNS servers" people self-host are *forwarders*. `dnsmasq` on your router,
`systemd-resolved` on your laptop, and every Pi-hole install out of the box: these
take your query and hand it to somebody else — `1.1.1.1`, `8.8.8.8`, your ISP —
then cache the answer. They are proxies. Someone upstream still walks the tree.

A true recursive resolver does the walking itself. It starts at the root servers,
follows referrals to the TLD, then to the authoritative servers for the zone, and
returns the answer — the full process I broke down in
[how DNS actually resolves](/posts/how-dns-resolves/). No third party sees the
question unless the delegation chain requires it to.

That distinction is the whole point of the exercise:

- A **forwarder** outsources trust. Your upstream sees every name you look up, in
  order, tied to your IP.
- A **recursive resolver** keeps the question on your box. The root and TLD
  servers see fragments of the path, and the authoritative server sees the final
  query, but no single operator sees your full browsing history.

## Why self-host a resolver at all

The case is not "it is faster" — it usually is not, on a cold cache. The case is
control.

- **Privacy against upstream logging.** Your ISP, your employer's network, and
  public resolvers all log queries. Keeping recursion local means the only place
  your full query stream exists is a cache you own, on a box you can audit.
- **No upstream policy.** Public resolvers filter, block, or NXDOMAIN whatever
  their operator decides. A recursive resolver answers what DNS actually says.
- **Filtering on your terms.** You can block trackers, ad domains, or a specific
  hostname for one device, without redirecting anyone else's traffic.
- **Internal names, one resolver.** A recursive resolver doubles as an
  authoritative server for your own LAN zone (`home.lan`, `internal.example`), so
  clients get split-horizon answers from the same box.
- **Kill switch value.** Point your LAN at it and outbound port 53 to the internet
  can be dropped entirely — nothing bypasses your policy silently.

If your threat model is "I do not want my ISP composing a profile from my DNS,"
this is the cheapest meaningful move you can make.

## Pick your resolver: Unbound, Knot Resolver, or dnsdist

Three names cover almost every real deployment, and they are not interchangeable.

| Project | Role | Reach for it when |
| --- | --- | --- |
| **Unbound** | Full recursive resolver, validating, authoritative-lite | You want one solid daemon and a config file you fully understand |
| **Knot Resolver** | Full recursive resolver, modern cache, Lua policy engine | You want scriptable policy: per-client answers, complex rules |
| **dnsdist** | DNS load balancer / frontend | You already have backends and need rate-limiting, DoH/DoT, caching in front |

Unbound is my default: a single C binary, no runtime dependencies, a documented
config, and a security record that comes from doing one job. Knot Resolver is
excellent when you need a policy engine and are comfortable with its Lua hooks.
dnsdist is not a resolver at all — it is the layer you put *in front* of one to
absorb abuse and terminate encrypted transports.

## A concrete Unbound config

Here is a hardened starting point. It listens only on your LAN, validates DNSSEC,
uses qname minimisation, tunes the cache, and refuses anything it should not
answer.

```yaml
# /etc/unbound/unbound.conf.d/local.conf
server:
    verbosity: 1
    interface: 10.0.0.1
    interface: ::1
    port: 53
    do-ip4: yes
    do-ip6: yes
    do-udp: yes
    do-tcp: yes

    # Access control: LAN only. This is the single most important line.
    access-control: 10.0.0.0/8 allow
    access-control: 192.168.0.0/16 allow
    access-control: 0.0.0.0/0 refuse
    access-control: ::/0 refuse

    # Hardening
    hide-identity: yes
    hide-version: yes
    harden-glue: yes
    harden-dnssec-stripped: yes
    harden-below-nxdomain: yes
    harden-referral-path: yes
    use-caps-for-id: yes
    qname-minimisation: yes
    qname-minimisation-strict: yes

    # DNSSEC: validate, and fail closed
    auto-trust-anchor-file: "/var/lib/unbound/root.key"
    val-clean-additional: yes
    val-log-level: 2

    # Explicit root hints instead of trusting a packaged file blindly
    root-hints: "/var/lib/unbound/root.hints"

    # Cache tuning
    msg-cache-size: 64m
    rrset-cache-size: 128m
    cache-min-ttl: 60
    cache-max-ttl: 86400
    prefetch: yes
    prefetch-key: yes
    serve-expired: yes
    serve-expired-ttl: 86400
```

The lines that matter most, in order:

- **`access-control`** — with `0.0.0.0/0 refuse` at the end, the box refuses to be
  an open resolver even if the firewall leaks. Never expose this to the internet.
- **`qname-minimisation: yes`** — the resolver asks the root for the shortest
  possible name (`.`, then `com.`, then `example.com.`) instead of leaking the full
  query upstream. The strict mode sends no message at all unless needed.
- **`auto-trust-anchor-file`** — enables DNSSEC validation. `val-clean-additional`
  strips bogus records from additional sections; with validation on, a forged
  answer returns `SERVFAIL` instead of an address.
- **`harden-glue`, `harden-referral-path`** — reject the off-path cache-poisoning
  classes that Kaminsky-era bugs exploited.

Verify it is actually validating rather than just claiming to:

```bash
# A signed domain must validate (rcode NOERROR, ad flag set)
dig +dnssec @10.0.0.1 cloudflare.com

# The deliberately broken DNSSEC test domain must fail
dig +dnssec @10.0.0.1 dnssec-failed.org
# Expect: status: SERVFAIL  -- if you get an A record, validation is off.
```

Then check that it resolves from the root, not through a forwarder:

```bash
unbound-control status
unbound-control lookup www.example.com
dig +trace @10.0.0.1 www.example.com
```

## Encrypt the last hop: DoT and DoH

Recursion to the internet is still plaintext UDP. If your resolver sits across an
untrusted link, push the recursion off the box entirely and have it forward over
**DoT** or **DoH** to a trusted upstream instead:

```yaml
forward-zone:
    name: "."
    forward-tls-upstream: yes
    forward-addr: 1.1.1.1@853#cloudflare-dns.com
    forward-addr: 9.9.9.9@853#dns.quad9.net
```

Note the tradeoff honestly: `forward-tls-upstream` makes the network path private
but hands your query stream to that upstream. You cannot have both full recursion
*and* an encrypted transport to it — the authoritative servers do not speak DoT.
The fix for a resolver on a hostile link is usually a VPN, not DoT to a third
party. **DoT DoH** secures the stub-to-resolver hop; it does not make recursion
private by itself.

## Performance and reality

Be honest about what you gain. A cold recursive resolver is *slower* than a big
public one whose cache already holds half the internet.

- **First lookup is expensive.** Root → TLD → authoritative is three round trips
  before your query. Public resolvers amortise that across millions of users; you
  pay it yourself.
- **Cache warming is real but small.** A fresh resolver holds nothing. `prefetch`
  and `serve-expired` keep hot names warm, and `unbound-control` can pre-populate
  your common domains — but the win is modest unless you have many clients.
- **Latency is dominated by the last hop.** Once cached, a local resolver answers
  in under a millisecond. That is a *perceived* win for browsing, not bandwidth.
- **Root hints matter.** A stale `root.hints` file routes every cold query through
  a wrong or dead anycast node. Refresh it periodically and never treat it as
  static:

```bash
# Refresh root hints monthly (root primaries are stable since 2019)
curl -s https://www.internic.net/domain/named.root -o /var/lib/unbound/root.hints
systemctl restart unbound
```

- **Memory is the tuning knob.** `rrset-cache-size` and `msg-cache-size` should
  sum to more than the working set of names your clients touch; 128 MB of rrset
  cache is generous for a home or small office.

## Failure modes: the open resolver problem

This is where self-hosted DNS stops being fun.

An **open resolver** answers recursive queries from anyone. That makes it a
DDoS amplification weapon: an attacker sends a DNS query with a spoofed source
IP — yours — and the resolver blasts a much larger response at your victim. A
small query becomes a 50×–100× larger reply, and there are botnets that scan for
port 53 within minutes of a box appearing online.

The defenses, in order:

1. **Bind to the LAN interface only** — never `0.0.0.0`. The
   `access-control` lines above are the backstop; the interface binding is the
   primary wall.
2. **Drop outbound port 53 at the edge.** Your resolver should be the only thing
   allowed to talk to the internet on UDP/TCP 53, so a compromised client cannot
   become a rogue source:

```bash
# nftables: allow LAN clients to reach the resolver, block direct 53 out
nft add rule inet filter output udp dport 53 ip daddr 10.0.0.1 accept
nft add rule inet filter forward udp dport 53 drop
nft add rule inet filter forward tcp dport 53 drop
```

3. **Rate-limit and cap.** Even on the LAN, a runaway client should not starve
   everyone:

```yaml
server:
    ratelimit: 200            # replies/sec per client, doubled on overflow
    ip-ratelimit: 50          # per-source-IP queries/sec
    num-queries-per-thread: 4096
```

4. **Turn on RRL (Response Rate Limiting).** Unbound's `ip-ratelimit` plus
   `ratelimit` curbs spoofed-source floods. If you are genuinely serving many
   clients, put [dnsdist in front](/posts/self-hosting-without-docker/) to absorb
   the abuse before it reaches the resolver.
5. **Monitor it.** A spike in query volume, a sudden flood of `TXT` or `ANY`, or
   traffic to port 53 from outside your subnets means you are being used. Alert on
   it, do not wait for an abuse email.

## When you should just use your provider's resolver

Recursion is not free, and the honest answer is that most people should not run
it. Skip it if:

- **You are on a laptop that roams.** Running a resolver on a machine that
  changes networks constantly means your queries break the moment the resolver
  is not reachable. Use the system stub and a reputable DoH/DoT upstream.
- **Your upstream is already trustworthy and nearby.** A well-run ISP resolver a
  few milliseconds away with a big warm cache beats a cold local one on both
  latency and policy. If you trust the operator, you are not losing much.
- **You want zero maintenance.** Recursion needs root hints refreshes, trust
  anchor rollovers, version updates, and monitoring. A managed resolver needs
  none of that.
- **You are already using a good encrypted forwarder.** `systemd-resolved` or a
  browser DoH config gives you most of the path privacy with none of the abuse
  risk.

Run your own recursive resolver when you have a stable network, more than a
handful of clients, a genuine privacy reason, and the discipline to firewall the
box properly. Otherwise, a reputable resolver — with DoT or DoH — is the
smarter, boring, correct choice. The point is not to run more software; it is to
know exactly who sees your queries and why.
