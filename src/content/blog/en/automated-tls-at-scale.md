---
title: "Automated TLS for many subdomains: ACME, HTTP-01 vs DNS-01, and wildcards"
description: "How I run automated TLS for dozens of subdomains: the ACME flow, HTTP-01 vs DNS-01 challenge tradeoffs, wildcard certificates with safe DNS credentials, renewal hooks, systemd timers, monitoring, rate limits, and the failure modes that actually bite."
pubDate: 2026-10-25
lang: en
translationKey: automated-tls-at-scale
tags: [self-hosting, nginx, devops, security]
featured: false
keywords:
  - automated TLS
  - ACME DNS-01
  - wildcard certificate
  - certbot
  - renewal hook
---

One domain, one certificate: run certbot once, answer the prompt, forget it. That
works until you have thirty subdomains across five services, a wildcard for the
names you spin up on a whim, and a renewal that has to keep working while you
sleep. At that point the problem stops being "get a certificate" and becomes
"keep every certificate valid, on time, with no human in the loop". This is how I
run **automated TLS** with **ACME**: why I chose the **DNS-01 challenge** over
HTTP-01, how I keep the **wildcard certificate** and its DNS credentials from
becoming the weakest link, and how I notice when it breaks. It assumes nginx as
the front door — the setup in my
[self-hosting without Docker](/posts/self-hosting-without-docker/) post, on a box
hardened with the [public server checklist](/posts/hardening-a-public-server/).

## Why manual certificates fail at scale

Manual issuance works fine for one or two names. Let's Encrypt certificates last
90 days, so at that size you renew by hand a few times a year and nothing goes
wrong. At thirty names across five vhosts, plus staging, plus a couple of
internal-only names, the arithmetic changes: roughly four renewals per year per
certificate, multiplied by the number of certificates, and each one is a chance
to forget.

The failures are never cryptographic. They are operational:

- Nobody remembers which SANs were on last year's certificate.
- A name gets added to nginx but never to the renewal line.
- A renewal is "temporarily" disabled while debugging and never re-enabled.
- The machine that used to renew it got rebuilt, and the cron entry didn't come
  along.

The only sustainable answer is automation that knows the inventory, can prove
control of names without a human, and shouts when it fails.

## The ACME flow in one screen

ACME (RFC 8555) is the protocol Let's Encrypt speaks, and it is what your client
does behind the scenes:

1. **Account** — the client generates an account key and registers with the CA.
2. **Order** — it requests a certificate for a specific set of names.
3. **Challenges** — the CA returns one challenge per name (`http-01`, `dns-01`,
   or `tls-alpn-01`).
4. **Fulfill** — the client proves control of each name.
5. **Validate** — the CA checks the proof.
6. **Finalize** — the client submits a CSR, the CA issues, the client downloads
   the certificate and chain.

Everything after step 1 is scriptable, which is the whole point: if there is a
human step in your ACME flow, that step is the bug. Most clients also keep local
state that doubles as your inventory:

```ini
# /etc/letsencrypt/renewal/blog.example.com.conf — the inventory, in a file
[renewalparams]
account = a1b2c3d4e5f6
authenticator = dns-cloudflare
dns_cloudflare_credentials = /etc/letsencrypt/cloudflare.ini
server = https://acme-v02.api.letsencrypt.org/directory
[[webroot_map]]
```

`certbot certificates` prints the same list in human form. Keep the authoritative
list in config management though, because a client config is a terrible source of
truth.

## HTTP-01 vs DNS-01 challenge: the real tradeoffs

The challenge type you pick decides everything downstream.

**HTTP-01** has the CA fetch `http://<name>/.well-known/acme-challenge/<token>`.
It requires port 80 reachable from the internet for that name, so every name
needs DNS *and* routing to the box answering. It cannot issue a wildcard. On the
plus side, it needs no stored secret.

**DNS-01** has the client write a TXT record at `_acme-challenge.<name>` and the
CA query DNS. No inbound port at all. It works behind NAT, on a host that only
listens on 443, on a box with no public IP, and for internal-only names. It is
the only method that issues wildcards. The cost is real: you hand the client an
API credential that can edit your DNS.

| | HTTP-01 | DNS-01 |
|---|---|---|
| Inbound port 80 | required | not required |
| Wildcard certificate | no | yes |
| Secret to store | none | DNS provider API token |
| Failure surface | firewall, proxy, CDN, redirects | propagation, TTL, provider API, wrong zone |
| Internal-only names | no | yes |
| Time to renew | seconds | seconds to minutes |

