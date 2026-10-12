---
title: "DNS zone transfers (AXFR): how they leak your whole zone — and how to stop it"
description: "A DNS zone transfer (AXFR) hands a stranger every hostname in your zone in one query. Real dig AXFR output against a lab BIND on 127.0.0.1, the real REFUSED after allow-transfer { none; }, TSIG-restricted secondary DNS, and NSEC3."
pubDate: 2027-01-07
lang: en
translationKey: dns-zone-transfer-axfr
tags: [networking, security]
featured: false
keywords:
  - DNS zone transfer
  - AXFR
  - allow-transfer
  - dig AXFR
  - zone enumeration
---

The most valuable DNS query I know is one line long: `dig AXFR`. It asks an
authoritative server for a **DNS zone transfer** — a complete copy of a zone —
and if the server is misconfigured, it answers. Not with one record. With the
SOA, every NS, every A, every CNAME, every SRV and TXT record it serves. I ran
exactly this against a throwaway BIND9 in Docker on `127.0.0.1:15353`, and then
ran it again after locking the server down, so you can see both the leak and the
real `REFUSED` you should be getting instead. Everything below is real output
from BIND 9.18.49 and dig 9.18.49.

**Authorised use only:** everything in this post applies to zones you own or
are contractually authorised to test. Run `dig AXFR` against your own
authoritative servers — that is the entire point of the checklist at the end.

## What a DNS zone transfer (AXFR) actually is

DNS is built so that a zone can live on more than one machine. The **primary**
(primary) holds the editable copy of the zone; **secondary DNS** servers keep
full replicas so the zone survives one box dying. The protocol that ships a
complete zone from primary to secondary is AXFR (RFC 5936): a single TCP
session on port 53 in which the server streams the entire zone, bookended by
the SOA record. The modern incremental variant, IXFR, ships only what changed
since a serial number — but if you want everything, AXFR is the request.

That design has a sharp edge. The same protocol operation that a secondary
uses to sync is available to *anyone* the server will talk to, unless you
explicitly restrict it. An open **AXFR** is not a misconfiguration of some
obscure feature — it is the default-ish state that survives "I copied a config
from a blog post," and internet-wide scanners probe for it constantly.

<figure>
<svg viewBox="0 0 640 210" width="100%" role="img" aria-label="A primary server holds the zone. A secondary requests an AXFR authenticated with a TSIG key and succeeds; an attacker requests a digest AXFR without the key and is refused.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.85">
    <rect x="225" y="30" width="190" height="64" rx="8"/>
    <rect x="470" y="34" width="150" height="56" rx="8"/>
    <rect x="20" y="130" width="150" height="56" rx="8"/>
    <path d="M470 62 H420" marker-end="url(#axfr-arrow)"/>
    <path d="M170 140 H225" stroke-dasharray="6 5" marker-end="url(#axfr-arrow)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12" text-anchor="middle">
    <text x="320" y="55" font-weight="600">primary ns1</text>
    <text x="320" y="75" opacity="0.75">allow-transfer { key }</text>
    <text x="545" y="57" font-weight="600">secondary ns2</text>
    <text x="545" y="77" opacity="0.75">holds TSIG key</text>
    <text x="95" y="153" font-weight="600">attacker</text>
    <text x="95" y="173" opacity="0.75">dig AXFR (no key)</text>
    <text x="445" y="50" opacity="0.9">AXFR + TSIG</text>
    <text x="197" y="130" opacity="0.9">REFUSED</text>
  </g>
  <defs>
    <marker id="axfr-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>
<figcaption>A zone transfer is legitimate traffic between machines that share a secret. Everyone else should get <code>REFUSED</code> — that is what <code>allow-transfer</code> is for.</figcaption>
</figure>

## The lab: a disposable BIND9 on 127.0.0.1:15353

No sudo, nothing exposed: a Debian container, BIND9 installed inside it, and
the host port published on loopback only. The zone file is the kind of small
"production" zone that leaks beautifully — it has internal-sounding names:

