---
title: "TLS certificate errors, explained — and how to fix each one"
description: "A field guide to the TLS certificate errors you actually hit: incomplete certificate chain, missing SNI, expired certificate, hostname mismatch, self-signed cert, clock skew, cipher mismatch, Let's Encrypt rate limits, and HSTS — with the openssl s_client command that proves each, and the fix."
pubDate: 2026-11-05
lang: en
translationKey: tls-errors-explained
tags: [security, networking, self-hosting]
featured: false
keywords:
  - TLS certificate error
  - openssl s_client
  - certificate chain
  - SNI
  - HSTS
---

Every **TLS certificate error** I have debugged in the last few years turned out
to be one of about ten things, and nearly all of them are visible from a single
**`openssl s_client`** command run from your laptop. The trick is knowing which
part of the output to read: a broken **certificate chain** and a missing **SNI**
name look completely different in the handshake, yet the browser collapses both
into the same unhelpful "your connection is not private". This is the field guide
I wish I'd had — the errors people actually hit, the command that proves each, and
the fix. If you are still wiring up issuance at all, start with my
[automated TLS](/posts/automated-tls-at-scale/) setup; this post is what to do
when it breaks.

## A TLS certificate error is a diagnosis, not a mystery

The browser is a terrible debugger. It folds expired certificates, missing
intermediates, wrong hostnames, and untrusted issuers into one red page. Reproduce
the failure from the command line, where the real TLS alert and the certificate
that caused it are printed in full — you can usually name the cause in under a
minute.

## Start with openssl s_client

`openssl s_client` opens a TLS connection and prints the negotiated protocol and
cipher, the full certificate chain, and the verification result. The flags that
matter: `-connect host:443` (where to connect), `-servername host` (send SNI),
`-showcerts` (dump the whole chain), and `-verify_return_error` (fail the
handshake on a verification error, so the exit code is scriptable).

```bash
# The one-liner I run first, on every TLS ticket
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top \
  -showcerts -verify_return_error </dev/null 2>&1 | head -60

# curl -v adds the client-side hostname check and verify result
curl -vI https://blog.awin-x.top/ 2>&1 | sed -n '1,40p'
```

## `unable to get local issuer certificate` and the incomplete certificate chain

**Symptom.** `curl: (60) ... unable to get local issuer certificate`, even though
the certificate is valid, current, and issued by a real CA — but only in `curl`,
or an old Android phone, or a Go service.

**Cause.** The server sends the leaf certificate and no intermediates. Desktop
browsers paper over this by fetching or caching the missing intermediate
themselves, which is why "it works in Chrome" tells you nothing.

**Proof.** `-showcerts` counts the certificates actually sent. If you see one,
that is the bug.

```bash
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top \
  -showcerts </dev/null 2>/dev/null | grep -c 'BEGIN CERTIFICATE'
```

**Fix.** Point the server at the *full* chain, not the leaf — in nginx,
`ssl_certificate` must be `fullchain.pem`, never `cert.pem` alone:

```nginx
ssl_certificate     /etc/letsencrypt/live/blog.awin-x.top/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/blog.awin-x.top/privkey.pem;
```

Then `nginx -t && systemctl reload nginx` and re-run the count; it should now be
2 or 3.

## Wrong or absent SNI: the default-server certificate mismatch

**Symptom.** A name connects but serves a certificate for a *different* domain —
usually your first vhost. Or an IP or internal health check gets the wrong cert.

**Cause.** **SNI** (RFC 6066) is how a client says which hostname it wants *before*
the handshake completes. Without it the server cannot pick a certificate, so it
serves its default vhost. This bites old clients, by-IP connections, and any name
that matches no `server_name`.

**Proof.** Ask for the name, then deliberately ask for none.

```bash
# With SNI: the certificate for blog.awin-x.top
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top </dev/null 2>/dev/null \
  | openssl x509 -noout -subject
# No SNI: you get the default server's certificate instead
openssl s_client -connect blog.awin-x.top:443 </dev/null 2>/dev/null \
  | openssl x509 -noout -subject
```