My rule of thumb: use HTTP-01 for a single public web server where nginx already
answers on port 80; use DNS-01 when you need wildcards, when port 80 is closed,
or when the name does not point at this machine. Note that HTTP-01 tolerates a
redirect to HTTPS — the CA follows it. What it does not tolerate is port 80
firewalled off, or a CDN intercepting the challenge path.

## Wildcard certificate with DNS-01 (and where the risk lives)

A wildcard `*.example.com` covers `api.example.com` but **not** `example.com`
itself, and not `a.b.example.com`. So the certificate I usually ask for is
`example.com` plus `*.example.com`: apex and one label, in one file.

Two consequences matter:

- **Blast radius.** One certificate means one private key for every subdomain. If
  that key leaks, everything behind the wildcard leaks with it.
- **Distribution.** Every host that terminates TLS for a subdomain needs the same
  key material, and your deploy hook has to copy it again on every renewal. That
  is more places for it to leak.

So a wildcard is a convenience, not a default. For a handful of names on one
machine, an explicit SAN certificate is often safer. Choose the tradeoff
deliberately.

## Keeping DNS-01 credentials safe

The token that can create `_acme-challenge` records can also redirect your mail,
take over the zone, or issue certificates you didn't ask for. Treat it as a
production secret:

- **Scope it.** Use a token limited to DNS edit on that one zone, not an
  account-wide key, and never the registrar's global API key.
- **One credential per zone**, so a single leak cannot take down everything.
- **File permissions.** Root-owned, `0600`, outside version control.
- **Prefer systemd credentials** (`LoadCredential=`) over a plaintext file on
  disk; the secret is then only visible to that one unit.
- **Rotate and revoke** on any suspicion, and after it leaves your hands.
- **Consider CNAME delegation** to a purpose-built service like `acme-dns`, so
  the ACME client holds a credential good for exactly one `_acme-challenge`
  record and nothing else.

```bash
# /etc/letsencrypt/cloudflare.ini — root-owned, 0600, never in git
sudo install -m 600 -o root -g root /dev/null /etc/letsencrypt/cloudflare.ini
sudo tee /etc/letsencrypt/cloudflare.ini >/dev/null <<'EOF'
# Token scoped to Zone:DNS:Edit on example.com ONLY
dns_cloudflare_api_token = 0123456789abcdef_CHANGEME
EOF
sudo chmod 600 /etc/letsencrypt/cloudflare.ini
```

## Renewal: hooks, systemd timers, and why "set and forget" needs monitoring

Renewal is two problems. The first is getting a fresh certificate; the client
handles that. The second is making running services pick it up. nginx reads
certificates at load time, so a renewed file on disk does nothing until you
reload. Mail and proxy daemons may pin certs in memory and need their own reload.

certbot ships a twice-daily systemd timer, and a deploy hook runs only after a
*successful* renewal — not on every attempt:

```bash
#!/usr/bin/env bash
# /etc/letsencrypt/renewal-hooks/deploy/reload-tls.sh  →  chmod +x
set -euo pipefail
# certbot exports RENEWED_LINEAGE and RENEWED_DOMAINS for the hook
test -n "${RENEWED_LINEAGE:-}" || exit 0
nginx -t
systemctl reload nginx
for unit in haproxy.service dovecot.service; do
  if systemctl is-active --quiet "$unit"; then systemctl reload "$unit"; fi
done
logger -t tls-deploy "renewed ${RENEWED_DOMAINS:-unknown}"
```

`lego` does the same thing. In v5 the flag is `--deploy-hook`; older versions
call it `--run-hook` / `--renew-hook`:

```bash
lego --path /etc/lego --email ops@example.com --dns cloudflare \
  -d example.com -d '*.example.com' --accept-tos \
  --deploy-hook /usr/local/bin/reload-tls.sh run
```

If your client has no timer, add one. The jitter matters: a fleet that renews at
exactly `03:00:00` stampedes the CA and hits rate limits.

```ini
# /etc/systemd/system/tls-renew.service
[Unit]
Description=Renew TLS certificates
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/lego --path /etc/lego --email ops@example.com \
  --dns cloudflare -d example.com -d '*.example.com' --accept-tos \
  --deploy-hook /usr/local/bin/reload-tls.sh run
```

```ini
# /etc/systemd/system/tls-renew.timer
[Unit]
Description=Twice-daily TLS renewal check

[Timer]
OnCalendar=*-*-* 03,15:17:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
```