```text
; db.lab.example — the lab zone
$TTL 3600
@       IN  SOA ns1.lab.example. admin.lab.example. (
                2027010701 ; serial
                3600       ; refresh
                900        ; retry
                1209600    ; expire
                3600 )     ; minimum
@       IN  NS      ns1.lab.example.
@       IN  NS      ns2.lab.example.
@       IN  MX  10  mail.lab.example.
@       IN  A       203.0.113.10
www     IN  A       10.10.0.5
db      IN  A       10.10.0.6
replica IN  A       10.10.0.7
mail    IN  A       10.10.0.10
vpn     IN  A       10.10.0.25
git     IN  A       10.10.0.30
backup  IN  A       10.10.0.40
staging IN  CNAME   www.lab.example.
mon     IN  A       10.10.0.32
_sip._tcp IN SRV   10 5 5060 mail.lab.example.
```

The config for phase one is deliberately the wrong one — the line people copy
without thinking:

```text
// named-lab.conf — phase 1: open transfer, the bug
options {
    directory "/var/cache/bind";
    listen-on port 15353 { any; };   // dockerd publishes it on host 127.0.0.1 only
    listen-on-v6 { none; };
    recursion no;
    allow-query { any; };
};

zone "lab.example" IN {
    type master;
    file "/var/lib/bind/db.lab.example";
    allow-transfer { any; };   // <-- anyone may copy the whole zone
};
```

Start it, watch BIND load the zone — one SOA and one NS query first, so we can
confirm the server is authoritative (`aa` flag) before we try to copy it:

```text
$ dig @127.0.0.1 -p 15353 lab.example SOA +noall +answer
lab.example.		3600	IN	SOA	ns1.lab.example. admin.lab.example. 2027010701 3600 900 1209600 3600

$ dig @127.0.0.1 -p 15353 lab.example NS +noall +answer +additional
lab.example.		3600	IN	NS	ns1.lab.example.
lab.example.		3600	IN	NS	ns2.lab.example.
ns1.lab.example.	3600	IN	A	10.10.0.53
ns2.lab.example.	3600	IN	A	10.20.0.53
```

Note the two NS records and the glue: even the boring query already tells an
attacker how many name servers the zone has and where they live.

## dig AXFR: the whole zone in one query

Now the attack query. One TCP connection, one response stream:

```text
$ dig AXFR @127.0.0.1 -p 15353 lab.example
; <<>> DiG 9.18.49-1~deb12u2-Debian <<>> AXFR @127.0.0.1 -p 15353 lab.example
; (1 server found)
;; global options: +cmd
lab.example.		3600	IN	SOA	ns1.lab.example. admin.lab.example. 2027010701 3600 900 1209600 3600
lab.example.		3600	IN	NS	ns1.lab.example.
lab.example.		3600	IN	NS	ns2.lab.example.
lab.example.		3600	IN	MX	10 mail.lab.example.
lab.example.		3600	IN	TXT	"v=spf1 mx -all"
lab.example.		3600	IN	A	203.0.113.10
_sip._tcp.lab.example.	3600	IN	SRV	10 5 5060 mail.lab.example.
api.lab.example.	3600	IN	CNAME	www.lab.example.
backup.lab.example.	3600	IN	A	10.10.0.40
ci.lab.example.		3600	IN	CNAME	git.lab.example.
db.lab.example.		3600	IN	A	10.10.0.6
git.lab.example.	3600	IN	A	10.10.0.30
mail.lab.example.	3600	IN	A	10.10.0.10
mon.lab.example.	3600	IN	A	10.10.0.32
ns1.lab.example.	3600	IN	A	10.10.0.53
ns2.lab.example.	3600	IN	A	10.20.0.53
replica.lab.example.	3600	IN	A	10.10.0.7
staging.lab.example.	3600	IN	CNAME	www.lab.example.
vpn.lab.example.	3600	IN	A	10.10.0.25
www.lab.example.	3600	IN	A	10.10.0.5
lab.example.		3600	IN	SOA	ns1.lab.example. admin.lab.example. 2027010701 3600 900 1209600 3600
;; Query time: 1 msec
;; SERVER: 127.0.0.1#15353(127.0.0.1) (TCP)
;; WHEN: Mon Oct 12 19:48:23 UTC 2026
;; XFR size: 21 records (messages 1, bytes 554)
```

