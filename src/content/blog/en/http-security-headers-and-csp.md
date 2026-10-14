---
title: "Content-Security-Policy and security headers that actually do something"
description: "A deep-dive into Content-Security-Policy (CSP): a real before/after header diff in throwaway nginx containers, how CSP nonces and hashes beat 'unsafe-inline', how frame-ancestors stops clickjacking, how Report-Only mode lets you test without breaking your site, and a copy-paste starting set for a static site."
pubDate: 2027-02-04
lang: en
translationKey: http-security-headers-and-csp
tags: [security, nginx]
featured: false
keywords:
  - Content-Security-Policy
  - security headers
  - CSP nonce
  - HSTS
  - Report-Only
---

Security headers are the cheapest hardening you will ever ship — a dozen lines
in nginx, zero runtime cost, and they close whole classes of browser-side bugs.
I already covered the basics (HSTS, `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy`, `frame-ancestors`) in
[web security headers explained](/posts/web-security-headers/). This is the
deeper **Content-Security-Policy (CSP)** follow-up: the one header that does the
heavy lifting, the one that is genuinely hard to get right, and the one where
most sites either do nothing or ship a policy so loose it's security theatre.

I ran every example below in throwaway Docker containers on `127.0.0.1` with
`nginx:1.27-alpine`. No sudo, no privileged mode, no host installs. Every
`curl -i` block is real output from those containers.

## What security headers are (in 30 seconds)

A security header is a **response header the browser enforces**. Your server
sends it; the browser — not your app — decides what to do with it. `curl` reads
`Content-Security-Policy` and shrugs; Chrome reads it and refuses to execute an
injected `<script>`. That is the whole value proposition: when your app has a
bug (and it will), the browser refuses to turn that bug into an exploit.

The headers worth setting on a static site:

- **`Strict-Transport-Security`** (HSTS) — force HTTPS, block SSL stripping.
- **`X-Content-Type-Options: nosniff`** — stop MIME-sniffing XSS.
- **`Referrer-Policy`** — control referrer leakage.
- **`Permissions-Policy`** — revoke camera/mic/geolocation by default.
- **`Content-Security-Policy`** — the big one; CSP nonce, hashes, and
  `frame-ancestors`.
- **`X-Frame-Options`** / CSP `frame-ancestors` — stop clickjacking.

All of them are one-liners in nginx. The hard part is CSP.

## The before/after header diff (real output)

Here is what a bare nginx server returns with no security headers configured —
just the standard transport metadata:

```bash
$ curl -si http://127.0.0.1:18099/ | head -12
HTTP/1.1 200 OK
Server: nginx/1.27.5
Date: Wed, 14 Oct 2026 04:32:31 GMT
Content-Type: text/html
Content-Length: 615
Last-Modified: Wed, 16 Apr 2025 12:55:34 GMT
Connection: keep-alive
ETag: "67ffa8c6-267"
Accept-Ranges: bytes
```

Now the same server with six `add_header` directives. Everything below the
`Accept-Ranges` line is new — that is the entire cost of the hardening:

```bash
$ curl -si http://127.0.0.1:18099/ | head -20
HTTP/1.1 200 OK
Server: nginx/1.27.5
Date: Wed, 14 Oct 2026 04:33:42 GMT
Content-Type: text/html
Content-Length: 472
Last-Modified: Wed, 14 Oct 2026 04:32:45 GMT
Connection: keep-alive
ETag: "6acf05ed-1d8"
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=(), usb=()
X-Frame-Options: SAMEORIGIN
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
Accept-Ranges: bytes
```

That is it. One config reload, and the browser now enforces every one of those
lines on every page load. The rest of this post is about the CSP line — what it
means, how to test it without breaking your site, and how to handle the pain
points (inline scripts, third-party widgets, `'unsafe-inline'` creep).

## CSP in depth: `default-src`, `script-src`, and the inline script problem

CSP is an allowlist. `default-src 'self'` means "by default, load everything
only from my own origin." `script-src 'self'` means "execute JavaScript only
from my own origin." A `<script>` tag that does not match `script-src` is
**blocked by the browser** — not by your server, not by your framework, by the
browser itself.

Here is the problem every site hits immediately: **inline scripts**. If your
HTML contains `<script>alert('x')</script>`, a CSP with `script-src 'self'`
blocks it. The browser console says:

```
Refused to execute inline script because it violates the following Content
Security Policy directive: "script-src 'self'". Either the 'unsafe-inline'
keyword, a hash, or a nonce is required to enable inline execution.
```

That error is CSP working correctly. It means an attacker who manages to inject
`<script>` into your page — via a comment field, a URL parameter stored and
rendered later, a third-party widget — gets the same refusal.

Here is a real demonstration. The test page has an inline script:

```html
<script>
    document.addEventListener('DOMContentLoaded', function() {
        document.getElementById('msg').textContent = 'Inline script executed successfully!';
    });
</script>
```

With `script-src 'self'` (no `'unsafe-inline'`), the browser blocks the inline
script. With `script-src 'self' 'unsafe-inline'`, it runs. The header diff:

```bash
# BLOCKS inline script — the CSP line:
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'

# ALLOWS inline script — the CSP line:
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

### CSP nonce: the right way to allow inline scripts

A **nonce** is a per-request random value. Your server generates it, puts it in
the CSP header, and adds it as an attribute to the script tag:

```
Content-Security-Policy: script-src 'nonce-r4nd0m123'
```

```html
<script nonce="r4nd0m123">console.log('this runs');</script>
```

An attacker cannot guess the nonce, so even if they inject a `<script>` tag, it
does not have the nonce attribute and the browser blocks it. This is the
correct way to allow inline scripts.

### CSP hash: the way for static inline scripts

If your inline script is static (same bytes every time), you can hash it and
list the hash in `script-src`. The browser hashes the inline script content and
checks it against the allowlist:

```
Content-Security-Policy: script-src 'sha256-base64hash=='
```

This is safer than `'unsafe-inline'` (an attacker cannot inject arbitrary code)
but more fragile than a nonce — any change to the inline script bytes changes
the hash and breaks it. Nonces are the modern default; hashes are the fallback
for static sites with no server-side nonce generation.

## `frame-ancestors`: the clickjacking defence that is not `X-Frame-Options`

`X-Frame-Options: SAMEORIGIN` is the old way to stop clickjacking. CSP's
`frame-ancestors` directive is the modern replacement, and it is strictly better:

- `X-Frame-Options` can only say `DENY`, `SAMEORIGIN`, or one origin.
- `frame-ancestors` can list multiple origins, use wildcards, and is part of
  the same CSP policy as everything else.

```
# Old: one header, three possible values
X-Frame-Options: SAMEORIGIN

# Modern: in your CSP
frame-ancestors 'none';           # never framed (equivalent to DENY)
frame-ancestors 'self';          # only framed by same origin
frame-ancestors https://app.example.com;  # framed only by that origin
```

If you set both `X-Frame-Options` and `frame-ancestors`, modern browsers use
`frame-ancestors` and ignore `X-Frame-Options`. Keep both for older browsers
that do not support `frame-ancestors`, but do not set them to conflicting
values.

## Report-Only mode: test CSP without breaking your site

Enforcing a new CSP on a live site is a recipe for breaking something. The
answer is `Content-Security-Policy-Report-Only` — same syntax, same directives,
but the browser **reports violations instead of blocking them**:

```bash
$ curl -si http://127.0.0.1:18099/report.html | grep -i 'content-security'
Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; report-uri /csp-report
```

The page loads normally, inline scripts run, but every violation is reported to
the `report-uri` endpoint. You read the reports, fix the real issues, and only
then flip the header from `Content-Security-Policy-Report-Only` to
`Content-Security-Policy`. That is the rollout:

1. Deploy in Report-Only mode.
2. Browse your own site, click every page, check the reports.
3. Fix every violation (move scripts to files, add nonces, adjust `script-src`).
4. Flip to enforcing mode.

## The honest pain of CSP

CSP is the security header that actually does something, and that is exactly
why it is painful:

- **Inline scripts** — every CMS plugin, every analytics snippet, every
  third-party widget wants to inject inline JavaScript. You either refactor to
  external files, use nonces, or weaken the policy with `'unsafe-inline'`.
- **Third-party widgets** — a chat widget or a map embed needs its origin in
  `frame-src`, `script-src`, `style-src`, `img-src`, `connect-src`. Every
  directive is a place where you can accidentally allow too much.
- **`'unsafe-inline'` creep** — one developer adds it to make a script work,
  the next developer copies that pattern, and six months later your CSP is
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' https:` — which is security
  theatre. The fix is to never use `'unsafe-inline'` in `script-src` and to
  enforce code review on CSP changes.
- **Headers do not fix a vulnerable app** — CSP is defence in depth. If your
  app has an SQL injection, CSP will not save you. If your app has a stored
  XSS, CSP makes it significantly harder for the attacker, but it does not
  patch the bug. Fix the app first; CSP is the seatbelt, not the airbag.

## A copy-paste starting set for a static site

Here is a reasonable CSP for a static site that serves its own assets and does
not embed third-party widgets. Adjust `img-src` and `font-src` if you use
external fonts or images:

```nginx
add_header Strict-Transport-Security "max-age=31536000" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "geolocation=(), camera=(), microphone=(), payment=(), usb=()" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" always;
```

If you need to allow inline scripts during a transition, add a nonce (not
`'unsafe-inline'`):

```nginx
# Generate nonce per request in your app; this is the pattern, not a literal value
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'nonce-{PER_REQUEST}'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" always;
```

Deploy that in Report-Only mode first. Read the reports. Then enforce.

## Verify with curl, then with a browser

```bash
# Check the headers are present
curl -si https://example.com/ | grep -iE \
  'strict-transport|content-security|x-content-type|referrer|x-frame|permissions'

# Check CSP-Report-Only does NOT block (should show the Report-Only header, not enforcing)
curl -si https://example.com/ | grep -i 'content-security-policy-report-only'

# Check CSP IS enforcing (should show the enforcing header)
curl -si https://example.com/ | grep -i '^content-security-policy:'
```

Then open the browser console and click through your own site. Any blocked
inline script shows up as a CSP violation you can fix before enforcing.

## The bottom line

CSP is the security header that actually does something. It is also the one
that requires the most care. Run Report-Only first, use nonces instead of
`'unsafe-inline'`, prefer `frame-ancestors` over `X-Frame-Options`, and treat
every CSP violation in the console as a real bug. The before/after diff above
is the whole cost: six lines in nginx, and the browser starts enforcing them
on every request.

For the full list of security headers and the `add_header` inheritance trap,
see [web security headers explained](/posts/web-security-headers/) and the
[nginx cookbook](/posts/nginx-cookbook/).