**Fix.** Always pass `-servername` when *testing* (that is a test fix, not a server
fix). On the server, make the mismatch visible: give every real name a
`server_name` with a matching certificate, and add a catch-all that rejects
unknown names instead of leaking the default cert.

```nginx
server {
    listen 443 ssl default_server;
    server_name _;
    ssl_certificate     /etc/ssl/self-signed-default.crt;
    ssl_certificate_key /etc/ssl/self-signed-default.key;
    return 444;
}
```

## `certificate has expired`

**Symptom.** `curl: (60) ... certificate has expired`, or an interstitial you
cannot click through. It worked yesterday.

**Cause.** `notAfter` is in the past. Almost never a forgotten manual renewal —
it is automated renewal failing *silently* for weeks while the old 90-day
certificate kept being served.

**Proof.**

```bash
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top </dev/null 2>/dev/null \
  | openssl x509 -noout -dates
# then find WHY renewal failed, on the box itself
sudo certbot renew --dry-run && sudo journalctl -u certbot.timer -n 50 --no-pager
```

**Fix.** Renew, then fix the *reason* it lapsed: an expired or rotated DNS API
token, a full disk, a renamed challenge path, or a timer missing on a rebuilt
host. The [automated TLS](/posts/automated-tls-at-scale/) flow exists to keep this
out of the manual pile — but automation without expiry monitoring just fails
later and louder.

## Hostname mismatch, SANs, and wildcard scope

**Symptom.** `curl: (60) ... no alternative certificate subject name matches
target host name`. The cert is valid and correctly chained — just not for *this*
name.

**Cause.** Modern clients ignore the old `CN` field and match only the
`subjectAltName` (SAN) list. Two classic traps: a certificate for `example.com`
asked to serve `www.example.com` (the apex does not cover the subdomain), and a
wildcard `*.example.com` that matches exactly one label — it covers
`api.example.com` but not `a.b.example.com`, and not the apex itself.

**Proof.**

```bash
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top </dev/null 2>/dev/null \
  | openssl x509 -noout -ext subjectAltName
```

**Fix.** Reissue with the exact name in the SAN list — often `example.com` *plus*
`*.example.com` in one certificate — and confirm `server_name` matches the vhost
that answers. Remember the one-label rule, then reload.

## `self signed certificate`