Twenty-one records, one query, 554 bytes. That is the entire attack surface of
my naming scheme, delivered in a millisecond. No brute force, no rate limits
tripped, no alerting on the client side.

## Why an open AXFR is a reconnaissance gift

**Zone enumeration** from that output is a one-liner — every A and CNAME owner
name, plucked out and sorted:

```text
$ dig AXFR @127.0.0.1 -p 15353 lab.example \
    | grep -E '^[a-z0-9_.-]+[[:space:]]+[0-9]+[[:space:]]+IN[[:space:]]+(A|CNAME|MX)[[:space:]]' \
    | awk '{print $1}' | sed 's/\.lab\.example\.$//' | sort -u
api
backup
ci
db
git
lab.example.
mail
mon
ns1
ns2
replica
staging
vpn
www
```

Read that list as an attacker. `vpn`, `db`, `replica`, `backup`, `git`,
`staging` — I just learned which services exist, which hosts are probably
internal, and a short target list for the *next* phase: scanning those IPs,
guessing credentials on `vpn`, phishing `staging.lab.example` (staging
environments are famously the weakest link), or feeding the names into a
credential-stuffing list. Two AXFRs taken hours apart also diff nicely on the
SOA serial (`2027010701`) and let someone see when your zone changes and what
appeared — a free change-detection feed.

And the `ANY` query? Historically the "give me everything at this name" side
channel, still worth understanding:

```text
$ dig @127.0.0.1 -p 15353 lab.example ANY +noall +answer
lab.example.		3600	IN	SOA	ns1.lab.example. admin.lab.example. 2027010701 3600 900 1209600 3600
lab.example.		3600	IN	NS	ns2.lab.example.
lab.example.		3600	IN	NS	ns1.lab.example.
lab.example.		3600	IN	MX	10 mail.lab.example.
lab.example.		3600	IN	TXT	"v=spf1 mx -all"
lab.example.		3600	IN	A	203.0.113.10
```

Useful, but per-name only — `ANY` on the apex cannot discover
`vpn.lab.example`. Modern providers also increasingly answer `ANY` with a
minimal RFC 8482 response, so it is an unreliable recon tool. **AXFR remains
the one query that returns the whole zone, which is exactly why its ACL is the
control that matters.**

## Locking it down: allow-transfer in BIND

The fix in BIND9 is one line. I changed `allow-transfer { any; }` to
`allow-transfer { none; }`, re-checked the config, and restarted:

```text
# named-checkconf /etc/bind/named-lab.conf && rndc reconfig   (or restart named)

$ dig AXFR @127.0.0.1 -p 15353 lab.example
; <<>> DiG 9.18.49-1~deb12u2-Debian <<>> AXFR @127.0.0.1 -p 15353 lab.example
; (1 server found)
;; global options: +cmd
; Transfer failed.
```

`; Transfer failed.` — the real refusal. With the comments switched on you can
see *why*, including the modern Extended DNS Error:

```text
$ dig AXFR @127.0.0.1 -p 15353 lab.example +noall +comments
;; ->>HEADER<<- opcode: QUERY, status: REFUSED, id: 51765
;; flags: qr; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1
; EDE: 18 (Prohibited)
; Transfer failed.
```

The server side says the same thing in the log — this is the line you should
be grepping your own name servers for:

```text
12-Oct-2026 19:49:14.046 error: client @0x7f4a97c20c98 172.17.0.1#50606 (lab.example): zone transfer 'lab.example/AXFR/IN' denied
```

And ordinary resolution is completely unaffected — the restriction applies to
transfers, not queries:

```text
$ dig @127.0.0.1 -p 15353 www.lab.example A +short
10.10.0.5
```

