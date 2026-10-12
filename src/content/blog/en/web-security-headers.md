---
title: "Web security headers explained: CSP, HSTS, and the nginx add_header trap"
description: "A practical guide to the security headers a static site needs: HSTS and its includeSubDomains footgun, a strict Content-Security-Policy, X-Content-Type-Options, Referrer-Policy, frame-ancestors, Permissions-Policy, and CORS — plus the nginx add_header trap and how to test it."
pubDate: 2026-11-14
lang: en
translationKey: web-security-headers
tags: [security, nginx, networking]
featured: false
keywords:
  - security headers
  - Content-Security-Policy
  - HSTS
  - nginx add_header
  - Referrer-Policy
---

**Security headers** are the cheapest hardening you will ever ship. They are a
dozen lines in your nginx config, they cost nothing at runtime, and they close
whole classes of browser-side bugs: session hijacking over plaintext,
cross-site scripting, clickjacking, MIME confusion, referrer leaks, and a
third-party script quietly asking for your camera. A strict
**Content-Security-Policy** is the one that does the most work, but the boring
ones earn their keep too. And yet most static sites ship one or two, or think
they are covered because their CDN added `X-Content-Type-Options` for them.

This is the set I actually run on this blog, what each header defends against,
and the nginx trap that silently disables half of them the moment you touch a
`location` block.

## What security headers actually defend against

A response header is a set of instructions the **browser** follows. It does not
stop your server being scanned, and it does not protect a client that ignores
it — `curl` reads `Content-Security-Policy` and shrugs. What headers do is
constrain what a compliant browser is allowed to do with *your* pages and
content once it has them. That makes them defense in depth: when your app has a
bug, the browser refuses to turn that bug into an exploit.

Two rules before the list:

- **A header protects users of your site, not your site.** Nothing here makes
  your server harder to attack. That is [server hardening](/posts/hardening-a-public-server/),
  firewalls, and patching.
- **Headers are additive across layers.** If you are behind a CDN or reverse
  proxy, decide once where each header is set, or you will end up with two
  `Content-Security-Policy` headers, and browsers apply the **intersection** —
  which is usually the strictest and most surprising combination.

## HSTS: Strict-Transport-Security

HSTS tells the browser: for the next `max-age` seconds, never speak plain HTTP
to this host again — rewrite `http://` links, refuse certificate-error
click-throughs. It defends against **SSL stripping**, where an attacker on the
path downgrades your first request to HTTP and steals the session before TLS
ever starts. Without HSTS, the browser has no memory of your HTTPS preference,
so every fresh visit is downgradeable.

```nginx
add_header Strict-Transport-Security "max-age=31536000" always;
```

That is a reasonable starting point: one year, this host only. Two options make
it powerful, and both are footguns on a first deploy.

- **`includeSubDomains`** applies the policy to *every* subdomain. The instant a
  browser sees it, any subdomain that cannot serve a valid HTTPS certificate
  becomes effectively unreachable — the browser will not fall back to HTTP. If
  `dev.example.com` or an old `mail.example.com` only does HTTP, you just broke
  it for anyone who visited your main site. Audit your subdomains first.
- **`preload`** asks browsers to ship your domain in a hardcoded list, so even
  the *first* visit is HTTPS-only. It also requires `includeSubDomains` and a
  `max-age` of at least one year. Removal is not instant: you submit a request
  and wait months for browsers to ship a new list. Treat preload as a one-way
  door.

My advice: ship `max-age` alone, watch the logs, and only add
`includeSubDomains` once you have proven every subdomain serves HTTPS. Add
`preload` last, deliberately, and submit at `hstspreload.org` when you are sure.
If you are still fighting certificate errors, fix those first — see
[TLS errors explained](/posts/tls-errors-explained/).

## Content-Security-Policy: start strict, loosen with evidence

**CSP** is the header that does the heavy lifting. It is an allowlist of where
the browser may load scripts, styles, fonts, images, and frames from, and what
it may connect to. The point is not to trust your markup; it is to make an
injected `<script>` fail. A cross-site scripting bug that would run attacker
code runs into `script-src` and dies.

