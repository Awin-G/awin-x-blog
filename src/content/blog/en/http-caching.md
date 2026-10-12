---
title: "HTTP caching explained: Cache-Control, ETag, and why users see stale pages"
description: "A practical walk through HTTP caching: browser, CDN and reverse-proxy layers and who obeys whom, the Cache-Control directives that matter, ETag/Last-Modified validators, the 304 round trip, the classic no-cache misreading, cache busting vs revalidation, Vary and cookies, and a working nginx config."
pubDate: 2026-11-27
lang: en
translationKey: http-caching
tags: [networking, nginx, devops]
featured: false
keywords:
  - HTTP caching
  - Cache-Control
  - ETag
  - 304 Not Modified
  - cache busting
---

Users see stale pages for one of two reasons: either nobody told the browser to revalidate, or somebody *did* and a layer in the middle ignored it. **HTTP caching** is the mechanism behind both — the same set of response headers that makes your site feel instant also makes it feel broken when they are wrong. The confusing part is that caching is not one thing. It is a stack, and each layer has its own opinion about what it is allowed to keep.

This is the mental model I actually use, the `Cache-Control` directives that matter, how `ETag` turns a stale cache hit into a cheap **304 Not Modified**, and the nginx config I run for this blog. If you are also fighting TLS-level surprises, the same request path is walked in [TLS 1.3 in one handshake](/posts/tls-1-3-handshake/); caching sits on top of that handshake.

## The layers of HTTP caching, and who obeys whom

There is no single cache. A request can be answered by the browser's own cache, a CDN edge near the user, a reverse proxy like nginx on your box, or finally the origin. Each layer is independent, and a response passes through all of them on the way out, collecting their decisions.

<figure>
<svg viewBox="0 0 680 200" width="100%" role="img" aria-label="A request path crossing four cache layers: the browser cache, a CDN edge, a reverse proxy such as nginx, and the origin. Each layer may answer from its own stored copy; Cache-Control directives on the response tell each layer independently whether it may store and whether it must revalidate.">
  <defs>
    <marker id="hcf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.7">
    <rect x="10" y="52" width="130" height="56" rx="8"/>
    <rect x="180" y="52" width="130" height="56" rx="8"/>
    <rect x="350" y="52" width="130" height="56" rx="8"/>
    <rect x="520" y="52" width="150" height="56" rx="8"/>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none">
    <line x1="140" y1="70" x2="178" y2="70" marker-end="url(#hcf-arrow)"/>
    <line x1="310" y1="70" x2="348" y2="70" marker-end="url(#hcf-arrow)"/>
    <line x1="480" y1="70" x2="518" y2="70" marker-end="url(#hcf-arrow)"/>
    <line x1="518" y1="92" x2="482" y2="92" marker-end="url(#hcf-arrow)"/>
    <line x1="348" y1="92" x2="312" y2="92" marker-end="url(#hcf-arrow)"/>
    <line x1="178" y1="92" x2="142" y2="92" marker-end="url(#hcf-arrow)"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13">
    <text x="75" y="78" text-anchor="middle">browser</text>
    <text x="245" y="78" text-anchor="middle">CDN edge</text>
    <text x="415" y="78" text-anchor="middle">nginx</text>
    <text x="595" y="78" text-anchor="middle">origin app</text>
    <text x="75" y="98" text-anchor="middle" opacity="0.7">private cache</text>
    <text x="245" y="98" text-anchor="middle" opacity="0.7">shared cache</text>
    <text x="415" y="98" text-anchor="middle" opacity="0.7">shared cache</text>
    <text x="595" y="98" text-anchor="middle" opacity="0.7">source of truth</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5" opacity="0.8">
    <text x="340" y="140" text-anchor="middle">request flows right; the response flows left and each layer decides for itself whether to keep it</text>
    <text x="340" y="162" text-anchor="middle"><tspan font-family="ui-monospace, monospace">no-store</tspan> forbids storing · <tspan font-family="ui-monospace, monospace">private</tspan> locks out every shared cache on the way</text>
  </g>
</svg>
<figcaption>The browser cache is private and belongs to one user; CDN and reverse-proxy caches are shared and serve many users. `Cache-Control` speaks to each of them separately, which is why one header can be right for the CDN and wrong for the browser.</figcaption>
</figure>

The rule that untangles most confusion: **the response headers travel with the response**. The origin sets the policy, and every layer downstream reads it. A `private` directive tells the CDN and the proxy "hands off"; a `no-store` tells everyone not to keep a copy at all. But layers only obey what they can see — if a header is dropped or overwritten in transit, the layer below never hears the instruction.

## Cache-Control directives that actually matter

Almost everything you need is a handful of directives on one header. There are more, but these are the ones that decide whether you have a bug.