Two belt-and-braces notes. First, AXFR is TCP-only, so the firewall equivalent
of this ACL is: allow inbound tcp/53 from your secondaries' addresses and
nowhere else. Second, `allow-transfer { none; }` is the correct setting the
moment you stop running secondaries — a surprising number of zones are served
by exactly one machine and never needed the door open at all.

## TSIG: secondary DNS without the open door

If you *do* run a secondary, the modern pattern is **notify + TSIG**: the
primary notifies the secondary that the serial changed, and the transfer is
authenticated with a shared HMAC key, so the door opens only for the holder. I
generated a real throwaway key on the lab server:

```text
$ tsig-keygen -a hmac-sha256 axfr-lab
key "axfr-lab" {
	algorithm hmac-sha256;
	secret "DR+b53nkSQGqRgDX/YfJ2H4hks2JC1AUmdoxDBNsBvY=";
};
```

That key block goes into the config, and the zone clause changes to accept
only that identity:

```text
key "axfr-lab" {
    algorithm hmac-sha256;
    secret "DR+b53nkSQGqRgDX/YfJ2H4hks2JC1AUmdoxDBNsBvY=";
};

zone "lab.example" IN {
    type master;
    file "/var/lib/bind/db.lab.example";
    allow-transfer { key "axfr-lab"; };   // the secondary, authenticated — nobody else
};
```

The same `dig AXFR` from before now fails even though the server allows
transfers in principle — the request is unauthenticated:

```text
$ dig AXFR @127.0.0.1 -p 15353 lab.example +noall +comments
;; ->>HEADER<<- opcode: QUERY, status: REFUSED, id: 7835
; EDE: 18 (Prohibited)
; Transfer failed.
```

Point dig at the same server with the key (`-y
hmac-sha256:axfr-lab:<secret>`) and the transfer succeeds. The other daemons
express the same policy in their own dialect. NSD:

```text
# nsd.conf — NSD equivalent
zone:
    name: "lab.example"
    zonefile: "lab.example"
    provide-xfr: 10.20.0.53 axfr-lab        # that secondary, that key, nothing else
```

Knot DNS:

```yaml
# knot.conf — Knot equivalent
zone:
  - domain: lab.example
    file: "lab.example.zone"
    acl:
      - id: secondary-xfr
        address: [10.20.0.53]
        action: transfer
        key: axfr-lab
```

If you have never touched NSD or Knot: the shape is identical — a named key
(TSIG), a named peer, and a rule that grants `transfer` to that peer and
default-denies everyone else. Rotate the key on a schedule and store it in
whatever secret manager you already use; a TSIG secret in an Ansible repo is a
bad day waiting to happen.

## If the zone is DNSSEC-signed, the transfer carries signatures too

People sometimes assume DNSSEC makes this moot. It does not — DNSSEC proves
what the zone *contains*, it does not decide who may *copy* it. To make that
concrete I re-signed the lab zone with BIND's inline signing and an NSEC3
chain:

```text
dnssec-policy lab-nsec3 {
    keys { csk lifetime unlimited algorithm ecdsap256sha256; };
    nsec3param iterations 8 salt-length 6;
};

zone "lab.example" IN {
    type master;
    file "/var/lib/bind/db.lab.example";
    inline-signing yes;
    dnssec-policy lab-nsec3;
    allow-transfer { key "axfr-lab"; };
};
```

The authenticated AXFR then returns the signed view — DNSKEY, RRSIGs over
every RRset, an NSEC3PARAM and the full NSEC3 chain, with the message itself
carrying a TSIG signature:

```text
lab.example.		3600	IN	DNSKEY	257 3 13 HgSx1zqU0doyyQF+R5l8tsHhhKLheL/+AhSaLooVJjqe0yD9icq8jd+2 ...
lab.example.		0	IN	NSEC3PARAM 1 0 8 F65EB0CD4453
6RNEG2MMDM9GVIGODBA49DS7E35K7S51.lab.example. 3600 IN NSEC3 1 0 8 F65EB0CD4453 A5H8P1E4NAF5NGMU6PC521IVMTCQGJ59 A NS SOA MX TXT RRSIG DNSKEY NSEC3PARAM TYPE65534
V640UOA1PU45U1443HA1HOQB0FIK5BU7.lab.example. 3600 IN NSEC3 1 0 8 F65EB0CD4453 0P634D8KK6PS0BI63BA0UL0LAGRSQQ6O A RRSIG
axfr-lab.		0	ANY	TSIG	hmac-sha256. 1791834757 300 32 w1YoDEoU9AqFWGYqQiPnOasQglAxo1oXOS/D9avRoyE= ...
;; XFR size: 78 records (messages 1, bytes 6208)
```