The mistake is starting loose, because loose CSP is security theater.
`script-src 'unsafe-inline' 'unsafe-eval' *` allows everything and stops
nothing. Start from a policy a **no-JS static site** can actually satisfy:

```nginx
add_header Content-Security-Policy "default-src 'none'; \
  base-uri 'none'; form-action 'none'; frame-ancestors 'none'; \
  img-src 'self' data:; style-src 'self'; font-src 'self'; \
  manifest-src 'self'; connect-src 'none'; \
  script-src 'none'; object-src 'none'; upgrade-insecure-requests" always;
```

Read it as: nothing by default; no `<base>` rewriting, no forms, no framing;
images, styles, fonts, and the web manifest only from my own origin (plus
`data:` images, which many sites need); no `fetch`/XHR; and crucially **no
scripts at all**. If your site truly ships no JavaScript, `script-src 'none'`
is the strongest single line in this post — an injected script cannot run, full
stop.

If you do ship JavaScript, add its origin and stop guessing:

```nginx
# Astro's own island bundles, served from the same origin
script-src 'self';
```

For any inline script you cannot move to a file, use a **nonce** or a **hash**
rather than `'unsafe-inline'`. Modern frameworks can emit nonces per request;
if yours cannot, hash the inline block and list it in `script-src`. Deploy in
two steps: first `Content-Security-Policy-Report-Only` (browsers report
violations without enforcing), read the reports, then flip the same string to
the enforcing header. Also note that CSP with a **sandbox** or
`frame-ancestors` cannot be delivered in a `<meta>` tag — it has to be a real
HTTP header.

## X-Content-Type-Options: nosniff

Browsers try to be helpful: if a response is labelled `text/plain` but the bytes
look like HTML, some will "sniff" and render it anyway. That turns an innocuous
user-uploaded `.txt` into stored XSS. `nosniff` forbids the guess.

```nginx
add_header X-Content-Type-Options "nosniff" always;
```

Pair it with correct `Content-Type` on every response — `nosniff` makes a
missing or wrong type fail *loudly* instead of being guessed at, which is what
you want.

## Referrer-Policy

The `Referer` header leaks where a visitor came from, including full URLs with
tokens or query strings, to every third party the page touches. `Referrer-Policy`
decides how much is sent.

```nginx
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

That default sends the full URL for same-origin requests and only the bare
origin (`https://example.com/`) cross-origin, and nothing at all over a
downgrade from HTTPS to HTTP. It is the sensible modern default.
`no-referrer` is stricter and breaks nothing except sites that rely on referrer
for analytics or hotlink protection; use it if you want zero leakage.

## X-Frame-Options and CSP frame-ancestors

Clickjacking is framing your page invisibly under an attacker's UI so a click
lands on your "delete account" button. Two headers stop it. `X-Frame-Options`
is the old one; `frame-ancestors` in CSP is the modern, expressive one.

```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
# frame-ancestors 'none' is already set in the CSP above
```

Use `SAMEORIGIN` if you frame your own pages, `DENY` if you never do.
`frame-ancestors` supersedes it in modern browsers and lets you allow specific
origins; keep `X-Frame-Options` as a belt for older ones. Do not set both to
conflicting values, or you get the surprise intersection again.

## Permissions-Policy

Powerful browser features — camera, microphone, geolocation, and more — are on
unless you turn them off. `Permissions-Policy` (formerly `Feature-Policy`) is
how you turn them off, both for your own page and for anything you embed.

```nginx
add_header Permissions-Policy "geolocation=(), camera=(), microphone=(), payment=(), usb=()" always;
```

For a content blog the honest answer is to deny everything you do not use — it
is a one-line guarantee that no script, yours or injected, can reach the
sensors. If you embed a map or a video player, allow only the specific
origin: `geolocation=(self "https://maps.example.com")`.

## CORS: what it is and what it isn't

**CORS** is the most misunderstood item here, so be blunt about it: it is a
**browser** rule, not a server access-control mechanism.
`Access-Control-Allow-Origin` does not protect your data. `curl`, a script, or
a server can read your endpoint no matter what you set. What CORS does is tell a
browser whether JavaScript on *another* origin may **read** the response it
made. It is a relaxation mechanism, not a wall.

