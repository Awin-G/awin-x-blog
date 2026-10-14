---
title: "TLS OCSP stapling: certificate revocation without the privacy leak"
description: "How certificate revocation works: CRLs, OCSP queries and their privacy cost, ssl_stapling in nginx verified with s_client -status against a real Docker lab, Must-Staple, and why Let's Encrypt killing OCSP in 2025 changed everything."
pubDate: 2027-01-31
lang: en
translationKey: tls-ocsp-stapling
tags: [security, networking]
featured: false
keywords:
  - OCSP stapling
  - certificate revocation
  - ssl_stapling
  - CRL
  - Must-Staple
---

A certificate can be valid and *dead at the same time*. The dates check out,
the chain verifies, the browser shows you a padlock — and the CA revoked that
certificate last Tuesday because someone's key leaked. **Certificate
revocation** is how a CA unsays "valid" before the `notAfter` date, and almost
every mechanism for checking it has been a tradeoff between privacy, latency,
and honesty about failure. This post is about **OCSP stapling**, the trick that
moves the revocation check off the client's path, what it looks like when it
actually works, and the awkward 2026 truth: the largest CA on the internet
switched its OCSP off in 2025, so for many of us this is now a historical
feature. Everything command-line below was run for real — a throwaway nginx in
Docker with a real local CA and a real OCSP responder, plus the public sites I
check. The handshake itself I covered in [the TLS 1.3 handshake
post](/posts/tls-1-3-handshake/); renewal automation is in [automated TLS at
scale](/posts/automated-tls-at-scale/).

## Certificate revocation: the gap that expiry does not cover

Issuance is a promise: *this key, this name, until this date.* Revocation is
the CA withdrawing that promise early. The reasons are all things you have read
about in a postmortem: the private key leaked, the CA mis-issued, the domain
changed hands and the old owner must lose their certificate, a malware operation
listed a name briefly. A certificate that saying "valid" for five years is a
liability the moment something goes wrong in year one.

Two classic ways to answer "is this serial still good?":

- **CRL — Certificate Revocation List.** The CA publishes a signed file listing
  every serial it has revoked. The client downloads the list and searches it.
  One file, one signature, enormously cacheable — and it tells the CA only
  *that you are checking some certificate from that CA*, not which website you
  are visiting.
- **OCSP — Online Certificate Status Protocol.** The client asks the CA's
  responder, over HTTP, about one specific serial: `GET /ocsp?<serial>`.
  Small, fast, focused — and it tells the CA exactly which certificate you are
  validating, from which IP address, at what moment.

Neither mechanism makes the browser hard-fail. That detail matters more than
any of the protocol details, and I keep coming back to it.

## The OCSP privacy and latency problem

