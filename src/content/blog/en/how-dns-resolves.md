---
title: "How DNS actually resolves, step by step (for engineers)"
description: "A packet-level walkthrough of DNS resolution: the stub resolver, the recursive resolver, root and TLD servers, the authoritative answer, caching and TTLs, the record types that matter, CNAME rules, glue and apex ALIAS/ANAME, authoritative vs recursive roles, and debugging with dig +trace, kdig, DoH and DoT."
pubDate: 2026-10-26
lang: en
translationKey: how-dns-resolves
tags: [networking, linux]
featured: false
keywords:
  - how DNS works
  - DNS resolution
  - recursive resolver
  - dig trace
  - TTL caching
---

Two hours after you pointed `api.example.com` at a new box, half the internet is
still talking to the old one. Nothing is broken; you have just met the part of
**how DNS works** that never makes it into the diagram — the caching. DNS is a
distributed, hierarchical, aggressively cached database, and most "propagation"
problems are really cache-expiry problems. This is the walk-through I use when
onboarding engineers: what **DNS resolution** actually does to one name, from the
**stub resolver** inside your process to the **authoritative** server that owns the
answer, and how to debug it with `dig +trace` when the answer is wrong.

I follow a single lookup end to end, then cover the records you touch day to day,
then the failure modes that will actually page you.

## How DNS works: the cast of servers

Every lookup passes through a small set of roles. Confusing them is the root of
most DNS arguments.

- **Stub resolver** — the tiny client baked into your OS or libc (`getaddrinfo`).
  It knows nothing; it just forwards a query to whatever recursive resolver it was
  configured with and waits.
- **Recursive resolver** — the workhorse (`systemd-resolved`, `unbound`, your
  router, `1.1.1.1`). It does the walking, caches everything it learns, and
  answers your process. This is the only component that *resolves*.
- **Root servers** — thirteen named identities (`.`) served from hundreds of
  anycast nodes. They do not know your name; they only point at the TLD.
- **TLD servers** — they own `.com`, `.io`, `.dev`. They point at the
  authoritative servers for the domain under them.
- **Authoritative servers** — they hold the real records for
  `example.com` and answer with authority. They never ask anyone else; they are
  the end of the line.

The key split: root, TLD, and authoritative servers are **authoritative** — they
answer for zones they own and refuse to recurse. Only the recursive resolver
recurses. Your machine almost never talks to a root server directly.

## DNS resolution, step by step

Say a process on your laptop asks for `www.example.com`. Here is the full path.

```
stub            recursive               root      TLD (.com)     authoritative
 |                 |                      |           |               |
 |-- query www.example.com -------------->|           |               |
 |                 |-- miss cache         |           |               |
 |                 |-- query . ---------------------->|               |
 |                 |<- referral: .com NS + glue --------|               |
 |                 |-- query .com ----------------------------->       |
 |                 |<- referral: example.com NS + glue -----------------|
 |                 |-- query www.example.com ----------------------->  |
 |                 |<- authoritative A 203.0.113.10, TTL 300 ----------|
 |<- answer 203.0.113.10 (cached for 300s) |           |               |
```

Reading it in order:

1. The stub sends a *recursive* query (`RD=1`) to the recursive resolver.
2. The recursive resolver checks its cache. A hit ends the story here.
3. On a miss, it starts at the root. The root replies with a **referral**: "for
   `.com`, ask these TLD servers," and includes **glue** addresses so it does not
   have to resolve the TLD servers' own names first.
4. It asks a `.com` TLD server, which refers it to the authoritative name servers
   for `example.com` — again with glue.
5. It asks an authoritative server for `example.com`, which returns the actual
   `A` record plus a TTL.
6. The recursive resolver caches each answer for its TTL and returns the final
   address to your process.

You can watch this exact sequence without trusting any resolver, because
`dig +trace` starts from the root and follows referrals itself:

```bash
dig +trace www.example.com

# Repeats the whole hierarchy: root -> .com -> example.com -> answer.
# No cache is used, so you see the real delegation chain.
```

Note the difference in roles: steps 1–2 are **recursive** (the resolver does work
on your behalf); steps 3–5 are **iterative** (each server only points to the next).

## Caching and TTLs

Every record carries a **TTL** in seconds. The resolver may cache the answer for
that long, then must re-ask. Two numbers matter:

- **What the authoritative server publishes** — the TTL on the record itself.
- **What a given resolver chose to keep** — it may only honour the lower of the
  record TTL and its own minimum, and it never has to cache at all.

This is why "I changed the record and it's slow" is not a bug. If the old record
had a 24-hour TTL, resolvers all over the world are entitled to keep serving it
for 24 hours. The practical rule: **lower the TTL a day before a migration**, do
the cutover, then raise it again. That is the only reliable way to make DNS
changes fast.

## Record types that matter day to day

You will not memorise every RR type. These eight cover almost all real work.

| Type | What it means | Typical use |
| --- | --- | --- |
| `A` | IPv4 address | `example.com. 300 IN A 203.0.113.10` |
| `AAAA` | IPv6 address | `example.com. 300 IN AAAA 2001:db8::10` |
| `CNAME` | Alias to another name | `www` → `example.com` |
| `TXT` | Arbitrary text | SPF, DKIM, domain verification |
| `MX` | Mail exchanger (+ priority) | where email for the domain goes |
| `NS` | Name server for a zone | the delegation itself |
| `SOA` | Zone authority record | serial, refresh, negative TTL |
| `CAA` | Which CAs may issue certs | `letsencrypt.org` allowed |

Two of these punch above their weight. `SOA` carries the **negative TTL**
(minimum field) — how long a resolver may cache "this name does not exist" — which
is why a `NXDOMAIN` can mysteriously persist. `CAA` can silently block a
certificate renewal if a CA you no longer use is the only one listed.

## CNAME rules: one is fine, chains are not

A `CNAME` says "this name is an alias; go ask about that name instead." Two rules
trip people up constantly:

- **No other data may coexist with a CNAME.** A name that has a `CNAME` cannot
  also have an `A`, `TXT`, or `MX`. The CNAME replaces everything.
- **Only the left side is aliased, not the zone.** `www.example.com CNAME
  example.com` does not make `mail.example.com` follow along.

Long CNAME chains technically work but add latency (every hop is another lookup)
and another place to break. Keep it to one hop where you can.

## Apex CNAMEs, glue, and why ALIAS/ANAME exist

The zone **apex** (the bare `example.com`) must carry the `SOA` and `NS` records,
and nothing may coexist with a `CNAME`. So you **cannot** put a plain `CNAME` at
the apex — `example.com CNAME example.com` is simply invalid DNS. This is the
problem **ALIAS** and **ANAME** solve: a non-standard record an authoritative
server resolves *internally* and then answers as if it were an `A`/`AAAA`, so the
apex can point at a load balancer without a CNAME. It only works because that
provider's server does the special-casing; a client never sees an `ALIAS`.

**Glue** is the related trick in the other direction. When a TLD delegates
`example.com` to `ns1.example.com`, resolving `ns1.example.com` would require
first finding `example.com` — a circular dependency. So the TLD zone holds *glue*
`A`/`AAAA` records for the in-zone name servers, breaking the loop. Bad glue
(a stale IP for a name server) is a classic cause of a whole domain becoming
unreachable.

## Authoritative vs recursive: two different jobs

Keep the two roles straight and half of DNS confusion evaporates.

- A **recursive** resolver answers for *any* name, caches, and will do the walking.
  It can be wrong in a cached way.
- An **authoritative** server answers only for zones it holds, never caches other
  people's data, and is the source of truth. If it is wrong, the domain is wrong
  everywhere.

When someone says "the DNS server is down," ask which one. If *recursive* broke,
only your clients are affected. If *authoritative* broke, the whole internet loses
the zone once caches expire.