Worth knowing what NSEC3 buys and costs. It replaces NSEC's plaintext "next
name" chain with hashed owner names, so a validating resolver asking for a name
that does not exist gets a cryptographic NXDOMAIN proof:

```text
$ dig @127.0.0.1 -p 15353 nope.lab.example A +dnssec +noall +authority
lab.example.		3600	IN	SOA	ns1.lab.example. admin.lab.example. 2027010712 3600 900 1209600 3600
lab.example.		3600	IN	RRSIG	SOA 13 2 3600 20261026195223 20261012185223 19342 lab.example. ...
48FU8OQCKV4R8PKTA8RRM0P8PALGUL6P.lab.example. 3600 IN NSEC3 1 0 8 F65EB0CD4453 6RNEG2MMDM9GVIGODBA49DS7E35K7S51 A NS SOA MX TXT RRSIG DNSKEY NSEC3PARAM TYPE65534
```

NSEC3 salt plus hashing slows casual zone-walking, but once someone has the
zone — remember, from the AXFR above — the whole chain is right there, and the
signing keys are what DNSSEC actually protects. The lesson stands: transfer
ACLs and DNSSEC are orthogonal controls, and you need both.

## What modern practice actually looks like

Concretely, what I would tell a colleague with a zone to protect:

- **No secondaries? Leave the door closed.** `allow-transfer { none; }` on
  BIND, no `provide-xfr` in NSD, no `transfer` ACL in Knot. Let your DNS
  provider or registrar run the redundancy — that is the job you are paying
  them for.
- **Secondaries? Notify + TSIG only.** The primary notifies known secondaries
  and transfers only to keyed, IP-pinned peers. Never `any`.
- **Hidden primary pattern.** Public NS records point at your secondaries; the
  primary is reachable only from them, with transfers restricted to their keys.
  This is how most serious operators do it.
- **Watch the logs.** An AXFR denial from an unknown address is reconnaissance
  hitting your zone. A *successful* AXFR from anything that is not your
  secondary is an incident. Keep date-based serials so IXFR works and secondaries
  re-sync quickly.
- **DNSSEC on top, not instead.** Signing is orthogonal to transfer control.

## How to check your own zones (authorised testing only)

For every zone you run, from a machine you control:

```text
# 1. who serves this zone?
dig NS lab.example +short            # your own zone, never someone else's

# 2. can anyone AXFR it?
dig AXFR @<your-primary> <your-zone>
#   expect:  ; Transfer failed.   / status: REFUSED
#   if you get records: fix allow-transfer today

# 3. if a secondary is legitimate, verify the TSIG path works
dig -y hmac-sha256:<keyname>:<secret> AXFR @<your-primary> <your-zone>
```

One `dig`, one second, and you know. If step 2 hands you records, that is the
whole article: any scanner on the internet can run the exact same command
against your IP right now.

## Cleanup

The lab left nothing behind:

```bash
docker rm -f axfr-srv axfr-client
```

## What I take away

AXFR exists so a zone can live on more than one machine, and that is a feature
worth having — right up to the moment `allow-transfer { any; }` ships your
entire host inventory to whoever asks. Run a lab BIND once and watch
`dig AXFR` succeed, then flip one line to `allow-transfer { none; }` and watch
the real `REFUSED` come back. Once you have seen both, you will never trust a
copied config again. (For the other half of the picture — how the recursive side
of DNS works — see [how DNS actually resolves](/posts/how-dns-resolves/) and my
notes on [running your own recursive resolver](/posts/self-hosted-dns-resolver/).)
