---
title: "DNSSEC in Practice: Signing a Zone and Watching Validation Fail"
description: "A hands-on DNSSEC walkthrough: sign a real zone with BIND inline signing, inspect DNSKEY/RRSIG/DS/NSEC records, see the ad flag from a validating resolver, watch SERVFAIL when the chain breaks, and learn why key rollovers make DNSSEC operationally painful."
pubDate: 2027-01-13
lang: en
translationKey: dnssec-in-practice
tags: [networking, security]
featured: false
keywords:
  - DNSSEC
  - RRSIG
  - chain of trust
  - DNSSEC validation
  - DS record
---

DNSSEC is one of those protocols everyone agrees is important and almost nobody
has watched actually work. I have run authoritative DNS for years — see
[how DNS resolves end-to-end](/posts/how-dns-resolves/) and
[zone transfers with AXFR](/posts/dns-zone-transfer-axfr/) — but I had never
deliberately signed a zone and then broken it on purpose to see what happens.
So I spun up a throwaway BIND server on loopback, signed a small zone, validated
it against a real resolver, and then broke the chain to watch validation fail.
This post is the tour I wish I had first.

## What DNSSEC Does (and What It Does Not)

DNSSEC adds **origin authentication** and **data integrity** to DNS. It answers
two questions: *did this answer really come from the zone owner?* and *was it
modified in transit?* It does so with a chain of cryptographic signatures that
starts at the DNS root and descends through TLD delegations to your zone.

What it does **not** do: DNSSEC provides zero privacy. Every record, signature,
and key travels in plaintext. Anyone on the path sees exactly which names you
query. If you want privacy, that is [DNS-over-HTTPS / DNS-over-TLS](/posts/encrypted-dns/)
— a separate problem. DNSSEC is about trust, not confidentiality.

## The Records: DNSKEY, RRSIG, DS, and NSEC

Four record types make DNSSEC work:

- **DNSKEY** — the public keys. Each zone has at least one Key Signing Key (KSK,
  flagged `257`) used to sign other keys, and one or more Zone Signing Keys (ZSK,
  flagged `256`) used to sign the actual zone data. Think of it as a key
  hierarchy: the KSK is the master key you hand to the parent, the ZSK does the
  daily signing work.
- **RRSIG** — the signatures. Every RRset (group of records of the same type
  and name) gets an RRSIG that covers it. The RRSIG contains a signature, the
  algorithm, the key tag, and an expiration time. If you change any record in
  the RRset, you must re-sign.
- **DS record** — the hash of the KSK, published in the *parent* zone. This is
  the link in the chain of trust. The parent says "this is what the child's
  KSK should look like," and the validator checks the child's actual DNSKEY
  against this hash.
- **NSEC / NSEC3** — proof of non-existence. When you ask for a name that does
  not exist, NSEC returns the closest existing names and proves there is
  nothing between them. NSEC3 hashes the names to avoid trivial zone walking,
  at the cost of extra complexity.

## The Chain of Trust: From Root to Zone