OCSP is precise, and it is a tracking rail. Every client that checks revocation
the naive way pings a CA-run HTTP endpoint *per site visit*. Even a CA that
promises not to log holds, at minimum, a real-time stream of (IP, certificate,
timestamp) triples. That is a browsing history, and if the CA is ever ordered to
record it, one suddenly exists. Let's Encrypt was blunt about it in their
[post-mortem of the decision](https://letsencrypt.org/2025/08/06/ocsp-service-has-reached-end-of-life/):
they ended OCSP *primarily* because it is a privacy risk. The scale they
published makes it visceral — at their peak they served about **340 billion
OCSP requests per month**, more than 140,000 requests per second at their CDN.

The second problem is latency. A client that wants to be sure *before* talking
must resolve and query the responder, wait for a signed response, and check its
dates — a full extra round trip before the "connection is secure" moment, plus
the trust-list dance of verifying the responder's signature. Do that for every
certificate in the chain and the "secure" message arrives meaningfully late.
Browsers resolved the tension by soft-failing: if the OCSP check does not come
back, proceed anyway. Which is to say, for the web as people use it, revocation
checking has been advisory for a very long time.

## OCSP stapling: let the server carry the answer

The fix inverts the direction of the request. The *server* fetches the OCSP
response for its own certificate from the CA responder — a background request
from a datacenter, on a timer, for exactly one serial — caches it, and attaches
it to the TLS handshake. The client announces support with the `status_request`
extension in its `ClientHello`, and the server answers with a
`CertificateStatus` message carrying the signed response. No client ever
touches a CA endpoint. No extra round trip for the user. The privacy leak
disappears because the interesting queries now come from the server, for itself,
in a pattern that reveals nothing about visitors.

<figure>
<svg viewBox="0 0 640 260" width="100%" role="img" aria-label="Two diagrams. With stapling, the server has already fetched the OCSP response and sends it inside the TLS handshake, so the client never contacts the CA. Without stapling, the client makes its own HTTP query to the CA's OCSP responder, revealing which site it is visiting, and pays an extra round trip.">
  <defs>
    <marker id="ocsp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
    <marker id="ocsp-arrow-dim" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="11" opacity="0.75">
    <text x="10" y="14">WITH STAPLING — server carries the answer</text>
    <text x="10" y="152">WITHOUT STAPLING — client asks the CA</text>
  </g>
  <g stroke="currentColor" fill="none" stroke-width="1.5" opacity="0.75">
    <rect x="10" y="30" width="120" height="40" rx="6"/>
    <rect x="330" y="24" width="170" height="52" rx="6"/>
    <rect x="330" y="140" width="170" height="40" rx="6"/>
    <rect x="470" y="184" width="160" height="52" rx="6" stroke-dasharray="5 4"/>
    <rect x="10" y="176" width="120" height="40" rx="6"/>
  </g>
  <g stroke="#0f766e" stroke-width="1.6" fill="none">
    <line x1="130" y1="44" x2="326" y2="44" marker-end="url(#ocsp-arrow)"/>
    <line x1="330" y1="66" x2="134" y2="66" marker-end="url(#ocsp-arrow)"/>
  </g>
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.6">
    <line x1="130" y1="190" x2="466" y2="200" marker-end="url(#ocsp-arrow-dim)"/>
    <line x1="470" y1="226" x2="134" y2="216" marker-end="url(#ocsp-arrow-dim)"/>
    <line x1="415" y1="76" x2="470" y2="182" stroke-dasharray="3 4" marker-end="url(#ocsp-arrow-dim)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11">
    <text x="36" y="54">client</text>
    <text x="368" y="44">server</text>
    <text x="36" y="200">client</text>
    <text x="398" y="164">CA OCSP</text>
    <text x="476" y="212">responder</text>
  </g>
  <g fill="#0f766e" font-family="system-ui, sans-serif" font-size="10.5">
    <text x="136" y="38">ClientHello (status_request)</text>
    <text x="136" y="60">Certificate + stapled OCSP response</text>
    <text x="330" y="102">no client → CA contact, no extra round trip</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="10.5" opacity="0.75">
    <text x="136" y="184">GET /ocsp?serial…</text>
    <text x="136" y="248">CA learns site + IP + time</text>
    <text x="330" y="140">— one extra round trip before the padlock —</text>
  </g>
</svg>
<figcaption>The whole idea: with OCSP stapling the server already fetched the response and mails it inside the handshake, so no visitor ever contacts the CA. Classic OCSP inverts the arrows — the client queries the responder itself, and every query is a data point about what you are visiting.</figcaption>
</figure>

Two honest caveats before the config tour:

- **Stapling is best-effort.** The client has no way to demand the response
  (unless Must-Staple is in play), so a broken staple config degrades to no
  information rather than a failure — the same soft-fail shape as before, minus
  the leak.
- **One serial, not the whole chain.** The stapled response covers the server's
  leaf certificate, because that is the one the server's config points at.
  Intermediate revocation is a gap in most of engineering practice.

## Must-Staple: the extension that was supposed to force the issue

OCSP stapling works only if the server bothers. **Must-Staple** was the attempt
to make it non-optional: a certificate extension (`tlsfeature`, OID
`1.3.6.1.5.5.7.1.24`) telling the client "this cert is only usable if the
handshake carries a stapled OCSP response". A client that sees the extension
and no response must refuse the connection. That finally turns revocation
checking from advisory into binding.

It was a good idea that died of ecosystem friction: browsers never shipped it
consistently, and a broken staple setup became a self-inflicted outage
generator — the certificate *demands* a response the server may fail to
deliver. Let's Encrypt, which supported it for years, called the experiment off
as part of ending OCSP: from **January 30, 2025** new Must-Staple requests
failed, and from **May 7, 2025** all requests carrying the extension failed,
including renewals.

## Enabling it in nginx: ssl_stapling, and the resolver nobody mentions

I ran all of this in a throwaway container — nginx, a local CA, an `openssl
ocsp` responder standing in for the CA's OCSP service — on a private network,
nothing privileged, cleaned up afterwards. The server certificate carries an
Authority Information Access extension with an OCSP URL, the way every real CA
issues them:

```bash
openssl x509 -in server.crt -noout -ocsp_uri
# http://ocsp-responder:18888/
```

The nginx side is four directives:

```nginx
server {
    listen 8443 ssl;
    server_name ocsp.lab.test;

    ssl_certificate     /certs/fullchain.crt;
    ssl_certificate_key /certs/server.key;

    # OCSP stapling: the server fetches the response, clients never do
    ssl_stapling on;
    ssl_stapling_verify on;
    ssl_trusted_certificate /certs/ca.crt;    # who to trust the stapled response from
    resolver 127.0.0.11 valid=10s;            # needed to resolve the responder hostname

    location / { return 200 "stapled handshake OK\n"; }
}
```

`ssl_stapling on` is the switch. `ssl_stapling_verify on` plus
`ssl_trusted_certificate` tell nginx whose signature on that response it should
trust, which matters: a stapled response is only worth something if the server
checked it. The `resolver` looks like boilerplate and is the single most common
reason a working-looking config staples nothing — nginx has to resolve the
responder's hostname with runtime DNS, and `/etc/hosts` does not count. Remove
it and nginx says exactly that, per certificate:

```
[warn] no resolver defined to resolve ocsp-responder while requesting certificate status,
       responder: ocsp-responder, certificate: "/certs/fullchain.crt"
```

With the responder up and the responder reachable, the handshake carries the
goods. Ask for it with `openssl s_client -status`:

```bash
openssl s_client -connect 127.0.0.1:9443 -servername ocsp.lab.test -status \
  -verifyCAfile ca.crt </dev/null 2>/dev/null | grep -A12 'OCSP responses'
```

```
OCSP responses: number of responses: 1
======================================
OCSP Response Data:
    OCSP Response Status: successful (0x0)
    Response Type: Basic OCSP Response
    Responder Id: CN = OCSP Lab Root
    Produced At: Oct 14 03:46:27 2026 GMT
    Responses:
    Certificate ID:
      Hash Algorithm: sha1
      Issuer Name Hash: F8841CF33301178E2F1BBBF06A22DBE129CAC9DD
      Issuer Key Hash: DEAA545A24EFE55F25A8F11B005B7C7ADF6C2D02
      Serial Number: 1BDBDA62843525B120330AE007C87477EDFAF6B8
    Cert Status: good
    This Update: Oct 14 03:46:27 2026 GMT
    Next Update: Oct 14 04:46:27 2026 GMT
    Signature Algorithm: sha256WithRSAEncryption
```

`Cert Status: good`, the serial matches the certificate just served, the
response is signed by the CA, and it carries `thisUpdate`/`nextUpdate` so
clients know its freshness window. Flip `ssl_stapling off;` — same certs, same
responder — and the client sees the absence:

```
OCSP responses: no responses sent
```

That single line is the entire lesson of stapling in two states. Two more
things I confirmed in the lab, both of which surprised me:

**nginx does not staple a revoked answer.** I flipped my local index to
`revoked` and nginx refused to send it:

```
[error] certificate status "revoked" in the OCSP response while requesting certificate status,
        responder: ocsp-responder, certificate: "/certs/fullchain.crt"
```

so a revoked-but-still-served certificate simply produces no response, and the
handshake continues. And **do not trust a restart**: after a cold start the
first fetch can miss, and in my runs the staple appeared only several seconds
after start. Verify with `s_client -status`, never with "it restarted fine".

## In the wild: what real certificates actually do in 2026

Theory time is over. Here is what public sites really serve today — same
commands I used above (`openssl x509 -noout -ocsp_uri` and `s_client -status`):

| host | issuer | OCSP URL in cert | server staples |
|---|---|---|---|
| aws.amazon.com | Amazon RSA 2048 M04 | yes (`ocsp.r2m04.amazontrust.com`) | **yes** |
| blog.awin-x.top | TrustAsia DV TLS RSA CA 2025 | yes (`ocsp.digicert.com`) | no |
| github.com | Sectigo | yes (`ocsp.sectigo.com`) | no |
| cloudflare.com | Google Trust Services WE1 | no | no |
| fastly.com | Certainly Intermediate R1 | no | no |
| letsencrypt.org | Let's Encrypt YE2 | no | no |

`aws.amazon.com` is the working case: a real stapled response with
`Cert Status: good` and a week-long freshness window:

```
OCSP responses: number of responses: 1
    Cert Status: good
    This Update: Oct 13 14:39:00 2026 GMT
    Next Update: Oct 20 13:39:00 2026 GMT
```

The blog you are reading is the cautionary case: its certificate *does* carry
an OCSP URL, and my own edge server still does not staple. This post's
to-do list just got one entry longer. The pattern across the table is the story
of 2025–2026: three of six certs have no OCSP URL at all. Let's Encrypt
announced the end of OCSP support in December 2024, dropped OCSP URLs from new
certificates on **May 7, 2025**, and turned the responders off on **August 6,
2025**. Revocation information from the largest CA on the web now travels
**exclusively via CRL**, browsers never broke, and stapling for those
certificates became unconfigured-by-design.

Which is why the honest conclusion is not "enable stapling". It is: check what
your certificate actually contains before configuring anything.
`openssl x509 -noout -ocsp_uri` prints nothing on a modern Let's Encrypt
certificate, because there is nothing to staple. The industry's bet has gone
the other way entirely — short-lived certificates, where a compromised key
expires anyway: Let's Encrypt shipped six-day certificates in January 2026,
cut default lifetimes to 45 days in late 2025, and announced 64-day defaults
for February 2027. A six-day certificate does not need revocation to be safe
for long, and the CRL a CA publishes for its long-lived intermediates stays a
single signed file on a CDN path.

## What I do on my own servers

1. **Ask the certificate first**: `openssl x509 -noout -ocsp_uri`. No URL
   means stapling is moot — spend the effort on renewal automation instead
   (that is the [automated TLS](/posts/automated-tls-at-scale/) half of the
   problem).
2. **If there is a URL**, the four directives are worth it: the privacy win for
   privacy-valuing clients is real, and it costs nothing at request time.
3. **Verify with `s_client -status`**, on a schedule, and alert when the
   response stops appearing — a staple that silently vanished is the classic
   resolver/fetch failure, and you will never notice from logs alone.
4. **Do not reach for Must-Staple.** It is dead at Let's Encrypt, unshipped
   across browsers, and its main legacy is the ability to turn one expired
   staple into an outage.

Revocation is the least satisfying corner of TLS: the mechanism that should
bind has been quietly advisory for a decade, and the CA that serves the largest
fraction of the web has decided the cleanest fix is to make certificates expire
quickly. Knowing both halves — the stapling config that still works with
OCSP-serving CAs, and the `openssl x509 -noout -ocsp_uri` that tells you
whether any of it applies to you — is most of what there is to know.