- **`max-age=N`** — the copy is fresh for N seconds; until then, a cache may serve it without asking anyone. This is the browser's clock.
- **`s-maxage=N`** — same idea, but for **shared** caches (CDN, proxy) only. It overrides `max-age` for them, so you can let an edge hold an asset for a day while browsers hold it for an hour.
- **`no-cache`** — the most misread directive in the spec. It does *not* mean "do not cache". It means "cache it, but you must **revalidate** before reusing it". The copy is stored; it is just never served without a check.
- **`no-store`** — the real "do not cache". Nothing is written to disk or memory, anywhere. Use it for secrets and responses that must never resurface.
- **`public`** — may be stored even by a shared cache. Mostly explicit rather than load-bearing, but it is what allows a CDN to keep a response that is otherwise ambiguous.
- **`private`** — the response is for one user; shared caches must not store it. This is what protects a page rendered with someone's name on it.
- **`immutable`** — while fresh, do not revalidate even on a user reload. This is the directive that stops a browser from re-asking about a fingerprinted asset it already has.
- **`must-revalidate`** — once stale, a cache may not use the copy without checking with the origin. Good belt-and-braces for anything correctness-sensitive.

A typical static site reaches for exactly three combinations: long-lived immutable assets, short-lived HTML that revalidates, and feeds that are somewhere between.

## Validators: ETag, Last-Modified, and the 304 Not Modified

Freshness has two phases. While a response is *fresh* (inside `max-age`), no one asks the origin. Once it is *stale*, the interesting part happens: the cache turns a full download into a question, and the origin answers "nothing changed" — that is a **304 Not Modified**.

A validator is a fingerprint the origin attaches to a response so a cache can ask "is this still yours?":

- **`ETag`** — an opaque token for this exact version of the body, often a hash or an inode-size-mtime triple. Any change to the body should change the ETag.
- **`Last-Modified`** — the modification timestamp. Cheaper for the server, but only second-resolution and easy to fool by editing a file at the same second.

The cache stores the validator beside the body and, once stale, sends it back in a conditional request. If it matches, the origin replies `304` with no body — saving the download, not the round trip. Here is the whole exchange, headers and all:

```http
# 1. First request — origin returns the body plus its validators
GET /posts/http-caching/ HTTP/1.1
Host: blog.awin-x.top

HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Cache-Control: public, max-age=0, must-revalidate
ETag: "8f3a1c2e9b"
Last-Modified: Wed, 26 Nov 2026 18:04:11 GMT
```

```http
# 2. Later, the copy is stale — the cache asks instead of re-downloading
GET /posts/http-caching/ HTTP/1.1
Host: blog.awin-x.top
If-None-Match: "8f3a1c2e9b"
If-Modified-Since: Wed, 26 Nov 2026 18:04:11 GMT

HTTP/1.1 304 Not Modified
Cache-Control: public, max-age=0, must-revalidate
ETag: "8f3a1c2e9b"
Last-Modified: Wed, 26 Nov 2026 18:04:11 GMT
# no body — reuse what you already have
```

Two details earn their keep. `If-None-Match` (the `ETag` check) **wins over** `If-Modified-Since` when both are sent, so trust the ETag. And the `304` still carries `Cache-Control`, which lets you update the freshness window without resending the body. That is why revalidating HTML feels instant even though it technically talks to the server: the answer is a few hundred bytes of headers, not the whole page.

## The classic no-cache misreading

Every few months someone "fixes" a stale page by adding `Cache-Control: no-cache`, sees it still cached, and concludes caching is broken. It is not. `no-cache` is a **revalidation** instruction, not an eviction one. The response *is* stored — it just must be checked before every reuse. If you wanted "never keep this", you wanted `no-store`.

The trap is that these two read as synonyms in English and behave nothing alike:

```http
Cache-Control: no-cache   # store it, but revalidate every single time
Cache-Control: no-store   # do not store it anywhere, ever
```

`no-cache` is exactly right for HTML you want fresh but still cheap to serve: the browser keeps a copy, asks with `If-None-Match`, and gets a `304` when nothing changed. `no-store` is right for a bank statement or an authenticated response that must not sit in a shared cache. Pick the one that matches the intent, not the one that sounds stricter.

One more reading hazard: `max-age=0, must-revalidate` and `no-cache` are near twins in practice — both force a check on every use — but the first also lets an HTTP/1.0 cache that understands `must-revalidate` behave, while the second is the clearer modern spelling.

## Cache busting for assets, revalidation for HTML

The tension in a static site is real: you want assets cached forever for speed, but the moment you change one it must be picked up immediately. The fix is not a shorter cache lifetime — that is slow and still imprecise. The fix is **cache busting**: change the *URL* when the content changes.

Every build hashes the file and puts the hash in the name (`app.4f9c2a1b.js`). The file is now content-addressed, so it can be cached for a year and marked `immutable` safely — a new build produces a new name, and the old one simply stops being referenced.

```nginx
# fingerprinted assets: the name changes when the bytes change, so cache hard
location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
}
```

HTML is the opposite. Its URL is stable — `/posts/http-caching/` — so it can never be renamed, and it is the thing users actually need to see current. Serve it with a zero or very short `max-age` plus `must-revalidate`, and lean on `ETag` to keep the revalidation cheap:

```nginx
# HTML keeps a stable URL, so revalidate on every use instead of renaming it
location ~* \.html$ {
    add_header Cache-Control "public, max-age=0, must-revalidate";
}
```