The part everyone skips is monitoring, because automated renewal fails
*silently*: a rotated API token, a changed DNS provider, a full disk, and the
service keeps serving yesterday's certificate until one morning it doesn't. A
monthly `certbot renew --dry-run` plus an independent external check that does
not trust the client:

```bash
#!/usr/bin/env bash
# check-cert-expiry.sh <hostname> — alert inside the warning window
set -euo pipefail
name="$1"; warn_days=14
not_after=$(openssl s_client -connect "$name:443" -servername "$name" </dev/null 2>/dev/null \
  | openssl x509 -noout -enddate | cut -d= -f2)
end=$(date -d "$not_after" +%s); now=$(date +%s)
days=$(( (end - now) / 86400 ))
if [ "$days" -lt "$warn_days" ]; then
  echo "TLS WARNING: $name expires in ${days}d ($not_after)"
  exit 1
fi
echo "ok: $name has ${days}d left"
```

Run it from a *different* machine or region, and point it at every hostname you
serve — not just the certificate's primary name. The local client will always
think everything is fine.

## Rate limits: the thing that bites you at scale

Let's Encrypt's limits are generous until you are testing in a loop. The ones
that matter:

- **50 new certificates per registered domain per 7 days** (global, across all
  accounts).
- **5 per exact same set of identifiers per 7 days** — the one you hit by
  reinstalling your client, or by deleting `/etc/letsencrypt` on every deploy.
- **300 new orders per account per 3 hours.**
- **5 failed authorizations per identifier per hour.**

Renewals that reuse the same name set are treated leniently, and clients that
speak ACME Renewal Information (ARI) are exempt from the issuance limits
entirely. Practical rules: test against staging, batch SANs into fewer
certificates instead of one per name, keep client state on disk, and prefer one
wildcard over forty individual certs. `crt.sh` will show you what has already
been issued for your domain when you are auditing a mistake.

## Failure modes I've actually hit

- **Expired certificate.** The renewal unit had been failing for weeks. The
  deploy hook's reload worked fine — there was simply nothing new to deploy.
  Monitoring would have caught it in a day; nothing else did.
- **Wrong `server_name` / default server.** When SNI does not match any
  `server_name`, nginx serves the *first* server block, so a browser gets the
  wrong certificate for that name. Add a catch-all `server` that returns `444`
  so misconfigured names fail visibly instead of quietly serving someone else's
  cert.
- **Chain issues.** Pointing nginx at the leaf certificate instead of
  `fullchain.pem` breaks older Android and some `curl`. Use the full chain, and
  `--preferred-chain` when a CA offers a chain whose root old clients don't have.
- **HSTS as an amplifier.** With `includeSubDomains`, one broken certificate on a
  subdomain becomes an error users cannot click through, and you can no longer
  fall back to HTTP. Enable `includeSubDomains` only after every subdomain is
  covered, and don't `preload` until you have lived with it for a while.
- **Clock skew.** Wrong time makes validation fail for no apparent reason. Run
  `systemd-timesyncd` and check `timedatectl`.

```bash
curl -sSI https://blog.awin-x.top | head -1
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top </dev/null \
  | openssl x509 -noout -subject -issuer -dates
sudo nginx -T | grep -nE 'server_name|ssl_certificate'
```

## What I actually run: automated TLS, end to end

The stack, concretely: one `lego` binary, DNS-01 through the provider plugin, one
certificate per zone covering `example.com` and `*.example.com`, credentials
delivered with `LoadCredential`, a deploy hook that validates and reloads nginx,
a twice-daily jittered timer, and an external expiry check at 14 days that alerts
me before users ever see a warning.

```bash
#!/usr/bin/env bash
# /usr/local/bin/lego-issue.sh — ExecStart of tls-renew.service
set -euo pipefail
# the token comes from the unit's LoadCredential, not from disk
export CLOUDFLARE_DNS_API_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/cf")"
exec /usr/bin/lego --path /etc/lego --email ops@example.com \
  --dns cloudflare --domains example.com --domains '*.example.com' \
  --accept-tos --deploy-hook /usr/local/bin/reload-tls.sh run
```

None of this is exotic. The payoff is that adding subdomain number forty-one
costs one DNS record and nothing else — no certificate request, no ticket, no
reminder on a calendar. That is what automated TLS is supposed to feel like. If
you have not locked down the box yet, start with the
[hardening checklist](/posts/hardening-a-public-server/) first; a certificate is
only as trustworthy as the server holding the key.