**Symptom.** `curl: (60) ... self signed certificate` (or "self signed
certificate in certificate chain").

**Cause.** Three situations produce the same message: a genuinely self-signed
cert (an internal service, dev box, router page); a private CA the client does not
trust; or a corporate middlebox intercepting TLS. Diagnose by the issuer.

```bash
openssl s_client -connect internal.example:443 -servername internal.example </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -fingerprint -sha256
```

**Fix.** If it is your own service behind a private CA, distribute that CA root to
clients (`update-ca-certificates`, or the macOS keychain) instead of teaching
everyone `curl -k`. Never disable verification to silence an error on anything
internet-reachable — that turns a lock into a decoration. If the issuer is neither
yours nor expected, treat it as possible interception and stop.

## Clock skew: the error with no certificate at fault

**Symptom.** Every certificate looks expired or "not yet valid", including ones
just issued. Fresh VMs and freshly flashed devices are the usual suspects.

**Cause.** TLS validates against the *client's* clock. A clock off by minutes or
days fails the `notBefore`/`notAfter` comparison even for a perfect certificate.

```bash
timedatectl status        # is "System clock synchronized: yes"?
date -u                   # compare against a known-good source
```

**Fix.** Run a time daemon (`systemd-timesyncd`, or `chrony` for tighter sync),
allow outbound NTP, and use `Persistent=true` on timers so a suspended box catches
up. Note timesyncd refuses to jump a wildly-off clock at boot — exactly when
RTC-less devices need it most.

## TLS version and cipher mismatch

**Symptom.** `error:0A000152:SSL routines::unsafe legacy renegotiation disabled`,
or an abrupt handshake failure with no certificate at all, or `no protocols
available`.

**Cause.** Client and server cannot agree on a protocol or cipher — usually an
old-TLS client hitting a server that now requires 1.2+, or a suite mismatch.

```bash
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top -tls1 </dev/null
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top </dev/null 2>/dev/null \
  | grep -E 'Protocol|Cipher'
```

**Fix.** Modernise the server, don't downgrade it: require TLS 1.2+
(`ssl_protocols TLSv1.2 TLSv1.3;` in nginx) and let TLS 1.3 choose the cipher. If
the *client* is the old thing, upgrade or isolate it.

## Let's Encrypt rate limits and ACME failures

**Symptom.** Issuance fails with `urn:ietf:params:acme:error:rateLimited`, "too
many failed authorizations", or a challenge that never validates.

**Cause.** Either a limit (50 new certs per registered domain per 7 days; 5 per
identical name set per 7 days; 5 failed authorizations per identifier per hour),
or the challenge itself failing — usually DNS-01 propagation, a wrong zone, or an
HTTP-01 path blocked by a proxy or CDN.

```bash
# Never hammer prod to debug; test against staging
sudo certbot renew --dry-run --server https://acme-staging-v02.api.letsencrypt.org/directory
# Audit what is already issued for your domain
curl -s 'https://crt.sh/?q=example.com&output=json' | head -c 500
```

**Fix.** Back off — every retry on a failing identifier resets the hourly failure
count. Fix the challenge (TTL/propagation, correct zone, port 80 reachable), test
on staging, and prefer one wildcard over DNS-01 over forty certificates. The
[rate-limit arithmetic](/posts/automated-tls-at-scale/) is laid out in full; the
short version is *never delete `/etc/letsencrypt` to "start clean"* unless you can
afford five per week.

## HSTS: when a TLS mistake becomes permanent

**Symptom.** Users cannot reach a subdomain at all; there is no "proceed anyway".
Fixing the certificate does not help browsers that already saw the policy.

**Cause.** **HSTS** tells the browser to refuse plain HTTP and refuse certificate
exceptions for a host, for a fixed max-age. With `includeSubDomains`, one header
on the apex covers *every* subdomain — so a single broken certificate bricks that
name for every visitor until max-age expires (or, for `preload`, a browser
update). HSTS turns a five-minute mistake into a monument.

```bash
curl -sSI https://blog.awin-x.top/ | grep -i strict-transport-security
```

**Fix.** Treat HSTS as a one-way door: start with a small `max-age` (say 300),
confirm every subdomain has a valid certificate, then lengthen it. Add
`includeSubDomains` only once every name under the apex is covered, and never
submit to preload until the policy has been stable for months.

## Prevention checklist

- **Automate renewal.** A twice-daily, jittered timer plus a deploy hook that
  reloads the service — the [automated TLS](/posts/automated-tls-at-scale/)
  pattern. Manual renewal is a future outage with a date on it.
- **Monitor expiry from outside.** An independent check from a *different* machine
  that alerts at ~14 days, so silent renewal failures surface before users see
  them.
- **Test from outside, with SNI.** Run `openssl s_client -servername` and `curl -v`
  against every public name from off-box, not just on the server itself.
- **Serve the full chain.** Point the server at `fullchain.pem` and verify with
  `-showcerts`.
- **Be deliberate with HSTS.** Small max-age first; `includeSubDomains` only when
  all names are covered; `preload` after months of stability.
- **Lock the box first.** A certificate is only as trustworthy as the server
  holding the key — start with the [public server hardening
  checklist](/posts/hardening-a-public-server/).

None of these errors are cryptographic mysteries. They are configuration, timing,
and automation — and each one announces itself in the first sixty lines of
`openssl s_client`. Read the handshake, name the cause, fix the config, then make
sure the fix cannot silently rot.