A static site usually needs CORS for exactly nothing — same-origin assets need
no header. You touch it when a font, a JSON API, or a widget is loaded
cross-origin. Two things to get right:

- `Access-Control-Allow-Origin: *` and `credentials: include` are mutually
  excluded; if you need cookies, you must name the exact origin and add
  `Access-Control-Allow-Credentials: true`. Never echo back arbitrary origins
  from the request.
- Non-simple requests trigger a **preflight** `OPTIONS` request; your server
  must answer it (`Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`)
  or the real request never happens.

If you want to genuinely restrict who can read data, that is authentication
and authorization, not CORS.

## The nginx add_header inheritance trap

Here is the trap that makes people think headers "don't work". In nginx,
`add_header` inherits from the outer block **only if the inner block has no
`add_header` of its own**. The moment you add a single `add_header` inside a
`location`, it **cancels every `add_header` inherited from `server`** in that
location.

```nginx
server {
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;

    location /assets/ {
        # This single line wipes HSTS and nosniff for /assets/*.
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}
```

Requests to `/assets/*` get `Cache-Control` and **none** of the security
headers. Nothing warns you; it just silently drops them. The same applies one
level deeper in nested `location` blocks, and it is the number-one reason a
`securityheaders.com` scan comes back with an A on `/` and a D on some asset.

The fix is to stop repeating yourself: put the security headers in a snippet and
`include` it in **every** block that defines its own `add_header`.

```nginx
# /etc/nginx/snippets/security-headers.conf
add_header Strict-Transport-Security "max-age=31536000" always;
add_header Content-Security-Policy "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self'; font-src 'self'; manifest-src 'self'; connect-src 'none'; script-src 'none'; object-src 'none'; upgrade-insecure-requests" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Permissions-Policy "geolocation=(), camera=(), microphone=(), payment=(), usb=()" always;
```

```nginx
server {
    server_name example.com;
    server_tokens off;

    include snippets/security-headers.conf;

    location /assets/ {
        include snippets/security-headers.conf;    # re-include, or you lose them
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}
```

The `always` parameter matters too: without it, nginx adds a header only on
2xx, 3xx, 204 and 304 responses, so your security headers vanish on a 404 or
500 — exactly when an attacker probing your error pages would like them gone.
`include` at every level plus `always` is the whole fix. One snippet, no drift.

## How to test it

Check with `curl` first, because it tells you the truth without a browser:

```bash
curl -sI https://example.com | grep -iE \
  'strict-transport|content-security|x-content-type|referrer|x-frame|permissions'

# test a 404 and a nested asset too — the add_header trap hides there
curl -sI https://example.com/assets/app.js | grep -iE 'strict-transport|x-content-type'
curl -sI https://example.com/does-not-exist | grep -iE 'strict-transport'
```

Then use the scanners as a second opinion: `securityheaders.com` and Mozilla
Observatory grade the headers on a URL, and `hstspreload.org` will tell you
whether your HSTS is preload-eligible. Finally, open devtools → Console with a
CSP in Report-Only mode and click through your own site: any blocked inline
script shows up as a violation you can fix before enforcing.

## Frequently asked questions

**Do I need all of these on a static blog?** HSTS, `nosniff`,
`Referrer-Policy`, `frame-ancestors`, and a strict CSP cover ~95% of the value.
`Permissions-Policy` is nearly free. CORS you probably do not need at all.

**Will CSP break my site?** Only if you enforce it before testing. Run
Report-Only first, read the violations, then enforce the same policy.

**Is HSTS preload worth the commitment?** For a stable domain with HTTPS on every
subdomain, yes. For anything experimental, no — removal takes months.

**Why do my headers disappear on some paths?** Almost always the `add_header`
inheritance rule above. `curl -I` the exact path and confirm.

Ship the snippet, verify with `curl -I` on more than one path, and move on. The
whole thing is an afternoon, once, and then it keeps working.