Feeds land in between: short freshness because a reader eventually wants the new items, but not so short that a polling client hammers the origin.

The payoff is a system where a deploy ships instantly (the HTML points at new asset names) while every byte the user already downloaded stays cached. That property is what makes the deploys in [zero-downtime deploys on one box](/posts/zero-downtime-deploys/) feel instant to a returning visitor.

## Vary and cookies: why a logged-in user gets a cached page

A cache keys a response by URL by default. That is fine until the same URL returns different content depending on something else — the `Accept-Encoding` of a gzip-capable client, the `Accept-Language`, or the fact that a request carries a session cookie. Then a shared cache happily hands one user's page to another.

**`Vary`** is how you tell the cache which request headers were part of the decision:

```http
Vary: Accept-Encoding
```

Now a compressed and an uncompressed client get separate cache entries instead of a corrupted mix. Omit `Vary: Accept-Encoding` behind a CDN and you get the legendary "garbled gzip" bug where a plain-text client receives compressed bytes it cannot read.

Cookies are the sharper edge. If a response depends on a cookie, a shared cache must not serve it to the next visitor — no `Vary` value fixes that safely. The right tool is `Cache-Control: private`, which instructs every shared cache to leave the response alone:

```http
Set-Cookie: session=abc123
Cache-Control: private, max-age=0, no-cache
```

`private` is the one directive that reliably protects per-user content. If a CDN is misconfigured to ignore cookies and cache everything, `private` is what stands between a logged-in page and the next anonymous reader. Never make a shared cache guess about identity.

## A concrete nginx config for a static site

Putting it together, here is the shape I run — fingerprinted assets cached long, HTML revalidated, feeds short:

```nginx
# /etc/nginx/conf.d/blog.conf
server {
    listen 443 ssl;
    server_name blog.awin-x.top;

    root /var/www/blog/current;
    index index.html;

    # Fingerprinted assets: the filename contains a content hash, so it is safe
    # to cache for a year and mark immutable — the URL changes when the bytes do.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # Feeds: short freshness; a reader wants new items soon, but not every second.
    location ~* ^/(rss|atom|feed)\.xml$ {
        add_header Cache-Control "public, max-age=600, must-revalidate";
    }

    # HTML: stable URL, so revalidate on every use. ETag makes the check cheap.
    location / {
        add_header Cache-Control "public, max-age=0, must-revalidate";
        try_files $uri $uri/index.html =404;
    }

    # Never let a shared cache keep per-user or secret responses.
    location /api/ {
        add_header Cache-Control "private, no-store";
    }

    gzip on;
    gzip_types text/html text/css application/javascript application/xml;

    # nginx enables etag by default; this is here to be explicit.
    etag on;
}
```

Two nginx gotchas worth naming. `add_header` only fires on 2xx/3xx/304 unless you append `always`, and it **cancels inherited headers** the moment a `location` declares its own — the same trap as in [web security headers](/posts/web-security-headers/). And `etag on` is the default; `gzip` affects the bytes but nginx handles `Vary` and the ETag correctly across gzip on/off for static files, so you get a valid `304` either way.

## Verifying it by hand

You do not need a browser to see caching working. `curl` shows the whole exchange:

```bash
# Grab the validators from the first response
curl -sI https://blog.awin-x.top/ | grep -iE 'cache-control|etag|last-modified'

# Then ask conditionally with the ETag you just saw
curl -sI -H 'If-None-Match: "8f3a1c2e9b"' https://blog.awin-x.top/ | head -1
# HTTP/2 304
```

If that second call returns `200`, either the content genuinely changed or your ETag is unstable — some servers regenerate it per request, which silently defeats every cache in the chain.

## Frequently asked questions

**Why is my page stale even though I set `no-cache`?** Because `no-cache` means revalidate, not "discard". The browser is doing exactly what you asked; the stale copy is served from a *shared* layer, or your `ETag` never changes. Check `Cache-Control` on the actual response, then check the ETag is stable.

**Should I use `etag` or `Last-Modified`?** Both, and let the client prefer the ETag. `Last-Modified` is a cheap fallback; the ETag is the accurate one.

**How long should assets be cached?** If the filename contains a content hash, a year with `immutable` is correct. If it does not, fix that first — no lifetime choice will save a stable asset URL.

**Does `max-age` override `s-maxage`?** No — for shared caches `s-maxage` wins, and it also implies `must-revalidate` behavior for proxies. It is the knob that lets a CDN hold something longer than a browser.

**Why did my CDN cache a logged-in page?** Almost always a missing `private` (or `no-store`) on the authenticated response combined with a CDN rule that ignores cookies. Fix the header; do not rely on the CDN's defaults.

Caching rewards a clear mental model more than any single setting. Decide, per resource class, three things — how long is it fresh, who is allowed to keep it, and how does a stale copy get revalidated — and write those three answers as headers. The sites that feel fast and stay correct are the ones where those answers match the content, and where nobody used `no-cache` when they meant `no-store`.