## Debugging with dig, kdig, and dig +trace

`dig` is the tool to live in. The essentials:

```bash
# Default: the A record via your configured resolver, with full header
dig example.com

# Just the answer, ideal for scripts
dig +short example.com

# Ask a specific server, bypassing your config
dig @1.1.1.1 example.com A
dig @ns1.example.com example.com SOA

# Follow the delegation from the root yourself
dig +trace example.com

# Ask for DNSSEC records and see the validation result
dig +dnssec example.com
```

A few habits that save time:

- **`dig` does not use `/etc/hosts` or the NSS stack** — it queries DNS directly.
  If `dig` works but your app fails, the problem is `nsswitch.conf` or a stuck
  local stub, not the upstream resolver.
- **Read the `status:` line.** `NOERROR` with an empty answer section means the
  name exists but has no record of that type; `NXDOMAIN` means the name does not
  exist. They are different bugs.
- **`+trace`** proves where the chain breaks: root answers, TLD answers, but the
  authoritative server is silent → the delegation or the server is the problem.

`kdig` (from Knot DNS) adds encrypted transports on top of the same syntax:

```bash
# DNS over TLS
kdig +tls @1.1.1.1 example.com

# DNS over HTTPS
kdig +https @https://cloudflare-dns.com/dns-query example.com
```

## DoH and DoT: encrypted DNS

Classic DNS is plaintext UDP port 53, which means anyone on the path can read and
rewrite your queries. **DoT** wraps DNS in TLS on port 853; **DoH** wraps it in
HTTPS on port 443, making it indistinguishable from ordinary web traffic. DoH
travels where port 53 is blocked — including the walled gardens that
[captive portals](/posts/captive-portals-explained/) set up before you log in,
which is exactly why some portals work over a DoH-enabled browser and fail in a
terminal.

The caveat: encryption protects the path, not the resolver. You are simply moving
trust from your network to the DoH provider, who now sees all your queries.

## The failure modes you will actually hit

- **"Propagation."** It is not real. There is no push. Every resolver holds its
  own copy until its TTL expires. Two users see different answers because their
  resolvers cached at different times. The fix is planning TTLs, not waiting.
- **TTL surprises.** A resolver may have pinned your record far longer than you
  expected, or a CDN may serve a short TTL to force re-resolution. Always check
  the TTL you actually received, not the one you set.
- **Split-horizon DNS.** The same name answers differently inside and outside your
  network — internal clients reach a private address, external clients a public
  one. Debugging "works for me" usually means you are querying the internal view.
  `dig @8.8.8.8` sees the world; `dig` sees your LAN.
- **DNSSEC validation failures.** A validating resolver (`dig +dnssec` reports
  `SERVFAIL`) will refuse a zone whose signatures are expired, whose keys are
  missing from the parent via `DS`, or whose responses are unsigned after a
  parent said they should be signed. The signature chain must be intact from the
  root down — a rotated key you forgot to publish takes the domain dark for every
  validating resolver, even though the records themselves look fine.
- **Asymmetric reachability.** If your recursive resolver is itself behind a NAT
  or a stateful firewall, some upstream servers may be unreachable, and queries
  quietly stall. The [same NAT traversal issues](/posts/nat-traversal-explained/)
  you fight for inbound connections show up as resolver timeouts.

## The one-paragraph summary

A stub resolver forwards one question to a recursive resolver, which walks the
tree iteratively — root, TLD, authoritative — caching every answer for its TTL
and returning the address. The authoritative side owns the truth; the recursive
side owns the cache, and the cache is why nothing "propagates." Records are simple
once you know the CNAME coexistence rules and why the apex is special. When
something breaks, `dig`, `dig +trace`, and `kdig +tls`/`+https` tell you exactly
which hop stopped answering — and whether it is a cache, a delegation, or a
DNSSEC chain that is the problem.