<figure>
<svg viewBox="0 0 600 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="DNSSEC chain of trust from root to TLD to zone">
  <defs>
    <style>
      .box { fill: #f0fdfa; stroke: #0f766e; stroke-width: 2; rx: 8; }
      .arrow { stroke: #0f766e; stroke-width: 2; fill: none; marker-end: url(#head); }
      .label { font-family: system-ui, sans-serif; font-size: 13px; fill: #134e4a; }
      .sublabel { font-family: system-ui, sans-serif; font-size: 11px; fill: #0f766e; }
    </style>
    <marker id="head" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="#0f766e"/>
    </marker>
  </defs>

  <!-- Root -->
  <rect class="box" x="220" y="10" width="160" height="50" rx="8"/>
  <text class="label" x="300" y="32" text-anchor="middle">Root (.)</text>
  <text class="sublabel" x="300" y="48" text-anchor="middle">KSK → DS for TLDs</text>

  <!-- Arrow root to TLD -->
  <path class="arrow" d="M300,60 L300,90"/>

  <!-- TLD -->
  <rect class="box" x="220" y="90" width="160" height="50" rx="8"/>
  <text class="label" x="300" y="112" text-anchor="middle">TLD (.com)</text>
  <text class="sublabel" x="300" y="128" text-anchor="middle">KSK → DS for zones</text>

  <!-- Arrow TLD to zone -->
  <path class="arrow" d="M300,140 L300,170"/>

  <!-- Zone -->
  <rect class="box" x="220" y="170" width="160" height="50" rx="8"/>
  <text class="label" x="300" y="192" text-anchor="middle">Zone (example.com)</text>
  <text class="sublabel" x="300" y="208" text-anchor="middle">ZSK signs all RRsets</text>
</svg>
<figcaption>The chain of trust: each level delegates to the next by publishing a DS record (hash of the child's KSK). A validator walks from the root down, verifying each link.</figcaption>
</figure>

The validator starts with the root's KSK — a key you configure as a trust anchor
(or that ships with the resolver). It verifies the DS for the TLD against the
root's delegation, then the DS for your zone against the TLD's delegation, and
finally the RRSIGs in your zone against your DNSKEY. Every step is a signature
check. Break any link and the chain fails.

## Signing a Zone with Inline Signing

I used BIND 9.18 in Docker on loopback (`127.0.0.1:15353`). The key pieces of
the config:

```named
dnssec-policy "lab-policy" {
    keys {
        ksk lifetime P180D algorithm ecdsap256sha256;
        zsk lifetime P90D algorithm ecdsap256sha256;
    };
    signatures-refresh P14D;
    signatures-validity P21D;
};

zone "dnssec-lab.example" {
    type primary;
    file "/var/cache/bind/dnssec-lab.example.db";
    key-directory "/var/cache/bind/keys";
    inline-signing yes;
    dnssec-policy "lab-policy";
    journal "/var/cache/bind/dnssec-lab.example.db.journal";
};
```

`inline-signing yes` means BIND signs the zone in place — the zone file on disk
stays unsigned, and BIND serves the signed version from memory plus a journal.
When BIND starts with this policy, it generates the KSK and ZSK automatically,
signs every RRset, and starts a key-event timer for rollovers.

After startup, the keys exist:

```console
# ls /var/cache/bind/keys/
Kdnssec-lab.example.+013+06758.key    # KSK
Kdnssec-lab.example.+013+06758.private
Kdnssec-lab.example.+013+12610.key    # ZSK
Kdnssec-lab.example.+013+12610.private
```

Query the DNSKEY records:

```console
# dig @127.0.0.1 -p 15353 dnssec-lab.example DNSKEY +noall +answer
dnssec-lab.example.  3600  IN  DNSKEY  257 3 13 Qn7j7gOj5Cip060IT57fIChO3AIizRSE6KTqE+O8cFuqoVroLtog1ZzvSYoOdwM/f4aETvWnZToYYhuhnQCi6w==
dnssec-lab.example.  3600  IN  DNSKEY  256 3 13 S+M6QjU1xU0CgZsIeAjVi5gAt34H6p+pNmK80YCMf8gUESdnRucr60XvyjviSfeeKiqP17BPMaiTibZKLakq/Q==
```

Two keys: `257` (KSK) and `256` (ZSK), both ECDSA P-256 with SHA-256 (algorithm
`13`). The KSK is the one whose hash goes into the parent's DS record.

Generate the DS record from the KSK — this is what you give to your registrar
or publish in the parent zone:

```console
# dnssec-dsfromkey /var/cache/bind/keys/Kdnssec-lab.example.+013+06758.key
dnssec-lab.example. IN DS 6758 13 2 1D548D007BFE3C245A35691B77A0ADB9A34F7E4A0BAF52E38315FEBF3668FF0C
```

The `2` is the digest type (SHA-256). The long hex string is the hash of the
KSK's DNSKEY rdata.

Now every answer from the zone carries signatures. Query an A record with
`+dnssec`:

```console
# dig @127.0.0.1 -p 15353 www.dnssec-lab.example A +dnssec +noall +answer
www.dnssec-lab.example.  300  IN  A      192.0.2.100
www.dnssec-lab.example.  300  IN  RRSIG  A 13 3 300 20261102182703 20261012212032 12610 dnssec-lab.example. seFdliw1hffFqbe4PUW8yC7auJwtjDM0h6/SNJIbqF3SNnrYupvgot3U/+DvIgeS02hsKKXdxFZtYcMzAv1KQQ==
```

The RRSIG says: this A RRset was signed by key `12610` (the ZSK), with
algorithm `13`, and the signature is valid until `20261102182703`. If you tamper
with the IP address, the signature will no longer match.

For non-existent names, NSEC provides proof:

```console
# dig @127.0.0.1 -p 15353 nonexistent.dnssec-lab.example A +dnssec +noall +authority
dnssec-lab.example.  300  IN  NSEC  api.dnssec-lab.example. NS SOA RRSIG NSEC DNSKEY TYPE65534
dnssec-lab.example.  300  IN  RRSIG NSEC 13 2 300 20261102204709 20261012212032 12610 dnssec-lab.example. WD79OOv4u6o1QRae3rdSdtXtBnoAK9Un9mS2FCrXfsGhjbWUCW/1tUb5bAaH0RLeFNUzt18RUkdx7TXbkdZ+Zg==
```

The NSEC record at `dnssec-lab.example.` points to `api.dnssec-lab.example.`
as the next existing name, proving `nonexistent.dnssec-lab.example.` does not
exist. It is also signed — you cannot forge an NXDOMAIN without the ZSK.

## How DNSSEC Validation Works: The ad Flag

A validating resolver (like Cloudflare's `1.1.1.1` or Quad9's `9.9.9.9`) walks
the chain of trust from the root. If every signature checks out, it sets the
**authenticated data** (`ad`) flag in the response.

Query a real signed zone through a validating resolver:

```console
# dig @1.1.1.1 cloudflare.com A +dnssec +noall +answer
cloudflare.com.  102  IN  A      104.16.133.229
cloudflare.com.  102  IN  A      104.16.132.229
cloudflare.com.  102  IN  RRSIG  A 13 2 300 20261013232059 20261011212059 34505 cloudflare.com. CRZ11hpf69+l4qVHRkxS6Oglebm3yq20vvQCyihIbgvOGN12HaE5HniFuaXiMb6WTqmbplCc9MUTDE6Y+KTnNA==
```

The header says it all:

```
;; flags: qr rd ra ad; QUERY: 1, ANSWER: 3, ...
```

That `ad` flag means: the resolver verified the RRSIG against the zone's
DNSKEY, verified the DNSKEY against the DS in the parent, verified the DS
against the parent's DNSKEY, and so on up to the root. The chain held. The
answer is authenticated.

Another example with `internet.nl`:

```console
# dig @1.1.1.1 internet.nl A +dnssec +noall +answer
internet.nl.  3600  IN  A      62.204.66.10
internet.nl.  3600  IN  RRSIG  A 13 2 3600 20261022181337 20261008174412 22707 internet.nl. ZcI+3+M+SlioaOc7oNgB5hcSSD7k3OJv0BSzxtrW+cTAd2wzC5dswGTLAVnyKm5GOK33y+QYKocGO5cW0+36Aw==
```

Same story: `ad` flag, valid RRSIG, chain of trust intact.

## When DNSSEC Fails: SERVFAIL and Bogus

Now the part everyone should see at least once: what happens when the chain
breaks. I used `dnssec-failed.org`, a zone deliberately configured with a broken
DNSSEC chain so you can watch a validator reject it.

Query through a validating resolver (`1.1.1.1`):

```console
# dig @1.1.1.1 dnssec-failed.org A +dnssec +noall +comments +answer
;; ->>HEADER<<- opcode: QUERY, status: SERVFAIL, id: 57147
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, ...

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags: do; udp: 1232
; EDE: 9 (DNSKEY Missing): (no SEP matching the DS found for dnssec-failed.org.)
```

**SERVFAIL**. The resolver tried to validate, found a DS record in the parent
for `dnssec-failed.org`, but the zone's DNSKEY did not match that DS hash.
The chain is broken, so the resolver refuses to answer. The `EDE: 9` is an
Extended DNS Error code — `DNSKEY Missing` — telling you exactly why.

Now the critical contrast: query with the `+cd` (checking disabled) flag,
which tells the resolver to skip validation:

```console
# dig @1.1.1.1 dnssec-failed.org A +dnssec +cd +noall +comments +answer
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 65506
;; flags: qr rd ra cd; QUERY: 1, ANSWER: 2, ...

dnssec-failed.org.  300  IN  A      96.99.227.255
dnssec-failed.org.  300  IN  RRSIG  A 13 2 300 20261015015706 20261007225206 32784 dnssec-failed.org. na2euGmlBvOYfQ6l1qd9k6gzzAEMh7nI4wuIbjQJ5HoELOkd1ZuiMPqA1D+QEnBLepCjDkoK+PZ84UFOaF1wcA==
```

With `+cd`, you get the answer. The data is there, the RRSIG is there, but the
chain of trust does not verify. This is exactly what an attacker wants: they
can inject a fake zone with its own keys, and if you disable validation you
will believe it. DNSSEC validation is what stops that attack — and when it
fails, you get SERVFAIL, not a wrong answer.

## Why DNSSEC Is Operationally Painful

DNSSEC is simple in theory and brutal in practice. The failure modes are
unforgiving:

- **Key rollovers are a dance.** You must publish a new KSK, wait for the
  parent to publish the new DS, wait for the old DS to expire from caches,
  and only then remove the old key. Do it wrong and your zone disappears from
  every validating resolver on the internet. The key-event timers in BIND's
  `dnssec-policy` help, but you still have to understand the states.
- **Clock skew breaks everything.** RRSIGs are time-bound. If your server's
  clock is off by more than the signature validity window, validation fails.
  NTP is not optional — it is a DNSSEC dependency.
- **A broken zone takes down resolution.** Unlike a regular DNS misconfig
  (where you might get stale answers or NXDOMAIN), a DNSSEC failure produces
  SERVFAIL. Every client using a validating resolver cannot resolve your zone
  at all. There is no "partial degradation."
- **Parent coordination is a bottleneck.** If you run your own registrar or
  use a slow one, updating the DS record can take hours or days. During a
  key roll, that latency is on your critical path.
- **NSEC3 is complex.** It adds hashing, salt, and iteration parameters to
  prevent zone enumeration. Most people use NSEC (simpler, but reveals all
  names in the zone via walking).

## Should You Enable DNSSEC?

My honest take: **yes, if you run a public zone and can operate it carefully.**
The protection against DNS cache poisoning and zone hijacking is real. A
signed zone with a correct chain of trust means an attacker on the path
cannot forge your records without your private keys.

But go in with eyes open:

- If you cannot commit to key rollovers, NTP discipline, and DS record
  maintenance, an outage is not a matter of *if* but *when*.
- If your zone is internal-only (e.g., `home.lan`), DNSSEC is less critical —
  the threat model is different, and the operational burden may not be worth
  it.
- Always test with `dig +dnssec` and a validating resolver *before* you
  consider the rollout done. A DS record that does not match the KSK is a
  silent time bomb.

DNSSEC is not a set-and-forget feature. It is a commitment to cryptographic
key management for your most critical internet-facing service. Make that
commitment deliberately, with runbooks for key rollovers and a monitoring
alert for SERVFAIL spikes — because when DNSSEC breaks, it breaks loudly and
completely.
